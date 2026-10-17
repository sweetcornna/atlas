// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Operator-configured extensions on a node (P32 §9): the hub's set is laid
 * out in each runtime's native shape, secrets stay out of what runtimes copy
 * or agents read, GitHub sources are only used when their files match the
 * pinned digest, and only agents whose set changed are recycled.
 */

import { afterEach, beforeEach, expect, test } from 'bun:test'
import {
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
import * as path from 'node:path'
import { OutboundPolicy } from '../../src/commands/outboundPolicy.js'
import {
  codexMcpToml,
  extensionsDigest,
  extensionWireSchema,
  type ExtensionWireEntry,
  type McpProbeTarget,
  NodeExtensions,
} from '../../src/host/extensions.js'
import { treeDigest } from '../../src/host/githubDir.js'

const COMMIT = 'a'.repeat(40)
let root: string
let served: Map<string, Uint8Array>
let changed: string[]
let commands: string[][]
let probes: string[]
let targets: McpProbeTarget[]

function id(n: number): string {
  return `ext-00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
}

/** A codeload tarball of `files` under `<repo>-<commit>/`. */
function tarball(files: Record<string, string>): Uint8Array {
  const dir = mkdtempSync(path.join(root, 'repo-'))
  const top = path.join(dir, `tools-${COMMIT}`)
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(top, name)), { recursive: true })
    writeFileSync(path.join(top, name), text)
  }
  const out = path.join(root, `t-${Math.random()}.tgz`)
  const made = Bun.spawnSync(['tar', '-czf', out, '-C', dir, `tools-${COMMIT}`])
  expect(made.exitCode).toBe(0)
  return new Uint8Array(readFileSync(out))
}

function digestOf(files: Record<string, string>, dir: string): string {
  const at = mkdtempSync(path.join(root, 'digest-'))
  for (const [name, text] of Object.entries(files)) {
    if (!name.startsWith(`${dir}/`)) continue
    const rel = name.slice(dir.length + 1)
    mkdirSync(path.dirname(path.join(at, rel)), { recursive: true })
    writeFileSync(path.join(at, rel), text)
  }
  return treeDigest(at)
}

const policy = () =>
  new OutboundPolicy({
    lookup: async () => [{ address: '140.82.112.9', family: 4 }],
    fetch: async url => {
      const hit = served.get(url)
      return hit === undefined
        ? new Response('missing', { status: 404 })
        : new Response(hit, { status: 200 })
    },
  })

const AGENTS = [
  { agent: 'writer' },
  { agent: 'coder', runtime: 'claude-code' },
  { agent: 'helper', runtime: 'codex' },
] as const

function host(
  overrides: Partial<ConstructorParameters<typeof NodeExtensions>[0]> = {},
): NodeExtensions {
  return new NodeExtensions({
    agents: AGENTS,
    root: path.join(root, 'extensions'),
    codexHome: agent => path.join(root, 'codex', agent),
    codexBin: '/opt/codex',
    policy: policy(),
    run: async (argv, options) => {
      if (argv[0] === '/opt/codex') {
        commands.push([...argv])
        // Codex installs into a home beside the live one (P32 audit 4).
        expect(options.env.CODEX_HOME).toStartWith(
          `${path.join(root, 'codex', 'helper')}.next-`,
        )
        return { code: 0, stdout: '' }
      }
      const done = Bun.spawnSync([...argv], { env: options.env })
      return { code: done.exitCode, stdout: done.stdout.toString() }
    },
    probe: async target => {
      probes.push(target.name)
      targets.push(target)
      return [`mcp__qianmo_mcp_${target.name}_search`]
    },
    mcpExec: args => ['/opt/qm', ...args],
    changed: async agent => {
      changed.push(agent)
    },
    now: () => 1_000,
    ...overrides,
  })
}

const MCP: ExtensionWireEntry = {
  id: id(1),
  kind: 'mcp',
  name: 'docs',
  agents: null,
  transport: 'stdio',
  command: 'docs-mcp',
  args: ['--stdio'],
  env: { DOCS_TOKEN: 'secret-value' },
  approval: 'allow',
}
const SKILL: ExtensionWireEntry = {
  id: id(2),
  kind: 'skill',
  name: 'review',
  agents: ['writer', 'helper'],
  description: 'Review a draft: tone, facts',
  body: 'Read the draft twice.',
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'qm-ext-'))
  served = new Map()
  changed = []
  commands = []
  probes = []
  targets = []
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

test('lays out skills and MCP servers in each runtime’s native shape', async () => {
  const node = host()
  const outcome = await node.apply([MCP, SKILL])
  expect(outcome.ok).toBe(true)
  const base = path.join(root, 'extensions', 'agents')

  // qianmopi: the skills plugin and the MCP plugin; tools from the probe.
  const writer = node.forAgent('writer')!
  expect(writer.ompPluginDirs).toEqual([
    path.join(base, 'writer', 'plugins', 'qianmo'),
    path.join(base, 'writer', 'mcp', 'qianmo-mcp'),
  ])
  expect(writer.mcp[0]!.tools).toEqual(['mcp__qianmo_mcp_docs_search'])
  expect(probes).toEqual(['docs'])
  const skill = readFileSync(
    path.join(
      base,
      'writer',
      'plugins',
      'qianmo',
      'skills',
      'review',
      'SKILL.md',
    ),
    'utf8',
  )
  expect(skill).toContain('name: review')
  expect(skill).toContain('description: "Review a draft: tone, facts"')
  const manifest = JSON.parse(
    readFileSync(
      path.join(base, 'writer', 'plugins', 'qianmo', 'plugin.json'),
      'utf8',
    ),
  )
  expect(manifest.$schema).toContain('agent-plugins.org')
  const mcpFile = path.join(base, 'writer', 'mcp', 'qianmo-mcp', 'mcp.json')
  expect(statSync(mcpFile).mode & 0o077).toBe(0)
  // Through `qm mcp-exec`: only its own variables reach it (P32 audit 9).
  // Agent Plugins only start a command inside the plugin: a script there.
  expect(JSON.parse(readFileSync(mcpFile, 'utf8')).mcpServers.docs).toEqual({
    type: 'stdio',
    command: './bin/qm-mcp-exec',
    args: ['--keep', 'DOCS_TOKEN', '--', 'docs-mcp', '--stdio'],
    env: { DOCS_TOKEN: 'secret-value' },
  })
  const shim = path.join(
    base,
    'writer',
    'mcp',
    'qianmo-mcp',
    'bin',
    'qm-mcp-exec',
  )
  expect(readFileSync(shim, 'utf8')).toContain(`exec '/opt/qm' 'mcp-exec' "$@"`)
  expect(statSync(shim).mode & 0o777).toBe(0o700)
  expect(targets[0]).toMatchObject({
    command: '/opt/qm',
    args: ['mcp-exec', '--keep', 'DOCS_TOKEN', '--', 'docs-mcp', '--stdio'],
    env: { DOCS_TOKEN: 'secret-value' },
  })
  // Secrets are never under the plugins tree an agent may read.
  expect(writer.readableRoots[0]).toBe(path.join(base, 'writer', 'plugins'))
  expect(
    existsSync(path.join(base, 'writer', 'plugins', 'qianmo', 'mcp.json')),
  ).toBe(false)

  // Claude Code: MCP comes through its own config; no skills for it here.
  const coder = node.forAgent('coder')!
  expect(coder.claudePluginDirs).toEqual([])
  expect(coder.mcp.map(server => server.name)).toEqual(['docs'])
  expect(existsSync(path.join(base, 'coder', 'mcp'))).toBe(false)

  // Codex: its own config.toml and its own plugin commands.
  const config = readFileSync(
    path.join(root, 'codex', 'helper', 'config.toml'),
    'utf8',
  )
  expect(config).toContain('[mcp_servers."docs"]')
  expect(config).toContain('default_tools_approval_mode = "approve"')
  expect(config).toContain('"DOCS_TOKEN" = "secret-value"')
  expect(commands).toEqual([
    ['/opt/codex', 'plugin', 'marketplace', 'add', path.join(base, 'helper')],
    ['/opt/codex', 'plugin', 'add', 'qianmo@qianmo'],
  ])
  const market = JSON.parse(
    readFileSync(
      path.join(base, 'helper', '.agents', 'plugins', 'marketplace.json'),
      'utf8',
    ),
  )
  expect(market.plugins.map((one: { name: string }) => one.name)).toEqual([
    'qianmo',
  ])
  expect(changed.sort()).toEqual(['coder', 'helper', 'writer'])
})

test('the same set again changes nothing; a removal recycles only who had it', async () => {
  const node = host()
  await node.apply([MCP, SKILL])
  changed = []
  commands = []
  expect((await node.apply([MCP, SKILL])).ok).toBe(true)
  expect(changed).toEqual([])
  expect(commands).toEqual([])
  await node.apply([MCP])
  expect(changed.sort()).toEqual(['helper', 'writer'])
  expect(node.forAgent('writer')!.ompPluginDirs).toEqual([
    path.join(root, 'extensions', 'agents', 'writer', 'mcp', 'qianmo-mcp'),
  ])
  await node.apply([])
  expect(node.forAgent('writer')).toBeNull()
})

test('the control link checks the digest and survives a restart', async () => {
  const node = host()
  const bad = await node.control(
    'extensions.apply',
    { digest: '0'.repeat(64), entries: [MCP] },
    {} as never,
  )
  expect(bad.ok).toBe(false)
  const good = await node.control(
    'extensions.apply',
    { digest: extensionsDigest([MCP]), entries: [MCP] },
    {} as never,
  )
  expect(good.ok).toBe(true)
  const again = host()
  expect(again.status().digest).toBe(extensionsDigest([MCP]))
  expect(again.forAgent('coder')!.mcp[0]!.env).toEqual({
    DOCS_TOKEN: 'secret-value',
  })
})

test('a GitHub plugin is used only when its files match the pinned digest', async () => {
  const files = {
    'plugins/lint/.claude-plugin/plugin.json': '{"name":"lint"}',
    'plugins/lint/.codex-plugin/plugin.json':
      '{"name":"lint","skills":"./skills/"}',
    'plugins/lint/skills/lint/SKILL.md':
      '---\nname: lint\ndescription: Lint\n---\n',
    'README.md': 'not part of it',
  }
  served.set(
    `https://codeload.github.com/team/tools/tar.gz/${COMMIT}`,
    tarball(files),
  )
  const plugin: ExtensionWireEntry = {
    id: id(3),
    kind: 'plugin',
    name: 'lint',
    agents: null,
    github: {
      repo: 'team/tools',
      commit: COMMIT,
      path: 'plugins/lint',
      digest: digestOf(files, 'plugins/lint'),
    },
  }
  const node = host()
  const outcome = await node.apply([plugin])
  expect(outcome.ok).toBe(true)
  expect(node.status().results).toEqual([
    {
      id: id(3),
      ok: true,
      detail: null,
      retry: false,
      agents: AGENTS.map(({ agent }) => ({
        agent,
        ok: true,
        detail: null,
        retry: false,
      })),
    },
  ])
  const dir = path.join(
    root,
    'extensions',
    'agents',
    'coder',
    'plugins',
    'lint',
  )
  expect(node.forAgent('coder')!.claudePluginDirs).toEqual([dir])
  expect(existsSync(path.join(dir, 'README.md'))).toBe(false)
  expect(commands).toContainEqual([
    '/opt/codex',
    'plugin',
    'add',
    'lint@qianmo',
  ])

  const tampered = {
    ...plugin,
    id: id(4),
    github: { ...plugin.github!, digest: 'b'.repeat(64) },
  }
  await node.apply([tampered])
  expect(node.status().results[0]!.ok).toBe(false)
  expect(node.status().results[0]!.detail).toContain('摘要不符')
  expect(node.forAgent('coder')!.claudePluginDirs).toEqual([])
})

