// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `qm replicate`：中枢把自己复制到一台新服务器上（`node-provisioning.md` §14）。
 *
 *   qm replicate inspect                 stdin 一行请求 JSON，stdout 一行报告 JSON
 *   qm replicate run --request <文件>    读完立刻删掉请求文件；进度一行一条 JSON
 *
 * ## 凭据只用一次
 *
 * 请求里的口令或私钥只用来建立这一次的 SSH 主连接（`ControlMaster`），之后的每一步都
 * 复用这条连接；主连接建好私钥就从一次性 agent 里清掉，作业结束主连接退出、临时目录
 * 删掉。口令与私钥不进 argv、不写进任何持久文件、不进进度日志。复制完成后中枢留下的
 * 只有它为这个节点**自己生成**的两把 key：链路 key（隧道与审计镜像，`restrict` +
 * `port-forwarding` + `permitopen`，强制命令只读审计链）与模型下发 key（强制命令
 * `model-apply.sh`）。
 *
 * ## 模型档案以发起人的名义下发
 *
 * 作业不拿控制台的管理令牌：模型服务的写操作只认运维个人账号，共用令牌与
 * break-glass 只能查看。请求里的 `models` 是控制台在「部署」那一刻、发起人是运维
 * 个人账号时给的单次授权；最后一步把它交回 `POST /v0/replicate/jobs/<作业>/models`，
 * 由控制台以发起人的名义给这一个节点下发（`consoleReplicate.ts`、`routes/servers.ts`）。
 * 没有这张授权时只提示去模型页下发。
 *
 * ## 主机身份
 *
 * `inspect` 用 ssh-keyscan 读出主机公钥并给出指纹；控制台把指纹给操作者看，操作者点
 * 「部署」就是确认这一把。`run` 再扫一次，必须与确认的那把逐字相同才写进本次的
 * known_hosts，全程 `StrictHostKeyChecking=yes`。
 *
 * ## 复制什么
 *
 * 中枢自己正在跑的部署树里的 `dist/` 与 `demo/`，原样打包送过去：目标机必须与中枢
 * 同一操作系统与架构（现场是 linux x86_64）。节点腿、模型下发登记与中枢腿都用这棵树里
 * 的脚本（`demo/env/beta/`），与运维手工装机走的是同一套。
 *
 * ## 失败了怎么办
 *
 * 每一步登记自己的撤回动作。中途失败时倒序撤回：目标机上删掉加进 authorized_keys 的
 * 两行、停掉节点、把两个目录改名为 `.failed-<UTC>`（不删）；中枢上撤回 peers.conf、
 * console.env 与本次生成的 PSK 和 key。已经重启过中枢之后的失败不再撤回：那时节点已经
 * 接进网络，进度日志里写明停在哪一步。
 */

import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  accessSync,
  appendFileSync,
  chmodSync,
  closeSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ---------------------------------------------------------------------------
// requests

export interface ReplicateTarget {
  readonly host: string
  readonly port: number
  readonly user: string
}

export type ReplicateAuth =
  | { readonly kind: 'password'; readonly secret: string }
  | { readonly kind: 'key'; readonly secret: string }

export interface InspectRequest {
  readonly v: 1
  readonly op: 'inspect'
  readonly target: ReplicateTarget
  readonly auth: ReplicateAuth
  /** The hub's deployment tree: its platform is what the target must match. */
  readonly tree: string
}

export interface RunRequest {
  readonly v: 1
  readonly op: 'run'
  readonly job: string
  readonly target: ReplicateTarget
  readonly auth: ReplicateAuth
  /** The `SHA256:…` fingerprint the operator confirmed. */
  readonly hostKey: string
  readonly node: string
  readonly agent: string
  readonly server: string
  /** The hub's beta root (`QIANMO_BETA_ROOT`) and deployment tree. */
  readonly root: string
  readonly tree: string
  /** The console's own address, for the last step's model-profile apply. */
  readonly consoleUrl: string
  /**
   * The one-time grant the console gave this job when the person who started
   * it may write model services; absent otherwise (the module note).
   */
  readonly models?: string
}

export interface HostKeyView {
  readonly type: string
  readonly fingerprint: string
}

export interface InspectReport {
  readonly ok: true
  readonly hostKeys: readonly HostKeyView[]
  readonly os: string
  readonly arch: string
  readonly kernel: string
  /** The target's own name (`uname -n`), when it can stand as a server name. */
  readonly hostname?: string
  readonly memMb: number
  readonly availMb: number
  readonly diskMb: number
  /** A Qianmo deployment is already in the account's home directory. */
  readonly existing: boolean
  readonly supported: boolean
  /** Why not, when `supported` is false. */
  readonly reason?: string
}

export interface ReplicateFailure {
  readonly ok: false
  readonly code: string
  readonly reason: string
}

const NODE_NAME = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/
const AGENT_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/
const SSH_USER = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,31}$/
const HOST = /^[A-Za-z0-9][A-Za-z0-9.:_-]{0,252}$/
const SERVER_ID = /^[A-Za-z0-9._:-]{1,64}$/
const JOB_ID = /^[a-z0-9-]{6,64}$/
const FINGERPRINT = /^SHA256:[A-Za-z0-9+/]{43}$/
const MODELS_GRANT = /^[A-Za-z0-9_-]{43}$/
const SAFE_PATH = /^\/[A-Za-z0-9._/-]+$/
/** A private key or a password is short; anything this long is not one. */
const MAX_SECRET = 16 * 1024

type Parsed<T> = { ok: true; value: T } | ReplicateFailure

function refuse(code: string, reason: string): ReplicateFailure {
  return { ok: false, code, reason }
}

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function parseTarget(value: unknown): Parsed<ReplicateTarget> {
  const target = object(value)
  if (target === null) return refuse('bad-request', '缺少服务器')
  const { host, port, user } = target
  if (typeof host !== 'string' || !HOST.test(host) || host.includes('..'))
    return refuse('bad-host', '地址只收主机名 IPv4 或不带方括号的 IPv6')
  const portNumber = port === undefined ? 22 : port
  if (
    typeof portNumber !== 'number' ||
    !Number.isInteger(portNumber) ||
    portNumber < 1 ||
    portNumber > 65535
  )
    return refuse('bad-port', 'SSH 端口应在 1–65535')
  if (typeof user !== 'string' || !SSH_USER.test(user))
    return refuse('bad-user', '用户名不合法')
  return { ok: true, value: { host, port: portNumber, user } }
}

