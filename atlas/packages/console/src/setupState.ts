// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 初始化配置：一台新控制台从「能登录」到「能对话」还差哪几步。
 *
 * 每一步的状态都从现有端口当场读出来，这里不另存「完成了第几步」——存下来的
 * 进度会和真实状态对不上（有人在模型页删了默认档案，进度条却还是满的）。
 *
 * 必需的四步按依赖排：运维账号（模型服务只认个人运维账号）→ 接入模型 →
 * 服务器与节点 → 主智能体。任务模型是建议项：没设时三档都跟随主模型，照样能用。
 * 渠道、云端电脑、成员是可选项，只给状态和入口。
 *
 * 读不到的端口按「这台控制台没开这项」处理（`blocked`，写明要加的启动参数），
 * 读失败按「没完成」处理并带上失败原因，不会把读失败显示成已完成。
 */

import type { AccountRole } from './contracts.js'
import type {
  ConsoleAgent,
  ConsoleResult,
  ProviderOverview,
  ProviderPresetView,
  ProviderResult,
} from './deps.js'
import type {
  ChannelsSnapshot,
  DesktopNodeView,
  ModelRoutingSnapshot,
} from './directionPorts.js'

export type SetupStepId =
  | 'account'
  | 'model'
  | 'nodes'
  | 'main'
  | 'tasks'
  | 'channels'
  | 'desktop'
  | 'members'

export type SetupStepKind = 'required' | 'recommended' | 'optional'

/** `blocked`：这台控制台没开这一项，页面上做不了，只能改启动参数。 */
export type SetupStepState = 'done' | 'todo' | 'blocked'

export interface SetupStep {
  readonly id: SetupStepId
  readonly title: string
  readonly kind: SetupStepKind
  readonly state: SetupStepState
  /** 一句话：现在是什么，或缺什么。 */
  readonly summary: string
  /** 为什么做不了、或要先做什么；一个短句。 */
  readonly note?: string
  /** 去别的页面完成或查看。 */
  readonly link?: { readonly href: string; readonly label: string }
}

/** 接入模型这一步页内可选的预设：不需要额外模板变量、只填一把密钥就能用的。 */
export interface SetupPreset {
  readonly id: string
  readonly name: string
  readonly vendor: string
  readonly group: ProviderPresetView['group']
  readonly keyHint: string | null
}

/** 主智能体这一步的候选。 */
export interface SetupAgent {
  readonly address: string
  readonly node: string
  readonly agent: string
  readonly online: boolean
}

export interface SetupSnapshot {
  readonly steps: readonly SetupStep[]
  /** 必需项里还没完成的数目（含 blocked）。 */
  readonly remaining: number
  /** 必需项里能在页面上做、还没做的数目：侧栏上的数字只数这些。 */
  readonly actionable: number
  readonly presets: readonly SetupPreset[]
  readonly agents: readonly SetupAgent[]
  /** 当前主智能体（页面设的或启动参数），不在名册里时仍给出，由页面说明。 */
  readonly main: string | null
  /** 主智能体是页面上设过的（可「恢复启动参数」）。 */
  readonly mainFromPage: boolean
}

/** 计算所需的全部读数；路由层负责去读，这里只做判断，便于测试。 */
export interface SetupReadings {
  readonly now: number
  /** `undefined`：这台控制台没开个人账号。 */
  readonly accounts?: ConsoleResult<{
    readonly accounts: readonly {
      readonly role: AccountRole
      readonly state: 'active' | 'reset' | 'revoked'
    }[]
    readonly invites: readonly {
      readonly role: AccountRole
      readonly state: 'open' | 'expired' | 'consumed' | 'withdrawn'
    }[]
  }>
  /** 读者此刻能不能写模型服务（个人运维账号、非 break-glass）。 */
  readonly modelWriter: boolean
  /** `undefined`：没开模型服务。 */
  readonly providers?: ProviderResult<ProviderOverview>
  readonly presets: readonly ProviderPresetView[]
  readonly roster: ConsoleResult<readonly ConsoleAgent[]>
  /** 能不能从页面添加服务器（`--replicate`）。 */
  readonly replicate: boolean
  readonly chatWired: boolean
  readonly mainPreferred: string | undefined
  readonly mainFromPage: boolean
  readonly mainSettable: boolean
  /** `undefined`：没接任务模型（路由簿）。 */
  readonly routing?: ConsoleResult<ModelRoutingSnapshot>
  readonly channels?: ConsoleResult<ChannelsSnapshot>
  readonly desktop?: ConsoleResult<readonly DesktopNodeView[]>
}

