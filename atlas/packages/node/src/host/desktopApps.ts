// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as fs from 'node:fs'
import * as path from 'node:path'
import type { DesktopApps } from '@qianmo/console'

/**
 * The system application directories, highest precedence first (the XDG
 * default `XDG_DATA_DIRS=/usr/local/share:/usr/share`). Only these are read:
 * a model never names a program, it picks an id from what is installed here.
 */
export const DESKTOP_APPLICATION_DIRS: readonly string[] = [
  '/usr/local/share/applications',
  '/usr/share/applications',
]

/** One application the private desktop can open (runtimes-channels.md §6.3). */
export interface DesktopApp {
  /** Desktop file id without `.desktop`: `xterm`, `org.gnome.TextEditor`. */
  readonly id: string
  readonly name: string
  /** `Categories` names `TerminalEmulator`: a shell in the private desktop. */
  readonly terminal: boolean
  /** `Exec` with field codes removed; the first item is the program. */
  readonly argv: readonly string[]
}

const APP_ID = /^[\x21-\x7e]{1,200}$/
const ENTRY_BYTES = 64 * 1024
const ENTRY_FILES = 4000

/** `'all'`, `'none'`, or at most 50 distinct ids of 1–200 visible characters. */
export function isDesktopAppsPolicy(value: unknown): value is DesktopApps {
  if (value === 'all' || value === 'none') return true
  return (
    Array.isArray(value) &&
    value.length <= 50 &&
    value.every(id => typeof id === 'string' && APP_ID.test(id))
  )
}

/** The general string escapes of the desktop entry spec. */
function unescapeValue(value: string): string {
  return value.replace(/\\([sntr\\])/g, (_, c: string) =>
    c === 's'
      ? ' '
      : c === 'n'
        ? '\n'
        : c === 't'
          ? '\t'
          : c === 'r'
            ? '\r'
            : '\\',
  )
}

/**
 * Split an `Exec` value into arguments: double quotes with the four escapes
 * the spec defines, single quotes and backslashes the way shells (and GLib)
 * read them, then field codes dropped (`%f`, `%U`, `%i`, `%c`, `%k`, …) and
 * `%%` turned into `%`. Nothing is passed for the codes: the host opens an
 * application empty, never with a file or URL the model chose. `undefined`
 * for an unterminated quote or an empty command.
 */
export function desktopExecArgv(exec: string): string[] | undefined {
  const args: string[] = []
  let current = ''
  let started = false
  for (let i = 0; i < exec.length; i++) {
    const c = exec[i]!
    if (c === ' ' || c === '\t' || c === '\n') {
      if (started) args.push(current)
      current = ''
      started = false
      continue
    }
    started = true
    if (c === '"') {
      let closed = false
      for (i++; i < exec.length; i++) {
        const q = exec[i]!
        if (q === '"') {
          closed = true
          break
        }
        if (q === '\\' && '"`$\\'.includes(exec[i + 1] ?? '')) {
          current += exec[++i]
          continue
        }
        current += q
      }
      if (!closed) return undefined
    } else if (c === "'") {
      const end = exec.indexOf("'", i + 1)
      if (end < 0) return undefined
      current += exec.slice(i + 1, end)
      i = end
    } else if (c === '\\' && i + 1 < exec.length) current += exec[++i]
    else current += c
  }
  if (started) args.push(current)
  const out = args
    .filter(arg => !/^%[a-zA-Z]$/.test(arg))
    .map(arg =>
      arg.replace(/%([%a-zA-Z])/g, (_, c: string) => (c === '%' ? '%' : '')),
    )
  return out.length > 0 && out[0] !== '' ? out : undefined
}

interface DesktopEntry {
  readonly type: string | undefined
  readonly name: string | undefined
  readonly exec: string | undefined
  readonly tryExec: string | undefined
  readonly noDisplay: boolean
  readonly hidden: boolean
  readonly terminal: boolean
  readonly categories: readonly string[]
}

