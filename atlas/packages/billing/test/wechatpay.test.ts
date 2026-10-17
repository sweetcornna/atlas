// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterAll, describe, expect, test } from 'bun:test'
import {
  createCipheriv,
  createSecretKey,
  generateKeyPairSync,
  sign as rsaSign,
  verify as rsaVerify,
} from 'node:crypto'
import { WechatPayChannel } from '../src/channels/wechatpay.js'
import { ChannelError, parseBillingConfig } from '../src/index.js'
import {
  configJson,
  makeKeys,
  startWechatFake,
  tempDir,
  wechatNotify,
  writeSecrets,
} from './fixtures.js'

const keys = makeKeys()
let clock = Date.UTC(2026, 9, 16, 4, 0, 0)
const now = () => clock
const fake = startWechatFake(keys, now)
afterAll(() => fake.stop())

const config = parseBillingConfig(
  configJson(writeSecrets(tempDir(), keys), { wechat: fake.origin }),
).channels.wechatpay!
const channel = new WechatPayChannel({ config, now })

describe('request signing', () => {
  // The message format and the header are written out here from the
  // documentation's description; the key and the expected signature are made
  // in the test (no example key or example request from the documentation).
  const signer = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const timestamp = 1_800_000_000
  const nonce = '0F1E2D3C4B5A69788796A5B4C3D2E1F0'
  const signing = new WechatPayChannel({
    config: { ...config, merchantPrivateKey: signer.privateKey },
    now: () => timestamp * 1000,
    nonce: () => nonce,
  })

  function expectSigned(header: string, message: string): void {
    const signature = rsaSign(
      'RSA-SHA256',
      Buffer.from(message, 'utf8'),
      signer.privateKey,
    ).toString('base64')
    expect(header).toBe(
      `WECHATPAY2-SHA256-RSA2048 mchid="${config.mchid}",nonce_str="${nonce}",` +
        `signature="${signature}",timestamp="${timestamp}",serial_no="${config.merchantSerialNo}"`,
    )
    expect(
      rsaVerify(
        'RSA-SHA256',
        Buffer.from(message, 'utf8'),
        signer.publicKey,
        Buffer.from(signature, 'base64'),
      ),
    ).toBe(true)
  }

  test('a POST signs method, path, timestamp, nonce and body, each line ended by \\n', () => {
    const path = '/v3/pay/transactions/native'
    const body = JSON.stringify({
      appid: config.appid,
      mchid: config.mchid,
      description: '阡陌 · 签名测试',
      out_trade_no: 'S'.repeat(32),
      notify_url: config.notifyUrl,
      amount: { total: 100, currency: 'CNY' },
    })
    expectSigned(
      signing.authorization('POST', path, body),
      `POST\n${path}\n${timestamp}\n${nonce}\n${body}\n`,
    )
  })

  test('a GET signs the path with its query and an empty body line', () => {
    const path = `/v3/pay/transactions/out-trade-no/${'S'.repeat(32)}?mchid=${config.mchid}`
    expectSigned(
      signing.authorization('GET', path, ''),
      `GET\n${path}\n${timestamp}\n${nonce}\n\n`,
    )
  })
})

