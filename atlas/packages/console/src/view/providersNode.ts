// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * One node's 「模型」 tab (§6.3.8): expected, actual, drift, every field of
 * `effective`, each key of a key pool as the node reports it (P18.18), the
 * last ten applies and probes, and the two settings a node page may change —
 * the context window (D-8) and the auto-compact window (D-9).
 *
 * It lives at `/providers/nodes/<node>` with its polled region at
 * `/fragments/providers/nodes/<node>`. `/nodes/<node>` is P18.11's page; the
 * fragment is what that page embeds or links to, so the tab is drawn in one
 * place whichever page shows it.
 *
 * ## Two settings, two owners
 *
 * - The context window is the hub's: a per-node override in the assignment,
 *   compiled into the node's settings at the next apply. What the node runs
 *   is its `effective.contextTokens`; where the number is meant to come from
 *   (节点覆盖 / 档案 / 默认 200k) is the hub's record and labelled as such.
 * - The auto-compact window is the node's own (D-9): written straight to the
 *   node through `qm provider autocompact`, never part of a profile, never
 *   drift. Its value and where it came from are the node's
 *   (`effective.autoCompactWindow`, `effective.autoCompactSource`).
 */

import type {
  ProviderNodeView,
  ProviderOverview,
  ProviderProfileView,
} from '../deps.js'
import { sectionHead, state } from './bits.js'
import { attr, escapeHtml } from './escape.js'
import { formatRelative } from './format.js'
import {
  appliedText,
  contextSource,
  driftList,
  effectiveCells,
  effectiveFields,
  expectedText,
  kvText,
  namesOf,
  nodeState,
  recentList,
  tokens,
  writeLink,
  type ProvidersReader,
} from './providers.js'
import { nodeKeysSection } from './providersKeys.js'

interface NodePanelModel {
  readonly node: ProviderNodeView
  readonly overview: ProviderOverview | null
  readonly reader: ProvidersReader
  readonly now: number
}

function profileOf(model: NodePanelModel): ProviderProfileView | undefined {
  const id = model.node.expected?.profileId
  if (id === undefined) return undefined
  return model.overview?.profiles.find(entry => entry.profile.id === id)
    ?.profile
}

/** Where a write control of the tab leads when no script of this area is on the page. */
function doHref(node: string, what: string): string {
  return `/providers/nodes/${encodeURIComponent(node)}?do=${what}`
}

const AUTO_COMPACT_SOURCE_LINE: Readonly<Record<string, string>> = {
  env: '来自节点进程的环境变量 · 控制台改不了 · 要在节点上去掉这个变量',
  settings: '来自节点设置',
  auto: '自动 · 按上下文窗口算',
}

/** D-8: the context window, the node's number and the hub's source. */
function contextSetting(model: NodePanelModel): string {
  const { node, reader } = model
  const cells = effectiveCells(node.actual)
  const source = contextSource(node, profileOf(model))
  const pendingApply = node.drift.some(drift => drift.kind === 'out-of-sync')
  const controls = reader.writer
    ? `<div class="prov-actions">` +
      writeLink('prov-context', '修改', doHref(node.node, 'context'), {
        node: node.node,
        tokens:
          node.contextOverride === null ? '' : String(node.contextOverride),
      }) +
      (node.contextOverride === null
        ? ''
        : writeLink(
            'prov-context-clear',
            '恢复默认',
            doHref(node.node, 'context-clear'),
            { node: node.node },
          )) +
      `</div>`
    : ''
  return (
    `<article class="card elev-sm prov-setting" data-setting="context">` +
    `<div class="card-kicker">Context</div>` +
    `<div class="prov-kvs">` +
    kvText('上下文窗口 · 节点算出', cells.context) +
    kvText(
      '来源 · 中枢期望',
      source +
        (node.contextOverride === null
          ? ''
          : ` · 覆盖 ${tokens(node.contextOverride)}`),
    ) +
    `</div>` +
    `<p class="note">${escapeHtml(
      `改动写入该节点的指派覆盖 · 随下一次下发生效${
        pendingApply ? ' · 当前有待下发的改动' : ''
      } · 超过模型能力时节点按能力夹取`,
    )}</p>` +
    controls +
    `</article>`
  )
}

/** D-9: the auto-compact window, the node's value and the node's source. */
function autoCompactSetting(model: NodePanelModel): string {
  const { node, reader } = model
  const cells = effectiveCells(node.actual)
  const value =
    cells.autoCompactTokens === null
      ? '未报告'
      : tokens(cells.autoCompactTokens)
  const source =
    cells.autoCompactSource === null
      ? '节点没有报告 · 可能是较早的节点版本'
      : (AUTO_COMPACT_SOURCE_LINE[cells.autoCompactSource] ??
        cells.autoCompactSource)
  const pinned = cells.autoCompactSource === 'env'
  return (
    `<article class="card elev-sm prov-setting" data-setting="autocompact">` +
    `<div class="card-kicker">Auto compact</div>` +
    `<div class="prov-kvs">` +
    kvText('自动压缩阈值 · 节点算出', value) +
    kvText('来源 · 节点', source) +
    `</div>` +
    `<p class="note">立即写到节点 · 归节点所有 · 不随下发改变 · 运行中的会话下一轮生效</p>` +
    (reader.writer && !pinned
      ? `<div class="prov-actions">` +
        writeLink(
          'prov-autocompact',
          '修改',
          doHref(node.node, 'autocompact'),
          {
            node: node.node,
          },
        ) +
        `</div>`
      : '') +
    `</article>`
  )
}

