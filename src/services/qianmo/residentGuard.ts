// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: MIT

/**
 * Where the resident hardline table meets the base's permission chain
 * (design `resident-botization.md` §4.5, hermes E2 / E3).
 *
 * WHY THIS IS A TOOL WRAPPER AND NOT AN EDIT TO `permissions.ts`
 *
 * The requirement is that the hardline is evaluated **before any allow rule**.
 * There are exactly two ways a tool call can come back `allow` in this build,
 * and a wrapper around `checkPermissions` sits ahead of both:
 *
 *   - `hasPermissionsToUseToolInner` calls `tool.checkPermissions` at step 1c
 *     and returns immediately on a `deny` at step 1d. Everything that can
 *     produce an allow — `bypassPermissions` mode (2a) and the whole-tool allow
 *     rule (2b) — is downstream of that return. Allow rules that a tool matches
 *     itself are decided *inside* `checkPermissions`, so overriding its answer
 *     is the same thing as pre-empting them.
 *   - `resolveHookPermissionDecision` handles the case where a `PreToolUse`
 *     hook already answered `allow`; it deliberately still runs
 *     `checkRuleBasedPermissions`, which also calls `tool.checkPermissions` and
 *     also returns on `deny`.
 *
 * So the ceiling holds on both funnels without touching either of them. That
 * matters beyond tidiness: `permissions.ts` is base core on the hot path of
 * every tool call in the product, and an edit there would be re-merged by hand
 * at every upstream sync, forever, for a rule that concerns only resident
 * sessions. This wrapper is applied to one session's tool array, at the one
 * place the resident tool surface is already assembled.
 *
 * WHY THE TABLE IS NOT READ FROM CONFIGURATION
 *
 * `ResidentHardline` holds a frozen literal in `@qianmo/resident`. The only
 * thing supplied from outside is the set of absolute state roots, and those are
 * derived from `occConfigDir()` — the process's own path derivation, not
 * anything a session can set. Nothing here reads `settings.json`, and that is
 * the point: the first entry on the table is `settings.json` itself.
 */

import { ResidentHardline } from '@qianmo/resident'
import type { Tool, Tools } from '@open-claude-code/tool-runtime/Tool.js'
import { occConfigDir } from '../../config/paths.js'

/**
 * The one hardline instance for this process.
 *
 * Built from the identity config root, which is where every protected target
 * actually lives. The lexical rules in `@qianmo/resident` apply regardless, so
 * a deployment whose root is somewhere unusual is covered by those even if the
 * root itself never matches.
 */
function residentHardline(): ResidentHardline {
  return new ResidentHardline({ stateRoots: [occConfigDir()] })
}

function guardTool(tool: Tool, hardline: ResidentHardline): Tool {
  // Prototype delegation rather than a spread: a spread would copy own
  // enumerable properties only, dropping getters and anything the tool defines
  // on a prototype, and would silently change behaviour for tools that have
  // either. Here every read that is not `checkPermissions` falls through to the
  // real tool untouched.
  const guarded = Object.create(tool) as Tool
  guarded.checkPermissions = async (input, context) => {
    const denial = hardline.verdict(tool.name, input)
    if (denial !== null) {
      return {
        behavior: 'deny',
        message:
          `Refused by the Qianmo resident hardline (${denial.target.id}): ` +
          `${denial.target.reason}. Matched ${JSON.stringify(denial.matched)} on the ` +
          `${denial.surface} surface. This target cannot be pre-approved — no ` +
          'allow rule, permission mode or hook grants access to it.',
        decisionReason: {
          type: 'other',
          reason: `qianmo-resident-hardline:${denial.target.id}`,
        },
      }
    }
    return await tool.checkPermissions(input, context)
  }
  return guarded
}

/**
 * Apply the hardline to every tool a resident session is given.
 *
 * Every tool, not a chosen few: the file tools and `Bash` are the two surfaces
 * E3 names, but a list of "the dangerous ones" is a list that goes stale the
 * next time a tool grows a path argument, and it goes stale silently.
 */
export function withResidentHardline(tools: Tools): Tools {
  const hardline = residentHardline()
  return tools.map(tool => guardTool(tool, hardline))
}
