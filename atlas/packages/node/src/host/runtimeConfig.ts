// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Which runtime and model each agent runs on (P36.4, `harness-backends.md`
 * §3), and where it actually runs right now.
 *
 * Configured, highest first: the node's `runtimes.json` (written by
 * `runtime.configure`), the start flags `--agent-runtime` / `--agent-model`,
 * the node default `--default-runtime` (DeepSeek Harness unless told
 * otherwise). An agent whose configured runtime cannot run — not installed,
 * installing, a failed install or compatibility check, no Node.js, no model
 * it can call — runs on qianmopi meanwhile, with the reason in
 * `runtime.status`, and goes back once the reason is gone. Whenever where an
 * agent runs changes, its listeners hear the agent's name; the host recycles
 * that agent's idle children (busy ones after their turn).
 *
 * The default install (§2) lives here too: at start, every npm runtime some
 * agent is configured on and the node lacks is installed in the background,
 * retried after 5, 15 and 60 minutes; the count of failures is kept across
 * restarts, so a restart does not install again before the wait is over.
 */

import { qianmoConfigPath } from '@qianmo/paths'
import type { ControlOutcome } from '@qianmo/protocol'
import { readTextIfExists, writePrivateJson } from '../providers/store.js'
import type { ControlHandler } from './control.js'
import { failuresOf, RuntimeInstaller } from './runtimeUpdate.js'
import {
  DEFAULT_RUNTIME,
  FALLBACK_RUNTIME,
  normalizeRuntimeId,
  RUNTIME_CATALOG,
  type RuntimeLane,
  type RuntimeSpec,
  runtimeSpec,
} from './runtimes/catalog.js'
import type { ExternalRuntimeKind } from './runtimes/channel.js'
import {
  type AgentRuntimeState,
  RUNTIME_ERRORS,
  RUNTIME_OPS,
  type RuntimeFallbackCode,
  type RuntimeStatusReply,
} from './runtimes/contract.js'
import type { ExternalLaunch } from './runtimes/pool.js'

/** One agent as the start flags left it. */
export interface RuntimeAgentFlags {
  readonly agent: string
  /** `--agent-runtime`, a catalog id (`omp` for qianmopi). */
  readonly runtime?: string
  /** `--agent-model`: `<profile>/<model>`. */
  readonly model?: string
}

/** What an external runtime starts with, and over which lane. */
export interface RuntimeCredential extends ExternalLaunch {
  readonly lane: RuntimeLane
}

export interface NodeRuntimesOptions {
  readonly agents: readonly RuntimeAgentFlags[]
  /** `--default-runtime`; default `dsh`. */
  readonly defaultRuntime?: string
  readonly installer: RuntimeInstaller
  /**
   * Run an agent whose runtime cannot run on qianmopi instead (§3.3).
   * Off: every configured runtime is taken as runnable (embedders and tests
   * that bring their own binaries).
   */
  readonly fallback?: boolean
  /** `runtimeModelCredential` (`providers/node.ts`); throws when unresolvable. */
  readonly credential?: (spec: string, runtime: string) => RuntimeCredential
  /** The node's main model as `<profile>/<model>`, when one is applied. */
  readonly mainModel?: () => string | undefined
  /** Install missing default runtimes at start (`--no-runtime-autoinstall` turns it off). */
  readonly autoInstall?: boolean
  /** Waits before each retry of a failed default install. */
  readonly retryDelaysMs?: readonly number[]
  /** Default `qianmoConfigPath('qianmo', 'runtimes.json')`. */
  readonly configPath?: string
  /** Whether this build can start `spec` at all (default: {@link hasLauncher}). */
  readonly launchable?: (spec: RuntimeSpec) => boolean
  readonly onError?: (error: unknown) => void
}

/**
 * §2: retried after 5, 15 and 60 minutes, then not again in this process.
 * The count of failures is kept in `installs.json`: a node started again
 * waits out what is left of the wait its last failure set (the last one,
 * once the retries are used up) instead of installing at once.
 */
