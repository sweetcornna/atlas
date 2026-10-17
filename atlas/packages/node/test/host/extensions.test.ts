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
  withoutGrants,
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
  // qianmopi would import tools/ in-process; no runtime gets it (P32 review 5).
  for (const agent of ['writer', 'coder', 'helper'])
    expect(existsSync(path.join(base, agent, 'plugins', 'kit', 'tools'))).toBe(
      false,
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

// -- P32 review (PR #232) -----------------------------------------------------

/** `applied.json` as the P32 node before per-agent results wrote it (v1). */
function writeV1(
  entries: readonly ExtensionWireEntry[],
  results: readonly { id: string; ok: boolean; detail: string | null }[],
): string {
  const digest = extensionsDigest(entries)
  mkdirSync(path.join(root, 'extensions'), { recursive: true })
  writeFileSync(
    path.join(root, 'extensions', 'applied.json'),
    JSON.stringify({
      v: 1,
      digest,
      entries,
      results,
      tools: { [MCP.id]: ['mcp__qianmo_mcp_docs_search'] },
      plugins: {},
      agentDigests: Object.fromEntries(
        AGENTS.map(({ agent }) => [agent, 'c'.repeat(64)]),
      ),
      at: 500,
    }),
  )
  return digest
}

test('a set laid out before v2 is not used until it is laid out again (P32 review 1)', async () => {
  const digest = writeV1(
    [MCP, SKILL],
    [
      { id: MCP.id, ok: true, detail: null },
      { id: SKILL.id, ok: true, detail: null },
    ],
  )
  // What that node laid out: the server started directly, with no qm mcp-exec.
  const old = path.join(root, 'extensions', 'agents', 'writer')
  mkdirSync(path.join(old, 'mcp', 'qianmo-mcp'), { recursive: true })
  writeFileSync(
    path.join(old, 'mcp', 'qianmo-mcp', 'mcp.json'),
    JSON.stringify({ mcpServers: { docs: { command: 'docs-mcp' } } }),
  )
  mkdirSync(path.join(old, 'plugins', 'qianmo'), { recursive: true })
  let broken = true
  const errors: string[] = []
  const node = host({
    mcpExec: args => {
      if (broken) throw new Error('qm is missing')
      return ['/opt/qm', ...args]
    },
    onError: message => errors.push(message),
  })
  // Agents started now run without extensions, as on a fresh node.
  for (const { agent } of AGENTS) expect(node.forAgent(agent)).toBeNull()
  expect(node.status().digest).toBeNull()

  // The start's layout fails: still nothing, and the hub is told to resend.
  await node.start()
  expect(errors.join('\n')).toContain('扩展落地失败')
  expect(node.forAgent('writer')).toBeNull()
  expect(node.status().digest).toBeNull()

  broken = false
  changed = []
  const resent = await node.control(
    'extensions.apply',
    { digest, entries: [MCP, SKILL] },
    {} as never,
  )
  expect(resent.ok).toBe(true)
  expect(node.status().digest).toBe(digest)
  const writer = node.forAgent('writer')!
  expect(writer.ompPluginDirs).toContain(path.join(old, 'mcp', 'qianmo-mcp'))
  expect(
    JSON.parse(
      readFileSync(path.join(old, 'mcp', 'qianmo-mcp', 'mcp.json'), 'utf8'),
    ).mcpServers.docs.command,
  ).toBe('./bin/qm-mcp-exec')
  expect(changed.sort()).toEqual(['coder', 'helper', 'writer'])
})

test('failures kept from before v2 are resent: they do not say retry (P32 review 2)', () => {
  writeV1(
    [MCP, SKILL],
    [
      { id: MCP.id, ok: true, detail: null },
      { id: SKILL.id, ok: false, detail: 'Codex 安装失败：boom' },
    ],
  )
  const failed = host()
    .status()
    .results.find(result => result.id === SKILL.id)!
  expect(failed.ok).toBe(false)
  expect(failed.retry).toBeUndefined()
})

test('a Codex install that only partly went in still recycles the agent (P32 review 3)', async () => {
  let addFails = false
  const node = host({
    agents: [{ agent: 'helper', runtime: 'codex' }],
    run: async argv => {
      commands.push([...argv])
      return addFails && argv[2] === 'add'
        ? { code: 1, stdout: 'plugin add failed' }
        : { code: 0, stdout: '' }
    },
  })
  await node.apply([MCP, SKILL])
  expect(changed).toEqual(['helper'])
  changed = []
  addFails = true
  // The operator switches the server to ask; the skill plugin fails to add.
  await node.apply([{ ...MCP, approval: 'ask' }, SKILL])
  const config = readFileSync(
    path.join(root, 'codex', 'helper', 'config.toml'),
    'utf8',
  )
  expect(config).toContain('default_tools_approval_mode = "prompt"')
  expect(
    node.status().results.find(result => result.id === SKILL.id)!.retry,
  ).toBe(true)
  expect(changed).toEqual(['helper'])
  // The same partial install again: the live home is as it was.
  changed = []
  await node.apply([{ ...MCP, approval: 'ask' }, SKILL])
  expect(changed).toEqual([])
  // Once it all goes in, the agent sees the plugin too.
  addFails = false
  await node.apply([{ ...MCP, approval: 'ask' }, SKILL])
  expect(changed).toEqual(['helper'])
})

test('imported skills and plugins grant no tools and carry no hooks (P32 review 4)', async () => {
  const files = {
    'grants/.claude-plugin/plugin.json': '{"name":"grants"}',
    'grants/skills/grants/SKILL.md':
      '---\nname: grants\ndescription: Grants\nallowed-tools: Bash, Write\n---\n\nallowed-tools: Bash stays in the body\n',
    'grants/commands/ship.md':
      '---\ndescription: Ship it\nallowed-tools:\n  - Bash(git push:*)\n  - Write\nargument-hint: <branch>\n---\nPush $1.\n',
    'grants/commands/list.md':
      '---\r\nallowed_tools:\r\n- Bash\r\nhooks:\r\n  PreToolUse: []\r\ndescription: List\r\n---\r\nList.\r\n',
    'grants/agents/helper.md':
      '---\nname: helper\n"allowed-tools": Bash\ntools: Read\n---\nHelp.\n',
    'grants/commands/sly.md':
      '---\n{description: Sly, "allowed\\x2dtools": Bash}\n---\nSly.\n',
    'grants/commands/plain.md': 'allowed-tools: Bash\nNo frontmatter.\n',
  }
  served.set(
    `https://codeload.github.com/team/tools/tar.gz/${COMMIT}`,
    tarball(files),
  )
  const github = (dir: string) => ({
    repo: 'team/tools',
    commit: COMMIT,
    path: dir,
    digest: digestOf(files, dir),
  })
  const node = host({ agents: [{ agent: 'coder', runtime: 'claude-code' }] })
  await node.apply([
    {
      id: id(11),
      kind: 'plugin',
      name: 'grants',
      agents: null,
      github: github('grants'),
    },
    {
      id: id(12),
      kind: 'skill',
      name: 'grants',
      agents: null,
      github: github('grants/skills/grants'),
    },
  ])
  expect(node.status().results.every(result => result.ok)).toBe(true)
  const plugins = path.join(root, 'extensions', 'agents', 'coder', 'plugins')
  const read = (...parts: string[]) =>
    readFileSync(path.join(plugins, ...parts), 'utf8')
  const skill =
    '---\nname: grants\ndescription: Grants\n---\n\nallowed-tools: Bash stays in the body\n'
  expect(read('grants', 'skills', 'grants', 'SKILL.md')).toBe(skill)
  expect(read('qianmo', 'skills', 'grants', 'SKILL.md')).toBe(skill)
  expect(read('grants', 'commands', 'ship.md')).toBe(
    '---\ndescription: Ship it\nargument-hint: <branch>\n---\nPush $1.\n',
  )
  expect(read('grants', 'commands', 'list.md')).toBe(
    '---\r\ndescription: List\r\n---\r\nList.\r\n',
  )
  expect(read('grants', 'agents', 'helper.md')).toBe(
    '---\nname: helper\ntools: Read\n---\nHelp.\n',
  )
  // A form no line edit sees: it is frontmatter no more.
  const sly = read('grants', 'commands', 'sly.md')
  expect(sly.startsWith('---')).toBe(false)
  expect(sly).toEndWith('---\nSly.\n')
  expect(read('grants', 'commands', 'plain.md')).toBe(
    files['grants/commands/plain.md'],
  )
})

test('frontmatter grants are found however the YAML spells them (P32 review 4)', () => {
  // Nothing to take out: the file is left alone.
  expect(withoutGrants('---\nname: a\ndescription: A\n---\nBody\n')).toBeNull()
  expect(withoutGrants('# allowed-tools: Bash\n')).toBeNull()
  expect(withoutGrants('\uFEFF---\nallowed-tools: Bash\n---\nBody\n')).toBe(
    '\uFEFF---\n---\nBody\n',
  )
  // A merged key, and one Claude Code would read up to a `---` mid-line.
  for (const front of [
    'base: &base {allowed-tools: Bash}\n<<: *base\ndescription: x',
    '"allowed\\x2dtools": Bash\ndescription: x---\n: : not yaml',
  ]) {
    const text = withoutGrants(`---\n${front}\n---\nBody\n`)!
    expect(text.startsWith('---')).toBe(false)
    expect(text).toEndWith('\n---\nBody\n')
  }
})

test('an imported plugin keeps only instructions, docs and manifests (P32 review 5)', async () => {
  const files = {
    'kit/.claude-plugin/plugin.json': JSON.stringify({
      name: 'kit',
      version: '1.0.0',
      description: 'Kit',
      commands: './commands/',
      skills: ['./skills/', './extra/'],
      monitors: './monitors/monitors.json',
      outputStyles: './styles/',
      userConfig: { token: { type: 'string' } },
    }),
    'kit/.claude-plugin/marketplace.json': '{"plugins":[]}',
    'kit/.codex-plugin/plugin.json': JSON.stringify({
      name: 'kit',
      skills: './skills/',
      apps: './.app.json',
      interface: { displayName: 'Kit', logo: './assets/logo.png' },
    }),
    'kit/.app.json': '{}',
    'kit/monitors/monitors.json': '{"monitors":[]}',
    'kit/monitors/watch.sh': '#!/bin/sh\n',
    'kit/workflows/ship.yaml': 'steps: []\n',
    'kit/lsp.json': '{}',
    'kit/dap.yaml': 'adapters: {}\n',
    'kit/settings.json': '{"agent":"kit"}',
    'kit/bin/git': '#!/bin/sh\n',
    'kit/scripts/run.sh': '#!/bin/sh\n',
    'kit/styles/terse.md': 'Be terse.\n',
    'kit/extra/SKILL.md': '---\nname: extra\ndescription: Extra\n---\n',
    'kit/skills/kit/SKILL.md': '---\nname: kit\ndescription: Kit\n---\n',
    'kit/commands/go.md': 'go',
    'kit/agents/aide.md': '---\nname: aide\n---\nAid.\n',
    'kit/rules/style.md': 'Style.\n',
    'kit/prompts/start.md': 'Start.\n',
    'kit/assets/logo.png': 'png',
    'kit/README.md': 'Kit.\n',
    'kit/LICENSE': 'MIT\n',
  }
  served.set(
    `https://codeload.github.com/team/tools/tar.gz/${COMMIT}`,
    tarball(files),
  )
  const node = host()
  await node.apply([
    {
      id: id(13),
      kind: 'plugin',
      name: 'kit',
      agents: null,
      github: {
        repo: 'team/tools',
        commit: COMMIT,
        path: 'kit',
        digest: digestOf(files, 'kit'),
      },
    },
  ])
  expect(node.status().results[0]!.ok).toBe(true)
  for (const { agent } of AGENTS) {
    const dir = path.join(root, 'extensions', 'agents', agent, 'plugins', 'kit')
    expect(readdirSync(dir).sort()).toEqual([
      '.claude-plugin',
      '.codex-plugin',
      'LICENSE',
      'README.md',
      'agents',
      'assets',
      'commands',
      'prompts',
      'rules',
      'skills',
    ])
    expect(readdirSync(path.join(dir, '.claude-plugin'))).toEqual([
      'plugin.json',
    ])
    // A path outside what is kept: the runtime falls back to `skills/`.
    expect(
      JSON.parse(
        readFileSync(path.join(dir, '.claude-plugin', 'plugin.json'), 'utf8'),
      ),
    ).toEqual({
      name: 'kit',
      version: '1.0.0',
      description: 'Kit',
      commands: './commands/',
    })
    expect(
      JSON.parse(
        readFileSync(path.join(dir, '.codex-plugin', 'plugin.json'), 'utf8'),
      ),
    ).toEqual({
      name: 'kit',
      skills: './skills/',
      interface: { displayName: 'Kit', logo: './assets/logo.png' },
    })
  }
})

test('an MCP probe runs in an empty scratch directory, not beside the secrets (P32 review 6)', async () => {
  const seen: { cwd: string; files: string[] }[] = []
  const probe = async (target: McpProbeTarget) => {
    seen.push({ cwd: target.cwd, files: readdirSync(target.cwd) })
    return [`mcp__qianmo_mcp_${target.name}_search`]
  }
  await host({ probe }).apply([MCP])
  // On start applied.json, with every server's secrets, is in the root.
  await host({ probe }).start()
  const ext = path.join(root, 'extensions')
  expect(seen).toHaveLength(2)
  for (const { cwd, files } of seen) {
    expect(cwd).not.toBe(ext)
    expect(cwd.startsWith(`${ext}${path.sep}`)).toBe(true)
    expect(files).toEqual([])
    expect(existsSync(cwd)).toBe(false)
  }
})
