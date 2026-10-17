// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `/v0/magpie` (P33/P34): everyone with view reads the gateway's state, only
 * writers see full addresses and key tails, and only a personal ops account
 * outside break-glass (a platform subject when there are tenants) changes
 * anything — guard and admission before any effect, every write recorded
 * under a target of our own grammar.
 */

import { beforeEach, expect, test } from 'bun:test'
import type { Access } from '../src/access.js'
import type { ConsoleDeps } from '../src/deps.js'
import type {
  MagpieAgentsSnapshot,
  MagpieExtensionsView,
  MagpieKeyView,
  MagpieProviderView,
  MagpieSnapshot,
} from '../src/directionPorts.js'
import { magpieApi } from '../src/routes/magpieApi.js'
import type { RouteContext } from '../src/routes/types.js'
import type { TenantPort } from '../src/tenancy.js'
import { LIMITS } from './accountsHarness.js'
import { FakeMagpie } from './directionFakes.js'

const NOW = 1_700_000_000_000
const SUBJECT = 'u:0123456789abcdef'
let port: FakeMagpie
let admits: number
let records: string[]
let deps: ConsoleDeps
const denied = {
  ok: false as const,
  failure: { code: 'unsupported' as const, message: 'unused' },
}

beforeEach(() => {
  port = new FakeMagpie()
  admits = 0
  records = []
  deps = {
    limits: LIMITS,
    magpie: port,
    registry: {
      list: async () => ({ ok: true, value: [] }),
      register: async () => denied,
      heartbeat: async () => denied,
      deregister: async () => ({ ok: true, value: undefined }),
    },
    audit: { read: async () => denied, chain: async () => denied },
  }
})

function access(
  role: 'none' | 'view' | 'admin' | 'viewer' | 'member' | 'ops',
  breakGlass = false,
): Access {
  const personal = ['viewer', 'member', 'ops'].includes(role)
  return {
    credential: {
      role: personal
        ? role === 'ops'
          ? 'admin'
          : 'view'
        : (role as 'none' | 'view' | 'admin'),
      source: 'bearer',
      header: true,
      crossOrigin: false,
    },
    principal:
      role === 'none'
        ? null
        : personal
          ? {
              kind: 'user',
              subject: SUBJECT,
              role: role as 'ops',
              credential: 'bearer',
              authenticatedAt: 1,
            }
          : {
              kind: 'legacy',
              subject: role === 'admin' ? 'legacy:admin' : 'legacy:view',
              credential: 'bearer',
            },
    sid: null,
    refusal: null,
    breakGlass,
  }
}

function tenancy(platformSubjects: readonly string[] | 'broken'): TenantPort {
  return {
    read() {
      if (platformSubjects === 'broken') throw new Error('租户配置不可用')
      return {
        revision: 'r1',
        config: {
          version: 1,
          hubServer: 'hub',
          tenants: [],
          subjects: [],
          nodes: [],
          jobs: [],
          platformSubjects,
        },
      }
    },
    subscribe: () => () => {},
  }
}

async function call(
  method: string,
  path: string,
  who: Access,
  body?: unknown,
): Promise<Response> {
  const request = new Request(`http://console.test${path}`, {
    method,
    ...(body === undefined
      ? {}
      : {
          body: JSON.stringify(body),
          headers: { 'content-type': 'application/json' },
        }),
  })
  const url = new URL(request.url)
  const ctx: RouteContext = {
    request,
    url,
    deps,
    access: who,
    accounts: undefined,
    now: NOW,
    viewer: undefined,
    requestId: 'request',
    roster: () => deps.registry.list(),
    admit: async () => {
      admits++
      return null
    },
    record: async (action, target, outcome) => {
      records.push(`${action} ${target} ${outcome}`)
      return true
    },
  }
  return magpieApi.handle(
    ctx,
    'magpie',
    url.pathname.split('/').filter(Boolean).slice(2),
  )
}

