// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 智能体模型 (`harness-backends.md` §11): each agent's native model fields as
 * the page draws them (a writer gets the picker, the effort select and the
 * 分档 panel; a reader the values), and the JSON behind them, which works on a
 * console without magpie: `GET /v0/magpie/agents/models` for view and up,
 * `POST /v0/magpie/agents/configure {node, agent, field, value}` for a
 * writer, recorded as `runtime.configure`.
 */

import { beforeEach, describe, expect, test } from 'bun:test'
import type { Access } from '../src/access.js'
import type { ConsoleDeps } from '../src/deps.js'
import type {
  AgentModelChange,
  AgentModelFieldView,
  AgentModelsAgentView,
  AgentModelsPort,
  AgentModelsSnapshot,
  MagpieCaller,
} from '../src/directionPorts.js'
import { magpieRoute } from '../src/routes/magpie.js'
import {
  agentModelsForReader,
  magpieAgentsForReader,
  magpieApi,
} from '../src/routes/magpieApi.js'
import type { RouteContext } from '../src/routes/types.js'
import {
  AGENT_MODELS_FRAGMENT,
  AGENT_MODELS_JS,
  agentModelsMount,
  type AgentModelsSectionModel,
  renderAgentModelsSection,
  tiersSummary,
} from '../src/view/agentModels.js'
import { renderMagpieAgents } from '../src/view/magpieAgents.js'
import { LIMITS } from './accountsHarness.js'
import { FakeMagpieAgents } from './directionFakes.js'

const NOW = 1_700_000_000_000
const SUBJECT = 'u:0123456789abcdef'

function modelField(
  key: string,
  value: string,
  follows: string | null,
  extra: Partial<AgentModelFieldView> = {},
): AgentModelFieldView {
  return {
    key,
    label: key === 'model' ? '模型' : key,
    kind: 'model',
    tier: null,
    value,
    follows,
    levels: [],
    sameSource: key !== 'model',
    locked: null,
    pending: false,
    ...extra,
  }
}

function effortField(
  key: string,
  value: string,
  levels: readonly string[],
  extra: Partial<AgentModelFieldView> = {},
): AgentModelFieldView {
  return {
    key,
    label: key === 'effort' ? '推理强度' : key.replace('_effort', ' 推理强度'),
    kind: 'effort',
    tier: null,
    value,
    follows: null,
    levels,
    sameSource: false,
    locked: null,
    pending: false,
    ...extra,
  }
}

const SOURCES = [
  {
    id: 'anth',
    name: 'Anthropic',
    magpie: false,
    models: ['claude-opus-4-8', 'claude-sonnet-4-6', 'claude-haiku-4-5'],
  },
]

const CODER: AgentModelsAgentView = {
  agent: 'coder',
  runtime: 'claude-code',
  runtimeLabel: 'Claude Code',
  source: 'anth',
  sources: SOURCES,
  write: null,
  fields: [
    modelField('model', 'anth/claude-opus-4-8', 'anth/claude-opus-4-8', {
      sameSource: false,
    }),
    effortField('effort', 'xhigh', ['low', 'medium', 'high', 'xhigh', 'max']),
    modelField('fable', '', null, { tier: 'fable' }),
    effortField('fable_effort', '', [], {
      tier: 'fable',
      locked: '这个来源不认按档强度 · 只有 magpie 网关按档固定强度',
    }),
    modelField('opus', '', 'anth/claude-opus-4-8', { tier: 'opus' }),
    effortField('opus_effort', 'high', ['low', 'medium', 'high'], {
      tier: 'opus',
      pending: true,
    }),
    modelField('sonnet', '', 'anth/claude-opus-4-8', { tier: 'sonnet' }),
    effortField('sonnet_effort', '', [], { tier: 'sonnet' }),
    modelField('haiku', 'anth/claude-sonnet-4-6', 'anth/claude-haiku-4-5', {
      tier: 'haiku',
    }),
    effortField('haiku_effort', 'low', ['low'], { tier: 'haiku' }),
  ],
}

