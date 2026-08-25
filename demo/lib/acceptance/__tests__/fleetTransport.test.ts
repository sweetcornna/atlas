// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: MIT

/**
 * `FleetDriver` 把 SSH 传输层与被测系统分开说的那几条护栏（issue #96）。
 *
 * 这三条都属于「改坏了要到下一次真跑才发现」，而真跑一轮两小时、还得有人手动
 * 起隧道 —— 所以它们必须落在分片里。
 *
 * ## 怎么注入而不用 mock
 *
 * 假一个 `ssh` 出来，经 `FleetConfig.sshBin` 交给驱动。整个套件的 SSH 面因此
 * 可控，而一个 `mock.module` 都不用加（仓库的 mock 卫生棘轮对内联 mock 零容忍，
 * 而这里本来也不需要）。假 ssh 拿到的**最后一个参数**就是远端命令原文，按内容
 * 回不同的答案 —— 退出码 255 就是一次传输层失败。
 *
 * 为什么不改 `PATH`：`Bun.spawn(['ssh', …])` 的可执行文件解析用的是**进程启动
 * 时**的 PATH，测试里改 `process.env.PATH` 对它无效（实测 `Bun.which` 回 null）。
 */

import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FleetDriver } from '../fleet/driver.js'
import { cleanupFailures, summarize } from '../report-core.js'
import { runScenario } from '../runner.js'
import { TRANSPORT_RETRY_ATTEMPTS } from '../transport.js'
import type { Scenario, ScenarioResult } from '../types.js'

/** 假 ssh 回给 `mktemp -d` 的那个根，形状与真的一致（带 SCRATCH_PREFIX）。 */
const FAKE_ROOT = '/home/fake/.cache/qianmo-acceptance/run.AAAABBBB'

const madeDirs: string[] = []

