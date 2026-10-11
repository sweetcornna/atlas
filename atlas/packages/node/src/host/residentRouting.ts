// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  classifyDirection,
  DIRECTION_ROLES,
  isModelDirection,
  type ModelDirection,
} from '@qianmo/providers'
import type { OmpRpcFrame } from '@qianmo/resident'
import { nodeModelSelection, readYaml } from '../providers/node.js'
import { providerPaths } from '../providers/store.js'

export function decideResidentRoute(input: {
  text: string
  hint?: unknown
  auto: boolean
}): {
  direction: ModelDirection
  source: 'hint' | 'auto' | 'default'
  rule: string
} {
  if (isModelDirection(input.hint))
    return { direction: input.hint, source: 'hint', rule: 'explicit-hint' }
  if (input.auto) return { ...classifyDirection(input.text), source: 'auto' }
  return { direction: 'code', source: 'default', rule: 'default-model' }
}
export function residentMediaRoutes(): {
  image: boolean
  speech: boolean
  video: boolean
} {
  const config = readYaml(providerPaths.config())
  const enabled = (name: string) =>
    !!config[name] &&
    typeof config[name] === 'object' &&
    (config[name] as Record<string, unknown>).enabled === true
  return {
    image: enabled('generate_image') && !!nodeModelSelection('image'),
    speech: enabled('speechgen') && !!nodeModelSelection('speech'),
    video: !!nodeModelSelection('video'),
  }
}
export function residentRouteSelection(input: {
  text: string
  hint?: unknown
}) {
  const config = readYaml(providerPaths.config())
  const auto =
    !!config.qianmoRouting &&
    typeof config.qianmoRouting === 'object' &&
    (config.qianmoRouting as Record<string, unknown>).auto === true
  const decision = decideResidentRoute({ ...input, auto })
  // A media runner is a tool model, never the model receiving the main prompt.
  const role = ['image', 'speech', 'video'].includes(decision.direction)
    ? 'default'
    : DIRECTION_ROLES[decision.direction][0]!
  const selection = nodeModelSelection(role) ?? nodeModelSelection()
  return {
    ...decision,
    selection,
    mediaModel: ['image', 'speech', 'video'].includes(decision.direction)
      ? nodeModelSelection(decision.direction)
      : undefined,
  }
}

/** Read back the actual state: omp may clamp a requested effort for the model. */
export async function applyResidentModelRoute(
  rpc: {
    request(type: string, input?: Record<string, unknown>): Promise<OmpRpcFrame>
  },
  selection: { provider: string; modelId: string; thinkingLevel?: string },
): Promise<{ model: string; thinkingLevel: string }> {
  const read = async () => {
    const frame = await rpc.request('get_state')
    return frame.data as
      | { model?: { provider?: string; id?: string }; thinkingLevel?: string }
      | undefined
  }
  let state = await read()
  let changed = false
  if (
    state?.model?.provider !== selection.provider ||
    state?.model?.id !== selection.modelId
  ) {
    await rpc.request('set_model', {
      provider: selection.provider,
      modelId: selection.modelId,
    })
    state = await read()
    changed = true
  }
  if (
    selection.thinkingLevel &&
    state?.thinkingLevel !== selection.thinkingLevel
  ) {
    await rpc.request('set_thinking_level', { level: selection.thinkingLevel })
    changed = true
  }
  if (changed) state = await read()
  if (
    state?.model?.provider !== selection.provider ||
    state?.model?.id !== selection.modelId
  )
    throw new Error('omp did not select the routed model')
  return {
    model: `${state.model.provider}/${state.model.id}`,
    thinkingLevel: state.thinkingLevel ?? 'off',
  }
}
