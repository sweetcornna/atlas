// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { parseFrontmatter } from '@oh-my-pi/pi-utils/frontmatter'
import {
  buildMemoryReview,
  FileMemoryStore,
  parseEntry,
  serializeEntry,
  type MemoryWriteInput,
} from '../src/index.js'
import { createSandbox, type Sandbox } from './helpers.js'

let sandbox: Sandbox
beforeEach(() => {
  sandbox = createSandbox()
})
afterEach(() => sandbox.dispose())
const scope = { layer: 'project' as const, projectKey: 'atlas' }
const input = (extra: Partial<MemoryWriteInput> = {}): MemoryWriteInput => ({
  scope,
  title: 'Database policy',
  summary: 'Use Postgres',
  body: 'Choose Postgres for durable records.',
  source: { kind: 'user', id: 'local' },
  tags: ['database'],
  ...extra,
})
const pathOf = (id: string) =>
  join(sandbox.root, 'project', 'atlas', `${id}.md`)

async function crash(id: string, operation = 'write') {
  const child = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, 'supersession-crash.runner.ts'),
      sandbox.root,
      id,
      operation,
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  )
  await child.exited
  expect(child.signalCode).toBe('SIGKILL')
}

describe('explicit supersession', () => {
  test('native base frontmatter reads links; past and present event axes remain distinct', () => {
    const old = sandbox.store.write(input())
    sandbox.clock.advance(86_400_000)
    const next = sandbox.store.write(
      input({ summary: 'Use SQLite', supersedes: [old.id] }),
      'operator',
    )
    const file = readFileSync(pathOf(next.id), 'utf8')
    expect(parseEntry(file)).toEqual(next)
    expect(parseFrontmatter(file).frontmatter.qm_supersedes).toEqual([old.id])
    expect(sandbox.store.query().map(entry => entry.id)).toEqual([next.id])
    expect(
      sandbox.store
        .query({ asOf: new Date(old.validAt) })
        .map(entry => entry.id),
    ).toEqual([old.id])
    expect(sandbox.store.getEntry(old.id)?.expiredAt).toBeNull()
    expect(sandbox.store.getEntry(old.id)?.invalidAt).toBe(next.validAt)
  })

  test('rejects cross scope, cross layer, forged peer provenance, invalid time and duplicate replacement', () => {
    const old = sandbox.store.write(input())
    for (const alternative of [
      { layer: 'project', projectKey: 'elsewhere' },
      { layer: 'working', projectKey: 'atlas', taskId: 'task' },
    ] as const) {
      expect(() =>
        sandbox.store.write(
          input({ scope: alternative, supersedes: [old.id] }),
          'operator',
        ),
      ).toThrow('same scope')
    }
    expect(() => sandbox.store.write(input({ supersedes: [old.id] }))).toThrow(
      'peer',
    )
    expect(() =>
      sandbox.store.write(
        input({ source: { kind: 'agent', id: 'peer' }, supersedes: [old.id] }),
      ),
    ).toThrow('higher-trust')
    expect(() =>
      sandbox.store.write(
        input({
          source: { kind: 'session', id: 'peer' },
          supersedes: [old.id],
        }),
        'operator',
      ),
    ).toThrow('higher-trust')
    expect(() =>
      sandbox.store.write(
        input({ validAt: new Date(0), supersedes: [old.id] }),
        'operator',
      ),
    ).toThrow('validAt')
    expect(sandbox.store.query()).toHaveLength(1)
    sandbox.clock.advance(1)
    sandbox.store.write(input({ supersedes: [old.id] }), 'operator')
    expect(() =>
      sandbox.store.write(input({ supersedes: [old.id] }), 'operator'),
    ).toThrow('already invalidated')
  })

  test('peer may replace peer, but cannot replace imported or archived provenance', () => {
    const old = sandbox.store.write(
      input({ source: { kind: 'session', id: 'peer' } }),
    )
    sandbox.clock.advance(1)
    const next = sandbox.store.write(
      input({ source: { kind: 'agent', id: 'peer' }, supersedes: [old.id] }),
    )
    expect(sandbox.store.getEntry(old.id)?.supersededBy).toBe(next.id)
    for (const kind of ['archive', 'import'] as const) {
      const protectedEntry = sandbox.store.write(
        input({ source: { kind, id: 'record' } }),
      )
      expect(() =>
        sandbox.store.write(
          input({
            source: { kind: 'agent', id: 'peer' },
            supersedes: [protectedEntry.id],
          }),
        ),
      ).toThrow('higher-trust')
    }
  })

  test('undo is scoped, audited, idempotent and does not undo an independent retirement', () => {
    const old = sandbox.store.write(input())
    sandbox.clock.advance(1)
    const next = sandbox.store.write(
      input({ supersedes: [old.id] }),
      'operator',
    )
    sandbox.store.revoke(old.id, { reason: 'withdraw', by: 'operator' })
    expect(() =>
      sandbox.store.undoSupersedes(next.id, {
        scope: { ...scope, projectKey: 'other' },
        writer: 'operator',
        by: 'op',
        reason: 'bad',
      }),
    ).toThrow('exact scope')
    const undo = {
      scope,
      writer: 'operator' as const,
      by: 'operator:alice',
      reason: 'wrong decision',
    }
    const canceled = sandbox.store.undoSupersedes(next.id, undo)
    expect(canceled.supersedesUndo).toEqual({
      at: sandbox.clock.now().toISOString(),
      by: undo.by,
      reason: undo.reason,
    })
    const bytes = readFileSync(pathOf(next.id), 'utf8')
    sandbox.clock.advance(1)
    expect(
      sandbox.store.undoSupersedes(next.id, {
        ...undo,
        reason: 'second attempt',
      }),
    ).toEqual(canceled)
    expect(readFileSync(pathOf(next.id), 'utf8')).toBe(bytes)
    const reopened = sandbox.reopen()
    expect(reopened.getEntry(old.id)?.invalidAt).toBeNull()
    expect(reopened.getEntry(old.id)?.retirement?.reason).toBe('withdraw')
    expect(reopened.query().map(entry => entry.id)).toEqual([next.id])
    expect(reopened.getEntry(next.id)?.supersedesUndo).toEqual(
      canceled.supersedesUndo,
    )
  })

  test('real SIGKILL between intent and invalidation repairs at startup; repair writes nothing twice', async () => {
    const old = sandbox.store.write(input())
    await crash(old.id)
    expect(
      parseEntry(readFileSync(pathOf(old.id), 'utf8')).invalidAt,
    ).toBeNull()
    const reopened = sandbox.reopen()
    expect(reopened.getEntry(old.id)?.invalidAt).toBe(
      '2026-10-01T00:00:00.000Z',
    )
    const stamp = statSync(pathOf(old.id)).mtimeMs
    sandbox.reopen()
    expect(statSync(pathOf(old.id)).mtimeMs).toBe(stamp)
    expect(
      reopened.query({ asOf: new Date('2026-10-02') }).map(entry => entry.id),
    ).toEqual(['replacement'])
    await crash('replacement', 'undo')
    expect(
      parseEntry(readFileSync(pathOf(old.id), 'utf8')).invalidAt,
    ).not.toBeNull()
    const recovered = sandbox.reopen()
    expect(recovered.getEntry(old.id)?.invalidAt).toBeNull()
    expect(recovered.getEntry('replacement')?.supersedesUndo?.by).toBe(
      'operator:crash',
    )
    const undoStamp = statSync(pathOf(old.id)).mtimeMs
    sandbox.reopen()
    expect(statSync(pathOf(old.id)).mtimeMs).toBe(undoStamp)
  })

  test('an old canceled relation cannot undo a newer replacement', () => {
    const old = sandbox.store.write(input())
    const next = sandbox.store.write(
      input({ supersedes: [old.id] }),
      'operator',
    )
    sandbox.store.undoSupersedes(next.id, {
      scope,
      writer: 'operator',
      by: 'op',
      reason: 'wrong',
    })
    const newer = sandbox.store.write(
      input({ supersedes: [old.id] }),
      'operator',
    )
    expect(sandbox.reopen().getEntry(old.id)?.supersededBy).toBe(newer.id)
  })
})

