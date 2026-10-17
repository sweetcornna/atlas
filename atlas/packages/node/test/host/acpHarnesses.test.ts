// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  AcpLaunchInput,
  AcpToolCall,
} from '../../src/host/runtimes/acpSpec.js'
import { FAMILIES, runtimeSpec } from '../../src/host/runtimes/catalog.js'
import {
  GEMINI_POLICY_FILE,
  GEMINI_QMO_SKILLS,
  geminiBaseUrl,
  geminiExtension,
  geminiLaunch,
  geminiPolicy,
  geminiSettings,
  geminiToolCall,
} from '../../src/host/runtimes/gemini.js'
import {
  OPENCODE_KEY_ENV,
  OPENCODE_QMO_SKILLS,
  opencodeConfig,
  opencodeLaunch,
  opencodeToolCall,
} from '../../src/host/runtimes/opencode.js'
import {
  QWEN_QMO_SKILLS,
  QWEN_SETTINGS_FILE,
  qwenLaunch,
  qwenSettings,
  qwenToolCall,
} from '../../src/host/runtimes/qwen.js'

const scratch: string[] = []
afterEach(() => {
  for (const dir of scratch.splice(0))
    rmSync(dir, { recursive: true, force: true })
})
function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'qm-acp-harness-'))
  scratch.push(dir)
  return dir
}

const BRIDGE_TIMEOUT_MS = 1_900_000

function input(
  runtime: string,
  overrides: Partial<AcpLaunchInput> = {},
): AcpLaunchInput {
  return {
    bin: `/prefix/node_modules/.bin/${runtime}`,
    model: 'vendor/model-x',
    lane: 'openai-chat',
    baseUrl: 'https://gw.example/v1',
    apiKey: 'sk-secret',
    home: `/q/runtimes/${runtime}/coder`,
    runDir: '/q/resident/sessions/coder/s1/runtime-launch',
    cwd: '/work/space',
    bridge: {
      name: 'qianmo',
      command: '/usr/local/bin/qm',
      args: ['runtime-mcp', '--port', '4100', '--token-file', '/q/t'],
      timeoutMs: BRIDGE_TIMEOUT_MS,
    },
    ...overrides,
  }
}

function call(overrides: Partial<AcpToolCall>): AcpToolCall {
  return { title: 'tool', rawInput: {}, paths: [], ...overrides }
}

test('the three ACP survey entries are pinned npm installs with their lanes, verified on their pins', () => {
  const gemini = runtimeSpec('gemini')!
  expect(gemini.install).toEqual({
    kind: 'npm',
    package: '@google/gemini-cli',
    command: 'gemini',
    pin: '0.64.0',
    needsNode: '>=20',
  })
  expect(gemini.lanes).toEqual(['gemini'])
  expect(gemini.family).toBe(FAMILIES.gemini)
  // Only the bridge: Gemini's permission request does not name a server.
  expect(gemini.acp?.mcpTransports).toEqual([])
  expect(gemini.acp?.skillsDir).toBe(GEMINI_QMO_SKILLS)

  const qwen = runtimeSpec('qwen')!
  expect(qwen.install).toEqual({
    kind: 'npm',
    package: '@qwen-code/qwen-code',
    command: 'qwen',
    pin: '0.25.2',
    needsNode: '>=22',
  })
  expect(qwen.lanes).toEqual(['openai-chat'])
  expect(qwen.family).toBe(FAMILIES.qwen)
  expect(qwen.acp?.skillsDir).toBe(QWEN_QMO_SKILLS)

  const opencode = runtimeSpec('opencode')!
  expect(opencode.install).toEqual({
    kind: 'npm',
    package: 'opencode-ai',
    command: 'opencode',
    pin: '1.19.3',
  })
  expect(opencode.lanes).toEqual(['openai-chat', 'anthropic'])
  expect(opencode.family).toBeNull()
  // Its prompt usage is the last model call's only.
  expect(opencode.acp?.promptUsage).toBe(false)
  expect(opencode.acp?.skillsDir).toBe(OPENCODE_QMO_SKILLS)

  for (const spec of [gemini, qwen, opencode]) {
    expect(spec.protocol).toBe('acp')
    expect(spec.default).toBe(false)
    expect(spec.verified).toBe(true)
  }
})

