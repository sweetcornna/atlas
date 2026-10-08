// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * A headless Chrome, driven over the DevTools protocol with nothing but Bun.
 *
 * The defects this suite exists for — a session-expiry modal that never
 * opens, a poller that keeps firing after a 401, a refresh that collapses the
 * row somebody was reading, a page that renders inside a stranger's iframe —
 * live in the browser, between the markup and the script. A string assertion
 * cannot see them and a DOM emulator does not enforce frame headers. So the
 * test drives a real browser, and drives it with Bun's own `WebSocket` and
 * `Bun.spawn`: no Playwright, no Puppeteer, no download step, no dependency
 * in any `package.json` (`providers-console-m1.md` §6.2, K1).
 *
 * ## Which Chrome
 *
 * `QIANMO_CHROME` when set, else the platform's usual install. When none is
 * found the suites skip and say why, rather than failing on a machine that
 * was never meant to run them; a CI that should run them sets the variable.
 *
 * ## What the driver is
 *
 * One browser per suite, one tab per test. Commands go out with an id and
 * come back on the same socket; events for a tab carry its session id (the
 * "flattened" attach mode), so one socket serves every tab.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const MAC_CHROME =
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const LINUX_CHROMES = [
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
]

/** The Chrome to drive, or `null` with nothing installed where we look. */
export function chromePath(): string | null {
  const configured = process.env['QIANMO_CHROME']
  if (configured !== undefined && configured !== '') {
    return existsSync(configured) ? configured : null
  }
  const candidates =
    process.platform === 'darwin'
      ? [MAC_CHROME]
      : process.platform === 'linux'
        ? LINUX_CHROMES
        : []
  return candidates.find(path => existsSync(path)) ?? null
}

/** Why the browser suites are skipped on this machine, or `null` when they run. */
export function skipReason(): string | null {
  if (chromePath() !== null) return null
  return (
    'no Chrome found (set QIANMO_CHROME to a Chrome or Chromium binary to run ' +
    'the browser-level console tests)'
  )
}

type Json = Record<string, unknown>

interface Pending {
  readonly resolve: (value: Json) => void
  readonly reject: (error: Error) => void
}

type Listener = (params: Json) => void

