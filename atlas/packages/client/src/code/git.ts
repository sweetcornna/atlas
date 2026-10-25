// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The 「变更」 panel of a session in a Git folder (qmo-local.md §4.3.7): the
 * working tree against a base, as a file list and one file's diff. The base
 * is `HEAD` for a session in the picked folder (the empty tree before the
 * first commit) and the commit its worktree was made from for a session in a
 * worktree of its own, so what the agent committed there counts too. Read
 * only: nothing is staged, committed or restored. Each command runs with no
 * prompt, no optional locks and the C locale, at most 10 s; paths go after
 * `--`, taken literally. `status` and `diff` run no hooks; the repository's
 * file-system monitor is turned off for them too.
 *
 * Past the limits only the counts are given: a file's diff over 256 KiB is
 * not shown (`large`), an untracked file over 1 MiB is not read (`large`),
 * and past 1,000 files the rest are only counted (`omitted`).
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { resolveInRoot, sessionRoot } from './paths.js'
import { killGroup } from './processes.js'
import { CodeError } from './protocol.js'

const GIT_TIMEOUT_MS = 10_000
/** At most this many files are listed. */
const MAX_FILES = 1_000
/** A file's diff larger than this is not shown, only counted. */
const MAX_DIFF_BYTES = 256 * 1024
/** A file list or numstat larger than this is cut (truncated). */
const MAX_LIST_BYTES = 4 * 1024 * 1024
/** An untracked file larger than this is not read: large, its lines uncounted. */
const MAX_COUNTED_BYTES = 1024 * 1024

export type ChangeStatus =
  | 'modified'
  | 'added'
  | 'deleted'
  | 'renamed'
  | 'untracked'
  | 'conflicted'

export interface ChangedFile {
  /** Relative to the session's root, `/` between parts. */
  readonly path: string
  readonly status: ChangeStatus
  readonly added: number
  readonly removed: number
  readonly binary: boolean
  /** Over a limit: the counts only, no diff (an untracked one is not even read). */
  readonly large?: true
}

export interface Changes {
  readonly source: 'git' | 'session'
  readonly base?: string
  readonly files: readonly ChangedFile[]
  readonly truncated: boolean
  /** How many files past the first 1,000 were not listed. */
  readonly omitted?: number
}

export interface FileDiff {
  readonly path: string
  readonly text: string
  readonly truncated: boolean
  readonly binary: boolean
  /** Over 256 KiB: not shown, the list's counts are what there is. */
  readonly large?: true
}

/** Where git is and the environment it runs in (the login shell's PATH). */
export interface GitContext {
  readonly git: string
  readonly env: Readonly<Record<string, string>>
}

/** The folder's repository: a `.git` in it or a folder above, `undefined` when none. */
export function gitTop(folder: string): string | undefined {
  for (let at = path.resolve(folder); ; ) {
    if (fs.existsSync(path.join(at, '.git'))) return at
    const up = path.dirname(at)
    if (up === at) return undefined
    at = up
  }
}

/** git's environment: no prompt, no optional locks, the C locale, literal paths. */
export function gitEnv(
  env: Readonly<Record<string, string>>,
): Record<string, string> {
  return {
    ...env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_LITERAL_PATHSPECS: '1',
    LC_ALL: 'C',
  }
}

/** A git command that did not do its job, and how it ended. */
export class GitError extends CodeError {
  readonly ended: 'start' | 'exit' | 'timeout' | 'abort'

  constructor(ended: GitError['ended'], message: string) {
    super('E_GIT', message)
    this.name = 'GitError'
    this.ended = ended
  }
}

export interface GitRun {
  readonly code: number
  readonly stdout: Buffer
  readonly truncated: boolean
}

