// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * WeChat Pay API v3, Native payment, merchant direct mode (普通商户).
 *
 * **未评估**：not run against a real merchant account. Tested only against
 * local fakes with keys generated in the test; the request-signing message
 * and header are checked against the docs' description of them, not against
 * the docs' example key or example request.
 *
 * ## Protocol facts relied on (official docs, fetched 2026-10-16)
 *
 * - 下单 `POST /v3/pay/transactions/native` → `{code_url}`; body fields
 *   appid, mchid, description (≤127), out_trade_no (6–32, `[0-9A-Za-z_-|*]`),
 *   time_expire (RFC 3339, ≥ 1 min, ≤ 7 d), notify_url, amount {total 分,
 *   currency CNY}. code_url is valid for 2 h.
 *   https://pay.weixin.qq.com/doc/v3/merchant/4012791877
 * - 查单 `GET /v3/pay/transactions/out-trade-no/{no}?mchid=` → trade_state
 *   SUCCESS / REFUND / NOTPAY / CLOSED / REVOKED / USERPAYING / PAYERROR;
 *   404 `ORDER_NOT_EXIST`. https://pay.weixin.qq.com/doc/v3/merchant/4012791880
 * - 关单 `POST …/{no}/close` body `{mchid}` → 204.
 *   https://pay.weixin.qq.com/doc/v3/merchant/4012791881
 * - 请求签名：`METHOD\nPATH?QUERY\nTIMESTAMP\nNONCE\nBODY\n` (empty body →
 *   just `\n`), SHA256withRSA with the merchant API key, base64; header
 *   `Authorization: WECHATPAY2-SHA256-RSA2048 mchid="",nonce_str="",
 *   signature="",timestamp="",serial_no=""` (any order).
 *   https://pay.weixin.qq.com/doc/v3/merchant/4012365336 , …/4012365337
 * - 应答与回调验签：`TIMESTAMP\nNONCE\nBODY\n` from `Wechatpay-Timestamp`,
 *   `Wechatpay-Nonce` and the raw body, verified with the 微信支付公钥 named by
 *   `Wechatpay-Serial` (`PUB_KEY_ID_…`; anything else means platform-
 *   certificate mode, which this adapter does not implement). The official
 *   `WXPayUtility` rejects |now − timestamp| ≥ 5 min and a serial that differs
 *   from the configured key id; only 2xx responses are verified. Signatures
 *   beginning `WECHATPAY/SIGNTEST/` are probes and must simply fail.
 *   https://pay.weixin.qq.com/doc/v3/merchant/4013053249 , …/4014931831
 * - 支付成功回调：JSON `{id, create_time, event_type: TRANSACTION.SUCCESS,
 *   resource_type: encrypt-resource, resource: {algorithm: AEAD_AES_256_GCM,
 *   ciphertext (base64, last 16 bytes = tag), associated_data, nonce,
 *   original_type: transaction}}`; plaintext has appid, mchid, out_trade_no,
 *   transaction_id, trade_state, amount {total, currency, …}. Reply 200/204
 *   with no body on success, 4xx/5xx with `{code: "FAIL", message}` on
 *   failure, within 5 s; WeChat retries up to 15 times.
 *   https://pay.weixin.qq.com/doc/v3/merchant/4012791882 , …/4012075420
 */

import {
  createDecipheriv,
  randomBytes,
  sign as rsaSign,
  verify as rsaVerify,
} from 'node:crypto'
import type { WechatPayConfig } from '../config.js'
import {
  ChannelError,
  type HeaderBag,
  headerOf,
  type NotifyReply,
  type NotifyRequest,
  type NotifyVerdict,
  type PaymentChannel,
  type QrRequest,
  type ReplyOutcome,
  type TradeStatus,
} from './types.js'
import { type FetchLike, send, shanghaiRfc3339 } from './wire.js'

const SKEW_SECONDS = 300
const MAX_NOTIFY_BYTES = 1024 * 1024
const OUT_TRADE_NO = /^[A-Za-z0-9_\-|*]{6,32}$/
const USER_AGENT = 'qianmo-billing/1'

type Json = Record<string, unknown>

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseJson(text: string): Json | null {
  try {
    const value: unknown = JSON.parse(text)
    return isRecord(value) ? value : null
  } catch {
    return null
  }
}

function stateOf(tradeState: unknown): TradeStatus['state'] {
  switch (tradeState) {
    case 'SUCCESS':
      return 'paid'
    case 'NOTPAY':
    case 'USERPAYING':
      return 'pending'
    default:
      // CLOSED, REVOKED, PAYERROR, REFUND (paid then refunded) and unknown.
      return 'closed'
  }
}

export interface WechatPayChannelOptions {
  readonly config: WechatPayConfig
  readonly fetch?: FetchLike
  readonly now?: () => number
  readonly nonce?: () => string
}

export class WechatPayChannel implements PaymentChannel {
  readonly id = 'wechatpay' as const
  readonly #config: WechatPayConfig
  readonly #fetch: FetchLike
  readonly #now: () => number
  readonly #nonce: () => string

