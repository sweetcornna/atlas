// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `qm handoff pull [taskId]` — bring a cloud result home (`handoff-p17-plan.md`
 * §2 P17.6; AC-H5 「接回不覆盖」).
 *
 * ## Steps
 *
 * 1. Ask the hub for the task (`GET /v0/handoff/<task>`). Only `done` has a
 *    result to bring back; `returned` is taken again (a second pull is
 *    harmless); `failed` and the states before `done` are refused with what to
 *    do instead. Without a task id: this project's and device's newest `done`.
 * 2. `git fetch` from the hub, with the gate key, `qianmo/<task>` and — for a
 *    qmcode session — the cloud session ref, into two temporary refs under
 *    `refs/qianmo/pull/<task>/`, removed again at the end. The fetched tip must
 *    be the result's `head`, and the shadow commit the task started from must
 *    be its ancestor.
 * 3. **Untouched since the handoff** means all four: on a branch, the branch
 *    the handoff was made from, HEAD is the shadow commit's parent, and the
 *    work tree's tree (`shadowTree`, a private index: nothing of the user's is
 *    written) is the shadow commit's tree. The plan names the last two; the
 *    branch is added so that switching branches counts as a change and takes
 *    the safe way.
 *    - Untouched: fast-forward the current branch. A plain
 *      `git merge --ff-only` is refused whenever the handoff carried
 *      uncommitted or untracked files — the usual case — because those files
 *      are dirty against HEAD and the target tree changes them. Since the work
 *      tree **is** the shadow commit's tree, `git reset --mixed <shadow>` first
 *      (branch to the shadow commit, index to its tree; no file touched) leaves
 *      a clean work tree, and then `git merge --ff-only <head>` is an ordinary
 *      fast-forward that git itself checks. If either step fails, the branch
 *      and the index file are put back and the result goes on a branch
 *      instead.
 *    - Otherwise: `refs/heads/qianmo/<task>-return` → the result. HEAD, the
 *      index and every work-tree file stay as they are; the diff statistics
 *      are tree against tree (what the cloud changed since the handoff, what
 *      changed here since), so not even an index refresh happens.
 * 4. A qmcode session goes back to `$QMCODE_HOME/sessions/` under the file
 *    name the node committed it with (the laptop's own rollout name), so
 *    `qmcode resume <thread>` continues it here. A rollout of that thread that
 *    differs is renamed to `<name>.before-pull-<task>` first — qmcode reads
 *    only `.jsonl`, so the old one stays on disk and out of the way. It nearly
 *    always differs: `/handoff` is itself a shell turn that qmcode writes into
 *    the local rollout after the handoff was taken.
 * 5. `POST /v0/handoff/<task>/return`: the ledger says `returned`. Last, so it
 *    is never said before it is true; when it fails, the exit code is 1 and
 *    the message says the local part is done and a second pull records it.
 *
 * The user's hooks do not run (an empty `core.hooksPath` for every command),
 * and no gc or maintenance starts. Pulls and handoffs of one repository take
 * the same lock (`now.lock`), so two do not interleave.
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import {
  acquireExclusiveLock,
  CLOUD_DEVICE,
  isSha,
  LockHeldError,
  runGit,
  sessionRef,
  shadowTree,
  taskBranch,
  taskRef,
} from '@qianmo/handoff'
import { qmcodeHome } from '../../config/paths.js'
import { fetchFromHub, hubConnection, localRef } from './handoffHub.js'
import {
  consoleError,
  consoleRequest,
  nowLockPath,
  type Output,
  PROCESS_OUTPUT,
  projectAt,
  projectTasks,
} from './handoffNow.js'
import { type HandoffProject, HandoffUserError } from './handoffStore.js'
import { findQmcodeRollout } from './handoffTranscript.js'

/** How the result came home. */
type ReturnMode = 'fast-forward' | 'branch'

export interface PullOptions {
  readonly taskId?: string
  /**
   * The qmcode thread this runs in (`CODEX_THREAD_ID` for `/pull`, the MCP
   * call's `_meta.threadId`): when it is the task's thread, the answer says
   * the open thread has to be resumed again to show the cloud's turns.
   */
  readonly callerThread?: string
}

/** What the hub says about one task, as far as pulling goes. */
interface PullableTask {
  readonly taskId: string
  readonly state: string
  readonly project: string
  readonly branch: string
  readonly wip: string
  readonly tree: string
  readonly tool: string
  readonly status: string
  readonly head: string
  readonly threadId: string
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** States that come before the cloud is finished. */
const NOT_YET: ReadonlySet<string> = new Set([
  'accepted',
  'dispatched',
  'running',
])

async function pullableTask(
  project: HandoffProject,
  taskId: string,
): Promise<PullableTask> {
  const answer = await consoleRequest(
    project,
    'GET',
    `/v0/handoff/${encodeURIComponent(taskId)}`,
  )
  if (answer.status === 404) {
    throw new HandoffUserError(`中枢台账里没有任务 ${taskId}`)
  }
  if (answer.status !== 200) {
    throw new HandoffUserError(`查不了任务 ${taskId}：${consoleError(answer)}`)
  }
  const task = record(answer.body.task)
  const manifest = record(task.manifest)
  const result = record(task.result)
  const state = text(task.state)
  if (NOT_YET.has(state)) {
    throw new HandoffUserError(
      `任务 ${taskId} 还在云端（${state}）· 没有结果可接回 · 等它结束：qm handoff status --wait --task ${taskId} · 要看现场：qm handoff attach ${taskId}`,
    )
  }
  if (state === 'failed') {
    throw new HandoffUserError(
      `任务 ${taskId} 失败了（failed）· 没有云端结果可接回 · 原因：${text(task.reason) || '没有写'}`,
    )
  }
  if (state !== 'done' && state !== 'returned') {
    throw new HandoffUserError(`任务 ${taskId} 的状态 ${state || '?'} 不认识`)
  }
  const pulled: PullableTask = {
    taskId,
    state,
    project: text(manifest.project),
    branch: text(manifest.branch),
    wip: text(manifest.wip),
    tree: text(manifest.tree),
    tool: text(manifest.tool),
    status: text(result.status),
    head: text(result.head),
    threadId: text(result.threadId),
  }
  if (pulled.project !== project.project) {
    throw new HandoffUserError(
      `任务 ${taskId} 属于项目 ${pulled.project || '?'} · 这个仓库登记的是 ${project.project}`,
    )
  }
  if (
    !isSha(pulled.wip) ||
    !isSha(pulled.tree) ||
    !isSha(pulled.head) ||
    text(result.branch) !== taskBranch(taskId) ||
    pulled.threadId === ''
  ) {
    throw new HandoffUserError(`中枢给的任务 ${taskId} 缺清单或结果字段`)
  }
  return pulled
}

/** This project's newest task that has a result to bring back. */
async function latestDone(project: HandoffProject): Promise<string> {
  const mine = await projectTasks(project)
  const done = mine.find(task => task.state === 'done')
  if (done !== undefined) return done.taskId
  const running = mine.find(task => NOT_YET.has(task.state))
  throw new HandoffUserError(
    running === undefined
      ? `本项目 ${project.project} 在本设备 ${project.device} 上没有待接回的任务 · 接回别的任务要给出任务号`
      : `本项目最近的任务 ${running.taskId} 还在云端（${running.state}）· 等它结束再接回 · 要看现场：qm handoff attach ${running.taskId}`,
  )
}

/** Run `git` in the repository with the user's hooks and gc switched off. */
function quietGit(
  root: string,
  hooks: string,
): (
  args: readonly string[],
  okExitCodes?: readonly number[],
) => ReturnType<typeof runGit> {
  return (args, okExitCodes) =>
    runGit(
      [
        '-c',
        `core.hooksPath=${hooks}`,
        '-c',
        'core.fsmonitor=false',
        '-c',
        'gc.auto=0',
        '-c',
        'maintenance.auto=false',
        ...args,
      ],
      { cwd: root, ...(okExitCodes === undefined ? {} : { okExitCodes }) },
    )
}

type Git = ReturnType<typeof quietGit>

async function line(git: Git, args: readonly string[]): Promise<string> {
  return (await git(args)).stdout.toString('utf8').trim()
}

/** `<commit>^1`, or `null` for a root commit. */
async function firstParent(git: Git, commit: string): Promise<string | null> {
  const probe = await git(
    ['rev-parse', '-q', '--verify', `${commit}^1`],
    [1, 128],
  )
  const sha = probe.stdout.toString('utf8').trim()
  return probe.exitCode === 0 && sha !== '' ? sha : null
}

/** `git diff --stat` of two trees, indented; `（没有改动）` when empty. */
async function treeStat(git: Git, from: string, to: string): Promise<string[]> {
  const stat = await line(git, ['diff', '--stat', '--no-color', from, to, '--'])
  return stat === ''
    ? ['    （没有改动）']
    : stat.split('\n').map(row => `    ${row.trimStart()}`)
}

interface FastForward {
  readonly ok: boolean
  readonly reason?: string
}

/**
 * Branch to the shadow commit (index to its tree; the work tree already is
 * it), then an ordinary `merge --ff-only`. On failure the branch and the index
 * file are put back as they were.
 */
async function fastForward(
  git: Git,
  root: string,
  branch: string,
  from: string,
  wip: string,
  head: string,
): Promise<FastForward> {
  const index = resolve(
    root,
    await line(git, ['rev-parse', '--git-path', 'index']),
  )
  const backup = `${index}.qianmo-pull-${process.pid}`
  const hadIndex = existsSync(index)
  if (hadIndex) copyFileSync(index, backup)
  try {
    await git(['reset', '-q', '--mixed', wip])
    await git(['merge', '--ff-only', '-q', head])
    rmSync(backup, { force: true })
    return { ok: true }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    try {
      await git([
        'update-ref',
        '-m',
        'qianmo handoff pull: put back after a failed fast-forward',
        `refs/heads/${branch}`,
        from,
      ])
      if (hadIndex) renameSync(backup, index)
    } catch (rollback) {
      throw new HandoffUserError(
        `快进失败（${reason.slice(0, 300)}）也没能还原 · 分支 ${branch} 应指回 ${from} · index 的备份在 ${backup} · ${rollback instanceof Error ? rollback.message : String(rollback)}`,
      )
    }
    return { ok: false, reason: reason.split('\n')[0]?.slice(0, 300) ?? '' }
  }
}

interface PlacedSession {
  readonly path: string
  readonly status: 'new' | 'same' | 'replaced'
  readonly backup?: string
}

/** `rollout-YYYY-MM-DDT…-<thread>.jsonl`, the name qmcode gives its rollouts. */
const ROLLOUT_NAME =
  /^rollout-(\d{4})-(\d{2})-(\d{2})T[0-9-]+-[A-Za-z0-9_-]+\.jsonl$/

/**
 * Put the cloud session (the one file of the fetched session commit) where
 * qmcode looks for the thread's rollout.
 */
async function placeSession(
  git: Git,
  commit: string,
  threadId: string,
  taskId: string,
): Promise<PlacedSession> {
  const entries = (await git(['ls-tree', '-z', commit])).stdout
    .toString('utf8')
    .split('\0')
    .filter(entry => entry !== '')
  const match = /^100644 blob ([0-9a-f]{40,64})\t(.+)$/s.exec(entries[0] ?? '')
  const blob = match?.[1]
  const name = match?.[2]
  if (entries.length !== 1 || blob === undefined || name === undefined) {
    throw new HandoffUserError(`云端会话提交 ${commit} 的树不是单个会话文件`)
  }
  const dated = ROLLOUT_NAME.exec(name)
  if (dated === null || !name.endsWith(`-${threadId}.jsonl`)) {
    throw new HandoffUserError(
      `云端会话文件名 ${JSON.stringify(name)} 不是线程 ${threadId} 的 qmcode 会话`,
    )
  }
  const content = (await git(['cat-file', 'blob', blob])).stdout
  const home = qmcodeHome()
  const existing = findQmcodeRollout(home, threadId)
  if (existing !== null) {
    if (readFileSync(existing).equals(content)) {
      return { path: existing, status: 'same' }
    }
    let backup = `${existing}.before-pull-${taskId}`
    for (let n = 2; existsSync(backup); n++) {
      backup = `${existing}.before-pull-${taskId}-${n}`
    }
    renameSync(existing, backup)
    writeAtomically(existing, content)
    return { path: existing, status: 'replaced', backup }
  }
  const path = join(
    home,
    'sessions',
    dated[1] ?? '',
    dated[2] ?? '',
    dated[3] ?? '',
    name,
  )
  writeAtomically(path, content)
  return { path, status: 'new' }
}

function writeAtomically(path: string, content: Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, content, { mode: 0o600 })
  renameSync(temp, path)
}

/** `qm handoff pull`. Returns the exit code. */
export async function runPull(
  cwd: string,
  options: PullOptions,
  output: Output = PROCESS_OUTPUT,
): Promise<number> {
  const project = await projectAt(cwd)
  if (project.tokenFile === undefined) {
    throw new HandoffUserError(
      '没有登记控制台凭据 · 重新 qm handoff init --token-file <文件>',
    )
  }
  let lock: ReturnType<typeof acquireExclusiveLock>
  try {
    lock = acquireExclusiveLock(nowLockPath(project.root))
  } catch (error) {
    if (!(error instanceof LockHeldError)) throw error
    throw new HandoffUserError(
      `这个仓库有一份转交或接回正在进行${error.holder === null ? '' : `（pid ${error.holder}）`} · 等它结束再试`,
    )
  }
  try {
    return await pull(project, options, output)
  } finally {
    lock.release()
  }
}

async function pull(
  project: HandoffProject,
  options: PullOptions,
  output: Output,
): Promise<number> {
  const taskId = options.taskId ?? (await latestDone(project))
  const task = await pullableTask(project, taskId)
  const qmcodeSession = task.tool === 'qmcode'
  const hooks = mkdtempSync(join(tmpdir(), 'qianmo-handoff-pull-'))
  const git = quietGit(project.root, hooks)
  const pulledHead = `refs/qianmo/pull/${taskId}/head`
  const pulledSession = `refs/qianmo/pull/${taskId}/session`
  let mode: ReturnMode = 'branch'
  try {
    try {
      await fetchFromHub(hubConnection(project), project.root, [
        `+${taskRef(taskId)}:${pulledHead}`,
        ...(qmcodeSession
          ? [`+${sessionRef(CLOUD_DEVICE, task.threadId)}:${pulledSession}`]
          : []),
      ])
    } catch (error) {
      throw new HandoffUserError(
        `从中枢取回 ${taskBranch(taskId)} 失败：${error instanceof Error ? error.message.split('\n')[0] : String(error)}`,
      )
    }
    const fetched = await localRef(project.root, pulledHead)
    if (fetched !== task.head) {
      throw new HandoffUserError(
        `中枢上的 ${taskBranch(taskId)} 是 ${fetched ?? '（不存在）'} · 不是结果里的 ${task.head}`,
      )
    }
    const grown = await git(
      ['merge-base', '--is-ancestor', task.wip, task.head],
      [1],
    )
    if (grown.exitCode !== 0) {
      throw new HandoffUserError(
        `云端分支 ${task.head} 不是从这次转交的影子提交 ${task.wip} 长出来的 · 不接回`,
      )
    }

    const here = await shadowTree({ cwd: project.root })
    const returnBranch = `${taskBranch(taskId)}-return`
    const existingReturn = await localRef(
      project.root,
      `refs/heads/${returnBranch}`,
    )
    output.out(
      `接回  任务 ${taskId}（云端 ${task.status || '?'} · 线程 ${task.threadId}）`,
    )

    if (here.head === task.head) {
      mode = 'fast-forward'
      output.out(`  代码  本机已在云端结果上（${task.head}）· 不用再动`)
    } else if (existingReturn === task.head) {
      mode = 'branch'
      output.out(
        `  代码  分支 ${returnBranch} 已指向云端结果（${task.head}）· 不用再动`,
      )
    } else {
      const parent = await firstParent(git, task.wip)
      const changes: string[] = []
      if (here.branch === null) changes.push('当前不在分支上')
      else if (here.branch !== task.branch) {
        changes.push(`当前分支是 ${here.branch} · 转交时是 ${task.branch}`)
      }
      if (parent === null) changes.push('转交时的分支还没有提交')
      else if (here.head !== parent) {
        changes.push(`HEAD 是 ${here.head ?? '（无）'} · 转交时是 ${parent}`)
      }
      if (here.tree !== task.tree) changes.push('工作区与转交时不同')

      let fellBack: string | null = null
      if (changes.length === 0 && here.branch !== null && parent !== null) {
        const ff = await fastForward(
          git,
          project.root,
          here.branch,
          parent,
          task.wip,
          task.head,
        )
        if (ff.ok) {
          mode = 'fast-forward'
          output.out(
            `  代码  本地没动过：快进 ${here.branch} ${parent} → ${task.head}`,
          )
          output.out('  云端改动')
          for (const row of await treeStat(git, task.wip, task.head))
            output.out(row)
        } else {
          fellBack = ff.reason ?? ''
          mode = 'branch'
        }
      } else {
        mode = 'branch'
      }
      if (mode === 'branch') {
        if (existingReturn !== undefined) {
          throw new HandoffUserError(
            `分支 ${returnBranch} 已存在 · 指向 ${existingReturn} 而不是云端结果 ${task.head} · 先改名或删掉它再接回`,
          )
        }
        await git([
          'update-ref',
          '-m',
          `qianmo handoff pull: cloud result of ${taskId}`,
          `refs/heads/${returnBranch}`,
          task.head,
          '',
        ])
        output.out(
          fellBack === null
            ? `  代码  本地在转交后动过（${changes.join('；')}）· 工作区一个文件没动 · 云端结果在新分支 ${returnBranch}（${task.head}）`
            : `  代码  快进没有成功（${fellBack}）· 分支与 index 已还原 · 工作区一个文件没动 · 云端结果在新分支 ${returnBranch}（${task.head}）`,
        )
        output.out('  云端改动（相对转交时的工作区）')
        for (const row of await treeStat(git, task.wip, task.head))
          output.out(row)
        output.out('  本机改动（转交之后）')
        for (const row of await treeStat(git, task.wip, here.tree))
          output.out(row)
        output.out(
          `  合并  由你决定：git merge ${returnBranch} · 先看差异：git diff HEAD ${returnBranch}`,
        )
      }
    }

    if (qmcodeSession) {
      const commit = await localRef(project.root, pulledSession)
      if (commit === undefined) {
        throw new HandoffUserError(
          `中枢上没有云端会话 ${sessionRef(CLOUD_DEVICE, task.threadId)}`,
        )
      }
      const placed = await placeSession(git, commit, task.threadId, taskId)
      output.out(
        `  会话  ${placed.path}${placed.status === 'same' ? '（已是云端那份）' : ''}`,
      )
      if (placed.backup !== undefined) {
        output.out(`        本机原来那份改名为 ${placed.backup}`)
      }
      output.out(
        options.callerThread === task.threadId
          ? `        这个线程正开着 · 退出 qmcode 后运行 qmcode resume ${task.threadId} 才看得到云端的回合`
          : `        qmcode resume ${task.threadId} 接着聊`,
      )
    } else {
      output.out(
        `  会话  Claude Code 会话在云端续成了 qmcode 线程 ${task.threadId} · 留在中枢 ${sessionRef(CLOUD_DEVICE, task.threadId)} · 没有放到本机`,
      )
    }
  } finally {
    for (const ref of [pulledHead, pulledSession]) {
      await git(['update-ref', '-d', ref], [1]).catch(() => {})
    }
    rmSync(hooks, { recursive: true, force: true })
  }

  if (task.state === 'returned') {
    output.out('  台账  已是 returned')
    return 0
  }
  const answer = await consoleRequest(
    project,
    'POST',
    `/v0/handoff/${encodeURIComponent(taskId)}/return`,
    { device: project.device, mode },
  )
  if (answer.status !== 200) {
    throw new HandoffUserError(
      `本机已经接回 · 中枢没有记下 returned（${consoleError(answer)}）· 再运行一次 qm handoff pull ${taskId} 补记`,
    )
  }
  output.out('  台账  returned')
  return 0
}
