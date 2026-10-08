// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `qm handoff attach [taskId]` — join a task running in the cloud from this
 * machine (`handoff-p17-plan.md` §2 P17.6, D-6; AC-H4 「远程直连」).
 *
 * ## Steps
 *
 * 1. Ask the hub where the task runs: `POST /v0/handoff/<task>/attach`, which
 *    answers only for a `running` task and writes `handoff.attach-requested`.
 *    It gives the node and the thread — and nothing secret.
 * 2. Read the node's app-server token over **the user's own SSH**
 *    (`ssh <target> cat -- <file>`; the user's `~/.ssh/config`, keys and
 *    prompts apply). The token goes into this process's memory and from there
 *    into one place only: the environment of the `qmcode` child, under
 *    {@link ATTACH_TOKEN_ENV}. Never an argument, a file, a log line, the hub.
 * 3. Open the tunnel: `ssh -N -L 127.0.0.1:<local>:127.0.0.1:<app-server port>
 *    -o ExitOnForwardFailure=yes`. The local port is tried first (a port held
 *    by somebody else would otherwise answer the readiness check in ssh's
 *    stead); the tunnel is ready when the app-server's `/readyz` answers 200
 *    through it.
 * 4. The thread: from the hub for a qmcode session (the node resumed the
 *    laptop's own thread). For a Claude Code session the node imported a new
 *    thread whose id reaches the hub only with the result, so it is looked up
 *    through the tunnel — the app-server's loaded threads, the one whose
 *    working directory is the bridge's `…/work/<task>`.
 * 5. `qmcode resume --remote ws://127.0.0.1:<local> --remote-auth-token-env
 *    QIANMO_ATTACH_TOKEN <thread>` with the terminal. No `--cd`: the thread
 *    keeps the node's working directory (probe 第 5 项).
 * 6. When qmcode exits the tunnel is closed — on every other way out as well:
 *    an error, SIGTERM or SIGHUP (passed on to qmcode first). A SIGINT while
 *    qmcode runs is qmcode's (the terminal's Ctrl-C), not this process's.
 *    For the one exit no handler sees, SIGKILL, a small `sh` watchdog holds
 *    the read end of a pipe from this process and stops the tunnel when the
 *    pipe closes.
 *
 * ## What the probe and this package measured about the terminal
 *
 * With the fork's 0.158.0 release build against a local app-server (2026-10-04,
 * the opt-in `tests/integration/qianmo-handoff-attach-qmcode.test.ts`, which
 * runs this command with the real terminal): a turn started from the attached
 * terminal ran with the **node thread's** approval policy and sandbox even
 * when this machine's `config.toml` said otherwise, in both directions
 * (stricter and `danger-full-access`); and text that arrives as one burst
 * followed at once by Enter is treated as a paste (`tui/src/bottom_pane/
 * paste_burst.rs`: three or more characters under 8 ms apart, Enter within
 * 120 ms becomes a newline), so it takes a second Enter. Typed text, or
 * bracketed paste, submits with one.
 */

import type { Subprocess } from 'bun'
import { get } from 'node:http'
import { createServer } from 'node:net'
import { AppServerClient, isTaskId } from '@qianmo/handoff'
import { buildVersion } from '../../constants/buildProvenance.js'
import { gitTopLevel, remoteRoot } from './handoffHub.js'
import {
  type ConsoleAccess,
  consoleError,
  consoleRequest,
  hubTasks,
  type Output,
  PROCESS_OUTPUT,
} from './handoffNow.js'
import {
  defaultDeviceName,
  type HandoffProject,
  HandoffUserError,
  isRemotePath,
  isSshTarget,
  loadProject,
  sleep,
} from './handoffStore.js'

/** The variable that carries the node's token into `qmcode` and nowhere else. */
export const ATTACH_TOKEN_ENV = 'QIANMO_ATTACH_TOKEN'

/** Where `demo/env/beta/handoff-node.sh` keeps the token, under the node's home. */
const DEFAULT_NODE_TOKEN_FILE = 'qianmo-beta/secrets/handoff-app-server-token'
/** `handoff-node.sh --app-server-port` default. */
const DEFAULT_APP_SERVER_PORT = 38_631
const READY_TIMEOUT_MS = 20_000
const READY_POLL_MS = 200
const TUNNEL_STOP_GRACE_MS = 3_000
const QMCODE_STOP_GRACE_MS = 5_000
/** A capability token is a short run of printable ASCII. */
const TOKEN = /^[\x21-\x7e]{8,4096}$/

