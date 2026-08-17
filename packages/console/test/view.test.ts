// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: MIT

/**
 * The view layer, tested as what it is: pure functions from data to strings.
 *
 * That is the whole reason the console renders on the server. There is no
 * browser here, no DOM, no jsdom, no build step — a roster with a hostile
 * address in it is a function call, and "did the escape hold" is an assertion
 * about a string. The parts that a browser *would* be needed for are kept in
 * `client.ts` and deliberately kept small.
 *
 * The suite is organised around what can actually go wrong:
 *
 * - **Escaping**, with real payloads rather than a lone `<b>`. Element content,
 *   attribute position, and the two breakouts that a naive escaper misses
 *   (`" onload=` and `</textarea>`).
 * - **Health boundaries**, because `live`/`stale`/`expired` is the one piece of
 *   judgement in the view and an off-by-one there is a node that looks fine
 *   until it vanishes.
 * - **Failure and empty states**, because those are the states a first-time
 *   user is guaranteed to hit and the states nobody demos.
 * - **The two claims the page makes about itself**: the integrity strip is
 *   loud, and the two rate limits never merge into one number.
 */

import { describe, expect, test } from 'bun:test'
import { AuditSource, type AuditRecord, type MessageChain } from '@qianmo/audit'
import { CONSOLE_CLIENT_JS } from '../src/assets/client.js'
import { CONSOLE_CSS } from '../src/assets/css.js'
import { renderRoster } from '../src/view/agents.js'
import { renderAudit, renderChain } from '../src/view/audit.js'
import { attr, escapeHtml } from '../src/view/escape.js'
import {
  agentHealth,
  formatBytes,
  formatDuration,
  formatInstant,
  formatShortDuration,
  publicKeyFingerprint,
} from '../src/view/format.js'
import { renderLimits } from '../src/view/limits.js'
import { renderPage } from '../src/view/page.js'
import type {
  AuditFilter,
  AuditPage,
  ConsoleAgent,
  ConsoleFailure,
  LimitsSnapshot,
} from '../src/deps.js'

const NOW = 1_760_000_000_000
const TTL = 300_000

function agent(over: Partial<ConsoleAgent> = {}): ConsoleAgent {
  return {
    address: 'qianmo://node-a/reviewer',
    endpoint: 'node-a.internal:7421',
    capabilities: ['code-review', 'summarize'],
    status: 'online',
    registeredAt: NOW - 600_000,
    lastHeartbeatAt: NOW - 10_000,
    expiresAt: NOW + TTL - 10_000,
    ...over,
  }
}

function record(over: Partial<AuditRecord> = {}): AuditRecord {
  return {
    seq: 1,
    at: NOW - 5_000,
    source: AuditSource.Router,
    kind: 'forward',
    outcome: 'ok',
    prev: '0'.repeat(64),
    ...over,
  }
}

function page(over: Partial<AuditPage> = {}): AuditPage {
  return {
    records: [record()],
    intact: true,
    issueCount: 0,
    total: 1,
    ...over,
  }
}

const LIMITS: LimitsSnapshot = {
  protocol: {
    maxMessageBytes: 256 * 1024,
    maxHops: 8,
    defaultTtlMs: 30_000,
    defaultTaskTtlMs: 300_000,
    ratePerMinute: 600,
  },
  runtime: { capacity: 20, windowMs: 60_000 },
  registryTtlMs: TTL,
}

const NO_FILTER: AuditFilter = {}

/** Payloads that a peer on the network could plausibly put in an address. */
const ATTACKS = {
  script: '<script>alert(1)</script>',
  handler: '" onload="alert(1)',
  textarea: '</textarea><img src=x onerror=alert(1)>',
  singleQuote: "' onmouseover='alert(1)",
  backtick: '`onload=alert(1)',
  entity: 'a&b',
  closeTag: '</style><script>alert(1)</script>',
} as const

/**
 * The precise property, rather than a substring hunt.
 *
 * Looking for `onerror=` is the wrong assertion: it appears, harmlessly, inside
 * `&lt;img src=x onerror=alert(1)&gt;`, which is text. What must never appear
 * is the **raw payload**, byte for byte — if the exact attack string survives
 * anywhere in the output then some `"` or `<` was not encoded, and that is the
 * only way one of these becomes markup.
 */
function expectInert(html: string): void {
  for (const payload of Object.values(ATTACKS)) {
    // `entity` is a legitimate string, not an attack.
    if (payload === ATTACKS.entity) continue
    // A bare backtick is inert in element content — it is a quote character
    // only inside an *unquoted* attribute value, which is why `attr` escapes it
    // and `escapeHtml` deliberately does not. Its attribute-position behaviour
    // is asserted directly in the escape suite.
    if (payload === ATTACKS.backtick) continue
    expect(html).not.toContain(payload)
  }
  expect(html).not.toContain('<script>alert')
  expect(html).not.toContain('<img')
}

/**
 * The declarations of one CSS rule, by the selector that opens it.
 *
 * Design decisions that a redesign is supposed to keep — the rail is a real
 * column, a section label is 12px of unbold mono — are only worth writing down
 * if they can be checked, and the place they live is the stylesheet.
 */
function ruleOf(selector: string): string {
  const at = CONSOLE_CSS.indexOf(`\n${selector} {`)
  expect(at).toBeGreaterThan(-1)
  const start = CONSOLE_CSS.indexOf('{', at)
  return CONSOLE_CSS.slice(start, CONSOLE_CSS.indexOf('}', start))
}

// ---------------------------------------------------------------------------

describe('escape', () => {
  test('covers the five characters that matter, and nothing else', () => {
    expect(escapeHtml('&<>"\'')).toBe('&amp;&lt;&gt;&quot;&#39;')
    expect(escapeHtml('plain 文本 42')).toBe('plain 文本 42')
  })

  test('ampersand is escaped first, so no double-encoding loop', () => {
    expect(escapeHtml('&lt;')).toBe('&amp;lt;')
    expect(escapeHtml(ATTACKS.entity)).toBe('a&amp;b')
  })

  test('neutralises a script tag', () => {
    const out = escapeHtml(ATTACKS.script)
    expect(out).not.toContain('<script')
    expect(out).toBe('&lt;script&gt;alert(1)&lt;/script&gt;')
  })

  test('neutralises the attribute breakout', () => {
    expect(attr(ATTACKS.handler)).not.toContain('"')
    expect(attr(ATTACKS.singleQuote)).not.toContain("'")
  })

  test('neutralises the textarea breakout', () => {
    const out = escapeHtml(ATTACKS.textarea)
    expect(out).not.toContain('</textarea')
    expect(out).not.toContain('<img')
  })

  test('attr is strictly wider than escapeHtml: backtick too', () => {
    expect(attr(ATTACKS.backtick)).not.toContain('`')
    expect(attr(ATTACKS.backtick)).toContain('&#96;')
    // escapeHtml leaves it, which is correct for element content.
    expect(escapeHtml(ATTACKS.backtick)).toContain('`')
  })

  test('survives a non-string arriving off a socket', () => {
    const sneaky = 42 as unknown as string
    expect(escapeHtml(sneaky)).toBe('42')
    expect(() => attr(null as unknown as string)).not.toThrow()
  })
})

