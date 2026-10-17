// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterAll, describe, expect, test } from 'bun:test'
import { createCipheriv, createPrivateKey, createSecretKey } from 'node:crypto'
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

/**
 * The signing example in the official docs, with its published test key
 * (https://pay.weixin.qq.com/doc/v3/merchant/4012365336 — "示例密钥本身是不可用的").
 */
const DOC_TEST_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQCm2mb6q8gMKH/3
CNTbpJAIrbqiBiQGEOtjGcBrDYltsGynWgNscqT7WvfzU14FQbYcQUC5T4Wvva7m
i3fIp3OgX8VqMDNA0qebnr38Pe6kqiLyZgFpJPXlSKDyPyqhRbVTbXssvSMQeVKc
dXeVxoNNeoOlNFHgF/P0io6AmAVnz+hN8SiZKuOsth5/zUTLGvtkgxBcQooQrtXh
RcpLT798OyIb9xeJ2HO3xRtMv2+perEzb4gMibI74UBz+2QEbnkubPE+2jU2rRZu
dnNEz/BPOt3Qj/w2V6/G0VumGDh6+UeMU0jv4aupHztWITC4Akn0l7lBCNy3lgl8
VFaJnkIxAgMBAAECggEAYGL8aESB7NwciDWW2UdoWUsa7GxFtSdjAz2mFXGdeTsY
mVh7b9OOkRGM+Qio4LqEHDBp1mMk5E/cUJwy1zw8pGGO5nfvs7u9TT3XnHaefIs4
YvUgTYAneIuLRkXNN5rQU+CD7mVYczTSz0Vgjqo9wa1LjUz7G0xbBmJgTdMEFGJs
eJjy6AbJo0CGIwp6HJbTm4CmOUgXnnDAIbEGTIRImkZFH/rzneIeR7oZ77FVwxr1
CZB2gfRCov/yRPbw8vnryYkmvQ7D/ze3j5097vRg/MoDGBSdoOwcmo75vyofr0AS
zytMjmHYyifqkf5slPropSiJeGf4p/7gtKyF6dE/XQKBgQDVAlJ+4U5ZVGOuDc3+
sAhz8CTzgFNlq9vKuSoFK6hOz2L+cwj+E7NXGkOe2DsHHZNy2Xqxk7caKhPEp1z9
hhpMpyLVMoFt6CKemyoRBWDCQwLLwem9SZF/IAyovBkLiH36P42Jm26gUkNMKC/5
Zhtqxf6RZgRQzbVudJi47vIRCwKBgQDIh0+v27Oo+DM3fhObH4I1NrXpWOEGH7OQ
G1dEsMuFYF4hjGhg0kBEP3w9vVdl2+mRllZKTsx9oqjb8OibPLLIH8xsdbAB0WLf
JvjLu4wl/ILUzN1RI03dWnnv2EnEeQn6c3hizvrJ9wR5U4ue9RPVnQooJ0hZF1PU
uCL5fWK3MwKBgElReU/PAYbh80WP3t3Rfbdaa32dKBeQ5iCLR5lsA4zM+YgX1HqQ
EWTj126vgvHaDkyz6vWAoL/Sx+cirHFfXWIRDX5Q2hgYlQH+6qXdMgbrxeSYpHnQ
/tHBGFpkFELSAnrGsVMyOwvYBO4LzyeLK9i+ufcWJFoj1FVmsMLHDG8tAoGARdbi
iQQCoYG4DMarO2aQ6cmhN6EN1h0qY7EyBqlwaIZ0okiNfdMcMOjPc41DKCWcRmlO
qlihXcxN9TQFPzO3rH1urAOdBjUPs1qWYhZyrDQyuLyVBBJApyxAtajloDjrob+f
mQIvVDHk7ACN6xG+E7K6+9salnTKbJapD618uQMCgYBNy6XUvzLkP/A1U/UZdtcx
l8GwU/dturLxz4CyGbqDw4ubaYY2e13lnqHUqQgPtiSyH51nq3tdo8G0YAJdfkSv
KvnfslW91fyEBUKnkdW1o3/1UFU/wprZ7ixVL/F42A4xDu7OFE8EnweJOZ0jWceE
OdhCkaIGBCfRnlECRK8UyQ==
-----END PRIVATE KEY-----`

describe('request signing', () => {
  test('reproduces the official documentation example byte for byte', () => {
    const docChannel = new WechatPayChannel({
      config: {
        ...config,
        mchid: '1900007291',
        merchantSerialNo: '408B07E79B8269FEC3D5D3E6AB8ED163A6A380DB',
        merchantPrivateKey: createPrivateKey(DOC_TEST_KEY),
      },
      now: () => 1554208460 * 1000,
      nonce: () => '593BEC0C930BF1AFEB40B4A08C8FB242',
    })
    const body =
      '{"appid":"wxd678efh567hg6787","mchid":"1900007291","description":"Image形象店-深圳腾大-QQ公仔","out_trade_no":"1217752501201407033233368018","notify_url":"https://www.weixin.qq.com/wxpay/pay.php","amount":{"total":100,"currency":"CNY"},"payer":{"openid":"oUpF8uMuAJO_M2pxb1Q9zNjWeS6o"}}'
    expect(
      docChannel.authorization('POST', '/v3/pay/transactions/jsapi', body),
    ).toBe(
      'WECHATPAY2-SHA256-RSA2048 mchid="1900007291",nonce_str="593BEC0C930BF1AFEB40B4A08C8FB242",signature="jnks4dlrPw3ZX+ozVvSK39oa0t7OMBsg83BHAwd8BRdUFiVaQNTLTvci+wURgP1OQBbKYhFGvt7iqYpDSTQkp7Uq1sltaQKyncCyrA1g88m5bsKERQfPyT0ahSwKTYJ1CAn9QiJuSJRq1QsQs07eehbU/k9BCS51jTyc1Jpsi2H77HF9f/BnjXAOP3/sPObg6V5Ee4EzwLox684hhuMuIwHo7D8KFk3LIHOKDcNI4It1aCXydFWNpNK+SG86VUDe5kwoDpw4Ulqfu9z8OFDGbDs9TCxEv8iqQzbpxOlEVoOe2kalSYM5kApQb3nZcxdUtoE0liJGW3RGUNE0t4v01A==",timestamp="1554208460",serial_no="408B07E79B8269FEC3D5D3E6AB8ED163A6A380DB"',
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
      serial: '5157F09EFDC096DE15EBE81A47057A7232F1B8E1',
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
