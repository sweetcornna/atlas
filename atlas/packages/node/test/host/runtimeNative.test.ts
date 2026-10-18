// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * P36.7 (`harness-backends.md` §7): one environment for the resident
 * process, the official frontend and the native operations; the pin layer
 * per runtime; connectors under `qm-` and out of native files; the Codex
 * trust leak; native operations (argv, sources, reserved names, the lock);
 * the runtime lock between `qm runtime open` and the pool.
 */

import { afterEach, expect, test } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { qianmoConfigPath } from '@qianmo/paths'
import { OmpResidentTurnPort } from '@qianmo/resident'
import { OutboundPolicy } from '../../src/commands/outboundPolicy.js'
import { frontendLaunch } from '../../src/commands/runtimeOpen.js'
import type { AgentExtensions } from '../../src/host/extensions.js'
import { codexArgv } from '../../src/host/runtimes/codex.js'
import {
  type NativeExtensionsReply,
  RUNTIME_EXT_ERRORS,
} from '../../src/host/runtimes/contract.js'
import {
  acquireChangeLock,
  acquireFrontendLock,
  changeHolds,
  holdsFrontendLock,
  readFrontendAck,
  readFrontendLock,
  releaseChangeLock,
  releaseFrontendLock,
} from '../../src/host/runtimes/frontendLock.js'
import { GEMINI_TRUST_RECORD } from '../../src/host/runtimes/gemini.js'
import {
  type HarnessRun,
  NativeExtensions,
  parseNativeSource,
} from '../../src/host/runtimes/nativeExt.js'
import {
  type ExternalLaunch,
  ExternalRuntimePool,
  type ExternalRuntimeSpawn,
} from '../../src/host/runtimes/pool.js'
import { runtimeDirs, runtimeEnv } from '../../src/host/runtimes/runtimeEnv.js'
import { isolatedRoot } from '../providers/fake.js'
import { assertScratchConfigRoot } from './realHarnessGuard.js'

const fixtures = join(import.meta.dir, 'fixtures')
const FAKE: Record<string, string> = {
  'claude-code': join(fixtures, 'fake-claude-code.runner.ts'),
  codex: join(fixtures, 'fake-codex.runner.ts'),
}
const RUNTIMES = ['claude-code', 'codex', 'dsh', 'gemini', 'qwen', 'opencode']
const LANES: Record<string, ExternalLaunch['lane']> = {
  'claude-code': 'anthropic',
  codex: 'openai-responses',
  dsh: 'openai-chat',
  gemini: 'gemini',
  qwen: 'openai-chat',
  opencode: 'openai-chat',
}

let cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const step of cleanups.splice(0).reverse()) await step()
})

function scratch(): { root: string; workspace: string } {
  const root = isolatedRoot()
  cleanups.push(() => root.dispose())
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'qm-p367-ws-')))
  cleanups.push(() => rmSync(workspace, { recursive: true, force: true }))
  return { root: root.root, workspace }
}

function route(runtime: string) {
  return {
    model: 'vendor/model-x',
    baseUrl:
      runtime === 'gemini' ? 'https://gw.example' : 'https://gw.example/v1',
    apiKey: 'sk-route',
  }
}

/** A pool whose processes are captured; `fake` runs a fixture for them. */
function pool(
  runtime: string,
  workspace: string,
  options: {
    readonly fake?: boolean
    readonly extensions?: AgentExtensions
    readonly env?: Record<string, string>
    readonly permission?: () => boolean
    readonly allowWorkspaceEdits?: boolean
  } = {},
) {
  const launches: ExternalRuntimeSpawn[] = []
  const children: ChildProcess[] = []
  const agent = { agent: 'coder', cwd: workspace, runtime }
  const created = new ExternalRuntimePool({
    agents: [agent],
    resolveLaunch: () => ({ ...route(runtime), lane: LANES[runtime] }),
    memoryRoot: join(workspace, '..', 'memory'),
    allowWorkspaceEdits: options.allowWorkspaceEdits ?? false,
    hostTools: { announce: async () => ({ status: 'sent' }) },
    ...(options.extensions === undefined
      ? {}
      : { extensions: () => options.extensions! }),
    mcpArgv: args => ['/usr/bin/false', ...args],
    requestPermission: async () => options.permission?.() ?? false,
    spawn: input => {
      launches.push(input)
      // A fixture speaks the runtime's protocol; otherwise the process ends
      // at once and only its launch is looked at.
      const child =
        options.fake === true
          ? spawn(process.execPath, [FAKE[runtime]!, ...input.argv.slice(1)], {
              cwd: input.cwd,
              env: { ...input.env, ...options.env },
              stdio: ['pipe', 'pipe', 'pipe'],
            })
          : spawn(process.execPath, ['-e', ''], {
              stdio: ['pipe', 'pipe', 'pipe'],
            })
      children.push(child)
      return child
    },
  })
  cleanups.push(async () => {
    await created.stop()
    for (const child of children)
      if (child.exitCode === null && child.signalCode === null) child.kill()
  })
  return { pool: created, agent, launches }
}

/** Native operations with every command recorded and answered by `reply`. */
function native(
  runtime: string,
  workspace: string,
  reply: (argv: readonly string[]) => string = () => '[]',
) {
  const calls: {
    argv: readonly string[]
    env: Record<string, string>
    cwd: string
  }[] = []
  const invalidated: string[] = []
  const run: HarnessRun = async (argv, options) => {
    calls.push({ argv, env: options.env, cwd: options.cwd })
    return { code: 0, stdout: reply(argv), stderr: '' }
  }
  const ext = new NativeExtensions({
    agents: [{ agent: 'coder', cwd: workspace }],
    runtimeOf: () => runtime,
    bins: { [runtime]: `/opt/${runtime}` },
    invalidate: async agent => {
      invalidated.push(agent)
    },
    run,
  })
  return { ext, calls, invalidated }
}

