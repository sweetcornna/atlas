// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { AuditSource } from '@qianmo/audit'
import { ActionLedger, type DirectionActor } from '@qianmo/console'
import type { ProviderProfile } from '@qianmo/providers'
import { acquirePrivateLock } from '../../src/providers/store.js'
import { ConsoleRouting } from '../../src/commands/consoleRouting.js'
import { routingFixture } from '../providers/routingFixtures.js'
import { MemoryActionStore } from '../../../console/test/actionStore.js'
const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true })
})
const actor: DirectionActor = {
  subject: 'u:0123456789abcdef',
  role: 'ops',
  requestId: 'request-1234',
}
function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p22-book-'))
  roots.push(root)
  const f = routingFixture()
  const profiles: ProviderProfile[] = [f.primary, ...f.profiles].map(p => ({
    ...p,
    name: p.id,
    auth: { scheme: p.auth.scheme },
    keys: [{ id: 'k1' }],
    presetId: null,
    plan: 'paygo',
    site: null,
    evaluated: false,
  }))
  const actions = new ActionLedger({ store: new MemoryActionStore() })
  const options = {
    path: path.join(root, 'routing.json'),
    profiles: () => profiles,
    actions,
    now: () => 1000,
  }
  return { options, port: new ConsoleRouting(options), actions, profiles }
}
test('save is durable/private, preserves unpatched directions and records the DirectionActor once', async () => {
  const { port, options, actions } = setup()
  const result = await port.save(
    {
      node: null,
      auto: true,
      revision: 0,
      routes: [
        {
          direction: 'medium',
          profileId: 'chat',
          modelId: 'vendor-model-pro',
          effort: null,
        },
      ],
    },
    actor,
  )
  expect(result.ok).toBe(true)
  expect(fs.statSync(options.path).mode & 0o777).toBe(0o600)
  const snap = await new ConsoleRouting(options).snapshot()
  if (!snap.ok) throw new Error(snap.failure.message)
  expect(snap.value.defaults.auto).toBe(true)
  expect(
    snap.value.defaults.routes.find(r => r.direction === 'medium')?.profileId,
  ).toBe('chat')
  expect(
    snap.value.models.find(m => m.profileId === 'openai-images')?.kind,
  ).toBe('image')
  expect(JSON.stringify(snap.value)).not.toContain('auth')
  const lines = await actions.list({})
  if (!lines.ok) throw new Error(lines.failure.message)
  expect(
    lines.value.entries.map(e => ({
      action: e.action,
      subject: e.subject,
      requestId: e.requestId,
    })),
  ).toEqual([
    {
      action: 'routing.save',
      subject: actor.subject,
      requestId: actor.requestId,
    },
  ])
})
test('stale revisions from another instance reject and node clear cannot resurrect a stale override', async () => {
  const { port, options } = setup()
  const peer = new ConsoleRouting(options)
  const input = {
    node: 'node-a',
    auto: true,
    revision: 0,
    routes: [
      {
        direction: 'medium' as const,
        profileId: 'chat',
        modelId: 'vendor-model-pro',
        effort: null,
      },
    ],
  }
  expect((await port.save(input, actor)).ok).toBe(true)
  const stale = await peer.save(input, actor)
  expect(stale).toMatchObject({ ok: false, failure: { code: 'rejected' } })
  const cleared = await peer.clearNode('node-a', actor)
  expect(cleared.ok).toBe(true)
  expect(port.effective('node-a').auto).toBe(false)
  expect((await port.save({ ...input, revision: 1 }, actor)).ok).toBe(false)
})
test('partial node routes inherit defaults, then explicit null clears just that direction', async () => {
  const { port } = setup()
  await port.save(
    {
      node: null,
      auto: true,
      revision: 0,
      routes: [
        {
          direction: 'medium',
          profileId: 'chat',
          modelId: 'vendor-model-pro',
          effort: null,
        },
      ],
    },
    actor,
  )
  const node = await port.save(
    {
      node: 'node-a',
      auto: false,
      revision: 1,
      routes: [
        {
          direction: 'complex',
          profileId: 'vendor-paygo',
          modelId: 'vendor-model-pro',
          effort: 'high',
        },
      ],
    },
    actor,
  )
  if (!node.ok) throw new Error(node.failure.message)
  expect(node.value.routes.find(r => r.direction === 'medium')?.profileId).toBe(
    'chat',
  )
  expect(node.value.routes.find(r => r.direction === 'complex')?.effort).toBe(
    'high',
  )
  const cleared = await port.save(
    {
      node: 'node-a',
      auto: false,
      revision: 2,
      routes: [
        { direction: 'medium', profileId: null, modelId: null, effort: null },
      ],
    },
    actor,
  )
  if (!cleared.ok) throw new Error(cleared.failure.message)
  expect(
    cleared.value.routes.find(r => r.direction === 'medium')?.profileId,
  ).toBeNull()
})
test('invalid references, kinds, half-null references, duplicate directions and unauthorized actors reject without changing the book', async () => {
  const { port, options } = setup()
  const medium = 'medium' as const
  for (const routes of [
    [
      {
        direction: medium,
        profileId: 'missing',
        modelId: 'vendor-model-pro',
        effort: null,
      },
    ],
    [
      {
        direction: medium,
        profileId: 'chat',
        modelId: 'missing',
        effort: null,
      },
    ],
    [
      {
        direction: medium,
        profileId: 'openai-images',
        modelId: 'gpt-image-2',
        effort: null,
      },
    ],
    [
      {
        direction: 'complex' as const,
        profileId: null,
        modelId: 'x',
        effort: null,
      },
    ],
    [
      { direction: medium, profileId: null, modelId: null, effort: null },
      { direction: medium, profileId: null, modelId: null, effort: null },
    ],
    // P38: an effort the model does not take, an effort on following the
    // main model, an effort on a media model.
    [
      {
        direction: medium,
        profileId: 'chat',
        modelId: 'vendor-model-pro',
        effort: 'medium' as const,
      },
    ],
    [
      {
        direction: medium,
        profileId: null,
        modelId: null,
        effort: 'high' as const,
      },
    ],
    [
      {
        direction: 'image' as const,
        profileId: 'openai-images',
        modelId: 'gpt-image-2',
        effort: 'high' as const,
      },
    ],
  ])
    expect(
      (await port.save({ node: null, auto: false, revision: 0, routes }, actor))
        .ok,
    ).toBe(false)
  expect(
    (await port.clearNode('node-a', { ...actor, role: 'viewer' })).ok,
  ).toBe(false)
  expect(fs.existsSync(options.path)).toBe(false)
  // The shared admin token is not a routing writer: a route ships another
  // service's credentials to the nodes (the 模型服务 rule).
  expect(
    (
      await port.save(
        { node: null, auto: false, revision: 0, routes: [] },
        { ...actor, subject: 'legacy:admin', role: null },
      )
    ).ok,
  ).toBe(false)
})
test('corrupt or non-private routing books fail closed', async () => {
  const { port, options } = setup()
  await port.save({ node: null, auto: false, revision: 0, routes: [] }, actor)
  fs.chmodSync(options.path, 0o644)
  expect((await port.snapshot()).ok).toBe(false)
  fs.chmodSync(options.path, 0o600)
  fs.writeFileSync(options.path, '{bad')
  expect((await port.clearNode('node-a', actor)).ok).toBe(false)
})
test('snapshot reads model.route from attached audit ports, keeps latest twenty and never includes prompt text', async () => {
  const { options } = setup()
  const port = new ConsoleRouting({
    ...options,
    audits: [
      {
        node: 'node-a',
        kind: 'authoritative',
        audit: {
          async chain() {
            return { ok: true, value: null }
          },
          async read() {
            return {
              ok: true,
              value: {
                chain: 'intact',
                intact: true,
                issueCount: 0,
                total: 25,
                records: Array.from({ length: 25 }, (_, i) => ({
                  seq: i + 1,
                  prev: '0'.repeat(64),
                  at: i,
                  source: AuditSource.Resident,
                  kind: 'model.route',
                  outcome: 'ok' as const,
                  detail: {
                    agent: 'main',
                    // A node older than P38 still writes the P22 name.
                    direction: i % 2 === 0 ? 'chat' : 'plan',
                    source: 'auto',
                    model: 'qm-chat-1234/model',
                    prompt: 'must not be returned',
                  },
                })),
              },
            }
          },
        },
      },
    ],
  })
  const snapshot = await port.snapshot()
  if (!snapshot.ok) throw new Error(snapshot.failure.message)
  expect(snapshot.value.recent).toHaveLength(20)
  expect(snapshot.value.recent[0]?.at).toBe(24)
  expect(snapshot.value.recent[19]?.at).toBe(5)
  expect(snapshot.value.recent.map(r => r.direction).slice(0, 2)).toEqual([
    'medium',
    'complex',
  ])
  expect(JSON.stringify(snapshot.value)).not.toContain('must not')
})

