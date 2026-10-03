// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Which endpoints get the previous turns' reasoning back on the Chat
 * Completions lane, decided by the TARGET endpoint (P18.8, hermes #4; design
 * `providers-console-m1.md` §5.4 「回放」, §5.6 row 4).
 *
 * Before: `anthropicMessagesToOpenAI` turned every thinking block into
 * `reasoning_content` whatever the request was for, and back-filled `''` on
 * tool-calling turns only when thinking was auto-detected for a deepseek /
 * mimo name. Two consequences (hermes-research §11.9-①):
 *   E — a strict endpoint (Mistral, Cerebras, Groq, SambaNova, …) got the
 *       key from history written by another vendor and rejects the request
 *       ("Extra inputs are not permitted");
 *   F — Kimi, which rejects a replayed assistant turn WITHOUT the key, got
 *       none: thinking is never auto-detected for kimi names. A relay that
 *       forwards the body to Moonshot unchanged hits the same 400 on
 *       multi-turn tool calls (the 2026-10-03 ruling's premise; not checked
 *       against a real relay).
 *
 * Now the converted messages are reconciled against the endpoint the request
 * is actually going to, right before the body is built (`requestBody.ts`) —
 * the send boundary, where hermes does the same pass.
 *
 * 规则来源 NousResearch/hermes-agent（MIT，Copyright (c) 2025 Nous Research，
 * 声明见 NOTICE 五），取于 `f9b29c49b6`（2026-10-03 取用）：
 *   - `agent/message_sanitization.py:630-664` — the direction table
 *     `_REASONING_ECHO_RULES`: kimi (hosts `api.kimi.com`, `moonshot.ai`,
 *     `moonshot.cn`), deepseek (model contains `deepseek`, host
 *     `api.deepseek.com`), mimo (model contains `mimo`, hosts
 *     `api.xiaomimimo.com`, `xiaomimimo.com`); every other endpoint is the
 *     strict side and gets the key stripped, even `""` or `" "`;
 *   - `:674-707` — membership is per family, first match in table order wins;
 *     `run_agent.py:7765-7783` — kimi is matched on the host only, never the
 *     model name ("aggregators like OpenRouter that re-export Kimi/Moonshot
 *     models … reject reasoning_content echoes");
 *   - `:714-802` `apply_reasoning_content_policy` and `:805-850`
 *     `reapply_reasoning_echo` — on the require side an existing value is
 *     kept, `""` becomes `" "`, a missing or non-string value becomes `" "`,
 *     on every assistant turn;
 *   - `utils.py:906-924` — host matching (exact or subdomain).
 * hermes keys families on its provider id as well; Qianmo has no provider id
 * on this lane, only `OPENAI_BASE_URL`, so the host stands in for it. Only the
 * facts are taken; the code is ours.
 *
 * Qianmo differences, on purpose (P18.8 audit ruling, 2026-10-03):
 *   - three kinds of host. A family's own host decides by itself, as in
 *     hermes. A known strict vendor (`STRICT_VENDOR_HOSTS`: OpenAI official —
 *     also the unset default —, OpenRouter, Mistral, Cerebras, Groq,
 *     SambaNova) gets the key stripped whatever the model is called; hermes
 *     would keep it there for a deepseek / mimo name (SambaNova's or Groq's
 *     DeepSeek models, deepseek on OpenRouter). Any other host — a relay or
 *     gateway such as `api.cornna.xyz`, which usually forwards the body to
 *     the original vendor as is — is decided by the model family: deepseek /
 *     mimo by substring as in hermes, and kimi by `isKimiModel` (hermes
 *     `auxiliary_client.py:613-616`), where hermes matches kimi on the host
 *     only;
 *   - deepseek keeps Qianmo's own contract byte for byte: thinking blocks
 *     (including the empty one) are echoed as they are, and the `''`
 *     back-fill on tool-calling turns stays `''` and stays gated on thinking
 *     being on. hermes pads `" "` because "DeepSeek V4 Pro rejects empty
 *     string"; Qianmo's comment in `openaiConvertMessages.ts` says the
 *     opposite. Not settled against a real endpoint, so the design keeps `''`
 *     (design §5.4, §5.10; hermes-research §11.10 item 2);
 *   - the `" "` pad on kimi / mimo is what hermes sends; also not checked
 *     against a real endpoint (design §11 item 5).
 */
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions/completions.mjs'
import { isKimiModel } from './samplingParams.js'
import { targetHostIs } from './targetMatch.js'
import { replayThoughtSignatures } from './thoughtSignatureReplay.js'

type ReasoningEchoFamily = 'kimi' | 'deepseek' | 'mimo'

type EchoRule = {
  family: ReasoningEchoFamily
  /** Whether the model id names this family; counts on unknown hosts only. */
  namesFamily: (model: string) => boolean
  hosts: readonly string[]
}

/**
 * Hosts and order: hermes `message_sanitization.py:655-664`. The name tests
 * are hermes's for deepseek / mimo and Qianmo's for kimi (see the header).
 */
const REASONING_ECHO_RULES: readonly EchoRule[] = [
  {
    family: 'kimi',
    namesFamily: isKimiModel,
    hosts: ['api.kimi.com', 'moonshot.ai', 'moonshot.cn'],
  },
  {
    family: 'deepseek',
    namesFamily: model => model.toLowerCase().includes('deepseek'),
    hosts: ['api.deepseek.com'],
  },
  {
    family: 'mimo',
    namesFamily: model => model.toLowerCase().includes('mimo'),
    hosts: ['api.xiaomimimo.com', 'xiaomimimo.com'],
  },
]

/**
 * Vendors that serve other families' models through their own strict API:
 * no model name makes one of them a family endpoint. An unset base URL is
 * `api.openai.com` (`targetMatch.ts`).
 */
const STRICT_VENDOR_HOSTS = [
  'api.openai.com',
  'openrouter.ai',
  'mistral.ai',
  'cerebras.ai',
  'groq.com',
  'sambanova.ai',
]

/** Neither a strict vendor nor a family's own host: a relay or gateway. */
function isUnknownHost(baseURL: string | undefined): boolean {
  return (
    !targetHostIs(baseURL, STRICT_VENDOR_HOSTS) &&
    !REASONING_ECHO_RULES.some(rule => targetHostIs(baseURL, rule.hosts))
  )
}

function ruleMatches(
  rule: EchoRule,
  model: string,
  baseURL: string | undefined,
): boolean {
  if (targetHostIs(baseURL, rule.hosts)) return true
  return rule.namesFamily(model) && isUnknownHost(baseURL)
}

/** Single-space pad the require side gets (hermes `:788-798`). */
const REQUIRED_REASONING_PAD = ' '

/**
 * The family whose echo contract the request target enforces, or
 * `undefined` for the strict side (the key must not be sent at all).
 */
export function reasoningEchoFamily(
  model: string,
  baseURL: string | undefined,
): ReasoningEchoFamily | undefined {
  return REASONING_ECHO_RULES.find(rule => ruleMatches(rule, model, baseURL))
    ?.family
}

type AssistantParam = Extract<ChatCompletionMessageParam, { role: 'assistant' }>
type WithReasoning = AssistantParam & { reasoning_content?: unknown }

function replayAssistant(
  message: WithReasoning,
  family: ReasoningEchoFamily | undefined,
): WithReasoning {
  if (family === 'deepseek') return message
  const existing = message.reasoning_content
  if (family === undefined) {
    if (!('reasoning_content' in message)) return message
    const { reasoning_content: _stripped, ...rest } = message
    return rest
  }
  if (typeof existing === 'string' && existing !== '') return message
  return { ...message, reasoning_content: REQUIRED_REASONING_PAD }
}

/**
 * Reconcile the converted messages with the endpoint the request goes to:
 * `reasoning_content` by echo family (#4), and Gemini's tool-call signature
 * for Gemini-family targets (#10, `thoughtSignatureReplay.ts`).
 * Pure: returns a new array, and new objects only for the messages it
 * changed; `model` is the wire model id, `baseURL` the request's endpoint.
 */
export function applyReasoningReplayPolicy(
  messages: readonly ChatCompletionMessageParam[],
  target: { model: string; baseURL: string | undefined },
): ChatCompletionMessageParam[] {
  const family = reasoningEchoFamily(target.model, target.baseURL)
  return messages.map(message =>
    message.role === 'assistant'
      ? replayThoughtSignatures(replayAssistant(message, family), target.model)
      : message,
  )
}

/**
 * True since P18.8, reported as `capabilities.replayFilter`: on the OpenAI
 * lane, reasoning in history is filtered by the target endpoint before it is
 * sent — chat `reasoning_content` here (#4), Gemini tool-call signatures only
 * to Gemini-family targets (#10), Responses `encrypted_content` by issuer
 * (#23, `responsesIssuer.ts`). Pinned by behavioural tests
 * (`capabilities.test.ts`), not only by this constant.
 *
 * Not covered, and so not claimed: the Grok lane builds its own body from
 * `anthropicMessagesToOpenAI` and does not pass through `requestBody.ts`
 * (P18.12 owns `grok/index.ts`); thinking-block signatures on the
 * Anthropic-compatible lane are untouched.
 */
export const REPLAY_FILTER = true
