// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * A stand-in for an ACP agent over stdio, grown from the node's
 * `fake-acp.runner.ts` for what the desktop app's runner uses (qmo-local.md
 * §4.3.3–§4.4). `FAKE_ACP_PROFILE` makes it answer like one of four agents:
 *
 * | profile | modes in `session/new` | permission options | continues by |
 * |---|---|---|---|
 * | `gemini` | `default`, `autoEdit`, `yolo`, `plan` | `proceed_always_and_save`, `proceed_always` (both `allow_always`), `proceed_once`, `cancel` | `session/load`, replayed after its answer |
 * | `qwen` | `default`, `auto-edit`, `yolo`, `plan` | as `gemini` | `session/resume` |
 * | `opencode` | `build`, `plan` (its agents, not permission modes) | `once`, `always`, `reject` | `session/resume` |
 * | `dsh` (default) | none | `allow-once`, `reject-once` | `session/resume` |
 *
 * Gemini CLI and Qwen Code ask about a call before announcing it (the
 * question carries the call and its diff; `tool_call_update` follows); the
 * others announce it with `tool_call` first. Gemini and Qwen ask for edits
 * and commands in `default`, for commands in `autoEdit` / `auto-edit`, for
 * nothing in `yolo`; opencode and dsh always ask. An edit allowed with
 * `proceed_always` is not asked again in that process; `proceed_always_and_save`
 * also writes `saved-settings.json` into the state folder, as the real one
 * writes the user's settings.
 *
 * Prompts: `edit <file>` writes it (relative to the session's cwd, or
 * absolute); `bash <cmd>` pretends to run it; `think` thinks first; `long
 * <n>` answers n characters in pieces; `hang` waits for `session/cancel`;
 * `hang-ask` asks and waits; `deaf` ignores the cancel; `spawn` starts a
 * `sleep` in its process group and ignores the cancel; `fail` answers with a
 * JSON-RPC error; `crash` exits mid-turn; anything else is echoed with the
 * session's turn count, which `FAKE_ACP_STATE` keeps across processes.
 *
 * Environment: `FAKE_ACP_STATE` (a folder: `argv.ndjson`, `methods.ndjson`
 * with every request it received, `answers.ndjson`, `sessions/<id>`),
 * `FAKE_ACP_START_MODE` (the mode a new session is in, as the user's own
 * settings may say), `FAKE_ACP_NO_YOLO=1` (no `yolo` offered),
 * `FAKE_ACP_SET_MODE_FAIL=1` (`session/set_mode` refused),
 * `FAKE_ACP_SWITCH_ON_ALWAYS=1` (an edit allowed for the session switches it
 * to `autoEdit` / `auto-edit` and says so in `current_mode_update`),
 * `FAKE_ACP_AUTH=required` (`session/new` and continuing answer that it
 * must be signed in), `FAKE_ACP_RESUME_FAIL=1` (continuing fails with a
 * passing internal error), `FAKE_ACP_IGNORE_TERM=1`, `FAKE_ACP_ENV_LOG` (where to
 * write the environment it got).
 */

import { spawn } from 'node:child_process'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'

const argv = process.argv.slice(2)
if (argv.includes('--version')) {
  console.log('0.0.1')
  process.exit(0)
}
const state = process.env.FAKE_ACP_STATE
const log = (name: string, value: unknown) => {
  if (state) appendFileSync(join(state, name), `${JSON.stringify(value)}\n`)
}
log('argv.ndjson', argv)
if (process.env.FAKE_ACP_IGNORE_TERM === '1') process.on('SIGTERM', () => {})
if (process.env.FAKE_ACP_ENV_LOG)
  writeFileSync(
    process.env.FAKE_ACP_ENV_LOG,
    JSON.stringify({ ...process.env, __cwd: process.cwd() }),
  )

type Profile = 'gemini' | 'qwen' | 'opencode' | 'dsh'
const profile: Profile =
  (['gemini', 'qwen', 'opencode', 'dsh'] as const).find(
    one => one === process.env.FAKE_ACP_PROFILE,
  ) ?? 'dsh'
const asksFirst = profile === 'gemini' || profile === 'qwen'
const signedOut = process.env.FAKE_ACP_AUTH === 'required'

