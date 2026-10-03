// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 告警 and 值守作业 as each kind of caller gets them (P18.15 criteria 3–5):
 *
 * - who sees what, and who is offered the one write control (acknowledge) —
 *   one HTTP case per principal: the legacy tokens, a viewer, a member, ops;
 * - every state either page can be in keeps the console's copy rules;
 * - with script off, both pages read completely and the filter still filters.
 */

import { describe, expect, test } from 'bun:test'
import type {
  AuditPage,
  ConsoleDeps,
  ConsoleResult,
  SchedulerSnapshot,
} from '../src/deps.js'
import { accountsHarness, asSession, person } from './accountsHarness.js'
import {
  ADMIN,
  AGENTS,
  NOW,
  VIEW,
  browse,
  call,
  visibleText,
  withoutScripts,
} from './pageHarness.js'
import {
  FixedScheduler,
  LOST_OSAKA,
  MemoryNotify,
  certificatesOf,
  notice,
  snapshotOf,
  unwiredSnapshotOf,
  watchConsole,
} from './watchFakes.js'

function ok<T>(value: T): ConsoleResult<T> {
  return { ok: true, value }
}

/** Does this markup let its reader change something? (`roles.test.ts`) */
function hasWriteControl(html: string): boolean {
  return /\sdata-write[\s>=]/.test(withoutScripts(html))
}

function freshNotify(): MemoryNotify {
  return new MemoryNotify([
    notice('n:disk', 'error', '根分区使用率 95%'),
    notice('n:done', 'info', '巡检完成'),
  ])
}

const ACK_PATH = '/v0/alerts/n%3Adisk/ack'

