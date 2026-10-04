// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 每轮真机验收（P18.13，AC-P6）的用例：假控制台 + 假舰队，真扫描器。
 *
 * - **假控制台**（Bun.serve，只听回环）按 `@qianmo/console` 的类型拼响应：节点视图、测连、
 *   下发（pending → resident 等在途 → 换代）、指派、档案存取、导出、页面、对话。类型从真包里
 *   import，真接口改了字段这里就编不过。
 * - **假舰队**：两台「机器」是两个临时家目录，各有内测根（pid 文件指着真活着的 `sleep`、
 *   启动横幅、节点配置根里的 `settings.json` / `key-pool.json`）与部署树（`dist/cli-node.js`、
 *   软链回仓库的 `provider-acceptance-node.ts`）。`QIANMO_ACCEPTANCE_SSH_BIN` 指向一个
 *   ssh 桩：按目标找到那台机器的家目录、`bash -c` 跑远端命令。于是 facts 与扫描器是**真的**
 *   在跑：真读文件、真每 50 ms 采样本机 `ps -eo args`。
 *
 * 钉的是：一条全绿；每种红各一条（P0 角色、部署、接线、漂移、测连、call、切换、在途失败、
 * 不确定、金丝雀进页面 / 进日志 / 进 ps、真 key 落进非持有点）；两轮比对（同一份部署通过、
 * 换过产物不通过、中间夹了一轮不通过）；输出与证据里没有任何金丝雀、真 key 或运维凭据。
 * 包装脚本在每个找得到的 bash 上各跑一遍。
 */

import { afterAll, describe, expect, test } from 'bun:test'
import type {
  ChatTurn,
  ProviderAssignment,
  ProviderDrift,
  ProviderNodeView,
  ProviderProbeResult,
} from '@qianmo/console'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { SECRET_ENV_KEYS as WHITELIST_SECRET_KEYS } from '../../../../src/services/qianmo/providers/whitelist.js'
import { parseProviderProfile, presetById } from '@qianmo/providers'
import { testBashes } from '../testBashes'
import {
  CANARY_PRESET,
  canaryProfileEdit,
  compareRounds,
  ConfigError,
  main,
  parseConfig,
  Redactor,
  replyOf,
  type Verdict,
} from './provider-acceptance'
import { SECRET_ENV_KEYS, parseConsoleBanner } from './provider-acceptance-node'

const REPOSITORY_ROOT = resolve(import.meta.dir, '..', '..', '..', '..')
const WRAPPER = join(
  REPOSITORY_ROOT,
  'demo/env/beta/ops/provider-acceptance.sh',
)
const RUNNER = join(REPOSITORY_ROOT, 'demo/env/beta/ops/provider-acceptance.ts')
const NODE_SCRIPT = join(
  REPOSITORY_ROOT,
  'demo/env/beta/ops/provider-acceptance-node.ts',
)
const BASHES = testBashes()
const SLOW = 90_000

const SHA = 'a'.repeat(40)
const OTHER_SHA = 'b'.repeat(40)
const TOKEN = 'qmu_test_ops_credential_0123456789abcdef'
const REAL_KEY = 'sk-test-real-key-0123456789abcdefghijklmnop'
const REAL_KEY_2 = 'sk-test-real-key-second-zyxwvutsrqponmlkji'

const BASE = mkdtempSync(join(tmpdir(), 'qm-accept-'))
const sleepers: ReturnType<typeof Bun.spawn>[] = []
afterAll(() => {
  for (const proc of sleepers) proc.kill()
  rmSync(BASE, { recursive: true, force: true })
})

// ── 桩（模块作用域只写一次）──────────────────────────────────────────────────

const BIN = join(BASE, 'bin')
mkdirSync(BIN, { recursive: true })
symlinkSync(process.execPath, join(BIN, 'bun'))
const FAKE_SSH = join(BIN, 'ssh')
writeFileSync(
  FAKE_SSH,
  `#!/bin/bash
set -u
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) shift 2 ;;
    -*) printf 'fake ssh: unexpected option %s\\n' "$1" >&2; exit 254 ;;
    *) break ;;
  esac
done
target="$1"
shift
m="\${FAKE_FLEET:?}/$target"
[ -d "$m" ] || { printf 'ssh: Could not resolve hostname %s\\n' "$target" >&2; exit 255; }
printf '%s %s\\n' "$target" "$*" >>"\${FAKE_FLEET}/ssh.log"
exec env -i PATH="${BIN}:/usr/bin:/bin:/usr/sbin:/sbin" HOME="$m/home" LC_ALL=C bash -c "$*"
`,
)
chmodSync(FAKE_SSH, 0o755)

function sleeper(): number {
  const proc = Bun.spawn(['sleep', '600'], {
    stdout: 'ignore',
    stderr: 'ignore',
  })
  sleepers.push(proc)
  return proc.pid
}

// 进程：每台机器上的控制台与节点各一个真活着的进程，整个文件共用。
const PIDS = { console: sleeper(), 'beta-1': sleeper(), 'beta-2': sleeper() }

// ── 假舰队 ──────────────────────────────────────────────────────────────────

interface Fleet {
  readonly dir: string
  readonly out: string
  readonly config: string
  readonly credential: string
  root(machine: 'h' | 'n2'): string
  tree(machine: 'h' | 'n2'): string
}

interface FleetOptions {
  readonly nodeCommit?: string
  readonly localCommandsFrom?: readonly string[]
  readonly realKeyLeak?: boolean
  readonly timing?: Record<string, unknown>
  readonly attempts?: number
  readonly realApply?: boolean
}

let fleetCount = 0

function write(path: string, text: string, mode = 0o600): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text, { mode })
}

