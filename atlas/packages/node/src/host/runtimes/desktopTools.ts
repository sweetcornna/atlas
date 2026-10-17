// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import {
  desktopToolDescription,
  desktopTools,
  desktopToolSchema,
  isDesktopTool,
  type DesktopDecision,
  type DesktopResource,
} from '@qianmo/extension/desktopPolicy'
import { ompSpawnEnv, qmArgv } from '../../omp/launch.js'
import type { ResidentPermission } from '../residentOmp.js'
import { residentOmpEnvironment } from '../residentOmpEnv.js'
import type {
  RuntimeToolContent,
  RuntimeToolResult,
  RuntimeToolSession,
  RuntimeToolSpec,
} from './toolHost.js'

/** Where an agent's private resource is described (`NodeDesktop`). */
export interface RuntimeDesktopSource {
  resource(agent: string): DesktopResource | undefined
  resourcePath(agent: string): string
}

export interface RuntimeDesktopSpawn {
  readonly argv: readonly string[]
  readonly env: Record<string, string>
  readonly cwd: string
}

export interface RuntimeDesktopToolsOptions {
  readonly desktop: RuntimeDesktopSource
  /** The host's gate: `NodeDesktop.decide` behind the active-turn checks. */
  readonly permission: (
    sessionId: string,
    call: {
      readonly toolName: string
      readonly input: Readonly<Record<string, unknown>>
    },
  ) => Promise<ResidentPermission>
  /** How the host starts `qm desktop-exec`; tests point it elsewhere. */
  readonly argv?: (args: readonly string[]) => string[]
  readonly spawn?: (input: RuntimeDesktopSpawn) => ChildProcess
  readonly onError?: (error: unknown) => void
}

/** One running `qm desktop-exec` for one session. */
interface Executor {
  readonly child: ChildProcess
  readonly calls: Map<number, (result: RuntimeToolResult) => void>
  sequence: number
}

/** What a desktop child's answer looks like on its way back to MCP. */
function toolResult(message: Record<string, unknown>): RuntimeToolResult {
  if (message.type === 'error')
    return {
      ok: false,
      text:
        typeof message.message === 'string'
          ? message.message
          : 'Desktop call failed',
    }
  const result = message.result as { content?: unknown } | undefined
  const content: RuntimeToolContent[] = []
  for (const part of Array.isArray(result?.content) ? result.content : []) {
    const value = part as Record<string, unknown>
    if (value.type === 'text' && typeof value.text === 'string')
      content.push({ type: 'text', text: value.text })
    else if (
      value.type === 'image' &&
      typeof value.data === 'string' &&
      typeof value.mimeType === 'string'
    )
      content.push({
        type: 'image',
        data: value.data,
        mimeType: value.mimeType,
      })
  }
  const text = content
    .filter(part => part.type === 'text')
    .map(part => part.text)
    .join('\n')
  return { ok: true, text, content }
}

/** A gate answer in the shape the child's gateway reads. */
function answer(
  kind: unknown,
  permission: ResidentPermission,
): boolean | DesktopDecision {
  const decision =
    typeof permission === 'object' && permission !== null
      ? permission
      : undefined
  const granted = permission === true || decision?.ok === true
  if (kind === 'confirm') return granted
  if (granted)
    return typeof decision?.value === 'string'
      ? { ok: true, value: decision.value }
      : { ok: true }
  return { ok: false, reason: decision?.reason || '宿主拒绝了这次请求' }
}

/**
 * The private browser and computer for agents on Claude Code or Codex
 * (runtimes-channels.md §6.1). Tools are listed only while the unit runs;
 * each session that uses one gets its own `qm desktop-exec` child, started
 * on the first call and stopped with the session. Every gate phase the child
 * asks goes to the same host check the qianmopi extension reaches.
 */
export class RuntimeDesktopTools {
  readonly #options: RuntimeDesktopToolsOptions
  readonly #executors = new Map<string, Executor>()

  constructor(options: RuntimeDesktopToolsOptions) {
    this.#options = options
  }

