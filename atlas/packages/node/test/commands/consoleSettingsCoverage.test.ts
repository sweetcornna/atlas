// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Every entry an agent may ask for (P40 `agent-settings.md` §2), against the
 * console with one stateful fake per port, the way the page preview wires it
 * (`console/test/preview/serve.ts`): the preview binds it, its value read
 * included, and the request it makes lands on the console's own route and is
 * carried out there.
 *
 * Each entry has one small sample beside this test. An entry with no sample,
 * or a sample for an entry a person alone may change, is red: a new entry
 * comes with its sample. The few entries the harness cannot carry out are
 * listed in {@link NOT_RUN} with the reason.
 */

import { describe, expect, test } from 'bun:test'
import {
  type AgentModelChange,
  type AgentModelsAgentView,
  type AgentModelsPort,
  type AgentModelsSnapshot,
  type ChatSession,
  type ChatTranscript,
  type ConsoleDeps,
  type ConsoleResult,
  type ServerNote,
  type ServerNotesPort,
  settingOperation,
  settingOperations,
} from '@qianmo/console'
import {
  type AccountsHarness,
  ManualClock,
  accountsHarness,
  person,
} from '../../../console/test/accountsHarness.js'
import {
  FakeChannels,
  FakeExtensions,
  FakeMagpie,
  FakeUpdates,
  PREVIEW_PORTS,
} from '../../../console/test/directionFakes.js'
import {
  PLANNER,
  REVIEWER,
  SLEEPER,
  StatefulLifecycle,
} from '../../../console/test/lifecycleFake.js'
import { MemoryActionLedger } from '../../../console/test/memoryActions.js'
import { PageAudit, PageRegistry } from '../../../console/test/pageHarness.js'
import {
  CHAT_URL,
  FakeProviders,
  FINGERPRINT,
  SHORT_FINGERPRINT,
} from '../../../console/test/providersFake.js'
import { MemoryNotify, notice } from '../../../console/test/watchFakes.js'
import { ConsoleSettings } from '../../src/commands/consoleSettings.js'

const NODE = 'tokyo-1'
const AGENT = 'main'
const CHAT = 'chat-ops'
const TASK = 'task-1'
const ORIGIN = 'http://console.in-process'

/** One entry's sample: what the agent would pass for it. */
interface Sample {
  readonly target?: Record<string, unknown>
  readonly input?: Record<string, unknown>
}

const PLANNER_AT = { node: 'tokyo-1', agent: 'planner' }
/** An agent the gateway page knows (`FakeMagpieAgents`). */
const CODER_AT = { node: 'tokyo-1', agent: 'coder' }
const SCHEDULE = {
  title: '晨报',
  target: PLANNER,
  template: 'custom',
  prompt: '写今天的晨报',
  when: { kind: 'interval', everyMinutes: 30 },
  timezone: 'Asia/Tokyo',
  direction: null,
  channels: [],
  notifyOnlyAgent: false,
  enabled: true,
  timeoutMs: 600_000,
}

