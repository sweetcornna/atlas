// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * §2.4 `effective`: what this node will ACTUALLY do with its settings, as the
 * runtime's own gate functions answer it — never a re-derivation from the
 * profile. The hub displays these values and nothing else (§3.4 「显示 =
 * 线上」), so a profile that says `always` but cannot reach the wire shows up
 * here as `effortOnWire: false` instead of hiding behind the catalog.
 *
 * MUTATES process.env: it replays the ACP child's startup sequence
 * (`runAcpAgent` → `enableConfigs()` + `applySafeConfigEnvironmentVariables()`,
 * then `createSession`'s `resetSettingsCache()` + re-apply) onto THIS process.
 * Call it only in a dedicated, short-lived process whose spawn env has been
 * stripped of provider keys the same way the ACP child's is (P18.7), and
 * print the result — never in the resident or the hub.
 */

import {
  resolveGeminiModel,
  resolveGrokModel,
  resolveOpenAIModel,
} from '@ant/model-provider'
import type { EffectiveState, WireEffortLevel } from '@qianmo/providers'
import { enableConfigs } from '../../../utils/config/config.js'
import { applySafeConfigEnvironmentVariables } from '../../../utils/config/managedEnv.js'
import {
  isDeepSeekTuningActiveForModel,
  resolveDeepSeekReasoningEffort,
} from '../../../utils/model/deepseekTuning.js'
import {
  convertEffortValueToLevel,
  type EffortValue,
  modelSupportsEffort,
  resolveAppliedEffort,
} from '../../../utils/model/effort.js'
import {
  getMainLoopModel,
  getMainLoopModelSettingsSlot,
} from '../../../utils/model/model.js'
import { getAPIProvider } from '../../../utils/model/providers.js'
import { getContextWindowForModel } from '../../../utils/session/context.js'
import { resetSettingsCache } from '../../../utils/settings/settingsCache.js'
import {
  type AutoCompactWindowSource,
  resolveActiveAutoCompactWindow,
} from '../../compact/autoCompactWindow.js'
import { resolveGrokReasoningEffort } from '../../api/grok/reasoning.js'
import { getResponsesReasoningEffort } from '../../api/openai/reasoning.js'
import { isOpenAIThinkingEnabled } from '../../api/openai/requestBody.js'
import { resolveOpenAIWireProtocol } from '../../api/openai/wireProtocol.js'
import { resolveChatReasoningEffort } from '../modelCompat/chatEffort.js'

/**
 * A wire vocabulary value back on the five-level scale, or `none` — what a
 * vendor table sends to switch reasoning off (`resolveChatReasoningEffort`
 * since P18.8): the key IS on the wire, so `effortOnWire` stays true and the
 * level says what it carries. Anything else is not reported as a level.
 */
export function wireEffortLevel(value: unknown): WireEffortLevel | null {
  return value === 'none' ||
    value === 'low' ||
    value === 'medium' ||
    value === 'high' ||
    value === 'xhigh' ||
    value === 'max'
    ? value
    : null
}

type WireEffort = {
  wire: string
  wireModel: string
  onWire: boolean
  level: WireEffortLevel | null
}

/**
 * Per-lane copy of the decision each request path makes, citing the line it
 * mirrors. Kept as thin as possible: every predicate is the runtime's own.
 */
function wireEffort(
  model: string,
  applied: EffortValue | undefined,
): WireEffort {
  const provider = getAPIProvider()
  if (provider === 'openai') {
    const wireModel = resolveOpenAIModel(model)
    const wire = resolveOpenAIWireProtocol(wireModel)
    if (wire === 'responses') {
      // openai/index.ts: `modelSupportsEffort(openaiModel) ? getResponsesReasoningEffort(…)`
      const level = modelSupportsEffort(wireModel)
        ? getResponsesReasoningEffort(wireModel, applied)
        : undefined
      return {
        wire,
        wireModel,
        onWire: level !== undefined,
        level: wireEffortLevel(level),
      }
    }
    // requestBody.ts: DeepSeek's ladder when thinking is on, else the value
    // the chat lane puts on the wire — `resolveChatReasoningEffort`, the gate
    // openai/index.ts asks (`chatLaneSendsReasoningEffort`, P18.5) and the
    // value it sends, so this is not a second copy of either.
    const deepseek =
      isDeepSeekTuningActiveForModel(wireModel, process.env.OPENAI_BASE_URL) &&
      isOpenAIThinkingEnabled(wireModel)
        ? resolveDeepSeekReasoningEffort(applied)
        : undefined
    const level =
      deepseek ??
      resolveChatReasoningEffort(
        wireModel,
        applied,
        process.env.OPENAI_BASE_URL,
      )
    return {
      wire,
      wireModel,
      onWire: level !== undefined,
      level: wireEffortLevel(level),
    }
  }
  if (provider === 'grok') {
    const wireModel = resolveGrokModel(model)
    const level = resolveGrokReasoningEffort(wireModel, applied)
    return {
      wire: 'grok',
      wireModel,
      onWire: level !== undefined,
      level: wireEffortLevel(level),
    }
  }
  if (provider === 'gemini') {
    // gemini/index.ts scales the thinking budget by the applied effort; the
    // knob exists whenever an effort resolves for this model.
    const wireModel = resolveGeminiModel(model)
    const onWire = modelSupportsEffort(model) && applied !== undefined
    return {
      wire: 'gemini',
      wireModel,
      onWire,
      level:
        onWire && applied !== undefined
          ? convertEffortValueToLevel(applied)
          : null,
    }
  }
  // claude.ts configureEffortParams: nothing unless modelSupportsEffort(model);
  // DeepSeek's endpoint always gets a rung; otherwise only a string level is
  // put into output_config.effort.
  if (!modelSupportsEffort(model)) {
    return { wire: 'anthropic', wireModel: model, onWire: false, level: null }
  }
  if (isDeepSeekTuningActiveForModel(model, process.env.ANTHROPIC_BASE_URL)) {
    const level = resolveDeepSeekReasoningEffort(applied)
    return {
      wire: 'anthropic',
      wireModel: model,
      onWire: true,
      level: wireEffortLevel(level),
    }
  }
  return {
    wire: 'anthropic',
    wireModel: model,
    onWire: typeof applied === 'string',
    level: wireEffortLevel(applied),
  }
}

type EffectiveStateOptions = {
  /**
   * Evaluate a model the session switched to (ACP `session/set_model` →
   * `queryEngine.setModel(id)`), instead of the one a fresh session starts
   * with. The slot is then whatever `QueryEngine` would compute for it.
   */
  model?: string
}

export function computeEffectiveProviderState(
  options: EffectiveStateOptions = {},
): EffectiveState {
  enableConfigs()
  resetSettingsCache()
  applySafeConfigEnvironmentVariables()

  // QueryEngine: `modelSettingsSlot: getMainLoopModelSettingsSlot(mainLoopModel)`.
  const model = options.model ?? getMainLoopModel()
  const slot = getMainLoopModelSettingsSlot(model)
  // An ACP session starts with no in-session /effort (AppState.effortValue is
  // undefined), so the applied value is env → per-slot setting → default.
  const applied = resolveAppliedEffort(model, undefined, slot)
  const effort = wireEffort(model, applied)
  const contextTokens = getContextWindowForModel(model, undefined, slot)
  // A fresh ACP session seeds AppState from settings without an override
  // (`resolveInitialAutoCompactWindow`), which resolves exactly as the live
  // settings file does here.
  const autoCompact = resolveActiveAutoCompactWindow(contextTokens)
  return {
    apiProvider: getAPIProvider(),
    wire: effort.wire,
    model,
    wireModel: effort.wireModel,
    modelSettingsSlot: slot ?? null,
    effortOnWire: effort.onWire,
    effortLevel: effort.level,
    contextTokens,
    autoCompactWindow: autoCompact.window,
    autoCompactSource: autoCompactSourceOf(autoCompact.source),
  }
}

/**
 * The runtime's source label in the three words §2.4 reports (D-9). The
 * other labels — `experiment`, `clientdata`, `model-default`,
 * `unknown-model` — are unreachable in this build (`autoCompactWindow.ts`)
 * and would all mean "chosen for the model", so they read as `auto`.
 */
export function autoCompactSourceOf(
  source: AutoCompactWindowSource,
): EffectiveState['autoCompactSource'] {
  return source === 'env' || source === 'settings' ? source : 'auto'
}