// ---------------------------------------------------------------------------

describe('formatting', () => {
  test('formatInstant carries a clock and a relative gap', () => {
    const out = formatInstant(NOW - 180_000, NOW)
    expect(out).toMatch(/^\d{2}:\d{2}:\d{2}（3 分钟前）$/)
  })

  test('formatInstant names the sub-second case rather than saying "0 秒前"', () => {
    expect(formatInstant(NOW - 200, NOW)).toContain('（刚刚）')
  })

  test('formatInstant shows clock skew instead of hiding it', () => {
    expect(formatInstant(NOW + 5_000, NOW)).toContain('（5 秒后）')
  })

  test('formatInstant refuses to invent a time for a missing stamp', () => {
    expect(formatInstant(0, NOW)).toBe('—')
    expect(formatInstant(Number.NaN, NOW)).toBe('—')
  })

  test('formatDuration: the two documented examples', () => {
    expect(formatDuration(90_000)).toBe('1 分 30 秒')
    expect(formatDuration(90 * 24 * 3_600_000)).toBe('90 天')
  })

  test('formatDuration drops a zero remainder and stops at two units', () => {
    expect(formatDuration(60_000)).toBe('1 分')
    expect(formatDuration(3_600_000)).toBe('1 小时')
    expect(formatDuration(3_600_000 + 120_000)).toBe('1 小时 2 分')
    expect(formatDuration(24 * 3_600_000 + 3 * 3_600_000)).toBe('1 天 3 小时')
    expect(formatDuration(500)).toBe('500 毫秒')
    expect(formatDuration(-5_000)).toBe('0 毫秒')
  })

  test('formatBytes speaks the same binary units as LIMITS', () => {
    expect(formatBytes(256 * 1024)).toBe('256 KiB')
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(1023)).toBe('1023 B')
    expect(formatBytes(1536)).toBe('1.5 KiB')
    expect(formatBytes(5 * 1024 * 1024)).toBe('5 MiB')
  })

  test('publicKeyFingerprint is a hash, not a prefix of the key', () => {
    const key = 'ed25519:AAAABBBBCCCCDDDD'
    const fp = publicKeyFingerprint(key)
    expect(fp).toHaveLength(8)
    expect(fp).toMatch(/^[0-9a-f]{8}$/)
    expect(key).not.toContain(fp)
  })
})

// ---------------------------------------------------------------------------

describe('agentHealth', () => {
  test('a fresh heartbeat inside the first half of the lease is live', () => {
    expect(agentHealth(agent(), NOW, TTL)).toBe('live')
  })

  test('exactly half a TTL is already stale — the renewal is overdue', () => {
    const half = agent({
      lastHeartbeatAt: NOW - TTL / 2,
      expiresAt: NOW + TTL / 2,
    })
    expect(agentHealth(half, NOW, TTL)).toBe('stale')
  })

  test('one millisecond before half is still live', () => {
    const nearly = agent({
      lastHeartbeatAt: NOW - (TTL / 2 - 1),
      expiresAt: NOW + TTL,
    })
    expect(agentHealth(nearly, NOW, TTL)).toBe('live')
  })

  test('an age exactly equal to the TTL is expired, not stale', () => {
    // The boundary the roster is judged on: the lease has run out to the
    // millisecond. Rounding this the other way puts a dead node in amber.
    const exact = agent({ lastHeartbeatAt: NOW - TTL, expiresAt: 0 })
    expect(agentHealth(exact, NOW, TTL)).toBe('expired')
  })

  test('a lapsed lease is expired even with a recent heartbeat', () => {
    const lapsed = agent({ lastHeartbeatAt: NOW - 1_000, expiresAt: NOW - 1 })
    expect(agentHealth(lapsed, NOW, TTL)).toBe('expired')
  })

  test('a lease expiring exactly now is expired', () => {
    expect(agentHealth(agent({ expiresAt: NOW }), NOW, TTL)).toBe('expired')
  })

  test('never heard from is stale, never live', () => {
    const silent = agent({ lastHeartbeatAt: 0, expiresAt: NOW + TTL })
    expect(agentHealth(silent, NOW, TTL)).toBe('stale')
  })

  test('a heartbeat from the future reads as just-now, not as negative age', () => {
    const skewed = agent({
      lastHeartbeatAt: NOW + 60_000,
      expiresAt: NOW + TTL,
    })
    expect(agentHealth(skewed, NOW, TTL)).toBe('live')
  })

  test('a nonsense TTL falls back to the lease alone', () => {
    expect(agentHealth(agent({ expiresAt: NOW + 1 }), NOW, 0)).toBe('live')
    expect(agentHealth(agent({ expiresAt: NOW - 1 }), NOW, 0)).toBe('expired')
  })
})

// ---------------------------------------------------------------------------

