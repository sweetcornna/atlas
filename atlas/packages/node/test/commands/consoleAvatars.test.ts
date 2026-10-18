// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  type AvatarKey,
  type AvatarRecord,
  type AvatarSpec,
  type ConsoleResult,
  type DirectionActor,
  avatarFor,
  defaultAvatar,
  parseAvatarKey,
} from '@qianmo/console'
import { ConsoleAvatars } from '../../src/commands/consoleAvatars.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

const actor: DirectionActor = {
  subject: 'u:0123456789abcdef',
  role: 'member',
  requestId: 'avatar-request',
}
const agentKey: AvatarKey = 'agent:qianmo://node-a/main'
const userKey: AvatarKey = `user:${actor.subject}`
const otherKey: AvatarKey = 'user:other'
const spec: AvatarSpec = {
  shape: 'cloud',
  color: 'sage',
  material: 'plush',
  eyes: 'ring',
  mouth: 'smile',
  cheeks: true,
  accessory: 'sprout',
}
const record: AvatarRecord = { spec, updatedAt: 1000, updatedBy: actor.subject }

function value<T>(result: ConsoleResult<T>): T {
  if (!result.ok) throw new Error(result.failure.message)
  return result.value
}

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qianmo-avatars-'))
  roots.push(root)
  const storePath = path.join(root, 'console', 'avatars.json')
  let now = 1000
  const options = { path: storePath, now: () => now }
  return {
    root,
    storePath,
    options,
    port: new ConsoleAvatars(options),
    tick: () => {
      now += 1000
    },
  }
}

function putFile(storePath: string, raw: unknown, mode = 0o600) {
  fs.mkdirSync(path.dirname(storePath), { recursive: true, mode: 0o700 })
  fs.writeFileSync(storePath, JSON.stringify(raw), { mode })
  fs.chmodSync(storePath, mode)
}

test('missing figures use deterministic defaults without creating a file or directory', async () => {
  const { port, storePath } = setup()
  const saved = value(await port.read([agentKey, userKey]))
  expect([...saved]).toEqual([])
  expect(avatarFor(agentKey, saved)).toEqual(
    defaultAvatar('qianmo://node-a/main'),
  )
  expect(avatarFor(userKey, saved)).toEqual(defaultAvatar(actor.subject))
  expect(fs.existsSync(path.dirname(storePath))).toBe(false)
})

test('save, update and delete survive reopening, keep actor/time and leave private atomic files', async () => {
  const { port, options, storePath, tick } = setup()
  expect(value(await port.save(agentKey, spec, actor))).toEqual(record)
  expect(
    value(await new ConsoleAvatars(options).read([agentKey])).get(agentKey),
  ).toEqual(record)
  const updatedSpec: AvatarSpec = { ...spec, shape: 'orb' }
  const editor = { ...actor, subject: 'u:fedcba9876543210' }
  tick()
  expect(value(await port.save(agentKey, updatedSpec, editor))).toEqual({
    spec: updatedSpec,
    updatedAt: 2000,
    updatedBy: editor.subject,
  })
  expect(
    value(await new ConsoleAvatars(options).read([agentKey])).get(agentKey)
      ?.spec,
  ).toEqual(updatedSpec)
  expect(fs.statSync(storePath).mode & 0o7777).toBe(0o600)
  expect(fs.statSync(path.dirname(storePath)).mode & 0o7777).toBe(0o700)
  expect(fs.readdirSync(path.dirname(storePath))).toEqual(['avatars.json'])
  expect(value(await port.save(agentKey, null, actor))).toBeNull()
  expect([
    ...value(await new ConsoleAvatars(options).read([agentKey])),
  ]).toEqual([])
  expect(value(await port.save(agentKey, null, actor))).toBeNull()
})

test('one multi-key read returns only saved requested keys, with duplicates collapsed', async () => {
  const { port } = setup()
  value(await port.save(agentKey, spec, actor))
  value(await port.save(userKey, { ...spec, color: 'lake' }, actor))
  value(await port.save(otherKey, spec, actor))
  const saved = value(
    await port.read([userKey, agentKey, userKey, 'user:unsaved']),
  )
  expect([...saved.keys()]).toEqual([userKey, agentKey])
  expect(saved.get(userKey)?.spec.color).toBe('lake')
  expect(saved.get(agentKey)).toEqual(record)
  expect([...value(await port.read([]))]).toEqual([])
})

