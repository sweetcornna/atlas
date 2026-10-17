// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The public edition (P35) on the hub, end to end with nothing of ours
 * mocked: `@qianmo/billing` on an in-memory ledger with a fake payment
 * channel (signature over the raw body), the fake magpie of
 * `@qianmo/magpie/testing` on loopback, the real model service with fake
 * node processes, a real tenancy file.
 *
 * What it pins:
 *
 * - a payment makes the tenant, a subscriber key that is off and held to
 *   nothing, and the tenant's profile; once ops give the tenant a node it
 *   gets that profile, never more nodes than the plan;
 * - the key is on only with an upstream of the subscriber's own, and every
 *   model list ever written for it is non-empty and the tenant's alone
 *   (magpie reads an empty list as every model);
 * - expiry turns the key off; the platform never sees a subscriber's
 *   upstream; the model service takes only the magpie preset;
 * - the edition's startup rules and the deployment templates.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createHmac, generateKeyPairSync } from 'node:crypto'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  BillingStore,
  billingConfigPath,
  type NotifyReply,
  type NotifyRequest,
  type PaymentChannel,
  parseBillingConfig,
  type TradeStatus,
} from '@qianmo/billing'
import type {
  MagpieCaller,
  ProviderCaller,
  TenantConfig,
} from '@qianmo/console'
import { NO_MODEL_PATTERN } from '@qianmo/magpie'
import { FakeMagpie } from '@qianmo/magpie/testing'
import {
  consoleBillingPath,
  parseConsoleArgs,
} from '../../src/commands/consoleArgs.js'
import {
  ConsoleBilling,
  loadBillingConfig,
} from '../../src/commands/consoleBilling.js'
import {
  ConsoleMagpie,
  magpieProfileId,
  NO_MODEL_PROFILE,
} from '../../src/commands/consoleMagpie.js'
import {
  type ConsoleProviders,
  openConsoleProviders,
  type ProviderScheduler,
} from '../../src/commands/consoleProviders.js'
import { publicProviders } from '../../src/commands/consolePublicProviders.js'
import {
  ConsoleRouting,
  routingWire,
} from '../../src/commands/consoleRouting.js'
import { FileTenantStore } from '../../src/commands/consoleTenancy.js'
import { type FakeNode, fakeNode } from './consoleProvidersFakeNode.js'

const OPS = 'u:0123456789abcdef'
const ALICE = 'u:a11ce00000000001'
const BOB = 'u:b0b0000000000002'
const WEB_KEY = 'magpie-web-key-for-tests-0001'
const SIGNING = 'fake-channel-signing-key'
const STILL: ProviderScheduler = { set: () => null, clear: () => {} }
const DAY = 86_400_000
const REPO = join(import.meta.dir, '..', '..', '..', '..', '..')

/** A WeChat-shaped channel whose notifications are HMAC-signed over the raw body. */
class FakeChannel implements PaymentChannel {
  readonly id = 'wechatpay' as const
  readonly trades = new Map<string, TradeStatus>()

  async createQr(request: {
    outTradeNo: string
    amountCents: number
  }): Promise<{ qrText: string }> {
    this.trades.set(request.outTradeNo, {
      state: 'pending',
      outTradeNo: request.outTradeNo,
      amountCents: request.amountCents,
      currency: 'CNY',
      providerTxnId: null,
      merchantMatches: true,
    })
    return { qrText: `weixin://wxpay/bizpayurl?pr=${request.outTradeNo}` }
  }

  verifyNotify(request: NotifyRequest) {
    const headers = request.headers as Headers
    const signature = createHmac('sha256', SIGNING)
      .update(request.rawBody)
      .digest('hex')
    if (headers.get('x-fake-signature') !== signature)
      return { ok: false as const, reason: 'signature' }
    const body = JSON.parse(request.rawBody) as {
      outTradeNo: string
      amountCents: number
    }
    return {
      ok: true as const,
      trade: {
        state: 'paid' as const,
        outTradeNo: body.outTradeNo,
        amountCents: body.amountCents,
        currency: 'CNY',
        providerTxnId: `txn-${body.outTradeNo.slice(0, 8)}`,
        merchantMatches: true,
      },
    }
  }

  async query(outTradeNo: string): Promise<TradeStatus> {
    return (
      this.trades.get(outTradeNo) ?? {
        state: 'absent',
        outTradeNo,
        amountCents: null,
        currency: null,
        providerTxnId: null,
        merchantMatches: true,
      }
    )
  }

  async close(): Promise<void> {}

  reply(outcome: 'ok' | 'rejected' | 'retry'): NotifyReply {
    return outcome === 'ok'
      ? { httpStatus: 204, body: '', headers: {} }
      : {
          httpStatus: outcome === 'retry' ? 500 : 400,
          body: '{"code":"FAIL"}',
          headers: { 'content-type': 'application/json' },
        }
  }
}

let root: string
let clock: number
let fake: FakeMagpie
let nodes: FakeNode[]
let raw: ConsoleProviders
let tenancy: FileTenantStore
let channel: FakeChannel
let store: BillingStore
let magpie: ConsoleMagpie
let billing: ConsoleBilling
let ledger: string[]
let errors: string[]
let providers: ReturnType<typeof publicProviders>
let system: ProviderCaller

function ops(): MagpieCaller & ProviderCaller {
  return {
    subject: OPS,
    role: 'ops',
    requestId: 'req-1',
    breakGlass: false,
    async record(action: string, target: string, outcome: string) {
      ledger.push(`ops ${action} ${target} ${outcome}`)
      return true
    },
  }
}

function config(): TenantConfig {
  return tenancy.read().config
}

/** Ops give `tenant` the named nodes (the tenancy file, as they edit it). */
function mapNodes(tenant: string, names: readonly string[]): void {
  const current = config()
  tenancy.replace({
    ...current,
    nodes: [
      ...current.nodes,
      ...names.map(nodeId => ({
        nodeId,
        tenant,
        server: `s-${nodeId}`,
        memoryRoot: join(root, 'memory', nodeId),
      })),
    ],
  })
}

