// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `model-apply.sh`：第六类动作在节点上的强制命令（P18.6，`providers-console-m1.md` §2.5）。
 *
 * 跑的是仓库里那一份真脚本：在临时目录里搭一棵「仓库」，`common.sh` 与脚本本身软链
 * 回仓库（脚本从**自己的位置**推仓库根与内测根），`dist/cli-node.js` 换成一个假的
 * `qm`——它记下自己的 argv、环境、stdin 与忙碌的时段，再回一行协议响应。
 *
 * 钉 §9.2 P18.6 一格里的三条：忽略 `SSH_ORIGINAL_COMMAND`；节点名不合法时拒绝；同一
 * 节点的两次 apply 串行（带正向对照：不同节点确实会并行，说明这条测得出重叠）。另外
 * 一条端到端：中枢执行器 → 假 sshd（强制命令就是这份脚本）→ 假 qm；强制命令那一行
 * 不在时，哨兵让操作失败。
 */

import { afterAll, describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ProviderExecutor } from '../../../../src/cli/handlers/consoleProvidersExec.js'
import { fakeSsh } from '../../../../src/cli/handlers/__tests__/consoleProvidersFakeNode.js'

const REPO = resolve(import.meta.dir, '../../../..')
const SCRIPT = join(REPO, 'demo/env/beta/ops/model-apply.sh')
const BASH = Bun.which('bash')
if (BASH === null) throw new Error('这套用例要 bash')
const HAS_FLOCK = Bun.which('flock') !== null

const FAKE_QM = String.raw`
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const records = join(import.meta.dir, '..', 'records')
const started = Date.now()
let input = ''
for await (const chunk of process.stdin) input += chunk
const line = input.split('\n')[0]
const argv = process.argv.slice(2)
appendFileSync(
  join(records, 'calls.ndjson'),
  JSON.stringify({
    argv,
    line,
    env: {
      OCC_CONFIG_DIR: process.env.OCC_CONFIG_DIR ?? null,
      OCC_IDENTITY: process.env.OCC_IDENTITY ?? null,
      SSH_ORIGINAL_COMMAND: process.env.SSH_ORIGINAL_COMMAND ?? null,
    },
  }) + '\n',
)
const delay = existsSync(join(records, 'delay-ms'))
  ? Number(readFileSync(join(records, 'delay-ms'), 'utf8'))
  : 0
if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay))
appendFileSync(
  join(records, 'spans.ndjson'),
  JSON.stringify({ node: argv[argv.length - 1], start: started, end: Date.now() }) + '\n',
)
const code = existsSync(join(records, 'exit-code'))
  ? Number(readFileSync(join(records, 'exit-code'), 'utf8'))
  : 0
if (code === 2) process.exit(2)
let requestId = null
try {
  requestId = JSON.parse(line).requestId ?? null
} catch {}
process.stdout.write(
  JSON.stringify(
    code === 0
      ? { v: 1, requestId, ok: true, state: null }
      : { v: 1, requestId, ok: false, code: 'conflict', message: 'x' },
  ) + '\n',
)
process.exit(code)
`

const SHARED = mkdtempSync(join(tmpdir(), 'qianmo-model-apply-'))
afterAll(() => rmSync(SHARED, { recursive: true, force: true }))

interface Tree {
  readonly dir: string
  /** `$HOME` of the node account; the beta root is its default `qianmo-beta`. */
  readonly home: string
  readonly script: string
  readonly root: string
  readonly records: string
  calls(): {
    argv: string[]
    line: string
    env: Record<string, string | null>
  }[]
  spans(): { node: string; start: number; end: number }[]
}

