// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: MIT

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AuditSource,
  AuditTrail,
  readTrail,
  type AuditRecord,
} from '@qianmo/audit'
import { generateNodeKeyPair } from '@qianmo/capability'
import {
  DESTRUCTIVE_WORDS,
  AuditWitnessScheduler,
  FileWitnessAnchorStore,
  WitnessOp,
  assertWitnessSurfaceIsSafe,
  canonicalizeWitnessAnchor,
  checkWitnessStaleness,
  formatWitnessVerification,
  remoteWitnessAnchorReader,
  remoteWitnessAnchorWriter,
  signWitnessAnchor,
  startWitnessService,
  verifyAuditWitness,
  verifyWitnessAnchor,
  witnessAnchorOf,
  type WitnessRoute,
} from '../index.js'

const NODE = 'node-a'
const WRITE_TOKEN = 'witness-write-token-not-a-real-secret'
const READ_TOKEN = 'witness-read-token-not-a-real-secret'

const temporaryDirectories: string[] = []
const services: Array<{ stop(): Promise<void> }> = []

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'qianmo-witness-'))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(async () => {
  for (const service of services.splice(0)) await service.stop()
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function appendStory(path: string, count: number): void {
  const trail = new AuditTrail(path)
  for (let index = 0; index < count; index++) {
    const seq = trail.written + 1
    trail.append({
      at: 1_000 + seq,
      source: AuditSource.Resident,
      kind: seq === 3 ? 'rate_limit' : `event-${seq}`,
      outcome: seq === 3 ? 'refused' : seq === 4 ? 'dropped' : 'ok',
      node: NODE,
    })
  }
  trail.close()
}

function rewriteTrail(
  sourcePath: string,
  targetPath: string,
  change: (records: readonly AuditRecord[]) => readonly AuditRecord[],
): void {
  const rewritten = new AuditTrail(targetPath)
  for (const record of change(readTrail(sourcePath).records)) {
    const { seq: _seq, prev: _prev, ...input } = record
    rewritten.append(input)
  }
  rewritten.close()
}

function signedAnchor(keys: ReturnType<typeof generateNodeKeyPair>) {
  return signWitnessAnchor(
    {
      v: 1,
      node: NODE,
      seq: 1,
      head: 'c'.repeat(64),
      count: 1,
      at: 1,
    },
    keys,
  )
}

function hangingFetch(onAbort: () => void): typeof fetch {
  return ((_input, init) => {
    init?.signal?.addEventListener('abort', onAbort, { once: true })
    return new Promise<Response>(() => {})
  }) as typeof fetch
}

describe('the signed anchor format', () => {
  test('signs the fixed §4.3 field order with the existing node key', () => {
    const keys = generateNodeKeyPair()
    const anchor = signWitnessAnchor(
      {
        v: 1,
        node: NODE,
        seq: 7,
        head: 'a'.repeat(64),
        count: 7,
        at: 123,
      },
      keys,
    )
    expect(canonicalizeWitnessAnchor(anchor)).toBe(
      '[1,"node-a",7,"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",7,123]',
    )
    expect(verifyWitnessAnchor(anchor, keys.publicKey)).toBe(true)
    expect(verifyWitnessAnchor({ ...anchor, count: 8 }, keys.publicKey)).toBe(
      false,
    )
  })
})

describe('the append-only witness endpoint', () => {
  test('rejects destructive names and a widened writer surface at import-time checks', () => {
    for (const word of DESTRUCTIVE_WORDS) {
      const unsafe = new Map<string, WitnessRoute>([
        [
          `${word}Anchor`,
          {
            method: 'POST',
            path: '/v0/anchor',
            audience: 'reader',
            rationale: 'red direction',
          },
        ],
      ])
      expect(() => assertWitnessSurfaceIsSafe(unsafe)).toThrow(
        /destructive word/,
      )
    }
    const widened = new Map<string, WitnessRoute>([
      [
        WitnessOp.CreateAnchor,
        {
          method: 'POST',
          path: '/v0/anchor',
          audience: 'writer',
          rationale: 'valid route',
        },
      ],
      [
        WitnessOp.ListAnchors,
        {
          method: 'GET',
          path: '/v0/anchor?node=',
          audience: 'writer',
          rationale: 'must be refused',
        },
      ],
    ])
    expect(() => assertWitnessSurfaceIsSafe(widened)).toThrow(
      /writer audience may only reach/,
    )
  })

  test('refuses overwrite, deletion, and non-whitelisted methods over a real Bun server', async () => {
    const directory = temporaryDirectory()
    const store = new FileWitnessAnchorStore({ root: join(directory, 'store') })
    const service = startWitnessService({
      store,
      writeToken: WRITE_TOKEN,
      readToken: READ_TOKEN,
      now: () => 1_234,
    })
    services.push(service)
    const base = service.url as string
    const keys = generateNodeKeyPair()
    const anchor = signWitnessAnchor(
      {
        v: 1,
        node: NODE,
        seq: 1,
        head: 'b'.repeat(64),
        count: 1,
        at: 1,
      },
      keys,
    )
    const create = await fetch(`${base}/v0/anchor`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${WRITE_TOKEN}`,
        'content-type': 'application/json',
      },
      // The sender is allowed to declare only `anchor.at`; a similarly named
      // field in its body must not become the witness receipt time.
      body: JSON.stringify({ ...anchor, receivedAt: Number.MAX_SAFE_INTEGER }),
    })
    expect(create.status).toBe(201)
    expect(await create.json()).toEqual({ anchor, receivedAt: 1_234 })
    const overwrite = await fetch(`${base}/v0/anchor`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${WRITE_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(anchor),
    })
    expect(overwrite.status).toBe(409)
    const deletion = await fetch(`${base}/v0/anchor?node=${NODE}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${WRITE_TOKEN}` },
    })
    expect(deletion.status).toBe(405)
    const nonWhitelisted = await fetch(`${base}/v0/anchor`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${WRITE_TOKEN}` },
    })
    expect(nonWhitelisted.status).toBe(405)
    expect(await store.list(NODE)).toEqual([{ anchor, receivedAt: 1_234 }])
  })

  test('bounds writer and reader requests even when fetch ignores abort', async () => {
    const anchor = signedAnchor(generateNodeKeyPair())
    let writerAborted = false
    const writer = remoteWitnessAnchorWriter({
      url: 'http://witness.test',
      token: WRITE_TOKEN,
      timeoutMs: 10,
      fetchImpl: hangingFetch(() => {
        writerAborted = true
      }),
    })
    await expect(writer.append(anchor)).rejects.toThrow('timed out after 10 ms')
    expect(writerAborted).toBe(true)

    let readerAborted = false
    const reader = remoteWitnessAnchorReader({
      url: 'http://witness.test',
      token: READ_TOKEN,
      timeoutMs: 10,
      fetchImpl: hangingFetch(() => {
        readerAborted = true
      }),
    })
    await expect(reader.list(NODE)).rejects.toThrow('timed out after 10 ms')
    expect(readerAborted).toBe(true)
  })

  test('bounds a hanging remote reader body under the same request deadline', async () => {
    let aborted = false
    const reader = remoteWitnessAnchorReader({
      url: 'http://witness.test',
      token: READ_TOKEN,
      timeoutMs: 10,
      fetchImpl: ((_input, init) => {
        init?.signal?.addEventListener(
          'abort',
          () => {
            aborted = true
          },
          { once: true },
        )
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => new Promise<unknown>(() => {}),
        } as unknown as Response)
      }) as typeof fetch,
    })
    await expect(reader.list(NODE)).rejects.toThrow('timed out after 10 ms')
    expect(aborted).toBe(true)
  })
})

