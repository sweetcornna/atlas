// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: MIT

/**
 * 验收套件判定层的回归护栏。
 *
 * 这些用例守的不是「场景通不通过」，而是**判定规则本身有没有被改松**。
 * 驱动那半边要起真进程，进不了单测分片；这半边进得去，所以「已知缺陷不改
 * 判定」「skip 不算通过」「零覆盖维度必须出现在报告里」这三条被钉在这里。
 */

import { describe, expect, test } from 'bun:test'
import {
  briefEvidence,
  coverageByDimension,
  fromNdjson,
  ndjsonScenarioLine,
  ndjsonStartLine,
  ndjsonSummaryLine,
  renderSummary,
  summarize,
  type SuiteMeta,
} from '../report-core.js'
import type { Dimension, Outcome, ScenarioResult } from '../types.js'
import { DIMENSIONS } from '../types.js'

const META: SuiteMeta = {
  target: 'local',
  startedAt: '2026-08-24T00:00:00.000Z',
  finishedAt: '2026-08-24T00:01:30.000Z',
  commit: 'c4ed9d8f',
}

function result(
  over: Partial<ScenarioResult> & { id: string; outcome: Outcome },
): ScenarioResult {
  return {
    dimension: (over.id.split('/')[0] ?? 'handshake') as Dimension,
    title: over.id,
    target: 'local',
    durationMs: 10,
    expected: '期望',
    actual: '实际',
    evidence: [],
    requires: ['raw-dial'],
    // 缺省「碰过驱动」：这些用例守的是别的规则，不该每条都去想触达那一项。
    // 触达规则自己的用例显式传 `driverCalls: []`。
    driverCalls: ['startNode'],
    ...over,
  }
}

describe('summarize', () => {
  test('counts 每个 outcome 各自成列', () => {
    const run = summarize(
      [
        result({ id: 'handshake/a', outcome: 'pass' }),
        result({ id: 'handshake/b', outcome: 'fail' }),
        result({ id: 'policy/c', outcome: 'skip', skipReason: '缺能力' }),
        result({ id: 'policy/d', outcome: 'error' }),
      ],
      META,
    )
    expect(run.counts).toEqual({ pass: 1, fail: 1, skip: 1, error: 1 })
    expect(run.durationMs).toBe(90_000)
  })

  test('skip 不拉低判定，fail 与 error 会', () => {
    const onlySkips = summarize(
      [
        result({ id: 'handshake/a', outcome: 'pass' }),
        result({ id: 'policy/b', outcome: 'skip', skipReason: 'x' }),
      ],
      META,
    )
    expect(onlySkips.pass).toBe(true)

    const withFail = summarize(
      [result({ id: 'handshake/a', outcome: 'fail' })],
      META,
    )
    expect(withFail.pass).toBe(false)

    const withError = summarize(
      [result({ id: 'handshake/a', outcome: 'error' })],
      META,
    )
    expect(withError.pass).toBe(false)
  })

  // 这条是整个套件的存在理由：给红开豁免口子等于把套件删掉。
  test('knownIssue 不把 fail 洗成 pass', () => {
    const run = summarize(
      [
        result({
          id: 'multi-agent/workspace-isolation',
          outcome: 'fail',
          knownIssue: '#44',
        }),
      ],
      META,
    )
    expect(run.counts.fail).toBe(1)
    expect(run.counts.pass).toBe(0)
    expect(run.pass).toBe(false)
  })

  // ── 目标触达（issue #61 那次假绿的直接护栏）─────────────────────────────
  //
  // 真机腿曾经报 `pass=11 fail=0 skip=104` + exit 0 + 「判定: PASS」，而驱动
  // **一次都没被调用过** —— 那 11 条绿全部跑在开发机上。下面三条钉住的是
  // 「全绿」与「没跑」必须给出不同的判定。
  describe('目标触达', () => {
    test('一条场景都没碰过驱动时不算通过，哪怕全绿', () => {
      const run = summarize(
        [
          result({
            id: 'policy/both-flags-refused',
            outcome: 'pass',
            driverCalls: [],
          }),
          result({
            id: 'trust/no-execution-gate',
            outcome: 'pass',
            driverCalls: [],
          }),
          result({ id: 'handshake/psk-ok', outcome: 'skip', skipReason: 'x' }),
        ],
        { ...META, target: 'fleet' },
      )
      expect(run.counts).toEqual({ pass: 2, fail: 0, skip: 1, error: 0 })
      expect(run.targetTouches).toBe(0)
      expect(run.pass).toBe(false)
      expect(renderSummary(run)).toContain('等于什么都没验')
    })

    test('哪怕只有一条碰过驱动，判定就回到看 fail/error', () => {
      const run = summarize(
        [
          result({
            id: 'trust/no-execution-gate',
            outcome: 'pass',
            driverCalls: [],
          }),
          result({
            id: 'policy/both-flags-refused',
            outcome: 'pass',
            driverCalls: ['execHost', 'startNode'],
          }),
        ],
        { ...META, target: 'fleet' },
      )
      expect(run.targetTouches).toBe(1)
      expect(run.pass).toBe(true)
    })

    // skip 的场景不该被算成触达 —— 它压根没跑。
    test('skip 不计入触达', () => {
      const run = summarize(
        [
          result({
            id: 'handshake/psk-ok',
            outcome: 'skip',
            skipReason: '缺 spawn-node',
            driverCalls: ['startNode'],
          }),
        ],
        { ...META, target: 'fleet' },
      )
      expect(run.targetTouches).toBe(0)
      expect(run.pass).toBe(false)
    })
  })
})