/** Checkout, then the platform's signed notification: the plan is paid. */
async function pay(subject: string, plan = 'month'): Promise<string> {
  const created = await billing.checkout(subject, plan, 'wechatpay')
  if (!created.ok) throw new Error(created.failure.message)
  const order = store.order(created.value.orderId)
  if (order === null) throw new Error('order')
  const rawBody = JSON.stringify({
    outTradeNo: order.outTradeNo,
    amountCents: order.amountCents,
  })
  const reply = await billing.notify('wechatpay', {
    headers: new Headers({
      'x-fake-signature': createHmac('sha256', SIGNING)
        .update(rawBody)
        .digest('hex'),
    }),
    rawBody,
  })
  expect(reply.httpStatus).toBe(204)
  await billing.tick()
  const tenant = config().subjects.find(row => row.subject === subject)?.tenant
  if (tenant === undefined) throw new Error('no tenant made')
  return tenant
}

function tenantKey(tenant: string) {
  const key = fake
    .keys()
    .find(one => one.name.startsWith(`qm-tenant-${tenant}-`))
  if (key === undefined) throw new Error(`no key for ${tenant}`)
  return key
}

/** Every model list magpie was told for one key, in order. */
function listsWritten(keyId: string): readonly (readonly string[])[] {
  return fake.requests
    .filter(
      request =>
        request.path === '/api/caller-keys/models-key' &&
        (request.body as { key?: unknown } | null)?.key === keyId,
    )
    .map(request => (request.body as { models: string[] }).models)
}

/** The key actions (add, models, on, off, …) magpie heard for one key. */
function actionsOn(keyId: string, keyName: string): readonly string[] {
  return fake.requests.flatMap(request => {
    const action = /^\/api\/caller-keys\/([a-z-]+)$/.exec(request.path)?.[1]
    const body = request.body as { key?: unknown; name?: unknown } | null
    if (action === undefined) return []
    if (body?.key === keyId || body?.name === keyName) return [action]
    return []
  })
}

/** The key and main model last delivered to node `index`, or null. */
function delivered(index: number): { key: unknown; main: unknown } | null {
  const last = nodes[index]
    ?.requests()
    .filter(request => request['op'] === 'apply' && request['dryRun'] !== true)
    .at(-1)
  if (last === undefined) return null
  const profile = last['profile'] as {
    auth: { keys: { value?: string }[] }
    models: { id: string; role: string }[]
  }
  return {
    key: profile.auth.keys[0]?.value,
    main: profile.models.find(model => model.role === 'main')?.id,
  }
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'qianmo-billing-port-'))
  clock = Date.UTC(2026, 9, 16, 8, 0, 0)
  ledger = []
  errors = []
  fake = await FakeMagpie.start({
    webKey: WEB_KEY,
    providers: [
      {
        id: 'openai',
        models: ['gpt-6', 'gpt-6-mini'],
        key: 'sk-platform-0001',
      },
    ],
  })
  nodes = ['beta-1', 'beta-2', 'beta-3'].map(name => fakeNode(join(root, name)))
  raw = openConsoleProviders({
    storePath: join(root, 'config', 'providers.ndjson'),
    secretsPath: join(root, 'config', 'provider-secrets.json'),
    keyPath: join(root, 'keys', 'provider-master.key'),
    knownHostsFile: join(root, 'known_hosts'),
    nodes: nodes.map((node, index) => ({
      node: `beta-${index + 1}`,
      kind: 'local' as const,
      command: node.command,
    })),
    scheduler: STILL,
  })
  mkdirSync(join(root, 'config'), { recursive: true })
  const tenancyPath = join(root, 'config', 'tenancy.json')
  writeFileSync(
    tenancyPath,
    JSON.stringify({
      version: 1,
      hubServer: 'hub',
      tenants: [],
      subjects: [],
      nodes: [],
      jobs: [],
      platformSubjects: [OPS],
    }),
    { mode: 0o600 },
  )
  tenancy = new FileTenantStore(tenancyPath)
  const record = async (action: string, target: string, outcome: string) => {
    ledger.push(`system ${action} ${target} ${outcome}`)
    return true
  }
  system = raw.systemCaller(record)
  providers = publicProviders(raw, {
    tenancy,
    isSystem: caller => raw.isSystemCaller(caller),
    allowance: tenant => billing.allowance(tenant),
  })
  magpie = new ConsoleMagpie({
    statePath: join(root, 'config', 'magpie.json'),
    secretsPath: join(root, 'config', 'magpie-secrets.json'),
    keyPath: join(root, 'keys', 'magpie-master.key'),
    providers,
    tenants: () => config().tenants.map(row => row.id),
    subscriptions: {
      caller: system,
      onProfile: tenant => billing.profileChanged(tenant),
    },
    onError: line => errors.push(line),
  })
  const connected = await magpie.connect(
    {
      gatewayUrl: fake.gatewayUrl,
      managementUrl: fake.managementUrl,
      managementKey: WEB_KEY,
    },
    ops(),
  )
  if (!connected.ok) throw new Error(connected.failure.message)
  channel = new FakeChannel()
  store = new BillingStore(':memory:')
  billing = new ConsoleBilling({
    config: parseBillingConfig({
      version: 1,
      currency: 'CNY',
      sourceUrl: 'https://github.com/sweetcornna/atlas',
      termsUrl: null,
      plans: [
        {
          id: 'month',
          name: '月付',
          priceCents: 9900,
          periodDays: 30,
          note: null,
          nodes: 1,
          gatewayLimits: [{ period: 'month', costUsd: 30 }],
        },
        {
          id: 'team',
          name: '团队',
          priceCents: 29900,
          periodDays: 30,
          note: null,
          nodes: 2,
        },
      ],
      channels: { wechatpay: null, alipay: null, redeem: { enabled: true } },
    }),
    store,
    channels: { wechatpay: channel },
    tenancy,
    magpie,
    providers,
    caller: system,
    record,
    now: () => clock,
    onError: line => errors.push(line),
  })
})

afterEach(async () => {
  // A changed tenant profile queues a node sync; let it land before the
  // files go, or the model service reads its vanished book as tampered.
  await billing.syncNodes()
  // Nothing in these flows is meant to fail quietly on the hub's side.
  expect(errors).toEqual([])
  billing.close()
  raw.stop()
  magpie.close()
  store.close()
  await fake.stop()
  rmSync(root, { recursive: true, force: true })
})

