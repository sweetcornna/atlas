// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: MIT

/**
 * Turning recalled entries into prompt text — the 小规模全量注入 half of D-6.
 *
 * WHY FULL INJECTION AT ALL
 *
 * Deterministic retrieval alone was measured at 8/10 on adversarial questions,
 * and its worst failure is total: ask about 「语义搜索」 when the entry says
 * 「向量数据库」 and a keyword query returns nothing, so the answer is not
 * "weakly ranked", it is absent. AC-4 wants 5/5. Below the budget in
 * {@link INJECTION_BUDGET} every live entry in scope goes into the prompt and
 * the model does the matching, which turns 5/5 from a probability into a
 * property of the pipeline. Ranking still runs — it decides the *order*, and it
 * decides who survives when the store outgrows the budget.
 *
 * The base does the same thing with its own `MEMORY.md`, which is loaded into
 * every prompt whole. This is that pattern applied to a store that additionally
 * knows what each record's id and write time are.
 *
 * WHY THE BLOCK LOOKS LIKE THIS
 *
 * Each entry prints `entry_id` and `written_at` as their own labelled lines,
 * and a ready-made `citation` line built by `@qianmo/memory`'s own
 * `formatCitation`. AC-4 asks the answer to carry 来源 ID 与写入时间; making the
 * model *copy* a string it can see beats asking it to assemble one, and using
 * the store's formatter means the citation the model reads and the citation the
 * verifier renders can never drift apart.
 */

import { formatCitation, type MemoryEntry } from '@qianmo/memory'
import type { RankedEntry } from './rank.js'
import { MEMORY_ANSWER_TOOL_NAME } from './tool.js'

export type InjectionMode = 'full' | 'ranked'

export type InjectionBudget = {
  readonly maxEntries: number
  readonly maxChars: number
}

/**
 * The line between "inject everything" and "inject the best of it".
 *
 * D-6 put it at < 50 entries / < 20k tokens. The character budget is the
 * deterministic proxy for the token one: CJK runs at roughly one token per
 * character, so 20 000 characters is at the decision's ceiling in the worst
 * case and comfortably under it for Latin text. Counting characters rather than
 * calling a tokeniser keeps the whole path model-free, which is the same reason
 * charter N-8 gives for the retrieval itself.
 *
 * Recall-layer policy, not a protocol limit: nothing here crosses a node
 * boundary, so this is not a value `@qianmo/protocol`'s `LIMITS` owns.
 */
export const INJECTION_BUDGET: InjectionBudget = {
  maxEntries: 50,
  maxChars: 20_000,
}

/** The subset of a recall result that rendering needs. */
export type InjectionView = {
  readonly asOf: string
  readonly mode: InjectionMode
  readonly entries: readonly RankedEntry[]
  readonly omittedCount: number
  /** True when the scan could not read part of the store. */
  readonly degraded: boolean
}

function scopeLabel(entry: MemoryEntry): string {
  switch (entry.scope.layer) {
    case 'working':
      return `working/${entry.scope.projectKey}/${entry.scope.taskId}`
    case 'project':
      return `project/${entry.scope.projectKey}`
    case 'baseline':
      return `baseline/${entry.scope.period}`
  }
}

/** One entry as it appears in the block. */
export function renderEntry(entry: MemoryEntry): string {
  return [
    `entry_id: ${entry.id}`,
    `written_at: ${entry.createdAt}`,
    `source: ${entry.source.kind}:${entry.source.id}`,
    `scope: ${scopeLabel(entry)}`,
    `valid_from: ${entry.validAt}`,
    `tags: ${entry.tags.length === 0 ? '(none)' : entry.tags.join(', ')}`,
    `citation: ${formatCitation(entry)}`,
    `title: ${entry.title}`,
    `summary: ${entry.summary}`,
    'body:',
    entry.body.trimEnd(),
  ].join('\n')
}

export type Selection = {
  readonly chosen: readonly RankedEntry[]
  readonly mode: InjectionMode
  readonly omittedCount: number
}