test('view and up read the gateway; only a writer sees addresses whole and key tails', async () => {
  for (const role of ['view', 'admin', 'viewer', 'member', 'ops'] as const) {
    const response = await call('GET', '/v0/magpie', access(role))
    expect(response.status).toBe(200)
    const snapshot = (await response.json()) as MagpieSnapshot
    const writer = role === 'ops'
    expect(`${role} ${snapshot.connection.gatewayUrl}`).toBe(
      `${role} ${writer ? 'https://gw.tokyo.example:8443' : 'gw.tokyo.example:8443'}`,
    )
    expect(`${role} ${snapshot.connection.managementUrl}`).toBe(
      `${role} ${writer ? 'http://127.0.0.1:3430' : '127.0.0.1:3430'}`,
    )
    expect(`${role} ${snapshot.keys[0]?.masked}`).toBe(
      `${role} ${writer ? '…a1b2' : null}`,
    )
    expect(snapshot.providers.map(one => one.access)).toEqual([
      'key',
      'key',
      'account',
    ])
  }
  const breakGlass = (await (
    await call('GET', '/v0/magpie', access('ops', true))
  ).json()) as MagpieSnapshot
  expect(breakGlass.keys[0]?.masked).toBeNull()
  expect((await call('GET', '/v0/magpie', access('none'))).status).toBe(401)
  expect(admits).toBe(0)
})

test('usage reads by period and refuses one magpie would read as 30 days', async () => {
  const response = await call(
    'GET',
    '/v0/magpie/usage?period=30d',
    access('view'),
  )
  expect(response.status).toBe(200)
  const usage = (await response.json()) as { period: string; keys: unknown[] }
  expect(usage.period).toBe('30d')
  expect(usage.keys).toHaveLength(1)
  expect(
    (await call('GET', '/v0/magpie/usage?period=90d', access('view'))).status,
  ).toBe(400)
})

const WRITES: readonly (readonly [string, string, unknown?])[] = [
  [
    'POST',
    '/v0/magpie/connection',
    { gatewayUrl: 'https://a.test', managementUrl: 'http://127.0.0.1:3430' },
  ],
  ['POST', '/v0/magpie/check', {}],
  ['POST', '/v0/magpie/providers', { preset: 'openai', key: 'sk-upstream' }],
  ['POST', '/v0/magpie/providers/openai', { enabled: false }],
  ['POST', '/v0/magpie/providers/openai/test', {}],
  ['DELETE', '/v0/magpie/providers/openai'],
  ['POST', '/v0/magpie/groups', { id: 'fast', routing: 'rotate' }],
  ['DELETE', '/v0/magpie/groups/fast'],
  [
    'POST',
    '/v0/magpie/keys',
    { binding: 'node:osaka-1', mainModel: 'openai/gpt-6' },
  ],
  ['POST', '/v0/magpie/keys/node%3Atokyo-1', { enabled: false }],
  ['POST', '/v0/magpie/keys/node%3Atokyo-1/rotate', {}],
  ['DELETE', '/v0/magpie/keys/node%3Atokyo-1'],
]

test('nobody but a personal ops account writes; nothing happens before the guard', async () => {
  for (const who of [
    access('view'),
    access('admin'),
    access('viewer'),
    access('member'),
    access('ops', true),
  ]) {
    for (const [method, path, body] of WRITES) {
      const response = await call(method, path, who, body)
      expect(`${method} ${path} ${response.status}`).toBe(
        `${method} ${path} 403`,
      )
    }
  }
  expect(port.calls).toEqual([])
  expect(admits).toBe(0)
  expect(records).toEqual([])
})

test('with tenants, only a platform subject writes; a broken tenancy refuses', async () => {
  deps = { ...deps, tenancy: tenancy(['u:ffffffffffffffff']) }
  for (const [method, path, body] of WRITES) {
    expect((await call(method, path, access('ops'), body)).status).toBe(403)
  }
  deps = { ...deps, tenancy: tenancy('broken') }
  expect(
    (await call('POST', '/v0/magpie/check', access('ops'), {})).status,
  ).toBe(403)
  deps = { ...deps, tenancy: tenancy([SUBJECT]) }
  expect(
    (await call('POST', '/v0/magpie/check', access('ops'), {})).status,
  ).toBe(200)
  expect(port.calls).toEqual([`check ${SUBJECT}`])
})

