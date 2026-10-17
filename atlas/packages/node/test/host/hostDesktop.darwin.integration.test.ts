// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, expect, test } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { OmpResidentTurnPort } from '@qianmo/resident'
import { NodeDesktop } from '../../src/host/desktop.js'
import {
  ExternalRuntimePool,
  type ExternalRuntimeSpawn,
} from '../../src/host/runtimes/pool.js'
import { isolatedRoot } from '../providers/fake.js'

/**
 * This Mac's own desktop (runtimes-channels.md §6.5) with the real Quartz
 * backend: an agent on Claude Code sees and types into TextEdit's window in
 * the background, and nothing else. It drives the real desktop, so it runs
 * only when asked (`QM_TEST_HOST_DESKTOP=1`), needs Screen Recording and
 * Accessibility for the process running it, and skips while TextEdit is
 * already open (it quits TextEdit at the end).
 */
const textEditRunning = () =>
  Bun.spawnSync(['pgrep', '-x', 'TextEdit']).exitCode === 0
const available =
  process.platform === 'darwin' &&
  process.env.QM_TEST_HOST_DESKTOP === '1' &&
  !textEditRunning()

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
        clientInfo: { name: 'host-desktop-test', version: '0' },
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

/** The frontmost application's bundle id, as Launch Services reports it. */
function frontmost(): string {
  const asn = Bun.spawnSync(['lsappinfo', 'front']).stdout.toString().trim()
  return Bun.spawnSync(['lsappinfo', 'info', '-only', 'bundleID', asn])
    .stdout.toString()
    .trim()
}

test.skipIf(!available)(
  "macOS host desktop: only TextEdit's windows, background input, the owner's foreground untouched",
  async () => {
    const root = isolatedRoot()
    cleanups.push(() => root.dispose())
    const workspace = `${root.root}-workspace`
    mkdirSync(workspace, { recursive: true })
    cleanups.push(() => rmSync(workspace, { recursive: true, force: true }))
    const name = `qmo-host-${process.pid}.txt`
    const file = join(workspace, name)
    writeFileSync(file, 'start\n')
    cleanups.push(() => {
      Bun.spawnSync(['pkill', '-x', 'TextEdit'])
    })

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
        computer: true,
        apps: ['com.apple.TextEdit'],
        confirm: 'autonomous',
        operationId: 'on',
      },
      ops,
    )
    expect(enabled.ok).toBe(true)

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
    expect(names).toContain('qianmo_computer_actions')
    expect(names).toContain('qianmo_computer_open_app')
    expect(names).not.toContain('qianmo_computer_clipboard_read')
    expect(names).not.toContain('qianmo_computer_focus')

    const apps = JSON.parse((await mcp.call('qianmo_computer_apps', {})).text)
    expect(apps).toEqual([
      { id: 'com.apple.TextEdit', name: 'TextEdit', terminal: false },
    ])

    // The owner's foreground before anything opens.
    const owner = frontmost()
    // TextEdit with a document, in the background.
    expect(Bun.spawnSync(['open', '-g', '-a', 'TextEdit', file]).exitCode).toBe(
      0,
    )
    let editor: { id: string; title: string } | undefined
    let listed: { id: string; app: string; title: string }[] = []
    let empty = ''
    for (let i = 0; i < 25 && editor === undefined; i++) {
      await Bun.sleep(200)
      const windows = await mcp.call('qianmo_computer_windows', {})
      expect(windows.isError).toBe(false)
      if (windows.text.startsWith('[]')) {
        empty = windows.text
        continue
      }
      listed = JSON.parse(windows.text)
      editor = listed.find(w => w.title.includes(name))
    }

    // A capture without a window would be the owner's screen: refused.
    const bare = await mcp.call('qianmo_computer_screenshot', {})
    expect(bare.isError).toBe(true)
    expect(bare.text).toContain('window')

    if (editor === undefined) {
      // The base lists the current Space only. With the owner in a
      // full-screen app, TextEdit's window is on another Space: the agent is
      // told why, and the input half of this test cannot run here.
      expect(empty).toContain('当前桌面空间')
      console.warn(
        'hostDesktop: TextEdit is not on the current Space; background input not exercised',
      )
    } else {
      // Only TextEdit's windows are there for the agent.
      expect(listed.every(w => w.app === 'TextEdit')).toBe(true)
      // Like a person, in the background: to the end, then type.
      const shot = await mcp.call('qianmo_computer_screenshot', {
        window: editor.id,
      })
      expect(shot.isError).toBe(false)
      expect(shot.content.some(part => part.type === 'image')).toBe(true)
      const batch = await mcp.call('qianmo_computer_actions', {
        window: editor.id,
        actions: [
          { type: 'keypress', keys: ['super', 'down'] },
          { type: 'type', text: 'hello qmo' },
          { type: 'wait', ms: 300 },
        ],
      })
      expect(batch.isError).toBe(false)
      expect(batch.content.some(part => part.type === 'image')).toBe(true)
      expect(approvals).toEqual([])
      const observed = await mcp.call('qianmo_computer_observe', {
        window: editor.id,
      })
      expect(observed.isError).toBe(false)
      expect(observed.text).toContain('hello qmo')
    }
    // The owner kept the foreground throughout.
    expect(frontmost()).toBe(owner)

    // Not offered: the owner's clipboard.
    expect((await mcp.call('qianmo_computer_clipboard_read', {})).isError).toBe(
      true,
    )
  },
  120_000,
)
