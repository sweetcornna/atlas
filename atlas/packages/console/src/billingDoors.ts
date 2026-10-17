// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The public edition's doors (P35), dispatched by `http.ts` only when the
 * billing port is wired; without it every path here is the plain 404 it
 * always was (`test/legacyParity.test.ts`).
 *
 * | Path | Who | What |
 * | --- | --- | --- |
 * | `POST /v0/billing/notify/{wechatpay,alipay}` | the payment platform | answered before any credential is read: the raw body as text, untouched, to the channel's verifier; the channel's reply verbatim |
 * | `GET /plans` | anyone | plan cards, sign-in and sign-up, the source link |
 * | `GET /subscription` | a signed-in person | their subscription, nodes, models, usage, renewal, orders |
 * | `GET /subscription/checkout?plan=&channel=` | a signed-in person | confirm, with a same-origin form |
 * | `POST /subscription/checkout` | a signed-in person | create or reuse the order, 303 to it |
 * | `GET /subscription/checkout?order=<id>` | the order's owner | the QR, polled until paid or closed |
 *
 * ## The subscription gate
 *
 * {@link subscriptionDenial} is the one place a member without an active
 * subscription is stopped: `http.ts` asks it for every request, right after
 * the tenant scope, before the action ledger and before any route. A write
 * by a non-platform person (or a device acting for one) whose subscription
 * is not active answers **402 `subscription_required`**, whatever route it
 * was for. Reads pass (their own history stays readable), and so do the
 * doors, the two writes that make a person a subscriber (checkout and
 * redeem), and `DELETE /v0/billing/models/<id>`: a lapsed subscriber can
 * still take their own upstream key back out of the gateway. Platform
 * subjects and break-glass are never gated.
 *
 * `/` (`publicFrontDoor`) follows the same standing: signed out it is the
 * plans page; signed in without a subscription a card that points at
 * `/subscription`; subscribed while the tenant has no node yet, 节点分配中;
 * otherwise the conversation front as before.
 */

import type { Access } from './access.js'
import { isCrossOriginRequest } from './auth.js'
import type { ConsoleDeps } from './deps.js'
import {
  BILLING_CHANNELS,
  type BillingChannel,
  type BillingPort,
} from './directionPorts.js'
import {
  fail,
  html,
  methodNotAllowed,
  notFound,
  readForm,
  seeOther,
} from './respond.js'
import { billingSubject } from './routes/billingApi.js'
import { DEFAULT_LABEL } from './routes/shared.js'
import type { RouteContext } from './routes/types.js'
import type { TenantScope } from './tenancy.js'
import {
  renderBillingNotice,
  renderCheckoutConfirm,
  renderCheckoutPage,
  renderPlansPage,
  renderStandingCard,
  renderSubscriptionPage,
} from './view/billing.js'
import { BILLING_PUBLIC_JS } from './view/billingScript.js'
import { humanizeError } from './view/errors.js'

/** A notification body larger than this is not one the channels send. */
export const MAX_NOTIFY_BYTES = 64 * 1024

const ORDER_ID = /^ord_[A-Za-z0-9]{22}$/
const PLAN_ID = /^[a-z0-9][a-z0-9_-]{0,31}$/

function isChannel(value: string | null | undefined): value is BillingChannel {
  return (BILLING_CHANNELS as readonly string[]).includes(value ?? '')
}

// --- notifications -----------------------------------------------------

/** `wechatpay` / `alipay` when the path is a notify route, else null. */
export function notifyChannelOf(segments: readonly string[]): string | null {
  if (
    segments.length === 4 &&
    segments[0] === 'v0' &&
    segments[1] === 'billing' &&
    segments[2] === 'notify'
  )
    return segments[3] ?? null
  return null
}

/**
 * The body as UTF-8 text, or `null` once it passes `limit` bytes: reading
 * stops there and the stream is cancelled, so a sender without a
 * `Content-Length` cannot make the hub hold more than the cap.
 */
async function boundedText(
  request: Request,
  limit: number,
): Promise<string | null> {
  if (request.body === null) return ''
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > limit) return null
      chunks.push(chunk.value)
    }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * One payment notification: public, no login, no console header. The body
 * is read once (at most {@link MAX_NOTIFY_BYTES}, as a stream) and handed
 * over untouched — the signature covers those exact bytes — and the
 * channel's reply goes back as it is.
 */
