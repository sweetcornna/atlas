// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from 'bun:test'
import type {
  ActionLedgerPort,
  ConsoleAction,
  ConsoleAgent,
  ConsoleResult,
  MainAgentPort,
  ProviderOverview,
} from '../src/deps.js'
import { preferredMainAgent } from '../src/routes/shared.js'
import { type SetupReadings, setupSnapshot } from '../src/setupState.js'
import {
  ADMIN,
  AGENTS,
  agentAt,
  BASE,
  browse,
  NOW,
  pageHarness,
  VIEW,
  visibleText,
} from './pageHarness.js'

function ok<T>(value: T): { readonly ok: true; readonly value: T } {
  return { ok: true, value }
}

function overview(
  over: Partial<ProviderOverview> & { readonly keySet?: boolean } = {},
): ProviderOverview {
  const keySet = over.keySet ?? true
  return {
    revision: 1,
    defaultProfileId: 'api2',
    nodes: [],
    profiles: [
      {
        profile: {
          id: 'api2',
          revision: 1,
          name: 'api2 网关',
          presetId: null,
          plan: 'paygo',
          site: null,
          lane: 'openai-responses',
          baseUrl: 'https://api2.example.com/v1',
          models: [
            {
              id: 'gpt-6-luna',
              role: 'main',
              tiers: [],
              capabilities: { mode: 'family' },
              effort: { send: 'auto' },
            },
          ],
          auth: { scheme: 'bearer' },
          keys: [{ id: 'k1' }],
          evaluated: false,
        },
        secrets: [{ keyId: 'k1', set: keySet }],
        nodes: [],
        isDefault: true,
      },
    ] as unknown as ProviderOverview['profiles'],
    ...over,
  }
}

function readings(over: Partial<SetupReadings> = {}): SetupReadings {
  return {
    now: NOW,
    accounts: ok({
      accounts: [{ role: 'ops', state: 'active' }],
      invites: [],
    }),
    modelWriter: true,
    providers: ok(overview()),
    presets: [],
    roster: ok(AGENTS),
    replicate: true,
    chatWired: true,
    mainPreferred: 'qianmo://tokyo-1/planner',
    mainFromPage: false,
    mainSettable: true,
    ...over,
  }
}

