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
  test('每个场景一行 + 末行 summary', () => {
    const run = summarize(
      [
        result({ id: 'handshake/a', outcome: 'pass' }),
        result({ id: 'policy/b', outcome: 'fail' }),
      ],
      META,
    )
    const lines = toNdjsonLines(run)
    expect(lines.length).toBe(3)
    expect(JSON.parse(lines[0] ?? '').kind).toBe('scenario')
    expect(JSON.parse(lines[1] ?? '').kind).toBe('scenario')
    const summary = JSON.parse(lines[2] ?? '')
    expect(summary.kind).toBe('summary')
    expect(summary.pass).toBe(false)
    expect(Array.isArray(summary.coverage)).toBe(true)
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
