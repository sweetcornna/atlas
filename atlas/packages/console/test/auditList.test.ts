// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 消息链 as a list (D5) and its poll (G2): newest first, a page at a time,
 * 加载更早 that neither repeats nor skips, one search box, and a poll that
 * carries what arrived instead of the page again.
 *
 * The audit port here pages the way the host's does — the same
 * `pageTrail` over records in memory — so the page is exercised against the
 * cursor semantics it will meet, and the trail can grow between requests.
 * The host's own port is tested on a real file in
 * `packages/node/test/commands/consoleAuditPaging.test.ts`.
 */

import { describe, expect, test } from 'bun:test'
import {
  AuditSource,
  pageTrail,
  type AuditRecord,
  type MessageChain,
  type TrailQuery,
} from '@qianmo/audit'
import type {
  AuditFilter,
  AuditPage,
  AuditPort,
  ConsoleAuditSource,
  ConsoleResult,
} from '../src/deps.js'
import { createConsoleHandler } from '../src/http.js'
import {
  ADMIN,
  LIMITS,
  NOW,
  PageRegistry,
  TOKENS,
  VIEW,
  browse,
  visibleText,
  withoutScripts,
} from './pageHarness.js'

const SOURCES = [
  AuditSource.Transport,
  AuditSource.Router,
  AuditSource.Resident,
] as const
const OUTCOMES = ['ok', 'refused', 'dropped'] as const

/** A port over records in memory that pages exactly as `createAuditPort` does. */
class PagedAudit implements AuditPort {
  records: AuditRecord[] = []
  readonly filters: AuditFilter[] = []

  constructor(
    count: number,
    readonly prefix = 'k',
  ) {
    this.append(count)
  }

  /** `count` more records, each with a kind that names its seq. */
  append(count: number): void {
    for (let index = 0; index < count; index++) {
      const seq = this.records.length + 1
      this.records.push({
        seq,
        at: NOW - 1_000_000 + seq,
        source: SOURCES[seq % 3] ?? AuditSource.Router,
        kind: `${this.prefix}-${seq}`,
        outcome: OUTCOMES[seq % 3] ?? 'ok',
        traceId: `00-${String(seq % 7).padStart(32, '0')}-00f067aa0ba902b7-01`,
        node: seq % 10 === 0 ? 'needle-node' : 'node-a',
        prev: '0'.repeat(64),
      })
    }
  }

  read(filter: AuditFilter): Promise<ConsoleResult<AuditPage>> {
    this.filters.push(filter)
    const query: TrailQuery = {
      ...(filter.outcome === undefined
        ? {}
        : { outcome: filter.outcome as AuditRecord['outcome'] }),
      ...(filter.q === undefined ? {} : { text: filter.q }),
    }
    const page = pageTrail(this.records, query, {
      limit: filter.limit ?? 200,
      ordered: true,
      ...(filter.before === undefined ? {} : { before: filter.before }),
      ...(filter.since === undefined ? {} : { after: filter.since }),
    })
    return Promise.resolve({
      ok: true,
      value: {
        records: page.records,
        chain: this.records.length === 0 ? 'empty' : 'intact',
        intact: true,
        issueCount: 0,
        total: this.records.length,
        head: this.records.at(-1)?.seq ?? 0,
        earlier: page.earlier,
      },
    })
  }

  chain(): Promise<ConsoleResult<MessageChain | null>> {
    return Promise.resolve({ ok: true, value: null })
  }
}

function console_(audit: PagedAudit, audits?: readonly ConsoleAuditSource[]) {
  return createConsoleHandler(
    {
      registry: new PageRegistry(),
      audit,
      ...(audits === undefined ? {} : { audits }),
      limits: LIMITS,
      now: () => NOW,
    },
    TOKENS,
  )
}

async function text(
  handle: (request: Request) => Promise<Response>,
  path: string,
  token = VIEW,
): Promise<string> {
  const response = await handle(browse(path, token))
  expect(`${path} ${response.status}`).toBe(`${path} 200`)
  return await response.text()
}

