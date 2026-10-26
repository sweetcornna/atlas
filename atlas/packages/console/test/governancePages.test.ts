// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileUsageStore } from '../src/usage.js'
import type { ConsolePrincipal } from '../src/contracts.js'
import type { ApprovalPort } from '../src/governance.js'
import { APPROVAL_COOKIE } from '../src/approvalSession.js'
import {
  accountsHarness,
  person,
  asBearer,
  asSession,
  asAdmin,
  cookieFrom,
  BASE,
  START,
  CONSOLE_HEADER,
} from './accountsHarness.js'

const jsonBody = async (response: Response) =>
  (await response.json()) as Record<string, unknown>

describe('P18.16 quota and usage through HTTP', () => {
  test('real durable quota rejects before open/send and holds admitted pending turns until terminal completion', async () => {
    const usage = new FileUsageStore({
      path: join(mkdtempSync(join(tmpdir(), 'qm-http-usage-')), 'usage.ndjson'),
      policy: {
        mode: 'enforce',
        person: { inFlight: 1, sessions: 1 },
        job: {},
        global: {},
      },
      now: () => START,
    })
    try {
      const h = accountsHarness({ deps: { usage } }),
        alice = await person(h.handle),
        bob = await person(h.handle)
      const opened = await h.handle(
        asBearer('POST', '/v0/chat/sessions', alice.credential, {
          target: 'qianmo://tokyo-1/planner',
        }),
      )
      expect(opened.status).toBe(200)
      const id = (await jsonBody(opened))['id'] as string
      // The same agent again is the same conversation (P37.17): no new
      // session, so nothing for the session quota to refuse.
      const again = await h.handle(
        asBearer('POST', '/v0/chat/sessions', alice.credential, {
          target: 'qianmo://tokyo-1/planner',
        }),
      )
      expect(again.status).toBe(200)
      expect((await jsonBody(again))['id']).toBe(id)
      expect(
        (
          await h.handle(
            asBearer('POST', '/v0/chat/sessions', alice.credential, {
              target: 'qianmo://tokyo-1/reviewer',
            }),
          )
        ).status,
      ).toBe(429)
      expect(h.chat.opened).toBe(1)
      expect(
        (
          await h.handle(
            asBearer(
              'POST',
              `/v0/chat/sessions/${id}/messages`,
              alice.credential,
              { text: 'hello' },
            ),
          )
        ).status,
      ).toBe(200)
      const refused = await h.handle(
        asBearer('POST', `/v0/chat/sessions/${id}/messages`, alice.credential, {
          text: 'second',
        }),
      )
      expect(refused.status).toBe(429)
      expect(h.chat.sends).toBe(1)
      const reservation = h.chat.sent[0]?.usageReservation
      expect(typeof reservation).toBe('string')
      usage.finish(reservation!, {
        input: 8,
        output: 2,
        cacheWrite: 3,
        cacheRead: 900,
      })
      expect(
        (
          await h.handle(
            asBearer(
              'POST',
              `/v0/chat/sessions/${id}/messages`,
              alice.credential,
              { text: 'after completion' },
            ),
          )
        ).status,
      ).toBe(200)
      const text = await (
        await h.handle(asBearer('GET', '/admin/usage', alice.credential))
      ).text()
      expect(text).toContain('东八区自然日')
      expect(text).toContain('缓存读取')
      expect(text).toContain('下界')
      expect(text).toContain('900')
      const bobUsage = await jsonBody(
        await h.handle(asBearer('GET', '/v0/usage', bob.credential)),
      )
      expect(JSON.stringify(bobUsage)).not.toContain('900')
      expect(bobUsage['rows'] as unknown[]).toHaveLength(1)
    } finally {
      usage.close()
    }
  })
  test('unwired usage is explicit and anonymous access is denied', async () => {
    const h = accountsHarness()
    expect((await h.handle(asAdmin('GET', '/v0/usage'))).status).toBe(501)
    expect((await h.handle(new Request(`${BASE}/v0/usage`))).status).toBe(401)
    expect(
      await (await h.handle(asAdmin('GET', '/admin/usage'))).text(),
    ).toContain('用量未接入')
  })
})

