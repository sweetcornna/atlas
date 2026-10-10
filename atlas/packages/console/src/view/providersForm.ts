// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 模型服务: starting from a preset, the profile form, one profile's page, the
 * import page and the model label of the chat page (§6.3.2, §6.3.3, §6.3.6,
 * §6.3.8).
 *
 * ## The form is not a `<form>`
 *
 * With script off a browser submits a form by `GET`, which would put the key
 * typed into it in the address bar, the history and every access log on the
 * way (§7.5). So the profile form has no `<form>` around it, its buttons are
 * `type="button"`, and the key field has no `name`: without script there is
 * nothing to submit, and the page says so where the buttons are. The one
 * `<form>` on these pages is the preset search, a `GET` with nothing secret in
 * it, which works without script (§6.7).
 *
 * ## Effort and capability are one choice
 *
 * The catalog's validator holds `send: auto` ⇔ `capabilities: family`
 * (`validate.ts`, `checkModelEffort`), so the form asks one question —
 * 自动 / 总是发送 / 不发送 — and the capability mode follows from it. The
 * three explicit bits appear only for the two explicit answers, starting from
 * the lane's defaults the catalog uses for its own presets.
 *
 * ## Two answers the form gives that the validator does not
 *
 * - Automatic family capabilities come from omp's model catalog; explicit
 *   always/never settings compile into the native model configuration.
 * - Whether 总是发送 is on offer for the OpenAI Chat lane is the nodes' own
 *   answer ({@link chatAlwaysGate}), read from the capabilities they reported,
 *   never a constant here (follow-up 4).
 */

import type {
  ProviderCatalog,
  ProviderEffortLevel,
  ProviderNodeView,
  ProviderOverview,
  ProviderPresetView,
  ProviderProfileSummary,
  ProviderProfileView,
} from '../deps.js'
import { chevron, hint, icon, sectionHead, state, tag } from './bits.js'
import { attr, escapeHtml } from './escape.js'
import {
  CACHE_LINE,
  FAMILY_GOVERNED_LINE,
  GROUP_WORD,
  LANE_WORD,
  PLAN_WORD,
  baseUrlFor,
  calm,
  effectiveCells,
  familyGoverned,
  keyState,
  kv,
  kvText,
  laneWord,
  mainModel,
  nodeState,
  profileTags,
  tokens,
  vendorOf,
  writeButton,
  type ProvidersReader,
} from './providers.js'
import {
  addKeyButton,
  keyDialogs,
  keyList,
  keysAttr,
  nodeKeysLine,
} from './providersKeys.js'

type ProviderModel = ProviderProfileView['models'][number]

const EFFORT_LEVELS: readonly ProviderEffortLevel[] = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]

const TIERS = ['opus', 'sonnet', 'haiku', 'fable'] as const

const BITS = [
  ['thinking', 'thinking'],
  ['adaptive_thinking', 'adaptive thinking'],
  ['interleaved_thinking', 'interleaved thinking'],
] as const

const ROLE_WORD: Readonly<Record<ProviderModel['role'], string>> = {
  main: '主模型',
  fast: '快速模型',
  extra: '其他',
}

const SEND_WORD = {
  auto: '自动 · 按模型族',
  always: '总是发送',
  never: '不发送',
} as const

/** The three checks, each with what it costs (§6.3.5). */
/** The 保存并切换 rule, as the page says it before anything is pressed. */
const SWITCH_RULE_LINE = '保存并切换要求本页测连可用 · 或勾选跳过测连'

const CHECKS = [
  ['auth', '测连', '验证地址和密钥 · 不产生费用'],
  ['latency', '测速', '网络往返 · 不含推理'],
  ['call', '真实调用', '走完整线路发一次最小请求 · 会产生一次计费调用'],
] as const

// ---------------------------------------------------------------------------
// Follow-up 4: may the OpenAI Chat lane ask for 总是发送
// ---------------------------------------------------------------------------

interface ChatGate {
  readonly open: boolean
  /** Why not, when it is closed. */
  readonly reason: string
}

/**
 * Whether `always` is on offer for the OpenAI Chat lane, from what the nodes
 * reported (`capabilities.chatEffortHonorsOverride`) and nothing else.
 *
 * The nodes asked are the ones whose expected profile is this one; a profile
 * no node uses yet asks every node that has reported. Every one asked must say
 * yes — one that cannot send it would refuse the apply (`effort-unsendable`).
 * No report at all is a closed gate with the reason, not a guess.
 */