/** The seqs of the rows in one `<tbody>` (by id), in the order drawn. */
function seqsIn(html: string, id: string, prefix = 'k'): number[] {
  const start = html.indexOf(`id="${id}"`)
  if (start === -1) return []
  const end = html.indexOf('</tbody>', start)
  const body = html.slice(start, end)
  return [...body.matchAll(new RegExp(`>${prefix}-(\\d+)<`, 'g'))].map(match =>
    Number(match[1]),
  )
}

/** An attribute of the first element carrying `marker`. */
function attrOf(html: string, marker: string, name: string): string | null {
  const at = html.indexOf(marker)
  if (at === -1) return null
  const open = html.lastIndexOf('<', at)
  const close = html.indexOf('>', at)
  const tag = html.slice(open, close)
  const match = new RegExp(`${name}="([^"]*)"`).exec(tag)
  return match === null ? null : (match[1] ?? '').replaceAll('&amp;', '&')
}

describe('the trail page lists newest first, one page at a time (D5)', () => {
  test('the first screen is the newest 50, newest on top', async () => {
    const audit = new PagedAudit(500)
    const handle = console_(audit)
    const html = await text(handle, '/audit')
    const seqs = seqsIn(html, 'audit-rows')
    expect(seqs).toHaveLength(50)
    expect(seqs[0]).toBe(500)
    expect(seqs.at(-1)).toBe(451)
    // The port was asked for one page, not the API's 200.
    expect(audit.filters.at(-1)?.limit).toBe(50)
  })

  test('加载更早 walks every record exactly once, appends meanwhile shift nothing', async () => {
    const audit = new PagedAudit(173)
    const handle = console_(audit)
    let path = '/audit'
    const seen: number[] = []
    for (let pages = 0; pages < 20; pages++) {
      const html = await text(handle, path)
      seen.push(...seqsIn(html, 'audit-rows'))
      // Lines arriving between two pages land above every cursor handed out.
      if (pages === 0) audit.append(9)
      const next = attrOf(html, 'data-action="audit-earlier"', 'href')
      if (next === null) {
        expect(html).toContain('已是最早的记录')
        break
      }
      // The link and the fragment the script fetches are the same view.
      expect(attrOf(html, 'data-action="audit-earlier"', 'data-fragment')).toBe(
        next.replace('/audit?', '/fragments/audit?'),
      )
      path = next
    }
    expect(seen).toEqual(Array.from({ length: 173 }, (_, index) => 173 - index))
  })

  test('the script fetches the same page as a fragment, rows under the same ids', async () => {
    const audit = new PagedAudit(120)
    const handle = console_(audit)
    const first = await text(handle, '/audit')
    const fragment = attrOf(
      first,
      'data-action="audit-earlier"',
      'data-fragment',
    )
    expect(fragment).toBe('/fragments/audit?before=71')
    const more = await (
      await handle(
        new Request(`http://console.test${fragment}`, {
          headers: { authorization: `Bearer ${VIEW}` },
        }),
      )
    ).text()
    expect(seqsIn(more, 'audit-rows')).toEqual(
      Array.from({ length: 50 }, (_, index) => 70 - index),
    )
    expect(attrOf(more, 'data-action="audit-earlier"', 'href')).toBe(
      '/audit?before=21',
    )
    // An older page has no body for new rows: they belong on the newest one.
    expect(more).not.toContain('id="audit-fresh"')
  })

  test('one search box: it narrows the list, keeps its value, and rides along with the cursor', async () => {
    const audit = new PagedAudit(300)
    const handle = console_(audit)
    const html = await text(handle, '/audit?q=NEEDLE')
    const seqs = seqsIn(html, 'audit-rows')
    expect(seqs.length).toBe(30)
    expect(seqs.every(seq => seq % 10 === 0)).toBe(true)
    expect(seqs[0]).toBe(300)
    expect(html).toContain('name="q" value="NEEDLE"')
    expect(html).toContain('<span class="chip mono">q NEEDLE</span>')
    expect(audit.filters.at(-1)?.q).toBe('NEEDLE')
    // Thirty matches is one page: nothing older, and the poll keeps the box.
    expect(html).toContain('已是最早的记录')
    expect(attrOf(html, 'id="audit" ', 'data-poll')).toBe(
      '/fragments/audit?q=NEEDLE&since=300',
    )
  })

  test('the time segment says 全部 when there is no window, 自定义 only for a range', async () => {
    const handle = console_(new PagedAudit(3))
    const open = await text(handle, '/audit')
    expect(open).toContain('name="window" value="" checked>全部')
    const ranged = await text(handle, '/audit?from=1000&to=2000')
    expect(ranged).toContain('name="window" value="" checked>自定义')
  })
})

