// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_COMPACTION_SETTINGS,
  shouldCompact,
  resolveThresholdTokens,
} from '@oh-my-pi/pi-agent-core/compaction'
import { LIMITS } from '@qianmo/protocol'
import { INJECTION_BUDGET, memoryEvidenceContext } from '@qianmo/recall'
import { MAX_MAILBOX_MESSAGE_TEXT_BYTES } from '@qianmo/mailbox'
import { residentToolSurface } from '../../src/host/notifyTool.js'

// A declared 200k test model; this is a budget regression, not a claim about
// every model a node can configure. Character counts conservatively allow CJK.
const CONTEXT_WINDOW = 200_000
function toolSurfaceChars(): number {
  return residentToolSurface(true).reduce(
    (total, tool) =>
      total +
      tool.name.length +
      tool.description.length +
      JSON.stringify(tool.parameters).length,
    0,
  )
}
describe('resident additions fit the declared omp model context', () => {
  test('a maximal mailbox message, sidecar and actual host schema stay below omp compaction', () => {
    const tokens =
      MAX_MAILBOX_MESSAGE_TEXT_BYTES +
      memoryEvidenceContext('x'.repeat(INJECTION_BUDGET.maxChars)).length +
      toolSurfaceChars()
    expect(
      shouldCompact(tokens, CONTEXT_WINDOW, DEFAULT_COMPACTION_SETTINGS),
    ).toBe(false)
    expect(tokens).toBeLessThan(
      resolveThresholdTokens(CONTEXT_WINDOW, DEFAULT_COMPACTION_SETTINGS),
    )
  })
  test('sidecar and host surface remain bounded independently of the memory store', () => {
    expect(INJECTION_BUDGET.maxChars).toBeLessThanOrEqual(20_000)
    expect(INJECTION_BUDGET.maxEntries).toBeLessThanOrEqual(50)
    expect(residentToolSurface().map(tool => tool.name)).toEqual([
      'qianmo_memory_answer',
      'qianmo_notify',
    ])
    expect(
      residentToolSurface(true)
        .map(tool => tool.name)
        .sort(),
    ).toEqual(['qianmo_memory_answer', 'qianmo_memory_write', 'qianmo_notify'])
    expect(toolSurfaceChars()).toBeGreaterThan(200)
    expect(toolSurfaceChars()).toBeLessThan(8_000)
  })
  test('collapsing a whole queue into one prompt would cross the threshold', () => {
    expect(LIMITS.maxQueuedTurns).toBe(32)
    const tokens =
      (MAX_MAILBOX_MESSAGE_TEXT_BYTES +
        memoryEvidenceContext('x'.repeat(INJECTION_BUDGET.maxChars)).length) *
      LIMITS.maxQueuedTurns
    expect(
      shouldCompact(tokens, CONTEXT_WINDOW, DEFAULT_COMPACTION_SETTINGS),
    ).toBe(true)
  })
})