export const RUNTIME_INSTALL_RETRY_MS: readonly number[] = [
  5 * 60_000,
  15 * 60_000,
  60 * 60_000,
]

interface AgentEntry {
  runtime?: string
  model?: string
}

interface RuntimesFile {
  readonly v: 1
  readonly agents: Readonly<Record<string, AgentEntry>>
}

/** `<profile>/<model>`; the model id may itself contain slashes. */
const MODEL_SPEC = /^[^/\s]+\/\S+$/

/**
 * An ACP runtime needs its catalog launcher (`acp`, filled in by P36.2);
 * without one this build cannot drive it, whatever is installed.
 */
export function hasLauncher(spec: RuntimeSpec): boolean {
  return spec.protocol !== 'acp' || spec.acp !== undefined
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** The node's runtime configuration and every agent's effective runtime. */
export class NodeRuntimes {
  readonly #options: NodeRuntimesOptions
  readonly #agents: ReadonlyMap<string, RuntimeAgentFlags>
  readonly #listeners = new Set<(agent: string) => void>()
  readonly #states = new Map<string, AgentRuntimeState>()
  /** Pending default installs, by runtime. */
  readonly #retries = new Map<string, ReturnType<typeof setTimeout>>()
  /** The last successful install seen per runtime: newer ones recycle. */
  readonly #installedAt = new Map<string, number>()
  readonly #defaultRuntime: string
  #file: RuntimesFile
  #stopped = false

  constructor(options: NodeRuntimesOptions) {
    this.#options = options
    this.#agents = new Map(options.agents.map(agent => [agent.agent, agent]))
    const defaultRuntime = normalizeRuntimeId(
      options.defaultRuntime ?? DEFAULT_RUNTIME,
    )
    if (defaultRuntime === undefined)
      throw new Error(`unknown default runtime ${options.defaultRuntime}`)
    this.#defaultRuntime = defaultRuntime
    this.#file = this.#read()
    for (const spec of RUNTIME_CATALOG)
      this.#installedAt.set(spec.id, this.#lastOkAt(spec.id))
    options.installer.onChange(kind => this.#installerChanged(kind))
    this.recompute()
  }

  /**
   * Embedders that pick runtimes themselves: no default install and no
   * fallback; agents without `runtime` run on qianmopi.
   */
  static unmanaged(
    agents: readonly {
      readonly agent: string
      readonly runtime?: string
      readonly model?: string
    }[],
    bins?: Partial<Record<ExternalRuntimeKind, string>>,
  ): NodeRuntimes {
    return new NodeRuntimes({
      agents: agents.map(agent => ({
        agent: agent.agent,
        ...(agent.runtime === undefined ? {} : { runtime: agent.runtime }),
        ...(agent.model === undefined ? {} : { model: agent.model }),
      })),
      defaultRuntime: FALLBACK_RUNTIME,
      installer: new RuntimeInstaller(bins === undefined ? {} : { bins }),
      fallback: false,
      autoInstall: false,
    })
  }

  get installer(): RuntimeInstaller {
    return this.#options.installer
  }
  get defaultRuntime(): string {
    return this.#defaultRuntime
  }

  /** Called with an agent's name when where or how it runs changed. */
  onChange(listener: (agent: string) => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  #path(): string {
    return (
      this.#options.configPath ?? qianmoConfigPath('qianmo', 'runtimes.json')
    )
  }

  #read(): RuntimesFile {
    let raw: unknown
    try {
      raw = JSON.parse(readTextIfExists(this.#path()) ?? '{"v":1,"agents":{}}')
    } catch (error) {
      this.#options.onError?.(
        new Error(`runtimes.json is unreadable: ${errorText(error)}`),
      )
      return { v: 1, agents: {} }
    }
    // No prototype: the file's keys are data, `__proto__` included.
    const agents: Record<string, AgentEntry> = Object.create(null)
    if (isRecord(raw) && isRecord(raw['agents']))
      for (const [agent, value] of Object.entries(raw['agents'])) {
        if (!isRecord(value)) continue
        const runtime =
          typeof value['runtime'] === 'string'
            ? normalizeRuntimeId(value['runtime'])
            : undefined
        const model =
          typeof value['model'] === 'string' &&
          (value['model'] === 'auto' || MODEL_SPEC.test(value['model']))
            ? value['model']
            : undefined
        agents[agent] = {
          ...(runtime === undefined ? {} : { runtime }),
          ...(model === undefined ? {} : { model }),
        }
      }
    return { v: 1, agents }
  }

  /** Where `agent`'s runtime and model come from (§3.1). */
  configured(agent: string): AgentRuntimeState['configured'] {
    const entry = this.#file.agents[agent]
    const flags = this.#agents.get(agent)
    const runtime =
      entry?.runtime !== undefined
        ? { runtime: entry.runtime, source: 'config' as const }
        : flags?.runtime !== undefined
          ? { runtime: flags.runtime, source: 'flag' as const }
          : { runtime: this.#defaultRuntime, source: 'default' as const }
    return {
      ...runtime,
      model: entry?.model ?? flags?.model ?? null,
    }
  }

  /** The runtime `agent`'s next turn runs on: `omp` or an external id. */
  effectiveRuntime(agent: string): string {
    return this.#states.get(agent)?.effective.runtime ?? FALLBACK_RUNTIME
  }

  /**
   * The external runtime an agent's external sessions use: the effective
   * one, else the configured one, else the default external runtime.
   */
  externalRuntimeOf(agent: string): ExternalRuntimeKind {
    const effective = this.effectiveRuntime(agent)
    if (effective !== FALLBACK_RUNTIME) return effective
    const configured = this.configured(agent).runtime
    return configured !== FALLBACK_RUNTIME ? configured : DEFAULT_RUNTIME
  }

  /**
   * The runtime whose native state is `agent`'s (P36.7): `omp` when it is
   * configured on qianmopi, else its external runtime (the configured one
   * while it is away on the fallback).
   */
  nativeRuntimeOf(agent: string): string {
    return this.configured(agent).runtime === FALLBACK_RUNTIME
      ? FALLBACK_RUNTIME
      : this.externalRuntimeOf(agent)
  }

  /** The agents configured on `kind` (`runtime.remove` refuses while any). */
  inUse(kind: string): string[] {
    return [...this.#agents.keys()].filter(
      agent => this.configured(agent).runtime === kind,
    )
  }

  state(agent: string): AgentRuntimeState | undefined {
    return this.#states.get(agent)
  }

  status(): RuntimeStatusReply {
    return {
      defaultRuntime: this.#defaultRuntime,
      agents: [...this.#agents.keys()].flatMap(agent => {
        const state = this.#states.get(agent)
        return state === undefined ? [] : [state]
      }),
    }
  }

  /** Address, key and model for `agent`'s effective external runtime. */
  launch(agent: string): RuntimeCredential {
    const state = this.#states.get(agent)
    const runtime = state?.effective.runtime
    if (runtime === undefined || runtime === FALLBACK_RUNTIME)
      throw new Error(`${agent} runs on qianmopi now`)
    const model = state?.effective.model
    if (model === undefined || this.#options.credential === undefined)
      throw new Error(`${agent} has no model for ${runtime}`)
    return this.#options.credential(model, runtime)
  }

  #lastOkAt(kind: string): number {
    const last = this.installer.lastInstall(kind)
    return last?.ok === true ? last.at : 0
  }

  #unavailable(
    runtime: string,
  ): { code: RuntimeFallbackCode; message: string } | undefined {
    const spec = runtimeSpec(runtime)
    if (spec === undefined)
      return { code: 'not-installed', message: `目录里没有 ${runtime}` }
    if (!(this.#options.launchable ?? hasLauncher)(spec))
      return {
        code: 'smoke-failed',
        message: `这个版本的阡陌还不能驱动 ${spec.label}（ACP 启动方式未定）`,
      }
    const installer = this.installer
    const here = installer.availability(runtime)
    if (!here.installed) {
      if (installer.installing(runtime))
        return { code: 'installing', message: `${spec.label} 正在安装` }
      const last = installer.lastInstall(runtime)
      if (last !== undefined && !last.ok)
        return {
          code: last.code ?? 'install-failed',
          message: last.error ?? `${spec.label} 安装失败`,
        }
      return {
        code: 'not-installed',
        message:
          here.rejected === undefined
            ? `节点上没有 ${spec.label}`
            : `节点上没有 ${spec.label}：${here.rejected}`,
      }
    }
    const range =
      spec.install.kind === 'npm' ? spec.install.needsNode : undefined
    if (range !== undefined && installer.nodeSatisfies(range) === false)
      return {
        code: 'no-node',
        message: `缺少 Node.js（${spec.label} 需要 ${range}）`,
      }
    return undefined
  }

  /** The model `runtime` would call for `configured`, and its lane (§3.2). */
  #model(
    configured: string | null,
    runtime: string,
  ): { model?: string; lane?: RuntimeLane } | { error: string } {
    const credential = this.#options.credential
    const explicit =
      configured !== null && configured !== 'auto' ? configured : undefined
    if (credential === undefined)
      return explicit === undefined ? {} : { model: explicit }
    try {
      const spec = explicit ?? this.#options.mainModel?.()
      if (spec === undefined)
        return { error: '没有为它配置模型，节点也没有可用的主模型' }
      const resolved = credential(spec, runtime)
      const target = runtimeSpec(runtime)
      if (
        target?.customHeaders === false &&
        Object.keys(resolved.headers ?? {}).length > 0
      )
        return {
          error: `${target.label} 不能发送 ${spec.slice(0, spec.indexOf('/'))} 要求的自定义请求头`,
        }
      return { model: spec, lane: resolved.lane }
    } catch (error) {
      return { error: `没有可用模型：${errorText(error)}` }
    }
  }

  #compute(agent: string): AgentRuntimeState {
    const configured = this.configured(agent)
    const runtime = configured.runtime
    if (runtime === FALLBACK_RUNTIME)
      return { agent, configured, effective: { runtime } }
    const fallback = this.#options.fallback !== false
    const away = fallback ? this.#unavailable(runtime) : undefined
    if (away !== undefined)
      return {
        agent,
        configured,
        effective: { runtime: FALLBACK_RUNTIME },
        reason: away,
      }
    const model = this.#model(configured.model, runtime)
    if ('error' in model) {
      if (fallback)
        return {
          agent,
          configured,
          effective: { runtime: FALLBACK_RUNTIME },
          reason: { code: 'no-model', message: model.error },
        }
      return { agent, configured, effective: { runtime } }
    }
    return {
      agent,
      configured,
      effective: {
        runtime,
        ...(model.model === undefined ? {} : { model: model.model }),
        ...(model.lane === undefined ? {} : { lane: model.lane }),
      },
    }
  }

  /**
   * Recomputes every agent's effective runtime; the agents whose runtime,
   * model or lane changed are announced (and returned), as are `also`.
   */
  recompute(also: Iterable<string> = []): string[] {
    const changed = new Set(also)
    for (const agent of this.#agents.keys()) {
      const before = this.#states.get(agent)?.effective
      const state = this.#compute(agent)
      this.#states.set(agent, state)
      const after = state.effective
      if (
        before !== undefined &&
        (before.runtime !== after.runtime ||
          before.model !== after.model ||
          before.lane !== after.lane)
      )
        changed.add(agent)
    }
    for (const agent of changed)
      for (const listener of [...this.#listeners]) {
        try {
          listener(agent)
        } catch (error) {
          this.#options.onError?.(error)
        }
      }
    return [...changed]
  }

  #installerChanged(kind: string): void {
    // A finished install of a runtime agents already run on: new binary,
    // so their idle children start again from it.
    const at = this.#lastOkAt(kind)
    const fresh = at > (this.#installedAt.get(kind) ?? 0)
    if (fresh) this.#installedAt.set(kind, at)
    this.recompute(
      fresh
        ? [...this.#agents.keys()].filter(
            agent => this.#states.get(agent)?.effective.runtime === kind,
          )
        : [],
    )
  }

  /**
   * At resident start, after the model service is in place: sweeps leftover
   * scratch prefixes, checks who the configured runtimes found on PATH are,
   * computes every agent's runtime, starts the default installs and checks
   * Node.js. Never waits for an install; resolves once Node.js was checked.
   */
  async start(): Promise<void> {
    // What an install left when the node died in the middle of it; in the
    // background (large trees), never in the way of starting.
    void this.installer
      .sweepStages()
      .catch(error => this.#options.onError?.(error))
    // A configured runtime found on PATH says who it is before it counts
    // (Debian's `dsh` is not DeepSeek Harness), and before the install.
    const configured = new Set(
      [...this.#agents.keys()].map(agent => this.configured(agent).runtime),
    )
    await Promise.all(
      [...configured].map(kind => this.installer.checkPath(kind)),
    )
    this.recompute()
    if (this.#options.autoInstall === true) this.#autoInstall()
    const needsNode = this.#options.agents.some(agent => {
      const spec = runtimeSpec(this.configured(agent.agent).runtime)
      return (
        spec?.install.kind === 'npm' && spec.install.needsNode !== undefined
      )
    })
    if (needsNode && this.#options.fallback !== false) {
      await this.installer.checkNode().catch(() => null)
      this.recompute()
    }
  }

  #autoInstall(): void {
    const missing = new Set<string>()
    for (const agent of this.#agents.keys()) {
      const runtime = this.configured(agent).runtime
      if (
        runtimeSpec(runtime)?.install.kind === 'npm' &&
        !this.installer.availability(runtime).installed
      )
        missing.add(runtime)
    }
    for (const kind of missing) {
      // What an earlier run's failures left of the backoff (§2); a clock
      // that went back never makes it longer than the wait itself.
      const last = this.installer.lastInstall(kind)
      const failures = failuresOf(last)
      const wait = failures === 0 ? 0 : this.#delay(failures)
      const left = (last?.at ?? 0) + wait - Date.now()
      this.#later(kind, Math.min(wait, Math.max(0, left)))
    }
  }

  /** The wait after `failures` failed installs in a row (the last, past the end). */
  #delay(failures: number): number {
    const delays = this.#options.retryDelaysMs ?? RUNTIME_INSTALL_RETRY_MS
    return delays[Math.min(failures, delays.length) - 1] ?? 0
  }

  #later(kind: string, wait: number): void {
    if (this.#stopped || this.#retries.has(kind)) return
    // Configured away while it was installing: nothing to retry for.
    if (this.inUse(kind).length === 0) return
    if (wait <= 0) {
      this.#installInBackground(kind)
      return
    }
    const timer = setTimeout(() => {
      this.#retries.delete(kind)
      if (this.inUse(kind).length > 0) this.#installInBackground(kind)
    }, wait)
    timer.unref?.()
    this.#retries.set(kind, timer)
  }

  /** No agent is configured on a runtime any more: its pending retry goes. */
  #dropUnusedRetries(): void {
    for (const [kind, timer] of this.#retries)
      if (this.inUse(kind).length === 0) {
        clearTimeout(timer)
        this.#retries.delete(kind)
      }
  }

  #installInBackground(kind: string): void {
    if (this.#stopped) return
    void this.installer
      .ensureRuntimeInstalled(kind)
      .then(result => {
        if (result.ok || this.#stopped) return
        this.#options.onError?.(
          new Error(`default install of ${kind} failed: ${result.message}`),
        )
        // In this run: one retry per entry of the schedule, then no more.
        const failures = failuresOf(this.installer.lastInstall(kind))
        const delays = this.#options.retryDelaysMs ?? RUNTIME_INSTALL_RETRY_MS
        if (failures > 0 && failures <= delays.length)
          this.#later(kind, this.#delay(failures))
      })
      .catch(error => this.#options.onError?.(error))
  }

  /** The node is stopping: no more retries, and running installs end. */
  stop(): void {
    this.#stopped = true
    for (const timer of this.#retries.values()) clearTimeout(timer)
    this.#retries.clear()
    this.installer.stop()
  }

  /** `runtime.configure` (§3.1): validates, writes, recomputes. */
  configure(args: Record<string, unknown>): ControlOutcome {
    const agent = args['agent']
    if (typeof agent !== 'string' || !this.#agents.has(agent))
      return {
        ok: false,
        code: RUNTIME_ERRORS.unknownAgent,
        message: `本节点没有这个智能体：${String(agent)}`,
      }
    const entry: AgentEntry = { ...this.#file.agents[agent] }
    if ('runtime' in args) {
      const value = args['runtime']
      if (value === null) delete entry.runtime
      else {
        const runtime =
          typeof value === 'string' ? normalizeRuntimeId(value) : undefined
        if (runtime === undefined)
          return {
            ok: false,
            code: RUNTIME_ERRORS.unknownRuntime,
            message: `目录里没有这个底层：${String(value)}`,
          }
        entry.runtime = runtime
      }
    }
    if ('model' in args) {
      const value = args['model']
      if (value === null) delete entry.model
      else if (
        typeof value === 'string' &&
        (value === 'auto' || MODEL_SPEC.test(value))
      )
        entry.model = value
      else
        return {
          ok: false,
          code: RUNTIME_ERRORS.badModel,
          message: '模型要写成 <档案>/<模型号> 或 auto',
        }
    }
    const before = JSON.stringify(this.#file.agents[agent] ?? {})
    const agents: Record<string, AgentEntry> = { ...this.#file.agents }
    if (entry.runtime === undefined && entry.model === undefined)
      delete agents[agent]
    else agents[agent] = entry
    const next: RuntimesFile = { v: 1, agents }
    try {
      writePrivateJson(this.#path(), next)
    } catch (error) {
      return {
        ok: false,
        code: 'internal',
        message: `写不进 runtimes.json：${errorText(error)}`,
      }
    }
    this.#file = next
    this.recompute(
      JSON.stringify(agents[agent] ?? {}) === before ? [] : [agent],
    )
    this.#dropUnusedRetries()
    // Moved onto a runtime whose PATH binary was never asked who it is (§2):
    // ask now, without waiting; its answer recomputes (`#installerChanged`).
    void this.installer
      .checkPath(this.configured(agent).runtime)
      .catch(error => this.#options.onError?.(error))
    return { ok: true, value: this.#states.get(agent) }
  }

  /** All six runtime ops (`runtime.*`). */
  readonly control: ControlHandler = async (op, args, ctx) => {
    if (op === RUNTIME_OPS.status) return { ok: true, value: this.status() }
    if (op === RUNTIME_OPS.configure) return this.configure(args)
    if (op === RUNTIME_OPS.versions)
      return {
        ok: true,
        value: {
          ...(await this.installer.versions()),
          defaultRuntime: this.#defaultRuntime,
        },
      }
    if (op === RUNTIME_OPS.remove) {
      const kind = args['runtime']
      const runtime =
        typeof kind === 'string' ? normalizeRuntimeId(kind) : undefined
      const users = runtime === undefined ? [] : this.inUse(runtime)
      if (
        runtime !== undefined &&
        runtime !== FALLBACK_RUNTIME &&
        users.length > 0
      )
        return {
          ok: false,
          code: RUNTIME_ERRORS.inUse,
          message: `${runtimeSpec(runtime)?.label ?? runtime} 正被这些智能体使用：${users.join('、')}；先把它们改到别的底层`,
        }
    }
    return this.installer.control(op, args, ctx)
  }
}
