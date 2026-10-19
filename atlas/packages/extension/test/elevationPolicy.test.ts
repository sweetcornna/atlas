// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from 'bun:test'
import {
  elevatedCall,
  elevatedTools,
  elevationActive,
  elevationNeedsApproval,
  parseElevationResource,
  sandboxedCommand,
  unsandboxedCommand,
  type ElevationResource,
  type ElevationSandbox,
} from '../src/elevationPolicy.js'
import {
  residentActiveTools,
  residentApprovalMode,
  residentConfigOverlay,
  residentWritesWorkspace,
  type ResidentExtensionConfig,
} from '../src/policy.js'

const SANDBOX: ElevationSandbox = {
  argv: ['bwrap', '--unshare-all', '--die-with-parent'],
  shell: '/bin/bash',
}
function grant(
  over: Partial<ElevationResource> = {},
): ElevationResource & { tier: 'accept-edits' | 'auto' | 'full-access' } {
  return {
    v: 1,
    tier: 'auto',
    epoch: 1,
    expiresAt: Date.now() + 3_600_000,
    sandbox: SANDBOX,
    ...over,
  } as ElevationResource & {
    tier: 'accept-edits' | 'auto' | 'full-access'
  }
}

describe('elevation grant file', () => {
  test('parses a well-formed grant and fails closed on anything else', () => {
    const live = grant()
    expect(parseElevationResource(JSON.parse(JSON.stringify(live)))).toEqual(
      live,
    )
    expect(
      parseElevationResource({
        v: 1,
        tier: 'off',
        epoch: 2,
        expiresAt: 0,
        sandbox: null,
      })?.tier,
    ).toBe('off')
    for (const bad of [
      null,
      [],
      { v: 2, tier: 'auto', epoch: 1, expiresAt: 1, sandbox: null },
      { v: 1, tier: 'confirm-each', epoch: 1, expiresAt: 1, sandbox: null },
      { v: 1, tier: 'auto', epoch: 1.5, expiresAt: 1, sandbox: null },
      { v: 1, tier: 'auto', epoch: 1, expiresAt: 1, sandbox: { argv: [] } },
      {
        v: 1,
        tier: 'auto',
        epoch: 1,
        expiresAt: 1,
        sandbox: { argv: ['x'], shell: 'bash' },
      },
    ])
      expect(parseElevationResource(bad)).toBeUndefined()
  })
  test('active only while non-off and unexpired', () => {
    const now = 1_000_000
    expect(elevationActive(grant({ expiresAt: now + 1 }), now)).toBe(true)
    expect(elevationActive(grant({ expiresAt: now }), now)).toBe(false)
    expect(
      elevationActive(
        parseElevationResource({
          v: 1,
          tier: 'off',
          epoch: 1,
          expiresAt: now + 9,
          sandbox: null,
        }),
        now,
      ),
    ).toBe(false)
    expect(elevationActive(undefined, now)).toBe(false)
  })
})

describe('tier approval matrix (P39 §2)', () => {
  test('accept-edits asks for everything, auto only for act-out, full-access for nothing', () => {
    const classes = ['local', 'read-out', 'act-out'] as const
    expect(classes.map(c => elevationNeedsApproval('accept-edits', c))).toEqual(
      [true, true, true],
    )
    expect(classes.map(c => elevationNeedsApproval('auto', c))).toEqual([
      false,
      false,
      true,
    ])
    expect(classes.map(c => elevationNeedsApproval('full-access', c))).toEqual([
      false,
      false,
      false,
    ])
  })
})

describe('elevated tool classification', () => {
  test('bash is local, rejects extra keys and needs a command', () => {
    expect(elevatedCall('bash', { command: 'ls', i: 'why' })).toMatchObject({
      tool: 'bash',
      class: 'local',
      args: { command: 'ls' },
    })
    expect(elevatedCall('bash', { command: 'ls', pty: true })).toContain('pty')
    expect(elevatedCall('bash', {})).toBe('bash needs a command')
  })
  test('web_search is read-out; task is never an elevated call', () => {
    // No tier opens native subagents: task falls to the ordinary verdict,
    // which refuses it.
    expect(elevatedCall('task', { prompt: 'x' })).toBeUndefined()
    expect(elevatedCall('web_search', { query: 'x' })).toMatchObject({
      class: 'read-out',
    })
  })
  test('github read ops are read-out, pr_create act-out, host mutations refused', () => {
    expect(elevatedCall('github', { op: 'repo_view' })).toMatchObject({
      class: 'read-out',
      op: 'repo_view',
    })
    expect(elevatedCall('github', { op: 'pr_create' })).toMatchObject({
      class: 'act-out',
      op: 'pr_create',
    })
    for (const op of ['pr_push', 'pr_checkout', ''])
      expect(typeof elevatedCall('github', { op })).toBe('string')
  })
  test('read is elevated only for URLs, collects hosts, rejects mixed inputs', () => {
    expect(elevatedCall('read', { path: './local.txt' })).toBeUndefined()
    expect(
      elevatedCall('read', { path: 'https://a.test/x;http://b.test' }),
    ).toMatchObject({ class: 'read-out', hosts: ['a.test', 'b.test'] })
    expect(
      elevatedCall('read', { path: 'https://a.test/x;./local' }),
    ).toContain('mix')
  })
  test('an unlisted tool is not an elevated call', () => {
    expect(elevatedCall('edit', { path: 'x' })).toBeUndefined()
  })
})

