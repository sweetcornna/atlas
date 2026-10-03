// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 告警 (J5): the inbox, the unread badge, the level filter and
 * acknowledgement — P18.15's first completion criterion, through the router
 * as a browser and a script reach it, plus the rules that decide what goes
 * into the inbox in the first place.
 */

import { describe, expect, test } from 'bun:test'
import type { AlertBoard } from '../src/view/alerts.js'
import { alertBoard } from '../src/view/alerts.js'
import type { AuditPage, ConsoleAgent, ConsoleResult } from '../src/deps.js'
import { MemoryActionLedger } from './memoryActions.js'
import {
  ADMIN,
  AGENTS,
  NOW,
  VIEW,
  agentAt,
  browse,
  call,
} from './pageHarness.js'
import { LOST_OSAKA, MemoryNotify, notice, watchConsole } from './watchFakes.js'

function ok<T>(value: T): ConsoleResult<T> {
  return { ok: true, value }
}

/** The number in the badge, read off the markup the server sent. */
function badgeOf(html: string): number {
  const match = /id="alerts-unread" data-unread="(\d+)"/.exec(html)
  if (match === null || match[1] === undefined) throw new Error('no badge')
  return Number(match[1])
}

/** The ids of the rows on the page, in order. */
function rowsOf(html: string): readonly string[] {
  return [...html.matchAll(/<li class="alert-row" data-key="([^"]+)"/g)].map(
    match => match[1] ?? '',
  )
}

/** A console with two notices and one lost node: three unread alerts. */
function inbox() {
  const notify = new MemoryNotify([
    notice('n:disk', 'error', '根分区使用率 95%'),
    notice('n:done', 'info', '巡检完成', { at: NOW - 120_000 }),
  ])
  const actions = new MemoryActionLedger()
  const c = watchConsole({ notify, actions })
  c.page.registry.listResult = ok([...AGENTS.slice(0, 2), LOST_OSAKA])
  return { ...c, notify, actions }
}

async function page(
  handle: (request: Request) => Promise<Response>,
  path: string,
  token = ADMIN,
): Promise<string> {
  const response = await handle(browse(path, token))
  expect(`${path} ${response.status}`).toBe(`${path} 200`)
  return await response.text()
}

describe('the inbox', () => {
  test('lists notices and conditions together, strongest first, with the unread badge', async () => {
    const { handle } = inbox()
    const html = await page(handle, '/alerts')
    expect(badgeOf(html)).toBe(3)
    // The two errors before the info; between them the newer first: the
    // notice came in 60 s ago, the lease lapsed 310 s ago.
    expect(rowsOf(html)).toEqual([
      'n:disk',
      `node-lost:osaka-1:${NOW - 400_000}`,
      'n:done',
    ])
    expect(html).toContain('根分区使用率 95%')
    expect(html).toContain('节点失联 · osaka-1')
    expect(html).toContain('来自 qianmo://tokyo-1/reviewer · 作业 disk-watch')
  })

  test('the level filter narrows the list and leaves the badge counting every unread alert', async () => {
    const { handle } = inbox()
    const errors = await page(handle, '/alerts?level=error')
    expect(rowsOf(errors)).toEqual([
      'n:disk',
      `node-lost:osaka-1:${NOW - 400_000}`,
    ])
    expect(badgeOf(errors)).toBe(3)
    const infos = await page(handle, '/alerts?level=info')
    expect(rowsOf(infos)).toEqual(['n:done'])
    expect(await page(handle, '/alerts?level=warn')).toContain(
      '没有未确认的警告级告警',
    )
    // The checked radio is the filter in force, so the form reproduces it.
    expect(errors).toContain('name="level" value="error" checked')
    // An unknown level is a stale bookmark, not an error: the whole inbox.
    expect(rowsOf(await page(handle, '/alerts?level=loud'))).toHaveLength(3)
  })

  test('acknowledging one changes the badge, and moves it from 未确认 to 已确认', async () => {
    const { handle, notify } = inbox()
    expect(badgeOf(await page(handle, '/alerts'))).toBe(3)

    const response = await handle(
      call('POST', '/v0/alerts/n%3Adisk/ack', ADMIN),
    )
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      ack: { id: string; at: number }
      unread: number
    }
    expect(body).toEqual({ ack: { id: 'n:disk', at: NOW }, unread: 2 })
    expect(notify.stored.get('n:disk')?.by).toBe('legacy:admin')

    const after = await page(handle, '/alerts')
    expect(badgeOf(after)).toBe(2)
    expect(rowsOf(after)).not.toContain('n:disk')
    const acked = await page(handle, '/alerts?state=acked')
    expect(rowsOf(acked)).toEqual(['n:disk'])
    expect(acked).toContain('已确认 <time')
    expect(acked).not.toContain('data-alert="n:disk"')
    expect(rowsOf(await page(handle, '/alerts?state=all'))).toHaveLength(3)
  })

  test('acknowledging twice keeps the first one', async () => {
    const { handle, notify, deps } = inbox()
    await handle(call('POST', '/v0/alerts/n%3Adone/ack', ADMIN))
    const first = notify.stored.get('n:done')
    const later = watchConsole({ ...deps, now: () => NOW + 5_000 })
    const again = await later.handle(
      call('POST', '/v0/alerts/n%3Adone/ack', ADMIN),
    )
    expect(again.status).toBe(200)
    expect(notify.stored.get('n:done')).toEqual(first)
    expect(((await again.json()) as { unread: number }).unread).toBe(2)
  })

  test('the JSON list carries the same filter and the same count', async () => {
    const { handle } = inbox()
    const response = await handle(call('GET', '/v0/alerts?level=info', VIEW))
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      unread: number
      total: number
      alerts: { id: string; level: string }[]
      sources: { label: string; text: string }[]
    }
    expect(body.unread).toBe(3)
    expect(body.total).toBe(3)
    expect(body.alerts.map(alert => alert.id)).toEqual(['n:done'])
    expect(body.sources.map(source => source.label)).toContain('链路')
  })

  test('the fragment the page polls is the inbox, with its badge', async () => {
    const { handle } = inbox()
    const response = await handle(
      call('GET', '/fragments/alerts?level=error', VIEW),
    )
    expect(response.status).toBe(200)
    const html = await response.text()
    expect(html.startsWith('<div class="sec-head" id="alerts-head"')).toBe(true)
    expect(badgeOf(html)).toBe(3)
    expect(rowsOf(html)).toHaveLength(2)
    const pageHtml = await page(handle, '/alerts?level=error')
    expect(pageHtml).toContain('data-poll="/fragments/alerts?level=error"')
  })
})

