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
        { direction: 'chat', profileId: 'chat', modelId: 'vendor-model-pro' },
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
    snap.value.defaults.routes.find(r => r.direction === 'chat')?.profileId,
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
        direction: 'chat' as const,
        profileId: 'chat',
        modelId: 'vendor-model-pro',
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
        { direction: 'chat', profileId: 'chat', modelId: 'vendor-model-pro' },
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
          direction: 'code',
          profileId: 'vendor-paygo',
          modelId: 'vendor-model-pro',
        },
      ],
    },
    actor,
  )
  if (!node.ok) throw new Error(node.failure.message)
  expect(node.value.routes.find(r => r.direction === 'chat')?.profileId).toBe(
    'chat',
  )
  const cleared = await port.save(
    {
      node: 'node-a',
      auto: false,
      revision: 2,
      routes: [{ direction: 'chat', profileId: null, modelId: null }],
    },
    actor,
  )
  if (!cleared.ok) throw new Error(cleared.failure.message)
  expect(
    cleared.value.routes.find(r => r.direction === 'chat')?.profileId,
  ).toBeNull()
})
test('invalid references, kinds, half-null references, duplicate directions and unauthorized actors reject without changing the book', async () => {
  const { port, options } = setup()
  for (const routes of [
    [
      {
        direction: 'chat' as const,
        profileId: 'missing',
        modelId: 'vendor-model-pro',
      },
    ],
    [{ direction: 'chat' as const, profileId: 'chat', modelId: 'missing' }],
    [
      {
        direction: 'chat' as const,
        profileId: 'openai-images',
        modelId: 'gpt-image-2',
      },
    ],
    [{ direction: 'code' as const, profileId: null, modelId: 'x' }],
    [
      { direction: 'chat' as const, profileId: null, modelId: null },
      { direction: 'chat' as const, profileId: null, modelId: null },
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
                    direction: 'chat',
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