function modeIds(): string[] | undefined {
  switch (profile) {
    case 'gemini':
      return ['default', 'autoEdit', 'yolo', 'plan']
    case 'qwen':
      return ['default', 'auto-edit', 'yolo', 'plan']
    case 'opencode':
      return ['build', 'plan']
    default:
      return undefined
  }
}
const available = (modeIds() ?? []).filter(
  id => !(id === 'yolo' && process.env.FAKE_ACP_NO_YOLO === '1'),
)

interface Session {
  readonly id: string
  readonly cwd: string
  mode: string
  turns: number
  /** Edits allowed for the rest of this process (`proceed_always`). */
  editsAllowed: boolean
}
const sessions = new Map<string, Session>()
const waiting = new Map<number, (result: Record<string, unknown>) => void>()
let serverSequence = 0
let cancelled: (() => void) | undefined
let deaf = false

const send = (message: Record<string, unknown>) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)

function sessionFile(id: string): string | undefined {
  return state === undefined ? undefined : join(state, 'sessions', id)
}

function remember(session: Session): void {
  const file = sessionFile(session.id)
  if (file === undefined) return
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, String(session.turns))
}

/** A session an earlier process opened, or `undefined` when it is gone. */
function recall(id: string, cwd: string): Session | undefined {
  const known = sessions.get(id)
  if (known !== undefined) return known
  const file = sessionFile(id)
  if (file === undefined || !existsSync(file)) return undefined
  const session: Session = {
    id,
    cwd,
    mode: process.env.FAKE_ACP_START_MODE ?? available[0] ?? 'default',
    turns: Number(readFileSync(file, 'utf8')),
    editsAllowed: false,
  }
  sessions.set(id, session)
  return session
}

function modes(session: Session): Record<string, unknown> {
  return available.length === 0
    ? {}
    : {
        modes: {
          currentModeId: session.mode,
          availableModes: available.map(id => ({
            id,
            name: id,
            description: `the ${id} mode`,
          })),
        },
      }
}

function update(session: Session, body: Record<string, unknown>): void {
  send({
    method: 'session/update',
    params: { sessionId: session.id, update: body },
  })
}

