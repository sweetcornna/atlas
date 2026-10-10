// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/** omp owns request shaping and credential rotation. No occ feature switches remain. */
export function getModelCompatCapabilities() {
  return { chatEffortHonorsOverride: true, replayFilter: true, multiKey: true }
}
