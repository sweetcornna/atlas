// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: MIT

/**
 * 断言累加器。
 *
 * 一条场景通常要同时成立好几件事（关闭码是 4003 **且** 审计链里记了理由
 * **且** 没有别的帧漏进来）。这个类让它们**逐条留痕**而不是短路：
 *
 *   · `expect()` 不抛，只记账。所以一条场景里三个断言全会被求值，报告里也就
 *     能看到「三条里坏了哪一条」；短路断言只会告诉你第一条坏了，第二次跑
 *     才知道第二条也坏了。
 *   · 每条断言无论成败都往证据里塞一行原文。红的时候不用回去重跑，绿的时候
 *     NDJSON 里也留着这次到底看见了什么。
 *
 * 与 `demo/lib/*-report-core.ts` 的「每条 check 单独留痕、不合并」同一条纪律。
 */

import type { Evidence, ScenarioOutcome } from './types.js'

export class Checks {
  readonly #evidence: Evidence[] = []
  readonly #failures: string[] = []
  #passed = 0

  /** 只记一行证据，不参与判定。 */
  note(label: string, value: unknown): this {
    this.#evidence.push({ label, value: render(value) })
    return this
  }

  /** 一条断言。`ok` 为假就记一笔失败，但**不中断**后面的断言。 */
  expect(ok: boolean, description: string, actual?: unknown): this {
    if (ok) {
      this.#passed += 1
    } else {
      this.#failures.push(description)
    }
    this.#evidence.push({
      label: `${ok ? 'ok' : 'FAILED'} · ${description}`,
      value: actual === undefined ? '' : render(actual),
    })
    return this
  }

  eq(actual: unknown, expected: unknown, what: string): this {
    return this.expect(
      Object.is(actual, expected),
      `${what} 应为 ${render(expected)}`,
      actual,
    )
  }

  contains(haystack: string | undefined, needle: string, what: string): this {
    return this.expect(
      haystack !== undefined && haystack.includes(needle),
      `${what} 应含 ${JSON.stringify(needle)}`,
      haystack ?? '(未取到)',
    )
  }

  notContains(
    haystack: string | undefined,
    needle: string,
    what: string,
  ): this {
    return this.expect(
      haystack === undefined || !haystack.includes(needle),
      `${what} 不应含 ${JSON.stringify(needle)}`,
      haystack ?? '(未取到)',
    )
  }

  get failed(): boolean {
    return this.#failures.length > 0
  }

  get passedCount(): number {
    return this.#passed
  }

  /** 收口成 runner 认的形状。 */
  done(summary?: string): ScenarioOutcome {
    const total = this.#passed + this.#failures.length
    const actual =
      this.#failures.length === 0
        ? (summary ?? `${total} 条断言全部成立`)
        : `${this.#failures.length}/${total} 条断言不成立: ${this.#failures.join('；')}`
    return { ok: this.#failures.length === 0, actual, evidence: this.#evidence }
  }

  /** 场景自行跳过（本目标上这条链路不存在等）。证据照样带出去。 */
  skip(reason: string): ScenarioOutcome {
    return { ok: false, actual: '跳过', evidence: this.#evidence, skip: reason }
  }
}

function render(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === undefined) return '(undefined)'
  if (value === null) return '(null)'
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}