export interface AttachOptions {
  readonly taskId?: string
  /** `--ssh`: how this machine reaches the node; default the node's name. */
  readonly sshTarget?: string
  /** `--node-token-file`: the token on the node; relative is under its home. */
  readonly nodeTokenFile?: string
  readonly appServerPort?: number
  readonly localPort?: number
  /** `--console` + `--token-file`: the hub, outside a registered repository. */
  readonly console?: string
  readonly tokenFile?: string
}

/** The programs attach runs; tests put stand-ins here. */
export interface AttachCommands {
  readonly ssh: string
  readonly qmcode: string
  readonly sh: string
}

const SYSTEM_COMMANDS: AttachCommands = {
  ssh: 'ssh',
  qmcode: 'qmcode',
  sh: '/bin/sh',
}

/** Knobs for tests. */
interface AttachTiming {
  readonly readyTimeoutMs?: number
}

interface HubAccess extends ConsoleAccess {
  /** The registered repository this runs in, if any. */
  readonly project?: HandoffProject
}

interface Locator {
  readonly taskId: string
  readonly node: string
  readonly threadId: string | null
  readonly tool: string
}

async function hubAccess(
  cwd: string,
  options: AttachOptions,
): Promise<HubAccess> {
  if (options.console !== undefined && options.tokenFile !== undefined) {
    return { console: options.console, tokenFile: options.tokenFile }
  }
  const root = await gitTopLevel(cwd)
  const project = root === null ? undefined : loadProject(root)
  if (project === undefined) {
    throw new HandoffUserError(
      `${cwd} 不在登记过接力的仓库里 · 在别的机器上接入要给 --console <控制台> --token-file <凭据文件>`,
    )
  }
  return { console: project.console, tokenFile: project.tokenFile, project }
}

/** Without a task id: the one running task (of this project, in a registered repository). */
async function runningTask(where: HubAccess): Promise<string> {
  const tasks = (await hubTasks(where)).filter(
    task =>
      where.project === undefined || task.project === where.project.project,
  )
  const running = tasks.filter(task => task.state === 'running')
  if (running.length === 1 && running[0] !== undefined) return running[0].taskId
  const scope =
    where.project === undefined ? '中枢上' : `本项目 ${where.project.project}`
  if (running.length === 0) {
    const latest = tasks[0]
    throw new HandoffUserError(
      latest === undefined
        ? `${scope}没有在云端运行的任务`
        : `${scope}没有在云端运行的任务 · 最近的 ${latest.taskId} 是 ${latest.state}${latest.state === 'done' ? ' · 用 qm handoff pull 接回' : ''}`,
    )
  }
  throw new HandoffUserError(
    `${scope}有 ${running.length} 个任务在云端运行（${running.map(task => task.taskId).join(' · ')}）· 给出要接入的任务号`,
  )
}

async function locate(where: HubAccess, taskId: string): Promise<Locator> {
  const device = where.project?.device ?? defaultDeviceName()
  const answer = await consoleRequest(
    where,
    'POST',
    `/v0/handoff/${encodeURIComponent(taskId)}/attach`,
    device === null ? {} : { device },
  )
  if (answer.status === 404) {
    throw new HandoffUserError(`中枢台账里没有任务 ${taskId}`)
  }
  const attach = answer.body.attach
  if (answer.status !== 200 || typeof attach !== 'object' || attach === null) {
    throw new HandoffUserError(consoleError(answer))
  }
  const view = attach as Record<string, unknown>
  const node = typeof view.node === 'string' ? view.node : ''
  const threadId = typeof view.threadId === 'string' ? view.threadId : null
  if (node === '') throw new HandoffUserError('中枢的回答里没有节点')
  return {
    taskId,
    node,
    threadId,
    tool: typeof view.tool === 'string' ? view.tool : '',
  }
}

/** Collect a child's stdout as text and its exit code. */
async function finished(
  child: Subprocess<'ignore', 'pipe', 'inherit'>,
): Promise<{ readonly code: number; readonly stdout: string }> {
  const [stdout, code] = await Promise.all([
    new Response(child.stdout).text(),
    child.exited,
  ])
  return { code, stdout }
}

