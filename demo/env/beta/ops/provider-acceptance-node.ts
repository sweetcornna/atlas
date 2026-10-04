// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 每轮真机验收（AC-P6，`providers-console-m1.md` §8.4，P18.13）在**中枢与节点机器上**
 * 的那一半。运维本机的 `provider-acceptance.ts` 经 ssh 起它：
 *
 *   bun provider-acceptance-node.ts facts --tree <部署根> [--root <内测根>] [--nodes a,b] [--console]
 *   bun provider-acceptance-node.ts scan  [--root <内测根>] [--nodes a,b] [--console]   # stdin 见下
 *
 * **只用 node 内建模块**：舰队上的部署树只有 `dist/` 与 `demo/`（`beta-deploy.sh --only dist,demo`），
 * 没有 `src/`、没有 `node_modules`。于是 `SECRET_ENV_KEYS` 在这里抄一份，用例钉住它与
 * `src/services/qianmo/providers/whitelist.ts` 逐项一致。
 *
 * ## facts
 *
 * 一行 JSON：部署树里 `dist/cli-node.js` 的 sha256 与 ctime（装进去的时刻）、控制台与各节点
 * 进程的 pid / 活着没有 / 启动时刻、启动横幅里**白名单**内的几项。控制台横幅的 `open`、
 * `view-token`、`admin-token` 行可能带 token 值，所以从不整段转述：只取 `chat`、`providers`、
 * `accounts`、`sourceCommit`。节点横幅（`logs/<节点>.out` 首行 JSON）只取 `node`、
 * `sourceCommit`、`trusts`、`localCommandsFrom`。
 *
 * ## scan
 *
 * stdin 第一行 `{"canaries":[…],"psIntervalMs":100}`。针有两种：
 *   · 金丝雀：运维本机这一轮现生成的，经 ssh 的 stdin 送来，只在本进程内存里；
 *   · 本机真 key：这台机器上每个节点 `settings.json` 里 SECRET_ENV_KEYS 的值，加
 *     `qianmo/provider/key-pool.json` 的 `keys[].value`（P18.18）。**不跨机器传。**
 * 先自检（每根针在合成缓冲里恰好命中一次），打一行 `{"ready":true,…}`；然后每 `psIntervalMs`
 * 采样一次 `ps -eo args`，直到 stdin 来一行 `stop`（或关掉）；最后扫文件，打一行结果。
 *
 * 扫的是内测根下的一切，除了：`secrets/`（本来就是密钥的家，整个不读）、`backups/`（归档）、
 * `workspaces/`（agent 的工作区，AC-P2 的清单里没有它），以及明文**持有点**——节点配置根的
 * `settings.json`、`qianmo/provider/pending.json`、`qianmo/provider/key-pool.json`，控制台
 * 配置根的 `qianmo/console/provider-secrets.json`（那是密文，排除是 §8.3 的原话）。持有点照样
 * 读，但命中记进 `holders` 而不是 `hits`：真 key 必须在持有点里命中，这是「针是对的」的正向对照。
 * 不跟软链。
 *
 * **输出里永远没有针的值**：只有标签（`canary-1`、`real-<节点>-<序号>`）、路径与次数。
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** `src/services/qianmo/providers/whitelist.ts` 的 SECRET_ENV_KEYS（用例钉住两边一致）。 */
export const SECRET_ENV_KEYS: readonly string[] = [
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'GROK_API_KEY',
  'XAI_API_KEY',
  'OPENCODE_API_KEY',
]

/** 控制台横幅里允许转述的字段。其余（尤其 token 那几行）一律不碰。 */
const CONSOLE_BANNER_FIELDS = ['chat', 'providers', 'accounts', 'sourceCommit']

/** 内测根下不扫的顶层目录。 */
export const EXCLUDED_TOP = ['secrets', 'backups', 'workspaces'] as const

