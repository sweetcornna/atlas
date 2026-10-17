// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterAll, describe, expect, test } from 'bun:test'
import { sign as rsaSign } from 'node:crypto'
import {
  AlipayChannel,
  alipaySignContent,
  centsToYuan,
  rawJsonMembers,
  yuanToCents,
} from '../src/channels/alipay.js'
import { ChannelError, parseBillingConfig } from '../src/index.js'
import {
  ALIPAY_APP_ID,
  alipayNotify,
  alipayResponse,
  configJson,
  makeKeys,
  startAlipayFake,
  tempDir,
  writeSecrets,
} from './fixtures.js'

const keys = makeKeys()
const clock = Date.UTC(2026, 9, 16, 4, 0, 0)
const fake = startAlipayFake(keys)
afterAll(() => fake.stop())
const config = parseBillingConfig(
  configJson(writeSecrets(tempDir(), keys), { alipay: fake.endpoint }),
).channels.alipay!
const channel = new AlipayChannel({ config, now: () => clock })

describe('signing', () => {
  test('sign content: sorted, raw values, empty values and sign dropped', () => {
    expect(
      alipaySignContent({
        timestamp: '2026-10-16 12:00:00',
        app_id: '2021',
        sign: 'zzz',
        biz_content: '{"a":"b&c"}',
        empty: '',
        charset: 'utf-8',
      }),
    ).toBe(
      'app_id=2021&biz_content={"a":"b&c"}&charset=utf-8&timestamp=2026-10-16 12:00:00',
    )
  })

  test('common params carry the Asia/Shanghai timestamp and an RSA2 signature', () => {
    const params = channel.signedParams('alipay.trade.query', {
      out_trade_no: 'x',
    })
    expect(params).toMatchObject({
      app_id: ALIPAY_APP_ID,
      method: 'alipay.trade.query',
      format: 'JSON',
      charset: 'utf-8',
      sign_type: 'RSA2',
      timestamp: '2026-10-16 12:00:00',
      version: '1.0',
      biz_content: '{"out_trade_no":"x"}',
    })
    const expected = rsaSign(
      'RSA-SHA256',
      Buffer.from(alipaySignContent(params), 'utf8'),
      keys.app.privateKey,
    ).toString('base64')
    expect(params['sign']).toBe(expected)
  })

  test('yuan conversion is exact', () => {
    expect(centsToYuan(9900)).toBe('99.00')
    expect(centsToYuan(1)).toBe('0.01')
    expect(centsToYuan(100_000_000)).toBe('1000000.00')
    expect(yuanToCents('99.00')).toBe(9900)
    expect(yuanToCents('99.9')).toBe(9990)
    expect(yuanToCents('99')).toBe(9900)
    expect(yuanToCents('0.01')).toBe(1)
    for (const bad of ['', '-1', '1.001', '01.00', '1e3', ' 1', '1,00'])
      expect(yuanToCents(bad)).toBeNull()
  })
})

describe('response verification', () => {
  const method = 'alipay.trade.precreate'

  test('raw member extraction keeps the bytes exactly as received', () => {
    const text =
      '{ "alipay_trade_precreate_response" : {"code":"10000","qr_code":"https:\\/\\/qr.alipay.com\\/x","note":"a \\"}\\" b"} , "sign":"abc" }'
    const members = rawJsonMembers(text)
    expect(members.get('alipay_trade_precreate_response')).toBe(
      '{"code":"10000","qr_code":"https:\\/\\/qr.alipay.com\\/x","note":"a \\"}\\" b"}',
    )
    expect(members.get('sign')).toBe('"abc"')
    expect(() => rawJsonMembers('{"a":1,"a":2}')).toThrow()
    expect(() => rawJsonMembers('{"a":1} trailing')).toThrow()
    expect(() => rawJsonMembers('[1]')).toThrow()
  })

  test('verifies the signature over the raw node, not a re-serialisation', () => {
    const node =
      '{ "code" : "10000", "msg":"Success","out_trade_no":"x","qr_code":"https:\\/\\/qr.alipay.com\\/bax1"}'
    // Re-serialising would drop the spaces and unescape the slashes.
    expect(JSON.stringify(JSON.parse(node))).not.toBe(node)
    const parsed = channel.verifyResponse(
      alipayResponse(keys, method, node),
      method,
      't',
    )
    expect(parsed['qr_code']).toBe('https://qr.alipay.com/bax1')
  })

  test('refuses forged, unsigned, swapped and malformed responses', () => {
    const node = '{"code":"10000","msg":"Success"}'
    const attempt = (text: string) => {
      try {
        channel.verifyResponse(text, method, 't')
        return 'accepted'
      } catch (error) {
        return (error as ChannelError).code
      }
    }
    expect(attempt(alipayResponse(keys, method, node, { forge: true }))).toBe(
      'bad_signature',
    )
    expect(
      attempt(alipayResponse(keys, method, node, { omitSign: true })),
    ).toBe('unsigned')
    // A signature for another node does not carry over.
    const signedOther = alipayResponse(keys, method, '{"code":"40004"}')
    const sign = rawJsonMembers(signedOther).get('sign')
    expect(
      attempt(`{"alipay_trade_precreate_response":${node},"sign":${sign}}`),
    ).toBe('bad_signature')
    expect(attempt('<html>')).toBe('bad_response')
    expect(attempt('{"sign":"x"}')).toBe('bad_response')
  })
})

