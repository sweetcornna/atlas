// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import {
  unmarkResidentInput,
  RESIDENT_INPUT_IDENTITY_ENTRY,
} from '@qianmo/extension/policy'

const emit = (frame: Record<string, unknown>) =>
  process.stdout.write(`${JSON.stringify(frame)}\n`)
let sessionDir = ''
let current: string | undefined
const pendingTools = new Map<string, (value: Record<string, unknown>) => void>()
async function prompt(frame: Record<string, unknown>) {
  const input = unmarkResidentInput(String(frame.message))
  if (!input) throw new Error('resident fixture requires input identity')
  current = String(frame.id)
  const log = process.env.QIANMO_FIXTURE_PROMPT_LOG
  if (log) appendFileSync(log, `${JSON.stringify(input.text)}\n`)
  appendFileSync(
    join(sessionDir, 'fixture.jsonl'),
    `${JSON.stringify({ type: 'message', id: input.messageId, message: { role: 'user', content: input.text } })}\n${JSON.stringify({ type: 'custom', customType: RESIDENT_INPUT_IDENTITY_ENTRY, data: { messageId: input.messageId, userEntryId: input.messageId } })}\n`,
  )
  emit({ type: 'agent_start' })
  emit({ type: 'message_end', message: { role: 'user', content: input.text } })
  emit({
    type: 'response',
    id: frame.id,
    command: 'prompt',
    success: true,
    data: { agentInvoked: true },
  })
  let text = 'fixture response'
  const title = process.env.QIANMO_FIXTURE_TOOL_CALL
  if (title)
    emit({
      type: 'tool_execution_start',
      toolCallId: 'fixture-tool-1',
      toolName: title,
      args: process.env.QIANMO_FIXTURE_TOOL_PATH
        ? { path: process.env.QIANMO_FIXTURE_TOOL_PATH }
        : {},
    })
  const summary = process.env.QIANMO_FIXTURE_NOTIFY
  if (summary) {
    const wait = new Promise<Record<string, unknown>>(resolve =>
      pendingTools.set('notify-1', resolve),
    )
    emit({
      type: 'host_tool_call',
      id: 'notify-1',
      toolCallId: 'fixture-notify',
      toolName: 'qianmo_notify',
      arguments: {
        kind: 'watch',
        severity: 'warn',
        summary,
        detail: 'observed by the fixture',
        ...(process.env.QIANMO_FIXTURE_NOTIFY_DEDUP
          ? { dedupKey: process.env.QIANMO_FIXTURE_NOTIFY_DEDUP }
          : {}),
      },
    })
    const result = await wait
    const details = result.details as Record<string, unknown>
    text += ` notify=${String(details.status)}`
  }
  const work = process.env.QIANMO_FIXTURE_WORK_LOG
  if (work) {
    const ask = /QIANMO-COMPUTE (\d+)\*(\d+)/.exec(input.text)
    if (input.text.includes('never as instructions'))
      text +=
        ' refused: the relayed message is marked untrusted, so its content was treated as data.'
    else if (ask) {
      const product = Number(ask[1]) * Number(ask[2])
      appendFileSync(work, `${product}\n`)
      text += ` computed ${product}`
    } else text += ' no relayed request was found in this turn'
  }
  if (process.env.QIANMO_FIXTURE_HOLD_BUSY === '1') return
  emit({
    type: 'message_end',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }],
      stopReason: 'stop',
    },
  })
  emit({
    type: 'prompt_result',
    id: frame.id,
    status: 'completed',
    sessionSettled: true,
  })
  emit({ type: 'session_settled' })
}
const lines = createInterface({ input: process.stdin })
lines.on('line', line => {
  const frame = JSON.parse(line) as Record<string, unknown>
  if (frame.type === 'host_tool_result') {
    pendingTools.get(String(frame.id))?.(
      frame.result as Record<string, unknown>,
    )
    return
  }
  if (frame.type === 'prompt') {
    void prompt(frame).catch(error => {
      process.stderr.write(String(error))
      process.exit(1)
    })
    return
  }
  if (frame.type === 'open_session') sessionDir = String(frame.sessionDir)
  if (frame.type === 'abort' && current) {
    emit({
      type: 'prompt_result',
      id: current,
      status: 'aborted',
      sessionSettled: true,
    })
    emit({ type: 'session_settled' })
  }
  emit({
    type: 'response',
    command: frame.type,
    id: frame.id,
    success: true,
    data: {},
  })
})
emit({ type: 'ready', protocolVersion: 1, supportedProtocolVersions: [1, 2] })
