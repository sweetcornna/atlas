// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `qm handoff attach` with the real qmcode terminal (P17.6 完成标准 4): the
 * two questions the probe left open (`handoff-probe-p17.md` 第 5 项) answered
 * on a local build of the fork, not on a stand-in.
 *
 * 1. The laptop's approval and sandbox settings differ from the node's: which
 *    ones do the turns typed in the attached terminal run with?
 * 2. "Enter has to be pressed twice": when, and why.
 *
 * ## Opt-in
 *
 * Runs only with `QIANMO_TEST_QMCODE_BIN=<a qmcode built from the fork>` on
 * macOS (both qmcode processes are fenced to loopback with `sandbox-exec`);
 * skipped everywhere else, CI included. Nothing is downloaded and nothing is
 * read from or written to the real home: every `HOME` and `QMCODE_HOME` is a
 * temporary directory.
 *
 * ## What is real
 *
 * `qmcode app-server` (the node) with capability-token auth, and the
 * `qmcode resume --remote …` terminal in a pseudo-terminal, started by the
 * real `qm handoff attach` from source through a wrapper on `PATH`. The model
 * is a loopback Responses double in this file (every request answered with a
 * short message and complete usage). The node bridge is played by an
 * `AppServerClient` that starts the thread with the bridge's settings —
 * `approvalPolicy: never`, `sandbox: workspace-write` — and runs one turn.
 * `ssh` is the stand-in of `support/attachShims.ts` (a real TCP forward); the
 * hub is a small HTTP stand-in for `POST /v0/handoff/<task>/attach`.
 *
 * ## What it found (2026-10-04, fork 0.158.0)
 *
 * - Settings: with the laptop's `config.toml` stricter (`on-request` /
 *   `read-only`) and with it looser (`never` / `danger-full-access`), every
 *   turn typed in the attached terminal ran with the node thread's `never` /
 *   `workspace-write` and the node's working directory (rollout
 *   `turn_context`). A remote resume sends neither
 *   (`thread_resume_params_from_config`), and the terminal then runs with
 *   what the resumed thread reports.
 * - Enter: text and Enter arriving in one write — how an automated driver and
 *   a terminal paste without bracketed-paste deliver them — are taken as a
 *   paste burst, and that Enter becomes part of the paste; the second Enter
 *   submits. Typed text, a pause before Enter, and a bracketed paste each
 *   submit on the first Enter. Nothing about attach or the remote mode: it is
 *   the composer's paste-burst detection.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Subprocess } from 'bun'
import { AppServerClient } from '@qianmo/handoff'
import {
  alive,
  readShimLog,
  writeAttachShims,
} from '../../src/cli/handlers/__tests__/support/attachShims.js'
import {
  cliPrefix,
  freePort,
  INHERITED_KEYS_TO_DROP,
} from './fixtures/handoff-processes.js'

const QMCODE_BIN = process.env.QIANMO_TEST_QMCODE_BIN ?? ''
const SANDBOX_EXEC = '/usr/bin/sandbox-exec'
const ENABLED =
  QMCODE_BIN !== '' &&
  process.platform === 'darwin' &&
  existsSync(QMCODE_BIN) &&
  existsSync(SANDBOX_EXEC)

const TASK = 'a1b2c3d4-attach'
const NODE = 'cloud-1'
const MODEL = 'gpt-6-luna'
const MODEL_KEY = `sk-test-canary-${randomBytes(8).toString('hex')}`
const CONSOLE_TOKEN = `qm-attach-qmcode-${randomBytes(8).toString('hex')}`
const APP_TOKEN = randomBytes(32).toString('hex')
const SUITE_TIMEOUT_MS = 240_000

/** Network out only to loopback, for both qmcode processes. */
const LOOPBACK_ONLY = `(version 1)
(allow default)
(deny network-outbound (remote ip "*:*"))
(allow network-outbound (remote ip "localhost:*"))
`

let root = ''
let nodeHome = ''
let nodeQm = ''
let work = ''
let profile = ''
let bin = ''
let baseUrl = ''
let consoleTokenFile = ''
let appPort = 0
let model: ReturnType<typeof Bun.serve> | undefined
let hub: ReturnType<typeof Bun.serve> | undefined
let appServer: Subprocess | undefined
let bridge: AppServerClient | undefined
let threadId = ''
const modelRequests: Record<string, unknown>[] = []

