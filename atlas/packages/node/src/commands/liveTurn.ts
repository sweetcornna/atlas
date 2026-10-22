// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Whether a call comes from a person's own turn, still running (P40 §5,
 * owner 2026-10-22).
 *
 * The conversation named by `contextId` must be with this very agent, a
 * foreground one, and `taskId` must be a turn a person started there that is
 * still waiting for its answer. A background worker's conversation, a
 * schedule's and a channel conversation that is not the owner's private chat
 * are not: nobody is there to have asked. The answer is the conversation's
 * owner as an active account, or why not.
 *
 * Settings changes read their values as this owner (`consoleSettings.ts`),
 * and an approval request raised inside such a turn is decided by the
 * person's own request rather than a card (`consoleApprovals.ts`).
 */

import type {
  AccountBook,
  ChatPort,
  ChatTranscript,
  ConsolePrincipal,
} from '@qianmo/console'
import { terminalReply } from './chatTurn.js'

export type LiveTurnOwner = Extract<ConsolePrincipal, { kind: 'user' }>

export interface LiveTurnOptions {
  readonly chat: Pick<ChatPort, 'transcript'>
  readonly book: Pick<AccountBook, 'ownerOf' | 'list'>
  /** A schedule's conversation: nobody reads it live. */
  readonly scheduled?: (sessionId: string) => boolean
  /** False for a channel conversation that is not the owner's private chat. */
  readonly foreground?: (sessionId: string) => boolean
  /** A background task worker's conversation. */
  readonly worker?: (sessionId: string) => boolean
  readonly now: () => number
}

export interface LiveTurnCall {
  readonly contextId: string
  readonly taskId: string
  /** The agent the call is from, `qianmo://<node>/<agent>`. */
  readonly address: string
}

/** The owner of the live person's turn `call` names, or why it is not one. */
export async function liveTurnOwner(
  options: LiveTurnOptions,
  call: LiveTurnCall,
): Promise<LiveTurnOwner | string> {
  const { contextId, taskId } = call
  let transcript: ChatTranscript
  try {
    const read = await options.chat.transcript(contextId)
    if (!read.ok) return '会话不存在'
    transcript = read.value
  } catch {
    return '会话不存在'
  }
  if (transcript.session.target !== call.address) return '会话不属于这个智能体'
  if (
    transcript.session.background === true ||
    options.worker?.(contextId) === true
  )
    return '后台子任务不能改设置 · 交回发起它的对话去做'
  if (options.scheduled?.(contextId) === true)
    return '定时任务的会话不能改设置 · 没有人在看这一轮'
  if (options.foreground?.(contextId) === false)
    return '只有主人的私聊和控制台对话能改设置'
  const turns = transcript.turns
  const asked = turns.some(
    turn => turn.author === 'operator' && turn.taskId === taskId,
  )
  // The same terminal rule the task worker waits on (`consoleTasks.ts`).
  if (!asked || terminalReply(turns, taskId) !== undefined)
    return '这一轮不在进行中 · 只有人发起的一轮能改设置'
  const subject = options.book.ownerOf(contextId)
  if (subject === null) return '这个对话没有个人账号主人'
  const listed = options.book.list()
  const account = listed.ok
    ? listed.value.accounts.find(
        row => row.subject === subject && row.state === 'active',
      )
    : undefined
  if (account === undefined) return '对话主人的账号已不可用'
  return {
    kind: 'user',
    subject: account.subject,
    role: account.role,
    credential: 'bearer',
    authenticatedAt: options.now(),
  }
}
