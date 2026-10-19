// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Background task tools (P29, `runtimes-channels.md` §3), ported from
 * grantley's `tasks/`: a foreground conversation hands long work to a
 * background task (its own sub-session, or another agent) and stays
 * responsive; the task reports progress and completion. The hub keeps the task ledger and runs the worker loop;
 * these tools only forward to it (`tasks.*` hub calls) with the console
 * conversation and turn they were called from, which the hub checks.
 *
 * All seven tools are always offered, so the tool surface (and the prompt
 * prefix it is part of) never changes between turns; the hub decides from
 * the conversation whether the caller is a foreground or a worker.
 */

import type { ControlOutcome } from '@qianmo/protocol'
import type { HostToolDefinition } from './notifyTool.js'

export interface TaskToolOrigin {
  /** The console conversation (`contextId`) of the turn calling the tool. */
  readonly contextId: string
  /** That turn's task id. */
  readonly taskId: string
}

export interface TaskToolsOptions {
  readonly call: (
    op: string,
    args: Record<string, unknown>,
    options: { agent: string },
  ) => Promise<ControlOutcome>
  /** The running turn behind a tool call, or null when it has none. */
  readonly origin: (ctx: {
    readonly agent: string
    readonly sessionId: string
  }) => TaskToolOrigin | null
}

const string = { type: 'string' }
const integer = { type: 'integer' }

const specs = [
  {
    name: 'qianmo_task_start',
    op: 'start',
    description:
      "Foreground only. Keep this conversation free for the owner's next message: hand work to a background task and return at once with its task id; never wait for it here. Do it yourself when one or two steps finish it (an answer, a question back, one lookup, one simple tool call, reading one file). Start a task without agent, in your own sub-session, for anything that takes several steps or more than a minute or two: research, writing or changing code, long commands, trial and error. Simple but slow work with clear edges (bulk tidying, checking against a list, collecting material, waiting on a result to check it) may go to another agent: give agent, a qianmo://node/agent address from qianmo_task_agents, preferring idle and cheaper ones. Split independent parts into separate tasks that run in parallel. Give a short title and complete instructions (the task sees no more of this conversation than its last few messages). Leave out (or give null) every optional field you do not need: no agent runs it in your own sub-session, no after or at starts it now, no everyMinutes runs it once; 0 and empty strings count as left out. To run it later give after (minutes, 1-10080) or at (an ISO time with its zone, at most 7 days ahead), not both; to repeat it give everyMinutes (30-10080) with times (1-100). Plan this way what should be looked at again later or done periodically. A planned task waits as scheduled, runs in the same sub-session each time and its result comes back here after every run; at most 20 planned per owner. Tell the owner what you started or planned, and when it runs.",
    properties: {
      title: string,
      instructions: string,
      agent: {
        ...string,
        description:
          'Optional. Another agent, qianmo://node/agent; leave out for your own sub-session.',
      },
      after: {
        ...integer,
        description:
          'Optional. Minutes until the first run, 1-10080; leave out to start now.',
      },
      at: {
        ...string,
        description:
          'Optional. First run at this ISO time with its zone, at most 7 days ahead; leave out to start now.',
      },
      everyMinutes: {
        ...integer,
        description:
          'Optional. Repeat every this many minutes, 30-10080, with times; leave out to run once.',
      },
      times: {
        ...integer,
        description:
          'Optional. How many runs in all, 1-100, with everyMinutes; leave out to run once.',
      },
    },
    required: ['title', 'instructions'],
  },
  {
    name: 'qianmo_task_agents',
    op: 'agents',
    description:
      "Foreground only. List the agents you may hand a task to with qianmo_task_start's agent: address, name, runtime and model when known, whether it is you, and how busy it is — idle (nothing running on its node), turns in flight, background tasks queued and running. Check it before handing simple but slow work to another agent, and prefer idle and cheaper ones. Does not wait.",
    properties: {},
    required: [],
  },
  {
    name: 'qianmo_task_status',
    op: 'status',
    description:
      "Foreground only. Read this conversation's background tasks: real phase (a scheduled one with its next start and the runs left), last report, result. When the owner asks how things are going, report the real phase; only a completed task is done. When a task has completed, decide the next step yourself: start the next task or ask the owner. Does not wait.",
    properties: { id: string },
    required: [],
  },
  {
    name: 'qianmo_task_send',
    op: 'send',
    description:
      'Foreground only. Pass an extra instruction from the owner to one of this conversation’s background tasks. A task running now reads it at its next step where its runtime allows (delivery live), otherwise at its next turn (next_turn); a task waiting for input resumes in the same sub-session, a scheduled one reads it when its next run starts. A new message from the owner cancels no task.',
    properties: { id: string, message: string },
    required: ['id', 'message'],
  },
  {
    name: 'qianmo_task_cancel',
    op: 'cancel',
    description:
      "Foreground only. Stop one of this conversation's background tasks; a scheduled one is cancelled with all its remaining runs.",
    properties: { id: string },
    required: ['id'],
  },
  {
    name: 'qianmo_task_report',
    op: 'report',
    description:
      "Background task only. Save this task's real progress (state working), its verified final result (state completed), or the one question you need answered (state needs_input). Only an explicit completed report finishes the task. The answer's newUpdates counts user instructions you have not read yet; read them with qianmo_task_updates.",
    properties: {
      summary: string,
      state: { type: 'string', enum: ['working', 'completed', 'needs_input'] },
    },
    required: ['summary', 'state'],
  },
  {
    name: 'qianmo_task_updates',
    op: 'updates',
    description:
      'Background task only. Read the user’s new instructions for this task. Call it before starting, before key actions and between phases.',
    properties: {},
    required: [],
  },
] as const

/**
 * What to do when the hub did not answer. A background task may not read status,
 * and both of its calls are safe to repeat: a report overwrites the
 * checkpoint, unconfirmed instructions are returned again.
 */
const UNANSWERED: Readonly<Record<string, string>> = {
  report:
    'The task service did not answer; the report may not be saved. Call qianmo_task_report again with the same content: reporting twice is harmless.',
  updates:
    'The task service did not answer. Call qianmo_task_updates again: instructions you have not confirmed in a report are returned again.',
}

export function taskTools(options: TaskToolsOptions): HostToolDefinition[] {
  return specs.map(spec => ({
    name: spec.name,
    description: spec.description,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: spec.properties,
      required: [...spec.required],
    },
    async handler(raw, ctx) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        return { ok: false, text: 'Invalid arguments.' }
      const params = raw as Record<string, unknown>
      if (
        Object.keys(params).some(key => !Object.hasOwn(spec.properties, key)) ||
        spec.required.some(key => typeof params[key] !== 'string')
      )
        return { ok: false, text: 'Invalid arguments.' }
      const origin = options.origin(ctx)
      if (origin === null)
        return {
          ok: false,
          text: 'Background tasks are only available in a console or chat-channel conversation.',
        }
      try {
        const result = await options.call(
          `tasks.${spec.op}`,
          { ...params, contextId: origin.contextId, taskId: origin.taskId },
          { agent: ctx.agent },
        )
        return {
          ok: result.ok,
          text: JSON.stringify(
            result.ok ? result.value : { error: result.message },
          ),
          details: result,
        }
      } catch {
        return {
          ok: false,
          text:
            UNANSWERED[spec.op] ??
            'The task service did not answer; the outcome is unknown. Check with qianmo_task_status before retrying.',
        }
      }
    },
  }))
}
