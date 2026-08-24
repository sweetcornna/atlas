// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: MIT

/**
 * 握手维度。
 *
 * **读断言之前先知道这条事实：wire 上分辨不出握手失败的种类。**
 * 十二种拒绝（错 PSK、坏签名、未知签名者、缺 credential、证书过期……）
 * 在线上全部是 `4003 / 'unauthorized'`，服务端在握手完成前**从不发 error 帧**。
 * 所以每条场景的断言分两层：
 *
 *   ① 线上那层 —— 关闭码（这是发起方唯一能看到的）；
 *   ② 节点那层 —— 审计链里 `auth_rejected` 记录的 `code`，**但只有五种理由
 *      进链**（见 `observe.ts` 的 `AUDITED_HANDSHAKE_REJECTIONS`）。
 *
 * 把两层写死在断言里，是为了让「哪些失败可归因」这件事本身也被钉住：
 * 有人往 `HANDSHAKE_AUDITED` 里加一种或去掉一种，`rejection-attributable`
 * 会立刻变红。
 */

import { generateNodeKeyPair } from '@qianmo/capability'
import { newChannelId } from '@qianmo/transport'
import { Checks } from '../checks.js'
import { ACCEPTANCE_PSK, WRONG_PSK } from '../local/driver.js'
import { bogusEnvelopeFrame, malformedFrame, rawDial } from '../local/dial.js'
import {
  AUDITED_HANDSHAKE_REJECTIONS,
  delay,
  handshakeRejections,
  waitForRejection,
} from '../observe.js'
import type { Scenario } from '../types.js'
import { newParty, startNodeTrusting } from './fixtures.js'

const CLOSE_UNAUTHORIZED = 4003
const CLOSE_PROTOCOL_ERROR = 1002
const CLOSE_CHANNEL_CONFLICT = 4004
const CLOSE_NORMAL = 1000

