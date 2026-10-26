// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The shapes the runner speaks (qmo-local.md §4.5.1, §4.5.2, §4.3.6) and the
 * checks it makes on every request. The shell checks the same things first;
 * the runner checks again, since it cannot trust the other end of the pipe.
 */

import { isMode, type Mode } from './modes.js'

/** The codes a refusal carries; the shell shows them as `qmo local <code>: …`. */
export type CodeErrorCode =
  | 'E_ARGS'
  | 'E_RUNNER'
  | 'E_FOLDER'
  | 'E_AGENT'
  | 'E_SESSION'
  | 'E_BUSY'
  | 'E_LIMIT'
  | 'E_ASK'
  | 'E_GIT'
  | 'E_REMOTE'

export class CodeError extends Error {
  readonly code: CodeErrorCode

  constructor(code: CodeErrorCode, message: string) {
    super(message)
    this.name = 'CodeError'
    this.code = code
  }
}

/** What this runner drives; the page offers only agents whose protocol is here. */
export const FEATURES = {
  protocols: ['claude-stream', 'codex-app-server', 'acp'],
  worktree: true,
  remote: true,
} as const

/** The runtime catalog's six ids, the only ones a page may name. */
export const AGENT_IDS = [
  'claude-code',
  'codex',
  'gemini',
  'qwen',
  'opencode',
  'dsh',
] as const

/** A picked folder; `path` is for showing only. */
export interface Folder {
  readonly id: string
  readonly name: string
  readonly path: string
  readonly git: boolean
}

export type SessionState =
  | 'idle'
  | 'running'
  | 'waiting'
  | 'interrupted'
  | 'failed'

/** One session as the list and the events show it. */
export interface Summary {
  readonly id: string
  readonly title: string
  readonly folder: { readonly id: string | null; readonly name: string }
  readonly agent: { readonly id: string; readonly name: string }
  readonly mode: Mode
  readonly state: SessionState
  readonly worktree?: { readonly branch: string }
  /** Remote on: synced to the hub over the device link (§5). */
  readonly remote: boolean
  readonly createdAt: number
  readonly updatedAt: number
  readonly lastSeq: number
}

/** A tool call, on its process line (§4.3.6). */
export interface ToolInfo {
  readonly id: string
  readonly name: string
  readonly status: 'running' | 'done' | 'failed' | 'denied'
  readonly paths?: readonly string[]
  readonly command?: string
  readonly detailKind: 'output' | 'diff'
  readonly added?: number
  readonly removed?: number
  readonly approvedBy?: 'mode' | 'user' | 'session'
}

export type AskDecision = 'once' | 'session' | 'deny'

/** A permission question, on its process line (§4.4). */
export interface AskInfo {
  readonly id: string
  readonly tool: string
  readonly title: string
  readonly paths?: readonly string[]
  readonly input?: string
  readonly options: readonly AskDecision[]
  readonly decision?: AskDecision
  readonly by?: 'user' | 'stop' | 'shutdown'
  readonly at?: number
}

/**
 * One line of a conversation: a valid `ChatTurn` of the hub's console
 * (`console/src/deps.ts`) plus the three local fields, `tool`, `ask` and
 * `clientId`, which the hub's `ChatStore` drops.
 */
export interface CodeTurn {
  readonly id: string
  readonly sessionId: string
  readonly author: 'operator' | 'agent'
  readonly at: number
  readonly text: string
  readonly state: 'pending' | 'read' | 'done' | 'failed'
  readonly code?: string
  readonly variant?: 'notice'
  readonly noticeSource?: 'step'
  readonly severity?: 'info' | 'warn' | 'error'
  readonly detail?: string
  readonly tool?: ToolInfo
  readonly ask?: AskInfo
  readonly clientId?: string
  /** A person's line sent from another device over the link (§5.1). */
  readonly origin?: 'remote'
}

/** A line of `session.read`. */
export interface CodeRecord {
  readonly seq: number
  readonly kind: 'turn'
  readonly turn: CodeTurn
}

/**
 * What goes to the page's channel (§4.5.2), `v: 1` added on the way out. The
 * `runner` event (`up` after a `hello` it accepts, `down` when the runner
 * ends) is the shell's alone: only the shell knows when a runner is usable.
 */
export type CodeEvent =
  | { readonly type: 'session'; readonly session: Summary }
  | {
      readonly type: 'record'
      readonly session: string
      readonly seq: number
      readonly record?: CodeRecord
      readonly trimmed?: true
    }
  | {
      readonly type: 'delta'
      readonly session: string
      readonly turn: string
      readonly offset: number
      readonly text: string
    }
  | {
      readonly type: 'activity'
      readonly session: string
      readonly kind: 'thinking' | 'tool' | 'waiting' | 'queued' | 'starting'
      readonly words: string
    }
  | { readonly type: 'removed'; readonly session: string }
  /** The device link's state (§5.1): off, connecting, up, retrying, refused. */
  | {
      readonly type: 'link'
      readonly state: 'off' | 'connecting' | 'up' | 'retrying' | 'refused'
      readonly reason?: string
    }

