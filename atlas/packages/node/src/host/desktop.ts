// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as fs from 'node:fs'
import * as path from 'node:path'
import { createHash, randomUUID, randomBytes } from 'node:crypto'
import { ptree } from '@oh-my-pi/pi-utils'
import { Process } from '@oh-my-pi/pi-natives'
import {
  caDir,
  memoryBaseDir,
  nodeHomeDir,
  protectedConfigRoots,
  qianmoConfigDir,
  qianmoConfigPath,
} from '@qianmo/paths'
import type {
  DesktopApps,
  DesktopNodeView,
  DesktopActionView,
  DesktopConfirm,
  DesktopScreenView,
} from '@qianmo/console'
import {
  desktopArgs,
  desktopNeedsApproval,
  desktopOp,
  isDesktopInvocationId,
  isDesktopTool,
  type DesktopArgs,
  type DesktopDecision,
  type DesktopResource,
  type DesktopTool,
} from '@qianmo/extension/desktopPolicy'
import { ResidentHardline, type AuthzCall } from '@qianmo/resident'
import { isValidSegment, type ControlOutcome } from '@qianmo/protocol'
import type { ControlHandler } from './control.js'
import type { ResidentAuthzEvent } from './residentAuthorization.js'
import {
  ensurePrivateDir,
  readTextIfExists,
  writePrivateJson,
} from '../providers/store.js'
import {
  DESKTOP_APPLICATION_DIRS,
  allowedDesktopApps,
  desktopApplications,
  isDesktopAppsPolicy,
  type DesktopApp,
} from './desktopApps.js'
import {
  AT_SPI_BUS_LAUNCHERS,
  DESKTOP_BWRAP_PROBE,
  DESKTOP_HOME_DIRS,
  DESKTOP_WINDOW_MANAGERS,
  desktopMemory,
  desktopSandboxArgv,
  desktopSandboxEnv,
  desktopScopeArgv,
  OPENBOX_CONFIG,
  type DesktopSandbox,
} from './desktopSandbox.js'
import {
  createCdpBridge,
  type CdpBridge,
  type CdpBridgeFactory,
  type CdpPipe,
} from './desktopCdp.js'
import {
  SCREEN_VIEW_BASE64,
  shrinkScreenshot,
  type ScreenEncoder,
} from './desktopScreen.js'

export interface DesktopProcess {
  readonly pid: number
  /** The host ends of the fd 3 and 4 it was started with, when asked. */
  readonly devtools?: CdpPipe
  alive(): boolean
  stop(): Promise<void>
}
export interface DesktopLauncher {
  available(program: string): boolean
  /**
   * With `devtools`, the process gets a socket pair on fd 3 and on fd 4 for
   * a browser's DevTools pipe (macOS only; Linux bridges through FIFOs).
   */
  start(
    program: string,
    argv: readonly string[],
    env: Record<string, string | undefined>,
    devtools?: boolean,
  ): Promise<DesktopProcess>
  run(
    program: string,
    argv: readonly string[],
    env: Record<string, string | undefined>,
  ): Promise<number>
  reap(pid: number, marker: string): Promise<void>
  /**
   * Resident memory of everything these started processes run, in bytes;
   * `null` (or no method) when the platform cannot tell.
   */
  memory?(pids: readonly number[]): number | null
}
const alive = (pid: number) => {
  for (const target of [-pid, pid]) {
    try {
      process.kill(target, 0)
      return true
    } catch {
      /* Already exited. */
    }
  }
  return false
}
async function confirmExit(pid: number): Promise<void> {
  const deadline = Date.now() + 3000
  while (alive(pid) && Date.now() < deadline) await Bun.sleep(25)
  if (alive(pid)) throw new Error('Desktop process tree did not exit')
}
export const desktopLauncher: DesktopLauncher = {
  available: program =>
    path.isAbsolute(program)
      ? fs.existsSync(program)
      : Bun.which(program) !== null,
  async start(program, argv, env, devtools) {
    // The Linux subreaper passes no descriptor past stdio.
    if (devtools && process.platform === 'linux')
      throw new Error('DevTools socket pairs are not passed on Linux')
    const child = ptree
      .spawn([program, ...argv], {
        detached: true,
        subreaper: true,
        env,
        ...(devtools
          ? { stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'] as const }
          : {}),
      })
      .nothrow()
    // Drain both pipes through the shared supervisor; no child output is logged.
    const closed = child.wait({ allowNonZero: true, allowAbort: true })
    void closed.catch(() => {})
    const extra = devtools ? (child.proc.stdio as unknown[]) : []
    return {
      pid: child.pid,
      ...(devtools
        ? {
            devtools: {
              input: extra[3] as number,
              output: extra[4] as number,
            },
          }
        : {}),
      alive: () => alive(child.pid),
      async stop() {
        child.attachTimeout(5000)
        child.kill(undefined, 1500)
        await closed
        await confirmExit(child.pid)
      },
    }
  },
  async run(program, argv, env) {
    // Probes and xauth finish at once; a hung one counts as a failure.
    const proc = Bun.spawn([program, ...argv], {
      env,
      stdout: 'ignore',
      stderr: 'ignore',
      timeout: 10_000,
    })
    return await proc.exited
  },
  // ptree supervises each command from a subreaper on Linux; desktopMemory
  // leaves those roots out and sums what runs under them.
  memory: pids => (process.platform === 'linux' ? desktopMemory(pids) : null),
  async reap(pid, marker) {
    if (!alive(pid)) return
    // A durable PID is not identity: refuse to kill a reused PID.
    const root = Process.fromPid(pid)
    if (!root) {
      if (alive(pid))
        throw new Error('Orphan group leader missing; resource remains blocked')
      return
    }
    const descendants: Process[] = []
    const pending = [root]
    while (pending.length) {
      const processRef = pending.pop()!
      descendants.push(processRef)
      pending.push(...processRef.children())
    }
    // Linux's ptree subreaper carries the browser under its own root. Match
    // the trusted resource path in that tree before touching a persisted PID.
    if (!descendants.some(ref => ref.args().some(arg => arg.includes(marker))))
      throw new Error('Orphan PID identity could not be verified')
    for (const ref of descendants.reverse()) {
      if (
        !(await ref.terminate({
          group: ref.pid === pid,
          gracefulMs: 1500,
          timeoutMs: 5000,
        }))
      )
        throw new Error('Orphan tree did not exit')
    }
    await confirmExit(pid)
  },
}
interface ResourceState {
  agent: string
  resourceId: string
  resourceEpoch: number
  confirm: DesktopConfirm
  browser: boolean
  computer: boolean
  state: 'off' | 'starting' | 'running' | 'failed'
  reason: string | null
  startedAt: number | null
  lastActionAt: number | null
  cdpUrl: string | null
  display: string | null
  /** Every started process; `app` marks what `open_app` opened. */
  pids: { pid: number; marker: string; app?: true }[]
  apps: DesktopApps
  terminal: boolean
  /** The private desktop's session bus address, when one runs. */
  bus?: string | null
  windowManager?: string | null
  accessibility?: boolean
  /** Whether the private desktop's processes run in bubblewrap. */
  confined?: boolean | null
  /** Why a running unit runs with less than it was asked for. */
  notes?: { browser: string | null; computer: string | null } | null
  memoryBytes?: number | null
}
/** One started process; applications may exit without stopping the desktop. */
interface Managed {
  readonly proc: DesktopProcess
  readonly app: boolean
}
/** How one running resource starts its processes. */
interface Session {
  /** The node-side environment Xvfb, Chromium headless and `systemd-run` get. */
  readonly env: Record<string, string | undefined>
  readonly scope: boolean
  /** Where sandboxed processes may look; null without usable bubblewrap. */
  sandbox: Omit<DesktopSandbox, 'env'> | null
  desktop: {
    readonly home: string
    readonly display: string
    readonly xauthority: string
    bus: string | null
  } | null
}
interface Operation {
  digest: string
  result?: ControlOutcome
}
interface Lease {
  readonly actionId: string
  readonly resource: ResourceState
  readonly epoch: number
  readonly tool: DesktopTool
  readonly call: AuthzCall
  readonly invocationId: string
  readonly taskId: string
  readonly sessionId: string
  readonly argsDigest: string
  readonly active: () => boolean
  expiresAt: number
  confirmed: boolean
  authorizing: boolean
  authorized: boolean
  committed: boolean
  /** The host already listed or opened applications for this call. */
  carried: boolean
  host: string | null
  observedTargetDigest: string | null
  requestId: string | null
  approvalValid: () => boolean
}
interface Options {
  readonly node: string
  readonly agents: readonly string[]
  readonly estop: () => boolean
  readonly audit?: (event: ResidentAuthzEvent) => void
  readonly launcher?: DesktopLauncher
  readonly platform?: NodeJS.Platform
  readonly now?: () => number
  readonly idleMs?: number
  readonly downloadBytes?: number
  readonly tabLimit?: number
  readonly removeData?: (root: string) => void
  readonly invalidated?: (agent: string) => void
  readonly changed?: (agent: string) => Promise<void>
  /** Resident memory cap of one resource (`--desktop-memory-mib`), bytes. */
  readonly memoryBytes?: number
  /** The agent's workspace, mounted into the private desktop. */
  readonly workspace?: (agent: string) => string | undefined
  /** `--allow-workspace-edits`: the workspace is writable there too. */
  readonly workspaceWritable?: boolean
  /** The resident guard's protected roots and memory root, hidden there. */
  readonly protectedRoots?: readonly string[]
  /** Desktop entry directories, highest precedence first (tests). */
  readonly applicationDirs?: readonly string[]
  /** How `desktop.view` scales a screenshot down (tests). */
  readonly screenEncoders?: readonly ScreenEncoder[]
  /** How a browser's DevTools pipe is bridged to its executor (tests). */
  readonly cdpBridge?: CdpBridgeFactory
}
const hash = (input: unknown) =>
  createHash('sha256').update(JSON.stringify(input)).digest('hex')
const GRANTED: DesktopDecision = { ok: true }
const refuse = (reason: string): DesktopDecision => ({ ok: false, reason })
const UNIT = { browser: '专属浏览器', computer: '专属电脑' } as const
/** The two tools whose effect the host carries out itself (§6.2). */
const APPS_TOOL = 'qianmo_computer_apps'
const OPEN_APP_TOOL = 'qianmo_computer_open_app'
const DEFAULT_MEMORY_BYTES = 1536 * 1024 * 1024
/** Applications one private desktop keeps open at a time. */
const APP_LIMIT = 8
const SCREEN_BYTES = 4 * 1024 * 1024
const SCREEN_TYPES: Readonly<Record<string, DesktopScreenView['mimeType']>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
}
const NO_BWRAP =
  '打开应用需要 bubblewrap：本节点没装 bubblewrap，或它建不了用户命名空间（Ubuntu 24.04 等默认 kernel.apparmor_restrict_unprivileged_userns=1 时非特权 bwrap 会被拒），私有桌面没有隔离'
