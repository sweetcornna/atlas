// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { spawn } from 'node:child_process'
import { residentExtensionSource } from '../../../../scripts/residentExtensionBundle.js'
import { writeResidentExtensionAsset } from '../../src/host/residentExtension.js'
import { Process } from '@oh-my-pi/pi-natives'
import { expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { randomUUID } from 'node:crypto'
import {
  generateNodeKeyPair,
  signAuthzDecision,
  type AuthzRequest,
} from '@qianmo/capability'
import { ResidentEstop, OmpResidentTurnPort } from '@qianmo/resident'
import { NodeDesktop } from '../../src/host/desktop.js'
import { ResidentAuthorization } from '../../src/host/residentAuthorization.js'
import { ResidentOmpPool } from '../../src/host/residentOmp.js'
import {
  ResidentOmpHarness,
  type HarnessApi,
} from '../../../../tests/integration/fixtures/resident-omp-harness.js'

const compiledBinary = process.env.QIANMO_TEST_COMPILED_QM

/**
 * Real Chrome + real omp RPC, deterministic local provider and signed
 * approver. The provider speaks both wires: OpenAI Responses tool-call ids
 * (`call_…|fc_…`) were refused at the lease before any of this could run.
 */
for (const [bundled, api] of [
  [false, 'openai-completions'],
  [false, 'openai-responses'],
  [true, 'openai-completions'],
] as const satisfies readonly (readonly [boolean, HarnessApi])[]) {
  test.skipIf(process.platform !== 'darwin' || (bundled && !compiledBinary))(
    `real private Chrome (${bundled ? 'embedded extension' : 'source extension'}, ${api}): screenshot/read auto-allow, click denial has zero side effects, once approval executes, recycle reaps`,
    async () => {
      const old = process.env.QIANMO_CONFIG_DIR
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p21-chrome-'))
      process.env.QIANMO_CONFIG_DIR = path.join(root, 'config')
      const workspace = path.join(root, 'workspace')
      fs.mkdirSync(workspace)
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
            '<!doctype html><html><body><h1>P21 fixture</h1><button id="send" onclick="document.querySelector(\'#status\').textContent=\'clicked\';fetch(\'/clicked\')">Send</button><p id="status">untouched</p></body></html>',
            { headers: { 'Content-Type': 'text/html' } },
          )
        },
      })
      const harness = new ResidentOmpHarness({ api })
      const nodeKeys = generateNodeKeyPair(),
        keys = generateNodeKeyPair()
      const authz = new ResidentAuthorization({
        node: 'worker',
        keys: nodeKeys,
        approvers: new Map([['hub', keys.publicKey]]),
        commanderKeys: () => [],
        memoryRoot: path.join(root, 'memory'),
        estop: new ResidentEstop({ path: path.join(root, 'ESTOP') }),
      })
      const node = new NodeDesktop({
        node: 'worker',
        agents: ['reviewer'],
        estop: () => false,
      })
      let pool: ResidentOmpPool | undefined,
        turn: OmpResidentTurnPort | undefined
      const requests: AuthzRequest[] = []
      let clickAsk = 0
      try {
        const enabled = await node.control(
          'desktop.enable',
          { agent: 'reviewer', browser: true, operationId: 'on' },
          { peer: 'hub', actor: 'ops', taskId: 'on' },
        )
        expect(enabled.ok).toBe(true)
        if (!enabled.ok) throw new Error(enabled.message)
        const r = node.resource('reviewer')!
        const ledger = JSON.parse(
          fs.readFileSync(
            path.join(root, 'config/qianmo/desktop-ledger.json'),
            'utf8',
          ),
        ) as { states: { pids: { pid: number }[] }[] }
        const chromePid = ledger.states[0]!.pids[0]!.pid
        harness.script([
          {
            name: 'qianmo_browser_navigate',
            input: { tab: r.tab, url: `http://127.0.0.1:${page.port}/` },
          },
          { name: 'qianmo_browser_screenshot', input: { tab: r.tab } },
          { name: 'qianmo_browser_read_page', input: { tab: r.tab } },
          {
            name: 'qianmo_browser_click',
            input: { tab: r.tab, selector: '#send' },
          },
          { name: 'qianmo_browser_read_page', input: { tab: r.tab } },
          {
            name: 'qianmo_browser_click',
            input: { tab: r.tab, selector: '#send' },
          },
          { name: 'qianmo_browser_read_page', input: { tab: r.tab } },
          {
            name: 'qianmo_browser_click',
            input: { tab: r.tab, selector: '#send', code: 'process.exit()' },
          },
          { name: 'eval', input: { code: 'process.exit()' } },
        ])
        let extensionPath: string | undefined
        if (bundled) {
          const dir = path.join(root, 'config/embedded')
          fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
          extensionPath = writeResidentExtensionAsset(
            dir,
            await residentExtensionSource(),
          )
          const nativeDir = path.dirname(
            Bun.resolveSync('@oh-my-pi/pi-natives', import.meta.dir),
          )
          const version = JSON.parse(
            fs.readFileSync(path.join(nativeDir, '../package.json'), 'utf8'),
          ).version as string
          const cache = path.join(root, 'config/omp/natives', version)
          fs.mkdirSync(cache, { recursive: true, mode: 0o700 })
          for (const name of fs
            .readdirSync(nativeDir)
            .filter(n => n.endsWith('.node')))
            fs.copyFileSync(path.join(nativeDir, name), path.join(cache, name))
        }
        pool = new ResidentOmpPool({
          extensionPath,
          ...(bundled
            ? {
                spawn: input =>
                  spawn(compiledBinary!, ['agent', ...input.argv.slice(2)], {
                    cwd: input.cwd,
                    env: { ...input.env, PI_COMPILED: 'true' },
                    stdio: ['pipe', 'pipe', 'inherit'],
                  }),
              }
            : {}),
          desktop: node,
          agents: [{ agent: 'reviewer', cwd: workspace }],
          memoryRoot: path.join(root, 'memory'),
          announce: async () => ({ status: 'queued' }),
          requestPermission: async (sessionId, raw) => {
            const active = turn?.activeInput(sessionId)
            if (!active) return false
            return node.gate(
              'reviewer',
              sessionId,
              active.messageId,
              'ctx',
              raw,
              () => turn?.activeInput(sessionId) === active,
              (call, before) =>
                authz.request(
                  call,
                  {
                    from: 'qianmo://hub/console',
                    taskId: active.messageId,
                    traceId: null,
                    trust: 'verified-capability',
                  },
                  Date.now() + 60000,
                  120000,
                  request => {
                    requests.push(request)
                    const click = request.toolName === 'qianmo_browser_click'
                    if (click) clickAsk++
                    if (clickAsk === 1 && click) expect(clicks).toBe(0)
                    if (clickAsk === 2 && click) expect(clicks).toBe(0)
                    const now = Date.now()
                    const base = {
                      v: 1 as const,
                      aud: 'worker',
                      sub: request.sub,
                      requestId: request.requestId,
                      digest: request.digest,
                      approver: 'hub/u:7f3a0c1d2e4b5a69',
                      nbf: now,
                      exp: now + 30000,
                      nonce: randomUUID(),
                      windowMs: 0,
                    }
                    if (click && clickAsk === 2) {
                      expect(
                        authz.decision(
                          signAuthzDecision(keys, {
                            ...base,
                            nonce: randomUUID(),
                            decision: 'allow-window',
                            windowMs: 30000,
                          }),
                        ),
                      ).toBe(false)
                    }
                    const wire = signAuthzDecision(keys, {
                      ...base,
                      decision: click && clickAsk === 1 ? 'deny' : 'allow-once',
                    })
                    expect(authz.decision(wire)).toBe(true)
                    expect(authz.decision(wire)).toBe(false)
                  },
                  before,
                ),
            )
          },
        })
        harness.pools.push(pool)
        const sessionId = await pool.newSession({
          agent: 'reviewer',
          cwd: workspace,
        })
        const channel = await pool.channelFor(sessionId)
        const frames: { type: string; [key: string]: unknown }[] = []
        channel.onFrame(frame => frames.push(frame))
        turn = new OmpResidentTurnPort(pool, {
          inactivity: { timeoutMs: 120000 },
        })
        const result = await turn.execute(
          {
            sessionId,
            messageId: 'desktop-real',
            prompt: 'Run the scripted desktop verification.',
          },
          async () => {},
        )
        expect(result.outcome).toBe('completed')
        expect(harness.offeredTools.has('eval')).toBe(false)
        expect(requests.map(r => r.toolName)).toEqual([
          'qianmo_browser_navigate',
          'qianmo_browser_click',
          'qianmo_browser_click',
        ])
        expect(clicks).toBe(1)
        expect(
          harness.toolResults.some(text => text.includes('untouched')),
        ).toBe(true)
        expect(harness.toolResults.some(text => text.includes('clicked'))).toBe(
          true,
        )
        expect(
          frames.some(
            f =>
              f.type === 'tool_execution_end' &&
              JSON.stringify(f.result).includes('"type":"image"'),
          ),
        ).toBe(true)
        const actions = await node.control(
          'desktop.actions',
          {},
          { peer: 'hub', actor: 'ops', taskId: 'read' },
        )
        expect(actions.ok).toBe(true)
        if (actions.ok) {
          const rows = actions.value as {
            outcome: string
            op: string
            confirmed: boolean
          }[]
          expect(
            rows
              .filter(a => a.op === 'click')
              .map(a => a.outcome)
              .sort(),
          ).toEqual(['confirmed', 'denied', 'denied'])
          expect(
            rows
              .filter(a => a.op === 'read_page' || a.op === 'screenshot')
              .every(a => a.outcome === 'allowed' && !a.confirmed),
          ).toBe(true)
        }
        expect(
          fs
            .readdirSync(
              path.join(root, 'config/qianmo/desktop/reviewer/screenshots'),
            )
            .some(name => name.endsWith('.png') || name.endsWith('.webp')),
        ).toBe(true)
        const tree: Process[] = [],
          pendingTree = [Process.fromPid(chromePid)!]
        while (pendingTree.length) {
          const p = pendingTree.pop()!
          tree.push(p)
          pendingTree.push(...p.children())
        }
        const recycled = await node.control(
          'desktop.recycle',
          { agent: 'reviewer', operationId: 'recycle' },
          { peer: 'hub', actor: 'ops', taskId: 'r' },
        )
        expect(recycled.ok).toBe(true)
        expect(
          fs.existsSync(path.join(root, 'config/qianmo/desktop/reviewer')),
        ).toBe(false)
        expect(() => process.kill(chromePid, 0)).toThrow()
        for (const p of tree)
          expect(await p.waitForExit({ timeoutMs: 1000 })).toBe(true)
      } finally {
        await harness.stop()
        await node.close()
        authz.close()
        await page.stop(true)
        process.env.QIANMO_CONFIG_DIR = old
        fs.rmSync(root, { recursive: true, force: true })
      }
    },
    120000,
  )
}
