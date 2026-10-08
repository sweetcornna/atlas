// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `qm resident` and the provider hot switch, end to end (design
 * `providers-console-m1.md` §2.7, P18.3): the shipped entrypoint from source,
 * its pid file, its SIGHUP handler, the 5 s poll, and the ACP child it
 * replaces — observed from outside, the way an operator or `qm provider apply`
 * (P18.7) would.
 *
 * What is not real: the model endpoints, two loopback doubles that answer
 * every request 200 and record who asked with which key. The keys are
 * `sk-test-canary-…` strings. The child's process environment names a model
 * the way the fleet's do, so the double behind it doubles as the positive
 * control that the startup probe ran at all.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  macroDefineArgs,
  resolveBuildFeatures,
} from '../../../../scripts/defines.js'
import * as providerNode from '../../../services/qianmo/providers/node.js'
import { applyRequest } from '../../../services/qianmo/providers/__tests__/helpers.js'
import type { ResidentProviderSwitchEvent } from '../../../services/qianmo/resident.js'
import { resetSettingsCache } from '../../../utils/settings/settingsCache.js'
import { signalResidentProviderCheck } from '../resident.js'

const PSK = 'resident-hot-switch-cli-not-a-real-secret'
const CLI_ENTRYPOINT = join(
  import.meta.dir,
  '..',
  '..',
  '..',
  'entrypoints',
  'cli.tsx',
)
const BOOT_MS = 90_000
const TEST_TIMEOUT_MS = 180_000
const KEY_PROCESS = 'sk-test-canary-cli-process-env-4Fv1'
const KEY_A = 'sk-test-canary-cli-hot-switch-a-8Tq6'
const KEY_B = 'sk-test-canary-cli-hot-switch-b-2Mz0'

interface Seen {
  readonly path: string
  readonly authorization: string
}

/** Answers everything 200 with the trivial Chat Completions shape. */
function startDouble(): {
  readonly baseUrl: string
  readonly seen: Seen[]
  stop(): Promise<void>
} {
  const seen: Seen[] = []
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(request) {
      seen.push({
        path: new URL(request.url).pathname,
        authorization: request.headers.get('authorization') ?? '',
      })
      return Response.json({
        id: 'double',
        object: 'chat.completion',
        created: 1,
        model: 'double',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'ok' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      })
    },
  })
  return {
    baseUrl: `http://127.0.0.1:${String(server.port)}/v1`,
    seen,
    stop: () => server.stop(true),
  }
}

async function waitUntil(
  predicate: () => boolean,
  what: string,
  timeoutMs: number,
  diagnose: () => string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error(
    `timed out waiting for ${what} (${timeoutMs}ms)\n${diagnose()}`,
  )
}

/** Live `--acp` children of `parent`, from the process table. */
function acpChildrenOf(parent: number): number[] {
  const table = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,command='], {
    encoding: 'utf8',
  })
  const pids: number[] = []
  for (const line of table.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)
    if (match === null) continue
    if (Number(match[2]) === parent && (match[3] as string).includes('--acp')) {
      pids.push(Number(match[1]))
    }
  }
  return pids
}

function chatProfile(
  baseUrl: string,
  model: string,
  key: string,
  revision: number,
): Record<string, unknown> {
  return {
    id: 'cli-hot-switch',
    revision,
    lane: 'openai-chat',
    baseUrl,
    auth: { scheme: 'bearer', keys: [{ id: 'k1', value: key }] },
    models: [
      {
        id: model,
        role: 'main',
        tiers: ['opus', 'sonnet', 'haiku', 'fable'],
        capabilities: { mode: 'family' },
        effort: { send: 'auto' },
      },
    ],
    compat: {},
  }
}

/** Stage an apply the way `qm provider serve-stdin` will (P18.7). */
function stage(profile: Record<string, unknown>): string {
  const managed = providerNode.readProviderState().managed
  const result = providerNode.stageProviderApply(
    applyRequest({
      expect: { ownedHash: managed ? providerNode.currentManagedHash() : null },
      recycle: { sessions: 'reset' },
      profile,
    }),
  )
  if (!result.ok) throw new Error(JSON.stringify(result))
  expect(result.pending).toBe(true)
  return result.requestId
}