function options(kind: 'edit' | 'execute'): Record<string, unknown>[] {
  switch (profile) {
    case 'gemini':
    case 'qwen':
      return [
        {
          optionId: 'proceed_always_and_save',
          name: 'Always allow, and save to settings',
          kind: 'allow_always',
        },
        {
          optionId: 'proceed_always',
          name: kind === 'edit' ? 'Allow All Edits' : 'Always Allow',
          kind: 'allow_always',
        },
        { optionId: 'proceed_once', name: 'Allow', kind: 'allow_once' },
        { optionId: 'cancel', name: 'Reject', kind: 'reject_once' },
      ]
    case 'opencode':
      return [
        { optionId: 'once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
        { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
      ]
    default:
      return [
        { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
      ]
  }
}

/** Whether the session's mode has this kind of call asked about. */
function asks(session: Session, kind: 'edit' | 'execute'): boolean {
  if (profile === 'opencode' || profile === 'dsh') return true
  if (session.mode === 'yolo') return false
  if (kind === 'edit')
    return session.mode === 'default' && !session.editsAllowed
  return true
}

/** The chosen option id, or the outcome (`cancelled`). */
async function permission(
  session: Session,
  call: Record<string, unknown>,
  kind: 'edit' | 'execute',
): Promise<string> {
  const id = serverSequence++
  const result = await new Promise<Record<string, unknown>>(done => {
    waiting.set(id, done)
    send({
      id,
      method: 'session/request_permission',
      params: {
        sessionId: session.id,
        toolCall: call,
        options: options(kind),
      },
    })
  })
  const outcome = result.outcome as Record<string, unknown> | undefined
  const chosen =
    outcome?.outcome === 'selected'
      ? String(outcome.optionId)
      : String(outcome?.outcome)
  log('answers.ndjson', { kind, chosen })
  if (chosen === 'proceed_always_and_save' && state)
    writeFileSync(join(state, 'saved-settings.json'), '{"allowed":true}\n')
  if (
    kind === 'edit' &&
    (chosen === 'proceed_always' || chosen === 'proceed_always_and_save')
  ) {
    session.editsAllowed = true
    // As an older Gemini CLI does: 「Allow All Edits」 switches the session.
    if (process.env.FAKE_ACP_SWITCH_ON_ALWAYS === '1') {
      session.mode = profile === 'qwen' ? 'auto-edit' : 'autoEdit'
      update(session, {
        sessionUpdate: 'current_mode_update',
        currentModeId: session.mode,
      })
    }
  }
  return chosen
}

function allowed(chosen: string): boolean {
  return [
    'proceed_once',
    'proceed_always',
    'proceed_always_and_save',
    'once',
    'always',
    'allow-once',
  ].includes(chosen)
}

/** A call: announced (or asked about first, as Gemini does), run if allowed. */
async function useTool(
  session: Session,
  input: {
    readonly id: string
    readonly kind: 'edit' | 'execute'
    readonly title: string
    readonly rawInput: Record<string, unknown>
    readonly locations?: readonly string[]
    readonly diff?: { path: string; oldText: string | null; newText: string }
  },
  run: () => string | undefined,
): Promise<boolean> {
  const announced = {
    toolCallId: input.id,
    title: input.title,
    kind: input.kind,
    rawInput: input.rawInput,
    locations: (input.locations ?? []).map(path => ({ path })),
  }
  const diff = input.diff === undefined ? [] : [{ type: 'diff', ...input.diff }]
  const ask = asks(session, input.kind)
  if (!ask || !asksFirst)
    update(session, {
      sessionUpdate: 'tool_call',
      status: ask ? 'pending' : 'in_progress',
      ...announced,
      content: asksFirst ? [] : diff,
    })
  let chosen = 'unasked'
  if (ask) {
    chosen = await permission(
      session,
      asksFirst
        ? { ...announced, status: 'pending', content: diff }
        : { toolCallId: input.id },
      input.kind,
    )
    if (!allowed(chosen)) {
      update(session, {
        sessionUpdate: 'tool_call_update',
        toolCallId: input.id,
        status: 'failed',
        content: [
          {
            type: 'content',
            content: {
              type: 'text',
              text: `the user rejected "${input.title}"`,
            },
          },
        ],
      })
      return false
    }
  }
  const output = run()
  update(session, {
    sessionUpdate: 'tool_call_update',
    toolCallId: input.id,
    status: 'completed',
    content:
      input.diff !== undefined
        ? diff
        : output === undefined
          ? []
          : [{ type: 'content', content: { type: 'text', text: output } }],
  })
  return true
}

async function prompt(
  id: number,
  session: Session,
  text: string,
): Promise<void> {
  session.turns++
  remember(session)
  const turn = session.turns
  let message = 0
  const say = (body: string, pieces = 1) => {
    const messageId = `m-${turn}-${++message}`
    const size = Math.max(1, Math.ceil(body.length / pieces))
    for (let at = 0; at < body.length; at += size)
      update(session, {
        sessionUpdate: 'agent_message_chunk',
        messageId,
        content: { type: 'text', text: body.slice(at, at + size) },
      })
  }
  const done = (stopReason = 'end_turn') => send({ id, result: { stopReason } })
  const [verb = '', ...rest] = text.split(' ')
  const arg = rest.join(' ')
  switch (verb) {
    case 'think':
      update(session, {
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: 'THOUGHT-NOT-ANSWER' },
      })
      say(`acp(${turn}): thought`)
      done()
      return
    case 'long': {
      const length = Number(arg) || 1000
      say('x'.repeat(length), Math.ceil(length / 100))
      done()
      return
    }
    case 'edit': {
      const file = isAbsolute(arg) ? arg : resolve(session.cwd, arg)
      const before = existsSync(file) ? readFileSync(file, 'utf8') : null
      say('Editing.')
      const ok = await useTool(
        session,
        {
          id: `call_edit_${turn}`,
          kind: 'edit',
          title: `Writing to ${arg}`,
          rawInput: { file_path: file, content: 'edited by fake\n' },
          locations: [file],
          diff: { path: file, oldText: before, newText: 'edited by fake\n' },
        },
        () => {
          writeFileSync(file, 'edited by fake\n')
          return undefined
        },
      )
      say(`acp(${turn}): edit ${ok ? 'done' : 'refused'}`)
      done()
      return
    }
    case 'bash': {
      const ok = await useTool(
        session,
        {
          id: `call_bash_${turn}`,
          kind: 'execute',
          title: arg,
          rawInput: { command: arg },
        },
        () => `ran: ${arg}`,
      )
      say(`acp(${turn}): bash ${ok ? 'done' : 'refused'}`)
      done()
      return
    }
    case 'hang':
    case 'hang-ask':
    case 'deaf': {
      say('Working…')
      deaf = verb === 'deaf'
      let asked: Promise<boolean> | undefined
      if (verb === 'hang-ask')
        asked = useTool(
          session,
          {
            id: `call_slow_${turn}`,
            kind: 'execute',
            title: 'sleep 100',
            rawInput: { command: 'sleep 100' },
          },
          () => 'slept',
        )
      await new Promise<void>(go => {
        cancelled = go
      })
      if (asked !== undefined)
        log('answers.ndjson', { afterCancel: await asked })
      done('cancelled')
      return
    }
    case 'spawn': {
      // In its process group: it outlives the agent unless the group is stopped.
      const sleeper =
        process.env.FAKE_ACP_IGNORE_TERM === '1'
          ? spawn('/bin/sh', ['-c', 'trap "" TERM; exec /bin/sleep 30'], {
              stdio: 'ignore',
            })
          : spawn('/bin/sleep', ['30'], { stdio: 'ignore' })
      log('grandchild.ndjson', sleeper.pid)
      deaf = true
      say('Started something.')
      return
    }
    case 'fail':
      send({
        id,
        error: { code: -32603, message: 'turn failed: upstream exploded' },
      })
      return
    case 'crash':
      say('About to go.')
      setTimeout(() => process.exit(3), 20)
      return
    default:
      say(`acp(${turn}): ${text}`)
      done()
  }
}

const AUTH_REQUIRED = {
  code: -32000,
  message: 'Authentication required',
  data: { reason: 'not signed in' },
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
  log('methods.ndjson', { method, params })
  switch (method) {
    case 'initialize':
      send({
        id,
        result: {
          protocolVersion: 1,
          agentInfo: { name: `fake-${profile}`, version: '0.0.1' },
          agentCapabilities: {
            mcpCapabilities: { http: true, sse: true },
            promptCapabilities: { image: false },
            sessionCapabilities: profile === 'gemini' ? {} : { resume: {} },
            ...(profile === 'gemini' ? { loadSession: true } : {}),
          },
          authMethods: [{ id: 'oauth', name: 'Sign in', description: null }],
        },
      })
      return
    case 'authenticate':
      // Logged above; a client that respects the user's own login never sends it.
      send({ id, result: {} })
      return
    case 'session/new': {
      if (signedOut) {
        send({ id, error: AUTH_REQUIRED })
        return
      }
      const session: Session = {
        id: crypto.randomUUID(),
        cwd: String(params.cwd),
        mode: process.env.FAKE_ACP_START_MODE ?? available[0] ?? 'default',
        turns: 0,
        editsAllowed: false,
      }
      sessions.set(session.id, session)
      remember(session)
      send({ id, result: { sessionId: session.id, ...modes(session) } })
      return
    }
    case 'session/resume':
    case 'session/load': {
      if (signedOut) {
        send({ id, error: AUTH_REQUIRED })
        return
      }
      const sessionId = String(params.sessionId)
      if (process.env.FAKE_ACP_RESUME_FAIL === '1') {
        // It has the conversation but cannot open it now.
        send({
          id,
          error: { code: -32603, message: 'Internal error', data: null },
        })
        return
      }
      const session = recall(sessionId, String(params.cwd))
      if (session === undefined) {
        send({
          id,
          error:
            method === 'session/load'
              ? { code: -32002, message: 'Resource not found', data: sessionId }
              : { code: -32602, message: `unknown session ${sessionId}` },
        })
        return
      }
      send({ id, result: modes(session) })
      if (method === 'session/load')
        // Like Gemini CLI: the old conversation after the answer.
        void (async () => {
          for (const [kind, said] of [
            ['user_message_chunk', 'old question'],
            ['agent_message_chunk', 'OLD-ANSWER'],
          ]) {
            await new Promise(go => setTimeout(go, 20))
            update(session, {
              sessionUpdate: kind,
              content: { type: 'text', text: said },
            })
          }
        })()
      return
    }
    case 'session/set_mode': {
      const session = sessions.get(String(params.sessionId))
      const mode = String(params.modeId)
      if (session === undefined || !available.includes(mode)) {
        send({ id, error: { code: -32602, message: `Invalid mode: ${mode}` } })
        return
      }
      if (process.env.FAKE_ACP_SET_MODE_FAIL === '1') {
        send({
          id,
          error: {
            code: -32603,
            message: 'Cannot change the approval mode in an untrusted folder',
          },
        })
        return
      }
      session.mode = mode
      send({ id, result: {} })
      update(session, {
        sessionUpdate: 'current_mode_update',
        currentModeId: mode,
      })
      return
    }
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
      if (deaf) return
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
