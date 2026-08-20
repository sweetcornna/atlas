// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: MIT

/**
 * Host-only retention implementation for demo/env/beta/beta-retain.sh.
 *
 * Bash owns the beta environment guard. Bun owns UTC calendar arithmetic and
 * lstat/realpath checks so the result is the same on macOS and Linux without
 * relying on GNU date, GNU stat, or find's platform-specific flags.
 */

import { gzipSync } from 'node:zlib'
import {
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
  type Stats,
} from 'node:fs'
import {
  basename,
  dirname,
  isAbsolute,
  join,
  normalize,
  relative,
  resolve,
} from 'node:path'

const HOUR_MS = 60 * 60 * 1_000
const DAY_MS = 24 * HOUR_MS
const BACKUP_FULL_RETENTION_MS = 72 * HOUR_MS
const LOG_RETENTION_MS = 14 * DAY_MS
const LEDGER_WARNING_BYTES = 10 * 1024 * 1024
const SNAPSHOT_ID = /^\d{14}-\d{4}$/
const REGISTRY_SNAPSHOT =
  /^registry-(\d{8}T\d{6}Z)(?:-([A-Za-z0-9._-]+))?\.json$/

type Mode = 'dry-run' | 'apply'

interface Paths {
  readonly root: string
  readonly rootReal: string
  readonly run: string
  readonly logs: string
  readonly backups: string
  readonly registryState: string
  readonly registrySnapshots: string
  readonly nodes: string
}

interface Operation {
  execute(): void
}

interface Plan {
  readonly name: string
  readonly operations: readonly Operation[]
  readonly remaining: number
  readonly warnings: readonly string[]
}

interface ParsedArgs {
  readonly mode: Mode
  readonly snapshotRegistry: boolean
}

interface Backup {
  readonly id: string
  readonly createdAt: number
  readonly archive: string
  readonly meta: string
}

interface RegistrySnapshot {
  readonly path: string
  readonly name: string
  readonly stamp: string
}

function die(message: string): never {
  throw new Error(message)
}

function requiredEnv(name: string): string {
  const value = process.env[name]
  if (value === undefined || value.length === 0) die(`缺少配置：${name}`)
  return value
}

function parseArgs(args: readonly string[]): ParsedArgs {
  let mode: Mode = 'dry-run'
  let setMode = false
  let snapshotRegistry = false
  for (const arg of args) {
    switch (arg) {
      case '--dry-run':
        if (setMode) die('参数模式重复或冲突：--dry-run')
        mode = 'dry-run'
        setMode = true
        break
      case '--apply':
        if (setMode) die('参数模式重复或冲突：--apply')
        mode = 'apply'
        setMode = true
        break
      case '--snapshot-registry':
        if (snapshotRegistry) die('参数重复：--snapshot-registry')
        snapshotRegistry = true
        break
      default:
        die(`未知参数：${JSON.stringify(arg)}`)
    }
  }
  return { mode, snapshotRegistry }
}

function hasParentTraversal(value: string): boolean {
  return value.split('/').includes('..')
}

function assertSafeRoot(root: string): string {
  if (!isAbsolute(root)) die(`内测根必须是绝对路径：${JSON.stringify(root)}`)
  if (root === '/' || hasParentTraversal(root) || normalize(root) !== root) {
    die(`内测根不是规范化安全路径：${JSON.stringify(root)}`)
  }
  let stat
  try {
    stat = lstatSync(root)
  } catch {
    die(`内测根不存在：${JSON.stringify(root)}`)
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    die(`内测根不是普通目录：${JSON.stringify(root)}`)
  }
  return realpathSync(root)
}

function assertMarker(root: string, rootReal: string): void {
  const marker = join(root, '.qianmo-beta-env')
  assertExistingRegularFile({ root, rootReal }, marker, '标记文件')
  const firstLine = readFileSync(marker, 'utf8').split('\n', 1)[0]
  if (firstLine !== 'qianmo-beta-env/v1') {
    die('内测根标记文件身份不正确')
  }
}

