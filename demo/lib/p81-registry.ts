// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 阡陌 P8.1 —— 演示拓扑的注册中心：把**多个**智能体地址登记到各自节点的入口上。
 *
 *   bun run demo/lib/p81-registry.ts --ready <file> --port 38610 \
 *     --register 'qianmo://node-a/planner=ws://127.0.0.1:38611' \
 *     --register 'qianmo://node-b/reviewer=ws://127.0.0.1:38612'
 *
 * 与 `p41-registry.ts` 的分工：那个是 AC-2 跑批用的，地址从 `ac2-env.ts` 读、**只登记
 * 一个**（沙箱里的那个目标节点）。演示环境要的是「两个节点互相能按名找到对方」，
 * 于是需要 N 条登记；把 p41 那个改成可变条数会动到 AC-2 的复现路径，所以这里另起一个
 * 文件，两个都只做自己那件事。**注册中心本体仍是 `@qianmo/registry`，没有第二张表。**
 *
 * 租约会过期（`DEFAULT_TTL_MS` = 90 s），所以本进程按周期续租——真实部署里该做的
 * 就是这件事；把 TTL 调大而不续租，测的就不是同一件事了（同 `p41-registry.ts`）。
 *
 * `--state` 打开落盘（`FileRegistryStore`，原子写），用来演示 P2.1 的「重启后表还在」。
 * 不给就是纯内存表——持久化是 opt-in，构造一个注册中心不该顺手写别人的配置根。
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute } from 'node:path'
import {
  FileRegistryStore,
  InMemoryRegistry,
  startRegistryServer,
} from '@qianmo/registry'
import { arg, intArg } from './cli-args.js'
import {
  announceRegistrations,
  type Registration,
} from './p81-announce-core.js'

/**
 * 收集重复出现的 `--register <address>=<endpoint>`。
 *
 * `cli-args.ts` 的 `arg()` 只取第一个同名参数——多节点拓扑正好需要多条，所以这里
 * 自己扫一遍 argv，而不是把 `arg()` 改成会返回数组（那会改到所有 demo 的取参语义）。
 */
function collectRegistrations(argv: readonly string[]): Registration[] {
  const out: Registration[] = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== '--register') continue
    const raw = argv[i + 1]
    if (raw === undefined) throw new Error('--register 缺少取值')
    const separator = raw.indexOf('=')
    if (separator <= 0) {
      throw new Error(`--register 必须是 <address>=<endpoint>，收到 ${raw}`)
    }
    out.push({
      address: raw.slice(0, separator),
      endpoint: raw.slice(separator + 1),
    })
    i++
  }
  return out
}

const readyFile = arg('ready')
if (readyFile === undefined || !isAbsolute(readyFile)) {
  throw new Error(
    '用法：--ready <绝对路径> --port <port> --register <a>=<ep> ...',
  )
}
const registrations = collectRegistrations(process.argv)
if (registrations.length === 0) {
  throw new Error('至少要有一条 --register <address>=<endpoint>')
}

const statePath = arg('state')
if (statePath !== undefined && !isAbsolute(statePath)) {
  throw new Error('--state 必须是绝对路径')
}
const registry = new InMemoryRegistry({
  ...(statePath === undefined
    ? {}
    : { store: new FileRegistryStore(statePath) }),
  onPersistError: error => {
    // 落盘失败不失败请求（表在内存里仍然权威），但**必须可见**。
    process.stderr.write(`registry 持久化失败：${String(error)}\n`)
  },
})

const server = startRegistryServer(intArg('port', 0), {
  registry,
  hostname: arg('host') ?? '127.0.0.1',
})

const announce = (): void => {
  for (const outcome of announceRegistrations(registry, registrations)) {
    // 端点搬家必须出声：命令行说的和名册答的曾经不一致过整整一轮部署，
    // 而那次没有任何一行输出（见 p81-announce-core.ts 的头注）。
    if (outcome.kind !== 'moved') continue
    process.stderr.write(
      `registry 端点已更新：${outcome.address} ${outcome.from} → ${outcome.to}\n`,
    )
  }
}

try {
  announce()
} catch (error) {
  await server.stop()
  throw error
}

const heartbeat = setInterval(
  () => {
    try {
      announce()
    } catch (error) {
      process.stderr.write(`registry 续租失败：${String(error)}\n`)
    }
  },
  intArg('heartbeat-ms', 20_000),
)
heartbeat.unref?.()

mkdirSync(dirname(readyFile), { recursive: true })
writeFileSync(
  readyFile,
  `${JSON.stringify({
    url: server.url,
    port: server.port,
    pid: process.pid,
    agents: registrations,
    ...(statePath === undefined ? {} : { state: statePath }),
  })}\n`,
  { mode: 0o600 },
)
process.stdout.write(
  `registry 就绪：${server.url}（${registrations.length} 条登记）\n`,
)
for (const { address, endpoint } of registrations) {
  process.stdout.write(`  ${address} → ${endpoint}\n`)
}

let stopping = false
const shutdown = async (signal: string): Promise<void> => {
  if (stopping) return
  stopping = true
  process.stdout.write(`收到 ${signal}，停止 registry\n`)
  clearInterval(heartbeat)
  await server.stop()
  process.exit(0)
}
process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