const MEDIA = new Set(['image', 'speech', 'video'])

/** 页内能直接接的预设分组：按量计费、国际、套餐。本地与自定义要填地址，去完整表单。 */
const INLINE_GROUPS = new Set<ProviderPresetView['group']>([
  'cn-paygo',
  'intl',
  'plan',
])

function failureLine(result: {
  readonly ok: false
  readonly failure: { readonly message: string }
}): string {
  return `读取失败 · ${result.failure.message}`
}

function addressParts(address: string): { node: string; agent: string } {
  const match = /^qianmo:\/\/([^/]+)\/(.+)$/.exec(address)
  return match === null
    ? { node: address, agent: '' }
    : { node: match[1] ?? address, agent: match[2] ?? '' }
}

function accountStep(r: SetupReadings): SetupStep {
  const base = { id: 'account', title: '运维账号', kind: 'required' } as const
  if (r.accounts === undefined) {
    return {
      ...base,
      state: 'blocked',
      summary: '这台控制台没开个人账号',
      note: '启动参数加 --accounts 后才能配置模型',
    }
  }
  if (!r.accounts.ok) {
    return { ...base, state: 'todo', summary: failureLine(r.accounts) }
  }
  const ops = r.accounts.value.accounts.filter(
    one => one.role === 'ops' && one.state !== 'revoked',
  ).length
  if (ops === 0) {
    const pending = r.accounts.value.invites.some(
      one => one.role === 'ops' && one.state === 'open',
    )
    return {
      ...base,
      state: 'todo',
      summary: pending ? '已发出运维邀请 · 还没有人领取' : '还没有运维账号',
      note: '模型服务只认个人运维账号 · 共用令牌只能查看',
    }
  }
  return {
    ...base,
    state: 'done',
    summary: `${ops} 个运维账号`,
    ...(r.modelWriter
      ? {}
      : { note: '你现在用的不是运维账号 · 退出后用运维账号登录才能改模型' }),
  }
}

function modelStep(r: SetupReadings): SetupStep {
  const base = { id: 'model', title: '接入模型', kind: 'required' } as const
  if (r.providers === undefined) {
    return {
      ...base,
      state: 'blocked',
      summary: '这台控制台没开模型服务',
      note: '启动参数加 --providers 与 --accounts',
    }
  }
  if (!r.providers.ok) {
    return { ...base, state: 'todo', summary: failureLine(r.providers) }
  }
  const overview = r.providers.value
  const chosen = overview.profiles.find(
    one => one.profile.id === overview.defaultProfileId,
  )
  const link = { href: '/admin/providers', label: '模型页' }
  if (chosen === undefined) {
    return {
      ...base,
      state: 'todo',
      summary:
        overview.profiles.length === 0
          ? '还没有模型服务'
          : `有 ${overview.profiles.length} 个模型服务 · 还没设全局默认`,
      link,
    }
  }
  const keyless = chosen.secrets.length > 0 && !chosen.secrets.some(s => s.set)
  const main = chosen.profile.models.find(model => model.role === 'main')
  if (keyless) {
    return {
      ...base,
      state: 'todo',
      summary: `全局默认「${chosen.profile.name}」还没填密钥`,
      link: {
        href: `/admin/providers/profiles/${encodeURIComponent(chosen.profile.id)}`,
        label: '填密钥',
      },
    }
  }
  return {
    ...base,
    state: 'done',
    summary:
      main === undefined
        ? `全局默认：${chosen.profile.name}`
        : `全局默认：${chosen.profile.name} · ${main.id}`,
    link,
  }
}

