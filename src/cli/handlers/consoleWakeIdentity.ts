// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: MIT

/**
 * 控制台**出向面**的签名身份：它自己的一把 Ed25519 密钥，以及唯一一件它用这把
 * 密钥签的事——一条唤醒的 capability token。
 *
 * ## 为什么控制台要有**自己的**身份，而不是复用某个节点的
 *
 * `verifyCapability` 只有一个字段回答「这条授权是谁给的」：`iss`。它同时是
 * `MessageOrigin.capIss` 里落进对方审计链的那个值。所以复用节点身份不是省事，
 * 是**把两个主体合成一个**——事后没有任何字段能把「beta-1 自己发起的任务」与
 * 「谁拿到 admin token 后让控制台代 beta-1 发起的任务」分开，而 `console.md`
 * §8.1 已经说明控制台连「是谁」都答不出来。
 *
 * 更硬的一条是撤销：`key-distribution.md` §6.5 定案「节点 Ed25519 身份密钥**不
 * 轮换**」。若控制台借用了某节点的私钥，那么控制台一旦失陷，唯一的收回手段就是
 * 换掉那个节点的身份——而那是被明文禁止的动作。控制台自己的密钥则可以随时丢弃
 * 重建：代价只有「把新的公钥再分发一次」。
 *
 * ## 它**不**违反 §10.3 那条硬规矩
 *
 * §10.3 写的是「控制台进程不得读取 CA 私钥、**任何节点的** Ed25519 私钥、任何
 * 节点的 TLS 私钥，也不得持有 RL 的签名能力」。这里持有的是**控制台自己的**私钥，
 * 三类材料一样都没碰：它签不出证书、签不出 RL、也冒充不了任何一个节点。这条区分
 * 已经回写进 `key-distribution.md` §10.3 与 `console.md` §7.2，不是本文件的一家
 * 之言。
 *
 * ## 身份名从哪来
 *
 * `--chat-from` 的 node 段，默认 `console`。控制台已经用这个地址在对面的收件箱里
 * 署名（`console.ts` 的 `identity` 字段注释：「一个聊天时自称一个名字、唤醒时自称
 * 另一个名字的控制台，是一个审计链里有两个身份的控制台」）——签名身份跟着它走，
 * 那句话就继续成立。
 *
 * 落盘路径复用节点那一套 `loadOrCreateNodeKeys()`，因此每一个字节都从
 * `src/config/paths.ts` 派生（CLAUDE.md §1.1②）：`<config>/qianmo/identity/
 * <node>.json`，0700 目录 + 0600 文件 + `wx` 创建、永不覆盖。
 */

import { issueCapability, type NodeKeyPair } from '@qianmo/capability'
import { CapabilityLevel, assertAddress } from '@qianmo/protocol'
import { loadOrCreateNodeKeys } from '../../services/qianmo/nodeIdentity.js'
import type {
  WakeCapabilityBinding,
  WakeCapabilityIssuer,
} from './residentWake.js'

/**
 * 令牌活多久。**下限由连接封顶决定，上限由「偷来还有没有用」决定。**
 *
 * 令牌是在 socket 打开**之前**铸出来的（`executeResidentWake` 要先有 taskId 才能
 * 造信封），而连接本身封顶 30 s（`residentWake.ts` 的 `CONNECT_TIMEOUT_CAP_MS`）。
 * 所以任何 ≤30 s 的有效期都会把一次慢 TCP 连接变成一条
 * `E_CAP_INVALID: capability has expired`——把网络问题报成授权问题，是最难查的
 * 那一类误报。60 s 是给那个封顶留满一倍余量的最小整数。
 *
 * 另一侧：唤醒是即时动作，令牌没有任何理由活得比它承载的那次请求更久。到了分钟级
 * 以上，它就变成一枚**可以从日志或反代里抄走、过一会儿再用**的持有型凭据。60 s
 * 也短于人注意到泄露所需的时间，所以这一档不是「够安全」，而是「窗口小到不值得
 * 去抢」——真正的单次性由 `NonceStore` 保证（同一枚 nonce 只admit 一次）。
 */
export const CONSOLE_WAKE_CAPABILITY_TTL_MS = 60_000

/**
 * `nbf` 往前挪多少，用来吸收两台机器的时钟差。
 *
 * **这不是第二段寿命**：它只挡「节点的钟比控制台慢」那个方向，症状是
 * `capability is not yet valid`——一条读起来像 bug 的拒绝。控制台与节点是两台机器，
 * 部署故事里没有任何一步保证它们跑同一套 NTP 纪律，所以这个容差必须是显式的常数
 * 而不是「应该差不多吧」。
 */
export const CONSOLE_WAKE_CAPABILITY_BACKDATE_MS = 30_000

/** 控制台的签名身份：名字、公开的那一半，以及它能签的那一件事。 */
export interface ConsoleWakeIdentity {
  /** `iss`，也是节点侧 `--trust <node>=<publicKey>` 里的 `<node>`。 */
  readonly node: string
  /** 公开材料。启动横幅照原样打出来，供运维粘进 `--trust`。 */
  readonly publicKey: string
  readonly issue: WakeCapabilityIssuer
}

/**
 * 控制台的签名身份名 = `--chat-from` 的 node 段。
 *
 * 走 `assertAddress` 而不是自己切字符串：地址规则的唯一出处在
 * `@qianmo/protocol`，抄一份就等于多一个会漂移的解析器。
 */
export function consoleWakeIdentityNode(chatFrom: string): string {
  return assertAddress(chatFrom, '--chat-from').node
}

/**
 * 把一把密钥变成一个「只会签唤醒」的签发器。
 *
 * 等级钉死在 `write-limited`：那正是 `SIGNED_TASK_POLICY` 对 `MessageType.Wake`
 * 要求的那一档，一分不多。**`user-confirmed` 在这里签不出来也不该签得出来**——
 * 规则 S-1 规定它只被签发方自己接受，控制台签的任何一枚都会被对面按 S-1 拒掉，
 * 而一个「签得出但必被拒」的分支只会让人以为自己配错了。
 */
export function createConsoleWakeIssuer(
  node: string,
  keys: NodeKeyPair,
  ttlMs: number = CONSOLE_WAKE_CAPABILITY_TTL_MS,
  backdateMs: number = CONSOLE_WAKE_CAPABILITY_BACKDATE_MS,
): WakeCapabilityIssuer {
  return (binding: WakeCapabilityBinding): string =>
    issueCapability(node, keys, {
      sub: binding.sub,
      aud: binding.aud,
      act: CapabilityLevel.WriteLimited,
      taskId: binding.taskId,
      nbf: binding.createdAt - backdateMs,
      exp: binding.createdAt + ttlMs,
    })
}

/**
 * 读出（首次运行时创建）控制台自己的身份。
 *
 * 只在真要签名时调用：一个从不签名的控制台不该在配置根里留下一把没人用的私钥。
 */
export function loadConsoleWakeIdentity(chatFrom: string): ConsoleWakeIdentity {
  const node = consoleWakeIdentityNode(chatFrom)
  const keys = loadOrCreateNodeKeys(node)
  return {
    node,
    publicKey: keys.publicKey,
    issue: createConsoleWakeIssuer(node, keys),
  }
}