/** 节点配置根里的明文持有点（相对配置根）。 */
const NODE_HOLDERS = [
  'settings.json',
  'qianmo/provider/pending.json',
  'qianmo/provider/key-pool.json',
]
const CONSOLE_HOLDERS = ['qianmo/console/provider-secrets.json']

/** 单个文件超过它就跳过并计数（日志轮转之前不会到这个量级）。 */
const MAX_FILE_BYTES = 512 * 1024 * 1024
const CHUNK_BYTES = 1024 * 1024
/** 真 key 至少这么长才当针：短串会在任何地方撞上。 */
const MIN_NEEDLE_LENGTH = 8

export interface ProcessFacts {
  readonly pid: number | null
  readonly alive: boolean
  /** `ps -o lstart=` 换成 ISO；换不了时原样。 */
  readonly startedAt: string | null
}

export interface NodeBanner {
  readonly node: string | null
  readonly sourceCommit: string | null
  readonly trusts: readonly string[]
  readonly localCommandsFrom: readonly string[]
}

export interface MachineFacts {
  readonly v: 1
  readonly root: string
  readonly tree: {
    readonly path: string
    readonly cliSha256: string | null
    readonly cliCtime: string | null
  }
  readonly console:
    | (ProcessFacts & { readonly banner: Record<string, string> | null })
    | null
  readonly nodes: Record<
    string,
    ProcessFacts & { readonly banner: NodeBanner | null }
  >
}

export interface Needle {
  readonly label: string
  readonly bytes: Buffer
}

export interface PathHit {
  readonly path: string
  readonly label: string
  readonly count: number
}

export interface ScanResult {
  readonly v: 1
  readonly done: true
  readonly selfTest: boolean
  readonly samples: number
  /** 每根针在 ps 采样里命中的总次数（只有非零的）。 */
  readonly ps: Record<string, number>
  readonly files: {
    readonly scanned: number
    readonly bytes: number
    readonly skippedLarge: number
    readonly excluded: readonly string[]
  }
  readonly hits: readonly PathHit[]
  readonly holders: readonly PathHit[]
  readonly needles: {
    readonly canary: number
    readonly real: number
    readonly realLabels: readonly string[]
  }
}

// ── 小工具 ────────────────────────────────────────────────────────────────────

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

function readJson(path: string): unknown {
  const text = readText(path)
  if (text === null) return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : []
}

// ── facts ─────────────────────────────────────────────────────────────────────

/** 控制台横幅：`<名字补到 13 列><值>`，只取白名单字段。 */
export function parseConsoleBanner(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const match = /^(\S+)\s+(.*)$/.exec(line)
    if (match === null) continue
    const [, name, value] = match
    if (name === undefined || value === undefined) continue
    if (!CONSOLE_BANNER_FIELDS.includes(name) || name in out) continue
    out[name] = value.trimEnd()
    if (name === 'sourceCommit') break
  }
  return out
}

