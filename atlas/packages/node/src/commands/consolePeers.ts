// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The roster and synchronous questions between agents on the hub (P36.6,
 * `harness-backends.md` §6.2).
 *
 * A turn calls `qianmo_agents` to see whom it may dial and `qianmo_ask` to
 * ask one to four of them; the node forwards both here (`peers.list`,
 * `peers.ask`). The hub checks the call the way background tasks do (P29):
 * the conversation must be with that very agent and the turn must still be
 * waiting for its answer, and everything goes out as the conversation's
 * owner through {@link ChatDispatch} (tenant, dial list, quota) with one
 * `peer.ask` audit record per target and no message text in it.
 *
 * Each (asking conversation, asked agent) pair has one conversation of its
 * own, kept and reused, so the asked agent remembers what it was asked
 * before; a new asking conversation (or `/new`) starts a new one. The
 * answer is the asked turn's terminal assistant text. A target that outlives
 * the question is stopped on its node (`turn.stop`, as task cancellation
 * does) and reported as timed out.
 *
 * A node runs one turn at a time, and the asking turn holds it while it waits.
 * So every ask turn carries a signed call chain — the asking turns, outermost
 * first — and a node whose running turn is in it lets the ask turn nest
 * instead of queueing it (`NodeTurnGate`). The hub keeps the chain of every
 * ask in flight, extends it when an asked agent asks in turn, refuses a
 * question to an agent already asking in it (A→B→A, on one node or across
 * nodes) and stops it at `LIMITS.maxAskChain` levels.
 *
 * Two unrelated chains can still hold each other: A on node 1 asks B on node
 * 2 while X on node 2 asks Y on node 1, and each question queues behind the
 * other node's asking turn. The hub knows every turn waiting on a question
 * (`#waiting`), so a question to a node where a turn outside its chain is
 * waiting is refused `busy` at once. The check and the record of the new
 * wait happen in one synchronous step, so of two crossing questions the
 * second always sees the first.
 */

import * as path from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import {
  type ActionLedgerPort,
  type ActionOutcome,
  ChatDispatch,
  type ChatPort,
  type ChatTranscript,
  type ConsoleAccounts,
  type TenantPort,
  type UsagePort,
} from '@qianmo/console'
import { LIMITS, parseAddress, type ControlOutcome } from '@qianmo/protocol'
import { PEER_ASK } from '../host/peerTools.js'
import { runtimeSpec } from '../host/runtimes/catalog.js'
import { RUNTIME_OPS } from '../host/runtimes/contract.js'
import {
  acquirePrivateInstanceLock,
  ensurePrivateDir,
  type PrivateInstanceLock,
  readTextIfExists,
  writePrivateJson,
} from '../providers/store.js'
import {
  refusal,
  sendAndWait,
  terminalReply,
  type ChatTurnHandle,
} from './chatTurn.js'
import type { ControlLinks, HubCallHandler } from './consoleControl.js'

/** A conversation pair nobody asked through for this long is forgotten. */
const KEEP_IDLE_MS = 30 * 24 * 60 * 60_000
/**
 * Room for the answers in one hub-call result, below the envelope's
 * `LIMITS.maxMessageBytes` with space for the JSON around them; split evenly
 * between the targets.
 */
const ANSWER_BUDGET_BYTES = 160 * 1024

const conversationSchema = z.object({
  /** The asking conversation. */
  caller: z.string(),
  /** The asked agent's address. */
  target: z.string(),
  /** The conversation with the asked agent. */
  session: z.string(),
  owner: z.string(),
  createdAt: z.number(),
  usedAt: z.number(),
})
type Conversation = z.infer<typeof conversationSchema>

const bookSchema = z.object({
  v: z.literal(1),
  conversations: z.array(conversationSchema),
})

/** A node gets this long to say what its agents run on. */
const RUNTIME_STATUS_TIMEOUT_MS = 5_000