function consoleBanner(): string {
  const field = (name: string, value: string) => `${name.padEnd(13)}${value}\n`
  return [
    field('console', 'http://127.0.0.1:38621'),
    field(
      'open',
      'http://127.0.0.1:38621/?token=view-token-should-never-be-read',
    ),
    field('view-token', 'from /secret/view'),
    field('admin-token', 'admin-token-should-never-be-read'),
    field('chat', 'enabled as console (signed)'),
    field('accounts', 'enabled -> /x/accounts.json'),
    field(
      'providers',
      'enabled -> /x/providers.ndjson (nodes: beta-1/local, beta-2/ssh)',
    ),
    field('label', 'beta'),
    field('sourceCommit', SHA),
  ].join('')
}

function nodeBanner(
  node: string,
  commit: string,
  from: readonly string[],
): string {
  return `${JSON.stringify({
    node,
    sourceCommit: commit,
    publicKey: 'pk',
    trusts: ['console'],
    localCommandsFrom: from,
  })}\n其后是日志\n`
}

function makeFleet(options: FleetOptions = {}): Fleet {
  fleetCount += 1
  const dir = join(BASE, `fleet${fleetCount}`)
  const machineDir = (m: string) => join(dir, 'fleet', m)
  const root = (m: 'h' | 'n2') => join(machineDir(m), 'home', 'qianmo-beta')
  const tree = (m: 'h' | 'n2') => join(machineDir(m), 'tree')
  for (const m of ['h', 'n2'] as const) {
    write(join(tree(m), 'dist/cli-node.js'), `// build ${SHA}\n`)
    mkdirSync(join(tree(m), 'demo/env/beta/ops'), { recursive: true })
    symlinkSync(
      NODE_SCRIPT,
      join(tree(m), 'demo/env/beta/ops/provider-acceptance-node.ts'),
    )
    mkdirSync(join(root(m), 'logs'), { recursive: true })
    mkdirSync(join(root(m), 'run'), { recursive: true })
    // secrets/ 不扫：放一把真 key 进去，扫到了就是用例红。
    write(join(root(m), 'secrets/model-env'), `OPENAI_API_KEY=${REAL_KEY}\n`)
  }
  const from = options.localCommandsFrom ?? ['console']
  // H：控制台 + beta-1（本机执行器）。
  write(join(root('h'), 'run/console.pid'), `${PIDS.console}\n`)
  write(join(root('h'), 'logs/console.out'), consoleBanner())
  write(join(root('h'), 'run/beta-1.pid'), `${PIDS['beta-1']}\n`)
  write(join(root('h'), 'logs/beta-1.out'), nodeBanner('beta-1', SHA, from))
  write(
    join(
      root('h'),
      'nodes/console/config/qianmo/console/provider-secrets.json',
    ),
    '{"v":1,"sealed":"AAAAciphertextAAAA"}\n',
  )
  write(
    join(root('h'), 'nodes/console/config/qianmo/console/actions.ndjson'),
    '{"action":"provider.save"}\n',
  )
  write(
    join(root('h'), 'nodes/beta-1/config/settings.json'),
    JSON.stringify({
      env: { OPENAI_API_KEY: REAL_KEY, OPENAI_MODEL: 'gpt-6-luna' },
    }),
  )
  // n2：beta-2（ssh 执行器），多 key 池（P18.18）。
  write(join(root('n2'), 'run/beta-2.pid'), `${PIDS['beta-2']}\n`)
  write(
    join(root('n2'), 'logs/beta-2.out'),
    nodeBanner('beta-2', options.nodeCommit ?? SHA, from),
  )
  write(join(root('n2'), 'logs/beta-2.err'), 'resident 日志\n')
  write(
    join(root('n2'), 'nodes/beta-2/config/settings.json'),
    JSON.stringify({ env: { OPENAI_API_KEY: REAL_KEY } }),
  )
  write(
    join(root('n2'), 'nodes/beta-2/config/qianmo/provider/key-pool.json'),
    JSON.stringify({
      v: 1,
      keys: [
        { id: 'k1', value: REAL_KEY },
        { id: 'k2', value: REAL_KEY_2 },
      ],
    }),
  )
  write(
    join(root('n2'), 'nodes/beta-2/config/qianmo/audit/trail.ndjson'),
    '{"seq":1}\n',
  )
  if (options.realKeyLeak === true) {
    write(
      join(root('n2'), 'nodes/beta-2/config/projects/p/session.jsonl'),
      `{"text":"key is ${REAL_KEY_2}"}\n`,
    )
  }

  const out = join(dir, 'evidence')
  mkdirSync(out, { recursive: true, mode: 0o700 })
  const credential = join(dir, 'ops-credential')
  write(credential, `${TOKEN}\n`)
  const config = join(dir, 'round.json')
  write(
    config,
    JSON.stringify({
      v: 1,
      console: {
        url: 'http://127.0.0.1:1',
        credentialFile: credential,
        chatAs: 'console',
      },
      machines: {
        h: { ssh: 'h', tree: tree('h') },
        n2: { ssh: 'n2', tree: tree('n2') },
      },
      hub: 'h',
      nodes: {
        'beta-1': { machine: 'h', profileId: 'luna' },
        'beta-2': { machine: 'n2', profileId: 'luna' },
      },
      expect: { sourceCommit: SHA },
      switch: { node: 'beta-2', profileId: 'alt' },
      call: { node: 'beta-1' },
      inflight: {
        target: 'qianmo://beta-2/planner',
        attempts: options.attempts ?? 3,
      },
      canary: {
        node: 'beta-2',
        baseUrl: 'http://127.0.0.1:9/v1',
        realApply: options.realApply === true,
      },
      timing: {
        pollMs: 20,
        ackTimeoutMs: 3_000,
        inflightTimeoutMs: 6_000,
        switchTimeoutMs: 3_000,
        httpTimeoutMs: 5_000,
        sshTimeoutMs: 60_000,
        scanReadyTimeoutMs: 30_000,
        retryDelaysMs: [10, 20],
        psIntervalMs: 50,
        replyGraceMs: 100,
        ...options.timing,
      },
    }),
  )
  return { dir, out, config, credential, root, tree }
}

