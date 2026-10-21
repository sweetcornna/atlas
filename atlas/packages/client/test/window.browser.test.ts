// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { findBrowser } from '../src/browser.ts'
import {
  dropDeviceHeader,
  openOnPipe,
  pagePath,
  windowFlags,
} from '../src/window.ts'

/**
 * The two ways a ticket reaches a real browser (clients.md §3.3), against a
 * stand-in hub that records how the window's navigation arrived. Headless so
 * it runs on a CI runner; skipped where no Chromium-family browser exists.
 */
const browser = findBrowser()
const linux = process.platform === 'linux'
const TICKET = `qmt_${'w'.repeat(43)}`
const DEVICE = 'd-abcdefghijkl'
/** CI runners commonly forbid the user namespaces Chrome's sandbox needs. */
const HEADLESS = [
  '--headless=new',
  '--disable-gpu',
  ...(linux ? ['--no-sandbox'] : []),
]

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function stage() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qmo-window-'))
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }))
  const entered: {
    site: string | null
    ticket: string | null
    device: string | null
  }[] = []
  /** Every request, with its `X-Qmo-Device`. */
  const seen: { path: string; device: string | null }[] = []
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      const url = new URL(request.url)
      const device = request.headers.get('x-qmo-device')
      seen.push({ path: url.pathname, device })
      if (url.pathname === '/client/enter') {
        entered.push({
          site: request.headers.get('sec-fetch-site'),
          ticket: url.searchParams.get('ticket'),
          device,
        })
        return new Response(null, {
          status: 303,
          headers: {
            location: '/',
            'set-cookie': 'qianmo_session=s; Path=/; HttpOnly',
          },
        })
      }
      return new Response('<!doctype html><title>front</title>', {
        headers: { 'content-type': 'text/html' },
      })
    },
  })
  cleanups.push(() => server.stop(true))
  return {
    root,
    entered,
    seen,
    origin: `http://127.0.0.1:${server.port}`,
    enter: `http://127.0.0.1:${server.port}/client/enter?ticket=${TICKET}`,
  }
}

async function until(check: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) return false
    await Bun.sleep(100)
  }
  return true
}

/** Every process command line on this host that carries `needle` (Linux). */
function commandLinesWith(needle: string): string[] {
  const found: string[] = []
  for (const name of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue
    try {
      const argv = fs.readFileSync(`/proc/${name}/cmdline`, 'utf8')
      if (argv.includes(needle)) found.push(argv.replaceAll('\0', ' '))
    } catch {}
  }
  return found
}

describe.skipIf(browser === null)('a real browser', () => {
  test.skipIf(!linux)(
    'Linux: the window is navigated over the pipe, the ticket on no command line',
    async () => {
      const s = stage()
      const pipeDir = path.join(s.root, 'pipe')
      const open = await openOnPipe(
        browser!,
        path.join(s.root, 'window'),
        pipeDir,
        s.enter,
        DEVICE,
        HEADLESS,
      )
      // The FIFOs are gone as soon as the browser has both ends, in a 0700 directory.
      expect(fs.readdirSync(pipeDir)).toEqual([])
      expect(fs.statSync(pipeDir).mode & 0o777).toBe(0o700)
      cleanups.push(async () => {
        await open.window.send('Browser.close').catch(() => {})
        await Promise.race([open.window.exited, Bun.sleep(5000)])
        open.window.close()
      })
      expect(await until(() => s.entered.length > 0, 30_000)).toBe(true)
      expect(s.entered[0]).toEqual({
        site: 'none',
        ticket: TICKET,
        device: DEVICE,
      })
      expect(commandLinesWith(TICKET)).toEqual([])
      let where: string | null = null
      for (let i = 0; i < 40 && where !== '/'; i++) {
        where = await pagePath(open)
        if (where !== '/') await Bun.sleep(250)
      }
      expect(where).toBe('/')
      // Once landed, the window's requests go without the device header.
      await dropDeviceHeader(open)
      await open.window.send(
        'Page.navigate',
        { url: `${s.origin}/after` },
        { sessionId: open.sessionId },
      )
      expect(
        await until(() => s.seen.some(r => r.path === '/after'), 15_000),
      ).toBe(true)
      expect(s.seen.find(r => r.path === '/after')?.device).toBeNull()
    },
    90_000,
  )

  test('a URL on the command line arrives as a user-initiated navigation', async () => {
    const s = stage()
    const proc = Bun.spawn(
      [
        browser!.path,
        ...windowFlags(path.join(s.root, 'window')),
        ...HEADLESS,
        `--app=${s.enter}`,
      ],
      { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' },
    )
    cleanups.push(async () => {
      if (process.platform === 'win32')
        Bun.spawnSync(['taskkill', '/T', '/F', '/PID', String(proc.pid)])
      else proc.kill()
      await Promise.race([proc.exited, Bun.sleep(5000)])
    })
    expect(await until(() => s.entered.length > 0, 30_000)).toBe(true)
    expect(s.entered[0]).toEqual({ site: 'none', ticket: TICKET, device: null })
  }, 90_000)
})
