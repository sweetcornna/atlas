// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The hub's agent model fields (`harness-backends.md` §11): candidates from
 * every profile delivered to a node, magpie only one of them; each field
 * sent whole as `runtime.configure {agent, fields}`; a node that predates
 * fields gets the model only and the rest waits in the hub; writes only by a
 * personal ops account outside break-glass.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  AgentModelsAgentView,
  AgentModelsSnapshot,
  ConsoleResult,
  MagpieAgentChange,
  MagpieAgentView,
  MagpieCaller,
  ProviderOverview,
  ProviderProfileView,
} from '@qianmo/console'
import type { ControlOutcome } from '@qianmo/protocol'
import {
  type AgentModelsMagpie,
  ConsoleAgentModels,
  profileModelFacts,
} from '../../src/commands/consoleAgentModels.js'
import { RUNTIME_OPS } from '../../src/host/runtimes/contract.js'

const OPS = 'u:0123456789abcdef'
const NOW = 1_700_000_000_000

interface FakeAgent {
  agent: string
  runtime: string
  model: string | null
  effective?: string
  fields?: Record<string, string>
}

/** One node's answers: running agents, or an old or unreachable node. */
type FakeNode = { agents: FakeAgent[] } | 'old' | 'down'

function stateOf(one: FakeAgent): Record<string, unknown> {
  return {
    agent: one.agent,
    configured: {
      runtime: one.runtime,
      model: one.model,
      source: one.model === null ? 'default' : 'config',
      ...(one.fields === undefined ? {} : { fields: { ...one.fields } }),
    },
    effective: {
      runtime: one.runtime,
      ...(one.effective === undefined && one.model === null
        ? {}
        : { model: one.effective ?? one.model }),
    },
  }
}

class FakeControl {
  readonly nodes = new Map<string, FakeNode>()
  readonly writes: { node: string; args: Record<string, unknown> }[] = []
  refuse: { code: string; message: string } | null = null

  async request(
    node: string,
    op: string,
    args: Record<string, unknown>,
  ): Promise<ControlOutcome> {
    const entry = this.nodes.get(node)
    if (entry === undefined || entry === 'down')
      return { ok: false, code: 'unreachable', message: 'no route' }
    if (entry === 'old')
      return { ok: false, code: 'unsupported', message: `unknown op ${op}` }
    if (op === RUNTIME_OPS.status)
      return { ok: true, value: { agents: entry.agents.map(stateOf) } }
    if (op !== RUNTIME_OPS.configure)
      return { ok: false, code: 'unsupported', message: op }
    this.writes.push({ node, args })
    if (this.refuse !== null) return { ok: false, ...this.refuse }
    const agent = entry.agents.find(one => one.agent === args['agent'])
    if (agent === undefined)
      return { ok: false, code: 'E_AGENT_UNKNOWN', message: 'none' }
    if ('model' in args) {
      agent.model = typeof args['model'] === 'string' ? args['model'] : null
      agent.effective = agent.model ?? undefined
    }
    // A node that predates fields drops them, as the real one would.
    if ('fields' in args && agent.fields !== undefined)
      agent.fields = { ...(args['fields'] as Record<string, string>) }
    return { ok: true, value: stateOf(agent) }
  }
}

function chat(
  id: string,
  levels?: ProviderProfileView['models'][number]['effort']['levels'],
  extra: Partial<ProviderProfileView['models'][number]> = {},
): ProviderProfileView['models'][number] {
  return {
    id,
    role: 'main',
    tiers: [],
    capabilities: {
      mode: 'explicit',
      thinking: true,
      adaptive_thinking: false,
      interleaved_thinking: false,
    },
    effort: { send: 'auto', ...(levels === undefined ? {} : { levels }) },
    ...extra,
  }
}

function profile(
  id: string,
  lane: ProviderProfileView['lane'],
  models: ProviderProfileView['models'],
  presetId: string | null = null,
): ProviderProfileView {
  return {
    id,
    revision: 1,
    name: id.toUpperCase(),
    presetId,
    plan: 'paygo',
    site: null,
    lane,
    baseUrl: `https://${id}.example/v1`,
    models,
    auth: { scheme: 'bearer' },
    keys: [],
    evaluated: false,
  }
}

