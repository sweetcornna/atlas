import { afterEach, describe, expect, mock, test } from 'bun:test'
import {
  registerSessionActivityCallback,
  sendSessionActivitySignal,
  startSessionActivity,
  stopSessionActivity,
  unregisterSessionActivityCallback,
} from '../sessionActivity.js'

afterEach(() => {
  unregisterSessionActivityCallback()
})

describe('session activity transitions', () => {
  test('reports only outer busy and idle transitions', () => {
    const callback = mock((_active: boolean) => {})
    registerSessionActivityCallback(callback)

    startSessionActivity('api_call')
    startSessionActivity('tool_exec')
    stopSessionActivity('tool_exec')
    stopSessionActivity('api_call')

    expect(callback.mock.calls).toEqual([[true], [false]])
  })

  test('manual signals report the current state', () => {
    const previous = process.env.CLAUDE_CODE_REMOTE_SEND_KEEPALIVES
    process.env.CLAUDE_CODE_REMOTE_SEND_KEEPALIVES = '1'
    try {
      const callback = mock((_active: boolean) => {})
      registerSessionActivityCallback(callback)

      sendSessionActivitySignal()
      startSessionActivity('api_call')
      sendSessionActivitySignal()
      stopSessionActivity('api_call')

      expect(callback.mock.calls).toEqual([[false], [true], [true], [false]])
    } finally {
      if (previous === undefined) {
        delete process.env.CLAUDE_CODE_REMOTE_SEND_KEEPALIVES
      } else {
        process.env.CLAUDE_CODE_REMOTE_SEND_KEEPALIVES = previous
      }
    }
  })
})
