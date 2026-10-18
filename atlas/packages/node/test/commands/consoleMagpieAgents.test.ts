// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The gateway page's 智能体 section on the hub (P36.5): the fake magpie of
 * `@qianmo/magpie/testing` on loopback, the real model service with a real
 * child process playing each node's model side, and a fake control link that
 * answers the runtime ops in the contract's shapes (`host/runtimes/contract.ts`)
 * the way a node keeps them.
 *
 * What it pins:
 *
 * - an automatic agent gets its runtime family's best model among what its
 *   node's key lets through, never a routing group or a subscription's model;
 *   nothing is sent when that is already what the node has;
 * - upstream changes, a runtime change from the page and switching back to
 *   automatic work it out again; a manual model is never overwritten;
 * - new nodes that follow nothing join magpie through the issuance chain as
 *   `system:magpie`; nodes with a profile of their own, or a tenant's, do not;
 * - a node without the runtime ops is shown and never written to;
 * - only a personal ops account outside break-glass writes.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  MagpieAgentsSnapshot,
  MagpieCaller,
  ProviderCaller,
} from '@qianmo/console'
import { FakeMagpie } from '@qianmo/magpie/testing'
import type { ControlOutcome } from '@qianmo/protocol'
import { systemRecorder } from '../../src/commands/consoleBilling.js'
import {
  ConsoleMagpie,
  magpieLaneAddresses,
} from '../../src/commands/consoleMagpie.js'
import {
  autoModel,
  type ConsoleMagpieAgents,
  joinModel,
} from '../../src/commands/consoleMagpieAgents.js'
import {
  type ConsoleProviders,
  openConsoleProviders,
  type ProviderScheduler,
  SYSTEM_MAGPIE_SUBJECT,
} from '../../src/commands/consoleProviders.js'
import {
  RUNTIME_CATALOG,
  runtimeSpec,
} from '../../src/host/runtimes/catalog.js'
import type {
  AgentRuntimeState,
  NativeExtensionKind,
  NativeExtensionRow,
  NativeExtensionsReply,
  RuntimeVersionRow,
} from '../../src/host/runtimes/contract.js'
import { fakeNode } from './consoleProvidersFakeNode.js'

const OPS = 'u:0123456789abcdef'
const WEB_KEY = 'magpie-web-key-for-tests-0001'
const STILL: ProviderScheduler = { set: () => null, clear: () => {} }
const PROFILE = 'magpie-node-beta-1'

interface FakeAgent {
  readonly agent: string
  runtime: string
  model: string | null
}

interface FakeRuntimeNode {
  readonly kind: 'current' | 'old' | 'down'
  readonly agents: FakeAgent[]
  readonly installed: Set<string>
  /** Has the native extension ops (P36.7); a P36.5 node does not. */
  ext: boolean
  /** Each agent's natively installed items. */
  readonly items: Map<string, NativeExtensionRow[]>
  /** Agents whose official frontend is open. */
  readonly locked: Set<string>
}

/**
 * A node's runtime ops as the contract has them: `runtimes.json` in memory,
 * an agent on a runtime that is not installed reported as falling back to
 * qianmopi with the reason. `hold` keeps an install's answer back until
 * `release` is called.
 */
class FakeLinks {
  readonly nodes = new Map<string, FakeRuntimeNode>()
  readonly writes: string[] = []
  /** Every `runtime.status` and `runtime.versions` a node was asked. */
  readonly reads: string[] = []
  /** Every `runtime.ext.*` a node was asked, lists included. */
  readonly ext: string[] = []
  #held: (() => void) | null = null
  hold = false
  /** `runtime.configure` answers a refusal. */
  refuseConfigure = false
  /** A runtime the node reports as installing on its own (P36.3). */
  installing: string | null = null

  add(
    node: string,
    kind: FakeRuntimeNode['kind'],
    agents: readonly [string, string][] = [],
  ): void {
    this.nodes.set(node, {
      kind,
      agents: agents.map(([agent, runtime]) => ({
        agent,
        runtime,
        model: null,
      })),
      installed: new Set(['dsh', 'claude-code', 'codex']),
      ext: kind === 'current',
      items: new Map(),
      locked: new Set(),
    })
  }

