// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Installing the runtimes of the catalog (P31, P36.3; `harness-backends.md`
 * §2, `runtimes-channels.md` §5): every `npm` entry of `RUNTIME_CATALOG`
 * (DeepSeek Harness, Claude Code, Codex, …) is installed unmodified from its
 * official package into a qianmo-owned prefix, `qianmoConfigPath('runtimes',
 * 'npm')`. New runtime children start from there; running ones finish on the
 * old binary and are recycled when idle. npm's cache, config and HOME live
 * under the qianmo config root too: nothing here reads or writes the user's
 * own `~/.npm`, `~/.claude` or `~/.codex`.
 *
 * A version is first installed into a scratch prefix and must pass the
 * compatibility check (`runtimes/smoke.ts`: the node's own arguments, the
 * `qianmo` tool bridge) before it goes into the managed prefix; one that
 * fails leaves the node on the version it had, and the answer says why. A
 * runtime that needs Node.js is not installed on a node without a matching
 * one, and nothing starts without the disk space a whole install takes.
 *
 * Binaries given with `--runtime-bin` (or its aliases `--claude-code-bin`,
 * `--codex-bin`) are the operator's: they are reported, never managed.
 */

import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, rmSync, statfsSync } from 'node:fs'
import * as path from 'node:path'
import { qianmoConfigPath } from '@qianmo/paths'
import type { ControlOutcome } from '@qianmo/protocol'
import { ompVersion } from '../provenance.js'
import { readTextIfExists, writePrivateJson } from '../providers/store.js'
import type { ControlHandler } from './control.js'
import {
  DEFAULT_RUNTIME,
  normalizeRuntimeId,
  type NpmInstall,
  RUNTIME_CATALOG,
  type RuntimeSpec,
  runtimeSpec,
} from './runtimes/catalog.js'
import type { ExternalRuntimeKind } from './runtimes/channel.js'
import {
  RUNTIME_ERRORS,
  RUNTIME_OPS,
  type RuntimeFallbackCode,
  type RuntimeVersionRow,
  type RuntimeVersionsReply,
} from './runtimes/contract.js'
import { runtimeSmoke } from './runtimes/smoke.js'

type NpmRuntime = RuntimeSpec & { readonly install: NpmInstall }

function npmRuntime(id: string): NpmRuntime | undefined {
  const spec = runtimeSpec(id)
  return spec?.install.kind === 'npm' ? (spec as NpmRuntime) : undefined
}

/** The official npm package of every installable runtime, by catalog id. */
export const RUNTIME_PACKAGES: Readonly<Record<ExternalRuntimeKind, string>> =
  Object.fromEntries(
    RUNTIME_CATALOG.flatMap(spec =>
      spec.install.kind === 'npm' ? [[spec.id, spec.install.package]] : [],
    ),
  )

/** Exact versions only: no ranges, tags or URLs reach npm. */
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const MIB = 1024 * 1024
/**
 * Free space one install needs, both prefixes and npm's cache together.
 * dsh unpacks to about 854 MB (`dsh-acp-facts.md`) and is installed twice.
 */
const DISK_MIB: Readonly<Record<string, number>> = { dsh: 2048 }
const DEFAULT_DISK_MIB = 512

function diskMiB(spec: NpmRuntime): number {
  // A catalog hint wins once the catalog carries one.
  const hint = 'diskMiB' in spec.install ? spec.install.diskMiB : undefined
  return typeof hint === 'number' && hint > 0
    ? hint
    : (DISK_MIB[spec.id] ?? DEFAULT_DISK_MIB)
}

/** The npm prefix runtime installs go into. */
export function managedRuntimePrefix(): string {
  return qianmoConfigPath('runtimes', 'npm')
}

/** The installed binary of a managed runtime, when an install put one there. */
export function managedRuntimeBin(
  kind: ExternalRuntimeKind,
): string | undefined {
  const spec = npmRuntime(kind)
  if (spec === undefined) return undefined
  const bin = path.join(
    managedRuntimePrefix(),
    'node_modules',
    '.bin',
    spec.install.command,
  )
  return existsSync(bin) ? bin : undefined
}

