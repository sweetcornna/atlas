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
 * Dispatch to a node, results and the rest of the audit kinds are P17.5/P17.6;
 * their kinds are registered in {@link HANDOFF_AUDIT_KINDS} now so the names
 * are settled before anything writes them.
 */

import { randomBytes } from 'node:crypto'
import { statSync } from 'node:fs'
import { join } from 'node:path'
import { AuditSource, AuditTrail } from '@qianmo/audit'
import type {
  ConsoleResult,
  HandoffAcceptance,
  HandoffPort,
  HandoffSendView,
  HandoffTaskView,
} from '@qianmo/console'
import {
  type HandoffManifest,
  HandoffLedger,
  HandoffLedgerError,
  runGit,
  validateManifest,
} from '@qianmo/handoff'
import { occConfigPath } from '../../config/paths.js'

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
}

interface ConsoleHandoff {
  readonly port: HandoffPort
  readonly root: string
  readonly ledgerPath: string
  readonly auditPath: string
  /** Tasks in the ledger when it was opened. */
  readonly replayed: number
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

function sameManifest(a: HandoffManifest, b: HandoffManifest): boolean {
  // Both went through `validateManifest`, which rebuilds the object in one
  // fixed key order, so the serialisations compare field for field.
  return JSON.stringify(a) === JSON.stringify(b)
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
        return Promise.resolve({
          ok: true,
          value: ledger.queueSend(taskId, text),
        })
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
  }

  return {
    port,
    root: options.root,
    ledgerPath,
    auditPath,
    replayed: ledger.list().length,
    close() {
      trail.close()
      ledger.close()
    },
  }
}