function online(agent: ConsoleAgent, now: number): boolean {
  return agent.expiresAt > now
}

function nodesStep(r: SetupReadings): SetupStep {
  const base = { id: 'nodes', title: '服务器与节点', kind: 'required' } as const
  const add = r.replicate
    ? { link: { href: '/admin/servers?add=1', label: '添加服务器' } }
    : {}
  if (!r.roster.ok) {
    return { ...base, state: 'todo', summary: failureLine(r.roster), ...add }
  }
  const live = r.roster.value.filter(agent => online(agent, r.now))
  const nodes = new Set(live.map(agent => addressParts(agent.address).node))
  if (nodes.size === 0) {
    return {
      ...base,
      state: r.replicate ? 'todo' : 'blocked',
      summary:
        r.roster.value.length === 0 ? '名册里还没有节点' : '节点都不在线',
      ...(r.replicate
        ? add
        : { note: '在服务器上装好节点并注册到这台中枢后会出现在这里' }),
    }
  }
  return {
    ...base,
    state: 'done',
    summary: `${nodes.size} 个节点在线 · ${live.length} 个智能体`,
    link: { href: '/admin/nodes', label: '节点页' },
  }
}

function mainStep(r: SetupReadings, agents: readonly SetupAgent[]): SetupStep {
  const base = { id: 'main', title: '主智能体', kind: 'required' } as const
  if (!r.chatWired) {
    return {
      ...base,
      state: 'blocked',
      summary: '这台控制台没开对话',
      note: '启动参数加 --chat-url 等对话参数',
    }
  }
  if (agents.length === 0) {
    return {
      ...base,
      state: 'todo',
      summary: '先接入节点再选主智能体',
    }
  }
  const preferred = r.mainPreferred
  const listed =
    preferred === undefined
      ? undefined
      : agents.find(agent => agent.address === preferred)
  if (listed !== undefined) {
    const where = `${listed.agent} · ${listed.node}`
    return {
      ...base,
      state: 'done',
      summary: listed.online ? where : `${where} · 不在线`,
    }
  }
  if (!r.mainSettable) {
    // 改不了也照样能用：对话首页打开名册里第一个能对话的智能体。
    return {
      ...base,
      state: 'done',
      summary:
        preferred === undefined
          ? '未指定 · 对话首页打开名册里第一个智能体'
          : `启动参数指定的 ${preferred} 不在名册里 · 对话首页打开第一个智能体`,
      note: '要在页面上改主智能体 · 需要对话通道已接入的中枢',
    }
  }
  return {
    ...base,
    state: 'todo',
    summary:
      preferred === undefined
        ? '还没指定 · 对话首页会打开名册里第一个智能体'
        : `指定的 ${preferred} 不在名册里`,
  }
}

function tasksStep(r: SetupReadings): SetupStep {
  const base = {
    id: 'tasks',
    title: '任务模型',
    kind: 'recommended',
    link: { href: '/admin/providers#task-models', label: '去设置' },
  } as const
  if (r.routing === undefined) {
    return {
      ...base,
      state: 'blocked',
      summary: '这台控制台没开任务模型',
      note: '随模型服务一起开启',
    }
  }
  if (!r.routing.ok) {
    return { ...base, state: 'todo', summary: failureLine(r.routing) }
  }
  const routes = r.routing.value.defaults.routes
  const tiers = routes.filter(one => !MEDIA.has(one.direction))
  const media = routes.filter(one => MEDIA.has(one.direction))
  const setTiers = tiers.filter(one => one.modelId !== null).length
  const setMedia = media.filter(one => one.modelId !== null).length
  const tierLine =
    setTiers === 0 ? '各难度都跟随主模型' : `${setTiers} 档难度单独设了模型`
  const mediaLine =
    setMedia === 0 ? '生图 / 语音 / 视频没开' : `开了 ${setMedia} 种生成`
  return {
    ...base,
    state: setTiers + setMedia > 0 ? 'done' : 'todo',
    summary: `${tierLine} · ${mediaLine}`,
  }
}

