// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as fs from 'node:fs'
import * as path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { qianmoConfigPath } from '@qianmo/paths'
import type {
  ElevationActionClass,
  ElevationActionView,
  ElevationNodeView,
  ElevationTierName,
} from '@qianmo/console'
import { isValidSegment, type ControlOutcome } from '@qianmo/protocol'
import type { AuthzCall } from '@qianmo/resident'
import {
  elevatedCall,
  elevationNeedsApproval,
  type ElevationResource,
  type ElevationSandbox,
  type ElevationTier,
} from '@qianmo/extension/elevationPolicy'
import type { ControlHandler } from './control.js'
import type { ResidentAuthzEvent } from './residentAuthorization.js'
import { readTextIfExists, writePrivateJson } from '../providers/store.js'
import {
  defaultElevationBwrap,
  elevationProbeArgv,
  elevationSandboxArgv,
  type ElevationBwrap,
} from './elevationSandbox.js'

/** The title the extension confirms every elevated call under (P39 §4). */
export const ELEVATION_GATE_TITLE = 'QIANMO_ELEVATION_V1'

const LIVE_TIERS: readonly ElevationTier[] = [
  'accept-edits',
  'auto',
  'full-access',
]
function isLiveTier(value: unknown): value is ElevationTier {
  return LIVE_TIERS.includes(value as ElevationTier)
}

/** Expiry bounds: 5 minutes to 24 hours, default 2 hours (P39 §4). */
const MIN_TTL_MS = 5 * 60_000
const MAX_TTL_MS = 24 * 60 * 60_000
const DEFAULT_TTL_MS = 2 * 60 * 60_000
/** Call budget: default 200, cap 2000. */
const MIN_CALLS = 1
const MAX_CALLS = 2000
const DEFAULT_CALLS = 200
const ACTION_RETENTION_MS = 24 * 60 * 60_000
const MAX_ACTIONS = 500
const NO_SANDBOX_REASON =
  '这台节点没有可用的命令沙箱（macOS，或没装 bubblewrap / 建不了用户命名空间）：放权期间不提供 bash，联网与 GitHub 等类型化工具照常'

interface ElevationStateRow {
  agent: string
  tier: ElevationTierName
  epoch: number
  expiresAt: number | null
  maxCalls: number
  usedCalls: number
  enabledAt: number | null
  enabledBy: string | null
}
interface Operation {
  digest: string
  result?: ControlOutcome
}
/** One authorize/complete pair in flight, so a repeat is not recounted. */
interface InFlight {
  readonly cls: ElevationActionClass
  readonly epoch: number
}

/** The decision a gate phase reaches. */
export interface ElevationDecision {
  readonly ok: boolean
  readonly reason?: string
}
const GRANTED: ElevationDecision = { ok: true }
const refuse = (reason: string): ElevationDecision => ({ ok: false, reason })

export interface NodeElevationOptions {
  readonly node: string
  readonly agents: readonly string[]
  readonly estop: () => boolean
  readonly workspace: (agent: string) => string | undefined
  readonly audit?: (event: ResidentAuthzEvent) => void
  /** Recycle one agent's omp children so the next turn picks up the grant. */
  readonly changed?: (agent: string) => Promise<void>
  /** Cancel pending elevated approvals for one agent on revoke/ESTOP. */
  readonly invalidated?: (agent: string) => void
  /**
   * Revoke and ESTOP: close the agent's children now, even mid-turn, so a
   * running sandboxed command dies with its parent. Disable and expiry use
   * {@link changed} and let the current turn finish.
   */
  readonly terminate?: (agent: string) => Promise<void>
  /**
   * Why a grant cannot take effect for this agent (it runs on an external
   * runtime that does not load the qianmopi extension); `undefined` when it can.
   */
  readonly unsupported?: (agent: string) => string | undefined
  readonly now?: () => number
  readonly platform?: NodeJS.Platform
  /** For tests: whether a program is on PATH; whether a probe argv succeeds. */
  readonly bwrap?: ElevationBwrap
}

