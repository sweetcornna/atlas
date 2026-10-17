// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 网关 › 智能体 (P36.5) as each side of the page sees it: a writer gets the
 * runtime and model selects (自动 first, the key's models by family, routing
 * groups last), the install and remove buttons and the failure text folded
 * under 详情; a reader gets names and states and none of the rest.
 */

import { describe, expect, test } from 'bun:test'
import { magpieAgentsForReader } from '../src/routes/magpieApi.js'
import {
  type MagpieAgentsModel,
  renderMagpieAgents,
} from '../src/view/magpieAgents.js'
import { FakeMagpieAgents } from './directionFakes.js'

async function model(writer: boolean): Promise<MagpieAgentsModel> {
  const snapshot = await new FakeMagpieAgents().snapshot()
  if (!snapshot.ok) throw new Error('snapshot')
  return {
    side: { kind: 'ok', value: magpieAgentsForReader(snapshot.value, writer) },
    writer,
    mainAgent: 'qianmo://tokyo-1/coder',
  }
}

/** The text a person reads in a fragment: no markup, no folded original. */
function readable(html: string): string {
  return html
    .replace(/<pre class="raw" data-raw>[\s\S]*?<\/pre>/g, '')
    .replace(/<[^>]*>/g, ' ')
}

describe('the 智能体 section', () => {
  test('a writer chooses runtime and model; 自动 names its pick and the models go by family', async () => {
    const html = renderMagpieAgents(await model(true))
    expect(html).toContain('name="mg-runtime"')
    expect(html).toContain('name="mg-model"')
    expect(html).toContain('data-write')
    // 自动 first with its pick, then the families, then routing groups.
    const coder = html.slice(
      html.indexOf('data-key="tokyo-1/coder"'),
      html.indexOf('data-key="tokyo-1/reviewer"'),
    )
    const order = [
      '<option value="auto" selected>自动（deepseek/deepseek-v4）</option>',
      '<optgroup label="DeepSeek">',
      '<optgroup label="Claude">',
      '<optgroup label="GPT">',
      '<optgroup label="路由组">',
    ].map(piece => coder.indexOf(piece))
    expect(order.every(at => at >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    // The manual choice is selected; qianmopi has no model to choose.
    expect(html).toContain(
      '<option value="anthropic/claude-opus-5" selected>anthropic/claude-opus-5</option>',
    )
    const planner = html.slice(html.indexOf('data-key="tokyo-1/planner"'))
    expect(planner).not.toContain('name="mg-model"')
    expect(planner).toContain('跟随节点主模型')
    // Installed runtimes only in the runtime select; the rest get 安装.
    expect(html).toContain('data-action="magpie-runtime-install"')
    expect(html).toContain('data-runtime="codex"')
    expect(html).toContain('data-action="magpie-runtime-remove"')
    expect(html).toContain('data-action="magpie-autojoin"')
    expect(html).toContain('data-action="magpie-join"')
    // Failure text, folded for the ticket; the main agent marked.
    expect(html).toContain('<pre class="raw" data-raw>未安装，等待安装</pre>')
    expect(html).toContain('npm 下载失败，网络超时')
    expect(html).toContain('下发失败')
    expect(html).toContain('主')
  })

  test('a reader reads names and states and nothing to press or paste', async () => {
    const html = renderMagpieAgents(await model(false))
    expect(html).not.toContain('data-write')
    expect(html).not.toContain('<select')
    expect(html).not.toContain('data-action')
    expect(html).not.toContain('data-raw')
    for (const words of [
      'qianmopi',
      'Claude Code',
      'anthropic/claude-opus-5',
      'deepseek/deepseek-v4',
      '暂用 qianmopi · 未安装',
      '下发失败',
      '节点版本过旧',
      '连不上',
      '新节点自动接入',
    ])
      expect(`${words} ${html.includes(words)}`).toBe(`${words} true`)
    for (const detail of ['网络超时', '等待安装', '已拒绝', '稍后重试'])
      expect(`${detail} ${readable(html).includes(detail)}`).toBe(
        `${detail} false`,
      )
  })

  test('copy: no full stops, commas or exclamation marks on either side', async () => {
    for (const writer of [true, false]) {
      const text = readable(renderMagpieAgents(await model(writer)))
      for (const mark of ['。', '，', '、', '！', '!'])
        expect(`${writer} ${mark} ${text.includes(mark)}`).toBe(
          `${writer} ${mark} false`,
        )
    }
  })

  test('without a control link the section says how to wire it', () => {
    const html = renderMagpieAgents({
      side: { kind: 'unwired' },
      writer: true,
      mainAgent: null,
    })
    expect(html).toContain('data-unwired')
    expect(html).toContain('--control')
  })
})