describe('against the local fake', () => {
  test('precreate → query (not scanned) → scan → pay → query → close', async () => {
    const no = 'G'.repeat(32)
    const { qrText } = await channel.createQr({
      outTradeNo: no,
      amountCents: 9900,
      title: '月度/专业=a&b',
      expiresAt: clock + 15 * 60_000,
    })
    expect(qrText).toBe(`https://qr.alipay.com/bax0${no.slice(0, 6)}`)
    expect(fake.requests.at(-1)).toEqual({
      method: 'alipay.trade.precreate',
      biz: {
        out_trade_no: no,
        total_amount: '99.00',
        subject: '月度 专业 a b',
        timeout_express: '15m',
      },
    })
    expect((await channel.query(no)).state).toBe('absent')
    fake.scan(no)
    expect((await channel.query(no)).state).toBe('pending')
    fake.scan(no, 'TRADE_SUCCESS')
    expect(await channel.query(no)).toEqual({
      state: 'paid',
      outTradeNo: no,
      amountCents: 9900,
      currency: 'CNY',
      providerTxnId: '2026101622001400000000000009',
      merchantMatches: true,
    })
    fake.scan(no, 'WAIT_BUYER_PAY')
    await channel.close(no)
    expect(fake.trades.get(no)?.status).toBe('TRADE_CLOSED')
    expect((await channel.query(no)).state).toBe('closed')
  })

  test('closing a never-scanned QR succeeds', async () => {
    const no = 'H'.repeat(32)
    await channel.createQr({
      outTradeNo: no,
      amountCents: 100,
      title: 't',
      expiresAt: clock + 15 * 60_000,
    })
    await expect(channel.close(no)).resolves.toBeUndefined()
  })

  test('a request signed with the wrong key is refused by the gateway', async () => {
    const wrong = new AlipayChannel({
      config: { ...config, appPrivateKey: keys.merchant.privateKey },
      now: () => clock,
    })
    const error = await wrong.query('I'.repeat(32)).catch(e => e)
    expect(error).toBeInstanceOf(ChannelError)
    expect(error.code).toBe('alipay:isv.invalid-signature')
  })

  test('forged or unsigned gateway answers are refused', async () => {
    fake.control.forge = true
    try {
      const error = await channel.query('J'.repeat(32)).catch(e => e)
      expect(error.code).toBe('bad_signature')
    } finally {
      fake.control.forge = false
    }
    fake.control.omitSign = true
    try {
      const error = await channel.query('J'.repeat(32)).catch(e => e)
      expect(error.code).toBe('unsigned')
    } finally {
      fake.control.omitSign = false
    }
  })
})

describe('notifications', () => {
  test('verifies a form-encoded notification', () => {
    const request = alipayNotify(keys, {
      outTradeNo: 'K'.repeat(32),
      totalAmount: '99.00',
    })
    expect(channel.verifyNotify({ headers: {}, ...request }, clock)).toEqual({
      ok: true,
      trade: {
        state: 'paid',
        outTradeNo: 'K'.repeat(32),
        amountCents: 9900,
        currency: 'CNY',
        providerTxnId: '2026101622001400000000000001',
        merchantMatches: true,
      },
    })
    const finished = alipayNotify(keys, {
      outTradeNo: 'K'.repeat(32),
      totalAmount: '99.00',
      tradeStatus: 'TRADE_FINISHED',
    })
    const verdict = channel.verifyNotify({ headers: {}, ...finished }, clock)
    expect(verdict.ok && verdict.trade.state).toBe('paid')
  })

  test('refuses tampered, unsigned, duplicated and mistyped notifications', () => {
    const request = alipayNotify(keys, {
      outTradeNo: 'K'.repeat(32),
      totalAmount: '99.00',
    })
    const tampered = request.rawBody.replace(
      'total_amount=99.00',
      'total_amount=0.01',
    )
    expect(
      channel.verifyNotify(
        { headers: {}, ...request, rawBody: tampered },
        clock,
      ),
    ).toEqual({ ok: false, reason: '签名不符' })
    const params = new URLSearchParams(request.rawBody)
    params.delete('sign')
    expect(
      channel.verifyNotify(
        { headers: {}, ...request, rawBody: params.toString() },
        clock,
      ).ok,
    ).toBe(false)
    expect(
      channel.verifyNotify(
        {
          headers: {},
          ...request,
          rawBody: `${request.rawBody}&out_trade_no=other`,
        },
        clock,
      ),
    ).toEqual({ ok: false, reason: '参数重复' })
    expect(
      channel.verifyNotify(
        { headers: {}, ...request, contentType: 'application/json' },
        clock,
      ),
    ).toEqual({ ok: false, reason: '通知类型不对' })
  })

  test('a foreign app_id is reported for the service to reject', () => {
    const request = alipayNotify(keys, {
      outTradeNo: 'K'.repeat(32),
      totalAmount: '99.00',
      appId: '2021999999999999',
    })
    const verdict = channel.verifyNotify({ headers: {}, ...request }, clock)
    expect(verdict.ok && verdict.trade.merchantMatches).toBe(false)
  })

  test('a foreign or missing seller_id is reported for the service to reject', () => {
    for (const sellerId of ['2088999999999999', null]) {
      const request = alipayNotify(keys, {
        outTradeNo: 'K'.repeat(32),
        totalAmount: '99.00',
        sellerId,
      })
      const verdict = channel.verifyNotify({ headers: {}, ...request }, clock)
      expect(`${sellerId} ${verdict.ok && verdict.trade.merchantMatches}`).toBe(
        `${sellerId} false`,
      )
    }
  })

  test('replies are the literal success / fail bodies', () => {
    expect(channel.reply('ok', '').body).toBe('success')
    expect(channel.reply('rejected', 'x').body).toBe('fail')
    expect(channel.reply('retry', 'x').httpStatus).toBe(500)
  })
})