/**
 * Decide how much of the candidate set fits.
 *
 * Walks in ranked order and stops at the first entry that would breach either
 * limit — so what survives a squeeze is what ranking judged most relevant, not
 * whatever the filesystem listed first.
 *
 * The character budget alone cannot reduce the block to nothing: a lone entry
 * larger than `maxChars` is still injected. A block that renders empty while
 * the store holds matching memory is indistinguishable, from inside the model,
 * from having no memory at all, and overshooting a soft size limit is the
 * lesser fault. `maxEntries` has no such exception — a caller asking for zero
 * entries is asking a different question and gets exactly that.
 */
export function selectForInjection(
  ranked: readonly RankedEntry[],
  budget: InjectionBudget = INJECTION_BUDGET,
): Selection {
  const chosen: RankedEntry[] = []
  let chars = 0
  for (const candidate of ranked) {
    const cost = renderEntry(candidate.entry).length
    const withinCount = chosen.length < budget.maxEntries
    const withinChars = chars + cost <= budget.maxChars || chosen.length === 0
    if (!withinCount || !withinChars) {
      break
    }
    chosen.push(candidate)
    chars += cost
  }
  const omittedCount = ranked.length - chosen.length
  return {
    chosen,
    mode: omittedCount === 0 ? 'full' : 'ranked',
    omittedCount,
  }
}

const OPEN = '<qianmo-memory'
const CLOSE = '</qianmo-memory>'

/**
 * The memory block, ready to be placed in a system prompt.
 *
 * `mode` and `omitted` are printed because they change what the block *means*:
 * in `full` mode "not in the block" is evidence the store does not know, while
 * in `ranked` mode it only means the entry did not make the cut. The model is
 * told which of the two it is looking at, and so is anyone reading a transcript.
 */
export function renderInjection(view: InjectionView): string {
  const header =
    `${OPEN} as_of="${view.asOf}" mode="${view.mode}" ` +
    `injected="${view.entries.length}" omitted="${view.omittedCount}">`
  const lines = [header]
  if (view.mode === 'full') {
    lines.push(
      '# Every live memory entry in scope is included below. If a claim is ' +
        'not here, this store does not record it.',
    )
  } else {
    lines.push(
      `# The store holds more entries than fit; the ${view.entries.length} ` +
        'most relevant are included and ' +
        `${view.omittedCount} were omitted. Absence here is not evidence of ` +
        'absence in the store.',
    )
  }
  if (view.degraded) {
    lines.push(
      '# WARNING: part of the memory store could not be read during this ' +
        'recall. The block below may be incomplete for reasons unrelated to ' +
        'what was written.',
    )
  }
  if (view.entries.length === 0) {
    lines.push('(no live memory entries in scope)')
  }
  for (const [index, ranked] of view.entries.entries()) {
    lines.push(
      `--- entry ${index + 1}/${view.entries.length} ---`,
      renderEntry(ranked.entry),
    )
  }
  lines.push(CLOSE)
  return lines.join('\n')
}

/**
 * The rules that make the citation contract binding, in prompt form.
 *
 * The prompt is the *cooperative* half only. Nothing here is trusted: the
 * enforcement is `verifyCitations`, which resolves every id against the store
 * regardless of what the model was told. Charter §6.1 T-7 fixes the standard —
 * 不以模型是否被说服验收 — and it applies to being persuaded *into* a fabricated
 * citation exactly as it applies to being persuaded out of a permission check.
 */
export function citationInstructions(
  toolName: string = MEMORY_ANSWER_TOOL_NAME,
): string {
  return [
    'You answer strictly from the <qianmo-memory> block above.',
    `Reply by calling the \`${toolName}\` tool. Do not answer in prose.`,
    'Put every entry you relied on in `citations`, using the `entry_id` value ' +
      'copied character for character from the block.',
    'Never invent, guess, abbreviate or reformat an id. Ids are checked ' +
      'against the memory store and an unverifiable id causes the whole ' +
      'answer to be rejected.',
    'If the block contains nothing that answers the question, say exactly ' +
      'that and pass an empty `citations` list. An honest "not recorded" is ' +
      'correct; a plausible-looking id is not.',
  ].join('\n')
}

/** System-prompt sections: the rules first, then the memory. */
export function buildRecallSystemPrompt(view: InjectionView): string[] {
  return [citationInstructions(), renderInjection(view)]
}
