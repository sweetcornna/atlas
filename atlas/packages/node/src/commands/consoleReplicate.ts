// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 控制台的复制面（`ReplicatePort`，`node-provisioning.md` §14）。
 *
 * - `inspect`：起一个 `qm replicate inspect` 子进程，凭据从 stdin 进；结果连同凭据
 *   留在本进程内存里，按一张随机票取，15 分钟过期，最多同时留 8 张。
 * - `start`：取票（取了就删），核对操作者确认的指纹就是检查时扫到的那一把，把
 *   请求写成一份 0600 文件交给后台作业（`systemd-run --user`，没有就脱离本进程起），
 *   随即返回。作业读完那份文件就删掉它。
 * - `jobs` / `job`：读 `<内测根>/state/replicate/<作业>.ndjson`，按事件折出状态。
 *
 * 作业要脱离控制台跑：它的倒数第二步是重启控制台本身。
 */

import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeSync,
} from 'node:fs'
import { isIP } from 'node:net'
import { basename, dirname, join } from 'node:path'
import type {
  ConsoleResult,
  ReplicateInspection,
  ReplicateJob,
  ReplicateJobEvent,
  ReplicatePort,
  ReplicateStartInput,
  ReplicateTargetInput,
} from '@qianmo/console'
import {
  hubBinaryName,
  type InspectReport,
  jobLogDir,
  newJobId,
  parseInspectRequest,
  parseRunRequest,
  type ReplicateFailure,
} from './replicate.js'

export interface ConsoleReplicateConfig {
  /** The hub's beta root (`QIANMO_BETA_ROOT`). */
  readonly root: string
  /** The deployment tree this console runs from (`dist/` and `demo/`). */
  readonly tree: string
  /** This console's own loopback origin. */
  readonly consoleUrl: string
  /** The main agent's address; its agent name is the default for a copy. */
  readonly mainAgent?: string
}

/** What the port runs; replaced in tests. */
export interface ReplicateLauncher {
  inspect(request: string): Promise<string>
  launch(job: string, requestFile: string): Promise<void>
}

const TICKET_TTL_MS = 15 * 60_000
const MAX_TICKETS = 8
/** A running job that has said nothing for this long has died. */
const STALE_MS = 40 * 60_000
const JOB_ID = /^[a-z0-9-]{6,64}$/

interface Ticket {
  readonly target: ReplicateTargetInput
  readonly fingerprints: readonly string[]
  readonly supported: boolean
  readonly expiresAt: number
}

function failure(
  code:
    | 'invalid'
    | 'refused'
    | 'rejected'
    | 'not_found'
    | 'unreachable'
    | 'unsupported',
  message: string,
): { ok: false; failure: { code: typeof code; message: string } } {
  return { ok: false, failure: { code, message } }
}

/**
 * The deployment tree this process runs from: `<tree>/dist/qm-<platform>-<arch>`
 * is the compiled qm (`common.sh`, `beta_host_target`). `null` in a source
 * checkout, where there is no single binary to copy.
 */
export function deploymentTree(): string | null {
  if (process.env.QIANMO_OMP_ENTRY !== 'self') return null
  const dist = dirname(process.execPath)
  if (
    basename(dist) !== 'dist' ||
    basename(process.execPath) !== hubBinaryName()
  )
    return null
  const tree = dirname(dist)
  return existsSync(
    join(tree, 'demo', 'env', 'beta', 'ops', 'replicate-hub.sh'),
  )
    ? tree
    : null
}

/** The argv that runs this same qm with `args` (`effectiveProcess.ts`). */
export function selfArgv(args: readonly string[]): string[] {
  return process.env.QIANMO_OMP_ENTRY === 'self'
    ? [process.execPath, ...args]
    : [process.execPath, join(import.meta.dir, '..', 'cli.ts'), ...args]
}

function childEnv(root: string): Record<string, string> {
  const env: Record<string, string> = { QIANMO_BETA_ROOT: root }
  for (const name of [
    'PATH',
    'HOME',
    'USER',
    'LOGNAME',
    'LANG',
    'XDG_RUNTIME_DIR',
    'DBUS_SESSION_BUS_ADDRESS',
    'QIANMO_OMP_ENTRY',
    'QIANMO_BETA_MODEL_KEY_DIR',
  ]) {
    const value = process.env[name]
    if (value !== undefined) env[name] = value
  }
  return env
}

