// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 公开版订阅（P35）的页面：公开的套餐页、成员的订阅页与结账页、`/` 上的两张
 * 状态卡，以及平台运维的「订阅」页。
 *
 * 公开的几页与 `/signup`、`/login` 同一套版式：一张卡片放在素底上，服务端
 * 渲染，一页一个 `<style>`、至多一个 `<script>`，CSP 按哈希（`respond.ts`）。
 * 每一页的页脚都有对应源代码的链接（AGPL 第 13 条，`sourceUrl` 必填）。
 *
 * 套餐卖的是托管节点，不是模型额度：卡片写价格、周期、含几台节点与说明，另有
 * 一句「模型接入订阅者自有的 API 密钥」。二维码用本包唯一的编码器（`qr.ts`）画成内联
 * SVG，页面不加载任何外部资源。
 */

import type { ConsoleFailure } from '../deps.js'
import type {
  BillingAdminView,
  BillingChannel,
  BillingMeView,
  BillingOrderStatus,
  BillingOrderView,
  BillingPlanView,
  BillingPresetView,
  BillingSiteView,
  BillingStanding,
} from '../directionPorts.js'
import {
  absent,
  failureBar,
  icon,
  scroll,
  sectionHead,
  state,
  tag,
  timeTag,
} from './bits.js'
import { attr, escapeHtml } from './escape.js'
import {
  actionButton,
  dialogActions,
  dialogTop,
  emptyState,
  selectField,
  textField,
  unwiredCard,
} from './kit.js'
import { qianmoMark } from './mark.js'
import { documentHead } from './page.js'
import { qrSvg } from './qr.js'
import { sourceFooter } from './source.js'

/** 支付方式在页面上的名字。 */
const CHANNEL_WORD: Readonly<Record<BillingChannel, string>> = {
  wechatpay: '微信支付',
  alipay: '支付宝',
}

const ORDER_WORD: Readonly<Record<BillingOrderStatus, string>> = {
  created: '待支付',
  paid: '已支付',
  closed: '已关闭',
  expired: '已过期',
  refunded: '已退款',
}

/** 模型怎么接：卡片下面那一句，文案门禁同其他页。 */
export const BYOK_LINE = '模型接入订阅者自有的 API 密钥 · 经平台网关统一调度'

/** 没开正式收款时公开页上的那一句；开了就没有。 */
function notLiveLine(site: BillingSiteView): string {
  if (site.live) return ''
  const tail = site.channels.redeem ? ' · 可用兑换码开通' : ''
  return `<p class="bl-live note" role="note">未开通正式收款 · 暂不接受扫码付款${tail}</p>`
}

/** 整数分写成元：`9900` → `99`，`990` → `9.90`。 */
function yuan(cents: number): string {
  return cents % 100 === 0 ? String(cents / 100) : (cents / 100).toFixed(2)
}

function planName(plans: readonly BillingPlanView[], id: string): string {
  return plans.find(plan => plan.id === id)?.name ?? id
}

function channelName(channel: string): string {
  return channel === 'wechatpay' || channel === 'alipay'
    ? CHANNEL_WORD[channel]
    : channel
}

// --- the public frame --------------------------------------------------

/** 每个公开页面的页脚：源代码链接，有条款时再给条款（`source.ts`，与登录、注册、邀请页和前台同一个）。 */
function billingFooter(site: BillingSiteView): string {
  return sourceFooter(site, 'bl-foot')
}

function brandRow(label: string): string {
  return (
    `<div class="brand">${qianmoMark(28)}<div class="brand-cn">阡陌</div></div>` +
    `<p class="inst"><b>${escapeHtml(label)}</b></p>`
  )
}

/** 一张公开页：卡片、页脚，一个样式，至多一个脚本。 */
function publicDocument(
  title: string,
  label: string,
  site: BillingSiteView,
  body: string,
  script?: string,
): string {
  const scripts = script === undefined ? [] : [script]
  return (
    documentHead(`${title} · ${label}`, BILLING_PUBLIC_CSS, scripts) +
    `<body>\n<main class="stage bl-stage" aria-labelledby="page-title">\n` +
    `<section class="card elev-lg bl-sheet">${brandRow(label)}${body}` +
    `${billingFooter(site)}</section>\n</main>\n` +
    (script === undefined ? '' : `<script>${script}</script>\n`) +
    `</body>\n</html>\n`
  )
}

