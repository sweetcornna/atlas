// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * ACP tool calls in the node's permission vocabulary (`residentToolVerdict`):
 * the mapping by ACP `kind` and `locations` every harness falls back to, and
 * the entry point the channel and the pool use. Harness modules build their
 * own mappings on top of it, so it depends on nothing but the catalog types.
 */

import type { AcpRuntime, AcpToolCall, AcpVerdictCall } from './acpSpec.js'

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function firstPath(...values: unknown[]): string | undefined {
  return values.find(
    (value): value is string => typeof value === 'string' && value !== '',
  )
}

/**
 * A tool call by its ACP `kind` and `locations`, for harnesses without a
 * mapping of their own. What it cannot place keeps its title, which the
 * node's verdict refuses as a tool it does not know.
 */
export function genericAcpToolCall(call: AcpToolCall): AcpVerdictCall[] {
  const raw = call.rawInput
  const path = firstPath(
    call.paths[0],
    raw.file_path,
    raw.filePath,
    raw.absolute_path,
    raw.path,
  )
  if (call.title.startsWith('mcp__'))
    return [{ toolName: call.title, input: { ...raw } }]
  switch (call.kind) {
    case 'execute':
      return [
        {
          toolName: 'bash',
          input: { ...raw, command: text(raw.command) ?? call.title },
        },
      ]
    case 'edit':
    case 'delete':
    case 'move': {
      const targets =
        call.paths.length > 0 ? call.paths : path === undefined ? [] : [path]
      // No target: the verdict cannot tell what it would change and refuses.
      if (targets.length === 0) return [{ toolName: 'edit', input: { ...raw } }]
      return targets.map(target => ({
        toolName: 'edit',
        input: { ...raw, path: target },
      }))
    }
    case 'read':
      return path === undefined
        ? [{ toolName: `read:${call.title}`, input: { ...raw } }]
        : [{ toolName: 'read', input: { path } }]
    case 'search':
      return [{ toolName: 'grep', input: { path: path ?? '.' } }]
    case 'think':
      return [{ toolName: 'todo', input: {} }]
    case 'fetch':
      return [{ toolName: 'fetch', input: { ...raw } }]
    default:
      return [{ toolName: call.title, input: { ...raw } }]
  }
}

/** `call` in the node's vocabulary, by the harness's own mapping if it has one. */
export function acpVerdictCalls(
  runtime: AcpRuntime,
  call: AcpToolCall,
): readonly AcpVerdictCall[] {
  return (runtime.toolCall ?? genericAcpToolCall)(call)
}
