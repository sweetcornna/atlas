import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MAX_PENDING_TIMING_EVENTS,
  assertResidentRuntime,
  createResidentTimingWriter,
  parseResidentArgs,
} from '../resident.js'

const BASE = [
  '--node',
  'node-b',
  '--team',
  'atlas',
  '--agent',
  'reviewer=/workspace',
  '--port',
  '7321',
  '--hostname',
  '127.0.0.1',
] as const

describe('resident CLI configuration', () => {
  test('fails closed outside the Bun runtime', () => {
    expect(() => assertResidentRuntime(false)).toThrow(
      'requires the Bun runtime',
    )
    expect(() => assertResidentRuntime(true)).not.toThrow()
  })

  test('requires the Qianmo identity and preserves explicit exposure choices', () => {
    expect(parseResidentArgs(BASE, 'qianmo')).toEqual({
      node: 'node-b',
      team: 'atlas',
      agents: [{ agent: 'reviewer', cwd: '/workspace' }],
      port: 7321,
      hostname: '127.0.0.1',
      // Capability defaults: trust nobody but itself, and admit unsigned work
      // (P4.3 — `packages/capability/src/policy.ts` says why the M0 default is
      // permissive about *requiring* a token while still verifying every one
      // that is presented).
      trusted: [],
      requireSignedTasks: false,
    })
    expect(() => parseResidentArgs(BASE, 'occ')).toThrow('OCC_IDENTITY=qianmo')
  })

  test('never guesses a TCP hostname or listener', () => {
    expect(() =>
      parseResidentArgs(
        BASE.filter(arg => arg !== '--hostname' && arg !== '127.0.0.1'),
        'qianmo',
      ),
    ).toThrow('explicit --hostname')
    expect(() => parseResidentArgs(BASE.slice(0, 6), 'qianmo')).toThrow(
      'requires --port or --unix',
    )
  })

  test('requires absolute cwd and unique safe agent names', () => {
    expect(() =>
      parseResidentArgs(
        BASE.map(arg =>
          arg === 'reviewer=/workspace' ? 'reviewer=relative' : arg,
        ),
        'qianmo',
      ),
    ).toThrow('cwd must be absolute')
    expect(() =>
      parseResidentArgs([...BASE, '--agent', 'reviewer=/other'], 'qianmo'),
    ).toThrow('unique')
  })

  test('accepts explicit host activity and timing endpoints', () => {
    expect(
      parseResidentArgs(
        [...BASE, '--activity-url=ws://host.internal:7331'],
        'qianmo',
      ),
    ).toMatchObject({
      activityUrl: 'ws://host.internal:7331/',
      activityReconnectFactor: 1.1,
    })
    expect(
      parseResidentArgs(
        [
          ...BASE,
          '--activity-url=ws://host.internal:7331',
          '--activity-reconnect-factor=1.1',
          '--timings=/tmp/resident-timings.jsonl',
        ],
        'qianmo',
      ),
    ).toMatchObject({
      activityUrl: 'ws://host.internal:7331/',
      activityReconnectFactor: 1.1,
      timings: '/tmp/resident-timings.jsonl',
    })
    expect(() =>
      parseResidentArgs(
        [...BASE, '--activity-url=http://host.internal'],
        'qianmo',
      ),
    ).toThrow('must use ws or wss')
    expect(() =>
      parseResidentArgs([...BASE, '--timings=relative.jsonl'], 'qianmo'),
    ).toThrow('absolute path')
    expect(() =>
      parseResidentArgs([...BASE, '--activity-reconnect-factor=1.1'], 'qianmo'),
    ).toThrow('requires --activity-url')
    expect(() =>
      parseResidentArgs(
        [
          ...BASE,
          '--activity-url=ws://host.internal:7331',
          '--activity-reconnect-factor=1',
        ],
        'qianmo',
      ),
    ).toThrow('greater than 1')
  })

  test('accepts an absolute unix socket without TCP options', () => {
    expect(
      parseResidentArgs(
        [
          '--node=node-b',
          '--team=atlas',
          '--agent=reviewer=/workspace',
          '--unix=/tmp/qianmo-resident.sock',
        ],
        'qianmo',
      ),
    ).toMatchObject({ unix: '/tmp/qianmo-resident.sock' })
  })

  test('flushes timing evidence in order on close', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'resident-timing-writer-'))
    const path = join(directory, 'timings.jsonl')
    const errors: unknown[] = []
    const writer = createResidentTimingWriter(path, error => errors.push(error))
    try {
      writer.write({
        stage: 'acp_ready',
        at: 1,
        sessionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      })
      writer.write({
        stage: 'acp_ready',
        at: 2,
        sessionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      })

      await writer.close()

      expect(
        readFileSync(path, 'utf8')
          .trim()
          .split('\n')
          .map(line => JSON.parse(line).at),
      ).toEqual([1, 2])
      expect(errors).toEqual([])
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('bounds timing evidence queued in one turn and reports overflow once', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'resident-timing-overflow-'))
    const path = join(directory, 'timings.jsonl')
    const errors: unknown[] = []
    const writer = createResidentTimingWriter(path, error => errors.push(error))
    try {
      for (let at = 0; at < MAX_PENDING_TIMING_EVENTS + 10; at++) {
        writer.write({
          stage: 'acp_ready',
          at,
          sessionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
        })
      }

      await writer.close()

      expect(readFileSync(path, 'utf8').trim().split('\n')).toHaveLength(
        MAX_PENDING_TIMING_EVENTS,
      )
      expect(errors.map(String)).toEqual([
        'Error: resident timing writer queue overflow',
      ])
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

describe('capability flags (P4.3)', () => {
  const KEY = 'A'.repeat(43)

  test('--trust takes <node>=<publicKey> and refuses anything else', () => {
    const parsed = parseResidentArgs(
      [...BASE, '--trust', `node-a=${KEY}`],
      'qianmo',
    )
    expect(parsed.trusted).toEqual([['node-a', KEY]])
    expect(() =>
      parseResidentArgs([...BASE, '--trust', 'node-a'], 'qianmo'),
    ).toThrow('<node>=<publicKey>')
    expect(() =>
      parseResidentArgs([...BASE, '--trust', 'node-a=short'], 'qianmo'),
    ).toThrow('not a valid Ed25519 key')
  })

  test('--require-signed-tasks is off unless asked for', () => {
    expect(parseResidentArgs(BASE, 'qianmo').requireSignedTasks).toBe(false)
    expect(
      parseResidentArgs([...BASE, '--require-signed-tasks'], 'qianmo')
        .requireSignedTasks,
    ).toBe(true)
  })
})
