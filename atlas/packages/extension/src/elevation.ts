// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFileSync } from 'node:fs'
import {
  parseElevationResource,
  type ElevationResource,
} from './elevationPolicy.js'

/**
 * Read one agent's grant file. Kept out of `index.ts`, which wires the
 * hardline and must not read files (`resident/test/guard.test.ts`).
 */
export function readElevationResource(
  file: string,
): ElevationResource | undefined {
  try {
    return parseElevationResource(JSON.parse(readFileSync(file, 'utf8')))
  } catch {
    return undefined
  }
}
