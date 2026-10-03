// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The optional prompt-cache fields of a generic `/responses` request
 * (P18.19, design `providers-console-m1.md` §5.11.5):
 *
 * - **CH-5 `prompt_cache_retention`** — sent only when asked for
 *   (`OPENAI_PROMPT_CACHE_RETENTION=in_memory|24h`), or by default to a host
 *   whose own default retention is short: `api.meta.ai` gets `24h`, as in
 *   hermes. OpenAI documents the field for models before GPT-5.6; from 5.6 on
 *   retention is `prompt_cache_options.ttl` and `30m` is the default. Whether
 *   the fleet's gateway passes it through is unverified, hence off by default.
 * - **CH-6 `prompt_cache_options.comparison_response_id`** — with
 *   `OPENAI_PROMPT_CACHE_DIAGNOSTICS=1`, every request after the first names
 *   the previous response, and the reply carries `prompt_cache_diagnostics`
 *   saying why a prefix was not reused (`responseRecord.ts` stores it).
 *   GPT-5.6+ only, per OpenAI's diagnostics guide.
 *
 * Both are dropped and latched for the rest of the process the first time an
 * endpoint rejects them, the same way `prompt_cache_key` is: the retry happens
 * on the refused HTTP request, before anything has streamed.
 *
 * Sources (fetched 2026-10-03, no credentials):
 *   https://developers.openai.com/api/docs/guides/prompt-caching.md
 *   https://developers.openai.com/api/docs/guides/prompt-caching/diagnostics.md
 * hermes `agent/transports/codex.py:114-124` (`f9b29c49b6`) for the Meta host.
 */
import { isEnvTruthy } from '../../../utils/config/envUtils.js'
import { errorMessageTexts } from '../modelCompat/errorMessages.js'
import { isUnsupportedParameterText } from '../modelCompat/unsupportedParam.js'
import { previousResponseId } from './responseRecord.js'

export type PromptCacheRetention = 'in_memory' | '24h'

/** Hosts whose retention is raised without being asked (hermes's table). */
const DEFAULT_RETENTION_BY_HOST: Readonly<
  Record<string, PromptCacheRetention>
> = {
  'api.meta.ai': '24h',
}

const OFF = new Set(['0', 'off', 'false', 'no', 'none'])

let retentionRejected = false
let optionsRejected = false

function hostOf(baseURL: string | undefined): string | undefined {
  if (!baseURL?.trim()) return undefined
  try {
    return new URL(baseURL).hostname.toLowerCase()
  } catch {
    return undefined
  }
}

/** The `prompt_cache_retention` a generic `/responses` request carries, if any. */
export function resolvePromptCacheRetention(
  baseURL: string | undefined,
): PromptCacheRetention | undefined {
  if (retentionRejected) return undefined
  const raw = process.env.OPENAI_PROMPT_CACHE_RETENTION?.trim().toLowerCase()
  if (raw !== undefined && raw !== '') {
    if (OFF.has(raw)) return undefined
    if (raw === 'in_memory' || raw === '24h') return raw
    return undefined
  }
  const host = hostOf(baseURL)
  return host === undefined ? undefined : DEFAULT_RETENTION_BY_HOST[host]
}

export function isPromptCacheDiagnosticsEnabled(): boolean {
  return isEnvTruthy(process.env.OPENAI_PROMPT_CACHE_DIAGNOSTICS)
}

/**
 * `prompt_cache_options` for this request: a comparison against the previous
 * response when diagnostics are on and there is one.
 */
export function resolvePromptCacheOptions(
  messages: readonly unknown[],
): { comparison_response_id: string } | undefined {
  if (optionsRejected || !isPromptCacheDiagnosticsEnabled()) return undefined
  const id = previousResponseId(messages)
  return id === undefined ? undefined : { comparison_response_id: id }
}

/** Markers on top of the shared list: OpenAI words value errors this way. */
const REJECTION_MARKERS: readonly string[] = [
  'unsupported parameter',
  'unsupported_parameter',
  'not supported',
  'does not support',
  'unknown parameter',
  'unrecognized request argument',
  'unrecognized parameter',
  'invalid parameter',
  'unsupported value',
  'invalid value',
]

function rejects(error: unknown, param: string): boolean {
  return errorMessageTexts(error).some(text =>
    isUnsupportedParameterText(text, param, REJECTION_MARKERS),
  )
}

type WithExtras = {
  prompt_cache_retention?: string
  prompt_cache_options?: Record<string, unknown>
}

/**
 * If `error` is the endpoint refusing one of these fields that `request`
 * carries: latch it off and return the request without it, with the retry
 * tag the caller hands its retry ladder (one per field, so each is dropped at
 * most once). Otherwise `undefined`.
 */
export function dropRejectedPromptCacheExtra<T extends WithExtras>(
  request: T,
  error: unknown,
): { request: T; transform: string } | undefined {
  if (
    request.prompt_cache_retention !== undefined &&
    rejects(error, 'prompt_cache_retention')
  ) {
    retentionRejected = true
    const { prompt_cache_retention: _dropped, ...rest } = request
    return { request: rest as T, transform: 'retry:prompt-cache-retention' }
  }
  if (
    request.prompt_cache_options !== undefined &&
    rejects(error, 'prompt_cache_options')
  ) {
    optionsRejected = true
    const { prompt_cache_options: _dropped, ...rest } = request
    return { request: rest as T, transform: 'retry:prompt-cache-options' }
  }
  return undefined
}

/** Test seam. */
export function resetPromptCacheExtrasForTesting(): void {
  retentionRejected = false
  optionsRejected = false
}