describe('sandbox command wrapping', () => {
  test('wraps and unwraps an exact earlier rewrite, leaving edits alone', () => {
    const wrapped = sandboxedCommand('echo hi', '/work', SANDBOX)
    expect(wrapped).toContain(
      "'--chdir' '/work' '--' '/bin/bash' '-c' 'echo hi'",
    )
    expect(unsandboxedCommand(wrapped, SANDBOX)).toBe('echo hi')
    expect(unsandboxedCommand('plain command', SANDBOX)).toBe('plain command')
    expect(unsandboxedCommand(`${wrapped} ; rm -rf /`, SANDBOX)).toBe(
      `${wrapped} ; rm -rf /`,
    )
  })
})

describe('tool surface under a live grant', () => {
  test('a live grant adds bash only with a sandbox, plus web_search/github, never task', () => {
    expect(elevatedTools(grant())).toEqual(['bash', 'web_search', 'github'])
    expect(elevatedTools(grant({ sandbox: null }))).toEqual([
      'web_search',
      'github',
    ])
    expect(elevatedTools(grant({ tier: 'off' }))).toEqual([])
  })
  test('workspace writes and write approval mode turn on under any live tier', () => {
    expect(residentWritesWorkspace({ edits: 'none', elevation: grant() })).toBe(
      true,
    )
    expect(residentApprovalMode({ edits: 'none', elevation: grant() })).toBe(
      'write',
    )
    expect(residentWritesWorkspace({ edits: 'none' })).toBe(false)
    expect(
      residentActiveTools('none', [], undefined, undefined, undefined, grant()),
    ).toEqual(
      expect.arrayContaining(['write', 'edit', 'ast_edit', 'bash', 'github']),
    )
  })
  test('the overlay allows the elevated tools and enables their load sites', () => {
    const overlay = Bun.YAML.parse(
      residentConfigOverlay({ edits: 'none', elevation: grant() }),
    ) as {
      tools: { approvalMode: string; approval: Record<string, string> }
      web_search: { enabled: boolean }
      github: { enabled: boolean }
      bash: { direnv: string; autoBackground: { enabled: boolean } }
    }
    expect(overlay.tools.approvalMode).toBe('write')
    expect(overlay.tools.approval.bash).toBe('allow')
    expect(overlay.tools.approval.github).toBe('allow')
    expect(overlay.tools.approval.eval).toBe('deny')
    expect(overlay.web_search.enabled).toBe(true)
    expect(overlay.github.enabled).toBe(true)
    expect(overlay.tools.approval.task).toBe('deny')
    expect(overlay.bash.direnv).toBe('off')
    expect(overlay.bash.autoBackground.enabled).toBe(false)
  })
  test('without a grant the denied table still denies the elevated tools', () => {
    const overlay = residentConfigOverlay({ edits: 'none' })
    expect(overlay).toContain('bash: deny')
    expect(overlay).toContain('github: deny')
    expect(overlay).toContain('web_search:\n  enabled: false')
  })
  test('a sandbox-less node offers no bash but still denies it in the overlay', () => {
    const noSandbox = grant({ sandbox: null })
    const config: Pick<ResidentExtensionConfig, 'edits' | 'elevation'> = {
      edits: 'none',
      elevation: noSandbox,
    }
    expect(
      residentActiveTools(
        'none',
        [],
        undefined,
        undefined,
        undefined,
        noSandbox,
      ),
    ).not.toContain('bash')
    void config
    const overlay = residentConfigOverlay({
      edits: 'none',
      elevation: noSandbox,
    })
    expect(overlay).toContain('bash: deny')
    expect(overlay).toContain('github: allow')
  })
})