const SAMPLES: Readonly<Record<string, Sample>> = {
  'providers.default': { input: { profileId: 'chat-svc' } },
  'providers.profile.create': {
    input: { presetId: 'deepseek', profile: { name: '另一份' } },
  },
  'providers.profile.save': {
    target: { profileId: 'chat-svc' },
    input: { profile: { name: '改个名' }, ifMatch: 1 },
  },
  'providers.profile.remove': {
    target: { profileId: 'spare' },
    input: { ifMatch: 1 },
  },
  'providers.key.set': {
    target: { profileId: 'chat-svc', keyId: 'k1' },
    input: { value: 'sk-test-0123456789abcdef', ifMatch: 1 },
  },
  'providers.key.clear': {
    target: { profileId: 'deepseek', keyId: 'k1' },
    input: { ifMatch: 3 },
  },
  'providers.node.assignment': {
    target: { node: 'node-a' },
    input: { mode: 'profile', profileId: 'chat-svc' },
  },
  'providers.node.context': {
    target: { node: 'node-a' },
    input: { tokens: 300_000 },
  },
  'providers.node.autocompact': {
    target: { node: 'node-a' },
    input: { value: 80 },
  },
  'providers.apply': { input: { nodes: ['node-a'] } },
  'providers.import': { input: { text: '{}' } },
  'routing.set': {
    target: { node: null },
    input: { auto: false, routes: [], revision: 3 },
  },
  'routing.node.reset': { target: { node: 'node-a' } },
  'magpie.connect': {
    input: {
      gatewayUrl: 'https://gw2.tokyo.example:8443',
      managementUrl: 'http://127.0.0.1:3431',
    },
  },
  'magpie.check': {},
  'magpie.provider.add': {
    input: { preset: 'anthropic', key: 'sk-ant-0123456789' },
  },
  'magpie.provider.toggle': {
    target: { id: 'openai' },
    input: { enabled: false },
  },
  'magpie.provider.remove': { target: { id: 'codex' } },
  'magpie.provider.test': { target: { id: 'openai' } },
  'magpie.group.save': { target: { id: 'fast' }, input: { name: '快车道' } },
  'magpie.group.remove': { target: { id: 'mixed' } },
  'magpie.key.issue': {
    input: { binding: 'node:osaka-1', mainModel: 'openai/gpt-6' },
  },
  'magpie.key.update': {
    target: { binding: 'node:tokyo-1' },
    input: { enabled: false },
  },
  'magpie.key.remove': { target: { binding: 'node:tokyo-1' } },
  'magpie.key.rotate': { target: { binding: 'node:tokyo-1' } },
  'magpie.autojoin': { input: { on: false } },
  'magpie.join': { target: { node: 'osaka-1' } },
  'agents.runtime': { target: CODER_AT, input: { runtime: 'claude-code' } },
  'agents.model': {
    target: { ...CODER_AT, field: 'model' },
    input: { value: 'openai/gpt-6' },
  },
  'agents.runtime.install': { target: { node: 'tokyo-1', runtime: 'codex' } },
  'agents.runtime.remove': { target: { node: 'tokyo-1', runtime: 'dsh' } },
  'agents.extension.install': {
    target: CODER_AT,
    input: { kind: 'skill', source: 'qianmo/skills' },
  },
  'agents.extension.remove': {
    target: CODER_AT,
    input: { kind: 'skill', name: 'notes' },
  },
  'agents.avatar.set': {
    target: { address: PLANNER },
    input: {
      shape: 'drop',
      color: 'sage',
      material: 'glaze',
      eyes: 'oval',
      mouth: 'smile',
      cheeks: true,
      accessory: 'sprout',
    },
  },
  'agents.avatar.reset': { target: { address: PLANNER } },
  'nodes.agent.publish': {
    input: { address: 'qianmo://tokyo-1/scout', endpoint: 'ws://127.0.0.1:1' },
  },
  'nodes.agent.deregister': { target: { address: REVIEWER } },
  'nodes.agent.pause': { target: { address: PLANNER } },
  'nodes.agent.resume': { target: { address: SLEEPER } },
  'nodes.agent.retire': { target: { address: REVIEWER } },
  'setup.main': { input: { address: PLANNER } },
  'im.save': {
    target: { id: 'ch-1' },
    input: {
      name: '值班群',
      platform: 'qq',
      target: PLANNER,
      prompt: '回答简短',
    },
  },
  'im.remove': { target: { id: 'ch-1' } },
  'schedules.create': { input: SCHEDULE },
  'schedules.save': { target: { id: 'sch-1' }, input: SCHEDULE },
  'schedules.remove': { target: { id: 'sch-1' } },
  'schedules.enabled': { target: { id: 'sch-1' }, input: { enabled: false } },
  'schedules.run': { target: { id: 'sch-1' } },
  'schedules.resolve': {
    target: { id: 'sch-1', runId: 'run-1' },
    input: { outcome: 'ok' },
  },
  'notify.create': {
    input: { name: '值班', kind: 'webhook', url: 'https://hooks.example/x' },
  },
  // The fake wants an address on every save; the node keeps the old one.
  'notify.save': {
    target: { id: 'ch-1' },
    input: { name: '我的新手机', kind: 'bark', url: 'https://api.day.app/k2' },
  },
  'notify.remove': { target: { id: 'ch-1' } },
  'notify.test': { target: { id: 'ch-1' } },
  'extensions.create': {
    input: { kind: 'skill', name: 'notes', body: '# 记笔记' },
  },
  'extensions.save': {
    target: { id: 'ext-00000000-0000-4000-8000-000000000001' },
    input: { enabled: false },
  },
  'extensions.remove': {
    target: { id: 'ext-00000000-0000-4000-8000-000000000002' },
  },
  'connectors.create': {
    input: {
      name: '工作邮箱',
      kind: 'mail',
      preset: 'qq-mail',
      settings: { address: 'a@qq.com' },
      secret: 'app-password-0123',
      agents: [PLANNER],
    },
  },
  'connectors.save': {
    target: { id: 'con-1' },
    input: {
      name: '改名邮箱',
      kind: 'mail',
      preset: 'qq-mail',
      settings: { address: 'a@qq.com' },
      agents: [PLANNER],
    },
  },
  'connectors.remove': { target: { id: 'con-2' } },
  'connectors.probe': { target: { id: 'con-1' } },
  'desktop.set': { target: PLANNER_AT, input: { browser: false } },
  'desktop.recycle': { target: PLANNER_AT },
  'elevation.off': { target: PLANNER_AT, input: { tier: 'off' } },
  'elevation.revoke': { target: PLANNER_AT },
  'elevation.revoke-all': {},
  'servers.note': { target: { server: 'p11' }, input: { note: '换过硬盘' } },
  'updates.save': {
    input: {
      times: [{ kind: 'daily', time: '04:00' }],
      timezone: 'Asia/Tokyo',
      actions: { qianmopi: 'notify' },
      channels: [],
      repo: null,
    },
  },
  'updates.run': {},
  'updates.upgrade': { input: {} },
  'updates.rollback': { input: {} },
  'alerts.ack': { target: { id: 'n-disk' } },
  'files.revoke': { target: { id: 'fg-1' } },
  'files.transfer': {
    input: {
      sources: [{ agent: PLANNER, path: 'reports/a.md' }],
      target: 'qianmo://osaka-1/writer',
    },
  },
  'files.retry': { target: { id: 'ft-3' } },
}