/** The polled half of the tab. */
export function renderNodePanel(model: NodePanelModel): string {
  const { node, overview, reader, now } = model
  const names = namesOf(overview?.profiles ?? [])
  const status = nodeState(node, now)
  const name = node.node
  const local = node.drift.find(drift => drift.kind === 'local-edit')
  const actions = reader.writer
    ? `<div class="prov-actions">` +
      writeLink(
        'prov-apply',
        '下发',
        doHref(name, 'apply'),
        { node: name },
        {
          primary: true,
        },
      ) +
      (node.expected === null
        ? ''
        : writeLink('prov-probe', '测连', doHref(name, 'probe'), {
            node: name,
            profile: node.expected.profileId,
          }) +
          writeLink('prov-diff', '查看差异', doHref(name, 'diff'), {
            node: name,
          })) +
      writeLink('prov-assign', '指派', doHref(name, 'assign'), {
        node: name,
        mode: node.assignment.mode,
        profile:
          node.assignment.mode === 'profile' ? node.assignment.profileId : '',
      }) +
      writeLink('prov-refresh', '刷新', doHref(name, 'refresh'), {
        node: name,
      }) +
      (local === undefined
        ? ''
        : writeLink('prov-force', '覆盖节点上的改动', doHref(name, 'force'), {
            node: name,
            keys: (local.keys ?? []).join(' '),
          }) +
          writeLink(
            'prov-unmanage',
            '停止托管',
            doHref(name, 'unmanage'),
            { node: name },
            { danger: true },
          )) +
      `</div>`
    : ''
  return (
    `<div class="prov-node-in" data-node="${attr(node.node)}" data-state="${attr(
      status.word,
    )}">` +
    `<style>${NODE_TAB_CSS}</style>` +
    `<section class="card elev-sm prov-node-head">` +
    `<div class="rowx"><span class="prov-default-name mono">${escapeHtml(
      node.node,
    )}</span>${state(status.tone, status.word)}</div>` +
    `<div class="prov-kvs">` +
    kvText('期望', expectedText(node, names)) +
    kvText('实际', appliedText(node.actual, names)) +
    kvText('执行方式', node.executor === 'ssh' ? 'SSH 强制命令' : '本机') +
    kvText(
      '状态刷新',
      node.lastStatus === null
        ? '尚未刷新'
        : `${node.lastStatus.ok ? '成功' : '失败 · 已过期'} · ${formatRelative(
            node.lastStatus.at,
            now,
          )}`,
    ) +
    `</div>` +
    driftList(node, reader, now) +
    actions +
    `</section>` +
    `<section class="sec" aria-labelledby="h-prov-effective">` +
    sectionHead('Effective', '节点算出的生效值', {
      headingId: 'h-prov-effective',
      tail: `<span class="note">中枢不推断 · 节点没报的就写未报告</span>`,
    }) +
    effectiveFields(node.actual) +
    `</section>` +
    nodeKeysSection(node.actual) +
    `<section class="sec" aria-labelledby="h-prov-settings">` +
    sectionHead('Settings', '设置', { headingId: 'h-prov-settings' }) +
    `<div class="prov-cards">` +
    contextSetting(model) +
    autoCompactSetting(model) +
    `</div></section>` +
    (reader.writer
      ? `<section class="sec" aria-labelledby="h-prov-recent">` +
        sectionHead('Recent', '最近的下发与测连', {
          headingId: 'h-prov-recent',
        }) +
        recentList(node.recent, names, now) +
        `</section>`
      : '') +
    `</div>`
  )
}

/**
 * The 「模型」 tab's fragment URL: `/fragments/providers/node/<node>`, the node
 * one percent-encoded path segment. The interface P18.11's `/nodes/<node>`
 * loads; this area's own node page polls the same URL.
 */
function nodeTabFragment(node: string): string {
  return `/fragments/providers/node/${encodeURIComponent(node)}`
}

/**
 * The few rules the tab needs, carried inside it: embedded in `/nodes/<node>`
 * it arrives without this area's page sheet. Shared classes do the rest.
 */
const NODE_TAB_CSS =
  '.prov-node-in{display:flex;flex-direction:column;gap:var(--space-5)}' +
  '.prov-node-in .prov-kvs{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:var(--space-3)}' +
  '.prov-node-in .prov-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:var(--space-3)}' +
  '.prov-node-in .prov-drift,.prov-node-in .prov-recent{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:var(--space-2);font-size:13px}' +
  '.prov-node-in .prov-drift li,.prov-node-in .prov-recent li{display:flex;flex-wrap:wrap;align-items:center;gap:var(--space-2) var(--space-3)}' +
  '.prov-node-in .prov-actions{display:flex;flex-wrap:wrap;gap:var(--space-2);align-items:center}' +
  '.prov-node-in .prov-keys{font-size:12px;overflow-wrap:anywhere}' +
  '.prov-node-in .card{padding:var(--space-4);gap:var(--space-3)}'

/** The whole tab: the polled panel, and the way back to the matrix. */
export function renderNodePage(model: NodePanelModel): string {
  const name = model.node.node
  return (
    `<p class="note"><a href="/providers?node=${attr(
      encodeURIComponent(name),
    )}" data-nav>在节点矩阵里看这台节点</a></p>` +
    `<div class="prov-node" id="prov-node" data-poll="${attr(
      nodeTabFragment(name),
    )}">` +
    renderNodePanel(model) +
    `</div>`
  )
}
