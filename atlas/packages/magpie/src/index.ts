// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `@qianmo/magpie`: the hub's client for a magpie model gateway.
 *
 * magpie (MIT, github.com/yetone/magpie) runs as the platform's gateway;
 * nodes call its gateway with keys the hub issues, and the hub manages it
 * through its management API. This package is that management client, the
 * L-6 guard that decides what a Qianmo key may reach, and (at
 * `@qianmo/magpie/testing`) an in-memory magpie for tests.
 */

export {
  eligiblePatterns,
  groupEligible,
  ineligiblePatterns,
  NO_MODEL_PATTERN,
  patternsConfined,
} from './access.js'
export {
  checkOrigin,
  MAGPIE_ERROR_CODES,
  MagpieClient,
  type MagpieClientOptions,
  MagpieError,
  type MagpieErrorCode,
} from './client.js'
export * from './types.js'
