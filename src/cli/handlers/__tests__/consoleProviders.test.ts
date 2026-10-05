// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 模型服务的中枢端口（P18.6，`providers-console-m1.md` §2–§3、§6.3、§7）：真文件、
 * 真密文库、真执行器加一个真子进程扮演的节点、真 `ActionLedger`。零 `mock.module`。
 *
 * 钉 §9.2 P18.6 一格里端口这一侧的几条：
 *
 * - `providers.ndjson` 有坏行时拒绝服务（以及链断、运行中被改）；
 * - 主密钥缺失而密文存在时整个面 fail-closed；
 * - D-8：未写 `contextTokens` 的档案编译出 200 000，节点覆盖优先于档案，清除覆盖
 *   后回到档案值；
 * - 每类写动作在动作账本里各记一条（真 `ActionLedger` + `MemoryActionStore`）；
 * - 金丝雀：任何返回值、账本、`providers.ndjson`、导出、告警、错误信息、执行器
 *   argv 里都没有 key 的明文或片段。
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import {
  appendFileSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ActionLedger,
  type ActionRecord,
  CONSOLE_ACTIONS,
  type ProviderActionName,
  type ProviderCaller,
  type ProviderProfileDraft,
} from '@qianmo/console'
import { parseWireProfile, type WireProfile } from '@qianmo/providers'
import { MemoryActionStore } from '../../../../packages/console/test/actionStore.js'
import { compileProfile } from '../../../services/qianmo/providers/compile.js'
import {
  type ConsoleProviders,
  openConsoleProviders,
  type ProviderScheduler,
} from '../consoleProviders.js'
import { type FakeNode, fakeNode, fakeSsh } from './consoleProvidersFakeNode.js'

const CANARY = 'sk-test-canary-port-Xv93KdQ1mB7zR4nW'
const CANARY_2 = 'sk-test-canary-port-second-Lp05TzE8jH'
const OPS = 'u:0123456789abcdef'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

/** Timers that never fire on their own: the tests drive refreshes directly. */
const STILL: ProviderScheduler = {
  set: () => null,
  clear: () => {},
}

interface Harness {
  readonly root: string
  readonly port: ConsoleProviders
  readonly nodes: Record<'beta-1' | 'beta-4', FakeNode>
  readonly ledger: ActionLedger
  readonly ledgerStore: MemoryActionStore
  readonly alarms: string[]
  readonly paths: { store: string; secrets: string; key: string }
  caller(overrides?: Partial<Omit<ProviderCaller, 'record'>>): ProviderCaller
  reopen(): ConsoleProviders
}

function harness(options: { readonly now?: () => number } = {}): Harness {
  const root = mkdtempSync(join(tmpdir(), 'qianmo-providers-port-'))
  roots.push(root)
  const nodes = {
    'beta-1': fakeNode(join(root, 'node-1')),
    'beta-4': fakeNode(join(root, 'node-4')),
  }
  const paths = {
    store: join(root, 'config', 'qianmo', 'console', 'providers.ndjson'),
    secrets: join(root, 'config', 'qianmo', 'console', 'provider-secrets.json'),
    key: join(root, 'secrets', 'provider-master.key'),
  }
  const alarms: string[] = []
  const open = () =>
    openConsoleProviders({
      storePath: paths.store,
      secretsPath: paths.secrets,
      keyPath: paths.key,
      knownHostsFile: join(root, 'known_hosts'),
      nodes: [
        { node: 'beta-1', kind: 'local', command: nodes['beta-1'].command },
        { node: 'beta-4', kind: 'local', command: nodes['beta-4'].command },
      ],
      onAlarm: line => alarms.push(line),
      scheduler: STILL,
      ...(options.now === undefined ? {} : { now: options.now }),
    })
  const ledgerStore = new MemoryActionStore()
  const ledger = new ActionLedger({ store: ledgerStore })
  return {
    root,
    port: open(),
    nodes,
    ledger,
    ledgerStore,
    alarms,
    paths,
    // What `http.ts`'s request ledger does for `ctx.record`, verbatim in shape.
    caller(overrides = {}) {
      const requestId = randomUUID()
      const subject = overrides.subject ?? OPS
      const breakGlass = overrides.breakGlass ?? false
      return {
        subject,
        role: overrides.role === undefined ? 'ops' : overrides.role,
        breakGlass,
        record: async (action, target, outcome, code) =>
          (
            await ledger.record({
              at: Date.now(),
              requestId,
              subject,
              ...(breakGlass ? { breakGlass: true as const } : {}),
              action,
              target,
              outcome,
              ...(code === undefined ? {} : { code }),
            })
          ).ok,
      }
    },
    reopen: open,
  }
}

function draft(overrides: Record<string, unknown> = {}): ProviderProfileDraft {
  return {
    id: 'luna',
    name: 'Luna 网关',
    presetId: null,
    plan: 'custom',
    site: null,
    lane: 'openai-responses',
    baseUrl: 'https://gateway.vendor.example/v1',
    auth: { scheme: 'bearer' },
    keys: [{ id: 'k1' }],
    models: [
      {
        id: 'gpt-6-luna',
        role: 'main',
        tiers: ['opus', 'sonnet', 'fable'],
        capabilities: {
          mode: 'explicit',
          thinking: false,
          adaptive_thinking: false,
          interleaved_thinking: false,
        },
        effort: {
          send: 'always',
          levels: ['low', 'medium', 'high', 'max'],
          level: 'max',
        },
      },
    ],
    evaluated: false,
    ...overrides,
  }
}

async function entries(h: Harness): Promise<ActionRecord[]> {
  const page = await h.ledger.list({ actionPrefix: 'provider.', limit: 500 })
  if (!page.ok) throw new Error(page.failure.message)
  return [...page.value.entries].reverse()
}

function value<T>(
  result: { ok: true; value: T } | { ok: false; failure: unknown },
): T {
  if (!result.ok) throw new Error(JSON.stringify(result.failure))
  return result.value
}

/** The wire profiles a fake node received for `op`. */
function received(node: FakeNode, op: string): WireProfile[] {
  return node
    .requests()
    .filter(request => request.op === op)
    .map(request => {
      const parsed = parseWireProfile(request.profile)
      if (!parsed.ok) throw new Error(JSON.stringify(parsed.error))
      return parsed.value
    })
}