function chatAlwaysGate(
  overview: ProviderOverview | null,
  profileId: string | null,
): ChatGate {
  const nodes = overview?.nodes ?? []
  const using =
    profileId === null
      ? []
      : nodes.filter(node => node.expected?.profileId === profileId)
  const asked = (using.length > 0 ? using : nodes).filter(
    node => node.actual !== null,
  )
  if (asked.length === 0) {
    return {
      open: false,
      reason: 'OpenAI Chat 线路的总是发送要等节点报告能力 · 先刷新节点状态',
    }
  }
  const unable = asked
    .filter(node => node.actual?.capabilities.chatEffortHonorsOverride !== true)
    .map(node => node.node)
  if (unable.length > 0) {
    return {
      open: false,
      reason: `节点 ${unable.join(' ')} 报告 OpenAI Chat 线路发不了显式 effort · 总是发送不可选`,
    }
  }
  return { open: true, reason: '' }
}

// ---------------------------------------------------------------------------
// The preset grid (§6.3.2 step 1)
// ---------------------------------------------------------------------------

function matches(preset: ProviderPresetView, query: string): boolean {
  if (query === '') return true
  const needle = query.toLowerCase()
  return [preset.id, preset.name, preset.vendor].some(text =>
    text.toLowerCase().includes(needle),
  )
}

/** 「已评估」带上何时、谁、证据（title）；没有证据就是「未评估」。 */
function evaluatedTag(evaluated: ProviderPresetView['evaluated']): string {
  if (evaluated === false) return tag('未评估', 'warn')
  return tag(
    '已评估',
    'ok',
    `${evaluated.at} · ${evaluated.by} · ${evaluated.evidence}`,
  )
}

function presetCard(preset: ProviderPresetView): string {
  const main = preset.models.find(model => model.role === 'main')
  return (
    `<a class="card elev-sm prov-preset" href="/providers/new?preset=${attr(
      encodeURIComponent(preset.id),
    )}" data-nav data-preset="${attr(preset.id)}">` +
    `<span class="prov-preset-name">${escapeHtml(preset.name)}</span>` +
    `<span class="card-meta">${escapeHtml(preset.vendor)} · ${escapeHtml(
      laneWord(preset.lane),
    )}</span>` +
    `<span class="tags">${tag(PLAN_WORD[preset.plan] ?? preset.plan)}${evaluatedTag(
      preset.evaluated,
    )}${preset.terms?.restricted === true ? tag('条款限制', 'warn') : ''}</span>` +
    `<span class="note mono">${escapeHtml(main?.id ?? '模型自填')}</span>` +
    `</a>`
  )
}

/** `/providers/new`: the presets in their five groups, searched by `?q=`. */
export function renderPresetGrid(
  catalog: ProviderCatalog,
  query: string,
): string {
  const q = query.trim()
  const listed = catalog.presets.filter(
    preset => preset.listed && matches(preset, q),
  )
  const search =
    `<form class="prov-search" method="get" action="/providers/new" role="search">` +
    `<div class="field"><label for="prov-q">搜索预设</label>` +
    `<input class="input" type="search" id="prov-q" name="q" value="${attr(
      q,
    )}" placeholder="厂商或服务名" autocomplete="off" spellcheck="false"></div>` +
    `<button type="submit" class="btn btn-secondary">搜索</button>` +
    (q === ''
      ? ''
      : `<a class="btn btn-ghost" href="/providers/new" data-nav>清除</a>`) +
    `</form>`
  const groups = catalog.groups
    .map(group => {
      const presets = listed.filter(preset => preset.group === group)
      if (presets.length === 0) return ''
      return (
        `<section class="sec" aria-labelledby="h-group-${attr(group)}">` +
        sectionHead(group, GROUP_WORD[group] ?? group, {
          headingId: `h-group-${group}`,
          sub: true,
        }) +
        `<div class="prov-grid">${presets.map(presetCard).join('')}</div>` +
        `</section>`
      )
    })
    .join('')
  return (
    `<div class="prov-editor">` +
    `<p class="note">选好预设后只需填写密钥 · 卡片只有文字 · 全部预设都未经真 key 评估</p>` +
    search +
    (groups === '' ? hint('没有匹配的预设 · 换个关键词或选自定义') : groups) +
    `</div>`
  )
}

/** A preset, for a reader who may not create one. */
export function renderPresetReadOnly(preset: ProviderPresetView): string {
  return (
    `<section class="card elev-sm prov-editor">` +
    `<div class="card-meta">${escapeHtml(preset.vendor)} · ${escapeHtml(
      laneWord(preset.lane),
    )}</div>` +
    `<div class="prov-kvs">` +
    kvText('计费', PLAN_WORD[preset.plan] ?? preset.plan) +
    kvText('地址', baseUrlFor({ baseUrl: preset.baseUrl }, false)) +
    kvText(
      '模型',
      preset.models.length === 0
        ? '新增时自填'
        : preset.models.map(model => model.id).join(' '),
    ) +
    `</div>` +
    `<p class="note">新增模型服务需要运维角色的个人账号</p>` +
    `</section>`
  )
}

// ---------------------------------------------------------------------------
// The form
// ---------------------------------------------------------------------------

