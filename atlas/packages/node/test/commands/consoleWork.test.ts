// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * P37.17 B — the hub's side of work (`work-tasks.md` §3, §4.3, §5.4): the
 * session kind and workflow in the chat store, the line naming the skill
 * in front of what was typed, file cards and activity from the node's hub calls (and who may
 * make them), and the paced, chunked fetch over the control link.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  ChatSession,
  ConsoleAgent,
  ConsoleResult,
  RegistryPort,
  WorkFailure,
  WorkFileRef,
} from '@qianmo/console'
import type { ControlOutcome, QianmoMessage } from '@qianmo/protocol'
import {
  createConsoleChatPort,
  type ChatDialer,
  type ConsoleChatHub,
} from '../../src/commands/consoleChat.js'
import { ConsoleWork, workHubCalls } from '../../src/commands/consoleWork.js'

const TARGET = 'qianmo://node-b/writer'
const ENDPOINT = 'ws://127.0.0.1:38612'
const FROM = 'qianmo://console/operator'
const PSK = 'demo-psk-that-is-long-enough-000'

class OneAgentRegistry implements RegistryPort {
  list(): Promise<ConsoleResult<readonly ConsoleAgent[]>> {
    return Promise.resolve({
      ok: true,
      value: [
        {
          address: TARGET,
          endpoint: ENDPOINT,
          capabilities: [],
          status: 'online',
          registeredAt: 1,
          lastHeartbeatAt: 2,
          expiresAt: 3,
        },
      ],
    })
  }
  register(): Promise<ConsoleResult<ConsoleAgent>> {
    return Promise.resolve({
      ok: false,
      failure: { code: 'unsupported', message: 'unused' },
    })
  }
  deregister(): Promise<ConsoleResult<void>> {
    return Promise.resolve({
      ok: false,
      failure: { code: 'unsupported', message: 'unused' },
    })
  }
  heartbeat(): Promise<ConsoleResult<ConsoleAgent>> {
    return Promise.resolve({
      ok: false,
      failure: { code: 'unsupported', message: 'unused' },
    })
  }
}

let directory: string
let hubs: ConsoleChatHub[]

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'qmo-console-work-'))
  hubs = []
})

afterEach(async () => {
  for (const hub of hubs) await hub.close()
  rmSync(directory, { recursive: true, force: true })
})

function hub(prefix = 'id'): {
  hub: ConsoleChatHub
  sent: QianmoMessage[]
  advance: (ms: number) => void
} {
  const sent: QianmoMessage[] = []
  let clock = 1_700_000_000_000
  let counter = 0
  const dial: ChatDialer = () => ({
    connect: async () => {},
    sendAndWait: async message => {
      sent.push(message)
      return 'accepted'
    },
    isClosed: () => false,
    close: async () => {},
  })
  const made = createConsoleChatPort({
    from: FROM,
    endpoints: [{ url: ENDPOINT, psk: PSK }],
    storePath: join(directory, 'chat.ndjson'),
    registry: new OneAgentRegistry(),
    dial,
    now: () => clock,
    newId: () => `${prefix}-${(counter += 1)}`,
  })
  hubs.push(made)
  return {
    hub: made,
    sent,
    advance: ms => {
      clock += ms
    },
  }
}

const FILE: WorkFileRef = {
  name: '季度汇报.pptx',
  size: 81_234,
  kind: 'presentation',
  mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  sha256: 'a'.repeat(64),
  preview: true,
  title: '季度汇报',
}

async function workSession(h: ReturnType<typeof hub>) {
  const opened = await h.hub.open(TARGET, { work: true, workflow: 'slides' })
  if (!opened.ok) throw new Error(opened.failure.message)
  const turn = await h.hub.send({
    sessionId: opened.value.id,
    text: '做一份季度汇报',
    workflow: 'slides',
  })
  if (!turn.ok) throw new Error(turn.failure.message)
  return { session: opened.value, taskId: turn.value.taskId! }
}

