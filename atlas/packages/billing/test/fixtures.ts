// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Test doubles: in-test RSA keys, secret files, and local Bun.serve fakes of
 * the WeChat Pay v3 and Alipay gateways. Nothing here touches the network
 * beyond 127.0.0.1.
 */

import {
  createCipheriv,
  generateKeyPairSync,
  type KeyObject,
  randomBytes,
  sign as rsaSign,
  verify as rsaVerify,
} from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { alipaySignContent } from '../src/channels/alipay.js'

export interface KeyPair {
  readonly privateKey: KeyObject
  readonly publicKey: KeyObject
  readonly privatePem: string
  readonly publicPem: string
}

export function rsaPair(): KeyPair {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
  })
  return {
    privateKey,
    publicKey,
    privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  }
}

/** Keys shared by a test file: merchant, WeChat Pay platform, Alipay app, Alipay. */
export interface Keys {
  readonly merchant: KeyPair
  readonly wechat: KeyPair
  readonly app: KeyPair
  readonly alipay: KeyPair
  /** 32 ASCII bytes. */
  readonly apiV3Key: string
}

export function makeKeys(): Keys {
  return {
    merchant: rsaPair(),
    wechat: rsaPair(),
    app: rsaPair(),
    alipay: rsaPair(),
    apiV3Key: randomBytes(16).toString('hex'),
  }
}

export const MCHID = '1900007291'
export const APPID = 'wxd678efh567hg6787'
export const SERIAL = '408B07E79B8269FEC3D5D3E6AB8ED163A6A380DB'
export const PUB_KEY_ID = 'PUB_KEY_ID_0119000072912024'
export const ALIPAY_APP_ID = '2021000122671080'

export function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'qm-billing-'))
}

/** Writes the four key files and the APIv3 key with `mode`; returns their paths. */
export function writeSecrets(dir: string, keys: Keys, mode = 0o600) {
  const files = {
    merchantPrivateKeyFile: join(dir, 'apiclient_key.pem'),
    apiV3KeyFile: join(dir, 'apiv3.key'),
    wechatpayPublicKeyFile: join(dir, 'pub_key.pem'),
    appPrivateKeyFile: join(dir, 'alipay_app_private.txt'),
    alipayPublicKeyFile: join(dir, 'alipay_public.txt'),
  }
  writeFileSync(files.merchantPrivateKeyFile, keys.merchant.privatePem, {
    mode,
  })
  writeFileSync(files.apiV3KeyFile, `${keys.apiV3Key}\n`, { mode })
  writeFileSync(files.wechatpayPublicKeyFile, keys.wechat.publicPem, { mode })
  // The Alipay key tool writes bare base64 without PEM armour.
  writeFileSync(
    files.appPrivateKeyFile,
    keys.app.privateKey
      .export({ type: 'pkcs1', format: 'der' })
      .toString('base64'),
    { mode },
  )
  writeFileSync(
    files.alipayPublicKeyFile,
    keys.alipay.publicKey
      .export({ type: 'spki', format: 'der' })
      .toString('base64'),
    { mode },
  )
  return files
}

export function configJson(
  files: ReturnType<typeof writeSecrets>,
  endpoints: { wechat?: string; alipay?: string } = {},
): Record<string, unknown> {
  return {
    version: 1,
    currency: 'CNY',
    sourceUrl: 'https://github.com/sweetcornna/atlas',
    termsUrl: null,
    plans: [
      {
        id: 'month',
        name: '月度',
        priceCents: 9900,
        periodDays: 30,
        note: '每月 30 美元额度',
        gateway: {
          limits: [{ period: 'month', costUsd: 30 }],
          models: ['group/standard'],
        },
      },
      {
        id: 'pro',
        name: '专业',
        priceCents: 29900,
        periodDays: 30,
        gateway: {
          limits: [
            { period: 'days', days: 7, tokens: 50_000_000 },
            { period: 'hours', hours: 5, costUsd: 10 },
          ],
          models: ['openai/*', 'anthropic/claude-sonnet-4-5'],
        },
      },
    ],
    channels: {
      wechatpay: {
        mchid: MCHID,
        appid: APPID,
        merchantSerialNo: SERIAL,
        merchantPrivateKeyFile: files.merchantPrivateKeyFile,
        apiV3KeyFile: files.apiV3KeyFile,
        wechatpayPublicKeyId: PUB_KEY_ID,
        wechatpayPublicKeyFile: files.wechatpayPublicKeyFile,
        notifyUrl: 'https://hub.example.com/billing/notify/wechatpay',
        ...(endpoints.wechat ? { endpoint: endpoints.wechat } : {}),
      },
      alipay: {
        appId: ALIPAY_APP_ID,
        appPrivateKeyFile: files.appPrivateKeyFile,
        alipayPublicKeyFile: files.alipayPublicKeyFile,
        notifyUrl: 'https://hub.example.com/billing/notify/alipay',
        ...(endpoints.alipay ? { endpoint: endpoints.alipay } : {}),
      },
      redeem: { enabled: true },
    },
    orderTtlMinutes: 15,
  }
}