/** One pending request owned by whoever asks, and every call the port gets. */
function approvalPort(): {
  readonly port: ApprovalPort
  readonly calls: string[]
  readonly seen: ConsolePrincipal[]
  setTool(name: string): void
} {
  const calls: string[] = []
  const seen: ConsolePrincipal[] = []
  let toolName = 'write'
  const port: ApprovalPort = {
    async list(principal) {
      return {
        ok: true,
        value: [
          {
            requestId: 'request-1',
            node: 'tokyo-1',
            agent: 'planner',
            contextId: 'session-1',
            owner: principal.subject,
            toolName,
            input: { path: '<unsafe>', content: 'hello' },
            digest: 'digest-1',
            createdAt: START,
            expiresAt: START + 6 * 3600000,
            status: 'pending',
          },
        ],
      }
    },
    async decide(principal, input) {
      seen.push(principal)
      calls.push(`${principal.credential}:${input.decision}:${input.digest}`)
      return { ok: true, value: { delivered: true } }
    },
    async revoke(principal) {
      seen.push(principal)
      calls.push(`${principal.credential}:revoke`)
      return { ok: true, value: { delivered: true } }
    },
  }
  return {
    port,
    calls,
    seen,
    setTool: name => {
      toolName = name
    },
  }
}

describe('P18.16 approval decisions over real HTTP (no step-up since 2026-10-22)', () => {
  const body = { decision: 'allow-once', digest: 'digest-1' }

  test('a signed-in session decides on its own conversation directly; a viewer session, the admin token and a request without the console header cannot', async () => {
    const { port, calls, setTool } = approvalPort()
    const h = accountsHarness({ deps: { approvals: port } }),
      alice = await person(h.handle),
      viewer = await person(h.handle, 'viewer')
    const deciding = (method = 'POST', value: unknown = body) =>
      asSession(method, '/v0/approvals/request-1', alice.sid, { body: value })
    expect((await h.handle(deciding())).status).toBe(200)
    expect(calls).toEqual(['session:allow-once:digest-1'])
    expect((await h.handle(deciding('DELETE'))).status).toBe(200)
    expect(calls).toEqual(['session:allow-once:digest-1', 'session:revoke'])
    expect(
      (
        await h.handle(
          deciding('POST', {
            decision: 'allow-window',
            digest: 'digest-1',
            windowMs: 3600001,
          }),
        )
      ).status,
    ).toBe(400)
    expect(calls).toHaveLength(2)
    const page = await (
      await h.handle(asSession('GET', '/admin/approvals', alice.sid))
    ).text()
    // Nothing to verify first: no credential row and no call for one.
    expect(page).not.toContain('approval-auth')
    expect(page).not.toContain('name="credential"')
    expect(page).not.toContain('/v0/approvals/auth')
    expect(page).not.toContain('先验证个人凭据')
    expect(page).toContain('<p class="apv-note">批准绑定确切参数</p>')
    expect(page).toContain('&lt;unsafe&gt;')
    expect(page).not.toContain('<unsafe>')
    expect(page).toContain('value="allow-window"')
    setTool('qianmo_memory_write')
    const memoryPage = await (
      await h.handle(asSession('GET', '/admin/approvals', alice.sid))
    ).text()
    expect(memoryPage).not.toContain('value="allow-window"')
    expect(memoryPage).toContain('value="allow-once"')
    const refusedWindow = await h.handle(
      deciding('POST', {
        decision: 'allow-window',
        digest: 'digest-1',
        windowMs: 300_000,
      }),
    )
    expect(refusedWindow.status).toBe(400)
    expect(await refusedWindow.text()).toContain('逐次批准')
    expect(calls).toHaveLength(2)

    // A viewer is signed in too, and still never decides.
    for (const method of ['POST', 'DELETE'])
      expect(
        (
          await h.handle(
            asSession(method, '/v0/approvals/request-1', viewer.sid, {
              body,
            }),
          )
        ).status,
      ).toBe(403)
    expect(
      (await h.handle(asAdmin('POST', '/v0/approvals/request-1', body))).status,
    ).toBe(403)
    const noCsrf = deciding()
    noCsrf.headers.delete(CONSOLE_HEADER)
    expect((await h.handle(noCsrf)).status).toBe(403)
    expect(calls).toHaveLength(2)
  })

  test('a cross-origin cookie POST to an approval is refused and reaches no port', async () => {
    const { port, calls } = approvalPort()
    const h = accountsHarness({ deps: { approvals: port } }),
      alice = await person(h.handle)
    // What a page on another origin gets the browser to send: the cookie,
    // never the console header.
    for (const path of [
      '/v0/approvals/request-1',
      '/v0/approvals/request-1/continue',
    ]) {
      const forged = asSession('POST', path, alice.sid, {
        body,
        header: false,
        extra: { 'sec-fetch-site': 'cross-site', origin: 'https://evil.test' },
      })
      expect((await h.handle(forged)).status).toBe(403)
    }
    const revoke = asSession('DELETE', '/v0/approvals/request-1', alice.sid, {
      header: false,
      extra: { 'sec-fetch-site': 'cross-site' },
    })
    expect((await h.handle(revoke)).status).toBe(403)
    expect(calls).toEqual([])
    // The same request from the console's own page goes through.
    expect(
      (
        await h.handle(
          asSession('POST', '/v0/approvals/request-1', alice.sid, {
            body,
            extra: { 'sec-fetch-site': 'same-origin' },
          }),
        )
      ).status,
    ).toBe(200)
    expect(calls).toEqual(['session:allow-once:digest-1'])
  })

  test('a login hours old still decides, and an approval session from an older page is still taken', async () => {
    const { port, calls, seen } = approvalPort()
    const h = accountsHarness({ deps: { approvals: port } }),
      alice = await person(h.handle),
      bob = await person(h.handle)
    // Three hours of use, never idle for the session's two: the login is
    // as old as that, and no credential has been shown since.
    for (let hour = 0; hour < 3; hour++) {
      h.clock.advance(3600000)
      expect(
        (await h.handle(asSession('GET', '/v0/approvals', alice.sid))).status,
      ).toBe(200)
    }
    expect(
      (
        await h.handle(
          asSession('POST', '/v0/approvals/request-1', alice.sid, { body }),
        )
      ).status,
    ).toBe(200)
    expect(calls).toEqual(['session:allow-once:digest-1'])
    expect(seen[0]).toMatchObject({
      kind: 'user',
      credential: 'session',
      authenticatedAt: START,
    })

    // An older page verifies first. It still may, with the right credential
    // only, and the decision then rides that approval session.
    expect(
      (
        await h.handle(
          asSession('POST', '/v0/approvals/auth', alice.sid, {
            body: { credential: bob.credential },
          }),
        )
      ).status,
    ).toBe(403)
    const authenticated = await h.handle(
      asSession('POST', '/v0/approvals/auth', alice.sid, {
        body: { credential: alice.credential },
      }),
    )
    expect(authenticated.status).toBe(200)
    const cookie = cookieFrom(authenticated, APPROVAL_COOKIE)
    expect(cookie).not.toBeNull()
    expect(authenticated.headers.get('set-cookie')).toContain(
      'HttpOnly; SameSite=Strict',
    )
    expect(authenticated.headers.get('set-cookie')).toContain('; Secure')
    expect(h.ledger.text).not.toContain(cookie!)
    const withCookie = () => {
      const request = asSession('POST', '/v0/approvals/request-1', alice.sid, {
        body,
      })
      request.headers.set(
        'cookie',
        `${request.headers.get('cookie')}; ${APPROVAL_COOKIE}=${cookie}`,
      )
      return request
    }
    expect((await h.handle(withCookie())).status).toBe(200)
    expect(calls[1]).toBe('approval-session:allow-once:digest-1')
    // Once it lapses the session decides on its own; nothing asks again.
    h.clock.advance(1800000)
    expect((await h.handle(withCookie())).status).toBe(200)
    expect(calls[2]).toBe('session:allow-once:digest-1')
  })
})