describe('a payment opens the subscription', () => {
  test('tenant made and recorded, key off and held to nothing, profile saved', async () => {
    const tenant = await pay(ALICE)
    expect(tenant).toBe(`t-${ALICE.slice(2, 10)}`)
    expect(config().tenants.map(row => row.id)).toEqual([tenant])
    expect(config().subjects).toEqual([{ subject: ALICE, tenant }])
    expect(ledger).toContain(`system billing.tenant ${tenant} ok`)
    const key = tenantKey(tenant)
    expect(key.off).toBe(true)
    expect(key.models).toEqual([NO_MODEL_PATTERN])
    expect(key.limits.map(limit => `${limit.period} ${limit.cost}`)).toEqual([
      'month 30',
    ])
    const profileId = magpieProfileId({ kind: 'tenant', id: tenant })
    const profile = await raw.profile(profileId)
    expect(profile.ok && profile.value.presetId).toBe('magpie')
    // The key value is in the sealed store only, not in magpie's state file.
    expect(
      readFileSync(join(root, 'config', 'magpie.json'), 'utf8'),
    ).not.toContain(key.secret)
    const standing = await billing.standing(ALICE)
    expect(standing).toMatchObject({
      active: true,
      planId: 'month',
      nodes: 1,
      tenant,
      nodesMapped: 0,
    })
    const me = await billing.me(ALICE)
    expect(me.ok && me.value.gateway).toBe('off')
    // Paying twice for the same tenant makes no second tenant or key.
    clock += DAY
    await pay(ALICE)
    expect(config().tenants).toHaveLength(1)
    expect(
      fake.keys().filter(one => one.name.startsWith('qm-tenant-')),
    ).toHaveLength(1)
  })

  test('a node mapped by ops gets the tenant profile and is delivered, up to the plan', async () => {
    const tenant = await pay(ALICE)
    mapNodes(tenant, ['beta-1', 'beta-2'])
    await billing.syncNodes()
    const overview = await raw.overview()
    if (!overview.ok) throw new Error('overview')
    const profileId = magpieProfileId({ kind: 'tenant', id: tenant })
    const assigned = (node: string) =>
      overview.value.nodes.find(row => row.node === node)?.assignment
    expect(assigned('beta-1')).toEqual({ mode: 'profile', profileId })
    // The plan has one node: the second mapped node gets no model.
    expect(assigned('beta-2')).toEqual({
      mode: 'profile',
      profileId: NO_MODEL_PROFILE,
    })
    // Delivered with the subscriber key; nothing reaches the node unmapped.
    expect(ledger).toContain('system provider.apply beta-1 ok')
    expect(delivered(0)).toEqual({
      key: tenantKey(tenant).secret,
      main: NO_MODEL_PATTERN,
    })
    expect(deliveredProfile(1)?.id).toBe(NO_MODEL_PROFILE)
    expect(delivered(1)?.key).not.toBe(tenantKey(tenant).secret)
    expect(delivered(2)).toBeNull()
    expect((await billing.standing(ALICE)).nodesMapped).toBe(2)
    // Ops cannot hand it a second node either.
    const refused = await providers.assign(
      { node: 'beta-2', assignment: { mode: 'profile', profileId } },
      ops(),
    )
    expect(refused.ok).toBe(false)
    if (!refused.ok) {
      expect(refused.failure.code).toBe('invalid')
      expect(refused.failure.message).toContain('套餐含 1 台节点')
    }
    expect(
      ledger.some(line => line.startsWith('system provider.assign beta-1')),
    ).toBe(true)
  })
})

