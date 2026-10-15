// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * One directory of a public GitHub repository at one commit (P32,
 * `runtimes-channels.md` §9): the source of an imported skill or plugin.
 *
 * The hub pins the reference to a commit and records the directory's tree
 * digest; a node fetches the same commit from `codeload.github.com` and keeps
 * the directory only if its digest matches. The digest is over the files, not
 * the archive bytes, so it does not depend on how GitHub packs the archive.
 * Unpacking follows the in-place upgrade's rules (§5.2): member names are
 * checked before extraction, links and special files refused after it, and
 * sizes are bounded.
 */

import { createHash } from 'node:crypto'
import {
  closeSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs'
import * as path from 'node:path'
import type { OutboundPolicy } from '../commands/outboundPolicy.js'
import { runCommand, type RunCommand } from './runtimeUpdate.js'

const HOSTS: ReadonlySet<string> = new Set([
  'api.github.com',
  'codeload.github.com',
])
const MAX_ARCHIVE_BYTES = 50 * 1024 * 1024
const MAX_DIR_BYTES = 20 * 1024 * 1024
const MAX_DIR_FILES = 2_000

export const GITHUB_REPO =
  /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/
const COMMIT = /^[0-9a-f]{40}$/
const REF = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/

export class GithubDirError extends Error {}

export interface GithubDirRef {
  /** `owner/name`. */
  readonly repo: string
  /** A branch, tag or commit. */
  readonly ref: string
  /** The directory inside the repository; `''` is the root. */
  readonly path: string
}

export interface PinnedGithubDir {
  readonly repo: string
  readonly commit: string
  readonly path: string
  /** {@link treeDigest} of the directory. */
  readonly digest: string
}

/** A repository path: relative, `/`-separated, no `.` or `..` segments. */
export function cleanDirPath(raw: string): string {
  const value = raw.trim().replace(/^\/+|\/+$/g, '')
  if (value === '') return ''
  const parts = value.split('/')
  if (
    value.length > 300 ||
    value.includes('\\') ||
    parts.some(part => part === '' || part === '.' || part === '..')
  )
    throw new GithubDirError('目录路径无效')
  return value
}

export function checkRef(ref: GithubDirRef): GithubDirRef {
  if (!GITHUB_REPO.test(ref.repo))
    throw new GithubDirError('仓库要写成 owner/name')
  const at = ref.ref.trim() || 'HEAD'
  if (at !== 'HEAD' && (!REF.test(at) || at.includes('..')))
    throw new GithubDirError('分支、标签或提交号无效')
  return { repo: ref.repo, ref: at, path: cleanDirPath(ref.path) }
}

/** One request to a GitHub host; redirects are followed by hand and checked. */
async function fetchGithub(
  policy: OutboundPolicy,
  raw: string,
  accept: string,
  token: string | null,
  timeoutMs: number,
): Promise<Response> {
  let url = raw
  const signal = AbortSignal.timeout(timeoutMs)
  let init: RequestInit = {
    headers: {
      Accept: accept,
      'User-Agent': 'qianmo-agentnest',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    signal,
  }
  for (let hop = 0; hop < 4; hop++) {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:' || !HOSTS.has(parsed.hostname))
      throw new GithubDirError('下载地址不在 GitHub 范围内')
    const response = await policy.request(url, init, false)
    if (![301, 302, 303, 307, 308].includes(response.status)) return response
    await response.body?.cancel()
    const location = response.headers.get('location')
    if (!location) throw new GithubDirError('GitHub 重定向无效')
    const next = new URL(location, url)
    if (next.origin !== parsed.origin) {
      const kept = new Headers(init.headers)
      kept.delete('authorization')
      init = { headers: kept, signal }
    }
    url = next.toString()
  }
  throw new GithubDirError('GitHub 重定向过多')
}

/** The commit a branch, tag or commit names. */
export async function resolveCommit(
  policy: OutboundPolicy,
  repo: string,
  ref: string,
  token: string | null = null,
): Promise<string> {
  if (COMMIT.test(ref)) return ref
  const response = await fetchGithub(
    policy,
    `https://api.github.com/repos/${repo}/commits/${encodeURIComponent(ref)}`,
    'application/vnd.github.sha',
    token,
    30_000,
  )
  const text = (await response.text()).trim()
  if (response.status === 404 || response.status === 422)
    throw new GithubDirError('仓库或引用不存在，或不是公开仓库')
  if (!response.ok)
    throw new GithubDirError(`GitHub 答复 HTTP ${response.status}`)
  if (!COMMIT.test(text)) throw new GithubDirError('GitHub 没有给出提交号')
  return text
}

/**
 * SHA-256 over the directory's files: sorted relative paths, each with the
 * SHA-256 of its content. Modes and timestamps do not count.
 */
export function treeDigest(dir: string): string {
  const lines: string[] = []
  const walk = (at: string, rel: string): void => {
    for (const name of readdirSync(at).sort()) {
      const full = path.join(at, name)
      const relative = rel === '' ? name : `${rel}/${name}`
      const stat = lstatSync(full)
      if (stat.isDirectory()) walk(full, relative)
      else
        lines.push(
          `${relative}\0${createHash('sha256').update(readFileSync(full)).digest('hex')}`,
        )
    }
  }
  walk(dir, '')
  return createHash('sha256').update(lines.join('\n')).digest('hex')
}

function checkMembers(names: readonly string[]): void {
  if (names.length === 0) throw new GithubDirError('仓库包是空的')
  for (const raw of names) {
    const name = raw.replace(/^\.\//, '')
    const parts = name.split('/').filter(Boolean)
    if (name.startsWith('/') || parts.includes('..') || name.includes('\\'))
      throw new GithubDirError('仓库包里有越出目录的路径')
  }
}

/** Refuses links, special files and hard links; bounds files and bytes. */
function checkTree(root: string): { files: number; bytes: number } {
  let files = 0
  let bytes = 0
  const walk = (at: string): void => {
    const stat = lstatSync(at)
    if (stat.isSymbolicLink()) throw new GithubDirError('目录里有符号链接')
    if (stat.isDirectory()) {
      for (const name of readdirSync(at)) walk(path.join(at, name))
      return
    }
    if (!stat.isFile()) throw new GithubDirError('目录里有特殊文件')
    if (stat.nlink > 1) throw new GithubDirError('目录里有硬链接')
    files += 1
    bytes += stat.size
    if (files > MAX_DIR_FILES)
      throw new GithubDirError(`目录超过 ${MAX_DIR_FILES} 个文件`)
    if (bytes > MAX_DIR_BYTES)
      throw new GithubDirError(`目录超过 ${MAX_DIR_BYTES / 1024 / 1024} MB`)
  }
  walk(root)
  return { files, bytes }
}

export interface FetchedGithubDir {
  readonly digest: string
  readonly files: number
  readonly bytes: number
}

/**
 * Fetch `repo@commit`, keep only `dir`, and move it to `dest` (which must
 * not exist). `work` is a scratch directory on the same filesystem as
 * `dest`; everything left in it is removed.
 */
export async function fetchGithubDir(options: {
  readonly policy: OutboundPolicy
  readonly repo: string
  readonly commit: string
  readonly path: string
  readonly work: string
  readonly dest: string
  readonly token?: string | null
  readonly run?: RunCommand
}): Promise<FetchedGithubDir> {
  if (!GITHUB_REPO.test(options.repo) || !COMMIT.test(options.commit))
    throw new GithubDirError('仓库或提交号无效')
  const dir = cleanDirPath(options.path)
  const run = options.run ?? runCommand
  mkdirSync(options.work, { recursive: true, mode: 0o700 })
  const scratch = mkdtempSync(path.join(options.work, 'github-'))
  try {
    const response = await fetchGithub(
      options.policy,
      `https://codeload.github.com/${options.repo}/tar.gz/${options.commit}`,
      'application/octet-stream',
      options.token ?? null,
      5 * 60_000,
    )
    if (!response.ok || response.body === null) {
      await response.body?.cancel()
      throw new GithubDirError(
        response.status === 404
          ? '仓库不存在或不是公开仓库'
          : `下载仓库包失败（HTTP ${response.status}）`,
      )
    }
    const archive = path.join(scratch, 'repo.tgz')
    const fd = openSync(archive, 'wx', 0o600)
    let total = 0
    try {
      const reader = response.body.getReader()
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        total += chunk.value.byteLength
        if (total > MAX_ARCHIVE_BYTES) {
          await reader.cancel()
          throw new GithubDirError(
            `仓库包超过 ${MAX_ARCHIVE_BYTES / 1024 / 1024} MB`,
          )
        }
        writeSync(fd, chunk.value)
      }
    } finally {
      closeSync(fd)
    }
    const env = {
      PATH: process.env['PATH'] ?? '/usr/bin:/bin',
      HOME: scratch,
      LC_ALL: 'C',
    }
    const listed = await run(['tar', '-tzf', archive], {
      env,
      timeoutMs: 120_000,
      maxOutput: 8 * 1024 * 1024,
    })
    if (listed.code !== 0 || listed.truncated === true)
      throw new GithubDirError('仓库包读不开')
    const names = listed.stdout.split('\n').filter(Boolean)
    checkMembers(names)
    const tops = new Set(
      names.map(name => name.replace(/^\.\//, '').split('/')[0]),
    )
    if (tops.size !== 1) throw new GithubDirError('仓库包结构不对')
    const top = [...tops][0]!
    const root = path.join(scratch, 'root')
    mkdirSync(root, { mode: 0o700 })
    const prefix = dir === '' ? top : `${top}/${dir}`
    const extracted = await run(
      ['tar', '-xzf', archive, '-C', root, '--no-same-owner', prefix],
      { env, timeoutMs: 300_000 },
    )
    if (extracted.code !== 0)
      throw new GithubDirError(
        dir === '' ? '仓库包解不开' : `仓库里没有目录 ${dir}`,
      )
    const picked = path.join(root, ...prefix.split('/'))
    let stat
    try {
      stat = lstatSync(picked)
    } catch {
      throw new GithubDirError(`仓库里没有目录 ${dir}`)
    }
    if (!stat.isDirectory()) throw new GithubDirError(`${dir} 不是目录`)
    const counted = checkTree(picked)
    const digest = treeDigest(picked)
    mkdirSync(path.dirname(options.dest), { recursive: true, mode: 0o700 })
    renameSync(picked, options.dest)
    return { digest, ...counted }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}
