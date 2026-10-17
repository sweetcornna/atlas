// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * A stand-in for an ACP agent over stdio, shaped like `dsh --profile acp`:
 * `initialize`, `session/new` / `session/resume`, `session/set_config_option`,
 * `session/prompt` with ordered `session/update`s, `session/cancel`,
 * `session/request_permission` (allow-once / reject-once), and real usage
 * only in a plain-JSONL session log under `$DSH_HOME/sessions`, written a
 * little after the prompt is answered (dsh batches its log writes).
 *
 * Prompts: `tool` reads a file; `write <path>` asks to write `<path>` and
 * writes it only when allowed; `bash` asks to run a command; `hang` waits for
 * `session/cancel`; `hang-ask` asks and waits; `fail` answers with a JSON-RPC
 * error; `long` stops at max tokens; `noise` sends what a client must ignore;
 * `mcp <tool>` asks to call an MCP tool; `crash` exits mid-turn; anything
 * else is echoed.
 *
 * `QIANMO_FIXTURE_LOG` (a file) gets one JSON line per event the test checks.
 * `QIANMO_FAKE_ACP_LOAD=late` offers `session/load` instead of
 * `session/resume` and, like Gemini CLI, replays the old conversation only
 * after answering it.
 */

import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { dshProjectKey } from '../../../src/host/runtimes/dsh.js'

const logFile = process.env.QIANMO_FIXTURE_LOG
const log = (entry: Record<string, unknown>) => {
  if (logFile) appendFileSync(logFile, `${JSON.stringify(entry)}\n`)
}
const send = (message: Record<string, unknown>) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
const lateLoad = process.env.QIANMO_FAKE_ACP_LOAD === 'late'

log({
  event: 'start',
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  env: {
    DSH_HOME: process.env.DSH_HOME ?? null,
    DSH_AGENTS_HOME: process.env.DSH_AGENTS_HOME ?? null,
    DSH_TELEMETRY_DISABLED: process.env.DSH_TELEMETRY_DISABLED ?? null,
    QM_DSH_GATEWAY_KEY: process.env.QM_DSH_GATEWAY_KEY ?? null,
    DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY ?? null,
    DEEPSEEK_BASE_URL: process.env.DEEPSEEK_BASE_URL ?? null,
  },
})

interface Session {
  readonly id: string
  readonly cwd: string
  turns: number
  seq: number
}
const sessions = new Map<string, Session>()
const waiting = new Map<number, (result: Record<string, unknown>) => void>()
let serverSequence = 0
let cancelled: (() => void) | undefined

function sessionLog(session: Session): string {
  const home = process.env.DSH_HOME ?? '/nonexistent'
  return join(
    home,
    'sessions',
    dshProjectKey(session.cwd),
    session.id,
    'session.v4.jsonl',
  )
}

function persist(session: Session, events: Record<string, unknown>[]): void {
  const file = sessionLog(session)
  mkdirSync(join(file, '..'), { recursive: true })
  appendFileSync(
    file,
    events
      .map(event => JSON.stringify({ seq: session.seq++, ...event }))
      .join('\n')
      .concat('\n'),
  )
}

function update(session: Session, body: Record<string, unknown>): void {
  send({
    method: 'session/update',
    params: { sessionId: session.id, update: body },
  })
}