/** The token file on the node, read over the user's own SSH. */
async function readNodeToken(
  commands: AttachCommands,
  target: string,
  node: string,
  path: string,
): Promise<string> {
  let child: Subprocess<'ignore', 'pipe', 'inherit'>
  try {
    child = Bun.spawn(
      [
        commands.ssh,
        '-T',
        '-o',
        'ClearAllForwardings=yes',
        '--',
        target,
        `cat -- ${remoteRoot(path)}`,
      ],
      // `env` given: without it Bun hands over the environment the process
      // started with, not `process.env` as it is now.
      { stdin: 'ignore', stdout: 'pipe', stderr: 'inherit', env: process.env },
    )
  } catch {
    throw new HandoffUserError(
      `找不到 ssh（${commands.ssh}）· 装上 OpenSSH 客户端再试`,
    )
  }
  const { code, stdout } = await finished(child)
  if (code !== 0) {
    throw new HandoffUserError(
      `读不到节点 ${node} 上的 app-server 令牌（ssh ${target} 退出码 ${code}）· 上面是 ssh 的输出 · 节点的 SSH 目标不是 ${target} 时用 --ssh 指定 · 令牌不在 ${path} 时用 --node-token-file 指定`,
    )
  }
  const token = stdout.trim()
  if (!TOKEN.test(token)) {
    throw new HandoffUserError(
      `节点 ${node} 上的 ${path} 不像 app-server 令牌（空的或含空白）· 节点上的 handoff-node.sh 起过吗`,
    )
  }
  return token
}

/** Whether `port` on 127.0.0.1 can be bound now. */
function portFree(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = createServer()
    server.once('error', () => resolve(false))
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)))
  })
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port =
        typeof address === 'object' && address !== null ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

function portTaken(port: number): HandoffUserError {
  return new HandoffUserError(
    `本地端口 ${port} 已被占用 · 换一个 --local-port 或不给它让 qm 自己挑`,
  )
}

/** `/readyz` through the tunnel: the status code, or null for no answer. */
function readyz(port: number): Promise<number | null> {
  return new Promise(resolve => {
    const request = get(
      { host: '127.0.0.1', port, path: '/readyz', timeout: 2_000 },
      response => {
        response.resume()
        resolve(response.statusCode ?? null)
      },
    )
    request.on('error', () => resolve(null))
    request.on('timeout', () => {
      request.destroy()
      resolve(null)
    })
  })
}

interface Tunnel {
  readonly ssh: Subprocess<'ignore', 'ignore', 'pipe'>
  stderr(): string
  close(): Promise<void>
}

/** `ssh -N -L`, and the watchdog that stops it if this process is killed. */
function openTunnel(
  commands: AttachCommands,
  target: string,
  localPort: number,
  remotePort: number,
): Tunnel {
  let ssh: Subprocess<'ignore', 'ignore', 'pipe'>
  try {
    ssh = Bun.spawn(
      [
        commands.ssh,
        '-N',
        '-L',
        `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`,
        '-o',
        'ExitOnForwardFailure=yes',
        '-o',
        'ServerAliveInterval=30',
        '-o',
        'ServerAliveCountMax=3',
        '--',
        target,
      ],
      { stdin: 'ignore', stdout: 'ignore', stderr: 'pipe', env: process.env },
    )
  } catch {
    throw new HandoffUserError(
      `找不到 ssh（${commands.ssh}）· 装上 OpenSSH 客户端再试`,
    )
  }
  let errText = ''
  void (async () => {
    const decoder = new TextDecoder()
    for await (const chunk of ssh.stderr) {
      errText = `${errText}${decoder.decode(chunk)}`.slice(-4_000)
    }
  })().catch(() => {})
  // Holds the read end of a pipe whose write end only this process has: when
  // this process dies in any way, the read returns and the tunnel goes.
  const watchdog = Bun.spawn(
    [
      commands.sh,
      '-c',
      'trap "" INT HUP; read _; kill -TERM "$1" 2>/dev/null; exit 0',
      'qianmo-attach-watchdog',
      String(ssh.pid),
    ],
    { stdin: 'pipe', stdout: 'ignore', stderr: 'ignore' },
  )
  const lastResort = (): void => {
    try {
      process.kill(ssh.pid, 'SIGTERM')
    } catch {}
  }
  process.once('exit', lastResort)
  let closing: Promise<void> | null = null
  return {
    ssh,
    stderr: () => errText,
    close() {
      closing ??= (async () => {
        // The watchdog first: it must not outlive the tunnel and fire at a
        // pid the system has handed to somebody else.
        watchdog.kill('SIGKILL')
        await watchdog.exited
        if (ssh.exitCode === null && ssh.signalCode === null) {
          ssh.kill('SIGTERM')
          const stopped = await Promise.race([
            ssh.exited.then(() => true),
            sleep(TUNNEL_STOP_GRACE_MS).then(() => false),
          ])
          if (!stopped) ssh.kill('SIGKILL')
        }
        await ssh.exited
        process.removeListener('exit', lastResort)
      })()
      return closing
    },
  }
}