describe('acknowledging is a guarded write', () => {
  test('an id that is not in the inbox is refused, recorded, and never stored', async () => {
    const { handle, notify, actions } = inbox()
    const response = await handle(call('POST', '/v0/alerts/made-up/ack', ADMIN))
    expect(response.status).toBe(404)
    expect(notify.ackCalls).toBe(0)
    expect(actions.lines()).toEqual(['alert.ack made-up refused not_found'])
  })

  test('a done acknowledgement is one ledger entry naming the alert', async () => {
    const { handle, actions } = inbox()
    await handle(call('POST', '/v0/alerts/n%3Adisk/ack', ADMIN))
    expect(actions.lines()).toEqual(['alert.ack n:disk ok'])
    expect(actions.entries[0]?.subject).toBe('legacy:admin')
  })

  test('a ledger that cannot write stops it before the store is touched', async () => {
    const { handle, notify, actions } = inbox()
    actions.admitResult = {
      ok: false,
      failure: { code: 'unreachable', message: 'ledger closed' },
    }
    const response = await handle(
      call('POST', '/v0/alerts/n%3Adisk/ack', ADMIN),
    )
    expect(response.status).toBe(503)
    expect(notify.ackCalls).toBe(0)
    expect(actions.entries).toHaveLength(0)
  })

  test('only POST, and an id that does not decode is input, not a 500', async () => {
    const { handle, notify } = inbox()
    expect(
      (await handle(call('GET', '/v0/alerts/n%3Adisk/ack', ADMIN))).status,
    ).toBe(405)
    expect(
      (await handle(call('POST', '/v0/alerts/%E0%A4%A/ack', ADMIN))).status,
    ).toBe(400)
    expect(
      (await handle(call('POST', `/v0/alerts/${'x'.repeat(300)}/ack`, ADMIN)))
        .status,
    ).toBe(400)
    expect(notify.ackCalls).toBe(0)
  })

  test('a view token is refused at the role gate, before anything else', async () => {
    const { handle, notify, actions } = inbox()
    const response = await handle(call('POST', '/v0/alerts/n%3Adisk/ack', VIEW))
    expect(response.status).toBe(403)
    expect(notify.ackCalls).toBe(0)
    expect(actions.entries).toHaveLength(0)
  })
})