test('Gemini CLI gets the gateway root: a trailing /v1beta and slashes come off', () => {
  expect(geminiBaseUrl('https://gw.example/v1beta')).toBe('https://gw.example')
  expect(geminiBaseUrl('https://gw.example/v1beta/')).toBe('https://gw.example')
  expect(geminiBaseUrl('https://gw.example/magpie/v1beta//')).toBe(
    'https://gw.example/magpie',
  )
  expect(geminiBaseUrl('https://gw.example/')).toBe('https://gw.example')
  expect(geminiBaseUrl('https://gw.example')).toBe('https://gw.example')
  // Only the version at the end.
  expect(geminiBaseUrl('https://gw.example/v1beta/proxy')).toBe(
    'https://gw.example/v1beta/proxy',
  )
  const launch = geminiLaunch(
    input('gemini', {
      lane: 'gemini',
      baseUrl: 'https://gw.example/v1beta/',
    }),
  )
  expect(launch.env.GOOGLE_GEMINI_BASE_URL).toBe('https://gw.example')
})

test('Gemini CLI starts from its own launch directory under the admin policy, with only the bridge and its own home', () => {
  const at = input('gemini', {
    lane: 'gemini',
    baseUrl: 'https://gw.example/v1beta',
  })
  const launch = geminiLaunch(at)
  const policy = join(at.runDir, GEMINI_POLICY_FILE)
  expect(launch.argv).toEqual([
    at.bin,
    '--acp',
    '--approval-mode',
    'default',
    '--admin-policy',
    policy,
    '--allowed-mcp-server-names',
    'qianmo',
  ])
  expect(launch.env).toEqual({
    GEMINI_CLI_HOME: at.home,
    GOOGLE_GEMINI_BASE_URL: 'https://gw.example',
    GEMINI_API_KEY: 'sk-secret',
    GEMINI_MODEL: 'vendor/model-x',
    GEMINI_TELEMETRY_ENABLED: 'false',
    GEMINI_CLI_TRUST_WORKSPACE: 'true',
    GEMINI_CLI_NO_RELAUNCH: 'true',
    QM_GEMINI_BRIDGE_COMMAND: '/usr/local/bin/qm',
    QM_GEMINI_BRIDGE_ARG_0: 'runtime-mcp',
    QM_GEMINI_BRIDGE_ARG_1: '--port',
    QM_GEMINI_BRIDGE_ARG_2: '4100',
    QM_GEMINI_BRIDGE_ARG_3: '--token-file',
    QM_GEMINI_BRIDGE_ARG_4: '/q/t',
  })
  expect(launch.cwd).toBe(join(at.home, 'launch'))
  expect(launch.dirs).toEqual([join(at.home, GEMINI_QMO_SKILLS)])
  expect(launch.files?.map(file => file.path)).toEqual([
    policy,
    join(at.home, '.gemini', 'settings.json'),
    join(at.home, '.gemini', 'extensions', 'qmo', 'gemini-extension.json'),
  ])
  for (const file of launch.files ?? [])
    expect(file.content).not.toContain('sk-secret')
  // The bridge is the node's extension's server, with the long call timeout
  // (`session/new` carries none); the file holds no per-process detail.
  expect(launch.mountsBridge).toBe(true)
  const manifest = launch.files?.[2]?.content ?? ''
  expect(JSON.parse(manifest)).toEqual({
    name: 'qmo',
    version: '1.0.0',
    mcpServers: {
      qianmo: {
        command: `\${QM_GEMINI_BRIDGE_COMMAND}`,
        args: [0, 1, 2, 3, 4].map(at => `\${QM_GEMINI_BRIDGE_ARG_${at}}`),
        timeout: BRIDGE_TIMEOUT_MS,
      },
    },
  })
  expect(manifest).not.toContain('4100')
  expect(geminiExtension(at.bridge).manifest).toBe(manifest)

  expect(
    geminiLaunch({ ...at, headers: { 'X-Tenant': 'a b' } }).env
      .GEMINI_CLI_CUSTOM_HEADERS,
  ).toBe('X-Tenant: a b')
  expect(() => geminiLaunch({ ...at, headers: { 'X-List': 'a, b' } })).toThrow(
    /cannot carry header/,
  )
  expect(() => geminiLaunch({ ...at, lane: 'openai-chat' })).toThrow(
    /does not call the openai-chat lane/,
  )
})

