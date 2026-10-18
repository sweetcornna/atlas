// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Update checks on the hub (P31): one row per source per check, a new
 * version is pushed once, automatic sources act once, and qianmo upgrades
 * node by node with the hub last, stopping at the first failure.
 */

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import type { DirectionActor, UpdatesSnapshot } from '@qianmo/console'
import type { ControlOutcome } from '@qianmo/protocol'
import { ConsoleUpdates } from '../../src/commands/consoleUpdates.js'
import { OutboundPolicy } from '../../src/commands/outboundPolicy.js'
import { SelfUpgrader } from '../../src/host/selfUpgradeRunner.js'

const actor: DirectionActor = {
  subject: 'u:ops',
  role: 'ops',
} as DirectionActor
let dir: string
let clock: number
let requests: string[]
let pushes: string[]
let calls: string[]
/** Nodes the gateway page was told to read the runtimes of again. */
let changed: string[]
let nodeVersions: Record<string, string>
let failUpgrade: Set<string>

const policy = () =>
  new OutboundPolicy({
    lookup: async () => [{ address: '140.82.112.6', family: 4 }],
    fetch: async (url, init) => {
      requests.push(`${init.method ?? 'GET'} ${url}`)
      const json = (value: unknown) =>
        new Response(JSON.stringify(value), { status: 200 })
      if (
        url === 'https://api.github.com/repos/can1357/oh-my-pi/releases/latest'
      )
        return json({ tag_name: 'v99.0.0', assets: [] })
      if (url === 'https://registry.npmjs.org/@anthropic-ai/claude-code/latest')
        return json({ version: '2.1.0' })
      if (url === 'https://registry.npmjs.org/@openai/codex/latest')
        return json({ version: '0.50.0' })
      if (url === 'https://api.github.com/repos/team/atlas/releases/latest')
        return json({ tag_name: 'v3.1.0', assets: [] })
      if (
        url === 'https://api.github.com/repos/team/atlas/releases?per_page=15'
      )
        return json(
          ['v3.1.0', 'v3.0.1', 'v3.0.0', 'v2.47.2'].map(tag => ({
            tag_name: tag,
            assets: [],
          })),
        )
      if (url.endsWith('/actions/workflows/sync-omp.yml/dispatches'))
        return new Response(null, { status: 204 })
      return new Response('missing', { status: 404 })
    },
  })

const control = {
  async request(
    node: string,
    op: string,
    args: Record<string, unknown>,
  ): Promise<ControlOutcome> {
    calls.push(
      `${node} ${op}${args['version'] ? ` ${String(args['version'])}` : ''}`,
    )
    // tokyo-1 answers with the P36 catalog rows, osaka-1 is still on P31.
    if (op === 'runtime.versions')
      return node === 'tokyo-1'
        ? {
            ok: true,
            value: {
              defaultRuntime: 'dsh',
              runtimes: [
                { id: 'dsh', installed: false, installing: true },
                {
                  id: 'claude-code',
                  installed: true,
                  version: '2.0.0',
                  source: 'prefix',
                  pin: '2.1.301',
                  installing: false,
                  verified: true,
                },
                {
                  id: 'codex',
                  installed: true,
                  version: '0.50.0',
                  source: 'flag',
                  installing: false,
                  verified: true,
                },
              ],
            },
          }
        : {
            ok: true,
            value: {
              'claude-code': { version: '2.0.0', managed: true, pinned: false },
              codex: { version: '0.50.0', managed: false, pinned: false },
            },
          }
    if (op === 'runtime.update')
      return { ok: true, value: { version: args['version'] } }
    if (op === 'system.version')
      return {
        ok: true,
        value: {
          version: nodeVersions[node],
          upgradable: true,
          backup: null,
          upgrade: failUpgrade.has(node)
            ? { state: 'failed', target: '3.1.0', detail: '校验和不符', at: 0 }
            : { state: 'idle', target: null, detail: null, at: 0 },
        },
      }
    if (op === 'system.upgrade') {
      if (!failUpgrade.has(node)) nodeVersions[node] = String(args['version'])
      return { ok: true, value: { accepted: true } }
    }
    return { ok: false, code: 'unsupported', message: op }
  },
}

function make(options: { self?: SelfUpgrader } = {}): ConsoleUpdates {
  return new ConsoleUpdates({
    directory: dir,
    policy: policy(),
    nodes: () => ['tokyo-1', 'osaka-1'],
    control,
    repoToken: async () => 'repo-token',
    notify: {
      platformChannels: () => [{ id: 'nc-1', name: '值班群' }],
      pushPlatform: async (ids, title) => {
        pushes.push(`${ids.join(',')} ${title}`)
        return ids.map(channelId => ({ channelId, ok: true, error: null }))
      },
    },
    self: options.self ?? new SelfUpgrader({ tree: null, version: '3.0.1' }),
    runtimesChanged: node => changed.push(node),
    now: () => clock,
    sleep: async () => {
      clock += 5_000
    },
  })
}