  /**
   * The extension ops as §7.3 has them: a list after every change, the
   * frontend lock, dsh without an MCP command, a repository that is not there.
   */
  async #extension(
    fake: FakeRuntimeNode,
    node: string,
    op: string,
    args: Record<string, unknown>,
    actor: string,
  ): Promise<ControlOutcome> {
    this.ext.push(`${node} ${op} ${JSON.stringify(args)} by ${actor}`)
    if (!fake.ext)
      return { ok: false, code: 'unsupported', message: '不支持此底层操作' }
    const name = String(args['agent'])
    const agent = fake.agents.find(one => one.agent === name)
    if (agent === undefined)
      return { ok: false, code: 'E_AGENT_UNKNOWN', message: '没有这个智能体' }
    const list = (): NativeExtensionsReply => ({
      agent: name,
      runtime: agent.runtime,
      items: fake.items.get(name) ?? [],
      notes: ['项目级配置不加载'],
      openCommand: `qm runtime open ${name}${agent.runtime === 'dsh' ? ' --port 8123' : ''}`,
    })
    if (op === 'runtime.ext.list') return { ok: true, value: list() }
    if (fake.locked.has(name))
      return {
        ok: false,
        code: 'E_RUNTIME_EXT_LOCKED',
        message: '官方前端开着',
      }
    const kind = String(args['kind']) as NativeExtensionKind
    const items = fake.items.get(name) ?? []
    if (op === 'runtime.ext.remove') {
      fake.items.set(
        name,
        items.filter(item => item.kind !== kind || item.name !== args['name']),
      )
      return { ok: true, value: list() }
    }
    if (kind === 'mcp' && agent.runtime === 'dsh')
      return {
        ok: false,
        code: 'E_RUNTIME_EXT_UNSUPPORTED',
        message: 'dsh 没有 MCP 命令',
      }
    if (this.hold)
      await new Promise<void>(resolve => {
        this.#held = resolve
      })
    const source = String(args['source'])
    if (source.includes('missing'))
      return {
        ok: false,
        code: 'E_RUNTIME_EXT_FAILED',
        message: '克隆失败 · 仓库不存在',
      }
    fake.items.set(name, [
      ...items,
      {
        kind,
        name: typeof args['name'] === 'string' ? args['name'] : source,
        version: '1.0.0',
        enabled: true,
        source,
      },
    ])
    // An MCP add answers without the list: the hub reads it again.
    return { ok: true, value: kind === 'mcp' ? { added: true } : list() }
  }

  agent(node: string, agent: string): FakeAgent | undefined {
    return this.nodes.get(node)?.agents.find(one => one.agent === agent)
  }

  release(): void {
    this.#held?.()
    this.#held = null
  }

  #state(node: FakeRuntimeNode, agent: FakeAgent): AgentRuntimeState {
    const spec = runtimeSpec(agent.runtime)
    const there =
      spec?.install.kind === 'builtin' || node.installed.has(agent.runtime)
    return {
      agent: agent.agent,
      configured: {
        runtime: agent.runtime,
        model: agent.model,
        source: 'config',
      },
      effective: { runtime: there ? agent.runtime : 'omp' },
      ...(there
        ? {}
        : {
            reason: { code: 'not-installed', message: '未安装 · npm 没装上' },
          }),
    }
  }

  async request(
    node: string,
    op: string,
    args: Record<string, unknown>,
    actor: string,
  ): Promise<ControlOutcome> {
    const fake = this.nodes.get(node)
    if (op === 'runtime.status' || op === 'runtime.versions')
      this.reads.push(`${node} ${op}`)
    if (fake === undefined || fake.kind === 'down')
      return { ok: false, code: 'unreachable', message: '节点控制链路未连接' }
    if (fake.kind === 'old') {
      if (op === 'runtime.versions')
        return {
          ok: true,
          value: { codex: { version: '0.50.0', managed: true, pinned: false } },
        }
      return { ok: false, code: 'unsupported', message: '不支持此底层操作' }
    }
    if (op.startsWith('runtime.ext.'))
      return this.#extension(fake, node, op, args, actor)
    if (op !== 'runtime.status' && op !== 'runtime.versions')
      this.writes.push(`${node} ${op} ${JSON.stringify(args)} by ${actor}`)
    if (op === 'runtime.status')
      return {
        ok: true,
        value: {
          defaultRuntime: 'dsh',
          agents: fake.agents.map(agent => this.#state(fake, agent)),
        },
      }
    if (op === 'runtime.versions')
      return {
        ok: true,
        value: {
          defaultRuntime: 'dsh',
          runtimes: RUNTIME_CATALOG.map(
            (spec): RuntimeVersionRow => ({
              id: spec.id,
              label: spec.label,
              installed:
                spec.install.kind === 'builtin' || fake.installed.has(spec.id),
              ...(fake.installed.has(spec.id) ? { version: '1.0.0' } : {}),
              installing: this.installing === spec.id,
              verified: spec.verified,
            }),
          ),
        },
      }
    if (op === 'runtime.configure') {
      if (this.refuseConfigure)
        return { ok: false, code: 'E_RUNTIME_BUSY', message: '节点正忙' }
      const agent = this.agent(node, String(args['agent']))
      if (agent === undefined)
        return { ok: false, code: 'E_AGENT_UNKNOWN', message: '没有这个智能体' }
      if (typeof args['runtime'] === 'string') agent.runtime = args['runtime']
      if ('model' in args) agent.model = args['model'] as string | null
      return { ok: true, value: this.#state(fake, agent) }
    }
    const runtime = String(args['runtime'])
    if (op === 'runtime.install') {
      if (this.hold)
        await new Promise<void>(resolve => {
          this.#held = resolve
        })
      fake.installed.add(runtime)
      return { ok: true, value: { runtime, version: '1.0.0' } }
    }
    if (op === 'runtime.remove') {
      const users = fake.agents.filter(one => one.runtime === runtime)
      if (users.length > 0)
        return {
          ok: false,
          code: 'E_RUNTIME_IN_USE',
          message: `${users.map(one => one.agent).join(' ')} 配置在它上面`,
        }
      fake.installed.delete(runtime)
      return { ok: true, value: { runtime } }
    }
    return { ok: false, code: 'unsupported', message: op }
  }
}

let root: string
let fake: FakeMagpie
let links: FakeLinks
let providers: ConsoleProviders
let ledger: string[]
let paths: { state: string; secrets: string; key: string }
let tenants: Map<string, string>
let magpie: ConsoleMagpie | undefined

function caller(overrides: Partial<MagpieCaller> = {}): MagpieCaller {
  return {
    subject: OPS,
    role: 'ops',
    requestId: 'req-1',
    breakGlass: false,
    async record(action, target, outcome, code) {
      ledger.push(`${action} ${target} ${outcome}${code ? ` ${code}` : ''}`)
      return true
    },
    ...overrides,
  }
}

const PCALLER: ProviderCaller = {
  subject: OPS,
  role: 'ops',
  breakGlass: false,
  record: async () => true,
}

function open(now?: () => number): ConsoleMagpie {
  const record = systemRecorder(
    async entry => {
      ledger.push(
        `${entry.subject} ${entry.action} ${entry.target} ${entry.outcome}`,
      )
      return { ok: true }
    },
    Date.now,
    SYSTEM_MAGPIE_SUBJECT,
  )
  magpie = new ConsoleMagpie({
    statePath: paths.state,
    secretsPath: paths.secrets,
    keyPath: paths.key,
    providers,
    ...(now === undefined ? {} : { now }),
    system: {
      caller: providers.systemCaller(record, SYSTEM_MAGPIE_SUBJECT),
      record,
    },
    agents: {
      control: links,
      nodes: () => [...links.nodes.keys()],
      tenantOf: node => {
        const tenant = tenants.get(node) ?? null
        if (tenant === 'unreadable') throw new Error('租户配置不可用')
        return tenant
      },
      waitMs: 20,
      ...(now === undefined ? {} : { now }),
    },
  })
  return magpie
}

function agentsOf(port: ConsoleMagpie): ConsoleMagpieAgents {
  if (port.agents === undefined) throw new Error('no agents section')
  return port.agents
}

async function connected(now?: () => number): Promise<ConsoleMagpie> {
  const port = open(now)
  const result = await port.connect(
    {
      gatewayUrl: fake.gatewayUrl,
      managementUrl: fake.managementUrl,
      managementKey: WEB_KEY,
    },
    caller(),
  )
  if (!result.ok) throw new Error(result.failure.message)
  await agentsOf(port).idle()
  return port
}

async function snapshot(port: ConsoleMagpie): Promise<MagpieAgentsSnapshot> {
  const result = await agentsOf(port).snapshot()
  if (!result.ok) throw new Error(result.failure.message)
  return result.value
}

/** A profile of its own, assigned to beta-2: what the page leaves alone. */
async function ownProfile(): Promise<void> {
  const saved = await providers.saveProfile(
    {
      profile: {
        id: 'luna',
        name: 'Luna',
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
            tiers: ['opus', 'sonnet', 'haiku', 'fable'],
            capabilities: { mode: 'family' },
            effort: { send: 'auto' },
          },
        ],
        evaluated: false,
      },
      ifMatch: null,
      secrets: { k1: 'sk-luna-upstream-0001-abcdef' },
    },
    PCALLER,
  )
  if (!saved.ok) throw new Error(saved.failure.message)
  const assigned = await providers.assign(
    { node: 'beta-2', assignment: { mode: 'profile', profileId: 'luna' } },
    PCALLER,
  )
  if (!assigned.ok) throw new Error(assigned.failure.message)
}