test('Codex gets no SSE server and asks for servers set to ask', () => {
  const { toml, skipped } = codexMcpToml([
    { ...MCP, approval: 'ask' },
    {
      id: id(5),
      kind: 'mcp',
      name: 'feed',
      agents: null,
      transport: 'sse',
      url: 'https://feed.example/sse',
    },
  ])
  expect(toml).toContain('default_tools_approval_mode = "prompt"')
  expect(toml).not.toContain('feed')
  expect(skipped).toEqual([id(5)])
})

test('a failed Codex install is retried while the set stays the same', async () => {
  let fail = true
  const node = new NodeExtensions({
    agents: [{ agent: 'helper', runtime: 'codex' }],
    root: path.join(root, 'extensions'),
    codexHome: agent => path.join(root, 'codex', agent),
    codexBin: '/opt/codex',
    run: async argv => {
      commands.push([...argv])
      return fail ? { code: 1, stdout: 'boom' } : { code: 0, stdout: '' }
    },
    changed: async agent => {
      changed.push(agent)
    },
  })
  await node.apply([SKILL])
  expect(node.status().results[0]!.ok).toBe(false)
  fail = false
  commands = []
  changed = []
  await node.apply([SKILL])
  expect(node.status().results[0]!.ok).toBe(true)
  expect(commands.map(argv => argv[2])).toEqual(['marketplace', 'add'])
  expect(changed).toEqual(['helper'])
})

