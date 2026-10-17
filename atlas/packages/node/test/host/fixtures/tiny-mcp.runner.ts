// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * A minimal stdio MCP server with one tool, `search` (P32 tests). With
 * `TINY_MCP_ENV_LOG` set it appends the names in its environment there.
 */
import { appendFileSync } from 'node:fs'

if (process.env.TINY_MCP_ENV_LOG)
  appendFileSync(
    process.env.TINY_MCP_ENV_LOG,
    `${JSON.stringify(Object.keys(process.env).sort())}\n`,
  )

const decoder = new TextDecoder()
let buffer = ''
function reply(id: unknown, result: unknown): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`)
}
for await (const chunk of Bun.stdin.stream()) {
  buffer += decoder.decode(chunk)
  let at: number
  while ((at = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, at)
    buffer = buffer.slice(at + 1)
    if (line.trim() === '') continue
    const message = JSON.parse(line) as {
      id?: unknown
      method: string
      params?: Record<string, unknown>
    }
    if (message.id === undefined) continue
    if (message.method === 'initialize')
      reply(message.id, {
        protocolVersion: message.params?.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'tiny', version: '1.0.0' },
      })
    else if (message.method === 'tools/list')
      reply(message.id, {
        tools: [
          {
            name: 'search',
            description: 'Search the docs',
            inputSchema: {
              type: 'object',
              properties: { q: { type: 'string' } },
            },
          },
        ],
      })
    else if (message.method === 'tools/call') {
      const args = (message.params?.arguments ?? {}) as { q?: string }
      reply(message.id, {
        content: [
          {
            type: 'text',
            text: `found: ${args.q ?? ''} (${process.env.DOCS_TOKEN ?? 'no token'})`,
          },
        ],
      })
    } else reply(message.id, {})
  }
}
