// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 模型服务 (J1, `providers-console-m1.md` §6.3): the overview board, and the
 * vocabulary every page of the area shares.
 *
 * ## What a node is running is the node's answer, never ours
 *
 * The line, the model, whether effort goes on the wire and at what level,
 * the context window and the auto-compact window of a node are read from one
 * place: the `effective` block the node computed with its real gate functions
 * and reported in its last `status` (§2.4, §3.4 「显示 = 线上」). They pass
 * through {@link effectiveCells} and nothing else; that function reads
 * `actual.effective` and nothing else, and `providersPage.test.ts` holds it to
 * that with a recording proxy. When a node has not reported them the cell says
 * so — the hub's own idea of what the node should be running is never used to
 * fill the gap, because that is exactly the gap §0.2 fell into.
 *
 * ## Who sees what (§7.3)
 *
 * A writer is a personal `ops` account outside break-glass. Everyone else —
 * `viewer`, `member`, the admin token in break-glass, either legacy token —
 * reads which vendor, model, line and state, and sees a base URL as its host
 * only. Key fingerprints, full base URLs, the names of locally edited keys and
 * the recent apply and probe records are a writer's; so is every control.
 *
 * ## Words
 *
 * Every visible word is written here, in the console's register (` · `, no
 * full stop or comma). Text a node or the hub's validator produced goes
 * through {@link calm} before it reaches a page, and drift is described by its
 * kind rather than by the hub's sentence for it.
 */

import type {
  ProviderActivity,
  ProviderCatalog,
  ProviderDrift,
  ProviderFailure,
  ProviderNodeActual,
  ProviderNodeView,
  ProviderOverview,
  ProviderPresetView,
  ProviderProfileSummary,
  ProviderProfileView,
} from '../deps.js'
import {
  bar,
  chevron,
  hint,
  icon,
  sectionHead,
  state,
  tag,
  type Tone,
} from './bits.js'
import { attr, escapeHtml } from './escape.js'
import { formatRelative } from './format.js'

// ---------------------------------------------------------------------------
// The reader
// ---------------------------------------------------------------------------

/** Who a provider page is drawn for. */
export interface ProvidersReader {
  /** A personal `ops` account outside break-glass: controls, fingerprints, full URLs. */
  readonly writer: boolean
  /** Personal accounts are on: decides how the read-only line is worded. */
  readonly accountsOn: boolean
}

/** What a reader who may not write is told, once, in the top bar. */
const READ_ONLY_LINE = '只读 · 模型服务的写操作需要运维角色的个人账号'

export function readOnlyBadge(): string {
  return `<span class="note" id="read-only">${escapeHtml(READ_ONLY_LINE)}</span>`
}

/** Said where the write controls are, to a writer with script off (§6.7). */
const NO_SCRIPT_LINE =
  '保存 · 切换 · 测连 · 删除与导入需要启用脚本 · 阅读不受影响'

export function noScriptNote(): string {
  return `<noscript><p class="note prov-noscript">${escapeHtml(
    NO_SCRIPT_LINE,
  )}</p></noscript>`
}

/** No port behind the page: the console was started without `--providers`. */
const PROVIDERS_OFF_LINE =
  '模型服务未开启 · 启动控制台时加 --providers 与 --accounts'

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

/**
 * Text from a node or a validator, in the console's register: the full-width
 * stops become the ` · ` the rest of the page uses, so a sentence the page did
 * not write still reads like one it did.
 */