describe('without a notify port, and with one that fails', () => {
  test('the conditions are still listed, and the page says what is missing', async () => {
    const c = watchConsole()
    c.page.registry.listResult = ok([...AGENTS.slice(0, 2), LOST_OSAKA])
    const html = await page(c.handle, '/alerts')
    expect(rowsOf(html)).toEqual([`node-lost:osaka-1:${NOW - 400_000}`])
    expect(html).toContain('未接入 · 控制台没有读取值守进程的通知')
    expect(html).toContain('未接入 · 确认无处记录')
    // No store, no button: a confirmation with nowhere to go would be lost.
    expect(html).not.toContain('data-action="alert-ack"')
    const ack = await c.handle(
      call(
        'POST',
        `/v0/alerts/node-lost%3Aosaka-1%3A${NOW - 400_000}/ack`,
        ADMIN,
      ),
    )
    expect(ack.status).toBe(501)
  })

  test('acknowledgements that cannot be read: everything reads unread and nothing can be acknowledged', async () => {
    const { handle, notify } = inbox()
    notify.stored.set('n:done', { id: 'n:done', at: NOW, by: 'legacy:admin' })
    notify.acksFailure = {
      ok: false,
      failure: { code: 'unreachable', message: 'acks unreadable' },
    }
    const html = await page(handle, '/alerts')
    expect(badgeOf(html)).toBe(3)
    expect(html).toContain('确认记录读不出来 · 全部按未确认显示')
    expect(html).not.toContain('data-action="alert-ack"')
    const response = await handle(
      call('POST', '/v0/alerts/n%3Adisk/ack', ADMIN),
    )
    expect(response.status).toBe(503)
    expect(notify.ackCalls).toBe(0)
  })

  test('notices that cannot be read: the conditions stay, the source says so', async () => {
    const { handle, notify } = inbox()
    notify.noticesFailure = {
      ok: false,
      failure: { code: 'unreachable', message: 'trail unreadable' },
    }
    const html = await page(handle, '/alerts')
    expect(rowsOf(html)).toEqual([`node-lost:osaka-1:${NOW - 400_000}`])
    expect(html).toContain(
      '<span class="k">通知</span><span class="tone-bad">读取失败</span>',
    )
  })

  test('a trail that does not verify still lists its notices, under a warning', async () => {
    const { handle, notify } = inbox()
    notify.intact = false
    const html = await page(handle, '/alerts')
    expect(rowsOf(html)).toContain('n:disk')
    expect(html).toContain('通知所在的中枢审计链校验不过')
  })

  test('a hub trail that does not exist yet is said, not shown as zero notices', async () => {
    const { handle, notify } = inbox()
    notify.list = []
    notify.present = false
    const html = await page(handle, '/alerts')
    expect(html).toContain(
      '已接入 · 中枢审计链尚未建立 · 值守进程没有在这个配置根上运行过',
    )
    notify.present = true
    expect(await page(handle, '/alerts')).toContain(
      '<span class="k">通知</span><span class="tone-ok">已接入 · 0 条</span>',
    )
  })

  test('a registry that cannot be read is stated above the inbox', async () => {
    const { handle, page: harness } = inbox()
    harness.registry.listResult = {
      ok: false,
      failure: { code: 'unreachable', message: 'registry down' },
    }
    const html = await page(handle, '/alerts')
    expect(html).toContain('注册中心不可达 · registry down')
    expect(html).toContain(
      '<span class="k">注册中心</span><span class="tone-bad">不可达</span>',
    )
  })
})

// ---------------------------------------------------------------------------
// What goes into the inbox
// ---------------------------------------------------------------------------

const PAGE_OK: AuditPage = {
  records: [],
  chain: 'intact',
  intact: true,
  issueCount: 0,
  total: 0,
}

function board(
  over: Partial<Parameters<typeof alertBoard>[0]> = {},
): AlertBoard {
  return alertBoard({
    now: NOW,
    ttlMs: 90_000,
    roster: ok(AGENTS),
    audits: [{ node: 'tokyo-1', page: PAGE_OK, failure: null }],
    ...over,
  })
}

function summary(alerts: AlertBoard['alerts']): readonly string[] {
  return alerts.map(alert => `${alert.level} ${alert.title}`)
}

