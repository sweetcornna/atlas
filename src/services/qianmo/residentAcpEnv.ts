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
 *
 * ## Why safe mode is on
 *
 * `CLAUDE_CODE_SAFE_MODE=1` turns off every *user* customization surface in the
 * child: user/project/local `PreToolUse` hooks, custom agent and skill
 * definitions, plugins, custom slash commands, output styles and workflows.
 * That closes three permission bypasses at the load site, before any of them
 * can reach a permission decision:
 *
 *   - a `PreToolUse` hook that answers `allow` skips the host prompt entirely
 *     (review-P14 E-2). Its config snapshot is process-level, so one workspace's
 *     hook would also apply to another agent's session in the same child;
 *   - a custom agent definition carrying `permissionMode: bypassPermissions` is
 *     adopted by the subagent it spawns (E-3);
 *   - a skill's `allowed-tools` injects allow rules into the running session
 *     (E-4).
 *
 * Safe mode keeps everything the node actually needs: auth and model selection,
 * the built-in tool set, the permission system, `CLAUDE.md`, and — because they
 * load from `policySettings`, not user settings — any admin-managed hooks. It
 * does **not** touch the provider credentials or endpoints the node reads from
 * its own `settings.json` `env` block (`applySafeConfigEnvironmentVariables`
 * runs regardless), nor the host-side memory sidecar, notify tool or MCP wiring,
 * none of which are user-customization surfaces. Measured: a child booted with
 * this env still reads its `settings.json` provider and its workspace
 * `CLAUDE.md`, and still auto-accepts workspace edits under `acceptEdits`.
 *
 * The tool-surface trims, the hardline and the `canUseTool` ceiling in
 * `residentGuard.ts` are the defence in depth for the case where a definition
 * is admin-managed (safe mode keeps those) or a future base change moves one of
 * these load sites — they hold with safe mode off.
 */
export function residentAcpEnvironment(
  parent: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return {
    ...parent,
    [IDENTITY_ENV_VAR]: NODE_IDENTITY_MODE,
    CLAUDE_CODE_REMOTE_SEND_KEEPALIVES: '1',
    CLAUDE_CODE_SAFE_MODE: '1',
  }
}