/** 节点横幅：`logs/<节点>.out` 的首行 JSON，只取四项。 */
export function parseNodeBanner(text: string): NodeBanner | null {
  const first = text.split('\n', 1)[0] ?? ''
  let parsed: unknown
  try {
    parsed = JSON.parse(first) as unknown
  } catch {
    return null
  }
  if (!isRecord(parsed)) return null
  return {
    node: typeof parsed.node === 'string' ? parsed.node : null,
    sourceCommit:
      typeof parsed.sourceCommit === 'string' ? parsed.sourceCommit : null,
    trusts: stringList(parsed.trusts),
    localCommandsFrom: stringList(parsed.localCommandsFrom),
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM：进程在，只是不归我们管。
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function startedAt(pid: number): string | null {
  try {
    const raw = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    if (raw === '') return null
    const ms = Date.parse(raw)
    return Number.isNaN(ms) ? raw : new Date(ms).toISOString()
  } catch {
    return null
  }
}

function processFacts(root: string, name: string): ProcessFacts {
  const raw = readText(join(root, 'run', `${name}.pid`))?.trim() ?? ''
  const pid = /^[0-9]+$/.test(raw) ? Number(raw) : null
  if (pid === null) return { pid: null, alive: false, startedAt: null }
  const up = alive(pid)
  return { pid, alive: up, startedAt: up ? startedAt(pid) : null }
}

function fileSha256(path: string): string | null {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex')
  } catch {
    return null
  }
}

export function collectFacts(options: {
  readonly root: string
  readonly tree: string
  readonly nodes: readonly string[]
  readonly console: boolean
}): MachineFacts {
  const { root, tree } = options
  const cli = join(tree, 'dist', 'cli-node.js')
  let cliCtime: string | null = null
  try {
    cliCtime = new Date(statSync(cli).ctimeMs).toISOString()
  } catch {
    cliCtime = null
  }
  const nodes: MachineFacts['nodes'] = {}
  for (const node of options.nodes) {
    const banner = readText(join(root, 'logs', `${node}.out`))
    nodes[node] = {
      ...processFacts(root, node),
      banner: banner === null ? null : parseNodeBanner(banner),
    }
  }
  let consoleFacts: MachineFacts['console'] = null
  if (options.console) {
    const banner = readText(join(root, 'logs', 'console.out'))
    consoleFacts = {
      ...processFacts(root, 'console'),
      banner: banner === null ? null : parseConsoleBanner(banner),
    }
  }
  return {
    v: 1,
    root,
    tree: { path: tree, cliSha256: fileSha256(cli), cliCtime },
    console: consoleFacts,
    nodes,
  }
}

// ── scan ──────────────────────────────────────────────────────────────────────

/** 这台机器上各节点持有的真 key，按值去重；标签 `real-<节点>-<序号>`。 */
export function realKeyNeedles(
  root: string,
  nodes: readonly string[],
): Needle[] {
  const seen = new Set<string>()
  const out: Needle[] = []
  for (const node of nodes) {
    const config = join(root, 'nodes', node, 'config')
    const values: string[] = []
    const settings = readJson(join(config, 'settings.json'))
    if (isRecord(settings) && isRecord(settings.env)) {
      for (const key of SECRET_ENV_KEYS) {
        const value = settings.env[key]
        if (typeof value === 'string') values.push(value)
      }
    }
    const pool = readJson(join(config, 'qianmo', 'provider', 'key-pool.json'))
    if (isRecord(pool) && Array.isArray(pool.keys)) {
      for (const entry of pool.keys) {
        if (isRecord(entry) && typeof entry.value === 'string') {
          values.push(entry.value)
        }
      }
    }
    for (const value of values) {
      if (value.length < MIN_NEEDLE_LENGTH || seen.has(value)) continue
      seen.add(value)
      out.push({
        label: `real-${node}-${out.length + 1}`,
        bytes: Buffer.from(value, 'utf8'),
      })
    }
  }
  return out
}

function countIn(haystack: Buffer, needle: Buffer, from: number): number {
  let count = 0
  let at = haystack.indexOf(needle, 0)
  while (at !== -1) {
    // 整段落在上一块的尾巴里的，上一块已经数过了。
    if (at + needle.length > from) count += 1
    at = haystack.indexOf(needle, at + 1)
  }
  return count
}

/** 一个文件里每根针的次数（分块读，块间留 `最长针 - 1` 字节的尾巴）。 */
export function countFile(
  path: string,
  needles: readonly Needle[],
): Map<string, number> {
  const counts = new Map<string, number>()
  if (needles.length === 0) return counts
  const longest = Math.max(...needles.map(n => n.bytes.length))
  const fd = openSync(path, 'r')
  try {
    let carry = Buffer.alloc(0)
    const chunk = Buffer.alloc(CHUNK_BYTES)
    for (;;) {
      const read = readSync(fd, chunk, 0, CHUNK_BYTES, null)
      if (read <= 0) break
      const window = Buffer.concat([carry, chunk.subarray(0, read)])
      for (const needle of needles) {
        const n = countIn(window, needle.bytes, carry.length)
        if (n > 0) counts.set(needle.label, (counts.get(needle.label) ?? 0) + n)
      }
      const keep = Math.min(longest - 1, window.length)
      carry = Buffer.from(window.subarray(window.length - keep))
    }
  } finally {
    closeSync(fd)
  }
  return counts
}

function holderRule(
  rel: string,
  nodes: readonly string[],
  withConsole: boolean,
): boolean {
  for (const node of nodes) {
    for (const holder of NODE_HOLDERS) {
      if (rel === `nodes/${node}/config/${holder}`) return true
    }
  }
  if (withConsole) {
    for (const holder of CONSOLE_HOLDERS) {
      if (rel === `nodes/console/config/${holder}`) return true
    }
  }
  return false
}

export function scanFiles(options: {
  readonly root: string
  readonly nodes: readonly string[]
  readonly console: boolean
  readonly needles: readonly Needle[]
}): Pick<ScanResult, 'files' | 'hits' | 'holders'> {
  const hits: PathHit[] = []
  const holders: PathHit[] = []
  let scanned = 0
  let bytes = 0
  let skippedLarge = 0
  const walk = (dir: string, rel: string): void => {
    let names: string[]
    try {
      names = readdirSync(dir).sort()
    } catch {
      return
    }
    for (const name of names) {
      const path = join(dir, name)
      const childRel = rel === '' ? name : `${rel}/${name}`
      if (rel === '' && (EXCLUDED_TOP as readonly string[]).includes(name)) {
        continue
      }
      let st: ReturnType<typeof lstatSync>
      try {
        st = lstatSync(path)
      } catch {
        continue
      }
      if (st.isSymbolicLink()) continue
      if (st.isDirectory()) {
        walk(path, childRel)
        continue
      }
      if (!st.isFile()) continue
      if (st.size > MAX_FILE_BYTES) {
        skippedLarge += 1
        continue
      }
      let counts: Map<string, number>
      try {
        counts = countFile(path, options.needles)
      } catch {
        continue
      }
      scanned += 1
      bytes += st.size
      const into = holderRule(childRel, options.nodes, options.console)
        ? holders
        : hits
      for (const [label, count] of counts) {
        into.push({ path: childRel, label, count })
      }
    }
  }
  if (existsSync(options.root)) walk(options.root, '')
  return {
    files: {
      scanned,
      bytes,
      skippedLarge,
      excluded: EXCLUDED_TOP.map(name => `${name}/`),
    },
    hits,
    holders,
  }
}

/** 每根针在合成缓冲里恰好命中一次：匹配器本身是好的。 */
export function selfTest(needles: readonly Needle[]): boolean {
  return needles.every(needle => {
    const buffer = Buffer.concat([
      Buffer.from('<<'),
      needle.bytes,
      Buffer.from('>>'),
    ])
    return countIn(buffer, needle.bytes, 0) === 1
  })
}

function psSample(needles: readonly Needle[], into: Map<string, number>): void {
  let text: string
  try {
    text = execFileSync('ps', ['-eo', 'args'], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch {
    return
  }
  const buffer = Buffer.from(text, 'utf8')
  for (const needle of needles) {
    const n = countIn(buffer, needle.bytes, 0)
    if (n > 0) into.set(needle.label, (into.get(needle.label) ?? 0) + n)
  }
}

/** stdin 按行读：第一行是请求，之后等 `stop` 或 EOF。 */
async function* stdinLines(): AsyncGenerator<string> {
  const decoder = new TextDecoder()
  let buffered = ''
  for await (const chunk of process.stdin) {
    buffered += decoder.decode(chunk as Uint8Array, { stream: true })
    let at = buffered.indexOf('\n')
    while (at !== -1) {
      yield buffered.slice(0, at)
      buffered = buffered.slice(at + 1)
      at = buffered.indexOf('\n')
    }
  }
  if (buffered !== '') yield buffered
}

async function runScan(options: {
  readonly root: string
  readonly nodes: readonly string[]
  readonly console: boolean
}): Promise<void> {
  const lines = stdinLines()
  const first = await lines.next()
  let request: unknown = null
  try {
    request = first.done ? null : (JSON.parse(first.value) as unknown)
  } catch {
    request = null
  }
  if (!isRecord(request)) {
    process.stderr.write('scan：stdin 第一行应是 {"canaries":[…]}\n')
    process.exit(2)
  }
  const canaries = stringList(request.canaries).map((value, index) => ({
    label: `canary-${index + 1}`,
    bytes: Buffer.from(value, 'utf8'),
  }))
  const interval =
    typeof request.psIntervalMs === 'number' && request.psIntervalMs > 0
      ? request.psIntervalMs
      : 100
  const real = realKeyNeedles(options.root, options.nodes)
  const needles = [...canaries, ...real]
  const ok = selfTest(needles)
  process.stdout.write(
    `${JSON.stringify({ v: 1, ready: true, needles: { canary: canaries.length, real: real.length } })}\n`,
  )

  const ps = new Map<string, number>()
  let samples = 0
  const timer = setInterval(() => {
    psSample(needles, ps)
    samples += 1
  }, interval)
  psSample(needles, ps)
  samples += 1
  for (;;) {
    const next = await lines.next()
    if (next.done || next.value.trim() === 'stop') break
  }
  clearInterval(timer)

  const result: ScanResult = {
    v: 1,
    done: true,
    selfTest: ok,
    samples,
    ps: Object.fromEntries(ps),
    ...scanFiles({ ...options, needles }),
    needles: {
      canary: canaries.length,
      real: real.length,
      realLabels: real.map(needle => needle.label),
    },
  }
  process.stdout.write(`${JSON.stringify(result)}\n`)
}

// ── 入口 ──────────────────────────────────────────────────────────────────────

interface Args {
  readonly command: string
  readonly root: string
  readonly tree: string | null
  readonly nodes: readonly string[]
  readonly console: boolean
}

function parseArgs(argv: readonly string[]): Args {
  const [command = '', ...rest] = argv
  let root = process.env.QIANMO_BETA_ROOT || join(homedir(), 'qianmo-beta')
  let tree: string | null = null
  let nodes: string[] = []
  let withConsole = false
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i]
    const value = rest[i + 1]
    if (arg === '--root' && value !== undefined) {
      root = value
      i += 1
    } else if (arg === '--tree' && value !== undefined) {
      tree = value
      i += 1
    } else if (arg === '--nodes' && value !== undefined) {
      nodes = value.split(',').filter(name => name !== '')
      i += 1
    } else if (arg === '--console') {
      withConsole = true
    } else {
      process.stderr.write(`不认识的参数：${arg ?? ''}\n`)
      process.exit(2)
    }
  }
  for (const node of nodes) {
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(node)) {
      process.stderr.write(`节点名不合法：${node}\n`)
      process.exit(2)
    }
  }
  return { command, root, tree, nodes, console: withConsole }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (args.command === 'facts') {
    if (args.tree === null) {
      process.stderr.write('facts 要 --tree <部署根>\n')
      process.exit(2)
    }
    const facts = collectFacts({
      root: args.root,
      tree: args.tree,
      nodes: args.nodes,
      console: args.console,
    })
    process.stdout.write(`${JSON.stringify(facts)}\n`)
    return
  }
  if (args.command === 'scan') {
    await runScan(args)
    return
  }
  process.stderr.write('用法：provider-acceptance-node.ts facts|scan …\n')
  process.exit(2)
}

if (import.meta.main) {
  await main()
}