function configures(node = 'beta-1'): string[] {
  return links.writes.filter(line =>
    line.startsWith(`${node} runtime.configure`),
  )
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'qianmo-magpie-agents-'))
  ledger = []
  tenants = new Map()
  magpie = undefined
  fake = await FakeMagpie.start({
    webKey: WEB_KEY,
    providers: [
      {
        id: 'deepseek',
        models: ['deepseek-chat', 'deepseek-v4'],
        key: 'sk-upstream-deepseek-0001',
      },
      {
        id: 'anthropic',
        models: ['claude-sonnet-5', 'claude-opus-5', 'claude-haiku-5'],
      },
      { id: 'openai', models: ['gpt-6', 'gpt-6-mini', 'gpt-6-codex'] },
      {
        id: 'codex',
        models: ['gpt-7-codex'],
        account: { agent: 'codex', user: 'a@example.test', plan: 'pro' },
      },
    ],
    groups: [{ id: 'fast', members: ['openai/gpt-6-mini'] }],
  })
  links = new FakeLinks()
  links.add('beta-1', 'current', [
    ['coder', 'dsh'],
    ['reviewer', 'claude-code'],
    ['builder', 'codex'],
    ['main', 'omp'],
  ])
  links.add('beta-2', 'current', [['coder', 'dsh']])
  // beta-2 runs a P36.5 node: the runtime ops, not the extension ones.
  const p365 = links.nodes.get('beta-2')
  if (p365 !== undefined) p365.ext = false
  links.add('old-1', 'old')
  links.add('down-1', 'down')
  const one = fakeNode(join(root, 'node-1'))
  const two = fakeNode(join(root, 'node-2'))
  providers = openConsoleProviders({
    storePath: join(root, 'config', 'providers.ndjson'),
    secretsPath: join(root, 'config', 'provider-secrets.json'),
    keyPath: join(root, 'keys', 'provider-master.key'),
    knownHostsFile: join(root, 'known_hosts'),
    nodes: [
      { node: 'beta-1', kind: 'local', command: one.command },
      { node: 'beta-2', kind: 'local', command: two.command },
    ],
    scheduler: STILL,
  })
  paths = {
    state: join(root, 'config', 'magpie.json'),
    secrets: join(root, 'config', 'magpie-secrets.json'),
    key: join(root, 'keys', 'magpie-master.key'),
  }
})

afterEach(async () => {
  if (magpie !== undefined) {
    await magpie.agents?.idle()
    magpie.close()
  }
  await fake.stop()
  rmSync(root, { recursive: true, force: true })
})

