// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Which of a conversation's lines are still waiting for an answer.
 *
 * One rule for every place that says a conversation is running — the host's
 * session list (`running`), the front's badge, strip and "正在处理" line — so
 * none of them can disagree with another.
 *
 * A person's line is answered by the agent's line that carries the same
 * `taskId` (the request/reply correlation key, protocol C-1), whether that
 * answer is a reply or a failure. Asking only "is the last line the
 * person's" misses the case that matters most here: two lines sent back to
 * back, the first answered, the second still on its way — the conversation
 * is still running although its last line is the agent's.
 *
 * A failed line is not waiting for anything. A line with no `taskId` (one the
 * transport never took, or a transcript older than the key) is waiting only
 * while no agent line comes after it: that is the most the transcript can
 * say about it.
 */

import type { ChatTurn } from './deps.js'

export function unansweredTurns(
  turns: readonly ChatTurn[],
): readonly ChatTurn[] {
  const answered = new Set<string>()
  let lastAgentAt = -1
  turns.forEach((turn, index) => {
    if (turn.variant === 'notice' || turn.author !== 'agent') return
    if (turn.taskId !== undefined) answered.add(turn.taskId)
    lastAgentAt = index
  })
  return turns.filter(
    (turn, index) =>
      turn.variant !== 'notice' &&
      turn.author === 'operator' &&
      turn.state !== 'failed' &&
      (turn.taskId === undefined
        ? index > lastAgentAt
        : !answered.has(turn.taskId)),
  )
}
