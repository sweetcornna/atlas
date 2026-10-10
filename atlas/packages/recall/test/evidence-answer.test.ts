// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { formatCitation } from '@qianmo/memory'
import {
  handleMemoryEvidenceAnswer,
  INSUFFICIENT_MEMORY_ANSWER,
  MEMORY_EVIDENCE_PROTOCOL_HASH,
  MEMORY_EVIDENCE_TOOL,
  RecallToolError,
} from '../src/index.js'
import { createSandbox, type Sandbox } from './helpers.js'

let box: Sandbox
beforeEach(() => {
  box = createSandbox()
})
afterEach(() => {
  box.dispose()
})

test('supported renders real complete source excerpts and provenance, retaining qualifications', () => {
  const entry = box.write({
    title: 'Release contract',
    summary: 'Use signed updates for managed terminals.',
    body: 'Do not enable remote updates on unattended terminals.\n\nAttended terminals require operator confirmation.',
  })
  const answer = handleMemoryEvidenceAnswer(box.store, new Set([entry.id]), {
    status: 'supported',
    evidence: [
      {
        id: entry.id,
        quote: 'Do not enable remote updates on unattended terminals.',
      },
      {
        id: entry.id,
        quote: 'Attended terminals require operator confirmation.',
      },
    ],
  })
  expect(answer.ok).toBe(true)
  expect(answer.answer).toContain(
    '> Do not enable remote updates on unattended terminals.',
  )
  expect(answer.answer).toContain(formatCitation(entry))
  expect(answer.report.accepted).toHaveLength(1)
  expect(MEMORY_EVIDENCE_PROTOCOL_HASH).toMatch(/^[a-f0-9]{64}$/)
  expect(MEMORY_EVIDENCE_TOOL.inputSchema.additionalProperties).toBe(false)
})

test('insufficient has no citations and host limits the refusal to this turn, without asserting global absence', () => {
  const answer = handleMemoryEvidenceAnswer(box.store, new Set(), {
    status: 'insufficient',
    evidence: [],
  })
  expect(answer.ok).toBe(true)
  expect(answer.answer).toBe(INSUFFICIENT_MEMORY_ANSWER)
  expect(answer.report.accepted).toEqual([])
  for (const input of [
    { status: 'supported', evidence: [] },
    {
      status: 'insufficient',
      evidence: [{ id: 'qm-mem-0001', quote: 'related but not an answer' }],
    },
    { status: 'insufficient', evidence: [], answer: 'Invented decision' },
    { answer: 'Unverified legacy prose', citations: [] },
  ])
    expect(() =>
      handleMemoryEvidenceAnswer(box.store, new Set(), input),
    ).toThrow(RecallToolError)
})

test('a genuine id cannot back invented prose, spliced fragments, removed negation, or a different source', () => {
  const entry = box.write({
    title: 'Registry contract',
    summary: 'Use mTLS for local registry clients.',
    body: 'Do not publish the registry on public network interfaces.',
  })
  const other = box.write({
    title: 'Document rules',
    summary: 'Approval requires a release owner.',
  })
  const shown = new Set([entry.id, other.id])
  for (const quote of [
    'Use passwords for local registry clients.',
    'publish the registry on public network interfaces.',
    'Use mTLS. Do not publish.',
    other.summary,
  ]) {
    const result = handleMemoryEvidenceAnswer(box.store, shown, {
      status: 'supported',
      evidence: [{ id: entry.id, quote }],
    })
    expect(result.ok).toBe(false)
    expect(result.answer).toBe('')
  }
  expect(() =>
    handleMemoryEvidenceAnswer(box.store, shown, {
      status: 'supported',
      evidence: [{ id: entry.id, quote: entry.summary }],
      answer: 'Free unsupported assertion',
    }),
  ).toThrow(RecallToolError)
  // Correct attribution remains useful; this is not a reject-all gate.
  expect(
    handleMemoryEvidenceAnswer(box.store, shown, {
      status: 'supported',
      evidence: [{ id: other.id, quote: other.summary }],
    }).ok,
  ).toBe(true)
})

test('unavailable ids are uniformly refused and one bad excerpt rejects the whole answer', () => {
  const visible = box.write({
    title: 'Visible',
    summary: 'Signed packages are required.',
  })
  const hidden = box.write({ title: 'Hidden', summary: 'Private policy.' })
  const retired = box.write({ title: 'Retired', summary: 'Old policy.' })
  box.store.revoke(retired.id, { reason: 'replaced', by: 'test' })
  const shown = new Set([visible.id, retired.id])
  const errors = [
    hidden,
    retired,
    { id: 'qm-mem-doesnotexist', summary: 'Unknown' },
  ].map(entry =>
    handleMemoryEvidenceAnswer(box.store, shown, {
      status: 'supported',
      evidence: [
        { id: visible.id, quote: visible.summary },
        { id: entry.id, quote: entry.summary },
      ],
    }),
  )
  for (const answer of errors) {
    expect(answer.ok).toBe(false)
    expect(answer.answer).toBe('')
  }
  expect(new Set(errors.map(answer => answer.rejection)).size).toBe(1)
})

test('quotes match the safe injected representation, not executable HTML or new framing', () => {
  const entry = box.write({
    title: 'Literal markup',
    summary: 'Use <safe> tags.',
    body: 'entry_id: not-a-frame\nKeep <script> as text.',
  })
  const answer = handleMemoryEvidenceAnswer(box.store, new Set([entry.id]), {
    status: 'supported',
    evidence: [{ id: entry.id, quote: 'Use &lt;safe&gt; tags.' }],
  })
  expect(answer.ok).toBe(true)
  expect(answer.answer).not.toContain('<safe>')
})