describe('coverageByDimension', () => {
  test('零覆盖的维度也必须出现在表里', () => {
    const run = summarize(
      [result({ id: 'handshake/a', outcome: 'pass' })],
      META,
    )
    const cov = coverageByDimension(run)
    expect(cov.length).toBe(DIMENSIONS.length)
    const wake = cov.find(c => c.dimension === 'wake')
    expect(wake).toBeDefined()
    expect(wake?.total).toBe(0)
  })

  test('逐维度分列 pass/fail/skip/error', () => {
    const run = summarize(
      [
        result({ id: 'audit/a', outcome: 'pass' }),
        result({ id: 'audit/b', outcome: 'fail' }),
        result({ id: 'audit/c', outcome: 'skip', skipReason: 'x' }),
        result({ id: 'audit/d', outcome: 'error' }),
      ],
      META,
    )
    const audit = coverageByDimension(run).find(c => c.dimension === 'audit')
    expect(audit).toEqual({
      dimension: 'audit',
      total: 4,
      pass: 1,
      fail: 1,
      skip: 1,
      error: 1,
    })
  })
})

describe('NDJSON 往返', () => {
  test('首行 start + 每个场景一行 + 末行 summary', () => {
    const run = summarize(
      [
        result({ id: 'handshake/a', outcome: 'pass' }),
        result({ id: 'policy/b', outcome: 'fail' }),
      ],
      META,
    )
    const lines = toNdjsonLines(run)
    expect(lines.length).toBe(4)
    const start = JSON.parse(lines[0] ?? '')
    expect(start.kind).toBe('start')
    // 被打断的文件只有首行这些字段可读 —— target / startedAt 以前只存在于
    // summary 行里，于是半份产物连「这是哪条腿」都答不出来。
    expect(start.target).toBe('local')
    expect(start.startedAt).toBe(META.startedAt)
    expect(start.commit).toBe('c4ed9d8f')
    expect(start.planned).toBe(2)
    expect(JSON.parse(lines[1] ?? '').kind).toBe('scenario')
    expect(JSON.parse(lines[2] ?? '').kind).toBe('scenario')
    const summary = JSON.parse(lines[3] ?? '')
    expect(summary.kind).toBe('summary')
    expect(summary.pass).toBe(false)
    expect(Array.isArray(summary.coverage)).toBe(true)
  })

  test('流式拼出来的一份与 toNdjson 逐字节相同', () => {
    // 真跑走的是「首行 → 每条追加 → 末行」，`toNdjson` 只有单测和一次性
    // 渲染在用。两条路各写各的格式是这类产物最典型的漂移，这里钉住。
    const results = [
      result({ id: 'handshake/a', outcome: 'pass' }),
      result({ id: 'policy/b', outcome: 'fail' }),
    ]
    const run = summarize(results, META)
    const streamed =
      `${ndjsonStartLine({
        target: run.target,
        startedAt: run.startedAt,
        commit: run.commit,
        planned: results.length,
      })}\n` +
      `${results.map(r => `${ndjsonScenarioLine(r)}\n`).join('')}` +
      `${ndjsonSummaryLine(run)}\n`
    expect(streamed).toBe(renderNdjson(run))
  })

  test('被打断的一份：有 start 无 summary，读得出跑到哪、也读得出没跑完', () => {
    const run = summarize(
      [
        result({ id: 'handshake/a', outcome: 'pass' }),
        result({ id: 'policy/b', outcome: 'pass' }),
      ],
      META,
    )
    // 计划 115 条，写到第 2 条被杀 —— 正是 issue #85 里那个现场的形状。
    const partial =
      `${ndjsonStartLine({
        target: run.target,
        startedAt: run.startedAt,
        commit: run.commit,
        planned: 115,
      })}\n` + run.results.map(r => `${ndjsonScenarioLine(r)}\n`).join('')

    const lines = partial.trimEnd().split('\n')
    // ① 末行不是 summary → 这一轮没跑完。CI 那道护栏与人都按这条读。
    expect(JSON.parse(lines.at(-1) ?? '').kind).not.toBe('summary')
    // ② 首行还在，于是「计划多少 / 跑了多少 / 哪条腿」都答得出来。
    const start = JSON.parse(lines[0] ?? '')
    expect(start.planned).toBe(115)
    expect(start.target).toBe('local')
    expect(lines.filter(l => JSON.parse(l).kind === 'scenario').length).toBe(2)
    // ③ 前面那些结果是真留下来了 —— 修复要的就是这一条。
    expect(JSON.parse(lines[1] ?? '').id).toBe('handshake/a')
    // ④ 而程序化反解**不会**拿半份编一个 SuiteRun 出来：那两条全绿，
    //    `summarize` 一下会得出 pass=true，恰好是最坏的那种静默。
    expect(fromNdjson(partial)).toBeUndefined()
  })

  test('fromNdjson 还原判定与逐条结果', () => {
    const run = summarize(
      [
        result({
          id: 'delivery/unknown-agent',
          outcome: 'fail',
          evidence: [{ label: 'code', value: 'E_UNKNOWN_AGENT' }],
        }),
      ],
      META,
    )
    const back = fromNdjson(renderNdjson(run))
    expect(back).toBeDefined()
    expect(back?.pass).toBe(false)
    expect(back?.results.length).toBe(1)
    expect(back?.results[0]?.evidence[0]?.value).toBe('E_UNKNOWN_AGENT')
    expect(back?.commit).toBe('c4ed9d8f')
  })

  test('混进噪声行不丢结果', () => {
    const run = summarize([result({ id: 'audit/a', outcome: 'pass' })], META)
    const dirty = `噪声一行\n${renderNdjson(run)}{ 不是 JSON\n`
    const back = fromNdjson(dirty)
    expect(back?.results.length).toBe(1)
  })

  test('没有 summary 行时返回 undefined，而不是编一个出来', () => {
    expect(fromNdjson('{"kind":"scenario","id":"a"}\n')).toBeUndefined()
    expect(fromNdjson('')).toBeUndefined()
  })
})

