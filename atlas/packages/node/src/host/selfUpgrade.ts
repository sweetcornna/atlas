// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Upgrading qianmo itself in place (P31, `runtimes-channels.md` §5.2), the
 * way sub2api does it, fitted to a deployment tree (`<tree>/dist/qm-<platform>`
 * and `<tree>/demo`):
 *
 * 1. only a GitHub release of the configured repository, only the asset for
 *    this platform (`qianmo-<version>-<platform>.tgz`), only from GitHub hosts;
 * 2. its SHA-256 must match the release's `<asset>.sha256` (or `SHA256SUMS`);
 * 3. it is unpacked on the tree's own filesystem (so the swap is a rename),
 *    with names checked before extraction and links refused after it;
 * 4. the new `qm --version` must name the release;
 * 5. the caller drains its work, then the live entries are renamed to
 *    `<entry>.bak-upgrade` and the new ones renamed in — any failure puts the
 *    old ones back;
 * 6. the process stops through its normal SIGTERM path and, once the event
 *    loop is empty, `execve`s the new binary: same PID, same arguments, so
 *    the fleet's pid files keep naming it.
 *
 * Rolling back swaps the backup and the live tree, or installs one of the
 * three newest releases older than the running one. One upgrade at a time
 * per tree (`.qianmo-upgrade.lock`).
 */

