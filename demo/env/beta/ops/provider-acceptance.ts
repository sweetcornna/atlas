// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 模型服务的每轮真机验收（AC-P6，`providers-console-m1.md` §8.4，P18.13），运维本机这一半。
 *
 *   bun provider-acceptance.ts round   --config <轮配置.json> --out <证据目录> [--label <名>]
 *   bun provider-acceptance.ts compare <轮 A 目录> <轮 B 目录> [--min-gap-minutes N]
 *
 * 平常经 `provider-acceptance.sh` 起（它先查 bun、HOLD 与输出目录）。
 *
 * ## 一轮做什么（顺序即执行顺序）
 *
 * | id | 判据 |
 * | --- | --- |
 * | P0 | 配置合法、凭据文件 0600、`/v0/health` 200、凭据是运维个人账号（`POST /v0/providers/preview` 不是 401 / 403） |
 * | D0 | 每台机器的 facts 取得到；控制台与每个节点进程活着；所有 `sourceCommit` 相同、是 40 位 hex、等于期望（给了的话） |
 * | W1 | 节点横幅 `trusts`、`localCommandsFrom` 含 chatAs；控制台 chat 行 `enabled as qianmo://<chatAs>/<agent> (signed) -> …`、accounts / providers enabled、执行器覆盖每个节点且种类对 |
 * | A1 | 每个节点 refresh：status ok、无漂移、托管、applied = 期望、无 pending、三个哈希一致、resident 在跑、没有 dead 的 key |
 * | A2 | 每个节点真 key `probe auth`：`ok && reachable`（三态写进细节） |
 * | A4 | `call` 节点 `probe call`：`ok && reachable` |
 * | A6 | 在途时下发：等对方受理一轮 → 下发同一份档案 → 看到 `pending.waitingTurns ≥ 1` → 回复 done → 切换完成、generation 前进 |
 * | A3 | 真实切换并切回：改指派 → 下发 → 等到 applied 与 effective 都是新档案 → 原指派 → 同样核 |
 * | A5 | AC-P2 金丝雀：存档（两把 key）→ 页面 / JSON → 测连 → dry-run 下发 →（可选真下发）→ 导出 → 轮换 → 删除；
 * |    | 运维本机看到的每个响应、各机器的文件与每 100 ms 的 `ps` 采样**零命中**；正向对照成立；本机真 key 只在持有点里 |
 * | A1b | 结束时同 A1 |
 * | D1 | 部署身份与进程（pid、启动时刻）同 D0 |
 *
 * 扫描器在 A6 之前起、A5 之后停，所以 ps 采样覆盖 A6、A3、A5 的每一次下发与切换。
 *
 * ## 证据
 *
 * `<out>/round-<label>/`：`verdict.json`、`verdict.md`、`deployment.json`、`raw/*.json`、`retries.ndjson`。
 * **不存原始响应体**，只存投影（id、状态、哈希、计数、时刻）；自由文本先过 {@link Redactor.free}。
 * 对话只记轮次的 id / 状态 / 时刻，不记正文。退出码：0 零红；1 有红；2 配置错（没有判定）；42 HOLD。
 *
 * ## 重试（只针对过程，不针对结果）
 *
 * fetch 抛错（连不上、重置、超时）、200 但响应体为空或不是 JSON、ssh 退出码 255、远端退出 0 却没有输出：
 * 按 `timing.retryDelaysMs`（缺省 1 s、3 s）再试，每次记一行 `retries.ndjson`。其余一律当结果判。
 */

import type {
  ChatSession,
  ChatTranscript,
  ChatTurn,
  ProviderApplyResult,
  ProviderAssignment,
  ProviderNodeView,
  ProviderProbeResult,
  ProviderProfileView,
} from '@qianmo/console'
import { createHash, randomBytes } from 'node:crypto'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type { MachineFacts, ScanResult } from './provider-acceptance-node'

const REPOSITORY_ROOT = resolve(import.meta.dir, '..', '..', '..', '..')
const NODE_SCRIPT = 'demo/env/beta/ops/provider-acceptance-node.ts'

export const EXIT = { green: 0, red: 1, config: 2, held: 42 } as const

// ── 配置 ──────────────────────────────────────────────────────────────────────

export interface Timing {
  readonly pollMs: number
  readonly ackTimeoutMs: number
  readonly inflightTimeoutMs: number
  readonly switchTimeoutMs: number
  readonly httpTimeoutMs: number
  readonly sshTimeoutMs: number
  readonly scanReadyTimeoutMs: number
  readonly retryDelaysMs: readonly number[]
  readonly psIntervalMs: number
  readonly replyGraceMs: number
}

const DEFAULT_TIMING: Timing = {
  pollMs: 1_000,
  ackTimeoutMs: 120_000,
  inflightTimeoutMs: 900_000,
  switchTimeoutMs: 300_000,
  httpTimeoutMs: 120_000,
  sshTimeoutMs: 300_000,
  scanReadyTimeoutMs: 60_000,
  retryDelaysMs: [1_000, 3_000],
  psIntervalMs: 100,
  replyGraceMs: 5_000,
}

/** 在途那一轮的缺省话：要跑一阵子（几十秒），下发才有机会落在它进行中。 */
const DEFAULT_INFLIGHT_PROMPT =
  '请写一篇约 800 字的短文，题目是「一条乡间小路的四季」，分四段，每段写一个季节。直接给正文。'

export interface MachineConfig {
  readonly ssh: string
  readonly tree: string
  readonly root?: string
}

export interface RoundConfig {
  readonly v: 1
  readonly console: {
    readonly url: string
    readonly credentialFile: string
    readonly chatAs: string
  }
  readonly machines: Readonly<Record<string, MachineConfig>>
  readonly hub: string
  readonly nodes: Readonly<
    Record<string, { readonly machine: string; readonly profileId: string }>
  >
  readonly expect: { readonly sourceCommit?: string }
  readonly switch: { readonly node: string; readonly profileId: string }
  readonly call: { readonly node: string }
  readonly inflight: {
    readonly target: string
    readonly prompt?: string
    readonly attempts?: number
  }
  readonly canary: {
    readonly node: string
    readonly baseUrl: string
    readonly realApply?: boolean
  }
  readonly timing: Timing
}

export class ConfigError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/
const PROFILE_ID = /^[a-z0-9-]{1,48}$/
const SAFE_PATH = /^\/[A-Za-z0-9._/-]*$/

function need(cond: boolean, message: string): asserts cond {
  if (!cond) throw new ConfigError(message)
}

function str(raw: Record<string, unknown>, key: string, where: string): string {
  const value = raw[key]
  need(
    typeof value === 'string' && value !== '',
    `${where}.${key} 必须是非空字符串`,
  )
  return value
}

function safePath(value: string, where: string): string {
  need(
    SAFE_PATH.test(value) && !`${value}/`.includes('/../'),
    `${where} 必须是绝对路径，只含 A-Z a-z 0-9 . _ / -：${value}`,
  )
  return value
}

function httpUrl(value: string, where: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new ConfigError(`${where} 不是 URL：${value}`)
  }
  need(
    url.protocol === 'http:' || url.protocol === 'https:',
    `${where} 必须是 http(s)`,
  )
  return value.replace(/\/+$/, '')
}

/** 读并校验轮配置。错了抛 {@link ConfigError}（退出码 2）。 */
export function parseConfig(raw: unknown): RoundConfig {
  need(isRecord(raw), '配置必须是 JSON 对象')
  need(raw.v === 1, '配置 v 必须是 1')
  need(isRecord(raw.console), '缺 console')
  const consoleRaw = raw.console
  const consoleCfg = {
    url: httpUrl(str(consoleRaw, 'url', 'console'), 'console.url'),
    credentialFile: str(consoleRaw, 'credentialFile', 'console'),
    chatAs: str(consoleRaw, 'chatAs', 'console'),
  }
  need(
    isAbsolute(consoleCfg.credentialFile),
    'console.credentialFile 必须是绝对路径',
  )
  need(NAME.test(consoleCfg.chatAs), 'console.chatAs 不是合法的签名名')

  need(
    isRecord(raw.machines) && Object.keys(raw.machines).length > 0,
    '缺 machines',
  )
  const machines: Record<string, MachineConfig> = {}
  for (const [name, value] of Object.entries(raw.machines)) {
    need(NAME.test(name), `machines 的名字不合法：${name}`)
    need(isRecord(value), `machines.${name} 必须是对象`)
    const ssh = str(value, 'ssh', `machines.${name}`)
    need(
      !/\s/.test(ssh) && !ssh.startsWith('-'),
      `machines.${name}.ssh 不像 ssh 目标`,
    )
    const tree = safePath(
      str(value, 'tree', `machines.${name}`),
      `machines.${name}.tree`,
    )
    const root =
      value.root === undefined
        ? undefined
        : safePath(
            str(value, 'root', `machines.${name}`),
            `machines.${name}.root`,
          )
    machines[name] = root === undefined ? { ssh, tree } : { ssh, tree, root }
  }
  const hub = typeof raw.hub === 'string' ? raw.hub : ''
  need(hub in machines, 'hub 必须是 machines 里的一台')

  need(isRecord(raw.nodes) && Object.keys(raw.nodes).length > 0, '缺 nodes')
  const nodes: Record<string, { machine: string; profileId: string }> = {}
  for (const [name, value] of Object.entries(raw.nodes)) {
    need(NAME.test(name), `nodes 的名字不合法：${name}`)
    need(isRecord(value), `nodes.${name} 必须是对象`)
    const machine = str(value, 'machine', `nodes.${name}`)
    need(machine in machines, `nodes.${name}.machine 不在 machines 里`)
    const profileId = str(value, 'profileId', `nodes.${name}`)
    need(PROFILE_ID.test(profileId), `nodes.${name}.profileId 不合法`)
    nodes[name] = { machine, profileId }
  }

  const expectRaw = isRecord(raw.expect) ? raw.expect : {}
  const sourceCommit =
    typeof expectRaw.sourceCommit === 'string'
      ? expectRaw.sourceCommit
      : undefined
  need(
    sourceCommit === undefined || /^[0-9a-f]{40}$/.test(sourceCommit),
    'expect.sourceCommit 必须是 40 位小写 hex',
  )

  need(isRecord(raw.switch), '缺 switch')
  const switchCfg = {
    node: str(raw.switch, 'node', 'switch'),
    profileId: str(raw.switch, 'profileId', 'switch'),
  }
  need(switchCfg.node in nodes, 'switch.node 不在 nodes 里')
  need(PROFILE_ID.test(switchCfg.profileId), 'switch.profileId 不合法')
  need(
    switchCfg.profileId !== nodes[switchCfg.node]?.profileId,
    'switch.profileId 要与该节点期望的档案不同（不然不是切换）',
  )

  need(isRecord(raw.call), '缺 call')
  const call = { node: str(raw.call, 'node', 'call') }
  need(call.node in nodes, 'call.node 不在 nodes 里')

  need(isRecord(raw.inflight), '缺 inflight')
  const target = str(raw.inflight, 'target', 'inflight')
  const targetNode = /^qianmo:\/\/([^/]+)\/[^/]+$/.exec(target)?.[1]
  need(
    targetNode !== undefined && targetNode in nodes,
    'inflight.target 必须是 qianmo://<nodes 里的节点>/<agent>',
  )
  const attempts =
    typeof raw.inflight.attempts === 'number' ? raw.inflight.attempts : 3
  need(
    Number.isInteger(attempts) && attempts >= 1 && attempts <= 5,
    'inflight.attempts 只能是 1–5',
  )
  const prompt =
    typeof raw.inflight.prompt === 'string' && raw.inflight.prompt !== ''
      ? raw.inflight.prompt
      : undefined

  need(isRecord(raw.canary), '缺 canary')
  const canary = {
    node: str(raw.canary, 'node', 'canary'),
    baseUrl: httpUrl(str(raw.canary, 'baseUrl', 'canary'), 'canary.baseUrl'),
    realApply: raw.canary.realApply === true,
  }
  need(canary.node in nodes, 'canary.node 不在 nodes 里')

  const timingRaw = isRecord(raw.timing) ? raw.timing : {}
  const timing: Record<string, unknown> = { ...DEFAULT_TIMING }
  for (const [key, value] of Object.entries(timingRaw)) {
    need(key in DEFAULT_TIMING, `timing.${key} 不认识`)
    if (key === 'retryDelaysMs') {
      need(
        Array.isArray(value) &&
          value.length <= 5 &&
          value.every(v => typeof v === 'number' && v >= 0),
        'timing.retryDelaysMs 必须是至多 5 个非负数',
      )
    } else {
      need(typeof value === 'number' && value > 0, `timing.${key} 必须是正数`)
    }
    timing[key] = value
  }

  return {
    v: 1,
    console: consoleCfg,
    machines,
    hub,
    nodes,
    expect: sourceCommit === undefined ? {} : { sourceCommit },
    switch: switchCfg,
    call,
    inflight: {
      target,
      attempts,
      ...(prompt === undefined ? {} : { prompt }),
    },
    canary,
    timing: timing as unknown as Timing,
  }
}

