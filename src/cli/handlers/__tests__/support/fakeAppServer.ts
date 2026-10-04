// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * A fake qmcode app-server for the node bridge tests: a Bun WebSocket server
 * that speaks only the methods the bridge uses, in the fork's wire shape
 * (`codex-rs/app-server-protocol` v2) — frames without `"jsonrpc"`, the token
 * in `Authorization: Bearer`, `initialize` then `initialized`.
 *
 * It keeps a rollout per thread under `$QMCODE_HOME/sessions/` the way qmcode
 * does: `thread/resume` finds the file by thread id (and fails without one),
 * `thread/start` and a successful import create one, and every turn appends
 * `task_started` … `task_complete` / `turn_aborted` lines. A turn may do work
 * in its `cwd` first, may be held open until the test releases it, and a
 * `turn/start` on a thread with a running turn is steered into that turn
 * (same turn id), as `turn/start` does on the real server.
 *
 * Nothing here is a recording of a real session.
 */

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { ServerWebSocket } from 'bun'
import { findQmcodeRollout } from '../../handoffTranscript.js'

export interface FakeTurn {
  readonly threadId: string
  readonly turnId: string
  readonly cwd: string
  readonly text: string
}

export interface FakeAppServerOptions {
  readonly token: string
  readonly qmcodeHome: string
  /** What the "model" does in the work tree before the turn ends. */
  readonly work?: (turn: FakeTurn) => void | Promise<void>
  /** The turn's last agent message. */
  readonly reply?: (turn: FakeTurn) => string
  /** Turns stay open until {@link FakeAppServer.release} or `turn/interrupt`. */
  readonly hold?: boolean
  /** `externalAgentConfig/import` fails with this message. */
  readonly importFailure?: string
  /**
   * When the turn's end line reaches the rollout, relative to
   * `turn/completed`: `0` before it (default), a positive number that many
   * ms after, `null` never.
   */
  readonly endLineDelayMs?: number | null
}

export interface FakeAppServer {
  readonly url: string
  /** Every frame a client sent. */
  readonly frames: Record<string, unknown>[]
  readonly upgrades: {
    readonly authorization: string | null
    readonly origin: string | null
  }[]
  /** `params` of each request with this method, in order. */
  calls(method: string): Record<string, unknown>[]
  /** Texts that went into a turn, steered ones included. */
  inputs(turnId: string): readonly string[]
  /** Turn ids in the order they started. */
  readonly turns: string[]
  /** Rollout path of a thread the server knows. */
  rolloutOf(threadId: string): string | undefined
  /** End a held turn (the latest one when no id is given). */
  release(turnId?: string): void
  stop(): void
}

interface ThreadState {
  readonly path: string
  cwd: string
  active: string | null
}

const SESSION_DAY = ['2026', '10', '03'] as const

function line(type: string, payload: unknown): string {
  return `${JSON.stringify({ timestamp: new Date().toISOString(), type, payload })}\n`
}