import {
  closeSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statfsSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import * as path from 'node:path'
import { boundedText, type OutboundPolicy } from '../commands/outboundPolicy.js'
import { runCommand, type RunCommand } from './runtimeUpdate.js'

/** Where release metadata and assets may come from (and redirect to). */
const HOSTS: ReadonlySet<string> = new Set([
  'api.github.com',
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
])

const ENTRIES = ['dist', 'demo'] as const
const BACKUP = '.bak-upgrade'
const MAX_ARCHIVE_BYTES = 400 * 1024 * 1024
const MAX_TREE_BYTES = 2 * 1024 * 1024 * 1024
const ROLLBACK_VERSIONS = 3

export class UpgradeError extends Error {}

// -- versions -----------------------------------------------------------------

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/

/** Semantic order; a pre-release sorts before its release. Unparsable sorts first. */
export function compareVersions(a: string, b: string): number {
  const x = SEMVER.exec(a.trim())
  const y = SEMVER.exec(b.trim())
  if (x === null || y === null) return x === null ? (y === null ? 0 : -1) : 1
  for (let i = 1; i <= 3; i++) {
    const d = Number(x[i]) - Number(y[i])
    if (d !== 0) return Math.sign(d)
  }
  if (x[4] === undefined || y[4] === undefined)
    return x[4] === y[4] ? 0 : x[4] === undefined ? 1 : -1
  return x[4] < y[4] ? -1 : x[4] > y[4] ? 1 : 0
}

export function plainVersion(tag: string): string {
  return tag.trim().replace(/^v/, '')
}

// -- the running install ------------------------------------------------------

export interface InstallTree {
  /** The deployment tree holding `dist/` and `demo/`. */
  readonly tree: string
  /** `linux-x64`, `darwin-arm64` … */
  readonly platform: string
  readonly bin: string
}

/** The tree this compiled `qm` runs from; null for a source run. */
export function installTree(execPath = process.execPath): InstallTree | null {
  let bin: string
  try {
    bin = realpathSync(execPath)
  } catch {
    return null
  }
  const match = /^qm-(linux|darwin)-(x64|arm64)$/.exec(path.basename(bin))
  if (match === null || path.basename(path.dirname(bin)) !== 'dist') return null
  return {
    tree: path.dirname(path.dirname(bin)),
    platform: `${match[1]}-${match[2]}`,
    bin,
  }
}

export interface BackupFacts {
  /** The version the backup holds, when the swap recorded it. */
  readonly version: string | null
  readonly at: number | null
}

interface UpgradeRecord {
  readonly from: string | null
  readonly to: string
  readonly at: number
}

function recordPath(tree: InstallTree): string {
  return path.join(tree.tree, '.qianmo-upgrade.json')
}

function readRecord(tree: InstallTree): UpgradeRecord | null {
  try {
    const value = JSON.parse(
      readFileSync(recordPath(tree), 'utf8'),
    ) as Partial<UpgradeRecord>
    return typeof value.to === 'string' && typeof value.at === 'number'
      ? {
          from: typeof value.from === 'string' ? value.from : null,
          to: value.to,
          at: value.at,
        }
      : null
  } catch {
    return null
  }
}

/** What a rollback to the local backup would bring back; null without one. */
export function backupOf(tree: InstallTree): BackupFacts | null {
  if (!ENTRIES.some(entry => existsSync(path.join(tree.tree, entry + BACKUP))))
    return null
  const record = readRecord(tree)
  return { version: record?.from ?? null, at: record?.at ?? null }
}

// -- GitHub -------------------------------------------------------------------

export interface ReleaseAsset {
  readonly name: string
  /** The API URL; downloads ask it for `application/octet-stream`. */
  readonly url: string
  readonly size: number
}

export interface Release {
  readonly version: string
  readonly publishedAt: string
  readonly htmlUrl: string
  readonly draft: boolean
  readonly prerelease: boolean
  readonly assets: readonly ReleaseAsset[]
}

export interface ReleaseSource {
  readonly policy: OutboundPolicy
  /** `owner/name`. */
  readonly repo: string
  /** Only needed for a private repository. */
  readonly token?: string | null
}

function headers(
  source: ReleaseSource,
  accept: string,
): Record<string, string> {
  return {
    Accept: accept,
    'User-Agent': 'qianmo-agentnest',
    'X-GitHub-Api-Version': '2022-11-28',
    ...(source.token ? { Authorization: `Bearer ${source.token}` } : {}),
  }
}

/** One GitHub request; redirects are followed by hand so every hop is checked. */
async function fetchChecked(
  source: ReleaseSource,
  raw: string,
  accept: string,
  timeoutMs = 30_000,
): Promise<Response> {
  let url = raw
  const signal = AbortSignal.timeout(timeoutMs)
  let init: RequestInit = { headers: headers(source, accept), signal }
  for (let hop = 0; hop < 4; hop++) {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:' || !HOSTS.has(parsed.hostname))
      throw new UpgradeError('下载地址不在 GitHub 范围内')
    const response = await source.policy.request(url, init, false)
    if (![301, 302, 303, 307, 308].includes(response.status)) return response
    await response.body?.cancel()
    const location = response.headers.get('location')
    if (!location) throw new UpgradeError('GitHub 重定向无效')
    const next = new URL(location, url)
    if (next.origin !== parsed.origin) {
      const kept = new Headers(init.headers)
      kept.delete('authorization')
      init = { headers: kept, signal }
    }
    url = next.toString()
  }
  throw new UpgradeError('GitHub 重定向过多')
}

function releaseOf(raw: unknown): Release {
  const value = raw as {
    tag_name?: unknown
    published_at?: unknown
    html_url?: unknown
    draft?: unknown
    prerelease?: unknown
    assets?: unknown
  }
  if (typeof value?.tag_name !== 'string')
    throw new UpgradeError('GitHub 发行信息无效')
  const assets = Array.isArray(value.assets) ? value.assets : []
  return {
    version: plainVersion(value.tag_name),
    publishedAt:
      typeof value.published_at === 'string' ? value.published_at : '',
    htmlUrl: typeof value.html_url === 'string' ? value.html_url : '',
    draft: value.draft === true,
    prerelease: value.prerelease === true,
    assets: assets.flatMap(
      (one: { name?: unknown; url?: unknown; size?: unknown }) =>
        typeof one?.name === 'string' && typeof one.url === 'string'
          ? [
              {
                name: one.name,
                url: one.url,
                size: typeof one.size === 'number' ? one.size : 0,
              },
            ]
          : [],
    ),
  }
}

async function apiJson(
  source: ReleaseSource,
  suffix: string,
): Promise<unknown> {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(source.repo))
    throw new UpgradeError('仓库名不合法')
  const response = await fetchChecked(
    source,
    `https://api.github.com/repos/${source.repo}/${suffix}`,
    'application/vnd.github+json',
  )
  if (!response.ok) {
    await response.body?.cancel()
    throw new UpgradeError(
      response.status === 404
        ? '仓库没有发行，或令牌看不到它'
        : `GitHub 查询失败（HTTP ${response.status}）`,
    )
  }
  return JSON.parse(await boundedText(response, 4 * 1024 * 1024))
}

export async function latestRelease(source: ReleaseSource): Promise<Release> {
  return releaseOf(await apiJson(source, 'releases/latest'))
}

/** The newest releases older than `current`, newest first, at most three. */
export async function rollbackReleases(
  source: ReleaseSource,
  current: string,
): Promise<Release[]> {
  const raw = await apiJson(source, 'releases?per_page=15')
  if (!Array.isArray(raw)) throw new UpgradeError('GitHub 发行列表无效')
  const seen = new Set<string>()
  return raw
    .map(releaseOf)
    .filter(one => {
      if (one.draft || one.prerelease || seen.has(one.version)) return false
      seen.add(one.version)
      return (
        SEMVER.test(one.version) && compareVersions(one.version, current) < 0
      )
    })
    .sort((a, b) => compareVersions(b.version, a.version))
    .slice(0, ROLLBACK_VERSIONS)
}