function collect(
  argv: readonly string[],
  env: Record<string, string>,
  input: string,
  timeoutMs: number,
): Promise<{ code: number; stdout: string }> {
  return new Promise(resolve => {
    const [command, ...args] = argv
    const child = spawn(command ?? 'false', args, {
      env,
      stdio: ['pipe', 'pipe', 'ignore'],
    })
    let stdout = ''
    child.stdout.on('data', (chunk: Buffer) => {
      if (stdout.length < 1024 * 1024) stdout += chunk.toString('utf8')
    })
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.on('error', () => {
      clearTimeout(timer)
      resolve({ code: 127, stdout })
    })
    child.on('close', code => {
      clearTimeout(timer)
      resolve({ code: code ?? 1, stdout })
    })
    child.stdin.on('error', () => {})
    child.stdin.end(input)
  })
}

export function defaultLauncher(
  config: ConsoleReplicateConfig,
): ReplicateLauncher {
  const env = childEnv(config.root)
  return {
    async inspect(request) {
      const ran = await collect(
        selfArgv(['replicate', 'inspect']),
        env,
        request,
        150_000,
      )
      return ran.stdout
    },
    async launch(job, requestFile) {
      const argv = selfArgv(['replicate', 'run', '--request', requestFile])
      // Its own transient unit: the job restarts this console near its end.
      const unit = await collect(
        [
          'systemd-run',
          '--user',
          '--collect',
          '--quiet',
          `--unit=qianmo-replicate-${job}`,
          ...Object.entries(env).map(
            ([name, value]) => `--setenv=${name}=${value}`,
          ),
          '--',
          ...argv,
        ],
        env,
        '',
        30_000,
      )
      if (unit.code === 0) return
      const [command, ...args] = argv
      const child = spawn(command ?? 'false', args, {
        env,
        detached: true,
        stdio: 'ignore',
      })
      // A job that never started must not leave its credential behind.
      child.on('error', () => rmSync(requestFile, { force: true }))
      child.unref()
    },
  }
}

/** Node names already in peers.conf, so a suggestion does not collide. */
function knownNodes(root: string): Set<string> {
  const names = new Set<string>()
  try {
    for (const line of readFileSync(join(root, 'peers.conf'), 'utf8').split(
      '\n',
    )) {
      const fields = line.trim().split(/\s+/)
      if (fields[0] === 'node' && fields[1] !== undefined) names.add(fields[1])
      const address = /^qianmo:\/\/([^/\s]+)\//.exec(fields[0] ?? '')
      if (address?.[1] !== undefined) names.add(address[1])
    }
  } catch {}
  return names
}

/** A node name from the host: the last two IPv4 octets, or the first DNS label. */
export function suggestNode(host: string, taken: ReadonlySet<string>): string {
  let base: string
  if (isIP(host) === 4) base = `n${host.split('.').slice(2).join('-')}`
  else if (isIP(host) === 6)
    base = `n${host
      .replace(/[^0-9a-f]/gi, '')
      .slice(-6)
      .toLowerCase()}`
  else
    base = (host.split('.')[0] ?? 'node')
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, '-')
      .replace(/^[-_]+|[-_]+$/g, '')
      .slice(0, 40)
  if (base === '') base = 'node'
  let name = base
  for (let n = 2; taken.has(name); n += 1) name = `${base}-${n}`
  return name
}

function agentOf(address: string | undefined): string {
  const agent =
    address === undefined
      ? undefined
      : /^qianmo:\/\/[^/]+\/([^/]+)$/.exec(address)?.[1]
  return agent !== undefined && /^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/.test(agent)
    ? agent
    : 'main'
}

// ---------------------------------------------------------------------------
// job logs

interface RawEvent {
  readonly at?: string
  readonly step?: string
  readonly state?: string
  readonly detail?: string
  readonly address?: string
  readonly node?: string
  readonly agent?: string
  readonly host?: string
}

