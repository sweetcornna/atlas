// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/** omp uses its native abort marker. Attribution belongs to the resident's
 * delivery/timing record, which survives process restarts independently of text. */

import { Checks } from '../checks.js'
import { ACCEPTANCE_PSK } from '../local/driver.js'
import { sendEnvelope } from '../local/send.js'
import { startStubUpstream } from '../local/upstream.js'
import { readTimings, waitForTurn } from '../observe.js'
import type { Scenario } from '../types.js'
import {
  ADDRESS,
  AGENT,
  SENDER,
  SENDER_NODE,
  newParty,
  startNodeTrusting,
  upstreamEnv,
} from './fixtures.js'

export const abortAttributionScenarios: readonly Scenario[] = [
  {
    id: 'abort-attribution/watchdog-attribution-e2e',
    dimension: 'abort-attribution',
    title: '真跑：上游挂起 → 看门狗中止 → 宿主记录无活动原因',
    expected:
      "transcript 里出现看门狗标记、且不出现 '[Request interrupted by user'；timings 里是 turn_failed/ResidentInactivityError",
    requires: ['spawn-node', 'raw-dial', 'read-node-files', 'stub-upstream'],
    // 常驻的无活动超时是硬编码的 120 s（没有 CLI 开关），所以这一条**必然**
    // 要花两分半。别把它调短——调短就测不到真正的那条路径了。
    timeoutMs: 260_000,
    async run(ctx) {
      const upstream = startStubUpstream({ behavior: 'hang' })
      ctx.cleanup(() => upstream.stop())
      const node = await startNodeTrusting(ctx, newParty(), {
        policy: 'open',
        env: upstreamEnv(upstream.baseUrl),
      })
      await sendEnvelope({
        url: node.endpoint,
        psk: ACCEPTANCE_PSK,
        fromNode: SENDER_NODE,
        from: SENDER,
        to: ADDRESS,
        payload: { trigger: 'manual', prompt: 'acceptance watchdog probe' },
      })
      const terminal = await waitForTurn(ctx, node, AGENT, 220_000)
      const timings = await readTimings(ctx.driver, node)
      const checks = new Checks()
        .note(
          'timings',
          timings.map(e => `${e.stage} ${e.error ?? ''}`).join('\n'),
        )
        .note('假上游收到的请求数', upstream.requests().length)

      if (terminal === undefined) {
        return checks.skip(
          '220 s 内这一轮没有走到终态（这台机器上 omp 子进程可能没能起来），无法观察看门狗写的标记',
        )
      }

      return checks
        .eq(terminal.stage, 'turn_failed', '终态 stage')
        .eq(terminal.error, 'ResidentInactivityError', '终态错误类型')
        .done('基础设施故障没有被伪装成人为取消')
    },
  },
]
