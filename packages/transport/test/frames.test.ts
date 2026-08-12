// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: MIT

import { describe, expect, test } from 'bun:test'
import { ProtocolErrorCode } from '@qianmo/protocol'
import {
  FRAME_VERSION,
  FrameType,
  ReceiptStatus,
  parseFrame,
  serializeFrame,
} from '../src/index.js'
import { makeMessage } from './helpers.js'

describe('frame round trip', () => {
  test('every frame kind survives serialize → parse', () => {
    const message = makeMessage()
    const frames = [
      { t: FrameType.Challenge, v: FRAME_VERSION, nonce: 'abcd' },
      {
        t: FrameType.Auth,
        v: FRAME_VERSION,
        node: 'node-a',
        nonce: 'abcd',
        clientNonce: 'ef01',
        mac: '00ff',
      },
      { t: FrameType.Ready, v: FRAME_VERSION },
      { t: FrameType.KeepAlive, v: FRAME_VERSION },
      { t: FrameType.Envelope, v: FRAME_VERSION, envelope: message },
      {
        t: FrameType.Receipt,
        v: FRAME_VERSION,
        msgId: message.msgId,
        status: ReceiptStatus.Accepted,
      },
    ] as const

    for (const frame of frames) {
      expect(parseFrame(serializeFrame(frame))).toEqual(frame)
    }
  })

  test('a rejected receipt keeps its protocol error code', () => {
    const frame = {
      t: FrameType.Receipt,
      v: FRAME_VERSION,
      msgId: 'm-1',
      status: ReceiptStatus.Rejected,
      code: ProtocolErrorCode.E_TOO_LARGE,
      reason: 'invalid envelope',
    } as const
    expect(parseFrame(serializeFrame(frame))).toEqual(frame)
  })
})

describe('parseFrame refuses what is not a frame', () => {
  test.each([
    ['not json at all', 'definitely-not-json'],
    ['a bare array', '[1,2,3]'],
    ['a frame of another version', '{"t":"ready","v":1}'],
    ['an unknown frame type', '{"t":"gossip","v":0}'],
    ['a challenge with no nonce', '{"t":"challenge","v":0}'],
    ['an auth frame missing its mac', '{"t":"auth","v":0,"node":"a"}'],
    [
      'a receipt with an invented status',
      '{"t":"receipt","v":0,"msgId":"m","status":"maybe"}',
    ],
  ])('%s → null', (_label, raw) => {
    expect(parseFrame(raw)).toBeNull()
  })

  test('an unknown error code is dropped, the receipt still parses', () => {
    const parsed = parseFrame(
      '{"t":"receipt","v":0,"msgId":"m","status":"rejected","code":"E_MADE_UP"}',
    )
    expect(parsed).toEqual({
      t: FrameType.Receipt,
      v: FRAME_VERSION,
      msgId: 'm',
      status: ReceiptStatus.Rejected,
    })
  })

  test('an envelope frame carries its payload through unvalidated', () => {
    // The transport must not decide what a valid envelope is — it hands the
    // raw value to `validateMessage` on the receiving node.
    const parsed = parseFrame('{"t":"envelope","v":0,"envelope":{"junk":true}}')
    expect(parsed).toEqual({
      t: FrameType.Envelope,
      v: FRAME_VERSION,
      envelope: { junk: true },
    })
  })
})
