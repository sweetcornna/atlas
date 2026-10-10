// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `qm handoff node` — the node bridge: the cloud end of a handoff
 * (`handoff-p17-plan.md` §2 P17.5; design `handoff-m1.md` §7).
 *
 * It listens on `qianmo://<node>/handoff` and nothing else: it never dials and
 * never registers anywhere (D-1). The hub dials in, pushes the code and the
 * session into this node's bare repository over git-over-SSH (D-2), and sends
 * a signed `task.request` whose payload is the handoff manifest. The bridge
 * then drives the qmcode app-server running next to it on loopback (D-3):
 *
 * ① ack the request at once;
 * ② `git worktree add <root>/work/<task> -b qianmo/<task> <wip>` from the bare
 *    repository `<root>/repos/<project>.git` — no remote anywhere, so the only
 *    thing that can leave is what the hub fetches;
 * ③ put the session where the app-server finds it: a qmcode rollout into
 *    `$QMCODE_HOME/sessions/YYYY/MM/DD/`; a Claude Code transcript, cut to its
 *    `user` / `assistant` records with `cwd` rewritten, into the app-server's
 *    `$HOME/.claude/projects/qianmo-import/` and imported
 *    (`externalAgentConfig/import`) — and when the import fails, a fresh
 *    thread given the brief plus the last 20 rounds verbatim;
 * ④ `thread/resume` with the work tree as `cwd`, then `turn/start` with the
 *    fixed brief;
 * ⑤ on `turn/completed`: confirm the turn is on disk by P17.4's rule (the
 *    turn's `task_complete` / `turn_aborted` line), commit the work tree onto
 *    `qianmo/<task>` (shadow commit: the same exclusions and secret scan as the
 *    laptop's), commit the transcript as `refs/qianmo/sessions/cloud/<thread>`,
 *    answer `task.result` with the JSON result;
 * ⑥ a reply whose receipt does not come back stays in the delivery ledger and
 *    leaves again on the next message from that hub — the hub pings every 60 s
 *    while a task runs.
 *
 * `handoff.send` — a sentence for the running task — is one more
 * `task.request`: it becomes `turn/start` on the task's thread, which the
 * app-server steers into the turn when one is running.
 *
 * ## What is refused
 *
 * Every `task.request` must carry a capability token from an issuer named
 * with `--trust` (the console's identity, the same one `--chat-sign` uses):
 * `SIGNED_TASK_POLICY` through `NodeRouter.inbound`, and then the verified
 * tier, so an unsigned request or one signed by a stranger is answered with
 * an `error` and starts nothing. Refusals are answered, not thrown: the hub
 * reads the `error` envelope, the transport receipt stays `accepted`.
 *
 * The bridge refuses to **start** when `bwrap` is missing or cannot build a
 * user namespace: the node runs qmcode's `workspace-write` sandbox, which has
 * no fallback without bubblewrap, and `danger-full-access` is not an option
 * (P17.2 probe 第 2 项; plan 「节点沙箱」).
 *
 * ## Memory
 *
 * With `--app-server-pid-file`, a new task is refused (`E_BUSY`) while the
 * app-server and its descendants hold more than 150 MiB of anonymous memory
 * (`RssAnon` in `/proc/<pid>/status`). `VmRSS` is logged and not judged: most
 * of it is clean pages of the 278 MB executable the kernel can drop (probe
 * 第 2 项). Without `/proc`, nothing is judged and the log says so.
 *
 * ## Nothing of the environment
 *
 * The bridge never holds the model key — the start script gives it to the
 * app-server only — and writes no environment anywhere: logs carry ids,
 * paths, hashes and counts; the turn's summary is redacted before it leaves.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import {
  NodeCapabilities,
  SIGNED_TASK_POLICY,
  StaticPublicKeyDirectory,
} from '@qianmo/capability'
import {
  AppServerClient,
  AppServerError,
  AppServerImportError,
  type AppServerThread,
  type AppServerThreadSettings,
  type AppServerTurn,
  CLOUD_DEVICE,
  encodeResultContent,
  FIELD_MAX_BYTES,
  HANDOFF_AGENT,
  HANDOFF_SEND_KIND,
  type HandoffManifest,
  type HandoffResult,
  handoffNodeAddress,
  isTaskId,
  OversizedFileError,
  redactHandoffText,
  runGit,
  SecretFoundError,
  SEND_TEXT_MAX_BYTES,
  sessionCommit,
  sessionRef,
  shadowCommit,
  taskBranch,
  taskRef,
  validateManifest,
} from '@qianmo/handoff'
import {
  createAck,
  createMessage,
  createTaskResult,
  errorCodeForPeer,
  errorReply,
  isTaskResultPayload,
  MessageType,
  NOTICE_TRUST_VERIFIED_CAPABILITY,
  parseAddress,
  peerIsPostLegacy,
  ProtocolErrorCode,
  type QianmoMessage,
  type TaskResultInput,
  taskExpiresAt,
} from '@qianmo/protocol'
import { type DeliveryLedgerEntry, FileDeliveryLedger } from '@qianmo/resident'
import { NodeRouter } from '@qianmo/router'
import {
  type InboundContext,
  pskFromEnv,
  startTransportServer,
  type TransportChannel,
} from '@qianmo/transport'
import { qmcodeHome } from '@qianmo/paths'
import { parseTrustedKey } from '../host/nodeIdentity.js'
import { buildVersion } from '../provenance.js'
import { PRE_RECEIVE_HOOK } from './handoffHub.js'
import { HandoffUserError } from './handoffStore.js'
import {
  findQmcodeRollout,
  lastNewlineEnd,
  qmcodeTurnEnd,
  waitForTurnEnd,
} from './handoffTranscript.js'
import { residentOptionValue } from './residentArgs.js'

const DEFAULT_PORT = 38_630
const DEFAULT_BIND = '127.0.0.1'
/** 150 MiB of anonymous memory, in the kB `/proc/<pid>/status` counts in. */
export const APP_SERVER_ANON_LIMIT_KB = 150 * 1024
/** Receipt budget for a reply; what does not make it goes to the ledger. */
const DEFAULT_RECEIPT_TIMEOUT_MS = 20_000
/**
 * How long the transcript may lag `turn/completed` on the node. The laptop's
 * hook waits 2 s and then skips; here nobody waits, and skipping would lose
 * the result, so the wait is longer and the cut falls back to the last line.
 */
const DEFAULT_TURN_END_WAIT_MS = 10_000
/** Rounds of a Claude Code session the fallback quotes verbatim. */
const RECENT_ROUNDS = 20
/** Cap on the quoted rounds; the oldest are dropped first. */
const RECENT_ROUNDS_MAX_BYTES = 96 * 1024
/**
 * The qmcode app-server's Claude Code directory under its `$HOME`: it imports
 * Claude Code transcripts from `<this>/projects/` (`externalAgentConfig/import`).
 */
const APP_SERVER_CLAUDE_DIR = '.claude'
/** Directory under the app-server's `$HOME/.claude/projects/`. */
const IMPORT_PROJECT = 'qianmo-import'
const BWRAP_PROBE_TIMEOUT_MS = 10_000

// ─── Arguments ───────────────────────────────────────────────────────

export interface HandoffNodeConfig {
  /** This node's segment. */
  readonly node: string
  /** `<root>/repos/<project>.git`, `<root>/work/<task>`, `<root>/state/`. */
  readonly root: string
  readonly port: number
  readonly bind: string
  /** `--trust <node>=<publicKey>`: who may sign a task for this node. */
  readonly trusted: readonly (readonly [string, string])[]
  /** Bare repositories to make sure of at start. */
  readonly projects: readonly string[]
  /** `ws://127.0.0.1:<port>` of the app-server. */
  readonly appServerUrl: string
  readonly appServerTokenFile: string
  /** The app-server's `QMCODE_HOME`. */
  readonly qmcodeHome: string
  /** The app-server's `HOME` (Claude Code imports go under it). */
  readonly appServerHome: string
  readonly appServerPidFile?: string
}

const NODE_USAGE = `Usage: qm handoff node --node <name> --root <abs> --trust <node>=<publicKey>...
         --app-server ws://127.0.0.1:<port> --app-server-token-file <abs>
         --app-server-home <abs> [--qmcode-home <abs>] [--project <name>]...
         [--port ${DEFAULT_PORT}] [--bind ${DEFAULT_BIND}] [--app-server-pid-file <abs>]`

const PROJECT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

function absolute(value: string, flag: string): string {
  if (!isAbsolute(value)) {
    throw new HandoffUserError(`${flag} 要绝对路径：${value}`, 2)
  }
  return resolve(value)
}

/** Parse `qm handoff node` options. Throws {@link HandoffUserError} (exit 2). */
export function parseHandoffNodeArgs(
  args: readonly string[],
  defaults: { readonly qmcodeHome?: string } = {},
): HandoffNodeConfig {
  let node: string | undefined
  let root: string | undefined
  let port = DEFAULT_PORT
  let bind = DEFAULT_BIND
  const trusted = new Map<string, string>()
  const projects: string[] = []
  let appServerUrl: string | undefined
  let appServerTokenFile: string | undefined
  let home: string | undefined
  let appServerHome: string | undefined
  let appServerPidFile: string | undefined
  const value = (index: number, flag: string) => {
    try {
      return residentOptionValue(args, index, flag)
    } catch (error) {
      throw new HandoffUserError(
        `${error instanceof Error ? error.message : String(error)}\n${NODE_USAGE}`,
        2,
      )
    }
  }
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] ?? ''
    const flag = arg.includes('=') ? arg.slice(0, arg.indexOf('=')) : arg
    switch (flag) {
      case '--node': {
        const parsed = value(index, flag)
        if (
          parseAddress(`qianmo://${parsed.value}/${HANDOFF_AGENT}`) === null
        ) {
          throw new HandoffUserError(
            `--node 要小写的协议段名（字母、数字、- 或 _）：${parsed.value}`,
            2,
          )
        }
        node = parsed.value
        index = parsed.next
        break
      }
      case '--root': {
        const parsed = value(index, flag)
        root = absolute(parsed.value, flag)
        index = parsed.next
        break
      }
      case '--port': {
        const parsed = value(index, flag)
        const number = Number(parsed.value)
        if (!Number.isInteger(number) || number < 1 || number > 65_535) {
          throw new HandoffUserError(`--port 要 1–65535：${parsed.value}`, 2)
        }
        port = number
        index = parsed.next
        break
      }
      case '--bind': {
        const parsed = value(index, flag)
        bind = parsed.value
        index = parsed.next
        break
      }
      case '--trust': {
        const parsed = value(index, flag)
        let entry: readonly [string, string]
        try {
          entry = parseTrustedKey(parsed.value)
        } catch (error) {
          throw new HandoffUserError(
            error instanceof Error ? error.message : String(error),
            2,
          )
        }
        const earlier = trusted.get(entry[0])
        if (earlier !== undefined && earlier !== entry[1]) {
          throw new HandoffUserError(`--trust 给 ${entry[0]} 两把不同的公钥`, 2)
        }
        trusted.set(entry[0], entry[1])
        index = parsed.next
        break
      }
      case '--project': {
        const parsed = value(index, flag)
        if (
          !PROJECT_NAME.test(parsed.value) ||
          parsed.value.includes('..') ||
          parsed.value.endsWith('.') ||
          parsed.value.endsWith('.git') ||
          parsed.value.endsWith('.lock')
        ) {
          throw new HandoffUserError(
            `--project 只许 A-Z a-z 0-9 . _ -（与中枢、闸门同一套规则）：${parsed.value}`,
            2,
          )
        }
        if (!projects.includes(parsed.value)) projects.push(parsed.value)
        index = parsed.next
        break
      }
      case '--app-server': {
        const parsed = value(index, flag)
        let url: URL
        try {
          url = new URL(parsed.value)
        } catch {
          throw new HandoffUserError(
            `--app-server 不是 URL：${parsed.value}`,
            2,
          )
        }
        if (
          url.protocol !== 'ws:' ||
          !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
        ) {
          // The app-server has no TLS and its token is a bearer credential:
          // it is reached on loopback only (plan D-6, probe 第 2 项).
          throw new HandoffUserError(
            `--app-server 只能是本机回环上的 ws://：${parsed.value}`,
            2,
          )
        }
        appServerUrl = parsed.value
        index = parsed.next
        break
      }
      case '--app-server-token-file': {
        const parsed = value(index, flag)
        appServerTokenFile = absolute(parsed.value, flag)
        index = parsed.next
        break
      }
      case '--qmcode-home': {
        const parsed = value(index, flag)
        home = absolute(parsed.value, flag)
        index = parsed.next
        break
      }
      case '--app-server-home': {
        const parsed = value(index, flag)
        appServerHome = absolute(parsed.value, flag)
        index = parsed.next
        break
      }
      case '--app-server-pid-file': {
        const parsed = value(index, flag)
        appServerPidFile = absolute(parsed.value, flag)
        index = parsed.next
        break
      }
      default:
        throw new HandoffUserError(`node 不认识的参数 ${arg}\n${NODE_USAGE}`, 2)
    }
  }
  const missing = [
    ['--node', node],
    ['--root', root],
    ['--app-server', appServerUrl],
    ['--app-server-token-file', appServerTokenFile],
    ['--app-server-home', appServerHome],
  ].filter(([, given]) => given === undefined)
  if (missing.length > 0) {
    throw new HandoffUserError(
      `node 缺 ${missing.map(([flag]) => flag).join('、')}\n${NODE_USAGE}`,
      2,
    )
  }
  if (trusted.size === 0) {
    throw new HandoffUserError(
      `node 至少要一个 --trust <节点>=<公钥>（中枢控制台的签名身份，qm console --print-wake-identity 打出来的那一行）\n${NODE_USAGE}`,
      2,
    )
  }
  return {
    node: node as string,
    root: root as string,
    port,
    bind,
    trusted: [...trusted.entries()],
    projects,
    appServerUrl: appServerUrl as string,
    appServerTokenFile: appServerTokenFile as string,
    qmcodeHome: home ?? defaults.qmcodeHome ?? qmcodeHome(),
    appServerHome: appServerHome as string,
    ...(appServerPidFile === undefined ? {} : { appServerPidFile }),
  }
}

