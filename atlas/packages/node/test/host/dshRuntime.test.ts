// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, expect, test } from 'bun:test'
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AcpLaunchInput } from '../../src/host/runtimes/acpSpec.js'
import { runtimeSpec } from '../../src/host/runtimes/catalog.js'
import {
  DSH_BRIDGE_READY_PLUGIN,
  DSH_GATE_PLUGIN,
  dshEncodeSegment,
  dshLaunch,
  dshPatch,
  dshProjectKey,
  dshToolCall,
  dshUsageReader,
} from '../../src/host/runtimes/dsh.js'

const scratch: string[] = []
afterEach(() => {
  for (const dir of scratch.splice(0))
    rmSync(dir, { recursive: true, force: true })
})
function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'qm-dsh-'))
  scratch.push(dir)
  return dir
}

const INPUT: AcpLaunchInput = {
  bin: '/prefix/node_modules/.bin/dsh',
  model: 'deepseek/deepseek-chat',
  lane: 'openai-chat',
  baseUrl: 'https://gw.example/v1',
  apiKey: 'sk-secret',
  home: '/q/runtimes/dsh/coder',
  runDir: '/q/resident/sessions/coder/s1/runtime-launch',
  cwd: '/work/space',
  bridge: {
    name: 'qianmo',
    command: '/usr/local/bin/qm',
    args: ['runtime-mcp', '--port', '4100', '--token-file', '/q/t'],
    timeoutMs: 1_900_000,
  },
}

type Row = {
  id?: string
  config?: Record<string, unknown>
  disabled?: boolean
  inject?: string[]
  insert?: unknown[]
}

function rows(text: string): Row[] {
  return Bun.YAML.parse(text) as Row[]
}

test('the dsh catalog entry is pinned, needs Node 22.19+, names itself in --help, and speaks ACP through dsh.ts', () => {
  const spec = runtimeSpec('dsh')!
  expect(spec.protocol).toBe('acp')
  expect(spec.install).toEqual({
    kind: 'npm',
    package: '@deepseek-ai/dsh',
    command: 'dsh',
    pin: '0.2.1-rc.2',
    needsNode: '^22.19.0 || >=24',
    // Debian's and pdsh's `dsh` share its name (runtimeUpdate.ts, qmo agents).
    identity: { args: ['--help'], name: /DeepSeek Harness/ },
  })
  expect(spec.lanes).toEqual(['openai-chat', 'anthropic'])
  expect(spec.acp?.mcpTransports).toEqual(['stdio', 'http'])
  expect(spec.acp?.resume).toBe('session/resume')
  expect(spec.acp?.effortOption).toBe('reasoning_effort')
  expect(spec.acp?.skillsDir).toBe('skills/qmo')
})

test('dsh starts from its own empty launch directory with its home, the key under a KEY name and no DeepSeek variables', () => {
  const launch = dshLaunch(INPUT)
  const patch = join(INPUT.runDir, 'qianmo-dsh.patch.yml')
  expect(launch.argv).toEqual([INPUT.bin, '--profile', 'acp', '--patch', patch])
  expect(launch.env).toEqual({
    DSH_HOME: INPUT.home,
    DSH_AGENTS_HOME: join(INPUT.home, 'agents'),
    DSH_TELEMETRY_DISABLED: '1',
    QM_DSH_GATEWAY_KEY: 'sk-secret',
  })
  expect(launch.cwd).toBe(join(INPUT.home, 'launch'))
  expect(launch.cwd).not.toBe(INPUT.cwd)
  expect(launch.files?.map(file => file.path)).toEqual([
    patch,
    join(INPUT.runDir, 'qm-approval-gate.mjs'),
    join(INPUT.runDir, 'qm-bridge-ready.mjs'),
  ])
  expect(launch.files?.[0]?.content).not.toContain('sk-secret')
  expect(launch.dirs).toContain(join(INPUT.home, 'skills', 'qmo'))
  expect(launch.mountsBridge).toBe(true)
})

