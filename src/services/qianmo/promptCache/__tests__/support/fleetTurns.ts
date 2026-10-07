// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Turns of a fleet-shaped conversation for the P18.21 (CH-8) suites: the
 * replies the fleet's `/responses` endpoint streams (a reasoning item with
 * `encrypted_content`, then text or one tool call, then `response.completed`
 * with an id and usage), and the history messages around them.
 *
 * Fed to the REAL `queryModelOpenAI` through the P18.5 recording stub
 * (`modelCompat/__tests__/support/requestCapture.ts`).
 */
import type { Message } from 'src/types/message.js'

export const GATEWAY = 'https://gateway.example/v1'

/** The fleet's settings (design §5.11.2). */
export const FLEET_ENV = {
  OPENAI_WIRE_API: 'responses',
  CLAUDE_CODE_EFFORT_LEVEL: 'max',
  CLAUDE_CODE_ALWAYS_ENABLE_EFFORT: '1',
} as const

/** A two-part system prompt; the lane joins it into `instructions`. */
export const SYSTEM = ['You are a node agent.', 'Workspace status: (clean)']

function sse(events: readonly unknown[]): string {
  return events.map(e => `data: ${JSON.stringify(e)}\n\n`).join('')
}

/** Reply `n`: reasoning, then `ack <n>` or one Glob call `call_<n>`. */
export function fleetReply(n: number, kind: 'text' | 'tool'): string {
  const events: unknown[] = [
    { type: 'response.created', response: { id: `resp_${n}` } },
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: { type: 'reasoning', id: `rs_${n}` },
    },
    {
      type: 'response.output_item.done',
      output_index: 0,
      item: {
        type: 'reasoning',
        id: `rs_${n}`,
        encrypted_content: `ENC-${n}`,
        summary: [{ type: 'summary_text', text: `thinking ${n}` }],
      },
    },
  ]
  if (kind === 'tool') {
    const call = {
      type: 'function_call',
      id: `fc_${n}`,
      call_id: `call_${n}`,
      name: 'Glob',
      arguments: '{"pattern":"*.md"}',
    }
    events.push(
      {
        type: 'response.output_item.added',
        output_index: 1,
        item: { ...call, arguments: '' },
      },
      {
        type: 'response.function_call_arguments.delta',
        output_index: 1,
        item_id: call.id,
        delta: call.arguments,
      },
      {
        type: 'response.output_item.done',
        output_index: 1,
        item: { ...call, status: 'completed' },
      },
    )
  } else {
    events.push(
      {
        type: 'response.output_item.added',
        output_index: 1,
        item: {
          type: 'message',
          id: `msg_${n}`,
          role: 'assistant',
          content: [],
        },
      },
      {
        type: 'response.output_text.delta',
        output_index: 1,
        content_index: 0,
        delta: `ack ${n}`,
      },
      {
        type: 'response.output_item.done',
        output_index: 1,
        item: {
          type: 'message',
          id: `msg_${n}`,
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: `ack ${n}` }],
        },
      },
    )
  }
  events.push({
    type: 'response.completed',
    response: {
      id: `resp_${n}`,
      status: 'completed',
      usage: {
        input_tokens: 1000,
        input_tokens_details: { cached_tokens: 512 },
        output_tokens: 8,
        output_tokens_details: { reasoning_tokens: 4 },
      },
    },
  })
  return sse(events)
}

export function userText(uuid: string, text: string): Message {
  return {
    type: 'user',
    uuid,
    message: { role: 'user', content: text },
  } as unknown as Message
}

export function toolResult(uuid: string, callId: string): Message {
  return {
    type: 'user',
    uuid,
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: callId, content: 'a.md' }],
    },
  } as unknown as Message
}

/**
 * A yielded message with the values that are random per run (`uuid`,
 * `timestamp`, `message.id`) replaced by placeholders, every key in place.
 */
export function messageShape(output: unknown): Record<string, unknown> {
  const copy = JSON.parse(JSON.stringify(output)) as Record<string, unknown>
  if ('uuid' in copy) copy.uuid = '<uuid>'
  if ('timestamp' in copy) copy.timestamp = '<timestamp>'
  const inner = copy.message as Record<string, unknown> | undefined
  if (inner !== undefined && 'id' in inner) inner.id = '<message-id>'
  return copy
}
