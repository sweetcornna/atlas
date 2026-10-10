// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  arg,
  emit,
  intArg,
  SessionManager,
  rememberSession,
  sessionDir,
  synthTurns,
} from './ac1-common.js'
async function write(label: string, count: number): Promise<string> {
  const manager = SessionManager.create(process.cwd(), sessionDir)
  for (const message of synthTurns(count)) manager.appendMessage(message)
  await manager.flush()
  rememberSession(label, manager.getSessionFile()!)
  return manager.getSessionId()
}
const sessions = intArg('sessions', 5)
const msgs = intArg('msgs', 40)
const targetMsgs = intArg('target-msgs', 40)
const label = arg('target') ?? crypto.randomUUID()
const started = performance.now()
for (let i = 0; i < sessions; i++) await write(crypto.randomUUID(), msgs)
const target = await write(label, targetMsgs)
emit({
  projectDir: sessionDir,
  target,
  requestedLabel: label,
  sessions,
  msgsPerSession: msgs,
  targetMsgs,
  elapsedMs: Math.round(performance.now() - started),
})
