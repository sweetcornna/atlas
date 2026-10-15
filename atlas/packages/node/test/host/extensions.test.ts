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
  type ExtensionWireEntry,
  NodeExtensions,
} from '../../src/host/extensions.js'
import { treeDigest } from '../../src/host/githubDir.js'

const COMMIT = 'a'.repeat(40)
let root: string
let served: Map<string, Uint8Array>
let changed: string[]
let commands: string[][]
let probes: string[]

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

function host(): NodeExtensions {
  return new NodeExtensions({
    agents: [
      { agent: 'writer' },
      { agent: 'coder', runtime: 'claude-code' },
      { agent: 'helper', runtime: 'codex' },
    ],
    root: path.join(root, 'extensions'),
    codexHome: agent => path.join(root, 'codex', agent),
    codexBin: '/opt/codex',
    policy: policy(),
    run: async (argv, options) => {
      if (argv[0] === '/opt/codex') {
        commands.push([...argv])
        expect(options.env.CODEX_HOME).toBe(path.join(root, 'codex', 'helper'))
        return { code: 0, stdout: '' }
      }
      const done = Bun.spawnSync([...argv], { env: options.env })
      return { code: done.exitCode, stdout: done.stdout.toString() }
    },
    probe: async target => {
      probes.push(target.name)
      return [`mcp__qianmo_mcp_${target.name}_search`]
    },
    changed: async agent => {
      changed.push(agent)
    },
    now: () => 1_000,
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
  expect(JSON.parse(readFileSync(mcpFile, 'utf8')).mcpServers.docs).toEqual({
    type: 'stdio',
    command: 'docs-mcp',
    args: ['--stdio'],
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
  expect(node.status().results).toEqual([{ id: id(3), ok: true, detail: null }])
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
