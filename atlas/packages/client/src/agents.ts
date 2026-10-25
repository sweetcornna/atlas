// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `qmo agents` (qmo-local.md §4.2): the coding agents installed on this
 * computer, for the desktop app's 「开发」 page and the local node.
 *
 * The detection follows magpie's (yetone/magpie, MIT: `internal/agent`
 * `Detected`, `internal/proc` `UserPath` and `Version`), written anew here;
 * the rules and where they part are in qmo-local.md §4.2.1. What a scan may
 * do (charter §2.13 item 3):
 *
 * - stat an agent's config file and folder, and list the folder's entry
 *   names; never open a file in it, never read a credential or login file,
 *   never write there;
 * - look for commands on PATH (this process's, the login shell's, the usual
 *   install folders) and read an npm package's `package.json`;
 * - run `<bin> --version`, and `dsh --help` to tell DeepSeek Harness from
 *   Debian's `dsh`. Never an agent's service or protocol mode, which can
 *   sign it in or start a session.
 *
 * What took a process to learn (versions, the `dsh --help` verdict, the
 * login shell's PATH) is kept in a 0600 file in the client state directory.
 */

import { homedir } from 'node:os'
import * as path from 'node:path'
import { stripVTControlCharacters } from 'node:util'
import { claudeConfigDir, codexHome } from '@qianmo/paths'
import {
  type AgentFs,
  type AskLoginShell,
  agentDir,
  defaultSystemDirs,
  envOf,
  type LoginEnv,
  Lookup,
  loginShellAsker,
  type Place,
  type RunProbe,
  runProbe,
  stringEnv,
  systemFs,
  taken,
  userDirs,
} from './computer.js'
import { readPrivateFile, writePrivateFile } from './secret.js'

/**
 * How the local runner drives an agent; the runtime catalog's protocols. The
 * catalog's built-in qianmopi (`omp`) is not listed: the desktop app carries
 * no `qm` (qmo-local.md §4.3.1).
 */
type AgentProtocol = 'claude-stream' | 'codex-app-server' | 'acp'

/** Where its program was found. */
type AgentSource = 'path' | 'vendor' | 'brew'

/** One agent found here, as `qmo agents --json` prints it. */
export interface LocalAgent {
  /** The runtime catalog's id for the ones the node drives. */
  readonly id: string
  readonly name: string
  readonly version: string | null
  /** The program to run, as found (not resolved through links). */
  readonly path: string | null
  /** `null`: recognised, not driven. */
  readonly protocol: AgentProtocol | null
  readonly available: boolean
  /** Why it is not available. */
  readonly reason: string | null
  readonly source: AgentSource | null
  /** Its config file, or a config folder of its own, is here. */
  readonly configFound: boolean
  /** Not looked at in this version: always `null` (unknown). */
  readonly signedIn: null
}

export interface AgentsReport {
  readonly agents: readonly LocalAgent[]
}

export interface ScanOptions {
  readonly platform?: NodeJS.Platform
  readonly env?: NodeJS.ProcessEnv
  readonly home?: string
  /** Where answers are kept between runs; none: nothing is kept. */
  readonly cacheFile?: string
  /** Ask everything again, whatever is kept (`--rescan`). */
  readonly rescan?: boolean
  readonly fs?: AgentFs
  readonly run?: RunProbe
  /** `null`: the login shell is not asked (Windows never is). */
  readonly loginShell?: AskLoginShell | null
  /** Machine-wide bin folders (Homebrew's); tests empty them. */
  readonly systemDirs?: readonly string[]
  /** Where macOS apps are installed. */
  readonly appDirs?: readonly string[]
  readonly now?: () => number
}

// ---- the agents ----------------------------------------------------------

/** Where an agent keeps its config: a folder and the files in it that are its own. */
interface Located {
  readonly dir: string
  readonly files: readonly string[]
}

interface AgentSpec {
  readonly id: string
  readonly name: string
  /** `null`: recognised, not driven (yet). */
  readonly protocol: AgentProtocol | null
  /** The command it is run as. */
  readonly command: string
  /** Its npm packages, whose `package.json` says its version. */
  readonly npm: readonly string[]
  readonly config: (at: Place) => Located
  /** Its folder is another app's too: only its config file says it is here. */
  readonly sharedDir?: true
  /**
   * Only its command says it is here: its folder, files and all, is written
   * by others as well (Gemini CLI's `~/.gemini`, by Antigravity).
   */
  readonly commandOnly?: true
  /**
   * Its command's name is other tools' too (pressly's `goose`, a database
   * migration tool): the command is taken only where these Homebrew
   * formulae or casks put it, or at {@link vendor}.
   */
  readonly brewOnly?: readonly string[]
  /** Where its vendor's own installer puts the program, off PATH until a new shell. */
  readonly vendor?: (at: Place) => readonly string[]
  /** Its macOS app, which needs no command-line program (DeepSeek Harness Desktop). */
  readonly apps?: readonly string[]
  /**
   * Told from another program of the same name by what it prints: the
   * runtime catalog's `install.identity`, kept the same (checked by
   * `qianmo-client-agents-catalog.test.ts`).
   */
  readonly identity?: {
    readonly args: readonly string[]
    readonly name: RegExp
  }
}

const UNSUPPORTED = '暂不支持接入'

/**
 * The agents a scan knows, in the order they are listed. The first six are
 * the runtime catalog's (`harness-backends.md` §1); the rest are common ones
 * the node cannot drive yet, recognised so the page can say so.
 */
export const AGENT_SPECS: readonly AgentSpec[] = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    protocol: 'claude-stream',
    command: 'claude',
    npm: ['@anthropic-ai/claude-code'],
    config: at => ({
      dir: claudeConfigDir(agentEnv(at, 'CLAUDE_CONFIG_DIR'), at.home),
      files: ['settings.json'],
    }),
    // Its old local install, in the folder it is configured in or the default one.
    vendor: at => [
      path.join(
        claudeConfigDir(agentEnv(at, 'CLAUDE_CONFIG_DIR'), at.home),
        'local',
        at.exe('claude'),
      ),
      path.join(claudeConfigDir({}, at.home), 'local', at.exe('claude')),
    ],
  },
  {
    id: 'codex',
    name: 'Codex',
    protocol: 'codex-app-server',
    command: 'codex',
    npm: ['@openai/codex'],
    config: at => ({
      dir: codexHome(agentEnv(at, 'CODEX_HOME'), at.home),
      files: ['config.toml'],
    }),
  },
  {
    id: 'gemini',
    name: 'Gemini CLI',
    protocol: 'acp',
    command: 'gemini',
    npm: ['@google/gemini-cli'],
    config: at => ({
      dir: path.join(at.env('GEMINI_CLI_HOME') ?? at.home, '.gemini'),
      files: ['settings.json'],
    }),
    commandOnly: true,
  },
  {
    id: 'qwen',
    name: 'Qwen Code',
    protocol: 'acp',
    command: 'qwen',
    npm: ['@qwen-code/qwen-code'],
    config: at => ({
      dir: at.env('QWEN_HOME') ?? path.join(at.home, '.qwen'),
      files: ['settings.json'],
    }),
  },
  {
    id: 'opencode',
    name: 'opencode',
    protocol: 'acp',
    command: 'opencode',
    npm: ['opencode-ai'],
    config: at => ({
      dir:
        at.env('OPENCODE_CONFIG_DIR') ??
        path.join(
          at.env('XDG_CONFIG_HOME') ?? path.join(at.home, '.config'),
          'opencode',
        ),
      files: ['opencode.jsonc', 'opencode.json', 'config.json'],
    }),
    vendor: at => [path.join(at.home, '.opencode', 'bin', at.exe('opencode'))],
  },
  {
    id: 'dsh',
    name: 'DeepSeek Harness',
    protocol: 'acp',
    command: 'dsh',
    npm: ['@deepseek-ai/dsh'],
    config: at => ({
      dir: at.env('DSH_HOME') ?? path.join(at.home, '.dsh'),
      files: ['config.yaml'],
    }),
    apps: ['DeepSeek Harness.app'],
    identity: { args: ['--help'], name: /DeepSeek Harness/ },
  },
  {
    id: 'cursor',
    name: 'Cursor CLI',
    protocol: null,
    command: 'cursor-agent',
    npm: [],
    // The Cursor editor makes ~/.cursor with no cursor-agent anywhere.
    config: at => ({
      dir: path.join(at.home, '.cursor'),
      files: ['cli-config.json'],
    }),
    sharedDir: true,
  },
  {
    id: 'kimi',
    name: 'Kimi Code',
    protocol: null,
    command: 'kimi',
    npm: [],
    // Kimi Code's folder, else the old kimi-cli's where only that is here.
    config: at => {
      const code = at.env('KIMI_CODE_HOME')
      if (code !== undefined) return { dir: code, files: ['config.toml'] }
      const fresh = path.join(at.home, '.kimi-code')
      const old = at.env('KIMI_SHARE_DIR') ?? path.join(at.home, '.kimi')
      return {
        dir: !at.isDir(fresh) && at.isDir(old) ? old : fresh,
        files: ['config.toml'],
      }
    },
  },
  {
    id: 'droid',
    name: 'Droid',
    protocol: null,
    command: 'droid',
    npm: [],
    config: at => ({
      dir: path.join(at.env('FACTORY_HOME_OVERRIDE') ?? at.home, '.factory'),
      files: ['settings.json', 'config.json'],
    }),
  },
  {
    id: 'copilot',
    name: 'Copilot CLI',
    protocol: null,
    command: 'copilot',
    npm: ['@github/copilot'],
    // GitHub Copilot's editor plugins write ~/.copilot too.
    config: at => ({
      dir: path.join(at.home, '.copilot'),
      files: ['settings.json'],
    }),
    sharedDir: true,
  },
  {
    id: 'goose',
    name: 'Goose',
    protocol: null,
    command: 'goose',
    npm: [],
    config: at => ({
      dir:
        at.platform === 'win32' && at.env('APPDATA') !== undefined
          ? path.join(at.env('APPDATA')!, 'Block', 'goose', 'config')
          : path.join(
              at.env('XDG_CONFIG_HOME') ?? path.join(at.home, '.config'),
              'goose',
            ),
      files: ['config.yaml'],
    }),
    brewOnly: ['block-goose-cli'],
    vendor: at => [path.join(at.home, '.local', 'bin', at.exe('goose'))],
  },
]