const ANTH = profile('anth', 'anthropic', [
  chat('claude-opus-4-8', ['low', 'medium', 'high', 'xhigh', 'max']),
  chat('claude-sonnet-4-6', ['low', 'medium', 'high', 'max']),
  chat('claude-haiku-4-5', [], {
    capabilities: {
      mode: 'explicit',
      thinking: false,
      adaptive_thinking: false,
      interleaved_thinking: false,
    },
  }),
  chat('nano-banana', undefined, { kind: 'image' }),
])
const OA = profile('oa', 'openai-responses', [
  chat('gpt-5.5', ['low', 'medium', 'high', 'xhigh']),
])
const MAGPIE = profile(
  'magpie-node-osaka-1',
  'anthropic',
  [chat('claude-opus-4-8')],
  'magpie',
)

function overview(
  delivered: Record<string, readonly string[]>,
): ProviderOverview {
  const nodes = Object.entries(delivered).map(([node, ids]) => ({
    node,
    actual: ids[0] === undefined ? null : { applied: { profileId: ids[0] } },
    expected: ids[1] === undefined ? null : { profileId: ids[1], revision: 1 },
  }))
  return {
    revision: 1,
    defaultProfileId: null,
    profiles: [ANTH, OA, MAGPIE].map(one => ({ profile: one, secrets: [] })),
    nodes,
  } as unknown as ProviderOverview
}

let root: string
let control: FakeControl
let now: number
let errors: string[]
let magpieChanges: MagpieAgentChange[]
let magpieOn: boolean

function caller(overrides: Partial<MagpieCaller> = {}): MagpieCaller {
  return {
    subject: OPS,
    role: 'ops',
    requestId: 'req-1',
    breakGlass: false,
    record: async () => true,
    ...overrides,
  }
}

const fakeMagpie: AgentModelsMagpie = {
  async gateways() {
    return {
      defaultProfileId: null,
      platformModels: null,
      nodes: new Map([
        [
          'osaka-1',
          {
            profileId: 'magpie-node-osaka-1',
            assignment: 'bound' as const,
            models: ['claude-opus-4-8', 'claude-haiku-4-5', 'fast-group'],
          },
        ],
      ]),
    }
  },
  async configure(
    change: MagpieAgentChange,
  ): Promise<ConsoleResult<MagpieAgentView>> {
    magpieChanges.push(change)
    const node = control.nodes.get(change.node)
    if (typeof node === 'object') {
      const agent = node.agents.find(one => one.agent === change.agent)
      if (agent !== undefined && change.model !== undefined)
        agent.model =
          change.model === 'auto' ? null : `magpie-node-osaka-1/${change.model}`
    }
    return {
      ok: true,
      value: { agent: change.agent } as unknown as MagpieAgentView,
    }
  },
}

function hub(
  delivered: Record<string, readonly string[]> = {
    'tokyo-1': ['anth', 'oa'],
  },
): ConsoleAgentModels {
  return new ConsoleAgentModels({
    control,
    nodes: () => [...control.nodes.keys()],
    overview: async () => ({ ok: true, value: overview(delivered) }),
    magpie: () => (magpieOn ? fakeMagpie : undefined),
    statePath: join(root, 'console', 'agent-models.json'),
    now: () => now,
    onError: message => errors.push(message),
  })
}

function agentOf(
  read: ConsoleResult<AgentModelsSnapshot>,
  node: string,
  agent: string,
): AgentModelsAgentView {
  if (!read.ok) throw new Error(read.failure.message)
  const found = read.value.nodes
    .find(one => one.node === node)
    ?.agents.find(one => one.agent === agent)
  if (found === undefined) throw new Error(`${node}/${agent} missing`)
  return found
}