export interface RunOptions {
  /** Exit codes that are not a failure (default: 0). */
  readonly ok?: readonly number[]
  /** Standard output kept, in bytes; the rest is read and dropped (`truncated`). */
  readonly max?: number
  readonly timeoutMs?: number
  /** Ends the command (SIGKILL), as a refusal. */
  readonly signal?: AbortSignal
  /**
   * As a person's terminal runs it, for a command that runs the repository's
   * hooks (`worktree add`): only no prompt is added to the environment, no
   * `-c` settings, no C locale, no literal pathspecs. It leads a process
   * group of its own, so a timeout or an abort ends its hooks too.
   */
  readonly terminal?: boolean
}

async function readCapped(
  stream: ReadableStream<Uint8Array>,
  max: number,
): Promise<{ data: Buffer; truncated: boolean }> {
  const chunks: Uint8Array[] = []
  let size = 0
  let truncated = false
  const reader = stream.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (size < max) {
        chunks.push(value)
        size += value.length
      } else truncated = true
    }
  } catch {}
  const data = Buffer.concat(chunks)
  return data.length > max
    ? { data: data.subarray(0, max), truncated: true }
    : { data, truncated }
}

/**
 * Runs git in `cwd`; refuses (`E_GIT`) on an exit code not in `ok`, a
 * timeout (10 s unless said) or an abort, with the last line git wrote.
 */
export async function run(
  context: GitContext,
  cwd: string,
  args: readonly string[],
  options: RunOptions = {},
): Promise<GitRun> {
  if (options.signal?.aborted)
    throw new GitError('abort', `git ${args[0]} 已中止`)
  let proc: Bun.Subprocess<'ignore', 'pipe', 'pipe'>
  try {
    proc = Bun.spawn(
      options.terminal === true
        ? [context.git, ...args]
        : [
            context.git,
            '--no-optional-locks',
            '-c',
            'core.fsmonitor=false',
            '-c',
            'core.quotepath=off',
            ...args,
          ],
      {
        cwd,
        env:
          options.terminal === true
            ? { ...context.env, GIT_TERMINAL_PROMPT: '0' }
            : gitEnv(context.env),
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
        detached: options.terminal === true && process.platform !== 'win32',
      },
    )
  } catch (error) {
    throw new GitError('start', `git 起不来：${String(error)}`)
  }
  const timeoutMs = options.timeoutMs ?? GIT_TIMEOUT_MS
  let ended: 'timeout' | 'abort' | undefined
  const end = (why: 'timeout' | 'abort') => {
    ended ??= why
    if (options.terminal === true) killGroup(proc.pid, 'SIGKILL')
    else proc.kill('SIGKILL')
  }
  const timer = setTimeout(() => end('timeout'), timeoutMs)
  const aborted = () => end('abort')
  options.signal?.addEventListener('abort', aborted, { once: true })
  try {
    const [out, err, code] = await Promise.all([
      readCapped(proc.stdout, options.max ?? MAX_LIST_BYTES),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    if (ended === 'timeout')
      throw new GitError(
        'timeout',
        `git ${args[0]} 超过 ${Math.ceil(timeoutMs / 1000)} 秒没有结束`,
      )
    if (ended === 'abort') throw new GitError('abort', `git ${args[0]} 已中止`)
    if (!(options.ok ?? [0]).includes(code))
      throw new GitError(
        'exit',
        `git ${args[0]} 失败：${lastLine(err) || code}`,
      )
    return { code, stdout: out.data, truncated: out.truncated }
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', aborted)
  }
}

/**
 * The last line git wrote that says something: `fatal: …` comes last, and
 * so do a failed hook's own words, after git's 「Preparing worktree」.
 */
function lastLine(text: string): string {
  return (
    text
      .split('\n')
      .map(line => line.trim())
      .filter(line => line !== '')
      .pop() ?? ''
  )
}

/** What the working tree is compared with: `HEAD`, or the empty tree before the first commit. */
async function baseOf(context: GitContext, cwd: string): Promise<string> {
  const head = await run(
    context,
    cwd,
    ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'],
    { ok: [0, 1] },
  )
  if (head.code === 0) return 'HEAD'
  const empty = await run(context, cwd, [
    'hash-object',
    '-t',
    'tree',
    '--stdin',
  ])
  return empty.stdout.toString().trim()
}

/** The root's place in its repository (`sub/dir/`), from `rev-parse --show-prefix`. */
async function prefixOf(context: GitContext, cwd: string): Promise<string> {
  const out = await run(context, cwd, ['rev-parse', '--show-prefix'])
  return out.stdout.toString().trim()
}

interface StatusEntry {
  readonly path: string
  readonly status: ChangeStatus
}

/** `status --porcelain=v2 -z`: the untracked files and the conflicted ones. */
function parseStatus(raw: string): StatusEntry[] {
  const tokens = raw.split('\0')
  const out: StatusEntry[] = []
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!
    if (token === '') continue
    const kind = token[0]
    if (kind === '?') out.push({ path: token.slice(2), status: 'untracked' })
    else if (kind === 'u') {
      const fields = token.split(' ')
      out.push({ path: fields.slice(10).join(' '), status: 'conflicted' })
    } else if (kind === '2') i++ // A rename's original path.
  }
  return out
}

/**
 * `diff --name-status -z <base>`: each tracked file that differs from the
 * base, by what happened to it. A rename or copy is followed by two paths,
 * the original and the new one.
 */
function parseNameStatus(raw: string): StatusEntry[] {
  const tokens = raw.split('\0')
  const out: StatusEntry[] = []
  for (let i = 0; i < tokens.length; i++) {
    const letter = tokens[i]?.[0]
    if (letter === undefined) continue
    if (letter === 'R' || letter === 'C') {
      i += 2
      out.push({
        path: tokens[i] ?? '',
        status: letter === 'R' ? 'renamed' : 'added',
      })
      continue
    }
    i++
    out.push({
      path: tokens[i] ?? '',
      status:
        letter === 'A'
          ? 'added'
          : letter === 'D'
            ? 'deleted'
            : letter === 'U'
              ? 'conflicted'
              : 'modified',
    })
  }
  return out.filter(entry => entry.path !== '')
}

/** `diff --numstat -z`: added and removed lines by path (`-` for a binary file). */
function parseNumstat(
  raw: string,
): Map<string, { added: number; removed: number; binary: boolean }> {
  const out = new Map<
    string,
    { added: number; removed: number; binary: boolean }
  >()
  const tokens = raw.split('\0')
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!
    if (token === '') continue
    const [added = '', removed = '', ...rest] = token.split('\t')
    let file = rest.join('\t')
    if (file === '') {
      // A rename: the old path, then the new one.
      i += 2
      file = tokens[i] ?? ''
    }
    const binary = added === '-' || removed === '-'
    out.set(file, {
      added: binary ? 0 : Number(added) || 0,
      removed: binary ? 0 : Number(removed) || 0,
      binary,
    })
  }
  return out
}

