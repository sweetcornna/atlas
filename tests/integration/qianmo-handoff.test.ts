// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `qm handoff` end to end: the laptop commands against a real hub on loopback
 * (P17.4 完成标准).
 *
 * ## What is real
 *
 * Every command is its own `qm` process from source, with the shipped defines
 * and feature list: `handoff init / sync --hook … / now / status` on the
 * laptop side, and `qm console --handoff-root` as the hub, each with its own
 * throwaway config root. The hub's bare repository is a local path (the SSH
 * hop is the one thing left out; `init` over SSH runs the same script that
 * `handoffHub.test.ts` runs through `sh -s`). Git is real git; the hub checks
 * objects with `git cat-file` in that repository.
 *
 * ## What is made up
 *
 * The transcripts and hook inputs: qmcode rollouts, the notify argument and
 * Claude Code's hook stdin are built by `support/handoffSamples.ts` in the
 * shapes the fork and the base write them. No model is called.
 *
 * ## The completion criteria, in order
 *
 * 1. `now` prints 「已落地，可以关机」 only after the hub accepted: refused
 *    while a qmcode turn runs, no sentence when the console is down, the
 *    sentence once the ledger holds the task and the hub holds the objects.
 *    Run by `/handoff` in qmcode (`CODEX_THREAD_ID` set, the rollout ending
 *    on the shell turn's own `task_started`), that shell turn is left out; a
 *    model turn running is still refused.
 * 2. A session object lost on the hub after the push: `now` fails and says so.
 * 3. The hub keeps the ledger across a restart; a second console on the same
 *    root cannot take the ledger.
 * 4. The user's HEAD, index, stash, branches, tags and files are byte-identical.
 * 5. The hub's pre-receive hook refuses refs outside the handoff namespaces.
 * 6. `sync --hook qmcode` and `--hook claude-code`: a complete turn is pushed,
 *    an incomplete one is not, a thread without a rollout is skipped.
 * 7. A canary in the environment of every laptop command is in no file left
 *    behind (config roots, hub repository, user repository, all git objects).
 * 8. `cli-golden.test.ts` lists `handoff` (that file, not this one).
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { readTrail } from '@qianmo/audit'
import {
  claudeCodeHookInput,
  claudeCodeTranscript,
  qmcodeNotify,
  qmcodeRollout,
  qmcodeRolloutPath,
  type QmcodeTurn,
} from '../../src/cli/handlers/__tests__/support/handoffSamples.js'
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
const THREAD = '0199a4c2-7c1e-7d32-9a5e-3b1f2c4d5e6f'
const TEMP_THREAD = '0199a4c2-7c1e-7d32-9a5e-ffffffffffff'
const TURN_1 = '0199a4c2-8000-7000-8000-000000000001'
const TURN_2 = '0199a4c2-8000-7000-8000-000000000002'
const TURN_3 = '0199a4c2-8000-7000-8000-000000000003'
const TURN_4 = '0199a4c2-8000-7000-8000-000000000004'
const TURN_5 = '0199a4c2-8000-7000-8000-000000000005'
const TURN_6 = '0199a4c2-8000-7000-8000-000000000006'
/** The shell turn `/handoff` opens to run `qm handoff now` in. */
const SHELL_TURN = '0199a4c2-8000-7000-8000-000000000007'
const CC_DONE = '7d8c2a10-3c55-4b2e-9a51-0f6c1d2e3a4b'
const CC_OPEN = '7d8c2a10-3c55-4b2e-9a51-0f6c1d2e3a4c'
/** In the environment of every laptop command; must end up nowhere. */
const CANARY = `sk-test-canary-${randomBytes(12).toString('hex')}`

const BOOT_TIMEOUT_MS = 90_000
const STEP_TIMEOUT_MS = 90_000

let root = ''
let repo = ''
let hubRoot = ''
let bare = ''
let laptopConfig = ''
let hubConfig = ''
let qmHome = ''
let ccDir = ''
let gitConfig = ''
let adminTokenFile = ''
let viewTokenFile = ''
let adminToken = ''
let port = 0
let userBefore = ''

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
    // The developer's ~/.gitconfig (signing, hooks, templates) stays out.
    GIT_CONFIG_GLOBAL: gitConfig,
    GIT_CONFIG_NOSYSTEM: '1',
  }
}