test('authorization report projects verified audit scope: viewer counts only, member owns contexts, corrupt source yields no rows', async () => {
  const { AuditSource } = await import('@qianmo/audit')
  let intact = true
  const h = accountsHarness({
    deps: {
      audits: [
        {
          node: 'worker',
          kind: 'authoritative',
          audit: {
            async read() {
              return {
                ok: true,
                value: {
                  chain: intact ? 'intact' : 'broken',
                  intact,
                  issueCount: intact ? 0 : 1,
                  total: 2,
                  earlier: 1,
                  records: ['own', 'other'].map((contextId, i) => ({
                    seq: i + 1,
                    prev: '0'.repeat(64),
                    at: START,
                    source: AuditSource.Capability,
                    node: 'worker',
                    kind: 'authz.requested',
                    outcome: 'ok' as const,
                    detail: {
                      requestId: String(i).repeat(32),
                      contextId,
                      tool: 'Write',
                      input: 'must-not-leak',
                      digest: 'b'.repeat(64),
                    },
                  })),
                },
              }
            },
            async chain() {
              return { ok: true, value: null }
            },
          },
        },
      ],
    },
  })
  const viewer = await person(h.handle, 'viewer'),
    member = await person(h.handle, 'member')
  const principal = h.book.bearerPrincipal(member.credential)
  if (!principal.ok) throw new Error('missing principal')
  expect(
    h.book.recordOwner('own', principal.value.subject as `u:${string}`).ok,
  ).toBe(true)
  const summary = await jsonBody(
    await h.handle(asBearer('GET', '/v0/approvals/report', viewer.credential)),
  )
  expect(summary['rows']).toBeUndefined()
  expect(summary['summary']).toEqual([
    { node: 'worker', requests: 2, used: 0, refused: 0, pending: 2 },
  ])
  expect(JSON.stringify(summary)).not.toContain('must-not-leak')
  const report = await jsonBody(
    await h.handle(asBearer('GET', '/v0/approvals/report', member.credential)),
  )
  expect(report['rows'] as unknown[]).toHaveLength(1)
  expect(JSON.stringify(report)).toContain('own')
  expect(JSON.stringify(report)).not.toContain('other')
  expect(JSON.stringify(report)).not.toContain('must-not-leak')
  intact = false
  const broken = await jsonBody(
    await h.handle(asBearer('GET', '/v0/approvals/report', viewer.credential)),
  )
  expect(broken['summary']).toEqual([])
  expect(JSON.stringify(broken)).toContain('broken')
})

