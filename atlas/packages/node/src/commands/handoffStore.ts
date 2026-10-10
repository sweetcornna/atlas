// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * What `qm handoff` keeps on this machine, and the names it accepts
 * (P17.4 本地命令, P17.3 会话定位).
 *
 * Everything lives under `<config root>/qianmo/handoff/` (`qianmoConfigPath`):
 *
 * | File | Holds | Written by |
 * | --- | --- | --- |
 * | `projects.json` | per repository root: project, device, hub, console, key and token-file paths | `init` |
 * | `sessions.json` | per working directory: the tool, session id and transcript path seen last | every hook |
 * | `state/<root hash>/` | `sync.lock`, `pending/`, `last.json` for one repository | `sync`, `now` |
 * | `sync.log` | one JSON line per sync attempt: outcome, refs, redaction counts | `sync`, `now` |
 *
 * **No environment variable is ever written here**, and nothing that comes
 * from one: a `notify` callback runs with qmcode's whole environment, model
 * key included (handoff-probe-p17.md 第 6 项), so the log and the state files
 * carry ids, paths, hashes and counts only. Secrets are not read by this
 * module at all, with one exception — {@link readTokenFile} returns the console
 * credential to the caller, which sends it as a header and stores it nowhere.
 *
 * JSON files are written whole (temp file, then rename, mode 0600) under a
 * short lock, because several hook processes can finish at the same moment.
 */

import { createHash } from 'node:crypto'
import {
  appendFileSync,
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { hostname } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import {
  CLOUD_DEVICE,
  type HandoffTool,
  tryExclusiveLock,
} from '@qianmo/handoff'
import { qianmoConfigPath } from '@qianmo/paths'

/** A mistake a person can fix; printed as is, exit code 1 (2 for usage). */
export class HandoffUserError extends Error {
  readonly exitCode: number

  constructor(message: string, exitCode = 1) {
    super(message)
    this.name = 'HandoffUserError'
    this.exitCode = exitCode
  }
}

/** `<config root>/qianmo/handoff/<segments>`. */
function handoffPath(...segments: string[]): string {
  return qianmoConfigPath('qianmo', 'handoff', ...segments)
}

const DIRECTORY_MODE = 0o700
const FILE_MODE = 0o600

// ─── Names ───────────────────────────────────────────────────────────

/**
 * Project and device names: the SSH gate's path alphabet (`[A-Za-z0-9._-]`,
 * which already excludes `/` and `~`, gate ruling 1) under the manifest's own
 * rules — a letter or digit first, no `..`, no trailing `.` or `.lock`.
 */
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

function isHandoffName(value: string): boolean {
  return (
    value.length <= 64 &&
    NAME.test(value) &&
    !value.includes('..') &&
    !value.endsWith('.') &&
    !value.endsWith('.lock')
  )
}

export function assertProjectName(value: string): string {
  if (!isHandoffName(value) || value.endsWith('.git')) {
    throw new HandoffUserError(
      `项目名 ${JSON.stringify(value)} 不能用：只许 A-Z a-z 0-9 . _ -，字母或数字开头，` +
        '不超过 64 个字符，不以 . / .lock / .git 结尾；用 --project 指定',
      2,
    )
  }
  return value
}

export function assertDeviceName(value: string): string {
  if (!isHandoffName(value) || value === CLOUD_DEVICE) {
    throw new HandoffUserError(
      `设备名 ${JSON.stringify(value)} 不能用：规则同项目名，且 ${CLOUD_DEVICE} 留给云端；用 --device 指定`,
      2,
    )
  }
  return value
}

/** The short host name, folded into the name alphabet; `null` if nothing is left. */
export function defaultDeviceName(host: string = hostname()): string | null {
  const folded = (host.split('.')[0] ?? '')
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/^[^A-Za-z0-9]+/, '')
    .slice(0, 64)
    .replace(/[.-]+$/, '')
  return isHandoffName(folded) && folded !== CLOUD_DEVICE ? folded : null
}

// ─── Hub location ────────────────────────────────────────────────────

/** Where the hub's bare repositories are: over SSH, or a local directory (tests). */
export type HubLocation =
  | { readonly kind: 'local'; readonly root: string }
  | { readonly kind: 'ssh'; readonly target: string; readonly root: string }

