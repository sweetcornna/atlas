// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * A stand-in for `claude -p --input-format stream-json --output-format
 * stream-json --verbose`, grown from the node's `fake-claude-code.runner.ts`
 * for what the desktop app's runner uses (qmo-local.md §4.3.3–§4.3.5):
 *
 * - `--include-partial-messages`: each text and thinking block is streamed
 *   as `stream_event` deltas before its `assistant` message.
 * - `--permission-prompt-tool stdio`: a call its mode does not allow is
 *   asked on stdout (`control_request` `can_use_tool`) and waits for the
 *   `control_response`; the answers are logged.
 * - `--permission-mode`: `default` asks for edits and commands,
 *   `acceptEdits` for commands, `auto` and `bypassPermissions` for neither;
 *   `bypassPermissions` needs `--allow-dangerously-skip-permissions`.
 *   `set_permission_mode` and `interrupt` are answered with their id.
 * - `--session-id` / `--resume`: with `FAKE_CLAUDE_STATE` the turn count is
 *   kept per session, so a resumed conversation counts on; a used id cannot
 *   start again and an unknown one cannot be resumed (as Claude Code).
 *
 * Prompts: `edit <file>` writes the file in its working folder (asked in
 * `default`); `bash <cmd>` pretends to run it (asked in `default` and
 * `acceptEdits`), `say-bash <cmd>` with a sentence in the same message;
 * `think` thinks first; `sub` has a sub-agent speak; `long
 * <n>` answers n characters; `hang` waits for an interrupt; `deaf` ignores
 * one; `spawn` starts a `sleep` in its process group and ignores
 * interrupts; `slow` answers after 400 ms; `fail` and `login` end in an error;
 * `crash` exits mid-turn; anything else is echoed with the turn count.
 *
 * Environment: `FAKE_CLAUDE_STATE` (a folder for counts and logs),
 * `FAKE_CLAUDE_NO_AUTO=1` (switching to `auto` is refused),
 * `FAKE_CLAUDE_AUTO_EXIT=1` (starting in `auto` fails at once),
 * `FAKE_CLAUDE_INIT_MODE` (the mode `init` reports, `none` for none),
 * `FAKE_CLAUDE_IGNORE_TERM=1` (SIGTERM is ignored, by what `spawn` starts
 * too), `FAKE_CLAUDE_ENV_LOG` (where to write the environment it got).
 */

import { spawn } from 'node:child_process'
import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

const argv = process.argv.slice(2)
if (argv.includes('--version')) {
  console.log('9.9.9 (Claude Code)')
  process.exit(0)
}
const state = process.env.FAKE_CLAUDE_STATE
const log = (name: string, value: unknown) => {
  if (state) appendFileSync(join(state, name), `${JSON.stringify(value)}\n`)
}
log('argv.ndjson', argv)
if (process.env.FAKE_CLAUDE_IGNORE_TERM === '1') process.on('SIGTERM', () => {})
if (process.env.FAKE_CLAUDE_ENV_LOG)
  writeFileSync(
    process.env.FAKE_CLAUDE_ENV_LOG,
    JSON.stringify({ ...process.env, __cwd: process.cwd() }),
  )

const flag = (name: string) => {
  const index = argv.indexOf(name)
  return index === -1 ? undefined : argv[index + 1]
}
const resume = flag('--resume')
const session = flag('--session-id') ?? resume ?? 'none'
const partial = argv.includes('--include-partial-messages')
const stdioAsk = flag('--permission-prompt-tool') === 'stdio'
const dangerous = argv.includes('--allow-dangerously-skip-permissions')
let mode = flag('--permission-mode') ?? 'default'

const fail = (message: string): never => {
  process.stderr.write(`Error: ${message}\n`)
  process.exit(1)
}
if (mode === 'auto' && process.env.FAKE_CLAUDE_AUTO_EXIT === '1')
  fail('auto mode is not enabled for this account')
if (mode === 'bypassPermissions' && !dangerous)
  fail('bypassPermissions needs --allow-dangerously-skip-permissions')
const countFile = state ? join(state, `${session}.count`) : undefined
if (countFile && resume !== undefined && !existsSync(countFile))
  fail(`No conversation found with session ID: ${session}`)
if (countFile && resume === undefined && existsSync(countFile))
  fail(`Session ID ${session} is already in use`)

let turn =
  countFile && existsSync(countFile)
    ? Number(readFileSync(countFile, 'utf8'))
    : 0
let started = false
let hanging: 'hang' | 'deaf' | undefined
let control = 0
let asked = 0
const answers = new Map<string, (response: Record<string, unknown>) => void>()

const emit = (event: Record<string, unknown>) =>
  process.stdout.write(`${JSON.stringify({ ...event, session_id: session })}\n`)

function stream(
  kind: 'text' | 'thinking',
  text: string,
  parent: string | null,
) {
  if (!partial) return
  const index = 0
  emit({
    type: 'stream_event',
    parent_tool_use_id: parent,
    event: {
      type: 'content_block_start',
      index,
      content_block: { type: kind },
    },
  })
  for (let at = 0; at < text.length; at += 3)
    emit({
      type: 'stream_event',
      parent_tool_use_id: parent,
      event: {
        type: 'content_block_delta',
        index,
        delta:
          kind === 'text'
            ? { type: 'text_delta', text: text.slice(at, at + 3) }
            : { type: 'thinking_delta', thinking: text.slice(at, at + 3) },
      },
    })
  emit({
    type: 'stream_event',
    parent_tool_use_id: parent,
    event: { type: 'content_block_stop', index },
  })
}

function say(text: string, parent: string | null = null, stop = 'end_turn') {
  stream('text', text, parent)
  emit({
    type: 'assistant',
    parent_tool_use_id: parent,
    message: {
      id: `msg-${turn}-${Math.random()}`,
      role: 'assistant',
      content: [{ type: 'text', text }],
      stop_reason: stop,
    },
  })
}

function result(
  text: string,
  error = false,
  subtype = error ? 'error_during_execution' : 'success',
) {
  emit({
    type: 'result',
    subtype,
    is_error: error,
    result: text,
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: 900,
      cache_creation_input_tokens: 20,
    },
  })
}

/** Asks on stdout and waits for the answer; `allow` when the mode allows it. */
async function permitted(
  tool: string,
  input: Record<string, unknown>,
  id: string,
): Promise<{ allow: boolean; message?: string }> {
  const asks = mode === 'default' || (mode === 'acceptEdits' && tool === 'Bash')
  if (!asks) return { allow: true }
  if (!stdioAsk) return { allow: false, message: 'no prompt tool' }
  const requestId = `ask-${++asked}`
  const answer = new Promise<Record<string, unknown>>(resolve =>
    answers.set(requestId, resolve),
  )
  emit({
    type: 'control_request',
    request_id: requestId,
    request: {
      subtype: 'can_use_tool',
      tool_name: tool,
      input,
      tool_use_id: id,
      description:
        tool === 'Bash'
          ? `Run ${String(input.command)}`
          : `${tool} ${String(input.file_path)}`,
      permission_suggestions: [
        {
          type: 'addRules',
          rules: [{ toolName: tool }],
          behavior: 'allow',
          destination: 'localSettings',
        },
        { type: 'setMode', mode: 'acceptEdits', destination: 'userSettings' },
      ],
    },
  })
  const response = await answer
  log('answers.ndjson', response)
  const inner = (response.response ?? {}) as Record<string, unknown>
  return inner.behavior === 'allow'
    ? { allow: true }
    : { allow: false, message: String(inner.message ?? 'denied') }
}

async function useTool(
  tool: string,
  input: Record<string, unknown>,
  run: () => string,
  words?: string,
) {
  const id = `tool-${turn}-${++control}`
  emit({
    type: 'assistant',
    parent_tool_use_id: null,
    message: {
      id: `msg-${id}`,
      role: 'assistant',
      content: [
        ...(words === undefined ? [] : [{ type: 'text', text: words }]),
        { type: 'tool_use', id, name: tool, input },
      ],
    },
  })
  const verdict = await permitted(tool, input, id)
  const content = verdict.allow ? run() : verdict.message
  emit({
    type: 'user',
    parent_tool_use_id: null,
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: id,
          content,
          is_error: !verdict.allow,
        },
      ],
    },
  })
}

async function onUser(text: string) {
  turn += 1
  if (countFile) writeFileSync(countFile, String(turn))
  if (!started) {
    started = true
    emit({
      type: 'system',
      subtype: 'init',
      tools: ['Read', 'Edit', 'Write', 'Bash'],
      model: 'fake',
      ...(process.env.FAKE_CLAUDE_INIT_MODE === 'none'
        ? {}
        : { permissionMode: process.env.FAKE_CLAUDE_INIT_MODE || mode }),
    })
  }
  const [word = '', ...rest] = text.split(' ')
  const arg = rest.join(' ')
  if (word === 'hang' || word === 'deaf') {
    hanging = word
    return
  }
  if (word === 'spawn') {
    // A program it started, in its process group, outlives it unless the group is stopped.
    // With FAKE_CLAUDE_IGNORE_TERM it ignores SIGTERM too.
    const sleeper =
      process.env.FAKE_CLAUDE_IGNORE_TERM === '1'
        ? spawn('/bin/sh', ['-c', 'trap "" TERM; exec /bin/sleep 30'], {
            stdio: 'ignore',
          })
        : spawn('/bin/sleep', ['30'], { stdio: 'ignore' })
    log('grandchild.ndjson', sleeper.pid)
    hanging = 'deaf'
    return
  }
  if (word === 'crash') process.exit(3)
  if (word === 'slow') await Bun.sleep(400)
  if (word === 'think') stream('thinking', 'let me see', null)
  if (word === 'edit') {
    const file = join(process.cwd(), arg)
    const before = existsSync(file) ? readFileSync(file, 'utf8') : undefined
    if (before === undefined)
      await useTool(
        'Write',
        { file_path: file, content: 'created by fake\n' },
        () => {
          writeFileSync(file, 'created by fake\n')
          return `File created successfully at: ${file}`
        },
      )
    else
      await useTool(
        'Edit',
        {
          file_path: file,
          old_string: before,
          new_string: `${before}edited\n`,
        },
        () => {
          writeFileSync(file, `${before}edited\n`)
          return `The file ${file} has been updated.`
        },
      )
  }
  if (word === 'bash')
    await useTool('Bash', { command: arg }, () => `ran: ${arg}`)
  if (word === 'say-bash')
    await useTool('Bash', { command: arg }, () => `ran: ${arg}`, 'Running it.')
  if (word === 'sub') say('a sub-agent speaks', 'tool-parent')
  if (word === 'fail') return result('upstream exploded', true)
  if (word === 'login')
    return result('Invalid API key · Please run /login', true)
  const reply =
    word === 'long' ? 'x'.repeat(Number(arg)) : `echo(${turn}): ${text}`
  say(reply)
  result(reply)
}

createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line) as Record<string, unknown>
  if (message.type === 'control_response') {
    const response = (message.response ?? {}) as Record<string, unknown>
    answers.get(String(response.request_id))?.(response)
    answers.delete(String(response.request_id))
    return
  }
  if (message.type === 'control_request') {
    const request = (message.request ?? {}) as Record<string, unknown>
    const reply = (error?: string) =>
      emit({
        type: 'control_response',
        response:
          error === undefined
            ? {
                subtype: 'success',
                request_id: message.request_id,
                response: {},
              }
            : { subtype: 'error', request_id: message.request_id, error },
      })
    log('control.ndjson', request)
    if (request.subtype === 'set_permission_mode') {
      const next = String(request.mode)
      if (next === 'auto' && process.env.FAKE_CLAUDE_NO_AUTO === '1')
        return reply('gate not enabled')
      if (next === 'bypassPermissions' && !dangerous)
        return reply('needs --allow-dangerously-skip-permissions')
      mode = next
      return reply()
    }
    if (request.subtype === 'interrupt') {
      if (hanging === 'deaf') return
      reply()
      if (hanging === 'hang') {
        hanging = undefined
        result('interrupted', true)
      }
    }
    return
  }
  const content = (message.message as { content: { text: string }[] }).content
  void onUser(content.map(block => block.text).join(''))
})