test('every write is admitted once and recorded under our own target', async () => {
  const ops = access('ops')
  const statuses: number[] = []
  for (const [method, path, body] of WRITES) {
    statuses.push((await call(method, path, ops, body)).status)
  }
  expect(statuses).toEqual([
    200, 200, 200, 200, 200, 204, 200, 204, 200, 200, 200, 200,
  ])
  expect(admits).toBe(WRITES.length)
  expect(records).toEqual([
    'magpie.connect magpie ok',
    'magpie.check magpie ok',
    'magpie.provider.save new ok',
    'magpie.provider.toggle openai ok',
    'magpie.provider.test openai ok',
    'magpie.provider.remove openai ok',
    'magpie.group.save fast ok',
    'magpie.group.remove fast ok',
    'magpie.key.issue node:osaka-1 ok',
    'magpie.key.update node:tokyo-1 ok',
    'magpie.key.rotate node:tokyo-1 ok',
    'magpie.key.remove node:tokyo-1 ok',
  ])
  expect(port.calls[0]).toBe(`connect https://a.test ${SUBJECT}`)
})

test('a port refusal keeps its code and is recorded as failed', async () => {
  const ops = access('ops')
  const plain = await call('POST', '/v0/magpie/connection', ops, {
    gatewayUrl: 'http://a.test',
    managementUrl: 'http://127.0.0.1:3430',
  })
  expect(plain.status).toBe(400)
  const account = await call('POST', '/v0/magpie/providers', ops, {
    preset: 'codex',
  })
  expect(account.status).toBe(400)
  expect(
    ((await account.json()) as { error: { code: string } }).error.code,
  ).toBe('rejected')
  const missing = await call(
    'POST',
    '/v0/magpie/keys/node%3Anowhere/rotate',
    ops,
    {},
  )
  expect(missing.status).toBe(404)
  expect(records).toEqual([
    'magpie.connect magpie failed',
    'magpie.provider.save new failed',
    'magpie.key.rotate node:nowhere failed',
  ])
})

test('bodies and path segments are checked before the port is asked', async () => {
  const ops = access('ops')
  const bad: readonly (readonly [string, string, unknown?])[] = [
    ['POST', '/v0/magpie/connection', { gatewayUrl: '' }],
    ['POST', '/v0/magpie/providers', {}],
    [
      'POST',
      '/v0/magpie/providers',
      { preset: 'openai', chat: 'https://api.example.cn/v1' },
    ],
    [
      'POST',
      '/v0/magpie/providers',
      { preset: '', chat: 'https://api.example.cn/v1' },
    ],
    ['POST', '/v0/magpie/providers', { preset: '', name: 'api2' }],
    ['POST', '/v0/magpie/providers/Bad_Id', { enabled: true }],
    ['POST', '/v0/magpie/providers/openai', { enabled: 'yes' }],
    ['POST', '/v0/magpie/groups', { id: 'g', routing: 'weight' }],
    ['DELETE', '/v0/magpie/groups/Bad.Group'],
    ['POST', '/v0/magpie/keys', { binding: 'node:Bad Node', mainModel: 'a/b' }],
    ['POST', '/v0/magpie/keys', { binding: 'node:osaka-1' }],
    [
      'POST',
      '/v0/magpie/keys',
      {
        binding: { kind: 'tenant', id: 'acme' },
        mainModel: 'a/b',
        limits: [{ period: 'year', tokens: 1 }],
      },
    ],
    [
      'POST',
      '/v0/magpie/keys',
      {
        binding: 'node:osaka-1',
        mainModel: 'a/b',
        limits: new Array(6).fill({ period: 'day', tokens: 1 }),
      },
    ],
    ['POST', '/v0/magpie/keys/server%3Ax', { enabled: true }],
    ['POST', '/v0/magpie/keys/node%3Atokyo-1', { resetLimit: -1 }],
    ['POST', '/v0/magpie/keys/node%3Atokyo-1', { models: 'openai/*' }],
  ]
  for (const [method, path, body] of bad) {
    const response = await call(method, path, ops, body)
    expect(`${method} ${path} ${JSON.stringify(body)} ${response.status}`).toBe(
      `${method} ${path} ${JSON.stringify(body)} 400`,
    )
  }
  expect(port.calls).toEqual([])
  expect(records).toEqual([])
})

