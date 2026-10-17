// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The billing config (`billing.json` beside the hub's console state). Strict:
 * every object rejects unknown keys, so a typo such as `priceCent` fails at
 * load instead of silently selling a plan for nothing. Secrets are file paths
 * here and `KeyObject`s after parsing (see `secrets.ts`).
 */

import type { KeyObject } from 'node:crypto'
import { isIP } from 'node:net'
import { qianmoConfigPath } from '@qianmo/paths'
import {
  loadApiV3Key,
  loadRsaPrivateKey,
  loadRsaPublicKey,
  readSecretFile,
  type SecretReader,
} from './secrets.js'

/** Where the hub keeps the billing config by default. */
export function billingConfigPath(): string {
  return qianmoConfigPath('qianmo', 'console', 'billing.json')
}

/** Where the hub keeps the billing database by default. */
export function billingStorePath(): string {
  return qianmoConfigPath('qianmo', 'console', 'billing.sqlite')
}

export type LimitPeriod = 'day' | 'week' | 'month' | 'days' | 'hours'

/** One gateway limit window; `days` / `hours` only with the matching period. */
export interface PlanLimit {
  readonly period: LimitPeriod
  readonly days?: number
  readonly hours?: number
  readonly tokens?: number
  readonly costUsd?: number
  readonly cacheReads?: number
}

/** What a subscriber's gateway key may do. Handed to the provisioner as is. */
export interface PlanGateway {
  readonly limits: readonly PlanLimit[]
  /** `provider/model`, `provider/*` or `group/<id>`. */
  readonly models: readonly string[]
}

export interface Plan {
  readonly id: string
  readonly name: string
  /** Integer cents (分). */
  readonly priceCents: number
  readonly periodDays: number
  readonly note: string | null
  readonly gateway: PlanGateway
}

export interface WechatPayConfig {
  readonly mchid: string
  readonly appid: string
  readonly merchantSerialNo: string
  readonly merchantPrivateKey: KeyObject
  readonly apiV3Key: KeyObject
  readonly wechatpayPublicKeyId: string
  readonly wechatpayPublicKey: KeyObject
  readonly notifyUrl: string
  /** Origin without a trailing slash, e.g. `https://api.mch.weixin.qq.com`. */
  readonly endpoint: string
}

export interface AlipayConfig {
  readonly appId: string
  readonly appPrivateKey: KeyObject
  readonly alipayPublicKey: KeyObject
  readonly notifyUrl: string
  /** Full gateway URL, e.g. `https://openapi.alipay.com/gateway.do`. */
  readonly endpoint: string
}

export interface BillingConfig {
  readonly version: 1
  readonly currency: 'CNY'
  /** AGPL §13: where users of a public deployment get the Corresponding Source. */
  readonly sourceUrl: string
  readonly termsUrl: string | null
  readonly plans: readonly Plan[]
  readonly channels: {
    readonly wechatpay: WechatPayConfig | null
    readonly alipay: AlipayConfig | null
    readonly redeem: { readonly enabled: boolean }
  }
  readonly orderTtlMinutes: number
}

export class BillingConfigError extends Error {
  override readonly name = 'BillingConfigError'
}

const MAX_PLANS = 50
const MAX_LIMITS = 5
const MAX_MODELS = 500
const MAX_PRICE_CENTS = 100_000_000
const MAX_PERIOD_DAYS = 3660
const PLAN_ID = /^[a-z0-9][a-z0-9_-]{0,31}$/
const PROVIDER = '[A-Za-z0-9][A-Za-z0-9._-]{0,63}'
const MODEL_PATTERN = new RegExp(
  `^${PROVIDER}/(?:\\*|[A-Za-z0-9][A-Za-z0-9._:@+/-]{0,191})$`,
)
const GROUP_PATTERN = new RegExp(`^group/${PROVIDER}$`)
const PERIODS: readonly LimitPeriod[] = [
  'day',
  'week',
  'month',
  'days',
  'hours',
]

type Json = Record<string, unknown>

function fail(path: string, message: string): never {
  throw new BillingConfigError(`billing 配置 ${path}：${message}`)
}

function object(
  value: unknown,
  path: string,
  allowed: readonly string[],
): Json {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    fail(path, '必须是对象')
  const record = value as Json
  for (const key of Object.keys(record))
    if (!allowed.includes(key)) fail(`${path}.${key}`, '未知字段')
  return record
}