// ─── bwrap ───────────────────────────────────────────────────────────

type BwrapCheck =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly reason: string }

const BWRAP_HINT =
  '节点上的 qmcode 用 workspace-write 沙箱，靠系统包 bubblewrap 提供的 bwrap 建 user namespace；' +
  '没有它就没有沙箱可用，节点桥不退到 danger-full-access。' +
  '装上 bubblewrap（Debian：apt-get install bubblewrap），确认 kernel.unprivileged_userns_clone=1 后再启动。'

/**
 * Whether `bwrap` is on `PATH` and can build an unprivileged user namespace:
 * the two ways qmcode's Linux sandbox fails (probe 第 2 项 — missing on p4,
 * and the open question inside gVisor).
 */
export async function checkBwrap(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<BwrapCheck> {
  const path = Bun.which('bwrap', { PATH: env.PATH ?? '' })
  if (path === null) {
    return { ok: false, reason: `PATH 上没有 bwrap。${BWRAP_HINT}` }
  }
  const probe = Bun.spawn(
    [path, '--unshare-user', '--unshare-net', '--ro-bind', '/', '/', 'true'],
    {
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'pipe',
      env: { PATH: env.PATH ?? '' },
    },
  )
  const timer = setTimeout(() => probe.kill('SIGKILL'), BWRAP_PROBE_TIMEOUT_MS)
  const [code, stderr] = await Promise.all([
    probe.exited,
    new Response(probe.stderr).text(),
  ])
  clearTimeout(timer)
  if (code !== 0) {
    const first = stderr.trim().split('\n')[0]?.slice(0, 300) ?? ''
    return {
      ok: false,
      reason: `bwrap 在（${path}），但建不了沙箱（退出码 ${code}${first === '' ? '' : `：${first}`}）。${BWRAP_HINT}`,
    }
  }
  return { ok: true, path }
}

// ─── Memory ──────────────────────────────────────────────────────────

interface AppServerMemory {
  /** The app-server and every descendant found. */
  readonly pids: readonly number[]
  /** `VmRSS`, summed, kB. Logged only. */
  readonly vmRssKb: number
  /** `RssAnon`, summed, kB. The figure judged against the limit. */
  readonly rssAnonKb: number
}

function statusKb(status: string, key: string): number {
  const match = new RegExp(`^${key}:\\s+(\\d+)\\s+kB`, 'm').exec(status)
  return match === null ? 0 : Number(match[1])
}

/**
 * The app-server's memory with its descendants (the code-mode host and tool
 * shells), read from `<procRoot>`. `null` when `pid` is not there — no such
 * process, or no `/proc` at all.
 */
export function appServerMemory(
  pid: number,
  procRoot = '/proc',
): AppServerMemory | null {
  const readStatus = (one: number): string | null => {
    try {
      return readFileSync(join(procRoot, String(one), 'status'), 'utf8')
    } catch {
      return null
    }
  }
  if (readStatus(pid) === null) return null
  const children = new Map<number, number[]>()
  let entries: string[] = []
  try {
    entries = readdirSync(procRoot)
  } catch {}
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue
    let stat: string
    try {
      stat = readFileSync(join(procRoot, entry, 'stat'), 'utf8')
    } catch {
      continue
    }
    // "<pid> (<comm>) <state> <ppid> …"; the comm may hold spaces and parens.
    const after = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    const ppid = Number(after[1])
    if (!Number.isInteger(ppid)) continue
    children.set(ppid, [...(children.get(ppid) ?? []), Number(entry)])
  }
  const pids: number[] = []
  const queue = [pid]
  while (queue.length > 0) {
    const one = queue.shift() as number
    if (pids.includes(one)) continue
    pids.push(one)
    queue.push(...(children.get(one) ?? []))
  }
  let vmRssKb = 0
  let rssAnonKb = 0
  for (const one of pids) {
    const status = readStatus(one)
    if (status === null) continue
    vmRssKb += statusKb(status, 'VmRSS')
    rssAnonKb += statusKb(status, 'RssAnon')
  }
  return { pids, vmRssKb, rssAnonKb }
}