export function calm(text: string): string {
  return text
    .replace(/[。，、；：！!]+/g, ' · ')
    .replace(/\s*·\s*(·\s*)+/g, ' · ')
    .replace(/^\s*·\s*|\s*·\s*$/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

export const LANE_WORD: Readonly<Record<string, string>> = {
  anthropic: 'Anthropic Messages',
  'openai-chat': 'OpenAI Chat',
  'openai-responses': 'OpenAI Responses',
  gemini: 'Gemini 原生',
  grok: 'Grok',
}

/** `effective.wire` as the node reports it (`chat`, `responses`, …). */
const WIRE_WORD: Readonly<Record<string, string>> = {
  anthropic: 'Anthropic Messages',
  chat: 'OpenAI Chat',
  responses: 'OpenAI Responses',
  gemini: 'Gemini 原生',
  grok: 'Grok',
}

export const PLAN_WORD: Readonly<Record<string, string>> = {
  paygo: '按量',
  plan: '套餐',
  local: '本地',
  custom: '自定义',
}

export const GROUP_WORD: Readonly<Record<string, string>> = {
  'cn-paygo': '国内按量',
  intl: '国际',
  plan: '套餐',
  local: '本地',
  custom: '自定义',
}

const AUTO_COMPACT_SOURCE_WORD: Readonly<Record<string, string>> = {
  env: '环境变量',
  settings: '节点设置',
  auto: '自动',
}

export function laneWord(lane: string): string {
  return LANE_WORD[lane] ?? lane
}

/**
 * A token count the way the console writes one: `200k`, `1M`, or the digits
 * grouped by three when it is not a round number.
 */
export function tokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '—'
  if (n % 1_000_000 === 0) return `${n / 1_000_000}M`
  if (n % 1_000 === 0) return `${n / 1_000}k`
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
}

/** An ISO instant as `YYYY-MM-DD HH:MM`, local zone; the text itself when it is not one. */
export function minuteOf(iso: string): string {
  const at = Date.parse(iso)
  if (!Number.isFinite(at)) return iso
  const date = new Date(at)
  const pad = (value: number) => (value < 10 ? `0${value}` : String(value))
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`
  )
}

/** The 8 hex characters of a key fingerprint ops are shown (§6.3.3). */
export function shortFingerprint(fingerprint: string): string {
  const bare = fingerprint.startsWith('fp1:')
    ? fingerprint.slice(4)
    : fingerprint
  return bare.slice(0, 8)
}

/**
 * A base URL as a reader sees it: the whole of it for a writer, the host for
 * everyone else (§7.3). Template placeholders are filled from the profile's
 * own values first, so a reader sees the real host rather than `{region}`.
 */
export function baseUrlFor(
  profile: Pick<ProviderProfileView, 'baseUrl' | 'templateValues'>,
  writer: boolean,
): string {
  if (writer) return profile.baseUrl
  let resolved = profile.baseUrl
  for (const [name, value] of Object.entries(profile.templateValues ?? {})) {
    resolved = resolved.split(`{${name}}`).join(value)
  }
  try {
    return new URL(resolved).host
  } catch {
    return '—'
  }
}

/** The main model of a profile, or `undefined` for a profile with none yet. */
export function mainModel(
  profile: Pick<ProviderProfileView, 'models'>,
): ProviderProfileView['models'][number] | undefined {
  return profile.models.find(model => model.role === 'main')
}

/** Who makes a profile: the preset's vendor, or 自定义. */
export function vendorOf(
  profile: Pick<ProviderProfileView, 'presetId'>,
  catalog: ProviderCatalog,
): string {
  const preset =
    profile.presetId === null
      ? undefined
      : catalog.presets.find(entry => entry.id === profile.presetId)
  return preset?.vendor ?? '自定义'
}

function presetOf(
  catalog: ProviderCatalog,
  id: string | null,
): ProviderPresetView | undefined {
  return id === null
    ? undefined
    : catalog.presets.find(entry => entry.id === id)
}

/**
 * §4.1 rule 1 and the P18.12 parity table: a Claude model id on the
 * Anthropic lane (or the official host) is Anthropic's own catalog, whose
 * capability list the runtime does not read — the model family decides, so
 * an explicit `always` or `never` there is not what reaches the wire. The
 * console says so beside the control rather than letting the choice look
 * honoured (P18.9 follow-up 3).
 */
export function familyGoverned(
  lane: string,
  modelId: string,
  baseUrl: string,
): boolean {
  if (lane !== 'anthropic') return false
  if (modelId.toLowerCase().includes('claude')) return true
  try {
    return new URL(baseUrl).hostname === 'api.anthropic.com'
  } catch {
    return false
  }
}

export const FAMILY_GOVERNED_LINE =
  'Claude 系模型在 Anthropic 线上按内置模型族判断 · 该线路不受此设置控制'

// ---------------------------------------------------------------------------
// The node's own answer (§2.4 effective)
// ---------------------------------------------------------------------------

/** What a node reported it is running, in words; every cell from `effective`. */
interface EffectiveCells {
  /** False when the node has not reported `effective` at all. */
  readonly reported: boolean
  readonly lane: string
  readonly model: string
  /** The id the lane puts on the wire, when it differs from {@link model}. */
  readonly wireModel: string | null
  readonly effort: string
  readonly effortOn: boolean | null
  readonly context: string
  readonly contextTokens: number | null
  readonly autoCompact: string
  readonly autoCompactTokens: number | null
  readonly autoCompactSource: 'env' | 'settings' | 'auto' | null
  readonly slot: string | null
  readonly apiProvider: string
}

const NOT_REPORTED = '未报告'

/**
 * The only door from a node's report to a cell (AC-P4, the console half).
 * Reads `actual.effective` and nothing else — not the expected profile, not
 * the hub's assignment — so a value the node did not compute cannot appear.
 */
export function effectiveCells(
  actual: ProviderNodeActual | null,
): EffectiveCells {
  const effective = actual?.effective
  if (effective === undefined) {
    return {
      reported: false,
      lane: NOT_REPORTED,
      model: NOT_REPORTED,
      wireModel: null,
      effort: NOT_REPORTED,
      effortOn: null,
      context: NOT_REPORTED,
      contextTokens: null,
      autoCompact: NOT_REPORTED,
      autoCompactTokens: null,
      autoCompactSource: null,
      slot: null,
      apiProvider: NOT_REPORTED,
    }
  }
  const effort = !effective.effortOnWire
    ? '不发'
    : effective.effortLevel === 'none'
      ? '关闭推理'
      : (effective.effortLevel ?? '发送')
  const autoCompact =
    effective.autoCompactWindow === undefined
      ? NOT_REPORTED
      : `${tokens(effective.autoCompactWindow)}` +
        (effective.autoCompactSource === undefined
          ? ''
          : ` · ${AUTO_COMPACT_SOURCE_WORD[effective.autoCompactSource] ?? effective.autoCompactSource}`)
  return {
    reported: true,
    lane: WIRE_WORD[effective.wire] ?? effective.wire,
    model: effective.model,
    wireModel:
      effective.wireModel !== effective.model ? effective.wireModel : null,
    effort,
    effortOn: effective.effortOnWire,
    context: tokens(effective.contextTokens),
    contextTokens: effective.contextTokens,
    autoCompact,
    autoCompactTokens: effective.autoCompactWindow ?? null,
    autoCompactSource: effective.autoCompactSource ?? null,
    slot: effective.modelSettingsSlot,
    apiProvider: effective.apiProvider,
  }
}

/** Where a node's context window is meant to come from (D-8), from the hub's own records. */
export function contextSource(
  node: Pick<ProviderNodeView, 'contextOverride' | 'expected'>,
  profile: Pick<ProviderProfileView, 'models'> | undefined,
): string {
  if (node.expected === null) return '节点本地配置'
  if (node.contextOverride !== null) return '节点覆盖'
  const main = profile === undefined ? undefined : mainModel(profile)
  return main?.contextTokens === undefined ? '默认 200k' : '档案'
}

// ---------------------------------------------------------------------------
// Drift (§2.4), in the page's words
// ---------------------------------------------------------------------------

/** A pending switch older than this is a warning (R-6: 30 min, no forced kill). */
const PENDING_ALARM_MS = 30 * 60 * 1000

interface DriftWords {
  readonly tone: Tone
  readonly word: string
  readonly line: string
}

function driftWords(
  drift: ProviderDrift,
  actual: ProviderNodeActual | null,
  now: number,
): DriftWords {
  switch (drift.kind) {
    case 'unmanaged':
      return {
        tone: 'warn',
        word: '待接管',
        line: '节点上还没有托管的配置 · 首次下发即接管 · 节点会先备份原配置',
      }
    case 'out-of-sync':
      return {
        tone: 'warn',
        word: '待下发',
        line: '期望与节点上已生效的配置不同 · 需要下发',
      }
    case 'pending': {
      const since = Date.parse(actual?.pending?.since ?? '')
      const turns = actual?.pending?.waitingTurns ?? null
      if (Number.isFinite(since) && now - since >= PENDING_ALARM_MS) {
        return {
          tone: 'bad',
          word: '等待超时',
          line:
            `已等待 ${Math.floor((now - since) / 60_000)} 分钟` +
            (turns === null ? '' : ` · 节点仍有 ${turns} 个进行中的对话`) +
            ' · 未强制切换',
        }
      }
      return {
        tone: 'warn',
        word: '等待空闲',
        line:
          '已下发 · 节点空闲时切换' +
          (turns === null ? '' : ` · 进行中的对话 ${turns} 个`) +
          (Number.isFinite(since) ? ` · ${formatRelative(since, now)}` : ''),
      }
    }
    case 'local-edit':
      return {
        tone: 'bad',
        word: '本地改动',
        line: '节点上的配置在上次下发后被改过 · 覆盖或停止托管',
      }
    case 'not-loaded':
      return actual?.resident?.running === true
        ? {
            tone: 'warn',
            word: '待加载',
            line: '已写入 · 等待下一代子进程加载',
          }
        : {
            tone: 'muted',
            word: '节点未运行',
            line: '已写入 · 节点未运行 · 下次启动时加载',
          }
    case 'env-residue':
      return {
        tone: 'muted',
        word: '环境残留',
        line: '节点进程环境里还有旧的模型变量 · 子进程已剥离 · 下次重启后消失',
      }
    case 'unreachable':
      return {
        tone: 'bad',
        word: '不可达',
        line: '最近一次状态刷新失败 · 下面是上一次成功时的状态 · 已过期',
      }
    case 'retiring-model':
      return {
        tone: 'warn',
        word: '模型将下线',
        line: '档案里有模型已下线或 14 天内下线 · 请换用替代模型',
      }
  }
}

/** Strongest first: the badge a node's row carries is its worst drift. */
const DRIFT_RANK: Readonly<Record<ProviderDrift['kind'], number>> = {
  unreachable: 0,
  'local-edit': 1,
  pending: 2,
  'out-of-sync': 3,
  unmanaged: 4,
  'not-loaded': 5,
  'retiring-model': 6,
  'env-residue': 7,
}

/** One node's state in a word, from its drift. */
export function nodeState(
  node: ProviderNodeView,
  now: number,
): { readonly tone: Tone; readonly word: string } {
  const worst = [...node.drift].sort(
    (a, b) => DRIFT_RANK[a.kind] - DRIFT_RANK[b.kind],
  )[0]
  if (worst !== undefined) {
    const words = driftWords(worst, node.actual, now)
    return { tone: words.tone, word: words.word }
  }
  if (node.expected === null) return { tone: 'muted', word: '未托管' }
  if (node.actual === null) return { tone: 'muted', word: '尚未刷新' }
  return { tone: 'ok', word: '已生效' }
}

/** Every drift of a node, one line each, with the key names for a writer. */
export function driftList(
  node: ProviderNodeView,
  reader: ProvidersReader,
  now: number,
): string {
  if (node.drift.length === 0) {
    return node.expected === null
      ? `<p class="note">未托管 · 当前由节点本地配置决定</p>`
      : ''
  }
  return (
    `<ul class="prov-drift">` +
    node.drift
      .map(drift => {
        const words = driftWords(drift, node.actual, now)
        const keys =
          reader.writer && drift.keys !== undefined && drift.keys.length > 0
            ? `<span class="prov-keys mono">${drift.keys
                .map(key => escapeHtml(key))
                .join(' ')}</span>`
            : ''
        return (
          `<li data-drift="${attr(drift.kind)}">` +
          state(words.tone, words.word) +
          `<span class="note">${escapeHtml(words.line)}</span>` +
          keys +
          `</li>`
        )
      })
      .join('') +
    `</ul>`
  )
}

// ---------------------------------------------------------------------------
// Cells shared by the board and the node page
// ---------------------------------------------------------------------------

function kv(label: string, value: string): string {
  return (
    `<div class="kv"><span class="k">${escapeHtml(label)}</span>` +
    `<span class="v">${value}</span></div>`
  )
}

export function kvText(label: string, value: string): string {
  return kv(label, escapeHtml(value))
}

/** The expected half of a node: which profile, at which revision, or not managed. */
export function expectedText(
  node: ProviderNodeView,
  names: ReadonlyMap<string, string>,
): string {
  if (node.expected === null) {
    return node.assignment.mode === 'unmanaged' ? '不托管' : '未托管'
  }
  const name = names.get(node.expected.profileId) ?? node.expected.profileId
  const how = node.assignment.mode === 'inherit' ? '默认' : '单独指定'
  return `${name} · r${node.expected.revision} · ${how}`
}

/** The actual half: what the node says it last committed. */
export function appliedText(
  actual: ProviderNodeActual | null,
  names: ReadonlyMap<string, string>,
): string {
  if (actual === null) return '尚未刷新'
  if (!actual.managed || actual.applied === null) return '节点本地配置'
  const name = names.get(actual.applied.profileId) ?? actual.applied.profileId
  return `${name} · r${actual.applied.revision}`
}

/** The latest probe of a node, from the hub's book. */
function lastProbe(recent: readonly ProviderActivity[], now: number): string {
  const probe = recent.find(entry => entry.kind === 'probe')
  if (probe === undefined) return '—'
  return `${probe.outcome === 'ok' ? '可用' : '失败'} · ${formatRelative(
    probe.at,
    now,
  )}`
}

const ACTIVITY_OUTCOME: Readonly<Record<string, readonly [Tone, string]>> = {
  ok: ['ok', '成功'],
  refused: ['warn', '被拒'],
  failed: ['bad', '失败'],
}

const PROBE_MODE_WORD: Readonly<Record<string, string>> = {
  auth: '测连',
  latency: '测速',
  call: '真实调用',
}

/** §6.3.8 「最近 10 次下发与测连记录」: a writer's. */
export function recentList(
  recent: readonly ProviderActivity[],
  names: ReadonlyMap<string, string>,
  now: number,
): string {
  if (recent.length === 0) return hint('还没有下发与测连记录')
  return (
    `<ul class="prov-recent">` +
    recent
      .map(entry => {
        const [tone, word] = ACTIVITY_OUTCOME[entry.outcome] ?? ['muted', '']
        const what =
          entry.kind === 'apply'
            ? entry.force === true
              ? '覆盖下发'
              : '下发'
            : (PROBE_MODE_WORD[entry.mode ?? 'auth'] ?? '测连')
        return (
          `<li data-key="${attr(entry.requestId)}">` +
          `<span class="mono">${escapeHtml(formatRelative(entry.at, now))}</span>` +
          `<span>${escapeHtml(what)}</span>` +
          `<span>${escapeHtml(names.get(entry.profileId) ?? entry.profileId)}</span>` +
          state(tone, word) +
          (entry.code === undefined
            ? ''
            : `<code class="bar-code">${escapeHtml(entry.code)}</code>`) +
          `<span class="note mono">${escapeHtml(entry.requestId)}</span>` +
          `</li>`
        )
      })
      .join('') +
    `</ul>`
  )
}

/** Every field of `effective` (§6.3.8 「effective 的全部字段」). */
export function effectiveFields(actual: ProviderNodeActual | null): string {
  const cells = effectiveCells(actual)
  if (!cells.reported) {
    return `<p class="note">节点没有报告生效值 · 刷新后再看</p>`
  }
  return (
    `<div class="prov-kvs" data-effective>` +
    kvText('调用方', cells.apiProvider) +
    kvText('线路', cells.lane) +
    kvText('模型', cells.model) +
    kvText('线上模型名', cells.wireModel ?? cells.model) +
    kvText('生效槽位', cells.slot ?? '—') +
    kvText('effort', cells.effort) +
    kvText('上下文窗口', cells.context) +
    kvText('自动压缩阈值', cells.autoCompact) +
    `</div>`
  )
}

/** A failure from the port, as a strip; the hub's words calmed. */
export function providerFailureBar(failure: ProviderFailure): string {
  const lead =
    failure.code === 'unavailable'
      ? '模型服务已停用'
      : failure.code === 'unreachable'
        ? '节点不可达'
        : '模型服务出错'
  const tail =
    failure.code === 'unavailable' ? ' · 节点继续使用上次下发的配置' : ''
  return (
    `<p class="bar bar-bad" role="alert" id="prov-failure">` +
    icon('alert-triangle', { small: true }) +
    `<span>${escapeHtml(`${lead} · ${calm(failure.message)}${tail}`)}</span>` +
    `<code class="bar-code">${escapeHtml(failure.code)}</code></p>`
  )
}

// ---------------------------------------------------------------------------
// The board (/providers)
// ---------------------------------------------------------------------------

/** Profile id → display name, for the cells that name a profile. */
export function namesOf(
  profiles: readonly ProviderProfileSummary[],
): ReadonlyMap<string, string> {
  return new Map(profiles.map(entry => [entry.profile.id, entry.profile.name]))
}

/** A button that only a writer sees. Every write control carries `data-write`. */
export function writeButton(
  action: string,
  label: string,
  data: Readonly<Record<string, string>>,
  options: { readonly danger?: boolean; readonly primary?: boolean } = {},
): string {
  const cls =
    options.primary === true
      ? 'btn btn-primary btn-small'
      : options.danger === true
        ? 'btn btn-ghost btn-danger btn-small'
        : 'btn btn-secondary btn-small'
  const attrs = Object.entries(data)
    .map(([key, value]) => ` data-${key}="${attr(value)}"`)
    .join('')
  return (
    `<button type="button" class="${cls}" data-action="${attr(action)}"` +
    `${attrs} data-write>${escapeHtml(label)}</button>`
  )
}

/**
 * A write control that is a link when no script has claimed it: the node tab
 * is also embedded in `/nodes/<node>` (P18.11), whose page carries no script
 * of this area, so there the control takes the writer to the page that does
 * (`href`), and here the page script handles the click instead.
 */
export function writeLink(
  action: string,
  label: string,
  href: string,
  data: Readonly<Record<string, string>>,
  options: { readonly danger?: boolean; readonly primary?: boolean } = {},
): string {
  const cls =
    options.primary === true
      ? 'btn btn-primary btn-small'
      : options.danger === true
        ? 'btn btn-ghost btn-danger btn-small'
        : 'btn btn-secondary btn-small'
  const attrs = Object.entries(data)
    .map(([key, value]) => ` data-${key}="${attr(value)}"`)
    .join('')
  return (
    `<a class="${cls}" href="${attr(href)}" data-action="${attr(action)}"` +
    `${attrs} data-write>${escapeHtml(label)}</a>`
  )
}

/**
 * The effort a profile asks of its main model against what the node computed,
 * when they disagree: the line is family-governed (follow-up 3) or the node's
 * code does not honour it. Only for a node that is running this revision.
 */
function effortMismatch(
  node: ProviderNodeView,
  profile: ProviderProfileView | undefined,
): boolean {
  const cells = effectiveCells(node.actual)
  const applied = node.actual?.applied
  if (
    !cells.reported ||
    profile === undefined ||
    applied === null ||
    applied === undefined ||
    applied.profileId !== profile.id ||
    applied.revision !== profile.revision ||
    node.actual?.pending !== null
  ) {
    return false
  }
  const send = mainModel(profile)?.effort.send
  return (
    (send === 'never' && cells.effortOn === true) ||
    (send === 'always' && cells.effortOn === false)
  )
}

/** One node of the matrix: a summary row and, under it, everything about it. */
function nodeRow(
  node: ProviderNodeView,
  profiles: ReadonlyMap<string, ProviderProfileView>,
  names: ReadonlyMap<string, string>,
  reader: ProvidersReader,
  now: number,
): string {
  const cells = effectiveCells(node.actual)
  const status = nodeState(node, now)
  const expectedProfile =
    node.expected === null ? undefined : profiles.get(node.expected.profileId)
  const mismatch = effortMismatch(node, expectedProfile)
  const stale = node.lastStatus !== null && !node.lastStatus.ok
  const local = node.drift.find(drift => drift.kind === 'local-edit')
  const name = attr(node.node)
  const actions = reader.writer
    ? `<div class="row-acts">` +
      writeButton(
        'prov-apply',
        '下发',
        { node: node.node },
        { primary: true },
      ) +
      (node.expected === null
        ? ''
        : writeButton('prov-probe', '测连', {
            node: node.node,
            profile: node.expected.profileId,
          })) +
      (node.expected === null
        ? ''
        : writeButton('prov-diff', '查看差异', { node: node.node })) +
      writeButton('prov-assign', '指派', {
        node: node.node,
        mode: node.assignment.mode,
        profile:
          node.assignment.mode === 'profile' ? node.assignment.profileId : '',
      }) +
      writeButton('prov-context', '改上下文窗口', {
        node: node.node,
        tokens:
          node.contextOverride === null ? '' : String(node.contextOverride),
      }) +
      writeButton('prov-autocompact', '改自动压缩阈值', { node: node.node }) +
      writeButton('prov-refresh', '刷新', { node: node.node }) +
      (local === undefined
        ? ''
        : writeButton('prov-force', '覆盖节点上的改动', {
            node: node.node,
            keys: (local.keys ?? []).join(' '),
          }) +
          writeButton(
            'prov-unmanage',
            '停止托管',
            { node: node.node },
            { danger: true },
          )) +
      `</div>`
    : ''
  return (
    `<details class="row prov-row" data-key="node:${name}" data-node="${name}"` +
    ` data-state="${attr(status.word)}">` +
    `<summary>` +
    `<span class="prov-node mono">${escapeHtml(node.node)}</span>` +
    `<span class="prov-cell" data-cell="expected">${escapeHtml(
      expectedText(node, names),
    )}<span class="note">${escapeHtml(appliedText(node.actual, names))}</span></span>` +
    `<span class="prov-cell" data-cell="state">${state(status.tone, status.word)}` +
    (stale ? `<span class="note">已过期</span>` : '') +
    `</span>` +
    `<span class="prov-cell" data-cell="lane">${escapeHtml(cells.lane)}</span>` +
    `<span class="prov-cell mono" data-cell="model"${
      cells.wireModel === null ? '' : ` title="${attr(cells.wireModel)}"`
    }>${escapeHtml(cells.model)}</span>` +
    `<span class="prov-cell" data-cell="effort">${escapeHtml(cells.effort)}` +
    (mismatch ? `<span class="note">与档案不同</span>` : '') +
    `</span>` +
    `<span class="prov-cell" data-cell="context"${
      cells.contextTokens === null
        ? ''
        : ` title="${attr(String(cells.contextTokens))}"`
    }>${escapeHtml(cells.context)}</span>` +
    `<span class="prov-cell note" data-cell="probe">${escapeHtml(
      lastProbe(node.recent, now),
    )}</span>` +
    chevron() +
    `</summary>` +
    `<div class="row-panel prov-panel">` +
    driftList(node, reader, now) +
    (mismatch
      ? `<p class="note" data-family-governed>${escapeHtml(
          `节点算出的 effort 与档案的设置相反 · ${FAMILY_GOVERNED_LINE}`,
        )}</p>`
      : '') +
    effectiveFields(node.actual) +
    `<div class="prov-kvs">` +
    kvText(
      '上下文来源',
      `${contextSource(node, expectedProfile)}` +
        (node.contextOverride === null
          ? ''
          : ` · 覆盖 ${tokens(node.contextOverride)}`),
    ) +
    kvText('执行方式', node.executor === 'ssh' ? 'SSH 强制命令' : '本机') +
    kvText(
      '状态刷新',
      node.lastStatus === null
        ? '尚未刷新'
        : `${node.lastStatus.ok ? '成功' : '失败'} · ${formatRelative(
            node.lastStatus.at,
            now,
          )}`,
    ) +
    `</div>` +
    `<p class="note"><a href="/providers/nodes/${attr(
      encodeURIComponent(node.node),
    )}" data-nav>节点详情</a></p>` +
    actions +
    `</div></details>`
  )
}

