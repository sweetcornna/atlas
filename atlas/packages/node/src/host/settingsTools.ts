// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The hub's settings for agents (P40, `agent-settings.md` §3–§4).
 * `qianmo_settings_list` reads the settings catalog the console's panels use;
 * `qianmo_settings_change` changes one item. The hub binds the change it would
 * make (`settings.preview` → `bound`), a person approves exactly that in the
 * conversation (P14, once, never on a window), and the hub makes it for that
 * approval only (`settings.apply`), checking `bound` again first.
 *
 * Like the task tools these only forward to the hub, with the console
 * conversation and turn they were called from, which the hub checks; the
 * catalog, what only a person may change and who may approve what all live
 * there.
 */

import { newId, type ControlOutcome } from '@qianmo/protocol'
import type { HostToolDefinition } from './notifyTool.js'
import type { TaskToolOrigin } from './taskTools.js'

interface SettingsToolContext {
  readonly agent: string
  readonly sessionId: string
}

/** Why the turn behind a change cannot have it approved (§4.1). */
export type SettingsUnavailable =
  | 'no-approver'
  | 'no-turn'
  | 'unsigned'
  | 'background'

/**
 * How the approval of one change ended. `denied` is a person's no; `pending`
 * is the wait running out with the request still open. `allowed` names the
 * request whose grant let the change through, which the hub consumes.
 */
export type SettingsApproval =
  | {
      readonly kind: 'allowed'
      readonly contextId: string
      readonly requestId: string
    }
  | { readonly kind: 'denied'; readonly requestId: string }
  | { readonly kind: 'pending'; readonly requestId: string }
  | { readonly kind: 'unavailable'; readonly reason: SettingsUnavailable }
  | { readonly kind: 'refused' }

export interface SettingsToolsOptions {
  readonly call: (
    op: string,
    args: Record<string, unknown>,
    options: { agent: string; callId?: string },
  ) => Promise<ControlOutcome>
  /** The running turn behind a tool call, or null when it has none. */
  readonly origin: (ctx: SettingsToolContext) => TaskToolOrigin | null
  /** Why the turn behind a call cannot change settings, or null when it can. */
  readonly unavailable: (ctx: SettingsToolContext) => SettingsUnavailable | null
  /** One P14 approval of exactly `input`, asked in the turn behind `ctx`. */
  readonly approve: (
    ctx: SettingsToolContext,
    toolName: string,
    input: Record<string, unknown>,
  ) => Promise<SettingsApproval>
}

const CHANGE_TOOL = 'qianmo_settings_change'

const LIST_DESCRIPTION =
  "Read this hub's settings: the same items the console's panels change. With no arguments: the areas, and for every item its id, label, one-line description, kind, the role it needs and whether only a person may change it. With area or id: also the JSON Schema of its target and input and its current value. Secrets show only whether they are set and their last four characters. Call it before qianmo_settings_change to find the id and the exact arguments."

const CHANGE_DESCRIPTION =
  "Change one hub setting, by an id from qianmo_settings_list (read it first); one change per call. target picks the object when the item has one and input is the new value, each as the item's schema says; leave out what the item does not take. Every change waits for a person to approve it on a card in this conversation that shows the current and the new value, and nothing changes before that. A denial ends it: tell the owner and do not ask again unless they want to. If the wait runs out you get an approval id: tell the owner, end your turn, and when they choose 批准并继续 make exactly the same call again; never change the arguments to get past an approval. Items only a person may change (approvals, accounts, raising the permission mode, billing, pairing, SSH credentials) cannot be changed by an agent: the answer says where the person changes them. If the outcome is unknown, never retry automatically; read the item again and check with the owner. Any other refusal names what is wrong: correct the arguments once from the item's schema, or tell the owner; never repeat a call that was refused."

const INVALID = 'Invalid arguments.'

const UNAVAILABLE: Readonly<Record<SettingsUnavailable, string>> = {
  'no-approver':
    '这里不能改设置：这个节点没有接审批（没有 --approver），没有人能在对话里确认。由人在控制台面板里改。',
  'no-turn': '这里不能改设置：找不到这次调用所属的进行中回合。',
  unsigned:
    '这里不能改设置：这一回合不是控制台里签名的人发起的，没有人能在对话里确认。',
  background:
    '这里不能改设置：后台任务与定时作业的回合没有人在场确认。回到前台对话里提出，由人确认。',
}

const OUTSIDE = '设置只能在控制台或聊天渠道的对话里读写。'

const NOT_PREVIEWED = '中枢没有给出这次更改的预览，没有更改任何设置。'

const REFUSED =
  '这次更改没有得到批准（审批被撤销、回合已结束、节点急停或审批记录不可用）· 没有执行。不要自动重试。'

const UNKNOWN =
  '结果未知：这次更改可能已经生效，也可能没有。不要自动重试；先用 qianmo_settings_list 读这一项，再和对方核对。'