export function foldJob(
  job: string,
  text: string,
  now: number,
): ReplicateJob | null {
  const events: ReplicateJobEvent[] = []
  let node = ''
  let agent = ''
  let host = ''
  let address: string | undefined
  let state: ReplicateJob['state'] = 'running'
  let step = 'pin'
  let error: string | undefined
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    let raw: RawEvent
    try {
      raw = JSON.parse(line) as RawEvent
    } catch {
      continue
    }
    const at = Date.parse(raw.at ?? '')
    if (!Number.isFinite(at) || typeof raw.step !== 'string') continue
    if (typeof raw.node === 'string') node = raw.node
    if (typeof raw.agent === 'string') agent = raw.agent
    if (typeof raw.host === 'string') host = raw.host
    if (raw.step === 'queued') {
      events.push({ at, step: 'queued', state: 'info' })
      continue
    }
    const kind =
      raw.state === 'start' || raw.state === 'ok' || raw.state === 'fail'
        ? raw.state
        : 'info'
    events.push({
      at,
      step: raw.step,
      state: kind,
      ...(typeof raw.detail === 'string' ? { detail: raw.detail } : {}),
    })
    if (raw.step === 'done' && kind === 'ok') {
      state = 'done'
      if (typeof raw.address === 'string') address = raw.address
    } else if (kind === 'fail' && raw.step !== 'rollback') {
      state = 'failed'
      step = raw.step
      error = raw.detail
    } else if (
      raw.step !== 'rollback' &&
      raw.step !== 'done' &&
      state === 'running'
    ) {
      step = raw.step
    }
  }
  const first = events[0]
  const last = events.at(-1)
  if (first === undefined || last === undefined) return null
  if (state === 'running' && now - last.at > STALE_MS) {
    state = 'failed'
    error = '作业很久没有再报进度 · 可能已经退出'
  }
  return {
    job,
    node,
    agent,
    host,
    state,
    step,
    startedAt: first.at,
    updatedAt: last.at,
    events,
    ...(address === undefined ? {} : { address }),
    ...(error === undefined ? {} : { error }),
  }
}

function writeExclusive(file: string, text: string): void {
  const fd = openSync(file, 'wx', 0o600)
  try {
    writeSync(fd, text)
  } finally {
    closeSync(fd)
  }
}

// ---------------------------------------------------------------------------
// the port

