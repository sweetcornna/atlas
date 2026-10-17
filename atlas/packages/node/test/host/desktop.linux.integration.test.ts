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

/**
 * The private desktop on a real Linux node (runtimes-channels.md §6.3, §6.7):
 * Xvfb, a window manager, headed Chromium and desktop applications in
 * bubblewrap, driven like a person through MCP by an agent on Claude Code.
 * Needs Xvfb, xauth, Chromium, openbox, bubblewrap and mousepad; skipped
 * elsewhere. Run on the acceptance VM:
 *   bun test --preload ./atlas/tests/preload.ts ./atlas/packages/node/test/host/desktop.linux.integration.test.ts
 */
const available =
  process.platform === 'linux' &&
  ['Xvfb', 'xauth', 'openbox', 'bwrap', 'mousepad'].every(
    program => Bun.which(program) !== null,
  ) &&
  (Bun.which('chromium') !== null || Bun.which('google-chrome') !== null)

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
        clientInfo: { name: 'desktop-linux-test', version: '0' },
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
      const result = reply.result as { content: McpPart[]; isError?: boolean }
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

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

test.skipIf(!available)(
  'Linux private desktop: confined session, apps by allowlist, batched human-like input, headed browser, autonomous confirmation, view and recycle',
  async () => {
    const root = isolatedRoot()
    cleanups.push(() => root.dispose())
    const workspace = `${root.root}-workspace`
    mkdirSync(workspace, { recursive: true })
    cleanups.push(() => rmSync(workspace, { recursive: true, force: true }))
    const page = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: () =>
        new Response(
          '<!doctype html><html><body><h1>Qmo Linux desktop</h1></body></html>',
          { headers: { 'Content-Type': 'text/html' } },
        ),
    })
    cleanups.push(() => page.stop(true))

    const node = new NodeDesktop({
      node: 'worker',
      agents: ['coder'],
      estop: () => false,
    })
    cleanups.push(() => node.close())
    const ops = { peer: 'hub', actor: 'ops', taskId: 'op' }
    const enabled = await node.control(
      'desktop.enable',
      {
        agent: 'coder',
        browser: true,
        computer: true,
        confirm: 'autonomous',
        apps: 'all',
        terminal: false,
        operationId: 'on',
      },
      ops,
    )
    expect(enabled.ok).toBe(true)
    const status = (await node.control('desktop.status', {}, ops)) as {
      ok: true
      value: {
        computer: {
          state: string
          windowManager?: string | null
          confined?: boolean
        }
      }[]
    }
    const computer = status.value[0]!.computer
    expect(computer.state).toBe('running')
    expect(computer.windowManager).toBe('openbox')
    expect(computer.confined).toBe(true)
    const pids = () =>
      (
        JSON.parse(
          readFileSync(
            join(root.root, 'qianmo', 'desktop-ledger.json'),
            'utf8',
          ),
        ) as { states: { pids: { pid: number }[] }[] }
      ).states.flatMap(s => s.pids.map(p => p.pid))

    const launches: ExternalRuntimeSpawn[] = []
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
    await new OmpResidentTurnPort(pool, {}).execute(
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
    for (const name of [
      'qianmo_computer_actions',
      'qianmo_computer_windows',
      'qianmo_computer_apps',
      'qianmo_computer_open_app',
      'qianmo_browser_navigate',
    ])
      expect(names).toContain(name)

    // Applications: the allowlist, without terminals.
    const apps = JSON.parse(
      (await mcp.call('qianmo_computer_apps', {})).text,
    ) as { id: string; name: string; terminal: boolean }[]
    const mousepad = apps.find(app => app.id.includes('mousepad'))
    expect(mousepad).toBeDefined()
    expect(apps.some(app => app.terminal)).toBe(false)
    const refused = await mcp.call('qianmo_computer_open_app', {
      app: 'debian-xterm',
    })
    expect(refused.isError).toBe(true)

    const opened = await mcp.call('qianmo_computer_open_app', {
      app: mousepad!.id,
    })
    expect(opened.isError).toBe(false)
    let editor:
      | {
          id: string
          title: string
          x: number
          y: number
          width: number
          height: number
        }
      | undefined
    for (let i = 0; i < 50 && editor === undefined; i++) {
      await Bun.sleep(200)
      const windows = JSON.parse(
        (await mcp.call('qianmo_computer_windows', {})).text,
      ) as {
        id: string
        app: string
        title: string
        x: number
        y: number
        width: number
        height: number
      }[]
      editor = windows.find(w => /mousepad/i.test(`${w.app} ${w.title}`))
    }
    expect(editor).toBeDefined()

    // Like a person: look first, then click into the editor, type, select
    // all, in one batch that ends with a screenshot. Autonomous: no approval.
    const look = await mcp.call('qianmo_computer_screenshot', {})
    expect(look.isError).toBe(false)
    expect(look.content.some(part => part.type === 'image')).toBe(true)
    const batch = await mcp.call('qianmo_computer_actions', {
      actions: [
        {
          type: 'click',
          x: editor!.x + Math.floor(editor!.width / 2),
          y: editor!.y + Math.floor(editor!.height / 2),
        },
        { type: 'type', text: 'hello qmo' },
        { type: 'keypress', keys: ['ctrl', 'a'] },
        { type: 'wait', ms: 300 },
      ],
    })
    expect(batch.isError).toBe(false)
    expect(batch.content.some(part => part.type === 'image')).toBe(true)
    expect(approvals).toEqual([])
    const titled = JSON.parse(
      (await mcp.call('qianmo_computer_windows', {})).text,
    ) as { app: string; title: string }[]
    // Mousepad marks a modified document in its title.
    expect(
      titled.some(
        w => /mousepad/i.test(`${w.app} ${w.title}`) && w.title.includes('*'),
      ),
    ).toBe(true)

    // A call that says why it needs a person goes to the operator once.
    const confirmed = await mcp.call('qianmo_computer_key', {
      key: 'ctrl+s',
      confirm: '保存文件前确认',
    })
    expect(approvals).toEqual(['qianmo_computer_key'])
    expect(confirmed.isError).toBe(false)

    // The browser runs headed on the same display.
    const tab = node.resource('coder')!.tab
    const navigated = await mcp.call('qianmo_browser_navigate', {
      tab,
      url: `http://127.0.0.1:${page.port}/`,
    })
    expect(navigated.isError).toBe(false)
    const browserWindows = JSON.parse(
      (await mcp.call('qianmo_computer_windows', {})).text,
    ) as { app: string; title: string }[]
    expect(browserWindows.some(w => /chrom/i.test(`${w.app} ${w.title}`))).toBe(
      true,
    )

    // The operator sees the latest screen.
    const view = (await node.control(
      'desktop.view',
      { agent: 'coder' },
      ops,
    )) as {
      ok: true
      value: { mimeType: string; data: string } | null
    }
    expect(view.value?.mimeType).toMatch(/^image\//)

    // Recycle: every process gone, the private data removed.
    const before = pids()
    expect(before.length).toBeGreaterThanOrEqual(3)
    const recycled = await node.control(
      'desktop.recycle',
      { agent: 'coder', operationId: 'recycle' },
      ops,
    )
    expect(recycled.ok).toBe(true)
    for (const pid of before) expect(alive(pid)).toBe(false)
    expect(existsSync(join(root.root, 'qianmo', 'desktop', 'coder'))).toBe(
      false,
    )
  },
  180_000,
)
