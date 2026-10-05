// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `handoff-node.sh`：接力节点那两个进程怎么起（P17.5）。
 *
 * 钉四件事：
 *
 * ① app-server 的命令行带着 `-c mcp_servers.qianmo.enabled=false` 与 `-c notify=[]`
 *    （完成标准 5）：qmcode 内置的阡陌 MCP 与回合结束回调在节点上会反过来调接力命令；
 * ② 模型 key 只进 app-server 一个进程（完成标准 9）：节点桥的环境里没有它——连运维
 *    shell 里早就 export 着的那一把也被去掉——argv、config.toml、脚本输出里都没有它的值；
 * ③ 先起节点桥、后起 app-server；app-server 起不来就把节点桥停回去，不留半个节点；
 * ④ 起之前该拒的拒：没给网关地址、key 是空的、qmcode 旁边没有 codex-code-mode-host。
 *
 * 做法与 beta-up-args.test.ts 相同：脚本复制进一棵临时「仓库」，复制出来的 common.sh
 * 末尾把 `beta_start_process` 换成一个**同步跑一遍**底层命令的桩。底层命令里的
 * `env -u …` 与 `HOME=…` 都真的生效，被拉起的是两个假程序（假 occ 产物、假 qmcode），
 * 它们把自己看到的 argv 与环境记下来——断言的就是进程真正拿到的东西。
 */

import { afterAll, describe, expect, test } from 'bun:test'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const REPOSITORY_ROOT = resolve(import.meta.dir, '..', '..', '..')
const BETA_DIR = join(REPOSITORY_ROOT, 'demo/env/beta')

/** 假 key。断言它只出现在 app-server 的环境里。 */
const MODEL_KEY = 'sk-test-canary-handoff-node-model-env'
/** 运维 shell 里早就 export 着的另一把：节点桥也不许看见。 */
const OUTER_KEY = 'sk-test-canary-handoff-node-outer-shell'
/** model-env 里另一类 provider 的键：同样不进节点桥。 */
const OTHER_KEY = 'sk-test-canary-handoff-node-other'
/** secrets/handoff-model-env 里的那把（P17.7 前置）：只该出现在 app-server 的环境里。 */
const HANDOFF_KEY = 'sk-test-canary-handoff-node-own-file'
const PSK = 'psk-for-handoff-node-test'
const BASE_URL = 'https://gateway.example.test/v1'

/**
 * 起进程那一步：同步跑一遍底层命令，再写一个指向不存在进程的 pid 文件（停回去那条
 * 路径要读它）。`FAKE_FAIL_PROC` 点名的那个按「没能保持运行」处理。
 */
const RECORDER = `
beta_start_process() {
  local name="$1" config_dir="$2"
  shift 2
  printf '%s\\n' "$name" >>"$FAKE_LOG_DIR/order"
  if [ "\${FAKE_FAIL_PROC:-}" = "$name" ]; then
    beta_die "$name 未能保持运行（录制桩）"
  fi
  mkdir -p "$config_dir"
  OCC_CONFIG_DIR="$config_dir" "$@" >>"$FAKE_LOG_DIR/$name.out" 2>&1
  printf '%s\\n' 2147483646 >"$(beta_pidfile "$name")"
  beta_ok "$name 已启动（录制桩）"
}
`

/** 假的 occ 产物：bun 把它当数据读，不产生新的可执行 inode。 */
const FAKE_OCC = `const fs = require('node:fs')
fs.writeFileSync(
  process.env.FAKE_LOG_DIR + '/bridge.json',
  JSON.stringify({ args: process.argv.slice(2), env: process.env }),
)
`

/**
 * 假 qmcode 与它旁边的 codex-code-mode-host 整个文件只写一次、并在模块作用域先跑一次：
 * macOS 对新写出的可执行文件第一次 exec 要做一遍策略扫描，没有上界
 * （beta-up-args.test.ts 头注，issue #56）。
 */
