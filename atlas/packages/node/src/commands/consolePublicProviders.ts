// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 公开版的模型服务（P35，`--billing`）：同一个 `ConsoleProviders`，外面多一层
 * 规矩。公开版不卖模型额度，模型只经平台网关 magpie：
 *
 * - 预设只有 `magpie`：目录只列它，从别的预设起草、保存、测连、拉模型列表一律
 *   答 `edition_public_magpie_only`；导入整个关掉（网关档案由网关页与订阅生成）。
 * - 订阅者的档案 `magpie-tenant-<租户>` 与「无模型」档案 `magpie-none` 随订阅
 *   管理：只有中枢自己的调用者（`ConsoleProviders.systemCaller`）能写、删、换
 *   密钥；订阅者的档案不能设为默认，也不能指派给别的租户或平台的节点。
 * - 租户的节点只持有本租户的档案或「无模型」：这条在期望状态上强制
 *   （`ConsoleProviders.configureScope`），跟随默认、停止托管、别人的档案一律
 *   算作「无模型」，任务分工只带它跑的那份档案，测连、拉模型列表与 dry-run 也
 *   不把别的档案发给它。指派只收本租户档案（不超过套餐含的节点数）或「无模型」；
 *   停止托管会留下节点上次拿到的密钥，所以不收。有租户节点时，全局默认只能清空
 *   或设为「无模型」。平台的节点不持有订阅者的档案。
 *
 * 读与节点上的其余操作原样转交。
 */

import type {
  ProviderAssignment,
  ProviderCaller,
  ProviderCandidate,
  ProviderPort,
  ProviderResult,
  TenantPort,
} from '@qianmo/console'
import { magpieProfileId, NO_MODEL_PROFILE } from './consoleMagpie.js'
import type { ProviderNodeScope } from './consoleProviders.js'

const MAGPIE_PRESET = 'magpie'
const TENANT_PROFILE = /^magpie-tenant-/

export interface PublicProvidersOptions {
  readonly tenancy: TenantPort
  /** Whether `caller` is the hub's own (`ConsoleProviders.isSystemCaller`). */
  readonly isSystem: (caller: ProviderCaller) => boolean
  /** How many nodes a tenant's plan includes; 0 without an active subscription. */
  readonly allowance: (tenant: string) => number
}

function refused<T>(message: string): ProviderResult<T> {
  return {
    ok: false,
    failure: { code: 'edition_public_magpie_only', message },
  }
}

const MAGPIE_ONLY = '公开版的模型只经平台网关 · 预设只能是 magpie'
const SUBSCRIPTION_PROFILE = '订阅者的网关档案随订阅管理'

/** A draft is an open record until the service parses it. */
function field(draft: Readonly<Record<string, unknown>>, name: string): string {
  const value = draft[name]
  return typeof value === 'string' ? value : ''
}

function candidatePreset(candidate: ProviderCandidate): string | 'saved' {
  return 'draft' in candidate ? field(candidate.draft, 'presetId') : 'saved'
}

/** The profile a candidate would send, by id (a draft takes the stored key of its id). */
function candidateProfile(candidate: ProviderCandidate): string {
  return 'draft' in candidate
    ? field(candidate.draft, 'id')
    : candidate.profileId
}

/** A platform node: anything but a subscriber's profile, the book decides the rest. */
const PLATFORM_SCOPE: ProviderNodeScope = {
  allows: id => !TENANT_PROFILE.test(id),
  fallback: null,
  extras: true,
}

/** The model service as the wrapper needs it: a port that can be scoped. */
export type ScopedProviderPort = ProviderPort & {
  configureScope?(source: (node: string) => ProviderNodeScope | null): void
}

/**
 * Wrap the model service with the public edition's rules (module note). The
 * scope goes onto `inner` itself, so its own applies keep to it too.
 */