function text(
  value: unknown,
  path: string,
  options: { max: number; pattern?: RegExp } = { max: 256 },
): string {
  if (typeof value !== 'string' || value.length === 0)
    fail(path, '必须是非空字符串')
  if (value.length > options.max) fail(path, `不能超过 ${options.max} 个字符`)
  if (/\p{Cc}/u.test(value)) fail(path, '不能含控制字符')
  if (options.pattern && !options.pattern.test(value)) fail(path, '格式不对')
  return value
}

function integer(value: unknown, path: string, min: number, max: number) {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < min ||
    value > max
  )
    fail(path, `必须是 ${min}–${max} 之间的整数`)
  return value
}

function absolutePath(value: unknown, path: string): string {
  const file = text(value, path, { max: 4096 })
  if (!file.startsWith('/')) fail(path, '必须是绝对路径')
  return file
}

function httpsUrl(value: unknown, path: string): URL {
  const raw = text(value, path, { max: 2048 })
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    fail(path, '不是合法 URL')
  }
  if (url.protocol !== 'https:') fail(path, '必须是 https:// 地址')
  if (url.username !== '' || url.password !== '') fail(path, '不能带用户名密码')
  return url
}

/** WeChat Pay's notify_url rules, applied to both channels. */
function notifyUrl(value: unknown, path: string): string {
  const url = httpsUrl(value, path)
  if (url.search !== '' || url.hash !== '') fail(path, '不能带查询参数或片段')
  if (url.pathname === '/' || url.pathname === '') fail(path, '必须带具体路径')
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (isIP(host) !== 0 || host === 'localhost')
    fail(path, '必须是公网可访问的域名，不能是 IP 或 localhost')
  return url.toString()
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]'])

/** API endpoint: https, or plain http to loopback (local test doubles only). */
function endpoint(value: unknown, path: string, keepPath: boolean): string {
  const raw = text(value, path, { max: 2048 })
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    fail(path, '不是合法 URL')
  }
  const loopbackHttp = url.protocol === 'http:' && LOOPBACK.has(url.hostname)
  if (url.protocol !== 'https:' && !loopbackHttp)
    fail(path, '必须是 https:// 地址')
  if (url.search !== '' || url.hash !== '' || url.username !== '')
    fail(path, '不能带查询参数、片段或用户名')
  if (!keepPath) {
    if (url.pathname !== '/') fail(path, '只能是源地址（不带路径）')
    return url.origin
  }
  return url.toString()
}

function secret<T>(
  file: string,
  path: string,
  readSecret: SecretReader,
  load: (content: string, label: string) => T,
): T {
  let content: string
  try {
    content = readSecret(file)
  } catch (error) {
    fail(path, error instanceof Error ? error.message : '密钥文件读取失败')
  }
  try {
    return load(content, path)
  } catch (error) {
    fail(path, error instanceof Error ? error.message : '密钥无法解析')
  }
}

function limit(value: unknown, path: string): PlanLimit {
  const record = object(value, path, [
    'period',
    'days',
    'hours',
    'tokens',
    'costUsd',
    'cacheReads',
  ])
  const period = record['period']
  if (typeof period !== 'string' || !PERIODS.includes(period as LimitPeriod))
    fail(`${path}.period`, `必须是 ${PERIODS.join(' / ')} 之一`)
  const out: {
    period: LimitPeriod
    days?: number
    hours?: number
    tokens?: number
    costUsd?: number
    cacheReads?: number
  } = { period: period as LimitPeriod }
  if (period === 'days')
    out.days = integer(record['days'], `${path}.days`, 1, 366)
  else if (record['days'] !== undefined)
    fail(`${path}.days`, '只有 period 为 days 时才能填')
  if (period === 'hours')
    out.hours = integer(record['hours'], `${path}.hours`, 1, 8784)
  else if (record['hours'] !== undefined)
    fail(`${path}.hours`, '只有 period 为 hours 时才能填')
  if (record['tokens'] !== undefined)
    out.tokens = integer(
      record['tokens'],
      `${path}.tokens`,
      1,
      Number.MAX_SAFE_INTEGER,
    )
  if (record['cacheReads'] !== undefined)
    out.cacheReads = integer(
      record['cacheReads'],
      `${path}.cacheReads`,
      1,
      Number.MAX_SAFE_INTEGER,
    )
  if (record['costUsd'] !== undefined) {
    const cost = record['costUsd']
    if (
      typeof cost !== 'number' ||
      !Number.isFinite(cost) ||
      cost <= 0 ||
      cost > 1_000_000
    )
      fail(`${path}.costUsd`, '必须是 0–1000000 之间的正数')
    out.costUsd = cost
  }
  if (
    out.tokens === undefined &&
    out.costUsd === undefined &&
    out.cacheReads === undefined
  )
    fail(path, 'tokens、costUsd、cacheReads 至少填一个')
  return out
}