// ── 脱敏 ──────────────────────────────────────────────────────────────────────

/** 把这一轮知道的秘密换成标签；自由文本再把像 token 的长串换掉。 */
export class Redactor {
  readonly #needles: { value: string; label: string }[] = []

  add(value: string, label: string): void {
    if (value !== '') this.#needles.push({ value, label })
  }

  /** 这段文本里出现了哪些秘密（标签）。 */
  labelsIn(text: string): string[] {
    return this.#needles
      .filter(needle => text.includes(needle.value))
      .map(needle => needle.label)
  }

  text(input: string): string {
    let out = input
    for (const needle of this.#needles) {
      out = out.split(needle.value).join(`«${needle.label}»`)
    }
    return out
  }

  free(input: string): string {
    return this.text(input).replace(/[A-Za-z0-9_-]{32,}/g, '«long-token»')
  }
}

// ── 证据 ──────────────────────────────────────────────────────────────────────

class Evidence {
  readonly dir: string
  readonly #redactor: Redactor
  #seq = 0

  constructor(dir: string, redactor: Redactor) {
    this.dir = dir
    this.#redactor = redactor
    mkdirSync(join(dir, 'raw'), { recursive: true, mode: 0o700 })
  }

  write(name: string, value: unknown): void {
    const text = this.#redactor.text(JSON.stringify(value, null, 2))
    writeFileSync(join(this.dir, name), `${text}\n`, { mode: 0o600 })
  }

  writeText(name: string, text: string): void {
    writeFileSync(join(this.dir, name), this.#redactor.text(text), {
      mode: 0o600,
    })
  }

  raw(slug: string, value: unknown): void {
    this.#seq += 1
    const name = `${String(this.#seq).padStart(3, '0')}-${slug.replace(/[^A-Za-z0-9._-]/g, '_')}.json`
    this.write(join('raw', name), value)
  }

  retry(entry: Record<string, unknown>): void {
    appendFileSync(
      join(this.dir, 'retries.ndjson'),
      `${this.#redactor.text(JSON.stringify(entry))}\n`,
      { mode: 0o600 },
    )
  }
}

// ── 控制台 HTTP ───────────────────────────────────────────────────────────────

interface Reply {
  readonly status: number
  readonly text: string
  readonly json: unknown
  /** 重试用完仍是过程失败时的原因；正常拿到响应时为 null。 */
  readonly transport: string | null
}

const sleep = (ms: number): Promise<void> => Bun.sleep(ms)

class ConsoleClient {
  readonly #base: string
  readonly #token: string
  readonly #timing: Timing
  readonly #evidence: Evidence
  readonly #onBody: (where: string, text: string) => void

  constructor(
    base: string,
    token: string,
    timing: Timing,
    evidence: Evidence,
    onBody: (where: string, text: string) => void,
  ) {
    this.#base = base
    this.#token = token
    this.#timing = timing
    this.#evidence = evidence
    this.#onBody = onBody
  }

  async call(
    method: string,
    path: string,
    body?: unknown,
    options: { readonly document?: boolean } = {},
  ): Promise<Reply> {
    const delays = this.#timing.retryDelaysMs
    let last = 'no attempt'
    for (let attempt = 0; attempt <= delays.length; attempt += 1) {
      if (attempt > 0) {
        this.#evidence.retry({
          at: new Date().toISOString(),
          kind: 'http',
          method,
          path,
          attempt,
          reason: last,
        })
        await sleep(delays[attempt - 1] ?? 0)
      }
      let response: Response
      try {
        response = await fetch(`${this.#base}${path}`, {
          method,
          headers: {
            authorization: `Bearer ${this.#token}`,
            ...(body === undefined
              ? {}
              : { 'content-type': 'application/json' }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(this.#timing.httpTimeoutMs),
        })
      } catch (error) {
        last = `fetch 抛错：${error instanceof Error ? error.name : 'unknown'}`
        continue
      }
      let text: string
      try {
        text = await response.text()
      } catch {
        last = '读响应体失败'
        continue
      }
      this.#onBody(`${method} ${path}`, text)
      let json: unknown = null
      if (!options.document) {
        try {
          json = text === '' ? null : (JSON.parse(text) as unknown)
        } catch {
          json = null
        }
        if (response.status === 200 && json === null) {
          last = text === '' ? '200 但响应体为空' : '200 但响应体不是 JSON'
          continue
        }
      } else if (response.status === 200 && text === '') {
        last = '200 但响应体为空'
        continue
      }
      return { status: response.status, text, json, transport: null }
    }
    return { status: 0, text: '', json: null, transport: last }
  }
}

function errorOf(reply: Reply, redactor: Redactor): string {
  if (reply.transport !== null)
    return `过程失败（已按规则重试）：${reply.transport}`
  const error = isRecord(reply.json) ? reply.json.error : undefined
  const message =
    isRecord(error) && typeof error.message === 'string' ? error.message : ''
  const code =
    isRecord(error) && typeof error.code === 'string' ? error.code : ''
  return redactor.free(
    `HTTP ${reply.status}${code === '' ? '' : ` ${code}`}${message === '' ? '' : `：${message}`}`,
  )
}

// ── 远端（ssh）───────────────────────────────────────────────────────────────

interface RemoteResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

function sshBin(): string {
  return process.env.QIANMO_ACCEPTANCE_SSH_BIN || 'ssh'
}

function remoteCommand(machine: MachineConfig, args: string): string {
  const root = machine.root === undefined ? '' : ` --root '${machine.root}'`
  return `PATH="$HOME/.bun/bin:$PATH" bun '${machine.tree}/${NODE_SCRIPT}' ${args}${root}`
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  return await new Response(stream).text()
}

class Remote {
  readonly #timing: Timing
  readonly #evidence: Evidence

  constructor(timing: Timing, evidence: Evidence) {
    this.#timing = timing
    this.#evidence = evidence
  }

  async run(machine: MachineConfig, args: string): Promise<RemoteResult> {
    const delays = this.#timing.retryDelaysMs
    let last: RemoteResult = { code: -1, stdout: '', stderr: '' }
    for (let attempt = 0; attempt <= delays.length; attempt += 1) {
      if (attempt > 0) {
        this.#evidence.retry({
          at: new Date().toISOString(),
          kind: 'ssh',
          target: machine.ssh,
          args,
          attempt,
          reason:
            last.code === 255 ? 'ssh 退出码 255' : '远端退出 0 但没有输出',
        })
        await sleep(delays[attempt - 1] ?? 0)
      }
      const proc = Bun.spawn(
        [
          sshBin(),
          '-o',
          'BatchMode=yes',
          '-o',
          'ConnectTimeout=15',
          machine.ssh,
          remoteCommand(machine, args),
        ],
        { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
      )
      const timer = setTimeout(() => proc.kill(), this.#timing.sshTimeoutMs)
      const [stdout, stderr] = await Promise.all([
        readAll(proc.stdout),
        readAll(proc.stderr),
      ])
      const code = await proc.exited
      clearTimeout(timer)
      last = { code, stdout, stderr }
      if (code === 255 || (code === 0 && stdout.trim() === '')) continue
      return last
    }
    return last
  }