/** Until `/readyz` answers 200 through the tunnel, ssh gives up, or time runs out. */
async function waitReady(
  tunnel: Tunnel,
  node: string,
  target: string,
  localPort: number,
  remotePort: number,
  timeoutMs: number,
  cancelled: () => boolean,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let last: number | null = null
  for (;;) {
    if (cancelled()) throw new HandoffUserError('已取消', 130)
    if (tunnel.ssh.exitCode !== null || tunnel.ssh.signalCode !== null) {
      const said = tunnel.stderr()
      if (/Address already in use|cannot listen to port/i.test(said)) {
        throw portTaken(localPort)
      }
      throw new HandoffUserError(
        `开不了到节点 ${node} 的隧道（ssh ${target} 退出码 ${tunnel.ssh.exitCode ?? tunnel.ssh.signalCode}）${
          said.trim() === ''
            ? ''
            : ` · ssh 说：${said.trim().split('\n').slice(-3).join(' / ')}`
        }`,
      )
    }
    last = await readyz(localPort)
    if (last === 200) return
    if (Date.now() > deadline) {
      throw new HandoffUserError(
        `隧道开了但节点 ${node} 上的 app-server 没有回应（127.0.0.1:${remotePort}${last === null ? '' : ` 回 ${last}`}）· 节点上 handoff-node.sh 起了吗 · 端口不是 ${remotePort} 时用 --app-server-port 指定`,
      )
    }
    await sleep(READY_POLL_MS)
  }
}

/** The thread of a task, from the app-server: the one working in `…/work/<task>`. */
async function threadOnNode(
  localPort: number,
  token: string,
  taskId: string,
  node: string,
): Promise<string> {
  const client = await AppServerClient.connect({
    url: `ws://127.0.0.1:${localPort}`,
    token,
    clientName: 'qianmo_handoff_attach',
    clientVersion: buildVersion() ?? '0.0.0',
    requestTimeoutMs: 15_000,
  }).catch(() => {
    throw new HandoffUserError(
      `连不上节点 ${node} 的 app-server（令牌不对或 app-server 刚重启）`,
    )
  })
  try {
    const suffix = `/work/${taskId}`
    for (const id of await client.loadedThreadIds()) {
      const cwd = await client.threadCwd(id)
      if (cwd !== null && cwd.replace(/\/+$/, '').endsWith(suffix)) return id
    }
  } finally {
    client.close()
  }
  throw new HandoffUserError(
    `节点 ${node} 的 app-server 上没有任务 ${taskId} 的线程（工作目录 …${`/work/${taskId}`}）· 任务可能刚结束：qm handoff status --task ${taskId}`,
  )
}

/** Signals that end attach: passed on to qmcode, then the tunnel goes. */
const ENDING_SIGNALS = ['SIGTERM', 'SIGHUP'] as const
const SIGNAL_NUMBER: Readonly<Record<string, number>> = {
  SIGINT: 2,
  SIGHUP: 1,
  SIGTERM: 15,
}