test('HTTP does not release a metered chat reservation when delivery is unknown', async () => {
  const usage = new FileUsageStore({
    path: join(mkdtempSync(join(tmpdir(), 'qm-http-unknown-')), 'usage.ndjson'),
    policy: { mode: 'enforce', person: { inFlight: 1 }, job: {}, global: {} },
    now: () => START,
  })
  try {
    const h = accountsHarness({ deps: { usage } })
    const alice = await person(h.handle)
    const opened = await h.handle(
      asBearer('POST', '/v0/chat/sessions', alice.credential, {
        target: 'qianmo://tokyo-1/planner',
      }),
    )
    const id = (await jsonBody(opened))['id'] as string
    const original = h.chat.send.bind(h.chat)
    h.chat.send = async input => {
      await original(input)
      return {
        ok: false,
        failure: {
          code: 'unreachable',
          message: 'delivery unknown',
          deliveryUnknown: true,
        },
      }
    }
    const send = () =>
      h.handle(
        asBearer('POST', `/v0/chat/sessions/${id}/messages`, alice.credential, {
          text: 'hello',
        }),
      )
    expect((await send()).status).toBe(503)
    expect((await send()).status).toBe(429)
    expect(h.chat.sends).toBe(1)
    usage.finish(h.chat.sent[0]!.usageReservation!)
    expect((await send()).status).toBe(503)
    expect(h.chat.sends).toBe(2)
  } finally {
    usage.close()
  }
})