describe('renderRoster', () => {
  test('an empty registry names the next action instead of going blank', () => {
    const html = renderRoster([], null, NOW, TTL)
    expect(html).toContain('还没有节点 · ')
    expect(html).toContain('在下面注册第一个')
    expect(html).toContain('href="#register"')
    expect(html).not.toContain('<table')
    // One short line. The empty state is allowed a sentence; it is not allowed
    // a paragraph of encouragement.
    expect(html).not.toContain('。')
  })

  test('every branch emits the rail, so the row never loses its heading', () => {
    const failure: ConsoleFailure = { code: 'unreachable', message: '超时' }
    for (const html of [
      renderRoster(null, null, NOW, TTL),
      renderRoster(null, failure, NOW, TTL),
      renderRoster([], null, NOW, TTL),
      renderRoster([agent()], null, NOW, TTL),
    ]) {
      expect(html).toContain('<h2 class="rail-name" id="h-nodes">节点</h2>')
      expect(html).toContain('<div class="pane">')
    }
  })

  test('the rail carries the counts the deleted prose used to explain', () => {
    const html = renderRoster(
      [agent(), agent({ address: 'a://2' })],
      null,
      NOW,
      TTL,
    )
    expect(html).toContain('<span class="total">2</span>')
    expect(html).toContain('<span class="tone-ok">在线 2</span>')
    // Zero rows are not printed: a permanent 过期 0 makes the day it turns
    // into 过期 1 look like nothing changed.
    expect(html).not.toContain('滞后 0')
    expect(html).not.toContain('过期 0')
    expect(html).toContain('租约 5 分')
  })

  test('a null roster with no failure says so rather than pretending to be empty', () => {
    const html = renderRoster(null, null, NOW, TTL)
    expect(html).toContain('未取得注册数据')
    expect(html).not.toContain('暂无节点')
  })

  test('a failure renders a bar and does not throw', () => {
    const failure: ConsoleFailure = {
      code: 'unreachable',
      message: '连接注册中心被拒绝',
    }
    let html = ''
    expect(() => {
      html = renderRoster(null, failure, NOW, TTL)
    }).not.toThrow()
    expect(html).toContain('bar-bad')
    expect(html).toContain('unreachable')
    expect(html).toContain('连接注册中心被拒绝')
  })

  test('a failure over stale data keeps the table and says the data is old', () => {
    const failure: ConsoleFailure = { code: 'unreachable', message: '超时' }
    const html = renderRoster([agent()], failure, NOW, TTL)
    expect(html).toContain('bar-bad')
    expect(html).toContain('最后一次成功读取')
    expect(html).toContain('<table')
  })

  test('a failure message is escaped like everything else', () => {
    const failure: ConsoleFailure = {
      code: 'rejected',
      message: ATTACKS.script,
    }
    const html = renderRoster(null, failure, NOW, TTL)
    expect(html).not.toContain('<script')
  })

  test('every hostile field is neutralised in both content and attribute position', () => {
    const html = renderRoster(
      [
        agent({
          address: ATTACKS.handler,
          endpoint: ATTACKS.script,
          capabilities: [ATTACKS.textarea],
          status: ATTACKS.closeTag,
        }),
      ],
      null,
      NOW,
      TTL,
    )
    expectInert(html)
    // The address still round-trips into the action buttons, escaped.
    expect(html).toContain('data-address="&quot; onload=&quot;alert(1)"')
  })

  test('the public key is never printed, only an 8-hex fingerprint', () => {
    const key = 'ed25519:MCowBQYDK2VwAyEA-secret-looking-material'
    const html = renderRoster([agent({ publicKey: key })], null, NOW, TTL)
    expect(html).not.toContain(key)
    expect(html).not.toContain('MCowBQYDK2VwAyEA')
    expect(html).toContain(publicKeyFingerprint(key))
  })

  test('a node with no key says so instead of leaving the cell blank', () => {
    const html = renderRoster([agent()], null, NOW, TTL)
    expect(html).toContain('未发布')
  })

  test('the three health states each get their own tone', () => {
    const html = renderRoster(
      [
        agent({ address: 'a://1' }),
        agent({
          address: 'a://2',
          lastHeartbeatAt: NOW - TTL / 2,
          expiresAt: NOW + 10,
        }),
        agent({ address: 'a://3', expiresAt: NOW - 1 }),
      ],
      null,
      NOW,
      TTL,
    )
    expect(html).toContain('data-health="live"')
    expect(html).toContain('data-health="stale"')
    expect(html).toContain('data-health="expired"')
    // Status is a dot, not a filled badge: a column of colour blocks stops
    // meaning anything by the fourth row.
    expect(html).toContain('dot-ok')
    expect(html).toContain('dot-warn')
    expect(html).toContain('dot-bad')
    expect(html).not.toContain('pill')
    // …and the rail states the same three counts as digits.
    expect(html).toContain('<span class="total">3</span>')
    expect(html).toContain('<span class="tone-ok">在线 1</span>')
    expect(html).toContain('<span class="tone-warn">滞后 1</span>')
    expect(html).toContain('<span class="tone-bad">过期 1</span>')
  })

  test('a lapsed lease is labelled, not shown as a negative countdown', () => {
    const html = renderRoster(
      [agent({ expiresAt: NOW - 90_000 })],
      null,
      NOW,
      TTL,
    )
    expect(html).toContain('过期')
    expect(html).not.toContain('-90')
  })

  test('each row offers heartbeat and deregister', () => {
    const html = renderRoster([agent()], null, NOW, TTL)
    expect(html).toContain('data-action="heartbeat"')
    expect(html).toContain('data-action="deregister"')
  })
})

// ---------------------------------------------------------------------------

/**
 * The one graphic element on the page, and therefore the one that has to be
 * pinned down. Three boundaries: under half a lease, past half, and lapsed.
 */
describe('lease bar', () => {
  function barOf(over: Partial<ConsoleAgent>): string {
    const html = renderRoster([agent(over)], null, NOW, TTL)
    const start = html.indexOf('<td class="lease"')
    expect(start).toBeGreaterThan(-1)
    return html.slice(start, html.indexOf('</td>', start))
  }

  test('a fresh heartbeat is a short ink bar and the time it has left', () => {
    // 10s of a 300s lease.
    const cell = barOf({})
    expect(cell).toContain('<span class="lease-fill" style="width:3%">')
    expect(cell).not.toContain('lease-stale')
    expect(cell).not.toContain('lease-dead')
    expect(cell).toContain('>4m50s<')
  })

  test('past the halfway mark the bar turns amber', () => {
    const cell = barOf({
      lastHeartbeatAt: NOW - TTL / 2,
      expiresAt: NOW + TTL / 2,
    })
    expect(cell).toContain('lease-fill lease-stale')
    expect(cell).toContain('style="width:50%"')
    expect(cell).toContain('>2m30s<')
  })

  test('an expired lease is locked at full width, never past it', () => {
    // Three times the TTL: the bar is full, not 300% wide, and the remaining
    // time is zero rather than a negative countdown.
    const cell = barOf({
      lastHeartbeatAt: NOW - TTL * 3,
      expiresAt: NOW - TTL * 2,
    })
    expect(cell).toContain('lease-fill lease-dead')
    expect(cell).toContain('style="width:100%"')
    expect(cell).toContain('>0s<')
    expect(cell).not.toContain('>-')
    expect(cell).not.toContain('width:300%')
  })

  test('the bar and the status word can never disagree', () => {
    // A lapsed registry record with a fresh heartbeat: the registry's verdict
    // decides whether messages route, so both halves say expired.
    const html = renderRoster(
      [agent({ lastHeartbeatAt: NOW - 1_000, expiresAt: NOW - 1 })],
      null,
      NOW,
      TTL,
    )
    expect(html).toContain('data-health="expired"')
    expect(html).toContain('lease-fill lease-dead')
  })

  test('no scale to draw against means no bar at all', () => {
    const html = renderRoster([agent()], null, NOW, 0)
    expect(html).not.toContain('lease-fill')
    expect(html).toContain('<td class="lease"><span class="absent">')
  })

  test('the compact duration lines up digit for digit', () => {
    expect(formatShortDuration(290_000)).toBe('4m50s')
    expect(formatShortDuration(150_000)).toBe('2m30s')
    expect(formatShortDuration(59_000)).toBe('59s')
    expect(formatShortDuration(60_000)).toBe('1m')
    expect(formatShortDuration(3_600_000 + 120_000)).toBe('1h02m')
    expect(formatShortDuration(25 * 3_600_000)).toBe('1d1h')
    expect(formatShortDuration(-1)).toBe('0s')
  })
})