describe('picking by family', () => {
  test('each runtime gets its family best; groups, subscriptions and qianmopi never', () => {
    const models = [
      'deepseek/deepseek-chat',
      'deepseek/deepseek-v4',
      'anthropic/claude-sonnet-5',
      'anthropic/claude-opus-5',
      'openai/gpt-6',
      'openai/gpt-6-codex',
      'group/fast',
    ]
    const pick = (id: string) => {
      const spec = runtimeSpec(id)
      if (spec === undefined) throw new Error(id)
      return autoModel(spec, models)
    }
    expect(pick('dsh')).toEqual({
      model: 'deepseek/deepseek-v4',
      outOfFamily: false,
    })
    expect(pick('claude-code')).toEqual({
      model: 'anthropic/claude-opus-5',
      outOfFamily: false,
    })
    expect(pick('codex')).toEqual({
      model: 'openai/gpt-6-codex',
      outOfFamily: false,
    })
    expect(pick('omp')).toBeNull()
    // Nothing of its family: another family's best, marked; groups never.
    const dsh = runtimeSpec('dsh')
    if (dsh === undefined) throw new Error('dsh')
    expect(autoModel(dsh, ['group/fast', 'openai/gpt-6'])).toEqual({
      model: 'openai/gpt-6',
      outOfFamily: true,
    })
    expect(autoModel(dsh, ['group/fast'])).toBeNull()
    // A joining node starts on the default runtime's family.
    expect(joinModel(models)).toBe('deepseek/deepseek-v4')
    expect(joinModel(['group/fast'])).toBeNull()
  })

  test('a node that follows nothing joins magpie and every agent gets its family model', async () => {
    const port = await connected()
    expect(configures().sort()).toEqual(
      [
        `beta-1 runtime.configure {"agent":"builder","model":"${PROFILE}/openai/gpt-6-codex"} by magpie`,
        `beta-1 runtime.configure {"agent":"coder","model":"${PROFILE}/deepseek/deepseek-v4"} by magpie`,
        `beta-1 runtime.configure {"agent":"reviewer","model":"${PROFILE}/anthropic/claude-opus-5"} by magpie`,
      ].sort(),
    )
    expect(links.agent('beta-1', 'main')?.model).toBeNull()
    const overview = await providers.overview()
    if (!overview.ok) throw new Error('overview')
    expect(
      overview.value.nodes.map(node => [node.node, node.assignment]),
    ).toEqual([
      ['beta-1', { mode: 'profile', profileId: PROFILE }],
      ['beta-2', { mode: 'profile', profileId: 'magpie-node-beta-2' }],
    ])
    const profile = await providers.profile(PROFILE)
    expect(profile.ok && profile.value.models[0]?.id).toBe(
      'deepseek/deepseek-v4',
    )
    // The hub's own hand, in the ledger under a subject no request can claim.
    expect(ledger).toContain(`system:magpie magpie.autojoin node:beta-1 ok`)
    expect(ledger).toContain(`system:magpie provider.assign beta-1 ok`)
    expect(ledger).toContain(
      `system:magpie runtime.configure qianmo://beta-1/coder ok`,
    )
    // beta-2 followed nothing too; each joins once.
    expect(ledger).toContain(`system:magpie magpie.autojoin node:beta-2 ok`)
    expect(
      ledger.filter(line => line.includes('magpie.autojoin')),
    ).toHaveLength(2)
    expect(readFileSync(paths.state, 'utf8')).toContain('"autoJoin": true')
    void port
  })

  test('nothing is sent again while nothing changed', async () => {
    const port = await connected()
    const before = links.writes.length
    const agents = agentsOf(port)
    agents.changed()
    await agents.idle()
    const checked = await port.check(caller())
    expect(checked.ok).toBe(true)
    await agents.idle()
    expect(links.writes.length).toBe(before)
  })

  test('a new upstream is worked in at the next check', async () => {
    const port = await connected()
    fake.addProvider({ id: 'ds2', models: ['deepseek-v5'] })
    const checked = await port.check(caller())
    expect(checked.ok).toBe(true)
    await agentsOf(port).idle()
    expect(links.agent('beta-1', 'coder')?.model).toBe(
      `${PROFILE}/ds2/deepseek-v5`,
    )
    expect(links.agent('beta-1', 'reviewer')?.model).toBe(
      `${PROFILE}/anthropic/claude-opus-5`,
    )
  })

  test('the snapshot names models by family and marks the automatic pick', async () => {
    const port = await connected()
    const value = await snapshot(port)
    expect(value.autoJoin).toBe(true)
    expect(value.connected).toBe(true)
    expect(value.catalog.map(one => one.id)).toEqual(
      RUNTIME_CATALOG.map(spec => spec.id),
    )
    expect(value.catalog.find(one => one.id === 'omp')?.label).toBe('qianmopi')
    const node = value.nodes.find(one => one.node === 'beta-1')
    expect(node?.state).toBe('ok')
    expect(node?.gateway).toBe('bound')
    expect(node?.models.map(one => `${one.id} ${one.family ?? '-'}`)).toEqual([
      'deepseek/deepseek-chat DeepSeek',
      'deepseek/deepseek-v4 DeepSeek',
      'anthropic/claude-sonnet-5 Claude',
      'anthropic/claude-opus-5 Claude',
      'anthropic/claude-haiku-5 Claude',
      'openai/gpt-6 GPT',
      'openai/gpt-6-mini GPT',
      'openai/gpt-6-codex GPT',
      'group/fast -',
    ])
    const coder = node?.agents.find(one => one.agent === 'coder')
    expect(coder).toMatchObject({
      runtime: 'dsh',
      effective: 'dsh',
      model: 'deepseek/deepseek-v4',
      choice: { mode: 'auto' },
      pick: 'deepseek/deepseek-v4',
      outOfFamily: false,
      followsNode: false,
      choosable: true,
      reason: null,
      write: null,
    })
    const main = node?.agents.find(one => one.agent === 'main')
    expect(main).toMatchObject({ followsNode: true, choosable: false })
    expect(
      value.nodes.map(one => `${one.node} ${one.state} ${one.gateway}`),
    ).toEqual([
      'beta-1 ok bound',
      'beta-2 ok bound',
      'old-1 old absent',
      'down-1 unreachable absent',
    ])
  })
})

describe('choices from the page', () => {
  test('a manual model is kept through recomputing, and back to automatic recomputes', async () => {
    const port = await connected()
    const agents = agentsOf(port)
    const manual = await agents.configure(
      { node: 'beta-1', agent: 'coder', model: 'openai/gpt-6' },
      caller(),
    )
    if (!manual.ok) throw new Error(manual.failure.message)
    expect(manual.value.choice).toEqual({
      mode: 'manual',
      model: 'openai/gpt-6',
    })
    expect(links.agent('beta-1', 'coder')?.model).toBe(
      `${PROFILE}/openai/gpt-6`,
    )
    expect(readFileSync(paths.state, 'utf8')).toContain('"openai/gpt-6"')
    fake.addProvider({ id: 'ds2', models: ['deepseek-v5'] })
    await port.check(caller())
    await agents.idle()
    expect(links.agent('beta-1', 'coder')?.model).toBe(
      `${PROFILE}/openai/gpt-6`,
    )
    // A routing group is the user's to pick.
    const group = await agents.configure(
      { node: 'beta-1', agent: 'coder', model: 'group/fast' },
      caller(),
    )
    expect(group.ok).toBe(true)
    expect(links.agent('beta-1', 'coder')?.model).toBe(`${PROFILE}/group/fast`)
    const auto = await agents.configure(
      { node: 'beta-1', agent: 'coder', model: 'auto' },
      caller(),
    )
    if (!auto.ok) throw new Error(auto.failure.message)
    expect(auto.value.choice).toEqual({ mode: 'auto' })
    expect(links.agent('beta-1', 'coder')?.model).toBe(
      `${PROFILE}/ds2/deepseek-v5`,
    )
    // The configure the page sent carries the person, not the hub.
    expect(configures().at(-1)).toEndWith(`by ${OPS}`)
  })

  test('a runtime change takes its family model in the same write; qianmopi takes ours back', async () => {
    const port = await connected()
    const agents = agentsOf(port)
    const moved = await agents.configure(
      { node: 'beta-1', agent: 'builder', runtime: 'claude-code' },
      caller(),
    )
    if (!moved.ok) throw new Error(moved.failure.message)
    expect(configures().at(-1)).toBe(
      `beta-1 runtime.configure {"agent":"builder","runtime":"claude-code","model":"${PROFILE}/anthropic/claude-opus-5"} by ${OPS}`,
    )
    expect(moved.value.model).toBe('anthropic/claude-opus-5')
    const omp = await agents.configure(
      { node: 'beta-1', agent: 'builder', runtime: 'qianmopi' },
      caller(),
    )
    expect(omp.ok).toBe(true)
    expect(configures().at(-1)).toBe(
      `beta-1 runtime.configure {"agent":"builder","runtime":"omp","model":null} by ${OPS}`,
    )
    const refused = await agents.configure(
      { node: 'beta-1', agent: 'main', model: 'openai/gpt-6' },
      caller(),
    )
    expect(refused.ok ? 'ok' : refused.failure.code).toBe('invalid')
    const unchanged = links.writes.length
    const same = await agents.configure(
      { node: 'beta-1', agent: 'reviewer', runtime: 'claude-code' },
      caller(),
    )
    expect(same.ok).toBe(true)
    expect(links.writes.length).toBe(unchanged)
  })

  test('a choice the node did not take is not kept for a later check to apply', async () => {
    const port = await connected()
    const agents = agentsOf(port)
    const before = links.agent('beta-1', 'coder')?.model
    links.refuseConfigure = true
    const refused = await agents.configure(
      { node: 'beta-1', agent: 'coder', model: 'openai/gpt-6' },
      caller(),
    )
    expect(refused.ok).toBe(false)
    expect(readFileSync(paths.state, 'utf8')).not.toContain('"openai/gpt-6"')
    links.refuseConfigure = false
    await port.check(caller())
    await agents.idle()
    expect(links.agent('beta-1', 'coder')?.model).toBe(before)
  })

  test('a model the key cannot use, an unknown runtime or agent is refused before the node', async () => {
    const port = await connected()
    const agents = agentsOf(port)
    const before = links.writes.length
    const cases = [
      [
        { node: 'beta-1', agent: 'coder', model: 'codex/gpt-7-codex' },
        'invalid',
      ],
      [{ node: 'beta-1', agent: 'coder', runtime: 'nope' }, 'invalid'],
      [{ node: 'beta-1', agent: 'ghost', model: 'auto' }, 'not_found'],
      [{ node: 'nowhere', agent: 'coder', model: 'auto' }, 'not_found'],
      [{ node: 'old-1', agent: 'coder', model: 'auto' }, 'unsupported'],
      [{ node: 'down-1', agent: 'coder', model: 'auto' }, 'unreachable'],
    ] as const
    for (const [change, code] of cases) {
      const result = await agents.configure(change, caller())
      expect(
        `${JSON.stringify(change)} ${result.ok ? 'ok' : result.failure.code}`,
      ).toBe(`${JSON.stringify(change)} ${code}`)
    }
    expect(links.writes.length).toBe(before)
  })

  test('only a personal ops account outside break-glass writes', async () => {
    const port = await connected()
    const agents = agentsOf(port)
    const before = links.writes.length
    const keys = fake.keys().length
    for (const who of [
      caller({ role: 'viewer' }),
      caller({ role: 'member' }),
      caller({ breakGlass: true }),
      caller({ subject: 'legacy:admin', role: null }),
    ]) {
      const results = await Promise.all([
        agents.configure(
          { node: 'beta-1', agent: 'coder', model: 'openai/gpt-6' },
          who,
        ),
        agents.install({ node: 'beta-1', runtime: 'codex' }, who),
        agents.remove({ node: 'beta-1', runtime: 'codex' }, who),
        agents.setAutoJoin(false, who),
        agents.join('beta-2', who),
      ])
      expect(results.map(one => (one.ok ? 'ok' : one.failure.code))).toEqual([
        'rejected',
        'rejected',
        'rejected',
        'rejected',
        'rejected',
      ])
    }
    expect(links.writes.length).toBe(before)
    expect(fake.keys()).toHaveLength(keys)
    expect((await snapshot(port)).autoJoin).toBe(true)
  })
})