test('a crashed lock holder is reclaimed, while a live holder rejects writes', async () => {
  const { port, options } = setup()
  fs.writeFileSync(
    `${options.path}.lock`,
    JSON.stringify({
      pid: 2147483647,
      nonce: 'dead',
      at: new Date().toISOString(),
    }),
    { mode: 0o600 },
  )
  expect(
    (
      await port.save(
        { node: null, auto: false, revision: 0, routes: [] },
        actor,
      )
    ).ok,
  ).toBe(true)
  fs.writeFileSync(
    `${options.path}.lock`,
    JSON.stringify({
      pid: process.pid,
      nonce: 'live',
      at: new Date().toISOString(),
    }),
    { mode: 0o600 },
  )
  expect(
    (await new ConsoleRouting(options).clearNode('node-a', actor)).ok,
  ).toBe(false)
  expect(
    JSON.parse(fs.readFileSync(`${options.path}.lock`, 'utf8')).nonce,
  ).toBe('live')
})

test('expired live locks recover and releasing an old owner preserves the replacement lock', () => {
  const { options } = setup()
  const lockPath = `${options.path}.lock`
  fs.writeFileSync(
    lockPath,
    JSON.stringify({
      pid: process.pid,
      nonce: 'expired',
      at: new Date(0).toISOString(),
    }),
    { mode: 0o600 },
  )
  const lock = acquirePrivateLock(lockPath, { maxAgeMs: 5 * 60_000 })
  if (!lock) throw new Error('expired lock was not reclaimed')
  const other = JSON.stringify({
    pid: process.pid,
    nonce: 'other-owner',
    at: new Date().toISOString(),
  })
  fs.writeFileSync(lockPath, other)
  lock.release()
  expect(fs.readFileSync(lockPath, 'utf8')).toBe(other)
})