// ---------------------------------------------------------------------------

describe('renderAudit', () => {
  test('a broken chain is stated on the rail, in --dead, before anything', () => {
    const html = renderAudit(
      page({ intact: false, issueCount: 3 }),
      null,
      NO_FILTER,
    )
    expect(html).toContain('<span class="tone-bad">断裂 3</span>')
    expect(html).toContain('审计链断裂')
    expect(html).toContain('role="alert"')
    // The rail opens the fragment, so the number is above the form and the
    // table even with the script disabled.
    expect(html.indexOf('断裂 3')).toBeLessThan(html.indexOf('audit-filter'))
    expect(html.indexOf('audit-rail')).toBeLessThan(
      html.indexOf('audit-results'),
    )
    // …and there is no full-bleed banner left to dock at the top of the page.
    expect(html).not.toContain('integrity-alert')
    expect(html).not.toContain('alert-dock')
  })

  test('the alert is one line: the fact and the number', () => {
    const html = renderAudit(page({ intact: false, issueCount: 1 }), null, {})
    const start = html.indexOf('<p class="bar bar-bad" id="audit-integrity"')
    expect(start).toBeGreaterThan(-1)
    const strip = html.slice(start, html.indexOf('</p>', start))
    const text = strip.replace(/<[^>]*>/g, '')
    expect(text).toBe('审计链断裂 · 1 处')
    // No explanation on screen. A strip long enough to read is a strip long
    // enough to scan past, which defeats the only thing it is for.
    expect(text.length).toBeLessThan(16)
  })

  test('an intact trail renders no alert at all', () => {
    const html = renderAudit(page(), null, NO_FILTER)
    expect(html).not.toContain('audit-integrity')
    expect(html).toContain('<span class="tone-ok">完整</span>')
  })

  test('the rail states the trail size and only names what is hidden', () => {
    const unfiltered = renderAudit(page(), null, NO_FILTER)
    expect(unfiltered).toContain('<span class="total">1</span>')
    expect(unfiltered).not.toContain('显示 1')

    const filtered = renderAudit(page({ total: 512 }), null, NO_FILTER)
    expect(filtered).toContain('<span class="total">512</span>')
    expect(filtered).toContain('显示 1')
  })

  test('the filter form offers all twelve sources plus 全部', () => {
    const html = renderAudit(page(), null, NO_FILTER)
    for (const source of Object.values(AuditSource)) {
      expect(html).toContain(`value="${source}"`)
    }
    expect(Object.values(AuditSource)).toHaveLength(12)
    expect(html).toContain('全部')
  })

  test('the filter form is prefilled and every value is escaped', () => {
    const html = renderAudit(page(), null, {
      traceId: ATTACKS.handler,
      taskId: ATTACKS.singleQuote,
      agent: ATTACKS.script,
      outcome: 'refused',
      source: AuditSource.Transport,
      limit: 50,
    })
    expectInert(html)
    expect(html).toContain('value="50"')
    expect(html).toContain(`value="${AuditSource.Transport}" selected`)
    expect(html).toContain('value="refused" selected')
  })

  test('the filter form lives outside the polled region', () => {
    const html = renderAudit(page(), null, NO_FILTER)
    // If the form were inside #audit-results the five-second poller would
    // replace it mid-keystroke.
    const formAt = html.indexOf('id="audit-filter"')
    const resultsAt = html.indexOf('id="audit-results"')
    expect(formAt).toBeGreaterThan(-1)
    expect(formAt).toBeLessThan(resultsAt)
  })

  test('hostile kind, code and detail are all neutralised', () => {
    const html = renderAudit(
      page({
        records: [
          record({
            kind: ATTACKS.script,
            code: ATTACKS.handler,
            node: ATTACKS.textarea,
            peer: ATTACKS.closeTag,
            traceId: ATTACKS.singleQuote,
            detail: { [ATTACKS.backtick]: ATTACKS.script, count: 3 },
          }),
        ],
      }),
      null,
      NO_FILTER,
    )
    expectInert(html)
    expect(html).toContain('count=')
  })

  test('refused and dropped rows are marked for the eye, not filtered out', () => {
    const html = renderAudit(
      page({
        records: [
          record({ seq: 1, outcome: 'ok' }),
          record({ seq: 2, outcome: 'refused', code: 'E_RATE_LIMITED' }),
          record({ seq: 3, outcome: 'dropped' }),
        ],
        total: 3,
      }),
      null,
      NO_FILTER,
    )
    expect(html).toContain(`data-outcome="refused"`)
    expect(html).toContain(`data-outcome="dropped"`)
    expect(html).toContain('E_RATE_LIMITED')
    expect(html).toContain('拒绝')
    expect(html).toContain('丢弃')
  })

  test('a trace cell is clickable and carries the full segment', () => {
    const trace = '4bf92f3577b34da6a3ce929d0e0e4736'
    const html = renderAudit(
      page({
        records: [record({ traceId: `00-${trace}-00f067aa0ba902b7-01` })],
      }),
      null,
      NO_FILTER,
    )
    expect(html).toContain(`data-trace="${trace}"`)
    expect(html).toContain('data-action="chain"')
    // Only eight characters on screen; the rest is in the attribute.
    expect(html).toContain('>4bf92f35…<')
  })

  test('an empty result set explains what to change', () => {
    const html = renderAudit(page({ records: [], total: 40 }), null, NO_FILTER)
    expect(html).toContain('无匹配记录')
    expect(html).not.toContain('<table')
    expect(html).toContain('<span class="total">40</span>')
    expect(html).toContain('显示 0')
  })

  test('a failure renders a bar and does not throw', () => {
    let html = ''
    expect(() => {
      html = renderAudit(null, { code: 'not_found', message: '找不到日志' }, {})
    }).not.toThrow()
    expect(html).toContain('bar-bad')
    expect(html).toContain('找不到日志')
    expect(html).toContain('not_found')
  })

  test('null page with no failure is a neutral state, not an error', () => {
    const html = renderAudit(null, null, NO_FILTER)
    expect(html).toContain('未读取审计日志')
    expect(html).not.toContain('bar-bad')
  })
})