export interface RunResult {
  readonly code: number
  readonly stdout: string
  /** The output went past `maxOutput` and was cut. */
  readonly truncated?: boolean
}

export type RunCommand = (
  argv: readonly string[],
  options: {
    readonly env: Record<string, string>
    readonly timeoutMs: number
    /** Default 4000 characters. */
    readonly maxOutput?: number
    /** Kills the command when aborted. */
    readonly signal?: AbortSignal
    /** Where it runs; default the node's working directory. */
    readonly cwd?: string
  },
) => Promise<RunResult>

/** Runs a command without a shell; output is capped. */
export const runCommand: RunCommand = async (argv, options) => {
  const child = Bun.spawn([...argv], {
    env: options.env,
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const timer = setTimeout(() => child.kill(), options.timeoutMs)
  const abort = () => child.kill()
  options.signal?.addEventListener('abort', abort, { once: true })
  if (options.signal?.aborted) child.kill()
  try {
    const [stdout, code] = await Promise.all([
      new Response(child.stdout).text(),
      child.exited,
    ])
    const max = options.maxOutput ?? 4_000
    return {
      code,
      stdout: stdout.slice(0, max),
      truncated: stdout.length > max,
    }
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', abort)
  }
}

type Triple = readonly [number, number, number]

function triple(text: string): { v: Triple; given: number } | undefined {
  const match = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[-+][0-9A-Za-z.-]+)?$/.exec(
    text,
  )
  if (match === null) return undefined
  const given = match[3] !== undefined ? 3 : match[2] !== undefined ? 2 : 1
  return {
    v: [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)],
    given,
  }
}

function compare(a: Triple, b: Triple): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2]
}

/** The first version past a partial one: `22` → 23.0.0, `22.19` → 22.20.0. */
function past(v: Triple, given: number): Triple {
  return given === 1 ? [v[0] + 1, 0, 0] : [v[0], v[1] + 1, 0]
}

function comparator(token: string, version: Triple): boolean {
  if (token === '*' || token === 'x') return true
  const match = /^(>=|<=|>|<|=|\^|~)?(.+)$/.exec(token)
  const bound = match === null ? undefined : triple(match[2]!)
  if (match === null || bound === undefined) return false
  const { v, given } = bound
  const c = compare(version, v)
  switch (match[1] ?? '=') {
    case '>=':
      return c >= 0
    case '>':
      return given === 3 ? c > 0 : compare(version, past(v, given)) >= 0
    case '<':
      return c < 0
    case '<=':
      return given === 3 ? c <= 0 : compare(version, past(v, given)) < 0
    case '~':
      return c >= 0 && compare(version, past(v, given === 1 ? 1 : 2)) < 0
    case '^': {
      const upper: Triple =
        v[0] > 0 || given === 1
          ? [v[0] + 1, 0, 0]
          : v[1] > 0 || given === 2
            ? [0, v[1] + 1, 0]
            : [0, 0, v[2] + 1]
      return c >= 0 && compare(version, upper) < 0
    }
    default:
      return given === 3
        ? c === 0
        : c >= 0 && compare(version, past(v, given)) < 0
  }
}

/**
 * Whether `version` (`v22.19.0`, `24.1.0`) is in an npm-style `range`:
 * alternatives joined by `||`, each a space-separated set of comparators
 * (`>=`, `>`, `<`, `<=`, `=`, `^`, `~`, a bare or partial version, `*`).
 * Prerelease tags are ignored. A comparator it cannot read never matches.
 */
export function satisfiesVersionRange(version: string, range: string): boolean {
  const parsed = triple(version.trim())
  if (parsed === undefined) return false
  return range.split('||').some(alternative => {
    const tokens = alternative
      .trim()
      .replace(/(>=|<=|>|<|=|\^|~)\s+/g, '$1')
      .split(/\s+/)
      .filter(token => token !== '')
    return tokens.length === 0
      ? true
      : tokens.every(token => comparator(token, parsed.v))
  })
}

