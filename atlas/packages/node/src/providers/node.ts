// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Two-phase node configuration. Stage is synchronous; commit awaits omp's credential writer.
 * Each owned leaf may be either its old or target value after a crash; a third value
 * is a local-edit conflict. Journal remains until YAML, credentials and state agree.
 */
import { Database } from 'bun:sqlite'
import { chmodSync, existsSync } from 'node:fs'
import {
  AuthStorage,
  SqliteAuthCredentialStore,
} from '@oh-my-pi/pi-coding-agent/session/auth-storage'
import { ompAgentDir, qianmoConfigDir } from '@qianmo/paths'
import {
  type AppliedRecord,
  type ApplyRequest,
  type KeyStatus,
  type LastCommitResult,
  type NodeCapabilities,
  type ProviderErrorCode,
  type ProviderNodeState,
  type ProviderWarning,
  type SessionPolicy,
  parseProviderRequest,
  secretFingerprint,
} from '@qianmo/providers'
import { compileProfile, type CompiledProfile, LANE_API } from './compile.js'
import { getModelCompatCapabilities } from './capabilities.js'
import {
  diffKeyHashes,
  hashManagedView,
  isRecord,
  keyHashesOf,
  type ManagedView,
} from './managedView.js'
import {
  acquireApplyLock,
  ensurePrivateDir,
  isOwnerOnly,
  isProcessAlive,
  providerDir,
  providerPaths,
  readTextIfExists,
  removeIfExists,
  writePrivateFileAtomic,
  writePrivateJson,
} from './store.js'
import { inheritedProviderKeyNames } from './whitelist.js'
export { computeEffectiveProviderState } from './effective.js'
export { inheritedProviderKeyNames } from './whitelist.js'