describe('against the local fake', () => {
  test('create → query → pay → query → close, every request signed', async () => {
    const outTradeNo = 'A'.repeat(31) + '1'
    const { qrText } = await channel.createQr({
      outTradeNo,
      amountCents: 9900,
      title: '月度',
      expiresAt: clock + 15 * 60_000,
    })
    expect(qrText).toStartWith('weixin://wxpay/bizpayurl/up?pr=')
    const sent = JSON.parse(fake.requests.at(-1)!.body)
    expect(sent).toEqual({
      appid: config.appid,
      mchid: config.mchid,
      description: '月度',
      out_trade_no: outTradeNo,
      time_expire: '2026-10-16T12:15:00+08:00',
      notify_url: 'https://hub.example.com/billing/notify/wechatpay',
      amount: { total: 9900, currency: 'CNY' },
    })
    expect(await channel.query(outTradeNo)).toMatchObject({
      state: 'pending',
      amountCents: 9900,
      merchantMatches: true,
    })
    fake.pay(outTradeNo)
    expect(await channel.query(outTradeNo)).toEqual({
      state: 'paid',
      outTradeNo,
      amountCents: 9900,
      currency: 'CNY',
      providerTxnId: '4200000001202610160000000002',
      merchantMatches: true,
    })
    expect(fake.requests.at(-1)!.path).toBe(
      `/v3/pay/transactions/out-trade-no/${outTradeNo}?mchid=${config.mchid}`,
    )
    await channel.close(outTradeNo)
    expect(fake.trades.get(outTradeNo)?.state).toBe('CLOSED')
  })

  test('an unknown order queries as absent', async () => {
    expect((await channel.query('B'.repeat(32))).state).toBe('absent')
  })

  test('a response with a bad signature is refused', async () => {
    fake.control.badResponseSignature = true
    try {
      // Like the official WXPayUtility, only 2xx answers are verified: a 404
      // still reads as absent, which can only lead to closing the order.
      await expect(channel.query('B'.repeat(32))).resolves.toMatchObject({
        state: 'absent',
      })
      const error = await channel
        .createQr({
          outTradeNo: 'C'.repeat(32),
          amountCents: 100,
          title: 't',
          expiresAt: clock + 60_000,
        })
        .catch(e => e)
      expect(error).toBeInstanceOf(ChannelError)
      expect(error.code).toBe('bad_signature')
    } finally {
      fake.control.badResponseSignature = false
    }
  })

  test('a response outside the 5-minute window is refused', async () => {
    const skewed = new WechatPayChannel({
      config,
      now: () => clock + 6 * 60_000,
    })
    const error = await skewed
      .createQr({
        outTradeNo: 'D'.repeat(32),
        amountCents: 100,
        title: 't',
        expiresAt: clock + 60_000,
      })
      .catch(e => e)
    // The fake accepts the request (it does not check freshness) and signs
    // its answer with its own clock; our side refuses the answer.
    expect(error).toBeInstanceOf(ChannelError)
    expect(error.message).toContain('5 分钟')
  })

  test('provider errors carry the code, not the body', async () => {
    fake.control.failCreate = true
    try {
      const error = await channel
        .createQr({
          outTradeNo: 'E'.repeat(32),
          amountCents: 100,
          title: 't',
          expiresAt: clock + 60_000,
        })
        .catch(e => e)
      expect(error.code).toBe('wechatpay:SYSTEM_ERROR')
      expect(error.message).not.toContain('系统错误')
    } finally {
      fake.control.failCreate = false
    }
  })
})

