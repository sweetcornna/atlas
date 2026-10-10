// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `providers.ndjson`（P18.6，`providers-console-m1.md` §2.4、§3.7）：账头、重放、
 * 严格读与语义折叠。账本面用 `MemoryActionStore`（与动作账本同一个桩），零
 * `mock.module`。
 *
 * 钉的是「`providers.ndjson` 有坏行时拒绝服务」在账本这一层的几种坏法：哈希链对得
 * 上但形状不对、种类未知、多一个字段、首行不是账头、语义上接不上前文（修订号跳号、
 * 删除仍被指派的档案、提交回报对不上任何一次下发）、运行中被追加。端口一层的同一条
 * 在 `consoleProviders.test.ts`。
 */

import { describe, expect, test } from 'bun:test'
import {
  encodeLedgerEntry,
  type LedgerData,
  nextPrevious,
  readLedger,
} from '@qianmo/console'
import { MemoryActionStore } from '../../../console/test/actionStore.js'
import {
  type BookEvent,
  ProviderBook,
} from '../../src/commands/consoleProvidersBook.js'

const FP = `fp1:${'a1'.repeat(16)}`
const HASH = `sha256:${'b2'.repeat(32)}`

function body(id: string, revision: number, fingerprint?: string): string {
  return JSON.stringify({
    id,
    revision,
    name: id,
    presetId: null,
    plan: 'custom',
    site: null,
    lane: 'openai-responses',
    baseUrl: 'https://gateway.vendor.example/v1',
    auth: { scheme: 'bearer' },
    keys: [
      fingerprint === undefined
        ? { id: 'k1' }
        : { id: 'k1', fingerprint, setAt: '2026-10-01T00:00:00.000Z' },
    ],
    models: [
      {
        id: 'vendor-model',
        role: 'main',
        tiers: ['opus', 'sonnet', 'fable'],
        capabilities: { mode: 'family' },
        effort: { send: 'auto' },
      },
    ],
    evaluated: false,
  })
}

function open(store = new MemoryActionStore()) {
  const alarms: string[] = []
  const book = new ProviderBook({ store, onAlarm: line => alarms.push(line) })
  return { store, book, alarms }
}

/** Append a line with a correct hash chain, as a hand edit with tools would. */
function forge(store: MemoryActionStore, kind: string, data: LedgerData): void {
  const read = readLedger(store.text ?? '')
  if (!read.ok) throw new Error('fixture: the book must read before forging')
  const entry = {
    seq: read.entries.length + 1,
    at: Date.now(),
    kind,
    data,
    prev: nextPrevious(read.entries),
  }
  store.append(encodeLedgerEntry(entry))
}

const SEED: readonly BookEvent[] = [
  { kind: 'profile.saved', id: 'luna', revision: 1, body: body('luna', 1) },
  { kind: 'profile.saved', id: 'luna', revision: 2, body: body('luna', 2, FP) },
  { kind: 'secret.set', profileId: 'luna', keyId: 'k1', fp: FP },
  { kind: 'default.set', profileId: 'luna' },
  { kind: 'scope.assigned', node: 'beta-4', mode: 'unmanaged' },
  { kind: 'context.set', node: 'beta-1', tokens: 300_000 },
  {
    kind: 'apply.result',
    node: 'beta-1',
    requestId: 'req-00000001',
    profileId: 'luna',
    revision: 2,
    outcome: 'ok',
    pending: false,
    force: false,
    sessions: 'keep',
    lane: 'openai-responses',
    host: 'gateway.vendor.example',
    context: 300_000,
  },
  {
    kind: 'apply.committed',
    node: 'beta-1',
    requestId: 'req-00000001',
    appliedHash: HASH,
  },
  {
    kind: 'probe.result',
    node: 'beta-1',
    requestId: 'req-00000002',
    profileId: 'luna',
    mode: 'auth',
    ok: true,
    reachable: true,
  },
]

