// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The hub's handoff ledger behind `/v0/handoff` (P17.4,
 * `handoff-p17-plan.md` §2 P17.4「中枢」表).
 *
 * `qm console --handoff-root <root>` wires this. `<root>` is the directory the
 * bare repositories live in — `<root>/<project>.git`, created by
 * `qm handoff init` over the user's own SSH and written to through the SSH
 * gate (`demo/env/beta/ops/handoff-git-gate.sh`, same root). This module does
 * three things with it:
 *
 * 1. **Checks that the data landed before it says so.** `accept` validates the
 *    manifest (`@qianmo/handoff`), then asks git in the bare repository whether
 *    the shadow commit, its tree, the session commit and the session's one
 *    blob are all there, and whether the shadow commit's tree is the work-tree
 *    tree the laptop computed (AC-H1). Only then is `accepted` written — and
 *    `qm handoff now` tells a person 「可以关机」 on exactly that answer.
 *    `git cat-file -e` is the check because a ref is no evidence: a bare
 *    repository advertises a ref whose object has been deleted, and a push of
 *    the same commit then reports "Everything up-to-date".
 * 2. **Keeps the ledger single-writer.** `HandoffLedger.open` takes
 *    `<ledger>.lock` (ruling 10): a second hub on the same config root fails to
 *    start, a crashed one's lock is reclaimed by the next start.
 * 3. **Writes the audit line.** `handoff.accepted` into a chain of its own
 *    (`<config root>/qianmo/handoff/audit.ndjson`), written only by the process
 *    holding the ledger lock, so the chain has one writer too. Add it to the
 *    console as `--audit hub-handoff=<that path>` to see it on the audit page.
 *
 * With `--handoff-node`, a fourth: accepted tasks go to node bridges and
 * come back (P17.5, `consoleHandoffDispatch.ts`), which writes
 * `handoff.dispatched`, `handoff.completed` and `handoff.failed` into the same
 * chain.
 *
 * P17.6 adds the two ends a person drives from a laptop:
 *
 * - `attach` gives `qm handoff attach` the node and thread of a **running**
 *   task and writes `handoff.attach-requested`. It is a locator and nothing
 *   more: the node's app-server token is read from the node over the user's
 *   own SSH and never passes through here (plan D-6). The thread is the
 *   manifest's `sessionId` for a qmcode session — the node resumes that very
 *   thread — and unknown (`null`) for a Claude Code session until the result
 *   names it, because the node imports it as a new thread and nothing on the
 *   protocol carries that id back before `task.result`;
 * - `markReturned` records `qm handoff pull` having brought the result home:
 *   `done` / `failed` → `returned` and `handoff.returned`. Asked again for a
 *   task already `returned` it answers success with `changed: false`, so a
 *   pull that is run again after the hub was unreachable is not an error.
 */

import { randomBytes } from 'node:crypto'
import { statSync } from 'node:fs'
import { join } from 'node:path'
import { type AuditInput, AuditSource, AuditTrail } from '@qianmo/audit'
import type {
  ConsoleResult,
  HandoffAcceptance,
  HandoffAttachView,
  HandoffPort,
  HandoffReturnView,
  HandoffSendView,
  HandoffTaskView,
} from '@qianmo/console'
import {
  type HandoffManifest,
  HandoffLedger,
  HandoffLedgerError,
  LockHeldError,
  runGit,
  validateManifest,
} from '@qianmo/handoff'
import { occConfigPath } from '../../config/paths.js'
import {
  createHandoffDispatcher,
  type HandoffDispatcher,
  type HandoffDispatchWiring,
} from './consoleHandoffDispatch.js'

/**
 * Every audit kind the hub writes under `AuditSource.Handoff`
 * (`handoff-p17-plan.md` P17.4「审计」行). P17.4 writes the first; the rest
 * belong to dispatch (P17.5) and to attach / pull (P17.6).
 */
export const HANDOFF_AUDIT_KINDS = [
  'handoff.accepted',
  'handoff.dispatched',
  'handoff.completed',
  'handoff.failed',
  'handoff.returned',
  'handoff.attach-requested',
] as const

/** The hub's ledger: `<config root>/qianmo/handoff/ledger.ndjson`. */
function handoffLedgerPath(): string {
  return occConfigPath('qianmo', 'handoff', 'ledger.ndjson')
}

/** The hub's own audit chain for handoff events. */
function handoffAuditPath(): string {
  return occConfigPath('qianmo', 'handoff', 'audit.ndjson')
}

