// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: MIT

/**
 * 证书维度 —— `--trust-ca` 那条路的整条链。
 *
 * 这一维和 `handshake` 维度的差别值得先说清楚：那边测的是 `--trust`
 * （一张手工分发的 `节点名 → 公钥` 表），**证书完全不参与**；这边测的是
 * 「离线 CA 签发 + 注册中心分发 + 吊销清单撤销」这条另一套机制。两条路在
 * `CertificateDirectory` 里**同时存在**，`--trust` 那条**永远压过** CA 那条
 * —— 这不是巧合，是 key-distribution.md §6.4 写下的取舍，
 * `certificate/explicit-trust-outranks-revocation` 把它连同代价一起钉住。
 *
 * 四条读断言前必须知道的事实：
 *
 * ① **一条完整的正向链有五步，缺任何一步都会得到同一个 `unknown_signer`。**
 *    `qm ca init` → `qm cert request` → `qm ca issue` → 把证书**带 certificate
 *    字段**登记进注册中心 → 把签好的吊销清单 `PUT` 上去。线上永远是
 *    `4003 / 'unauthorized'`，具体是哪一步漏了只有节点自己的审计链知道，
 *    而审计链对这五种情况记的**也是同一个 `unknown_signer`**。所以这一维的
 *    每条拒绝场景都必须配一条对照（同一次运行里另一张证书仍然通），否则
 *    「配错了」和「被拒了」在报告里长得一模一样。
 *
 * ② **没有吊销清单 = 整条 CA 路关闭**，不是「什么都没吊销」。fail closed。
 *
 * ③ **吊销的键是证书指纹，不是节点名。** 同一个节点的另一张证书不受影响 ——
 *    这正是「换证」这件事在协议里的样子。
 *
 * ④ **CA 只回答「这个主体是谁」，不回答「它能做什么」。** 所以 `--trust-ca`
 *    单独存在时，一个 CA 认得的签发者签出来的能力 token **验得过签、消息也
 *    会被投递**，但 `notice.trust` 停在 `untrusted` —— 授权名单只有 `--trust`
 *    与本节点自己。`certificate/verified-signature-is-not-authorization` 是
 *    这一条的落点，也是「验得了签 ≠ 是授权方」这个说法唯一成立的形态。
 */

import { CapabilityLevel } from '@qianmo/protocol'
import { Checks } from '../checks.js'
import { rawDial } from '../local/dial.js'
import { ACCEPTANCE_PSK } from '../local/driver.js'
import { startRegistry } from '../local/console.js'
import {
  initCa,
  issueCertificate,
  issueExpiredCertificate,
  opensslSupportsExplicitValidity,
  opensslVersion,
  publishAgentCertificate,
  publishRevocationList,
  signRevocationList,
  type CaHandle,
  type IssuedCertificate,
} from '../local/ca.js'
import { mint, sendEnvelope, type Issuer } from '../local/send.js'
import { delay, handshakeRejections, waitForMailbox } from '../observe.js'
import type { NodeHandle, Scenario, ScenarioContext } from '../types.js'
import {
  ADDRESS,
  AGENT,
  NODE,
  SENDER,
  SENDER_NODE,
  TEAM,
  newTaskId,
  nodeSpec,
} from './fixtures.js'
import { join } from 'node:path'

const CLOSE_UNAUTHORIZED = 4003
const CLOSE_NORMAL = 1000

/** 对端节点的配置根名 —— 同一个根 = 同一把 Ed25519 身份钥匙。 */
const PEER_CONFIG = 'peer-config'

export interface CertificateFixture {
  readonly ca: CaHandle
  readonly registryUrl: string
  readonly peerConfig: string
}

export async function certificateFixture(
  ctx: ScenarioContext,
): Promise<CertificateFixture> {
  const ca = await initCa(ctx)
  const registry = await startRegistry(ctx)
  return {
    ca,
    registryUrl: registry.url,
    peerConfig: join(ctx.workdir, PEER_CONFIG),
  }
}

/**
 * 起一个只认 CA、**一条 `--trust` 都不给**的严格握手节点。
 *
 * 不走 `startNodeTrusting`：那个 helper 一定会发 `--trust`，而显式信任会
 * 短路掉整条证书路径（有效期不看、吊销不查），于是每一条本该红的场景都会
 * 变绿。这条区别是这一维最容易搞砸的地方。
 */