describe('who sees what (one case per principal)', () => {
  test('legacy tokens: the view token reads both pages and cannot acknowledge; the admin token can', async () => {
    const notify = freshNotify()
    const c = watchConsole({
      notify,
      scheduler: new FixedScheduler(snapshotOf()),
    })

    const viewAlerts = await (await c.handle(browse('/alerts', VIEW))).text()
    expect(viewAlerts).toContain('根分区使用率 95%')
    expect(hasWriteControl(viewAlerts)).toBe(false)
    expect(viewAlerts).toContain(
      '<span class="note" id="read-only">只读 · 写操作需要管理令牌</span>',
    )
    const viewJobs = await (await c.handle(browse('/jobs', VIEW))).text()
    expect(viewJobs).toContain('<tr data-key="disk-watch">')
    expect(hasWriteControl(viewJobs)).toBe(false)
    expect((await c.handle(call('POST', ACK_PATH, VIEW))).status).toBe(403)
    expect(notify.ackCalls).toBe(0)

    const adminAlerts = await (await c.handle(browse('/alerts', ADMIN))).text()
    expect(hasWriteControl(adminAlerts)).toBe(true)
    expect(adminAlerts).toContain('data-action="alert-ack" data-alert="n:disk"')
    expect(adminAlerts).not.toContain('id="read-only"')
    // The jobs page has no write control for anyone, the admin token included.
    expect(
      hasWriteControl(await (await c.handle(browse('/jobs', ADMIN))).text()),
    ).toBe(false)
    expect((await c.handle(call('POST', ACK_PATH, ADMIN))).status).toBe(200)
    expect(notify.stored.get('n:disk')?.by).toBe('legacy:admin')
  })

  async function asPerson(role: 'viewer' | 'member' | 'ops') {
    const notify = freshNotify()
    const scheduler = new FixedScheduler(snapshotOf())
    const h = accountsHarness({ deps: { notify, scheduler } })
    const who = await person(h.handle, role)
    const read = async (path: string) => {
      const response = await h.handle(
        asSession('GET', path, who.sid, { header: false, accept: 'text/html' }),
      )
      expect(`${role} ${path} ${response.status}`).toBe(`${role} ${path} 200`)
      return await response.text()
    }
    const ack = async () => await h.handle(asSession('POST', ACK_PATH, who.sid))
    return { notify, read, ack }
  }

  test('a viewer reads both pages and is offered nothing to press', async () => {
    const { notify, read, ack } = await asPerson('viewer')
    const alerts = await read('/alerts')
    expect(alerts).toContain('根分区使用率 95%')
    expect(hasWriteControl(alerts)).toBe(false)
    expect(alerts).toContain('只读 · 写操作需要运维角色')
    expect(hasWriteControl(await read('/jobs'))).toBe(false)
    expect((await ack()).status).toBe(403)
    expect(notify.ackCalls).toBe(0)
  })

  test('a member reads both pages and, like a viewer, cannot acknowledge', async () => {
    const { notify, read, ack } = await asPerson('member')
    const alerts = await read('/alerts')
    expect(alerts).toContain('巡检完成')
    expect(hasWriteControl(alerts)).toBe(false)
    expect(alerts).toContain('只读 · 写操作需要运维角色')
    expect((await read('/jobs')).includes('每十分钟看一次磁盘')).toBe(true)
    expect((await ack()).status).toBe(403)
    expect(notify.ackCalls).toBe(0)
  })

  test('ops is offered the button, and the acknowledgement is recorded under the person', async () => {
    const { notify, read, ack } = await asPerson('ops')
    const alerts = await read('/alerts')
    expect(hasWriteControl(alerts)).toBe(true)
    expect(alerts).not.toContain('id="read-only"')
    expect(hasWriteControl(await read('/jobs'))).toBe(false)
    const response = await ack()
    expect(response.status).toBe(200)
    expect(notify.stored.get('n:disk')?.by).toMatch(/^u:[0-9a-f]{16}$/)
    expect(((await response.json()) as { unread: number }).unread).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// The copy rules, over every state the two pages can be in
// ---------------------------------------------------------------------------

const BROKEN: AuditPage = {
  records: [],
  chain: 'broken',
  intact: false,
  issueCount: 1,
  total: 3,
  witness: { tampered: true, stale: false },
}

/** Every shape of alert source, failure and absence the page can draw. */
function alertStates(): readonly Partial<ConsoleDeps>[] {
  const failing = freshNotify()
  failing.noticesFailure = {
    ok: false,
    failure: { code: 'unreachable', message: 'trail unreadable' },
  }
  failing.acksFailure = {
    ok: false,
    failure: { code: 'unreachable', message: 'acks unreadable' },
  }
  const tampered = freshNotify()
  tampered.intact = false
  tampered.stored.set('n:done', { id: 'n:done', at: NOW, by: 'legacy:admin' })
  return [
    {},
    { notify: freshNotify() },
    { notify: failing },
    {
      notify: tampered,
      certificates: certificatesOf(
        {
          certificates: [
            { node: 'b', status: 'expiring', notAfter: NOW + 9 * 86_400_000 },
            {
              node: 'c',
              status: 'expiring-urgent',
              notAfter: NOW + 86_400_000,
            },
            { node: 'd', status: 'expired', notAfter: NOW - 86_400_000 },
            { node: 'e', status: 'revoked' },
            { node: 'f', status: 'bad-signature' },
            { node: 'g', status: 'absent' },
          ],
          revocationList: {
            issuedAt: NOW - 9 * 86_400_000,
            nextUpdate: NOW - 86_400_000,
            revokedCount: 2,
          },
        },
        [
          {
            subject: 'Root A',
            notAfter: NOW + 20 * 86_400_000,
            status: 'expiring',
          },
          { subject: 'Root B', notAfter: NOW - 86_400_000, status: 'expired' },
        ],
      ),
      audits: [
        {
          node: 'tokyo-1',
          kind: 'authoritative',
          audit: {
            read: () => Promise.resolve(ok(BROKEN)),
            chain: () => Promise.resolve(ok(null)),
          },
        },
        {
          node: 'osaka-1',
          kind: 'authoritative',
          audit: {
            read: () =>
              Promise.resolve(
                ok({ ...BROKEN, chain: 'absent' as const, witness: undefined }),
              ),
            chain: () => Promise.resolve(ok(null)),
          },
        },
      ],
    },
  ]
}

function jobStates(): readonly (SchedulerSnapshot | null | 'failing')[] {
  const base = snapshotOf().jobs[0]
  if (base === undefined) throw new Error('fixture')
  return [
    null,
    'failing',
    snapshotOf(),
    snapshotOf({ tick: { state: 'never' } }),
    snapshotOf({ tick: { state: 'seen', at: NOW - 900_000, everyMs: 60_000 } }),
    snapshotOf({ tick: { state: 'seen', at: NOW - 5_000, everyMs: 60_000 } }),
    snapshotOf({ estop: { state: 'engaged', since: NOW - 60_000 } }),
    snapshotOf({ estop: { state: 'unknown', reason: 'EACCES' } }),
    unwiredSnapshotOf(),
    unwiredSnapshotOf({
      tick: { state: 'unwired', reason: '状态文件读不出来 · not JSON' },
      jobs: [{ id: 'x', listed: false, consecutiveFailures: 1 }],
    }),
    snapshotOf({
      jobs: [
        {
          ...base,
          next: NOW - 60_000,
          result: { at: NOW, result: 'error', code: 'E_CAP_INSUFFICIENT' },
        },
        {
          ...base,
          id: 'held',
          holdUntil: NOW + 60_000,
          consecutiveFailures: 2,
        },
        {
          id: 'gone',
          listed: false,
          consecutiveFailures: 0,
          last: { at: NOW - 1, outcome: 'preempted' },
        },
        { ...base, id: 'skip', last: { at: NOW - 1, outcome: 'skipped' } },
      ],
    }),
    snapshotOf({ jobs: [] }),
  ]
}

function assertCopy(label: string, html: string): void {
  const text = visibleText(html)
  for (const banned of ['。', '，', '、', '！', '!']) {
    expect(`${label} ${text.includes(banned)} ${banned}`).toBe(
      `${label} false ${banned}`,
    )
  }
  expect(text).not.toMatch(/\p{Extended_Pictographic}/u)
}

describe('the copy rules', () => {
  test('every state of the inbox, every filter: no 。，、 no exclamation, no emoji', async () => {
    let checked = 0
    for (const [index, extra] of alertStates().entries()) {
      const c = watchConsole(extra)
      c.page.registry.listResult = ok([...AGENTS.slice(0, 2), LOST_OSAKA])
      for (const query of ['', '?state=all', '?state=acked', '?level=warn']) {
        for (const token of [ADMIN, VIEW]) {
          const html = await (
            await c.handle(browse(`/alerts${query}`, token))
          ).text()
          assertCopy(`alerts#${index}${query}`, html)
          checked += 1
        }
      }
    }
    // With the registry down as well.
    const down = watchConsole({ notify: freshNotify() })
    down.page.registry.listResult = {
      ok: false,
      failure: { code: 'unreachable', message: 'registry down' },
    }
    assertCopy(
      'alerts registry down',
      await (await down.handle(browse('/alerts', ADMIN))).text(),
    )
    expect(checked).toBe(32)
  })

  test('every state of the jobs page: the same rules', async () => {
    for (const [index, state] of jobStates().entries()) {
      let extra: Partial<ConsoleDeps> = {}
      if (state === 'failing') {
        const scheduler = new FixedScheduler(snapshotOf())
        scheduler.result = {
          ok: false,
          failure: { code: 'unreachable', message: 'state unreadable' },
        }
        extra = { scheduler }
      } else if (state !== null) {
        extra = { scheduler: new FixedScheduler(state) }
      }
      const c = watchConsole(extra)
      assertCopy(
        `jobs#${index}`,
        await (await c.handle(browse('/jobs', ADMIN))).text(),
      )
    }
  })
})

// ---------------------------------------------------------------------------
// Without script
// ---------------------------------------------------------------------------

describe('with script off', () => {
  test('the inbox is in the markup and the GET form is the filter', async () => {
    const c = watchConsole({ notify: freshNotify() })
    c.page.registry.listResult = ok([...AGENTS.slice(0, 2), LOST_OSAKA])
    const bare = withoutScripts(
      await (await c.handle(browse('/alerts', ADMIN))).text(),
    )
    expect(bare).not.toContain('<script')
    expect(bare).toContain('根分区使用率 95%')
    expect(bare).toContain('节点失联 · osaka-1')
    expect(bare).toContain('id="alerts-unread" data-unread="3"')
    expect(bare).toContain('<form id="alerts-filter" method="get">')
    // The one thing that needs script says so where it would have been.
    expect(bare).toContain(
      '<noscript><p class="note">确认需要启用脚本 · 阅读与筛选不受影响</p></noscript>',
    )

    // What the form submits, as a browser with no script sends it.
    const filtered = withoutScripts(
      await (
        await c.handle(browse('/alerts?level=info&state=all', ADMIN))
      ).text(),
    )
    expect(filtered).toContain('巡检完成')
    expect(filtered).not.toContain('根分区使用率 95%')
    expect(filtered).not.toContain('节点失联 · osaka-1')
  })

  test('a reader who cannot acknowledge is not told about script at all', async () => {
    const c = watchConsole({ notify: freshNotify() })
    const html = await (await c.handle(browse('/alerts', VIEW))).text()
    expect(html).not.toContain('<noscript>')
  })

  test('the jobs page is whole without script', async () => {
    const c = watchConsole({ scheduler: new FixedScheduler(snapshotOf()) })
    const bare = withoutScripts(
      await (await c.handle(browse('/jobs', VIEW))).text(),
    )
    expect(bare).toContain('<tr data-key="disk-watch">')
    expect(bare).toContain('刚运行过')
    expect(bare).toContain('id="sched-estop"')
    expect(bare).toContain('id="nav-alerts" href="/alerts"')
  })
})