/** One `qm handoff attach` in its own pseudo-terminal and laptop home. */
interface Session {
  readonly proc: Subprocess
  readonly shimLog: string
  readonly laptopQm: string
  screen: string
}
const sessions: Session[] = []

function config(approval: string, sandbox: string): string {
  return `model_provider = "fake"
model = "${MODEL}"
approval_policy = "${approval}"
sandbox_mode = "${sandbox}"
check_for_update_on_startup = false
[analytics]
enabled = false
[features]
plugins = false
[model_providers.fake]
name = "fake"
base_url = "${baseUrl}"
env_key = "FAKE_MODEL_KEY"
wire_api = "responses"
`
}

/** A Responses stream: one short message, then `response.completed` with full usage. */
function answer(n: number): Response {
  const message = { type: 'message', id: `msg_${n}`, role: 'assistant' }
  const events = [
    {
      type: 'response.created',
      response: { id: `resp_${n}`, status: 'in_progress' },
    },
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: { ...message, content: [] },
    },
    {
      type: 'response.output_text.delta',
      output_index: 0,
      content_index: 0,
      delta: `ack ${n}`,
    },
    {
      type: 'response.output_item.done',
      output_index: 0,
      item: {
        ...message,
        status: 'completed',
        content: [{ type: 'output_text', text: `ack ${n}` }],
      },
    },
    {
      type: 'response.completed',
      response: {
        id: `resp_${n}`,
        status: 'completed',
        usage: {
          input_tokens: 10,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens: 2,
          output_tokens_details: { reasoning_tokens: 0 },
          total_tokens: 12,
        },
      },
    },
  ]
  return new Response(
    events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(''),
    { headers: { 'content-type': 'text/event-stream' } },
  )
}

function baseEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value
  }
  for (const key of INHERITED_KEYS_TO_DROP) delete env[key]
  delete env.QIANMO_TEST_QMCODE_BIN
  return env
}

/** CSI, OSC, charset and keypad sequences: what a terminal draws with. */
const ANSI =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: terminal escape sequences are what is being removed
  /\x1b\[[0-9;?<>=]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-Za-z]|\x1b[=>78]/g

/** ANSI out, so the screen can be searched as text. */
function plain(text: string): string {
  return text.replace(ANSI, '')
}

async function until(
  check: () => boolean,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) return false
    await Bun.sleep(100)
  }
  return true
}

async function mustUntil(
  session: Session,
  what: string,
  check: () => boolean,
  timeoutMs: number,
): Promise<void> {
  if (!(await until(check, timeoutMs))) {
    throw new Error(
      `timed out waiting for ${what}\n--- screen ---\n${plain(session.screen).slice(-3000)}`,
    )
  }
}

/** The node's rollout of the thread, as JSON lines. */
function nodeRollout(): Record<string, unknown>[] {
  const find = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
      entry.isDirectory()
        ? find(join(dir, entry.name))
        : entry.name.includes(threadId) && entry.name.endsWith('.jsonl')
          ? [join(dir, entry.name)]
          : [],
    )
  const [path] = find(join(nodeQm, 'sessions'))
  if (path === undefined) return []
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(line => line !== '')
    .map(line => JSON.parse(line) as Record<string, unknown>)
}

function payloadOf(line: Record<string, unknown>): Record<string, unknown> {
  return (line.payload ?? {}) as Record<string, unknown>
}

/**
 * The texts users sent into the node's thread, in order: `response_item`
 * user messages (this rollout keeps no `user_message` events), without the
 * `<environment_context>` the server adds.
 */
function userMessages(): string[] {
  return nodeRollout()
    .map(payloadOf)
    .filter(item => item.type === 'message' && item.role === 'user')
    .flatMap(item =>
      Array.isArray(item.content)
        ? item.content.map(part => String(part?.text ?? ''))
        : [],
    )
    .filter(text => !text.startsWith('<'))
}

function completedTurns(): number {
  return nodeRollout().filter(
    line =>
      line.type === 'event_msg' && payloadOf(line).type === 'task_complete',
  ).length
}

/** `[approval, sandbox type, cwd]` of every turn the node ran, in order. */
function turnSettings(): [unknown, unknown, string][] {
  return nodeRollout()
    .filter(line => line.type === 'turn_context')
    .map(payloadOf)
    .map(context => [
      context.approval_policy,
      (context.sandbox_policy as Record<string, unknown> | undefined)?.type,
      String(context.cwd),
    ])
}