function compiledDefaultContext(wire: WireProfile): number | undefined {
  const compiled = compileProfile(wire, {
    secret: 'x',
    capabilities: {
      protocol: 1,
      chatEffortHonorsOverride: false,
      replayFilter: false,
      multiKey: false,
    },
  })
  if (!compiled.ok) throw new Error(JSON.stringify(compiled.error))
  return compiled.compiled.patch.modelSettings.default?.contextTokens
}

async function savedWithKey(h: Harness, extra: Record<string, unknown> = {}) {
  return value(
    await h.port.saveProfile(
      { profile: draft(extra), ifMatch: null, secrets: { k1: CANARY } },
      h.caller(),
    ),
  )
}

describe('the book is read strictly', () => {
  test('a bad line in providers.ndjson closes the whole face; a clean book serves', async () => {
    const h = harness()
    await savedWithKey(h)
    // Positive control.
    expect((await h.reopen().overview()).ok).toBe(true)
    appendFileSync(h.paths.store, '{"seq":99,"broken":true}\n')
    const port = h.reopen()
    expect(port.problem).toContain('第')
    for (const result of [
      await port.overview(),
      await port.profile('luna'),
      await port.node('beta-1'),
      await port.exportProfiles(),
      await port.apply({}, h.caller()),
      await port.saveProfile(
        { profile: draft({ id: 'other' }), ifMatch: null },
        h.caller(),
      ),
    ]) {
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.failure.code).toBe('unavailable')
    }
    // Nothing was sent to any node.
    expect(h.nodes['beta-1'].requests()).toEqual([])
    expect(h.alarms.some(line => line.includes('模型服务已停用'))).toBe(true)
    // The catalog does not read the book and still answers.
    expect(port.catalog().presets.length).toBeGreaterThan(0)
  }, 30_000)

  test('an edited line breaks the chain and closes the face', async () => {
    const h = harness()
    await savedWithKey(h)
    const text = readFileSync(h.paths.store, 'utf8')
    writeFileSync(h.paths.store, text.replace('Luna 网关', 'Luna 网关X'))
    expect(h.reopen().problem).toContain('哈希链断开')
  }, 30_000)

  test('a book changed under a running console stops taking writes', async () => {
    const h = harness()
    await savedWithKey(h)
    const text = readFileSync(h.paths.store, 'utf8').split('\n')
    writeFileSync(h.paths.store, `${text.slice(0, -2).join('\n')}\n`)
    const result = await h.port.setDefault({ profileId: 'luna' }, h.caller())
    expect(result.ok).toBe(false)
    expect(h.port.problem).toContain('被改动')
  }, 30_000)

  test('the book is 0600 in a 0700 directory', async () => {
    const h = harness()
    await savedWithKey(h)
    expect(statSync(h.paths.store).mode & 0o777).toBe(0o600)
    expect(
      statSync(join(h.root, 'config', 'qianmo', 'console')).mode & 0o777,
    ).toBe(0o700)
  }, 30_000)

  test('a missing master key with ciphertext present closes the face and is not regenerated', async () => {
    const h = harness()
    await savedWithKey(h)
    rmSync(h.paths.key)
    const port = h.reopen()
    expect(port.problem).toContain('主密钥缺失')
    const result = await port.apply({ nodes: ['beta-1'] }, h.caller())
    expect(result.ok ? 'ok' : result.failure.code).toBe('unavailable')
    expect(readdirSync(join(h.root, 'secrets'))).toEqual([])
  }, 30_000)
})

describe('who may write', () => {
  test('viewer, member, break-glass, legacy and anonymous are rejected and nothing is recorded', async () => {
    const h = harness()
    const cases: Partial<Omit<ProviderCaller, 'record'>>[] = [
      { role: 'viewer' },
      { role: 'member' },
      { breakGlass: true },
      { subject: 'legacy:admin', role: null },
      { subject: 'anonymous', role: null },
    ]
    for (const overrides of cases) {
      const result = await h.port.saveProfile(
        { profile: draft(), ifMatch: null, secrets: { k1: CANARY } },
        h.caller(overrides),
      )
      expect(result.ok ? 'ok' : result.failure.code).toBe('rejected')
    }
    expect(await entries(h)).toEqual([])
    expect((await h.port.profile('luna')).ok).toBe(false)
  }, 30_000)
})

