// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * P17.6 end to end: from the laptop, `qm handoff attach` joins a task running
 * on a node and `qm handoff pull` brings finished ones home.
 *
 * ## What is real
 *
 * The same three kinds of `qm` process as `qianmo-handoff-node.test.ts`, from
 * source with the shipped defines and feature list: the laptop
 * (`handoff init`, `now`, `attach`, `pull`), the hub (`qm console
 * --handoff-root … --handoff-node …`) and the node bridge (`qm handoff
 * node`). The tunnel `attach` opens is a real TCP forward, the WebSocket and
 * its token check are real, git is real git, and the pulls fetch from the
 * hub's bare repository.
 *
 * ## What is made up
 *
 * - The app-server: `support/fakeAppServer.ts`, in this process; each turn
 *   writes `cloud-<task>.txt` in the node's work tree and is held open until
 *   the test releases it. No model is called.
 * - `ssh` and `qmcode`: the stand-ins of `support/attachShims.ts`, first on
 *   the laptop's `PATH`. "The node" `ssh` runs commands in is a directory
 *   holding the app-server token where `demo/env/beta/handoff-node.sh` puts
 *   it, so `attach` runs on its defaults (token path, the node's name as the
 *   ssh target); only the app-server port is the fake's.
 * - `bwrap` on the bridge's `PATH`, and the laptop's qmcode rollouts.
 *
 * ## The completion criteria here
 *
 * - AC-H4: `attach` without a task id finds the project's running task, the
 *   tunnel stand-in carries `qmcode`'s connection, `thread/resume` keeps the
 *   node's working directory and the typed input reaches the node's running
 *   turn. The app-server token is in no argv, nothing of the hub's (ledger,
 *   audit, output, answers), nothing of the laptop's and no output; the
 *   tunnel is gone after a normal exit, after SIGTERM and after attach itself
 *   is SIGKILLed; the hub's audit says `handoff.attach-requested`.
 * - AC-H5: untouched → the branch fast-forwards; changed → the result is on
 *   `qianmo/<task>-return` and every work-tree file (`shasum`), the index
 *   file and every other ref are as before; the boundary — HEAD moved by a
 *   commit of exactly the handed-over work tree — takes the branch way too.
 * - The cloud session is in `$QMCODE_HOME/sessions/` with the hub's bytes,
 *   the laptop's own rollout kept beside it; the ledger says `returned` and
 *   the audit `handoff.returned`.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { type ChildProcess, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { readTrail } from '@qianmo/audit'
import { sessionRef, taskBranch } from '@qianmo/handoff'
import { transportPskEnvVarForNode } from '../../src/cli/handlers/consoleArgs.js'
import { ATTACH_TOKEN_ENV } from '../../src/cli/handlers/handoffAttach.js'
import {
  type AttachShims,
  alive,
  readShimLog,
  type ShimEvent,
  writeAttachShims,
} from '../../src/cli/handlers/__tests__/support/attachShims.js'
import {
  type FakeAppServer,
  startFakeAppServer,
} from '../../src/cli/handlers/__tests__/support/fakeAppServer.js'
import {
  qmcodeRollout,
  qmcodeRolloutPath,
} from '../../src/cli/handlers/__tests__/support/handoffSamples.js'
import { bwrapStub } from '../../src/cli/handlers/__tests__/support/handoffNodeFixtures.js'
import {
  cliPrefix,
  freePort,
  INHERITED_KEYS_TO_DROP,
  type RunningConsole,
  startHandoffConsole,
  stopConsole,
  waitForConsole,
} from './fixtures/handoff-processes.js'

const SAFE = '已落地，可以关机'
const COPY_RULE = /[。，、！!]|\p{Extended_Pictographic}/u
const DEVICE = 'laptop'
const NODE = 'cloud-1'
/** One laptop thread per task, so each node turn is its own. */
const THREADS = {
  attach: '0199a4c2-7c1e-7d32-9a5e-3b1f2c4d6e01',
  changed: '0199a4c2-7c1e-7d32-9a5e-3b1f2c4d6e02',
  boundary: '0199a4c2-7c1e-7d32-9a5e-3b1f2c4d6e03',
} as const
const TURN_1 = '0199a4c2-8000-7000-8000-000000000601'
const TYPED = '在接入的终端里补一句：README 也顺手改'
const PSK = randomBytes(32).toString('hex')
/** The node's app-server token: read over ssh by attach, never anywhere else. */
const APP_TOKEN = `app-${randomBytes(32).toString('hex')}`

const BOOT_TIMEOUT_MS = 120_000
const STEP_TIMEOUT_MS = 120_000

let root = ''
let repo = ''
let hubRoot = ''
let hubBare = ''
let hubConfig = ''
let laptopConfig = ''
let laptopQm = ''
let nodeRoot = ''
let nodeConfig = ''
let nodeQm = ''
let nodeHome = ''
let gitConfig = ''
let adminTokenFile = ''
let viewTokenFile = ''
let adminToken = ''
let trust = ''
let port = 0
let nodePort = 0
let appPort = 0
let shims: AttachShims
/** The stand-ins' log for the current test; every one is kept for the scan. */
let shimLog = ''
const shimLogs: string[] = []
let fake: FakeAppServer | undefined
let hub: RunningConsole | undefined
let bridge: RunningConsole | undefined
/** Everything attach printed, for the token scan. */
const attachOutput: string[] = []

function baseEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value
  }
  for (const key of INHERITED_KEYS_TO_DROP) delete env[key]
  return {
    ...env,
    NODE_ENV: 'production',
    OCC_IDENTITY: 'qianmo',
    NO_COLOR: '1',
    GIT_CONFIG_GLOBAL: gitConfig,
    GIT_CONFIG_NOSYSTEM: '1',
  }
}

