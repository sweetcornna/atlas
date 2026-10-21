// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * An agent changing the console's settings (P40, `agent-settings.md` §3, §5).
 *
 * The node's two host tools forward here as hub calls: `settings.list` reads
 * the catalog and the values in it, `settings.preview` answers the bound an
 * approval is asked for, and `settings.apply` makes the change once a person
 * has approved exactly that bound.
 *
 * ## Who is calling
 *
 * The check background tasks make (`consoleTasks.ts`): the conversation named
 * by `contextId` must be with this very agent, and a turn a person started
 * must still be waiting for its answer. A background worker's conversation, a
 * schedule's and a channel conversation that is not the owner's private chat
 * may not change settings at all. The conversation's owner is who the values
 * are read as, and the owner must hold the role the change needs before
 * anybody is asked to approve it.
 *
 * ## What is approved, and what is done
 *
 * Preview and apply compute the bound the same way, from the real arguments
 * and the value read before the change (`settingsBound`), so an approval is
 * used only for the change it was given for, and only while the setting still
 * holds the value the person saw. Apply consumes the approval first
 * (`ConsoleApprovals.consumeSettings`, durable) and then runs the catalog's
 * `/v0` request through the console's own router as the approver
 * (`ConsoleHandler.as`), so the route's guard, tenant boundary, `admit` and
 * action ledger are the page's, and the ledger lines name the agent and the
 * approval. An answer that does not say whether the change was made is
 * reported as unknown; it is never retried, and the approval is spent.
 */

import {
  type ChatPort,
  type ChatTranscript,
  type ConsoleAccounts,
  type ConsoleHandler,
  type ConsolePrincipal,
  type JsonSchema,
  type SettingOperation,
  type SettingReader,
  type SettingsBound,
  SETTING_AREAS,
  redactSecrets,
  schemaProblem,
  secretMark,
  settingOperation,
  settingOperations,
  settingsBound,
  settingUnchanged,
} from '@qianmo/console'
import type { ControlOutcome } from '@qianmo/protocol'
import { terminalReply } from './chatTurn.js'
import type { ConsoleApprovals } from './consoleApprovals.js'
import type { HubCallHandler } from './consoleControl.js'

type User = Extract<ConsolePrincipal, { kind: 'user' }>

export interface ConsoleSettingsOptions {
  readonly chat: Pick<ChatPort, 'transcript'>
  readonly accounts: ConsoleAccounts
  readonly approvals: Pick<ConsoleApprovals, 'consumeSettings'>
  /**
   * The console's in-process door. Read at every call: the hub calls are
   * registered before the server is started.
   */
  readonly console: () => ConsoleHandler['as'] | undefined
  /** A schedule's conversation: nobody reads it live. */
  readonly scheduled?: (sessionId: string) => boolean
  /** False for a channel conversation that is not the owner's private chat. */
  readonly foreground?: (sessionId: string) => boolean
  /** A background task worker's conversation. */
  readonly worker?: (sessionId: string) => boolean
  readonly now?: () => number
}

interface Caller {
  readonly contextId: string
  readonly node: string
  readonly agent: string
  readonly address: string
  /** The conversation's owner, as an active account. */
  readonly owner: User
}

/** One change as the hub reads it, before or after it is approved. */
interface Change {
  readonly op: SettingOperation
  readonly target: Record<string, unknown>
  readonly input: Record<string, unknown>
  readonly bound: SettingsBound
}

/** The most a bound may weigh: it rides in the approval request and its card. */
const MAX_BOUND_BYTES = 16 * 1024

/** The most a result may weigh on its way back to the node. */
const MAX_RESULT_BYTES = 32 * 1024

const ROLE_RANK: Readonly<Record<string, number>> = {
  viewer: 0,
  member: 1,
  ops: 2,
}

/** The host of the requests the hub makes of its own console. */
const IN_PROCESS_ORIGIN = 'http://console.in-process'

/**
 * What each call takes. The node adds the running turn (`contextId`,
 * `taskId`) to every one, the way the task tools do; `target` on a list is
 * only for reading one entry's value.
 */
