// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, expect, test } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { qianmoConfigPath } from '@qianmo/paths'
import {
  OmpResidentTurnPort,
  type OmpRpcFrame,
  type ResidentTurnProgress,
  type ResidentTurnResult,
} from '@qianmo/resident'
import type {
  AgentExtensions,
  AgentExtensionsSource,
} from '../../src/host/extensions.js'
import {
  AcpChannel,
  AcpRpcError,
  acpSessionGone,
} from '../../src/host/runtimes/acp.js'
import {
  ExternalRuntimePool,
  type ExternalAgent,
  type ExternalLaunch,
  type ExternalRuntimeSpawn,
} from '../../src/host/runtimes/pool.js'
import { isolatedRoot } from '../providers/fake.js'

const fixtures = join(import.meta.dir, 'fixtures')
const FAKE: Record<string, string> = {
  dsh: join(fixtures, 'fake-acp.runner.ts'),
  'claude-code': join(fixtures, 'fake-claude-code.runner.ts'),
}

let root: ReturnType<typeof isolatedRoot> | undefined
const pools: ExternalRuntimePool[] = []
const children: ChildProcess[] = []
const launches: ExternalRuntimeSpawn[] = []
/** Process starts and turn ends, in order. */
const events: string[] = []
afterEach(async () => {
  for (const pool of pools.splice(0)) await pool.stop()
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill()
  }
  launches.length = 0
  events.length = 0
  if (root) {
    rmSync(`${root.root}-workspace`, { recursive: true, force: true })
    rmSync(`${root.root}-outside.txt`, { force: true })
  }
  root?.dispose()
  root = undefined
})

interface Logged {
  readonly event: string
  readonly method?: string
  readonly params?: Record<string, unknown>
  readonly [key: string]: unknown
}

