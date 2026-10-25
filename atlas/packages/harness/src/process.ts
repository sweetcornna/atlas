// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline'

/**
 * One frame a channel emits, in the resident turn port's vocabulary
 * (`message_end`, `tool_execution_*`, `prompt_result`, `runtime_status`).
 * The same shape as `@qianmo/resident`'s `OmpRpcFrame`, defined here so the
 * desktop app's runner can use the channels without the resident package.
 */
export type HarnessFrame = { readonly type: string } & Readonly<
  Record<string, unknown>
>

/** How a channel answered a `prompt`: `@qianmo/resident`'s `OmpPromptAdmission`. */
export interface HarnessPromptAdmission {
  /** The request id `prompt_result` will carry. */
  readonly requestId: string
  /** `true`: wait for the `prompt_result` with {@link requestId}. */
  readonly agentInvoked: boolean
}

/** A token count the turn port can record (`message_end.usage`). */
export interface RuntimeUsage {
  readonly input: number
  readonly output: number
  readonly cacheRead: number
  readonly cacheWrite: number
}

const STDERR_TAIL_BYTES = 4_096

/** What the pool learns from a channel beyond the turn port's frames. */
export interface RuntimeChannelHooks {
  /** The runtime took this input; crash recovery reads it back. */
  readonly onAdmitted?: (messageId: string) => void
}

/**
 * Shared process plumbing for the Claude Code and Codex channels: line-framed
 * JSON on stdout, a bounded stderr tail, one `closed` promise, and frame
 * listeners in the resident turn port's vocabulary (`message_end`,
 * `tool_execution_*`, `prompt_result`).
 */
export abstract class RuntimeChannelBase {
  readonly child: ChildProcess
  readonly closed: Promise<void>
  readonly #listeners = new Set<(frame: HarnessFrame) => void>()
  readonly #hooks: RuntimeChannelHooks
  readonly #reaped: Promise<void>
  #stderr = ''
  #alive = true
  #intentional = false
  #stopping: Promise<void> | undefined
  #readyAt: number | undefined
  #endedAt: number | undefined
  /** The request id of the turn in flight, if any. */
  protected currentRequest: string | undefined