function field(view: AgentModelsAgentView, key: string) {
  const found = view.fields.find(one => one.key === key)
  if (found === undefined) throw new Error(`${key} missing`)
  return found
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'qm-agent-models-'))
  control = new FakeControl()
  now = NOW
  errors = []
  magpieChanges = []
  magpieOn = false
  control.nodes.set('tokyo-1', {
    agents: [
      {
        agent: 'coder',
        runtime: 'claude-code',
        model: 'anth/claude-opus-4-8',
        fields: {},
      },
      { agent: 'helper', runtime: 'codex', model: 'oa/gpt-5.5', fields: {} },
      {
        agent: 'main',
        runtime: 'omp',
        model: null,
        effective: 'anth/claude-sonnet-4-6',
        fields: {},
      },
    ],
  })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('snapshot', () => {
  test('fields per runtime, followed tiers and narrowed efforts', async () => {
    const read = await hub().snapshot()
    const coder = agentOf(read, 'tokyo-1', 'coder')
    expect(coder.runtimeLabel).toBe('Claude Code')
    expect(coder.fields.map(one => one.key)).toEqual([
      'model',
      'effort',
      'fable',
      'fable_effort',
      'opus',
      'opus_effort',
      'sonnet',
      'sonnet_effort',
      'haiku',
      'haiku_effort',
    ])
    // Only the sources the runtime can call, chat models only.
    expect(coder.sources.map(one => one.id)).toEqual(['anth'])
    expect(coder.sources[0]?.models).not.toContain('nano-banana')
    expect(coder.source).toBe('anth')
    expect(field(coder, 'model').value).toBe('anth/claude-opus-4-8')
    expect(field(coder, 'effort').levels).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ])
    expect(field(coder, 'haiku').follows).toBe('anth/claude-haiku-4-5')
    expect(field(coder, 'opus').follows).toBe('anth/claude-opus-4-8')
    expect(field(coder, 'fable').follows).toBeNull()
    expect(field(coder, 'haiku').sameSource).toBe(true)
    // A tier's own effort is a magpie gateway thing.
    expect(field(coder, 'opus_effort').locked).toContain('magpie')
    expect(field(coder, 'opus_effort').levels).toEqual([])

    const helper = agentOf(read, 'tokyo-1', 'helper')
    expect(helper.fields.map(one => one.key)).toEqual(['model', 'effort'])
    expect(helper.sources.map(one => one.id)).toEqual(['oa'])
    expect(field(helper, 'effort').levels).toEqual([
      'none',
      'low',
      'medium',
      'high',
      'xhigh',
    ])

    // qianmopi calls any chat profile; unset follows the node's main model.
    const main = agentOf(read, 'tokyo-1', 'main')
    expect(main.runtimeLabel).toBe('qianmopi')
    expect(main.sources.map(one => one.id)).toEqual(['anth', 'oa'])
    expect(field(main, 'model').value).toBe('')
    expect(field(main, 'model').follows).toBe('anth/claude-sonnet-4-6')
    expect(field(main, 'effort').levels).toEqual([
      'none',
      'low',
      'medium',
      'high',
      'max',
    ])
  })

  test('old and unreachable nodes say so and list nothing', async () => {
    control.nodes.set('old-1', 'old')
    control.nodes.set('down-1', 'down')
    const read = await hub().snapshot()
    if (!read.ok) throw new Error('read failed')
    const old = read.value.nodes.find(one => one.node === 'old-1')
    const down = read.value.nodes.find(one => one.node === 'down-1')
    expect(old).toMatchObject({ state: 'old', agents: [], error: null })
    expect(down).toMatchObject({ state: 'unreachable', agents: [] })
    expect(down?.error).toContain('no route')
    expect(read.value.nodes.find(one => one.node === 'tokyo-1')?.fields).toBe(
      true,
    )
  })

  test('profile facts follow the compiler: explicit, family, none', () => {
    expect(profileModelFacts(ANTH, 'claude-haiku-4-5')).toEqual({
      id: 'claude-haiku-4-5',
      reasoning: false,
    })
    expect(profileModelFacts(OA, 'gpt-5.5').efforts).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
    ])
    const family = profile('fam', 'anthropic', [
      { ...chat('x'), capabilities: { mode: 'family' } },
    ])
    expect(profileModelFacts(family, 'x')).toEqual({ id: 'x' })
    expect(profileModelFacts(ANTH, 'unknown')).toEqual({ id: 'unknown' })
  })
})

