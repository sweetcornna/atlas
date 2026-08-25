// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: MIT

/**
 * 「这是链路坏了，还是被测系统答错了」—— 传输层失败的判据（issue #96）。
 *
 * 真机腿的每一步都要经一次 SSH（其中一台还要经 gcloud IAP 的 ProxyCommand），
 * 而套件此前把「SSH 没接上」和「被测系统的回答」当成同一类东西：一次链路打嗝
 * 变成一条 `error`，读报告的人只看得到「套件自己炸了」。那正是会被人当成「套件
 * 不稳」而整条加豁免的那类噪声。
 *
 * 这个模块只回答一个问题，不做判定：**这次 `ExecResult` 是不是根本没走到远端**。
 *
 * ## 为什么是 255
 *
 * `ssh(1)`：「ssh exits with the exit status of the remote command or with 255
 * if an error occurred」。远端命令自己回 255 理论上可能，但本套件发出去的远端
 * 命令全是 shell 片段（`printf` / `mkdir` / `rm` / `grep`），没有一条会回它。
 * 所以 rc=255 在这条腿上等于「ssh 自己失败了」。
 *
 * **stderr 的形态只拿来给人看，不参与判定** —— 远端命令的 stderr 里出现
 * `Connection refused`（比如一次 curl 探测）完全正常，拿它当判据会把产品的回答
 * 误判成链路问题，方向正好反了。
 */

/** `ssh` 自己失败时的退出码。 */
export const SSH_TRANSPORT_EXIT_CODE = 255

/** 一条幂等远端命令最多发几次（含第一次）。 */
export const TRANSPORT_RETRY_ATTEMPTS = 3

/** 重试间隔基数，第 n 次退避 `n × 这个数`。 */
export const TRANSPORT_RETRY_BACKOFF_MS = 750

/** 一次远端执行的结果里，判定只用得上这两栏。 */
export interface TransportProbe {
  readonly code: number
  readonly stderr: string
}

/** 这次执行是不是**没走到远端**（ssh 传输层失败）。 */
export function isTransportFailure(probe: TransportProbe): boolean {
  return probe.code === SSH_TRANSPORT_EXIT_CODE
}

/**
 * 重试之前先排掉**重试也没用**的那几种。
 *
 * 认证失败、主机名解析不了、主机密钥对不上都会回 255，但它们不是抖动 —— 一轮
 * 真机腿有几百次 SSH，对着一个配错的目标每条都多打两次，只是把「配错了」这个
 * 结论晚说 2 秒、把日志涨三倍。命中这几条就一次定音。
 */
const PERMANENT_PATTERNS: readonly RegExp[] = [
  /Permission denied/i,
  /Host key verification failed/i,
  /Could not resolve hostname/i,
  /No route to host/i,
  /Too many authentication failures/i,
  /Bad configuration option/i,
]

/** 值得再打一次的传输层失败。 */
export function isRetriableTransportFailure(probe: TransportProbe): boolean {
  if (!isTransportFailure(probe)) return false
  return !PERMANENT_PATTERNS.some(p => p.test(probe.stderr))
}

/**
 * 已知的链路形态，命中就在报告里点名 —— 纯展示，不参与任何判定。
 *
 * 第一条是那次真跑上唯一的红：`ssh workbench-iap` 的 gcloud IAP ProxyCommand
 * 抛了一段 Python traceback，栈停在开一次性目录那一步，`beta-up.sh` 一行都没
 * 跑到（issue #96 ③）。
 */
const KNOWN_SIGNATURES: readonly (readonly [RegExp, string])[] = [
  [/UNEXPECTED_EOF_WHILE_READING/, 'gcloud IAP 隧道半路 EOF'],
  [/Connection closed by/, '对端关闭了连接'],
  [/kex_exchange_identification/, 'SSH 版本协商没完成'],
  [/banner exchange/, 'SSH banner 交换没完成'],
  [/Connection timed out|Operation timed out/i, '连接超时'],
  [/Connection refused/i, '连接被拒'],
  [/Broken pipe/i, '管道断了'],
  [/Permission denied/i, '认证被拒（不是抖动，重试没用）'],
  [/Host key verification failed/i, '主机密钥对不上（不是抖动，重试没用）'],
  [/Could not resolve hostname/i, '主机名解析不了（不是抖动，重试没用）'],
]

/** 认得出来就给一句人话，认不出来回 undefined。 */
export function transportSignature(stderr: string): string | undefined {
  for (const [pattern, label] of KNOWN_SIGNATURES) {
    if (pattern.test(stderr)) return label
  }
  return undefined
}
