// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 模型服务的中枢一侧：`@qianmo/console` 的 `ProviderPort` 的生产实现
 * （`providers-console-m1.md` §2–§3、§6.3、§7，P18.6）。
 *
 * 三样东西在这里接起来：
 *
 * - 期望状态 `providers.ndjson`（`consoleProvidersBook.ts`）；
 * - 密文库与主密钥（`consoleProvidersSecrets.ts`）；
 * - 第六类动作的执行器（`consoleProvidersExec.ts`）。
 *
 * ## 谁能写、怎么记账
 *
 * 写方法要个人账号的 ops 角色（R-13 / D-4），这里再判一次（路由那一道是主门）；
 * 角色不够的回 `rejected`、不记账。放行之后每个写方法**自己**记动作账本：一次保存
 * 一条，一次下发每个节点一条、记的是节点回报的结果（§7.6）。target 只是档案 id 或
 * 节点名。
 *
 * ## 密钥只写不读
 *
 * 明文只在两处出现：`setSecret` / `saveProfile` 收进来的那一刻，和组装第六类动作
 * 请求、写进执行器 stdin 的那一刻。任何返回值、账本、日志、错误信息里都没有它的值
 * 或片段；节点回来的文字在进页面之前把本次送出去的值再替换一遍（第二道）。
 *
 * ## 同步段
 *
 * 「核对修订号 → 写密文 → 记事件」中间没有 `await`：两个并发请求不会在里面交错
 * （§2.3 第 3 步「同一把档案锁内」）。只有执行器调用是异步的，它按节点串行。
 */

import { randomUUID } from 'node:crypto'
import {
  type ActionOutcome,
  type ProviderActionName,
  type ProviderApplyResult,
  type ProviderAssignment,
  type ProviderAutocompactResult,
  type ProviderCaller,
  type ProviderCandidate,
  type ProviderCatalog,
  type ProviderCompilePreview,
  type ProviderEffortLevel,
  type ProviderExport,
  type ProviderFailure,
  type ProviderImportInput,
  type ProviderImportPreview,
  type ProviderIssueView,
  type ProviderNodeActual,
  type ProviderNodeView,
  type ProviderOverview,
  type ProviderPort,
  type ProviderPresetView,
  type ProviderProbeResult,
  type ProviderProfileDraft,
  type ProviderProfileSummary,
  type ProviderProfileView,
  type ProviderResult,
} from '@qianmo/console'
import {
  type AutoCompactReport,
  type AutocompactRequest,
  isEffortLevel,
  type KeyRef,
  type NodeCapabilities,
  PRESET_GROUPS,
  PRESETS,
  PROTOCOL_LIMITS,
  PROTOCOL_VERSION,
  parseProviderProfile,
  parseProviderRequest,
  parseWireProfile,
  presetById,
  primaryKey,
  type ProviderProfile,
  type ProviderWarning,
  resolveBaseUrl,
  type WireProfile,
} from '@qianmo/providers'
import { compileProfile } from '../../services/qianmo/providers/compile.js'
import { FileActionLedger } from './consoleActionLedger.js'
import { ProviderBook } from './consoleProvidersBook.js'
import {
  type ExecResult,
  type NodeReply,
  ProviderExecutor,
  type ProviderNodeTarget,
} from './consoleProvidersExec.js'
import {
  driftOf,
  diffKeyNames,
  type Expected,
  nodeCode,
  nodeText,
  parseNodeState,
  parseProbeReply,
} from './consoleProvidersNode.js'
import { ProviderSecretStore } from './consoleProvidersSecrets.js'

const PERSONAL_SUBJECT = /^u:[0-9a-f]{16}$/
/** §2.5 limits; `autocompact` is P18.7's and not in this build's table yet. */
const TIMEOUTS = PROTOCOL_LIMITS.timeoutMs
/** Repeated refreshes of one node inside this window are answered from cache. */
const REFRESH_THROTTLE_MS = 5_000
/** §2.3 step 10: poll every 5 s for at most 2 min after an apply. */
const FOLLOW_INTERVAL_MS = 5_000
const FOLLOW_LIMIT_MS = 120_000
/** §2.3 step 10: the background refresh. */
const BACKGROUND_INTERVAL_MS = 10 * 60_000
/** Import documents are a handful of profiles; this is generous. */
const MAX_IMPORT_BYTES = 1024 * 1024
const MAX_IMPORT_PROFILES = 200

/** Capabilities assumed for a node that has not reported any (the v1 floor). */
const FLOOR_CAPABILITIES: NodeCapabilities = {
  protocol: 1,
  chatEffortHonorsOverride: false,
  replayFilter: false,
  multiKey: false,
}

/** What a compile preview puts where the key would go; never sent anywhere. */
const PREVIEW_SECRET = 'preview-placeholder-not-a-key'

/** Timers, injectable so the follow-up polling can be driven by a test. */
export interface ProviderScheduler {
  set(run: () => void, ms: number): unknown
  clear(handle: unknown): void
}

const REAL_SCHEDULER: ProviderScheduler = {
  set(run, ms) {
    const handle = setTimeout(run, ms)
    handle.unref?.()
    return handle
  },
  clear(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>)
  },
}

interface NodeCache {
  actual: ProviderNodeActual | null
  lastStatus: { at: number; ok: boolean; message?: string } | null
}

interface ConsoleProvidersOptions {
  readonly book: ProviderBook
  readonly secrets: ProviderSecretStore
  readonly executor: ProviderExecutor
  readonly now?: () => number
  readonly scheduler?: ProviderScheduler
  readonly onAlarm?: (line: string) => void
}

function fail<T>(
  code: ProviderFailure['code'],
  message: string,
  extra: Omit<ProviderFailure, 'code' | 'message'> = {},
): ProviderResult<T> {
  return { ok: false, failure: { code, message, ...extra } }
}