function terminalOf(session: Session): NonNullable<Subprocess['terminal']> {
  const handle = session.proc.terminal
  if (handle === undefined) throw new Error('attach has no terminal')
  return handle
}

/**
 * `qm handoff attach <task>` in a pseudo-terminal, from a laptop whose
 * qmcode is configured with `approval` and `sandbox`; ready for input.
 */
async function startAttach(
  name: string,
  approval: string,
  sandbox: string,
): Promise<Session> {
  const laptopHome = join(root, `${name}-home`)
  const laptopQm = join(root, `${name}-qmcode-home`)
  mkdirSync(laptopHome, { recursive: true })
  mkdirSync(laptopQm, { recursive: true })
  writeFileSync(join(laptopQm, 'config.toml'), config(approval, sandbox))
  const shimLog = join(root, `${name}-shim.log`)
  const decoder = new TextDecoder()
  const session: Session = {
    shimLog,
    laptopQm,
    screen: '',
    proc: Bun.spawn(
      [
        process.execPath,
        ...cliPrefix(),
        'handoff',
        'attach',
        TASK,
        '--console',
        `http://127.0.0.1:${hub?.port}`,
        '--token-file',
        consoleTokenFile,
        '--app-server-port',
        String(appPort),
      ],
      {
        cwd: root,
        env: {
          ...baseEnv(),
          NODE_ENV: 'production',
          OCC_IDENTITY: 'qianmo',
          OCC_CONFIG_DIR: join(root, `${name}-config`),
          HOME: laptopHome,
          QMCODE_HOME: laptopQm,
          PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
          TERM: 'xterm-256color',
          LANG: 'en_US.UTF-8',
          FAKE_MODEL_KEY: MODEL_KEY,
          QIANMO_SHIM_LOG: shimLog,
          QIANMO_SHIM_NODE_HOME: nodeHome,
        },
        terminal: {
          cols: 160,
          rows: 48,
          data(_terminal, bytes) {
            session.screen += decoder.decode(bytes)
          },
        },
      },
    ),
  }
  sessions.push(session)
  await mustUntil(
    session,
    'the terminal to come up',
    () => /GPT-6-Luna/i.test(plain(session.screen)),
    60_000,
  )
  // Let the composer settle the way a person would before typing.
  await Bun.sleep(1_500)
  expect(plain(session.screen)).toContain(`接入  任务 ${TASK} · 节点 ${NODE}`)
  return session
}

/**
 * Send `text` the way `send` does; one more Enter if the first did not
 * submit. How many Enters it took, once the turn has completed on the node.
 */
async function submit(
  session: Session,
  text: string,
  send: (terminal: NonNullable<Subprocess['terminal']>) => Promise<void>,
): Promise<number> {
  const done = completedTurns()
  await send(terminalOf(session))
  let enters = 1
  const arrived = () => userMessages().some(m => m.includes(text))
  if (!(await until(arrived, 5_000))) {
    terminalOf(session).write('\r')
    enters = 2
    await mustUntil(session, `${text} after a second Enter`, arrived, 15_000)
  }
  await mustUntil(
    session,
    `${text}: the turn to complete`,
    () => completedTurns() > done,
    30_000,
  )
  return enters
}

async function typeSlowly(
  terminal: NonNullable<Subprocess['terminal']>,
  text: string,
): Promise<void> {
  for (const key of text) {
    terminal.write(key)
    await Bun.sleep(40)
  }
  await Bun.sleep(600)
  terminal.write('\r')
}

/**
 * Leave the way a person does: Ctrl-C on an idle composer (a second one if
 * the first only clears it). The terminal is in raw mode, so it reaches
 * qmcode as a key, not the tunnel as SIGINT. Checks attach closed the tunnel.
 */
async function leave(session: Session): Promise<void> {
  const tunnel = readShimLog(session.shimLog).find(
    e => e.tool === 'ssh' && e.event === 'start' && e.mode === 'tunnel',
  )
  expect(tunnel).toBeDefined()
  expect(alive(tunnel?.pid ?? 0)).toBe(true)
  terminalOf(session).write('\x03')
  if (!(await until(() => session.proc.exitCode !== null, 5_000))) {
    terminalOf(session).write('\x03')
  }
  const code = await Promise.race([
    session.proc.exited,
    Bun.sleep(20_000).then(() => 'timeout' as const),
  ])
  expect(code).toBe(0)
  await mustUntil(
    session,
    'attach to report the tunnel closed',
    () => plain(session.screen).includes('隧道已关'),
    5_000,
  )
  expect(alive(tunnel?.pid ?? 0)).toBe(false)
  expect(
    readShimLog(session.shimLog).find(
      e => e.pid === tunnel?.pid && e.event === 'stopped',
    )?.signal,
  ).toBe('SIGTERM')
}