test('the Gemini policy asks by default, frees reads, runs the bridge unasked and turns subagents and the web off', () => {
  const policy = geminiPolicy('qianmo')
  const rules = Bun.TOML.parse(policy) as {
    rule: {
      toolName: string | string[]
      mcpName?: string
      decision: string
      priority: number
    }[]
  }
  expect(rules.rule.map(rule => [rule.decision, rule.priority])).toEqual([
    ['ask_user', 100],
    ['allow', 200],
    ['allow', 400],
    ['deny', 500],
  ])
  const [ask, free, bridge, off] = rules.rule
  expect(ask!.toolName).toBe('*')
  expect(free!.toolName).toContain('read_file')
  expect(free!.toolName).not.toContain('write_file')
  expect(free!.toolName).not.toContain('run_shell_command')
  expect(bridge).toMatchObject({ mcpName: 'qianmo', toolName: '*' })
  expect(off!.toolName).toEqual(
    expect.arrayContaining(['web_fetch', 'google_web_search', 'invoke_agent']),
  )
  // Never a rule for every MCP server: the allow-list keeps the others off.
  expect(rules.rule.filter(rule => rule.mcpName !== undefined)).toHaveLength(1)
  expect(() => geminiPolicy('qianmo"\n[[rule]]')).toThrow(/unexpected bridge/)
})

test('the node’s Gemini settings merge into the agent’s settings.json, every native entry kept, and are written only when missing', () => {
  const home = temp()
  const path = join(home, '.gemini', 'settings.json')
  const fresh = JSON.parse(geminiSettings(path)!) as Record<string, unknown>
  expect(fresh).toEqual({
    privacy: { usageStatisticsEnabled: false },
    hooksConfig: { enabled: false },
    advanced: { ignoreLocalEnv: true },
    security: { auth: { selectedType: 'gateway' } },
  })

  mkdirSync(join(home, '.gemini'), { recursive: true })
  const native = {
    ui: { theme: 'GitHub' },
    mcpServers: { own: { command: 'own-server' } },
    privacy: { usageStatisticsEnabled: true, other: 1 },
    security: { auth: { selectedType: 'oauth-personal' }, folderTrust: {} },
  }
  writeFileSync(path, JSON.stringify(native))
  const merged = geminiSettings(path)!
  expect(JSON.parse(merged)).toEqual({
    ui: { theme: 'GitHub' },
    mcpServers: { own: { command: 'own-server' } },
    privacy: { usageStatisticsEnabled: false, other: 1 },
    security: { auth: { selectedType: 'gateway' }, folderTrust: {} },
    hooksConfig: { enabled: false },
    advanced: { ignoreLocalEnv: true },
  })
  writeFileSync(path, merged)
  expect(geminiSettings(path)).toBeUndefined()
  // Nothing the agent's home already holds is written again.
  const at = input('gemini', { lane: 'gemini', home })
  const extension = join(home, '.gemini', 'extensions', 'qmo')
  mkdirSync(extension, { recursive: true })
  writeFileSync(
    join(extension, 'gemini-extension.json'),
    geminiExtension(at.bridge).manifest,
  )
  expect(geminiLaunch(at).files?.map(file => file.path)).toEqual([
    join(at.runDir, GEMINI_POLICY_FILE),
  ])

  // Never rewritten when the node cannot read it as plain JSON.
  writeFileSync(path, '{ // a comment\n "ui": {} }')
  expect(() => geminiSettings(path)).toThrow(/not plain JSON/)
  writeFileSync(path, '[]')
  expect(() => geminiSettings(path)).toThrow(/not a JSON object/)
})

