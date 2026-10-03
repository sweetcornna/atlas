// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `qm handoff` — the laptop side of the local-to-cloud handoff
 * (`handoff-p17-plan.md` §2 P17.4 本地命令; design `handoff-m1.md` v1.1).
 *
 *   qm handoff init --hub <ssh target>:<root> --console <https://…> [--key …] [--token-file …]
 *   qm handoff sync [--hook qmcode|claude-code]
 *   qm handoff now [--goal …] [--done …] [--remaining …] [--deadline …]
 *   qm handoff status [--wait] [--task <id>]
 *
 * `mcp`, `pull`, `attach` and `node` are reserved here and answer 「尚未实现」
 * with exit 2, so the packages that build them (P17.3, P17.6, P17.5) replace
 * one branch each.
 *
 * ## Exit codes
 *
 * 0 done · 1 did not happen, with the reason on stderr · 2 usage. A hook
 * (`sync --hook …`) always exits 0: it runs inside somebody's tool, and a
 * failed backup must not break their turn. What it did or why it did not is
 * in `<config root>/qianmo/handoff/sync.log`.
 *
 * Options are parsed here rather than by Commander, like `console` and
 * `memory`; `cli/program/commands/qianmo.tsx` only lists the command in
 * `--help`.
 */

import { basename, isAbsolute, resolve } from 'node:path'
import { statSync } from 'node:fs'
import { isatty } from 'node:tty'
import { sessionRef, type HandoffTool } from '@qianmo/handoff'
import { qmcodeHome } from '../../config/paths.js'
import { invokedBinName } from '../../constants/brand.js'
import { IDENTITY_MODE } from '../../constants/identity.js'
import { gitTopLevel, initHubRepository } from './handoffHub.js'
import {
  PROCESS_OUTPUT,
  projectAt,
  runNow,
  runStatus,
  sessionSnapshot,
  type Output,
} from './handoffNow.js'
import {
  appendSyncLog,
  assertDeviceName,
  assertProjectName,
  defaultDeviceName,
  HandoffUserError,
  hubRepoUrl,
  loadProject,
  parseConsoleUrl,
  parseHub,
  readTokenFile,
  recordSession,
  saveProject,
} from './handoffStore.js'
import {
  drainPending,
  logSync,
  mergeSnapshots,
  pendingCount,
  syncFailureReason,
  syncOnce,
  restorePending,
  takePending,
  waitForSyncLock,
  writeLastSync,
  writePending,
} from './handoffSync.js'
import {
  claudeCodeTurnEnd,
  findQmcodeRollout,
  parseClaudeCodeHookInput,
  parseQmcodeNotify,
  qmcodeTurnEnd,
  readTranscript,
  waitForTurnEnd,
} from './handoffTranscript.js'
import { residentOptionValue } from './residentArgs.js'

/** The subcommands later packages fill in, and which package each is. */
const RESERVED: Readonly<Record<string, string>> = {
  mcp: 'P17.3',
  node: 'P17.5',
  pull: 'P17.6',
  attach: 'P17.6',
}

