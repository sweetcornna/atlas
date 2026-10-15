// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  QIANMO_NOTIFY_TOOL_NAME,
  verdictText,
  type HostToolDefinition,
} from './notifyTool.js'
import { parseNotifyVerdict } from './notifyWire.js'

/** The host-side handlers every runtime's `qianmo_*` tools reach. */
export interface HostToolDispatchOptions {
  readonly extraHostTools?: readonly HostToolDefinition[]
  readonly memoryWrite?: (
    sessionId: string,
    args: unknown,
  ) => Promise<{ ok: boolean; text: string }>
  readonly memoryAnswer?: (
    sessionId: string,
    args: unknown,
  ) => { ok: boolean; text: string }
  readonly announce: (
    params: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>
}

export interface HostToolOutcome {
  readonly isError: boolean
  readonly text: string
  readonly details?: unknown
}

/**
 * One host tool call, the same for a qianmopi child (`host_tool_call`) and an
 * external runtime (`qm runtime-mcp`). The caller resolves the session's agent
 * from its own records, never from the call.
 */
export async function dispatchHostTool(
  options: HostToolDispatchOptions,
  ctx: { readonly agent: string; readonly sessionId: string },
  toolName: string,
  args: unknown,
): Promise<HostToolOutcome> {
  const extra = options.extraHostTools?.find(tool => tool.name === toolName)
  if (extra) {
    const result = await extra.handler(args, ctx)
    return {
      isError: !result.ok,
      text: result.text,
      ...(result.details === undefined ? {} : { details: result.details }),
    }
  }
  if (toolName === 'qianmo_memory_write') {
    const result = (await options.memoryWrite?.(ctx.sessionId, args)) ?? {
      ok: false,
      text: 'Memory writer is not enabled',
    }
    return { isError: !result.ok, text: result.text }
  }
  if (toolName === 'qianmo_memory_answer') {
    const answer = options.memoryAnswer?.(ctx.sessionId, args) ?? {
      ok: false,
      text: 'Memory answer host unavailable',
    }
    return { isError: !answer.ok, text: answer.text }
  }
  const verdict =
    toolName === QIANMO_NOTIFY_TOOL_NAME
      ? parseNotifyVerdict(
          await options.announce({
            ...(args && typeof args === 'object'
              ? (args as Record<string, unknown>)
              : {}),
            sessionId: ctx.sessionId,
          }),
        )
      : { status: 'rejected' as const, detail: 'unknown resident host tool' }
  return { isError: false, text: verdictText(verdict), details: verdict }
}