async function until(
  updates: ConsoleUpdates,
  done: (value: UpdatesSnapshot) => boolean,
): Promise<UpdatesSnapshot> {
  for (let i = 0; i < 500; i++) {
    const snapshot = await updates.snapshot()
    if (snapshot.ok && done(snapshot.value)) return snapshot.value
    await Bun.sleep(1)
  }
  throw new Error('timed out')
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'qm-updates-'))
  clock = Date.UTC(2026, 9, 15, 0, 0)
  requests = []
  pushes = []
  calls = []
  changed = []
  nodeVersions = { 'tokyo-1': '3.0.1', 'osaka-1': '3.1.0' }
  failUpgrade = new Set()
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

test('settings are checked, and the next check time follows them', async () => {
  const updates = make()
  const bad = [
    {
      times: [{ kind: 'daily', time: '25:00' }],
      timezone: 'Asia/Shanghai',
      actions: {},
      channels: [],
      repo: null,
    },
    { times: [], timezone: 'Mars/Base', actions: {}, channels: [], repo: null },
    {
      times: [],
      timezone: 'Asia/Shanghai',
      actions: {},
      channels: [],
      repo: 'not a repo',
    },
    {
      times: [],
      timezone: 'Asia/Shanghai',
      actions: {},
      channels: ['nc-9'],
      repo: null,
    },
    {
      times: [],
      timezone: 'Asia/Shanghai',
      actions: { codex: 'always' },
      channels: [],
      repo: null,
    },
  ]
  for (const draft of bad)
    expect((await updates.save(draft as never, actor)).ok).toBe(false)
  const saved = await updates.save(
    {
      times: [{ kind: 'daily', time: '09:30' }],
      timezone: 'Asia/Shanghai',
      actions: { qianmopi: 'auto', 'claude-code': 'auto' },
      channels: ['nc-1'],
      repo: 'team/atlas',
    },
    actor,
  )
  expect(saved.ok && saved.value.nextAt).toBe(Date.UTC(2026, 9, 15, 1, 30))
  expect(
    saved.ok && saved.value.sources.find(one => one.id === 'qianmopi')?.action,
  ).toBe('auto')
  await updates.close()
})

test('a check writes one row per source; new versions are pushed and handled once', async () => {
  const updates = make()
  await updates.save(
    {
      times: [],
      timezone: 'Asia/Shanghai',
      actions: { qianmopi: 'auto', 'claude-code': 'auto' },
      channels: ['nc-1'],
      repo: 'team/atlas',
    },
    actor,
  )
  updates.start()
  expect((await updates.run(actor)).ok).toBe(true)
  let value = await until(
    updates,
    one => !one.running && one.history.length === 4,
  )
  const row = (id: string) => value.history.find(one => one.source === id)!
  expect(row('qianmopi')).toMatchObject({
    outcome: 'dispatched',
    latest: '99.0.0',
  })
  expect(row('claude-code')).toMatchObject({
    outcome: 'installed',
    latest: '2.1.0',
  })
  expect(row('codex')).toMatchObject({ outcome: 'current' })
  // qianmo is set to notify: tokyo-1 is behind, nothing is installed.
  expect(row('qianmo')).toMatchObject({ outcome: 'available', latest: '3.1.0' })
  expect(value.rollbackVersions).toEqual(['3.0.0', '2.47.2'])
  expect(requests.filter(one => one.startsWith('POST'))).toEqual([
    'POST https://api.github.com/repos/team/atlas/actions/workflows/sync-omp.yml/dispatches',
  ])
  expect(calls.filter(one => one.includes('runtime.update'))).toEqual([
    'tokyo-1 runtime.update 2.1.0',
    'osaka-1 runtime.update 2.1.0',
  ])
  // The gateway page's cached versions of both are dropped (P36.5).
  expect(changed).toEqual(['tokyo-1', 'osaka-1'])
  // Both shapes read the same; a binary given by flag is pinned.
  const source = (id: string) => value.sources.find(one => one.id === id)!
  expect(source('claude-code').nodes).toEqual([
    { node: 'tokyo-1', version: '2.0.0', managed: true, pinned: false },
    { node: 'osaka-1', version: '2.0.0', managed: true, pinned: false },
  ])
  expect(source('codex').nodes).toEqual([
    { node: 'tokyo-1', version: '0.50.0', managed: false, pinned: true },
    { node: 'osaka-1', version: '0.50.0', managed: false, pinned: false },
  ])
  expect(pushes).toEqual([
    'nc-1 qianmopi 上游 有新版本 99.0.0',
    'nc-1 Claude Code 有新版本 2.1.0',
    'nc-1 阡陌 有新版本 3.1.0',
  ])

  // The same versions again: recorded, not pushed or dispatched twice.
  await updates.run(actor)
  value = await until(updates, one => !one.running && one.history.length === 8)
  expect(value.history.slice(0, 4).map(one => one.detail)).toContain(
    '这个版本已处理过',
  )
  expect(pushes).toHaveLength(3)
  expect(requests.filter(one => one.startsWith('POST'))).toHaveLength(1)
  await updates.close()
})