/** The `runtime.status` answer as far as the roster reads it (P36.4). */
const runtimeStatusSchema = z.object({
  agents: z.array(
    z.object({
      agent: z.string(),
      configured: z.object({ runtime: z.string() }).passthrough(),
      effective: z
        .object({ runtime: z.string(), model: z.string().optional() })
        .passthrough(),
      reason: z.object({ message: z.string() }).passthrough().optional(),
    }),
  ),
})
type RuntimeFacts = z.infer<typeof runtimeStatusSchema>['agents'][number]

/** A question as one target gets it. */
interface Question {
  readonly message: string
  readonly timeoutSec: number
  /** When every target's answer is due, on {@link ConsolePeersOptions.now}. */
  readonly deadline: number
}

/** One asking turn in a call chain. */
interface Asker {
  readonly address: string
  readonly node: string
  readonly taskId: string
}

/** A question in flight, by the conversation it was sent into. */
interface InFlight {
  readonly chain: readonly Asker[]
  /** The node task of the ask turn, once the node took it. */
  taskId: string | null
}

interface Caller {
  readonly session: string
  readonly address: string
  readonly node: string
  readonly taskId: string
  readonly owner: string
}

export type PeerAnswer =
  | { readonly agent: string; readonly ok: true; readonly reply: string }
  | {
      readonly agent: string
      readonly ok: false
      readonly code: string
      readonly error: string
    }

export interface PeerRosterRow {
  readonly agent: string
  readonly runtime: string | null
  readonly model: string | null
  readonly online: boolean
  readonly busy: boolean
  readonly description: string
}

export interface ConsolePeersOptions {
  readonly directory: string
  readonly chat: ChatPort
  readonly accounts?: ConsoleAccounts
  readonly usage?: UsagePort
  readonly tenancy?: TenantPort
  /** The action ledger; with it every target of every ask is recorded. */
  readonly actions?: ActionLedgerPort
  readonly now?: () => number
  /** Stops a target's running turn on its node (`turn.stop`). */
  readonly stopTask?: (target: string, taskId: string) => Promise<boolean>
  /** True for a schedule's session (P24): its turns ask nobody. */
  readonly scheduled?: (sessionId: string) => boolean
  /** False for conversations that may not start other agents' work (P29). */
  readonly foreground?: (sessionId: string) => boolean
  /** The control links: the roster asks each node `runtime.status`. */
  readonly control?: Pick<ControlLinks, 'request'>
  /** A one-line description of an agent, where the hub keeps one. */
  readonly describe?: (address: string) => string | undefined
  /** How long `timeoutSec` seconds are; tests shorten them. */
  readonly timeoutMs?: (timeoutSec: number) => number
  readonly onError?: (message: string) => void
}

function ok(value: unknown): ControlOutcome {
  return { ok: true, value }
}
function refused(message: string): ControlOutcome {
  return { ok: false, code: 'refused', message }
}
function failed(agent: string, code: string, error: string): PeerAnswer {
  return { agent, ok: false, code, error }
}

/** `text` cut to `bytes` of UTF-8 on a character boundary, marked when cut. */
function clipBytes(text: string, bytes: number): string {
  if (Buffer.byteLength(text) <= bytes) return text
  const mark = '…（回答过长，已截断）'
  let used = Buffer.byteLength(mark)
  let out = ''
  for (const char of text) {
    used += Buffer.byteLength(char)
    if (used > bytes) break
    out += char
  }
  return `${out}${mark}`
}

/** The addresses a refused question named, for its audit records. */
function targetsOf(args: Record<string, unknown>): string[] {
  const agents = Array.isArray(args['agents']) ? args['agents'] : []
  const named = agents
    .filter((one): one is string => typeof one === 'string')
    .slice(0, PEER_ASK.maxTargets)
  return named.length > 0 ? named : ['-']
}