/** The laptop, inside a qmcode thread (`/handoff`, `/pull` set this). */
function laptopEnv(thread: string): Record<string, string> {
  return {
    ...baseEnv(),
    OCC_CONFIG_DIR: laptopConfig,
    QMCODE_HOME: laptopQm,
    CODEX_THREAD_ID: thread,
  }
}

/** The laptop with the `ssh` and `qmcode` stand-ins first on `PATH`. */
function attachEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    ...laptopEnv(THREADS.attach),
    PATH: `${shims.dir}:${process.env.PATH ?? '/usr/bin:/bin'}`,
    QIANMO_SHIM_LOG: shimLog,
    QIANMO_SHIM_NODE_HOME: nodeHome,
    QIANMO_SHIM_INPUT: TYPED,
    ...extra,
  }
}

function hubEnv(): Record<string, string> {
  return {
    ...baseEnv(),
    OCC_CONFIG_DIR: hubConfig,
    [transportPskEnvVarForNode(NODE, 'test')]: PSK,
  }
}

function nodeEnv(path: string): Record<string, string> {
  return {
    ...baseEnv(),
    OCC_CONFIG_DIR: nodeConfig,
    QIANMO_TRANSPORT_PSK: PSK,
    PATH: path,
  }
}

interface Ran {
  readonly code: number | null
  readonly stdout: string
  readonly stderr: string
}