test('corrupt JSON, malformed records and unknown keys fail closed on read, save and delete without overwriting evidence', async () => {
  const { port, storePath } = setup()
  const badFiles = [
    '{broken',
    'null',
    JSON.stringify({ v: 2, avatars: {} }),
    JSON.stringify({ v: 1, avatars: [] }),
    JSON.stringify({
      v: 1,
      avatars: { [agentKey]: { ...record, spec: { ...spec, eyes: 'html' } } },
    }),
    JSON.stringify({
      v: 1,
      avatars: { [agentKey]: { ...record, updatedAt: -1 } },
    }),
    JSON.stringify({
      v: 1,
      avatars: { [agentKey]: { ...record, updatedBy: null } },
    }),
    JSON.stringify({ v: 1, avatars: { 'user:has space': record } }),
  ]
  fs.mkdirSync(path.dirname(storePath), { recursive: true, mode: 0o700 })
  for (const text of badFiles) {
    fs.writeFileSync(storePath, text, { mode: 0o600 })
    expect(await port.read([agentKey])).toMatchObject({
      ok: false,
      failure: { code: 'unreachable' },
    })
    expect(await port.save(userKey, spec, actor)).toMatchObject({
      ok: false,
      failure: { code: 'unreachable' },
    })
    expect(await port.save(agentKey, null, actor)).toMatchObject({
      ok: false,
      failure: { code: 'unreachable' },
    })
    expect(fs.readFileSync(storePath, 'utf8')).toBe(text)
  }
})

test('non-0600 files fail closed without repairing their mode or content', async () => {
  const { port, storePath } = setup()
  putFile(storePath, { v: 1, avatars: { [agentKey]: record } })
  const before = fs.readFileSync(storePath, 'utf8')
  for (const mode of [0o644, 0o640, 0o400, 0o700]) {
    fs.chmodSync(storePath, mode)
    expect(await port.read([agentKey])).toMatchObject({
      ok: false,
      failure: { code: 'unreachable' },
    })
    expect(await port.save(userKey, spec, actor)).toMatchObject({
      ok: false,
      failure: { code: 'unreachable' },
    })
    expect(fs.readFileSync(storePath, 'utf8')).toBe(before)
    expect(fs.statSync(storePath).mode & 0o7777).toBe(mode)
  }
  fs.chmodSync(storePath, 0o600)
  expect(value(await port.read([agentKey])).get(agentKey)).toEqual(record)
})

test('symlinks and directories cannot be used as avatar stores', async () => {
  const { port, root, storePath } = setup()
  const target = path.join(root, 'target.json')
  putFile(target, { v: 1, avatars: { [agentKey]: record } })
  const before = fs.readFileSync(target, 'utf8')
  fs.mkdirSync(path.dirname(storePath), { recursive: true })
  fs.symlinkSync(target, storePath)
  expect(await port.read([agentKey])).toMatchObject({
    ok: false,
    failure: { code: 'unreachable' },
  })
  expect(await port.save(userKey, spec, actor)).toMatchObject({
    ok: false,
    failure: { code: 'unreachable' },
  })
  expect(fs.readFileSync(target, 'utf8')).toBe(before)
  expect(fs.lstatSync(storePath).isSymbolicLink()).toBe(true)
  fs.unlinkSync(storePath)
  fs.mkdirSync(storePath)
  expect(await port.read([agentKey])).toMatchObject({
    ok: false,
    failure: { code: 'unreachable' },
  })
  expect(await port.save(userKey, spec, actor)).toMatchObject({
    ok: false,
    failure: { code: 'unreachable' },
  })
})