describe('set', () => {
  test('a field goes to the node whole, and is kept in the hub', async () => {
    const models = hub()
    const set = await models.set(
      {
        node: 'tokyo-1',
        agent: 'coder',
        field: 'haiku',
        value: 'anth/claude-sonnet-4-6',
      },
      caller(),
    )
    expect(set.ok).toBe(true)
    const effort = await models.set(
      { node: 'tokyo-1', agent: 'coder', field: 'effort', value: 'xhigh' },
      caller(),
    )
    expect(effort.ok).toBe(true)
    expect(control.writes.map(one => one.args)).toEqual([
      { agent: 'coder', fields: { haiku: 'anth/claude-sonnet-4-6' } },
      {
        agent: 'coder',
        fields: { haiku: 'anth/claude-sonnet-4-6', effort: 'xhigh' },
      },
    ])
    const path = join(root, 'console', 'agent-models.json')
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      v: 1,
      agents: [
        {
          node: 'tokyo-1',
          agent: 'coder',
          fields: { haiku: 'anth/claude-sonnet-4-6', effort: 'xhigh' },
        },
      ],
    })
    // Clearing one field drops it from the set; the last one drops the row.
    await models.set(
      { node: 'tokyo-1', agent: 'coder', field: 'haiku', value: '' },
      caller(),
    )
    await models.set(
      { node: 'tokyo-1', agent: 'coder', field: 'effort', value: '' },
      caller(),
    )
    expect(control.writes.at(-1)?.args).toEqual({ agent: 'coder', fields: {} })
    expect(JSON.parse(readFileSync(path, 'utf8')).agents).toEqual([])
  })

  test('the model goes as runtime.configure model; empty is default', async () => {
    const models = hub()
    const set = await models.set(
      {
        node: 'tokyo-1',
        agent: 'helper',
        field: 'model',
        value: 'oa/gpt-5.5-mini',
      },
      caller(),
    )
    // A typed id the list lacks is taken: the node compiles any id.
    expect(set.ok).toBe(true)
    const cleared = await models.set(
      { node: 'tokyo-1', agent: 'helper', field: 'model', value: '' },
      caller(),
    )
    expect(cleared.ok).toBe(true)
    expect(control.writes.map(one => one.args)).toEqual([
      { agent: 'helper', model: 'oa/gpt-5.5-mini' },
      { agent: 'helper', model: null },
    ])
    const wrongLane = await models.set(
      {
        node: 'tokyo-1',
        agent: 'helper',
        field: 'model',
        value: 'anth/claude-opus-4-8',
      },
      caller(),
    )
    expect(wrongLane).toMatchObject({ ok: false, failure: { code: 'invalid' } })
    const bad = await models.set(
      { node: 'tokyo-1', agent: 'helper', field: 'model', value: 'gpt-5.5' },
      caller(),
    )
    expect(bad).toMatchObject({ ok: false, failure: { code: 'invalid' } })
    expect(control.writes).toHaveLength(2)
  })

  test('refuses what the runtime or source cannot take', async () => {
    const models = hub()
    const cases: [string, string, string][] = [
      ['coder', 'haiku', 'oa/gpt-5.5'],
      ['coder', 'opus_effort', 'high'],
      ['coder', 'effort', 'none'],
      ['coder', 'small', 'anth/claude-haiku-4-5'],
      ['helper', 'effort', 'max'],
      ['helper', 'haiku', 'oa/gpt-5.5'],
    ]
    for (const [agent, key, value] of cases) {
      const result = await models.set(
        { node: 'tokyo-1', agent, field: key, value },
        caller(),
      )
      expect([agent, key, result.ok]).toEqual([agent, key, false])
      if (!result.ok) expect(result.failure.code).toBe('invalid')
    }
    const missing = await models.set(
      { node: 'tokyo-1', agent: 'nobody', field: 'model', value: '' },
      caller(),
    )
    expect(missing).toMatchObject({ ok: false, failure: { code: 'not_found' } })
    const offLink = await models.set(
      { node: 'paris-1', agent: 'coder', field: 'model', value: '' },
      caller(),
    )
    expect(offLink).toMatchObject({ ok: false, failure: { code: 'not_found' } })
    expect(control.writes).toEqual([])
  })

  test('only a personal ops account outside break-glass writes', async () => {
    const models = hub()
    const change = {
      node: 'tokyo-1',
      agent: 'coder',
      field: 'effort',
      value: 'high',
    }
    for (const who of [
      caller({ role: 'member' }),
      caller({ role: 'viewer' }),
      caller({ breakGlass: true }),
      caller({ subject: 'legacy:admin', role: null }),
    ]) {
      const result = await models.set(change, who)
      expect(result).toMatchObject({ ok: false, failure: { code: 'rejected' } })
    }
    expect(control.writes).toEqual([])
  })

  test('a node refusal comes back with its words and no hub change', async () => {
    const models = hub()
    control.refuse = { code: 'E_RUNTIME_MODEL', message: 'bad effort' }
    const result = await models.set(
      { node: 'tokyo-1', agent: 'coder', field: 'effort', value: 'high' },
      caller(),
    )
    expect(result).toMatchObject({
      ok: false,
      failure: { code: 'invalid', message: '节点 · bad effort' },
    })
    control.refuse = null
    const read = await models.snapshot()
    const coder = agentOf(read, 'tokyo-1', 'coder')
    expect(coder.write).toMatchObject({
      state: 'failed',
      message: 'bad effort',
    })
    expect(field(coder, 'effort').value).toBe('')
  })
})

