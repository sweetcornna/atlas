// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * This computer, as `qmo agents` looks at it (qmo-local.md §4.2.1): the
 * folders a terminal finds commands in, the login shell's PATH for a desktop
 * app started without it, and the probes run on an agent's program. Every
 * look at the disk goes through an {@link AgentFs}, so a test can see that
 * nothing under an agent's folder is opened.
 */

import type { Stats } from 'node:fs'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'

/** One entry of a listed folder. */
interface DirEntry {
  readonly name: string
  readonly dir: boolean
}

/** Every look at the disk a scan makes, so a test can see each one. */
export interface AgentFs {
  /** Following links; `null` when nothing is there. */
  stat(file: string): Stats | null
  realpath(file: string): string | null
  /** The entry names of a folder; `null` when it cannot be listed. */
  list(dir: string): DirEntry[] | null
  /**
   * A small file's text. Only an npm package's `package.json` and a Windows
   * npm shim are ever read.
   */
  read(file: string): string | null
}

export const systemFs: AgentFs = {
  stat: file => {
    try {
      return fs.statSync(file)
    } catch {
      return null
    }
  },
  realpath: file => {
    try {
      return fs.realpathSync(file)
    } catch {
      return null
    }
  },
  list: dir => {
    try {
      return fs
        .readdirSync(dir, { withFileTypes: true })
        .map(entry => ({ name: entry.name, dir: entry.isDirectory() }))
    } catch {
      return null
    }
  },
  read: file => {
    try {
      return fs.statSync(file).size > MAX_READ
        ? null
        : fs.readFileSync(file, 'utf8')
    } catch {
      return null
    }
  },
}

/** Largest manifest or shim read. */
const MAX_READ = 64 * 1024

interface ProbeResult {
  /** `null` when it did not exit by itself (timed out, or did not start). */
  readonly code: number | null
  readonly stdout: string
  readonly stderr: string
  readonly timedOut: boolean
}

/** Runs one probe of an agent's program: `--version` or `dsh --help`. */
export type RunProbe = (
  argv: readonly string[],
  env: Record<string, string>,
  timeoutMs: number,
) => Promise<ProbeResult>

/** Most of a probe's output kept; the rest is read and dropped. */
const MAX_OUTPUT = 256 * 1024
/**
 * How long the pipes are waited on once the program has exited or been
 * stopped: something it started may hold them (Cline starts a detached
 * update at exit).
 */
const PIPE_GRACE_MS = 2_000

/** A stream's text, up to {@link MAX_OUTPUT}, until it ends or `stop`. */
async function drain(
  stream: ReadableStream<Uint8Array>,
  stop: Promise<void>,
): Promise<string> {
  const reader = stream.getReader()
  stop.then(() => reader.cancel().catch(() => {}))
  const decoder = new TextDecoder()
  let text = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (text.length < MAX_OUTPUT)
        text += decoder.decode(value, { stream: true })
    }
  } catch {}
  return (text + decoder.decode()).slice(0, MAX_OUTPUT)
}

/**
 * Runs `argv` with nothing on its stdin, in the system's temporary folder
 * (dsh reads a `.env` where it starts), and stops it after `timeoutMs`. On
 * POSIX it leads a process group of its own, so the stop reaches whatever
 * it started, and a login shell asked for its PATH cannot take the
 * terminal `qmo` runs in. Once it has exited or been stopped, its pipes are
 * waited on {@link PIPE_GRACE_MS} more, then its group is stopped too.
 */
