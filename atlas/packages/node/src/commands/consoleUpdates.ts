// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Update checks on the hub (P31, `docs/dev/runtimes-channels.md` §5).
 *
 * At the times ops set, the hub asks four sources whether something newer
 * exists — qianmopi's upstream releases, npm's Claude Code and Codex, and
 * qianmo's own releases — records one row per source, pushes new versions
 * to the chosen notification channels, and, for a source set to automatic:
 *
 * - qianmopi: dispatches the repository's `sync-omp.yml` (a draft PR that
 *   still needs review; nothing merges here);
 * - Claude Code / Codex: asks each node to install that exact version
 *   (`runtime.update`);
 * - qianmo: upgrades the nodes one at a time and then the hub itself, the
 *   way sub2api upgrades in place (§5.2, `host/selfUpgrade.ts`).
 *
 * The same rolling job runs on demand from the page, and so does a rollback.
 */

import * as path from 'node:path'
import { z } from 'zod'
import {
  type ConsoleResult,
  type DirectionActor,
  UPDATE_SOURCES,
  type UpdateAction,
  type UpdateNodeVersion,
  type UpdateRunView,
  type UpdateSourceId,
  type UpdateSourceView,
  type UpdatesDraft,
  type UpdatesPort,
  type UpdatesSnapshot,
  type UpdateTime,
  type UpgradeJobView,
} from '@qianmo/console'
import type { ControlOutcome } from '@qianmo/protocol'
import { RUNTIME_PACKAGES } from '../host/runtimeUpdate.js'
import {
  compareVersions,
  latestRelease,
  type ReleaseSource,
  rollbackReleases,
} from '../host/selfUpgrade.js'
import type { SelfUpgrader, SystemFacts } from '../host/selfUpgradeRunner.js'
import { ompVersion } from '../provenance.js'
import {
  acquirePrivateInstanceLock,
  ensurePrivateDir,
  type PrivateInstanceLock,
  readTextIfExists,
  writePrivateJson,
} from '../providers/store.js'
import { boundedText, type OutboundPolicy } from './outboundPolicy.js'
import { nextRunAt, validateScheduleWhen } from './scheduleTime.js'

const UPSTREAM_REPO = 'can1357/oh-my-pi'
const HISTORY = 100
const HUB = 'hub'
const NAMES: Readonly<Record<UpdateSourceId, string>> = {
  qianmopi: 'qianmopi 上游',
  'claude-code': 'Claude Code',
  codex: 'Codex',
  qianmo: '阡陌',
}
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
/** How long one node may take to come back on the new version. */
const NODE_UPGRADE_MS = 30 * 60_000

const timeSchema = z.union([
  z.object({ kind: z.literal('daily'), time: z.string() }),
  z.object({
    kind: z.literal('weekly'),
    days: z.array(z.number().int()),
    time: z.string(),
  }),
])

const sourceSchema = z.object({
  current: z.string().nullable(),
  latest: z.string().nullable(),
  nodes: z.array(
    z.object({
      node: z.string(),
      version: z.string().nullable(),
      managed: z.boolean(),
      pinned: z.boolean(),
    }),
  ),
  checkedAt: z.number().nullable(),
  error: z.string().nullable(),
})

const runSchema = z.object({
  at: z.number(),
  source: z.enum(UPDATE_SOURCES),
  current: z.string().nullable(),
  latest: z.string().nullable(),
  outcome: z.enum([
    'current',
    'available',
    'dispatched',
    'installed',
    'failed',
  ]),
  detail: z.string().nullable(),
  trigger: z.enum(['schedule', 'manual']),
})

const jobSchema = z.object({
  kind: z.enum(['upgrade', 'rollback']),
  target: z.string().nullable(),
  state: z.enum(['running', 'done', 'failed']),
  steps: z.array(
    z.object({
      node: z.string(),
      state: z.enum(['pending', 'upgrading', 'done', 'skipped', 'failed']),
      detail: z.string().nullable(),
    }),
  ),
  startedAt: z.number(),
  finishedAt: z.number().nullable(),
  trigger: z.enum(['schedule', 'manual']),
})