// ---------------------------------------------------------------------------

describe('renderChain', () => {
  const chain: MessageChain = {
    traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
    records: [
      record({ seq: 1, source: AuditSource.Transport, kind: 'sent' }),
      record({
        seq: 2,
        source: AuditSource.Router,
        kind: 'rate_limited',
        outcome: 'refused',
        code: 'E_RATE_LIMITED',
      }),
      record({
        seq: 3,
        source: AuditSource.Transport,
        kind: 'dedup',
        outcome: 'dropped',
      }),
    ],
    taskIds: ['task-000000000001'],
    msgIds: ['msg-aaaaaaaaaaaa', 'msg-bbbbbbbbbbbb'],
    sources: [AuditSource.Transport, AuditSource.Router],
    refused: 1,
    dropped: 1,
    firstAt: NOW - 90_000,
    lastAt: NOW,
  }

  test('a missing chain explains itself and offers a way out', () => {
    const html = renderChain(null)
    expect(html).toContain('未找到该 trace')
    expect(html).toContain('data-action="chain-close"')
  })

  test('it is a path of hops, not a second table', () => {
    const html = renderChain(chain)
    expect(html).not.toContain('<table')
    expect(html).not.toContain('<tr')
    expect(html).toContain('<ol class="hops">')
    // Each hop is where it happened, what was attempted, how it ended.
    expect(html).toContain('<li class="hop" data-outcome="ok" data-seq="1">')
    expect(html).toContain('<span class="hop-kind mono">sent</span>')
    expect(html).toContain('<span class="hop-line"></span>')
    expect(html.match(/class="hop"/g)).toHaveLength(3)
  })

  test('the three outcomes get three different marks', () => {
    const html = renderChain(chain)
    // 通过 = filled dot, 拒绝 = hollow square, 丢弃 = dashed segment. Drawn
    // with boxes and hairlines: no icon font, no pictograph, no SVG.
    expect(html).toContain('hop-mark mark-ok')
    expect(html).toContain('hop-mark mark-refused')
    expect(html).toContain('hop-mark mark-dropped')
    expect(html).toContain('data-outcome="refused"')
    expect(html).toContain('data-outcome="dropped"')
    // The mark is not the only channel: each one names its outcome for a
    // screen reader and for a hover.
    expect(html).toContain('title="拒绝"')
    expect(html).toContain('<span class="sr-only">丢弃</span>')
  })

  test('a refusal keeps its code on the hop that caused it', () => {
    const html = renderChain(chain)
    expect(html).toContain('<span class="hop-code mono">E_RATE_LIMITED</span>')
  })

  test('records keep the order they arrived in — seq order, not clock order', () => {
    const html = renderChain(chain)
    expect(html.indexOf('data-seq="1"')).toBeLessThan(
      html.indexOf('data-seq="2"'),
    )
    expect(html.indexOf('data-seq="2"')).toBeLessThan(
      html.indexOf('data-seq="3"'),
    )
    expect(html.indexOf('>sent<')).toBeLessThan(html.indexOf('>rate_limited<'))
  })

  test('a hop with no node names the layer that logged it', () => {
    const html = renderChain(chain)
    expect(html).toContain('<span class="hop-node mono" title="传输">传输')
    expect(html).toContain('<span class="hop-node mono" title="路由">路由')
    expect(html).not.toContain('>?<')
  })

  test('the refusal counts lead, and the foot carries trace and span', () => {
    const html = renderChain(chain)
    expect(html).toContain('3 条')
    expect(html).toContain('<span class="tone-bad">拒绝 1</span>')
    expect(html).toContain('<span class="tone-warn">丢弃 1</span>')
    const foot = html.slice(html.indexOf('<p class="chain-foot'))
    expect(foot).toContain('4bf92f35…')
    expect(foot).toContain('1 分 30 秒')
  })

  test('ids are truncated on screen and complete in the tooltip', () => {
    const html = renderChain(chain)
    expect(html).toContain('title="msg-aaaaaaaaaaaa"')
    expect(html).toContain('>msg-aaaa…<')
  })

  test('a hostile traceId cannot break out of the heading', () => {
    const html = renderChain({ ...chain, traceId: ATTACKS.script })
    expect(html).not.toContain('<script>alert')
  })

  test('a hostile node name cannot break out of a hop', () => {
    const html = renderChain({
      ...chain,
      records: [record({ node: ATTACKS.handler, peer: ATTACKS.script })],
    })
    expectInert(html)
  })
})

// ---------------------------------------------------------------------------

describe('renderLimits', () => {
  const html = renderLimits(LIMITS)

  function columnOf(id: string): string {
    const start = html.indexOf(`id="${id}"`)
    expect(start).toBeGreaterThan(-1)
    const end = html.indexOf('</section>', start)
    return html.slice(start, end)
  }

  test('both ceilings are rendered from their own package', () => {
    expect(html).toContain('@qianmo/protocol')
    expect(html).toContain('LIMITS')
    expect(html).toContain('@qianmo/router')
    expect(html).toContain('RUNTIME_RATE')
  })

  test('the two rate limits live in two columns and never merge', () => {
    const protocol = columnOf('limits-protocol')
    const runtime = columnOf('limits-runtime')

    // Each column carries its own number and its own source, and neither
    // mentions the other's. `packages/router/src/rate.ts`: the two limits are
    // structurally distinct and must not be mixed — a dashboard is a document.
    expect(protocol).toContain('600 / 分钟')
    expect(protocol).toContain('@qianmo/protocol')
    expect(protocol).not.toContain('RUNTIME_RATE')
    expect(protocol).not.toContain('@qianmo/router')

    expect(runtime).toContain('20 / 1 分')
    expect(runtime).toContain('@qianmo/router')
    expect(runtime).not.toContain('LIMITS')
    expect(runtime).not.toContain('600')
  })

  test('the counting unit is part of the key, not a deletable footnote', () => {
    // The rule in packages/router/src/rate.ts survives a redesign only if it is
    // structural. A note under the table is the first thing a redesign deletes;
    // two rows that read differently cannot be skimmed as the same row.
    expect(columnOf('limits-protocol')).toContain('速率（节点 × 节点）')
    expect(columnOf('limits-runtime')).toContain('速率（发送方 × 地址）')
  })

  test('the block is key/value only — nothing to skim past', () => {
    expect(html).not.toContain('。')
    expect(html).not.toContain('dd-note')
  })

  test('protocol ceilings are shown in the units the constants are written in', () => {
    const protocol = columnOf('limits-protocol')
    expect(protocol).toContain('256 KiB')
    expect(protocol).toContain('30 秒')
    expect(protocol).toContain('5 分')
  })

  test('the registry lease is a third thing, not folded into either column', () => {
    expect(html).toContain('id="limits-registry"')
    expect(columnOf('limits-protocol')).not.toContain('注册中心租约')
    expect(columnOf('limits-runtime')).not.toContain('注册中心租约')
  })
})