// ---- this computer -------------------------------------------------------

/** `name`'s value at `at`, as an environment for `@qianmo/paths`. */
function agentEnv(at: Place, name: string): NodeJS.ProcessEnv {
  const value = at.env(name)
  return value === undefined ? {} : { [name]: value }
}

/**
 * Asked of the login shell beside PATH: the agents' own folder variables, and
 * the Node tool managers' that say where commands go. A desktop app started
 * from the Dock has none of what a shell profile sets.
 */
const LOGIN_VARS = [
  'CLAUDE_CONFIG_DIR',
  'CODEX_HOME',
  'GEMINI_CLI_HOME',
  'QWEN_HOME',
  'OPENCODE_CONFIG_DIR',
  'XDG_CONFIG_HOME',
  'DSH_HOME',
  'KIMI_CODE_HOME',
  'KIMI_SHARE_DIR',
  'FACTORY_HOME_OVERRIDE',
  'NVM_DIR',
  'FNM_DIR',
  'BUN_INSTALL',
  'VOLTA_HOME',
  'PNPM_HOME',
  'NPM_CONFIG_PREFIX',
  'npm_config_prefix',
] as const

const BREW_KEG = /[\\/](Cellar|Caskroom)[\\/]([^\\/]+)[\\/]/

// ---- versions ------------------------------------------------------------

