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
 * 节点的两次 apply 串行，同机不同根的节点也串行。另外
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
import { ProviderExecutor } from '@qianmo/node/commands/consoleProvidersExec.js'
import { fakeSsh } from '../../../../atlas/packages/node/test/commands/consoleProvidersFakeNode.js'

const REPO = resolve(import.meta.dir, '../../../..')
const SCRIPT = join(REPO, 'demo/env/beta/ops/model-apply.sh')
const BASH = Bun.which('bash')
if (BASH === null) throw new Error('这套用例要 bash')
/**
 * The PATH the script runs under in these cases (`sshdEnv`): flock has to be
 * on THAT path for the script to take the flock branch. Linux runners have
 * `/usr/bin/flock` (util-linux); stock macOS has none, so there the flock
 * cases are skipped — by name, so a CI log shows whether they ran.
 */
const SCRIPT_SYSTEM_PATH = '/usr/bin:/bin'
const HAS_FLOCK = Bun.which('flock', { PATH: SCRIPT_SYSTEM_PATH }) !== null

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
      QIANMO_CONFIG_DIR: process.env.QIANMO_CONFIG_DIR ?? null,
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
function tree(
  nodes: readonly string[] = ['beta-1', 'beta-2'],
  lockMode?: 'mkdir' | 'flock',
): Tree {
  count += 1
  const dir = join(SHARED, `t${count}`)
  const beta = join(dir, 'repo/demo/env/beta')
  mkdirSync(join(beta, 'ops'), { recursive: true })
  if (lockMode === 'mkdir') {
    writeFileSync(
      join(beta, 'common.sh'),
      readFileSync(join(REPO, 'demo/env/beta/common.sh'), 'utf8') +
        '\nbeta_model_flock() { :; }\n',
    )
  } else
    symlinkSync(join(REPO, 'demo/env/beta/common.sh'), join(beta, 'common.sh'))
  symlinkSync(SCRIPT, join(beta, 'ops/model-apply.sh'))
  mkdirSync(join(dir, 'repo/dist'), { recursive: true })
  writeFileSync(
    join(dir, `repo/dist/qm-${process.platform}-${process.arch}`),
    `#!${process.execPath}\n${FAKE_QM.replace(/^#![^\n]*\n/, '')}`,
    { mode: 0o755 },
  )
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
    PATH: `${resolve(process.execPath, '..')}:${SCRIPT_SYSTEM_PATH}`,
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
      QIANMO_CONFIG_DIR: join(t.root, 'nodes/beta-1/config'),
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
      expect(call.env.QIANMO_CONFIG_DIR).toBe(
        join(t.root, 'nodes/beta-1/config'),
      )
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

  /**
   * Both lock implementations, each with proof of which one ran: flock leaves
   * the `.lock` file behind (it is only ever opened), the mkdir lock holds a
   * `.lock.d` directory while busy and removes it afterwards.
   */
  const modes: {
    readonly name: string
    readonly kind: 'mkdir' | 'flock'
    readonly env: Record<string, string>
    readonly skip: boolean
  }[] = [
    {
      name: 'mkdir lock (fixture backend; runs everywhere)',
      kind: 'mkdir',
      env: {},
      skip: false,
    },
    {
      name: `flock lock (runs only where ${SCRIPT_SYSTEM_PATH} has flock, e.g. Linux CI; skipped otherwise)`,
      kind: 'flock',
      env: {},
      skip: !HAS_FLOCK,
    },
  ]
  const lockFile = (t: Tree) => join(t.home, '.qianmo-model-apply-host.lock')
  const lockDir = (t: Tree) => `${lockFile(t)}.d`
  for (const mode of modes) {
    test.skipIf(mode.skip)(
      `${mode.name}: two nodes under different roots share the host lock and run serially`,
      async () => {
        const t = tree(undefined, mode.kind)
        writeFileSync(join(t.records, 'delay-ms'), '1200')
        const env = sshdEnv(t, mode.env)
        await Promise.all([run(t, ['beta-1'], env), run(t, ['beta-1'], env)])
        const same = t.spans()
        expect(same).toHaveLength(2)
        const [a, b] = [...same].sort((x, y) => x.start - y.start)
        expect((b?.start ?? 0) >= (a?.end ?? Infinity)).toBe(true)
        // Which implementation ran.
        expect(existsSync(lockFile(t))).toBe(mode.kind === 'flock')
        expect(existsSync(lockDir(t))).toBe(false)

        // A second beta root under the same HOME must still use the very same lock.
        rmSync(join(t.records, 'spans.ndjson'))
        const otherRoot = join(t.home, 'other-beta-root')
        mkdirSync(join(otherRoot, 'nodes/beta-2/config'), { recursive: true })
        const results = await Promise.all([
          run(t, ['beta-1'], env),
          run(t, ['beta-2', '--root', otherRoot], env),
        ])
        expect(results.map(result => result.code)).toEqual([0, 0])
        const [c, d] = [...t.spans()].sort((x, y) => x.start - y.start)
        expect(t.spans()).toHaveLength(2)
        expect((d?.start ?? 0) >= (c?.end ?? Infinity)).toBe(true)
      },
      30_000,
    )

    test.skipIf(mode.skip)(
      `${mode.name}: conflicting lock overrides cannot split callers under the same service account`,
      async () => {
        const t = tree(undefined, mode.kind)
        const otherHome = join(t.dir, 'other-home')
        mkdirSync(otherHome)
        writeFileSync(join(t.records, 'delay-ms'), '600')
        const env = sshdEnv(t, {
          ...mode.env,
          QIANMO_MODEL_APPLY_LOCK_FILE: join(t.dir, 'shared/provider.lock'),
        })
        const results = await Promise.all([
          run(t, ['beta-1'], env),
          run(t, ['beta-2', '--root', t.root], {
            ...env,
            QIANMO_MODEL_APPLY_LOCK_FILE: join(otherHome, 'different.lock'),
          }),
        ])
        expect(results.map(result => result.code)).toEqual([0, 0])
        const spans = t.spans().sort((a, b) => a.start - b.start)
        expect(spans).toHaveLength(2)
        expect((spans[1]?.start ?? 0) >= (spans[0]?.end ?? Infinity)).toBe(true)
      },
      30_000,
    )
  }

  /**
   * The fixed 20 s wait cannot be shortened — that is what this case proves —
   * so the implementations sit it out at once instead of one after the other:
   * each in its own tree (its own `$HOME`, so its own host lock). Where flock
   * is missing only mkdir runs, and the name says which ran.
   */
  const waiting = modes.filter(mode => !mode.skip)
  async function waitPastLimit(mode: (typeof modes)[number]): Promise<void> {
    const t = tree(undefined, mode.kind)
    writeFileSync(join(t.records, 'delay-ms'), '22000')
    const env = sshdEnv(t, {
      ...mode.env,
      QIANMO_MODEL_APPLY_LOCK_WAIT_S: '1',
    })
    const first = run(t, ['beta-1'], env)
    for (let attempt = 0; attempt < 100 && t.calls().length === 0; attempt++)
      await Bun.sleep(50)
    expect(t.calls()).toHaveLength(1)
    const began = Date.now()
    const second = await run(t, ['beta-2'], env)
    // The deprecated one-second override cannot shorten the fixed 20 s wait.
    // mkdir uses second-resolution date, so allow one second of rounding.
    expect(Date.now() - began).toBeGreaterThanOrEqual(19_000)
    expect(second.code).toBe(1)
    expect(JSON.parse(second.stdout)).toMatchObject({
      v: 1,
      requestId: null,
      ok: false,
      code: 'busy',
    })
    // While the first one still holds it: the lock of this implementation.
    expect(existsSync(mode.kind === 'flock' ? lockFile(t) : lockDir(t))).toBe(
      true,
    )
    expect((await first).code).toBe(0)
    expect(t.calls()).toHaveLength(1)
  }
  test(`${waiting.map(mode => mode.kind).join(' and ')} lock, side by side: waiting past the limit answers busy instead of hanging`, async () => {
    // Every run to its end before judging, so a red names the implementation.
    const outcomes = await Promise.allSettled(
      waiting.map(mode => waitPastLimit(mode)),
    )
    expect(
      outcomes.flatMap((outcome, i) =>
        outcome.status === 'rejected'
          ? [`${waiting[i]?.kind}: ${String(outcome.reason)}`]
          : [],
      ),
    ).toEqual([])
  }, 35_000)

  test('mkdir stale reclamation with concurrent waiters preserves host serialization', async () => {
    const t = tree(undefined, 'mkdir')
    const lock = join(t.home, '.qianmo-model-apply-host.lock.d')
    mkdirSync(lock, { recursive: true })
    const gone = Bun.spawnSync(['true'])
    writeFileSync(join(lock, 'pid'), `${gone.pid}\n`)
    writeFileSync(join(t.records, 'delay-ms'), '150')
    const env = sshdEnv(t, { QIANMO_MODEL_APPLY_LOCK: 'mkdir' })
    const results = await Promise.all(
      ['beta-1', 'beta-2', 'beta-1', 'beta-2'].map(node => run(t, [node], env)),
    )
    expect(results.map(result => result.code)).toEqual([0, 0, 0, 0])
    const spans = t.spans().sort((a, b) => a.start - b.start)
    expect(spans).toHaveLength(4)
    for (let i = 1; i < spans.length; i++)
      expect((spans[i]?.start ?? 0) >= (spans[i - 1]?.end ?? Infinity)).toBe(
        true,
      )
  }, 30_000)

  test('mkdir lock: a lock left by a process that is gone is taken back', async () => {
    const t = tree(undefined, 'mkdir')
    const lock = join(t.home, '.qianmo-model-apply-host.lock.d')
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

describe('how sshd and the local executor start it', () => {
  test('real local executor, direct and SSH forced command share one lock despite conflicting environment overrides', async () => {
    const t = tree()
    writeFileSync(join(t.records, 'delay-ms'), '350')
    const otherRoot = join(t.home, 'other-beta')
    mkdirSync(join(otherRoot, 'nodes/beta-2/config'), { recursive: true })
    const customLock = join(t.dir, 'custom.lock')
    const env = sshdEnv(t, {
      QIANMO_MODEL_APPLY_LOCK_FILE: customLock,
      QIANMO_MODEL_APPLY_LOCK_WAIT_S: '0',
      QIANMO_MODEL_APPLY_LOCK: 'mkdir',
      QIANMO_BETA_ROOT: otherRoot,
    })
    const local = new ProviderExecutor(
      [{ kind: 'local', node: 'beta-2', command: t.script }],
      { knownHostsFile: '', env },
    )
    const ssh = fakeSsh(join(t.dir, 'ssh'))
    ssh.forcedCommand(`${BASH} ${t.script} beta-1 --root ${t.root}`)
    const knownHosts = join(t.dir, 'known_hosts')
    writeFileSync(knownHosts, 'node.example.net ssh-ed25519 AAAAFakeHostKey\n')
    const remote = new ProviderExecutor(
      [
        {
          kind: 'ssh',
          node: 'beta-1',
          host: 'node.example.net',
          user: 'ops',
          port: 22,
          keyFile: join(t.dir, 'key'),
        },
      ],
      { knownHostsFile: knownHosts, sshBinary: ssh.binary, env },
    )
    const request = {
      v: 1,
      op: 'status',
      requestId: 'shared-entry-lock',
      node: 'beta-2',
    }
    const results = await Promise.all([
      local.run('beta-2', request, 5000),
      run(t, ['beta-1', '--root', t.root], env),
      remote.run('beta-1', { ...request, node: 'beta-1' }, 5000),
    ])
    expect(results[0]).toMatchObject({ ok: true })
    expect(results[1]).toMatchObject({ code: 0 })
    expect(results[2]).toMatchObject({ ok: true })
    const spans = t.spans().sort((a, b) => a.start - b.start)
    expect(spans).toHaveLength(3)
    for (let i = 1; i < spans.length; i++)
      expect((spans[i]?.start ?? 0) >= (spans[i - 1]?.end ?? Infinity)).toBe(
        true,
      )
    expect(
      t
        .calls()
        .map(call => call.env.QIANMO_CONFIG_DIR)
        .sort(),
    ).toEqual(
      [
        join(t.root, 'nodes/beta-1/config'),
        join(t.root, 'nodes/beta-1/config'),
        join(otherRoot, 'nodes/beta-2/config'),
      ].sort(),
    )
    expect(existsSync(customLock) || existsSync(`${customLock}.d`)).toBe(false)
  }, 15_000)

  test('it is 100755 in the git index: both exec the path directly', () => {
    // The cases above run it as `bash <script>`, which passes without the bit;
    // sshd and the hub's local executor exec the path and would get EACCES.
    // The deploy payload comes from a clone, so the index is what counts.
    const out = Bun.spawnSync(
      ['git', 'ls-files', '-s', '--', 'demo/env/beta/ops/model-apply.sh'],
      { cwd: REPO },
    )
    expect(out.stdout.toString().trim().split(/\s+/)[0]).toBe('100755')
  })
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