/** Where a runtime's binary comes from, as `runtime.versions` reports it. */
export interface RuntimeAvailability {
  readonly installed: boolean
  readonly source?: 'builtin' | 'prefix' | 'path' | 'flag'
  readonly bin?: string
}

/** The last install of one runtime, kept across restarts. */
export interface RuntimeInstallRecord {
  readonly at: number
  readonly ok: boolean
  readonly version?: string
  readonly error?: string
  /** Why it failed, in `runtime.status` terms; never on the wire. */
  readonly code?: Extract<
    RuntimeFallbackCode,
    'install-failed' | 'smoke-failed' | 'no-node'
  >
}

/** What {@link RuntimeInstaller.ensureRuntimeInstalled} answers. */
export type RuntimeInstallResult =
  | { readonly ok: true; readonly version?: string }
  | {
      readonly ok: false
      /** The control link's refusal code. */
      readonly code: string
      readonly message: string
      readonly fallback?: RuntimeInstallRecord['code']
    }

export interface RuntimeUpdateOptions {
  /** Binaries given on the command line (`--runtime-bin`); never managed. */
  readonly bins?: Partial<Record<ExternalRuntimeKind, string>>
  readonly run?: RunCommand
  readonly npm?: string
  /** The Node.js executable `needsNode` is checked with (default `node`). */
  readonly node?: string
  /** A new binary is in place; idle children of this runtime may be recycled. */
  readonly onInstalled?: (kind: ExternalRuntimeKind) => void
  /** The compatibility check: `null` when `bin` works, else why not. */
  readonly smoke?: (
    kind: ExternalRuntimeKind,
    bin: string,
  ) => Promise<string | null>
  /** PATH lookup (default `Bun.which`); tests replace it. */
  readonly which?: (command: string) => string | null
  /** Free bytes on the filesystem holding `dir` (default `statfs`). */
  readonly freeBytes?: (dir: string) => number
  /** The agents configured on a runtime: `runtime.remove` refuses while any. */
  readonly inUse?: (kind: ExternalRuntimeKind) => readonly string[]
  /** The node's default runtime, for `runtime.versions`. */
  readonly defaultRuntime?: () => string
  readonly now?: () => number
}

/** The binary a new child of this runtime starts with. */
export function runtimeBin(
  kind: ExternalRuntimeKind,
  bins?: Partial<Record<ExternalRuntimeKind, string>>,
): string {
  return (
    bins?.[kind] ??
    managedRuntimeBin(kind) ??
    npmRuntime(kind)?.install.command ??
    kind
  )
}

function env(): Record<string, string> {
  const prefix = managedRuntimePrefix()
  return {
    PATH: process.env['PATH'] ?? '/usr/bin:/bin',
    HOME: qianmoConfigPath('runtimes', 'npm-home'),
    npm_config_cache: path.join(prefix, '.cache'),
    npm_config_userconfig: path.join(prefix, '.npmrc'),
    npm_config_update_notifier: 'false',
    npm_config_fund: 'false',
    npm_config_audit: 'false',
    DISABLE_AUTOUPDATER: '1',
  }
}