// -- P32 audit: results per agent, retries, roster, re-probing --------------

const SSE: ExtensionWireEntry = {
  id: id(6),
  kind: 'mcp',
  name: 'feed',
  agents: null,
  transport: 'sse',
  url: 'https://feed.example/sse',
  approval: 'allow',
}

test('one agent’s failure leaves the entry working for the others (P32 audit 7)', async () => {
  const node = host({
    run: async argv => {
      commands.push([...argv])
      return { code: 1, stdout: 'marketplace is broken' }
    },
  })
  await node.apply([SKILL, MCP])
  const skill = node.status().results.find(result => result.id === SKILL.id)!
  expect(skill.ok).toBe(false)
  expect(skill.retry).toBe(true)
  expect(skill.detail).toStartWith(
    'helper：Codex 安装失败：marketplace is broken',
  )
  expect(skill.agents).toEqual([
    { agent: 'writer', ok: true, detail: null, retry: false },
    {
      agent: 'helper',
      ok: false,
      detail:
        'Codex 安装失败：marketplace is broken · 这个智能体沿用上一次的扩展',
      retry: true,
    },
  ])
  // writer still gets the skill; coder still gets the MCP server.
  expect(node.forAgent('writer')!.ompPluginDirs).toContain(
    path.join(root, 'extensions', 'agents', 'writer', 'plugins', 'qianmo'),
  )
  expect(node.forAgent('coder')!.mcp.map(server => server.name)).toEqual([
    'docs',
  ])
  // The live Codex home was left alone: no config was swapped in.
  expect(existsSync(path.join(root, 'codex', 'helper', 'config.toml'))).toBe(
    false,
  )
})