/** The matrix's column heads, on the same grid as its rows. */
function matrixHead(): string {
  return (
    `<div class="prov-head" aria-hidden="true">` +
    [
      '节点',
      '期望 · 实际',
      '状态',
      '线路',
      '模型',
      'effort',
      '上下文',
      '最近测连',
    ]
      .map(label => `<span>${escapeHtml(label)}</span>`)
      .join('') +
    `<span></span></div>`
  )
}

/** §6.3.1 the node matrix; `only` narrows it to one node (`?node=`). */
function matrix(
  overview: ProviderOverview,
  reader: ProvidersReader,
  now: number,
  only: string | undefined,
): string {
  const names = namesOf(overview.profiles)
  const profiles = new Map(
    overview.profiles.map(entry => [entry.profile.id, entry.profile]),
  )
  const nodes =
    only === undefined
      ? overview.nodes
      : overview.nodes.filter(node => node.node === only)
  const narrowed =
    only === undefined
      ? ''
      : `<p class="note">只看节点 ${escapeHtml(only)} · ` +
        `<a href="/providers" data-nav>查看全部</a></p>`
  const body =
    nodes.length === 0
      ? hint(
          only === undefined
            ? '这台控制台没有可下发的节点 · 用 --provider-local 或 --provider-ssh 登记'
            : '没有这个节点',
        )
      : `<div class="prov-matrix" id="prov-matrix">` +
        matrixHead() +
        nodes
          .map(node => nodeRow(node, profiles, names, reader, now))
          .join('') +
        `</div>`
  const drifted = overview.nodes.filter(node => node.drift.length > 0).length
  return (
    `<section class="sec" id="prov-nodes" aria-labelledby="h-prov-nodes">` +
    sectionHead('Nodes', '节点', {
      headingId: 'h-prov-nodes',
      tail: `<span class="note">${escapeHtml(
        `${overview.nodes.length} 个节点 · 有漂移 ${drifted} 个 · effort 与上下文取节点算出的值`,
      )}</span>`,
    }) +
    narrowed +
    body +
    `</section>`
  )
}

