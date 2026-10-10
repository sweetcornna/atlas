// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 节点回报的读法与漂移判定（`providers-console-m1.md` §2.4，P18.6）。
 *
 * 节点的回应要进页面，所以这里按字段挑、按类型收，不认识的字段一律丢掉，字符串去掉
 * 控制字符并截短。中枢**不推断**节点的实际状态：页面上的「实际」「生效值」只来自这里
 * 读出来的东西；中枢自己算的只有一样——拿期望与节点回报比出来的漂移类型。
 */

import {
  modelFromStartupEnv,
  type ProviderDrift,
  type ProviderNodeActual,
  type ProviderProbeResult,
} from '@qianmo/console'
import {
  isKeyId,
  KEY_HEALTHS,
  KEY_OUT_REASONS,
  modelRetirementStatus,
  type ProviderProfile,
} from '@qianmo/providers'
import type { SentRecord } from './consoleProvidersBook.js'

type Json = Readonly<Record<string, unknown>>

const HASH = /^sha256:[0-9a-f]{64}$/
const ENV_KEY = /^[A-Z][A-Z0-9_]{0,63}$/
const SLOT_KEY = /^modelSettings\.[a-z][a-z0-9-]{0,31}$/
const OMP_PATH =
  /^(?:models\.providers\.qm-[a-z0-9._-]+(?:\.[A-Za-z0-9_.-]+)*|config\.(?:modelRoles|defaultThinkingLevel|retry|providers)(?:\.[A-Za-z0-9_.-]+)*|credentials\.qm-[a-z0-9._-]+(?:\.[0-9]+)?)$/
const NODE_CODE = /^[a-z][a-z0-9-]{0,39}$/
const MAX_TEXT = 300

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value)
}

/**
 * A string from a node, fit for a page: control characters out, bounded, and
 * every value in `secrets` replaced with `***` (a second guard: the protocol
 * already promises no values).
 */
export function nodeText(
  value: unknown,
  secrets: readonly string[] = [],
): string | null {
  if (typeof value !== 'string') return null
  let text = value
  for (const secret of secrets) {
    if (secret.length > 0) text = text.split(secret).join('***')
  }
  let out = ''
  for (const char of text) {
    const code = char.charCodeAt(0)
    out += code < 0x20 || (code >= 0x7f && code <= 0x9f) ? ' ' : char
  }
  out = out.trim()
  return out.length > MAX_TEXT ? `${out.slice(0, MAX_TEXT - 1)}…` : out
}

/** A node error code, or `null` when it is not shaped like one. */
export function nodeCode(value: unknown): string | null {
  return typeof value === 'string' && NODE_CODE.test(value) ? value : null
}

/** Env key names a node reported (`inheritedProviderKeys`); others dropped. */
function keyNames(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter(
    (item): item is string => typeof item === 'string' && ENV_KEY.test(item),
  )
}

/** Bounded native owned YAML paths and legacy node diff names, never values. */
export function diffKeyNames(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const names = new Set<string>()
  for (const item of value) {
    if (typeof item !== 'string') continue
    const name = item.startsWith('env.') ? item.slice(4) : item
    if (
      (name.length <= 300 && OMP_PATH.test(name)) ||
      ENV_KEY.test(name) ||
      name === 'modelType' ||
      SLOT_KEY.test(name)
    ) {
      names.add(name)
    }
  }
  return [...names]
}

function hashOrNull(value: unknown): string | null | undefined {
  if (value === null) return null
  return typeof value === 'string' && HASH.test(value) ? value : undefined
}

function isoText(value: unknown): string | null {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value))
    ? value
    : null
}

function parseEffective(raw: unknown): ProviderNodeActual['effective'] {
  if (!isRecord(raw)) return undefined
  const text = (key: string) => nodeText(raw[key])
  const apiProvider = text('apiProvider')
  const wire = text('wire')
  const model = text('model')
  const wireModel = text('wireModel')
  const slot = raw.modelSettingsSlot === null ? null : text('modelSettingsSlot')
  const level = raw.effortLevel === null ? null : text('effortLevel')
  if (
    apiProvider === null ||
    wire === null ||
    model === null ||
    wireModel === null ||
    (raw.modelSettingsSlot !== null && slot === null) ||
    (raw.effortLevel !== null && level === null) ||
    typeof raw.effortOnWire !== 'boolean' ||
    !isInteger(raw.contextTokens)
  ) {
    return undefined
  }
  const source = raw.autoCompactSource
  return {
    apiProvider,
    wire,
    model,
    wireModel,
    modelSettingsSlot: slot,
    effortOnWire: raw.effortOnWire,
    effortLevel: level,
    contextTokens: raw.contextTokens,
    ...(isInteger(raw.autoCompactWindow)
      ? { autoCompactWindow: raw.autoCompactWindow }
      : {}),
    ...(source === 'env' || source === 'settings' || source === 'auto'
      ? { autoCompactSource: source }
      : {}),
  }
}

