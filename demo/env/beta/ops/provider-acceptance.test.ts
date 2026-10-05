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
  linkSync,
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
import { dirname, join, relative, resolve } from 'node:path'
import { transportPskEnvVarForNode } from '../../../../src/cli/handlers/consoleArgs.js'
import { occConfigPath } from '../../../../src/config/paths.js'
import { keyPoolPaths } from '../../../../src/services/qianmo/modelCompat/credentialPoolStore.js'
import { providerPaths } from '../../../../src/services/qianmo/providers/store.js'
import { SECRET_ENV_KEYS as WHITELIST_SECRET_KEYS } from '../../../../src/services/qianmo/providers/whitelist.js'
import { parseProviderProfile, presetById } from '@qianmo/providers'
import { cliPrefix, waitFor } from '../../../lib/acceptance/local/spawn'
import { testBashes } from '../testBashes'
import {
  CANARY_PRESET,
  canaryProfileEdit,
  chatWiringOf,
  compareRounds,
  ConfigError,
  consoleWiringProblems,
  main,
  parseConfig,
  Redactor,
  replyOf,
  type Verdict,
} from './provider-acceptance'
import {
  EXCLUDED_TOP,
  LAYOUT,
  SECRET_ENV_KEYS,
  parseConsoleBanner,
  parseNodeBanner,
  realKeyNeedles,
  scanFiles,
} from './provider-acceptance-node'

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

// ── 真进程的输出（W1 / P0 的判据对着它们，夹具里不再手写一份）──────────────────
//
// 控制台横幅、resident 启动行、/v0/health 与写者守卫的状态码，都从源码起一个真 `qm`
// 进程拿（`demo/lib/acceptance/local/spawn.ts` 的 cliPrefix：与 dev / build 同一份 defines
// 与 feature 表）。代码一改，这里拿到的就跟着变，判据对不上当场红。环境只给下面这几项：
// 开发者自己的凭据与模型端点一个都不继承（端点指到回环上没人听的口，万一有哪一步要拨）。

interface QmProcess {
  readonly stdout: () => string
  readonly stderr: () => string
  readonly alive: () => boolean
  stop(): Promise<void>
}

