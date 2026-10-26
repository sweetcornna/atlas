// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * A stand-in for `codex app-server` over stdio, grown from the node's
 * `fake-codex.runner.ts` for what the desktop app's runner uses
 * (qmo-local.md §4.3.4, §4.3.5, §4.4):
 *
 * - `thread/start` and `thread/resume` take `approvalPolicy` and `sandbox`;
 *   a `turn/start`'s `approvalPolicy` and `sandboxPolicy` override them from
 *   that turn on. With `FAKE_CODEX_STATE` a thread is kept on disk, so a
 *   resumed one counts its turns on and an unknown one cannot be resumed.
 * - Edits: asked under `untrusted`, under `on-request` when outside the
 *   working folder, never under `never`; a file answered
 *   `acceptForSession` is not asked about again in this process. The
 *   `fileChange` item starts before its approval, as the app-server does.
 * - Commands: asked under `untrusted` (one answered `acceptForSession` not
 *   again); `escalate` asks under `on-request` too.
 * - Answers: `item/agentMessage/delta` before each message,
 *   `item/commandExecution/outputDelta` before a command's end,
 *   `turn/diff/updated` after an edit.
 *
 * Prompts: `edit <file>` writes `<file>` (relative to the working folder,
 * or absolute); `bash <cmd>` and `escalate <cmd>` pretend to run it;
 * `think` thinks first; `long <n>` answers n characters; `hang` waits for
 * `turn/interrupt`; `wait-ask` asks and waits, an interrupt withdraws the
 * question (`serverRequest/resolved`); `mcp` asks through an MCP
 * elicitation; `fail` and `login` end the turn failed; `crash` exits
 * mid-turn; anything else is echoed with the thread's turn count.
 *
 * Environment: `FAKE_CODEX_STATE` (a folder: `argv.ndjson`,
 * `requests.ndjson` with every request and notification it got,
 * `answers.ndjson` with every answer to its own requests, `turns.ndjson`
 * with the policy each turn ran in, `threads.json`),
 * `FAKE_CODEX_NO_SESSION=1` (`availableDecisions` without
 * `acceptForSession`), `FAKE_CODEX_IGNORE_TERM=1`, `FAKE_CODEX_ENV_LOG`
 * (where to write the environment it got), `FAKE_CODEX_ONE_WRITE=1` (the
 * `turn/start` answer and what the turn says until it first waits go out in
 * one write: what a client reading late gets in one read).
 */

import { randomBytes } from 'node:crypto'
import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { createInterface } from 'node:readline'

const argv = process.argv.slice(2)
if (argv.includes('--version')) {
  console.log('codex-cli 0.164.0')
  process.exit(0)
}
const state = process.env.FAKE_CODEX_STATE
const log = (name: string, value: unknown) => {
  if (state) appendFileSync(join(state, name), `${JSON.stringify(value)}\n`)
}
log('argv.ndjson', argv)
if (process.env.FAKE_CODEX_IGNORE_TERM === '1') process.on('SIGTERM', () => {})
if (process.env.FAKE_CODEX_ENV_LOG)
  writeFileSync(
    process.env.FAKE_CODEX_ENV_LOG,
    JSON.stringify({ ...process.env, __cwd: process.cwd() }),
  )

/** Lines held for one write (`FAKE_CODEX_ONE_WRITE`), while a turn starts. */
let held: string[] | undefined
const send = (message: Record<string, unknown>) => {
  const line = `${JSON.stringify(message)}\n`
  if (held !== undefined) held.push(line)
  else process.stdout.write(line)
}

const threadsFile = state ? join(state, 'threads.json') : undefined
function threads(): Record<string, number> {
  if (threadsFile === undefined || !existsSync(threadsFile)) return {}
  return JSON.parse(readFileSync(threadsFile, 'utf8')) as Record<string, number>
}
function saveTurns(id: string, turns: number): void {
  if (threadsFile === undefined) return
  writeFileSync(threadsFile, JSON.stringify({ ...threads(), [id]: turns }))
}

let thread = ''
let cwd = process.cwd()
let turns = 0
let total = 0
let approvalPolicy = 'on-request'
let sandbox = 'workspace-write'
let hanging: string | undefined
let waitingAsk: number | undefined
const sessionFiles = new Set<string>()
const sessionCommands = new Set<string>()
const waiting = new Map<number, (result: Record<string, unknown>) => void>()
let serverSequence = 1000

/** Asks the client; resolves with its answer. */
function request(
  method: string,
  params: Record<string, unknown>,
  hold?: (id: number) => void,
): Promise<Record<string, unknown>> {
  const id = ++serverSequence
  return new Promise(resolve => {
    waiting.set(id, result => {
      log('answers.ndjson', { method, result })
      resolve(result)
    })
    hold?.(id)
    send({ id, method, params })
  })
}

const allowed = (decision: unknown) =>
  decision === 'accept' || decision === 'acceptForSession'

