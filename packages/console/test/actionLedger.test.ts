// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * P15.9 — the hash-chained action ledger behind `ActionLedgerPort`
 * (`tenancy-m1.md` §6).
 *
 * Three things are judged here: the ledger answers `list` the way the port
 * says (the same scenario the in-memory one is held to in `actions.test.ts`),
 * it refuses rather than skips — at startup, and when the file is changed
 * under a running console — and it never writes anything but the six fields
 * of an action. The DoD rows that are about the console's calls (one opening
 * and a hundred polls; break-glass) are run here with this ledger behind a
 * real console handler.
 */

import { describe, expect, test } from 'bun:test'
import {
  ActionLedger,
  verifyActionLedger,
  type ActionLedgerOptions,
} from '../src/actionLedger.js'
import type { ConsoleAction } from '../src/deps.js'
import { encodeLedgerEntry, ledgerDigest, readLedger } from '../src/ledger.js'
import {
  ADMIN as ACCOUNTS_ADMIN,
  accountsHarness,
  asBearer,
  asSession,
  person,
} from './accountsHarness.js'
import { MemoryActionStore } from './actionStore.js'
import { MemoryActionLedger } from './memoryActions.js'
import { ADMIN, NOW, browse, call, pageHarness } from './pageHarness.js'

const SUBJECT_A = 'u:00000000000000aa'

function action(over: Partial<ConsoleAction> = {}): ConsoleAction {
  return {
    at: NOW,
    requestId: 'r-1',
    subject: 'legacy:admin',
    action: 'agent.heartbeat',
    target: 'qianmo://tokyo-1/planner',
    outcome: 'ok',
    ...over,
  }
}

function open(
  store = new MemoryActionStore(),
  options: Partial<ActionLedgerOptions> = {},
) {
  const alarms: string[] = []
  const ledger = new ActionLedger({
    store,
    now: () => NOW,
    onAlarm: line => {
      alarms.push(line)
    },
    ...options,
  })
  return { ledger, store, alarms }
}

/** A ledger with five actions in it, the `actions.test.ts` scenario. */
async function five(store = new MemoryActionStore()) {
  const opened = open(store)
  for (let i = 1; i <= 5; i++) {
    const recorded = await opened.ledger.record(
      action({
        at: NOW + i,
        requestId: `r-${i}`,
        subject: i % 2 === 0 ? SUBJECT_A : 'legacy:admin',
        action: i <= 3 ? 'chat.transcript.open' : 'agent.heartbeat',
        target: `t-${i}`,
      }),
    )
    expect(recorded.ok).toBe(true)
  }
  return opened
}

/** Rewrite line `index` (0-based) with `edit`, keeping the chain intact after it. */
function forge(
  store: MemoryActionStore,
  index: number,
  edit: (line: Record<string, unknown>) => void,
): void {
  const read = readLedger(store.text ?? '')
  if (!read.ok) throw new Error('forge needs an intact ledger')
  let previous = read.entries[0]?.prev ?? ''
  const out: string[] = []
  for (const [i, entry] of read.entries.entries()) {
    const raw = { ...entry, data: { ...entry.data }, prev: previous }
    if (i === index) edit(raw as unknown as Record<string, unknown>)
    out.push(encodeLedgerEntry(raw))
    previous = ledgerDigest(raw)
  }
  store.text = out.join('')
}

describe('what lands on disk', () => {
  test('a header first, then one chained line per action with six fields at most', async () => {
    const { store } = await five()
    const lines = store.lines()
    expect(lines).toHaveLength(6)
    expect(lines[0]).toMatchObject({
      kind: 'ledger.header',
      data: { ledger: 'actions', version: 1 },
    })
    for (const line of lines.slice(1)) {
      expect(
        Object.keys(line.data).every(key =>
          [
            'requestId',
            'subject',
            'target',
            'outcome',
            'code',
            'breakGlass',
          ].includes(key),
        ),
      ).toBe(true)
    }
    expect(lines[1]).toMatchObject({
      kind: 'chat.transcript.open',
      data: {
        requestId: 'r-1',
        subject: 'legacy:admin',
        target: 't-1',
        outcome: 'ok',
      },
    })
    expect(verifyActionLedger(store.text)).toEqual({
      chain: 'intact',
      actions: 5,
    })
  })

  test('a failed action keeps its code; break-glass is marked', async () => {
    const { ledger, store } = open()
    await ledger.record(
      action({ outcome: 'failed', code: 'not_found', breakGlass: true }),
    )
    expect(store.lines()[1]?.data).toEqual({
      requestId: 'r-1',
      subject: 'legacy:admin',
      target: 'qianmo://tokyo-1/planner',
      outcome: 'failed',
      code: 'not_found',
      breakGlass: true,
    })
  })

  test('opening twice resumes the chain instead of starting another', async () => {
    const { store } = await five()
    const again = open(store)
    expect(again.ledger.problem).toBeNull()
    await again.ledger.record(action({ requestId: 'r-6' }))
    expect(verifyActionLedger(store.text)).toEqual({
      chain: 'intact',
      actions: 6,
    })
    expect(store.lines().filter(l => l.kind === 'ledger.header')).toHaveLength(
      1,
    )
  })
})