function seeded() {
  const opened = open()
  for (const event of SEED) {
    expect([event.kind, opened.book.record(event)]).toEqual([event.kind, true])
  }
  return opened
}

describe('the providers book', () => {
  test('a new book starts with its header line and reads back', () => {
    const { store, book } = open()
    expect(book.problem).toBeNull()
    const lines = store.rawLines()
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({
      seq: 1,
      kind: 'ledger.header',
      data: { ledger: 'providers', version: 1 },
    })
    expect(open(store).book.problem).toBeNull()
  })

  test('a replay folds to the same state the writes left', () => {
    const { store, book } = seeded()
    const again = open(new MemoryActionStore(store.text)).book
    for (const view of [book, again]) {
      expect(view.problem).toBeNull()
      expect(view.profile('luna')?.revision).toBe(2)
      expect(view.profile('luna')?.keys[0]?.fingerprint).toBe(FP)
      expect(view.lastRevision('luna')).toBe(2)
      expect(view.defaultProfileId).toBe('luna')
      expect(view.assignment('beta-4')).toEqual({ mode: 'unmanaged' })
      expect(view.assignment('beta-1')).toEqual({ mode: 'inherit' })
      expect(view.contextOverride('beta-1')).toBe(300_000)
      expect(view.committed('beta-1')).toEqual({
        requestId: 'req-00000001',
        appliedHash: HASH,
      })
      expect(view.sent('req-00000001')?.context).toBe(300_000)
      expect(view.activity('beta-1').map(item => item.kind)).toEqual([
        'probe',
        'apply',
      ])
      expect(view.isReferenced('luna')).toBe(true)
    }
    expect(again.revision).toBe(book.revision)
  })

  test('the book holds ids, fingerprints and hashes, never a key', () => {
    const { store } = seeded()
    const text = store.text ?? ''
    expect(text).toContain(FP)
    expect(text).not.toMatch(/sk-[A-Za-z0-9]/)
    expect(text).not.toContain('"value"')
  })
})

describe('a write that cannot follow is refused and nothing is written', () => {
  const cases: [string, BookEvent, string][] = [
    [
      'a skipped revision',
      { kind: 'profile.saved', id: 'luna', revision: 4, body: body('luna', 4) },
      '修订号应为 3',
    ],
    [
      'deleting the default',
      { kind: 'profile.deleted', id: 'luna', revision: 2 },
      '仍被指派',
    ],
    [
      'a commit for a request never sent',
      {
        kind: 'apply.committed',
        node: 'beta-1',
        requestId: 'req-99999999',
        appliedHash: HASH,
      },
      '对不上',
    ],
    [
      'a fingerprint the profile does not hold',
      {
        kind: 'secret.set',
        profileId: 'luna',
        keyId: 'k1',
        fp: `fp1:${'c3'.repeat(16)}`,
      },
      '指纹与档案不符',
    ],
    [
      'clearing a key the profile still holds',
      { kind: 'secret.cleared', profileId: 'luna', keyId: 'k1' },
      '指纹与档案不符',
    ],
    [
      'assigning a profile that does not exist',
      {
        kind: 'scope.assigned',
        node: 'beta-1',
        mode: 'profile',
        profileId: 'ghost',
      },
      '不存在',
    ],
  ]
  for (const [name, event, reason] of cases) {
    test(name, () => {
      const { store, book, alarms } = seeded()
      const before = store.text
      expect(book.record(event)).toBe(false)
      expect(store.text).toBe(before)
      expect(alarms.join('\n')).toContain(reason)
      // A refused write is a caller bug, not a broken book.
      expect(book.problem).toBeNull()
      expect(book.record({ kind: 'context.cleared', node: 'beta-1' })).toBe(
        true,
      )
    })
  }
})

