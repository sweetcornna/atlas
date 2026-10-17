// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, expect, test } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { OmpResidentTurnPort } from '@qianmo/resident'
import { NodeDesktop } from '../../src/host/desktop.js'
import {
  ExternalRuntimePool,
  type ExternalRuntimeSpawn,
} from '../../src/host/runtimes/pool.js'
import { isolatedRoot } from '../providers/fake.js'

const FAKE_CLAUDE = join(
  import.meta.dir,
  'fixtures',
  'fake-claude-code.runner.ts',
)

const children: ChildProcess[] = []
const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  for (const child of children.splice(0))
    if (child.exitCode === null && child.signalCode === null) child.kill()
})

interface McpPart {
  readonly type: string
  readonly text?: string
  readonly data?: string
  readonly mimeType?: string
}

/** Speaks MCP to the `qm runtime-mcp` a Claude Code process would start. */
function mcpClient(launch: ExternalRuntimeSpawn) {
  const config = JSON.parse(
    readFileSync(join(launch.sessionDir, 'runtime-mcp.json'), 'utf8'),
  ) as { mcpServers: Record<string, { command: string; args: string[] }> }
  const server = config.mcpServers.qianmo!
  const child = spawn(server.command, server.args, {
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  children.push(child)
  const waiting = new Map<number, (reply: Record<string, unknown>) => void>()
  let buffer = ''
  child.stdout!.on('data', (chunk: Buffer) => {
    buffer += chunk.toString()
    let index: number
    while ((index = buffer.indexOf('\n')) !== -1) {
      const reply = JSON.parse(buffer.slice(0, index)) as Record<
        string,
        unknown
      >
      buffer = buffer.slice(index + 1)
      waiting.get(reply.id as number)?.(reply)
    }
  })
  let sequence = 0
  const request = (method: string, params: Record<string, unknown> = {}) =>
    new Promise<Record<string, unknown>>(resolve => {
      const id = ++sequence
      waiting.set(id, resolve)
      child.stdin!.write(
        `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`,
      )
    })
  return {
    async open() {
      await request('initialize', {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'runtime-desktop-test', version: '0' },
      })
      child.stdin!.write(
        `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
      )
    },
    async names(): Promise<string[]> {
      const listed = await request('tools/list')
      return (listed.result as { tools: { name: string }[] }).tools.map(
        tool => tool.name,
      )
    },
    async call(name: string, args: Record<string, unknown>) {
      const reply = await request('tools/call', { name, arguments: args })
      const result = reply.result as {
        content: McpPart[]
        isError?: boolean
      }
      return {
        content: result.content,
        text: result.content
          .filter(part => part.type === 'text')
          .map(part => part.text)
          .join('\n'),
        isError: result.isError === true,
      }
    },
  }
}

/**
 * Chrome or Chromium where `NodeDesktop` starts it (host/desktop.ts): the app
 * bundle on macOS, `google-chrome` or `chromium` on Linux, where the browser
 * alone runs headless and needs no display.
 */
const browserAvailable =
  process.platform === 'darwin'
    ? existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    : process.platform === 'linux' &&
      (Bun.which('google-chrome') !== null || Bun.which('chromium') !== null)

/**
 * Real Chrome, a real `qm desktop-exec` child and the real `qm runtime-mcp`
 * bridge: an agent on Claude Code drives its private browser through MCP,
 * with the same lease and one-time approvals as qianmopi (§6.1).
 */
test.skipIf(!browserAvailable)(
  'external runtime: browser tools over MCP, screenshots come back as images, a denied click has no effect, an approved one runs once',
  async () => {
    const root = isolatedRoot()
    cleanups.push(() => root.dispose())
    const workspace = `${root.root}-workspace`
    mkdirSync(workspace, { recursive: true })
    cleanups.push(() => rmSync(workspace, { recursive: true, force: true }))
    let clicks = 0
    const page = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: req => {
        if (new URL(req.url).pathname === '/clicked') {
          clicks++
          return new Response('ok')
        }
        return new Response(
          '<!doctype html><html><body><h1>P21 runtime fixture</h1><button id="send" onclick="document.querySelector(\'#status\').textContent=\'clicked\';fetch(\'/clicked\')">Send</button><p id="status">untouched</p></body></html>',
          { headers: { 'Content-Type': 'text/html' } },
        )
      },
    })
    cleanups.push(() => page.stop(true))
    const node = new NodeDesktop({
      node: 'worker',
      agents: ['coder'],
      estop: () => false,
    })
    cleanups.push(() => node.close())
    const enabled = await node.control(
      'desktop.enable',
      { agent: 'coder', browser: true, operationId: 'on' },
      { peer: 'hub', actor: 'ops', taskId: 'on' },
    )
    expect(enabled.ok).toBe(true)
    const tab = node.resource('coder')!.tab

    const launches: ExternalRuntimeSpawn[] = []
    let turn: OmpResidentTurnPort | undefined
    let approveClick = false
    const approvals: string[] = []
    const pool = new ExternalRuntimePool({
      agents: [{ agent: 'coder', cwd: workspace, runtime: 'claude-code' }],
      resolveLaunch: () => ({
        model: 'fake-model',
        baseUrl: 'http://127.0.0.1:9/v1',
        apiKey: 'sk-test-runtime',
      }),
      memoryRoot: join(root.root, 'memory'),
      hostTools: { announce: async () => ({ status: 'sent' }) },
      desktop: node,
      requestPermission: async (sessionId, raw) =>
        node.decide(
          'coder',
          sessionId,
          'task-1',
          'ctx',
          raw,
          () => true,
          async (call, before) => {
            approvals.push(call.toolName)
            if (call.toolName === 'qianmo_browser_click' && !approveClick)
              return false
            return before(undefined, `request-${approvals.length}`, () => true)
          },
        ),
      spawn: input => {
        launches.push(input)
        const child = spawn(
          process.execPath,
          [FAKE_CLAUDE, ...input.argv.slice(1)],
          { cwd: input.cwd, env: input.env, stdio: ['pipe', 'pipe', 'pipe'] },
        )
        children.push(child)
        return child
      },
    })
    cleanups.push(() => pool.stop())
    const session = await pool.newSession({ agent: 'coder', cwd: workspace })
    turn = new OmpResidentTurnPort(pool, {})
    await turn.execute(
      {
        sessionId: session,
        messageId: 'm-1',
        prompt: 'hello',
        networkMsgId: 'net-m-1',
      },
      async () => {},
    )
    const mcp = mcpClient(launches[0]!)
    await mcp.open()

    const names = await mcp.names()
    expect(names).toContain('qianmo_browser_navigate')
    expect(names).toContain('qianmo_browser_screenshot')
    // Only the browser is on: no computer tools.
    expect(names.some(name => name.startsWith('qianmo_computer_'))).toBe(false)

    const tabs = await mcp.call('qianmo_browser_tabs', {})
    expect(tabs.isError).toBe(false)
    expect(tabs.text).toContain(tab)

    const navigated = await mcp.call('qianmo_browser_navigate', {
      tab,
      url: `http://127.0.0.1:${page.port}/`,
    })
    expect(navigated.isError).toBe(false)
    expect(approvals).toEqual(['qianmo_browser_navigate'])

    const shot = await mcp.call('qianmo_browser_screenshot', { tab })
    expect(shot.isError).toBe(false)
    const image = shot.content.find(part => part.type === 'image')
    expect(image?.mimeType).toMatch(/^image\//)
    expect((image?.data ?? '').length).toBeGreaterThan(1000)

    const read = await mcp.call('qianmo_browser_read_page', { tab })
    expect(read.text).toContain('P21 runtime fixture')
    expect(read.text).toContain('untouched')

    const denied = await mcp.call('qianmo_browser_click', {
      tab,
      selector: '#send',
    })
    expect(denied.isError).toBe(true)
    expect(clicks).toBe(0)
    expect(
      (await mcp.call('qianmo_browser_read_page', { tab })).text,
    ).toContain('untouched')

    approveClick = true
    const clicked = await mcp.call('qianmo_browser_click', {
      tab,
      selector: '#send',
    })
    expect(clicked.isError).toBe(false)
    await Bun.sleep(200)
    expect(clicks).toBe(1)

    // Unknown fields are refused whole, never run with the rest.
    const smuggled = await mcp.call('qianmo_browser_click', {
      tab,
      selector: '#send',
      code: 'process.exit()',
    })
    expect(smuggled.isError).toBe(true)
    expect(clicks).toBe(1)

    // A stopped browser leaves the tool list on the next listing.
    await node.control(
      'desktop.disable',
      { agent: 'coder', operationId: 'off' },
      { peer: 'hub', actor: 'ops', taskId: 'off' },
    )
    expect(
      (await mcp.names()).some(name => name.startsWith('qianmo_browser_')),
    ).toBe(false)
    const after = await mcp.call('qianmo_browser_tabs', {})
    expect(after.isError).toBe(true)
    expect(after.text).toContain('专属浏览器')
  },
  120_000,
)