test('a failure that cannot change is not retried and recycles nobody (P32 audit 5)', async () => {
  const node = host()
  const ghost: ExtensionWireEntry = { ...SKILL, id: id(7), agents: ['ghost'] }
  await node.apply([SSE, ghost])
  const [feed, nobody] = node.status().results
  expect(feed!.ok).toBe(false)
  expect(feed!.retry).toBe(false)
  expect(feed!.agents.map(one => [one.agent, one.ok])).toEqual([
    ['writer', true],
    ['coder', true],
    ['helper', false],
  ])
  expect(nobody).toMatchObject({
    ok: false,
    retry: false,
    detail: '这台节点上没有它适用的智能体',
  })
  changed = []
  commands = []
  probes = []
  for (let i = 0; i < 3; i++) await node.apply([SSE, ghost])
  expect([changed, commands, probes]).toEqual([[], [], []])
})

test('a retryable failure is tried again; who sees nothing new is not recycled (P32 audit 5)', async () => {
  let up = false
  const node = host({
    probe: async target => {
      probes.push(target.name)
      if (!up) throw new Error('connection refused')
      return [`mcp__qianmo_mcp_${target.name}_search`]
    },
  })
  await node.apply([MCP])
  const first = node.status().results[0]!
  expect(first.retry).toBe(true)
  expect(first.agents.find(one => one.agent === 'writer')!.detail).toContain(
    'connection refused',
  )
  // Claude Code and Codex do not need the probe.
  expect(first.agents.filter(one => one.ok).map(one => one.agent)).toEqual([
    'coder',
    'helper',
  ])
  expect(node.forAgent('writer')!.mcp[0]!.tools).toEqual([])
  changed = []
  commands = []
  await node.apply([MCP])
  expect(probes).toEqual(['docs', 'docs'])
  expect(changed).toEqual([])
  expect(commands).toEqual([])
  up = true
  await node.apply([MCP])
  expect(node.status().results[0]!.ok).toBe(true)
  expect(node.forAgent('writer')!.mcp[0]!.tools).toEqual([
    'mcp__qianmo_mcp_docs_search',
  ])
  expect(changed).toEqual(['writer'])
})

