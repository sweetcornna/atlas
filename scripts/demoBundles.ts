#!/usr/bin/env bun
// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: MIT

/**
 * 把 `demo/lib/` 下**被 shell 脚本直接调起**的那几个入口打成自包含单文件，落进
 * `dist/demo/`。
 *
 * 为什么必须打包，而不是直接投 `.ts` 源文件：舰队的投递载荷是 `dist` + `demo` 两块
 * （没有 `node_modules`，也没有 `packages/`），而这几个入口 import 的是 `@qianmo/*`
 * **workspace 包**。于是投出去的树上，它们全都是「文件在、跑不起来」——
 *
 *     error: Cannot find module '@qianmo/protocol' from '…/demo/lib/p81-probe.ts'
 *
 * 这不是理论问题：2026-08-27 在 p11 上部署时，注册中心起不来（`@qianmo/registry`），
 * 冒烟的八条地址拨号探针**全崩**，而崩溃回溯的尾巴恰好是 `Bun v1.3.13 (Linux x64)`
 * ——冒烟脚本把那一行当作失败原因原样报了出来，读起来像「节点拨不通」，实际是探针
 * 自己没跑起来。一个报不出真话的自检比没有自检更坏。
 *
 * 真源仍然是 `demo/lib/*.ts`。这里只产出**构建产物**；`beta_demo_entry`（common.sh）
 * 优先用 `dist/demo/` 里的那份，取不到才回落到源文件，所以未构建的开发检出照常工作。
 *
 * 名单是「shell 脚本会调起的入口」，不是「demo/lib 下的全部文件」。判据是这一条，
 * 排掉注释行之后的调用点：
 *
 *     grep -rn 'demo/lib/[a-z0-9-]*\.ts' demo --include='*.sh' | grep -vE ':[0-9]+:\s*#'
 *
 * 新增脚本调用点时同步这里 —— 漏一条的症状不是构建失败，而是那个脚本在**投出去的
 * 机器上**才崩，且崩在 Bun 的模块解析层，错误信息与脚本自己想报的事情毫无关系。
 * `demo/lib/entry.sh` 的 `demo_entry` 是消费侧，两边是一对。
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** 被 shell 直接调起的入口。加一条前先确认它真的被某个 .sh 调用。 */
export const DEMO_ENTRYPOINTS = [
  'ac1-project-dir',
  'ac3-loop-rate',
  'ac6a-sandbox',
  'ac6b-restore',
  'chaos-inject',
  'p51-diagnosis',
  'p61-scenario',
  'p61-seed',
  'p61-worker',
  'p73-throughput',
  'p81-probe',
  'p81-registry',
] as const

export async function writeDemoBundles(outdir: string): Promise<number> {
  const dest = join(outdir, 'demo')
  const result = await Bun.build({
    entrypoints: DEMO_ENTRYPOINTS.map(name => `demo/lib/${name}.ts`),
    outdir: dest,
    // **root 必须钉死。**不给它，Bun 从入口集合推公共祖先——3 个入口时推出 `demo/lib`
    // （产物落 `dist/demo/<name>.js`），12 个时推出仓库根（产物落
    // `dist/demo/demo/lib/<name>.js`）。同一份代码，加一条入口就换一种布局，而消费侧
    // `demo_entry` 只认前一种：它会安静地回落到源文件，于是这一整个修复在部署树上等于
    // 没做。加一条入口不该改变已有入口的落位。
    root: 'demo/lib',
    target: 'bun',
  })
  if (!result.success) {
    // 逐条抛出来。静默产出一个缺文件的 dist/demo/ 会把问题推迟到部署现场。
    throw new AggregateError(result.logs, `demo 入口打包失败（${dest}）`)
  }
  // 落位当场核一遍。打包「成功」而文件不在 demo_entry 要找的那个路径上，是这段代码
  // 唯一会**静默**失效的方式（上面那条 root 注释就是它的由来）。
  const missing = DEMO_ENTRYPOINTS.filter(
    name => !existsSync(join(dest, `${name}.js`)),
  )
  if (missing.length > 0) {
    throw new Error(
      `demo 入口打包后不在预期位置：${missing.map(n => join(dest, `${n}.js`)).join('、')}` +
        '（demo/lib/entry.sh 的 demo_entry 只找这个路径）',
    )
  }
  return result.outputs.length
}