function setup(
  agentOptions: Partial<ExternalAgent> = {},
  options: {
    permission?: (call: {
      toolName: string
      input: Readonly<Record<string, unknown>>
    }) => boolean | Promise<boolean>
    allowWorkspaceEdits?: boolean
    idleChildMs?: number
    extensions?: AgentExtensionsSource
    launch?: Partial<ExternalLaunch>
    runtimeOf?: () => string
    spawnFails?: boolean
    maxChildren?: number
    /** More for the fixture's environment. */
    env?: Record<string, string>
  } = {},
) {
  root ??= isolatedRoot()
  // Outside the config root, which the posture protects as node state.
  const cwd = `${root.root}-workspace`
  mkdirSync(cwd, { recursive: true })
  writeFileSync(join(cwd, 'README.md'), 'hello\n')
  // A `.env` in the workspace never becomes the harness's environment.
  writeFileSync(join(cwd, '.env'), 'LEAK=1\n')
  const logFile = join(root.root, 'fake-acp.ndjson')
  const agent: ExternalAgent = {
    agent: 'coder',
    cwd,
    runtime: 'dsh',
    ...agentOptions,
  }
  const announced: Record<string, unknown>[] = []
  const asked: { toolName: string; input: unknown }[] = []
  const resolved: ExternalAgent[] = []
  const pool = new ExternalRuntimePool({
    agents: [agent],
    ...(options.runtimeOf === undefined
      ? {}
      : { runtimeOf: options.runtimeOf }),
    resolveLaunch: running => {
      resolved.push(running)
      return {
        model: 'deepseek/deepseek-chat',
        baseUrl: 'http://127.0.0.1:9/v1',
        apiKey: 'sk-test-runtime',
        lane: 'openai-chat',
        ...options.launch,
      }
    },
    bins: { dsh: '/opt/fake/dsh' },
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
      return (await options.permission?.(call)) ?? false
    },
    ...(options.idleChildMs === undefined
      ? {}
      : { idleChildMs: options.idleChildMs }),
    ...(options.extensions === undefined
      ? {}
      : { extensions: options.extensions }),
    ...(options.maxChildren === undefined
      ? {}
      : { maxChildren: options.maxChildren }),
    spawn: input => {
      launches.push(input)
      events.push(`spawn:${input.sessionId}`)
      if (options.spawnFails === true) throw new Error('spawn refused')
      const child = spawn(
        process.execPath,
        [FAKE[input.kind]!, ...input.argv.slice(1)],
        {
          cwd: input.cwd,
          env: { ...input.env, ...options.env, QIANMO_FIXTURE_LOG: logFile },
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      )
      children.push(child)
      return child
    },
  })
  pools.push(pool)
  const logged = (): Logged[] =>
    existsSync(logFile)
      ? readFileSync(logFile, 'utf8')
          .trim()
          .split('\n')
          .map(line => JSON.parse(line) as Logged)
      : []
  const requests = (method: string) =>
    logged().filter(entry => entry.method === method)
  return { pool, agent, announced, asked, logged, requests, resolved }
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

/** The answer, or why the turn failed. */
const content = (result: ResidentTurnResult): string =>
  result.outcome === 'completed' ? result.content : `failed: ${result.reason}`

const exited = (child: ChildProcess) =>
  child.exitCode !== null || child.signalCode !== null

/** The bridge row of a dsh patch the pool wrote. */
function patchBridge(patch: string): Record<string, unknown> {
  const rows = Bun.YAML.parse(readFileSync(patch, 'utf8')) as {
    insert?: { id: string; config?: Record<string, unknown> }[]
  }[]
  return rows
    .flatMap(row => row.insert ?? [])
    .find(row => row.id === 'qm-bridge')!.config!
}

test('dsh: a warm process answers turns with text, tool progress and the usage in its session log', async () => {
  const { pool, agent, requests } = setup()
  const session = await pool.newSession(agent)
  const usage: Record<string, number>[] = []
  const progress: ResidentTurnProgress[] = []
  expect(await turn(pool, session, 'm1', 'hello', { usage })).toEqual({
    outcome: 'completed',
    content: 'acp(1): hello',
  })
  expect(await turn(pool, session, 'm2', 'tool', { usage, progress })).toEqual({
    outcome: 'completed',
    content: 'Reading.\n\nacp(2): read done',
  })
  expect(launches).toHaveLength(1)
  // From the session log, never `usage_update.used` (999999).
  expect(usage).toEqual([
    { input: 100, output: 10, cacheRead: 500, cacheWrite: 0 },
    { input: 400, output: 20, cacheRead: 1000, cacheWrite: 7 },
  ])
  expect(progress.map(step => step.summary)).toEqual(['读：README.md'])
  // The node's instructions go ahead of the first prompt only.
  const prompts = requests('session/prompt').map(
    entry => entry.params!.prompt as { type: string; text: string }[],
  )
  expect(prompts[0]).toHaveLength(2)
  expect(prompts[0]![0]!.text).toContain('a resident agent on a Qianmo')
  expect(prompts[0]![0]!.text).toContain('shell commands are refused')
  expect(prompts[1]).toEqual([{ type: 'text', text: 'tool' }])
  expect(await pool.isAccepted(session, 'm2')).toBe(true)
})

test('dsh: started from an empty directory of its own with the node’s patch, its own home and no DeepSeek variables', async () => {
  const { pool, agent, logged, requests } = setup()
  const session = await pool.newSession(agent)
  expect((await turn(pool, session, 's1', 'hello')).outcome).toBe('completed')
  const home = qianmoConfigPath('runtimes', 'dsh', 'coder')
  const launch = launches[0]!
  expect(launch.kind).toBe('dsh')
  expect(launch.cwd).toBe(join(home, 'launch'))
  expect(launch.cwd).not.toBe(agent.cwd)
  const patch = join(
    launch.sessionDir,
    'runtime-launch',
    'qianmo-dsh.patch.yml',
  )
  expect(launch.argv).toEqual([
    '/opt/fake/dsh',
    '--profile',
    'acp',
    '--patch',
    patch,
  ])
  expect(statSync(patch).mode & 0o777).toBe(0o600)
  expect(statSync(join(launch.sessionDir, 'runtime-launch')).mode & 0o777).toBe(
    0o700,
  )
  expect(statSync(home).mode & 0o777).toBe(0o700)
  expect(readFileSync(patch, 'utf8')).toContain(
    '"apiKeyEnv": "QM_DSH_GATEWAY_KEY"',
  )
  expect(readFileSync(patch, 'utf8')).not.toContain('sk-test-runtime')
  expect(
    existsSync(
      join(launch.sessionDir, 'runtime-launch', 'qm-approval-gate.mjs'),
    ),
  ).toBe(true)
  const start = logged().find(entry => entry.event === 'start')!
  expect(start.cwd).toBe(realpathSync(join(home, 'launch')))
  expect(start.env).toEqual({
    DSH_HOME: home,
    DSH_AGENTS_HOME: join(home, 'agents'),
    DSH_TELEMETRY_DISABLED: '1',
    QM_DSH_GATEWAY_KEY: 'sk-test-runtime',
    DEEPSEEK_API_KEY: null,
    DEEPSEEK_BASE_URL: null,
  })
  expect(launch.env.LEAK).toBeUndefined()
  // The workspace only as the session's directory.
  const opened = requests('session/new')[0]!.params!
  expect(opened.cwd).toBe(agent.cwd)
  // The bridge is in the patch with the long call timeout, not in
  // `session/new` (where dsh would give it 60 s).
  expect(opened.mcpServers).toEqual([])
  const bridge = patchBridge(patch)
  expect(bridge.serverName).toBe('qianmo')
  expect(String(bridge.command).startsWith('/')).toBe(true)
  expect(bridge.args).toContain('runtime-mcp')
  expect(bridge.toolCallTimeoutMs).toBe(1_900_000)
  // No effort configured: the harness's default stays.
  expect(requests('session/set_config_option')).toEqual([])
  const initialize = requests('initialize')[0]!.params!
  expect(initialize.protocolVersion).toBe(1)
  expect(initialize.clientCapabilities).toEqual({
    fs: { readTextFile: false, writeTextFile: false },
    terminal: false,
  })
  // The launch files go with the process.
  pool.closeSession(session)
  expect(existsSync(join(launch.sessionDir, 'runtime-launch'))).toBe(false)
})

test('dsh: effort goes through the offered reasoning_effort option', async () => {
  const { pool, agent, requests } = setup({}, { launch: { effort: 'low' } })
  const session = await pool.newSession(agent)
  expect((await turn(pool, session, 'e1', 'hello')).outcome).toBe('completed')
  expect(requests('session/set_config_option')[0]!.params).toEqual({
    sessionId: requests('session/prompt')[0]!.params!.sessionId,
    configId: 'reasoning_effort',
    value: 'low',
  })
})

test('dsh: a write the node refuses never happens; one inside the workspace on an editing node does', async () => {
  const refused = setup({}, { permission: () => true })
  const session = await refused.pool.newSession(refused.agent)
  expect(await turn(refused.pool, session, 'w1', 'write out.txt')).toEqual({
    outcome: 'completed',
    content: 'acp(1): write reject-once',
  })
  expect(existsSync(join(refused.agent.cwd, 'out.txt'))).toBe(false)
  // Read-only node: refused by the posture, nobody asked.
  expect(refused.asked).toEqual([])
  await refused.pool.stop()

  const editing = setup(
    {},
    { permission: () => false, allowWorkspaceEdits: true },
  )
  const second = await editing.pool.newSession(editing.agent)
  expect(await turn(editing.pool, second, 'w2', 'write out.txt')).toEqual({
    outcome: 'completed',
    content: 'acp(1): write allow-once',
  })
  expect(readFileSync(join(editing.agent.cwd, 'out.txt'), 'utf8')).toBe(
    'written\n',
  )
  expect(editing.asked).toEqual([])
  // Outside the workspace: an approval the operator declines; no file.
  const outside = `${root!.root}-outside.txt`
  expect(await turn(editing.pool, second, 'w3', `write ${outside}`)).toEqual({
    outcome: 'completed',
    content: 'acp(2): write reject-once',
  })
  expect(existsSync(outside)).toBe(false)
  expect(editing.asked.map(call => call.toolName)).toEqual(['write'])
})

test('dsh: a shell command is refused without --agent-shell and asked of the operator with it', async () => {
  const plain = setup({}, { permission: () => true })
  const session = await plain.pool.newSession(plain.agent)
  expect(content(await turn(plain.pool, session, 'b1', 'bash'))).toBe(
    'acp(1): bash reject-once',
  )
  expect(plain.asked).toEqual([])
  await plain.pool.stop()
  const shell = setup({ shell: true }, { permission: () => true })
  const second = await shell.pool.newSession(shell.agent)
  expect(content(await turn(shell.pool, second, 'b2', 'bash'))).toBe(
    'acp(1): bash allow-once',
  )
  expect(shell.asked).toEqual([
    {
      toolName: 'bash',
      input: { command: 'echo hi', description: 'Say hi' },
    },
  ])
})

test('dsh: an abort cancels the turn and answers a pending permission request as cancelled, never granted', async () => {
  let grant: ((value: boolean) => void) | undefined
  const { pool, agent, logged } = setup(
    { shell: true },
    {
      permission: () =>
        new Promise<boolean>(resolve => {
          grant = resolve
        }),
    },
  )
  const session = await pool.newSession(agent)
  const channel = await pool.channelFor(session)
  const pending = new OmpResidentTurnPort(pool).execute(
    { sessionId: session, messageId: 'h', prompt: 'hang-ask' },
    async () => {},
  )
  while (grant === undefined) await Bun.sleep(5)
  await channel.abort()
  const aborted = await pending
  expect(aborted.outcome).toBe('failed')
  if (aborted.outcome === 'failed') expect(aborted.reason).toContain('aborted')
  // The operator's late yes changes nothing.
  grant(true)
  await Bun.sleep(50)
  expect(
    logged().find(entry => entry.event === 'permission-after-cancel'),
  ).toMatchObject({ decision: 'cancelled' })
  // The process stays usable.
  expect((await turn(pool, session, 'h2', 'again')).outcome).toBe('completed')
  expect(launches).toHaveLength(1)
})

test('dsh: a turn error and a token ceiling fail the turn', async () => {
  const { pool, agent } = setup()
  const session = await pool.newSession(agent)
  const failed = await turn(pool, session, 'f', 'fail')
  expect(failed.outcome).toBe('failed')
  if (failed.outcome === 'failed')
    expect(failed.reason).toContain('upstream exploded')
  const long = await turn(pool, session, 'l', 'long')
  expect(long.outcome).toBe('failed')
})

test('dsh: a new process resumes the session; a crash is recovered; a lost session starts anew', async () => {
  const { pool, agent, requests } = setup()
  const session = await pool.newSession(agent)
  expect((await turn(pool, session, 'r1', 'hello')).outcome).toBe('completed')
  const first = requests('session/prompt')[0]!.params!.sessionId as string
  pool.closeSession(session)
  await Bun.sleep(50)
  expect(await turn(pool, session, 'r2', 'back')).toEqual({
    outcome: 'completed',
    content: 'acp(1): back',
  })
  expect(launches).toHaveLength(2)
  const resumed = requests('session/resume')
  expect(resumed).toHaveLength(1)
  expect(resumed[0]!.params!.sessionId).toBe(first)
  expect(resumed[0]!.params!.cwd).toBe(agent.cwd)
  expect(
    (resumed[0]!.params!.mcpServers as { name: string }[]).map(s => s.name),
  ).toEqual([])
  // Resumed: the instructions are already in the conversation.
  expect(requests('session/prompt')[1]!.params!.prompt).toHaveLength(1)

  // The process dies mid-turn: the turn fails, the input stays accepted.
  const crashed = await turn(pool, session, 'r3', 'crash')
  expect(crashed.outcome).toBe('failed')
  expect(await pool.isAccepted(session, 'r3')).toBe(true)
  expect((await turn(pool, session, 'r4', 'after')).outcome).toBe('completed')
  expect(launches).toHaveLength(3)
  expect(requests('session/resume')).toHaveLength(2)

  // The harness lost it: a new conversation, with the instructions again.
  pool.closeSession(session)
  await Bun.sleep(50)
  const record = join(launches[0]!.sessionDir, 'runtime.json')
  writeFileSync(record, JSON.stringify({ kind: 'dsh', nativeId: 'gone-1' }))
  expect((await turn(pool, session, 'r5', 'fresh')).outcome).toBe('completed')
  const last = requests('session/prompt').at(-1)!.params!
  expect(last.prompt).toHaveLength(2)
  expect(JSON.parse(readFileSync(record, 'utf8')).nativeId).toBe(last.sessionId)
})

test('starts at the same time share the process cap: the second waits for the first to go idle', async () => {
  const { pool, agent } = setup({}, { maxChildren: 1 })
  const a = await pool.newSession(agent)
  const b = await pool.newSession(agent)
  const ended = (session: string, id: string) =>
    turn(pool, session, id, 'hello').then(result => {
      events.push(`done:${session}`)
      return result
    })
  const results = await Promise.all([ended(a, 'c1'), ended(b, 'c2')])
  expect(results.map(result => result.outcome)).toEqual([
    'completed',
    'completed',
  ])
  expect(events.map(event => event.split(':')[0])).toEqual([
    'spawn',
    'done',
    'spawn',
    'done',
  ])
})

test('a launch that fails before its process is running leaves no token or launch files behind', async () => {
  const leftovers = (sessionDir: string) =>
    ['runtime-mcp.token', 'runtime-launch'].filter(name =>
      existsSync(join(sessionDir, name)),
    )
  // The launch plan refuses the lane: nothing was handed out yet.
  const planned = setup({}, { launch: { lane: 'gemini' } })
  const first = await planned.pool.newSession(planned.agent)
  await expect(turn(planned.pool, first, 'p1', 'hello')).rejects.toThrow(
    'cannot call the gemini lane',
  )
  const firstDir = qianmoConfigPath('resident', 'sessions', 'coder', first)
  expect(leftovers(firstDir)).toEqual([])
  // The process does not start: its token and launch files are taken back.
  const spawned = setup({}, { spawnFails: true })
  const second = await spawned.pool.newSession(spawned.agent)
  await expect(turn(spawned.pool, second, 'p2', 'hello')).rejects.toThrow(
    'spawn refused',
  )
  expect(launches.at(-1)?.sessionId).toBe(second)
  expect(leftovers(launches.at(-1)!.sessionDir)).toEqual([])
})

test('a start still being set up when the pool stops spawns nothing and hands out no token', async () => {
  const { pool, agent } = setup()
  const session = await pool.newSession(agent)
  const before = launches.length
  const starting = pool.channelFor(session)
  await pool.stop()
  await expect(starting).rejects.toThrow('external runtime pool is closed')
  expect(launches.length).toBe(before)
  const sessionDir = qianmoConfigPath('resident', 'sessions', 'coder', session)
  expect(existsSync(join(sessionDir, 'runtime-mcp.token'))).toBe(false)
})

test('a session the harness cannot open right now is kept; only an unknown one, or one failing three starts in a row, starts anew', async () => {
  const { pool, agent, requests } = setup()
  const session = await pool.newSession(agent)
  expect((await turn(pool, session, 'f1', 'hello')).outcome).toBe('completed')
  pool.closeSession(session)
  await Bun.sleep(50)
  const record = join(launches[0]!.sessionDir, 'runtime.json')
  const saved = () =>
    JSON.parse(readFileSync(record, 'utf8')) as {
      kind: string
      nativeId?: string
      resumeFailures?: number
    }
  writeFileSync(record, JSON.stringify({ kind: 'dsh', nativeId: 'flaky-1' }))
  for (const [id, failures] of [
    ['f2', 1],
    ['f3', 2],
  ] as const) {
    await expect(turn(pool, session, id, 'again')).rejects.toThrow(
      'session/resume: Internal error',
    )
    expect(saved()).toEqual({
      kind: 'dsh',
      nativeId: 'flaky-1',
      resumeFailures: failures,
    })
  }
  const before = requests('session/new').length
  expect((await turn(pool, session, 'f4', 'fresh')).outcome).toBe('completed')
  expect(requests('session/new')).toHaveLength(before + 1)
  expect(saved().nativeId).not.toBe('flaky-1')
  expect(saved().resumeFailures).toBeUndefined()
})

test('only a not-found answer counts as a lost session', () => {
  expect(acpSessionGone(new AcpRpcError('x', -32002, undefined))).toBe(true)
  expect(
    acpSessionGone(
      new AcpRpcError('dsh session/resume: unknown session s1', -32602, {}),
    ),
  ).toBe(true)
  // Gemini CLI: an internal error whose details name the session.
  expect(
    acpSessionGone(
      new AcpRpcError('gemini session/load: Internal error', -32603, {
        details: 'Invalid session identifier "s1".',
      }),
    ),
  ).toBe(true)
  expect(
    acpSessionGone(
      new AcpRpcError('qwen session/resume: Internal error', -32603, {
        details: 'upstream unavailable',
      }),
    ),
  ).toBe(false)
  expect(acpSessionGone(new Error('dsh session/resume timed out'))).toBe(false)
})

const SERVERS: AgentExtensions = {
  ompPluginDirs: [],
  claudePluginDirs: [],
  mcp: [
    {
      name: 'docs',
      transport: 'stdio',
      command: 'docs-mcp',
      args: ['--fast'],
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
    {
      name: 'feed',
      transport: 'sse',
      url: 'https://feed.example/sse',
      approval: 'allow',
      tools: [],
    },
  ],
  readableRoots: [],
}

test('dsh: operator MCP servers go in session/new (the bridge is in the patch); stdio through qm mcp-exec, SSE left out', async () => {
  const { pool, agent, requests, announced } = setup(
    {},
    { extensions: () => SERVERS },
  )
  const session = await pool.newSession(agent)
  expect((await turn(pool, session, 'p1', 'hello')).outcome).toBe('completed')
  const servers = requests('session/new')[0]!.params!.mcpServers as Record<
    string,
    unknown
  >[]
  // Under the reserved prefix (P36.7).
  expect(servers.map(server => server.name)).toEqual(['qm-docs', 'qm-crm'])
  const docs = servers[0]!
  expect(String(docs.command).startsWith('/')).toBe(true)
  const args = docs.args as string[]
  expect(args.slice(args.indexOf('mcp-exec'))).toEqual([
    'mcp-exec',
    '--keep',
    'DOCS_TOKEN',
    '--',
    'docs-mcp',
    '--fast',
  ])
  expect(docs.env).toEqual([{ name: 'DOCS_TOKEN', value: 'secret-value' }])
  expect(servers[1]).toEqual({
    type: 'http',
    name: 'qm-crm',
    url: 'https://crm.example/mcp',
    headers: [{ name: 'Authorization', value: 'Bearer t' }],
  })
  // The bridge answers for this session, with the host's tools.
  const launch = launches.at(-1)!
  const bridge = patchBridge(
    join(launch.sessionDir, 'runtime-launch', 'qianmo-dsh.patch.yml'),
  ) as { command: string; args: string[] }
  const mcp = mcpClient(bridge)
  await mcp.open()
  const listed = await mcp.request('tools/list')
  const names = (listed.result as { tools: { name: string }[] }).tools.map(
    tool => tool.name,
  )
  expect(names).toContain('qianmo_notify')
  expect(names).not.toContain('qianmo_permission')
  expect(names).not.toContain('qianmo_read_file')
  const notified = await mcp.call('qianmo_notify', {
    verdict: 'notify',
    summary: 'done',
  })
  expect(announced.length + Number(notified.isError)).toBeGreaterThan(0)
})

test('dsh: an MCP call on a server set to ask goes to the operator; one set to allow and the host’s own tools are not asked about', async () => {
  const { pool, agent, asked } = setup(
    {},
    { extensions: () => SERVERS, permission: () => true },
  )
  const session = await pool.newSession(agent)
  expect(
    content(await turn(pool, session, 'q1', 'mcp mcp__qm-docs__search')),
  ).toBe('acp(1): mcp__qm-docs__search allow-once')
  expect(
    content(await turn(pool, session, 'q2', 'mcp mcp__qianmo__qianmo_notify')),
  ).toBe('acp(2): mcp__qianmo__qianmo_notify allow-once')
  expect(asked).toEqual([])
  expect(
    content(await turn(pool, session, 'q3', 'mcp mcp__qm-crm__lookup')),
  ).toBe('acp(3): mcp__qm-crm__lookup allow-once')
  expect(asked.map(call => call.toolName)).toEqual(['mcp__crm__lookup'])
  // A connector nobody configured: refused without asking.
  expect(
    content(await turn(pool, session, 'q4', 'mcp mcp__qm-stranger__x')),
  ).toBe('acp(4): mcp__qm-stranger__x reject-once')
  expect(asked).toHaveLength(1)
  // A server the agent installed in dsh itself: the operator decides.
  expect(
    content(await turn(pool, session, 'q5', 'mcp mcp__docs__search')),
  ).toBe('acp(5): mcp__docs__search allow-once')
  expect(asked.map(call => call.toolName)).toEqual([
    'mcp__crm__lookup',
    'mcp__docs__search',
  ])
})

test('dsh: what a client must ignore is ignored; methods it does not offer are refused', async () => {
  const { pool, agent, logged } = setup()
  const session = await pool.newSession(agent)
  expect(await turn(pool, session, 'n1', 'noise')).toEqual({
    outcome: 'completed',
    content: 'acp(1): noise',
  })
  const reply = logged().find(entry => entry.event === 'fs-reply')!
  expect((reply.reply as { code: number }).code).toBe(-32601)
})

test('a session moved to another runtime starts a new native conversation there', async () => {
  let runtime = 'dsh'
  const { pool, agent, resolved } = setup(
    { runtime: 'claude-code' },
    { runtimeOf: () => runtime },
  )
  const session = await pool.newSession(agent)
  expect(pool.conversationSince(session)).toBeUndefined()
  const begun = Date.now()
  expect(content(await turn(pool, session, 'x1', 'hello'))).toBe(
    'acp(1): hello',
  )
  expect(resolved.at(-1)!.runtime).toBe('dsh')
  const dshSince = pool.conversationSince(session)!
  expect(dshSince).toBeGreaterThanOrEqual(begun)
  const dir = launches[0]!.sessionDir
  expect(JSON.parse(readFileSync(join(dir, 'runtime.json'), 'utf8')).kind).toBe(
    'dsh',
  )
  const dshPrompt = readFileSync(join(dir, 'runtime-system.txt'), 'utf8')
  runtime = 'claude-code'
  pool.closeSession(session)
  await Bun.sleep(50)
  expect(content(await turn(pool, session, 'x2', 'again'))).toBe(
    'echo(1): again',
  )
  expect(launches[1]!.kind).toBe('claude-code')
  expect(launches[1]!.argv).toContain('--session-id')
  expect(launches[1]!.argv).not.toContain('--resume')
  const claude = JSON.parse(readFileSync(join(dir, 'runtime.json'), 'utf8'))
  expect(claude.kind).toBe('claude-code')
  // Its conversation there is new: the dsh turn is not in it.
  expect(pool.conversationSince(session)!).toBeGreaterThan(dshSince)
  // The instructions follow the runtime it runs on now.
  expect(readFileSync(join(dir, 'runtime-system.txt'), 'utf8')).not.toBe(
    dshPrompt,
  )
})

test('a conversation id equal to the one another runtime had is still a new conversation', async () => {
  const { pool, agent } = setup(
    {},
    { env: { QIANMO_FIXTURE_SESSION_ID: 'same-id' } },
  )
  const session = await pool.newSession(agent)
  // The session ran on Gemini before, whose conversation had the same id.
  writeFileSync(
    join(
      qianmoConfigPath('resident', 'sessions', 'coder', session),
      'runtime.json',
    ),
    JSON.stringify({ kind: 'gemini', nativeId: 'same-id', since: 1 }),
  )
  const begun = Date.now()
  expect(content(await turn(pool, session, 'x1', 'hello'))).toBe(
    'acp(1): hello',
  )
  expect(pool.conversationSince(session)!).toBeGreaterThanOrEqual(begun)
})

test('an ACP turn with no usage anywhere records zero, marked unreported', async () => {
  root ??= isolatedRoot()
  const cwd = `${root.root}-workspace`
  mkdirSync(cwd, { recursive: true })
  const child = spawn(process.execPath, [FAKE.dsh!], {
    cwd,
    env: { ...process.env, DSH_HOME: join(root.root, 'nowhere') },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  children.push(child)
  const channel = new AcpChannel(child, {
    label: 'Fake ACP',
    runtime: {
      launch: () => ({ argv: [], env: {} }),
      mcpTransports: ['stdio'],
    },
    cwd,
    mcpServers: [],
    onSession: () => {},
    permission: async () => false,
  })
  await channel.initialize()
  const frames: OmpRpcFrame[] = []
  const done = new Promise<void>(resolve =>
    channel.onFrame(frame => {
      frames.push(frame)
      if (frame.type === 'prompt_result') resolve()
    }),
  )
  await channel.prompt({ messageId: 'u1', text: 'hello' })
  await done
  const messages = frames
    .filter(frame => frame.type === 'message_end')
    .map(frame => frame.message as Record<string, unknown>)
  expect(messages.at(-1)).toEqual({
    role: 'assistant',
    content: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    usageReported: false,
  })
  expect(frames.at(-1)).toMatchObject({ status: 'completed' })
  await channel.stop()
  expect(exited(child)).toBe(true)
})

test('a conversation session/load replays after its answer is not taken for the next turn’s', async () => {
  root ??= isolatedRoot()
  const cwd = `${root.root}-workspace`
  mkdirSync(cwd, { recursive: true })
  const child = spawn(process.execPath, [FAKE.dsh!], {
    cwd,
    env: {
      ...process.env,
      DSH_HOME: join(root.root, 'nowhere'),
      QIANMO_FAKE_ACP_LOAD: 'late',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  children.push(child)
  const opened: string[] = []
  const channel = new AcpChannel(child, {
    label: 'Fake ACP',
    runtime: {
      launch: () => ({ argv: [], env: {} }),
      mcpTransports: ['stdio'],
    },
    cwd,
    mcpServers: [],
    sessionId: 'earlier',
    onSession: id => opened.push(id),
    permission: async () => false,
  })
  await channel.initialize()
  expect(opened).toEqual(['earlier'])
  const frames: OmpRpcFrame[] = []
  const done = new Promise<void>(resolve =>
    channel.onFrame(frame => {
      frames.push(frame)
      if (frame.type === 'prompt_result') resolve()
    }),
  )
  await channel.prompt({ messageId: 'u1', text: 'hello' })
  await done
  const said = frames
    .filter(frame => frame.type === 'message_end')
    .map(frame => frame.message as { role: string; content: unknown[] })
    .filter(message => message.role === 'assistant')
    .flatMap(message => message.content)
  expect(said).toEqual([{ type: 'text', text: 'acp(1): hello' }])
  await channel.stop()
})

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