function assertDerivedPath(
  paths: Pick<Paths, 'root' | 'rootReal'>,
  target: string,
  label: string,
): void {
  if (
    !isAbsolute(target) ||
    hasParentTraversal(target) ||
    normalize(target) !== target
  ) {
    die(`${label} 不是规范化绝对路径：${JSON.stringify(target)}`)
  }
  const relation = relative(paths.root, target)
  if (
    relation.length === 0 ||
    relation === '..' ||
    relation.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) ||
    isAbsolute(relation)
  ) {
    die(`${label} 越出内测根：${JSON.stringify(target)}`)
  }
}

function assertExistingPath(
  paths: Pick<Paths, 'root' | 'rootReal'>,
  target: string,
  label: string,
): Stats {
  assertDerivedPath(paths, target, label)
  const relation = relative(paths.root, target)
  let cursor = paths.root
  const rootStat = lstatSync(cursor)
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    die(`内测根在运行中变成了不安全路径：${JSON.stringify(paths.root)}`)
  }
  for (const part of relation.split('/')) {
    cursor = join(cursor, part)
    let stat: Stats
    try {
      stat = lstatSync(cursor)
    } catch {
      die(`${label} 缺失：${JSON.stringify(cursor)}`)
    }
    if (stat.isSymbolicLink())
      die(`${label} 或父路径是符号链接：${JSON.stringify(cursor)}`)
  }
  const resolved = realpathSync(target)
  const realRelation = relative(paths.rootReal, resolved)
  if (
    realRelation === '..' ||
    realRelation.startsWith('../') ||
    isAbsolute(realRelation)
  ) {
    die(`${label} 真实路径越出内测根：${JSON.stringify(target)}`)
  }
  return lstatSync(target)
}

function assertExistingDirectory(
  paths: Pick<Paths, 'root' | 'rootReal'>,
  target: string,
  label: string,
): void {
  const stat = assertExistingPath(paths, target, label)
  if (!stat.isDirectory()) die(`${label} 不是目录：${JSON.stringify(target)}`)
}

function assertExistingRegularFile(
  paths: Pick<Paths, 'root' | 'rootReal'>,
  target: string,
  label: string,
): Stats {
  const stat = assertExistingPath(paths, target, label)
  if (!stat.isFile()) die(`${label} 不是普通文件：${JSON.stringify(target)}`)
  return stat
}

function ensureSafeDirectory(
  paths: Pick<Paths, 'root' | 'rootReal'>,
  target: string,
): void {
  assertDerivedPath(paths, target, '待创建目录')
  const relation = relative(paths.root, target)
  let cursor = paths.root
  for (const part of relation.split('/')) {
    cursor = join(cursor, part)
    if (!existsSync(cursor)) {
      mkdirSync(cursor, { mode: 0o700 })
    }
    const stat = assertExistingPath(paths, cursor, '待创建目录')
    if (!stat.isDirectory())
      die(`待创建目录的父路径不是目录：${JSON.stringify(cursor)}`)
  }
}

function readDirectory(
  paths: Pick<Paths, 'root' | 'rootReal'>,
  directory: string,
  label: string,
): readonly string[] {
  if (!existsSync(directory)) return []
  assertExistingDirectory(paths, directory, label)
  return readdirSync(directory).sort()
}

function nowMs(): number {
  const configured = process.env.QIANMO_BETA_RETAIN_NOW_EPOCH_MS
  if (configured === undefined) return Date.now()
  if (!/^\d+$/.test(configured))
    die('QIANMO_BETA_RETAIN_NOW_EPOCH_MS 必须是毫秒整数')
  const value = Number(configured)
  if (!Number.isSafeInteger(value) || value <= 0) {
    die('QIANMO_BETA_RETAIN_NOW_EPOCH_MS 超出有效范围')
  }
  return value
}