export const handshakeScenarios: readonly Scenario[] = [
  {
    id: 'handshake/psk-ok',
    dimension: 'handshake',
    title: 'psk 档：正确的 PSK 握手成功',
    expected: '拿到 ready 帧、连接不被拒绝关闭',
    requires: ['spawn-node', 'raw-dial'],
    async run(ctx) {
      const party = newParty()
      const node = await startNodeTrusting(ctx, party)
      const probe = await rawDial({
        url: node.endpoint,
        node: party.peerNode,
        auth: { kind: 'psk', psk: ACCEPTANCE_PSK },
        settleMs: 300,
      })
      return new Checks()
        .expect(probe.authed, '握手完成（收到 ready 帧）', probe.authed)
        .expect(
          probe.closeCode === CLOSE_NORMAL || probe.closeCode === undefined,
          '不是被拒绝关闭的',
          probe.closeCode,
        )
        .note('frames', probe.frames.join('\n'))
        .done('psk 档握手成功')
    },
  },

  {
    id: 'handshake/psk-wrong',
    dimension: 'handshake',
    title: 'psk 档：错的 PSK 被 4003 拒绝',
    expected: `关闭码 ${CLOSE_UNAUTHORIZED}、reason 'unauthorized'、且没有 ready 帧`,
    requires: ['spawn-node', 'raw-dial'],
    async run(ctx) {
      const party = newParty()
      const node = await startNodeTrusting(ctx, party)
      const probe = await rawDial({
        url: node.endpoint,
        node: party.peerNode,
        auth: { kind: 'psk', psk: WRONG_PSK },
        settleMs: 300,
      })
      await delay(500)
      const audited = await handshakeRejections(ctx.driver, node)
      return (
        new Checks()
          .expect(!probe.authed, '没有握手成功', probe.authed)
          .eq(probe.closeCode, CLOSE_UNAUTHORIZED, '关闭码')
          .eq(probe.closeReason, 'unauthorized', '关闭原因')
          // 这条不是断言而是留痕：bad_mac **不在** HANDSHAKE_AUDITED 里，
          // 所以一次错 PSK 在节点上不留任何痕迹。归因边界由
          // `handshake/rejection-attributable` 那条负责钉。
          .note('审计链里的握手拒绝（bad_mac 预期不在其中）', audited)
          .done('错 PSK 被 4003 拒绝')
      )
    },
  },

  {
    id: 'handshake/signature-ok',
    dimension: 'handshake',
    title: 'signature 档：受信任的签名握手成功',
    expected: '拿到 ready 帧',
    requires: ['spawn-node', 'raw-dial'],
    async run(ctx) {
      const party = newParty()
      const node = await startNodeTrusting(ctx, party, { signHandshake: true })
      const probe = await rawDial({
        url: node.endpoint,
        node: party.peerNode,
        auth: { kind: 'signature', psk: ACCEPTANCE_PSK, keys: party.peerKeys },
        settleMs: 300,
      })
      return new Checks()
        .expect(probe.authed, '握手完成', probe.authed)
        .note('frames', probe.frames.join('\n'))
        .done('signature 档握手成功')
    },
  },

  {
    id: 'handshake/signature-bad',
    dimension: 'handshake',
    title: 'signature 档：签名不对被拒，且审计链记下 bad_signature',
    expected: `4003；审计链出现 code='bad_signature'`,
    requires: ['spawn-node', 'raw-dial', 'read-node-files'],
    async run(ctx) {
      const party = newParty()
      const node = await startNodeTrusting(ctx, party, { signHandshake: true })
      // 名字是受信任的那个，钥匙不是 —— 这才测得到「签名不验证通过」，
      // 换个名字测到的是 unknown_signer，两条是不同的分支。
      const impostor = generateNodeKeyPair()
      const probe = await rawDial({
        url: node.endpoint,
        node: party.peerNode,
        auth: { kind: 'signature', psk: ACCEPTANCE_PSK, keys: impostor },
        settleMs: 300,
      })
      const audited = await waitForRejection(ctx, node, 'bad_signature')
      return new Checks()
        .expect(!probe.authed, '没有握手成功', probe.authed)
        .eq(probe.closeCode, CLOSE_UNAUTHORIZED, '关闭码')
        .expect(
          audited,
          '审计链里出现 bad_signature',
          await handshakeRejections(ctx.driver, node),
        )
        .done('坏签名被拒且可归因')
    },
  },

  {
    id: 'handshake/unknown-signer',
    dimension: 'handshake',
    title: 'signature 档：签名者不在信任集被拒',
    expected: `4003；审计链出现 code='unknown_signer'`,
    requires: ['spawn-node', 'raw-dial', 'read-node-files'],
    async run(ctx) {
      const party = newParty()
      const node = await startNodeTrusting(ctx, party, { signHandshake: true })
      const probe = await rawDial({
        url: node.endpoint,
        node: 'never-trusted',
        auth: {
          kind: 'signature',
          psk: ACCEPTANCE_PSK,
          keys: generateNodeKeyPair(),
        },
        settleMs: 300,
      })
      const audited = await waitForRejection(ctx, node, 'unknown_signer')
      return new Checks()
        .expect(!probe.authed, '没有握手成功', probe.authed)
        .eq(probe.closeCode, CLOSE_UNAUTHORIZED, '关闭码')
        .expect(
          audited,
          '审计链里出现 unknown_signer',
          await handshakeRejections(ctx.driver, node),
        )
        .done('未知签名者被拒且可归因')
    },
  },

  {
    id: 'handshake/credential-half',
    dimension: 'handshake',
    title: 'credential 档：只给 credential 不给 proof 被拒',
    expected: `4003；审计链出现 code='credential_required'`,
    requires: ['spawn-node', 'raw-dial', 'read-node-files'],
    async run(ctx) {
      const party = newParty()
      const node = await startNodeTrusting(ctx, party, { signHandshake: true })
      const probe = await rawDial({
        url: node.endpoint,
        node: party.peerNode,
        auth: {
          kind: 'half_credential',
          psk: ACCEPTANCE_PSK,
          keys: party.peerKeys,
          selector: 'sha256:acceptance-selector',
        },
        settleMs: 300,
      })
      const audited = await waitForRejection(ctx, node, 'credential_required')
      return new Checks()
        .expect(!probe.authed, '没有握手成功', probe.authed)
        .eq(probe.closeCode, CLOSE_UNAUTHORIZED, '关闭码')
        .expect(
          audited,
          '审计链里出现 credential_required',
          await handshakeRejections(ctx.driver, node),
        )
        .done('半截 credential 被拒')
    },
  },

  {
    id: 'handshake/credential-without-signature',
    dimension: 'handshake',
    title: 'credential 档：带 credential 却不带 sig 被拒',
    expected: '4003（对端有 signing 时按 bad_signature 处理）',
    requires: ['spawn-node', 'raw-dial'],
    async run(ctx) {
      const party = newParty()
      const node = await startNodeTrusting(ctx, party, { signHandshake: true })
      const probe = await rawDial({
        url: node.endpoint,
        node: party.peerNode,
        auth: {
          kind: 'credential_without_sig',
          psk: ACCEPTANCE_PSK,
          credential: {
            selector: 'sha256:acceptance',
            source: 'certificate',
            id: 'F1',
          },
        },
        settleMs: 300,
      })
      return new Checks()
        .expect(!probe.authed, '没有握手成功', probe.authed)
        .eq(probe.closeCode, CLOSE_UNAUTHORIZED, '关闭码')
        .done('缺 sig 的 credential 被拒')
    },
  },

  {
    id: 'handshake/envelope-before-auth',
    dimension: 'handshake',
    title: '未握手就发 Envelope → CLOSE_UNAUTHORIZED 4003',
    expected: `关闭码 ${CLOSE_UNAUTHORIZED}、reason 'unauthorized'`,
    requires: ['spawn-node', 'raw-dial'],
    async run(ctx) {
      const party = newParty()
      const node = await startNodeTrusting(ctx, party)
      const probe = await rawDial({
        url: node.endpoint,
        node: party.peerNode,
        auth: { kind: 'none' },
        sendBeforeAuth: [bogusEnvelopeFrame()],
        settleMs: 300,
      })
      return new Checks()
        .expect(!probe.authed, '没有握手成功', probe.authed)
        .eq(probe.closeCode, CLOSE_UNAUTHORIZED, '关闭码')
        .eq(probe.closeReason, 'unauthorized', '关闭原因')
        .note('收到的帧', probe.frames.join('\n'))
        .done('未授权信封被 4003 挡住')
    },
  },

  {
    id: 'handshake/malformed-before-auth',
    dimension: 'handshake',
    title: '未握手就发解析不了的帧 → CLOSE_PROTOCOL_ERROR 1002',
    expected: `关闭码 ${CLOSE_PROTOCOL_ERROR}（不是 4003 —— 解析失败与「帧不对」是两条分支）`,
    requires: ['spawn-node', 'raw-dial'],
    async run(ctx) {
      const party = newParty()
      const node = await startNodeTrusting(ctx, party)
      const probe = await rawDial({
        url: node.endpoint,
        node: party.peerNode,
        auth: { kind: 'none' },
        sendBeforeAuth: [malformedFrame()],
        settleMs: 300,
      })
      return new Checks()
        .eq(probe.closeCode, CLOSE_PROTOCOL_ERROR, '关闭码')
        .eq(
          probe.closeReason,
          'unauthorized',
          '关闭原因（握手前仍是 unauthorized）',
        )
        .done('畸形帧按 1002 处理')
    },
  },

  {
    id: 'handshake/channel-conflict-peer-node',
    dimension: 'handshake',
    title: '冻结四元组 · peerNode 腿变化 → 4004',
    expected: `关闭码 ${CLOSE_CHANNEL_CONFLICT}、reason 'logical channel identity conflict'`,
    requires: ['spawn-node', 'raw-dial'],
    async run(ctx) {
      const party = newParty()
      const node = await startNodeTrusting(ctx, party)
      const channelId = newChannelId()
      // 第一条连接必须**还活着**：清掉出站队列后的通道会被立刻释放，
      // 串行地「拨完再拨」根本触发不了冲突（这个坑真踩过）。
      const holder = rawDial({
        url: node.endpoint,
        node: party.peerNode,
        auth: { kind: 'psk', psk: ACCEPTANCE_PSK },
        channelId,
        settleMs: 6_000,
      })
      await delay(1_000)
      const intruder = await rawDial({
        url: node.endpoint,
        node: 'another-node',
        auth: { kind: 'psk', psk: ACCEPTANCE_PSK },
        channelId,
        settleMs: 400,
      })
      const first = await holder
      return new Checks()
        .expect(first.authed, '第一条连接握手成功并持有通道', first.authed)
        .expect(!intruder.authed, '第二条没有握手成功', intruder.authed)
        .eq(intruder.closeCode, CLOSE_CHANNEL_CONFLICT, '关闭码')
        .eq(
          intruder.closeReason,
          'logical channel identity conflict',
          '关闭原因',
        )
        .done('换节点名重用通道被 4004 挡住')
    },
  },

  {
    id: 'handshake/channel-conflict-authentication',
    dimension: 'handshake',
    title: '冻结四元组 · authentication 腿变化 → 4004',
    expected: `同一节点名换档位重用通道 → ${CLOSE_CHANNEL_CONFLICT}`,
    requires: ['spawn-node', 'raw-dial'],
    async run(ctx) {
      const party = newParty()
      const node = await startNodeTrusting(ctx, party, { signHandshake: true })
      const channelId = newChannelId()
      const holder = rawDial({
        url: node.endpoint,
        node: party.peerNode,
        auth: { kind: 'psk', psk: ACCEPTANCE_PSK },
        channelId,
        settleMs: 6_000,
      })
      await delay(1_000)
      const upgraded = await rawDial({
        url: node.endpoint,
        node: party.peerNode,
        auth: { kind: 'signature', psk: ACCEPTANCE_PSK, keys: party.peerKeys },
        channelId,
        settleMs: 400,
      })
      const first = await holder
      return new Checks()
        .expect(first.authed, '第一条（psk 档）握手成功', first.authed)
        .expect(
          !upgraded.authed,
          '第二条（signature 档）没有握手成功',
          upgraded.authed,
        )
        .eq(upgraded.closeCode, CLOSE_CHANNEL_CONFLICT, '关闭码')
        .eq(
          upgraded.closeReason,
          'logical channel identity conflict',
          '关闭原因',
        )
        .done('换认证档位重用通道被 4004 挡住')
    },
  },

  {
    id: 'handshake/rejection-attributable',
    dimension: 'handshake',
    title: '可归因的握手拒绝恰好是那五种（可观测边界）',
    expected:
      '审计链只收 channel_identity_mismatch / bad_credential_proof / unknown_signer / bad_signature / credential_required；bad_mac 等不进链',
    requires: ['spawn-node', 'raw-dial', 'read-node-files'],
    async run(ctx) {
      const party = newParty()
      const node = await startNodeTrusting(ctx, party, { signHandshake: true })
      // 一次制造两类：进链的（unknown_signer）与不进链的（bad_mac）。
      await rawDial({
        url: node.endpoint,
        node: 'never-trusted',
        auth: {
          kind: 'signature',
          psk: ACCEPTANCE_PSK,
          keys: generateNodeKeyPair(),
        },
        settleMs: 200,
      })
      await rawDial({
        url: node.endpoint,
        node: party.peerNode,
        auth: { kind: 'psk', psk: WRONG_PSK },
        settleMs: 200,
      })
      await delay(1_000)
      const audited = await handshakeRejections(ctx.driver, node)
      const checks = new Checks()
        .note('审计链里的握手拒绝', audited)
        .expect(
          audited.includes('unknown_signer'),
          'unknown_signer 进链',
          audited,
        )
        .expect(
          !audited.includes('bad_mac'),
          'bad_mac 不进链（错 PSK 在节点上不留痕迹，这是当前的可观测边界）',
          audited,
        )
      for (const rejection of audited) {
        checks.expect(
          AUDITED_HANDSHAKE_REJECTIONS.includes(rejection),
          `${rejection} 在已记录的可归因集合内`,
          AUDITED_HANDSHAKE_REJECTIONS,
        )
      }
      return checks.done('可归因边界与代码一致')
    },
  },
]
