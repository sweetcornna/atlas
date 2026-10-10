// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { NOTIFY_KINDS, NOTIFY_SEVERITIES } from '@qianmo/protocol'
import { MEMORY_EVIDENCE_TOOL } from '@qianmo/recall'
import { MEMORY_WRITE_TOOL } from './residentMemoryWrite.js'
import type { QianmoNotifyVerdict } from './notifyWire.js'
export const QIANMO_NOTIFY_TOOL_NAME = 'qianmo_notify'
const DESCRIPTION =
  'Send one short notification to the operator who runs this node. Use it only when a human needs to know something now; routine findings belong in the answer to the task, which is recorded either way.'

const PROMPT = `Announce something to the human operating this node.

This is the ONLY way anything you do reaches a person directly. Everything else
you produce is recorded and can be read later, but nobody is paged for it — that
silence is the intended default for an unattended run, not a limitation to work
around.

Send one when, and only when:
- a watch job found the condition it was watching for;
- something you were asked to keep running has stopped, or is about to;
- you cannot finish the task and waiting will make it worse.

Do not send one to report that a task finished normally, to acknowledge an
instruction, or to repeat something you already announced this run — the node
enforces a hard ceiling of ${'`'}notifyRatePerMinute${'`'} announcements a minute and
anything past it waits.

Keep ${'`'}summary${'`'} to a single line someone can act on without opening anything.
Put the evidence in ${'`'}detail${'`'}. Set ${'`'}dedupKey${'`'} to a stable string for a recurring
condition, and the node will suppress repeats of it that are still undelivered.

The result tells you what actually happened to it. "queued" means the operator's
console is unreachable right now and the node is holding the notification for
it — that is normal and needs nothing from you; do not send it again.`

/** Text the model reads back. Each status says what it means for the turn. */
export function verdictText(verdict: QianmoNotifyVerdict): string {
  switch (verdict.status) {
    case 'sent':
      return 'Notification sent to the operator.'
    case 'queued':
      return verdict.retryAfterMs === undefined
        ? 'Notification recorded. The operator console is not reachable right now; the node will deliver it when the console comes back. Do not send it again.'
        : `Notification recorded but held: this node is at its notification ceiling for the current minute. A slot opens in about ${Math.ceil(
            verdict.retryAfterMs / 1000,
          )}s and the node will deliver it then. Do not send it again.`
    case 'unsupported':
      return 'Not sent: the operator console does not support notifications (older protocol version). Put what you wanted to say in your answer instead.'
    case 'duplicate':
      return 'Not sent: a notification with the same dedupKey is still waiting to be delivered.'
    case 'rejected':
      return `Not sent: ${verdict.detail ?? 'the node refused it'}.`
  }
}

/** Host notification tool; citation and approved memory writing share this surface. */
export function residentToolSurface(memoryWrite = false) {
  return [
    ...(memoryWrite ? [MEMORY_WRITE_TOOL] : []),
    {
      name: MEMORY_EVIDENCE_TOOL.name,
      description: MEMORY_EVIDENCE_TOOL.description,
      loadMode: 'essential' as const,
      parameters: MEMORY_EVIDENCE_TOOL.inputSchema,
    },
    {
      name: QIANMO_NOTIFY_TOOL_NAME,
      description: `${DESCRIPTION}\n\n${PROMPT}`,
      loadMode: 'essential' as const,
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', enum: [...NOTIFY_KINDS] },
          severity: { type: 'string', enum: [...NOTIFY_SEVERITIES] },
          summary: { type: 'string', minLength: 1 },
          detail: { type: 'string' },
          dedupKey: { type: 'string' },
        },
        required: ['kind', 'severity', 'summary'],
      },
    },
  ]
}