test('qianmo upgrades node by node, skips what is current, and the hub goes last', async () => {
  const updates = make()
  await updates.save(
    {
      times: [],
      timezone: 'Asia/Shanghai',
      actions: {},
      channels: ['nc-1'],
      repo: 'team/atlas',
    },
    actor,
  )
  updates.start()
  const started = await updates.upgrade({}, actor)
  expect(started.ok && started.value.upgrade?.target).toBe('3.1.0')
  const value = await until(updates, one => one.upgrade?.state !== 'running')
  expect(value.upgrade).toMatchObject({ state: 'done', target: '3.1.0' })
  expect(value.upgrade?.steps).toEqual([
    { node: 'tokyo-1', state: 'done', detail: '3.0.1 → 3.1.0' },
    { node: 'osaka-1', state: 'skipped', detail: '已是 3.1.0' },
    { node: 'hub', state: 'skipped', detail: '源码运行，不能在线升级' },
  ])
  expect(calls.filter(one => one.includes('system.upgrade'))).toEqual([
    'tokyo-1 system.upgrade 3.1.0',
  ])
  expect(pushes).toEqual(['nc-1 阡陌升级完成'])
  expect(value.history[0]).toMatchObject({
    source: 'qianmo',
    outcome: 'installed',
  })
  // Only one job at a time; rollback only to a listed release.
  expect((await updates.rollback({ version: '1.0.0' }, actor)).ok).toBe(false)
  await updates.close()
})

test('the first failing node stops the rollout', async () => {
  nodeVersions['osaka-1'] = '3.0.1'
  failUpgrade.add('tokyo-1')
  const updates = make()
  await updates.save(
    {
      times: [],
      timezone: 'Asia/Shanghai',
      actions: {},
      channels: [],
      repo: 'team/atlas',
    },
    actor,
  )
  updates.start()
  await updates.upgrade({ version: '3.1.0' }, actor)
  const value = await until(updates, one => one.upgrade?.state !== 'running')
  expect(value.upgrade?.state).toBe('failed')
  expect(
    value.upgrade?.steps.map(one => [one.node, one.state, one.detail]),
  ).toEqual([
    ['tokyo-1', 'failed', '校验和不符'],
    ['osaka-1', 'pending', null],
    ['hub', 'pending', null],
  ])
  expect(calls.filter(one => one.includes('system.upgrade'))).toEqual([
    'tokyo-1 system.upgrade 3.1.0',
  ])
  await updates.close()
})

test('after the hub restarts into the target, its step is closed', async () => {
  const first = make()
  await first.save(
    {
      times: [],
      timezone: 'Asia/Shanghai',
      actions: {},
      channels: [],
      repo: 'team/atlas',
    },
    actor,
  )
  await first.close()
  // A job left with the hub step in flight, as the old process saw it last.
  const book = JSON.parse(await Bun.file(path.join(dir, 'updates.json')).text())
  book.upgrade = {
    kind: 'upgrade',
    target: '3.1.0',
    state: 'running',
    steps: [
      { node: 'tokyo-1', state: 'done', detail: null },
      { node: 'hub', state: 'upgrading', detail: null },
    ],
    startedAt: clock,
    finishedAt: null,
    trigger: 'manual',
  }
  await Bun.write(path.join(dir, 'updates.json'), JSON.stringify(book))
  const after = make({
    self: new SelfUpgrader({ tree: null, version: '3.1.0' }),
  })
  after.start()
  const value = await until(after, one => one.upgrade?.state !== 'running')
  expect(value.upgrade?.state).toBe('done')
  expect(value.upgrade?.steps[1]).toEqual({
    node: 'hub',
    state: 'done',
    detail: null,
  })
  await after.close()
})
