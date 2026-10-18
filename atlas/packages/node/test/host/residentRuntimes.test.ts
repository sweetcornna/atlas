// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, expect, test } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import {
  OmpResidentTurnPort,
  type ResidentTurnProgress,
} from '@qianmo/resident'
import {
  ExternalRuntimePool,
  type ExternalAgent,
  type ExternalRuntimeSpawn,
} from '../../src/host/runtimes/pool.js'
import type {
  AgentExtensions,
  AgentExtensionsSource,
} from '../../src/host/extensions.js'
import { claudeCodeArgv } from '../../src/host/runtimes/claudeCode.js'
import type { RuntimeDesktopSource } from '../../src/host/runtimes/desktopTools.js'
import { codexArgv } from '../../src/host/runtimes/codex.js'
import { parseResidentArgs } from '../../src/commands/resident.js'
import { isolatedRoot } from '../providers/fake.js'

const fixtures = join(import.meta.dir, 'fixtures')
const FAKE = {
  'claude-code': join(fixtures, 'fake-claude-code.runner.ts'),
  codex: join(fixtures, 'fake-codex.runner.ts'),
} as const

let root: ReturnType<typeof isolatedRoot> | undefined
const pools: ExternalRuntimePool[] = []
const children: ChildProcess[] = []
const launches: ExternalRuntimeSpawn[] = []
afterEach(async () => {
  for (const pool of pools.splice(0)) await pool.stop()
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill()
  }
  launches.length = 0
  if (root) rmSync(`${root.root}-workspace`, { recursive: true, force: true })
  root?.dispose()
  root = undefined
})

function setup(
  agentOptions: Partial<ExternalAgent> & Pick<ExternalAgent, 'runtime'>,
  options: {
    permission?: (call: {
      toolName: string
      input: Readonly<Record<string, unknown>>
    }) => boolean
    idleChildMs?: number
    allowWorkspaceEdits?: boolean
    extensions?: AgentExtensionsSource
    desktop?: RuntimeDesktopSource
    desktopArgv?: (args: readonly string[]) => string[]
  } = {},
) {
  root ??= isolatedRoot()
  // Outside the config root, which the posture protects as node state.
  const cwd = `${root.root}-workspace`
  mkdirSync(cwd, { recursive: true })
  writeFileSync(join(cwd, 'README.md'), 'hello\nworld\n')
  const agent: ExternalAgent = { agent: 'coder', cwd, ...agentOptions }
  const announced: Record<string, unknown>[] = []
  const asked: { toolName: string; input: unknown }[] = []
  const pool = new ExternalRuntimePool({
    agents: [agent],
    resolveLaunch: () => ({
      model: 'fake-model',
      baseUrl: 'http://127.0.0.1:9/v1',
      apiKey: 'sk-test-runtime',
    }),
    memoryRoot: join(root.root, 'memory'),
    allowWorkspaceEdits: options.allowWorkspaceEdits ?? false,
    hostTools: {
      announce: async params => {
        announced.push(params)
        return { status: 'sent' }
      },
    },
    requestPermission: async (_sessionId, call) => {
      asked.push(call)
      return options.permission?.(call) ?? false
    },
    ...(options.idleChildMs === undefined
      ? {}
      : { idleChildMs: options.idleChildMs }),
    ...(options.extensions === undefined
      ? {}
      : { extensions: options.extensions }),
    ...(options.desktop === undefined ? {} : { desktop: options.desktop }),
    ...(options.desktopArgv === undefined
      ? {}
      : { desktopArgv: options.desktopArgv }),
    spawn: input => {
      launches.push(input)
      const child = spawn(
        process.execPath,
        [FAKE[input.kind as keyof typeof FAKE], ...input.argv.slice(1)],
        { cwd: input.cwd, env: input.env, stdio: ['pipe', 'pipe', 'pipe'] },
      )
      children.push(child)
      return child
    },
  })
  pools.push(pool)
  return { pool, agent, announced, asked }
}

async function turn(
  pool: ExternalRuntimePool,
  sessionId: string,
  messageId: string,
  prompt: string,
  sink: {
    usage?: Record<string, number>[]
    progress?: ResidentTurnProgress[]
  } = {},
) {
  return new OmpResidentTurnPort(pool, {
    onUsage: (_input, usage) => sink.usage?.push({ ...usage }),
    onProgress: progress => sink.progress?.push(progress),
  }).execute(
    { sessionId, messageId, prompt, networkMsgId: `net-${messageId}` },
    async () => {},
  )
}