describe('a node that predates fields', () => {
  beforeEach(() => {
    control.nodes.set('tokyo-1', {
      agents: [
        {
          agent: 'coder',
          runtime: 'claude-code',
          model: 'anth/claude-opus-4-8',
        },
      ],
    })
  })

  test('gets the model only; the rest waits in the hub, marked', async () => {
    const models = hub()
    const effort = await models.set(
      { node: 'tokyo-1', agent: 'coder', field: 'effort', value: 'high' },
      caller(),
    )
    expect(effort.ok).toBe(true)
    if (effort.ok) {
      expect(field(effort.value, 'effort').value).toBe('high')
      expect(field(effort.value, 'effort').pending).toBe(true)
    }
    const model = await models.set(
      {
        node: 'tokyo-1',
        agent: 'coder',
        field: 'model',
        value: 'anth/claude-sonnet-4-6',
      },
      caller(),
    )
    expect(model.ok).toBe(true)
    expect(control.writes.map(one => one.args)).toEqual([
      { agent: 'coder', model: 'anth/claude-sonnet-4-6' },
    ])
    const read = await models.snapshot()
    if (!read.ok) throw new Error('read failed')
    expect(read.value.nodes[0]?.fields).toBe(false)
    const coder = agentOf(read, 'tokyo-1', 'coder')
    expect(field(coder, 'effort')).toMatchObject({
      value: 'high',
      pending: true,
    })
    expect(field(coder, 'model').pending).toBe(false)
  })

  test('once upgraded, the kept fields are sent again, at most every ten minutes', async () => {
    const models = hub()
    await models.set(
      { node: 'tokyo-1', agent: 'coder', field: 'effort', value: 'high' },
      caller(),
    )
    // The node upgrades: it now reports fields, still empty.
    const node = control.nodes.get('tokyo-1')
    if (typeof node !== 'object') throw new Error('node')
    node.agents[0]!.fields = {}
    // A failing resend is said once and not tried again soon.
    control.refuse = { code: 'E_BUSY', message: 'busy' }
    now += 5_000
    await models.snapshot()
    await models.idle()
    expect(control.writes.map(one => one.args)).toEqual([
      { agent: 'coder', fields: { effort: 'high' } },
    ])
    expect(errors.some(one => one.includes('没补发上'))).toBe(true)
    control.refuse = null
    now += 5_000
    await models.snapshot()
    await models.idle()
    expect(control.writes).toHaveLength(1)
    now += 10 * 60_000
    const read = await models.snapshot()
    await models.idle()
    expect(control.writes).toHaveLength(2)
    expect(field(agentOf(read, 'tokyo-1', 'coder'), 'effort').pending).toBe(
      true,
    )
    now += 5_000
    const after = await models.snapshot()
    expect(field(agentOf(after, 'tokyo-1', 'coder'), 'effort')).toMatchObject({
      value: 'high',
      pending: false,
    })
  })

  test('the kept fields survive a hub restart', async () => {
    await hub().set(
      { node: 'tokyo-1', agent: 'coder', field: 'effort', value: 'high' },
      caller(),
    )
    const read = await hub().snapshot()
    expect(field(agentOf(read, 'tokyo-1', 'coder'), 'effort')).toMatchObject({
      value: 'high',
      pending: true,
    })
  })
})