test('one environment: the pool, the frontend and the native operations see the same state (P36.7)', async () => {
  const { root, workspace } = scratch()
  // dsh's web app beside its executable, as an install has it.
  const dshBin = join(root, 'dsh', 'node_modules', '.bin', 'dsh')
  mkdirSync(join(root, 'dsh', 'node_modules', '.bin'), { recursive: true })
  writeFileSync(dshBin, '')
  const app = join(root, 'dsh', 'node_modules', '@deepseek-ai', 'dsh-web-app')
  mkdirSync(app, { recursive: true })
  writeFileSync(join(app, 'cordis.patch.yml'), '')
  for (const runtime of RUNTIMES) {
    const expected = runtimeEnv(runtime, 'coder', route(runtime))
    const bare = runtimeEnv(runtime, 'coder')
    // The resident process.
    const { pool: made, agent, launches } = pool(runtime, workspace)
    const session = await made.newSession(agent)
    await made.channelFor(session).catch(() => {})
    const spawned = launches[0]!
    for (const [name, value] of Object.entries(expected))
      expect([runtime, name, spawned.env[name]]).toEqual([runtime, name, value])
    // The frontend.
    const opened = await frontendLaunch({
      agent: 'coder',
      runtime,
      bin: runtime === 'dsh' ? dshBin : `/opt/${runtime}`,
      cwd: workspace,
      route: { ...route(runtime), lane: LANES[runtime]! },
      web: false,
      nonce: 'n1',
    })
    for (const [name, value] of Object.entries(expected))
      expect([runtime, name, opened.env[name]]).toEqual([runtime, name, value])
    if (opened.runDir) rmSync(opened.runDir, { recursive: true, force: true })
    // The native operations: no key, the agent's empty launch directory.
    const { ext, calls } = native(runtime, workspace)
    if (runtime === 'dsh') await ext.list('coder')
    else
      await ext.install({
        agent: 'coder',
        kind: 'mcp',
        name: 'own',
        source: 'own-server',
        command: 'own-server',
      })
    expect(calls[0]!.env).toEqual(bare)
    expect(calls[0]!.cwd).toBe(runtimeDirs(runtime, 'coder').launchDir)
    expect(existsSync(calls[0]!.cwd)).toBe(true)
    for (const [name, value] of Object.entries(bare))
      expect([runtime, name, spawned.env[name]]).toEqual([runtime, name, value])
  }
  // Per-agent HOME where the harness reads the account's home otherwise.
  for (const runtime of ['gemini', 'qwen', 'opencode'])
    expect(runtimeEnv(runtime, 'coder').HOME).toBe(
      join(root, 'runtimes', runtime, 'coder'),
    )
})

