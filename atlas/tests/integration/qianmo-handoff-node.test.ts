// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * P17.5 end to end: the laptop hands a session over, the hub dispatches it to
 * a node bridge, the bridge continues it on an app-server and the result
 * comes back to the hub.
 *
 * ## What is real
 *
 * Three kinds of `qm` process from source (`atlas/packages/node/src/cli.ts`),
 * each with its own config root: the laptop (`handoff init`,
 * `handoff now`), the hub (`qm console --handoff-root … --handoff-node …`) and
 * the node bridge (`qm handoff node`). The hub reaches the bridge over the
 * real transport (PSK, signed `task.request`) and its repositories with real
 * git; the node's repository is a local path (the SSH gate is the one hop
 * left out — `handoffHub.test.ts` covers it).
 *
 * ## What is made up
 *
 * - The app-server: `support/fakeAppServer.ts`, in this process — no model is
 *   called. It writes a file in the work tree and echoes a key-shaped canary
 *   in its last message.
 * - `bwrap`: a stub on the bridge's `PATH` (exit 0, or exit 1 with the error
 *   unprivileged user namespaces give). The real sandbox is not exercised
 *   here; on a node it is the fork's.
 * - The laptop's qmcode rollout (`support/handoffSamples.ts`).
 *
 * ## The completion criteria here
 *
 * - 4: without a working `bwrap` the bridge refuses to start and says why
 *   (two red cases); with one it starts (green).
 * - 1, 6, 7: `now` → the hub pushes the objects and sends a signed request →
 *   the bridge resumes the laptop's thread → a `send` posted to the hub while
 *   the turn runs reaches that turn → the result comes back, the hub fetches
 *   the branch and the cloud session ref, the ledger says `done`, the audit
 *   trail and the webhook say so too.
 * - 3: the node's repository has only `qianmo/` branches and no remote.
 * - 9: a key-shaped canary in the bridge's environment and in the model's
 *   reply is in no file, git object, process output, API answer or webhook
 *   body of the hub or the node.
 *
 * Criteria 2, 5 and 8 are in `handoffNode.test.ts`,
 * `demo/env/beta/handoff-node.test.ts` and `consoleHandoffDispatch.test.ts`.
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
import { dirname, join } from 'node:path'
import { readTrail } from '@qianmo/audit'
import { sessionRef, taskBranch } from '@qianmo/handoff'
import { transportPskEnvVarForNode } from '@qianmo/node/commands/consoleArgs.js'
import {
  type FakeAppServer,
  startFakeAppServer,
} from '../../packages/node/test/commands/support/fakeAppServer.js'
import {
  qmcodeRollout,
  qmcodeRolloutPath,
} from '../../packages/node/test/commands/support/handoffSamples.js'
import { bwrapStub } from '../../packages/node/test/commands/support/handoffNodeFixtures.js'
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
const DEVICE = 'laptop'
const NODE = 'cloud-1'
const THREAD = '0199a4c2-7c1e-7d32-9a5e-3b1f2c4d5e70'
const TURN_1 = '0199a4c2-8000-7000-8000-000000000101'
const SEND_TEXT = '顺手把 README 里那句也改了'
/** Key-shaped: in the bridge's environment and in the model's reply. */
const CANARY = `sk-test-canary-${randomBytes(12).toString('hex')}`
const PSK = randomBytes(32).toString('hex')

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
let nodeTokenFile = ''
let gitConfig = ''
let adminTokenFile = ''
let viewTokenFile = ''
let adminToken = ''
let trust = ''
let port = 0
let nodePort = 0
let goodBwrap = ''
let fake: FakeAppServer | undefined
let hub: RunningConsole | undefined
let bridge: RunningConsole | undefined
let hook: ReturnType<typeof Bun.serve> | undefined
const hookBodies: unknown[] = []
let hookUrl = ''

function baseEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value
  }
  for (const key of INHERITED_KEYS_TO_DROP) delete env[key]
  return {
    ...env,
    NODE_ENV: 'production',
    NO_COLOR: '1',
    GIT_CONFIG_GLOBAL: gitConfig,
    GIT_CONFIG_NOSYSTEM: '1',
  }
}