function done<T>(value: T): ProviderResult<T> {
  return { ok: true, value }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function issueOf(warning: ProviderWarning): ProviderIssueView {
  return { code: warning.code, message: warning.message, path: warning.path }
}

/** The host of a profile's resolved base URL; never a path, never userinfo. */
function hostOf(
  profile: Pick<ProviderProfile, 'baseUrl' | 'templateValues'>,
): string {
  const resolved = resolveBaseUrl(profile.baseUrl, profile.templateValues)
  if (!resolved.ok) return ''
  try {
    return new URL(resolved.url).hostname
  } catch {
    return ''
  }
}

/** A profile's keys without the hub's bookkeeping (what an export carries). */
function bareKeys(keys: readonly KeyRef[]): KeyRef[] {
  return keys.map(key => ({
    id: key.id,
    ...(key.label === undefined ? {} : { label: key.label }),
    ...(key.priority === undefined ? {} : { priority: key.priority }),
  }))
}

/** A ledger target from untrusted input: the id when it is one, else `-`. */
/** The flat `autocompact` reply as P18.7's `AutoCompactReport`, or `null`. */
function autoCompactReportOf(reply: NodeReply): AutoCompactReport | null {
  const { autoCompactWindow, configured, source, message } = reply
  if (
    typeof autoCompactWindow !== 'number' ||
    typeof configured !== 'number' ||
    (source !== 'env' && source !== 'settings' && source !== 'auto') ||
    (message !== undefined && typeof message !== 'string')
  ) {
    return null
  }
  return {
    autoCompactWindow,
    configured,
    source,
    ...(message === undefined ? {} : { message }),
  }
}

function targetOf(value: unknown): string {
  return typeof value === 'string' && /^[a-z0-9-]{1,48}$/.test(value)
    ? value
    : '-'
}

/**
 * The model-service port. One instance per console; open it with
 * {@link openConsoleProviders}.
 */
export class ConsoleProviders implements ProviderPort {
  readonly #book: ProviderBook
  readonly #secrets: ProviderSecretStore
  readonly #executor: ProviderExecutor
  readonly #now: () => number
  readonly #scheduler: ProviderScheduler
  readonly #onAlarm: (line: string) => void
  readonly #cache = new Map<string, NodeCache>()
  readonly #follows = new Map<string, unknown>()
  #background: unknown = null
  #changes = 0

  constructor(options: ConsoleProvidersOptions) {
    this.#book = options.book
    this.#secrets = options.secrets
    this.#executor = options.executor
    this.#now = options.now ?? Date.now
    this.#scheduler = options.scheduler ?? REAL_SCHEDULER
    this.#onAlarm = options.onAlarm ?? (() => {})
  }

  /** `null` while usable; otherwise why the providers face is closed. */
  get problem(): string | null {
    return this.#book.problem ?? this.#secrets.problem
  }

  /** Nodes this console can reach, for the banner. */
  get nodes(): readonly string[] {
    return this.#executor.nodes()
  }

  /** Start the 10-minute background refresh (§2.3 step 10). */
  start(): void {
    if (this.#background !== null) return
    const tick = () => {
      this.#background = this.#scheduler.set(tick, BACKGROUND_INTERVAL_MS)
      if (this.problem !== null) return
      for (const node of this.#executor.nodes()) void this.#refresh(node)
    }
    this.#background = this.#scheduler.set(tick, 0)
  }

  stop(): void {
    if (this.#background !== null) this.#scheduler.clear(this.#background)
    this.#background = null
    for (const handle of this.#follows.values()) this.#scheduler.clear(handle)
    this.#follows.clear()
  }

  // --- reads -------------------------------------------------------------

  async overview(): Promise<ProviderResult<ProviderOverview>> {
    const closed = this.#closed<ProviderOverview>()
    if (closed !== null) return closed
    const nodes = this.#executor.nodes().map(node => this.#nodeView(node))
    const profiles: ProviderProfileSummary[] = this.#book
      .profiles()
      .map(profile => ({
        profile: this.#view(profile),
        secrets: profile.keys.map(key => {
          const at = this.#sealedAt(profile, key)
          return {
            keyId: key.id,
            set: at !== null,
            ...(at === null ? {} : { setAt: at }),
          }
        }),
        nodes: nodes
          .filter(view => view.expected?.profileId === profile.id)
          .map(view => view.node),
        isDefault: this.#book.defaultProfileId === profile.id,
      }))
    return done({
      revision: this.#book.revision + this.#changes,
      defaultProfileId: this.#book.defaultProfileId,
      profiles,
      nodes,
    })
  }

  async profile(id: string): Promise<ProviderResult<ProviderProfileView>> {
    const closed = this.#closed<ProviderProfileView>()
    if (closed !== null) return closed
    const profile = this.#book.profile(id)
    if (profile === undefined) return fail('not_found', '没有这份档案')
    return done(this.#view(profile))
  }

  catalog(): ProviderCatalog {
    return {
      groups: PRESET_GROUPS,
      presets: PRESETS.map(({ probe: _probe, ...preset }) => {
        const view: ProviderPresetView = preset
        return view
      }),
    }
  }

  draftFromPreset(input: {
    readonly presetId: string
    readonly site?: string
  }): ProviderResult<ProviderProfileView> {
    const preset = presetById(input.presetId)
    if (preset === undefined) return fail('not_found', '没有这个预设')
    const site =
      input.site === undefined
        ? preset.sites[0]
        : preset.sites.find(entry => entry.id === input.site)
    if (input.site !== undefined && site === undefined) {
      return fail('invalid', '这个预设没有这个站点', { path: 'site' })
    }
    let id = preset.id
    for (let n = 2; this.#book.profile(id) !== undefined; n += 1) {
      id = `${preset.id}-${n}`.slice(0, 48)
    }
    const draft: ProviderProfile = {
      id,
      revision: 0,
      name: preset.name.slice(0, 40),
      presetId: preset.id,
      plan: preset.plan,
      site: site?.id ?? null,
      lane: preset.lane,
      baseUrl: site?.baseUrl ?? preset.baseUrl,
      models: preset.models,
      compat: preset.compat,
      effortLock: null,
      keySelection: 'fill_first',
      auth: { scheme: preset.authScheme },
      keys: [{ id: 'k1' }],
      probe: preset.probe,
      ...(preset.terms === null ? {} : { terms: preset.terms }),
      evaluated: false,
    }
    return done(this.#view(draft))
  }

  async preview(input: {
    readonly candidate: ProviderCandidate
    readonly node?: string
  }): Promise<ProviderResult<ProviderCompilePreview>> {
    const closed = this.#closed<ProviderCompilePreview>()
    if (closed !== null) return closed
    if (
      input.node !== undefined &&
      this.#executor.target(input.node) === undefined
    ) {
      return fail('not_found', '没有这个节点')
    }
    const resolved = this.#candidateProfile(input.candidate)
    if (!resolved.ok) return resolved
    const override =
      input.node === undefined ? null : this.#book.contextOverride(input.node)
    const wire = this.#wire(resolved.value.profile, PREVIEW_SECRET, override)
    const compiled = compileProfile(wire, {
      secret: PREVIEW_SECRET,
      capabilities: this.#capabilities(input.node),
    })
    if (!compiled.ok) {
      return fail('invalid', compiled.error.message, {
        path: compiled.error.path,
        nodeCode: compiled.error.code,
      })
    }
    const { patch, route, effectiveLane, secretEnvKey } = compiled.compiled
    const set: Record<string, string | null> = {}
    const deleted: string[] = []
    for (const [key, value] of Object.entries(patch.env)) {
      if (value === undefined) deleted.push(key)
      else set[key] = key === secretEnvKey ? null : value
    }
    const modelSettings: Record<
      string,
      { effort?: ProviderEffortLevel; contextTokens?: number }
    > = {}
    for (const [slot, value] of Object.entries(patch.modelSettings)) {
      if (value === undefined || value === null) continue
      modelSettings[slot] = {
        ...(isEffortLevel(value.effort) ? { effort: value.effort } : {}),
        ...(value.contextTokens === undefined
          ? {}
          : { contextTokens: value.contextTokens }),
      }
    }
    return done({
      modelType: patch.modelType,
      route,
      effectiveLane,
      set,
      secretKeys: [secretEnvKey],
      deleted: deleted.sort(),
      modelSettings,
      warnings: resolved.value.warnings,
    })
  }

  async node(node: string): Promise<ProviderResult<ProviderNodeView>> {
    const closed = this.#closed<ProviderNodeView>()
    if (closed !== null) return closed
    if (this.#executor.target(node) === undefined) {
      return fail('not_found', '没有这个节点')
    }
    return done(this.#nodeView(node))
  }

  async refreshNode(node: string): Promise<ProviderResult<ProviderNodeView>> {
    const closed = this.#closed<ProviderNodeView>()
    if (closed !== null) return closed
    if (this.#executor.target(node) === undefined) {
      return fail('not_found', '没有这个节点')
    }
    const last = this.#cache.get(node)?.lastStatus
    if (
      last === undefined ||
      last === null ||
      this.#now() - last.at >= REFRESH_THROTTLE_MS
    ) {
      await this.#refresh(node)
    }
    return done(this.#nodeView(node))
  }

  async exportProfiles(
    ids?: readonly string[],
  ): Promise<ProviderResult<ProviderExport>> {
    const closed = this.#closed<ProviderExport>()
    if (closed !== null) return closed
    const chosen: ProviderProfile[] = []
    for (const id of ids ?? this.#book.profiles().map(profile => profile.id)) {
      const profile = this.#book.profile(id)
      if (profile === undefined) return fail('not_found', `没有档案 ${id}`)
      chosen.push(profile)
    }
    const profiles = chosen.map(profile => ({
      ...profile,
      keys: bareKeys(profile.keys),
    }))
    const text = `${JSON.stringify(
      { v: 1, kind: 'qianmo-providers', secrets: 'not-included', profiles },
      null,
      2,
    )}\n`
    const day = new Date(this.#now())
      .toISOString()
      .slice(0, 10)
      .replace(/-/g, '')
    return done({
      filename: `qianmo-providers-${day}.json`,
      text,
      count: profiles.length,
    })
  }

  async importPreview(
    text: string,
  ): Promise<ProviderResult<ProviderImportPreview>> {
    const closed = this.#closed<ProviderImportPreview>()
    if (closed !== null) return closed
    const parsed = this.#parseImport(text)
    if (!parsed.ok) return parsed
    return done({
      profiles: parsed.value.profiles.map(profile => this.#view(profile)),
      collisions: parsed.value.profiles
        .map(profile => profile.id)
        .filter(id => this.#book.profile(id) !== undefined),
      warnings: parsed.value.warnings,
    })
  }

  async models(
    input: { readonly node: string; readonly candidate?: ProviderCandidate },
    caller: ProviderCaller,
  ): Promise<ProviderResult<readonly { readonly id: string }[]>> {
    const denied = this.#authorize<readonly { readonly id: string }[]>(caller)
    if (denied !== null) return denied
    const closed = this.#closed<readonly { readonly id: string }[]>()
    if (closed !== null) return closed
    if (this.#executor.target(input.node) === undefined) {
      return fail('not_found', '没有这个节点')
    }
    let wire: WireProfile | undefined
    let secrets: string[] = []
    if (input.candidate !== undefined) {
      const built = this.#candidateWire(input.candidate)
      if (!built.ok) return built
      wire = built.value.wire
      secrets = [built.value.secret]
    }
    const requestId = this.#requestId()
    const request = {
      v: 1,
      op: 'models',
      requestId,
      node: input.node,
      ...(wire === undefined ? {} : { profile: wire }),
    }
    const checked = this.#check<readonly { readonly id: string }[]>(
      request,
      input.node,
    )
    if (checked !== null) return checked
    const result = await this.#executor.run(
      input.node,
      request,
      TIMEOUTS.models,
    )
    if (!result.ok) return fail('unreachable', result.message)
    const reply = result.reply
    if (!reply.ok)
      return this.#refusedBy<readonly { readonly id: string }[]>(reply, secrets)
    const list = Array.isArray(reply.models) ? reply.models : []
    const models: { id: string }[] = []
    for (const entry of list) {
      const id = isRecord(entry) ? nodeText(entry.id, secrets) : null
      if (id !== null && id !== '') models.push({ id })
    }
    return done(models)
  }

  // --- writes ------------------------------------------------------------

  async saveProfile(
    input: {
      readonly profile: ProviderProfileDraft
      readonly ifMatch: number | null
      readonly secrets?: Readonly<Record<string, string>>
    },
    caller: ProviderCaller,
  ): Promise<ProviderResult<ProviderProfileView>> {
    const denied = this.#authorize<ProviderProfileView>(caller)
    if (denied !== null) return denied
    const target = targetOf(input.profile.id)
    const result = this.#save(input)
    await this.#note(caller, 'provider.save', target, result)
    if (result.ok) {
      // One line per key filled in with the save (§2.3 step 3).
      for (const _keyId of Object.keys(input.secrets ?? {})) {
        await caller.record('provider.secret.set', result.value.id, 'ok')
      }
    }
    return result
  }

  async deleteProfile(
    input: { readonly profileId: string; readonly ifMatch: number },
    caller: ProviderCaller,
  ): Promise<ProviderResult<void>> {
    const denied = this.#authorize<void>(caller)
    if (denied !== null) return denied
    const result = this.#delete(input)
    await this.#note(
      caller,
      'provider.delete',
      targetOf(input.profileId),
      result,
    )
    return result
  }

  async setSecret(
    input: {
      readonly profileId: string
      readonly keyId: string
      readonly value: string
      readonly ifMatch: number
    },
    caller: ProviderCaller,
  ): Promise<ProviderResult<ProviderProfileView>> {
    const denied = this.#authorize<ProviderProfileView>(caller)
    if (denied !== null) return denied
    const result = this.#rekey(input.profileId, input.keyId, input.ifMatch, {
      value: input.value,
    })
    await this.#note(
      caller,
      'provider.secret.set',
      targetOf(input.profileId),
      result,
    )
    return result
  }

  async clearSecret(
    input: {
      readonly profileId: string
      readonly keyId: string
      readonly ifMatch: number
    },
    caller: ProviderCaller,
  ): Promise<ProviderResult<ProviderProfileView>> {
    const denied = this.#authorize<ProviderProfileView>(caller)
    if (denied !== null) return denied
    const result = this.#rekey(
      input.profileId,
      input.keyId,
      input.ifMatch,
      null,
    )
    await this.#note(
      caller,
      'provider.secret.clear',
      targetOf(input.profileId),
      result,
    )
    return result
  }

  async setDefault(
    input: { readonly profileId: string | null },
    caller: ProviderCaller,
  ): Promise<ProviderResult<void>> {
    const denied = this.#authorize<void>(caller)
    if (denied !== null) return denied
    const target = input.profileId ?? this.#book.defaultProfileId ?? '-'
    let result: ProviderResult<void>
    const closed = this.#closed<void>()
    if (closed !== null) result = closed
    else if (
      input.profileId !== null &&
      this.#book.profile(input.profileId) === undefined
    ) {
      result = fail('not_found', '没有这份档案')
    } else {
      result = this.#write<void>(
        { kind: 'default.set', profileId: input.profileId ?? '' },
        undefined,
      )
    }
    await this.#note(caller, 'provider.default.set', targetOf(target), result)
    return result
  }

  async assign(
    input: { readonly node: string; readonly assignment: ProviderAssignment },
    caller: ProviderCaller,
  ): Promise<ProviderResult<ProviderNodeView>> {
    const denied = this.#authorize<ProviderNodeView>(caller)
    if (denied !== null) return denied
    const result = this.#assign(input)
    await this.#note(
      caller,
      'provider.assign',
      this.#nodeTarget(input.node),
      result,
    )
    return result
  }

  async setContextOverride(
    input: { readonly node: string; readonly tokens: number | null },
    caller: ProviderCaller,
  ): Promise<ProviderResult<ProviderNodeView>> {
    const denied = this.#authorize<ProviderNodeView>(caller)
    if (denied !== null) return denied
    const result = this.#context(input)
    await this.#note(
      caller,
      input.tokens === null ? 'provider.context.clear' : 'provider.context.set',
      this.#nodeTarget(input.node),
      result,
    )
    return result
  }

  async apply(
    input: {
      readonly nodes?: readonly string[]
      readonly dryRun?: boolean
      readonly force?: boolean
      readonly sessions?: 'keep' | 'reset'
      readonly profileId?: string
    },
    caller: ProviderCaller,
  ): Promise<ProviderResult<readonly ProviderApplyResult[]>> {
    const denied = this.#authorize<readonly ProviderApplyResult[]>(caller)
    if (denied !== null) return denied
    const dryRun = input.dryRun === true
    const force = input.force === true
    const action: ProviderActionName = force
      ? 'provider.apply.force'
      : 'provider.apply'
    const closed = this.#closed<readonly ProviderApplyResult[]>()
    if (closed !== null) {
      if (!dryRun) {
        for (const node of input.nodes ?? []) {
          await caller.record(
            action,
            this.#nodeTarget(node),
            'failed',
            'unavailable',
          )
        }
      }
      return closed
    }
    if (input.profileId !== undefined && !dryRun) {
      return fail('invalid', '指定档案只用于 dry-run；要换档案先改指派', {
        path: 'profileId',
      })
    }
    const nodes =
      input.nodes ??
      this.#executor.nodes().filter(node => this.#expected(node) !== null)
    const unknown = nodes.filter(
      node => this.#executor.target(node) === undefined,
    )
    if (unknown.length > 0) {
      return fail('not_found', '没有这些节点', { nodes: unknown })
    }
    const results: ProviderApplyResult[] = []
    for (const node of nodes) {
      const result = await this.#applyOne(node, {
        dryRun,
        force,
        ...(input.sessions === undefined ? {} : { sessions: input.sessions }),
        ...(input.profileId === undefined
          ? {}
          : { profileId: input.profileId }),
      })
      results.push(result)
      if (!dryRun) {
        await caller.record(
          action,
          node,
          result.outcome,
          ...(result.code === undefined ? [] : [result.code]),
        )
      }
    }
    return done(results)
  }

  async probe(
    input: {
      readonly node: string
      readonly mode: 'auth' | 'latency' | 'call'
      readonly candidate: ProviderCandidate
    },
    caller: ProviderCaller,
  ): Promise<ProviderResult<ProviderProbeResult>> {
    const denied = this.#authorize<ProviderProbeResult>(caller)
    if (denied !== null) return denied
    const action: ProviderActionName =
      input.mode === 'call'
        ? 'provider.probe.call'
        : input.mode === 'latency'
          ? 'provider.probe.latency'
          : 'provider.probe.auth'
    const result = await this.#probe(input)
    const target = this.#nodeTarget(input.node)
    if (result.ok) {
      await caller.record(
        action,
        target,
        result.value.ok ? 'ok' : 'failed',
        ...(result.value.ok ? [] : ['probe-failed']),
      )
    } else {
      await this.#note(caller, action, target, result)
    }
    return result
  }

  async autocompact(
    input: { readonly node: string; readonly value?: 'auto' | number },
    caller: ProviderCaller,
  ): Promise<ProviderResult<ProviderAutocompactResult>> {
    const denied = this.#authorize<ProviderAutocompactResult>(caller)
    if (denied !== null) return denied
    const result = await this.#autocompact(input)
    if (input.value !== undefined) {
      await this.#note(
        caller,
        'provider.autocompact',
        this.#nodeTarget(input.node),
        result,
      )
    }
    return result
  }

  async importProfiles(
    input: ProviderImportInput,
    caller: ProviderCaller,
  ): Promise<ProviderResult<readonly ProviderProfileView[]>> {
    const denied = this.#authorize<readonly ProviderProfileView[]>(caller)
    if (denied !== null) return denied
    const result = this.#import(input)
    if (result.ok) {
      for (const profile of result.value) {
        await caller.record('provider.import', profile.id, 'ok')
      }
    } else {
      await this.#note(caller, 'provider.import', '-', result)
    }
    return result
  }

  // --- the gate and the ledger -------------------------------------------

  #authorize<T>(caller: ProviderCaller): ProviderResult<T> | null {
    if (
      caller.breakGlass ||
      caller.role !== 'ops' ||
      !PERSONAL_SUBJECT.test(caller.subject)
    ) {
      return fail('rejected', '模型服务的这一步需要运维角色的个人账号')
    }
    return null
  }

  #closed<T>(): ProviderResult<T> | null {
    const problem = this.problem
    return problem === null
      ? null
      : fail('unavailable', `模型服务已停用：${problem}`)
  }

  /** One ledger line for a finished write: `ok`, or how it was turned away. */
  async #note(
    caller: ProviderCaller,
    action: ProviderActionName,
    target: string,
    result: ProviderResult<unknown>,
  ): Promise<void> {
    if (result.ok) {
      await caller.record(action, target, 'ok')
      return
    }
    const { code, nodeCode: fromNode } = result.failure
    const outcome: ActionOutcome =
      code === 'unreachable' || code === 'unavailable' ? 'failed' : 'refused'
    await caller.record(action, target, outcome, fromNode ?? code)
  }

  #nodeTarget(node: string): string {
    return this.#executor.target(node) === undefined ? '-' : node
  }

  /** Record one book event; `unavailable` when the book will not take it. */
  #write<T>(
    event: Parameters<ProviderBook['record']>[0],
    value: T,
  ): ProviderResult<T> {
    if (!this.#book.record(event)) {
      return (
        this.#closed<T>() ??
        fail('unavailable', '模型服务账本拒收了这一条，已告警')
      )
    }
    return done(value)
  }

  // --- profiles ----------------------------------------------------------

  #view(profile: ProviderProfile): ProviderProfileView {
    const view: ProviderProfileView = profile
    return view
  }

  /** When the key was sealed, if the sealed key is the one the profile names. */
  #sealedAt(profile: ProviderProfile, key: KeyRef): string | null {
    const ref = { profileId: profile.id, keyId: key.id }
    const fp = this.#secrets.fingerprint(ref)
    if (fp === null || fp !== key.fingerprint) return null
    return this.#secrets.sealedAt(ref)
  }

  /** The value of the profile's delivered key, if it is sealed and current. */
  #secretOf(profile: ProviderProfile): string | null {
    const key = primaryKey(profile.keys)
    if (this.#sealedAt(profile, key) === null) return null
    return this.#secrets.reveal({ profileId: profile.id, keyId: key.id })
  }

  /** Check every new key value with the catalog's own rule for one. */
  #checkSecrets(
    profile: ProviderProfile,
    secrets: Readonly<Record<string, string>>,
  ): ProviderResult<void> {
    for (const [keyId, value] of Object.entries(secrets)) {
      if (!profile.keys.some(key => key.id === keyId)) {
        return fail('invalid', `档案里没有密钥 ${keyId}`, { path: 'secrets' })
      }
      const parsed = parseWireProfile(this.#wire(profile, value, null))
      if (!parsed.ok) {
        // The validator's message names the rule, never the value.
        return fail('invalid', parsed.error.message, {
          path: `secrets.${keyId}`,
        })
      }
    }
    return done(undefined)
  }

  #save(input: {
    readonly profile: ProviderProfileDraft
    readonly ifMatch: number | null
    readonly secrets?: Readonly<Record<string, string>>
  }): ProviderResult<ProviderProfileView> {
    const closed = this.#closed<ProviderProfileView>()
    if (closed !== null) return closed
    const draft = input.profile
    const id = draft.id
    if (typeof id !== 'string')
      return fail('invalid', '档案缺 id', { path: 'id' })
    const existing = this.#book.profile(id)
    if (input.ifMatch === null && existing !== undefined) {
      return fail('conflict', '这个 id 已经有档案了 · 换一个 id', {
        fields: ['id'],
      })
    }
    if (input.ifMatch !== null) {
      if (existing === undefined) return fail('not_found', '没有这份档案')
      if (existing.revision !== input.ifMatch) {
        return fail('conflict', '此服务已被他人修改 · 刷新后再保存', {
          fields: changedFields(existing, draft),
        })
      }
    }
    const revision = this.#book.lastRevision(id) + 1
    const secrets = input.secrets ?? {}
    const at = new Date(this.#now()).toISOString()
    const keys = Array.isArray(draft.keys)
      ? draft.keys.map(entry => {
          if (!isRecord(entry)) return entry
          const { fingerprint: _f, setAt: _s, ...rest } = entry
          const keyId = typeof rest.id === 'string' ? rest.id : ''
          const value = secrets[keyId]
          if (value !== undefined) return rest
          const old = existing?.keys.find(key => key.id === keyId)
          const sealed =
            existing !== undefined && old !== undefined
              ? this.#sealedAt(existing, old)
              : null
          return sealed !== null && old?.fingerprint !== undefined
            ? {
                ...rest,
                fingerprint: old.fingerprint,
                setAt: old.setAt ?? sealed,
              }
            : rest
        })
      : draft.keys
    const parsed = parseProviderProfile(
      { ...draft, revision, keys },
      { now: new Date(this.#now()) },
    )
    if (!parsed.ok) {
      return fail('invalid', parsed.error.message, {
        path: parsed.error.path,
        nodeCode: parsed.error.code,
      })
    }
    let profile = parsed.value
    const checked = this.#checkSecrets(profile, secrets)
    if (!checked.ok) return checked
    let fingerprints: Record<string, string>
    try {
      fingerprints = this.#secrets.commit(
        profile.id,
        revision,
        profile.keys
          .filter(key => key.fingerprint !== undefined)
          .map(key => key.id),
        secrets,
      )
    } catch (error) {
      this.#onAlarm(`console providers: 密文库写不进去（${messageOf(error)}）`)
      return fail('unavailable', '密文库写不进去，已告警')
    }
    profile = {
      ...profile,
      keys: profile.keys.map(key =>
        fingerprints[key.id] === undefined
          ? key
          : { ...key, fingerprint: fingerprints[key.id], setAt: at },
      ),
    }
    // The profile line first: a `secret.set` line names a fingerprint the
    // book already holds for that key.
    const saved = this.#write(
      {
        kind: 'profile.saved',
        id: profile.id,
        revision,
        body: JSON.stringify(profile),
      },
      this.#view(profile),
    )
    if (!saved.ok) return saved
    for (const [keyId, fp] of Object.entries(fingerprints)) {
      const wrote = this.#write(
        { kind: 'secret.set', profileId: profile.id, keyId, fp },
        null,
      )
      if (!wrote.ok) return wrote
    }
    return saved
  }

  #delete(input: {
    readonly profileId: string
    readonly ifMatch: number
  }): ProviderResult<void> {
    const closed = this.#closed<void>()
    if (closed !== null) return closed
    const profile = this.#book.profile(input.profileId)
    if (profile === undefined) return fail('not_found', '没有这份档案')
    if (profile.revision !== input.ifMatch) {
      return fail('conflict', '此服务已被他人修改 · 刷新后再删除', {
        fields: [],
      })
    }
    const users = this.#executor.nodes().filter(node => {
      const expected = this.#expected(node)
      const applied = this.#cache.get(node)?.actual?.applied
      return (
        expected?.profileId === profile.id || applied?.profileId === profile.id
      )
    })
    if (users.length > 0 || this.#book.isReferenced(profile.id)) {
      return fail('in_use', '还有节点在用这份档案 · 先指定替代档案', {
        nodes: users,
      })
    }
    try {
      this.#secrets.forget(profile.id)
    } catch (error) {
      this.#onAlarm(`console providers: 密文库写不进去（${messageOf(error)}）`)
      return fail('unavailable', '密文库写不进去，已告警')
    }
    return this.#write(
      { kind: 'profile.deleted', id: profile.id, revision: profile.revision },
      undefined,
    )
  }

  /** Set (`change.value`) or clear (`null`) one key; a new profile revision either way. */
  #rekey(
    profileId: string,
    keyId: string,
    ifMatch: number,
    change: { readonly value: string } | null,
  ): ProviderResult<ProviderProfileView> {
    const closed = this.#closed<ProviderProfileView>()
    if (closed !== null) return closed
    const profile = this.#book.profile(profileId)
    if (profile === undefined) return fail('not_found', '没有这份档案')
    if (profile.revision !== ifMatch) {
      return fail('conflict', '此服务已被他人修改 · 刷新后再试', { fields: [] })
    }
    if (!profile.keys.some(key => key.id === keyId)) {
      return fail('not_found', '档案里没有这把密钥')
    }
    if (change !== null) {
      const checked = this.#checkSecrets(profile, { [keyId]: change.value })
      if (!checked.ok) return checked
    }
    const revision = this.#book.lastRevision(profileId) + 1
    const keep = profile.keys
      .filter(key => key.id !== keyId && this.#sealedAt(profile, key) !== null)
      .map(key => key.id)
    let fingerprints: Record<string, string>
    try {
      fingerprints = this.#secrets.commit(
        profileId,
        revision,
        keep,
        change === null ? {} : { [keyId]: change.value },
      )
    } catch (error) {
      this.#onAlarm(`console providers: 密文库写不进去（${messageOf(error)}）`)
      return fail('unavailable', '密文库写不进去，已告警')
    }
    const at = new Date(this.#now()).toISOString()
    const next: ProviderProfile = {
      ...profile,
      revision,
      keys: profile.keys.map(key => {
        if (key.id !== keyId) {
          return keep.includes(key.id) ? key : (bareKeys([key])[0] ?? key)
        }
        const fp = fingerprints[keyId]
        return fp === undefined
          ? (bareKeys([key])[0] ?? key)
          : { ...key, fingerprint: fp, setAt: at }
      }),
    }
    const event =
      change === null
        ? ({ kind: 'secret.cleared', profileId, keyId } as const)
        : ({
            kind: 'secret.set',
            profileId,
            keyId,
            fp: fingerprints[keyId] ?? '',
          } as const)
    const saved = this.#write(
      {
        kind: 'profile.saved',
        id: profileId,
        revision,
        body: JSON.stringify(next),
      },
      this.#view(next),
    )
    if (!saved.ok) return saved
    const wrote = this.#write(event, null)
    return wrote.ok ? saved : wrote
  }

  #assign(input: {
    readonly node: string
    readonly assignment: ProviderAssignment
  }): ProviderResult<ProviderNodeView> {
    const closed = this.#closed<ProviderNodeView>()
    if (closed !== null) return closed
    if (this.#executor.target(input.node) === undefined) {
      return fail('not_found', '没有这个节点')
    }
    const assignment = input.assignment
    if (assignment.mode === 'profile') {
      if (this.#book.profile(assignment.profileId) === undefined) {
        return fail('not_found', '没有这份档案')
      }
      const wrote = this.#write(
        {
          kind: 'scope.assigned',
          node: input.node,
          mode: 'profile',
          profileId: assignment.profileId,
        },
        null,
      )
      if (!wrote.ok) return wrote
    } else if (
      assignment.mode === 'inherit' ||
      assignment.mode === 'unmanaged'
    ) {
      const wrote = this.#write(
        { kind: 'scope.assigned', node: input.node, mode: assignment.mode },
        null,
      )
      if (!wrote.ok) return wrote
    } else {
      return fail('invalid', '指派方式只有跟随默认、指定档案、不托管三种', {
        path: 'assignment.mode',
      })
    }
    return done(this.#nodeView(input.node))
  }

  #context(input: {
    readonly node: string
    readonly tokens: number | null
  }): ProviderResult<ProviderNodeView> {
    const closed = this.#closed<ProviderNodeView>()
    if (closed !== null) return closed
    if (this.#executor.target(input.node) === undefined) {
      return fail('not_found', '没有这个节点')
    }
    if (input.tokens === null) {
      const wrote = this.#write(
        { kind: 'context.cleared', node: input.node },
        null,
      )
      return wrote.ok ? done(this.#nodeView(input.node)) : wrote
    }
    const problem = contextTokensProblem(input.tokens)
    if (problem !== null) return fail('invalid', problem, { path: 'tokens' })
    const wrote = this.#write(
      { kind: 'context.set', node: input.node, tokens: input.tokens },
      null,
    )
    return wrote.ok ? done(this.#nodeView(input.node)) : wrote
  }

  #parseImport(text: string): ProviderResult<{
    profiles: ProviderProfile[]
    warnings: ProviderIssueView[]
  }> {
    if (Buffer.byteLength(text, 'utf8') > MAX_IMPORT_BYTES) {
      return fail('invalid', '导入文件超过 1 MiB')
    }
    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch {
      return fail('invalid', '导入文件不是 JSON')
    }
    if (
      !isRecord(raw) ||
      raw.v !== 1 ||
      raw.kind !== 'qianmo-providers' ||
      !Array.isArray(raw.profiles)
    ) {
      return fail(
        'invalid',
        '不是阡陌模型服务的导出文件（v 1，kind qianmo-providers）',
      )
    }
    if (
      raw.profiles.length === 0 ||
      raw.profiles.length > MAX_IMPORT_PROFILES
    ) {
      return fail('invalid', `档案数要在 1 到 ${MAX_IMPORT_PROFILES} 之间`)
    }
    const profiles: ProviderProfile[] = []
    const warnings: ProviderIssueView[] = []
    const problems: string[] = []
    const seen = new Set<string>()
    raw.profiles.forEach((entry, index) => {
      const body = isRecord(entry)
        ? {
            ...entry,
            revision: 1,
            evaluated: false,
            keys: Array.isArray(entry.keys)
              ? entry.keys.map(key => {
                  if (!isRecord(key)) return key
                  const { fingerprint: _f, setAt: _s, ...rest } = key
                  return rest
                })
              : entry.keys,
          }
        : entry
      const parsed = parseProviderProfile(body, { now: new Date(this.#now()) })
      if (!parsed.ok) {
        problems.push(
          `profiles.${index}${parsed.error.path ? `.${parsed.error.path}` : ''}`,
        )
        return
      }
      if (seen.has(parsed.value.id)) {
        problems.push(`profiles.${index}.id`)
        return
      }
      seen.add(parsed.value.id)
      profiles.push(parsed.value)
      warnings.push(...parsed.warnings.map(issueOf))
    })
    if (problems.length > 0) {
      return fail('invalid', '导入文件里有不合法或不认识的字段 · 整份拒绝', {
        fields: problems,
      })
    }
    return done({ profiles, warnings })
  }

  #import(
    input: ProviderImportInput,
  ): ProviderResult<readonly ProviderProfileView[]> {
    const closed = this.#closed<readonly ProviderProfileView[]>()
    if (closed !== null) return closed
    const parsed = this.#parseImport(input.text)
    if (!parsed.ok) return parsed
    const renames = input.renames ?? {}
    const finalIds = new Set<string>()
    const missing: string[] = []
    const plan: ProviderProfile[] = []
    for (const profile of parsed.value.profiles) {
      const id = renames[profile.id] ?? profile.id
      if (this.#book.profile(id) !== undefined || finalIds.has(id)) {
        missing.push(profile.id)
        continue
      }
      finalIds.add(id)
      plan.push({ ...profile, id })
    }
    if (missing.length > 0) {
      return fail('conflict', '有档案 id 已存在 · 只能另存为新 id，不覆盖', {
        fields: missing,
      })
    }
    const saved: ProviderProfileView[] = []
    for (const profile of plan) {
      const revision = this.#book.lastRevision(profile.id) + 1
      const next = parseProviderProfile(
        { ...profile, revision },
        { now: new Date(this.#now()) },
      )
      if (!next.ok) {
        return fail('invalid', next.error.message, { path: next.error.path })
      }
      const wrote = this.#write(
        {
          kind: 'profile.saved',
          id: next.value.id,
          revision,
          body: JSON.stringify(next.value),
        },
        this.#view(next.value),
      )
      if (!wrote.ok) return wrote
      saved.push(wrote.value)
    }
    return done(saved)
  }

  // --- nodes -------------------------------------------------------------

  #expected(node: string): Expected | null {
    const assignment = this.#book.assignment(node)
    const profileId =
      assignment.mode === 'profile'
        ? assignment.profileId
        : assignment.mode === 'inherit'
          ? this.#book.defaultProfileId
          : null
    if (profileId === null) return null
    const profile = this.#book.profile(profileId)
    if (profile === undefined) return null
    return {
      profileId,
      revision: profile.revision,
      contextOverride: this.#book.contextOverride(node),
    }
  }

  #capabilities(node: string | undefined): NodeCapabilities {
    if (node === undefined) return FLOOR_CAPABILITIES
    const reported = this.#cache.get(node)?.actual?.capabilities
    return reported === undefined
      ? FLOOR_CAPABILITIES
      : { ...reported, protocol: 1 }
  }

  #nodeView(node: string): ProviderNodeView {
    const target = this.#executor.target(node)
    const expected = this.#expected(node)
    const cache = this.#cache.get(node)
    const actual = cache?.actual ?? null
    const appliedRequest = actual?.applied?.requestId
    return {
      node,
      executor: target?.kind ?? 'local',
      assignment: this.#book.assignment(node),
      contextOverride: this.#book.contextOverride(node),
      expected,
      actual,
      lastStatus: cache?.lastStatus ?? null,
      drift: driftOf({
        expected,
        profile:
          expected === null
            ? undefined
            : this.#book.profile(expected.profileId),
        actual,
        lastStatusOk: cache?.lastStatus?.ok ?? null,
        sent:
          appliedRequest === undefined
            ? undefined
            : this.#book.sent(appliedRequest),
        now: new Date(this.#now()),
      }),
      recent: this.#book.activity(node),
    }
  }

  /** The wire form of a profile for one node: the D-8 override on the main model. */
  #wire(
    profile: ProviderProfile,
    secret: string,
    contextOverride: number | null,
  ): WireProfile {
    const key = primaryKey(profile.keys)
    return {
      id: profile.id,
      revision: profile.revision,
      lane: profile.lane,
      baseUrl: profile.baseUrl,
      ...(profile.templateValues === undefined
        ? {}
        : { templateValues: profile.templateValues }),
      models:
        contextOverride === null
          ? profile.models
          : profile.models.map(model =>
              model.role === 'main'
                ? { ...model, contextTokens: contextOverride }
                : model,
            ),
      ...(profile.compat === undefined ? {} : { compat: profile.compat }),
      ...(profile.effortLock === undefined
        ? {}
        : { effortLock: profile.effortLock }),
      ...(profile.keySelection === undefined
        ? {}
        : { keySelection: profile.keySelection }),
      auth: {
        scheme: profile.auth.scheme,
        keys: [
          {
            id: key.id,
            value: secret,
            ...(key.priority === undefined ? {} : { priority: key.priority }),
          },
        ],
      },
    }
  }

  /** A candidate as a validated profile (no secret involved). */
  #candidateProfile(candidate: ProviderCandidate): ProviderResult<{
    profile: ProviderProfile
    warnings: ProviderIssueView[]
  }> {
    if ('profileId' in candidate) {
      const profile = this.#book.profile(candidate.profileId)
      if (profile === undefined) return fail('not_found', '没有这份档案')
      return done({ profile, warnings: [] })
    }
    const draft = candidate.draft
    const keys = Array.isArray(draft.keys)
      ? draft.keys.map(key => {
          if (!isRecord(key)) return key
          const { fingerprint: _f, setAt: _s, ...rest } = key
          return rest
        })
      : [{ id: 'k1' }]
    const parsed = parseProviderProfile(
      {
        ...draft,
        revision: typeof draft.revision === 'number' ? draft.revision : 0,
        keys,
      },
      { now: new Date(this.#now()) },
    )
    if (!parsed.ok) {
      return fail('invalid', parsed.error.message, {
        path: parsed.error.path,
        nodeCode: parsed.error.code,
      })
    }
    return done({
      profile: parsed.value,
      warnings: parsed.warnings.map(issueOf),
    })
  }

  /** A candidate as a deliverable profile, with the key it will carry. */
  #candidateWire(candidate: ProviderCandidate): ProviderResult<{
    wire: WireProfile
    secret: string
    profileId: string
  }> {
    const resolved = this.#candidateProfile(candidate)
    if (!resolved.ok) return resolved
    const profile = resolved.value.profile
    let secret = candidate.secret
    if (secret === undefined) {
      const stored = this.#book.profile(profile.id)
      secret =
        stored === undefined ? undefined : (this.#secretOf(stored) ?? undefined)
    }
    if (secret === undefined) {
      return fail('invalid', '这份档案还没有密钥 · 先填写', { path: 'secret' })
    }
    const checked = this.#checkSecrets(profile, {
      [primaryKey(profile.keys).id]: secret,
    })
    if (!checked.ok) return checked
    return done({
      wire: this.#wire(profile, secret, null),
      secret,
      profileId: profile.id,
    })
  }

  /** The request as the node will parse it; refused here rather than sent. */
  #check<T>(
    request: Readonly<Record<string, unknown>>,
    node: string,
  ): ProviderResult<T> | null {
    const parsed = parseProviderRequest(request, {
      node,
      capabilities: this.#capabilities(node),
      now: new Date(this.#now()),
    })
    if (parsed.ok) return null
    return fail('invalid', parsed.error.message, {
      path: parsed.error.path,
      nodeCode: parsed.error.code,
    })
  }

  #refusedBy<T>(
    reply: NodeReply,
    secrets: readonly string[],
  ): ProviderResult<T> {
    const code = nodeCode(reply.code) ?? 'refused'
    const message = nodeText(reply.message, secrets) ?? '节点拒绝了这次操作'
    const failed = code === 'write-failed' || code === 'probe-failed'
    return fail(failed ? 'unreachable' : 'refused', message, { nodeCode: code })
  }

  #requestId(): string {
    return randomUUID().replace(/-/g, '')
  }

  /** §2.7: keep only when lane and host are the ones the node last committed. */
  #sessions(
    node: string,
    profile: ProviderProfile,
    requested: 'keep' | 'reset' | undefined,
  ): ProviderResult<'keep' | 'reset'> {
    const committed = this.#book.committed(node)
    const last =
      committed === null ? undefined : this.#book.sent(committed.requestId)
    const same =
      last !== undefined &&
      last.lane === profile.lane &&
      last.host === hostOf(profile)
    if (requested === undefined) return done(same ? 'keep' : 'reset')
    if (
      requested === 'keep' &&
      !same &&
      !this.#capabilities(node).replayFilter
    ) {
      return fail(
        'invalid',
        '换厂商或换线路时只能重置会话 · 节点支持回放过滤之后才能保留',
        { path: 'sessions' },
      )
    }
    return done(requested)
  }

  async #applyOne(
    node: string,
    options: {
      readonly dryRun: boolean
      readonly force: boolean
      readonly sessions?: 'keep' | 'reset'
      readonly profileId?: string
    },
  ): Promise<ProviderApplyResult> {
    const requestId = this.#requestId()
    const refuse = (code: string, message: string): ProviderApplyResult => ({
      node,
      requestId,
      outcome: 'refused',
      code,
      message,
    })
    const expected = this.#expected(node)
    const profileId = options.profileId ?? expected?.profileId
    if (profileId === undefined) {
      return refuse('not-managed', '这个节点不受托管 · 先指派档案或设全局默认')
    }
    const profile = this.#book.profile(profileId)
    if (profile === undefined) return refuse('not-found', '没有这份档案')
    const secret = this.#secretOf(profile)
    if (secret === null) {
      return refuse('secret-missing', '这份档案还没有密钥 · 先填写')
    }
    const sessions = this.#sessions(node, profile, options.sessions)
    if (!sessions.ok) return refuse('invalid', sessions.failure.message)
    const override = this.#book.contextOverride(node)
    const wire = this.#wire(profile, secret, override)
    const request = {
      v: 1,
      op: 'apply',
      requestId,
      node,
      expect: { ownedHash: this.#book.committed(node)?.appliedHash ?? null },
      profile: wire,
      recycle: { sessions: sessions.value },
      dryRun: options.dryRun,
      force: options.force,
    }
    const checked = this.#check<void>(request, node)
    if (checked !== null && !checked.ok) {
      return refuse(
        checked.failure.nodeCode ?? 'invalid',
        checked.failure.message,
      )
    }
    const result = await this.#executor.run(node, request, TIMEOUTS.apply)
    const applied = this.#applyResult(node, requestId, result, [secret])
    const base = {
      ...applied,
      sessions: sessions.value,
      profileId: profile.id,
      revision: profile.revision,
    }
    if (options.dryRun) return base
    this.#book.record({
      kind: 'apply.result',
      node,
      requestId,
      profileId: profile.id,
      revision: profile.revision,
      outcome: base.outcome,
      ...(base.code === undefined ? {} : { code: base.code }),
      pending: base.pending === true,
      force: options.force,
      sessions: sessions.value,
      lane: profile.lane,
      host: hostOf(profile) || 'unknown',
      ...(override === null ? {} : { context: override }),
    })
    if (result.ok && result.reply.ok) {
      this.#observe(node, result.reply)
      if (base.pending === true) this.#follow(node, requestId)
    }
    return base
  }

  #applyResult(
    node: string,
    requestId: string,
    result: ExecResult,
    secrets: readonly string[],
  ): ProviderApplyResult {
    if (!result.ok) {
      return {
        node,
        requestId,
        outcome: 'failed',
        code: 'unreachable',
        message: result.message,
      }
    }
    const reply = result.reply
    const diffKeys = diffKeyNames(reply.diffKeys)
    if (!reply.ok) {
      const code = nodeCode(reply.code) ?? 'refused'
      return {
        node,
        requestId,
        outcome: code === 'write-failed' ? 'failed' : 'refused',
        code,
        message: nodeText(reply.message, secrets) ?? '节点拒绝了这次下发',
        ...(diffKeys.length > 0 ? { diffKeys } : {}),
      }
    }
    const state = isRecord(reply.state) ? reply.state : null
    const pending =
      state !== null &&
      isRecord(state.pending) &&
      state.pending.requestId === requestId
    return {
      node,
      requestId,
      outcome: 'ok',
      message:
        reply.state === undefined
          ? '校验通过 · 没有写入'
          : pending
            ? '已下发 · 节点空闲时切换'
            : '已写入节点',
      pending,
      ...(diffKeys.length > 0 ? { diffKeys } : {}),
    }
  }

  /** Take a node's reported state; record `apply.committed` when it names our request. */
  #observe(node: string, reply: NodeReply): void {
    if (reply.state === undefined) return
    const actual = parseNodeState(reply.state, reply.effective)
    if (actual === null) return
    const previous = this.#cache.get(node)
    this.#cache.set(node, {
      actual:
        reply.effective === undefined &&
        previous?.actual?.effective !== undefined
          ? { ...actual, effective: previous.actual.effective }
          : actual,
      lastStatus: previous?.lastStatus ?? null,
    })
    this.#changes += 1
    const applied = actual.applied
    if (applied === null || actual.appliedHash === null) return
    const sent = this.#book.sent(applied.requestId)
    if (sent === undefined || sent.node !== node) return
    if (this.#book.committed(node)?.requestId === applied.requestId) return
    this.#book.record({
      kind: 'apply.committed',
      node,
      requestId: applied.requestId,
      appliedHash: actual.appliedHash,
    })
  }

  async #refresh(node: string): Promise<void> {
    const requestId = this.#requestId()
    const result = await this.#executor.run(
      node,
      { v: 1, op: 'status', requestId, node },
      TIMEOUTS.status,
    )
    const at = this.#now()
    const previous = this.#cache.get(node) ?? { actual: null, lastStatus: null }
    if (result.ok && result.reply.ok) {
      this.#observe(node, result.reply)
      const cache = this.#cache.get(node) ?? previous
      cache.lastStatus = { at, ok: true }
      this.#cache.set(node, cache)
    } else {
      const message = result.ok
        ? (nodeText(result.reply.message) ?? '节点拒绝了状态查询')
        : result.message
      this.#cache.set(node, {
        actual: previous.actual,
        lastStatus: { at, ok: false, message },
      })
      this.#changes += 1
    }
  }

  /** §2.3 step 10: poll until the switch has landed, for at most 2 min. */
  #follow(node: string, requestId: string): void {
    const started = this.#now()
    const old = this.#follows.get(node)
    if (old !== undefined) this.#scheduler.clear(old)
    const tick = async () => {
      this.#follows.delete(node)
      await this.#refresh(node)
      const actual = this.#cache.get(node)?.actual
      const landed =
        actual !== null &&
        actual !== undefined &&
        actual.pending === null &&
        actual.applied?.requestId === requestId &&
        (actual.loadedHash === actual.appliedHash ||
          actual.resident?.running !== true)
      if (landed || this.#now() - started >= FOLLOW_LIMIT_MS) return
      this.#follows.set(
        node,
        this.#scheduler.set(() => void tick(), FOLLOW_INTERVAL_MS),
      )
    }
    this.#follows.set(
      node,
      this.#scheduler.set(() => void tick(), FOLLOW_INTERVAL_MS),
    )
  }

  async #probe(input: {
    readonly node: string
    readonly mode: 'auth' | 'latency' | 'call'
    readonly candidate: ProviderCandidate
  }): Promise<ProviderResult<ProviderProbeResult>> {
    const closed = this.#closed<ProviderProbeResult>()
    if (closed !== null) return closed
    if (this.#executor.target(input.node) === undefined) {
      return fail('not_found', '没有这个节点')
    }
    const built = this.#candidateWire(input.candidate)
    if (!built.ok) return built
    const requestId = this.#requestId()
    const request = {
      v: 1,
      op: 'probe',
      requestId,
      node: input.node,
      profile: built.value.wire,
      probe: { mode: input.mode },
    }
    const checked = this.#check<ProviderProbeResult>(request, input.node)
    if (checked !== null) return checked
    const timeout =
      input.mode === 'call'
        ? TIMEOUTS.probeCall
        : input.mode === 'latency'
          ? TIMEOUTS.probeLatency
          : TIMEOUTS.probeAuth
    const result = await this.#executor.run(input.node, request, timeout)
    if (!result.ok) return fail('unreachable', result.message)
    const reply = result.reply
    if (!reply.ok && reply.code !== 'probe-failed') {
      return this.#refusedBy(reply, [built.value.secret])
    }
    const probe = parseProbeReply(reply, input.node, requestId, [
      built.value.secret,
    ])
    this.#book.record({
      kind: 'probe.result',
      node: input.node,
      requestId,
      profileId: built.value.profileId,
      mode: input.mode,
      ok: probe.ok,
      reachable: probe.reachable,
    })
    return done(probe)
  }

  async #autocompact(input: {
    readonly node: string
    readonly value?: 'auto' | number
  }): Promise<ProviderResult<ProviderAutocompactResult>> {
    const closed = this.#closed<ProviderAutocompactResult>()
    if (closed !== null) return closed
    if (this.#executor.target(input.node) === undefined) {
      return fail('not_found', '没有这个节点')
    }
    const value = input.value
    const request: AutocompactRequest = {
      v: PROTOCOL_VERSION,
      op: 'autocompact',
      requestId: this.#requestId(),
      node: input.node,
      ...(value === undefined ? {} : { value }),
    }
    // The protocol's own rule (`AUTO_COMPACT_LIMITS`): a bad value is refused
    // here, before anything is started on the node.
    const checked = this.#check<ProviderAutocompactResult>(request, input.node)
    if (checked !== null) return checked
    const result = await this.#executor.run(
      input.node,
      request,
      TIMEOUTS.autocompact,
    )
    if (!result.ok) return fail('unreachable', result.message)
    const reply = result.reply
    if (!reply.ok) {
      const code = nodeCode(reply.code) ?? 'refused'
      const message =
        code === 'unsupported-op'
          ? '节点的版本还不支持 autocompact'
          : (nodeText(reply.message) ?? '节点拒绝了这次修改')
      return fail(
        code === 'write-failed'
          ? 'unreachable'
          : code === 'bad-value'
            ? 'invalid'
            : 'refused',
        message,
        { nodeCode: code },
      )
    }
    const report = autoCompactReportOf(reply)
    if (report === null) {
      return fail('unreachable', '节点的回应不是 autocompact 的形状')
    }
    if (value !== undefined) {
      this.#changes += 1
      void this.#refresh(input.node)
    }
    const message = nodeText(report.message)
    return done({
      node: input.node,
      autoCompactWindow: report.autoCompactWindow,
      configured: report.configured,
      source: report.source,
      ...(message === null ? {} : { message }),
    })
  }
}

