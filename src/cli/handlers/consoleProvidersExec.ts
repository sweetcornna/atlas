// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 第六类动作的中枢一侧执行器（`providers-console-m1.md` §2.5，P18.6）：把一行请求
 * JSON 送到节点的 `qm provider serve-stdin`，把一行响应 JSON 读回来。
 *
 * ## 两条路
 *
 * - **local**：中枢同机的节点。起 `<脚本> <节点名>`（内测里就是节点 sshd 强制命令
 *   那同一个 `model-apply.sh`），同样的 stdin，不经 ssh、不经任何文件（§2.8）。
 * - **ssh**：每节点一把专用 key，`StrictHostKeyChecking=yes`、中枢自有的
 *   known_hosts。客户端命令是**一个不存在的哨兵**（`SENTINEL_COMMAND`）：节点上
 *   `authorized_keys` 那一行的强制命令丢了或被改写时，sshd 去执行哨兵，结果是「命令
 *   不存在」（127），这里报失败，而不是静默成功。
 *
 * 两条路的子进程都只拿到一份最小环境（{@link MINIMAL_ENV}），控制台进程里的 PSK、
 * token 之类一个都不带过去；ssh 也不读用户的 `~/.ssh/config`（`-F /dev/null`）、
 * 不复用多路复用主连接（那条主连接可能是隧道那把 key 认证的，强制命令是另一条）、
 * 不向 agent 要 key。
 *
 * ## 密钥只走 stdin
 *
 * argv 里只有 key 文件的**路径**、主机、端口与哨兵；密钥只出现在写进 stdin 的那一行
 * 里（§2.5「为什么只走 stdin」）。节点的 stderr 与 stdout 第一行以外的内容都不往外
 * 转述：stderr 只用来认出几种已知的 ssh 失败，给一句我们自己写的原因。
 *
 * ## 串行
 *
 * 同一个节点同一时刻只有一个操作在途（§2.5「中枢对同一个节点同时只发一个操作」），
 * 后来的排在它后面；节点上的 `model-apply.sh` 锁与 `apply.lock` 是第二、第三道。
 */

import { spawn } from 'node:child_process'
import { createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { parseProviderRequest, SENTINEL_COMMAND } from '@qianmo/providers'

/** A node the hub can reach, as `consoleArgs.ts` parsed it. */
export type ProviderNodeTarget =
  | {
      readonly node: string
      readonly kind: 'local'
      /** Absolute path of the executable; it is run as `<command> <node>`. */
      readonly command: string
    }
  | {
      readonly node: string
      readonly kind: 'ssh'
      readonly user: string
      /** A host name, an IPv4 literal, or an IPv6 literal without brackets. */
      readonly host: string
      readonly port: number
      /** The dedicated private key for this node (§2.5): a path, never its content. */
      readonly keyFile: string
    }

/**
 * The node-name rule of the protocol itself, asked of the protocol parser
 * rather than copied: a name it would refuse in a request is refused here.
 */
export function isProtocolNodeName(node: string): boolean {
  return parseProviderRequest({
    v: 1,
    op: 'status',
    requestId: 'node-name-check',
    node,
  }).ok
}

/** The only variables a node process gets from the console's environment. */
const MINIMAL_ENV = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'LANG',
  'LC_ALL',
  'TMPDIR',
] as const

/** Local only: where the beta root is, when it is not the default one. */
const LOCAL_ONLY_ENV = ['QIANMO_BETA_ROOT'] as const

/** Room for the ssh handshake on top of an operation's own budget. */
const SSH_GRACE_MS = 15_000
/** A response is one line; anything this large is not one. */
const MAX_STDOUT_BYTES = 1024 * 1024
const MAX_STDERR_BYTES = 8 * 1024

/** The ssh command line for one target. Never carries a key value. */
function providerSshArgv(
  sshBinary: string,
  target: Extract<ProviderNodeTarget, { kind: 'ssh' }>,
  knownHostsFile: string,
): string[] {
  return [
    sshBinary,
    '-F',
    '/dev/null',
    '-i',
    target.keyFile,
    '-o',
    'IdentitiesOnly=yes',
    '-o',
    'IdentityAgent=none',
    '-o',
    'BatchMode=yes',
    '-o',
    'StrictHostKeyChecking=yes',
    '-o',
    `UserKnownHostsFile=${knownHostsFile}`,
    '-o',
    'GlobalKnownHostsFile=/dev/null',
    '-o',
    'ControlMaster=no',
    '-o',
    'ControlPath=none',
    '-o',
    'ConnectTimeout=10',
    '-o',
    'LogLevel=ERROR',
    '-T',
    '-x',
    '-a',
    '-p',
    String(target.port),
    `${target.user}@${target.host}`,
    SENTINEL_COMMAND,
  ]
}

