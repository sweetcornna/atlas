// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Model fallback on the third-party lanes (P18.12, hermes #1; design
 * `providers-console-m1.md` §5.6 row 1).
 *
 * Before: `--fallback-model` / `fallbackModels` only ever engaged on the
 * Anthropic lane. `query.ts` switches models when the call throws
 * `FallbackTriggeredError`, and only `withRetry.ts` throws it; the OpenAI,
 * Grok and Gemini lanes run their own ladder (`retryThirdPartyEventStream`)
 * and turned every give-up into an error message. A configured fallback was
 * never tried on those lanes.
 *
 * Now the ladder asks here when it gives up, and throws what this returns:
 *   - `exhausted` — the retries for an HTTP 5xx are spent (`server_error`;
 *     `overloaded` for 529);
 *   - `refused` — a failure no retry changes, when it is about the model:
 *     the model does not exist (`model_not_found`), or the account may not
 *     use it (`permission_denied`: 403 naming the model, or a
 *     `model_disabled` code such as OpenCode's
 *     `managed_inference_model_disabled`).
 * Account-level failures (bad key, no balance, rate limit), bad requests and
 * context overflow are not reasons: another model reproduces them.
 *
 * Only when nothing reached the reader (commitment `none`) and the error is
 * replayable — the barrier every other re-send of the ladder obeys. The
 * fallback request is built from scratch by the lane with the new model, so
 * the history goes through the send-boundary replay policy for the fallback
 * target (`reasoningEcho.ts`) before it is sent.
 *
 * 规则来源 NousResearch/hermes-agent（MIT，Copyright (c) 2025 Nous Research，
 * 声明见 NOTICE 五），取于 `f9b29c49b6`（2026-10-03 取用）：
 *   - `agent/error_classifier.py:359-377` `_MODEL_NOT_FOUND_PATTERNS` — the
 *     "model does not exist" wording, `should_fallback=True` at `:1222-1226`;
 *   - `:1212-1220`, `:479-483` — an OpenRouter data-policy 404 is NOT a
 *     missing model and does not fall back ("same account setting applies");
 *   - `:1325-1365` — 5xx is `server_error`, 503/529 `overloaded`, retried
 *     before the chain moves on.
 * hermes also falls back on auth, billing and rate limits, across providers;
 * here the fallback is another model on the same endpoint and credential
 * (`--fallback-model`), so those are left out (design §5.6 row 1). Only the
 * rules are taken; the code is ours, and the reasons are the ones
 * `withRetry.ts` already reports (`modelFallbackReason`).
 */
import { FallbackTriggeredError } from 'src/services/api/withRetry.js'
import { errorRecords, httpStatus, lowerStrings } from './errorRecords.js'

/** The model this request is for, and the fallback `query.ts` armed it with. */
export type ThirdPartyFallbackTarget = {
  model: string
  fallbackModel: string | undefined
}

/** Where the ladder gave up. */
export type FallbackStage = 'exhausted' | 'refused'

type Reason = FallbackTriggeredError['reason']

const NAMES_A_MODEL = /\bmodels?\b/i

/** hermes `_MODEL_NOT_FOUND_PATTERNS`, lower-cased substrings. */
const MODEL_NOT_FOUND_TEXT = [
  'is not a valid model',
  'invalid model',
  'model not found',
  'model_not_found',
  'does not exist',
  'no such model',
  'unknown model',
  'unsupported model',
  'no endpoints found that support tool use',
]

/** hermes `_PROVIDER_POLICY_BLOCKED_PATTERNS`: the account, not the model. */
const POLICY_BLOCKED_TEXT = [
  'no endpoints available matching your guardrail',
  'no endpoints available matching your data policy',
  'no endpoints found matching your data policy',
]

function refusedReason(
  status: number | undefined,
  records: readonly Record<string, unknown>[],
): Reason | undefined {
  const codes = lowerStrings(records, ['code', 'type'])
  const messages = lowerStrings(records, ['message'])
  const says = (phrases: readonly string[]) =>
    messages.some(message => phrases.some(phrase => message.includes(phrase)))
  if (says(POLICY_BLOCKED_TEXT)) return undefined
  const namesModel = messages.some(message => NAMES_A_MODEL.test(message))
  if (
    codes.some(code => code.includes('model_disabled')) ||
    (status === 403 && namesModel)
  ) {
    return 'permission_denied'
  }
  if (
    // `ModelError`: OpenCode's gateway for an id it does not serve
    // (retryClassification.ts, MODEL_?ERROR).
    codes.some(
      code => code.includes('model_not_found') || code === 'modelerror',
    ) ||
    (status === 404 && namesModel) ||
    says(MODEL_NOT_FOUND_TEXT)
  ) {
    return 'model_not_found'
  }
  return undefined
}

/**
 * The `FallbackTriggeredError` to throw instead of `error`, or `undefined`
 * when there is no fallback to switch to or `error` is not a reason to.
 * The caller has already checked the commitment barrier.
 */
export function thirdPartyFallback(
  error: unknown,
  target: ThirdPartyFallbackTarget | undefined,
  stage: FallbackStage,
): FallbackTriggeredError | undefined {
  const fallbackModel = target?.fallbackModel
  if (!target || !fallbackModel || fallbackModel === target.model) {
    return undefined
  }
  const records = errorRecords(error)
  const status = httpStatus(records)
  const reason: Reason | undefined =
    stage === 'exhausted'
      ? status !== undefined && status >= 500
        ? status === 503 || status === 529
          ? 'overloaded'
          : 'server_error'
        : undefined
      : refusedReason(status, records)
  return reason
    ? new FallbackTriggeredError(target.model, fallbackModel, reason, error)
    : undefined
}