describe('joining magpie', () => {
  test('a node with a profile of its own is left alone; the page joins it by the same chain', async () => {
    await ownProfile()
    const port = await connected()
    const agents = agentsOf(port)
    expect(configures('beta-2')).toEqual([])
    expect(ledger).not.toContain(`system:magpie magpie.autojoin node:beta-2 ok`)
    const value = await snapshot(port)
    expect(value.nodes.find(one => one.node === 'beta-2')?.gateway).toBe(
      'profile',
    )
    const joined = await agents.join('beta-2', caller())
    if (!joined.ok) throw new Error(joined.failure.message)
    expect(joined.value.profileId).toBe('magpie-node-beta-2')
    expect(ledger).toContain('provider.assign beta-2 ok')
    await agents.idle()
    expect(links.agent('beta-2', 'coder')?.model).toBe(
      'magpie-node-beta-2/deepseek/deepseek-v4',
    )
    const again = await agents.join('beta-2', caller())
    expect(again.ok ? 'ok' : again.failure.code).toBe('invalid')
  })

  test('off, a global default or a tenant keeps a node from joining on its own', async () => {
    const port = open()
    const agents = agentsOf(port)
    const off = await agents.setAutoJoin(false, caller())
    expect(off.ok).toBe(true)
    expect(readFileSync(paths.state, 'utf8')).toContain('"autoJoin": false')
    const result = await port.connect(
      {
        gatewayUrl: fake.gatewayUrl,
        managementUrl: fake.managementUrl,
        managementKey: WEB_KEY,
      },
      caller(),
    )
    expect(result.ok).toBe(true)
    await agents.idle()
    expect(fake.keys()).toEqual([])
    // A tenant's node does not take the platform's key on its own.
    tenants.set('beta-2', 'acme')
    const on = await agents.setAutoJoin(true, caller())
    expect(on.ok).toBe(true)
    await agents.idle()
    expect(
      fake.keys().map(key => key.name.split('-').slice(0, 4).join('-')),
    ).toEqual(['qm-node-beta-1'])
    expect(ledger.filter(line => line.includes('magpie.autojoin'))).toEqual([
      'system:magpie magpie.autojoin node:beta-1 ok',
    ])
  })

  test('a node whose tenant cannot be told does not join on its own', async () => {
    tenants.set('beta-1', 'unreadable')
    tenants.set('beta-2', 'acme')
    await connected()
    expect(fake.keys()).toEqual([])
    expect(ledger.some(line => line.includes('magpie.autojoin'))).toBe(false)
  })

  test('with a global default nothing joins on its own', async () => {
    await ownProfile()
    const set = await providers.setDefault({ profileId: 'luna' }, PCALLER)
    expect(set.ok).toBe(true)
    await connected()
    expect(fake.keys()).toEqual([])
    expect(links.writes).toEqual([])
  })

  test('a node off its magpie profile gets the models we wrote taken back', async () => {
    const port = await connected()
    await ownProfile()
    const assigned = await providers.assign(
      { node: 'beta-1', assignment: { mode: 'profile', profileId: 'luna' } },
      PCALLER,
    )
    expect(assigned.ok).toBe(true)
    await port.check(caller())
    await agentsOf(port).idle()
    for (const agent of ['coder', 'reviewer', 'builder'])
      expect(`${agent} ${links.agent('beta-1', agent)?.model}`).toBe(
        `${agent} null`,
      )
  })
})