function planCard(plan: BillingPlanView, action = ''): string {
  return (
    `<article class="bl-plan card elev-sm" data-plan="${attr(plan.id)}">` +
    `<h2 class="bl-plan-name">${escapeHtml(plan.name)}</h2>` +
    `<p class="bl-price"><b>${escapeHtml(yuan(plan.priceCents))}</b> 元` +
    `<span class="note"> / ${plan.periodDays} 天</span></p>` +
    `<p class="bl-nodes">${icon('server', { small: true })}含 ${plan.nodes} 台托管节点</p>` +
    (plan.note === null ? '' : `<p class="note">${escapeHtml(plan.note)}</p>`) +
    action +
    `</article>`
  )
}

interface PlansPageModel {
  readonly label: string
  readonly site: BillingSiteView
  readonly signedIn: boolean
  readonly signup: boolean
}

/** `/plans`，也是公开版里匿名访客在 `/` 看到的页。 */
export function renderPlansPage(model: PlansPageModel): string {
  const links = model.signedIn
    ? `<a class="btn btn-primary" href="/subscription">我的订阅</a>`
    : `<a class="btn btn-primary" href="/login?redirect=%2Fsubscription">登录</a>` +
      (model.signup
        ? `<a class="btn btn-secondary" href="/signup">注册</a>`
        : '')
  return publicDocument(
    '套餐',
    model.label,
    model.site,
    `<h1 class="page-title" id="page-title">套餐</h1>` +
      `<p class="bl-lead">按托管节点订阅 · 预付周期 · 到期不自动扣款</p>` +
      notLiveLine(model.site) +
      `<div class="bl-plans">${model.site.plans.map(plan => planCard(plan)).join('')}</div>` +
      `<p class="bl-byok note">${escapeHtml(BYOK_LINE)}</p>` +
      `<div class="bl-actions">${links}</div>`,
  )
}

/** 公开版的 `/`：已登录但还不能对话的人看到的那张卡。 */
export function renderStandingCard(
  label: string,
  site: BillingSiteView,
  standing: BillingStanding,
): string {
  const waiting = standing.active
  const title = waiting
    ? '节点分配中'
    : standing.endsAt === null
      ? '还没有订阅'
      : '订阅已到期'
  const line = waiting
    ? '订阅已生效 · 节点分配完成后可用'
    : standing.endsAt === null
      ? '订阅套餐后可用'
      : '续费后立即恢复'
  return publicDocument(
    title,
    label,
    site,
    `<h1 class="page-title" id="page-title">${escapeHtml(title)}</h1>` +
      `<p class="bl-lead">${escapeHtml(line)}</p>` +
      `<div class="bl-actions"><a class="btn btn-primary" href="/subscription">我的订阅</a>` +
      `<a class="btn btn-secondary" href="/plans">套餐</a></div>`,
  )
}

/** A refusal on a public form (a POST a browser made), drawn as a card. */
export function renderBillingNotice(
  label: string,
  site: BillingSiteView,
  title: string,
  line: string,
  status = 400,
): { readonly html: string; readonly status: number } {
  return {
    status,
    html: publicDocument(
      title,
      label,
      site,
      `<h1 class="page-title" id="page-title">${escapeHtml(title)}</h1>` +
        `<p class="bl-lead" role="alert">${escapeHtml(line)}</p>` +
        `<div class="bl-actions"><a class="btn btn-primary" href="/subscription">回到订阅</a></div>`,
    ),
  }
}

// --- /subscription -----------------------------------------------------

interface SubscriptionPageModel {
  readonly label: string
  readonly site: BillingSiteView
  readonly me: BillingMeView | null
  readonly failure: ConsoleFailure | null
  readonly presets: readonly BillingPresetView[] | null
}

function standingSection(
  site: BillingSiteView,
  standing: BillingStanding,
): string {
  const status = standing.active
    ? state('ok', '有效')
    : standing.endsAt === null
      ? state('muted', '未订阅')
      : state('bad', '已到期')
  const plan =
    standing.planId === null ? absent() : planName(site.plans, standing.planId)
  const ends =
    standing.endsAt === null ? absent() : timeTag(standing.endsAt, 'minute')
  const nodes = standing.active
    ? standing.nodesMapped === 0
      ? state('warn', '节点分配中')
      : `${Math.min(standing.nodesMapped, standing.nodes)}/${standing.nodes} 台`
    : absent()
  const over =
    standing.active && standing.nodesMapped > standing.nodes
      ? `<p class="note">分到的节点多于套餐 · 超出的 ${standing.nodesMapped - standing.nodes} 台不下发模型配置</p>`
      : ''
  return (
    `<section class="bl-sec" aria-labelledby="h-bl-standing">` +
    `<h2 id="h-bl-standing">订阅</h2>` +
    `<div class="bl-facts">` +
    `<div class="bl-fact"><span class="note">状态</span><span>${status}</span></div>` +
    `<div class="bl-fact"><span class="note">套餐</span><span>${typeof plan === 'string' ? escapeHtml(plan) : plan}</span></div>` +
    `<div class="bl-fact"><span class="note">到期</span><span>${ends}</span></div>` +
    `<div class="bl-fact" id="bl-nodes"><span class="note">节点</span><span>${nodes}</span></div>` +
    `</div>${over}</section>`
  )
}