function ask(
  session: Session,
  toolCallId: string,
): Promise<Record<string, unknown>> {
  const id = serverSequence++
  return new Promise(done => {
    waiting.set(id, done)
    send({
      id,
      method: 'session/request_permission',
      params: {
        sessionId: session.id,
        toolCall: { toolCallId },
        options: [
          { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
        ],
      },
    })
  })
}

function chosen(result: Record<string, unknown>): string {
  const outcome = result.outcome as Record<string, unknown> | undefined
  return outcome?.outcome === 'selected'
    ? String(outcome.optionId)
    : String(outcome?.outcome)
}

async function prompt(
  id: number,
  session: Session,
  text: string,
): Promise<void> {
  // The model call a replay overlaps with.
  if (lateLoad) await new Promise(done => setTimeout(done, 150))
  session.turns++
  const turn = session.turns
  const step = (n: number) => ({
    type: 'assistant/message',
    data: {
      turn,
      step: n,
      usage: {
        inputTokens: 100 * turn,
        outputTokens: 10,
        totalTokens: 100 * turn + 10 + 500,
        cacheReadTokens: 500,
        ...(n === 2 ? { cacheWriteTokens: 7 } : {}),
      },
    },
  })
  const answer = (result: Record<string, unknown>, steps: number) => {
    send({ id, result })
    // Like dsh: the log reaches disk in a batch after the answer.
    setTimeout(() => {
      persist(session, [
        { type: 'turn/start', data: { turn } },
        ...Array.from({ length: steps }, (_, at) => step(at + 1)),
        { type: 'turn/end', data: { turn, reason: { kind: 'completed' } } },
      ])
    }, 120)
  }
  const say = (body: string) =>
    update(session, {
      sessionUpdate: 'agent_message_chunk',
      messageId: `m-${turn}-${body.length}`,
      content: { type: 'text', text: body },
    })
  update(session, {
    sessionUpdate: 'agent_thought_chunk',
    content: { type: 'text', text: 'THOUGHT-NOT-ANSWER' },
  })
  const [verb, ...rest] = text.split(' ')
  switch (verb) {
    case 'tool': {
      say('Reading.')
      update(session, {
        sessionUpdate: 'tool_call',
        toolCallId: 'call_read',
        title: 'read',
        kind: 'other',
        status: 'in_progress',
        rawInput: { file_path: 'README.md' },
      })
      update(session, {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call_read',
        status: 'completed',
        content: [
          { type: 'content', content: { type: 'text', text: 'hello' } },
        ],
      })
      say(`acp(${turn}): read done`)
      update(session, { sessionUpdate: 'usage_update', used: 999999, size: 1 })
      answer({ stopReason: 'end_turn' }, 2)
      return
    }
    case 'write': {
      const target = rest.join(' ')
      update(session, {
        sessionUpdate: 'tool_call',
        toolCallId: 'call_write',
        title: 'write',
        kind: 'other',
        status: 'in_progress',
        rawInput: { file_path: target, content: 'written\n' },
      })
      const decision = chosen(await ask(session, 'call_write'))
      if (decision === 'allow-once') {
        writeFileSync(
          isAbsolute(target) ? target : resolve(session.cwd, target),
          'written\n',
        )
        update(session, {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'call_write',
          status: 'completed',
        })
      } else
        update(session, {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'call_write',
          status: 'failed',
          content: [
            {
              type: 'content',
              content: { type: 'text', text: 'the user rejected tool "write"' },
            },
          ],
        })
      say(`acp(${turn}): write ${decision}`)
      answer({ stopReason: 'end_turn' }, 2)
      return
    }
    case 'bash': {
      update(session, {
        sessionUpdate: 'tool_call',
        toolCallId: 'call_bash',
        title: 'bash',
        kind: 'other',
        status: 'in_progress',
        rawInput: { command: 'echo hi', description: 'Say hi' },
      })
      const decision = chosen(await ask(session, 'call_bash'))
      update(session, {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call_bash',
        status: decision === 'allow-once' ? 'completed' : 'failed',
      })
      say(`acp(${turn}): bash ${decision}`)
      answer({ stopReason: 'end_turn' }, 1)
      return
    }
    case 'mcp': {
      // A tool call on an MCP server, asked about like dsh's gate does.
      const title = rest[0] ?? 'mcp__docs__search'
      update(session, {
        sessionUpdate: 'tool_call',
        toolCallId: 'call_mcp',
        title,
        kind: 'other',
        status: 'in_progress',
        rawInput: { q: 'cache' },
      })
      const decision = chosen(await ask(session, 'call_mcp'))
      update(session, {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call_mcp',
        status: decision === 'allow-once' ? 'completed' : 'failed',
      })
      say(`acp(${turn}): ${title} ${decision}`)
      answer({ stopReason: 'end_turn' }, 1)
      return
    }
    case 'hang':
    case 'hang-ask': {
      say('Working…')
      let decision: Promise<Record<string, unknown>> | undefined
      if (verb === 'hang-ask') {
        update(session, {
          sessionUpdate: 'tool_call',
          toolCallId: 'call_slow',
          title: 'bash',
          kind: 'other',
          status: 'in_progress',
          rawInput: { command: 'sleep 100' },
        })
        decision = ask(session, 'call_slow')
      }
      await new Promise<void>(done => {
        cancelled = done
      })
      if (decision !== undefined)
        log({
          event: 'permission-after-cancel',
          decision: chosen(await decision),
        })
      answer({ stopReason: 'cancelled' }, 1)
      return
    }
    case 'fail':
      send({
        id,
        error: { code: -32603, message: 'turn failed: upstream exploded' },
      })
      return
    case 'long':
      say(`acp(${turn}): cut`)
      answer({ stopReason: 'max_tokens' }, 1)
      return
    case 'noise': {
      process.stdout.write('dsh banner: not json\n')
      send({ method: 'foo/bar', params: { x: 1 } })
      update(session, { sessionUpdate: 'something_new', x: 1 })
      send({
        method: 'session/update',
        params: {
          sessionId: 'another-session',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'NOT-MINE' },
          },
        },
      })
      const reply = await new Promise<Record<string, unknown>>(done => {
        const rid = serverSequence++
        waiting.set(rid, done)
        send({
          id: rid,
          method: 'fs/read_text_file',
          params: { sessionId: session.id, path: '/etc/hosts' },
        })
      })
      log({ event: 'fs-reply', reply })
      say(`acp(${turn}): ${text}`)
      answer({ stopReason: 'end_turn' }, 1)
      return
    }
    case 'crash':
      say('About to go.')
      setTimeout(() => process.exit(3), 20)
      return
    default:
      say(`acp(${turn}): ${text}`)
      answer({ stopReason: 'end_turn' }, 1)
  }
}