const NOTE_NO_BWRAP = `${NO_BWRAP}；不许打开应用，浏览器保持无头`
/**
 * A bundle id the operator lists for this Mac's own desktop (§6.5); at most
 * {@link HOST_APPS_MAX} of them.
 */
const BUNDLE_ID = /^[A-Za-z0-9][A-Za-z0-9-]*(\.[A-Za-z0-9-]+)+$/
const HOST_APPS_MAX = 20
/** Terminal applications on macOS: a shell on the owner's account. */
const HOST_TERMINALS: ReadonlySet<string> = new Set([
  'com.apple.Terminal',
  'com.googlecode.iterm2',
  'com.mitchellh.ghostty',
  'dev.warp.Warp-Stable',
  'io.alacritty',
  'net.kovidgoyal.kitty',
  'co.zeit.hyper',
  'com.github.wez.wezterm',
])
const NOTE_HEADLESS =
  '需要 bubblewrap 才能在专属电脑的显示上有头运行：浏览器保持无头'
const NOTE_HEADED_FAILED =
  '有头浏览器在 bubblewrap 里没能启动（多半是不许嵌套用户命名空间，Chromium 自身的沙箱起不来）：已退回无头'
const NOTE_NO_BUS = '私有 D-Bus 总线没能启动：无障碍不可用'
const CHROME_LOCKS = ['SingletonLock', 'SingletonSocket', 'SingletonCookie']
function isImage(bytes: Uint8Array, type: DesktopScreenView['mimeType']) {
  const ascii = (from: number, to: number) =>
    String.fromCharCode(...bytes.subarray(from, to))
  return type === 'image/png'
    ? ascii(1, 4) === 'PNG' && bytes[0] === 0x89
    : type === 'image/jpeg'
      ? bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
      : ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP'
}
const stale = (unit: 'browser' | 'computer') =>
  unit === 'browser'
    ? '专属浏览器已重启或回收，资源代次变了：先调用 qianmo_browser_tabs 取当前的标签句柄再重试'
    : '专属电脑已重启或回收，资源代次变了：请重试'