export const runProbe: RunProbe = async (argv, env, timeoutMs) => {
  let proc: Bun.Subprocess<'ignore', 'pipe', 'pipe'>
  try {
    proc = Bun.spawn([...argv], {
      cwd: tmpdir(),
      env,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      detached: process.platform !== 'win32',
    })
  } catch (error) {
    return { code: null, stdout: '', stderr: String(error), timedOut: false }
  }
  const stopAll = () => {
    try {
      if (process.platform === 'win32') proc.kill('SIGKILL')
      else process.kill(-proc.pid, 'SIGKILL')
    } catch {}
  }
  let release = () => {}
  const stop = new Promise<void>(resolve => {
    release = resolve
  })
  let grace: ReturnType<typeof setTimeout> | undefined
  const settle = () => {
    grace ??= setTimeout(() => {
      stopAll()
      release()
    }, PIPE_GRACE_MS)
  }
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    stopAll()
    settle()
  }, timeoutMs)
  proc.exited.then(settle)
  try {
    const [stdout, stderr, code] = await Promise.all([
      drain(proc.stdout, stop),
      drain(proc.stderr, stop),
      proc.exited,
    ])
    return { code: timedOut ? null : code, stdout, stderr, timedOut }
  } finally {
    clearTimeout(timer)
    clearTimeout(grace)
    release()
  }
}

/** What the login shell says, for a desktop app started with launchd's PATH. */
export interface LoginEnv {
  readonly path: readonly string[]
  readonly vars: Readonly<Record<string, string>>
}

/** Asks the login shell for its PATH and `names`; `null` when it does not say in time. */
export type AskLoginShell = (
  names: readonly string[],
  timeoutMs: number,
) => Promise<LoginEnv | null>

/** This computer, as the scan sees it. */
export interface Place {
  readonly platform: NodeJS.Platform
  readonly home: string
  /** An agent's variable as a terminal has it: absolute, else `undefined`. */
  env(name: string): string | undefined
  isDir(dir: string): boolean
  /** `name` with Windows' `.exe`. */
  exe(name: string): string
}

/** `name` in `env`; on Windows in any case (`Path`). */
export function envOf(
  env: NodeJS.ProcessEnv,
  name: string,
  platform: NodeJS.Platform,
): string | undefined {
  if (platform !== 'win32') return env[name]
  const key = Object.keys(env).find(
    one => one.toUpperCase() === name.toUpperCase(),
  )
  return key === undefined ? undefined : env[key]
}

function versionNumbers(name: string): number[] {
  return (name.match(/\d+/g) ?? []).map(Number)
}

/** Newest first, by the numbers in the names (`v22.19.0` before `v9.0.0`). */
function newestFirst(a: string, b: string): number {
  const x = versionNumbers(a)
  const y = versionNumbers(b)
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (y[i] ?? -1) - (x[i] ?? -1)
    if (d !== 0) return d
  }
  return a.localeCompare(b)
}

/** `<root>/<each version>/<tail>`, newest version first. */
function versionDirs(fsx: AgentFs, root: string, ...tail: string[]): string[] {
  return (fsx.list(root) ?? [])
    .filter(entry => entry.dir)
    .map(entry => entry.name)
    .sort(newestFirst)
    .map(name => path.join(root, name, ...tail))
}

/**
 * The folders users' command-line tools are installed in, for a PATH that
 * does not reach them: the standalone installers' `~/.local/bin`, npm's
 * prefix, bun, Volta, pnpm, asdf, mise, each Node of nvm, fnm and mise,
 * cargo, deno; on Windows npm's, bun's, Volta's, pnpm's and scoop's.
 */