/** The `[Desktop Entry]` group's unlocalized keys. */
export function parseDesktopEntry(text: string): DesktopEntry {
  const keys = new Map<string, string>()
  let group: string | undefined
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    if (line.startsWith('[') && line.endsWith(']')) {
      group = line.slice(1, -1)
      continue
    }
    if (group !== 'Desktop Entry') continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim()
    if (!keys.has(key)) keys.set(key, line.slice(eq + 1).trim())
  }
  const unescaped = (key: string) => {
    const value = keys.get(key)
    return value === undefined ? undefined : unescapeValue(value)
  }
  return {
    type: keys.get('Type'),
    name: unescaped('Name'),
    exec: unescaped('Exec'),
    tryExec: unescaped('TryExec'),
    noDisplay: keys.get('NoDisplay') === 'true',
    hidden: keys.get('Hidden') === 'true',
    terminal: keys.get('Terminal') === 'true',
    categories: (keys.get('Categories') ?? '').split(';').filter(Boolean),
  }
}

/**
 * Terminal emulators that run a `Terminal=true` entry, first installed wins,
 * with the flag after which the rest of the line is the command (Debian
 * policy requires `-e` of `x-terminal-emulator`).
 */
export const DESKTOP_TERMINAL_RUNNERS: readonly (readonly [string, string])[] =
  [
    ['x-terminal-emulator', '-e'],
    ['xterm', '-e'],
    ['uxterm', '-e'],
    ['xfce4-terminal', '-x'],
    ['gnome-terminal', '--'],
    ['konsole', '-e'],
    ['alacritty', '-e'],
  ]

/**
 * Every application installed in `dirs` that this node can start. The first
 * directory that holds an id wins, so a `Hidden` override in
 * `/usr/local/share/applications` removes the packaged entry too. Entries
 * that are hidden, not applications, or whose program is missing are left
 * out. Terminal emulators and `Terminal=true` entries (`vim`, `python3.11`)
 * are both terminal-class: either way the agent gets a shell-capable window.
 * The latter run inside the first installed emulator, and are left out when
 * there is none.
 */
export function desktopApplications(
  dirs: readonly string[],
  available: (program: string) => boolean,
): DesktopApp[] {
  const runner = DESKTOP_TERMINAL_RUNNERS.find(([program]) =>
    available(program),
  )
  const seen = new Set<string>()
  const apps: DesktopApp[] = []
  let files = 0
  for (const dir of dirs) {
    let names: string[]
    try {
      names = (fs.readdirSync(dir, { recursive: true }) as string[]).sort()
    } catch {
      continue
    }
    for (const name of names) {
      if (!name.endsWith('.desktop') || ++files > ENTRY_FILES) continue
      const id = name.slice(0, -'.desktop'.length).split(path.sep).join('-')
      if (seen.has(id)) continue
      seen.add(id)
      let text: string
      try {
        const file = path.join(dir, name)
        const stat = fs.statSync(file)
        if (!stat.isFile() || stat.size > ENTRY_BYTES) continue
        text = fs.readFileSync(file, 'utf8')
      } catch {
        continue
      }
      const entry = parseDesktopEntry(text)
      if (
        !APP_ID.test(id) ||
        entry.type !== 'Application' ||
        entry.noDisplay ||
        entry.hidden ||
        (entry.terminal && !runner) ||
        !entry.name ||
        (entry.tryExec !== undefined && !available(entry.tryExec))
      )
        continue
      const argv =
        entry.exec === undefined ? undefined : desktopExecArgv(entry.exec)
      if (!argv || !available(argv[0]!)) continue
      apps.push({
        id,
        name: entry.name.slice(0, 200),
        terminal:
          entry.terminal || entry.categories.includes('TerminalEmulator'),
        argv: entry.terminal && runner ? [...runner, ...argv] : argv,
      })
    }
  }
  return apps.sort((a, b) => a.id.localeCompare(b.id))
}

/** What one agent's policy lets it open: terminals only with `terminal`. */
export function allowedDesktopApps(
  apps: readonly DesktopApp[],
  policy: DesktopApps,
  terminal: boolean,
): DesktopApp[] {
  if (policy === 'none') return []
  return apps.filter(
    app =>
      (terminal || !app.terminal) &&
      (policy === 'all' || policy.includes(app.id)),
  )
}