function pause(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** One tab, attached over the browser's socket. */
export class Tab {
  readonly #browser: Browser
  readonly sessionId: string
  readonly targetId: string

  constructor(browser: Browser, sessionId: string, targetId: string) {
    this.#browser = browser
    this.sessionId = sessionId
    this.targetId = targetId
  }

  send(method: string, params: Json = {}): Promise<Json> {
    return this.#browser.send(method, params, this.sessionId)
  }

  /** Resolve with the next `event` on this tab. */
  next(event: string, timeoutMs = 10_000): Promise<Json> {
    return this.#browser.next(event, this.sessionId, timeoutMs)
  }

  /** Navigate and wait for the load event. */
  async goto(url: string): Promise<void> {
    const loaded = this.next('Page.loadEventFired')
    const result = await this.send('Page.navigate', { url })
    if (typeof result['errorText'] === 'string') {
      throw new Error(`navigation failed: ${result['errorText']}`)
    }
    await loaded
  }

  /** Evaluate an expression in the page and return its value. */
  async evaluate<T>(expression: string): Promise<T> {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    })
    const thrown = result['exceptionDetails'] as Json | undefined
    if (thrown !== undefined) {
      throw new Error(`page threw: ${JSON.stringify(thrown).slice(0, 400)}`)
    }
    const value = result['result'] as Json | undefined
    return value?.['value'] as T
  }

  /** Poll `expression` until it is truthy, or fail after `timeoutMs`. */
  async waitFor(expression: string, timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      if (await this.evaluate<boolean>(`Boolean(${expression})`)) return
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for: ${expression}`)
      }
      await pause(50)
    }
  }

  /**
   * Evaluate in one child frame, by frame id, in an isolated world: the
   * frame's DOM, none of its script's globals. How a test reads a frame
   * whose origin the page cannot reach into.
   */
  async evaluateInFrame<T>(frameId: string, expression: string): Promise<T> {
    const world = await this.send('Page.createIsolatedWorld', {
      frameId,
      worldName: 'qianmo-test',
    })
    const result = await this.send('Runtime.evaluate', {
      expression,
      contextId: world['executionContextId'],
      returnByValue: true,
    })
    const value = result['result'] as Json | undefined
    return value?.['value'] as T
  }

  /** The child frames of the top document, as `{ id, url }`. */
  async childFrames(): Promise<readonly { id: string; url: string }[]> {
    const tree = (await this.send('Page.getFrameTree'))['frameTree'] as Json
    const children = (tree['childFrames'] as Json[] | undefined) ?? []
    return children.map(child => {
      const frame = child['frame'] as Json
      return { id: String(frame['id']), url: String(frame['url']) }
    })
  }

  async close(): Promise<void> {
    await this.#browser.send('Target.closeTarget', { targetId: this.targetId })
  }
}

export class Browser {
  readonly #process: ReturnType<typeof Bun.spawn>
  readonly #socket: WebSocket
  readonly #profile: string
  readonly #pending = new Map<number, Pending>()
  readonly #listeners = new Map<string, Set<Listener>>()
  #nextId = 0

  private constructor(
    process: ReturnType<typeof Bun.spawn>,
    socket: WebSocket,
    profile: string,
  ) {
    this.#process = process
    this.#socket = socket
    this.#profile = profile
    socket.addEventListener('message', event => {
      const message = JSON.parse(String(event.data)) as Json
      const id = message['id']
      if (typeof id === 'number') {
        const pending = this.#pending.get(id)
        if (pending === undefined) return
        this.#pending.delete(id)
        const error = message['error'] as Json | undefined
        if (error !== undefined) {
          pending.reject(new Error(`CDP ${String(error['message'])}`))
        } else {
          pending.resolve((message['result'] as Json | undefined) ?? {})
        }
        return
      }
      const method = String(message['method'])
      const session = String(message['sessionId'] ?? '')
      const params = (message['params'] as Json | undefined) ?? {}
      for (const key of [`${session}:${method}`, method]) {
        for (const listener of this.#listeners.get(key) ?? []) {
          listener(params)
        }
      }
    })
  }

  /** Start a headless Chrome on a throwaway profile and connect to it. */
  static async launch(): Promise<Browser> {
    const chrome = chromePath()
    if (chrome === null) throw new Error(skipReason() ?? 'no Chrome')
    const profile = mkdtempSync(join(tmpdir(), 'qianmo-cdp-'))
    const process_ = Bun.spawn(
      [
        chrome,
        '--headless=new',
        '--remote-debugging-port=0',
        `--user-data-dir=${profile}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-gpu',
        '--disable-extensions',
        '--disable-background-networking',
        '--disable-sync',
        '--mute-audio',
        '--hide-scrollbars',
        // Linux CI runners commonly forbid the unprivileged user namespaces
        // Chrome's sandbox needs; the pages under test are our own.
        ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
        'about:blank',
      ],
      { stdout: 'ignore', stderr: 'ignore' },
    )
    // Chrome writes the port it picked, and the browser endpoint's path, here.
    const portFile = join(profile, 'DevToolsActivePort')
    const deadline = Date.now() + 15_000
    let endpoint = ''
    while (endpoint === '') {
      if (existsSync(portFile)) {
        const [port, path] = readFileSync(portFile, 'utf8').split('\n')
        if (port !== undefined && path !== undefined && path !== '') {
          endpoint = `ws://127.0.0.1:${port.trim()}${path.trim()}`
          break
        }
      }
      if (Date.now() > deadline) {
        process_.kill()
        throw new Error('Chrome did not open its DevTools port in 15 s')
      }
      await pause(25)
    }
    const socket = new WebSocket(endpoint)
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve(), { once: true })
      socket.addEventListener('error', () => reject(new Error('CDP socket')), {
        once: true,
      })
    })
    return new Browser(process_, socket, profile)
  }

  send(method: string, params: Json = {}, sessionId?: string): Promise<Json> {
    this.#nextId += 1
    const id = this.#nextId
    const message: Json = { id, method, params }
    if (sessionId !== undefined) message['sessionId'] = sessionId
    return new Promise<Json>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject })
      this.#socket.send(JSON.stringify(message))
    })
  }

  on(event: string, listener: Listener, sessionId?: string): () => void {
    const key = sessionId === undefined ? event : `${sessionId}:${event}`
    let set = this.#listeners.get(key)
    if (set === undefined) {
      set = new Set()
      this.#listeners.set(key, set)
    }
    set.add(listener)
    return () => {
      set.delete(listener)
    }
  }

  next(event: string, sessionId: string, timeoutMs: number): Promise<Json> {
    return new Promise<Json>((resolve, reject) => {
      const timer = setTimeout(() => {
        off()
        reject(new Error(`timed out waiting for ${event}`))
      }, timeoutMs)
      const off = this.on(
        event,
        params => {
          clearTimeout(timer)
          off()
          resolve(params)
        },
        sessionId,
      )
    })
  }

  /** A fresh tab with the page and runtime domains on. */
  async tab(
    viewport: { width: number; height: number } = { width: 1280, height: 900 },
  ): Promise<Tab> {
    const created = await this.send('Target.createTarget', {
      url: 'about:blank',
    })
    const targetId = String(created['targetId'])
    const attached = await this.send('Target.attachToTarget', {
      targetId,
      flatten: true,
    })
    const tab = new Tab(this, String(attached['sessionId']), targetId)
    await tab.send('Page.enable')
    await tab.send('Runtime.enable')
    await tab.send('Emulation.setDeviceMetricsOverride', {
      ...viewport,
      deviceScaleFactor: 1,
      mobile: false,
    })
    return tab
  }

  async close(): Promise<void> {
    try {
      await Promise.race([this.send('Browser.close'), pause(2_000)])
    } catch {
      // Already gone: closing is best effort, the kill below is not.
    }
    this.#socket.close()
    this.#process.kill()
    await this.#process.exited
    rmSync(this.#profile, { recursive: true, force: true })
  }
}