function plain(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** An id or area as the catalog spells it; the hub checks it exists. */
function name(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 200
}

/**
 * The arguments with only known keys, `null` and `''` read as left out: a
 * provider's strict mode makes every field required, and a model fills the
 * ones it does not mean with either. (A value inside `input` is untouched:
 * `''` there can be the new value.)
 */
function known(
  raw: unknown,
  keys: readonly string[],
): Record<string, unknown> | null {
  if (!plain(raw) || Object.keys(raw).some(key => !keys.includes(key)))
    return null
  return Object.fromEntries(
    Object.entries(raw).filter(([, value]) => value !== null && value !== ''),
  )
}

function listArguments(raw: unknown): Record<string, unknown> | null {
  const params = known(raw, ['area', 'id'])
  if (params === null) return null
  return Object.values(params).every(name) ? params : null
}

function changeArguments(raw: unknown): Record<string, unknown> | null {
  const params = known(raw, ['id', 'target', 'input'])
  if (
    params === null ||
    !name(params['id']) ||
    (params['target'] !== undefined && !plain(params['target'])) ||
    (params['input'] !== undefined && !plain(params['input']))
  )
    return null
  return params
}

/** What the hub bound for the change it was asked about, or null. */
function boundOf(value: unknown, id: unknown): Record<string, unknown> | null {
  if (!plain(value) || !plain(value['bound'])) return null
  const bound = value['bound']
  return bound['id'] === id && plain(bound['card']) ? bound : null
}

/** The hub's value, or its own words for why not. */
function answer(result: ControlOutcome): {
  ok: boolean
  text: string
  details: ControlOutcome
} {
  return {
    ok: result.ok,
    text: result.ok ? JSON.stringify(result.value) : result.message,
    details: result,
  }
}

export function settingsTools(
  options: SettingsToolsOptions,
): HostToolDefinition[] {
  const string = { type: 'string' }
  // Open maps: each item has its own target and input schema. A bare
  // `{ type: 'object' }` reads as a closed, empty object to the providers'
  // strict-mode rewrite (OpenAI strict, Anthropic), which then lets the model
  // send only `{}`.
  const object = { type: 'object', additionalProperties: true }
  return [
    {
      name: 'qianmo_settings_list',
      description: LIST_DESCRIPTION,
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { area: string, id: string },
        required: [],
      },
      async handler(raw, ctx) {
        const params = listArguments(raw)
        if (params === null) return { ok: false, text: INVALID }
        const origin = options.origin(ctx)
        if (origin === null) return { ok: false, text: OUTSIDE }
        try {
          return answer(
            await options.call(
              'settings.list',
              { ...params, contextId: origin.contextId, taskId: origin.taskId },
              { agent: ctx.agent },
            ),
          )
        } catch {
          return {
            ok: false,
            text: '设置服务没有回应，稍后再读。',
          }
        }
      },
    },
    {
      name: CHANGE_TOOL,
      description: CHANGE_DESCRIPTION,
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { id: string, target: object, input: object },
        required: ['id'],
      },
      async handler(raw, ctx) {
        const params = changeArguments(raw)
        if (params === null) return { ok: false, text: INVALID }
        const unavailable = options.unavailable(ctx)
        if (unavailable !== null)
          return { ok: false, text: UNAVAILABLE[unavailable] }
        const origin = options.origin(ctx)
        if (origin === null) return { ok: false, text: UNAVAILABLE['no-turn'] }
        const turn = { contextId: origin.contextId, taskId: origin.taskId }
        // 1. The hub binds what it would change; its refusals (unknown id,
        // only a person may change it, nothing would change …) say why.
        let bound: Record<string, unknown> | null
        try {
          const preview = await options.call(
            'settings.preview',
            { ...params, ...turn },
            { agent: ctx.agent },
          )
          if (!preview.ok)
            return preview.code === 'unknown'
              ? { ok: false, text: NOT_PREVIEWED, details: preview }
              : answer(preview)
          bound = boundOf(preview.value, params['id'])
        } catch {
          bound = null
        }
        if (bound === null) return { ok: false, text: NOT_PREVIEWED }
        // 2. A person approves exactly that, on the card it carries.
        let approval: SettingsApproval
        try {
          approval = await options.approve(ctx, CHANGE_TOOL, bound)
        } catch {
          approval = { kind: 'refused' }
        }
        switch (approval.kind) {
          case 'unavailable':
            return { ok: false, text: UNAVAILABLE[approval.reason] }
          case 'denied':
            return { ok: false, text: '用户拒绝了这次更改 · 没有执行' }
          case 'pending':
            return {
              ok: false,
              text: `已提交审批，编号 ${approval.requestId}，还没有执行。告诉对方在确认卡片上点「批准并继续」，然后结束这一回合；继续的那一回合里用完全相同的参数再调用一次。别换参数重发。`,
            }
          case 'refused':
            return { ok: false, text: REFUSED }
        }
        // 3. The hub makes the change for this approval, once.
        try {
          const result = await options.call(
            'settings.apply',
            {
              ...params,
              ...turn,
              approvalId: approval.requestId,
              contextId: approval.contextId,
            },
            { agent: ctx.agent, callId: newId() },
          )
          if (result.ok || result.code !== 'unknown') return answer(result)
          return { ok: false, text: UNKNOWN, details: result }
        } catch {
          return { ok: false, text: UNKNOWN }
        }
      },
    },
  ]
}