const hash = (input: unknown) =>
  createHash('sha256').update(JSON.stringify(input)).digest('hex')

/** Build the AuthzCall the host asks the operator to approve for one call. */
function elevatedAuthzCall(
  node: string,
  agent: string,
  contextId: string,
  tool: string,
  args: Readonly<Record<string, unknown>>,
): AuthzCall {
  void node
  return {
    agent,
    contextId,
    toolName: `qianmo_elevated_${tool}`,
    input: args,
  }
}

/**
 * Host-owned per-agent grant state, the authoritative reclassifier, the gate
 * the extension confirms every elevated call through, and the control
 * operations the console drives it with (P39 §§2,4). A grant never survives a
 * restart; ESTOP clears every grant for good until it is lifted.
 */
export class NodeElevation {
  readonly #options: NodeElevationOptions
  readonly #now: () => number
  readonly #states = new Map<string, ElevationStateRow>()
  readonly #operations = new Map<string, Operation>()
  readonly #actions: ElevationActionView[] = []
  readonly #inflight = new Map<string, InFlight>()
  readonly #file = qianmoConfigPath('qianmo', 'elevation-ledger.json')
  /** Memoized sandbox probe: undefined until the first grant needs it. */
  /**
   * Each agent's sandbox, probed at its first grant: the argv binds that
   * agent's own workspace, so it is never shared between agents. `null`:
   * probed and unusable; absent: not probed yet.
   */
  readonly #sandboxes = new Map<string, ElevationSandbox | null>()
  readonly #probes = new Map<string, Promise<ElevationSandbox | null>>()
  #closed = false
  #sweeping = false
  readonly #timer: Timer

