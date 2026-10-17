// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The two QR payment channels. Redeem codes are not a payment channel. */
export type PaymentChannelId = 'wechatpay' | 'alipay'

export interface QrRequest {
  /** 32 chars of `[A-Za-z0-9]`; valid for both WeChat Pay and Alipay. */
  readonly outTradeNo: string
  /** Integer cents (分), > 0. */
  readonly amountCents: number
  /** What the payer sees in the bill (WeChat `description`, Alipay `subject`). */
  readonly title: string
  /** Epoch ms after which the QR must no longer be payable. */
  readonly expiresAt: number
}

/**
 * The provider's view of one trade, after its signature was verified:
 * `paid` (WeChat `SUCCESS`, Alipay `TRADE_SUCCESS` / `TRADE_FINISHED`),
 * `pending` (not paid yet), `closed` (closed, revoked or refunded) or
 * `absent` (the provider has no such trade — for Alipay precreate, a QR that
 * was never scanned).
 */
export interface TradeStatus {
  readonly state: 'paid' | 'pending' | 'closed' | 'absent'
  readonly outTradeNo: string
  readonly amountCents: number | null
  readonly currency: string | null
  readonly providerTxnId: string | null
  /** The merchant identifiers in the message equal this deployment's config. */
  readonly merchantMatches: boolean
}

export type HeaderBag =
  | Headers
  | Readonly<Record<string, string | readonly string[] | undefined>>

/** An inbound payment notification exactly as received. */
export interface NotifyRequest {
  readonly headers: HeaderBag
  /** The raw body text; signatures cover these exact bytes. */
  readonly rawBody: string
  readonly contentType?: string
}

/** `ok: false` carries a reason for logs only — never the message content. */
export type NotifyVerdict =
  | { readonly ok: false; readonly reason: string }
  | { readonly ok: true; readonly trade: TradeStatus }

/** What the hub writes back to the provider. */
export interface NotifyReply {
  readonly httpStatus: number
  readonly body: string
  readonly headers: Readonly<Record<string, string>>
}

/** `ok`: accepted (no retry); `rejected`: bad message; `retry`: our failure. */
export type ReplyOutcome = 'ok' | 'rejected' | 'retry'

export interface PaymentChannel {
  readonly id: PaymentChannelId
  createQr(request: QrRequest): Promise<{ readonly qrText: string }>
  /** Signature, freshness and decryption; no business matching. */
  verifyNotify(request: NotifyRequest, now: number): NotifyVerdict
  query(outTradeNo: string): Promise<TradeStatus>
  /** Resolves when the trade is closed or never existed. */
  close(outTradeNo: string): Promise<void>
  reply(outcome: ReplyOutcome, message: string): NotifyReply
}

/** A channel call failed. The message never contains secrets or raw bodies. */
export class ChannelError extends Error {
  override readonly name = 'ChannelError'
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

/** Case-insensitive single-valued header lookup; repeated headers count as absent. */
export function headerOf(headers: HeaderBag, name: string): string | undefined {
  if (headers instanceof Headers) return headers.get(name) ?? undefined
  const wanted = name.toLowerCase()
  let found: string | undefined
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== wanted || value === undefined) continue
    if (found !== undefined || typeof value !== 'string') return undefined
    found = value
  }
  return found
}