async function qm(
  args: readonly string[],
  env: Record<string, string>,
  cwd = repo,
): Promise<Ran> {
  const proc = Bun.spawn([process.execPath, ...cliPrefix(), ...args], {
    cwd,
    env,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { code, stdout, stderr }
}

function git(cwd: string, ...args: string[]): string {
  const proc = Bun.spawnSync(
    [
      'git',
      '-c',
      'user.name=Handoff E2E',
      '-c',
      'user.email=handoff-e2e@qianmo.invalid',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    { cwd, env: baseEnv(), stdout: 'pipe', stderr: 'pipe' },
  )
  if (proc.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')}: ${proc.stderr.toString()}`)
  }
  return proc.stdout.toString().trim()
}

async function until(
  what: string,
  check: () => boolean | Promise<boolean>,
  timeoutMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await check())) {
    if (Date.now() > deadline) {
      throw new Error(
        `timed out waiting for ${what}\n--- hub stderr ---\n${hub?.stderr() ?? ''}\n--- node stdout ---\n${bridge?.stdout() ?? ''}\n--- node stderr ---\n${bridge?.stderr() ?? ''}`,
      )
    }
    await Bun.sleep(100)
  }
}

async function hubApi(
  method: 'GET' | 'POST',
  path: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${adminToken}`,
      accept: 'application/json',
    },
  })
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  }
}

async function taskView(taskId: string): Promise<Record<string, unknown>> {
  const { status, body } = await hubApi('GET', `/v0/handoff/${taskId}`)
  expect(status).toBe(200)
  return body.task as Record<string, unknown>
}

function auditKinds(taskId: string): string[] {
  return readTrail(join(hubConfig, 'qianmo', 'handoff', 'audit.ndjson'))
    .records.filter(record => record.taskId === taskId)
    .map(record => record.kind)
}

/** A finished turn of `thread` in the laptop's qmcode home. */
function laptopRollout(thread: string): string {
  const path = qmcodeRolloutPath(laptopQm, thread)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(
    path,
    qmcodeRollout(thread, repo, [
      { turnId: TURN_1, user: '把 a.txt 改完', assistant: '改了一半' },
    ]),
  )
  return path
}

/** `qm handoff now` from `thread`; the new task's id. */
async function handOver(thread: string, goal: string): Promise<string> {
  const ran = await qm(['handoff', 'now', '--goal', goal], laptopEnv(thread))
  expect(ran.stderr).toBe('')
  expect(ran.code).toBe(0)
  expect(ran.stdout.split('\n')[0]).toBe(SAFE)
  const taskId = /任务\s+(\S+)/.exec(ran.stdout)?.[1] ?? ''
  expect(taskId).not.toBe('')
  return taskId
}

/** `qm handoff now` from `thread`, and the node's turn for it once open. */
async function handOverAndRun(
  thread: string,
  goal: string,
): Promise<{ taskId: string; turnId: string }> {
  const turnsBefore = fake?.turns.length ?? 0
  const taskId = await handOver(thread, goal)
  await until(
    `the node to open a turn for ${taskId}`,
    async () =>
      (fake?.turns.length ?? 0) > turnsBefore &&
      (await taskView(taskId)).state === 'running',
  )
  expect(
    (fake?.calls('thread/resume') ?? []).some(
      call =>
        call.threadId === thread &&
        String(call.cwd ?? '').endsWith(`/work/${taskId}`),
    ),
  ).toBe(true)
  const turnId = fake?.turns[turnsBefore] ?? ''
  expect(turnId).not.toBe('')
  return { taskId, turnId }
}

async function finish(taskId: string, turnId: string): Promise<void> {
  fake?.release(turnId)
  await until(
    `${taskId} done`,
    async () => (await taskView(taskId)).state === 'done',
  )
}

/** `shasum -a 256` of every file in the work tree (`.git` aside), sorted. */
function workTreeSums(): string {
  const files: string[] = []
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (dir === repo && name === '.git') continue
      const path = join(dir, name)
      const stat = statSync(path)
      if (stat.isDirectory()) walk(path)
      else files.push(path.slice(repo.length + 1))
    }
  }
  walk(repo)
  files.sort()
  const ran = Bun.spawnSync(['shasum', '-a', '256', ...files], {
    cwd: repo,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  expect(ran.exitCode).toBe(0)
  return ran.stdout.toString()
}

/** Everything that must not move on the branch way: files, index, refs. */
function snapshot(): { sums: string; index: string; refs: string } {
  return {
    sums: workTreeSums(),
    index: Bun.hash(readFileSync(join(repo, '.git', 'index'))).toString(),
    refs: git(repo, 'for-each-ref', '--format=%(refname) %(objectname)'),
  }
}

function refsWithout(refs: string, ref: string): string {
  return refs
    .split('\n')
    .filter(line => !line.startsWith(`${ref} `))
    .join('\n')
}

/** A fresh stand-in log for the next attach. */
function newShimLog(): void {
  shimLog = join(root, `shim-${shimLogs.length + 1}.log`)
  shimLogs.push(shimLog)
}

function shimEvents(path = shimLog): ShimEvent[] {
  return readShimLog(path)
}

function pidsOf(
  events: readonly ShimEvent[],
  tool: 'ssh' | 'qmcode',
  mode?: string,
): number[] {
  return events
    .filter(
      e =>
        e.tool === tool &&
        e.event === 'start' &&
        (mode === undefined || e.mode === mode),
    )
    .map(e => e.pid)
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'qianmo-handoff-return-e2e-'))
  gitConfig = join(root, 'gitconfig')
  writeFileSync(gitConfig, '')
  laptopConfig = join(root, 'laptop-config')
  laptopQm = join(root, 'laptop-qmcode-home')
  hubConfig = join(root, 'hub-config')
  hubRoot = join(root, 'hub', 'repos')
  hubBare = join(hubRoot, 'atlas.git')
  nodeRoot = join(root, 'node')
  nodeConfig = join(root, 'node-config')
  nodeQm = join(root, 'node-qmcode-home')
  nodeHome = join(root, 'node-home')
  for (const dir of [laptopConfig, laptopQm, hubConfig, nodeConfig, nodeQm]) {
    mkdirSync(dir, { recursive: true })
  }
  shims = writeAttachShims(join(root, 'laptop-bin'))

  // The laptop: one commit and an edit on top.
  repo = join(root, 'work', 'atlas')
  mkdirSync(repo, { recursive: true })
  git(repo, 'init', '-q', '-b', 'main')
  writeFileSync(join(repo, 'a.txt'), 'one\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'one')
  writeFileSync(join(repo, 'a.txt'), 'half done\n')
  repo = git(repo, 'rev-parse', '--show-toplevel')

  adminToken = `qm-e2e-admin-${randomBytes(16).toString('hex')}`
  adminTokenFile = join(root, 'admin.token')
  viewTokenFile = join(root, 'view.token')
  writeFileSync(adminTokenFile, `${adminToken}\n`, { mode: 0o600 })
  writeFileSync(
    viewTokenFile,
    `qm-e2e-view-${randomBytes(16).toString('hex')}\n`,
    { mode: 0o600 },
  )
  chmodSync(adminTokenFile, 0o600)
  chmodSync(viewTokenFile, 0o600)

  const identity = await qm(
    ['console', '--print-wake-identity'],
    hubEnv(),
    root,
  )
  expect(identity.code).toBe(0)
  trust = identity.stdout.trim()

  // The node's app-server token, where handoff-node.sh keeps it; the bridge
  // reads the same file.
  const tokenDir = join(nodeHome, 'qianmo-beta', 'secrets')
  mkdirSync(tokenDir, { recursive: true })
  const nodeTokenFile = join(tokenDir, 'handoff-app-server-token')
  writeFileSync(nodeTokenFile, `${APP_TOKEN}\n`, { mode: 0o600 })
  fake = startFakeAppServer({
    token: APP_TOKEN,
    qmcodeHome: nodeQm,
    hold: true,
    work: turn =>
      writeFileSync(
        join(turn.cwd, `cloud-${basename(turn.cwd)}.txt`),
        'from the cloud\n',
      ),
    reply: () => '收尾了',
  })
  appPort = Number(new URL(fake.url).port)

  const goodBwrap = bwrapStub(join(root, 'bwrap-ok'))
  nodePort = await freePort()
  const child: ChildProcess = spawn(
    process.execPath,
    [
      ...cliPrefix(),
      'handoff',
      'node',
      '--node',
      NODE,
      '--root',
      nodeRoot,
      '--trust',
      trust,
      '--app-server',
      fake.url,
      '--app-server-token-file',
      nodeTokenFile,
      '--app-server-home',
      nodeHome,
      '--qmcode-home',
      nodeQm,
      '--project',
      'atlas',
      '--port',
      String(nodePort),
      '--bind',
      '127.0.0.1',
    ],
    {
      cwd: root,
      env: nodeEnv(`${goodBwrap}:${process.env.PATH ?? '/usr/bin:/bin'}`),
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  let stdout = ''
  let stderr = ''
  child.stdout?.on('data', chunk => {
    stdout += String(chunk)
  })
  child.stderr?.on('data', chunk => {
    stderr += String(chunk)
  })
  bridge = {
    child,
    exited: new Promise<void>(done => child.once('exit', () => done())),
    stdout: () => stdout,
    stderr: () => stderr,
  }
  await waitForConsole(bridge, nodePort, BOOT_TIMEOUT_MS)

  port = await freePort()
  hub = startHandoffConsole({
    port,
    handoffRoot: hubRoot,
    adminTokenFile,
    viewTokenFile,
    cwd: root,
    env: hubEnv(),
    extraArgs: [
      '--handoff-node',
      `${NODE}=ws://127.0.0.1:${nodePort}`,
      '--handoff-node-git',
      `${NODE}=${join(nodeRoot, 'repos')}`,
    ],
  })
  await waitForConsole(hub, port, BOOT_TIMEOUT_MS)

  const init = await qm(
    [
      'handoff',
      'init',
      '--hub',
      hubRoot,
      '--console',
      `http://127.0.0.1:${port}`,
      '--device',
      DEVICE,
      '--token-file',
      adminTokenFile,
    ],
    laptopEnv(THREADS.attach),
  )
  expect(init.stderr).toBe('')
  expect(init.code).toBe(0)
}, BOOT_TIMEOUT_MS)