function parseAuth(value: unknown): Parsed<ReplicateAuth> {
  const auth = object(value)
  if (auth === null) return refuse('bad-request', '缺少登录凭据')
  const { kind, secret } = auth
  if (kind !== 'password' && kind !== 'key')
    return refuse('bad-auth', '凭据只收口令或私钥')
  if (typeof secret !== 'string' || secret === '' || secret.length > MAX_SECRET)
    return refuse('bad-auth', kind === 'password' ? '口令为空' : '私钥为空')
  if (kind === 'password' && /[\r\n\0]/.test(secret))
    return refuse('bad-auth', '口令里不能有换行')
  if (kind === 'key' && !/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/.test(secret))
    return refuse('bad-auth', '私钥应是 PEM 或 OpenSSH 格式的整段文本')
  return { ok: true, value: { kind, secret } }
}

function parsePath(value: unknown, what: string): Parsed<string> {
  if (
    typeof value !== 'string' ||
    !SAFE_PATH.test(value) ||
    value.includes('..')
  )
    return refuse('bad-request', `${what}不合法`)
  return { ok: true, value }
}

export function parseInspectRequest(value: unknown): Parsed<InspectRequest> {
  const body = object(value)
  if (body === null || body.v !== 1 || body.op !== 'inspect')
    return refuse('bad-request', '请求格式不对')
  const target = parseTarget(body.target)
  if (!target.ok) return target
  const auth = parseAuth(body.auth)
  if (!auth.ok) return auth
  const tree = parsePath(body.tree, '部署树路径')
  if (!tree.ok) return tree
  return {
    ok: true,
    value: {
      v: 1,
      op: 'inspect',
      target: target.value,
      auth: auth.value,
      tree: tree.value,
    },
  }
}

export function parseRunRequest(value: unknown): Parsed<RunRequest> {
  const body = object(value)
  if (body === null || body.v !== 1 || body.op !== 'run')
    return refuse('bad-request', '请求格式不对')
  const target = parseTarget(body.target)
  if (!target.ok) return target
  const auth = parseAuth(body.auth)
  if (!auth.ok) return auth
  const { job, hostKey, node, agent, server, consoleUrl, models } = body
  if (typeof job !== 'string' || !JOB_ID.test(job))
    return refuse('bad-request', '作业号不合法')
  if (typeof hostKey !== 'string' || !FINGERPRINT.test(hostKey))
    return refuse('bad-host-key', '主机指纹应是 SHA256:… 的形式')
  if (typeof node !== 'string' || !NODE_NAME.test(node))
    return refuse(
      'bad-node',
      '节点名只收小写字母 数字 - 与 _ · 首尾是字母或数字',
    )
  if (typeof agent !== 'string' || !AGENT_NAME.test(agent))
    return refuse('bad-agent', '智能体名只收字母 数字 - 与 _')
  if (typeof server !== 'string' || !SERVER_ID.test(server))
    return refuse('bad-server', '服务器名只收字母 数字与 . _ : -')
  if (
    typeof consoleUrl !== 'string' ||
    !/^http:\/\/127\.0\.0\.1:[0-9]{1,5}$/.test(consoleUrl)
  )
    return refuse('bad-request', '控制台地址应是本机回环')
  if (
    models !== undefined &&
    (typeof models !== 'string' || !MODELS_GRANT.test(models))
  )
    return refuse('bad-request', '下发授权不合法')
  const root = parsePath(body.root, '内测根路径')
  if (!root.ok) return root
  const tree = parsePath(body.tree, '部署树路径')
  if (!tree.ok) return tree
  return {
    ok: true,
    value: {
      v: 1,
      op: 'run',
      job,
      target: target.value,
      auth: auth.value,
      hostKey,
      node,
      agent,
      server,
      root: root.value,
      tree: tree.value,
      consoleUrl,
      ...(typeof models === 'string' ? { models } : {}),
    },
  }
}

// ---------------------------------------------------------------------------
// processes

interface Ran {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

/** The variables a child gets: nothing of the console's own environment. */
function minimalEnv(
  extra: Record<string, string> = {},
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const name of [
    'PATH',
    'HOME',
    'USER',
    'LOGNAME',
    'LANG',
    'TMPDIR',
    'XDG_RUNTIME_DIR',
    'DBUS_SESSION_BUS_ADDRESS',
  ]) {
    const value = process.env[name]
    if (value !== undefined) env[name] = value
  }
  return { ...env, LC_ALL: 'C', ...extra }
}

function runProcess(
  argv: readonly string[],
  options: {
    readonly input?: string
    readonly env?: Record<string, string>
    readonly timeoutMs?: number
  } = {},
): Promise<Ran> {
  return new Promise(resolve => {
    const [command, ...args] = argv
    const child = spawn(command ?? 'false', args, {
      env: options.env ?? minimalEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => {
      if (stdout.length < 4 * 1024 * 1024) stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 64 * 1024) stderr += chunk.toString('utf8')
    })
    const timer = setTimeout(
      () => child.kill('SIGKILL'),
      options.timeoutMs ?? 120_000,
    )
    child.on('error', error => {
      clearTimeout(timer)
      resolve({ code: 127, stdout, stderr: `${stderr}${String(error)}` })
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      resolve({ code: code ?? (signal === null ? 1 : 128), stdout, stderr })
    })
    child.stdin.on('error', () => {})
    child.stdin.end(options.input ?? '')
  })
}