export async function serveBillingNotify(
  request: Request,
  billing: BillingPort,
  channel: string,
): Promise<Response> {
  if (!isChannel(channel))
    return notFound(`unknown path: ${new URL(request.url).pathname}`)
  if (request.method !== 'POST') return methodNotAllowed(['POST'])
  const declared = Number(request.headers.get('content-length') ?? '0')
  if (declared > MAX_NOTIFY_BYTES) {
    await request.body?.cancel()
    return fail(413, 'invalid', '通知过大')
  }
  const rawBody = await boundedText(request, MAX_NOTIFY_BYTES)
  if (rawBody === null) return fail(413, 'invalid', '通知过大')
  const contentType = request.headers.get('content-type')
  const reply = await billing.notify(channel, {
    headers: request.headers,
    rawBody,
    ...(contentType === null ? {} : { contentType }),
  })
  // A null-body status (204, 304) takes no body at all, not an empty one.
  const empty = reply.httpStatus === 204 || reply.httpStatus === 304
  return new Response(empty ? null : reply.body, {
    status: reply.httpStatus,
    headers: { 'cache-control': 'no-store', ...reply.headers },
  })
}

// --- the gate ----------------------------------------------------------

/** Writes a person without a subscription may still make. */
function ungated(method: string, segments: readonly string[]): boolean {
  const [head, second, third] = segments
  if (
    segments.length === 1 &&
    ['login', 'logout', 'signup', 'invite'].includes(head ?? '')
  )
    return true
  if (head === 'subscription' && second === 'checkout') return true
  if (head !== 'v0' || second !== 'billing') return false
  if (segments.length === 3) return third === 'checkout' || third === 'redeem'
  // Their own upstream key, out of the gateway, whatever their standing.
  return segments.length === 4 && third === 'models' && method === 'DELETE'
}

/**
 * Requests that may open a subscription and so create the subscriber's
 * tenant mid-request: a member's own subscription pages and routes (polling
 * an order can find it paid), and ops' grant. Their answers are about that
 * subscription only, so `http.ts` does not refuse them for the tenant
 * revision they caused; every other request still is.
 */
export function provisioningPath(segments: readonly string[]): boolean {
  const [head, second, third, fourth] = segments
  if (head === 'subscription') return segments.length <= 2
  if (head !== 'v0' || second !== 'billing') return false
  if (segments.length === 3)
    return ['me', 'checkout', 'redeem', 'models'].includes(third ?? '')
  return (
    segments.length === 4 &&
    (third === 'orders' ||
      third === 'models' ||
      (third === 'admin' && fourth === 'grant'))
  )
}

/** The subject a request acts for: the person, or a device's owner. */
function actingSubject(access: Access): string | null {
  const principal = access.principal
  if (principal?.kind === 'user') return principal.subject
  if (principal?.kind === 'device') return principal.owner
  return null
}

/**
 * The public edition's subscription gate (see the module note). `null` lets
 * the request on; otherwise the 402 it ends with.
 */
export async function subscriptionDenial(
  request: Request,
  segments: readonly string[],
  deps: ConsoleDeps,
  access: Access,
  scope: TenantScope | undefined,
): Promise<Response | null> {
  const billing = deps.billing
  if (billing === undefined) return null
  if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return null
  if (access.breakGlass || scope?.platform === true) return null
  const subject = actingSubject(access)
  // The legacy tokens are the platform's own (and the view token is off in
  // the public edition).
  if (subject === null) return null
  if (ungated(request.method, segments)) return null
  const standing = await billing.standing(subject)
  if (standing.active) return null
  return fail(402, 'subscription_required', '需要有效订阅 · 在订阅页购买或续费')
}

// --- pages -------------------------------------------------------------

function labelOf(deps: ConsoleDeps): string {
  return deps.label ?? DEFAULT_LABEL
}

/** `/plans`: public. */
export function servePlans(
  request: Request,
  deps: ConsoleDeps,
  billing: BillingPort,
  access: Access,
  signup: boolean,
): Response {
  if (request.method !== 'GET') return methodNotAllowed(['GET'])
  return html(
    renderPlansPage({
      label: labelOf(deps),
      site: billing.site(),
      signedIn: billingSubjectOf(access) !== null,
      signup,
    }),
  )
}

function billingSubjectOf(access: Access): string | null {
  return access.principal?.kind === 'user' ? access.principal.subject : null
}

/** Platform members of a tenancy, and break-glass, are not subscribers. */
function platformCaller(ctx: RouteContext): boolean {
  if (ctx.access.breakGlass) return true
  const subject = billingSubject(ctx)
  const tenancy = ctx.deps.tenancy
  if (subject === null || tenancy === undefined) return false
  try {
    return tenancy.read().config.platformSubjects.includes(subject)
  } catch {
    return false
  }
}

