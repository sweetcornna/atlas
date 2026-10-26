// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * What a turn is doing, for the work activity panel (`work-tasks.md` §3.3,
 * §5.5): omp's `todo` list as it changes, and which skills, tools and files
 * the turn touched. Raw tool events come from the resident turn port; this
 * keeps a per-turn account and sends it with the `work.activity` hub call —
 * a changed list at most once every two seconds, and the whole account once
 * more when the turn ends. A report that cannot be sent is dropped: the
 * turn never waits for it and it is never retried.
 */

import type { WorkProgressItem, WorkProgressStatus } from '@qianmo/console'
import type { ControlOutcome } from '@qianmo/protocol'
import type { ResidentToolEvent, ResidentTurnInput } from '@qianmo/resident'
import type { TaskToolOrigin } from './taskTools.js'

/** Changes of the list folded into one report (§5.5). */
export const WORK_ACTIVITY_DEBOUNCE_MS = 2000
/** Files one turn's context names. */
const MAX_FILES = 50
/** Tools, skills and list items one report carries. */
const MAX_NAMES = 50
const MAX_ITEMS = 100

/** Argument fields that name files (cf. omp-turn's step locations). */
const PATH_FIELDS = ['path', 'file_path', 'file', 'paths', 'files'] as const

/** omp's skill command, anywhere in the prompt after whitespace. */
const SKILL_COMMAND = /(?:^|\s)\/skill:([A-Za-z0-9][A-Za-z0-9._:-]{0,127})/g

const STATUSES: ReadonlySet<string> = new Set<WorkProgressStatus>([
  'pending',
  'in_progress',
  'completed',
  'abandoned',
  'blocked',
])

/** The turn an event belongs to, as the resident turn port names it. */
export type WorkActivityInput = ResidentTurnInput

export interface WorkActivityOptions {
  readonly call: (
    op: string,
    args: Record<string, unknown>,
    options: { agent: string },
  ) => Promise<ControlOutcome>
  /** The console conversation and turn of a running input, or null. */
  readonly origin: (input: WorkActivityInput) => TaskToolOrigin | null
  readonly debounceMs?: number
}

interface TurnAccount {
  readonly agent: string
  readonly origin: TaskToolOrigin
  readonly skills: Set<string>
  readonly tools: Map<string, number>
  readonly files: Set<string>
  todo: readonly WorkProgressItem[] | undefined
  todoDirty: boolean
  timer: ReturnType<typeof setTimeout> | undefined
}

/** omp's `todo` result details as list items, or undefined when not a list. */
export function todoItems(details: unknown): WorkProgressItem[] | undefined {
  if (details === null || typeof details !== 'object') return undefined
  const phases = (details as { phases?: unknown }).phases
  if (!Array.isArray(phases)) return undefined
  const items: WorkProgressItem[] = []
  for (const phase of phases) {
    if (phase === null || typeof phase !== 'object') continue
    const name = (phase as { name?: unknown }).name
    const tasks = (phase as { tasks?: unknown }).tasks
    if (!Array.isArray(tasks)) continue
    for (const task of tasks) {
      if (task === null || typeof task !== 'object') continue
      const content = (task as { content?: unknown }).content
      const status = (task as { status?: unknown }).status
      if (typeof content !== 'string' || typeof status !== 'string') continue
      if (!STATUSES.has(status)) continue
      items.push({
        phase: typeof name === 'string' ? name.slice(0, 200) : '',
        content: content.slice(0, 500),
        status: status as WorkProgressStatus,
      })
      if (items.length >= MAX_ITEMS) return items
    }
  }
  return items
}

function pathsOf(
  args: Readonly<Record<string, unknown>> | undefined,
): string[] {
  if (args === undefined) return []
  const out: string[] = []
  const take = (value: unknown): void => {
    if (typeof value === 'string') {
      if (value !== '' && !value.includes('://') && value.length <= 1024)
        out.push(value)
    } else if (value !== null && typeof value === 'object' && 'name' in value) {
      take((value as { name?: unknown }).name)
    }
  }
  for (const field of PATH_FIELDS) {
    const value = args[field]
    if (Array.isArray(value)) for (const one of value.slice(0, 20)) take(one)
    else take(value)
  }
  return out
}

export class WorkActivityTracker {
  readonly #options: WorkActivityOptions
  readonly #turns = new Map<string, TurnAccount>()

  constructor(options: WorkActivityOptions) {
    this.#options = options
  }

  #account(input: WorkActivityInput): TurnAccount | undefined {
    const known = this.#turns.get(input.sessionId)
    if (known !== undefined) return known
    if (input.agent === undefined) return undefined
    const origin = this.#options.origin(input)
    if (origin === null) return undefined
    const account: TurnAccount = {
      agent: input.agent,
      origin,
      skills: new Set(),
      tools: new Map(),
      files: new Set(),
      todo: undefined,
      todoDirty: false,
      timer: undefined,
    }
    for (const match of input.prompt.matchAll(SKILL_COMMAND))
      if (account.skills.size < MAX_NAMES) account.skills.add(match[1]!)
    this.#turns.set(input.sessionId, account)
    return account
  }

  onToolEvent(input: WorkActivityInput, event: ResidentToolEvent): void {
    if (event.phase === 'turn_end') {
      const account = this.#account(input)
      this.#turns.delete(input.sessionId)
      // A turn that used no skill, tool or list leaves the last account.
      if (
        account !== undefined &&
        (account.skills.size > 0 ||
          account.tools.size > 0 ||
          account.todo !== undefined)
      )
        this.#flush(account)
      else if (account?.timer !== undefined) clearTimeout(account.timer)
      return
    }
    const account = this.#account(input)
    if (account === undefined) return
    if (event.phase === 'start') {
      if (account.tools.has(event.toolName) || account.tools.size < MAX_NAMES)
        account.tools.set(
          event.toolName,
          (account.tools.get(event.toolName) ?? 0) + 1,
        )
      const target = event.args?.path
      if (
        event.toolName === 'read' &&
        typeof target === 'string' &&
        target.startsWith('skill://')
      ) {
        const name = target.slice('skill://'.length).split('/')[0] ?? ''
        if (name !== '' && account.skills.size < MAX_NAMES)
          account.skills.add(name)
      }
      for (const file of pathsOf(event.args))
        if (account.files.size < MAX_FILES) account.files.add(file)
      return
    }
    if (event.toolName !== 'todo' || event.isError) return
    const items = todoItems(event.details)
    if (items === undefined) return
    account.todo = items
    account.todoDirty = true
    if (account.timer === undefined)
      account.timer = setTimeout(() => {
        account.timer = undefined
        if (this.#turns.get(input.sessionId) === account) this.#flush(account)
      }, this.#options.debounceMs ?? WORK_ACTIVITY_DEBOUNCE_MS)
  }

  #flush(account: TurnAccount): void {
    if (account.timer !== undefined) {
      clearTimeout(account.timer)
      account.timer = undefined
    }
    const todo = account.todoDirty ? account.todo : undefined
    account.todoDirty = false
    void this.#options
      .call(
        'work.activity',
        {
          contextId: account.origin.contextId,
          taskId: account.origin.taskId,
          ...(todo === undefined ? {} : { todo }),
          context: {
            skills: [...account.skills],
            tools: [...account.tools].map(([name, count]) => ({ name, count })),
            files: [...account.files],
          },
        },
        { agent: account.agent },
      )
      .catch(() => {})
  }

  /** Drop every account and its timer (resident shutdown). */
  close(): void {
    for (const account of this.#turns.values())
      if (account.timer !== undefined) clearTimeout(account.timer)
    this.#turns.clear()
  }
}