test('a custom upstream reaches the port by its name and URLs', async () => {
  const response = await call('POST', '/v0/magpie/providers', access('ops'), {
    name: 'api2',
    key: 'sk-upstream',
    chat: ' https://api.example.cn/v1 ',
    responses: 'https://api.example.cn/v1',
  })
  expect(response.status).toBe(200)
  const view = (await response.json()) as MagpieProviderView
  expect(view.preset).toBe('')
  expect(view.host).toBe('api.example.cn')
  expect(port.calls).toEqual([`provider.save  ${SUBJECT}`])
})

test('a tenant binding and a key change reach the port as typed drafts', async () => {
  const ops = access('ops')
  const issued = await call('POST', '/v0/magpie/keys', ops, {
    binding: { kind: 'tenant', id: 'acme' },
    mainModel: 'openai/gpt-6',
    fastModel: 'group/fast',
    lane: 'openai-chat',
    models: ['openai/*'],
    limits: [{ period: 'days', days: '7', tokens: '1000' }],
  })
  expect(issued.status).toBe(200)
  const view = (await issued.json()) as MagpieKeyView
  expect(view.binding).toEqual({ kind: 'tenant', id: 'acme' })
  expect(view.lane).toBe('openai-chat')
  expect(view.modelsMode).toBe('list')
  const back = await call('POST', '/v0/magpie/keys/tenant%3Aacme', ops, {
    models: null,
    fastModel: null,
  })
  const changed = (await back.json()) as MagpieKeyView
  expect(changed.modelsMode).toBe('all')
  expect(changed.fastModel).toBeNull()
})

test('unknown paths, wrong methods and a missing port', async () => {
  const ops = access('ops')
  const unknown = await call('GET', '/v0/magpie/nope', ops)
  expect(unknown.status).toBe(404)
  expect(await unknown.text()).toContain('unknown path')
  expect(
    (await call('GET', '/v0/magpie/keys/node%3Atokyo-1/x', ops)).status,
  ).toBe(404)
  expect((await call('PUT', '/v0/magpie', ops)).status).toBe(405)
  expect((await call('GET', '/v0/magpie/providers/openai', ops)).status).toBe(
    405,
  )
  expect((await call('POST', '/v0/magpie/groups/fast', ops, {})).status).toBe(
    405,
  )
  const { magpie: _gone, ...rest } = deps
  deps = rest
  expect((await call('GET', '/v0/magpie', ops)).status).toBe(501)
  expect((await call('POST', '/v0/magpie/check', ops, {})).status).toBe(501)
})

// --- the 智能体 section (P36.5) -------------------------------------------

const AGENT_WRITES: readonly (readonly [string, string, unknown])[] = [
  [
    'POST',
    '/v0/magpie/agents/configure',
    { node: 'tokyo-1', agent: 'coder', model: 'openai/gpt-6' },
  ],
  [
    'POST',
    '/v0/magpie/agents/configure',
    { node: 'tokyo-1', agent: 'builder', runtime: 'claude-code' },
  ],
  ['POST', '/v0/magpie/agents/install', { node: 'tokyo-1', runtime: 'codex' }],
  ['POST', '/v0/magpie/agents/remove', { node: 'tokyo-1', runtime: 'dsh' }],
  ['POST', '/v0/magpie/agents/autojoin', { on: false }],
  ['POST', '/v0/magpie/agents/join', { node: 'osaka-1' }],
]

function agentCalls(): readonly string[] {
  return port.agents?.calls ?? []
}