/**
 * P18.18: a node's key pool, key by key — ids, states, when a cooling key
 * comes back and why it went out. An entry that is not shaped like one is
 * dropped; a node that reports none (a single key) gives `undefined`.
 */
function parseKeys(raw: unknown): ProviderNodeActual['keys'] {
  if (!Array.isArray(raw)) return undefined
  const keys: NonNullable<ProviderNodeActual['keys']>[number][] = []
  for (const entry of raw) {
    if (!isRecord(entry) || !isKeyId(entry.id)) continue
    const state = KEY_HEALTHS.find(health => health === entry.state)
    if (state === undefined) continue
    const until = state === 'cooling' ? isoText(entry.until) : null
    const reason = KEY_OUT_REASONS.find(word => word === entry.reason)
    keys.push({
      id: entry.id,
      state,
      ...(until === null ? {} : { until }),
      ...(reason === undefined || state === 'ok' ? {} : { reason }),
    })
  }
  return keys.length === 0 ? undefined : keys
}

/**
 * §2.4 state (plus `effective` when the response carries it), or `null` when
 * the node's answer is not shaped like one. `effective` is dropped for a node
 * whose model comes from its resident's start-up environment
 * ({@link modelFromStartupEnv}): an older node still sends one, computed from
 * the wrong inputs.
 */
export function parseNodeState(
  state: unknown,
  effective?: unknown,
): ProviderNodeActual | null {
  if (!isRecord(state) || typeof state.managed !== 'boolean') return null
  const onDiskHash = hashOrNull(state.onDiskHash)
  const appliedHash = hashOrNull(state.appliedHash)
  const loadedHash = hashOrNull(state.loadedHash)
  if (
    typeof onDiskHash !== 'string' ||
    appliedHash === undefined ||
    loadedHash === undefined
  ) {
    return null
  }
  let applied: ProviderNodeActual['applied'] = null
  if (state.applied !== null) {
    const raw = state.applied
    if (!isRecord(raw)) return null
    const profileId = nodeText(raw.profileId)
    const requestId = nodeText(raw.requestId)
    const at = isoText(raw.at)
    if (
      profileId === null ||
      requestId === null ||
      at === null ||
      !isInteger(raw.revision)
    ) {
      return null
    }
    applied = { profileId, revision: raw.revision, requestId, at }
  }
  let pending: ProviderNodeActual['pending'] = null
  if (state.pending !== null && state.pending !== undefined) {
    const raw = state.pending
    if (!isRecord(raw)) return null
    const requestId = nodeText(raw.requestId)
    const since = isoText(raw.since)
    if (requestId === null || since === null) return null
    pending = {
      requestId,
      since,
      waitingTurns: isInteger(raw.waitingTurns) ? raw.waitingTurns : null,
    }
  }
  let resident: ProviderNodeActual['resident'] = null
  if (isRecord(state.resident)) {
    const raw = state.resident
    resident = {
      running: raw.running === true,
      generation: isInteger(raw.generation) ? raw.generation : null,
      inFlight: isInteger(raw.inFlight) ? raw.inFlight : null,
    }
  }
  const caps = isRecord(state.capabilities) ? state.capabilities : {}
  let lastResult: ProviderNodeActual['lastResult'] = null
  if (isRecord(state.lastResult)) {
    const raw = state.lastResult
    const requestId = nodeText(raw.requestId)
    const code = nodeCode(raw.code)
    const at = isoText(raw.at)
    if (requestId !== null && code !== null && at !== null) {
      lastResult = { requestId, code, at, diffKeys: diffKeyNames(raw.diffKeys) }
    }
  }
  const inheritedProviderKeys = keyNames(state.inheritedProviderKeys)
  const computed = modelFromStartupEnv({
    managed: state.managed,
    inheritedProviderKeys,
  })
    ? undefined
    : parseEffective(effective)
  const keys = parseKeys(state.keys)
  return {
    managed: state.managed,
    applied,
    onDiskHash,
    appliedHash,
    loadedHash,
    pending,
    resident,
    inheritedProviderKeys,
    capabilities: {
      protocol: isInteger(caps.protocol) ? caps.protocol : 1,
      chatEffortHonorsOverride: caps.chatEffortHonorsOverride === true,
      replayFilter: caps.replayFilter === true,
      multiKey: caps.multiKey === true,
    },
    lastResult,
    ...(keys === undefined ? {} : { keys }),
    ...(computed === undefined ? {} : { effective: computed }),
  }
}