describe('conditions', () => {
  test('a healthy network raises nothing, and every source still says it is there', () => {
    const quiet = board()
    expect(quiet.alerts).toEqual([])
    expect(quiet.unread).toBe(0)
    expect(
      quiet.sources.map(source => `${source.label} ${source.text}`),
    ).toEqual([
      '通知 未接入 · 控制台没有读取值守进程的通知',
      '注册中心 已接入',
      '证书 未配置',
      '审计链 已接入 · 1 条',
      '链路 未接入 · 控制台没有节点连通探测的数据',
      '确认 未接入 · 确认无处记录',
    ])
  })

  test('a node is lost when every agent on it is past its lease, not one of them', () => {
    const half: readonly ConsoleAgent[] = [
      agentAt('qianmo://tokyo-1/planner'),
      agentAt('qianmo://tokyo-1/reviewer', {
        lastHeartbeatAt: NOW - 400_000,
        expiresAt: NOW - 310_000,
      }),
    ]
    expect(board({ roster: ok(half) }).alerts).toEqual([])
    const gone = board({ roster: ok([LOST_OSAKA]) }).alerts
    expect(summary(gone)).toEqual(['error 节点失联 · osaka-1'])
    expect(gone[0]?.detail).toBe('最后心跳 6 分钟前')
  })

  test('a node that comes back and goes quiet again is a new, unread alert', () => {
    const first = board({ roster: ok([LOST_OSAKA]) }).alerts[0]
    const again = board({
      roster: ok([
        agentAt('qianmo://osaka-1/writer', {
          lastHeartbeatAt: NOW - 200_000,
          expiresAt: NOW - 110_000,
        }),
      ]),
      acks: ok([{ id: first?.id ?? '', at: NOW - 1, by: 'legacy:admin' }]),
    })
    expect(again.alerts[0]?.id).not.toBe(first?.id)
    expect(again.unread).toBe(1)
  })

  test('certificates, the revocation list and the CA roots, each at its level', () => {
    const raised = board({
      certificates: {
        snapshot: ok({
          certificates: [
            { node: 'a', status: 'valid', notAfter: NOW + 90 * 86_400_000 },
            { node: 'b', status: 'expiring', notAfter: NOW + 10 * 86_400_000 },
            {
              node: 'c',
              status: 'expiring-urgent',
              notAfter: NOW + 86_400_000,
            },
            { node: 'd', status: 'expired', notAfter: NOW - 86_400_000 },
            { node: 'e', status: 'revoked', notAfter: NOW + 86_400_000 },
            { node: 'f', status: 'bad-signature' },
            { node: 'g', status: 'absent' },
          ],
          revocationList: null,
        }),
        roots: [
          {
            subject: 'Qianmo CA',
            notAfter: NOW + 5 * 86_400_000,
            status: 'expiring-urgent',
          },
        ],
      },
    })
    expect([...summary(raised.alerts)].sort()).toEqual(
      [
        'warn 证书将到期 · b',
        'error 证书7 天内到期 · c',
        'error 证书已过期 · d',
        'warn 证书已吊销 · e',
        'error 证书签名不符 · f',
        'info 证书未发布 · g',
        'warn 吊销清单未发布',
        'error CA 根7 天内到期 · Qianmo CA',
      ].sort(),
    )
    // Strongest first.
    expect(raised.alerts.map(alert => alert.level)).toEqual([
      'error',
      'error',
      'error',
      'error',
      'warn',
      'warn',
      'warn',
      'info',
    ])
    expect(raised.sources.find(source => source.label === '证书')?.text).toBe(
      '已接入',
    )
  })

  test('a revocation list past its next update is an error with that instant', () => {
    const stale = board({
      certificates: {
        snapshot: ok({
          certificates: [],
          revocationList: {
            issuedAt: NOW - 8 * 86_400_000,
            nextUpdate: NOW - 86_400_000,
            revokedCount: 1,
          },
        }),
        roots: [],
      },
    })
    expect(summary(stale.alerts)).toEqual(['error 吊销清单已过期'])
    expect(stale.alerts[0]?.at).toBe(NOW - 86_400_000)
  })

  test('a trail that breaks, one that never arrived and an anchor that disagrees', () => {
    const raised = board({
      audits: [
        {
          node: 'tokyo-1',
          page: { ...PAGE_OK, chain: 'broken', intact: false, issueCount: 2 },
          failure: null,
        },
        {
          node: 'osaka-1',
          page: { ...PAGE_OK, chain: 'absent', intact: false },
          failure: null,
        },
        {
          node: 'kyoto-1',
          page: { ...PAGE_OK, witness: { tampered: true, stale: false } },
          failure: null,
        },
        {
          node: 'nara-1',
          page: { ...PAGE_OK, witness: { tampered: false, stale: true } },
          failure: null,
        },
        {
          node: 'kobe-1',
          page: null,
          failure: { code: 'unreachable', message: 'gone' },
        },
      ],
    })
    expect(summary(raised.alerts)).toEqual([
      'error 审计链断裂 · tokyo-1',
      'error 锚点不符 · kyoto-1',
      'warn 审计链未建立 · osaka-1',
    ])
    expect(raised.sources.find(source => source.label === '审计链')?.text).toBe(
      '5 条 · 1 条读取失败',
    )
  })

  test('a redelivered notice with the same message id is one alert', () => {
    const twice = board({
      notices: ok({
        notices: [
          notice('n:1', 'warn', '磁盘 91%', { redelivered: true }),
          notice('n:1', 'warn', '磁盘 91%'),
        ],
        total: 2,
        intact: true,
        present: true,
      }),
      acks: ok([]),
    })
    expect(twice.alerts).toHaveLength(1)
    expect(twice.alerts[0]?.detail).toContain('重发')
  })
})
