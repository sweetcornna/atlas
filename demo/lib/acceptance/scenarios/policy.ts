// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: MIT

/**
 * 策略维度：`--open-policy` 与 `--require-signed-tasks` 两态。
 *
 * 这一维的重点不是「开放放行、严格拒绝」那两条显然的，而是**那条反直觉的**：
 *
 *   `OPEN_POLICY` 只是不再*要求* token，它从不*跳过*验证。
 *
 * `NodeCapabilities.check()` 在 `message.cap !== undefined` 时**先**跑
 * `verifyCapability`，那个函数的入参里根本没有 policy 这一项，也没有办法传。
 * 所以开放策略下带一个坏 token 照样是 `E_CAP_INVALID`，nonce 照样被消费。
 * 三条场景把这件事从三个角度钉住：坏签名、过期、重放。
 *
 * 顺带钉住两条参数面的事实：默认是**严格**（P12.4 起 `requireSignedTasks`
 * 出厂为 true），以及两个开关同时给会在解析期直接报错、而不是按优先级和稀泥。
 */

import { Checks, stripMinifiedSourceFrame } from '../checks.js'
import { ACCEPTANCE_PSK } from '../local/driver.js'
import {
  mint,
  sendEnvelope,
  withBrokenSignature,
  receiptScene,
} from '../local/send.js'
import type { Scenario } from '../types.js'
import {
  ADDRESS,
  NODE,
  SENDER,
  SENDER_NODE,
  newParty,
  newTaskId,
  startNodeTrusting,
} from './fixtures.js'

