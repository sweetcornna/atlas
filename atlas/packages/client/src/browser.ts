// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Which Chromium-family browser hosts the app window (clients.md §1, §3.3).
 *
 * Windows always has Edge; Chrome is the second choice. On Linux the first of
 * Edge, Chrome, Chromium on `PATH` wins, skipping snap builds: their
 * confinement cannot read a profile under a hidden directory, so the window
 * would fail to start. `QMO_BROWSER` names a program and overrides the search.
 * With nothing usable the client falls back to the default browser.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

export interface Browser {
  readonly path: string
  readonly name: 'edge' | 'chrome' | 'chromium' | 'custom'
}

/** What the search may look at; tests hand in a fake one. */
export interface BrowserProbe {
  readonly platform: NodeJS.Platform
  readonly env: NodeJS.ProcessEnv
  exists(file: string): boolean
  which(command: string): string | null
  /** The first bytes of a file, to tell a snap wrapper script. */
  head(file: string): string | null
  realpath(file: string): string
  /** The default value of a registry key, `null` when it is not there. */
  registry(key: string): string | null
}

export const BROWSER_ENV = 'QMO_BROWSER'

const WINDOWS_PROGRAMS: readonly [Browser['name'], string][] = [
  ['edge', 'Microsoft\\Edge\\Application\\msedge.exe'],
  ['chrome', 'Google\\Chrome\\Application\\chrome.exe'],
]

const WINDOWS_APP_PATHS: readonly [Browser['name'], string][] = [
  ['edge', 'msedge.exe'],
  ['chrome', 'chrome.exe'],
]

const LINUX_COMMANDS: readonly [Browser['name'], string][] = [
  ['edge', 'microsoft-edge-stable'],
  ['edge', 'microsoft-edge'],
  ['chrome', 'google-chrome-stable'],
  ['chrome', 'google-chrome'],
  ['chromium', 'chromium'],
  ['chromium', 'chromium-browser'],
]

const MAC_APPS: readonly [Browser['name'], string][] = [
  ['edge', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
  ['chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
  ['chromium', '/Applications/Chromium.app/Contents/MacOS/Chromium'],
]

function windowsBrowser(probe: BrowserProbe): Browser | null {
  const roots = [
    probe.env['ProgramFiles(x86)'],
    probe.env.ProgramFiles,
    probe.env.LOCALAPPDATA,
  ].filter((root): root is string => typeof root === 'string' && root !== '')
  for (const [name, relative] of WINDOWS_PROGRAMS) {
    for (const root of roots) {
      const file = path.win32.join(root, relative)
      if (probe.exists(file)) return { path: file, name }
    }
  }
  // Installed somewhere else: the App Paths entry the installer registered.
  for (const [name, exe] of WINDOWS_APP_PATHS) {
    for (const hive of ['HKLM', 'HKCU']) {
      const file = probe.registry(
        `${hive}\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exe}`,
      )
      if (file !== null && probe.exists(file)) return { path: file, name }
    }
  }
  return null
}

/** A snap build, or a wrapper script that hands over to one. */
function confined(probe: BrowserProbe, file: string): boolean {
  let real = file
  try {
    real = probe.realpath(file)
  } catch {}
  if (real.startsWith('/snap/')) return true
  const head = probe.head(real)
  return head !== null && head.startsWith('#!') && head.includes('/snap/')
}

function linuxBrowser(probe: BrowserProbe): Browser | null {
  for (const [name, command] of LINUX_COMMANDS) {
    const file = probe.which(command)
    if (file !== null && !confined(probe, file)) return { path: file, name }
  }
  return null
}

export function findBrowser(
  probe: BrowserProbe = systemProbe(),
): Browser | null {
  const named = probe.env[BROWSER_ENV]
  if (named) {
    const file = path.isAbsolute(named) ? named : probe.which(named)
    return file !== null && probe.exists(file)
      ? { path: file, name: 'custom' }
      : null
  }
  if (probe.platform === 'win32') return windowsBrowser(probe)
  if (probe.platform === 'darwin') {
    for (const [name, file] of MAC_APPS)
      if (probe.exists(file)) return { path: file, name }
    return null
  }
  return linuxBrowser(probe)
}

/** `reg query <key> /ve`, read back as the one REG_SZ value it prints. */
function queryRegistry(key: string): string | null {
  const result = Bun.spawnSync(['reg', 'query', key, '/ve'], {
    stdout: 'pipe',
    stderr: 'ignore',
  })
  if (result.exitCode !== 0) return null
  const line = result.stdout
    .toString()
    .split(/\r?\n/)
    .find(l => /\sREG_(?:EXPAND_)?SZ\s/.test(l))
  const value = line?.replace(/^.*?REG_(?:EXPAND_)?SZ\s+/, '').trim()
  return value ? value.replace(/^"(.*)"$/, '$1') : null
}

export function systemProbe(): BrowserProbe {
  return {
    platform: process.platform,
    env: process.env,
    exists: file => fs.existsSync(file),
    which: command => Bun.which(command),
    head(file) {
      try {
        const fd = fs.openSync(file, 'r')
        try {
          const buffer = Buffer.alloc(512)
          const read = fs.readSync(fd, buffer, 0, buffer.length, 0)
          return buffer.subarray(0, read).toString('latin1')
        } finally {
          fs.closeSync(fd)
        }
      } catch {
        return null
      }
    },
    realpath: file => fs.realpathSync(file),
    registry: key => (process.platform === 'win32' ? queryRegistry(key) : null),
  }
}