/**
 * Numbers joined by dots, two or more, with a pre-release tag
 * (`0.2.1-rc.2`, `2026.10.01-e373342`), not inside a longer word or number.
 */
const VERSION = /(?<![\w.])v?(\d+(?:\.\d+)+(?:-[\dA-Za-z]+(?:\.[\dA-Za-z]+)*)?)/

/** The first version in what a program printed (`codex-cli 0.163.0`). */
function parseVersion(output: string): string | null {
  return VERSION.exec(stripVTControlCharacters(output))?.[1] ?? null
}

/** A package manifest's version when it is one of `packages`. */
function manifestVersion(
  fsx: AgentFs,
  dir: string,
  packages: readonly string[],
): string | null {
  const text = fsx.read(path.join(dir, 'package.json'))
  if (text === null) return null
  try {
    const manifest: unknown = JSON.parse(text)
    if (
      typeof manifest === 'object' &&
      manifest !== null &&
      'name' in manifest &&
      typeof manifest.name === 'string' &&
      packages.includes(manifest.name) &&
      'version' in manifest &&
      typeof manifest.version === 'string' &&
      parseVersion(` ${manifest.version}`) !== null
    )
      return manifest.version
  } catch {}
  return null
}

/**
 * The version of the npm package the file at `real` is in
 * (`…/node_modules/@openai/codex/bin/codex.js`), read rather than run, when
 * it is one of the agent's packages.
 */