const HELPER: AgentModelsAgentView = {
  agent: 'helper',
  runtime: 'codex',
  runtimeLabel: 'Codex',
  source: null,
  sources: [{ id: 'oa', name: 'OpenAI', magpie: false, models: ['gpt-5.5'] }],
  write: { state: 'failed', at: NOW, message: 'E_RUNTIME_MODEL bad effort' },
  fields: [
    modelField('model', '', 'oa/gpt-5.5', { sameSource: false }),
    effortField('effort', '', ['none', 'low', 'medium', 'high', 'xhigh']),
  ],
}

const SNAPSHOT: AgentModelsSnapshot = {
  nodes: [
    {
      node: 'tokyo-1',
      state: 'ok',
      fields: true,
      agents: [CODER, HELPER],
      error: null,
    },
    { node: 'old-1', state: 'old', fields: false, agents: [], error: null },
    {
      node: 'down-1',
      state: 'unreachable',
      fields: false,
      agents: [],
      error: 'dial tcp 10.0.0.9:22 · timeout',
    },
  ],
}

function section(writer: boolean): string {
  const model: AgentModelsSectionModel = {
    side: { kind: 'ok', value: agentModelsForReader(SNAPSHOT, writer) },
    writer,
    mainAgent: 'qianmo://tokyo-1/coder',
  }
  return renderAgentModelsSection(model)
}

function slice(html: string, from: string, to?: string): string {
  const start = html.indexOf(from)
  if (start < 0) throw new Error(`${from} missing`)
  if (to === undefined) return html.slice(start)
  const end = html.indexOf(to, start + from.length)
  if (end < 0) throw new Error(`${to} missing after ${from}`)
  return html.slice(start, end)
}