describe('the subscriber’s own models', () => {
  test('the key is on only with an own upstream, and every list written is non-empty and the tenant’s', async () => {
    const tenant = await pay(ALICE)
    mapNodes(tenant, ['beta-1'])
    await billing.syncNodes()
    const before = tenantKey(tenant)
    expect(before.off).toBe(true)

    const added = await billing.addUpstream(ALICE, {
      preset: 'openai',
      key: 'sk-alice-own-0001',
    })
    if (!added.ok) throw new Error(added.failure.message)
    // magpie named it after the preset; the platform's is `openai`.
    expect(added.value.id).toBe('openai-2')
    await billing.syncNodes()
    const on = tenantKey(tenant)
    expect(on.off).toBe(false)
    expect(on.models).toEqual(['openai-2/*'])
    expect(fake.provider('openai-2')?.name.startsWith(`qmt-${tenant}-`)).toBe(
      true,
    )
    const me = await billing.me(ALICE)
    if (!me.ok) throw new Error('me')
    expect(me.value.gateway).toBe('on')
    expect(me.value.mainModel).toBe('openai-2/gpt-6')
    // The node got the profile again, now pointed at the subscriber's model.
    expect(delivered(0)).toEqual({ key: on.secret, main: 'openai-2/gpt-6' })
    expect(me.value.upstreams).toEqual([
      expect.objectContaining({ id: 'openai-2', present: true }),
    ])
    expect(JSON.stringify(me.value)).not.toContain('sk-alice-own-0001')

    const removed = await billing.removeUpstream(ALICE, 'openai-2')
    expect(removed.ok).toBe(true)
    const off = tenantKey(tenant)
    expect(off.off).toBe(true)
    expect(off.models).toEqual([NO_MODEL_PATTERN])
    expect(fake.provider('openai-2')).toBeUndefined()

    // The whole history of this key: made, held to nothing and switched off
    // before anything else; switched on only after the upstream existed.
    const actions = actionsOn(on.id, on.name)
    expect(actions.slice(0, 3)).toEqual(['add-key', 'models-key', 'off-key'])
    const lists = listsWritten(on.id)
    expect(lists.length).toBeGreaterThan(1)
    for (const list of lists) {
      expect(list.length).toBeGreaterThan(0)
      for (const pattern of list)
        expect([NO_MODEL_PATTERN, 'openai-2/*']).toContain(pattern)
    }
    const firstOn = fake.requests.findIndex(
      request =>
        request.path === '/api/caller-keys/on-key' &&
        (request.body as { key?: unknown }).key === on.id,
    )
    const saved = fake.requests.findIndex(
      request => request.path === '/api/provider/save',
    )
    expect(saved).toBeGreaterThan(-1)
    expect(firstOn).toBeGreaterThan(saved)
  })

  test('tenants never reach each other’s upstreams, and the platform never sees them', async () => {
    const alice = await pay(ALICE)
    const bob = await pay(BOB)
    const a = await billing.addUpstream(ALICE, {
      preset: 'openai',
      key: 'sk-a-1',
    })
    const b = await billing.addUpstream(BOB, {
      preset: 'anthropic',
      key: 'sk-b-1',
    })
    if (!a.ok || !b.ok) throw new Error('add')
    expect(tenantKey(alice).models).toEqual([`${a.value.id}/*`])
    expect(tenantKey(bob).models).toEqual([`${b.value.id}/*`])
    const stolen = await billing.removeUpstream(BOB, a.value.id)
    expect(stolen.ok).toBe(false)
    if (!stolen.ok) expect(stolen.failure.code).toBe('not_found')
    expect(fake.provider(a.value.id)).toBeDefined()

    const snapshot = await magpie.snapshot()
    if (!snapshot.ok) throw new Error('snapshot')
    expect(snapshot.value.providers.map(one => one.id)).toEqual(['openai'])
    expect(
      snapshot.value.models.every(model => model.startsWith('openai/')),
    ).toBe(true)
    // A platform key for a platform node is held to the platform's upstreams.
    const issued = await magpie.issueKey(
      { binding: { kind: 'node', id: 'beta-3' }, mainModel: 'openai/gpt-6' },
      ops(),
    )
    if (!issued.ok) throw new Error(issued.failure.message)
    expect(fake.key(issued.value.keyId)?.models).toEqual(['openai/*'])
    // And the platform page cannot touch a subscriber's key or upstream.
    const edits = [
      await magpie.updateKey(
        { kind: 'tenant', id: alice },
        { models: ['openai/*'] },
        ops(),
      ),
      await magpie.removeKey({ kind: 'tenant', id: alice }, ops()),
      await magpie.issueKey(
        {
          binding: { kind: 'tenant', id: 't-other' },
          mainModel: 'openai/gpt-6',
        },
        ops(),
      ),
      await magpie.removeProvider(a.value.id, ops()),
    ]
    for (const edit of edits) {
      expect(edit.ok).toBe(false)
      if (!edit.ok) expect(['rejected', 'invalid']).toContain(edit.failure.code)
    }
  })

  test('an upstream needs an active subscription and an API-key preset', async () => {
    const none = await billing.addUpstream(ALICE, {
      preset: 'openai',
      key: 'k',
    })
    expect(none.ok).toBe(false)
    await pay(ALICE)
    const local = await billing.addUpstream(ALICE, {
      preset: 'ollama',
      key: '',
    })
    expect(local.ok).toBe(false)
    const presets = await billing.presets()
    expect(presets.ok && presets.value.map(one => one.id)).not.toContain(
      'ollama',
    )
  })

  test('a subscriber is offered the vendors’ own APIs and OpenRouter, no other relay', async () => {
    await pay(ALICE)
    const presets = await billing.presets()
    expect(presets.ok && presets.value.map(one => one.id)).toEqual([
      'anthropic',
      'openai',
      'openrouter',
    ])
    const relay = await billing.addUpstream(ALICE, {
      preset: 'relay-hub',
      key: 'sk-relay-0001',
    })
    expect(relay.ok).toBe(false)
    if (!relay.ok) expect(relay.failure.code).toBe('rejected')
    expect(
      fake.requests.some(
        request =>
          request.path === '/api/provider/save' &&
          (request.body as { preset?: unknown } | null)?.preset === 'relay-hub',
      ),
    ).toBe(false)
  })
})

describe('expiry', () => {
  test('the sweep turns the key off when the period ends, upstream or not', async () => {
    const tenant = await pay(ALICE)
    const added = await billing.addUpstream(ALICE, {
      preset: 'openai',
      key: 'k-1',
    })
    expect(added.ok).toBe(true)
    expect(tenantKey(tenant).off).toBe(false)
    clock += 31 * DAY
    await billing.tick()
    expect(tenantKey(tenant).off).toBe(true)
    expect((await billing.standing(ALICE)).active).toBe(false)
    const admin = await billing.admin()
    if (!admin.ok) throw new Error('admin')
    expect(admin.value.subscriptions).toEqual([
      expect.objectContaining({ subject: ALICE, gateway: 'disabled', tenant }),
    ])
    // Renewing switches it back on: the upstream is still there.
    await pay(ALICE)
    expect(tenantKey(tenant).off).toBe(false)
  })

  test('switching off goes by the tenant the subscription was provisioned for, never a guessed one', async () => {
    // Same first 8 hex digits: Alice gets t-a11ce000, Carol the long form.
    const CAROL = 'u:a11ce000ffffffff'
    const alice = await pay(ALICE)
    const carol = await pay(CAROL)
    expect(alice).toBe('t-a11ce000')
    expect(carol).toBe('t-a11ce000ffffffff')
    for (const subject of [ALICE, CAROL]) {
      const added = await billing.addUpstream(subject, {
        preset: 'openai',
        key: `sk-own-${subject.slice(2)}`,
      })
      expect(added.ok).toBe(true)
    }
    // Ops take Carol out of the subjects table (account cleanup).
    const current = config()
    tenancy.replace({
      ...current,
      subjects: current.subjects.filter(row => row.subject !== CAROL),
    })
    await billing.setEnabled(CAROL, false)
    expect(tenantKey(carol).off).toBe(true)
    expect(tenantKey(alice).off).toBe(false)
  })

  test('a tenant stays on while anybody in it is still paid up', async () => {
    const DAVE = 'u:da7e000000000004'
    const tenant = await pay(ALICE)
    // Ops put Dave into Alice's tenant; he pays ten days later.
    const current = config()
    tenancy.replace({
      ...current,
      subjects: [...current.subjects, { subject: DAVE, tenant }],
    })
    clock += 10 * DAY
    expect(await pay(DAVE)).toBe(tenant)
    const added = await billing.addUpstream(ALICE, {
      preset: 'openai',
      key: 'sk-alice-own-0001',
    })
    expect(added.ok).toBe(true)
    // Alice's period ends; Dave's has ten days to go.
    clock += 21 * DAY
    await billing.tick()
    expect((await billing.standing(ALICE)).active).toBe(false)
    expect(tenantKey(tenant).off).toBe(false)
    // Dave's ends too.
    clock += 10 * DAY
    await billing.tick()
    expect(tenantKey(tenant).off).toBe(true)
  })

  test('disabling somebody never provisioned is a no-op', async () => {
    await billing.setEnabled(BOB, false)
    expect(
      fake.requests.some(request => request.path.includes('off-key')),
    ).toBe(false)
  })
})

