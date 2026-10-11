// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  MODEL_DIRECTIONS,
  LANE_KINDS,
  presetById,
  type ModelRouting,
  type WireProfile,
} from '@qianmo/providers'
import { presetProfile, wireProfile, CANARY_KEY } from './helpers.js'
import { getModelCompatCapabilities } from '../../src/providers/capabilities.js'
export const capabilities = {
  protocol: 1 as const,
  ...getModelCompatCapabilities(),
}
export function routingFixture() {
  const primary = wireProfile()
  const chat = wireProfile({ id: 'chat', baseUrl: 'https://chat.example/v1' })
  const media = ['openai-images', 'openai-speech', 'openrouter-video'].map(id =>
    presetProfile(presetById(id)!),
  )
  const routes: ModelRouting['routes'] = {}
  for (const direction of MODEL_DIRECTIONS) {
    const profile =
      direction === 'image'
        ? media[0]!
        : direction === 'speech'
          ? media[1]!
          : direction === 'video'
            ? media[2]!
            : direction === 'chat'
              ? chat
              : primary
    routes[direction] = {
      profileId: profile.id,
      modelId: profile.models[0]!.id,
    }
  }
  const profiles = [chat, ...media]
  return {
    primary,
    profiles,
    routing: { auto: true, routes },
    options: {
      secret: CANARY_KEY,
      capabilities,
      routing: { auto: true, routes },
      profiles: profiles.map(profile => ({ profile, secret: CANARY_KEY })),
    },
  }
}
export function mediaProfile(lane: keyof typeof LANE_KINDS): WireProfile {
  return presetProfile(presetById(lane)!)
}