test('Claude Code: a warm process answers consecutive turns, reports tools and cache usage', async () => {
  const { pool, agent } = setup({ runtime: 'claude-code' })
  const session = await pool.newSession(agent)
  const usage: Record<string, number>[] = []
  const progress: ResidentTurnProgress[] = []
  const first = await turn(pool, session, 'm1', 'hello', { usage, progress })
  expect(first).toEqual({ outcome: 'completed', content: 'echo(1): hello' })
  const second = await turn(pool, session, 'm2', 'again')
  expect(second).toEqual({ outcome: 'completed', content: 'echo(2): again' })
  expect(launches).toHaveLength(1)
  expect(usage).toEqual([
    { input: 10, output: 5, cacheRead: 900, cacheWrite: 20 },
  ])
  expect(progress.map(step => step.summary)).toEqual(['读：README.md'])
  expect(await pool.isAccepted(session, 'm1')).toBe(true)
  expect(await pool.isAccepted(session, 'never')).toBe(false)
  const argv = launches[0]!.argv
  // Only the node-owned user settings, never the project's (P32 audit 2).
  expect(argv[argv.indexOf('--setting-sources') + 1]).toBe('user')
  expect(argv).not.toContain('--safe-mode')
  expect(argv).not.toContain('--bare')
  expect(argv).not.toContain('--plugin-dir')
  // The pin layer (P36.7): hooks off, every effectful tool and every MCP
  // tool asked, the gateway and an inert key helper over the agent's own
  // settings; the agent's own MCP servers load (no --strict-mcp-config).
  expect(JSON.parse(argv[argv.indexOf('--settings') + 1]!)).toEqual({
    disableAllHooks: true,
    permissions: {
      ask: [
        'Bash',
        'Edit',
        'Write',
        'MultiEdit',
        'NotebookEdit',
        'Read',
        'Grep',
        'Glob',
        'mcp__*',
      ],
    },
    env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:9/v1' },
    apiKeyHelper: '/usr/bin/true',
  })
  expect(argv).not.toContain('--strict-mcp-config')
  expect(launches[0]!.env.CLAUDE_CONFIG_DIR).toBe(
    join(root!.root, 'runtimes', 'claude-code', 'coder'),
  )
  expect(argv[argv.indexOf('--permission-prompt-tool') + 1]).toBe(
    'mcp__qianmo__qianmo_permission',
  )
  // Not Claude Code's own `auto` classifier (real-runtime smoke test).
  expect(argv[argv.indexOf('--permission-mode') + 1]).toBe('default')
  expect(argv[argv.indexOf('--model') + 1]).toBe('fake-model')
  expect(argv).toContain('--session-id')
  const denied = argv[argv.indexOf('--disallowedTools') + 1]!.split(',')
  expect(denied).toContain('Bash')
  expect(denied).toContain('Edit')
  expect(denied).toContain('WebFetch')
  const env = launches[0]!.env
  expect(env.ANTHROPIC_API_KEY).toBe('sk-test-runtime')
  expect(env.CLAUDE_CONFIG_DIR).toStartWith(root!.root)
  expect(env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe('1')
  // Host tools can wait for a person (`qianmo_ask`, up to 1800 s).
  expect(env.MCP_TOOL_TIMEOUT).toBe('1900000')
})

test('Claude Code: an idle-reaped session resumes the same conversation', async () => {
  const { pool, agent } = setup({ runtime: 'claude-code' }, { idleChildMs: 30 })
  const session = await pool.newSession(agent)
  expect((await turn(pool, session, 'a', 'one')).outcome).toBe('completed')
  const deadline = Date.now() + 3_000
  while (children[0]!.exitCode === null && children[0]!.signalCode === null) {
    if (Date.now() > deadline) throw new Error('process was not reaped')
    await Bun.sleep(10)
  }
  expect((await turn(pool, session, 'b', 'two')).outcome).toBe('completed')
  expect(launches).toHaveLength(2)
  const first = launches[0]!.argv
  const second = launches[1]!.argv
  const id = first[first.indexOf('--session-id') + 1]
  expect(second[second.indexOf('--resume') + 1]).toBe(id!)
  // The appended system prompt is frozen with the session.
  expect(second[second.indexOf('--append-system-prompt') + 1]).toBe(
    first[first.indexOf('--append-system-prompt') + 1]!,
  )
})

test('Claude Code: failures, token ceilings and aborts map onto turn results', async () => {
  const { pool, agent } = setup({ runtime: 'claude-code' })
  const session = await pool.newSession(agent)
  const failed = await turn(pool, session, 'f', 'fail')
  expect(failed.outcome).toBe('failed')
  if (failed.outcome === 'failed')
    expect(failed.reason).toBe('Model request failed: upstream exploded')
  const long = await turn(pool, session, 'l', 'long')
  expect(long.outcome).toBe('failed')
  const channel = await pool.channelFor(session)
  const port = new OmpResidentTurnPort(pool)
  const pending = port.execute(
    { sessionId: session, messageId: 'h', prompt: 'hang' },
    async () => {},
  )
  await Bun.sleep(50)
  await channel.abort()
  const aborted = await pending
  expect(aborted.outcome).toBe('failed')
  if (aborted.outcome === 'failed') expect(aborted.reason).toContain('aborted')
})

test('Codex: a thread is opened once, used for every turn and resumed after a restart', async () => {
  const { pool, agent } = setup({ runtime: 'codex' })
  const session = await pool.newSession(agent)
  const usage: Record<string, number>[] = []
  const progress: ResidentTurnProgress[] = []
  expect(await turn(pool, session, 'c1', 'hi', { usage, progress })).toEqual({
    outcome: 'completed',
    content: 'codex(1): hi',
  })
  expect(await turn(pool, session, 'c2', 'more', { usage })).toEqual({
    outcome: 'completed',
    content: 'codex(2): more',
  })
  expect(usage).toEqual([
    { input: 100, output: 10, cacheRead: 900, cacheWrite: 0 },
    { input: 0, output: 10, cacheRead: 1000, cacheWrite: 0 },
  ])
  expect(progress.map(step => step.summary)).toEqual(['执行：ls'])
  const record = JSON.parse(
    readFileSync(join(launches[0]!.sessionDir, 'runtime.json'), 'utf8'),
  ) as { nativeId: string }
  expect(record.nativeId).toStartWith('thread-')
  pool.closeSession(session)
  await Bun.sleep(50)
  expect(await turn(pool, session, 'c3', 'back')).toEqual({
    outcome: 'completed',
    content: 'codex(1): back',
  })
  const argv = launches[0]!.argv
  expect(argv).toContain('shell_tool')
  expect(argv.join(' ')).toContain('model_provider="qianmo"')
  // Plugins load (operator skills, P32 audit 1); what they bundle does not.
  const disabled = argv.flatMap((arg, at) =>
    arg === '--disable' ? [argv[at + 1]!] : [],
  )
  expect(disabled).not.toContain('plugins')
  for (const feature of [
    'apps',
    'remote_plugin',
    'hooks',
    'skill_mcp_dependency_install',
  ])
    expect(disabled).toContain(feature)
  const bridge = argv.find(arg => arg.startsWith('mcp_servers.qianmo='))
  expect(bridge).toContain('"default_tools_approval_mode" = "approve"')
  // Host tools can wait for a person (`qianmo_ask`, up to 1800 s).
  expect(bridge).toContain('"tool_timeout_sec" = 1900')
  expect(launches[0]!.env.QIANMO_RUNTIME_KEY).toBe('sk-test-runtime')
  expect(launches[0]!.env.CODEX_HOME).toStartWith(root!.root)
})

test('Codex: a stop while turn/start is still unanswered interrupts the turn once it has an id', async () => {
  const { pool, agent } = setup({ runtime: 'codex' })
  const session = await pool.newSession(agent)
  const channel = await pool.channelFor(session)
  const pending = new OmpResidentTurnPort(pool).execute(
    { sessionId: session, messageId: 'late', prompt: 'late' },
    async () => {},
  )
  await Bun.sleep(50)
  await channel.abort()
  const stopped = await pending
  expect(stopped.outcome).toBe('failed')
})

test('Codex: failed turns fail; an escalation outside the workspace goes to the operator', async () => {
  const { pool, agent, asked } = setup(
    { runtime: 'codex' },
    { allowWorkspaceEdits: true, permission: () => false },
  )
  const session = await pool.newSession(agent)
  const failed = await turn(pool, session, 'x', 'fail')
  expect(failed.outcome).toBe('failed')
  if (failed.outcome === 'failed')
    expect(failed.reason).toBe('Model request failed: model overloaded')
  const approved = await turn(pool, session, 'y', 'approve')
  expect(approved).toEqual({
    outcome: 'completed',
    content: 'codex(2): approve decision=decline',
  })
  expect(asked.map(call => call.toolName)).toEqual(['edit'])
})

test('Codex shell agents keep the shell and the sandbox decides', async () => {
  const { pool, agent } = setup({ runtime: 'codex', shell: true })
  const session = await pool.newSession(agent)
  expect((await turn(pool, session, 's', 'go')).outcome).toBe('completed')
  expect(launches[0]!.argv).not.toContain('shell_tool')
})

const DOCS: AgentExtensions = {
  ompPluginDirs: [],
  claudePluginDirs: ['/ext/agents/coder/plugins/qianmo'],
  mcp: [
    {
      name: 'docs',
      transport: 'stdio',
      command: 'docs-mcp',
      env: { DOCS_TOKEN: 'secret-value' },
      approval: 'allow',
      tools: [],
    },
    {
      name: 'crm',
      transport: 'http',
      url: 'https://crm.example/mcp',
      headers: { Authorization: 'Bearer t' },
      approval: 'ask',
      tools: [],
    },
  ],
  readableRoots: [],
}

test('Claude Code: operator extensions load through --plugin-dir and the MCP config, user settings only (P32)', async () => {
  const { pool, agent } = setup(
    { runtime: 'claude-code' },
    { extensions: name => (name === 'coder' ? DOCS : null) },
  )
  const session = await pool.newSession(agent)
  expect((await turn(pool, session, 'p', 'hello')).outcome).toBe('completed')
  const argv = launches[0]!.argv
  expect(argv[argv.indexOf('--setting-sources') + 1]).toBe('user')
  expect(argv).not.toContain('--bare')
  expect(argv).not.toContain('--safe-mode')
  expect(argv).not.toContain('--strict-mcp-config')
  expect(argv[argv.indexOf('--plugin-dir') + 1]).toBe(
    '/ext/agents/coder/plugins/qianmo',
  )
  const allowed = argv[argv.indexOf('--allowedTools') + 1]!.split(',')
  expect(allowed).toContain('Skill')
  // Connectors under the reserved prefix (P36.7).
  expect(allowed).toContain('mcp__qm-docs')
  expect(allowed).not.toContain('mcp__qm-crm')
  const config = JSON.parse(
    readFileSync(argv[argv.indexOf('--mcp-config') + 1]!, 'utf8'),
  ).mcpServers
  expect(Object.keys(config).sort()).toEqual(['qianmo', 'qm-crm', 'qm-docs'])
  expect(config['qm-docs']).toEqual({
    type: 'stdio',
    command: 'docs-mcp',
    args: [],
    env: {
      ANTHROPIC_API_KEY: '',
      ANTHROPIC_CUSTOM_HEADERS: '',
      DOCS_TOKEN: 'secret-value',
    },
  })
  expect(config['qm-crm']).toEqual({
    type: 'http',
    url: 'https://crm.example/mcp',
    headers: { Authorization: 'Bearer t' },
  })
  expect(config.qianmo.type).toBe('stdio')
})

test('invalidating an agent closes its idle process now and lets a running turn finish first (P32 audit 4)', async () => {
  const { pool, agent } = setup({ runtime: 'claude-code' })
  const busy = await pool.newSession(agent)
  const idle = await pool.newSession(agent)
  expect((await turn(pool, idle, 'i1', 'hello')).outcome).toBe('completed')
  const idleConfig = join(launches[0]!.sessionDir, 'runtime-mcp.json')
  expect(existsSync(idleConfig)).toBe(true)
  const running = turn(pool, busy, 'b1', 'slow')
  while (launches.length < 2) await Bun.sleep(5)
  await Bun.sleep(100)
  await pool.invalidateAgent(agent.agent)
  // The idle process is gone, and its MCP config (with secrets) with it.
  const exited = (child: ChildProcess) =>
    child.exitCode !== null || child.signalCode !== null
  expect(exited(children[0]!)).toBe(true)
  expect(existsSync(idleConfig)).toBe(false)
  // The turn in flight is not interrupted.
  expect(exited(children[1]!)).toBe(false)
  expect(await running).toEqual({
    outcome: 'completed',
    content: 'echo(1): slow',
  })
  const deadline = Date.now() + 3_000
  while (!exited(children[1]!) && Date.now() < deadline) await Bun.sleep(10)
  expect(exited(children[1]!)).toBe(true)
  // The next turn starts a new process, on the new configuration.
  expect((await turn(pool, busy, 'b2', 'again')).outcome).toBe('completed')
  expect(launches).toHaveLength(3)
  expect(launches[2]!.sessionId).toBe(busy)
})

test('a new pool removes MCP configs left by processes that are gone (P32 audit 12)', async () => {
  const { pool, agent } = setup({ runtime: 'claude-code' })
  const session = await pool.newSession(agent)
  expect((await turn(pool, session, 's1', 'hello')).outcome).toBe('completed')
  const file = join(launches[0]!.sessionDir, 'runtime-mcp.json')
  expect(existsSync(file)).toBe(true)
  // A pool that stops takes the file with it.
  await pool.stop()
  expect(existsSync(file)).toBe(false)
  // A crash leaves the file; the next generation's pool clears it.
  writeFileSync(file, '{"mcpServers":{}}')
  setup({ runtime: 'claude-code' })
  expect(existsSync(file)).toBe(false)
})

test('a Claude Code process that exits on its own leaves no MCP config behind', async () => {
  const { pool, agent } = setup({ runtime: 'claude-code' })
  const session = await pool.newSession(agent)
  expect((await turn(pool, session, 'e1', 'hello')).outcome).toBe('completed')
  const file = join(launches[0]!.sessionDir, 'runtime-mcp.json')
  expect(existsSync(file)).toBe(true)
  children[0]!.kill('SIGKILL')
  const deadline = Date.now() + 3_000
  while (existsSync(file) && Date.now() < deadline) await Bun.sleep(10)
  expect(existsSync(file)).toBe(false)
})

test('a stale process replaced at the start of a turn is reaped once idle', async () => {
  const { pool, agent } = setup({ runtime: 'claude-code' }, { idleChildMs: 50 })
  const session = await pool.newSession(agent)
  const stale = await pool.channelFor(session)
  // Busy when the agent is invalidated, then idle with no turn holding it
  // (a Codex turn/start that fails ends without a prompt_result): the next
  // turn replaces it.
  Object.defineProperty(stale, 'busy', { value: true, configurable: true })
  await pool.invalidateAgent(agent.agent)
  Reflect.deleteProperty(stale, 'busy')
  const fresh = await pool.channelFor(session)
  expect(fresh).not.toBe(stale)
  expect(launches).toHaveLength(2)
  const deadline = Date.now() + 3_000
  while (children[1]!.exitCode === null && children[1]!.signalCode === null) {
    if (Date.now() > deadline) throw new Error('replacement was not reaped')
    await Bun.sleep(10)
  }
})

/**
 * A stand-in for `qm desktop-exec`: answers every call with its pid and,
 * like the real one, exits once the host closes its stdin.
 */
const FAKE_DESKTOP_EXEC = `import { createInterface } from 'node:readline'
const send = message => process.stdout.write(JSON.stringify(message) + '\\n')
const lines = createInterface({ input: process.stdin })
lines.on('line', line => {
  const message = JSON.parse(line)
  if (message.type === 'call')
    send({ type: 'result', id: message.id, result: { content: [{ type: 'text', text: String(process.pid) }] } })
})
lines.on('close', () => process.exit(0))
send({ type: 'ready' })
`

test('a runtime process that exits on its own closes its session’s desktop executor', async () => {
  root ??= isolatedRoot()
  const script = join(root.root, 'fake-desktop-exec.ts')
  writeFileSync(script, FAKE_DESKTOP_EXEC)
  const downloads = join(root.root, 'desktop', 'downloads')
  mkdirSync(join(root.root, 'desktop', 'screenshots'), { recursive: true })
  const { pool, agent } = setup(
    { runtime: 'claude-code' },
    {
      desktop: {
        resource: () => ({
          resourceId: 'r-1',
          resourceEpoch: 1,
          browser: true,
          computer: false,
          cdpUrl: null,
          cdpToken: null,
          display: null,
          xauthority: null,
          downloads,
          tab: 'tab-1',
        }),
        resourcePath: () => join(root!.root, 'desktop', 'resource.json'),
      },
      desktopArgv: args => [process.execPath, script, ...args],
    },
  )
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }
  const session = await pool.newSession(agent)
  expect((await turn(pool, session, 'd1', 'hello')).outcome).toBe('completed')
  const first = mcpClient(bridgeOf(launches[0]!))
  await first.open()
  const tabs = await first.call('qianmo_browser_tabs', {})
  expect(tabs.isError).toBe(false)
  const executor = Number(tabs.text)
  expect(alive(executor)).toBe(true)
  children[0]!.kill('SIGKILL')
  const deadline = Date.now() + 3_000
  while (alive(executor) && Date.now() < deadline) await Bun.sleep(10)
  expect(alive(executor)).toBe(false)
  // The next process gets a new executor, with the resource as it is now.
  expect((await turn(pool, session, 'd2', 'again')).outcome).toBe('completed')
  const second = mcpClient(bridgeOf(launches[1]!))
  await second.open()
  const again = await second.call('qianmo_browser_tabs', {})
  expect(again.isError).toBe(false)
  expect(Number(again.text)).not.toBe(executor)
})