describe('setupSnapshot', () => {
  test('a finished console has nothing left', () => {
    const snap = setupSnapshot(readings())
    expect(snap.remaining).toBe(0)
    expect(snap.actionable).toBe(0)
    const model = snap.steps.find(step => step.id === 'model')
    expect(model?.state).toBe('done')
    expect(model?.summary).toContain('gpt-6-luna')
    expect(snap.steps.find(step => step.id === 'nodes')?.summary).toBe(
      '2 个节点在线 · 3 个智能体',
    )
  })

  test('a fresh console lists the four required steps in order', () => {
    const snap = setupSnapshot(
      readings({
        accounts: ok({ accounts: [], invites: [] }),
        providers: ok(overview({ defaultProfileId: null, profiles: [] })),
        roster: ok([]),
        mainPreferred: undefined,
      }),
    )
    expect(
      snap.steps.filter(step => step.kind === 'required').map(step => step.id),
    ).toEqual(['account', 'model', 'nodes', 'main'])
    expect(snap.remaining).toBe(4)
    expect(snap.actionable).toBe(4)
    expect(snap.steps[0]?.summary).toBe('还没有运维账号')
    expect(snap.steps[1]?.summary).toBe('还没有模型服务')
    expect(snap.steps[2]?.link?.href).toBe('/admin/servers?add=1')
  })

  test('a default profile without its key is not done', () => {
    const snap = setupSnapshot(
      readings({ providers: ok(overview({ keySet: false })) }),
    )
    const model = snap.steps.find(step => step.id === 'model')
    expect(model?.state).toBe('todo')
    expect(model?.link?.href).toBe('/admin/providers/profiles/api2')
  })

  test('what the console was not started with is blocked, not actionable', () => {
    const {
      accounts: _a,
      providers: _p,
      ...rest
    } = readings({
      roster: ok([]),
      replicate: false,
    })
    const snap = setupSnapshot(rest)
    const states = Object.fromEntries(
      snap.steps.map(step => [step.id, step.state]),
    )
    expect(states.account).toBe('blocked')
    expect(states.model).toBe('blocked')
    expect(states.nodes).toBe('blocked')
    expect(snap.remaining).toBe(4)
    // Only the main agent is left to do on the page, and it waits for nodes.
    expect(snap.actionable).toBe(1)
  })

  test('a console that cannot store the choice still works on the first agent', () => {
    const snap = setupSnapshot(
      readings({ mainSettable: false, mainPreferred: undefined }),
    )
    const main = snap.steps.find(step => step.id === 'main')
    expect(main?.state).toBe('done')
    expect(main?.summary).toBe('未指定 · 对话首页打开名册里第一个智能体')
    expect(snap.actionable).toBe(0)
  })

  test('a read failure is never shown as done', () => {
    const snap = setupSnapshot(
      readings({
        roster: {
          ok: false,
          failure: { code: 'unreachable', message: '超时' },
        },
      }),
    )
    const nodes = snap.steps.find(step => step.id === 'nodes')
    expect(nodes?.state).toBe('todo')
    expect(nodes?.summary).toBe('读取失败 · 超时')
  })

  test('offline agents do not count as nodes, and sort after online ones', () => {
    const snap = setupSnapshot(
      readings({
        roster: ok([
          agentAt('qianmo://a-1/x', { expiresAt: NOW - 1 }),
          agentAt('qianmo://b-1/y'),
        ]),
        mainPreferred: undefined,
      }),
    )
    expect(snap.steps.find(step => step.id === 'nodes')?.summary).toBe(
      '1 个节点在线 · 1 个智能体',
    )
    expect(snap.agents.map(agent => agent.address)).toEqual([
      'qianmo://b-1/y',
      'qianmo://a-1/x',
    ])
    expect(snap.steps.find(step => step.id === 'main')?.state).toBe('todo')
  })

  test('only presets that need nothing but a key are offered inline', () => {
    const preset = (id: string, group: string, vars = 0, listed = true) =>
      ({
        id,
        name: id,
        vendor: 'v',
        group,
        listed,
        templateVars: Array.from({ length: vars }, () => ({
          name: 'x',
          label: 'x',
        })),
        keyHint: null,
      }) as unknown as SetupReadings['presets'][number]
    const snap = setupSnapshot(
      readings({
        presets: [
          preset('a', 'cn-paygo'),
          preset('b', 'local'),
          preset('c', 'intl', 1),
          preset('d', 'plan', 0, false),
          preset('e', 'intl'),
        ],
      }),
    )
    expect(snap.presets.map(one => one.id)).toEqual(['a', 'e'])
  })
})

describe('preferredMainAgent', () => {
  test('the page choice wins over --chat-default, null falls back', () => {
    let value: string | null = 'qianmo://osaka-1/writer'
    const port: MainAgentPort = {
      get: () => value,
      set: async () => ok(null),
    }
    const base = pageHarness().deps
    expect(
      preferredMainAgent({
        ...base,
        chatDefault: 'qianmo://tokyo-1/planner',
        mainAgent: port,
      }),
    ).toBe('qianmo://osaka-1/writer')
    value = null
    expect(
      preferredMainAgent({
        ...base,
        chatDefault: 'qianmo://tokyo-1/planner',
        mainAgent: port,
      }),
    ).toBe('qianmo://tokyo-1/planner')
  })
})

class FakeMain implements MainAgentPort {
  value: string | null = null
  sets: (readonly [string | null, string])[] = []
  get(): string | null {
    return this.value
  }
  async set(address: string | null, by: string): Promise<ConsoleResult<null>> {
    this.sets.push([address, by])
    this.value = address
    return ok(null)
  }
}

class Ledger implements ActionLedgerPort {
  entries: ConsoleAction[] = []
  async record(entry: ConsoleAction): Promise<ConsoleResult<void>> {
    this.entries.push(entry)
    return ok(undefined)
  }
  async list(): Promise<never> {
    throw new Error('not here')
  }
}

function putMain(token: string, body: unknown): Request {
  return new Request(`${BASE}/v0/setup/main`, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  })
}