/**
 * Lines of a new file, or binary: a NUL early on. One too large to read is
 * only said to be large.
 */
function countUntracked(file: string): {
  added: number
  binary: boolean
  large?: true
} {
  try {
    const stat = fs.statSync(file)
    if (!stat.isFile()) return { added: 0, binary: true }
    if (stat.size > MAX_COUNTED_BYTES)
      return { added: 0, binary: false, large: true }
    const data = fs.readFileSync(file)
    if (data.subarray(0, 8_000).includes(0)) return { added: 0, binary: true }
    if (data.length === 0) return { added: 0, binary: false }
    let lines = 0
    for (const byte of data) if (byte === 0x0a) lines++
    if (data[data.length - 1] !== 0x0a) lines++
    return { added: lines, binary: false }
  } catch {
    return { added: 0, binary: false }
  }
}

/**
 * Changes under the session's root against `base` (default: `HEAD`, or the
 * empty tree before the first commit). Not a Git folder, or no git: none,
 * `source: 'session'` (the session's own records say what changed then,
 * `recorded.ts`).
 */
export async function changes(
  context: GitContext | undefined,
  root: string,
  base?: string,
): Promise<Changes> {
  const top = sessionRoot(root)
  if (gitTop(top) === undefined || context === undefined)
    return { source: 'session', files: [], truncated: false }
  const [against, prefix] = await Promise.all([
    base ?? baseOf(context, top),
    prefixOf(context, top),
  ])
  const [names, numstat, status] = await Promise.all([
    run(context, top, [
      'diff',
      '--name-status',
      '-z',
      '--no-color',
      against,
      '--',
      '.',
    ]),
    run(context, top, [
      'diff',
      '--numstat',
      '-z',
      '--no-color',
      against,
      '--',
      '.',
    ]),
    run(context, top, [
      'status',
      '--porcelain=v2',
      '-z',
      '--untracked-files=all',
      '--',
      '.',
    ]),
  ])
  const counts = parseNumstat(numstat.stdout.toString())
  const fromStatus = parseStatus(status.stdout.toString())
  const conflicted = new Set(
    fromStatus.filter(one => one.status === 'conflicted').map(one => one.path),
  )
  const entries = [
    ...parseNameStatus(names.stdout.toString()).map(entry =>
      conflicted.has(entry.path)
        ? { path: entry.path, status: 'conflicted' as const }
        : entry,
    ),
    ...fromStatus.filter(one => one.status === 'untracked'),
  ].filter(entry => entry.path.startsWith(prefix))
  const files: ChangedFile[] = []
  for (const entry of entries.slice(0, MAX_FILES)) {
    const relative = entry.path.slice(prefix.length)
    const counted =
      entry.status === 'untracked'
        ? { ...countUntracked(path.join(top, relative)), removed: 0 }
        : counts.get(entry.path)
    files.push({
      path: relative,
      status: entry.status,
      added: counted?.added ?? 0,
      removed: counted?.removed ?? 0,
      binary: counted?.binary ?? false,
      ...(counted !== undefined && 'large' in counted && counted.large === true
        ? { large: true as const }
        : {}),
    })
  }
  const omitted = entries.length - files.length
  return {
    source: 'git',
    base: against,
    files,
    truncated:
      names.truncated || numstat.truncated || status.truncated || omitted > 0,
    ...(omitted > 0 ? { omitted } : {}),
  }
}