export interface EditorModel {
  readonly mode: 'create' | 'edit'
  readonly profile: ProviderProfileView
  /** The preset it came from, when there is one in the catalog. */
  readonly preset: ProviderPresetView | undefined
  readonly catalog: ProviderCatalog
  readonly overview: ProviderOverview | null
  /** The stored profile's summary (key state, nodes), when editing. */
  readonly summary: ProviderProfileSummary | undefined
  readonly now: number
}

function option(value: string, label: string, selected: boolean): string {
  return `<option value="${attr(value)}"${selected ? ' selected' : ''}>${escapeHtml(
    label,
  )}</option>`
}

function select(attrs: string, options: string): string {
  return `<span class="sel"><select class="input" ${attrs}>${options}</select>${chevron()}</span>`
}

function check(attrs: string, label: string, checked: boolean): string {
  return `<label class="chk"><input type="checkbox" ${attrs}${
    checked ? ' checked' : ''
  }><span class="bx">${icon('check', { small: true })}</span>${escapeHtml(
    label,
  )}</label>`
}

/** One model of the table. `null` draws the empty one the template clones. */
function modelBlock(
  model: ProviderModel | null,
  lane: string,
  gate: ChatGate,
): string {
  const send = model?.effort.send ?? 'auto'
  const caps = model?.capabilities
  const explicit = caps?.mode === 'explicit' ? caps : undefined
  const levels = new Set(model?.effort.levels ?? [])
  const tiers = new Set(model?.tiers ?? ['opus', 'sonnet', 'haiku'])
  const governed = familyGoverned(model)
  const chatClosed = lane === 'openai-chat' && !gate.open
  const noAlways = lane === 'gemini' || lane === 'grok'
  const sends = (['auto', 'always', 'never'] as const)
    .map(value => {
      const off = value === 'always' && (chatClosed || noAlways)
      return (
        `<option value="${value}"${send === value ? ' selected' : ''}` +
        `${value === 'always' ? ' data-chat-gate' : ''}` +
        `${value !== 'auto' ? ' data-explicit' : ''}${off ? ' disabled' : ''}>` +
        `${escapeHtml(SEND_WORD[value])}</option>`
      )
    })
    .join('')
  return (
    `<div class="prov-model" data-model>` +
    `<label class="field"><span>模型 id</span>` +
    `<input class="input mono" data-f="id" list="prov-model-list" value="${attr(
      model?.id ?? '',
    )}" autocomplete="off" spellcheck="false" placeholder="例如 deepseek-v4-pro"></label>` +
    `<label class="field"><span>角色</span>` +
    select(
      'data-f="role"',
      (['main', 'fast', 'extra'] as const)
        .map(role =>
          option(role, ROLE_WORD[role], (model?.role ?? 'main') === role),
        )
        .join(''),
    ) +
    `</label>` +
    `<div class="field"><span>档位</span><div class="chips">` +
    TIERS.map(tier =>
      check(`data-f="tier" value="${tier}"`, tier, tiers.has(tier)),
    ).join('') +
    `</div></div>` +
    `<label class="field"><span>effort</span>` +
    select('data-f="send"', sends) +
    `</label>` +
    `<label class="field"><span>默认档位</span>` +
    select(
      'data-f="level"',
      option('', '不指定', model?.effort.level === undefined) +
        EFFORT_LEVELS.map(level =>
          option(level, level, model?.effort.level === level),
        ).join(''),
    ) +
    `</label>` +
    `<div class="field" data-when="explicit"${send === 'auto' ? ' hidden' : ''}>` +
    `<span>可选档位</span><div class="chips">` +
    EFFORT_LEVELS.map(level =>
      check(`data-f="levels" value="${level}"`, level, levels.has(level)),
    ).join('') +
    `</div></div>` +
    `<div class="field" data-when="explicit"${send === 'auto' ? ' hidden' : ''}>` +
    `<span>显式能力</span><div class="chips">` +
    BITS.map(([bit, label]) =>
      check(
        `data-f="bit" value="${bit}"`,
        label,
        explicit === undefined
          ? bit === 'thinking' && lane === 'anthropic'
          : explicit[bit],
      ),
    ).join('') +
    `</div></div>` +
    `<label class="field"><span>上下文窗口</span>` +
    `<input class="input mono" data-f="context" inputmode="numeric" autocomplete="off" value="${attr(
      model?.contextTokens === undefined ? '' : String(model.contextTokens),
    )}" placeholder="留空按 200000"></label>` +
    `<label class="field"><span>输出上限</span>` +
    `<input class="input mono" data-f="maxout" inputmode="numeric" autocomplete="off" value="${attr(
      model?.maxOutputTokens === undefined ? '' : String(model.maxOutputTokens),
    )}" placeholder="留空用节点默认"></label>` +
    `<input type="hidden" data-f="retire" value="${attr(model?.retireAt ?? '')}">` +
    `<p class="note prov-hint field-wide" data-family-note${
      governed ? '' : ' hidden'
    }>${escapeHtml(FAMILY_GOVERNED_LINE)}</p>` +
    `<div class="prov-model-acts">` +
    `<button type="button" class="btn btn-ghost btn-small" data-action="prov-model-remove" data-write>移除这个模型</button>` +
    `</div>` +
    `</div>`
  )
}

