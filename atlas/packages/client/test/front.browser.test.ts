// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { findBrowser } from '../src/browser.ts'
import {
  type ClientDeps,
  openFront,
  signIn,
  signOut,
  status,
} from '../src/commands.ts'
import { ClientHome } from '../src/home.ts'
import { runProgram } from '../src/secret.ts'
import { openOnArgv, openOnPipe, type PipeOpen } from '../src/window.ts'
import { fakeHub, PAIRING_CODE } from './fakeHub.ts'

/**
 * `qmo sign-in`, `open`, `sign-out` on this machine as shipped: its own token
 * store (DPAPI on Windows), its own ticket route (the pipe on Linux, the
 * command line elsewhere) and a real browser, headless, against the stand-in
 * hub. Skipped where no Chromium-family browser exists.
 */
const browser = findBrowser()
const linux = process.platform === 'linux'
const HEADLESS = [
  '--headless=new',
  '--disable-gpu',
  ...(linux ? ['--no-sandbox'] : []),
]

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function until(check: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) return false
    await Bun.sleep(100)
  }
  return true
}

function stopWindow(pid: number): void {
  if (process.platform === 'win32')
    Bun.spawnSync(['taskkill', '/T', '/F', '/PID', String(pid)])
  else
    try {
      process.kill(pid)
    } catch {}
}

test.skipIf(browser === null)(
  'sign in, open the front in a real window, sign out',
  async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qmo-front-'))
    // A browser that just exited can hold its profile a moment longer on Windows.
    cleanups.push(() =>
      fs.rmSync(root, {
        recursive: true,
        force: true,
        maxRetries: 20,
        retryDelay: 250,
      }),
    )
    const hub = fakeHub()
    cleanups.push(() => hub.stop())
    const out: string[] = []
    const err: string[] = []
    let piped: PipeOpen | undefined
    const deps: ClientDeps = {
      home: new ClientHome(
        path.join(root, 'client'),
        process.platform,
        runProgram,
      ),
      platform: process.platform,
      arch: process.arch,
      io: {
        out: line => out.push(line),
        err: line => err.push(line),
        ask: () => null,
      },
      fetch: (input, init) => fetch(input, init),
      hostname: () => 'ci-box',
      findBrowser: () => browser,
      openOnArgv(found, profile, url) {
        const pid = openOnArgv(found, profile, url, HEADLESS)
        if (pid !== undefined)
          cleanups.push(async () => {
            stopWindow(pid)
            await Bun.sleep(500)
          })
      },
      async openOnPipe(found, profile, pipeDir, url) {
        piped = await openOnPipe(found, profile, pipeDir, url, HEADLESS)
        return piped
      },
      openDefault: url => err.push(`default ${url}`),
      sleep: ms => Bun.sleep(ms),
    }

    expect(await signIn(deps, { hub: hub.url, code: PAIRING_CODE })).toBe(0)
    const token = await deps.home.token()
    const onDisk = fs.readFileSync(deps.home.secret.file, 'utf8')
    if (process.platform === 'win32') {
      expect(deps.home.secret.kind).toBe('dpapi')
      expect(onDisk).not.toContain(token)
    } else {
      expect(deps.home.secret.kind).toBe('file')
      expect(fs.statSync(deps.home.secret.file).mode & 0o777).toBe(0o600)
    }

    await status(deps)
    expect(out).toContain('状态    有效')

    const opened = openFront(deps)
    if (linux) {
      // The client stays with the window until it closes; close it once the
      // front has been served.
      expect(await until(() => hub.front.includes('/'), 60_000)).toBe(true)
      expect(
        await until(
          () => out.some(l => l.startsWith('已在窗口里打开')),
          15_000,
        ),
      ).toBe(true)
      await piped!.window.send('Browser.close').catch(() => {})
    }
    expect(await opened).toBe(0)
    expect(err).toEqual([])
    expect(hub.entered[0]).toEqual({ site: 'none' })
    expect(await until(() => hub.front.includes('/'), 30_000)).toBe(true)

    expect(await signOut(deps)).toBe(0)
    expect(hub.revoked.size).toBe(1)
    expect(deps.home.load()).toBeUndefined()
    expect(fs.existsSync(deps.home.secret.file)).toBe(false)
  },
  120_000,
)
