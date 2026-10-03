// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * hermes #20 — images in tool results on the chat lane: sent as a parts list
 * by default, dropped and remembered when the endpoint refuses (P18.12).
 *
 * The refusal bodies are constructed from hermes's record of each vendor
 * (`agent/error_classifier.py:296-311`: Xiaomi MiMo's `{"error":{"code":
 * "400","message":"Param Incorrect","param":"text is not set"}}`, …). No
 * vendor was called.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { anthropicMessagesToOpenAI } from '@ant/model-provider'
import type { Message } from 'src/types/message.js'
import { setupSettingsMock } from '../../../../../tests/mocks/settings.js'
import {
  isToolImageRejection,
  TOOL_IMAGE_REMOVED_PLACEHOLDER,
} from '../toolResultImages.js'
import { captureOpenAIRequests } from './support/requestCapture.js'

const settingsMock = setupSettingsMock()
beforeAll(() => settingsMock.set({ getInitialSettings: () => ({}) }))
afterAll(() => settingsMock.reset())

const PNG = 'iVBORw0KGgo='

function history(toolContent: unknown[]): Message[] {
  return [
    { type: 'user', uuid: 'u1', message: { role: 'user', content: 'look' } },
    {
      type: 'assistant',
      uuid: 'a1',
      message: {
        id: 'm1',
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'toolu_1', name: 'Screenshot', input: {} },
        ],
      },
    },
    {
      type: 'user',
      uuid: 'u2',
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_1', content: toolContent },
        ],
      },
    },
  ] as unknown as Message[]
}

const WITH_IMAGE = [
  { type: 'text', text: 'Screenshot taken' },
  {
    type: 'image',
    source: { type: 'base64', media_type: 'image/png', data: PNG },
  },
]

function toolMessages(body: Record<string, unknown>) {
  return (body.messages as Record<string, unknown>[]).filter(
    m => m.role === 'tool',
  )
}

describe('conversion', () => {
  const convert = (toolResultImages: boolean, content: unknown[]) =>
    anthropicMessagesToOpenAI(history(content) as never, [] as never, {
      toolResultImages,
    }).filter(m => m.role === 'tool')

  test('on: text + image_url parts, in order', () => {
    expect(convert(true, WITH_IMAGE)).toEqual([
      {
        role: 'tool',
        tool_call_id: 'toolu_1',
        content: [
          { type: 'text', text: 'Screenshot taken' },
          {
            type: 'image_url',
            image_url: { url: `data:image/png;base64,${PNG}` },
          },
        ],
      },
    ] as never)
  })

  test('off (the default, and the Responses wire): text only, as before', () => {
    expect(convert(false, WITH_IMAGE)).toEqual([
      { role: 'tool', tool_call_id: 'toolu_1', content: 'Screenshot taken' },
    ])
  })

  test('on, but no image: the same string as before', () => {
    expect(convert(true, [{ type: 'text', text: 'plain' }])).toEqual([
      { role: 'tool', tool_call_id: 'toolu_1', content: 'plain' },
    ])
  })
})

describe('the refusal table', () => {
  test.each([
    { code: '400', message: 'Param Incorrect', param: 'text is not set' },
    { message: 'tool message content must be a string' },
    { message: 'messages.2.content: expected string, got list' },
    { message: 'tool_call.content must be string' },
    // Qianmo addition: a 400 naming the image.
    { message: 'Invalid content type. image_url is not supported' },
  ])('%o', body => {
    expect(
      isToolImageRejection({ status: 400, error: body, message: '400' }),
    ).toBe(true)
  })

  test('not a refusal: another 400, or a 500 mentioning images', () => {
    expect(
      isToolImageRejection({ status: 400, error: { message: 'bad tools' } }),
    ).toBe(false)
    expect(
      isToolImageRejection({
        status: 500,
        error: { message: 'image worker down' },
      }),
    ).toBe(false)
  })
})

describe('chat lane, end to end', () => {
  const MIMO_REFUSAL = {
    status: 400,
    body: {
      error: {
        code: '400',
        message: 'Param Incorrect',
        param: 'text is not set',
      },
    },
  }

  test('sent as a list by default', async () => {
    const [request] = await captureOpenAIRequests({
      model: 'vision-model-a',
      baseURL: 'https://gateway.example/v1',
      env: { OPENAI_WIRE_API: 'chat' },
      messages: history(WITH_IMAGE),
    })
    const [tool] = toolMessages(request!.body)
    expect(Array.isArray(tool!.content)).toBe(true)
  })

  test('refused: dropped to text, re-sent once, remembered for the next turn', async () => {
    const target = {
      model: 'mimo-v2.6-pro',
      baseURL: 'https://token-plan.example/v1',
      env: { OPENAI_WIRE_API: 'chat' },
    }
    const outputs: unknown[] = []
    const first = await captureOpenAIRequests({
      ...target,
      messages: history(WITH_IMAGE),
      failFirst: [MIMO_REFUSAL],
      outputs,
    })
    expect(first).toHaveLength(2)
    expect(Array.isArray(toolMessages(first[0]!.body)[0]!.content)).toBe(true)
    expect(toolMessages(first[1]!.body)[0]!.content).toBe('Screenshot taken')
    expect(
      outputs.some(
        o => (o as { isApiErrorMessage?: boolean }).isApiErrorMessage,
      ),
    ).toBe(false)

    // Next turn, same endpoint and model: no image from the start.
    const next = await captureOpenAIRequests({
      ...target,
      messages: history(WITH_IMAGE),
    })
    expect(next).toHaveLength(1)
    expect(toolMessages(next[0]!.body)[0]!.content).toBe('Screenshot taken')

    // Another model on that endpoint still gets the list.
    const other = await captureOpenAIRequests({
      ...target,
      model: 'mimo-v2.6-omni',
      messages: history(WITH_IMAGE),
    })
    expect(Array.isArray(toolMessages(other[0]!.body)[0]!.content)).toBe(true)
  })

  test('no text to keep: the placeholder', async () => {
    const requests = await captureOpenAIRequests({
      model: 'image-only-tool-model',
      baseURL: 'https://gateway.example/v1',
      env: { OPENAI_WIRE_API: 'chat' },
      messages: history([WITH_IMAGE[1]]),
      failFirst: [MIMO_REFUSAL],
    })
    expect(toolMessages(requests[1]!.body)[0]!.content).toBe(
      TOOL_IMAGE_REMOVED_PLACEHOLDER,
    )
  })

  test('Responses wire: unchanged (tool output stays text)', async () => {
    const [request] = await captureOpenAIRequests({
      model: 'vision-model-b',
      baseURL: 'https://gateway.example/v1',
      env: { OPENAI_WIRE_API: 'responses' },
      messages: history(WITH_IMAGE),
    })
    const output = (request!.body.input as Record<string, unknown>[]).find(
      item => item.type === 'function_call_output',
    )
    expect(output?.output).toBe('Screenshot taken')
  })
})