describe('work sessions in the chat store', () => {
  test('kind and workflow are written once and survive a restart', async () => {
    const first = hub('a')
    const { session } = await workSession(first)
    expect(session.work).toBe(true)
    expect(session.workflow).toBe('slides')
    const plain = await first.hub.open(TARGET)
    if (!plain.ok) throw new Error('open')
    expect(plain.value.work).toBeUndefined()
    const refused = await first.hub.open(TARGET, { workflow: 'slides' })
    expect(refused.ok).toBe(false)
    await first.hub.close()
    const again = hub('b')
    const listed = await again.hub.sessions()
    if (!listed.ok) throw new Error('sessions')
    expect(listed.value.find(one => one.id === session.id)).toMatchObject({
      work: true,
      workflow: 'slides',
    })
    expect(
      listed.value.find(one => one.id === plain.value.id)?.work,
    ).toBeUndefined()
  })

  test('the node is sent the line naming the skill; the transcript keeps the line as typed', async () => {
    const h = hub()
    const { session } = await workSession(h)
    expect((h.sent[0]?.payload as { prompt: string }).prompt).toBe(
      '[工作流 qmo-slides] 先读 skill://qmo-slides，按里面的步骤做。\n做一份季度汇报',
    )
    const read = await h.hub.transcript(session.id)
    if (!read.ok) throw new Error('transcript')
    expect(read.value.turns[0]).toMatchObject({
      author: 'operator',
      text: '做一份季度汇报',
      workflow: 'slides',
    })
    const both = await h.hub.send({
      sessionId: session.id,
      text: '/compact',
      command: 'compact',
      workflow: 'sheet',
    })
    expect(both.ok).toBe(false)
  })
})

describe('file cards from work.deliver', () => {
  test('a card in the running turn: a notice that does not end the turn', async () => {
    const h = hub()
    const { session, taskId } = await workSession(h)
    const calls = workHubCalls(h.hub)
    const outcome = await calls(
      'work.deliver',
      { contextId: session.id, taskId, files: [FILE] },
      { node: 'node-b', agent: 'writer', callId: 'c-1' },
    )
    expect(outcome).toEqual({ ok: true, value: { delivered: true } })
    const read = await h.hub.transcript(session.id)
    if (!read.ok) throw new Error('transcript')
    const card = read.value.turns.at(-1)
    expect(card).toMatchObject({
      author: 'agent',
      state: 'done',
      variant: 'notice',
      noticeSource: 'files',
      severity: 'info',
      taskId,
      files: [FILE],
      text: '交付了 1 个文件：季度汇报.pptx',
    })
    // Still running, and still one turn: the card is not an answer.
    expect(read.value.session.running).toBe(true)
    expect(read.value.session.turnCount).toBe(1)
    expect(read.value.session.preview).toBe('做一份季度汇报')
  })

  test('only the agent running the session, only in a turn that has not ended', async () => {
    const h = hub()
    const { session, taskId } = await workSession(h)
    const calls = workHubCalls(h.hub)
    const deliver = (
      ctx: { node: string; agent?: string },
      args: Record<string, unknown>,
    ) => calls('work.deliver', args, { ...ctx, callId: 'c' })
    const base = { contextId: session.id, taskId, files: [FILE] }
    expect(
      await deliver({ node: 'node-x', agent: 'writer' }, base),
    ).toMatchObject({
      ok: false,
      code: 'not_found',
    })
    expect(
      await deliver({ node: 'node-b', agent: 'other' }, base),
    ).toMatchObject({
      ok: false,
      code: 'not_found',
    })
    expect(await deliver({ node: 'node-b' }, base)).toMatchObject({
      ok: false,
      code: 'not_found',
    })
    expect(
      await deliver(
        { node: 'node-b', agent: 'writer' },
        { ...base, taskId: 'elsewhere' },
      ),
    ).toMatchObject({ ok: false, code: 'rejected' })
    for (const files of [
      [],
      Array(21).fill(FILE),
      [{ ...FILE, name: '../x' }],
      [{ ...FILE, sha256: 'nope' }],
      [{ ...FILE, size: 50 * 1024 * 1024 + 1 }],
      [FILE, FILE],
    ])
      expect(
        await deliver({ node: 'node-b', agent: 'writer' }, { ...base, files }),
      ).toMatchObject({ ok: false, code: 'invalid' })
    const read = await h.hub.transcript(session.id)
    if (!read.ok) throw new Error('transcript')
    expect(read.value.turns.some(turn => turn.noticeSource === 'files')).toBe(
      false,
    )
  })

  test('at most 200 cards per session, counted again after a restart', async () => {
    const h = hub('a')
    const { session, taskId } = await workSession(h)
    const calls = workHubCalls(h.hub)
    const ctx = { node: 'node-b', agent: 'writer', callId: 'c' }
    for (let index = 0; index < 199; index += 1)
      expect(
        (
          await calls(
            'work.deliver',
            { contextId: session.id, taskId, files: [FILE] },
            ctx,
          )
        ).ok,
      ).toBe(true)
    await h.hub.close()
    const again = hub('b')
    // The restart settled the old turn; a new one is running.
    const turn = await again.hub.send({ sessionId: session.id, text: '再来' })
    if (!turn.ok) throw new Error('send')
    const later = workHubCalls(again.hub)
    const args = {
      contextId: session.id,
      taskId: turn.value.taskId,
      files: [FILE],
    }
    expect((await later('work.deliver', args, ctx)).ok).toBe(true)
    expect(await later('work.deliver', args, ctx)).toMatchObject({
      ok: false,
      code: 'rejected',
    })
  })
})