test('Gemini tool calls: a change to its own config in the workspace or an env file is refused outright; the rest by kind', () => {
  expect(
    geminiToolCall(
      call({ kind: 'edit', paths: ['/work/space/.gemini/settings.json'] }),
    ),
  ).toEqual([
    {
      toolName: 'gemini_config',
      input: { paths: ['/work/space/.gemini/settings.json'] },
    },
  ])
  expect(
    geminiToolCall(call({ kind: 'move', paths: ['/work/space/.env.local'] })),
  ).toMatchObject([{ toolName: 'gemini_config' }])
  expect(
    geminiToolCall(call({ kind: 'edit', paths: ['/work/space/src/a.ts'] })),
  ).toEqual([{ toolName: 'edit', input: { path: '/work/space/src/a.ts' } }])
  expect(
    geminiToolCall(
      call({ kind: 'read', paths: ['/work/space/.gemini/settings.json'] }),
    ),
  ).toEqual([
    { toolName: 'read', input: { path: '/work/space/.gemini/settings.json' } },
  ])
  expect(
    geminiToolCall(call({ kind: 'execute', title: 'ls -la' })),
  ).toMatchObject([{ toolName: 'bash', input: { command: 'ls -la' } }])
})

test('Qwen Code starts with its own home, the node’s system settings layer and the OpenAI route from the environment', () => {
  const at = input('qwen')
  const launch = qwenLaunch(at)
  const settings = join(at.runDir, QWEN_SETTINGS_FILE)
  expect(launch.argv).toEqual([
    at.bin,
    '--acp',
    '--auth-type',
    'openai',
    '--approval-mode',
    'default',
  ])
  expect(launch.env).toEqual({
    HOME: at.home,
    QWEN_HOME: join(at.home, '.qwen'),
    QWEN_CODE_SYSTEM_SETTINGS_PATH: settings,
    OPENAI_BASE_URL: 'https://gw.example/v1',
    OPENAI_API_KEY: 'sk-secret',
    OPENAI_MODEL: 'vendor/model-x',
    QWEN_TELEMETRY_ENABLED: 'false',
    QWEN_USAGE_STATISTICS_ENABLED: 'false',
    QWEN_CODE_LEGACY_MCP_BLOCKING: '1',
  })
  expect(launch.cwd).toBe(join(at.home, 'launch'))
  expect(launch.dirs).toEqual([join(at.home, QWEN_QMO_SKILLS)])
  expect(launch.mountsBridge).toBe(true)
  expect(launch.files).toEqual([{ path: settings, content: qwenSettings(at) }])
  expect(launch.files?.[0]?.content).not.toContain('sk-secret')
  expect(() => qwenLaunch({ ...at, lane: 'anthropic' })).toThrow(
    /does not call the anthropic lane/,
  )
})