describe('a bad book closes the face (strict read)', () => {
  const forged: [string, string, LedgerData, string][] = [
    ['an unknown kind', 'profile.renamed', { id: 'luna' }, '形状不对'],
    [
      'an extra field',
      'context.set',
      { node: 'beta-1', tokens: 300_000, note: 'hand edit' },
      '形状不对',
    ],
    [
      'a node name outside the protocol',
      'context.cleared',
      { node: 'Beta_1' },
      '形状不对',
    ],
    [
      'a semantic jump the writer would have refused',
      'profile.saved',
      { id: 'luna', revision: 9, body: body('luna', 9) },
      '修订号应为 3',
    ],
    [
      'a body that does not parse as a profile',
      'profile.saved',
      { id: 'luna', revision: 3, body: '{"id":"luna","revision":3}' },
      '档案正文不合法',
    ],
  ]
  for (const [name, kind, data, reason] of forged) {
    test(`${name}, chain intact, still closes it`, () => {
      const { store } = seeded()
      forge(store, kind, data)
      const reopened = open(store)
      expect(reopened.book.problem).toContain(`第 ${SEED.length + 2} 行`)
      expect(reopened.book.problem).toContain(reason)
      expect(reopened.alarms.join('\n')).toContain('模型服务已停用')
      expect(
        reopened.book.record({ kind: 'context.cleared', node: 'beta-1' }),
      ).toBe(false)
      // Nothing is served from a half-read book.
      expect(reopened.book.profiles()).toEqual([])
    })
  }

  test('a first line that is not the header', () => {
    // A well-formed chain whose header names another ledger.
    const replaced = new MemoryActionStore()
    replaced.append(
      encodeLedgerEntry({
        seq: 1,
        at: 1,
        kind: 'ledger.header',
        data: { ledger: 'actions', version: 1 },
        prev: nextPrevious([]),
      }),
    )
    expect(open(replaced).book.problem).toContain('首行不是模型服务账本的账头')
  })

  test('a truncated last line', () => {
    const { store } = seeded()
    const text = store.text ?? ''
    const cut = new MemoryActionStore(text.slice(0, text.length - 20))
    expect(open(cut).book.problem).not.toBeNull()
  })

  test('a line appended by someone else while running stops the writes', () => {
    const { store, book, alarms } = seeded()
    forge(store, 'context.cleared', { node: 'beta-1' })
    expect(
      book.record({ kind: 'context.set', node: 'beta-1', tokens: 250_000 }),
    ).toBe(false)
    expect(book.problem).toContain('被改动')
    expect(alarms.join('\n')).toContain('模型服务已停用')
  })

  test('a touch that changes no byte does not', () => {
    const { store, book } = seeded()
    store.touch()
    expect(
      book.record({ kind: 'context.set', node: 'beta-1', tokens: 250_000 }),
    ).toBe(true)
    expect(book.problem).toBeNull()
  })
})

test('legacy stored compat replays into native fields; malformed old headers still fail closed', () => {
  const valid = JSON.parse(body('legacy', 1))
  valid.lane = 'anthropic'
  valid.compat = {
    CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1',
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: '4096',
    ANTHROPIC_CUSTOM_HEADERS: 'anthropic-workspace-id: workspace-1',
  }
  const { book, store } = open()
  expect(
    book.record({
      kind: 'profile.saved',
      id: 'legacy',
      revision: 1,
      body: JSON.stringify(valid),
    }),
  ).toBe(true)
  expect(
    open(new MemoryActionStore(store.text)).book.profile('legacy')?.compat,
  ).toEqual({
    disableStrictTools: 'true',
    maxTokens: '4096',
    'headers.anthropic-workspace-id': 'workspace-1',
  })
  const invalid = open()
  valid.compat.ANTHROPIC_CUSTOM_HEADERS = 'Authorization: injected'
  forge(invalid.store, 'profile.saved', {
    id: 'legacy',
    revision: 1,
    body: JSON.stringify(valid),
  })
  expect(open(invalid.store).book.problem).not.toBeNull()
})