describe('no secret reaches the file', () => {
  const PERSONAL = `qmu_${'A'.repeat(43)}`
  const INVITE = `qmi_${'b'.repeat(43)}`
  const SESSION = `qms_${'c'.repeat(43)}`

  test('known tokens and minted secrets in a target are replaced', async () => {
    const { ledger, store } = open(new MemoryActionStore(), {
      secrets: [ADMIN, 'short'],
    })
    await ledger.record(
      action({
        action: 'breakglass.request',
        target: `GET /v0/${ADMIN}/${PERSONAL}/${INVITE}/${SESSION}/short`,
      }),
    )
    const text = store.text ?? ''
    for (const secret of [ADMIN, PERSONAL, INVITE, SESSION]) {
      expect(text.includes(secret)).toBe(false)
    }
    expect(store.lines()[1]?.data['target']).toBe(
      'GET /v0/***/***/***/***/short',
    )
  })

  test('an agent named like a prefix is left alone', async () => {
    const { ledger, store } = open()
    await ledger.record(action({ target: 'qianmo://tokyo-1/qms_planner' }))
    expect(store.lines()[1]?.data['target']).toBe(
      'qianmo://tokyo-1/qms_planner',
    )
  })

  test('control characters are replaced and a long target is cut, not refused', async () => {
    const { ledger, store } = open()
    await ledger.record(action({ target: 'a\nb\u0000c' }))
    await ledger.record(action({ target: 'x'.repeat(2_000) }))
    await ledger.record(action({ target: '' }))
    const targets = store.lines().map(line => line.data['target'])
    expect(targets[1]).toBe('a\uFFFDb\uFFFDc')
    expect(String(targets[2]).length).toBe(512)
    expect(String(targets[2]).endsWith('…')).toBe(true)
    expect(targets[3]).toBe('-')
    expect(verifyActionLedger(store.text).chain).toBe('intact')
  })

  test("a caller's malformed entry is refused alone, loudly, and the ledger stays open", async () => {
    const { ledger, store, alarms } = open()
    for (const bad of [
      action({ action: 'Not A Verb' }),
      action({ action: 'ledger.header' }),
      action({ subject: 'root' }),
      action({ requestId: 'has space' }),
    ]) {
      const result = await ledger.record(bad)
      expect(result.ok).toBe(false)
    }
    expect(store.lines()).toHaveLength(1)
    expect(alarms).toHaveLength(4)
    expect(ledger.problem).toBeNull()
    expect((await ledger.admit()).ok).toBe(true)
  })
})

