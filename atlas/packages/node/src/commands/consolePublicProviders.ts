// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 公开版的模型服务（P35，`--billing`）：同一个 `ConsoleProviders`，外面多一层
 * 规矩。公开版不卖模型额度，模型只经平台网关 magpie：
 *
 * - 预设只有 `magpie`：目录只列它，从别的预设起草、保存、测连、拉模型列表一律
 *   答 `edition_public_magpie_only`；导入整个关掉（网关档案由网关页与订阅生成）。
 * - 订阅者的档案 `magpie-tenant-<租户>` 随订阅管理：只有中枢自己的调用者
 *   （`ConsoleProviders.systemCaller`）能写、删、换密钥；它不能设为默认，也不能
 *   指派给别的租户或平台的节点。
 * - 租户的节点只能用本租户的档案，或停止托管；不能继承平台默认（那等于把平台的
 *   模型给了租户）。指派本租户档案的节点数不超过套餐含的节点数。
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
import { magpieProfileId } from './consoleMagpie.js'

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

/** Wrap the model service with the public edition's rules (module note). */
export function publicProviders(
  inner: ProviderPort,
  options: PublicProvidersOptions,
): ProviderPort {
  const subscriptionWrite = (profileId: string, caller: ProviderCaller) =>
    TENANT_PROFILE.test(profileId) && !options.isSystem(caller)
  const draftRefused = (candidate: ProviderCandidate): boolean => {
    const preset = candidatePreset(candidate)
    return preset !== 'saved' && preset !== MAGPIE_PRESET
  }
  const tenantOf = (node: string): string | null | undefined => {
    try {
      return (
        options.tenancy.read().config.nodes.find(row => row.nodeId === node)
          ?.tenant ?? null
      )
    } catch {
      return undefined
    }
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
      return input.candidate !== undefined && draftRefused(input.candidate)
        ? refused(MAGPIE_ONLY)
        : inner.models(input, caller)
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
      return input.profileId !== null && TENANT_PROFILE.test(input.profileId)
        ? refused('订阅者的网关档案不能设为默认')
        : inner.setDefault(input, caller)
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
      if (assignment.mode === 'unmanaged') return inner.assign(input, caller)
      const own = magpieProfileId({ kind: 'tenant', id: tenant })
      if (assignment.mode !== 'profile' || assignment.profileId !== own)
        return refused(`租户的节点只能用本租户的网关档案 ${own}`)
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
      return draftRefused(input.candidate)
        ? refused(MAGPIE_ONLY)
        : inner.probe(input, caller)
    },
    autocompact: (input, caller) => inner.autocompact(input, caller),
    async importProfiles() {
      return refused('公开版不导入档案 · 网关档案由网关页与订阅生成')
    },
  }
}
