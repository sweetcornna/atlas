// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: MIT

/**
 * The ordering claim, checked where it is actually made: the hardline table is
 * consulted **before** anything that could answer `allow` (design §4.5, hermes
 * E2/E3, roadmap P13.7 DoD).
 *
 * The base has exactly two funnels that can produce an allow for a tool call,
 * and both of them reach it through `tool.checkPermissions`:
 * `hasPermissionsToUseToolInner` (step 1c, returning on a deny at 1d, ahead of
 * bypass mode at 2a and the whole-tool allow rule at 2b) and
 * `checkRuleBasedPermissions` (the path taken when a `PreToolUse` hook already
 * answered allow). So a tool whose `checkPermissions` returns `allow` is a
 * faithful stand-in for "a pre-approval matched", and the assertions below are
 * about what happens to that allow.
 */

import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import type {
  Tool,
  ToolUseContext,
} from '@open-claude-code/tool-runtime/Tool.js'
import { occConfigDir } from '../../../config/paths.js'
import { withResidentHardline } from '../residentGuard.js'

const CONTEXT = {} as unknown as ToolUseContext

/** A tool that pre-approves everything, the way a matched allow rule does. */
function permissiveTool(name: string): {
  readonly tool: Tool
  readonly calls: unknown[]
} {
  const calls: unknown[] = []
  const tool = {
    name,
    async checkPermissions(input: unknown) {
      calls.push(input)
      return { behavior: 'allow' as const, updatedInput: input }
    },
    async description() {
      return `${name} description`
    },
    marker: 'inherited-property',
  } as unknown as Tool
  return { tool, calls }
}

describe('resident hardline wiring — evaluated before any allow', () => {
  test('a pre-approved write to a protected target is refused anyway', async () => {
    const { tool } = permissiveTool('FileWrite')
    const [guarded] = withResidentHardline([tool])

    const decision = await (guarded as Tool).checkPermissions(
      { file_path: `${occConfigDir()}/settings.json` } as never,
      CONTEXT,
    )

    expect(decision.behavior).toBe('deny')
    expect(decision.decisionReason).toEqual({
      type: 'other',
      reason: 'qianmo-resident-hardline:settings',
    })
  })

  test('the allow is never even consulted for a protected target', async () => {
    // The ordering claim in its sharpest form. If the wrapper ran the inner
    // check first and then overrode it, this counter would be 1 — and the
    // difference matters, because "asked, then overruled" is a shape that
    // decays into "asked, and honoured" the first time somebody refactors the
    // override away.
    const { tool, calls } = permissiveTool('Bash')
    const [guarded] = withResidentHardline([tool])

    const decision = await (guarded as Tool).checkPermissions(
      { command: `rm -rf ${occConfigDir()}/resident` } as never,
      CONTEXT,
    )

    expect(decision.behavior).toBe('deny')
    expect(calls).toHaveLength(0)
  })

  test('the shell surface is refused for the same target as the file surface', async () => {
    // Paired, at the wiring level and not only in the table: an implementation
    // that wrapped the file tools and forgot Bash would pass the file half of
    // this file and fail here.
    const target = `${occConfigDir()}/qianmo/audit/trail.ndjson`
    const [guardedFile] = withResidentHardline([
      permissiveTool('FileWrite').tool,
    ])
    const [guardedShell] = withResidentHardline([permissiveTool('Bash').tool])

    const fileDecision = await (guardedFile as Tool).checkPermissions(
      { file_path: target } as never,
      CONTEXT,
    )
    const shellDecision = await (guardedShell as Tool).checkPermissions(
      { command: `: > ${target}` } as never,
      CONTEXT,
    )

    expect(fileDecision.behavior).toBe('deny')
    expect(shellDecision.behavior).toBe('deny')
  })

  test('ordinary work still reaches the tool own decision', async () => {
    // Without this the suite above is satisfied by a guard that denies
    // everything, which would take the node off the air rather than protect it.
    const { tool, calls } = permissiveTool('FileWrite')
    const [guarded] = withResidentHardline([tool])

    const decision = await (guarded as Tool).checkPermissions(
      { file_path: '/repo/src/index.ts' } as never,
      CONTEXT,
    )

    expect(decision.behavior).toBe('allow')
    expect(calls).toHaveLength(1)
  })

  test('wrapping preserves everything else about the tool', async () => {
    const { tool } = permissiveTool('FileRead')
    const [guarded] = withResidentHardline([tool])
    const wrapped = guarded as Tool & { marker?: string }

    expect(wrapped.name).toBe('FileRead')
    expect(wrapped.marker).toBe('inherited-property')
    expect(await wrapped.description({} as never, {} as never)).toBe(
      'FileRead description',
    )
  })

  test('every tool in the array is wrapped, not just the ones we thought of', async () => {
    const tools = ['FileWrite', 'Bash', 'NotebookEdit', 'SomeFutureTool'].map(
      name => permissiveTool(name).tool,
    )
    const guarded = withResidentHardline(tools)

    for (const tool of guarded) {
      const decision = await tool.checkPermissions(
        { file_path: `${occConfigDir()}/settings.json` } as never,
        CONTEXT,
      )
      expect(decision.behavior).toBe('deny')
    }
  })
})

describe('resident hardline wiring — it is applied to resident sessions only', () => {
  test('the session builder wraps the resident branch and leaves the other alone', async () => {
    const source = await Bun.file(
      resolve(import.meta.dir, '../../acp/agent/createSessionMethod.ts'),
    ).text()

    // The resident branch is wrapped …
    expect(source).toContain('withResidentHardline([')
    // … and the non-resident branch is still the untouched base array. A
    // regression that wrapped everything would be a behaviour change for every
    // ordinary ACP session, which is not what this batch is allowed to do.
    expect(/:\s*baseTools\b/.test(source)).toBe(true)
    expect(source.match(/withResidentHardline/g)).toHaveLength(2)
  })
})