const HANDOFF_HELP_TEXT = `Usage: ${invokedBinName()} handoff <command> [options]

Hand the work in this repository over to the cloud: the work tree (including
uncommitted and untracked, not ignored files) and the current qmcode or Claude
Code session go to your hub as git objects; the hub confirms they landed
before you are told it is safe to shut down. Requires OCC_IDENTITY=qianmo.

Commands:

  init --hub <target>:<root> --console <url> [options]
                           Register this repository. Creates <root>/<project>.git
                           on the hub over your own SSH and installs its
                           pre-receive hook; does not touch your git remotes.
      --hub <user@host>:<root> | <abs path>
                           Directory of the hub's bare repositories (the hub's
                           --handoff-root). An absolute local path skips SSH.
      --console <url>      The hub console, https:// (http:// on loopback only).
      --key <abs path>     The dedicated gate key for pushes and fetches
                           (ssh -i <key> -o IdentitiesOnly=yes). Required for
                           an SSH hub.
      --token-file <abs path>
                           File holding your console credential (chmod 600):
                           a member/ops personal credential or the admin token.
      --no-token-file      Forget the credential file registered before.
      --project <name>     Default: the repository directory's name.
      --device <name>      Default: this machine's short host name.
                           Both use A-Z a-z 0-9 . _ - only; "cloud" is reserved.
                           Running init again keeps --project, --device,
                           --key and --token-file from last time unless given.

  sync [--hook qmcode|claude-code]
                           Push a shadow commit of the work tree and the
                           session transcript (secrets redacted) to the hub.
                           Without --hook: now, for the session last seen in
                           this directory. With --hook: the turn-end entry
                           point — at most one push per 5 s, the last turn of a
                           burst always pushed, a turn not yet complete on disk
                           not pushed; always exit 0, outcome in
                           <config root>/qianmo/handoff/sync.log.
                             qmcode: notify passes its JSON as the last
                               argument: notify = ["qm", "handoff", "sync",
                               "--hook", "qmcode"] in config.toml (a notify
                               of your own replaces it).
                             claude-code: reads the hook JSON on stdin. Add
                               "${invokedBinName()} handoff sync --hook claude-code"
                               to ~/.claude/settings.json yourself — nothing
                               here writes to ~/.claude — as a Stop command
                               hook with "async": true, so the turn does not
                               wait for the push, and on SessionEnd if you
                               like (Claude Code gives SessionEnd hooks 1.5 s;
                               what does not fit is picked up by the next sync
                               or by now).

  now [--goal <text>] [--done <text>] [--remaining <text>] [--deadline <UTC>]
                           Sync, check both refs on the hub, check the work
                           tree did not change since, and register the handoff
                           with the console. Prints "已落地，可以关机" and the
                           task id only when the hub accepted it. Refuses while
                           a qmcode turn is still running. Run by /handoff (or
                           !) in qmcode, it takes that thread ($CODEX_THREAD_ID)
                           and leaves out the shell turn it runs in. Deadline
                           default: 24 h from now, e.g. 2026-11-20T02:00:00Z.

  status [--wait] [--task <id>]
                           This repository's settings, last sync and the hub's
                           tasks for it. --wait blocks until the latest task
                           (or --task) changes state.

  mcp | pull | attach | node
                           Reserved; not implemented yet (P17.3 / P17.6 / P17.5).

Files: <config root>/qianmo/handoff/{projects.json,sessions.json,sync.log,state/}.
qmcode sessions are looked up under $QMCODE_HOME/sessions (default ~/.qmcode).
`

function isHelpRequest(args: readonly string[]): boolean {
  return args.some(arg => arg === '--help' || arg === '-h')
}

function usage(message: string): never {
  throw new HandoffUserError(
    `${message}（${invokedBinName()} handoff --help 看用法）`,
    2,
  )
}

/** `--name value` / `--name=value` options, every one of them known. */
function parseOptions(
  args: readonly string[],
  valued: readonly string[],
  flags: readonly string[] = [],
): {
  readonly values: Map<string, string>
  readonly flags: Set<string>
  readonly positional: string[]
} {
  const values = new Map<string, string>()
  const seen = new Set<string>()
  const positional: string[] = []
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] ?? ''
    const name = valued.find(
      option => arg === option || arg.startsWith(`${option}=`),
    )
    if (name !== undefined) {
      let parsed: { value: string; next: number }
      try {
        parsed = residentOptionValue(args, index, name)
      } catch (error) {
        usage(
          `${error instanceof Error ? error.message : String(error)}${
            name === '--token-file'
              ? '（要清除已登记的凭据用 --no-token-file）'
              : ''
          }`,
        )
      }
      if (values.has(name)) usage(`${name} 只能给一次`)
      values.set(name, parsed.value)
      index = parsed.next
    } else if (flags.includes(arg)) {
      seen.add(arg)
    } else if (arg.startsWith('-')) {
      usage(`不认识的选项 ${arg}`)
    } else {
      positional.push(arg)
    }
  }
  return { values, flags: seen, positional }
}

function absoluteOption(
  values: Map<string, string>,
  name: string,
): string | undefined {
  const value = values.get(name)
  if (value === undefined) return undefined
  if (!isAbsolute(value)) usage(`${name} 必须是绝对路径`)
  return resolve(value)
}

// ─── init ────────────────────────────────────────────────────────────

