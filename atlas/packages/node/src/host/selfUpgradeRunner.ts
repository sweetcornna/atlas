// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The upgrade job one qm process runs on itself (P31, `runtimes-channels.md`
 * §5.2), the same for the hub and for a node: stage the release while still
 * serving, drain, swap, restart in place. A node offers it on the control
 * link as `system.version`, `system.upgrade` and `system.rollback`; the job
 * runs after the answer, and `system.version` reports how it is going (the
 * link drops while the process restarts, so the hub polls).
 */

import { rmSync, statSync } from 'node:fs'
import type { ControlOutcome } from '@qianmo/protocol'
import { OutboundPolicy } from '../commands/outboundPolicy.js'
import { buildVersion, sourceCommit } from '../provenance.js'
import type { ControlHandler } from './control.js'
import { runCommand, type RunCommand } from './runtimeUpdate.js'
import {
  backupOf,
  compareVersions,
  installTree,
  type InstallTree,
  releaseByVersion,
  type ReleaseSource,
  restartInPlace,
  restoreBackup,
  rollbackReleases,
  stageRelease,
  swapIn,
  UpgradeError,
  withUpgradeLock,
} from './selfUpgrade.js'

export interface UpgradeStatus {
  readonly state: 'idle' | 'staging' | 'draining' | 'restarting' | 'failed'
  readonly target: string | null
  readonly detail: string | null
  readonly at: number
}

export interface SystemFacts {
  readonly version: string
  readonly commit: string
  readonly platform: string
  /** A compiled qm running from a deployment tree. */
  readonly upgradable: boolean
  /** The version on disk; differs from `version` once a swap happened. */
  readonly installed: string | null
  /** What a rollback to the local backup brings back. */
  readonly backup: string | null
  readonly upgrade: UpgradeStatus
}

export interface SelfUpgraderOptions {
  readonly tree?: InstallTree | null
  readonly version?: string
  /** Stop taking new work; `resume` undoes it when the upgrade is called off. */
  readonly drain?: () => void
  readonly resume?: () => void
  /** Nothing in flight any more. */
  readonly idle?: () => boolean
  readonly restart?: () => void
  readonly run?: RunCommand
  readonly now?: () => number
  readonly sleep?: (ms: number) => Promise<void>
  readonly log?: (line: string) => void
}

const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const DRAIN_DEFAULT_MS = 10 * 60_000
const DRAIN_MAX_MS = 60 * 60_000

interface Prepared {
  readonly swap: () => void
  readonly discard: () => void
}

function refused(message: string): ControlOutcome {
  return { ok: false, code: 'refused', message }
}

export class SelfUpgrader {
  readonly #options: SelfUpgraderOptions
  readonly #tree: InstallTree | null
  readonly #version: string
  readonly #inode: number | null
  #status: UpgradeStatus
  #job: Promise<void> | null = null