/** The effort the default profile's nodes compute, when they agree. */
function defaultEffort(overview: ProviderOverview, profileId: string): string {
  const words = new Set<string>()
  for (const node of overview.nodes) {
    if (node.expected?.profileId !== profileId) continue
    const cells = effectiveCells(node.actual)
    if (cells.reported) words.add(cells.effort)
  }
  if (words.size === 0) return NOT_REPORTED
  if (words.size > 1) return '各节点不同'
  return [...words][0] ?? NOT_REPORTED
}

/** §6.3.1 the global default card. */
function defaultCard(
  overview: ProviderOverview,
  reader: ProvidersReader,
): string {
  const summary = overview.profiles.find(
    entry => entry.profile.id === overview.defaultProfileId,
  )
  const change = reader.writer
    ? writeButton('prov-default-open', '更改全局默认', {
        profile: overview.defaultProfileId ?? '',
      })
    : ''
  if (summary === undefined) {
    return (
      `<section class="card elev-sm prov-default" id="prov-default">` +
      `<div class="card-kicker">Default</div>` +
      `<div class="prov-default-name">没有全局默认</div>` +
      `<p class="note">跟随默认的节点不受托管 · 设一份全局默认或给节点单独指定</p>` +
      `<div class="rowx">${change}</div>` +
      `</section>`
    )
  }
  const profile = summary.profile
  const following = overview.nodes.filter(
    node => node.expected?.profileId === profile.id,
  )
  const drifted = following.filter(node => node.drift.length > 0).length
  return (
    `<section class="card elev-sm prov-default" id="prov-default" ` +
    `data-profile="${attr(profile.id)}">` +
    `<div class="card-kicker">Default</div>` +
    `<div class="rowx"><a class="prov-default-name" href="/providers/profiles/${attr(
      encodeURIComponent(profile.id),
    )}" data-nav>${escapeHtml(profile.name)}</a>` +
    tag('全局默认', 'ok') +
    `</div>` +
    `<div class="prov-kvs">` +
    kvText('线路', laneWord(profile.lane)) +
    kvText('主模型', mainModel(profile)?.id ?? '—') +
    kvText('effort · 节点算出', defaultEffort(overview, profile.id)) +
    kvText('在用', `${following.length} 个节点 · 有漂移 ${drifted} 个`) +
    `</div>` +
    `<div class="rowx">${change}</div>` +
    `</section>`
  )
}