function usage(): void {
  total += 1000
  send({
    method: 'thread/tokenUsage/updated',
    params: {
      threadId: thread,
      turnId: `turn-${turns}`,
      tokenUsage: {
        total: {
          totalTokens: total,
          inputTokens: total,
          cachedInputTokens: total - 100,
          cacheWriteInputTokens: 0,
          outputTokens: turns * 10,
          reasoningOutputTokens: 0,
        },
        last: {},
        modelContextWindow: null,
      },
    },
  })
}

function complete(
  turnId: string,
  status: string,
  error?: Record<string, unknown>,
): void {
  send({
    method: 'turn/completed',
    params: {
      threadId: thread,
      turn: { id: turnId, status, error: error ?? null, items: [] },
    },
  })
}

function say(turnId: string, text: string): void {
  const itemId = `msg-${turns}-${randomBytes(3).toString('hex')}`
  for (let at = 0; at < text.length; at += 1000)
    send({
      method: 'item/agentMessage/delta',
      params: {
        threadId: thread,
        turnId,
        itemId,
        delta: text.slice(at, at + 1000),
      },
    })
  send({
    method: 'item/completed',
    params: {
      threadId: thread,
      turnId,
      item: { type: 'agentMessage', id: itemId, text },
    },
  })
}

function item(
  turnId: string,
  phase: 'started' | 'completed',
  body: Record<string, unknown>,
): void {
  send({
    method: `item/${phase}`,
    params: { threadId: thread, turnId, item: body },
  })
}

async function edit(turnId: string, name: string): Promise<string> {
  const file = isAbsolute(name) ? name : join(cwd, name)
  const inside = !relative(resolve(cwd), resolve(file)).startsWith('..')
  const itemId = `patch-${turns}`
  const content = 'written by fake codex\n'
  const changes = [{ path: file, kind: { type: 'add' }, diff: content }]
  item(turnId, 'started', {
    type: 'fileChange',
    id: itemId,
    changes,
    status: 'inProgress',
  })
  const asks =
    !sessionFiles.has(file) &&
    (approvalPolicy === 'untrusted' ||
      (approvalPolicy === 'on-request' && !inside))
  let ok = true
  if (asks) {
    const answer = await request('item/fileChange/requestApproval', {
      threadId: thread,
      turnId,
      itemId,
      reason: inside ? null : 'outside the workspace',
      ...(inside ? {} : { grantRoot: resolve(file, '..') }),
    })
    ok = allowed(answer.decision)
    if (answer.decision === 'acceptForSession') sessionFiles.add(file)
  }
  if (ok) writeFileSync(file, content)
  item(turnId, 'completed', {
    type: 'fileChange',
    id: itemId,
    changes,
    status: ok ? 'completed' : 'declined',
  })
  if (ok) {
    const shown = relative(cwd, file) || file
    send({
      method: 'turn/diff/updated',
      params: {
        threadId: thread,
        turnId,
        diff: `diff --git a/${shown} b/${shown}\nnew file mode 100644\n--- /dev/null\n+++ b/${shown}\n@@ -0,0 +1 @@\n+written by fake codex\n`,
      },
    })
  }
  return ok ? `edited ${name}` : `not allowed to edit ${name}`
}

async function command(
  turnId: string,
  line: string,
  escalate: boolean,
): Promise<string> {
  const itemId = `cmd-${turns}`
  const asks =
    !sessionCommands.has(line) &&
    (approvalPolicy === 'untrusted' ||
      (escalate && approvalPolicy === 'on-request'))
  let ok = true
  if (asks) {
    const answer = await request('item/commandExecution/requestApproval', {
      threadId: thread,
      turnId,
      itemId,
      command: line,
      cwd,
      reason: escalate ? 'needs the network' : null,
      ...(process.env.FAKE_CODEX_NO_SESSION === '1'
        ? { availableDecisions: ['accept', 'decline', 'cancel'] }
        : {}),
    })
    ok = allowed(answer.decision)
    if (answer.decision === 'acceptForSession') sessionCommands.add(line)
  }
  const body = { type: 'commandExecution', id: itemId, command: line, cwd }
  item(turnId, 'started', { ...body, status: 'inProgress' })
  if (!ok) {
    item(turnId, 'completed', { ...body, status: 'declined' })
    return `not allowed to run ${line}`
  }
  for (const delta of ['out 1\n', 'out 2\n'])
    send({
      method: 'item/commandExecution/outputDelta',
      params: { threadId: thread, turnId, itemId, delta },
    })
  item(turnId, 'completed', {
    ...body,
    status: 'completed',
    exitCode: 0,
    aggregatedOutput: 'out 1\nout 2\n',
  })
  return `ran ${line}`
}

