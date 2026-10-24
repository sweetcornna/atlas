// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `qmo code serve`, the local runner (qmo-local.md §4.3.2): the desktop
 * shell's resident child, one JSON object per line each way. Standard output
 * carries the protocol only, every log line goes to standard error, without
 * what was said. `shutdown` and the end of standard input both stop every
 * turn, end every agent and leave.
 *
 * | Direction | Shape |
 * | --- | --- |
 * | request | `{id, method, params}` |
 * | answer | `{id, result}` or `{id, error: {code, message}}` |
 * | event | `{method: 'event', params: {v: 1, type, …}}` |
 */

import { createInterface } from 'node:readline'
import pkg from '../../package.json' with { type: 'json' }
import { type AgentsReport, scanAgents } from '../agents.js'
import { ClientError } from '../hub.js'
import { agentEnv, LoginEnvironment, loginEnvFor } from './env.js'
import type { GitContext } from './git.js'
import { ChildRegistry, RunnerLock } from './processes.js'
import {
  agentId,
  askId,
  booleanOf,
  clientId,
  CodeError,
  type CodeEvent,
  DEFAULT_READ,
  decisionOf,
  FEATURES,
  folderId,
  keys,
  limitOf,
  messageOf,
  modeOf,
  pickedPathOf,
  positiveOf,
  relativePathOf,
  sessionId,
  textOf,
} from './protocol.js'
import { type FoundAgent, type Limits, SessionManager } from './session.js'
import { CodeStore } from './store.js'

/** The runner's protocol version (`hello`). */
const PROTOCOL = 1
/** A method answers within this, or says it could not (the shell waits 30 s). */
const ANSWER_WITHIN_MS = 25_000
/** `qmo agents` is asked again after this long. */
const SCAN_KEEP_MS = 30_000

export interface ServeIO {
  readonly input: NodeJS.ReadableStream
  /** One line of protocol, without its newline. */
  readonly write: (line: string) => void
  /** Settles once everything written has been handed on. */
  readonly drain?: () => Promise<void>
  readonly log: (line: string) => void
}

export interface ServeOptions {
  /** `<client dir>/code`. */
  readonly codeDir: string
  /** The client folder itself: guarded, never a session's folder. */
  readonly clientDir: string
  /** `agents.json`, as `qmo agents` keeps it. */
  readonly agentsCache: string
  readonly io: ServeIO
  /** Tests: the agents found, the login shell, the budgets. */
  readonly scan?: () => Promise<AgentsReport>
  readonly loginEnv?: LoginEnvironment
  readonly env?: NodeJS.ProcessEnv
  /** The user's home (default: this process's). */
  readonly home?: string
  readonly limits?: Partial<Limits>
}

function codeError(error: unknown): { code: string; message: string } {
  if (error instanceof CodeError)
    return { code: error.code, message: error.message }
  if (error instanceof ClientError)
    return { code: 'E_RUNNER', message: error.message }
  return {
    code: 'E_RUNNER',
    message: String((error as Error)?.message ?? error),
  }
}

/** The agents `qmo agents` finds, asked at most every 30 s. */
function agentFinder(
  scan: () => Promise<AgentsReport>,
): (id: string) => Promise<FoundAgent> {
  let kept: { at: number; report: Promise<AgentsReport> } | undefined
  return async id => {
    if (kept === undefined || Date.now() - kept.at >= SCAN_KEEP_MS)
      kept = { at: Date.now(), report: scan() }
    let report: AgentsReport
    try {
      report = await kept.report
    } catch (error) {
      kept = undefined
      return { ok: false, reason: `没能查找本机 agent：${String(error)}` }
    }
    const agent = report.agents.find(one => one.id === id)
    if (agent === undefined)
      return { ok: false, reason: '这台电脑上没有找到它' }
    if (!agent.available || agent.path === null)
      return { ok: false, reason: agent.reason ?? '它现在不可用' }
    if (!FEATURES.protocols.some(one => one === agent.protocol))
      return { ok: false, reason: '后续版本支持' }
    return {
      ok: true,
      id: agent.id,
      name: agent.name,
      version: agent.version,
      path: agent.path,
      protocol: agent.protocol ?? '',
    }
  }
}

