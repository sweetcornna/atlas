// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 中枢端口 → 本机 local 执行器 → **真** `qm provider serve-stdin`（P18.7，从源码起）的
 * 端到端（P18.6）。配置根在临时目录，零 `mock.module`，不碰任何厂商。
 *
 * 节点就是 `--provider-local <node>=<命令>` 那条路：执行器起 `<命令> <节点名>`、只给最小
 * 环境、请求走 stdin。命令是一个小包装，它像内测的 `model-apply.sh` 一样自己设好
 * `OCC_IDENTITY=qianmo` 与 `OCC_CONFIG_DIR`，再从源码起 CLI（`providerSource.ts` 的
 * `sourceLaunch`，与 P18.7 自己的用例同一种起法）。
 *
 * 三类操作各一条成功、一条节点侧拒绝：
 *
 * - status：成功时带回节点用真实门控函数算的 `effective`；包装把 `--node` 换成别的名字时，
 *   节点以 `node-mismatch` 拒绝，中枢标「刷新失败」。
 * - apply：dry-run 成功（只回键名）、dry-run 遇 `node-mismatch` 拒绝；真写成功（节点
 *   `settings.json` 0600，`effective.contextTokens` 是 D-8 的 200 000）；节点上的受管键被
 *   手改后再下发，节点以 `conflict` 拒绝，`force` 之后成功。
 * - autocompact：写 150 000 成功（来源 settings）；节点进程环境里有
 *   `CLAUDE_CODE_AUTO_COMPACT_WINDOW` 时，节点以 `env-override` 拒绝。
 *
 * 动作账本用真 `ActionLedger` + `MemoryActionStore`：下发的 ok 与 refused 各记成节点
 * 回报的那个结果。
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ActionLedger,
  type ProviderCaller,
  type ProviderProfileDraft,
} from '@qianmo/console'
import { MemoryActionStore } from '../../../../packages/console/test/actionStore.js'
import {
  type ConsoleProviders,
  openConsoleProviders,
  type ProviderScheduler,
} from '../consoleProviders.js'
import { childEnv, sourceLaunch } from './providerSource.js'

const CANARY = 'sk-test-canary-serve-stdin-Qw81Zt4LmB0x'
const CANARY_2 = 'sk-test-canary-serve-stdin-two-Hc05Vy'
const OPS = 'u:0fedcba987654321'
const NODE = 'beta-1'
/** Each step starts this CLI from source (status twice: it computes `effective` in a child). */
const STEP_TIMEOUT_MS = 240_000

const STILL: ProviderScheduler = { set: () => null, clear: () => {} }

/** The hub's clock; tests move it past the 5 s status throttle instead of sleeping. */
let skew = 0
const later = () => {
  skew += 10_000
}

let root: string
let config: string
let port: ConsoleProviders
let ledger: ActionLedger
let ledgerStore: MemoryActionStore
const ledgerText = () => ledgerStore.text ?? ''

/** The executable the local executor runs as `<command> <node>`. */
function writeNodeCommand(): string {
  const launch = sourceLaunch(
    ['provider', 'serve-stdin', '--node'],
    childEnv({
      OCC_IDENTITY: 'qianmo',
      OCC_CONFIG_DIR: config,
      HOME: root,
    }),
  )
  writeFileSync(
    join(root, 'launch.json'),
    JSON.stringify({
      execPath: launch.execPath,
      args: launch.args,
      env: launch.env,
    }),
  )
  // Steering files, read on every run: `serve-as` (the forced command names
  // another node) and `env-override` (the node's own process environment
  // pins the auto-compact window).
  writeFileSync(
    join(root, 'launch.mjs'),
    `import { existsSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
const root = ${JSON.stringify(root)}
const spec = JSON.parse(readFileSync(root + '/launch.json', 'utf8'))
let node = process.argv[2]
if (existsSync(root + '/serve-as')) node = readFileSync(root + '/serve-as', 'utf8').trim()
const env = { ...spec.env }
if (existsSync(root + '/env-override')) {
  env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = readFileSync(root + '/env-override', 'utf8').trim()
}
const run = spawnSync(spec.execPath, [...spec.args, node], { stdio: 'inherit', env, cwd: root })
process.exit(run.status ?? 2)
`,
  )
  const command = join(root, 'node.sh')
  writeFileSync(
    command,
    `#!/bin/sh\nexec '${process.execPath}' '${join(root, 'launch.mjs')}' "$@"\n`,
  )
  chmodSync(command, 0o755)
  return command
}