describe('the model service in the public edition', () => {
  test('only the magpie preset, and a tenant node only on its tenant’s profile', async () => {
    const tenant = await pay(ALICE)
    mapNodes(tenant, ['beta-1'])
    const caller = ops()
    const draft = {
      id: 'vendor',
      name: 'Vendor',
      presetId: 'openai',
      plan: 'custom',
      site: null,
      lane: 'openai-responses',
      baseUrl: 'https://api.openai.com/v1',
      auth: { scheme: 'bearer' },
      keys: [{ id: 'k1' }],
      models: [],
      evaluated: false,
    }
    const save = await providers.saveProfile(
      { profile: draft, ifMatch: null, secrets: { k1: 'sk-x' } },
      caller,
    )
    expect(save.ok).toBe(false)
    if (!save.ok) expect(save.failure.code).toBe('edition_public_magpie_only')
    expect(providers.catalog().presets.map(one => one.id)).toEqual(['magpie'])
    const imported = await providers.importProfiles({ text: '{}' }, caller)
    expect(imported.ok).toBe(false)

    const profileId = magpieProfileId({ kind: 'tenant', id: tenant })
    for (const result of [
      await providers.assign(
        { node: 'beta-1', assignment: { mode: 'inherit' } },
        caller,
      ),
      await providers.assign(
        {
          node: 'beta-3',
          assignment: { mode: 'profile', profileId },
        },
        caller,
      ),
      await providers.setDefault({ profileId }, caller),
      await providers.setSecret(
        { profileId, keyId: 'gw', value: 'stolen-key-0001', ifMatch: 1 },
        caller,
      ),
    ]) {
      expect(result.ok).toBe(false)
      if (!result.ok)
        expect(result.failure.code).toBe('edition_public_magpie_only')
    }
    // Not managing would leave whatever key the node last got: refused. No
    // model is how a tenant node is taken back.
    const stop = await providers.assign(
      { node: 'beta-1', assignment: { mode: 'unmanaged' } },
      caller,
    )
    expect(stop.ok).toBe(false)
    if (!stop.ok) expect(stop.failure.code).toBe('edition_public_magpie_only')
    const none = await providers.assign(
      {
        node: 'beta-1',
        assignment: { mode: 'profile', profileId: NO_MODEL_PROFILE },
      },
      caller,
    )
    expect(none.ok).toBe(true)
  })
})

/** The profile id, key and main model last delivered to node `index`, or null. */
function deliveredProfile(
  index: number,
): { id: unknown; key: unknown; main: unknown; extra: unknown[] } | null {
  const last = nodes[index]
    ?.requests()
    .filter(request => request['op'] === 'apply' && request['dryRun'] !== true)
    .at(-1)
  if (last === undefined) return null
  const profile = last['profile'] as {
    id: string
    auth: { keys: { value?: string }[] }
    models: { id: string; role: string }[]
  }
  const extra = (last['profiles'] ?? []) as { id: string }[]
  return {
    id: profile.id,
    key: profile.auth.keys[0]?.value,
    main: profile.models.find(model => model.role === 'main')?.id,
    extra: extra.map(one => one.id),
  }
}

async function nodeRow(node: string) {
  const overview = await raw.overview()
  if (!overview.ok) throw new Error('overview')
  const row = overview.value.nodes.find(one => one.node === node)
  if (row === undefined) throw new Error(`no ${node}`)
  return row
}