const ARGUMENTS: Readonly<Record<string, readonly string[]>> = {
  'settings.list': ['area', 'id', 'target', 'contextId', 'taskId'],
  'settings.preview': ['id', 'target', 'input', 'contextId', 'taskId'],
  'settings.apply': [
    'id',
    'target',
    'input',
    'approvalId',
    'contextId',
    'taskId',
  ],
}

const UNWIRED =
  '这台中枢不能让智能体改设置 · 需要 --accounts 与 --approvals 接上审批'

function ok(value: unknown): ControlOutcome {
  return { ok: true, value }
}

function refused(message: string): ControlOutcome {
  return { ok: false, code: 'refused', message }
}

function unknown(message: string): ControlOutcome {
  return { ok: false, code: 'unknown', message }
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function covers(role: string, needed: string): boolean {
  return (ROLE_RANK[role] ?? -1) >= (ROLE_RANK[needed] ?? 99)
}

/** The answer of every op on a hub without accounts or approvals. */
export const settingsUnwired: HubCallHandler = async () => refused(UNWIRED)

/** A route's own error text, or its status. */
async function errorText(response: Response): Promise<string> {
  const body = recordOf(await response.json().catch(() => null))
  const message = recordOf(body?.['error'])?.['message']
  return typeof message === 'string' ? message : `http_${response.status}`
}

/** Field names a result might carry a secret under; routes never should. */
const SECRET_FIELD = /(secret|token|password|credential|apikey|privatekey)$/i

function withoutSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutSecrets)
  const found = recordOf(value)
  if (found === null) return value
  return Object.fromEntries(
    Object.entries(found).map(([key, item]) => [
      key,
      SECRET_FIELD.test(key) && typeof item === 'string' && item !== ''
        ? secretMark(item)
        : withoutSecrets(item),
    ]),
  )
}

const DONE: Readonly<Record<SettingOperation['kind'], string>> = {
  set: '已更改',
  create: '已新建',
  update: '已修改',
  remove: '已删除',
  run: '已执行',
}

export class ConsoleSettings {
  readonly #options: ConsoleSettingsOptions
  readonly #now: () => number

  constructor(options: ConsoleSettingsOptions) {
    this.#options = options
    this.#now = options.now ?? Date.now
  }

  readonly handle: HubCallHandler = async (fullOp, args, ctx) => {
    const keys = ARGUMENTS[fullOp]
    if (keys === undefined)
      return { ok: false, code: 'unsupported', message: `不支持 ${fullOp}` }
    const extra = Object.keys(args).find(key => !keys.includes(key))
    if (extra !== undefined) return refused(`不认识的参数 ${extra}`)
    const caller = await this.#caller(args, ctx)
    if (typeof caller === 'string') return refused(caller)
    if (fullOp === 'settings.list') return await this.#list(caller, args)
    if (fullOp === 'settings.preview') {
      const change = await this.#change(caller, args, true)
      return typeof change === 'string'
        ? refused(change)
        : ok({ bound: change.bound })
    }
    return await this.#apply(caller, args, ctx.callId)
  }