function caller(): ProviderCaller {
  const requestId = randomUUID()
  return {
    subject: OPS,
    role: 'ops',
    breakGlass: false,
    record: async (action, target, outcome, code) =>
      (
        await ledger.record({
          at: Date.now(),
          requestId,
          subject: OPS,
          action,
          target,
          outcome,
          ...(code === undefined ? {} : { code }),
        })
      ).ok,
  }
}

function value<T>(
  result: { ok: true; value: T } | { ok: false; failure: unknown },
): T {
  if (!result.ok) throw new Error(JSON.stringify(result.failure))
  return result.value
}

const DRAFT: ProviderProfileDraft = {
  id: 'luna',
  name: 'Luna 网关',
  presetId: null,
  plan: 'custom',
  site: null,
  lane: 'openai-responses',
  baseUrl: 'https://gateway.vendor.example/v1',
  auth: { scheme: 'bearer' },
  keys: [{ id: 'k1' }],
  models: [
    {
      id: 'gpt-6-luna',
      role: 'main',
      tiers: ['opus', 'sonnet', 'fable'],
      capabilities: {
        mode: 'explicit',
        thinking: false,
        adaptive_thinking: false,
        interleaved_thinking: false,
      },
      effort: {
        send: 'always',
        levels: ['low', 'medium', 'high', 'max'],
        level: 'max',
      },
    },
  ],
  evaluated: false,
}

function settings(): { env?: Record<string, string> } {
  return JSON.parse(readFileSync(join(config, 'settings.json'), 'utf8')) as {
    env?: Record<string, string>
  }
}

beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'qianmo-serve-stdin-e2e-')))
  config = join(root, 'config')
  mkdirSync(config, { mode: 0o700 })
  const command = writeNodeCommand()
  port = openConsoleProviders({
    storePath: join(root, 'hub', 'providers.ndjson'),
    secretsPath: join(root, 'hub', 'provider-secrets.json'),
    keyPath: join(root, 'hub-keys', 'provider-master.key'),
    knownHostsFile: join(root, 'hub-keys', 'known_hosts'),
    nodes: [{ node: NODE, kind: 'local', command }],
    onAlarm: () => {},
    now: () => Date.now() + skew,
    scheduler: STILL,
  })
  ledgerStore = new MemoryActionStore()
  ledger = new ActionLedger({ store: ledgerStore })
  value(
    await port.saveProfile(
      { profile: DRAFT, ifMatch: null, secrets: { k1: CANARY } },
      caller(),
    ),
  )
  value(await port.setDefault({ profileId: 'luna' }, caller()))
})

afterAll(() => {
  port.stop()
  rmSync(root, { recursive: true, force: true })
})

/** Run `body` with a steering file in place, removing it afterwards. */
async function steered<T>(
  name: string,
  content: string,
  body: () => Promise<T>,
): Promise<T> {
  writeFileSync(join(root, name), content)
  try {
    return await body()
  } finally {
    rmSync(join(root, name), { force: true })
  }
}

/** `[action, outcome, code]` of the ledger records under `prefix`, oldest first. */
async function recorded(
  prefix: string,
): Promise<[string, string, string | undefined][]> {
  const page = await ledger.list({ actionPrefix: prefix, limit: 50 })
  if (!page.ok) throw new Error(page.failure.message)
  return [...page.value.entries]
    .reverse()
    .map(record => [record.action, record.outcome, record.code])
}