export async function startCaOnlyNode(
  ctx: ScenarioContext,
  fixture: CertificateFixture,
  options: {
    readonly trust?: readonly string[]
    readonly signHandshake?: boolean
  } = {},
): Promise<NodeHandle> {
  return await ctx.driver.startNode(
    ctx,
    nodeSpec(ctx, {
      policy: 'open',
      ...(options.signHandshake === false
        ? {}
        : { requireSignedHandshake: true }),
      ...(options.trust === undefined ? {} : { trust: options.trust }),
      extraArgs: [
        '--trust-ca',
        fixture.ca.certificatePath,
        '--registry-url',
        fixture.registryUrl,
      ],
    }),
  )
}

/** 用证书的指纹当 selector 拨一次 credential 档握手。 */
export async function dialWithCertificate(
  node: NodeHandle,
  certificate: IssuedCertificate,
  options: { readonly channelId?: string; readonly settleMs?: number } = {},
) {
  return await rawDial({
    url: node.endpoint,
    node: certificate.node,
    auth: {
      kind: 'credential_signature',
      psk: ACCEPTANCE_PSK,
      keys: certificate.keys,
      credential: {
        selector: certificate.fingerprint256,
        source: 'certificate',
        id: certificate.fingerprint256,
      },
    },
    ...(options.channelId === undefined
      ? {}
      : { channelId: options.channelId }),
    settleMs: options.settleMs ?? 500,
  })
}

/** openssl 拿不到就整条维度没法跑 —— 如实 skip，别假装覆盖。 */
export function opensslGate(checks: Checks): string | undefined {
  const version = opensslVersion()
  checks.note('openssl', version ?? '(跑不动)')
  return version === null
    ? '本机没有可用的 openssl；qm ca 的签发链跑不起来（这是 CA 工具的外部依赖，不是被测系统的缺陷）'
    : undefined
}