function channelsStep(r: SetupReadings): SetupStep {
  const base = {
    id: 'channels',
    title: '聊天渠道',
    kind: 'optional',
    link: { href: '/admin/channels', label: '渠道页' },
  } as const
  if (r.channels === undefined) {
    return { ...base, state: 'blocked', summary: '这台控制台没开聊天渠道' }
  }
  if (!r.channels.ok) {
    return { ...base, state: 'todo', summary: failureLine(r.channels) }
  }
  const on = r.channels.value.channels.filter(one => one.enabled).length
  return on === 0
    ? {
        ...base,
        state: 'todo',
        summary: '在 QQ / 微信 / Telegram 等平台上和智能体对话',
      }
    : { ...base, state: 'done', summary: `${on} 个渠道已开` }
}

function desktopStep(r: SetupReadings): SetupStep {
  const base = {
    id: 'desktop',
    title: '云端电脑',
    kind: 'optional',
    link: { href: '/admin/desktop', label: '云端电脑页' },
  } as const
  if (r.desktop === undefined) {
    return { ...base, state: 'blocked', summary: '这台控制台没开云端电脑' }
  }
  if (!r.desktop.ok) {
    return { ...base, state: 'todo', summary: failureLine(r.desktop) }
  }
  const on = r.desktop.value.filter(
    one => one.browser.enabled || one.computer.enabled,
  ).length
  return on === 0
    ? { ...base, state: 'todo', summary: '给智能体一台专属浏览器或电脑' }
    : { ...base, state: 'done', summary: `${on} 个智能体已开` }
}

function membersStep(r: SetupReadings): SetupStep {
  const base = {
    id: 'members',
    title: '邀请成员',
    kind: 'optional',
    link: { href: '/admin/access/invites', label: '邀请' },
  } as const
  if (r.accounts === undefined) {
    return { ...base, state: 'blocked', summary: '这台控制台没开个人账号' }
  }
  if (!r.accounts.ok) {
    return { ...base, state: 'todo', summary: failureLine(r.accounts) }
  }
  const people = r.accounts.value.accounts.filter(
    one => one.state !== 'revoked',
  ).length
  return people > 1
    ? { ...base, state: 'done', summary: `${people} 个账号` }
    : { ...base, state: 'todo', summary: '请同事一起用 · 各自有自己的对话' }
}

function agentsOf(r: SetupReadings): readonly SetupAgent[] {
  if (!r.roster.ok) return []
  return r.roster.value
    .filter(agent => agent.address.startsWith('qianmo://'))
    .map(agent => {
      const parts = addressParts(agent.address)
      return {
        address: agent.address,
        node: parts.node,
        agent: parts.agent,
        online: online(agent, r.now),
      }
    })
    .sort(
      (a, b) =>
        Number(b.online) - Number(a.online) ||
        a.address.localeCompare(b.address),
    )
}

function presetsOf(r: SetupReadings): readonly SetupPreset[] {
  return r.presets
    .filter(
      preset =>
        preset.listed &&
        INLINE_GROUPS.has(preset.group) &&
        preset.templateVars.length === 0,
    )
    .map(preset => ({
      id: preset.id,
      name: preset.name,
      vendor: preset.vendor,
      group: preset.group,
      keyHint: preset.keyHint?.display ?? null,
    }))
}

/** 由读数算出整页状态。 */
export function setupSnapshot(r: SetupReadings): SetupSnapshot {
  const agents = agentsOf(r)
  const steps: readonly SetupStep[] = [
    accountStep(r),
    modelStep(r),
    nodesStep(r),
    mainStep(r, agents),
    tasksStep(r),
    channelsStep(r),
    desktopStep(r),
    membersStep(r),
  ]
  return {
    steps,
    remaining: steps.filter(
      step => step.kind === 'required' && step.state !== 'done',
    ).length,
    actionable: steps.filter(
      step => step.kind === 'required' && step.state === 'todo',
    ).length,
    presets: presetsOf(r),
    agents,
    main: r.mainPreferred ?? null,
    mainFromPage: r.mainFromPage,
  }
}