  /** The desktop tools `agent` has right now, in a stable order. */
  specs(agent: string): RuntimeToolSpec[] {
    return desktopTools(this.#options.desktop.resource(agent)).map(name => ({
      name,
      description: desktopToolDescription(name),
      inputSchema: desktopToolSchema(name),
    }))
  }

  handles(name: string): boolean {
    return isDesktopTool(name)
  }

  async call(
    session: RuntimeToolSession,
    cwd: string,
    name: string,
    args: Record<string, unknown>,
  ): Promise<RuntimeToolResult> {
    let executor: Executor
    try {
      executor = this.#executor(session, cwd)
    } catch (error) {
      this.#options.onError?.(error)
      return { ok: false, text: '专属电脑的执行进程起不来，请稍后重试' }
    }
    const id = ++executor.sequence
    return await new Promise<RuntimeToolResult>(resolve => {
      executor.calls.set(id, resolve)
      executor.child.stdin?.write(
        `${JSON.stringify({
          type: 'call',
          id,
          name,
          // MCP carries no provider call id; each call is a fresh one.
          invocationId: randomUUID(),
          args,
        })}\n`,
      )
    })
  }

  #executor(session: RuntimeToolSession, cwd: string): Executor {
    const live = this.#executors.get(session.sessionId)
    if (live && live.child.exitCode === null && !live.child.killed) return live
    const resource = this.#options.desktop.resource(session.agent)
    const env = residentOmpEnvironment(ompSpawnEnv())
    if (env.QIANMO_OMP_ENTRY === 'self') env.PI_COMPILED = 'true'
    delete env.WAYLAND_DISPLAY
    if (resource?.browser || resource?.computer)
      env.TMPDIR = join(resource.downloads, '..', 'screenshots')
    if (resource?.computer && resource.display && resource.xauthority) {
      env.DISPLAY = resource.display
      env.XAUTHORITY = resource.xauthority
      if (resource.bus) env.DBUS_SESSION_BUS_ADDRESS = resource.bus
      else delete env.DBUS_SESSION_BUS_ADDRESS
    } else {
      delete env.DISPLAY
      delete env.XAUTHORITY
      delete env.DBUS_SESSION_BUS_ADDRESS
    }
    const argv = (this.#options.argv ?? qmArgv)([
      'desktop-exec',
      '--resource',
      this.#options.desktop.resourcePath(session.agent),
      '--cwd',
      cwd,
    ])
    const child =
      this.#options.spawn?.({ argv, env, cwd }) ??
      spawn(argv[0]!, argv.slice(1), {
        cwd,
        env,
        stdio: ['pipe', 'pipe', 'ignore'],
      })
    const executor: Executor = { child, calls: new Map(), sequence: 0 }
    this.#executors.set(session.sessionId, executor)
    const gone = () => {
      if (this.#executors.get(session.sessionId) === executor)
        this.#executors.delete(session.sessionId)
      for (const settle of executor.calls.values())
        settle({
          ok: false,
          text: '专属电脑的执行进程已退出；这次操作的结果未知，不要自动重试',
        })
      executor.calls.clear()
    }
    child.once('exit', gone)
    child.once('error', error => {
      this.#options.onError?.(error)
      gone()
    })
    if (child.stdout === null) throw new Error('desktop-exec has no stdout')
    createInterface({ input: child.stdout, crlfDelay: Infinity }).on(
      'line',
      line => {
        let message: Record<string, unknown>
        try {
          const parsed: unknown = JSON.parse(line)
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
            return
          message = parsed as Record<string, unknown>
        } catch {
          return
        }
        if (message.type === 'gate') void this.#gate(session, executor, message)
        else if (
          (message.type === 'result' || message.type === 'error') &&
          typeof message.id === 'number'
        ) {
          const settle = executor.calls.get(message.id)
          executor.calls.delete(message.id)
          settle?.(toolResult(message))
        }
      },
    )
    return executor
  }

  async #gate(
    session: RuntimeToolSession,
    executor: Executor,
    message: Record<string, unknown>,
  ): Promise<void> {
    const request = message.request as
      | { toolName?: unknown; input?: unknown }
      | undefined
    let permission: ResidentPermission = false
    try {
      if (
        request &&
        typeof request.toolName === 'string' &&
        isDesktopTool(request.toolName) &&
        request.input &&
        typeof request.input === 'object' &&
        !Array.isArray(request.input)
      )
        permission = await this.#options.permission(session.sessionId, {
          toolName: request.toolName,
          input: request.input as Record<string, unknown>,
        })
    } catch (error) {
      this.#options.onError?.(error)
      permission = { ok: false, reason: '宿主授权检查出错' }
    }
    if (executor.child.exitCode !== null || executor.child.stdin === null)
      return
    executor.child.stdin.write(
      `${JSON.stringify({
        type: 'gate',
        id: message.id,
        answer: answer(message.kind, permission),
      })}\n`,
    )
  }

  /** End the session's child: it refuses pending gates and closes the tab. */
  close(sessionId: string): void {
    const executor = this.#executors.get(sessionId)
    if (executor === undefined) return
    this.#executors.delete(sessionId)
    executor.child.stdin?.end()
    const timer = setTimeout(() => executor.child.kill('SIGKILL'), 10_000)
    timer.unref()
    executor.child.once('exit', () => clearTimeout(timer))
  }

  stop(): void {
    for (const sessionId of [...this.#executors.keys()]) this.close(sessionId)
  }
}