/**
 * Entries whose request the harness cannot carry out to the end, with the
 * status the console answers and why. Each still reaches its own route.
 */
const NOT_RUN: Readonly<
  Record<string, { readonly status: number; readonly why: string }>
> = {}

/** One agent's model field on tokyo-1, the way `/v0/magpie/agents/models` shows it. */
class Models implements AgentModelsPort {
  value = 'deepseek/deepseek-v4'
  #agent(): AgentModelsAgentView {
    return {
      agent: 'coder',
      runtime: 'dsh',
      runtimeLabel: 'DeepSeek Harness',
      fields: [
        {
          key: 'model',
          label: '主模型',
          kind: 'model',
          tier: null,
          value: this.value,
          follows: null,
          levels: [],
          sameSource: false,
          locked: null,
          pending: false,
        },
      ],
      sources: [],
      source: null,
      write: null,
    }
  }
  snapshot(): Promise<ConsoleResult<AgentModelsSnapshot>> {
    return Promise.resolve({
      ok: true,
      value: {
        nodes: [
          {
            node: 'tokyo-1',
            state: 'ok',
            fields: true,
            agents: [this.#agent()],
            error: null,
          },
        ],
      },
    })
  }
  set(change: AgentModelChange): Promise<ConsoleResult<AgentModelsAgentView>> {
    this.value = change.value
    return Promise.resolve({ ok: true, value: this.#agent() })
  }
}

class Notes implements ServerNotesPort {
  readonly stored = new Map<string, ServerNote>()
  list(): Promise<ConsoleResult<readonly ServerNote[]>> {
    return Promise.resolve({ ok: true, value: [...this.stored.values()] })
  }
  set(server: string, note: string): Promise<ConsoleResult<ServerNote>> {
    const record: ServerNote = { server, note, updatedAt: 1 }
    this.stored.set(server, record)
    return Promise.resolve({ ok: true, value: record })
  }
}

/** One conversation: the ops person's, a turn still running in it. */
function conversation(): {
  transcript(id: string): Promise<ConsoleResult<ChatTranscript>>
} {
  const session: ChatSession = {
    id: CHAT,
    target: `qianmo://${NODE}/${AGENT}`,
    node: NODE,
    agent: AGENT,
    createdAt: 1,
    updatedAt: 1,
    turnCount: 1,
    preview: '',
  }
  return {
    transcript: id =>
      Promise.resolve(
        id === CHAT
          ? {
              ok: true,
              value: {
                session,
                turns: [
                  {
                    id: 'ask',
                    sessionId: CHAT,
                    author: 'operator',
                    at: 1,
                    text: '改一下',
                    state: 'delivered',
                    taskId: TASK,
                  },
                ],
              },
            }
          : { ok: false, failure: { code: 'not_found', message: '没有' } },
      ),
  }
}

/** The preview harness's console, a fresh one for every entry. */
async function console_(): Promise<{
  readonly h: AccountsHarness
  readonly settings: ConsoleSettings
  readonly ops: Parameters<AccountsHarness['handle']['as']>[0]
}> {
  const clock = new ManualClock(Date.now())
  const now = clock.now
  const ports = Object.fromEntries(
    Object.entries(PREVIEW_PORTS).map(([name, make]) => [name, make(now)]),
  ) as Partial<ConsoleDeps>
  let main: string | null = null
  // A profile no node uses, so that one can be removed.
  const providers = new FakeProviders()
  const chat = providers.profiles.get('chat-svc')
  if (chat !== undefined)
    providers.profiles.set('spare', { ...chat, id: 'spare', name: '备用' })
  const h = accountsHarness({
    clock,
    deps: {
      registry: new PageRegistry(),
      audit: new PageAudit(),
      lifecycle: new StatefulLifecycle(),
      mainAgent: {
        get: () => main,
        set: async address => {
          main = address
          return { ok: true, value: null }
        },
      },
      nodeServers: [{ node: NODE, server: 'p11' }],
      serverNotes: new Notes(),
      actions: new MemoryActionLedger(),
      notify: new MemoryNotify([notice('n-disk', 'warn', '磁盘快满了')]),
      providers,
      agentModels: new Models(),
      channels: new FakeChannels(now),
      updates: new FakeUpdates(now),
      extensions: new FakeExtensions(),
      magpie: new FakeMagpie(),
      ...ports,
    },
  })
  const who = await person(h.handle, 'ops')
  const found = h.book.bearerPrincipal(who.credential)
  if (!found.ok) throw new Error('no ops person')
  const ops = found.value
  if (ops.kind !== 'user') throw new Error('no ops person')
  expect(h.book.recordOwner(CHAT, ops.subject).ok).toBe(true)
  const settings = new ConsoleSettings({
    chat: conversation(),
    accounts: { book: h.book },
    approvals: { consumeSettings: () => null },
    console: () => h.handle.as,
  })
  return { h, settings, ops }
}

function chars(text: string | null): number {
  return text === null ? 0 : [...text].length
}

describe('every entry an agent may ask for (P40 §2)', () => {
  const requestable = settingOperations().filter(op => op.human === undefined)

  test('has a sample, and only those do', () => {
    expect(requestable.map(op => op.id).filter(id => !(id in SAMPLES))).toEqual(
      [],
    )
    expect(
      Object.keys(SAMPLES).filter(
        id =>
          settingOperation(id)?.human !== undefined || !settingOperation(id),
      ),
    ).toEqual([])
    for (const id of Object.keys(NOT_RUN)) expect(id in SAMPLES).toBe(true)
  })

  for (const op of requestable) {
    test(`${op.id}: previewed with its value, carried out on its own route`, async () => {
      const sample = SAMPLES[op.id]
      if (sample === undefined) return
      const { h, settings, ops } = await console_()
      const preview = await settings.handle(
        'settings.preview',
        {
          id: op.id,
          ...(sample.target === undefined ? {} : { target: sample.target }),
          ...(sample.input === undefined ? {} : { input: sample.input }),
          contextId: CHAT,
          taskId: TASK,
        },
        { node: NODE, agent: AGENT, callId: 'c' },
      )
      expect(preview.ok ? 'bound' : preview.message).toBe('bound')
      if (!preview.ok) return
      const bound = (
        preview.value as { bound: { card: Record<string, string | null> } }
      ).bound
      const card = bound.card
      // What only a writer reads on the panel stays out of what the agent
      // reads and what the approval keeps.
      const listed = await settings.handle(
        'settings.list',
        {
          id: op.id,
          ...(sample.target === undefined ? {} : { target: sample.target }),
          contextId: CHAT,
          taskId: TASK,
        },
        { node: NODE, agent: AGENT, callId: 'c' },
      )
      for (const text of [JSON.stringify(bound), JSON.stringify(listed)])
        for (const writerOnly of [CHAT_URL, FINGERPRINT, SHORT_FINGERPRINT])
          expect(text).not.toContain(writerOnly)
      expect(chars(card['current'] ?? null)).toBeLessThanOrEqual(200)
      expect(chars(card['next'] ?? null)).toBeLessThanOrEqual(200)
      expect(chars(card['title'] ?? null)).toBeLessThanOrEqual(120)
      if (sample.target !== undefined)
        expect(
          chars((card['title'] ?? '').split(' · ').at(-1) ?? ''),
        ).toBeLessThanOrEqual(48)

      const { method, path, body } = op.request(
        sample.target ?? {},
        sample.input ?? {},
      )
      const response = await h.handle.as(
        ops,
        new Request(`${ORIGIN}${path}`, {
          method,
          headers: {
            accept: 'application/json',
            'content-type': 'application/json',
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      )
      const said = await response.text()
      const expected = NOT_RUN[op.id]
      if (expected === undefined)
        expect(`${response.status} ${said.slice(0, 300)}`).toMatch(/^2\d\d /)
      else expect(response.status).toBe(expected.status)
    })
  }
})

describe('what only a person may widen (P40 §2)', () => {
  const preview = async (
    settings: ConsoleSettings,
    id: string,
    target: Record<string, unknown>,
    input: Record<string, unknown>,
    op = 'settings.preview',
  ): Promise<string> => {
    const outcome = await settings.handle(
      op,
      {
        id,
        target,
        input,
        contextId: CHAT,
        taskId: TASK,
        ...(op === 'settings.apply' ? { approvalId: 'a'.repeat(32) } : {}),
      },
      { node: NODE, agent: AGENT, callId: 'c' },
    )
    return outcome.ok ? 'bound' : outcome.message
  }

  test('the desktop: narrowing may be asked for, widening is refused with where to go', async () => {
    const { settings } = await console_()
    const refusal = `只能本人操作 · ${settingOperation('desktop.set')?.personOnly?.note}`
    // The planner has a browser and a computer, asks on sensitive steps,
    // opens three apps and no terminal.
    for (const input of [
      { terminal: true },
      { confirm: 'autonomous' },
      { apps: 'all' },
      { apps: ['firefox-esr', 'org.gnome.Terminal'] },
    ]) {
      expect(await preview(settings, 'desktop.set', PLANNER_AT, input)).toBe(
        refusal,
      )
      expect(
        await preview(
          settings,
          'desktop.set',
          PLANNER_AT,
          input,
          'settings.apply',
        ),
      ).toBe(refusal)
    }
    for (const input of [
      { confirm: 'always' },
      { apps: 'none' },
      { apps: ['firefox-esr'] },
      { browser: false, computer: false },
    ])
      expect(await preview(settings, 'desktop.set', PLANNER_AT, input)).toBe(
        'bound',
      )
    // An agent the console does not know has nothing to narrow.
    expect(
      await preview(
        settings,
        'desktop.set',
        { node: 'tokyo-1', agent: 'nobody' },
        { browser: true },
      ),
    ).toBe(refusal)
  })

  test('a channel: its words may change, who reaches whom may not', async () => {
    const { settings } = await console_()
    const refusal = `只能本人操作 · ${settingOperation('im.save')?.personOnly?.note}`
    const same = { name: '工作 QQ', platform: 'qq', target: PLANNER }
    for (const input of [
      { ...same, ownerIds: ['OWNER-OPENID', 'SOMEONE-ELSE'] },
      { ...same, allowAll: true },
      { ...same, allowGroups: [] },
      { ...same, pairing: 'off' },
      { ...same, memberTarget: PLANNER },
      { ...same, target: 'qianmo://osaka-1/writer' },
    ])
      expect(await preview(settings, 'im.save', { id: 'ch-1' }, input)).toBe(
        refusal,
      )
    expect(
      await preview(
        settings,
        'im.save',
        { id: 'ch-1' },
        { ...same, ownerIds: ['OWNER-OPENID'], groupTrigger: 'all' },
      ),
    ).toBe('bound')
  })

  test('the list says so before anybody asks', async () => {
    const { settings } = await console_()
    const listed = await settings.handle(
      'settings.list',
      { area: 'desktop', contextId: CHAT, taskId: TASK },
      { node: NODE, agent: AGENT, callId: 'c' },
    )
    if (!listed.ok) throw new Error(listed.message)
    const rows = (listed.value as { settings: Record<string, unknown>[] })
      .settings
    expect(rows.find(row => row['id'] === 'desktop.set')).toMatchObject({
      personOnly: settingOperation('desktop.set')?.personOnly?.note,
    })
  })
})