function laptopEnv(): Record<string, string> {
  return {
    ...baseEnv(),
    QIANMO_CONFIG_DIR: laptopConfig,
    QMCODE_HOME: laptopQm,
    CODEX_THREAD_ID: THREAD,
  }
}

function hubEnv(): Record<string, string> {
  return {
    ...baseEnv(),
    QIANMO_CONFIG_DIR: hubConfig,
    [transportPskEnvVarForNode(NODE, 'test')]: PSK,
  }
}

/** The bridge: its PSK, a bwrap on `PATH` (or not), and the canary. */
function nodeEnv(path: string): Record<string, string> {
  return {
    ...baseEnv(),
    QIANMO_CONFIG_DIR: nodeConfig,
    QIANMO_TRANSPORT_PSK: PSK,
    OPENAI_API_KEY: CANARY,
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

function nodeArgs(nodeDir: string, listen: number): string[] {
  return [
    'handoff',
    'node',
    '--node',
    NODE,
    '--root',
    nodeDir,
    '--trust',
    trust,
    '--app-server',
    fake?.url ?? '',
    '--app-server-token-file',
    nodeTokenFile,
    '--app-server-home',
    nodeHome,
    '--qmcode-home',
    nodeQm,
    '--project',
    'atlas',
    '--port',
    String(listen),
    '--bind',
    '127.0.0.1',
  ]
}

/** `qm handoff node` as a long-running process. */
function startBridge(): RunningConsole {
  const child: ChildProcess = spawn(
    process.execPath,
    [...cliPrefix(), ...nodeArgs(nodeRoot, nodePort)],
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
  const exited = new Promise<void>(done => child.once('exit', () => done()))
  return { child, exited, stdout: () => stdout, stderr: () => stderr }
}

async function hubApi(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${adminToken}`,
      accept: 'application/json',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
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

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'qianmo-handoff-node-e2e-'))
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
  mkdirSync(nodeHome, { recursive: true })

  // The laptop: one commit, an edit on top, one finished qmcode turn.
  repo = join(root, 'work', 'atlas')
  mkdirSync(repo, { recursive: true })
  git(repo, 'init', '-q', '-b', 'main')
  writeFileSync(join(repo, 'a.txt'), 'one\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'one')
  writeFileSync(join(repo, 'a.txt'), 'half done\n')
  repo = git(repo, 'rev-parse', '--show-toplevel')
  const rollout = qmcodeRolloutPath(laptopQm, THREAD)
  mkdirSync(dirname(rollout), { recursive: true })
  writeFileSync(
    rollout,
    qmcodeRollout(THREAD, repo, [
      { turnId: TURN_1, user: '把 a.txt 改完', assistant: '改了一半' },
    ]),
  )

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

  // The hub's signing identity, the line the node trusts.
  const identity = await qm(
    ['console', '--print-wake-identity'],
    hubEnv(),
    root,
  )
  expect(identity.code).toBe(0)
  trust = identity.stdout.trim()
  expect(trust).toMatch(/^console=\S+$/)

  // The app-server next to the bridge: holds each turn until released.
  const appToken = randomBytes(32).toString('hex')
  nodeTokenFile = join(root, 'app-server.token')
  writeFileSync(nodeTokenFile, `${appToken}\n`, { mode: 0o600 })
  fake = startFakeAppServer({
    token: appToken,
    qmcodeHome: nodeQm,
    hold: true,
    work: turn =>
      writeFileSync(join(turn.cwd, 'cloud.txt'), 'from the cloud\n'),
    reply: () => `收尾了，调试时看到 ${CANARY}`,
  })

  hook = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      hookBodies.push(await request.json())
      return new Response('ok')
    },
  })
  hookUrl = `http://127.0.0.1:${hook.port}/hook/secret-topic-e2e`

  goodBwrap = bwrapStub(join(root, 'bwrap-ok'))
  nodePort = await freePort()
  bridge = startBridge()
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
      '--handoff-notify-url',
      hookUrl,
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
    laptopEnv(),
  )
  expect(init.stderr).toBe('')
  expect(init.code).toBe(0)
}, BOOT_TIMEOUT_MS)

afterAll(async () => {
  fake?.release()
  if (hub !== undefined) await stopConsole(hub)
  if (bridge !== undefined) await stopConsole(bridge)
  fake?.stop()
  hook?.stop(true)
  if (root !== '') rmSync(root, { recursive: true, force: true })
})

describe('qm handoff node end to end', () => {
  test(
    'criterion 4 · no bwrap, or one that cannot sandbox: the bridge refuses to start and says why',
    async () => {
      // Green: the bridge in beforeAll started with a working bwrap.
      expect(bridge?.stdout()).toContain(`bwrap         ${goodBwrap}/bwrap`)
      expect(bridge?.stdout()).toContain(
        `handoff-node  qianmo://${NODE}/handoff`,
      )

      const empty = join(root, 'empty-bin')
      mkdirSync(empty, { recursive: true })
      const missingRoot = join(root, 'node-missing')
      const missing = await qm(
        nodeArgs(missingRoot, await freePort()),
        nodeEnv(empty),
        root,
      )
      expect(missing.code).toBe(1)
      expect(missing.stderr).toContain('节点桥没有启动')
      expect(missing.stderr).toContain('PATH 上没有 bwrap')
      expect(missing.stderr).toContain('不退到 danger-full-access')
      expect(existsSync(missingRoot)).toBe(false)

      const broken = bwrapStub(
        join(root, 'bwrap-broken'),
        1,
        'bwrap: setting up uid map: Permission denied',
      )
      const brokenRoot = join(root, 'node-broken')
      const refused = await qm(
        nodeArgs(brokenRoot, await freePort()),
        nodeEnv(`${broken}:/usr/bin:/bin`),
        root,
      )
      expect(refused.code).toBe(1)
      expect(refused.stderr).toContain('建不了沙箱（退出码 1')
      expect(refused.stderr).toContain('setting up uid map: Permission denied')
      expect(existsSync(brokenRoot)).toBe(false)
    },
    STEP_TIMEOUT_MS,
  )

  let taskId = ''

  test(
    'criteria 1, 6, 7 · now → dispatched → the node resumes the thread → send reaches the turn → done, fetched back',
    async () => {
      const ran = await qm(
        ['handoff', 'now', '--goal', '把 a.txt 收尾'],
        laptopEnv(),
      )
      expect(ran.stderr).toBe('')
      expect(ran.code).toBe(0)
      expect(ran.stdout.split('\n')[0]).toBe(SAFE)
      taskId = /任务\s+(\S+)/.exec(ran.stdout)?.[1] ?? ''
      expect(taskId).not.toBe('')
      const manifest = (await taskView(taskId)).manifest as Record<
        string,
        unknown
      >

      // The hub dispatched it without being asked: the node's turn is open.
      await until('the node to open a turn', () => fake?.turns.length === 1)
      const turnId = fake?.turns[0] ?? ''
      expect(fake?.calls('thread/resume')[0]?.threadId).toBe(THREAD)
      await until(
        'running',
        async () => (await taskView(taskId)).state === 'running',
      )

      // A send while the turn runs reaches that turn.
      const sent = await hubApi('POST', `/v0/handoff/${taskId}/send`, {
        text: SEND_TEXT,
      })
      expect(sent.status).toBe(202)
      await until('the send to reach the turn', () =>
        (fake?.inputs(turnId) ?? []).includes(SEND_TEXT),
      )
      expect(fake?.turns).toHaveLength(1)

      fake?.release(turnId)
      await until('done', async () => (await taskView(taskId)).state === 'done')

      const task = await taskView(taskId)
      const result = task.result as Record<string, unknown>
      expect(result.status).toBe('completed')
      expect(result.branch).toBe(taskBranch(taskId))
      expect(result.threadId).toBe(THREAD)
      const head = String(result.head)
      expect(git(hubBare, 'rev-parse', taskBranch(taskId))).toBe(head)
      expect(git(hubBare, 'show', `${head}:cloud.txt`)).toBe('from the cloud')
      expect(git(hubBare, 'show', `${head}:a.txt`)).toBe('half done')
      expect(git(hubBare, 'rev-parse', `${head}^`)).toBe(String(manifest.wip))
      const nodeBare = join(nodeRoot, 'repos', 'atlas.git')
      expect(git(hubBare, 'rev-parse', sessionRef('cloud', THREAD))).toBe(
        git(nodeBare, 'rev-parse', sessionRef('cloud', THREAD)),
      )

      const kinds = readTrail(
        join(hubConfig, 'qianmo', 'handoff', 'audit.ndjson'),
      )
        .records.filter(record => record.taskId === taskId)
        .map(record => record.kind)
      expect(kinds).toEqual([
        'handoff.accepted',
        'handoff.dispatched',
        'handoff.completed',
      ])

      await until('the webhook', () => hookBodies.length === 1)
      expect(hookBodies[0]).toMatchObject({
        msgtype: 'text',
        qianmo: {
          taskId,
          state: 'done',
          node: NODE,
          status: 'completed',
          branch: taskBranch(taskId),
          threadId: THREAD,
        },
      })
    },
    STEP_TIMEOUT_MS,
  )

  test(
    'criterion 3 · the node repository: only qianmo/ branches, no remote',
    () => {
      expect(taskId).not.toBe('')
      const nodeBare = join(nodeRoot, 'repos', 'atlas.git')
      const branches = git(
        nodeBare,
        'for-each-ref',
        '--format=%(refname)',
        'refs/heads',
      )
        .split('\n')
        .filter(Boolean)
      expect(branches).toEqual([`refs/heads/${taskBranch(taskId)}`])
      expect(git(nodeBare, 'remote')).toBe('')
      expect(
        Bun.spawnSync(
          [
            'git',
            '--git-dir',
            nodeBare,
            'config',
            '--get-regexp',
            '^remote\\.',
          ],
          { env: baseEnv() },
        ).exitCode,
      ).toBe(1)
    },
    STEP_TIMEOUT_MS,
  )

  test(
    'criterion 9 · the canary is in no file, git object, output, answer or webhook of the hub or the node',
    async () => {
      expect(taskId).not.toBe('')
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
      // Files as they are on disk (git's loose objects are compressed: read
      // through git below).
      walk(hubConfig)
      walk(join(root, 'hub'))
      walk(nodeRoot)
      walk(nodeConfig)
      for (const bare of [hubBare, join(nodeRoot, 'repos', 'atlas.git')]) {
        const dump = Bun.spawnSync(
          ['git', 'cat-file', '--batch-all-objects', '--batch'],
          { cwd: bare, env: baseEnv(), stdout: 'pipe', stderr: 'pipe' },
        )
        expect(dump.exitCode).toBe(0)
        expect(dump.stdout.length).toBeGreaterThan(0)
        texts.push(dump.stdout.toString('latin1'))
      }
      texts.push(
        hub?.stdout() ?? '',
        hub?.stderr() ?? '',
        bridge?.stdout() ?? '',
        bridge?.stderr() ?? '',
        JSON.stringify(hookBodies),
        JSON.stringify(await taskView(taskId)),
        JSON.stringify((await hubApi('GET', '/v0/handoff')).body),
      )
      const found = texts.filter(text => text.includes(CANARY))
      expect(found).toEqual([])
      // The model's reply arrived, redacted.
      const result = (await taskView(taskId)).result as Record<string, unknown>
      expect(String(result.summary)).toContain('收尾了，调试时看到 ***')
      // The webhook URL's path is not in the hub's output.
      expect(`${hub?.stdout()}${hub?.stderr()}`).not.toContain(
        'secret-topic-e2e',
      )
    },
    STEP_TIMEOUT_MS,
  )
})
