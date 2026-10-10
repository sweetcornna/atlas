// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Pure compiler for omp models.yml and config.yml. Credentials never enter argv. */
import { createHash } from 'node:crypto'
import { isRuntimeEnvironmentName } from './whitelist.js'
import {
  checkModelEffort,
  clampSharedEffortDown,
  compiledEffortLevel,
  checkCompatValue,
  isCompatKey,
  isOmpCompatField,
  primaryKey,
  resolveBaseUrl,
  type EffortLevel,
  type Lane,
  type NodeCapabilities,
  type ProviderIssue,
  type ProviderModel,
  type WireProfile,
} from '@qianmo/providers'

export const LANE_API = {
  anthropic: 'anthropic-messages',
  'openai-chat': 'openai-completions',
  'openai-responses': 'openai-responses',
  gemini: 'google-generative-ai',
  grok: 'openai-completions',
} as const
export type OmpModel = {
  id: string
  name: string
  reasoning?: boolean
  thinking?: {
    mode: 'effort' | 'budget' | 'anthropic-adaptive' | 'google-level'
    efforts: readonly string[]
  }
  compat: Record<string, string | number | boolean>
  contextWindow: number
  maxTokens: number
}
export type OmpProvider = {
  baseUrl: string
  api: string
  auth: 'apiKey' | 'none'
  apiKey?: string
  authHeader?: boolean
  headers?: Record<string, string>
  disableStrictTools?: boolean
  models: OmpModel[]
}
export type CompiledProfile = {
  models: { providers: Record<string, OmpProvider> }
  config: {
    modelRoles: Record<string, string>
    defaultThinkingLevel: string
    providers: { cacheRetention: string; cacheWarming: 'off' }
    retry: {
      enabled: boolean
      maxRetries: number
      baseDelayMs: number
      maxDelayMs: number
      fallbackChains: Record<string, never>
    }
  }
  providerId: string
  selection: { provider: string; modelId: string; thinkingLevel: string }
  route: 'direct'
  effectiveLane: Lane
  keyId: string
}
export type CompileResult =
  | { ok: true; compiled: CompiledProfile }
  | { ok: false; error: ProviderIssue }

