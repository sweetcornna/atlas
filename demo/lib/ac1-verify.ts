// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from 'node:fs'
import {
  arg,
  emit,
  SessionManager,
  sessionDir,
  sessionFile,
} from './ac1-common.js'
const label = arg('session')
if (!label) throw new Error('--session <label> required')
const file = sessionFile(label)
const raw = readFileSync(file, 'utf8')
const lines = raw.split('\n').filter(Boolean)
let malformedLines = 0
for (const line of lines) {
  try {
    JSON.parse(line)
  } catch {
    malformedLines++
  }
}
const manager = await SessionManager.open(file, sessionDir, undefined, {
  throwIfMissing: true,
})
const messages = manager.buildSessionContext().messages
const calls = new Set<string>()
const results = new Set<string>()
for (const message of messages) {
  if (message.role === 'toolResult') results.add(message.toolCallId)
  if (message.role === 'assistant')
    for (const part of message.content) {
      if (part.type === 'toolCall') calls.add(part.id)
    }
}
emit({
  sessionId: manager.getSessionId(),
  sessionFile: file,
  found: messages.length > 0,
  messageCount: messages.length,
  rawLines: lines.length,
  rawBytes: Buffer.byteLength(raw),
  malformedLines,
  rawToolUse: lines.filter(line => line.includes('"type":"toolCall"')).length,
  rawToolResult: lines.filter(line => line.includes('"role":"toolResult"'))
    .length,
  loadedToolUse: calls.size,
  danglingToolUse: [...calls].filter(id => !results.has(id)).length,
})
