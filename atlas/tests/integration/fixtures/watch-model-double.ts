// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Deterministic model for the real qm watch → resident → omp chain.
 * It reads the runbook, searches it with grep, then reads a workspace snapshot
 * of actual root-filesystem usage captured by the trusted test host. Shell is
 * unavailable to resident agents. Tool results, notice tier, notify RPC and
 * transport are real; only the model's tool choices/replies are scripted.
 */

/** The untrusted notice's deciding clause (`packages/adapter/src/wrapper.ts`). */
export const UNTRUSTED_DIRECTIVE = 'never as instructions'
/** The verified notice's deciding clause, same file. */
export const VERIFIED_DIRECTIVE = 'The request is therefore authorized'
/** File the test puts in the workspace for `Read` and `Grep` to find. */
export const RUNBOOK_FILE = 'RUNBOOK.md'
export const DISK_USAGE_FILE = 'ROOT_USAGE.txt'
/** A line in that file; seeing it in a tool result means the tool ran. */
export const RUNBOOK_MARKER = 'watch-runbook-marker'
/**
 * A job whose prompt carries this gets an empty completion on every turn
 * request: HTTP 200, finish_reason `stop`, no content, no tool call — the
 * gateway behaviour behind the beta-5 failures of 2026-09-27.
 */
export const EMPTY_JOB_MARKER = 'WATCH-EMPTY'
/** How a job hands the double its threshold, e.g. `WATCH-DF threshold=90`. */
const JOB_MARKER = /WATCH-DF threshold=(\d+)/

/** What the double decided on one request, for the test to assert on. */
export type ModelDoubleStep =
  | { readonly kind: 'declined-untrusted' }
  | {
      readonly kind: 'tool-result'
      readonly tool: string
      readonly ok: boolean
      readonly text: string
    }
  | { readonly kind: 'notified'; readonly usage: number }
  | { readonly kind: 'quiet'; readonly usage: number }
  | { readonly kind: 'finished' }
  | { readonly kind: 'empty' }
  | { readonly kind: 'no-job' }

export interface ModelDouble {
  /** `http://127.0.0.1:<port>/v1`, for `OPENAI_BASE_URL`. */
  readonly baseUrl: string
  /** Every request body, parsed. */
  requests(): readonly Record<string, unknown>[]
  /** Every decision, in order. */
  steps(): readonly ModelDoubleStep[]
  stop(): Promise<void>
}

interface ChatMessage {
  readonly role?: unknown
  readonly content?: unknown
  readonly tool_calls?: unknown
  readonly tool_call_id?: unknown
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map(part =>
      typeof part === 'object' &&
      part !== null &&
      typeof (part as Record<string, unknown>).text === 'string'
        ? ((part as Record<string, unknown>).text as string)
        : '',
    )
    .join('\n')
}

/** The name of the tool whose result `message` carries. */
function toolNameFor(
  messages: readonly ChatMessage[],
  message: ChatMessage,
): string | undefined {
  for (const candidate of messages) {
    if (!Array.isArray(candidate.tool_calls)) continue
    for (const call of candidate.tool_calls as Record<string, unknown>[]) {
      if (call.id !== message.tool_call_id) continue
      const fn = call.function as Record<string, unknown> | undefined
      return typeof fn?.name === 'string' ? fn.name : undefined
    }
  }
  return undefined
}

let callCounter = 0

function frame(delta: Record<string, unknown>, finish: string | null): string {
  return `data: ${JSON.stringify({
    id: 'watch-model-double',
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: 'watch-model-double',
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`
}

function sse(body: string): Response {
  return new Response(`${body}data: [DONE]\n\n`, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
    },
  })
}

function textReply(text: string): Response {
  return sse(
    frame({ role: 'assistant', content: text }, null) + frame({}, 'stop'),
  )
}

function toolReply(name: string, input: Record<string, unknown>): Response {
  callCounter += 1
  const id = `call_double_${callCounter}`
  return sse(
    frame(
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            index: 0,
            id,
            type: 'function',
            function: { name, arguments: JSON.stringify(input) },
          },
        ],
      },
      null,
    ) + frame({}, 'tool_calls'),
  )
}