const STUB_HOME = mkdtempSync(join(tmpdir(), 'qianmo-handoff-node-sh-bin-'))
const QMCODE_DIR = join(STUB_HOME, 'qmcode')
const QMCODE_REAL = join(QMCODE_DIR, 'qmcode-rust-v0.158.0-0123456789-x86_64')
const QMCODE_LINK = join(QMCODE_DIR, 'qmcode')
mkdirSync(QMCODE_DIR, { recursive: true })
writeFileSync(
  QMCODE_REAL,
  '#!/bin/bash\nprintf \'%s\\n\' "$@" >"$FAKE_LOG_DIR/app-server.argv"\nenv >"$FAKE_LOG_DIR/app-server.env"\n',
)
chmodSync(QMCODE_REAL, 0o755)
writeFileSync(join(QMCODE_DIR, 'codex-code-mode-host'), '#!/bin/sh\nexit 0\n')
chmodSync(join(QMCODE_DIR, 'codex-code-mode-host'), 0o755)
symlinkSync('qmcode-rust-v0.158.0-0123456789-x86_64', QMCODE_LINK)
mkdirSync(join(STUB_HOME, 'warmup'), { recursive: true })
Bun.spawnSync([QMCODE_REAL, '--version'], {
  env: { PATH: '/usr/bin:/bin', FAKE_LOG_DIR: join(STUB_HOME, 'warmup') },
  stdout: 'ignore',
  stderr: 'ignore',
})

const scratches: string[] = [STUB_HOME]
const orphans: number[] = []