/** The question as the hub reads it, or why it refuses the whole of it. */
function question(
  args: Record<string, unknown>,
): { agents: readonly string[]; message: string; timeoutSec: number } | string {
  const { agents, message, timeoutSec } = args
  if (
    !Array.isArray(agents) ||
    agents.length === 0 ||
    agents.length > PEER_ASK.maxTargets ||
    !agents.every(one => typeof one === 'string' && one.trim() !== '') ||
    new Set(agents).size !== agents.length
  )
    return `需要 1 到 ${PEER_ASK.maxTargets} 个不同的智能体地址`
  if (typeof message !== 'string' || message.trim() === '') return '问题是空的'
  if (Buffer.byteLength(message) > PEER_ASK.maxMessageBytes)
    return `问题超过 ${PEER_ASK.maxMessageBytes / 1024} KiB`
  if (
    typeof timeoutSec !== 'number' ||
    !Number.isInteger(timeoutSec) ||
    timeoutSec < 1 ||
    timeoutSec > PEER_ASK.maxTimeoutSec
  )
    return `timeoutSec 需要是 1 到 ${PEER_ASK.maxTimeoutSec} 的整数秒`
  return {
    agents: (agents as string[]).map(one => one.trim()),
    message,
    timeoutSec,
  }
}

export class ConsolePeers {
  readonly #options: ConsolePeersOptions
  readonly #now: () => number
  readonly #path: string
  readonly #lock: PrivateInstanceLock | null
  /** By `caller\0target`. */
  readonly #conversations = new Map<string, Conversation>()
  readonly #inFlight = new Map<string, InFlight>()
  /**
   * The asking turns waiting for an answer now, by `node\0taskId`, with how
   * many of their targets are still out.
   */
  readonly #waiting = new Map<
    string,
    { readonly node: string; count: number }
  >()
  /** One question at a time per conversation pair, in arrival order. */
  readonly #serial = new Map<string, Promise<unknown>>()
  readonly #turns = new Set<ChatTurnHandle>()
  #closed = false