interface ConsoleHandoffOptions {
  /** Directory holding `<project>.git`; the `--handoff-root` value. */
  readonly root: string
  readonly ledgerPath?: string
  readonly auditPath?: string
  readonly now?: () => number
  /** For tests; defaults to `YYYYMMDD-HHMMSS-<6 hex>` in UTC. */
  readonly newTaskId?: () => string
  /** Where a failed audit write is reported; defaults to stderr. */
  readonly onError?: (line: string) => void
  /** `--handoff-node …` resolved (P17.5); no config, no dispatch. */
  readonly dispatch?: HandoffDispatchWiring
}

interface ConsoleHandoff {
  readonly port: HandoffPort
  readonly root: string
  readonly ledgerPath: string
  readonly auditPath: string
  /** Tasks in the ledger when it was opened. */
  readonly replayed: number
  /** The banner's `handoff-node` line: where tasks go, or why nowhere. */
  readonly dispatchStatus: string
  /** Start dispatching; called once the console's port is bound. */
  start(): void
  /** Close the ledger (releasing its lock) and the audit chain. */
  close(): void
}

function failure<T>(
  code: 'invalid' | 'rejected' | 'not_found' | 'unreachable',
  message: string,
): ConsoleResult<T> {
  return { ok: false, failure: { code, message } }
}