afterAll(() => {
  for (const pid of orphans) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {}
  }
  for (const dir of scratches.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

interface Scratch {
  readonly repo: string
  readonly root: string
  readonly logs: string
}

function scratch(
  options: {
    readonly modelEnv?: string | null
    /** secrets/handoff-model-env 的内容；缺省不写这份文件（走旧做法）。 */
    readonly handoffEnv?: string
    readonly handoffMode?: number
  } = {},
): Scratch {
  const base = mkdtempSync(join(tmpdir(), 'qianmo-handoff-node-sh-'))
  scratches.push(base)
  const repo = join(base, 'repo')
  const beta = join(repo, 'demo/env/beta')
  mkdirSync(beta, { recursive: true })
  copyFileSync(join(BETA_DIR, 'handoff-node.sh'), join(beta, 'handoff-node.sh'))
  const common = readFileSync(join(BETA_DIR, 'common.sh'), 'utf8')
  writeFileSync(join(beta, 'common.sh'), common + RECORDER)
  mkdirSync(join(repo, 'demo/lib'), { recursive: true })
  copyFileSync(
    join(REPOSITORY_ROOT, 'demo/lib/entry.sh'),
    join(repo, 'demo/lib/entry.sh'),
  )
  mkdirSync(join(repo, 'dist'), { recursive: true })
  writeFileSync(join(repo, 'dist/cli-node.js'), FAKE_OCC)

  const root = join(base, 'beta-root')
  mkdirSync(join(root, 'secrets'), { recursive: true })
  writeFileSync(join(root, '.qianmo-beta-env'), 'qianmo-beta-env/v1\n')
  writeFileSync(join(root, 'secrets', 'transport-psk'), `${PSK}\n`)
  chmodSync(join(root, 'secrets', 'transport-psk'), 0o600)
  const modelEnv =
    options.modelEnv === undefined
      ? `OPENAI_API_KEY=${MODEL_KEY}\nexport ANTHROPIC_API_KEY=${OTHER_KEY}\n`
      : options.modelEnv
  if (modelEnv !== null) {
    writeFileSync(join(root, 'secrets', 'model-env'), modelEnv)
    chmodSync(join(root, 'secrets', 'model-env'), 0o600)
  }
  if (options.handoffEnv !== undefined) {
    const file = join(root, 'secrets', 'handoff-model-env')
    writeFileSync(file, options.handoffEnv)
    chmodSync(file, options.handoffMode ?? 0o600)
  }
  const logs = join(base, 'logs')
  mkdirSync(logs, { recursive: true })
  return { repo, root, logs }
}

interface ShellResult {
  readonly exitCode: number
  readonly output: string
}

function run(
  place: Scratch,
  args: readonly string[],
  env: Readonly<Record<string, string>> = {},
): ShellResult {
  const child = Bun.spawnSync(
    ['/bin/bash', join(place.repo, 'demo/env/beta/handoff-node.sh'), ...args],
    {
      cwd: place.repo,
      // 环境从零拼，不继承开发机的：那里可能有真 key，而录制桩会把环境整份写进文件。
      env: {
        PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
        HOME: place.root.replace(/\/beta-root$/, ''),
        LANG: process.env.LANG ?? 'en_US.UTF-8',
        QIANMO_BETA_ROOT: place.root,
        QIANMO_HANDOFF_BASE_URL: BASE_URL,
        QIANMO_QMCODE_BIN: QMCODE_LINK,
        FAKE_LOG_DIR: place.logs,
        OPENAI_API_KEY: OUTER_KEY,
        ...env,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )
  return {
    exitCode: child.exitCode,
    output: `${child.stdout.toString()}${child.stderr.toString()}`,
  }
}

const START = [
  'start',
  '--node',
  'cloud-1',
  '--trust',
  'hub=hub-public-key-0123456789',
  '--project',
  'atlas',
]

function bridge(place: Scratch): {
  readonly args: string[]
  readonly env: Record<string, string>
} {
  return JSON.parse(readFileSync(join(place.logs, 'bridge.json'), 'utf8'))
}

function appServerEnv(place: Scratch): Map<string, string> {
  const env = new Map<string, string>()
  for (const line of readFileSync(
    join(place.logs, 'app-server.env'),
    'utf8',
  ).split('\n')) {
    const at = line.indexOf('=')
    if (at > 0) env.set(line.slice(0, at), line.slice(at + 1))
  }
  return env
}

function everythingWritten(place: Scratch): string {
  const parts: string[] = []
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name)
      const stat = statSync(path, { throwIfNoEntry: false })
      if (stat === undefined) continue
      if (stat.isDirectory()) walk(path)
      else if (stat.isFile())
        parts.push(`${path}\n${readFileSync(path, 'utf8')}`)
    }
  }
  walk(join(place.root, 'handoff'))
  for (const dir of ['run', 'logs']) {
    if (existsSync(join(place.root, dir))) walk(join(place.root, dir))
  }
  return parts.join('\n')
}

describe('handoff-node.sh start', () => {
  test('先起节点桥、后起 app-server；app-server 带着那两个 -c（完成标准 5）', () => {
    const place = scratch()
    const r = run(place, START)
    expect(r.output).toContain('已起')
    expect(r.exitCode).toBe(0)
    expect(readFileSync(join(place.logs, 'order'), 'utf8')).toBe(
      'handoff-node\nhandoff-app-server\n',
    )

    const tokenFile = join(place.root, 'secrets', 'handoff-app-server-token')
    const handoff = join(place.root, 'handoff')
    expect(
      readFileSync(join(place.logs, 'app-server.argv'), 'utf8')
        .trimEnd()
        .split('\n'),
    ).toEqual([
      'app-server',
      '--listen',
      'ws://127.0.0.1:38631',
      '--ws-auth',
      'capability-token',
      '--ws-token-file',
      tokenFile,
      '-c',
      'mcp_servers.qianmo.enabled=false',
      '-c',
      'notify=[]',
    ])
    expect(bridge(place).args).toEqual([
      'handoff',
      'node',
      '--node',
      'cloud-1',
      '--root',
      join(handoff, 'node'),
      '--port',
      '38630',
      '--bind',
      '0.0.0.0',
      '--app-server',
      'ws://127.0.0.1:38631',
      '--app-server-token-file',
      tokenFile,
      '--app-server-home',
      join(handoff, 'home'),
      '--qmcode-home',
      join(handoff, 'qmcode-home'),
      '--app-server-pid-file',
      join(place.root, 'run', 'handoff-app-server.pid'),
      '--trust',
      'hub=hub-public-key-0123456789',
      '--project',
      'atlas',
    ])
    // 令牌本机生成、0600，下次 start 沿用同一把（正在跑的 app-server 认的就是它）。
    const token = readFileSync(tokenFile, 'utf8').trim()
    expect(token).toMatch(/^[0-9a-f]{64}$/)
    expect(statSync(tokenFile).mode & 0o777).toBe(0o600)
    expect(run(place, START).exitCode).toBe(0)
    expect(readFileSync(tokenFile, 'utf8').trim()).toBe(token)
  }, 20_000)

  test('模型 key 只进 app-server：节点桥、argv、配置、输出里都没有（完成标准 9）', () => {
    const place = scratch()
    const r = run(place, START)
    expect(r.exitCode).toBe(0)

    const node = bridge(place)
    expect(node.env.QIANMO_TRANSPORT_PSK).toBe(PSK)
    expect(node.env.OCC_IDENTITY).toBe('qianmo')
    // 运维 shell 里那把与 model-env 里的每个键都去掉了。
    expect(node.env.OPENAI_API_KEY).toBeUndefined()
    expect(node.env.ANTHROPIC_API_KEY).toBeUndefined()
    const bridgeText = JSON.stringify(node)
    for (const key of [MODEL_KEY, OUTER_KEY, OTHER_KEY]) {
      expect(bridgeText).not.toContain(key)
    }

    const app = appServerEnv(place)
    expect(app.get('OPENAI_API_KEY')).toBe(MODEL_KEY)
    expect(app.has('QIANMO_TRANSPORT_PSK')).toBe(false)
    expect(app.get('HOME')).toBe(join(place.root, 'handoff', 'home'))
    expect(app.get('QMCODE_HOME')).toBe(
      join(place.root, 'handoff', 'qmcode-home'),
    )

    const argv = readFileSync(join(place.logs, 'app-server.argv'), 'utf8')
    const written = everythingWritten(place)
    for (const key of [MODEL_KEY, OUTER_KEY, OTHER_KEY]) {
      expect(argv).not.toContain(key)
      expect(written).not.toContain(key)
      expect(r.output).not.toContain(key)
    }
    expect(r.output).toContain('已加载')
  }, 20_000)

  test('config.toml：网关、key 的名字、关掉插件与内置 MCP 的完整表', () => {
    const place = scratch({ modelEnv: `QIANMO_GATEWAY_KEY=${MODEL_KEY}\n` })
    expect(
      run(place, START, {
        QIANMO_HANDOFF_MODEL: 'gpt-test-model',
        QIANMO_HANDOFF_KEY_ENV: 'QIANMO_GATEWAY_KEY',
      }).exitCode,
    ).toBe(0)
    expect(appServerEnv(place).get('QIANMO_GATEWAY_KEY')).toBe(MODEL_KEY)
    expect(bridge(place).env.QIANMO_GATEWAY_KEY).toBeUndefined()

    const config = join(place.root, 'handoff', 'qmcode-home', 'config.toml')
    const text = readFileSync(config, 'utf8')
    expect(statSync(config).mode & 0o777).toBe(0o600)
    for (const line of [
      'model_provider = "qianmo"',
      'model = "gpt-test-model"',
      'approval_policy = "never"',
      'sandbox_mode = "workspace-write"',
      '[features]\nplugins = false',
      '[shell_environment_policy]\ninherit = "core"',
      '[sandbox_workspace_write]\nnetwork_access = true',
      `[model_providers.qianmo]\nname = "qianmo"\nbase_url = "${BASE_URL}"\nenv_key = "QIANMO_GATEWAY_KEY"\nwire_api = "responses"`,
      '[mcp_servers.qianmo]\ncommand = "qm"\nargs = ["handoff", "mcp"]\nenabled = false',
    ]) {
      expect(text).toContain(line)
    }
    expect(text).not.toContain(MODEL_KEY)
  }, 20_000)
})

describe('handoff-node.sh start 拒绝的情形', () => {
  test('没给网关地址：起之前就拒，一个进程都不起', () => {
    const place = scratch()
    const r = run(place, START, { QIANMO_HANDOFF_BASE_URL: '' })
    expect(r.exitCode).not.toBe(0)
    expect(r.output).toContain('QIANMO_HANDOFF_BASE_URL 没给')
    expect(existsSync(join(place.logs, 'order'))).toBe(false)
  })

  test('网关地址里有引号：拒收，不往 TOML 里拼', () => {
    const place = scratch()
    const r = run(place, START, {
      QIANMO_HANDOFF_BASE_URL: 'https://x.test/v1"\nmodel = "evil',
    })
    expect(r.exitCode).not.toBe(0)
    expect(r.output).toContain('拒收')
    expect(existsSync(join(place.root, 'handoff'))).toBe(false)
  })

  test('两份文件里都没有 KEY_ENV：起之前就拒，报出新文件的路径与权限', () => {
    // model-env 里只有别家的键；运维 shell 里那把不算数（节点桥本来就要剥掉它）。
    const place = scratch({ modelEnv: `ANTHROPIC_API_KEY=${OTHER_KEY}\n` })
    const r = run(place, START)
    expect(r.exitCode).not.toBe(0)
    expect(r.output).toContain(
      `把 OPENAI_API_KEY=… 写进 ${join(place.root, 'secrets', 'handoff-model-env')}（chmod 600`,
    )
    expect(existsSync(join(place.logs, 'order'))).toBe(false)
    for (const key of [OTHER_KEY, OUTER_KEY]) {
      expect(r.output).not.toContain(key)
    }
  })

  test('key 那一行没有值：节点桥停回去，不留半个节点', () => {
    const place = scratch({ handoffEnv: 'OPENAI_API_KEY=\n' })
    const r = run(place, START)
    expect(r.exitCode).not.toBe(0)
    expect(r.output).toContain('环境变量 OPENAI_API_KEY 是空的')
    expect(r.output).toContain('handoff-model-env 里那一行没有值')
    expect(readFileSync(join(place.logs, 'order'), 'utf8')).toBe(
      'handoff-node\n',
    )
    expect(existsSync(join(place.root, 'run', 'handoff-node.pid'))).toBe(false)
  })

  test('app-server 没起来：节点桥停回去', () => {
    const place = scratch()
    const r = run(place, START, { FAKE_FAIL_PROC: 'handoff-app-server' })
    expect(r.exitCode).not.toBe(0)
    expect(r.output).toContain('节点桥已停回去')
    expect(existsSync(join(place.root, 'run', 'handoff-node.pid'))).toBe(false)
  })

  test('qmcode 真实文件旁边没有 codex-code-mode-host：起之前就拒', () => {
    const place = scratch()
    // 默认路径 <部署树>/qmcode/qmcode：软链指向同目录的产物，而辅助程序不在。
    const dir = join(place.repo, 'qmcode')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'qmcode-x'), '#!/bin/sh\n', { mode: 0o755 })
    symlinkSync('qmcode-x', join(dir, 'qmcode'))
    const r = run(place, START, { QIANMO_QMCODE_BIN: '' })
    expect(r.exitCode).not.toBe(0)
    expect(r.output).toContain('旁边没有可执行的 codex-code-mode-host')
    expect(existsSync(join(place.logs, 'order'))).toBe(false)
  })
})