describe('every kind of write is one line in the action ledger', () => {
  test('each provider.* verb is written exactly once, with an id or node name as target', async () => {
    const h = harness()
    const ops = h.caller()
    const saved = await savedWithKey(h) // provider.save + provider.secret.set
    value(await h.port.setDefault({ profileId: 'luna' }, ops))
    value(
      await h.port.assign(
        { node: 'beta-1', assignment: { mode: 'inherit' } },
        ops,
      ),
    )
    value(
      await h.port.setContextOverride({ node: 'beta-1', tokens: 300_000 }, ops),
    )
    value(
      await h.port.setContextOverride({ node: 'beta-1', tokens: null }, ops),
    )
    const rotated = value(
      await h.port.clearSecret(
        { profileId: 'luna', keyId: 'k1', ifMatch: saved.revision },
        ops,
      ),
    )
    const withKey = value(
      await h.port.setSecret(
        {
          profileId: 'luna',
          keyId: 'k1',
          value: CANARY_2,
          ifMatch: rotated.revision,
        },
        ops,
      ),
    )
    value(await h.port.apply({ nodes: ['beta-1'] }, ops))
    value(await h.port.apply({ nodes: ['beta-1'], force: true }, ops))
    for (const mode of ['auth', 'latency', 'call'] as const) {
      value(
        await h.port.probe(
          { node: 'beta-1', mode, candidate: { profileId: 'luna' } },
          ops,
        ),
      )
    }
    value(await h.port.autocompact({ node: 'beta-1', value: 150_000 }, ops))
    const exported = value(await h.port.exportProfiles(['luna']))
    const text = exported.text.replace('"id": "luna"', '"id": "luna-copy"')
    value(await h.port.importProfiles({ text }, ops))
    value(
      await h.port.saveProfile(
        { profile: draft({ id: 'spare', name: '备用' }), ifMatch: null },
        ops,
      ),
    )
    value(await h.port.deleteProfile({ profileId: 'spare', ifMatch: 1 }, ops))

    // Reads write nothing.
    await h.port.overview()
    await h.port.node('beta-1')
    await h.port.models({ node: 'beta-1' }, ops)
    await h.port.autocompact({ node: 'beta-1' }, ops)
    await h.port.apply({ nodes: ['beta-1'], dryRun: true }, ops)
    void withKey

    const records = await entries(h)
    const counts = new Map<string, number>()
    for (const record of records) {
      counts.set(record.action, (counts.get(record.action) ?? 0) + 1)
    }
    // `provider.probe.skip` is the console route's own line (跳过测连,
    // `packages/console/src/routes/providers.ts`); the port has no such step,
    // and its verb type says so: `typecheck` fails if this line compiles.
    // @ts-expect-error — not a verb the port may write
    const routeOnly: ProviderActionName = 'provider.probe.skip'
    void routeOnly
    const verbs = CONSOLE_ACTIONS.filter(
      action =>
        action.startsWith('provider.') && action !== 'provider.probe.skip',
    )
    // Two saves (luna, spare); one key filled in with the luna save plus one
    // set on its own; every other verb once.
    const twice = new Set(['provider.save', 'provider.secret.set'])
    for (const verb of verbs) {
      expect([verb, counts.get(verb)]).toEqual([verb, twice.has(verb) ? 2 : 1])
    }
    expect(records).toHaveLength(verbs.length + twice.size)
    for (const record of records) {
      expect(record.subject).toBe(OPS)
      expect(['luna', 'luna-copy', 'spare', 'beta-1']).toContain(record.target)
      expect(record.outcome).toBe('ok')
    }
  }, 30_000)

  test('apply records what each node answered: ok, refused (conflict / busy), failed (unreachable)', async () => {
    const h = harness()
    const ops = h.caller()
    await savedWithKey(h)
    value(await h.port.setDefault({ profileId: 'luna' }, ops))
    h.nodes['beta-4'].set(
      'reply-apply.json',
      JSON.stringify({
        v: 1,
        requestId: 'x',
        ok: false,
        code: 'busy',
        message: '另一次下发正在进行',
      }),
    )
    let results = value(await h.port.apply({}, ops))
    expect(
      results.map(result => [result.node, result.outcome, result.code]),
    ).toEqual([
      ['beta-1', 'ok', undefined],
      ['beta-4', 'refused', 'busy'],
    ])
    h.nodes['beta-4'].set(
      'reply-apply.json',
      JSON.stringify({
        v: 1,
        requestId: 'x',
        ok: false,
        code: 'conflict',
        message: '被改过',
        // P18.7 names keys by their place in settings.json; bare env names
        // are taken too.
        diffKeys: [
          'env.OPENAI_BASE_URL',
          'modelType',
          'modelSettings.default',
          'OPENAI_MODEL',
          'env.OPENAI_MODEL',
          'lower-case-dropped',
          'env.lower',
          'modelSettings.BAD',
          'other.OPENAI_API_KEY',
        ],
      }),
    )
    results = value(await h.port.apply({ nodes: ['beta-4'] }, ops))
    expect(results[0]?.outcome).toBe('refused')
    expect(results[0]?.code).toBe('conflict')
    expect(results[0]?.diffKeys).toEqual([
      'OPENAI_BASE_URL',
      'modelType',
      'modelSettings.default',
      'OPENAI_MODEL',
    ])
    h.nodes['beta-4'].set('raw-apply', '2\n')
    results = value(await h.port.apply({ nodes: ['beta-4'] }, ops))
    expect(results[0]?.outcome).toBe('failed')
    expect(results[0]?.code).toBe('unreachable')

    const applies = (await entries(h)).filter(
      record => record.action === 'provider.apply',
    )
    expect(
      applies.map(record => [record.target, record.outcome, record.code]),
    ).toEqual([
      ['beta-1', 'ok', undefined],
      ['beta-4', 'refused', 'busy'],
      ['beta-4', 'refused', 'conflict'],
      ['beta-4', 'failed', 'unreachable'],
    ])
  }, 30_000)
})

describe('D-8: the context window', () => {
  test('no contextTokens compiles 200 000; the node override wins; clearing it returns to the profile value', async () => {
    const h = harness()
    const ops = h.caller()
    await savedWithKey(h)
    value(await h.port.setDefault({ profileId: 'luna' }, ops))
    const node = h.nodes['beta-1']

    value(await h.port.apply({ nodes: ['beta-1'] }, ops))
    let wire = received(node, 'apply').at(-1)
    expect(wire?.models[0]?.contextTokens).toBeUndefined()
    expect(wire === undefined ? null : compiledDefaultContext(wire)).toBe(
      200_000,
    )

    value(
      await h.port.setContextOverride({ node: 'beta-1', tokens: 300_000 }, ops),
    )
    const view = value(await h.port.node('beta-1'))
    expect(view.contextOverride).toBe(300_000)
    expect(view.expected?.contextOverride).toBe(300_000)
    value(await h.port.apply({ nodes: ['beta-1'] }, ops))
    wire = received(node, 'apply').at(-1)
    expect(wire === undefined ? null : compiledDefaultContext(wire)).toBe(
      300_000,
    )

    // The profile names its own window; the override still wins.
    const current = value(await h.port.profile('luna'))
    const models = current.models.map(model => ({
      ...model,
      contextTokens: 400_000,
    }))
    value(
      await h.port.saveProfile(
        { profile: { ...draft(), models }, ifMatch: current.revision },
        ops,
      ),
    )
    value(await h.port.apply({ nodes: ['beta-1'] }, ops))
    wire = received(node, 'apply').at(-1)
    expect(wire === undefined ? null : compiledDefaultContext(wire)).toBe(
      300_000,
    )

    // Cleared: back to the profile's value.
    value(
      await h.port.setContextOverride({ node: 'beta-1', tokens: null }, ops),
    )
    value(await h.port.apply({ nodes: ['beta-1'] }, ops))
    wire = received(node, 'apply').at(-1)
    expect(wire === undefined ? null : compiledDefaultContext(wire)).toBe(
      400_000,
    )

    // The hub's own preview agrees, with and without the node.
    value(
      await h.port.setContextOverride({ node: 'beta-1', tokens: 250_000 }, ops),
    )
    const preview = value(
      await h.port.preview({
        candidate: { profileId: 'luna' },
        node: 'beta-1',
      }),
    )
    expect(preview.modelSettings.default?.contextTokens).toBe(250_000)
    const plain = value(
      await h.port.preview({ candidate: { profileId: 'luna' } }),
    )
    expect(plain.modelSettings.default?.contextTokens).toBe(400_000)
  }, 30_000)

  test('the override only touches the main model; an out-of-range one is refused', async () => {
    const h = harness()
    const ops = h.caller()
    value(
      await h.port.saveProfile(
        {
          profile: draft({
            models: [
              {
                id: 'main-model',
                role: 'main',
                tiers: ['opus', 'sonnet', 'fable'],
                capabilities: { mode: 'family' },
                effort: { send: 'auto' },
              },
              {
                id: 'fast-model',
                role: 'fast',
                tiers: ['haiku'],
                capabilities: { mode: 'family' },
                effort: { send: 'auto' },
              },
            ],
          }),
          ifMatch: null,
          secrets: { k1: CANARY },
        },
        ops,
      ),
    )
    value(await h.port.setDefault({ profileId: 'luna' }, ops))
    value(
      await h.port.setContextOverride({ node: 'beta-1', tokens: 500_000 }, ops),
    )
    const preview = value(
      await h.port.preview({
        candidate: { profileId: 'luna' },
        node: 'beta-1',
      }),
    )
    expect(preview.modelSettings.default?.contextTokens).toBe(500_000)
    expect(preview.modelSettings.opus?.contextTokens).toBe(500_000)
    expect(preview.modelSettings.haiku?.contextTokens).toBe(200_000)
    const refused = await h.port.setContextOverride(
      { node: 'beta-1', tokens: 10 },
      ops,
    )
    expect(refused.ok ? 'ok' : refused.failure.code).toBe('invalid')
  }, 30_000)
})

