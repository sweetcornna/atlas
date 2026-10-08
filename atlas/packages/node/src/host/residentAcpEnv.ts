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

import { readFileSync } from 'node:fs'
import {
  IDENTITY_ENV_VAR,
  NODE_IDENTITY_MODE,
} from '../../constants/identity.js'
import { providerPaths } from './providers/store.js'
import { inheritedProviderKeyNames } from './providers/whitelist.js'

/**
 * The memory root the host serves memory from, as handed to its ACP child.
 * Set by {@link residentAcpEnvironment}; read back by {@link hostMemoryRoot}.
 */
const RESIDENT_MEMORY_ROOT_ENV = 'QIANMO_RESIDENT_MEMORY_ROOT'

/**
 * The memory root the host named for this child, or `undefined`.
 *
 * A path derivation in the same sense as `occConfigDir()` and
 * `defaultMemoryRoot()`, which read `OCC_CONFIG_DIR` and
 * `CLAUDE_CODE_REMOTE_MEMORY_DIR` the same way: the value is fixed when the
 * host spawns the child, and the only other writer is the node's own
 * `settings.json` `env` block, which the hardline refuses to every resident
 * turn. It is only ever *added* to the protected roots, so no value of it can
 * make the table refuse less.
 */
export function hostMemoryRoot(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const root = env[RESIDENT_MEMORY_ROOT_ENV]
  return root === undefined || root === '' ? undefined : root
}

/**
 * Whether the hub manages this node's model service: `state.json` under
 * `occConfigPath('qianmo','provider')` parses and records an applied profile.
 *
 * The same judgment as `readProviderState().managed` (`providers/node.ts`),
 * restated here so the ACP child's guard path does not load the provider
 * write path; a test pins the two together. A file that is missing, does not
 * parse or records no applied profile (a first apply that ended in
 * `conflict` writes one like that) means "not managed": the node's model then
 * still comes from wherever it came from before, and stripping it would leave
 * the child with none.
 */
function isProviderManagedNode(): boolean {
  let text: string
  try {
    text = readFileSync(providerPaths.state(), 'utf8')
  } catch {
    return false
  }
  try {
    const state: unknown = JSON.parse(text)
    if (typeof state !== 'object' || state === null || Array.isArray(state)) {
      return false
    }
    const { v, applied } = state as { v?: unknown; applied?: unknown }
    return v === 1 && applied !== null && applied !== undefined
  } catch {
    return false
  }
}

/**
 * `parent` without any key that selects or shapes a model provider — the
 * spawn env of a managed node's ACP child, and of every process the node runs
 * to compute or try out a provider configuration (`qm provider`), so that
 * what those report is what the child will do.
 */
export function withoutProviderKeys(
  parent: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const env = { ...parent }
  for (const key of inheritedProviderKeyNames(parent)) delete env[key]
  return env
}

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
 *
 * ## Why the memory root travels with it
 *
 * The child's hardline refuses the node's memory store as a whole subtree. It
 * derives that root itself (`defaultMemoryRoot()`), which agrees with the host
 * only while the host uses the default too. A host started with its own
 * `memoryRoot` would otherwise protect one directory and serve memory out of
 * another. So the host names the root it actually uses, and the child adds it
 * to the protected set — additively: the child's own default stays protected
 * whatever this says.
 *
 * ## Why a managed node's child gets no provider keys from here
 *
 * Once the hub manages the node's model service (design
 * `providers-console-m1.md` §2.6, P18.7), `settings.json` is the one source
 * of the provider, and the process environment must not be a second one. It
 * would be: the fleet's residents are started with their model in the
 * environment (`CLAUDE_CODE_USE_OPENAI`, `OPENAI_BASE_URL`, `OPENAI_API_KEY`
 * …), settings only override the keys they name, and `getAPIProvider()` reads
 * `CLAUDE_CODE_USE_*` whenever `modelType` is `anthropic` — so a switch to an
 * Anthropic-lane profile would still route through the inherited OpenAI
 * switch, and a key the profile deleted would survive from the environment.
 * The child therefore gets `parent` minus exactly the set the node's
 * `effective` computation strips (`inheritedProviderKeyNames`), so what the
 * console shows and what the child sends are computed from the same inputs.
 *
 * A managed child also gets `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`: the keys now
 * reach it through `settings.json`, and the scrub keeps them out of what its
 * Bash tool, hooks, MCP and LSP servers inherit (§7.5). That is a shell
 * expansion closed, not a secrecy boundary — the agent runs as the same user
 * as the process holding the key.
 *
 * A node the hub does not manage gets exactly what it got before this
 * existed, key for key and in the same order.
 */
export function residentAcpEnvironment(
  parent: NodeJS.ProcessEnv,
  options: { readonly memoryRoot?: string } = {},
): NodeJS.ProcessEnv {
  const managed = isProviderManagedNode()
  return {
    ...(managed ? withoutProviderKeys(parent) : parent),
    [IDENTITY_ENV_VAR]: NODE_IDENTITY_MODE,
    CLAUDE_CODE_REMOTE_SEND_KEEPALIVES: '1',
    CLAUDE_CODE_SAFE_MODE: '1',
    ...(managed ? { CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1' } : {}),
    ...(options.memoryRoot === undefined
      ? {}
      : { [RESIDENT_MEMORY_ROOT_ENV]: options.memoryRoot }),
  }
}
