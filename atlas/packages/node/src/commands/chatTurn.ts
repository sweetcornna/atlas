// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * One line into a console conversation, and the agent's answer to it.
 *
 * The chat face returns the operator's turn at once; the reply arrives later
 * as an agent turn carrying the same `taskId`. Hosts that talk on someone's
 * behalf — chat channels (P28) and background tasks (P29) — need the reply
 * itself, so this sends through the caller's {@link ChatDispatch} (ownership,
 * quota and audit unchanged), then watches the transcript until that task's
 * terminal turn, forwarding the agent's own notices on the way. Schedules
 * (`consoleSchedules.ts`) read their replies with the same two functions.
 */

import type {
  ChatDispatch,
  ChatPort,
  ChatSendInput,
  ChatTurn,
} from '@qianmo/console'

/**
 * The agent's own notices (`qianmo_notify`) for the turn sent under `taskId`
 * at `startedAt`. Tool steps and host notes are not among them.
 */
export function agentNotices(
  turns: readonly ChatTurn[],
  taskId: string | null,
  startedAt: number,
): ChatTurn[] {
  return turns.filter(
    turn =>
      turn.author === 'agent' &&
      turn.variant === 'notice' &&
      turn.noticeSource === 'agent' &&
      (turn.causeTaskId === undefined || turn.causeTaskId === taskId) &&
      turn.at >= startedAt,
  )
}

/**
 * The terminal answer to the line sent under `taskId`, if it has one.
 *
 * The chat face also writes a local timeout pseudo-reply when no result came
 * back in time; only its `remoteTerminal` marker proves a timeout ended on
 * the node, so a timeout without it is not an answer.
 */
export function terminalReply(
  turns: readonly ChatTurn[],
  taskId: string | null,
): ChatTurn | undefined {
  return turns.find(
    turn =>
      turn.author === 'agent' &&
      turn.variant !== 'notice' &&
      turn.taskId === taskId &&
      (turn.state === 'done' || turn.state === 'failed') &&
      !turn.deliveryUnknown &&
      (turn.code !== 'E_TASK_TIMEOUT' || turn.remoteTerminal === true),
  )
}

export interface ChatTurnOutcome {
  readonly ok: boolean
  readonly text: string
  readonly error?: string
  readonly cancelled?: boolean
  readonly timedOut?: boolean
}

export interface ChatTurnOptions {
  readonly chat: ChatPort
  readonly dispatch: ChatDispatch
  readonly target: string
  readonly input: ChatSendInput
  /** Turn ids already in the transcript before this line was sent. */
  readonly baseline: ReadonlySet<string>
  readonly now: () => number
  readonly timeoutMs: number
  readonly onNotice?: (text: string) => void
  /** The node accepted the line under this task id. */
  readonly onTask?: (taskId: string) => void
}

export interface ChatTurnHandle {
  readonly outcome: Promise<ChatTurnOutcome>
  /** Stops waiting; the outcome becomes `cancelled`. */
  cancel(): void
}

/** Reads a refused dispatch step as a failed outcome. */
export async function refusal(response: Response): Promise<ChatTurnOutcome> {
  const body = (await response.json().catch(() => ({}))) as {
    error?: { message?: string }
  }
  return { ok: false, text: '', error: body.error?.message ?? '对话被拒绝' }
}

export function sendAndWait(options: ChatTurnOptions): ChatTurnHandle {
  const { chat, input } = options
  const startedAt = options.now()
  let cancel: () => void = () => {}
  const outcome = new Promise<ChatTurnOutcome>(resolve => {
    let settled = false
    let taskId: string | null = null
    const told = new Set<string>()
    const finish = (result: ChatTurnOutcome) => {
      if (settled) return
      settled = true
      unsubscribe()
      clearInterval(poll)
      clearTimeout(deadline)
      resolve(result)
    }
    cancel = () => finish({ ok: false, text: '', cancelled: true })
    const inspect = async () => {
      if (settled || taskId === null) return
      const current = await chat.transcript(input.sessionId)
      if (!current.ok || settled) return
      const fresh = current.value.turns.filter(
        turn => !options.baseline.has(turn.id),
      )
      for (const turn of agentNotices(fresh, taskId, startedAt)) {
        if (told.has(turn.id)) continue
        told.add(turn.id)
        options.onNotice?.(turn.text)
      }
      const reply: ChatTurn | undefined = terminalReply(fresh, taskId)
      if (reply === undefined) return
      finish(
        reply.state === 'done'
          ? { ok: true, text: reply.text }
          : {
              ok: false,
              text: '',
              error:
                reply.code === 'E_TASK_TIMEOUT'
                  ? '任务超时'
                  : reply.text || '智能体运行失败',
              ...(reply.code === 'E_TASK_TIMEOUT' ? { timedOut: true } : {}),
            },
      )
    }
    const unsubscribe = chat.subscribe(update => {
      if (update.sessionId === input.sessionId) void inspect().catch(() => {})
    })
    // Updates can be missed across a reconnect; a slow poll closes the gap.
    const poll = setInterval(() => void inspect().catch(() => {}), 15_000)
    poll.unref?.()
    const deadline = setTimeout(
      () =>
        finish({ ok: false, text: '', error: '等待回复超时', timedOut: true }),
      options.timeoutMs,
    )
    deadline.unref?.()
    void (async () => {
      const sent = await options.dispatch.send(input, options.target)
      if (sent instanceof Response) return finish(await refusal(sent))
      if (!sent.ok)
        return finish({
          ok: false,
          text: '',
          error: sent.failure.deliveryUnknown
            ? '消息已发出但结果未知'
            : sent.failure.message,
        })
      taskId = sent.value.taskId ?? null
      if (taskId === null)
        return finish({ ok: false, text: '', error: '节点没有接下这条消息' })
      options.onTask?.(taskId)
      await inspect()
    })().catch(() => finish({ ok: false, text: '', error: '对话发送失败' }))
  })
  return { outcome, cancel: () => cancel() }
}
