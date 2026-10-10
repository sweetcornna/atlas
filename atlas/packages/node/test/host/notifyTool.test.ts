// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from 'bun:test'
import { NOTIFY_KINDS, NOTIFY_SEVERITIES } from '@qianmo/protocol'
import { residentToolSurface, verdictText } from '../../src/host/notifyTool.js'
import { parseNotifyVerdict } from '../../src/host/notifyWire.js'

describe('resident host tool contract', () => {
  test('always-loaded host tools; their caller cannot choose a recipient or session', () => {
    const tools = residentToolSurface()
    expect(tools.map(tool => tool.name)).toEqual([
      'qianmo_memory_answer',
      'qianmo_notify',
    ])
    const tool = tools[1]!
    expect(tool.loadMode).toBe('essential')
    expect(
      (tool.parameters.properties as Record<string, unknown>).kind,
    ).toMatchObject({ enum: [...NOTIFY_KINDS] })
    expect(
      (tool.parameters.properties as Record<string, unknown>).severity,
    ).toMatchObject({ enum: [...NOTIFY_SEVERITIES] })
    expect(tool.parameters.additionalProperties).toBe(false)
    expect(tool.parameters.properties).not.toHaveProperty('recipient')
    expect(tool.parameters.properties).not.toHaveProperty('sessionId')
    expect(tool.description).not.toMatch(/create.*schedule|run.*every.*minute/i)
  })
  test('every verdict tells the truth including queued, duplicate and unsupported', () => {
    expect(verdictText({ status: 'sent' })).toContain('sent')
    expect(verdictText({ status: 'queued' })).toContain('not reachable')
    expect(verdictText({ status: 'queued', retryAfterMs: 1001 })).toContain(
      '2s',
    )
    expect(verdictText({ status: 'duplicate' })).toContain('Not sent')
    expect(verdictText({ status: 'unsupported' })).toContain('does not support')
    expect(verdictText({ status: 'rejected', detail: 'no task' })).toContain(
      'no task',
    )
  })
  test('malformed responses fail closed and never claim delivery', () => {
    expect(parseNotifyVerdict({ status: 'invented' }).status).toBe('rejected')
    expect(parseNotifyVerdict(null).status).toBe('rejected')
    expect(
      parseNotifyVerdict({ status: 'queued', detail: 5, retryAfterMs: NaN }),
    ).toEqual({ status: 'queued' })
  })
})
