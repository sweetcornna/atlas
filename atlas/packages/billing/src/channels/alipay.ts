// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Alipay open platform, 当面付 precreate (scan-to-pay QR), classic gateway,
 * public-key mode (not certificate mode).
 *
 * **未评估**：not run against a real Alipay app. Tested only against local
 * fakes with keys generated in the test.
 *
 * ## Protocol facts relied on
 *
 * Sources: Alipay's official SDKs (fetched 2026-10-16) —
 * `alipay/alipay-sdk-nodejs-all` `src/util.ts` `sign()`, `src/alipay.ts`
 * (`formatUrl`, `getSignStr`, `checkResponseSign`, `checkNotifySign`), and
 * `alipay/alipay-sdk-java-all` `AlipaySignature.java` (`getSignContent`,
 * `getSignCheckContentV1`, `extractSignContent`), `AlipayTradePrecreateModel`,
 * `AlipayTradePrecreateResponse`, `AlipayTradeQueryResponse`. The
 * opendocs.alipay.com pages are script-rendered and could not be read; the
 * points marked (knowledge) are from memory of those pages, unverified.
 *
 * - Common params: app_id, method, format=JSON, charset=utf-8, sign_type=RSA2,
 *   timestamp `yyyy-MM-dd HH:mm:ss` (Asia/Shanghai), version=1.0, notify_url,
 *   biz_content (JSON text). The SDK sends everything but biz_content in the
 *   gateway URL's query and biz_content as a form-encoded POST body.
 * - Request signature: sort params by key, drop `sign` and empty values,
 *   join `k=v` with `&` (raw values, no URL encoding), SHA256withRSA with the
 *   app private key, base64.
 * - Response: `{"<method with dots as _>_response": {...}, "sign": "..."}`.
 *   The signature covers the raw JSON text of the response node exactly as
 *   received; the Java SDK finds it by brace matching that respects strings
 *   and escapes. Business success is `code` "10000".
 * - precreate biz_content: out_trade_no (≤64, letters/digits/_), total_amount
 *   (yuan, 2 decimals, 0.01–100000000), subject (≤256, no `/ = &`),
 *   timeout_express (`1m`–`15d`; the QR itself dies after 2 h). Response
 *   `qr_code`.
 * - query: trade_status WAIT_BUYER_PAY / TRADE_CLOSED / TRADE_SUCCESS /
 *   TRADE_FINISHED, total_amount, trade_no. A precreate QR that was never
 *   scanned has no trade yet: `40004` + `ACQ.TRADE_NOT_EXIST` (knowledge).
 * - close: `10000`, or `ACQ.TRADE_NOT_EXIST` for a never-scanned QR (knowledge).
 * - Async notify: form-encoded POST; verify over the sorted params minus
 *   `sign`, `sign_type` and empty values (Java `getSignCheckContentV1`);
 *   check app_id, out_trade_no, total_amount; pay on TRADE_SUCCESS or
 *   TRADE_FINISHED; answer the exact body `success`, anything else makes
 *   Alipay retry (knowledge: over about 25 h).
 */

import { sign as rsaSign, verify as rsaVerify } from 'node:crypto'
import type { AlipayConfig } from '../config.js'
import {
  ChannelError,
  type NotifyReply,
  type NotifyRequest,
  type NotifyVerdict,
  type PaymentChannel,
  type QrRequest,
  type ReplyOutcome,
  type TradeStatus,
} from './types.js'
import { type FetchLike, send, shanghaiDateTime } from './wire.js'

const MAX_NOTIFY_BYTES = 64 * 1024
const OUT_TRADE_NO = /^[A-Za-z0-9_]{1,64}$/
const YUAN = /^(0|[1-9][0-9]{0,9})(?:\.([0-9]{1,2}))?$/