describe('activity from work.activity', () => {
  test('progress is kept across turns and goes null when emptied; context is per turn and names the workflow', async () => {
    const h = hub('a')
    const { session, taskId } = await workSession(h)
    const calls = workHubCalls(h.hub)
    const ctx = { node: 'node-b', agent: 'writer', callId: 'c' }
    const todo = [
      { phase: '准备', content: '整理材料', status: 'completed' },
      { phase: '准备', content: '定大纲', status: 'in_progress' },
      { phase: '制作', content: '生成', status: 'pending' },
    ]
    expect(
      await calls(
        'work.activity',
        {
          contextId: session.id,
          taskId,
          todo,
          context: {
            skills: ['qmo-slides', 'qmo-document', 'web-research'],
            tools: [
              { name: 'todo', count: 2 },
              { name: 'qianmo_make_document', count: 1 },
            ],
            files: ['资料/数据.csv'],
          },
        },
        ctx,
      ),
    ).toMatchObject({ ok: true })
    let read = await h.hub.transcript(session.id)
    if (!read.ok) throw new Error('transcript')
    expect(read.value.activity?.progress).toMatchObject({
      taskId,
      total: 3,
      done: 1,
      step: 2,
      current: '定大纲',
    })
    expect(read.value.activity?.context).toMatchObject({
      taskId,
      workflows: ['slides', 'document'],
      skills: ['qmo-slides', 'qmo-document', 'web-research'],
      files: ['资料/数据.csv'],
    })
    // A finished turn may still report (its last account), with no list.
    h.advance(1000)
    expect(
      (
        await calls(
          'work.activity',
          {
            contextId: session.id,
            taskId,
            context: { skills: [], tools: [], files: [] },
          },
          ctx,
        )
      ).ok,
    ).toBe(true)
    read = await h.hub.transcript(session.id)
    if (!read.ok) throw new Error('transcript')
    expect(read.value.activity?.progress?.total).toBe(3)
    // Survives a restart.
    await h.hub.close()
    const again = hub('b')
    const replayed = await again.hub.transcript(session.id)
    if (!replayed.ok) throw new Error('transcript')
    expect(replayed.value.activity?.progress?.current).toBe('定大纲')
    expect(replayed.value.activity?.context?.workflows).toEqual(['slides'])
    const later = workHubCalls(again.hub)
    await later(
      'work.activity',
      {
        contextId: session.id,
        taskId,
        todo: [],
        context: { skills: [], tools: [], files: [] },
      },
      ctx,
    )
    const emptied = await again.hub.transcript(session.id)
    if (!emptied.ok) throw new Error('transcript')
    expect(emptied.value.activity?.progress).toBeNull()
    const lines = readFileSync(join(directory, 'chat.ndjson'), 'utf8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as { kind: string })
    expect(lines.filter(line => line.kind === 'activity')).toHaveLength(3)
  })

  test('a turn of another session, or a malformed list, changes nothing', async () => {
    const h = hub()
    const { session } = await workSession(h)
    const calls = workHubCalls(h.hub)
    const ctx = { node: 'node-b', agent: 'writer', callId: 'c' }
    expect(
      await calls(
        'work.activity',
        {
          contextId: session.id,
          taskId: 'nope',
          context: { skills: [], tools: [], files: [] },
        },
        ctx,
      ),
    ).toMatchObject({ ok: false, code: 'rejected' })
    const read = await h.hub.transcript(session.id)
    if (!read.ok) throw new Error('transcript')
    expect(read.value.activity).toBeUndefined()
    expect(await calls('work.other', {}, ctx)).toMatchObject({
      ok: false,
      code: 'unsupported',
    })
  })
})

describe('fetching over the control link', () => {
  const SESSION: ChatSession = {
    id: 'session-1',
    target: TARGET,
    node: 'node-b',
    agent: 'writer',
    createdAt: 1,
    updatedAt: 1,
    turnCount: 0,
    preview: '',
  }

  function control(
    file: Uint8Array,
    options: {
      readonly changeAt?: number
      readonly refuse?: ControlOutcome
    } = {},
  ) {
    const requests: { op: string; args: Record<string, unknown> }[] = []
    return {
      requests,
      port: {
        async request(
          node: string,
          op: string,
          args: Record<string, unknown>,
        ): Promise<ControlOutcome> {
          expect(node).toBe('node-b')
          requests.push({ op, args })
          if (options.refuse !== undefined) return options.refuse
          if (op === 'work.list')
            return {
              ok: true,
              value: {
                files: [
                  {
                    name: 'a.pptx',
                    size: 3,
                    kind: 'other',
                    mime: 'x',
                    mtime: 5,
                    preview: true,
                  },
                  {
                    name: 'big.csv',
                    size: 60 * 1024 * 1024,
                    mtime: 4,
                    preview: false,
                    tooLarge: true,
                  },
                  { bogus: true },
                ],
                truncated: false,
              },
            }
          const offset = args.offset as number
          const chunk = file.subarray(offset, offset + 4)
          const etag =
            options.changeAt !== undefined && offset >= options.changeAt
              ? 'e2'
              : 'e1'
          return {
            ok: true,
            value: {
              name: args.name,
              size: file.byteLength,
              mime: 'application/octet-stream',
              etag,
              offset,
              data: Buffer.from(chunk).toString('base64'),
              eof: offset + chunk.byteLength >= file.byteLength,
            },
          }
        },
      },
    }
  }

  test('listing: the node’s rows, kind and MIME read from the name on the hub', async () => {
    const link = control(new Uint8Array())
    const listed = await new ConsoleWork({ control: link.port }).outputs(
      SESSION,
    )
    expect(listed).toEqual({
      ok: true,
      value: {
        files: [
          {
            name: 'a.pptx',
            size: 3,
            kind: 'presentation',
            mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
            mtime: 5,
            preview: true,
          },
          {
            name: 'big.csv',
            size: 60 * 1024 * 1024,
            kind: 'spreadsheet',
            mime: 'text/csv; charset=utf-8',
            mtime: 4,
            preview: false,
            tooLarge: true,
          },
        ],
        truncated: false,
      },
    })
    expect(link.requests).toEqual([
      { op: 'work.list', args: { agent: 'writer', session: 'session-1' } },
    ])
  })

  test('a download is the file’s bytes, chunk by chunk, paced to 150 a minute per node', async () => {
    const file = new TextEncoder().encode('0123456789abcdef!')
    const link = control(file)
    const waits: number[] = []
    let clock = 0
    const work = new ConsoleWork({
      control: link.port,
      now: () => clock,
      sleep: async ms => {
        waits.push(ms)
        clock += ms
      },
    })
    const fetched = await work.fetch(SESSION, 'a.bin', 'file')
    if (!fetched.ok) throw new Error(fetched.failure.message)
    expect(fetched.value.size).toBe(file.byteLength)
    const bytes = new Uint8Array(
      await new Response(fetched.value.body).arrayBuffer(),
    )
    expect(new TextDecoder().decode(bytes)).toBe('0123456789abcdef!')
    expect(link.requests.map(one => one.args.offset)).toEqual([0, 4, 8, 12, 16])
    expect(link.requests.slice(1).every(one => one.args.etag === 'e1')).toBe(
      true,
    )
    expect(waits).toEqual([400, 400, 400, 400])
  })

  test('a file changed half way breaks the body instead of joining two versions', async () => {
    const link = control(new TextEncoder().encode('0123456789'), {
      changeAt: 8,
    })
    const work = new ConsoleWork({ control: link.port, sleep: async () => {} })
    const fetched = await work.fetch(SESSION, 'a.bin', 'file')
    if (!fetched.ok) throw new Error('fetch')
    await expect(
      new Response(fetched.value.body).arrayBuffer(),
    ).rejects.toThrow()
  })

  test('the node’s refusals as the page reads them', async () => {
    const cases: [ControlOutcome, WorkFailure['code']][] = [
      [{ ok: false, code: 'not_found', message: 'x' }, 'not_found'],
      [{ ok: false, code: 'limit', message: 'x' }, 'limit'],
      [{ ok: false, code: 'invalid', message: 'x' }, 'invalid'],
      [{ ok: false, code: 'unsupported', message: 'x' }, 'unsupported'],
      [{ ok: false, code: 'unreachable', message: 'x' }, 'unreachable'],
    ]
    for (const [refuse, code] of cases) {
      const work = new ConsoleWork({
        control: control(new Uint8Array(), { refuse }).port,
        sleep: async () => {},
      })
      const fetched = await work.fetch(SESSION, 'a.bin', 'preview')
      expect(fetched.ok ? null : fetched.failure.code).toBe(code)
      const listed = await work.outputs(SESSION)
      expect(listed.ok ? null : listed.failure.code).toBe(code)
    }
  })
})