/** The top-level fields of `draft` that differ from `stored` (§6.3.3 409). */
function changedFields(
  stored: ProviderProfile,
  draft: ProviderProfileDraft,
): string[] {
  const fields = new Set([...Object.keys(stored), ...Object.keys(draft)])
  fields.delete('revision')
  fields.delete('keys')
  const record = stored as unknown as Readonly<Record<string, unknown>>
  return [...fields]
    .filter(
      field => JSON.stringify(record[field]) !== JSON.stringify(draft[field]),
    )
    .sort()
}

/**
 * D-8: whether `tokens` is a context window a profile may carry. Asked of the
 * catalog's own validator with a minimal profile, so the bounds live in one
 * place (`validate.ts`).
 */
function contextTokensProblem(tokens: number): string | null {
  const parsed = parseProviderProfile({
    id: 'context-check',
    revision: 1,
    name: 'context-check',
    presetId: null,
    plan: 'custom',
    site: null,
    lane: 'openai-chat',
    baseUrl: 'https://context-check.invalid/v1',
    auth: { scheme: 'bearer' },
    keys: [{ id: 'k1' }],
    models: [
      {
        id: 'context-check',
        role: 'main',
        tiers: ['opus', 'sonnet', 'haiku', 'fable'],
        capabilities: { mode: 'family' },
        effort: { send: 'auto' },
        contextTokens: tokens,
      },
    ],
    evaluated: false,
  })
  return parsed.ok ? null : parsed.error.message
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

interface OpenConsoleProvidersOptions {
  readonly storePath: string
  readonly secretsPath: string
  readonly keyPath: string
  readonly knownHostsFile: string
  readonly nodes: readonly ProviderNodeTarget[]
  readonly onAlarm?: (line: string) => void
  readonly sshBinary?: string
  readonly now?: () => number
  readonly scheduler?: ProviderScheduler
}

/**
 * Open the providers face. Never throws for a bad store: a book with a bad
 * line, a master key that is missing or too open, a secret store that does
 * not match — each closes this face ({@link ConsoleProviders.problem}) and
 * the rest of the console starts as usual.
 */
export function openConsoleProviders(
  options: OpenConsoleProvidersOptions,
): ConsoleProviders {
  const onAlarm =
    options.onAlarm ??
    ((line: string) => {
      process.stderr.write(`${line}\n`)
    })
  const now = options.now ?? Date.now
  const book = new ProviderBook({
    store: new FileActionLedger(options.storePath),
    onAlarm,
    now,
  })
  const secrets = new ProviderSecretStore(
    { secretsPath: options.secretsPath, keyPath: options.keyPath },
    () => new Date(now()),
  )
  if (secrets.problem !== null) {
    onAlarm(`console providers: ${secrets.problem}；模型服务已停用`)
  }
  const executor = new ProviderExecutor(options.nodes, {
    knownHostsFile: options.knownHostsFile,
    ...(options.sshBinary === undefined
      ? {}
      : { sshBinary: options.sshBinary }),
  })
  return new ConsoleProviders({
    book,
    secrets,
    executor,
    now,
    onAlarm,
    ...(options.scheduler === undefined
      ? {}
      : { scheduler: options.scheduler }),
  })
}