test('agents: everyone with view reads names and states; only a writer reads failure text', async () => {
  for (const role of ['view', 'viewer', 'member', 'ops'] as const) {
    const response = await call('GET', '/v0/magpie/agents', access(role))
    expect(response.status).toBe(200)
    const snapshot = (await response.json()) as MagpieAgentsSnapshot
    const writer = role === 'ops'
    const tokyo = snapshot.nodes.find(one => one.node === 'tokyo-1')
    const reviewer = tokyo?.agents.find(one => one.agent === 'reviewer')
    const builder = tokyo?.agents.find(one => one.agent === 'builder')
    expect(`${role} ${reviewer?.write?.message ?? null}`).toBe(
      `${role} ${writer ? 'E_RUNTIME_MODEL：模型不在档案里，已拒绝' : null}`,
    )
    expect(`${role} ${builder?.reason?.message ?? null}`).toBe(
      `${role} ${writer ? '未安装，等待安装' : null}`,
    )
    // The state words stay for everyone.
    expect(builder?.reason?.code).toBe('not-installed')
    expect(reviewer?.write?.state).toBe('failed')
    expect(
      `${role} ${tokyo?.runtimes.find(one => one.id === 'codex')?.failed?.message ?? null}`,
    ).toBe(`${role} ${writer ? 'npm 下载失败，网络超时' : null}`)
    expect(
      `${role} ${snapshot.nodes.find(one => one.node === 'nagoya-1')?.error ?? null}`,
    ).toBe(`${role} ${writer ? '节点控制链路未连接，稍后重试' : null}`)
    expect(reviewer?.model).toBe('anthropic/claude-opus-5')
  }
  expect((await call('GET', '/v0/magpie/agents', access('none'))).status).toBe(
    401,
  )
  expect(agentCalls()).toEqual([])
  expect(admits).toBe(0)
})

test('agents: nobody but a personal ops account (a platform subject with tenants) writes', async () => {
  for (const who of [
    access('view'),
    access('admin'),
    access('viewer'),
    access('member'),
    access('ops', true),
  ]) {
    for (const [method, path, body] of AGENT_WRITES) {
      const response = await call(method, path, who, body)
      expect(`${path} ${response.status}`).toBe(`${path} 403`)
    }
  }
  deps = { ...deps, tenancy: tenancy(['u:ffffffffffffffff']) }
  for (const [method, path, body] of AGENT_WRITES) {
    expect((await call(method, path, access('ops'), body)).status).toBe(403)
  }
  expect(agentCalls()).toEqual([])
  expect(admits).toBe(0)
  expect(records).toEqual([])
})

test('agents: every write is admitted once and recorded under our own target', async () => {
  const ops = access('ops')
  const statuses: number[] = []
  for (const [method, path, body] of AGENT_WRITES)
    statuses.push((await call(method, path, ops, body)).status)
  expect(statuses).toEqual([200, 200, 200, 200, 200, 200])
  expect(admits).toBe(AGENT_WRITES.length)
  expect(records).toEqual([
    'runtime.configure qianmo://tokyo-1/coder ok',
    'runtime.configure qianmo://tokyo-1/builder ok',
    'runtime.install tokyo-1/codex ok',
    'runtime.remove tokyo-1/dsh ok',
    'magpie.autojoin magpie ok',
    'magpie.key.issue node:osaka-1 ok',
  ])
  expect(agentCalls()).toEqual([
    `configure tokyo-1/coder - openai/gpt-6 ${SUBJECT}`,
    `configure tokyo-1/builder claude-code - ${SUBJECT}`,
    `install tokyo-1/codex ${SUBJECT}`,
    `remove tokyo-1/dsh ${SUBJECT}`,
    `autojoin false ${SUBJECT}`,
    `join osaka-1 ${SUBJECT}`,
  ])
  const refused = await call('POST', '/v0/magpie/agents/remove', ops, {
    node: 'tokyo-1',
    runtime: 'claude-code',
  })
  expect(refused.status).toBe(403)
  expect(
    ((await refused.json()) as { error: { code: string } }).error.code,
  ).toBe('refused')
  expect(records.at(-1)).toBe('runtime.remove tokyo-1/claude-code failed')
})