test('Codex: a tool call on an MCP server set to ask goes to the operator (P32)', async () => {
  const { pool, agent, asked } = setup(
    { runtime: 'codex' },
    {
      extensions: () => ({
        ...DOCS,
        mcp: [{ ...DOCS.mcp[0]!, approval: 'ask' }],
      }),
      permission: call => call.toolName === 'mcp__docs__search',
    },
  )
  const session = await pool.newSession(agent)
  expect(await turn(pool, session, 'q', 'mcp')).toEqual({
    outcome: 'completed',
    content: 'codex(1): mcp action=accept',
  })
  expect(asked.map(call => call.toolName)).toEqual(['mcp__docs__search'])
})

test('Codex: asked about one of the host’s own tools, the node accepts without asking anyone (P32 audit 14)', async () => {
  const { pool, agent, asked } = setup(
    { runtime: 'codex' },
    { permission: () => false },
  )
  const session = await pool.newSession(agent)
  expect(await turn(pool, session, 'h', 'mcp-host')).toEqual({
    outcome: 'completed',
    content: 'codex(1): mcp-host action=accept',
  })
  expect(asked).toEqual([])
})

test('Codex: an MCP elicitation for a connector nobody configured is declined', async () => {
  const { pool, agent, asked } = setup(
    { runtime: 'codex' },
    { permission: () => true },
  )
  const session = await pool.newSession(agent)
  expect(await turn(pool, session, 'r', 'mcp')).toEqual({
    outcome: 'completed',
    content: 'codex(1): mcp action=decline',
  })
  expect(asked).toEqual([])
})