describe('the canary never leaks', () => {
  test('no return value, ledger, book, export, alarm, error or argv carries the key or a piece of it', async () => {
    const h = harness()
    const ops = h.caller()
    const outputs: unknown[] = []
    const keep = <T>(result: T): T => {
      outputs.push(result)
      return result
    }
    const saved = value(
      keep(
        await h.port.saveProfile(
          { profile: draft(), ifMatch: null, secrets: { k1: CANARY } },
          ops,
        ),
      ),
    )
    keep(await h.port.setDefault({ profileId: 'luna' }, ops))
    keep(
      await h.port.probe(
        { node: 'beta-1', mode: 'auth', candidate: { profileId: 'luna' } },
        ops,
      ),
    )
    keep(
      await h.port.probe(
        {
          node: 'beta-1',
          mode: 'auth',
          candidate: { draft: draft({ id: 'trial' }), secret: CANARY_2 },
        },
        ops,
      ),
    )
    keep(await h.port.apply({}, ops))
    keep(await h.port.apply({ dryRun: true }, ops))
    keep(await h.port.refreshNode('beta-1'))
    keep(await h.port.overview())
    keep(await h.port.profile('luna'))
    keep(
      await h.port.preview({
        candidate: { profileId: 'luna' },
        node: 'beta-1',
      }),
    )
    keep(
      await h.port.models(
        { node: 'beta-1', candidate: { profileId: 'luna' } },
        ops,
      ),
    )
    const exported = value(keep(await h.port.exportProfiles()))
    keep(await h.port.importPreview(exported.text))
    // A node that echoes the key back in its message: the hub redacts it.
    h.nodes['beta-4'].set(
      'reply-apply.json',
      JSON.stringify({
        v: 1,
        requestId: 'x',
        ok: false,
        code: 'bad-value',
        message: `rejected ${CANARY}`,
      }),
    )
    keep(await h.port.apply({ nodes: ['beta-4'] }, ops))
    // Errors that mention the key slot must not mention the key.
    keep(
      await h.port.setSecret(
        {
          profileId: 'luna',
          keyId: 'k1',
          value: `${CANARY} with spaces`,
          ifMatch: saved.revision,
        },
        ops,
      ),
    )
    keep(
      await h.port.importProfiles(
        {
          text: JSON.stringify({
            v: 1,
            kind: 'qianmo-providers',
            profiles: [{ ...draft(), keys: [{ id: 'k1', value: CANARY }] }],
          }),
        },
        ops,
      ),
    )
    const rotated = value(
      keep(
        await h.port.setSecret(
          {
            profileId: 'luna',
            keyId: 'k1',
            value: CANARY_2,
            ifMatch: saved.revision,
          },
          ops,
        ),
      ),
    )
    keep(
      await h.port.clearSecret(
        { profileId: 'luna', keyId: 'k1', ifMatch: rotated.revision },
        ops,
      ),
    )

    const pieces = [CANARY, CANARY_2].flatMap(key => [
      key,
      key.slice(-4),
      key.slice(-8),
      key.slice(15, 27),
    ])
    const surfaces: Record<string, string> = {
      outputs: JSON.stringify(outputs),
      ledger: h.ledgerStore.text ?? '',
      book: readFileSync(h.paths.store, 'utf8'),
      secretsFile: readFileSync(h.paths.secrets, 'utf8'),
      export: exported.text,
      alarms: h.alarms.join('\n'),
      argv: JSON.stringify([
        ...h.nodes['beta-1'].argv(),
        ...h.nodes['beta-4'].argv(),
      ]),
    }
    for (const [name, text] of Object.entries(surfaces)) {
      for (const piece of pieces) {
        expect([name, piece, text.includes(piece)]).toEqual([
          name,
          piece,
          false,
        ])
      }
    }
    // Positive control: the key did go out, on the node's stdin.
    const stdin = JSON.stringify(h.nodes['beta-1'].requests())
    expect(stdin).toContain(CANARY)
    expect(stdin).toContain(CANARY_2)
  }, 30_000)
})

// ─── P18.18: several keys ────────────────────────────────────────────────────

const CANARY_3 = 'sk-test-canary-port-third-Wm62RbY4nS'
const CANARY_ROTATED = 'sk-test-canary-port-rotated-Jt17FeC9q'

function multiKeyDraft(extra: Record<string, unknown> = {}) {
  return draft({
    keys: [{ id: 'k1' }, { id: 'k2' }, { id: 'k3', priority: 1 }],
    keySelection: 'round_robin',
    ...extra,
  })
}