/** The SSH gate's path alphabet (`handoff-git-gate.sh` ③). */
const HUB_PATH = /^[A-Za-z0-9._~/-]+$/
/** `[user@]host`, an ssh config alias included; no option can start it. */
const SSH_TARGET = /^(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9][A-Za-z0-9._-]*$/

/** `[user@]host` or an alias from `~/.ssh/config`, never an ssh option. */
export function isSshTarget(value: string): boolean {
  return SSH_TARGET.test(value)
}

/**
 * A path on another machine as the gate takes one: its alphabet, not starting
 * with `-`, no `..` segment, `~` only as a leading `~/`. Relative paths are
 * under that machine's home.
 */
export function isRemotePath(path: string): boolean {
  return (
    path !== '' &&
    HUB_PATH.test(path) &&
    !path.startsWith('-') &&
    !`/${path}/`.includes('/../') &&
    (!path.includes('~') || /^~\/[^~]*$/.test(path))
  )
}

/**
 * `<ssh target>:<path>` or an absolute local path. The path is the directory
 * the bare repositories live in — the hub's `--handoff-root`, and the root the
 * gate was installed with. Checked against the gate's rules, so a value the
 * gate would refuse is refused here, at `init`, rather than on every push.
 */
export function parseHub(raw: string): HubLocation {
  if (raw.startsWith('/')) {
    return { kind: 'local', root: resolve(raw) }
  }
  const colon = raw.indexOf(':')
  const usage =
    '--hub 要么是 <ssh 目标>:<裸仓根目录>（如 me@hub:/srv/qianmo/handoff/repos），要么是本地绝对路径'
  if (colon <= 0) throw new HandoffUserError(usage, 2)
  const target = raw.slice(0, colon)
  const path = raw.slice(colon + 1).replace(/\/+$/, '')
  if (!isSshTarget(target)) {
    throw new HandoffUserError(`${usage}；ssh 目标 ${target} 不合规`, 2)
  }
  if (!isRemotePath(path)) {
    throw new HandoffUserError(
      `${usage}；路径只许 A-Z a-z 0-9 . _ ~ / -，不以 - 开头，没有 .. 段，~ 只能作开头的 ~/（与 SSH 闸门同一套规则）`,
      2,
    )
  }
  return { kind: 'ssh', target, root: path }
}

/** The form {@link parseHub} reads back. */
export function formatHub(hub: HubLocation): string {
  return hub.kind === 'local' ? hub.root : `${hub.target}:${hub.root}`
}

/** The git URL of one project's bare repository on the hub. */
export function hubRepoUrl(hub: HubLocation, project: string): string {
  return hub.kind === 'local'
    ? join(hub.root, `${project}.git`)
    : `${hub.target}:${hub.root}/${project}.git`
}

// ─── Console URL and token ───────────────────────────────────────────

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])

/**
 * The console's base URL. `https`, or `http` on loopback only: the bearer
 * credential rides on every request, and plain HTTP to another machine would
 * hand it to the network.
 */
export function parseConsoleUrl(raw: string): string {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new HandoffUserError(`--console 不是 URL：${raw}`, 2)
  }
  const loopback = LOOPBACK.has(url.hostname)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new HandoffUserError(
      '--console 必须是 https://…（只有 127.0.0.1 / localhost 可以用 http://）',
      2,
    )
  }
  if (url.username !== '' || url.password !== '' || url.search !== '') {
    throw new HandoffUserError('--console 里不能带用户名、密码或查询串', 2)
  }
  return url.toString().replace(/\/+$/, '')
}

/**
 * The console credential from a file, checked the way the console checks its
 * own token files: one descriptor from open to read, regular file, nobody but
 * the owner may read it.
 */
export function readTokenFile(path: string): string {
  let fd: number
  try {
    fd = openSync(path, 'r')
  } catch (error) {
    throw new HandoffUserError(
      `读不了控制台凭据文件 ${path}：${(error as NodeJS.ErrnoException).code ?? String(error)}`,
    )
  }
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile()) {
      throw new HandoffUserError(`控制台凭据 ${path} 不是普通文件`)
    }
    const mode = stat.mode & 0o777
    if (process.platform !== 'win32' && (mode & 0o077) !== 0) {
      throw new HandoffUserError(
        `控制台凭据 ${path} 别人也能读（权限 ${mode.toString(8).padStart(4, '0')}）：先 chmod 600`,
      )
    }
    const token = readFileSync(fd, 'utf8').trim()
    if (token === '') throw new HandoffUserError(`控制台凭据 ${path} 是空的`)
    return token
  } finally {
    closeSync(fd)
  }
}