export async function releaseByVersion(
  source: ReleaseSource,
  version: string,
): Promise<Release> {
  if (!SEMVER.test(version)) throw new UpgradeError('版本号不合法')
  return releaseOf(
    await apiJson(source, `releases/tags/v${plainVersion(version)}`),
  )
}

export function assetName(version: string, platform: string): string {
  return `qianmo-${version}-${platform}.tgz`
}

// -- staging ------------------------------------------------------------------

export interface StagedUpgrade {
  readonly version: string
  /** The scratch directory inside the tree; removed after the swap. */
  readonly dir: string
  /** The unpacked `dist/` and `demo/`. */
  readonly root: string
  readonly entries: readonly string[]
}

function treeBytes(target: string): number {
  let total = 0
  const walk = (at: string): void => {
    const stat = lstatSync(at, { throwIfNoEntry: false })
    if (stat === undefined) return
    if (stat.isDirectory())
      for (const name of readdirSync(at)) walk(path.join(at, name))
    else total += stat.size
  }
  walk(target)
  return total
}

function freeBytes(target: string): number {
  const stat = statfsSync(target)
  return stat.bavail * stat.bsize
}

function removeBackups(tree: InstallTree): void {
  for (const entry of ENTRIES)
    rmSync(path.join(tree.tree, entry + BACKUP), {
      recursive: true,
      force: true,
    })
}

async function download(
  source: ReleaseSource,
  asset: ReleaseAsset,
  dest: string,
  limit: number,
): Promise<void> {
  const response = await fetchChecked(
    source,
    asset.url,
    'application/octet-stream',
    20 * 60_000,
  )
  if (!response.ok || response.body === null) {
    await response.body?.cancel()
    throw new UpgradeError(`下载 ${asset.name} 失败（HTTP ${response.status}）`)
  }
  const fd = openSync(dest, 'wx', 0o600)
  let bytes = 0
  try {
    const reader = response.body.getReader()
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > limit) {
        await reader.cancel()
        throw new UpgradeError(
          `${asset.name} 超过 ${Math.round(limit / 1048576)} MB`,
        )
      }
      writeSync(fd, chunk.value)
    }
  } finally {
    closeSync(fd)
  }
}

async function sha256(file: string): Promise<string> {
  const hasher = new Bun.CryptoHasher('sha256')
  const reader = Bun.file(file).stream().getReader()
  for (;;) {
    const chunk = await reader.read()
    if (chunk.done) break
    hasher.update(chunk.value)
  }
  return hasher.digest('hex')
}

/** `<hex>  <name>` or `<hex> *<name>` lines; the entry for `name`, or null. */
export function expectedHash(sums: string, name: string): string | null {
  for (const line of sums.split('\n')) {
    const match = /^([0-9a-f]{64})\s+\*?(\S+)\s*$/i.exec(line.trim())
    if (match !== null && match[2] === name) return match[1]!.toLowerCase()
  }
  return null
}

