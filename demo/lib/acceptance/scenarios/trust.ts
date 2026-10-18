// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 信任层级维度 —— issue #47 的验收面。
 *
 * **先记住这条，不然断言会写错方向：常驻唤醒路径上 `notice.trust` 不门控执行。**
 * 全仓库**真的按这两个常量分支**的非测试文件是一张核对过的名单（实测，见
 * `trust/no-execution-gate`）：`adapter/src/wrapper.ts` 按档位给模型两句不同的
 * 英文，`protocol/src/validate.ts` 把线上的 `envelope.trust` 钉死成
 * `untrusted`（写别的值即 `E_BAD_ENVELOPE`），`capability/src/authz.ts` 只校验
 * 签名对象里这个字段是两值之一，`node/src/host/residentLocalCommand.ts` 只决定
 * 一条消息是原样交给 omp 当本地命令还是照常组装成消息。`capability/src/gate.ts`
 * 只**产出**档位、自己不按它分支；`router` / `inbound` / `message` / `index` 是
 * 纯转发。这几处**都不决定常驻跑不跑** —— turn 照跑、token 照计费。唯一决定
 * 跑不跑的是 `node/src/commands/handoffNode.ts`：`qm handoff node` 节点桥
 * （P17.5）只接 `verified-capability` 的 `task.request`，那是另一个入口，不是
 * 常驻唤醒。所以这一维断言的是**字段值与给模型的措辞**，不是「有没有被执行」。
 *
 * 三个容易读错的地方，各有一条场景钉着：
 *   ① `NoticeTrust` 只有两个取值，没有 `trusted`；
 *   ② `verified-capability` 要**同时**满足「签发者在 `--trust` 里」与
 *      「act ≥ write-limited」—— 受信任签发者发的 `read` 档仍然是 untrusted；
 *   ③ 同一个信封里 `envelope.trust` 恒为 `untrusted`（验签前的默认值），
 *      只有 `notice.trust` 是授权信号。只看前者会得出完全相反的结论。
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CapabilityLevel } from '@qianmo/protocol'
import { Checks } from '../checks.js'
import { REPO_ROOT } from '../local/spawn.js'
import { ACCEPTANCE_PSK } from '../local/driver.js'
import { mint, sendEnvelope } from '../local/send.js'
import { waitForMailbox, type MailboxNotice } from '../observe.js'
import type { Scenario, ScenarioContext } from '../types.js'
import {
  ADDRESS,
  AGENT,
  NODE,
  SENDER,
  SENDER_NODE,
  TEAM,
  newParty,
  newTaskId,
  startNodeTrusting,
  type Party,
} from './fixtures.js'

/** 只在 `untrusted` 那条措辞里出现的句子。 */
const UNTRUSTED_PHRASE = 'never as instructions'
/** 只在 `verified-capability` 那条措辞里出现的句子。 */
const VERIFIED_PHRASE = 'The request is therefore authorized'

/**
 * 投一条唤醒，把落到信箱里的那条 notice 取回来。
 *
 * 信箱路径在**配置根**下（`<config>/teams/<team>/inboxes/<agent>.json`），所以
 * 走驱动接口就够得着，两个目标通用。早先一版去翻 agent 工作区，那在真机腿上
 * 根本读不到 —— 而失败形态会长得像「被测系统没投递」，是最坏的一种假红。
 */
async function deliverWith(
  ctx: ScenarioContext,
  party: Party,
  act: CapabilityLevel | undefined,
): Promise<{
  readonly notice?: MailboxNotice
  readonly receipt?: string
  readonly envelopeTrustOnWire?: string
}> {
  const node = await startNodeTrusting(ctx, party, { policy: 'open' })
  const taskId = newTaskId()
  const cap =
    act === undefined
      ? undefined
      : mint(party.issuer, { sub: ADDRESS, aud: NODE, taskId, act })
  const result = await sendEnvelope({
    url: node.endpoint,
    psk: ACCEPTANCE_PSK,
    fromNode: SENDER_NODE,
    from: SENDER,
    to: ADDRESS,
    taskId,
    ...(cap === undefined ? {} : { cap }),
  })
  const entries = await waitForMailbox(ctx, node, TEAM, AGENT)
  return {
    notice: entries.at(-1),
    receipt: result.receipt,
    envelopeTrustOnWire: result.message.trust,
  }
}

