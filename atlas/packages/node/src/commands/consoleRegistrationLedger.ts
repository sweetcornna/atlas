// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 登记簿 `registrations.json` 的读法与出口判定（P15.2），控制台与 `qm watch`
 * 共用一份。
 *
 * ## 只读，不改盘
 *
 * 这里只读文件、解析、判定。挪开坏文件、写回、续租都是控制台进程的事
 * （`consoleRegistrations.ts`）；`qm watch` 每次派发前读一次，它是只读副本的
 * 读者，绝不能替控制台动那份文件。
 *
 * ## 读不出来的五种样子，一个处置
 *
 * 文档不是 JSON、版本不认识、外形不对（`malformed`）；文件在、读不动（权限、
 * IO 错误，`io`）；有条目形状不对或地址重复（`partial`）；文件不在、但同目录还
 * 躺着一份先前被挪开的 `.unreadable-*`（`quarantined`）。对出口与「会放宽什么」
 * 的写动作，这几种是同一件事：**不知道谁被暂停了、谁已退役**。所以一律按读不
 * 出来处理，不「跳过坏行」、不「从空登记簿起」——一条写坏的 `retired` 被跳过，
 * 等于把那个地址重新放出去（`tenancy-m1.md` §3.3 对账号库是同一条理）。
 *
 * `quarantined` 那一种的出口：运维把修好的文件放回原处，或者确认要从空登记簿
 * 起、把 `.unreadable-*` 挪出这个目录（与注册中心吊销清单「确认要丢弃它，把它
 * 移开后再启动」同一个先例）。
 *
 * ## 出口按黑名单判
 *
 * 不在登记簿里的地址照旧放行：今天舰队上的地址全是 `peers.conf` 种子，由注册
 * 中心宿主续租、从没进过控制台的登记簿。只有明确记成 `paused` / `retired` 的，
 * 和登记簿整本读不出来的时候，才拒。
 */

import { readdirSync, readFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import {
  REGISTRATION_STATES,
  type ConsoleFailure,
  type RegisterAgentInput,
  type RegistrationState,
} from '@qianmo/console'

/**
 * 写出去的文档版本。读 1（P15.2 生命周期之前）与 2；别的版本整份当作读不动。
 *
 * 升到 2 是为了旧控制台：它读到带 `state` 的 v1 会把 paused / retired 当成要
 * 续租的条目重新发布。版本不认识时它整份挪开，不续任何一条。
 */
export const REGISTRATION_LEDGER_VERSION = 2

const READABLE_VERSIONS: readonly unknown[] = [1, REGISTRATION_LEDGER_VERSION]

/** 被挪开的坏文件的后缀，`<登记簿>.unreadable-<ISO 时间>`。 */
export const UNREADABLE_SUFFIX = '.unreadable-'

/** 登记簿里的一条：给注册中心的那份声明，加上生命周期。 */
export interface LedgerEntry {
  readonly declaration: RegisterAgentInput
  readonly state: RegistrationState
  /** 最近一次改它的主体；P15.2 之前写的条目、或没有主体的注册没有。 */
  readonly by?: string
  readonly at?: number
}

/** 读一次登记簿的结果。 */
type LedgerRead =
  /** 没有文件，也没有被挪开的旧文件：空登记簿。 */
  | { readonly kind: 'absent' }
  | { readonly kind: 'ok'; readonly entries: readonly LedgerEntry[] }
  /** 读得出的条目照留（续租用），但整本按读不出来处理。 */
  | {
      readonly kind: 'partial'
      readonly entries: readonly LedgerEntry[]
      readonly dropped: number
    }
  /** 文档本身不对：控制台会把它挪开留证。 */
  | { readonly kind: 'malformed'; readonly reason: string }
  /** 读不动（权限、IO）：原地留着，什么都不改。 */
  | { readonly kind: 'io'; readonly reason: string }
  /** 文件不在，同目录有先前挪开的那份。 */
  | { readonly kind: 'quarantined'; readonly aside: string }

/** 这一次读出来能不能用；不能用时是给人看的原因。 */
export function ledgerProblemOf(path: string, read: LedgerRead): string | null {
  switch (read.kind) {
    case 'absent':
    case 'ok':
      return null
    case 'partial':
      return `skipped ${String(read.dropped)} malformed entries in ${path}`
    case 'malformed':
      return `${path} is unreadable (${read.reason})`
    case 'io':
      return `${path} cannot be read (${read.reason})`
    case 'quarantined':
      return (
        `${path} is missing and ${read.aside} is still beside it: an earlier ` +
        'ledger was set aside as unreadable and nothing has replaced it'
      )
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isState(value: unknown): value is RegistrationState {
  return (REGISTRATION_STATES as readonly unknown[]).includes(value)
}

/**
 * 盘上一条 → 一条登记；形状不对返回 null。
 *
 * 声明部分只查类型，不查取值：地址、端点、能力条数的规矩住在注册中心，下一轮
 * 续租时它会如实拒绝，在这里再抄一份就是第二个会漂移的出处（`consolePorts.ts`
 * 同一条）。生命周期部分查取值：`state` 只认三个词，缺席就是 `active`。
 */
function toEntry(value: unknown): LedgerEntry | null {
  if (!isRecord(value)) return null
  const address = value['address']
  const endpoint = value['endpoint']
  const capabilities = value['capabilities']
  const publicKey = value['publicKey']
  const status = value['status']
  const state = value['state']
  const by = value['by']
  const at = value['at']
  if (typeof address !== 'string' || address === '') return null
  if (typeof endpoint !== 'string' || endpoint === '') return null
  if (
    capabilities !== undefined &&
    !(
      Array.isArray(capabilities) &&
      capabilities.every(item => typeof item === 'string')
    )
  ) {
    return null
  }
  if (publicKey !== undefined && typeof publicKey !== 'string') return null
  if (status !== undefined && typeof status !== 'string') return null
  if (state !== undefined && !isState(state)) return null
  if (by !== undefined && (typeof by !== 'string' || by === '')) return null
  if (at !== undefined && (typeof at !== 'number' || !Number.isFinite(at))) {
    return null
  }
  return {
    declaration: {
      address,
      endpoint,
      ...(capabilities === undefined
        ? {}
        : { capabilities: [...(capabilities as string[])] }),
      ...(publicKey === undefined ? {} : { publicKey }),
      ...(status === undefined ? {} : { status }),
    },
    state: state ?? 'active',
    ...(by === undefined ? {} : { by }),
    ...(at === undefined ? {} : { at }),
  }
}

/** 同目录里先前被挪开的那份；目录不在就是没有。 */
function quarantinedBeside(path: string): LedgerRead {
  const prefix = `${basename(path)}${UNREADABLE_SUFFIX}`
  let names: readonly string[]
  try {
    names = readdirSync(dirname(path))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { kind: 'absent' }
    }
    return { kind: 'io', reason: messageOf(error) }
  }
  const aside = names.filter(name => name.startsWith(prefix)).sort()[0]
  return aside === undefined
    ? { kind: 'absent' }
    : { kind: 'quarantined', aside: join(dirname(path), aside) }
}

/** 读一次登记簿。不抛，不改盘。 */
export function readRegistrationLedger(path: string): LedgerRead {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return quarantinedBeside(path)
    }
    return { kind: 'io', reason: messageOf(error) }
  }
  let document: unknown
  try {
    document = JSON.parse(raw) as unknown
  } catch {
    return { kind: 'malformed', reason: 'not valid JSON' }
  }
  if (!isRecord(document)) {
    return { kind: 'malformed', reason: 'not a JSON object' }
  }
  if (!READABLE_VERSIONS.includes(document['version'])) {
    return {
      kind: 'malformed',
      reason: `version ${JSON.stringify(document['version']) ?? 'missing'} is not one this console reads`,
    }
  }
  const list = document['registrations']
  if (!Array.isArray(list)) {
    return { kind: 'malformed', reason: 'no registrations list' }
  }
  const entries: LedgerEntry[] = []
  const seen = new Set<string>()
  let dropped = 0
  for (const item of list as readonly unknown[]) {
    const entry = toEntry(item)
    // 同一地址两条：哪条算数是猜，猜错了就可能把一条 retired 换成 active。
    if (entry === null || seen.has(entry.declaration.address)) {
      dropped += 1
      continue
    }
    seen.add(entry.declaration.address)
    entries.push(entry)
  }
  return dropped > 0
    ? { kind: 'partial', entries, dropped }
    : { kind: 'ok', entries }
}