/** Runs one method; throws a {@link CodeError} for a refusal. */
async function dispatch(
  manager: SessionManager,
  codeDir: string,
  method: string,
  params: unknown,
): Promise<unknown> {
  switch (method) {
    case 'hello':
      keys(params, [])
      return {
        version: pkg.version,
        protocol: PROTOCOL,
        features: FEATURES,
        codeDir,
      }
    case 'list':
      keys(params, [])
      return manager.list()
    case 'folders.add': {
      const p = keys(params, ['path'])
      return manager.addFolder(pickedPathOf(p.path))
    }
    case 'folders.forget': {
      const p = keys(params, ['folder'])
      manager.forgetFolder(folderId(p.folder))
      return {}
    }
    case 'session.start': {
      const p = keys(
        params,
        ['folder', 'agent', 'mode', 'worktree', 'text', 'clientId'],
        ['remote'],
      )
      const folder = folderId(p.folder)
      const agent = agentId(p.agent)
      const mode = modeOf(p.mode)
      const text = textOf(p.text)
      const client = clientId(p.clientId)
      if (booleanOf(p.worktree, 'worktree'))
        throw new CodeError('E_ARGS', '独立工作树在后续版本开放')
      if (p.remote !== undefined && booleanOf(p.remote, 'remote'))
        throw new CodeError('E_REMOTE', 'Remote 在后续版本开放')
      return manager.start({ folder, agent, mode, text, clientId: client })
    }
    case 'session.send': {
      const p = keys(params, ['session', 'text', 'clientId'], ['origin'])
      if (p.origin !== undefined && p.origin !== 'local') {
        if (p.origin === 'remote')
          throw new CodeError('E_REMOTE', 'Remote 在后续版本开放')
        throw new CodeError('E_ARGS', 'origin 只能是 local')
      }
      return manager.send({
        session: sessionId(p.session),
        text: textOf(p.text),
        clientId: clientId(p.clientId),
      })
    }
    case 'session.stop': {
      const p = keys(params, ['session'])
      manager.stop(sessionId(p.session))
      return {}
    }
    case 'session.answer': {
      const p = keys(params, ['session', 'ask', 'decision'], ['message'])
      manager.answer({
        session: sessionId(p.session),
        ask: askId(p.ask),
        decision: decisionOf(p.decision),
        ...(p.message === undefined ? {} : { message: messageOf(p.message) }),
      })
      return {}
    }
    case 'session.mode': {
      const p = keys(params, ['session', 'mode'])
      return manager.setMode({
        session: sessionId(p.session),
        mode: modeOf(p.mode),
      })
    }
    case 'session.read': {
      const p = keys(params, ['session'], ['before', 'limit'])
      return manager.read({
        session: sessionId(p.session),
        ...(p.before === undefined
          ? {}
          : { before: positiveOf(p.before, 'before') }),
        limit: p.limit === undefined ? DEFAULT_READ : limitOf(p.limit),
      })
    }
    case 'session.changes': {
      const p = keys(params, ['session'])
      return manager.changes(sessionId(p.session))
    }
    case 'session.diff': {
      const p = keys(params, ['session', 'path'])
      return manager.diff(sessionId(p.session), relativePathOf(p.path))
    }
    case 'session.remote': {
      const p = keys(params, ['session', 'on'])
      sessionId(p.session)
      booleanOf(p.on, 'on')
      throw new CodeError('E_REMOTE', 'Remote 在后续版本开放')
    }
    case 'session.rename':
    case 'session.delete':
      throw new CodeError('E_ARGS', '后续版本支持')
    default:
      throw new CodeError('E_ARGS', `不认识的方法：${method}`)
  }
}

interface Request {
  readonly id: number
  readonly method: string
  readonly params: unknown
}

function requestOf(line: string): Request | undefined {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return undefined
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return undefined
  const { id, method, params } = value as Record<string, unknown>
  if (
    typeof id !== 'number' ||
    !Number.isSafeInteger(id) ||
    id < 1 ||
    typeof method !== 'string' ||
    Object.keys(value).some(key => !['id', 'method', 'params'].includes(key))
  )
    return undefined
  return { id, method, params: params ?? {} }
}