  constructor(child: ChildProcess, hooks: RuntimeChannelHooks = {}) {
    this.child = child
    this.#hooks = hooks
    const { promise, resolve, reject } = Promise.withResolvers<void>()
    this.closed = promise
    void this.closed.catch(() => {})
    this.#reaped = new Promise<void>(done => child.once('close', () => done()))
    child.stderr?.on('data', (chunk: Buffer | string) => {
      this.#stderr = (this.#stderr + chunk.toString()).slice(-STDERR_TAIL_BYTES)
    })
    child.once('error', error => {
      this.#end()
      reject(error)
    })
    child.once('close', (code, signal) => {
      this.#end()
      if (this.#intentional || code === 0) resolve()
      else
        reject(
          new Error(
            `${this.runtimeName} exited (${signal ?? code})${this.#stderr ? `: ${this.#stderr.trim().slice(-400)}` : ''}`,
          ),
        )
    })
    if (child.stdout) {
      const lines = createInterface({ input: child.stdout })
      lines.on('line', line => {
        const text = line.trim()
        if (text === '') return
        let parsed: unknown
        try {
          parsed = JSON.parse(text)
        } catch {
          return // Banners and log lines are not protocol.
        }
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
          this.handleMessage(parsed as Record<string, unknown>)
      })
    }
  }

  protected abstract readonly runtimeName: string
  protected abstract handleMessage(message: Record<string, unknown>): void
  abstract initialize(): Promise<void>
  abstract prompt(input: {
    readonly messageId: string
    readonly text: string
  }): Promise<HarnessPromptAdmission>
  abstract abort(): Promise<void>

  get alive(): boolean {
    return (
      this.#alive &&
      this.child.exitCode === null &&
      this.child.signalCode === null
    )
  }
  get busy(): boolean {
    return this.currentRequest !== undefined
  }
  get readyRuntimeMs(): number {
    return this.#readyAt === undefined
      ? 0
      : (this.#endedAt ?? Date.now()) - this.#readyAt
  }
  get stderrTail(): string {
    return this.#stderr
  }
  protected markReady(): void {
    this.#readyAt ??= Date.now()
  }

  onFrame(listener: (frame: HarnessFrame) => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }
  protected emit(frame: HarnessFrame): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener(frame)
      } catch {
        // A listener's failure must not stop the others from seeing the frame.
      }
    }
  }
  protected write(message: Record<string, unknown>): void {
    if (!this.alive || !this.child.stdin)
      throw new Error(`${this.runtimeName} is closed`)
    this.child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  /** Opens a turn; the caller emits the user `message_end` once admitted. */
  protected beginTurn(): string {
    if (this.currentRequest !== undefined)
      throw new Error(`${this.runtimeName} already runs a turn`)
    const requestId = randomUUID()
    this.currentRequest = requestId
    return requestId
  }
  protected acceptInput(messageId: string, text: string): void {
    this.#hooks.onAdmitted?.(messageId)
    this.emit({
      type: 'message_end',
      message: { role: 'user', content: [{ type: 'text', text }] },
    })
  }
  protected assistantMessage(
    text: string,
    usage?: RuntimeUsage,
    stopReason?: string,
  ): void {
    this.emit({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: text === '' ? [] : [{ type: 'text', text }],
        ...(usage === undefined ? {} : { usage }),
        ...(stopReason === undefined ? {} : { stopReason }),
      },
    })
  }
  protected toolStart(
    id: string,
    name: string,
    args: Record<string, unknown>,
  ): void {
    this.emit({
      type: 'tool_execution_start',
      toolCallId: id,
      toolName: name,
      args,
    })
  }
  protected toolEnd(id: string, name: string, isError: boolean): void {
    this.emit({
      type: 'tool_execution_end',
      toolCallId: id,
      toolName: name,
      isError,
    })
  }
  /** Ends the turn in flight with the turn port's `prompt_result`. */
  protected endTurn(
    status: 'completed' | 'error' | 'aborted',
    error?: { message: string; httpStatus?: number },
  ): void {
    const id = this.currentRequest
    if (id === undefined) return
    this.currentRequest = undefined
    this.emit({
      type: 'prompt_result',
      id,
      status,
      ...(error === undefined ? {} : { error }),
    })
  }

  async prepareRoute(): Promise<undefined> {
    return undefined
  }

  #end(): void {
    if (!this.#alive) return
    this.#alive = false
    this.#endedAt ??= Date.now()
    if (this.currentRequest !== undefined)
      this.endTurn('error', {
        message: `${this.runtimeName} exited during the turn`,
      })
  }

  stop(terminateImmediately = false): Promise<void> {
    this.#stopping ??= this.#stopAndReap()
    if (terminateImmediately) this.#signal('SIGTERM')
    return this.#stopping
  }
  #signal(name: NodeJS.Signals): void {
    try {
      this.child.kill(name)
    } catch {
      // Not proof of exit; keep waiting for close.
    }
  }
  async #stopAndReap(): Promise<void> {
    this.#intentional = true
    this.#endedAt ??= Date.now()
    try {
      this.child.stdin?.end()
    } catch {
      this.#signal('SIGTERM')
    }
    const terminate = setTimeout(() => this.#signal('SIGTERM'), 1_000)
    const kill = setTimeout(() => this.#signal('SIGKILL'), 3_000)
    terminate.unref()
    kill.unref()
    try {
      if (this.child.exitCode === null && this.child.signalCode === null)
        await this.#reaped
    } finally {
      clearTimeout(terminate)
      clearTimeout(kill)
    }
  }
}

/** The tool name the progress line shows for a runtime-native tool call. */
export function toolArgs(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

export function nonNegative(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : 0
}
