// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `qm handoff now` and `qm handoff status` (P17.4 本地命令).
 *
 * ## `now`: say 「可以关机」 only after the hub has it
 *
 * In this order, and any step that does not hold ends the command with a
 * reason on stderr, exit 1, and **without the sentence**:
 *
 * 1. find the session: the calling qmcode thread's (`CODEX_THREAD_ID`, set
 *    when `/handoff` or `!` runs this), else the one reported from this
 *    directory (`sessions.json`); for qmcode, refuse while a turn is still
 *    running (「回合进行中」) — the transcript would end mid-turn — except
 *    the shell turn running this very command, which is left out;
 * 2. take the repository's sync lock and sync now (shadow commit, session
 *    commit, atomic push), including whatever hooks left pending;
 * 3. `git ls-remote` the hub: both refs must point at exactly the commits
 *    just pushed;
 * 4. compute the work tree's tree again and compare it with the shadow
 *    commit's (AC-H1): an edit between the sync and now would otherwise be
 *    left behind on the laptop;
 * 5. `POST /v0/handoff` — the hub checks the objects itself (`git cat-file`
 *    in its bare repository; a ref is no evidence there either) and writes
 *    `accepted` to its ledger;
 * 6. only on 201/200 with state `accepted`: 「已落地，可以关机」 and the task id.
 *
 * ## `status`
 *
 * This repository's settings, the session `now` would take, the last sync and
 * what is pending; then the hub's tasks for this project and device.
 * `--wait` polls one task (the latest, or the one named) until its state
 * changes.
 */

import {
  type HandoffManifest,
  isIsoInstant,
  MANIFEST_KIND,
  sessionRef,
  shadowTree,
} from '@qianmo/handoff'
import { qmcodeHome } from '../../config/paths.js'
import { gitTopLevel, hubConnection, lsRemote } from './handoffHub.js'
import {
  formatHub,
  type HandoffProject,
  HandoffUserError,
  loadProject,
  readTokenFile,
  sessionFor,
  sleep,
} from './handoffStore.js'
import {
  drainPending,
  logSync,
  mergeSnapshots,
  pendingCount,
  readLastSync,
  type SessionSnapshot,
  syncFailureReason,
  syncOnce,
  restorePending,
  takePending,
  waitForSyncLock,
  writeLastSync,
} from './handoffSync.js'
import {
  findQmcodeRollout,
  lastNewlineEnd,
  qmcodeSnapshot,
  readTranscript,
} from './handoffTranscript.js'

/** The sentence. Printed only after the hub answered `accepted`. */
const SAFE_TO_SHUT_DOWN = '已落地，可以关机'

const DEFAULT_GOAL = '接着本地会话，继续完成当前任务'
const DEFAULT_DEADLINE_MS = 24 * 60 * 60 * 1000
const REQUEST_TIMEOUT_MS = 30_000

export interface Output {
  out(line: string): void
  err(line: string): void
}

export const PROCESS_OUTPUT: Output = {
  out: line => process.stdout.write(`${line}\n`),
  err: line => process.stderr.write(`${line}\n`),
}

/** The repository and its settings, or the sentence that says why not. */
export async function projectAt(cwd: string): Promise<HandoffProject> {
  const root = await gitTopLevel(cwd)
  if (root === null) {
    throw new HandoffUserError(`${cwd} 不在 git 工作区里`)
  }
  const project = loadProject(root)
  if (project === undefined) {
    throw new HandoffUserError(
      `${root} 还没有登记接力：先运行 qm handoff init --hub … --console …`,
    )
  }
  return project
}

interface ConsoleAnswer {
  readonly status: number
  readonly body: Record<string, unknown>
}

