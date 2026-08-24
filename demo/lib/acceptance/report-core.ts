// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: MIT

/**
 * 阡陌端到端验收套件 —— 纯判定与渲染层。
 *
 * 这里**不碰进程、不碰网络、不碰文件系统**，只把一堆
 * {@link ScenarioResult} 折成 {@link SuiteRun} 再渲染成两种形态：
 *
 *   ① 机器可读：NDJSON，一行一个场景，最后一行是 `{"kind":"summary",…}`；
 *   ② 人可读：汇总表，一行一个场景 + 判定 + 红的时候带证据摘要。
 *
 * 与 `demo/lib/*-report-core.ts` 同一套路：判定逻辑单独成文件才测得动。
 * 驱动那半边要起真进程，进不了单测分片；这半边进得去，于是「判定规则本身
 * 有没有被改松」是有回归护栏的。
 *
 * 一条硬规则：**`knownIssue` 不改变判定。** 挂了缺陷编号的场景仍然按 `fail`
 * 计入 `counts` 与 `pass`，只是渲染时多一列标注。套件的用处就是把红的抓出来，
 * 给红的开豁免口子等于把用处删掉。
 */

import type {
  Dimension,
  Evidence,
  Outcome,
  ScenarioResult,
  SuiteRun,
  Target,
} from './types.js'
import { DIMENSIONS } from './types.js'

const OUTCOMES: readonly Outcome[] = ['pass', 'fail', 'skip', 'error']

/** 汇总元信息（时间、目标、提交）。 */
export interface SuiteMeta {
  readonly target: Target
  readonly startedAt: string
  readonly finishedAt: string
  readonly commit?: string
}

/** 把逐场景结果折成一轮运行。 */
export function summarize(
  results: readonly ScenarioResult[],
  meta: SuiteMeta,
): SuiteRun {
  const counts: Record<Outcome, number> = {
    pass: 0,
    fail: 0,
    skip: 0,
    error: 0,
  }
  for (const r of results) counts[r.outcome] += 1

  const started = Date.parse(meta.startedAt)
  const finished = Date.parse(meta.finishedAt)

  // 「真正触达目标」= 已执行（非 skip）且至少调用过一次驱动。
  // skip 不算：它本来就没跑。`read-repo-source` 那类静态断言也不算：它们读的
  // 是 runner 上的仓库源码，两条腿按设计本就相同，证明不了目标的任何事。
  const targetTouches = results.filter(
    r => r.outcome !== 'skip' && r.driverCalls.length > 0,
  ).length

  return {
    target: meta.target,
    startedAt: meta.startedAt,
    finishedAt: meta.finishedAt,
    durationMs:
      Number.isFinite(started) && Number.isFinite(finished)
        ? finished - started
        : 0,
    results,
    counts,
    targetTouches,
    // skip 不参与判定：一个能力在本目标上不存在，不是被测系统的失败。
    // 但它也不是通过 —— 覆盖率那张表会把它单列出来。
    //
    // `targetTouches > 0` 是 issue #61 之后加的第三项，它挡的不是「系统答错
    // 了」而是「这一轮根本没问过系统」：真机腿曾经在驱动零调用的情况下报出
    // exit 0 + 「判定: PASS」，而那 11 条绿全部跑在开发机上。全绿与没跑必须
    // 给出不同的退出码，否则修好之后的任何一次退化都会以同样的形态回来。
    pass: counts.fail === 0 && counts.error === 0 && targetTouches > 0,
    commit: meta.commit,
  }
}

/** 单维度的覆盖情况。 */
export interface DimensionCoverage {
  readonly dimension: Dimension
  readonly total: number
  readonly pass: number
  readonly fail: number
  readonly skip: number
  readonly error: number
}

/**
 * 按维度统计。
 *
 * 维度全表来自 {@link DIMENSIONS} 而不是结果里出现过的那些 —— 一个维度一条
 * 场景都没跑出来时，它必须以 `total: 0` 的形态出现在报告里。只统计「跑过的」
 * 就永远看不见整片没覆盖的地方，而那正是最该看见的。
 */
export function coverageByDimension(
  run: SuiteRun,
): readonly DimensionCoverage[] {
  return DIMENSIONS.map(dimension => {
    const rows = run.results.filter(r => r.dimension === dimension)
    return {
      dimension,
      total: rows.length,
      pass: rows.filter(r => r.outcome === 'pass').length,
      fail: rows.filter(r => r.outcome === 'fail').length,
      skip: rows.filter(r => r.outcome === 'skip').length,
      error: rows.filter(r => r.outcome === 'error').length,
    }
  })
}

/** 机器可读：一行一个场景，末行 summary。 */
export function toNdjson(run: SuiteRun): string {
  const lines = run.results.map(r => JSON.stringify({ kind: 'scenario', ...r }))
  lines.push(
    JSON.stringify({
      kind: 'summary',
      target: run.target,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      durationMs: run.durationMs,
      counts: run.counts,
      targetTouches: run.targetTouches,
      pass: run.pass,
      commit: run.commit,
      coverage: coverageByDimension(run),
    }),
  )
  return `${lines.join('\n')}\n`
}