test('Codex: a tool of a server the agent installed itself is the operator’s call (P36.7)', async () => {
  const { pool, agent, asked } = setup(
    { runtime: 'codex' },
    { permission: () => false },
  )
  const session = await pool.newSession(agent)
  expect(await turn(pool, session, 'n', 'mcp-native')).toEqual({
    outcome: 'completed',
    content: 'codex(1): mcp-native action=decline',
  })
  expect(asked.map(call => call.toolName)).toEqual(['mcp__docs__search'])
})

test('external runtime arguments are explicit and testable', () => {
  const claude = claudeCodeArgv({
    bin: 'claude',
    model: 'claude-sonnet-5-5',
    baseUrl: 'https://gw.example',
    sessionId: 'id',
    resume: false,
    systemPrompt: 'be brief',
    mcpConfigPath: '/x/mcp.json',
    allowWorkspaceEdits: true,
  })
  const denied = claude[claude.indexOf('--disallowedTools') + 1]!.split(',')
  expect(denied).toContain('Task')
  expect(denied).toContain('Bash')
  expect(denied).not.toContain('Edit')
  expect(claude).toContain('--exclude-dynamic-system-prompt-sections')
  const codex = codexArgv({
    bin: 'codex',
    model: 'gpt-6-luna',
    baseUrl: 'https://api.example/v1',
    keyEnv: 'K',
    headers: { 'X-Team': 'a"b' },
    workspace: '/w',
    mcp: { command: '/bin/qm', args: ['runtime-mcp', '--port', '1'] },
  })
  expect(codex).toContain(
    'model_providers.qianmo={ "name" = "qianmo", "base_url" = "https://api.example/v1", "env_key" = "K", "wire_api" = "responses", "http_headers" = { "X-Team" = "a\\"b" } }',
  )
})