  constructor(options: NodeElevationOptions) {
    if (
      !isValidSegment(options.node) ||
      options.agents.some(agent => !isValidSegment(agent))
    )
      throw new Error('Invalid elevation owner')
    this.#options = options
    this.#now = options.now ?? Date.now
    const text = readTextIfExists(this.#file)
    const saved =
      text === undefined
        ? undefined
        : (JSON.parse(text) as {
            operations?: [string, Operation][]
            actions?: ElevationActionView[]
          })
    for (const [id, op] of saved?.operations ?? []) this.#operations.set(id, op)
    this.#actions.push(...(saved?.actions ?? []))
    // A grant never survives a restart: bring every agent up at `off` with a
    // fresh generation, so a child from before the restart is already stale.
    for (const agent of options.agents)
      this.#states.set(agent, {
        agent,
        tier: 'off',
        epoch: 1,
        expiresAt: null,
        maxCalls: DEFAULT_CALLS,
        usedCalls: 0,
        enabledAt: null,
        enabledBy: null,
      })
    this.#save()
    this.#timer = setInterval(() => {
      void this.sweep().catch(() => {})
    }, 2000)
    this.#timer.unref()
  }

  resourcePath(agent: string): string {
    return path.join(
      path.dirname(this.#file),
      'elevation-resources',
      `${agent}.json`,
    )
  }

  /** The grant file the extension reads for one agent. */
  resource(agent: string): ElevationResource | undefined {
    const s = this.#states.get(agent)
    if (!s) return undefined
    const live = isLiveTier(s.tier) && s.expiresAt !== null
    return {
      v: 1,
      tier: s.tier,
      epoch: s.epoch,
      expiresAt: s.expiresAt ?? 0,
      sandbox:
        live && s.tier !== 'off' ? (this.#sandboxes.get(agent) ?? null) : null,
    }
  }

  #view(s: ElevationStateRow): ElevationNodeView {
    const since = this.#now() - ACTION_RETENTION_MS
    return {
      node: this.#options.node,
      agent: s.agent,
      reachable: true,
      tier: s.tier,
      epoch: s.epoch,
      expiresAt: s.expiresAt,
      maxCalls: s.maxCalls,
      usedCalls: s.usedCalls,
      sandbox: Boolean(this.#sandboxes.get(s.agent)),
      // Linux nodes are probed at the first grant; until then nothing is said.
      sandboxReason:
        (this.#options.platform ?? process.platform) !== 'linux' ||
        this.#sandboxes.get(s.agent) === null
          ? NO_SANDBOX_REASON
          : null,
      unsupportedReason: this.#options.unsupported?.(s.agent) ?? null,
      enabledAt: s.enabledAt,
      enabledBy: s.enabledBy,
      actions24h: this.#actions.filter(
        a => a.agent === s.agent && a.at >= since,
      ).length,
    }
  }

  #save(): void {
    if (this.#actions.length > MAX_ACTIONS)
      this.#actions.splice(0, this.#actions.length - MAX_ACTIONS)
    writePrivateJson(this.#file, {
      operations: [...this.#operations],
      actions: this.#actions,
    })
    for (const agent of this.#states.keys())
      writePrivateJson(this.resourcePath(agent), this.resource(agent))
  }

  /**
   * Probe bubblewrap for one agent with the very argv its commands will run
   * under (`… -- <shell> -c true`), so a pass means the real launch works on
   * this node — whatever its directory layout — and a failure leaves bash off.
   */
  async #ensureSandbox(agent: string): Promise<ElevationSandbox | null> {
    const known = this.#sandboxes.get(agent)
    if (known !== undefined) return known
    const workspace = this.#options.workspace(agent)
    if (
      workspace === undefined ||
      (this.#options.platform ?? process.platform) !== 'linux'
    ) {
      this.#sandboxes.set(agent, null)
      return null
    }
    let probe = this.#probes.get(agent)
    if (probe === undefined) {
      probe = (async () => {
        const bwrap = this.#options.bwrap ?? defaultElevationBwrap
        const shell = bwrap.shell()
        const argv = elevationSandboxArgv({ bwrap: 'bwrap', shell, workspace })
        if (
          !bwrap.available('bwrap') ||
          !(await bwrap.probe(elevationProbeArgv(argv, workspace, shell)))
        )
          return null
        return { argv, shell }
      })()
      this.#probes.set(agent, probe)
    }
    const sandbox = await probe
    this.#sandboxes.set(agent, sandbox)
    return sandbox
  }

  #record(
    s: ElevationStateRow,
    row: Omit<ElevationActionView, 'at' | 'node' | 'agent' | 'epoch'>,
    taskId: string | undefined,
  ): void {
    const action: ElevationActionView = {
      at: this.#now(),
      node: this.#options.node,
      agent: s.agent,
      epoch: s.epoch,
      ...row,
      ...(taskId ? { taskId } : {}),
    }
    const cutoff = this.#now() - ACTION_RETENTION_MS
    while (this.#actions.length > 0 && this.#actions[0]!.at < cutoff)
      this.#actions.shift()
    this.#actions.push(action)
    this.#options.audit?.({
      kind: 'elevation.action',
      ...(taskId ? { taskId } : {}),
      detail: {
        agent: s.agent,
        tool: row.tool,
        cls: row.cls,
        op: row.op ?? '',
        host: row.host ?? '',
        approved: row.approved,
        outcome: row.outcome,
        epoch: s.epoch,
        ...(row.digest ? { digest: row.digest } : {}),
        ...(row.invocationId ? { invocationId: row.invocationId } : {}),
      },
    })
  }

  /** Force one agent to `off`: a new generation, and children recycled. */
  async #clear(
    agent: string,
    kind: 'disable' | 'revoke' | 'estop' | 'expire',
  ): Promise<void> {
    const s = this.#states.get(agent)
    if (!s) return
    const wasLive = isLiveTier(s.tier)
    s.tier = 'off'
    s.epoch++
    s.expiresAt = null
    s.usedCalls = 0
    s.enabledAt = null
    s.enabledBy = null
    for (const key of [...this.#inflight.keys()])
      if (key.startsWith(`${agent}:`)) this.#inflight.delete(key)
    this.#save()
    if (wasLive)
      this.#options.audit?.({
        kind: `elevation.${kind === 'expire' ? 'disable' : kind}`,
        detail: { agent, status: kind, epoch: s.epoch },
      })
    try {
      this.#options.invalidated?.(agent)
    } catch {
      /* Cancelling pending approvals must never block retirement. */
    }
    // Revoke and ESTOP stop what is running; disable and expiry let the
    // current turn finish on a gate that already refuses every new call.
    if ((kind === 'revoke' || kind === 'estop') && this.#options.terminate)
      await this.#options.terminate(agent)
    else await this.#options.changed?.(agent)
  }

  /**
   * The periodic sweep: ESTOP clears every live grant for good, and a grant
   * past its expiry goes back to `off` without waiting for the next call.
   */
  async sweep(): Promise<void> {
    if (this.#sweeping || this.#closed) return
    this.#sweeping = true
    try {
      const estop = this.#options.estop()
      for (const s of [...this.#states.values()]) {
        if (!isLiveTier(s.tier)) continue
        if (estop) await this.#clear(s.agent, 'estop')
        else if (s.expiresAt === null || this.#now() >= s.expiresAt)
          await this.#clear(s.agent, 'expire')
        else if (this.#options.unsupported?.(s.agent) !== undefined)
          await this.#clear(s.agent, 'disable')
      }
    } finally {
      this.#sweeping = false
    }
  }

  /**
   * One gate phase, from the extension's `QIANMO_ELEVATION_V1` confirm. All
   * attribution is the active turn's; the model supplies none of it. `approve`
   * runs the P14 one-shot when the tier asks for a call; it is never called
   * for an auto tier.
   */
  async decide(
    agent: string,
    taskId: string,
    contextId: string,
    raw: unknown,
    active: () => boolean,
    approve: (call: AuthzCall) => Promise<boolean>,
  ): Promise<ElevationDecision> {
    if (this.#closed) return refuse('节点正在停止')
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
      return refuse('授权请求格式不合法')
    const call = raw as { toolName?: unknown; input?: unknown }
    const input =
      call.input && typeof call.input === 'object' && !Array.isArray(call.input)
        ? (call.input as Record<string, unknown>)
        : undefined
    if (typeof call.toolName !== 'string' || input === undefined)
      return refuse('授权请求格式不合法')
    const s = this.#states.get(agent)
    if (!s) return refuse(`节点没有为智能体 ${agent} 配置放权`)
    const invocationId =
      typeof input.invocationId === 'string' ? input.invocationId : undefined
    const key = invocationId ? `${agent}:${invocationId}` : undefined

    if (input.phase === 'completed') {
      const pending = key ? this.#inflight.get(key) : undefined
      if (pending === undefined || key === undefined) return GRANTED
      this.#inflight.delete(key)
      this.#record(
        s,
        {
          tool: String(call.toolName),
          cls: pending.cls,
          op: null,
          host: null,
          approved: false,
          outcome: input.isError === true ? 'failed' : 'completed',
          ...(invocationId ? { invocationId } : {}),
        },
        taskId,
      )
      return GRANTED
    }
    if (input.phase !== 'authorize') return refuse('未知的授权阶段')

    // ESTOP clears grants for good, then refuses.
    if (this.#options.estop()) {
      await this.#clear(agent, 'estop')
      return refuse('急停已开启：放权已清除，解除急停后需要重新开启')
    }
    if (!isLiveTier(s.tier)) return refuse('这台智能体没有开启高权限模式')
    if (s.expiresAt === null || this.#now() >= s.expiresAt) {
      await this.#clear(agent, 'expire')
      return refuse('放权已到期，已回到人工确认')
    }
    if (typeof input.epoch !== 'number' || input.epoch !== s.epoch)
      return refuse('放权已变更或被收回（代次不符）')
    if (!active())
      return refuse('发起这次调用的任务已经结束、超时，或不是当前回合')
    if (key && this.#inflight.has(key)) return GRANTED
    if (s.usedCalls >= s.maxCalls) {
      await this.#clear(agent, 'disable')
      return refuse('放权的调用次数已用尽，已回到人工确认')
    }

    const args =
      input.args && typeof input.args === 'object' && !Array.isArray(input.args)
        ? (input.args as Record<string, unknown>)
        : {}
    const classified = elevatedCall(String(call.toolName), args)
    if (classified === undefined) return refuse('这不是高权限工具调用')
    if (typeof classified === 'string') return refuse(classified)
    // The authoritative layer refuses an unsandboxed command even if the
    // extension somehow offered one: bash runs only inside bubblewrap.
    if (classified.tool === 'bash' && !this.#sandboxes.get(agent))
      return refuse('这台节点没有命令沙箱：放权期间不执行 bash')

    const needsApproval = elevationNeedsApproval(s.tier, classified.class)
    const digest = hash(classified.args)
    let approved = false
    if (needsApproval) {
      approved = await approve(
        elevatedAuthzCall(
          this.#options.node,
          agent,
          contextId,
          classified.tool,
          classified.args,
        ),
      )
      if (!approved || !active() || this.#options.estop()) {
        this.#record(
          s,
          {
            tool: classified.tool,
            cls: classified.class,
            op: classified.op ?? null,
            host: classified.hosts?.join(',') ?? null,
            approved: false,
            outcome: 'refused',
            digest,
            ...(invocationId ? { invocationId } : {}),
          },
          taskId,
        )
        return refuse('操作员没有批准，或批准到达时放权已失效')
      }
    }
    // Admit: count the call and remember it so a repeat is not recounted.
    s.usedCalls++
    if (key) this.#inflight.set(key, { cls: classified.class, epoch: s.epoch })
    this.#record(
      s,
      {
        tool: classified.tool,
        cls: classified.class,
        op: classified.op ?? null,
        host: classified.hosts?.join(',') ?? null,
        approved,
        outcome: 'allowed',
        digest,
        ...(invocationId ? { invocationId } : {}),
      },
      taskId,
    )
    this.#save()
    return GRANTED
  }

  /** The control face the console drives (P39 §§4,5). */
  readonly control: ControlHandler = async (op, args, ctx) => {
    const agent = typeof args.agent === 'string' ? args.agent : undefined
    if (op === 'elevation.status') {
      if (Object.keys(args).length > 0)
        return { ok: false, code: 'invalid', message: 'Invalid status query' }
      return {
        ok: true,
        value: [...this.#states.values()].map(s => this.#view(s)),
      }
    }
    if (op === 'elevation.actions') {
      if (Object.keys(args).some(k => !['agent', 'limit'].includes(k)))
        return { ok: false, code: 'invalid', message: 'Invalid action query' }
      const limit = args.limit ?? 50
      if (
        !Number.isSafeInteger(limit) ||
        Number(limit) < 1 ||
        Number(limit) > 200 ||
        (agent !== undefined && !this.#states.has(agent))
      )
        return { ok: false, code: 'invalid', message: 'Invalid action query' }
      return {
        ok: true,
        value: this.#actions
          .filter(a => agent === undefined || a.agent === agent)
          .slice(-Number(limit))
          .reverse(),
      }
    }
    if (
      !['elevation.enable', 'elevation.disable', 'elevation.revoke'].includes(
        op,
      )
    )
      return { ok: false, code: 'unsupported', message: '不支持此控制操作' }
    if (
      agent === undefined ||
      !this.#states.has(agent) ||
      typeof args.operationId !== 'string'
    )
      return {
        ok: false,
        code: 'invalid',
        message: 'Invalid elevation operation',
      }
    const changeKeys =
      op === 'elevation.enable'
        ? ['agent', 'operationId', 'tier', 'ttlMs', 'maxCalls']
        : ['agent', 'operationId']
    if (Object.keys(args).some(k => !changeKeys.includes(k)))
      return { ok: false, code: 'invalid', message: 'Invalid elevation change' }
    if (op === 'elevation.enable') {
      if (!isLiveTier(args.tier) && args.tier !== 'off')
        return { ok: false, code: 'invalid', message: '档位无效' }
      if (
        args.ttlMs !== undefined &&
        (!Number.isSafeInteger(args.ttlMs) ||
          Number(args.ttlMs) < MIN_TTL_MS ||
          Number(args.ttlMs) > MAX_TTL_MS)
      )
        return { ok: false, code: 'invalid', message: '生效时长无效' }
      if (
        args.maxCalls !== undefined &&
        (!Number.isSafeInteger(args.maxCalls) ||
          Number(args.maxCalls) < MIN_CALLS ||
          Number(args.maxCalls) > MAX_CALLS)
      )
        return { ok: false, code: 'invalid', message: '次数上限无效' }
    }
    const id = args.operationId
    const digest = hash({ op, args, actor: ctx.actor, peer: ctx.peer })
    const previous = this.#operations.get(id)
    if (previous)
      return previous.digest !== digest
        ? {
            ok: false,
            code: 'rejected',
            message: 'operationId reused with different arguments',
          }
        : (previous.result ?? {
            ok: false,
            code: 'rejected',
            message: 'Previous operation result unknown; inspect status',
          })
    const unsupported =
      op === 'elevation.enable' && isLiveTier(args.tier)
        ? this.#options.unsupported?.(agent)
        : undefined
    if (unsupported !== undefined)
      return { ok: false, code: 'rejected', message: unsupported }
    if (this.#closed || (this.#options.estop() && op === 'elevation.enable'))
      return { ok: false, code: 'rejected', message: '放权已停止或被急停拦下' }
    this.#operations.set(id, { digest })
    this.#save()
    let result: ControlOutcome
    try {
      const s = this.#states.get(agent)!
      if (op === 'elevation.enable' && isLiveTier(args.tier)) {
        const sandbox = await this.#ensureSandbox(agent)
        s.tier = args.tier as ElevationTierName
        s.epoch++
        s.expiresAt =
          this.#now() +
          (args.ttlMs === undefined ? DEFAULT_TTL_MS : Number(args.ttlMs))
        s.maxCalls =
          args.maxCalls === undefined ? DEFAULT_CALLS : Number(args.maxCalls)
        s.usedCalls = 0
        s.enabledAt = this.#now()
        s.enabledBy = ctx.actor
        for (const k of [...this.#inflight.keys()])
          if (k.startsWith(`${agent}:`)) this.#inflight.delete(k)
        this.#save()
        void sandbox
        this.#options.audit?.({
          kind: 'elevation.grant',
          detail: {
            agent,
            actor: ctx.actor,
            tier: s.tier,
            epoch: s.epoch,
            expiresAt: s.expiresAt,
            maxCalls: s.maxCalls,
            sandbox: sandbox !== null,
          },
        })
        try {
          this.#options.invalidated?.(agent)
        } catch {
          /* Pending approvals from a previous generation close. */
        }
        await this.#options.changed?.(agent)
      } else {
        await this.#clear(
          agent,
          op === 'elevation.revoke' ? 'revoke' : 'disable',
        )
      }
      result = { ok: true, value: this.#view(this.#states.get(agent)!) }
    } catch {
      result = { ok: false, code: 'internal', message: '放权操作失败' }
    }
    this.#operations.set(id, { digest, result })
    this.#save()
    return result
  }

  close(): void {
    this.#closed = true
    clearInterval(this.#timer)
  }
}