const CAPABILITIES: NodeCapabilities = {
  protocol: 1,
  ...getModelCompatCapabilities(),
}
const CONFIG_FIELDS = ['modelRoles', 'defaultThinkingLevel', 'retry'] as const
const PROVIDER_FIELDS = ['cacheRetention', 'cacheWarming'] as const
export function readYaml(path: string): Record<string, unknown> {
  const raw = readTextIfExists(path)
  if (raw === undefined) return {}
  const data: unknown = Bun.YAML.parse(raw)
  if (!isRecord(data)) throw new Error('omp configuration must be a mapping')
  return data
}
function readJson<T>(path: string): T | null {
  const raw = readTextIfExists(path)
  if (raw === undefined) return null
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}
function inlineCredential(p: Record<string, unknown>): string | undefined {
  if (typeof p.apiKey === 'string') return p.apiKey
  return isRecord(p.headers) && typeof p.headers['X-Api-Key'] === 'string'
    ? p.headers['X-Api-Key']
    : undefined
}
function withStore<T>(
  fn: (store: SqliteAuthCredentialStore) => T,
): T | undefined {
  if (!existsSync(providerPaths.auth())) return undefined
  // Public constructor; no private SQL/schema knowledge. Existing DB only.
  const store = new SqliteAuthCredentialStore(
    new Database(providerPaths.auth()),
  )
  try {
    return fn(store)
  } finally {
    store.close()
  }
}
function credentialView(): Record<string, string[]> {
  return (
    withStore(store => {
      const out: Record<string, string[]> = {}
      for (const row of store.listAuthCredentials()) {
        if (row.provider.startsWith('qm-') && row.credential.type === 'api_key')
          (out[row.provider] ??= []).push(secretFingerprint(row.credential.key))
      }
      for (const hashes of Object.values(out)) hashes.sort()
      return out
    }) ?? {}
  )
}
function ownView(
  models: Record<string, unknown>,
  config: Record<string, unknown>,
  credentials = credentialView(),
): ManagedView {
  const providers = isRecord(models.providers) ? models.providers : {}
  const settingsProviders = isRecord(config.providers) ? config.providers : {}
  return {
    models: {
      providers: Object.fromEntries(
        Object.entries(providers).filter(([key]) => key.startsWith('qm-')),
      ),
    },
    config: {
      ...Object.fromEntries(
        CONFIG_FIELDS.filter(k => k in config).map(k => [k, config[k]]),
      ),
      providers: Object.fromEntries(
        PROVIDER_FIELDS.filter(k => k in settingsProviders).map(k => [
          k,
          settingsProviders[k],
        ]),
      ),
    },
    credentials,
  }
}
function readView(): ManagedView {
  try {
    return ownView(
      readYaml(providerPaths.models()),
      readYaml(providerPaths.config()),
    )
  } catch {
    return {
      unreadableModels: readTextIfExists(providerPaths.models()) ?? '',
      unreadableConfig: readTextIfExists(providerPaths.config()) ?? '',
    }
  }
}
export function currentManagedHash(): string {
  return hashManagedView(readView())
}
export function nodeModelSelection():
  | { provider: string; modelId: string; thinkingLevel?: string }
  | undefined {
  const config = readYaml(providerPaths.config())
  const roles = isRecord(config.modelRoles) ? config.modelRoles : {}
  if (typeof roles.default !== 'string') return undefined
  const slash = roles.default.indexOf('/')
  if (slash < 1) return undefined
  const provider = roles.default.slice(0, slash)
  const tail = roles.default.slice(slash + 1)
  const match = /:(off|minimal|low|medium|high|xhigh|max)$/.exec(tail)
  const modelId = match ? tail.slice(0, match.index) : tail
  const thinkingLevel =
    match?.[1] ??
    (typeof config.defaultThinkingLevel === 'string'
      ? config.defaultThinkingLevel
      : undefined)
  return { provider, modelId, ...(thinkingLevel ? { thinkingLevel } : {}) }
}
export function resolveKeptSecret(fingerprint: string): string | undefined {
  const providers = readYaml(providerPaths.models()).providers
  if (isRecord(providers))
    for (const p of Object.values(providers)) {
      if (
        isRecord(p) &&
        inlineCredential(p) !== undefined &&
        secretFingerprint(inlineCredential(p)!) === fingerprint
      )
        return inlineCredential(p)
    }
  return withStore(store => {
    for (const row of store.listAuthCredentials())
      if (
        row.provider.startsWith('qm-') &&
        row.credential.type === 'api_key' &&
        secretFingerprint(row.credential.key) === fingerprint
      )
        return row.credential.key
    return undefined
  })
}
export function configuredProvider() {
  const selection = nodeModelSelection()
  if (!selection) return undefined
  const providers = readYaml(providerPaths.models()).providers
  const provider = isRecord(providers)
    ? providers[selection.provider]
    : undefined
  if (
    !isRecord(provider) ||
    typeof provider.baseUrl !== 'string' ||
    typeof provider.api !== 'string'
  )
    return undefined
  const secret =
    inlineCredential(provider) !== undefined
      ? inlineCredential(provider)
      : withStore(store => {
          const row = store
            .listAuthCredentials(selection.provider)
            .find(row => row.credential.type === 'api_key')
          return row?.credential.type === 'api_key'
            ? row.credential.key
            : undefined
        })
  return {
    ...selection,
    baseUrl: provider.baseUrl,
    api: provider.api,
    secret,
    lane:
      Object.entries(LANE_API).find(([, api]) => api === provider.api)?.[0] ??
      'openai-chat',
    scheme:
      provider.api === 'anthropic-messages' && provider.authHeader !== true
        ? ('x-api-key' as const)
        : ('bearer' as const),
  }
}
type PoolKey = { id: string; value: string }
type Pending = {
  v: 2
  request: ApplyRequest
  requestId: string
  profile: { id: string; revision: number }
  compiled: CompiledProfile
  keys: PoolKey[]
  before: Record<string, string>
  target: Record<string, string>
  expectHash: string
  targetHash: string
  sessions: SessionPolicy
  stagedAt: string
}
type State = {
  v: 2
  applied: AppliedRecord
  appliedHash: string
  appliedKeyHashes: Record<string, string>
  lastResult: LastCommitResult | null
}
type Generation = {
  generation: number
  startedAt: string
  loadedHash: string
  inheritedProviderKeys: string[]
}
function loadPending(text: string): Pending | null {
  try {
    const p: unknown = JSON.parse(text)
    if (
      !isRecord(p) ||
      p.v !== 2 ||
      typeof p.requestId !== 'string' ||
      !isRecord(p.profile) ||
      !isRecord(p.compiled) ||
      !isRecord(p.compiled.models) ||
      !isRecord(p.compiled.config) ||
      !isRecord(p.before) ||
      !isRecord(p.target) ||
      !Array.isArray(p.keys) ||
      p.keys.length === 0 ||
      !p.keys.every(
        k =>
          isRecord(k) &&
          typeof k.id === 'string' &&
          typeof k.value === 'string',
      ) ||
      !['keep', 'reset'].includes(String(p.sessions))
    )
      return null
    const file = p as Pending
    const parsed = parseProviderRequest(file.request, {
      capabilities: CAPABILITIES,
      now: new Date(file.stagedAt),
    })
    if (
      !parsed.ok ||
      parsed.request.op !== 'apply' ||
      parsed.request.requestId !== file.requestId ||
      parsed.request.profile.id !== file.profile.id ||
      parsed.request.profile.revision !== file.profile.revision ||
      parsed.request.recycle.sessions !== file.sessions ||
      !Number.isFinite(Date.parse(file.stagedAt))
    )
      return null
    for (const key of parsed.request.profile.auth.keys) {
      const resolved = file.keys.find(k => k.id === key.id)
      if (
        !resolved ||
        ('value' in key
          ? resolved.value !== key.value
          : secretFingerprint(resolved.value) !== key.keep)
      )
        return null
    }
    if (file.keys.length !== parsed.request.profile.auth.keys.length)
      return null
    const rebuilt = compileProfile(parsed.request.profile, {
      secret: file.keys[0]!.value,
      capabilities: CAPABILITIES,
    })
    if (
      !rebuilt.ok ||
      hashManagedView(rebuilt.compiled) !== hashManagedView(file.compiled)
    )
      return null
    if (!Object.values(file.before).every(v => /^sha256:[0-9a-f]{64}$/.test(v)))
      return null
    if (
      JSON.stringify(keyHashesOf(targetView(file.compiled, file.keys))) !==
      JSON.stringify(file.target)
    )
      return null
    if (
      !file.compiled.providerId.startsWith('qm-') ||
      !isRecord(file.compiled.models.providers[file.compiled.providerId])
    )
      return null
    if (
      hashManagedView(targetView(file.compiled, file.keys)) !== file.targetHash
    )
      return null
    return file
  } catch {
    return null
  }
}
function targetView(compiled: CompiledProfile, keys: PoolKey[]): ManagedView {
  return ownView(
    compiled.models,
    compiled.config,
    keys.length > 1
      ? {
          [compiled.providerId]: keys
            .map(k => secretFingerprint(k.value))
            .sort(),
        }
      : {},
  )
}
type StageResult =
  | {
      ok: true
      requestId: string
      pending: boolean
      dryRun: boolean
      duplicate: 'pending' | 'applied' | null
      diffKeys: string[]
      warnings: ProviderWarning[]
    }
  | {
      ok: false
      requestId: string | null
      code: ProviderErrorCode
      message: string
      diffKeys?: string[]
    }
