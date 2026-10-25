// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The hub's file store for Remote copies (P37.15, qmo-local.md §5.3): the
 * layout and its modes, no account name in a path, a copy read back after
 * a restart with each turn's last line at its first place, the limits, and
 * what revocation and the start-up prune leave.
 */

import { afterEach, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  CODE_ACCOUNT_MAX_COPIES,
  CODE_COPY_MAX_BYTES,
  type CodeCopyHeader,
  type CodeCopyRecord,
  codeOwnerKey,
} from '@qianmo/console'
import { openConsoleCodeCopies } from '../../src/commands/consoleCodeCopies.js'

const cleanup: (() => void)[] = []
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn()
})

const OWNER = 'u:0123456789abcdef'
const OTHER = 'u:fedcba9876543210'
const DEVICE = 'd-aaaaaaaaaaaa'
const DEVICE_2 = 'd-bbbbbbbbbbbb'
const SESSION = 'cs_AbCdEfGhIjKlMnOpQrSt_-'

function rooted() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p37-copies-'))
  cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}

const head = (
  id = SESSION,
  over: Partial<CodeCopyHeader> = {},
): CodeCopyHeader => ({
  id,
  title: '改一下 README',
  folder: 'atlas',
  agent: { id: 'claude-code', name: 'Claude Code' },
  mode: 'off',
  state: 'idle',
  remote: true,
  createdAt: 1,
  updatedAt: 2,
  lastSeq: 0,
  ...over,
})

const record = (seq: number, turn: string, text: string): CodeCopyRecord => ({
  seq,
  kind: 'turn',
  turn: {
    id: turn,
    sessionId: SESSION,
    author: 'agent',
    at: seq,
    text,
    state: 'done',
  },
})

/** A session id that is not {@link SESSION}, from a number. */
const sessionId = (n: number) => `cs_${n.toString().padStart(22, '0')}`

test('the layout: hashed account, device, session; folders 0700, files 0600', () => {
  const root = rooted()
  const store = openConsoleCodeCopies({ root })
  expect(store.saveHeader(OWNER, DEVICE, head())).toBe('ok')
  expect(
    store.append(OWNER, DEVICE, SESSION, [record(1, 't-1', 'one')]),
  ).toEqual({
    stored: 1,
  })
  const ownerKey = codeOwnerKey(OWNER)
  const dir = path.join(root, ownerKey, DEVICE, SESSION)
  expect(fs.readdirSync(dir).sort()).toEqual(['events.ndjson', 'session.json'])
  for (const folder of [
    path.join(root, ownerKey),
    path.join(root, ownerKey, DEVICE),
    dir,
  ])
    expect(fs.statSync(folder).mode & 0o777).toBe(0o700)
  for (const file of ['events.ndjson', 'session.json'])
    expect(fs.statSync(path.join(dir, file)).mode & 0o777).toBe(0o600)
  // No account name anywhere on disk.
  const walk = (at: string): string[] =>
    fs.statSync(at).isDirectory()
      ? fs.readdirSync(at).flatMap(name => [name, ...walk(path.join(at, name))])
      : [fs.readFileSync(at, 'utf8')]
  expect(walk(root).join('\n')).not.toContain(OWNER)
  expect(
    JSON.parse(fs.readFileSync(path.join(dir, 'events.ndjson'), 'utf8').trim()),
  ).toEqual(record(1, 't-1', 'one'))
})

test('a restart reads it back: each turn its last line at its first place', () => {
  const root = rooted()
  const store = openConsoleCodeCopies({ root })
  store.saveHeader(OWNER, DEVICE, head())
  store.append(OWNER, DEVICE, SESSION, [
    record(1, 't-1', 'one'),
    record(2, 't-2', 'two, running'),
  ])
  store.append(OWNER, DEVICE, SESSION, [
    record(3, 't-3', 'three'),
    record(4, 't-2', 'two, done'),
  ])
  const again = openConsoleCodeCopies({ root })
  expect(again.get(OWNER, DEVICE, SESSION)).toMatchObject({
    device: DEVICE,
    stored: 4,
    full: false,
    header: head(),
  })
  const page = again.read(OWNER, DEVICE, SESSION, undefined, 100)
  expect(page?.records.map(one => [one.seq, one.turn.text])).toEqual([
    [1, 'one'],
    [4, 'two, done'],
    [3, 'three'],
  ])
  expect(page?.lastSeq).toBe(4)
  // Older than the second turn's place: the first only.
  expect(
    again.read(OWNER, DEVICE, SESSION, 2, 100)?.records.map(one => one.seq),
  ).toEqual([1])
  expect(again.read(OWNER, DEVICE, SESSION, undefined, 1)).toMatchObject({
    more: true,
  })
  // Another account sees nothing, by the same ids.
  expect(again.list(OTHER)).toEqual([])
  expect(again.read(OTHER, DEVICE, SESSION, undefined, 100)).toBeUndefined()
  expect(again.append(OTHER, DEVICE, SESSION, [record(5, 't-5', 'x')])).toBe(
    'missing',
  )
})