function compatRow(key: string, value: string): string {
  return (
    `<div class="prov-compat-row" data-compat>` +
    `<input class="input mono" data-f="ckey" value="${attr(key)}" aria-label="键名" ` +
    `autocomplete="off" spellcheck="false" placeholder="键名">` +
    `<input class="input mono" data-f="cval" value="${attr(value)}" aria-label="值" ` +
    `autocomplete="off" spellcheck="false" placeholder="值">` +
    `<button type="button" class="btn btn-ghost btn-small" data-action="prov-compat-remove" data-write>移除</button>` +
    `</div>`
  )
}

/** Whether the profile differs from what its preset would start it as. */
function departsFromPreset(
  profile: ProviderProfileView,
  preset: ProviderPresetView | undefined,
): boolean {
  if (preset === undefined) return true
  if (preset.group === 'custom' || preset.group === 'local') return true
  if (profile.lane !== preset.lane) return true
  const site = preset.sites.find(entry => entry.id === profile.site)
  if (profile.baseUrl !== (site?.baseUrl ?? preset.baseUrl)) return true
  if (JSON.stringify(profile.models) !== JSON.stringify(preset.models))
    return true
  if (JSON.stringify(profile.compat ?? {}) !== JSON.stringify(preset.compat)) {
    return true
  }
  return (profile.effortLock ?? null) !== null
}

/** The node a check runs on by default (§6.3.2 step 5). */
function probeNodes(
  overview: ProviderOverview | null,
  profileId: string,
): { readonly nodes: readonly ProviderNodeView[]; readonly first: string } {
  const nodes = overview?.nodes ?? []
  const reachable = (node: ProviderNodeView) => node.lastStatus?.ok === true
  const preferred =
    nodes.find(
      node => node.expected?.profileId === profileId && reachable(node),
    ) ??
    nodes.find(node => node.assignment.mode === 'inherit' && reachable(node)) ??
    nodes.find(reachable) ??
    nodes[0]
  return { nodes, first: preferred?.node ?? '' }
}

function keySection(model: EditorModel): string {
  const { profile, preset, summary, mode } = model
  // P18.18: several keys are a list, each with its own controls.
  if (mode === 'edit' && profile.keys.length > 1) return keyList(profile)
  const keyId = profile.keys[0]?.id ?? 'k1'
  const placeholder = preset?.placeholderKey
  const keyHint = preset?.keyHint ?? null
  const status =
    mode === 'edit' && summary !== undefined
      ? `<p class="prov-key-state" id="prov-key-state">${keyState(summary, {
          writer: true,
          accountsOn: true,
        })}</p>`
      : ''
  const actions =
    mode === 'edit'
      ? `<div class="prov-actions">` +
        writeButton('prov-key-refill', '重新填写', {}) +
        (summary?.secrets[0]?.set === true
          ? writeButton(
              'prov-key-clear',
              '清除',
              { key: keyId },
              { danger: true },
            )
          : '') +
        addKeyButton(profile) +
        `</div>`
      : ''
  return (
    `<div class="field field-wide">` +
    `<label for="prov-key">密钥${mode === 'create' && placeholder === undefined ? '<em class="req">*</em>' : ''}</label>` +
    status +
    `<input class="input mono" type="password" id="prov-key" autocomplete="off" ` +
    `spellcheck="false" placeholder="${attr(
      mode === 'edit'
        ? '重新填写密钥 · 留空不改'
        : placeholder === undefined
          ? '粘贴密钥 · 保存后不再显示'
          : `本地服务可留空 · 留空时用 ${placeholder}`,
    )}">` +
    `<p class="note prov-hint" id="prov-key-hint" hidden></p>` +
    (keyHint === null
      ? ''
      : `<p class="note">常见前缀 ${escapeHtml(keyHint.display)} · 不符只提示不拦截</p>`) +
    (mode === 'edit'
      ? `<p class="note">${escapeHtml(`换密钥后要下发才生效 · ${CACHE_LINE}`)}</p>`
      : '') +
    actions +
    `</div>`
  )
}