export function stageProviderApply(
  req: ApplyRequest,
  options: { capabilities?: NodeCapabilities; now?: Date; node?: string } = {},
): StageResult {
  const now = options.now ?? new Date()
  const capabilities = options.capabilities ?? CAPABILITIES
  const parsed = parseProviderRequest(req, {
    capabilities,
    now,
    ...(options.node ? { node: options.node } : {}),
  })
  if (!parsed.ok)
    return { ok: false, requestId: parsed.requestId, ...parsed.error }
  const request = parsed.request
  if (request.op !== 'apply')
    return {
      ok: false,
      requestId: request.requestId,
      code: 'unsupported-op',
      message: '这里只处理 apply',
    }
  const fail = (
    code: ProviderErrorCode,
    message: string,
    diffKeys?: string[],
  ): StageResult => ({
    ok: false,
    requestId: request.requestId,
    code,
    message,
    ...(diffKeys ? { diffKeys } : {}),
  })
  const success = (
    pending: boolean,
    duplicate: 'pending' | 'applied' | null,
    diffKeys: string[],
  ): StageResult => ({
    ok: true,
    requestId: request.requestId,
    pending,
    dryRun: request.dryRun,
    duplicate,
    diffKeys,
    warnings:
      request.profile.auth.keys.length > 1
        ? [
            ...parsed.warnings,
            {
              code: 'native-key-selection' as const,
              path: 'profile.keySelection',
              message:
                'omp 凭据池按会话固定选择、额度耗尽后轮换，瞬时限流则退避；原 fill_first / least_used 策略不再生效',
            },
          ]
        : parsed.warnings,
  })
  const lock = request.dryRun ? undefined : acquireApplyLock(now)
  if (lock === null) return fail('busy', '另一次下发正在进行')
  try {
    const state = readJson<State>(providerPaths.state())
    const pending = readTextIfExists(providerPaths.pending())
    if (
      !request.dryRun &&
      pending !== undefined &&
      loadPending(pending)?.requestId === request.requestId
    )
      return success(true, 'pending', [])
    if (!request.dryRun && state?.applied?.requestId === request.requestId)
      return success(false, 'applied', [])
    const view = readView()
    const before = keyHashesOf(view)
    const hash = hashManagedView(view)
    if (
      !request.dryRun &&
      !request.force &&
      ((request.expect.ownedHash === null && state?.applied) ||
        (request.expect.ownedHash !== null &&
          (!state?.applied || request.expect.ownedHash !== hash)))
    )
      return fail(
        'conflict',
        '节点受管配置与预期不符',
        diffKeyHashes(state?.appliedKeyHashes ?? {}, before),
      )
    const keys: PoolKey[] = []
    for (const key of [...request.profile.auth.keys].sort(
      (a, b) => (b.priority ?? 0) - (a.priority ?? 0),
    )) {
      const value = 'value' in key ? key.value : resolveKeptSecret(key.keep)
      if (value === undefined)
        return fail(
          'secret-mismatch',
          '节点上没有指纹相符的密钥 · 需要重新填写',
        )
      if (value.startsWith('!'))
        return fail('bad-value', '密钥不能使用 omp 命令求值语法')
      keys.push({ id: key.id, value })
    }
    const result = compileProfile(request.profile, {
      secret: keys[0]!.value,
      capabilities,
    })
    if (!result.ok) return fail(result.error.code, result.error.message)
    const target = targetView(result.compiled, keys)
    const diff = diffKeyHashes(before, keyHashesOf(target))
    if (request.dryRun) return success(false, null, diff)
    if (!existsSync(providerPaths.firstWrite()))
      writePrivateJson(providerPaths.firstWrite(), {
        models: readTextIfExists(providerPaths.models()) ?? null,
        config: readTextIfExists(providerPaths.config()) ?? null,
        credentials:
          withStore(store =>
            store
              .listAuthCredentials()
              .filter(r => r.provider.startsWith('qm-')),
          ) ?? [],
      })
    const file: Pending = {
      v: 2,
      request,
      requestId: request.requestId,
      profile: { id: request.profile.id, revision: request.profile.revision },
      compiled: result.compiled,
      keys,
      before,
      target: keyHashesOf(target),
      expectHash: hash,
      targetHash: hashManagedView(target),
      sessions: request.recycle.sessions,
      stagedAt: now.toISOString(),
    }
    writePrivateJson(providerPaths.pending(), file)
    return success(true, null, diff)
  } catch {
    return fail('write-failed', '无法准备 omp 配置 · 检查节点文件与权限')
  } finally {
    lock?.release()
  }
}
export function hasPendingProviderConfig(): boolean {
  return existsSync(providerPaths.pending())
}
type CommitResult =
  | { status: 'none' | 'busy' }
  | { status: 'bad-pending'; movedTo: string }
  | { status: 'refused'; reason: 'config-root-not-private'; message: string }
  | { status: 'conflict'; requestId: string; diffKeys: string[] }
  | { status: 'write-failed'; requestId: string; message: string }
  | {
      status: 'committed'
      requestId: string
      applied: AppliedRecord
      appliedHash: string
      sessions: SessionPolicy
      recovered: boolean
    }
