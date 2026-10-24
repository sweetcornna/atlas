// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Installing the runtimes of the catalog (P31, P36.3; `harness-backends.md`
 * §2, `runtimes-channels.md` §5): every `npm` entry of `RUNTIME_CATALOG`
 * (DeepSeek Harness, Claude Code, Codex, …) is installed unmodified from its
 * official package into a qianmo-owned tree of its own under
 * `qianmoConfigPath('runtimes', 'trees')`. New runtime children start from
 * there; running ones finish on the old binary and are recycled when idle. npm's cache, config and HOME live
 * under the qianmo config root too: nothing here reads or writes the user's
 * own `~/.npm`, `~/.claude` or `~/.codex`.
 *
 * A version is installed into a tree of its own staged beside the live one
 * (`qianmoConfigPath('runtimes', 'trees')`) and must pass the compatibility
 * check (`runtimes/smoke.ts`: the node's own arguments, the `qianmo` tool
 * bridge); only then is that same tree made live, by swapping the runtime's
 * link onto it in one rename (no second npm resolution). One that fails
 * leaves the node on the version it had, and the answer says why. Installs
 * of earlier builds in the shared prefix are still found and removed. A
 * runtime that needs Node.js is not installed on a node without a matching
 * one, and nothing starts without the disk space a whole install takes;
 * the default install also waits for {@link INSTALL_MEMORY_MIB} of available
 * memory.
 *
 * Binaries given with `--runtime-bin` (or its aliases `--claude-code-bin`,
 * `--codex-bin`) are the operator's: they are reported, never managed.
 */

import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  statfsSync,
  symlinkSync,
} from 'node:fs'
import { rm } from 'node:fs/promises'
import { freemem } from 'node:os'
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
 * Free space one install needs: the staged tree beside the live one it
 * replaces, and npm's cache. dsh unpacks to about 854 MB (`dsh-acp-facts.md`).
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

/**
 * Memory the default install needs free before it starts (§2): npm unpacking
 * dsh and the compatibility check's harness process beside a running node.
 * Below it the default install is refused like a failed one and retried on
 * the backoff. An operator's `runtime.install` / `runtime.update` is their
 * call and does not wait for it (the disk floor applies to every install).
 */
export const INSTALL_MEMORY_MIB = 1536

/** How long `runtime.versions` reuses a binary's `--version` answer. */
export const VERSION_CACHE_MS = 10 * 60_000

/** `MemAvailable` of a `/proc/meminfo` text, in bytes (absent before Linux 3.14). */
export function memAvailableBytes(meminfo: string): number | undefined {
  const kib = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(meminfo)?.[1]
  return kib === undefined ? undefined : Number(kib) * 1024
}

/**
 * Free, inactive and speculative pages of a `vm_stat` text, in bytes: what
 * macOS can hand a new process without swapping.
 */
export function vmStatAvailableBytes(vmStat: string): number | undefined {
  const page = /page size of (\d+) bytes/.exec(vmStat)?.[1]
  const pages = ['free', 'inactive', 'speculative'].map(
    name => new RegExp(`^Pages ${name}:\\s+(\\d+)\\.`, 'm').exec(vmStat)?.[1],
  )
  if (page === undefined || pages.some(count => count === undefined))
    return undefined
  return pages.reduce((sum, count) => sum + Number(count), 0) * Number(page)
}

/**
 * Memory a new process can take: `MemAvailable` on Linux and the reclaimable
 * pages on macOS (free memory alone leaves out the caches the kernel gives
 * back; on macOS `os.freemem()` is a few hundred MiB on a machine with GiBs
 * to spare), else `os.freemem()`.
 */
export function availableMemoryBytes(): number {
  try {
    if (process.platform === 'linux') {
      const bytes = memAvailableBytes(readFileSync('/proc/meminfo', 'utf8'))
      if (bytes !== undefined) return bytes
    } else if (process.platform === 'darwin') {
      const bytes = vmStatAvailableBytes(
        execFileSync('/usr/bin/vm_stat', { encoding: 'utf8', timeout: 5_000 }),
      )
      if (bytes !== undefined) return bytes
    }
  } catch {
    // No procfs or vm_stat: what the OS says is free.
  }
  return freemem()
}