const CONNECTORS: AgentExtensions = {
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
      headers: { Authorization: 'Bearer crm-secret' },
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

test('Codex: connectors ride the session overrides as qm-*, secrets off the command line and out of config.toml', async () => {
  const { root, workspace } = scratch()
  const {
    pool: made,
    agent,
    launches,
  } = pool('codex', workspace, {
    fake: true,
    extensions: CONNECTORS,
  })
  const session = await made.newSession(agent)
  const channel = await made.channelFor(session)
  expect(channel.alive).toBe(true)
  const { argv, env } = launches[0]!
  const overrides = argv.filter((_arg, at) => argv[at - 1] === '-c')
  const docs = overrides.find(one => one.startsWith('mcp_servers.qm-docs='))!
  const envFile = join(
    launches[0]!.sessionDir,
    'runtime-launch',
    'qm-docs.env.json',
  )
  expect(docs).toBe(
    `mcp_servers.qm-docs={ "command" = "/usr/bin/false", "args" = ["mcp-exec", "--env-file", ${JSON.stringify(envFile)}, "--", "docs-mcp", "--fast"], "default_tools_approval_mode" = "approve" }`,
  )
  expect(JSON.parse(readFileSync(envFile, 'utf8'))).toEqual({
    DOCS_TOKEN: 'secret-value',
  })
  expect(overrides).toContain(
    'mcp_servers.qm-crm={ "url" = "https://crm.example/mcp", "env_http_headers" = { "Authorization" = "QM_SECRET_1" }, "default_tools_approval_mode" = "prompt" }',
  )
  expect(env.QM_SECRET_1).toBe('Bearer crm-secret')
  // Codex has no SSE; no unprefixed name; no secret on the command line.
  expect(overrides.some(one => one.includes('feed'))).toBe(false)
  expect(overrides.some(one => /^mcp_servers\.(docs|crm)\b/.test(one))).toBe(
    false,
  )
  expect(argv.join(' ')).not.toContain('secret-value')
  expect(argv.join(' ')).not.toContain('crm-secret')
  // Nothing written into the agent's own files.
  expect(
    existsSync(join(root, 'runtimes', 'codex', 'coder', 'config.toml')),
  ).toBe(false)
  made.closeSession(session)
  expect(existsSync(envFile)).toBe(false)
})

test('Codex trust leak (P36.7 security fix): the workspace is never trusted, and native tools ask whatever was persisted', async () => {
  const { root, workspace } = scratch()
  // The workspace inside a repository: Codex would key trust on its root.
  const repo = join(workspace, 'repo')
  mkdirSync(join(repo, '.git'), { recursive: true })
  mkdirSync(join(repo, 'pkg'))
  const threadLog = join(root, 'threads.ndjson')
  const nativeState = {
    servers: [
      { name: 'usermcp', tools: { ping: {} } },
      { name: 'cxbundled', pluginId: 'probe@market', tools: { run: {} } },
      { name: 'qm-docs', tools: { search: {} } },
      { name: 'qianmo', tools: { qianmo_notify: {} } },
    ],
    plugins: [
      { id: 'probe@market', installed: true, enabled: true },
      { id: 'off@market', installed: true, enabled: false },
    ],
    skills: [
      { scope: 'repo', path: join(repo, '.agents', 'skills', 'x', 'SKILL.md') },
      { scope: 'user', path: '/h/skills/y/SKILL.md' },
    ],
  }
  const {
    pool: made,
    agent,
    launches,
  } = pool('codex', join(repo, 'pkg'), {
    fake: true,
    allowWorkspaceEdits: true,
    env: {
      QIANMO_FIXTURE_THREAD_LOG: threadLog,
      QIANMO_FAKE_CODEX_NATIVE: JSON.stringify(nativeState),
    },
  })
  const session = await made.newSession(agent)
  await made.channelFor(session)
  const argv = launches[0]!.argv
  const overrides = argv.filter((_arg, at) => argv[at - 1] === '-c')
  expect(overrides).toContain(
    `projects={ ${JSON.stringify(join(repo, 'pkg'))} = { "trust_level" = "untrusted" }, ${JSON.stringify(repo)} = { "trust_level" = "untrusted" } }`,
  )
  expect(overrides).toContain('project_doc_max_bytes=0')
  expect(argv.join(' ')).toContain('--disable hooks')
  const started = JSON.parse(readFileSync(threadLog, 'utf8').split('\n')[0]!)
  expect(started.params.approvalsReviewer).toBe('user')
  expect(started.params.sandbox).toBe('workspace-write')
  expect(started.params.config).toEqual({
    'mcp_servers.usermcp.tools.ping.approval_mode': 'prompt',
    plugins: {
      'probe@market': {
        enabled: true,
        mcp_servers: {
          cxbundled: { tools: { run: { approval_mode: 'prompt' } } },
        },
      },
      'off@market': { enabled: false },
    },
    'skills.config': [
      {
        path: join(repo, '.agents', 'skills', 'x', 'SKILL.md'),
        enabled: false,
      },
    ],
  })
})

const CODEX = Bun.which('codex')

test.skipIf(CODEX === null)(
  'real Codex: thread/start with workspace-write persists trust without the pin, and not with it',
  async () => {
    const { root } = scratch()
    assertScratchConfigRoot()
    const home = process.env.HOME
    process.env.HOME = join(root, 'home')
    mkdirSync(process.env.HOME)
    cleanups.push(() => {
      process.env.HOME = home
    })
    const persisted = async (pinned: boolean): Promise<string> => {
      const workspace = realpathSync(
        mkdtempSync(join(tmpdir(), 'qm-p367-trust-')),
      )
      cleanups.push(() => rmSync(workspace, { recursive: true, force: true }))
      mkdirSync(join(workspace, '.git'))
      // A project config that would load once the project is trusted.
      mkdirSync(join(workspace, '.codex'))
      writeFileSync(
        join(workspace, '.codex', 'config.toml'),
        '[mcp_servers.cxproj]\ncommand = "/usr/bin/false"\ndefault_tools_approval_mode = "approve"\n',
      )
      const agent = `coder${pinned ? 'p' : 'u'}`
      const launches: ExternalRuntimeSpawn[] = []
      const made = new ExternalRuntimePool({
        agents: [{ agent, cwd: workspace, runtime: 'codex' }],
        resolveLaunch: () => ({
          model: 'fake-model',
          baseUrl: 'http://127.0.0.1:9/v1',
          apiKey: 'sk-fake',
        }),
        bins: { codex: CODEX! },
        memoryRoot: join(root, 'memory'),
        allowWorkspaceEdits: true,
        hostTools: { announce: async () => ({ status: 'sent' }) },
        mcpArgv: () => ['/usr/bin/false'],
        spawn: input => {
          launches.push(input)
          // The control run: the same process without the trust pins.
          const argv = pinned
            ? input.argv
            : input.argv.filter(
                (arg, at, all) =>
                  !/^(projects|project_doc_max_bytes)=/.test(arg) &&
                  !/^(projects|project_doc_max_bytes)=/.test(all[at + 1] ?? ''),
              )
          return spawn(argv[0]!, argv.slice(1), {
            cwd: input.cwd,
            env: input.env,
            stdio: ['pipe', 'pipe', 'pipe'],
          })
        },
      })
      cleanups.push(() => made.stop())
      const session = await made.newSession({ agent, cwd: workspace })
      await made.channelFor(session)
      await made.stop()
      const config = join(root, 'runtimes', 'codex', agent, 'config.toml')
      return existsSync(config) ? readFileSync(config, 'utf8') : ''
    }
    // The leak as it was: the first workspace-write thread trusts the project.
    expect(await persisted(false)).toContain('trust_level = "trusted"')
    // With the pin layer nothing is persisted.
    expect(await persisted(true)).not.toContain('trusted')
  },
  120_000,
)

test('the Claude Code pin layer and the Gemini, Qwen and opencode allowlists name the connectors', async () => {
  const { workspace } = scratch()
  for (const runtime of ['gemini', 'qwen']) {
    const {
      pool: made,
      agent,
      launches,
    } = pool(runtime, workspace, {
      extensions: CONNECTORS,
    })
    const session = await made.newSession(agent)
    await made.channelFor(session).catch(() => {})
    const argv = launches[0]!.argv
    expect(argv[argv.indexOf('--allowed-mcp-server-names') + 1]).toBe(
      'qianmo,qm-docs,qm-crm,qm-feed',
    )
  }
  const { pool: oc, agent, launches } = pool('opencode', workspace)
  await oc.channelFor(await oc.newSession(agent)).catch(() => {})
  const argv = launches[0]!.argv
  expect(argv.slice(1, 4)).toEqual(['acp', '--pure', '--port'])
  expect(Number(argv[4])).toBeGreaterThan(0)
  expect(launches[0]!.env.OPENCODE_SERVER_PASSWORD).toMatch(/^[0-9a-f-]{36}$/)
})

test('Gemini: trust on the agent’s own servers is taken off before a start and after a native operation, and reported', async () => {
  const { workspace } = scratch()
  const home = runtimeDirs('gemini', 'coder').home
  mkdirSync(join(home, '.gemini'), { recursive: true })
  const settings = join(home, '.gemini', 'settings.json')
  writeFileSync(
    settings,
    JSON.stringify({
      ui: { theme: 'GitHub' },
      mcpServers: {
        own: { command: 'own-server', trust: true },
        other: { command: 'other' },
      },
    }),
  )
  const { ext } = native('gemini', workspace)
  const listed = await ext.list('coder')
  expect(listed.notes).toContain('已撤销预授权：own')
  expect(
    listed.items.filter(item => item.kind === 'mcp').map(item => item.name),
  ).toEqual(['other', 'own'])
  const after = JSON.parse(readFileSync(settings, 'utf8'))
  expect(after.mcpServers.own).toEqual({ command: 'own-server' })
  expect(after.ui).toEqual({ theme: 'GitHub' })
  expect(
    JSON.parse(readFileSync(join(home, GEMINI_TRUST_RECORD), 'utf8')),
  ).toEqual(['own'])
  // A start does the same, and allows the agent's own servers by name.
  writeFileSync(
    settings,
    JSON.stringify({ mcpServers: { own: { command: 'x', trust: true } } }),
  )
  const { pool: made, agent, launches } = pool('gemini', workspace)
  await made.channelFor(await made.newSession(agent)).catch(() => {})
  expect(JSON.parse(readFileSync(settings, 'utf8')).mcpServers.own.trust).toBe(
    undefined,
  )
  const argv = launches[0]!.argv
  expect(argv[argv.indexOf('--allowed-mcp-server-names') + 1]).toBe(
    'qianmo,own',
  )
})

test('Gemini: listing leaves settings.json alone while its frontend or a change holds it', async () => {
  const { workspace } = scratch()
  const home = runtimeDirs('gemini', 'coder').home
  mkdirSync(join(home, '.gemini'), { recursive: true })
  const settings = join(home, '.gemini', 'settings.json')
  const before = JSON.stringify({
    mcpServers: { own: { command: 'own-server', trust: true } },
  })
  writeFileSync(settings, before)
  const { ext } = native('gemini', workspace)
  const frontend = acquireFrontendLock('coder', 'gemini')!
  expect((await ext.list('coder')).notes).not.toContain('已撤销预授权：own')
  expect(readFileSync(settings, 'utf8')).toBe(before)
  releaseFrontendLock('coder', frontend)
  const change = acquireChangeLock('coder', 'gemini')!
  await ext.list('coder')
  expect(readFileSync(settings, 'utf8')).toBe(before)
  releaseChangeLock('coder', change)
  expect((await ext.list('coder')).notes).toContain('已撤销预授权：own')
  expect(JSON.parse(readFileSync(settings, 'utf8')).mcpServers.own).toEqual({
    command: 'own-server',
  })
})

test('a change that went through is reported done even when listing again fails', async () => {
  const { workspace } = scratch()
  const { ext, calls } = native('gemini', workspace, argv => {
    if (argv.includes('list')) throw new Error('list timed out')
    return '[]'
  })
  const outcome = await ext.control(
    'runtime.ext.install',
    { agent: 'coder', kind: 'plugin', source: 'team/ext' },
    {} as never,
  )
  expect(outcome).toMatchObject({
    ok: true,
    value: { agent: 'coder', runtime: 'gemini', changed: true },
  })
  const value = (outcome as { value: Record<string, unknown> }).value
  expect(value.items).toBeUndefined()
  expect(value.notes).toContain('已完成，但重新列出失败：list timed out')
  expect(calls.some(call => call.argv.includes('install'))).toBe(true)
  // A change that failed is still a failure.
  const { ext: failing } = native('gemini', workspace, () => {
    throw new Error('install refused')
  })
  expect(
    await failing.control(
      'runtime.ext.install',
      { agent: 'coder', kind: 'plugin', source: 'team/ext' },
      {} as never,
    ),
  ).toMatchObject({ ok: false })
})

test('native sources: GitHub, npm and marketplaces; credentials, other hosts, traversal and flags refused', () => {
  expect(parseNativeSource('team/tools')).toEqual({
    kind: 'github',
    repo: 'team/tools',
    path: '',
  })
  expect(parseNativeSource('team/tools/skills/review#v1')).toEqual({
    kind: 'github',
    repo: 'team/tools',
    path: 'skills/review',
    ref: 'v1',
  })
  expect(
    parseNativeSource('https://github.com/team/tools/tree/main/skills/review'),
  ).toEqual({
    kind: 'github',
    repo: 'team/tools',
    path: 'skills/review',
    ref: 'main',
  })
  expect(parseNativeSource('https://github.com/team/tools.git')).toMatchObject({
    repo: 'team/tools',
  })
  expect(parseNativeSource('@scope/pkg@1.2.3')).toEqual({
    kind: 'npm',
    spec: '@scope/pkg@1.2.3',
    name: '@scope/pkg',
  })
  expect(parseNativeSource('left-pad')).toMatchObject({ kind: 'npm' })
  // `name@word`: an exact version is npm, anything else a marketplace.
  expect(parseNativeSource('pkg@2.0.0')).toMatchObject({ kind: 'npm' })
  expect(parseNativeSource('probe@market')).toEqual({
    kind: 'market',
    plugin: 'probe',
    market: 'market',
  })
  for (const bad of [
    'https://user:pw@github.com/team/tools',
    'https://gitlab.com/team/tools',
    'http://github.com/team/tools',
    'https://github.com/team/tools?x=1',
    'team/../tools',
    'team/tools/../../etc',
    '--registry=https://evil',
    '-x',
    'git@github.com:team/tools.git',
    'file:///etc',
    '@scope/pkg@latest',
    'team/tools#../x',
    'a b',
    'team/\u0007tools',
  ])
    expect([bad, typeof parseNativeSource(bad)]).toEqual([bad, 'string'])
})

test('native MCP commands: the server command after its separator, connector names refused, nothing a flag', async () => {
  const { workspace } = scratch()
  const add = {
    agent: 'coder',
    kind: 'mcp',
    name: 'own',
    source: 'npx',
    command: 'npx',
    args: ['-y', '@scope/server', '--stdio'],
  }
  const expected: Record<string, readonly string[]> = {
    'claude-code': [
      'mcp',
      'add',
      '-s',
      'user',
      'own',
      '--',
      'npx',
      '-y',
      '@scope/server',
      '--stdio',
    ],
    codex: ['mcp', 'add', 'own', '--', 'npx', '-y', '@scope/server', '--stdio'],
    // Their parser needs the command before the separator.
    gemini: [
      'mcp',
      'add',
      '-s',
      'user',
      'own',
      'npx',
      '--',
      '-y',
      '@scope/server',
      '--stdio',
    ],
    qwen: [
      'mcp',
      'add',
      '-s',
      'user',
      'own',
      'npx',
      '--',
      '-y',
      '@scope/server',
      '--stdio',
    ],
    opencode: [
      'mcp',
      'add',
      'own',
      '--',
      'npx',
      '-y',
      '@scope/server',
      '--stdio',
    ],
  }
  for (const [runtime, argv] of Object.entries(expected)) {
    const { ext, calls, invalidated } = native(runtime, workspace)
    const outcome = await ext.control('runtime.ext.install', add, {} as never)
    expect([runtime, outcome.ok]).toEqual([runtime, true])
    expect(calls[0]!.argv).toEqual([`/opt/${runtime}`, ...argv])
    expect(invalidated).toEqual(['coder'])
  }
  const { ext } = native('codex', workspace)
  const url = await ext.control(
    'runtime.ext.install',
    {
      agent: 'coder',
      kind: 'mcp',
      name: 'web',
      source: 'https://mcp.example/x',
      url: 'https://mcp.example/x',
    },
    {} as never,
  )
  expect(url.ok).toBe(true)
  for (const [args, code] of [
    [{ ...add, name: 'qm-docs' }, RUNTIME_EXT_ERRORS.badSource],
    [{ ...add, name: 'qianmo' }, RUNTIME_EXT_ERRORS.badSource],
    [{ ...add, name: '-x' }, RUNTIME_EXT_ERRORS.badSource],
    [{ ...add, command: '-c', source: '-c' }, RUNTIME_EXT_ERRORS.badSource],
    [{ ...add, source: 'other' }, RUNTIME_EXT_ERRORS.badSource],
    [
      {
        agent: 'coder',
        kind: 'mcp',
        name: 'w',
        source: 'https://u:p@x.example',
        url: 'https://u:p@x.example',
      },
      RUNTIME_EXT_ERRORS.badSource,
    ],
  ] as const)
    expect(
      await ext.control('runtime.ext.install', args, {} as never),
    ).toMatchObject({
      ok: false,
      code,
    })
  const removed = await ext.control(
    'runtime.ext.remove',
    { agent: 'coder', kind: 'mcp', name: 'qm-docs' },
    {} as never,
  )
  expect(removed).toMatchObject({
    ok: false,
    code: RUNTIME_EXT_ERRORS.badSource,
  })
  // One added in the harness's own frontend may carry dots: it goes by that
  // name. Adding one does not (a harness config path splits on dots).
  const dotted = native('gemini', workspace)
  expect(
    await dotted.ext.control(
      'runtime.ext.remove',
      { agent: 'coder', kind: 'mcp', name: 'docs.v2' },
      {} as never,
    ),
  ).toMatchObject({ ok: true })
  expect(dotted.calls[0]!.argv.slice(1)).toEqual([
    'mcp',
    'remove',
    '-s',
    'user',
    'docs.v2',
  ])
  for (const [op, name] of [
    ['runtime.ext.remove', 'docs..v2'],
    ['runtime.ext.remove', '.docs'],
    ['runtime.ext.install', 'docs.v2'],
  ] as const)
    expect(
      await dotted.ext.control(
        op,
        { agent: 'coder', kind: 'mcp', name, command: 'npx' },
        {} as never,
      ),
    ).toMatchObject({ ok: false, code: RUNTIME_EXT_ERRORS.badSource })
  // dsh has no command for MCP servers: its web frontend does it.
  const dsh = native('dsh', workspace)
  expect(
    await dsh.ext.control('runtime.ext.install', add, {} as never),
  ).toMatchObject({
    ok: false,
    code: RUNTIME_EXT_ERRORS.unsupported,
  })
})

test('native plugins: each harness’s own command and source kinds; the node’s own items stay out', async () => {
  const { workspace } = scratch()
  const install = async (
    runtime: string,
    source: string,
    name?: string,
    reply?: (argv: readonly string[]) => string,
  ) => {
    const made = native(runtime, workspace, reply)
    const outcome = await made.ext.control(
      'runtime.ext.install',
      { agent: 'coder', kind: 'plugin', source, ...(name ? { name } : {}) },
      {} as never,
    )
    return { outcome, argv: made.calls.map(call => call.argv.slice(1)) }
  }
  expect((await install('claude-code', 'probe@market')).argv[0]).toEqual([
    'plugin',
    'install',
    'probe@market',
    '-s',
    'user',
    '--json',
  ])
  const fromRepo = await install('claude-code', 'team/market', 'probe', argv =>
    argv.includes('marketplace') && argv.includes('list')
      ? JSON.stringify([{ name: 'team-market', repo: 'team/market' }])
      : '[]',
  )
  expect(fromRepo.argv.slice(0, 3)).toEqual([
    ['plugin', 'marketplace', 'add', 'team/market'],
    ['plugin', 'marketplace', 'list', '--json'],
    ['plugin', 'install', 'probe@team-market', '-s', 'user', '--json'],
  ])
  const codexRepo = await install('codex', 'team/market#v2', 'probe', argv =>
    argv.includes('marketplace')
      ? JSON.stringify({ marketplaceName: 'team-market' })
      : '{}',
  )
  expect(codexRepo.argv.slice(0, 2)).toEqual([
    ['plugin', 'marketplace', 'add', 'team/market', '--ref', 'v2', '--json'],
    ['plugin', 'add', 'probe@team-market', '--json'],
  ])
  expect((await install('codex', 'mine@qianmo')).outcome).toMatchObject({
    ok: false,
    code: RUNTIME_EXT_ERRORS.badSource,
  })
  // A repository whose marketplace calls itself qianmo: refused, and the
  // marketplace it already added is taken back.
  const reserved = await install('codex', 'evil/market', 'probe', argv =>
    argv.includes('add') ? JSON.stringify({ marketplaceName: 'qianmo' }) : '{}',
  )
  expect(reserved.outcome).toMatchObject({
    ok: false,
    code: RUNTIME_EXT_ERRORS.badSource,
  })
  expect(reserved.argv.slice(0, 2)).toEqual([
    ['plugin', 'marketplace', 'add', 'evil/market', '--json'],
    ['plugin', 'marketplace', 'remove', 'qianmo'],
  ])
  const claudeReserved = await install(
    'claude-code',
    'evil/market',
    'probe',
    argv =>
      argv.includes('list')
        ? JSON.stringify([{ name: 'qianmo', repo: 'evil/market' }])
        : '[]',
  )
  expect(claudeReserved.outcome).toMatchObject({
    ok: false,
    code: RUNTIME_EXT_ERRORS.badSource,
  })
  expect(claudeReserved.argv.slice(0, 3)).toEqual([
    ['plugin', 'marketplace', 'add', 'evil/market'],
    ['plugin', 'marketplace', 'list', '--json'],
    ['plugin', 'marketplace', 'remove', 'qianmo'],
  ])
  expect((await install('codex', 'pkg@1.0.0')).outcome).toMatchObject({
    ok: false,
    code: RUNTIME_EXT_ERRORS.badSource,
  })
  expect((await install('dsh', 'team/bundle#v1')).argv[0]).toEqual([
    'plugin',
    '--profile',
    'acp',
    'add',
    'github:team/bundle#v1',
  ])
  expect((await install('gemini', 'team/ext')).argv[0]).toEqual([
    'extensions',
    'install',
    'https://github.com/team/ext',
    '--consent',
  ])
  expect((await install('qwen', '@scope/ext@1.0.0')).argv[0]).toEqual([
    'extensions',
    'install',
    '@scope/ext@1.0.0',
    '--consent',
  ])
  expect((await install('opencode', 'oc-plugin@0.3.0')).argv[0]).toEqual([
    'plugin',
    'oc-plugin@0.3.0',
    '-g',
  ])
  expect((await install('opencode', 'team/plugin')).outcome).toMatchObject({
    ok: false,
    code: RUNTIME_EXT_ERRORS.badSource,
  })
  // Lists leave out the console's marketplace and connectors.
  const codex = native('codex', workspace, argv =>
    argv.includes('plugin')
      ? JSON.stringify({
          installed: [
            {
              pluginId: 'qianmo@qianmo',
              marketplaceName: 'qianmo',
              enabled: true,
            },
            {
              pluginId: 'probe@market',
              marketplaceName: 'market',
              enabled: true,
              version: '1.0.0',
            },
          ],
        })
      : JSON.stringify([
          { name: 'own', enabled: true },
          { name: 'qm-docs', enabled: true },
        ]),
  )
  const listed = await codex.ext.control(
    'runtime.ext.list',
    { agent: 'coder' },
    {} as never,
  )
  expect(listed).toMatchObject({
    ok: true,
    value: {
      agent: 'coder',
      runtime: 'codex',
      items: [
        {
          kind: 'plugin',
          name: 'probe@market',
          version: '1.0.0',
          enabled: true,
        },
        { kind: 'mcp', name: 'own', enabled: true },
      ],
      openCommand: 'qm runtime open coder',
    },
  })
  // opencode: no remove command; its plain-JSON config is edited.
  const config = join(
    runtimeDirs('opencode', 'coder').home,
    'config',
    'opencode',
  )
  mkdirSync(config, { recursive: true })
  writeFileSync(
    join(config, 'opencode.json'),
    JSON.stringify({
      plugin: ['oc-plugin@0.3.0', 'other'],
      mcp: { own: { type: 'local' } },
    }),
  )
  const oc = native('opencode', workspace)
  const after = await oc.ext.control(
    'runtime.ext.remove',
    { agent: 'coder', kind: 'plugin', name: 'oc-plugin' },
    {} as never,
  )
  expect(after).toMatchObject({ ok: true })
  expect(
    JSON.parse(readFileSync(join(config, 'opencode.json'), 'utf8')).plugin,
  ).toEqual(['other'])
  const value = (after as { value: NativeExtensionsReply }).value
  expect(value.items[0]).toMatchObject({
    name: 'other',
    notLoaded: expect.stringContaining('--pure'),
  })
  expect(value.notes.join()).toContain('不加载 opencode 插件')
})

test('opencode: an MCP server is removed by its own name only, never one the object inherits', async () => {
  const { workspace } = scratch()
  const config = join(
    runtimeDirs('opencode', 'coder').home,
    'config',
    'opencode',
  )
  mkdirSync(config, { recursive: true })
  const file = join(config, 'opencode.json')
  // Compact on purpose: the node writes it back indented, so a rewrite shows.
  const before = JSON.stringify({ mcp: { own: { type: 'local' } } })
  writeFileSync(file, before)
  const oc = native('opencode', workspace)
  for (const name of ['toString', 'constructor', 'hasOwnProperty', 'valueOf']) {
    const outcome = await oc.ext.control(
      'runtime.ext.remove',
      { agent: 'coder', kind: 'mcp', name },
      {} as never,
    )
    expect({ name, outcome }).toMatchObject({
      name,
      outcome: { ok: false, code: RUNTIME_EXT_ERRORS.failed },
    })
  }
  // Nothing was written.
  expect(readFileSync(file, 'utf8')).toBe(before)
  expect(
    await oc.ext.control(
      'runtime.ext.remove',
      { agent: 'coder', kind: 'mcp', name: 'own' },
      {} as never,
    ),
  ).toMatchObject({ ok: true })
  expect(JSON.parse(readFileSync(file, 'utf8')).mcp).toEqual({})
})

test('native changes wait for the official frontend to close; listing does not', async () => {
  const { workspace } = scratch()
  const lock = acquireFrontendLock('coder', 'gemini')!
  expect(acquireFrontendLock('coder', 'gemini')).toBeUndefined()
  const { ext, calls } = native('gemini', workspace)
  expect(
    await ext.control(
      'runtime.ext.install',
      { agent: 'coder', kind: 'plugin', source: 'team/ext' },
      {} as never,
    ),
  ).toMatchObject({ ok: false, code: RUNTIME_EXT_ERRORS.locked })
  expect(calls).toEqual([])
  const listed = await ext.control(
    'runtime.ext.list',
    { agent: 'coder' },
    {} as never,
  )
  expect((listed as { value: { notes: string[] } }).value.notes).toContain(
    '官方前端正开着：安装与卸载要等它退出',
  )
  releaseFrontendLock('coder', lock)
  expect(readFrontendLock('coder')).toBeUndefined()
  // A lock left by a process that is gone is taken over.
  writeFileSync(
    qianmoConfigPath('runtimes', 'locks', 'coder.lock'),
    JSON.stringify({
      pid: 2 ** 22 + 7,
      nonce: 'old',
      runtime: 'gemini',
      at: 1,
    }),
  )
  expect(readFrontendLock('coder')).toBeUndefined()
  const taken = acquireFrontendLock('coder', 'gemini')
  expect(taken?.pid).toBe(process.pid)
  releaseFrontendLock('coder', taken!)
})

test('a native change holds its own lock while it runs, which the frontend looks for', async () => {
  const { workspace } = scratch()
  const during: boolean[] = []
  const { ext } = native('gemini', workspace, argv => {
    if (argv.includes('install')) during.push(changeHolds('coder'))
    return '[]'
  })
  await ext.control(
    'runtime.ext.install',
    { agent: 'coder', kind: 'plugin', source: 'team/ext' },
    {} as never,
  )
  expect(during).toEqual([true])
  expect(changeHolds('coder')).toBe(false)
  // One change at a time, across processes too.
  const held = acquireChangeLock('coder', 'gemini')!
  expect(acquireChangeLock('coder', 'gemini')).toBeUndefined()
  expect(
    await ext.control(
      'runtime.ext.install',
      { agent: 'coder', kind: 'plugin', source: 'team/ext' },
      {} as never,
    ),
  ).toMatchObject({ ok: false, code: RUNTIME_EXT_ERRORS.locked })
  releaseChangeLock('coder', held)
  expect(changeHolds('coder')).toBe(false)
})

test('a frontend lock appears whole; an empty or dead one is taken over and its old holder learns it', () => {
  scratch()
  const dir = qianmoConfigPath('runtimes', 'locks')
  mkdirSync(dir, { recursive: true })
  // What a taker that died between creating and writing would leave.
  writeFileSync(join(dir, 'coder.lock'), '')
  const lock = acquireFrontendLock('coder', 'gemini')!
  expect(lock.pid).toBe(process.pid)
  expect(JSON.parse(readFileSync(join(dir, 'coder.lock'), 'utf8'))).toEqual(
    lock,
  )
  expect(readdirSync(dir)).toEqual(['coder.lock'])
  // A live holder is never moved aside.
  expect(acquireFrontendLock('coder', 'gemini')).toBeUndefined()
  expect(holdsFrontendLock('coder', lock)).toBe(true)
  releaseFrontendLock('coder', lock)
  const dead = { pid: 2 ** 22 + 7, nonce: 'old', runtime: 'gemini', at: 1 }
  writeFileSync(join(dir, 'coder.lock'), JSON.stringify(dead))
  const next = acquireFrontendLock('coder', 'gemini')!
  expect(holdsFrontendLock('coder', dead)).toBe(false)
  expect(holdsFrontendLock('coder', next)).toBe(true)
  releaseFrontendLock('coder', next)
  expect(readdirSync(dir)).toEqual([])
})

test('the pool yields an idle agent to the frontend, refuses a busy one, and starts nothing while the lock is held', async () => {
  const { workspace } = scratch()
  const {
    pool: made,
    agent,
    launches,
  } = pool('claude-code', workspace, {
    fake: true,
  })
  const turn = (session: string, id: string, prompt: string) =>
    new OmpResidentTurnPort(made).execute(
      { sessionId: session, messageId: id, prompt },
      async () => {},
    )
  const session = await made.newSession(agent)
  expect((await turn(session, 'a', 'hello')).outcome).toBe('completed')
  const first = await made.channelFor(session)
  // Busy: a turn is running when the pool looks.
  const channel = first
  const pending = turn(session, 'b', 'hang')
  await Bun.sleep(50)
  const busy = acquireFrontendLock('coder', 'claude-code')!
  const deadline = Date.now() + 3_000
  while (
    readFrontendAck('coder')?.nonce !== busy.nonce &&
    Date.now() < deadline
  )
    await Bun.sleep(50)
  expect(readFrontendAck('coder')).toMatchObject({
    nonce: busy.nonce,
    busy: true,
  })
  releaseFrontendLock('coder', busy)
  await channel.abort()
  await pending
  // Idle: its process is closed before the frontend may start.
  const idle = acquireFrontendLock('coder', 'claude-code')!
  const until = Date.now() + 3_000
  while (readFrontendAck('coder')?.nonce !== idle.nonce && Date.now() < until)
    await Bun.sleep(50)
  expect(readFrontendAck('coder')).toMatchObject({
    nonce: idle.nonce,
    busy: false,
  })
  expect(first.alive).toBe(false)
  // Nothing starts while the frontend holds the agent.
  await expect(made.channelFor(session)).rejects.toThrow(
    /official frontend is open/,
  )
  expect(launches).toHaveLength(1)
  releaseFrontendLock('coder', idle)
  expect((await turn(session, 'c', 'again')).outcome).toBe('completed')
  expect(launches).toHaveLength(2)
})

test('the web frontends listen on loopback behind a secret of the launch; the address is printed, not opened', async () => {
  const { workspace } = scratch()
  const qwen = await frontendLaunch({
    agent: 'coder',
    runtime: 'qwen',
    bin: '/opt/qwen',
    cwd: workspace,
    route: { ...route('qwen'), lane: 'openai-chat' },
    web: true,
    nonce: 'n2',
  })
  expect(qwen.argv.slice(0, 4)).toEqual([
    '/opt/qwen',
    'serve',
    '--hostname',
    '127.0.0.1',
  ])
  expect(qwen.argv).toContain('--require-auth')
  expect(qwen.argv.join(' ')).not.toContain(qwen.env.QWEN_SERVER_TOKEN!)
  expect(qwen.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/)
  expect(qwen.signIn).toBe(`令牌 ${qwen.env.QWEN_SERVER_TOKEN}`)
  const oc = await frontendLaunch({
    agent: 'coder',
    runtime: 'opencode',
    bin: '/opt/opencode',
    cwd: workspace,
    route: { ...route('opencode'), lane: 'openai-chat' },
    web: true,
    nonce: 'n3',
  })
  expect(oc.argv.slice(0, 4)).toEqual([
    '/opt/opencode',
    'serve',
    '--hostname',
    '127.0.0.1',
  ])
  expect(oc.signIn).toBe(
    `用户名 opencode，口令 ${oc.env.OPENCODE_SERVER_PASSWORD}`,
  )
  await expect(
    frontendLaunch({
      agent: 'coder',
      runtime: 'gemini',
      bin: '/opt/gemini',
      cwd: workspace,
      route: { ...route('gemini'), lane: 'gemini' },
      web: true,
      nonce: 'n4',
    }),
  ).rejects.toThrow(/没有网页前端/)
  // Claude Code: the first-run dialogs answered in the agent's own file.
  const claude = await frontendLaunch({
    agent: 'coder',
    runtime: 'claude-code',
    bin: '/opt/claude',
    cwd: workspace,
    route: { ...route('claude-code'), lane: 'anthropic' },
    web: false,
    nonce: 'n5',
  })
  expect(claude.argv).toContain('--setting-sources')
  expect(claude.argv[claude.argv.indexOf('--permission-mode') + 1]).toBe(
    'default',
  )
  expect(claude.argv).not.toContain('--permission-prompt-tool')
  const seeded = JSON.parse(
    readFileSync(
      join(runtimeDirs('claude-code', 'coder').home, '.claude.json'),
      'utf8',
    ),
  )
  expect(seeded).toMatchObject({
    hasCompletedOnboarding: true,
    customApiKeyResponses: { approved: ['sk-route'] },
    projects: { [workspace]: { hasTrustDialogAccepted: true } },
  })
  // Codex: the same pins as the resident process, no bridge.
  const codex = await frontendLaunch({
    agent: 'coder',
    runtime: 'codex',
    bin: '/opt/codex',
    cwd: workspace,
    route: route('codex'),
    web: false,
    nonce: 'n6',
  })
  expect(codex.argv[1]).toBe('--no-daemon')
  expect(codex.argv.join(' ')).toContain('project_doc_max_bytes=0')
  expect(codex.argv.join(' ')).not.toContain('mcp_servers.qianmo')
  expect(
    codexArgv({
      bin: '/opt/codex',
      model: 'vendor/model-x',
      baseUrl: 'https://gw.example/v1',
      keyEnv: 'QIANMO_RUNTIME_KEY',
      workspace,
    }).slice(2),
  ).toEqual(codex.argv.slice(2))
})

/** A codeload tarball of `files` under `<repo>-<commit>/`. */
function tarball(
  root: string,
  commit: string,
  files: Record<string, string>,
): Uint8Array {
  const dir = mkdtempSync(join(root, 'repo-'))
  const top = join(dir, `tools-${commit}`)
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(top, name, '..'), { recursive: true })
    writeFileSync(join(top, name), text)
  }
  const out = join(root, 'skill.tgz')
  expect(
    Bun.spawnSync(['tar', '-czf', out, '-C', dir, `tools-${commit}`]).exitCode,
  ).toBe(0)
  return new Uint8Array(readFileSync(out))
}