export function userDirs(at: Place, fsx: AgentFs): (string | undefined)[] {
  const { home } = at
  const under = (base: string | undefined, ...tail: string[]) =>
    base === undefined ? undefined : path.join(base, ...tail)
  if (at.platform === 'win32')
    return [
      under(at.env('APPDATA'), 'npm'),
      path.join(home, '.local', 'bin'),
      path.join(at.env('BUN_INSTALL') ?? path.join(home, '.bun'), 'bin'),
      under(
        at.env('VOLTA_HOME') ?? under(at.env('LOCALAPPDATA'), 'Volta'),
        'bin',
      ),
      at.env('PNPM_HOME') ?? under(at.env('LOCALAPPDATA'), 'pnpm'),
      path.join(home, 'scoop', 'shims'),
      path.join(home, '.cargo', 'bin'),
      path.join(home, '.deno', 'bin'),
    ]
  const fnmRoots = [
    at.env('FNM_DIR'),
    path.join(home, '.local', 'share', 'fnm'),
    path.join(home, 'Library', 'Application Support', 'fnm'),
  ]
  return [
    path.join(home, '.local', 'bin'),
    under(at.env('NPM_CONFIG_PREFIX') ?? at.env('npm_config_prefix'), 'bin'),
    path.join(home, '.npm-global', 'bin'),
    path.join(at.env('BUN_INSTALL') ?? path.join(home, '.bun'), 'bin'),
    path.join(at.env('VOLTA_HOME') ?? path.join(home, '.volta'), 'bin'),
    at.env('PNPM_HOME') ??
      (at.platform === 'darwin'
        ? path.join(home, 'Library', 'pnpm')
        : path.join(home, '.local', 'share', 'pnpm')),
    path.join(home, '.asdf', 'shims'),
    path.join(home, '.local', 'share', 'mise', 'shims'),
    ...versionDirs(
      fsx,
      path.join(
        at.env('NVM_DIR') ?? path.join(home, '.nvm'),
        'versions',
        'node',
      ),
      'bin',
    ),
    ...fnmRoots.flatMap(root =>
      root === undefined
        ? []
        : versionDirs(
            fsx,
            path.join(root, 'node-versions'),
            'installation',
            'bin',
          ),
    ),
    ...versionDirs(
      fsx,
      path.join(home, '.local', 'share', 'mise', 'installs', 'node'),
      'bin',
    ),
    path.join(home, '.cargo', 'bin'),
    path.join(home, '.deno', 'bin'),
  ]
}

/** Machine-wide bin folders a desktop app's PATH lacks; Windows' registry PATH is not read. */
export function defaultSystemDirs(platform: NodeJS.Platform): string[] {
  if (platform === 'win32') return []
  if (platform === 'darwin') return ['/opt/homebrew/bin', '/usr/local/bin']
  return ['/usr/local/bin', '/home/linuxbrew/.linuxbrew/bin']
}

/** Commands looked up once per scan, in the folders a terminal would look in. */
export class Lookup {
  readonly #found = new Map<string, string[]>()
  readonly #exts: readonly string[]

  constructor(
    readonly dirs: readonly string[],
    readonly platform: NodeJS.Platform,
    readonly fsx: AgentFs,
    pathext: string | undefined,
  ) {
    this.#exts = (pathext || '.COM;.EXE;.BAT;.CMD')
      .split(';')
      .filter(ext => ext !== '')
      .map(ext => ext.toLowerCase())
  }

  /** A file this user can run (on Windows: a file). */
  executable(file: string): boolean {
    const stat = this.fsx.stat(file)
    return (
      stat !== null &&
      stat.isFile() &&
      (this.platform === 'win32' || (stat.mode & 0o111) !== 0)
    )
  }

  /** Every `command` in the folders, in their order. */
  all(command: string): readonly string[] {
    const known = this.#found.get(command)
    if (known !== undefined) return known
    const names =
      this.platform === 'win32' && path.extname(command) === ''
        ? this.#exts.map(ext => command + ext)
        : [command]
    const found: string[] = []
    for (const dir of this.dirs)
      for (const name of names) {
        const file = path.join(dir, name)
        if (this.executable(file)) found.push(file)
      }
    this.#found.set(command, found)
    return found
  }
}

/** Whether something that is not a folder is where `dir`, or one it is in, would be. */
export function taken(fsx: AgentFs, dir: string): boolean {
  for (let at = path.resolve(dir); ; ) {
    const stat = fsx.stat(at)
    if (stat !== null) return !stat.isDirectory()
    const up = path.dirname(at)
    if (up === at) return false
    at = up
  }
}