// ---------------------------------------------------------------------------

describe('renderPage', () => {
  function build(over: Partial<Parameters<typeof renderPage>[0]> = {}) {
    return renderPage({
      label: 'node-a 本机',
      now: NOW,
      roster: renderRoster([agent()], null, NOW, TTL),
      audit: renderAudit(page(), null, NO_FILTER),
      limits: renderLimits(LIMITS),
      wakeEnabled: true,
      auditFilter: NO_FILTER,
      ...over,
    })
  }

  test('is a complete document that follows the system theme', () => {
    const html = build()
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true)
    expect(html).toContain('<meta name="color-scheme" content="light dark">')
    expect(html).toContain('prefers-color-scheme: dark')
    expect(html).toContain('color-scheme: light dark')
    expect(html).toContain('</html>')
    expect(html).toContain('lang="zh-CN"')
  })

  test('loads nothing from anywhere — no scheme appears in the document', () => {
    const html = build()
    expect(html).not.toContain('http://')
    expect(html).not.toContain('https://')
    expect(html).not.toContain('//cdn')
    expect(html).not.toContain('<link')
    expect(html).not.toContain('src="')
    expect(html).not.toContain('@import')
    expect(html).not.toContain('url(')
  })

  test('states the same rule in a CSP the browser enforces', () => {
    const html = build()
    expect(html).toContain('Content-Security-Policy')
    expect(html).toContain('default-src &#39;none&#39;')
    expect(html).toContain('connect-src &#39;self&#39;')
    expect(html).toContain('img-src &#39;none&#39;')
  })

  test('inlines exactly one stylesheet and one script', () => {
    const html = build()
    expect(html.split('<style>')).toHaveLength(2)
    expect(html.split('<script>')).toHaveLength(2)
    // Nothing in the script can close the tag early.
    const script = html.slice(html.indexOf('<script>'))
    expect(script.split('</script>')).toHaveLength(2)
  })

  test('carries the three fragments and their mount points', () => {
    const html = build()
    expect(html).toContain('id="roster"')
    expect(html).toContain('id="audit"')
    expect(html).toContain('id="limits"')
    expect(html).toContain('id="chain"')
    expect(html).toContain('id="register"')
    expect(html).toContain('qianmo://node-a/reviewer')
    // The dark red banner and its dock are gone: a broken chain now reads
    // `断裂 N` on the 消息链 rail.
    expect(html).not.toContain('alert-dock')
    expect(html).not.toContain('integrity-alert')
  })

  test('every row of the page is [rail][pane]', () => {
    const html = build()
    const body = html.slice(html.indexOf('<main>'))
    // Five rails: 节点, 注册, 消息链, 限额, 唤醒 — plus the empty one the
    // chain panel hangs off.
    for (const name of ['节点', '注册', '消息链', '限额', '唤醒']) {
      expect(body).toContain(`class="rail-name"`)
      expect(body).toContain(name)
    }
    expect(body.match(/class="row"/g)?.length).toBe(6)
    expect(body).toContain('<div class="pane">')
  })

  test('the sidebar carries the brand, the label, a clock and the controls', () => {
    const html = build()
    expect(html).toContain('阡陌 console')
    expect(html).toContain('class="wordmark"')
    expect(html).toContain('node-a 本机')
    expect(html).toContain('id="clock"')
    expect(html).toContain('id="auto-refresh"')
    expect(html).toContain('id="refresh-interval"')
    expect(html).toContain('value="5000" selected')
    expect(html).toContain('id="token"')
  })

  test('the shell is a fixed sidebar plus an independently scrolling content pane', () => {
    const html = build()
    expect(html).toContain('class="shell"')
    expect(html).toContain('class="sidebar"')
    expect(html).toContain('class="content"')
    // The sidebar no longer holds a top bar — it is gone entirely.
    expect(html).not.toContain('class="topbar"')
    for (const [href, label] of [
      ['#overview', '总览'],
      ['#nodes-section', '节点'],
      ['#trail-section', '消息链'],
      ['#limits-section', '限额'],
      ['#wake-section', '唤醒'],
    ] as const) {
      expect(html).toContain(`<a class="nav-item" href="${href}">${label}</a>`)
    }
  })

  test('an overview section leads with four stat cards, summarising numbers the ledger already shows', () => {
    const html = build()
    expect(html).toContain('id="overview"')
    expect(html).toContain('class="stat-grid"')
    expect(html.match(/class="stat-card"/g)).toHaveLength(4)
    // The node count on the card is the same total the roster rail carries.
    expect(html).toContain('<p class="stat-label">节点</p>')
    expect(html).toContain('<p class="stat-value">1</p>')
    expect(html).toContain('在线 1')
    // An intact trail reads 完整, not a false-precision 断裂 0.
    expect(html).toContain('<p class="stat-label">消息链</p>')
    expect(html).toContain('<p class="stat-hint">完整</p>')
  })

  test('a broken chain colours the overview hint destructive, matching the rail', () => {
    const html = build({
      audit: renderAudit(
        page({ intact: false, issueCount: 4 }),
        null,
        NO_FILTER,
      ),
    })
    expect(html).toContain('<p class="stat-hint tone-bad">断裂 4</p>')
  })

  test('the label is escaped like any other value', () => {
    const html = build({ label: ATTACKS.handler })
    expect(html).not.toContain('" onload="')
    expect(html).toContain('&quot; onload=&quot;')
  })

  test('the register form is on the page — it is the exit criterion', () => {
    const html = build()
    expect(html).toContain('id="register-form"')
    expect(html).toContain('name="address"')
    expect(html).toContain('name="endpoint"')
    expect(html).toContain('name="capabilities"')
    expect(html).toContain('name="publicKey"')
    expect(html).toContain('name="status"')
    expect(html).toContain('>注册</button>')
  })

  test('a disabled wake face explains why and offers no button to press', () => {
    const html = build({ wakeEnabled: false })
    expect(html).toContain('QIANMO_TRANSPORT_PSK')
    expect(html).toContain('<fieldset disabled')
    expect(html).not.toContain('id="wake-form"')
    expect(html).not.toContain('>唤醒</button>')
  })

  test('an enabled wake face is a real form', () => {
    const html = build({ wakeEnabled: true })
    expect(html).toContain('id="wake-form"')
    expect(html).toContain('>唤醒</button>')
    expect(html).not.toContain('QIANMO_TRANSPORT_PSK')
  })

  test('the poller replays the current filter, escaped, as a query string', () => {
    const html = build({
      auditFilter: {
        source: AuditSource.Router,
        traceId: ATTACKS.handler,
        limit: 25,
        from: NOW - 3_600_000,
      },
      audit: renderAudit(page(), null, { source: AuditSource.Router }),
    })
    expect(html).toContain('data-query="')
    expect(html).toContain('source=router')
    expect(html).toContain('limit=25')
    expect(html).toContain(`from=${NOW - 3_600_000}`)
    expect(html).not.toContain('" onload="')
  })

  test('an empty filter yields an empty query rather than a stray question mark', () => {
    const html = build()
    expect(html).toContain('data-query=""')
  })

  test('the client script never builds HTML out of a response body', () => {
    const html = build()
    const script = html.slice(html.indexOf('<script>'))
    // Error text and server messages go through textContent; the only
    // innerHTML assignments take server-rendered fragments.
    expect(script).toContain('panel.textContent =')
    expect(script).toContain('el.textContent = value')
    expect(script).not.toContain('innerHTML = message')
    expect(script).not.toContain("innerHTML = '<")
  })

  test('the token rides in a header, never in a URL or the document', () => {
    const html = build()
    const script = html.slice(html.indexOf('<script>'))
    expect(script).toContain("headers['Authorization'] = 'Bearer ' + token")
    expect(script).toContain('history.replaceState')
    // The input is never seeded from storage, so a saved token is not sitting
    // in the DOM waiting to be read out of a screenshot.
    expect(script).not.toContain('input.value = readToken')
  })
})

