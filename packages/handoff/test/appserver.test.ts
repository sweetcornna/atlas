// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `AppServerClient` against a fake app-server: a Bun WebSocket server in this
 * file that speaks the fork's wire shape — frames without `"jsonrpc"`, the
 * capability token in `Authorization`, `initialize` then `initialized`.
 * Every frame the client sends is recorded and checked.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import {
  AppServerClient,
  AppServerError,
  AppServerImportError,
} from '../src/appserver.js'

const TOKEN = 'test-capability-token-0123456789abcdef'

type Frame = Record<string, unknown>
type Answer = { readonly result?: unknown; readonly error?: unknown }

interface Fake {
  readonly url: string
  readonly frames: Frame[]
  readonly upgrades: {
    readonly authorization: string | null
    readonly origin: string | null
  }[]
  /** Push a frame to every connected client. */
  push(frame: Frame): void
  /** Close every connection from the server side. */
  drop(): void
  stop(): void
}

const fakes: Fake[] = []
afterEach(() => {
  for (const fake of fakes.splice(0)) fake.stop()
})

function startFake(
  answer: (method: string, params: unknown, fake: Fake) => Answer | null,
): Fake {
  const frames: Frame[] = []
  const upgrades: Fake['upgrades'] = []
  const sockets = new Set<import('bun').ServerWebSocket<unknown>>()
  let fake: Fake
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(request, srv) {
      upgrades.push({
        authorization: request.headers.get('authorization'),
        origin: request.headers.get('origin'),
      })
      if (request.headers.get('authorization') !== `Bearer ${TOKEN}`) {
        return new Response('unauthorized', { status: 401 })
      }
      return srv.upgrade(request)
        ? undefined
        : new Response('no', { status: 400 })
    },
    websocket: {
      open(ws) {
        sockets.add(ws)
      },
      close(ws) {
        sockets.delete(ws)
      },
      message(ws, data) {
        const frame = JSON.parse(String(data)) as Frame
        frames.push(frame)
        if (typeof frame.method !== 'string' || frame.id === undefined) return
        const reply = answer(frame.method, frame.params, fake)
        if (reply !== null) ws.send(JSON.stringify({ id: frame.id, ...reply }))
      },
    },
  })
  fake = {
    url: `ws://127.0.0.1:${server.port}`,
    frames,
    upgrades,
    push(frame) {
      for (const ws of sockets) ws.send(JSON.stringify(frame))
    },
    drop() {
      for (const ws of sockets) ws.close(1011, 'gone')
    },
    stop() {
      server.stop(true)
    },
  }
  fakes.push(fake)
  return fake
}

/** Answers `initialize` and the thread / turn methods the way the fork does. */
function standard(method: string, params: unknown): Answer | null {
  const p = (params ?? {}) as Record<string, unknown>
  switch (method) {
    case 'initialize':
      return { result: { userAgent: 'qmcode/0.158.0' } }
    case 'thread/resume':
      return {
        result: {
          thread: {
            id: p.threadId,
            path: '/state/sessions/2026/10/03/rollout-x.jsonl',
          },
          cwd: p.cwd,
        },
      }
    case 'thread/start':
      return {
        result: { thread: { id: 'thread-new', path: null }, cwd: p.cwd },
      }
    case 'turn/start':
      return {
        result: {
          turn: { id: 'turn-1', items: [], status: 'inProgress', error: null },
        },
      }
    case 'turn/interrupt':
      return { result: {} }
    default:
      return { error: { code: -32601, message: `no ${method}` } }
  }
}