function npmVersion(
  fsx: AgentFs,
  real: string,
  packages: readonly string[],
): string | null {
  if (packages.length === 0) return null
  for (let dir = path.dirname(real); ; dir = path.dirname(dir)) {
    const up = path.dirname(dir)
    if (up === dir) return null
    const name = path.basename(up)
    if (
      name === 'node_modules' ||
      (name.startsWith('@') &&
        path.basename(path.dirname(up)) === 'node_modules')
    )
      return manifestVersion(fsx, dir, packages)
  }
}

/**
 * The version of the npm package a Windows shim starts: npm puts
 * `claude.cmd` beside `node_modules`, not a link into it, and the shim
 * names the package's file.
 */
function shimVersion(
  fsx: AgentFs,
  bin: string,
  packages: readonly string[],
): string | null {
  const text = fsx.read(bin)
  if (text === null) return null
  const match =
    /[\\/]node_modules[\\/]((?:@[^\\/"'%$\s]+[\\/])?[^\\/"'%$\s]+)[\\/]/.exec(
      text,
    )
  if (match === null) return null
  const name = match[1]!.replace(/\\/g, '/')
  if (!packages.includes(name)) return null
  return manifestVersion(
    fsx,
    path.join(path.dirname(bin), 'node_modules', ...name.split('/')),
    packages,
  )
}

// ---- answers kept between runs -------------------------------------------

/** A good answer is kept a day, a failed one ten minutes (magpie's). */
const KEEP_OK_MS = 24 * 60 * 60 * 1000
const KEEP_FAILED_MS = 10 * 60 * 1000
/** The login shell is asked again after ten minutes. */
const KEEP_LOGIN_MS = 10 * 60 * 1000

interface KeptVersion {
  readonly stamp: string
  readonly at: number
  readonly version: string | null
}

interface KeptIdentity {
  readonly stamp: string
  readonly at: number
  /** `null`: it could not be told (`why`). */
  readonly ok: boolean | null
  readonly why?: string
}

interface KeptLogin {
  readonly at: number
  readonly shell: string
  /** `null`: the shell did not say in time. */
  readonly path: readonly string[] | null
  readonly vars: Readonly<Record<string, string>>
}

interface KeptAnswers {
  readonly versions: Record<string, KeptVersion>
  readonly identity: Record<string, KeptIdentity>
  login?: KeptLogin
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function keptEntries<T>(
  value: unknown,
  valid: (entry: Record<string, unknown>) => boolean,
): Record<string, T> {
  if (!isRecord(value)) return {}
  return Object.fromEntries(
    Object.entries(value).filter(
      ([, entry]) =>
        isRecord(entry) &&
        typeof entry.stamp === 'string' &&
        typeof entry.at === 'number' &&
        valid(entry),
    ),
  ) as Record<string, T>
}

function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
}

/** What earlier scans learned by running something, in the client state directory. */
class AnswerCache {
  readonly #file: string | undefined
  readonly #now: () => number
  readonly #answers: KeptAnswers = { versions: {}, identity: {} }
  #changed = false

  constructor(file: string | undefined, rescan: boolean, now: () => number) {
    this.#file = file
    this.#now = now
    if (file === undefined || rescan) return
    let raw: unknown
    try {
      // Another user's file, a link or a damaged one is not taken; the scan
      // asks anew and replaces it.
      raw = JSON.parse(readPrivateFile(file) ?? 'null')
    } catch {
      return
    }
    if (!isRecord(raw) || raw.v !== 1) return
    Object.assign(
      this.#answers.versions,
      keptEntries<KeptVersion>(
        raw.versions,
        entry => entry.version === null || typeof entry.version === 'string',
      ),
    )
    Object.assign(
      this.#answers.identity,
      keptEntries<KeptIdentity>(
        raw.identity,
        entry => entry.ok === null || typeof entry.ok === 'boolean',
      ),
    )
    const login = raw.login
    if (
      isRecord(login) &&
      typeof login.at === 'number' &&
      typeof login.shell === 'string' &&
      (login.path === null || strings(login.path)) &&
      isRecord(login.vars) &&
      Object.values(login.vars).every(item => typeof item === 'string')
    )
      this.#answers.login = login as unknown as KeptLogin
  }

  #fresh(at: number, ok: boolean, keep = ok ? KEEP_OK_MS : KEEP_FAILED_MS) {
    const age = this.#now() - at
    return age >= 0 && age < keep
  }

  version(bin: string, stamp: string): KeptVersion | undefined {
    const kept = this.#answers.versions[bin]
    return kept?.stamp === stamp && this.#fresh(kept.at, kept.version !== null)
      ? kept
      : undefined
  }

  keepVersion(bin: string, stamp: string, version: string | null): void {
    this.#answers.versions[bin] = { stamp, at: this.#now(), version }
    this.#changed = true
  }

  identity(bin: string, stamp: string): KeptIdentity | undefined {
    const kept = this.#answers.identity[bin]
    return kept?.stamp === stamp && this.#fresh(kept.at, kept.ok !== null)
      ? kept
      : undefined
  }

  keepIdentity(bin: string, kept: Omit<KeptIdentity, 'at'>): void {
    this.#answers.identity[bin] = { ...kept, at: this.#now() }
    this.#changed = true
  }

  login(shell: string): KeptLogin | undefined {
    const kept = this.#answers.login
    return kept?.shell === shell && this.#fresh(kept.at, true, KEEP_LOGIN_MS)
      ? kept
      : undefined
  }

  keepLogin(shell: string, answer: LoginEnv | null): void {
    this.#answers.login = {
      at: this.#now(),
      shell,
      path: answer?.path ?? null,
      vars: answer?.vars ?? {},
    }
    this.#changed = true
  }

  /** Writes what changed, without what is older than a day. A failed write only loses the cache. */
  save(): void {
    if (this.#file === undefined || !this.#changed) return
    const recent = <T extends { readonly at: number }>(
      entries: Record<string, T>,
    ) =>
      Object.fromEntries(
        Object.entries(entries).filter(([, entry]) =>
          this.#fresh(entry.at, true),
        ),
      )
    try {
      writePrivateFile(
        this.#file,
        `${JSON.stringify({
          v: 1,
          versions: recent(this.#answers.versions),
          identity: recent(this.#answers.identity),
          ...(this.#answers.login === undefined
            ? {}
            : { login: this.#answers.login }),
        })}\n`,
      )
    } catch {}
  }
}

// ---- the scan ------------------------------------------------------------

/** How long a scan waits for the login shell (magpie's); `--rescan` waits longer. */
const SHELL_WAIT_MS = 2_000
const RESCAN_SHELL_WAIT_MS = 5_000

/** How long a `--version` or `--help` may take. */
const PROBE_TIMEOUT_MS = 10_000

interface Candidate {
  readonly bin: string
  readonly source: AgentSource
}

interface Scan {
  readonly place: Place
  readonly fsx: AgentFs
  readonly look: Lookup
  readonly cache: AnswerCache
  readonly run: RunProbe
  readonly runEnv: Record<string, string>
  readonly appDirs: readonly string[]
}

/** What a program's file is now: where its links lead, its size and time. */
function stampOf(fsx: AgentFs, bin: string): string | null {
  const real = fsx.realpath(bin) ?? bin
  const stat = fsx.stat(real)
  return stat === null ? null : `${real}\0${stat.size}\0${stat.mtimeMs}`
}

/**
 * The version of the agent's own npm package `bin` is a program of (through
 * its links, or a Windows shim), read rather than run; `null` when it is in
 * none of them. Such a program is the agent, whatever its name is shared with.
 */
function packagedVersion(
  scan: Scan,
  spec: AgentSpec,
  bin: string,
): string | null {
  const { fsx } = scan
  return (
    npmVersion(fsx, fsx.realpath(bin) ?? bin, spec.npm) ??
    (scan.place.platform === 'win32' ? shimVersion(fsx, bin, spec.npm) : null)
  )
}

/**
 * The agent's version: its npm package's, read; else what `--version`
 * prints, kept while the program's file is the same.
 */
async function versionOf(
  scan: Scan,
  spec: AgentSpec,
  bin: string,
): Promise<string | null> {
  const { fsx, cache } = scan
  const read = packagedVersion(scan, spec, bin)
  if (read !== null) return read
  const stamp = stampOf(fsx, bin)
  if (stamp === null) return null
  const kept = cache.version(bin, stamp)
  if (kept !== undefined) return kept.version
  const result = await scan.run(
    [bin, '--version'],
    scan.runEnv,
    PROBE_TIMEOUT_MS,
  )
  const version = result.timedOut
    ? null
    : parseVersion(`${result.stdout}\n${result.stderr}`)
  cache.keepVersion(bin, stamp, version)
  return version
}

/** `null` when `bin` is the agent; else why it is not taken. */
async function identify(
  scan: Scan,
  spec: AgentSpec,
  rule: NonNullable<AgentSpec['identity']>,
  bin: string,
): Promise<string | null> {
  const shown = rule.args.join(' ')
  const stamp = stampOf(scan.fsx, bin)
  let kept = stamp === null ? undefined : scan.cache.identity(bin, stamp)
  if (kept === undefined) {
    const result = await scan.run(
      [bin, ...rule.args],
      scan.runEnv,
      PROBE_TIMEOUT_MS,
    )
    const answer: Omit<KeptIdentity, 'at'> =
      result.timedOut || result.code === null
        ? {
            stamp: stamp ?? '',
            ok: null,
            why: result.timedOut
              ? `${PROBE_TIMEOUT_MS / 1000} 秒没有结束`
              : result.stderr.trim().split('\n')[0] || '没能运行',
          }
        : { stamp: stamp ?? '', ok: rule.name.test(result.stdout) }
    if (stamp !== null) scan.cache.keepIdentity(bin, answer)
    kept = { ...answer, at: 0 }
  }
  if (kept.ok === true) return null
  return kept.ok === false
    ? `${bin} 不是 ${spec.name}（它的 ${shown} 里没有这个名字）`
    : `${bin} 核对不了是不是 ${spec.name}（${spec.command} ${shown}：${kept.why}）`
}

/** The agent as found here, `null` when nothing says it is installed. */
async function inspect(
  scan: Scan,
  spec: AgentSpec,
): Promise<LocalAgent | null> {
  const { place, fsx, look } = scan
  const located = spec.config(place)
  // A file where its folder goes (a shell's ~/.dsh): it could not be here.
  if (taken(fsx, located.dir)) return null
  const configFile = located.files.some(
    file => fsx.stat(path.join(located.dir, file)) !== null,
  )
  const configFound =
    configFile ||
    (spec.sharedDir !== true &&
      spec.commandOnly !== true &&
      agentDir(fsx, located.dir))
  const brew = spec.brewOnly
  const onPath = look
    .all(spec.command)
    .filter(bin => {
      if (brew === undefined) return true
      const keg = BREW_KEG.exec(fsx.realpath(bin) ?? bin)
      return keg !== null && brew.includes(keg[2]!)
    })
    .map((bin): Candidate => ({ bin, source: brew ? 'brew' : 'path' }))
  const vendor = (spec.vendor?.(place) ?? [])
    .filter(
      (bin, i, all) =>
        all.indexOf(bin) === i &&
        !onPath.some(found => found.bin === bin) &&
        look.executable(bin),
    )
    .map((bin): Candidate => ({ bin, source: 'vendor' }))
  const candidates = [...onPath, ...vendor]
  const app =
    place.platform === 'darwin' &&
    (spec.apps ?? []).some(name =>
      scan.appDirs.some(dir => place.isDir(path.join(dir, name))),
    )
  const here =
    spec.commandOnly === true
      ? candidates.length > 0
      : configFound || app || candidates.length > 0
  if (!here) return null

  let chosen: Candidate | undefined
  let rejected: string | undefined
  if (spec.identity === undefined) chosen = candidates[0]
  else
    for (const candidate of candidates) {
      // A program of its own npm package needs no asking.
      const why =
        packagedVersion(scan, spec, candidate.bin) !== null
          ? null
          : await identify(scan, spec, spec.identity, candidate.bin)
      if (why === null) {
        chosen = candidate
        break
      }
      rejected ??= why
    }
  const version =
    chosen === undefined ? null : await versionOf(scan, spec, chosen.bin)
  const reason =
    spec.protocol === null
      ? UNSUPPORTED
      : chosen !== undefined
        ? null
        : (rejected ??
          (app && !configFound
            ? 'CLI 未找到（只装了桌面 App）'
            : `CLI 未找到（有 ${located.dir}，但 PATH 与常见安装位置里都没有 ${spec.command}）`))
  return {
    id: spec.id,
    name: spec.name,
    version,
    path: chosen?.bin ?? null,
    protocol: spec.protocol,
    available: reason === null,
    reason,
    source: chosen?.source ?? null,
    configFound,
    signedIn: null,
  }
}

/** The agents installed on this computer, in {@link AGENT_SPECS}' order. */
export async function scanAgents(
  options: ScanOptions = {},
): Promise<AgentsReport> {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const home = options.home ?? homedir()
  const fsx = options.fs ?? systemFs
  const rescan = options.rescan === true
  const cache = new AnswerCache(
    options.cacheFile,
    rescan,
    options.now ?? Date.now,
  )

  const ask =
    options.loginShell !== undefined
      ? options.loginShell
      : platform === 'win32'
        ? null
        : loginShellAsker(env)
  let login: LoginEnv | null = null
  if (ask !== null) {
    const shell = env.SHELL ?? ''
    const kept = cache.login(shell)
    if (kept !== undefined)
      login = kept.path === null ? null : { path: kept.path, vars: kept.vars }
    else {
      login = await ask(
        LOGIN_VARS,
        rescan ? RESCAN_SHELL_WAIT_MS : SHELL_WAIT_MS,
      )
      cache.keepLogin(shell, login)
    }
  }

  const place: Place = {
    platform,
    home,
    env: name => {
      for (const value of [envOf(env, name, platform), login?.vars[name]])
        if (value !== undefined && value !== '' && path.isAbsolute(value))
          return value
      return undefined
    },
    isDir: dir => fsx.stat(dir)?.isDirectory() ?? false,
    exe: name => (platform === 'win32' ? `${name}.exe` : name),
  }
  const delimiter = platform === 'win32' ? ';' : ':'
  const dirs: string[] = []
  for (const dir of [
    ...(envOf(env, 'PATH', platform) ?? '').split(delimiter),
    ...(login?.path ?? []),
    ...userDirs(place, fsx),
    ...(options.systemDirs ?? defaultSystemDirs(platform)),
  ])
    if (
      dir !== undefined &&
      dir !== '' &&
      path.isAbsolute(dir) &&
      !dirs.includes(dir) &&
      place.isDir(dir)
    )
      dirs.push(dir)

  const scan: Scan = {
    place,
    fsx,
    look: new Lookup(dirs, platform, fsx, envOf(env, 'PATHEXT', platform)),
    cache,
    run: options.run ?? runProbe,
    // A Node.js program's `#!/usr/bin/env node` finds the Node the folders have.
    runEnv: { ...stringEnv(env), PATH: dirs.join(delimiter), NO_COLOR: '1' },
    appDirs: options.appDirs ?? [
      '/Applications',
      path.join(home, 'Applications'),
    ],
  }
  const found = await Promise.all(AGENT_SPECS.map(spec => inspect(scan, spec)))
  cache.save()
  return { agents: found.filter(agent => agent !== null) }
}

/** Columns a terminal gives `text`: two for each wide (CJK) character. */
function columns(text: string): number {
  let width = 0
  for (const char of text)
    width +=
      /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/.test(
        char,
      )
        ? 2
        : 1
  return width
}

/** `qmo agents` for a person: one line each. */
export function formatAgents(report: AgentsReport): string[] {
  const rows = report.agents.map(agent => [
    agent.name,
    agent.path === null ? '—' : (agent.version ?? '版本不明'),
    agent.available ? '可用' : `不可用 · ${agent.reason}`,
    agent.path ?? '',
  ])
  const widths = [0, 1].map(column =>
    Math.max(...rows.map(row => columns(row[column]!))),
  )
  const pad = (text: string, column: number) =>
    text + ' '.repeat(widths[column]! - columns(text))
  return rows.map(([name, version, state, where]) =>
    [pad(name!, 0), pad(version!, 1), state, where]
      .filter(cell => cell !== '')
      .join('  '),
  )
}