function pointConfigAt(fleet: Fleet, url: string): void {
  const raw = JSON.parse(readFileSync(fleet.config, 'utf8')) as {
    console: { url: string }
  }
  raw.console.url = url
  write(fleet.config, JSON.stringify(raw))
}

// ── 假控制台 ────────────────────────────────────────────────────────────────

interface Scenario {
  notOps?: boolean
  drift?: boolean
  authFail?: boolean
  callFail?: boolean
  switchRefused?: boolean
  turnFails?: boolean
  /** 回复与受理同时到（这一轮太短）。 */
  instantReply?: boolean
  /** 有缺陷的节点：不等在途 turn 就切。 */
  noWait?: boolean
  /** 轮中途（第一次改指派时）这个 pid 文件换成另一个进程：resident 重启过。 */
  restart?: { readonly file: string; readonly pid: number }
  pageLeak?: boolean
  /** dry-run 下发时节点把金丝雀写进了日志。 */
  logLeak?: string
  /** dry-run 下发时有个进程的 argv 里带着金丝雀。 */
  psLeak?: boolean
  /** 前两次 /v0/health 回空体（过程失败，按规则重试）。 */
  flakyHealth?: boolean
}

interface FakeNode {
  readonly node: string
  readonly executor: 'local' | 'ssh'
  assignment: ProviderAssignment
  applied: {
    profileId: string
    revision: number
    requestId: string
    at: string
  }
  pending: { requestId: string; since: string } | null
  generation: number
  hash: string
  model: string
  inflight: number
  /** resident 正等着在途的 turn（只有它真在等时 status 才报 waitingTurns）。 */
  waiting: boolean
}

interface FakeProfile {
  id: string
  revision: number
  models: { id: string; role: 'main' | 'fast' | 'extra' }[]
  secrets: Record<string, string>
}