function siteField(
  profile: ProviderProfileView,
  preset: ProviderPresetView | undefined,
): string {
  if (preset === undefined || preset.sites.length === 0) return ''
  return (
    `<div class="field"><label for="prov-site">站点</label>` +
    select(
      'id="prov-site"',
      preset.sites
        .map(
          site =>
            `<option value="${attr(site.id)}" data-base-url="${attr(
              site.baseUrl,
            )}"${site.id === profile.site ? ' selected' : ''}>${escapeHtml(
              site.label,
            )}</option>`,
        )
        .join(''),
    ) +
    `</div>`
  )
}

function templateFields(
  profile: ProviderProfileView,
  preset: ProviderPresetView | undefined,
): string {
  const vars = preset?.templateVars ?? []
  return vars
    .map(
      variable =>
        `<label class="field"><span>${escapeHtml(variable.label)}<em class="req">*</em></span>` +
        `<input class="input mono" data-template="${attr(variable.name)}" value="${attr(
          profile.templateValues?.[variable.name] ?? '',
        )}" autocomplete="off" spellcheck="false"></label>`,
    )
    .join('')
}

function termsNote(profile: ProviderProfileView): string {
  if (profile.terms?.restricted !== true) return ''
  return (
    `<p class="bar bar-warn prov-terms">${icon('alert-triangle', { small: true })}<span>` +
    escapeHtml(
      '套餐条款多限定用于交互式编程工具 · 远端智能体代为调用可能不符合条款 · 请对照官方条款自行判断',
    ) +
    `</span></p>` +
    (profile.terms.note === ''
      ? ''
      : `<p class="note">${escapeHtml(calm(profile.terms.note))}</p>`)
  )
}

function laneOptions(lane: string): string {
  return Object.entries(LANE_WORD)
    .map(([value, label]) => option(value, label, value === lane))
    .join('')
}

function advanced(model: EditorModel, gate: ChatGate): string {
  const { profile, preset } = model
  const open = departsFromPreset(profile, preset) || profile.models.length === 0
  const compat = Object.entries(profile.compat ?? {}).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string',
  )
  return (
    `<details class="adv" id="prov-adv"${open ? ' open' : ''}>` +
    `<summary>${chevron()}高级 · 线路 地址 模型 effort 与兼容开关</summary>` +
    `<div class="adv-body prov-adv-body">` +
    `<div class="field"><label for="prov-lane">线路</label>` +
    select('id="prov-lane"', laneOptions(profile.lane)) +
    `</div>` +
    `<div class="field field-wide"><label for="prov-base">Base URL</label>` +
    `<input class="input mono" id="prov-base" value="${attr(
      profile.baseUrl,
    )}" autocomplete="off" spellcheck="false" placeholder="https://"></div>` +
    `<div class="field"><label for="prov-auth">认证方式</label>` +
    select(
      'id="prov-auth"',
      option(
        'bearer',
        'Authorization Bearer',
        profile.auth.scheme === 'bearer',
      ) + option('x-api-key', 'x-api-key', profile.auth.scheme === 'x-api-key'),
    ) +
    `</div>` +
    `<div class="field"><label for="prov-lock">effort 上限</label>` +
    select(
      'id="prov-lock"',
      option('', '不限', (profile.effortLock ?? null) === null) +
        EFFORT_LEVELS.map(level =>
          option(level, level, profile.effortLock === level),
        ).join(''),
    ) +
    `</div>` +
    `<div class="field field-wide"><span class="flabel">模型</span>` +
    `<p class="note prov-hint" id="prov-chat-gate"${
      profile.lane === 'openai-chat' && !gate.open ? '' : ' hidden'
    }>${escapeHtml(gate.reason)}</p>` +
    `<p class="note">上下文窗口留空按 200000 · 节点指派的覆盖优先 · 节点上的实际值看下方在用节点</p>` +
    `<div class="prov-models" id="prov-models">` +
    profile.models
      .map(entry => modelBlock(entry, profile.lane, gate))
      .join('') +
    `</div>` +
    `<template id="prov-model-template">${modelBlock(
      null,
      profile.lane,
      gate,
    )}</template>` +
    `<datalist id="prov-model-list"></datalist>` +
    `<div class="prov-actions">` +
    writeButton('prov-model-add', '添加模型', {}) +
    `</div></div>` +
    `<div class="field field-wide"><span class="flabel">兼容开关</span>` +
    `<p class="note">只接受中枢认可的键 · 其余会被拒收</p>` +
    `<div class="prov-compat" id="prov-compat">` +
    compat.map(([key, value]) => compatRow(key, value)).join('') +
    `</div>` +
    `<template id="prov-compat-template">${compatRow('', '')}</template>` +
    `<div class="prov-actions">` +
    writeButton('prov-compat-add', '添加开关', {}) +
    `</div></div>` +
    `</div></details>`
  )
}