  /** 起一个扫描器：等到它的 ready 行，返回停止它的函数。 */
  async scan(
    machine: MachineConfig,
    args: string,
    canaries: readonly string[],
  ): Promise<ScanHandle> {
    const proc = Bun.spawn(
      [
        sshBin(),
        '-o',
        'BatchMode=yes',
        '-o',
        'ConnectTimeout=15',
        machine.ssh,
        remoteCommand(machine, args),
      ],
      { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
    )
    proc.stdin.write(
      `${JSON.stringify({ canaries, psIntervalMs: this.#timing.psIntervalMs })}\n`,
    )
    proc.stdin.flush()
    const reader = proc.stdout.getReader()
    const decoder = new TextDecoder()
    let buffered = ''
    const stderr = readAll(proc.stderr)
    const nextLine = async (timeoutMs: number): Promise<string | null> => {
      const deadline = Date.now() + timeoutMs
      for (;;) {
        const at = buffered.indexOf('\n')
        if (at !== -1) {
          const line = buffered.slice(0, at)
          buffered = buffered.slice(at + 1)
          return line
        }
        const left = deadline - Date.now()
        if (left <= 0) return null
        const chunk = await Promise.race([
          reader.read(),
          sleep(left).then(() => 'timeout' as const),
        ])
        if (chunk === 'timeout') return null
        if (chunk.done) {
          if (buffered === '') return null
          const line = buffered
          buffered = ''
          return line
        }
        buffered += decoder.decode(chunk.value, { stream: true })
      }
    }
    const ready = await nextLine(this.#timing.scanReadyTimeoutMs)
    let readyInfo: unknown = null
    try {
      readyInfo = ready === null ? null : (JSON.parse(ready) as unknown)
    } catch {
      readyInfo = null
    }
    const started = isRecord(readyInfo) && readyInfo.ready === true
    const timing = this.#timing
    return {
      started,
      async stop(): Promise<ScanResult | null> {
        try {
          proc.stdin.write('stop\n')
          proc.stdin.end()
        } catch {
          // 进程已经没了：下面读不到结果行，按扫描器失败判。
        }
        const line = started ? await nextLine(timing.sshTimeoutMs) : null
        proc.kill()
        await proc.exited
        await stderr
        if (line === null) return null
        try {
          const parsed = JSON.parse(line) as unknown
          return isRecord(parsed) && parsed.done === true
            ? (parsed as unknown as ScanResult)
            : null
        } catch {
          return null
        }
      },
    }
  }
}

interface ScanHandle {
  readonly started: boolean
  stop(): Promise<ScanResult | null>
}

// ── 判定 ──────────────────────────────────────────────────────────────────────

export type ItemStatus = 'PASS' | 'FAIL' | 'RECORD' | 'SKIPPED'

export interface Item {
  readonly id: string
  readonly title: string
  readonly status: ItemStatus
  /** 红的种类，机器可读（`drift`、`turn-failed`、`canary-leak`…）。 */
  readonly class?: string
  readonly detail: readonly string[]
}

export interface Deployment {
  readonly sourceCommit: string | null
  readonly machines: Record<
    string,
    {
      readonly cliSha256: string | null
      readonly cliInode: number | null
      readonly cliMtime: string | null
    }
  >
  readonly processes: Record<
    string,
    {
      readonly machine: string
      readonly pid: number | null
      readonly startedAt: string | null
    }
  >
  /** sha256(规范 JSON {sourceCommit, machines})：同一份部署的判据。 */
  readonly fingerprint: string | null
}

export interface Verdict {
  readonly v: 1
  readonly label: string
  readonly startedAt: string
  readonly finishedAt: string
  readonly green: boolean
  readonly held: boolean
  readonly red: readonly string[]
  readonly items: readonly Item[]
  readonly deployment: Deployment | null
  readonly moments: readonly Record<string, unknown>[]
  readonly retries: number
  readonly scope: Record<string, unknown>
}

const ITEMS: readonly { id: string; title: string }[] = [
  { id: 'P0', title: '前置：配置、凭据、控制台、运维角色' },
  { id: 'D0', title: '部署身份（开始）' },
  { id: 'W1', title: '接线：P18.20 信任与本地命令、签名对话、模型服务执行器' },
  { id: 'A1', title: '所有节点 status 无漂移（开始）' },
  { id: 'A2', title: '真 key 三态测连（auth）' },
  { id: 'A4', title: 'call 模式真实调用' },
  {
    id: 'A6',
    title: '在途 turn 时下发：等空闲、在途 turn 不失败（同构建热切换样本）',
  },
  { id: 'A3', title: '真实切换并切回' },
  { id: 'A5', title: 'AC-P2 金丝雀与真 key 扫描' },
  { id: 'A1b', title: '所有节点 status 无漂移（结束）' },
  { id: 'D1', title: '部署身份与进程（结束）同开始' },
]

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map(key => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

/**
 * 控制台横幅的 chat 行。形状照 `src/cli/handlers/console.ts` 的 `wireConsoleChat`：
 * `enabled as <--chat-from 地址>[ (signed)] -> <节点 -> 端点>, …`；`--chat-from` 缺省是
 * `qianmo://console/operator`，地址里的节点名就是各节点 `--trust <名>=<公钥>` 里的那个名。
 * 不是 enabled（`disabled (…)`）或形状不对时是 null。
 */
export function chatWiringOf(chat: string | undefined): {
  readonly from: string
  readonly node: string
  readonly signed: boolean
} | null {
  const match =
    /^enabled as (qianmo:\/\/([^/\s]+)\/\S+?)( \(signed\))?(?: -> |$)/.exec(
      chat ?? '',
    )
  if (match === null) return null
  return {
    from: match[1] ?? '',
    node: match[2] ?? '',
    signed: match[3] !== undefined,
  }
}

/**
 * W1 的控制台一半：chat 以 `qianmo://<chatAs>/…` 签名，个人账号开着，模型服务 enabled 且
 * 执行器覆盖配置里每个节点、种类与它所在的机器相符。字面量的出处：`console.ts` 里
 * `field('chat' | 'accounts' | 'providers', …)` 那几行（用例拿真起的控制台的横幅喂它）。
 */
export function consoleWiringProblems(
  banner: Readonly<Record<string, string>> | null,
  cfg: Pick<RoundConfig, 'hub' | 'nodes'> & { readonly chatAs: string },
): string[] {
  if (banner === null) return ['读不到控制台横幅']
  const problems: string[] = []
  const chatAs = cfg.chatAs
  const chat = chatWiringOf(banner.chat)
  if (chat === null) {
    problems.push(
      `控制台 chat 行是「${banner.chat ?? '（缺）'}」，不是 enabled as qianmo://${chatAs}/<agent> (signed) -> …`,
    )
  } else {
    if (chat.node !== chatAs)
      problems.push(
        `控制台以 ${chat.from} 发对话，节点信任的签名名是 ${chatAs}（--chat-from 的节点名要与 --trust ${chatAs}=<公钥> 一致）`,
      )
    if (!chat.signed)
      problems.push(
        `控制台 chat 行没有 (signed)：没开 --chat-sign（${chat.from}）`,
      )
  }
  if (!(banner.accounts ?? '').startsWith('enabled -> '))
    problems.push(
      `控制台没开个人账号（--accounts）：「${banner.accounts ?? '（缺）'}」`,
    )
  const providers = banner.providers ?? ''
  if (!providers.startsWith('enabled -> ')) {
    problems.push(`控制台模型服务不是 enabled：「${providers}」`)
    return problems
  }
  const listed = /\(nodes: ([^)]*)\)\s*$/.exec(providers)?.[1] ?? ''
  const executors = new Map(
    listed
      .split(',')
      .map(entry => entry.trim().split('/'))
      .filter((pair): pair is [string, string] => pair.length === 2)
      .map(([node, kind]) => [node, kind] as const),
  )
  for (const [node, { machine }] of Object.entries(cfg.nodes)) {
    const kind = executors.get(node)
    const want = machine === cfg.hub ? 'local' : 'ssh'
    if (kind === undefined) problems.push(`${node}：控制台没有它的执行器`)
    else if (kind !== want)
      problems.push(`${node}：执行器是 ${kind}，按它所在的机器应是 ${want}`)
  }
  return problems
}

export function deploymentOf(
  cfg: RoundConfig,
  facts: Readonly<Record<string, MachineFacts | null>>,
): Deployment {
  const commits = new Set<string>()
  const machines: Record<
    string,
    {
      cliSha256: string | null
      cliInode: number | null
      cliMtime: string | null
    }
  > = {}
  const processes: Record<
    string,
    { machine: string; pid: number | null; startedAt: string | null }
  > = {}
  let complete = true
  for (const [name, f] of Object.entries(facts)) {
    if (f === null) {
      complete = false
      continue
    }
    machines[name] = {
      cliSha256: f.tree.cliSha256,
      cliInode: f.tree.cliInode,
      cliMtime: f.tree.cliMtime,
    }
    if (f.tree.cliSha256 === null) complete = false
  }
  const hubFacts = facts[cfg.hub] ?? null
  if (hubFacts?.console != null) {
    processes.console = {
      machine: cfg.hub,
      pid: hubFacts.console.pid,
      startedAt: hubFacts.console.startedAt,
    }
    const commit = hubFacts.console.banner?.sourceCommit
    if (commit !== undefined) commits.add(commit)
    else complete = false
  } else {
    complete = false
  }
  for (const [node, { machine }] of Object.entries(cfg.nodes)) {
    const n = facts[machine]?.nodes[node]
    if (n === undefined) {
      complete = false
      continue
    }
    processes[node] = { machine, pid: n.pid, startedAt: n.startedAt }
    const commit = n.banner?.sourceCommit
    if (typeof commit === 'string') commits.add(commit)
    else complete = false
  }
  const sourceCommit = commits.size === 1 ? ([...commits][0] ?? null) : null
  const fingerprint =
    complete && sourceCommit !== null
      ? createHash('sha256')
          .update(canonical({ sourceCommit, machines }))
          .digest('hex')
      : null
  return { sourceCommit, machines, processes, fingerprint }
}

function mainModelOf(profile: unknown): string | null {
  if (!isRecord(profile) || !Array.isArray(profile.models)) return null
  for (const model of profile.models) {
    if (
      isRecord(model) &&
      model.role === 'main' &&
      typeof model.id === 'string'
    ) {
      return model.id
    }
  }
  return null
}

/** 一个节点视图对着期望的档案，挑出全部不对的地方（空 = 没漂移）。 */
export function stateProblems(
  view: ProviderNodeView,
  profileId: string,
): { problems: string[]; notes: string[] } {
  const problems: string[] = []
  const notes: string[] = []
  if (view.lastStatus?.ok !== true) problems.push('最近一次 status 不是 ok')
  if (view.drift.length > 0) {
    problems.push(`漂移：${view.drift.map(drift => drift.kind).join('、')}`)
  }
  const actual = view.actual
  if (actual === null) {
    problems.push('没有实际状态')
    return { problems, notes }
  }
  if (!actual.managed) problems.push('节点不受托管')
  if (view.expected?.profileId !== profileId) {
    problems.push(
      `期望档案是 ${view.expected?.profileId ?? '（不托管）'}，不是 ${profileId}`,
    )
  }
  if (
    actual.applied === null ||
    actual.applied.profileId !== view.expected?.profileId ||
    actual.applied.revision !== view.expected?.revision
  ) {
    problems.push(
      `已应用 ${actual.applied === null ? '（无）' : `${actual.applied.profileId}@${actual.applied.revision}`} 与期望不符`,
    )
  }
  if (actual.pending !== null) problems.push('还有 pending')
  if (
    actual.appliedHash === null ||
    actual.loadedHash !== actual.appliedHash ||
    actual.onDiskHash !== actual.appliedHash
  ) {
    problems.push('onDisk / applied / loaded 三个哈希不一致')
  }
  if (actual.resident?.running !== true) problems.push('resident 没在跑')
  for (const key of actual.keys ?? []) {
    if (key.state === 'dead') {
      problems.push(
        `key ${key.id} 已失效（dead${key.reason === undefined ? '' : `，${key.reason}`}）`,
      )
    } else if (key.state === 'cooling') {
      notes.push(
        `key ${key.id} 冷却中（${key.reason ?? '原因未报'}，到 ${key.until ?? '?'}）`,
      )
    }
  }
  return { problems, notes }
}

function projectView(view: ProviderNodeView): Record<string, unknown> {
  const a = view.actual
  return {
    node: view.node,
    executor: view.executor,
    assignment: view.assignment,
    expected: view.expected,
    lastStatus:
      view.lastStatus === null
        ? null
        : { at: view.lastStatus.at, ok: view.lastStatus.ok },
    drift: view.drift.map(drift => drift.kind),
    actual:
      a === null
        ? null
        : {
            managed: a.managed,
            applied: a.applied,
            onDiskHash: a.onDiskHash,
            appliedHash: a.appliedHash,
            loadedHash: a.loadedHash,
            pending: a.pending,
            resident: a.resident,
            keys: a.keys ?? null,
            effective:
              a.effective === undefined
                ? null
                : {
                    apiProvider: a.effective.apiProvider,
                    wire: a.effective.wire,
                    model: a.effective.model,
                    wireModel: a.effective.wireModel,
                    effortOnWire: a.effective.effortOnWire,
                    effortLevel: a.effective.effortLevel,
                  },
          },
  }
}

function turnsOf(json: unknown): readonly ChatTurn[] {
  if (!isRecord(json) || !Array.isArray(json.turns)) return []
  return json.turns as readonly ChatTurn[]
}

/** 操作者那一轮的回复：同 taskId 的 agent 消息（不是过程行）；没有 taskId 时取它后面的第一条。 */
export function replyOf(
  turns: readonly ChatTurn[],
  operator: ChatTurn,
): ChatTurn | null {
  const index = turns.findIndex(turn => turn.id === operator.id)
  const after = index === -1 ? turns : turns.slice(index + 1)
  return (
    after.find(
      turn =>
        turn.author === 'agent' &&
        turn.variant !== 'notice' &&
        (operator.taskId === undefined || turn.taskId === operator.taskId),
    ) ?? null
  )
}

/** 金丝雀档案从哪个预设起（自定义 OpenAI 兼容：没有预设探测，测连走通用 `{base}/models`）。 */
export const CANARY_PRESET = 'custom-openai'
const CANARY_MODEL = 'qm-canary-model'

/**
 * 金丝雀档案的表单字段（路由只取 EDITABLE 里的几项叠在预设草稿上）。两把 key 覆盖 P18.18
 * 的多 key 路径。导出给用例：用真校验器核过它在真控制台上存得进去。
 */
export function canaryProfileEdit(
  id: string,
  baseUrl: string,
): Record<string, unknown> {
  return {
    id,
    name: 'AC-P2 金丝雀',
    lane: 'openai-chat',
    baseUrl,
    models: [
      {
        id: CANARY_MODEL,
        role: 'main',
        tiers: ['opus', 'sonnet', 'haiku'],
        capabilities: { mode: 'family' },
        effort: { send: 'auto' },
      },
    ],
    keys: [{ id: 'k1' }, { id: 'k2' }],
    keySelection: 'fill_first',
  }
}

function newCanary(): string {
  const alphabet =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  const bytes = randomBytes(40)
  let out = 'sk-qmcanary-'
  for (const byte of bytes) out += alphabet[byte % alphabet.length]
  return out
}

// ── 一轮 ──────────────────────────────────────────────────────────────────────

export interface RoundOptions {
  readonly config: RoundConfig
  readonly outDir: string
  readonly label: string
}

class Round {
  readonly #cfg: RoundConfig
  readonly #outDir: string
  readonly #redactor = new Redactor()
  readonly #evidence: Evidence
  readonly #remote: Remote
  readonly #canaries: string[]
  readonly #items: Item[] = []
  readonly #moments: Record<string, unknown>[] = []
  /** 运维本机看到的每个响应里命中的秘密：`<请求> → <标签>`。 */
  readonly #pageHits: string[] = []
  #client!: ConsoleClient
  #held = false
  #deployment: Deployment | null = null
  #facts0: Record<string, MachineFacts | null> = {}
  readonly #baseline = new Map<string, ProviderNodeView>()

  constructor(options: RoundOptions) {
    this.#cfg = options.config
    this.#outDir = options.outDir
    this.#canaries = [newCanary(), newCanary(), newCanary()]
    this.#canaries.forEach((value, index) =>
      this.#redactor.add(value, `canary-${index + 1}`),
    )
    this.#evidence = new Evidence(
      join(options.outDir, `round-${options.label}`),
      this.#redactor,
    )
    this.#remote = new Remote(this.#cfg.timing, this.#evidence)
  }