describe('the poll carries what arrived, not the page again (G2)', () => {
  test('the page polls since its head and swaps only the header and the fresh rows', async () => {
    const audit = new PagedAudit(80)
    const handle = console_(audit)
    const page = await text(handle, '/audit')
    expect(attrOf(page, 'id="audit" ', 'data-poll')).toBe(
      '/fragments/audit?since=80',
    )
    expect(attrOf(page, 'id="audit" ', 'data-swap')).toBe(
      'audit-rail audit-fresh',
    )
    expect(page).toContain(
      '<tbody class="trail-fresh" id="audit-fresh"></tbody>',
    )

    // Nothing arrived: the answer is the header and an empty body.
    const quiet = await text(handle, '/fragments/audit?since=80')
    expect(quiet).toContain('id="audit-rail"')
    expect(seqsIn(quiet, 'audit-fresh')).toEqual([])
    expect(quiet).not.toContain('id="audit-filter"')
    expect(quiet).not.toContain('id="audit-rows"')

    audit.append(3)
    const news = await text(handle, '/fragments/audit?since=80')
    expect(seqsIn(news, 'audit-fresh')).toEqual([83, 82, 81])
    expect(news).toContain('<span class="total">83</span>')
    // The rows already on the page are not sent again.
    expect(news).not.toContain('>k-80<')
    // …and the whole page would have been a few times the size.
    const whole = await text(handle, '/fragments/audit')
    expect(news.length * 4).toBeLessThan(whole.length)

    // The cursor never moves: the next poll still answers since the page was drawn.
    audit.append(1)
    const later = await text(handle, '/fragments/audit?since=80')
    expect(seqsIn(later, 'audit-fresh')).toEqual([84, 83, 82, 81])
  })

  test('more than a page since, or a shorter trail: a reload link instead of a guess', async () => {
    const audit = new PagedAudit(10)
    const handle = console_(audit)
    audit.append(60)
    const burst = await text(handle, '/fragments/audit?q=k&since=10')
    expect(seqsIn(burst, 'audit-fresh')).toHaveLength(50)
    expect(burst).toContain(
      '新记录超过一页 · <a href="/audit?q=k" data-nav>重新载入</a>',
    )

    audit.records = audit.records.slice(0, 5)
    const shorter = await text(handle, '/fragments/audit?since=10')
    expect(seqsIn(shorter, 'audit-fresh')).toEqual([])
    expect(shorter).toContain('链比载入时短 · 可能被改写或换了文件')
  })

  test('an older page polls its header only', async () => {
    const handle = console_(new PagedAudit(200))
    const older = await text(handle, '/audit?before=100')
    expect(attrOf(older, 'id="audit" ', 'data-swap')).toBe('audit-rail')
    expect(older).not.toContain('id="audit-fresh"')
    expect(seqsIn(older, 'audit-rows')[0]).toBe(99)
  })

  test('an empty trail keeps a hidden table for the first row to land in', async () => {
    const audit = new PagedAudit(0)
    const handle = console_(audit)
    const page = await text(handle, '/audit')
    expect(page).toContain('这条链还没有记录')
    expect(page).toContain('<div class="scroll fresh-only">')
    expect(attrOf(page, 'id="audit" ', 'data-poll')).toBe(
      '/fragments/audit?since=0',
    )
    audit.append(2)
    const first = await text(handle, '/fragments/audit?since=0')
    expect(seqsIn(first, 'audit-fresh')).toEqual([2, 1])
  })

  test('a port that does not page is polled whole, as before', async () => {
    // `PageAudit` in the shared harness answers without `head`.
    const { pageHarness } = await import('./pageHarness.js')
    const h = pageHarness()
    const page = await (await h.handle(browse('/audit', VIEW))).text()
    expect(attrOf(page, 'id="audit" ', 'data-poll')).toBe('/fragments/audit')
    expect(attrOf(page, 'id="audit" ', 'data-swap')).toBe(
      'audit-rail audit-results',
    )
  })
})