describe('the section', () => {
  test('a writer gets the picker, the effort select and the 分档 panel', () => {
    const html = section(true)
    const row = slice(
      html,
      'data-key="am:tokyo-1/coder"',
      'data-key="am:tokyo-1/helper"',
    )
    // Name with 主, runtime, a picker on the main model.
    expect(row).toContain('<span class="kit-mono">coder</span>')
    expect(row).toContain('主')
    expect(row).toContain('<td>Claude Code</td>')
    expect(row).toContain('data-key="am-pick:tokyo-1/coder/model"')
    expect(row).toContain('placeholder="过滤或直接输入模型 id…"')
    const picker = slice(
      row,
      'data-key="am-pick:tokyo-1/coder/model"',
      '</details>',
    )
    // 默认 first, then the source's models under its name.
    const order = [
      '>默认（claude-opus-4-8）</button>',
      '<li class="am-grp" role="presentation">Anthropic</li>',
      'data-value="anth/claude-opus-4-8" aria-selected="true">claude-opus-4-8</button>',
      'data-value="anth/claude-haiku-4-5">claude-haiku-4-5</button>',
    ].map(piece => picker.indexOf(piece))
    expect(order.every(at => at >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    // The effort select speaks words, 默认 first.
    const effort = slice(row, 'data-field="effort"', '</select>')
    expect(effort).toContain('<option value="">默认</option>')
    expect(effort).toContain('<option value="xhigh" selected>超高</option>')
    expect(effort).toContain('<option value="max">最高</option>')
    // 分档: the summary, a row per tier, 同主模型（X） for a following tier.
    expect(row).toContain(
      '分档 · <span data-am-tiers>opus（高） · haiku（低）</span>',
    )
    expect(row).toContain('data-key="am-pick:tokyo-1/coder/opus"')
    expect(row).toContain('>同主模型（claude-opus-4-8）</span>')
    expect(row).toContain('>同主模型（claude-haiku-4-5）</button>')
    expect(row).toContain(
      '<span class="am-cur" data-am-current>claude-sonnet-4-6</span>',
    )
    // A tier offers the main model's source alone.
    expect(row).toContain('data-sources="anth"')
    // A locked tier effort says why; one the node has not taken is marked.
    expect(row).toContain('只有 magpie 网关按档固定强度')
    expect(row).toContain('节点未收到')
    expect(row).toContain('data-am-error="tokyo-1/coder"')
  })

  test('the node heads say what a node can take', () => {
    const html = section(true)
    expect(slice(html, 'am-node:old-1', '</tr>')).toContain('节点版本过旧')
    const down = slice(html, 'am-node:down-1', '</tr>')
    expect(down).toContain('连不上')
    expect(down).toContain('dial tcp 10.0.0.9:22')
    // A failed write shows under its row, the node's words to a writer.
    const helper = slice(html, 'data-key="am:tokyo-1/helper"')
    expect(helper).toContain('下发失败')
    expect(helper).toContain('E_RUNTIME_MODEL bad effort')
    expect(helper).not.toContain('分档')
  })

  test('a reader reads the values and has nothing to change', () => {
    const html = section(false)
    expect(html).not.toContain('am-pick')
    expect(html).not.toContain('name="am-effort"')
    expect(html).not.toContain('dial tcp')
    expect(html).not.toContain('E_RUNTIME_MODEL')
    const row = slice(
      html,
      'data-key="am:tokyo-1/coder"',
      'data-key="am:tokyo-1/helper"',
    )
    expect(row).toContain('<span class="kit-mono">claude-opus-4-8</span>')
    expect(row).toContain('超高')
    expect(row).toContain('分档 · opus（高） · haiku（低）')
    expect(slice(html, 'data-key="am:tokyo-1/helper"')).toContain(
      '默认（gpt-5.5）',
    )
  })

  test('the 分档 summary: the tiers of their own, or 同主模型', () => {
    expect(tiersSummary(CODER)).toBe('opus（高） · haiku（低）')
    const plain: AgentModelsAgentView = {
      ...CODER,
      fields: CODER.fields.map(one =>
        one.key === 'model' || one.key === 'effort'
          ? one
          : { ...one, value: '' },
      ),
    }
    expect(tiersSummary(plain)).toBe('同主模型')
  })

  test('unwired and failed say so; the mount polls the fragment', () => {
    const unwired = renderAgentModelsSection({
      side: { kind: 'unwired' },
      writer: true,
      mainAgent: null,
    })
    expect(unwired).toContain('模型服务与节点控制链路')
    const failed = renderAgentModelsSection({
      side: {
        kind: 'failed',
        failure: { code: 'unreachable', message: '读模型服务失败' },
      },
      writer: true,
      mainAgent: null,
    })
    expect(failed).toContain('读模型服务失败')
    const mount = agentModelsMount({
      side: { kind: 'ok', value: { nodes: [] } },
      writer: false,
      mainAgent: null,
    })
    expect(mount).toContain(`data-poll="${AGENT_MODELS_FRAGMENT}"`)
    expect(mount).toContain('还没有节点')
  })

  test('the script parses, sends one field, and leaves an input method Enter alone', () => {
    expect(() => new Function(AGENT_MODELS_JS)).not.toThrow()
    expect(AGENT_MODELS_JS).toContain("'/v0/magpie/agents/configure'")
    expect(AGENT_MODELS_JS).toContain(
      'node: node, agent: agent, field: field, value: value',
    )
    expect(AGENT_MODELS_JS).toContain(
      'event.isComposing || composing || event.keyCode === 229',
    )
  })
})

describe('in the gateway page agents section', () => {
  async function drawn(runtime: string): Promise<string> {
    const agents = await new FakeMagpieAgents().snapshot()
    if (!agents.ok) throw new Error('snapshot')
    const reviewer: AgentModelsAgentView = {
      ...CODER,
      agent: 'reviewer',
      runtime,
    }
    return renderMagpieAgents({
      side: { kind: 'ok', value: magpieAgentsForReader(agents.value, true) },
      writer: true,
      mainAgent: null,
      models: {
        nodes: [
          {
            node: 'tokyo-1',
            state: 'ok',
            fields: true,
            agents: [reviewer],
            error: null,
          },
        ],
      },
    })
  }

  test('an agent the hub has fields for gets the native controls in its 模型 cell', async () => {
    const html = await drawn('claude-code')
    const reviewer = slice(
      html,
      'data-key="tokyo-1/reviewer"',
      'data-key="tokyo-1/builder"',
    )
    expect(reviewer).toContain('data-key="am-pick:tokyo-1/reviewer/model"')
    expect(reviewer).toContain('分档 · ')
    expect(reviewer).not.toContain('name="mg-model"')
    // The others keep the gateway's own select.
    expect(
      slice(html, 'data-key="tokyo-1/coder"', 'data-key="tokyo-1/reviewer"'),
    ).toContain('name="mg-model"')
  })

  test('a runtime the gateway page just moved keeps its own select', async () => {
    const html = await drawn('codex')
    const reviewer = slice(
      html,
      'data-key="tokyo-1/reviewer"',
      'data-key="tokyo-1/builder"',
    )
    expect(reviewer).not.toContain('am-pick')
    expect(reviewer).toContain('name="mg-model"')
  })
})

// --- the JSON, without magpie ------------------------------------------------

class FakeAgentModels implements AgentModelsPort {
  readonly calls: { change: AgentModelChange; caller: MagpieCaller }[] = []
  answer: 'ok' | 'invalid' = 'ok'
  async snapshot() {
    return { ok: true as const, value: SNAPSHOT }
  }
  async set(change: AgentModelChange, caller: MagpieCaller) {
    this.calls.push({ change, caller })
    if (this.answer === 'invalid')
      return {
        ok: false as const,
        failure: {
          code: 'invalid' as const,
          message: '分档与小模型要和主模型同一来源',
        },
      }
    return { ok: true as const, value: CODER }
  }
}

let port: FakeAgentModels
let records: string[]
let deps: ConsoleDeps
const denied = {
  ok: false as const,
  failure: { code: 'unsupported' as const, message: 'unused' },
}

beforeEach(() => {
  port = new FakeAgentModels()
  records = []
  deps = {
    limits: LIMITS,
    agentModels: port,
    registry: {
      list: async () => ({ ok: true, value: [] }),
      register: async () => denied,
      heartbeat: async () => denied,
      deregister: async () => ({ ok: true, value: undefined }),
    },
    audit: { read: async () => denied, chain: async () => denied },
  }
})

function access(role: 'view' | 'viewer' | 'ops', breakGlass = false): Access {
  return {
    credential: {
      role: role === 'ops' ? 'admin' : 'view',
      source: 'bearer',
      header: true,
      crossOrigin: false,
    },
    principal:
      role === 'view'
        ? { kind: 'legacy', subject: 'legacy:view', credential: 'bearer' }
        : {
            kind: 'user',
            subject: SUBJECT,
            role,
            credential: 'bearer',
            authenticatedAt: 1,
          },
    sid: null,
    refusal: null,
    breakGlass,
  }
}

function contextOf(
  method: string,
  path: string,
  who: Access,
  body?: unknown,
): RouteContext {
  const request = new Request(`http://console.test${path}`, {
    method,
    ...(body === undefined
      ? {}
      : {
          body: JSON.stringify(body),
          headers: { 'content-type': 'application/json' },
        }),
  })
  return {
    request,
    url: new URL(request.url),
    deps,
    access: who,
    accounts: undefined,
    now: NOW,
    viewer: undefined,
    requestId: 'request',
    roster: () => deps.registry.list(),
    admit: async () => null,
    record: async (action, target, outcome) => {
      records.push(`${action} ${target} ${outcome}`)
      return true
    },
  }
}

function call(
  method: string,
  path: string,
  who: Access,
  body?: unknown,
): Promise<Response> {
  const ctx = contextOf(method, path, who, body)
  return magpieApi.handle(
    ctx,
    'magpie',
    ctx.url.pathname.split('/').filter(Boolean).slice(2),
  )
}

describe('the JSON without magpie', () => {
  test('view and up read the fields; only a writer sees the node words', async () => {
    for (const role of ['view', 'viewer', 'ops'] as const) {
      const response = await call(
        'GET',
        '/v0/magpie/agents/models',
        access(role),
      )
      expect(response.status).toBe(200)
      const read = (await response.json()) as AgentModelsSnapshot
      const writer = role === 'ops'
      expect(`${role} ${read.nodes[2]?.error}`).toBe(
        `${role} ${writer ? 'dial tcp 10.0.0.9:22 · timeout' : null}`,
      )
      expect(`${role} ${read.nodes[0]?.agents[1]?.write?.message}`).toBe(
        `${role} ${writer ? 'E_RUNTIME_MODEL bad effort' : null}`,
      )
    }
  })

  test('a writer sets one field; it is recorded as runtime.configure', async () => {
    const response = await call(
      'POST',
      '/v0/magpie/agents/configure',
      access('ops'),
      {
        node: 'tokyo-1',
        agent: 'coder',
        field: 'haiku_effort',
        value: 'low',
      },
    )
    expect(response.status).toBe(200)
    expect(port.calls.map(one => one.change)).toEqual([
      { node: 'tokyo-1', agent: 'coder', field: 'haiku_effort', value: 'low' },
    ])
    expect(port.calls[0]?.caller.subject).toBe(SUBJECT)
    expect(records).toEqual([
      'runtime.configure qianmo://tokyo-1/coder haiku_effort ok',
    ])
    // Empty is 跟随 / 默认.
    await call('POST', '/v0/magpie/agents/configure', access('ops'), {
      node: 'tokyo-1',
      agent: 'coder',
      field: 'haiku',
      value: '',
    })
    expect(port.calls[1]?.change.value).toBe('')
  })

  test('a refusal is answered and recorded; nobody else writes', async () => {
    port.answer = 'invalid'
    const refused = await call(
      'POST',
      '/v0/magpie/agents/configure',
      access('ops'),
      {
        node: 'tokyo-1',
        agent: 'coder',
        field: 'haiku',
        value: 'oa/gpt-5.5',
      },
    )
    expect(refused.status).toBe(400)
    expect(records.at(-1)).toBe(
      'runtime.configure qianmo://tokyo-1/coder haiku failed',
    )
    const before = port.calls.length
    for (const who of [access('viewer'), access('view'), access('ops', true)]) {
      const response = await call('POST', '/v0/magpie/agents/configure', who, {
        node: 'tokyo-1',
        agent: 'coder',
        field: 'effort',
        value: 'high',
      })
      expect(response.status).toBe(403)
    }
    expect(port.calls).toHaveLength(before)
  })

  test('bodies are checked before the port is asked', async () => {
    const bad: readonly Record<string, unknown>[] = [
      { node: 'tokyo-1', agent: 'coder', field: 'Effort', value: 'high' },
      { node: 'tokyo-1', agent: 'Coder!', field: 'effort', value: 'high' },
      { node: 'Tokyo 1', agent: 'coder', field: 'effort', value: 'high' },
      {
        node: 'tokyo-1',
        agent: 'coder',
        field: 'haiku',
        value: 'claude-haiku-4-5',
      },
      { node: 'tokyo-1', agent: 'coder', field: 'model', value: 'anth/a b' },
      {
        node: 'tokyo-1',
        agent: 'coder',
        field: 'model',
        value: `anth/${'x'.repeat(300)}`,
      },
    ]
    for (const body of bad) {
      const response = await call(
        'POST',
        '/v0/magpie/agents/configure',
        access('ops'),
        body,
      )
      expect(`${JSON.stringify(body)} ${response.status}`).toBe(
        `${JSON.stringify(body)} 400`,
      )
    }
    expect(port.calls).toEqual([])
    expect(records).toEqual([])
  })

  test('without the model service it says so; the other agents writes still need magpie', async () => {
    const { agentModels: _gone, ...rest } = deps
    deps = rest
    expect(
      (await call('GET', '/v0/magpie/agents/models', access('ops'))).status,
    ).toBe(501)
    expect(
      (
        await call('POST', '/v0/magpie/agents/configure', access('ops'), {
          node: 'tokyo-1',
          agent: 'coder',
          field: 'effort',
          value: 'high',
        })
      ).status,
    ).toBe(501)
    expect(
      (
        await call('POST', '/v0/magpie/agents/configure', access('ops'), {
          node: 'tokyo-1',
          agent: 'coder',
          model: 'auto',
        })
      ).status,
    ).toBe(501)
  })

  test('the fragment draws the section for view and up', async () => {
    const handle = magpieRoute.fragments?.handle
    if (handle === undefined) throw new Error('no fragments')
    const reader = await handle(
      contextOf('GET', '/fragments/agents/models', access('viewer')),
      'agents',
      ['models'],
    )
    expect(reader.status).toBe(200)
    const html = await reader.text()
    expect(html).toContain('智能体模型')
    expect(html).not.toContain('am-pick')
    const writer = await handle(
      contextOf('GET', '/fragments/agents/models', access('ops')),
      'agents',
      ['models'],
    )
    expect(await writer.text()).toContain(
      'data-key="am-pick:tokyo-1/coder/model"',
    )
    const unknown = await handle(
      contextOf('GET', '/fragments/agents/other', access('ops')),
      'agents',
      ['other'],
    )
    expect(unknown.status).toBe(404)
  })
})