  get evidence(): Evidence {
    return this.#evidence
  }

  #push(item: Item): void {
    this.#items.push({
      ...item,
      // 自己拼的句子只换秘密；外来的自由文本在拼进来的那一刻已经过了 free()。
      detail: item.detail.map(line => this.#redactor.text(line)),
    })
  }

  #holdRequested(): boolean {
    return existsSync(join(this.#outDir, 'HOLD'))
  }

  async #step(
    id: string,
    run: () => Promise<Omit<Item, 'id' | 'title'>>,
  ): Promise<Item> {
    const title = ITEMS.find(item => item.id === id)?.title ?? id
    if (this.#held || this.#holdRequested()) {
      this.#held = true
      const item: Item = { id, title, status: 'SKIPPED', detail: ['HOLD'] }
      this.#push(item)
      return item
    }
    let result: Omit<Item, 'id' | 'title'>
    try {
      result = await run()
    } catch (error) {
      result = {
        status: 'FAIL',
        class: 'exception',
        detail: [
          `脚本自己出错：${this.#redactor.free(error instanceof Error ? error.message : String(error))}`,
        ],
      }
    }
    const item: Item = { id, title, ...result }
    this.#push(item)
    return item
  }

  #api(
    method: string,
    path: string,
    body?: unknown,
    document = false,
  ): Promise<Reply> {
    return this.#client.call(method, path, body, { document })
  }

  async #refresh(
    node: string,
  ): Promise<{ view: ProviderNodeView | null; error: string | null }> {
    const reply = await this.#api(
      'POST',
      `/v0/providers/nodes/${encodeURIComponent(node)}/refresh`,
      {},
    )
    if (
      reply.status !== 200 ||
      !isRecord(reply.json) ||
      !isRecord(reply.json.node)
    ) {
      return { view: null, error: errorOf(reply, this.#redactor) }
    }
    return { view: reply.json.node as unknown as ProviderNodeView, error: null }
  }

  async #transcript(sessionId: string): Promise<readonly ChatTurn[] | null> {
    const reply = await this.#api(
      'GET',
      `/v0/chat/sessions/${encodeURIComponent(sessionId)}`,
    )
    if (reply.status !== 200) return null
    return turnsOf(reply.json as ChatTranscript)
  }

  async #until<T>(
    timeoutMs: number,
    probe: () => Promise<T | null>,
  ): Promise<T | null> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const value = await probe()
      if (value !== null) return value
      if (Date.now() >= deadline) return null
      await sleep(this.#cfg.timing.pollMs)
    }
  }

  async #facts(): Promise<Record<string, MachineFacts | null>> {
    const out: Record<string, MachineFacts | null> = {}
    await Promise.all(
      Object.entries(this.#cfg.machines).map(async ([name, machine]) => {
        const nodes = Object.entries(this.#cfg.nodes)
          .filter(([, value]) => value.machine === name)
          .map(([node]) => node)
        const args = [
          'facts',
          `--tree '${machine.tree}'`,
          ...(nodes.length === 0 ? [] : [`--nodes ${nodes.join(',')}`]),
          ...(name === this.#cfg.hub ? ['--console'] : []),
        ].join(' ')
        const result = await this.#remote.run(machine, args)
        let parsed: unknown = null
        try {
          parsed =
            result.code === 0
              ? (JSON.parse(
                  result.stdout.trim().split('\n').pop() ?? '',
                ) as unknown)
              : null
        } catch {
          parsed = null
        }
        out[name] =
          isRecord(parsed) && parsed.v === 1
            ? (parsed as unknown as MachineFacts)
            : null
      }),
    )
    return out
  }

  // ── items ──

  async #p0(): Promise<Omit<Item, 'id' | 'title'>> {
    const detail: string[] = []
    const health = await this.#api('GET', '/v0/health')
    if (
      health.status !== 200 ||
      !isRecord(health.json) ||
      health.json.status !== 'ok'
    ) {
      return {
        status: 'FAIL',
        class: 'console-down',
        detail: [`/v0/health：${errorOf(health, this.#redactor)}`],
      }
    }
    detail.push('/v0/health 200')
    const anyProfile = Object.values(this.#cfg.nodes)[0]?.profileId ?? ''
    const role = await this.#api('POST', '/v0/providers/preview', {
      profileId: anyProfile,
    })
    if (role.status === 401 || role.status === 403) {
      return {
        status: 'FAIL',
        class: 'not-ops',
        detail: [
          ...detail,
          `凭据不是运维个人账号或已失效：${errorOf(role, this.#redactor)}`,
        ],
      }
    }
    // 写者检查在解析请求体之前：除了 401 / 403，任何一个端口给的答复（200，或档案层面的
    // 400 / 404 / 422）都说明已经过了「ops 个人账号」这一关。501 是模型服务没接上。
    if (role.status === 0 || role.status === 501 || role.status >= 500) {
      return {
        status: 'FAIL',
        class: 'console',
        detail: [...detail, `preview：${errorOf(role, this.#redactor)}`],
      }
    }
    detail.push(`运维个人账号（preview ${role.status}）`)
    const overview = await this.#api('GET', '/v0/providers')
    if (
      overview.status !== 200 ||
      !isRecord(overview.json) ||
      !Array.isArray(overview.json.nodes)
    ) {
      return {
        status: 'FAIL',
        class: 'console',
        detail: [
          ...detail,
          `/v0/providers：${errorOf(overview, this.#redactor)}`,
        ],
      }
    }
    const known = new Set(
      overview.json.nodes
        .filter(isRecord)
        .map(node => node.node)
        .filter((name): name is string => typeof name === 'string'),
    )
    const missing = Object.keys(this.#cfg.nodes).filter(
      node => !known.has(node),
    )
    if (missing.length > 0) {
      return {
        status: 'FAIL',
        class: 'unknown-node',
        detail: [
          ...detail,
          `控制台不认识这些节点（没有执行器）：${missing.join('、')}`,
        ],
      }
    }
    detail.push(`控制台认得全部 ${known.size} 个节点`)
    return { status: 'PASS', detail }
  }

  async #d0(): Promise<Omit<Item, 'id' | 'title'>> {
    const facts = await this.#facts()
    this.#facts0 = facts
    const deployment = deploymentOf(this.#cfg, facts)
    this.#deployment = deployment
    this.#evidence.raw('facts-start', facts)
    const problems: string[] = []
    for (const [name, f] of Object.entries(facts)) {
      if (f === null) problems.push(`${name}：取不到 facts`)
      else if (f.tree.cliSha256 === null)
        problems.push(`${name}：部署树里没有 dist/cli-node.js`)
    }
    const hub = facts[this.#cfg.hub]
    if (hub?.console == null || !hub.console.alive)
      problems.push('控制台进程不在')
    for (const [node, { machine }] of Object.entries(this.#cfg.nodes)) {
      const n = facts[machine]?.nodes[node]
      if (n === undefined || !n.alive)
        problems.push(`${node}：resident 进程不在`)
      else if (n.banner === null) problems.push(`${node}：读不到启动行`)
    }
    const commits = new Set<string>()
    if (hub?.console?.banner?.sourceCommit !== undefined)
      commits.add(hub.console.banner.sourceCommit)
    for (const [node, { machine }] of Object.entries(this.#cfg.nodes)) {
      const commit = facts[machine]?.nodes[node]?.banner?.sourceCommit
      if (typeof commit === 'string') commits.add(commit)
    }
    if (commits.size > 1)
      problems.push(`sourceCommit 不止一个：${[...commits].join('、')}`)
    for (const commit of commits) {
      if (!/^[0-9a-f]{40}$/.test(commit))
        problems.push(`sourceCommit 不是一个干净的 40 位提交：${commit}`)
    }
    const want = this.#cfg.expect.sourceCommit
    if (want !== undefined && deployment.sourceCommit !== want) {
      problems.push(
        `sourceCommit 是 ${deployment.sourceCommit ?? '（不一致）'}，期望 ${want}`,
      )
    }
    if (problems.length > 0)
      return { status: 'FAIL', class: 'deployment', detail: problems }
    return {
      status: 'PASS',
      detail: [
        `sourceCommit ${deployment.sourceCommit ?? ''}`,
        `部署指纹 ${deployment.fingerprint ?? ''}`,
        ...Object.entries(deployment.processes).map(
          ([name, p]) =>
            `${name}@${p.machine} pid ${String(p.pid)} 起于 ${p.startedAt ?? '?'}`,
        ),
      ],
    }
  }

  async #w1(): Promise<Omit<Item, 'id' | 'title'>> {
    const chatAs = this.#cfg.console.chatAs
    const banner = this.#facts0[this.#cfg.hub]?.console?.banner ?? null
    const problems = consoleWiringProblems(banner, {
      hub: this.#cfg.hub,
      nodes: this.#cfg.nodes,
      chatAs,
    }).map(problem => this.#redactor.free(problem))
    const chatFrom = chatWiringOf(banner?.chat)?.from ?? `qianmo://${chatAs}/…`
    for (const [node, { machine }] of Object.entries(this.#cfg.nodes)) {
      const nb = this.#facts0[machine]?.nodes[node]?.banner
      if (nb == null) {
        problems.push(`${node}：读不到启动行`)
        continue
      }
      if (!nb.trusts.includes(chatAs))
        problems.push(
          `${node}：trusts 里没有 ${chatAs}（--trust ${chatAs}=<公钥>）`,
        )
      if (!nb.localCommandsFrom.includes(chatAs)) {
        problems.push(
          `${node}：localCommandsFrom 里没有 ${chatAs}（--local-commands-from ${chatAs}）`,
        )
      }
    }
    return problems.length > 0
      ? { status: 'FAIL', class: 'wiring', detail: problems }
      : {
          status: 'PASS',
          detail: [
            `chat 以 ${chatFrom} 签名；每个节点 trusts / localCommandsFrom 含 ${chatAs}；执行器齐`,
          ],
        }
  }

  async #a1(id: 'A1' | 'A1b'): Promise<Omit<Item, 'id' | 'title'>> {
    const problems: string[] = []
    const notes: string[] = []
    const views: Record<string, unknown> = {}
    for (const [node, { profileId }] of Object.entries(this.#cfg.nodes)) {
      const { view, error } = await this.#refresh(node)
      if (view === null) {
        problems.push(`${node}：refresh 失败：${error ?? ''}`)
        continue
      }
      views[node] = projectView(view)
      if (id === 'A1') this.#baseline.set(node, view)
      const checked = stateProblems(view, profileId)
      problems.push(...checked.problems.map(p => `${node}：${p}`))
      notes.push(...checked.notes.map(n => `${node}：${n}`))
    }
    this.#evidence.raw(`nodes-${id}`, views)
    if (problems.length > 0)
      return { status: 'FAIL', class: 'drift', detail: [...problems, ...notes] }
    return {
      status: 'PASS',
      detail: [`${Object.keys(this.#cfg.nodes).length} 个节点无漂移`, ...notes],
    }
  }

  async #probe(
    node: string,
    mode: 'auth' | 'call',
    profileId: string,
  ): Promise<{ result: ProviderProbeResult | null; error: string | null }> {
    const reply = await this.#api('POST', '/v0/providers/probe', {
      node,
      mode,
      profileId,
    })
    if (reply.status !== 200 || !isRecord(reply.json)) {
      return { result: null, error: errorOf(reply, this.#redactor) }
    }
    return { result: reply.json as unknown as ProviderProbeResult, error: null }
  }

  #probeLine(node: string, result: ProviderProbeResult): string {
    const state = result.ok ? 'ok' : result.reachable ? '连上但被拒' : '没连上'
    return `${node}：${state}${result.httpStatus === undefined ? '' : ` · HTTP ${result.httpStatus}`}${result.vendorCode === undefined ? '' : ` · ${this.#redactor.free(result.vendorCode)}`} · ${this.#redactor.free(result.message)}`
  }

  async #a2(): Promise<Omit<Item, 'id' | 'title'>> {
    const lines: string[] = []
    let red = false
    const raw: Record<string, unknown> = {}
    for (const [node, { profileId }] of Object.entries(this.#cfg.nodes)) {
      const { result, error } = await this.#probe(node, 'auth', profileId)
      if (result === null) {
        red = true
        lines.push(`${node}：测连请求失败：${error ?? ''}`)
        continue
      }
      raw[node] = {
        ok: result.ok,
        reachable: result.reachable,
        httpStatus: result.httpStatus ?? null,
        vendorCode: result.vendorCode ?? null,
      }
      if (!(result.ok && result.reachable)) red = true
      lines.push(this.#probeLine(node, result))
    }
    this.#evidence.raw('probe-auth', raw)
    return red
      ? { status: 'FAIL', class: 'auth', detail: lines }
      : { status: 'PASS', detail: lines }
  }

  async #a4(): Promise<Omit<Item, 'id' | 'title'>> {
    const node = this.#cfg.call.node
    const profileId = this.#cfg.nodes[node]?.profileId ?? ''
    const { result, error } = await this.#probe(node, 'call', profileId)
    if (result === null)
      return {
        status: 'FAIL',
        class: 'call',
        detail: [`call 请求失败：${error ?? ''}`],
      }
    this.#evidence.raw('probe-call', {
      node,
      ok: result.ok,
      reachable: result.reachable,
      httpStatus: result.httpStatus ?? null,
      latency: result.latency ?? null,
    })
    const line = this.#probeLine(node, result)
    return result.ok && result.reachable
      ? { status: 'PASS', detail: [line] }
      : { status: 'FAIL', class: 'call', detail: [line] }
  }

  async #a6(): Promise<Omit<Item, 'id' | 'title'>> {
    const { target, attempts = 3 } = this.#cfg.inflight
    const prompt = this.#cfg.inflight.prompt ?? DEFAULT_INFLIGHT_PROMPT
    const node = /^qianmo:\/\/([^/]+)\//.exec(target)?.[1] ?? ''
    const tries: { kind: string; detail: string[] }[] = []
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const moment: Record<string, unknown> = { item: 'A6', node, attempt }
      const outcome = await this.#inflightOnce(node, target, prompt, moment)
      this.#moments.push(moment)
      tries.push(outcome)
      if (
        outcome.kind !== 'inconclusive' &&
        outcome.kind !== 'no-wait-suspect'
      ) {
        break
      }
    }
    const last = tries[tries.length - 1] ?? { kind: 'inconclusive', detail: [] }
    const detail = tries.flatMap((t, index) => [
      `第 ${index + 1} 次：${t.kind}`,
      ...t.detail.map(d => `  ${d}`),
    ])
    if (last.kind === 'pass') return { status: 'PASS', detail }
    // 每一次都是「先看到已切、回复还没到、节点从没报过在等」：节点多半没有等空闲。
    // 只要有一次不是这个形状，就只能说「不确定」——两种都是红。
    const kind =
      last.kind === 'inconclusive' || last.kind === 'no-wait-suspect'
        ? tries.every(t => t.kind === 'no-wait-suspect')
          ? 'no-wait'
          : 'inconclusive'
        : last.kind
    return { status: 'FAIL', class: kind, detail }
  }

  async #inflightOnce(
    node: string,
    target: string,
    prompt: string,
    moment: Record<string, unknown>,
  ): Promise<{ kind: string; detail: string[] }> {
    const timing = this.#cfg.timing
    const now = (): string => new Date().toISOString()
    const before = await this.#refresh(node)
    if (before.view === null)
      return { kind: 'refresh-failed', detail: [before.error ?? ''] }
    const g0 = before.view.actual?.resident?.generation ?? null
    moment.generationBefore = g0
    const opened = await this.#api('POST', '/v0/chat/sessions', { target })
    if (opened.status !== 200 || !isRecord(opened.json)) {
      return {
        kind: 'chat-failed',
        detail: [`开会话：${errorOf(opened, this.#redactor)}`],
      }
    }
    const session = opened.json as unknown as ChatSession
    moment.sessionId = session.id
    const sent = await this.#api(
      'POST',
      `/v0/chat/sessions/${encodeURIComponent(session.id)}/messages`,
      { text: prompt },
    )
    if (sent.status !== 200 || !isRecord(sent.json)) {
      return {
        kind: 'chat-failed',
        detail: [`发话：${errorOf(sent, this.#redactor)}`],
      }
    }
    const operator = sent.json as unknown as ChatTurn
    moment.sentAt = now()
    moment.turnId = operator.id

    const ack = await this.#until(timing.ackTimeoutMs, async () => {
      const turns = await this.#transcript(session.id)
      if (turns === null) return null
      const op = turns.find(turn => turn.id === operator.id)
      const reply = op === undefined ? null : replyOf(turns, op)
      if (reply !== null) return { reply, failed: reply.state === 'failed' }
      if (op?.state === 'failed') return { reply: null, failed: true }
      if (op?.state === 'read') return { reply: null, failed: false }
      return null
    })
    if (ack === null)
      return {
        kind: 'no-ack',
        detail: [`${timing.ackTimeoutMs} ms 内对方没有受理这一轮`],
      }
    if (ack.failed)
      return { kind: 'turn-failed', detail: ['在下发之前这一轮就失败了'] }
    if (ack.reply !== null) {
      return {
        kind: 'inconclusive',
        detail: ['回复在下发之前就到了（这一轮太短）'],
      }
    }
    moment.readAt = now()

    const applied = await this.#api('POST', '/v0/providers/apply', {
      nodes: [node],
    })
    const results =
      isRecord(applied.json) && Array.isArray(applied.json.results)
        ? (applied.json.results as ProviderApplyResult[])
        : []
    const result = results[0]
    if (
      applied.status !== 200 ||
      result === undefined ||
      result.outcome !== 'ok'
    ) {
      return {
        kind: 'apply-refused',
        detail: [
          result === undefined
            ? errorOf(applied, this.#redactor)
            : this.#redactor.free(
                `${result.outcome} ${result.code ?? ''} ${result.message}`,
              ),
        ],
      }
    }
    moment.appliedAt = now()
    moment.requestId = result.requestId
    const rid = result.requestId

    let sawWaiting = false
    let reply: ChatTurn | null = null
    let switchedBeforeReply = false
    const final = await this.#until(timing.inflightTimeoutMs, async () => {
      // 先 refresh、后读转录：refresh 说「已切」而之后读到的转录还没有回复，切换就确实先于回复。
      const { view } = await this.#refresh(node)
      const turns = await this.#transcript(session.id)
      if (turns !== null) {
        const op = turns.find(turn => turn.id === operator.id)
        const found = op === undefined ? null : replyOf(turns, op)
        if (found !== null && reply === null) {
          moment.replyAt = now()
          moment.replyState = found.state
        }
        reply = found
      }
      const a = view?.actual ?? null
      if (
        a?.pending?.requestId === rid &&
        (a.pending.waitingTurns ?? 0) >= 1 &&
        !sawWaiting
      ) {
        sawWaiting = true
        moment.waitingSeenAt = now()
        moment.waitingTurns = a.pending.waitingTurns
      }
      const switched =
        a !== null && a.pending === null && a.applied?.requestId === rid
      if (switched && moment.switchedAt === undefined) {
        moment.switchedAt = now()
        if (reply === null) switchedBeforeReply = true
      }
      return switched && reply !== null && view !== null
        ? { view, reply }
        : null
    })
    const replyNow = reply as ChatTurn | null
    if (final === null) {
      if (replyNow?.state === 'failed')
        return { kind: 'turn-failed', detail: ['在途那一轮失败了'] }
      return {
        kind: replyNow === null ? 'timeout' : 'not-switched',
        detail: [
          replyNow === null
            ? `${timing.inflightTimeoutMs} ms 内没有回复`
            : '回复到了，但这次下发一直没有切换完成',
        ],
      }
    }
    const notes: string[] = []
    if (switchedBeforeReply) {
      // 回复经隧道回到控制台要时间：先看到「已切」不等于切在 turn 中间。真切在中间的话那一轮会失败。
      notes.push(
        '观察到切换完成时控制台还没收到回复（链路延迟；回复最终是 done 才算数）',
      )
    }
    if (final.reply.state === 'failed')
      return { kind: 'turn-failed', detail: ['在途那一轮失败了', ...notes] }
    if (!sawWaiting) {
      // 两种可能分不开：这一轮在下发落地之前刚好跑完（正常），或者节点没等空闲就切了（缺陷）。
      // 先看到「已切」而回复还没到，偏向后者，记成 no-wait-suspect；都按「不确定」重试。
      return {
        kind: switchedBeforeReply ? 'no-wait-suspect' : 'inconclusive',
        detail: [
          '没观察到节点「等在途」（pending.waitingTurns ≥ 1）',
          ...notes,
        ],
      }
    }
    const a = final.view.actual
    const g1 = a?.resident?.generation ?? null
    moment.generationAfter = g1
    if (g0 === null || g1 === null || g1 <= g0) {
      return {
        kind: 'not-switched',
        detail: [
          `generation ${String(g0)} → ${String(g1)}，没有前进`,
          ...notes,
        ],
      }
    }
    if (a === null || a.loadedHash !== a.appliedHash) {
      return {
        kind: 'not-switched',
        detail: ['切换后 loaded 与 applied 不一致', ...notes],
      }
    }
    return {
      kind: 'pass',
      detail: [
        `等了在途 ${String(moment.waitingTurns)} 轮；回复 done；generation ${g0} → ${g1}`,
        ...notes,
      ],
    }
  }

  async #assignment(node: string): Promise<ProviderAssignment | null> {
    const base = this.#baseline.get(node)
    if (base !== undefined) return base.assignment
    const reply = await this.#api(
      'GET',
      `/v0/providers/nodes/${encodeURIComponent(node)}`,
    )
    return reply.status === 200 && isRecord(reply.json)
      ? ((reply.json as unknown as ProviderNodeView).assignment ?? null)
      : null
  }

  async #profile(id: string): Promise<ProviderProfileView | null> {
    const reply = await this.#api(
      'GET',
      `/v0/providers/profiles/${encodeURIComponent(id)}`,
    )
    return reply.status === 200 && isRecord(reply.json)
      ? (reply.json as unknown as ProviderProfileView)
      : null
  }

  /** 改指派 → 下发 → 等到 applied 是 `profileId`、无 pending、loaded = applied、effective 的模型对上。 */
  async #switchTo(
    node: string,
    assignment: ProviderAssignment,
    profileId: string,
    model: string | null,
    tag: string,
  ): Promise<{ ok: boolean; detail: string[] }> {
    const moment: Record<string, unknown> = {
      item: tag,
      node,
      to: profileId,
      startedAt: new Date().toISOString(),
    }
    this.#moments.push(moment)
    const assigned = await this.#api(
      'PUT',
      `/v0/providers/nodes/${encodeURIComponent(node)}/assignment`,
      assignment,
    )
    if (assigned.status !== 200)
      return {
        ok: false,
        detail: [`改指派：${errorOf(assigned, this.#redactor)}`],
      }
    const applied = await this.#api('POST', '/v0/providers/apply', {
      nodes: [node],
    })
    const results =
      isRecord(applied.json) && Array.isArray(applied.json.results)
        ? (applied.json.results as ProviderApplyResult[])
        : []
    const result = results[0]
    if (
      applied.status !== 200 ||
      result === undefined ||
      result.outcome !== 'ok'
    ) {
      return {
        ok: false,
        detail: [
          `下发：${result === undefined ? errorOf(applied, this.#redactor) : this.#redactor.free(`${result.outcome} ${result.code ?? ''} ${result.message}`)}`,
        ],
      }
    }
    moment.requestId = result.requestId
    moment.sessions = result.sessions ?? null
    const done = await this.#until(
      this.#cfg.timing.switchTimeoutMs,
      async () => {
        const { view } = await this.#refresh(node)
        const a = view?.actual
        if (view == null || a == null) return null
        return a.pending === null &&
          a.applied?.requestId === result.requestId &&
          a.loadedHash === a.appliedHash
          ? view
          : null
      },
    )
    moment.finishedAt = new Date().toISOString()
    if (done === null)
      return {
        ok: false,
        detail: [
          `${this.#cfg.timing.switchTimeoutMs} ms 内没有切到 ${profileId}`,
        ],
      }
    const problems: string[] = []
    const a = done.actual
    if (a?.applied?.profileId !== profileId)
      problems.push(
        `applied 是 ${a?.applied?.profileId ?? '?'}，不是 ${profileId}`,
      )
    if (done.drift.length > 0)
      problems.push(`漂移：${done.drift.map(d => d.kind).join('、')}`)
    const effective = a?.effective
    if (model !== null) {
      if (effective === undefined) problems.push('节点没报 effective')
      else if (effective.model !== model && effective.wireModel !== model) {
        problems.push(`effective 模型是 ${effective.model}，不是 ${model}`)
      }
    }
    if (a?.resident?.running !== true) problems.push('resident 没在跑')
    return problems.length > 0
      ? { ok: false, detail: problems }
      : {
          ok: true,
          detail: [
            `已切到 ${profileId}（${model ?? '模型未核'}）${result.sessions === 'reset' ? '；这次切换重置了该节点的会话（换了线路或主机）' : ''}`,
          ],
        }
  }

  async #a3(): Promise<Omit<Item, 'id' | 'title'>> {
    const node = this.#cfg.switch.node
    const to = this.#cfg.switch.profileId
    const from = this.#cfg.nodes[node]?.profileId ?? ''
    const original = await this.#assignment(node)
    if (original === null)
      return {
        status: 'FAIL',
        class: 'switch',
        detail: ['读不到这个节点原来的指派'],
      }
    const toModel = mainModelOf(await this.#profile(to))
    const fromModel = mainModelOf(await this.#profile(from))
    if (toModel === null)
      return {
        status: 'FAIL',
        class: 'switch',
        detail: [`读不到档案 ${to} 的主模型`],
      }
    const there = await this.#switchTo(
      node,
      { mode: 'profile', profileId: to },
      to,
      toModel,
      'A3-there',
    )
    const back = await this.#switchTo(
      node,
      original,
      from,
      fromModel,
      'A3-back',
    )
    const detail = [
      `去：${there.detail.join('；')}`,
      `回：${back.detail.join('；')}`,
    ]
    return there.ok && back.ok
      ? { status: 'PASS', detail }
      : { status: 'FAIL', class: 'switch', detail }
  }

  async #canaryFlow(): Promise<{ problems: string[]; notes: string[] }> {
    const problems: string[] = []
    const notes: string[] = []
    const [c1, c2, c3] = this.#canaries as [string, string, string]
    const node = this.#cfg.canary.node
    const id = `qm-canary-${randomBytes(4).toString('hex')}`
    const model = CANARY_MODEL
    let revision: number | null = null
    let deleted = false
    try {
      const created = await this.#api('POST', '/v0/providers/profiles', {
        presetId: CANARY_PRESET,
        profile: canaryProfileEdit(id, this.#cfg.canary.baseUrl),
        secrets: { k1: c1, k2: c2 },
      })
      const profile =
        isRecord(created.json) && isRecord(created.json.profile)
          ? created.json.profile
          : null
      if (
        created.status !== 200 ||
        profile === null ||
        typeof profile.revision !== 'number'
      ) {
        problems.push(`存金丝雀档案：${errorOf(created, this.#redactor)}`)
        return { problems, notes }
      }
      revision = profile.revision
      notes.push(`金丝雀档案 ${id} 已存（两把 key）`)

      for (const path of [
        '/providers',
        `/providers/profiles/${id}`,
        `/providers/nodes/${node}`,
      ]) {
        const page = await this.#api('GET', path, undefined, true)
        if (page.status !== 200)
          problems.push(`页面 ${path}：${errorOf(page, this.#redactor)}`)
      }
      await this.#api('GET', '/v0/providers')
      await this.#api('GET', `/v0/providers/profiles/${id}`)

      const probe1 = await this.#probe(node, 'auth', id)
      notes.push(
        `金丝雀测连：${probe1.result === null ? (probe1.error ?? '') : this.#probeLine(node, probe1.result)}`,
      )
      const dry = await this.#api('POST', '/v0/providers/apply', {
        nodes: [node],
        dryRun: true,
        profileId: id,
      })
      const dryResult =
        isRecord(dry.json) && Array.isArray(dry.json.results)
          ? (dry.json.results[0] as ProviderApplyResult | undefined)
          : undefined
      // 要 ok：中枢在发出之前就拒绝（缺密钥、会话策略、校验）时，金丝雀根本没有走到节点，
      // 这一轮的 AC-P2 就少扫了最要紧的那一段。
      if (dryResult === undefined || dryResult.outcome !== 'ok') {
        problems.push(
          `dry-run 下发没有走通，金丝雀没有到节点的编译路径：${dryResult === undefined ? errorOf(dry, this.#redactor) : this.#redactor.free(`${dryResult.outcome} ${dryResult.code ?? ''} ${dryResult.message}`)}`,
        )
      } else {
        notes.push(
          `dry-run 下发：${dryResult.outcome}${dryResult.code === undefined ? '' : ` ${dryResult.code}`}`,
        )
      }

      if (this.#cfg.canary.realApply) {
        const original = await this.#assignment(node)
        const from = this.#cfg.nodes[node]?.profileId ?? ''
        const fromModel = mainModelOf(await this.#profile(from))
        const there = await this.#switchTo(
          node,
          { mode: 'profile', profileId: id },
          id,
          model,
          'A5-canary-there',
        )
        if (!there.ok) problems.push(`金丝雀真下发：${there.detail.join('；')}`)
        const probe = await this.#probe(node, 'auth', id)
        notes.push(
          `真下发后测连：${probe.result === null ? (probe.error ?? '') : this.#probeLine(node, probe.result)}`,
        )
        const back =
          original === null
            ? { ok: false, detail: ['读不到原指派'] }
            : await this.#switchTo(
                node,
                original,
                from,
                fromModel,
                'A5-canary-back',
              )
        if (!back.ok)
          problems.push(`金丝雀真下发后切回：${back.detail.join('；')}`)
        else notes.push('金丝雀真下发并切回')
      } else {
        notes.push(
          '金丝雀没有真下发（canary.realApply=false）：真写入路径由本机真 key 扫描覆盖',
        )
      }

      const exported = await this.#api(
        'GET',
        '/v0/providers/export',
        undefined,
        true,
      )
      if (exported.status !== 200)
        problems.push(`导出：${errorOf(exported, this.#redactor)}`)

      const rotated = await this.#api(
        'PUT',
        `/v0/providers/profiles/${id}/keys/k1`,
        { value: c3, ifMatch: revision },
      )
      const rotatedProfile =
        isRecord(rotated.json) && isRecord(rotated.json.profile)
          ? rotated.json.profile
          : null
      if (
        rotated.status !== 200 ||
        rotatedProfile === null ||
        typeof rotatedProfile.revision !== 'number'
      ) {
        problems.push(`轮换 k1：${errorOf(rotated, this.#redactor)}`)
      } else {
        revision = rotatedProfile.revision
        const probe2 = await this.#probe(node, 'auth', id)
        notes.push(
          `轮换后测连：${probe2.result === null ? (probe2.error ?? '') : this.#probeLine(node, probe2.result)}`,
        )
      }

      const removed = await this.#api(
        'DELETE',
        `/v0/providers/profiles/${id}`,
        { ifMatch: revision },
      )
      if (removed.status !== 200)
        problems.push(`删除金丝雀档案：${errorOf(removed, this.#redactor)}`)
      const gone = await this.#api('GET', `/v0/providers/profiles/${id}`)
      deleted = gone.status === 404
      if (!deleted) problems.push(`删除之后档案还在（HTTP ${gone.status}）`)
    } finally {
      if (!deleted && revision !== null) {
        const left = await this.#profile(id)
        if (left !== null) {
          const cleanup = await this.#api(
            'DELETE',
            `/v0/providers/profiles/${id}`,
            { ifMatch: left.revision },
          )
          notes.push(`收尾删除金丝雀档案：HTTP ${cleanup.status}`)
        }
      }
    }
    return { problems, notes }
  }

  #judgeScans(
    scans: Readonly<Record<string, ScanResult | null>>,
    flow: { problems: string[]; notes: string[] },
  ): Omit<Item, 'id' | 'title'> {
    const problems = [...flow.problems]
    const leaks: string[] = [
      ...this.#pageHits.map(hit => `运维本机看到的响应里有 ${hit}`),
    ]
    let realLeak = false
    let control = false
    for (const [machine, scan] of Object.entries(scans)) {
      if (scan === null) {
        problems.push(`${machine}：扫描器没有结果`)
        control = true
        continue
      }
      if (!scan.selfTest) {
        problems.push(`${machine}：扫描器自检失败`)
        control = true
      }
      if (scan.samples < 1) {
        problems.push(`${machine}：ps 一次都没采到`)
        control = true
      }
      if (scan.files.scanned < 1) {
        problems.push(`${machine}：一个文件都没扫到`)
        control = true
      }
      for (const [label, count] of Object.entries(scan.ps)) {
        leaks.push(`${machine}：ps 采样里 ${label} ×${count}`)
        if (label.startsWith('real-')) realLeak = true
      }
      for (const hit of scan.hits) {
        leaks.push(`${machine}：${hit.path} 里 ${hit.label} ×${hit.count}`)
        if (hit.label.startsWith('real-')) realLeak = true
      }
      for (const label of scan.needles.realLabels) {
        if (!scan.holders.some(holder => holder.label === label)) {
          problems.push(
            `${machine}：真 key ${label} 在持有点里一次都没命中（针不对？）`,
          )
          control = true
        }
      }
      flow.notes.push(
        `${machine}：针 金丝雀 ${scan.needles.canary} / 本机真 key ${scan.needles.real}；ps 采样 ${scan.samples} 次；扫文件 ${scan.files.scanned} 个（${scan.files.bytes} 字节，跳过超大 ${scan.files.skippedLarge}，不扫 ${scan.files.excluded.join(' ')}）`,
      )
    }
    const detail = [...leaks, ...problems, ...flow.notes]
    if (leaks.length > 0) {
      return {
        status: 'FAIL',
        class: realLeak ? 'real-key-leak' : 'canary-leak',
        detail,
      }
    }
    if (problems.length > 0) {
      return {
        status: 'FAIL',
        class: control ? 'control' : 'canary-flow',
        detail,
      }
    }
    return { status: 'PASS', detail: ['零命中', ...flow.notes] }
  }

  #scanArgs(name: string): string {
    const nodes = Object.entries(this.#cfg.nodes)
      .filter(([, value]) => value.machine === name)
      .map(([node]) => node)
    return [
      'scan',
      ...(nodes.length === 0 ? [] : [`--nodes ${nodes.join(',')}`]),
      ...(name === this.#cfg.hub ? ['--console'] : []),
    ].join(' ')
  }

  async #d1(): Promise<Omit<Item, 'id' | 'title'>> {
    const facts = await this.#facts()
    this.#evidence.raw('facts-end', facts)
    const end = deploymentOf(this.#cfg, facts)
    const start = this.#deployment
    const problems: string[] = []
    if (start === null || start.fingerprint === null)
      problems.push('开始时没有部署指纹')
    else if (end.fingerprint !== start.fingerprint)
      problems.push('部署指纹变了（轮内换过产物）')
    for (const [name, p] of Object.entries(end.processes)) {
      const was = start?.processes[name]
      if (was === undefined) continue
      if (was.pid !== p.pid || was.startedAt !== p.startedAt) {
        problems.push(
          `${name} 轮内重启过：pid ${String(was.pid)} → ${String(p.pid)}`,
        )
      }
    }
    for (const [node, { machine }] of Object.entries(this.#cfg.nodes)) {
      if (facts[machine]?.nodes[node]?.alive !== true)
        problems.push(`${node}：结束时 resident 不在`)
    }
    if (facts[this.#cfg.hub]?.console?.alive !== true)
      problems.push('结束时控制台不在')
    return problems.length > 0
      ? { status: 'FAIL', class: 'deployment-changed', detail: problems }
      : {
          status: 'PASS',
          detail: ['部署指纹与每个进程的 pid / 启动时刻都同开始时'],
        }
  }

  async run(): Promise<{ verdict: Verdict; code: number }> {
    const startedAt = new Date().toISOString()
    const p0 = await this.#step('P0', async () => {
      const file = this.#cfg.console.credentialFile
      let st: ReturnType<typeof statSync>
      try {
        st = statSync(file)
      } catch {
        return {
          status: 'FAIL',
          class: 'credential',
          detail: [`读不到凭据文件 ${file}`],
        }
      }
      if ((st.mode & 0o077) !== 0) {
        return {
          status: 'FAIL',
          class: 'credential',
          detail: [`凭据文件 ${file} 权限太宽（要 0600）`],
        }
      }
      const value = readFileSync(file, 'utf8').trim()
      if (value === '' || /\s/.test(value)) {
        return {
          status: 'FAIL',
          class: 'credential',
          detail: ['凭据文件不是一行 token'],
        }
      }
      this.#redactor.add(value, 'ops-credential')
      this.#client = new ConsoleClient(
        this.#cfg.console.url,
        value,
        this.#cfg.timing,
        this.#evidence,
        (where, text) => {
          for (const label of this.#redactor.labelsIn(text))
            this.#pageHits.push(`${where} → ${label}`)
        },
      )
      return await this.#p0()
    })

    if (p0.status === 'PASS') {
      await this.#step('D0', () => this.#d0())
      await this.#step('W1', () => this.#w1())
      await this.#step('A1', () => this.#a1('A1'))
      await this.#step('A2', () => this.#a2())
      await this.#step('A4', () => this.#a4())

      const scans: Record<string, ScanHandle> = {}
      const scanStart: string[] = []
      if (!this.#held && !this.#holdRequested()) {
        await Promise.all(
          Object.entries(this.#cfg.machines).map(async ([name, machine]) => {
            const handle = await this.#remote.scan(
              machine,
              this.#scanArgs(name),
              this.#canaries,
            )
            scans[name] = handle
            if (!handle.started) scanStart.push(`${name}：扫描器没起来`)
          }),
        )
      }
      await this.#step('A6', () => this.#a6())
      await this.#step('A3', () => this.#a3())
      await this.#step('A5', async () => {
        const flow = await this.#canaryFlow()
        const results: Record<string, ScanResult | null> = {}
        await Promise.all(
          Object.entries(scans).map(async ([name, handle]) => {
            results[name] = await handle.stop()
          }),
        )
        this.#evidence.raw('scans', results)
        flow.problems.unshift(...scanStart)
        flow.notes.push(
          `realApply=${String(this.#cfg.canary.realApply === true)}`,
        )
        return this.#judgeScans(results, flow)
      })
      // A5 被 HOLD 跳过时扫描器还开着：关掉，不判。
      await Promise.all(
        Object.values(scans).map(handle => handle.stop().catch(() => null)),
      )
      await this.#step('A1b', () => this.#a1('A1b'))
      await this.#step('D1', () => this.#d1())
    } else {
      for (const { id, title } of ITEMS.slice(1)) {
        this.#push({ id, title, status: 'SKIPPED', detail: ['P0 没过'] })
      }
    }

    const red = this.#items
      .filter(item => item.status === 'FAIL')
      .map(item => item.id)
    const held = this.#held
    const verdict: Verdict = {
      v: 1,
      label:
        this.#evidence.dir
          .split('/')
          .pop()
          ?.replace(/^round-/, '') ?? '',
      startedAt,
      finishedAt: new Date().toISOString(),
      green:
        !held &&
        red.length === 0 &&
        this.#items.every(item => item.status !== 'SKIPPED'),
      held,
      red,
      items: this.#items,
      deployment: this.#deployment,
      moments: this.#moments,
      retries: this.#countRetries(),
      scope: {
        hub: this.#cfg.hub,
        nodes: Object.keys(this.#cfg.nodes),
        switch: this.#cfg.switch,
        call: this.#cfg.call,
        inflight: {
          target: this.#cfg.inflight.target,
          attempts: this.#cfg.inflight.attempts ?? 3,
        },
        canary: {
          node: this.#cfg.canary.node,
          realApply: this.#cfg.canary.realApply === true,
        },
      },
    }
    this.#evidence.write('verdict.json', verdict)
    this.#evidence.write('deployment.json', this.#deployment)
    this.#evidence.writeText('verdict.md', renderVerdict(verdict))
    const code = held ? EXIT.held : verdict.green ? EXIT.green : EXIT.red
    return { verdict, code }
  }

  #countRetries(): number {
    const file = join(this.#evidence.dir, 'retries.ndjson')
    if (!existsSync(file)) return 0
    return readFileSync(file, 'utf8')
      .split('\n')
      .filter(line => line !== '').length
  }
}