function installsFile(): string {
  return qianmoConfigPath('runtimes', 'installs.json')
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const SEMVER_IN_OUTPUT = /\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/

/**
 * The node's runtime installs: what is there, installing one (a control op
 * or {@link ensureRuntimeInstalled}), removing one. One install per runtime at
 * a time; the managed prefix itself is changed by one npm at a time.
 */
export class RuntimeInstaller {
  readonly #options: RuntimeUpdateOptions
  readonly #run: RunCommand
  readonly #installing = new Map<string, Promise<RuntimeInstallResult>>()
  readonly #listeners = new Set<(kind: ExternalRuntimeKind) => void>()
  #records: Record<string, RuntimeInstallRecord> | undefined
  /** The managed prefix's lock: npm never runs twice on it. */
  #prefixLock: Promise<unknown> = Promise.resolve()
  /** `undefined`: not checked yet; `null`: no Node.js found. */
  #nodeVersion: string | null | undefined
  /** Stops every command this installer runs (the node is shutting down). */
  readonly #stopping = new AbortController()

  constructor(options: RuntimeUpdateOptions = {}) {
    this.#options = options
    this.#run = options.run ?? runCommand
  }

  /** Binaries given on the command line. */
  get bins(): Partial<Record<ExternalRuntimeKind, string>> {
    return this.#options.bins ?? {}
  }

  /** Called whenever a runtime starts or finishes installing, or is removed. */
  onChange(listener: (kind: ExternalRuntimeKind) => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }
  #changed(kind: ExternalRuntimeKind): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener(kind)
      } catch {
        // One listener's failure is not the install's.
      }
    }
  }

  /** Whether a new child of `kind` has a binary to start, and from where. */
  availability(kind: string): RuntimeAvailability {
    const spec = runtimeSpec(kind)
    if (spec === undefined) return { installed: false }
    if (spec.install.kind === 'builtin')
      return { installed: true, source: 'builtin' }
    const flag = this.#options.bins?.[kind]
    if (flag !== undefined)
      return { installed: true, source: 'flag', bin: flag }
    const managed = managedRuntimeBin(kind)
    if (managed !== undefined)
      return { installed: true, source: 'prefix', bin: managed }
    const which =
      this.#options.which ?? ((command: string) => Bun.which(command))
    const found = which(spec.install.command)
    return found === null || found === undefined
      ? { installed: false }
      : { installed: true, source: 'path', bin: found }
  }

  installing(kind: string): boolean {
    return this.#installing.has(kind)
  }

  lastInstall(kind: string): RuntimeInstallRecord | undefined {
    return this.#loadRecords()[kind]
  }

  #loadRecords(): Record<string, RuntimeInstallRecord> {
    if (this.#records !== undefined) return this.#records
    let records: Record<string, RuntimeInstallRecord> = {}
    try {
      const raw: unknown = JSON.parse(readTextIfExists(installsFile()) ?? '{}')
      if (raw && typeof raw === 'object' && !Array.isArray(raw))
        records = Object.fromEntries(
          Object.entries(raw).filter(
            ([kind, value]) =>
              runtimeSpec(kind) !== undefined &&
              value !== null &&
              typeof value === 'object' &&
              typeof (value as { at?: unknown }).at === 'number' &&
              typeof (value as { ok?: unknown }).ok === 'boolean',
          ),
        ) as Record<string, RuntimeInstallRecord>
    } catch {
      // A damaged record only loses history; the next install writes anew.
    }
    this.#records = records
    return records
  }

  #record(kind: string, record: RuntimeInstallRecord): void {
    this.#records = { ...this.#loadRecords(), [kind]: record }
    try {
      writePrivateJson(installsFile(), this.#records)
    } catch {
      // Kept in memory for this process; the status stays right.
    }
  }

  /** Whether the node's Node.js is in `range`; `undefined` before a check. */
  nodeSatisfies(range: string): boolean | undefined {
    if (this.#nodeVersion === undefined) return undefined
    return (
      this.#nodeVersion !== null &&
      satisfiesVersionRange(this.#nodeVersion, range)
    )
  }

  /** Runs `node --version` (the runtimes' PATH); `null` when there is none. */
  async checkNode(): Promise<string | null> {
    let found: string | null = null
    try {
      const result = await this.#run(
        [this.#options.node ?? 'node', '--version'],
        {
          env: env(),
          timeoutMs: 15_000,
          signal: this.#stopping.signal,
        },
      )
      if (result.code === 0)
        found = SEMVER_IN_OUTPUT.exec(result.stdout)?.[0] ?? null
    } catch {
      found = null
    }
    this.#nodeVersion = found
    return found
  }

  async #version(bin: string): Promise<string | null> {
    try {
      const result = await this.#run([bin, '--version'], {
        env: env(),
        timeoutMs: 15_000,
        signal: this.#stopping.signal,
      })
      return result.code === 0
        ? (SEMVER_IN_OUTPUT.exec(result.stdout)?.[0] ?? null)
        : null
    } catch {
      return null
    }
  }

  /** One row per catalog entry (`runtime.versions`). */
  async versions(): Promise<RuntimeVersionsReply> {
    const rows = await Promise.all(
      RUNTIME_CATALOG.map(async (spec): Promise<RuntimeVersionRow> => {
        if (spec.install.kind === 'builtin')
          return {
            id: spec.id,
            label: spec.label,
            installed: true,
            version: ompVersion(),
            source: 'builtin',
            installing: false,
            verified: spec.verified,
          }
        const here = this.availability(spec.id)
        const version =
          here.bin === undefined ? null : await this.#version(here.bin)
        const last = this.lastInstall(spec.id)
        return {
          id: spec.id,
          label: spec.label,
          installed: here.installed,
          ...(version === null ? {} : { version }),
          ...(here.source === undefined ? {} : { source: here.source }),
          pin: spec.install.pin,
          installing: this.installing(spec.id),
          ...(last === undefined
            ? {}
            : {
                lastInstall: {
                  at: last.at,
                  ok: last.ok,
                  ...(last.version === undefined
                    ? {}
                    : { version: last.version }),
                  ...(last.error === undefined ? {} : { error: last.error }),
                },
              }),
          verified: spec.verified,
        }
      }),
    )
    return {
      defaultRuntime: this.#options.defaultRuntime?.() ?? DEFAULT_RUNTIME,
      runtimes: rows,
    }
  }

  /** Refusals that need no attempt: unknown, built in, given by a flag, bad version. */
  #refusal(
    kind: unknown,
    version: unknown,
  ): Extract<RuntimeInstallResult, { ok: false }> | NpmRuntime {
    const id = typeof kind === 'string' ? normalizeRuntimeId(kind) : undefined
    if (id === undefined)
      return {
        ok: false,
        code: RUNTIME_ERRORS.unknownRuntime,
        message: `目录里没有这个底层：${String(kind)}`,
      }
    const spec = npmRuntime(id)
    if (spec === undefined)
      return {
        ok: false,
        code: RUNTIME_ERRORS.builtin,
        message: 'qianmopi 内置在 qm 里，不需要安装或卸载',
      }
    if (
      version !== undefined &&
      (typeof version !== 'string' || !VERSION.test(version))
    )
      return {
        ok: false,
        code: 'invalid',
        message: '版本号必须是确切的版本（如 1.2.3），不接受范围或标签',
      }
    if (this.#options.bins?.[id] !== undefined)
      return {
        ok: false,
        code: 'refused',
        message: '这个节点用启动参数指定了该底层的路径，不由阡陌安装或更新',
      }
    return spec
  }

  /**
   * Installs `version` (default: the catalog pin) of an npm runtime. A second
   * request for a runtime already installing is refused (`E_RUNTIME_BUSY`).
   */
  async install(
    kind: unknown,
    version?: unknown,
  ): Promise<RuntimeInstallResult> {
    const spec = this.#refusal(kind, version)
    if ('ok' in spec) return spec
    if (this.#installing.has(spec.id))
      return {
        ok: false,
        code: RUNTIME_ERRORS.busy,
        message: `${spec.label} 正在安装`,
      }
    const wanted = typeof version === 'string' ? version : spec.install.pin
    const attempt = this.#attempt(spec, wanted)
    this.#installing.set(spec.id, attempt)
    this.#changed(spec.id)
    try {
      return await attempt
    } finally {
      this.#installing.delete(spec.id)
      this.#changed(spec.id)
    }
  }

  /**
   * Makes sure `kind` has a binary: already there (prefix, PATH or flag),
   * joins an install in progress, or installs the catalog pin.
   */
  async ensureRuntimeInstalled(
    kind: ExternalRuntimeKind,
  ): Promise<RuntimeInstallResult> {
    if (this.availability(kind).installed) return { ok: true }
    const running = this.#installing.get(kind)
    if (running !== undefined) return running
    return this.install(kind)
  }

  async #attempt(
    spec: NpmRuntime,
    wanted: string,
  ): Promise<RuntimeInstallResult> {
    const fail = (
      fallback: NonNullable<RuntimeInstallRecord['code']>,
      message: string,
    ): RuntimeInstallResult => {
      // Cut short by the node stopping: not a verdict on the runtime.
      if (!this.#stopping.signal.aborted)
        this.#record(spec.id, {
          at: this.#now(),
          ok: false,
          version: wanted,
          error: message.slice(0, 300),
          code: fallback,
        })
      return {
        ok: false,
        code: RUNTIME_ERRORS.installFailed,
        message,
        fallback,
      }
    }
    try {
      const needsNode = spec.install.needsNode
      if (needsNode !== undefined) {
        const node = await this.checkNode()
        if (node === null || !satisfiesVersionRange(node, needsNode))
          return fail(
            'no-node',
            `缺少 Node.js（${spec.label} 需要 ${needsNode}${node === null ? '' : `，节点上是 ${node}`}）`,
          )
      }
      // Already there: nothing to download.
      const local = this.availability(spec.id)
      if (
        local.source === 'prefix' &&
        local.bin !== undefined &&
        (await this.#version(local.bin)) === wanted
      ) {
        this.#record(spec.id, { at: this.#now(), ok: true, version: wanted })
        return { ok: true, version: wanted }
      }
      const root = qianmoConfigPath('runtimes')
      const prefix = managedRuntimePrefix()
      mkdirSync(prefix, { recursive: true, mode: 0o700 })
      mkdirSync(qianmoConfigPath('runtimes', 'npm-home'), {
        recursive: true,
        mode: 0o700,
      })
      // Never a partial install: not starting is better than a half prefix.
      const need = diskMiB(spec)
      const free = (
        this.#options.freeBytes ??
        ((dir: string) => {
          const stats = statfsSync(dir)
          return stats.bavail * stats.bsize
        })
      )(root)
      if (free < need * MIB)
        return fail('install-failed', `磁盘空间不足（需要约 ${need} MiB）`)
      const npmInstall = (into: string, timeoutMs: number) =>
        this.#run(
          [
            this.#options.npm ?? 'npm',
            'install',
            '--prefix',
            into,
            '--save-exact',
            '--no-audit',
            '--no-fund',
            `${spec.install.package}@${wanted}`,
          ],
          { env: env(), timeoutMs, signal: this.#stopping.signal },
        ).catch(() => ({ code: -1, stdout: '' }))
      // Scratch prefix first; the managed one only gets a version that passed.
      // The budget stays inside the hub's 11 minutes for one update.
      const stage = qianmoConfigPath('runtimes', `npm-stage-${randomUUID()}`)
      try {
        mkdirSync(stage, { recursive: true, mode: 0o700 })
        // npm's warnings (blocked install scripts) are not failures; its exit is.
        if ((await npmInstall(stage, 6 * 60_000)).code !== 0)
          return fail(
            'install-failed',
            `npm 安装 ${spec.install.package}@${wanted} 失败`,
          )
        const candidate = path.join(
          stage,
          'node_modules',
          '.bin',
          spec.install.command,
        )
        const staged = await this.#version(candidate)
        if (staged !== wanted)
          return fail(
            'install-failed',
            `安装后版本是 ${staged ?? '未知'}，不是 ${wanted}`,
          )
        const smoke = this.#options.smoke ?? runtimeSmoke
        const reason = await smoke(spec.id, candidate).catch(errorText)
        if (reason !== null)
          return fail(
            'smoke-failed',
            `${wanted} 没有通过兼容检查，节点继续用原来的版本：${reason}`,
          )
      } finally {
        rmSync(stage, { recursive: true, force: true })
      }
      // From npm's cache now: the same files that passed.
      const installed = await this.#withPrefix(() =>
        npmInstall(prefix, 3 * 60_000),
      )
      if (installed.code !== 0)
        return fail(
          'install-failed',
          `npm 安装 ${spec.install.package}@${wanted} 失败`,
        )
      const bin = managedRuntimeBin(spec.id)
      const now = bin === undefined ? null : await this.#version(bin)
      if (now !== wanted)
        return fail(
          'install-failed',
          `安装后版本是 ${now ?? '未知'}，不是 ${wanted}`,
        )
      this.#record(spec.id, { at: this.#now(), ok: true, version: now })
      this.#options.onInstalled?.(spec.id)
      return { ok: true, version: now }
    } catch (error) {
      return fail('install-failed', `安装失败：${errorText(error)}`)
    }
  }

  #withPrefix<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#prefixLock.then(work, work)
    this.#prefixLock = next.catch(() => {})
    return next
  }

  /** Removes an npm runtime from the managed prefix (only from there). */
  async remove(kind: unknown): Promise<ControlOutcome> {
    const spec = this.#refusal(kind, undefined)
    if ('ok' in spec) return spec
    const users = this.#options.inUse?.(spec.id) ?? []
    if (users.length > 0)
      return {
        ok: false,
        code: RUNTIME_ERRORS.inUse,
        message: `${spec.label} 正被这些智能体使用：${users.join('、')}；先把它们改到别的底层`,
      }
    if (this.#installing.has(spec.id))
      return {
        ok: false,
        code: RUNTIME_ERRORS.busy,
        message: `${spec.label} 正在安装`,
      }
    if (managedRuntimeBin(spec.id) === undefined)
      return { ok: true, value: { runtime: spec.id, removed: false } }
    const removed = await this.#withPrefix(() =>
      this.#run(
        [
          this.#options.npm ?? 'npm',
          'uninstall',
          '--prefix',
          managedRuntimePrefix(),
          '--no-audit',
          '--no-fund',
          spec.install.package,
        ],
        { env: env(), timeoutMs: 3 * 60_000, signal: this.#stopping.signal },
      ).catch(() => ({ code: -1, stdout: '' })),
    )
    this.#changed(spec.id)
    if (removed.code !== 0 || managedRuntimeBin(spec.id) !== undefined)
      return {
        ok: false,
        code: RUNTIME_ERRORS.installFailed,
        message: `npm 卸载 ${spec.install.package} 失败`,
      }
    return { ok: true, value: { runtime: spec.id, removed: true } }
  }

  #now(): number {
    return (this.#options.now ?? Date.now)()
  }

  /**
   * The node is stopping: running npm commands are killed so the process can
   * exit, and nothing they leave unfinished is recorded as a failure.
   */
  stop(): void {
    this.#stopping.abort()
  }

  /** `runtime.versions`, `runtime.install`, `runtime.update`, `runtime.remove`. */
  readonly control: ControlHandler = async (op, args) => {
    if (op === RUNTIME_OPS.versions)
      return { ok: true, value: await this.versions() }
    if (op === RUNTIME_OPS.install || op === RUNTIME_OPS.update) {
      const result = await this.install(args['runtime'], args['version'])
      return result.ok
        ? {
            ok: true,
            value: { runtime: args['runtime'], version: result.version },
          }
        : { ok: false, code: result.code, message: result.message }
    }
    if (op === RUNTIME_OPS.remove) return this.remove(args['runtime'])
    return { ok: false, code: 'unsupported', message: '不支持此底层操作' }
  }
}

/** The installer's control ops on their own (no roster: `remove` never refuses as in use). */
export function runtimeControl(
  options: RuntimeUpdateOptions = {},
): ControlHandler {
  return new RuntimeInstaller(options).control
}
