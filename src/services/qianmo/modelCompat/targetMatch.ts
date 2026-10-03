// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * "Which endpoint and which model is this request for", as the P18.8 rule
 * tables ask it (`reasoningEcho.ts`, `effortVendors.ts`).
 *
 * Host rule: the exact hostname or a dot-suffix subdomain of it — never a
 * substring, so `evil.example/moonshot.ai` and `moonshot.ai.evil` do not
 * match `moonshot.ai`. Same rule as hermes `utils.py:906-924`
 * (`base_url_host_matches`), and the one P18.5's tables apply privately
 * (`wireHosts.ts`, `outputTokenDefault.ts`, `samplingParams.ts`).
 *
 * An unset base URL is the OpenAI SDK's default, `api.openai.com`.
 *
 * 规则来源 NousResearch/hermes-agent（MIT，Copyright (c) 2025 Nous Research，
 * 声明见 NOTICE 五），取于 `f9b29c49b6`（2026-10-03 取用）：`utils.py:906-924`
 * `base_url_host_matches` — exact host or a dot-suffix subdomain. Only the
 * rule is taken; the code is ours.
 */

const SDK_DEFAULT_HOST = 'api.openai.com'

/** Lower-cased hostname of `baseURL`; a missing scheme is tolerated. */
function targetHostname(baseURL: string | undefined): string | undefined {
  const trimmed = baseURL?.trim()
  if (!trimmed) return SDK_DEFAULT_HOST
  try {
    const raw = trimmed.includes('://') ? trimmed : `//${trimmed}`
    const host = new URL(raw, 'https://placeholder.invalid').hostname
    return host.toLowerCase().replace(/\.$/, '') || undefined
  } catch {
    return undefined
  }
}

/** Whether `baseURL`'s host is one of `domains` or a subdomain of one. */
export function targetHostIs(
  baseURL: string | undefined,
  domains: readonly string[],
): boolean {
  const host = targetHostname(baseURL)
  if (!host) return false
  return domains.some(domain => host === domain || host.endsWith(`.${domain}`))
}

/** Lower-cased model id after an OpenRouter-style `vendor/` prefix. */
export function bareModelId(model: string): string {
  const lower = model.trim().toLowerCase()
  const slash = lower.lastIndexOf('/')
  return slash === -1 ? lower : lower.slice(slash + 1)
}
