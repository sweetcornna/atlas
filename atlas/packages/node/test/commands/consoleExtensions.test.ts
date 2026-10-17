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
/** How the fake node lands an entry; every entry works by default. */
let landed: (entry: ExtensionWireEntry) => {
  ok: boolean
  detail: string | null
  retry?: boolean
}
let lastResults: Map<string, unknown[]>

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

function book(
  options: Partial<ConstructorParameters<typeof ConsoleExtensions>[0]> = {},
): ConsoleExtensions {
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
            value: {
              digest: onNode.get(node) ?? null,
              results: lastResults.get(node) ?? [],
              at: 1,
            },
          }
        const entries = args.entries as ExtensionWireEntry[]
        onNode.set(node, String(args.digest))
        const results = entries.map(entry => {
          const one = landed(entry)
          return {
            id: entry.id,
            ...one,
            agents: (entry.agents ?? ['writer']).map(agent => ({
              agent,
              ...one,
            })),
          }
        })
        lastResults.set(node, results)
        return {
          ok: true,
          value: { digest: args.digest, results, at: 2 },
        }
      },
    },
    now: () => 1_000,
    ...options,
  })
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'qm-hub-ext-'))
  served = new Map()
  calls = []
  onNode = new Map()
  landed = () => ({ ok: true, detail: null, retry: false })
  lastResults = new Map()
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
    {
      node: 'n1',
      state: 'applied',
      detail: null,
      at: 2,
      agents: [{ agent: 'writer', state: 'applied', detail: null }],
    },
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

async function until(done: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000
  while (!done() && Date.now() < deadline) await Bun.sleep(5)
}

test('a node already on its set is only asked, not sent it again', async () => {
  const hub = book({ reconcileMs: 20 })
  hub.start()
  await hub.settled()
  const first = calls.length
  // A second start is a no-op: one timer (P32 audit 15).
  hub.start()
  await until(() => calls.length >= first + 2)
  await hub.settled()
  expect(calls.slice(first, first + 2).map(call => call.op)).toEqual([
    'extensions.status',
    'extensions.status',
  ])
  expect(onNode.get('n1')).toBe(extensionsDigest([]))
  await hub.close()
})

test('only a failure another try may get past is sent again (P32 audit 5)', async () => {
  const hub = book({ reconcileMs: 20 })
  landed = entry =>
    entry.name === 'feed'
      ? { ok: false, detail: 'Codex 不支持 SSE 传输', retry: false }
      : { ok: true, detail: null, retry: false }
  const saved = await hub.save(
    {
      kind: 'mcp',
      name: 'feed',
      transport: 'sse',
      url: 'https://feed.example/sse',
      agents: ['qianmo://n2/helper'],
    },
    ACTOR,
  )
  expect(saved.ok).toBe(true)
  await hub.settled()
  const applies = () =>
    calls.filter(call => call.op === 'extensions.apply' && call.node === 'n2')
      .length
  const sent = applies()
  hub.start()
  const asked = calls.length
  await until(
    () =>
      calls.filter(
        (call, at) =>
          at >= asked && call.op === 'extensions.status' && call.node === 'n2',
      ).length >= 2,
  )
  await hub.settled()
  expect(applies()).toBe(sent)
  const snapshot = await hub.snapshot()
  expect(snapshot.ok && snapshot.value.extensions[0]!.nodes).toEqual([
    {
      node: 'n2',
      state: 'failed',
      detail: 'Codex 不支持 SSE 传输',
      // From the last periodic check.
      at: 1,
      agents: [
        { agent: 'helper', state: 'failed', detail: 'Codex 不支持 SSE 传输' },
      ],
    },
  ])

  // A failure that may pass, or a node that does not say, is sent again.
  for (const retry of [true, undefined]) {
    landed = () => ({ ok: false, detail: '下载失败', retry })
    await hub.save(
      { id: saved.ok ? saved.value.id : '', enabled: false },
      ACTOR,
    )
    await hub.save({ id: saved.ok ? saved.value.id : '', enabled: true }, ACTOR)
    await hub.settled()
    const before = applies()
    await until(() => applies() > before)
    expect(applies()).toBeGreaterThan(before)
  }
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

test('names: skills and plugins up to 64 characters, MCP servers up to 40 (P32 audit 16)', async () => {
  const hub = book()
  const skill = await hub.save(
    { kind: 'skill', name: `a${'b'.repeat(63)}`, description: 'x', body: 'y' },
    ACTOR,
  )
  expect(skill.ok).toBe(true)
  const long = await hub.save(
    { kind: 'skill', name: `a${'b'.repeat(64)}`, description: 'x', body: 'y' },
    ACTOR,
  )
  expect(long.ok ? '' : long.failure.message).toContain('不超过 64 字符')
  const mcp = await hub.save(
    { kind: 'mcp', name: `a${'b'.repeat(40)}`, command: 'x' },
    ACTOR,
  )
  expect(mcp.ok ? '' : mcp.failure.message).toContain('不超过 40 字符')
  for (const name of ['a--b', 'a-'])
    expect(
      (
        await hub.save(
          { kind: 'skill', name, description: 'x', body: 'y' },
          ACTOR,
        )
      ).ok,
    ).toBe(false)
})

test('a repo only the connection can read is refused: nodes fetch without it (P32 audit 10)', async () => {
  const seen: (string | null)[] = []
  served.set('https://api.github.com/repos/team/private/commits/main', {
    status: 200,
    body: COMMIT,
  })
  const hub = new ConsoleExtensions({
    directory: path.join(root, 'hub'),
    policy: new OutboundPolicy({
      lookup: async () => [{ address: '140.82.112.9', family: 4 }],
      fetch: async (url, init) => {
        const auth = new Headers(init?.headers).get('authorization')
        seen.push(auth)
        // GitHub answers a private repo without the token with 404.
        const hit = served.get(url)
        return hit === undefined || (auth === null && url.includes('codeload'))
          ? new Response('missing', { status: 404 })
          : new Response(hit.body, { status: hit.status })
      },
    }),
    nodes: () => ['n1'],
    agents: async () => ['qianmo://n1/writer'],
    repoToken: async () => 'repo-token',
    now: () => 1_000,
  })
  const saved = await hub.save(
    {
      kind: 'skill',
      source: { repo: 'team/private', ref: 'main', path: 'skills/review' },
    },
    ACTOR,
  )
  expect(saved.ok ? '' : saved.failure.message).toBe(
    '这个仓库不是公开仓库 · 节点不带令牌下载 · 取不到',
  )
  // The commit was resolved with the token; the download went without it.
  expect(seen).toEqual(['Bearer repo-token', null])
  await hub.close()
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