function gateway(value: unknown, path: string): PlanGateway {
  const record = object(value, path, ['limits', 'models'])
  const limits = record['limits']
  if (!Array.isArray(limits) || limits.length > MAX_LIMITS)
    fail(`${path}.limits`, `必须是不超过 ${MAX_LIMITS} 项的数组`)
  const models = record['models']
  if (
    !Array.isArray(models) ||
    models.length === 0 ||
    models.length > MAX_MODELS
  )
    fail(`${path}.models`, `必须是 1–${MAX_MODELS} 项的数组`)
  const seen = new Set<string>()
  const patterns = models.map((model, index) => {
    const at = `${path}.models[${index}]`
    const pattern = text(model, at, { max: 256 })
    const ok = pattern.startsWith('group/')
      ? GROUP_PATTERN.test(pattern)
      : MODEL_PATTERN.test(pattern)
    if (!ok) fail(at, '必须是 provider/model、provider/* 或 group/<id>')
    if (seen.has(pattern)) fail(at, '重复')
    seen.add(pattern)
    return pattern
  })
  return {
    limits: limits.map((item, index) =>
      limit(item, `${path}.limits[${index}]`),
    ),
    models: patterns,
  }
}

function plan(value: unknown, path: string): Plan {
  const record = object(value, path, [
    'id',
    'name',
    'priceCents',
    'periodDays',
    'note',
    'gateway',
  ])
  const note = record['note']
  return {
    id: text(record['id'], `${path}.id`, { max: 32, pattern: PLAN_ID }),
    name: text(record['name'], `${path}.name`, { max: 64 }),
    priceCents: integer(
      record['priceCents'],
      `${path}.priceCents`,
      1,
      MAX_PRICE_CENTS,
    ),
    periodDays: integer(
      record['periodDays'],
      `${path}.periodDays`,
      1,
      MAX_PERIOD_DAYS,
    ),
    note:
      note === undefined || note === null
        ? null
        : text(note, `${path}.note`, { max: 500 }),
    gateway: gateway(record['gateway'], `${path}.gateway`),
  }
}

function wechatpay(
  value: unknown,
  path: string,
  readSecret: SecretReader,
): WechatPayConfig {
  const record = object(value, path, [
    'mchid',
    'appid',
    'merchantSerialNo',
    'merchantPrivateKeyFile',
    'apiV3KeyFile',
    'wechatpayPublicKeyId',
    'wechatpayPublicKeyFile',
    'notifyUrl',
    'endpoint',
  ])
  return {
    mchid: text(record['mchid'], `${path}.mchid`, {
      max: 32,
      pattern: /^[0-9]{6,32}$/,
    }),
    appid: text(record['appid'], `${path}.appid`, {
      max: 32,
      pattern: /^[A-Za-z0-9_]{1,32}$/,
    }),
    merchantSerialNo: text(
      record['merchantSerialNo'],
      `${path}.merchantSerialNo`,
      { max: 64, pattern: /^[0-9A-Fa-f]{8,64}$/ },
    ),
    merchantPrivateKey: secret(
      absolutePath(
        record['merchantPrivateKeyFile'],
        `${path}.merchantPrivateKeyFile`,
      ),
      `${path}.merchantPrivateKeyFile`,
      readSecret,
      loadRsaPrivateKey,
    ),
    apiV3Key: secret(
      absolutePath(record['apiV3KeyFile'], `${path}.apiV3KeyFile`),
      `${path}.apiV3KeyFile`,
      readSecret,
      loadApiV3Key,
    ),
    wechatpayPublicKeyId: text(
      record['wechatpayPublicKeyId'],
      `${path}.wechatpayPublicKeyId`,
      { max: 80, pattern: /^PUB_KEY_ID_[0-9A-Za-z]{1,64}$/ },
    ),
    wechatpayPublicKey: secret(
      absolutePath(
        record['wechatpayPublicKeyFile'],
        `${path}.wechatpayPublicKeyFile`,
      ),
      `${path}.wechatpayPublicKeyFile`,
      readSecret,
      loadRsaPublicKey,
    ),
    notifyUrl: notifyUrl(record['notifyUrl'], `${path}.notifyUrl`),
    endpoint:
      record['endpoint'] === undefined
        ? 'https://api.mch.weixin.qq.com'
        : endpoint(record['endpoint'], `${path}.endpoint`, false),
  }
}