describe('list answers the way the port says', () => {
  // The same scenario, run against both: what the in-memory ledger promised
  // P18.4 is what this one delivers.
  for (const [name, make] of [
    ['memory', async () => ({ ledger: await fiveInMemory() })],
    ['hash-chained', five],
  ] as const) {
    test(`newest first, filtered, paged by sequence (${name})`, async () => {
      const { ledger } = await make()
      const first = await ledger.list({ limit: 2 })
      expect(first.ok && first.value.entries.map(e => e.seq)).toEqual([5, 4])
      expect(first.ok && first.value.nextBeforeSeq).toBe(4)
      const second = await ledger.list({ limit: 2, beforeSeq: 4 })
      expect(second.ok && second.value.entries.map(e => e.seq)).toEqual([3, 2])
      const mine = await ledger.list({
        targets: ['t-1', 't-3', 't-5'],
        actionPrefix: 'chat.transcript.',
      })
      expect(mine.ok && mine.value.entries.map(e => e.target)).toEqual([
        't-3',
        't-1',
      ])
      expect(mine.ok && mine.value.nextBeforeSeq).toBeNull()
      const theirs = await ledger.list({ subject: SUBJECT_A })
      expect(theirs.ok && theirs.value.entries.map(e => e.seq)).toEqual([4, 2])
      const none = await ledger.list({ targets: [] })
      expect(none.ok && none.value.entries).toEqual([])
    })
  }

  test('the record comes back as it went in, numbered from 1', async () => {
    const { ledger } = await five()
    const page = await ledger.list({ limit: 1, beforeSeq: 2 })
    expect(page.ok && page.value.entries).toEqual([
      {
        seq: 1,
        at: NOW + 1,
        requestId: 'r-1',
        subject: 'legacy:admin',
        action: 'chat.transcript.open',
        target: 't-1',
        outcome: 'ok',
      },
    ])
  })

  test('a page is at most 500, and a nonsense limit is the default', async () => {
    const { ledger } = open()
    for (let i = 0; i < 520; i++) {
      await ledger.record(action({ requestId: `r-${i}` }))
    }
    const big = await ledger.list({ limit: 10_000 })
    expect(big.ok && big.value.entries).toHaveLength(500)
    const nan = await ledger.list({ limit: Number.NaN })
    expect(nan.ok && nan.value.entries).toHaveLength(50)
  })
})

async function fiveInMemory(): Promise<MemoryActionLedger> {
  const ledger = new MemoryActionLedger()
  for (let i = 1; i <= 5; i++) {
    await ledger.record(
      action({
        at: NOW + i,
        requestId: `r-${i}`,
        subject: i % 2 === 0 ? SUBJECT_A : 'legacy:admin',
        action: i <= 3 ? 'chat.transcript.open' : 'agent.heartbeat',
        target: `t-${i}`,
      }),
    )
  }
  return ledger
}

/** Everything a closed ledger must do: refuse all three, write nothing. */
async function expectClosed(
  ledger: ActionLedger,
  store: MemoryActionStore,
  alarms: readonly string[],
): Promise<void> {
  const before = store.text
  expect(ledger.problem).not.toBeNull()
  expect(alarms.length).toBeGreaterThan(0)
  expect((await ledger.admit()).ok).toBe(false)
  expect((await ledger.list({})).ok).toBe(false)
  expect((await ledger.record(action({ requestId: 'late' }))).ok).toBe(false)
  expect(store.text).toBe(before)
}

describe('a ledger it cannot trust is closed at startup', () => {
  const cases: [string, (store: MemoryActionStore) => void, string][] = [
    [
      'a byte changed in the middle',
      store => {
        store.text = (store.text ?? '').replace('"t-2"', '"t-9"')
      },
      '第 4 行：哈希链断开',
    ],
    [
      'a line deleted',
      store => {
        const lines = store.rawLines()
        lines.splice(2, 1)
        store.text = `${lines.join('\n')}\n`
      },
      'seq 不连续',
    ],
    [
      'two lines swapped',
      store => {
        const lines = store.rawLines()
        const [a, b] = [lines[2], lines[3]]
        if (a === undefined || b === undefined) throw new Error('short')
        lines[2] = b
        lines[3] = a
        store.text = `${lines.join('\n')}\n`
      },
      'seq 不连续',
    ],
    [
      'a torn last line',
      store => {
        store.text = (store.text ?? '').slice(0, -5)
      },
      '末行不完整',
    ],
    [
      'a line that is not JSON',
      store => {
        const lines = store.rawLines()
        lines[3] = '{oops'
        store.text = `${lines.join('\n')}\n`
      },
      '第 4 行：不是 JSON',
    ],
    [
      'an extra field, chain recomputed',
      store => {
        forge(store, 2, line => {
          ;(line['data'] as Record<string, unknown>)['prompt'] = 'hello'
        })
      },
      '第 3 行：多出字段 prompt',
    ],
    [
      'a broken subject, chain recomputed',
      store => {
        forge(store, 2, line => {
          ;(line['data'] as Record<string, unknown>)['subject'] = 'root'
        })
      },
      '第 3 行：主体不对',
    ],
    [
      'an outcome it does not know, chain recomputed',
      store => {
        forge(store, 1, line => {
          ;(line['data'] as Record<string, unknown>)['outcome'] = 'maybe'
        })
      },
      '第 2 行：结果不对',
    ],
    [
      'the account book pointed at by mistake',
      store => {
        forge(store, 0, line => {
          ;(line['data'] as Record<string, unknown>)['ledger'] = 'accounts'
        })
      },
      '第 1 行：账名不对',
    ],
    [
      'a version it does not know',
      store => {
        forge(store, 0, line => {
          ;(line['data'] as Record<string, unknown>)['version'] = 2
        })
      },
      '第 1 行：版本不是 1',
    ],
    [
      'no header at all',
      store => {
        forge(store, 0, line => {
          line['kind'] = 'agent.heartbeat'
        })
      },
      '第 1 行：首行不是账头',
    ],
  ]

  for (const [name, damage, reason] of cases) {
    test(name, async () => {
      const { store } = await five()
      damage(store)
      expect(verifyActionLedger(store.text).chain).toBe('broken')
      const { ledger, alarms } = open(store)
      expect(ledger.problem).toContain(reason)
      expect(alarms[0]).toContain(reason)
      await expectClosed(ledger, store, alarms)
    })
  }

  test('a file that cannot be read', async () => {
    const store = new MemoryActionStore()
    store.read = () => {
      throw new Error('EACCES')
    }
    const { ledger, alarms } = open(store)
    expect(ledger.problem).toContain('读不出来（EACCES）')
    await expectClosed(ledger, store, alarms)
  })
})