/**
 * `/` in the public edition, before the conversation front. `null` hands
 * the request to the front as it always was.
 */
export async function publicFrontDoor(
  ctx: RouteContext,
): Promise<Response | null> {
  const billing = ctx.deps.billing
  if (billing === undefined || ctx.request.method !== 'GET') return null
  if (ctx.access.credential.role === 'none')
    return html(
      renderPlansPage({
        label: labelOf(ctx.deps),
        site: billing.site(),
        signedIn: false,
        signup:
          ctx.accounts?.signup !== undefined && ctx.deps.tenancy !== undefined,
      }),
    )
  const subject = billingSubject(ctx)
  if (subject === null || platformCaller(ctx)) return null
  const standing = await billing.standing(subject)
  if (standing.active && standing.nodesMapped > 0) return null
  return html(renderStandingCard(labelOf(ctx.deps), billing.site(), standing))
}

/**
 * `/subscription` and `/subscription/checkout`. The caller has already been
 * through the credential checks of `http.ts`; `denied` is the answer for a
 * caller who is not a signed-in person.
 */
export async function serveSubscription(
  ctx: RouteContext,
  billing: BillingPort,
  segments: readonly string[],
  denied: () => Response,
): Promise<Response> {
  const subject = billingSubject(ctx)
  if (subject === null) return denied()
  if (segments.length === 1) {
    if (ctx.request.method !== 'GET') return methodNotAllowed(['GET'])
    const [me, presets] = await Promise.all([
      billing.me(subject),
      billing.presets(),
    ])
    return html(
      renderSubscriptionPage(
        {
          label: labelOf(ctx.deps),
          site: billing.site(),
          me: me.ok ? me.value : null,
          failure: me.ok ? null : me.failure,
          presets: presets.ok ? presets.value : null,
        },
        BILLING_PUBLIC_JS,
      ),
    )
  }
  if (segments.length === 2 && segments[1] === 'checkout')
    return serveCheckout(ctx, billing, subject)
  return notFound(`unknown path: ${ctx.url.pathname}`)
}

async function serveCheckout(
  ctx: RouteContext,
  billing: BillingPort,
  subject: string,
): Promise<Response> {
  const { request, url } = ctx
  const site = billing.site()
  if (request.method === 'POST') {
    const origin = request.headers.get('origin')
    if (
      isCrossOriginRequest(request) ||
      (origin !== null && origin !== url.origin)
    )
      return fail(403, 'forbidden', '下单只接受本控制台页面的提交')
    const form = await readForm(request)
    const planId = form?.get('plan')
    const channel = form?.get('channel')
    if (typeof planId !== 'string' || !PLAN_ID.test(planId))
      return fail(400, 'invalid', '套餐无效')
    if (typeof channel !== 'string' || !isChannel(channel))
      return fail(400, 'invalid', '付款方式只能是微信支付或支付宝')
    const busy = await ctx.admit()
    if (busy !== null) return busy
    const created = await billing.checkout(subject, planId, channel)
    await ctx.record(
      'billing.checkout',
      created.ok ? created.value.orderId : planId,
      created.ok ? 'ok' : 'failed',
      created.ok ? undefined : created.failure.code,
    )
    if (!created.ok) {
      const notice = renderBillingNotice(
        labelOf(ctx.deps),
        site,
        '没有下单',
        humanizeError(created.failure).text,
        created.failure.code === 'unreachable' ? 503 : 400,
      )
      return html(notice.html, notice.status)
    }
    return seeOther(
      `/subscription/checkout?order=${encodeURIComponent(created.value.orderId)}`,
    )
  }
  if (request.method !== 'GET') return methodNotAllowed(['GET', 'POST'])
  const orderId = url.searchParams.get('order')
  if (orderId !== null) {
    if (!ORDER_ID.test(orderId)) return notFound('订单不存在')
    const order = await billing.order(subject, orderId)
    if (!order.ok) return notFound('订单不存在')
    const { qrText, ...view } = order.value
    return html(
      renderCheckoutPage(
        { label: labelOf(ctx.deps), site, order: view, qrText },
        BILLING_PUBLIC_JS,
      ),
    )
  }
  const planId = url.searchParams.get('plan')
  const channel = url.searchParams.get('channel')
  const plan = site.plans.find(one => one.id === planId)
  if (plan === undefined) return notFound('套餐不存在')
  if (!isChannel(channel) || !site.channels[channel])
    return fail(400, 'invalid', '这个付款方式没有开通')
  return html(
    renderCheckoutConfirm({ label: labelOf(ctx.deps), site, plan, channel }),
  )
}