function alipay(
  value: unknown,
  path: string,
  readSecret: SecretReader,
): AlipayConfig {
  const record = object(value, path, [
    'appId',
    'appPrivateKeyFile',
    'alipayPublicKeyFile',
    'notifyUrl',
    'endpoint',
  ])
  return {
    appId: text(record['appId'], `${path}.appId`, {
      max: 32,
      pattern: /^[0-9]{8,32}$/,
    }),
    appPrivateKey: secret(
      absolutePath(record['appPrivateKeyFile'], `${path}.appPrivateKeyFile`),
      `${path}.appPrivateKeyFile`,
      readSecret,
      loadRsaPrivateKey,
    ),
    alipayPublicKey: secret(
      absolutePath(
        record['alipayPublicKeyFile'],
        `${path}.alipayPublicKeyFile`,
      ),
      `${path}.alipayPublicKeyFile`,
      readSecret,
      loadRsaPublicKey,
    ),
    notifyUrl: notifyUrl(record['notifyUrl'], `${path}.notifyUrl`),
    endpoint:
      record['endpoint'] === undefined
        ? 'https://openapi.alipay.com/gateway.do'
        : endpoint(record['endpoint'], `${path}.endpoint`, true),
  }
}

/**
 * Parse and validate a billing config (an object, or its JSON text). Secret
 * files are read through `readSecret` (default: {@link readSecretFile}, which
 * insists on mode 0600 or stricter).
 */
export function parseBillingConfig(
  json: unknown,
  options: { readSecret?: SecretReader } = {},
): BillingConfig {
  const readSecret = options.readSecret ?? readSecretFile
  let input = json
  if (typeof json === 'string') {
    try {
      input = JSON.parse(json)
    } catch {
      fail('$', '不是合法 JSON')
    }
  }
  const root = object(input, '$', [
    'version',
    'currency',
    'sourceUrl',
    'termsUrl',
    'plans',
    'channels',
    'orderTtlMinutes',
  ])
  if (root['version'] !== 1) fail('$.version', '只支持 1')
  if (root['currency'] !== 'CNY') fail('$.currency', '只支持 CNY')
  if (root['sourceUrl'] === undefined)
    fail('$.sourceUrl', '必填（AGPL 第 13 条：公开部署须提供对应源码）')
  const sourceUrl = httpsUrl(root['sourceUrl'], '$.sourceUrl').toString()
  const termsUrl =
    root['termsUrl'] === undefined || root['termsUrl'] === null
      ? null
      : httpsUrl(root['termsUrl'], '$.termsUrl').toString()
  const rawPlans = root['plans']
  if (
    !Array.isArray(rawPlans) ||
    rawPlans.length === 0 ||
    rawPlans.length > MAX_PLANS
  )
    fail('$.plans', `必须是 1–${MAX_PLANS} 项的数组`)
  const plans = rawPlans.map((item, index) => plan(item, `$.plans[${index}]`))
  const ids = new Set<string>()
  for (const [index, item] of plans.entries()) {
    if (ids.has(item.id)) fail(`$.plans[${index}].id`, '重复')
    ids.add(item.id)
  }
  const channels = object(root['channels'], '$.channels', [
    'wechatpay',
    'alipay',
    'redeem',
  ])
  const redeemRaw =
    channels['redeem'] === undefined
      ? { enabled: false }
      : object(channels['redeem'], '$.channels.redeem', ['enabled'])
  if (typeof redeemRaw['enabled'] !== 'boolean')
    fail('$.channels.redeem.enabled', '必须是布尔值')
  const wechat =
    channels['wechatpay'] === undefined || channels['wechatpay'] === null
      ? null
      : wechatpay(channels['wechatpay'], '$.channels.wechatpay', readSecret)
  const ali =
    channels['alipay'] === undefined || channels['alipay'] === null
      ? null
      : alipay(channels['alipay'], '$.channels.alipay', readSecret)
  if (wechat === null && ali === null && redeemRaw['enabled'] !== true)
    fail('$.channels', '至少启用一个渠道')
  return {
    version: 1,
    currency: 'CNY',
    sourceUrl,
    termsUrl,
    plans,
    channels: {
      wechatpay: wechat,
      alipay: ali,
      redeem: { enabled: redeemRaw['enabled'] === true },
    },
    orderTtlMinutes:
      root['orderTtlMinutes'] === undefined
        ? 15
        : integer(root['orderTtlMinutes'], '$.orderTtlMinutes', 5, 120),
  }
}