function fakeConsole(scenario: Scenario) {
  let seq = 0
  let healthCalls = 0
  const profiles = new Map<string, FakeProfile>([
    [
      'luna',
      {
        id: 'luna',
        revision: 1,
        models: [{ id: 'gpt-6-luna', role: 'main' }],
        secrets: { k1: REAL_KEY },
      },
    ],
    [
      'alt',
      {
        id: 'alt',
        revision: 1,
        models: [{ id: 'gpt-6-alt', role: 'main' }],
        secrets: { k1: REAL_KEY },
      },
    ],
  ])
  const nodes = new Map<string, FakeNode>()
  for (const [node, executor] of [
    ['beta-1', 'local'],
    ['beta-2', 'ssh'],
  ] as const) {
    nodes.set(node, {
      node,
      executor,
      assignment: { mode: 'inherit' },
      applied: {
        profileId: 'luna',
        revision: 1,
        requestId: 'r0',
        at: '2026-10-04T00:00:00Z',
      },
      pending: null,
      generation: 3,
      hash: 'h-luna',
      model: 'gpt-6-luna',
      inflight: 0,
      waiting: false,
    })
  }
  const sessions = new Map<string, { target: string; turns: ChatTurn[] }>()
  const expectedOf = (n: FakeNode) =>
    n.assignment.mode === 'profile' ? n.assignment.profileId : 'luna'

  const view = (n: FakeNode): ProviderNodeView => {
    const expected = profiles.get(expectedOf(n))
    const drift: ProviderDrift[] =
      scenario.drift === true && n.node === 'beta-1'
        ? [
            {
              kind: 'local-edit',
              message: '有人改过受管键',
              keys: ['OPENAI_MODEL'],
            },
          ]
        : []
    return {
      node: n.node,
      executor: n.executor,
      assignment: n.assignment,
      contextOverride: null,
      expected:
        expected === undefined
          ? null
          : {
              profileId: expected.id,
              revision: expected.revision,
              contextOverride: null,
            },
      actual: {
        managed: true,
        applied: n.applied,
        onDiskHash: n.hash,
        appliedHash: n.hash,
        loadedHash: n.hash,
        pending:
          n.pending === null
            ? null
            : {
                ...n.pending,
                waitingTurns: n.waiting ? n.inflight : null,
              },
        resident: {
          running: true,
          generation: n.generation,
          inFlight: n.inflight > 0 ? n.inflight : null,
        },
        inheritedProviderKeys: [],
        capabilities: {
          protocol: 1,
          chatEffortHonorsOverride: true,
          replayFilter: true,
          multiKey: true,
        },
        lastResult: null,
        ...(n.node === 'beta-2'
          ? {
              keys: [
                { id: 'k1', state: 'ok' as const },
                {
                  id: 'k2',
                  state: 'cooling' as const,
                  reason: 'rate-limit' as const,
                  until: '2026-10-04T01:00:00Z',
                },
              ],
            }
          : {}),
        effective: {
          apiProvider: 'openai',
          wire: 'responses',
          model: n.model,
          wireModel: n.model,
          modelSettingsSlot: null,
          effortOnWire: true,
          effortLevel: 'max',
          contextTokens: 200_000,
        },
      },
      lastStatus: { at: Date.now(), ok: true },
      drift,
      recent: [],
    }
  }

  const json = (value: unknown, status = 200) =>
    new Response(JSON.stringify(value), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  const fail = (status: number, code: string, message: string) =>
    json({ error: { code, message } }, status)

  const commitWhenIdle = (n: FakeNode, profile: FakeProfile, rid: string) => {
    const tick = () => {
      if (n.pending?.requestId !== rid) return
      if (n.inflight > 0 && scenario.noWait !== true) {
        n.waiting = true
        setTimeout(tick, 10)
        return
      }
      n.waiting = false
      n.pending = null
      n.applied = {
        profileId: profile.id,
        revision: profile.revision,
        requestId: rid,
        at: new Date().toISOString(),
      }
      n.generation += 1
      n.hash = `h-${profile.id}-${profile.revision}`
      n.model = profile.models.find(m => m.role === 'main')?.id ?? '?'
    }
    setTimeout(tick, 30)
  }

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      const path = url.pathname
      if (path === '/v0/health') {
        healthCalls += 1
        if (scenario.flakyHealth === true && healthCalls <= 2)
          return new Response('', { status: 200 })
        return json({ status: 'ok' })
      }
      if (request.headers.get('authorization') !== `Bearer ${TOKEN}`)
        return fail(401, 'unauthorized', '要 token')
      const body =
        request.method === 'GET'
          ? {}
          : ((await request.json().catch(() => ({}))) as Record<
              string,
              unknown
            >)
      if (path === '/v0/providers/preview') {
        return scenario.notOps === true
          ? fail(403, 'forbidden', '要运维角色的个人账号')
          : json({ modelType: 'x' })
      }
      if (path === '/v0/providers' && request.method === 'GET') {
        return json({
          revision: 1,
          defaultProfileId: 'luna',
          profiles: [],
          nodes: [...nodes.values()].map(view),
        })
      }
      const nodeMatch =
        /^\/v0\/providers\/nodes\/([^/]+)(?:\/(refresh|assignment))?$/.exec(
          path,
        )
      if (nodeMatch !== null) {
        const n = nodes.get(decodeURIComponent(nodeMatch[1] ?? ''))
        if (n === undefined) return fail(404, 'not_found', '没有这个节点')
        if (nodeMatch[2] === 'assignment') {
          if (scenario.restart !== undefined) {
            writeFileSync(scenario.restart.file, `${scenario.restart.pid}\n`)
          }
          n.assignment =
            body.mode === 'profile' && typeof body.profileId === 'string'
              ? { mode: 'profile', profileId: body.profileId }
              : { mode: 'inherit' }
          return json({ node: view(n) })
        }
        return nodeMatch[2] === 'refresh'
          ? json({ node: view(n) })
          : json(view(n))
      }
      if (path === '/v0/providers/probe') {
        const node = String(body.node)
        const isCanary = String(body.profileId).startsWith('qm-canary-')
        const result: ProviderProbeResult = isCanary
          ? {
              node,
              requestId: `p${++seq}`,
              ok: false,
              reachable: false,
              message: '连不上 127.0.0.1:9',
            }
          : scenario.authFail === true &&
              body.mode === 'auth' &&
              node === 'beta-2'
            ? {
                node,
                requestId: `p${++seq}`,
                ok: false,
                reachable: true,
                message: '厂商拒绝了这把 key',
                httpStatus: 401,
              }
            : scenario.callFail === true && body.mode === 'call'
              ? {
                  node,
                  requestId: `p${++seq}`,
                  ok: false,
                  reachable: false,
                  message: '连不上',
                }
              : {
                  node,
                  requestId: `p${++seq}`,
                  ok: true,
                  reachable: true,
                  message: '可用',
                  httpStatus: 200,
                }
        return json(result)
      }
      if (path === '/v0/providers/apply') {
        const list = Array.isArray(body.nodes) ? body.nodes.map(String) : []
        const results = []
        for (const name of list) {
          const n = nodes.get(name)
          if (n === undefined) return fail(404, 'not_found', '没有这些节点')
          const rid = `req-${++seq}`
          if (body.dryRun === true) {
            const profile = profiles.get(
              String(body.profileId ?? expectedOf(n)),
            )
            if (scenario.logLeak !== undefined && profile !== undefined) {
              writeFileSync(
                scenario.logLeak,
                `apply ${profile.secrets.k1 ?? ''}\n`,
                { flag: 'a' },
              )
            }
            if (scenario.psLeak === true && profile !== undefined) {
              // 末尾的 `; :` 让 bash 不把 sleep exec 掉（exec 之后 argv 里就没有 $0 了）。
              Bun.spawn(
                ['bash', '-c', 'sleep 1.5; :', profile.secrets.k1 ?? ''],
                {
                  stdout: 'ignore',
                  stderr: 'ignore',
                },
              )
              await Bun.sleep(400)
            }
            results.push({
              node: name,
              requestId: rid,
              outcome: 'ok',
              message: '预演通过',
              pending: false,
            })
            continue
          }
          const profile = profiles.get(expectedOf(n))
          if (profile === undefined)
            return fail(404, 'not_found', '没有这份档案')
          if (scenario.switchRefused === true && profile.id === 'alt') {
            results.push({
              node: name,
              requestId: rid,
              outcome: 'refused',
              code: 'conflict',
              message: '受管键在节点上被改过',
            })
            continue
          }
          n.pending = { requestId: rid, since: new Date().toISOString() }
          commitWhenIdle(n, profile, rid)
          results.push({
            node: name,
            requestId: rid,
            outcome: 'ok',
            message: '已写入 · 等空闲切换',
            pending: true,
            profileId: profile.id,
            revision: profile.revision,
          })
        }
        return json({ results })
      }
      const keyMatch =
        /^\/v0\/providers\/profiles\/([^/]+)\/keys\/([^/]+)$/.exec(path)
      if (keyMatch !== null && request.method === 'PUT') {
        const p = profiles.get(keyMatch[1] ?? '')
        if (p === undefined) return fail(404, 'not_found', '没有')
        if (body.ifMatch !== p.revision)
          return fail(409, 'conflict', '修订号不符')
        p.secrets[keyMatch[2] ?? ''] = String(body.value)
        p.revision += 1
        return json({ profile: { id: p.id, revision: p.revision } })
      }
      if (path === '/v0/providers/profiles' && request.method === 'POST') {
        const edit = body.profile as {
          id: string
          models: FakeProfile['models']
        }
        const secrets = (body.secrets ?? {}) as Record<string, string>
        profiles.set(edit.id, {
          id: edit.id,
          revision: 1,
          models: edit.models,
          secrets: { ...secrets },
        })
        return json({
          profile: {
            id: edit.id,
            revision: 1,
            keys: [
              { id: 'k1', fingerprint: 'f1' },
              { id: 'k2', fingerprint: 'f2' },
            ],
          },
        })
      }
      const profileMatch = /^\/v0\/providers\/profiles\/([^/]+)$/.exec(path)
      if (profileMatch !== null) {
        const p = profiles.get(profileMatch[1] ?? '')
        if (p === undefined) return fail(404, 'not_found', '没有这份档案')
        if (request.method === 'DELETE') {
          if (body.ifMatch !== p.revision)
            return fail(409, 'conflict', '修订号不符')
          profiles.delete(p.id)
          return json({ deleted: p.id })
        }
        return json({
          id: p.id,
          revision: p.revision,
          models: p.models.map(m => ({ ...m, tiers: ['opus'] })),
          ...(scenario.pageLeak === true && p.id.startsWith('qm-canary-')
            ? { debug: p.secrets.k1 }
            : {}),
        })
      }
      if (path === '/v0/providers/export') {
        return new Response(
          JSON.stringify({
            v: 1,
            kind: 'qianmo-providers',
            secrets: 'not-included',
            profiles: [...profiles.keys()],
          }),
          { status: 200 },
        )
      }
      if (path.startsWith('/providers')) {
        return new Response(`<html><body>模型服务 ${path}</body></html>`, {
          status: 200,
          headers: { 'content-type': 'text/html' },
        })
      }
      if (path === '/v0/chat/sessions' && request.method === 'POST') {
        const id = `s${++seq}`
        sessions.set(id, { target: String(body.target), turns: [] })
        return json({
          id,
          target: body.target,
          node: 'beta-2',
          agent: 'planner',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          turnCount: 0,
          preview: '',
        })
      }
      const chatMatch = /^\/v0\/chat\/sessions\/([^/]+)(\/messages)?$/.exec(
        path,
      )
      if (chatMatch !== null) {
        const s = sessions.get(decodeURIComponent(chatMatch[1] ?? ''))
        if (s === undefined)
          return fail(404, 'not_found', '这条会话不在本控制台的记录里')
        if (chatMatch[2] === undefined)
          return json({ session: { id: chatMatch[1] }, turns: s.turns })
        const n = nodes.get('beta-2') as FakeNode
        const taskId = `t${++seq}`
        const operator: ChatTurn = {
          id: `u${++seq}`,
          sessionId: chatMatch[1] ?? '',
          author: 'operator',
          at: Date.now(),
          text: String(body.text),
          state: 'pending',
          taskId,
        }
        s.turns.push(operator)
        n.inflight += 1
        const reply = () => {
          n.inflight -= 1
          s.turns.push({
            id: `a${++seq}`,
            sessionId: operator.sessionId,
            author: 'agent',
            at: Date.now(),
            text: '（回复正文）',
            state: scenario.turnFails === true ? 'failed' : 'done',
            taskId,
          })
        }
        setTimeout(() => {
          const index = s.turns.findIndex(t => t.id === operator.id)
          s.turns[index] = { ...operator, state: 'read' }
          // 过程行不算回复。
          s.turns.push({
            id: `n${++seq}`,
            sessionId: operator.sessionId,
            author: 'agent',
            at: Date.now(),
            text: '开始写',
            state: 'done',
            variant: 'notice',
            severity: 'info',
          })
          if (scenario.instantReply === true) reply()
        }, 50)
        if (scenario.instantReply !== true) setTimeout(reply, 700)
        return json(operator)
      }
      return fail(404, 'not_found', `unknown path: ${path}`)
    },
  })
  return {
    url: `http://127.0.0.1:${server.port}`,
    stop: () => server.stop(true),
    nodes,
  }
}