describe('runtimes on a node', () => {
  test('an install that takes time shows as running, then installed', async () => {
    const port = await connected()
    const agents = agentsOf(port)
    links.nodes.get('beta-1')?.installed.delete('codex')
    links.hold = true
    const started = await agents.install(
      { node: 'beta-1', runtime: 'codex' },
      caller(),
    )
    expect(started).toEqual({
      ok: true,
      value: { node: 'beta-1', runtime: 'codex', state: 'running' },
    })
    const during = (await snapshot(port)).nodes.find(
      one => one.node === 'beta-1',
    )
    expect(during?.runtimes.find(one => one.id === 'codex')).toMatchObject({
      installed: false,
      installing: true,
    })
    const builder = during?.agents.find(one => one.agent === 'builder')
    expect(builder?.effective).toBe('omp')
    expect(builder?.reason?.code).toBe('not-installed')
    const twice = await agents.install(
      { node: 'beta-1', runtime: 'codex' },
      caller(),
    )
    expect(twice.ok ? 'ok' : twice.failure.code).toBe('invalid')
    links.release()
    await agents.idle()
    const after = (await snapshot(port)).nodes.find(
      one => one.node === 'beta-1',
    )
    expect(after?.runtimes.find(one => one.id === 'codex')).toMatchObject({
      installed: true,
      installing: false,
      version: '1.0.0',
    })
    expect(
      links.writes.filter(line => line.includes('runtime.install')),
    ).toEqual([`beta-1 runtime.install {"runtime":"codex"} by ${OPS}`])
  })

  test('removal in use is refused with the node words; built-in and unknown are not sent', async () => {
    const port = await connected()
    const agents = agentsOf(port)
    const inUse = await agents.remove(
      { node: 'beta-1', runtime: 'codex' },
      caller(),
    )
    expect(inUse.ok ? 'ok' : inUse.failure).toEqual({
      code: 'refused',
      message: '节点 · builder 配置在它上面',
    })
    const builtin = await agents.remove(
      { node: 'beta-1', runtime: 'qianmopi' },
      caller(),
    )
    expect(builtin.ok ? 'ok' : builtin.failure.code).toBe('invalid')
    const old = await agents.install(
      { node: 'old-1', runtime: 'codex' },
      caller(),
    )
    expect(old.ok ? 'ok' : old.failure.code).toBe('unsupported')
    expect(
      links.writes.filter(line => !line.includes('runtime.configure')),
    ).toEqual([`beta-1 runtime.remove {"runtime":"codex"} by ${OPS}`])
    const removed = await agents.remove(
      { node: 'beta-2', runtime: 'claude-code' },
      caller(),
    )
    expect(removed).toEqual({
      ok: true,
      value: { node: 'beta-2', runtime: 'claude-code', state: 'done' },
    })
  })

  test('an old node is listed, never written to', async () => {
    const port = await connected()
    const value = await snapshot(port)
    const old = value.nodes.find(one => one.node === 'old-1')
    expect(old).toMatchObject({
      state: 'old',
      agents: [],
      runtimes: [],
      error: null,
    })
    expect(links.writes.some(line => line.startsWith('old-1'))).toBe(false)
    const down = value.nodes.find(one => one.node === 'down-1')
    expect(down?.error).toBe('节点控制链路未连接')
  })
})

describe('polling', () => {
  test('a page polled every 3 s reads runtime.status each time, runtime.versions every 5 minutes or after an install, magpie every 15 s', async () => {
    let clock = Date.now()
    const port = await connected(() => clock)
    const agents = agentsOf(port)
    await snapshot(port)
    await agents.idle()
    const asked = (op: string) =>
      links.reads.filter(line => line === `beta-1 ${op}`).length
    const management = () =>
      fake.requests.filter(
        one => one.target === 'management' && one.path === '/api/providers',
      ).length
    const status = asked('runtime.status')
    const versions = asked('runtime.versions')
    const before = management()
    // A minute of the page following a job: twenty reads.
    for (let i = 0; i < 20; i++) {
      clock += 3_000
      await snapshot(port)
    }
    await agents.idle()
    expect(asked('runtime.status') - status).toBe(20)
    expect(asked('runtime.versions') - versions).toBe(0)
    // magpie's management API: one read of its providers (and groups) per
    // 15 s, not one per poll.
    expect(management() - before).toBeLessThanOrEqual(4)
    // Five minutes on the versions are read again.
    clock += 5 * 60_000
    await snapshot(port)
    expect(asked('runtime.versions') - versions).toBe(1)
    // An install makes them stale at once.
    links.nodes.get('beta-1')?.installed.delete('codex')
    const installed = await agents.install(
      { node: 'beta-1', runtime: 'codex' },
      caller(),
    )
    expect(installed.ok && installed.value.state).toBe('done')
    clock += 3_000
    const after = await snapshot(port)
    expect(asked('runtime.versions') - versions).toBe(2)
    expect(
      after.nodes
        .find(one => one.node === 'beta-1')
        ?.runtimes.find(one => one.id === 'codex')?.installed,
    ).toBe(true)
  })

  test('while a node reports an install in progress, its versions follow the page', async () => {
    let clock = Date.now()
    const port = await connected(() => clock)
    await snapshot(port)
    await agentsOf(port).idle()
    links.installing = 'claude-code'
    clock += 5 * 60_000
    await snapshot(port)
    const asked = () =>
      links.reads.filter(line => line === 'beta-1 runtime.versions').length
    const first = asked()
    clock += 3_000
    await snapshot(port)
    expect(asked()).toBe(first + 1)
    links.installing = null
    clock += 3_000
    await snapshot(port)
    clock += 3_000
    await snapshot(port)
    expect(asked()).toBe(first + 2)
  })
})

