// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * A stand-in for `claude -p --input-format stream-json --output-format
 * stream-json`: answers each user line with the event sequence Claude Code
 * prints, so the resident's Claude Code channel can be tested without a model.
 *
 * Prompts: `fail` ends with an error result; `hang` waits for an interrupt
 * control request; `long` stops with `max_tokens`; anything else is echoed.
 */

import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const argv = process.argv.slice(2)
const log = process.env.QIANMO_FIXTURE_ARGV_LOG
if (log) appendFileSync(log, `${JSON.stringify(argv)}\n`)
const flag = (name: string) => {
  const index = argv.indexOf(name)
  return index === -1 ? undefined : argv[index + 1]
}
const session = flag('--session-id') ?? flag('--resume') ?? 'none'
const emit = (event: Record<string, unknown>) =>
  process.stdout.write(`${JSON.stringify({ ...event, session_id: session })}\n`)

let turn = 0
let hanging = false

createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line) as Record<string, unknown>
  if (message.type === 'control_request') {
    if (hanging) {
      hanging = false
      emit({
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        result: 'interrupted',
        usage: { input_tokens: 1, output_tokens: 0 },
      })
    }
    return
  }
  const content = (message.message as { content: { text: string }[] }).content
  const text = content.map(block => block.text).join('')
  turn += 1
  if (turn === 1)
    emit({ type: 'system', subtype: 'init', tools: ['Read'], model: 'fake' })
  if (text === 'hang') {
    hanging = true
    return
  }
  const tool = `tool-${turn}`
  emit({
    type: 'assistant',
    message: {
      id: `msg-${turn}-a`,
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: tool,
          name: 'Read',
          input: { file_path: 'README.md' },
        },
      ],
    },
  })
  emit({
    type: 'user',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: tool,
          content: 'ok',
          is_error: text === 'tool-error',
        },
      ],
    },
  })
  emit({
    type: 'assistant',
    message: {
      id: `msg-${turn}-b`,
      role: 'assistant',
      content: [{ type: 'text', text: `echo(${turn}): ${text}` }],
      stop_reason: text === 'long' ? 'max_tokens' : 'end_turn',
    },
  })
  emit({
    type: 'result',
    subtype: text === 'fail' ? 'error_during_execution' : 'success',
    is_error: text === 'fail',
    result: text === 'fail' ? 'upstream exploded' : `echo(${turn}): ${text}`,
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: 900,
      cache_creation_input_tokens: 20,
    },
  })
})
