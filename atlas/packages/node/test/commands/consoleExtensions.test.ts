// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The hub's extension book (P32 §9): secrets are sealed and never shown,
 * GitHub sources are pinned to a commit and a digest, each node gets only its
 * own agents' entries, and a node that already has its set is left alone.
 */

import { afterEach, beforeEach, expect, test } from 'bun:test'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import type { DirectionActor } from '@qianmo/console'
import type { ControlOutcome } from '@qianmo/protocol'
import {
  ConsoleExtensions,
  skillFrontMatter,
} from '../../src/commands/consoleExtensions.js'
import { OutboundPolicy } from '../../src/commands/outboundPolicy.js'
import {
  extensionsDigest,
  type ExtensionWireEntry,
} from '../../src/host/extensions.js'

const COMMIT = 'c'.repeat(40)
const ACTOR: DirectionActor = { subject: 'u:ops', role: 'ops', requestId: 'r1' }
let root: string
let served: Map<string, { status: number; body: Uint8Array | string }>
let calls: { node: string; op: string; args: Record<string, unknown> }[]
let onNode: Map<string, string>

function tarball(files: Record<string, string>): Uint8Array {
  const dir = mkdtempSync(path.join(root, 'repo-'))
  const top = path.join(dir, `tools-${COMMIT}`)
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(top, name)), { recursive: true })
    writeFileSync(path.join(top, name), text)
  }
  const out = path.join(root, `t-${Math.random()}.tgz`)
  expect(
    Bun.spawnSync(['tar', '-czf', out, '-C', dir, `tools-${COMMIT}`]).exitCode,
  ).toBe(0)
  return new Uint8Array(readFileSync(out))
}

function book(): ConsoleExtensions {
  return new ConsoleExtensions({
    directory: path.join(root, 'hub'),
    policy: new OutboundPolicy({
      lookup: async () => [{ address: '140.82.112.9', family: 4 }],
      fetch: async url => {
        const hit = served.get(url)
        return hit === undefined
          ? new Response('missing', { status: 404 })
          : new Response(hit.body, { status: hit.status })
      },
    }),
    nodes: () => ['n1', 'n2'],
    agents: async () => [
      'qianmo://n1/writer',
      'qianmo://n1/coder',
      'qianmo://n2/helper',
    ],
    control: {
      async request(node, op, args): Promise<ControlOutcome> {
        calls.push({ node, op, args })
        if (op === 'extensions.status')
          return {
            ok: true,
            value: { digest: onNode.get(node) ?? null, results: [], at: 1 },
          }
        const entries = args.entries as ExtensionWireEntry[]
        onNode.set(node, String(args.digest))
        return {
          ok: true,
          value: {
            digest: args.digest,
            results: entries.map(entry => ({
              id: entry.id,
              ok: true,
              detail: null,
            })),
            at: 2,
          },
        }
      },
    },
    now: () => 1_000,
  })
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'qm-hub-ext-'))
  served = new Map()
  calls = []
  onNode = new Map()
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

test('an MCP connector: secrets sealed, names shown, values sent only to its nodes', async () => {
  const hub = book()
  hub.start()
  const saved = await hub.save(
    {
      kind: 'mcp',
      name: 'docs',
      transport: 'stdio',
      command: 'docs-mcp',
      args: ['--stdio'],
      env: { DOCS_TOKEN: 'secret-value' },
      approval: 'allow',
      agents: ['qianmo://n1/writer'],
    },
    ACTOR,
  )
  expect(saved.ok).toBe(true)
  if (!saved.ok) return
  expect(saved.value.envKeys).toEqual(['DOCS_TOKEN'])
  expect(JSON.stringify(saved.value)).not.toContain('secret-value')
  expect(
    readFileSync(path.join(root, 'hub', 'extensions.json'), 'utf8'),
  ).not.toContain('secret-value')
  await hub.settled()

  const applied = calls.filter(call => call.op === 'extensions.apply')
  const latest = (node: string) =>
    applied.filter(call => call.node === node).at(-1)!.args.entries
  const n1 = latest('n1') as ExtensionWireEntry[]
  expect(n1).toEqual([
    {
      id: saved.value.id,
      kind: 'mcp',
      name: 'docs',
      agents: ['writer'],
      transport: 'stdio',
      command: 'docs-mcp',
      args: ['--stdio'],
      env: { DOCS_TOKEN: 'secret-value' },
      approval: 'allow',
    },
  ])
  expect(latest('n2')).toEqual([])
  const snapshot = await hub.snapshot()
  expect(snapshot.ok && snapshot.value.extensions[0]!.nodes).toEqual([
    { node: 'n1', state: 'applied', detail: null, at: 2 },
  ])

  // Editing with the name alone keeps the stored value.
  const kept = await hub.save(
    {
      id: saved.value.id,
      kind: 'mcp',
      name: 'docs',
      transport: 'stdio',
      command: 'docs-mcp',
      env: { DOCS_TOKEN: null, EXTRA: 'two' },
      agents: ['qianmo://n1/writer'],
    },
    ACTOR,
  )
  expect(kept.ok && kept.value.envKeys).toEqual(['DOCS_TOKEN', 'EXTRA'])
  await hub.settled()
  const last = calls
    .filter(call => call.op === 'extensions.apply' && call.node === 'n1')
    .at(-1)!
  expect((last.args.entries as ExtensionWireEntry[])[0]!.env).toEqual({
    DOCS_TOKEN: 'secret-value',
    EXTRA: 'two',
  })
  await hub.close()
})

