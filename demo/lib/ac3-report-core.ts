// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: MIT

/**
 * 阡陌 AC-3 —— 把四个场景的观测结果合成一份判据报告。
 *
 * 判据直接来自章程 §4 AC-3 与 roadmap P4.2 DoD，**四组各自独立**：
 *   ① 回环：A→B→A 在**首次回访同一处理者地址 + 同一任务标识**时即被切断，
 *      发送方收到 `error(E_LOOP)`，且目标处理器一次都没跑到；
 *   ② 审计：恰好 1 条 `loop_detected` 事件，且带完整消息链（trace-id 段与
 *      请求一致、跳链可读、判环键在事件里）；
 *   ③ 反向用例：**同一节点因不同目标地址被再次经过不算环**——这条是 D-2 改动
 *      的全部意义，没有它等于没改；
 *   ④ 两层限流各自生效且互不代劳：运行时层第 21 条被本地拒（不上线），
 *      协议层入站预算按 `LIMITS.ratePerMinute` 在**接收节点**拒，且这一层
 *      **按发送节点计**，多开几个 agent 名字不会多拿配额。
 *
 * 每条 check 单独留痕、不合并——合并之后没人知道是哪条没过。
 */

/** 场景一 + 二：回环切断与审计事件。 */
export interface Ac3LoopObservation {
  /** 第一跳（A→B）是否正常投递。 */
  readonly firstHopDelivered: boolean
  /** 回环那条是否被接收方拒收（transport receipt = rejected）。 */
  readonly bounceRejected: boolean
  /** 回环那条是否**没有**进到目标处理器。 */
  readonly bounceHandlerSkipped: boolean
  /** 发送方收到的 error 码，期望 `E_LOOP`。 */
  readonly replyCode?: string
  /** 回环时消息实际走过的跳数——用来证明切断不是 maxHops 兜底干的。 */
  readonly hopCountAtCut: number
  readonly maxHops: number
  /** `loop_detected` 事件条数，期望恰好 1。 */
  readonly loopEvents: number
  /** 事件里的 trace-id 段是否与原请求一致。 */
  readonly traceChainMatches: boolean
  /** 事件里的跳链，例如 `node-a -> node-b`。 */
  readonly hopPath?: string
  /** 事件里的判环键。 */
  readonly loopKeyHandler?: string
  readonly loopKeyTaskId?: string
}

/** 场景三：合法 spiral。 */
export interface Ac3SpiralObservation {
  /** 第二次经过节点 A（换了处理者地址）是否被正常投递。 */
  readonly delivered: boolean
  /** 投递到的处理者地址。 */
  readonly handler?: string
  /** 这一轮里 `loop_detected` 的条数，期望 0。 */
  readonly loopEvents: number
}

/** 场景四上半：运行时层令牌桶。 */
export interface Ac3RuntimeObservation {
  readonly capacity: number
  readonly windowMs: number
  /** 实际放行条数，期望等于 capacity。 */
  readonly allowed: number
  /** 第 capacity+1 条的本地拒绝码，期望 `E_RUNTIME_THROTTLED`。 */
  readonly refusedCode?: string
  /** 被拒那条是否**没有**上线（接收方一条都没多收）。 */
  readonly refusedStayedLocal: boolean
  /** 换一个目标地址是否立刻放行——证明这一层是「对单目标」。 */
  readonly otherTargetAllowed: boolean
  /** 运行时层是否**没有**产生协议层的 `rate_limited` 事件。 */
  readonly noProtocolEvent: boolean
}

/** 场景四下半：协议层入站预算。 */
export interface Ac3BudgetObservation {
  readonly perMinute: number
  /** 接收方实际收下的条数，期望等于 perMinute。 */
  readonly accepted: number
  /** 越界那条的错误码，期望 `E_RATE_LIMITED`。 */
  readonly refusedCode?: string
  /** 参与发送的 agent 名字个数——>1 才能证明「按节点计」。 */
  readonly senderAgents: number
  /** 协议层是否**没有**产生运行时层的 `runtime_throttled` 事件。 */
  readonly noRuntimeEvent: boolean
  /**
   * 601 条突发从第一条到最后一条的实际耗时（ms）。
   *
   * 纯观测，不进 check：入站预算是连续回补的桶（每 100 ms 一个令牌），突发耗时
   * 超过 100 ms 就会多回补一个——这正是这份报告在慢机器上误判过的原因
   * （`docs/dev/demo-env.md` §7.5）。量具已改成冻结接收方的原始时钟，所以这个
   * 数多大都不再影响判据；留着它是为了让机器速度在报告里可见。
   */
  readonly burstMs: number
  /** 接收方的原始时钟是否被冻住——上面那条判据成立的前提。 */
  readonly clockFrozen: boolean
}

export interface Ac3Observations {
  readonly loop: Ac3LoopObservation
  readonly spiral: Ac3SpiralObservation
  readonly runtime: Ac3RuntimeObservation
  readonly budget: Ac3BudgetObservation
}

export interface Ac3Report extends Ac3Observations {
  readonly checks: {
    readonly loopCutAtFirstRevisit: boolean
    readonly loopReportedToSender: boolean
    readonly loopNotByHopBackstop: boolean
    readonly loopAuditEvent: boolean
    readonly loopAuditCarriesChain: boolean
    readonly spiralNotCut: boolean
    readonly runtimeThrottleAtCapacity: boolean
    readonly runtimeThrottleStaysLocal: boolean
    readonly protocolBudgetAtLimit: boolean
    readonly layersDoNotOverlap: boolean
  }
  readonly pass: boolean
}

export function buildAc3Report(observations: Ac3Observations): Ac3Report {
  const { loop, spiral, runtime, budget } = observations

  const checks = {
    loopCutAtFirstRevisit:
      loop.firstHopDelivered &&
      loop.bounceRejected &&
      loop.bounceHandlerSkipped,
    loopReportedToSender: loop.replyCode === 'E_LOOP',
    // 判环是处理者粒度命中的，不是跳数兜底救的场——两者都会切断，但只有前者
    // 满足「首次回访即切断」。
    loopNotByHopBackstop: loop.hopCountAtCut < loop.maxHops,
    loopAuditEvent: loop.loopEvents === 1,
    loopAuditCarriesChain:
      loop.traceChainMatches &&
      typeof loop.hopPath === 'string' &&
      loop.hopPath.length > 0 &&
      typeof loop.loopKeyHandler === 'string' &&
      typeof loop.loopKeyTaskId === 'string',
    spiralNotCut: spiral.delivered && spiral.loopEvents === 0,
    runtimeThrottleAtCapacity:
      runtime.allowed === runtime.capacity &&
      runtime.refusedCode === 'E_RUNTIME_THROTTLED' &&
      runtime.otherTargetAllowed,
    runtimeThrottleStaysLocal: runtime.refusedStayedLocal,
    protocolBudgetAtLimit:
      budget.accepted === budget.perMinute &&
      budget.refusedCode === 'E_RATE_LIMITED' &&
      // >1 个发送 agent：协议层按**节点**计，多开名字不多拿配额。
      budget.senderAgents > 1,
    layersDoNotOverlap: runtime.noProtocolEvent && budget.noRuntimeEvent,
  }

  return {
    ...observations,
    checks,
    pass: Object.values(checks).every(Boolean),
  }
}