// ── 跑一轮 ──────────────────────────────────────────────────────────────────

interface RoundRun {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
  readonly verdict: Verdict | null
  readonly dir: string
}

function env(fleet: Fleet): Record<string, string> {
  return {
    PATH: `${BIN}:/usr/bin:/bin:/usr/sbin:/sbin`,
    HOME: fleet.dir,
    LC_ALL: 'C',
    TMPDIR: tmpdir(),
    FAKE_FLEET: join(fleet.dir, 'fleet'),
    QIANMO_ACCEPTANCE_SSH_BIN: FAKE_SSH,
  }
}

async function round(
  fleet: Fleet,
  scenario: Scenario,
  label: string,
  launcher: readonly string[] = [process.execPath, RUNNER],
): Promise<RoundRun> {
  const fake = fakeConsole(scenario)
  pointConfigAt(fleet, fake.url)
  try {
    const proc = Bun.spawn(
      [
        ...launcher,
        'round',
        '--config',
        fleet.config,
        '--out',
        fleet.out,
        '--label',
        label,
      ],
      {
        env: env(fleet),
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    const code = await proc.exited
    const dir = join(fleet.out, `round-${label}`)
    const file = join(dir, 'verdict.json')
    const verdict = existsSync(file)
      ? (JSON.parse(readFileSync(file, 'utf8')) as Verdict)
      : null
    return { code, stdout, stderr, verdict, dir }
  } finally {
    fake.stop()
  }
}

function itemOf(run: RoundRun, id: string) {
  return run.verdict?.items.find(item => item.id === id)
}

/** 证据目录与输出里不许有任何一个秘密的原文。 */
function expectNoSecrets(run: RoundRun): void {
  const texts: string[] = [run.stdout, run.stderr]
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name)
      if (statSync(path).isDirectory()) walk(path)
      else texts.push(readFileSync(path, 'utf8'))
    }
  }
  walk(run.dir)
  const all = texts.join('\n')
  expect(all).not.toContain(TOKEN)
  expect(all).not.toContain(REAL_KEY)
  expect(all).not.toContain(REAL_KEY_2)
  expect(all).not.toMatch(/sk-qmcanary-[A-Za-z0-9]{40}/)
  expect(all).not.toContain('should-never-be-read')
}