function gatewayWord(gateway: BillingMeView['gateway']): string {
  if (gateway === 'on') return state('ok', '可用')
  if (gateway === 'off') return state('muted', '停用')
  return state('muted', '未开通')
}

function modelsSection(
  me: BillingMeView,
  presets: readonly BillingPresetView[] | null,
): string {
  const active = me.standing.active
  const rows = me.upstreams.map(
    one =>
      `<tr data-key="${attr(one.id)}">` +
      `<td><b>${escapeHtml(one.name)}</b> <span class="kit-mono">${escapeHtml(one.id)}</span></td>` +
      `<td>${escapeHtml(one.preset)}</td>` +
      `<td>${one.models}</td>` +
      `<td>${one.present ? (one.ready ? state('ok', '可用') : state('warn', '未就绪')) : state('bad', '网关里已不在')}</td>` +
      `<td class="acts">${actionButton('bl-model-remove', '删除', {
        tone: 'ghost',
        data: { id: one.id, name: one.name },
      })}</td></tr>`,
  )
  const list =
    rows.length === 0
      ? `<p class="note" id="bl-models-empty">还没有接入上游 · 接入之前网关密钥保持停用</p>`
      : scroll(
          `<table class="trail"><caption class="sr-only">我的上游</caption>` +
            `<thead><tr><th scope="col">名称</th><th scope="col">预设</th><th scope="col">模型</th>` +
            `<th scope="col">状态</th><th scope="col"></th></tr></thead>` +
            `<tbody>${rows.join('')}</tbody></table>`,
        )
  const form =
    active && presets !== null && presets.length > 0
      ? `<form class="bl-form" id="bl-model-form" novalidate>` +
        selectField(
          'preset',
          '预设',
          presets.map(one => [one.id, one.name] as const),
          { required: true, form: 'bl' },
        ) +
        textField('key', '上游 API 密钥', {
          type: 'password',
          required: true,
          mono: true,
          maxLength: 4096,
          help: '只交给平台网关 · 保存后不回显',
          form: 'bl',
        }) +
        `<button type="submit" class="btn btn-primary">接入</button></form>`
      : active && presets === null
        ? `<p class="note">网关暂时不可用 · 稍后再接入</p>`
        : ''
  return (
    `<section class="bl-sec" aria-labelledby="h-bl-models">` +
    `<h2 id="h-bl-models">模型</h2>` +
    `<p class="note">${escapeHtml(BYOK_LINE)}</p>` +
    `<div class="bl-facts">` +
    `<div class="bl-fact"><span class="note">网关密钥</span><span>${gatewayWord(me.gateway)}</span></div>` +
    `<div class="bl-fact"><span class="note">主模型</span><span>${me.mainModel === null ? absent() : `<span class="kit-mono">${escapeHtml(me.mainModel)}</span>`}</span></div>` +
    `</div>${list}${form}</section>`
  )
}

function usageSection(me: BillingMeView): string {
  const usage = me.usage
  const body =
    usage === null
      ? `<p class="note">网关用量暂时读不到</p>`
      : `<div class="bl-facts">` +
        `<div class="bl-fact"><span class="note">调用</span><span>${usage.calls}</span></div>` +
        `<div class="bl-fact"><span class="note">输入 token</span><span>${usage.input}</span></div>` +
        `<div class="bl-fact"><span class="note">输出 token</span><span>${usage.output}</span></div>` +
        `<div class="bl-fact"><span class="note">费用 · 估算</span><span>$${usage.cost.toFixed(2)}</span></div>` +
        `</div>`
  return (
    `<section class="bl-sec" aria-labelledby="h-bl-usage">` +
    `<h2 id="h-bl-usage">网关用量 · 近 30 天 · 估算</h2>${body}</section>`
  )
}

