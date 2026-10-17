// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 网关 › 智能体 (P36.5) as each side of the page sees it: a writer gets the
 * runtime and model selects (自动 first, the key's models by family, routing
 * groups last), the install and remove buttons and the failure text folded
 * under 详情; a reader gets names and states and none of the rest. Each
 * agent's 原生扩展 panel (P36.7) the same way: everyone reads the list and the
 * commands, only writers get install, remove and the node's words.
 */

import { describe, expect, test } from 'bun:test'
import type { MagpieAgentView } from '../src/directionPorts.js'
import { magpieAgentsForReader } from '../src/routes/magpieApi.js'
import {
  type MagpieAgentsModel,
  renderMagpieAgents,
  renderMagpieExtensionForm,
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

  test('a reader reads names and states and has nothing to press but 复制', async () => {
    const html = renderMagpieAgents(await model(false))
    expect(html).not.toContain('data-write')
    expect(html).not.toContain('<select')
    const actions = new Set(
      [...html.matchAll(/data-action="([^"]+)"/g)].map(match => match[1]),
    )
    expect([...actions]).toEqual(['magpie-ext-copy'])
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

/** One agent's 原生扩展 panel, cut out of the section. */
function panel(html: string, agent: string): string {
  const start = html.indexOf(`data-key="ext:tokyo-1/${agent}"`)
  if (start < 0) return ''
  return html.slice(start, html.indexOf('</details></td></tr>', start))
}

/** The writer's section with tokyo-1's first agent (coder) changed. */
async function withCoder(
  change: (coder: MagpieAgentView) => MagpieAgentView,
): Promise<string> {
  const agents = new FakeMagpieAgents()
  const node = agents.nodes[0]
  const [coder, ...rest] = node?.agents ?? []
  if (node === undefined || coder === undefined) throw new Error('fixture')
  agents.nodes[0] = { ...node, agents: [change(coder), ...rest] }
  const snapshot = await agents.snapshot()
  if (!snapshot.ok) throw new Error('snapshot')
  return renderMagpieAgents({
    side: { kind: 'ok', value: snapshot.value },
    writer: true,
    mainAgent: null,
  })
}

describe('the 原生扩展 panel (P36.7)', () => {
  test('a writer gets the list by kind, install and remove, and the failures folded', async () => {
    const html = renderMagpieAgents(await model(true))
    const coder = panel(html, 'coder')
    // Grouped 插件 / MCP / 技能, each item with its facts and a 卸载.
    const order = [
      '插件',
      '@deepseek-ai/dsh-plugin-review',
      'MCP',
      'github',
      '技能',
      'release-notes',
    ].map(piece => coder.indexOf(piece))
    expect(order.every(at => at >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    expect(coder).toContain('v0.3.1 · npm')
    expect(coder).toContain('停用')
    expect(coder).toContain(
      'data-action="magpie-ext-remove" data-node="tokyo-1" data-agent="coder" data-kind="mcp" data-name="github"',
    )
    expect(coder).toContain('data-action="magpie-ext-new"')
    expect(coder).toContain('<li class="note">项目级配置不加载</li>')
    // The open command and, since it names a port, the forwarding line.
    expect(coder).toContain('qm runtime open coder --port 8123')
    expect(coder).toContain('在节点上运行 · 进入该底层的官方前端')
    expect(coder).toContain('ssh -L 8123:127.0.0.1:8123 tokyo-1')
    expect(coder).toContain('data-fresh="1"')
    // No port named, no forwarding line; a plugin the resident runtime skips.
    const planner = panel(html, 'planner')
    expect(planner).toContain('qm runtime open planner')
    expect(planner).not.toContain('ssh -L')
    expect(planner).toContain('常驻运行时不加载')
    // A failed read and a failed install, the node's words folded.
    const reviewer = panel(html, 'reviewer')
    expect(reviewer).toContain('安装失败 · 插件 obra/superpowers')
    expect(reviewer).toContain(
      '<pre class="raw" data-raw>E_RUNTIME_EXT_FAILED：克隆失败，仓库不存在</pre>',
    )
    expect(reviewer).toContain('没读到列表')
    expect(reviewer).toContain(
      '<pre class="raw" data-raw>列表命令超时，已放弃</pre>',
    )
    expect(reviewer).toContain('data-fresh="0"')
    // An install in flight: followed, and nothing else to start meanwhile.
    const builder = panel(html, 'builder')
    expect(builder).toContain('data-busy')
    expect(builder).toContain('安装中 · MCP docs')
    expect(builder).toContain('读取中')
    expect(builder).not.toContain('magpie-ext-new')
  })

  test('a reader sees the list and the commands, no forms and no failure text', async () => {
    const html = renderMagpieAgents(await model(false))
    const coder = panel(html, 'coder')
    expect(coder).toContain('@deepseek-ai/dsh-plugin-review')
    expect(coder).toContain('qm runtime open coder --port 8123')
    expect(coder).toContain('data-action="magpie-ext-copy"')
    expect(coder).not.toContain('magpie-ext-remove')
    expect(coder).not.toContain('magpie-ext-new')
    expect(panel(html, 'planner')).toContain('常驻运行时不加载')
    const reviewer = readable(panel(html, 'reviewer'))
    expect(reviewer).toContain('安装失败 · 插件 obra/superpowers')
    expect(reviewer).not.toContain('克隆失败')
    expect(reviewer).not.toContain('列表命令超时')
  })

  test('only a port the open command names makes a forwarding line', async () => {
    const forwarding = async (openCommand: string) => {
      const html = await withCoder(coder =>
        coder.extensions === null
          ? coder
          : { ...coder, extensions: { ...coder.extensions, openCommand } },
      )
      return /ssh -L ([^<]+)</.exec(panel(html, 'coder'))?.[1] ?? null
    }
    expect(await forwarding('qm runtime open coder --port=9000')).toBe(
      '9000:127.0.0.1:9000 tokyo-1',
    )
    expect(await forwarding('qm runtime open coder')).toBeNull()
    expect(await forwarding('qm runtime open coder --port 99999')).toBeNull()
    expect(await forwarding('qm runtime open coder --portal 80')).toBeNull()
  })

  test('an agent on a node without the ops gets no panel', async () => {
    const html = await withCoder(coder => ({ ...coder, extensions: null }))
    expect(html).not.toContain('ext:tokyo-1/coder')
    expect(html).toContain('ext:tokyo-1/reviewer')
  })

  test('the install form: kind, source, and the MCP fields; copy rules hold', () => {
    const html = renderMagpieExtensionForm({ node: 'tokyo-1', agent: 'coder' })
    expect(html).toContain('<input type="hidden" name="form" value="ext">')
    expect(html).toContain('name="node" value="tokyo-1"')
    expect(html).toContain('name="agent" value="coder"')
    for (const field of ['extKind', 'source', 'name', 'command', 'args', 'url'])
      expect(`${field} ${html.includes(`name="${field}"`)}`).toBe(
        `${field} true`,
      )
    const text = readable(html)
    for (const mark of ['。', '，', '、', '！', '!'])
      expect(`${mark} ${text.includes(mark)}`).toBe(`${mark} false`)
  })
})