type Json = Record<string, unknown>

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 9900 → "99.00". */
export function centsToYuan(cents: number): string {
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`
}

/** "99.00" / "99.0" / "99" → 9900; null when not a plain yuan amount. */
export function yuanToCents(text: string): number | null {
  const match = YUAN.exec(text)
  if (match === null) return null
  const fraction = (match[2] ?? '').padEnd(2, '0')
  return Number(match[1]) * 100 + Number(fraction)
}

/** The string Alipay signs: sorted `k=v` pairs, empty values and `excluded` dropped. */
export function alipaySignContent(
  params: Readonly<Record<string, string>>,
  excluded: readonly string[] = ['sign'],
): string {
  return Object.keys(params)
    .filter(key => !excluded.includes(key) && params[key] !== '')
    .sort()
    .map(key => `${key}=${params[key]}`)
    .join('&')
}

/** Index just past the JSON string starting at `start` (a `"`). */
function skipString(text: string, start: number): number {
  for (let i = start + 1; i < text.length; i++) {
    const char = text[i]
    if (char === '\\') i++
    else if (char === '"') return i + 1
  }
  throw new Error('unterminated string')
}

/** Index just past the JSON value starting at `start`. */
function skipValue(text: string, start: number): number {
  const first = text[start]
  if (first === '"') return skipString(text, start)
  if (first === '{' || first === '[') {
    let depth = 0
    for (let i = start; i < text.length; i++) {
      const char = text[i]
      if (char === '"') {
        i = skipString(text, i) - 1
      } else if (char === '{' || char === '[') {
        depth++
      } else if (char === '}' || char === ']') {
        depth--
        if (depth === 0) return i + 1
      }
    }
    throw new Error('unterminated value')
  }
  let i = start
  while (i < text.length && !/[\s,}\]]/.test(text[i]!)) i++
  if (i === start) throw new Error('empty value')
  return i
}

function skipSpace(text: string, start: number): number {
  let i = start
  while (i < text.length && /\s/.test(text[i]!)) i++
  return i
}

/**
 * The raw text of every top-level member of a JSON object, exactly as
 * received. Duplicate keys are refused: two `…_response` members would make
 * "the signed one" ambiguous.
 */
export function rawJsonMembers(text: string): Map<string, string> {
  const members = new Map<string, string>()
  let i = skipSpace(text, 0)
  if (text[i] !== '{') throw new Error('not an object')
  i = skipSpace(text, i + 1)
  if (text[i] === '}') return members
  for (;;) {
    if (text[i] !== '"') throw new Error('expected key')
    const keyEnd = skipString(text, i)
    const key: unknown = JSON.parse(text.slice(i, keyEnd))
    if (typeof key !== 'string' || members.has(key))
      throw new Error('duplicate key')
    i = skipSpace(text, keyEnd)
    if (text[i] !== ':') throw new Error('expected colon')
    i = skipSpace(text, i + 1)
    const valueEnd = skipValue(text, i)
    members.set(key, text.slice(i, valueEnd))
    i = skipSpace(text, valueEnd)
    if (text[i] === ',') {
      i = skipSpace(text, i + 1)
      continue
    }
    if (text[i] === '}' && skipSpace(text, i + 1) === text.length)
      return members
    throw new Error('expected , or }')
  }
}

function stateOf(status: unknown): TradeStatus['state'] {
  switch (status) {
    case 'TRADE_SUCCESS':
    case 'TRADE_FINISHED':
      return 'paid'
    case 'WAIT_BUYER_PAY':
      return 'pending'
    default:
      return 'closed'
  }
}

function absent(outTradeNo: string): TradeStatus {
  return {
    state: 'absent',
    outTradeNo,
    amountCents: null,
    currency: null,
    providerTxnId: null,
    merchantMatches: true,
  }
}

export interface AlipayChannelOptions {
  readonly config: AlipayConfig
  readonly fetch?: FetchLike
  readonly now?: () => number
}

export class AlipayChannel implements PaymentChannel {
  readonly id = 'alipay' as const
  readonly #config: AlipayConfig
  readonly #fetch: FetchLike
  readonly #now: () => number

  constructor(options: AlipayChannelOptions) {
    this.#config = options.config
    this.#fetch = options.fetch ?? fetch
    this.#now = options.now ?? Date.now
  }