// ───────────────────────────── WeChat Pay ─────────────────────────────

/** Headers WeChat Pay would put on a signed response or notification. */
export function wechatSigned(
  keys: Keys,
  body: string,
  nowMs: number,
  options: { serial?: string; signature?: string; timestamp?: number } = {},
): Record<string, string> {
  const timestamp = String(options.timestamp ?? Math.floor(nowMs / 1000))
  const nonce = randomBytes(16).toString('hex')
  const signature =
    options.signature ??
    rsaSign(
      'RSA-SHA256',
      Buffer.from(`${timestamp}\n${nonce}\n${body}\n`, 'utf8'),
      keys.wechat.privateKey,
    ).toString('base64')
  return {
    'Wechatpay-Timestamp': timestamp,
    'Wechatpay-Nonce': nonce,
    'Wechatpay-Serial': options.serial ?? PUB_KEY_ID,
    'Wechatpay-Signature': signature,
  }
}

/** A TRANSACTION.SUCCESS notification encrypted with the APIv3 key. */
export function wechatNotify(
  keys: Keys,
  nowMs: number,
  transaction: {
    outTradeNo: string
    total: number
    currency?: string
    mchid?: string
    appid?: string
    tradeState?: string
    transactionId?: string
  },
  options: { serial?: string; signature?: string; timestamp?: number } = {},
): { headers: Record<string, string>; rawBody: string } {
  const plaintext = JSON.stringify({
    mchid: transaction.mchid ?? MCHID,
    appid: transaction.appid ?? APPID,
    out_trade_no: transaction.outTradeNo,
    transaction_id: transaction.transactionId ?? '4200000001202610160000000001',
    trade_type: 'NATIVE',
    trade_state: transaction.tradeState ?? 'SUCCESS',
    trade_state_desc: '支付成功',
    bank_type: 'OTHERS',
    success_time: '2026-10-16T12:00:00+08:00',
    payer: { openid: 'oUpF8uMuAJO_M2pxb1Q9zNjWeS6o' },
    amount: {
      total: transaction.total,
      payer_total: transaction.total,
      currency: transaction.currency ?? 'CNY',
      payer_currency: 'CNY',
    },
  })
  const nonce = randomBytes(6).toString('hex')
  const cipher = createCipheriv(
    'aes-256-gcm',
    Buffer.from(keys.apiV3Key, 'utf8'),
    Buffer.from(nonce, 'utf8'),
  )
  cipher.setAAD(Buffer.from('transaction', 'utf8'))
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
    cipher.getAuthTag(),
  ]).toString('base64')
  const rawBody = JSON.stringify({
    id: 'EV-2018022511223320873',
    create_time: '2026-10-16T12:00:01+08:00',
    resource_type: 'encrypt-resource',
    event_type: 'TRANSACTION.SUCCESS',
    summary: '支付成功',
    resource: {
      original_type: 'transaction',
      algorithm: 'AEAD_AES_256_GCM',
      ciphertext,
      associated_data: 'transaction',
      nonce,
    },
  })
  return { headers: wechatSigned(keys, rawBody, nowMs, options), rawBody }
}

interface FakeTrade {
  total: number
  state: string
  transactionId: string | null
}