/**
 * 写出去的文档。`active` 不写 `state`（缺省即 active，旧文件同一个形状）；
 * 主体与时刻有才写。
 */
export function ledgerDocument(entries: Iterable<LedgerEntry>): unknown {
  const registrations: Record<string, unknown>[] = []
  for (const entry of entries) {
    const { declaration } = entry
    registrations.push({
      address: declaration.address,
      endpoint: declaration.endpoint,
      ...(declaration.capabilities === undefined
        ? {}
        : { capabilities: [...declaration.capabilities] }),
      ...(declaration.publicKey === undefined
        ? {}
        : { publicKey: declaration.publicKey }),
      ...(declaration.status === undefined
        ? {}
        : { status: declaration.status }),
      ...(entry.state === 'active' ? {} : { state: entry.state }),
      ...(entry.by === undefined ? {} : { by: entry.by }),
      ...(entry.at === undefined ? {} : { at: entry.at }),
    })
  }
  return { version: REGISTRATION_LEDGER_VERSION, registrations }
}

/** 出口为什么不能拨这个地址。 */
export interface ExitRefusal {
  readonly reason: 'paused' | 'retired' | 'unreadable'
  readonly message: string
}

/**
 * 出口判定，三个出口共用这一句话：登记簿读不出来就谁都不拨；明确记成
 * `paused` / `retired` 的不拨；其余放行。
 *
 * 文案不带操作主体：对话面的成员也会看到它，「谁停的」属于操作记录面。
 */
export function exitRefusalOf(
  problem: string | null,
  entry: LedgerEntry | undefined,
  address: string,
): ExitRefusal | null {
  if (problem !== null) {
    return {
      reason: 'unreadable',
      message:
        `登记簿读不出来（${problem}）· ` +
        '修好之前不向任何智能体发起对话、唤醒与值守作业',
    }
  }
  if (entry?.state === 'paused') {
    return {
      reason: 'paused',
      message: `${address} 已暂停 · 恢复之前不发起对话、唤醒与值守作业`,
    }
  }
  if (entry?.state === 'retired') {
    return {
      reason: 'retired',
      message: `${address} 已退役 · 不再向它发起对话、唤醒与值守作业`,
    }
  }
  return null
}

/** 把出口判定换成端口的失败形状：`rejected`，这一侧的规矩不让它出去。 */
export function exitFailureOf(refusal: ExitRefusal): ConsoleFailure {
  return { code: 'rejected', message: refusal.message }
}

/**
 * `qm watch` 的那一问：现在读一次登记簿的只读副本，这个地址能不能拨。
 */
export function readExitRefusal(
  path: string,
  address: string,
): ExitRefusal | null {
  const read = readRegistrationLedger(path)
  const problem = ledgerProblemOf(path, read)
  const entries = read.kind === 'ok' ? read.entries : []
  return exitRefusalOf(
    problem,
    entries.find(entry => entry.declaration.address === address),
    address,
  )
}
