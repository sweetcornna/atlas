// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  classifyDirection,
  DIRECTION_ROLES,
  directionOf,
  type ModelDirection,
} from '@qianmo/providers'
import type { OmpRpcFrame } from '@qianmo/resident'
import { nodeModelSelection, readYaml } from '../providers/node.js'
import {
  providerPaths,
  readTextIfExists,
  writePrivateJson,
} from '../providers/store.js'

export function decideResidentRoute(input: {
  text: string
  hint?: unknown
  auto: boolean
}): {
  direction: ModelDirection
  source: 'hint' | 'auto' | 'default'
  rule: string
} | null {
  // A hub sends a tier under its P22 name (`legacyDirectionOf`); both
  // spellings name the same tier here.
  const hint = directionOf(input.hint)
  if (hint !== null)
    return { direction: hint, source: 'hint', rule: 'explicit-hint' }
  if (input.auto) return { ...classifyDirection(input.text), source: 'auto' }
  return null
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
  if (!decision) return null
  // A media runner is a tool model, never the model receiving the main prompt.
  const media = ['image', 'speech', 'video'].includes(decision.direction)
  const selection = media
    ? undefined
    : (nodeModelSelection(DIRECTION_ROLES[decision.direction][0]!) ??
      nodeModelSelection())
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

export type ResidentModelSelection = {
  provider: string
  modelId: string
  thinkingLevel?: string
}
export interface ResidentRoutingRpc {
  request(type: string, input?: Record<string, unknown>): Promise<OmpRpcFrame>
}
export function readResidentManualSelection(
  file?: string,
): ResidentModelSelection | undefined {
  const text = file ? readTextIfExists(file) : undefined
  if (text === undefined) return undefined
  const raw = JSON.parse(text) as { manual?: ResidentModelSelection }
  if (raw.manual === undefined) return undefined
  if (
    !raw.manual ||
    typeof raw.manual.provider !== 'string' ||
    typeof raw.manual.modelId !== 'string' ||
    (raw.manual.thinkingLevel !== undefined &&
      typeof raw.manual.thinkingLevel !== 'string')
  )
    throw new Error('invalid resident manual model selection')
  return raw.manual
}
export async function currentResidentSelection(
  rpc: ResidentRoutingRpc,
): Promise<ResidentModelSelection> {
  const frame = await rpc.request('get_state')
  const state = frame.data as
    | { model?: { provider?: string; id?: string }; thinkingLevel?: string }
    | undefined
  if (!state?.model?.provider || !state.model.id)
    throw new Error('omp has no current model')
  return {
    provider: state.model.provider,
    modelId: state.model.id,
    ...(state.thinkingLevel === undefined
      ? {}
      : { thinkingLevel: state.thinkingLevel }),
  }
}
/** Manual state outlives the child; only explicit mutations replace it. */
export class ResidentModelRouter {
  #manual: ResidentModelSelection | undefined
  #restore: ResidentModelSelection | undefined
  readonly #file: string | undefined
  constructor(file?: string) {
    this.#file = file
    this.#manual = readResidentManualSelection(file)
  }
  async remember(rpc: ResidentRoutingRpc): Promise<void> {
    this.#manual = await currentResidentSelection(rpc)
    // A user can mutate the live RPC session while a hinted turn is running.
    // Its completion must restore the newer choice, not the older baseline.
    if (this.#restore) this.#restore = this.#manual
    if (this.#file) writePrivateJson(this.#file, { manual: this.#manual })
  }
  clear(): void {
    if (this.#file) writePrivateJson(this.#file, {})
    this.#manual = undefined
  }
  async prepare(
    rpc: ResidentRoutingRpc,
    input: { text: string; hint?: unknown; localCommand?: string },
  ) {
    // These commands are implemented locally in OmpRpcProcess.prompt. Their
    // queries and manual mutations must never be preceded by an auto switch.
    if (input.localCommand && !/^\/compact(?:\s|$)/.test(input.localCommand))
      return null
    const route = residentRouteSelection(input)
    if (route?.source === 'hint') {
      if (route.selection) this.#restore = await currentResidentSelection(rpc)
    } else if (this.#manual) {
      // Explicit RPC mutations already selected it, and child startup reads
      // the same persisted choice. Do not reapply effort on every turn: omp
      // may omit an unsupported effort from get_state.
      return null
    }
    if (!route) return null
    const actual = route.selection
      ? await applyResidentModelRoute(rpc, route.selection)
      : await currentResidentSelection(rpc).then(s => ({
          model: `${s.provider}/${s.modelId}`,
          thinkingLevel: s.thinkingLevel ?? 'off',
        }))
    return { ...route, actual }
  }
  async finish(rpc: ResidentRoutingRpc): Promise<void> {
    const restore = this.#restore
    this.#restore = undefined
    if (restore) await applyResidentModelRoute(rpc, restore)
  }
}