/** 证据文件都是 0600、目录 0700。 */
function expectPrivate(dir: string): void {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    const st = statSync(path)
    expect({ path, mode: (st.mode & 0o777).toString(8) }).toEqual({
      path,
      mode: st.isDirectory() ? '700' : '600',
    })
    if (st.isDirectory()) expectPrivate(path)
  }
}

// ── 用例 ────────────────────────────────────────────────────────────────────

describe('一轮', () => {
  test(
    '全绿：每一项 PASS，退 0；A6 记下同构建热切换的时刻；证据里没有任何秘密、文件都是私有的',
    async () => {
      const fleet = makeFleet()
      const run = await round(fleet, { flakyHealth: true }, 'green')
      expect(run.stderr).toBe('')
      expect(run.verdict?.items.filter(item => item.status !== 'PASS')).toEqual(
        [],
      )
      expect(run.code).toBe(0)
      expect(run.verdict?.green).toBe(true)
      expect(run.verdict?.deployment?.sourceCommit).toBe(SHA)
      expect(run.verdict?.deployment?.fingerprint).toMatch(/^[0-9a-f]{64}$/)
      // 空应答按规则重试了两次，记在 retries.ndjson。
      expect(run.verdict?.retries).toBe(2)
      // A6：看到了「等在途」，换代前进。
      const a6 = run.verdict?.moments.find(m => m.item === 'A6')
      expect(a6?.waitingTurns).toBe(1)
      expect(Number(a6?.generationAfter)).toBe(Number(a6?.generationBefore) + 1)
      // A5：两台机器都扫了，真 key 的针在持有点里命中（正向对照），key-pool 的第二把也在。
      const a5 = itemOf(run, 'A5')
      expect(a5?.detail.join('\n')).toContain('h：针 金丝雀 3 / 本机真 key 1')
      expect(a5?.detail.join('\n')).toContain('n2：针 金丝雀 3 / 本机真 key 2')
      // 冷却中的 key 只记不判。
      expect(itemOf(run, 'A1')?.detail.join('\n')).toContain('k2 冷却中')
      expect(readFileSync(join(run.dir, 'verdict.md'), 'utf8')).toContain(
        '零红',
      )
      expectNoSecrets(run)
      expectPrivate(run.dir)
    },
    SLOW,
  )

  test(
    '金丝雀真下发（realApply）：切到金丝雀档案再切回，仍零红',
    async () => {
      const run = await round(makeFleet({ realApply: true }), {}, 'real-apply')
      expect(run.verdict?.red).toEqual([])
      expect(run.code).toBe(0)
      expect(itemOf(run, 'A5')?.detail.join('\n')).toContain(
        '金丝雀真下发并切回',
      )
      expect(run.verdict?.moments.some(m => m.item === 'A5-canary-there')).toBe(
        true,
      )
      expectNoSecrets(run)
    },
    SLOW,
  )

  const reds: [string, FleetOptions, Scenario, string, string][] = [
    [
      '凭据不是运维个人账号 → P0 红，其余跳过',
      {},
      { notOps: true },
      'P0',
      'not-ops',
    ],
    [
      '节点与控制台不是同一个提交 → D0 红',
      { nodeCommit: OTHER_SHA },
      {},
      'D0',
      'deployment',
    ],
    [
      '节点没开 --local-commands-from console → W1 红',
      { localCommandsFrom: [] },
      {},
      'W1',
      'wiring',
    ],
    ['节点有漂移 → A1 红', {}, { drift: true }, 'A1', 'drift'],
    ['真 key 测连被拒 → A2 红', {}, { authFail: true }, 'A2', 'auth'],
    ['call 调用失败 → A4 红', {}, { callFail: true }, 'A4', 'call'],
    ['切换被节点拒绝 → A3 红', {}, { switchRefused: true }, 'A3', 'switch'],
    ['在途那一轮失败 → A6 红', {}, { turnFails: true }, 'A6', 'turn-failed'],
    [
      '每次都是回复先到 → A6 不确定，红',
      { attempts: 2 },
      { instantReply: true },
      'A6',
      'inconclusive',
    ],
    [
      '节点不等在途 turn 就切（缺陷）→ A6 红，no-wait',
      { attempts: 2 },
      { noWait: true },
      'A6',
      'no-wait',
    ],
    [
      '金丝雀出现在 JSON 响应里 → A5 红',
      {},
      { pageLeak: true },
      'A5',
      'canary-leak',
    ],
    [
      '金丝雀出现在 ps 采样里 → A5 红',
      {},
      { psLeak: true },
      'A5',
      'canary-leak',
    ],
    [
      '真 key 落进了会话转录（非持有点）→ A5 红',
      { realKeyLeak: true },
      {},
      'A5',
      'real-key-leak',
    ],
  ]
  for (const [title, fleetOptions, scenario, id, kind] of reds) {
    test(
      title,
      async () => {
        const run = await round(makeFleet(fleetOptions), scenario, 'red')
        expect(run.code).toBe(1)
        expect(run.verdict?.green).toBe(false)
        expect(run.verdict?.red).toContain(id)
        expect(itemOf(run, id)?.class).toBe(kind)
        if (id === 'P0') {
          expect(
            run.verdict?.items
              .slice(1)
              .every(item => item.status === 'SKIPPED'),
          ).toBe(true)
        }
        expectNoSecrets(run)
      },
      SLOW,
    )
  }

  test(
    '金丝雀出现在节点日志里 → A5 红，点名文件',
    async () => {
      const fleet = makeFleet()
      const run = await round(
        fleet,
        { logLeak: join(fleet.root('n2'), 'logs/beta-2.err') },
        'log-leak',
      )
      expect(run.code).toBe(1)
      expect(itemOf(run, 'A5')?.class).toBe('canary-leak')
      expect(itemOf(run, 'A5')?.detail.join('\n')).toContain(
        'n2：logs/beta-2.err 里 canary-1 ×1',
      )
      expectNoSecrets(run)
    },
    SLOW,
  )

  test(
    'resident 轮内重启过 → D1 红',
    async () => {
      const fleet = makeFleet()
      const run = await round(
        fleet,
        {
          restart: {
            file: join(fleet.root('n2'), 'run/beta-2.pid'),
            pid: sleeper(),
          },
        },
        'restart',
      )
      expect(run.code).toBe(1)
      expect(run.verdict?.red).toEqual(['D1'])
      expect(itemOf(run, 'D1')?.class).toBe('deployment-changed')
      expect(itemOf(run, 'D1')?.detail.join('\n')).toContain(
        'beta-2 轮内重启过',
      )
    },
    SLOW,
  )

  test(
    'HOLD：证据目录里有 HOLD 就不开始，退 42、不建轮目录',
    async () => {
      const fleet = makeFleet()
      writeFileSync(join(fleet.out, 'HOLD'), '')
      const run = await round(fleet, {}, 'held')
      expect(run.code).toBe(42)
      expect(existsSync(run.dir)).toBe(false)
    },
    SLOW,
  )
})