function directoryBytes(dir: string): number {
  let total = 0
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) total += directoryBytes(p)
      else if (e.isFile()) total += fs.statSync(p).size
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
  }
  return total
}
/** Host-owned leases, process lifecycle, durable intent and control idempotency. */
export class NodeDesktop {
  readonly #options: Options
  readonly #launcher: DesktopLauncher
  readonly #states = new Map<string, ResourceState>()
  readonly #processes = new Map<string, Managed[]>()
  readonly #sessions = new Map<string, Session>()
  /** Each running browser's DevTools bridge and its claim secret (§6.3). */
  readonly #bridges = new Map<string, { bridge: CdpBridge; token: string }>()
  /** Why the owner cannot see a resource's screen, until a view succeeds. */
  readonly #viewReasons = new Map<string, string>()
  readonly #leases = new Map<string, Lease>()
  readonly #operations = new Map<string, Operation>()
  readonly #actions: DesktopActionView[] = []
  readonly #orphans: ResourceState[] = []
  readonly #recoveredIntents: DesktopActionView[] = []
  readonly #now: () => number
  readonly #file = qianmoConfigPath('qianmo', 'desktop-ledger.json')
  readonly #ready: Promise<void>
  readonly #memoryLimit: number
  /**
   * The resident guard's path rules. Approvals already apply them, but an
   * `autonomous` call without `confirm` never asks; typed text, clipboard
   * text and every nested string are checked at reserve either way.
   */
  readonly #hardline: ResidentHardline
  #queue: Promise<unknown> = Promise.resolve()
  #timer: Timer
  #closed = false
  #sweeping = false
  // Probed once, on the first start that needs them (§6.3).
  #scope: Promise<boolean> | undefined
  #bwrap: Promise<boolean> | undefined
  #bwrapUsable: boolean | undefined
  constructor(options: Options) {
    if (
      !isValidSegment(options.node) ||
      options.agents.some(agent => !isValidSegment(agent))
    )
      throw new Error('Invalid desktop owner')
    if (
      options.memoryBytes !== undefined &&
      (!Number.isSafeInteger(options.memoryBytes) || options.memoryBytes <= 0)
    )
      throw new Error('Invalid desktop memory limit')
    this.#options = options
    this.#now = options.now ?? Date.now
    this.#launcher = options.launcher ?? desktopLauncher
    this.#memoryLimit = options.memoryBytes ?? DEFAULT_MEMORY_BYTES
    this.#hardline = new ResidentHardline({
      stateRoots: protectedConfigRoots(),
      protectedRoots: [
        ...protectedConfigRoots(),
        ...(options.protectedRoots ?? []),
      ],
    })
    const text = readTextIfExists(this.#file)
    if (text !== undefined) {
      const saved = JSON.parse(text) as {
        states: (Omit<ResourceState, 'apps' | 'terminal'> &
          Partial<Pick<ResourceState, 'apps' | 'terminal'>>)[]
        operations: [string, Operation][]
        actions: DesktopActionView[]
      }
      for (const stored of saved.states) {
        // Ledgers written before §6.3 carry no application policy.
        const state: ResourceState = {
          ...stored,
          apps: stored.apps ?? 'all',
          terminal: stored.terminal ?? false,
        }
        if (options.agents.includes(state.agent))
          this.#states.set(state.agent, state)
        else this.#orphans.push(state)
      }
      for (const [id, op] of saved.operations) this.#operations.set(id, op)
      this.#actions.push(
        ...saved.actions.map(action =>
          action.outcome === 'intent'
            ? (() => {
                const unknown = { ...action, outcome: 'unknown' as const }
                this.#recoveredIntents.push(unknown)
                return unknown
              })()
            : action,
        ),
      )
    }
    for (const agent of options.agents)
      if (!this.#states.has(agent))
        this.#states.set(agent, {
          agent,
          resourceId: randomUUID(),
          resourceEpoch: 1,
          confirm: 'sensitive',
          browser: false,
          computer: false,
          state: 'off',
          reason: null,
          startedAt: null,
          lastActionAt: null,
          cdpUrl: null,
          display: null,
          pids: [],
          apps: 'all',
          terminal: false,
        })
    this.#ready = this.#reap()
    this.#timer = setInterval(() => {
      void this.sweep().catch(() => {})
    }, 2000)
    this.#timer.unref()
  }
  #root(agent: string): string {
    return path.join(path.dirname(this.#file), 'desktop', agent)
  }
  resourcePath(agent: string): string {
    return path.join(
      path.dirname(this.#file),
      'desktop-resources',
      `${agent}.json`,
    )
  }
  resource(agent: string): DesktopResource | undefined {
    const s = this.#states.get(agent)
    if (!s) return undefined
    return {
      resourceId: s.resourceId,
      resourceEpoch: s.resourceEpoch,
      browser: s.browser && s.state === 'running',
      computer: s.computer && s.state === 'running',
      cdpUrl: s.cdpUrl,
      cdpToken: s.cdpUrl ? (this.#bridges.get(agent)?.token ?? null) : null,
      display: s.display,
      xauthority:
        s.computer && !this.#hostDesktop()
          ? path.join(this.#root(agent), 'Xauthority')
          : null,
      downloads: path.join(this.#root(agent), 'downloads'),
      tab: `${s.resourceId}:${s.resourceEpoch}:main`,
      bus: s.computer && s.state === 'running' ? (s.bus ?? null) : null,
      // Only what the agent may use: a terminal the operator listed stays
      // out, or its windows (the owner's shell) would take input (§6.5).
      ...(this.#hostDesktop() && s.computer && Array.isArray(s.apps)
        ? { hostApps: this.#allowed(s).map(app => app.id) }
        : {}),
    }
  }
  /** Cut every executor off the browser; the claim secret dies with it. */
  #closeBridge(agent: string): void {
    this.#bridges.get(agent)?.bridge.close()
    this.#bridges.delete(agent)
  }
  /** Forget what the last session ran with; its processes are gone. */
  #clearSession(s: ResourceState): void {
    s.bus = s.windowManager = s.confined = s.notes = s.memoryBytes = null
    s.accessibility = false
    this.#sessions.delete(s.agent)
  }
  #save(): void {
    writePrivateJson(this.#file, {
      states: [...this.#states.values()],
      operations: [...this.#operations],
      actions: this.#actions,
    })
    for (const agent of this.#states.keys())
      writePrivateJson(this.resourcePath(agent), this.resource(agent))
  }
  async #reap(): Promise<void> {
    for (const s of [...this.#states.values(), ...this.#orphans]) {
      s.resourceEpoch++
      s.browser = s.computer = false
      s.cdpUrl = s.display = null
      this.#clearSession(s)
      try {
        for (const p of s.pids) await this.#launcher.reap(p.pid, p.marker)
        s.pids = []
        s.state = 'off'
        s.reason = null
      } catch {
        s.state = 'failed'
        s.reason = '孤儿进程未能确认退出，拒绝开启'
        if (!this.#states.has(s.agent)) throw new Error(s.reason)
      }
    }
    this.#save()
    for (const row of this.#recoveredIntents)
      this.#options.audit?.({
        kind: 'desktop.action',
        ...(row.taskId ? { taskId: row.taskId } : {}),
        detail: {
          ...row,
          host: row.host ?? '',
          confirmed: row.confirmed ?? false,
        },
      })
  }
  #supported(): boolean {
    return this.#unsupportedReason() === null
  }
  /**
   * Why this node has no computer, in the words the console shows under the
   * disabled switch: the system, or which of Xvfb and xauth is missing.
   */
  #unsupportedReason(): string | null {
    if (this.#hostDesktop()) return null
    if ((this.#options.platform ?? process.platform) !== 'linux')
      return '这个系统不提供电脑 · 需要 Linux 或 macOS 节点'
    const missing = ['Xvfb', 'xauth'].filter(
      program => !this.#launcher.available(program),
    )
    return missing.length === 0
      ? null
      : `节点缺少 ${missing.join(' 和 ')} · 装上后可用`
  }
  /**
   * The computer is this Mac's own desktop, limited to the applications the
   * operator lists (runtimes-channels.md §6.5): no private display, nothing
   * started, nothing of the owner's stopped.
   */
  #hostDesktop(): boolean {
    return (this.#options.platform ?? process.platform) === 'darwin'
  }
  #view(s: ResourceState): DesktopNodeView {
    const recent = this.#actions.filter(
      a => a.agent === s.agent && a.at >= this.#now() - 86400000,
    )
    const platform = this.#options.platform ?? process.platform
    const confined = s.confined ?? this.#bwrapUsable
    return {
      node: this.#options.node,
      agent: s.agent,
      reachable: true,
      platform:
        platform === 'linux' || platform === 'darwin' ? platform : 'other',
      browser: {
        enabled: s.browser,
        state: s.browser ? s.state : s.state === 'failed' ? 'failed' : 'off',
        profileBytes: directoryBytes(path.join(this.#root(s.agent), 'browser')),
        startedAt: s.startedAt,
        reason:
          s.reason ??
          s.notes?.browser ??
          this.#viewReasons.get(s.agent) ??
          null,
      },
      computer: {
        enabled: s.computer,
        supported: this.#supported(),
        state: s.computer ? s.state : s.state === 'failed' ? 'failed' : 'off',
        display: s.display,
        reason:
          this.#unsupportedReason() ??
          s.reason ??
          s.notes?.computer ??
          this.#viewReasons.get(s.agent) ??
          null,
        ...(platform === 'linux'
          ? {
              mode: 'private' as const,
              windowManager: s.windowManager ?? null,
              accessibility: s.accessibility === true,
              ...(confined === undefined ? {} : { confined }),
              memoryBytes: s.memoryBytes ?? null,
              memoryLimitBytes: this.#memoryLimit,
            }
          : platform === 'darwin'
            ? { mode: 'host' as const }
            : {}),
        apps: s.apps,
        terminal: s.terminal,
      },
      confirm: s.confirm,
      lastActionAt: s.lastActionAt,
      actions24h: recent.length,
      confirmed24h: recent.filter(a => a.confirmed).length,
    }
  }
  async #stop(s: ResourceState, recycle: boolean): Promise<void> {
    s.browser = s.computer = false
    s.resourceEpoch++
    let persistenceFailure: unknown
    try {
      this.#options.invalidated?.(s.agent)
    } catch (error) {
      persistenceFailure = error
    }
    s.cdpUrl = s.display = null
    this.#closeBridge(s.agent)
    for (const lease of [...this.#leases.values()]) {
      if (lease.resource !== s) continue
      try {
        this.#finish(lease, lease.committed ? 'unknown' : 'denied')
      } catch (error) {
        persistenceFailure = error
        this.#leases.delete(lease.actionId)
      }
    }
    try {
      this.#save()
    } catch (error) {
      persistenceFailure = error
    }
    // Even a full disk must not prevent process termination. The in-memory
    // epoch and gate are already closed; a failed write never authorizes reuse.
    // Applications first, Xvfb last: the reverse of the order they started.
    const managed = this.#processes.get(s.agent)
    if (managed) for (const m of [...managed].reverse()) await m.proc.stop()
    else
      for (const p of [...s.pids].reverse())
        await this.#launcher.reap(p.pid, p.marker)
    this.#processes.delete(s.agent)
    this.#clearSession(s)
    s.pids = []
    s.state = 'off'
    s.startedAt = null
    s.reason = null
    if (recycle) {
      if (this.#options.removeData)
        this.#options.removeData(this.#root(s.agent))
      else fs.rmSync(this.#root(s.agent), { recursive: true, force: true })
    }
    this.#save()
    await this.#options.changed?.(s.agent)
    if (persistenceFailure !== undefined) throw persistenceFailure
  }
  /** Whether processes get their own capped scope; whether bwrap works. */
  #probe(
    kind: 'scope' | 'bwrap',
    env: Record<string, string | undefined>,
  ): Promise<boolean> {
    const probe = async (program: string, argv: readonly string[]) => {
      try {
        return (
          this.#launcher.available(program) &&
          (await this.#launcher.run(
            program,
            argv,
            kind === 'scope' ? env : { PATH: env.PATH },
          )) === 0
        )
      } catch {
        return false
      }
    }
    if (kind === 'scope')
      return (this.#scope ??= probe('systemd-run', [
        ...desktopScopeArgv(this.#memoryLimit),
        'true',
      ]))
    return (this.#bwrap ??= probe('bwrap', DESKTOP_BWRAP_PROBE).then(
      usable => (this.#bwrapUsable = usable),
    ))
  }
  /** Start one process of a running resource and record it in the table. */
  async #spawn(
    s: ResourceState,
    command: readonly string[],
    marker: string,
    app = false,
    devtools = false,
  ): Promise<DesktopProcess> {
    const session = this.#sessions.get(s.agent)
    if (!session) throw new Error('Desktop session is not running')
    const [program, ...argv] = session.scope
      ? ['systemd-run', ...desktopScopeArgv(this.#memoryLimit), ...command]
      : command
    const proc = await this.#launcher.start(
      program!,
      argv,
      session.env,
      devtools,
    )
    const managed = this.#processes.get(s.agent) ?? []
    this.#processes.set(s.agent, managed)
    managed.push({ proc, app })
    s.pids.push({
      pid: proc.pid,
      marker,
      ...(app ? { app: true as const } : {}),
    })
    this.#save()
    return proc
  }
  /** Stop one process that did not come up, and take it off the table. */
  async #drop(s: ResourceState, proc: DesktopProcess): Promise<void> {
    await proc.stop()
    const managed = this.#processes.get(s.agent) ?? []
    const index = managed.findIndex(m => m.proc === proc)
    if (index >= 0) managed.splice(index, 1)
    s.pids = s.pids.filter(p => p.pid !== proc.pid)
    this.#save()
  }
  /**
   * The command line of one private desktop process. With bubblewrap it is
   * sandboxed (§6.3); without, `env -i` gives it the same environment and a
   * shell that stays its parent keeps the home path in the tree as the
   * orphan sweep's marker.
   */
  #desktopCommand(
    s: ResourceState,
    command: readonly string[],
    proxy = false,
  ): string[] {
    const session = this.#sessions.get(s.agent)
    if (!session?.desktop) throw new Error('Private desktop is not running')
    const env = desktopSandboxEnv({ ...session.desktop, proxy })
    return session.sandbox
      ? ['bwrap', ...desktopSandboxArgv({ ...session.sandbox, env }, command)]
      : [
          '/usr/bin/env',
          '-i',
          ...Object.entries(env).map(([key, value]) => `${key}=${value}`),
          '/bin/sh',
          '-c',
          'shift; "$@"; exit $?',
          'qianmo-desktop',
          session.desktop.home,
          ...command,
        ]
  }
  /** Roots no private desktop process of `agent` may see. */
  #hidden(agent: string): string[] {
    const own = this.#options.workspace?.(agent)
    return [
      nodeHomeDir(),
      qianmoConfigDir(),
      ...protectedConfigRoots(),
      caDir(),
      memoryBaseDir(),
      ...(this.#options.protectedRoots ?? []),
      // The other agents' workspaces: each desktop sees its own only.
      ...[...this.#states.keys()]
        .filter(other => other !== agent)
        .map(other => this.#options.workspace?.(other))
        .filter((dir): dir is string => dir !== undefined && dir !== own),
    ]
  }
  /** Wait for `ready`, giving up early when `proc` has already exited. */
  async #until(
    ready: () => boolean | Promise<boolean>,
    proc: DesktopProcess,
    ms: number,
  ): Promise<boolean> {
    const deadline = Date.now() + ms
    while (Date.now() < deadline && proc.alive()) {
      if (await ready()) return true
      await Bun.sleep(25)
    }
    return false
  }
  /**
   * Start Chrome on a DevTools pipe (§6.3): it listens on no port, and only
   * the host bridge, which lets in the executor that claims it, reaches it.
   * Whether it answered there within `ms`; one that did not is stopped.
   */
  async #browser(
    s: ResourceState,
    command: readonly string[],
    profile: string,
    ms: number,
  ): Promise<boolean> {
    const token = randomBytes(32).toString('base64url')
    const bridge = await (this.#options.cdpBridge ?? createCdpBridge)({
      dir: path.join(this.#root(s.agent), 'cdp'),
      token,
      transport:
        (this.#options.platform ?? process.platform) === 'linux'
          ? 'fifo'
          : 'pair',
    })
    let proc: DesktopProcess
    try {
      proc = await this.#spawn(
        s,
        bridge.command(command),
        profile,
        false,
        bridge.pair,
      )
    } catch (error) {
      bridge.close()
      throw error
    }
    if (bridge.pair) {
      if (proc.devtools) bridge.attach(proc.devtools)
      else {
        bridge.close()
        await this.#drop(s, proc)
        throw new Error('Launcher handed the browser no DevTools pipe')
      }
    }
    if (await bridge.ready(() => proc.alive(), ms)) {
      this.#bridges.set(s.agent, { bridge, token })
      s.cdpUrl = bridge.url
      return true
    }
    bridge.close()
    await this.#drop(s, proc)
    return false
  }
  async #start(
    s: ResourceState,
    browser: boolean,
    computer: boolean,
  ): Promise<void> {
    if (s.pids.length)
      throw new Error('Existing process tree must be stopped first')
    const platform = this.#options.platform ?? process.platform
    if (platform !== 'darwin' && platform !== 'linux')
      throw new Error('Browser unsupported on this platform')
    if (computer && !this.#supported())
      throw new Error('Linux computer requires Xvfb and xauth')
    const root = this.#root(s.agent),
      profile = path.join(root, 'browser'),
      downloads = path.join(root, 'downloads'),
      home = path.join(root, 'home')
    for (const dir of [
      root,
      profile,
      downloads,
      path.join(root, 'screenshots'),
    ])
      ensurePrivateDir(dir)
    s.state = 'starting'
    s.browser = browser
    s.computer = computer
    s.reason = null
    const notes = {
      browser: null as string | null,
      computer: null as string | null,
    }
    s.notes = notes
    const env = { ...process.env }
    for (const key of [
      'DISPLAY',
      'WAYLAND_DISPLAY',
      'XAUTHORITY',
      'DBUS_SESSION_BUS_ADDRESS',
    ])
      delete env[key]
    this.#processes.set(s.agent, [])
    const session: Session = {
      env,
      scope: platform === 'linux' && (await this.#probe('scope', env)),
      sandbox: null,
      desktop: null,
    }
    this.#sessions.set(s.agent, session)
    // On this Mac the computer is its own desktop: nothing to start.
    if (computer && platform === 'linux') {
      const auth = path.join(root, 'Xauthority')
      const displayFile = path.join(root, 'display')
      // xauth writes an independent credential. Xvfb chooses its display
      // atomically using -displayfd; no probe-then-bind display race.
      writePrivateJson(displayFile, null)
      const cookie = randomBytes(16).toString('hex')
      if (
        (await this.#launcher.run(
          'xauth',
          ['-f', auth, 'add', ':0', '.', cookie],
          env,
        )) !== 0
      )
        throw new Error('Xauthority initialization failed')
      const fd = fs.openSync(displayFile, 'w', 0o600)
      fs.closeSync(fd)
      // The trusted shell redirects only the fixed display file; the model
      // cannot choose this command or any process argument.
      await this.#spawn(
        s,
        [
          '/bin/sh',
          '-c',
          'exec Xvfb -displayfd 3 -screen 0 1440x900x24 -nolisten tcp -auth "$1" 3>"$2"',
          'qianmo-xvfb',
          auth,
          displayFile,
        ],
        auth,
      )
      const deadline = Date.now() + 10000
      while (Date.now() < deadline) {
        const display = readTextIfExists(displayFile)?.trim()
        if (display && /^\d+$/.test(display)) {
          s.display = `:${display}`
          break
        }
        await Bun.sleep(25)
      }
      if (!s.display) throw new Error('Xvfb did not allocate a display')
      // Add the cookie for the actual allocated display before the controller starts.
      if (
        (await this.#launcher.run(
          'xauth',
          ['-f', auth, 'add', s.display, '.', cookie],
          env,
        )) !== 0
      )
        throw new Error('Xauthority initialization failed')
      fs.chmodSync(auth, 0o600)
      env.DISPLAY = s.display
      env.XAUTHORITY = auth
      // The private desktop (§6.3): its own home with XDG directories, a
      // session bus with accessibility, a window manager, all in bubblewrap.
      for (const dir of [
        home,
        ...DESKTOP_HOME_DIRS.map(dir => path.join(home, dir)),
      ])
        ensurePrivateDir(dir)
      // ~/Downloads in the private home is the quota-counted directory.
      const saved = path.join(home, 'Downloads')
      try {
        fs.lstatSync(saved)
      } catch {
        fs.symlinkSync(downloads, saved)
      }
      const confined = await this.#probe('bwrap', env)
      s.confined = confined
      // Outside the private home, mounted read-only: nothing in the
      // sandbox can give the window manager a menu back.
      const openbox = path.join(root, 'openbox.xml')
      fs.writeFileSync(openbox, OPENBOX_CONFIG, { mode: 0o600 })
      const workspace = this.#options.workspace?.(s.agent)
      session.sandbox = confined
        ? {
            home,
            writable: [home, downloads, profile],
            readOnly: [auth, openbox],
            hidden: this.#hidden(s.agent),
            ...(workspace === undefined
              ? {}
              : {
                  workspace: {
                    path: workspace,
                    writable: this.#options.workspaceWritable === true,
                  },
                }),
          }
        : null
      const socket = path.join(home, '.run', 'bus')
      session.desktop = {
        home,
        display: s.display,
        xauthority: auth,
        bus: null,
      }
      // A Unix socket path holds at most 107 bytes.
      if (
        confined &&
        this.#launcher.available('dbus-daemon') &&
        Buffer.byteLength(socket) <= 107
      ) {
        fs.rmSync(socket, { force: true })
        const bus = `unix:path=${socket}`
        const daemon = await this.#spawn(
          s,
          this.#desktopCommand(s, [
            'dbus-daemon',
            '--session',
            '--nofork',
            '--nopidfile',
            `--address=${bus}`,
          ]),
          home,
        )
        if (await this.#until(() => fs.existsSync(socket), daemon, 10000)) {
          session.desktop.bus = s.bus = bus
          const launcher = AT_SPI_BUS_LAUNCHERS.find(program =>
            this.#launcher.available(program),
          )
          if (launcher) {
            await this.#spawn(
              s,
              this.#desktopCommand(s, [launcher, '--launch-immediately']),
              home,
            )
            s.accessibility = true
          }
        } else {
          await this.#drop(s, daemon)
          notes.computer = NOTE_NO_BUS
        }
      }
      // A window manager only in the sandbox. Without one nothing opens on
      // this display (apps are refused, Chromium stays headless), and an
      // unconfined window manager would be a process outside it.
      const manager = confined
        ? DESKTOP_WINDOW_MANAGERS.find(program =>
            this.#launcher.available(program),
          )
        : undefined
      if (manager) {
        const command =
          manager === 'openbox'
            ? ['openbox', '--config-file', openbox]
            : [manager]
        await this.#spawn(s, this.#desktopCommand(s, command), home)
        s.windowManager = manager
      }
      if (!confined) notes.computer = NOTE_NO_BWRAP
    }
    if (browser) {
      const chrome =
        platform === 'darwin'
          ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
          : (Bun.which('google-chrome') ?? Bun.which('chromium') ?? 'chromium')
      if (!this.#launcher.available(chrome))
        throw new Error('Chrome/Chromium unavailable')
      const prefs = path.join(profile, 'Default', 'Preferences')
      const previous = readTextIfExists(prefs)
      const existing = previous
        ? (JSON.parse(previous) as Record<string, unknown>)
        : {}
      writePrivateJson(prefs, {
        ...existing,
        download: { default_directory: downloads, prompt_for_download: false },
      })
      // Only this resource's Chrome uses the profile, and none runs now. A
      // lock left by one in a pid namespace names a pid that means nothing here.
      const clear = () => {
        for (const name of ['DevToolsActivePort', ...CHROME_LOCKS])
          fs.rmSync(path.join(profile, name), { force: true })
      }
      const flags = [
        `--user-data-dir=${profile}`,
        '--remote-debugging-pipe',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-sync',
        '--window-size=1440,900',
      ]
      if (computer && session.sandbox) {
        // Headed on the private display, Chromium's own sandbox kept.
        clear()
        const headed = await this.#browser(
          s,
          this.#desktopCommand(
            s,
            [
              chrome,
              ...flags,
              '--window-position=0,0',
              '--password-store=basic',
              'about:blank',
            ],
            true,
          ),
          profile,
          10000,
        )
        if (!headed) notes.browser = NOTE_HEADED_FAILED
      } else if (computer && platform === 'linux') notes.browser = NOTE_HEADLESS
      if (!s.cdpUrl) {
        clear()
        if (
          !(await this.#browser(
            s,
            [chrome, '--headless=new', ...flags, 'about:blank'],
            profile,
            15000,
          ))
        )
          throw new Error('Chrome CDP did not become ready')
      }
    }
    s.state = 'running'
    s.startedAt = this.#now()
    s.lastActionAt = this.#now()
    this.#save()
    await this.#options.changed?.(s.agent)
  }
  readonly control: ControlHandler = async (op, args, ctx) => {
    await this.#ready
    const run = async (): Promise<ControlOutcome> => {
      const agent = args.agent
      if (op === 'desktop.status' && Object.keys(args).length > 0)
        return { ok: false, code: 'invalid', message: 'Invalid status query' }
      if (op === 'desktop.status')
        return {
          ok: true,
          value: [...this.#states.values()].map(s => this.#view(s)),
        }
      if (op === 'desktop.actions') {
        if (Object.keys(args).some(k => !['agent', 'limit'].includes(k)))
          return { ok: false, code: 'invalid', message: 'Invalid action query' }
        const limit = args.limit ?? 50
        if (
          !Number.isSafeInteger(limit) ||
          Number(limit) < 1 ||
          Number(limit) > 200 ||
          (agent !== undefined && !this.#states.has(String(agent)))
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
      if (op === 'desktop.view') {
        // Refusals here say why in words: the hub reads the generic
        // `Invalid desktop operation` as "this node predates desktop.view".
        const s =
          typeof agent === 'string' ? this.#states.get(agent) : undefined
        if (Object.keys(args).some(key => key !== 'agent'))
          return {
            ok: false,
            code: 'rejected',
            message: '查看画面只接受 agent 一个参数',
          }
        if (!s)
          return {
            ok: false,
            code: 'rejected',
            message: `节点没有为智能体 ${String(agent)} 配置云端电脑资源`,
          }
        if (s.state !== 'running' || (!s.computer && !s.browser))
          return {
            ok: false,
            code: 'rejected',
            message: '专属电脑和专属浏览器都没有开启：没有正在进行的画面可看',
          }
        return await this.#screen(s, ctx.resultFits)
      }
      if (
        !['desktop.enable', 'desktop.disable', 'desktop.recycle'].includes(
          op,
        ) ||
        typeof agent !== 'string' ||
        !this.#states.has(agent) ||
        typeof args.operationId !== 'string' ||
        !/^[A-Za-z0-9._:-]{1,200}$/.test(args.operationId) ||
        Object.keys(args).some(
          key =>
            ![
              'agent',
              'operationId',
              'browser',
              'computer',
              'confirm',
              'apps',
              'terminal',
            ].includes(key),
        )
      )
        return {
          ok: false,
          code: 'invalid',
          message: 'Invalid desktop operation',
        }
      if (
        ['browser', 'computer'].some(
          k => args[k] !== undefined && typeof args[k] !== 'boolean',
        ) ||
        (args.confirm !== undefined &&
          args.confirm !== 'always' &&
          args.confirm !== 'sensitive' &&
          args.confirm !== 'autonomous') ||
        (args.apps !== undefined && !isDesktopAppsPolicy(args.apps)) ||
        (args.terminal !== undefined && typeof args.terminal !== 'boolean')
      )
        return { ok: false, code: 'invalid', message: 'Invalid desktop change' }
      if (
        op === 'desktop.disable' &&
        (args.browser === true ||
          args.computer === true ||
          args.confirm !== undefined ||
          args.apps !== undefined ||
          args.terminal !== undefined)
      )
        return {
          ok: false,
          code: 'invalid',
          message: 'Disable only accepts false unit flags',
        }
      if (
        op === 'desktop.recycle' &&
        (args.browser !== undefined ||
          args.computer !== undefined ||
          args.confirm !== undefined ||
          args.apps !== undefined ||
          args.terminal !== undefined)
      )
        return {
          ok: false,
          code: 'invalid',
          message: 'Recycle only accepts agent and operationId',
        }
      // This Mac's own desktop opens only what the operator names (§6.5).
      if (op === 'desktop.enable' && this.#hostDesktop()) {
        const current = this.#states.get(agent)!
        const computer =
          typeof args.computer === 'boolean' ? args.computer : current.computer
        const apps = args.apps === undefined ? current.apps : args.apps
        if (
          computer &&
          !(
            Array.isArray(apps) &&
            apps.length > 0 &&
            new Set(apps).size <= HOST_APPS_MAX &&
            apps.every(id => typeof id === 'string' && BUNDLE_ID.test(id))
          )
        )
          return {
            ok: false,
            code: 'rejected',
            message: `macOS 本机桌面要列出允许的应用：1–${HOST_APPS_MAX} 个 bundle id（如 com.apple.TextEdit），不接受 all`,
          }
        // A terminal here is a shell on the owner's account, with nothing
        // around it: not offered at all.
        const terminal =
          typeof args.terminal === 'boolean' ? args.terminal : current.terminal
        if (computer && terminal)
          return {
            ok: false,
            code: 'rejected',
            message:
              'macOS 本机桌面不提供终端类应用：这里的终端就是主人账号的 shell，没有隔离',
          }
      }
      const id = args.operationId,
        digest = hash({ op, args, actor: ctx.actor, peer: ctx.peer })
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
      if (this.#closed || (this.#options.estop() && op === 'desktop.enable'))
        return { ok: false, code: 'rejected', message: 'Desktop stopped' }
      this.#operations.set(id, { digest })
      this.#save()
      const s = this.#states.get(agent)!
      let result: ControlOutcome
      try {
        if (op === 'desktop.enable') {
          const browser =
            typeof args.browser === 'boolean' ? args.browser : s.browser
          const computer =
            typeof args.computer === 'boolean' ? args.computer : s.computer
          const apps: DesktopApps = Array.isArray(args.apps)
            ? [...new Set(args.apps as string[])]
            : ((args.apps as DesktopApps | undefined) ?? s.apps)
          const terminal =
            typeof args.terminal === 'boolean' ? args.terminal : s.terminal
          // The application policy is part of the confirmation policy: a
          // running session must not keep opening what it no longer may.
          const policyChanged =
            (args.confirm !== undefined && args.confirm !== s.confirm) ||
            JSON.stringify(apps) !== JSON.stringify(s.apps) ||
            terminal !== s.terminal
          if (args.confirm) s.confirm = args.confirm as DesktopConfirm
          s.apps = apps
          s.terminal = terminal
          if (
            policyChanged ||
            s.browser !== browser ||
            s.computer !== computer ||
            s.state === 'failed'
          ) {
            await this.#stop(s, false)
            if (browser || computer) await this.#start(s, browser, computer)
          }
        } else {
          const partial =
            op === 'desktop.disable' &&
            (args.browser === false || args.computer === false) &&
            !this.#options.estop()
          const browser = partial && args.browser !== false && s.browser
          const computer = partial && args.computer !== false && s.computer
          await this.#stop(s, op === 'desktop.recycle')
          if (browser || computer) await this.#start(s, browser, computer)
        }
        result = { ok: true, value: this.#view(s) }
      } catch {
        try {
          await this.#stop(s, false)
        } catch {
          /* Retain failed PID evidence. */
        }
        s.state = 'failed'
        s.browser = s.computer = false
        s.reason = '资源操作失败，进程退出或删除结果需检查'
        result = { ok: false, code: 'internal', message: s.reason }
      }
      this.#operations.set(id, { digest, result })
      this.#save()
      return result
    }
    const result = this.#queue.then(run)
    this.#queue = result.catch(() => {})
    return result
  }
  /**
   * The newest screenshot the executor saved for this resource (§6.6): a
   * regular PNG, JPEG or WebP file of at most 4 MiB whose bytes match its
   * name. A control reply is bounded by the protocol envelope, so a picture
   * larger than {@link SCREEN_VIEW_BASE64} is scaled down to JPEG; a node
   * with no way to do that answers null and says so in the status.
   */
  async #screen(
    s: ResourceState,
    fits?: (outcome: ControlOutcome) => boolean,
  ): Promise<ControlOutcome> {
    const dir = path.join(this.#root(s.agent), 'screenshots')
    let entries: fs.Dirent[] = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const shots = entries
      .flatMap(entry => {
        const mimeType = SCREEN_TYPES[path.extname(entry.name).toLowerCase()]
        if (!entry.isFile() || !mimeType) return []
        const file = path.join(dir, entry.name)
        try {
          const stat = fs.lstatSync(file)
          return stat.isFile() && stat.size > 0 && stat.size <= SCREEN_BYTES
            ? [{ file, mimeType, at: Math.floor(stat.mtimeMs) }]
            : []
        } catch {
          return []
        }
      })
      .sort((a, b) => b.at - a.at)
    const reply = (value: DesktopScreenView | null): ControlOutcome => ({
      ok: true,
      value,
    })
    const sendable = (view: DesktopScreenView) =>
      view.data.length <= SCREEN_VIEW_BASE64 && (fits?.(reply(view)) ?? true)
    for (const shot of shots) {
      let bytes: Buffer
      try {
        bytes = fs.readFileSync(shot.file)
      } catch {
        continue
      }
      if (bytes.length > SCREEN_BYTES || !isImage(bytes, shot.mimeType))
        continue
      const view: DesktopScreenView = {
        at: shot.at,
        mimeType: shot.mimeType,
        data: bytes.toString('base64'),
      }
      if (sendable(view)) {
        this.#viewReasons.delete(s.agent)
        return reply(view)
      }
      const smaller = await shrinkScreenshot(
        { file: shot.file, bytes, at: shot.at },
        sendable,
        this.#options.screenEncoders,
      )
      if (smaller === undefined) {
        this.#viewReasons.set(
          s.agent,
          '节点缺少图像压缩能力：截图超过控制回执上限，看不到画面（需要 Bun 的图像编码或 ImageMagick）',
        )
        return reply(null)
      }
      if (smaller === null)
        return {
          ok: false,
          code: 'rejected',
          message: '最新一张截图压缩到最小仍超过控制回执上限',
        }
      this.#viewReasons.delete(s.agent)
      return reply(smaller)
    }
    return reply(null)
  }
  #finish(lease: Lease, outcome: DesktopActionView['outcome']): void {
    const row: DesktopActionView = {
      at: this.#now(),
      node: this.#options.node,
      agent: lease.resource.agent,
      unit: lease.tool.startsWith('qianmo_browser_') ? 'browser' : 'computer',
      op: desktopOp(lease.tool),
      host: lease.host,
      outcome,
      actionId: lease.actionId,
      taskId: lease.taskId,
      invocationId: lease.invocationId,
      resourceId: lease.resource.resourceId,
      resourceEpoch: lease.epoch,
      digest: lease.argsDigest,
      ...(lease.requestId ? { requestId: lease.requestId } : {}),
      confirmed: lease.confirmed,
    }
    const index = this.#actions.findIndex(a => a.actionId === lease.actionId)
    if (index < 0) this.#actions.push(row)
    else this.#actions[index] = row
    if (outcome !== 'intent') this.#leases.delete(lease.actionId)
    lease.resource.lastActionAt = row.at
    this.#save()
    this.#options.audit?.({
      kind: 'desktop.action',
      taskId: lease.taskId,
      detail: {
        ...row,
        host: row.host ?? '',
        confirmed: row.confirmed ?? false,
      },
    })
  }
  /** The yes/no view of {@link decide}, for callers that need no reason. */
  async gate(...params: Parameters<NodeDesktop['decide']>): Promise<boolean> {
    return (await this.decide(...params)).ok
  }
  /**
   * Answer one gate phase. All attribution is supplied by the actual active
   * RPC turn, never the model. A refusal says why in words the model and the
   * operator can act on; it never echoes argument text.
   */
  async decide(
    agent: string,
    sessionId: string,
    taskId: string,
    contextId: string,
    raw: unknown,
    active: () => boolean,
    approve: (
      call: AuthzCall,
      beforeConsume: (
        expiresAt?: number,
        requestId?: string,
        valid?: () => boolean,
      ) => boolean,
    ) => Promise<boolean>,
  ): Promise<DesktopDecision> {
    await this.#ready
    const malformed = refuse('租约请求格式不合法')
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return malformed
    const call = raw as { toolName?: unknown; input?: unknown }
    if (
      !isDesktopTool(String(call.toolName)) ||
      !call.input ||
      typeof call.input !== 'object' ||
      Array.isArray(call.input)
    )
      return malformed
    const tool = call.toolName as DesktopTool,
      input = call.input as Record<string, unknown>
    // `apps` and `launch` (the host lists or opens applications itself) carry
    // the same binding as the other phases; no phase takes any other key.
    if (
      Object.keys(input).some(
        k =>
          ![
            'phase',
            'invocationId',
            'resourceId',
            'resourceEpoch',
            'args',
            'canonicalArgsDigest',
            'host',
            'observedTargetDigest',
          ].includes(k),
      )
    )
      return malformed
    if (!isDesktopInvocationId(input.invocationId))
      return refuse('工具调用编号不可用：需要 1–512 个可见 ASCII 字符')
    if (input.phase === 'refused') {
      const state = this.#states.get(agent)
      if (
        !state ||
        typeof input.canonicalArgsDigest !== 'string' ||
        !/^[a-f0-9]{64}$/.test(input.canonicalArgsDigest)
      )
        return malformed
      const row: DesktopActionView = {
        at: this.#now(),
        node: this.#options.node,
        agent,
        unit: tool.startsWith('qianmo_browser_') ? 'browser' : 'computer',
        op: desktopOp(tool),
        host: null,
        outcome: 'denied',
        actionId: randomUUID(),
        taskId,
        invocationId: input.invocationId,
        resourceId: state.resourceId,
        resourceEpoch: state.resourceEpoch,
        digest: input.canonicalArgsDigest,
        confirmed: false,
      }
      this.#actions.push(row)
      this.#save()
      this.#options.audit?.({
        kind: 'desktop.action',
        taskId,
        detail: { ...row, host: '', confirmed: false },
      })
      return GRANTED
    }
    let args: DesktopArgs
    try {
      args = desktopArgs(tool, input.args)
    } catch {
      return refuse('参数不合法')
    }
    const s = this.#states.get(agent),
      unit = tool.startsWith('qianmo_browser_') ? 'browser' : 'computer'
    if (!s) return refuse(`节点没有为智能体 ${agent} 配置云端电脑资源`)
    if (s.state !== 'running' || !s[unit]) return refuse(this.#off(s, unit))
    if (
      s.resourceId !== input.resourceId ||
      s.resourceEpoch !== input.resourceEpoch ||
      ('tab' in args && args.tab !== this.resource(agent)?.tab)
    )
      return refuse(stale(unit))
    if (input.canonicalArgsDigest !== hash(args))
      return refuse('参数摘要与参数不一致')
    const invocationId = input.invocationId
    let lease = [...this.#leases.values()].find(
      l => l.sessionId === sessionId && l.invocationId === invocationId,
    )
    if (input.phase === 'reserve') {
      await this.#queue
      if (s.state !== 'running') return refuse(this.#off(s, unit))
      if (s.resourceEpoch !== input.resourceEpoch) return refuse(stale(unit))
      if (this.#closed) return refuse('节点正在停止，不再发放租约')
      if (this.#options.estop())
        return refuse(
          '急停已开启：解除急停之前，专属浏览器和专属电脑都不发放租约',
        )
      if (!active())
        return refuse(
          '发起这次调用的任务已经结束、超时，或已不是这个会话的当前回合',
        )
      if (lease) return refuse('这次调用已经持有租约')
      if (this.#hardline.verdict(tool, args) !== null)
        return refuse(
          '参数里出现了节点受保护的路径（身份、凭据、配置、审计或记忆目录）：这次调用不执行',
        )
      if (
        this.#hostCarried(tool) &&
        s.confined !== true &&
        !this.#hostDesktop()
      )
        return refuse(NO_BWRAP)
      // Refuse before anyone is asked to approve an app that cannot open.
      if (
        String(tool) === OPEN_APP_TOOL &&
        !this.#allowed(s).some(app => app.id === args.app)
      )
        return refuse(
          !s.terminal &&
            this.#catalog(s).some(app => app.id === args.app && app.terminal)
            ? '这台专属电脑没有开放终端类应用：请在控制台「云端电脑」页为它打开「终端」后再试'
            : '这个应用不在这台专属电脑允许打开的列表里：先调用 qianmo_computer_apps 取编号',
        )
      const holder = [...this.#leases.values()].find(l => l.resource === s)
      if (holder)
        return refuse(
          `这台${UNIT[unit]}上一项操作（${desktopOp(holder.tool)}）还没结束：同一时间只发放一个租约，请等它结束后再试`,
        )
      if (
        this.#actions.some(
          a => a.invocationId === invocationId && a.taskId === taskId,
        )
      )
        return refuse(
          '这次调用已经执行过或被拒绝过，不会重复执行；需要再做请发起新的调用',
        )
      lease = {
        actionId: randomUUID(),
        resource: s,
        epoch: s.resourceEpoch,
        tool,
        invocationId,
        taskId,
        sessionId,
        argsDigest: hash(args),
        active,
        expiresAt: this.#now() + 60000,
        confirmed: false,
        authorizing: false,
        authorized: false,
        committed: false,
        carried: false,
        host: null,
        observedTargetDigest: null,
        requestId: null,
        approvalValid: () => false,
        call: {
          agent,
          contextId,
          toolName: tool,
          input: {
            node: this.#options.node,
            agent,
            contextId,
            taskId,
            invocationId,
            resourceId: s.resourceId,
            resourceEpoch: s.resourceEpoch,
            op: desktopOp(tool),
            canonicalArgsDigest: hash(args),
            args,
          },
        },
      }
      this.#leases.set(lease.actionId, lease)
      return GRANTED
    }
    if (
      !lease ||
      lease.tool !== tool ||
      lease.taskId !== taskId ||
      lease.argsDigest !== hash(args)
    )
      return refuse('没有与这次调用对应的租约')
    const valid = () =>
      active() &&
      !this.#closed &&
      !this.#options.estop() &&
      s.resourceEpoch === lease!.epoch &&
      s.state === 'running' &&
      this.#now() < lease!.expiresAt &&
      this.#leases.has(lease!.actionId) &&
      (!lease!.confirmed || lease!.approvalValid())
    const lapsed = refuse(
      '租约已失效：超时、急停、任务结束、资源重启或批准被撤销',
    )
    if (
      input.phase === 'completed' ||
      input.phase === 'unknown' ||
      input.phase === 'failed'
    ) {
      const completed =
        input.phase === 'completed' && lease.committed && valid()
      this.#finish(
        lease,
        completed
          ? lease.confirmed
            ? 'confirmed'
            : 'allowed'
          : lease.committed
            ? 'unknown'
            : 'failed',
      )
      return completed ? GRANTED : lapsed
    }
    if (!valid()) {
      this.#finish(lease, lease.committed ? 'unknown' : 'denied')
      return lapsed
    }
    if (input.phase === 'authorize') {
      if (
        lease.authorized ||
        lease.authorizing ||
        typeof input.observedTargetDigest !== 'string' ||
        !/^[a-f0-9]{64}$/.test(input.observedTargetDigest)
      )
        return refuse('这次调用已经在审批或已经批准')
      lease.authorizing = true
      lease.observedTargetDigest = input.observedTargetDigest
      if (
        typeof input.host === 'string' &&
        /^[a-zA-Z0-9.:[\]-]{1,253}$/.test(input.host)
      )
        lease.host = input.host
      const bound = {
        ...lease.call,
        input: {
          ...lease.call.input,
          observedTargetDigest: lease.observedTargetDigest,
          targetHost: lease.host,
        },
      }
      // On top of the shared rule the host always asks before a terminal
      // opens: in the private desktop it is a shell (§6.4).
      const needs =
        desktopNeedsApproval(tool, args, s.confirm) ||
        (String(tool) === OPEN_APP_TOOL &&
          this.#catalog(s).some(app => app.id === args.app && app.terminal))
      const beforeConsume = (
        expiresAt?: number,
        requestId?: string,
        validApproval?: () => boolean,
      ) => {
        lease!.requestId = requestId ?? null
        lease!.approvalValid = validApproval ?? (() => false)
        if (expiresAt !== undefined)
          lease!.expiresAt = Math.min(lease!.expiresAt, expiresAt)
        if (!valid()) return false
        this.#finish(lease!, 'intent')
        return true
      }
      const approved = needs
        ? await approve(bound, beforeConsume)
        : beforeConsume()
      lease.confirmed = needs
      if (!approved || !valid()) {
        this.#finish(lease, 'denied')
        return refuse('操作员没有批准，或批准到达时租约已失效')
      }
      lease.authorized = true
      return GRANTED
    }
    if (input.phase === 'commit') {
      if (
        !lease.authorized ||
        lease.committed ||
        lease.observedTargetDigest !== input.observedTargetDigest
      )
        return refuse('提交与批准时观察到的目标不一致，或已经提交过')
      lease.committed = true
      this.#finish(lease, 'intent')
      return GRANTED
    }
    if (input.phase === 'apps' || input.phase === 'launch') {
      if (String(tool) !== (input.phase === 'apps' ? APPS_TOOL : OPEN_APP_TOOL))
        return malformed
      if (!lease.committed || lease.carried)
        return refuse(
          '宿主只在这次调用经过审批并提交之后执行一次：不能提前，也不能重复',
        )
      lease.carried = true
      if (s.confined !== true && !this.#hostDesktop()) return refuse(NO_BWRAP)
      if (input.phase === 'apps')
        return {
          ok: true,
          value: JSON.stringify(
            this.#allowed(s).map(({ id, name, terminal }) => ({
              id,
              name,
              terminal,
            })),
          ),
        }
      return await this.#launch(s, lease, args.app, valid)
    }
    return malformed
  }
  #hostCarried(tool: DesktopTool): boolean {
    const name: string = tool
    return name === APPS_TOOL || name === OPEN_APP_TOOL
  }
  /** Every application installed on this node that it can start. */
  #catalog(s: ResourceState): DesktopApp[] {
    // This Mac: exactly the bundle ids the operator listed. `open -g` starts
    // or reaches one without bringing it to the front.
    if (this.#hostDesktop())
      return (Array.isArray(s.apps) ? s.apps : []).map(id => ({
        id,
        name: id.split('.').at(-1) ?? id,
        terminal: HOST_TERMINALS.has(id),
        argv: ['open', '-g', '-b', id],
      }))
    return desktopApplications(
      this.#options.applicationDirs ?? DESKTOP_APPLICATION_DIRS,
      program => this.#launcher.available(program),
    )
  }
  /** What this agent's policy lets it open. */
  #allowed(s: ResourceState): DesktopApp[] {
    return allowedDesktopApps(this.#catalog(s), s.apps, s.terminal)
  }
  /**
   * Open one allowed application in the sandbox, after the lease committed.
   * Serialized with disable, recycle and the sweep, so a process is never
   * added to a table that is being emptied.
   */
  #launch(
    s: ResourceState,
    lease: Lease,
    id: unknown,
    valid: () => boolean,
  ): Promise<DesktopDecision> {
    const run = async (): Promise<DesktopDecision> => {
      if (!valid())
        return refuse('租约已失效：超时、急停、任务结束、资源重启或批准被撤销')
      const app = this.#allowed(s).find(entry => entry.id === id)
      if (!app)
        return refuse(
          '这个应用不在这台专属电脑允许打开的列表里：先调用 qianmo_computer_apps 取编号',
        )
      if (app.terminal && !lease.confirmed)
        return refuse('打开终端类应用总要经过操作员批准')
      if (this.#hostDesktop()) {
        // The owner's application: opened, never tracked or stopped by us.
        const [program, ...argv] = app.argv
        return (await this.#launcher.run(program!, argv, process.env)) === 0
          ? { ok: true, value: JSON.stringify({ app: app.id }) }
          : refuse('应用没能打开：这台 Mac 上可能没装它')
      }
      const open = (this.#processes.get(s.agent) ?? []).filter(
        m => m.app && m.proc.alive(),
      ).length
      if (open >= APP_LIMIT)
        return refuse(
          `这台专属电脑已经开着 ${APP_LIMIT} 个应用：先在桌面上关掉一些再开`,
        )
      const session = this.#sessions.get(s.agent)
      if (!session?.sandbox || !session.desktop) return refuse(NO_BWRAP)
      try {
        const [program, ...argv] = app.argv
        const proc = await this.#spawn(
          s,
          this.#desktopCommand(s, [Bun.which(program!) ?? program!, ...argv]),
          session.desktop.home,
          true,
        )
        return {
          ok: true,
          value: JSON.stringify({ app: app.id, pid: proc.pid }),
        }
      } catch {
        return refuse('应用没能启动')
      }
    }
    const result = this.#queue.then(run)
    this.#queue = result.catch(() => {})
    return result
  }
  /** Why a unit that is not running cannot be leased, and how to open it. */
  #off(s: ResourceState, unit: 'browser' | 'computer'): string {
    const label = UNIT[unit]
    if (unit === 'computer' && !this.#supported())
      return `${label}需要 Linux 节点（装有 Xvfb 与 xauth）或 macOS 节点，本节点不支持；只能开专属浏览器`
    if (s.state === 'starting') return `${label}正在启动，请稍后重试`
    if (s.state === 'failed')
      return `${label}处于故障状态（${s.reason ?? '原因未记录'}）：请在控制台「云端电脑」页停用后重新打开`
    return `${label}没有开启${s.reason ? `（${s.reason}）` : ''}：请在控制台「云端电脑」页为 ${s.agent} 打开${label}后重试`
  }
  async sweep(): Promise<void> {
    await this.#ready
    if (this.#closed || this.#sweeping) return
    this.#sweeping = true
    const swept = this.#queue.then(() => this.#sweepResources())
    this.#queue = swept.catch(() => {})
    try {
      await swept
    } finally {
      this.#sweeping = false
    }
  }
  async #sweepResources(): Promise<void> {
    if (this.#closed) return
    for (const lease of [...this.#leases.values()])
      if (this.#now() >= lease.expiresAt || !lease.active())
        this.#finish(lease, lease.committed ? 'unknown' : 'denied')
    for (const s of this.#states.values())
      if (s.state === 'running') {
        let reason: string | undefined
        const managed = this.#processes.get(s.agent) ?? []
        // An application the agent closed is gone, not a broken desktop.
        const closed = managed.filter(m => m.app && !m.proc.alive())
        if (closed.length) {
          this.#processes.set(
            s.agent,
            managed.filter(m => !closed.includes(m)),
          )
          s.pids = s.pids.filter(p => !closed.some(m => m.proc.pid === p.pid))
          this.#save()
        }
        if (managed.some(m => !m.app && !m.proc.alive()))
          reason = '资源进程已退出，已停用'
        if (
          this.#now() - (s.lastActionAt ?? s.startedAt ?? 0) >
            (this.#options.idleMs ?? 15 * 60000) &&
          ![...this.#leases.values()].some(l => l.resource === s)
        )
          reason = '空闲超时，已停用'
        if (
          directoryBytes(path.join(this.#root(s.agent), 'downloads')) >
          (this.#options.downloadBytes ?? 100 * 1024 * 1024)
        )
          reason = '下载配额超限，已停用'
        if (s.cdpUrl) {
          try {
            const bridge = this.#bridges.get(s.agent)?.bridge
            if (!bridge) throw new Error('DevTools bridge missing')
            if ((await bridge.pages(2000)) > (this.#options.tabLimit ?? 4))
              reason = 'tab 配额超限，已停用'
          } catch {
            reason = '浏览器失联，已停用'
          }
        }
        // Summed over every process tree of the resource, scopes or not.
        if ((this.#options.platform ?? process.platform) === 'linux') {
          s.memoryBytes =
            this.#launcher.memory?.(s.pids.map(p => p.pid)) ?? null
          if (s.memoryBytes !== null && s.memoryBytes > this.#memoryLimit)
            reason = '内存超过上限，已停用'
        }
        if (reason || this.#options.estop()) {
          try {
            await this.#stop(s, false)
          } catch {
            s.state = 'failed'
            reason = '看护停用失败，退出状态需检查'
          }
          s.reason = reason ?? '急停，已停用'
          this.#save()
        }
      }
  }
  #closing: Promise<void> | undefined
  close(): Promise<void> {
    return (this.#closing ??= this.#close())
  }
  async #close(): Promise<void> {
    this.#closed = true
    clearInterval(this.#timer)
    await this.#ready
    await this.#queue
    for (const s of this.#states.values()) await this.#stop(s, false)
  }
}