  constructor(options: SelfUpgraderOptions = {}) {
    this.#options = options
    this.#tree = options.tree === undefined ? installTree() : options.tree
    this.#version = options.version ?? buildVersion()
    this.#inode = this.#binInode()
    this.#status = {
      state: 'idle',
      target: null,
      detail: null,
      at: this.#now(),
    }
  }

  #now(): number {
    return (this.#options.now ?? Date.now)()
  }

  #binInode(): number | null {
    try {
      return this.#tree === null ? null : statSync(this.#tree.bin).ino
    } catch {
      return null
    }
  }

  #set(
    state: UpgradeStatus['state'],
    target: string | null,
    detail: string | null,
  ): void {
    this.#status = { state, target, detail, at: this.#now() }
  }

  get version(): string {
    return this.#version
  }

  get upgradable(): boolean {
    return this.#tree !== null
  }

  status(): UpgradeStatus {
    return this.#status
  }

  /** Settles when the job in progress, if any, has stopped (tests). */
  async settled(): Promise<void> {
    await this.#job
  }

  /** The version on disk: the running one, unless the binary has been replaced. */
  async installed(): Promise<string | null> {
    if (this.#tree === null) return null
    const inode = this.#binInode()
    if (inode === null) return null
    if (inode === this.#inode) return this.#version
    const run = this.#options.run ?? runCommand
    const out = await run([this.#tree.bin, '--version'], {
      env: {
        PATH: process.env['PATH'] ?? '/usr/bin:/bin',
        HOME: this.#tree.tree,
        LC_ALL: 'C',
      },
      timeoutMs: 60_000,
    }).catch(() => null)
    return out?.code === 0
      ? (/^qm (\S+)/.exec(out.stdout.trim())?.[1] ?? null)
      : null
  }

  async facts(): Promise<SystemFacts> {
    return {
      version: this.#version,
      commit: sourceCommit(),
      platform: this.#tree?.platform ?? `${process.platform}-${process.arch}`,
      upgradable: this.#tree !== null,
      installed: await this.installed(),
      backup:
        this.#tree === null ? null : (backupOf(this.#tree)?.version ?? null),
      upgrade: this.#status,
    }
  }

  /** Upgrade (or go back) to `version` of `source`'s releases. Answers at once. */
  async upgrade(
    source: ReleaseSource,
    version: string,
    drainMs?: number,
  ): Promise<ControlOutcome> {
    if (!VERSION.test(version))
      return {
        ok: false,
        code: 'invalid',
        message: '需要确切的版本号（x.y.z）',
      }
    const installed = await this.installed()
    if (version === this.#version && installed === version)
      return { ok: true, value: { already: true, version } }
    const current = this.#version
    return this.#start(
      version,
      async tree => {
        // A sibling process on the same tree may have swapped it in already.
        if ((await this.installed()) === version) return null
        const newer = compareVersions(version, current) > 0
        if (
          !newer &&
          !(await rollbackReleases(source, current)).some(
            one => one.version === version,
          )
        )
          throw new UpgradeError(
            '只能升到更新的版本，或回到最近三个更旧的发行之一',
          )
        const release = await releaseByVersion(source, version)
        const staged = await stageRelease({
          source,
          tree,
          release,
          ...(this.#options.run === undefined
            ? {}
            : { run: this.#options.run }),
        })
        return {
          swap: () => swapIn(tree, staged, installed ?? current, this.#now()),
          discard: () => rmSync(staged.dir, { recursive: true, force: true }),
        }
      },
      drainMs,
    )
  }

  /** Go back to the local backup the last swap left. Answers at once. */
  rollback(drainMs?: number): ControlOutcome {
    if (this.#tree === null)
      return refused('源码运行或不在部署树里的进程不能在线回滚')
    const backup = backupOf(this.#tree)
    if (backup === null) return refused('没有可回滚的备份')
    return this.#start(
      backup.version,
      async tree => ({
        swap: () => void restoreBackup(tree, this.#now()),
        discard: () => {},
      }),
      drainMs,
    )
  }

  #start(
    target: string | null,
    prepare: (tree: InstallTree) => Promise<Prepared | null>,
    drainMs = DRAIN_DEFAULT_MS,
  ): ControlOutcome {
    const tree = this.#tree
    if (tree === null)
      return refused('源码运行或不在部署树里的进程不能在线升级')
    if (this.#job !== null) return refused('已有升级或回滚在进行')
    const budget = Math.min(Math.max(drainMs, 0), DRAIN_MAX_MS)
    this.#set('staging', target, null)
    this.#job = (async () => {
      let drained = false
      try {
        await withUpgradeLock(tree, async () => {
          const prepared = await prepare(tree)
          try {
            this.#set('draining', target, null)
            this.#options.drain?.()
            drained = true
            const deadline = this.#now() + budget
            while (!(this.#options.idle?.() ?? true)) {
              if (this.#now() >= deadline)
                throw new UpgradeError(
                  `在途工作 ${Math.round(budget / 60_000)} 分钟内没有做完，已取消升级，原程序照常运行`,
                )
              await (this.#options.sleep ?? Bun.sleep)(1_000)
            }
            prepared?.swap()
          } catch (error) {
            prepared?.discard()
            throw error
          }
        })
        this.#set('restarting', target, null)
        this.#options.log?.(
          `[upgrade] ${this.#version} -> ${target ?? 'backup'}; restarting in place`,
        )
        // Like sub2api: let the answer and the status poll get out first.
        setTimeout(() => {
          if (this.#options.restart) this.#options.restart()
          else
            restartInPlace(
              this.#options.log === undefined ? {} : { log: this.#options.log },
            )
        }, 500)
      } catch (error) {
        if (drained) this.#options.resume?.()
        this.#set(
          'failed',
          target,
          error instanceof UpgradeError
            ? error.message
            : '升级失败；原程序照常运行',
        )
        this.#options.log?.(`[upgrade] failed: ${this.#status.detail}`)
      } finally {
        this.#job = null
      }
    })()
    return { ok: true, value: { accepted: true, target } }
  }
}

/** `system.version` / `system.upgrade` / `system.rollback` on a node's control link. */
export function systemControl(
  upgrader: SelfUpgrader,
  policy: OutboundPolicy = new OutboundPolicy(),
): ControlHandler {
  return async (op, args) => {
    if (op === 'system.version')
      return { ok: true, value: await upgrader.facts() }
    const drainMs =
      typeof args['drainMs'] === 'number' && Number.isFinite(args['drainMs'])
        ? args['drainMs']
        : undefined
    if (op === 'system.upgrade') {
      const repo = args['repo']
      const version = args['version']
      if (typeof repo !== 'string' || typeof version !== 'string')
        return { ok: false, code: 'invalid', message: '需要 repo 与 version' }
      return upgrader.upgrade({ policy, repo }, version, drainMs)
    }
    if (op === 'system.rollback') return upgrader.rollback(drainMs)
    return { ok: false, code: 'unsupported', message: '不支持此系统操作' }
  }
}
