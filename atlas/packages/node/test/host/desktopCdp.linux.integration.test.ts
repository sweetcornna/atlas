// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import { join } from 'node:path'
import { NodeDesktop } from '../../src/host/desktop.js'
import type { ResidentPermission } from '../../src/host/residentOmp.js'
import { RuntimeDesktopTools } from '../../src/host/runtimes/desktopTools.js'
import { isolatedRoot } from '../providers/fake.js'

/**
 * Two agents' private desktops on one Linux node (runtimes-channels.md §6.3):
 * neither Chromium listens on a port; a terminal in one agent's desktop is
 * refused by both agents' DevTools bridges; each agent's own executor
 * (`qm desktop-exec`) still navigates and takes screenshots. Needs Xvfb,
 * xauth, Chromium, openbox, bubblewrap, xterm and curl; skipped elsewhere.
 * Run on the acceptance VM:
 *   bun test --preload ./atlas/tests/preload.ts ./atlas/packages/node/test/host/desktopCdp.linux.integration.test.ts
 */
const available =
  process.platform === 'linux' &&
  ['Xvfb', 'xauth', 'openbox', 'bwrap', 'xterm', 'curl'].every(
    program => Bun.which(program) !== null,
  ) &&
  (Bun.which('chromium') !== null || Bun.which('google-chrome') !== null)

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const AGENTS = ['alpha', 'beta'] as const
type Agent = (typeof AGENTS)[number]

/** Every TCP socket in LISTEN state here, by inode. */
function listeningInodes(): Set<string> {
  const inodes = new Set<string>()
  for (const table of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let text = ''
    try {
      text = fs.readFileSync(table, 'utf8')
    } catch {
      continue
    }
    for (const line of text.split('\n').slice(1)) {
      const fields = line.trim().split(/\s+/)
      if (fields[3] === '0A' && fields[9] && fields[9] !== '0')
        inodes.add(fields[9])
    }
  }
  return inodes
}

/** The processes whose command line names `marker`, with their sockets. */
function processesWith(marker: string) {
  const found: { pid: number; argv: string[]; sockets: string[] }[] = []
  for (const name of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue
    let argv: string[]
    try {
      argv = fs
        .readFileSync(`/proc/${name}/cmdline`, 'utf8')
        .split('\0')
        .filter(Boolean)
    } catch {
      continue
    }
    if (!argv.some(arg => arg.includes(marker))) continue
    const sockets: string[] = []
    try {
      for (const fd of fs.readdirSync(`/proc/${name}/fd`)) {
        const link = fs.readlinkSync(`/proc/${name}/fd/${fd}`)
        const inode = /^socket:\[(\d+)\]$/.exec(link)?.[1]
        if (inode) sockets.push(inode)
      }
    } catch {
      /* Exited, or another account's. */
    }
    found.push({ pid: Number(name), argv, sockets })
  }
  return found
}