const bookSchema = z.object({
  v: z.literal(1),
  times: z.array(timeSchema).default([]),
  timezone: z.string().default('Asia/Shanghai'),
  actions: z.record(z.string(), z.enum(['notify', 'auto'])).default({}),
  channels: z.array(z.string()).default([]),
  repo: z.string().nullable().default(null),
  sources: z.record(z.string(), sourceSchema).default({}),
  history: z.array(runSchema).default([]),
  nextAt: z.number().nullable().default(null),
  /** The latest version each source has already been notified or automated for. */
  handled: z.record(z.string(), z.string()).default({}),
  rollbackVersions: z.array(z.string()).default([]),
  upgrade: jobSchema.nullable().default(null),
})
type Book = z.infer<typeof bookSchema>
type SourceState = z.infer<typeof sourceSchema>

export interface UpdatesControl {
  request(
    node: string,
    op: string,
    args: Record<string, unknown>,
    actor: string,
    options?: { readonly timeoutMs?: number },
  ): Promise<ControlOutcome>
}

export interface UpdatesNotify {
  platformChannels(): readonly { id: string; name: string }[]
  pushPlatform(
    ids: readonly string[],
    title: string,
    body: string,
  ): Promise<
    readonly { channelId: string; ok: boolean; error: string | null }[]
  >
}

export interface ConsoleUpdatesOptions {
  readonly directory: string
  readonly policy: OutboundPolicy
  /** The nodes on the control link. */
  readonly nodes: () => readonly string[]
  readonly control?: UpdatesControl
  /** The token of the repo connection for `repo`, if there is one. */
  readonly repoToken?: (repo: string) => Promise<string | null>
  readonly notify?: UpdatesNotify
  /** The hub's own upgrade job. */
  readonly self: SelfUpgrader
  readonly now?: () => number
  readonly sleep?: (ms: number) => Promise<void>
  readonly onError?: (message: string) => void
}

function ok<T>(value: T): ConsoleResult<T> {
  return { ok: true, value }
}

function fail<T>(
  code: 'invalid' | 'refused' | 'unreachable',
  message: string,
): ConsoleResult<T> {
  return { ok: false, failure: { code, message } }
}

function emptySource(): SourceState {
  return {
    current: null,
    latest: null,
    nodes: [],
    checkedAt: null,
    error: null,
  }
}

/** A line of text without anything that could be a secret or remote markup. */
function detailOf(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 200) : '检查失败'
}

export class ConsoleUpdates implements UpdatesPort {
  readonly #options: ConsoleUpdatesOptions
  readonly #now: () => number
  readonly #path: string
  readonly #lock: PrivateInstanceLock | null
  #book: Book
  #running: Promise<void> | null = null
  #job: Promise<void> | null = null
  #timer: ReturnType<typeof setTimeout> | null = null
  #closed = false