/**
 * The node's npm home: its cache and config, and the shared prefix earlier
 * builds installed every runtime into (still read, see `managedRuntimeBin`).
 */
export function managedRuntimePrefix(): string {
  return qianmoConfigPath('runtimes', 'npm')
}

function treesDir(): string {
  return qianmoConfigPath('runtimes', 'trees')
}

/**
 * Where a runtime is installed now: its own npm tree, behind a link that an
 * install swaps whole for the tree that passed its checks.
 */
export function managedRuntimeTree(kind: ExternalRuntimeKind): string {
  return path.join(treesDir(), kind)
}

/** The installed binary of a managed runtime, when an install put one there. */
export function managedRuntimeBin(
  kind: ExternalRuntimeKind,
): string | undefined {
  const spec = npmRuntime(kind)
  if (spec === undefined) return undefined
  for (const prefix of [managedRuntimeTree(kind), managedRuntimePrefix()]) {
    const bin = path.join(prefix, 'node_modules', '.bin', spec.install.command)
    if (existsSync(bin)) return bin
  }
  return undefined
}

/** A runtime's trees on disk (`<kind>-<id>`), the live one among them. */
function runtimeTrees(kind: string): string[] {
  try {
    return readdirSync(treesDir())
      .filter(
        name =>
          name.startsWith(`${kind}-`) &&
          /^[0-9a-f-]{36}$/.test(name.slice(kind.length + 1)),
      )
      .map(name => path.join(treesDir(), name))
  } catch {
    return []
  }
}

function liveTree(kind: string): string | undefined {
  try {
    return path.resolve(treesDir(), readlinkSync(managedRuntimeTree(kind)))
  } catch {
    return undefined
  }
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
    /** After a stop, how long it gets before it is killed outright; default 5 s. */
    readonly killGraceMs?: number
  },
) => Promise<RunResult>

/**
 * After a command exits, how long its pipes get to close; a process it left
 * behind (an npm lifecycle script's) that still holds them is then killed.
 */
const PIPE_GRACE_MS = 2_000

/** Runs a command without a shell; output is capped. */
export const runCommand: RunCommand = async (argv, options) => {
  const child = Bun.spawn([...argv], {
    env: options.env,
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    // A process group of its own, so a stop reaches what it started (npm's
    // lifecycle scripts) and not only the command.
    detached: process.platform !== 'win32',
  })
  const signalAll = (signal: NodeJS.Signals) => {
    if (process.platform === 'win32') child.kill(signal)
    else
      try {
        process.kill(-child.pid, signal)
      } catch {
        // The whole group is gone.
      }
  }
  let force: ReturnType<typeof setTimeout> | undefined
  const stop = () => {
    if (force !== undefined) return
    signalAll('SIGTERM')
    // One that ignores the signal (npm and its lifecycle children can) goes anyway.
    force = setTimeout(() => signalAll('SIGKILL'), options.killGraceMs ?? 5_000)
  }
  const timer = setTimeout(stop, options.timeoutMs)
  options.signal?.addEventListener('abort', stop, { once: true })
  if (options.signal?.aborted) stop()
  const out = child.stdout.getReader()
  const err = child.stderr.getReader()
  // Both read as they come, so a chatty command never blocks on a full pipe,
  // and only the first `maxOutput` characters of stdout are kept.
  const reading = Promise.all([
    readCapped(out, options.maxOutput ?? 4_000),
    drain(err),
  ])
  let late: ReturnType<typeof setTimeout> | undefined
  // Output cut off when the pipes were: it may be incomplete.
  let cutOff = false
  try {
    const code = await child.exited
    // Stopped: what it started goes with it, now.
    if (force !== undefined) signalAll('SIGKILL')
    late = setTimeout(() => {
      // Exited, but something it started still holds the pipes: it goes too.
      cutOff = true
      signalAll('SIGKILL')
      out.cancel().catch(() => {})
      err.cancel().catch(() => {})
    }, PIPE_GRACE_MS)
    const [stdout] = await reading
    return {
      code,
      stdout: stdout.stdout,
      truncated: stdout.truncated || cutOff,
    }
  } finally {
    clearTimeout(timer)
    clearTimeout(force)
    clearTimeout(late)
    options.signal?.removeEventListener('abort', stop)
  }
}