test('off-list choices and invalid keys reject before touching disk; extra spec fields are discarded', async () => {
  const { port, storePath } = setup()
  for (const patch of [
    { shape: 'triangle' },
    { color: '#fff' },
    { material: 'html' },
    { eyes: 'script' },
    { mouth: 'svg' },
    { cheeks: 'yes' },
    { accessory: 'crown' },
  ]) {
    expect(
      await port.save(
        agentKey,
        { ...spec, ...patch } as unknown as AvatarSpec,
        actor,
      ),
    ).toMatchObject({ ok: false, failure: { code: 'rejected' } })
  }
  for (const key of [
    'agent:somewhere',
    'user:',
    'user:has space',
    `user:${'x'.repeat(300)}`,
  ]) {
    expect(await port.save(key as AvatarKey, spec, actor)).toMatchObject({
      ok: false,
      failure: { code: 'rejected' },
    })
    expect(await port.save(key as AvatarKey, null, actor)).toMatchObject({
      ok: false,
      failure: { code: 'rejected' },
    })
    expect(await port.read([key as AvatarKey])).toMatchObject({
      ok: false,
      failure: { code: 'rejected' },
    })
  }
  expect(fs.existsSync(path.dirname(storePath))).toBe(false)
  value(
    await port.save(
      agentKey,
      { ...spec, state: 'speaking', markup: '<script>' } as AvatarSpec,
      actor,
    ),
  )
  expect(value(await port.read([agentKey])).get(agentKey)).toEqual(record)
  expect(fs.readFileSync(storePath, 'utf8')).not.toContain('markup')
  expect(fs.readFileSync(storePath, 'utf8')).not.toContain('speaking')
})

test('10 000 saved entries allow replacements and deletion, reject a new key, and free a slot after deletion', async () => {
  const { port, storePath } = setup()
  const avatars = Object.fromEntries(
    Array.from({ length: 10_000 }, (_, i) => [`user:${i}`, record]),
  )
  putFile(storePath, { v: 1, avatars })
  const before = fs.readFileSync(storePath, 'utf8')
  expect(await port.save(userKey, spec, actor)).toMatchObject({
    ok: false,
    failure: { code: 'rejected' },
  })
  expect(fs.readFileSync(storePath, 'utf8')).toBe(before)
  value(await port.save('user:0', { ...spec, shape: 'orb' }, actor))
  expect(value(await port.read(['user:0'])).get('user:0')?.spec.shape).toBe(
    'orb',
  )
  value(await port.save('user:1', null, actor))
  value(await port.save(userKey, spec, actor))
  expect(value(await port.read([userKey, 'user:1'])).get(userKey)).toEqual(
    record,
  )
  putFile(storePath, { v: 1, avatars: { ...avatars, [userKey]: record } })
  expect(await port.read([userKey])).toMatchObject({
    ok: false,
    failure: { code: 'unreachable' },
  })
  expect(await port.save('user:0', null, actor)).toMatchObject({
    ok: false,
    failure: { code: 'unreachable' },
  })
})

test('two instances concurrently saving the same file preserve both updates', async () => {
  const { port, options } = setup()
  const peer = new ConsoleAvatars(options)
  const results = await Promise.all([
    port.save(agentKey, spec, actor),
    peer.save(userKey, { ...spec, color: 'lake' }, actor),
  ])
  results.forEach(value)
  const saved = value(await port.read([agentKey, userKey]))
  expect(saved.get(agentKey)).toEqual(record)
  expect(saved.get(userKey)?.spec.color).toBe('lake')
})

test('two real processes start together and retain every independently saved key', async () => {
  const { root, storePath, port } = setup()
  const workerPath = path.join(root, 'writer.ts')
  const moduleUrl = new URL(
    '../../src/commands/consoleAvatars.ts',
    import.meta.url,
  ).href
  await Bun.write(
    workerPath,
    `
import { ConsoleAvatars } from ${JSON.stringify(moduleUrl)}
const port = new ConsoleAvatars({ path: process.argv[2] })
process.stdout.write('ready\\n')
await Bun.stdin.text()
for (let i = 0; i < 20; i++) {
  const result = await port.save('user:' + process.argv[3] + '-' + i, ${JSON.stringify(spec)}, ${JSON.stringify(actor)})
  if (!result.ok) throw new Error(result.failure.message)
}
`,
  )
  const children = ['one', 'two'].map(name =>
    Bun.spawn([process.execPath, workerPath, storePath, name], {
      env: { ...process.env, QIANMO_CONFIG_DIR: root },
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    }),
  )
  const errors = children.map(child => new Response(child.stderr).text())
  try {
    await Promise.all(
      children.map(async child => {
        const reader = child.stdout.getReader()
        const ready = await reader.read()
        reader.releaseLock()
        expect(new TextDecoder().decode(ready.value)).toBe('ready\n')
      }),
    )
    children.forEach(child => {
      child.stdin.write('go\n')
      child.stdin.end()
    })
    expect(await Promise.all(children.map(child => child.exited))).toEqual([
      0, 0,
    ])
    expect(await Promise.all(errors)).toEqual(['', ''])
    const keys = ['one', 'two'].flatMap(name =>
      Array.from(
        { length: 20 },
        (_, i) => parseAvatarKey(`user:${name}-${i}`)!,
      ),
    )
    const saved = value(await port.read(keys))
    expect([...saved.keys()].sort()).toEqual([...keys].sort())
    for (const key of keys) expect(saved.get(key)?.spec).toEqual(spec)
  } finally {
    children.forEach(child => child.kill())
    await Promise.all(children.map(child => child.exited))
  }
}, 30_000)