/** The sealed entry of one key, as pieces that would show in the file's bytes. */
function sealedPieces(h: Harness, keyId: string): string[] {
  const entry = (
    JSON.parse(readFileSync(h.paths.secrets, 'utf8')) as {
      entries: Record<string, Record<string, string>>
    }
  ).entries[`luna:${keyId}`]
  return entry === undefined
    ? []
    : [entry.ct, entry.iv, entry.tag, entry.wrappedKey].filter(
        (piece): piece is string => typeof piece === 'string',
      )
}

describe('P18.18: several keys', () => {
  test('an apply delivers every key, primary by priority; only to a node that rotates keys', async () => {
    const h = harness()
    const ops = h.caller()
    value(
      await h.port.saveProfile(
        {
          profile: multiKeyDraft(),
          ifMatch: null,
          secrets: { k1: CANARY, k2: CANARY_2, k3: CANARY_3 },
        },
        ops,
      ),
    )
    value(await h.port.setDefault({ profileId: 'luna' }, ops))
    const node = h.nodes['beta-1']

    // A node that has not said it rotates keys: refused here, nothing sent.
    const refused = value(await h.port.apply({ nodes: ['beta-1'] }, ops))
    expect(refused[0]).toMatchObject({
      outcome: 'refused',
      code: 'unsupported-multi-key',
    })
    expect(node.requests().filter(r => r.op === 'apply')).toHaveLength(0)

    node.set('multi-key', '1')
    await h.port.refreshNode('beta-1')
    const applied = value(await h.port.apply({ nodes: ['beta-1'] }, ops))
    expect(applied[0]?.outcome).toBe('ok')
    const wire = received(node, 'apply').at(-1)
    expect(wire?.keySelection).toBe('round_robin')
    expect(wire?.auth.keys).toEqual([
      { id: 'k1', value: CANARY },
      { id: 'k2', value: CANARY_2 },
      { id: 'k3', value: CANARY_3, priority: 1 },
    ])

    // A probe or a model list still carries the primary only.
    value(
      await h.port.probe(
        { node: 'beta-1', mode: 'auth', candidate: { profileId: 'luna' } },
        ops,
      ),
    )
    expect(received(node, 'probe').at(-1)?.auth.keys).toEqual([
      { id: 'k3', value: CANARY_3, priority: 1 },
    ])
  }, 30_000)

  test('status keys: the id, state, return time and reason of each key reach the page; nothing else does', async () => {
    const h = harness()
    const EMPTY = `sha256:${'0'.repeat(64)}`
    const until = '2026-10-04T10:30:00.000Z'
    h.nodes['beta-1'].set(
      'reply-status.json',
      JSON.stringify({
        v: 1,
        requestId: 'x',
        ok: true,
        state: {
          managed: false,
          applied: null,
          onDiskHash: EMPTY,
          appliedHash: null,
          loadedHash: null,
          pending: null,
          resident: null,
          inheritedProviderKeys: [],
          capabilities: { protocol: 1, multiKey: true },
          lastResult: null,
          keys: [
            { id: 'k1', state: 'ok' },
            // A value or a fingerprint a node should never send: dropped.
            {
              id: 'k2',
              state: 'cooling',
              until,
              reason: 'rate-limit',
              value: CANARY,
              fingerprint: 'fp1:0123456789abcdef0123456789abcdef',
            },
            { id: 'k3', state: 'dead', reason: 'revoked', until },
            // Not shaped like a key: dropped whole.
            { id: 'K 4', state: 'ok' },
            { id: 'k5', state: 'resting' },
            'k6',
            // An `ok` key has no reason to be out.
            { id: 'k7', state: 'ok', reason: 'auth' },
            { id: 'k8', state: 'cooling', until: 'soon', reason: 'sideways' },
          ],
        },
      }),
    )
    const view = value(await h.port.refreshNode('beta-1'))
    expect(view.actual?.keys).toEqual([
      { id: 'k1', state: 'ok' },
      { id: 'k2', state: 'cooling', until, reason: 'rate-limit' },
      { id: 'k3', state: 'dead', reason: 'revoked' },
      { id: 'k7', state: 'ok' },
      { id: 'k8', state: 'cooling' },
    ])
    expect(JSON.stringify(view)).not.toContain(CANARY)
    expect(JSON.stringify(view)).not.toContain('fp1:')

    // A single-key node reports none, and the view has no `keys` at all.
    h.nodes['beta-4'].set('multi-key', '1')
    const single = value(await h.port.refreshNode('beta-4'))
    expect(single.actual).not.toBeNull()
    expect(single.actual !== null && 'keys' in single.actual).toBe(false)
  }, 30_000)

  test('a key that is not filled in: secret-missing, naming it, nothing sent', async () => {
    const h = harness()
    const ops = h.caller()
    value(
      await h.port.saveProfile(
        {
          profile: multiKeyDraft(),
          ifMatch: null,
          secrets: { k1: CANARY, k3: CANARY_3 },
        },
        ops,
      ),
    )
    value(await h.port.setDefault({ profileId: 'luna' }, ops))
    h.nodes['beta-1'].set('multi-key', '1')
    await h.port.refreshNode('beta-1')
    const result = value(await h.port.apply({ nodes: ['beta-1'] }, ops))
    expect(result[0]).toMatchObject({
      outcome: 'refused',
      code: 'secret-missing',
      message: '密钥 k2 还没有填写 · 先填写',
    })
    expect(
      h.nodes['beta-1'].requests().filter(r => r.op === 'apply'),
    ).toHaveLength(0)
  }, 30_000)

  test('rotating one key, then removing one: the old ciphertext is gone byte for byte, and the next apply carries the new set', async () => {
    const h = harness()
    const ops = h.caller()
    const saved = value(
      await h.port.saveProfile(
        {
          profile: multiKeyDraft(),
          ifMatch: null,
          secrets: { k1: CANARY, k2: CANARY_2, k3: CANARY_3 },
        },
        ops,
      ),
    )
    value(await h.port.setDefault({ profileId: 'luna' }, ops))
    const oldK2 = sealedPieces(h, 'k2')
    const oldK3 = sealedPieces(h, 'k3')
    expect(oldK2).toHaveLength(4)
    expect(oldK3).toHaveLength(4)
    const holds = (piece: string) =>
      readFileSync(h.paths.secrets).includes(Buffer.from(piece))
    for (const piece of [...oldK2, ...oldK3]) expect(holds(piece)).toBe(true)

    const rotated = value(
      await h.port.setSecret(
        {
          profileId: 'luna',
          keyId: 'k2',
          value: CANARY_ROTATED,
          ifMatch: saved.revision,
        },
        ops,
      ),
    )
    for (const piece of oldK2) expect(holds(piece)).toBe(false)

    const removedK3 = sealedPieces(h, 'k3')
    value(
      await h.port.saveProfile(
        {
          profile: multiKeyDraft({
            keys: rotated.keys.filter(key => key.id !== 'k3'),
          }),
          ifMatch: rotated.revision,
        },
        ops,
      ),
    )
    for (const piece of [...oldK3, ...removedK3]) {
      expect(holds(piece)).toBe(false)
    }
    expect(sealedPieces(h, 'k3')).toEqual([])
    const bytes = readFileSync(h.paths.secrets)
    for (const key of [CANARY, CANARY_2, CANARY_3, CANARY_ROTATED]) {
      expect(bytes.includes(Buffer.from(key))).toBe(false)
    }

    h.nodes['beta-1'].set('multi-key', '1')
    await h.port.refreshNode('beta-1')
    value(await h.port.apply({ nodes: ['beta-1'] }, ops))
    expect(received(h.nodes['beta-1'], 'apply').at(-1)?.auth.keys).toEqual([
      { id: 'k1', value: CANARY },
      { id: 'k2', value: CANARY_ROTATED },
    ])
  }, 30_000)

  test('AC-P2 canary, several keys: no return value, ledger, book, secrets file, export, alarm or argv carries any of them', async () => {
    const h = harness()
    const ops = h.caller()
    const outputs: unknown[] = []
    const keep = <T>(result: T): T => {
      outputs.push(result)
      return result
    }
    const saved = value(
      keep(
        await h.port.saveProfile(
          {
            profile: multiKeyDraft(),
            ifMatch: null,
            secrets: { k1: CANARY, k2: CANARY_2, k3: CANARY_3 },
          },
          ops,
        ),
      ),
    )
    keep(await h.port.setDefault({ profileId: 'luna' }, ops))
    for (const name of ['beta-1', 'beta-4'] as const) {
      h.nodes[name].set('multi-key', '1')
      keep(await h.port.refreshNode(name))
    }
    keep(await h.port.apply({ nodes: ['beta-1'] }, ops))
    keep(await h.port.apply({ nodes: ['beta-1'], dryRun: true }, ops))
    // A node that echoes every key back: the hub redacts all of them.
    h.nodes['beta-4'].set(
      'reply-apply.json',
      JSON.stringify({
        v: 1,
        requestId: 'x',
        ok: false,
        code: 'bad-value',
        message: `rejected ${CANARY} ${CANARY_2} ${CANARY_3}`,
      }),
    )
    keep(await h.port.apply({ nodes: ['beta-4'] }, ops))
    keep(
      await h.port.preview({
        candidate: { profileId: 'luna' },
        node: 'beta-1',
      }),
    )
    keep(
      await h.port.probe(
        { node: 'beta-1', mode: 'auth', candidate: { profileId: 'luna' } },
        ops,
      ),
    )
    keep(await h.port.overview())
    keep(await h.port.profile('luna'))
    keep(await h.port.node('beta-1'))
    const rotated = value(
      keep(
        await h.port.setSecret(
          {
            profileId: 'luna',
            keyId: 'k2',
            value: CANARY_ROTATED,
            ifMatch: saved.revision,
          },
          ops,
        ),
      ),
    )
    keep(
      await h.port.saveProfile(
        {
          profile: multiKeyDraft({
            keys: rotated.keys.filter(key => key.id !== 'k3'),
          }),
          ifMatch: rotated.revision,
        },
        ops,
      ),
    )
    keep(await h.port.apply({ nodes: ['beta-1'] }, ops))
    const exported = value(keep(await h.port.exportProfiles()))

    const pieces = [CANARY, CANARY_2, CANARY_3, CANARY_ROTATED].flatMap(key => [
      key,
      key.slice(-8),
      key.slice(15, 27),
    ])
    const surfaces: Record<string, string> = {
      outputs: JSON.stringify(outputs),
      ledger: h.ledgerStore.text ?? '',
      book: readFileSync(h.paths.store, 'utf8'),
      secretsFile: readFileSync(h.paths.secrets, 'utf8'),
      export: exported.text,
      alarms: h.alarms.join('\n'),
      argv: JSON.stringify([
        ...h.nodes['beta-1'].argv(),
        ...h.nodes['beta-4'].argv(),
      ]),
    }
    for (const [name, text] of Object.entries(surfaces)) {
      for (const piece of pieces) {
        expect([name, piece, text.includes(piece)]).toEqual([
          name,
          piece,
          false,
        ])
      }
    }
    // Positive control: every key did go out, on the nodes' stdin.
    const stdin = JSON.stringify([
      ...h.nodes['beta-1'].requests(),
      ...h.nodes['beta-4'].requests(),
    ])
    for (const key of [CANARY, CANARY_2, CANARY_3, CANARY_ROTATED]) {
      expect(stdin).toContain(key)
    }
  }, 30_000)
})