describe('replacement transactions', () => {
  test('invalid second target leaves the first and new-entry count unchanged', () => {
    const first = sandbox.store.write(input())
    expect(() =>
      sandbox.store.write(
        input({ supersedes: [first.id, 'missing'] }),
        'operator',
      ),
    ).toThrow('no memory entry')
    expect(sandbox.store.getEntry(first.id)?.invalidAt).toBeNull()
    expect(sandbox.store.query({ includeRetired: true })).toHaveLength(1)
    const a = sandbox.store.write(
      input({ scope: { layer: 'working', projectKey: 'p', taskId: 'a' } }),
    )
    expect(() =>
      sandbox.store.write(
        input({
          scope: { layer: 'working', projectKey: 'p', taskId: 'b' },
          supersedes: [a.id],
        }),
        'operator',
      ),
    ).toThrow('same scope')
  })

  test('two real processes replacing one target yield one complete winner', async () => {
    const old = sandbox.store.write(input())
    const go = join(sandbox.root, 'race-go')
    const ids = ['race-a', 'race-b']
    const children = ids.map(id =>
      Bun.spawn(
        [
          process.execPath,
          join(import.meta.dir, 'supersession-race.runner.ts'),
          sandbox.root,
          old.id,
          id,
          go,
        ],
        { stdout: 'pipe', stderr: 'pipe' },
      ),
    )
    const deadline = Date.now() + 5000
    while (!ids.every(id => existsSync(`${go}.${id}.ready`))) {
      if (Date.now() > deadline)
        throw new Error('race fixture readiness timeout')
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    writeFileSync(go, '')
    const results = await Promise.all(
      children.map(async child => {
        expect(await child.exited).toBe(0)
        return JSON.parse(await new Response(child.stdout).text()) as {
          ok: boolean
          id?: string
          error?: string
        }
      }),
    )
    expect(results.filter(result => result.ok)).toHaveLength(1)
    expect(results.find(result => !result.ok)?.error).toContain(
      'already invalidated',
    )
    const reopened = sandbox.reopen()
    expect(reopened.getEntry(old.id)?.supersededBy).toBe(
      results.find(result => result.ok)?.id,
    )
    expect(reopened.query({ includeRetired: true })).toHaveLength(2)
  })
})

describe('read-only deterministic review', () => {
  test('reports stale and conflicting candidates, never crosses scopes or includes retired entries', () => {
    const old = sandbox.store.write(input())
    const next = sandbox.store.write(
      input({
        summary: 'Prefer SQLite',
        body: 'Choose SQLite for durable records.',
      }),
    )
    sandbox.store.write(input({ scope: { ...scope, projectKey: 'elsewhere' } }))
    const retired = sandbox.store.write(input())
    sandbox.store.revoke(retired.id, { by: 'op', reason: 'wrong' })
    const entries = sandbox.store.query({ includeRetired: true })
    const options = { asOf: new Date('2027-01-01'), staleDays: 90 }
    const report = buildMemoryReview(entries, options)
    expect(buildMemoryReview([...entries].reverse(), options)).toEqual(report)
    expect(report.stale).toHaveLength(3)
    expect(report.conflicts).toMatchObject([
      { left: old.id, right: next.id, method: 'local-text' },
    ])
    expect(
      buildMemoryReview(entries, {
        ...options,
        semanticPairs: [{ left: old.id, right: next.id, score: 0.9 }],
      }).conflicts[0]?.method,
    ).toBe('semantic-index')
  })

  test('read-only opening and reporting a crashed intent changes no bytes and does not repair it', async () => {
    const old = sandbox.store.write(input())
    await crash(old.id)
    const snapshot = () =>
      readdirSync(sandbox.root, { recursive: true })
        .filter(name => statSync(join(sandbox.root, String(name))).isFile())
        .sort()
        .map(name => [
          name,
          readFileSync(join(sandbox.root, String(name)), 'hex'),
        ])
    const before = snapshot()
    const store = new FileMemoryStore({ root: sandbox.root, readOnly: true })
    buildMemoryReview(store.query({ includeRetired: true }), {
      asOf: new Date('2026-10-02'),
    })
    expect(snapshot()).toEqual(before)
    expect(store.getEntry(old.id)?.invalidAt).toBeNull()
    expect(() => store.write(input())).toThrow('read-only')
    expect(() => store.invalidate(old.id)).toThrow('read-only')
    const source = readFileSync(
      join(import.meta.dir, '../src/review.ts'),
      'utf8',
    )
    expect(source).not.toMatch(
      /\b(?:revoke|invalidate|write|retire|undoSupersedes)\s*\(/,
    )
    expect(source).not.toMatch(/node:fs|\.\/store|\.\/mutation/)
    expect(serializeEntry(store.getEntry(old.id)!)).toBe(
      readFileSync(pathOf(old.id), 'utf8'),
    )
  })
})
