// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * A stand-in for `codex app-server` over stdio. Enough of the v2 protocol for
 * the resident's Codex channel: initialize, thread start/resume, turn start,
 * item and token-usage notifications, turn completion, interrupt, and one
 * server-to-client approval request.
 *
 * Prompts: `fail` completes the turn as failed; `hang` waits for
 * `turn/interrupt`; `approve` asks for a file-change approval first and echoes
 * the decision; anything else is echoed after one command item.
 */

import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const log = process.env.QIANMO_FIXTURE_ARGV_LOG
if (log) appendFileSync(log, `${JSON.stringify(process.argv.slice(2))}\n`)
const send = (message: Record<string, unknown>) =>
  process.stdout.write(`${JSON.stringify(message)}\n`)

let thread = ''
let turns = 0
let total = 0
let hanging: string | undefined
const waiting = new Map<number, (result: Record<string, unknown>) => void>()
let serverSequence = 1000

function usage(): void {
  total += 1000
  send({
    method: 'thread/tokenUsage/updated',
    params: {
      threadId: thread,
      turnId: `turn-${turns}`,
      tokenUsage: {
        total: {
          totalTokens: total,
          inputTokens: total,
          cachedInputTokens: total - 100,
          cacheWriteInputTokens: 0,
          outputTokens: turns * 10,
          reasoningOutputTokens: 0,
        },
        last: {},
        modelContextWindow: null,
      },
    },
  })
}

function complete(turnId: string, status: string, error?: string): void {
  send({
    method: 'turn/completed',
    params: {
      threadId: thread,
      turn: {
        id: turnId,
        status,
        error: error === undefined ? null : { message: error },
        items: [],
      },
    },
  })
}

async function run(turnId: string, text: string): Promise<void> {
  send({ method: 'turn/started', params: { threadId: thread, turnId } })
  if (text === 'hang') {
    hanging = turnId
    return
  }
  let suffix = ''
  if (text === 'approve') {
    const id = ++serverSequence
    const decision = await new Promise<Record<string, unknown>>(resolve => {
      waiting.set(id, resolve)
      send({
        id,
        method: 'item/fileChange/requestApproval',
        params: {
          threadId: thread,
          turnId,
          itemId: 'patch-1',
          startedAtMs: Date.now(),
          grantRoot: '/etc',
        },
      })
    })
    suffix = ` decision=${String(decision.decision)}`
  }
  if (text === 'mcp') {
    // A tool call on an MCP server set to `prompt` (P32).
    const id = ++serverSequence
    const answer = await new Promise<Record<string, unknown>>(resolve => {
      waiting.set(id, resolve)
      send({
        id,
        method: 'mcpServer/elicitation/request',
        params: {
          threadId: thread,
          turnId,
          serverName: 'docs',
          mode: 'form',
          message: 'Allow docs to run search?',
          requestedSchema: { type: 'object', properties: {} },
          _meta: { codex_approval_kind: 'mcp_tool_call', tool_name: 'search' },
        },
      })
    })
    suffix = ` action=${String(answer.action)}`
  }
  const item = `cmd-${turns}`
  send({
    method: 'item/started',
    params: {
      threadId: thread,
      turnId,
      item: { type: 'commandExecution', id: item, command: 'ls' },
    },
  })
  send({
    method: 'item/completed',
    params: {
      threadId: thread,
      turnId,
      item: {
        type: 'commandExecution',
        id: item,
        command: 'ls',
        status: 'completed',
        exitCode: 0,
      },
    },
  })
  send({
    method: 'item/completed',
    params: {
      threadId: thread,
      turnId,
      item: {
        type: 'agentMessage',
        id: `answer-${turns}`,
        text: `codex(${turns}): ${text}${suffix}`,
      },
    },
  })
  usage()
  if (text === 'fail') complete(turnId, 'failed', 'model overloaded')
  else complete(turnId, 'completed')
}

createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line) as {
    id?: number
    method?: string
    params?: Record<string, unknown>
    result?: Record<string, unknown>
  }
  if (message.method === undefined && message.id !== undefined) {
    waiting.get(message.id)?.(message.result ?? {})
    waiting.delete(message.id)
    return
  }
  const params = message.params ?? {}
  switch (message.method) {
    case 'initialize':
      send({ id: message.id, result: { userAgent: 'fake-codex' } })
      return
    case 'initialized':
      return
    case 'thread/start':
      thread = `thread-${process.pid}`
      send({ id: message.id, result: { thread: { id: thread } } })
      return
    case 'thread/resume':
      if (params.threadId === 'missing') {
        send({
          id: message.id,
          error: { code: -32600, message: 'no rollout found' },
        })
        return
      }
      thread = String(params.threadId)
      send({ id: message.id, result: { thread: { id: thread } } })
      return
    case 'turn/start': {
      turns += 1
      const turnId = `turn-${turns}`
      send({ id: message.id, result: { turn: { id: turnId } } })
      const input = params.input as { text: string }[]
      void run(turnId, input.map(part => part.text).join(''))
      return
    }
    case 'turn/interrupt':
      send({ id: message.id, result: {} })
      if (hanging !== undefined) {
        complete(hanging, 'interrupted')
        hanging = undefined
      }
      return
    default:
      send({
        id: message.id,
        error: { code: -32601, message: `unknown ${message.method}` },
      })
  }
})