function buyButtons(site: BillingSiteView, planId: string): string {
  const channels = (['wechatpay', 'alipay'] as const).filter(
    channel => site.channels[channel],
  )
  if (channels.length === 0) return ''
  return (
    `<form class="bl-buy" method="post" action="/subscription/checkout">` +
    `<input type="hidden" name="plan" value="${attr(planId)}">` +
    channels
      .map(
        channel =>
          `<button type="submit" class="btn btn-secondary btn-small" name="channel" value="${channel}">` +
          `${escapeHtml(CHANNEL_WORD[channel])}</button>`,
      )
      .join('') +
    `</form>`
  )
}

function renewSection(
  site: BillingSiteView,
  standing: BillingStanding,
): string {
  // One plan at a time: while one is active only it can be renewed.
  const plans = standing.active
    ? site.plans.filter(plan => plan.id === standing.planId)
    : site.plans
  const anyChannel = site.channels.wechatpay || site.channels.alipay
  const cards = anyChannel
    ? `<div class="bl-plans">${plans.map(plan => planCard(plan, buyButtons(site, plan.id))).join('')}</div>`
    : ''
  const redeem = site.channels.redeem
    ? `<form class="bl-form bl-inline" id="bl-redeem-form" novalidate>` +
      textField('code', '兑换码', {
        required: true,
        mono: true,
        maxLength: 64,
        form: 'bl',
      }) +
      `<button type="submit" class="btn btn-secondary">兑换</button></form>`
    : ''
  return (
    `<section class="bl-sec" aria-labelledby="h-bl-renew">` +
    `<h2 id="h-bl-renew">${standing.active ? '续费' : '购买'}</h2>` +
    `${notLiveLine(site)}${cards}${redeem}</section>`
  )
}

function ordersSection(
  site: BillingSiteView,
  orders: readonly BillingOrderView[],
): string {
  const body =
    orders.length === 0
      ? `<p class="note">还没有订单</p>`
      : scroll(
          `<table class="trail"><caption class="sr-only">订单</caption>` +
            `<thead><tr><th scope="col">时间</th><th scope="col">套餐</th><th scope="col">金额</th>` +
            `<th scope="col">方式</th><th scope="col">状态</th></tr></thead><tbody>` +
            orders
              .map(
                order =>
                  `<tr data-key="${attr(order.orderId)}"><td>${timeTag(order.createdAt, 'minute')}</td>` +
                  `<td>${escapeHtml(planName(site.plans, order.planId))}</td>` +
                  `<td>${escapeHtml(yuan(order.amountCents))} 元</td>` +
                  `<td>${escapeHtml(channelName(order.channel))}</td>` +
                  `<td>${order.status === 'created' ? `<a href="/subscription/checkout?order=${encodeURIComponent(order.orderId)}">${escapeHtml(ORDER_WORD.created)}</a>` : escapeHtml(ORDER_WORD[order.status])}</td></tr>`,
              )
              .join('') +
            `</tbody></table>`,
        )
  return (
    `<section class="bl-sec" aria-labelledby="h-bl-orders">` +
    `<h2 id="h-bl-orders">订单</h2>${body}</section>`
  )
}

/** `/subscription`：成员自己的订阅、节点、模型、用量、续费与订单。 */
export function renderSubscriptionPage(
  model: SubscriptionPageModel,
  script: string,
): string {
  const me = model.me
  const body =
    me === null
      ? failureBar(
          model.failure ?? { code: 'unreachable', message: '订阅读不到' },
          '订阅',
        )
      : standingSection(model.site, me.standing) +
        (me.standing.active || me.upstreams.length > 0
          ? modelsSection(me, model.presets)
          : '') +
        (me.standing.tenant === null ? '' : usageSection(me)) +
        renewSection(model.site, me.standing) +
        ordersSection(model.site, me.orders)
  return publicDocument(
    '我的订阅',
    model.label,
    model.site,
    `<h1 class="page-title" id="page-title">我的订阅</h1>` +
      `<p class="bl-status note" id="bl-status" role="status"></p>` +
      body +
      `<div class="bl-actions"><a class="btn btn-secondary" href="/">回到前台</a>` +
      `<a class="btn btn-ghost" href="/plans">套餐</a></div>`,
    script,
  )
}

// --- /subscription/checkout --------------------------------------------

interface CheckoutConfirmModel {
  readonly label: string
  readonly site: BillingSiteView
  readonly plan: BillingPlanView
  readonly channel: BillingChannel
}

