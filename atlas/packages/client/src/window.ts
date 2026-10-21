// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Opening the front in an app window (clients.md §3.2–§3.3).
 *
 * Windows (and macOS, for development): the ticket goes on the browser's
 * command line, which other standard users cannot read there; the browser is
 * started detached and the client waits only until the hub reports the ticket
 * spent. Linux: the ticket never touches a command line — the window starts
 * blank on a DevTools pipe and is navigated over it, and the client stays
 * with the pipe until the window closes.
 *
 * The first window on a fresh profile meets the hub's account confirmation,
 * and the ticket is spent only when the user confirms. On the pipe the
 * navigation carries `X-Qmo-Device` instead, which web content cannot put on
 * a navigation, so the hub lets the device's own window straight through.
 */

import { spawn } from 'node:child_process'
import type { Browser } from './browser.js'
import { launchOnPipe, type PipeWindow } from './cdp.js'
import { ClientError } from './hub.js'

/** Command-line flags for the app window, before the page to open. */
export function windowFlags(
  profile: string,
  platform: NodeJS.Platform = process.platform,
): string[] {
  return [
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1200,820',
    // The window manager matches this against the `.desktop` entry (P37.3).
    ...(platform === 'linux' ? ['--class=Qmo'] : []),
  ]
}

/** How this platform gets a ticket into the window. */
export function ticketRoute(
  platform: NodeJS.Platform = process.platform,
): 'argv' | 'pipe' {
  return platform === 'linux' ? 'pipe' : 'argv'
}

/** Start `program` detached from this process; it outlives the client. */
export function startDetached(
  program: string,
  args: readonly string[],
): number | undefined {
  const child = spawn(program, [...args], {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  })
  child.on('error', () => {})
  child.unref()
  return child.pid
}

/** Open `url` in the system's default browser (no ticket ever goes this way). */
export function openDefault(
  url: string,
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform === 'win32') startDetached('explorer.exe', [url])
  else if (platform === 'darwin') startDetached('open', [url])
  else startDetached('xdg-open', [url])
}

/** Open the app window directly on `url`, detached; its pid, if it started. */
export function openOnArgv(
  browser: Browser,
  profile: string,
  url: string,
  extra: readonly string[] = [],
  platform: NodeJS.Platform = process.platform,
): number | undefined {
  return startDetached(browser.path, [
    ...windowFlags(profile, platform),
    ...extra,
    `--app=${url}`,
  ])
}

/** Sent with the pipe route's navigation: this device's id, which the ticket must match. */
const DEVICE_HEADER = 'X-Qmo-Device'

export interface PipeOpen {
  readonly window: PipeWindow
  /** The attached page, for the caller's later questions. */
  readonly sessionId: string
}

/** Wait for the page target the app window opened with. */
async function firstPage(window: PipeWindow, ms: number): Promise<string> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const { targetInfos } = await window.send('Target.getTargets')
    const page = Array.isArray(targetInfos)
      ? targetInfos.find(
          (t: unknown) =>
            typeof t === 'object' &&
            t !== null &&
            'type' in t &&
            t.type === 'page' &&
            'targetId' in t &&
            typeof t.targetId === 'string',
        )
      : undefined
    if (page !== undefined) return (page as { targetId: string }).targetId
    await Bun.sleep(100)
  }
  throw new ClientError('窗口没有打开页面')
}

const failure = (error: unknown): ClientError =>
  error instanceof ClientError
    ? error
    : new ClientError(
        `窗口没有起来：${error instanceof Error ? error.message : String(error)}`,
      )

/**
 * Start the app window blank on a DevTools pipe and navigate it to `url` as
 * device `deviceId` (`X-Qmo-Device`); {@link dropDeviceHeader} stops the
 * header once the window has landed. `startMs` covers a cold start: a browser
 * launched for the first time from a cold disk has taken over 10 s to answer
 * its pipe.
 */
export async function openOnPipe(
  browser: Browser,
  profile: string,
  pipeDir: string,
  url: string,
  deviceId: string,
  extra: readonly string[] = [],
  startMs = 45_000,
): Promise<PipeOpen> {
  let window: PipeWindow
  try {
    window = launchOnPipe(pipeDir, browser.path, [
      ...windowFlags(profile, 'linux'),
      ...extra,
      '--remote-debugging-pipe',
      '--app=about:blank',
    ])
  } catch (error) {
    throw failure(error)
  }
  try {
    // A second launch on a profile already in use hands over to the running
    // browser and exits at once; its pipe never answers.
    const ready = await Promise.race([
      window
        .send('Browser.getVersion', {}, { ms: startMs })
        .then(() => true as const),
      window.exited.then(() => false as const),
    ])
    if (!ready)
      throw new ClientError('阡陌窗口已经开着（同一份资料目录只能开一个）')
    const targetId = await firstPage(window, 15_000)
    const attached = await window.send('Target.attachToTarget', {
      targetId,
      flatten: true,
    })
    const sessionId = attached.sessionId
    if (typeof sessionId !== 'string') throw new ClientError('窗口的页面连不上')
    await window.send('Network.enable', {}, { sessionId })
    await window.send(
      'Network.setExtraHTTPHeaders',
      { headers: { [DEVICE_HEADER]: deviceId } },
      { sessionId },
    )
    const navigated = await window.send(
      'Page.navigate',
      { url },
      { sessionId, ms: 30_000 },
    )
    if (typeof navigated.errorText === 'string' && navigated.errorText !== '')
      throw new ClientError(`窗口打不开中枢：${navigated.errorText}`)
    return { window, sessionId }
  } catch (error) {
    window.close()
    throw failure(error)
  }
}

/**
 * Once the window has landed: no more device header, and no more network
 * events over the pipe for as long as the window stays open. A window already
 * gone needs neither.
 */
export async function dropDeviceHeader(open: PipeOpen): Promise<void> {
  const options = { sessionId: open.sessionId }
  try {
    await open.window.send(
      'Network.setExtraHTTPHeaders',
      { headers: {} },
      options,
    )
    await open.window.send('Network.disable', {}, options)
  } catch {}
}

/** The page's current path, `null` while the page cannot answer. */
export async function pagePath(
  open: PipeOpen,
  ms = 5000,
): Promise<string | null> {
  try {
    const evaluated = await open.window.send(
      'Runtime.evaluate',
      { expression: 'location.pathname', returnByValue: true },
      { sessionId: open.sessionId, ms },
    )
    const result = evaluated.result
    return typeof result === 'object' &&
      result !== null &&
      'value' in result &&
      typeof result.value === 'string'
      ? result.value
      : null
  } catch {
    return null
  }
}