export function renderVerdict(verdict: Verdict): string {
  const lines = [
    `# 模型服务真机验收 · 第 ${verdict.label} 轮`,
    '',
    `- 结论：**${verdict.held ? 'HOLD（中途叫停）' : verdict.green ? '零红' : `红 ${verdict.red.length} 项：${verdict.red.join('、')}`}**`,
    `- 时间：${verdict.startedAt} → ${verdict.finishedAt}`,
    `- sourceCommit：${verdict.deployment?.sourceCommit ?? '（未取得）'}`,
    `- 部署指纹：${verdict.deployment?.fingerprint ?? '（未取得）'}`,
    `- 过程重试：${verdict.retries} 次（见 retries.ndjson）`,
    '',
    '| 项 | 结果 | 种类 | 说明 |',
    '| --- | --- | --- | --- |',
    ...verdict.items.map(
      item =>
        `| ${item.id} ${item.title} | ${item.status} | ${item.class ?? ''} | ${item.detail.join('<br>').replace(/\|/g, '\\|')} |`,
    ),
    '',
  ]
  return `${lines.join('\n')}\n`
}

// ── compare ───────────────────────────────────────────────────────────────────

export interface Pair {
  readonly v: 1
  readonly a: string
  readonly b: string
  readonly ok: boolean
  readonly checks: Record<string, boolean>
  readonly problems: readonly string[]
  /** 两轮之间重启过的进程（不判红：重启 ≠ 换部署）。 */
  readonly restarts: readonly string[]
}