async function runInit(
  args: readonly string[],
  cwd: string,
  output: Output,
): Promise<number> {
  const { values, flags, positional } = parseOptions(
    args,
    ['--hub', '--console', '--key', '--token-file', '--project', '--device'],
    ['--no-token-file'],
  )
  if (positional.length > 0) usage(`init 不接受参数 ${positional[0]}`)
  const clearToken = flags.has('--no-token-file')
  if (clearToken && values.has('--token-file')) {
    usage('--token-file 与 --no-token-file 只能给一个')
  }
  const hubRaw = values.get('--hub')
  const consoleRaw = values.get('--console')
  if (hubRaw === undefined || consoleRaw === undefined) {
    usage('init 需要 --hub 与 --console')
  }
  const root = await gitTopLevel(cwd)
  if (root === null) throw new HandoffUserError(`${cwd} 不在 git 工作区里`)
  const hub = parseHub(hubRaw)
  const consoleUrl = parseConsoleUrl(consoleRaw)
  // Running init again re-registers: what is not given again is kept, so
  // fixing the console URL does not quietly drop the credential, rename the
  // device or forget the gate key.
  const existing = loadProject(root)
  const project = assertProjectName(
    values.get('--project') ?? existing?.project ?? basename(root),
  )
  const device = assertDeviceName(
    values.get('--device') ??
      existing?.device ??
      defaultDeviceName() ??
      usage('从主机名得不出可用的设备名：用 --device 指定'),
  )
  const key =
    absoluteOption(values, '--key') ??
    (hub.kind === 'ssh' ? existing?.key : undefined)
  if (hub.kind === 'ssh') {
    if (key === undefined) {
      usage(
        'SSH 中枢需要 --key <专用钥匙>：推拉只用这把钥匙（-o IdentitiesOnly=yes）',
      )
    }
    let isFile = false
    try {
      isFile = statSync(key).isFile()
    } catch {}
    if (!isFile) throw new HandoffUserError(`--key ${key} 不是一个文件`)
  }
  const givenToken = absoluteOption(values, '--token-file')
  const tokenFile = clearToken ? undefined : (givenToken ?? existing?.tokenFile)
  if (tokenFile !== undefined) readTokenFile(tokenFile)

  const repo = await initHubRepository(hub, project)
  await saveProject({
    root,
    project,
    device,
    hub,
    console: consoleUrl,
    ...(hub.kind === 'ssh' && key !== undefined ? { key } : {}),
    ...(tokenFile === undefined ? {} : { tokenFile }),
  })
  output.out(`已登记 ${root}`)
  output.out(`  项目    ${project}（设备 ${device}）`)
  output.out(
    hub.kind === 'local'
      ? `  中枢仓  ${repo}`
      : `  中枢仓  ${hubRepoUrl(hub, project)}（中枢上的 ${repo}）`,
  )
  output.out(`  控制台  ${consoleUrl}`)
  if (tokenFile !== undefined) {
    output.out(
      `  凭据    ${tokenFile}${givenToken === undefined ? '（沿用已登记的）' : ''}`,
    )
  } else {
    output.out(
      clearToken && existing?.tokenFile !== undefined
        ? '  凭据    已清除登记的凭据文件；now / status 要用，补上再 init 一次'
        : '  注意    没给 --token-file：now / status 要用，补上再 init 一次',
    )
  }
  return 0
}

// ─── sync ────────────────────────────────────────────────────────────

/**
 * The hook's JSON on stdin, read through `Bun.stdin` rather than by iterating
 * `process.stdin`. The CLI entry loads ink before it dispatches here (via
 * `startupProfiler`), and ink's `StdinContext` touches `process.stdin` at
 * module load. Under Bun 1.3.13 a `process.stdin` made over a regular file and
 * not read in that same tick gives nothing afterwards: a `< file` redirect on
 * any system, and on Linux every Blob stdin `Bun.spawn` passes (a memfd).
 * Measured on macOS and in a Linux container; a pipe, which is what Claude
 * Code hands its hooks, was not affected. `Bun.stdin` reads all three.
 */
async function readStdin(): Promise<string> {
  if (isatty(0)) {
    throw new HandoffUserError('--hook claude-code 要从标准输入读 hook 的 JSON')
  }
  return await Bun.stdin.text()
}

interface HookReport {
  readonly tool: HandoffTool
  readonly sessionId: string
  readonly cwd: string
  /** The transcript, or `null` for a thread that never wrote one. */
  readonly file: string | null
  readonly judge: (content: Buffer) => number | null
}