describe('the desired state against the node', () => {
  test('expect.ownedHash is the hash the node reported for OUR last commit, never a fresh read', async () => {
    const h = harness()
    const ops = h.caller()
    await savedWithKey(h)
    value(await h.port.setDefault({ profileId: 'luna' }, ops))
    const node = h.nodes['beta-1']
    node.set('strict-expect', '1')
    value(await h.port.apply({ nodes: ['beta-1'] }, ops))
    value(await h.port.apply({ nodes: ['beta-1'] }, ops))
    const applies = node.requests().filter(request => request.op === 'apply')
    expect((applies[0]?.expect as { ownedHash: unknown }).ownedHash).toBeNull()
    const second = (applies[1]?.expect as { ownedHash: unknown }).ownedHash
    expect(typeof second).toBe('string')
    expect(String(second)).toMatch(/^sha256:[0-9a-f]{64}$/)

    // A console whose book does not know the node sends null; the node refuses.
    rmSync(h.paths.store)
    const fresh = h.reopen()
    value(
      await fresh.saveProfile(
        { profile: draft(), ifMatch: null, secrets: { k1: CANARY } },
        ops,
      ),
    )
    value(await fresh.setDefault({ profileId: 'luna' }, ops))
    const [refused] = value(await fresh.apply({ nodes: ['beta-1'] }, ops))
    expect(refused?.code).toBe('conflict')
    const [forced] = value(
      await fresh.apply({ nodes: ['beta-1'], force: true }, ops),
    )
    expect(forced?.outcome).toBe('ok')
  }, 30_000)

  test('drift: unmanaged before the first apply, nothing after, out-of-sync after an override', async () => {
    const h = harness()
    const ops = h.caller()
    await savedWithKey(h)
    value(await h.port.setDefault({ profileId: 'luna' }, ops))
    let view = value(await h.port.refreshNode('beta-1'))
    expect(view.drift.map(item => item.kind)).toEqual(['unmanaged'])
    value(await h.port.apply({ nodes: ['beta-1'] }, ops))
    view = value(await h.port.node('beta-1'))
    expect(view.drift).toEqual([])
    expect(view.actual?.applied?.profileId).toBe('luna')
    value(
      await h.port.setContextOverride({ node: 'beta-1', tokens: 300_000 }, ops),
    )
    view = value(await h.port.node('beta-1'))
    expect(view.drift.map(item => item.kind)).toEqual(['out-of-sync'])
    expect(view.recent[0]?.kind).toBe('apply')
  }, 30_000)

  test('a node whose model comes from its start-up environment shows no effective — neither an old one nor a new one', async () => {
    // Each refresh past the 5 s throttle.
    let clock = Date.now()
    const h = harness({ now: () => (clock += 6_000) })
    const EMPTY = `sha256:${'0'.repeat(64)}`
    const node = h.nodes['beta-1']
    let view = value(await h.port.refreshNode('beta-1'))
    expect(view.actual?.effective?.model).toBe('vendor-model-pro')
    const fromEnv = {
      managed: false,
      applied: null,
      onDiskHash: EMPTY,
      appliedHash: null,
      loadedHash: null,
      pending: null,
      resident: { running: true, generation: 1, inFlight: 0 },
      inheritedProviderKeys: ['CLAUDE_CODE_USE_OPENAI', 'OPENAI_BASE_URL'],
      capabilities: { protocol: 1 },
      lastResult: null,
    }
    // A node that leaves it out: the one cached from before does not come back.
    node.set(
      'reply-status.json',
      JSON.stringify({ v: 1, requestId: 'x', ok: true, state: fromEnv }),
    )
    view = value(await h.port.refreshNode('beta-1'))
    expect(view.actual?.inheritedProviderKeys).toEqual([
      'CLAUDE_CODE_USE_OPENAI',
      'OPENAI_BASE_URL',
    ])
    expect(view.actual?.effective).toBeUndefined()
    // An older node still computes one from settings.json alone: not taken.
    node.set(
      'reply-status.json',
      JSON.stringify({
        v: 1,
        requestId: 'x',
        ok: true,
        state: fromEnv,
        effective: {
          apiProvider: 'firstParty',
          wire: 'anthropic',
          model: 'claude-sonnet-5',
          wireModel: 'claude-sonnet-5',
          modelSettingsSlot: null,
          effortOnWire: true,
          effortLevel: 'xhigh',
          contextTokens: 200_000,
        },
      }),
    )
    view = value(await h.port.refreshNode('beta-1'))
    expect(view.actual?.effective).toBeUndefined()
    // Nothing inherited: what the node computed is what its child runs.
    node.set(
      'reply-status.json',
      JSON.stringify({
        v: 1,
        requestId: 'x',
        ok: true,
        state: { ...fromEnv, inheritedProviderKeys: [] },
        effective: {
          apiProvider: 'firstParty',
          wire: 'anthropic',
          model: 'claude-sonnet-5',
          wireModel: 'claude-sonnet-5',
          modelSettingsSlot: null,
          effortOnWire: true,
          effortLevel: 'xhigh',
          contextTokens: 200_000,
        },
      }),
    )
    view = value(await h.port.refreshNode('beta-1'))
    expect(view.actual?.effective?.model).toBe('claude-sonnet-5')
  }, 30_000)

  test('assign unmanaged stops managing only on the hub side', async () => {
    const h = harness()
    const ops = h.caller()
    await savedWithKey(h)
    value(await h.port.setDefault({ profileId: 'luna' }, ops))
    const view = value(
      await h.port.assign(
        { node: 'beta-1', assignment: { mode: 'unmanaged' } },
        ops,
      ),
    )
    expect(view.expected).toBeNull()
    const [result] = value(await h.port.apply({ nodes: ['beta-1'] }, ops))
    expect(result?.code).toBe('not-managed')
    expect(h.nodes['beta-1'].requests()).toEqual([])
  }, 30_000)
})