test('locks older than 30 seconds recover even when the crashed file is empty', async () => {
  const { port, storePath } = setup()
  value(await port.save(agentKey, spec, actor))
  const lockPath = `${storePath}.lock`
  for (const content of ['', '{torn', JSON.stringify({ pid: process.pid })]) {
    fs.writeFileSync(lockPath, content, { mode: 0o600 })
    const stale = new Date(Date.now() - 31_000)
    fs.utimesSync(lockPath, stale, stale)
    value(await port.save(userKey, spec, actor))
    expect(fs.existsSync(lockPath)).toBe(false)
    expect([...value(await port.read([agentKey, userKey])).keys()]).toEqual([
      agentKey,
      userKey,
    ])
  }
})

test('a fresh lock refuses writes after a bounded wait without removing the holder or changing saved figures', async () => {
  const { port, storePath, options } = setup()
  value(await port.save(agentKey, spec, actor))
  const before = fs.readFileSync(storePath, 'utf8')
  const lockPath = `${storePath}.lock`
  fs.writeFileSync(lockPath, 'active holder', { mode: 0o600 })
  // The wait is bounded at 200 ms instead of the default 5 s: what is tested
  // is that it ends in a refusal and leaves the holder alone, not its length.
  const bounded = new ConsoleAvatars({ ...options, lockWaitMs: 200 })
  expect(await bounded.save(userKey, spec, actor)).toMatchObject({
    ok: false,
    failure: { code: 'unreachable' },
  })
  expect(fs.readFileSync(lockPath, 'utf8')).toBe('active holder')
  expect(fs.readFileSync(storePath, 'utf8')).toBe(before)
  expect(value(await port.read([agentKey, userKey])).get(agentKey)).toEqual(
    record,
  )
}, 10_000)

test('a replaced lock prevents a stale holder from writing or deleting its successor lock', async () => {
  const { port, storePath } = setup()
  value(await port.save(agentKey, spec, actor))
  const before = fs.readFileSync(storePath, 'utf8')
  const lockPath = `${storePath}.lock`
  const stale = new ConsoleAvatars({
    path: storePath,
    now() {
      fs.unlinkSync(lockPath)
      fs.writeFileSync(lockPath, 'successor', { mode: 0o600 })
      return 2000
    },
  })
  expect(await stale.save(userKey, spec, actor)).toMatchObject({
    ok: false,
    failure: { code: 'unreachable' },
  })
  expect(fs.readFileSync(storePath, 'utf8')).toBe(before)
  expect(fs.readFileSync(lockPath, 'utf8')).toBe('successor')
})

interface RunningConsole {
  readonly child: Bun.Subprocess<'ignore', 'pipe', 'pipe'>
  readonly origin: string
  readonly admin: string
  readonly view: string
}