async function run(turnId: string, text: string): Promise<void> {
  send({ method: 'turn/started', params: { threadId: thread, turnId } })
  const [word = '', ...rest] = text.split(' ')
  const arg = rest.join(' ')
  if (word === 'hang') {
    hanging = turnId
    return
  }
  if (word === 'crash') {
    say(turnId, 'about to go')
    process.exit(3)
  }
  if (word === 'wait-ask') {
    hanging = turnId
    void request(
      'item/commandExecution/requestApproval',
      { threadId: thread, turnId, itemId: `cmd-${turns}`, command: 'sleep 9' },
      id => {
        waitingAsk = id
      },
    )
    return
  }
  if (word === 'fail') {
    usage()
    complete(turnId, 'failed', { message: 'model overloaded' })
    return
  }
  if (word === 'login') {
    usage()
    complete(turnId, 'failed', {
      message: 'unexpected status 401 Unauthorized: Missing bearer',
      codexErrorInfo: 'unauthorized',
    })
    return
  }
  if (word === 'think')
    for (const delta of ['Looking', ' around'])
      send({
        method: 'item/reasoning/summaryTextDelta',
        params: {
          threadId: thread,
          turnId,
          itemId: 'reason-1',
          delta,
          summaryIndex: 0,
        },
      })
  let answer = `codex(${turns}): ${text}`
  if (word === 'edit') answer = await edit(turnId, arg)
  else if (word === 'bash' || word === 'escalate')
    answer = await command(turnId, arg, word === 'escalate')
  else if (word === 'long') answer = 'x'.repeat(Number(arg))
  else if (word === 'mcp') {
    const reply = await request('mcpServer/elicitation/request', {
      threadId: thread,
      turnId,
      serverName: 'docs',
      mode: 'form',
      message: 'Allow the tool to run?',
      requestedSchema: { type: 'object', properties: {} },
      _meta: { codex_approval_kind: 'mcp_tool_call', tool_name: 'search' },
    })
    answer = `mcp action=${String(reply.action)}`
  }
  say(turnId, answer)
  usage()
  complete(turnId, 'completed')
}

const sandboxOf = (policy: unknown): string | undefined => {
  const type = (policy as { type?: unknown } | null)?.type
  return type === 'dangerFullAccess'
    ? 'danger-full-access'
    : type === 'workspaceWrite'
      ? 'workspace-write'
      : type === 'readOnly'
        ? 'read-only'
        : undefined
}

function open(params: Record<string, unknown>): void {
  if (typeof params.cwd === 'string') cwd = params.cwd
  if (typeof params.approvalPolicy === 'string')
    approvalPolicy = params.approvalPolicy
  if (typeof params.sandbox === 'string') sandbox = params.sandbox
}

createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line) as {
    id?: number
    method?: string
    params?: Record<string, unknown>
    result?: Record<string, unknown>
  }
  if (message.method === undefined && message.id !== undefined) {
    waiting.get(message.id)?.(message.result ?? {})
    waiting.delete(message.id)
    return
  }
  const params = message.params ?? {}
  log('requests.ndjson', { method: message.method, params })
  switch (message.method) {
    case 'initialize':
      send({ id: message.id, result: { userAgent: 'fake-codex' } })
      return
    case 'initialized':
      return
    case 'skills/list':
      send({ id: message.id, result: { data: [] } })
      return
    case 'thread/start':
      open(params)
      thread = `thread-${randomBytes(6).toString('hex')}`
      turns = 0
      saveTurns(thread, 0)
      send({ id: message.id, result: { thread: { id: thread } } })
      return
    case 'thread/resume': {
      const id = String(params.threadId)
      const known = threads()[id]
      if (known === undefined) {
        send({
          id: message.id,
          error: { code: -32600, message: `no rollout found for ${id}` },
        })
        return
      }
      open(params)
      thread = id
      turns = known
      send({ id: message.id, result: { thread: { id: thread } } })
      return
    }
    case 'turn/start': {
      if (typeof params.approvalPolicy === 'string')
        approvalPolicy = params.approvalPolicy
      sandbox = sandboxOf(params.sandboxPolicy) ?? sandbox
      turns += 1
      saveTurns(thread, turns)
      log('turns.ndjson', { thread, approvalPolicy, sandbox })
      const turnId = `turn-${turns}`
      const input = params.input as { text: string }[]
      const text = input.map(part => part.text).join('')
      if (process.env.FAKE_CODEX_ONE_WRITE === '1') held = []
      send({ id: message.id, result: { turn: { id: turnId } } })
      void run(turnId, text)
      if (held !== undefined)
        // After the turn's promise steps, before any I/O it waits for.
        setImmediate(() => {
          const out = (held ?? []).join('')
          held = undefined
          process.stdout.write(out)
        })
      return
    }
    case 'turn/interrupt':
      send({ id: message.id, result: {} })
      if (waitingAsk !== undefined) {
        waiting.delete(waitingAsk)
        send({
          method: 'serverRequest/resolved',
          params: { threadId: thread, requestId: waitingAsk },
        })
        waitingAsk = undefined
      }
      if (hanging !== undefined) {
        complete(hanging, 'interrupted')
        hanging = undefined
      }
      return
    default:
      send({
        id: message.id,
        error: { code: -32601, message: `unknown ${message.method}` },
      })
  }
})
