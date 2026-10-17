// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 网关页「智能体」区块里每个智能体的「原生扩展」（P36.7，`harness-backends.md`
 * §7.3）：该底层自己装的插件、MCP 服务与技能，经控制链路 `runtime.ext.list` /
 * `install` / `remove` 由节点调该底层自己的命令列出、安装、卸载。
 *
 * ## 读
 *
 * 节点每列一次都要起该底层的进程，所以区块的轮询从不触发它：中枢按节点 / 智能体
 * 缓存最近一次的列表，页面只从缓存渲染；展开面板时缓存超过一分钟才再问。
 *
 * 节点有没有这组操作没有能力位可看：第一次读到一台节点时拿它的第一个智能体问一次
 * 列表，答 `unsupported` 的是旧节点（页面不显示这一块，一小时后再看），答了的就有；
 * 连不上、急停中这类答不出的，一分钟后再问。
 *
 * ## 写
 *
 * 来源先经 `@qianmo/console` 的 `extensionInstallRequest` 检查（路由记账前也查过），
 * 每个智能体同一时刻只装卸一项；发出后等几秒，没答就报「进行中」，页面靠轮询跟进，
 * 节点答了再按它的答复（是扩展列表就直接用）或重读一次列表更新缓存。晚到的失败留
 * 一刻钟给页面看。
 */

import {
  type ConsoleFailure,
  type ConsoleResult,
  type ExtensionInstallRequest,
  MAGPIE_EXTENSION_KINDS,
  type MagpieExtensionItemView,
  type MagpieExtensionJobState,
  type MagpieExtensionJobView,
  type MagpieExtensionKind,
  type MagpieExtensionsView,
} from '@qianmo/console'
import type { ControlOutcome } from '@qianmo/protocol'
import { z } from 'zod'
import {
  type NativeExtensionKind,
  type NativeExtensionsReply,
  RUNTIME_ERRORS,
  RUNTIME_EXT_ERRORS,
  RUNTIME_EXT_OPS,
} from '../host/runtimes/contract.js'

const LIST_MS = 30_000
/** npm and git fetches through the harness's own installer. */
const INSTALL_MS = 10 * 60_000
const REMOVE_MS = 2 * 60_000
/** A list this young is shown as is; opening the panel does not ask again. */
const FRESH_MS = 60_000
/** A node that could not be asked is asked again after this. */
const UNKNOWN_RETRY_MS = 60_000
/** A node without the ops is looked at again after this (it may be upgraded). */
const UNSUPPORTED_RECHECK_MS = 60 * 60_000
/** How long a late failure stays on the page. */
const FAILED_SHOWN_MS = 15 * 60_000

/** The node's own codes: the op exists there, whatever else went wrong. */
const NODE_CODES: ReadonlySet<string> = new Set([
  ...Object.values(RUNTIME_EXT_ERRORS),
  RUNTIME_ERRORS.unknownAgent,
  'invalid',
])

export interface AgentExtensionsOptions {
  /** One control request; never throws. */
  readonly request: (
    node: string,
    op: string,
    args: Record<string, unknown>,
    actor: string,
    timeoutMs: number,
  ) => Promise<ControlOutcome>
  /** How the agents section reads every code that is not the extension ops' own. */
  readonly fromNode: (outcome: {
    readonly code: string
    readonly message: string
  }) => ConsoleFailure
  /** Keeps a background promise for `idle()`. */
  readonly track: (promise: Promise<unknown>) => void
  readonly now: () => number
  /** How long a page write waits for the node's answer before saying it runs. */
  readonly waitMs: number
  /** The control-link actor of the hub's own reads. */
  readonly actor: string
}

const replySchema: z.ZodType<NativeExtensionsReply> = z.object({
  agent: z.string().max(64),
  runtime: z.string().max(64),
  items: z
    .array(
      z.object({
        // Read open: a newer node's new kind is dropped, not the whole list.
        kind: z.custom<NativeExtensionKind>(
          value =>
            typeof value === 'string' && value.length > 0 && value.length <= 40,
        ),
        name: z.string().min(1).max(300),
        version: z.string().max(64).optional(),
        enabled: z.boolean(),
        source: z.string().max(500).optional(),
        notLoaded: z.string().max(300).optional(),
      }),
    )
    .max(500),
  notes: z.array(z.string().max(300)).max(20),
  openCommand: z.string().max(500),
})

function isKind(value: string): value is MagpieExtensionKind {
  return (MAGPIE_EXTENSION_KINDS as readonly string[]).includes(value)
}