// ---- checks ------------------------------------------------------------------

export const SESSION_ID = /^cs_[A-Za-z0-9_-]{22}$/
export const FOLDER_ID = /^[0-9a-f]{16}$/
const ASK_ID = /^[A-Za-z0-9_.:-]{1,128}$/
const CLIENT_ID = /^[A-Za-z0-9_-]{1,64}$/
/** C0, DEL and C1 controls. */
const CONTROL = /\p{Cc}/u

export const MAX_TEXT = 65_536
const MAX_MESSAGE = 500
const MAX_TITLE = 120
const MAX_PATH = 4_096
export const MAX_READ = 200
export const DEFAULT_READ = 100

type Params = Readonly<Record<string, unknown>>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function bad(message: string): CodeError {
  return new CodeError('E_ARGS', message)
}

/** `params` with exactly the keys named, the optional ones possibly absent. */
export function keys(
  params: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Params {
  if (!isRecord(params)) throw bad('参数要是一个对象')
  for (const key of Object.keys(params))
    if (!required.includes(key) && !optional.includes(key))
      throw bad(`多余的参数：${key}`)
  for (const key of required)
    if (!(key in params)) throw bad(`缺少参数：${key}`)
  return params
}

export function sessionId(value: unknown): string {
  if (typeof value !== 'string' || !SESSION_ID.test(value))
    throw bad('会话 id 不对')
  return value
}

export function folderId(value: unknown): string {
  if (typeof value !== 'string' || !FOLDER_ID.test(value))
    throw bad('文件夹 id 不对')
  return value
}

export function askId(value: unknown): string {
  if (typeof value !== 'string' || !ASK_ID.test(value))
    throw bad('征询 id 不对')
  return value
}

export function clientId(value: unknown): string {
  if (typeof value !== 'string' || !CLIENT_ID.test(value))
    throw bad('clientId 不对')
  return value
}

export function agentId(value: unknown): (typeof AGENT_IDS)[number] {
  const found = AGENT_IDS.find(id => id === value)
  if (found === undefined) throw bad('不认识的 agent')
  return found
}

export function modeOf(value: unknown): Mode {
  if (!isMode(value)) throw bad('不认识的权限模式')
  return value
}

export function decisionOf(value: unknown): AskDecision {
  if (value !== 'once' && value !== 'session' && value !== 'deny')
    throw bad('decision 只能是 once、session、deny')
  return value
}

/**
 * What a person typed: 1–65,536 characters, no NUL. Characters here, in the
 * shell and on the page are UTF-16 code units, a JavaScript string's
 * `length` (the shell's `ipc::units`, the page's `maxLength`).
 */
export function textOf(value: unknown): string {
  if (typeof value !== 'string' || value === '') throw bad('text 不能为空')
  if (value.includes('\0')) throw bad('text 里不能有 NUL')
  if (value.length > MAX_TEXT) throw bad(`text 至多 ${MAX_TEXT} 个字符`)
  return value
}

/** A short line: no control characters, at most `max` characters. */
function lineOf(value: unknown, name: string, max: number): string {
  if (typeof value !== 'string') throw bad(`${name} 要是字符串`)
  if (CONTROL.test(value)) throw bad(`${name} 里不能有控制字符`)
  if (value.length > max) throw bad(`${name} 至多 ${max} 个字符`)
  return value
}

export function messageOf(value: unknown): string {
  return lineOf(value, 'message', MAX_MESSAGE)
}

export function titleOf(value: unknown): string {
  return lineOf(value, 'title', MAX_TITLE)
}

export function booleanOf(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') throw bad(`${name} 要是布尔值`)
  return value
}

export function positiveOf(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1)
    throw bad(`${name} 要是正整数`)
  return value
}

export function limitOf(value: unknown): number {
  const limit = positiveOf(value, 'limit')
  if (limit > MAX_READ) throw bad(`limit 在 1–${MAX_READ} 之间`)
  return limit
}

/** A picked folder's path, from the shell's dialog: absolute, no NUL. */
export function pickedPathOf(value: unknown): string {
  if (typeof value !== 'string' || value === '') throw bad('path 不能为空')
  if (value.includes('\0') || value.length > MAX_PATH) throw bad('path 不对')
  return value
}

/** A path under a session's root, as `session.diff` takes it (§4.5.3). */
export function relativePathOf(
  value: unknown,
  platform: NodeJS.Platform = process.platform,
): string {
  if (typeof value !== 'string' || value === '') throw bad('path 不能为空')
  if (value.length > 1_024) throw bad('path 至多 1024 个字符')
  if (CONTROL.test(value)) throw bad('path 里不能有控制字符')
  if (value.startsWith('/') || value.startsWith('-'))
    throw bad('path 不能以 / 或 - 开头')
  const parts = value.split(platform === 'win32' ? /[\\/]/ : '/')
  if (platform === 'win32' && /^[A-Za-z]:/.test(value))
    throw bad('path 要是相对路径')
  for (const part of parts)
    if (part === '' || part === '.' || part === '..')
      throw bad('path 里不能有空段、. 或 ..')
  return parts.join('/')
}