describe('a tenant node holds its tenant’s profile or no model, nothing else', () => {
  async function platformKey(node: string) {
    const issued = await magpie.issueKey(
      { binding: { kind: 'node', id: node }, mainModel: 'openai/gpt-6' },
      ops(),
    )
    if (!issued.ok) throw new Error(issued.failure.message)
    const secret = fake.key(issued.value.keyId)?.secret
    if (secret === undefined) throw new Error('no platform secret')
    return { profileId: magpieProfileId({ kind: 'node', id: node }), secret }
  }

  test('a platform default is never what a tenant node is expected to run, and deliver-all gives it no model', async () => {
    // Before any tenant node exists, ops make a platform profile the default.
    const platform = await platformKey('beta-3')
    const def = await providers.setDefault(
      { profileId: platform.profileId },
      ops(),
    )
    expect(def.ok).toBe(true)
    const tenant = await pay(ALICE)
    mapNodes(tenant, ['beta-1', 'beta-2'])
    // beta-2 follows the default in the book; it is still not the platform's.
    expect((await nodeRow('beta-2')).assignment.mode).not.toBe('profile')
    expect((await nodeRow('beta-2')).expected?.profileId).toBe(NO_MODEL_PROFILE)
    const applied = await providers.apply({}, ops())
    expect(applied.ok).toBe(true)
    const beta2 = deliveredProfile(1)
    expect(beta2?.id).toBe(NO_MODEL_PROFILE)
    expect(beta2?.main).toBe(NO_MODEL_PATTERN)
    expect(beta2?.key).not.toBe(platform.secret)
    // magpie does not know the no-model key: it opens nothing.
    expect(fake.keys().some(key => key.secret === beta2?.key)).toBe(false)
    // The platform node still runs the platform profile.
    expect(deliveredProfile(2)?.key).toBe(platform.secret)
    for (let index = 0; index < 2; index++) {
      const all = JSON.stringify(nodes[index]?.requests())
      expect(all).not.toContain(platform.secret)
    }
  })

  test('with tenant nodes the default can only be cleared or set to no model', async () => {
    const platform = await platformKey('beta-3')
    const tenant = await pay(ALICE)
    mapNodes(tenant, ['beta-1'])
    const set = await providers.setDefault(
      { profileId: platform.profileId },
      ops(),
    )
    expect(set.ok).toBe(false)
    if (!set.ok) expect(set.failure.code).toBe('edition_public_magpie_only')
    expect((await providers.setDefault({ profileId: null }, ops())).ok).toBe(
      true,
    )
    expect(
      (await providers.setDefault({ profileId: NO_MODEL_PROFILE }, ops())).ok,
    ).toBe(true)
  })

  test('the no-model profile is the hub’s own: ops cannot edit or delete it', async () => {
    const profile = await raw.profile(NO_MODEL_PROFILE)
    if (!profile.ok) throw new Error('no no-model profile after connect')
    expect(profile.value.presetId).toBe('magpie')
    const revision = profile.value.revision
    for (const result of [
      await providers.setSecret(
        {
          profileId: NO_MODEL_PROFILE,
          keyId: 'gw',
          value: 'sk-planted-0000001',
          ifMatch: revision,
        },
        ops(),
      ),
      await providers.deleteProfile(
        { profileId: NO_MODEL_PROFILE, ifMatch: revision },
        ops(),
      ),
      await providers.saveProfile(
        { profile: { ...profile.value }, ifMatch: revision },
        ops(),
      ),
    ]) {
      expect(result.ok).toBe(false)
      if (!result.ok)
        expect(result.failure.code).toBe('edition_public_magpie_only')
    }
  })

  test('probes, model lists and dry runs of another profile never reach a tenant node', async () => {
    const platform = await platformKey('beta-3')
    const tenant = await pay(ALICE)
    mapNodes(tenant, ['beta-1'])
    await billing.syncNodes()
    const before = nodes[0]?.requests().length ?? 0
    const candidate = { profileId: platform.profileId }
    for (const result of [
      await providers.probe({ node: 'beta-1', mode: 'auth', candidate }, ops()),
      await providers.models({ node: 'beta-1', candidate }, ops()),
      await providers.probe(
        {
          node: 'beta-1',
          mode: 'auth',
          candidate: {
            draft: { id: platform.profileId, presetId: 'magpie' },
          },
        },
        ops(),
      ),
    ]) {
      expect(result.ok).toBe(false)
      if (!result.ok)
        expect(result.failure.code).toBe('edition_public_magpie_only')
    }
    const dry = await providers.apply(
      { nodes: ['beta-1'], dryRun: true, profileId: platform.profileId },
      ops(),
    )
    expect(dry.ok && dry.value[0]?.outcome).toBe('refused')
    expect(nodes[0]?.requests().length).toBe(before)
  })

  test('hub-wide task routing to a platform profile does not travel to a tenant node', async () => {
    const routing = new ConsoleRouting({
      path: join(root, 'config', 'routing.json'),
      profiles: () => raw.routingProfiles(),
    })
    raw.configureRouting(node => {
      const view = routing.effective(node)
      return view.updatedAt === null
        ? { revision: view.revision }
        : { revision: view.revision, routing: routingWire(view) }
    })
    const platform = await platformKey('beta-3')
    const saved = await routing.save(
      {
        node: null,
        auto: false,
        revision: 0,
        routes: [
          {
            direction: 'fast',
            profileId: platform.profileId,
            modelId: 'openai/gpt-6',
          },
        ],
      },
      { subject: OPS, role: 'ops', requestId: 'r-1' },
    )
    expect(saved.ok).toBe(true)
    const tenant = await pay(ALICE)
    const added = await billing.addUpstream(ALICE, {
      preset: 'openai',
      key: 'sk-alice-own-0001',
    })
    expect(added.ok).toBe(true)
    mapNodes(tenant, ['beta-1'])
    await billing.syncNodes()
    const own = magpieProfileId({ kind: 'tenant', id: tenant })
    const beta1 = deliveredProfile(0)
    expect(beta1?.id).toBe(own)
    expect(beta1?.extra).toEqual([])
    expect(JSON.stringify(nodes[0]?.requests())).not.toContain(platform.secret)
  })
})

describe('the plan’s node count, kept by the node sync', () => {
  function assigned(row: { assignment: { mode: string } }): string | null {
    const assignment = row.assignment as { mode: string; profileId?: string }
    return assignment.mode === 'profile' ? (assignment.profileId ?? null) : null
  }

  test('mapped nodes beyond the plan are put on no model and delivered, whatever they held', async () => {
    // beta-2 was a platform node with a platform key, its profile the default.
    const issued = await magpie.issueKey(
      { binding: { kind: 'node', id: 'beta-2' }, mainModel: 'openai/gpt-6' },
      ops(),
    )
    if (!issued.ok) throw new Error(issued.failure.message)
    const platformSecret = fake.key(issued.value.keyId)?.secret
    const platformProfile = magpieProfileId({ kind: 'node', id: 'beta-2' })
    expect(
      (await providers.setDefault({ profileId: platformProfile }, ops())).ok,
    ).toBe(true)
    expect(deliveredProfile(1)?.key).toBe(platformSecret)
    const tenant = await pay(ALICE)
    mapNodes(tenant, ['beta-1', 'beta-2', 'beta-3'])
    await billing.syncNodes()
    const own = magpieProfileId({ kind: 'tenant', id: tenant })
    expect(assigned(await nodeRow('beta-1'))).toBe(own)
    expect(assigned(await nodeRow('beta-2'))).toBe(NO_MODEL_PROFILE)
    expect(assigned(await nodeRow('beta-3'))).toBe(NO_MODEL_PROFILE)
    expect(deliveredProfile(0)?.id).toBe(own)
    // The platform key the node held is replaced; beta-3 never had one.
    expect(deliveredProfile(1)?.id).toBe(NO_MODEL_PROFILE)
    expect(deliveredProfile(1)?.key).not.toBe(platformSecret)
    expect(deliveredProfile(2)?.id).toBe(NO_MODEL_PROFILE)
    expect(ledger).toContain('system provider.apply beta-2 ok')
  })

  test('a downgrade takes back the nodes the new plan does not cover', async () => {
    const tenant = await pay(ALICE, 'team')
    mapNodes(tenant, ['beta-1', 'beta-2'])
    await billing.syncNodes()
    const own = magpieProfileId({ kind: 'tenant', id: tenant })
    expect(assigned(await nodeRow('beta-1'))).toBe(own)
    expect(assigned(await nodeRow('beta-2'))).toBe(own)
    clock += 31 * DAY
    await billing.tick()
    await pay(ALICE, 'month')
    await billing.syncNodes()
    expect(billing.allowance(tenant)).toBe(1)
    expect(assigned(await nodeRow('beta-1'))).toBe(own)
    expect(assigned(await nodeRow('beta-2'))).toBe(NO_MODEL_PROFILE)
    expect(deliveredProfile(0)?.id).toBe(own)
    expect(deliveredProfile(1)?.id).toBe(NO_MODEL_PROFILE)
  })

  test('expiry takes every node back; renewal gives them back', async () => {
    const tenant = await pay(ALICE)
    mapNodes(tenant, ['beta-1'])
    await billing.syncNodes()
    const own = magpieProfileId({ kind: 'tenant', id: tenant })
    expect(deliveredProfile(0)?.id).toBe(own)
    clock += 31 * DAY
    await billing.tick()
    expect(assigned(await nodeRow('beta-1'))).toBe(NO_MODEL_PROFILE)
    expect(deliveredProfile(0)?.id).toBe(NO_MODEL_PROFILE)
    await pay(ALICE)
    await billing.syncNodes()
    expect(assigned(await nodeRow('beta-1'))).toBe(own)
    expect(deliveredProfile(0)?.id).toBe(own)
  })
})