/** A node's answer to an extension op as the console's failure. */
function fromExtension(
  outcome: { readonly code: string; readonly message: string },
  fallback: AgentExtensionsOptions['fromNode'],
): ConsoleFailure {
  const detail = `节点 · ${outcome.message}`.slice(0, 300)
  switch (outcome.code) {
    case 'unsupported':
      return { code: 'unsupported', message: '节点版本过旧 · 不支持原生扩展' }
    case RUNTIME_EXT_ERRORS.unsupported:
      return { code: 'unsupported', message: '该底层不支持这类扩展' }
    case RUNTIME_EXT_ERRORS.locked:
      return { code: 'refused', message: '该智能体的官方前端正开着' }
    case RUNTIME_EXT_ERRORS.badSource:
      return { code: 'invalid', message: `节点不收这个来源 · ${detail}` }
    case RUNTIME_EXT_ERRORS.failed:
      return { code: 'refused', message: detail }
    default:
      return fallback(outcome)
  }
}

interface Listed {
  readonly at: number
  readonly reply: NativeExtensionsReply | null
  readonly error: string | null
}

interface Support {
  readonly at: number
  /** null: could not be asked yet. */
  readonly value: boolean | null
}

export class AgentExtensions {
  readonly #options: AgentExtensionsOptions
  readonly #support = new Map<string, Support>()
  readonly #probing = new Set<string>()
  readonly #lists = new Map<string, Listed>()
  readonly #jobs = new Map<string, MagpieExtensionJobState>()

  constructor(options: AgentExtensionsOptions) {
    this.#options = options
  }

  /** Whether the node has the ops; null while that is not known. */
  supported(node: string): boolean | null {
    return this.#support.get(node)?.value ?? null
  }

  /** Find out in the background whether a node has the ops, by listing one agent. */
  probe(node: string, agent: string): void {
    if (this.#probing.has(node)) return
    const known = this.#support.get(node)
    if (known !== undefined) {
      if (known.value === true) return
      const wait =
        known.value === false ? UNSUPPORTED_RECHECK_MS : UNKNOWN_RETRY_MS
      if (this.#options.now() - known.at < wait) return
    }
    this.#probing.add(node)
    this.#options.track(
      this.#list(node, agent, this.#options.actor).finally(() =>
        this.#probing.delete(node),
      ),
    )
  }

  /** What the page shows for an agent, from the cache; null on a node without the ops. */
  view(node: string, agent: string): MagpieExtensionsView | null {
    if (this.supported(node) !== true) return null
    const key = `${node}/${agent}`
    const listed = this.#lists.get(key)
    const now = this.#options.now()
    let job = this.#jobs.get(key) ?? null
    if (
      job !== null &&
      job.state === 'failed' &&
      now - job.at >= FAILED_SHOWN_MS
    ) {
      this.#jobs.delete(key)
      job = null
    }
    const reply = listed?.reply ?? null
    const items: MagpieExtensionItemView[] = []
    for (const item of reply?.items ?? []) {
      if (!isKind(item.kind)) continue
      items.push({
        kind: item.kind,
        name: item.name,
        version: item.version ?? null,
        enabled: item.enabled,
        source: item.source ?? null,
        notLoaded: item.notLoaded ?? null,
      })
    }
    return {
      node,
      agent,
      state:
        listed === undefined
          ? 'unread'
          : listed.error !== null
            ? 'failed'
            : 'ok',
      fresh: listed !== undefined && now - listed.at < FRESH_MS,
      runtime: reply?.runtime ?? null,
      items,
      notes: reply?.notes ?? [],
      openCommand:
        reply === null || reply.openCommand === '' ? null : reply.openCommand,
      error: listed?.error ?? null,
      job,
    }
  }

  /** An agent's list: the cached one while it is fresh, else the node's now. */
  async read(
    node: string,
    agent: string,
    actor: string,
  ): Promise<ConsoleResult<MagpieExtensionsView>> {
    if (this.supported(node) === false)
      return {
        ok: false,
        failure: {
          code: 'unsupported',
          message: '节点版本过旧 · 不支持原生扩展',
        },
      }
    const listed = this.#lists.get(`${node}/${agent}`)
    if (
      listed === undefined ||
      listed.error !== null ||
      this.#options.now() - listed.at >= FRESH_MS
    ) {
      const failure = await this.#list(node, agent, actor)
      if (failure !== null) return { ok: false, failure }
    }
    const view = this.view(node, agent)
    return view === null
      ? {
          ok: false,
          failure: {
            code: 'unsupported',
            message: '节点版本过旧 · 不支持原生扩展',
          },
        }
      : { ok: true, value: view }
  }

  /** The agent's install or removal in flight, if any. */
  busy(node: string, agent: string): boolean {
    return this.#jobs.get(`${node}/${agent}`)?.state === 'running'
  }

