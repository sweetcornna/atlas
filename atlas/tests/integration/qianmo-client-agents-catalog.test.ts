// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `qmo agents` (`@qianmo/client`) and the node's runtime catalog
 * (`@qianmo/node`, harness-backends.md §1) name the same agents the same
 * way: the client cannot import the node (its Windows build links only
 * `@qianmo/paths`), so its table is its own and this test keeps the two
 * together — ids, protocols, names, commands, npm packages, and the rule
 * that tells DeepSeek Harness from Debian's `dsh`.
 */

import { afterEach, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { AGENT_SPECS, scanAgents } from '@qianmo/client/agents.ts'
import { RUNTIME_CATALOG } from '@qianmo/node/host/runtimes/catalog.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true })
})

test('every catalog runtime the node installs is one qmo agents knows, the same way', () => {
  const external = RUNTIME_CATALOG.filter(spec => spec.install.kind === 'npm')
  expect(external.length).toBeGreaterThan(0)
  for (const runtime of external) {
    if (runtime.install.kind !== 'npm') continue
    const agent = AGENT_SPECS.find(spec => spec.id === runtime.id)
    expect(agent).toBeDefined()
    // The catalog has one more protocol (its built-in `omp`) than qmo lists.
    const protocol: string | null = agent!.protocol
    expect({
      id: agent!.id,
      name: agent!.name,
      protocol,
      command: agent!.command,
      packaged: agent!.npm.includes(runtime.install.package),
      identity: agent!.identity && {
        args: [...agent!.identity.args],
        name: String(agent!.identity.name),
      },
    }).toEqual({
      id: runtime.id,
      name: runtime.label,
      protocol: runtime.protocol,
      command: runtime.install.command,
      packaged: true,
      identity: runtime.install.identity && {
        args: [...runtime.install.identity.args],
        name: String(runtime.install.identity.name),
      },
    })
  }
  // And none it drives that the catalog does not have.
  expect(
    AGENT_SPECS.filter(spec => spec.protocol !== null)
      .map(spec => spec.id)
      .sort(),
  ).toEqual(external.map(spec => spec.id).sort())
})

test('the catalog’s built-in qianmopi is not listed: the desktop app has no qm', async () => {
  const builtin = RUNTIME_CATALOG.find(spec => spec.install.kind === 'builtin')!
  expect(AGENT_SPECS.some(spec => spec.id === builtin.id)).toBe(false)
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'qmo-agents-catalog-'))
  roots.push(home)
  const report = await scanAgents({
    env: {},
    home,
    systemDirs: [],
    appDirs: [],
    loginShell: null,
  })
  expect(report.agents).toEqual([])
})
