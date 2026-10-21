// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The public edition in the console (P35): the doors (`/plans`,
 * `/subscription`, the checkout, the two payment notifications), the one
 * subscription gate — walked over every write row of `console.md` §5 — the
 * `/` standings, the member and admin routes, and the default edition with
 * none of it.
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { BYOK_LINE } from '../src/view/billing.js'
import {
  ADMIN,
  BASE,
  CONSOLE_HEADER,
  accountsHarness,
  asBearer,
  person,
} from './accountsHarness.js'
import { MAX_NOTIFY_BYTES } from '../src/billingDoors.js'
import { publicConsole, signNotify, type PublicPerson } from './billingFake.js'

type Fixture = ReturnType<typeof publicConsole>

/** A page as a browser asks for it, with a personal bearer. */
function page(path: string, who?: PublicPerson | string): Request {
  const bearer = typeof who === 'string' ? who : who?.credential
  return new Request(`${BASE}${path}`, {
    headers: {
      accept: 'text/html',
      ...(bearer === undefined ? {} : { authorization: `Bearer ${bearer}` }),
    },
  })
}

/** A JSON call the way the page script makes it. */
function call(
  method: string,
  path: string,
  who: PublicPerson | string,
  body?: unknown,
): Request {
  const bearer = typeof who === 'string' ? who : who.credential
  return new Request(`${BASE}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${bearer}`,
      [CONSOLE_HEADER]: '1',
      accept: 'application/json',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

/** The checkout form, submitted from the console's own page. */
function checkoutForm(
  who: PublicPerson,
  fields: Record<string, string>,
  extra: Record<string, string> = { 'sec-fetch-site': 'same-origin' },
): Request {
  return new Request(`${BASE}/subscription/checkout`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${who.credential}`,
      'content-type': 'application/x-www-form-urlencoded',
      ...extra,
    },
    body: new URLSearchParams(fields).toString(),
  })
}

function notify(channel: string, raw: string, signed = true): Request {
  return new Request(`${BASE}/v0/billing/notify/${channel}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(signed ? { 'x-fake-signature': signNotify(raw) } : {}),
    },
    body: raw,
  })
}

async function errorCode(response: Response): Promise<string> {
  const body = (await response.json()) as { error?: { code?: string } }
  return body.error?.code ?? ''
}

async function checkout(f: Fixture, who: PublicPerson): Promise<string> {
  const response = await f.handle(
    checkoutForm(who, { plan: 'month', channel: 'wechatpay' }),
  )
  expect(response.status).toBe(303)
  const location = response.headers.get('location') ?? ''
  expect(location).toMatch(/^\/subscription\/checkout\?order=ord_/)
  return decodeURIComponent(location.split('order=')[1] ?? '')
}

// ---------------------------------------------------------------------------