// ─── Repositories ────────────────────────────────────────────────────

/**
 * `reference-transaction` hook of a node repository: the only branches that
 * may appear here are `qianmo/…`; no tags, no remote-tracking refs. Git
 * runs it for every ref update except where the caller switched hooks off,
 * so a `git checkout -b` inside the work tree fails instead of leaving a
 * branch nobody fetches (plan 完成标准「节点工作仓除 qianmo/ 外没有新分支」).
 */
export const NODE_REFERENCE_HOOK = `#!/bin/sh
# Qianmo handoff node repository: only refs/heads/qianmo/* may be created
# here, plus the handoff's own refs/qianmo/*. Installed by qm handoff node.
[ "$1" = prepared ] || exit 0
status=0
while read -r old new ref; do
  : "$old" "$new"
  case "$ref" in
    refs/heads/qianmo/* | refs/qianmo/*) ;;
    refs/heads/* | refs/tags/* | refs/remotes/*)
      printf '[qianmo handoff node] refused %s: only qianmo/ branches live here\\n' "$ref" >&2
      status=1
      ;;
  esac
done
exit "$status"
`

function repositoriesDir(root: string): string {
  return join(root, 'repos')
}

function repositoryOf(root: string, project: string): string {
  return join(repositoriesDir(root), `${project}.git`)
}

/**
 * `<root>/repos/<project>.git`: created bare if missing, with the hub's
 * pre-receive rule (only `refs/qianmo/{wip,sessions}/<device ≠ cloud>/…`
 * may be pushed in), the reference hook above, a fixed committer identity,
 * and no remote — `git init --bare` makes none and nothing here adds one.
 */
export async function ensureNodeRepository(
  root: string,
  project: string,
): Promise<string> {
  const repo = repositoryOf(root, project)
  mkdirSync(repositoriesDir(root), { recursive: true, mode: 0o700 })
  if (!existsSync(join(repo, 'HEAD'))) {
    await runGit(['init', '-q', '--bare', repo], { cwd: repositoriesDir(root) })
  }
  mkdirSync(join(repo, 'hooks'), { recursive: true })
  for (const [name, text] of [
    ['pre-receive', PRE_RECEIVE_HOOK],
    ['reference-transaction', NODE_REFERENCE_HOOK],
  ] as const) {
    const hook = join(repo, 'hooks', name)
    writeFileSync(hook, text, { mode: 0o755 })
    chmodSync(hook, 0o755)
  }
  for (const [key, val] of [
    ['user.name', 'Qianmo Cloud'],
    ['user.email', 'cloud@qianmo.invalid'],
  ] as const) {
    await runGit(['--git-dir', repo, 'config', key, val], { cwd: repo })
  }
  return repo
}

// ─── Transcripts ─────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function jsonLines(text: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      const value: unknown = JSON.parse(line)
      if (isRecord(value)) out.push(value)
    } catch {}
  }
  return out
}

/**
 * A Claude Code transcript as the importer should see it (probe 第 4 项):
 * main-chain `user` / `assistant` records only — attachments carry the
 * laptop's CLAUDE.md and other local context — with every record's `cwd`
 * pointing at the node's work tree. Paths inside tool calls are left as they
 * were; the brief says where the old directory is now.
 */
export function importableClaudeCodeTranscript(
  text: string,
  cwd: string,
): string {
  return jsonLines(text)
    .filter(
      record =>
        (record.type === 'user' || record.type === 'assistant') &&
        record.isSidechain !== true,
    )
    .map(record =>
      JSON.stringify(
        typeof record.cwd === 'string' ? { ...record, cwd } : record,
      ),
    )
    .map(line => `${line}\n`)
    .join('')
}