describe('a ledger changed under a running console is closed', () => {
  test('an edit in the middle: the next write is refused before it happens', async () => {
    const { ledger, store, alarms } = await five()
    store.text = (store.text ?? '').replace('"t-2"', '"t-9"')
    expect((await ledger.admit()).ok).toBe(false)
    expect(ledger.problem).toContain('哈希链断开')
    await expectClosed(ledger, store, alarms)
  })

  test('a read is refused too, and a reading is not appended after the edit', async () => {
    const { ledger, store, alarms } = await five()
    store.text = (store.text ?? '').replace('"r-3"', '"r-7"')
    const record = await ledger.record(
      action({ action: 'chat.transcript.open', target: 't-1' }),
    )
    expect(record.ok).toBe(false)
    await expectClosed(ledger, store, alarms)
  })

  test('lines appended by somebody else, chain and all', async () => {
    const { ledger, store, alarms } = await five()
    const other = open(new MemoryActionStore(store.text))
    await other.ledger.record(action({ requestId: 'r-intruder' }))
    store.text = other.store.text
    const listed = await ledger.list({})
    expect(listed.ok).toBe(false)
    expect(ledger.problem).toContain('链尾与本进程写下的不一致')
    await expectClosed(ledger, store, alarms)
  })

  test('a file deleted or emptied', async () => {
    const { ledger, store, alarms } = await five()
    store.text = null
    expect((await ledger.admit()).ok).toBe(false)
    await expectClosed(ledger, store, alarms)
  })

  test('touched but unchanged: still open, and checked by content once', async () => {
    const { ledger, store } = await five()
    store.touch()
    const reads = store.reads
    expect((await ledger.admit()).ok).toBe(true)
    expect(store.reads).toBe(reads + 1)
    // The stamp is taken again; the next admit is the cheap one.
    expect((await ledger.admit()).ok).toBe(true)
    expect(store.reads).toBe(reads + 1)
  })

  test('a write that fails closes the ledger, the way a full disk would', async () => {
    const { ledger, store, alarms } = await five()
    store.failAppends = true
    const result = await ledger.record(action({ requestId: 'r-6' }))
    expect(result.ok).toBe(false)
    expect(ledger.problem).toContain('写不进去（no space left on device）')
    store.failAppends = false
    await expectClosed(ledger, store, alarms)
  })

  test('a closed ledger repeats its alarm at most once a minute', async () => {
    let now = NOW
    const store = new MemoryActionStore()
    const alarms: string[] = []
    const ledger = new ActionLedger({
      store,
      now: () => now,
      onAlarm: line => {
        alarms.push(line)
      },
    })
    store.text = 'garbage\n'
    await ledger.admit()
    expect(alarms).toHaveLength(1)
    await ledger.admit()
    await ledger.list({})
    expect(alarms).toHaveLength(1)
    now += 60_000
    await ledger.admit()
    expect(alarms).toHaveLength(2)
  })
})