describe('D-9: autocompact goes through the protocol', () => {
  test('a value outside AUTO_COMPACT_LIMITS is refused by the protocol parser before the node is asked', async () => {
    const h = harness()
    const ops = h.caller()
    for (const bad of [99_999, 1_000_001, 150_000.5]) {
      const result = await h.port.autocompact(
        { node: 'beta-1', value: bad },
        ops,
      )
      expect(
        result.ok
          ? 'ok'
          : [result.failure.code, result.failure.nodeCode, result.failure.path],
      ).toEqual(['invalid', 'bad-value', 'value'])
    }
    expect(h.nodes['beta-1'].requests()).toEqual([])
    // The refusals are recorded, as refusals.
    const records = (await entries(h)).filter(
      record => record.action === 'provider.autocompact',
    )
    expect(records.map(record => [record.outcome, record.code])).toEqual([
      ['refused', 'bad-value'],
      ['refused', 'bad-value'],
      ['refused', 'bad-value'],
    ])
    // Positive control: the bounds themselves pass and reach the node.
    for (const good of [100_000, 1_000_000, 'auto'] as const) {
      expect(
        (await h.port.autocompact({ node: 'beta-1', value: good }, ops)).ok,
      ).toBe(true)
    }
    // (A write is followed by a status refresh; only the autocompact lines here.)
    expect(
      h.nodes['beta-1']
        .requests()
        .filter(request => request.op === 'autocompact')
        .map(request => [request.op, request.value]),
    ).toEqual([
      ['autocompact', 100_000],
      ['autocompact', 1_000_000],
      ['autocompact', 'auto'],
    ])
  }, 30_000)
})