function thinkingLevel(
  model: ProviderModel,
  lock?: EffortLevel | null,
): string {
  if (model.effort.send === 'never') return 'off'
  return lock ?? compiledEffortLevel(model.effort) ?? 'medium'
}
export function compileProfile(
  profile: WireProfile,
  options: { secret: string; capabilities: NodeCapabilities },
): CompileResult {
  const fail = (path: string, message: string): CompileResult => ({
    ok: false,
    error: { code: 'bad-value', path, message },
  })
  if (profile.auth.keys.length > 1 && !options.capabilities.multiKey) {
    return {
      ok: false,
      error: {
        code: 'unsupported-multi-key',
        path: 'profile.auth.keys',
        message: '此节点不支持 omp 凭据池',
      },
    }
  }
  if (options.secret.startsWith('!'))
    return fail('profile.auth.keys', '密钥不能使用 omp 命令求值语法')
  if (isRuntimeEnvironmentName(options.secret))
    return fail('profile.auth.keys', '密钥不能引用运行期环境变量名称')
  const resolved = resolveBaseUrl(profile.baseUrl, profile.templateValues)
  if (!resolved.ok) return fail('profile.baseUrl', resolved.message)
  if (
    profile.lane === 'anthropic' &&
    profile.auth.scheme === 'x-api-key' &&
    profile.auth.keys.length > 1 &&
    new URL(resolved.url).hostname !== 'api.anthropic.com'
  )
    return {
      ok: false,
      error: {
        code: 'unsupported-multi-key',
        path: 'profile.auth.keys',
        message:
          'omp 自定义 Anthropic 端点的凭据池使用 bearer；x-api-key 池仅支持官方端点',
      },
    }
  const main = profile.models.find(model => model.role === 'main')
  if (!main) return fail('profile.models', '缺少主模型')
  for (const [i, model] of profile.models.entries()) {
    const issue = checkModelEffort(
      model,
      profile.lane,
      `profile.models.${i}`,
      options.capabilities,
    )
    if (issue) return { ok: false, error: issue }
  }
  const compat: Record<string, string | number | boolean> = {
    statefulResponses: false,
  }
  for (const [key, value] of Object.entries(profile.compat ?? {})) {
    if (value === undefined) continue
    if (!isCompatKey(key))
      return {
        ok: false,
        error: {
          code: 'unknown-key',
          path: `profile.compat.${key}`,
          message: '不支持的 omp 兼容键',
        },
      }
    if (key.startsWith('headers.') && isRuntimeEnvironmentName(value))
      return fail(`profile.compat.${key}`, '请求头不能引用运行期环境变量名称')
    const problem = checkCompatValue(key, value)
    if (problem) return fail(`profile.compat.${key}`, problem)
    if (isOmpCompatField(key))
      compat[key] =
        value === 'true'
          ? true
          : value === 'false'
            ? false
            : key.endsWith('Ms')
              ? Number(value)
              : value
  }
  let locked: EffortLevel | null | undefined = profile.effortLock
  if (locked) {
    locked = clampSharedEffortDown(
      locked,
      profile.models
        .filter(m => m.effort.send !== 'never')
        .flatMap(m => (m.effort.levels ? [m.effort.levels] : [])),
    )
    if (!locked)
      return fail('profile.effortLock', '锁定档位不在模型共享的可用档位内')
  }
  const providerId = `qm-${profile.id}-${createHash('sha256').update(resolved.url).digest('hex').slice(0, 8)}`
  const models: OmpModel[] = profile.models.map(model => {
    const inferFamily =
      model.capabilities.mode === 'family' && model.effort.send === 'auto'
    const reasoning =
      model.effort.send !== 'never' &&
      (model.effort.send === 'always' ||
        (model.capabilities.mode === 'explicit' && model.capabilities.thinking))
    const contextWindow = model.contextTokens ?? 200_000
    const maxTokens = Math.min(
      model.maxOutputTokens ?? Number(profile.compat?.maxTokens ?? 32_000),
      contextWindow,
    )
    const mode =
      profile.lane === 'anthropic'
        ? model.capabilities.mode === 'explicit' &&
          !model.capabilities.adaptive_thinking
          ? 'budget'
          : 'anthropic-adaptive'
        : profile.lane === 'gemini'
          ? 'google-level'
          : 'effort'
    return {
      id: model.id,
      name: model.id,
      ...(inferFamily ? {} : { reasoning }),
      ...(reasoning
        ? {
            thinking: {
              mode,
              efforts: model.effort.levels ?? ['low', 'medium', 'high'],
            },
          }
        : {}),
      compat: { ...compat },
      contextWindow,
      maxTokens,
    }
  })
  const selector = (m: ProviderModel) =>
    `${providerId}/${m.id}:${thinkingLevel(m, locked)}`
  const fast = profile.models.find(m => m.role === 'fast') ?? main
  const customHeaderAuth =
    profile.lane === 'anthropic' &&
    profile.auth.scheme === 'x-api-key' &&
    new URL(resolved.url).hostname !== 'api.anthropic.com'
  const provider: OmpProvider = {
    baseUrl: resolved.url,
    api: LANE_API[profile.lane],
    // auth:none suppresses the loader inline-key requirement. Native stored
    // API-key credentials precede its keyless fallback; no OAuth shaping is enabled.
    auth: profile.auth.keys.length > 1 || customHeaderAuth ? 'none' : 'apiKey',
    ...(profile.auth.keys.length === 1 && !customHeaderAuth
      ? { apiKey: options.secret }
      : {}),
    ...(profile.lane === 'anthropic' && profile.auth.scheme === 'bearer'
      ? { authHeader: true }
      : {}),
    ...(profile.compat?.disableStrictTools
      ? { disableStrictTools: profile.compat.disableStrictTools === 'true' }
      : {}),
    headers: {
      ...(customHeaderAuth ? { 'X-Api-Key': options.secret } : {}),
      ...(profile.compat?.['headers.anthropic-workspace-id']
        ? {
            'anthropic-workspace-id':
              profile.compat['headers.anthropic-workspace-id'],
          }
        : {}),
    },
    models,
  }
  return {
    ok: true,
    compiled: {
      models: { providers: { [providerId]: provider } },
      config: {
        modelRoles: {
          default: selector(main),
          smol: selector(fast),
          plan: selector(main),
          slow: selector(main),
          commit: selector(fast),
        },
        defaultThinkingLevel: thinkingLevel(main, locked),
        providers: {
          cacheRetention: profile.compat?.cacheRetention ?? 'auto',
          cacheWarming: 'off',
        },
        retry: {
          enabled: true,
          maxRetries: 3,
          baseDelayMs: 500,
          maxDelayMs: 60_000,
          fallbackChains: {},
        },
      },
      providerId,
      selection: {
        provider: providerId,
        modelId: main.id,
        thinkingLevel: thinkingLevel(main, locked),
      },
      route: 'direct',
      effectiveLane: profile.lane,
      keyId: primaryKey(profile.auth.keys).id,
    },
  }
}