interface SwitchLine {
  readonly node: string
  readonly providerSwitch: ResidentProviderSwitchEvent
}

describe('qm resident: hot switch from the outside', () => {
  let root: string
  let config: string
  let resident: ChildProcess
  let output = ''
  let stdout = ''
  let residentPid = 0
  let firstAcp = 0
  let processModel: ReturnType<typeof startDouble>
  let modelA: ReturnType<typeof startDouble>
  let modelB: ReturnType<typeof startDouble>
  const previous = {
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
    OCC_CONFIG_DIR: process.env.OCC_CONFIG_DIR,
  }

  const diagnose = () => `resident output (tail):\n${output.slice(-4_000)}`
  const switchLines = (): SwitchLine[] =>
    stdout
      .split('\n')
      .filter(line => line.includes('"providerSwitch"'))
      .map(line => JSON.parse(line) as SwitchLine)
  const generation = (): number =>
    (
      JSON.parse(
        readFileSync(
          join(config, 'qianmo', 'provider', 'generation.json'),
          'utf8',
        ),
      ) as { generation: number }
    ).generation
  const residentAlive = () =>
    resident.exitCode === null && resident.signalCode === null

  beforeAll(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'qm-hsc-')))
    config = join(root, 'config')
    const workspace = join(root, 'ws')
    const home = join(root, 'home')
    mkdirSync(config, { mode: 0o700 })
    chmodSync(config, 0o700)
    mkdirSync(workspace)
    mkdirSync(home)
    process.env.CLAUDE_CONFIG_DIR = config
    delete process.env.OCC_CONFIG_DIR
    resetSettingsCache()
    processModel = startDouble()
    modelA = startDouble()
    modelB = startDouble()

    resident = spawn(
      process.execPath,
      [
        'run',
        ...macroDefineArgs(),
        '-d',
        `process.env.NODE_ENV:${JSON.stringify('production')}`,
        ...[...resolveBuildFeatures()].flatMap(name => ['--feature', name]),
        CLI_ENTRYPOINT,
        'resident',
        '--node',
        'node-b',
        '--team',
        'nest',
        '--agent',
        `reviewer=${workspace}`,
        '--unix',
        join(root, 'r.sock'),
        '--open-policy',
      ],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          PATH: process.env.PATH,
          HOME: home,
          TMPDIR: tmpdir(),
          NODE_ENV: 'production',
          NO_COLOR: '1',
          DISABLE_TELEMETRY: '1',
          DISABLE_AUTOUPDATER: '1',
          OCC_IDENTITY: 'qianmo',
          OCC_CONFIG_DIR: config,
          QIANMO_TRANSPORT_PSK: PSK,
          CLAUDE_CODE_USE_OPENAI: '1',
          OPENAI_BASE_URL: processModel.baseUrl,
          OPENAI_API_KEY: KEY_PROCESS,
          OPENAI_MODEL: 'process-env-model',
          OPENAI_WIRE_API: 'chat',
        },
      },
    )
    resident.stdout?.on('data', chunk => {
      output += String(chunk)
      stdout += String(chunk)
    })
    resident.stderr?.on('data', chunk => {
      output += String(chunk)
    })
    residentPid = resident.pid as number
    await waitUntil(
      () => existsSync(join(root, 'r.sock')) || !residentAlive(),
      'the resident to listen',
      BOOT_MS,
      diagnose,
    )
    if (!residentAlive()) throw new Error(`resident exited\n${diagnose()}`)
    await waitUntil(
      () => acpChildrenOf(residentPid).length === 1,
      'the first ACP child',
      BOOT_MS,
      diagnose,
    )
    firstAcp = acpChildrenOf(residentPid)[0] as number
  }, BOOT_MS * 2)

  afterAll(async () => {
    if (resident !== undefined && residentAlive()) {
      resident.kill('SIGKILL')
      await once(resident, 'exit')
    }
    await Promise.all(
      [processModel, modelA, modelB].map(double => double?.stop()),
    )
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    resetSettingsCache()
    rmSync(root, { recursive: true, force: true })
  }, 30_000)

  test(
    'the pid file names the resident; a SIGHUP with nothing pending changes nothing',
    async () => {
      const record = JSON.parse(
        readFileSync(join(config, 'resident', 'resident.pid'), 'utf8'),
      ) as { pid: number; startedAt: string }
      expect(record.pid).toBe(residentPid)
      // What P18.7 will call. Off Linux there is no start time to check, so
      // it never signals; on Linux it signals this resident.
      expect(signalResidentProviderCheck()).toEqual(
        process.platform === 'linux'
          ? { signalled: true, pid: residentPid }
          : { signalled: false, reason: 'unverifiable' },
      )
      await waitUntil(
        () => processModel.seen.length > 0,
        'the startup probe (positive control)',
        30_000,
        diagnose,
      )
      expect(processModel.seen[0]?.authorization).toBe(`Bearer ${KEY_PROCESS}`)

      for (let i = 0; i < 3; i++) process.kill(residentPid, 'SIGHUP')
      await new Promise(resolve => setTimeout(resolve, 1_500))

      expect(residentAlive()).toBe(true)
      expect(acpChildrenOf(residentPid)).toEqual([firstAcp])
      expect(switchLines()).toEqual([])
      expect(generation()).toBe(1)
      expect(existsSync(join(config, 'settings.json'))).toBe(false)
      expect(existsSync(join(config, 'resident', 'provider-switch.json'))).toBe(
        false,
      )
    },
    TEST_TIMEOUT_MS,
  )

  test(
    'SIGHUP with an intent staged: committed, ACP child replaced, resident pid unchanged',
    async () => {
      const requestId = stage(
        chatProfile(modelA.baseUrl, 'cli-model-a', KEY_A, 1),
      )
      process.kill(residentPid, 'SIGHUP')
      await waitUntil(
        () => switchLines().length === 1,
        'the providerSwitch line',
        30_000,
        diagnose,
      )
      expect(switchLines()[0]).toEqual({
        node: 'node-b',
        providerSwitch: {
          requestId,
          sessions: 'reset',
          recovered: false,
          via: 'switch',
        },
      })
      await waitUntil(
        () => {
          const now = acpChildrenOf(residentPid)
          return now.length === 1 && now[0] !== firstAcp
        },
        'the replacement ACP child',
        BOOT_MS,
        diagnose,
      )
      expect(residentAlive()).toBe(true)
      expect(resident.pid).toBe(residentPid)
      expect(generation()).toBe(2)
      expect(providerNode.hasPendingProviderConfig()).toBe(false)
      // The credential probe re-ran against the committed endpoint and key.
      await waitUntil(
        () => modelA.seen.length > 0,
        'the re-probe at model a',
        30_000,
        diagnose,
      )
      expect(modelA.seen[0]?.authorization).toBe(`Bearer ${KEY_A}`)
    },
    TEST_TIMEOUT_MS,
  )

  test(
    'with no signal at all the 5 s poll finds the intent (the only path off Linux)',
    async () => {
      const before = acpChildrenOf(residentPid)
      const requestId = stage(
        chatProfile(modelB.baseUrl, 'cli-model-b', KEY_B, 2),
      )
      await waitUntil(
        () => switchLines().length === 2,
        'the second providerSwitch line',
        30_000,
        diagnose,
      )
      expect(switchLines()[1]?.providerSwitch.requestId).toBe(requestId)
      await waitUntil(
        () => {
          const now = acpChildrenOf(residentPid)
          return now.length === 1 && now[0] !== before[0]
        },
        'the third ACP child',
        BOOT_MS,
        diagnose,
      )
      expect(generation()).toBe(3)
      await waitUntil(
        () => modelB.seen.length > 0,
        'the re-probe at model b',
        30_000,
        diagnose,
      )
      expect(modelB.seen[0]?.authorization).toBe(`Bearer ${KEY_B}`)
      expect(residentAlive()).toBe(true)
    },
    TEST_TIMEOUT_MS,
  )

  test(
    'SIGTERM: the resident exits and removes its pid file',
    async () => {
      resident.kill('SIGTERM')
      await waitUntil(
        () => !residentAlive(),
        'the resident to exit',
        30_000,
        diagnose,
      )
      expect(existsSync(join(config, 'resident', 'resident.pid'))).toBe(false)
      expect(acpChildrenOf(residentPid)).toEqual([])
    },
    TEST_TIMEOUT_MS,
  )
})