/** The §5.5 fields of a probe reply. */
export function parseProbeReply(
  reply: Json,
  node: string,
  requestId: string,
  secrets: readonly string[],
): ProviderProbeResult {
  const suggestion =
    isRecord(reply.suggestion) && typeof reply.suggestion.baseUrl === 'string'
      ? nodeText(reply.suggestion.baseUrl, secrets)
      : null
  const latency = isRecord(reply.latency) ? reply.latency : null
  const vendorCode = nodeText(reply.vendorCode, secrets)
  return {
    node,
    requestId,
    ok: reply.ok === true,
    reachable: reply.reachable === true,
    message:
      nodeText(reply.message, secrets) ??
      (reply.ok === true ? '可用' : '不可用'),
    ...(isInteger(reply.httpStatus) ? { httpStatus: reply.httpStatus } : {}),
    ...(vendorCode === null ? {} : { vendorCode }),
    ...(suggestion === null ? {} : { suggestion: { baseUrl: suggestion } }),
    ...(latency !== null &&
    typeof latency.medianMs === 'number' &&
    typeof latency.minMs === 'number' &&
    isInteger(latency.samples)
      ? {
          latency: {
            medianMs: latency.medianMs,
            minMs: latency.minMs,
            samples: latency.samples,
          },
        }
      : {}),
  }
}

/** What the hub wants a node to run: `null` when it does not manage the node. */
export interface Expected {
  readonly profileId: string
  readonly revision: number
  readonly contextOverride: number | null
}

/**
 * §2.4's drift types for one node: the desired state against what the node
 * last reported. `sent` is the hub's own record of the request the node
 * reports as applied (absent when somebody else applied it), which is how a
 * changed context override with an unchanged revision still reads as
 * out-of-sync.
 */
export function driftOf(input: {
  readonly expected: Expected | null
  readonly profile: ProviderProfile | undefined
  readonly actual: ProviderNodeActual | null
  readonly lastStatusOk: boolean | null
  readonly sent: SentRecord | undefined
  readonly now: Date
}): ProviderDrift[] {
  const { expected, actual, sent } = input
  const drift: ProviderDrift[] = []
  if (input.lastStatusOk === false) {
    drift.push({
      kind: 'unreachable',
      message: '最近一次状态刷新失败 · 下面是上一次成功时的实际状态（已过期）',
    })
  }
  if (actual !== null) {
    if (expected !== null && !actual.managed) {
      drift.push({
        kind: 'unmanaged',
        message: '节点还没有被托管 · 首次下发即接管',
      })
    }
    if (expected !== null && actual.managed) {
      const applied = actual.applied
      const sameProfile =
        applied !== null &&
        applied.profileId === expected.profileId &&
        applied.revision === expected.revision
      const sameContext =
        sent !== undefined
          ? (sent.context ?? null) === expected.contextOverride
          : expected.contextOverride === null
      if (!sameProfile || !sameContext) {
        drift.push({
          kind: 'out-of-sync',
          message: '期望与节点上已生效的配置不同 · 需要下发',
        })
      }
    }
    if (actual.pending !== null) {
      drift.push({
        kind: 'pending',
        message: `已下发 · 等节点空闲时切换（自 ${actual.pending.since}）`,
      })
    }
    if (
      actual.appliedHash !== null &&
      actual.onDiskHash !== actual.appliedHash
    ) {
      drift.push({
        kind: 'local-edit',
        message: '节点上的受管键在上次下发后被改过',
        ...(actual.lastResult !== null && actual.lastResult.diffKeys.length > 0
          ? { keys: actual.lastResult.diffKeys }
          : {}),
      })
    }
    if (
      actual.pending === null &&
      actual.appliedHash !== null &&
      actual.loadedHash !== actual.appliedHash
    ) {
      drift.push({
        kind: 'not-loaded',
        message:
          // No pid file (`resident: null`) is a node with no resident either.
          actual.resident?.running !== true
            ? '节点未运行 · 下次启动时加载'
            : '已写入 · 等待下一代子进程加载',
      })
    }
    if (actual.inheritedProviderKeys.length > 0) {
      drift.push({
        kind: 'env-residue',
        message:
          'resident 进程环境里还有旧的模型变量 · 子进程已剥离 · 下次重启后消失',
        keys: actual.inheritedProviderKeys,
      })
    }
  }
  if (input.profile !== undefined) {
    const retiring = input.profile.models.filter(
      model =>
        modelRetirementStatus(model.id, input.now, model.retireAt) !== 'active',
    )
    if (retiring.length > 0) {
      drift.push({
        kind: 'retiring-model',
        message: `模型 ${retiring.map(model => model.id).join('、')} 已下线或 14 天内下线 · 请换用替代模型`,
      })
    }
  }
  return drift
}