export async function commitPendingProviderConfig(
  options: { now?: Date } = {},
): Promise<CommitResult> {
  if (!hasPendingProviderConfig()) return { status: 'none' }
  const now = options.now ?? new Date()
  const lock = acquireApplyLock(now)
  if (!lock) return { status: 'busy' }
  let pending: Pending | null = null
  try {
    const raw = readTextIfExists(providerPaths.pending())
    if (raw === undefined) return { status: 'none' }
    pending = loadPending(raw)
    if (!pending) {
      const movedTo = `${providerPaths.pending()}.bad-${now.getTime()}`
      writePrivateFileAtomic(movedTo, raw)
      removeIfExists(providerPaths.pending())
      return { status: 'bad-pending', movedTo }
    }
    if (!isOwnerOnly(qianmoConfigDir()))
      return {
        status: 'refused',
        reason: 'config-root-not-private',
        message: '配置根目录不是 0700 · 拒绝提交',
      }
    const state = readJson<State>(providerPaths.state())
    const current = keyHashesOf(readView())
    const names = new Set([
      ...Object.keys(current),
      ...Object.keys(pending.before),
      ...Object.keys(pending.target),
    ])
    const conflicts = [...names].filter(
      k =>
        current[k] !== pending!.before[k] && current[k] !== pending!.target[k],
    )
    if (conflicts.length) {
      if (state)
        writePrivateJson(providerPaths.state(), {
          ...state,
          lastResult: {
            requestId: pending.requestId,
            code: 'conflict',
            at: now.toISOString(),
            diffKeys: conflicts,
          },
        })
      removeIfExists(providerPaths.pending())
      return {
        status: 'conflict',
        requestId: pending.requestId,
        diffKeys: conflicts,
      }
    }
    const recovered =
      hashManagedView(readView()) !== pending.expectHash ||
      state?.applied?.requestId === pending.requestId
    ensurePrivateDir(ompAgentDir())
    const models = readYaml(providerPaths.models())
    const providers = isRecord(models.providers) ? models.providers : {}
    models.providers = {
      ...Object.fromEntries(
        Object.entries(providers).filter(([id]) => !id.startsWith('qm-')),
      ),
      ...pending.compiled.models.providers,
    }
    writePrivateJson(providerPaths.models(), models)
    const config = readYaml(providerPaths.config())
    const providerConfig = isRecord(config.providers) ? config.providers : {}
    Object.assign(config, pending.compiled.config)
    config.providers = {
      ...providerConfig,
      ...pending.compiled.config.providers,
    }
    writePrivateJson(providerPaths.config(), config)
    const store = await SqliteAuthCredentialStore.open(providerPaths.auth())
    try {
      const auth = new AuthStorage(store)
      await auth.credentials.reload()
      const active = new Set(
        store
          .listAuthCredentials()
          .filter(r => r.provider.startsWith('qm-'))
          .map(r => r.provider),
      )
      active.add(pending.compiled.providerId)
      for (const id of active) {
        const keys =
          id === pending.compiled.providerId && pending.keys.length > 1
            ? pending.keys.map(key => ({
                type: 'api_key' as const,
                key: key.value,
              }))
            : []
        await auth.credentials.set(id, keys)
      }
      if (pending.keys.length > 1)
        writePrivateJson(providerPaths.pool(), {
          provider: pending.compiled.providerId,
          keys: pending.keys.map(k => ({
            id: k.id,
            fingerprint: secretFingerprint(k.value),
          })),
        })
      else removeIfExists(providerPaths.pool())
    } finally {
      store.close()
    }
    chmodSync(providerPaths.auth(), 0o600)
    const appliedHash = currentManagedHash()
    if (appliedHash !== pending.targetHash)
      throw new Error('compiled configuration did not round trip')
    const applied = {
      profileId: pending.profile.id,
      revision: pending.profile.revision,
      requestId: pending.requestId,
      at: now.toISOString(),
    }
    writePrivateJson(providerPaths.state(), {
      v: 2,
      applied,
      appliedHash,
      appliedKeyHashes: pending.target,
      lastResult: null,
    })
    removeIfExists(providerPaths.pending())
    return {
      status: 'committed',
      requestId: pending.requestId,
      applied,
      appliedHash,
      sessions: pending.sessions,
      recovered,
    }
  } catch {
    return {
      status: 'write-failed',
      requestId: pending?.requestId ?? '',
      message: 'omp 配置提交未完成 · 保留意图以供恢复',
    }
  } finally {
    lock.release()
  }
}
function keyStatus(): KeyStatus[] | undefined {
  const pool = readJson<{
    provider: string
    keys: { id: string; fingerprint: string }[]
  }>(providerPaths.pool())
  if (!pool || nodeModelSelection()?.provider !== pool.provider)
    return undefined
  return withStore(store => {
    const rows = store.listAuthCredentials(pool.provider)
    const blocks = store.listCredentialBlocks(rows.map(r => r.id))
    return pool.keys.map(key => {
      const row = rows.find(
        r =>
          r.credential.type === 'api_key' &&
          secretFingerprint(r.credential.key) === key.fingerprint,
      )
      if (!row) return { id: key.id, state: 'dead', reason: 'auth' }
      const until = Math.max(
        0,
        ...blocks
          .filter(b => b.credentialId === row.id)
          .map(b => b.blockedUntilMs),
      )
      return until > Date.now()
        ? {
            id: key.id,
            state: 'cooling',
            until: new Date(until).toISOString(),
            reason: 'rate-limit',
          }
        : { id: key.id, state: 'ok' }
    })
  })
}
export function readProviderState(): ProviderNodeState {
  const state = readJson<State>(providerPaths.state())
  const generation = readJson<Generation>(providerPaths.generation())
  const pendingText = readTextIfExists(providerPaths.pending())
  const pending = pendingText === undefined ? null : loadPending(pendingText)
  const pid = readJson<{ pid: number }>(providerPaths.residentPid())
  const keys = keyStatus()
  return {
    managed: Boolean(state?.applied),
    applied: state?.applied ?? null,
    onDiskHash: currentManagedHash(),
    appliedHash: state?.appliedHash ?? null,
    loadedHash: generation?.loadedHash ?? null,
    pending: pending
      ? {
          requestId: pending.requestId,
          since: pending.stagedAt,
          waitingTurns: null,
        }
      : null,
    resident: pid
      ? {
          running: isProcessAlive(pid.pid),
          generation: generation?.generation ?? null,
          inFlight: null,
        }
      : null,
    inheritedProviderKeys: generation?.inheritedProviderKeys ?? [],
    capabilities: CAPABILITIES,
    lastResult: state?.lastResult ?? null,
    ...(keys ? { keys } : {}),
  }
}
export function recordProviderGeneration(input: {
  generation: number
  startedAt?: Date
  env?: Readonly<Record<string, string | undefined>>
}): Generation {
  const record = {
    generation: input.generation,
    startedAt: (input.startedAt ?? new Date()).toISOString(),
    loadedHash: currentManagedHash(),
    inheritedProviderKeys: inheritedProviderKeyNames(input.env ?? process.env),
  }
  ensurePrivateDir(providerDir())
  writePrivateJson(providerPaths.generation(), record)
  return record
}