let count = 0
function tree(nodes: readonly string[] = ['beta-1', 'beta-2']): Tree {
  count += 1
  const dir = join(SHARED, `t${count}`)
  const beta = join(dir, 'repo/demo/env/beta')
  mkdirSync(join(beta, 'ops'), { recursive: true })
  symlinkSync(join(REPO, 'demo/env/beta/common.sh'), join(beta, 'common.sh'))
  symlinkSync(SCRIPT, join(beta, 'ops/model-apply.sh'))
  mkdirSync(join(dir, 'repo/dist'), { recursive: true })
  writeFileSync(join(dir, 'repo/dist/cli-node.js'), FAKE_QM)
  const records = join(dir, 'repo/records')
  mkdirSync(records)
  const home = join(dir, 'home')
  const root = join(home, 'qianmo-beta')
  for (const node of nodes) {
    mkdirSync(join(root, 'nodes', node, 'config'), { recursive: true })
  }
  const lines = (name: string) =>
    existsSync(join(records, name))
      ? readFileSync(join(records, name), 'utf8')
          .split('\n')
          .filter(line => line !== '')
          .map(line => JSON.parse(line))
      : []
  return {
    dir,
    home,
    script: join(beta, 'ops/model-apply.sh'),
    root,
    records,
    calls: () => lines('calls.ndjson'),
    spans: () => lines('spans.ndjson'),
  }
}

/**
 * The environment sshd hands a forced command: short, no `QIANMO_BETA_ROOT` (the
 * root is the default under `$HOME`), the client's command in `SSH_ORIGINAL_COMMAND`.
 */
function sshdEnv(
  t: Tree,
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    PATH: `${resolve(process.execPath, '..')}:/usr/bin:/bin`,
    HOME: t.home,
    SSH_ORIGINAL_COMMAND: 'qianmo-model-apply-v1',
    ...extra,
  }
}

const REQUEST = `${JSON.stringify({ v: 1, op: 'status', requestId: 'req-model-apply-1', node: 'beta-1' })}\n`