function checks(model: EditorModel): string {
  const { nodes, first } = probeNodes(model.overview, model.profile.id)
  const nodeSelect =
    nodes.length === 0
      ? `<p class="note">没有可用来测连的节点 · 用 --provider-local 或 --provider-ssh 登记</p>`
      : `<div class="field"><label for="prov-probe-node">在哪个节点上测</label>` +
        select(
          'id="prov-probe-node"',
          nodes
            .map(node => option(node.node, node.node, node.node === first))
            .join(''),
        ) +
        `</div>`
  return (
    `<section class="card elev-sm" aria-labelledby="h-prov-checks">` +
    `<div class="card-kicker" id="h-prov-checks">Checks</div>` +
    nodeSelect +
    `<ul class="prov-plan">` +
    CHECKS.map(
      ([mode, label, line]) =>
        `<li>${writeButton('prov-check', label, { mode })}<span class="note">${escapeHtml(
          line,
        )}</span></li>`,
    ).join('') +
    `<li>${writeButton('prov-models-fetch', '拉取模型列表', {})}` +
    `<span class="note">经节点向服务要模型列表 · 结果进模型 id 的下拉</span></li>` +
    `</ul>` +
    `<p class="prov-result" id="prov-probe-result" role="status" data-tone="muted"></p>` +
    `</section>`
  )
}

/**
 * For a pay-as-you-go preset, the key prefixes of the same vendor's plans: a
 * key that starts with one of them is very likely a plan key pasted against
 * the pay-as-you-go address (§6.6 前缀软提示). A hint, never a refusal.
 */
function planPrefixes(model: EditorModel): readonly string[] {
  const preset = model.preset
  if (preset === undefined || preset.plan !== 'paygo') return []
  const own = new Set(preset.keyHint?.prefixes ?? [])
  return model.catalog.presets
    .filter(entry => entry.vendor === preset.vendor && entry.plan === 'plan')
    .flatMap(entry => entry.keyHint?.prefixes ?? [])
    .filter(prefix => !own.has(prefix))
}

/** The profile form: create from a preset, or edit a stored one. */
export function renderEditor(model: EditorModel): string {
  const { profile, preset, mode } = model
  const gate = chatAlwaysGate(
    model.overview,
    mode === 'edit' ? profile.id : null,
  )
  const keyHint = preset?.keyHint ?? null
  const head =
    mode === 'edit'
      ? `<div class="rowx">${profileTags(profile)}` +
        (model.summary?.isDefault === true ? tag('全局默认', 'ok') : '') +
        `<span class="note">${escapeHtml(
          `${vendorOf(profile, model.catalog)} · 修订 ${profile.revision}`,
        )}</span></div>`
      : `<div class="rowx">${profileTags(profile)}<span class="note">${escapeHtml(
          `${preset?.vendor ?? '自定义'} · ${laneWord(profile.lane)}`,
        )}</span></div>`
  const identity =
    mode === 'create'
      ? `<label class="field"><span>标识 · 小写字母 数字与短横线</span>` +
        `<input class="input mono" id="prov-id" value="${attr(profile.id)}" ` +
        `autocomplete="off" spellcheck="false" maxlength="48"></label>`
      : kvText('标识', profile.id)
  const actions =
    `<div class="prov-actions">` +
    writeButton('prov-save', '保存', {}, { primary: true }) +
    writeButton('prov-save-switch', '保存并切换', {}) +
    check('id="prov-skip-probe" data-write', '跳过测连', false) +
    (mode === 'edit'
      ? (model.summary?.isDefault === true
          ? ''
          : writeButton('prov-default', '设为全局默认', {
              profile: profile.id,
              name: profile.name,
            })) +
        writeButton(
          'prov-delete',
          '删除',
          {
            profile: profile.id,
            name: profile.name,
            revision: String(profile.revision),
          },
          { danger: true },
        )
      : '') +
    `</div>` +
    // One sentence for the rule: the script turns this line itself into the
    // warning when 保存并切换 is pressed without a probe, never a second one.
    `<p class="note prov-rule" id="prov-switch-rule" role="status" data-tone="muted">${escapeHtml(
      SWITCH_RULE_LINE,
    )}</p>` +
    `<p class="prov-result" id="prov-result" role="status" data-tone="muted"></p>`
  return (
    `<section class="prov-editor" id="prov-editor" data-mode="${mode}" ` +
    `data-profile="${attr(profile.id)}" data-revision="${attr(
      String(profile.revision),
    )}" data-preset="${attr(profile.presetId ?? '')}" ` +
    `data-key-id="${attr(profile.keys[0]?.id ?? 'k1')}" ` +
    `data-keys="${attr(keysAttr(profile))}" ` +
    `data-placeholder-key="${attr(preset?.placeholderKey ?? '')}" ` +
    `data-key-prefixes="${attr(JSON.stringify(keyHint?.prefixes ?? []))}" ` +
    `data-key-pattern="${attr(keyHint?.pattern ?? '')}" ` +
    `data-key-display="${attr(keyHint?.display ?? '')}" ` +
    `data-plan-prefixes="${attr(JSON.stringify(planPrefixes(model)))}" ` +
    `data-chat-always="${gate.open ? '1' : '0'}" ` +
    `data-chat-reason="${attr(gate.reason)}">` +
    `<section class="card elev-sm" aria-labelledby="h-prov-basic">` +
    `<div class="card-kicker" id="h-prov-basic">Service</div>` +
    head +
    termsNote(profile) +
    `<div class="prov-field-row">` +
    `<label class="field"><span>名称</span><input class="input" id="prov-name" value="${attr(
      profile.name,
    )}" maxlength="40" autocomplete="off"></label>` +
    identity +
    siteField(profile, preset) +
    templateFields(profile, preset) +
    keySection(model) +
    `</div>` +
    `</section>` +
    advanced(model, gate) +
    checks(model) +
    actions +
    `</section>` +
    editorDialogs() +
    (mode === 'edit' ? keyDialogs() : '')
  )
}