async function consoleRequest(
  project: HandoffProject,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<ConsoleAnswer> {
  if (project.tokenFile === undefined) {
    throw new HandoffUserError(
      '没有登记控制台凭据：重新 qm handoff init --token-file <文件>',
    )
  }
  const token = readTokenFile(project.tokenFile)
  const url = `${project.console}${path}`
  let response: Response
  try {
    response = await fetch(url, {
      method,
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  } catch (error) {
    throw new HandoffUserError(
      `连不上控制台 ${project.console}：${error instanceof Error ? error.message : String(error)}`,
    )
  }
  let parsed: unknown = null
  try {
    parsed = await response.json()
  } catch {}
  return {
    status: response.status,
    body:
      typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {},
  }
}

function consoleError(answer: ConsoleAnswer): string {
  const error = answer.body.error
  const message =
    typeof error === 'object' &&
    error !== null &&
    typeof (error as Record<string, unknown>).message === 'string'
      ? ((error as Record<string, unknown>).message as string)
      : '（没有说明）'
  return `控制台回 ${answer.status}：${message}`
}

interface NowOptions {
  readonly goal?: string
  readonly done?: string
  readonly remaining?: string
  readonly deadline?: string
}

/**
 * The qmcode thread this process is a shell command of. qmcode sets
 * `CODEX_THREAD_ID` for `!` commands, `/handoff` and the model's shell tool —
 * not for `notify` or the MCP server (QIANMO.md 10.2, 10.3).
 */
function callingThread(): string | undefined {
  const id = process.env.CODEX_THREAD_ID
  return id === undefined || id === '' ? undefined : id
}

/**
 * The session to hand over: the calling qmcode thread's own rollout when
 * there is one (`/handoff` hands over the thread it was typed in), else the
 * one reported from `cwd` — with `at`, when a hook reported it.
 */
function sessionToHandOver(
  cwd: string,
  root: string,
  thread: string | undefined,
):
  | (Pick<SessionSnapshot, 'tool' | 'sessionId' | 'file'> & {
      readonly at?: number
    })
  | undefined {
  const own =
    thread === undefined ? null : findQmcodeRollout(qmcodeHome(), thread)
  if (thread !== undefined && own !== null) {
    return { tool: 'qmcode', sessionId: thread, file: own }
  }
  return sessionFor(cwd, root)
}

/**
 * The session to hand over, cut where it is complete. `now` refuses a
 * running turn — except the shell turn of the thread that is running it
 * (`qmcodeSnapshot`); a manual sync (`whileRunning: 'cut'`) takes everything
 * before the open turn.
 */
export function sessionSnapshot(
  cwd: string,
  root: string,
  whileRunning: 'refuse' | 'cut' = 'refuse',
): SessionSnapshot {
  const thread = callingThread()
  const location = sessionToHandOver(cwd, root, thread)
  if (location === undefined) {
    throw new HandoffUserError(
      '找不到这个目录的会话记录：先在 qmcode 或 Claude Code 里跑完一个回合（hook 会记下会话）',
    )
  }
  const content = readTranscript(location.file)
  if (content === null) {
    throw new HandoffUserError(`会话文件不在了：${location.file}`)
  }
  let end: number
  if (location.tool === 'qmcode') {
    const snapshot = qmcodeSnapshot(content, location.sessionId === thread)
    if (snapshot.open && whileRunning === 'refuse') {
      throw new HandoffUserError(
        `回合进行中（${snapshot.turnId}）：等这一轮结束再转交`,
      )
    }
    end = snapshot.open ? snapshot.before : snapshot.end
  } else {
    end = lastNewlineEnd(content)
  }
  if (end === 0) {
    throw new HandoffUserError(`会话文件还没有完整的一行：${location.file}`)
  }
  return {
    tool: location.tool,
    sessionId: location.sessionId,
    file: location.file,
    content: content.subarray(0, end),
  }
}

function deadlineOf(raw: string | undefined): string {
  if (raw === undefined) {
    return new Date(Date.now() + DEFAULT_DEADLINE_MS)
      .toISOString()
      .replace(/\.\d{3}Z$/, 'Z')
  }
  if (!isIsoInstant(raw)) {
    throw new HandoffUserError(
      '--deadline 要写成 UTC 时间，如 2026-11-20T02:00:00Z',
      2,
    )
  }
  return raw
}

/** `qm handoff now`. Returns the exit code. */
export async function runNow(
  cwd: string,
  options: NowOptions,
  output: Output = PROCESS_OUTPUT,
): Promise<number> {
  const project = await projectAt(cwd)
  const deadline = deadlineOf(options.deadline)
  // The credential is checked before anything is pushed: a handoff that can
  // never be registered should not have synced first.
  if (project.tokenFile === undefined) {
    throw new HandoffUserError(
      '没有登记控制台凭据：重新 qm handoff init --token-file <文件>',
    )
  }
  readTokenFile(project.tokenFile)
  const snapshot = sessionSnapshot(cwd, project.root)
  let thisSessionRef: string
  try {
    thisSessionRef = sessionRef(project.device, snapshot.sessionId)
  } catch {
    throw new HandoffUserError(
      `会话 id ${snapshot.sessionId} 不能用作引用名，转交不了`,
    )
  }

  const lock = await waitForSyncLock(project.root)
  let manifest: HandoffManifest
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
      logSync(project, 'now', { error })
      throw new HandoffUserError(`同步失败：${syncFailureReason(error)}`)
    }
    writeLastSync(project.root, { at: Date.now(), ok: true, wip: result.wip })
    logSync(project, 'now', result)
    const session = result.sessions.find(s => s.ref === thisSessionRef)
    if (session === undefined) {
      throw new HandoffUserError('同步结果里没有本会话的提交')
    }

    const remote = await lsRemote(hubConnection(project), project.root)
    for (const [ref, sha] of [
      [result.wipRef, result.wip],
      [session.ref, session.commit],
    ] as const) {
      const there = remote.get(ref)
      if (there !== sha) {
        throw new HandoffUserError(
          `中枢上的 ${ref} 是 ${there ?? '（不存在）'}，不是刚推送的 ${sha}`,
        )
      }
    }
    const now = await shadowTree({ cwd: project.root })
    if (now.tree !== result.tree) {
      throw new HandoffUserError(
        `同步之后工作区又变了（现在的树 ${now.tree}，推送的树 ${result.tree}）：再运行一次 qm handoff now`,
      )
    }
    manifest = {
      kind: MANIFEST_KIND,
      project: project.project,
      device: project.device,
      branch: result.branch,
      wip: result.wip,
      tree: result.tree,
      tool: snapshot.tool,
      sessionId: snapshot.sessionId,
      sessionRef: session.ref,
      sessionCommit: session.commit,
      cwd: project.root,
      brief: {
        goal: options.goal ?? DEFAULT_GOAL,
        done: options.done ?? '',
        remaining: options.remaining ?? '',
      },
      deadline,
    }
  } finally {
    lock.release()
  }

  const answer = await consoleRequest(project, 'POST', '/v0/handoff', manifest)
  const task = answer.body.task as Record<string, unknown> | undefined
  if (
    (answer.status !== 201 && answer.status !== 200) ||
    typeof task !== 'object' ||
    task === null ||
    task.state !== 'accepted' ||
    typeof task.taskId !== 'string'
  ) {
    throw new HandoffUserError(`中枢没有登记这次转交：${consoleError(answer)}`)
  }
  output.out(SAFE_TO_SHUT_DOWN)
  output.out(`  任务  ${task.taskId}`)
  output.out(
    `  代码  ${manifest.wip}（refs/qianmo/wip/${manifest.device}/${manifest.branch}）`,
  )
  output.out(`  会话  ${manifest.sessionCommit}（${manifest.sessionRef}）`)
  if (answer.body.created === false) {
    output.out('  （同一份清单已登记过，沿用原任务）')
  }

  // Hooks that ran while this held the lock left their entries for it.
  if (pendingCount(project.root) > 0) {
    await drainPending(project, { trigger: 'now' })
  }
  return 0
}

// ─── status ──────────────────────────────────────────────────────────

interface TaskLine {
  readonly taskId: string
  readonly state: string
  readonly acceptedAt: number
  readonly project: string
  readonly device: string
  readonly goal: string
}

function taskLine(value: unknown): TaskLine | null {
  if (typeof value !== 'object' || value === null) return null
  const task = value as Record<string, unknown>
  const manifest = task.manifest as Record<string, unknown> | undefined
  const brief = manifest?.brief as Record<string, unknown> | undefined
  if (
    typeof task.taskId !== 'string' ||
    typeof task.state !== 'string' ||
    typeof task.acceptedAt !== 'number' ||
    typeof manifest?.project !== 'string' ||
    typeof manifest.device !== 'string'
  ) {
    return null
  }
  return {
    taskId: task.taskId,
    state: task.state,
    acceptedAt: task.acceptedAt,
    project: manifest.project,
    device: manifest.device,
    goal: typeof brief?.goal === 'string' ? brief.goal : '',
  }
}

function describeTask(task: TaskLine): string {
  return `  ${task.taskId}  ${task.state.padEnd(10)} ${new Date(task.acceptedAt).toISOString()}  ${task.goal.slice(0, 60)}`
}

interface StatusOptions {
  readonly wait: boolean
  readonly taskId?: string
}

/** `qm handoff status`. Returns the exit code. */
export async function runStatus(
  cwd: string,
  options: StatusOptions,
  output: Output = PROCESS_OUTPUT,
): Promise<number> {
  const project = await projectAt(cwd)
  if (!options.wait) {
    output.out(`仓库    ${project.root}`)
    output.out(`项目    ${project.project}（设备 ${project.device}）`)
    output.out(`中枢    ${formatHub(project.hub)}`)
    output.out(`控制台  ${project.console}`)
    const session = sessionToHandOver(cwd, project.root, callingThread())
    output.out(
      session === undefined
        ? '会话    （还没有 hook 报过）'
        : `会话    ${session.tool} ${session.sessionId}（${session.at === undefined ? '运行这条命令的 qmcode 线程' : new Date(session.at).toISOString()}）`,
    )
    const last = readLastSync(project.root)
    output.out(
      last === undefined
        ? '同步    （还没同步过）'
        : `同步    ${new Date(last.at).toISOString()} ${last.ok ? `成功 ${last.wip ?? ''}` : `失败：${last.reason ?? ''}`}`,
    )
    const pending = pendingCount(project.root)
    if (pending > 0) output.out(`待同步  ${pending} 个会话`)
  }

  const listed = await consoleRequest(project, 'GET', '/v0/handoff')
  if (listed.status !== 200 || !Array.isArray(listed.body.tasks)) {
    throw new HandoffUserError(`查不了中枢台账：${consoleError(listed)}`)
  }
  const mine = listed.body.tasks
    .map(taskLine)
    .filter(
      (task): task is TaskLine =>
        task !== null &&
        task.project === project.project &&
        task.device === project.device,
    )
    .sort((a, b) => b.acceptedAt - a.acceptedAt)

  if (!options.wait) {
    output.out(mine.length === 0 ? '任务    （没有）' : '任务')
    for (const task of mine.slice(0, 5)) output.out(describeTask(task))
    return 0
  }

  const target =
    options.taskId === undefined
      ? mine[0]
      : mine.find(task => task.taskId === options.taskId)
  if (target === undefined) {
    throw new HandoffUserError(
      options.taskId === undefined
        ? '这个项目在中枢上还没有接力任务'
        : `中枢上没有本项目的任务 ${options.taskId}`,
    )
  }
  output.out(`等待 ${target.taskId} 离开 ${target.state} …`)
  let delay = 1_000
  for (;;) {
    if (target.state === 'returned') {
      output.out(`${target.taskId}  ${target.state}（已是最后一步）`)
      return 0
    }
    await sleep(delay)
    delay = Math.min(delay * 2, 10_000)
    const answer = await consoleRequest(
      project,
      'GET',
      `/v0/handoff/${encodeURIComponent(target.taskId)}`,
    )
    const task = taskLine(answer.body.task)
    if (answer.status !== 200 || task === null) {
      throw new HandoffUserError(
        `查不了任务 ${target.taskId}：${consoleError(answer)}`,
      )
    }
    if (task.state !== target.state) {
      output.out(`${task.taskId}  ${target.state} → ${task.state}`)
      return 0
    }
  }
}