/** Serves until `shutdown` or the end of input; the exit code. */
export async function serve(options: ServeOptions): Promise<number> {
  const { io } = options
  const store = new CodeStore(options.codeDir)
  let lock: RunnerLock
  try {
    store.ensure()
    const held = RunnerLock.acquire(store.lockFile)
    if (!(held instanceof RunnerLock)) {
      io.log(
        `[runner] another runner holds ${store.lockFile} (pid ${held.heldBy})`,
      )
      return 1
    }
    lock = held
  } catch (error) {
    io.log(
      `[runner] cannot use ${options.codeDir}: ${codeError(error).message}`,
    )
    return 1
  }
  io.log(`[runner] up, pid ${process.pid}`)
  const children = new ChildRegistry(store.childrenFile)
  const reaped = children.reapLeftovers()
  if (reaped > 0)
    io.log(`[runner] ended ${reaped} agent process(es) left behind`)

  const env = options.env ?? process.env
  const login = options.loginEnv ?? new LoginEnvironment({ env })
  const spawnEnv = async () => agentEnv(env, await login.get())
  const scan =
    options.scan ??
    (() =>
      scanAgents({
        cacheFile: options.agentsCache,
        env,
        ...(options.home === undefined ? {} : { home: options.home }),
        ...(process.platform === 'win32'
          ? {}
          : {
              // The same login shell answer the agent will start with.
              loginShell: async names => loginEnvFor(await login.get(), names),
            }),
      }))
  const send = (message: unknown) => io.write(JSON.stringify(message))
  const emit = (event: CodeEvent) =>
    send({ method: 'event', params: { v: 1, ...event } })
  const manager = new SessionManager({
    store,
    clientDir: options.clientDir,
    ...(options.home === undefined ? {} : { home: options.home }),
    emit,
    findAgent: agentFinder(scan),
    agentEnv: spawnEnv,
    git: async (): Promise<GitContext | undefined> => {
      const agentEnvironment = await spawnEnv()
      const git = Bun.which('git', { PATH: agentEnvironment.PATH ?? '' })
      return git === null ? undefined : { git, env: agentEnvironment }
    },
    children,
    ...(options.limits === undefined ? {} : { limits: options.limits }),
    log: line => io.log(`[runner] ${line}`),
  })

  const { promise: done, resolve: finish } = Promise.withResolvers<void>()
  let closing: Promise<void> | undefined
  const close = (): Promise<void> => {
    closing ??= manager.shutdown().catch(error => {
      io.log(`[runner] shutdown: ${codeError(error).message}`)
    })
    return closing
  }
  const handle = async (request: Request): Promise<void> => {
    if (request.method === 'shutdown') {
      try {
        keys(request.params, [])
      } catch (error) {
        send({ id: request.id, error: codeError(error) })
        return
      }
      await close()
      send({ id: request.id, result: {} })
      finish()
      return
    }
    if (closing !== undefined) {
      send({
        id: request.id,
        error: { code: 'E_RUNNER', message: '运行器正在退出' },
      })
      return
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const result = await Promise.race([
        dispatch(manager, options.codeDir, request.method, request.params),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new CodeError('E_RUNNER', '超过 25 秒没有做完')),
            ANSWER_WITHIN_MS,
          )
        }),
      ])
      send({ id: request.id, result })
    } catch (error) {
      const refusal = codeError(error)
      if (refusal.code === 'E_RUNNER')
        io.log(`[runner] ${request.method}: ${refusal.message}`)
      send({ id: request.id, error: refusal })
    } finally {
      clearTimeout(timer)
    }
  }

  const lines = createInterface({ input: io.input, crlfDelay: Infinity })
  lines.on('line', line => {
    if (line.trim() === '') return
    const request = requestOf(line)
    if (request === undefined) {
      io.log('[runner] a line that is not a request was dropped')
      return
    }
    void handle(request)
  })
  lines.once('close', () => void close().then(finish))

  await done
  lines.close()
  lock.release()
  await io.drain?.()
  io.log('[runner] down')
  return 0
}

/** The runner on this process's standard input and output. */
export function serveStdio(options: Omit<ServeOptions, 'io'>): Promise<number> {
  let last: Promise<void> = Promise.resolve()
  return serve({
    ...options,
    io: {
      input: process.stdin,
      write: line => {
        last = new Promise<void>(resolve => {
          process.stdout.write(`${line}\n`, () => resolve())
        })
      },
      drain: () => last,
      log: line => console.error(line),
    },
  })
}
