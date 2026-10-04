// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Reasoning that used up the whole output budget (P18.12, hermes #24; design
 * `providers-console-m1.md` §5.6 row 24).
 *
 * When a response stops at the output limit, `query.ts` continues it — up to
 * three times, each with "Output token limit hit. Resume directly". That is
 * right for an answer cut mid-sentence and wrong for a response that never
 * got past its reasoning: the next request reasons again from the start and
 * stops at the same limit, three more times. Now, before continuing:
 *   - the response is "thinking exhausted" when it has reasoning and nothing
 *     else — no visible text, no tool call;
 *   - if the limit can still be raised (no `maxOutputTokensOverride` yet, no
 *     output limit the user set, and the reported output below
 *     `ESCALATED_MAX_TOKENS`), the same request is sent once more at that
 *     limit;
 *   - otherwise the turn ends with an error that says what happened.
 *
 * 规则来源 NousResearch/hermes-agent（MIT，Copyright (c) 2025 Nous Research，
 * 声明见 NOTICE 五），取于 `f9b29c49b6`（2026-10-03 取用）：
 * `agent/conversation_loop.py:3539-3597` — "When the model spends ALL output
 * tokens on reasoning and has none left for the response, continuation
 * retries are pointless … give a targeted error instead of wasting 3 API
 * calls"; exhausted only when reasoning was actually produced and nothing
 * visible follows, and never with tool calls ("content=None … for unrelated
 * reasons — treat those as normal truncations"). Only the rule is taken; the
 * code is ours.
 *
 * Qianmo difference: hermes stops at once; here one re-send at the escalated
 * limit comes first when the limit was lower (design §5.6 row 24). Not done
 * (left over): a `tool_use` cut off by the limit — its block may already be
 * running in the streaming tool executor, which is outside this package.
 */
// Imports nothing at runtime: query.ts calls this, and both
// `utils/messages` and `utils/session/context` lead back to query.ts
// (check:cycles). The caller passes the escalated limit and builds the
// message from THINKING_EXHAUSTED_TEXT.
import type { AssistantMessage } from 'src/types/message.js'

/** Output limits a user sets explicitly; any of them means "do not raise". */
const EXPLICIT_OUTPUT_LIMIT_ENV = [
  'CLAUDE_CODE_MAX_OUTPUT_TOKENS',
  'OPENAI_MAX_TOKENS',
  'GEMINI_MAX_TOKENS',
  'GROK_MAX_TOKENS',
] as const

type Block = { type?: unknown; text?: unknown; thinking?: unknown }

function blocksOf(message: AssistantMessage): Block[] {
  const content = message.message?.content
  return Array.isArray(content) ? (content as Block[]) : []
}

/**
 * `none` — not thinking exhaustion (continue as before); `raise` — re-send
 * once at `ESCALATED_MAX_TOKENS`; `stop` — end the turn with
 * an error reading {@link THINKING_EXHAUSTED_TEXT}.
 */
export function thinkingExhaustion(params: {
  /** This attempt's assistant messages, the withheld limit error included. */
  assistantMessages: readonly AssistantMessage[]
  maxOutputTokensOverride: number | undefined
  /** `ESCALATED_MAX_TOKENS` — the limit a raise goes to. */
  escalatedMaxTokens: number
  env?: NodeJS.ProcessEnv
}): 'none' | 'raise' | 'stop' {
  const env = params.env ?? process.env
  const responses = params.assistantMessages.filter(
    message => !message.isApiErrorMessage,
  )
  const blocks = responses.flatMap(blocksOf)
  const reasoned = blocks.some(
    block =>
      (block.type === 'thinking' &&
        typeof block.thinking === 'string' &&
        block.thinking.trim() !== '') ||
      block.type === 'redacted_thinking',
  )
  const answered = blocks.some(
    block =>
      block.type === 'tool_use' ||
      block.type === 'server_tool_use' ||
      (block.type === 'text' &&
        typeof block.text === 'string' &&
        block.text.trim() !== ''),
  )
  if (!reasoned || answered) return 'none'

  const reported = responses.at(-1)?.message?.usage?.output_tokens
  const outputTokens = typeof reported === 'number' ? reported : 0
  const raisable =
    params.maxOutputTokensOverride === undefined &&
    !EXPLICIT_OUTPUT_LIMIT_ENV.some(name => env[name]?.trim()) &&
    outputTokens > 0 &&
    outputTokens < params.escalatedMaxTokens
  return raisable ? 'raise' : 'stop'
}

/** What the turn ends with when reasoning took the whole budget. */
export const THINKING_EXHAUSTED_TEXT =
  'The model used its whole output budget on reasoning and produced no answer. ' +
  'Lower the reasoning effort (/effort) or raise the output limit ' +
  '(CLAUDE_CODE_MAX_OUTPUT_TOKENS).'