test('a new agent or a runtime switch after a restart gets the set laid out again (P32 audit 6)', async () => {
  const node = host({ agents: [{ agent: 'writer' }] })
  await node.apply([MCP, SKILL])
  expect(node.status().results.every(result => result.ok)).toBe(true)
  changed = []
  probes = []
  // The node restarts with a new agent pi3 and writer moved to Codex.
  const after = host({
    agents: [{ agent: 'writer', runtime: 'codex' }, { agent: 'pi3' }],
    run: async (argv, options) => {
      commands.push([...argv])
      expect(options.env.CODEX_HOME).toStartWith(
        `${path.join(root, 'codex', 'writer')}.next-`,
      )
      return { code: 0, stdout: '' }
    },
  })
  expect(after.forAgent('pi3')).toBeNull()
  expect(after.forAgent('writer')).toBeNull()
  await after.start()
  const pi3 = after.forAgent('pi3')!
  for (const dir of pi3.ompPluginDirs) expect(existsSync(dir)).toBe(true)
  expect(pi3.mcp[0]!.tools).toEqual(['mcp__qianmo_mcp_docs_search'])
  expect(changed.sort()).toEqual(['pi3', 'writer'])
  expect(commands.map(argv => argv.slice(1, 3).join(' '))).toEqual([
    'plugin marketplace',
    'plugin add',
  ])
  expect(after.forAgent('writer')!.mcp.map(server => server.name)).toEqual([
    'docs',
  ])
})

test('every start probes MCP servers again; new tools are allowed and the agent recycled (P32 audit 17)', async () => {
  await host({ agents: [{ agent: 'writer' }] }).apply([MCP])
  changed = []
  const restarted = host({
    agents: [{ agent: 'writer' }],
    probe: async target => [
      `mcp__qianmo_mcp_${target.name}_search`,
      `mcp__qianmo_mcp_${target.name}_fetch`,
    ],
  })
  await restarted.start()
  expect(restarted.forAgent('writer')!.mcp[0]!.tools).toEqual([
    'mcp__qianmo_mcp_docs_search',
    'mcp__qianmo_mcp_docs_fetch',
  ])
  expect(changed).toEqual(['writer'])
  // The same tools on the next start: nothing to recycle.
  changed = []
  await host({
    agents: [{ agent: 'writer' }],
    probe: async target => [
      `mcp__qianmo_mcp_${target.name}_search`,
      `mcp__qianmo_mcp_${target.name}_fetch`,
    ],
  }).start()
  expect(changed).toEqual([])
})

test('two servers whose qianmopi tool names clash: the later one stays off that agent (P32 audit 18)', async () => {
  const a: ExtensionWireEntry = { ...MCP, id: id(8), name: 'a' }
  const ab: ExtensionWireEntry = { ...MCP, id: id(9), name: 'a-b' }
  const node = host({
    agents: [{ agent: 'writer' }, { agent: 'coder', runtime: 'claude-code' }],
    // Server `a` tool `b_c` and server `a-b` tool `c` mint the same name.
    probe: async () => ['mcp__qianmo_mcp_a_b_c'],
  })
  await node.apply([a, ab])
  const clash = node.status().results.find(result => result.id === ab.id)!
  expect(clash.agents).toEqual([
    {
      agent: 'writer',
      ok: false,
      detail: 'qianmopi 里它的工具名与连接器 a 的相同 · 给其中一个换个名称',
      retry: false,
    },
    { agent: 'coder', ok: true, detail: null, retry: false },
  ])
  expect(node.forAgent('writer')!.mcp.map(server => server.name)).toEqual(['a'])
  const mcpJson = JSON.parse(
    readFileSync(
      path.join(
        root,
        'extensions',
        'agents',
        'writer',
        'mcp',
        'qianmo-mcp',
        'mcp.json',
      ),
      'utf8',
    ),
  )
  expect(Object.keys(mcpJson.mcpServers)).toEqual(['a'])
  // Claude Code names tools by server, so both work there.
  expect(node.forAgent('coder')!.mcp.map(server => server.name)).toEqual([
    'a',
    'a-b',
  ])
})