test('resident flags pick a runtime and model per agent', () => {
  root = isolatedRoot()
  const config = parseResidentArgs([
    '--node=n',
    '--team=t',
    `--agent=main=${root.root}`,
    `--agent=coder=${root.root}`,
    `--agent=reviewer=${root.root}`,
    '--agent-runtime=coder=codex',
    '--agent-model=coder=luna/gpt-6-luna',
    '--agent-runtime',
    'reviewer=claude-code',
    '--agent-model',
    'reviewer=claude/claude-sonnet-5-5',
    '--agent-shell=coder',
    '--port=0',
    '--hostname=127.0.0.1',
  ])
  expect(config.agents.map(a => [a.agent, a.runtime, a.shell])).toEqual([
    ['main', undefined, undefined],
    ['coder', 'codex', true],
    ['reviewer', 'claude-code', undefined],
  ])
  expect(config.agentModels).toEqual([
    ['coder', 'luna/gpt-6-luna'],
    ['reviewer', 'claude/claude-sonnet-5-5'],
  ])
  const base = [
    '--node=n',
    '--team=t',
    `--agent=main=${root.root}`,
    '--port=0',
    '--hostname=127.0.0.1',
  ]
  // No --agent-model: the node's main model, else qianmopi meanwhile (P36).
  expect(
    parseResidentArgs([...base, '--agent-runtime=main=claude-code']).agents,
  ).toEqual([{ agent: 'main', cwd: root.root, runtime: 'claude-code' }])
  expect(() =>
    parseResidentArgs([
      ...base,
      '--agent-runtime=main=qianmopi',
      '--agent-shell=main',
    ]),
  ).toThrow('applies to agents on an external runtime')
  expect(() =>
    parseResidentArgs([...base, '--agent-runtime=main=gpt']),
  ).toThrow('--agent-runtime must be')
})