function hostPatternMatches(pattern: string, name: string): boolean {
  if (pattern.startsWith('|1|')) {
    const [, , salt, hash] = pattern.split('|')
    if (salt === undefined || hash === undefined) return false
    const digest = createHmac('sha1', Buffer.from(salt, 'base64'))
      .update(name)
      .digest('base64')
    return digest === hash
  }
  if (/[*?]/.test(pattern)) {
    const source = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.')
    return new RegExp(`^${source}$`, 'i').test(name)
  }
  return pattern.toLowerCase() === name.toLowerCase()
}

/**
 * Whether `text` (a known_hosts file) has a usable entry for `host:port`:
 * plain or hashed (`|1|`) names, the `[host]:port` form for a port other than
 * 22, `@cert-authority` lines; `@revoked` lines and negated patterns do not
 * count. ssh's own `StrictHostKeyChecking=yes` remains the real gate; this is
 * what turns a missing entry into a refusal with a reason, before any dial.
 */
export function knownHostsHasEntry(
  text: string,
  host: string,
  port: number,
): boolean {
  const name = port === 22 ? host : `[${host}]:${port}`
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const fields = line.split(/\s+/)
    let at = 0
    if (fields[0]?.startsWith('@')) {
      if (fields[0] === '@revoked') continue
      at = 1
    }
    const hosts = fields[at]
    if (hosts === undefined || fields.length < at + 3) continue
    const patterns = hosts.split(',')
    if (
      patterns.some(
        p => p.startsWith('!') && hostPatternMatches(p.slice(1), name),
      )
    ) {
      continue
    }
    if (patterns.some(p => !p.startsWith('!') && hostPatternMatches(p, name))) {
      return true
    }
  }
  return false
}

/** A parsed response line: the protocol envelope, plus whatever fields the op adds. */
export type NodeReply = Readonly<Record<string, unknown>> & {
  readonly ok: boolean
}

export type ExecResult =
  | { readonly ok: true; readonly reply: NodeReply }
  | {
      readonly ok: false
      /** For the ledger and the page: our own words, never the node's stderr. */
      readonly message: string
      readonly reason:
        | 'no-target'
        | 'known-hosts'
        | 'spawn'
        | 'timeout'
        | 'forced-command'
        | 'ssh'
        | 'no-response'
    }

interface ProviderExecutorOptions {
  /** The hub's own known_hosts (§2.5); ssh targets only. */
  readonly knownHostsFile: string
  /** `ssh` on PATH by default; tests point it at a stand-in. */
  readonly sshBinary?: string
  /** Where {@link MINIMAL_ENV} is copied from. Defaults to `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function pickEnv(
  source: Readonly<Record<string, string | undefined>>,
  names: readonly string[],
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const name of names) {
    const value = source[name]
    if (value !== undefined) env[name] = value
  }
  return env
}

/** The one response line, held to the envelope the node promises. */
function parseReply(
  stdout: string,
  requestId: string,
  exitCode: number | null,
): NodeReply | null {
  const newline = stdout.indexOf('\n')
  const line = (newline === -1 ? stdout : stdout.slice(0, newline)).trim()
  if (line === '') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return null
  }
  if (!isRecord(parsed) || parsed.v !== 1 || typeof parsed.ok !== 'boolean') {
    return null
  }
  if (parsed.ok) {
    if (parsed.requestId !== requestId || exitCode !== 0) return null
  } else {
    if (parsed.requestId !== requestId && parsed.requestId !== null) {
      return null
    }
    if (typeof parsed.code !== 'string' || exitCode !== 1) return null
  }
  return parsed as NodeReply
}

/** Our sentence for a run that produced no protocol response. */
function failureOf(
  target: ProviderNodeTarget,
  exitCode: number | null,
  stderr: string,
): Extract<ExecResult, { ok: false }> {
  if (
    exitCode === 127 ||
    (exitCode !== 255 && /command not found/i.test(stderr))
  ) {
    return {
      ok: false,
      reason: 'forced-command',
      message:
        target.kind === 'ssh'
          ? '节点没有执行强制命令：authorized_keys 里那一行可能丢了或被改写（客户端命令是不存在的哨兵）'
          : '本机执行器的命令不存在或跑不起来',
    }
  }
  if (target.kind === 'ssh' && exitCode === 255) {
    const reason = /host key verification failed/i.test(stderr)
      ? '主机指纹与中枢 known_hosts 不符'
      : /permission denied/i.test(stderr)
        ? '节点不认这把专用 key'
        : '连不上节点'
    return { ok: false, reason: 'ssh', message: `ssh 失败：${reason}` }
  }
  return {
    ok: false,
    reason: 'no-response',
    message: `节点没有回协议响应（退出码 ${exitCode === null ? '无' : String(exitCode)}）`,
  }
}

export class ProviderExecutor {
  readonly #targets: ReadonlyMap<string, ProviderNodeTarget>
  readonly #options: ProviderExecutorOptions
  /** The tail of each node's queue: the next operation waits for it. */
  readonly #queues = new Map<string, Promise<unknown>>()

  constructor(
    targets: readonly ProviderNodeTarget[],
    options: ProviderExecutorOptions,
  ) {
    this.#targets = new Map(targets.map(target => [target.node, target]))
    this.#options = options
  }

