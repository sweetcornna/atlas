// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * What the Bash tool of a managed node's real ACP child can see (design
 * `providers-console-m1.md` §7.5, §9.2 P18.7): not the model key.
 *
 * ## What is real
 *
 * The `--acp` child from source, in the environment `residentAcpEnvironment()`
 * builds (through the permission-bypass suite's harness), its Bash tool and
 * the shell it spawns; the P18.2 write path committing a profile to a 0700
 * config root; the child reading that profile out of `settings.json`.
 *
 * ## What is not
 *
 * The model: the harness's loopback double, scripted to call Bash once and
 * record the tool result. The key is an `sk-test-canary-…` string.
 *
 * ## The order of events
 *
 * The node is managed before the child starts (that is what makes its spawn
 * env drop the parent's provider keys), and the profile is then re-pointed at
 * the double's port, which only exists once the harness has started — a
 * switch, as the console would send one. The child re-reads `settings.json`
 * when the session is created.
 *
 * ## Positive controls
 *
 * The same command prints `OPENAI_BASE_URL`, which comes from the same
 * `settings.json` `env` block as the key and is not on the scrub list: seeing
 * it proves the profile's env does reach the shell, so the missing key is the
 * scrub's doing. Removing the five keys from the scrub list turns this test
 * red (checked when it was written).
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ResidentAcpHarness } from '../../../../tests/integration/fixtures/resident-acp-harness.js'
import { resetSettingsCache } from '../../../utils/settings/settingsCache.js'
import {
  commitPendingProviderConfig,
  currentManagedHash,
  readProviderState,
  stageProviderApply,
} from '../providers/node.js'
import { applyRequest } from '../providers/__tests__/helpers.js'

const KEY = 'sk-test-canary-acp-bash-scrub-2Wn7'
const TEST_TIMEOUT_MS = 240_000

function chatProfile(baseUrl: string, revision: number) {
  return {
    id: 'scrub-check',
    revision,
    lane: 'openai-chat',
    baseUrl,
    auth: { scheme: 'bearer', keys: [{ id: 'k1', value: KEY }] },
    models: [
      {
        id: 'resident-permission-double',
        role: 'main',
        tiers: ['opus', 'sonnet', 'haiku', 'fable'],
        capabilities: { mode: 'family' },
        effort: { send: 'auto' },
      },
    ],
    compat: {},
  }
}

function applyAndCommit(baseUrl: string, revision: number): void {
  const managed = readProviderState().managed
  const staged = stageProviderApply(
    applyRequest({
      expect: { ownedHash: managed ? currentManagedHash() : null },
      profile: chatProfile(baseUrl, revision),
    }),
  )
  if (!staged.ok) throw new Error(JSON.stringify(staged))
  expect(commitPendingProviderConfig().status).toBe('committed')
}

describe('a managed node’s ACP child: Bash cannot read the model key', () => {
  let root: string
  let config: string
  let workspace: string
  let harness: ResidentAcpHarness
  const previous = process.env.CLAUDE_CONFIG_DIR

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'qm-acp-scrub-'))
    config = join(root, 'config')
    workspace = join(root, 'ws')
    mkdirSync(config, { mode: 0o700 })
    chmodSync(config, 0o700)
    mkdirSync(workspace)
    // The host's own config root is the child's: residentAcpEnvironment()
    // reads whether the node is managed from this process's root.
    process.env.CLAUDE_CONFIG_DIR = config
    resetSettingsCache()
    applyAndCommit('http://127.0.0.1:9/v1', 1)
    harness = new ResidentAcpHarness(config)
    await harness.start()
    applyAndCommit(`http://127.0.0.1:${harness.modelPort}/v1`, 2)
  }, TEST_TIMEOUT_MS)

  afterAll(async () => {
    await harness?.stop()
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previous
    resetSettingsCache()
    rmSync(root, { recursive: true, force: true })
  }, 30_000)

  test(
    'echo $OPENAI_API_KEY prints nothing; the profile’s other env does arrive',
    async () => {
      const result = await harness.run({
        id: 'scrub',
        mode: 'default',
        cwd: workspace,
        hostPolicy: () => true,
        steps: [
          {
            name: 'Bash',
            input: {
              command:
                'echo "QMK=${OPENAI_API_KEY:-unset} QMU=${OPENAI_BASE_URL:-unset}' +
                ' QMP=${CLAUDE_CODE_USE_OPENAI:-unset}' +
                ' QMS=${CLAUDE_CODE_SUBPROCESS_ENV_SCRUB:-unset}"',
              description: 'print the model environment',
            },
          },
        ],
      })
      const output = result.toolResults.join('\n')
      // The command ran: the host approved it and its output came back.
      expect(result.hostRequests.some(r => r.answered === 'allow')).toBe(true)
      expect(output).toContain('QMK=unset')
      expect(output).not.toContain(KEY)
      // Positive control: settings.json env reaches the shell.
      expect(output).toContain(`QMU=http://127.0.0.1:${harness.modelPort}/v1`)
      // The harness's parent env names the model with CLAUDE_CODE_USE_OPENAI;
      // a managed node's child does not inherit it.
      expect(output).toContain('QMP=unset')
      expect(output).toContain('QMS=1')
    },
    TEST_TIMEOUT_MS,
  )
})