describe('§5 witness variants', () => {
  let directory: string
  let path: string
  let baseline: string
  let store: FileWitnessAnchorStore
  let base: string
  let keys: ReturnType<typeof generateNodeKeyPair>
  let witnessNow: number

  async function publish(at: number, targetPath = path): Promise<void> {
    witnessNow = at
    const scheduler = new AuditWitnessScheduler({
      node: NODE,
      trailPath: targetPath,
      keys,
      writer: remoteWitnessAnchorWriter({ url: base, token: WRITE_TOKEN }),
      now: () => at,
    })
    await scheduler.tick()
  }

  beforeEach(async () => {
    directory = temporaryDirectory()
    path = join(directory, 'node-a', 'trail.ndjson')
    witnessNow = 0
    store = new FileWitnessAnchorStore({ root: join(directory, 'witness') })
    const service = startWitnessService({
      store,
      writeToken: WRITE_TOKEN,
      readToken: READ_TOKEN,
      now: () => witnessNow,
    })
    services.push(service)
    base = service.url as string
    keys = generateNodeKeyPair()

    appendStory(path, 5)
    await publish(1_000)
    appendStory(path, 3)
    await publish(2_000)
    appendStory(path, 4)
    baseline = readFileSync(path, 'utf8')
  })

  test('A: detects a full rewrite that removes a refused record and recomputes hashes', async () => {
    const attacked = join(directory, 'attacked-a.ndjson')
    rewriteTrail(path, attacked, records =>
      records.filter(record => record.outcome !== 'refused'),
    )
    expect(readTrail(attacked).intact).toBe(true)
    const anchors = await store.list(NODE)
    const result = verifyAuditWitness({
      trailPath: attacked,
      anchors,
      publicKey: keys.publicKey,
      now: () => 2_500,
      staleAfterMs: 1_000_000,
    })
    expect(result.tampered).toBe(true)
    expect(result.issues.some(issue => issue.kind === 'head_mismatch')).toBe(
      true,
    )
  })

  test('B: detects changing refused to ok without changing the record count', async () => {
    const attacked = join(directory, 'attacked-b.ndjson')
    rewriteTrail(path, attacked, records =>
      records.map(record =>
        record.outcome === 'refused'
          ? { ...record, outcome: 'ok' as const }
          : record,
      ),
    )
    expect(readTrail(attacked).records).toHaveLength(
      readTrail(path).records.length,
    )
    expect(readTrail(attacked).intact).toBe(true)
    const result = verifyAuditWitness({
      trailPath: attacked,
      anchors: await store.list(NODE),
      publicKey: keys.publicKey,
      now: () => 2_500,
      staleAfterMs: 1_000_000,
    })
    expect(result.tampered).toBe(true)
  })

  test('C: reports an explicit unwitnessed tail when only the anchoring window changed', async () => {
    const attacked = join(directory, 'attacked-c.ndjson')
    rewriteTrail(path, attacked, records =>
      records.map(record =>
        record.seq === 10 ? { ...record, kind: 'changed-in-window' } : record,
      ),
    )
    const result = verifyAuditWitness({
      trailPath: attacked,
      anchors: await store.list(NODE),
      publicKey: keys.publicKey,
      now: () => 2_500,
      staleAfterMs: 1_000_000,
    })
    expect(result.tampered).toBe(false)
    expect(result.issues).toContainEqual({
      kind: 'unwitnessed_tail',
      from: 9,
      to: 12,
      count: 4,
    })
    expect(formatWitnessVerification(result)).toContain(
      'unwitnessed_tail: seq 9..12 共 4 条尚未被任何锚点覆盖',
    )
  })

  test('D1: a compromised node key can add a new anchor but cannot repair old evidence', async () => {
    const attacked = join(directory, 'attacked-d1.ndjson')
    rewriteTrail(path, attacked, records =>
      records.filter(record => record.outcome !== 'refused'),
    )
    await publish(3_000, attacked)
    const anchors = await store.list(NODE)
    expect(anchors.map(witnessAnchorOf).map(anchor => anchor.seq)).toContain(11)
    const result = verifyAuditWitness({
      trailPath: attacked,
      anchors,
      publicKey: keys.publicKey,
      now: () => 3_100,
      staleAfterMs: 1_000_000,
    })
    expect(result.tampered).toBe(true)
    expect(result.issues.some(issue => issue.kind === 'head_mismatch')).toBe(
      true,
    )
  })

  test('E: reports stale when anchoring stops even though the local chain is unchanged', async () => {
    expect(readFileSync(path, 'utf8')).toBe(baseline)
    const result = verifyAuditWitness({
      trailPath: path,
      anchors: await store.list(NODE),
      publicKey: keys.publicKey,
      now: () => 122_001,
      staleAfterMs: 120_000,
    })
    expect(result.tampered).toBe(false)
    expect(result.stale).toBe(true)
    expect(result.issues).toContainEqual({
      kind: 'stale',
      ageMs: 120_001,
      thresholdMs: 120_000,
    })
    expect(formatWitnessVerification(result)).toContain(
      'stale: last anchor is 120001 ms old, over 120000 ms',
    )
    const witnessSide = checkWitnessStaleness({
      anchors: await store.list(NODE),
      publicKey: keys.publicKey,
      now: () => 122_001,
      staleAfterMs: 120_000,
    })
    expect(witnessSide.stale).toBe(true)
    expect(witnessSide.ageMs).toBe(120_001)
  })

  test('uses witness receipt time instead of a future node-declared anchor time', () => {
    const futureAnchor = signWitnessAnchor(
      {
        v: 1,
        node: NODE,
        seq: 1,
        head: 'f'.repeat(64),
        count: 1,
        at: Number.MAX_SAFE_INTEGER,
      },
      keys,
    )
    const result = checkWitnessStaleness({
      anchors: [{ anchor: futureAnchor, receivedAt: 1_000 }],
      publicKey: keys.publicKey,
      now: () => 121_001,
      staleAfterMs: 120_000,
    })
    expect(result).toMatchObject({ stale: true, ageMs: 120_001 })
  })

  test('does not let bare or bad-signature evidence extend freshness', () => {
    const anchor = signWitnessAnchor(
      {
        v: 1,
        node: NODE,
        seq: 1,
        head: 'e'.repeat(64),
        count: 1,
        at: Number.MAX_SAFE_INTEGER,
      },
      keys,
    )
    const badSignature = `${
      anchor.signature.startsWith('A') ? 'B' : 'A'
    }${anchor.signature.slice(1)}`
    const bare = checkWitnessStaleness({
      anchors: [anchor],
      publicKey: keys.publicKey,
      now: () => 121_001,
      staleAfterMs: 120_000,
    })
    expect(bare).toMatchObject({ stale: true, ageMs: null })

    const withBadReceipt = checkWitnessStaleness({
      anchors: [
        { anchor, receivedAt: 1_000 },
        { anchor: { ...anchor, signature: badSignature }, receivedAt: 121_001 },
      ],
      publicKey: keys.publicKey,
      now: () => 121_001,
      staleAfterMs: 120_000,
    })
    expect(withBadReceipt).toMatchObject({ stale: true, ageMs: 120_001 })
    expect(withBadReceipt.issues).toContainEqual({
      kind: 'bad_signature',
      seq: 1,
    })
  })

  test('a sender failure is fail-open and the next period still attempts an anchor', async () => {
    let now = 5_000
    let failures = 0
    const scheduler = new AuditWitnessScheduler({
      node: NODE,
      trailPath: path,
      keys,
      writer: {
        append: async () => {
          throw new Error('witness unavailable')
        },
      },
      now: () => now,
      onError: () => {
        failures += 1
      },
    })
    await expect(scheduler.tick()).resolves.toBeUndefined()
    await expect(scheduler.tick()).resolves.toBeUndefined()
    now += 60_000
    await expect(scheduler.tick()).resolves.toBeUndefined()
    expect(failures).toBe(2)
  })

  test('coalesces concurrent ticks into one in-flight anchor attempt', async () => {
    let release: (() => void) | undefined
    let appends = 0
    const scheduler = new AuditWitnessScheduler({
      node: NODE,
      trailPath: path,
      keys,
      writer: {
        append: async () => {
          appends += 1
          await new Promise<void>(resolve => {
            release = resolve
          })
        },
      },
      now: () => 10_000,
    })
    const first = scheduler.tick()
    const second = scheduler.tick()
    expect(appends).toBe(1)
    release?.()
    await Promise.all([first, second])
    expect(appends).toBe(1)
  })
})