function contentBlocks(message: unknown): unknown[] {
  const content = isRecord(message) ? message.content : undefined
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  return Array.isArray(content) ? content : []
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`
}

function renderRecord(record: Record<string, unknown>): string {
  const parts: string[] = []
  for (const block of contentBlocks(record.message)) {
    if (!isRecord(block)) continue
    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text)
    } else if (block.type === 'tool_use') {
      parts.push(
        `[工具调用 ${String(block.name ?? '?')}] ${clip(JSON.stringify(block.input ?? null), 500)}`,
      )
    } else if (block.type === 'tool_result') {
      const inner = block.content
      const text =
        typeof inner === 'string'
          ? inner
          : contentBlocks({ content: inner })
              .map(one =>
                isRecord(one) && typeof one.text === 'string' ? one.text : '',
              )
              .join('\n')
      parts.push(`[工具结果] ${clip(text, 2000)}`)
    }
  }
  const body = parts.join('\n').trim()
  if (body === '') return ''
  return `【${record.type === 'user' ? '用户' : '助手'}】${body}`
}

/** A user record that opens a round: the person typed it, it is no tool result. */
function opensRound(record: Record<string, unknown>): boolean {
  if (record.type !== 'user') return false
  const blocks = contentBlocks(record.message)
  return (
    blocks.some(block => isRecord(block) && block.type === 'text') &&
    !blocks.some(block => isRecord(block) && block.type === 'tool_result')
  )
}

/**
 * The last `rounds` rounds of a Claude Code transcript as text, verbatim
 * (tool inputs and results clipped), oldest rounds dropped first past
 * {@link RECENT_ROUNDS_MAX_BYTES}. A round opens at a message the person
 * typed. Returns the text and how many rounds it holds.
 */
export function recentClaudeCodeRounds(
  text: string,
  rounds = RECENT_ROUNDS,
): { readonly text: string; readonly rounds: number } {
  const records = jsonLines(text).filter(
    record =>
      (record.type === 'user' || record.type === 'assistant') &&
      record.isSidechain !== true,
  )
  const grouped: string[][] = []
  for (const record of records) {
    if (opensRound(record) || grouped.length === 0) grouped.push([])
    const rendered = renderRecord(record)
    if (rendered !== '') grouped[grouped.length - 1]?.push(rendered)
  }
  const kept = grouped.filter(group => group.length > 0).slice(-rounds)
  while (
    kept.length > 1 &&
    Buffer.byteLength(kept.map(group => group.join('\n')).join('\n\n')) >
      RECENT_ROUNDS_MAX_BYTES
  ) {
    kept.shift()
  }
  return {
    text: kept.map(group => group.join('\n')).join('\n\n'),
    rounds: kept.length,
  }
}

/** The fixed brief the first turn on the node opens with. */
export function handoffBrief(
  manifest: HandoffManifest,
  taskId: string,
  worktree: string,
): string {
  const orNone = (text: string): string =>
    text.trim() === '' ? '（未写）' : text
  return [
    `这是从本地转交到云端的接力任务 ${taskId}。`,
    `目标：${manifest.brief.goal}`,
    `已完成：${orNone(manifest.brief.done)}`,
    `剩余：${orNone(manifest.brief.remaining)}`,
    `工作目录：${worktree}（当前分支 ${taskBranch(taskId)}，起点是本地 ${manifest.branch} 上转交时的工作区快照；本地原目录 ${manifest.cwd}，会话里出现的旧路径对应这里）`,
    `截止：${manifest.deadline}`,
    '只在当前分支提交，不推送、不发布、不付款，遇到这类动作停下说明。',
  ].join('\n')
}

/** `last_agent_message` of `turnId`'s end line in a rollout, if any. */
function lastAgentMessageOf(content: Buffer, turnId: string): string | null {
  for (const record of jsonLines(content.toString('utf8')).reverse()) {
    if (record.type !== 'event_msg' || !isRecord(record.payload)) continue
    const { type, turn_id: turn, last_agent_message: last } = record.payload
    if (
      turn === turnId &&
      (type === 'task_complete' || type === 'turn_aborted') &&
      typeof last === 'string'
    ) {
      return last
    }
  }
  return null
}

function truncateBytes(text: string, max: number): string {
  if (Buffer.byteLength(text, 'utf8') <= max) return text
  let cut = text.slice(0, max)
  while (Buffer.byteLength(`${cut}…`, 'utf8') > max) cut = cut.slice(0, -1)
  return `${cut}…`
}

// ─── The bridge ──────────────────────────────────────────────────────

export interface HandoffNodeOptions extends HandoffNodeConfig {
  readonly psk: string
  /** Where `PATH` comes from for the bwrap check. */
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly log?: (line: string) => void
  readonly now?: () => number
  readonly receiptTimeoutMs?: number
  readonly turnEndWaitMs?: number
  readonly procRoot?: string
}

export interface HandoffNodeHandle {
  readonly address: string
  readonly url: string
  readonly port: number
  readonly bwrap: string
  /** Resolves once no task runs and no reply is on its way. */
  idle(): Promise<void>
  stop(): Promise<void>
}

/** The bridge would not start; `reason` is what to print. */
export class HandoffNodeRefusal extends Error {
  constructor(reason: string) {
    super(reason)
    this.name = 'HandoffNodeRefusal'
  }
}

interface QueuedSend {
  readonly message: QianmoMessage
  readonly channel: TransportChannel
  readonly seq: number
  readonly text: string
}

interface ActiveTask {
  readonly taskId: string
  readonly manifest: HandoffManifest
  envelope: QianmoMessage
  channel: TransportChannel
  releaseChannel: () => void
  readonly worktree: string
  client: AppServerClient | null
  threadId: string | null
  turnId: string | null
  finishing: boolean
  expired: boolean
  readonly sends: Map<number, string>
  /** `turn/start` calls for sends still waiting for their answer. */
  readonly starting: Set<Promise<string>>
  readonly queued: QueuedSend[]
  readonly notes: string[]
}

/** What a finished task answered, kept for a repeated request. */
interface StoredResult {
  readonly v: 1
  readonly taskId: string
  readonly reply: TaskResultInput
}

const PROTOCOL_ERROR_CODES: ReadonlySet<unknown> = new Set(
  Object.values(ProtocolErrorCode),
)

function isProtocolErrorCode(value: unknown): value is ProtocolErrorCode {
  return PROTOCOL_ERROR_CODES.has(value)
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Start the bridge: bwrap check, repositories, ledger, listener. */
export async function startHandoffNode(
  options: HandoffNodeOptions,
): Promise<HandoffNodeHandle> {
  const bwrap = await checkBwrap(options.env ?? process.env)
  if (!bwrap.ok) throw new HandoffNodeRefusal(bwrap.reason)

  const now = options.now ?? Date.now
  const log =
    options.log ??
    ((line: string) => {
      process.stdout.write(`${line}\n`)
    })
  const say = (line: string): void => {
    log(`[handoff-node] ${new Date(now()).toISOString()} ${line}`)
  }
  const receiptTimeoutMs =
    options.receiptTimeoutMs ?? DEFAULT_RECEIPT_TIMEOUT_MS
  const address = handoffNodeAddress(options.node)
  const stateDir = join(options.root, 'state')
  const resultsDir = join(stateDir, 'results')
  mkdirSync(join(options.root, 'work'), { recursive: true, mode: 0o700 })
  mkdirSync(resultsDir, { recursive: true, mode: 0o700 })
  for (const project of options.projects) {
    await ensureNodeRepository(options.root, project)
  }

  const deliveries = new FileDeliveryLedger(
    join(stateDir, 'deliveries.ndjson'),
    {
      onError: error => say(`投递台账写不进去：${messageOf(error)}`),
    },
  )
  const router = new NodeRouter({
    node: options.node,
    capability: new NodeCapabilities({
      node: options.node,
      directory: new StaticPublicKeyDirectory(options.trusted),
      policy: SIGNED_TASK_POLICY,
      trustedIssuers: options.trusted.map(([name]) => name),
    }),
  })

  let active: ActiveTask | null = null
  const redelivering = new Set<string>()
  const inFlight = new Set<Promise<unknown>>()
  const track = <T>(promise: Promise<T>): Promise<T> => {
    inFlight.add(promise)
    void promise.finally(() => inFlight.delete(promise)).catch(() => {})
    return promise
  }

  // ── replies ──

  const resultPath = (taskId: string): string =>
    join(resultsDir, `${taskId}.json`)

  const storeResult = (taskId: string, reply: TaskResultInput): void => {
    const path = resultPath(taskId)
    const stored: StoredResult = { v: 1, taskId, reply }
    writeFileSync(`${path}.tmp`, `${JSON.stringify(stored)}\n`, { mode: 0o600 })
    renameSync(`${path}.tmp`, path)
  }

  const storedResult = (taskId: string): TaskResultInput | null => {
    let value: unknown
    try {
      value = JSON.parse(readFileSync(resultPath(taskId), 'utf8'))
    } catch {
      return null
    }
    if (!isRecord(value) || value.taskId !== taskId || !isRecord(value.reply)) {
      return null
    }
    const { outcome, content, code, reason } = value.reply
    if (outcome === 'completed' && typeof content === 'string') {
      return { outcome, content }
    }
    if (
      outcome === 'failed' &&
      isProtocolErrorCode(code) &&
      typeof reason === 'string' &&
      reason !== ''
    ) {
      return { outcome, code, reason }
    }
    return null
  }

  /** Put a terminal reply on the wire with a ledger entry behind it. */
  const deliver = async (
    channel: TransportChannel,
    reply: QianmoMessage,
  ): Promise<void> => {
    const peerNode = parseAddress(reply.to)?.node
    const deliveryId =
      peerNode === undefined
        ? undefined
        : deliveries.open({
            taskId: reply.taskId,
            peerNode,
            envelope: reply as unknown as Record<string, unknown>,
          })
    if (deliveryId !== undefined) deliveries.attempt(deliveryId)
    try {
      await channel.sendAndWait(reply, receiptTimeoutMs)
      if (deliveryId !== undefined) deliveries.settle(deliveryId, 'delivered')
      say(`task ${reply.taskId} 结果已送达`)
    } catch (error) {
      say(
        `task ${reply.taskId} 结果没收到回执（${messageOf(error)}）：留在投递台账，等 ${peerNode ?? '?'} 下一条消息时补投`,
      )
    }
  }

  /** Fresh envelope for an owed reply (protocol.md §14.4③). */
  const redeliveryOf = (
    entry: DeliveryLedgerEntry,
    channel: TransportChannel,
  ): QianmoMessage | null => {
    const stored = entry.envelope as unknown as QianmoMessage
    if (
      typeof stored.from !== 'string' ||
      typeof stored.to !== 'string' ||
      typeof stored.traceId !== 'string' ||
      typeof stored.taskId !== 'string' ||
      !isTaskResultPayload(stored.payload)
    ) {
      return null
    }
    return createMessage({
      from: stored.from,
      to: stored.to,
      type: MessageType.TaskResult,
      traceId: stored.traceId,
      taskId: stored.taskId,
      ...(typeof stored.contextId === 'string' && stored.contextId.length > 0
        ? { contextId: stored.contextId }
        : {}),
      payload: peerIsPostLegacy(channel.peerSupportedTypes)
        ? { ...stored.payload, redelivered: true as const }
        : stored.payload,
    })
  }

  const redeliverOwed = (channel: TransportChannel, peerNode: string): void => {
    for (const entry of deliveries.outstanding(peerNode)) {
      if (redelivering.has(entry.deliveryId)) continue
      if (deliveries.attempt(entry.deliveryId) === 0) continue
      const reply = redeliveryOf(entry, channel)
      if (reply === null) {
        deliveries.abandon(
          entry.deliveryId,
          'stored reply is not a task.result',
        )
        continue
      }
      redelivering.add(entry.deliveryId)
      const release = channel.hold()
      void track(
        (async () => {
          try {
            await channel.sendAndWait(reply, receiptTimeoutMs)
            deliveries.settle(entry.deliveryId, 'delivered')
            say(`task ${entry.taskId} 结果补投送达`)
          } catch (error) {
            say(`task ${entry.taskId} 结果补投仍没回执：${messageOf(error)}`)
          } finally {
            redelivering.delete(entry.deliveryId)
            release()
          }
        })(),
      )
    }
  }

  const refuse = (
    context: InboundContext,
    message: QianmoMessage,
    code: ProtocolErrorCode,
    reason: string,
  ): void => {
    context.channel.send(
      errorReply(
        message,
        errorCodeForPeer(code, context.channel.peerSupportedTypes),
        reason,
      ),
    )
    say(`拒绝 ${message.type} ${message.taskId}（${code}）：${reason}`)
  }

  // ── one task ──

  const placeQmcodeSession = async (
    task: ActiveTask,
    repo: string,
  ): Promise<void> => {
    const { manifest } = task
    const listing = (
      await runGit(
        [
          '--git-dir',
          repo,
          'ls-tree',
          '--name-only',
          '-z',
          manifest.sessionCommit,
        ],
        {
          cwd: repo,
        },
      )
    ).stdout
      .toString('utf8')
      .split('\0')
      .filter(name => name !== '')
    const name = listing[0]
    if (
      listing.length !== 1 ||
      name === undefined ||
      !name.startsWith('rollout-') ||
      !name.endsWith('.jsonl') ||
      !name.includes(manifest.sessionId) ||
      name.includes('/')
    ) {
      throw new Error(
        `会话提交 ${manifest.sessionCommit} 不是 qmcode 的单个 rollout 文件`,
      )
    }
    const bytes = (
      await runGit(
        [
          '--git-dir',
          repo,
          'cat-file',
          'blob',
          `${manifest.sessionCommit}:${name}`,
        ],
        {
          cwd: repo,
        },
      )
    ).stdout
    const date = /^rollout-(\d{4})-(\d{2})-(\d{2})T/.exec(name)
    const today = new Date(now()).toISOString()
    const target =
      findQmcodeRollout(options.qmcodeHome, manifest.sessionId) ??
      join(
        options.qmcodeHome,
        'sessions',
        date?.[1] ?? today.slice(0, 4),
        date?.[2] ?? today.slice(5, 7),
        date?.[3] ?? today.slice(8, 10),
        name,
      )
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
    writeFileSync(target, bytes, { mode: 0o600 })
    say(`task ${task.taskId} qmcode 会话放到 ${target}（${bytes.length} 字节）`)
  }

  const readSessionText = async (
    repo: string,
    commit: string,
  ): Promise<string> => {
    const name = (
      await runGit(
        ['--git-dir', repo, 'ls-tree', '--name-only', '-z', commit],
        { cwd: repo },
      )
    ).stdout
      .toString('utf8')
      .split('\0')
      .filter(one => one !== '')[0]
    if (name === undefined) throw new Error(`会话提交 ${commit} 是空的`)
    return (
      await runGit(
        ['--git-dir', repo, 'cat-file', 'blob', `${commit}:${name}`],
        { cwd: repo },
      )
    ).stdout.toString('utf8')
  }

  /** ③ for a Claude Code session: import, or the fallback. */
  const openClaudeCodeThread = async (
    task: ActiveTask,
    client: AppServerClient,
    repo: string,
    settings: AppServerThreadSettings,
    brief: string,
  ): Promise<{
    readonly thread: AppServerThread
    readonly firstText: string
  }> => {
    const { manifest } = task
    const transcript = await readSessionText(repo, manifest.sessionCommit)
    const file = join(
      options.appServerHome,
      APP_SERVER_CLAUDE_DIR,
      'projects',
      IMPORT_PROJECT,
      `${manifest.sessionId}.jsonl`,
    )
    try {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
      writeFileSync(
        file,
        importableClaudeCodeTranscript(transcript, task.worktree),
        {
          mode: 0o600,
        },
      )
      const target = await client.importClaudeCodeSession({
        path: file,
        cwd: task.worktree,
        description: `qianmo handoff ${task.taskId}`,
      })
      say(`task ${task.taskId} Claude Code 会话导入为线程 ${target}`)
      return {
        thread: await client.threadResume(target, settings),
        firstText: brief,
      }
    } catch (error) {
      if (
        !(
          error instanceof AppServerImportError ||
          error instanceof AppServerError
        )
      ) {
        throw error
      }
      if (
        error instanceof AppServerError &&
        error.code === null &&
        error.method === 'connection'
      ) {
        throw error
      }
      const recent = recentClaudeCodeRounds(transcript)
      task.notes.push(
        `Claude Code 会话导入失败（${messageOf(error).slice(0, 200)}），退化为简报加最近 ${recent.rounds} 轮原文开新线程`,
      )
      say(`task ${task.taskId} 导入失败，退化为简报 + 最近 ${recent.rounds} 轮`)
      const thread = await client.threadStart(settings)
      return {
        thread,
        firstText: `${brief}\n\n下面是本地 Claude Code 会话最近 ${recent.rounds} 轮的原文（会话没能导入成线程，退化为文本）：\n\n${recent.text}`,
      }
    }
  }

  /** ⑤: the work tree onto `qianmo/<task>`. Returns the branch tip. */
  const commitWorkTree = async (task: ActiveTask): Promise<string> => {
    const shadow = await shadowCommit({
      cwd: task.worktree,
      message: `阡陌云端：任务 ${task.taskId} 的工作区改动`,
    })
    const headTree = (
      await runGit(['rev-parse', 'HEAD^{tree}'], { cwd: task.worktree })
    ).stdout
      .toString('utf8')
      .trim()
    const head = shadow.head
    if (head === null) throw new Error('工作树没有 HEAD')
    if (shadow.tree === headTree) return head
    await runGit(
      [
        'update-ref',
        '-m',
        'qianmo handoff: cloud work',
        taskRef(task.taskId),
        shadow.commit,
        head,
      ],
      { cwd: task.worktree },
    )
    // The work tree stays usable (attach, P17.6): its index follows HEAD.
    await runGit(['-c', 'core.fsmonitor=false', 'reset', '-q'], {
      cwd: task.worktree,
    })
    return shadow.commit
  }

  const sendLater = (task: ActiveTask, queued: QueuedSend): void => {
    void track(
      (async () => {
        const client = task.client
        const threadId = task.threadId
        if (client === null || threadId === null || task.finishing) {
          queued.channel.send(
            createTaskResult(queued.message, address, {
              outcome: 'failed',
              code: ProtocolErrorCode.E_TASK_FAILED,
              reason: `任务 ${task.taskId} 已在收尾，这句话没有送进线程`,
            }),
          )
          return
        }
        const starting = client.turnStart(threadId, queued.text)
        task.starting.add(starting)
        try {
          const turnId = await starting
          task.sends.set(queued.seq, turnId)
          if (turnId !== task.turnId && !task.finishing) task.turnId = turnId
          say(`task ${task.taskId} 追加的话 #${queued.seq} 进了回合 ${turnId}`)
          queued.channel.send(
            createTaskResult(queued.message, address, {
              outcome: 'completed',
              content: JSON.stringify({
                kind: HANDOFF_SEND_KIND,
                task: task.taskId,
                seq: queued.seq,
                turnId,
                duplicate: false,
              }),
            }),
          )
        } catch (error) {
          queued.channel.send(
            createTaskResult(queued.message, address, {
              outcome: 'failed',
              code: ProtocolErrorCode.E_TASK_FAILED,
              reason: `追加的话没有送进线程：${messageOf(error).slice(0, 300)}`,
            }),
          )
        } finally {
          task.starting.delete(starting)
        }
      })(),
    )
  }

  const runTask = async (task: ActiveTask): Promise<void> => {
    const { manifest, taskId } = task
    const repo = repositoryOf(options.root, manifest.project)
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined
    let reply: TaskResultInput
    try {
      // ②
      mkdirSync(join(options.root, 'work'), { recursive: true, mode: 0o700 })
      await runGit(
        [
          '--git-dir',
          repo,
          'worktree',
          'add',
          '--quiet',
          '-b',
          taskBranch(taskId),
          task.worktree,
          manifest.wip,
        ],
        { cwd: options.root },
      )
      say(
        `task ${taskId} 工作树 ${task.worktree}（${taskBranch(taskId)} ← ${manifest.wip}）`,
      )

      // ③
      const token = readFileSync(options.appServerTokenFile, 'utf8').trim()
      const client = await AppServerClient.connect({
        url: options.appServerUrl,
        token,
        clientVersion: buildVersion(),
      })
      task.client = client
      const settings: AppServerThreadSettings = {
        cwd: task.worktree,
        approvalPolicy: 'never',
        sandbox: 'workspace-write',
      }
      const brief = handoffBrief(manifest, taskId, task.worktree)
      let thread: AppServerThread
      let firstText = brief
      if (manifest.tool === 'qmcode') {
        await placeQmcodeSession(task, repo)
        // ④
        thread = await client.threadResume(manifest.sessionId, settings)
      } else {
        const opened = await openClaudeCodeThread(
          task,
          client,
          repo,
          settings,
          brief,
        )
        thread = opened.thread
        firstText = opened.firstText
      }
      task.threadId = thread.id
      const first = await client.turnStart(thread.id, firstText)
      task.turnId = first
      say(`task ${taskId} 线程 ${thread.id} 回合 ${first} 开始`)
      for (const queued of task.queued.splice(0)) sendLater(task, queued)

      const interrupt = (): void => {
        task.expired = true
        const turnId = task.turnId
        if (turnId === null || task.finishing) return
        say(`task ${taskId} 到截止时间，中断回合 ${turnId}`)
        client.turnInterrupt(thread.id, turnId).catch(error => {
          say(`task ${taskId} 中断回合失败：${messageOf(error)}`)
        })
      }
      const armDeadline = (): void => {
        const left = taskExpiresAt(task.envelope) - now()
        if (left <= 0) {
          interrupt()
          return
        }
        // setTimeout tops out near 24.8 days; re-arm in steps.
        deadlineTimer = setTimeout(armDeadline, Math.min(left, 2 ** 30))
      }
      if (task.expired) interrupt()
      else armDeadline()

      // Wait for the turn that is current when it ends: a `send` after the
      // first turn finished starts another one, and that is the one to wait for.
      // A send whose `turn/start` is still out may yet open that next turn.
      let turn: AppServerTurn
      for (;;) {
        const waiting: string = task.turnId ?? first
        turn = await client.waitTurnCompleted(thread.id, waiting)
        while (task.starting.size > 0) {
          await Promise.allSettled([...task.starting])
        }
        if (task.turnId === waiting) break
      }
      task.finishing = true
      clearTimeout(deadlineTimer)
      say(`task ${taskId} 回合 ${turn.id} 结束：${turn.status}`)

      // ⑤
      const rollout =
        thread.path ?? findQmcodeRollout(options.qmcodeHome, thread.id)
      if (rollout === null || !existsSync(rollout)) {
        throw new Error(`找不到线程 ${thread.id} 的会话文件`)
      }
      const landed = await waitForTurnEnd(
        rollout,
        content => qmcodeTurnEnd(content, turn.id),
        {
          timeoutMs: options.turnEndWaitMs ?? DEFAULT_TURN_END_WAIT_MS,
        },
      )
      let bytes: Buffer
      if (landed === null) {
        bytes = readFileSync(rollout)
        bytes = bytes.subarray(0, lastNewlineEnd(bytes))
        task.notes.push(
          `会话文件在回合结束后 ${(options.turnEndWaitMs ?? DEFAULT_TURN_END_WAIT_MS) / 1000} s 内没有写到本回合的结束行，按最后一个完整行提交`,
        )
      } else {
        bytes = landed.content.subarray(0, landed.end)
      }
      const head = await commitWorkTree(task)
      const cloudRef = sessionRef(CLOUD_DEVICE, thread.id)
      const previous = await runGit(
        [
          '--git-dir',
          repo,
          'rev-parse',
          '-q',
          '--verify',
          `${cloudRef}^{commit}`,
        ],
        {
          cwd: repo,
          okExitCodes: [1, 128],
        },
      )
      const parent = previous.stdout.toString('utf8').trim()
      const session = await sessionCommit({
        cwd: task.worktree,
        file: rollout,
        content: bytes,
        redact: true,
        ...(previous.exitCode === 0 && parent !== '' ? { parent } : {}),
        message: `阡陌云端：任务 ${taskId} 的会话`,
      })
      await runGit(
        ['--git-dir', repo, 'update-ref', cloudRef, session.commit],
        { cwd: repo },
      )
      say(
        `task ${taskId} 提交：分支 ${head}，会话 ${cloudRef} → ${session.commit}（脱敏 ${session.redactions?.count ?? 0} 处）`,
      )

      const said =
        lastAgentMessageOf(bytes, turn.id) ??
        client.lastAgentMessage(turn.id) ??
        ''
      if (task.expired) task.notes.push('到截止时间，回合被中断')
      const summary = truncateBytes(
        redactHandoffText(
          [said, ...task.notes.map(note => `〔节点〕${note}`)]
            .filter(Boolean)
            .join('\n\n'),
        ).text,
        FIELD_MAX_BYTES.summary,
      )
      const result: HandoffResult = {
        status: turn.status === 'inProgress' ? 'failed' : turn.status,
        branch: taskBranch(taskId),
        head,
        threadId: thread.id,
        summary,
      }
      reply = { outcome: 'completed', content: encodeResultContent(result) }
    } catch (error) {
      let reason: string
      if (error instanceof SecretFoundError) {
        reason = `云端的工作区改动里有疑似密钥，没有提交（${error.findings
          .map(
            finding =>
              `${finding.path}：${[...new Set(finding.matches.map(match => match.ruleId))].join('、')}`,
          )
          .join('；')}）；改动还在节点工作树 ${task.worktree}`
      } else if (error instanceof OversizedFileError) {
        reason = `云端的工作区改动里有超过上限的文件，没有提交（${error.files
          .map(file => `${file.path} ${file.bytes} 字节`)
          .join('；')}）；改动还在节点工作树 ${task.worktree}`
      } else {
        reason = `节点上续跑失败：${messageOf(error)}`
      }
      reason = truncateBytes(redactHandoffText(reason).text, 2000)
      say(`task ${taskId} 失败：${reason}`)
      reply = {
        outcome: 'failed',
        code: ProtocolErrorCode.E_TASK_FAILED,
        reason,
      }
    } finally {
      clearTimeout(deadlineTimer)
      task.finishing = true
      task.client?.close()
    }
    try {
      storeResult(taskId, reply)
    } catch (error) {
      say(`task ${taskId} 结果没能留档：${messageOf(error)}`)
    }
    // The node is free once the result is on file: a repeated request finds
    // it there, a new task may start while this reply waits for its receipt.
    if (active === task) active = null
    router.release(taskId)
    await deliver(
      task.channel,
      createTaskResult(task.envelope, address, reply, now()),
    )
    task.releaseChannel()
  }

  // ── inbound ──

  const onHandoff = async (
    message: QianmoMessage,
    context: InboundContext,
  ): Promise<void> => {
    const checked = validateManifest(message.payload)
    if (!checked.ok) {
      refuse(
        context,
        message,
        ProtocolErrorCode.E_BAD_ENVELOPE,
        `接力清单不合法：${checked.errors.join('；')}`,
      )
      return
    }
    const manifest = checked.value
    const taskId = message.taskId
    if (!isTaskId(taskId)) {
      refuse(
        context,
        message,
        ProtocolErrorCode.E_BAD_ENVELOPE,
        `任务号不能用作分支名：${taskId}`,
      )
      return
    }
    // The same task again: the hub restarted or did not see the ack.
    if (active !== null && active.taskId === taskId) {
      active.releaseChannel()
      active.channel = context.channel
      active.releaseChannel = context.channel.hold()
      active.envelope = message
      context.channel.send(createAck(message, address, now()))
      say(`task ${taskId} 重复的请求：仍在跑，再回一次 ack`)
      return
    }
    const stored = storedResult(taskId)
    if (stored !== null) {
      context.channel.send(createAck(message, address, now()))
      const again = peerIsPostLegacy(context.channel.peerSupportedTypes)
        ? { ...stored, redelivered: true as const }
        : stored
      say(`task ${taskId} 重复的请求：已收尾，重发结果`)
      void track(
        deliver(
          context.channel,
          createTaskResult(message, address, again, now()),
        ),
      )
      return
    }
    if (active !== null) {
      refuse(
        context,
        message,
        ProtocolErrorCode.E_BUSY,
        `节点正在跑任务 ${active.taskId}，一次只跑一个`,
      )
      return
    }
    if (options.appServerPidFile !== undefined) {
      let memory: AppServerMemory | null = null
      try {
        const pid = Number(
          readFileSync(options.appServerPidFile, 'utf8').trim(),
        )
        memory = Number.isInteger(pid)
          ? appServerMemory(pid, options.procRoot)
          : null
      } catch {}
      if (memory === null) {
        say('app-server 内存：读不到（没有 /proc 或 pid 不在），不判')
      } else {
        say(
          `app-server 内存：RssAnon ${memory.rssAnonKb} kB，VmRSS ${memory.vmRssKb} kB（${memory.pids.length} 个进程；只按 RssAnon 判，上限 ${APP_SERVER_ANON_LIMIT_KB} kB）`,
        )
        if (memory.rssAnonKb > APP_SERVER_ANON_LIMIT_KB) {
          refuse(
            context,
            message,
            ProtocolErrorCode.E_BUSY,
            `app-server 匿名内存 ${Math.round(memory.rssAnonKb / 1024)} MiB，超过 150 MiB 上限，暂不接新任务`,
          )
          return
        }
      }
    }
    const repo = repositoryOf(options.root, manifest.project)
    if (!existsSync(join(repo, 'HEAD'))) {
      refuse(
        context,
        message,
        ProtocolErrorCode.E_TASK_FAILED,
        `节点上没有项目 ${manifest.project} 的裸仓：用 --project ${manifest.project} 重启节点桥`,
      )
      return
    }
    const branch = await runGit(
      ['--git-dir', repo, 'rev-parse', '-q', '--verify', taskRef(taskId)],
      {
        cwd: repo,
        okExitCodes: [1, 128],
      },
    )
    if (branch.exitCode === 0) {
      refuse(
        context,
        message,
        ProtocolErrorCode.E_TASK_FAILED,
        `任务 ${taskId} 在本节点上跑过（分支 ${taskBranch(taskId)} 已在），没有留档的结果`,
      )
      return
    }
    for (const [what, sha] of [
      ['影子提交', manifest.wip],
      ['会话提交', manifest.sessionCommit],
    ] as const) {
      const probe = await runGit(
        ['--git-dir', repo, 'cat-file', '-e', `${sha}^{commit}`],
        {
          cwd: repo,
          okExitCodes: [1, 128],
        },
      )
      if (probe.exitCode !== 0) {
        refuse(
          context,
          message,
          ProtocolErrorCode.E_TASK_FAILED,
          `${what} ${sha} 不在节点仓里：中枢没有推过来`,
        )
        return
      }
    }
    // AC-H1: the work tree the node starts from is the one the laptop had.
    const wipTree = (
      await runGit(['--git-dir', repo, 'rev-parse', `${manifest.wip}^{tree}`], {
        cwd: repo,
      })
    ).stdout
      .toString('utf8')
      .trim()
    if (wipTree !== manifest.tree) {
      refuse(
        context,
        message,
        ProtocolErrorCode.E_TASK_FAILED,
        `影子提交 ${manifest.wip} 的树 ${wipTree} 与清单里的 ${manifest.tree} 不一致`,
      )
      return
    }
    // ① taken: ack before any slow step.
    context.channel.send(createAck(message, address, now()))
    const task: ActiveTask = {
      taskId,
      manifest,
      envelope: message,
      channel: context.channel,
      releaseChannel: context.channel.hold(),
      worktree: join(options.root, 'work', taskId),
      client: null,
      threadId: null,
      turnId: null,
      finishing: false,
      expired: false,
      sends: new Map(),
      starting: new Set(),
      queued: [],
      notes: [],
    }
    active = task
    say(
      `task ${taskId} 收下：项目 ${manifest.project}，${manifest.tool} 会话 ${manifest.sessionId}`,
    )
    void track(runTask(task))
  }

  const onSend = (message: QianmoMessage, context: InboundContext): void => {
    const payload = isRecord(message.payload) ? message.payload : {}
    const taskId = payload.task
    const seq = payload.seq
    const text = payload.text
    if (
      !isTaskId(taskId) ||
      typeof seq !== 'number' ||
      !Number.isSafeInteger(seq) ||
      seq < 1 ||
      typeof text !== 'string' ||
      text.trim() === '' ||
      Buffer.byteLength(text, 'utf8') > SEND_TEXT_MAX_BYTES
    ) {
      refuse(
        context,
        message,
        ProtocolErrorCode.E_BAD_ENVELOPE,
        'handoff.send 要 {task, seq, text}',
      )
      return
    }
    const task = active
    if (task === null || task.taskId !== taskId) {
      refuse(
        context,
        message,
        ProtocolErrorCode.E_TASK_FAILED,
        `本节点没有在跑任务 ${taskId}`,
      )
      return
    }
    context.channel.send(createAck(message, address, now()))
    const seen = task.sends.get(seq)
    if (seen !== undefined) {
      context.channel.send(
        createTaskResult(message, address, {
          outcome: 'completed',
          content: JSON.stringify({
            kind: HANDOFF_SEND_KIND,
            task: taskId,
            seq,
            turnId: seen,
            duplicate: true,
          }),
        }),
      )
      return
    }
    task.sends.set(seq, '')
    const queued: QueuedSend = { message, channel: context.channel, seq, text }
    if (task.threadId === null || task.turnId === null) {
      task.queued.push(queued)
      say(`task ${taskId} 追加的话 #${seq} 先排着，线程还没开`)
      return
    }
    sendLater(task, queued)
  }

  const onMessage = async (
    message: QianmoMessage,
    context: InboundContext,
  ): Promise<void> => {
    const routed = router.inbound(message)
    if (!routed.ok) {
      refuse(context, message, routed.code, routed.reason)
      return
    }
    // Any contact from a hub is the moment owed replies may leave (H-2).
    const peerNode = parseAddress(message.from)?.node
    if (peerNode !== undefined) redeliverOwed(context.channel, peerNode)
    if (message.type !== MessageType.TaskRequest) return
    if (message.to !== address) {
      refuse(
        context,
        message,
        ProtocolErrorCode.E_UNKNOWN_AGENT,
        `本节点桥只有 ${address}`,
      )
      return
    }
    if (routed.trust !== NOTICE_TRUST_VERIFIED_CAPABILITY) {
      refuse(
        context,
        message,
        ProtocolErrorCode.E_CAP_INSUFFICIENT,
        '接力任务要 --trust 名单里的签发方签名（write-limited）',
      )
      return
    }
    const kind = isRecord(message.payload) ? message.payload.kind : undefined
    if (kind === 'handoff') {
      await onHandoff(message, context)
    } else if (kind === HANDOFF_SEND_KIND) {
      onSend(message, context)
    } else {
      refuse(
        context,
        message,
        ProtocolErrorCode.E_BAD_ENVELOPE,
        `不认识的 payload.kind：${String(kind)}`,
      )
    }
  }

  const server = startTransportServer({
    psk: options.psk,
    port: options.port,
    hostname: options.bind,
    onMessage,
  })

  return {
    address,
    url: server.url ?? '',
    port: server.port ?? options.port,
    bwrap: bwrap.path,
    async idle() {
      while (inFlight.size > 0) await Promise.allSettled([...inFlight])
    },
    async stop() {
      await server.stop()
      active?.client?.close()
      await Promise.allSettled([...inFlight])
      deliveries.close()
    },
  }
}