/** Whether a session's root is in a repository git here can read. */
export function inGit(
  context: GitContext | undefined,
  root: string,
): context is GitContext {
  if (context === undefined) return false
  try {
    return gitTop(sessionRoot(root)) !== undefined
  } catch {
    return false
  }
}

/**
 * One file's unified diff against `base` (as {@link changes}); an untracked
 * file against nothing. Over 256 KiB only the counts are given (`large`).
 */
export async function diff(
  context: GitContext | undefined,
  root: string,
  relative: string,
  base?: string,
): Promise<FileDiff> {
  const top = sessionRoot(root)
  if (gitTop(top) === undefined || context === undefined)
    throw new CodeError('E_GIT', '不是 Git 仓库')
  const target = resolveInRoot(top, relative)
  const against = base ?? (await baseOf(context, top))
  const status = await run(context, top, [
    'status',
    '--porcelain=v2',
    '-z',
    '--untracked-files=all',
    '--',
    target.relative,
  ])
  const untracked = status.stdout.toString().startsWith('? ')
  const out = untracked
    ? await run(
        context,
        top,
        [
          'diff',
          '--no-index',
          '--no-color',
          '--no-ext-diff',
          '--no-textconv',
          '-U3',
          '--',
          '/dev/null',
          target.relative,
        ],
        { ok: [0, 1], max: MAX_DIFF_BYTES },
      )
    : await run(
        context,
        top,
        [
          'diff',
          '--no-color',
          '--no-ext-diff',
          '--no-textconv',
          '-U3',
          against,
          '--',
          target.relative,
        ],
        { max: MAX_DIFF_BYTES },
      )
  if (out.truncated)
    return {
      path: target.relative,
      text: '',
      truncated: true,
      binary: false,
      large: true,
    }
  const text = out.stdout.toString('utf8')
  const binary = /^Binary files .* differ$/m.test(text)
  return {
    path: target.relative,
    text: binary ? '' : text,
    truncated: false,
    binary,
  }
}
