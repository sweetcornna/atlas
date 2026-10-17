// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as fs from 'node:fs'
import * as path from 'node:path'
import { createHash, randomUUID, randomBytes } from 'node:crypto'
import { ptree } from '@oh-my-pi/pi-utils'
import { Process } from '@oh-my-pi/pi-natives'
import { qianmoConfigPath } from '@qianmo/paths'
import type {
  DesktopNodeView,
  DesktopActionView,
  DesktopConfirm,
} from '@qianmo/console'
import {
  desktopArgs,
  desktopNeedsApproval,
  desktopOp,
  isDesktopInvocationId,
  isDesktopTool,
  type DesktopDecision,
  type DesktopResource,
  type DesktopTool,
} from '@qianmo/extension/desktopPolicy'
import type { AuthzCall } from '@qianmo/resident'
import { isValidSegment, type ControlOutcome } from '@qianmo/protocol'
import type { ControlHandler } from './control.js'
import type { ResidentAuthzEvent } from './residentAuthorization.js'
import {
  ensurePrivateDir,
  readTextIfExists,
  writePrivateJson,
} from '../providers/store.js'

export interface DesktopProcess {
  readonly pid: number
  alive(): boolean
  stop(): Promise<void>
}
export interface DesktopLauncher {
  available(program: string): boolean
  start(
    program: string,
    argv: readonly string[],
    env: Record<string, string | undefined>,
  ): Promise<DesktopProcess>
  run(
    program: string,
    argv: readonly string[],
    env: Record<string, string | undefined>,
  ): Promise<number>
  reap(pid: number, marker: string): Promise<void>
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
  async start(program, argv, env) {
    const child = ptree
      .spawn([program, ...argv], { detached: true, subreaper: true, env })
      .nothrow()
    // Drain both pipes through the shared supervisor; no child output is logged.
    const closed = child.wait({ allowNonZero: true, allowAbort: true })
    void closed.catch(() => {})
    return {
      pid: child.pid,
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
    const proc = Bun.spawn([program, ...argv], {
      env,
      stdout: 'ignore',
      stderr: 'ignore',
    })
    return await proc.exited
  },
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
  pids: { pid: number; marker: string }[]
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
}
const hash = (input: unknown) =>
  createHash('sha256').update(JSON.stringify(input)).digest('hex')
const GRANTED: DesktopDecision = { ok: true }
const refuse = (reason: string): DesktopDecision => ({ ok: false, reason })
const UNIT = { browser: '专属浏览器', computer: '专属电脑' } as const
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
  readonly #processes = new Map<string, DesktopProcess[]>()
  readonly #leases = new Map<string, Lease>()
  readonly #operations = new Map<string, Operation>()
  readonly #actions: DesktopActionView[] = []
  readonly #orphans: ResourceState[] = []
  readonly #recoveredIntents: DesktopActionView[] = []
  readonly #now: () => number
  readonly #file = qianmoConfigPath('qianmo', 'desktop-ledger.json')
  readonly #ready: Promise<void>
  #queue: Promise<unknown> = Promise.resolve()
  #timer: Timer
  #closed = false
  #sweeping = false
  constructor(options: Options) {
    if (
      !isValidSegment(options.node) ||
      options.agents.some(agent => !isValidSegment(agent))
    )
      throw new Error('Invalid desktop owner')
    this.#options = options
    this.#now = options.now ?? Date.now
    this.#launcher = options.launcher ?? desktopLauncher
    const text = readTextIfExists(this.#file)
    if (text !== undefined) {
      const saved = JSON.parse(text) as {
        states: ResourceState[]
        operations: [string, Operation][]
        actions: DesktopActionView[]
      }
      for (const state of saved.states) {
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
      display: s.display,
      xauthority: s.computer
        ? path.join(this.#root(agent), 'Xauthority')
        : null,
      downloads: path.join(this.#root(agent), 'downloads'),
      tab: `${s.resourceId}:${s.resourceEpoch}:main`,
    }
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
    return (
      (this.#options.platform ?? process.platform) === 'linux' &&
      this.#launcher.available('Xvfb') &&
      this.#launcher.available('xauth')
    )
  }
  #view(s: ResourceState): DesktopNodeView {
    const recent = this.#actions.filter(
      a => a.agent === s.agent && a.at >= this.#now() - 86400000,
    )
    const platform = this.#options.platform ?? process.platform
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
        reason: s.reason,
      },
      computer: {
        enabled: s.computer,
        supported: this.#supported(),
        state: s.computer ? s.state : s.state === 'failed' ? 'failed' : 'off',
        display: s.display,
        reason: !this.#supported() ? '需要 Linux、Xvfb 和 xauth' : s.reason,
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
    const managed = this.#processes.get(s.agent)
    if (managed) for (const p of [...managed].reverse()) await p.stop()
    else
      for (const p of [...s.pids].reverse())
        await this.#launcher.reap(p.pid, p.marker)
    this.#processes.delete(s.agent)
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
      downloads = path.join(root, 'downloads')
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
    const env = { ...process.env }
    for (const key of [
      'DISPLAY',
      'WAYLAND_DISPLAY',
      'XAUTHORITY',
      'DBUS_SESSION_BUS_ADDRESS',
    ])
      delete env[key]
    const processes: DesktopProcess[] = []
    this.#processes.set(s.agent, processes)
    const start = async (program: string, argv: string[], marker: string) => {
      const proc = await this.#launcher.start(program, argv, env)
      processes.push(proc)
      s.pids.push({ pid: proc.pid, marker })
      this.#save()
    }
    if (computer) {
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
      await start(
        '/bin/sh',
        [
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
      const activePort = path.join(profile, 'DevToolsActivePort')
      fs.rmSync(activePort, { force: true })
      await start(
        chrome,
        [
          '--headless=new',
          `--user-data-dir=${profile}`,
          '--remote-debugging-address=127.0.0.1',
          '--remote-debugging-port=0',
          '--no-first-run',
          '--no-default-browser-check',
          '--disable-sync',
          '--window-size=1440,900',
          'about:blank',
        ],
        profile,
      )
      const deadline = Date.now() + 15000
      while (Date.now() < deadline) {
        const port = Number(readTextIfExists(activePort)?.split('\n')[0])
        if (Number.isInteger(port) && port > 0 && port <= 65535) {
          const url = `http://127.0.0.1:${port}`
          try {
            if ((await fetch(`${url}/json/version`)).ok) {
              s.cdpUrl = url
              break
            }
          } catch {
            /* Still starting. */
          }
        }
        await Bun.sleep(25)
      }
      if (!s.cdpUrl) throw new Error('Chrome CDP did not become ready')
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
          args.confirm !== 'autonomous')
      )
        return { ok: false, code: 'invalid', message: 'Invalid desktop change' }
      if (
        op === 'desktop.disable' &&
        (args.browser === true ||
          args.computer === true ||
          args.confirm !== undefined)
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
          args.confirm !== undefined)
      )
        return {
          ok: false,
          code: 'invalid',
          message: 'Recycle only accepts agent and operationId',
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
          const policyChanged =
            args.confirm !== undefined && args.confirm !== s.confirm
          if (args.confirm) s.confirm = args.confirm as DesktopConfirm
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
    let args: Record<string, string | number>
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
      const needs = desktopNeedsApproval(tool, args, s.confirm)
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
    return malformed
  }
  /** Why a unit that is not running cannot be leased, and how to open it. */
  #off(s: ResourceState, unit: 'browser' | 'computer'): string {
    const label = UNIT[unit]
    if (unit === 'computer' && !this.#supported())
      return `${label}需要 Linux 节点并装有 Xvfb 与 xauth，本节点不支持；只能开专属浏览器`
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
        if (this.#processes.get(s.agent)?.some(p => !p.alive()))
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
            const tabs = (await fetch(`${s.cdpUrl}/json/list`, {
              signal: AbortSignal.timeout(2000),
            }).then(r => r.json())) as { type: string }[]
            if (
              tabs.filter(t => t.type === 'page').length >
              (this.#options.tabLimit ?? 4)
            )
              reason = 'tab 配额超限，已停用'
          } catch {
            reason = '浏览器失联，已停用'
          }
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