function run(
  t: Tree,
  args: readonly string[],
  env: Record<string, string>,
  stdin = REQUEST,
) {
  const proc = Bun.spawn([BASH as string, t.script, ...args], {
    env,
    stdin: new TextEncoder().encode(stdin),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return (async () => {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    return { stdout, stderr, code }
  })()
}

describe('model-apply.sh', () => {
  test('runs serve-stdin for its own node, under that node’s config root, stdin and stdout untouched', async () => {
    const t = tree()
    const result = await run(t, ['beta-1'], sshdEnv(t))
    expect(result.code).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({
      v: 1,
      requestId: 'req-model-apply-1',
      ok: true,
      state: null,
    })
    const [call] = t.calls()
    expect(call?.argv).toEqual(['provider', 'serve-stdin', '--node', 'beta-1'])
    expect(call?.line).toBe(REQUEST.trimEnd())
    expect(call?.env).toEqual({
      OCC_CONFIG_DIR: join(t.root, 'nodes/beta-1/config'),
      OCC_IDENTITY: 'qianmo',
      SSH_ORIGINAL_COMMAND: null,
    })
  }, 30_000)

  test('exit codes pass through: 1 is ok:false, 2 is no response', async () => {
    const t = tree()
    writeFileSync(join(t.records, 'exit-code'), '1')
    const refused = await run(t, ['beta-1'], sshdEnv(t))
    expect(refused.code).toBe(1)
    expect(JSON.parse(refused.stdout).code).toBe('conflict')
    writeFileSync(join(t.records, 'exit-code'), '2')
    const silent = await run(t, ['beta-1'], sshdEnv(t))
    expect(silent.code).toBe(2)
    expect(silent.stdout).toBe('')
  }, 30_000)

  test('ignores SSH_ORIGINAL_COMMAND: the node and the program come from the forced command only', async () => {
    const t = tree()
    const marker = join(t.dir, 'pwned')
    for (const original of [
      `provider serve-stdin --node beta-2`,
      `beta-2`,
      `; touch ${marker}`,
      `$(touch ${marker})`,
      `\`touch ${marker}\``,
    ]) {
      const result = await run(
        t,
        ['beta-1'],
        sshdEnv(t, { SSH_ORIGINAL_COMMAND: original }),
      )
      expect([original, result.code]).toEqual([original, 0])
    }
    expect(existsSync(marker)).toBe(false)
    for (const call of t.calls()) {
      expect(call.argv).toEqual(['provider', 'serve-stdin', '--node', 'beta-1'])
      expect(call.env.SSH_ORIGINAL_COMMAND).toBeNull()
      expect(call.env.OCC_CONFIG_DIR).toBe(join(t.root, 'nodes/beta-1/config'))
    }
    expect(t.calls()).toHaveLength(5)
  }, 30_000)

  test('refuses an invalid node name, a missing config root, or the wrong number of arguments', async () => {
    const t = tree(['beta-1'])
    mkdirSync(join(t.root, 'nodes', 'Beta-1', 'config'), { recursive: true })
    mkdirSync(join(t.root, 'nodes', 'beta_1', 'config'), { recursive: true })
    const cases: string[][] = [
      ['Beta-1'],
      ['beta_1'],
      [''],
      ['../beta-1'],
      ['beta-1/../beta-1'],
      ['a'.repeat(33)],
      ['beta-1 beta-2'],
      ['beta-1', 'beta-2'],
      [],
      ['beta-9'],
    ]
    for (const args of cases) {
      const result = await run(t, args, sshdEnv(t))
      const reply = JSON.parse(result.stdout) as Record<string, unknown>
      expect([
        args,
        result.code,
        reply.ok,
        reply.code,
        reply.requestId,
      ]).toEqual([args, 1, false, 'bad-request', null])
    }
    expect(t.calls()).toEqual([])
    // Positive control: the same tree serves its real node.
    expect((await run(t, ['beta-1'], sshdEnv(t))).code).toBe(0)
  }, 30_000)

  test('a node directory that is a symlink is refused', async () => {
    const t = tree(['beta-1'])
    symlinkSync(
      join(t.root, 'nodes', 'beta-1'),
      join(t.root, 'nodes', 'beta-3'),
    )
    const result = await run(t, ['beta-3'], sshdEnv(t))
    expect(result.code).toBe(1)
    expect(JSON.parse(result.stdout).code).toBe('bad-request')
    expect(t.calls()).toEqual([])
  }, 30_000)

  test('finds bun in ~/.bun/bin when sshd’s PATH has none', async () => {
    const t = tree()
    mkdirSync(join(t.home, '.bun/bin'), { recursive: true })
    symlinkSync(process.execPath, join(t.home, '.bun/bin/bun'))
    const env = { ...sshdEnv(t), PATH: '/usr/bin:/bin' }
    const result = await run(t, ['beta-1'], env)
    expect(result.code).toBe(0)
    // And without it, no response (exit 2) and nothing ran.
    rmSync(join(t.home, '.bun'), { recursive: true })
    const none = await run(t, ['beta-1'], env)
    expect(none.code).toBe(2)
    expect(none.stdout).toBe('')
    expect(t.calls()).toHaveLength(1)
  }, 30_000)

  const modes: [string, Record<string, string>][] = [
    ['mkdir lock', { QIANMO_MODEL_APPLY_LOCK: 'mkdir' }],
    ...(HAS_FLOCK ? [['flock', {}] as [string, Record<string, string>]] : []),
  ]
  for (const [mode, extra] of modes) {
    test(`${mode}: two applies on one node run one after the other; two nodes overlap`, async () => {
      const t = tree()
      writeFileSync(join(t.records, 'delay-ms'), '1200')
      const env = sshdEnv(t, extra)
      await Promise.all([run(t, ['beta-1'], env), run(t, ['beta-1'], env)])
      const same = t.spans()
      expect(same).toHaveLength(2)
      const [a, b] = [...same].sort((x, y) => x.start - y.start)
      expect((b?.start ?? 0) >= (a?.end ?? Infinity)).toBe(true)

      // Positive control: different nodes do overlap, so the check above can fail.
      rmSync(join(t.records, 'spans.ndjson'))
      await Promise.all([run(t, ['beta-1'], env), run(t, ['beta-2'], env)])
      const [c, d] = [...t.spans()].sort((x, y) => x.start - y.start)
      expect((d?.start ?? Infinity) < (c?.end ?? 0)).toBe(true)
    }, 30_000)

    test(`${mode}: waiting past the limit answers busy instead of hanging`, async () => {
      const t = tree()
      writeFileSync(join(t.records, 'delay-ms'), '2500')
      const env = sshdEnv(t, { ...extra, QIANMO_MODEL_APPLY_LOCK_WAIT_S: '1' })
      const first = run(t, ['beta-1'], env)
      await new Promise(resolve => setTimeout(resolve, 400))
      const second = await run(t, ['beta-1'], env)
      expect(second.code).toBe(1)
      expect(JSON.parse(second.stdout)).toMatchObject({
        v: 1,
        requestId: null,
        ok: false,
        code: 'busy',
      })
      expect((await first).code).toBe(0)
      expect(t.calls()).toHaveLength(1)
    }, 30_000)
  }

  test('mkdir lock: a lock left by a process that is gone is taken back', async () => {
    const t = tree()
    const lock = join(t.root, 'run', 'model-apply.beta-1.lock.d')
    mkdirSync(lock, { recursive: true })
    // A pid that is not running: a finished child's.
    const gone = Bun.spawnSync(['true'])
    writeFileSync(join(lock, 'pid'), `${gone.pid}\n`)
    const result = await run(
      t,
      ['beta-1'],
      sshdEnv(t, {
        QIANMO_MODEL_APPLY_LOCK: 'mkdir',
        QIANMO_MODEL_APPLY_LOCK_WAIT_S: '1',
      }),
    )
    expect(result.code).toBe(0)
    expect(existsSync(lock)).toBe(false)
  }, 30_000)
})

describe('the hub through ssh to model-apply.sh', () => {
  test('the forced command answers; without it the sentinel fails the operation', async () => {
    const t = tree()
    const ssh = fakeSsh(join(t.dir, 'ssh'))
    const knownHosts = join(t.dir, 'known_hosts')
    writeFileSync(
      knownHosts,
      'node1.example.net ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeHostKeyForTestsOnly000000000000000000\n',
    )
    const keyFile = join(t.dir, 'model-key')
    writeFileSync(keyFile, 'not a real key\n', { mode: 0o600 })
    const executor = new ProviderExecutor(
      [
        {
          node: 'beta-1',
          kind: 'ssh',
          user: 'qianmo',
          host: 'node1.example.net',
          port: 22,
          keyFile,
        },
      ],
      {
        knownHostsFile: knownHosts,
        sshBinary: ssh.binary,
        // The fake ssh hands the hub's (already minimal) environment to the
        // forced command, so HOME here plays the node account's home.
        env: {
          PATH: `${resolve(process.execPath, '..')}:/usr/bin:/bin`,
          HOME: t.home,
        },
      },
    )
    const request = {
      v: 1,
      op: 'status',
      requestId: 'req-chain-0001',
      node: 'beta-1',
    }
    ssh.forcedCommand(`${BASH} ${t.script} beta-1`)
    const answered = await executor.run('beta-1', request, 20_000)
    expect(answered.ok).toBe(true)
    expect(t.calls()[0]?.argv).toEqual([
      'provider',
      'serve-stdin',
      '--node',
      'beta-1',
    ])
    expect(t.calls()[0]?.env.SSH_ORIGINAL_COMMAND).toBeNull()

    ssh.forcedCommand(null)
    const lost = await executor.run(
      'beta-1',
      { ...request, requestId: 'req-chain-0002' },
      20_000,
    )
    expect(lost.ok).toBe(false)
    if (!lost.ok) expect(lost.reason).toBe('forced-command')
    expect(t.calls()).toHaveLength(1)
  }, 30_000)
})
