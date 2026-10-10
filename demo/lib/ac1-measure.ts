// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  arg,
  emit,
  SessionManager,
  sessionDir,
  sessionFile,
} from './ac1-common.js'
const entry = arg('entry') ?? 'resume'
const label = arg('session')
if (entry === 'resume' && !label)
  throw new Error('--entry resume requires --session <label>')
const started = performance.now()
const manager =
  entry === 'continue'
    ? await SessionManager.continueRecent(process.cwd(), sessionDir)
    : await SessionManager.open(sessionFile(label!), sessionDir, undefined, {
        throwIfMissing: true,
      })
const messages = manager.buildSessionContext().messages
emit({
  entry,
  requestedSession: label ?? null,
  loadMs: Math.round(performance.now() - started),
  sinceProcessStartMs: Math.round(performance.now()),
  sessionId: manager.getSessionId(),
  messageCount: messages.length,
  found: messages.length > 0,
})