describe('the page and its API', () => {
  test('only someone who can administer sees it', async () => {
    const h = pageHarness({ chat: true })
    const viewer = await h.handle(browse('/admin/setup', VIEW))
    expect(viewer.status).toBe(404)
    const admin = await h.handle(browse('/admin/setup', ADMIN))
    expect(admin.status).toBe(200)
    const text = visibleText(await admin.text())
    for (const word of [
      '初始化配置',
      '运维账号',
      '接入模型',
      '服务器与节点',
      '主智能体',
      '任务模型',
      '可选',
    ]) {
      expect(text).toContain(word)
    }
    const api = await h.handle(
      new Request(`${BASE}/v0/setup`, {
        headers: { authorization: `Bearer ${VIEW}` },
      }),
    )
    expect(api.status).toBe(403)
  })

  test('the sidebar raises it with a count while there is work to do', async () => {
    const main = new FakeMain()
    const h = pageHarness({ chat: true, ports: { mainAgent: main } })
    // No --chat-default and no page choice: the main agent step is open.
    const page = await (await h.handle(browse('/admin/overview', ADMIN))).text()
    const nav = page.slice(page.indexOf('<nav class="nav"'))
    const setupAt = nav.indexOf('id="nav-setup"')
    expect(setupAt).toBeGreaterThan(-1)
    expect(setupAt).toBeLessThan(nav.indexOf('id="nav-overview"'))
    main.value = 'qianmo://tokyo-1/planner'
    const done = await (await h.handle(browse('/admin/overview', ADMIN))).text()
    const after = done.slice(done.indexOf('<nav class="nav"'))
    // Back in 管理, after the main group's items.
    expect(after.indexOf('id="nav-setup"')).toBeGreaterThan(
      after.indexOf('id="nav-desktop"') === -1
        ? after.indexOf('class="nav-group-name"')
        : after.indexOf('id="nav-desktop"'),
    )
  })

  test('PUT /v0/setup/main sets, records and resets', async () => {
    const main = new FakeMain()
    const actions = new Ledger()
    const h = pageHarness({ chat: true, actions, ports: { mainAgent: main } })
    const set = await h.handle(
      putMain(ADMIN, { address: 'qianmo://osaka-1/writer' }),
    )
    expect(set.status).toBe(200)
    expect(await set.json()).toEqual({ main: 'qianmo://osaka-1/writer' })
    expect(main.sets).toEqual([['qianmo://osaka-1/writer', 'legacy:admin']])
    expect(
      actions.entries.map(entry => [entry.action, entry.target, entry.outcome]),
    ).toEqual([['chat.main', 'qianmo://osaka-1/writer', 'ok']])
    const reset = await h.handle(putMain(ADMIN, { address: null }))
    expect(reset.status).toBe(200)
    expect(main.value).toBeNull()
    expect(actions.entries.at(-1)?.target).toBe('default')
  })

  test('PUT /v0/setup/main refuses what it cannot honour', async () => {
    const main = new FakeMain()
    const h = pageHarness({ chat: true, ports: { mainAgent: main } })
    expect((await h.handle(putMain(VIEW, { address: null }))).status).toBe(403)
    expect(
      (await h.handle(putMain(ADMIN, { address: 'not an address' }))).status,
    ).toBe(400)
    expect(
      (await h.handle(putMain(ADMIN, { address: 'qianmo://nowhere-1/ghost' })))
        .status,
    ).toBe(404)
    expect(main.sets).toEqual([])
    const unwired = pageHarness({ chat: true })
    expect(
      (await unwired.handle(putMain(ADMIN, { address: null }))).status,
    ).toBe(501)
  })

  test('the main agent form offers every agent, the current one selected', async () => {
    const main = new FakeMain()
    main.value = 'qianmo://osaka-1/writer'
    const h = pageHarness({ chat: true, ports: { mainAgent: main } })
    const page = await (await h.handle(browse('/admin/setup', ADMIN))).text()
    expect(page).toContain('id="setup-main-form"')
    expect(page).toContain(
      '<option value="qianmo://osaka-1/writer" selected>writer · osaka-1</option>',
    )
    expect(page).toContain('data-action="setup-main-reset"')
  })
})

test('an agent list with a non-qianmo address is not offered', () => {
  const snap = setupSnapshot(
    readings({
      roster: ok([
        agentAt('qianmo://tokyo-1/planner'),
        agentAt('occ://legacy/agent') as ConsoleAgent,
      ]),
    }),
  )
  expect(snap.agents.map(agent => agent.address)).toEqual([
    'qianmo://tokyo-1/planner',
  ])
})