/** What reading a pipe needs of its reader. */
interface PipeReader {
  read(): Promise<{ done: boolean; value?: Uint8Array }>
  releaseLock(): void
}

async function readCapped(
  reader: PipeReader,
  max: number,
): Promise<{ stdout: string; truncated: boolean }> {
  const decoder = new TextDecoder()
  let text = ''
  let cut = false
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (text.length > max) cut = true
      else text += decoder.decode(value, { stream: true })
    }
    if (!cut) text += decoder.decode()
  } catch {
    // Closed with the process.
  } finally {
    reader.releaseLock()
  }
  return { stdout: text.slice(0, max), truncated: cut || text.length > max }
}

async function drain(reader: PipeReader): Promise<void> {
  try {
    for (;;) if ((await reader.read()).done) return
  } catch {
    // Closed with the process.
  } finally {
    reader.releaseLock()
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
  /** A binary of its name on PATH that was not taken, and why. */
  readonly rejected?: string
}

/**
 * How a runtime is told apart from other programs of the same name on PATH,
 * by what the runtime prints itself (the catalog's `install.identity`: only
 * DeepSeek Harness, whose name Debian's and pdsh's `dsh` share). A binary
 * given by flag is the operator's and is not asked; the managed prefix only
 * holds what passed the compatibility check.
 */
function identityRule(kind: string): NpmInstall['identity'] {
  return npmRuntime(kind)?.install.identity
}

/** One PATH binary checked against its {@link identityRule}. */
interface PathCheck {
  readonly bin: string
  /** `null`: it is the runtime; a string: why it is not; absent: running. */
  verdict?: string | null
  done?: Promise<void>
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
  /**
   * Failed installs in a row, this one included (only on a failure; a record
   * from before the count existed counts as one). The default install's
   * backoff reads it after a restart; never on the wire.
   */
  readonly failures?: number
  /**
   * Written when the install began and never replaced: the node died in it.
   * `at` is when it began, which says nothing about when it died, so the
   * default install's backoff counts from the restart that finds it; never
   * on the wire.
   */
  readonly unfinished?: true
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
  /** Memory available to a new process (default {@link availableMemoryBytes}). */
  readonly freeMemoryBytes?: () => number
  /**
   * Removes a scratch prefix and all under it, off the event loop (default
   * `fs.promises.rm`, recursive: links are removed, never followed).
   */
  readonly removeTree?: (dir: string) => Promise<void>
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

/** Refused once the installer stopped (the node is shutting down). */
const STOPPING = {
  ok: false,
  code: RUNTIME_ERRORS.busy,
  message: '节点正在停机，不开始新的安装或卸载',
} as const

/** What an install that never ended reads as after a restart. */
const UNFINISHED =
  '上一次安装没有结束（节点在安装中途退出，常见原因是内存不足被系统结束）'

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
/** A scratch prefix of an earlier build's install, under the runtimes root. */
const STAGE_NAME = new RegExp(`^npm-stage-${UUID}$`)
/** A staged tree of one install, beside the live trees. */
const TREE_STAGE_NAME = new RegExp(`^\\.stage-[a-z0-9-]+-${UUID}$`)
/** A link an install made and had not swapped in yet. */
const LINK_NAME = new RegExp(`^\\.[a-z0-9-]+\\.link-${UUID}$`)

/** Failed installs in a row a record stands for (0 after a success). */
export function failuresOf(record: RuntimeInstallRecord | undefined): number {
  if (record === undefined || record.ok) return 0
  const failures = record.failures
  return typeof failures === 'number' &&
    Number.isSafeInteger(failures) &&
    failures > 0
    ? failures
    : 1
}

/**
 * The node's runtime installs: what is there, installing one (a control op
 * or {@link ensureRuntimeInstalled}), removing one. One install at a time,
 * whichever runtime; the live trees and the shared prefix are changed one
 * step at a time.
 */
export class RuntimeInstaller {
  readonly #options: RuntimeUpdateOptions
  readonly #run: RunCommand
  readonly #installing = new Map<string, Promise<RuntimeInstallResult>>()
  /**
   * Removals running now, by runtime: no install starts on one until it is
   * done, and the default install waits for it before looking.
   */
  readonly #removing = new Map<string, Promise<unknown>>()
  readonly #listeners = new Set<(kind: ExternalRuntimeKind) => void>()
  #records: Record<string, RuntimeInstallRecord> | undefined
  /** Promotions and removals, one at a time. */
  #prefixLock: Promise<unknown> = Promise.resolve()
  /** One install at a time, whichever runtime: each checks memory and disk alone. */
  #attemptLock: Promise<unknown> = Promise.resolve()
  /** `undefined`: not checked yet; `null`: no Node.js found. */
  #nodeVersion: string | null | undefined
  /** Scratch prefixes of the installs running now. */
  readonly #stages = new Set<string>()
  /**
   * The installs running now, with the last finished install of each: on
   * disk they read as an unfinished one (see `#attempt`), here they do not.
   */
  readonly #unfinished = new Map<string, RuntimeInstallRecord | undefined>()
  /** PATH binaries checked against their {@link identityRule}, by runtime. */
  readonly #onPath = new Map<string, PathCheck>()
  /** The leftover sweeps under way: an install checks the disk after them. */
  #sweeping: Promise<unknown> = Promise.resolve()
  /**
   * `runtime.versions`' `--version` answers by runtime, for one binary path;
   * reads at the same time share the one in flight. Dropped when the
   * runtime is installed or removed, and after {@link VERSION_CACHE_MS}.
   */
  readonly #versions = new Map<
    string,
    {
      readonly bin: string
      readonly at: number
      readonly version: Promise<string | null>
    }
  >()
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
    // A new binary, or none: whatever its `--version` said is stale.
    this.#versions.delete(kind)
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
    const found = this.#which(spec.install.command)
    if (found === null) return { installed: false }
    if (identityRule(kind) !== undefined) {
      // Taken only once it said who it is (`checkPath`).
      const check = this.#onPath.get(kind)
      if (check?.bin !== found || check.verdict === undefined)
        return {
          installed: false,
          rejected: `PATH 上的 ${found} 还没有核对是不是 ${spec.label}`,
        }
      if (check.verdict !== null)
        return { installed: false, rejected: check.verdict }
    }
    return { installed: true, source: 'path', bin: found }
  }

  #which(command: string): string | null {
    const which = this.#options.which ?? ((name: string) => Bun.which(name))
    return which(command) ?? null
  }

  /**
   * Asks the PATH binary of `kind` who it is, for the runtimes that need it
   * ({@link identityRule}); until then, and when it is another program, it
   * does not count as installed. Once per binary path; callers at the same
   * time share the one check. Nothing to do for a runtime given by flag or
   * in the managed prefix.
   */
  checkPath(kind: string): Promise<void> {
    const rule = identityRule(kind)
    const spec = npmRuntime(kind)
    if (
      rule === undefined ||
      spec === undefined ||
      this.#options.bins?.[kind] !== undefined ||
      managedRuntimeBin(kind) !== undefined
    )
      return Promise.resolve()
    const found = this.#which(spec.install.command)
    if (found === null) return Promise.resolve()
    const known = this.#onPath.get(kind)
    if (known?.bin === found && known.done !== undefined) return known.done
    const check: PathCheck = { bin: found }
    check.done = (async () => {
      const shown = `${spec.install.command} ${rule.args.join(' ')}`
      try {
        const result = await this.#run([found, ...rule.args], {
          env: env(),
          timeoutMs: 15_000,
          signal: this.#stopping.signal,
        })
        check.verdict = rule.name.test(result.stdout)
          ? null
          : `PATH 上的 ${found} 不是 ${spec.label}（它的 ${rule.args.join(' ')} 里没有这个名字），当作没有安装`
      } catch (error) {
        check.verdict = `PATH 上的 ${found} 核对不了（${shown}：${errorText(error)}），当作没有安装`
      }
      this.#changed(spec.id)
    })()
    this.#onPath.set(kind, check)
    return check.done
  }

  installing(kind: string): boolean {
    return this.#installing.has(kind)
  }

  /** The last install of `kind` that finished (in any run of the node). */
  lastInstall(kind: string): RuntimeInstallRecord | undefined {
    if (this.#unfinished.has(kind)) return this.#unfinished.get(kind)
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

  /** Writes `kind`'s record; `undefined` removes it. */
  #record(kind: string, record: RuntimeInstallRecord | undefined): void {
    const records = { ...this.#loadRecords() }
    if (record === undefined) delete records[kind]
    else records[kind] = record
    this.#records = records
    try {
      writePrivateJson(installsFile(), this.#records)
    } catch {
      // Kept in memory for this process; the status stays right.
    }
  }

  #removeTree(dir: string): Promise<void> {
    return (
      this.#options.removeTree ??
      ((tree: string) => rm(tree, { recursive: true, force: true }))
    )(dir)
  }

  /**
   * Removes what installs left when the node died during one: staged trees
   * (`.stage-<runtime>-<uuid>` beside the live trees, `npm-stage-<uuid>` of
   * earlier builds under the runtimes root) and links not yet swapped in
   * (`.<runtime>.link-<uuid>`), none of this process's running installs. The
   * live trees (`<runtime>-<uuid>`, the one each `<runtime>` link points at
   * and the one it replaced, kept for a round) never match. A staged entry
   * that is a link or a file is left alone; a directory's own links are
   * removed, never followed, and a leftover link is unlinked, not followed.
   * The removal is asynchronous — one leftover of dsh is about 850 MB, and
   * the node is serving by the time this runs — so callers need not wait; a
   * new install never meets one of these (its stage has a fresh uuid), and
   * it checks the disk only once the sweep is over (the space is on its way
   * back). Resolves to what went.
   */
  sweepStages(): Promise<string[]> {
    const sweep = this.#sweep()
    this.#sweeping = Promise.all([this.#sweeping, sweep]).catch(() => {})
    return sweep
  }

  async #sweep(): Promise<string[]> {
    const removed: string[] = []
    const sweep = async (root: string, stage: RegExp, link?: RegExp) => {
      // Listing one directory of a handful of entries is synchronous (and so
      // is a sweep with nothing to remove); removing a tree is not.
      let names: string[]
      try {
        names = readdirSync(root)
      } catch {
        return
      }
      for (const name of names) {
        const entry = path.join(root, name)
        try {
          const stat = lstatSync(entry)
          // Checked last thing before the removal: an install that made its
          // stage since the listing is in `#stages` by now.
          if (this.#stages.has(entry)) continue
          if (stage.test(name) && stat.isDirectory())
            await this.#removeTree(entry)
          else if (link?.test(name) === true && stat.isSymbolicLink())
            rmSync(entry, { force: true })
          else continue
          removed.push(entry)
        } catch {
          // Left for the next start.
        }
      }
    }
    await sweep(qianmoConfigPath('runtimes'), STAGE_NAME)
    await sweep(treesDir(), TREE_STAGE_NAME, LINK_NAME)
    return removed
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

  /** `bin`'s version for `runtime.versions`, reused per {@link VERSION_CACHE_MS}. */
  #reportedVersion(kind: string, bin: string): Promise<string | null> {
    const now = this.#now()
    const known = this.#versions.get(kind)
    if (
      known !== undefined &&
      known.bin === bin &&
      now >= known.at &&
      now - known.at < VERSION_CACHE_MS
    )
      return known.version
    const version = this.#version(bin)
    this.#versions.set(kind, { bin, at: now, version })
    return version
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
        await this.checkPath(spec.id)
        const here = this.availability(spec.id)
        const version =
          here.bin === undefined
            ? null
            : await this.#reportedVersion(spec.id, here.bin)
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
  install(kind: unknown, version?: unknown): Promise<RuntimeInstallResult> {
    return this.#install(kind, version, false)
  }

  async #install(
    kind: unknown,
    version: unknown,
    /** The default install: also waits for {@link INSTALL_MEMORY_MIB}. */
    automatic: boolean,
  ): Promise<RuntimeInstallResult> {
    const spec = this.#refusal(kind, version)
    if ('ok' in spec) return spec
    // Before the "unfinished" record: one written now would never be
    // replaced (every ending sees the stop) and the next start would back off.
    if (this.#stopping.signal.aborted) return STOPPING
    if (this.#installing.has(spec.id))
      return {
        ok: false,
        code: RUNTIME_ERRORS.busy,
        message: `${spec.label} 正在安装`,
      }
    if (this.#removing.has(spec.id))
      return {
        ok: false,
        code: RUNTIME_ERRORS.busy,
        message: `${spec.label} 正在卸载`,
      }
    const wanted = typeof version === 'string' ? version : spec.install.pin
    // One install at a time, whichever runtime: each checks memory and disk
    // alone. The "unfinished" record is written when its turn comes.
    const begin = () => this.#begin(spec, wanted, automatic)
    const attempt = this.#attemptLock.then(begin, begin)
    this.#attemptLock = attempt.catch(() => {})
    this.#installing.set(spec.id, attempt)
    this.#changed(spec.id)
    try {
      return await attempt
    } finally {
      this.#unfinished.delete(spec.id)
      this.#installing.delete(spec.id)
      this.#changed(spec.id)
    }
  }

  /**
   * The default install (§2): makes sure `kind` has a binary — already there
   * (prefix, PATH or flag), joins an install in progress, or installs the
   * catalog pin once {@link INSTALL_MEMORY_MIB} is available. A removal in
   * progress is waited out first: the binary it is deleting is not an
   * install, and its being busy is no failure to back off from.
   */
  async ensureRuntimeInstalled(
    kind: ExternalRuntimeKind,
  ): Promise<RuntimeInstallResult> {
    for (
      let removal = this.#removing.get(kind);
      removal !== undefined;
      removal = this.#removing.get(kind)
    )
      await removal
    await this.checkPath(kind)
    if (this.availability(kind).installed) return { ok: true }
    const running = this.#installing.get(kind)
    if (running !== undefined) return running
    return this.#install(kind, undefined, true)
  }

  /**
   * An install whose turn came. Before anything that can take the node down
   * with it (npm, the check): on disk this install is a failure until it
   * ends, one more in a row, so a node killed in the middle (an OOM kill,
   * most likely) backs off after the restart instead of installing again at
   * once. Its own ending writes the real verdict with the same count, or
   * clears it. Queued behind another while the node stopped: not begun.
   */
  #begin(
    spec: NpmRuntime,
    wanted: string,
    automatic: boolean,
  ): Promise<RuntimeInstallResult> {
    if (this.#stopping.signal.aborted) return Promise.resolve(STOPPING)
    const finished = this.lastInstall(spec.id)
    const failures = failuresOf(finished) + 1
    this.#unfinished.set(spec.id, finished)
    this.#record(spec.id, {
      at: this.#now(),
      ok: false,
      version: wanted,
      error: UNFINISHED,
      code: 'install-failed',
      failures,
      unfinished: true,
    })
    return this.#attempt(spec, wanted, automatic, failures)
  }

  async #attempt(
    spec: NpmRuntime,
    wanted: string,
    automatic: boolean,
    /** This one included, already on disk. */
    failures: number,
  ): Promise<RuntimeInstallResult> {
    const fail = (
      fallback: NonNullable<RuntimeInstallRecord['code']>,
      message: string,
    ): RuntimeInstallResult => {
      // Cut short by the node stopping: not a verdict on the runtime (`stop`
      // has put the last finished record back).
      if (!this.#stopping.signal.aborted)
        this.#record(spec.id, {
          at: this.#now(),
          ok: false,
          version: wanted,
          error: message.slice(0, 300),
          code: fallback,
          failures,
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
      mkdirSync(managedRuntimePrefix(), { recursive: true, mode: 0o700 })
      mkdirSync(treesDir(), { recursive: true, mode: 0o700 })
      mkdirSync(qianmoConfigPath('runtimes', 'npm-home'), {
        recursive: true,
        mode: 0o700,
      })
      // Never a partial install: not starting is better than a half prefix.
      // A leftover being swept is space on its way back: wait for it.
      await this.#sweeping
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
      const memory = automatic
        ? (this.#options.freeMemoryBytes ?? availableMemoryBytes)()
        : Number.POSITIVE_INFINITY
      if (memory < INSTALL_MEMORY_MIB * MIB)
        return fail(
          'install-failed',
          `可用内存不足（安装需要约 ${INSTALL_MEMORY_MIB} MiB，现有 ${Math.floor(memory / MIB)} MiB），稍后重试`,
        )
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
      // Its own tree, staged beside the live one; only a tree that passed
      // goes live, moved into place as it was checked. The budget stays
      // inside the hub's 11 minutes for one update.
      const stage = path.join(treesDir(), `.stage-${spec.id}-${randomUUID()}`)
      this.#stages.add(stage)
      let promoted = false
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
        await this.#withPrefix(async () => this.#promote(spec.id, stage))
        promoted = true
      } finally {
        // Best effort and off the event loop: what cannot go now goes at the
        // next start's sweep, and a failed cleanup is not a second verdict.
        if (!promoted) await this.#removeTree(stage).catch(() => {})
        this.#stages.delete(stage)
      }
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

  /**
   * Makes the checked tree at `stage` the live one: moved to its final name,
   * then the runtime's link swapped onto it in one rename. The tree it
   * replaces stays until the next install (a process may still run from it);
   * older ones go.
   */
  #promote(kind: string, stage: string): void {
    const tree = path.join(treesDir(), `${kind}-${randomUUID()}`)
    renameSync(stage, tree)
    const previous = liveTree(kind)
    const link = path.join(treesDir(), `.${kind}.link-${randomUUID()}`)
    symlinkSync(path.basename(tree), link)
    renameSync(link, managedRuntimeTree(kind))
    for (const old of runtimeTrees(kind))
      if (old !== tree && old !== previous)
        rmSync(old, { recursive: true, force: true })
  }

  #withPrefix<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#prefixLock.then(work, work)
    this.#prefixLock = next.catch(() => {})
    return next
  }

  /** Removes an npm runtime the node installed (only those). */
  async remove(kind: unknown): Promise<ControlOutcome> {
    const spec = this.#refusal(kind, undefined)
    if ('ok' in spec) return spec
    if (this.#stopping.signal.aborted) return STOPPING
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
    if (this.#removing.has(spec.id))
      return {
        ok: false,
        code: RUNTIME_ERRORS.busy,
        message: `${spec.label} 正在卸载`,
      }
    if (managedRuntimeBin(spec.id) === undefined)
      return { ok: true, value: { runtime: spec.id, removed: false } }
    // Held for the whole removal: an install that came in meanwhile would
    // see the binary still there and report it installed.
    const removal = this.#remove(spec)
    this.#removing.set(
      spec.id,
      removal.catch(() => {}),
    )
    try {
      return await removal
    } finally {
      this.#removing.delete(spec.id)
    }
  }

  async #remove(spec: NpmRuntime): Promise<ControlOutcome> {
    const removed = await this.#withPrefix(async () => {
      // Queued behind another change while the node stopped: not begun.
      if (this.#stopping.signal.aborted) return null
      // Its own trees, and the link to the live one.
      rmSync(managedRuntimeTree(spec.id), { force: true })
      for (const tree of runtimeTrees(spec.id))
        rmSync(tree, { recursive: true, force: true })
      // An install of an earlier build, in the shared prefix.
      const legacy = path.join(
        managedRuntimePrefix(),
        'node_modules',
        '.bin',
        spec.install.command,
      )
      if (!existsSync(legacy)) return { code: 0, stdout: '' }
      return this.#run(
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
      ).catch(() => ({ code: -1, stdout: '' }))
    })
    if (removed === null) return STOPPING
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
   * exit, and nothing they leave unfinished is recorded as a failure — the
   * last finished record of each goes back on disk now, before the exit.
   * From here on no install or removal starts (`E_RUNTIME_BUSY`): the
   * resident stops its runtimes before its control link closes.
   */
  stop(): void {
    for (const [kind, finished] of this.#unfinished)
      this.#record(kind, finished)
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