afterAll(async () => {
  for (const path of shimLogs) {
    const events = shimEvents(path)
    for (const pid of [...pidsOf(events, 'ssh'), ...pidsOf(events, 'qmcode')]) {
      if (alive(pid)) process.kill(pid, 'SIGKILL')
    }
  }
  fake?.release()
  if (hub !== undefined) await stopConsole(hub)
  if (bridge !== undefined) await stopConsole(bridge)
  fake?.stop()
  // The held turns end on stop and write their last lines; let them.
  await Bun.sleep(100)
  if (root !== '') rmSync(root, { recursive: true, force: true })
})

describe('qm handoff attach and pull end to end (P17.6)', () => {
  let attachTask = ''
  let attachTurn = ''

  test(
    'AC-H4 · attach: through the tunnel into the running node turn · the token only in qmcode’s environment · the tunnel gone after',
    async () => {
      const original = laptopRollout(THREADS.attach)
      expect(existsSync(original)).toBe(true)
      const running = await handOverAndRun(THREADS.attach, '把 a.txt 收尾')
      attachTask = running.taskId
      attachTurn = running.turnId
      const inputsBefore = fake?.inputs(attachTurn).length ?? 0

      newShimLog()
      // No task id: this project's one running task.
      const ran = await qm(
        ['handoff', 'attach', '--app-server-port', String(appPort)],
        attachEnv(),
      )
      attachOutput.push(ran.stdout, ran.stderr)
      expect(ran.stderr).toBe('')
      expect(ran.code).toBe(0)
      expect(ran.stdout).toContain(
        `接入  任务 ${attachTask} · 节点 ${NODE} · 线程 ${THREADS.attach}`,
      )
      expect(ran.stdout.trimEnd().split('\n').at(-1)).toBe('  隧道已关')
      for (const line of ran.stdout.split('\n')) {
        expect(line).not.toMatch(COPY_RULE)
      }

      const events = shimEvents()
      // The token was read over the user's ssh, from handoff-node.sh's path,
      // with the node's name as the target.
      expect(
        events.find(e => e.tool === 'ssh' && e.mode === 'command')?.argv,
      ).toEqual([
        '-T',
        '-o',
        'ClearAllForwardings=yes',
        '--',
        NODE,
        `cat -- "$HOME"/'qianmo-beta/secrets/handoff-app-server-token'`,
      ])
      const tunnelArgv = events.find(
        e => e.tool === 'ssh' && e.mode === 'tunnel',
      )?.argv as string[]
      const localPort = Number(
        /^127\.0\.0\.1:(\d+):127\.0\.0\.1:\d+$/.exec(tunnelArgv[2] ?? '')?.[1],
      )
      expect(tunnelArgv.slice(0, 3)).toEqual([
        '-N',
        '-L',
        `127.0.0.1:${localPort}:127.0.0.1:${appPort}`,
      ])
      const started = events.find(
        e => e.tool === 'qmcode' && e.event === 'start',
      )
      expect(started?.argv).toEqual([
        'resume',
        '--remote',
        `ws://127.0.0.1:${localPort}`,
        '--remote-auth-token-env',
        ATTACH_TOKEN_ENV,
        THREADS.attach,
      ])
      expect(started?.cd).toBe(false)
      expect(started?.tokenLength).toBe(APP_TOKEN.length)

      // The node: a resume without cwd kept the task's work tree, and the
      // typed line went into the turn that is running there.
      const resumes = fake?.calls('thread/resume') ?? []
      expect(resumes.at(-1)).toEqual({ threadId: THREADS.attach })
      expect(
        events.find(e => e.tool === 'qmcode' && e.event === 'resumed'),
      ).toMatchObject({ ok: true })
      expect(
        String(
          events.find(e => e.tool === 'qmcode' && e.event === 'resumed')?.cwd,
        ),
      ).toEndWith(`/work/${attachTask}`)
      const inputs = fake?.inputs(attachTurn) ?? []
      expect(inputs.length).toBe(inputsBefore + 1)
      expect(inputs.at(-1)).toBe(TYPED)

      // The tunnel is gone.
      const tunnels = pidsOf(events, 'ssh', 'tunnel')
      expect(tunnels).toHaveLength(1)
      for (const pid of tunnels) expect(alive(pid)).toBe(false)
      expect(events.some(e => e.tool === 'ssh' && e.event === 'stopped')).toBe(
        true,
      )

      // The hub gave the place, not the key, and wrote it down.
      expect(auditKinds(attachTask)).toEqual([
        'handoff.accepted',
        'handoff.dispatched',
        'handoff.attach-requested',
      ])
      const requested = readTrail(
        join(hubConfig, 'qianmo', 'handoff', 'audit.ndjson'),
      ).records.find(
        r => r.taskId === attachTask && r.kind === 'handoff.attach-requested',
      )
      expect(requested?.detail).toMatchObject({
        node: NODE,
        threadId: THREADS.attach,
        device: DEVICE,
      })
    },
    STEP_TIMEOUT_MS,
  )

  test(
    'attach ended by SIGTERM: qmcode gets the signal, the tunnel is closed, exit 143',
    async () => {
      expect(attachTask).not.toBe('')
      newShimLog()
      const proc = Bun.spawn(
        [
          process.execPath,
          ...cliPrefix(),
          'handoff',
          'attach',
          attachTask,
          '--app-server-port',
          String(appPort),
        ],
        {
          cwd: repo,
          env: attachEnv({ QIANMO_SHIM_QMCODE_HOLD: '1' }),
          stdin: 'ignore',
          stdout: 'pipe',
          stderr: 'pipe',
        },
      )
      const output = Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ])
      await until('qmcode to hold the session', () =>
        shimEvents().some(e => e.tool === 'qmcode' && e.event === 'holding'),
      )
      const tunnel = pidsOf(shimEvents(), 'ssh', 'tunnel')[0] ?? 0
      expect(alive(tunnel)).toBe(true)
      proc.kill('SIGTERM')
      expect(await proc.exited).toBe(143)
      const [stdout, stderr] = await output
      attachOutput.push(stdout, stderr)
      expect(stdout.trimEnd().split('\n').at(-1)).toBe('  隧道已关')
      expect(alive(tunnel)).toBe(false)
      expect(
        shimEvents().find(e => e.tool === 'qmcode' && e.event === 'signalled')
          ?.signal,
      ).toBe('SIGTERM')
    },
    STEP_TIMEOUT_MS,
  )

  test(
    'attach itself SIGKILLed: its watchdog still takes the tunnel down',
    async () => {
      expect(attachTask).not.toBe('')
      newShimLog()
      const proc = Bun.spawn(
        [
          process.execPath,
          ...cliPrefix(),
          'handoff',
          'attach',
          attachTask,
          '--app-server-port',
          String(appPort),
        ],
        {
          cwd: repo,
          env: attachEnv({ QIANMO_SHIM_QMCODE_HOLD: '1' }),
          stdin: 'ignore',
          stdout: 'pipe',
          stderr: 'pipe',
        },
      )
      await until('qmcode to hold the session', () =>
        shimEvents().some(e => e.tool === 'qmcode' && e.event === 'holding'),
      )
      const events = shimEvents()
      const tunnel = pidsOf(events, 'ssh', 'tunnel')[0] ?? 0
      expect(alive(tunnel)).toBe(true)
      proc.kill('SIGKILL')
      await proc.exited
      await until('the tunnel to go', () => !alive(tunnel), 10_000)
      expect(
        shimEvents().find(
          e => e.tool === 'ssh' && e.pid === tunnel && e.event === 'stopped',
        )?.signal,
      ).toBe('SIGTERM')
      // qmcode outlives a SIGKILLed attach (it has the terminal); with the
      // tunnel gone it has nothing to talk to. Stop the stand-in here.
      for (const pid of pidsOf(events, 'qmcode')) {
        if (alive(pid)) process.kill(pid, 'SIGKILL')
      }
    },
    STEP_TIMEOUT_MS,
  )

  test(
    'AC-H5 · untouched since the handoff: the branch fast-forwards · the cloud session is placed · returned',
    async () => {
      expect(attachTask).not.toBe('')
      await finish(attachTask, attachTurn)
      const task = await taskView(attachTask)
      const manifest = task.manifest as Record<string, unknown>
      const result = task.result as Record<string, unknown>
      const head = String(result.head)
      const original = qmcodeRolloutPath(laptopQm, THREADS.attach)
      const laptopBytes = readFileSync(original, 'utf8')
      expect(git(repo, 'rev-parse', 'HEAD')).toBe(
        git(repo, 'rev-parse', `${String(manifest.wip)}^`),
      )

      // No task id: the latest finished one of this project.
      const ran = await qm(['handoff', 'pull'], laptopEnv(THREADS.attach))
      expect(ran.stderr).toBe('')
      expect(ran.code).toBe(0)
      expect(ran.stdout).toContain(`接回  任务 ${attachTask}`)
      expect(ran.stdout).toContain('  代码  本地没动过：快进 main')
      expect(ran.stdout).toContain(`cloud-${attachTask}.txt`)
      expect(ran.stdout).toContain(
        `这个线程正开着 · 退出 qmcode 后运行 qmcode resume ${THREADS.attach} 才看得到云端的回合`,
      )
      expect(ran.stdout.trimEnd().split('\n').at(-1)).toBe('  台账  returned')
      for (const line of ran.stdout.split('\n')) {
        expect(line).not.toMatch(COPY_RULE)
      }

      expect(git(repo, 'symbolic-ref', '--short', 'HEAD')).toBe('main')
      expect(git(repo, 'rev-parse', 'HEAD')).toBe(head)
      expect(git(repo, 'status', '--porcelain')).toBe('')
      expect(readFileSync(join(repo, `cloud-${attachTask}.txt`), 'utf8')).toBe(
        'from the cloud\n',
      )
      expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('half done\n')
      // No temporary refs left behind.
      expect(
        git(repo, 'for-each-ref', '--format=%(refname)', 'refs/qianmo/pull'),
      ).toBe('')

      // The session: the hub's bytes under $QMCODE_HOME/sessions, the
      // laptop's own one kept beside it.
      const cloudRef = sessionRef('cloud', THREADS.attach)
      const [entry] = git(hubBare, 'ls-tree', cloudRef).split('\n')
      const [, , type, blob, name] =
        /^(\d+) (\w+) (\w+)\t(.+)$/.exec(entry ?? '') ?? []
      expect(type).toBe('blob')
      expect(name).toBe(basename(original))
      expect(original.startsWith(join(laptopQm, 'sessions'))).toBe(true)
      const hubBytes = Bun.spawnSync(['git', 'cat-file', 'blob', blob ?? ''], {
        cwd: hubBare,
        env: baseEnv(),
        stdout: 'pipe',
      }).stdout
      expect(hubBytes.length).toBeGreaterThan(0)
      expect(readFileSync(original).equals(hubBytes)).toBe(true)
      expect(readFileSync(original, 'utf8')).toContain(TYPED)
      const backup = `${original}.before-pull-${attachTask}`
      expect(readFileSync(backup, 'utf8')).toBe(laptopBytes)
      expect(ran.stdout).toContain(`  会话  ${original}`)
      expect(statSync(original).mode & 0o777).toBe(0o600)

      expect((await taskView(attachTask)).state).toBe('returned')
      const kinds = auditKinds(attachTask)
      expect(kinds.at(-2)).toBe('handoff.completed')
      expect(kinds.at(-1)).toBe('handoff.returned')
      expect(
        readTrail(
          join(hubConfig, 'qianmo', 'handoff', 'audit.ndjson'),
        ).records.find(
          r => r.taskId === attachTask && r.kind === 'handoff.returned',
        )?.detail,
      ).toMatchObject({ from: 'done', mode: 'fast-forward', device: DEVICE })

      // A second pull changes nothing and says so.
      const again = await qm(
        ['handoff', 'pull', attachTask],
        laptopEnv(THREADS.attach),
      )
      expect(again.code).toBe(0)
      expect(again.stdout).toContain('本机已在云端结果上')
      expect(again.stdout).toContain('（已是云端那份）')
      expect(again.stdout).toContain('  台账  已是 returned')
      expect(git(repo, 'rev-parse', 'HEAD')).toBe(head)
    },
    STEP_TIMEOUT_MS,
  )

  test(
    'AC-H5 · changed after the handoff: qianmo/<task>-return, every work-tree file, the index and the other refs byte for byte as before',
    async () => {
      laptopRollout(THREADS.changed)
      writeFileSync(join(repo, 'a.txt'), 'second round\n')
      const { taskId, turnId } = await handOverAndRun(THREADS.changed, '第二轮')
      await finish(taskId, turnId)
      const head = String(
        ((await taskView(taskId)).result as Record<string, unknown>).head,
      )

      // Meanwhile here: an edit, a new file, and something staged.
      writeFileSync(join(repo, 'a.txt'), 'changed here meanwhile\n')
      writeFileSync(join(repo, 'local-only.txt'), 'mine\n')
      mkdirSync(join(repo, 'notes'), { recursive: true })
      writeFileSync(join(repo, 'notes', 'n.md'), 'staged\n')
      git(repo, 'add', 'notes/n.md')
      const before = snapshot()

      const ran = await qm(
        ['handoff', 'pull', taskId],
        laptopEnv(THREADS.changed),
      )
      expect(ran.stderr).toBe('')
      expect(ran.code).toBe(0)
      const returnBranch = `${taskBranch(taskId)}-return`
      expect(ran.stdout).toContain('工作区与转交时不同')
      expect(ran.stdout).toContain('工作区一个文件没动')
      expect(ran.stdout).toContain(
        `云端结果在新分支 ${returnBranch}（${head}）`,
      )
      expect(ran.stdout).toContain('  云端改动（相对转交时的工作区）')
      expect(ran.stdout).toContain(`cloud-${taskId}.txt`)
      expect(ran.stdout).toContain('  本机改动（转交之后）')
      expect(ran.stdout).toContain('local-only.txt')
      expect(ran.stdout).toContain(`git merge ${returnBranch}`)
      for (const line of ran.stdout.split('\n')) {
        expect(line).not.toMatch(COPY_RULE)
      }

      const after = snapshot()
      expect(after.sums).toBe(before.sums)
      expect(after.index).toBe(before.index)
      expect(refsWithout(after.refs, `refs/heads/${returnBranch}`)).toBe(
        before.refs,
      )
      expect(git(repo, 'rev-parse', `refs/heads/${returnBranch}`)).toBe(head)
      expect(existsSync(join(repo, `cloud-${taskId}.txt`))).toBe(false)
      expect((await taskView(taskId)).state).toBe('returned')
      expect(
        readTrail(
          join(hubConfig, 'qianmo', 'handoff', 'audit.ndjson'),
        ).records.find(
          r => r.taskId === taskId && r.kind === 'handoff.returned',
        )?.detail,
      ).toMatchObject({ from: 'done', mode: 'branch' })

      // Put the laptop back to a clean main for the next case.
      git(repo, 'reset', '-q', 'HEAD', '--', 'notes/n.md')
      rmSync(join(repo, 'notes'), { recursive: true, force: true })
      rmSync(join(repo, 'local-only.txt'))
      git(repo, 'checkout', '-q', '--', 'a.txt')
    },
    STEP_TIMEOUT_MS,
  )

  test(
    'AC-H5 boundary · HEAD moved by a commit of exactly the handed-over work tree: still the branch way, nothing here moves',
    async () => {
      laptopRollout(THREADS.boundary)
      writeFileSync(join(repo, 'a.txt'), 'third round\n')
      writeFileSync(join(repo, 'b.txt'), 'new and untracked\n')
      const { taskId, turnId } = await handOverAndRun(
        THREADS.boundary,
        '第三轮',
      )
      const manifest = (await taskView(taskId)).manifest as Record<
        string,
        unknown
      >
      await finish(taskId, turnId)
      const head = String(
        ((await taskView(taskId)).result as Record<string, unknown>).head,
      )

      // Commit exactly what was handed over: the tree is the shadow tree,
      // HEAD is not its parent any more.
      git(repo, 'add', '-A')
      git(repo, 'commit', '-q', '-m', 'committed what was handed over')
      expect(git(repo, 'rev-parse', 'HEAD^{tree}')).toBe(String(manifest.tree))
      expect(git(repo, 'rev-parse', 'HEAD^')).toBe(
        git(repo, 'rev-parse', `${String(manifest.wip)}^`),
      )
      const before = snapshot()

      const ran = await qm(
        ['handoff', 'pull', taskId],
        laptopEnv(THREADS.boundary),
      )
      expect(ran.stderr).toBe('')
      expect(ran.code).toBe(0)
      const returnBranch = `${taskBranch(taskId)}-return`
      expect(ran.stdout).toContain('HEAD 是 ')
      expect(ran.stdout).not.toContain('工作区与转交时不同')
      expect(ran.stdout).toContain(
        `云端结果在新分支 ${returnBranch}（${head}）`,
      )
      const after = snapshot()
      expect(after.sums).toBe(before.sums)
      expect(after.index).toBe(before.index)
      expect(refsWithout(after.refs, `refs/heads/${returnBranch}`)).toBe(
        before.refs,
      )
      expect(git(repo, 'rev-parse', `refs/heads/${returnBranch}`)).toBe(head)
      expect((await taskView(taskId)).state).toBe('returned')
    },
    STEP_TIMEOUT_MS,
  )

  test(
    'the app-server token is in no argv, nothing of the hub, nothing of the laptop, no output',
    async () => {
      expect(attachTask).not.toBe('')
      const texts: string[] = []
      const walk = (dir: string): void => {
        for (const name of readdirSync(dir)) {
          const path = join(dir, name)
          const stat = statSync(path, { throwIfNoEntry: false })
          if (stat === undefined) continue
          if (stat.isDirectory()) walk(path)
          else if (stat.isFile()) texts.push(readFileSync(path, 'latin1'))
        }
      }
      // The hub's ledger, audit trail and repositories; the laptop's
      // registration, session records and sync log; the shims' argv log.
      walk(hubConfig)
      walk(join(root, 'hub'))
      walk(laptopConfig)
      walk(laptopQm)
      walk(join(repo, '.git'))
      for (const path of shimLogs) texts.push(readFileSync(path, 'utf8'))
      for (const bare of [hubBare]) {
        const dump = Bun.spawnSync(
          ['git', 'cat-file', '--batch-all-objects', '--batch'],
          { cwd: bare, env: baseEnv(), stdout: 'pipe', stderr: 'pipe' },
        )
        expect(dump.exitCode).toBe(0)
        texts.push(dump.stdout.toString('latin1'))
      }
      texts.push(
        ...attachOutput,
        hub?.stdout() ?? '',
        hub?.stderr() ?? '',
        bridge?.stdout() ?? '',
        bridge?.stderr() ?? '',
        JSON.stringify(await taskView(attachTask)),
        JSON.stringify((await hubApi('GET', '/v0/handoff')).body),
      )
      expect(texts.length).toBeGreaterThan(10)
      expect(texts.filter(text => text.includes(APP_TOKEN))).toEqual([])
      // Every argv the stand-ins saw, token-free (the logs have them all).
      const argvs = shimLogs.flatMap(path =>
        shimEvents(path).filter(e => e.event === 'start'),
      )
      expect(argvs.length).toBeGreaterThanOrEqual(9)
      for (const event of argvs) {
        expect(JSON.stringify(event.argv)).not.toContain(APP_TOKEN)
      }
    },
    STEP_TIMEOUT_MS,
  )
})
