// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Background task tools (P29, `runtimes-channels.md` §3), ported from
 * grantley's `tasks/`: a foreground conversation hands long work to a
 * background sub-agent and stays responsive; the sub-agent reports progress
 * and completion. The hub keeps the task ledger and runs the worker loop;
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

const specs = [
  {
    name: 'qianmo_task_start',
    op: 'start',
    description:
      'Foreground only. Start a persistent background sub-agent for work that needs tools, research, several steps or a long time, and return at once with its task id; do not wait for it. Give a short title and complete instructions (the sub-agent does not see this conversation beyond its last few messages). Optional agent: a qianmo://node/agent address to run it on another agent (another runtime or model); default is yourself.',
    properties: { title: string, instructions: string, agent: string },
    required: ['title', 'instructions'],
  },
  {
    name: 'qianmo_task_agents',
    op: 'agents',
    description:
      "Foreground only. List the agents you may hand a task to (qianmo_task_start's agent): address, name, runtime and model when known, whether it is you, and how busy it is — idle (nothing running on its node), turns in flight, background tasks queued and running. Does not wait.",
    properties: {},
    required: [],
  },
  {
    name: 'qianmo_task_status',
    op: 'status',
    description:
      "Foreground only. Read this conversation's background tasks: real phase, last report, result. Does not wait.",
    properties: { id: string },
    required: [],
  },
  {
    name: 'qianmo_task_send',
    op: 'send',
    description:
      'Foreground only. Pass an extra instruction from the user to one of this conversation’s background tasks; a task waiting for input resumes in the same sub-session.',
    properties: { id: string, message: string },
    required: ['id', 'message'],
  },
  {
    name: 'qianmo_task_cancel',
    op: 'cancel',
    description:
      "Foreground only. Stop one of this conversation's background tasks.",
    properties: { id: string },
    required: ['id'],
  },
  {
    name: 'qianmo_task_report',
    op: 'report',
    description:
      "Background sub-agent only. Save this task's real progress (state working), its verified final result (state completed), or the one question you need answered (state needs_input). Only an explicit completed report finishes the task. The answer's newUpdates counts user instructions you have not read yet; read them with qianmo_task_updates.",
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
      'Background sub-agent only. Read the user’s new instructions for this task. Call it before starting, before key actions and between phases.',
    properties: {},
    required: [],
  },
] as const

/**
 * What to do when the hub did not answer. A sub-agent may not read status,
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