// ---------------------------------------------------------------------------

describe('assets', () => {
  /**
   * The stylesheet and the script are TypeScript template literals, which means
   * a stray backtick or a `\\n` written as `\n` is a real hazard: the first is a
   * compile error, the second silently emits the wrong character into shipped
   * JavaScript. Parsing the emitted script is the cheap way to catch the second
   * class before it reaches a browser.
   */
  test('the emitted client script is valid JavaScript', () => {
    expect(() => new Function(CONSOLE_CLIENT_JS)).not.toThrow()
  })

  test('neither asset can close its own tag or reach off-origin', () => {
    for (const asset of [CONSOLE_CSS, CONSOLE_CLIENT_JS]) {
      expect(asset).not.toContain('</script')
      expect(asset).not.toContain('</style')
      expect(asset).not.toContain('http://')
      expect(asset).not.toContain('https://')
    }
    expect(CONSOLE_CSS).not.toContain('url(')
    expect(CONSOLE_CSS).not.toContain('@import')
  })

  /**
   * The design no longer confines colour to a single brand hex in the focus
   * ring: the focus ring itself now follows `--ring` (`--primary` on the
   * primary action), and `--primary` is deliberately spent on links and the
   * primary button too — the one exception to "colour states a fact" this
   * redesign keeps. What the check verifies is that the exception is the
   * *token*, not a hardcoded hex: no `#D77757` survives anywhere, and the
   * focus/primary machinery all resolves through `var(--ring)`/`var(--primary)`.
   */
  test('focus rings and the primary action are driven by tokens, not a hardcoded hex', () => {
    expect(CONSOLE_CSS).not.toContain('#D77757')
    expect(CONSOLE_CSS).toContain('outline: 2px solid var(--ring);')
    expect(CONSOLE_CSS).toContain('.btn-primary:focus-visible')
    expect(CONSOLE_CSS).toContain('outline-color: var(--primary);')
  })

  test('the primary action fills with --primary; the destructive one is an outline, never the default', () => {
    const primary = ruleOf('.btn-primary')
    expect(primary).toContain('background: var(--primary)')
    expect(primary).not.toContain('--destructive')

    // The plain button (心跳, 清空, 关闭, 保存/清除令牌…) never carries either
    // accent token — only the two deliberate exceptions do.
    const base = ruleOf('.btn')
    expect(base).not.toContain('--primary')
    expect(base).not.toContain('--destructive')

    // 注销 is the one dangerous action, and it is now a destructive outline
    // confirmed with a dialog — the colour marks the risk, the dialog stops
    // the slip.
    const destructive = ruleOf('.btn-destructive')
    expect(destructive).toContain('var(--destructive)')
    expect(destructive).not.toContain('background: var(--destructive)')

    const deregisterRow = renderRoster([agent()], null, NOW, TTL)
    expect(deregisterRow).toContain('class="btn btn-destructive"')
  })

  test('no shadow, no gradient, no decorative fill', () => {
    expect(CONSOLE_CSS).not.toContain('box-shadow')
    expect(CONSOLE_CSS).not.toContain('text-shadow')
    expect(CONSOLE_CSS).not.toContain('gradient')
  })

  test('sans is the display face; mono is earned by addresses, ids, hashes and code', () => {
    const body = ruleOf('body')
    expect(body).toContain('var(--ui)')
    expect(body).not.toContain('var(--mono)')
    expect(body).toContain('font-variant-numeric: tabular-nums')
    // Inter first, then the platform sans stack — never fetched, only named.
    expect(CONSOLE_CSS).toContain(
      '--ui: Inter, -apple-system, "SF Pro Text", "Segoe UI", system-ui, sans-serif;',
    )
    // Mono is confined to the elements the view layer tags for exactly this
    // reason: addresses, endpoints, key fingerprints, ids, protocol codes.
    const mono = ruleOf('.mono, code')
    expect(mono).toContain('var(--mono)')
  })

  test('a section label is a small muted sans label, not a headline', () => {
    const label = ruleOf('.rail-name, .section-label')
    expect(label).not.toContain('var(--mono)')
    expect(label).toContain('font-size: 12px')
    expect(label).toContain('color: var(--muted-foreground)')
    expect(label).not.toContain('bold')
    expect(label).not.toContain('rem')
  })

  test('the ledger rail is a real column that collapses on a narrow screen', () => {
    expect(ruleOf('.row')).toContain(
      'grid-template-columns: var(--rail) minmax(0, 1fr)',
    )
    const narrow = CONSOLE_CSS.slice(CONSOLE_CSS.indexOf('max-width: 900px'))
    expect(narrow).toContain('grid-template-columns: minmax(0, 1fr)')
    // Wide tables scroll inside their own box; the page body never does.
    expect(ruleOf('.scroll')).toContain('overflow-x: auto')
  })

  test('the only motion is a colour change under 120ms', () => {
    for (const transition of CONSOLE_CSS.match(/transition:[^;}]*/g) ?? []) {
      if (transition.includes('none')) continue
      expect(transition).toContain('120ms')
    }
    expect(CONSOLE_CSS).toContain('@media (prefers-reduced-motion: reduce)')
    expect(CONSOLE_CSS).not.toContain('@keyframes')
  })

  test('the stylesheet carries the shadcn token set, defined in both schemes', () => {
    const tokens = [
      '--background',
      '--foreground',
      '--card',
      '--card-foreground',
      '--primary',
      '--primary-foreground',
      '--secondary',
      '--secondary-foreground',
      '--muted',
      '--muted-foreground',
      '--destructive',
      '--warning',
      '--border',
      '--input',
      '--ring',
      '--sidebar',
      '--sidebar-foreground',
      '--sidebar-border',
    ]
    const dark = CONSOLE_CSS.slice(
      CONSOLE_CSS.indexOf('@media (prefers-color-scheme: dark)'),
    )
    for (const token of tokens) {
      // Defined in the light block…
      expect(CONSOLE_CSS).toContain(`${token}:`)
      // …and redefined in the dark one, so no colour has a single definition
      // that only happens to look right in one scheme.
      expect(dark).toContain(`${token}:`)
    }
    // Values copied verbatim from the shadcn reference palette.
    expect(CONSOLE_CSS).toContain('--primary: oklch(0.488 0.243 264.376);')
    expect(dark).toContain('--primary: oklch(0.424 0.199 265.638);')
    expect(CONSOLE_CSS).toContain('--radius: 0.625rem;')
    // Dark is designed rather than inverted: the border is 10% white, not a
    // darkened grey, and the card surface is a step lighter than the page
    // background rather than matching it.
    expect(dark).toContain('--border: oklch(1 0 0 / 10%);')
    expect(dark).toContain('--card: oklch(0.205 0 0);')
    expect(dark).toContain('--background: oklch(0.145 0 0);')
    expect(CONSOLE_CSS).toContain('color-scheme: light dark;')
  })
})