  /** Signed common params for one call (biz_content included). */
  signedParams(
    method: string,
    bizContent: Json,
    extra: Readonly<Record<string, string>> = {},
  ): Record<string, string> {
    const params: Record<string, string> = {
      app_id: this.#config.appId,
      method,
      format: 'JSON',
      charset: 'utf-8',
      sign_type: 'RSA2',
      timestamp: shanghaiDateTime(this.#now()),
      version: '1.0',
      ...extra,
      biz_content: JSON.stringify(bizContent),
    }
    params['sign'] = rsaSign(
      'RSA-SHA256',
      Buffer.from(alipaySignContent(params), 'utf8'),
      this.#config.appPrivateKey,
    ).toString('base64')
    return params
  }

  /** Verify a gateway response and return its node. */
  verifyResponse(text: string, method: string, label: string): Json {
    let members: Map<string, string>
    try {
      members = rawJsonMembers(text)
    } catch {
      throw new ChannelError('bad_response', `${label}：应答不是 JSON 对象`)
    }
    const key = `${method.replaceAll('.', '_')}_response`
    const raw = members.get(key) ?? members.get('error_response')
    const rawSign = members.get('sign')
    if (raw === undefined)
      throw new ChannelError('bad_response', `${label}：应答缺少 ${key}`)
    if (rawSign === undefined)
      throw new ChannelError('unsigned', `${label}：应答没有签名`)
    let signature: unknown
    let node: unknown
    try {
      signature = JSON.parse(rawSign)
      node = JSON.parse(raw)
    } catch {
      throw new ChannelError('bad_response', `${label}：应答格式不对`)
    }
    if (
      typeof signature !== 'string' ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(signature) ||
      !rsaVerify(
        'RSA-SHA256',
        Buffer.from(raw, 'utf8'),
        this.#config.alipayPublicKey,
        Buffer.from(signature, 'base64'),
      )
    )
      throw new ChannelError('bad_signature', `${label}：应答验签失败`)
    if (!isRecord(node))
      throw new ChannelError('bad_response', `${label}：应答格式不对`)
    return node
  }

  async #call(
    method: string,
    bizContent: Json,
    label: string,
    extra: Readonly<Record<string, string>> = {},
  ): Promise<Json> {
    const params = this.signedParams(method, bizContent, extra)
    const url = new URL(this.#config.endpoint)
    for (const [key, value] of Object.entries(params))
      if (key !== 'biz_content') url.searchParams.set(key, value)
    const result = await send(
      this.#fetch,
      url.toString(),
      {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8',
        },
        body: new URLSearchParams({
          biz_content: params['biz_content']!,
        }).toString(),
      },
      label,
    )
    if (result.status !== 200)
      throw new ChannelError(
        `alipay:HTTP_${result.status}`,
        `${label}：HTTP ${result.status}`,
      )
    return this.verifyResponse(result.text, method, label)
  }