async function startConsole(root: string): Promise<RunningConsole> {
  const cli = path.resolve(import.meta.dir, '../../src/cli.ts')
  const child = Bun.spawn(
    [
      process.execPath,
      cli,
      'console',
      '--port',
      '0',
      '--registry',
      'http://127.0.0.1:9',
    ],
    {
      env: { ...process.env, QIANMO_CONFIG_DIR: root },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )
  const reader = child.stdout.getReader()
  const decoder = new TextDecoder()
  let banner = ''
  try {
    while (!banner.includes('sourceCommit')) {
      const chunk = await reader.read()
      if (chunk.done) throw new Error('console exited before startup')
      banner += decoder.decode(chunk.value)
    }
    const field = (name: string) =>
      new RegExp(`^${name}\\s+(\\S+)`, 'm').exec(banner)?.[1] ?? ''
    const origin = field('console')
    if (!origin.startsWith('http://127.0.0.1:'))
      throw new Error('missing console origin')
    return {
      child,
      origin,
      admin: field('admin-token'),
      view: field('view-token'),
    }
  } catch (error) {
    child.kill()
    await child.exited
    throw error
  } finally {
    reader.releaseLock()
  }
}

interface AvatarsBody {
  readonly editable: boolean
  readonly avatars: Record<
    string,
    {
      readonly spec: AvatarSpec
      readonly saved: boolean
      readonly updatedAt: number | null
    }
  >
}

test('default qm console wiring saves via HTTP, survives restart, deletes to default, and serves default fragments when storage is corrupt', async () => {
  const { root } = setup()
  const storePath = path.join(root, 'qianmo', 'console', 'avatars.json')
  let running = await startConsole(root)
  const query = `/v0/avatars?key=${encodeURIComponent(agentKey)}`
  const mutation = `/v0/avatars/${encodeURIComponent(agentKey)}`
  try {
    const initial = await fetch(`${running.origin}${query}`, {
      headers: { authorization: `Bearer ${running.admin}` },
    })
    expect(initial.status).toBe(200)
    expect(await initial.json()).toMatchObject({
      editable: true,
      avatars: {
        [agentKey]: {
          saved: false,
          spec: defaultAvatar('qianmo://node-a/main'),
        },
      },
    })
    const readonly = await fetch(`${running.origin}${mutation}`, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${running.view}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(spec),
    })
    expect(readonly.status).toBe(403)
    expect(fs.existsSync(storePath)).toBe(false)
    const saved = await fetch(`${running.origin}${mutation}`, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${running.admin}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(spec),
    })
    expect(saved.status).toBe(200)
    expect(fs.statSync(storePath).mode & 0o7777).toBe(0o600)
    running.child.kill()
    await running.child.exited
    running = await startConsole(root)
    const reopened = await fetch(`${running.origin}${query}`, {
      headers: { authorization: `Bearer ${running.admin}` },
    })
    expect(reopened.status).toBe(200)
    const body = (await reopened.json()) as AvatarsBody
    expect(body.avatars[agentKey]).toMatchObject({ saved: true, spec })
    expect(body.avatars[agentKey]?.updatedAt).toBeGreaterThan(0)
    const rejected = await fetch(`${running.origin}${mutation}`, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${running.admin}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ ...spec, shape: 'triangle' }),
    })
    expect(rejected.status).toBe(400)
    const removed = await fetch(`${running.origin}${mutation}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${running.admin}` },
    })
    expect(removed.status).toBe(200)
    const defaults = await fetch(`${running.origin}${query}`, {
      headers: { authorization: `Bearer ${running.admin}` },
    })
    expect(await defaults.json()).toMatchObject({
      avatars: {
        [agentKey]: {
          saved: false,
          spec: defaultAvatar('qianmo://node-a/main'),
        },
      },
    })
    fs.writeFileSync(storePath, '{broken')
    const closed = await fetch(`${running.origin}${query}`, {
      headers: { authorization: `Bearer ${running.admin}` },
    })
    expect(closed.status).toBe(503)
    const fragment = await fetch(
      `${running.origin}/fragments/avatar?key=${encodeURIComponent(agentKey)}`,
      { headers: { authorization: `Bearer ${running.admin}` } },
    )
    expect(fragment.status).toBe(200)
    const html = await fragment.text()
    const fallback = defaultAvatar('qianmo://node-a/main')
    // The editor offers only what is drawn; the rest of the figure rides
    // along in data-spec and is saved as it was.
    for (const field of ['shape', 'color', 'eyes'] as const) {
      expect(html).toContain(
        `name="${field}" value="${fallback[field]}" checked`,
      )
    }
    const carried = /data-spec="([^"]*)"/
      .exec(html)?.[1]
      ?.replaceAll('&quot;', '"')
      .replaceAll('&amp;', '&')
    expect(JSON.parse(carried ?? 'null')).toEqual(fallback)
    const blocked = await fetch(`${running.origin}${mutation}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${running.admin}` },
    })
    expect(blocked.status).toBe(503)
    expect(fs.readFileSync(storePath, 'utf8')).toBe('{broken')
  } finally {
    running.child.kill()
    await running.child.exited
  }
}, 60_000)