describe('gateway lanes', () => {
  test('Gemini joins the lane addresses once a catalog runtime speaks it', () => {
    const base = RUNTIME_CATALOG.filter(spec => !spec.lanes.includes('gemini'))
    const gw = 'https://gw.example.test'
    expect(magpieLaneAddresses(gw, 'anthropic', base)).toEqual({
      'openai-responses': `${gw}/v1`,
      'openai-chat': `${gw}/v1`,
    })
    const first = base[0]
    if (first === undefined) throw new Error('empty catalog')
    const gemini = [
      ...base,
      { ...first, id: 'gemini-x', lanes: ['gemini'] as const },
    ]
    expect(magpieLaneAddresses(gw, 'openai-chat', gemini)).toEqual({
      anthropic: gw,
      'openai-responses': `${gw}/v1`,
      gemini: `${gw}/v1beta`,
    })
  })

  test('a node profile missing a lane address is brought up to date at the check', async () => {
    const port = await connected()
    const profile = await providers.profile(PROFILE)
    if (!profile.ok) throw new Error('profile')
    // The profile as an older hub wrote it: one lane short.
    const saved = await providers.saveProfile(
      {
        profile: {
          id: PROFILE,
          name: 'magpie 节点 beta-1',
          presetId: 'magpie',
          plan: profile.value.plan,
          site: null,
          lane: 'anthropic',
          baseUrl: fake.gatewayUrl,
          laneAddresses: { 'openai-chat': `${fake.gatewayUrl}/v1` },
          models: [
            {
              id: 'deepseek/deepseek-v4',
              role: 'main',
              tiers: ['opus', 'sonnet', 'haiku', 'fable'],
              capabilities: { mode: 'family' },
              effort: { send: 'auto' },
            },
          ],
          auth: { scheme: 'bearer' },
          keys: [{ id: 'gw', label: 'magpie' }],
          evaluated: false,
        },
        ifMatch: profile.value.revision,
      },
      PCALLER,
    )
    if (!saved.ok) throw new Error(saved.failure.message)
    const line = `system:magpie provider.save ${PROFILE} ok`
    const before = ledger.filter(one => one === line).length
    await port.check(caller())
    const after = await providers.profile(PROFILE)
    expect(after.ok && after.value.laneAddresses).toEqual(
      magpieLaneAddresses(fake.gatewayUrl, 'anthropic'),
    )
    expect(ledger.filter(one => one === line)).toHaveLength(before + 1)
    // Up to date: the next check leaves it.
    await port.check(caller())
    expect(ledger.filter(one => one === line)).toHaveLength(before + 1)
  })
})

