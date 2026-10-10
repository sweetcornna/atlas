// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  memoryEvidenceContext,
  type AnswerProtocol,
} from '../../src/evidence-answer.js'
import { buildRecallSystemPrompt, renderInjection } from '../../src/inject.js'
import type { RecallResult } from '../../src/recall.js'
import type { AnswerRequest } from './types.js'

/** The v1 branch is retained only to reproduce historical recorded requests. */
export function answerPrompt(
  protocol: AnswerProtocol,
  result: RecallResult,
  question: string,
): Pick<AnswerRequest, 'system' | 'turns' | 'protocol'> {
  if (protocol === 'legacy-v1')
    return {
      system: buildRecallSystemPrompt(result),
      turns: [{ role: 'user', text: question }],
    }
  return {
    protocol,
    system: [],
    turns: [
      {
        role: 'user',
        text:
          result.entries.length === 0
            ? question
            : `${question}\n\n${memoryEvidenceContext(renderInjection(result))}`,
      },
    ],
  }
}