  constructor(options: ConsolePeersOptions) {
    this.#options = options
    this.#now = options.now ?? Date.now
    ensurePrivateDir(options.directory)
    this.#path = path.join(options.directory, 'peers.json')
    this.#lock = acquirePrivateInstanceLock(
      path.join(options.directory, 'instance.lock'),
    )
    if (!this.#lock)
      options.onError?.('问答目录已由另一实例持有；本实例不转发智能体间的提问')
    const raw = readTextIfExists(this.#path)
    if (raw !== undefined)
      for (const one of bookSchema.parse(JSON.parse(raw)).conversations)
        this.#conversations.set(`${one.caller}\0${one.target}`, one)
  }

  /** Forgets idle conversation pairs. */
  start(): void {
    if (!this.#lock?.owned()) return
    this.#save()
  }

  async close(): Promise<void> {
    this.#closed = true
    for (const turn of this.#turns) turn.cancel()
    await Promise.allSettled([...this.#serial.values()])
    this.#lock?.release()
  }

  /** `sec` seconds of a question; see {@link ConsolePeersOptions.timeoutMs}. */
  #ms(sec: number): number {
    return (this.#options.timeoutMs ?? (one => one * 1000))(sec)
  }

  #save(): void {
    if (!this.#lock?.owned()) return
    const now = this.#now()
    for (const [key, one] of this.#conversations)
      if (now - one.usedAt > KEEP_IDLE_MS) this.#conversations.delete(key)
    try {
      writePrivateJson(this.#path, {
        v: 1,
        conversations: [...this.#conversations.values()],
      })
    } catch {
      this.#options.onError?.('问答会话表写入失败')
    }
  }

  readonly handle: HubCallHandler = async (fullOp, args, ctx) => {
    if (!fullOp.startsWith('peers.') || this.#closed)
      return refused('智能体间问答不可用')
    if (!this.#lock?.owned()) return refused('智能体间问答由另一控制台实例负责')
    const caller = await this.#caller(args, ctx)
    if (typeof caller === 'string') return refused(caller)
    const dispatch = this.#dispatch(caller.owner)
    // Nobody reads a schedule's session live, and a channel group or another
    // person's chat may not set other agents to work as the owner (P29).
    const denied =
      this.#options.scheduled?.(caller.session) === true
        ? {
            code: 'scheduled',
            message: '定时任务的会话不能问其他智能体；请在这一轮里直接完成',
          }
        : this.#options.foreground?.(caller.session) === false
          ? {
              code: 'foreground',
              message: '只有主人的私聊和控制台对话能问其他智能体',
            }
          : typeof dispatch === 'string'
            ? { code: 'account', message: dispatch }
            : undefined
    if (denied !== undefined || typeof dispatch === 'string') {
      if (fullOp === 'peers.ask')
        await this.#auditAll(
          randomUUID(),
          caller,
          targetsOf(args),
          'refused',
          denied?.code ?? 'account',
        )
      return refused(denied?.message ?? '会话主人的账号已不可用')
    }
    switch (fullOp) {
      case 'peers.list':
        return ok({ agents: await this.#roster(caller, dispatch) })
      case 'peers.ask':
        return this.#ask(caller, dispatch, args)
      default:
        return { ok: false, code: 'unsupported', message: `不支持 ${fullOp}` }
    }
  }

  /**
   * Who is calling: the conversation named by `contextId` must be with this
   * very agent, and `taskId` must be a turn of it still waiting for its
   * answer — the same check background tasks make (`consoleTasks.ts`).
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
    const transcript = await this.#options.chat.transcript(contextId)
    if (!transcript.ok) return '会话不存在'
    const address = `qianmo://${ctx.node}/${ctx.agent}`
    if (transcript.value.session.target !== address)
      return '会话不属于这个智能体'
    const turns = transcript.value.turns
    const asked = turns.some(
      turn => turn.author === 'operator' && turn.taskId === taskId,
    )
    if (!asked || terminalReply(turns, taskId) !== undefined)
      return '这一轮不在进行中'
    return {
      session: contextId,
      address,
      node: ctx.node,
      taskId,
      owner: this.#options.accounts?.book.ownerOf(contextId) ?? 'legacy:admin',
    }
  }

  #dispatch(owner: string): ChatDispatch | string {
    const dispatch = ChatDispatch.forSubject(owner, {
      deps: {
        chat: this.#options.chat,
        ...(this.#options.usage === undefined
          ? {}
          : { usage: this.#options.usage }),
        ...(this.#options.tenancy === undefined
          ? {}
          : { tenancy: this.#options.tenancy }),
      },
      accounts: this.#options.accounts,
      now: this.#now(),
      requestId: randomUUID(),
    })
    return dispatch instanceof Response ? '会话主人的账号已不可用' : dispatch
  }

  /** Addresses with a line still waiting for its answer. */
  async #busy(): Promise<ReadonlySet<string>> {
    const sessions = await this.#options.chat.sessions()
    return new Set(
      sessions.ok
        ? sessions.value
            .filter(session => session.running === true)
            .map(session => session.target)
        : [],
    )
  }

  // -- the roster ------------------------------------------------------------

  async #facts(
    nodes: readonly string[],
  ): Promise<ReadonlyMap<string, RuntimeFacts>> {
    const facts = new Map<string, RuntimeFacts>()
    const control = this.#options.control
    if (control === undefined) return facts
    await Promise.all(
      nodes.map(async node => {
        const outcome = await control
          .request(node, RUNTIME_OPS.status, {}, 'peers', {
            timeoutMs: RUNTIME_STATUS_TIMEOUT_MS,
          })
          .catch(() => undefined)
        // A node older than P36.4 answers `unsupported`: no facts, same row.
        const parsed = runtimeStatusSchema.safeParse(
          outcome?.ok === true ? outcome.value : undefined,
        )
        if (parsed.success)
          for (const agent of parsed.data.agents)
            facts.set(`qianmo://${node}/${agent.agent}`, agent)
      }),
    )
    return facts
  }

  async #roster(
    caller: Caller,
    dispatch: ChatDispatch,
  ): Promise<PeerRosterRow[]> {
    const targets = await this.#options.chat.targets()
    if (!targets.ok) return []
    const dialable = targets.value.filter(
      row =>
        row.dialable &&
        row.address !== caller.address &&
        dispatch.authorize(row.address) === null,
    )
    const [busy, facts] = await Promise.all([
      this.#busy(),
      this.#facts([...new Set(dialable.map(row => row.node))]),
    ])
    return dialable.map(row => {
      const fact = facts.get(row.address)
      const label = (id: string) => runtimeSpec(id)?.label ?? id
      const runtime = fact === undefined ? null : label(fact.effective.runtime)
      const model = fact?.effective.model ?? null
      const described =
        this.#options.describe?.(row.address) ??
        (fact === undefined
          ? `节点 ${row.node} 没有回报它的底层与模型`
          : [
              `${label(fact.effective.runtime)} 上的智能体`,
              ...(model === null ? [] : [`模型 ${model}`]),
              ...(fact.reason === undefined
                ? []
                : [
                    `配置的是 ${label(fact.configured.runtime)}，暂用 ${label(fact.effective.runtime)}：${fact.reason.message}`,
                  ]),
            ].join('，'))
      return {
        agent: row.address,
        runtime,
        model,
        online: row.status === 'online',
        busy: busy.has(row.address),
        description: described,
      }
    })
  }

  // -- a question ------------------------------------------------------------

  async #ask(
    caller: Caller,
    dispatch: ChatDispatch,
    args: Record<string, unknown>,
  ): Promise<ControlOutcome> {
    const asked = question(args)
    if (typeof asked === 'string') return refused(asked)
    const requestId = randomUUID()
    // The chain this caller's turn is part of, when it is itself an answer.
    const parent = this.#inFlight.get(caller.session)
    const upstream =
      parent !== undefined &&
      (parent.taskId === null || parent.taskId === caller.taskId)
        ? parent.chain
        : []
    const chain: readonly Asker[] = [
      ...upstream,
      { address: caller.address, node: caller.node, taskId: caller.taskId },
    ]
    if (chain.length > LIMITS.maxAskChain) {
      await this.#auditAll(requestId, caller, asked.agents, 'refused', 'depth')
      return refused(
        `问答链已经 ${LIMITS.maxAskChain} 层（${chain
          .slice(0, -1)
          .map(one => one.address)
          .join(
            ' → ',
          )} → 你），不能再往下问；请自己回答，或在回答里说明需要谁补充`,
      )
    }
    try {
      const admitted = await this.#options.actions?.admit?.()
      if (admitted && !admitted.ok) return refused('操作记录不可写，问答暂停')
    } catch {
      return refused('操作记录不可写，问答暂停')
    }
    const busy = await this.#busy()
    // One clock for every target: waiting for a slot spends it too.
    const deadline = this.#now() + this.#ms(asked.timeoutSec)
    const budget = Math.floor(ANSWER_BUDGET_BYTES / asked.agents.length)
    const answers = await Promise.all(
      asked.agents.map(async target => {
        const answer = await this.#askOne(
          caller,
          dispatch,
          chain,
          busy,
          target,
          { ...asked, deadline },
        ).catch(
          (): PeerAnswer => failed(target, 'failed', '问答中途出错，结果未知'),
        )
        await this.#audit(
          requestId,
          caller,
          target,
          answer.ok
            ? 'ok'
            : ['timeout', 'failed', 'cancelled'].includes(answer.code)
              ? 'failed'
              : 'refused',
          answer.ok ? undefined : answer.code,
        )
        return answer.ok
          ? { ...answer, reply: clipBytes(answer.reply, budget) }
          : answer
      }),
    )
    return ok({ answers })
  }

  /** One target: checks, its conversation, the turn and its answer. */
  async #askOne(
    caller: Caller,
    dispatch: ChatDispatch,
    chain: readonly Asker[],
    busy: ReadonlySet<string>,
    target: string,
    asked: Question,
  ): Promise<PeerAnswer> {
    const address = parseAddress(target)
    if (address === null)
      return failed(target, 'invalid', '不是有效的智能体地址')
    if (chain.some(one => one.address === target))
      return failed(
        target,
        'cycle',
        `${target} 已在这条问答链上（${chain.map(one => one.address).join(' → ')}），再问它会互相等待；请直接回答`,
      )
    // Its next turn would queue behind a turn here that waits for it, and its
    // node reads nothing new for it until that turn starts.
    if (busy.has(target) && chain.some(one => one.node === address.node))
      return failed(
        target,
        'busy',
        `${target} 与问答链上的一方在同一节点，它还有一轮在排队；现在问只会等到超时。稍后再问，或用 qianmo_task_start 交给它`,
      )
    // A turn there waiting on a question of another chain holds that node:
    // this question would queue behind it, and if that one waits on this
    // chain the two wait for each other until both time out.
    if (this.#waitingOutside(address.node, chain))
      return failed(
        target,
        'busy',
        `${target} 所在节点上另有一轮正在等别的智能体回答，现在问会排在它后面，可能互相等到超时。先自己回答，稍后再问，或用 qianmo_task_start 交给它`,
      )
    // Recorded in the same synchronous step as the check above.
    const release = this.#wait(caller)
    const key = `${caller.session}\0${target}`
    const previous = this.#serial.get(key) ?? Promise.resolve()
    const run = previous
      .catch(() => {})
      .then(() => this.#turn(caller, dispatch, chain, target, asked))
    this.#serial.set(key, run)
    try {
      return await run
    } finally {
      release()
      if (this.#serial.get(key) === run) this.#serial.delete(key)
    }
  }

  /** A turn on `node` waits on a question and is not one of `chain`'s askers. */
  #waitingOutside(node: string, chain: readonly Asker[]): boolean {
    for (const [key, one] of this.#waiting) {
      if (one.node !== node) continue
      if (!chain.some(link => `${link.node}\0${link.taskId}` === key))
        return true
    }
    return false
  }

  /** Records `caller` as waiting on one more target; returns the release. */
  #wait(caller: Caller): () => void {
    const key = `${caller.node}\0${caller.taskId}`
    const entry = this.#waiting.get(key) ?? { node: caller.node, count: 0 }
    entry.count++
    this.#waiting.set(key, entry)
    let released = false
    return () => {
      if (released) return
      released = true
      if (--entry.count <= 0 && this.#waiting.get(key) === entry)
        this.#waiting.delete(key)
    }
  }

  /** Drops this caller's conversation with `target`, if it is `session`. */
  #forget(caller: Caller, target: string, session: string): void {
    const key = `${caller.session}\0${target}`
    if (this.#conversations.get(key)?.session !== session) return
    this.#conversations.delete(key)
    this.#save()
  }

  /** The conversation with `target` for this caller, opened when missing. */
  async #conversation(
    caller: Caller,
    dispatch: ChatDispatch,
    target: string,
  ): Promise<
    { id: string; transcript: ChatTranscript; fresh: boolean } | PeerAnswer
  > {
    const key = `${caller.session}\0${target}`
    const known = this.#conversations.get(key)
    if (known !== undefined && known.owner === caller.owner) {
      const transcript = await this.#options.chat.transcript(known.session)
      if (transcript.ok && transcript.value.session.target === target) {
        const claimed = dispatch.claimSession(known.session)
        if (claimed)
          return failed(
            target,
            'refused',
            (await refusal(claimed)).error ?? '对话会话不可用',
          )
        this.#conversations.set(key, { ...known, usedAt: this.#now() })
        this.#save()
        return {
          id: known.session,
          transcript: transcript.value,
          fresh: false,
        }
      }
    }
    const opened = await dispatch.open(target)
    if (opened instanceof Response)
      return failed(
        target,
        'refused',
        (await refusal(opened)).error ?? '没能开启对话会话',
      )
    if (!opened.ok) return failed(target, 'failed', '没能开启对话会话')
    const now = this.#now()
    this.#conversations.set(key, {
      caller: caller.session,
      target,
      session: opened.value.id,
      owner: caller.owner,
      createdAt: now,
      usedAt: now,
    })
    this.#save()
    const transcript = await this.#options.chat.transcript(opened.value.id)
    if (!transcript.ok) return failed(target, 'failed', '对话会话记录不可用')
    return { id: opened.value.id, transcript: transcript.value, fresh: true }
  }

  async #turn(
    caller: Caller,
    dispatch: ChatDispatch,
    chain: readonly Asker[],
    target: string,
    asked: Question,
  ): Promise<PeerAnswer> {
    if (this.#closed) return failed(target, 'cancelled', '中枢正在关闭')
    const late = () =>
      failed(
        target,
        'timeout',
        `${target} 在 ${asked.timeoutSec} 秒内没有回答，已停止它这一轮`,
      )
    // An earlier question to the same agent from here took the time.
    if (asked.deadline - this.#now() < this.#ms(1)) return late()
    const quota = dispatch.preflightUsage(
      target,
      this.#conversations.get(`${caller.session}\0${target}`)?.session ?? null,
    )
    const denied = quota ?? (await dispatch.authorizeTarget(target))
    if (denied)
      return failed(
        target,
        'refused',
        (await refusal(denied)).error ?? '不能问这个智能体',
      )
    const conversation = await this.#conversation(caller, dispatch, target)
    if (!('id' in conversation)) return conversation
    const timeoutMs = asked.deadline - this.#now()
    if (timeoutMs < this.#ms(1)) return late()
    const lines = [`来自 ${caller.address} 的提问`]
    if (conversation.fresh)
      lines.push(
        '（另一个智能体经中枢同步发来的提问，对方在等你这一轮的最终回答：直接作答，答完就结束本轮；耗时的活请在回答里建议对方改用后台任务。）',
      )
    lines.push(asked.message)
    const flight: InFlight = { chain, taskId: null }
    this.#inFlight.set(conversation.id, flight)
    const handle = sendAndWait({
      chat: this.#options.chat,
      dispatch,
      target,
      input: {
        sessionId: conversation.id,
        text: lines.join('\n\n'),
        taskTtlMs: timeoutMs,
        chain: chain.map(one => ({ node: one.node, taskId: one.taskId })),
      },
      baseline: new Set(conversation.transcript.turns.map(turn => turn.id)),
      now: this.#now,
      timeoutMs,
      // Checked against the dial list just above.
      authorized: true,
      onTask: taskId => {
        flight.taskId = taskId
      },
    })
    this.#turns.add(handle)
    try {
      const outcome = await handle.outcome
      if (outcome.ok) return { agent: target, ok: true, reply: outcome.text }
      if (outcome.timedOut || (outcome.cancelled && !this.#closed)) {
        // A turn past its question is stopped natively, as a cancelled task's
        // is: an interactive turn's own deadline answers without stopping it.
        const stopTask = this.#options.stopTask
        const stopped =
          flight.taskId !== null &&
          stopTask !== undefined &&
          (await stopTask(target, flight.taskId).catch(() => false))
        if (stopped) return late()
        // Still running there: whatever it answers later must not become the
        // context of the next question, so that one opens a new conversation.
        this.#forget(caller, target, conversation.id)
        return failed(
          target,
          'timeout',
          `${target} 在 ${asked.timeoutSec} 秒内没有回答，没能停止它这一轮（可能仍在进行）；下次提问会开新对话`,
        )
      }
      if (outcome.cancelled) return failed(target, 'cancelled', '中枢正在关闭')
      return failed(
        target,
        outcome.refusedStatus === undefined ? 'failed' : 'refused',
        outcome.error ?? '对方这一轮没有正常结束',
      )
    } finally {
      this.#turns.delete(handle)
      if (this.#inFlight.get(conversation.id) === flight)
        this.#inFlight.delete(conversation.id)
    }
  }

  // -- audit -----------------------------------------------------------------

  async #audit(
    requestId: string,
    caller: Caller,
    target: string,
    outcome: ActionOutcome,
    code?: string,
  ): Promise<void> {
    try {
      const recorded = await this.#options.actions?.record({
        at: this.#now(),
        requestId,
        subject: caller.owner,
        action: 'peer.ask',
        target: `${caller.address} → ${target}`,
        outcome,
        ...(code === undefined ? {} : { code }),
      })
      if (recorded && !recorded.ok)
        this.#options.onError?.('问答的操作记录写入失败')
    } catch {
      this.#options.onError?.('问答的操作记录写入失败')
    }
  }

  async #auditAll(
    requestId: string,
    caller: Caller,
    targets: readonly string[],
    outcome: ActionOutcome,
    code: string,
  ): Promise<void> {
    for (const target of targets)
      await this.#audit(requestId, caller, target, outcome, code)
  }
}