test('the patch routes the openai-chat lane through pi-ai and isolates dsh', () => {
  const text = dshPatch(INPUT)
  const parsed = rows(text)
  const byId = new Map(parsed.filter(row => row.id).map(row => [row.id, row]))
  expect(byId.get('llm-pi-ai')?.config).toEqual({
    providers: {
      qm: {
        displayName: 'Qianmo gateway',
        api: 'openai-completions',
        baseURL: 'https://gw.example/v1',
        apiKeyEnv: 'QM_DSH_GATEWAY_KEY',
        models: [{ id: 'deepseek/deepseek-chat' }],
      },
    },
  })
  for (const id of ['acp', 'agent-default-model'])
    expect(byId.get(id)?.config).toEqual({
      provider: 'qm',
      model: 'deepseek/deepseek-chat',
    })
  // ACP serves nothing before the bridge's tools are registered.
  expect(byId.get('acp')?.inject).toEqual(['acpAppStartup', 'qmBridgeReady'])
  expect(byId.get('agent-instructions')?.config).toEqual({ maxBytes: 0 })
  expect(byId.get('skill-filesystem')?.config).toEqual({
    includeDefaultRoots: false,
    customSkillDirs: [
      "dshHomePath('skills', 'qmo')",
      "dshHomePath('skills')",
      "dshHomePath('agents', 'skills')",
    ],
    watch: false,
  })
  expect(byId.get('session-log-deepseek')?.config).toEqual({ enabled: false })
  expect(byId.get('plugin-package-inventory-deepseek')?.config).toEqual({
    enabled: false,
  })
  for (const id of [
    'session-telemetry-otel',
    'tool-web',
    'tool-subagent',
    'tool-subagent-fork',
    'tool-subagent-control',
    'tool-subagent-list-agents',
    'tool-workflow',
    'tool-goal',
    'hooks-claude-code',
    'hooks-codex',
  ])
    expect(byId.get(id)?.disabled).toBe(true)
  expect(byId.get('session-persistence-jsonl')?.config).toEqual({
    root: "dshHomePath('sessions')",
    compression: 'none',
  })
  // The bridge is a global MCP client with the long call timeout (dsh gives
  // `session/new` servers 60 s), so the launch keeps it out of `session/new`.
  expect(parsed.at(-1)).toEqual({
    insert: [
      {
        id: 'qm-bridge',
        name: '@deepseek-ai/dsh-mcp-client',
        config: {
          transport: 'stdio',
          serverName: 'qianmo',
          command: '/usr/local/bin/qm',
          args: ['runtime-mcp', '--port', '4100', '--token-file', '/q/t'],
          cwd: '/work/space',
          toolCallTimeoutMs: 1_900_000,
          failOnStartupError: true,
        },
      },
      {
        id: 'qm-bridge-ready',
        name: './qm-bridge-ready.mjs',
        config: { prefix: 'mcp__qianmo__', waitMs: 30_000 },
      },
      { id: 'qm-approval-gate', name: './qm-approval-gate.mjs' },
    ],
  })
  // The `!!js` tags are literal and only on dsh's own helper.
  expect(text).toContain(`"root": !!js "dshHomePath('sessions')"`)
  expect(text.match(/!!js/g)).toHaveLength(4)
  // Nothing of the user's own dsh or agents homes, nor the native route.
  expect(text).not.toContain('DEEPSEEK')
})

test('the anthropic lane uses anthropic-messages; effort declares the levels; other lanes are refused', () => {
  const parsed = rows(
    dshPatch({
      ...INPUT,
      lane: 'anthropic',
      baseUrl: 'https://gw.example',
      effort: 'xhigh',
      headers: { 'X-Qm-Agent': 'coder' },
      contextWindow: 131072,
      maxOutputTokens: 8192,
    }),
  )
  const provider = (
    parsed[0]!.config as { providers: Record<string, Record<string, unknown>> }
  ).providers.qm!
  expect(provider.api).toBe('anthropic-messages')
  expect(provider.baseURL).toBe('https://gw.example')
  expect(provider.headers).toEqual({ 'X-Qm-Agent': 'coder' })
  expect(provider.reasoning).toBe('xhigh')
  expect(provider.models).toEqual([
    {
      id: 'deepseek/deepseek-chat',
      contextWindow: 131072,
      maxTokens: 8192,
      reasoningEfforts: {
        low: 'low',
        medium: 'medium',
        high: 'high',
        xhigh: 'xhigh',
      },
    },
  ])
  expect(() => dshPatch({ ...INPUT, lane: 'gemini' })).toThrow(
    'cannot call the gemini lane',
  )
})