function utcDay(value: number): string {
  const date = new Date(value)
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`
}

function utcDayWindowStart(now: number): number {
  const date = new Date(now)
  return (
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) -
    13 * DAY_MS
  )
}

function utcStamp(value: number): string {
  const date = new Date(value)
  return `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, '0')}${String(date.getUTCDate()).padStart(2, '0')}T${String(date.getUTCHours()).padStart(2, '0')}${String(date.getUTCMinutes()).padStart(2, '0')}${String(date.getUTCSeconds()).padStart(2, '0')}Z`
}

function isoWeek(value: number): string {
  const date = new Date(value)
  const day = date.getUTCDay() || 7
  const thursday = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  )
  thursday.setUTCDate(thursday.getUTCDate() + 4 - day)
  const year = thursday.getUTCFullYear()
  const yearStart = Date.UTC(year, 0, 1)
  const week = Math.ceil(((thursday.getTime() - yearStart) / DAY_MS + 1) / 7)
  return `${year}-W${String(week).padStart(2, '0')}`
}

function isSunday(value: number): boolean {
  return new Date(value).getUTCDay() === 0
}

function bytesEqual(left: string, right: string): boolean {
  const a = readFileSync(left)
  const b = readFileSync(right)
  return a.byteLength === b.byteLength && a.equals(b)
}

function atomicCopy(paths: Paths, source: string, destination: string): void {
  assertExistingRegularFile(paths, source, '审计链源文件')
  if (existsSync(destination)) {
    assertExistingRegularFile(paths, destination, '审计链封存目标')
    if (!bytesEqual(source, destination)) {
      die(`审计链封存目标已存在且内容不同：${JSON.stringify(destination)}`)
    }
    return
  }
  ensureSafeDirectory(paths, dirname(destination))
  assertDerivedPath(paths, destination, '审计链封存目标')
  const temporary = `${destination}.tmp-${process.pid}`
  assertDerivedPath(paths, temporary, '审计链封存临时文件')
  if (existsSync(temporary))
    die(`审计链封存临时文件已存在：${JSON.stringify(temporary)}`)
  try {
    copyFileSync(source, temporary, constants.COPYFILE_EXCL)
    const descriptor = openSync(temporary, 'r')
    try {
      fsyncSync(descriptor)
    } finally {
      closeSync(descriptor)
    }
    // link(2) creates the final name atomically and fails on EEXIST. rename(2)
    // would overwrite a concurrently-created archive, which is not acceptable
    // for an audit seal or an upgrade snapshot.
    linkSync(temporary, destination)
    unlinkSync(temporary)
  } catch (error) {
    if (existsSync(temporary)) {
      assertExistingRegularFile(paths, temporary, '审计链封存临时文件')
      unlinkSync(temporary)
    }
    throw error
  }
}

function removeRegularFile(paths: Paths, target: string, label: string): void {
  assertExistingRegularFile(paths, target, label)
  unlinkSync(target)
}

function planBackups(paths: Paths, now: number): Plan {
  const entries = readDirectory(paths, paths.backups, '备份 store')
  const backups: Backup[] = []
  for (const name of entries) {
    if (!name.endsWith('.json')) continue
    const id = name.slice(0, -'.json'.length)
    if (!SNAPSHOT_ID.test(id)) continue
    const meta = join(paths.backups, name)
    const archive = join(paths.backups, `${id}.tar.gz`)
    assertExistingRegularFile(paths, meta, '备份元数据')
    assertExistingRegularFile(paths, archive, '备份归档')
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(meta, 'utf8'))
    } catch {
      die(`备份：元数据不是有效 JSON（${JSON.stringify(meta)}）`)
    }
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !('id' in parsed) ||
      !('createdAt' in parsed) ||
      parsed.id !== id ||
      typeof parsed.createdAt !== 'number' ||
      !Number.isSafeInteger(parsed.createdAt) ||
      parsed.createdAt <= 0
    ) {
      die(`备份：元数据身份或时间戳无效（${JSON.stringify(meta)}）`)
    }
    backups.push({ id, createdAt: parsed.createdAt, archive, meta })
  }

  const fullCutoff = now - BACKUP_FULL_RETENTION_MS
  const dailyWindow = utcDayWindowStart(now)
  const representatives = new Set<string>()
  const days = new Map<string, Backup[]>()
  for (const backup of backups) {
    if (backup.createdAt >= fullCutoff || backup.createdAt < dailyWindow)
      continue
    const day = utcDay(backup.createdAt)
    const sameDay = days.get(day) ?? []
    sameDay.push(backup)
    days.set(day, sameDay)
  }
  for (const sameDay of days.values()) {
    sameDay.sort(
      (a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id),
    )
    representatives.add(sameDay[0].id)
  }
  const remove = backups.filter(backup => {
    if (backup.createdAt >= fullCutoff) return false
    if (backup.createdAt >= dailyWindow) return !representatives.has(backup.id)
    return true
  })
  return {
    name: '备份',
    operations: remove.map(backup => ({
      execute: () => {
        // Revalidate both halves immediately before unlinking either one.
        assertExistingRegularFile(paths, backup.archive, '备份归档')
        assertExistingRegularFile(paths, backup.meta, '备份元数据')
        removeRegularFile(paths, backup.archive, '备份归档')
        removeRegularFile(paths, backup.meta, '备份元数据')
      },
    })),
    remaining: backups.length - remove.length,
    warnings: [],
  }
}

function activeLogNames(paths: Paths): ReadonlySet<string> {
  const active = new Set<string>()
  for (const name of readDirectory(paths, paths.run, '运行态目录')) {
    if (!name.endsWith('.pid')) continue
    const pidFile = join(paths.run, name)
    assertExistingRegularFile(paths, pidFile, 'pid 文件')
    const pid = Number(readFileSync(pidFile, 'utf8').trim())
    if (!Number.isSafeInteger(pid) || pid <= 0) continue
    try {
      process.kill(pid, 0)
    } catch {
      continue
    }
    const processName = name.slice(0, -'.pid'.length)
    active.add(`${processName}.out`)
    active.add(`${processName}.err`)
  }
  return active
}

function gzipLog(paths: Paths, source: string, destination: string): void {
  const stat = assertExistingRegularFile(paths, source, '日志源文件')
  if (existsSync(destination)) {
    die(`日志 gzip 目标已存在，拒绝覆盖：${JSON.stringify(destination)}`)
  }
  const temporary = `${destination}.tmp-${process.pid}`
  if (existsSync(temporary))
    die(`日志 gzip 临时文件已存在：${JSON.stringify(temporary)}`)
  try {
    writeFileSync(temporary, gzipSync(readFileSync(source)), {
      flag: 'wx',
      mode: stat.mode & 0o777,
    })
    utimesSync(temporary, stat.atime, stat.mtime)
    const descriptor = openSync(temporary, 'r')
    try {
      fsyncSync(descriptor)
    } finally {
      closeSync(descriptor)
    }
    linkSync(temporary, destination)
    unlinkSync(temporary)
    removeRegularFile(paths, source, '日志源文件')
  } catch (error) {
    if (existsSync(temporary)) {
      assertExistingRegularFile(paths, temporary, '日志 gzip 临时文件')
      unlinkSync(temporary)
    }
    throw error
  }
}

function planLogs(paths: Paths, now: number): Plan {
  const active = activeLogNames(paths)
  const operations: Operation[] = []
  let remaining = 0
  for (const name of readDirectory(paths, paths.logs, '日志目录')) {
    const path = join(paths.logs, name)
    const stat = assertExistingRegularFile(paths, path, '日志文件')
    const age = now - stat.mtimeMs
    if (name.endsWith('.gz')) {
      if (age >= LOG_RETENTION_MS) {
        operations.push({
          execute: () => removeRegularFile(paths, path, '过期 gzip 日志'),
        })
      } else {
        remaining += 1
      }
      continue
    }
    if (!name.endsWith('.out') && !name.endsWith('.err')) {
      remaining += 1
      continue
    }
    if (active.has(name)) {
      remaining += 1
      continue
    }
    if (age >= LOG_RETENTION_MS) {
      operations.push({
        execute: () => removeRegularFile(paths, path, '过期日志'),
      })
      continue
    }
    const destination = `${path}.${utcDay(stat.mtimeMs)}.gz`
    assertDerivedPath(paths, destination, '日志 gzip 目标')
    if (existsSync(destination)) {
      die(`日志 gzip 目标已存在，拒绝覆盖：${JSON.stringify(destination)}`)
    }
    operations.push({ execute: () => gzipLog(paths, path, destination) })
    remaining += 1
  }
  return { name: '日志', operations, remaining, warnings: [] }
}

function nodeDirectories(paths: Paths): readonly string[] {
  return readDirectory(paths, paths.nodes, '节点目录')
    .map(name => join(paths.nodes, name))
    .filter(path => {
      const stat = assertExistingPath(paths, path, '节点目录项')
      if (!stat.isDirectory())
        die(`节点目录项不是目录：${JSON.stringify(path)}`)
      return true
    })
}

function planAudits(paths: Paths, now: number): Plan {
  if (!isSunday(now))
    return { name: '审计链', operations: [], remaining: 0, warnings: [] }
  const week = isoWeek(now)
  const operations: Operation[] = []
  let remaining = 0
  for (const node of nodeDirectories(paths)) {
    const source = join(node, 'config/qianmo/audit/trail.ndjson')
    if (!existsSync(source)) continue
    assertExistingRegularFile(paths, source, '审计链源文件')
    const destination = join(dirname(source), 'archive', `trail-${week}.ndjson`)
    if (existsSync(destination)) {
      assertExistingRegularFile(paths, destination, '审计链封存目标')
      if (!bytesEqual(source, destination)) {
        die(
          `审计链：封存目标已存在且内容不同（${JSON.stringify(destination)}）`,
        )
      }
      remaining += 1
      continue
    }
    operations.push({ execute: () => atomicCopy(paths, source, destination) })
    remaining += 1
  }
  return { name: '审计链', operations, remaining, warnings: [] }
}

function snapshots(paths: Paths): RegistrySnapshot[] {
  const result: RegistrySnapshot[] = []
  for (const name of readDirectory(
    paths,
    paths.registrySnapshots,
    '注册表快照目录',
  )) {
    const match = REGISTRY_SNAPSHOT.exec(name)
    if (match === null) continue
    const path = join(paths.registrySnapshots, name)
    assertExistingRegularFile(paths, path, '注册表快照')
    result.push({ name, path, stamp: match[1] })
  }
  return result
}

function planRegistry(
  paths: Paths,
  now: number,
  snapshotRegistry: boolean,
): Plan {
  const current = snapshots(paths)
  const operations: Operation[] = []
  if (snapshotRegistry) {
    assertExistingRegularFile(paths, paths.registryState, '注册表当前落盘')
    const name = `registry-${utcStamp(now)}.json`
    const destination = join(paths.registrySnapshots, name)
    if (existsSync(destination)) {
      assertExistingRegularFile(paths, destination, '注册表快照')
      if (!bytesEqual(paths.registryState, destination)) {
        die(
          `注册表：同一时间戳快照已存在且内容不同（${JSON.stringify(destination)}）`,
        )
      }
    } else {
      current.push({ name, path: destination, stamp: utcStamp(now) })
      operations.push({
        execute: () => {
          ensureSafeDirectory(paths, paths.registrySnapshots)
          atomicCopy(paths, paths.registryState, destination)
        },
      })
    }
  }
  current.sort(
    (a, b) => a.stamp.localeCompare(b.stamp) || a.name.localeCompare(b.name),
  )
  const remove = current.slice(0, Math.max(0, current.length - 4))
  operations.push(
    ...remove.map(snapshot => ({
      execute: () => removeRegularFile(paths, snapshot.path, '旧注册表快照'),
    })),
  )
  return {
    name: '注册表快照',
    operations,
    remaining: Math.min(4, current.length),
    warnings: [],
  }
}

function planLedgers(paths: Paths): Plan {
  const warnings: string[] = []
  let remaining = 0
  for (const node of nodeDirectories(paths)) {
    const resident = join(node, 'config/resident')
    if (!existsSync(resident)) continue
    for (const agent of readDirectory(paths, resident, '准入台账目录')) {
      const ledger = join(resident, agent, 'admission.ndjson')
      if (!existsSync(ledger)) continue
      const stat = assertExistingRegularFile(paths, ledger, '准入台账')
      remaining += 1
      if (stat.size > LEDGER_WARNING_BYTES) {
        warnings.push(
          `准入台账超过 10 MiB：${JSON.stringify(ledger)}；只告警，绝不裁剪或压缩`,
        )
      }
    }
  }
  return { name: '准入台账', operations: [], remaining, warnings }
}

function pathsFromEnvironment(): Paths {
  const root = requiredEnv('BETA_RETAIN_ROOT')
  const rootReal = assertSafeRoot(root)
  const paths: Paths = {
    root,
    rootReal,
    run: requiredEnv('BETA_RETAIN_RUN_DIR'),
    logs: requiredEnv('BETA_RETAIN_LOG_DIR'),
    backups: requiredEnv('BETA_RETAIN_BACKUP_STORE'),
    registryState: requiredEnv('BETA_RETAIN_REGISTRY_STATE'),
    registrySnapshots: requiredEnv('BETA_RETAIN_REGISTRY_SNAPSHOT_DIR'),
    nodes: requiredEnv('BETA_RETAIN_NODES_DIR'),
  }
  const expected = {
    run: join(root, 'run'),
    logs: join(root, 'logs'),
    backups: join(root, 'backups'),
    registryState: join(root, 'state/registry-agents.json'),
    registrySnapshots: join(root, 'state/snapshots'),
    nodes: join(root, 'nodes'),
  }
  for (const [key, value] of Object.entries(expected)) {
    if (paths[key as keyof typeof expected] !== value) {
      die(`拒绝非 common.sh 派生的 ${key} 路径`)
    }
  }
  assertMarker(root, rootReal)
  return paths
}

function printPlan(plan: Plan, applied: number, elapsedMs: number): void {
  for (const warning of plan.warnings) console.log(`WARN : ${warning}`)
  console.log(
    `${plan.name}: 候选=${plan.operations.length} 实际=${applied} 剩余=${plan.remaining} 耗时=${elapsedMs}ms`,
  )
}

function main(): void {
  const args = parseArgs(process.argv.slice(2))
  const paths = pathsFromEnvironment()
  const now = nowMs()
  const builders: readonly (() => Plan)[] = [
    () => planBackups(paths, now),
    () => planLogs(paths, now),
    () => planAudits(paths, now),
    () => planRegistry(paths, now, args.snapshotRegistry),
    () => planLedgers(paths),
  ]
  const plans: { readonly plan: Plan; readonly started: number }[] = []
  for (const build of builders) {
    const started = Date.now()
    plans.push({ plan: build(), started })
  }
  console.log(
    `模式: ${args.mode}${args.snapshotRegistry ? '；升级前注册表快照' : ''}`,
  )
  for (const item of plans) {
    let applied = 0
    if (args.mode === 'apply') {
      for (const operation of item.plan.operations) {
        operation.execute()
        applied += 1
      }
    }
    printPlan(item.plan, applied, Date.now() - item.started)
  }
}

try {
  main()
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`FAIL : ${message}`)
  process.exitCode = 1
}