function readVerdict(dir: string): Verdict | null {
  try {
    const parsed = JSON.parse(
      readFileSync(join(dir, 'verdict.json'), 'utf8'),
    ) as unknown
    return isRecord(parsed) && parsed.v === 1
      ? (parsed as unknown as Verdict)
      : null
  } catch {
    return null
  }
}

export function compareRounds(
  dirA: string,
  dirB: string,
  minGapMinutes = 0,
): Pair {
  const a = readVerdict(dirA)
  const b = readVerdict(dirB)
  const problems: string[] = []
  const checks: Record<string, boolean> = {}
  if (a === null || b === null) {
    problems.push(`读不到 verdict.json：${a === null ? dirA : dirB}`)
    return { v: 1, a: dirA, b: dirB, ok: false, checks, problems, restarts: [] }
  }
  checks.bothGreen = a.green && b.green
  if (!a.green) problems.push(`第 ${a.label} 轮不是零红`)
  if (!b.green) problems.push(`第 ${b.label} 轮不是零红`)
  const fa = a.deployment?.fingerprint ?? null
  const fb = b.deployment?.fingerprint ?? null
  checks.sameDeployment = fa !== null && fa === fb
  if (!checks.sameDeployment)
    problems.push('两轮不是同一份部署（部署指纹不同或缺）')
  const gapMs = Date.parse(b.startedAt) - Date.parse(a.finishedAt)
  checks.ordered = Number.isFinite(gapMs) && gapMs >= minGapMinutes * 60_000
  if (!checks.ordered)
    problems.push(
      `第二轮要在第一轮结束${minGapMinutes > 0 ? ` ${minGapMinutes} 分钟` : ''}之后开始`,
    )
  const between: string[] = []
  const parent = dirname(resolve(dirB))
  try {
    for (const name of readdirSync(parent)) {
      if (!name.startsWith('round-')) continue
      const dir = join(parent, name)
      if (resolve(dir) === resolve(dirA) || resolve(dir) === resolve(dirB))
        continue
      const other = readVerdict(dir)
      if (other === null) continue
      const t = Date.parse(other.startedAt)
      if (t > Date.parse(a.startedAt) && t < Date.parse(b.startedAt))
        between.push(other.label)
    }
  } catch {
    // 读不了目录就不判「连续」，下面照实写。
  }
  checks.consecutive = between.length === 0
  if (!checks.consecutive)
    problems.push(`两轮之间还跑过：${between.join('、')}（不连续）`)
  const restarts: string[] = []
  for (const [name, p] of Object.entries(b.deployment?.processes ?? {})) {
    const was = a.deployment?.processes[name]
    if (
      was !== undefined &&
      (was.pid !== p.pid || was.startedAt !== p.startedAt)
    ) {
      restarts.push(`${name}：pid ${String(was.pid)} → ${String(p.pid)}`)
    }
  }
  return {
    v: 1,
    a: a.label,
    b: b.label,
    ok: problems.length === 0,
    checks,
    problems,
    restarts,
  }
}