test('agents: bodies are checked before the port is asked', async () => {
  const ops = access('ops')
  const bad: readonly (readonly [string, unknown])[] = [
    ['/v0/magpie/agents/configure', { node: 'tokyo-1', agent: 'coder' }],
    [
      '/v0/magpie/agents/configure',
      { node: 'Tokyo 1', agent: 'coder', model: 'auto' },
    ],
    [
      '/v0/magpie/agents/configure',
      { node: 'tokyo-1', agent: 'Coder!', model: 'auto' },
    ],
    [
      '/v0/magpie/agents/configure',
      { node: 'tokyo-1', agent: 'coder', runtime: 'Claude Code' },
    ],
    [
      '/v0/magpie/agents/configure',
      { node: 'tokyo-1', agent: 'coder', model: 'a b' },
    ],
    ['/v0/magpie/agents/install', { node: 'tokyo-1' }],
    ['/v0/magpie/agents/remove', { runtime: 'codex' }],
    ['/v0/magpie/agents/autojoin', { on: 'yes' }],
    ['/v0/magpie/agents/join', {}],
  ]
  for (const [path, body] of bad) {
    const response = await call('POST', path, ops, body)
    expect(`${path} ${JSON.stringify(body)} ${response.status}`).toBe(
      `${path} ${JSON.stringify(body)} 400`,
    )
  }
  expect(agentCalls()).toEqual([])
  expect(records).toEqual([])
})

test('agents: unknown actions, wrong methods and an unwired section', async () => {
  const ops = access('ops')
  expect(
    (await call('POST', '/v0/magpie/agents/upgrade', ops, {})).status,
  ).toBe(404)
  expect(
    (await call('POST', '/v0/magpie/agents/configure/x', ops, {})).status,
  ).toBe(404)
  expect((await call('POST', '/v0/magpie/agents', ops, {})).status).toBe(405)
  expect((await call('GET', '/v0/magpie/agents/join', ops)).status).toBe(405)
  port.agents = undefined
  expect((await call('GET', '/v0/magpie/agents', ops)).status).toBe(501)
  expect(
    (await call('POST', '/v0/magpie/agents/autojoin', ops, { on: true }))
      .status,
  ).toBe(501)
})

const EXT = '/v0/magpie/agents/tokyo-1/coder/extensions'
const EXT_WRITES: readonly (readonly [string, unknown])[] = [
  [`${EXT}/install`, { kind: 'plugin', source: 'obra/superpowers#v4.1.0' }],
  [`${EXT}/install`, { kind: 'skill', source: '@acme/release-notes@1.2.3' }],
  [
    `${EXT}/install`,
    {
      kind: 'mcp',
      name: 'github',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github', '--token=abc123'],
    },
  ],
  [
    `${EXT}/install`,
    { kind: 'mcp', name: 'docs', url: 'https://mcp.example.com/mcp' },
  ],
  [`${EXT}/remove`, { kind: 'plugin', name: 'superpowers@claude-plugins' }],
]

test('extensions: everyone with view reads the list; only a writer reads failure text', async () => {
  for (const role of ['view', 'viewer', 'member', 'ops'] as const) {
    const writer = role === 'ops'
    const coder = await call('GET', EXT, access(role))
    expect(coder.status).toBe(200)
    const list = (await coder.json()) as MagpieExtensionsView
    expect(list.items.map(item => `${item.kind}:${item.name}`)).toEqual([
      'plugin:@deepseek-ai/dsh-plugin-review',
      'mcp:github',
      'skill:release-notes',
    ])
    expect(list.openCommand).toBe('qm runtime open coder --port 8123')
    const reviewer = (await (
      await call(
        'GET',
        '/v0/magpie/agents/tokyo-1/reviewer/extensions',
        access(role),
      )
    ).json()) as MagpieExtensionsView
    expect(`${role} ${reviewer.error}`).toBe(
      `${role} ${writer ? '列表命令超时，已放弃' : null}`,
    )
    expect(`${role} ${reviewer.job?.message ?? null}`).toBe(
      `${role} ${writer ? 'E_RUNTIME_EXT_FAILED：克隆失败，仓库不存在' : null}`,
    )
    expect(reviewer.job?.state).toBe('failed')
    // The snapshot's copy of the same panel is cut the same way.
    const snapshot = (await (
      await call('GET', '/v0/magpie/agents', access(role))
    ).json()) as MagpieAgentsSnapshot
    const inSnapshot = snapshot.nodes[0]?.agents.find(
      one => one.agent === 'reviewer',
    )?.extensions
    expect(`${role} ${inSnapshot?.error ?? null}`).toBe(
      `${role} ${writer ? '列表命令超时，已放弃' : null}`,
    )
  }
  const ops = access('ops')
  expect(
    (await call('GET', '/v0/magpie/agents/tokyo-1/ghost/extensions', ops))
      .status,
  ).toBe(404)
  expect(
    (await call('GET', '/v0/magpie/agents/Tokyo%201/coder/extensions', ops))
      .status,
  ).toBe(400)
  expect((await call('GET', EXT, access('none'))).status).toBe(401)
  expect(admits).toBe(0)
  expect(records).toEqual([])
})