describe('两轮比对', () => {
  test(
    '同一份部署连续两轮零红 → 通过；换过产物 → 不通过；中间夹了一轮 → 不连续',
    async () => {
      const fleet = makeFleet()
      const r1 = await round(fleet, {}, 'r1')
      const r2 = await round(fleet, {}, 'r2')
      expect([r1.code, r2.code]).toEqual([0, 0])
      const ok = Bun.spawnSync(
        [process.execPath, RUNNER, 'compare', r1.dir, r2.dir],
        { env: env(fleet) },
      )
      expect(ok.exitCode).toBe(0)
      const pair = JSON.parse(
        readFileSync(join(fleet.out, 'pair-r1-r2.json'), 'utf8'),
      ) as { ok: boolean; checks: Record<string, boolean> }
      expect(pair).toMatchObject({
        ok: true,
        checks: {
          bothGreen: true,
          sameDeployment: true,
          ordered: true,
          consecutive: true,
        },
      })

      // 节点上换过一次产物（内容不同 → sha256 不同）。
      write(
        join(fleet.tree('n2'), 'dist/cli-node.js'),
        `// build ${SHA} rebuilt\n`,
      )
      const r3 = await round(fleet, {}, 'r3')
      expect(r3.code).toBe(0)
      const changed = compareRounds(r2.dir, r3.dir)
      expect(changed.ok).toBe(false)
      expect(changed.checks.sameDeployment).toBe(false)

      // r1 与 r3 之间夹着 r2。
      const skipped = compareRounds(r1.dir, r3.dir)
      expect(skipped.checks.consecutive).toBe(false)
    },
    SLOW * 2,
  )

  test('一轮红 → 两轮不通过', () => {
    const dir = join(BASE, 'synthetic')
    const verdict = (
      label: string,
      green: boolean,
      startedAt: string,
      finishedAt: string,
    ) => {
      mkdirSync(join(dir, `round-${label}`), { recursive: true })
      writeFileSync(
        join(dir, `round-${label}`, 'verdict.json'),
        JSON.stringify({
          v: 1,
          label,
          green,
          held: false,
          red: green ? [] : ['A2'],
          startedAt,
          finishedAt,
          items: [],
          moments: [],
          retries: 0,
          scope: {},
          deployment: {
            sourceCommit: SHA,
            machines: {},
            processes: {},
            fingerprint: 'f',
          },
        }),
      )
      return join(dir, `round-${label}`)
    }
    const a = verdict(
      'x1',
      true,
      '2026-10-04T01:00:00Z',
      '2026-10-04T01:10:00Z',
    )
    const b = verdict(
      'x2',
      false,
      '2026-10-04T01:20:00Z',
      '2026-10-04T01:30:00Z',
    )
    const pair = compareRounds(a, b)
    expect(pair.ok).toBe(false)
    expect(pair.checks.bothGreen).toBe(false)
    // 间隔不足。
    const c = verdict(
      'y1',
      true,
      '2026-10-04T02:00:00Z',
      '2026-10-04T02:10:00Z',
    )
    const d = verdict(
      'y2',
      true,
      '2026-10-04T02:15:00Z',
      '2026-10-04T02:25:00Z',
    )
    expect(compareRounds(c, d, 30).checks.ordered).toBe(false)
    expect(compareRounds(c, d, 5).ok).toBe(true)
  })
})