describe('notifications', () => {
  const tx = { outTradeNo: 'F'.repeat(32), total: 9900 }

  test('verifies, decrypts and parses a payment notification', () => {
    const request = wechatNotify(keys, clock, tx)
    expect(channel.verifyNotify(request, clock)).toEqual({
      ok: true,
      trade: {
        state: 'paid',
        outTradeNo: tx.outTradeNo,
        amountCents: 9900,
        currency: 'CNY',
        providerTxnId: '4200000001202610160000000001',
        merchantMatches: true,
      },
    })
  })

  test('header names are case-insensitive', () => {
    const request = wechatNotify(keys, clock, tx)
    const lower = Object.fromEntries(
      Object.entries(request.headers).map(([k, v]) => [k.toLowerCase(), v]),
    )
    expect(
      channel.verifyNotify({ ...request, headers: new Headers(lower) }, clock)
        .ok,
    ).toBe(true)
  })

  test('rejects stale and future timestamps (5 minutes)', () => {
    const stale = wechatNotify(keys, clock - 5 * 60_000, tx)
    expect(channel.verifyNotify(stale, clock)).toEqual({
      ok: false,
      reason: '时间戳超出 5 分钟',
    })
    const future = wechatNotify(keys, clock + 5 * 60_000, tx)
    expect(channel.verifyNotify(future, clock).ok).toBe(false)
    const fresh = wechatNotify(keys, clock - 4 * 60_000, tx)
    expect(channel.verifyNotify(fresh, clock).ok).toBe(true)
  })

  test('a replayed notification passes verification only while fresh', () => {
    const request = wechatNotify(keys, clock, tx)
    expect(channel.verifyNotify(request, clock).ok).toBe(true)
    // The same bytes ten minutes later are refused; idempotency in the
    // service covers replays inside the window.
    expect(channel.verifyNotify(request, clock + 10 * 60_000).ok).toBe(false)
  })

  test('rejects a tampered body, a probe signature and a foreign key id', () => {
    const request = wechatNotify(keys, clock, tx)
    const tampered = {
      ...request,
      rawBody: request.rawBody.replace('支付成功', '支付成功 '),
    }
    expect(channel.verifyNotify(tampered, clock)).toEqual({
      ok: false,
      reason: '签名不符',
    })
    const probe = wechatNotify(keys, clock, tx, {
      signature: `WECHATPAY/SIGNTEST/${Buffer.from('x').toString('base64')}`,
    })
    expect(channel.verifyNotify(probe, clock).ok).toBe(false)
    const foreign = wechatNotify(keys, clock, tx, { serial: 'PUB_KEY_ID_999' })
    expect(channel.verifyNotify(foreign, clock)).toEqual({
      ok: false,
      reason: '微信支付公钥 ID 不符',
    })
    const platform = wechatNotify(keys, clock, tx, {
      serial: '7C6B5A49382716051F2E3D4C5B6A79880A1B2C3D',
    })
    expect(channel.verifyNotify(platform, clock)).toEqual({
      ok: false,
      reason: '平台证书模式未实现',
    })
    const { 'Wechatpay-Signature': _, ...unsigned } = request.headers
    expect(
      channel.verifyNotify({ ...request, headers: unsigned }, clock),
    ).toEqual({ ok: false, reason: '缺少签名头' })
  })

  test('a validly signed body with a ciphertext under another key fails to decrypt', () => {
    const other = { ...keys, apiV3Key: 'x'.repeat(32) }
    const request = wechatNotify(other, clock, tx)
    expect(channel.verifyNotify(request, clock)).toEqual({
      ok: false,
      reason: '解密失败',
    })
  })

  test('merchant ids are reported, not trusted', () => {
    const request = wechatNotify(keys, clock, {
      ...tx,
      appid: 'wx0000000000000000',
    })
    const verdict = channel.verifyNotify(request, clock)
    expect(verdict.ok && verdict.trade.merchantMatches).toBe(false)
  })

  test('AEAD_AES_256_GCM round trip with associated data', () => {
    const key = createSecretKey(Buffer.from(keys.apiV3Key, 'utf8'))
    const nonce = 'abcdefghijkl'
    const cipher = createCipheriv('aes-256-gcm', key, Buffer.from(nonce))
    cipher.setAAD(Buffer.from('certificate'))
    const sealed = Buffer.concat([
      cipher.update('{"hello":"世界"}', 'utf8'),
      cipher.final(),
      cipher.getAuthTag(),
    ]).toString('base64')
    expect(channel.decryptResource(sealed, nonce, 'certificate')).toBe(
      '{"hello":"世界"}',
    )
    expect(channel.decryptResource(sealed, nonce, 'transaction')).toBeNull()
    expect(
      channel.decryptResource(sealed, 'abcdefghijkm', 'certificate'),
    ).toBeNull()
  })

  test('replies follow the documented shapes', () => {
    expect(channel.reply('ok', '')).toEqual({
      httpStatus: 204,
      body: '',
      headers: {},
    })
    const failed = channel.reply('rejected', '验签失败')
    expect(failed.httpStatus).toBe(400)
    expect(JSON.parse(failed.body)).toEqual({
      code: 'FAIL',
      message: '验签失败',
    })
    expect(channel.reply('retry', 'x').httpStatus).toBe(500)
  })
})