  constructor(options: WechatPayChannelOptions) {
    this.#config = options.config
    this.#fetch = options.fetch ?? fetch
    this.#now = options.now ?? Date.now
    this.#nonce =
      options.nonce ?? (() => randomBytes(16).toString('hex').toUpperCase())
  }

  /** The `Authorization` header value for one request. */
  authorization(method: string, pathWithQuery: string, body: string): string {
    const timestamp = String(Math.floor(this.#now() / 1000))
    const nonce = this.#nonce()
    const message = `${method}\n${pathWithQuery}\n${timestamp}\n${nonce}\n${body}\n`
    const signature = rsaSign(
      'RSA-SHA256',
      Buffer.from(message, 'utf8'),
      this.#config.merchantPrivateKey,
    ).toString('base64')
    return `WECHATPAY2-SHA256-RSA2048 mchid="${this.#config.mchid}",nonce_str="${nonce}",signature="${signature}",timestamp="${timestamp}",serial_no="${this.#config.merchantSerialNo}"`
  }

  /** Null when the signed message verifies; otherwise why not (for logs). */
  #signatureProblem(
    headers: HeaderBag,
    body: string,
    now: number,
  ): string | null {
    const timestamp = headerOf(headers, 'Wechatpay-Timestamp')
    const nonce = headerOf(headers, 'Wechatpay-Nonce')
    const serial = headerOf(headers, 'Wechatpay-Serial')
    const signature = headerOf(headers, 'Wechatpay-Signature')
    if (!timestamp || !nonce || !serial || !signature) return '缺少签名头'
    if (!/^\d{1,12}$/.test(timestamp)) return '时间戳格式不对'
    if (Math.abs(Math.floor(now / 1000) - Number(timestamp)) >= SKEW_SECONDS)
      return '时间戳超出 5 分钟'
    if (serial !== this.#config.wechatpayPublicKeyId)
      return serial.startsWith('PUB_KEY_ID_')
        ? '微信支付公钥 ID 不符'
        : '平台证书模式未实现'
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(signature)) return '签名格式不对'
    const ok = rsaVerify(
      'RSA-SHA256',
      Buffer.from(`${timestamp}\n${nonce}\n${body}\n`, 'utf8'),
      this.#config.wechatpayPublicKey,
      Buffer.from(signature, 'base64'),
    )
    return ok ? null : '签名不符'
  }

  async #request(
    method: 'GET' | 'POST',
    pathWithQuery: string,
    body: string | null,
    label: string,
  ): Promise<{ status: number; text: string }> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      Authorization: this.authorization(method, pathWithQuery, body ?? ''),
      'User-Agent': USER_AGENT,
      'Wechatpay-Serial': this.#config.wechatpayPublicKeyId,
    }
    if (body !== null) headers['Content-Type'] = 'application/json'
    const result = await send(
      this.#fetch,
      `${this.#config.endpoint}${pathWithQuery}`,
      { method, headers, ...(body === null ? {} : { body }) },
      label,
    )
    if (result.status >= 200 && result.status < 300) {
      const problem = this.#signatureProblem(
        result.headers,
        result.text,
        this.#now(),
      )
      if (problem !== null)
        throw new ChannelError(
          'bad_signature',
          `${label}：应答验签失败（${problem}）`,
        )
    }
    return { status: result.status, text: result.text }
  }

  #fail(label: string, status: number, text: string): never {
    const error = parseJson(text)
    const code =
      error && typeof error['code'] === 'string'
        ? error['code'].slice(0, 64)
        : `HTTP_${status}`
    throw new ChannelError(
      `wechatpay:${code}`,
      `${label}：微信支付返回 ${code}`,
    )
  }

  async createQr(request: QrRequest): Promise<{ qrText: string }> {
    if (!OUT_TRADE_NO.test(request.outTradeNo))
      throw new ChannelError('invalid', '商户订单号格式不对')
    const body = JSON.stringify({
      appid: this.#config.appid,
      mchid: this.#config.mchid,
      description: Array.from(request.title).slice(0, 127).join(''),
      out_trade_no: request.outTradeNo,
      time_expire: shanghaiRfc3339(request.expiresAt),
      notify_url: this.#config.notifyUrl,
      amount: { total: request.amountCents, currency: 'CNY' },
    })
    const label = '微信支付下单'
    const result = await this.#request(
      'POST',
      '/v3/pay/transactions/native',
      body,
      label,
    )
    if (result.status !== 200) this.#fail(label, result.status, result.text)
    const parsed = parseJson(result.text)
    const codeUrl = parsed?.['code_url']
    if (typeof codeUrl !== 'string' || !codeUrl.startsWith('weixin://'))
      throw new ChannelError('bad_response', `${label}：应答缺少 code_url`)
    return { qrText: codeUrl }
  }

  #trade(record: Json, outTradeNo: string): TradeStatus {
    const amount = isRecord(record['amount']) ? record['amount'] : {}
    const total = amount['total']
    const currency = amount['currency']
    const txn = record['transaction_id']
    return {
      state: stateOf(record['trade_state']),
      outTradeNo,
      amountCents:
        typeof total === 'number' && Number.isSafeInteger(total) ? total : null,
      currency: typeof currency === 'string' ? currency : null,
      providerTxnId: typeof txn === 'string' && txn !== '' ? txn : null,
      merchantMatches:
        record['mchid'] === this.#config.mchid &&
        record['appid'] === this.#config.appid,
    }
  }

  async query(outTradeNo: string): Promise<TradeStatus> {
    if (!OUT_TRADE_NO.test(outTradeNo))
      throw new ChannelError('invalid', '商户订单号格式不对')
    const label = '微信支付查单'
    const result = await this.#request(
      'GET',
      `/v3/pay/transactions/out-trade-no/${outTradeNo}?mchid=${encodeURIComponent(this.#config.mchid)}`,
      null,
      label,
    )
    if (result.status === 404) {
      const error = parseJson(result.text)
      if (error?.['code'] === 'ORDER_NOT_EXIST')
        return {
          state: 'absent',
          outTradeNo,
          amountCents: null,
          currency: null,
          providerTxnId: null,
          merchantMatches: true,
        }
    }
    if (result.status !== 200) this.#fail(label, result.status, result.text)
    const record = parseJson(result.text)
    if (record === null || record['out_trade_no'] !== outTradeNo)
      throw new ChannelError('bad_response', `${label}：应答订单号不符`)
    return this.#trade(record, outTradeNo)
  }

  async close(outTradeNo: string): Promise<void> {
    if (!OUT_TRADE_NO.test(outTradeNo))
      throw new ChannelError('invalid', '商户订单号格式不对')
    const label = '微信支付关单'
    const result = await this.#request(
      'POST',
      `/v3/pay/transactions/out-trade-no/${outTradeNo}/close`,
      JSON.stringify({ mchid: this.#config.mchid }),
      label,
    )
    if (result.status !== 204 && result.status !== 200)
      this.#fail(label, result.status, result.text)
  }

  verifyNotify(request: NotifyRequest, now: number): NotifyVerdict {
    if (Buffer.byteLength(request.rawBody, 'utf8') > MAX_NOTIFY_BYTES)
      return { ok: false, reason: '通知过大' }
    const problem = this.#signatureProblem(
      request.headers,
      request.rawBody,
      now,
    )
    if (problem !== null) return { ok: false, reason: problem }
    const envelope = parseJson(request.rawBody)
    const resource = envelope?.['resource']
    if (
      envelope === null ||
      envelope['resource_type'] !== 'encrypt-resource' ||
      !isRecord(resource) ||
      resource['algorithm'] !== 'AEAD_AES_256_GCM' ||
      typeof resource['ciphertext'] !== 'string' ||
      typeof resource['nonce'] !== 'string' ||
      resource['nonce'] === '' ||
      (resource['associated_data'] !== undefined &&
        typeof resource['associated_data'] !== 'string')
    )
      return { ok: false, reason: '通知格式不对' }
    const plaintext = this.decryptResource(
      resource['ciphertext'],
      resource['nonce'],
      typeof resource['associated_data'] === 'string'
        ? resource['associated_data']
        : '',
    )
    if (plaintext === null) return { ok: false, reason: '解密失败' }
    const record = parseJson(plaintext)
    const outTradeNo = record?.['out_trade_no']
    if (record === null || typeof outTradeNo !== 'string')
      return { ok: false, reason: '通知内容不对' }
    const trade = this.#trade(record, outTradeNo)
    // A paid state counts only in a payment-success event.
    if (
      trade.state === 'paid' &&
      envelope['event_type'] !== 'TRANSACTION.SUCCESS'
    )
      return { ok: true, trade: { ...trade, state: 'pending' } }
    return { ok: true, trade }
  }

  /** AEAD_AES_256_GCM with the APIv3 key; null when authentication fails. */
  decryptResource(
    ciphertext: string,
    nonce: string,
    associatedData: string,
  ): string | null {
    const data = Buffer.from(ciphertext, 'base64')
    if (data.length <= 16) return null
    try {
      const decipher = createDecipheriv(
        'aes-256-gcm',
        this.#config.apiV3Key,
        Buffer.from(nonce, 'utf8'),
      )
      decipher.setAAD(Buffer.from(associatedData, 'utf8'))
      decipher.setAuthTag(data.subarray(data.length - 16))
      return Buffer.concat([
        decipher.update(data.subarray(0, data.length - 16)),
        decipher.final(),
      ]).toString('utf8')
    } catch {
      return null
    }
  }

  reply(outcome: ReplyOutcome, message: string): NotifyReply {
    if (outcome === 'ok') return { httpStatus: 204, body: '', headers: {} }
    return {
      httpStatus: outcome === 'rejected' ? 400 : 500,
      body: JSON.stringify({ code: 'FAIL', message }),
      headers: { 'content-type': 'application/json; charset=utf-8' },
    }
  }
}
