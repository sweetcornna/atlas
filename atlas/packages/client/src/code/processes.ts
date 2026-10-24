// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The runner's own processes (qmo-local.md §4.3.2): one runner per client
 * folder (`runner.lock`: pid and start time; a dead holder's is taken over),
 * and the agent processes it started (`children.json`), so that a runner
 * started after a crash ends what the last one left, and nothing else: only
 * a process whose pid, start time and program all match.
 */

import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import { readPrivateFile, writePrivateFile } from '../secret.js'
import type { ChildInfo } from './drivers/agent.js'

/** How far a process's start, as `ps` tells it (to the second), may be from ours. */
const START_SLACK_MS = 3_000

/** Sends `signal` to `pid`'s process group (Windows: ends the tree). */
export function killGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    if (process.platform === 'win32')
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      })
    else process.kill(-pid, signal)
  } catch {
    // Gone already.
  }
}

/** Whether `pid` is a process (of anyone's). */
function exists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** `[[dd-]hh:]mm:ss` in milliseconds. */
function elapsedMs(text: string): number | undefined {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(text)
  if (match === null) return undefined
  const [, days = '0', hours = '0', minutes = '0', seconds = '0'] = match
  return (
    (((Number(days) * 24 + Number(hours)) * 60 + Number(minutes)) * 60 +
      Number(seconds)) *
    1000
  )
}

/** When `pid` started and its command line, by `ps`; `undefined` when it is not there. */
function processInfo(
  pid: number,
): { readonly startedAt: number; readonly command: string } | undefined {
  if (process.platform === 'win32' || !exists(pid)) return undefined
  const out = spawnSync(
    'ps',
    ['-o', 'etime=', '-o', 'command=', '-p', String(pid)],
    {
      encoding: 'utf8',
      env: { PATH: '/bin:/usr/bin', LC_ALL: 'C' },
    },
  )
  if (out.status !== 0) return undefined
  const line = out.stdout.trim()
  const space = line.indexOf(' ')
  if (space < 0) return undefined
  const ms = elapsedMs(line.slice(0, space))
  if (ms === undefined) return undefined
  return { startedAt: Date.now() - ms, command: line.slice(space + 1).trim() }
}

/** Whether `pid` is still the process that started at `startedAt` (running `program`). */
function same(pid: number, startedAt: number, program?: string): boolean {
  const info = processInfo(pid)
  return (
    info !== undefined &&
    Math.abs(info.startedAt - startedAt) <= START_SLACK_MS &&
    (program === undefined || info.command.includes(program))
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** `runner.lock`: this runner's, until it ends. */
export class RunnerLock {
  readonly #file: string
  readonly #startedAt: number

  private constructor(file: string, startedAt: number) {
    this.#file = file
    this.#startedAt = startedAt
  }

  /** The lock, or the pid of the live runner that holds it. */
  static acquire(file: string): RunnerLock | { readonly heldBy: number } {
    const startedAt = Date.now()
    const content = `${JSON.stringify({ pid: process.pid, startedAt })}\n`
    try {
      fs.writeFileSync(file, content, { flag: 'wx', mode: 0o600 })
      return new RunnerLock(file, startedAt)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    let held: unknown
    try {
      held = JSON.parse(readPrivateFile(file) ?? 'null')
    } catch {
      held = null
    }
    if (
      isRecord(held) &&
      typeof held.pid === 'number' &&
      typeof held.startedAt === 'number' &&
      held.pid !== process.pid &&
      same(held.pid, held.startedAt)
    )
      return { heldBy: held.pid }
    // The holder is gone (or is not who wrote it): take it over.
    writePrivateFile(file, content)
    return new RunnerLock(file, startedAt)
  }

  release(): void {
    try {
      const held: unknown = JSON.parse(readPrivateFile(this.#file) ?? 'null')
      if (
        isRecord(held) &&
        held.pid === process.pid &&
        held.startedAt === this.#startedAt
      )
        fs.rmSync(this.#file, { force: true })
    } catch {}
  }
}

interface ChildEntry extends ChildInfo {
  readonly session: string
}

/** `children.json`: the agent processes this runner has running. */
export class ChildRegistry {
  readonly #file: string
  readonly #entries = new Map<number, ChildEntry>()

  constructor(file: string) {
    this.#file = file
  }

  add(session: string, child: ChildInfo): void {
    this.#entries.set(child.pid, { ...child, session })
    this.#save()
  }

  remove(pid: number): void {
    if (this.#entries.delete(pid)) this.#save()
  }

  /** Ends, with their groups, the agent processes still running (the runner is leaving). */
  killAll(): void {
    for (const pid of this.#entries.keys()) killGroup(pid, 'SIGKILL')
  }

  #save(): void {
    try {
      writePrivateFile(
        this.#file,
        `${JSON.stringify({ v: 1, children: [...this.#entries.values()] })}\n`,
      )
    } catch {
      // Only crash cleanup is lost.
    }
  }

  /**
   * Ends what a runner before this one left running: each process whose pid,
   * start time and program match the record, with its group; then forgets
   * the record. Returns how many were ended.
   */
  reapLeftovers(termGraceMs = 3_000): number {
    let raw: unknown
    try {
      raw = JSON.parse(readPrivateFile(this.#file) ?? 'null')
    } catch {
      raw = null
    }
    const children =
      isRecord(raw) && Array.isArray(raw.children) ? raw.children : []
    let ended = 0
    for (const child of children) {
      if (
        !isRecord(child) ||
        typeof child.pid !== 'number' ||
        typeof child.startedAt !== 'number' ||
        typeof child.program !== 'string' ||
        child.pid === process.pid ||
        !same(child.pid, child.startedAt, child.program)
      )
        continue
      const { pid, startedAt, program } = child
      killGroup(pid, 'SIGTERM')
      ended++
      setTimeout(() => {
        if (same(pid, startedAt, program)) killGroup(pid, 'SIGKILL')
      }, termGraceMs).unref()
    }
    this.#save()
    return ended
  }
}