/** Archive member names: relative, no `..`, under `dist/` or `demo/` only. */
export function checkMembers(names: readonly string[]): void {
  if (names.length === 0) throw new UpgradeError('更新包是空的')
  for (const raw of names) {
    const name = raw.replace(/^\.\//, '')
    if (name === '' || name === '.') continue
    const parts = name.split('/').filter(Boolean)
    if (name.startsWith('/') || parts.includes('..') || name.includes('\\'))
      throw new UpgradeError('更新包里有越出目录的路径')
    if (!(ENTRIES as readonly string[]).includes(parts[0]!))
      throw new UpgradeError('更新包只能含 dist/ 与 demo/')
  }
}

function refuseLinks(root: string): number {
  let total = 0
  const walk = (at: string): void => {
    const stat = lstatSync(at)
    if (stat.isSymbolicLink()) throw new UpgradeError('更新包里有符号链接')
    if (stat.isDirectory()) {
      for (const name of readdirSync(at)) walk(path.join(at, name))
      return
    }
    if (!stat.isFile()) throw new UpgradeError('更新包里有特殊文件')
    if (stat.nlink > 1) throw new UpgradeError('更新包里有硬链接')
    total += stat.size
    if (total > MAX_TREE_BYTES) throw new UpgradeError('更新包解开后过大')
  }
  walk(root)
  return total
}

export interface StageOptions {
  readonly source: ReleaseSource
  readonly tree: InstallTree
  readonly release: Release
  readonly run?: RunCommand
}

/** Download, verify and unpack a release next to the live tree. Nothing live changes. */
export async function stageRelease(
  options: StageOptions,
): Promise<StagedUpgrade> {
  const { source, tree, release } = options
  const run = options.run ?? runCommand
  const name = assetName(release.version, tree.platform)
  const asset = release.assets.find(one => one.name === name)
  // The payload workflow attaches `<asset>.sha256`; a hand-made release lists it in SHA256SUMS.
  const sums =
    release.assets.find(one => one.name === `${name}.sha256`) ??
    release.assets.find(one => one.name === 'SHA256SUMS')
  if (asset === undefined)
    throw new UpgradeError(`发行 ${release.version} 没有 ${name}`)
  if (sums === undefined)
    throw new UpgradeError(`发行 ${release.version} 没有校验和`)
  if (asset.size > MAX_ARCHIVE_BYTES) throw new UpgradeError(`${name} 过大`)
  for (const stale of readdirSync(tree.tree))
    if (stale.startsWith('.qianmo-upgrade-'))
      rmSync(path.join(tree.tree, stale), { recursive: true, force: true })
  // Clear before install: the space has to exist before the download starts.
  const needed =
    asset.size +
    treeBytes(path.join(tree.tree, 'dist')) +
    treeBytes(path.join(tree.tree, 'demo'))
  if (freeBytes(tree.tree) < needed * 1.2) removeBackups(tree)
  if (freeBytes(tree.tree) < needed * 1.2)
    throw new UpgradeError(
      `磁盘空间不够：需要约 ${Math.ceil((needed * 1.2) / 1048576)} MB`,
    )

  const dir = mkdtempSync(path.join(tree.tree, '.qianmo-upgrade-'))
  try {
    const sumsFile = path.join(dir, 'checksums')
    await download(source, sums, sumsFile, 64 * 1024)
    const expected = expectedHash(readFileSync(sumsFile, 'utf8'), name)
    if (expected === null) throw new UpgradeError(`校验和里没有 ${name}`)
    const archive = path.join(dir, name)
    await download(source, asset, archive, MAX_ARCHIVE_BYTES)
    if ((await sha256(archive)) !== expected)
      throw new UpgradeError(`${name} 的 SHA-256 与发行记录不符`)

    const env = {
      PATH: process.env['PATH'] ?? '/usr/bin:/bin',
      HOME: dir,
      LC_ALL: 'C',
    }
    const listed = await run(['tar', '-tzf', archive], {
      env,
      timeoutMs: 120_000,
      maxOutput: 8 * 1024 * 1024,
    })
    // A listing cut short has not been checked.
    if (listed.code !== 0 || listed.truncated === true)
      throw new UpgradeError('更新包读不开')
    checkMembers(listed.stdout.split('\n').filter(Boolean))
    const root = path.join(dir, 'root')
    const made = await run(['mkdir', '-m', '700', root], {
      env,
      timeoutMs: 10_000,
    })
    if (made.code !== 0) throw new UpgradeError('暂存目录建不起来')
    const extracted = await run(
      ['tar', '-xzf', archive, '-C', root, '--no-same-owner'],
      {
        env,
        timeoutMs: 300_000,
      },
    )
    if (extracted.code !== 0) throw new UpgradeError('更新包解不开')
    unlinkSync(archive)
    refuseLinks(root)
    const entries = ENTRIES.filter(entry => existsSync(path.join(root, entry)))
    const bin = path.join(root, 'dist', `qm-${tree.platform}`)
    if (!entries.includes('dist') || !existsSync(bin))
      throw new UpgradeError(`更新包里没有 dist/qm-${tree.platform}`)
    const reported = await run([bin, '--version'], { env, timeoutMs: 60_000 })
    const said = /^qm (\S+)/.exec(reported.stdout.trim())?.[1]
    if (reported.code !== 0 || said !== release.version)
      throw new UpgradeError(
        `新程序自报版本是 ${said ?? '未知'}，不是 ${release.version}`,
      )
    return { version: release.version, dir, root, entries }
  } catch (error) {
    rmSync(dir, { recursive: true, force: true })
    throw error
  }
}

// -- the swap -----------------------------------------------------------------

/** Swap the staged entries in; the old ones become `<entry>.bak-upgrade`. */
export function swapIn(
  tree: InstallTree,
  staged: StagedUpgrade,
  from: string | null,
  now = Date.now(),
): void {
  const done: (readonly [string, string])[] = []
  try {
    for (const entry of staged.entries) {
      const live = path.join(tree.tree, entry)
      const backup = live + BACKUP
      rmSync(backup, { recursive: true, force: true })
      if (existsSync(live)) {
        renameSync(live, backup)
        done.push([live, backup])
      }
      renameSync(path.join(staged.root, entry), live)
      done.push([path.join(staged.root, entry), live])
    }
  } catch (error) {
    for (const [was, moved] of done.reverse())
      try {
        renameSync(moved, was)
      } catch {
        // Keep restoring the rest; the error below says the swap failed.
      }
    throw new UpgradeError(
      `替换失败，已恢复原程序：${error instanceof Error ? error.message : String(error)}`,
    )
  }
  writeFileSync(
    recordPath(tree),
    JSON.stringify({
      from,
      to: staged.version,
      at: now,
    } satisfies UpgradeRecord),
  )
  rmSync(staged.dir, { recursive: true, force: true })
}

/** Swap the backup and the live tree; the version now live, when known. */
export function restoreBackup(
  tree: InstallTree,
  now = Date.now(),
): string | null {
  const entries = ENTRIES.filter(entry =>
    existsSync(path.join(tree.tree, entry + BACKUP)),
  )
  if (entries.length === 0) throw new UpgradeError('没有可回滚的备份')
  const record = readRecord(tree)
  const done: (readonly [string, string])[] = []
  try {
    for (const entry of entries) {
      const live = path.join(tree.tree, entry)
      const parked = `${live}.rollback`
      rmSync(parked, { recursive: true, force: true })
      if (existsSync(live)) {
        renameSync(live, parked)
        done.push([live, parked])
      }
      renameSync(live + BACKUP, live)
      done.push([live + BACKUP, live])
      if (existsSync(parked)) {
        renameSync(parked, live + BACKUP)
        done.push([parked, live + BACKUP])
      }
    }
  } catch (error) {
    for (const [was, moved] of done.reverse())
      try {
        renameSync(moved, was)
      } catch {
        // As in swapIn.
      }
    throw new UpgradeError(
      `回滚失败，已恢复：${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (record !== null && record.from !== null)
    writeFileSync(
      recordPath(tree),
      JSON.stringify({
        from: record.to,
        to: record.from,
        at: now,
      } satisfies UpgradeRecord),
    )
  return record?.from ?? null
}

// -- one at a time --------------------------------------------------------------

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Runs `work` holding the tree's upgrade lock; a second caller is refused. */
export async function withUpgradeLock<T>(
  tree: InstallTree,
  work: () => Promise<T>,
  now = Date.now,
): Promise<T> {
  const file = path.join(tree.tree, '.qianmo-upgrade.lock')
  const take = (): boolean => {
    try {
      const fd = openSync(file, 'wx', 0o600)
      writeSync(fd, JSON.stringify({ pid: process.pid, at: now() }))
      closeSync(fd)
      return true
    } catch {
      return false
    }
  }
  if (!take()) {
    let held = true
    try {
      const value = JSON.parse(readFileSync(file, 'utf8')) as {
        pid?: unknown
        at?: unknown
      }
      held =
        typeof value.pid === 'number' &&
        alive(value.pid) &&
        typeof value.at === 'number' &&
        now() - value.at < 60 * 60_000
    } catch {
      held = false
    }
    if (held) throw new UpgradeError('另一个升级或回滚正在进行')
    rmSync(file, { force: true })
    if (!take()) throw new UpgradeError('另一个升级或回滚正在进行')
  }
  try {
    return await work()
  } finally {
    rmSync(file, { force: true })
  }
}

// -- the restart ----------------------------------------------------------------

/**
 * Stop through the process's own SIGTERM path, then run the new binary in
 * this PID. Past `deadlineMs` without the event loop emptying, exit 75 so a
 * supervisor (systemd `Restart=`) starts it instead.
 */
export function restartInPlace(
  options: {
    readonly deadlineMs?: number
    readonly log?: (line: string) => void
  } = {},
): void {
  const argv = [process.execPath, ...process.argv.slice(2)]
  const execve = (
    process as {
      execve?: (file: string, args: string[], env: NodeJS.ProcessEnv) => never
    }
  ).execve
  process.once('beforeExit', () => {
    options.log?.('[upgrade] stopped; starting the new binary in this process')
    if (typeof execve === 'function')
      execve(process.execPath, argv, process.env)
    process.exit(75)
  })
  setTimeout(() => {
    options.log?.(
      '[upgrade] shutdown did not finish in time; exiting 75 for the supervisor',
    )
    process.exit(75)
  }, options.deadlineMs ?? 60_000).unref()
  process.kill(process.pid, 'SIGTERM')
}