/**
 * Folders an agent writes as it runs and that stay when it is uninstalled
 * (`~/.qwen/debug`, `~/.codebuddy/logs`): a folder holding only these, skill
 * installers' `skills/` and `.DS_Store` is no sign the agent is here.
 */
const LEFTOVERS = new Set(['logs', 'log', 'debug', 'diagnostics', 'cache'])

/** Whether `dir` is a folder the agent made. Only its entry names are looked at. */
export function agentDir(fsx: AgentFs, dir: string): boolean {
  const entries = fsx.list(dir)
  if (entries === null) return fsx.stat(dir)?.isDirectory() ?? false
  if (entries.length === 0) return true
  return entries.some(
    entry =>
      entry.name !== 'skills' &&
      entry.name !== '.DS_Store' &&
      !(entry.dir && LEFTOVERS.has(entry.name.toLowerCase())),
  )
}

// ---- the login shell -----------------------------------------------------

const SHELL_MARK = '__qmo_env__'

/**
 * What the login shell runs: `/bin/sh` prints PATH and `names` as exported
 * (what a program started from the shell gets), NUL between them, inside two
 * marks that tell it from whatever the profile prints. nushell runs it as an
 * external command (`^`).
 */
function shellProbe(shell: string, names: readonly string[]): string {
  for (const name of names)
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
      throw new Error(`not a variable name: ${name}`)
  const format = `${SHELL_MARK}%s${'\\0%s'.repeat(names.length)}${SHELL_MARK}`
  const args = ['PATH', ...names].map(name => ` "$${name}"`).join('')
  const command = `/bin/sh -c 'printf "${format}"${args}'`
  return path.basename(shell) === 'nu' ? `^${command}` : command
}

/** The answer in what the shell printed; `null` when there is none. */
function parseShellProbe(
  output: string,
  names: readonly string[],
): LoginEnv | null {
  const start = output.indexOf(SHELL_MARK)
  if (start < 0) return null
  const rest = output.slice(start + SHELL_MARK.length)
  const end = rest.indexOf(SHELL_MARK)
  if (end < 0) return null
  const fields = rest.slice(0, end).split('\0')
  const dirs = [
    ...new Set(
      (fields[0] === '$PATH' ? '' : fields[0]!)
        .split(':')
        .filter(dir => path.isAbsolute(dir)),
    ),
  ]
  if (fields.length !== names.length + 1)
    return fields.length === 1 ? { path: dirs, vars: {} } : null
  const vars: Record<string, string> = {}
  names.forEach((name, i) => {
    const value = fields[i + 1]!
    // A shell that printed the reference instead of its value has none.
    if (value !== '' && value !== `$${name}`) vars[name] = value
  })
  return { path: dirs, vars }
}

export function stringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(env))
    if (value !== undefined) out[key] = value
  return out
}

/**
 * Asks the user's login shell (`$SHELL`, else `/bin/sh`) as a terminal opens
 * it: interactive first, since many set PATH in `.zshrc`; a profile that
 * hands the shell over to something else (`exec tmux`) never answers that,
 * and is asked again as a login shell only. `QMO_SHELL_PROBE=1` lets a
 * profile tell the question from a terminal.
 */
export function loginShellAsker(
  env: NodeJS.ProcessEnv,
  run: RunProbe = runProbe,
): AskLoginShell {
  const configured = env.SHELL
  const shell =
    configured !== undefined && path.isAbsolute(configured)
      ? configured
      : '/bin/sh'
  const probeEnv = { ...stringEnv(env), QMO_SHELL_PROBE: '1' }
  return async (names, timeoutMs) => {
    const until = Date.now() + timeoutMs
    for (const flags of ['-ilc', '-lc']) {
      const left = until - Date.now()
      if (left <= 0) break
      const result = await run(
        [shell, flags, shellProbe(shell, names)],
        probeEnv,
        left,
      )
      const answer = parseShellProbe(result.stdout, names)
      if (answer !== null) return answer
      if (result.timedOut) break
    }
    return null
  }
}