  /**
   * Who is calling: the conversation named by `contextId` must be with this
   * very agent, a foreground one, and `taskId` must be a turn a person
   * started there that is still waiting for its answer.
   */
  async #caller(
    args: Record<string, unknown>,
    ctx: { readonly node: string; readonly agent?: string },
  ): Promise<Caller | string> {
    const contextId = args['contextId']
    const taskId = args['taskId']
    if (
      typeof contextId !== 'string' ||
      typeof taskId !== 'string' ||
      !ctx.agent
    )
      return '缺少会话信息'
    let transcript: ChatTranscript
    try {
      const read = await this.#options.chat.transcript(contextId)
      if (!read.ok) return '会话不存在'
      transcript = read.value
    } catch {
      return '会话不存在'
    }
    const address = `qianmo://${ctx.node}/${ctx.agent}`
    if (transcript.session.target !== address) return '会话不属于这个智能体'
    if (
      transcript.session.background === true ||
      this.#options.worker?.(contextId) === true
    )
      return '后台子任务不能改设置 · 交回发起它的对话去做'
    if (this.#options.scheduled?.(contextId) === true)
      return '定时任务的会话不能改设置 · 没有人在看这一轮'
    if (this.#options.foreground?.(contextId) === false)
      return '只有主人的私聊和控制台对话能改设置'
    const turns = transcript.turns
    const asked = turns.some(
      turn => turn.author === 'operator' && turn.taskId === taskId,
    )
    // The same terminal rule the task worker waits on (`consoleTasks.ts`).
    if (!asked || terminalReply(turns, taskId) !== undefined)
      return '这一轮不在进行中 · 只有人发起的一轮能改设置'
    const subject = this.#options.accounts.book.ownerOf(contextId)
    if (subject === null) return '这个对话没有个人账号主人'
    const listed = this.#options.accounts.book.list()
    const account = listed.ok
      ? listed.value.accounts.find(
          row => row.subject === subject && row.state === 'active',
        )
      : undefined
    if (account === undefined) return '对话主人的账号已不可用'
    return {
      contextId,
      node: ctx.node,
      agent: ctx.agent,
      address,
      owner: {
        kind: 'user',
        subject: account.subject,
        role: account.role,
        credential: 'bearer',
        authenticatedAt: this.#now(),
      },
    }
  }

  /** Reads through the console as the conversation's owner. */
  #reader(owner: User): SettingReader | string {
    const as = this.#options.console()
    if (as === undefined) return '控制台还没有起来'
    return {
      get: async path => {
        const response = await as(
          owner,
          new Request(`${IN_PROCESS_ORIGIN}${path}`, {
            headers: { accept: 'application/json' },
          }),
        )
        if (response.status === 404) {
          await response.body?.cancel()
          return null
        }
        if (!response.ok) throw new Error(await errorText(response))
        return await response.json()
      },
    }
  }

  /**
   * One change, checked, its value read, and bound — or why not. `preview`
   * adds the one refusal apply cannot make: a change that changes nothing.
   */
  async #change(
    caller: Caller,
    args: Record<string, unknown>,
    preview: boolean,
  ): Promise<Change | string> {
    const id = args['id']
    const op = typeof id === 'string' ? settingOperation(id) : undefined
    if (op === undefined) return `没有这个设置项 ${String(id)}`
    if (op.human !== undefined) return `只能本人操作 · ${op.human}`
    const target = this.#argument(op.target, args['target'], 'target')
    if (typeof target === 'string') return target
    const input = this.#argument(op.input, args['input'], 'input')
    if (typeof input === 'string') return input
    if (!covers(caller.owner.role, op.role))
      return op.role === 'ops'
        ? '这项更改需要运维 · 这个对话的主人不是运维'
        : '这项更改需要成员或运维账号'
    const reader = this.#reader(caller.owner)
    if (typeof reader === 'string') return reader
    let current: unknown
    try {
      current =
        op.current === undefined ? undefined : await op.current(reader, target)
    } catch (error) {
      return `读不到现在的值 · ${error instanceof Error ? error.message : String(error)}`
    }
    const redacted = redactSecrets(input, op.secrets)
    if (preview && settingUnchanged(op, redacted, current))
      return '值没变 · 不用改'
    const bound = settingsBound(
      op,
      op.target === undefined ? null : target,
      op.input === undefined ? null : redacted,
      current,
    )
    if (JSON.stringify(bound).length > MAX_BOUND_BYTES)
      return `这次更改太大 · 在面板里做 ${op.page}`
    return { op, target, input, bound }
  }

  /** `target` or `input` against its schema; an op without one takes none. */
  #argument(
    schema: JsonSchema | undefined,
    value: unknown,
    where: 'target' | 'input',
  ): Record<string, unknown> | string {
    const given = value === undefined || value === null ? {} : value
    const found = recordOf(given)
    if (found === null) return `${where} 应为对象`
    if (schema === undefined) {
      return Object.keys(found).length === 0 ? {} : `这个设置项不收 ${where}`
    }
    return schemaProblem(schema, found, where) ?? found
  }

  async #apply(
    caller: Caller,
    args: Record<string, unknown>,
    callId: string,
  ): Promise<ControlOutcome> {
    const approvalId = args['approvalId']
    if (typeof approvalId !== 'string' || !/^[0-9a-f]{32}$/.test(approvalId))
      return refused('缺少单次批准编号')
    const change = await this.#change(caller, args, false)
    if (typeof change === 'string') return refused(change)
    const as = this.#options.console()
    if (as === undefined) return refused('控制台还没有起来')
    const approver = this.#options.approvals.consumeSettings({
      requestId: approvalId,
      node: caller.node,
      agent: caller.agent,
      contextId: caller.contextId,
      bound: change.bound,
      callId,
    })
    if (approver === null)
      return refused(
        '单次批准不存在 已用过 已过期或参数与当前值已变化 · 重新申请批准',
      )
    // The approval is spent from here on: whatever happens next is not retried.
    const { method, path, body } = change.op.request(
      change.target,
      change.input,
    )
    let response: Response
    try {
      response = await as(
        approver,
        new Request(`${IN_PROCESS_ORIGIN}${path}`, {
          method,
          headers: {
            accept: 'application/json',
            'content-type': 'application/json',
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
        { agent: caller.address, approval: approvalId },
      )
    } catch {
      return unknown('结果未知 · 不要自动重试 · 到面板上确认')
    }
    if (response.ok) {
      const text = await response.text().catch(() => '')
      let result: unknown = null
      try {
        result = text === '' ? null : JSON.parse(text)
      } catch {
        result = null
      }
      const clean = withoutSecrets(result)
      const label = `${SETTING_AREAS[change.op.area]} · ${change.op.label}`
      return ok({
        summary: `${DONE[change.op.kind]} ${label}`,
        result:
          JSON.stringify(clean ?? null).length > MAX_RESULT_BYTES
            ? { note: `结果太长 已省略 · 在面板里看 ${change.op.page}` }
            : clean,
      })
    }
    if (response.status < 500 || response.status === 501)
      return refused(await errorText(response))
    const said = await errorText(response)
    return unknown(`结果未知 · 不要自动重试 · ${said}`)
  }

  /** The catalog: areas and entries, and with an area or id the schemas and values. */
  async #list(
    caller: Caller,
    args: Record<string, unknown>,
  ): Promise<ControlOutcome> {
    const area = args['area']
    const id = args['id']
    if (area !== undefined && typeof area !== 'string')
      return refused('area 应为字符串')
    if (id !== undefined && typeof id !== 'string')
      return refused('id 应为字符串')
    const summary = (op: SettingOperation) => ({
      id: op.id,
      label: op.label,
      description: op.description,
      kind: op.kind,
      role: op.role,
      ...(op.human === undefined ? {} : { human: op.human }),
    })
    if (area === undefined && id === undefined) {
      const areas = Object.entries(SETTING_AREAS).map(([key, label]) => ({
        area: key,
        label,
        settings: settingOperations()
          .filter(op => op.area === key)
          .map(summary),
      }))
      return ok({ areas })
    }
    const chosen = settingOperations().filter(
      op =>
        (area === undefined || op.area === area) &&
        (id === undefined || op.id === id),
    )
    if (chosen.length === 0)
      return refused(
        id === undefined
          ? `没有这个区域 ${String(area)}`
          : `没有这个设置项 ${id}`,
      )
    const reader = this.#reader(caller.owner)
    const target = recordOf(args['target'])
    const settings = []
    for (const op of chosen) {
      settings.push({
        ...summary(op),
        ...(op.target === undefined ? {} : { target: op.target }),
        ...(op.input === undefined ? {} : { input: op.input }),
        ...(op.secrets === undefined ? {} : { secrets: op.secrets }),
        page: op.page,
        ...(await this.#currentFor(
          op,
          reader,
          id === undefined ? null : target,
        )),
      })
    }
    return ok({ settings })
  }

  /**
   * The value of one entry for the list: read when it needs no target, or
   * when the caller named one; otherwise what to give for it.
   */
  async #currentFor(
    op: SettingOperation,
    reader: SettingReader | string,
    target: Record<string, unknown> | null,
  ): Promise<Record<string, unknown>> {
    if (op.current === undefined || op.human !== undefined) return {}
    const needed = op.target?.required ?? []
    if (needed.length > 0 && target === null)
      return { current: null, currentNeeds: needed }
    if (typeof reader === 'string') return { currentError: reader }
    const given = target ?? {}
    const problem =
      op.target === undefined ? null : schemaProblem(op.target, given, 'target')
    if (problem !== null) return { currentError: problem }
    try {
      return { current: (await op.current(reader, given)) ?? null }
    } catch (error) {
      return {
        currentError: error instanceof Error ? error.message : String(error),
      }
    }
  }
}