function startQm(
  argv: readonly string[],
  configDir: string,
  env: Record<string, string> = {},
): QmProcess {
  const proc = Bun.spawn([process.execPath, ...cliPrefix().slice(1), ...argv], {
    cwd: REPOSITORY_ROOT,
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: process.env.HOME ?? BASE,
      TMPDIR: tmpdir(),
      OCC_IDENTITY: 'qianmo',
      OCC_CONFIG_DIR: configDir,
      NO_COLOR: '1',
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:9',
      OPENAI_BASE_URL: 'http://127.0.0.1:9/v1',
      ...env,
    },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  let out = ''
  let err = ''
  // 两条流一直抽着：长跑进程的管道写满了会卡在 write 上（spawn.ts 同一条理由）。
  const drain = async (
    stream: ReadableStream<Uint8Array>,
    onText: (text: string) => void,
  ) => {
    const decoder = new TextDecoder()
    for await (const chunk of stream) {
      onText(decoder.decode(chunk, { stream: true }))
    }
  }
  const drained = Promise.all([
    drain(proc.stdout, text => {
      out += text
    }).catch(() => {}),
    drain(proc.stderr, text => {
      err += text
    }).catch(() => {}),
  ])
  return {
    stdout: () => out,
    stderr: () => err,
    alive: () => proc.exitCode === null && proc.signalCode === null,
    async stop() {
      if (proc.exitCode === null && proc.signalCode === null) proc.kill()
      await proc.exited
      await drained
    },
  }
}

/** 等 stdout 里出现 `marker`；进程先退了就收完它的输出再判。 */
async function untilOut(p: QmProcess, marker: RegExp, what: string) {
  await waitFor(() => marker.test(p.stdout()) || !p.alive(), {
    timeoutMs: 60_000,
    what,
    diagnose: () => `stdout:\n${p.stdout()}\nstderr:\n${p.stderr()}`,
  })
  if (marker.test(p.stdout())) return
  await p.stop()
  if (!marker.test(p.stdout())) {
    throw new Error(
      `${what} 没有给出期望的输出：\n${p.stdout()}\n${p.stderr()}`,
    )
  }
}

interface RealOutputs {
  /** `console=<公钥>`：beta-up.sh --print-wake-identity 那一行。 */
  readonly identity: string
  /** 带 --chat-sign 的控制台横幅（stdout 到 sourceCommit 为止）。 */
  readonly consoleSigned: string
  readonly consoleUnsigned: string
  /** 横幅里自己生成的 view / admin token（白名单用例确认它们一个字都不被转述）。 */
  readonly tokens: readonly string[]
  /** resident 启动行（首行 JSON），带与不带 --local-commands-from console。 */
  readonly nodeWith: string
  readonly nodeWithout: string
  readonly health: { readonly status: number; readonly json: unknown }
  /** 写者守卫：没凭据、只拿 view token 时 `POST /v0/providers/preview` 的状态码。 */
  readonly preview: { readonly anonymous: number; readonly view: number }
}

/** 控制台横幅的最后一行（console.ts：`field('sourceCommit', …)` 排在最后）。 */
const BANNER_END = /^sourceCommit\s+\S+\n/m
/** resident 的启动行：监听之前打的那一行 JSON。 */
const START_LINE = /^\{.*"publicKey".*\}\n/

async function realOutputs(): Promise<RealOutputs> {
  const root = join(BASE, 'real')
  const dir = (name: string) => {
    const path = join(root, name)
    mkdirSync(path, { recursive: true, mode: 0o700 })
    return path
  }
  const signedRoot = dir('console-signed')
  const unsignedRoot = dir('console-unsigned')
  const ask = startQm(['console', '--print-wake-identity'], signedRoot)
  await untilOut(ask, /^console=\S+\n/m, 'console --print-wake-identity')
  await ask.stop()
  const identity = ask.stdout().trim()
  // 模型服务那几项照 beta-up.sh 的 provider_console_args：主密钥、中枢 known_hosts、逐节点执行器。
  const keyFile = join(root, 'provider-master.key')
  write(keyFile, `${'a1'.repeat(32)}\n`)
  const knownHosts = join(root, 'known_hosts')
  write(knownHosts, '')
  const sshKey = join(root, 'beta-2.key')
  write(sshKey, '占位：控制台起来时不读它\n')
  const consoleArgs = (signed: boolean) => [
    'console',
    '--port',
    '0',
    '--hostname',
    '127.0.0.1',
    '--registry',
    'http://127.0.0.1:9',
    '--chat-url',
    'beta-1=ws://127.0.0.1:38632',
    '--chat-url',
    'beta-2=ws://127.0.0.1:38633',
    ...(signed ? ['--chat-sign'] : []),
    '--accounts',
    '--providers',
    '--provider-key-file',
    keyFile,
    '--provider-known-hosts',
    knownHosts,
    '--provider-local',
    `beta-1=${join(REPOSITORY_ROOT, 'demo/env/beta/ops/model-apply.sh')}`,
    '--provider-ssh',
    'beta-2=ops@node2.example:22',
    '--provider-ssh-key',
    `beta-2=${sshKey}`,
  ]
  const psk = {
    [transportPskEnvVarForNode('beta-1')]: 'p'.repeat(32),
    [transportPskEnvVarForNode('beta-2')]: 'q'.repeat(32),
  }
  const workspace = dir('workspace')
  const residentArgs = (node: string, local: boolean) => [
    'resident',
    '--node',
    node,
    '--team',
    'acceptance',
    '--port',
    '0',
    '--hostname',
    '127.0.0.1',
    '--agent',
    `planner=${workspace}`,
    '--open-policy',
    '--trust',
    identity,
    ...(local ? ['--local-commands-from', 'console'] : []),
  ]
  const nodePsk = { QIANMO_TRANSPORT_PSK: 'r'.repeat(32) }
  const signed = startQm(consoleArgs(true), signedRoot, psk)
  const unsigned = startQm(consoleArgs(false), unsignedRoot, psk)
  const withLocal = startQm(
    residentArgs('beta-1', true),
    dir('node-with'),
    nodePsk,
  )
  const withoutLocal = startQm(
    residentArgs('beta-2', false),
    dir('node-without'),
    nodePsk,
  )
  try {
    await Promise.all([
      untilOut(signed, BANNER_END, '控制台（--chat-sign）'),
      untilOut(unsigned, BANNER_END, '控制台（不签名）'),
      untilOut(withLocal, START_LINE, 'resident（--local-commands-from）'),
      untilOut(withoutLocal, START_LINE, 'resident'),
    ])
    const banner = signed.stdout()
    const origin = /^console\s+(\S+)$/m.exec(banner)?.[1] ?? ''
    const token = (name: string) =>
      new RegExp(`^${name}\\s+(\\S+)$`, 'm').exec(banner)?.[1] ?? ''
    const healthReply = await fetch(`${origin}/v0/health`)
    const health = {
      status: healthReply.status,
      json: (await healthReply.json()) as unknown,
    }
    const preview = async (headers: Record<string, string>) => {
      const reply = await fetch(`${origin}/v0/providers/preview`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify({ profileId: 'luna' }),
      })
      await reply.text()
      return reply.status
    }
    const firstLine = (p: QmProcess) => p.stdout().split('\n', 1)[0] ?? ''
    return {
      identity,
      consoleSigned: banner,
      consoleUnsigned: unsigned.stdout(),
      tokens: [token('view-token'), token('admin-token')],
      nodeWith: firstLine(withLocal),
      nodeWithout: firstLine(withoutLocal),
      health,
      preview: {
        anonymous: await preview({}),
        view: await preview({ authorization: `Bearer ${token('view-token')}` }),
      },
    }
  } finally {
    await Promise.all([
      signed.stop(),
      unsigned.stop(),
      withLocal.stop(),
      withoutLocal.stop(),
    ])
  }
}