test.skipIf(!available)(
  'two agents on one node: no browser port, a terminal in one desktop is refused by both bridges, each executor still drives its own browser',
  async () => {
    const root = isolatedRoot()
    cleanups.push(() => root.dispose())
    const workspace = `${root.root}-workspace`
    fs.mkdirSync(workspace, { recursive: true })
    cleanups.push(() => fs.rmSync(workspace, { recursive: true, force: true }))
    const page = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: req =>
        new Response(
          `<!doctype html><title>Qmo ${new URL(req.url).pathname.slice(1)}</title><h1>${new URL(req.url).pathname.slice(1)}</h1>`,
          { headers: { 'Content-Type': 'text/html' } },
        ),
    })
    cleanups.push(() => page.stop(true))

    const node = new NodeDesktop({
      node: 'worker',
      agents: [...AGENTS],
      estop: () => false,
    })
    cleanups.push(() => node.close())
    const ops = { peer: 'hub', actor: 'ops', taskId: 'op' }
    // Both agents get a browser, a computer and a terminal on one node.
    for (const agent of AGENTS) {
      const enabled = await node.control(
        'desktop.enable',
        {
          agent,
          browser: true,
          computer: true,
          confirm: 'autonomous',
          apps: 'all',
          terminal: true,
          operationId: `on-${agent}`,
        },
        ops,
      )
      expect(enabled.ok).toBe(true)
    }
    const resource = (agent: Agent) => node.resource(agent)!
    for (const agent of AGENTS)
      expect(resource(agent)).toMatchObject({ browser: true, computer: true })
    expect(resource('alpha').cdpUrl).not.toBe(resource('beta').cdpUrl)
    expect(resource('alpha').cdpToken).not.toBe(resource('beta').cdpToken)
    const status = (await node.control('desktop.status', {}, ops)) as {
      ok: true
      value: { agent: string; browser: { reason: string | null } }[]
    }
    // Headed in bubblewrap, not the headless fallback.
    for (const view of status.value) expect(view.browser.reason).toBeNull()

    // Neither Chromium has a debugging port, or any listening socket.
    const listening = listeningInodes()
    for (const agent of AGENTS) {
      const chrome = processesWith(
        `--user-data-dir=${join(root.root, 'qianmo', 'desktop', agent, 'browser')}`,
      ).filter(p => p.argv.some(arg => /chrom/i.test(arg)))
      expect(chrome.length).toBeGreaterThan(0)
      for (const proc of chrome) {
        expect(
          proc.argv.some(arg => arg.startsWith('--remote-debugging-port')),
        ).toBe(false)
        expect(proc.sockets.filter(inode => listening.has(inode))).toEqual([])
      }
      expect(chrome.some(p => p.argv.includes('--remote-debugging-pipe'))).toBe(
        true,
      )
    }

    // Each agent's own executor, a `qm desktop-exec` child per session.
    const sessions: Record<Agent, { agent: Agent; sessionId: string }> = {
      alpha: { agent: 'alpha', sessionId: 'session-alpha' },
      beta: { agent: 'beta', sessionId: 'session-beta' },
    }
    const approvals: string[] = []
    const tools = new RuntimeDesktopTools({
      desktop: node,
      permission: async (sessionId, call) =>
        (await node.decide(
          sessionId === 'session-alpha' ? 'alpha' : 'beta',
          sessionId,
          'task-1',
          'ctx',
          call,
          () => true,
          async (approved, before) => {
            approvals.push(approved.toolName)
            return before(undefined, `request-${approvals.length}`, () => true)
          },
        )) as ResidentPermission,
    })
    cleanups.push(() => tools.stop())
    const call = (
      agent: Agent,
      name: string,
      args: Record<string, unknown> = {},
    ) => tools.call(sessions[agent], workspace, name, args)
    const browse = async (agent: Agent, path: string) => {
      const tab = resource(agent).tab
      const navigated = await call(agent, 'qianmo_browser_navigate', {
        tab,
        url: `http://127.0.0.1:${page.port}/${path}`,
      })
      expect(navigated.ok).toBe(true)
      const shot = await call(agent, 'qianmo_browser_screenshot', { tab })
      expect(shot.ok).toBe(true)
      expect(
        shot.content?.some(
          part => part.type === 'image' && part.mimeType.startsWith('image/'),
        ),
      ).toBe(true)
      const read = await call(agent, 'qianmo_browser_read_page', { tab })
      expect(read.ok).toBe(true)
      expect(read.text).toContain(path)
    }
    for (const agent of AGENTS) await browse(agent, `${agent}-first`)

    // A terminal in alpha's private desktop, the way an agent would use it.
    const apps = JSON.parse(
      (await call('alpha', 'qianmo_computer_apps')).text,
    ) as {
      id: string
      terminal: boolean
    }[]
    const xterm = apps.find(app => app.terminal && app.id.includes('xterm'))
    expect(xterm).toBeDefined()
    const home = join(root.root, 'qianmo', 'desktop', 'alpha', 'home')
    const out = join(home, 'check.out')
    const wrong = 'w'.repeat(43)
    const targets = [resource('beta').cdpUrl!, resource('alpha').cdpUrl!]
    fs.writeFileSync(
      join(home, 'check.sh'),
      [
        'for url in ' + targets.join(' ') + '; do',
        '  curl -s -o /dev/null -w "%{http_code}\\n" "$url/json/version"',
        `  curl -s -o /dev/null -w "%{http_code}\\n" -X POST -H "Authorization: Bearer ${wrong}" "$url/qianmo/claim"`,
        '  curl -s -o /dev/null -w "%{http_code}\\n" -H "Connection: Upgrade" -H "Upgrade: websocket" -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" "$url/devtools/browser/x"',
        `done > ${out}.part 2>&1`,
        `mv ${out}.part ${out}`,
        '',
      ].join('\n'),
    )
    expect(
      (await call('alpha', 'qianmo_computer_open_app', { app: xterm!.id })).ok,
    ).toBe(true)
    let terminal:
      | { id: string; x: number; y: number; width: number; height: number }
      | undefined
    for (let i = 0; i < 50 && terminal === undefined; i++) {
      await Bun.sleep(200)
      const windows = JSON.parse(
        (await call('alpha', 'qianmo_computer_windows')).text,
      ) as {
        id: string
        app: string
        title: string
        x: number
        y: number
        width: number
        height: number
      }[]
      terminal = windows.find(w => /xterm/i.test(`${w.app} ${w.title}`))
    }
    expect(terminal).toBeDefined()
    // Like a person: look first; coordinates are in that screenshot.
    expect((await call('alpha', 'qianmo_computer_screenshot')).ok).toBe(true)
    const typed = await call('alpha', 'qianmo_computer_actions', {
      actions: [
        {
          type: 'click',
          x: terminal!.x + Math.floor(terminal!.width / 2),
          y: terminal!.y + Math.floor(terminal!.height / 2),
        },
        { type: 'type', text: 'sh check.sh' },
        { type: 'keypress', keys: ['enter'] },
      ],
    })
    expect(typed.ok ? '' : typed.text).toBe('')
    for (let i = 0; i < 100 && !fs.existsSync(out); i++) await Bun.sleep(200)
    // Every request from the terminal, to either bridge, is refused.
    expect(fs.readFileSync(out, 'utf8').trim().split('\n')).toEqual(
      Array.from({ length: 6 }, () => '403'),
    )
    // So is this test process (not an executor), even with alpha's secret
    // on beta's bridge.
    expect(
      (await fetch(`${resource('beta').cdpUrl}/json/version`)).status,
    ).toBe(403)
    expect(
      (
        await fetch(`${resource('beta').cdpUrl}/qianmo/claim`, {
          method: 'POST',
          headers: { authorization: `Bearer ${resource('alpha').cdpToken}` },
        })
      ).status,
    ).toBe(403)

    // Both executors still drive their own browsers.
    for (const agent of AGENTS) await browse(agent, `${agent}-again`)
    expect(approvals).toEqual(['qianmo_computer_open_app'])

    // Recycling closes each bridge: nothing answers at its address.
    for (const agent of AGENTS) {
      const url = resource(agent).cdpUrl!
      const recycled = await node.control(
        'desktop.recycle',
        { agent, operationId: `recycle-${agent}` },
        ops,
      )
      expect(recycled.ok).toBe(true)
      await expect(fetch(`${url}/json/version`)).rejects.toThrow()
    }
  },
  240_000,
)