export function openConsoleReplicate(
  config: ConsoleReplicateConfig,
  options: {
    readonly launcher?: ReplicateLauncher
    readonly now?: () => number
  } = {},
): ReplicatePort {
  const launcher = options.launcher ?? defaultLauncher(config)
  const now = options.now ?? Date.now
  const tickets = new Map<string, Ticket>()
  const logDir = jobLogDir(config.root)

  function prune(): void {
    const at = now()
    for (const [id, ticket] of tickets)
      if (ticket.expiresAt <= at) tickets.delete(id)
    while (tickets.size > MAX_TICKETS) {
      const oldest = tickets.keys().next().value
      if (oldest === undefined) break
      tickets.delete(oldest)
    }
  }

  function readJob(id: string): ReplicateJob | null {
    try {
      return foldJob(
        id,
        readFileSync(join(logDir, `${id}.ndjson`), 'utf8'),
        now(),
      )
    } catch {
      return null
    }
  }

  function allJobs(): ReplicateJob[] {
    if (!existsSync(logDir)) return []
    const jobs: ReplicateJob[] = []
    for (const name of readdirSync(logDir)) {
      if (!name.endsWith('.ndjson')) continue
      const id = name.slice(0, -'.ndjson'.length)
      if (!JOB_ID.test(id)) continue
      const job = readJob(id)
      if (job !== null) jobs.push(job)
    }
    return jobs.sort((a, b) => b.startedAt - a.startedAt)
  }

  return {
    async inspect(target): Promise<ConsoleResult<ReplicateInspection>> {
      prune()
      const request = {
        v: 1,
        op: 'inspect',
        target: { host: target.host, port: target.port, user: target.user },
        auth: target.auth,
        tree: config.tree,
      }
      const parsed = parseInspectRequest(request)
      if (!parsed.ok) return failure('invalid', parsed.reason)
      const raw = await launcher.inspect(JSON.stringify(request))
      let report: InspectReport | ReplicateFailure
      try {
        report = JSON.parse(raw.trim().split('\n').at(-1) ?? '') as
          | InspectReport
          | ReplicateFailure
      } catch {
        return failure('unreachable', '检查没有结果')
      }
      if (!report.ok) {
        return failure(
          report.code === 'auth' || report.code.startsWith('bad-')
            ? 'rejected'
            : 'unreachable',
          report.reason,
        )
      }
      const ticket = randomBytes(18).toString('base64url')
      const expiresAt = now() + TICKET_TTL_MS
      tickets.set(ticket, {
        target,
        fingerprints: report.hostKeys.map(key => key.fingerprint),
        supported: report.supported,
        expiresAt,
      })
      prune()
      return {
        ok: true,
        value: {
          ticket,
          host: target.host,
          port: target.port,
          user: target.user,
          hostKeys: report.hostKeys,
          os: report.os,
          arch: report.arch,
          kernel: report.kernel,
          memMb: report.memMb,
          diskMb: report.diskMb,
          supported: report.supported,
          ...(report.reason === undefined ? {} : { reason: report.reason }),
          suggested: {
            node: suggestNode(target.host, knownNodes(config.root)),
            agent: agentOf(config.mainAgent),
            server: target.host,
          },
          expiresAt,
        },
      }
    },

    async start(
      input: ReplicateStartInput,
    ): Promise<ConsoleResult<ReplicateJob>> {
      prune()
      const ticket = tickets.get(input.ticket)
      if (ticket === undefined)
        return failure('not_found', '检查结果已过期 · 请重新检查')
      if (!ticket.supported) return failure('refused', '这台服务器没有通过检查')
      if (!ticket.fingerprints.includes(input.fingerprint))
        return failure('rejected', '确认的指纹不是检查时读到的那一把')
      if (knownNodes(config.root).has(input.node))
        return failure('refused', `节点名 ${input.node} 已经在用`)
      const busy = allJobs().find(job => job.state === 'running')
      if (busy !== undefined)
        return failure(
          'refused',
          `已有一个复制在进行（${busy.node}）· 等它结束再开始`,
        )
      const job = newJobId(now())
      const request = {
        v: 1,
        op: 'run',
        job,
        target: {
          host: ticket.target.host,
          port: ticket.target.port,
          user: ticket.target.user,
        },
        auth: ticket.target.auth,
        hostKey: input.fingerprint,
        node: input.node,
        agent: input.agent,
        server: input.server,
        root: config.root,
        tree: config.tree,
        consoleUrl: config.consoleUrl,
      }
      const parsed = parseRunRequest(request)
      if (!parsed.ok) return failure('invalid', parsed.reason)
      // The ticket is spent whatever happens next.
      tickets.delete(input.ticket)
      mkdirSync(logDir, { recursive: true, mode: 0o700 })
      const queued = {
        at: new Date(now()).toISOString(),
        job,
        step: 'queued',
        state: 'info',
        node: input.node,
        agent: input.agent,
        host: ticket.target.host,
      }
      writeExclusive(
        join(logDir, `${job}.ndjson`),
        `${JSON.stringify(queued)}\n`,
      )
      const runtime = process.env.XDG_RUNTIME_DIR
      const spool =
        runtime !== undefined && existsSync(runtime) ? runtime : logDir
      const file = join(spool, `qianmo-replicate-${job}.json`)
      writeExclusive(file, JSON.stringify(request))
      await launcher.launch(job, file)
      const view = readJob(job)
      return view === null
        ? failure('unreachable', '作业没有起来')
        : { ok: true, value: view }
    },

    async jobs() {
      return { ok: true, value: allJobs() }
    },

    async job(id) {
      if (!JOB_ID.test(id)) return failure('invalid', '作业号不合法')
      const view = readJob(id)
      return view === null
        ? failure('not_found', '没有这个作业')
        : { ok: true, value: view }
    },
  }
}