/** The `qm runtime-mcp` command line a runtime was told to start. */
function bridgeOf(launch: ExternalRuntimeSpawn): {
  command: string
  args: string[]
} {
  if (launch.kind === 'claude-code') {
    const config = JSON.parse(
      readFileSync(join(launch.sessionDir, 'runtime-mcp.json'), 'utf8'),
    ) as { mcpServers: Record<string, { command: string; args: string[] }> }
    return config.mcpServers.qianmo!
  }
  const value = launch.argv.find(arg => arg.startsWith('mcp_servers.qianmo='))!
  return {
    command: JSON.parse(/"command" = ("(?:[^"\\]|\\.)*")/.exec(value)![1]!),
    args: JSON.parse(/"args" = (\[.*\])/.exec(value)![1]!),
  }
}

/** Speaks MCP to the `qm runtime-mcp` command a runtime would start. */
function mcpClient(server: { command: string; args: string[] }) {
  const child = spawn(server.command, server.args, {
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  children.push(child)
  const waiting = new Map<number, (reply: Record<string, unknown>) => void>()
  let buffer = ''
  child.stdout!.on('data', (chunk: Buffer) => {
    buffer += chunk.toString()
    let index: number
    while ((index = buffer.indexOf('\n')) !== -1) {
      const reply = JSON.parse(buffer.slice(0, index)) as Record<
        string,
        unknown
      >
      buffer = buffer.slice(index + 1)
      waiting.get(reply.id as number)?.(reply)
    }
  })
  let sequence = 0
  const request = (method: string, params: Record<string, unknown> = {}) =>
    new Promise<Record<string, unknown>>(resolve => {
      const id = ++sequence
      waiting.set(id, resolve)
      child.stdin!.write(
        `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`,
      )
    })
  const call = async (name: string, args: Record<string, unknown>) => {
    const reply = await request('tools/call', { name, arguments: args })
    const result = reply.result as {
      content: { text: string }[]
      isError?: boolean
    }
    return { text: result.content[0]!.text, isError: result.isError === true }
  }
  return {
    async open() {
      await request('initialize', {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'runtime-test', version: '0' },
      })
      child.stdin!.write(
        `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
      )
    },
    request,
    call,
  }
}

test('runtime-mcp: the bridge lists host tools and applies the resident posture', async () => {
  const { pool, agent, announced, asked } = setup(
    { runtime: 'claude-code' },
    { permission: () => true },
  )
  const session = await pool.newSession(agent)
  await turn(pool, session, 'm-1', 'hello')
  const mcp = mcpClient(bridgeOf(launches[0]!))
  await mcp.open()

  const listed = await mcp.request('tools/list')
  const names = (listed.result as { tools: { name: string }[] }).tools.map(
    tool => tool.name,
  )
  expect(names).toContain('qianmo_notify')
  expect(names).toContain('qianmo_permission')
  // Claude Code reads with its native Read/Grep/Glob.
  expect(names).not.toContain('qianmo_read_file')
  expect(names).toEqual([...names].sort())

  const verdict = async (tool_name: string, input: Record<string, unknown>) =>
    JSON.parse(
      (await mcp.call('qianmo_permission', { tool_name, input })).text,
    ) as { behavior: string; message?: string }
  expect(
    await verdict('Read', { file_path: join(agent.cwd, 'README.md') }),
  ).toEqual({
    behavior: 'allow',
    updatedInput: { file_path: join(agent.cwd, 'README.md') },
  } as never)
  const outside = await verdict('Read', { file_path: '/etc/hosts' })
  expect(outside.behavior).toBe('deny')
  expect(outside.message).toContain('Qianmo resident posture')
  // Read-only node: a write is refused without asking anyone.
  expect(
    (await verdict('Write', { file_path: join(agent.cwd, 'x'), content: '' }))
      .behavior,
  ).toBe('deny')
  // No --agent-shell: the shell is refused without asking.
  expect((await verdict('Bash', { command: 'id' })).behavior).toBe('deny')
  expect((await verdict('TodoWrite', { todos: [] })).behavior).toBe('allow')
  // `permissions.ask: mcp__*` sends the bridge's own tools here; they pass.
  expect(
    (await verdict('mcp__qianmo__qianmo_notify', { summary: 'x' })).behavior,
  ).toBe('allow')
  // A connector nobody configured is refused by the posture.
  expect((await verdict('mcp__qm-docs__search', {})).behavior).toBe('deny')
  expect(asked).toEqual([])
  // A server the agent installed itself: the operator decides each call.
  expect((await verdict('mcp__usermcp__ping', { a: 1 })).behavior).toBe('allow')
  expect(asked).toEqual([{ toolName: 'mcp__usermcp__ping', input: { a: 1 } }])
  asked.length = 0

  const notified = await mcp.call('qianmo_notify', {
    verdict: 'notify',
    summary: 'done',
  })
  expect(announced.length + Number(notified.isError)).toBeGreaterThan(0)

  pool.closeSession(session)
  const revoked = await mcp.call('qianmo_notify', {
    verdict: 'notify',
    summary: 'late',
  })
  expect(revoked.isError).toBe(true)
  expect(revoked.text).toContain('revoked')
})

test('runtime-mcp: Codex without a shell reads the workspace through the host', async () => {
  const { pool, agent } = setup({ runtime: 'codex' })
  const session = await pool.newSession(agent)
  await turn(pool, session, 'm-1', 'hello')
  const mcp = mcpClient(bridgeOf(launches[0]!))
  await mcp.open()
  const listed = await mcp.request('tools/list')
  const names = (listed.result as { tools: { name: string }[] }).tools.map(
    tool => tool.name,
  )
  expect(names).toContain('qianmo_read_file')
  expect(names).not.toContain('qianmo_permission')
  const read = await mcp.call('qianmo_read_file', { path: 'README.md' })
  expect(read.isError).toBe(false)
  expect(read.text).toContain('hello')
  const found = await mcp.call('qianmo_search', { pattern: 'world' })
  expect(found.text).toContain('README.md')
  const escape = await mcp.call('qianmo_read_file', { path: '../../etc/hosts' })
  expect(escape.isError).toBe(true)
})

test('runtime-mcp: an edit outside the workspace goes to the operator on an editing node', async () => {
  const { pool, agent, asked } = setup(
    { runtime: 'claude-code' },
    { permission: () => true, allowWorkspaceEdits: true },
  )
  const session = await pool.newSession(agent)
  await turn(pool, session, 'm-1', 'hello')
  const mcp = mcpClient(bridgeOf(launches[0]!))
  await mcp.open()
  const decide = async (input: Record<string, unknown>) =>
    JSON.parse(
      (await mcp.call('qianmo_permission', { tool_name: 'Edit', input })).text,
    ) as { behavior: string }
  expect(
    (await decide({ file_path: join(agent.cwd, 'README.md') })).behavior,
  ).toBe('allow')
  expect(asked).toEqual([])
  const outsideFile = `${root!.root}-elsewhere.txt`
  expect((await decide({ file_path: outsideFile })).behavior).toBe('allow')
  expect(asked.map(call => call.toolName)).toEqual(['edit'])
  // Hooks and configuration a later run would load stay off limits.
  expect(
    (await decide({ file_path: join(agent.cwd, '.claude', 'settings.json') }))
      .behavior,
  ).toBe('deny')
})