  constructor(options: ConsoleUpdatesOptions) {
    this.#options = options
    this.#now = options.now ?? Date.now
    ensurePrivateDir(options.directory)
    this.#path = path.join(options.directory, 'updates.json')
    this.#lock = acquirePrivateInstanceLock(
      path.join(options.directory, 'instance.lock'),
    )
    if (!this.#lock)
      options.onError?.('更新检查目录已由另一实例持有；本实例不定时检查')
    const raw = readTextIfExists(this.#path)
    this.#book =
      raw === undefined
        ? bookSchema.parse({ v: 1 })
        : bookSchema.parse(JSON.parse(raw))
  }

  // -- lifecycle ------------------------------------------------------------------

  start(): void {
    if (!this.#lock?.owned()) return
    this.#finishHubStep()
    // A check missed while the hub was down runs once now.
    const due = this.#book.nextAt !== null && this.#book.nextAt <= this.#now()
    if (due) void this.#check('schedule')
    else this.#arm()
  }

  async close(): Promise<void> {
    this.#closed = true
    if (this.#timer !== null) clearTimeout(this.#timer)
    await Promise.allSettled([this.#running, this.#job])
    this.#lock?.release()
  }

  /** After the hub restarted into a new version, close its step of the job. */
  #finishHubStep(): void {
    const job = this.#book.upgrade
    const step = job?.steps.find(one => one.node === HUB)
    if (job == null || job.state !== 'running' || step?.state !== 'upgrading')
      return
    const reached =
      job.target === null || job.target === this.#options.self.version
    this.#setJob({
      ...job,
      state: reached ? 'done' : 'failed',
      finishedAt: this.#now(),
      steps: job.steps.map(one =>
        one.node === HUB
          ? {
              ...one,
              state: reached ? 'done' : 'failed',
              detail: reached
                ? null
                : `重启后仍是 ${this.#options.self.version}`,
            }
          : one,
      ),
    })
    void this.#announceJob()
  }

  #save(): void {
    if (!this.#lock?.owned()) return
    try {
      writePrivateJson(this.#path, this.#book)
    } catch {
      this.#options.onError?.('更新检查记录写入失败')
    }
  }

  #arm(): void {
    if (this.#timer !== null) clearTimeout(this.#timer)
    this.#timer = null
    if (this.#closed || !this.#lock?.owned()) return
    const now = this.#now()
    let next: number | null = null
    for (const when of this.#book.times) {
      const at = nextRunAt(when, this.#book.timezone, now)
      if (at !== null && (next === null || at < next)) next = at
    }
    this.#book = { ...this.#book, nextAt: next }
    this.#save()
    if (next === null) return
    // Re-armed at least hourly, so a changed clock or a long sleep catches up.
    this.#timer = setTimeout(
      () => {
        this.#timer = null
        if (this.#book.nextAt !== null && this.#book.nextAt <= this.#now())
          void this.#check('schedule')
        else this.#arm()
      },
      Math.min(Math.max(next - now, 1_000), 3_600_000),
    )
    this.#timer.unref?.()
  }

  // -- the port ---------------------------------------------------------------------

  #view(): UpdatesSnapshot {
    const book = this.#book
    const self = this.#options.self
    return {
      times: book.times as UpdateTime[],
      timezone: book.timezone,
      channels: book.channels,
      repo: book.repo,
      sources: UPDATE_SOURCES.map(
        (id): UpdateSourceView => ({
          id,
          name: NAMES[id],
          ...(book.sources[id] ?? emptySource()),
          action: book.actions[id] ?? 'notify',
          autoAvailable: true,
        }),
      ),
      history: book.history,
      nextAt: book.nextAt,
      running: this.#running !== null,
      channelChoices: this.#options.notify?.platformChannels() ?? [],
      hub: { version: self.version, upgradable: self.upgradable, backup: null },
      rollbackVersions: book.rollbackVersions,
      upgrade: book.upgrade,
    }
  }

  async snapshot(): Promise<ConsoleResult<UpdatesSnapshot>> {
    const view = this.#view()
    const facts = await this.#options.self.facts().catch(() => null)
    return ok({ ...view, hub: { ...view.hub, backup: facts?.backup ?? null } })
  }

  async save(
    draft: UpdatesDraft,
    _actor: DirectionActor,
  ): Promise<ConsoleResult<UpdatesSnapshot>> {
    if (draft === null || typeof draft !== 'object')
      return fail('invalid', '设定无效')
    const times = Array.isArray(draft.times) ? draft.times : []
    if (times.length > 12) return fail('invalid', '检查时间最多 12 条')
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: draft.timezone })
      for (const when of times) {
        if (when?.kind !== 'daily' && when?.kind !== 'weekly')
          throw new RangeError('只能每天或每周')
        validateScheduleWhen(when, draft.timezone)
      }
    } catch (error) {
      return fail(
        'invalid',
        error instanceof RangeError ? error.message : '时区或时间无效',
      )
    }
    const repo =
      draft.repo === null || draft.repo === undefined || draft.repo === ''
        ? null
        : String(draft.repo).trim()
    if (repo !== null && !REPO.test(repo))
      return fail('invalid', '仓库写成 owner/name')
    const choices = new Set(
      (this.#options.notify?.platformChannels() ?? []).map(one => one.id),
    )
    const channels = Array.isArray(draft.channels)
      ? [...new Set(draft.channels)]
      : []
    if (channels.some(id => !choices.has(id)))
      return fail('invalid', '通知渠道不存在')
    const actions: Record<string, UpdateAction> = { ...this.#book.actions }
    for (const id of UPDATE_SOURCES) {
      const action = draft.actions?.[id]
      if (action === 'notify' || action === 'auto') actions[id] = action
      else if (action !== undefined)
        return fail('invalid', '动作只能是只通知或自动处理')
    }
    this.#book = {
      ...this.#book,
      times: times.map(one =>
        one.kind === 'daily'
          ? { kind: 'daily' as const, time: one.time }
          : {
              kind: 'weekly' as const,
              days: [...one.days].sort((a, b) => a - b),
              time: one.time,
            },
      ),
      timezone: draft.timezone,
      actions,
      channels,
      repo,
    }
    this.#save()
    this.#arm()
    return this.snapshot()
  }

  async run(_actor: DirectionActor): Promise<ConsoleResult<UpdatesSnapshot>> {
    if (!this.#lock?.owned())
      return fail('refused', '另一个控制台实例持有更新检查')
    if (this.#running === null) void this.#check('manual')
    return this.snapshot()
  }

  async upgrade(
    input: { readonly version?: string },
    _actor: DirectionActor,
  ): Promise<ConsoleResult<UpdatesSnapshot>> {
    const source = await this.#qianmoSource()
    if (source === null) return fail('invalid', '先在设定里填阡陌仓库')
    let target = input.version
    if (target === undefined) {
      try {
        target = (await latestRelease(source)).version
      } catch (error) {
        return fail('unreachable', detailOf(error))
      }
    }
    if (!VERSION.test(target)) return fail('invalid', '版本号写成 x.y.z')
    return this.#startJob('upgrade', target, 'manual')
  }

  async rollback(
    input: { readonly version?: string },
    _actor: DirectionActor,
  ): Promise<ConsoleResult<UpdatesSnapshot>> {
    if (
      input.version !== undefined &&
      !this.#book.rollbackVersions.includes(input.version)
    )
      return fail('invalid', '只能回到最近三个更旧的发行之一；先检查一次更新')
    return this.#startJob('rollback', input.version ?? null, 'manual')
  }

  // -- checking -----------------------------------------------------------------------

  async #qianmoSource(): Promise<ReleaseSource | null> {
    const repo = this.#book.repo
    if (repo === null) return null
    const token = await this.#options.repoToken?.(repo).catch(() => null)
    return { policy: this.#options.policy, repo, ...(token ? { token } : {}) }
  }

  #check(trigger: 'schedule' | 'manual'): Promise<void> {
    if (this.#running !== null) return this.#running
    this.#running = (async () => {
      try {
        for (const id of UPDATE_SOURCES) {
          if (this.#closed) return
          await this.#checkOne(id, trigger)
        }
      } catch (error) {
        this.#options.onError?.(`更新检查失败：${detailOf(error)}`)
      } finally {
        this.#running = null
        this.#arm()
      }
    })()
    return this.#running
  }

  async #npmLatest(id: 'claude-code' | 'codex'): Promise<string> {
    const response = await this.#options.policy.request(
      `https://registry.npmjs.org/${RUNTIME_PACKAGES[id]}/latest`,
      {
        headers: {
          Accept: 'application/json',
          'User-Agent': 'qianmo-agentnest',
        },
      },
      false,
    )
    if (!response.ok) {
      await response.body?.cancel()
      throw new Error(`npm 查询失败（HTTP ${response.status}）`)
    }
    const version = (
      JSON.parse(await boundedText(response, 2 * 1024 * 1024)) as {
        version?: unknown
      }
    ).version
    if (typeof version !== 'string' || !VERSION.test(version))
      throw new Error('npm 返回的版本无效')
    return version
  }

  async #nodeFacts<T>(
    op: string,
    pick: (value: unknown) => T,
  ): Promise<{ node: string; value: T | null }[]> {
    const control = this.#options.control
    if (control === undefined) return []
    return Promise.all(
      this.#options.nodes().map(async node => {
        const outcome = await control
          .request(node, op, {}, 'updates', { timeoutMs: 60_000 })
          .catch(() => null)
        return { node, value: outcome?.ok ? pick(outcome.value) : null }
      }),
    )
  }

  async #observe(id: UpdateSourceId): Promise<SourceState> {
    const at = this.#now()
    if (id === 'qianmopi') {
      const latest = (
        await latestRelease({
          policy: this.#options.policy,
          repo: UPSTREAM_REPO,
        })
      ).version
      return {
        current: ompVersion(),
        latest,
        nodes: [],
        checkedAt: at,
        error: null,
      }
    }
    if (id === 'claude-code' || id === 'codex') {
      const latest = await this.#npmLatest(id)
      const nodes = await this.#nodeFacts('runtime.versions', value => {
        const row = (
          value as Record<
            string,
            { version?: unknown; managed?: unknown; pinned?: unknown }
          >
        )?.[id]
        return {
          version: typeof row?.version === 'string' ? row.version : null,
          managed: row?.managed === true,
          pinned: row?.pinned === true,
        }
      })
      return {
        current: null,
        latest,
        nodes: nodes.map(
          (one): UpdateNodeVersion =>
            one.value === null
              ? { node: one.node, version: null, managed: false, pinned: false }
              : { node: one.node, ...one.value },
        ),
        checkedAt: at,
        error: null,
      }
    }
    const source = await this.#qianmoSource()
    if (source === null) throw new Error('未设阡陌仓库')
    const self = this.#options.self
    const [latest, older] = await Promise.all([
      latestRelease(source),
      rollbackReleases(source, self.version).catch(() => []),
    ])
    this.#book = {
      ...this.#book,
      rollbackVersions: older.map(one => one.version),
    }
    const nodes = await this.#nodeFacts(
      'system.version',
      value => value as SystemFacts,
    )
    return {
      current: self.version,
      latest: latest.version,
      nodes: nodes.map(one => ({
        node: one.node,
        version: one.value?.version ?? null,
        managed: one.value?.upgradable === true,
        pinned: false,
      })),
      checkedAt: at,
      error: null,
    }
  }

  #behind(id: UpdateSourceId, state: SourceState): boolean {
    if (state.latest === null) return false
    const latest = state.latest
    if (id === 'claude-code' || id === 'codex')
      return state.nodes.some(
        one =>
          !one.pinned &&
          one.version !== null &&
          compareVersions(one.version, latest) < 0,
      )
    const versions = [
      state.current,
      ...state.nodes.map(one => one.version),
    ].filter((one): one is string => one !== null)
    return versions.some(one => compareVersions(one, latest) < 0)
  }

  #record(row: Omit<UpdateRunView, 'at'>): void {
    this.#book = {
      ...this.#book,
      history: [{ at: this.#now(), ...row }, ...this.#book.history].slice(
        0,
        HISTORY,
      ),
    }
    this.#save()
  }

  async #push(title: string, body: string): Promise<string> {
    const ids = this.#book.channels
    const notify = this.#options.notify
    if (ids.length === 0 || notify === undefined) return '未设通知渠道'
    const pushed = await notify.pushPlatform(ids, title, body).catch(() => [])
    const good = pushed.filter(one => one.ok).length
    return good === ids.length
      ? `已推送 ${good} 个通知渠道`
      : `推送 ${good}/${ids.length} 个通知渠道成功`
  }

  async #checkOne(
    id: UpdateSourceId,
    trigger: 'schedule' | 'manual',
  ): Promise<void> {
    let state: SourceState
    try {
      state = await this.#observe(id)
    } catch (error) {
      const previous = this.#book.sources[id] ?? emptySource()
      state = { ...previous, checkedAt: this.#now(), error: detailOf(error) }
      this.#book = {
        ...this.#book,
        sources: { ...this.#book.sources, [id]: state },
      }
      this.#record({
        source: id,
        current: previous.current,
        latest: previous.latest,
        outcome: 'failed',
        detail: state.error,
        trigger,
      })
      return
    }
    this.#book = {
      ...this.#book,
      sources: { ...this.#book.sources, [id]: state },
    }
    const latest = state.latest!
    if (!this.#behind(id, state)) {
      this.#record({
        source: id,
        current: state.current,
        latest,
        outcome: 'current',
        detail: null,
        trigger,
      })
      return
    }
    const fresh = this.#book.handled[id] !== latest
    const auto = (this.#book.actions[id] ?? 'notify') === 'auto'
    let outcome: UpdateRunView['outcome'] = 'available'
    let detail = fresh ? '' : '这个版本已处理过'
    if (fresh && auto) {
      const done = await this.#automate(id, latest, state, trigger)
      outcome = done.outcome
      detail = done.detail
    }
    if (fresh) {
      const pushed = await this.#push(
        `${NAMES[id]} 有新版本 ${latest}`,
        `当前 ${state.current ?? state.nodes.map(one => `${one.node} ${one.version ?? '未知'}`).join('、')}${detail ? `；${detail}` : ''}`,
      )
      detail = detail ? `${detail}；${pushed}` : pushed
      this.#book = {
        ...this.#book,
        handled: { ...this.#book.handled, [id]: latest },
      }
    }
    this.#record({
      source: id,
      current: state.current,
      latest,
      outcome,
      detail,
      trigger,
    })
  }

  async #automate(
    id: UpdateSourceId,
    latest: string,
    state: SourceState,
    trigger: 'schedule' | 'manual',
  ): Promise<{ outcome: UpdateRunView['outcome']; detail: string }> {
    if (id === 'qianmopi') {
      const source = await this.#qianmoSource()
      if (source?.token == null)
        return {
          outcome: 'failed',
          detail: '触发同步需要阡陌仓库的连接令牌（actions:write）',
        }
      try {
        const response = await this.#options.policy.request(
          `https://api.github.com/repos/${source.repo}/actions/workflows/sync-omp.yml/dispatches`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${source.token}`,
              Accept: 'application/vnd.github+json',
              'Content-Type': 'application/json',
              'User-Agent': 'qianmo-agentnest',
            },
            body: JSON.stringify({ ref: 'main' }),
          },
          false,
        )
        await response.body?.cancel()
        return response.status === 204
          ? {
              outcome: 'dispatched',
              detail: '已触发上游同步工作流；同步 PR 要评审后合并',
            }
          : {
              outcome: 'failed',
              detail: `触发同步失败（HTTP ${response.status}）`,
            }
      } catch (error) {
        return { outcome: 'failed', detail: detailOf(error) }
      }
    }
    if (id === 'claude-code' || id === 'codex') {
      const control = this.#options.control
      const due = state.nodes.filter(
        one => !one.pinned && one.version !== latest,
      )
      if (control === undefined || due.length === 0)
        return { outcome: 'available', detail: '没有可升级的节点' }
      const results: string[] = []
      let failed = 0
      for (const node of due) {
        const outcome = await control
          .request(
            node.node,
            'runtime.update',
            { runtime: id, version: latest },
            'updates',
            // The node's own steps take up to 11 minutes (staged install 6,
            // check 1.5, install 3, two version reads): a margin on top.
            { timeoutMs: 13 * 60_000 },
          )
          .catch(() => null)
        if (outcome?.ok) results.push(`${node.node} 已装 ${latest}`)
        else {
          failed++
          results.push(
            `${node.node} 失败${outcome && !outcome.ok ? `：${outcome.message}` : ''}`,
          )
        }
      }
      return {
        outcome: failed === 0 ? 'installed' : 'failed',
        detail: results.join('；'),
      }
    }
    const started = await this.#startJob('upgrade', latest, trigger)
    return started.ok
      ? { outcome: 'available', detail: `已开始逐台升级到 ${latest}` }
      : { outcome: 'failed', detail: started.failure.message }
  }

  // -- the rolling upgrade ----------------------------------------------------------------

  #setJob(job: UpgradeJobView): void {
    this.#book = {
      ...this.#book,
      upgrade: { ...job, steps: job.steps.map(one => ({ ...one })) },
    }
    this.#save()
  }

  #step(
    node: string,
    state: UpgradeJobView['steps'][number]['state'],
    detail: string | null,
  ): void {
    const job = this.#book.upgrade
    if (job === null) return
    this.#setJob({
      ...job,
      steps: job.steps.map(one =>
        one.node === node ? { node, state, detail } : one,
      ),
    })
  }

  async #startJob(
    kind: 'upgrade' | 'rollback',
    target: string | null,
    trigger: 'schedule' | 'manual',
  ): Promise<ConsoleResult<UpdatesSnapshot>> {
    if (!this.#lock?.owned())
      return fail('refused', '另一个控制台实例持有更新检查')
    if (this.#job !== null || this.#book.upgrade?.state === 'running')
      return fail('refused', '已有升级或回滚在进行')
    const source = await this.#qianmoSource()
    if (source === null && (kind === 'upgrade' || target !== null))
      return fail('invalid', '先在设定里填阡陌仓库')
    const nodes = this.#options.nodes()
    this.#setJob({
      kind,
      target,
      state: 'running',
      steps: [...nodes, HUB].map(node => ({
        node,
        state: 'pending' as const,
        detail: null,
      })),
      startedAt: this.#now(),
      finishedAt: null,
      trigger,
    })
    this.#job = this.#runJob(kind, target, source, nodes).finally(() => {
      this.#job = null
    })
    return this.snapshot()
  }

  async #runJob(
    kind: 'upgrade' | 'rollback',
    target: string | null,
    source: ReleaseSource | null,
    nodes: readonly string[],
  ): Promise<void> {
    const control = this.#options.control
    const sleep = this.#options.sleep ?? Bun.sleep
    const finish = (state: 'done' | 'failed'): void => {
      const job = this.#book.upgrade
      if (job !== null) this.#setJob({ ...job, state, finishedAt: this.#now() })
      void this.#announceJob()
    }
    for (const node of nodes) {
      if (this.#closed) return
      if (control === undefined) {
        this.#step(node, 'skipped', '没有控制链路')
        continue
      }
      const facts = await control
        .request(node, 'system.version', {}, 'updates', { timeoutMs: 60_000 })
        .catch(() => null)
      if (!facts?.ok) {
        this.#step(node, 'failed', '节点不可达')
        return finish('failed')
      }
      const before = facts.value as SystemFacts
      const want = target ?? (kind === 'rollback' ? before.backup : null)
      if (want !== null && before.version === want) {
        this.#step(node, 'skipped', `已是 ${want}`)
        continue
      }
      if (!before.upgradable) {
        this.#step(node, 'skipped', '源码运行，不能在线升级')
        continue
      }
      this.#step(node, 'upgrading', null)
      const asked =
        kind === 'rollback' && target === null
          ? await control
              .request(node, 'system.rollback', {}, 'updates', {
                timeoutMs: 60_000,
              })
              .catch(() => null)
          : await control
              .request(
                node,
                'system.upgrade',
                { repo: source!.repo, version: target },
                'updates',
                { timeoutMs: 60_000 },
              )
              .catch(() => null)
      if (!asked?.ok) {
        this.#step(
          node,
          'failed',
          asked && !asked.ok ? asked.message : '请求没有送到',
        )
        return finish('failed')
      }
      if ((asked.value as { already?: unknown }).already === true) {
        this.#step(node, 'skipped', `已是 ${target}`)
        continue
      }
      // The link drops while the node restarts; keep asking until it answers.
      const deadline = this.#now() + NODE_UPGRADE_MS
      let result: { state: 'done' | 'failed'; detail: string | null } | null =
        null
      while (result === null && !this.#closed) {
        await sleep(5_000)
        const now = await control
          .request(node, 'system.version', {}, 'updates', { timeoutMs: 30_000 })
          .catch(() => null)
        if (now?.ok) {
          const value = now.value as SystemFacts
          if (
            want !== null
              ? value.version === want
              : value.version !== before.version
          )
            result = {
              state: 'done',
              detail: `${before.version} → ${value.version}`,
            }
          else if (value.upgrade.state === 'failed')
            result = { state: 'failed', detail: value.upgrade.detail }
        }
        if (result === null && this.#now() >= deadline)
          result = { state: 'failed', detail: '30 分钟内没有回到新版本' }
      }
      if (result === null) return
      this.#step(node, result.state, result.detail)
      if (result.state === 'failed') return finish('failed')
    }
    // The hub goes last: it is the one running this job.
    const self = this.#options.self
    if (!self.upgradable) {
      this.#step(HUB, 'skipped', '源码运行，不能在线升级')
      return finish('done')
    }
    if (target !== null && self.version === target) {
      this.#step(HUB, 'skipped', `已是 ${target}`)
      return finish('done')
    }
    this.#step(HUB, 'upgrading', null)
    const asked =
      kind === 'rollback' && target === null
        ? self.rollback()
        : await self.upgrade(source!, target!)
    if (!asked.ok) {
      this.#step(HUB, 'failed', asked.message)
      return finish('failed')
    }
    if ((asked.value as { already?: unknown }).already === true) {
      this.#step(HUB, 'skipped', `已是 ${target}`)
      return finish('done')
    }
    await self.settled()
    const status = self.status()
    if (status.state === 'failed') {
      this.#step(HUB, 'failed', status.detail)
      return finish('failed')
    }
    // Restarting now; the next start closes this step (#finishHubStep).
  }

  async #announceJob(): Promise<void> {
    const job = this.#book.upgrade
    if (job === null || job.state === 'running') return
    const what = job.kind === 'upgrade' ? '升级' : '回滚'
    const lines = job.steps.map(
      one =>
        `${one.node === HUB ? '中枢' : one.node}：${STEP_WORD[one.state]}${one.detail ? `（${one.detail}）` : ''}`,
    )
    const pushed = await this.#push(
      `阡陌${what}${job.state === 'done' ? '完成' : '失败'}`,
      lines.join('\n'),
    )
    this.#record({
      source: 'qianmo',
      current: null,
      latest: job.target,
      outcome: job.state === 'done' ? 'installed' : 'failed',
      detail: `${what}：${lines.join('；')}；${pushed}`.slice(0, 1_000),
      trigger: job.trigger,
    })
  }
}

const STEP_WORD: Readonly<
  Record<UpgradeJobView['steps'][number]['state'], string>
> = {
  pending: '未开始',
  upgrading: '进行中',
  done: '完成',
  skipped: '跳过',
  failed: '失败',
}
