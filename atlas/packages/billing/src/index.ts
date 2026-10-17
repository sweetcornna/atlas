// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * # @qianmo/billing — 公开版订阅
 *
 * The public edition is usable only with a paid subscription, priced per
 * hosted node. This package is the domain logic and the official
 * payment-channel adapters; the hub owns HTTP routes, the checkout page, the
 * operator page, the tenant and the gateway (magpie) side of
 * {@link GatewayProvisioner}.
 *
 * ## Model
 *
 * - **Plans** (`billing.json`, {@link parseBillingConfig}): price in integer
 *   cents (分) + period in days + the hosted nodes included (`nodes`) +
 *   optional fair-use windows on the subscriber's gateway key
 *   (`gatewayLimits`). **Model quota is not sold**: the subscriber connects
 *   their own upstream keys through the platform gateway. Prepaid, never
 *   auto-debit: each purchase extends `endsAt = max(now, endsAt) + periodDays`.
 * - **Channels**: WeChat Pay API v3 Native (`code_url`) and Alipay 当面付
 *   precreate (`qr_code`), both official native APIs (charter §7.2 item 8);
 *   plus operator-issued **redeem codes** (SHA-256 stored, single use).
 *   **Both payment channels are 未评估** — exercised only against local
 *   fakes, never against a real merchant account. Each adapter's header lists
 *   the protocol facts it relies on and where they come from.
 * - **Ledger** ({@link BillingStore}): bun:sqlite, WAL, file mode 0600;
 *   every state change appends a SHA-256-chained event in the same
 *   transaction; `verifyChain()` also cross-checks the state tables.
 *
 * ## Secrets
 *
 * The merchant private key, APIv3 key, Alipay app private key, Alipay public
 * key and WeChat Pay public key are referenced by absolute file path; the
 * files must be mode 0600 or stricter ({@link readSecretFile}). They are
 * loaded as `KeyObject`s, which serialise as `{}`. Errors, log lines, events
 * and snapshots carry identifiers only.
 *
 * ## Hub wiring (expected)
 *
 * ```ts
 * const config = parseBillingConfig(readFileSync(billingConfigPath(), 'utf8'))
 * const store = new BillingStore(billingStorePath())
 * const billing = new BillingService({
 *   config, store, provisioner, channels: createPaymentChannels(config),
 * })
 * // POST /billing/notify/wechatpay  → billing.handleNotify('wechatpay', { headers, rawBody })
 * // POST /billing/notify/alipay     → billing.handleNotify('alipay', { headers, rawBody, contentType })
 * // every minute                    → billing.sweep()
 * ```
 *
 * The notify routes must hand over the raw body text untouched (signatures
 * cover the exact bytes) and must not require a login. `sourceUrl` is
 * mandatory: AGPL §13 obliges a public deployment to offer its Corresponding
 * Source, so the hub should link it from every page.
 */

export {
  type AlipayChannelOptions,
  AlipayChannel,
} from './channels/alipay.js'
export type {
  NotifyReply,
  NotifyRequest,
  PaymentChannel,
  PaymentChannelId,
  QrRequest,
  TradeStatus,
} from './channels/types.js'
export { ChannelError } from './channels/types.js'
export {
  type WechatPayChannelOptions,
  WechatPayChannel,
} from './channels/wechatpay.js'
export type { FetchLike } from './channels/wire.js'
export {
  type AlipayConfig,
  type BillingConfig,
  BillingConfigError,
  billingConfigPath,
  billingStorePath,
  type LimitPeriod,
  type Plan,
  type PlanLimit,
  type PlanProvision,
  parseBillingConfig,
  type WechatPayConfig,
} from './config.js'
export { readSecretFile, type SecretReader } from './secrets.js'
export {
  type AdminSnapshot,
  BillingError,
  type BillingErrorCode,
  BillingService,
  type BillingServiceOptions,
  type CreatedOrder,
  createPaymentChannels,
  type Entitlement,
  type GatewayProvisioner,
  type OrderView,
  type PublicPlan,
  type SweepReport,
} from './service.js'
export {
  type BillingEvent,
  BillingStore,
  type ChainReport,
  type GatewayState,
  type OrderRow,
  type OrderStatus,
  type RedeemCodeRow,
  type SubscriptionRow,
} from './store.js'