/** How a profile with several keys picks one for a new session (P18.18). */
export const KEY_SELECTION_WORD: Readonly<Record<string, string>> = {
  fill_first: '按顺序',
  round_robin: '轮流',
  least_used: '用得最少',
}

/**
 * A key's state in words: never a fragment of it, the fingerprint for ops
 * only. Several keys (P18.18) are counted, with how one is picked; each key's
 * own line is on the profile's form.
 */
export function keyState(
  summary: Pick<ProviderProfileSummary, 'secrets' | 'profile'>,
  reader: ProvidersReader,
): string {
  if (summary.secrets.length > 1) {
    const total = summary.secrets.length
    const set = summary.secrets.filter(secret => secret.set).length
    const selection = summary.profile.keySelection ?? 'fill_first'
    return (
      `${total} 把 · ` +
      (set === total
        ? '全部已设置'
        : set === 0
          ? '都未设置'
          : `已设置 ${set} 把`) +
      ` · ${KEY_SELECTION_WORD[selection] ?? selection}`
    )
  }
  const secret = summary.secrets[0]
  if (secret === undefined || !secret.set) return '密钥未设置'
  const at =
    secret.setAt === undefined ? '' : ` · 设置于 ${minuteOf(secret.setAt)}`
  const key = summary.profile.keys.find(entry => entry.id === secret.keyId)
  const print =
    reader.writer && key?.fingerprint !== undefined
      ? ` · 指纹 ${shortFingerprint(key.fingerprint)}`
      : ''
  return `密钥已设置${at}${print}`
}

/** The tags under a profile's name: plan, evaluation, terms. */
export function profileTags(profile: ProviderProfileView): string {
  return (
    `<span class="tags">` +
    tag(PLAN_WORD[profile.plan] ?? profile.plan) +
    (profile.evaluated === false
      ? tag('未评估', 'warn')
      : tag(`已评估 ${profile.evaluated.at.slice(0, 10)}`, 'ok')) +
    (profile.terms?.restricted === true ? tag('条款限制', 'warn') : '') +
    `</span>`
  )
}

