// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `@qianmo/recall` — 记忆检索唤醒 (roadmap P3.3, charter §4 AC-4).
 *
 * Four pieces, and the order they run in is the whole design:
 *
 *   1. `recall.ts`    scope-only candidate selection over `@qianmo/memory`,
 *                     live entries only, store failures carried out on the
 *                     result rather than swallowed.
 *   2. `rank.ts`      deterministic order: tags + keywords + time decay, no
 *                     model, no embeddings (charter N-8).
 *   3. `inject.ts`    small-scale full injection — below the budget every
 *                     entry in scope goes into the prompt, which is what makes
 *                     AC-4's 5/5 structural rather than probabilistic (D-6).
 *   4. `tool.ts` +    a provider-neutral tool carries the citation, and every
 *      `citation.ts`  id it carries is resolved against the store before the
 *                     answer is allowed out. A fabricated id does not resolve,
 *                     so it cannot be cited — that is AC-4's negative half.
 *
 * The one thing this package deliberately does not do is use any vendor's
 * native citation feature. See the header of `tool.ts`: that path is mutually
 * exclusive with structured output, exists on one vendor's line only, and would
 * put AC-4 and AC-5 in permanent conflict. The conflict is resolved here.
 */

export {
  handleMemoryAnswer,
  normaliseCitationId,
  renderCitedAnswer,
  verifyCitations,
  type CitationCheck,
  type CitationReport,
  type CitationStatus,
  type MemoryAnswer,
  type MemoryAnswerOptions,
} from './citation.js'
export {
  buildRecallSystemPrompt,
  citationInstructions,
  INJECTION_BUDGET,
  renderEntry,
  renderInjection,
  selectForInjection,
  type InjectionBudget,
  type InjectionMode,
  type InjectionView,
  type Selection,
} from './inject.js'
export {
  compareRanked,
  RANKING,
  rankEntries,
  recencyFactor,
  scoreEntry,
  tokensOf,
  type RankedEntry,
  type RankingInput,
} from './rank.js'
export {
  injectedIds,
  recall,
  type RecallRequest,
  type RecallResult,
  type RecallScope,
} from './recall.js'
export { tokenize } from './tokenize.js'
export {
  MEMORY_ANSWER_TOOL,
  MEMORY_ANSWER_TOOL_NAME,
  parseMemoryAnswerArgs,
  RecallToolError,
  type MemoryAnswerArgs,
  type RecallToolDefinition,
  type ToolInputSchema,
} from './tool.js'
