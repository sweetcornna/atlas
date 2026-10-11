// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { AppServerClient } from '@qianmo/handoff'
import {
  handoffAppServerArgv,
  type HandoffNodeConfig,
} from '../../src/commands/handoffNode.js'

const codex = Bun.which('codex')
test.skipIf(codex === null)(
  'official Codex app-server readyz + thread/start with an isolated plugin disabled',
  async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p19-codex-smoke-'))
    const token = 'p19-app-server-test-token'
    const tokenFile = path.join(root, 'app.token')
    fs.writeFileSync(tokenFile, token, { mode: 0o600 })
    const reserve = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () => new Response('reserve'),
    })
    const port = reserve.port
    reserve.stop(true)
    const config: HandoffNodeConfig = {
      node: 'smoke',
      root,
      port: 0,
      bind: '127.0.0.1',
      trusted: [],
      projects: [],
      appServerUrl: `ws://127.0.0.1:${port}`,
      appServerTokenFile: tokenFile,
      qmcodeHome: path.join(root, 'codex'),
      appServerHome: path.join(root, 'home'),
      appServerBin: codex!,
      appServerHomeEnv: 'CODEX_HOME',
    }
    fs.mkdirSync(config.qmcodeHome)
    fs.mkdirSync(config.appServerHome)
    const env = {
      ...process.env,
      HOME: config.appServerHome,
      CODEX_HOME: config.qmcodeHome,
      CLAUDE_CONFIG_DIR: path.join(root, 'claude'),
      QMCODE_HOME: path.join(root, 'qmcode'),
      QIANMO_CONFIG_DIR: path.join(root, 'qianmo'),
    }
    // Install the shipped plugin first, so its absence on the disabled startup
    // exercises a real loaded-plugin boundary rather than an empty config.
    for (const args of [
      [
        'plugin',
        'marketplace',
        'add',
        path.resolve(import.meta.dir, '../../../../..'),
      ],
      ['plugin', 'add', 'qianmo@qianmo'],
    ]) {
      const command = Bun.spawn([codex!, ...args], {
        env,
        cwd: root,
        stdout: 'ignore',
        stderr: 'pipe',
      })
      expect(await command.exited).toBe(0)
    }
    const baseline = Bun.spawn([codex!, 'mcp', 'list'], {
      env,
      cwd: root,
      stdout: 'pipe',
      stderr: 'ignore',
    })
    expect(await new Response(baseline.stdout).text()).toContain('qianmo')
    expect(await baseline.exited).toBe(0)
    const disabled = Bun.spawn(
      [codex!, '--disable', 'plugins', 'mcp', 'list'],
      { env, cwd: root, stdout: 'pipe', stderr: 'ignore' },
    )
    expect(await new Response(disabled.stdout).text()).not.toContain('qianmo')
    expect(await disabled.exited).toBe(0)
    const proc = Bun.spawn(handoffAppServerArgv(config), {
      env,
      cwd: root,
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'pipe',
    })
    const stderr = new Response(proc.stderr).text()
    let client: AppServerClient | undefined
    try {
      const deadline = Date.now() + 10_000
      let status = 0
      while (Date.now() < deadline) {
        try {
          status = (await fetch(`http://127.0.0.1:${port}/readyz`)).status
          if (status === 200) break
        } catch {}
        if (proc.exitCode !== null) throw new Error(await stderr)
        await Bun.sleep(20)
      }
      expect(status).toBe(200)
      client = await AppServerClient.connect({
        url: config.appServerUrl,
        token,
        requestTimeoutMs: 10_000,
      })
      const thread = await client.threadStart({
        cwd: root,
        approvalPolicy: 'never',
        sandbox: 'workspace-write',
      })
      expect(await client.threadCwd(thread.id)).toBe(root)
      expect(thread.id).toMatch(/^[a-zA-Z0-9-]+$/)
    } finally {
      client?.close()
      proc.kill()
      await proc.exited
      await stderr
      fs.rmSync(root, { recursive: true, force: true })
    }
  },
  30_000,
)
