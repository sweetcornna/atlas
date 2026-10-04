// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * hermes #21 — the three lossless tool-schema rules on the chat wire
 * (P18.12). Schemas are constructed in the shapes hermes records
 * (`tools/schema_sanitizer.py`: zod/Pydantic `type: [X, "null"]`, MCP
 * objects without `properties`, `{"$ref": …, "default": null}`).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { ChatCompletionTool } from 'openai/resources/chat/completions/completions.mjs'
import { setupSettingsMock } from '../../../../../tests/mocks/settings.js'
import {
  applyChatSchemaRules,
  applyLosslessSchemaRules,
} from '../schemaRules.js'
import { captureOpenAIRequests } from './support/requestCapture.js'

const settingsMock = setupSettingsMock()
beforeAll(() => settingsMock.set({ getInitialSettings: () => ({}) }))
afterAll(() => settingsMock.reset())

const HOSTILE = {
  type: 'object',
  properties: {
    note: { type: ['string', 'null'], description: 'optional' },
    either: { type: ['number', 'string'] },
    meta: { type: 'object', additionalProperties: { type: 'string' } },
    ref: { $ref: '#/$defs/Mode', default: null },
    list: { type: 'array', items: { type: ['integer', 'null'] } },
  },
  $defs: { Mode: { type: 'string', enum: ['a', 'b'] } },
  required: ['either'],
}

describe('applyLosslessSchemaRules', () => {
  test('the three rules, at every level', () => {
    expect(applyLosslessSchemaRules(HOSTILE)).toEqual({
      type: 'object',
      properties: {
        note: { type: 'string', nullable: true, description: 'optional' },
        either: { anyOf: [{ type: 'number' }, { type: 'string' }] },
        meta: {
          type: 'object',
          additionalProperties: { type: 'string' },
          properties: {},
        },
        ref: { $ref: '#/$defs/Mode' },
        list: { type: 'array', items: { type: 'integer', nullable: true } },
      },
      $defs: { Mode: { type: 'string', enum: ['a', 'b'] } },
      required: ['either'],
    })
  })

  test('a schema none apply to is the same object (same bytes on the wire)', () => {
    const fine = {
      type: 'object',
      properties: { path: { type: 'string' }, n: { type: 'integer' } },
      required: ['path'],
    }
    expect(applyLosslessSchemaRules(fine)).toBe(fine)
  })

  test('enum / required / default values are not walked as schemas', () => {
    const literal = {
      type: 'object',
      properties: { kind: { type: 'string', enum: ['object', 'null'] } },
      required: ['kind'],
    }
    expect(applyLosslessSchemaRules(literal)).toBe(literal)
  })

  test('the input is not mutated', () => {
    const copy = structuredClone(HOSTILE)
    applyLosslessSchemaRules(HOSTILE)
    expect(HOSTILE).toEqual(copy)
  })
})

describe('applyChatSchemaRules', () => {
  const tools: ChatCompletionTool[] = [
    {
      type: 'function',
      function: { name: 'T', description: '', parameters: HOSTILE },
    },
  ]

  test('Responses wire (the live path): untouched', () => {
    expect(applyChatSchemaRules(tools, 'responses')).toBe(tools)
  })

  test('chat wire: rewritten', () => {
    const [tool] = applyChatSchemaRules(tools, 'chat')
    expect(
      (
        tool as unknown as {
          function: { parameters: { properties: { note: unknown } } }
        }
      ).function.parameters.properties.note,
    ).toEqual({ type: 'string', nullable: true, description: 'optional' })
  })
})

describe('chat lane, end to end', () => {
  test('a type array from the tool schema does not reach the wire', async () => {
    // Minimal tool: what toolToAPISchema reads (an MCP-style JSON schema).
    const tool = {
      name: 'NullableP1812',
      inputJSONSchema: {
        type: 'object',
        properties: { note: { type: ['string', 'null'] } },
      },
      prompt: async () => 'd',
    }
    const [request] = await captureOpenAIRequests({
      model: 'vendor-model-x',
      baseURL: 'https://gateway.example/v1',
      env: { OPENAI_WIRE_API: 'chat' },
      tools: [tool as never],
    })
    const [sent] = request!.body.tools as {
      function: { parameters: { properties: { note: unknown } } }
    }[]
    expect(sent.function.parameters.properties.note).toEqual({
      type: 'string',
      nullable: true,
    })
  })
})