/** §6.3.1 one profile card. */
function profileCard(
  summary: ProviderProfileSummary,
  catalog: ProviderCatalog,
  reader: ProvidersReader,
): string {
  const profile = summary.profile
  const href = `/providers/profiles/${encodeURIComponent(profile.id)}`
  const actions = reader.writer
    ? `<div class="rowx prov-card-acts">` +
      writeButton(
        'prov-switch',
        '切换到此服务',
        {
          profile: profile.id,
          name: profile.name,
          lane: profile.lane,
        },
        { primary: true },
      ) +
      (summary.isDefault
        ? ''
        : writeButton('prov-default', '设为全局默认', {
            profile: profile.id,
            name: profile.name,
          })) +
      `<a class="btn btn-secondary btn-small" href="${attr(href)}" data-nav data-write>编辑</a>` +
      writeButton(
        'prov-delete',
        '删除',
        {
          profile: profile.id,
          name: profile.name,
          revision: String(profile.revision),
        },
        { danger: true },
      ) +
      `</div>`
    : ''
  return (
    `<article class="card elev-sm prov-card" data-key="profile:${attr(
      profile.id,
    )}" data-profile="${attr(profile.id)}">` +
    `<div class="rowx"><a class="prov-card-name" href="${attr(href)}" data-nav>${escapeHtml(
      profile.name,
    )}</a>` +
    (summary.isDefault ? tag('全局默认', 'ok') : '') +
    `</div>` +
    `<div class="card-meta">${escapeHtml(vendorOf(profile, catalog))} · ${escapeHtml(
      laneWord(profile.lane),
    )}</div>` +
    profileTags(profile) +
    `<div class="prov-kvs">` +
    kvText('主模型', mainModel(profile)?.id ?? '—') +
    kvText('地址', baseUrlFor(profile, reader.writer)) +
    kvText('密钥', keyState(summary, reader)) +
    kvText('在用', `${summary.nodes.length} 个节点`) +
    `</div>` +
    actions +
    `</article>`
  )
}

function profileCards(
  overview: ProviderOverview,
  catalog: ProviderCatalog,
  reader: ProvidersReader,
): string {
  const body =
    overview.profiles.length === 0
      ? `<div class="prov-empty">` +
        hint('还没有模型服务 · 从预设开始') +
        (reader.writer
          ? `<a class="btn btn-primary" href="/providers/new" data-nav data-write>${icon(
              'plus',
              { small: true },
            )}新增模型服务</a>`
          : '') +
        `</div>`
      : `<div class="prov-cards">` +
        overview.profiles
          .map(summary => profileCard(summary, catalog, reader))
          .join('') +
        `</div>`
  return (
    `<section class="sec" id="prov-profiles" aria-labelledby="h-prov-profiles">` +
    sectionHead('Services', '模型服务', {
      headingId: 'h-prov-profiles',
      tail: `<span class="note">${escapeHtml(
        `${overview.profiles.length} 份 · 密钥只写不读`,
      )}</span>`,
    }) +
    body +
    `</section>`
  )
}

/** The polled board: default card, node matrix, profile cards. */
export function renderBoard(model: {
  readonly overview: ProviderOverview
  readonly catalog: ProviderCatalog
  readonly reader: ProvidersReader
  readonly now: number
  readonly only?: string
}): string {
  return (
    `<div class="prov-board-in" data-revision="${attr(
      String(model.overview.revision),
    )}">` +
    defaultCard(model.overview, model.reader) +
    matrix(model.overview, model.reader, model.now, model.only) +
    profileCards(model.overview, model.catalog, model.reader) +
    `</div>`
  )
}

/** The board when the port could not answer. */
export function renderBoardFailure(failure: ProviderFailure): string {
  return `<div class="prov-board-in">${providerFailureBar(failure)}</div>`
}

/** The page when no port is wired at all. */
export function renderProvidersOff(): string {
  return (
    `<section class="card elev-sm stub" aria-labelledby="prov-off">` +
    `<p class="stub-title" id="prov-off">${escapeHtml(PROVIDERS_OFF_LINE)}</p>` +
    `<p class="note">模型服务由中枢持有加密密钥 · 经第六类动作下发到节点 · 节点在空闲时切换</p>` +
    `</section>`
  )
}

/** The top bar's actions on the board, for a writer. */
export function boardActions(): string {
  return (
    `<a class="btn btn-secondary" href="/providers/import" data-nav data-write>导入</a>` +
    `<a class="btn btn-secondary" href="/v0/providers/export" download ` +
    `id="prov-export" data-action="prov-export" data-write title="导出不含密钥">导出 · 不含密钥</a>` +
    `<a class="btn btn-primary" href="/providers/new" data-nav data-write>` +
    icon('plus', { small: true }) +
    `新增模型服务</a>`
  )
}

// ---------------------------------------------------------------------------
// Dialogs — outside every polled region (J-7)
// ---------------------------------------------------------------------------

export function dialog(options: {
  readonly id: string
  readonly glyph: string
  readonly title: string
  readonly body: string
  /** The confirm button's word; `null` for a dialog that only shows something. */
  readonly confirm: string | null
  readonly danger?: boolean
  readonly wide?: boolean
}): string {
  const { id } = options
  const confirm =
    options.confirm === null
      ? ''
      : `<button type="button" class="btn ${
          options.danger === true ? 'btn-danger' : 'btn-primary'
        }" data-action="confirm-${attr(id)}" data-write>${escapeHtml(
          options.confirm,
        )}</button>`
  return (
    `<dialog class="dialog${options.wide === true ? ' dialog-wide' : ''}" id="${attr(
      id,
    )}" aria-labelledby="${attr(`${id}-title`)}">` +
    `<div class="dlg-top"><span class="dlg-icon">` +
    icon(options.glyph) +
    `</span><div class="dialog-title" id="${attr(`${id}-title`)}">` +
    `${escapeHtml(options.title)}</div></div>` +
    `<div class="dialog-body">${options.body}</div>` +
    `<div class="dialog-actions">` +
    `<button type="button" class="btn btn-secondary" ` +
    `data-action="confirm-cancel">${options.confirm === null ? '关闭' : '取消'}</button>` +
    confirm +
    `</div></dialog>`
  )
}

export function recap(label: string, id: string): string {
  return `<div class="recap"><div class="recap-row"><span class="k">${escapeHtml(
    label,
  )}</span><span class="mono" id="${attr(id)}"></span></div></div>`
}