/** 结账第一步：确认套餐与付款方式，再由一个同源表单下单。 */
export function renderCheckoutConfirm(model: CheckoutConfirmModel): string {
  return publicDocument(
    '确认订单',
    model.label,
    model.site,
    `<h1 class="page-title" id="page-title">确认订单</h1>` +
      planCard(model.plan) +
      `<form class="bl-form" method="post" action="/subscription/checkout">` +
      `<input type="hidden" name="plan" value="${attr(model.plan.id)}">` +
      `<input type="hidden" name="channel" value="${attr(model.channel)}">` +
      `<p>付款方式 · ${escapeHtml(CHANNEL_WORD[model.channel])}</p>` +
      `<button type="submit" class="btn btn-primary">生成付款二维码</button></form>` +
      `<div class="bl-actions"><a class="btn btn-ghost" href="/subscription">返回</a></div>`,
  )
}

interface CheckoutPageModel {
  readonly label: string
  readonly site: BillingSiteView
  readonly order: BillingOrderView
  readonly qrText: string | null
}

/** 结账第二步：二维码与订单状态；脚本轮询订单直到付清或关闭。 */
export function renderCheckoutPage(
  model: CheckoutPageModel,
  script: string,
): string {
  const order = model.order
  const open = order.status === 'created' && model.qrText !== null
  const channel = channelName(order.channel)
  const qr = open
    ? `<div class="bl-qr">${qrSvg(model.qrText ?? '', { label: `${channel}付款二维码` })}</div>` +
      `<p class="note">用${escapeHtml(channel)}扫码付款 · ${timeTag(order.expiresAt, 'hm')} 前有效</p>`
    : ''
  const status = open ? '等待付款' : ORDER_WORD[order.status]
  return publicDocument(
    '付款',
    model.label,
    model.site,
    `<h1 class="page-title" id="page-title">付款</h1>` +
      `<p class="bl-price"><b>${escapeHtml(yuan(order.amountCents))}</b> 元` +
      `<span class="note"> · ${escapeHtml(planName(model.site.plans, order.planId))} · ${escapeHtml(channel)}</span></p>` +
      qr +
      `<p class="bl-status" id="bl-order" role="status" data-order="${attr(order.orderId)}"` +
      ` data-state="${attr(order.status)}">${escapeHtml(status)}</p>` +
      `<div class="bl-actions"><a class="btn btn-secondary" href="/subscription" id="bl-back">回到订阅</a></div>`,
    open ? script : undefined,
  )
}

// --- /admin/billing ----------------------------------------------------

export type BillingAdminSide =
  | { readonly kind: 'ok'; readonly value: BillingAdminView }
  | { readonly kind: 'failed'; readonly failure: ConsoleFailure }
  | { readonly kind: 'unwired' }

function table(
  caption: string,
  headers: readonly string[],
  rows: readonly string[],
): string {
  return scroll(
    `<table class="trail"><caption class="sr-only">${escapeHtml(caption)}</caption>` +
      `<thead><tr>${headers.map(name => `<th scope="col">${escapeHtml(name)}</th>`).join('')}</tr></thead>` +
      `<tbody>${rows.join('')}</tbody></table>`,
  )
}

function mono(text: string): string {
  return `<span class="kit-mono">${escapeHtml(text)}</span>`
}

/** 付了款却因套餐冲突没有计入的订单；没有就不出这一块。 */
function adminRefundsDue(view: BillingAdminView, writer: boolean): string {
  if (view.refundsDue.length === 0) return ''
  const rows = view.refundsDue.map(
    row =>
      `<tr data-key="${attr(row.orderId)}"><td>${row.paidAt === null ? absent() : timeTag(row.paidAt, 'minute')}</td>` +
      `<td>${mono(row.subject)}</td><td>${escapeHtml(planName(view.plans, row.planId))}</td>` +
      `<td>${escapeHtml(planName(view.plans, row.activePlanId))}</td>` +
      `<td>${escapeHtml(yuan(row.amountCents))} 元</td><td>${escapeHtml(channelName(row.channel))}</td>` +
      `<td>${mono(row.outTradeNo)}</td>` +
      (writer
        ? `<td class="acts">${actionButton('bl-refund', '登记退款', {
            tone: 'ghost',
            data: { order: row.orderId },
          })}</td>`
        : '') +
      `</tr>`,
  )
  return (
    `<section class="sec" aria-labelledby="h-bl-a-refunds">` +
    sectionHead('Refunds due', '待退款', { headingId: 'h-bl-a-refunds' }) +
    `<p class="note">付款时这个账号有别的套餐在有效期内 · 钱已到账 · 订阅没有改动 · 在商户平台退款后在这里登记</p>` +
    table(
      '待退款',
      [
        '付款',
        '账号',
        '付的套餐',
        '当时有效的套餐',
        '金额',
        '方式',
        '商户订单号',
        ...(writer ? [''] : []),
      ],
      rows,
    ) +
    `</section>`
  )
}