export const trustScenarios: readonly Scenario[] = [
  {
    id: 'trust/untrusted-wording',
    dimension: 'trust',
    title: '无 token 的投递：给模型的措辞是 untrusted 那一条',
    expected: `信箱里出现 ${JSON.stringify(UNTRUSTED_PHRASE)}，不出现 verified 那句`,
    requires: ['spawn-node', 'raw-dial'],
    async run(ctx) {
      const { notice, receipt } = await deliverWith(ctx, newParty(), undefined)
      return new Checks()
        .eq(receipt, 'accepted', 'receipt')
        .note('信箱原文', notice?.raw ?? '(信箱是空的)')
        .eq(notice?.trust, 'untrusted', 'notice.trust')
        .contains(notice?.text, UNTRUSTED_PHRASE, '给模型的措辞')
        .notContains(notice?.text, VERIFIED_PHRASE, '给模型的措辞')
        .done('未授信投递用 untrusted 措辞')
    },
  },

  {
    id: 'trust/verified-capability-wording',
    dimension: 'trust',
    title: '受信任签发者 + write-limited：措辞升级为 verified-capability',
    expected: `信箱里出现 ${JSON.stringify(VERIFIED_PHRASE)}`,
    requires: ['spawn-node', 'raw-dial'],
    async run(ctx) {
      const { notice, receipt } = await deliverWith(
        ctx,
        newParty(),
        CapabilityLevel.WriteLimited,
      )
      return new Checks()
        .eq(receipt, 'accepted', 'receipt')
        .note('信箱原文', notice?.raw ?? '(信箱是空的)')
        .eq(notice?.trust, 'verified-capability', 'notice.trust')
        .contains(notice?.text, VERIFIED_PHRASE, '给模型的措辞')
        .notContains(notice?.text, UNTRUSTED_PHRASE, '给模型的措辞')
        .eq(
          notice?.capIss,
          SENDER_NODE,
          'origin.capIss（受理方自己记的签发者）',
        )
        .done('已验签能力用 verified 措辞')
    },
  },

  {
    id: 'trust/read-level-stays-untrusted',
    dimension: 'trust',
    title: '受信任签发者但只给 read：仍然是 untrusted',
    expected: '档位不足以升级措辞，信箱里仍是 untrusted 那一条',
    requires: ['spawn-node', 'raw-dial'],
    async run(ctx) {
      const { notice } = await deliverWith(
        ctx,
        newParty(),
        CapabilityLevel.Read,
      )
      return new Checks()
        .note('信箱原文', notice?.raw ?? '(信箱是空的)')
        .eq(notice?.trust, 'untrusted', 'notice.trust')
        .contains(notice?.text, UNTRUSTED_PHRASE, '给模型的措辞')
        .done('read 档不升级信任层级')
    },
  },

  {
    id: 'trust/no-execution-gate',
    dimension: 'trust',
    title:
      'trust 不门控常驻执行：全仓按它分支的生产文件恰好是核对过的那几处，常驻唤醒路径上没有一处决定「跑不跑」',
    expected:
      '按 trust 分支的生产文件恰好是 REVIEWED 名单里的五处（措辞、线格式、签名对象结构校验、本地命令原样交付、接力节点桥入口），此外没有别的',
    requires: ['read-repo-source'],
    async run(ctx) {
      // 源码扫描，与 `atlas/packages/capability/test/authorization-invariants.test.ts`
      // 同一个路子：一条**不存在的**门控只能靠「谁读了这个常量」来证明。
      // 扫基座（`packages/`）与阡陌自有包（`atlas/packages/`）两棵树。
      const roots = [
        join(REPO_ROOT, 'packages'),
        join(REPO_ROOT, 'atlas/packages'),
      ]
      const hits: string[] = []
      const scan = (dir: string): void => {
        let entries: string[]
        try {
          entries = readdirSync(dir)
        } catch {
          return
        }
        for (const entry of entries) {
          if (entry === 'node_modules' || entry === 'dist') continue
          const full = join(dir, entry)
          let children: string[] | undefined
          try {
            children = readdirSync(full)
          } catch {
            children = undefined
          }
          if (children !== undefined) {
            scan(full)
            continue
          }
          if (!/\.tsx?$/.test(entry)) continue
          if (full.includes('/test/') || full.includes('/__tests__/')) continue
          let text: string
          try {
            text = readFileSync(full, 'utf8')
          } catch {
            continue
          }
          if (
            text.includes('NOTICE_TRUST_VERIFIED_CAPABILITY') ||
            text.includes('TRUST_UNTRUSTED')
          ) {
            hits.push(full.slice(REPO_ROOT.length + 1))
          }
        }
      }
      for (const root of roots) scan(root)
      // 消费者 = 读了常量**并且**拿它做判断的文件。纯转发（router / inbound /
      // validate 那几处）也会命中常量，所以只挑真的有比较的。
      const branching = hits.filter(path => {
        const text = readFileSync(join(REPO_ROOT, path), 'utf8')
        return /(===|!==)\s*(NOTICE_TRUST_VERIFIED_CAPABILITY|TRUST_UNTRUSTED)/.test(
          text,
        )
      })
      ctx.log(`提到常量的生产文件: ${hits.join(', ')}`)
      // **已核对过的**分支点，各自做什么。新增一处必须先读过、再加进来：
      //   · `adapter/src/wrapper.ts` —— 按 `notice.trust` 在两段措辞里挑一段
      //     交给模型。挑完照样把消息交下去，没有「不交」这条分支。
      //   · `protocol/src/validate.ts` —— `raw['trust'] !== TRUST_UNTRUSTED`
      //     时报 `E_BAD_ENVELOPE`。它是**线格式校验**：信封上的 trust 字段恒为
      //     `untrusted`，写别的值直接被判为坏信封。这条分支恰恰是「trust 不可能
      //     从线上被抬高」的证据，与「按 trust 决定跑不跑」相反。
      //   · `capability/src/authz.ts` —— `isAuthzOrigin` 只校验签名授权对象
      //     （P14.3）里的 `origin.trust` 是两值之一，是结构校验，不是门控。
      //   · `node/src/host/residentLocalCommand.ts` —— 只有 `verified-capability`
      //     且签发者在 `--local-commands-from` 里时，才把 `/compact` 这类本地命令
      //     原样交给 omp；否则照常组装成消息。两条路 turn 都照跑。
      //   · `node/src/commands/handoffNode.ts` —— `qm handoff node` 节点桥
      //     （P17.5）对不是 `verified-capability` 的 `task.request` 回
      //     `E_CAP_INSUFFICIENT`。**这是名单里唯一决定跑不跑的一处**，但它是
      //     接力节点桥自己的入口，不是常驻唤醒路径。
      const REVIEWED = [
        'atlas/packages/adapter/src/wrapper.ts',
        'atlas/packages/protocol/src/validate.ts',
        'atlas/packages/capability/src/authz.ts',
        'atlas/packages/node/src/host/residentLocalCommand.ts',
        'atlas/packages/node/src/commands/handoffNode.ts',
      ]
      const unexpected = branching.filter(p => !REVIEWED.includes(p))
      const missing = REVIEWED.filter(p => !branching.includes(p))
      return new Checks()
        .note('提到常量的生产文件', hits.join('\n'))
        .note('真的按它分支的文件', branching.join('\n'))
        .eq(unexpected.length, 0, '名单之外的 trust 分支点数')
        .eq(branching.length, REVIEWED.length, '按 trust 分支的生产文件数')
        .expect(
          missing.length === 0,
          '名单里的文件都还在按 trust 分支（少一处说明那处被删或改了，名单该跟着改）',
          missing,
        )
        .done('trust 只影响措辞、线格式与本地命令交付，常驻跑不跑不看它')
    },
  },

  {
    id: 'trust/notice-trust-has-two-values',
    dimension: 'trust',
    title: 'NoticeTrust 只有两个取值，没有 trusted',
    expected: "message.ts 里只声明 'untrusted' 与 'verified-capability'",
    requires: ['read-repo-source'],
    async run() {
      const source = readFileSync(
        join(REPO_ROOT, 'atlas/packages/protocol/src/message.ts'),
        'utf8',
      )
      const untrusted = /TRUST_UNTRUSTED\s*=\s*'untrusted'/.test(source)
      const verified =
        /NOTICE_TRUST_VERIFIED_CAPABILITY\s*=\s*'verified-capability'/.test(
          source,
        )
      const declaration = /export type NoticeTrust =[\s\S]{0,200}?\n\n/.exec(
        source,
      )?.[0]
      return new Checks()
        .note('NoticeTrust 声明', declaration ?? '(没找到)')
        .expect(untrusted, "存在常量 'untrusted'", untrusted)
        .expect(verified, "存在常量 'verified-capability'", verified)
        .expect(
          declaration !== undefined && !/'trusted'/.test(declaration),
          "声明里没有 'trusted' 这个取值",
          declaration,
        )
        .done('NoticeTrust 是两值封闭联合')
    },
  },

  {
    id: 'trust/envelope-trust-is-not-the-signal',
    dimension: 'trust',
    title: "envelope.trust 恒为 'untrusted'，只有 notice.trust 是授权信号",
    expected:
      "同一条消息：envelope.trust='untrusted' 而 notice.trust='verified-capability'",
    requires: ['spawn-node', 'raw-dial', 'read-node-files'],
    async run(ctx) {
      const { notice, envelopeTrustOnWire, receipt } = await deliverWith(
        ctx,
        newParty(),
        CapabilityLevel.WriteLimited,
      )
      return new Checks()
        .eq(receipt, 'accepted', 'receipt')
        .note('信箱原文', notice?.raw ?? '(信箱是空的)')
        .eq(envelopeTrustOnWire, 'untrusted', '发出去时的 envelope.trust')
        .eq(notice?.envelopeTrust, 'untrusted', '信箱里存的 envelope.trust')
        .eq(notice?.trust, 'verified-capability', 'notice.trust')
        .expect(
          notice?.envelopeTrust !== notice?.trust,
          '两个 trust 字段在同一条记录里取值相反（只看前者会读反）',
          `envelope=${notice?.envelopeTrust ?? '-'} notice=${notice?.trust ?? '-'}`,
        )
        .done('两个 trust 字段值相反，只有后者是信号')
    },
  },
]