// ---------------------------------------------------------------------------

/**
 * Wording and restraint, as gates rather than as taste.
 *
 * These four are the ones a reviewer would otherwise have to re-check by eye
 * every time somebody adds a field. Turning them into assertions is the only
 * way a copy rule survives the third person to touch the file.
 */
describe('copy discipline', () => {
  const rendered = renderPage({
    label: 'node-a',
    now: NOW,
    roster: renderRoster([agent()], null, NOW, TTL),
    audit: renderAudit(
      page({ intact: false, issueCount: 2, total: 9 }),
      null,
      NO_FILTER,
    ),
    limits: renderLimits(LIMITS),
    wakeEnabled: true,
    auditFilter: NO_FILTER,
  })

  /** Visible text only: markup, attributes, the inline style and script out. */
  function visibleText(html: string): string {
    return html
      .replace(/<style>[\s\S]*?<\/style>/g, '')
      .replace(/<script>[\s\S]*?<\/script>/g, '')
      .replace(/<[^>]*>/g, ' ')
  }

  test('the word 花名册 is gone, along with its neighbours', () => {
    for (const banned of [
      '花名册',
      '智能体花名册',
      '常驻节点',
      '审计与消息链',
    ]) {
      expect(rendered).not.toContain(banned)
    }
  })

  test('section headings are bare nouns', () => {
    const text = visibleText(rendered)
    for (const heading of ['节点', '消息链', '限额', '唤醒']) {
      expect(text).toContain(heading)
    }
  })

  test('no explanatory sentences anywhere on the page', () => {
    // A crude but unambiguous rule: nothing on screen ends a sentence, and
    // nothing on screen joins two clauses with a comma either — the page
    // separates with `·`, which cannot carry a subordinate clause after it.
    // The two states allowed a line of their own (empty, disabled) are one
    // clause each, so they pass both halves.
    const text = visibleText(rendered)
    expect(text).not.toContain('。')
    expect(text).not.toContain('，')
    expect(text).not.toContain('、')
  })

  test('an action and its result are the same word', () => {
    // 注册 → 已注册, 注销 → 已注销, 唤醒 → 已唤醒. Nothing says 提交 or 确定,
    // which name the gesture instead of the outcome.
    for (const pair of [
      ['>注册</button>', '已注册 '],
      ['data-action="deregister"', '已注销 '],
      ['>唤醒</button>', '已唤醒 · '],
    ]) {
      expect(rendered).toContain(pair[0] as string)
      expect(rendered).toContain(pair[1] as string)
    }
    expect(visibleText(rendered)).not.toContain('提交')
    expect(visibleText(rendered)).not.toContain('确定')
  })

  test('a failure names the thing, what happened to it, then the detail', () => {
    const html = renderRoster(
      null,
      { code: 'unreachable', message: '连接被拒绝' },
      NOW,
      TTL,
    )
    expect(html).toContain('注册中心不可达 · 连接被拒绝')
    expect(html).toContain('unreachable')

    const trail = renderAudit(
      null,
      { code: 'not_found', message: '文件不存在' },
      NO_FILTER,
    )
    expect(trail).toContain('审计日志未找到 · 文件不存在')
  })

  test('the empty state is an invitation, not a status', () => {
    const empty = renderRoster([], null, NOW, TTL)
    expect(empty).toContain('还没有节点 · ')
    expect(empty).toContain('在下面注册第一个')
    expect(empty).not.toContain('暂无')
  })

  test('no emoji and no pictographs', () => {
    expect(visibleText(rendered)).not.toMatch(/\p{Extended_Pictographic}/u)
  })

  test('no off-origin reference of any kind', () => {
    expect(rendered).not.toContain('http://')
    expect(rendered).not.toContain('https://')
    expect(rendered).not.toContain('<link')
    expect(rendered).not.toContain('<iframe')
  })

  test('the disabled wake face keeps its one allowed line', () => {
    const disabled = renderPage({
      label: 'node-a',
      now: NOW,
      roster: renderRoster([], null, NOW, TTL),
      audit: renderAudit(page(), null, NO_FILTER),
      limits: renderLimits(LIMITS),
      wakeEnabled: false,
      auditFilter: NO_FILTER,
    })
    // What is unavailable, and the exact name of the thing to go and set.
    expect(disabled).toContain('唤醒不可用 · 未设置 QIANMO_TRANSPORT_PSK')
    expect(visibleText(disabled)).not.toContain('。')
  })
})