/** The form's own confirmations; outside every polled region. */
function editorDialogs(): string {
  return (
    `<dialog class="dialog" id="prov-call-dialog" aria-labelledby="prov-call-title">` +
    `<div class="dlg-top"><span class="dlg-icon">${icon('alert-triangle')}</span>` +
    `<div class="dialog-title" id="prov-call-title">真实调用</div></div>` +
    `<div class="dialog-body"><p>将通过节点发送一次最小请求 · 会产生一次计费调用</p></div>` +
    `<div class="dialog-actions">` +
    `<button type="button" class="btn btn-secondary" data-action="confirm-cancel">取消</button>` +
    `<button type="button" class="btn btn-primary" data-action="confirm-prov-call" data-write>发送</button>` +
    `</div></dialog>` +
    `<dialog class="dialog" id="prov-clear-dialog" aria-labelledby="prov-clear-title">` +
    `<div class="dlg-top"><span class="dlg-icon">${icon('x')}</span>` +
    `<div class="dialog-title" id="prov-clear-title">清除密钥</div></div>` +
    `<div class="dialog-body"><p>密文随即从密文库删除 · 节点在下一次下发前仍用旧密钥</p></div>` +
    `<div class="dialog-actions">` +
    `<button type="button" class="btn btn-secondary" data-action="confirm-cancel">取消</button>` +
    `<button type="button" class="btn btn-danger" data-action="confirm-prov-clear" data-write>清除</button>` +
    `</div></dialog>`
  )
}

// ---------------------------------------------------------------------------
// One profile, for a reader who may not write
// ---------------------------------------------------------------------------

export function renderProfileReadOnly(model: {
  readonly profile: ProviderProfileView
  readonly summary: ProviderProfileSummary | undefined
  readonly catalog: ProviderCatalog
  readonly reader: ProvidersReader
}): string {
  const { profile, summary, catalog, reader } = model
  const main = mainModel(profile)
  return (
    `<section class="card elev-sm prov-editor" aria-labelledby="h-prov-profile">` +
    `<div class="card-kicker" id="h-prov-profile">Service</div>` +
    `<div class="rowx">${profileTags(profile)}` +
    (summary?.isDefault === true ? tag('全局默认', 'ok') : '') +
    `</div>` +
    `<div class="prov-kvs">` +
    kvText('厂商', vendorOf(profile, catalog)) +
    kvText('线路', laneWord(profile.lane)) +
    kvText('地址', baseUrlFor(profile, reader.writer)) +
    kvText('主模型', main?.id ?? '—') +
    kvText(
      '其他模型',
      profile.models
        .filter(entry => entry.role !== 'main')
        .map(entry => entry.id)
        .join(' ') || '—',
    ) +
    kv('密钥', summary === undefined ? '—' : keyState(summary, reader)) +
    kvText('修订', String(profile.revision)) +
    `</div>` +
    `</section>`
  )
}

// ---------------------------------------------------------------------------
// The nodes on one profile (polled)
// ---------------------------------------------------------------------------

/**
 * Every node that expects this profile or last committed it, with what the
 * node computed — the profile's context window is what was asked for, the
 * node's `effective` is what it got (D-8).
 */