describe('the default edition has none of it', () => {
  test('no billing port: the doors are unknown paths and the area is absent', async () => {
    const h = accountsHarness()
    for (const path of [
      '/plans',
      '/subscription',
      '/subscription/checkout',
      '/admin/billing',
    ]) {
      const response = await h.handle(asBearer('GET', path, ADMIN))
      expect(`${path} ${response.status}`).toBe(`${path} 404`)
      await response.body?.cancel()
    }
    const notified = await h.handle(
      asBearer('POST', '/v0/billing/notify/wechatpay', ADMIN, {}),
    )
    expect(notified.status).toBe(404)
    expect(await notified.text()).toContain('unknown path')
    const shell = await (
      await h.handle(asBearer('GET', '/admin/overview', ADMIN))
    ).text()
    expect(shell).not.toContain('href="/admin/billing"')
    // A write by a member is not gated by anything that is not there.
    const member = await person(h.handle, 'member')
    const written = await h.handle(
      new Request(`${BASE}/v0/billing/redeem`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${member.credential}`,
          [CONSOLE_HEADER]: '1',
          'content-type': 'application/json',
        },
        body: '{}',
      }),
    )
    expect(written.status).toBe(501)
    expect(await errorCode(written)).not.toBe('subscription_required')
  })
})

describe('/plans', () => {
  test('public: per-node cards, the own-key line, the source link, nothing external', async () => {
    const f = publicConsole()
    for (const path of ['/plans', '/']) {
      const response = await f.handle(page(path))
      expect(`${path} ${response.status}`).toBe(`${path} 200`)
      expect(response.headers.get('content-security-policy')).toContain(
        "default-src 'none'",
      )
      const html = await response.text()
      expect(html).toContain('含 1 台托管节点')
      expect(html).toContain('含 3 台托管节点')
      expect(html).toContain('<b>99</b> 元')
      expect(html).toContain(BYOK_LINE)
      expect(html).toContain(
        '<a href="https://github.com/sweetcornna/atlas" rel="noopener" data-source>源代码 · AGPL-3.0</a>',
      )
      expect(html).toContain('href="/login?redirect=%2Fsubscription"')
      expect(html).toContain('href="/signup"')
      expect(html).not.toContain('url(')
      // No model allowance is sold.
      expect(html).not.toContain('额度')
    }
  })

  test('signed in, it points at the subscription; only GET', async () => {
    const f = publicConsole()
    const html = await (await f.handle(page('/plans', f.unpaid))).text()
    expect(html).toContain('href="/subscription"')
    expect(html).not.toContain('href="/login')
    const posted = await f.handle(
      new Request(`${BASE}/plans`, { method: 'POST' }),
    )
    expect(posted.status).toBe(405)
  })

  test('without tenancy there is no sign-up to offer', async () => {
    const f = publicConsole({ tenancy: false })
    const html = await (await f.handle(page('/plans'))).text()
    expect(html).not.toContain('href="/signup"')
  })
})

describe('/ follows the standing', () => {
  const cases: readonly [
    string,
    (f: Fixture) => PublicPerson,
    string | null,
  ][] = [
    ['never subscribed', f => f.unpaid, '还没有订阅'],
    ['expired', f => f.expired, '订阅已到期'],
    ['active, no node yet', f => f.waiting, '节点分配中'],
    ['active with a node', f => f.paid, null],
    ['a platform subject', f => f.platform, null],
  ]
  for (const [name, who, card] of cases) {
    test(name, async () => {
      const f = publicConsole()
      const response = await f.handle(page('/', who(f)))
      expect(response.status).toBe(200)
      const html = await response.text()
      if (card === null) {
        expect(html).not.toContain('bl-stage')
      } else {
        expect(html).toContain(`id="page-title">${card}</h1>`)
        expect(html).toContain('href="/subscription"')
        expect(html).toContain('data-source>源代码 · AGPL-3.0</a>')
      }
    })
  }
})

// ---------------------------------------------------------------------------
// The gate, walked over the route table
// ---------------------------------------------------------------------------

const WRITES = ['POST', 'PUT', 'DELETE'] as const

/** Every documented write, as (method, concrete path). */
function documentedWrites(): readonly (readonly [string, string])[] {
  const doc = readFileSync(
    fileURLToPath(new URL('../../../../docs/dev/console.md', import.meta.url)),
    'utf8',
  )
  const start = doc.indexOf('\n## §5 路由表')
  const end = doc.indexOf('\n### 5.1', start)
  const out = new Map<string, readonly [string, string]>()
  for (const line of doc.slice(start, end).split('\n')) {
    const cells = line.split('\\|').join('\uE000').split('|')
    if (cells.length < 4) continue
    const methods = (cells[1] ?? '').trim().split(/[、/\s]+/)
    if (!methods.every(m => ['GET', ...WRITES].includes(m))) continue
    for (const [, text] of (cells[2] ?? '').matchAll(/`([^`]+)`/g)) {
      if (text === undefined || !text.startsWith('/')) continue
      const bare = text.split('?')[0] ?? ''
      let paths = ['']
      let slot = 0
      for (const part of bare.split('/').filter(Boolean)) {
        const braces = /^\{(.+)\}$/.exec(part)
        const angle = /^<(.+)>$/.exec(part)
        const options =
          braces?.[1] !== undefined
            ? braces[1].split(',')
            : angle?.[1] !== undefined
              ? [
                  /^[a-z|\uE000]+$/.test(angle[1])
                    ? (angle[1].split(/[|\uE000]/)[0] ?? '')
                    : `sample-${slot++}`,
                ]
              : [part]
        paths = paths.flatMap(prefix => options.map(o => `${prefix}/${o}`))
      }
      for (const method of methods) {
        if (!(WRITES as readonly string[]).includes(method)) continue
        for (const path of paths) out.set(`${method} ${path}`, [method, path])
      }
    }
  }
  return [...out.values()]
}

/** Writes a person without a subscription may still make, and why. */
function ungated(method: string, path: string): boolean {
  const parts = path.split('/').filter(Boolean)
  // The doors that make or end a session.
  if (['/login', '/logout', '/signup', '/invite'].includes(path)) return true
  // Becoming a subscriber.
  if (
    [
      '/subscription/checkout',
      '/v0/billing/checkout',
      '/v0/billing/redeem',
    ].includes(path)
  )
    return true
  // Answered before any credential is read.
  if (parts[0] === 'v0' && parts[1] === 'billing' && parts[2] === 'notify')
    return true
  // Taking one's own upstream key back out of the gateway, lapsed or not.
  if (
    method === 'DELETE' &&
    parts.length === 4 &&
    parts[0] === 'v0' &&
    parts[1] === 'billing' &&
    parts[2] === 'models'
  )
    return true
  // The `qmo` client's doors, answered before any credential is read like
  // pairing (clients.md §3.2): a ticket signs in, a device revoking itself
  // signs out, and the window's confirmation spends the ticket.
  if (method === 'POST' && path === '/v0/client/tickets') return true
  if (method === 'POST' && path === '/client/enter') return true
  if (method === 'DELETE' && path === '/v0/client/device') return true
  return path === '/v0/handoff/pair'
}

async function walk(
  f: Fixture,
  who: PublicPerson,
): Promise<{ gated: string[]; passed: string[] }> {
  const gated: string[] = []
  const passed: string[] = []
  for (const [method, path] of documentedWrites()) {
    const response = await f.handle(call(method, path, who, {}))
    const line = `${method} ${path}`
    if (response.status === 402) {
      expect(`${line} ${await errorCode(response)}`).toBe(
        `${line} subscription_required`,
      )
      gated.push(line)
    } else {
      await response.body?.cancel()
      passed.push(line)
    }
  }
  return { gated, passed }
}

describe('the subscription gate (one place, every write)', () => {
  test('the table has writes to walk, the new billing rows among them', () => {
    const writes = documentedWrites().map(([m, p]) => `${m} ${p}`)
    expect(writes.length).toBeGreaterThan(80)
    expect(writes).toContain('POST /v0/billing/models')
    expect(writes).toContain('DELETE /v0/billing/models/sample-0')
    expect(writes).toContain('POST /v0/schedules')
  })

  test('a member without a subscription gets 402 on every write but the doors', async () => {
    // An ops account outside the platform subjects is a subscriber like any.
    for (const who of ['unpaid', 'expired', 'ops'] as const) {
      const f = publicConsole()
      const { gated, passed } = await walk(f, f[who])
      const wrong = passed.filter(line => {
        const [method = '', path = ''] = line.split(' ')
        return !ungated(method, path)
      })
      expect(`${who} ${wrong.join(', ')}`).toBe(`${who} `)
      expect(gated.length).toBeGreaterThan(70)
      // Nothing behind the gate ran: no line in the action ledger.
      expect(f.actions.entries.filter(e => e.outcome === 'ok')).toEqual([])
    }
  })

  test('a lapsed subscriber can still take their own upstream key out', async () => {
    const f = publicConsole()
    f.billing.upstreams.set(f.expired.subject, [
      {
        id: 'openai-1',
        name: 'expired-openai',
        preset: 'openai',
        models: 2,
        ready: true,
        present: true,
      },
    ])
    const removed = await f.handle(
      call('DELETE', '/v0/billing/models/openai-1', f.expired),
    )
    expect(removed.status).toBe(204)
    expect(
      f.actions.entries.map(
        e => `${e.subject} ${e.action} ${e.target} ${e.outcome}`,
      ),
    ).toEqual([`${f.expired.subject} billing.model.remove openai-1 ok`])
    // Adding one is still for subscribers, and only DELETE is let through.
    for (const [method, path, body] of [
      ['POST', '/v0/billing/models', { preset: 'openai', key: 'sk-1' }],
      ['POST', '/v0/billing/models/openai-1', {}],
      ['PUT', '/v0/billing/models/openai-1', {}],
    ] as const) {
      const response = await f.handle(call(method, path, f.expired, body))
      expect(`${method} ${path} ${response.status}`).toBe(
        `${method} ${path} 402`,
      )
    }
  })

  test('the same walk as a subscriber, and as the platform, is never 402', async () => {
    for (const who of ['paid', 'waiting', 'platform'] as const) {
      const f = publicConsole()
      const { gated } = await walk(f, f[who])
      expect(`${who} ${gated.join(', ')}`).toBe(`${who} `)
    }
  })

  test('a device acts with its owner’s standing', async () => {
    const f = publicConsole({ devices: true })
    const device = (owner: PublicPerson, method: string, path: string) =>
      f.handle(
        new Request(`${BASE}${path}`, {
          method,
          headers: {
            authorization: `Bearer ${f.deviceOf(owner)}`,
            'content-type': 'application/json',
          },
          ...(method === 'GET' ? {} : { body: '{}' }),
        }),
      )
    for (const owner of [f.unpaid, f.expired, f.ops]) {
      const refused = await device(owner, 'POST', '/v0/handoff/task/send')
      expect(refused.status).toBe(402)
      expect(await errorCode(refused)).toBe('subscription_required')
    }
    for (const owner of [f.paid, f.waiting, f.platform]) {
      const passed = await device(owner, 'POST', '/v0/handoff/task/send')
      expect(passed.status).not.toBe(402)
      await passed.body?.cancel()
    }
    // A device's read is not gated either.
    const read = await device(f.unpaid, 'GET', '/v0/handoff/devices')
    expect(read.status).not.toBe(402)
    await read.body?.cancel()
  })

  test('reads are not gated, and neither is the legacy admin token', async () => {
    const f = publicConsole()
    for (const path of ['/v0/billing/me', '/v0/agents', '/v0/limits']) {
      const response = await f.handle(call('GET', path, f.unpaid))
      expect(`${path} ${response.status}`).toBe(`${path} 200`)
    }
    const admin = await f.handle(call('POST', '/v0/agents', ADMIN, {}))
    expect(admin.status).not.toBe(402)
  })

  test('without tenancy the gate stands the same', async () => {
    const f = publicConsole({ tenancy: false })
    const refused = await f.handle(
      call('POST', '/v0/billing/models', f.unpaid, {
        preset: 'anthropic',
        key: 'sk-1',
      }),
    )
    expect(refused.status).toBe(402)
    const allowed = await f.handle(
      call('POST', '/v0/billing/models', f.paid, {
        preset: 'anthropic',
        key: 'sk-1',
      }),
    )
    expect(allowed.status).toBe(200)
  })
})

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

describe('payment notifications', () => {
  test('raw body to the verifier, no login, no console header, the reply verbatim', async () => {
    const f = publicConsole()
    const orderId = await checkout(f, f.unpaid)
    // Spacing, key order and non-ASCII exactly as the platform sent them.
    const raw = `{ "orderId":"${orderId}",  "memo" : "月付 · 测试"\n}`
    const response = await f.handle(notify('alipay', raw))
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('success')
    expect(response.headers.get('content-type')).toBe(
      'text/plain; charset=utf-8',
    )
    expect(f.billing.notified[0]?.request.rawBody).toBe(raw)
    expect(f.billing.notified[0]?.channel).toBe('alipay')
    expect((await f.billing.standing(f.unpaid.subject)).active).toBe(true)
  })

  test('a 204 reply has no body; a bad signature gets the channel’s refusal', async () => {
    const f = publicConsole()
    const ok = await f.handle(notify('wechatpay', '{"x":1}'))
    expect(ok.status).toBe(204)
    expect(await ok.text()).toBe('')
    const bad = await f.handle(notify('wechatpay', '{"x":1}', false))
    expect(bad.status).toBe(401)
    expect(await bad.text()).toBe('FAIL')
  })

  test('a body without a length is read only up to the cap, then refused', async () => {
    const f = publicConsole()
    const chunk = new Uint8Array(16 * 1024).fill(0x78)
    let pulled = 0
    // 16 MiB if read to the end; the cap is 64 KiB.
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1
        if (pulled > 1024) controller.close()
        else controller.enqueue(chunk)
      },
    })
    const request = new Request(`${BASE}/v0/billing/notify/alipay`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    })
    expect(request.headers.get('content-length')).toBeNull()
    const response = await f.handle(request)
    expect(response.status).toBe(413)
    expect(pulled).toBeLessThan(16)
    expect(f.billing.notified).toEqual([])
  })

  test('only POST, only the two channels, nothing oversized', async () => {
    const f = publicConsole()
    const get = await f.handle(new Request(`${BASE}/v0/billing/notify/alipay`))
    expect(get.status).toBe(405)
    const unknown = await f.handle(notify('paypal', '{}'))
    expect(unknown.status).toBe(404)
    const big = await f.handle(
      notify('alipay', 'x'.repeat(MAX_NOTIFY_BYTES + 1)),
    )
    expect(big.status).toBe(413)
    expect(f.billing.notified).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Checkout
// ---------------------------------------------------------------------------

describe('checkout', () => {
  test('confirm, a same-origin POST, 303 to the QR page, polled to paid', async () => {
    const f = publicConsole()
    const confirm = await f.handle(
      page('/subscription/checkout?plan=month&channel=wechatpay', f.unpaid),
    )
    expect(confirm.status).toBe(200)
    const confirmHtml = await confirm.text()
    expect(confirmHtml).toContain(
      '<form class="bl-form" method="post" action="/subscription/checkout">',
    )
    expect(confirmHtml).toContain('name="plan" value="month"')
    // Showing the confirmation created nothing.
    expect(f.billing.orders.size).toBe(0)

    const orderId = await checkout(f, f.unpaid)
    expect(f.actions.entries.map(e => `${e.action} ${e.target}`)).toEqual([
      `billing.checkout ${orderId}`,
    ])
    const qr = await f.handle(
      page(`/subscription/checkout?order=${orderId}`, f.unpaid),
    )
    expect(qr.status).toBe(200)
    const html = await qr.text()
    expect(html).toContain('<svg xmlns="http://www.w3.org/2000/svg"')
    expect(html).toContain('role="img" aria-label="微信支付付款二维码"')
    expect(html).not.toContain('url(')
    expect(html).toContain(`data-order="${orderId}"`)
    expect(html).toContain('data-state="created"')
    expect(html).toContain('/v0/billing/orders/')
    expect(html).toContain('data-source>源代码 · AGPL-3.0</a>')

    // The same order again: reused, not a second one.
    expect(await checkout(f, f.unpaid)).toBe(orderId)
    expect(f.billing.orders.size).toBe(1)

    const polled = await f.handle(
      call('GET', `/v0/billing/orders/${orderId}`, f.unpaid),
    )
    const view = (await polled.json()) as Record<string, unknown>
    expect(view['status']).toBe('created')
    expect('qrText' in view).toBe(false)

    f.billing.pay(orderId)
    const after = await (
      await f.handle(page(`/subscription/checkout?order=${orderId}`, f.unpaid))
    ).text()
    expect(after).not.toContain('付款二维码')
    expect(after).toContain('data-state="paid"')
  })

  test('an order is its owner’s alone', async () => {
    const f = publicConsole()
    const orderId = await checkout(f, f.unpaid)
    const page404 = await f.handle(
      page(`/subscription/checkout?order=${orderId}`, f.paid),
    )
    expect(page404.status).toBe(404)
    const api404 = await f.handle(
      call('GET', `/v0/billing/orders/${orderId}`, f.paid),
    )
    expect(api404.status).toBe(404)
  })

  test('cross-origin posts, unknown plans and closed channels are refused', async () => {
    const f = publicConsole()
    const fields = { plan: 'month', channel: 'wechatpay' }
    const crossOrigin: readonly Record<string, string>[] = [
      { 'sec-fetch-site': 'cross-site' },
      { origin: 'https://evil.example' },
    ]
    for (const extra of crossOrigin) {
      const response = await f.handle(checkoutForm(f.unpaid, fields, extra))
      expect(response.status).toBe(403)
    }
    expect(f.billing.orders.size).toBe(0)
    const unknown = await f.handle(
      page('/subscription/checkout?plan=nope&channel=wechatpay', f.unpaid),
    )
    expect(unknown.status).toBe(404)
    f.billing.siteView = {
      ...f.billing.siteView,
      channels: { wechatpay: true, alipay: false, redeem: true },
    }
    const closed = await f.handle(
      page('/subscription/checkout?plan=month&channel=alipay', f.unpaid),
    )
    expect(closed.status).toBe(400)
    const failed = await f.handle(
      checkoutForm(f.unpaid, { plan: 'month', channel: 'alipay' }),
    )
    expect(failed.status).toBe(400)
    expect(await failed.text()).toContain('没有下单')
  })

  test('the checkout is not for a token or a stranger', async () => {
    const f = publicConsole()
    const admin = await f.handle(page('/subscription', ADMIN))
    expect(admin.status).toBe(403)
    const anonymous = await f.handle(page('/subscription'))
    expect(anonymous.status).toBe(303)
    expect(anonymous.headers.get('location')).toBe(
      '/login?redirect=%2Fsubscription',
    )
  })
})

// ---------------------------------------------------------------------------
// /subscription
// ---------------------------------------------------------------------------

describe('/subscription', () => {
  test('not subscribed: buy, redeem, no models section', async () => {
    const f = publicConsole()
    const html = await (await f.handle(page('/subscription', f.unpaid))).text()
    expect(html).toContain('id="h-bl-renew">购买</h2>')
    expect(html).toContain('data-plan="month"')
    expect(html).toContain('data-plan="pro"')
    expect(html).toContain('id="bl-redeem-form"')
    expect(html).not.toContain('id="h-bl-models"')
    expect(html).toContain('data-source>源代码 · AGPL-3.0</a>')
    expect(html).not.toContain('url(')
  })

  test('subscribed: nodes n/N, the models section with the own-key form, usage, renew this plan', async () => {
    const f = publicConsole()
    const html = await (await f.handle(page('/subscription', f.paid))).text()
    expect(html).toContain('1/1 台')
    expect(html).toContain('id="h-bl-models">模型</h2>')
    expect(html).toContain(BYOK_LINE)
    expect(html).toContain('id="bl-model-form"')
    expect(html).toContain('type="password"')
    expect(html).toContain('网关用量 · 近 30 天 · 估算')
    expect(html).toContain('id="h-bl-renew">续费</h2>')
    expect(html).toContain('data-plan="month"')
    expect(html).not.toContain('data-plan="pro"')
  })

  test('waiting for a node, and more nodes than the plan', async () => {
    const f = publicConsole()
    const waiting = await (
      await f.handle(page('/subscription', f.waiting))
    ).text()
    expect(waiting).toContain('节点分配中')
    f.billing.activate(f.paid.subject, { nodes: 1, nodesMapped: 2 })
    const over = await (await f.handle(page('/subscription', f.paid))).text()
    expect(over).toContain('1/1 台')
    expect(over).toContain('超出的 1 台不下发模型配置')
  })
})

describe('the live switch', () => {
  test('off: every page says 未开通正式收款, no QR checkout, redeem still offered', async () => {
    const f = publicConsole()
    f.billing.siteView = {
      ...f.billing.siteView,
      live: false,
      channels: { wechatpay: false, alipay: false, redeem: true },
    }
    const plans = await (await f.handle(page('/plans'))).text()
    expect(plans).toContain('未开通正式收款')
    const mine = await (await f.handle(page('/subscription', f.unpaid))).text()
    expect(mine).toContain('未开通正式收款')
    expect(mine).not.toContain('name="channel"')
    expect(mine).toContain('id="bl-redeem-form"')
    const confirm = await f.handle(
      page('/subscription/checkout?plan=month&channel=wechatpay', f.unpaid),
    )
    expect(confirm.status).toBe(400)
    expect(await confirm.text()).toContain('未开通正式收款')
    const admin = await (
      await f.handle(page('/admin/billing', f.platform))
    ).text()
    expect(admin).toContain('id="bl-live"')
    expect(admin).toContain('未开通正式收款')
  })

  test('on: no such line on the public pages; the admin page says it is on', async () => {
    const f = publicConsole()
    expect(f.billing.siteView.live).toBe(true)
    for (const path of ['/plans', '/subscription']) {
      const html = await (await f.handle(page(path, f.unpaid))).text()
      expect(`${path} ${html.includes('未开通正式收款')}`).toBe(`${path} false`)
    }
    const admin = await (
      await f.handle(page('/admin/billing', f.platform))
    ).text()
    expect(admin).toContain('正式收款已开通')
  })
})

// ---------------------------------------------------------------------------
// The member API
// ---------------------------------------------------------------------------

describe('a member’s own models', () => {
  test('connect and remove an upstream; the key is never answered; both recorded', async () => {
    const f = publicConsole()
    const added = await f.handle(
      call('POST', '/v0/billing/models', f.paid, {
        preset: 'anthropic',
        key: 'sk-secret-value',
      }),
    )
    expect(added.status).toBe(200)
    const text = await added.text()
    expect(text).not.toContain('sk-secret-value')
    const { id } = JSON.parse(text) as { id: string }
    const removed = await f.handle(
      call('DELETE', `/v0/billing/models/${id}`, f.paid),
    )
    expect(removed.status).toBe(204)
    expect(
      f.actions.entries.map(e => `${e.subject} ${e.action} ${e.target}`),
    ).toEqual([
      `${f.paid.subject} billing.model.add ${id}`,
      `${f.paid.subject} billing.model.remove ${id}`,
    ])
  })

  test('bad input is refused before the port; tokens are not people', async () => {
    const f = publicConsole()
    for (const body of [
      { preset: 'Bad Preset', key: 'k' },
      { preset: 'anthropic', key: '' },
    ]) {
      const response = await f.handle(
        call('POST', '/v0/billing/models', f.paid, body),
      )
      expect(response.status).toBe(400)
    }
    const admin = await f.handle(call('GET', '/v0/billing/me', ADMIN))
    expect(admin.status).toBe(403)
    expect(f.billing.calls.filter(c => c.startsWith('addUpstream'))).toEqual([])
  })
})

describe('redeem, and a tenant made mid-request', () => {
  test('a code opens the plan; the tenant revision it causes does not void the answer', async () => {
    const f = publicConsole()
    const minted = await f.handle(
      call('POST', '/v0/billing/admin/codes', f.platform, {
        planId: 'month',
        periods: 1,
        count: 2,
      }),
    )
    expect(minted.status).toBe(200)
    const { codes } = (await minted.json()) as { codes: string[] }
    expect(codes).toHaveLength(2)
    // The plaintext is in that one answer, not in the admin snapshot.
    const snapshot = await (
      await f.handle(call('GET', '/v0/billing/admin', f.platform))
    ).text()
    expect(snapshot).not.toContain(codes[0] ?? '-')

    const redeem = f.billing.redeem.bind(f.billing)
    f.billing.redeem = async (subject, code) => {
      const result = await redeem(subject, code)
      f.bump()
      return result
    }
    const redeemed = await f.handle(
      call('POST', '/v0/billing/redeem', f.unpaid, { code: codes[0] }),
    )
    expect(redeemed.status).toBe(200)
    expect(((await redeemed.json()) as { active: boolean }).active).toBe(true)
    // Any other request caught in a revision change is still refused.
    const admin = f.billing.admin.bind(f.billing)
    f.billing.admin = async () => {
      f.bump()
      return admin()
    }
    const refused = await f.handle(call('GET', '/v0/billing/admin', f.platform))
    expect(refused.status).toBe(403)
  })
})

// ---------------------------------------------------------------------------
// Platform ops
// ---------------------------------------------------------------------------

describe('订阅 for platform ops', () => {
  test('a platform reader sees the page and the area; a member does not', async () => {
    const f = publicConsole()
    const ok = await f.handle(page('/admin/billing', f.platform))
    expect(ok.status).toBe(200)
    const html = await ok.text()
    expect(html).toContain('href="/admin/billing"')
    expect(html).toContain('id="bl-grant-dialog"')
    expect(html).toContain('id="bl-codes-dialog"')
    const member = await f.handle(page('/admin/billing', f.paid))
    expect(member.status).toBe(404)
    const api = await f.handle(call('GET', '/v0/billing/admin', f.paid))
    expect(api.status).toBe(403)
  })

  test('break-glass reads but does not write; a non-platform ops cannot write', async () => {
    const f = publicConsole({ breakGlass: true })
    const read = await f.handle(call('GET', '/v0/billing/admin', ADMIN))
    expect(read.status).toBe(200)
    const grant = {
      subject: f.unpaid.subject,
      planId: 'pro',
      periods: 1,
      reason: '试用',
    }
    // Subscribed, so the refusal is the writer rule and not the gate.
    f.billing.activate(f.ops.subject)
    for (const who of [ADMIN, f.ops] as const) {
      const response = await f.handle(
        call('POST', '/v0/billing/admin/grant', who, grant),
      )
      expect(response.status).toBe(403)
    }
    expect(f.billing.calls.filter(c => c.startsWith('grant'))).toEqual([])
  })

  test('grant, refund, codes and verify, each recorded under the platform subject', async () => {
    const f = publicConsole()
    const granted = await f.handle(
      call('POST', '/v0/billing/admin/grant', f.platform, {
        subject: f.unpaid.subject,
        planId: 'pro',
        periods: 2,
        reason: '试用',
      }),
    )
    expect(granted.status).toBe(200)
    expect((await f.billing.standing(f.unpaid.subject)).nodes).toBe(3)

    const orderId = await checkout(f, f.expired)
    f.billing.pay(orderId)
    const refunded = await f.handle(
      call('POST', '/v0/billing/admin/refund', f.platform, {
        orderId,
        reason: '商户平台已退',
      }),
    )
    expect(refunded.status).toBe(200)
    const verify = await f.handle(
      call('GET', '/v0/billing/admin/verify', f.platform),
    )
    expect(await verify.json()).toEqual({ ok: true, events: 1 })
    expect(
      f.actions.entries
        .filter(e => e.subject === f.platform.subject)
        .map(e => `${e.action} ${e.target} ${e.outcome}`),
    ).toEqual([
      `billing.grant ${f.unpaid.subject} ok`,
      `billing.refund ${orderId} ok`,
    ])
  })

  test('orders paid while another plan was active are listed as owed a refund', async () => {
    const f = publicConsole()
    const orderId = await checkout(f, f.expired)
    f.billing.pay(orderId)
    f.billing.refundsDue = [
      {
        orderId,
        subject: f.expired.subject,
        planId: 'month',
        activePlanId: 'pro',
        amountCents: 9900,
        channel: 'wechatpay',
        outTradeNo: 'Q'.repeat(32),
        paidAt: f.now,
      },
    ]
    const html = await (
      await f.handle(page('/admin/billing', f.platform))
    ).text()
    expect(html).toContain('id="h-bl-a-refunds">待退款</h2>')
    const section = html.slice(html.indexOf('id="h-bl-a-refunds"'))
    expect(section).toContain(`data-key="${orderId}"`)
    expect(section).toContain('团队')
    expect(section).toContain(`data-action="bl-refund" data-order="${orderId}"`)
    expect(html).toContain('已支付 · 待退款')
    // A reader who cannot write sees the list without the button.
    const reader = publicConsole({ breakGlass: true })
    const readerOrder = await checkout(reader, reader.expired)
    reader.billing.pay(readerOrder)
    reader.billing.refundsDue = f.billing.refundsDue.map(row => ({
      ...row,
      orderId: readerOrder,
    }))
    const read = await (
      await reader.handle(page('/admin/billing', ADMIN))
    ).text()
    expect(read).toContain('id="h-bl-a-refunds">待退款</h2>')
    expect(read).not.toContain('data-action="bl-refund"')
    // Nothing owed: no section.
    f.billing.refundsDue = []
    const none = await (
      await f.handle(page('/admin/billing', f.platform))
    ).text()
    expect(none).not.toContain('h-bl-a-refunds')
  })

  test('admin input is checked before the port', async () => {
    const f = publicConsole()
    for (const [path, body] of [
      [
        '/v0/billing/admin/grant',
        { subject: 'bob', planId: 'month', periods: 1, reason: 'x' },
      ],
      [
        '/v0/billing/admin/grant',
        { subject: f.unpaid.subject, planId: 'month', periods: 0, reason: 'x' },
      ],
      ['/v0/billing/admin/refund', { orderId: 'nope', reason: 'x' }],
      ['/v0/billing/admin/codes', { planId: 'month', periods: 1, count: 5000 }],
    ] as const) {
      const response = await f.handle(call('POST', path, f.platform, body))
      expect(`${path} ${response.status}`).toBe(`${path} 400`)
    }
  })
})