// The cases build on each other (an apply needs the status before it, the
// conflict needs the apply), so they run in order in one describe.
describe('the hub against the real qm provider serve-stdin (local executor)', () => {
  test(
    'status: the node answers with its state and its own effective values',
    async () => {
      const view = value(await port.refreshNode(NODE))
      expect(view.lastStatus?.ok).toBe(true)
      expect(view.actual?.managed).toBe(false)
      expect(view.actual?.capabilities.protocol).toBe(1)
      expect(typeof view.actual?.effective?.model).toBe('string')
      expect(view.drift.map(item => item.kind)).toContain('unmanaged')
    },
    STEP_TIMEOUT_MS,
  )

  test(
    'status refused: a forced command naming another node gets node-mismatch',
    async () => {
      later()
      const view = await steered('serve-as', 'beta-9', async () =>
        value(await port.refreshNode(NODE)),
      )
      expect(view.lastStatus?.ok).toBe(false)
      expect(view.lastStatus?.message ?? '').toContain('节点名与本节点不符')
      expect(view.drift.map(item => item.kind)).toContain('unreachable')
      // The last good state is kept, marked stale.
      expect(view.actual?.managed).toBe(false)
    },
    STEP_TIMEOUT_MS,
  )

  test(
    'apply dry-run: validated and diffed by the node, nothing written; refused for the wrong node',
    async () => {
      const [dry] = value(
        await port.apply({ nodes: [NODE], dryRun: true }, caller()),
      )
      expect(dry?.outcome).toBe('ok')
      // P18.7 says `env.OPENAI_API_KEY`, `modelType`; the hub shows env keys bare.
      expect(dry?.diffKeys ?? []).toContain('OPENAI_API_KEY')
      expect(dry?.diffKeys ?? []).toContain('modelType')
      expect(dry?.diffKeys ?? []).toContain('modelSettings.default')
      expect(
        (dry?.diffKeys ?? []).filter(key => key.startsWith('env.')),
      ).toEqual([])
      expect(JSON.stringify(dry)).not.toContain(CANARY)
      expect(() => statSync(join(config, 'settings.json'))).toThrow()

      const [refused] = await steered('serve-as', 'beta-9', async () =>
        value(await port.apply({ nodes: [NODE], dryRun: true }, caller())),
      )
      expect([refused?.outcome, refused?.code]).toEqual([
        'refused',
        'node-mismatch',
      ])
      // Dry-runs are not recorded.
      expect(await recorded('provider.apply')).toEqual([])
    },
    STEP_TIMEOUT_MS,
  )

  test(
    'apply: written to the node (0600), effective context 200 000; a local edit is refused as conflict until forced',
    async () => {
      const [applied] = value(await port.apply({ nodes: [NODE] }, caller()))
      expect([applied?.outcome, applied?.pending]).toEqual(['ok', false])
      expect(statSync(join(config, 'settings.json')).mode & 0o777).toBe(0o600)
      expect(settings().env?.OPENAI_API_KEY).toBe(CANARY)

      later()
      const view = value(await port.refreshNode(NODE))
      expect(view.actual?.applied?.profileId).toBe('luna')
      // D-8 end to end: the node's own gate functions see the default window.
      expect(view.actual?.effective?.contextTokens).toBe(200_000)
      // Committed by `qm provider` itself (no resident here, so no pid file):
      // nothing has loaded it yet, and the page says the node is not running.
      expect(view.actual?.resident).toBeNull()
      expect(view.drift).toEqual([
        { kind: 'not-loaded', message: '节点未运行 · 下次启动时加载' },
      ])

      // Somebody edits a managed key on the node.
      const edited = settings()
      writeFileSync(
        join(config, 'settings.json'),
        JSON.stringify({
          ...edited,
          env: {
            ...edited.env,
            OPENAI_BASE_URL: 'https://elsewhere.example/v1',
          },
        }),
        { mode: 0o600 },
      )
      const [conflict] = value(await port.apply({ nodes: [NODE] }, caller()))
      expect([conflict?.outcome, conflict?.code]).toEqual([
        'refused',
        'conflict',
      ])
      expect(settings().env?.OPENAI_BASE_URL).toBe(
        'https://elsewhere.example/v1',
      )

      const [forced] = value(
        await port.apply({ nodes: [NODE], force: true }, caller()),
      )
      expect(forced?.outcome).toBe('ok')
      expect(settings().env?.OPENAI_BASE_URL).toBe(
        'https://gateway.vendor.example/v1',
      )
      expect(await recorded('provider.apply')).toEqual([
        ['provider.apply', 'ok', undefined],
        ['provider.apply', 'refused', 'conflict'],
        ['provider.apply.force', 'ok', undefined],
      ])
    },
    STEP_TIMEOUT_MS,
  )

  test(
    'autocompact: the node writes its own window; refused while its environment pins one',
    async () => {
      const set = value(
        await port.autocompact({ node: NODE, value: 150_000 }, caller()),
      )
      expect([set.configured, set.autoCompactWindow, set.source]).toEqual([
        150_000,
        150_000,
        'settings',
      ])
      const refused = await steered('env-override', '300000', () =>
        port.autocompact({ node: NODE, value: 120_000 }, caller()),
      )
      expect(
        refused.ok ? 'ok' : [refused.failure.code, refused.failure.nodeCode],
      ).toEqual(['refused', 'env-override'])
      // The refused write left the node's value alone.
      const read = value(await port.autocompact({ node: NODE }, caller()))
      expect([read.configured, read.source]).toEqual([150_000, 'settings'])
      // A read is not recorded.
      expect(await recorded('provider.autocompact')).toEqual([
        ['provider.autocompact', 'ok', undefined],
        ['provider.autocompact', 'refused', 'env-override'],
      ])
    },
    STEP_TIMEOUT_MS,
  )

  test(
    'P18.18: a second key — the node reports multiKey, takes both, keeps the second in key-pool.json (0600) and nowhere else',
    async () => {
      const current = value(await port.profile('luna'))
      value(
        await port.saveProfile(
          {
            profile: {
              ...DRAFT,
              keys: [{ id: 'k1' }, { id: 'k2' }],
              keySelection: 'least_used',
            },
            ifMatch: current.revision,
            secrets: { k2: CANARY_2 },
          },
          caller(),
        ),
      )
      later()
      const before = value(await port.refreshNode(NODE))
      expect(before.actual?.capabilities.multiKey).toBe(true)

      const [applied] = value(
        await port.apply({ nodes: [NODE], force: true }, caller()),
      )
      expect(applied?.outcome).toBe('ok')
      // settings.json: the primary only.
      expect(settings().env?.OPENAI_API_KEY).toBe(CANARY)
      const poolPath = join(config, 'qianmo', 'provider', 'key-pool.json')
      expect(statSync(poolPath).mode & 0o777).toBe(0o600)
      const pool = JSON.parse(readFileSync(poolPath, 'utf8')) as {
        selection: string
        keys: { id: string; value: string }[]
      }
      expect(pool.selection).toBe('least_used')
      expect(pool.keys).toEqual([
        { id: 'k1', value: CANARY },
        { id: 'k2', value: CANARY_2 },
      ])

      // The second key: in key-pool.json and on no other surface — the hub's
      // book, sealed store and ledger, the node's state files, the replies.
      const holders: string[] = []
      const walk = (dir: string) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const path = join(dir, entry.name)
          if (entry.isDirectory()) walk(path)
          else if (readFileSync(path).includes(Buffer.from(CANARY_2))) {
            holders.push(path.slice(root.length + 1))
          }
        }
      }
      walk(root)
      expect(holders).toEqual(['config/qianmo/provider/key-pool.json'])
      expect(ledgerText()).not.toContain(CANARY_2)
      expect(JSON.stringify([before, applied])).not.toContain(CANARY_2)
    },
    STEP_TIMEOUT_MS,
  )
})