afterEach(() => {
  for (const dir of madeDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

/**
 * 写一个假 `ssh` 到临时目录，返回它的绝对路径。
 *
 * `script` 是 bash 片段，进来时 `$cmd` 已经是远端命令原文。
 */
function fakeSsh(script: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'qm-fake-ssh-'))
  madeDirs.push(dir)
  const bin = join(dir, 'ssh')
  writeFileSync(bin, `#!/bin/bash\ncmd="\${@: -1}"\n${script}\nexit 0\n`, {
    mode: 0o755,
  })
  return bin
}

function driver(sshBin: string): FleetDriver {
  return new FleetDriver({
    hosts: [
      {
        ssh: 'fake-host',
        node: 'beta-1',
        tunnelPort: 38_631,
        endpoint: 'ws://127.0.0.1:38631',
        configRoot: '/home/fake/qianmo-beta/nodes/beta-1/config',
        occPath: '/home/fake/atlas-beta/dist/cli-node.js',
      },
    ],
    spawnMachines: [{ ssh: 'fake-host', label: 'fake', repoRel: 'atlas-beta' }],
    psk: {},
    sshBin,
  })
}

/** 一条只做「开一次性目录」的场景 —— 清理由 runner 在 `finally` 里跑。 */
const OPEN_LAUNCHER: Scenario = {
  id: 'launcher/fake-open',
  dimension: 'launcher',
  title: '只开一次性目录，什么都不跑',
  expected: '开得出来',
  requires: ['run-launcher'],
  async run(ctx) {
    const host = await ctx.driver.launcherHost(ctx)
    return { ok: true, actual: host.betaRoot, evidence: [] }
  },
}

async function runOnce(
  sshBin: string,
  scenario = OPEN_LAUNCHER,
): Promise<ScenarioResult> {
  return await runScenario(scenario, driver(sshBin), 4_000, false, 1)
}

/** 结果里全部 `log` 证据拼成一段。 */
function logsOf(result: ScenarioResult): string {
  return result.evidence
    .filter(e => e.label === 'log')
    .map(e => e.value)
    .join('\n')
}

/** 假 ssh 的公共分支：家目录、mktemp、pgrep 清扫都照常答。 */
const HAPPY_PREFIX = [
  `if [[ "$cmd" == *"mktemp -d"* ]]; then printf '%s\\n' '${FAKE_ROOT}'; exit 0; fi`,
  `if [[ "$cmd" == *"pgrep"* ]]; then exit 0; fi`,
  `if [[ "$cmd" == *'$HOME'* ]]; then printf '/home/fake\\n'; exit 0; fi`,
].join('\n')

describe('一次性目录的清理（issue #96 ①）', () => {
  it('远端 rm 失败时，报告里看得见 —— 而不是静默丢下 107 MB', async () => {
    const bin = fakeSsh(
      [
        HAPPY_PREFIX,
        `if [[ "$cmd" == *"rm -rf --"* ]]; then`,
        `  printf 'rm=1\\nleft=104857\\n'`,
        `  printf 'rm: 无法删除: Read-only file system\\n' >&2`,
        `  exit 0`,
        `fi`,
      ].join('\n'),
    )
    const result = await runOnce(bin)
    // 场景本身仍然是绿的：清理失败是套件的运维债，不是被测系统答错了。
    expect(result.outcome).toBe('pass')
    const logs = logsOf(result)
    expect(logs).toContain('cleanup 失败')
    expect(logs).toContain('远端 rm -rf 失败 (1)')
    expect(logs).toContain('104857 KB')
    expect(logs).toContain(FAKE_ROOT)
    // 汇总表也要说出来 —— 它只展开红行的证据，绿行的残留原本一个字都没有。
    const run = summarize([result], {
      target: 'fleet',
      startedAt: '',
      finishedAt: '',
    })
    expect(cleanupFailures(run)).toHaveLength(1)
  })

  it('删是删掉了但目录还在（rm 报 0）也算没做干净', async () => {
    const bin = fakeSsh(
      [
        HAPPY_PREFIX,
        `if [[ "$cmd" == *"rm -rf --"* ]]; then printf 'rm=0\\nleft=42\\n'; exit 0; fi`,
      ].join('\n'),
    )
    const logs = logsOf(await runOnce(bin))
    expect(logs).toContain('删完目录还在，约 42 KB')
  })

  it('清理都成功时一个字都不多写（绿场景的产物不变）', async () => {
    const bin = fakeSsh(
      [
        HAPPY_PREFIX,
        `if [[ "$cmd" == *"rm -rf --"* ]]; then printf 'rm=0\\nleft=no\\n'; exit 0; fi`,
      ].join('\n'),
    )
    const result = await runOnce(bin)
    expect(result.outcome).toBe('pass')
    expect(result.evidence.filter(e => e.label === 'log')).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// issue #96 ②：来源探针无重试，且一台问不到就把整份结论降级成「未知」。
//
// 探针是**纯读一次日志**，重发绝对安全，而「问不到」的代价高得离谱 —— 那一轮
// 5 台里 4 台一致报 fa80e006…、只有 beta-2 抖了一下，首栏就写成「被测端 未知」。
// ---------------------------------------------------------------------------

/** 那一轮舰队上真实的那一版。 */
const FLEET_SHA = 'fa80e006f18a931cb6386b99a7d5e6503991e2a9'

/** 让假 ssh 记一笔调用次数，用来证明「重试了」或「没重试」。 */
function counterScript(file: string): string {
  return `printf 'x' >> '${file}'`
}

function countOf(file: string): number {
  try {
    return readFileSync(file, 'utf8').length
  } catch {
    return 0
  }
}

describe('来源探针的重试（issue #96 ②）', () => {
  it('前两次链路抖动、第三次答上 —— 那就是答上了，不记「未知」', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'qm-fake-ssh-'))
    madeDirs.push(dir)
    const counter = join(dir, 'calls')
    const bin = fakeSsh(
      [
        counterScript(counter),
        `n=$(wc -c < '${counter}' | tr -d ' ')`,
        `if [ "$n" -lt 3 ]; then`,
        `  printf 'kex_exchange_identification: Connection closed by remote host\\n' >&2`,
        `  exit 255`,
        `fi`,
        `printf 'log=/home/fake/qianmo-beta/logs/beta-1.out\\nreadable=yes\\nsourceCommit=${FLEET_SHA}\\n'`,
      ].join('\n'),
    )
    const units = (await driver(bin).testedProvenance()).units
    expect(units).toHaveLength(1)
    expect(units[0]?.commit).toBe(FLEET_SHA)
    expect(countOf(counter)).toBe(3)
  })

  it('打满还是不通：说的是「SSH 链路失败」并带上重发次数，不是「采集失败」', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'qm-fake-ssh-'))
    madeDirs.push(dir)
    const counter = join(dir, 'calls')
    const bin = fakeSsh(
      [
        counterScript(counter),
        `printf 'Connection closed by 149.118.61.165 port 22\\n' >&2`,
        `exit 255`,
      ].join('\n'),
    )
    const units = (await driver(bin).testedProvenance()).units
    expect(units[0]?.commit).toBeUndefined()
    expect(units[0]?.detail).toContain('SSH 链路失败 (255')
    expect(units[0]?.detail).toContain('对端关闭了连接')
    expect(units[0]?.detail).toContain('已重发 2 次')
    expect(countOf(counter)).toBe(TRANSPORT_RETRY_ATTEMPTS)
  })

  it('认证被拒这类「重试也没用」的 255 一次定音，不白打两次', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'qm-fake-ssh-'))
    madeDirs.push(dir)
    const counter = join(dir, 'calls')
    const bin = fakeSsh(
      [
        counterScript(counter),
        `printf 'fake-host: Permission denied (publickey).\\n' >&2`,
        `exit 255`,
      ].join('\n'),
    )
    const units = (await driver(bin).testedProvenance()).units
    expect(units[0]?.detail).toContain('重试没用')
    expect(countOf(counter)).toBe(1)
  })

  it('远端命令自己非零（不是 255）不算链路失败，也不重试', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'qm-fake-ssh-'))
    madeDirs.push(dir)
    const counter = join(dir, 'calls')
    const bin = fakeSsh(
      [counterScript(counter), `printf 'boom\\n' >&2`, `exit 2`].join('\n'),
    )
    const units = (await driver(bin).testedProvenance()).units
    expect(units[0]?.detail).toContain('采集失败 (2)')
    expect(countOf(counter)).toBe(1)
  })
})