test('the Qwen settings layer: core tools only, every change and MCP call asked, the rest refused, and the bridge’s long call timeout', () => {
  const settings = JSON.parse(qwenSettings(input('qwen'))) as {
    tools: { core: string[]; approvalMode: string; toolSearch: unknown }
    permissions: { ask: string[]; deny: string[] }
    mcpServers: Record<string, unknown>
    mcp: { toolIdleTimeoutMs: number }
    skills: { directories: string[] }
    [key: string]: unknown
  }
  // The bridge, and the idle timeout every server shares, outlast qianmo_ask.
  expect(settings.mcpServers).toEqual({
    qianmo: {
      command: '/usr/local/bin/qm',
      args: ['runtime-mcp', '--port', '4100', '--token-file', '/q/t'],
      timeout: BRIDGE_TIMEOUT_MS,
    },
  })
  expect(settings.mcp.toolIdleTimeoutMs).toBe(BRIDGE_TIMEOUT_MS)
  expect(settings.tools.approvalMode).toBe('default')
  expect(settings.tools.toolSearch).toEqual({ threshold: 100 })
  expect(settings.permissions.ask).toEqual([
    'run_shell_command',
    'edit',
    'write_file',
    'mcp__*',
  ])
  expect(settings.permissions.deny).toEqual(
    expect.arrayContaining([
      'agent',
      'tool_search',
      'tool_call',
      'web_fetch',
      'enter_worktree',
      'save_memory',
    ]),
  )
  for (const tool of settings.tools.core)
    expect(settings.permissions.deny).not.toContain(tool)
  expect(settings.skills.directories).toEqual([
    join('/q/runtimes/qwen/coder', QWEN_QMO_SKILLS),
  ])
  expect(settings).toMatchObject({
    privacy: { usageStatisticsEnabled: false },
    telemetry: { enabled: false },
    general: { enableAutoUpdate: false },
    disableAllHooks: true,
  })
})

test('Qwen tool calls go by the name in _meta: commands, writes and MCP calls in the node’s words', () => {
  expect(
    qwenToolCall(
      call({
        title: 'Shell',
        kind: 'execute',
        rawInput: { command: 'ls' },
        meta: { toolName: 'run_shell_command' },
      }),
    ),
  ).toEqual([{ toolName: 'bash', input: { command: 'ls' } }])
  expect(
    qwenToolCall(
      call({
        title: 'WriteFile',
        kind: 'edit',
        rawInput: { file_path: '/work/space/a.txt', content: 'x' },
        meta: { toolName: 'write_file' },
      }),
    ),
  ).toEqual([
    {
      toolName: 'write',
      input: {
        file_path: '/work/space/a.txt',
        content: 'x',
        path: '/work/space/a.txt',
      },
    },
  ])
  expect(
    qwenToolCall(
      call({
        title: 'search (docs MCP Server)',
        kind: 'other',
        rawInput: { q: 'x' },
        meta: { toolName: 'mcp__docs__search' },
      }),
    ),
  ).toEqual([{ toolName: 'mcp__docs__search', input: { q: 'x' } }])
  // Without a name it knows, the generic mapping (here: refused as unknown).
  expect(
    qwenToolCall(call({ title: 'Mystery', meta: { toolName: 'mystery' } })),
  ).toEqual([{ toolName: 'Mystery', input: {} }])
})

test('opencode starts with its own home and XDG directories, the node’s inline config and the key under its own name', () => {
  const at = input('opencode', { contextWindow: 128_000 })
  const launch = opencodeLaunch(at)
  expect(launch.argv).toEqual([at.bin, 'acp'])
  expect(launch.env).toEqual({
    HOME: at.home,
    XDG_CONFIG_HOME: join(at.home, 'config'),
    XDG_DATA_HOME: join(at.home, 'data'),
    XDG_CACHE_HOME: join(at.home, 'cache'),
    XDG_STATE_HOME: join(at.home, 'state'),
    OPENCODE_CONFIG_CONTENT: opencodeConfig(at),
    [OPENCODE_KEY_ENV]: 'sk-secret',
    OPENCODE_DISABLE_AUTOUPDATE: '1',
    OPENCODE_DISABLE_MODELS_FETCH: '1',
    OPENCODE_DISABLE_LSP_DOWNLOAD: '1',
    OPENCODE_DISABLE_PROJECT_CONFIG: '1',
    OPENCODE_DISABLE_CLAUDE_CODE: '1',
    OPENCODE_DISABLE_DEFAULT_PLUGINS: '1',
  })
  expect(launch.env.OPENCODE_CONFIG_CONTENT).not.toContain('sk-secret')
  expect(launch.cwd).toBe(join(at.home, 'launch'))
  expect(launch.dirs).toEqual([join(at.home, OPENCODE_QMO_SKILLS)])
  expect(launch.mountsBridge).toBe(true)
  expect(launch.files).toBeUndefined()
  expect(() => opencodeLaunch({ ...at, lane: 'gemini' })).toThrow(
    /does not call the gemini lane/,
  )
})

