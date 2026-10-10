// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Load exactly the same public registry/settings as an omp child. No ambient env mutation. */
import { Database } from 'bun:sqlite'
import {
  AuthStorage,
  SqliteAuthCredentialStore,
} from '@oh-my-pi/pi-coding-agent/session/auth-storage'
import { ModelRegistry } from '@oh-my-pi/pi-coding-agent/config/model-registry'
import { Settings } from '@oh-my-pi/pi-coding-agent/config/settings'
import { parseModelPattern } from '@oh-my-pi/pi-coding-agent/config/model-resolver'
import { cfgDefaultThinkingLevel } from '@oh-my-pi/pi-coding-agent/session/settings'
import { cfgCompaction } from '@oh-my-pi/pi-coding-agent/session/context-settings'
import {
  clampThinkingLevelForModel,
  resolveWireModelId,
} from '@oh-my-pi/pi-catalog/model-thinking'
import { resolveThresholdTokens } from '@oh-my-pi/pi-agent-core'
import { ompAgentDir } from '@qianmo/paths'
import { type EffectiveState, type WireEffortLevel } from '@qianmo/providers'
import { providerPaths } from './store.js'

export async function computeEffectiveProviderState(
  options: { model?: string } = {},
): Promise<EffectiveState> {
  const settings = await Settings.loadReadOnly({
    agentDir: ompAgentDir(),
    cwd: ompAgentDir(),
  })
  const store = new SqliteAuthCredentialStore(new Database(':memory:'))
  try {
    const registry = new ModelRegistry(
      new AuthStorage(store),
      providerPaths.models(),
      { settings },
    )
    if (registry.getError())
      throw new Error('omp model configuration is invalid')
    const selector = options.model ?? settings.getModelRole('default')
    if (!selector) throw new Error('no configured node model')
    const resolved = parseModelPattern(selector, registry.getAll())
    const model = resolved.model
    if (!model) throw new Error('configured node model is unavailable')
    if (!model.contextWindow) throw new Error('model context window is unknown')
    const selectedLevel =
      resolved.thinkingLevel ?? cfgDefaultThinkingLevel.get(settings)
    const effort = clampThinkingLevelForModel(
      model,
      selectedLevel === 'off' ||
        selectedLevel === 'inherit' ||
        selectedLevel === 'auto'
        ? undefined
        : selectedLevel,
    )
    const compat = model.compat as Record<string, unknown>
    const openAi =
      model.api === 'openai-completions' || model.api === 'openai-responses'
    const efforts = model.thinking?.efforts ?? []
    const onWire =
      model.reasoning &&
      effort !== undefined &&
      efforts.length > 0 &&
      (!openAi ||
        (compat.supportsReasoningEffort !== false &&
          compat.supportsReasoningParams !== false))
    const level = onWire
      ? (model.thinking?.effortMap?.[
          effort as keyof typeof model.thinking.effortMap
        ] ?? effort)
      : null
    const allowed = ['none', 'low', 'medium', 'high', 'xhigh', 'max']
    const compaction = cfgCompaction.get(settings)
    return {
      apiProvider: model.api,
      wire: model.api,
      model: model.id,
      wireModel: resolveWireModelId(model, effort),
      modelSettingsSlot: options.model ? null : 'default',
      effortOnWire: onWire,
      effortLevel:
        typeof level === 'string' && allowed.includes(level)
          ? (level as WireEffortLevel)
          : null,
      contextTokens: model.contextWindow,
      autoCompactWindow: resolveThresholdTokens(
        model.contextWindow,
        compaction,
      ),
      autoCompactSource:
        (compaction.thresholdTokens ?? -1) > 0 ||
        (compaction.thresholdPercent ?? -1) > 0
          ? 'settings'
          : 'auto',
    }
  } finally {
    store.close()
  }
}