test('an entry for every agent only waits on nodes that have agents', async () => {
  const hub = new ConsoleExtensions({
    directory: path.join(root, 'hub'),
    policy: new OutboundPolicy(),
    nodes: () => ['n1', 'n2', 'empty'],
    agents: async () => ['qianmo://n1/writer', 'qianmo://n2/helper'],
    now: () => 1_000,
  })
  const saved = await hub.save(
    { kind: 'skill', name: 'review', description: 'x', body: 'y' },
    ACTOR,
  )
  expect(saved.ok && saved.value.nodes.map(node => node.node)).toEqual([
    'n1',
    'n2',
  ])
  await hub.close()
})

test('a node already on its set is only asked, not sent it again', async () => {
  const hub = book()
  hub.start()
  await hub.settled()
  const first = calls.length
  hub.start()
  await hub.settled()
  expect(calls.slice(first).map(call => call.op)).toEqual([
    'extensions.status',
    'extensions.status',
  ])
  expect(onNode.get('n1')).toBe(extensionsDigest([]))
  await hub.close()
})

test('refuses what a runtime could not load or that reaches too far', async () => {
  const hub = book()
  const bad = async (draft: Record<string, unknown>) => {
    const result = await hub.save(draft as never, ACTOR)
    expect(result.ok).toBe(false)
    return result.ok ? '' : result.failure.message
  }
  expect(await bad({ kind: 'mcp', name: 'Docs', command: 'x' })).toContain(
    '名称',
  )
  expect(await bad({ kind: 'mcp', name: 'qianmo', command: 'x' })).toContain(
    '名称',
  )
  expect(
    await bad({ kind: 'mcp', name: 'docs', command: '/usr/bin/x' }),
  ).toContain('命令')
  expect(
    await bad({
      kind: 'mcp',
      name: 'docs',
      transport: 'http',
      url: 'http://example.com/mcp',
    }),
  ).toContain('HTTPS')
  expect(
    await bad({
      kind: 'mcp',
      name: 'docs',
      command: 'x',
      env: { PLUGIN_ROOT: '/' },
    }),
  ).toContain('PLUGIN_ROOT')
  expect(
    await bad({ kind: 'mcp', name: 'docs', command: 'x', env: { NEW: null } }),
  ).toContain('还没有值')
  expect(
    await bad({ kind: 'skill', name: 'review', description: 'x', body: '' }),
  ).toContain('正文')
  expect(
    await bad({ kind: 'mcp', name: 'docs', command: 'x', agents: ['writer'] }),
  ).toContain('地址')
})

test('a GitHub skill is pinned to a commit and named by its SKILL.md', async () => {
  served.set('https://api.github.com/repos/team/tools/commits/main', {
    status: 200,
    body: COMMIT,
  })
  served.set(`https://codeload.github.com/team/tools/tar.gz/${COMMIT}`, {
    status: 200,
    body: tarball({
      'skills/review/SKILL.md':
        '---\nname: review\ndescription: >\n  Review a draft\n  for tone\n---\nBody\n',
      'skills/review/notes.md': 'more',
    }),
  })
  const hub = book()
  const saved = await hub.save(
    {
      kind: 'skill',
      source: { repo: 'team/tools', ref: 'main', path: 'skills/review' },
    },
    ACTOR,
  )
  expect(saved.ok).toBe(true)
  if (!saved.ok) return
  expect(saved.value.name).toBe('review')
  expect(saved.value.description).toBe('Review a draft for tone')
  expect(saved.value.source).toEqual({
    repo: 'team/tools',
    ref: 'main',
    path: 'skills/review',
    commit: COMMIT,
  })
  // A second skill of the same name is refused.
  const twin = await hub.save(
    { kind: 'skill', name: 'review', description: 'x', body: 'y' },
    ACTOR,
  )
  expect(twin.ok).toBe(false)
  // Switching it off keeps the pin and asks GitHub nothing.
  served.clear()
  const off = await hub.save({ id: saved.value.id, enabled: false }, ACTOR)
  expect(off.ok && off.value.enabled).toBe(false)
  expect(off.ok && off.value.source?.commit).toBe(COMMIT)
})

test('front matter: plain, quoted and folded values', () => {
  expect(skillFrontMatter('---\nname: a\ndescription: "x: y"\n---\n')).toEqual({
    name: 'a',
    description: 'x: y',
  })
  expect(skillFrontMatter('no front matter')).toEqual({})
})