export const policyScenarios: readonly Scenario[] = [
  {
    id: 'policy/open-admits-unsigned',
    dimension: 'policy',
    title: 'OPEN_POLICY：不带 token 的唤醒被放行',
    expected: "receipt='accepted'，且没有 error 信封",
    requires: ['spawn-node', 'raw-dial'],
    async run(ctx) {
      const party = newParty()
      const node = await startNodeTrusting(ctx, party, { policy: 'open' })
      const result = await sendEnvelope({
        url: node.endpoint,
        psk: ACCEPTANCE_PSK,
        fromNode: SENDER_NODE,
        from: SENDER,
        to: ADDRESS,
      })
      return new Checks()
        .eq(result.receipt, 'accepted', 'receipt')
        .eq(result.errorCode, undefined, 'error 信封的 code')
        .note('frames', result.frames.join('\n'))
        .done('开放策略放行无 token 唤醒')
    },
  },

  {
    id: 'policy/signed-refuses-unsigned-wake',
    dimension: 'policy',
    title: 'SIGNED_TASK_POLICY：不带 token 的唤醒被拒，且拒绝原因逐字可见',
    expected:
      "E_CAP_INSUFFICIENT + 'wake from ctl needs write-limited, presented read'",
    requires: ['spawn-node', 'raw-dial'],
    async run(ctx) {
      const party = newParty()
      const node = await startNodeTrusting(ctx, party, {
        policy: 'signed-task',
      })
      const result = await sendEnvelope({
        url: node.endpoint,
        psk: ACCEPTANCE_PSK,
        fromNode: SENDER_NODE,
        from: SENDER,
        to: ADDRESS,
      })
      return new Checks()
        .note('回执现场', receiptScene(result))
        .eq(result.receipt, 'rejected', 'receipt')
        .eq(result.errorCode, 'E_CAP_INSUFFICIENT', 'error code')
        .eq(
          result.errorReason,
          `wake from ${SENDER_NODE} needs write-limited, presented read`,
          'error reason',
        )
        .done('严格策略拒绝无 token 唤醒')
    },
  },

  {
    id: 'policy/signed-refuses-unsigned-task',
    dimension: 'policy',
    title: 'SIGNED_TASK_POLICY：不带 token 的 task.request 同样被拒',
    expected:
      "E_CAP_INSUFFICIENT + 'task.request from ctl needs write-limited, presented read'",
    requires: ['spawn-node', 'raw-dial'],
    async run(ctx) {
      const party = newParty()
      const node = await startNodeTrusting(ctx, party, {
        policy: 'signed-task',
      })
      const result = await sendEnvelope({
        url: node.endpoint,
        psk: ACCEPTANCE_PSK,
        fromNode: SENDER_NODE,
        from: SENDER,
        to: ADDRESS,
        type: 'task.request' as never,
        payload: { instruction: 'acceptance probe' },
      })
      return new Checks()
        .note('回执现场', receiptScene(result))
        .eq(result.receipt, 'rejected', 'receipt')
        .eq(result.errorCode, 'E_CAP_INSUFFICIENT', 'error code')
        .eq(
          result.errorReason,
          `task.request from ${SENDER_NODE} needs write-limited, presented read`,
          'error reason',
        )
        .done('严格策略拒绝无 token 任务')
    },
  },

  {
    id: 'policy/open-still-verifies-bad-token',
    dimension: 'policy',
    title: 'OPEN_POLICY 下坏签名的 token 仍然被验、仍然被拒',
    expected:
      "E_CAP_INVALID + 'capability signature does not verify'（开放策略不跳过验证）",
    requires: ['spawn-node', 'raw-dial'],
    async run(ctx) {
      const party = newParty()
      const node = await startNodeTrusting(ctx, party, { policy: 'open' })
      const taskId = newTaskId()
      const cap = withBrokenSignature(
        mint(party.issuer, { sub: ADDRESS, aud: NODE, taskId }),
      )
      const result = await sendEnvelope({
        url: node.endpoint,
        psk: ACCEPTANCE_PSK,
        fromNode: SENDER_NODE,
        from: SENDER,
        to: ADDRESS,
        cap,
        taskId,
      })
      return new Checks()
        .note('回执现场', receiptScene(result))
        .eq(result.receipt, 'rejected', 'receipt')
        .eq(result.errorCode, 'E_CAP_INVALID', 'error code')
        .eq(
          result.errorReason,
          'capability signature does not verify',
          'error reason',
        )
        .done('开放策略下坏 token 照样被拒')
    },
  },

  {
    id: 'policy/open-still-checks-expiry',
    dimension: 'policy',
    title: 'OPEN_POLICY 下过期的 token 仍然被拒',
    expected: "E_CAP_INVALID + 'capability has expired'",
    requires: ['spawn-node', 'raw-dial'],
    async run(ctx) {
      const party = newParty()
      const node = await startNodeTrusting(ctx, party, { policy: 'open' })
      const taskId = newTaskId()
      const now = Date.now()
      const cap = mint(party.issuer, {
        sub: ADDRESS,
        aud: NODE,
        taskId,
        nbf: now - 120_000,
        exp: now - 60_000,
      })
      const result = await sendEnvelope({
        url: node.endpoint,
        psk: ACCEPTANCE_PSK,
        fromNode: SENDER_NODE,
        from: SENDER,
        to: ADDRESS,
        cap,
        taskId,
      })
      return new Checks()
        .note('回执现场', receiptScene(result))
        .eq(result.receipt, 'rejected', 'receipt')
        .eq(result.errorCode, 'E_CAP_INVALID', 'error code')
        .eq(result.errorReason, 'capability has expired', 'error reason')
        .done('开放策略下过期 token 照样被拒')
    },
  },

  {
    id: 'policy/open-still-consumes-nonce',
    dimension: 'policy',
    title: 'OPEN_POLICY 下 nonce 照样被消费（重放被拒）',
    expected: "第二次 E_CAP_INVALID + 'capability nonce has already been used'",
    requires: ['spawn-node', 'raw-dial'],
    async run(ctx) {
      const party = newParty()
      const node = await startNodeTrusting(ctx, party, { policy: 'open' })
      const taskId = newTaskId()
      const cap = mint(party.issuer, { sub: ADDRESS, aud: NODE, taskId })
      const common = {
        url: node.endpoint,
        psk: ACCEPTANCE_PSK,
        fromNode: SENDER_NODE,
        from: SENDER,
        to: ADDRESS,
        cap,
        taskId,
      }
      const first = await sendEnvelope({
        ...common,
        payload: { trigger: 'manual', prompt: 'first' },
      })
      // payload 必须变：两条一字不差的信封会先撞上**传输层的指纹去重**，
      // 回的是 receipt='duplicate' 而不是能力层的 nonce 拒绝，测到的就成了
      // 另一个机制。
      const second = await sendEnvelope({
        ...common,
        payload: { trigger: 'manual', prompt: 'second' },
      })
      return new Checks()
        .eq(first.receipt, 'accepted', '第一次的 receipt')
        .eq(second.receipt, 'rejected', '第二次的 receipt')
        .eq(second.errorCode, 'E_CAP_INVALID', '第二次的 error code')
        .eq(
          second.errorReason,
          'capability nonce has already been used',
          '第二次的 error reason',
        )
        .done('开放策略下 nonce 仍然一次性')
    },
  },

  {
    id: 'policy/both-flags-refused',
    dimension: 'policy',
    title: '两个策略开关同时给 → 解析期报错，不按优先级和稀泥',
    expected:
      "非零退出 + 'resident takes either --open-policy or --require-signed-tasks, not both'",
    requires: ['exec-node-cli'],
    timeoutMs: 150_000,
    async run(ctx) {
      // 经 `ctx.driver.execHost` 而不是本地的 `runCli`：真机腿要问的是**那台
      // 机器上部署的那个二进制**怎么反应（p12 还是 x86_64），在 runner 上
      // spawn 一次只是把本地腿又跑了一遍（issue #61）。
      const host = await ctx.driver.execHost(ctx)
      const workspace = await host.mkdir('ws-main')
      const result = await host.exec(
        [
          'resident',
          '--node',
          'flagprobe',
          '--team',
          'acceptance',
          '--agent',
          `main=${workspace}`,
          '--port',
          // 解析期就该被拒，这个口不会被 bind —— 要的只是「语法上是个端口」
          // 加上「万一将来解析顺序变了，撞的也不是别人的服务」。
          String(await host.freePort()),
          '--hostname',
          '127.0.0.1',
          '--open-policy',
          '--require-signed-tasks',
        ],
        {
          env: { QIANMO_TRANSPORT_PSK: ACCEPTANCE_PSK },
          timeoutMs: 120_000,
        },
      )
      const output = stripMinifiedSourceFrame(
        `${result.stdout}\n${result.stderr}`,
      )
      return new Checks()
        .note('执行位置', host.describe)
        .expect(result.code !== 0, '退出码非零', result.code)
        .contains(
          output,
          'resident takes either --open-policy or --require-signed-tasks, not both',
          '错误输出',
        )
        .done('互斥开关在解析期就被挡住')
    },
  },

  {
    id: 'policy/default-is-signed',
    dimension: 'policy',
    title: '不给策略开关时默认是严格档，并且会警告没选',
    expected:
      "banner 里 requireSignedTasks=true，stderr 里出现 'no task policy was given'",
    requires: ['spawn-node'],
    async run(ctx) {
      const party = newParty()
      // 故意不经 fixtures 的 policy 参数：这里要测的正是「一个都不给」。
      const node = await ctx.driver.startNode(ctx, {
        name: NODE,
        agents: { main: `${ctx.workdir}/ws-main` },
        auth: { mode: 'psk', psk: ACCEPTANCE_PSK },
        policy: 'signed-task',
        omitPolicyFlag: true,
        trust: [`${party.peerNode}=${party.peerKeys.publicKey}`],
      })
      const banner = (await node.stdout())
        .split('\n')
        .find(line => line.includes('publicKey'))
      const stderr = await node.stderr()
      // 顺手验一次「默认真的是严格档」的行为面，而不是只信 banner 的字段：
      // 一条不带 token 的唤醒必须被拒。
      const probe = await sendEnvelope({
        url: node.endpoint,
        psk: ACCEPTANCE_PSK,
        fromNode: SENDER_NODE,
        from: SENDER,
        to: ADDRESS,
      })
      return new Checks()
        .note('启动 banner', banner ?? '(没有 banner)')
        .contains(banner, '"requireSignedTasks":true', 'banner 的策略字段')
        .contains(stderr, 'no task policy was given', 'stderr 的未选策略警告')
        .eq(probe.errorCode, 'E_CAP_INSUFFICIENT', '行为面：无 token 唤醒被拒')
        .done('默认档位是 SIGNED_TASK_POLICY 且会提醒没选')
    },
  },
]