/** The switch dialog (§6.3.4): scope, current → target, sessions, dry-run keys. */
function switchDialog(nodes: readonly ProviderNodeView[]): string {
  const choices = nodes
    .map(
      node =>
        `<label class="chk"><input type="checkbox" name="prov-switch-node" value="${attr(
          node.node,
        )}"><span class="bx">${icon('check', { small: true })}</span>${escapeHtml(
          node.node,
        )}</label>`,
    )
    .join('')
  return dialog({
    id: 'prov-switch-dialog',
    glyph: 'refresh-cw',
    title: '切换到此服务',
    wide: true,
    confirm: '切换',
    body:
      recap('目标', 'prov-switch-name') +
      `<fieldset class="prov-scope"><legend class="flabel">作用域</legend>` +
      `<div class="seg">` +
      `<label class="seg-opt"><input type="radio" name="prov-switch-scope" value="default" checked>全局默认</label>` +
      `<label class="seg-opt"><input type="radio" name="prov-switch-scope" value="nodes">指定节点</label>` +
      `</div>` +
      `<div class="chips prov-switch-nodes" id="prov-switch-nodes" hidden>${choices}</div>` +
      `</fieldset>` +
      `<div class="field"><label for="prov-switch-sessions">会话</label>` +
      `<span class="sel"><select class="input" id="prov-switch-sessions">` +
      `<option value="">按线路与主机判断</option>` +
      `<option value="reset">重置 · 开始新的会话</option>` +
      `<option value="keep">保留</option>` +
      `</select>${chevron()}</span></div>` +
      `<p class="note prov-hint" id="prov-switch-keep-note" hidden>${escapeHtml(
        KEEP_GATE_LINE,
      )}</p>` +
      `<ul class="prov-plan" id="prov-switch-plan"></ul>` +
      `<p class="note">${escapeHtml(SWITCH_LINE)}</p>` +
      `<p class="note">${escapeHtml(CACHE_LINE)}</p>`,
  })
}

/** §6.6 切换确认. */
const SWITCH_LINE =
  '节点在空闲时切换 · 进行中的对话不受影响 · 更换厂商会开始新的会话'

/** X-3 (§5.11.6): what a switch of model, line, effort or key costs the next turn. */
export const CACHE_LINE = '下一轮会整段重读 · 不命中缓存'

/** §2.7: keeping sessions across a line or host change waits on the node's replay filter. */
const KEEP_GATE_LINE =
  '保留会话要所有受影响的节点报告支持回放过滤 · 现在只能重置或按线路与主机判断'

/** Applying one node's expected profile (§6.3.1 行操作「下发」). */
function applyDialog(): string {
  return dialog({
    id: 'prov-apply-dialog',
    glyph: 'refresh-cw',
    title: '下发',
    confirm: '下发',
    body:
      recap('节点', 'prov-apply-node') +
      `<ul class="prov-plan" id="prov-apply-plan"></ul>` +
      `<div class="field"><label for="prov-apply-sessions">会话</label>` +
      `<span class="sel"><select class="input" id="prov-apply-sessions">` +
      `<option value="">按线路与主机判断</option>` +
      `<option value="reset">重置 · 开始新的会话</option>` +
      `<option value="keep">保留</option>` +
      `</select>${chevron()}</span></div>` +
      `<p class="note prov-hint" id="prov-apply-keep-note" hidden>${escapeHtml(
        KEEP_GATE_LINE,
      )}</p>` +
      `<p class="note">${escapeHtml(SWITCH_LINE)}</p>` +
      `<p class="note">${escapeHtml(CACHE_LINE)}</p>`,
  })
}

/** Every dialog the board's controls open. Rendered once, for a writer only. */
export function boardDialogs(overview: ProviderOverview | null): string {
  const profiles = overview?.profiles ?? []
  const profileOptions = profiles
    .map(
      entry =>
        `<option value="${attr(entry.profile.id)}">${escapeHtml(
          entry.profile.name,
        )}</option>`,
    )
    .join('')
  return (
    switchDialog(overview?.nodes ?? []) +
    applyDialog() +
    dialog({
      id: 'prov-default-dialog',
      glyph: 'settings',
      title: '更改全局默认',
      confirm: '保存',
      body:
        `<div class="field"><label for="prov-default-select">全局默认</label>` +
        `<span class="sel"><select class="input" id="prov-default-select">` +
        `<option value="">不设全局默认</option>${profileOptions}</select>${chevron()}</span></div>` +
        `<p class="note">单独指定过的节点不受影响 · 跟随默认的节点要下发后才切换</p>`,
    }) +
    dialog({
      id: 'prov-assign-dialog',
      glyph: 'server',
      title: '指派',
      confirm: '保存',
      body:
        recap('节点', 'prov-assign-node') +
        `<div class="seg" role="radiogroup" aria-label="指派方式">` +
        `<label class="seg-opt"><input type="radio" name="prov-assign-mode" value="inherit">跟随全局默认</label>` +
        `<label class="seg-opt"><input type="radio" name="prov-assign-mode" value="profile">单独指定</label>` +
        `<label class="seg-opt"><input type="radio" name="prov-assign-mode" value="unmanaged">不托管</label>` +
        `</div>` +
        `<div class="field"><label for="prov-assign-profile">档案</label>` +
        `<span class="sel"><select class="input" id="prov-assign-profile">${profileOptions}</select>${chevron()}</span></div>` +
        `<p class="note">改指派只改中枢的期望 · 下发后节点才切换 · 不托管不动节点文件</p>`,
    }) +
    dialog({
      id: 'prov-context-dialog',
      glyph: 'settings',
      title: '上下文窗口',
      confirm: '保存',
      body:
        recap('节点', 'prov-context-node') +
        `<div class="field"><label for="prov-context-value">上下文窗口 token</label>` +
        `<input class="input mono" type="text" inputmode="numeric" id="prov-context-value" ` +
        `autocomplete="off" spellcheck="false" placeholder="例如 200000 或 1M · 留空恢复默认"></div>` +
        `<p class="note">写入该节点的指派覆盖 · 优先于档案 · 随下一次下发生效 · 超过模型能力时由节点按能力夹取</p>`,
    }) +
    dialog({
      id: 'prov-autocompact-dialog',
      glyph: 'settings',
      title: '自动压缩阈值',
      confirm: '保存',
      body:
        recap('节点', 'prov-autocompact-node') +
        `<p class="note" id="prov-autocompact-now"></p>` +
        `<div class="field"><label for="prov-autocompact-value">阈值</label>` +
        `<input class="input mono" type="text" id="prov-autocompact-value" ` +
        `autocomplete="off" spellcheck="false" placeholder="auto 或 100k 到 1M"></div>` +
        `<p class="note">立即写到节点 · 节点所有 · 不随下发改变 · 运行中的会话下一轮生效</p>`,
    }) +
    dialog({
      id: 'prov-force-dialog',
      glyph: 'alert-triangle',
      title: '覆盖节点上的改动',
      confirm: '覆盖',
      danger: true,
      body:
        recap('节点', 'prov-force-node') +
        `<p>节点上的配置在上次下发后被改过 · 覆盖会用中枢的期望替换这些键</p>` +
        `<p class="mono prov-keys" id="prov-force-keys"></p>` +
        `<p class="note">覆盖记进操作记录 · 也可以停止托管这个节点</p>`,
    }) +
    dialog({
      id: 'prov-unmanage-dialog',
      glyph: 'power',
      title: '停止托管',
      confirm: '停止托管',
      danger: true,
      body:
        recap('节点', 'prov-unmanage-node') +
        `<p>只把中枢的期望改为不托管 · 不动节点上的文件 · 节点继续用现在的配置</p>`,
    }) +
    dialog({
      id: 'prov-delete-dialog',
      glyph: 'x',
      title: '删除模型服务',
      confirm: '删除',
      danger: true,
      body:
        recap('档案', 'prov-delete-name') +
        `<p>密钥随档案一起从密文库删除 · 删除不能撤回 · 还有节点在用时会被拒绝</p>`,
    }) +
    dialog({
      id: 'prov-diff-dialog',
      glyph: 'info',
      title: '差异',
      confirm: null,
      body:
        recap('节点', 'prov-diff-node') +
        `<p class="note">下发会改动的受管键 · 只列键名</p>` +
        `<p class="mono prov-keys" id="prov-diff-keys"></p>`,
    })
  )
}