// ─── JSON files ──────────────────────────────────────────────────────

function readJson(path: string): unknown {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  try {
    return JSON.parse(text)
  } catch {
    throw new HandoffUserError(`${path} 不是合法 JSON；修好或删掉它再试`)
  }
}

/** Whole-file write: temp file in the same directory, then rename. */
export function writeJsonFile(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: DIRECTORY_MODE })
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, {
    mode: FILE_MODE,
  })
  renameSync(temp, path)
}

export function readJsonFile(path: string): unknown {
  return readJson(path)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function sleep(ms: number): Promise<void> {
  return new Promise(done => setTimeout(done, ms))
}

/**
 * Run `update` with a short lock on `<path>.lock`. Waits up to `timeoutMs`
 * for another process that is in the middle of the same file.
 */
async function withShortLock<T>(
  path: string,
  update: () => T,
  timeoutMs = 2_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const lock = tryExclusiveLock(`${path}.lock`)
    if (lock !== null) {
      try {
        return update()
      } finally {
        lock.release()
      }
    }
    if (Date.now() >= deadline) {
      throw new HandoffUserError(`${path} 被另一个进程占着超过 ${timeoutMs} ms`)
    }
    await sleep(10)
  }
}

/** A path with symlinks resolved when it exists, so two spellings of one directory agree. */
export function canonicalPath(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

// ─── projects.json ───────────────────────────────────────────────────

/** One repository's handoff settings, as `init` recorded them. */
export interface HandoffProject {
  /** Repository top level; the key. */
  readonly root: string
  readonly project: string
  readonly device: string
  readonly hub: HubLocation
  /** The gate key, for an SSH hub (`-i … -o IdentitiesOnly=yes`). */
  readonly key?: string
  /** Console base URL. */
  readonly console: string
  /** File holding the console credential. */
  readonly tokenFile?: string
}

const PROJECTS_VERSION = 1

export function projectsPath(): string {
  return handoffPath('projects.json')
}

function projectsTable(): Record<string, unknown> {
  const file = readJson(projectsPath())
  if (file === undefined) return {}
  if (
    !isRecord(file) ||
    file.version !== PROJECTS_VERSION ||
    !isRecord(file.projects)
  ) {
    throw new HandoffUserError(`${projectsPath()} 的格式不认识`)
  }
  return file.projects
}

function projectOf(root: string, raw: unknown): HandoffProject {
  if (!isRecord(raw))
    throw new HandoffUserError(`${projectsPath()} 里 ${root} 一项坏了`)
  const text = (key: string): string | undefined =>
    typeof raw[key] === 'string' ? (raw[key] as string) : undefined
  const project = text('project')
  const device = text('device')
  const hub = text('hub')
  const consoleUrl = text('console')
  if (
    project === undefined ||
    device === undefined ||
    hub === undefined ||
    consoleUrl === undefined
  ) {
    throw new HandoffUserError(
      `${projectsPath()} 里 ${root} 一项缺字段；重新 init`,
    )
  }
  const key = text('key')
  const tokenFile = text('tokenFile')
  return {
    root,
    project: assertProjectName(project),
    device: assertDeviceName(device),
    hub: parseHub(hub),
    console: parseConsoleUrl(consoleUrl),
    ...(key === undefined ? {} : { key }),
    ...(tokenFile === undefined ? {} : { tokenFile }),
  }
}

/** The settings `init` recorded for the repository at `root`, if any. */
export function loadProject(root: string): HandoffProject | undefined {
  const raw = projectsTable()[root]
  return raw === undefined ? undefined : projectOf(root, raw)
}

export async function saveProject(project: HandoffProject): Promise<void> {
  const path = projectsPath()
  await withShortLock(path, () => {
    const projects = projectsTable()
    projects[project.root] = {
      project: project.project,
      device: project.device,
      hub: formatHub(project.hub),
      console: project.console,
      ...(project.key === undefined ? {} : { key: project.key }),
      ...(project.tokenFile === undefined
        ? {}
        : { tokenFile: project.tokenFile }),
    }
    writeJsonFile(path, { version: PROJECTS_VERSION, projects })
  })
}

// ─── sessions.json (会话定位) ────────────────────────────────────────

/** The last session a tool reported from one working directory. */
interface SessionLocation {
  readonly cwd: string
  readonly tool: HandoffTool
  readonly sessionId: string
  /** The transcript: qmcode rollout JSONL or Claude Code JSONL. */
  readonly file: string
  /** Epoch ms of the report. */
  readonly at: number
}

const SESSIONS_VERSION = 1
/** Oldest entries go first beyond this; one per working directory. */
const MAX_SESSIONS = 200

export function sessionsPath(): string {
  return handoffPath('sessions.json')
}

function sessionsTable(): Record<string, SessionLocation> {
  const file = readJson(sessionsPath())
  if (
    !isRecord(file) ||
    file.version !== SESSIONS_VERSION ||
    !isRecord(file.sessions)
  ) {
    return {}
  }
  const out: Record<string, SessionLocation> = {}
  for (const [cwd, raw] of Object.entries(file.sessions)) {
    if (
      isRecord(raw) &&
      (raw.tool === 'qmcode' || raw.tool === 'claude-code') &&
      typeof raw.sessionId === 'string' &&
      typeof raw.file === 'string' &&
      typeof raw.at === 'number'
    ) {
      out[cwd] = {
        cwd,
        tool: raw.tool,
        sessionId: raw.sessionId,
        file: raw.file,
        at: raw.at,
      }
    }
  }
  return out
}

/** Remember the session a hook just reported for `location.cwd`. */
export async function recordSession(location: SessionLocation): Promise<void> {
  const path = sessionsPath()
  const cwd = canonicalPath(location.cwd)
  await withShortLock(path, () => {
    const table = sessionsTable()
    table[cwd] = { ...location, cwd }
    const kept = Object.values(table)
      .sort((a, b) => b.at - a.at)
      .slice(0, MAX_SESSIONS)
    writeJsonFile(path, {
      version: SESSIONS_VERSION,
      sessions: Object.fromEntries(
        kept.map(({ cwd: key, tool, sessionId, file, at }) => [
          key,
          { tool, sessionId, file, at },
        ]),
      ),
    })
  })
}

function within(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * The session to hand over from `cwd`: the one reported from exactly this
 * directory, else the most recent one reported from anywhere in the same
 * repository.
 */
export function sessionFor(
  cwd: string,
  root: string,
): SessionLocation | undefined {
  const table = sessionsTable()
  const exact = table[canonicalPath(cwd)]
  if (exact !== undefined) return exact
  const top = canonicalPath(root)
  return Object.values(table)
    .filter(entry => within(top, entry.cwd))
    .sort((a, b) => b.at - a.at)[0]
}

// ─── Per-repository state and the log ────────────────────────────────

/** `state/<first 16 hex of sha256(root)>`: one directory per repository. */
export function stateDir(root: string): string {
  const key = createHash('sha256').update(root).digest('hex').slice(0, 16)
  return handoffPath('state', key)
}

export function syncLogPath(): string {
  return handoffPath('sync.log')
}

/** Rotated once past this, to `sync.log.1`. */
const MAX_LOG_BYTES = 1024 * 1024

/**
 * One line in `sync.log`. Callers pass ids, paths, hashes, counts and fixed
 * reasons — never an environment value, never transcript text.
 */
export function appendSyncLog(entry: Record<string, unknown>): void {
  const path = syncLogPath()
  try {
    mkdirSync(dirname(path), { recursive: true, mode: DIRECTORY_MODE })
    try {
      if (statSync(path).size > MAX_LOG_BYTES) renameSync(path, `${path}.1`)
    } catch {}
    appendFileSync(
      path,
      `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`,
      { mode: FILE_MODE },
    )
  } catch {
    // The log is the only place a hook can report to; when it cannot be
    // written there is nowhere left, and a hook must not fail its tool.
  }
}
