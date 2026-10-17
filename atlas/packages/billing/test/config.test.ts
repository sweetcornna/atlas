// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from 'bun:test'
import { chmodSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { inspect } from 'node:util'
import { qianmoConfigDir } from '@qianmo/paths'
import {
  BillingConfigError,
  billingConfigPath,
  billingStorePath,
  parseBillingConfig,
  readSecretFile,
} from '../src/index.js'
import { configJson, makeKeys, tempDir, writeSecrets } from './fixtures.js'

const keys = makeKeys()

function setup(mode = 0o600) {
  const dir = tempDir()
  const files = writeSecrets(dir, keys, mode)
  return { dir, files, json: configJson(files) }
}

function rejects(json: unknown, pattern: RegExp): void {
  let caught: unknown
  try {
    parseBillingConfig(json)
  } catch (error) {
    caught = error
  }
  expect(caught).toBeInstanceOf(BillingConfigError)
  expect(String(caught)).toMatch(pattern)
}

describe('parseBillingConfig', () => {
  test('accepts the documented shape and loads keys as KeyObjects', () => {
    const { json } = setup()
    const config = parseBillingConfig(JSON.stringify(json))
    expect(config.plans.map(plan => plan.id)).toEqual(['month', 'pro'])
    expect(config.plans[0]!.note).toBe('一个托管节点')
    expect(config.plans[1]!.note).toBeNull()
    expect(config.plans.map(plan => plan.nodes)).toEqual([1, 3])
    expect(config.plans[1]!.gatewayLimits).toEqual([
      { period: 'days', days: 7, tokens: 50_000_000, cacheReads: true },
      { period: 'hours', hours: 5, costUsd: 10 },
    ])
    expect(config.channels.wechatpay?.endpoint).toBe(
      'https://api.mch.weixin.qq.com',
    )
    expect(config.channels.alipay?.endpoint).toBe(
      'https://openapi.alipay.com/gateway.do',
    )
    expect(config.channels.wechatpay?.merchantPrivateKey.type).toBe('private')
    expect(config.channels.wechatpay?.apiV3Key.type).toBe('secret')
    expect(config.channels.alipay?.appPrivateKey.type).toBe('private')
    expect(config.channels.alipay?.alipayPublicKey.type).toBe('public')
    expect(config.orderTtlMinutes).toBe(15)
    expect(config.termsUrl).toBeNull()
  })

  test('never exposes secret material when serialised or inspected', () => {
    const { json, files } = setup()
    const config = parseBillingConfig(json)
    const dumped = `${JSON.stringify(config)}\n${inspect(config, { depth: 10 })}`
    expect(dumped).not.toContain(keys.apiV3Key)
    expect(dumped).not.toContain('PRIVATE KEY')
    const pemBody = keys.merchant.privatePem.split('\n')[1]!
    expect(dumped).not.toContain(pemBody)
    expect(dumped).not.toContain(files.merchantPrivateKeyFile)
  })

  test('rejects unknown keys at every level', () => {
    const { json } = setup()
    rejects({ ...json, extra: 1 }, /\$\.extra：未知字段/)
    const plans = structuredClone(json['plans']) as Record<string, unknown>[]
    plans[0]!['priceCent'] = 1
    rejects({ ...json, plans }, /plans\[0\]\.priceCent：未知字段/)
    const channels = structuredClone(json['channels']) as Record<
      string,
      Record<string, unknown>
    >
    channels['wechatpay']!['mchId'] = 'x'
    rejects({ ...json, channels }, /wechatpay\.mchId：未知字段/)
    const limits = structuredClone(json['plans']) as {
      gatewayLimits: Record<string, unknown>[]
    }[]
    limits[0]!.gatewayLimits[0]!['tokenz'] = 5
    rejects({ ...json, plans: limits }, /gatewayLimits\[0\]\.tokenz：未知字段/)
    // A plan sells nodes, never models: the old model allowance is refused.
    const old = structuredClone(json['plans']) as Record<string, unknown>[]
    old[0]!['gateway'] = { limits: [], models: ['openai/*'] }
    rejects({ ...json, plans: old }, /plans\[0\]\.gateway：未知字段/)
  })

  test('requires sourceUrl (AGPL §13) over https', () => {
    const { json } = setup()
    const { sourceUrl: _, ...rest } = json
    rejects(rest, /sourceUrl：必填/)
    rejects({ ...json, sourceUrl: 'http://example.com/src' }, /https/)
  })

  test('validates plans, node counts and fair-use limits', () => {
    const { json } = setup()
    const base = json['plans'] as Record<string, unknown>[]
    const withPlan = (patch: Record<string, unknown>) => ({
      ...json,
      plans: [{ ...base[0], ...patch }],
    })
    rejects(withPlan({ priceCents: 0 }), /priceCents/)
    rejects(withPlan({ priceCents: 99.5 }), /priceCents/)
    rejects(withPlan({ periodDays: 0 }), /periodDays/)
    rejects(withPlan({ id: 'Bad Id' }), /\.id：格式不对/)
    const { nodes: _nodes, ...noNodes } = base[0]!
    rejects({ ...json, plans: [noNodes] }, /nodes：必须是 1–100/)
    rejects(withPlan({ nodes: 0 }), /nodes：必须是 1–100/)
    rejects(withPlan({ nodes: 101 }), /nodes：必须是 1–100/)
    rejects(withPlan({ nodes: 1.5 }), /nodes/)
    rejects(
      withPlan({ gatewayLimits: [{ period: 'days', tokens: 5 }] }),
      /days：必须是/,
    )
    rejects(
      withPlan({ gatewayLimits: [{ period: 'day', hours: 3, tokens: 5 }] }),
      /hours：只有 period 为 hours/,
    )
    rejects(
      withPlan({ gatewayLimits: [{ period: 'day' }] }),
      /tokens、costUsd 至少填一个/,
    )
    rejects(
      withPlan({
        gatewayLimits: [{ period: 'day', costUsd: 1, cacheReads: 5 }],
      }),
      /cacheReads：必须是布尔值/,
    )
    rejects(
      withPlan({
        gatewayLimits: [{ period: 'day', costUsd: 1, cacheReads: true }],
      }),
      /cacheReads：只有填了 tokens/,
    )
    rejects(
      withPlan({
        gatewayLimits: Array.from({ length: 6 }, () => ({
          period: 'day',
          tokens: 1,
        })),
      }),
      /不超过 5 项/,
    )
    rejects({ ...json, plans: [base[0], base[0]] }, /\.id：重复/)
    const { gatewayLimits: _limits, ...noLimits } = base[0]!
    const parsed = parseBillingConfig({ ...json, plans: [noLimits] })
    expect(parsed.plans[0]!.gatewayLimits).toEqual([])
    expect(parsed.plans[0]!.nodes).toBe(1)
    expect(
      parseBillingConfig(
        withPlan({
          gatewayLimits: [{ period: 'week', tokens: 9, cacheReads: false }],
        }),
      ).plans[0]!.gatewayLimits,
    ).toEqual([{ period: 'week', tokens: 9 }])
  })

  test('applies the notify_url rules and the endpoint rules', () => {
    const { json } = setup()
    const channels = json['channels'] as Record<string, Record<string, unknown>>
    const withWechat = (patch: Record<string, unknown>) => ({
      ...json,
      channels: {
        ...channels,
        wechatpay: { ...channels['wechatpay'], ...patch },
      },
    })
    rejects(withWechat({ notifyUrl: 'http://hub.example.com/n' }), /https/)
    rejects(
      withWechat({ notifyUrl: 'https://hub.example.com/n?x=1' }),
      /查询参数/,
    )
    rejects(withWechat({ notifyUrl: 'https://127.0.0.1/n' }), /不能是 IP/)
    rejects(withWechat({ notifyUrl: 'https://hub.example.com/' }), /具体路径/)
    rejects(withWechat({ endpoint: 'http://api.example.com' }), /https/)
    rejects(withWechat({ endpoint: 'https://api.example.com/v3' }), /源地址/)
    rejects(withWechat({ wechatpayPublicKeyId: 'ABC' }), /格式不对/)
    expect(
      parseBillingConfig(withWechat({ endpoint: 'http://127.0.0.1:9' }))
        .channels.wechatpay?.endpoint,
    ).toBe('http://127.0.0.1:9')
  })

  test('requires at least one channel; redeem alone is enough', () => {
    const { json } = setup()
    rejects({ ...json, channels: {} }, /至少启用一个渠道/)
    const config = parseBillingConfig({
      ...json,
      channels: { redeem: { enabled: true } },
    })
    expect(config.channels.wechatpay).toBeNull()
    expect(config.channels.redeem.enabled).toBe(true)
  })

  test('rejects a wrong-length APIv3 key without echoing it', () => {
    const { dir, json } = setup()
    const secret = 'too-short-but-secret-VALUE'
    writeFileSync(join(dir, 'apiv3.key'), secret, { mode: 0o600 })
    let message = ''
    try {
      parseBillingConfig(json)
    } catch (error) {
      message = String(error)
    }
    expect(message).toMatch(/apiV3KeyFile.*32 字节/)
    expect(message).not.toContain(secret)
  })

  test('readSecret is injectable', () => {
    const { json } = setup()
    const seen: string[] = []
    const config = parseBillingConfig(json, {
      readSecret: path => {
        seen.push(path)
        return readSecretFile(path)
      },
    })
    expect(seen).toHaveLength(5)
    expect(config.channels.alipay?.appId).toBe('2021000122671080')
  })
})

describe('secret files', () => {
  test('a world-readable key file is refused and its content never echoed', () => {
    const { json, files } = setup(0o644)
    let message = ''
    try {
      parseBillingConfig(json)
    } catch (error) {
      message = String(error)
    }
    expect(message).toContain('权限过宽')
    expect(message).toContain(files.merchantPrivateKeyFile)
    expect(message).not.toContain('PRIVATE KEY')
  })

  test('group-readable is refused too; 0400 is accepted', () => {
    const { files } = setup()
    chmodSync(files.apiV3KeyFile, 0o640)
    expect(() => readSecretFile(files.apiV3KeyFile)).toThrow(/权限过宽/)
    chmodSync(files.apiV3KeyFile, 0o400)
    expect(readSecretFile(files.apiV3KeyFile)).toBe(`${keys.apiV3Key}\n`)
  })

  test('relative paths, symlinks and missing files are refused', () => {
    const { dir, files } = setup()
    expect(() => readSecretFile('relative/key.pem')).toThrow(/绝对路径/)
    const link = join(dir, 'link.pem')
    symlinkSync(files.merchantPrivateKeyFile, link)
    expect(() => readSecretFile(link)).toThrow(/无法打开/)
    expect(() => readSecretFile(join(dir, 'missing.pem'))).toThrow(/ENOENT/)
  })

  test('a garbage key file names the field, not the content', () => {
    const { dir, json } = setup()
    writeFileSync(join(dir, 'pub_key.pem'), 'not-a-key-SECRETISH', {
      mode: 0o600,
    })
    rejects(json, /wechatpayPublicKeyFile.*RSA 公钥/)
    try {
      parseBillingConfig(json)
    } catch (error) {
      expect(String(error)).not.toContain('SECRETISH')
    }
  })
})

test('default paths derive from the config root', () => {
  expect(billingConfigPath()).toBe(
    join(qianmoConfigDir(), 'qianmo', 'console', 'billing.json'),
  )
  expect(billingStorePath()).toBe(
    join(qianmoConfigDir(), 'qianmo', 'console', 'billing.sqlite'),
  )
})