test('an imported plugin brings its instructions, not the processes it bundles', async () => {
  const files = {
    'kit/.claude-plugin/plugin.json': JSON.stringify({
      name: 'kit',
      mcpServers: { db: { command: 'db-mcp' } },
      hooks: './hooks/hooks.json',
    }),
    'kit/.codex-plugin/plugin.json': JSON.stringify({
      name: 'kit',
      skills: './skills/',
      mcpServers: './.mcp.json',
    }),
    'kit/.mcp.json': '{"mcpServers":{"db":{"command":"db-mcp"}}}',
    'kit/.lsp.json': '{}',
    'kit/hooks/hooks.json': '{"hooks":{}}',
    'kit/tools/run.ts': 'export default {}',
    'kit/skills/kit/SKILL.md': '---\nname: kit\ndescription: Kit\n---\n',
    'kit/commands/go.md': 'go',
  }
  served.set(
    `https://codeload.github.com/team/tools/tar.gz/${COMMIT}`,
    tarball(files),
  )
  const kit: ExtensionWireEntry = {
    id: id(10),
    kind: 'plugin',
    name: 'kit',
    agents: null,
    github: {
      repo: 'team/tools',
      commit: COMMIT,
      path: 'kit',
      digest: digestOf(files, 'kit'),
    },
  }
  const node = host()
  await node.apply([kit])
  expect(node.status().results[0]!.ok).toBe(true)
  const base = path.join(root, 'extensions', 'agents')
  for (const agent of ['writer', 'coder', 'helper']) {
    const dir = path.join(base, agent, 'plugins', 'kit')
    for (const gone of ['.mcp.json', '.lsp.json', 'hooks'])
      expect(existsSync(path.join(dir, gone))).toBe(false)
    expect(existsSync(path.join(dir, 'skills', 'kit', 'SKILL.md'))).toBe(true)
    expect(existsSync(path.join(dir, 'commands', 'go.md'))).toBe(true)
    for (const manifest of ['.claude-plugin', '.codex-plugin']) {
      const kept = JSON.parse(
        readFileSync(path.join(dir, manifest, 'plugin.json'), 'utf8'),
      )
      expect(kept.name).toBe('kit')
      expect(kept.mcpServers).toBeUndefined()
      expect(kept.hooks).toBeUndefined()
    }
  }
  // qianmopi would import tools/ in-process; the others never run it.
  expect(existsSync(path.join(base, 'writer', 'plugins', 'kit', 'tools'))).toBe(
    false,
  )
  expect(existsSync(path.join(base, 'coder', 'plugins', 'kit', 'tools'))).toBe(
    true,
  )
})

test('Codex is installed beside its live home and swapped in whole (P32 audit 4)', async () => {
  const live = path.join(root, 'codex', 'helper')
  let seen: string | undefined
  const node = host({
    agents: [{ agent: 'helper', runtime: 'codex' }],
    run: async (argv, options) => {
      commands.push([...argv])
      // While Codex installs, the live home still has the old config.
      seen = readFileSync(path.join(live, 'config.toml'), 'utf8')
      const stage = options.env.CODEX_HOME!
      expect(stage).toStartWith(`${live}.next-`)
      if (argv[2] === 'add') {
        mkdirSync(path.join(stage, 'plugins', 'cache', 'qianmo', 'qianmo'), {
          recursive: true,
        })
        writeFileSync(
          path.join(stage, 'config.toml'),
          `${readFileSync(path.join(stage, 'config.toml'), 'utf8')}\n[plugins."qianmo@qianmo"]\nenabled = true\n`,
        )
      }
      return { code: 0, stdout: '' }
    },
  })
  mkdirSync(live, { recursive: true })
  writeFileSync(path.join(live, 'config.toml'), '# old\n')
  await node.apply([SKILL, MCP])
  expect(seen).toBe('# old\n')
  const config = readFileSync(path.join(live, 'config.toml'), 'utf8')
  expect(config).toContain('[mcp_servers."docs"]')
  expect(config).toContain('[plugins."qianmo@qianmo"]')
  expect(existsSync(path.join(live, 'plugins', 'cache', 'qianmo'))).toBe(true)
  expect(
    readdirSync(path.join(root, 'codex')).filter(name =>
      name.includes('.next-'),
    ),
  ).toEqual([])
})

test('skill and plugin names may have 64 characters; MCP server names 40', () => {
  const long = `a${'b'.repeat(63)}`
  expect(extensionWireSchema.safeParse({ ...SKILL, name: long }).success).toBe(
    true,
  )
  expect(
    extensionWireSchema.safeParse({ ...SKILL, name: `${long}c` }).success,
  ).toBe(false)
  expect(
    extensionWireSchema.safeParse({ ...MCP, name: 'a'.repeat(40) }).success,
  ).toBe(true)
  expect(
    extensionWireSchema.safeParse({ ...MCP, name: 'a'.repeat(41) }).success,
  ).toBe(false)
})