describe('包装脚本', () => {
  for (const bash of BASHES) {
    test(
      `bash ${bash.version}：经 provider-acceptance.sh 跑一轮全绿；HOLD 退 42；证据目录在仓库里退 2`,
      async () => {
        const fleet = makeFleet()
        const run = await round(fleet, {}, `wrapped-${bash.major}`, [
          bash.path,
          WRAPPER,
        ])
        expect(run.verdict?.red).toEqual([])
        expect(run.code).toBe(0)
        expectNoSecrets(run)

        writeFileSync(join(fleet.out, 'HOLD'), '')
        const held = Bun.spawnSync(
          [
            bash.path,
            WRAPPER,
            'round',
            '--config',
            fleet.config,
            '--out',
            fleet.out,
          ],
          { env: env(fleet) },
        )
        expect(held.exitCode).toBe(42)

        const inRepo = Bun.spawnSync(
          [
            bash.path,
            WRAPPER,
            'round',
            '--config',
            fleet.config,
            '--out',
            join(REPOSITORY_ROOT, 'demo'),
          ],
          { env: env(fleet) },
        )
        expect(inRepo.exitCode).toBe(2)
        expect(inRepo.stderr.toString()).toContain('仓库里')

        const usage = Bun.spawnSync([bash.path, WRAPPER, 'bogus'], {
          env: env(fleet),
        })
        expect(usage.exitCode).toBe(2)
      },
      SLOW,
    )
  }
})

describe('配置与零件', () => {
  test('节点脚本里抄的 SECRET_ENV_KEYS 与 whitelist.ts 逐项一致', () => {
    expect([...SECRET_ENV_KEYS]).toEqual([...WHITELIST_SECRET_KEYS])
  })

  test('金丝雀档案叠在预设草稿上（路由的 mergeEdit 那样）过得了真校验器', () => {
    const preset = presetById(CANARY_PRESET)
    expect(preset).toBeDefined()
    if (preset === undefined) return
    // consoleProviders.ts draftFromPreset 的草稿，再叠表单字段（routes/providers.ts mergeEdit）。
    const draft: Record<string, unknown> = {
      id: preset.id,
      name: preset.name.slice(0, 40),
      presetId: preset.id,
      plan: preset.plan,
      site: preset.sites[0]?.id ?? null,
      lane: preset.lane,
      baseUrl: preset.sites[0]?.baseUrl ?? preset.baseUrl,
      models: preset.models,
      effortLock: null,
      keySelection: 'fill_first',
      auth: { scheme: preset.authScheme },
      keys: [{ id: 'k1' }],
      probe: preset.probe,
      evaluated: false,
    }
    const merged = {
      ...draft,
      ...canaryProfileEdit('qm-canary-0a1b2c3d', 'http://127.0.0.1:9/v1'),
      revision: 1,
    }
    const parsed = parseProviderProfile(merged)
    expect(parsed.ok ? 'ok' : parsed.error.message).toBe('ok')
  })

  test('控制台横幅只取白名单字段：token 那几行从不转述', () => {
    const fields = parseConsoleBanner(consoleBanner())
    expect(Object.keys(fields).sort()).toEqual([
      'accounts',
      'chat',
      'providers',
      'sourceCommit',
    ])
    expect(JSON.stringify(fields)).not.toContain('should-never-be-read')
  })

  test('配置错退 2：切换目标与原档案相同、在途目标不在节点表里、凭据路径相对', async () => {
    const fleet = makeFleet()
    const good = JSON.parse(readFileSync(fleet.config, 'utf8')) as Record<
      string,
      unknown
    >
    expect(() => parseConfig(good)).not.toThrow()
    for (const patch of [
      { switch: { node: 'beta-2', profileId: 'luna' } },
      { inflight: { target: 'qianmo://beta-9/planner' } },
      {
        console: {
          url: 'http://127.0.0.1:1',
          credentialFile: 'ops-credential',
          chatAs: 'console',
        },
      },
      { machines: { h: { ssh: '-oProxyCommand=x', tree: '/srv/t' } } },
    ]) {
      expect(() => parseConfig({ ...good, ...patch })).toThrow(ConfigError)
    }
    write(join(fleet.dir, 'bad.json'), JSON.stringify({ ...good, v: 2 }))
    expect(
      await main([
        'round',
        '--config',
        join(fleet.dir, 'bad.json'),
        '--out',
        fleet.out,
      ]),
    ).toBe(2)
  })

  test(
    '凭据文件权限太宽 → P0 红（不读进来就停）',
    async () => {
      const fleet = makeFleet()
      chmodSync(fleet.credential, 0o644)
      const run = await round(fleet, {}, 'loose')
      expect(run.code).toBe(1)
      expect(itemOf(run, 'P0')?.class).toBe('credential')
    },
    SLOW,
  )

  test('脱敏：秘密换标签，自由文本里的长串换成 «long-token»', () => {
    const r = new Redactor()
    r.add('sk-qmcanary-abc', 'canary-1')
    expect(r.text('x sk-qmcanary-abc y')).toBe('x «canary-1» y')
    expect(r.labelsIn('..sk-qmcanary-abc..')).toEqual(['canary-1'])
    expect(r.free('key ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef012345 end')).toBe(
      'key «long-token» end',
    )
  })

  test('回复匹配：同 taskId 的 agent 消息，过程行不算', () => {
    const op: ChatTurn = {
      id: 'u1',
      sessionId: 's',
      author: 'operator',
      at: 1,
      text: '',
      state: 'read',
      taskId: 't1',
    }
    const notice: ChatTurn = {
      id: 'n1',
      sessionId: 's',
      author: 'agent',
      at: 2,
      text: '',
      state: 'done',
      variant: 'notice',
    }
    const other: ChatTurn = {
      id: 'a0',
      sessionId: 's',
      author: 'agent',
      at: 3,
      text: '',
      state: 'done',
      taskId: 't0',
    }
    const reply: ChatTurn = {
      id: 'a1',
      sessionId: 's',
      author: 'agent',
      at: 4,
      text: '',
      state: 'done',
      taskId: 't1',
    }
    expect(replyOf([op, notice, other], op)).toBeNull()
    expect(replyOf([op, notice, other, reply], op)?.id).toBe('a1')
  })
})
