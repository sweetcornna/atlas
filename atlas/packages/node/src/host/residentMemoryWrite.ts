// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

export const MEMORY_WRITE_TOOL = {
  name: 'qianmo_memory_write',
  description:
    'Propose a durable memory in this running agent and requester context only. Every write waits for a separate personal allow-once approval; no memory is written on timeout or denial. Do not place secrets or instructions to future agents in memory.',
  loadMode: 'essential' as const,
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      title: { type: 'string', minLength: 1, maxLength: 200 },
      summary: { type: 'string', minLength: 1, maxLength: 1000 },
      body: { type: 'string', maxLength: 20000 },
      tags: {
        type: 'array',
        maxItems: 32,
        items: { type: 'string', maxLength: 64 },
      },
    },
    required: ['title', 'summary', 'body'],
  },
}

export function parseMemoryWrite(input: unknown): {
  title: string
  summary: string
  body: string
  tags?: readonly string[]
} {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('memory proposal must be an object')
  const value = input as Record<string, unknown>
  if (
    Object.keys(value).some(
      key => !['title', 'summary', 'body', 'tags'].includes(key),
    ) ||
    typeof value.title !== 'string' ||
    !value.title.trim() ||
    value.title.length > 200 ||
    /[\r\n]/.test(value.title) ||
    typeof value.summary !== 'string' ||
    !value.summary.trim() ||
    value.summary.length > 1000 ||
    /[\r\n]/.test(value.summary) ||
    typeof value.body !== 'string' ||
    value.body.length > 20000 ||
    (value.tags !== undefined &&
      (!Array.isArray(value.tags) ||
        value.tags.length > 32 ||
        value.tags.some(
          tag =>
            typeof tag !== 'string' || tag.length > 64 || /[\r\n]/.test(tag),
        )))
  )
    throw new Error('invalid memory proposal')
  return {
    title: value.title,
    summary: value.summary,
    body: value.body,
    ...(value.tags === undefined ? {} : { tags: value.tags as string[] }),
  }
}