describe('AppServerClient', () => {
  test('connects with the bearer token, no Origin, no "jsonrpc"; initialize then initialized', async () => {
    const fake = startFake(standard)
    const client = await AppServerClient.connect({
      url: fake.url,
      token: TOKEN,
    })
    await Bun.sleep(20)
    expect(fake.upgrades).toEqual([
      { authorization: `Bearer ${TOKEN}`, origin: null },
    ])
    expect(fake.frames[0]).toMatchObject({
      id: 1,
      method: 'initialize',
      params: { clientInfo: { name: 'qianmo_handoff_node' } },
    })
    expect(fake.frames[1]).toEqual({ method: 'initialized' })
    for (const frame of fake.frames)
      expect(Object.hasOwn(frame, 'jsonrpc')).toBe(false)
    client.close()
  })

  test('a wrong token is refused at the upgrade and the token is not in the error', async () => {
    const fake = startFake(standard)
    const failed = await AppServerClient.connect({
      url: fake.url,
      token: 'wrong-token-wrong-token-wrong',
    }).then(
      () => null,
      (error: unknown) => error,
    )
    expect(failed).toBeInstanceOf(AppServerError)
    expect(String(failed)).not.toContain('wrong-token')
  })

  test('thread/resume, turn/start, turn/completed: params as the plan card, answers correlated by id', async () => {
    const fake = startFake(standard)
    const client = await AppServerClient.connect({
      url: fake.url,
      token: TOKEN,
    })
    const thread = await client.threadResume('thread-a', {
      cwd: '/node/work/t1',
      approvalPolicy: 'never',
      sandbox: 'workspace-write',
    })
    expect(thread).toEqual({
      id: 'thread-a',
      path: '/state/sessions/2026/10/03/rollout-x.jsonl',
    })
    const resume = fake.frames.find(frame => frame.method === 'thread/resume')
    expect(resume?.params).toEqual({
      threadId: 'thread-a',
      cwd: '/node/work/t1',
      approvalPolicy: 'never',
      sandbox: 'workspace-write',
      excludeTurns: true,
    })
    const turnId = await client.turnStart('thread-a', '简报')
    expect(turnId).toBe('turn-1')
    expect(
      fake.frames.find(frame => frame.method === 'turn/start')?.params,
    ).toEqual({
      threadId: 'thread-a',
      input: [{ type: 'text', text: '简报', text_elements: [] }],
    })
    // Arrives before anyone waits: kept and found.
    fake.push({
      method: 'item/completed',
      params: {
        threadId: 'thread-a',
        turnId: 'turn-1',
        item: { type: 'agentMessage', id: 'i1', text: '做完了' },
      },
    })
    fake.push({
      method: 'turn/completed',
      params: {
        threadId: 'thread-b',
        turn: { id: 'turn-1', status: 'failed' },
      },
    })
    fake.push({
      method: 'turn/completed',
      params: {
        threadId: 'thread-a',
        turn: { id: 'turn-1', status: 'completed', items: [] },
      },
    })
    const turn = await client.waitTurnCompleted('thread-a', 'turn-1', 2_000)
    expect(turn).toEqual({ id: 'turn-1', status: 'completed' })
    expect(client.lastAgentMessage('turn-1')).toBe('做完了')
    expect(client.lastAgentMessage('turn-2')).toBeNull()
    client.close()
  })

  test('an error answer rejects with its code; a server request is answered -32601', async () => {
    const fake = startFake((method, params) =>
      method === 'turn/interrupt'
        ? { error: { code: -32600, message: 'no such turn' } }
        : standard(method, params),
    )
    const client = await AppServerClient.connect({
      url: fake.url,
      token: TOKEN,
    })
    const failed = await client.turnInterrupt('thread-a', 'turn-x').then(
      () => null,
      (error: unknown) => error,
    )
    expect(failed).toBeInstanceOf(AppServerError)
    expect((failed as AppServerError).code).toBe(-32600)
    fake.push({
      id: 'srv-1',
      method: 'item/commandExecution/requestApproval',
      params: {},
    })
    await Bun.sleep(50)
    expect(fake.frames.at(-1)).toMatchObject({
      id: 'srv-1',
      error: { code: -32601 },
    })
    client.close()
  })

  test('externalAgentConfig/import: the SESSIONS target, or the failure', async () => {
    let nextOk = true
    const fake = startFake((method, params, self) => {
      if (method !== 'externalAgentConfig/import')
        return standard(method, params)
      const ok = nextOk
      setTimeout(() => {
        self.push({
          method: 'externalAgentConfig/import/completed',
          params: {
            importId: ok ? 'imp-1' : 'imp-2',
            itemTypeResults: [
              ok
                ? {
                    itemType: 'SESSIONS',
                    successes: [
                      { itemType: 'SESSIONS', target: 'thread-imported' },
                    ],
                    failures: [],
                  }
                : {
                    itemType: 'SESSIONS',
                    successes: [],
                    failures: [
                      {
                        itemType: 'SESSIONS',
                        failureStage: 'read',
                        message: 'bad record',
                      },
                    ],
                  },
            ],
          },
        })
      }, 10)
      return { result: { importId: ok ? 'imp-1' : 'imp-2' } }
    })
    const client = await AppServerClient.connect({
      url: fake.url,
      token: TOKEN,
    })
    const target = await client.importClaudeCodeSession({
      path: '/home/n/.claude/projects/qianmo-import/s.jsonl',
      cwd: '/node/work/t1',
      description: 'handoff t1',
    })
    expect(target).toBe('thread-imported')
    expect(
      fake.frames.find(frame => frame.method === 'externalAgentConfig/import')
        ?.params,
    ).toEqual({
      migrationItems: [
        {
          itemType: 'SESSIONS',
          description: 'handoff t1',
          cwd: null,
          details: {
            sessions: [
              {
                path: '/home/n/.claude/projects/qianmo-import/s.jsonl',
                cwd: '/node/work/t1',
                title: null,
              },
            ],
          },
        },
      ],
    })
    nextOk = false
    const failed = await client
      .importClaudeCodeSession({
        path: '/x.jsonl',
        cwd: '/w',
        description: 'd',
      })
      .then(
        () => null,
        (error: unknown) => error,
      )
    expect(failed).toBeInstanceOf(AppServerImportError)
    expect(String(failed)).toContain('bad record')
    client.close()
  })

  test('thread/loaded/list (every page) and thread/read: the threads and their cwd (P17.6)', async () => {
    const fake = startFake((method, params) => {
      const p = (params ?? {}) as Record<string, unknown>
      switch (method) {
        case 'thread/loaded/list':
          return p.cursor === undefined
            ? { result: { data: ['t-1', 't-2'], nextCursor: 'page-2' } }
            : { result: { data: ['t-3', 7], nextCursor: null } }
        case 'thread/read':
          return p.threadId === 't-2'
            ? { result: { thread: { id: 't-2', cwd: '/srv/node/work/x-1' } } }
            : { result: { thread: { id: p.threadId } } }
        default:
          return standard(method, params)
      }
    })
    const client = await AppServerClient.connect({
      url: fake.url,
      token: TOKEN,
      clientName: 'qianmo_handoff_attach',
    })
    expect(await client.loadedThreadIds()).toEqual(['t-1', 't-2', 't-3'])
    expect(await client.threadCwd('t-2')).toBe('/srv/node/work/x-1')
    expect(await client.threadCwd('t-1')).toBeNull()
    const sent = fake.frames.filter(frame => frame.id !== undefined)
    expect(sent[0]).toMatchObject({
      method: 'initialize',
      params: { clientInfo: { name: 'qianmo_handoff_attach' } },
    })
    expect(sent.slice(1).map(frame => [frame.method, frame.params])).toEqual([
      ['thread/loaded/list', {}],
      ['thread/loaded/list', { cursor: 'page-2' }],
      ['thread/read', { threadId: 't-2' }],
      ['thread/read', { threadId: 't-1' }],
    ])
    client.close()
  })

  test('a dropped connection rejects what is in flight and what is awaited', async () => {
    const fake = startFake((method, params) =>
      method === 'turn/start' ? null : standard(method, params),
    )
    const client = await AppServerClient.connect({
      url: fake.url,
      token: TOKEN,
    })
    const pending = client.turnStart('thread-a', 'x').then(
      () => null,
      (error: unknown) => error,
    )
    const waiting = client.waitTurnCompleted('thread-a', 'turn-9').then(
      () => null,
      (error: unknown) => error,
    )
    await Bun.sleep(20)
    fake.drop()
    expect(await pending).toBeInstanceOf(AppServerError)
    expect(await waiting).toBeInstanceOf(AppServerError)
    await client.closed
  })
})
