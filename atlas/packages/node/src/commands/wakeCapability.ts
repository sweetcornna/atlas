// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The exact wake envelope fields a capability issuer must bind. */
export interface WakeCapabilityBinding {
  readonly aud: string
  readonly sub: string
  readonly taskId: string
  readonly createdAt: number
}

/** Throwing refuses the wake. The task identity is supplied by the sender. */
export type WakeCapabilityIssuer = (binding: WakeCapabilityBinding) => string