export function renderProfileNodes(
  overview: ProviderOverview,
  id: string,
  reader: ProvidersReader,
  now: number,
): string {
  const nodes = overview.nodes.filter(
    node =>
      node.expected?.profileId === id || node.actual?.applied?.profileId === id,
  )
  // P18.18: several keys reach a node only if it said it rotates them.
  const several =
    (overview.profiles.find(entry => entry.profile.id === id)?.profile.keys
      .length ?? 0) > 1
  const body =
    nodes.length === 0
      ? hint('还没有节点用这份模型服务 · 切换到此服务或在节点上指派')
      : `<ul class="prov-recent prov-on">` +
        nodes
          .map(node => {
            const cells = effectiveCells(node.actual)
            const status = nodeState(node, now)
            return (
              `<li data-node="${attr(node.node)}">` +
              `<a class="mono" href="/providers/nodes/${attr(
                encodeURIComponent(node.node),
              )}" data-nav>${escapeHtml(node.node)}</a>` +
              state(status.tone, status.word) +
              `<span>${escapeHtml(cells.lane)}</span>` +
              `<span class="mono">${escapeHtml(cells.model)}</span>` +
              `<span>effort ${escapeHtml(cells.effort)}</span>` +
              `<span data-cell="context">上下文 ${escapeHtml(cells.context)}</span>` +
              (node.actual?.applied?.profileId === id
                ? nodeKeysLine(node.actual)
                : '') +
              (several && node.actual?.capabilities.multiKey === false
                ? `<span class="note">这台节点不支持多把密钥 · 下发会被拒</span>`
                : '') +
              (node.expected?.profileId === id
                ? ''
                : `<span class="note">已不再指派 · 仍在运行</span>`) +
              (reader.writer
                ? writeButton('prov-context', '改上下文窗口', {
                    node: node.node,
                    tokens:
                      node.contextOverride === null
                        ? ''
                        : String(node.contextOverride),
                  })
                : '') +
              `</li>`
            )
          })
          .join('') +
        `</ul>`
  return (
    `<section class="sec" id="prov-on" aria-labelledby="h-prov-on">` +
    sectionHead('Nodes', '在用节点', {
      headingId: 'h-prov-on',
      tail: `<span class="note">线路 模型 effort 与上下文取节点算出的值</span>`,
    }) +
    body +
    `</section>`
  )
}

// ---------------------------------------------------------------------------
// Import (§6.3.6)
// ---------------------------------------------------------------------------

export function renderImportPage(): string {
  return (
    `<section class="card elev-sm prov-editor" id="prov-import" aria-labelledby="h-prov-import">` +
    `<div class="card-kicker" id="h-prov-import">Import</div>` +
    `<p class="note">导入的档案不带密钥 · 一律未评估 · 有中枢不认识的键时整份拒绝 · 与现有档案撞 id 的要另起新 id</p>` +
    `<div class="field"><label for="prov-import-file">选择导出文件</label>` +
    `<input class="input" type="file" id="prov-import-file" accept="application/json,.json"></div>` +
    `<div class="field"><label for="prov-import-text">或粘贴内容</label>` +
    `<textarea class="input prov-import-text" id="prov-import-text" spellcheck="false" autocomplete="off"></textarea></div>` +
    `<div class="prov-actions">` +
    writeButton('prov-import-preview', '预览', {}, { primary: true }) +
    writeButton('prov-import-run', '导入', {}) +
    `</div>` +
    `<p class="prov-result" id="prov-import-result" role="status" data-tone="muted"></p>` +
    `<div id="prov-import-list"></div>` +
    `</section>`
  )
}

// ---------------------------------------------------------------------------
// The chat page (§6.3.8)
// ---------------------------------------------------------------------------

/** The node of a `qianmo://<node>/<agent>` address. */
function nodeOfAddress(address: string): string | null {
  const match = /^[a-z][a-z0-9+.-]*:\/\/([^/]+)\//i.exec(address)
  return match?.[1] ?? null
}

/**
 * What the chat page shows of the target's model: a label with the model the
 * node computed, and the switch the node last committed, to be drawn into the
 * transcript where it happened. Nothing at all when the target's node is not
 * one this console manages or has not reported — an empty answer, never a
 * guess from the hub's expectation.
 */
export function renderChatModel(
  overview: ProviderOverview,
  target: string,
  now: number,
): string {
  const name = nodeOfAddress(target)
  if (name === null) return ''
  const node = overview.nodes.find(entry => entry.node === name)
  if (node === undefined) return ''
  const cells = effectiveCells(node.actual)
  if (!cells.reported) return ''
  const label =
    `<span class="tag tag-neutral mono" id="prov-chat-label" data-node="${attr(
      name,
    )}" title="${attr(`节点 ${name} 当前生效的模型 · ${cells.lane}`)}">` +
    `${escapeHtml(`模型 · ${cells.model}`)}</span>`
  const applied = node.actual?.applied ?? null
  const at = applied === null ? Number.NaN : Date.parse(applied.at)
  if (applied === null || !Number.isFinite(at) || at > now) return label
  const profileName =
    overview.profiles.find(entry => entry.profile.id === applied.profileId)
      ?.profile.name ?? applied.profileId
  return (
    label +
    `<div class="prov-chat-divider" id="prov-chat-divider" data-at="${attr(
      String(at),
    )}" role="separator">` +
    `<span>${escapeHtml(`已切换到 ${profileName} · ${cells.model}`)}</span></div>`
  )
}