test('extensions: nobody but a personal ops account (a platform subject with tenants) writes', async () => {
  for (const who of [
    access('view'),
    access('admin'),
    access('viewer'),
    access('member'),
    access('ops', true),
  ]) {
    for (const [path, body] of EXT_WRITES) {
      const response = await call('POST', path, who, body)
      expect(`${path} ${response.status}`).toBe(`${path} 403`)
    }
  }
  deps = { ...deps, tenancy: tenancy(['u:ffffffffffffffff']) }
  for (const [path, body] of EXT_WRITES)
    expect((await call('POST', path, access('ops'), body)).status).toBe(403)
  expect(agentCalls()).toEqual([])
  expect(admits).toBe(0)
  expect(records).toEqual([])
})

test('extensions: every write is admitted once and recorded as node/agent kind:name, never the arguments', async () => {
  const ops = access('ops')
  const statuses: number[] = []
  for (const [path, body] of EXT_WRITES)
    statuses.push((await call('POST', path, ops, body)).status)
  expect(statuses).toEqual([200, 200, 200, 200, 200])
  expect(admits).toBe(EXT_WRITES.length)
  expect(records).toEqual([
    'runtime.ext.install tokyo-1/coder plugin:obra/superpowers#v4.1.0 ok',
    'runtime.ext.install tokyo-1/coder skill:@acme/release-notes@1.2.3 ok',
    'runtime.ext.install tokyo-1/coder mcp:github ok',
    'runtime.ext.install tokyo-1/coder mcp:docs ok',
    'runtime.ext.remove tokyo-1/coder plugin:superpowers@claude-plugins ok',
  ])
  expect(records.join('\n')).not.toContain('abc123')
  expect(records.join('\n')).not.toContain('mcp.example.com')
  expect(agentCalls()).toEqual([
    `ext-install tokyo-1/coder plugin:obra/superpowers#v4.1.0 ${SUBJECT}`,
    `ext-install tokyo-1/coder skill:@acme/release-notes@1.2.3 ${SUBJECT}`,
    `ext-install tokyo-1/coder mcp:github ${SUBJECT}`,
    `ext-install tokyo-1/coder mcp:docs ${SUBJECT}`,
    `ext-remove tokyo-1/coder plugin:superpowers@claude-plugins ${SUBJECT}`,
  ])
  // The node says the agent's frontend is open: 403, recorded as failed.
  const locked = await call(
    'POST',
    '/v0/magpie/agents/tokyo-1/reviewer/extensions/install',
    ops,
    { kind: 'plugin', source: 'https://github.com/obra/superpowers.git' },
  )
  expect(locked.status).toBe(403)
  expect(
    ((await locked.json()) as { error: { message: string } }).error.message,
  ).toBe('该智能体的官方前端正开着')
  expect(records.at(-1)).toBe(
    'runtime.ext.install tokyo-1/reviewer plugin:https://github.com/obra/superpowers failed',
  )
})