describe('profiles', () => {
  test('If-Match: a stale revision is a conflict that names the changed fields', async () => {
    const h = harness()
    const ops = h.caller()
    const saved = await savedWithKey(h)
    value(
      await h.port.saveProfile(
        { profile: draft({ name: '改过的名字' }), ifMatch: saved.revision },
        ops,
      ),
    )
    const stale = await h.port.saveProfile(
      {
        profile: draft({ baseUrl: 'https://other.vendor.example/v1' }),
        ifMatch: saved.revision,
      },
      ops,
    )
    expect(stale.ok).toBe(false)
    if (!stale.ok) {
      expect(stale.failure.code).toBe('conflict')
      expect(stale.failure.fields).toContain('baseUrl')
    }
  }, 30_000)

  test('a save keeps the sealed key; the key status is set and never shows a value', async () => {
    const h = harness()
    const ops = h.caller()
    const saved = await savedWithKey(h)
    const resaved = value(
      await h.port.saveProfile(
        { profile: draft({ name: '新名字' }), ifMatch: saved.revision },
        ops,
      ),
    )
    expect(resaved.keys[0]?.fingerprint).toBe(saved.keys[0]?.fingerprint)
    const overview = value(await h.port.overview())
    expect(overview.profiles[0]?.secrets).toEqual([
      { keyId: 'k1', set: true, setAt: expect.any(String) },
    ])
    // The re-bound ciphertext still opens after a restart.
    value(await h.port.setDefault({ profileId: 'luna' }, ops))
    const [result] = value(await h.reopen().apply({ nodes: ['beta-1'] }, ops))
    expect(result?.outcome).toBe('ok')
  }, 30_000)

  test('a profile in use cannot be deleted; an unknown field is refused, not ignored', async () => {
    const h = harness()
    const ops = h.caller()
    const saved = await savedWithKey(h)
    value(await h.port.setDefault({ profileId: 'luna' }, ops))
    const inUse = await h.port.deleteProfile(
      { profileId: 'luna', ifMatch: saved.revision },
      ops,
    )
    expect(inUse.ok ? 'ok' : inUse.failure.code).toBe('in_use')
    const unknown = await h.port.saveProfile(
      { profile: draft({ id: 'other', env: { PATH: '/tmp' } }), ifMatch: null },
      ops,
    )
    expect(unknown.ok ? 'ok' : unknown.failure.code).toBe('invalid')
  }, 30_000)

  test('export carries no key and no fingerprint; import needs a new id for a collision', async () => {
    const h = harness()
    const ops = h.caller()
    await savedWithKey(h)
    const exported = value(await h.port.exportProfiles())
    const doc = JSON.parse(exported.text) as Record<string, unknown>
    expect(Object.keys(doc)).toEqual(['v', 'kind', 'secrets', 'profiles'])
    expect(doc.secrets).toBe('not-included')
    expect(exported.text).not.toContain('fingerprint')
    expect(exported.text).not.toContain('fp1:')
    const preview = value(await h.port.importPreview(exported.text))
    expect(preview.collisions).toEqual(['luna'])
    const clash = await h.port.importProfiles({ text: exported.text }, ops)
    expect(clash.ok ? 'ok' : clash.failure.code).toBe('conflict')
    const imported = value(
      await h.port.importProfiles(
        { text: exported.text, renames: { luna: 'luna-2' } },
        ops,
      ),
    )
    expect(imported[0]?.id).toBe('luna-2')
    expect(imported[0]?.keys).toEqual([{ id: 'k1' }])
    expect(imported[0]?.evaluated).toBe(false)
  }, 30_000)

  test('drafts come from the one catalog', () => {
    const h = harness()
    const catalog = h.port.catalog()
    const first = catalog.presets[0]
    expect(first).toBeDefined()
    const result = h.port.draftFromPreset({ presetId: first?.id ?? '' })
    const view = value(result)
    expect(view.presetId).toBe(first?.id ?? null)
    expect(view.keys).toEqual([{ id: 'k1' }])
    expect(h.port.draftFromPreset({ presetId: 'no-such-preset' }).ok).toBe(
      false,
    )
  })
})

describe('status refreshes respect the dial pacing (v2.47.2)', () => {
  test('past the window a refresh dials nothing and the last good status stands', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qianmo-providers-pace-'))
    roots.push(root)
    const node = fakeNode(join(root, 'node-1'))
    const ssh = fakeSsh(join(root, 'ssh'))
    ssh.forcedCommand(`${node.command} beta-1`)
    const knownHosts = join(root, 'known_hosts')
    writeFileSync(
      knownHosts,
      'node-1.example.test ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl\n',
    )
    let clock = Date.now()
    const port = openConsoleProviders({
      storePath: join(root, 'config', 'providers.ndjson'),
      secretsPath: join(root, 'config', 'provider-secrets.json'),
      keyPath: join(root, 'secrets', 'provider-master.key'),
      knownHostsFile: knownHosts,
      sshBinary: ssh.binary,
      nodes: [
        {
          node: 'beta-1',
          kind: 'ssh',
          user: 'qianmo',
          host: 'node-1.example.test',
          port: 22,
          keyFile: join(root, 'keys', 'beta-1'),
        },
      ],
      onAlarm: () => {},
      scheduler: STILL,
      // The refresh throttle reads this clock; the executor's window reads
      // the real one, so all four refreshes land inside one real window.
      now: () => clock,
    })
    const ats: number[] = []
    for (let i = 0; i < 3; i++) {
      clock += 6_000
      const view = value(await port.refreshNode('beta-1'))
      expect(view.lastStatus).toMatchObject({ ok: true, at: clock })
      ats.push(clock)
    }
    expect(ssh.invocations()).toHaveLength(3)
    clock += 6_000
    const view = value(await port.refreshNode('beta-1'))
    expect(ssh.invocations()).toHaveLength(3)
    expect(view.lastStatus).toEqual({ ok: true, at: ats[2] })
    expect(view.drift.map(d => d.kind)).not.toContain('unreachable')
  }, 30_000)
})
