// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The environment a resident node hands to its ACP child.
 *
 * Its own module, rather than an inline literal inside `defaultSpawnAcp`, so
 * that the regression suite which boots a real `--acp` child can boot it with
 * *this* environment instead of a hand-copied one. A copy would keep passing
 * after this function changed, which is exactly the failure a regression test
 * exists to catch.
 */

import {
  IDENTITY_ENV_VAR,
  NODE_IDENTITY_MODE,
} from '../../constants/identity.js'

/**
 * `parent` plus what every resident ACP child needs regardless of how the
 * node was started. Keys set here win over the same keys in `parent`.
 */
export function residentAcpEnvironment(
  parent: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return {
    ...parent,
    [IDENTITY_ENV_VAR]: NODE_IDENTITY_MODE,
    CLAUDE_CODE_REMOTE_SEND_KEEPALIVES: '1',
  }
}