beforeAll(async () => {
  if (!ENABLED) return
  root = mkdtempSync(join(tmpdir(), 'qianmo-attach-qmcode-'))
  nodeHome = join(root, 'node-home')
  nodeQm = join(root, 'node-qmcode-home')
  work = join(root, 'node', 'work', TASK)
  for (const dir of [nodeHome, nodeQm, work]) {
    mkdirSync(dir, { recursive: true })
  }
  profile = join(root, 'loopback-only.sb')
  writeFileSync(profile, LOOPBACK_ONLY)

  model = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      if (
        request.method !== 'POST' ||
        !new URL(request.url).pathname.endsWith('/responses')
      ) {
        return Response.json({ error: { message: 'no' } }, { status: 404 })
      }
      modelRequests.push((await request.json()) as Record<string, unknown>)
      return answer(modelRequests.length)
    },
  })
  baseUrl = `http://127.0.0.1:${model.port}/v1`
  // The node as the bridge configures it.
  writeFileSync(join(nodeQm, 'config.toml'), config('never', 'workspace-write'))

  // The token where handoff-node.sh keeps it; the app-server reads it there.
  const secrets = join(nodeHome, 'qianmo-beta', 'secrets')
  mkdirSync(secrets, { recursive: true })
  const tokenFile = join(secrets, 'handoff-app-server-token')
  writeFileSync(tokenFile, `${APP_TOKEN}\n`, { mode: 0o600 })

  appPort = await freePort()
  appServer = Bun.spawn(
    [
      SANDBOX_EXEC,
      '-f',
      profile,
      QMCODE_BIN,
      'app-server',
      '--listen',
      `ws://127.0.0.1:${appPort}`,
      '--ws-auth',
      'capability-token',
      '--ws-token-file',
      tokenFile,
    ],
    {
      cwd: nodeHome,
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        HOME: nodeHome,
        QMCODE_HOME: nodeQm,
        FAKE_MODEL_KEY: MODEL_KEY,
      },
      stdout: 'ignore',
      stderr: 'ignore',
    },
  )
  let ready = false
  for (let i = 0; i < 300 && !ready; i++) {
    try {
      ready = (await fetch(`http://127.0.0.1:${appPort}/readyz`)).status === 200
    } catch {
      await Bun.sleep(100)
    }
  }
  expect(ready).toBe(true)

  // The node bridge's part: the thread with its settings, and one turn.
  bridge = await AppServerClient.connect({
    url: `ws://127.0.0.1:${appPort}`,
    token: APP_TOKEN,
  })
  threadId = (
    await bridge.threadStart({
      cwd: work,
      approvalPolicy: 'never',
      sandbox: 'workspace-write',
    })
  ).id
  const first = await bridge.turnStart(
    threadId,
    'first turn from the node bridge',
  )
  await bridge.waitTurnCompleted(threadId, first, 60_000)

  // The hub: where the task runs, nothing more.
  hub = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      if (request.headers.get('authorization') !== `Bearer ${CONSOLE_TOKEN}`) {
        return Response.json({ error: { message: 'no' } }, { status: 401 })
      }
      if (new URL(request.url).pathname !== `/v0/handoff/${TASK}/attach`) {
        return Response.json({ error: { message: 'no' } }, { status: 404 })
      }
      return Response.json({
        attach: {
          taskId: TASK,
          state: 'running',
          node: NODE,
          threadId,
          project: 'atlas',
          tool: 'qmcode',
        },
      })
    },
  })
  consoleTokenFile = join(root, 'console.token')
  writeFileSync(consoleTokenFile, `${CONSOLE_TOKEN}\n`, { mode: 0o600 })

  // ssh: the stand-in; qmcode: the real one, fenced, through a wrapper.
  bin = join(root, 'laptop-bin')
  const shims = writeAttachShims(bin)
  writeFileSync(
    shims.qmcode,
    `#!/bin/sh\nexec '${SANDBOX_EXEC}' -f '${profile}' '${QMCODE_BIN}' "$@"\n`,
  )
  chmodSync(shims.qmcode, 0o755)
}, SUITE_TIMEOUT_MS)