describe('native extensions (P36.7)', () => {
  function extLines(match: string): string[] {
    return links.ext.filter(line => line.includes(match))
  }

  /** Connected, with every node asked once whether it has the ops. */
  async function probed(now?: () => number): Promise<ConsoleMagpie> {
    const port = await connected(now)
    await snapshot(port)
    await agentsOf(port).idle()
    return port
  }

  test('a node is asked once whether it has the ops; only those that do get a panel', async () => {
    const port = await connected()
    const agents = agentsOf(port)
    expect(links.ext).toEqual([])
    await snapshot(port)
    await agents.idle()
    // One list per node, for its first agent; old and unreachable nodes are not asked.
    expect(links.ext).toEqual([
      'beta-1 runtime.ext.list {"agent":"coder"} by magpie',
      'beta-2 runtime.ext.list {"agent":"coder"} by magpie',
    ])
    const view = await snapshot(port)
    await agents.idle()
    expect(links.ext).toHaveLength(2)
    const beta1 = view.nodes.find(one => one.node === 'beta-1')
    const coder = beta1?.agents.find(one => one.agent === 'coder')?.extensions
    expect(coder?.state).toBe('ok')
    expect(coder?.fresh).toBe(true)
    expect(coder?.openCommand).toBe('qm runtime open coder --port 8123')
    expect(coder?.notes).toEqual(['项目级配置不加载'])
    expect(
      beta1?.agents.find(one => one.agent === 'reviewer')?.extensions?.state,
    ).toBe('unread')
    // The P36.5 node shows nothing extra and is not asked again on a read.
    expect(
      view.nodes
        .find(one => one.node === 'beta-2')
        ?.agents.map(one => one.extensions),
    ).toEqual([null])
    const old = await agents.extensions('beta-2', 'coder')
    expect(old).toEqual({
      ok: false,
      failure: {
        code: 'unsupported',
        message: '节点版本过旧 · 不支持原生扩展',
      },
    })
    expect((await agents.extensions('old-1', 'coder')).ok).toBe(false)
    expect(links.ext).toHaveLength(2)
  })

  test('opening a panel asks the node only when its list is over a minute old', async () => {
    let clock = Date.now()
    const port = await probed(() => clock)
    const agents = agentsOf(port)
    links.nodes.get('beta-1')?.items.set('reviewer', [
      { kind: 'skill', name: 'triage', enabled: true },
      {
        kind: 'plugin',
        name: 'opencode-wakatime',
        enabled: true,
        notLoaded: '常驻运行时不加载',
      },
      {
        kind: 'theme' as NativeExtensionKind,
        name: 'solarized',
        enabled: true,
      },
    ])
    const first = await agents.extensions('beta-1', 'reviewer')
    if (!first.ok) throw new Error(first.failure.message)
    // A kind this hub does not know is left out, not the whole list.
    expect(
      first.value.items.map(
        item => `${item.kind}:${item.name}:${item.notLoaded ?? '-'}`,
      ),
    ).toEqual(['skill:triage:-', 'plugin:opencode-wakatime:常驻运行时不加载'])
    expect(first.value.openCommand).toBe('qm runtime open reviewer')
    expect(extLines('"agent":"reviewer"')).toHaveLength(1)
    await agents.extensions('beta-1', 'reviewer')
    expect(extLines('"agent":"reviewer"')).toHaveLength(1)
    clock += 61_000
    const later = await agents.extensions('beta-1', 'reviewer')
    expect(later.ok && later.value.fresh).toBe(true)
    expect(extLines('"agent":"reviewer"')).toHaveLength(2)
    const ghost = await agents.extensions('beta-1', 'ghost')
    expect(ghost.ok ? null : ghost.failure.code).toBe('not_found')
    const nowhere = await agents.extensions('nowhere-1', 'coder')
    expect(nowhere.ok ? null : nowhere.failure.code).toBe('not_found')
  })

  test('a runtime change drops the agent’s list; another runtime’s list is never shown as its', async () => {
    const port = await probed()
    const agents = agentsOf(port)
    const first = await agents.extensions('beta-1', 'reviewer')
    expect(first.ok && first.value.runtime).toBe('claude-code')
    const moved = await agents.configure(
      { node: 'beta-1', agent: 'reviewer', runtime: 'codex' },
      caller(),
    )
    if (!moved.ok) throw new Error(moved.failure.message)
    expect(moved.value.extensions?.state).toBe('unread')
    const again = await agents.extensions('beta-1', 'reviewer')
    expect(again.ok && again.value.runtime).toBe('codex')
    expect(extLines('"agent":"reviewer"')).toHaveLength(2)
  })

  test('an install goes out as the node takes it, shows running, then lands in the list', async () => {
    const port = await probed()
    const agents = agentsOf(port)
    links.hold = true
    const job = await agents.installExtension(
      {
        node: 'beta-1',
        agent: 'reviewer',
        kind: 'plugin',
        source: 'https://github.com/obra/superpowers.git',
      },
      caller(),
    )
    expect(job).toEqual({
      ok: true,
      value: {
        node: 'beta-1',
        agent: 'reviewer',
        op: 'install',
        kind: 'plugin',
        name: 'https://github.com/obra/superpowers',
        state: 'running',
      },
    })
    expect(links.ext.at(-1)).toBe(
      `beta-1 runtime.ext.install {"agent":"reviewer","kind":"plugin","source":"https://github.com/obra/superpowers"} by ${OPS}`,
    )
    const during = (await snapshot(port)).nodes[0]?.agents.find(
      one => one.agent === 'reviewer',
    )?.extensions
    expect(during?.job).toMatchObject({
      op: 'install',
      kind: 'plugin',
      state: 'running',
    })
    // One change per agent at a time.
    const second = await agents.installExtension(
      {
        node: 'beta-1',
        agent: 'reviewer',
        kind: 'skill',
        source: 'acme/skills',
      },
      caller(),
    )
    expect(second.ok ? null : second.failure.code).toBe('invalid')
    links.release()
    await agents.idle()
    const after = await agents.extensions('beta-1', 'reviewer')
    if (!after.ok) throw new Error(after.failure.message)
    expect(after.value.job).toBeNull()
    expect(after.value.items.map(item => `${item.kind}:${item.name}`)).toEqual([
      'plugin:https://github.com/obra/superpowers',
    ])
    // The node's answer was the list: not asked for it again.
    expect(extLines('"agent":"reviewer"')).toHaveLength(1)
  })

  test('an MCP server goes as a name and a command line; the list is read again after', async () => {
    const port = await probed()
    const agents = agentsOf(port)
    const done = await agents.installExtension(
      {
        node: 'beta-1',
        agent: 'reviewer',
        kind: 'mcp',
        name: 'github',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-github'],
      },
      caller(),
    )
    expect(done.ok && done.value.state).toBe('done')
    await agents.idle()
    expect(extLines('"agent":"reviewer"')).toEqual([
      `beta-1 runtime.ext.install {"agent":"reviewer","kind":"mcp","source":"npx","name":"github","command":"npx","args":["-y","@modelcontextprotocol/server-github"]} by ${OPS}`,
      'beta-1 runtime.ext.list {"agent":"reviewer"} by magpie',
    ])
    const view = await agents.extensions('beta-1', 'reviewer')
    expect(view.ok && view.value.items.map(item => item.name)).toEqual([
      'github',
    ])
    const removed = await agents.removeExtension(
      { node: 'beta-1', agent: 'reviewer', kind: 'mcp', name: 'github' },
      caller(),
    )
    expect(removed.ok && removed.value.state).toBe('done')
    await agents.idle()
    const empty = await agents.extensions('beta-1', 'reviewer')
    expect(empty.ok && empty.value.items).toEqual([])
  })

  test('the node refusals read as the page words them; a late failure stays on the page', async () => {
    const port = await probed()
    const agents = agentsOf(port)
    const mcp = await agents.installExtension(
      {
        node: 'beta-1',
        agent: 'coder',
        kind: 'mcp',
        name: 'docs',
        url: 'https://mcp.example.com/mcp',
      },
      caller(),
    )
    expect(mcp).toEqual({
      ok: false,
      failure: { code: 'unsupported', message: '该底层不支持这类扩展' },
    })
    links.nodes.get('beta-1')?.locked.add('reviewer')
    const locked = await agents.removeExtension(
      { node: 'beta-1', agent: 'reviewer', kind: 'skill', name: 'triage' },
      caller(),
    )
    expect(locked).toEqual({
      ok: false,
      failure: { code: 'refused', message: '该智能体的官方前端正开着' },
    })
    links.nodes.get('beta-1')?.locked.clear()
    links.hold = true
    const late = await agents.installExtension(
      {
        node: 'beta-1',
        agent: 'reviewer',
        kind: 'plugin',
        source: 'acme/missing',
      },
      caller(),
    )
    expect(late.ok && late.value.state).toBe('running')
    links.release()
    await agents.idle()
    const job = (await snapshot(port)).nodes[0]?.agents.find(
      one => one.agent === 'reviewer',
    )?.extensions?.job
    expect(job).toMatchObject({
      op: 'install',
      name: 'acme/missing',
      state: 'failed',
      message: '节点 · 克隆失败 · 仓库不存在',
    })
  })

  test('a source the hub would not send, or a caller who may not write, never reaches the node', async () => {
    const port = await probed()
    const agents = agentsOf(port)
    const before = links.ext.length
    for (const source of [
      'https://gitlab.com/owner/repo',
      'https://user:secret@github.com/owner/repo',
      '../../etc/passwd',
      '--registry=https://evil.example',
    ]) {
      const result = await agents.installExtension(
        { node: 'beta-1', agent: 'coder', kind: 'plugin', source },
        caller(),
      )
      expect(`${source} ${result.ok ? 'ok' : result.failure.code}`).toBe(
        `${source} invalid`,
      )
    }
    const named = await agents.installExtension(
      {
        node: 'beta-1',
        agent: 'coder',
        kind: 'mcp',
        name: 'qm-github',
        command: 'npx',
      },
      caller(),
    )
    expect(named.ok ? null : named.failure.code).toBe('invalid')
    const climbing = await agents.removeExtension(
      { node: 'beta-1', agent: 'coder', kind: 'plugin', name: '../x' },
      caller(),
    )
    expect(climbing.ok ? null : climbing.failure.code).toBe('invalid')
    for (const who of [
      caller({ role: 'viewer' }),
      caller({ breakGlass: true }),
      caller({ subject: 'legacy:admin', role: null }),
    ]) {
      const results = await Promise.all([
        agents.installExtension(
          {
            node: 'beta-1',
            agent: 'coder',
            kind: 'plugin',
            source: 'obra/superpowers',
          },
          who,
        ),
        agents.removeExtension(
          {
            node: 'beta-1',
            agent: 'coder',
            kind: 'plugin',
            name: 'superpowers',
          },
          who,
        ),
      ])
      expect(results.map(one => (one.ok ? 'ok' : one.failure.code))).toEqual([
        'rejected',
        'rejected',
      ])
    }
    expect(links.ext).toHaveLength(before)
  })
})