  /** Node names in the order they were configured. */
  nodes(): readonly string[] {
    return [...this.#targets.keys()]
  }

  target(node: string): ProviderNodeTarget | undefined {
    return this.#targets.get(node)
  }

  /**
   * Send one request to `node` and read one response. Queued behind any
   * operation already in flight to the same node. Never throws.
   */
  run(
    node: string,
    request: Readonly<Record<string, unknown>> & { readonly requestId: string },
    timeoutMs: number,
  ): Promise<ExecResult> {
    const previous = this.#queues.get(node) ?? Promise.resolve()
    const next = previous.then(
      () => this.#runNow(node, request, timeoutMs),
      () => this.#runNow(node, request, timeoutMs),
    )
    this.#queues.set(node, next)
    void next.finally(() => {
      if (this.#queues.get(node) === next) this.#queues.delete(node)
    })
    return next
  }

  async #runNow(
    node: string,
    request: Readonly<Record<string, unknown>> & { readonly requestId: string },
    timeoutMs: number,
  ): Promise<ExecResult> {
    const target = this.#targets.get(node)
    if (target === undefined) {
      return {
        ok: false,
        reason: 'no-target',
        message: '这个节点没有配置执行器',
      }
    }
    const source = this.#options.env ?? process.env
    let argv: string[]
    let env: Record<string, string>
    let budget = timeoutMs
    if (target.kind === 'local') {
      argv = [target.command, target.node]
      env = pickEnv(source, [...MINIMAL_ENV, ...LOCAL_ONLY_ENV])
    } else {
      let knownHosts: string
      try {
        knownHosts = readFileSync(this.#options.knownHostsFile, 'utf8')
      } catch {
        knownHosts = ''
      }
      if (!knownHostsHasEntry(knownHosts, target.host, target.port)) {
        return {
          ok: false,
          reason: 'known-hosts',
          message: `中枢的 known_hosts 里没有 ${target.host} 的主机指纹，拒绝连接（StrictHostKeyChecking=yes）`,
        }
      }
      argv = providerSshArgv(
        this.#options.sshBinary ?? 'ssh',
        target,
        this.#options.knownHostsFile,
      )
      env = pickEnv(source, MINIMAL_ENV)
      budget += SSH_GRACE_MS
    }
    return this.#spawn(target, argv, env, request, budget)
  }

  #spawn(
    target: ProviderNodeTarget,
    argv: readonly string[],
    env: Record<string, string>,
    request: Readonly<Record<string, unknown>> & { readonly requestId: string },
    budgetMs: number,
  ): Promise<ExecResult> {
    return new Promise(resolve => {
      const [command, ...args] = argv
      if (command === undefined) {
        resolve({ ok: false, reason: 'spawn', message: '执行器命令为空' })
        return
      }
      let settled = false
      const finish = (result: ExecResult) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(result)
      }
      const child = spawn(command, args, {
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      const stdout: Buffer[] = []
      const stderr: Buffer[] = []
      let stdoutBytes = 0
      let stderrBytes = 0
      let timedOut = false
      let overflow = false
      const timer = setTimeout(() => {
        timedOut = true
        child.kill('SIGKILL')
      }, budgetMs)
      child.stdout.on('data', (chunk: Buffer) => {
        stdoutBytes += chunk.byteLength
        if (stdoutBytes > MAX_STDOUT_BYTES) {
          overflow = true
          child.kill('SIGKILL')
          return
        }
        stdout.push(chunk)
      })
      child.stderr.on('data', (chunk: Buffer) => {
        if (stderrBytes < MAX_STDERR_BYTES) stderr.push(chunk)
        stderrBytes += chunk.byteLength
      })
      // A child that exits before reading stdin makes the write fail with
      // EPIPE; the exit status below is the answer, not this error.
      child.stdin.on('error', () => {})
      child.on('error', () => {
        finish({
          ok: false,
          reason: 'spawn',
          message:
            target.kind === 'ssh'
              ? '起不了 ssh（中枢上找不到 ssh 可执行文件）'
              : '起不了本机执行器',
        })
      })
      child.on('close', exitCode => {
        if (timedOut) {
          finish({
            ok: false,
            reason: 'timeout',
            message: `节点 ${Math.round(budgetMs / 1000)} s 内没有回应`,
          })
          return
        }
        if (overflow) {
          finish({
            ok: false,
            reason: 'no-response',
            message: '节点的回应超过 1 MiB，不是一行协议响应',
          })
          return
        }
        const reply = parseReply(
          Buffer.concat(stdout).toString('utf8'),
          request.requestId,
          exitCode,
        )
        if (reply !== null) {
          finish({ ok: true, reply })
          return
        }
        finish(
          failureOf(target, exitCode, Buffer.concat(stderr).toString('utf8')),
        )
      })
      child.stdin.end(`${JSON.stringify(request)}\n`)
    })
  }
}
