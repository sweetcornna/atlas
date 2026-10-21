// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `qianmo_settings_list` and `qianmo_settings_change` on the node (P40,
 * `agent-settings.md` §3–§4, §8 「节点」): arguments checked before the hub
 * hears anything; preview → one approval of exactly `bound` → apply with the
 * approval it was given; a person's no, a wait that ran out and a turn that
 * cannot ask each answered as what they are; and, with the real grant store,
 * a 批准并继续 turn using the approval already given, once.
 */

import { expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { adaptSchemaForStrict } from '@oh-my-pi/pi-ai'
import {
  generateNodeKeyPair,
  signAuthzDecision,
  type AuthzRequest,
} from '@qianmo/capability'
import type { ControlOutcome } from '@qianmo/protocol'
import { ResidentEstop } from '@qianmo/resident'
import { ResidentAuthorization } from '../../src/host/residentAuthorization.js'
import {
  settingsTools,
  type SettingsApproval,
  type SettingsToolsOptions,
  type SettingsUnavailable,
} from '../../src/host/settingsTools.js'

const ctx = { agent: 'ops', sessionId: 's-1' }

const BOUND = {
  id: 'providers.default',
  target: null,
  input: { profileId: 'claude-gw' },
  card: {
    area: '模型',
    label: '默认模型服务',
    title: '把默认模型服务改成 Claude 网关',
    current: 'api2',
    next: 'Claude 网关',
    role: 'ops',
    page: '/admin/providers#routing',
  },
}

type Call = [string, Record<string, unknown>, Record<string, unknown>]

function harness(
  options: {
    preview?: ControlOutcome
    apply?: ControlOutcome | Error
    approval?: SettingsApproval
    unavailable?: SettingsUnavailable | null
    origin?: null
    approve?: SettingsToolsOptions['approve']
  } = {},
) {
  const calls: Call[] = []
  const approvals: [string, Record<string, unknown>][] = []
  const tools = settingsTools({
    call: async (op, args, callOptions) => {
      calls.push([op, args, callOptions])
      if (op === 'settings.list')
        return { ok: true, value: { areas: [{ area: 'providers' }] } }
      if (op === 'settings.preview')
        return options.preview ?? { ok: true, value: { bound: BOUND } }
      if (options.apply instanceof Error) throw options.apply
      return (
        options.apply ?? {
          ok: true,
          value: { summary: '默认模型服务已改为 Claude 网关', result: {} },
        }
      )
    },
    origin: () =>
      options.origin === null
        ? null
        : { contextId: 'console-session', taskId: 'turn-7' },
    unavailable: () => options.unavailable ?? null,
    approve:
      options.approve ??
      (async (_ctx, toolName, input) => {
        approvals.push([toolName, input])
        return (
          options.approval ?? {
            kind: 'allowed',
            contextId: 'console-session',
            requestId: 'a'.repeat(32),
          }
        )
      }),
  })
  const byName = (name: string) => tools.find(tool => tool.name === name)!
  return {
    calls,
    approvals,
    tools,
    list: (args: unknown) => byName('qianmo_settings_list').handler(args, ctx),
    change: (args: unknown) =>
      byName('qianmo_settings_change').handler(args, ctx),
    ops: () => calls.map(([op]) => op),
  }
}

const CHANGE = { id: 'providers.default', input: { profileId: 'claude-gw' } }
/** The conversation and turn every call carries up, for the hub to check. */
const TURN = { contextId: 'console-session', taskId: 'turn-7' }

test('two tools with closed schemas; the change tool says list first, one change, a person approves, unknown is never retried', () => {
  const { tools } = harness()
  expect(tools.map(tool => tool.name)).toEqual([
    'qianmo_settings_list',
    'qianmo_settings_change',
  ])
  for (const tool of tools)
    expect(tool.parameters).toMatchObject({
      type: 'object',
      additionalProperties: false,
    })
  expect(tools[1]!.parameters).toMatchObject({ required: ['id'] })
  const description = tools[1]!.description
  expect(description).toContain('qianmo_settings_list (read it first)')
  expect(description).toContain('one change per call')
  expect(description).toContain('waits for a person to approve it')
  expect(description).toContain('批准并继续')
  expect(description).toContain('cannot be changed by an agent')
  expect(description).toContain('never retry automatically')
})

test('arguments are checked before the hub hears anything; null counts as left out', async () => {
  const h = harness()
  for (const bad of [
    null,
    [],
    'providers.default',
    {},
    { id: '' },
    { id: 7 },
    { id: 'x'.repeat(201) },
    { id: 'providers.default', extra: true },
    { id: 'providers.default', target: [] },
    { id: 'providers.default', target: 'profile' },
    { id: 'providers.default', input: 'claude-gw' },
    { id: 'providers.default', input: ['claude-gw'] },
    { id: 'providers.default', operationId: 'x' },
    { id: 'providers.default', approvalId: 'a'.repeat(32) },
  ])
    expect(await h.change(bad)).toEqual({
      ok: false,
      text: 'Invalid arguments.',
    })
  for (const bad of [
    null,
    { area: 7 },
    { area: '' },
    { area: 'providers', extra: 1 },
  ])
    expect(await h.list(bad)).toEqual({ ok: false, text: 'Invalid arguments.' })
  expect(h.calls).toEqual([])
  expect(h.approvals).toEqual([])
  // A model that fills every optional field with null still gets through,
  // and the nulls never reach the hub.
  expect((await h.change({ ...CHANGE, target: null })).ok).toBe(true)
  expect(h.calls[0]).toEqual([
    'settings.preview',
    { ...CHANGE, ...TURN },
    { agent: 'ops' },
  ])
  expect((await h.list({ area: 'providers', id: null })).ok).toBe(true)
  expect(h.calls.at(-1)).toEqual([
    'settings.list',
    { area: 'providers', ...TURN },
    { agent: 'ops' },
  ])
})

test('listing forwards area and id and returns what the hub said', async () => {
  const h = harness()
  const listed = await h.list({})
  expect(listed.ok).toBe(true)
  expect(JSON.parse(listed.text)).toEqual({ areas: [{ area: 'providers' }] })
  expect(h.calls).toEqual([['settings.list', TURN, { agent: 'ops' }]])
  expect(h.approvals).toEqual([])
  // Outside a conversation there is nothing for the hub to check it against.
  const outside = harness({ origin: null })
  expect(await outside.list({})).toEqual({
    ok: false,
    text: '设置只能在控制台或聊天渠道的对话里读写。',
  })
  expect((await outside.change(CHANGE)).text).toContain('进行中回合')
  expect(outside.calls).toEqual([])
})

test('approved: the approval binds exactly the preview, and apply carries the real arguments with approvalId, contextId and its own callId', async () => {
  const h = harness()
  const secret = {
    id: 'providers.upsert',
    target: { profileId: 'claude-gw' },
    input: { key: 'sk-real-secret-abcd' },
  }
  const bound = {
    ...BOUND,
    id: 'providers.upsert',
    input: { key: { $secret: '…abcd', sha256: 'f'.repeat(64) } },
  }
  const withSecret = harness({ preview: { ok: true, value: { bound } } })
  const done = await withSecret.change(secret)
  expect(done.ok).toBe(true)
  expect(JSON.parse(done.text)).toEqual({
    summary: '默认模型服务已改为 Claude 网关',
    result: {},
  })
  // The person approves the hub's bound, secrets masked, nothing added.
  expect(withSecret.approvals).toEqual([['qianmo_settings_change', bound]])
  expect(withSecret.ops()).toEqual(['settings.preview', 'settings.apply'])
  const [, previewArgs] = withSecret.calls[0]!
  expect(previewArgs).toEqual({ ...secret, ...TURN })
  const [, applyArgs, applyOptions] = withSecret.calls[1]!
  expect(applyArgs).toEqual({
    ...secret,
    ...TURN,
    approvalId: 'a'.repeat(32),
  })
  expect(applyOptions).toEqual({
    agent: 'ops',
    callId: expect.stringMatching(/^\S{8,}$/),
  })
  // Every change has a call id of its own.
  await h.change(CHANGE)
  await h.change(CHANGE)
  const ids = h.calls
    .filter(([op]) => op === 'settings.apply')
    .map(([, , options]) => options['callId'])
  expect(new Set(ids).size).toBe(2)
})

test('a preview refusal reaches the model in the hub’s words, and nothing is asked or applied', async () => {
  for (const message of [
    '只能本人操作：在 /admin/access 由运维本人发邀请',
    '值没有变化：默认模型服务已经是 Claude 网关',
    '这个对话不是一个正在进行的人发起的回合',
  ]) {
    const h = harness({
      preview: { ok: false, code: 'refused', message },
    })
    const refused = await h.change(CHANGE)
    expect(refused).toMatchObject({ ok: false, text: message })
    expect(h.approvals).toEqual([])
    expect(h.ops()).toEqual(['settings.preview'])
  }
  // A preview that did not come back, or came back without a bound for this
  // id, changes nothing either.
  for (const preview of [
    { ok: false, code: 'unknown', message: '请求已写入连接，执行结果未知' },
    { ok: true, value: {} },
    { ok: true, value: { bound: { ...BOUND, id: 'providers.remove' } } },
    { ok: true, value: { bound: { ...BOUND, card: null } } },
  ] as ControlOutcome[]) {
    const h = harness({ preview })
    const refused = await h.change(CHANGE)
    expect(refused.ok).toBe(false)
    expect(refused.text).toContain('没有更改任何设置')
    expect(h.approvals).toEqual([])
    expect(h.ops()).toEqual(['settings.preview'])
  }
})

test('denied, waiting and refused are told apart, and none of them applies', async () => {
  const denied = harness({
    approval: { kind: 'denied', requestId: 'b'.repeat(32) },
  })
  expect(await denied.change(CHANGE)).toEqual({
    ok: false,
    text: '用户拒绝了这次更改 · 没有执行',
  })
  expect(denied.ops()).toEqual(['settings.preview'])

  const waiting = harness({
    approval: { kind: 'pending', requestId: 'c'.repeat(32) },
  })
  const pending = await waiting.change(CHANGE)
  expect(pending.ok).toBe(false)
  expect(pending.text).toContain(`编号 ${'c'.repeat(32)}`)
  expect(pending.text).toContain('批准并继续')
  expect(pending.text).toContain('完全相同的参数')
  expect(pending.text).toContain('别换参数重发')
  expect(waiting.ops()).toEqual(['settings.preview'])

  const refused = harness({ approval: { kind: 'refused' } })
  const no = await refused.change(CHANGE)
  expect(no.ok).toBe(false)
  expect(no.text).toContain('没有执行')
  expect(no.text).toContain('不要自动重试')
  expect(refused.ops()).toEqual(['settings.preview'])
})

test('a turn that cannot ask anyone says why, before the hub is asked', async () => {
  const reasons: Record<SettingsUnavailable, string> = {
    'no-approver': '--approver',
    'no-turn': '进行中回合',
    unsigned: '签名的人',
    background: '后台任务与定时作业',
  }
  for (const [reason, says] of Object.entries(reasons) as [
    SettingsUnavailable,
    string,
  ][]) {
    const h = harness({ unavailable: reason })
    const answer = await h.change(CHANGE)
    expect(answer.ok).toBe(false)
    expect(answer.text).toStartWith('这里不能改设置')
    expect(answer.text).toContain(says)
    expect(h.calls).toEqual([])
    // Listing is a read: it does not need a person.
    expect((await h.list({})).ok).toBe(true)
  }
  // The turn ended while the hub was previewing: the approval step says so.
  const late = harness({
    approval: { kind: 'unavailable', reason: 'no-turn' },
  })
  const answer = await late.change(CHANGE)
  expect(answer.text).toContain('进行中回合')
  expect(late.ops()).toEqual(['settings.preview'])
})

test('apply: the hub’s refusal is passed on; an unknown outcome is never to be retried', async () => {
  const stale = harness({
    apply: {
      ok: false,
      code: 'refused',
      message: '批准已失效：这一项在批准之后被改过，需要重新申请',
    },
  })
  expect(await stale.change(CHANGE)).toMatchObject({
    ok: false,
    text: '批准已失效：这一项在批准之后被改过，需要重新申请',
  })
  for (const apply of [
    { ok: false, code: 'unknown', message: '请求已写入连接，执行结果未知' },
    new Error('socket closed'),
  ] as const) {
    const h = harness({ apply })
    const unknown = await h.change(CHANGE)
    expect(unknown.ok).toBe(false)
    expect(unknown.text).toContain('结果未知')
    expect(unknown.text).toContain('不要自动重试')
  }
})

test('with the real grant store: a wait that runs out names the request, the person approves, the 批准并继续 turn applies on that approval without a second card, and only once', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p40-settings-'))
  const approver = generateNodeKeyPair()
  const auth = new ResidentAuthorization({
    node: 'worker',
    keys: generateNodeKeyPair(),
    approvers: new Map([['hub', approver.publicKey]]),
    commanderKeys: () => [],
    memoryRoot: root,
    estop: new ResidentEstop({ path: path.join(root, 'ESTOP') }),
  })
  const origin = {
    from: 'qianmo://hub/console',
    taskId: 'turn-1',
    traceId: null,
    trust: 'verified-capability' as const,
  }
  const decision = (request: AuthzRequest, kind: 'allow-once' | 'deny') =>
    signAuthzDecision(approver, {
      v: 1,
      requestId: request.requestId,
      aud: request.iss,
      sub: request.sub,
      digest: request.digest,
      decision: kind,
      windowMs: 0,
      approver: 'hub/u:0123456789abcdef',
      nbf: Date.now(),
      exp: Date.now() + 60_000,
      nonce: crypto.randomUUID(),
    })
  const sent: AuthzRequest[] = []
  let answer: ((request: AuthzRequest) => void) | undefined
  const h = harness({
    approve: async (turn, toolName, input) => {
      const outcome = await auth.requestOutcome(
        { toolName, input, agent: turn.agent, contextId: 'console-session' },
        origin,
        // A wait of 80 ms instead of 60 s.
        Date.now() + 80,
        120_000,
        request => {
          sent.push(request)
          answer?.(request)
        },
      )
      return outcome.kind === 'allowed'
        ? { ...outcome, contextId: 'console-session' }
        : outcome
    },
  })
  try {
    // Turn 1: nobody answers in time. The request stays open.
    const waited = await h.change(CHANGE)
    expect(sent).toHaveLength(1)
    const first = sent[0]!
    expect(first.toolName).toBe('qianmo_settings_change')
    expect(first.input).toEqual(BOUND)
    expect(waited.text).toContain(`编号 ${first.requestId}`)
    expect(h.ops()).toEqual(['settings.preview'])
    // The person approves it after the wait (the hub's 批准并继续 decides
    // allow-once, then starts the next turn).
    expect(auth.decision(decision(first, 'allow-once'))).toBe(true)
    // Turn 2: the identical call. No second card; apply carries the grant's id.
    const applied = await h.change(CHANGE)
    expect(applied.ok).toBe(true)
    expect(sent).toHaveLength(1)
    const apply = h.calls.filter(([op]) => op === 'settings.apply')
    expect(apply).toHaveLength(1)
    expect(apply[0]![1]).toMatchObject({
      approvalId: first.requestId,
      contextId: 'console-session',
    })
    // Turn 3: the grant is spent. The same call asks again, as a new request,
    // and a person's no is a no.
    answer = request => auth.decision(decision(request, 'deny'))
    const again = await h.change(CHANGE)
    expect(again.text).toBe('用户拒绝了这次更改 · 没有执行')
    expect(sent).toHaveLength(2)
    expect(sent[1]!.requestId).not.toBe(first.requestId)
    expect(h.calls.filter(([op]) => op === 'settings.apply')).toHaveLength(1)
  } finally {
    auth.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('target and input stay open maps through a provider’s strict rewrite', () => {
  const change = harness().tools.find(
    tool => tool.name === 'qianmo_settings_change',
  )
  if (change === undefined) throw new Error('no change tool')
  // What OpenAI strict and the Anthropic normaliser would send: a closed
  // `target` would let the model pass only `{}` (10-21 beta-5: `target.server 缺失`).
  const { schema, strict } = adaptSchemaForStrict(
    change.parameters as Record<string, unknown>,
    true,
  )
  const properties = schema['properties'] as Record<
    string,
    Record<string, unknown>
  >
  for (const key of ['target', 'input']) {
    expect(properties[key]?.['additionalProperties']).not.toBe(false)
    expect(properties[key]?.['properties']).toBeUndefined()
  }
  expect(strict).toBe(false)
})