test('a v1 book (the eight P22 directions) reads as the tiers and is written back as v2', async () => {
  const { port, options } = setup()
  const v1 = (node: string | null, picks: Record<string, string>) => ({
    node,
    auto: true,
    routes: [
      'code',
      'chat',
      'plan',
      'fast',
      'vision',
      'image',
      'speech',
      'video',
    ].map(direction => ({
      direction,
      profileId: picks[direction] === undefined ? null : 'chat',
      modelId: picks[direction] ?? null,
    })),
    revision: 3,
    updatedAt: 500,
    updatedBy: 'u:0123456789abcdef',
  })
  fs.writeFileSync(
    options.path,
    JSON.stringify({
      v: 1,
      defaults: v1(null, {
        chat: 'vendor-model-pro',
        plan: 'vendor-model-pro',
        vision: 'vendor-model-pro',
      }),
      nodes: [
        v1('node-a', { code: 'vendor-model-pro', fast: 'vendor-model-flash' }),
      ],
      revision: 3,
    }),
    { mode: 0o600 },
  )
  const snap = await port.snapshot()
  if (!snap.ok) throw new Error(snap.failure.message)
  const picked = (
    routes: readonly { direction: string; modelId: string | null }[],
  ) => Object.fromEntries(routes.map(r => [r.direction, r.modelId]))
  expect(picked(snap.value.defaults.routes)).toEqual({
    complex: 'vendor-model-pro',
    medium: 'vendor-model-pro',
    simple: null,
    image: null,
    speech: null,
    video: null,
  })
  expect(picked(port.effective('node-a').routes)).toMatchObject({
    complex: null,
    medium: 'vendor-model-pro',
    simple: 'vendor-model-flash',
  })
  // Reading leaves the file as it was; the next write moves it to v2.
  expect(JSON.parse(fs.readFileSync(options.path, 'utf8')).v).toBe(1)
  const saved = await port.save(
    { node: null, auto: false, revision: 3, routes: [] },
    actor,
  )
  expect(saved.ok).toBe(true)
  const book = JSON.parse(fs.readFileSync(options.path, 'utf8'))
  expect(book.v).toBe(2)
  expect(
    book.nodes[0].routes.map((r: { direction: string }) => r.direction),
  ).toEqual(['complex', 'medium', 'simple', 'image', 'speech', 'video'])
})
test('the snapshot offers each model the efforts it takes', async () => {
  const { port } = setup()
  const snap = await port.snapshot()
  if (!snap.ok) throw new Error(snap.failure.message)
  expect(
    snap.value.models.find(
      m => m.profileId === 'chat' && m.modelId === 'vendor-model-pro',
    )?.efforts,
  ).toEqual(['low', 'high', 'max'])
  expect(
    snap.value.models.find(m => m.profileId === 'openai-images')?.efforts,
  ).toEqual([])
})
