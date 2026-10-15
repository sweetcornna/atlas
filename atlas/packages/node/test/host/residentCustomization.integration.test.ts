// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * P14.0 on omp, against a real omp RPC child: a resident turn's system prompt
 * carries nothing from the service account's home, the node's own omp
 * directory or the workspace — no skills, rules, context files, `SYSTEM.md`
 * replacement or `APPEND_SYSTEM.md` — and no workspace custom tool runs. With
 * `allowUserCustomization` the same files are all loaded, which is what keeps
 * the first test from passing for want of anything to load.
 *
 * The child's `HOME` is the test's own (built the way `residentOmpEnvironment`
 * builds it), so what it finds there is what the test planted.
 */

import { afterEach, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { TransportClient } from '@qianmo/transport'
import {
  createMessage,
  MessageType,
  type QianmoMessage,
} from '@qianmo/protocol'
import { ompAgentDir } from '@qianmo/paths'
import { QianmoResident } from '../../src/host/resident.js'
import { residentOmpEnvironment } from '../../src/host/residentOmpEnv.js'
import { ResidentOmpHarness } from '../../../../tests/integration/fixtures/resident-omp-harness.js'

const PSK = 'test-resident-customization-no-secret'
const PROMPT = 'Run the customization probe.'

/** Planted text the system prompt must not carry by default, and must with the switch. */
const CANARIES = {
  homeSkill: 'qm-home-skill',
  nodeSkill: 'qm-node-skill',
  workspaceSkill: 'qm-workspace-skill',
  homeRule: 'QM-HOME-RULE-BODY',
  workspaceRule: 'QM-WORKSPACE-RULE-BODY',
  agentsMd: 'QM-WORKSPACE-AGENTS-MD',
  systemMd: 'QM-WORKSPACE-SYSTEM-MD',
  appendSystemMd: 'QM-APPEND-SYSTEM-MD',
} as const

let root: string | undefined
let previousConfigDir: string | undefined
let harness: ResidentOmpHarness | undefined
let resident: QianmoResident | undefined
let running: Promise<void> | undefined
let client: TransportClient | undefined

afterEach(async () => {
  resident?.stop()
  await running
  await client?.close()
  await harness?.stop()
  if (previousConfigDir === undefined) delete process.env.QIANMO_CONFIG_DIR
  else process.env.QIANMO_CONFIG_DIR = previousConfigDir
  if (root) rmSync(root, { recursive: true, force: true })
  root = resident = running = client = harness = undefined
})

function put(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

const skill = (name: string): string =>
  `---\nname: ${name}\ndescription: Planted by the customization test.\n---\n\nNothing to do.\n`
const rule = (body: string): string =>
  `---\ndescription: Planted by the customization test.\nalwaysApply: true\n---\n\n${body}\n`

/** One user-level, node-level and project-level file of each kind omp loads. */
function plant(home: string, workspace: string, marker: string): void {
  put(
    join(home, '.agents/skills', CANARIES.homeSkill, 'SKILL.md'),
    skill(CANARIES.homeSkill),
  )
  put(join(home, '.agents/rules/home.md'), rule(CANARIES.homeRule))
  put(
    join(ompAgentDir(), 'skills', CANARIES.nodeSkill, 'SKILL.md'),
    skill(CANARIES.nodeSkill),
  )
  // `.agents/` and the workspace root are outside the extension's protected
  // workspace directories: the agent itself could write these.
  put(
    join(workspace, '.agents/skills', CANARIES.workspaceSkill, 'SKILL.md'),
    skill(CANARIES.workspaceSkill),
  )
  put(
    join(workspace, '.agents/rules/workspace.md'),
    rule(CANARIES.workspaceRule),
  )
  put(join(workspace, 'AGENTS.md'), `${CANARIES.agentsMd}\n`)
  put(join(workspace, '.agents/SYSTEM.md'), `${CANARIES.systemMd}\n`)
  // `.omp/` is protected from the agent's own writes, but whatever put it
  // there, the child must not run or read it either.
  put(join(workspace, '.omp/APPEND_SYSTEM.md'), `${CANARIES.appendSystemMd}\n`)
  put(
    join(workspace, '.omp/tools/qm-probe-tool/index.ts'),
    `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(marker)}, 'loaded')\nexport default function () {}\n`,
  )
}

async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 2000; i++) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('resident customization probe timed out')
}