// ─── `qm handoff node` ───────────────────────────────────────────────

/** Run the bridge until SIGINT / SIGTERM. Returns the exit code. */
export async function runHandoffNode(args: readonly string[]): Promise<number> {
  let config: HandoffNodeConfig
  let psk: string
  try {
    config = parseHandoffNodeArgs(args)
    try {
      psk = pskFromEnv()
    } catch {
      // The variable's value never goes into the message.
      throw new HandoffUserError(
        '环境里没有可用的 QIANMO_TRANSPORT_PSK（中枢拨入用的那把，按节点分发，不在本机生成）',
      )
    }
    if (!existsSync(config.appServerTokenFile)) {
      throw new HandoffUserError(
        `app-server 令牌文件不在：${config.appServerTokenFile}（先起 app-server，它的 --ws-token-file 指向这里）`,
      )
    }
  } catch (error) {
    const exit = error instanceof HandoffUserError ? error.exitCode : 1
    process.stderr.write(`节点桥没有启动：${messageOf(error)}\n`)
    return exit
  }
  let handle: HandoffNodeHandle
  try {
    handle = await startHandoffNode({ ...config, psk })
  } catch (error) {
    process.stderr.write(`节点桥没有启动：${messageOf(error)}\n`)
    return 1
  }
  const field = (name: string, value: string): string =>
    `${name.padEnd(14)}${value}\n`
  process.stdout.write(
    field('handoff-node', handle.address) +
      field('listen', handle.url) +
      field(
        'root',
        `${config.root}（repos: ${config.projects.join(', ') || '无'}）`,
      ) +
      field(
        'app-server',
        `${config.appServerUrl}（令牌文件 ${config.appServerTokenFile}）`,
      ) +
      field('qmcode-home', config.qmcodeHome) +
      field('app-server-home', config.appServerHome) +
      field('trust', config.trusted.map(([name]) => name).join(', ')) +
      field('bwrap', handle.bwrap) +
      field(
        'memory',
        config.appServerPidFile === undefined
          ? '不判（没有 --app-server-pid-file）'
          : `按 RssAnon 判，上限 ${APP_SERVER_ANON_LIMIT_KB} kB；VmRSS 只记录（pid 文件 ${config.appServerPidFile}）`,
      ),
  )
  await new Promise<void>(done => {
    process.once('SIGINT', () => done())
    process.once('SIGTERM', () => done())
  })
  // The work trees stay: a task cut short is still there to look at.
  await handle.stop()
  return 0
}