/** `qm handoff attach`. Returns the exit code (qmcode's, once it ran). */
export async function runAttach(
  cwd: string,
  options: AttachOptions,
  output: Output = PROCESS_OUTPUT,
  commands: AttachCommands = SYSTEM_COMMANDS,
  timing: AttachTiming = {},
): Promise<number> {
  if (options.taskId !== undefined && !isTaskId(options.taskId)) {
    throw new HandoffUserError(`${options.taskId} 不是任务号`, 2)
  }
  const tokenPath = options.nodeTokenFile ?? DEFAULT_NODE_TOKEN_FILE
  if (!isRemotePath(tokenPath)) {
    throw new HandoffUserError(
      `--node-token-file ${tokenPath} 不能用 · 只许 A-Z a-z 0-9 . _ ~ / - · 不以 - 开头 · 没有 .. 段`,
      2,
    )
  }
  if (options.sshTarget !== undefined && !isSshTarget(options.sshTarget)) {
    throw new HandoffUserError(
      `--ssh ${options.sshTarget} 不是 SSH 目标（[用户@]主机 或 ~/.ssh/config 里的别名）`,
      2,
    )
  }
  const remotePort = options.appServerPort ?? DEFAULT_APP_SERVER_PORT
  const where = await hubAccess(cwd, options)
  const taskId = options.taskId ?? (await runningTask(where))
  const located = await locate(where, taskId)
  const target = options.sshTarget ?? located.node
  if (!isSshTarget(target)) {
    throw new HandoffUserError(
      `节点名 ${located.node} 不能直接当 SSH 目标 · 用 --ssh 指定`,
      2,
    )
  }
  output.out(
    `接入  任务 ${taskId} · 节点 ${located.node}${located.threadId === null ? '' : ` · 线程 ${located.threadId}`}`,
  )

  const localPort = options.localPort ?? (await freePort())
  if (options.localPort !== undefined && !(await portFree(localPort))) {
    throw portTaken(localPort)
  }
  const token = await readNodeToken(commands, target, located.node, tokenPath)

  let cancelled = false
  let qmcode: Subprocess<'inherit', 'inherit', 'inherit'> | null = null
  let endedBy: string | null = null
  let signalled: () => void = () => {}
  const ending = new Promise<void>(resolve => {
    signalled = resolve
  })
  const onInterrupt = (): void => {
    // While qmcode runs, Ctrl-C is its own; before that, it cancels attach.
    if (qmcode === null) cancelled = true
  }
  const onEnding = (signal: (typeof ENDING_SIGNALS)[number]) => (): void => {
    endedBy ??= signal
    cancelled = true
    qmcode?.kill(signal)
    signalled()
  }
  const enders = ENDING_SIGNALS.map(
    signal => [signal, onEnding(signal)] as const,
  )
  process.on('SIGINT', onInterrupt)
  for (const [signal, handler] of enders) process.on(signal, handler)

  const tunnel = openTunnel(commands, target, localPort, remotePort)
  try {
    await waitReady(
      tunnel,
      located.node,
      target,
      localPort,
      remotePort,
      timing.readyTimeoutMs ?? READY_TIMEOUT_MS,
      () => cancelled,
    )
    const threadId =
      located.threadId ??
      (await threadOnNode(localPort, token, taskId, located.node))
    if (located.threadId === null)
      output.out(`  线程  ${threadId}（向节点 app-server 查到）`)
    output.out(
      `  隧道  127.0.0.1:${localPort} → ${target} 127.0.0.1:${remotePort}`,
    )
    if (cancelled) throw new HandoffUserError('已取消', 130)
    try {
      qmcode = Bun.spawn(
        [
          commands.qmcode,
          'resume',
          '--remote',
          `ws://127.0.0.1:${localPort}`,
          '--remote-auth-token-env',
          ATTACH_TOKEN_ENV,
          threadId,
        ],
        {
          stdin: 'inherit',
          stdout: 'inherit',
          stderr: 'inherit',
          env: { ...process.env, [ATTACH_TOKEN_ENV]: token },
        },
      )
    } catch {
      throw new HandoffUserError(
        `找不到 qmcode（${commands.qmcode}）· 装上阡陌 Codex 并放进 PATH`,
      )
    }
    const running = qmcode
    const code = await Promise.race([
      running.exited,
      // An ending signal gives qmcode a moment, then it goes.
      ending.then(async () => {
        await sleep(QMCODE_STOP_GRACE_MS)
        running.kill('SIGKILL')
        return await running.exited
      }),
    ])
    if (endedBy !== null) return 128 + (SIGNAL_NUMBER[endedBy] ?? 0)
    if (running.signalCode !== null) {
      return 128 + (SIGNAL_NUMBER[running.signalCode] ?? 1)
    }
    return code
  } finally {
    await tunnel.close()
    process.removeListener('SIGINT', onInterrupt)
    for (const [signal, handler] of enders)
      process.removeListener(signal, handler)
    output.out('  隧道已关')
  }
}