test('the opencode config: one gateway provider, asking permissions, the bridge with its long call timeout, refusals back to the model', () => {
  const config = JSON.parse(
    opencodeConfig(input('opencode', { contextWindow: 128_000 })),
  ) as Record<string, unknown> & {
    permission: Record<string, string>
    agent: { build: { permission: unknown } }
    mcp: Record<string, unknown>
    provider: Record<string, Record<string, unknown>>
  }
  expect(config.mcp).toEqual({
    qianmo: {
      type: 'local',
      command: [
        '/usr/local/bin/qm',
        'runtime-mcp',
        '--port',
        '4100',
        '--token-file',
        '/q/t',
      ],
      enabled: true,
      timeout: BRIDGE_TIMEOUT_MS,
    },
  })
  expect(config.model).toBe('qm/vendor/model-x')
  expect(config.enabled_providers).toEqual(['qm'])
  expect(config.provider.qm).toEqual({
    name: 'Qianmo gateway',
    npm: '@ai-sdk/openai-compatible',
    options: {
      baseURL: 'https://gw.example/v1',
      apiKey: `{env:${OPENCODE_KEY_ENV}}`,
    },
    models: {
      'vendor/model-x': { limit: { context: 128_000, output: 32_000 } },
    },
  })
  expect(config.permission).toMatchObject({
    '*': 'ask',
    read: 'allow',
    edit: 'ask',
    bash: 'ask',
    external_directory: 'ask',
    task: 'deny',
    webfetch: 'deny',
    'qianmo_*': 'allow',
  })
  expect(config.agent.build.permission).toEqual(config.permission)
  expect(config).toMatchObject({
    default_agent: 'build',
    share: 'disabled',
    autoupdate: false,
    experimental: { continue_loop_on_deny: true },
    skills: {
      paths: [join('/q/runtimes/opencode/coder', OPENCODE_QMO_SKILLS)],
    },
  })

  const anthropic = JSON.parse(
    opencodeConfig(
      input('opencode', {
        lane: 'anthropic',
        baseUrl: 'https://gw.example/',
        headers: { 'X-Tenant': 't' },
      }),
    ),
  ) as { provider: Record<string, Record<string, unknown>> }
  expect(anthropic.provider.qm).toMatchObject({
    npm: '@ai-sdk/anthropic',
    options: {
      baseURL: 'https://gw.example/v1',
      headers: { 'X-Tenant': 't' },
    },
    models: { 'vendor/model-x': {} },
  })
})

test('opencode tool calls: an MCP tool by its permission key, its own tools by kind', () => {
  expect(
    opencodeToolCall(
      call({ title: 'docs_search', kind: 'other', rawInput: { q: 'x' } }),
    ),
  ).toEqual([{ toolName: 'mcp__docs__search', input: { q: 'x' } }])
  expect(opencodeToolCall(call({ title: 'crm_find_customer' }))).toEqual([
    { toolName: 'mcp__crm__find_customer', input: {} },
  ])
  expect(
    opencodeToolCall(
      call({ title: 'bash', kind: 'execute', rawInput: { command: 'ls' } }),
    ),
  ).toEqual([{ toolName: 'bash', input: { command: 'ls' } }])
  // Its own permission keys never name a server.
  expect(opencodeToolCall(call({ title: 'external_directory' }))).toEqual([
    { toolName: 'external_directory', input: {} },
  ])
  expect(
    opencodeToolCall(
      call({
        title: 'write',
        kind: 'edit',
        rawInput: { filePath: '/work/space/a.txt' },
        paths: ['/work/space/a.txt'],
      }),
    ),
  ).toEqual([
    {
      toolName: 'edit',
      input: { filePath: '/work/space/a.txt', path: '/work/space/a.txt' },
    },
  ])
})