describe('removing a subscriber’s upstream', () => {
  test('one that fails half way is still the subscriber’s, and asking again finishes it', async () => {
    const tenant = await pay(ALICE)
    const added = await billing.addUpstream(ALICE, {
      preset: 'openai',
      key: 'sk-alice-own-0001',
    })
    if (!added.ok) throw new Error(added.failure.message)
    const id = added.value.id
    fake.fault({
      target: 'management',
      path: '/api/provider/delete',
      times: 1,
      status: 500,
      body: 'down',
    })
    const first = await billing.removeUpstream(ALICE, id)
    expect(first.ok).toBe(false)
    // Not forgotten while it is still in magpie with the subscriber's key ...
    expect(fake.provider(id)).toBeDefined()
    const listed = await billing.me(ALICE)
    expect(
      listed.ok && listed.value.upstreams.map(upstream => upstream.id),
    ).toEqual([id])
    // ... and the key was taken off it before magpie was asked to delete it.
    expect(tenantKey(tenant).models).toEqual([NO_MODEL_PATTERN])
    expect(tenantKey(tenant).off).toBe(true)
    const again = await billing.removeUpstream(ALICE, id)
    expect(again.ok).toBe(true)
    expect(fake.provider(id)).toBeUndefined()
    const after = await billing.me(ALICE)
    expect(after.ok && after.value.upstreams).toEqual([])
  })
})

describe('a new gateway address', () => {
  test('reaches every subscriber profile, saved as the hub, and their nodes', async () => {
    const tenant = await pay(ALICE)
    const added = await billing.addUpstream(ALICE, {
      preset: 'openai',
      key: 'sk-alice-own-0001',
    })
    if (!added.ok) throw new Error(added.failure.message)
    mapNodes(tenant, ['beta-1'])
    await billing.syncNodes()
    const profileId = magpieProfileId({ kind: 'tenant', id: tenant })
    const moved = await magpie.connect(
      {
        gatewayUrl: 'https://gw2.example.test',
        managementUrl: fake.managementUrl,
      },
      ops(),
    )
    expect(moved.ok).toBe(true)
    await billing.syncNodes()
    const after = await raw.profile(profileId)
    expect(after.ok && after.value.baseUrl).toBe('https://gw2.example.test')
    const none = await raw.profile(NO_MODEL_PROFILE)
    expect(none.ok && none.value.baseUrl).toBe('https://gw2.example.test')
    const last = nodes[0]
      ?.requests()
      .filter(
        request => request['op'] === 'apply' && request['dryRun'] !== true,
      )
      .at(-1)
    expect(
      (last?.['profile'] as { baseUrl?: string } | undefined)?.baseUrl,
    ).toBe('https://gw2.example.test')
    expect(ledger).toContain(`system provider.save ${profileId} ok`)
  })
})

describe('a delivery that did not land is tried again', () => {
  const REFUSE = JSON.stringify({
    v: 1,
    requestId: 'x',
    ok: false,
    code: 'write-failed',
    message: 'busy',
  })
  const applies = (index: number) =>
    nodes[index]
      ?.requests()
      .filter(
        request => request['op'] === 'apply' && request['dryRun'] !== true,
      ).length ?? 0

  test('the sweep delivers again until the node runs what it is expected to', async () => {
    const tenant = await pay(ALICE)
    mapNodes(tenant, ['beta-1'])
    await billing.syncNodes()
    // The node cannot take a delivery when the subscriber connects a model.
    nodes[0]?.set('reply-apply.json', REFUSE)
    const added = await billing.addUpstream(ALICE, {
      preset: 'openai',
      key: 'sk-alice-own-0001',
    })
    if (!added.ok) throw new Error(added.failure.message)
    await billing.syncNodes()
    // Said, not swallowed.
    expect(errors.some(line => line.includes('beta-1'))).toBe(true)
    errors.length = 0
    rmSync(join(nodes[0]?.dir ?? '', 'reply-apply.json'))
    // The next sweep, a minute on.
    clock += 60_000
    await billing.tick()
    const row = await nodeRow('beta-1')
    expect(row.actual?.applied?.revision).toBe(row.expected?.revision)
    expect(delivered(0)).toEqual({
      key: tenantKey(tenant).secret,
      main: 'openai-2/gpt-6',
    })
  })

  test('a node that keeps refusing is asked one sweep later, then every five minutes', async () => {
    const tenant = await pay(ALICE)
    nodes[0]?.set('reply-apply.json', REFUSE)
    mapNodes(tenant, ['beta-1'])
    await billing.syncNodes()
    expect(applies(0)).toBe(1)
    // Syncs in the same minute (a tenancy change, a profile change) wait.
    await billing.tick()
    expect(applies(0)).toBe(1)
    clock += 60_000
    await billing.tick()
    expect(applies(0)).toBe(2)
    clock += 60_000
    await billing.tick()
    expect(applies(0)).toBe(2)
    clock += 4 * 60_000
    await billing.tick()
    expect(applies(0)).toBe(3)
    expect(errors.length).toBeGreaterThan(0)
    errors.length = 0
    rmSync(join(nodes[0]?.dir ?? '', 'reply-apply.json'))
  })
})