/** Progress of a switch, one line per node (§6.3.4); outside the polled board. */
export function progressPanel(): string {
  return (
    `<section class="card elev-sm prov-progress" id="prov-progress" hidden ` +
    `aria-live="polite" aria-labelledby="prov-progress-title">` +
    `<div class="rowx"><span class="flabel" id="prov-progress-title">切换进度</span>` +
    `<button type="button" class="btn btn-ghost btn-small" data-action="prov-progress-close">收起</button></div>` +
    `<ul class="prov-plan" id="prov-progress-list"></ul>` +
    `</section>`
  )
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

export const PROVIDERS_PAGE_CSS = `
.prov-board-in { display: flex; flex-direction: column; gap: var(--space-6); }
.prov-default { gap: var(--space-3); padding: var(--space-4); }
.prov-default-name { font-family: var(--font-heading); font-weight: var(--font-heading-weight); font-size: 20px; color: var(--color-text); }
.prov-kvs { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: var(--space-3); }
.prov-matrix { display: flex; flex-direction: column; gap: 2px; background: var(--color-surface); border-radius: calc(var(--radius-lg) * 1.15); padding: var(--space-2); overflow-x: auto; }
.prov-head, .prov-row > summary {
  display: grid; align-items: center; gap: var(--space-3);
  grid-template-columns: minmax(90px, .8fr) minmax(150px, 1.4fr) 112px 128px minmax(120px, 1.2fr) 76px 64px 104px 26px;
  min-width: 960px;
}
.prov-head { padding: 4px var(--space-2); font-size: 10px; letter-spacing: .08em; color: var(--color-muted); }
.prov-row > summary { border-radius: var(--radius-lg); }
.prov-cell { display: flex; flex-direction: column; gap: 2px; min-width: 0; overflow-wrap: anywhere; font-size: 13px; }
.prov-node { font-weight: 600; overflow-wrap: anywhere; }
.prov-panel { grid-template-columns: minmax(0, 1fr); min-width: 0; }
.prov-drift { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--space-2); }
.prov-drift li { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2) var(--space-3); }
.prov-keys { font-size: 12px; overflow-wrap: anywhere; }
.prov-recent { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; font-size: 13px; }
.prov-recent li { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2) var(--space-3); }
.prov-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: var(--space-3); }
.prov-card { gap: var(--space-3); padding: var(--space-4); }
.prov-card-name { font-weight: 700; font-size: 16px; color: var(--color-text); text-decoration: none; }
.prov-card-name:hover { text-decoration: underline; }
.prov-card-acts { margin-top: auto; }
.prov-empty { display: flex; flex-direction: column; align-items: flex-start; gap: var(--space-3); }
.prov-plan { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; font-size: 13px; }
.prov-plan li { display: flex; flex-wrap: wrap; gap: var(--space-2) var(--space-3); align-items: baseline; }
.prov-plan li[data-tone='ok'] .prov-plan-state { color: var(--color-accent-2-800); }
.prov-plan li[data-tone='bad'] .prov-plan-state { color: var(--color-accent-800); }
.prov-progress { gap: var(--space-3); padding: var(--space-4); }
.prov-scope { display: flex; flex-direction: column; gap: var(--space-2); }
.prov-switch-nodes { gap: var(--space-2); }
.prov-noscript { margin: 0; }
.prov-tabs { display: flex; flex-wrap: wrap; gap: var(--space-2); }
.prov-tab { padding: 6px 14px; border-radius: 999px; text-decoration: none; color: var(--color-text); border: 1px solid var(--color-divider); font-size: 13px; }
.prov-tab[aria-current='page'] { background: var(--color-accent); color: var(--color-bg); border-color: transparent; }
.prov-search { display: flex; gap: var(--space-2); align-items: flex-end; flex-wrap: wrap; }
.prov-search .input { min-width: 260px; }
.prov-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: var(--space-3); }
.prov-preset { display: flex; flex-direction: column; gap: 6px; padding: var(--space-3) var(--space-4); text-decoration: none; color: var(--color-text); border: 1px solid transparent; }
.prov-preset:hover, .prov-preset:focus-visible { border-color: var(--color-accent); }
.prov-preset-name { font-weight: 700; }
.prov-editor { display: flex; flex-direction: column; gap: var(--space-4); }
.prov-editor .card { padding: var(--space-4); gap: var(--space-3); }
.prov-field-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: var(--space-4); }
.prov-models { display: flex; flex-direction: column; gap: var(--space-3); }
.prov-model { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: var(--space-3); padding: var(--space-3); border-radius: var(--radius-lg); background: var(--color-neutral-100); }
.prov-model .chips { gap: var(--space-2); }
.prov-model-acts { grid-column: 1 / -1; display: flex; justify-content: flex-end; }
.prov-compat { display: flex; flex-direction: column; gap: var(--space-2); }
.prov-compat-row { display: grid; grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr) auto; gap: var(--space-2); align-items: center; }
.prov-actions { display: flex; flex-wrap: wrap; gap: var(--space-2); align-items: center; }
.prov-result { font-size: 13px; min-height: 1.25em; }
.prov-result[data-tone='ok'] { color: var(--color-accent-2-800); }
.prov-result[data-tone='warn'], .prov-result[data-tone='bad'] { color: var(--color-accent-800); }
.prov-rule[data-tone='warn'] { color: var(--color-accent-800); }
/* A class that sets display outranks the hidden attribute; these are the
   ones the page script shows and hides. */
.prov-hint[hidden], .prov-progress[hidden], .prov-switch-nodes[hidden],
.prov-editor .field[hidden], .prov-editor .chk[hidden] { display: none; }
.prov-pool-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--space-2); }
.prov-pool-row { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2) var(--space-3); padding: var(--space-2) var(--space-3); border-radius: var(--radius-lg); background: var(--color-neutral-100); }
.prov-pool-row .prov-actions { margin-left: auto; }
.prov-import-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--space-2); }
.prov-import-list li { display: flex; flex-wrap: wrap; gap: var(--space-2) var(--space-3); align-items: center; }
textarea.prov-import-text { min-height: 220px; font-family: var(--font-mono); font-size: 12.5px; }
@media (max-width: 720px) {
  .prov-compat-row { grid-template-columns: minmax(0, 1fr); }
}
`