test('a skill without a command comes from GitHub at a resolved commit, recorded beside it, and goes again', async () => {
  const { root, workspace } = scratch()
  const commit = 'c'.repeat(40)
  const served = new Map<string, Uint8Array | string>([
    ['https://api.github.com/repos/team/tools/commits/v1', commit],
    [
      `https://codeload.github.com/team/tools/tar.gz/${commit}`,
      tarball(root, commit, {
        'skills/review/SKILL.md':
          '---\nname: review\ndescription: Review\n---\nRead twice.\n',
        'skills/other/README.md': 'no skill here',
      }),
    ],
  ])
  const policy = new OutboundPolicy({
    lookup: async () => [{ address: '140.82.112.9', family: 4 }],
    fetch: async url => {
      const hit = served.get(url)
      return hit === undefined
        ? new Response('missing', { status: 404 })
        : new Response(hit, { status: 200 })
    },
  })
  const ext = new NativeExtensions({
    agents: [{ agent: 'coder', cwd: workspace }],
    runtimeOf: () => 'qwen',
    policy,
    run: async () => ({ code: 0, stdout: '', stderr: '' }),
  })
  const installed = await ext.control(
    'runtime.ext.install',
    { agent: 'coder', kind: 'skill', source: 'team/tools/skills/review#v1' },
    {} as never,
  )
  expect(installed).toMatchObject({ ok: true })
  const dir = join(
    runtimeDirs('qwen', 'coder').home,
    '.qwen',
    'skills',
    'review',
  )
  expect(readFileSync(join(dir, 'SKILL.md'), 'utf8')).toContain('Read twice.')
  expect(
    JSON.parse(readFileSync(join(dir, '.qmo-source.json'), 'utf8')),
  ).toMatchObject({
    repo: 'team/tools',
    path: 'skills/review',
    commit,
  })
  const value = (installed as { value: NativeExtensionsReply }).value
  expect(value.items).toContainEqual({
    kind: 'skill',
    name: 'review',
    enabled: true,
    source: `team/tools@${commit.slice(0, 12)}`,
  })
  expect(value.notes[0]).toContain(`team/tools@${commit.slice(0, 12)}`)
  // A directory without SKILL.md is refused; nothing is left behind.
  expect(
    await ext.control(
      'runtime.ext.install',
      { agent: 'coder', kind: 'skill', source: 'team/tools/skills/other#v1' },
      {} as never,
    ),
  ).toMatchObject({ ok: false, code: RUNTIME_EXT_ERRORS.failed })
  expect(existsSync(join(dir, '..', 'other'))).toBe(false)
  // npm is not a skill source.
  expect(
    await ext.control(
      'runtime.ext.install',
      { agent: 'coder', kind: 'skill', source: '@scope/skill' },
      {} as never,
    ),
  ).toMatchObject({ ok: false, code: RUNTIME_EXT_ERRORS.badSource })
  expect(
    await ext.control(
      'runtime.ext.remove',
      { agent: 'coder', kind: 'skill', name: 'review' },
      {} as never,
    ),
  ).toMatchObject({ ok: true })
  expect(existsSync(dir)).toBe(false)
})