async function runTurn(allowUserCustomization: boolean) {
  root = mkdtempSync(join(tmpdir(), 'ResidentCustomization-'))
  previousConfigDir = process.env.QIANMO_CONFIG_DIR
  process.env.QIANMO_CONFIG_DIR = join(root, 'config')
  const home = join(root, 'home')
  const workspace = join(root, 'workspace')
  const marker = join(root, 'custom-tool-loaded')
  mkdirSync(home)
  mkdirSync(workspace)
  harness = new ResidentOmpHarness()
  plant(home, workspace, marker)

  const argv: string[][] = []
  const postures: Record<string, unknown>[] = []
  const errors: unknown[] = []
  const unix = join(root, 'resident.sock')
  resident = new QianmoResident({
    node: 'node-b',
    team: 'nest',
    agents: [{ agent: 'reviewer', cwd: workspace }],
    psk: PSK,
    listen: { unix },
    pollIntervalMs: 20,
    allowWorkspaceEdits: true,
    ...(allowUserCustomization ? { allowUserCustomization } : {}),
    runtimeAudit: event => {
      if (event.kind === 'authz.posture' && event.detail?.sessionId)
        postures.push(event.detail)
    },
    spawnOmp: input => {
      argv.push([...input.argv])
      return spawn(input.argv[0]!, input.argv.slice(1), {
        cwd: input.cwd,
        env: residentOmpEnvironment({ ...input.env, HOME: home }),
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    },
    onError: error => errors.push(error),
  })
  running = resident.run()
  await until(() => existsSync(unix))
  const received: QianmoMessage[] = []
  client = new TransportClient({
    endpoint: { unix },
    node: 'hub',
    psk: PSK,
    onMessage: message => {
      received.push(message)
    },
  })
  await client.connect()
  await client.send(
    createMessage({
      type: MessageType.TaskRequest,
      from: 'qianmo://hub/operator',
      to: 'qianmo://node-b/reviewer',
      payload: { taskId: 'customization-probe', prompt: PROMPT },
    }),
  )
  await until(() => received.some(item => item.type === MessageType.TaskResult))
  expect(
    received.find(item => item.type === MessageType.TaskResult)?.payload,
  ).toMatchObject({ outcome: 'completed', content: 'pong' })
  expect(errors).toEqual([])
  const turn = harness.requests
    .map(request => JSON.stringify(request))
    .find(text => text.includes(PROMPT))
  expect(turn).toBeDefined()
  return { turn: turn!, argv, postures, toolLoaded: existsSync(marker) }
}

test('by default the child loads no user, node or workspace customization', async () => {
  const { turn, argv, postures, toolLoaded } = await runTurn(false)
  for (const canary of Object.values(CANARIES))
    expect(turn).not.toContain(canary)
  expect(turn).not.toContain('<skills>')
  expect(toolLoaded).toBe(false)
  expect(argv[0]).toEqual(expect.arrayContaining(['--no-skills', '--no-rules']))
  expect(postures.map(posture => posture.safeMode)).toEqual([true])
}, 30_000)

test('--allow-user-customization restores omp discovery of the same files', async () => {
  const { turn, argv, postures, toolLoaded } = await runTurn(true)
  for (const canary of Object.values(CANARIES)) expect(turn).toContain(canary)
  expect(toolLoaded).toBe(true)
  expect(argv[0]).not.toContain('--no-skills')
  expect(postures.map(posture => posture.safeMode)).toEqual([false])
}, 30_000)
