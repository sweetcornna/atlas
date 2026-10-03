// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * A loopback OpenAI Responses endpoint that records every request body
 * verbatim, and the byte-level prefix comparison P18.19 judges them by
 * (design `providers-console-m1.md` §5.11.2, §5.11.7).
 *
 * ## The model double
 *
 * Every request is answered with a reasoning item (with `encrypted_content`,
 * which the client replays) and then either one Glob call — when the newest
 * input item is user text containing `USE_TOOL` and the request offers tools
 * — or a message `ack <n>`. `n` counts requests over the recorder's lifetime,
 * so every answer, reasoning id and call id is distinct.
 *
 * A request that names an earlier response in
 * `prompt_cache_options.comparison_response_id` gets a
 * `prompt_cache_diagnostics` object back on `response.completed`, the way
 * OpenAI answers one; its `cache_missed_tokens` is the request's own `n`, so
 * a test can tell which reply a stored object came from. The values mean
 * nothing else.
 *
 * A top-level field named in {@link ResponsesRecorder.reject} is refused with
 * OpenAI's 400 for an unsupported parameter.
 *
 * It is not a model and says nothing about what a provider caches; it shows
 * what this side sends, which is the half of a cache hit the node controls.
 */

export type RecordedRequest = {
  readonly seq: number
  readonly path: string
  readonly headers: Readonly<Record<string, string>>
  readonly body: Record<string, unknown>
  /** The HTTP status it was answered with. */
  readonly status: number
}

type Item = Record<string, unknown>

function textOf(item: Item | undefined): string {
  const content = item?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map(part =>
      part !== null && typeof part === 'object'
        ? String((part as Item).text ?? '')
        : '',
    )
    .join('')
}

function sse(events: readonly unknown[]): Response {
  return new Response(
    events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(''),
    { headers: { 'content-type': 'text/event-stream' } },
  )
}

export class ResponsesRecorder {
  readonly requests: RecordedRequest[] = []
  /** Top-level request fields to refuse with a 400 while set. */
  readonly reject = new Set<string>()
  readonly #server: ReturnType<typeof Bun.serve>

  constructor() {
    this.#server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: async req => {
        const url = new URL(req.url)
        if (req.method !== 'POST') return new Response('', { status: 404 })
        let body: Record<string, unknown> = {}
        try {
          body = (await req.json()) as Record<string, unknown>
        } catch {
          // recorded as an empty body
        }
        const headers: Record<string, string> = {}
        req.headers.forEach((value, key) => {
          headers[key] = key === 'authorization' ? '<redacted>' : value
        })
        const seq = this.requests.length + 1
        const refused = [...this.reject].find(field => field in body)
        const status = !url.pathname.endsWith('/responses')
          ? 404
          : refused !== undefined
            ? 400
            : 200
        this.requests.push({ seq, path: url.pathname, headers, body, status })
        if (status === 404) {
          return Response.json(
            { error: { message: 'recorder: only /responses' } },
            { status },
          )
        }
        if (refused !== undefined) {
          return Response.json(
            {
              error: {
                message: `Unsupported parameter: '${refused}' is not supported with this model.`,
                type: 'invalid_request_error',
                param: refused,
                code: 'unsupported_parameter',
              },
            },
            { status },
          )
        }
        return this.#answer(seq, body)
      },
    })
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.#server.port}/v1`
  }

  /** Main-loop requests (they carry the tool table), oldest first. */
  mainRequests(from = 0): RecordedRequest[] {
    return this.requests
      .slice(from)
      .filter(r => Array.isArray(r.body.tools) && r.body.tools.length >= 5)
  }

  async stop(): Promise<void> {
    await this.#server.stop(true)
  }

  #answer(n: number, body: Record<string, unknown>): Response {
    const input = Array.isArray(body.input) ? (body.input as Item[]) : []
    const last = input.at(-1)
    const wantsTool =
      last?.type !== 'function_call_output' &&
      textOf(last).includes('USE_TOOL') &&
      Array.isArray(body.tools) &&
      body.tools.length > 0
    const events: unknown[] = [
      {
        type: 'response.created',
        response: { id: `resp_${n}`, status: 'in_progress' },
      },
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
    if (wantsTool) {
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
      const message = {
        type: 'message',
        id: `msg_${n}`,
        role: 'assistant',
      }
      events.push(
        {
          type: 'response.output_item.added',
          output_index: 1,
          item: { ...message, content: [] },
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
            ...message,
            status: 'completed',
            content: [{ type: 'output_text', text: `ack ${n}` }],
          },
        },
      )
    }
    const options = body.prompt_cache_options as
      | Record<string, unknown>
      | undefined
    const compared = typeof options?.comparison_response_id === 'string'
    events.push({
      type: 'response.completed',
      response: {
        id: `resp_${n}`,
        status: 'completed',
        ...(compared && {
          prompt_cache_diagnostics: {
            type: 'cache_miss',
            reason: 'input_changed',
            comparison_reusable_tokens: 1000,
            cache_missed_tokens: n,
          },
        }),
        usage: {
          input_tokens: 1000,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens: 8,
          output_tokens_details: { reasoning_tokens: 4 },
        },
      },
    })
    return sse(events)
  }
}

/**
 * Request fields that change OpenAI's hidden prompt header or routing; a
 * change in any of them is a miss however identical the rest is.
 */
export const PREFIX_SETTINGS = [
  'model',
  'reasoning',
  'text',
  'parallel_tool_calls',
  'tool_choice',
  'include',
  'store',
  'prompt_cache_key',
  'max_output_tokens',
  'prompt_cache_retention',
  'prompt_cache_options',
  'service_tier',
] as const

function enc(value: unknown): string {
  return JSON.stringify(value ?? null)
}

function firstDiff(a: string, b: string): number {
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i
  return n
}

function around(text: string, at: number): string {
  return JSON.stringify(text.slice(Math.max(0, at - 60), at + 60))
}

/**
 * `null` when `cur` starts with everything `prev` sent, in the order the
 * prompt is rendered — settings, tools, instructions, then input items one
 * by one; otherwise where and how the two first differ.
 */
export function prefixDivergence(
  prev: Record<string, unknown>,
  cur: Record<string, unknown>,
): string | null {
  for (const key of PREFIX_SETTINGS) {
    if (enc(prev[key]) !== enc(cur[key])) {
      return `setting ${key}: ${enc(prev[key])} -> ${enc(cur[key])}`
    }
  }
  if (enc(prev.tools) !== enc(cur.tools)) return 'tools differ'
  const pi = String(prev.instructions ?? '')
  const ci = String(cur.instructions ?? '')
  if (pi !== ci) {
    const at = firstDiff(pi, ci)
    return `instructions differ at char ${at}: ${around(pi, at)} -> ${around(ci, at)}`
  }
  const pIn = Array.isArray(prev.input) ? prev.input : []
  const cIn = Array.isArray(cur.input) ? cur.input : []
  for (let i = 0; i < pIn.length; i++) {
    if (i >= cIn.length)
      return `input shrank from ${pIn.length} to ${cIn.length}`
    const a = enc(pIn[i])
    const b = enc(cIn[i])
    if (a !== b) {
      const at = firstDiff(a, b)
      return `input[${i}] differs at char ${at}: ${around(a, at)} -> ${around(b, at)}`
    }
  }
  return null
}
