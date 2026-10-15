// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * P14.0 on omp: what keeps user and project customization out of a resident
 * child. The real-child behavior is pinned by
 * `atlas/packages/node/test/host/residentCustomization.integration.test.ts`;
 * this file pins the inputs and holds the provider list against omp.
 */

import { describe, expect, test } from 'bun:test'
import '@oh-my-pi/pi-coding-agent/discovery'
import { getAllCapabilitiesInfo } from '@oh-my-pi/pi-coding-agent/capability'
import {
  RESIDENT_DISABLED_DISCOVERY,
  residentConfigOverlay,
  residentCustomizationArgs,
} from '../src/policy.js'

/**
 * Providers deliberately left enabled, each with every capability it may
 * offer. Anything else it gains upstream reopens a load path.
 */
const KEPT: Readonly<Record<string, readonly string[]>> = {
  // Its id is also omp's Cursor model provider. Rules: `--no-rules`; project
  // MCP: `mcp.enableProjectConfig: false`; user files are opt-in; settings
  // load before `disabledProviders` is bound, so listing it would not help.
  cursor: ['mcps', 'rules', 'settings'],
}

function registry(): Map<string, Set<string>> {
  const providers = new Map<string, Set<string>>()
  for (const capability of getAllCapabilitiesInfo()) {
    for (const provider of capability.providers) {
      const capabilities = providers.get(provider.id) ?? new Set<string>()
      capabilities.add(capability.id)
      providers.set(provider.id, capabilities)
    }
  }
  return providers
}

describe('omp discovery providers', () => {
  test('every provider omp registers is disabled or kept on purpose', () => {
    const registered = [...registry().keys()].sort()
    expect(registered).toEqual(
      [...RESIDENT_DISABLED_DISCOVERY, ...Object.keys(KEPT)].sort(),
    )
  })

  test('a kept provider offers nothing beyond what other switches close', () => {
    const providers = registry()
    for (const [id, allowed] of Object.entries(KEPT)) {
      const offered = [...(providers.get(id) ?? [])]
      expect(offered.length).toBeGreaterThan(0)
      for (const capability of offered) expect(allowed).toContain(capability)
    }
  })
})

describe('default resident posture', () => {
  test('the overlay disables every listed provider', () => {
    const overlay = residentConfigOverlay({ edits: 'workspace' })
    const block = overlay.split('disabledProviders:\n')[1]?.split('\n')
    expect(block?.filter(line => line.startsWith('  - '))).toEqual(
      RESIDENT_DISABLED_DISCOVERY.map(id => `  - ${id}`),
    )
    // Project MCP stays off independently of the provider list.
    expect(overlay).toContain('mcp:\n  enableProjectConfig: false')
  })

  test('launch flags turn off skills, rules and APPEND_SYSTEM.md', () => {
    expect(residentCustomizationArgs(false)).toEqual([
      '--no-skills',
      '--no-rules',
      '--append-system-prompt',
      '',
    ])
  })
})

describe('--allow-user-customization', () => {
  test("omp's own discovery: no flags, no provider list", () => {
    expect(residentCustomizationArgs(true)).toEqual([])
    const overlay = residentConfigOverlay({
      edits: 'workspace',
      userCustomization: true,
    })
    expect(overlay).not.toContain('disabledProviders')
    // The rest of the posture does not move with it.
    expect(overlay).toContain('mcp:\n  enableProjectConfig: false')
    expect(overlay).toContain('bash: deny')
  })
})