function adminOrders(view: BillingAdminView, writer: boolean): string {
  const owed = new Set(view.refundsDue.map(row => row.orderId))
  const rows = view.orders.map(
    order =>
      `<tr data-key="${attr(order.orderId)}"><td>${timeTag(order.createdAt, 'minute')}</td>` +
      `<td>${mono(order.subject)}</td><td>${escapeHtml(planName(view.plans, order.planId))}</td>` +
      `<td>${escapeHtml(yuan(order.amountCents))} 元</td><td>${escapeHtml(channelName(order.channel))}</td>` +
      `<td>${
        order.status !== 'paid'
          ? escapeHtml(ORDER_WORD[order.status])
          : owed.has(order.orderId)
            ? state('warn', `${ORDER_WORD.paid} · 待退款`)
            : state('ok', ORDER_WORD.paid)
      }</td>` +
      `<td>${mono(order.outTradeNo)}</td>` +
      (writer
        ? `<td class="acts">${
            order.status === 'paid'
              ? actionButton('bl-refund', '登记退款', {
                  tone: 'ghost',
                  data: { order: order.orderId },
                })
              : ''
          }</td>`
        : '') +
      `</tr>`,
  )
  return (
    `<section class="sec" aria-labelledby="h-bl-a-orders">` +
    sectionHead('Orders', '订单', { headingId: 'h-bl-a-orders' }) +
    (rows.length === 0
      ? emptyState('还没有订单', '成员在订阅页下单后列在这里')
      : table(
          '订单',
          [
            '时间',
            '账号',
            '套餐',
            '金额',
            '方式',
            '状态',
            '商户订单号',
            ...(writer ? [''] : []),
          ],
          rows,
        )) +
    `</section>`
  )
}

const GATEWAY_WORD: Readonly<Record<string, string>> = {
  pending: '待开通',
  enabled: '已开通',
  disabled: '已停用',
}

function adminSubscriptions(view: BillingAdminView, writer: boolean): string {
  const rows = view.subscriptions.map(
    row =>
      `<tr data-key="${attr(row.subject)}"><td>${mono(row.subject)}</td>` +
      `<td>${row.tenant === null ? absent() : mono(row.tenant)}</td>` +
      `<td>${escapeHtml(planName(view.plans, row.planId))}</td>` +
      `<td>${timeTag(row.endsAt, 'minute')}</td>` +
      `<td>${row.active ? state('ok', '有效') : state('muted', '已到期')}</td>` +
      `<td>${row.gateway === 'pending' && row.attempts > 0 ? state('warn', `待开通 · 已重试 ${row.attempts} 次`) : escapeHtml(GATEWAY_WORD[row.gateway] ?? row.gateway)}</td></tr>`,
  )
  const add = writer
    ? actionButton('bl-grant', '手动开通或延期', { glyph: 'plus' })
    : ''
  return (
    `<section class="sec" aria-labelledby="h-bl-a-subs">` +
    sectionHead('Subscriptions', '订阅', {
      headingId: 'h-bl-a-subs',
      tail: `<div class="kit-row">${add}</div>`,
    }) +
    (rows.length === 0
      ? emptyState('还没有订阅', '付款 · 兑换 · 手动开通后都列在这里')
      : table('订阅', ['账号', '租户', '套餐', '到期', '状态', '开通'], rows)) +
    `</section>`
  )
}