/** A local WeChat Pay v3 server that checks request signatures. */
export function startWechatFake(keys: Keys, now: () => number) {
  const trades = new Map<string, FakeTrade>()
  const requests: { method: string; path: string; body: string }[] = []
  const control = { badResponseSignature: false, failCreate: false }
  const reply = (status: number, body: string) =>
    new Response(status === 204 ? null : body, {
      status,
      headers: {
        'content-type': 'application/json',
        ...wechatSigned(keys, body, now(), {
          ...(control.badResponseSignature
            ? { signature: Buffer.from('forged').toString('base64') }
            : {}),
        }),
      },
    })
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      const url = new URL(request.url)
      const body = request.method === 'GET' ? '' : await request.text()
      const pathWithQuery = `${url.pathname}${url.search}`
      requests.push({ method: request.method, path: pathWithQuery, body })
      const auth = request.headers.get('authorization') ?? ''
      const fields = Object.fromEntries(
        [...auth.matchAll(/(\w+)="([^"]*)"/g)].map(m => [m[1], m[2]]),
      )
      const signedOk =
        auth.startsWith('WECHATPAY2-SHA256-RSA2048 ') &&
        fields['mchid'] === MCHID &&
        fields['serial_no'] === SERIAL &&
        rsaVerify(
          'RSA-SHA256',
          Buffer.from(
            `${request.method}\n${pathWithQuery}\n${fields['timestamp']}\n${fields['nonce_str']}\n${body}\n`,
            'utf8',
          ),
          keys.merchant.publicKey,
          Buffer.from(fields['signature'] ?? '', 'base64'),
        )
      if (!signedOk)
        return reply(
          401,
          JSON.stringify({ code: 'SIGN_ERROR', message: '签名错误' }),
        )
      if (
        request.method === 'POST' &&
        url.pathname === '/v3/pay/transactions/native'
      ) {
        if (control.failCreate)
          return reply(
            500,
            JSON.stringify({ code: 'SYSTEM_ERROR', message: '系统错误' }),
          )
        const order = JSON.parse(body)
        trades.set(order.out_trade_no, {
          total: order.amount.total,
          state: 'NOTPAY',
          transactionId: null,
        })
        return reply(
          200,
          JSON.stringify({
            code_url: `weixin://wxpay/bizpayurl/up?pr=${order.out_trade_no.slice(0, 8)}`,
          }),
        )
      }
      const match =
        /^\/v3\/pay\/transactions\/out-trade-no\/([^/]+)(\/close)?$/.exec(
          url.pathname,
        )
      if (match) {
        const no = match[1]!
        const trade = trades.get(no)
        if (match[2]) {
          if (trade) trade.state = 'CLOSED'
          return reply(204, '')
        }
        if (url.searchParams.get('mchid') !== MCHID)
          return reply(400, JSON.stringify({ code: 'PARAM_ERROR' }))
        if (!trade)
          return reply(
            404,
            JSON.stringify({ code: 'ORDER_NOT_EXIST', message: '订单不存在' }),
          )
        return reply(
          200,
          JSON.stringify({
            appid: APPID,
            mchid: MCHID,
            out_trade_no: no,
            trade_state: trade.state,
            ...(trade.transactionId
              ? { transaction_id: trade.transactionId }
              : {}),
            amount: { total: trade.total, currency: 'CNY' },
          }),
        )
      }
      return reply(404, JSON.stringify({ code: 'NOT_FOUND' }))
    },
  })
  return {
    origin: `http://127.0.0.1:${server.port}`,
    trades,
    requests,
    control,
    pay(outTradeNo: string) {
      const trade = trades.get(outTradeNo)
      if (!trade) throw new Error(`no trade ${outTradeNo}`)
      trade.state = 'SUCCESS'
      trade.transactionId = '4200000001202610160000000002'
    },
    stop: () => server.stop(true),
  }
}

// ───────────────────────────── Alipay ─────────────────────────────

/** A signed async notification as Alipay would POST it. */
export function alipayNotify(
  keys: Keys,
  fields: {
    outTradeNo: string
    totalAmount: string
    tradeStatus?: string
    appId?: string
  },
): { rawBody: string; contentType: string } {
  const params: Record<string, string> = {
    notify_time: '2026-10-16 12:00:05',
    notify_type: 'trade_status_sync',
    notify_id: 'ac05099524730693a8b330c5ecf72da9786',
    charset: 'utf-8',
    version: '1.0',
    app_id: fields.appId ?? ALIPAY_APP_ID,
    auth_app_id: fields.appId ?? ALIPAY_APP_ID,
    trade_no: '2026101622001400000000000001',
    out_trade_no: fields.outTradeNo,
    trade_status: fields.tradeStatus ?? 'TRADE_SUCCESS',
    total_amount: fields.totalAmount,
    receipt_amount: fields.totalAmount,
    buyer_pay_amount: fields.totalAmount,
    subject: '月度',
    gmt_create: '2026-10-16 11:59:50',
    gmt_payment: '2026-10-16 12:00:04',
    fund_bill_list: '[{"amount":"99.00","fundChannel":"ALIPAYACCOUNT"}]',
  }
  params['sign'] = rsaSign(
    'RSA-SHA256',
    Buffer.from(alipaySignContent(params), 'utf8'),
    keys.alipay.privateKey,
  ).toString('base64')
  params['sign_type'] = 'RSA2'
  return {
    rawBody: new URLSearchParams(params).toString(),
    contentType: 'application/x-www-form-urlencoded; charset=utf-8',
  }
}

/**
 * The raw response text: the node is written by hand with escaped slashes
 * and odd spacing, so re-serialising it would not reproduce the signed bytes.
 */
