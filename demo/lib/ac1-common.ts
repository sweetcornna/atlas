// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/** AC-1 uses omp's real SessionManager, in an explicitly isolated config root. */
import type { AssistantMessage, Message } from '@oh-my-pi/pi-ai'
import { ompChildEnv, qianmoConfigPath } from '@qianmo/paths'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
export { arg, emit, intArg } from './cli-args.js'

if (!process.env.QIANMO_CONFIG_DIR) {
  throw new Error('AC-1 requires an isolated QIANMO_CONFIG_DIR')
}
Object.assign(process.env, ompChildEnv(process.env))
export const { SessionManager } = await import(
  '@oh-my-pi/pi-coding-agent/session/session-manager'
)
export const sessionDir = qianmoConfigPath('acceptance', 'ac1', 'sessions')
mkdirSync(sessionDir, { recursive: true })

/** Caller labels locate sessions; the report always exposes omp's actual session ID. */
export function rememberSession(label: string, file: string): void {
  if (!/^[a-zA-Z0-9-]+$/.test(label)) throw new Error('Invalid session label')
  writeFileSync(join(sessionDir, `${label}.path`), file)
}
export function sessionFile(label: string): string {
  if (!/^[a-zA-Z0-9-]+$/.test(label)) throw new Error('Invalid session label')
  return readFileSync(join(sessionDir, `${label}.path`), 'utf8')
}
function assistant(content: AssistantMessage['content']): AssistantMessage {
  return {
    role: 'assistant',
    content,
    api: 'openai-completions',
    provider: 'ac1-fixture',
    model: 'synthetic',
    timestamp: Date.now(),
    stopReason: 'stop',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  }
}
export function synthTurns(
  count: number,
  fillerBytes = 512,
  startIndex = 0,
): Message[] {
  return Array.from({ length: count }, (_, i) => {
    const n = startIndex + i
    const text = `${n % 2 === 0 ? 'turn' : 'reply'} ${n} ${'x'.repeat(fillerBytes)}`
    return n % 2 === 0
      ? { role: 'user', content: text, timestamp: Date.now() }
      : assistant([{ type: 'text', text }])
  })
}
export function toolUseTurn(id: string): Message {
  return assistant([
    { type: 'toolCall', id, name: 'bash', arguments: { command: 'sleep 30' } },
  ])
}
