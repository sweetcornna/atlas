import { describe, expect, test } from 'bun:test'
import {
  ENVELOPE_VERSION,
  LIMITS,
  MESSAGE_TYPES,
  MessageType,
  ProtocolError,
  ProtocolErrorCode,
  createMessage,
  destinationNode,
  errorReply,
  expiresAt,
  isExpired,
  isMessageType,
  messageBytes,
  newId,
  serializeMessage,
  withHop,
} from '../src/index.js'

const FROM = 'qianmo://tokyo-1/planner'
const TO = 'qianmo://osaka-2/worker'

describe('message types', () => {
  test('covers exactly the v0 type set', () => {
    expect([...MESSAGE_TYPES].sort() as string[]).toEqual(
      ['error', 'ping', 'pong', 'task.request', 'task.result', 'wake'].sort(),
    )
    expect(MESSAGE_TYPES).toHaveLength(6)
  })

  test('isMessageType accepts known types and rejects the rest', () => {
    expect(isMessageType(MessageType.TaskRequest)).toBe(true)
    expect(isMessageType('task.result')).toBe(true)
    expect(isMessageType('task.cancel')).toBe(false)
    expect(isMessageType(7)).toBe(false)
  })
})

describe('limits', () => {
  test('declares the v0 boundaries', () => {
    expect(LIMITS.maxMessageBytes).toBe(262144)
    expect(LIMITS.maxHops).toBe(8)
    expect(LIMITS.defaultTtlMs).toBeGreaterThan(0)
    expect(LIMITS.ratePerMinute).toBeGreaterThan(0)
  })
})

describe('createMessage', () => {
  test('fills in defaults', () => {
    const message = createMessage({
      from: FROM,
      to: TO,
      type: MessageType.Ping,
      payload: null,
    })
    expect(message.v).toBe(ENVELOPE_VERSION)
    expect(message.msgId.length).toBeGreaterThan(0)
    expect(message.traceId.length).toBeGreaterThan(0)
    expect(message.ttlMs).toBe(LIMITS.defaultTtlMs)
    expect(message.hops).toEqual([])
    expect(message.createdAt).toBeGreaterThan(0)
  })

  test('honours explicit fields', () => {
    const message = createMessage({
      from: FROM,
      to: TO,
      type: MessageType.TaskRequest,
      payload: { goal: 'summarise' },
      msgId: 'm-1',
      traceId: 't-1',
      createdAt: 1_000,
      ttlMs: 500,
      hops: ['tokyo-1'],
    })
    expect(message.msgId).toBe('m-1')
    expect(message.traceId).toBe('t-1')
    expect(message.hops).toEqual(['tokyo-1'])
    expect(expiresAt(message)).toBe(1_500)
  })

  test('newId produces distinct identifiers', () => {
    expect(newId()).not.toBe(newId())
  })

  test('destinationNode reads the recipient node', () => {
    const message = createMessage({
      from: FROM,
      to: TO,
      type: MessageType.Ping,
      payload: 1,
    })
    expect(destinationNode(message)).toBe('osaka-2')
  })
})

describe('withHop', () => {
  const base = createMessage({
    from: FROM,
    to: TO,
    type: MessageType.TaskRequest,
    payload: {},
    createdAt: 1_000,
  })

  test('appends without mutating the original', () => {
    const hopped = withHop(base, 'tokyo-1')
    expect(hopped.hops).toEqual(['tokyo-1'])
    expect(base.hops).toEqual([])
    expect(withHop(hopped, 'osaka-2').hops).toEqual(['tokyo-1', 'osaka-2'])
  })

  test('throws E_LOOP when the node is already present', () => {
    const hopped = withHop(base, 'tokyo-1')
    try {
      withHop(hopped, 'tokyo-1')
      throw new Error('expected withHop to throw')
    } catch (error) {
      expect(error).toBeInstanceOf(ProtocolError)
      expect((error as ProtocolError).code).toBe(ProtocolErrorCode.E_LOOP)
    }
  })

  test('throws E_TOO_MANY_HOPS past the limit', () => {
    let message = base
    for (let i = 0; i < LIMITS.maxHops; i += 1) {
      message = withHop(message, `n${i}`)
    }
    expect(message.hops).toHaveLength(LIMITS.maxHops)
    try {
      withHop(message, 'one-too-many')
      throw new Error('expected withHop to throw')
    } catch (error) {
      expect((error as ProtocolError).code).toBe(
        ProtocolErrorCode.E_TOO_MANY_HOPS,
      )
    }
  })
})

describe('ttl and size', () => {
  const message = createMessage({
    from: FROM,
    to: TO,
    type: MessageType.Ping,
    payload: null,
    createdAt: 10_000,
    ttlMs: 1_000,
  })

  test('isExpired follows the injected clock', () => {
    expect(isExpired(message, 10_500)).toBe(false)
    expect(isExpired(message, 11_000)).toBe(false)
    expect(isExpired(message, 11_001)).toBe(true)
  })

  test('messageBytes measures the utf-8 serialization', () => {
    expect(messageBytes(message)).toBe(
      new TextEncoder().encode(serializeMessage(message)).length,
    )
    const wide = createMessage({
      from: FROM,
      to: TO,
      type: MessageType.Ping,
      payload: '阡陌',
      createdAt: 10_000,
    })
    expect(messageBytes(wide)).toBeGreaterThan(JSON.stringify(wide).length - 6)
  })
})

describe('errorReply', () => {
  test('addresses the reply back to the sender and keeps the trace', () => {
    const original = createMessage({
      from: FROM,
      to: TO,
      type: MessageType.TaskRequest,
      payload: {},
      traceId: 'trace-9',
    })
    const reply = errorReply(
      original,
      ProtocolErrorCode.E_UNKNOWN_AGENT,
      'no such agent',
      5_000,
    )
    expect(reply.type).toBe(MessageType.Error)
    expect(reply.from).toBe(TO)
    expect(reply.to).toBe(FROM)
    expect(reply.traceId).toBe('trace-9')
    expect(reply.payload.code).toBe(ProtocolErrorCode.E_UNKNOWN_AGENT)
    expect(reply.payload.ofMsgId).toBe(original.msgId)
  })
})
