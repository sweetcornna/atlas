// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFileSync } from 'node:fs'
import { ompChildEnv, qianmoConfigPath } from '@qianmo/paths'
import {
  inheritedProviderKeyNames,
  withoutManagedConfigEnvironment,
} from '../providers/whitelist.js'

export function withoutProviderKeys(
  parent: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const env = { ...parent }
  for (const key of inheritedProviderKeyNames(parent)) delete env[key]
  return env
}
export function residentOmpEnvironment(
  parent: NodeJS.ProcessEnv,
): Record<string, string> {
  let managed = false
  try {
    const state = JSON.parse(
      readFileSync(
        qianmoConfigPath('qianmo', 'provider', 'state.json'),
        'utf8',
      ),
    )
    managed = state.v === 2 && state.applied != null
  } catch {
    /* An unmanaged node keeps the operator's provider environment. */
  }
  const env = ompChildEnv(managed ? withoutProviderKeys(parent) : parent)
  for (const key of Object.keys(env)) {
    if (['PI_CONFIG_FILES', 'PI_EDIT_VARIANT'].includes(key.toUpperCase()))
      delete env[key]
  }
  return withoutManagedConfigEnvironment(env)
}