export const certificateScenarios: readonly Scenario[] = [
  {
    id: 'certificate/handshake-ok',
    dimension: 'certificate',
    title: 'CA 签发 → 注册中心分发 → credential 档握手走通',
    expected:
      '一条 --trust 都不给、只给 --trust-ca 与 --registry-url 的节点接受这张证书的握手；审计链里没有拒绝记录',
    requires: ['spawn-node', 'raw-dial', 'exec-node-cli', 'read-node-files'],
    timeoutMs: 240_000,
    async run(ctx) {
      const checks = new Checks()
      const skip = opensslGate(checks)
      if (skip !== undefined) return checks.skip(skip)

      const fixture = await certificateFixture(ctx)
      const certificate = await issueCertificate(ctx, fixture.ca, {
        node: SENDER_NODE,
        configRoot: fixture.peerConfig,
        outName: 'peer.crt',
      })
      const rl = await signRevocationList(ctx, fixture.ca)
      const rlStatus = await publishRevocationList(fixture.registryUrl, rl)
      const agentStatus = await publishAgentCertificate(fixture.registryUrl, {
        address: SENDER,
        endpoint: 'ws://127.0.0.1:1',
        publicKey: certificate.nodePublicKey,
        certificate: certificate.pem,
      })
      const node = await startCaOnlyNode(ctx, fixture)
      const probe = await dialWithCertificate(node, certificate)
      await delay(500)
      const rejections = await handshakeRejections(ctx.driver, node)

      return checks
        .note('CA 指纹', fixture.ca.fingerprint256)
        .note('节点证书指纹', certificate.fingerprint256)
        .note('节点 Ed25519 公钥', certificate.nodePublicKey)
        .eq(rlStatus, 200, '发布吊销清单的 HTTP 码')
        .eq(agentStatus, 201, '登记带证书的节点的 HTTP 码')
        .expect(probe.authed, '握手完成（收到 ready 帧）', probe.authed)
        .expect(
          probe.closeCode === CLOSE_NORMAL || probe.closeCode === undefined,
          '不是被拒绝关闭的',
          probe.closeCode,
        )
        .eq(rejections.length, 0, '审计链里的握手拒绝条数')
        .note('frames', probe.frames.join('\n'))
        .done('CA 路的正向握手走通')
    },
  },

  {
    id: 'certificate/revoked-refused',
    dimension: 'certificate',
    title: '吊销的证书握不上手，同一节点的另一张证书照样能握',
    expected:
      "被吊销那张 → 4003 + 审计链 code='unknown_signer'；同一节点未吊销的那张 → 握手成功",
    requires: ['spawn-node', 'raw-dial', 'exec-node-cli', 'read-node-files'],
    timeoutMs: 300_000,
    async run(ctx) {
      const checks = new Checks()
      const skip = opensslGate(checks)
      if (skip !== undefined) return checks.skip(skip)

      const fixture = await certificateFixture(ctx)
      // 同一个配置根签两次 = 同一把 Ed25519、两张不同指纹的证书。
      const revoked = await issueCertificate(ctx, fixture.ca, {
        node: SENDER_NODE,
        configRoot: fixture.peerConfig,
        outName: 'revoked.crt',
      })
      const replacement = await issueCertificate(ctx, fixture.ca, {
        node: SENDER_NODE,
        configRoot: fixture.peerConfig,
        outName: 'replacement.crt',
      })
      const rl = await signRevocationList(ctx, fixture.ca, {
        revoke: [{ node: SENDER_NODE, fingerprint256: revoked.fingerprint256 }],
      })
      await publishRevocationList(fixture.registryUrl, rl)
      // 两条登记地址、同一个节点段：证书事实表按指纹存，于是两张都进得去。
      await publishAgentCertificate(fixture.registryUrl, {
        address: SENDER,
        endpoint: 'ws://127.0.0.1:1',
        publicKey: revoked.nodePublicKey,
        certificate: revoked.pem,
      })
      await publishAgentCertificate(fixture.registryUrl, {
        address: `qianmo://${SENDER_NODE}/spare`,
        endpoint: 'ws://127.0.0.1:2',
        publicKey: replacement.nodePublicKey,
        certificate: replacement.pem,
      })
      const node = await startCaOnlyNode(ctx, fixture)

      const withRevoked = await dialWithCertificate(node, revoked)
      const withReplacement = await dialWithCertificate(node, replacement)
      await delay(600)
      const rejections = await handshakeRejections(ctx.driver, node)

      return checks
        .note('被吊销的指纹', revoked.fingerprint256)
        .note('换发的指纹', replacement.fingerprint256)
        .note('吊销清单原文', rl)
        .expect(
          revoked.keys.publicKey === replacement.keys.publicKey,
          '两张证书绑定同一把签名钥匙（证明差别只在指纹上）',
          `${revoked.keys.publicKey} / ${replacement.keys.publicKey}`,
        )
        .expect(
          !withRevoked.authed,
          '被吊销那张没有握手成功',
          withRevoked.authed,
        )
        .eq(withRevoked.closeCode, CLOSE_UNAUTHORIZED, '被吊销那张的关闭码')
        .eq(withRevoked.closeReason, 'unauthorized', '被吊销那张的关闭原因')
        .expect(
          rejections.includes('unknown_signer'),
          "审计链里出现 code='unknown_signer'（吊销在线上与「不认识」不可分辨）",
          rejections,
        )
        .expect(
          withReplacement.authed,
          '换发那张仍然握得上（吊销的键是指纹，不是节点名）',
          withReplacement.authed,
        )
        .done('吊销按指纹生效')
    },
  },

  {
    id: 'certificate/expired-refused',
    dimension: 'certificate',
    title: '过了有效期的证书握不上手，同一节点的有效证书照样能握',
    expected:
      "过期证书 → 4003 + 审计链 code='unknown_signer'；有效证书 → 握手成功",
    requires: ['spawn-node', 'raw-dial', 'exec-node-cli', 'read-node-files'],
    timeoutMs: 300_000,
    async run(ctx) {
      const checks = new Checks()
      const skip = opensslGate(checks)
      if (skip !== undefined) return checks.skip(skip)
      if (!opensslSupportsExplicitValidity()) {
        // `qm ca issue --days` 走 positiveInteger，最短一天，签不出已经过期的
        // 证书；本机 openssl 又没有 `-not_before/-not_after`（OpenSSL 3.5 起
        // 才有）。两条路都不通就如实跳过，不改成「一天后到期」那种测不到的形状。
        return checks.skip(
          `本机 openssl 没有 -not_before/-not_after（OpenSSL 3.5 起才有），造不出一张已经过期的证书；openssl=${opensslVersion() ?? '?'}`,
        )
      }

      const fixture = await certificateFixture(ctx)
      const valid = await issueCertificate(ctx, fixture.ca, {
        node: SENDER_NODE,
        configRoot: fixture.peerConfig,
        outName: 'valid.crt',
      })
      const expired = await issueExpiredCertificate(ctx, fixture.ca, {
        node: SENDER_NODE,
        configRoot: fixture.peerConfig,
        outName: 'expired.crt',
      })
      const rl = await signRevocationList(ctx, fixture.ca)
      await publishRevocationList(fixture.registryUrl, rl)
      await publishAgentCertificate(fixture.registryUrl, {
        address: SENDER,
        endpoint: 'ws://127.0.0.1:1',
        publicKey: valid.nodePublicKey,
        certificate: valid.pem,
      })
      await publishAgentCertificate(fixture.registryUrl, {
        address: `qianmo://${SENDER_NODE}/stale`,
        endpoint: 'ws://127.0.0.1:2',
        publicKey: expired.nodePublicKey,
        certificate: expired.pem,
      })
      const node = await startCaOnlyNode(ctx, fixture)

      const withExpired = await dialWithCertificate(node, expired)
      const withValid = await dialWithCertificate(node, valid)
      await delay(600)
      const rejections = await handshakeRejections(ctx.driver, node)

      return checks
        .note('过期证书指纹', expired.fingerprint256)
        .note('有效证书指纹', valid.fingerprint256)
        .expect(!withExpired.authed, '过期证书没有握手成功', withExpired.authed)
        .eq(withExpired.closeCode, CLOSE_UNAUTHORIZED, '过期证书的关闭码')
        .expect(
          rejections.includes('unknown_signer'),
          "审计链里出现 code='unknown_signer'（过期与「不认识」在链上也不可分辨）",
          rejections,
        )
        .expect(
          withValid.authed,
          '同一节点的有效证书仍然握得上（证明拒绝来自有效期而不是配置）',
          withValid.authed,
        )
        .done('过期证书被拒')
    },
  },

  {
    id: 'certificate/no-revocation-list-fails-closed',
    dimension: 'certificate',
    title: '没有吊销清单时整条 CA 路关闭（fail closed，不是「什么都没吊销」）',
    expected:
      '证书本身完全有效、也已登记，但注册中心上没有吊销清单 → 握手仍然 4003',
    requires: ['spawn-node', 'raw-dial', 'exec-node-cli', 'read-node-files'],
    timeoutMs: 240_000,
    async run(ctx) {
      const checks = new Checks()
      const skip = opensslGate(checks)
      if (skip !== undefined) return checks.skip(skip)

      const fixture = await certificateFixture(ctx)
      const certificate = await issueCertificate(ctx, fixture.ca, {
        node: SENDER_NODE,
        configRoot: fixture.peerConfig,
        outName: 'peer.crt',
      })
      await publishAgentCertificate(fixture.registryUrl, {
        address: SENDER,
        endpoint: 'ws://127.0.0.1:1',
        publicKey: certificate.nodePublicKey,
        certificate: certificate.pem,
      })
      // 故意**不**发布吊销清单。
      const missing = await fetch(`${fixture.registryUrl}/v0/revocation-list`)
      const node = await startCaOnlyNode(ctx, fixture)
      const probe = await dialWithCertificate(node, certificate)
      await delay(500)
      const rejections = await handshakeRejections(ctx.driver, node)

      return checks
        .eq(missing.status, 404, '注册中心上还没有吊销清单')
        .expect(!probe.authed, '握手没有成功', probe.authed)
        .eq(probe.closeCode, CLOSE_UNAUTHORIZED, '关闭码')
        .expect(
          rejections.includes('unknown_signer'),
          "审计链里出现 code='unknown_signer'",
          rejections,
        )
        .note(
          '为什么是这样',
          'handshakeCredentialOf 第一行就是 `if (selector === undefined || !this.#rlFresh()) return null`：拉不到清单时有效凭据集退回只剩 --trust 那几条。撤销机制不可用时宁可谁都不认，也不认一份可能已经作废的名单。',
        )
        .done('缺吊销清单时 fail closed')
    },
  },

  {
    id: 'certificate/explicit-trust-outranks-revocation',
    dimension: 'certificate',
    title: '仍被 --trust 钉着的对端，吊销对它无效（§6.4 写明的边界）',
    expected:
      '同一张已吊销的证书：只给 --trust-ca 时被拒；同时把该节点写进 --trust 时被放行',
    requires: ['spawn-node', 'raw-dial', 'exec-node-cli', 'read-node-files'],
    timeoutMs: 300_000,
    async run(ctx) {
      const checks = new Checks()
      const skip = opensslGate(checks)
      if (skip !== undefined) return checks.skip(skip)

      const fixture = await certificateFixture(ctx)
      const certificate = await issueCertificate(ctx, fixture.ca, {
        node: SENDER_NODE,
        configRoot: fixture.peerConfig,
        outName: 'peer.crt',
      })
      const rl = await signRevocationList(ctx, fixture.ca, {
        revoke: [
          { node: SENDER_NODE, fingerprint256: certificate.fingerprint256 },
        ],
      })
      await publishRevocationList(fixture.registryUrl, rl)
      await publishAgentCertificate(fixture.registryUrl, {
        address: SENDER,
        endpoint: 'ws://127.0.0.1:1',
        publicKey: certificate.nodePublicKey,
        certificate: certificate.pem,
      })

      const caOnly = await startCaOnlyNode(ctx, fixture)
      const refused = await dialWithCertificate(caOnly, certificate)
      await ctx.driver.stopNode(caOnly)

      const pinned = await startCaOnlyNode(ctx, fixture, {
        trust: [`${SENDER_NODE}=${certificate.nodePublicKey}`],
      })
      const admitted = await dialWithCertificate(pinned, certificate)

      return checks
        .note('被吊销的指纹', certificate.fingerprint256)
        .expect(!refused.authed, '只给 --trust-ca 时被拒', refused.authed)
        .eq(refused.closeCode, CLOSE_UNAUTHORIZED, '只给 --trust-ca 时的关闭码')
        .expect(
          admitted.authed,
          '同时写进 --trust 时被放行（显式信任短路整条证书路径）',
          admitted.authed,
        )
        .note(
          '这条为什么是绿的',
          '显式 --trust 条目在 handshakeCredentialOf 里排在最前面并直接返回，既不看有效期也不查吊销。所以要真正把一个节点摘出去，必须**同时**删掉 --trust 条目并发布吊销清单 —— 只做后一半是无效操作（key-distribution.md §6.4）。',
        )
        .done('显式信任压过吊销，代价已被钉住')
    },
  },

  {
    id: 'certificate/verified-signature-is-not-authorization',
    dimension: 'certificate',
    title: '验得了签但不是授权方：消息照投，notice.trust 停在 untrusted',
    expected:
      "只给 --trust-ca 时，CA 认得的签发者签出的能力 token 验得过签、消息被接收，但 notice.trust='untrusted'",
    requires: ['spawn-node', 'raw-dial', 'exec-node-cli', 'read-node-files'],
    timeoutMs: 300_000,
    async run(ctx) {
      const checks = new Checks()
      const skip = opensslGate(checks)
      if (skip !== undefined) return checks.skip(skip)

      const fixture = await certificateFixture(ctx)
      const certificate = await issueCertificate(ctx, fixture.ca, {
        node: SENDER_NODE,
        configRoot: fixture.peerConfig,
        outName: 'peer.crt',
      })
      const rl = await signRevocationList(ctx, fixture.ca)
      await publishRevocationList(fixture.registryUrl, rl)
      await publishAgentCertificate(fixture.registryUrl, {
        address: SENDER,
        endpoint: 'ws://127.0.0.1:1',
        publicKey: certificate.nodePublicKey,
        certificate: certificate.pem,
      })
      // 握手走 psk 档：这条测的是**能力层**的信任判定，握手档位无关。
      // （`--require-signed-handshake` 会把 psk 拨号挡在门外，所以这里不开。）
      const node = await startCaOnlyNode(ctx, fixture, { signHandshake: false })

      const issuer: Issuer = { node: SENDER_NODE, keys: certificate.keys }
      const taskId = newTaskId()
      const cap = mint(issuer, {
        sub: ADDRESS,
        aud: NODE,
        taskId,
        act: CapabilityLevel.WriteLimited,
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
      const inbox = await waitForMailbox(ctx, node, TEAM, AGENT)
      const last = inbox.at(-1)

      return (
        checks
          .note('signer', certificate.nodePublicKey)
          .note('信箱原文', last?.raw ?? '(信箱是空的)')
          // 签名验得过 —— 否则这里会是 E_CAP_INVALID + no published public key。
          .eq(result.receipt, 'accepted', 'receipt（签名验得过，消息被接收）')
          .eq(result.errorCode, undefined, 'error code')
          .expect(inbox.length > 0, '消息真的投进了信箱', inbox.length)
          // 但它不是授权方：授权名单只有 --trust 与本节点自己，CA 不进那张表。
          .eq(last?.trust, 'untrusted', 'notice.trust')
          .contains(last?.text, 'never as instructions', '给模型的措辞')
          .notContains(
            last?.text,
            'The request is therefore authorized',
            '给模型的措辞',
          )
          .note(
            '这一条为什么重要',
            '`--trust` 那条路上「拿不到公钥」与「不是授权方」重合，于是分不开；只有 --trust-ca 能把两者拆开：CA 答得出「这是谁」，答不出「它能做什么」，所以消息会被投递而档位不升。',
          )
          .done('CA 只解决身份，不解决授权')
      )
    },
  },
]