// ── 入口 ──────────────────────────────────────────────────────────────────────

function usage(): never {
  process.stderr.write(
    [
      '用法：',
      '  provider-acceptance.ts round --config <轮配置.json> --out <证据目录> [--label <名>]',
      '  provider-acceptance.ts compare <轮 A 目录> <轮 B 目录> [--min-gap-minutes N]',
      '',
    ].join('\n'),
  )
  process.exit(EXIT.config)
}

function stamp(): string {
  return new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z')
}

function inside(child: string, parent: string): boolean {
  return child === parent || child.startsWith(`${parent}/`)
}

/** 证据目录：私有（0700）、不在仓库里。不合格抛 ConfigError。 */
export function prepareOutDir(out: string): string {
  const abs = resolve(out)
  if (!existsSync(abs)) mkdirSync(abs, { recursive: true, mode: 0o700 })
  const real = realpathSync(abs)
  if (inside(real, realpathSync(REPOSITORY_ROOT))) {
    throw new ConfigError(`证据目录不能在仓库里：${real}`)
  }
  if ((statSync(real).mode & 0o077) !== 0) {
    throw new ConfigError(`证据目录必须是私有的（0700）：${real}`)
  }
  return real
}

export async function main(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv
  if (command === 'compare') {
    const dirs: string[] = []
    let gap = 0
    for (let i = 0; i < rest.length; i += 1) {
      const arg = rest[i] ?? ''
      if (arg === '--min-gap-minutes') {
        gap = Number(rest[i + 1])
        i += 1
      } else {
        dirs.push(arg)
      }
    }
    if (dirs.length !== 2 || !Number.isFinite(gap) || gap < 0) usage()
    const [dirA, dirB] = dirs as [string, string]
    const pair = compareRounds(dirA, dirB, gap)
    const target = join(dirname(resolve(dirB)), `pair-${pair.a}-${pair.b}.json`)
    writeFileSync(target, `${JSON.stringify(pair, null, 2)}\n`, { mode: 0o600 })
    process.stdout.write(`${pair.ok ? '两轮通过' : '两轮不通过'}：${target}\n`)
    for (const problem of pair.problems)
      process.stdout.write(`  · ${problem}\n`)
    return pair.ok ? EXIT.green : EXIT.red
  }
  if (command !== 'round') usage()
  let configPath = ''
  let out = ''
  let label = stamp()
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i]
    const value = rest[i + 1] ?? ''
    if (arg === '--config') configPath = value
    else if (arg === '--out') out = value
    else if (arg === '--label') label = value
    else usage()
    i += 1
  }
  if (configPath === '' || out === '') usage()
  let config: RoundConfig
  let outDir: string
  try {
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(label))
      throw new ConfigError(`--label 只许 A-Z a-z 0-9 . _ -：${label}`)
    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(configPath, 'utf8')) as unknown
    } catch {
      throw new ConfigError(`读不了配置：${configPath}`)
    }
    config = parseConfig(raw)
    outDir = prepareOutDir(out)
    if (existsSync(join(outDir, `round-${label}`))) {
      throw new ConfigError(
        `这一轮的目录已经在了：round-${label}（每轮一个新标签）`,
      )
    }
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`配置错：${error.message}\n`)
      return EXIT.config
    }
    throw error
  }
  if (existsSync(join(outDir, 'HOLD'))) {
    process.stderr.write(`HOLD：${join(outDir, 'HOLD')} 在，不开始\n`)
    return EXIT.held
  }
  const round = new Round({ config, outDir, label })
  const { verdict, code } = await round.run()
  process.stdout.write(
    `${verdict.held ? 'HOLD' : verdict.green ? '零红' : `红：${verdict.red.join('、')}`} → ${round.evidence.dir}\n`,
  )
  return code
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)))
}