afterAll(async () => {
  if (!ENABLED) return
  for (const session of sessions) {
    if (session.proc.exitCode === null) session.proc.kill('SIGKILL')
    for (const event of readShimLog(session.shimLog)) {
      if (event.event === 'start' && alive(event.pid)) {
        process.kill(event.pid, 'SIGKILL')
      }
    }
  }
  bridge?.close()
  appServer?.kill('SIGTERM')
  await appServer?.exited
  model?.stop(true)
  hub?.stop(true)
  if (root !== '') rmSync(root, { recursive: true, force: true })
})

describe.skipIf(!ENABLED)(
  'qm handoff attach with the real qmcode terminal (P17.6 完成标准 4)',
  () => {
    test(
      'laptop stricter than the node (on-request · read-only): the node’s settings hold · a one-write paste needs a second Enter, typed · paused · bracketed input does not · the tunnel closes on exit',
      async () => {
        const session = await startAttach('strict', 'on-request', 'read-only')
        const before = turnSettings().length

        // The token is in no process's argv while the terminal is up.
        const ps = Bun.spawnSync(['ps', '-axww', '-o', 'args='], {
          stdout: 'pipe',
        })
        expect(ps.exitCode).toBe(0)
        expect(ps.stdout.toString()).toContain(
          'resume --remote ws://127.0.0.1:',
        )
        expect(ps.stdout.toString()).not.toContain(APP_TOKEN)

        const enters = {
          'one write': await submit(session, 'pasted in one write', async t => {
            t.write('pasted in one write\r')
          }),
          typed: await submit(session, 'typed one key at a time', async t => {
            await typeSlowly(t, 'typed one key at a time')
          }),
          'pause before Enter': await submit(
            session,
            'written at once then a pause',
            async t => {
              t.write('written at once then a pause')
              await Bun.sleep(300)
              t.write('\r')
            },
          ),
          'bracketed paste': await submit(
            session,
            'a bracketed paste',
            async t => {
              t.write('\x1b[200~a bracketed paste\x1b[201~')
              await Bun.sleep(300)
              t.write('\r')
            },
          ),
        }
        process.stderr.write(`Enters needed: ${JSON.stringify(enters)}\n`)
        expect(enters).toEqual({
          'one write': 2,
          typed: 1,
          'pause before Enter': 1,
          'bracketed paste': 1,
        })

        // The four turns typed here ran as the node thread is set up.
        const typedHere = turnSettings().slice(before)
        process.stderr.write(
          `node turn_context (laptop on-request/read-only): ${JSON.stringify(typedHere.map(([a, s]) => [a, s]))}\n`,
        )
        expect(typedHere).toHaveLength(4)
        for (const [approval, sandbox, cwd] of typedHere) {
          expect(approval).toBe('never')
          expect(sandbox).toBe('workspace-write')
          expect(cwd).toEndWith(`/work/${TASK}`)
        }
        // The session stays on the node: nothing of it in the laptop's home.
        const local = join(session.laptopQm, 'sessions')
        expect(
          existsSync(local)
            ? readdirSync(local, { recursive: true }).filter(entry =>
                String(entry).includes(threadId),
              )
            : [],
        ).toEqual([])

        await leave(session)
      },
      SUITE_TIMEOUT_MS,
    )

    test(
      'laptop looser than the node (never · danger-full-access): the node’s settings still hold',
      async () => {
        const session = await startAttach(
          'loose',
          'never',
          'danger-full-access',
        )
        const before = turnSettings().length
        expect(
          await submit(session, 'typed from a looser laptop', async t => {
            await typeSlowly(t, 'typed from a looser laptop')
          }),
        ).toBe(1)
        const typedHere = turnSettings().slice(before)
        process.stderr.write(
          `node turn_context (laptop never/danger-full-access): ${JSON.stringify(typedHere.map(([a, s]) => [a, s]))}\n`,
        )
        expect(typedHere).toHaveLength(1)
        expect(typedHere[0]?.[0]).toBe('never')
        expect(typedHere[0]?.[1]).toBe('workspace-write')
        await leave(session)
        // Every turn of the thread, the bridge's first included.
        expect(turnSettings().map(([a, s]) => [a, s])).toEqual(
          Array.from({ length: 6 }, () => ['never', 'workspace-write']),
        )
        expect(modelRequests.length).toBeGreaterThanOrEqual(6)
      },
      SUITE_TIMEOUT_MS,
    )
  },
)