const REAL = await realOutputs()

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
  /** 节点没带 `--local-commands-from console`（启动行取自没带它的真 resident）。 */
  readonly withoutLocalCommands?: boolean
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

/** 真控制台的横幅；只把 sourceCommit 换成这个假舰队的提交（部署身份是夹具的，形状是真的）。 */
function consoleBanner(): string {
  return REAL.consoleSigned.replace(/^(sourceCommit\s+)\S+$/m, `$1${SHA}`)
}

/** 真 resident 的启动行；只把 node 与 sourceCommit 换成夹具的，其余字段原样。 */
function nodeBanner(node: string, commit: string, local: boolean): string {
  const real = JSON.parse(local ? REAL.nodeWith : REAL.nodeWithout) as Record<
    string,
    unknown
  >
  return `${JSON.stringify({ ...real, node, sourceCommit: commit })}\n其后是日志\n`
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
  const local = options.withoutLocalCommands !== true
  // H：控制台 + beta-1（本机执行器）。
  write(join(root('h'), 'run/console.pid'), `${PIDS.console}\n`)
  write(join(root('h'), 'logs/console.out'), consoleBanner())
  write(join(root('h'), 'run/beta-1.pid'), `${PIDS['beta-1']}\n`)
  write(join(root('h'), 'logs/beta-1.out'), nodeBanner('beta-1', SHA, local))
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
    nodeBanner('beta-2', options.nodeCommit ?? SHA, local),
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
  /** dry-run 下发被中枢拒绝（金丝雀没走到节点）。 */
  dryRunRefused?: boolean
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
            if (scenario.dryRunRefused === true) {
              results.push({
                node: name,
                requestId: rid,
                outcome: 'refused',
                code: 'invalid',
                message: '换厂商或换线路时只能重置会话',
              })
              continue
            }
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
  for (const token of REAL.tokens) expect(all).not.toContain(token)
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
      { withoutLocalCommands: true },
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
      'dry-run 下发被中枢拒绝、金丝雀没走到节点 → A5 红',
      {},
      { dryRunRefused: true },
      'A5',
      'canary-flow',
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
      // CLI 起来时把 dist/cli-node.js 硬链进运行时目录、再撤掉：链接数变了，ctime 跟着变，
      // 产物没换。部署指纹不能因此变（P18.13 B 段 R1 的 D1 假红）。
      const cli = join(fleet.tree('n2'), 'dist/cli-node.js')
      const ctimeBefore = statSync(cli).ctimeMs
      await Bun.sleep(20)
      linkSync(cli, `${cli}.runtime-link`)
      rmSync(`${cli}.runtime-link`)
      expect(statSync(cli).ctimeMs).toBeGreaterThan(ctimeBefore)
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

      // 同样的字节重新装一遍（解包是先删后建）：sha256 不变，inode 变了，照样算换过产物。
      const bytes = readFileSync(cli)
      rmSync(cli)
      writeFileSync(cli, bytes)
      const r4 = await round(fleet, {}, 'r4')
      expect(r4.code).toBe(0)
      expect(compareRounds(r3.dir, r4.dir).checks.sameDeployment).toBe(false)
    },
    SLOW * 3,
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

  test('节点脚本的布局与 common.sh 一致（pid / 日志 / 节点与控制台配置根 / 不扫的目录 / 部署产物 / 缺省根）', () => {
    const root = join(BASE, 'layout-root')
    const home = join(BASE, 'layout-home')
    const asked = Bun.spawnSync(
      [
        '/bin/bash',
        '-c',
        '. "$1"; printf "%s\\n" "$(beta_pidfile console)" "$(beta_logfile beta-2 out)" "$BETA_NODES_DIR/beta-2/config" "$BETA_CONFIG_CONSOLE" "$BETA_SECRET_DIR" "$BETA_BACKUP_STORE" "$BETA_WORKSPACE_DIR" "$BETA_OCC"; unset QIANMO_BETA_ROOT; . "$1"; printf "%s\\n" "$BETA_ROOT"',
        'layout',
        join(REPOSITORY_ROOT, 'demo/env/beta/common.sh'),
      ],
      {
        env: { PATH: '/usr/bin:/bin', HOME: home, QIANMO_BETA_ROOT: root },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
    expect(asked.stderr.toString()).toBe('')
    expect(asked.stdout.toString().split('\n').slice(0, 9)).toEqual([
      LAYOUT.pidFile(root, 'console'),
      LAYOUT.outFile(root, 'beta-2'),
      LAYOUT.nodeConfig(root, 'beta-2'),
      LAYOUT.consoleConfig(root),
      ...EXCLUDED_TOP.map(name => join(root, name)),
      LAYOUT.cli(REPOSITORY_ROOT),
      LAYOUT.defaultRoot({}, home),
    ])
  })

  test('持有点与源码派生的路径同名；首次托管副本只对本机真 key 算持有点', () => {
    // 节点脚本只用 node 内建模块（部署树里没有 src），路径是抄的：这里钉住与源码一致。
    const script = readFileSync(NODE_SCRIPT, 'utf8')
    for (const path of [
      providerPaths.pending(),
      keyPoolPaths.pool(),
      providerPaths.firstWrite(),
    ]) {
      expect(script).toContain(`'${relative(occConfigPath(), path)}'`)
    }
    const canary = 'sk-test-canary-holders-0123456789abcdef'
    const root = mkdtempSync(join(BASE, 'holders-'))
    const config = join(root, 'nodes/beta-2/config')
    write(
      join(config, 'settings.json'),
      JSON.stringify({ env: { OPENAI_API_KEY: REAL_KEY } }),
    )
    // 迁移前 key 写在 settings.json 里的节点：首次托管的副本里有它，那是持有点。
    write(
      join(config, 'qianmo/provider/first-write/settings.json'),
      JSON.stringify({ env: { OPENAI_API_KEY: REAL_KEY }, canary }),
    )
    const real = realKeyNeedles(root, ['beta-2'])
    expect(real.map(needle => needle.label)).toEqual(['real-beta-2-1'])
    const scan = scanFiles({
      root,
      nodes: ['beta-2'],
      console: false,
      needles: [...real, { label: 'canary-1', bytes: Buffer.from(canary) }],
    })
    expect(scan.holders.map(hit => `${hit.path} ${hit.label}`).sort()).toEqual([
      'nodes/beta-2/config/qianmo/provider/first-write/settings.json real-beta-2-1',
      'nodes/beta-2/config/settings.json real-beta-2-1',
    ])
    // 金丝雀从不该进那份从不覆盖的副本：在那里出现照样是命中。
    expect(scan.hits.map(hit => `${hit.path} ${hit.label}`)).toEqual([
      'nodes/beta-2/config/qianmo/provider/first-write/settings.json canary-1',
    ])
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

  test('控制台横幅只取白名单字段：真控制台自己生成的 view / admin token 一个字都不转述', () => {
    const fields = parseConsoleBanner(REAL.consoleSigned)
    expect(Object.keys(fields).sort()).toEqual([
      'accounts',
      'chat',
      'providers',
      'sourceCommit',
    ])
    expect(REAL.tokens.every(token => token.length >= 16)).toBe(true)
    for (const token of REAL.tokens) {
      expect(REAL.consoleSigned).toContain(token)
      expect(JSON.stringify(fields)).not.toContain(token)
    }
  })

  test('W1 的控制台判据喂真控制台的横幅：带 --chat-sign 的过；不签名、签名名不对、少执行器各红', () => {
    const cfg = {
      hub: 'h',
      nodes: {
        'beta-1': { machine: 'h', profileId: 'luna' },
        'beta-2': { machine: 'n2', profileId: 'luna' },
      },
      chatAs: 'console',
    }
    const signed = parseConsoleBanner(REAL.consoleSigned)
    // 真横幅那一行的样子（console.ts wireConsoleChat）：地址 + (signed) + 端点列表。
    expect(chatWiringOf(signed.chat)).toEqual({
      from: 'qianmo://console/operator',
      node: 'console',
      signed: true,
    })
    expect(consoleWiringProblems(signed, cfg)).toEqual([])

    const unsigned = parseConsoleBanner(REAL.consoleUnsigned)
    expect(chatWiringOf(unsigned.chat)?.signed).toBe(false)
    expect(consoleWiringProblems(unsigned, cfg).join('\n')).toContain(
      '没有 (signed)',
    )
    expect(
      consoleWiringProblems(signed, { ...cfg, chatAs: 'hub' }).join('\n'),
    ).toContain('节点信任的签名名是 hub')
    expect(
      consoleWiringProblems(signed, {
        ...cfg,
        nodes: { ...cfg.nodes, 'beta-3': { machine: 'n2', profileId: 'luna' } },
      }),
    ).toEqual(['beta-3：控制台没有它的执行器'])
    // beta-1 在 H 上（local），换成远端机器就该是 ssh。
    expect(
      consoleWiringProblems(signed, {
        ...cfg,
        nodes: { ...cfg.nodes, 'beta-1': { machine: 'n2', profileId: 'luna' } },
      }),
    ).toEqual(['beta-1：执行器是 local，按它所在的机器应是 ssh'])
  })

  test('真 resident 的启动行：trusts 里有 console；--local-commands-from 给了才有', () => {
    const withLocal = parseNodeBanner(`${REAL.nodeWith}\n`)
    const withoutLocal = parseNodeBanner(`${REAL.nodeWithout}\n`)
    expect(withLocal?.node).toBe('beta-1')
    expect(withLocal?.trusts).toContain('console')
    expect(withLocal?.localCommandsFrom).toEqual(['console'])
    expect(withoutLocal?.trusts).toContain('console')
    expect(withoutLocal?.localCommandsFrom).toEqual([])
    expect(REAL.identity.startsWith('console=')).toBe(true)
  })

  test('真控制台：/v0/health 是 P0 认的形状；没有个人账号的凭据在 preview 上是 401 / 403（P0 的 not-ops）', () => {
    expect(REAL.health).toEqual({ status: 200, json: { status: 'ok' } })
    expect([401, 403]).toContain(REAL.preview.anonymous)
    expect([401, 403]).toContain(REAL.preview.view)
  })

  test('验收脚本拨的每个路由都在 console.md §5 的路由表里（那张表由 packages/console 的 routeDocs.test.ts 与路由器双向钉住）', () => {
    const doc = readFileSync(
      join(REPOSITORY_ROOT, 'docs/dev/console.md'),
      'utf8',
    )
    const table = doc.slice(
      doc.indexOf('\n## §5 路由表'),
      doc.indexOf('\n### 5.1', doc.indexOf('\n## §5 路由表')),
    )
    const rows: { method: string; segments: string[] }[] = []
    for (const line of table.split('\n')) {
      const cells = line.split('|')
      if (cells.length < 4) continue
      const methods = (cells[1] ?? '').trim().split(/[、/\s]+/)
      if (!methods.every(m => ['GET', 'POST', 'PUT', 'DELETE'].includes(m)))
        continue
      for (const [, text] of (cells[2] ?? '').matchAll(/`([^`]+)`/g)) {
        if (text === undefined || !text.startsWith('/')) continue
        const segments = (text.split('?')[0] ?? '').split('/').slice(1)
        for (const method of methods) rows.push({ method, segments })
      }
    }
    expect(rows.length).toBeGreaterThan(30)
    const source = readFileSync(RUNNER, 'utf8')
    const calls: [string, string][] = []
    for (const match of source.matchAll(
      /#api\(\s*'(GET|POST|PUT|DELETE)',\s*(?:'([^']*)'|`([^`]*)`)/g,
    )) {
      calls.push([match[1] ?? '', match[2] ?? match[3] ?? ''])
    }
    // 页面那几条是循环里的变量，路径写在数组字面量里。
    for (const match of source.matchAll(
      /^\s*(?:'(\/providers[^']*)'|`(\/providers[^`]*)`),$/gm,
    )) {
      calls.push(['GET', match[1] ?? match[2] ?? ''])
    }
    expect(calls.length).toBeGreaterThan(15)
    const missing = calls.filter(([method, path]) => {
      const segments = path
        .replace(/\$\{[^}]*\}/g, 'x')
        .split('/')
        .slice(1)
      return !rows.some(
        row =>
          row.method === method &&
          row.segments.length === segments.length &&
          row.segments.every(
            (segment, index) =>
              (segment.startsWith('<') && segment.endsWith('>')) ||
              segment === segments[index],
          ),
      )
    })
    expect(missing).toEqual([])
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