function adminCodes(view: BillingAdminView, writer: boolean): string {
  const rows = view.codes.map(
    code =>
      `<tr data-key="${attr(code.id)}"><td>${mono(code.id)}</td>` +
      `<td>${escapeHtml(planName(view.plans, code.planId))} × ${code.periods}</td>` +
      `<td>${timeTag(code.createdAt, 'minute')}</td>` +
      `<td>${code.expiresAt === null ? absent() : timeTag(code.expiresAt, 'minute')}</td>` +
      `<td>${code.usedBy === null ? state('muted', '未使用') : `${mono(code.usedBy)} ${code.usedAt === null ? '' : timeTag(code.usedAt, 'minute')}`}</td></tr>`,
  )
  const add =
    writer && view.channels.redeem
      ? actionButton('bl-codes', '生成兑换码', { glyph: 'plus' })
      : ''
  return (
    `<section class="sec" aria-labelledby="h-bl-a-codes">` +
    sectionHead('Redeem codes', '兑换码', {
      headingId: 'h-bl-a-codes',
      tail: `<div class="kit-row">${add}</div>`,
    }) +
    (view.channels.redeem ? '' : `<p class="note">配置里没有开兑换码</p>`) +
    (rows.length === 0
      ? view.channels.redeem
        ? `<p class="note">还没有兑换码</p>`
        : ''
      : table('兑换码', ['编号', '套餐与周期', '生成', '失效', '使用'], rows)) +
    `</section>`
  )
}

function adminChain(view: BillingAdminView, writer: boolean): string {
  const chain = view.chain
  const line = chain.ok
    ? state('ok', `完整 · ${chain.events} 条事件`)
    : state('bad', `第 ${chain.seq} 条起不一致 · ${chain.reason}`)
  const check = writer
    ? actionButton('bl-verify', '重新校验', { glyph: 'refresh-cw' })
    : ''
  return (
    `<section class="sec" aria-labelledby="h-bl-a-chain">` +
    sectionHead('Ledger', '账本', {
      headingId: 'h-bl-a-chain',
      tail: `<div class="kit-row">${check}</div>`,
    }) +
    `<p id="bl-chain">${line}</p>` +
    `<p id="bl-live">${
      view.live
        ? state('warn', '正式收款已开通')
        : state('muted', '未开通正式收款')
    } · 由 billing.json 的 live 决定</p>` +
    `<p class="note">${tag('未评估')} 两种支付通道只对本地假服务测过 · 开始收取真实款项前须满足章程 §8 M3 的法律前置</p>` +
    `</section>`
  )
}

/** 「订阅」页的正文。 */
export function renderBillingAdmin(
  side: BillingAdminSide,
  writer: boolean,
): string {
  if (side.kind === 'unwired')
    return unwiredCard(
      '订阅',
      '只在公开版接入 · 用公开版构建启动并给出 --billing',
    )
  if (side.kind === 'failed') return failureBar(side.failure, '订阅')
  const view = side.value
  return (
    adminRefundsDue(view, writer) +
    adminSubscriptions(view, writer) +
    adminOrders(view, writer) +
    adminCodes(view, writer) +
    adminChain(view, writer)
  )
}

/** 平台运维的三个对话框：开通或延期、生成兑换码（结果只显示一次）、登记退款。 */
export function billingAdminDialogs(plans: readonly BillingPlanView[]): string {
  const planChoices = plans.map(plan => [plan.id, plan.name] as const)
  return (
    `<dialog class="dialog bl-dialog" id="bl-grant-dialog" aria-labelledby="bl-grant-title">` +
    `<form id="bl-grant-form" novalidate>` +
    dialogTop('bl-grant-title', 'plus', '手动开通或延期') +
    `<div class="dialog-body"><div class="form-grid">` +
    textField('subject', '账号', {
      required: true,
      mono: true,
      placeholder: 'u:0123456789abcdef',
      form: 'grant',
      wide: true,
    }) +
    selectField('plan', '套餐', planChoices, {
      required: true,
      form: 'grant',
    }) +
    textField('periods', '周期数', {
      type: 'number',
      required: true,
      min: 1,
      max: 120,
      value: '1',
      form: 'grant',
    }) +
    textField('reason', '原因', {
      required: true,
      maxLength: 500,
      form: 'grant',
      wide: true,
    }) +
    `</div></div>` +
    `<p class="note bl-dlg-status" id="bl-grant-status" role="status"></p>` +
    dialogActions('开通', { glyph: 'check' }) +
    `</form></dialog>` +
    `<dialog class="dialog bl-dialog" id="bl-codes-dialog" aria-labelledby="bl-codes-title">` +
    `<form id="bl-codes-form" novalidate>` +
    dialogTop('bl-codes-title', 'plus', '生成兑换码') +
    `<div class="dialog-body"><div class="form-grid" id="bl-codes-fields">` +
    selectField('plan', '套餐', planChoices, {
      required: true,
      form: 'codes',
    }) +
    textField('periods', '每个码的周期数', {
      type: 'number',
      required: true,
      min: 1,
      max: 120,
      value: '1',
      form: 'codes',
    }) +
    textField('count', '数量', {
      type: 'number',
      required: true,
      min: 1,
      max: 1000,
      value: '10',
      form: 'codes',
    }) +
    textField('days', '几天后失效', {
      type: 'number',
      min: 1,
      max: 3660,
      help: '留空不失效',
      form: 'codes',
    }) +
    `</div><div class="field field-wide" id="bl-codes-result" hidden>` +
    `<label for="bl-codes-out">兑换码 · 只显示这一次</label>` +
    `<textarea class="input mono" id="bl-codes-out" rows="8" readonly></textarea></div></div>` +
    `<p class="note bl-dlg-status" id="bl-codes-status" role="status"></p>` +
    dialogActions('生成', { glyph: 'check' }) +
    `</form></dialog>` +
    `<dialog class="dialog bl-dialog" id="bl-refund-dialog" aria-labelledby="bl-refund-title">` +
    `<form id="bl-refund-form" novalidate>` +
    dialogTop('bl-refund-title', 'x', '登记退款', true) +
    `<div class="dialog-body"><p class="note">只登记已在商户平台完成的退款 · 订阅减去这张订单计入的天数</p>` +
    `<div class="form-grid">` +
    textField('order', '订单', {
      required: true,
      mono: true,
      form: 'refund',
      wide: true,
    }) +
    textField('reason', '原因', {
      required: true,
      maxLength: 500,
      form: 'refund',
      wide: true,
    }) +
    `</div></div>` +
    `<p class="note bl-dlg-status" id="bl-refund-status" role="status"></p>` +
    dialogActions('登记', { danger: true, glyph: 'check' }) +
    `</form></dialog>`
  )
}