describe('verifyActionLedger: the four states', () => {
  test('absent, empty, intact, broken', async () => {
    expect(verifyActionLedger(null)).toEqual({ chain: 'absent', actions: 0 })
    expect(verifyActionLedger('')).toEqual({ chain: 'empty', actions: 0 })
    const fresh = open()
    expect(verifyActionLedger(fresh.store.text)).toEqual({
      chain: 'empty',
      actions: 0,
    })
    const { store } = await five()
    expect(verifyActionLedger(store.text)).toEqual({
      chain: 'intact',
      actions: 5,
    })
    store.text = (store.text ?? '').replace('"ok"', '"refused"')
    expect(verifyActionLedger(store.text)).toEqual({
      chain: 'broken',
      actions: 0,
      issue: { line: 3, reason: '哈希链断开' },
    })
  })
})

// --- the console's calls, with this ledger behind them ------------------------

describe('the console writing into it', () => {
  test('one opening, a hundred polls and a stream are one reading', async () => {
    const store = new MemoryActionStore()
    const { ledger } = open(store)
    const h = pageHarness({ chat: true, actions: ledger })
    const opened = await h.handle(
      call('POST', '/v0/chat/sessions', ADMIN, {
        target: 'qianmo://tokyo-1/planner',
      }),
    )
    const { id } = (await opened.json()) as { id: string }

    const stream = await h.handle(call('GET', '/v0/chat/stream', ADMIN))
    expect(stream.status).toBe(200)
    const reader = stream.body?.getReader()
    if (reader === undefined) throw new Error('no stream body')
    await reader.read()

    expect((await h.handle(browse(`/chat?session=${id}`, ADMIN))).status).toBe(
      200,
    )
    for (let i = 0; i < 100; i++) {
      h.chat.emit(id)
      await reader.read()
      const poll = await h.handle(
        call('GET', `/fragments/chat/thread/${id}`, ADMIN),
      )
      expect(poll.status).toBe(200)
      await h.handle(call('GET', '/fragments/chat/sessions', ADMIN))
    }
    await reader.cancel()

    const readings = await ledger.list({ actionPrefix: 'chat.transcript.' })
    expect(readings.ok && readings.value.entries.map(e => e.target)).toEqual([
      id,
    ])
    // Two lines after the header: the session opened, the one reading.
    expect(store.lines().map(line => line.kind)).toEqual([
      'ledger.header',
      'chat.session.open',
      'chat.transcript.open',
    ])
    expect(verifyActionLedger(store.text).chain).toBe('intact')
  })

  test('break-glass: every request is a line, reads included', async () => {
    const store = new MemoryActionStore()
    const { ledger } = open(store)
    const h = accountsHarness({
      deps: { actions: ledger },
      accounts: { breakGlass: true },
    })
    const paths = ['/v0/limits', '/v0/limits', '/fragments/roster', '/nodes']
    for (const path of paths) {
      await h.handle(asBearer('GET', path, ACCOUNTS_ADMIN))
    }
    await h.handle(asBearer('GET', '/v0/nope', ACCOUNTS_ADMIN))
    const glass = await ledger.list({ actionPrefix: 'breakglass.' })
    if (!glass.ok) throw new Error('list failed')
    expect(
      glass.value.entries.map(e => `${e.target} ${e.outcome}`).reverse(),
    ).toEqual([
      'GET /v0/limits ok',
      'GET /v0/limits ok',
      'GET /fragments/roster ok',
      'GET /nodes ok',
      'GET /v0/nope refused',
    ])
    for (const entry of glass.value.entries) {
      expect(entry.breakGlass).toBe(true)
      expect(entry.subject).toBe('legacy:admin')
    }
    // Five requests, five request ids.
    expect(new Set(glass.value.entries.map(e => e.requestId)).size).toBe(5)
    expect((store.text ?? '').includes(ACCOUNTS_ADMIN)).toBe(false)
  })

  test('a closed ledger turns every write away before it happens', async () => {
    const store = new MemoryActionStore()
    const { ledger } = open(store)
    const h = accountsHarness({ deps: { actions: ledger } })
    const member = await person(h.handle, 'member')
    store.text = (store.text ?? '').replace('ledger.header', 'ledger.headed')
    const opened = await h.handle(
      asSession('POST', '/v0/chat/sessions', member.sid, {
        body: { target: 'qianmo://tokyo-1/planner' },
      }),
    )
    expect(opened.status).toBe(503)
    expect(h.chat.opened).toBe(0)
    const wake = await h.handle(
      asBearer('POST', '/v0/wake', ACCOUNTS_ADMIN, {
        from: 'qianmo://tokyo-hub/console',
        to: 'qianmo://tokyo-1/planner',
        prompt: 'x',
      }),
    )
    expect(wake.status).toBe(503)
    expect(h.wake.sent).toBe(0)
  })
})
