// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from 'bun:test'

import {
  MAX_UNREAD_PROTOCOL_MAILBOX_MESSAGES,
  compactMailboxMessages,
} from '../src/index.js'
import { message } from './helpers.js'

describe('compactMailboxMessages', () => {
  test('keeps unread messages first, then only recent read history', () => {
    const compacted = compactMailboxMessages(
      [
        message('read-1', true),
        message('read-2', true),
        message('unread-1', false),
        message('read-3', true),
        message('unread-2', false),
        message('read-4', true),
        message('read-5', true),
        message('unread-3', false),
      ],
      { maxMessages: 5, maxReadMessages: 2 },
    )

    expect(compacted.map(m => m.text)).toEqual([
      'unread-1',
      'unread-2',
      'read-4',
      'read-5',
      'unread-3',
    ])
  })

  test('unread protocol messages have their own lane outside the regular cap', () => {
    const protocol = message(
      JSON.stringify({ type: 'permission_response', request_id: 'req-1' }),
      false,
    )
    const compacted = compactMailboxMessages(
      [
        protocol,
        ...Array.from({ length: 5 }, (_, i) => message(`regular-${i}`, false)),
      ],
      { maxMessages: 2, maxReadMessages: 0, maxUnreadProtocolMessages: 1 },
    )

    expect(compacted.map(m => m.text)).toEqual([
      protocol.text,
      'regular-3',
      'regular-4',
    ])
  })

  test('an unknown typed JSON object rides the protocol lane too', () => {
    const unknown = message(JSON.stringify({ type: 'qianmo_custom' }), false)
    const compacted = compactMailboxMessages(
      [unknown, message('regular-1', false), message('regular-2', false)],
      { maxMessages: 1, maxReadMessages: 0 },
    )

    expect(compacted.map(m => m.text)).toEqual([unknown.text, 'regular-2'])
  })

  test('malformed JSON-like text is not treated as protocol', () => {
    const compacted = compactMailboxMessages(
      [
        message('{not-json', false),
        message('regular-1', false),
        message('regular-2', false),
      ],
      { maxMessages: 1, maxReadMessages: 0, maxUnreadProtocolMessages: 10 },
    )

    expect(compacted.map(m => m.text)).toEqual(['regular-2'])
  })

  test('the protocol lane has an independent bound, newest kept', () => {
    const compacted = compactMailboxMessages(
      Array.from({ length: MAX_UNREAD_PROTOCOL_MAILBOX_MESSAGES + 1 }, (_, i) =>
        message(
          JSON.stringify({
            type: 'permission_response',
            request_id: `req-${i}`,
          }),
          false,
        ),
      ),
    )

    expect(compacted).toHaveLength(MAX_UNREAD_PROTOCOL_MAILBOX_MESSAGES)
    expect(compacted[0]?.text).toContain('"req-1"')
  })

  test('retained bytes stay under the budget, newest kept', () => {
    const compacted = compactMailboxMessages(
      Array.from({ length: 20 }, (_, i) =>
        message(`msg-${i}-${'x'.repeat(200)}`, false),
      ),
      { maxMessages: 20, maxReadMessages: 0, maxRetainedBytes: 1_000 },
    )

    expect(
      Buffer.byteLength(JSON.stringify(compacted), 'utf8'),
    ).toBeLessThanOrEqual(1_000)
    expect(compacted.length).toBeLessThan(20)
    expect(compacted.at(-1)?.text).toContain('msg-19')
  })

  test('a message larger than the whole budget is dropped', () => {
    expect(
      compactMailboxMessages([message('too-large', false)], {
        maxMessages: 10,
        maxReadMessages: 0,
        maxRetainedBytes: 1,
      }),
    ).toEqual([])
  })

  test('all lanes disabled empties the inbox', () => {
    expect(
      compactMailboxMessages([message('unread', false)], {
        maxMessages: 0,
        maxReadMessages: 0,
        maxUnreadProtocolMessages: 0,
        maxRetainedBytes: 1_000,
      }),
    ).toEqual([])
  })
})