describe('renderSummary', () => {
  test('红的行展开期望/实际/全部证据；绿的行不展开', () => {
    const run = summarize(
      [
        result({ id: 'handshake/ok', outcome: 'pass', title: '正常握手' }),
        result({
          id: 'handshake/bad-psk',
          outcome: 'fail',
          title: '错 PSK',
          expected: 'close 4003',
          actual: 'close 1000',
          evidence: [
            { label: 'closeCode', value: '1000' },
            { label: 'closeReason', value: 'normal' },
          ],
        }),
      ],
      META,
    )
    const text = renderSummary(run)
    expect(text).toContain('PASS  handshake/ok')
    expect(text).toContain('FAIL  handshake/bad-psk')
    expect(text).toContain('期望: close 4003')
    expect(text).toContain('实际: close 1000')
    expect(text).toContain('closeCode: 1000')
    expect(text).toContain('closeReason: normal')
    // 绿的那条不该把 expected 也铺开——那样表就没法看了。
    expect(text).not.toContain('期望: 期望')
    expect(text).toContain('判定: FAIL')
  })

  test('skip 行给出原因', () => {
    const run = summarize(
      [
        result({
          id: 'launcher/beta-up',
          outcome: 'skip',
          skipReason: '驱动 fleet 缺少能力: run-launcher',
        }),
      ],
      META,
    )
    expect(renderSummary(run)).toContain('skip: 驱动 fleet 缺少能力')
  })

  test('已知缺陷标注出来，但判定仍是 FAIL', () => {
    const run = summarize(
      [
        result({
          id: 'multi-agent/workspace-isolation',
          outcome: 'fail',
          knownIssue: '#44',
        }),
      ],
      META,
    )
    const text = renderSummary(run)
    expect(text).toContain('[#44]')
    expect(text).toContain('已记录缺陷（仍按失败计）')
    expect(text).toContain('判定: FAIL')
  })

  test('零覆盖维度被点名', () => {
    const run = summarize([result({ id: 'audit/a', outcome: 'pass' })], META)
    expect(renderSummary(run)).toContain('← 本轮零覆盖')
  })
})

describe('briefEvidence', () => {
  test('空证据给空串', () => {
    expect(briefEvidence([])).toBe('')
  })

  test('超长只在渲染层截断并标注剩余条数', () => {
    const long = 'x'.repeat(300)
    const brief = briefEvidence(
      [
        { label: 'body', value: long },
        { label: 'b', value: '2' },
        { label: 'c', value: '3' },
      ],
      50,
    )
    expect(brief.startsWith('body=')).toBe(true)
    expect(brief).toContain('…')
    expect(brief).toContain('(+2)')
  })

  test('换行压平，便于放进一行表格', () => {
    expect(briefEvidence([{ label: 'l', value: 'a\n b\tc' }])).toBe('l=a b c')
  })
})

// --- 本地小工具：把 toNdjson 的输出拆行，避免每个用例重复 split -------------

import { toNdjson as renderNdjson } from '../report-core.js'

function toNdjsonLines(run: Parameters<typeof renderNdjson>[0]): string[] {
  return renderNdjson(run).trimEnd().split('\n')
}