/**
 * 反解 NDJSON。
 *
 * 存在是为了让「上一轮的结果」可以被后续工具（趋势对比、真机腿合并）重新
 * 读进来，而不是只能靠肉眼看表。解析失败的行直接跳过而不是抛 —— 结果文件
 * 可能被 tee 混进别的输出，为一行噪声丢掉整份结果是净亏损。
 */
export function fromNdjson(text: string): SuiteRun | undefined {
  const results: ScenarioResult[] = []
  let summary: Record<string, unknown> | undefined
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (typeof parsed !== 'object' || parsed === null) continue
    const rec = parsed as Record<string, unknown>
    if (rec.kind === 'scenario') results.push(rec as unknown as ScenarioResult)
    else if (rec.kind === 'summary') summary = rec
  }
  if (summary === undefined) return undefined
  return summarize(results, {
    target: summary.target as Target,
    startedAt: String(summary.startedAt ?? ''),
    finishedAt: String(summary.finishedAt ?? ''),
    commit: typeof summary.commit === 'string' ? summary.commit : undefined,
  })
}

const MARK: Record<Outcome, string> = {
  pass: 'PASS',
  fail: 'FAIL',
  skip: 'SKIP',
  error: ' ERR',
}

/**
 * 证据摘要：给汇总表用的一行内压缩形态。
 *
 * 只在渲染层截断，NDJSON 里存的永远是原文。截断标记用 `…+N` 而不是省略号
 * 单发，读的人才知道被吃掉了多少。
 */
export function briefEvidence(
  evidence: readonly Evidence[],
  limit = 160,
): string {
  if (evidence.length === 0) return ''
  const head = evidence[0]
  if (head === undefined) return ''
  const flat = `${head.label}=${head.value}`.replace(/\s+/g, ' ')
  const cut = flat.length > limit ? `${flat.slice(0, limit)}…` : flat
  const more = evidence.length > 1 ? ` (+${evidence.length - 1})` : ''
  return cut + more
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length)
}

/** 人可读汇总表。 */
export function renderSummary(run: SuiteRun): string {
  const out: string[] = []
  out.push(
    `阡陌端到端验收套件 · target=${run.target} · ${run.startedAt} · ` +
      `${(run.durationMs / 1000).toFixed(1)}s` +
      (run.commit === undefined ? '' : ` · ${run.commit}`),
  )
  out.push('')

  const idWidth = Math.max(2, ...run.results.map(r => r.id.length))
  for (const r of run.results) {
    const known = r.knownIssue === undefined ? '' : `  [${r.knownIssue}]`
    out.push(`${MARK[r.outcome]}  ${pad(r.id, idWidth)}  ${r.title}${known}`)
    if (r.outcome === 'skip') {
      out.push(`      skip: ${r.skipReason ?? '(未给原因)'}`)
      continue
    }
    if (r.outcome === 'pass') continue
    // 红的行才展开：期望、实际、以及全部证据原文（不截断——汇总表存在的
    // 意义就是让人不用去翻 NDJSON 就能开始排查）。
    out.push(`      期望: ${r.expected}`)
    out.push(`      实际: ${r.actual}`)
    for (const e of r.evidence) {
      const value = e.value.includes('\n')
        ? `\n${e.value
            .split('\n')
            .map(l => `          ${l}`)
            .join('\n')}`
        : ` ${e.value}`
      out.push(`      · ${e.label}:${value}`)
    }
  }

  out.push('')
  out.push('维度覆盖:')
  for (const c of coverageByDimension(run)) {
    const flag = c.total === 0 ? '   ← 本轮零覆盖' : ''
    out.push(
      `  ${pad(c.dimension, 18)} total=${pad(String(c.total), 3)}` +
        ` pass=${pad(String(c.pass), 3)} fail=${pad(String(c.fail), 3)}` +
        ` skip=${pad(String(c.skip), 3)} err=${c.error}${flag}`,
    )
  }

  out.push('')
  const tally = OUTCOMES.map(o => `${o}=${run.counts[o]}`).join(' ')
  out.push(`合计: ${tally}`)

  // 目标触达 —— 这一行是 issue #61 的直接产物，读报告的人先看它再看判定。
  const executed = run.results.filter(r => r.outcome !== 'skip')
  if (run.targetTouches === 0) {
    out.push(
      `目标触达: 0 / ${executed.length} 条已执行场景调用过驱动` +
        ' ← 这一轮没有任何场景碰过被测目标，等于什么都没验（判定按 FAIL 计）',
    )
  } else {
    out.push(
      `目标触达: ${run.targetTouches} / ${executed.length} 条已执行场景调用过驱动`,
    )
    const blind = executed.filter(r => r.driverCalls.length === 0)
    if (blind.length > 0) {
      out.push(
        `  其中 ${blind.length} 条没碰驱动（静态断言应当如此，别的就是绕过了驱动）: ` +
          blind.map(r => r.id).join(', '),
      )
    }
  }
  const known = run.results.filter(
    r => r.outcome === 'fail' && r.knownIssue !== undefined,
  )
  if (known.length > 0) {
    out.push(
      `其中 ${known.length} 条红是已记录缺陷（仍按失败计）: ` +
        known.map(r => `${r.id}${r.knownIssue}`).join(', '),
    )
  }
  out.push(`判定: ${run.pass ? 'PASS' : 'FAIL'}`)
  return `${out.join('\n')}\n`
}