export function alipayResponse(
  keys: Keys,
  method: string,
  rawNode: string,
  options: { forge?: boolean; omitSign?: boolean } = {},
): string {
  const key = `${method.replaceAll('.', '_')}_response`
  const signature = options.forge
    ? Buffer.from('forged').toString('base64')
    : rsaSign(
        'RSA-SHA256',
        Buffer.from(rawNode, 'utf8'),
        keys.alipay.privateKey,
      ).toString('base64')
  if (options.omitSign) return `{"${key}":${rawNode}}`
  return `{"${key}":${rawNode},"sign":"${signature}"}`
}

/** A local Alipay classic gateway that checks request signatures. */
export function startAlipayFake(keys: Keys) {
  const trades = new Map<string, { total: string; status: string }>()
  const requests: { method: string; biz: Record<string, unknown> }[] = []
  const control = { forge: false, omitSign: false }
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      const url = new URL(request.url)
      const params: Record<string, string> = Object.fromEntries(
        url.searchParams,
      )
      for (const [key, value] of new URLSearchParams(await request.text()))
        params[key] = value
      const method = params['method'] ?? ''
      const ok =
        params['app_id'] === ALIPAY_APP_ID &&
        params['sign_type'] === 'RSA2' &&
        params['charset'] === 'utf-8' &&
        /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(
          params['timestamp'] ?? '',
        ) &&
        rsaVerify(
          'RSA-SHA256',
          Buffer.from(alipaySignContent(params), 'utf8'),
          keys.app.publicKey,
          Buffer.from(params['sign'] ?? '', 'base64'),
        )
      const respond = (node: string) =>
        new Response(alipayResponse(keys, method, node, control), {
          headers: { 'content-type': 'text/html;charset=utf-8' },
        })
      if (!ok)
        return respond(
          '{"code":"40002","msg":"Invalid Arguments","sub_code":"isv.invalid-signature","sub_msg":"验签出错"}',
        )
      const biz = JSON.parse(params['biz_content'] ?? '{}')
      requests.push({ method, biz })
      const no = String(biz.out_trade_no)
      if (method === 'alipay.trade.precreate') {
        trades.set(no, { total: biz.total_amount, status: 'NOT_SCANNED' })
        return respond(
          `{ "code" : "10000", "msg":"Success","out_trade_no":"${no}","qr_code":"https:\\/\\/qr.alipay.com\\/bax0${no.slice(0, 6)}"}`,
        )
      }
      const trade = trades.get(no)
      if (method === 'alipay.trade.query' || method === 'alipay.trade.close') {
        if (!trade || trade.status === 'NOT_SCANNED')
          return respond(
            '{"code":"40004","msg":"Business Failed","sub_code":"ACQ.TRADE_NOT_EXIST","sub_msg":"交易不存在"}',
          )
        if (method === 'alipay.trade.close') {
          trade.status = 'TRADE_CLOSED'
          return respond(
            `{"code":"10000","msg":"Success","out_trade_no":"${no}","trade_no":"2026101622001400000000000009"}`,
          )
        }
        return respond(
          `{"code":"10000","msg":"Success","out_trade_no":"${no}","trade_no":"2026101622001400000000000009","trade_status":"${trade.status}","total_amount":"${trade.total}","buyer_logon_id":"159****5620"}`,
        )
      }
      return respond('{"code":"40004","msg":"Business Failed"}')
    },
  })
  return {
    endpoint: `http://127.0.0.1:${server.port}/gateway.do`,
    trades,
    requests,
    control,
    scan(outTradeNo: string, status = 'WAIT_BUYER_PAY') {
      const trade = trades.get(outTradeNo)
      if (!trade) throw new Error(`no trade ${outTradeNo}`)
      trade.status = status
    },
    stop: () => server.stop(true),
  }
}

/** A provisioner that records calls and can be told to fail. */
export function fakeProvisioner() {
  const calls: string[] = []
  const state = new Map<string, { enabled: boolean; models: string[] }>()
  const control = { failEnsure: false, failDisable: false }
  return {
    calls,
    state,
    control,
    async ensure(subject: string, plan: { models: readonly string[] }) {
      calls.push(`ensure ${subject}`)
      if (control.failEnsure)
        throw new Error('gateway down sk-live-SHOULD-NOT-LEAK')
      const prior = state.get(subject)
      state.set(subject, {
        enabled: prior?.enabled ?? false,
        models: [...plan.models],
      })
      return { binding: `key-${subject}` }
    },
    async setEnabled(subject: string, enabled: boolean) {
      calls.push(`${enabled ? 'enable' : 'disable'} ${subject}`)
      if (!enabled && control.failDisable) throw new Error('gateway down')
      const prior = state.get(subject)
      if (prior) prior.enabled = enabled
    },
  }
}