/** Single-quote a word for a POSIX shell. */
export function shellQuote(word: string): string {
  return `'${word.replace(/'/g, `'\\''`)}'`
}

/** Fold a remote error into one short line we can show. */
function lastLines(text: string, count = 6): string {
  return text
    .split('\n')
    .map(line => line.trimEnd())
    .filter(line => line !== '')
    .slice(-count)
    .join(' · ')
    .slice(0, 600)
}

// ---------------------------------------------------------------------------
// host keys

interface ScannedKey extends HostKeyView {
  /** The known_hosts line, as ssh-keyscan wrote it. */
  readonly line: string
}

function knownName(target: ReplicateTarget): string {
  return target.port === 22 ? target.host : `[${target.host}]:${target.port}`
}

export async function scanHostKeys(
  target: ReplicateTarget,
): Promise<readonly ScannedKey[]> {
  const scanned = await runProcess(
    [
      'ssh-keyscan',
      '-T',
      '10',
      '-t',
      'ed25519,ecdsa,rsa',
      '-p',
      String(target.port),
      target.host,
    ],
    { timeoutMs: 40_000 },
  )
  const keys: ScannedKey[] = []
  for (const line of scanned.stdout.split('\n')) {
    const fields = line.trim().split(/\s+/)
    if (fields.length < 3 || line.startsWith('#')) continue
    const [, type, blob] = fields
    if (type === undefined || blob === undefined) continue
    const printed = await runProcess(
      ['ssh-keygen', '-l', '-E', 'sha256', '-f', '-'],
      {
        input: `${knownName(target)} ${type} ${blob}\n`,
      },
    )
    const fingerprint = /SHA256:[A-Za-z0-9+/]{43}/.exec(printed.stdout)?.[0]
    if (fingerprint === undefined) continue
    keys.push({
      type,
      fingerprint,
      line: `${knownName(target)} ${type} ${blob}`,
    })
  }
  // ed25519 first: it is the one the operator is shown.
  return keys.sort(
    (a, b) =>
      Number(b.type === 'ssh-ed25519') - Number(a.type === 'ssh-ed25519'),
  )
}

// ---------------------------------------------------------------------------
// the one SSH session

export class ReplicateError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

function sshFailure(stderr: string, target: ReplicateTarget): ReplicateError {
  if (
    /Permission denied|Authentication failed|Too many authentication failures/i.test(
      stderr,
    )
  )
    return new ReplicateError('auth', '登录被拒 · 用户名 口令或私钥不对')
  if (
    /Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(
      stderr,
    )
  )
    return new ReplicateError('host-key', '主机指纹对不上')
  if (/Connection refused/i.test(stderr))
    return new ReplicateError(
      'unreachable',
      `${target.host}:${target.port} 拒绝连接`,
    )
  if (
    /timed out|No route to host|Could not resolve hostname|Name or service not known/i.test(
      stderr,
    )
  )
    return new ReplicateError(
      'unreachable',
      `连不上 ${target.host}:${target.port}`,
    )
  return new ReplicateError(
    'ssh',
    `SSH 失败：${lastLines(stderr, 2) || '无输出'}`,
  )
}

/**
 * One authenticated master connection, reused by every step. The credential
 * is spent on `open()` and nowhere else.
 */
export class BootstrapSession {
  readonly #dir: string
  readonly #control: string
  readonly #knownHosts: string
  #open = false

  constructor(readonly target: ReplicateTarget) {
    // Short: a UNIX socket path has a length limit (§3.5).
    this.#dir = mkdtempSync(
      join(tmpdir().length > 40 ? '/tmp' : tmpdir(), 'qmr-'),
    )
    chmodSync(this.#dir, 0o700)
    this.#control = join(this.#dir, 'c')
    this.#knownHosts = join(this.#dir, 'kh')
  }

  /** Pin exactly these known_hosts lines for this session. */
  pin(lines: readonly string[]): void {
    writeFileSync(this.#knownHosts, `${lines.join('\n')}\n`, { mode: 0o600 })
  }

  #base(): string[] {
    return [
      'ssh',
      '-F',
      '/dev/null',
      '-p',
      String(this.target.port),
      '-o',
      `ControlPath=${this.#control}`,
      '-o',
      'StrictHostKeyChecking=yes',
      '-o',
      `UserKnownHostsFile=${this.#knownHosts}`,
      '-o',
      'GlobalKnownHostsFile=/dev/null',
      '-o',
      'ConnectTimeout=20',
      '-o',
      'ServerAliveInterval=15',
      '-o',
      'ServerAliveCountMax=4',
      '-o',
      'LogLevel=ERROR',
    ]
  }

  #login(): string {
    return `${this.target.user}@${this.target.host}`
  }

  async open(auth: ReplicateAuth): Promise<void> {
    const master = [
      ...this.#base(),
      '-o',
      'ControlMaster=yes',
      '-o',
      'ControlPersist=1800',
      '-f',
      '-N',
    ]
    let env: Record<string, string>
    let agentPid: string | null = null
    if (auth.kind === 'password') {
      const askpass = join(this.#dir, 'a')
      writeFileSync(
        askpass,
        '#!/bin/sh\nprintf \'%s\\n\' "$QM_REPLICATE_ASKPASS"\n',
        {
          mode: 0o700,
        },
      )
      master.push(
        '-o',
        'PreferredAuthentications=keyboard-interactive,password',
        '-o',
        'PubkeyAuthentication=no',
        '-o',
        'NumberOfPasswordPrompts=1',
        '-o',
        'IdentityAgent=none',
      )
      env = minimalEnv({
        SSH_ASKPASS: askpass,
        SSH_ASKPASS_REQUIRE: 'force',
        DISPLAY: 'qianmo',
        QM_REPLICATE_ASKPASS: auth.secret,
      })
    } else {
      const socket = join(this.#dir, 's')
      const agent = await runProcess(['ssh-agent', '-a', socket, '-s'])
      agentPid = /SSH_AGENT_PID=([0-9]+)/.exec(agent.stdout)?.[1] ?? null
      if (agent.code !== 0 || agentPid === null)
        throw new ReplicateError('ssh', 'ssh-agent 起不来')
      const added = await runProcess(['ssh-add', '-q', '-'], {
        input: auth.secret.endsWith('\n') ? auth.secret : `${auth.secret}\n`,
        env: minimalEnv({
          SSH_AUTH_SOCK: socket,
          SSH_ASKPASS_REQUIRE: 'never',
        }),
      })
      if (added.code !== 0) {
        process.kill(Number(agentPid), 'SIGTERM')
        throw new ReplicateError(
          'bad-auth',
          '私钥读不出来 · 带口令的私钥要先去掉口令 · 或改用口令登录',
        )
      }
      master.push(
        '-o',
        `IdentityAgent=${socket}`,
        '-o',
        'PreferredAuthentications=publickey',
        '-o',
        'BatchMode=yes',
      )
      env = minimalEnv()
    }
    master.push(this.#login())
    try {
      const ran = await runProcess(master, { env, timeoutMs: 60_000 })
      if (ran.code !== 0) throw sshFailure(ran.stderr, this.target)
      this.#open = true
    } finally {
      // The master is authenticated; the key leaves memory with the agent.
      if (agentPid !== null) {
        try {
          process.kill(Number(agentPid), 'SIGTERM')
        } catch {}
      }
      rmSync(join(this.#dir, 'a'), { force: true })
    }
  }

  /** Run a POSIX sh script on the target over the master connection. */
  async sh(
    script: string,
    args: readonly string[] = [],
    options: { readonly input?: string; readonly timeoutMs?: number } = {},
  ): Promise<Ran> {
    const remote = [
      'sh',
      '-c',
      shellQuote(script),
      'qm',
      ...args.map(shellQuote),
    ].join(' ')
    return runProcess(
      [
        ...this.#base(),
        '-o',
        'ControlMaster=no',
        '-T',
        this.#login(),
        '--',
        remote,
      ],
      {
        ...(options.input === undefined ? {} : { input: options.input }),
        timeoutMs: options.timeoutMs ?? 120_000,
      },
    )
  }

  /** Stream a local command's stdout into a remote script's stdin. */
  pipe(
    local: readonly string[],
    script: string,
    args: readonly string[],
    timeoutMs: number,
  ): Promise<Ran> {
    return new Promise(resolve => {
      const remote = [
        'sh',
        '-c',
        shellQuote(script),
        'qm',
        ...args.map(shellQuote),
      ].join(' ')
      const [command, ...rest] = local
      const producer = spawn(command ?? 'false', rest, {
        env: minimalEnv(),
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      const [sshCommand, ...sshArgs] = [
        ...this.#base(),
        '-o',
        'ControlMaster=no',
        '-T',
        this.#login(),
        '--',
        remote,
      ]
      const consumer = spawn(sshCommand ?? 'ssh', sshArgs, {
        env: minimalEnv(),
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      let stderr = ''
      let localErr = ''
      producer.stderr.on('data', (chunk: Buffer) => {
        localErr += chunk.toString('utf8')
      })
      consumer.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8')
      })
      consumer.stdout.resume()
      producer.stdout.pipe(consumer.stdin)
      consumer.stdin.on('error', () => {})
      let producerCode: number | null = null
      producer.on('close', code => {
        producerCode = code ?? 1
      })
      const timer = setTimeout(() => {
        producer.kill('SIGKILL')
        consumer.kill('SIGKILL')
      }, timeoutMs)
      consumer.on('close', code => {
        clearTimeout(timer)
        const failed = producerCode !== null && producerCode !== 0
        resolve({
          code: failed ? 1 : (code ?? 1),
          stdout: '',
          stderr: failed ? `本机打包失败：${lastLines(localErr, 2)}` : stderr,
        })
      })
    })
  }

  async close(): Promise<void> {
    if (this.#open) {
      await runProcess([...this.#base(), '-O', 'exit', this.#login()], {
        timeoutMs: 15_000,
      })
      this.#open = false
    }
    rmSync(this.#dir, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// inspect

const PROBE_SCRIPT = `
printf 'os=%s\\n' "$(uname -s 2>/dev/null)"
printf 'arch=%s\\n' "$(uname -m 2>/dev/null)"
printf 'kernel=%s\\n' "$(uname -r 2>/dev/null)"
printf 'hostname=%s\\n' "$(uname -n 2>/dev/null)"
printf 'home=%s\\n' "$HOME"
printf 'user=%s\\n' "$(id -un 2>/dev/null)"
if [ -r /proc/meminfo ]; then
  awk '/^MemTotal:/{printf "mem_kb=%s\\n",$2} /^MemAvailable:/{printf "avail_kb=%s\\n",$2}' /proc/meminfo
fi
df -Pk "$HOME" 2>/dev/null | awk 'NR==2{printf "disk_kb=%s\\n",$4}'
for t in tar gzip git ssh-keygen; do command -v "$t" >/dev/null 2>&1 && printf 'has_%s=1\\n' "$t"; done
if command -v bun >/dev/null 2>&1 || [ -x "$HOME/.bun/bin/bun" ]; then printf 'has_bun=1\\n'; fi
if getconf GNU_LIBC_VERSION >/dev/null 2>&1; then printf 'libc=glibc\\n'; fi
[ -e "$HOME/qianmo-beta" ] && printf 'root=1\\n'
[ -e "$HOME/atlas-beta" ] && printf 'tree=1\\n'
exit 0
`

interface Probe {
  readonly os: string
  readonly arch: string
  readonly kernel: string
  readonly hostname: string
  readonly home: string
  readonly user: string
  readonly memMb: number
  readonly availMb: number
  readonly diskMb: number
  readonly libc: string
  readonly tools: ReadonlySet<string>
  readonly existing: boolean
}

/** A name a person would recognise the machine by; `localhost` is not one. */
function usableHostname(raw: string): string {
  return /^[A-Za-z0-9][A-Za-z0-9.-]{0,62}$/.test(raw) &&
    !/^localhost(\.|$)/i.test(raw)
    ? raw
    : ''
}

function parseProbe(stdout: string): Probe {
  const values = new Map<string, string>()
  for (const line of stdout.split('\n')) {
    const at = line.indexOf('=')
    if (at > 0) values.set(line.slice(0, at), line.slice(at + 1).trim())
  }
  const kb = (name: string): number =>
    Math.floor(Number(values.get(name) ?? 0) / 1024)
  return {
    os: values.get('os') ?? '',
    arch: values.get('arch') ?? '',
    kernel: values.get('kernel') ?? '',
    hostname: usableHostname(values.get('hostname') ?? ''),
    home: values.get('home') ?? '',
    user: values.get('user') ?? '',
    memMb: kb('mem_kb'),
    availMb: kb('avail_kb'),
    diskMb: kb('disk_kb'),
    libc: values.get('libc') ?? '',
    tools: new Set(
      ['tar', 'gzip', 'git', 'ssh-keygen', 'bun'].filter(
        tool => values.get(`has_${tool}`) === '1',
      ),
    ),
    existing: values.get('root') === '1' || values.get('tree') === '1',
  }
}

/** The binary of the hub's own tree: `qm-<platform>-<arch>`, as beta-deploy names it. */
export function hubBinaryName(): string {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
  return `qm-${process.platform}-${arch}`
}

/** `uname -m` of a machine the hub's binary runs on. */
function hubMachine(): string {
  return process.arch === 'arm64' ? 'aarch64' : 'x86_64'
}

/**
 * The bun the hub's own scripts run on. The node leg's scripts require bun on
 * PATH even in the deployment form (`beta_require_qm`), so a target without
 * one gets a copy of this file.
 */
export function findHubBun(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const dirs = (env.PATH ?? '').split(':').filter(dir => dir.startsWith('/'))
  if (env.HOME !== undefined) dirs.push(join(env.HOME, '.bun', 'bin'))
  for (const dir of dirs) {
    const candidate = join(dir, 'bun')
    try {
      accessSync(candidate, constants.X_OK)
      const real = realpathSync(candidate)
      if (statSync(real).isFile()) return real
    } catch {}
  }
  return null
}

/** Remote scripts see the bun this job may have installed. */
const REMOTE_PATH = 'PATH="$HOME/.bun/bin:$PATH"; export PATH; '

/** 700 MB: an idle node is ~145 MB, one model child ~240 MB on top (beta-deployment). */
const MIN_MEM_MB = 700
const MIN_DISK_MB = 1024

function verdict(probe: Probe, hubBun: string | null): string | null {
  const os = process.platform === 'linux' ? 'Linux' : process.platform
  if (probe.os !== os)
    return `目标是 ${probe.os || '未知系统'} · 中枢只能复制到 ${os}`
  if (probe.arch !== hubMachine())
    return `目标架构是 ${probe.arch || '未知'} · 中枢的部署树是 ${hubMachine()}`
  if (probe.os === 'Linux' && probe.libc !== 'glibc')
    return '目标不是 glibc 系统'
  // git: the node leg makes each agent's workspace a git repository.
  for (const tool of ['tar', 'gzip', 'git']) {
    if (!probe.tools.has(tool)) return `目标机缺 ${tool}`
  }
  if (!probe.tools.has('bun') && hubBun === null)
    return '目标机没有 bun · 中枢这边也找不到可以带过去的 bun'
  if (probe.existing)
    return '目标账号下已经有阡陌部署（~/qianmo-beta 或 ~/atlas-beta）'
  if (probe.memMb > 0 && probe.memMb < MIN_MEM_MB)
    return `内存 ${probe.memMb} MB · 至少要 ${MIN_MEM_MB} MB`
  if (probe.diskMb > 0 && probe.diskMb < MIN_DISK_MB)
    return `家目录可用磁盘 ${probe.diskMb} MB · 至少要 ${MIN_DISK_MB} MB`
  if (!/^\/[A-Za-z0-9._/-]+$/.test(probe.home))
    return '目标账号的家目录路径不合法'
  return null
}

export async function inspect(
  request: InspectRequest,
): Promise<InspectReport | ReplicateFailure> {
  const keys = await scanHostKeys(request.target)
  if (keys.length === 0)
    return refuse(
      'unreachable',
      `读不到 ${request.target.host}:${request.target.port} 的主机公钥`,
    )
  const session = new BootstrapSession(request.target)
  try {
    session.pin(keys.map(key => key.line))
    await session.open(request.auth)
    const probed = await session.sh(PROBE_SCRIPT, [], { timeoutMs: 30_000 })
    if (probed.code !== 0)
      return refuse('probe', `检查失败：${lastLines(probed.stderr, 2)}`)
    const probe = parseProbe(probed.stdout)
    const reason = verdict(probe, findHubBun())
    return {
      ok: true,
      hostKeys: keys.map(({ type, fingerprint }) => ({ type, fingerprint })),
      os: probe.os,
      arch: probe.arch,
      kernel: probe.kernel,
      ...(probe.hostname === '' ? {} : { hostname: probe.hostname }),
      memMb: probe.memMb,
      availMb: probe.availMb,
      diskMb: probe.diskMb,
      existing: probe.existing,
      supported: reason === null,
      ...(reason === null ? {} : { reason }),
    }
  } catch (error) {
    if (error instanceof ReplicateError)
      return refuse(error.code, error.message)
    throw error
  } finally {
    await session.close()
  }
}

// ---------------------------------------------------------------------------
// run

export const STEPS = [
  'pin',
  'login',
  'probe',
  'prepare',
  'payload',
  'secrets',
  'start',
  'register',
  'enroll',
  'restart',
  'ready',
] as const
export type ReplicateStep = (typeof STEPS)[number] | 'rollback' | 'done'

export interface ReplicateEvent {
  readonly at: string
  readonly job: string
  readonly step: ReplicateStep
  readonly state: 'start' | 'ok' | 'fail' | 'info'
  readonly detail?: string
  /** On `done`: the new agent's address. */
  readonly address?: string
  readonly node?: string
  readonly agent?: string
  readonly host?: string
}

export function jobLogDir(root: string): string {
  return join(root, 'state', 'replicate')
}

/** Where the console keeps the digest of a job's model grant (`consoleReplicate.ts`). */
export function modelsGrantFile(root: string, job: string): string {
  return join(jobLogDir(root), `${job}.models`)
}

type Undo = { readonly what: string; run(): Promise<void> }

class Job {
  readonly #log: string
  readonly #undo: Undo[] = []
  #step: ReplicateStep = 'pin'

  constructor(readonly request: RunRequest) {
    const dir = jobLogDir(request.root)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    this.#log = join(dir, `${request.job}.ndjson`)
  }

  emit(
    step: ReplicateStep,
    state: ReplicateEvent['state'],
    detail?: string,
    extra: Partial<ReplicateEvent> = {},
  ): void {
    const event: ReplicateEvent = {
      at: new Date().toISOString(),
      job: this.request.job,
      step,
      state,
      ...(detail === undefined ? {} : { detail }),
      ...extra,
    }
    const line = `${JSON.stringify(event)}\n`
    appendFileSync(this.#log, line, { mode: 0o600 })
    process.stdout.write(line)
  }

  async step<T>(step: ReplicateStep, work: () => Promise<T>): Promise<T> {
    this.#step = step
    this.emit(step, 'start')
    const value = await work()
    this.emit(step, 'ok')
    return value
  }

  undo(what: string, run: () => Promise<void>): void {
    this.#undo.push({ what, run })
  }

  /** The point after which a failure is reported, not reverted. */
  commit(): void {
    this.#undo.length = 0
  }

  get current(): ReplicateStep {
    return this.#step
  }

  async rollback(): Promise<void> {
    for (const entry of this.#undo.reverse()) {
      try {
        await entry.run()
        this.emit('rollback', 'info', `已撤回：${entry.what}`)
      } catch (error) {
        this.emit(
          'rollback',
          'fail',
          `撤不回：${entry.what}（${error instanceof Error ? error.message : String(error)}）`,
        )
      }
    }
    this.#undo.length = 0
  }
}

function hubScript(request: RunRequest, name: string): string {
  return join(request.tree, 'demo', 'env', 'beta', 'ops', name)
}

function hubEnv(request: RunRequest): Record<string, string> {
  return minimalEnv({ QIANMO_BETA_ROOT: request.root })
}

async function hub(
  request: RunRequest,
  script: string,
  args: readonly string[],
  options: { readonly input?: string; readonly timeoutMs?: number } = {},
): Promise<Ran> {
  return runProcess(['bash', hubScript(request, script), ...args], {
    env: hubEnv(request),
    ...(options.input === undefined ? {} : { input: options.input }),
    timeoutMs: options.timeoutMs ?? 120_000,
  })
}

function must(ran: Ran, what: string): Ran {
  if (ran.code !== 0)
    throw new ReplicateError(
      'step',
      `${what}失败：${lastLines(`${ran.stderr}\n${ran.stdout}`, 3)}`,
    )
  return ran
}

function fields(stdout: string, tag: string): string[] {
  return stdout
    .split('\n')
    .filter(line => line.startsWith(`${tag} `))
    .map(line => line.slice(tag.length + 1))
}

function tcpOpen(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = connect({ host: '127.0.0.1', port })
    const done = (value: boolean) => {
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(3000, () => done(false))
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
  })
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

async function waitFor(
  check: () => Promise<boolean>,
  timeoutMs: number,
): Promise<boolean> {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    if (await check()) return true
    await sleep(2000)
  }
  return false
}

/** Pin the confirmed host keys where the hub's tunnel and mirror look (`~/.ssh/known_hosts`). */
function pinForTunnel(lines: readonly string[]): string[] {
  const home = process.env.HOME
  if (home === undefined) return []
  const dir = join(home, '.ssh')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const file = join(dir, 'known_hosts')
  const current = existsSync(file) ? readFileSync(file, 'utf8') : ''
  const have = new Set(current.split('\n'))
  const added = lines.filter(line => !have.has(line))
  if (added.length === 0) return []
  const lead = current === '' || current.endsWith('\n') ? '' : '\n'
  appendFileSync(file, `${lead}${added.join('\n')}\n`, { mode: 0o600 })
  return added
}

/** Drop exactly these lines from a file (tmp + rename); a missing file is fine. */
function dropLines(file: string, lines: readonly string[]): void {
  if (lines.length === 0 || !existsSync(file)) return
  const drop = new Set(lines)
  const kept = readFileSync(file, 'utf8')
    .split('\n')
    .filter(line => !drop.has(line))
    .join('\n')
  const tmp = `${file}.qm-replicate-${process.pid}`
  writeFileSync(tmp, kept, { mode: 0o600 })
  renameSync(tmp, file)
}

/** Remove exact lines from the target's authorized_keys. */
const DROP_AUTHORIZED = `
f="$HOME/.ssh/authorized_keys"
[ -f "$f" ] || exit 0
t="$f.qm-replicate.$$"
cp -p "$f" "$t"
for line in "$@"; do
  grep -vxF -- "$line" "$t" > "$t.n" || true
  mv "$t.n" "$t"
done
chmod 600 "$t"
mv "$t" "$f"
`

export async function runJob(request: RunRequest): Promise<number> {
  const job = new Job(request)
  const target = request.target
  const session = new BootstrapSession(target)
  const binary = hubBinaryName()
  const bun = findHubBun()
  const failedStamp = stamp()
  let home = ''
  let needsBun = false
  try {
    const keys = await job.step('pin', async () => {
      const scanned = await scanHostKeys(target)
      const confirmed = scanned.filter(
        key => key.fingerprint === request.hostKey,
      )
      if (confirmed.length === 0)
        throw new ReplicateError(
          'host-key',
          '主机指纹和确认时的不一样 · 没有继续',
        )
      // Only the confirmed key: other types the server offers are not pinned.
      session.pin(confirmed.map(key => key.line))
      return confirmed
    })
    await job.step('login', () => session.open(request.auth))
    await job.step('probe', async () => {
      const probed = await session.sh(PROBE_SCRIPT, [], { timeoutMs: 30_000 })
      if (probed.code !== 0) throw new ReplicateError('probe', '检查失败')
      const probe = parseProbe(probed.stdout)
      const reason = verdict(probe, bun)
      if (reason !== null) throw new ReplicateError('unsupported', reason)
      home = probe.home
      needsBun = !probe.tools.has('bun')
    })
    const trail = `${home}/qianmo-beta/nodes/${request.node}/config/qianmo/audit/trail.ndjson`
    const prepared = await job.step('prepare', async () => {
      must(await hub(request, 'replicate-hub.sh', ['check']), '中枢自检')
      const ran = must(
        await hub(request, 'replicate-hub.sh', [
          'prepare',
          '--node',
          request.node,
          '--agent',
          request.agent,
        ]),
        '中枢准备',
      )
      job.undo('中枢上的登记 PSK 与链路 key', async () => {
        must(
          await hub(request, 'replicate-hub.sh', [
            'discard',
            '--node',
            request.node,
          ]),
          '撤回中枢记录',
        )
      })
      const localPort = Number(fields(ran.stdout, 'LOCAL_PORT')[0])
      const linkPub = fields(ran.stdout, 'LINK_PUBKEY')[0] ?? ''
      const pskFile = fields(ran.stdout, 'PSK_FILE')[0] ?? ''
      if (!Number.isInteger(localPort) || linkPub === '' || pskFile === '')
        throw new ReplicateError('step', '中枢准备的输出不完整')
      return {
        localPort,
        linkPub,
        pskFile,
        nodeArgs: fields(ran.stdout, 'NODE_ARG'),
      }
    })
    const version = must(
      await runProcess([join(request.tree, 'dist', binary), '--version'], {
        timeoutMs: 30_000,
      }),
      '读中枢版本',
    ).stdout.trim()
    await job.step('payload', async () => {
      const staging = `atlas-beta.replicate-${request.job}`
      job.undo('目标机上的部署树', async () => {
        await session.sh(
          'cd "$HOME" || exit 0; [ -e atlas-beta ] && mv atlas-beta "atlas-beta.failed-$1"; rm -rf "$2"; exit 0',
          [failedStamp, staging],
        )
      })
      const ran = await session.pipe(
        ['tar', '-C', request.tree, '-czf', '-', 'dist', 'demo'],
        'set -e; cd "$HOME"; mkdir -m 700 "$1"; tar -xzf - -C "$1"; mv "$1" atlas-beta',
        [staging],
        30 * 60_000,
      )
      if (ran.code !== 0)
        throw new ReplicateError(
          'payload',
          `复制部署树失败：${lastLines(ran.stderr, 2)}`,
        )
      if (needsBun && bun !== null) {
        job.undo('目标机上带过去的 bun', async () => {
          await session.sh(
            'rm -f "$HOME/.bun/bin/bun"; rmdir "$HOME/.bun/bin" "$HOME/.bun" 2>/dev/null; exit 0',
          )
        })
        const shipped = await session.pipe(
          ['gzip', '-1', '-c', bun],
          'set -e; mkdir -p "$HOME/.bun/bin"; gzip -dc > "$HOME/.bun/bin/bun.qm-tmp"; chmod 755 "$HOME/.bun/bin/bun.qm-tmp"; mv "$HOME/.bun/bin/bun.qm-tmp" "$HOME/.bun/bin/bun"',
          [],
          30 * 60_000,
        )
        if (shipped.code !== 0)
          throw new ReplicateError(
            'payload',
            `复制 bun 失败：${lastLines(shipped.stderr, 2)}`,
          )
        must(await session.sh(`${REMOTE_PATH}bun --version`), '目标机试跑 bun')
      }
      const remote = must(
        await session.sh('"$HOME/atlas-beta/dist/$1" --version', [binary], {
          timeoutMs: 60_000,
        }),
        '目标机试跑 qm',
      ).stdout.trim()
      if (remote !== version)
        throw new ReplicateError('payload', `目标机上的版本对不上：${remote}`)
    })
    const linkLine =
      `restrict,port-forwarding,permitopen="127.0.0.1:${NODE_PORT}",command="cat -- ${trail}" ` +
      `${prepared.linkPub} qianmo-link ${request.node}`
    const installed: string[] = []
    await job.step('secrets', async () => {
      job.undo('目标机上的内测根', async () => {
        await session.sh(
          `${REMOTE_PATH}cd "$HOME" || exit 0; ` +
            '[ -x atlas-beta/demo/env/beta/beta-down.sh ] && atlas-beta/demo/env/beta/beta-down.sh "$2" >/dev/null 2>&1; ' +
            '[ -e qianmo-beta ] && mv qianmo-beta "qianmo-beta.failed-$1"; exit 0',
          [failedStamp, request.node],
          { timeoutMs: 120_000 },
        )
      })
      must(
        await session.sh(
          'set -e; umask 077; mkdir -p "$HOME/qianmo-beta/secrets"; chmod 700 "$HOME/qianmo-beta" "$HOME/qianmo-beta/secrets"; cat > "$HOME/qianmo-beta/secrets/transport-psk"',
          [],
          { input: readFileSync(prepared.pskFile, 'utf8').trim() },
        ),
        '写入 PSK',
      )
      job.undo('目标机 authorized_keys 里加的两行', async () => {
        must(
          await session.sh(DROP_AUTHORIZED, installed),
          '撤回 authorized_keys',
        )
      })
      must(
        await session.sh(
          'set -e; umask 077; mkdir -p "$HOME/.ssh"; chmod 700 "$HOME/.ssh"; touch "$HOME/.ssh/authorized_keys"; ' +
            'grep -qxF -- "$1" "$HOME/.ssh/authorized_keys" || printf \'%s\\n\' "$1" >> "$HOME/.ssh/authorized_keys"; chmod 600 "$HOME/.ssh/authorized_keys"',
          [linkLine],
        ),
        '登记链路 key',
      )
      installed.push(linkLine)
    })
    const publicKey = await job.step('start', async () => {
      const ran = await session.sh(
        `${REMOTE_PATH}node="$1"; agent="$2"; shift 2; ` +
          'QIANMO_BETA_NODE_BIND=127.0.0.1 "$HOME/atlas-beta/demo/env/beta/beta-up.sh" --role node --node "$node" --agent "$agent" -- "$@"',
        [request.node, request.agent, ...prepared.nodeArgs],
        { timeoutMs: 240_000 },
      )
      if (ran.code !== 0)
        throw new ReplicateError(
          'start',
          `节点起不来：${lastLines(ran.stdout, 4)}`,
        )
      const banner = must(
        await session.sh('head -n 1 "$HOME/qianmo-beta/logs/$1.out"', [
          request.node,
        ]),
        '读节点身份',
      ).stdout
      const key = /"publicKey":"([A-Za-z0-9_-]{43})"/.exec(banner)?.[1]
      if (key === undefined)
        throw new ReplicateError('start', '节点起来了 · 但读不到它的公钥')
      return key
    })
    await job.step('register', async () => {
      must(
        await hub(request, 'replicate-hub.sh', [
          'add',
          '--node',
          request.node,
          '--agent',
          request.agent,
          '--user',
          target.user,
          '--host',
          target.host,
          '--port',
          String(target.port),
          '--local-port',
          String(prepared.localPort),
          '--server',
          request.server,
          '--public-key',
          publicKey,
          '--trail',
          trail,
        ]),
        '登记到中枢',
      )
      const pinned = pinForTunnel(keys.map(key => key.line))
      job.undo('中枢 known_hosts 里这台机器的主机公钥', async () => {
        if (process.env.HOME !== undefined)
          dropLines(join(process.env.HOME, '.ssh', 'known_hosts'), pinned)
      })
    })
    await job.step('enroll', async () => {
      const hubKey = must(
        await hub(request, 'model-apply-enroll.sh', [
          'hub-key',
          '--node',
          request.node,
        ]),
        '生成模型下发 key',
      ).stdout
      const pubLine =
        hubKey.split('\n').find(line => line.startsWith('PUBKEY ')) ?? ''
      const fresh = hubKey.split('\n').find(line => line.startsWith('NEW '))
      if (fresh !== undefined) {
        const top = fresh.startsWith('NEW key+dir ')
          ? fresh.slice('NEW key+dir '.length)
          : ''
        job.undo('中枢上的模型下发 key', async () => {
          must(
            await hub(
              request,
              'model-apply-enroll.sh',
              [
                'hub-key-discard',
                '--node',
                request.node,
                ...(top === '' ? [] : ['--with-dir', top]),
              ],
              { input: `${pubLine}\n` },
            ),
            '撤回模型下发 key',
          )
        })
      }
      const nodeInstall = must(
        await session.sh(
          `${REMOTE_PATH}"$HOME/atlas-beta/demo/env/beta/ops/model-apply-enroll.sh" node-install --node "$1" --user "$2"`,
          [request.node, target.user],
          { input: `${pubLine}\n` },
        ),
        '登记模型下发 key',
      ).stdout
      const line = /^(?:INSTALLED|PRESENT) (.+)$/m.exec(nodeInstall)?.[1]
      if (line !== undefined) installed.push(line)
      const hostKeys = must(
        await session.sh(
          `${REMOTE_PATH}"$HOME/atlas-beta/demo/env/beta/ops/model-apply-enroll.sh" node-hostkey`,
        ),
        '读主机公钥',
      ).stdout
      const registered = must(
        await hub(
          request,
          'model-apply-enroll.sh',
          ['hub-known-host', '--node', request.node],
          {
            input: hostKeys,
            timeoutMs: 120_000,
          },
        ),
        '登记主机公钥',
      ).stdout
      const added = registered
        .split('\n')
        .filter(entry => entry.startsWith('REGISTERED '))
        .map(entry => entry.slice('REGISTERED '.length))
      job.undo('模型下发 known_hosts 里的主机公钥', async () => {
        dropLines(modelKnownHosts(), added)
      })
    })
    await job.step('restart', async () => {
      // From here the node is wired into the hub; a later failure is reported, not reverted.
      job.commit()
      must(
        await hub(request, 'replicate-hub.sh', ['restart'], {
          timeoutMs: 240_000,
        }),
        '重启中枢',
      )
    })
    await job.step('ready', async () => {
      const tunnel = await waitFor(() => tcpOpen(prepared.localPort), 90_000)
      if (!tunnel)
        throw new ReplicateError(
          'ready',
          `隧道没有起来（回环口 ${prepared.localPort}）`,
        )
      const consoleUp = await waitFor(async () => {
        try {
          return (await fetch(`${request.consoleUrl}/v0/health`)).ok
        } catch {
          return false
        }
      }, 90_000)
      // The node is up and wired either way; the profile can be applied later.
      if (!consoleUp)
        job.emit('ready', 'info', '控制台还没回来 · 模型档案请稍后在模型页下发')
      else job.emit('ready', 'info', await shipModels(request))
    })
    const address = `qianmo://${request.node}/${request.agent}`
    job.emit('done', 'ok', undefined, {
      address,
      node: request.node,
      agent: request.agent,
      host: target.host,
    })
    return 0
  } catch (error) {
    const message =
      error instanceof ReplicateError
        ? error.message
        : error instanceof Error
          ? error.message
          : String(error)
    job.emit(job.current, 'fail', message)
    await job.rollback()
    return 1
  } finally {
    // An unspent grant dies with the job that held it.
    rmSync(modelsGrantFile(request.root, request.job), { force: true })
    await session.close()
  }
}

const MODELS_RETRY = '可在模型页再下发一次'

/**
 * The last step's apply: hand the grant back to the console, which ships the
 * node's profile as the operator who started the job. The line it returns is
 * what the card shows under 等待就绪.
 */
export async function shipModels(
  request: Pick<RunRequest, 'consoleUrl' | 'job' | 'node' | 'models'>,
  fetcher: typeof fetch = fetch,
): Promise<string> {
  if (request.models === undefined)
    return '这次部署不是运维个人账号发起的 · 模型档案请运维在模型页下发'
  let response: Response
  try {
    response = await fetcher(
      `${request.consoleUrl}/v0/replicate/jobs/${encodeURIComponent(request.job)}/models`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ grant: request.models }),
        signal: AbortSignal.timeout(120_000),
      },
    )
  } catch {
    return `模型档案没有下发成功 · 控制台没有回应 · ${MODELS_RETRY}`
  }
  let body: unknown = null
  try {
    body = await response.json()
  } catch {}
  const answer = object(body)
  if (!response.ok) {
    const message = object(answer?.error)?.message
    return `模型档案没有下发成功 · ${
      typeof message === 'string' && message !== ''
        ? message.slice(0, 200)
        : `控制台回了 ${response.status}`
    } · ${MODELS_RETRY}`
  }
  const results = Array.isArray(answer?.results) ? answer.results : []
  const mine = results.map(object).find(one => one?.node === request.node)
  if (mine?.outcome === 'ok') return '模型档案已下发'
  const message = mine?.message
  return `模型档案没有下发成功 · ${
    typeof message === 'string' && message !== ''
      ? message.slice(0, 200)
      : '节点没有回报结果'
  } · ${MODELS_RETRY}`
}

/** The node's inbound port: beta-up's default, which the replicated node keeps. */
const NODE_PORT = 38625

function modelKnownHosts(): string {
  const dir =
    process.env.QIANMO_BETA_MODEL_KEY_DIR ??
    join(process.env.HOME ?? '/nonexistent', '.ssh', 'qianmo-model-apply')
  return join(dir, 'known_hosts')
}

function stamp(): string {
  return new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z')
}

/** A fresh job id: time-sortable, unguessable enough for a file name. */
export function newJobId(now = Date.now()): string {
  return `${now.toString(36)}-${randomBytes(4).toString('hex')}`
}

// ---------------------------------------------------------------------------
// CLI

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

/** Read the request file and remove it before anything else happens. */
function takeRequestFile(path: string): string {
  const fd = openSync(path, 'r')
  try {
    return readFileSync(fd, 'utf8')
  } finally {
    closeSync(fd)
    unlinkSync(path)
  }
}

const HELP = `Usage:
  qm replicate inspect               read one JSON request on stdin, print one JSON report
  qm replicate run --request <file>  run one copy job; the request file is removed on read
`

export async function run(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv
  if (sub === 'inspect') {
    let body: unknown
    try {
      body = JSON.parse(await readStdin())
    } catch {
      process.stdout.write(
        `${JSON.stringify(refuse('bad-request', '请求不是 JSON'))}\n`,
      )
      return 1
    }
    const parsed = parseInspectRequest(body)
    if (!parsed.ok) {
      process.stdout.write(`${JSON.stringify(parsed)}\n`)
      return 1
    }
    const report = await inspect(parsed.value)
    process.stdout.write(`${JSON.stringify(report)}\n`)
    return report.ok ? 0 : 1
  }
  if (sub === 'run') {
    const at = rest.indexOf('--request')
    const file = at >= 0 ? rest[at + 1] : undefined
    if (file === undefined) {
      process.stderr.write(HELP)
      return 2
    }
    let body: unknown
    try {
      body = JSON.parse(takeRequestFile(file))
    } catch {
      process.stderr.write('replicate: 请求文件读不出来\n')
      return 1
    }
    const parsed = parseRunRequest(body)
    if (!parsed.ok) {
      process.stderr.write(`replicate: ${parsed.reason}\n`)
      return 1
    }
    return runJob(parsed.value)
  }
  process.stdout.write(HELP)
  return sub === undefined || sub === '--help' || sub === '-h' ? 0 : 2
}