async function hookReport(
  tool: HandoffTool,
  positional: readonly string[],
): Promise<HookReport | null> {
  if (tool === 'qmcode') {
    const payload = positional.at(-1)
    if (payload === undefined) {
      throw new HandoffUserError(
        '--hook qmcode 要把 notify 的 JSON 作为最后一个参数',
      )
    }
    const notify = parseQmcodeNotify(payload)
    if (notify === null) return null
    return {
      tool,
      sessionId: notify.threadId,
      cwd: notify.cwd,
      file: findQmcodeRollout(qmcodeHome(), notify.threadId),
      judge: content => qmcodeTurnEnd(content, notify.turnId),
    }
  }
  const input = parseClaudeCodeHookInput(await readStdin())
  return {
    tool,
    sessionId: input.sessionId,
    cwd: input.cwd,
    file:
      readTranscript(input.transcriptPath) === null
        ? null
        : input.transcriptPath,
    judge: content => claudeCodeTurnEnd(content, input.event),
  }
}

/**
 * A turn ended in `tool`: record where its session is, wait for the turn to be
 * on disk, leave it pending and drain. Never throws; always 0.
 */
async function runHookSync(
  tool: HandoffTool,
  positional: readonly string[],
): Promise<number> {
  try {
    const report = await hookReport(tool, positional)
    if (report === null) return 0
    const root = await gitTopLevel(report.cwd)
    // A repository that never ran `init` is not a handoff project: nothing to
    // do, and nothing worth a log line on every turn.
    const project = root === null ? undefined : loadProject(root)
    if (root === null || project === undefined) return 0
    if (report.file === null) {
      appendSyncLog({
        event: 'skip',
        tool,
        sessionId: report.sessionId,
        reason: 'no transcript for this session (ephemeral thread)',
      })
      return 0
    }
    try {
      sessionRef(project.device, report.sessionId)
    } catch {
      appendSyncLog({
        event: 'skip',
        tool,
        reason: 'session id cannot be a ref name',
      })
      return 0
    }
    await recordSession({
      cwd: report.cwd,
      tool,
      sessionId: report.sessionId,
      file: report.file,
      at: Date.now(),
    })
    const landed = await waitForTurnEnd(report.file, report.judge)
    if (landed === null) {
      appendSyncLog({
        event: 'skip',
        tool,
        sessionId: report.sessionId,
        reason: 'turn not complete on disk after 2 s; not pushed',
      })
      return 0
    }
    writePending(root, {
      tool,
      sessionId: report.sessionId,
      file: report.file,
      length: landed.end,
    })
    await drainPending(project, { trigger: `hook:${tool}` })
  } catch (error) {
    appendSyncLog({
      event: 'hook-error',
      tool,
      reason: error instanceof Error ? error.message : String(error),
    })
  }
  return 0
}

async function runManualSync(cwd: string, output: Output): Promise<number> {
  const project = await projectAt(cwd)
  let snapshot: ReturnType<typeof sessionSnapshot> | null = null
  try {
    snapshot = sessionSnapshot(cwd, project.root, 'cut')
  } catch (error) {
    if (!(error instanceof HandoffUserError)) throw error
    output.err(`（只同步代码：${error.message}）`)
  }
  const lock = await waitForSyncLock(project.root)
  try {
    const taken = takePending(project.root)
    const sessions = mergeSnapshots(snapshot, taken)
    let result: Awaited<ReturnType<typeof syncOnce>>
    try {
      result = await syncOnce(project, sessions)
    } catch (error) {
      restorePending(project.root, taken)
      writeLastSync(project.root, {
        at: Date.now(),
        ok: false,
        reason: syncFailureReason(error),
      })
      logSync(project, 'manual', { error })
      throw new HandoffUserError(`同步失败：${syncFailureReason(error)}`)
    }
    writeLastSync(project.root, { at: Date.now(), ok: true, wip: result.wip })
    logSync(project, 'manual', result)
    output.out(`已同步  代码 ${result.wip}（${result.wipRef}）`)
    for (const session of result.sessions) {
      const redacted = session.redactions?.count ?? 0
      output.out(
        `        会话 ${session.commit}（${session.ref}）${session.reused ? ' 未变' : ''}${
          redacted > 0
            ? ` 脱敏 ${redacted} 处（${session.redactions?.ruleIds.join('、') ?? ''}）`
            : ''
        }`,
      )
    }
    if (result.excluded.length > 0) {
      output.out(
        `        按密钥文件名排除了 ${result.excluded.length} 个未跟踪文件`,
      )
    }
  } finally {
    lock.release()
  }
  if (pendingCount(project.root) > 0) {
    await drainPending(project, { trigger: 'manual' })
  }
  return 0
}