test('every injected value stays one quoted scalar', () => {
  const hostile = {
    ...INPUT,
    model:
      'evil"\n- {id: tool-web, disabled: false}\n# x: !!js "process.exit()"',
    baseUrl: "https://gw.example/v1'] # \u0085",
    headers: {
      'X-A"\nb': 'line1\nline2: [x]\té😀',
    },
  }
  const text = dshPatch(hostile)
  const parsed = rows(text)
  const provider = (
    parsed[0]!.config as { providers: Record<string, Record<string, unknown>> }
  ).providers.qm!
  expect(provider.baseURL).toBe(hostile.baseUrl)
  expect(provider.headers).toEqual(hostile.headers)
  expect((provider.models as { id: string }[])[0]!.id).toBe(hostile.model)
  // No row was added, removed or re-enabled by a value.
  expect(parsed).toHaveLength(rows(dshPatch(INPUT)).length)
  // The only tags are the node's own; the value's `!!js` stayed text.
  expect(text.match(/!!js "dshHomePath/g)).toHaveLength(4)
  // One line per row, plus the comment and the final newline.
  expect(text.split('\n')).toHaveLength(parsed.length + 2)
  expect(text).toMatch(/^[\x20-\x7e\n]*$/)
})

test('dsh session paths are encoded as dsh encodes them', () => {
  // Observed in the probe: `/private/tmp/claude-501/dsh-probe/workspace`.
  expect(dshProjectKey('/private/tmp/claude-501/dsh-probe/workspace')).toBe(
    '--private-tmp-claude-501-dsh-probe-workspace--',
  )
  expect(dshProjectKey('/a//b c~d')).toBe('--a-b~0020c~007Ed--')
  expect(dshProjectKey('/')).toBe('--root--')
  expect(dshEncodeSegment('c9825f8c-fa7b-46d8-a5b9-4d196783dff3')).toBe(
    'c9825f8c-fa7b-46d8-a5b9-4d196783dff3',
  )
  expect(dshEncodeSegment('..')).toBe('~002E~002E')
  expect(dshEncodeSegment('a/b')).toBe('a~002Fb')
})

test('the usage reader sums a turn’s assistant messages once dsh has logged its end', async () => {
  const home = temp()
  const cwd = '/work/space'
  const dir = join(home, 'sessions', dshProjectKey(cwd), 'sess-1')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'session.v4.jsonl')
  const line = (value: unknown) => `${JSON.stringify(value)}\n`
  writeFileSync(file, line({ type: 'session', version: 4, cwd }))
  const reader = dshUsageReader({ home, cwd, sessionId: 'sess-1' })
  const from = reader.start()
  appendFileSync(
    file,
    line({ type: 'turn/start', data: { turn: 1 } }) +
      line({
        type: 'assistant/message',
        data: {
          usage: { inputTokens: 489, outputTokens: 21, cacheReadTokens: 512 },
        },
      }),
  )
  // The rest arrives in dsh's next batch; the read waits for it.
  setTimeout(() => {
    appendFileSync(
      file,
      line({
        type: 'assistant/message',
        data: {
          usage: {
            inputTokens: 923,
            outputTokens: 53,
            cacheReadTokens: 256,
            cacheWriteTokens: 64,
          },
        },
      }) +
        line({ type: 'turn/end', data: { turn: 1 } }) +
        '{"type":"torn',
    )
  }, 100)
  expect(await reader.read(from)).toEqual({
    input: 1412,
    output: 74,
    cacheRead: 768,
    cacheWrite: 64,
  })
  // The next turn counts only its own records.
  const next = reader.start()
  appendFileSync(
    file,
    'n":1}\n' +
      line({ type: 'turn/start', data: { turn: 2 } }) +
      line({ type: 'turn/end', data: { turn: 2 } }),
  )
  expect(next).toBeGreaterThan(from)
  expect(await reader.read(next)).toBeUndefined()
  // A log under another project directory is still found by its id.
  const elsewhere = dshUsageReader({ home, cwd: '/moved', sessionId: 'sess-1' })
  expect(elsewhere.start()).toBeGreaterThan(0)
})

test('dsh tool calls read in the node’s vocabulary', () => {
  const call = (title: string, rawInput: Record<string, unknown>) =>
    dshToolCall({ title, kind: 'other', rawInput, paths: [] })
  expect(call('bash', { command: 'ls', description: 'list' })).toEqual([
    { toolName: 'bash', input: { command: 'ls', description: 'list' } },
  ])
  expect(call('pwsh', { command: 'dir' })[0]!.toolName).toBe('bash')
  expect(call('write', { file_path: 'a.txt', content: 'x' })).toEqual([
    {
      toolName: 'write',
      input: { file_path: 'a.txt', content: 'x', path: 'a.txt' },
    },
  ])
  expect(
    call('edit', { file_path: '/etc/x', old_string: 'a', new_string: 'b' })[0],
  ).toMatchObject({
    toolName: 'edit',
    input: { path: '/etc/x' },
  })
  expect(call('read_image', { file_path: 'p.png' })).toEqual([
    { toolName: 'read', input: { path: 'p.png' } },
  ])
  expect(call('grep', { pattern: 'x' })).toEqual([
    { toolName: 'grep', input: { path: '.', pattern: 'x' } },
  ])
  expect(call('glob', { pattern: '../../**' })[0]!.input.path).toBe('../../**')
  expect(call('glob', { pattern: '**/*.ts', path: 'src' })[0]!.input.path).toBe(
    'src',
  )
  expect(call('working_directory', { cd: '/etc' })).toEqual([
    { toolName: 'read', input: { path: '/etc' } },
  ])
  expect(
    call('read_mcp_resource', { server: 'docs', uri: 'docs://a' }),
  ).toEqual([
    { toolName: 'mcp__docs__read_mcp_resource', input: { uri: 'docs://a' } },
  ])
  expect(call('todo_write', { todos: [] })[0]!.toolName).toBe('todo')
  expect(call('some_plugin_tool', {})[0]!.toolName).toBe('some_plugin_tool')
})

type GateListener = (
  exec: Record<string, unknown>,
  next: () => Promise<{ kind: string }>,
) => Promise<{
  kind: string
}>

type GateGuard = (exec: Record<string, unknown>) => string | undefined

async function loadGate(): Promise<{
  listener: GateListener
  options: unknown
  guard: GateGuard
}> {
  const dir = temp()
  const file = join(dir, 'qm-approval-gate.mjs')
  writeFileSync(file, DSH_GATE_PLUGIN)
  const plugin = (await import(file)) as {
    name: string
    apply: (ctx: unknown) => void
  }
  expect(plugin.name).toBe('qm-approval-gate')
  let listener: GateListener | undefined
  let options: unknown
  let guard: GateGuard | undefined
  plugin.apply({
    on: (event: string, callback: GateListener, opts: unknown) => {
      expect(event).toBe('tools/pre-execute')
      listener = callback
      options = opts
    },
    tools: {
      guard: (callback: GateGuard) => {
        guard = callback
      },
    },
  })
  return { listener: listener!, options, guard: guard! }
}

test('the approval gate asks for every effect and every read outside the workspace, after the rest of the chain', async () => {
  const { listener, options } = await loadGate()
  expect(options).toEqual({ prepend: true })
  const workspace = temp()
  mkdirSync(join(workspace, 'src'))
  const outside = temp()
  symlinkSync(outside, join(workspace, 'escape'))
  const decide = async (
    name: string,
    args: Record<string, unknown> = {},
    inner: { kind: string } = { kind: 'allow' },
  ) =>
    (
      await listener(
        {
          name,
          arguments: args,
          agent: { session: { header: { cwd: workspace } } },
        },
        async () => inner,
      )
    ).kind
  for (const effect of ['bash', 'pwsh', 'write', 'edit', 'read_mcp_resource'])
    expect(await decide(effect, { file_path: 'a.txt' })).toBe('ask')
  expect(await decide('mcp__docs__search')).toBe('ask')
  expect(await decide('some_plugin_tool')).toBe('ask')
  expect(await decide('mcp__qianmo__qianmo_notify')).toBe('allow')
  for (const free of [
    'todo_write',
    'skill',
    'job_output',
    'list_mcp_resources',
  ])
    expect(await decide(free)).toBe('allow')
  expect(await decide('read', { file_path: 'src/a.ts' })).toBe('allow')
  expect(
    await decide('read', { file_path: join(workspace, 'README.md') }),
  ).toBe('allow')
  expect(await decide('read', { file_path: '../x' })).toBe('ask')
  expect(await decide('read', { file_path: '/etc/hosts' })).toBe('ask')
  // A link inside the workspace that leads out of it.
  expect(await decide('read', { file_path: 'escape/secret' })).toBe('ask')
  expect(await decide('read_image', { file_path: '/tmp/p.png' })).toBe('ask')
  expect(await decide('grep', { pattern: 'x' })).toBe('allow')
  expect(await decide('grep', { pattern: 'x', path: '/etc' })).toBe('ask')
  expect(await decide('glob', { pattern: '**/*.ts' })).toBe('allow')
  expect(await decide('glob', { pattern: '/etc/*' })).toBe('ask')
  expect(await decide('glob', { pattern: '../**' })).toBe('ask')
  expect(await decide('working_directory')).toBe('allow')
  expect(await decide('working_directory', { cd: 'src' })).toBe('allow')
  expect(await decide('working_directory', { cd: '/' })).toBe('ask')
  // What the chain refuses stays refused; nothing asks first.
  expect(await decide('bash', {}, { kind: 'deny' })).toBe('deny')
  expect(await decide('bash', {}, { kind: 'ask' })).toBe('ask')
  // No session directory known: ask.
  expect(
    (
      await listener(
        { name: 'read', arguments: { file_path: 'a' } },
        async () => ({
          kind: 'allow',
        }),
      )
    ).kind,
  ).toBe('ask')
})

test('gate v2: a gated call that never reached the node is stopped at execution (P36.7)', async () => {
  const { listener, guard } = await loadGate()
  const workspace = temp()
  const exec = (name: string, callId: string, args = {}) => ({
    name,
    callId,
    arguments: args,
    agent: { session: { header: { cwd: workspace } } },
  })
  // A native bundle's listener answered first and allowed it: never asked.
  expect(guard(exec('bash', 'c1', { command: 'id' }))).toContain(
    'was not routed to the node',
  )
  expect(guard(exec('some_plugin_tool', 'c2'))).toContain('not routed')
  // Asked through the node: it runs once the operator allowed it.
  expect(
    (await listener(exec('bash', 'c3'), async () => ({ kind: 'allow' }))).kind,
  ).toBe('ask')
  expect(guard(exec('bash', 'c3'))).toBeUndefined()
  // Free tools and the node's own never need the node.
  expect(guard(exec('todo_write', 'c4'))).toBeUndefined()
  expect(guard(exec('mcp__qianmo__qianmo_notify', 'c5'))).toBeUndefined()
  expect(guard(exec('read', 'c6', { file_path: 'a.txt' }))).toBeUndefined()
})

test('the bridge-ready plugin provides its service once a bridge tool is registered', async () => {
  const file = join(temp(), 'qm-bridge-ready.mjs')
  writeFileSync(file, DSH_BRIDGE_READY_PLUGIN)
  const plugin = (await import(file)) as {
    name: string
    inject: string[]
    apply: (ctx: unknown, config: unknown) => Promise<void>
  }
  expect(plugin.name).toBe('qm-bridge-ready')
  expect(plugin.inject).toEqual(['tools'])
  const visible = new Map<string, unknown>([['read', {}]])
  const provided: [string, unknown][] = []
  const started = plugin.apply(
    {
      tools: { view: () => ({ visible }) },
      provide: (name: string, value: unknown) => provided.push([name, value]),
    },
    { prefix: 'mcp__qianmo__', waitMs: 5_000 },
  )
  await Bun.sleep(80)
  expect(provided).toEqual([])
  visible.set('mcp__qianmo__qianmo_notify', {})
  await started
  expect(provided).toEqual([['qmBridgeReady', { ready: true }]])
})