export function startFakeAppServer(
  options: FakeAppServerOptions,
): FakeAppServer {
  const frames: Record<string, unknown>[] = []
  const upgrades: FakeAppServer['upgrades'] = []
  const sockets = new Set<ServerWebSocket<unknown>>()
  const threads = new Map<string, ThreadState>()
  const inputs = new Map<string, string[]>()
  const turns: string[] = []
  const held = new Map<string, () => void>()
  let counter = 0

  const push = (method: string, params: unknown): void => {
    const text = JSON.stringify({ method, params })
    for (const socket of sockets) socket.send(text)
  }

  const newRollout = (id: string, cwd: string): string => {
    const path = join(
      options.qmcodeHome,
      'sessions',
      ...SESSION_DAY,
      `rollout-2026-10-03T10-00-00-${id}.jsonl`,
    )
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(
      path,
      line('session_meta', {
        id,
        timestamp: new Date().toISOString(),
        cwd,
        originator: 'qianmo_handoff_node',
        cli_version: '0.158.0',
        source: 'vscode',
        model_provider: 'qianmo',
      }),
    )
    return path
  }

  const finish = (
    threadId: string,
    turnId: string,
    status: 'completed' | 'interrupted',
  ): void => {
    const thread = threads.get(threadId)
    if (thread === undefined || thread.active !== turnId) return
    thread.active = null
    held.delete(turnId)
    const text =
      options.reply?.({
        threadId,
        turnId,
        cwd: thread.cwd,
        text: (inputs.get(turnId) ?? []).join('\n'),
      }) ?? `云端做完了：${turnId}`
    appendFileSync(
      thread.path,
      line('response_item', {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text }],
      }) +
        line('event_msg', { type: 'agent_message', message: text }) +
        line('event_msg', {
          type: 'token_count',
          info: null,
          rate_limits: null,
        }),
    )
    const end =
      status === 'completed'
        ? line('event_msg', {
            type: 'task_complete',
            turn_id: turnId,
            last_agent_message: text,
          })
        : line('event_msg', {
            type: 'turn_aborted',
            turn_id: turnId,
            reason: 'interrupted',
          })
    const delay =
      options.endLineDelayMs === undefined ? 0 : options.endLineDelayMs
    if (delay === 0) appendFileSync(thread.path, end)
    push('item/completed', {
      threadId,
      turnId,
      item: { type: 'agentMessage', id: `item-${turnId}`, text },
    })
    push('turn/completed', {
      threadId,
      turn: { id: turnId, items: [], status, error: null },
    })
    if (delay !== null && delay > 0) {
      setTimeout(() => appendFileSync(thread.path, end), delay)
    }
  }

  const run = async (
    threadId: string,
    turnId: string,
    gate: Promise<void> | null,
  ): Promise<void> => {
    const thread = threads.get(threadId)
    if (thread === undefined) return
    await Bun.sleep(5)
    await options.work?.({
      threadId,
      turnId,
      cwd: thread.cwd,
      text: (inputs.get(turnId) ?? []).join('\n'),
    })
    if (gate !== null) await gate
    finish(threadId, turnId, 'completed')
  }

  type Answer = { readonly result: unknown } | { readonly error: unknown }
  const answer = (method: string, params: Record<string, unknown>): Answer => {
    const fail = (message: string): Answer => ({
      error: { code: -32600, message },
    })
    switch (method) {
      case 'initialize':
        return { result: { userAgent: 'qmcode/0.158.0 (fake)' } }
      case 'thread/resume': {
        const id = String(params.threadId)
        const path =
          threads.get(id)?.path ?? findQmcodeRollout(options.qmcodeHome, id)
        if (path === null || path === undefined) {
          return fail(`no rollout found for thread id ${id}`)
        }
        const cwd = String(params.cwd)
        const known = threads.get(id)
        if (known === undefined) threads.set(id, { path, cwd, active: null })
        else known.cwd = cwd
        return { result: { thread: { id, path }, cwd } }
      }
      case 'thread/start': {
        const id = `0199f1a2-0000-7000-8000-${String(++counter).padStart(12, '0')}`
        const cwd = String(params.cwd)
        threads.set(id, { path: newRollout(id, cwd), cwd, active: null })
        return { result: { thread: { id, path: threads.get(id)?.path }, cwd } }
      }
      case 'turn/start': {
        const threadId = String(params.threadId)
        const thread = threads.get(threadId)
        if (thread === undefined) return fail(`thread not loaded: ${threadId}`)
        const input = Array.isArray(params.input) ? params.input : []
        const text = input
          .map(item =>
            typeof item === 'object' && item !== null && 'text' in item
              ? String(item.text)
              : '',
          )
          .join('\n')
        const steering = thread.active
        const turnId = steering ?? `turn-${++counter}`
        inputs.set(turnId, [...(inputs.get(turnId) ?? []), text])
        if (steering === null) {
          thread.active = turnId
          turns.push(turnId)
          appendFileSync(
            thread.path,
            line('event_msg', {
              type: 'task_started',
              turn_id: turnId,
              started_at: Math.floor(Date.now() / 1000),
            }) + line('turn_context', { turn_id: turnId, cwd: thread.cwd }),
          )
          // The gate exists from the start: a release right after the turn
          // shows up in `turns` must not be lost.
          const gate =
            options.hold === true
              ? new Promise<void>(resolve => held.set(turnId, resolve))
              : null
          void run(threadId, turnId, gate)
        }
        appendFileSync(
          thread.path,
          line('response_item', {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text }],
          }),
        )
        return {
          result: {
            turn: { id: turnId, items: [], status: 'inProgress', error: null },
          },
        }
      }
      case 'turn/interrupt': {
        const threadId = String(params.threadId)
        const turnId = String(params.turnId)
        const thread = threads.get(threadId)
        if (thread?.active !== turnId) return fail(`no active turn ${turnId}`)
        setTimeout(() => finish(threadId, turnId, 'interrupted'), 5)
        return { result: {} }
      }
      case 'externalAgentConfig/import': {
        const items = Array.isArray(params.migrationItems)
          ? params.migrationItems
          : []
        const session = items[0]?.details?.sessions?.[0] as
          | { path?: unknown; cwd?: unknown }
          | undefined
        const importId = `import-${++counter}`
        const failure = options.importFailure
        let records = 0
        try {
          records = readFileSync(String(session?.path), 'utf8')
            .split('\n')
            .filter(text => text.trim() !== '').length
        } catch {}
        setTimeout(() => {
          if (failure !== undefined || records === 0) {
            push('externalAgentConfig/import/completed', {
              importId,
              itemTypeResults: [
                {
                  itemType: 'SESSIONS',
                  successes: [],
                  failures: [
                    {
                      itemType: 'SESSIONS',
                      failureStage: 'read',
                      message: failure ?? 'empty session file',
                    },
                  ],
                },
              ],
            })
            return
          }
          const id = `0199f1a2-0000-7000-8000-${String(++counter).padStart(12, '0')}`
          const cwd = String(session?.cwd)
          threads.set(id, { path: newRollout(id, cwd), cwd, active: null })
          push('externalAgentConfig/import/completed', {
            importId,
            itemTypeResults: [
              {
                itemType: 'SESSIONS',
                successes: [{ itemType: 'SESSIONS', target: id }],
                failures: [],
              },
            ],
          })
        }, 5)
        return { result: { importId } }
      }
      default:
        return { error: { code: -32601, message: `no method ${method}` } }
    }
  }

  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(request, srv) {
      upgrades.push({
        authorization: request.headers.get('authorization'),
        origin: request.headers.get('origin'),
      })
      if (request.headers.get('authorization') !== `Bearer ${options.token}`) {
        return new Response('unauthorized', { status: 401 })
      }
      return srv.upgrade(request)
        ? undefined
        : new Response('upgrade required', { status: 426 })
    },
    websocket: {
      open(socket) {
        sockets.add(socket)
      },
      close(socket) {
        sockets.delete(socket)
      },
      message(socket, data) {
        const frame = JSON.parse(String(data)) as Record<string, unknown>
        frames.push(frame)
        if (typeof frame.method !== 'string' || frame.id === undefined) return
        const params =
          typeof frame.params === 'object' && frame.params !== null
            ? (frame.params as Record<string, unknown>)
            : {}
        socket.send(
          JSON.stringify({ id: frame.id, ...answer(frame.method, params) }),
        )
      },
    },
  })

  return {
    url: `ws://127.0.0.1:${server.port}`,
    frames,
    upgrades,
    calls(method) {
      return frames
        .filter(frame => frame.method === method && frame.id !== undefined)
        .map(frame =>
          typeof frame.params === 'object' && frame.params !== null
            ? (frame.params as Record<string, unknown>)
            : {},
        )
    },
    inputs(turnId) {
      return inputs.get(turnId) ?? []
    },
    turns,
    rolloutOf(threadId) {
      return threads.get(threadId)?.path
    },
    release(turnId) {
      const id = turnId ?? turns.at(-1)
      if (id !== undefined) held.get(id)?.()
    },
    stop() {
      for (const resolve of held.values()) resolve()
      server.stop(true)
    },
  }
}