/** The laptop: its own config root, qmcode's home, and the canary. */
function laptopEnv(): Record<string, string> {
  return {
    ...baseEnv(),
    OCC_CONFIG_DIR: laptopConfig,
    QMCODE_HOME: qmHome,
    OPENAI_API_KEY: CANARY,
    QIANMO_E2E_CANARY: CANARY,
  }
}

function hubEnv(): Record<string, string> {
  return { ...baseEnv(), OCC_CONFIG_DIR: hubConfig }
}

interface Ran {
  readonly code: number | null
  readonly stdout: string
  readonly stderr: string
}

async function qm(
  args: readonly string[],
  options: {
    cwd?: string
    /** Passed as a Blob: a socket on macOS, a memfd (a regular file) on Linux. */
    stdin?: string
    /** Passed as this file: a regular file on every system, like `< file`. */
    stdinFile?: string
    env?: Record<string, string>
  } = {},
): Promise<Ran> {
  const proc = Bun.spawn([process.execPath, ...cliPrefix(), ...args], {
    cwd: options.cwd ?? repo,
    env: options.env ?? laptopEnv(),
    stdin:
      options.stdinFile !== undefined
        ? Bun.file(options.stdinFile)
        : options.stdin === undefined
          ? 'ignore'
          : new Blob([options.stdin]),
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

function tryGit(cwd: string, ...args: string[]): Ran {
  const proc = Bun.spawnSync(['git', ...args], {
    cwd,
    env: baseEnv(),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return {
    code: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  }
}

function hubRefs(): Map<string, string> {
  const out = new Map<string, string>()
  const listed = git(bare, 'for-each-ref', '--format=%(refname) %(objectname)')
  for (const line of listed.split('\n').filter(Boolean)) {
    const [ref, sha] = line.split(' ')
    if (ref !== undefined && sha !== undefined) out.set(ref, sha)
  }
  return out
}

function syncLog(): Record<string, unknown>[] {
  let text = ''
  try {
    text = readFileSync(
      join(laptopConfig, 'qianmo', 'handoff', 'sync.log'),
      'utf8',
    )
  } catch {
    return []
  }
  return text
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line) as Record<string, unknown>)
}

/** Pending entries the laptop is holding for the next sync, in every repository. */
function pendingFiles(): string[] {
  const state = join(laptopConfig, 'qianmo', 'handoff', 'state')
  const out: string[] = []
  for (const key of readdirSync(state)) {
    try {
      out.push(
        ...readdirSync(join(state, key, 'pending')).filter(name =>
          name.endsWith('.json'),
        ),
      )
    } catch {}
  }
  return out
}

/** Everything of the user's repository nothing here may touch. */
function userState(): string {
  const dot = join(repo, '.git')
  return JSON.stringify({
    head: readFileSync(join(dot, 'HEAD'), 'utf8'),
    index: readFileSync(join(dot, 'index')).toString('base64'),
    stash: readFileSync(join(dot, 'refs', 'stash'), 'utf8'),
    stashLog: readFileSync(join(dot, 'logs', 'refs', 'stash'), 'utf8'),
    headLog: readFileSync(join(dot, 'logs', 'HEAD'), 'utf8'),
    refs: git(
      repo,
      'for-each-ref',
      '--format=%(refname) %(objectname)',
      'refs/heads',
      'refs/tags',
      'refs/remotes',
      'refs/stash',
    ),
    config: readFileSync(join(dot, 'config'), 'utf8'),
    // --no-optional-locks: `status` must not refresh the index it is measuring.
    status: git(
      repo,
      '--no-optional-locks',
      'status',
      '--porcelain=v1',
      '-uall',
    ),
    files: Object.fromEntries(
      ['a.txt', 'b.txt', 'new.txt'].map(name => [
        name,
        readFileSync(join(repo, name), 'utf8'),
      ]),
    ),
  })
}

// ─── The hub process ─────────────────────────────────────────────────

let hub: RunningConsole | undefined

function startConsole(listen: number): RunningConsole {
  return startHandoffConsole({
    port: listen,
    handoffRoot: hubRoot,
    adminTokenFile,
    viewTokenFile,
    cwd: root,
    env: hubEnv(),
  })
}

async function bootHub(): Promise<void> {
  const running = startConsole(port)
  hub = running
  await waitForConsole(running, port, BOOT_TIMEOUT_MS)
}

async function stopHub(): Promise<void> {
  const running = hub
  hub = undefined
  if (running !== undefined) await stopConsole(running)
}

async function hubGet(
  path: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
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

// ─── Fixture ─────────────────────────────────────────────────────────

const rolloutFile = (): string => qmcodeRolloutPath(qmHome, THREAD)
const turns: QmcodeTurn[] = []

function writeRollout(): void {
  mkdirSync(dirname(rolloutFile()), { recursive: true })
  writeFileSync(rolloutFile(), qmcodeRollout(THREAD, repo, turns))
}

function ccTranscript(id: string): string {
  return join(ccDir, `${id}.jsonl`)
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'qianmo-handoff-e2e-'))
  gitConfig = join(root, 'gitconfig')
  writeFileSync(gitConfig, '')
  laptopConfig = join(root, 'laptop-config')
  hubConfig = join(root, 'hub-config')
  hubRoot = join(root, 'hub', 'repos')
  qmHome = join(root, 'qmcode-home')
  ccDir = join(root, 'claude', 'projects', '-work-atlas')
  for (const dir of [laptopConfig, hubConfig, qmHome, ccDir]) {
    mkdirSync(dir, { recursive: true })
  }

  // The user's repository mid-work: a stash, a staged edit, an unstaged edit
  // on top, an untracked file. Two empty subdirectories are where the Claude
  // Code sessions below report from.
  repo = join(root, 'work', 'atlas')
  mkdirSync(repo, { recursive: true })
  git(repo, 'init', '-q', '-b', 'main')
  writeFileSync(join(repo, 'a.txt'), 'one\n')
  writeFileSync(join(repo, 'b.txt'), 'b\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'one')
  writeFileSync(join(repo, 'b.txt'), 'stashed\n')
  git(repo, 'stash', 'push', '-q')
  writeFileSync(join(repo, 'a.txt'), 'staged\n')
  git(repo, 'add', 'a.txt')
  writeFileSync(join(repo, 'a.txt'), 'staged then edited\n')
  writeFileSync(join(repo, 'new.txt'), 'untracked\n')
  mkdirSync(join(repo, 'docs'))
  mkdirSync(join(repo, 'packages'))
  repo = git(repo, 'rev-parse', '--show-toplevel')
  bare = join(hubRoot, 'atlas.git')
  userBefore = userState()

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
  port = await freePort()
  await bootHub()
}, BOOT_TIMEOUT_MS)

afterAll(async () => {
  await stopHub()
  if (root !== '') rmSync(root, { recursive: true, force: true })
})

describe('qm handoff end to end', () => {
  test(
    'init: creates the hub repository and records the project',
    async () => {
      const ran = await qm([
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
      ])
      expect(ran.stderr).toBe('')
      expect(ran.code).toBe(0)
      expect(ran.stdout).toContain(`已登记 ${repo}`)
      expect(git(bare, 'rev-parse', '--is-bare-repository')).toBe('true')
      expect(statSync(join(bare, 'hooks', 'pre-receive')).mode & 0o100).toBe(
        0o100,
      )
    },
    STEP_TIMEOUT_MS,
  )

  test(
    'init again: what is not given is kept; only --no-token-file forgets the credential',
    async () => {
      const again = (...extra: string[]) =>
        qm([
          'handoff',
          'init',
          '--hub',
          hubRoot,
          '--console',
          `http://127.0.0.1:${port}`,
          ...extra,
        ])
      const registered = (): Record<string, unknown> =>
        (
          JSON.parse(
            readFileSync(
              join(laptopConfig, 'qianmo', 'handoff', 'projects.json'),
              'utf8',
            ),
          ) as { projects: Record<string, Record<string, unknown>> }
        ).projects[repo] ?? {}

      const kept = await again()
      expect(kept.code).toBe(0)
      expect(kept.stdout).toContain('（沿用已登记的）')
      expect(registered()).toMatchObject({
        tokenFile: adminTokenFile,
        device: DEVICE,
        project: 'atlas',
      })

      const empty = await again('--token-file', '')
      expect(empty.code).toBe(2)
      expect(empty.stderr).toContain('--no-token-file')
      expect(registered().tokenFile).toBe(adminTokenFile)

      const cleared = await again('--no-token-file')
      expect(cleared.code).toBe(0)
      expect(cleared.stdout).toContain('已清除登记的凭据文件')
      expect(registered().tokenFile).toBeUndefined()
      expect(registered().device).toBe(DEVICE)
      const status = await qm(['handoff', 'status'])
      expect(status.code).toBe(1)
      expect(status.stderr).toContain('没有登记控制台凭据')

      const back = await again('--token-file', adminTokenFile)
      expect(back.code).toBe(0)
      expect(registered().tokenFile).toBe(adminTokenFile)
    },
    STEP_TIMEOUT_MS,
  )

  test(
    'criterion 6 · qmcode: a complete turn is pushed; an incomplete one is not; a thread without a rollout is skipped',
    async () => {
      turns.push({ turnId: TURN_1, user: '把 a.txt 读出来', assistant: 'one' })
      writeRollout()
      const done = await qm([
        'handoff',
        'sync',
        '--hook',
        'qmcode',
        qmcodeNotify(THREAD, TURN_1, repo),
      ])
      expect(done).toEqual({ code: 0, stdout: '', stderr: '' })
      const refs = hubRefs()
      const sessionRef = `refs/qianmo/sessions/${DEVICE}/${THREAD}`
      const pushed = refs.get(sessionRef)
      expect(pushed).toBeDefined()
      expect(refs.get(`refs/qianmo/wip/${DEVICE}/main`)).toBeDefined()
      const name = rolloutFile().split('/').at(-1) ?? ''
      expect(git(bare, 'show', `${pushed}:${name}`)).toContain(TURN_1)

      // Turn 2 has started and its end is not on disk: 2 s of re-reading, then
      // nothing is pushed and the log says why.
      turns.push({
        turnId: TURN_2,
        user: '再改一下',
        assistant: 'two',
        ending: 'open',
      })
      writeRollout()
      const open = await qm([
        'handoff',
        'sync',
        '--hook',
        'qmcode',
        qmcodeNotify(THREAD, TURN_2, repo),
      ])
      expect(open).toEqual({ code: 0, stdout: '', stderr: '' })
      expect(hubRefs().get(sessionRef)).toBe(pushed ?? '')
      expect(syncLog().at(-1)).toMatchObject({
        event: 'skip',
        tool: 'qmcode',
        sessionId: THREAD,
      })
      expect(String(syncLog().at(-1)?.reason)).toContain('not complete')

      // The TUI's title thread: notify fires, no rollout exists.
      const temp = await qm([
        'handoff',
        'sync',
        '--hook',
        'qmcode',
        qmcodeNotify(TEMP_THREAD, TURN_1, repo),
      ])
      expect(temp).toEqual({ code: 0, stdout: '', stderr: '' })
      expect(syncLog().at(-1)).toMatchObject({
        event: 'skip',
        sessionId: TEMP_THREAD,
      })
      expect([...hubRefs().keys()].some(ref => ref.includes(TEMP_THREAD))).toBe(
        false,
      )
    },
    STEP_TIMEOUT_MS,
  )

  test(
    'criterion 6 · claude-code: a complete Stop is pushed; one with the answer not on disk is not',
    async () => {
      writeFileSync(
        ccTranscript(CC_DONE),
        claudeCodeTranscript(CC_DONE, join(repo, 'docs'), 'complete'),
      )
      // The hook input as a regular file. The CLI loads ink before it
      // dispatches, and ink touches process.stdin at load; read through
      // process.stdin, a file-backed stdin then came out empty — on Linux the
      // Blob stdin below is a file too, which is how CI saw it first.
      const doneInput = join(root, 'cc-done-hook-input.json')
      writeFileSync(
        doneInput,
        claudeCodeHookInput(CC_DONE, ccTranscript(CC_DONE), join(repo, 'docs')),
      )
      const done = await qm(['handoff', 'sync', '--hook', 'claude-code'], {
        stdinFile: doneInput,
      })
      expect(done).toEqual({ code: 0, stdout: '', stderr: '' })
      const ref = `refs/qianmo/sessions/${DEVICE}/${CC_DONE}`
      const commit = hubRefs().get(ref)
      expect(commit).toBeDefined()
      expect(git(bare, 'show', `${commit}:${CC_DONE}.jsonl`)).toContain(
        'end_turn',
      )

      writeFileSync(
        ccTranscript(CC_OPEN),
        claudeCodeTranscript(CC_OPEN, join(repo, 'packages'), 'tool-result'),
      )
      const open = await qm(['handoff', 'sync', '--hook', 'claude-code'], {
        stdin: claudeCodeHookInput(
          CC_OPEN,
          ccTranscript(CC_OPEN),
          join(repo, 'packages'),
        ),
      })
      expect(open).toEqual({ code: 0, stdout: '', stderr: '' })
      expect(hubRefs().has(`refs/qianmo/sessions/${DEVICE}/${CC_OPEN}`)).toBe(
        false,
      )
      expect(syncLog().at(-1)).toMatchObject({
        event: 'skip',
        tool: 'claude-code',
        sessionId: CC_OPEN,
      })
    },
    STEP_TIMEOUT_MS,
  )

  test(
    'criterion 1 · refused while a qmcode turn runs: no sentence, nothing synced',
    async () => {
      const before = hubRefs()
      const ran = await qm(['handoff', 'now'])
      expect(ran.code).toBe(1)
      expect(ran.stderr).toContain('回合进行中')
      expect(ran.stdout).not.toContain(SAFE)
      expect(hubRefs()).toEqual(before)
    },
    STEP_TIMEOUT_MS,
  )

  test(
    'criterion 1 · console down: synced, but no sentence',
    async () => {
      turns[1] = { turnId: TURN_2, user: '再改一下', assistant: 'two' }
      writeRollout()
      await stopHub()
      try {
        const ran = await qm(['handoff', 'now', '--goal', '把 a.txt 收尾'])
        expect(ran.code).toBe(1)
        expect(ran.stderr).toContain('连不上控制台')
        expect(ran.stdout).not.toContain(SAFE)
        // The sync itself happened; it is the registration that is missing.
        const name = rolloutFile().split('/').at(-1) ?? ''
        const session = hubRefs().get(
          `refs/qianmo/sessions/${DEVICE}/${THREAD}`,
        )
        expect(git(bare, 'show', `${session}:${name}`)).toContain(TURN_2)
      } finally {
        // The later steps need the hub whether or not this one held.
        await bootHub()
      }
    },
    STEP_TIMEOUT_MS,
  )

  let acceptedTask = ''

  test(
    'criterion 1 · the sentence comes after the hub has the task and the objects',
    async () => {
      const ran = await qm(['handoff', 'now', '--goal', '把 a.txt 收尾'])
      expect(ran.stderr).toBe('')
      expect(ran.code).toBe(0)
      const lines = ran.stdout.split('\n')
      expect(lines[0]).toBe(SAFE)
      const taskId = /任务\s+(\S+)/.exec(ran.stdout)?.[1] ?? ''
      expect(taskId).not.toBe('')
      acceptedTask = taskId

      const { status, body } = await hubGet(`/v0/handoff/${taskId}`)
      expect(status).toBe(200)
      const task = body.task as Record<string, unknown>
      const manifest = task.manifest as Record<string, unknown>
      expect(task.state).toBe('accepted')
      const refs = hubRefs()
      expect(manifest.wip).toBe(refs.get(`refs/qianmo/wip/${DEVICE}/main`))
      expect(manifest.sessionCommit).toBe(
        refs.get(`refs/qianmo/sessions/${DEVICE}/${THREAD}`),
      )
      expect(manifest.tool).toBe('qmcode')
      expect((manifest.brief as Record<string, unknown>).goal).toBe(
        '把 a.txt 收尾',
      )
      git(bare, 'cat-file', '-e', `${String(manifest.wip)}^{commit}`)
      git(bare, 'cat-file', '-e', `${String(manifest.sessionCommit)}^{commit}`)
      expect(git(bare, 'show', `${String(manifest.wip)}:a.txt`)).toBe(
        'staged then edited',
      )

      const trail = readTrail(
        join(hubConfig, 'qianmo', 'handoff', 'audit.ndjson'),
      )
      expect(trail.records.map(record => record.kind)).toContain(
        'handoff.accepted',
      )
    },
    STEP_TIMEOUT_MS,
  )

  test(
    'criterion 3 · a second console cannot take the ledger; a restart keeps the task',
    async () => {
      const second = startConsole(await freePort())
      const ended = await Promise.race([
        second.exited.then(() => true),
        Bun.sleep(BOOT_TIMEOUT_MS / 2).then(() => false),
      ])
      if (!ended) second.child.kill('SIGKILL')
      expect(ended).toBe(true)
      expect(second.child.exitCode).toBe(1)
      // One sentence with the lock file and the holder, no stack.
      const refusal = second.stderr()
      expect(refusal).toContain('控制台没有启动')
      expect(refusal).toContain(
        `锁文件 ${join(hubConfig, 'qianmo', 'handoff', 'ledger.ndjson.lock')}`,
      )
      expect(refusal).toContain(`持锁进程 pid ${hub?.child.pid}`)
      expect(refusal).not.toMatch(/\n\s+at /)
      expect(refusal).not.toContain('HandoffLedgerError')

      await stopHub()
      await bootHub()
      const { status, body } = await hubGet(`/v0/handoff/${acceptedTask}`)
      expect(status).toBe(200)
      expect((body.task as Record<string, unknown>).state).toBe('accepted')
      const ran = await qm(['handoff', 'status'])
      expect(ran.code).toBe(0)
      expect(ran.stdout).toContain(acceptedTask)
      expect(ran.stdout).toContain('accepted')
    },
    STEP_TIMEOUT_MS,
  )

  test(
    'criterion 2 · a session object lost on the hub after the push: now fails and says which',
    async () => {
      // The hub "loses" every session commit right after receiving it; the
      // refs still point at them, so only the hub's own cat-file can tell.
      const lost = join(bare, 'lost')
      const hook = join(bare, 'hooks', 'post-receive')
      writeFileSync(
        hook,
        [
          '#!/bin/sh',
          'mkdir -p lost',
          'while read -r old new ref; do',
          '  case "$ref" in',
          '    refs/qianmo/sessions/*)',
          '      dir=$(printf %s "$new" | cut -c1-2); rest=$(printf %s "$new" | cut -c3-)',
          '      mv "objects/$dir/$rest" "lost/$new" ;;',
          '  esac',
          'done',
          '',
        ].join('\n'),
        { mode: 0o755 },
      )
      try {
        turns.push({ turnId: TURN_3, user: '收尾', assistant: 'three' })
        writeRollout()
        const ran = await qm(['handoff', 'now'])
        expect(ran.code).toBe(1)
        expect(ran.stdout).not.toContain(SAFE)
        expect(ran.stderr).toContain('中枢没有登记这次转交')
        expect(ran.stderr).toContain('不在中枢裸仓里')
        const missing = readdirSync(lost)
        expect(missing).toHaveLength(1)
        expect(ran.stderr).toContain(missing[0] ?? '?')
      } finally {
        rmSync(hook, { force: true })
        for (const sha of readdirSync(lost)) {
          renameSync(
            join(lost, sha),
            join(bare, 'objects', sha.slice(0, 2), sha.slice(2)),
          )
        }
        rmSync(lost, { recursive: true, force: true })
      }
      // With the object back, the same handoff goes through.
      const again = await qm(['handoff', 'now'])
      expect(again.code).toBe(0)
      expect(again.stdout.split('\n')[0]).toBe(SAFE)
    },
    STEP_TIMEOUT_MS,
  )

  test(
    'a hook sync that fails while the hub is unreachable is kept; the next hook pushes the latest turn',
    async () => {
      const sessionRef = `refs/qianmo/sessions/${DEVICE}/${THREAD}`
      const name = rolloutFile().split('/').at(-1) ?? ''
      const away = `${bare}.away`
      renameSync(bare, away)
      try {
        turns.push({ turnId: TURN_4, user: '再跑一次', assistant: 'four' })
        writeRollout()
        const failed = await qm([
          'handoff',
          'sync',
          '--hook',
          'qmcode',
          qmcodeNotify(THREAD, TURN_4, repo),
        ])
        expect(failed).toEqual({ code: 0, stdout: '', stderr: '' })
        expect(syncLog().at(-1)).toMatchObject({ event: 'sync', ok: false })
        expect(pendingFiles()).toHaveLength(1)
      } finally {
        renameSync(away, bare)
      }
      turns.push({ turnId: TURN_5, user: '收尾', assistant: 'five' })
      writeRollout()
      const next = await qm([
        'handoff',
        'sync',
        '--hook',
        'qmcode',
        qmcodeNotify(THREAD, TURN_5, repo),
      ])
      expect(next).toEqual({ code: 0, stdout: '', stderr: '' })
      expect(syncLog().at(-1)).toMatchObject({ event: 'sync', ok: true })
      expect(pendingFiles()).toEqual([])
      const stored = git(bare, 'show', `${hubRefs().get(sessionRef)}:${name}`)
      expect(stored).toContain(TURN_4)
      expect(stored).toContain(TURN_5)
    },
    STEP_TIMEOUT_MS,
  )

  test(
    '/handoff in qmcode: the shell turn running now is left out; a model turn running is refused',
    async () => {
      const sessionRef = `refs/qianmo/sessions/${DEVICE}/${THREAD}`
      const name = rolloutFile().split('/').at(-1) ?? ''
      // What qmcode gives `/handoff` and `!` commands (QIANMO.md 10.3).
      const fromThread = {
        ...laptopEnv(),
        CODEX_THREAD_ID: THREAD,
        CODEX_SESSION_ID: THREAD,
      }
      const before = hubRefs()

      // A model turn runs. The TUI disables `/handoff` then; `!qm handoff now`
      // still runs, inside that turn.
      turns.push({
        turnId: TURN_6,
        user: '再看一眼',
        assistant: 'six',
        ending: 'open',
      })
      writeRollout()
      const busy = await qm(['handoff', 'now'], { env: fromThread })
      expect(busy.code).toBe(1)
      expect(busy.stderr).toContain(`回合进行中（${TURN_6}）`)
      expect(busy.stdout).not.toContain(SAFE)
      expect(hubRefs()).toEqual(before)

      // It ends; `/handoff` opens its own shell turn and runs `now` in it: the
      // rollout ends on that turn's task_started.
      turns[turns.length - 1] = {
        turnId: TURN_6,
        user: '再看一眼',
        assistant: 'six',
      }
      turns.push({
        turnId: SHELL_TURN,
        shell: 'qm handoff now',
        ending: 'runs',
      })
      writeRollout()
      // From a terminal the same open turn is a turn running.
      const terminal = await qm(['handoff', 'now'])
      expect(terminal.code).toBe(1)
      expect(terminal.stderr).toContain(`回合进行中（${SHELL_TURN}）`)
      expect(hubRefs()).toEqual(before)

      // From the thread itself it goes through — here from `docs/`, where the
      // last session reported is a Claude Code one: `/handoff` hands over the
      // thread it was typed in.
      const ran = await qm(['handoff', 'now'], {
        cwd: join(repo, 'docs'),
        env: fromThread,
      })
      expect(ran.stderr).toBe('')
      expect(ran.code).toBe(0)
      expect(ran.stdout.split('\n')[0]).toBe(SAFE)
      const taskId = /任务\s+(\S+)/.exec(ran.stdout)?.[1] ?? ''
      const { body } = await hubGet(`/v0/handoff/${taskId}`)
      const manifest = (body.task as Record<string, unknown>)
        .manifest as Record<string, unknown>
      expect(manifest.tool).toBe('qmcode')
      expect(manifest.sessionId).toBe(THREAD)
      const stored = git(bare, 'show', `${hubRefs().get(sessionRef)}:${name}`)
      expect(stored).toContain(TURN_6)
      expect(stored).not.toContain(SHELL_TURN)

      // The shell turn ends after `now` has exited.
      turns[turns.length - 1] = { turnId: SHELL_TURN, shell: 'qm handoff now' }
      writeRollout()
      // `status` names the session `now` takes from there.
      const status = await qm(['handoff', 'status'], {
        cwd: join(repo, 'docs'),
        env: fromThread,
      })
      expect(status.code).toBe(0)
      expect(status.stdout).toContain(
        `会话    qmcode ${THREAD}（运行这条命令的 qmcode 线程）`,
      )
      expect(
        (await qm(['handoff', 'status'], { cwd: join(repo, 'docs') })).stdout,
      ).toContain(`会话    claude-code ${CC_DONE}`)
    },
    STEP_TIMEOUT_MS,
  )

  test(
    'criterion 5 · the hub refuses refs outside refs/qianmo/{wip,sessions}/<device>/',
    () => {
      const before = hubRefs()
      for (const ref of [
        'refs/heads/main',
        'refs/tags/v1',
        'refs/qianmo/wip/cloud/main',
        'refs/qianmo/sessions/cloud/t1',
        'refs/heads/qianmo/20261003-1',
      ]) {
        const pushed = tryGit(repo, 'push', bare, `HEAD:${ref}`)
        expect(pushed.code).not.toBe(0)
        expect(pushed.stderr).toContain(`[qianmo handoff] refused ${ref}`)
      }
      expect(hubRefs()).toEqual(before)
    },
    STEP_TIMEOUT_MS,
  )

  test(
    "criterion 4 · the user's HEAD, index, stash, refs and files are byte-identical",
    () => {
      expect(userState()).toBe(userBefore)
      // What was added is only the anti-GC refs of ruling 8.
      const added = git(
        repo,
        'for-each-ref',
        '--format=%(refname)',
        'refs/qianmo/',
      )
      for (const ref of added.split('\n')) {
        expect(ref.startsWith(`refs/qianmo/local/${DEVICE}/`)).toBe(true)
      }
    },
    STEP_TIMEOUT_MS,
  )

  test(
    'criterion 7 · the canary from the environment is in no file and no git object',
    () => {
      const files: string[] = []
      const walk = (dir: string): void => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const path = join(dir, entry.name)
          if (entry.isDirectory()) walk(path)
          else if (entry.isFile()) files.push(path)
        }
      }
      walk(root)
      expect(files.length).toBeGreaterThan(50)
      const needle = Buffer.from(CANARY)
      const hits = files.filter(file => readFileSync(file).includes(needle))
      expect(hits).toEqual([])
      for (const dir of [bare, repo]) {
        const objects = Bun.spawnSync(
          ['git', 'cat-file', '--batch-all-objects', '--batch'],
          { cwd: dir, env: baseEnv(), stdout: 'pipe', stderr: 'pipe' },
        )
        expect(objects.exitCode).toBe(0)
        expect(objects.stdout.length).toBeGreaterThan(0)
        expect(objects.stdout.includes(needle)).toBe(false)
      }

      // The scan can see a canary when there is one.
      const control = join(laptopConfig, 'control.txt')
      appendFileSync(control, CANARY)
      expect(readFileSync(control).includes(needle)).toBe(true)
      rmSync(control)
    },
    STEP_TIMEOUT_MS,
  )

  test(
    'pull and attach (P17.6): a malformed command line is a usage error, exit 2',
    async () => {
      for (const [args, said] of [
        [['pull', 'a-1', 'b-2'], '只接受一个任务号'],
        [['attach', '../x'], '不是任务号'],
        [['attach', '--console', 'https://hub.invalid'], '要一起给'],
        [['attach', '--local-port', '70000'], '端口号'],
      ] as const) {
        const ran = await qm(['handoff', ...args])
        expect(ran.code).toBe(2)
        expect(ran.stderr).toContain(said)
        expect(ran.stderr).toStartWith(
          args[0] === 'pull' ? '接回没有完成：' : '接入没有完成：',
        )
      }
    },
    STEP_TIMEOUT_MS,
  )
})