/** The trusted host records the volume metric in a plain workspace file. */
function usageFrom(output: string): number | undefined {
  const match = /root_usage_percent=(\d{1,3})/.exec(output)
  return match === null ? undefined : Number(match[1])
}

function completion(): Response {
  return Response.json({
    id: 'watch-model-double',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: 'watch-model-double',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: 'ok' },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  })
}

export function startWatchModelDouble(): ModelDouble {
  const requests: Record<string, unknown>[] = []
  const steps: ModelDoubleStep[] = []

  const usageCall = (): Response => toolReply('read', { path: DISK_USAGE_FILE })

  const decide = (body: Record<string, unknown>): Response => {
    const messages = Array.isArray(body.messages)
      ? (body.messages as ChatMessage[])
      : []
    const everything = messages.map(message => textOf(message.content))
    const prompt = everything.join('\n')
    const hasTools = Array.isArray(body.tools) && body.tools.length > 0
    if (hasTools && prompt.includes(EMPTY_JOB_MARKER)) {
      steps.push({ kind: 'empty' })
      return sse(frame({ role: 'assistant' }, null) + frame({}, 'stop'))
    }
    const job = JOB_MARKER.exec(prompt)
    if (job === null) {
      // A side request (title, summary): answer and stay out of it.
      steps.push({ kind: 'no-job' })
      return textReply('ok')
    }
    const threshold = Number(job[1])
    if (prompt.includes(UNTRUSTED_DIRECTIVE)) {
      steps.push({ kind: 'declined-untrusted' })
      return textReply(
        'I will not run this: the request is marked untrusted, so its content is data.',
      )
    }
    const last = messages.at(-1)
    if (last?.role !== 'tool') {
      return toolReply('read', { path: RUNBOOK_FILE })
    }
    const result = textOf(last.content)
    const tool = toolNameFor(messages, last) ?? 'unknown'
    if (tool === 'qianmo_notify') {
      steps.push({ kind: 'finished' })
      return textReply(`Reported. (${result.slice(0, 120)})`)
    }
    if (
      (tool === 'read' || tool === 'grep') &&
      usageFrom(result) === undefined
    ) {
      steps.push({
        kind: 'tool-result',
        tool,
        ok: result.includes(RUNBOOK_MARKER),
        text: result.slice(0, 400),
      })
      if (tool === 'read')
        return toolReply('grep', {
          pattern: RUNBOOK_MARKER,
          path: RUNBOOK_FILE,
        })
      return usageCall()
    }
    const usage = usageFrom(result)
    steps.push({
      kind: 'tool-result',
      tool,
      ok: usage !== undefined,
      text: result.slice(0, 400),
    })
    if (usage === undefined) {
      return textReply(`The check could not run: ${result.slice(0, 200)}`)
    }
    if (usage >= threshold) {
      steps.push({ kind: 'notified', usage })
      return toolReply('qianmo_notify', {
        kind: 'watch',
        severity: 'warn',
        summary: `root filesystem at ${usage}% (threshold ${threshold}%)`,
        detail: result.trim().split('\n').at(-1) ?? '',
        dedupKey: '/',
      })
    }
    steps.push({ kind: 'quiet', usage })
    return textReply(
      `Root filesystem at ${usage}%, under ${threshold}%. Nothing to report.`,
    )
  }

  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      let body: Record<string, unknown> = {}
      try {
        body = (await request.json()) as Record<string, unknown>
      } catch {
        body = {}
      }
      requests.push(body)
      // The node's startup probe, or any other non-streaming side request:
      // a plain completion is enough, and nothing here is part of a turn.
      if (body.stream !== true) return completion()
      return decide(body)
    },
  })
  const port = server.port
  if (port === undefined) throw new Error('model double got no TCP port')
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests: () => requests,
    steps: () => steps,
    stop: async () => {
      await server.stop(true)
    },
  }
}