describe('handoff-node.sh 的 key 文件（secrets/handoff-model-env）', () => {
  test('有这份文件就用它：app-server 只拿到它，model-env 不载入、也不告警', () => {
    const place = scratch({ handoffEnv: `OPENAI_API_KEY=${HANDOFF_KEY}\n` })
    const r = run(place, START)
    expect(r.exitCode).toBe(0)
    expect(r.output).not.toContain('WARN')
    expect(r.output).toContain(
      `模型凭据   : 已加载（${join(place.root, 'secrets', 'handoff-model-env')}，1 个环境键，只给 app-server）`,
    )

    const app = appServerEnv(place)
    expect(app.get('OPENAI_API_KEY')).toBe(HANDOFF_KEY)
    // model-env 是常驻的：它里面别家的键不进 app-server。
    expect(app.has('ANTHROPIC_API_KEY')).toBe(false)

    // 节点桥：两份文件里的键名与运维 shell 里那把都去掉了。
    const node = bridge(place)
    expect(node.env.OPENAI_API_KEY).toBeUndefined()
    expect(node.env.ANTHROPIC_API_KEY).toBeUndefined()
    const bridgeText = JSON.stringify(node)
    const argv = readFileSync(join(place.logs, 'app-server.argv'), 'utf8')
    const written = everythingWritten(place)
    for (const key of [HANDOFF_KEY, MODEL_KEY, OUTER_KEY, OTHER_KEY]) {
      expect(bridgeText).not.toContain(key)
      expect(argv).not.toContain(key)
      expect(written).not.toContain(key)
      expect(r.output).not.toContain(key)
    }
  }, 20_000)

  test('自定 KEY_ENV 的键名也从节点桥剥掉', () => {
    const place = scratch({
      modelEnv: null,
      handoffEnv: `QIANMO_GATEWAY_KEY=${HANDOFF_KEY}\n`,
    })
    const r = run(place, START, {
      QIANMO_HANDOFF_KEY_ENV: 'QIANMO_GATEWAY_KEY',
      QIANMO_GATEWAY_KEY: OUTER_KEY,
    })
    expect(r.exitCode).toBe(0)
    expect(bridge(place).env.QIANMO_GATEWAY_KEY).toBeUndefined()
    expect(appServerEnv(place).get('QIANMO_GATEWAY_KEY')).toBe(HANDOFF_KEY)
  }, 20_000)

  test('没有这份文件时退回 model-env，并告警叫人挪过去', () => {
    const place = scratch()
    const r = run(place, START)
    expect(r.exitCode).toBe(0)
    expect(r.output).toContain(
      `WARN : 没有 ${join(place.root, 'secrets', 'handoff-model-env')}：app-server 的 key 这次取自`,
    )
    expect(r.output).toContain('（旧做法：取自 model-env）')
    expect(appServerEnv(place).get('OPENAI_API_KEY')).toBe(MODEL_KEY)
    for (const key of [MODEL_KEY, OUTER_KEY, OTHER_KEY]) {
      expect(r.output).not.toContain(key)
    }
  }, 20_000)

  test('文件在但没有 KEY_ENV：拒绝，不退回 model-env', () => {
    const place = scratch({ handoffEnv: `ANTHROPIC_API_KEY=${OTHER_KEY}\n` })
    const r = run(place, START)
    expect(r.exitCode).not.toBe(0)
    expect(r.output).toContain('handoff-model-env 里没有 OPENAI_API_KEY=…')
    expect(existsSync(join(place.logs, 'order'))).toBe(false)
    expect(r.output).not.toContain(OTHER_KEY)
  })

  test('权限不是 0600：拒绝，一个进程都不起', () => {
    const place = scratch({
      handoffEnv: `OPENAI_API_KEY=${HANDOFF_KEY}\n`,
      handoffMode: 0o644,
    })
    const r = run(place, START)
    expect(r.exitCode).not.toBe(0)
    expect(r.output).toContain('的权限是 -rw-r--r--，要 0600')
    expect(existsSync(join(place.logs, 'order'))).toBe(false)
    expect(r.output).not.toContain(HANDOFF_KEY)
  })

  test('是软链（哪怕指向一份 0600 的好文件）：拒绝', () => {
    const place = scratch()
    const real = join(place.root, 'secrets', 'elsewhere-env')
    writeFileSync(real, `OPENAI_API_KEY=${HANDOFF_KEY}\n`)
    chmodSync(real, 0o600)
    symlinkSync(real, join(place.root, 'secrets', 'handoff-model-env'))
    const r = run(place, START)
    expect(r.exitCode).not.toBe(0)
    expect(r.output).toContain('是一条软链')
    expect(existsSync(join(place.logs, 'order'))).toBe(false)
  })

  test('常驻节点不读它：beta_load_model_env 之后环境里没有这份文件的键', () => {
    const place = scratch({
      modelEnv: `OPENAI_BASE_URL=${BASE_URL}\n`,
      handoffEnv: `QIANMO_HANDOFF_ONLY_KEY=${HANDOFF_KEY}\n`,
    })
    const child = Bun.spawnSync(
      [
        '/bin/bash',
        '-c',
        [
          'set -euo pipefail',
          '. "$1"',
          'beta_load_model_env',
          'printf "base=%s\\nonly=%s\\n" "${OPENAI_BASE_URL:-}" "${QIANMO_HANDOFF_ONLY_KEY:-ABSENT}"',
        ].join('\n'),
        'handoff-key-file-test',
        join(place.repo, 'demo/env/beta/common.sh'),
      ],
      {
        env: {
          PATH: '/usr/bin:/bin',
          HOME: place.root.replace(/\/beta-root$/, ''),
          QIANMO_BETA_ROOT: place.root,
        },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
    expect(child.exitCode).toBe(0)
    expect(child.stdout.toString()).toBe(`base=${BASE_URL}\nonly=ABSENT\n`)
  })

  test('除了 common.sh 的定义与本脚本，没有别的起法脚本碰这份文件', () => {
    const users = readdirSync(BETA_DIR)
      .filter(name => name.endsWith('.sh'))
      .filter(name => {
        const text = readFileSync(join(BETA_DIR, name), 'utf8')
        return (
          text.includes('handoff-model-env') ||
          text.includes('BETA_HANDOFF_MODEL_ENV_FILE')
        )
      })
      .sort()
    expect(users).toEqual(['common.sh', 'handoff-node.sh'])
  })
})

describe('handoff-node.sh stop', () => {
  /** 一个已经脱离本进程的 sleep：死后由 init 收尸，`kill -0` 不会被僵尸骗住。 */
  function orphan(): number {
    const child = Bun.spawnSync([
      '/bin/sh',
      '-c',
      'sleep 60 >/dev/null 2>&1 & echo $!',
    ])
    const pid = Number(child.stdout.toString().trim())
    orphans.push(pid)
    return pid
  }

  function alive(pid: number): boolean {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  test('两个都停、pid 文件收掉、数据一个不删；再停一次说本来就没在跑', () => {
    const place = scratch()
    const runDir = join(place.root, 'run')
    mkdirSync(runDir, { recursive: true })
    const data = join(place.root, 'handoff', 'node', 'repos')
    mkdirSync(data, { recursive: true })
    const pids = { 'handoff-node': orphan(), 'handoff-app-server': orphan() }
    for (const [name, pid] of Object.entries(pids)) {
      writeFileSync(join(runDir, `${name}.pid`), `${pid}\n`)
    }

    const r = run(place, ['stop'])
    expect(r.exitCode).toBe(0)
    for (const [name, pid] of Object.entries(pids)) {
      expect(alive(pid)).toBe(false)
      expect(existsSync(join(runDir, `${name}.pid`))).toBe(false)
      expect(r.output).toContain(`已停止 ${name}`)
    }
    expect(existsSync(data)).toBe(true)

    const again = run(place, ['stop'])
    expect(again.exitCode).toBe(0)
    expect(again.output).toContain('handoff-node 本来就没在跑')
  }, 30_000)
})