async function runSync(
  args: readonly string[],
  cwd: string,
  output: Output,
): Promise<number> {
  const { values, positional } = parseOptions(args, ['--hook'])
  const hook = values.get('--hook')
  if (hook === undefined) {
    if (positional.length > 0) usage(`sync 不接受参数 ${positional[0]}`)
    return await runManualSync(cwd, output)
  }
  if (hook !== 'qmcode' && hook !== 'claude-code') {
    usage('--hook 只认 qmcode 或 claude-code')
  }
  return await runHookSync(hook, positional)
}

// ─── now / status ────────────────────────────────────────────────────

async function runNowCommand(
  args: readonly string[],
  cwd: string,
  output: Output,
): Promise<number> {
  const { values, positional } = parseOptions(args, [
    '--goal',
    '--done',
    '--remaining',
    '--deadline',
  ])
  if (positional.length > 0) usage(`now 不接受参数 ${positional[0]}`)
  const pick = (name: string) => values.get(name)
  return await runNow(
    cwd,
    {
      ...(pick('--goal') === undefined ? {} : { goal: pick('--goal') }),
      ...(pick('--done') === undefined ? {} : { done: pick('--done') }),
      ...(pick('--remaining') === undefined
        ? {}
        : { remaining: pick('--remaining') }),
      ...(pick('--deadline') === undefined
        ? {}
        : { deadline: pick('--deadline') }),
    },
    output,
  )
}

async function runStatusCommand(
  args: readonly string[],
  cwd: string,
  output: Output,
): Promise<number> {
  const { values, flags, positional } = parseOptions(
    args,
    ['--task'],
    ['--wait'],
  )
  if (positional.length > 0) usage(`status 不接受参数 ${positional[0]}`)
  const taskId = values.get('--task')
  return await runStatus(
    cwd,
    { wait: flags.has('--wait'), ...(taskId === undefined ? {} : { taskId }) },
    output,
  )
}

// ─── entry ───────────────────────────────────────────────────────────

/** Dispatch `qm handoff <command>`; returns the exit code. */
async function dispatchHandoff(
  args: readonly string[],
  cwd: string = process.cwd(),
  output: Output = PROCESS_OUTPUT,
): Promise<number> {
  const [command, ...rest] = args
  if (command === undefined) {
    output.err(HANDOFF_HELP_TEXT)
    return 2
  }
  if (isHelpRequest(args)) {
    output.out(HANDOFF_HELP_TEXT)
    return 0
  }
  const reserved = RESERVED[command]
  if (reserved !== undefined) {
    output.err(
      `${invokedBinName()} handoff ${command}：尚未实现（${reserved}）`,
    )
    return 2
  }
  if (IDENTITY_MODE !== 'qianmo') {
    throw new HandoffUserError(
      'handoff 需要 OCC_IDENTITY=qianmo（或用 qm 运行）',
      2,
    )
  }
  switch (command) {
    case 'init':
      return await runInit(rest, cwd, output)
    case 'sync':
      return await runSync(rest, cwd, output)
    case 'now':
      return await runNowCommand(rest, cwd, output)
    case 'status':
      return await runStatusCommand(rest, cwd, output)
    default:
      return usage(`不认识的子命令 ${command}`)
  }
}

/** The fast-path entry (`cli.tsx`): runs, prints a refusal, sets the exit code. */
export async function runHandoff(args: readonly string[]): Promise<void> {
  try {
    process.exitCode = await dispatchHandoff(args)
  } catch (error) {
    if (error instanceof HandoffUserError) {
      process.stderr.write(`转交没有完成：${error.message}\n`)
      process.exitCode = error.exitCode
      return
    }
    process.stderr.write(
      `转交没有完成：${error instanceof Error ? error.message : String(error)}\n`,
    )
    process.exitCode = 1
  }
}
