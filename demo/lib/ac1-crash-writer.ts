// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Append synchronously through omp, then SIGKILL before async durability confirmation.
 * `snapshot` tests an omp custom entry, not the removed occ file-history snapshot. */
import { writeFileSync } from 'node:fs'
import {
  arg,
  SessionManager,
  rememberSession,
  sessionDir,
  synthTurns,
  toolUseTurn,
} from './ac1-common.js'
const point = arg('point') ?? 'write'
const label = arg('session') ?? crypto.randomUUID()
const manager = SessionManager.create(process.cwd(), sessionDir)
for (const message of synthTurns(4, 64)) manager.appendMessage(message)
await manager.flush()
rememberSession(label, manager.getSessionFile()!)
if (point === 'tool') manager.appendMessage(toolUseTurn('ac1-crash-tool'))
else if (point === 'snapshot')
  manager.appendCustomEntry('qianmo:ac1-checkpoint', { stage: 'crash' })
else for (const message of synthTurns(2, 64, 4)) manager.appendMessage(message)
const note = {
  point,
  sessionId: manager.getSessionId(),
  sessionFile: manager.getSessionFile(),
  pid: process.pid,
}
if (arg('out')) writeFileSync(arg('out')!, JSON.stringify(note))
if (point === 'tool') await new Promise(() => {})
else process.kill(process.pid, 'SIGKILL')
