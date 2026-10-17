// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `qm runtime-mcp` — the MCP server a resident Claude Code or Codex process
 * starts to reach its node's `qianmo_*` host tools.
 *
 * It holds no policy and no state: `tools/list` and `tools/call` are relayed
 * line by line to the resident host's loopback tool endpoint
 * (`host/runtimes/toolHost.ts`) with the session token the host wrote into
 * `--token-file`. The host decides what the session may do.
 */

import { lstatSync, readFileSync } from 'node:fs'
import { connect, type Socket } from 'node:net'
import { createInterface } from 'node:readline'
import type {
  CallToolResult,
  ListToolsResult,
  Tool,
} from '@modelcontextprotocol/server'
import { Server } from '@modelcontextprotocol/server'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { buildVersion } from '../provenance.js'

const USAGE = `Usage: qm runtime-mcp --port <loopback port> --token-file <abs path>

Started by a resident node's Claude Code or Codex process; not for direct use.
`

interface Options {
  readonly port: number
  readonly token: string
}

function parse(argv: readonly string[]): Options | string {
  let port: number | undefined
  let tokenFile: string | undefined
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    const value = argv[index + 1]
    if (arg === '--port' && value !== undefined) {
      port = Number(value)
      index++
    } else if (arg === '--token-file' && value !== undefined) {
      tokenFile = value
      index++
    } else return `unknown argument: ${arg}`
  }
  if (port === undefined || !Number.isInteger(port) || port < 1 || port > 65535)
    return '--port must be a TCP port'
  if (tokenFile === undefined || !tokenFile.startsWith('/'))
    return '--token-file must be an absolute path'
  const stat = lstatSync(tokenFile, { throwIfNoEntry: false })
  if (!stat?.isFile() || (stat.mode & 0o077) !== 0)
    return '--token-file must be a regular file readable only by its owner'
  return { port, token: readFileSync(tokenFile, 'utf8').trim() }
}

/** One line-framed connection to the host, opened lazily, reopened on loss. */
class HostLink {
  readonly #options: Options
  readonly #pending = new Map<
    number,
    (reply: Record<string, unknown>) => void
  >()
  #socket: Socket | undefined
  #sequence = 0

  constructor(options: Options) {
    this.#options = options
  }

  #open(): Socket {
    if (this.#socket && !this.#socket.destroyed) return this.#socket
    const socket = connect(this.#options.port, '127.0.0.1')
    this.#socket = socket
    const fail = () => {
      if (this.#socket === socket) this.#socket = undefined
      for (const [id, settle] of this.#pending) {
        this.#pending.delete(id)
        settle({ error: 'the resident host is not reachable' })
      }
    }
    socket.on('error', fail)
    socket.on('close', fail)
    createInterface({ input: socket }).on('line', line => {
      let reply: Record<string, unknown>
      try {
        reply = JSON.parse(line) as Record<string, unknown>
      } catch {
        return
      }
      const settle =
        typeof reply.id === 'number' ? this.#pending.get(reply.id) : undefined
      if (settle === undefined) return
      this.#pending.delete(reply.id as number)
      settle(reply)
    })
    return socket
  }

  request(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = ++this.#sequence
    return new Promise(resolve => {
      this.#pending.set(id, resolve)
      this.#open().write(
        `${JSON.stringify({ ...body, id, token: this.#options.token })}\n`,
      )
    })
  }

  close(): void {
    this.#socket?.destroy()
  }
}

function text(value: string, isError = false): CallToolResult {
  return {
    content: [{ type: 'text', text: value }],
    ...(isError ? { isError: true } : {}),
  }
}

/** The host's text and image parts as MCP content; anything else is dropped. */
function mcpContent(value: unknown): CallToolResult['content'] {
  const content: CallToolResult['content'] = []
  for (const part of Array.isArray(value) ? value : []) {
    const item = part as Record<string, unknown>
    if (item.type === 'text' && typeof item.text === 'string')
      content.push({ type: 'text', text: item.text })
    else if (
      item.type === 'image' &&
      typeof item.data === 'string' &&
      typeof item.mimeType === 'string'
    )
      content.push({ type: 'image', data: item.data, mimeType: item.mimeType })
  }
  return content
}

function buildServer(link: HostLink): Server {
  const server = new Server(
    { name: 'qianmo', version: buildVersion() },
    { capabilities: { tools: {} } },
  )
  server.setRequestHandler('tools/list', async (): Promise<ListToolsResult> => {
    const reply = await link.request({ method: 'list' })
    const tools = Array.isArray(reply.tools) ? (reply.tools as Tool[]) : []
    return { tools }
  })
  server.setRequestHandler(
    'tools/call',
    async ({ params }): Promise<CallToolResult> => {
      const reply = await link.request({
        method: 'call',
        name: params.name,
        args: params.arguments ?? {},
      })
      if (typeof reply.error === 'string') return text(reply.error, true)
      const result = reply.result as {
        ok?: unknown
        text?: unknown
        content?: unknown
      }
      const isError = result?.ok !== true
      const content = mcpContent(result?.content)
      if (content.length > 0)
        return { content, ...(isError ? { isError: true } : {}) }
      return text(typeof result?.text === 'string' ? result.text : '', isError)
    },
  )
  return server
}

export async function run(argv: readonly string[]): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(USAGE)
    return 0
  }
  const options = parse(argv)
  if (typeof options === 'string') {
    process.stderr.write(`qm runtime-mcp: ${options}\n${USAGE}`)
    return 2
  }
  const link = new HostLink(options)
  const handle = serveStdio(() => buildServer(link), {
    onerror: error => {
      process.stderr.write(`qm runtime-mcp: ${error.message}\n`)
    },
  })
  const end = () => {
    link.close()
    void handle.close().catch(() => {})
  }
  process.stdin.on('end', end)
  process.stdin.on('close', end)
  return 0
}
