// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from 'node:crypto'
import { formatCitation, type FileMemoryStore } from '@qianmo/memory'
import { verifyCitations, type CitationReport } from './citation.js'
import { renderEvidenceSources } from './inject.js'
import {
  MEMORY_ANSWER_TOOL_NAME,
  RecallToolError,
  type RecallToolDefinition,
} from './tool.js'

export type AnswerProtocol = 'legacy-v1' | 'memory-evidence-v2'
export const EVIDENCE_ANSWER_PROTOCOL: AnswerProtocol = 'memory-evidence-v2'

/** These limits bound output, not which subject matter may be remembered. */
const MAX_EVIDENCE = 16
const MAX_QUOTE_CHARS = 16_000
export const INSUFFICIENT_MEMORY_ANSWER =
  '本轮提供的记忆不足以回答这个问题；这不表示记忆库中完全没有相关记录。'

export const MEMORY_EVIDENCE_TOOL: RecallToolDefinition = {
  name: MEMORY_ANSWER_TOOL_NAME,
  description:
    'Answer a question about recorded memory using source excerpts, not invented prose. ' +
    'Choose supported only when the provided entries directly answer the requested fact, ' +
    'object, time, version and conditions. Copy each entry_id and a complete summary or ' +
    'complete body paragraph verbatim into evidence. The host verifies and renders the ' +
    'excerpts with their real sources. It does not certify their relevance to the question. ' +
    'If the requested fact is absent or only related facts are present, choose insufficient ' +
    'with evidence: []; do not attach background or corrective citations to a refusal. ' +
    'A missing retrieved fact does not prove the whole memory store lacks it.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      status: { type: 'string', enum: ['supported', 'insufficient'] },
      evidence: {
        type: 'array',
        maxItems: MAX_EVIDENCE,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', minLength: 1 },
            quote: {
              type: 'string',
              minLength: 1,
              maxLength: MAX_QUOTE_CHARS,
              description:
                'A whole summary, whole body, or complete body paragraph (blank-line separated), copied verbatim. Keep negation and qualifications; do not splice fragments.',
            },
          },
          required: ['id', 'quote'],
        },
      },
    },
    required: ['status', 'evidence'],
  },
}

export const MEMORY_EVIDENCE_INSTRUCTIONS =
  `For a memory-based answer call ${MEMORY_ANSWER_TOOL_NAME}. ` +
  MEMORY_EVIDENCE_TOOL.description

/** Appended to a user message on both resident and new evaluation paths. */
export function memoryEvidenceContext(block: string): string {
  return `${MEMORY_EVIDENCE_INSTRUCTIONS}\n\n${block}`
}

export const MEMORY_EVIDENCE_PROTOCOL_HASH = createHash('sha256')
  .update(
    JSON.stringify({
      version: EVIDENCE_ANSWER_PROTOCOL,
      tool: MEMORY_EVIDENCE_TOOL,
      instructions: MEMORY_EVIDENCE_INSTRUCTIONS,
      placement: 'user-message',
      insufficient: INSUFFICIENT_MEMORY_ANSWER,
      verification:
        'exact-injected-live-id;complete-rendered-source-paragraph;all-or-nothing;v1',
      rendering: 'host-only-excerpts-and-store-provenance;v1',
      scoringText: 'verified-quotes-only-excludes-host-provenance;v1',
    }),
  )
  .digest('hex')

type EvidenceArgs = {
  readonly status: 'supported' | 'insufficient'
  readonly evidence: readonly { readonly id: string; readonly quote: string }[]
}

function parseEvidence(input: unknown): EvidenceArgs {
  if (input === null || typeof input !== 'object' || Array.isArray(input))
    throw new RecallToolError('Memory evidence answer must be an object')
  const row = input as Record<string, unknown>
  if (
    Object.keys(row).some(key => key !== 'status' && key !== 'evidence') ||
    (row.status !== 'supported' && row.status !== 'insufficient') ||
    !Array.isArray(row.evidence) ||
    row.evidence.length > MAX_EVIDENCE ||
    (row.status === 'supported'
      ? row.evidence.length === 0
      : row.evidence.length !== 0)
  )
    throw new RecallToolError(
      'Use supported with source evidence, or insufficient with evidence: []',
    )
  for (const item of row.evidence) {
    if (
      item === null ||
      typeof item !== 'object' ||
      Array.isArray(item) ||
      Object.keys(item).some(key => key !== 'id' && key !== 'quote') ||
      typeof item.id !== 'string' ||
      !item.id ||
      typeof item.quote !== 'string' ||
      !item.quote.trim() ||
      item.quote.length > MAX_QUOTE_CHARS
    )
      throw new RecallToolError(
        'Evidence must contain only an entry id and a complete source quote',
      )
  }
  return row as EvidenceArgs
}

interface MemoryEvidenceAnswer {
  readonly ok: boolean
  readonly answer: string
  /** Substantive text only, so timestamps/source ids cannot satisfy answer labels. */
  readonly content: string
  readonly report: CitationReport
  readonly rejection: string | null
}

/** Provenance and verbatim source check; deliberately not a semantic entailment oracle. */
export function handleMemoryEvidenceAnswer(
  store: FileMemoryStore,
  shown: ReadonlySet<string>,
  input: unknown,
): MemoryEvidenceAnswer {
  const args = parseEvidence(input)
  const report = verifyCitations(
    store,
    args.evidence.map(item => item.id),
    shown,
  )
  const rendered: string[] = []
  let valid = report.verdict === 'accepted'
  for (const evidence of args.evidence) {
    const entry = report.accepted.find(item => item.id === evidence.id)
    // The v2 identifier is exact. Legacy formatted citations are not source ids.
    if (entry === undefined) {
      valid = false
      continue
    }
    const sources = renderEvidenceSources(entry)
    if (!sources.includes(evidence.quote)) {
      valid = false
      continue
    }
    rendered.push(
      `${evidence.quote
        .split('\n')
        .map(line => `> ${line}`)
        .join('\n')}\n\n${formatCitation(entry)}`,
    )
  }
  if (!valid)
    return {
      ok: false,
      answer: '',
      content: '',
      report,
      // Do not reveal whether an unavailable id exists outside the injected scope.
      rejection:
        'Memory evidence could not be verified for this turn. Use only an exact injected entry_id and its complete source summary or paragraph. If the requested fact is unsupported, use insufficient with evidence: [].',
    }
  return {
    ok: true,
    answer:
      args.status === 'insufficient'
        ? INSUFFICIENT_MEMORY_ANSWER
        : `记忆原文 / Memory excerpts:\n\n${rendered.join('\n\n')}`,
    content:
      args.status === 'insufficient'
        ? INSUFFICIENT_MEMORY_ANSWER
        : args.evidence.map(item => item.quote).join('\n\n'),
    report,
    rejection: null,
  }
}