const lines = createInterface({ input: process.stdin })
lines.on('line', line => {
  const message = JSON.parse(line) as Record<string, unknown>
  const { id, method } = message
  const params = (message.params ?? {}) as Record<string, unknown>
  if (method === undefined && typeof id === 'number') {
    waiting.get(id)?.((message.result ?? message.error ?? {}) as never)
    waiting.delete(id)
    return
  }
  log({ event: 'request', method, params })
  switch (method) {
    case 'initialize':
      send({
        id,
        result: {
          protocolVersion: 1,
          agentInfo: { name: 'fake-acp', version: '0.0.1' },
          agentCapabilities: {
            mcpCapabilities: { http: true },
            promptCapabilities: { image: false },
            sessionCapabilities: lateLoad
              ? { close: {}, list: {} }
              : { close: {}, list: {}, resume: {} },
            ...(lateLoad ? { loadSession: true } : {}),
          },
          authMethods: [],
        },
      })
      return
    case 'session/new': {
      const session: Session = {
        id: crypto.randomUUID(),
        cwd: String(params.cwd),
        turns: 0,
        seq: 0,
      }
      sessions.set(session.id, session)
      send({
        id,
        result: {
          sessionId: session.id,
          configOptions: [
            {
              id: 'reasoning_effort',
              name: 'Reasoning effort',
              type: 'select',
              currentValue: 'high',
              options: [
                { value: 'low', name: 'Low' },
                { value: 'medium', name: 'Medium' },
                { value: 'high', name: 'High' },
              ],
            },
          ],
        },
      })
      return
    }
    case 'session/resume': {
      const sessionId = String(params.sessionId)
      if (!sessionId.startsWith('gone-')) {
        sessions.set(sessionId, {
          id: sessionId,
          cwd: String(params.cwd),
          turns: 0,
          seq: 1000,
        })
        send({ id, result: {} })
      } else
        send({
          id,
          error: { code: -32602, message: `unknown session ${sessionId}` },
        })
      return
    }
    case 'session/load': {
      const session: Session = {
        id: String(params.sessionId),
        cwd: String(params.cwd),
        turns: 0,
        seq: 1000,
      }
      sessions.set(session.id, session)
      send({ id, result: {} })
      void (async () => {
        for (const [kind, text] of [
          ['user_message_chunk', 'old question'],
          ['agent_message_chunk', 'old '],
          ['agent_message_chunk', 'answer'],
        ]) {
          await new Promise(done => setTimeout(done, 20))
          update(session, {
            sessionUpdate: kind,
            content: { type: 'text', text },
          })
        }
      })()
      return
    }
    case 'session/set_config_option':
      send({ id, result: { configOptions: [] } })
      return
    case 'session/prompt': {
      const session = sessions.get(String(params.sessionId))
      if (session === undefined) {
        send({ id, error: { code: -32602, message: 'unknown session' } })
        return
      }
      const blocks = (params.prompt ?? []) as { text?: string }[]
      void prompt(id as number, session, blocks.at(-1)?.text ?? '')
      return
    }
    case 'session/cancel':
      cancelled?.()
      cancelled = undefined
      return
    default:
      if (id !== undefined)
        send({
          id,
          error: {
            code: -32601,
            message: `Method not found: ${String(method)}`,
          },
        })
  }
})
lines.on('close', () => process.exit(0))
