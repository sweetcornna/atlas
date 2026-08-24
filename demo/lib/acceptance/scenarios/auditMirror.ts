// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: MIT

/**
 * 审计镜像 —— `qm console --audit-mirror` 那一面。
 *
 * **这一维只覆盖得了一半，另一半在报告里以 skip 出现，那是故意的。**
 *
 * 「审计镜像」是两件事拼起来的：
 *
 *   ① **搬运**：把源节点的 `trail.ndjson` 定期拉到控制台所在的机器上。
 *      那是 systemd timer + 隧道 + rsync 的活，本地腿一台机器、没有隧道、
 *      也没有单元文件，**造不出来**。`audit/mirror-pull-not-constructible`
 *      如实记 skip，不拿一次 `cp` 冒充它 —— 冒充出来的绿色恰好会掩盖那条
 *      链路上唯一会坏的东西（拉取停了而没人知道）。
 *
 *   ② **申报**：控制台把一个审计源标成「这是镜像，最大滞后 N 分钟」，并在
 *      读取面上把它与权威源分开。这一半完全在进程内，本地腿测得动，
 *      而且它正是 ① 坏掉时唯一的可见面 —— 所以更该测。
 *
 * 两条容易读反的事实：
 *
 *   · **镜像与权威的区别只由 `--audit-mirror` 决定，与路径无关**（帮助文本里
 *     写着 "paths never imply"）。角色是部署事实，不是文件属性。
 *   · 但**同一次启动里同一个路径只许出现一次**：两条 `--audit` 指向同一个文件
 *     会在解析期报 `--audit repeats path <路径>`。所以「同一个文件同时是镜像
 *     又是权威」这种写法造不出来 —— 本套件先按那个形状写过一版，控制台当场
 *     拒绝启动。两条规则合起来才是完整的：角色可以任配，文件不能重复申报。
 *
 * 「源端无链」在读取面上是可分辨的：缺席的镜像给 `chain:'absent'`，存在但没有
 * 记录的源给 `chain:'empty'` —— 与 `qm audit --verify` 的四态同一套词汇，
 * 不是控制台另造的一份。
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Checks, stripMinifiedSourceFrame } from '../checks.js'
import { http, startConsole, startRegistry } from '../local/console.js'
import { TRAIL_PATH } from '../observe.js'
import { ACCEPTANCE_PSK } from '../local/driver.js'
import { sendEnvelope } from '../local/send.js'
import type { Scenario } from '../types.js'
import {
  ADDRESS,
  SENDER,
  SENDER_NODE,
  newParty,
  startNodeTrusting,
} from './fixtures.js'

interface AuditSourceRow {
  readonly node?: string
  readonly kind?: string
  readonly maxLagMinutes?: number
  readonly page?: Record<string, unknown> | null
  readonly failure?: Record<string, unknown> | null
}

function sourcesOf(
  json: Record<string, unknown> | undefined,
): AuditSourceRow[] {
  const audits = json?.audits
  return Array.isArray(audits) ? (audits as AuditSourceRow[]) : []
}

export const auditMirrorScenarios: readonly Scenario[] = [
  {
    id: 'audit/mirror-and-authoritative-are-distinguishable',
    dimension: 'audit',
    title: '同一次读取里，镜像源与权威源可分辨且带出滞后上限',
    expected:
      "GET /v0/audit 的每个源各带 kind；被 --audit-mirror 点名的那个是 'mirror' 且带 maxLagMinutes，另一个是 'authoritative' 且不带",
    requires: ['spawn-console', 'spawn-node', 'raw-dial', 'read-node-files'],
    timeoutMs: 180_000,
    async run(ctx) {
      const registry = await startRegistry(ctx)
      // 一条**真**审计链：起一个节点、发一条会被拒的消息，让它写几行出来。
      const node = await startNodeTrusting(ctx, newParty(), {
        policy: 'signed-task',
      })
      await sendEnvelope({
        url: node.endpoint,
        psk: ACCEPTANCE_PSK,
        fromNode: SENDER_NODE,
        from: SENDER,
        to: ADDRESS,
        payload: { trigger: 'manual', prompt: 'mirror seed' },
        settleMs: 800,
      })
      const trail = join(node.configRoot, TRAIL_PATH)
      // 镜像源就是源端那条链在本机的一份副本 —— 这正是镜像**是什么**。
      // 注意这里没有在测「副本是怎么来的」（那是搬运，见本文件末尾那条 skip），
      // 测的是控制台拿到一份副本之后怎么申报它。
      const mirrored = join(ctx.workdir, 'mirrored-trail.ndjson')
      writeFileSync(mirrored, readFileSync(trail, 'utf8'))

      const console_ = await startConsole(ctx, {
        registryUrl: registry.url,
        extraArgs: [
          '--audit',
          `remote=${mirrored}`,
          '--audit',
          `local=${trail}`,
          '--audit-mirror',
          'remote=45',
        ],
      })
      const probe = await http(`${console_.url}/v0/audit`, {
        token: console_.viewToken,
      })
      const sources = sourcesOf(probe.json)
      const mirror = sources.find(source => source.node === 'remote')
      const authoritative = sources.find(source => source.node === 'local')

      return (
        new Checks()
          .note('审计链路径', trail)
          .note('/v0/audit', probe.body.slice(0, 2_000))
          .eq(probe.status, 200, '状态码')
          .eq(sources.length, 2, '申报的审计源个数')
          .eq(mirror?.kind, 'mirror', 'remote 源的 kind')
          .eq(mirror?.maxLagMinutes, 45, 'remote 源的 maxLagMinutes')
          .eq(authoritative?.kind, 'authoritative', 'local 源的 kind')
          .eq(
            authoritative?.maxLagMinutes,
            undefined,
            'local 源的 maxLagMinutes（权威源没有滞后一说）',
          )
          // 两个源都真的被读到了 —— 一个源坏掉时另一个照样出现，是这一面
          // 存在的理由。
          .expect(
            mirror?.page !== undefined && authoritative?.page !== undefined,
            '两个源都各自给出了读取结果',
            sources.map(source => `${source.node}/${source.kind}`).join(', '),
          )
          .expect(
            ((mirror?.page as { total?: number } | undefined)?.total ?? 0) > 0,
            '镜像源里真的有记录（证明读到的是那条链，不是一个空壳）',
            JSON.stringify(mirror?.page ?? null).slice(0, 300),
          )
          .done('镜像与权威在读取面上可分辨')
      )
    },
  },

  {
    id: 'audit/mirror-of-absent-trail',
    dimension: 'audit',
    title: '源端还没有链时，镜像源读出来是什么（而不是把控制台带崩）',
    expected:
      '镜像指向一个不存在的文件时，/v0/audit 仍是 200，该源自己带出空结果或 failure，另一个源不受影响',
    requires: ['spawn-console'],
    timeoutMs: 180_000,
    async run(ctx) {
      const registry = await startRegistry(ctx)
      const present = join(ctx.workdir, 'present-trail.ndjson')
      mkdirSync(ctx.workdir, { recursive: true })
      writeFileSync(present, '')
      const missing = join(ctx.workdir, 'never-synced', 'trail.ndjson')

      const console_ = await startConsole(ctx, {
        registryUrl: registry.url,
        extraArgs: [
          '--audit',
          `remote=${missing}`,
          '--audit',
          `local=${present}`,
          '--audit-mirror',
          'remote=15',
        ],
      })
      const all = await http(`${console_.url}/v0/audit`, {
        token: console_.viewToken,
      })
      const one = await http(`${console_.url}/v0/audit?node=remote`, {
        token: console_.viewToken,
      })
      const sources = sourcesOf(all.json)
      const mirror = sources.find(source => source.node === 'remote')
      const local = sources.find(source => source.node === 'local')

      return (
        new Checks()
          .note('缺席的镜像路径', missing)
          .note('/v0/audit', all.body.slice(0, 2_000))
          .note(
            '/v0/audit?node=remote',
            `${one.status} ${one.body.slice(0, 800)}`,
          )
          // 控制台起得来是这条的第一半：一个还没同步过的镜像不该让它拒绝启动。
          .eq(all.status, 200, '合并读取的状态码')
          .eq(sources.length, 2, '申报的审计源个数')
          .eq(mirror?.kind, 'mirror', 'remote 源仍然申报为 mirror')
          // 「链不存在」与「链为空」在控制台这一面照样可分辨，用的是
          // `qm audit --verify` 的同一套词汇（issue #9② 的判据）。
          .eq(
            (mirror?.page as { chain?: string } | undefined)?.chain,
            'absent',
            '缺席镜像源的 chain',
          )
          .eq(
            (local?.page as { chain?: string } | undefined)?.chain,
            'empty',
            '存在但零记录的权威源的 chain',
          )
          .expect(
            mirror?.page !== undefined || mirror?.failure !== undefined,
            '缺席的镜像源自己给出了一个结果，而不是让整次读取失败',
            `page=${JSON.stringify(mirror?.page ?? null).slice(0, 200)} failure=${JSON.stringify(mirror?.failure ?? null).slice(0, 200)}`,
          )
          // 另一个源不受牵连 —— 一台机器上的一条链断了不该让整面看不见。
          .expect(
            local?.failure === undefined || local?.failure === null,
            '权威源不受缺席镜像的牵连',
            JSON.stringify(local ?? null).slice(0, 300),
          )
          .eq(one.status, 200, '单独读镜像源的状态码')
          .done('缺席的镜像被隔离在它自己那一行里')
      )
    },
  },

  {
    id: 'audit/mirror-must-name-a-configured-source',
    dimension: 'audit',
    title:
      '审计源申报的两条解析期规则：镜像必须点名已配的源、同一路径不许申报两次',
    expected:
      "非零退出 + '--audit-mirror names unknown audit node <名字>'；两条 --audit 指同一路径 → '--audit repeats path <路径>'",
    requires: ['exec-node-cli'],
    timeoutMs: 240_000,
    async run(ctx) {
      // 两条都是**解析期**规则，所以这里不会有控制台真的起来、也不会 bind
      // 那个口；经驱动跑是为了让真机腿问的是那台机器上部署的那个二进制。
      const host = await ctx.driver.execHost(ctx)
      const trail = await host.writeFile('trail.ndjson', '')
      const result = await host.exec(
        [
          'console',
          '--port',
          String(await host.freePort()),
          '--hostname',
          '127.0.0.1',
          '--audit',
          `local=${trail}`,
          '--audit-mirror',
          'remote=30',
        ],
        { timeoutMs: 100_000 },
      )
      const output = stripMinifiedSourceFrame(
        `${result.stdout}\n${result.stderr}`,
      )
      // 第二条规则：同一个路径不许被申报两次。这条挡掉的是「让同一个文件既
      // 当镜像又当权威」的写法 —— 本套件先按那个形状写过一版并撞在这里。
      const duplicate = await host.exec(
        [
          'console',
          '--port',
          String(await host.freePort()),
          '--hostname',
          '127.0.0.1',
          '--audit',
          `local=${trail}`,
          '--audit',
          `remote=${trail}`,
        ],
        {
          env: { OCC_CONFIG_DIR: await host.mkdir('console-config-2') },
          timeoutMs: 100_000,
        },
      )
      const duplicateOutput = stripMinifiedSourceFrame(
        `${duplicate.stdout}\n${duplicate.stderr}`,
      )
      return new Checks()
        .note('执行位置', host.describe)
        .note('输出', output.slice(0, 1_500))
        .note('重复路径的输出', duplicateOutput.slice(0, 1_500))
        .expect(result.code !== 0, '点名未知源时退出码非零', result.code)
        .contains(
          output,
          '--audit-mirror names unknown audit node remote',
          '错误输出',
        )
        .expect(duplicate.code !== 0, '重复路径时退出码非零', duplicate.code)
        .contains(
          duplicateOutput,
          `--audit repeats path ${trail}`,
          '重复路径的错误输出',
        )
        .done('两条申报规则都在解析期生效')
    },
  },

  {
    id: 'audit/mirror-pull-not-constructible',
    dimension: 'audit',
    title: '镜像的「搬运」那一半：本地腿造不出，如实记 skip',
    expected:
      '这条要的是「源端的 trail 被定期同步到控制台机器上，停了要被发现」，需要 systemd 定时器 + 隧道 + 两台机器',
    requires: ['exec-node-cli'],
    timeoutMs: 60_000,
    async run() {
      return new Checks()
        .note(
          '为什么不用一次 cp 代替',
          '拉取链路上唯一会坏的东西是「它停了而没人知道」。一次 cp 一定成功，于是这条场景会永远绿，而绿的那一刻恰好证明不了任何事。宁可空着，也不要一条测不到目标的绿。',
        )
        .note(
          '这条属于哪条腿',
          '真机腿：源节点写链 → 定时器把它拉到控制台机器 → 控制台按 --audit-mirror 申报的滞后上限判定它是否新鲜。本地腿只有一台机器、没有隧道、没有单元文件，三个前提一个都不成立。',
        )
        .note(
          '本地腿已经覆盖的那一半',
          'audit/mirror-and-authoritative-are-distinguishable 与 audit/mirror-of-absent-trail —— 申报与读取这一半是进程内的，测得动，而且它正是搬运停掉时唯一的可见面。',
        )
        .skip(
          '镜像的搬运需要 systemd 定时器 + 隧道 + 源与镜像两台机器；本地腿三个前提都不具备。用一次 cp 冒充会得到一条永远绿的场景，那比空着更糟。',
        )
    },
  },
]
