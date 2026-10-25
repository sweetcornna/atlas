// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The 「变更」 panel of a session in a Git folder (qmo-local.md §4.3.7): the
 * working tree against `HEAD`, as a file list and one file's diff. Read
 * only: nothing is staged, committed or restored. Each command runs with no
 * prompt, no optional locks and the C locale, at most 10 s; paths go after
 * `--`, taken literally. `status` and `diff` run no hooks; the repository's
 * file-system monitor is turned off for them too.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { resolveInRoot, sessionRoot } from './paths.js'
import { CodeError } from './protocol.js'

const GIT_TIMEOUT_MS = 10_000
/** At most this many files are listed. */
const MAX_FILES = 1_000
/** One file's diff is cut here. */
const MAX_DIFF_BYTES = 256 * 1024
/** A file list or numstat larger than this is cut (truncated). */
const MAX_LIST_BYTES = 4 * 1024 * 1024
/** An untracked file larger than this is counted as binary, unread. */
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
}

export interface Changes {
  readonly source: 'git' | 'session'
  readonly base?: string
  readonly files: readonly ChangedFile[]
  readonly truncated: boolean
}

export interface FileDiff {
  readonly path: string
  readonly text: string
  readonly truncated: boolean
  readonly binary: boolean
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

interface GitRun {
  readonly code: number
  readonly stdout: Buffer
  readonly truncated: boolean
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

/** Runs git in `cwd`; refuses on an exit code not in `ok` or a timeout. */
async function run(
  context: GitContext,
  cwd: string,
  args: readonly string[],
  options: { readonly ok?: readonly number[]; readonly max?: number } = {},
): Promise<GitRun> {
  let proc: Bun.Subprocess<'ignore', 'pipe', 'pipe'>
  try {
    proc = Bun.spawn(
      [
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
        env: gitEnv(context.env),
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
  } catch (error) {
    throw new CodeError('E_GIT', `git 起不来：${String(error)}`)
  }
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    proc.kill('SIGKILL')
  }, GIT_TIMEOUT_MS)
  try {
    const [out, err, code] = await Promise.all([
      readCapped(proc.stdout, options.max ?? MAX_LIST_BYTES),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    if (timedOut)
      throw new CodeError('E_GIT', `git ${args[0]} 超过 10 秒没有结束`)
    if (!(options.ok ?? [0]).includes(code))
      throw new CodeError(
        'E_GIT',
        `git ${args[0]} 失败：${err.trim().split('\n')[0] ?? code}`,
      )
    return { code, stdout: out.data, truncated: out.truncated }
  } finally {
    clearTimeout(timer)
  }
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

/** `status --porcelain=v2 -z` records. */
function parseStatus(raw: string): StatusEntry[] {
  const tokens = raw.split('\0')
  const out: StatusEntry[] = []
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!
    if (token === '') continue
    const kind = token[0]
    if (kind === '?') out.push({ path: token.slice(2), status: 'untracked' })
    else if (kind === '1') {
      const fields = token.split(' ')
      const xy = fields[1] ?? '..'
      const file = fields.slice(8).join(' ')
      if (xy[0] === 'A' && xy[1] === 'D') continue // Added, then removed: no change.
      out.push({
        path: file,
        status:
          xy[0] === 'A' ? 'added' : xy.includes('D') ? 'deleted' : 'modified',
      })
    } else if (kind === '2') {
      const fields = token.split(' ')
      out.push({ path: fields.slice(9).join(' '), status: 'renamed' })
      i++ // The original path.
    } else if (kind === 'u') {
      const fields = token.split(' ')
      out.push({ path: fields.slice(10).join(' '), status: 'conflicted' })
    }
  }
  return out
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

/** Lines of a new file, or binary: a NUL early on, or too large to read. */
function countUntracked(file: string): { added: number; binary: boolean } {
  try {
    const stat = fs.statSync(file)
    if (!stat.isFile() || stat.size > MAX_COUNTED_BYTES)
      return { added: 0, binary: true }
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

/** Changes under the session's root; not a Git folder: none (P37.14d adds the session's own). */
export async function changes(
  context: GitContext | undefined,
  root: string,
): Promise<Changes> {
  const top = sessionRoot(root)
  if (gitTop(top) === undefined || context === undefined)
    return { source: 'session', files: [], truncated: false }
  const [base, prefix] = await Promise.all([
    baseOf(context, top),
    prefixOf(context, top),
  ])
  const [status, numstat] = await Promise.all([
    run(context, top, [
      'status',
      '--porcelain=v2',
      '-z',
      '--untracked-files=all',
      '--',
      '.',
    ]),
    run(context, top, [
      'diff',
      '--numstat',
      '-z',
      '--no-color',
      base,
      '--',
      '.',
    ]),
  ])
  const counts = parseNumstat(numstat.stdout.toString())
  const entries = parseStatus(status.stdout.toString())
  const files: ChangedFile[] = []
  for (const entry of entries) {
    if (files.length >= MAX_FILES) break
    if (!entry.path.startsWith(prefix)) continue
    const relative = entry.path.slice(prefix.length)
    const counted =
      entry.status === 'untracked'
        ? { ...countUntracked(path.join(top, relative)), removed: 0 }
        : counts.get(entry.path)
    if (counted === undefined && entry.status === 'modified') continue // Mode or stat only.
    files.push({
      path: relative,
      status: entry.status,
      added: counted?.added ?? 0,
      removed: counted?.removed ?? 0,
      binary: counted?.binary ?? false,
    })
  }
  return {
    source: 'git',
    base,
    files,
    truncated:
      status.truncated || numstat.truncated || entries.length > files.length,
  }
}

/** `data` without a UTF-8 character its cut left unfinished at the end. */
function wholeChars(data: Buffer): Buffer {
  let start = data.length - 1
  while (start > 0 && (data[start]! & 0xc0) === 0x80) start--
  const lead = data[start] ?? 0
  const size = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1
  return start + size > data.length ? data.subarray(0, start) : data
}

/** One file's unified diff against the base; an untracked file against nothing. */
export async function diff(
  context: GitContext | undefined,
  root: string,
  relative: string,
): Promise<FileDiff> {
  const top = sessionRoot(root)
  if (gitTop(top) === undefined || context === undefined)
    throw new CodeError('E_GIT', '不是 Git 仓库，变更在后续版本补上')
  const target = resolveInRoot(top, relative)
  const base = await baseOf(context, top)
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
          base,
          '--',
          target.relative,
        ],
        { max: MAX_DIFF_BYTES },
      )
  const text = (out.truncated ? wholeChars(out.stdout) : out.stdout).toString(
    'utf8',
  )
  const binary = /^Binary files .* differ$/m.test(text)
  return {
    path: target.relative,
    text: binary ? '' : text,
    truncated: out.truncated,
    binary,
  }
}