export const BILLING_ADMIN_CSS = `
.bl-dialog .dialog-body { max-height: min(70vh, 680px); overflow: auto; }
.bl-dlg-status:empty { display: none; }
`

const BILLING_PUBLIC_CSS = `
.bl-stage { place-items: start center; }
.bl-sheet { position: relative; width: min(880px, 100%); margin: auto; padding: var(--space-8); border-radius: 16px; display: flex; flex-direction: column; gap: var(--space-5); }
.bl-sheet .brand { gap: 10px; }
.bl-sheet .brand-cn { font-size: var(--text-20); letter-spacing: .06em; }
.bl-sheet .page-title { font-size: var(--text-22); margin: 0; }
.bl-lead { margin: 0; color: var(--color-quiet); }
.bl-plans { display: grid; gap: var(--space-3); grid-template-columns: repeat(auto-fit, minmax(min(100%, 220px), 1fr)); }
.bl-plan { display: flex; flex-direction: column; gap: var(--space-2); padding: var(--space-4); }
.bl-plan-name { margin: 0; font-size: var(--text-16); }
.bl-price { margin: 0; font-size: var(--text-14); }
.bl-price b { font-size: var(--text-22); }
.bl-nodes { margin: 0; display: flex; align-items: center; gap: 6px; font-size: var(--text-13); }
.bl-byok { margin: 0; }
.bl-actions { display: flex; gap: var(--space-2); flex-wrap: wrap; }
.bl-sec { display: flex; flex-direction: column; gap: var(--space-3); padding-top: var(--space-4); border-top: 1px solid var(--color-divider); }
.bl-sec h2 { margin: 0; font-size: var(--text-16); }
.bl-facts { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 200px), 1fr)); gap: 6px var(--space-4); }
.bl-fact { display: flex; justify-content: space-between; gap: var(--space-3); font-size: var(--text-13); min-width: 0; }
.bl-form { display: flex; flex-direction: column; gap: var(--space-3); max-width: 420px; }
.bl-inline { flex-direction: row; align-items: flex-end; flex-wrap: wrap; }
.bl-buy { display: flex; gap: var(--space-2); flex-wrap: wrap; }
.bl-qr { width: min(240px, 100%); align-self: center; }
.bl-qr svg { display: block; width: 100%; height: auto; }
.bl-status { margin: 0; font-size: var(--text-14); }
.bl-status:empty { display: none; }
.bl-foot { display: flex; gap: var(--space-2); flex-wrap: wrap; font-size: var(--text-11-5); color: var(--color-muted); border-top: 1px solid var(--color-divider); padding-top: var(--space-3); }
.kit-mono { font-family: var(--font-mono); font-size: var(--text-12); overflow-wrap: anywhere; }
.trail td.acts { text-align: right; white-space: nowrap; }
.field-help { display: block; margin-top: 4px; }
`