describe('several trails', () => {
  function several() {
    const a = new PagedAudit(120, 'a')
    const b = new PagedAudit(30, 'b')
    const audits: ConsoleAuditSource[] = [
      { node: 'tokyo-1', audit: a, kind: 'authoritative' },
      { node: 'osaka.1', audit: b, kind: 'mirror', maxLagMinutes: 5 },
    ]
    return { a, b, handle: console_(new PagedAudit(0), audits) }
  }

  test('each trail polls since its own head, and pages back through node=', async () => {
    const { a, b, handle } = several()
    const page = await text(handle, '/audit')
    expect(attrOf(page, 'id="audit" ', 'data-poll')).toBe(
      '/fragments/audit?since=tokyo-1%3A120&since=osaka.1%3A30',
    )
    expect(attrOf(page, 'id="audit" ', 'data-swap')).toBe(
      'audit-rail audit-fresh-0 audit-fresh-1',
    )
    expect(seqsIn(page, 'audit-rows-0', 'a')[0]).toBe(120)
    expect(seqsIn(page, 'audit-rows-1', 'b')[0]).toBe(30)
    const more = attrOf(page, 'data-slot="0"', 'href')
    expect(more).toBe('/audit?before=71&node=tokyo-1')

    a.append(2)
    b.append(1)
    const news = await text(
      handle,
      '/fragments/audit?since=tokyo-1%3A120&since=osaka.1%3A30',
    )
    expect(seqsIn(news, 'audit-fresh-0', 'a')).toEqual([122, 121])
    expect(seqsIn(news, 'audit-fresh-1', 'b')).toEqual([31])

    // The older page of one trail keeps that trail's slot, so the script's
    // ids still find its table on the page it came from.
    const older = await text(handle, more ?? '')
    expect(seqsIn(older, 'audit-rows-0', 'a')[0]).toBe(70)
    expect(older).not.toContain('audit-rows-1')
  })

  test('a node that is not configured is a 404 page, not an empty list', async () => {
    const { handle } = several()
    const response = await handle(browse('/audit?node=nowhere', VIEW))
    expect(response.status).toBe(404)
    expect(await response.text()).toContain('未配置该审计节点')
  })
})

describe('reading without script, and the copy', () => {
  test('rows and 加载更早 are in the markup; the link is a link', async () => {
    const handle = console_(new PagedAudit(120))
    const bare = withoutScripts(await text(handle, '/audit'))
    expect(bare).not.toContain('<script')
    expect(seqsIn(bare, 'audit-rows')).toHaveLength(50)
    expect(bare).toContain(
      '<a class="btn btn-secondary" href="/audit?before=71"',
    )
    expect(bare).toContain('<form id="audit-filter" method="get">')
  })

  test('no 。，、 no exclamation, no emoji, on any state of the list', async () => {
    const audit = new PagedAudit(70)
    const handle = console_(audit)
    audit.append(60)
    const pages = [
      await text(handle, '/audit'),
      await text(handle, '/audit?before=20'),
      await text(handle, '/audit?q=nothing-matches-this'),
      await text(handle, '/fragments/audit?since=70'),
      await text(handle, '/fragments/audit?since=500'),
      await text(handle, '/audit', ADMIN),
    ]
    for (const html of pages) {
      const visible = visibleText(html)
      for (const banned of ['。', '，', '、', '！', '!']) {
        expect(visible.includes(banned)).toBe(false)
      }
      expect(visible).not.toMatch(/\p{Extended_Pictographic}/u)
    }
  })
})
