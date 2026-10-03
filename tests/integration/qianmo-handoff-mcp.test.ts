// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `qm handoff mcp` end to end: the handoff tools over real stdio, against a
 * real hub on loopback (P17.3 本仓库 完成标准).
 *
 * ## What is real
 *
 * Every MCP server is its own `qm handoff mcp` process from source (shipped
 * defines and features), spoken to in newline-delimited JSON-RPC on its
 * stdin and stdout, the way qmcode and Claude Code start it. The hub is
 * `qm console --handoff-root` with a local bare repository; the hooks that
 * record sessions are `qm handoff sync --hook …` processes; git is real git.
 *
 * ## What is made up
 *
 * The transcripts (`support/handoffSamples.ts`), in the shapes the fork and
 * the base write them, and the `_meta.threadId` qmcode puts on every tool
 * call (`codex-rs/core/src/mcp_tool_call.rs`). No model is called.
 *
 * ## The completion criteria
 *
 * 1. `initialize` answers; `tools/list` is exactly the tools this package
 *    delivers, every name `qianmo_`-prefixed.
 * 2. Three servers at once each answer `tools/list` and `qianmo_status`; two
 *    `qianmo_handoff` calls at once: one lands, the other is told another is
 *    in progress, and the hub and the repository agree.
 * 3. Called inside a turn that has not ended: no hang, and the running turn
 *    is not handed over — a qmcode rollout and a Claude Code transcript.
 * 4. A key in the server's environment is in no answer, no stderr, not in
 *    `sessions.json`, not in the hub's manifests, in no file and no object.
 * 5. Without `OCC_IDENTITY=qianmo`, refused like every `qm handoff` command.
 * 6. From a subdirectory, the repository's latest session; with none
 *    recorded, a reason and the server still serving.
 * 7. stdin closed: the process exits — after finishing a call in flight —
 *    and leaves no child behind.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createHash, randomBytes } from 'node:crypto'
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Subprocess } from 'bun'
import {
  claudeCodeHookInput,
  claudeCodeMidTurnTranscript,
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
const IN_PROGRESS = '另一份转交正在进行'
const DEVICE = 'laptop'
const THREAD = '0199a4c2-7c1e-7d32-9a5e-3b1f2c4d5e6f'
const TURN_1 = '0199a4c2-8000-7000-8000-000000000001'
/** The model turn that calls `qianmo_handoff`; never ends during the suite. */
const TURN_CALLING = '0199a4c2-8000-7000-8000-0000000000c1'
const CC_SESSION = '7d8c2a10-3c55-4b2e-9a51-0f6c1d2e3a4b'
/** In the environment of every server; must end up nowhere. */
const CANARY = `sk-test-canary-${randomBytes(12).toString('hex')}`
const TOOLS = ['qianmo_status', 'qianmo_handoff', 'qianmo_task']

const BOOT_TIMEOUT_MS = 90_000
const STEP_TIMEOUT_MS = 120_000
/** A call that hangs instead of answering fails here, not at the suite timeout. */
const CALL_TIMEOUT_MS = 60_000

let root = ''
let repo = ''
let other = ''
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
let hub: RunningConsole | undefined

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

/**
 * The laptop, as Claude Code starts its servers — its whole environment,
 * model key included — plus the throwaway roots.
 */
function laptopEnv(): Record<string, string> {
  return {
    ...baseEnv(),
    OCC_CONFIG_DIR: laptopConfig,
    QMCODE_HOME: qmHome,
    OPENAI_API_KEY: CANARY,
    QIANMO_E2E_CANARY: CANARY,
  }
}

interface Ran {
  readonly code: number | null
  readonly stdout: string
  readonly stderr: string
}

/** One `qm` command (init, a hook) to completion. */
async function qm(
  args: readonly string[],
  options: { cwd?: string; stdin?: string; env?: Record<string, string> } = {},
): Promise<Ran> {
  const proc = Bun.spawn([process.execPath, ...cliPrefix(), ...args], {
    cwd: options.cwd ?? repo,
    env: options.env ?? laptopEnv(),
    stdin: options.stdin === undefined ? 'ignore' : new Blob([options.stdin]),
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
      'user.name=Handoff MCP E2E',
      '-c',
      'user.email=handoff-mcp-e2e@qianmo.invalid',
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

function refsOf(dir: string, prefix: string): Map<string, string> {
  const out = new Map<string, string>()
  const listed = git(dir, 'for-each-ref', '--format=%(refname) %(objectname)')
  for (const line of listed.split('\n').filter(Boolean)) {
    const [ref, sha] = line.split(' ')
    if (ref?.startsWith(prefix) === true && sha !== undefined) {
      out.set(ref, sha)
    }
  }
  return out
}

const hubRefs = (): Map<string, string> => refsOf(bare, 'refs/qianmo/')

async function hubGet(path: string): Promise<Record<string, unknown>> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    headers: {
      authorization: `Bearer ${adminToken}`,
      accept: 'application/json',
    },
  })
  expect(response.status).toBe(200)
  return (await response.json()) as Record<string, unknown>
}

async function hubTasks(): Promise<Record<string, unknown>[]> {
  return (await hubGet('/v0/handoff')).tasks as Record<string, unknown>[]
}

/** The repository's sync lock, as a hook in the middle of a push holds it. */
function syncLockPath(of: string): string {
  const key = createHash('sha256').update(of).digest('hex').slice(0, 16)
  return join(laptopConfig, 'qianmo', 'handoff', 'state', key, 'sync.lock')
}

function holdSyncLock(of: string): () => void {
  const path = syncLockPath(of)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${process.pid}\n`, { mode: 0o600 })
  return () => rmSync(path, { force: true })
}

// ─── An MCP client over the server's stdio ──────────────────────────

interface Message {
  readonly id?: number
  readonly result?: Record<string, unknown>
  readonly error?: { readonly code: number; readonly message: string }
}

interface ToolAnswer {
  readonly text: string
  readonly isError: boolean
}

/** Every line any server wrote, and every stderr: criterion 4 reads them all. */
const wire: string[] = []

class McpServerProcess {
  readonly proc: Subprocess<'pipe', 'pipe', 'pipe'>
  private nextId = 1
  private readonly waiting = new Map<number, (message: Message) => void>()
  private errText = ''
  readonly stdoutDone: Promise<void>

  constructor(cwd: string, env: Record<string, string> = laptopEnv()) {
    this.proc = Bun.spawn(
      [process.execPath, ...cliPrefix(), 'handoff', 'mcp'],
      { cwd, env, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
    )
    this.stdoutDone = this.readLines()
    void new Response(this.proc.stderr).text().then(text => {
      this.errText = text
      wire.push(text)
    })
  }

  private async readLines(): Promise<void> {
    const decoder = new TextDecoder()
    let buffer = ''
    for await (const chunk of this.proc.stdout) {
      buffer += decoder.decode(chunk, { stream: true })
      for (;;) {
        const newline = buffer.indexOf('\n')
        if (newline === -1) break
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        if (line.trim() === '') continue
        wire.push(line)
        const message = JSON.parse(line) as Message
        if (message.id !== undefined) {
          this.waiting.get(message.id)?.(message)
          this.waiting.delete(message.id)
        }
      }
    }
  }

  private send(message: Record<string, unknown>): void {
    this.proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
    this.proc.stdin.flush()
  }

  request(method: string, params?: Record<string, unknown>): Promise<Message> {
    const id = this.nextId++
    const answered = new Promise<Message>((done, fail) => {
      const timer = setTimeout(
        () =>
          fail(new Error(`${method} not answered in ${CALL_TIMEOUT_MS} ms`)),
        CALL_TIMEOUT_MS,
      )
      this.waiting.set(id, message => {
        clearTimeout(timer)
        done(message)
      })
    })
    this.send({ id, method, ...(params === undefined ? {} : { params }) })
    return answered
  }

  async initialize(): Promise<Message> {
    const answer = await this.request('initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'qianmo-handoff-mcp-e2e', version: '0' },
    })
    this.send({ method: 'notifications/initialized' })
    return answer
  }

  async toolNames(): Promise<string[]> {
    const answer = await this.request('tools/list')
    return ((answer.result?.tools ?? []) as { name: string }[]).map(
      tool => tool.name,
    )
  }

  async call(
    name: string,
    args: Record<string, unknown> = {},
    meta?: Record<string, unknown>,
  ): Promise<ToolAnswer> {
    const answer = await this.request('tools/call', {
      name,
      arguments: args,
      ...(meta === undefined ? {} : { _meta: meta }),
    })
    expect(answer.error).toBeUndefined()
    const content = (answer.result?.content ?? []) as { text?: string }[]
    return {
      text: content.map(block => block.text ?? '').join('\n'),
      isError: answer.result?.isError === true,
    }
  }

  stderr(): string {
    return this.errText
  }

  closeStdin(): void {
    this.proc.stdin.end()
  }

  async stop(): Promise<number | null> {
    this.closeStdin()
    const killer = setTimeout(() => this.proc.kill('SIGKILL'), 45_000)
    const code = await this.proc.exited
    clearTimeout(killer)
    return code
  }
}

const servers: McpServerProcess[] = []

async function started(
  cwd: string,
  env?: Record<string, string>,
): Promise<McpServerProcess> {
  const server = new McpServerProcess(cwd, env)
  servers.push(server)
  await server.initialize()
  return server
}

// ─── Fixture ─────────────────────────────────────────────────────────

const turns: QmcodeTurn[] = [
  { turnId: TURN_1, user: '把 a.txt 读出来', assistant: 'one' },
]

function writeRollout(): void {
  const file = qmcodeRolloutPath(qmHome, THREAD)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, qmcodeRollout(THREAD, repo, turns))
}

const ccFile = (): string => join(ccDir, `${CC_SESSION}.jsonl`)

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'qianmo-handoff-mcp-e2e-'))
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

  repo = join(root, 'work', 'atlas')
  mkdirSync(join(repo, 'packages', 'deep'), { recursive: true })
  mkdirSync(join(repo, 'docs'))
  git(repo, 'init', '-q', '-b', 'main')
  writeFileSync(join(repo, 'a.txt'), 'one\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'one')
  writeFileSync(join(repo, 'a.txt'), 'edited, not committed\n')
  writeFileSync(join(repo, 'new.txt'), 'untracked\n')
  repo = git(repo, 'rev-parse', '--show-toplevel')
  bare = join(hubRoot, 'atlas.git')

  // A second registered repository nothing ever reported a session from.
  other = join(root, 'work', 'lonely')
  mkdirSync(other, { recursive: true })
  git(other, 'init', '-q', '-b', 'main')
  writeFileSync(join(other, 'x.txt'), 'x\n')
  git(other, 'add', '-A')
  git(other, 'commit', '-q', '-m', 'x')
  other = git(other, 'rev-parse', '--show-toplevel')

  adminToken = `qm-e2e-admin-${randomBytes(16).toString('hex')}`
  adminTokenFile = join(root, 'admin.token')
  viewTokenFile = join(root, 'view.token')
  writeFileSync(adminTokenFile, `${adminToken}\n`, { mode: 0o600 })
  writeFileSync(
    viewTokenFile,
    `qm-e2e-view-${randomBytes(16).toString('hex')}\n`,
    { mode: 0o600 },
  )
  port = await freePort()
  hub = startHandoffConsole({
    port,
    handoffRoot: hubRoot,
    adminTokenFile,
    viewTokenFile,
    cwd: root,
    env: { ...baseEnv(), OCC_CONFIG_DIR: hubConfig },
  })
  await waitForConsole(hub, port, BOOT_TIMEOUT_MS)

  for (const [dir, project] of [
    [repo, 'atlas'],
    [other, 'lonely'],
  ] as const) {
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
        '--project',
        project,
        '--token-file',
        adminTokenFile,
      ],
      { cwd: dir },
    )
    expect(init.stderr).toBe('')
    expect(init.code).toBe(0)
  }

  // qmcode finished turn 1 in the repository root: notify records the
  // session and pushes it.
  writeRollout()
  const hook = await qm([
    'handoff',
    'sync',
    '--hook',
    'qmcode',
    qmcodeNotify(THREAD, TURN_1, repo),
  ])
  expect(hook).toEqual({ code: 0, stdout: '', stderr: '' })
  expect(hubRefs().has(`refs/qianmo/sessions/${DEVICE}/${THREAD}`)).toBe(true)
}, BOOT_TIMEOUT_MS * 2)

afterAll(async () => {
  for (const server of servers) server.proc.kill('SIGKILL')
  if (hub !== undefined) await stopConsole(hub)
  if (root !== '') rmSync(root, { recursive: true, force: true })
})

describe('qm handoff mcp end to end', () => {
  test(
    'criterion 1 · initialize answers; tools/list is exactly the qianmo_ tools this package delivers',
    async () => {
      const server = new McpServerProcess(repo)
      servers.push(server)
      const init = await server.initialize()
      expect(init.error).toBeUndefined()
      expect(init.result).toMatchObject({
        protocolVersion: '2025-11-25',
        capabilities: { tools: {} },
        serverInfo: { name: 'qianmo-handoff' },
      })

      const listed = await server.request('tools/list')
      const tools = (listed.result?.tools ?? []) as Record<string, unknown>[]
      expect(tools.map(tool => tool.name)).toEqual(TOOLS)
      for (const tool of tools) {
        expect(String(tool.name).startsWith('qianmo_')).toBe(true)
        expect(String(tool.description)).not.toBe('')
      }
      const byName = new Map(tools.map(tool => [tool.name, tool]))
      // The one tool with a side effect says so, and is not marked read-only.
      const handoff = byName.get('qianmo_handoff') ?? {}
      expect(String(handoff.description)).toContain('有副作用')
      expect(String(handoff.description)).toContain('推送到中枢')
      expect(handoff.annotations).toMatchObject({ readOnlyHint: false })
      expect(handoff.inputSchema).toMatchObject({
        required: ['goal', 'done', 'remaining'],
      })
      for (const name of ['qianmo_status', 'qianmo_task']) {
        expect(byName.get(name)?.annotations).toMatchObject({
          readOnlyHint: true,
        })
      }
    },
    STEP_TIMEOUT_MS,
  )

  test(
    'criterion 2 + 6 · three servers at once each list the tools and answer status, from a subdirectory too',
    async () => {
      const cwds = [repo, join(repo, 'packages', 'deep'), repo]
      const three = await Promise.all(cwds.map(cwd => started(cwd)))
      const answers = await Promise.all(
        three.map(async server => ({
          names: await server.toolNames(),
          status: await server.call('qianmo_status'),
        })),
      )
      for (const { names, status } of answers) {
        expect(names).toEqual(TOOLS)
        expect(status.isError).toBe(false)
        expect(status.text).toContain(`仓库    ${repo}`)
        expect(status.text).toContain(`会话    qmcode ${THREAD}`)
        expect(status.text).toContain('任务    （没有）')
      }
    },
    STEP_TIMEOUT_MS,
  )

  test(
    'criterion 3 · qmcode: called inside the model turn — no hang, the running turn is not handed over',
    async () => {
      turns.push({
        turnId: TURN_CALLING,
        user: '剩下的交给云端',
        assistant: '',
        ending: 'calling',
      })
      writeRollout()
      // From a subdirectory, the thread named the way qmcode names it.
      const server = await started(join(repo, 'packages', 'deep'))
      const began = Date.now()
      const answer = await server.call(
        'qianmo_handoff',
        { goal: '把 a.txt 收尾', done: '读过 a.txt', remaining: '改完并提交' },
        { threadId: THREAD, sessionId: THREAD },
      )
      expect(answer.isError).toBe(false)
      expect(Date.now() - began).toBeLessThan(CALL_TIMEOUT_MS)
      const lines = answer.text.split('\n')
      expect(lines[0]).toBe(SAFE)
      expect(answer.text).toContain(
        `截至  回合 ${TURN_CALLING} 开始之前；这个回合还在进行`,
      )
      const taskId = /任务\s+(\S+)/.exec(answer.text)?.[1] ?? ''
      const { task } = (await hubGet(`/v0/handoff/${taskId}`)) as {
        task: { state: string; manifest: Record<string, unknown> }
      }
      expect(task.state).toBe('accepted')
      expect(task.manifest).toMatchObject({
        tool: 'qmcode',
        sessionId: THREAD,
        brief: {
          goal: '把 a.txt 收尾',
          done: '读过 a.txt',
          remaining: '改完并提交',
        },
      })
      const name = qmcodeRolloutPath(qmHome, THREAD).split('/').at(-1) ?? ''
      const stored = git(
        bare,
        'show',
        `${String(task.manifest.sessionCommit)}:${name}`,
      )
      expect(stored).toContain(TURN_1)
      expect(stored).not.toContain(TURN_CALLING)
      expect(`${stored}\n`).toBe(qmcodeRollout(THREAD, repo, turns.slice(0, 1)))
    },
    STEP_TIMEOUT_MS,
  )

  test(
    'criterion 3 · Claude Code: called inside a turn — the transcript is cut after the last complete turn',
    async () => {
      const docs = join(repo, 'docs')
      // The Stop hook of the last complete turn recorded the session for docs/.
      writeFileSync(
        ccFile(),
        claudeCodeTranscript(CC_SESSION, docs, 'complete'),
      )
      const hook = await qm(['handoff', 'sync', '--hook', 'claude-code'], {
        stdin: claudeCodeHookInput(CC_SESSION, ccFile(), docs),
      })
      expect(hook).toEqual({ code: 0, stdout: '', stderr: '' })
      // Now the model is inside the next turn and has called the tool.
      const { text, complete, running } = claudeCodeMidTurnTranscript(
        CC_SESSION,
        docs,
      )
      writeFileSync(ccFile(), text)

      const server = await started(docs)
      const answer = await server.call('qianmo_handoff', {
        goal: '把文档补完',
        done: '',
        remaining: '写完 docs/',
      })
      expect(answer.isError).toBe(false)
      expect(answer.text.split('\n')[0]).toBe(SAFE)
      expect(answer.text).toContain(
        '截至  最后一个完整回合；其后 4 行属于进行中的回合，未转交',
      )
      const taskId = /任务\s+(\S+)/.exec(answer.text)?.[1] ?? ''
      const { task } = (await hubGet(`/v0/handoff/${taskId}`)) as {
        task: { manifest: Record<string, unknown> }
      }
      expect(task.manifest).toMatchObject({
        tool: 'claude-code',
        sessionId: CC_SESSION,
      })
      const stored = git(
        bare,
        'show',
        `${String(task.manifest.sessionCommit)}:${CC_SESSION}.jsonl`,
      )
      expect(stored).not.toContain(running)
      expect(`${stored}\n`).toBe(complete)
    },
    STEP_TIMEOUT_MS,
  )

  test(
    'criterion 2 · two handoffs at once: one lands, the other is told one is in progress; hub and repository agree',
    async () => {
      const [first, second] = await Promise.all([started(repo), started(repo)])
      const tasksBefore = (await hubTasks()).length
      const refsBefore = hubRefs()
      // A hook mid-push holds the sync lock: the handoff that gets the
      // handoff lock waits behind it, so the two calls surely overlap.
      const release = holdSyncLock(repo)
      let released = false
      try {
        const brief = { goal: '并发', done: '', remaining: '' }
        const meta = { threadId: THREAD }
        const calls = [
          first.call('qianmo_handoff', brief, meta),
          second.call('qianmo_handoff', brief, meta),
        ]
        const refused = await Promise.race(calls)
        expect(refused.isError).toBe(true)
        expect(refused.text).toMatch(
          new RegExp(
            `^转交没有完成：${IN_PROGRESS}（pid \\d+）：等它结束再试$`,
          ),
        )
        // Nothing moved while the second was refused.
        expect(hubRefs()).toEqual(refsBefore)
        release()
        released = true
        const [a, b] = await Promise.all(calls)
        const landed = [a, b].filter(answer => !answer.isError)
        expect(landed).toHaveLength(1)
        expect(landed[0]?.text.split('\n')[0]).toBe(SAFE)
        expect(
          [a, b].filter(answer => answer.text.includes(IN_PROGRESS)),
        ).toHaveLength(1)

        // One task more on the hub, and it names the refs the hub and the
        // laptop's anti-GC refs both hold.
        const tasks = await hubTasks()
        expect(tasks).toHaveLength(tasksBefore + 1)
        const taskId = /任务\s+(\S+)/.exec(landed[0]?.text ?? '')?.[1]
        const task = tasks.find(t => t.taskId === taskId) as {
          manifest: { wip: string; sessionCommit: string; tree: string }
        }
        const refs = hubRefs()
        expect(refs.get(`refs/qianmo/wip/${DEVICE}/main`)).toBe(
          task.manifest.wip,
        )
        expect(refs.get(`refs/qianmo/sessions/${DEVICE}/${THREAD}`)).toBe(
          task.manifest.sessionCommit,
        )
        const local = refsOf(repo, 'refs/qianmo/local/')
        expect(local.get(`refs/qianmo/local/${DEVICE}/wip/main`)).toBe(
          task.manifest.wip,
        )
        expect(
          local.get(`refs/qianmo/local/${DEVICE}/sessions/${THREAD}`),
        ).toBe(task.manifest.sessionCommit)
        expect(git(bare, 'rev-parse', `${task.manifest.wip}^{tree}`)).toBe(
          task.manifest.tree,
        )
        // The handoff lock is gone with its holder.
        const state = dirname(syncLockPath(repo))
        expect(readdirSync(state)).not.toContain('now.lock')
      } finally {
        if (!released) release()
      }
    },
    STEP_TIMEOUT_MS,
  )

  test(
    'qianmo_task: the latest task of this project, and one by id',
    async () => {
      const server = await started(repo)
      const latest = await server.call('qianmo_task')
      expect(latest.isError).toBe(false)
      expect(latest.text).toContain('状态    accepted')
      expect(latest.text).toContain('目标    并发')
      expect(latest.text).toContain('结果    （还没有：云端回合结束后才有）')
      const first = (await hubTasks())[0] as { taskId: string }
      const byId = await server.call('qianmo_task', { taskId: first.taskId })
      expect(byId.text).toContain(`任务    ${first.taskId}`)
      expect(byId.text).toContain('目标    把 a.txt 收尾')
      const missing = await server.call('qianmo_task', { taskId: 'nope-1' })
      expect(missing.isError).toBe(true)
      expect(missing.text).toContain('查询没有完成：查不了任务 nope-1')
      const bad = await server.call('qianmo_task', { taskId: '../x' })
      expect(bad).toEqual({
        isError: true,
        text: '查询没有完成：参数 taskId 不是任务号',
      })
    },
    STEP_TIMEOUT_MS,
  )

  test(
    'criterion 6 · no session recorded for the repository: a reason, and the server keeps serving',
    async () => {
      const server = await started(other)
      const before = await hubTasks()
      const status = await server.call('qianmo_status')
      expect(status.isError).toBe(false)
      expect(status.text).toContain('会话    （还没有 hook 报过）')
      const answer = await server.call('qianmo_handoff', {
        goal: 'g',
        done: '',
        remaining: '',
      })
      expect(answer).toEqual({
        isError: true,
        text: '转交没有完成：找不到这个目录的会话记录：先在 qmcode 或 Claude Code 里跑完一个回合（hook 会记下会话）',
      })
      expect(await hubTasks()).toEqual(before)
      // Bad arguments are refused before anything happens.
      const noGoal = await server.call('qianmo_handoff', {
        goal: ' ',
        done: '',
        remaining: '',
      })
      expect(noGoal.text).toBe('转交没有完成：参数 goal 不能为空')
      const badDeadline = await server.call('qianmo_handoff', {
        goal: 'g',
        done: '',
        remaining: '',
        deadline: 'tomorrow',
      })
      expect(badDeadline.text).toContain('参数 deadline 要写成 UTC 时间')
      expect(await server.toolNames()).toEqual(TOOLS)
      expect(server.proc.exitCode).toBeNull()
    },
    STEP_TIMEOUT_MS,
  )

  test(
    'criterion 5 · without OCC_IDENTITY=qianmo: refused with output and a non-zero exit, like the other subcommands',
    async () => {
      const env = laptopEnv()
      delete env.OCC_IDENTITY
      const refusal = 'handoff 需要 OCC_IDENTITY=qianmo（或用 qm 运行）'
      // stdin left open, the way a client starts a server: it must not wait.
      const proc = Bun.spawn(
        [process.execPath, ...cliPrefix(), 'handoff', 'mcp'],
        { cwd: repo, env, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
      )
      const killer = setTimeout(() => proc.kill('SIGKILL'), 60_000)
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ])
      clearTimeout(killer)
      proc.stdin.end()
      wire.push(stdout, stderr)
      expect(proc.signalCode).toBeNull()
      expect(stdout).toBe('')
      expect(stderr).toBe(`转交没有完成：${refusal}\n`)
      const status = await qm(['handoff', 'status'], { env })
      expect(status.code).toBe(code)
      expect(code).not.toBe(0)
      expect(status.stderr).toBe(stderr)
    },
    STEP_TIMEOUT_MS,
  )

  test(
    'criterion 7 · stdin closed: an idle server exits 0; one with a call in flight answers it first; no child is left',
    async () => {
      const idle = await started(repo)
      expect(await idle.toolNames()).toEqual(TOOLS)
      const idleExit = await idle.stop()
      expect(idleExit).toBe(0)

      const busy = await started(repo)
      const release = holdSyncLock(repo)
      let answer: ToolAnswer | undefined
      try {
        const pending = busy.call(
          'qianmo_handoff',
          { goal: '关机前最后一次', done: '', remaining: '' },
          { threadId: THREAD },
        )
        // The call is in, waiting behind the sync lock; the client goes away.
        await Bun.sleep(1_000)
        busy.closeStdin()
        await Bun.sleep(300)
        expect(busy.proc.exitCode).toBeNull()
        release()
        answer = await pending
      } finally {
        release()
      }
      expect(answer?.isError).toBe(false)
      expect(answer?.text.split('\n')[0]).toBe(SAFE)
      expect(await busy.stop()).toBe(0)
      await busy.stdoutDone

      // Every git this suite's servers started ran in, or pushed to, a
      // directory under the suite's root; the hub console is the only process
      // still named after it.
      const ps = Bun.spawnSync(['ps', '-axww', '-o', 'pid=,command=']).stdout
      const left = ps
        .toString()
        .split('\n')
        .filter(line => line.includes(root))
        .filter(line => !line.trim().startsWith(`${hub?.child.pid} `))
      expect(left).toEqual([])
    },
    STEP_TIMEOUT_MS,
  )

  test(
    'criterion 4 · the key in the servers’ environment is in no answer, no stderr, no state file, no manifest, no object',
    async () => {
      for (const server of servers) {
        if (server.proc.exitCode === null) await server.stop()
        await server.stdoutDone
      }
      // stderr is collected asynchronously; give the last ones a moment.
      await Bun.sleep(200)
      expect(wire.length).toBeGreaterThan(20)
      const needle = Buffer.from(CANARY)
      expect(wire.filter(text => text.includes(CANARY))).toEqual([])

      const sessions = readFileSync(
        join(laptopConfig, 'qianmo', 'handoff', 'sessions.json'),
      )
      expect(sessions.includes(needle)).toBe(false)
      expect(sessions.toString()).toContain(THREAD)
      const manifests = JSON.stringify(await hubTasks())
      expect(manifests).not.toContain(CANARY)
      expect(manifests).toContain(THREAD)

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
      expect(files.filter(file => readFileSync(file).includes(needle))).toEqual(
        [],
      )
      for (const dir of [bare, repo]) {
        const objects = Bun.spawnSync(
          ['git', 'cat-file', '--batch-all-objects', '--batch'],
          { cwd: dir, env: baseEnv(), stdout: 'pipe', stderr: 'pipe' },
        )
        expect(objects.exitCode).toBe(0)
        expect(objects.stdout.length).toBeGreaterThan(0)
        expect(objects.stdout.includes(needle)).toBe(false)
      }
      // The scan sees a canary when there is one.
      const control = join(laptopConfig, 'control.txt')
      writeFileSync(control, CANARY)
      expect(readFileSync(control).includes(needle)).toBe(true)
      rmSync(control)
    },
    STEP_TIMEOUT_MS,
  )
})