test('extensions: a source the hub would not send is refused before the ledger or the port', async () => {
  const ops = access('ops')
  const plugin = (source: string) => ({ kind: 'plugin', source })
  const mcp = (over: Record<string, unknown>) => ({
    kind: 'mcp',
    name: 'tools',
    command: 'npx',
    ...over,
  })
  const bad: readonly (readonly [string, unknown])[] = [
    // Other hosts, other schemes, credentials.
    [`${EXT}/install`, plugin('https://gitlab.com/owner/repo')],
    [`${EXT}/install`, plugin('https://github.com.evil.example/owner/repo')],
    [`${EXT}/install`, plugin('http://github.com/owner/repo')],
    [`${EXT}/install`, plugin('https://user:secret@github.com/owner/repo')],
    [`${EXT}/install`, plugin('https://github.com:8443/owner/repo')],
    [`${EXT}/install`, plugin('https://github.com/owner/repo?ref=main')],
    [`${EXT}/install`, plugin('git@github.com:owner/repo')],
    [`${EXT}/install`, plugin('file:///etc/passwd')],
    // Paths that climb, encodings, flags.
    [`${EXT}/install`, plugin('../../etc/passwd')],
    [`${EXT}/install`, plugin('owner/../repo')],
    [`${EXT}/install`, plugin('https://github.com/owner/repo/../../x')],
    [`${EXT}/install`, plugin('%2e%2e/owner')],
    [`${EXT}/install`, plugin('-rf')],
    [`${EXT}/install`, plugin('--registry=https://evil.example')],
    [`${EXT}/install`, plugin('owner/repo#--upload-pack=x')],
    [`${EXT}/install`, plugin('owner/repo#--upload-pack')],
    // npm ranges are not an exact version.
    [`${EXT}/install`, plugin('left-pad@^1.0.0')],
    [`${EXT}/install`, { kind: 'plugin' }],
    [`${EXT}/install`, { kind: 'theme', source: 'owner/repo' }],
    [`${EXT}/install`, { kind: 'plugin', source: 'owner/repo', name: 'x' }],
    // MCP: names of our own, one way in, no credentials or query.
    [`${EXT}/install`, mcp({ name: 'qm-github' })],
    [`${EXT}/install`, mcp({ name: 'qianmo' })],
    [`${EXT}/install`, mcp({ url: 'https://mcp.example.com/mcp' })],
    [`${EXT}/install`, mcp({ command: '-c' })],
    [`${EXT}/install`, mcp({ command: '../bin/server' })],
    [`${EXT}/install`, mcp({ command: 'npx', args: ['ok', 'two\nlines'] })],
    [
      `${EXT}/install`,
      {
        kind: 'mcp',
        name: 'docs',
        url: 'https://token:x@mcp.example.com/mcp',
      },
    ],
    [
      `${EXT}/install`,
      { kind: 'mcp', name: 'docs', url: 'https://mcp.example.com/mcp?key=1' },
    ],
    [
      `${EXT}/install`,
      { kind: 'mcp', name: 'docs', url: 'http://mcp.example.com/mcp' },
    ],
    // Removals name an item the way a harness does, nothing more.
    [`${EXT}/remove`, { kind: 'plugin', name: '-x' }],
    [`${EXT}/remove`, { kind: 'plugin', name: '../x' }],
    [`${EXT}/remove`, { kind: 'plugin', name: 'a b' }],
    [`${EXT}/remove`, { kind: 'theme', name: 'x' }],
  ]
  for (const [path, body] of bad) {
    const response = await call('POST', path, ops, body)
    expect(`${JSON.stringify(body)} ${response.status}`).toBe(
      `${JSON.stringify(body)} 400`,
    )
  }
  const gitlab = await call(
    'POST',
    `${EXT}/install`,
    ops,
    plugin('https://gitlab.com/owner/repo'),
  )
  expect(
    ((await gitlab.json()) as { error: { message: string } }).error.message,
  ).toBe('来源只收 GitHub 仓库 · npm 包名 · 名字@市场')
  expect(agentCalls()).toEqual([])
  expect(records).toEqual([])
  expect(admits).toBe(0)
})

test('extensions: unknown verbs, wrong methods and an unwired section', async () => {
  const ops = access('ops')
  expect((await call('POST', `${EXT}/upgrade`, ops, {})).status).toBe(404)
  expect(
    (await call('GET', '/v0/magpie/agents/tokyo-1/coder/plugins', ops)).status,
  ).toBe(404)
  expect((await call('POST', EXT, ops, {})).status).toBe(405)
  expect((await call('GET', `${EXT}/install`, ops)).status).toBe(405)
  port.agents = undefined
  expect((await call('GET', EXT, ops)).status).toBe(501)
  expect(
    (
      await call('POST', `${EXT}/remove`, ops, {
        kind: 'plugin',
        name: 'x',
      })
    ).status,
  ).toBe(501)
})