export function publicProviders(
  inner: ScopedProviderPort,
  options: PublicProvidersOptions,
): ProviderPort {
  const subscriptionWrite = (profileId: string, caller: ProviderCaller) =>
    (TENANT_PROFILE.test(profileId) || profileId === NO_MODEL_PROFILE) &&
    !options.isSystem(caller)
  const draftRefused = (candidate: ProviderCandidate): boolean => {
    const preset = candidatePreset(candidate)
    return preset !== 'saved' && preset !== MAGPIE_PRESET
  }
  // The model service asks once per node and more than once per node in one
  // overview; one read of the tenancy file serves a synchronous run of them
  // and is dropped at the next microtask, so no answer outlives an `await`.
  let mapped: ReadonlyMap<string, string> | null = null
  /** Throws when the tenancy file cannot be read. */
  const tenantOfNow = (node: string): string | null => {
    if (mapped === null) {
      const rows = options.tenancy.read().config.nodes
      mapped = new Map(rows.map(row => [row.nodeId, row.tenant]))
      queueMicrotask(() => {
        mapped = null
      })
    }
    return mapped.get(node) ?? null
  }
  const tenantOf = (node: string): string | null | undefined => {
    try {
      return tenantOfNow(node)
    } catch {
      return undefined
    }
  }
  const scopeOf = (node: string): ProviderNodeScope => {
    const tenant = tenantOfNow(node)
    if (tenant === null) return PLATFORM_SCOPE
    const own = magpieProfileId({ kind: 'tenant', id: tenant })
    return {
      allows: id => id === own || id === NO_MODEL_PROFILE,
      fallback: NO_MODEL_PROFILE,
      extras: false,
    }
  }
  inner.configureScope?.(scopeOf)
  /** A candidate the node may not hold, refused before anything is sent. */
  const sendRefused = (
    node: string,
    candidate: ProviderCandidate,
  ): ProviderResult<never> | null => {
    let scope: ProviderNodeScope
    try {
      scope = scopeOf(node)
    } catch {
      return {
        ok: false,
        failure: { code: 'unavailable', message: '租户配置不可用' },
      }
    }
    if (scope.allows(candidateProfile(candidate))) return null
    return refused(
      scope === PLATFORM_SCOPE
        ? '订阅者的网关档案只发到它自己租户的节点'
        : '这份档案不能发到这个节点 · 租户的节点只收本租户的档案',
    )
  }
  return {
    overview: () => inner.overview(),
    profile: id => inner.profile(id),
    catalog() {
      const catalog = inner.catalog()
      const presets = catalog.presets.filter(one => one.id === MAGPIE_PRESET)
      return {
        groups: catalog.groups.filter(group =>
          presets.some(one => one.group === group),
        ),
        presets,
      }
    },
    draftFromPreset(input) {
      return input.presetId === MAGPIE_PRESET
        ? inner.draftFromPreset(input)
        : refused(MAGPIE_ONLY)
    },
    async preview(input) {
      return draftRefused(input.candidate)
        ? refused(MAGPIE_ONLY)
        : inner.preview(input)
    },
    node: node => inner.node(node),
    refreshNode: node => inner.refreshNode(node),
    exportProfiles: ids => inner.exportProfiles(ids),
    importPreview: text => inner.importPreview(text),
    async models(input, caller) {
      if (input.candidate === undefined) return inner.models(input, caller)
      if (draftRefused(input.candidate)) return refused(MAGPIE_ONLY)
      return (
        sendRefused(input.node, input.candidate) ?? inner.models(input, caller)
      )
    },
    async saveProfile(input, caller) {
      if (field(input.profile, 'presetId') !== MAGPIE_PRESET)
        return refused(MAGPIE_ONLY)
      if (subscriptionWrite(field(input.profile, 'id'), caller))
        return refused(SUBSCRIPTION_PROFILE)
      return inner.saveProfile(input, caller)
    },
    async deleteProfile(input, caller) {
      return subscriptionWrite(input.profileId, caller)
        ? refused(SUBSCRIPTION_PROFILE)
        : inner.deleteProfile(input, caller)
    },
    async setSecret(input, caller) {
      return subscriptionWrite(input.profileId, caller)
        ? refused(SUBSCRIPTION_PROFILE)
        : inner.setSecret(input, caller)
    },
    async clearSecret(input, caller) {
      return subscriptionWrite(input.profileId, caller)
        ? refused(SUBSCRIPTION_PROFILE)
        : inner.clearSecret(input, caller)
    },
    async setDefault(input, caller) {
      const profileId = input.profileId
      if (profileId !== null && TENANT_PROFILE.test(profileId))
        return refused('订阅者的网关档案不能设为默认')
      if (profileId !== null && profileId !== NO_MODEL_PROFILE) {
        let tenantNodes: number
        try {
          tenantNodes = options.tenancy.read().config.nodes.length
        } catch {
          return {
            ok: false,
            failure: { code: 'unavailable', message: '租户配置不可用' },
          }
        }
        if (tenantNodes > 0)
          return refused(
            '有租户节点时默认只能清空或设为无模型 · 平台节点逐台指定档案',
          )
      }
      return inner.setDefault(input, caller)
    },
    async assign(input, caller) {
      const tenant = tenantOf(input.node)
      if (tenant === undefined)
        return {
          ok: false,
          failure: { code: 'unavailable', message: '租户配置不可用' },
        }
      const assignment: ProviderAssignment = input.assignment
      if (tenant === null) {
        return assignment.mode === 'profile' &&
          TENANT_PROFILE.test(assignment.profileId)
          ? refused('订阅者的网关档案只给它自己租户的节点')
          : inner.assign(input, caller)
      }
      if (
        assignment.mode === 'profile' &&
        assignment.profileId === NO_MODEL_PROFILE
      )
        return inner.assign(input, caller)
      const own = magpieProfileId({ kind: 'tenant', id: tenant })
      if (assignment.mode !== 'profile' || assignment.profileId !== own)
        return refused(
          `租户的节点只能用本租户的网关档案 ${own} 或无模型 ${NO_MODEL_PROFILE}`,
        )
      const overview = await inner.overview()
      if (!overview.ok) return overview
      const others = overview.value.nodes.filter(
        row =>
          row.node !== input.node &&
          row.assignment.mode === 'profile' &&
          row.assignment.profileId === own,
      ).length
      const allowed = options.allowance(tenant)
      if (others >= allowed)
        return {
          ok: false,
          failure: {
            code: 'invalid',
            message: `套餐含 ${allowed} 台节点 · 已有 ${others} 台在用`,
          },
        }
      return inner.assign(input, caller)
    },
    setContextOverride: (input, caller) =>
      inner.setContextOverride(input, caller),
    apply: (input, caller) => inner.apply(input, caller),
    async probe(input, caller) {
      if (draftRefused(input.candidate)) return refused(MAGPIE_ONLY)
      return (
        sendRefused(input.node, input.candidate) ?? inner.probe(input, caller)
      )
    },
    autocompact: (input, caller) => inner.autocompact(input, caller),
    async importProfiles() {
      return refused('公开版不导入档案 · 网关档案由网关页与订阅生成')
    },
  }
}
