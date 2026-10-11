// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from 'bun:test'
import {
  CONTROL_MESSAGE_TYPES,
  LEGACY_MESSAGE_TYPES,
  LIMITS,
  MessageType,
  createMessage,
  isControlOp,
  isOperationId,
  isHubCallPayload,
  isHubCallResultPayload,
  isHubSubscribePayload,
  isNodeControlPayload,
  isNodeControlResultPayload,
  isReplyType,
  validateMessage,
} from '../src/index.js'

const callId = '12345678-1234-4123-8123-123456789abc'

const cases = [
  {
    type: MessageType.NodeControl,
    check: isNodeControlPayload,
    valid: { op: 'files.read', args: { path: 'a.txt' }, actor: 'u:alice' },
  },
  {
    type: MessageType.NodeControlResult,
    check: isNodeControlResultPayload,
    valid: { ok: true, value: { entries: [1, null] } },
  },
  {
    type: MessageType.HubSubscribe,
    check: isHubSubscribePayload,
    valid: { subscribe: true },
  },
  {
    type: MessageType.HubCall,
    check: isHubCallPayload,
    valid: { callId, op: 'connector.mail-search', args: {} },
  },
  {
    type: MessageType.HubCallResult,
    check: isHubCallResultPayload,
    valid: { callId, ok: false, code: 'unsupported', message: 'not supported' },
  },
] as const

describe('control wire payloads (§15)', () => {
  test('optional operation ids validate without breaking legacy request shapes', () => {
    for (const payload of [
      { op: 'files.write', args: {}, actor: 'admin' },
      { callId, op: 'files.request', args: {} },
    ]) {
      const check = 'actor' in payload ? isNodeControlPayload : isHubCallPayload
      expect(check(payload)).toBe(true)
      expect(check({ ...payload, operationId: callId })).toBe(true)
      expect(check({ ...payload, operationId: 'invalid' })).toBe(false)
      expect(check({ ...payload, operationId: callId, unknown: true })).toBe(
        false,
      )
    }
    expect(isOperationId(callId)).toBe(true)
    expect(isOperationId('')).toBe(false)
    expect(
      isNodeControlResultPayload({
        ok: false,
        code: 'unknown',
        message: 'may have executed',
      }),
    ).toBe(true)
    expect(
      isHubCallResultPayload({
        callId,
        ok: false,
        code: 'not-sent',
        message: 'withdrawn',
      }),
    ).toBe(true)
  })
  for (const row of cases) {
    test(`${row.type}: valid payload crosses validation; missing or unknown fields are refused`, () => {
      const envelope = (payload: unknown) =>
        createMessage({
          from: 'qianmo://hub/console',
          to: 'qianmo://worker/console',
          type: row.type,
          payload,
        })
      expect(row.check(row.valid)).toBe(true)
      expect(validateMessage(envelope(row.valid), { now: Date.now() }).ok).toBe(
        true,
      )
      for (const invalid of [
        null,
        [],
        'payload',
        { ...row.valid, node: 'spoofed' },
        ...Object.keys(row.valid).map(key =>
          Object.fromEntries(
            Object.entries(row.valid).filter(([name]) => name !== key),
          ),
        ),
      ]) {
        expect(row.check(invalid)).toBe(false)
        const result = validateMessage(envelope(invalid), { now: Date.now() })
        expect(result.ok).toBe(false)
        if (!result.ok)
          expect(result.issues.some(issue => issue.field === 'payload')).toBe(
            true,
          )
      }
    })
  }

  test('operation grammar, actor boundary, UUID and object arguments reject invalid input', () => {
    expect(isControlOp(`a.${'b'.repeat(LIMITS.maxControlOpLength - 2)}`)).toBe(
      true,
    )
    for (const op of [
      'node',
      'Node.ping',
      'node._ping',
      'node..ping',
      'node.ping.',
      'node-name.ping',
      `a.${'b'.repeat(LIMITS.maxControlOpLength - 1)}`,
    ])
      expect(isControlOp(op)).toBe(false)
    expect(
      isNodeControlPayload({
        op: 'node.ping',
        args: {},
        actor: 'x'.repeat(LIMITS.maxControlActorLength),
      }),
    ).toBe(true)
    for (const update of [
      { actor: 5 },
      { actor: 'x'.repeat(LIMITS.maxControlActorLength + 1) },
      { args: [] },
      { args: null },
      { args: 'json' },
      { op: 'not-an-op' },
    ])
      expect(
        isNodeControlPayload({
          op: 'node.ping',
          args: {},
          actor: '',
          ...update,
        }),
      ).toBe(false)
    for (const update of [
      { callId: 'not-uuid' },
      { callId: 3 },
      { op: 'files' },
      { args: [] },
      { args: null },
    ])
      expect(
        isHubCallPayload({ callId, op: 'files.request', args: {}, ...update }),
      ).toBe(false)
    expect(isHubSubscribePayload({ subscribe: false })).toBe(false)
    expect(isHubSubscribePayload({ subscribe: 1 })).toBe(false)
  })

  test('outcomes discriminate success and failure and forbid mixed branches', () => {
    for (const check of [
      isNodeControlResultPayload,
      (value: unknown) =>
        typeof value === 'object' &&
        value !== null &&
        isHubCallResultPayload({ ...value, callId }),
    ]) {
      expect(check({ ok: true, value: null })).toBe(true)
      expect(check({ ok: false, code: 'internal', message: 'failure' })).toBe(
        true,
      )
      for (const invalid of [
        { ok: 1, value: null },
        { ok: true },
        { ok: false, code: 1, message: 'bad' },
        { ok: false, code: 'bad', message: null },
        { ok: true, value: 1, code: 'bad' },
        { ok: false, code: 'bad', message: 'bad', value: null },
      ])
        expect(check(invalid)).toBe(false)
    }
    expect(
      isHubCallResultPayload({ callId: 'fake', ok: true, value: null }),
    ).toBe(false)
  })

  test('only the two results reuse taskId as replies; all five require negotiation', () => {
    for (const type of CONTROL_MESSAGE_TYPES) {
      expect(isReplyType(type)).toBe(
        type === MessageType.NodeControlResult ||
          type === MessageType.HubCallResult,
      )
      expect(LEGACY_MESSAGE_TYPES.includes(type)).toBe(false)
    }
  })
})
