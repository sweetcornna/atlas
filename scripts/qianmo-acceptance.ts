#!/usr/bin/env bun
// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: MIT

/**
 * 阡陌端到端验收套件 —— 可执行入口。
 *
 * ```
 * bun run scripts/qianmo-acceptance.ts [--target local|fleet] [--only <前缀>…]
 *                                      [--out <目录>] [--timeout-ms <n>]
 *                                      [--list] [--keep-workdir]
 * ```
 *
 * 跑完输出两份：
 *   · `<out>/results.ndjson` —— 机器可读，一行一个场景，末行是汇总；
 *   · `<out>/SUMMARY.txt` + stdout —— 人可读汇总表，红的行带证据原文。
 *
 * 退出码：0 = 无 fail 无 error **且至少有一条场景真正调用过驱动**（skip 不影响）；
 * 1 = 有红，或者这一轮一条都没碰过被测目标；2 = 用法错。
 *
 * 最后那半句是 issue #61 的产物：真机腿曾经在驱动零调用的情况下报出
 * `pass=11 fail=0 skip=104` 与 exit 0。全绿与没跑必须给出不同的退出码。
 *
 * ## 为什么是一条独立入口，而不是一个 `.test.ts`
 *
 * `scripts/test-shards.sh` 那 62 个分片是**单元测试**的执行体：一个 `bun test`
 * 进程跑完一整个目录，靠目录隔离 mock 状态。这套件与它在三处不相容：
 *
 * ① **它要起真进程。** 每条场景 fork 一个 `qm resident`（外加它自己的 ACP
 *    子进程），跑满一遍要**十几分钟**。塞进分片会把一次 CI 从几分钟拖到半
 *    小时以上，而分片的设计前提正是「每格都快」。
 * ② **它要占 TCP 端口与真文件系统。** 分片之间是并行安全的纯内存单元测试，
 *    往里塞一个抢端口的成员，失败会以「别的分片偶发红」的形态出现 —— 那正是
 *    这仓库花了 55 次连红才治好的病。
 * ③ **它的红是产品结论，不是构建结论。** 已知缺陷（如 #44）就该红着，而分片
 *    是合并门禁：一条永远红的门禁等于没有门禁，两轮之后就会被人加豁免。
 *
 * 判定层与场景表的**纯逻辑**另有单测，落在 `demo/lib/acceptance/__tests__/`，
 * 由 `demo/lib` 那一格分片带跑 —— 于是「判定规则被改松了」「场景表里有重复
 * id」这类退化仍然有 CI 护栏。
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { renderSummary, toNdjson } from '../demo/lib/acceptance/report-core.js'
import { ALL_SCENARIOS } from '../demo/lib/acceptance/registry.js'
import {
  checkScenarioTable,
  DEFAULT_SCENARIO_TIMEOUT_MS,
  runSuite,
} from '../demo/lib/acceptance/runner.js'
import { LocalDriver } from '../demo/lib/acceptance/local/driver.js'
import {
  FleetDriver,
  fleetConfigFromEnv,
} from '../demo/lib/acceptance/fleet/driver.js'
import type {
  AcceptanceDriver,
  ScenarioResult,
} from '../demo/lib/acceptance/types.js'

const USAGE = `阡陌端到端验收套件

  bun run scripts/qianmo-acceptance.ts [选项]

选项
  --target local|fleet   验收目标，默认 local
  --only <前缀>          只跑 id 以此开头的场景，可重复（如 --only handshake/ --only audit/）
  --out <目录>           产物目录，默认 ~/qianmo-acceptance/<UTC 时间戳>
  --timeout-ms <n>       单场景默认超时，默认 ${DEFAULT_SCENARIO_TIMEOUT_MS}
  --keep-workdir         保留每个场景的临时目录，便于排查
  --list                 只列出场景表，不执行
  -h, --help             本页

退出码：0 全绿且真的碰过目标（skip 不影响）· 1 有 fail/error 或本轮零触达 · 2 用法错
`

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`)
}

function value(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

function values(name: string): string[] {
  const out: string[] = []
  for (let i = 0; i < process.argv.length; i += 1) {
    if (process.argv[i] === `--${name}`) {
      const next = process.argv[i + 1]
      if (next !== undefined && !next.startsWith('--')) out.push(next)
    }
  }
  return out
}

async function main(): Promise<number> {
  if (flag('help') || process.argv.includes('-h')) {
    process.stdout.write(USAGE)
    return 0
  }

  // 场景表自检先跑：两条同 id 会让 NDJSON 的主键失效，而那种错在一次
  // 十几分钟的真跑之后才发现太晚。
  const problems = checkScenarioTable(ALL_SCENARIOS)
  if (problems.length > 0) {
    process.stderr.write(`场景表有问题:\n${problems.join('\n')}\n`)
    return 2
  }

  if (flag('list')) {
    for (const scenario of ALL_SCENARIOS) {
      process.stdout.write(
        `${scenario.id}\t${scenario.dimension}\t${scenario.title}` +
          `${scenario.knownIssue === undefined ? '' : `\t[${scenario.knownIssue}]`}\n`,
      )
    }
    process.stdout.write(`\n共 ${ALL_SCENARIOS.length} 条场景\n`)
    return 0
  }

  const target = value('target') ?? 'local'
  let driver: AcceptanceDriver
  if (target === 'local') {
    driver = new LocalDriver()
  } else if (target === 'fleet') {
    driver = new FleetDriver(fleetConfigFromEnv())
    process.stderr.write(
      '注意：真机腿的拨号走 H 上的隧道口 38631–38634。' +
        '不在 H 上跑就先把 `ssh -N -L 3863x:127.0.0.1:3863x <H>` 起起来，' +
        '或用 QIANMO_ACCEPTANCE_DIAL_HOST / QIANMO_ACCEPTANCE_ENDPOINT_<节点> 改道。\n',
    )
  } else {
    process.stderr.write(`未知 --target ${target}\n${USAGE}`)
    return 2
  }

  const outDir =
    value('out') ??
    join(
      homedir(),
      'qianmo-acceptance',
      new Date().toISOString().replaceAll(':', '-').replace(/\..*$/, 'Z'),
    )
  mkdirSync(outDir, { recursive: true, mode: 0o700 })

  const only = values('only')
  const timeoutRaw = value('timeout-ms')
  const timeoutMs =
    timeoutRaw === undefined ? undefined : Number.parseInt(timeoutRaw, 10)

  const commit = Bun.spawnSync(['git', 'rev-parse', '--short', 'HEAD'])
    .stdout.toString()
    .trim()

  process.stdout.write(
    `阡陌端到端验收套件 · target=${target} · 场景 ${
      only.length === 0 ? ALL_SCENARIOS.length : `匹配 ${only.join(' ')}`
    } · 产物 ${outDir}\n\n`,
  )

  const mark: Record<ScenarioResult['outcome'], string> = {
    pass: 'PASS',
    fail: 'FAIL',
    skip: 'SKIP',
    error: ' ERR',
  }

  const run = await runSuite({
    driver,
    scenarios: ALL_SCENARIOS,
    ...(only.length === 0 ? {} : { only }),
    ...(timeoutMs === undefined || Number.isNaN(timeoutMs)
      ? {}
      : { timeoutMs }),
    keepWorkdir: flag('keep-workdir'),
    commit,
    onResult: result => {
      // 实时打一行，长跑时人能看见进度；详情留给最后的汇总表。
      process.stdout.write(
        `${mark[result.outcome]}  ${result.id}  (${(result.durationMs / 1000).toFixed(1)}s)` +
          `${result.knownIssue === undefined ? '' : `  [${result.knownIssue}]`}\n`,
      )
    },
  })

  const ndjsonPath = join(outDir, 'results.ndjson')
  const summaryPath = join(outDir, 'SUMMARY.txt')
  const summary = renderSummary(run)
  writeFileSync(ndjsonPath, toNdjson(run), { mode: 0o600 })
  writeFileSync(summaryPath, summary, { mode: 0o600 })

  process.stdout.write(`\n${summary}\n`)
  process.stdout.write(`机器可读: ${ndjsonPath}\n人可读:   ${summaryPath}\n`)
  return run.pass ? 0 : 1
}

process.exitCode = await main()