  install(
    node: string,
    agent: string,
    request: ExtensionInstallRequest,
    actor: string,
  ): Promise<ConsoleResult<MagpieExtensionJobView>> {
    return this.#job(
      node,
      agent,
      'install',
      request.kind,
      request.name ?? request.source,
      { agent, ...request },
      actor,
    )
  }

  remove(
    node: string,
    agent: string,
    kind: MagpieExtensionKind,
    name: string,
    actor: string,
  ): Promise<ConsoleResult<MagpieExtensionJobView>> {
    return this.#job(
      node,
      agent,
      'remove',
      kind,
      name,
      { agent, kind, name },
      actor,
    )
  }

  // --- plumbing ----------------------------------------------------------

  /** Ask the node for an agent's list; the failure, or null. */
  async #list(
    node: string,
    agent: string,
    actor: string,
  ): Promise<ConsoleFailure | null> {
    const outcome = await this.#options.request(
      node,
      RUNTIME_EXT_OPS.list,
      { agent },
      actor,
      LIST_MS,
    )
    return this.#take(node, agent, outcome)
  }

  /**
   * What any answer says about the ops: an answer or one of the node's own
   * codes means it has them, `unsupported` that it does not; the link's own
   * failures (unreachable, emergency stop) say nothing.
   */
  #learn(node: string, outcome: ControlOutcome): void {
    const at = this.#options.now()
    if (outcome.ok || NODE_CODES.has(outcome.code))
      this.#support.set(node, { at, value: true })
    else if (outcome.code === 'unsupported')
      this.#support.set(node, { at, value: false })
    else if (this.supported(node) !== true)
      this.#support.set(node, { at, value: null })
  }

  /** Keep what a node answered: its list, or why not. */
  #take(
    node: string,
    agent: string,
    outcome: ControlOutcome,
  ): ConsoleFailure | null {
    const now = this.#options.now()
    const key = `${node}/${agent}`
    const previous = this.#lists.get(key)?.reply ?? null
    this.#learn(node, outcome)
    if (outcome.ok) {
      const parsed = replySchema.safeParse(outcome.value)
      if (parsed.success) {
        this.#lists.set(key, { at: now, reply: parsed.data, error: null })
        return null
      }
      const failure: ConsoleFailure = {
        code: 'unreachable',
        message: '节点的答复不是扩展列表',
      }
      this.#lists.set(key, { at: now, reply: previous, error: failure.message })
      return failure
    }
    const failure = fromExtension(outcome, this.#options.fromNode)
    if (outcome.code === 'unsupported') {
      this.#lists.delete(key)
      return failure
    }
    this.#lists.set(key, { at: now, reply: previous, error: failure.message })
    return failure
  }

  /**
   * Send an install or a removal and wait a little for its answer; a late
   * answer updates the cache, a late failure stays on the page a while.
   */
  async #job(
    node: string,
    agent: string,
    op: 'install' | 'remove',
    kind: MagpieExtensionKind,
    name: string,
    args: Record<string, unknown>,
    actor: string,
  ): Promise<ConsoleResult<MagpieExtensionJobView>> {
    const key = `${node}/${agent}`
    if (this.busy(node, agent))
      return {
        ok: false,
        failure: {
          code: 'invalid',
          message: '这个智能体的扩展正在装卸 · 稍后再试',
        },
      }
    this.#jobs.set(key, {
      op,
      kind,
      name,
      state: 'running',
      at: this.#options.now(),
      message: null,
    })
    const run = this.#options
      .request(
        node,
        op === 'install' ? RUNTIME_EXT_OPS.install : RUNTIME_EXT_OPS.remove,
        args,
        actor,
        op === 'install' ? INSTALL_MS : REMOVE_MS,
      )
      .then(outcome => {
        this.#learn(node, outcome)
        if (outcome.ok) {
          // The node lists again after every operation; take its list if it
          // sent one, else read it, and only then is the job over on the page.
          const listed = replySchema.safeParse(outcome.value)
          if (listed.success) {
            this.#lists.set(key, {
              at: this.#options.now(),
              reply: listed.data,
              error: null,
            })
            this.#jobs.delete(key)
          } else
            this.#options.track(
              this.#list(node, agent, this.#options.actor).finally(() =>
                this.#jobs.delete(key),
              ),
            )
        } else {
          // Kept for the page; an answer in time is the caller's to show.
          this.#jobs.set(key, {
            op,
            kind,
            name,
            state: 'failed',
            at: this.#options.now(),
            message: fromExtension(outcome, this.#options.fromNode).message,
          })
        }
        return outcome
      })
    this.#options.track(run)
    let timer: ReturnType<typeof setTimeout> | undefined
    const early = await Promise.race([
      run,
      new Promise<null>(resolve => {
        timer = setTimeout(() => resolve(null), this.#options.waitMs)
        timer.unref?.()
      }),
    ])
    clearTimeout(timer)
    const view = { node, agent, op, kind, name }
    if (early === null)
      return { ok: true, value: { ...view, state: 'running' } }
    if (!early.ok) {
      this.#jobs.delete(key)
      return {
        ok: false,
        failure: fromExtension(early, this.#options.fromNode),
      }
    }
    return { ok: true, value: { ...view, state: 'done' } }
  }
}