test('legacy wake binds its actual address node and unknown delivery keeps quota until that node ends the task', async () => {
  const usage = new FileUsageStore({
    path: join(mkdtempSync(join(tmpdir(), 'qm-wake-usage-')), 'usage.ndjson'),
    policy: { mode: 'enforce', person: { inFlight: 1 }, job: {}, global: {} },
    now: () => START,
  })
  let mode: 'success' | 'unknown' = 'success'
  let calls = 0
  const h = accountsHarness({
    deps: {
      usage,
      wake: {
        send: async input => {
          calls++
          const taskId = `wake-${mode}`
          if (mode === 'unknown') {
            input.onTaskCreated?.(taskId, 'tokyo-1')
            return {
              ok: false,
              failure: {
                code: 'unreachable',
                message: 'receipt missing',
                deliveryUnknown: true,
              },
            }
          }
          return {
            ok: true,
            value: { msgId: 'msg', taskId, receipt: 'delivered' },
          }
        },
      },
    },
  })
  const send = () =>
    h.handle(
      asAdmin('POST', '/v0/wake', {
        from: 'qianmo://console/operator',
        to: 'qianmo://tokyo-1/planner',
        prompt: 'wake',
        url: '',
      }),
    )
  try {
    expect((await send()).status).toBe(200)
    usage.recordTask(
      'right/usage',
      'wake-success',
      { input: 7, output: 0, cacheWrite: 0, cacheRead: 0 },
      START,
      'tokyo-1',
    )
    expect((await usage.read()).rows.some(row => row.charged === 7)).toBe(true)
    usage.finishTask('wake-success', 'wrong-node')
    expect((await send()).status).toBe(429)
    usage.finishTask('wake-success', 'tokyo-1')
    mode = 'unknown'
    expect((await send()).status).toBe(503)
    expect((await send()).status).toBe(429)
    expect(calls).toBe(2)
    usage.finishTask('wake-unknown', 'tokyo-1')
    expect((await usage.read()).rows.every(row => row.inFlight === 0)).toBe(
      true,
    )
  } finally {
    usage.close()
  }
})

describe('the sidebar dot of 审批', () => {
  test('a member who may decide sees how many wait; a viewer sees none', async () => {
    const pending = (id: string, status: 'pending' | 'allowed') => ({
      requestId: id,
      node: 'tokyo-1',
      agent: 'planner',
      contextId: `session-${id}`,
      owner: 'someone',
      toolName: 'write',
      input: {},
      digest: `digest-${id}`,
      createdAt: START,
      expiresAt: START + 3600000,
      status,
    })
    const approvals: ApprovalPort = {
      async list() {
        return {
          ok: true,
          value: [
            pending('a', 'pending'),
            pending('b', 'pending'),
            pending('c', 'allowed'),
          ],
        }
      },
      async decide() {
        return { ok: true, value: { delivered: true } }
      },
      async revoke() {
        return { ok: true, value: { delivered: true } }
      },
    }
    const h = accountsHarness({ deps: { approvals } })
    const member = await person(h.handle, 'member')
    const viewer = await person(h.handle, 'viewer')
    const item = async (sid: string) => {
      const page = await (
        await h.handle(asSession('GET', '/admin/overview', sid))
      ).text()
      const start = page.indexOf('id="nav-approvals"')
      return page.slice(start, page.indexOf('</a>', start))
    }
    const mine = await item(member.sid)
    expect(mine).toContain('nav-state-attention')
    expect(mine).toContain('2 项待你处理')
    expect(await item(viewer.sid)).not.toContain('nav-state')
  })
})