describe('with magpie', () => {
  beforeEach(() => {
    magpieOn = true
    control.nodes.set('osaka-1', {
      agents: [
        {
          agent: 'coder',
          runtime: 'claude-code',
          model: 'magpie-node-osaka-1/claude-opus-4-8',
          fields: {},
        },
        {
          agent: 'main',
          runtime: 'omp',
          model: null,
          effective: 'magpie-node-osaka-1/claude-opus-4-8',
          fields: {},
        },
      ],
    })
  })

  test('the bound profile is one source; its key models are the choices', async () => {
    const read = await hub({
      'tokyo-1': ['anth'],
      'osaka-1': ['anth'],
    }).snapshot()
    const coder = agentOf(read, 'osaka-1', 'coder')
    expect(coder.sources.map(one => [one.id, one.magpie])).toEqual([
      ['anth', false],
      ['magpie-node-osaka-1', true],
    ])
    expect(coder.sources[1]?.models).toEqual([
      'claude-opus-4-8',
      'claude-haiku-4-5',
      'fast-group',
    ])
    // The gateway fixes a tier's effort; qianmopi follows the node there.
    expect(field(coder, 'opus_effort').locked).toBeNull()
    expect(field(coder, 'haiku').follows).toBe(
      'magpie-node-osaka-1/claude-haiku-4-5',
    )
    expect(field(agentOf(read, 'osaka-1', 'main'), 'model').locked).toContain(
      'magpie',
    )
    // Elsewhere nothing changes.
    expect(
      agentOf(read, 'tokyo-1', 'coder').sources.map(one => one.id),
    ).toEqual(['anth'])
  })

  test('the model goes through the gateway section; the rest as fields', async () => {
    const models = hub({ 'osaka-1': ['anth'] })
    const auto = await models.set(
      { node: 'osaka-1', agent: 'coder', field: 'model', value: '' },
      caller(),
    )
    expect(auto.ok).toBe(true)
    const manual = await models.set(
      {
        node: 'osaka-1',
        agent: 'coder',
        field: 'model',
        value: 'magpie-node-osaka-1/claude-haiku-4-5',
      },
      caller(),
    )
    expect(manual.ok).toBe(true)
    const other = await models.set(
      {
        node: 'osaka-1',
        agent: 'coder',
        field: 'model',
        value: 'anth/claude-opus-4-8',
      },
      caller(),
    )
    expect(other).toMatchObject({ ok: false, failure: { code: 'invalid' } })
    expect(magpieChanges).toEqual([
      { node: 'osaka-1', agent: 'coder', model: 'auto' },
      { node: 'osaka-1', agent: 'coder', model: 'claude-haiku-4-5' },
    ])
    const tier = await models.set(
      { node: 'osaka-1', agent: 'coder', field: 'opus_effort', value: 'max' },
      caller(),
    )
    expect(tier.ok).toBe(true)
    expect(control.writes.map(one => one.args)).toEqual([
      { agent: 'coder', fields: { opus_effort: 'max' } },
    ])
  })
})