function defaultTaskId(now: number): string {
  const iso = new Date(now).toISOString()
  const stamp = `${iso.slice(0, 10).replaceAll('-', '')}-${iso
    .slice(11, 19)
    .replaceAll(':', '')}`
  return `${stamp}-${randomBytes(3).toString('hex')}`
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * Whether everything the manifest points at is in the hub's bare repository.
 * `null` when it is; otherwise the sentence to hand back to the laptop.
 */
async function landingProblem(
  root: string,
  manifest: HandoffManifest,
): Promise<string | null> {
  const repo = join(root, `${manifest.project}.git`)
  if (!isDirectory(repo)) {
    return `中枢上没有项目 ${manifest.project} 的裸仓（${repo}）：先在本机运行 qm handoff init`
  }
  const git = (args: readonly string[]) =>
    runGit(['--git-dir', repo, ...args], {
      cwd: repo,
      okExitCodes: [1, 128],
    })
  const has = async (spec: string): Promise<boolean> =>
    (await git(['cat-file', '-e', spec])).exitCode === 0

  if (!(await has(`${manifest.wip}^{commit}`))) {
    return `影子提交 ${manifest.wip} 不在中枢裸仓里`
  }
  const wipTree = (
    await git(['rev-parse', '--verify', `${manifest.wip}^{tree}`])
  ).stdout
    .toString('utf8')
    .trim()
  if (wipTree !== manifest.tree) {
    return `影子提交的树 ${wipTree || '(读不出)'} 与清单里的工作区树 ${manifest.tree} 不一致`
  }
  if (!(await has(`${manifest.tree}^{tree}`))) {
    return `影子提交的树 ${manifest.tree} 不在中枢裸仓里`
  }
  if (!(await has(`${manifest.sessionCommit}^{commit}`))) {
    return `会话提交 ${manifest.sessionCommit} 不在中枢裸仓里`
  }
  const listing = await git(['ls-tree', '-z', manifest.sessionCommit])
  const entries = listing.stdout
    .toString('utf8')
    .split('\0')
    .filter(entry => entry !== '')
  const blob = /^100644 blob ([0-9a-f]{40,64})\t/.exec(entries[0] ?? '')?.[1]
  if (listing.exitCode !== 0 || entries.length !== 1 || blob === undefined) {
    return `会话提交 ${manifest.sessionCommit} 的树不是单个会话文件`
  }
  if (!(await has(blob))) {
    return `会话文件对象 ${blob} 不在中枢裸仓里`
  }
  return null
}

/** Why a task that is not running cannot be attached to, and what to do instead. */
function notRunning(task: HandoffTaskView): string {
  switch (task.state) {
    case 'accepted':
      return `任务 ${task.taskId} 还没有派给节点（accepted）· 没有会话可接 · 等它开始跑：qm handoff status --wait --task ${task.taskId}`
    case 'dispatched':
      return `任务 ${task.taskId} 已派给节点 ${task.node ?? '?'}（dispatched）· 节点还没接手 · 稍后再试`
    case 'done':
      return `任务 ${task.taskId} 在云端已经结束（done）· 用 qm handoff pull ${task.taskId} 接回本机`
    case 'failed':
      return `任务 ${task.taskId} 失败了（failed）· 节点上没有在跑的会话 · 原因：${task.reason ?? '没有写'}`
    case 'returned':
      return `任务 ${task.taskId} 已经接回本机（returned）· 节点上没有在跑的会话`
    default:
      return `任务 ${task.taskId} 是 ${task.state} · 不在云端运行`
  }
}

/** Why a task cannot be marked returned yet. */
function notFinished(task: HandoffTaskView): string {
  return `任务 ${task.taskId} 还在 ${task.state} · 云端没有结束 · 不能记为已接回`
}

function sameManifest(a: HandoffManifest, b: HandoffManifest): boolean {
  // Both went through `validateManifest`, which rebuilds the object in one
  // fixed key order, so the serialisations compare field for field.
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * The sentence for a console that could not take the ledger because another
 * process holds it — the lock file and the holder's pid, which is what the
 * operator acts on — or `null` for any other error.
 */
export function handoffLockRefusal(error: unknown): string | null {
  if (
    !(error instanceof HandoffLedgerError) ||
    error.code !== 'locked' ||
    !(error.cause instanceof LockHeldError)
  ) {
    return null
  }
  const { path, holder } = error.cause
  return (
    `控制台没有启动：接力台账正被另一个进程使用（锁文件 ${path}，` +
    `${holder === null ? '持锁进程还没写下 pid' : `持锁进程 pid ${holder}`}）。` +
    '同一个配置根上只能有一个控制台开着 --handoff-root：先停掉那个进程；' +
    '确认它已经不在运行而锁文件还在时，删掉锁文件再启动。'
  )
}

/**
 * Open the ledger (taking its lock) and the audit chain. Throws
 * `HandoffLedgerError` `locked` when another live process holds the ledger,
 * `corrupt` when it does not replay.
 */
export function openConsoleHandoff(
  options: ConsoleHandoffOptions,
): ConsoleHandoff {
  const now = options.now ?? Date.now
  const ledgerPath = options.ledgerPath ?? handoffLedgerPath()
  const auditPath = options.auditPath ?? handoffAuditPath()
  const onError =
    options.onError ??
    ((line: string) => {
      process.stderr.write(`${line}\n`)
    })
  const ledger = HandoffLedger.open(ledgerPath, { now })
  let trail: AuditTrail
  try {
    trail = new AuditTrail(auditPath)
    trail.ensure()
  } catch (error) {
    ledger.close()
    throw error
  }
  const newTaskId = (): string => {
    for (;;) {
      const id = options.newTaskId?.() ?? defaultTaskId(now())
      if (ledger.get(id) === undefined) return id
    }
  }
  /**
   * One line in the chain. A failed write is reported, not turned into a
   * refusal: the ledger line it records is already on disk.
   */
  const appendAudit = (record: AuditInput): void => {
    try {
      trail.append(record)
    } catch (error) {
      onError(
        `console handoff: audit append failed for ${record.taskId ?? '?'}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    }
  }
  const dispatchConfig = options.dispatch?.config
  const dispatcher: HandoffDispatcher | undefined =
    dispatchConfig === undefined
      ? undefined
      : createHandoffDispatcher({
          ...dispatchConfig,
          root: options.root,
          ledger,
          trail,
          now,
          log: onError,
        })

  const port: HandoffPort = {
    async accept(body): Promise<ConsoleResult<HandoffAcceptance>> {
      const checked = validateManifest(body)
      if (!checked.ok) {
        return failure(
          'invalid',
          `接力清单不合法：${checked.errors.join('；')}`,
        )
      }
      const manifest = checked.value
      let problem: string | null
      try {
        problem = await landingProblem(options.root, manifest)
      } catch (error) {
        return failure(
          'unreachable',
          `核对中枢裸仓失败：${error instanceof Error ? error.message : String(error)}`,
        )
      }
      if (problem !== null) return failure('rejected', problem)

      // No await between this lookup and the append below: two retries of
      // one request cannot both get past it.
      const same = ledger
        .list()
        .find(
          task =>
            task.state === 'accepted' && sameManifest(task.manifest, manifest),
        )
      if (same !== undefined)
        return { ok: true, value: { task: same, created: false } }

      let task: HandoffTaskView
      try {
        task = ledger.accept(newTaskId(), manifest)
      } catch (error) {
        return failure(
          'unreachable',
          `台账写不进去：${error instanceof Error ? error.message : String(error)}`,
        )
      }
      try {
        trail.append({
          at: now(),
          source: AuditSource.Handoff,
          kind: 'handoff.accepted',
          taskId: task.taskId,
          peer: manifest.device,
          outcome: 'ok',
          detail: {
            project: manifest.project,
            device: manifest.device,
            branch: manifest.branch,
            tool: manifest.tool,
            wip: manifest.wip,
            sessionCommit: manifest.sessionCommit,
          },
        })
      } catch (error) {
        // The task is accepted and on disk; a missing audit line is reported,
        // not turned into a refusal the laptop would read as "not landed".
        onError(
          `console handoff: audit append failed for ${task.taskId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        )
      }
      dispatcher?.kick()
      return { ok: true, value: { task, created: true } }
    },

    list(): Promise<ConsoleResult<readonly HandoffTaskView[]>> {
      return Promise.resolve({ ok: true, value: ledger.list() })
    },

    get(taskId): Promise<ConsoleResult<HandoffTaskView>> {
      const task = ledger.get(taskId)
      return Promise.resolve(
        task === undefined
          ? failure('not_found', `台账里没有任务 ${taskId}`)
          : { ok: true, value: task },
      )
    },

    send(taskId, text): Promise<ConsoleResult<HandoffSendView>> {
      try {
        const queued = ledger.queueSend(taskId, text)
        // Kept first, then forwarded: a running task hears it now, one that
        // is not running yet hears it once the node has taken the task.
        dispatcher?.forwardSends(taskId)
        return Promise.resolve({ ok: true, value: queued })
      } catch (error) {
        if (!(error instanceof HandoffLedgerError)) {
          return Promise.resolve(
            failure(
              'unreachable',
              `台账写不进去：${error instanceof Error ? error.message : String(error)}`,
            ),
          )
        }
        switch (error.code) {
          case 'unknown_task':
            return Promise.resolve(
              failure('not_found', `台账里没有任务 ${taskId}`),
            )
          case 'invalid_input':
            return Promise.resolve(failure('invalid', error.message))
          default:
            return Promise.resolve(
              failure(
                'rejected',
                `任务 ${taskId} 已是 ${ledger.get(taskId)?.state ?? '?'}，不再收话`,
              ),
            )
        }
      }
    },

    attach(taskId, request): Promise<ConsoleResult<HandoffAttachView>> {
      const task = ledger.get(taskId)
      if (task === undefined) {
        return Promise.resolve(failure('not_found', `台账里没有任务 ${taskId}`))
      }
      if (task.state !== 'running' || task.node === null) {
        return Promise.resolve(failure('rejected', notRunning(task)))
      }
      const threadId =
        task.result?.threadId ??
        (task.manifest.tool === 'qmcode' ? task.manifest.sessionId : null)
      appendAudit({
        at: now(),
        source: AuditSource.Handoff,
        kind: 'handoff.attach-requested',
        taskId,
        peer: request.device ?? task.manifest.device,
        outcome: 'ok',
        detail: {
          node: task.node,
          ...(threadId === null ? {} : { threadId }),
          ...(request.device === null ? {} : { device: request.device }),
        },
      })
      return Promise.resolve({
        ok: true,
        value: {
          taskId,
          state: task.state,
          node: task.node,
          threadId,
          project: task.manifest.project,
          tool: task.manifest.tool,
        },
      })
    },

    markReturned(taskId, request): Promise<ConsoleResult<HandoffReturnView>> {
      const task = ledger.get(taskId)
      if (task === undefined) {
        return Promise.resolve(failure('not_found', `台账里没有任务 ${taskId}`))
      }
      if (task.state === 'returned') {
        return Promise.resolve({ ok: true, value: { task, changed: false } })
      }
      if (task.state !== 'done' && task.state !== 'failed') {
        return Promise.resolve(failure('rejected', notFinished(task)))
      }
      let returned: HandoffTaskView
      try {
        returned = ledger.markReturned(taskId)
      } catch (error) {
        return Promise.resolve(
          failure(
            'unreachable',
            `台账写不进去：${error instanceof Error ? error.message : String(error)}`,
          ),
        )
      }
      appendAudit({
        at: now(),
        source: AuditSource.Handoff,
        kind: 'handoff.returned',
        taskId,
        peer: request.device ?? task.manifest.device,
        outcome: 'ok',
        detail: {
          from: task.state,
          ...(request.mode === null ? {} : { mode: request.mode }),
          ...(request.device === null ? {} : { device: request.device }),
        },
      })
      return Promise.resolve({
        ok: true,
        value: { task: returned, changed: true },
      })
    },
  }

  return {
    port,
    root: options.root,
    ledgerPath,
    auditPath,
    replayed: ledger.list().length,
    dispatchStatus: options.dispatch?.status ?? 'disabled (no --handoff-node)',
    start() {
      dispatcher?.start()
    },
    close() {
      // Stops the clock at once; links close on their own time, and anything
      // still in flight checks for a closed dispatcher before it writes.
      void dispatcher?.close()
      trail.close()
      ledger.close()
    },
  }
}