// ---------------------------------------------------------------------------
// Startup rules and templates
// ---------------------------------------------------------------------------

const PUBLIC_FLAGS = [
  '--accounts',
  '--tenancy',
  '/srv/qianmo/tenancy.json',
  '--open-registration',
  '--registration-max-accounts',
  '100',
  '--providers',
  '--magpie',
]

describe('which edition starts with what', () => {
  test('the default edition refuses --billing', () => {
    expect(() =>
      parseConsoleArgs(['--billing', '/srv/qianmo/billing.json'], 'default'),
    ).toThrow('--billing is only for the public edition')
    expect(parseConsoleArgs([], 'default')).not.toHaveProperty('edition')
  })

  test('the public edition refuses to start without its five flags', () => {
    expect(() => parseConsoleArgs([], 'public')).toThrow(
      'missing --accounts, --tenancy, --open-registration, --providers, --magpie',
    )
    expect(() =>
      parseConsoleArgs(
        PUBLIC_FLAGS.filter(flag => flag !== '--magpie'),
        'public',
      ),
    ).toThrow('missing --magpie')
  })

  test('with them it is public, with the default billing path and the view token off', () => {
    const config = parseConsoleArgs(PUBLIC_FLAGS, 'public')
    expect(config.edition).toBe('public')
    expect(config.billingPath).toBe(consoleBillingPath())
    expect(consoleBillingPath()).toBe(billingConfigPath())
    expect(config.legacyViewToken).toBe(false)
    expect(
      parseConsoleArgs(
        [...PUBLIC_FLAGS, '--billing=/srv/qianmo/billing.json'],
        'public',
      ).billingPath,
    ).toBe('/srv/qianmo/billing.json')
    expect(() =>
      parseConsoleArgs(
        [...PUBLIC_FLAGS, '--legacy-view-token', 'on'],
        'public',
      ),
    ).toThrow('keeps --legacy-view-token off')
    expect(
      parseConsoleArgs(
        [...PUBLIC_FLAGS, '--legacy-view-token', 'off'],
        'public',
      ).legacyViewToken,
    ).toBe(false)
  })

  test('a billing config that does not load is a refusal that names the file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qianmo-billing-load-'))
    try {
      const missing = join(dir, 'missing.json')
      expect(() => loadBillingConfig(missing)).toThrow(
        `billing config ${missing} cannot be read`,
      )
      const broken = join(dir, 'broken.json')
      writeFileSync(broken, '{ nope', { mode: 0o600 })
      expect(() => loadBillingConfig(broken)).toThrow('is not JSON')
      const example = join(
        REPO,
        'demo',
        'env',
        'public',
        'billing.example.json',
      )
      expect(() => loadBillingConfig(example)).toThrow('priceCents')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('demo/env/public', () => {
  const dir = join(REPO, 'demo', 'env', 'public')

  /** The secret files a config names, answered from memory. */
  function stubSecrets(): (path: string) => string {
    const pair = () => {
      const { privateKey, publicKey } = generateKeyPairSync('rsa', {
        modulusLength: 2048,
      })
      return {
        privatePem: privateKey
          .export({ type: 'pkcs8', format: 'pem' })
          .toString(),
        publicPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      }
    }
    const merchant = pair()
    const platform = pair()
    return path => {
      if (path.endsWith('apiv3.key')) return 'abcdefghijklmnopqrstuvwxyz012345'
      if (/private|apiclient_key/.test(path)) return merchant.privatePem
      return platform.publicPem
    }
  }

  test('the example is refused as it is and loads once prices are set', () => {
    const example = JSON.parse(
      readFileSync(join(dir, 'billing.example.json'), 'utf8'),
    ) as { plans: { priceCents: number }[] }
    const readSecret = stubSecrets()
    expect(() => parseBillingConfig(example, { readSecret })).toThrow(
      '$.plans[0].priceCents',
    )
    const priced = {
      ...example,
      plans: example.plans.map(plan => ({ ...plan, priceCents: 9900 })),
    }
    const config = parseBillingConfig(priced, { readSecret })
    expect(config.plans.map(plan => plan.nodes)).toEqual([1, 3])
    expect(config.channels.wechatpay).not.toBeNull()
    expect(config.channels.alipay).not.toBeNull()
    expect(config.sourceUrl).toBe('https://github.com/sweetcornna/atlas')
  })

  test('the console unit runs the public build with flags the real parser accepts', () => {
    const unit = readFileSync(join(dir, 'qm-public-console.service'), 'utf8')
    const exec = /^ExecStart=((?:.*\\\n)*.*)$/m.exec(unit)?.[1]
    if (exec === undefined) throw new Error('no ExecStart')
    const words = exec.replace(/\\\n/g, ' ').split(/\s+/).filter(Boolean)
    expect(words[0]).toBe('/opt/qianmo/dist/qm-public-linux-x64')
    expect(words[1]).toBe('console')
    const config = parseConsoleArgs(words.slice(2), 'public')
    expect(config.edition).toBe('public')
    expect(config.billingPath).toBe(
      '/var/lib/qianmo/config/qianmo/console/billing.json',
    )
    expect(config.magpie).toBe(true)
    expect(config.legacyViewToken).toBe(false)
    expect(config.hostname).toBe('127.0.0.1')
    const magpieUnit = readFileSync(join(dir, 'magpie.service'), 'utf8')
    expect(magpieUnit).toContain('magpie serve --web=127.0.0.1:3430')
    expect(magpieUnit).not.toMatch(/MAGPIE_WEB_KEY=/)
  })
})