test('the limits: 100 copies an account, 16 MiB a copy; full is kept across a restart', () => {
  const root = rooted()
  const store = openConsoleCodeCopies({ root })
  for (let n = 0; n < CODE_ACCOUNT_MAX_COPIES; n += 1)
    expect(store.saveHeader(OWNER, DEVICE, head(sessionId(n)))).toBe('ok')
  expect(store.saveHeader(OWNER, DEVICE, head(SESSION))).toBe('full')
  // A head the account already has is replaced, not counted again.
  expect(
    store.saveHeader(OWNER, DEVICE, head(sessionId(0), { title: 'renamed' })),
  ).toBe('ok')
  // Another account has its own room.
  expect(store.saveHeader(OTHER, DEVICE, head(SESSION))).toBe('ok')

  const big = 'x'.repeat(250 * 1024)
  let seq = 0
  let answer: ReturnType<typeof store.append> = { stored: 0 }
  while (typeof answer === 'object') {
    seq += 1
    answer = store.append(OTHER, DEVICE, SESSION, [
      record(seq, `t-${seq}`, big),
    ])
  }
  expect(answer).toBe('full')
  const copy = store.get(OTHER, DEVICE, SESSION)!
  expect(copy.full).toBe(true)
  expect(copy.bytes).toBeLessThanOrEqual(CODE_COPY_MAX_BYTES)
  expect(copy.stored).toBe(seq - 1)
  // Nothing of the refused batch was written.
  const file = path.join(
    root,
    codeOwnerKey(OTHER),
    DEVICE,
    SESSION,
    'events.ndjson',
  )
  expect(fs.statSync(file).size).toBe(copy.bytes)
  expect(
    openConsoleCodeCopies({ root }).get(OTHER, DEVICE, SESSION)?.full,
  ).toBe(true)
}, 30_000)

test('remove, a device, an account; the start-up prune against the ledger', () => {
  const root = rooted()
  const store = openConsoleCodeCopies({ root })
  store.saveHeader(OWNER, DEVICE, head())
  store.saveHeader(OWNER, DEVICE, head(sessionId(1)))
  store.saveHeader(OWNER, DEVICE_2, head())
  store.saveHeader(OTHER, DEVICE_2, head())

  expect(store.remove(OWNER, DEVICE, sessionId(1))).toBe(true)
  expect(store.remove(OWNER, DEVICE, sessionId(1))).toBe(false)
  expect(
    fs.existsSync(path.join(root, codeOwnerKey(OWNER), DEVICE, sessionId(1))),
  ).toBe(false)

  store.removeDevice(OWNER, DEVICE)
  expect(store.list(OWNER).map(copy => copy.device)).toEqual([DEVICE_2])
  expect(fs.existsSync(path.join(root, codeOwnerKey(OWNER), DEVICE))).toBe(
    false,
  )

  store.removeOwner(OWNER)
  expect(store.list(OWNER)).toEqual([])
  expect(fs.existsSync(path.join(root, codeOwnerKey(OWNER)))).toBe(false)
  expect(store.list(OTHER)).toHaveLength(1)

  store.saveHeader(OWNER, DEVICE, head())
  const keep = `${codeOwnerKey(OWNER)}/${DEVICE}`
  expect(
    store.prune((ownerKey, device) => `${ownerKey}/${device}` === keep),
  ).toBe(1)
  expect(store.list(OTHER)).toEqual([])
  expect(store.list(OWNER)).toHaveLength(1)
})

test('a path segment that is not an id is refused before any file is touched', () => {
  const root = rooted()
  const store = openConsoleCodeCopies({ root })
  expect(() => store.saveHeader(OWNER, '../../etc', head())).toThrow()
  expect(fs.readdirSync(root)).toEqual([])
  // A folder that is not an id is left alone by the prune.
  fs.mkdirSync(path.join(root, 'not-an-owner'))
  expect(store.prune(() => false)).toBe(0)
  expect(fs.existsSync(path.join(root, 'not-an-owner'))).toBe(true)
})