  #fail(label: string, node: Json): never {
    const code = typeof node['code'] === 'string' ? node['code'] : '?'
    const sub =
      typeof node['sub_code'] === 'string' ? node['sub_code'].slice(0, 64) : ''
    throw new ChannelError(
      `alipay:${sub || code}`,
      `${label}：支付宝返回 ${code}${sub ? ` ${sub}` : ''}`,
    )
  }

  async createQr(request: QrRequest): Promise<{ qrText: string }> {
    if (!OUT_TRADE_NO.test(request.outTradeNo))
      throw new ChannelError('invalid', '商户订单号格式不对')
    const minutes = Math.max(
      1,
      Math.ceil((request.expiresAt - this.#now()) / 60_000),
    )
    const label = '支付宝预下单'
    const node = await this.#call(
      'alipay.trade.precreate',
      {
        out_trade_no: request.outTradeNo,
        total_amount: centsToYuan(request.amountCents),
        subject: Array.from(request.title.replace(/[/=&]/g, ' '))
          .slice(0, 256)
          .join(''),
        timeout_express: `${minutes}m`,
      },
      label,
      { notify_url: this.#config.notifyUrl },
    )
    if (node['code'] !== '10000') this.#fail(label, node)
    const qr = node['qr_code']
    if (typeof qr !== 'string' || qr === '')
      throw new ChannelError('bad_response', `${label}：应答缺少 qr_code`)
    if (node['out_trade_no'] !== request.outTradeNo)
      throw new ChannelError('bad_response', `${label}：应答订单号不符`)
    return { qrText: qr }
  }

  async query(outTradeNo: string): Promise<TradeStatus> {
    if (!OUT_TRADE_NO.test(outTradeNo))
      throw new ChannelError('invalid', '商户订单号格式不对')
    const label = '支付宝查单'
    const node = await this.#call(
      'alipay.trade.query',
      { out_trade_no: outTradeNo },
      label,
    )
    if (node['code'] !== '10000') {
      if (node['sub_code'] === 'ACQ.TRADE_NOT_EXIST') return absent(outTradeNo)
      this.#fail(label, node)
    }
    if (node['out_trade_no'] !== outTradeNo)
      throw new ChannelError('bad_response', `${label}：应答订单号不符`)
    const amount =
      typeof node['total_amount'] === 'string'
        ? yuanToCents(node['total_amount'])
        : null
    const tradeNo = node['trade_no']
    return {
      state: stateOf(node['trade_status']),
      outTradeNo,
      amountCents: amount,
      currency: 'CNY',
      providerTxnId:
        typeof tradeNo === 'string' && tradeNo !== '' ? tradeNo : null,
      // The response is signed by Alipay for a call signed with our app key.
      merchantMatches: true,
    }
  }

  async close(outTradeNo: string): Promise<void> {
    if (!OUT_TRADE_NO.test(outTradeNo))
      throw new ChannelError('invalid', '商户订单号格式不对')
    const label = '支付宝关单'
    const node = await this.#call(
      'alipay.trade.close',
      { out_trade_no: outTradeNo },
      label,
    )
    if (node['code'] === '10000') return
    if (node['sub_code'] === 'ACQ.TRADE_NOT_EXIST') return
    this.#fail(label, node)
  }

  verifyNotify(request: NotifyRequest, _now: number): NotifyVerdict {
    if (Buffer.byteLength(request.rawBody, 'utf8') > MAX_NOTIFY_BYTES)
      return { ok: false, reason: '通知过大' }
    if (
      request.contentType !== undefined &&
      !request.contentType
        .toLowerCase()
        .startsWith('application/x-www-form-urlencoded')
    )
      return { ok: false, reason: '通知类型不对' }
    const params: Record<string, string> = {}
    for (const [key, value] of new URLSearchParams(request.rawBody)) {
      if (Object.hasOwn(params, key)) return { ok: false, reason: '参数重复' }
      params[key] = value
    }
    const signature = params['sign']
    if (params['sign_type'] !== 'RSA2' || !signature)
      return { ok: false, reason: '缺少签名' }
    if (
      params['charset'] !== undefined &&
      params['charset'].toLowerCase() !== 'utf-8'
    )
      return { ok: false, reason: '字符集不对' }
    const ok = rsaVerify(
      'RSA-SHA256',
      Buffer.from(alipaySignContent(params, ['sign', 'sign_type']), 'utf8'),
      this.#config.alipayPublicKey,
      Buffer.from(signature, 'base64'),
    )
    if (!ok) return { ok: false, reason: '签名不符' }
    const outTradeNo = params['out_trade_no']
    if (!outTradeNo) return { ok: false, reason: '缺少订单号' }
    const tradeNo = params['trade_no']
    return {
      ok: true,
      trade: {
        state: stateOf(params['trade_status']),
        outTradeNo,
        amountCents:
          params['total_amount'] === undefined
            ? null
            : yuanToCents(params['total_amount']),
        currency: 'CNY',
        providerTxnId: tradeNo ? tradeNo : null,
        merchantMatches: params['app_id'] === this.#config.appId,
      },
    }
  }

  reply(outcome: ReplyOutcome, _message: string): NotifyReply {
    const headers = { 'content-type': 'text/plain; charset=utf-8' }
    if (outcome === 'ok') return { httpStatus: 200, body: 'success', headers }
    return {
      httpStatus: outcome === 'rejected' ? 400 : 500,
      body: 'fail',
      headers,
    }
  }
}
