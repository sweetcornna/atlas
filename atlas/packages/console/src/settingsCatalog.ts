// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The settings catalog (P40, `docs/dev/agent-settings.md` §2): every write the
 * console's panels can make, one entry each, shared by the panel and the
 * agent.
 *
 * ## An entry names a `/v0` write, it does not reimplement one
 *
 * {@link SettingOperation.request} turns a target and an input into the very
 * request the page would send; the hub runs it through the console's own
 * router as the person who approved it (`http.ts`, `ConsoleHandler.as`), so
 * the route's guard, the tenant boundary, `admit` and the action ledger are
 * the ones the page meets. Nothing here validates a value beyond the shape the
 * route reads: the schemas tell an agent what to send and let the hub refuse a
 * malformed change before anybody is asked to approve it.
 *
 * `route` is the row of `console.md` §5 an entry executes, in that table's own
 * spelling. `test/settingsCatalog.test.ts` reconciles the two both ways: a
 * documented write that is neither here nor in its commented exemption list
 * turns it red, and so does an entry whose row is not documented.
 *
 * ## Only a person
 *
 * An entry with {@link SettingOperation.human} is in the catalog so an agent
 * can tell somebody where to go, never so it can be requested: approvals,
 * accounts and devices, opening a tier above `off`, billing, channel pairing
 * and SSH credentials (§2). Lowering a tier (`elevation.off`,
 * `elevation.revoke`) is an ordinary change.
 *
 * ## What an approval binds
 *
 * {@link settingsBound} is the whole of it (§4.2): the id, the target, the
 * input with every secret replaced by its tail and hash, and the card a person
 * reads — including the value before the change, so an approval given while
 * somebody else changes the same setting no longer matches when it is used.
 * Everything in it is derived from the arguments and the value read, never
 * from the clock, so the hub can compute it again at apply time byte for byte.
 */

import { createHash } from 'node:crypto'
import {
  AVATAR_ACCESSORIES,
  AVATAR_COLORS,
  AVATAR_EYES,
  AVATAR_MATERIALS,
  AVATAR_MOUTHS,
  AVATAR_SHAPES,
} from './avatar.js'
import {
  EXTENSION_KINDS,
  MAGPIE_AFFINITIES,
  MAGPIE_EXTENSION_KINDS,
  MAGPIE_LANES,
  MAGPIE_LIMIT_PERIODS,
  MAGPIE_ROUTINGS,
  MODEL_DIRECTIONS,
  SCHEDULE_TEMPLATES,
  TIER_EFFORTS,
  UPDATE_SOURCES,
} from './directionPorts.js'
import { baseUrlFor } from './view/providers.js'

export type SettingArea =
  | 'providers'
  | 'routing'
  | 'magpie'
  | 'agents'
  | 'setup'
  | 'im'
  | 'schedules'
  | 'notify'
  | 'extensions'
  | 'connectors'
  | 'desktop'
  | 'elevation'
  | 'nodes'
  | 'servers'
  | 'updates'
  | 'alerts'
  | 'accounts'
  | 'approvals'
  | 'billing'
  | 'files'

export type SettingKind = 'set' | 'create' | 'update' | 'remove' | 'run'

/** The personal account role the `/v0` write's own guard asks for. */
export type SettingRole = 'ops' | 'member'

/** Each area in the panel's words, in the sidebar's order. */
export const SETTING_AREAS: Readonly<Record<SettingArea, string>> = {
  providers: '模型',
  routing: '任务模型',
  magpie: '网关',
  agents: '智能体',
  setup: '初始化配置',
  im: '渠道',
  schedules: '定时任务',
  notify: '通知渠道',
  extensions: '扩展',
  connectors: '应用连接',
  desktop: '云端电脑',
  elevation: '权限模式',
  nodes: '节点',
  servers: '服务器',
  updates: '更新',
  alerts: '告警',
  accounts: '账号与访问',
  approvals: '审批',
  billing: '订阅',
  files: '文件互通',
}

/**
 * The part of JSON Schema the catalog writes. {@link schemaProblem} checks
 * exactly these keywords; the agent reads the same object.
 */
export interface JsonSchema {
  readonly type?: JsonType | readonly JsonType[]
  readonly description?: string
  readonly properties?: Readonly<Record<string, JsonSchema>>
  readonly required?: readonly string[]
  readonly additionalProperties?: boolean | JsonSchema
  readonly minProperties?: number
  readonly items?: JsonSchema
  readonly minItems?: number
  readonly maxItems?: number
  readonly enum?: readonly (string | number | boolean | null)[]
  readonly pattern?: string
  readonly minLength?: number
  readonly maxLength?: number
  readonly minimum?: number
  readonly maximum?: number
  readonly anyOf?: readonly JsonSchema[]
}

type JsonType =
  | 'object'
  | 'array'
  | 'string'
  | 'number'
  | 'integer'
  | 'boolean'
  | 'null'

export interface SettingRequest {
  readonly method: 'POST' | 'PUT' | 'DELETE'
  /** The path with every segment already encoded. */
  readonly path: string
  readonly body?: unknown
}

/**
 * How an entry reads the value before a change: a GET through the console as
 * the conversation's owner. The JSON body on success, `null` for a 404; any
 * other answer throws with the route's own message.
 */
export interface SettingReader {
  get(path: string): Promise<unknown>
}

type Args = Readonly<Record<string, unknown>>

export interface SettingOperation {
  /** `area.action`, stable and readable: `providers.default`. */
  readonly id: string
  readonly area: SettingArea
  /** The panel's own name for it. */
  readonly label: string
  /** One line: what it changes. */
  readonly description: string
  readonly kind: SettingKind
  readonly role: SettingRole
  /** Set: only a person does this, and this is where. */
  readonly human?: string
  /**
   * Set: some changes of this entry are a person's alone (§2), the ones that
   * give an agent more than it has now. `when` reads the change against the
   * value before it; `note` is where the person goes.
   */
  readonly personOnly?: {
    readonly note: string
    readonly when: (input: Args, current: unknown) => boolean
  }
  /** What the change is about (profile, node, agent, id); absent when nothing. */
  readonly target?: JsonSchema
  /** What it becomes: the route's request body, less what the target says. */
  readonly input?: JsonSchema
  /** Paths in `input` that hold secrets; `*` is any key or index. */
  readonly secrets?: readonly string[]
  /** The `console.md` §5 row it executes: `PUT /v0/providers/default`. */
  readonly route: string
  readonly request: (target: Args, input: Args) => SettingRequest
  /** The value before the change, as a short record; `create` has none. */
  readonly current?: (read: SettingReader, target: Args) => Promise<unknown>
  /** Where on the panel. */
  readonly page: string
}

// ---------------------------------------------------------------------------
// Schema shorthand
// ---------------------------------------------------------------------------

const NAME_PATTERN = '^[a-z0-9][a-z0-9_-]{0,63}$'
const ADDRESS_PATTERN =
  '^qianmo://[a-z0-9][a-z0-9_-]{0,63}/[a-z0-9][a-z0-9_-]{0,63}$'

function text(
  description: string,
  extra: Partial<JsonSchema> = {},
): JsonSchema {
  return { type: 'string', description, ...extra }
}

function flag(description: string): JsonSchema {
  return { type: 'boolean', description }
}

function whole(
  description: string,
  minimum?: number,
  maximum?: number,
): JsonSchema {
  return {
    type: 'integer',
    description,
    ...(minimum === undefined ? {} : { minimum }),
    ...(maximum === undefined ? {} : { maximum }),
  }
}

function choice(
  values: readonly (string | null)[],
  description: string,
): JsonSchema {
  return {
    type: values.includes(null) ? ['string', 'null'] : 'string',
    enum: values,
    description,
  }
}

function texts(description: string, maxItems = 500): JsonSchema {
  return { type: 'array', items: { type: 'string' }, maxItems, description }
}

function shape(
  properties: Readonly<Record<string, JsonSchema>>,
  required: readonly string[] = [],
  extra: Partial<JsonSchema> = {},
): JsonSchema {
  return {
    type: 'object',
    properties,
    required,
    additionalProperties: false,
    ...extra,
  }
}

/** A string-to-string map: settings, secrets, environment. */
function dictionary(description: string, nullable = false): JsonSchema {
  return {
    type: 'object',
    additionalProperties: { type: nullable ? ['string', 'null'] : 'string' },
    description,
  }
}

const NODE = text('节点名', { pattern: NAME_PATTERN })
const AGENT = text('智能体名', { pattern: NAME_PATTERN })
const ADDRESS = text('智能体地址 qianmo://<节点>/<智能体>', {
  pattern: ADDRESS_PATTERN,
})
const NODE_TARGET = shape({ node: NODE }, ['node'])
const AGENT_TARGET = shape({ node: NODE, agent: AGENT }, ['node', 'agent'])
const ADDRESS_TARGET = shape({ address: ADDRESS }, ['address'])

function idTarget(description: string): JsonSchema {
  return shape({ id: text(description, { minLength: 1, maxLength: 128 }) }, [
    'id',
  ])
}

const REVISION = whole('当前修订号 · 有人先改了就不符', 0)

// ---------------------------------------------------------------------------
// Reading the value before a change
// ---------------------------------------------------------------------------

/**
 * One path segment, encoded. `.` and `..` survive encoding and a URL folds
 * them into the parent, so `keys/..` would land on the profile; the router
 * drops an empty segment, so `keys/` would be another route too: refused.
 */
function seg(value: unknown): string {
  const raw = String(value ?? '')
  if (raw === '' || raw === '.' || raw === '..')
    throw new SettingPathError(
      raw === '' ? '路径段不能为空' : `路径段不能是 ${raw}`,
    )
  return encodeURIComponent(raw)
}

class SettingPathError extends Error {}

/**
 * Why the request a change would make is not the one its entry names, or
 * null: a target that fails to build, or a path the URL parser would fold
 * into another route.
 */
export function settingRequestProblem(
  op: SettingOperation,
  target: Args,
  input: Args,
): string | null {
  let path: string
  try {
    path = op.request(target, input).path
  } catch (error) {
    if (error instanceof SettingPathError)
      return `target 不对 · ${error.message}`
    throw error
  }
  const bare = path.split('?')[0] ?? path
  return new URL(bare, 'http://console.in-process').pathname === bare
    ? null
    : 'target 不对 · 路径会被改写'
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function rowsOf(value: unknown, key: string): Record<string, unknown>[] {
  const list = recordOf(value)?.[key]
  return Array.isArray(list)
    ? list.flatMap(row => {
        const found = recordOf(row)
        return found === null ? [] : [found]
      })
    : []
}

/** `keys` of `value`, those it has; `null` when there is no value. */
function pick(value: unknown, keys: readonly string[]): unknown {
  const found = recordOf(value)
  if (found === null) return null
  const out: Record<string, unknown> = {}
  for (const key of keys) if (key in found) out[key] = found[key]
  return out
}

/** The editable fields a schema names, read off the stored row. */
function fieldsOf(schema: JsonSchema): readonly string[] {
  return Object.keys(schema.properties ?? {})
}

/** One row of a list in a GET, picked to the fields the input can change. */
async function rowIn(
  read: SettingReader,
  path: string,
  list: string,
  matches: (row: Record<string, unknown>) => boolean,
  keys: readonly string[],
): Promise<unknown> {
  const row = rowsOf(await read.get(path), list).find(matches)
  return row === undefined ? null : pick(row, keys)
}

function byId(target: Args): (row: Record<string, unknown>) => boolean {
  return row => row['id'] === target['id']
}

function byAgent(target: Args): (row: Record<string, unknown>) => boolean {
  return row =>
    row['node'] === target['node'] && row['agent'] === target['agent']
}

// ---------------------------------------------------------------------------
// The input shapes the routes read
// ---------------------------------------------------------------------------

const PROFILE_EDIT = {
  type: 'object',
  description:
    '表单编辑的字段 · name site lane baseUrl templateValues models compat effortLock auth keys keySelection · 预设与评估状态由中枢定',
} as const satisfies JsonSchema

const ROUTE_ENTRY = shape(
  {
    direction: choice(MODEL_DIRECTIONS, '方向'),
    profileId: text('模型服务档案 · null 跟随主模型', {
      type: ['string', 'null'],
    }),
    modelId: text('模型号 · null 跟随主模型', { type: ['string', 'null'] }),
    effort: choice([...TIER_EFFORTS, null], '推理强度 · 省略为模型默认'),
  },
  ['direction', 'profileId', 'modelId'],
)

const ROUTING_INPUT = shape(
  {
    auto: flag('任务没带方向时按文字自动归类'),
    routes: {
      type: 'array',
      items: ROUTE_ENTRY,
      maxItems: MODEL_DIRECTIONS.length,
      description: '只给要改的方向',
    },
    revision: REVISION,
  },
  ['auto', 'routes', 'revision'],
)

const MAGPIE_LIMIT = shape(
  {
    period: choice(MAGPIE_LIMIT_PERIODS, '周期'),
    days: { type: 'number', minimum: 0 },
    hours: { type: 'number', minimum: 0 },
    tokens: { type: 'number', minimum: 0 },
    cost: { type: 'number', minimum: 0 },
    cacheReads: flag('缓存读也计入'),
  },
  ['period'],
)

const MAGPIE_KEY_CHANGE = shape(
  {
    enabled: flag('启用'),
    limits: {
      type: 'array',
      items: MAGPIE_LIMIT,
      maxItems: 5,
      description: '限额 最多 5 条',
    },
    models: {
      type: ['array', 'null'],
      items: { type: 'string' },
      maxItems: 500,
      description: '模型白名单 · null 为全部',
    },
    mainModel: text('主模型'),
    fastModel: text('快模型 · null 清除', { type: ['string', 'null'] }),
    resetLimit: {
      anyOf: [
        { type: 'integer', minimum: 0 },
        { type: 'string', enum: ['all'] },
      ],
      description: '把一条限额重新计数 · 序号或 all',
    },
  },
  [],
  { minProperties: 1 },
)

const CHANNEL_FIELDS = {
  name: text('名称', { minLength: 1, maxLength: 80 }),
  platform: choice(
    ['qq', 'qq-personal', 'weixin', 'telegram', 'discord', 'slack'],
    '平台',
  ),
  enabled: flag('启用'),
  target: text('主人私聊对话的智能体地址', { pattern: ADDRESS_PATTERN }),
  memberTarget: text('群聊与其他人私聊的智能体地址 · null 不回应', {
    type: ['string', 'null'],
  }),
  ownerIds: texts('主人在该平台上的用户号'),
  allowAll: flag('放行所有人'),
  allowUsers: texts('放行的用户号'),
  allowGroups: texts('放行的群号'),
  groupTrigger: choice(['mention', 'all'], '群里什么时候回'),
  replyWindowMs: whole('回复窗口毫秒', 0),
  prompt: text('附加给智能体的说明'),
  pairing: choice(['auto', 'on', 'off'], '配对档位'),
  groupContext: flag('被 @ 时带上最近的群聊'),
  freeGroups: texts('不用 @ 也回的群'),
  keywords: texts('群里出现就回的词'),
  groupCooldownSeconds: whole('两次回复最短间隔秒', 0),
  groupSpeechMax: whole('每个时段最多回几条', 0),
  groupSpeechMinutes: whole('时段分钟', 0),
  settings: dictionary('平台的非秘密设置'),
  secrets: dictionary('平台凭据 · 留空保留原值'),
} as const satisfies Record<string, JsonSchema>
const CHANNEL_INPUT = shape(CHANNEL_FIELDS, ['name', 'platform', 'target'])

const SCHEDULE_WHEN: JsonSchema = {
  anyOf: [
    shape(
      {
        kind: choice(['daily'], '每天'),
        time: text('HH:MM', { pattern: '^\\d{2}:\\d{2}$' }),
      },
      ['kind', 'time'],
    ),
    shape(
      {
        kind: choice(['weekly'], '每周'),
        days: {
          type: 'array',
          items: { type: 'integer', minimum: 1, maximum: 7 },
          minItems: 1,
          maxItems: 7,
          description: '1–7 周一到周日',
        },
        time: text('HH:MM', { pattern: '^\\d{2}:\\d{2}$' }),
      },
      ['kind', 'days', 'time'],
    ),
    shape(
      {
        kind: choice(['interval'], '间隔'),
        everyMinutes: whole('每隔多少分钟', 1),
      },
      ['kind', 'everyMinutes'],
    ),
  ],
  description: '什么时候运行',
}
const SCHEDULE_INPUT = shape(
  {
    title: text('标题', { minLength: 1, maxLength: 80 }),
    target: text('目标智能体地址 · 须在对话白名单内', {
      pattern: ADDRESS_PATTERN,
    }),
    template: choice(SCHEDULE_TEMPLATES, '模板'),
    prompt: text('提示词'),
    when: SCHEDULE_WHEN,
    timezone: text('IANA 时区名'),
    direction: choice([...MODEL_DIRECTIONS, null], '任务方向 · null 自动'),
    channels: texts('通知渠道 id', 20),
    notifyOnlyAgent: flag('只在智能体要求时通知'),
    enabled: flag('启用'),
    timeoutMs: whole('超时毫秒', 1),
  },
  [
    'title',
    'target',
    'template',
    'prompt',
    'when',
    'timezone',
    'direction',
    'channels',
    'notifyOnlyAgent',
    'enabled',
    'timeoutMs',
  ],
)

const NOTIFY_KINDS = ['webhook', 'bark', 'wecom', 'feishu', 'ntfy'] as const

const EXTENSION_INPUT = shape({
  kind: choice(EXTENSION_KINDS, '种类'),
  name: text('名称'),
  description: text('说明'),
  enabled: flag('启用'),
  agents: texts('适用的智能体地址'),
  transport: choice(['stdio', 'http', 'sse'], 'MCP 传输'),
  command: text('stdio 命令'),
  args: texts('命令参数'),
  url: text('http 或 sse 地址'),
  env: dictionary('环境变量 · 值为 null 沿用已存的 · 没列出的删除', true),
  headers: dictionary('请求头 · 值为 null 沿用已存的 · 没列出的删除', true),
  approval: choice(['allow', 'ask'], '调用前是否确认'),
  body: text('技能正文'),
  source: shape(
    {
      repo: text('GitHub 仓库 owner/repo'),
      ref: text('引用'),
      path: text('目录'),
    },
    ['repo'],
  ),
})

const CONNECTOR_INPUT = shape(
  {
    tenant: text('租户 · 只有平台运维可选'),
    name: text('名称', { minLength: 1, maxLength: 80 }),
    kind: choice(['mail', 'calendar', 'repo'], '种类'),
    preset: text('预设'),
    settings: {
      type: 'object',
      additionalProperties: { type: ['string', 'number', 'boolean'] },
      description: '服务器 端口 账号 仓库这些非秘密字段',
    },
    secret: text('口令 授权码或令牌 · 修改时不给就保留原值'),
    agents: texts('能用这个连接的智能体地址'),
  },
  ['name', 'kind', 'preset', 'settings', 'agents'],
)

const DESKTOP_INPUT = shape(
  {
    browser: flag('专属浏览器'),
    computer: flag('专属电脑'),
    confirm: choice(['sensitive', 'always', 'autonomous'], '什么时候先问人'),
    apps: {
      anyOf: [
        { type: 'string', enum: ['all', 'none'] },
        {
          type: 'array',
          items: { type: 'string', minLength: 1, maxLength: 200 },
          minItems: 1,
          maxItems: 50,
        },
      ],
      description: '允许打开的应用 · all none 或编号列表',
    },
    terminal: flag('允许打开终端类应用'),
  },
  [],
  { minProperties: 1 },
)

const UPDATE_TIME: JsonSchema = {
  anyOf: [
    shape(
      {
        kind: choice(['daily'], '每天'),
        time: text('HH:MM', { pattern: '^\\d{2}:\\d{2}$' }),
      },
      ['kind', 'time'],
    ),
    shape(
      {
        kind: choice(['weekly'], '每周'),
        days: {
          type: 'array',
          items: { type: 'integer', minimum: 1, maximum: 7 },
          minItems: 1,
          maxItems: 7,
        },
        time: text('HH:MM', { pattern: '^\\d{2}:\\d{2}$' }),
      },
      ['kind', 'days', 'time'],
    ),
  ],
}

const UPDATES_INPUT = shape(
  {
    times: { type: 'array', items: UPDATE_TIME, maxItems: 20 },
    timezone: text('IANA 时区名'),
    actions: shape(
      Object.fromEntries(
        UPDATE_SOURCES.map(source => [
          source,
          choice(['notify', 'auto'], '只通知或自动处理'),
        ]),
      ),
    ),
    channels: texts('有新版本时推送的通知渠道 id', 20),
    repo: text('阡陌所在的 GitHub 仓库 · null 不查', {
      type: ['string', 'null'],
    }),
  },
  ['times', 'timezone', 'actions', 'channels', 'repo'],
)

const VERSION_INPUT = shape({
  version: text('版本号 x.y.z · 省略为最新发行', {
    pattern: '^\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?$',
  }),
})

const AVATAR_INPUT = shape(
  {
    shape: choice(AVATAR_SHAPES, '形状'),
    color: choice(AVATAR_COLORS, '颜色'),
    material: choice(AVATAR_MATERIALS, '质感'),
    eyes: choice(AVATAR_EYES, '眼睛'),
    mouth: choice(AVATAR_MOUTHS, '嘴'),
    cheeks: flag('腮红'),
    accessory: choice(AVATAR_ACCESSORIES, '配饰'),
  },
  ['shape', 'color', 'material', 'eyes', 'mouth', 'cheeks', 'accessory'],
)

// ---------------------------------------------------------------------------
// The catalog
// ---------------------------------------------------------------------------

const PERSON_ONLY = {
  approvals: '审批只能由本人在对话里的确认卡片或 /admin/approvals 上操作',
  accounts: '在 /admin/access 由运维本人操作',
  billing: '订阅与付款在 /admin/billing 由本人操作',
  device: '设备配对在 /admin/connect 由本人操作 · 配对码只给本人',
  pairing: '配对请求在 /admin/im 由运维本人处理',
  elevation:
    '在 /admin/elevation 由运维本人开启 · 降回人工确认用 elevation.off 或 elevation.revoke',
  ssh: '添加服务器在 /admin/servers 由运维本人填写 SSH 凭据',
  files: '文件申请在 /admin/files 由本人批准或拒绝',
  channel: '新建渠道与扫码登录在 /admin/im 由运维本人操作 · 扫码的人会成为主人',
  channelAccess:
    '主人号 放行名单 配对档位 对话的智能体 平台连接与凭据在 /admin/im 由运维本人改',
  updates:
    '更新仓库与自动处理在 /admin/updates 由运维本人改 · 改回只通知或不查可以申请',
  desktop:
    '在 /admin/desktop 由运维本人放宽 · 开浏览器 电脑或终端 少问人 多开应用 · 收紧可以申请',
} as const

/** The fields of a channel that say who reaches which agent through it. */
const CHANNEL_ACCESS = [
  'target',
  'memberTarget',
  'ownerIds',
  'allowAll',
  'allowUsers',
  'allowGroups',
  'pairing',
] as const

/** A channel field as the port keeps it: lists as sets, no address as null. */
function accessValue(key: string, value: unknown): string {
  if (Array.isArray(value))
    return JSON.stringify(
      [...new Set(value.map(item => String(item).trim()))]
        .filter(item => item !== '')
        .sort(),
    )
  if (key === 'memberTarget' && (value === undefined || value === ''))
    return 'null'
  if (key === 'allowAll' && value === undefined) return 'false'
  return JSON.stringify(value ?? null)
}

/**
 * Whether a channel change touches who may reach an agent through it: the
 * owner ids, the allow lists, the pairing mode or the two agent addresses.
 * Fields left out keep their value (`consoleChannels.ts`); a channel that
 * cannot be read counts as touched.
 */
function channelAccessChanged(input: Args, current: unknown): boolean {
  const before = recordOf(current)
  return CHANNEL_ACCESS.some(
    key =>
      input[key] !== undefined &&
      (before === null ||
        accessValue(key, input[key]) !== accessValue(key, before[key])),
  )
}

/**
 * Whether a channel change moves where it connects or as whom: the platform,
 * its non-secret settings (a SnowLuma URL is one) or any credential. Whoever
 * answers at a new endpoint can claim to be the owner (§2). `settings` is
 * compared with what an ops reader sees: below ops `/v0/im` blanks it, and
 * every save carrying settings would then count as a change.
 */
function channelTransportChanged(input: Args, current: unknown): boolean {
  const before = recordOf(current)
  if (
    input['platform'] !== undefined &&
    input['platform'] !== before?.['platform']
  )
    return true
  if (
    input['settings'] !== undefined &&
    stableJson(input['settings']) !== stableJson(before?.['settings'] ?? {})
  )
    return true
  const secrets = recordOf(input['secrets'])
  return (
    secrets !== null &&
    Object.values(secrets).some(
      value => typeof value === 'string' && value !== '',
    )
  )
}

/**
 * Whether an update change widens what runs unasked: another repository to
 * take releases from, or a source that only notified now acting on its own.
 * Stopping checks (`repo: null`) or going back to notify narrows (§2).
 */
function updatesWiden(input: Args, current: unknown): boolean {
  const before = recordOf(current)
  const repo = input['repo']
  if (
    repo !== undefined &&
    repo !== null &&
    repo !== '' &&
    repo !== before?.['repo']
  )
    return true
  const actions = recordOf(input['actions'])
  const was = recordOf(before?.['actions'])
  return (
    actions !== null &&
    Object.entries(actions).some(
      ([source, action]) => action === 'auto' && was?.[source] !== 'auto',
    )
  )
}

/** How often each mode asks a person first: the more, the narrower. */
const CONFIRM_RANK: Readonly<Record<string, number>> = {
  autonomous: 0,
  sensitive: 1,
  always: 2,
}

/** Whether `next` lets more apps open than `before` (absent is `all`). */
function appsWiden(next: unknown, before: unknown): boolean {
  if (next === 'none') return false
  const was = before === null || before === undefined ? 'all' : before
  if (was === 'all') return false
  if (!Array.isArray(next)) return true
  if (!Array.isArray(was)) return true
  return next.some(id => !was.includes(id))
}

/**
 * Whether a desktop change gives the agent more than it has (§2): a unit or
 * the terminal switched on, fewer questions asked first, more apps allowed.
 * Switching off, asking more and narrowing the apps stay the agent's to ask
 * for. An agent the console cannot read counts as having nothing.
 */
function desktopRaises(input: Args, current: unknown): boolean {
  const before = recordOf(current)
  for (const unit of ['browser', 'computer', 'terminal'])
    if (input[unit] === true && before?.[unit] !== true) return true
  const confirm = input['confirm']
  if (
    confirm !== undefined &&
    (CONFIRM_RANK[String(confirm)] ?? 0) <
      (CONFIRM_RANK[String(before?.['confirm'])] ?? 2)
  )
    return true
  const apps = input['apps']
  if (apps === undefined) return false
  return before === null ? apps !== 'none' : appsWiden(apps, before['apps'])
}

/** The `/v0` body for an op whose target rides in the body too. */
function withTarget(target: Args, input: Args): Record<string, unknown> {
  return { ...input, ...target }
}

const CATALOG: readonly SettingOperation[] = [
  // --- 模型 ---------------------------------------------------------------
  {
    id: 'providers.default',
    area: 'providers',
    label: '默认模型服务',
    description: '全局默认的模型服务档案 · null 清除',
    kind: 'set',
    role: 'ops',
    input: shape(
      {
        profileId: text('档案 id · null 清除', { type: ['string', 'null'] }),
      },
      ['profileId'],
    ),
    route: 'PUT /v0/providers/default',
    request: (_target, input) => ({
      method: 'PUT',
      path: '/v0/providers/default',
      body: input,
    }),
    current: async read => ({
      profileId:
        recordOf(await read.get('/v0/providers'))?.['defaultProfileId'] ?? null,
    }),
    page: '/admin/providers',
  },
  {
    id: 'providers.profile.create',
    area: 'providers',
    label: '模型服务档案',
    description: '从预设新建一份档案 · 密钥放在 secrets 里按 keyId 给',
    kind: 'create',
    role: 'ops',
    input: shape(
      {
        presetId: text('预设 id'),
        site: text('站点'),
        profile: PROFILE_EDIT,
        secrets: dictionary('keyId 到密钥'),
      },
      ['presetId', 'profile'],
    ),
    secrets: ['secrets.*'],
    route: 'POST /v0/providers/profiles',
    request: (_target, input) => ({
      method: 'POST',
      path: '/v0/providers/profiles',
      body: input,
    }),
    page: '/admin/providers/new',
  },
  {
    id: 'providers.profile.save',
    area: 'providers',
    label: '模型服务档案',
    description: '保存一份档案 · 加一把或删一把密钥也是保存',
    kind: 'update',
    role: 'ops',
    target: shape({ profileId: text('档案 id') }, ['profileId']),
    input: shape(
      {
        profile: PROFILE_EDIT,
        ifMatch: REVISION,
        secrets: dictionary('新那把的 keyId 到密钥'),
      },
      ['profile', 'ifMatch'],
    ),
    secrets: ['secrets.*'],
    route: 'PUT /v0/providers/profiles/<档案 id>',
    request: (target, input) => ({
      method: 'PUT',
      path: `/v0/providers/profiles/${seg(target['profileId'])}`,
      body: input,
    }),
    current: async (read, target) =>
      profileBrief(
        await read.get(`/v0/providers/profiles/${seg(target['profileId'])}`),
      ),
    page: '/admin/providers',
  },
  {
    id: 'providers.profile.remove',
    area: 'providers',
    label: '模型服务档案',
    description: '删除一份档案 · 还有节点在用时被拒',
    kind: 'remove',
    role: 'ops',
    target: shape({ profileId: text('档案 id') }, ['profileId']),
    input: shape({ ifMatch: REVISION }, ['ifMatch']),
    route: 'DELETE /v0/providers/profiles/<档案 id>',
    request: (target, input) => ({
      method: 'DELETE',
      path: `/v0/providers/profiles/${seg(target['profileId'])}`,
      body: input,
    }),
    current: async (read, target) =>
      profileBrief(
        await read.get(`/v0/providers/profiles/${seg(target['profileId'])}`),
      ),
    page: '/admin/providers',
  },
  {
    id: 'providers.key.set',
    area: 'providers',
    label: '档案密钥',
    description: '重新填写档案里的一把密钥',
    kind: 'update',
    role: 'ops',
    target: shape({ profileId: text('档案 id'), keyId: text('密钥编号') }, [
      'profileId',
      'keyId',
    ]),
    input: shape({ value: text('密钥', { minLength: 1 }), ifMatch: REVISION }, [
      'value',
      'ifMatch',
    ]),
    secrets: ['value'],
    route: 'PUT /v0/providers/profiles/<档案 id>/keys/<key id>',
    request: (target, input) => ({
      method: 'PUT',
      path: `/v0/providers/profiles/${seg(target['profileId'])}/keys/${seg(target['keyId'])}`,
      body: input,
    }),
    current: (read, target) => keyBrief(read, target),
    page: '/admin/providers',
  },
  {
    id: 'providers.key.clear',
    area: 'providers',
    label: '档案密钥',
    description: '清除档案里的一把密钥',
    kind: 'remove',
    role: 'ops',
    target: shape({ profileId: text('档案 id'), keyId: text('密钥编号') }, [
      'profileId',
      'keyId',
    ]),
    input: shape({ ifMatch: REVISION }, ['ifMatch']),
    route: 'DELETE /v0/providers/profiles/<档案 id>/keys/<key id>',
    request: (target, input) => ({
      method: 'DELETE',
      path: `/v0/providers/profiles/${seg(target['profileId'])}/keys/${seg(target['keyId'])}`,
      body: input,
    }),
    current: (read, target) => keyBrief(read, target),
    page: '/admin/providers',
  },
  {
    id: 'providers.node.assignment',
    area: 'providers',
    label: '节点的模型服务',
    description: '继承默认 · 单独指定一份档案 · 或不托管',
    kind: 'set',
    role: 'ops',
    target: NODE_TARGET,
    input: shape(
      {
        mode: choice(['inherit', 'profile', 'unmanaged'], '指派方式'),
        profileId: text('mode 为 profile 时的档案 id'),
      },
      ['mode'],
    ),
    route: 'PUT /v0/providers/nodes/<节点>/assignment',
    request: (target, input) => ({
      method: 'PUT',
      path: `/v0/providers/nodes/${seg(target['node'])}/assignment`,
      body: input,
    }),
    current: async (read, target) =>
      recordOf(await read.get(`/v0/providers/nodes/${seg(target['node'])}`))?.[
        'assignment'
      ] ?? null,
    page: '/admin/providers',
  },
  {
    id: 'providers.node.context',
    area: 'providers',
    label: '上下文窗口',
    description: '节点的上下文窗口覆盖 · 随下一次下发生效 · null 清除',
    kind: 'set',
    role: 'ops',
    target: NODE_TARGET,
    input: shape(
      {
        tokens: {
          type: ['integer', 'string', 'null'],
          description: 'token 数 · 200000 或 200k 或 1M · null 清除',
        },
      },
      ['tokens'],
    ),
    route: 'PUT /v0/providers/nodes/<节点>/context',
    request: (target, input) => ({
      method: 'PUT',
      path: `/v0/providers/nodes/${seg(target['node'])}/context`,
      body: input,
    }),
    current: async (read, target) => ({
      tokens:
        recordOf(
          await read.get(`/v0/providers/nodes/${seg(target['node'])}`),
        )?.['contextOverride'] ?? null,
    }),
    page: '/admin/providers',
  },
  {
    id: 'providers.node.autocompact',
    area: 'providers',
    label: '自动压缩阈值',
    description: '立即写到节点 · auto 或 100k 到 1M',
    kind: 'set',
    role: 'ops',
    target: NODE_TARGET,
    input: shape(
      {
        value: {
          type: ['integer', 'string'],
          description: 'auto 或 token 数',
        },
      },
      ['value'],
    ),
    route: 'PUT /v0/providers/nodes/<节点>/autocompact',
    request: (target, input) => ({
      method: 'PUT',
      path: `/v0/providers/nodes/${seg(target['node'])}/autocompact`,
      body: input,
    }),
    current: async (read, target) => {
      const found = recordOf(
        await read.get(
          `/v0/providers/nodes/${seg(target['node'])}/autocompact`,
        ),
      )
      if (found === null) return null
      return {
        value:
          found['source'] === 'auto' ? 'auto' : (found['configured'] ?? null),
      }
    },
    page: '/admin/providers',
  },
  {
    id: 'providers.apply',
    area: 'providers',
    label: '下发模型服务',
    description: '把档案下发到节点 · 每个节点一条结果',
    kind: 'run',
    role: 'ops',
    input: shape({
      nodes: texts('节点名 · 省略为全部'),
      force: flag('即使节点上的配置有漂移也下发'),
      sessions: choice(['keep', 'reset'], '会话保留或重开'),
      profileId: text('只下发这份档案'),
      routingRevision: whole('任务分工卡片画出时的路由簿修订号', 0),
    }),
    route: 'POST /v0/providers/apply',
    request: (_target, input) => ({
      method: 'POST',
      path: '/v0/providers/apply',
      body: input,
    }),
    page: '/admin/providers',
  },
  {
    id: 'providers.import',
    area: 'providers',
    label: '导入模型服务档案',
    description: '导入导出的档案文件 · 导入的档案没有密钥',
    kind: 'create',
    role: 'ops',
    input: shape(
      {
        text: text('导出文件的内容', { minLength: 1 }),
        renames: dictionary('撞 id 时另存的新 id'),
      },
      ['text'],
    ),
    route: 'POST /v0/providers/import',
    request: (_target, input) => ({
      method: 'POST',
      path: '/v0/providers/import',
      body: input,
    }),
    page: '/admin/providers/import',
  },

  // --- 任务模型 -------------------------------------------------------------
  {
    id: 'routing.set',
    area: 'routing',
    label: '任务模型',
    description: '默认或某个节点按方向用哪个模型 · 只给要改的方向',
    kind: 'set',
    role: 'ops',
    target: shape(
      { node: text('节点名 · null 改默认', { type: ['string', 'null'] }) },
      ['node'],
    ),
    input: ROUTING_INPUT,
    route: 'PUT /v0/routing',
    request: (target, input) => ({
      method: 'PUT',
      path: '/v0/routing',
      body: { ...input, node: target['node'] ?? null },
    }),
    current: async (read, target) => {
      const snapshot = await read.get('/v0/routing')
      const view =
        target['node'] === null || target['node'] === undefined
          ? recordOf(recordOf(snapshot)?.['defaults'])
          : rowsOf(snapshot, 'nodes').find(
              row => row['node'] === target['node'],
            )
      return pick(view, fieldsOf(ROUTING_INPUT))
    },
    page: '/admin/providers#routing',
  },
  {
    id: 'routing.node.reset',
    area: 'routing',
    label: '节点单独的任务模型',
    description: '去掉这个节点单独的分工 · 回到默认',
    kind: 'remove',
    role: 'ops',
    target: NODE_TARGET,
    route: 'DELETE /v0/routing/nodes/<节点>',
    request: target => ({
      method: 'DELETE',
      path: `/v0/routing/nodes/${seg(target['node'])}`,
    }),
    current: (read, target) =>
      rowIn(
        read,
        '/v0/routing',
        'nodes',
        row => row['node'] === target['node'],
        fieldsOf(ROUTING_INPUT),
      ),
    page: '/admin/providers#routing',
  },

  // --- 网关 ---------------------------------------------------------------
  {
    id: 'magpie.connect',
    area: 'magpie',
    label: '网关连接',
    description: '网关与管理接口的地址 · 管理密钥不给就沿用',
    kind: 'set',
    role: 'ops',
    input: shape(
      {
        gatewayUrl: text('网关 origin'),
        managementUrl: text('管理接口 origin'),
        managementKey: text('管理密钥'),
        webCookiePort: whole('网页登录端口', 1, 65535),
      },
      ['gatewayUrl', 'managementUrl'],
    ),
    secrets: ['managementKey'],
    route: 'POST /v0/magpie/connection',
    request: (_target, input) => ({
      method: 'POST',
      path: '/v0/magpie/connection',
      body: input,
    }),
    current: async read =>
      pick(recordOf(await read.get('/v0/magpie'))?.['connection'], [
        'gatewayUrl',
        'managementUrl',
        'keySet',
      ]),
    page: '/admin/magpie',
  },
  {
    id: 'magpie.check',
    area: 'magpie',
    label: '核对网关',
    description: '核对管理接口与网关侧 · 把每把密钥的模型白名单改回合格范围',
    kind: 'run',
    role: 'ops',
    route: 'POST /v0/magpie/check',
    request: () => ({ method: 'POST', path: '/v0/magpie/check', body: {} }),
    page: '/admin/magpie',
  },
  {
    id: 'magpie.provider.add',
    area: 'magpie',
    label: '网关上游',
    description: '添加一个 API 密钥上游 · 预设或自定义地址 · 密钥只交给网关',
    kind: 'create',
    role: 'ops',
    input: shape(
      {
        preset: text('网关预设 · 自定义时为空串'),
        key: text('上游 API 密钥'),
        name: text('名称 · 自定义时必填'),
        chat: text('chat 地址 以 /v1 结尾'),
        responses: text('responses 地址 以 /v1 结尾'),
        anthropic: text('anthropic 源站'),
      },
      ['preset'],
    ),
    secrets: ['key'],
    route: 'POST /v0/magpie/providers',
    request: (_target, input) => ({
      method: 'POST',
      path: '/v0/magpie/providers',
      body: input,
    }),
    page: '/admin/magpie',
  },
  {
    id: 'magpie.provider.toggle',
    area: 'magpie',
    label: '网关上游启用',
    description: '启用或停用一个上游',
    kind: 'set',
    role: 'ops',
    target: idTarget('上游 id'),
    input: shape({ enabled: flag('启用') }, ['enabled']),
    route: 'POST /v0/magpie/providers/<上游 id>',
    request: (target, input) => ({
      method: 'POST',
      path: `/v0/magpie/providers/${seg(target['id'])}`,
      body: input,
    }),
    current: (read, target) =>
      rowIn(read, '/v0/magpie', 'providers', byId(target), ['enabled']),
    page: '/admin/magpie',
  },
  {
    id: 'magpie.provider.remove',
    area: 'magpie',
    label: '网关上游',
    description: '删除一个上游',
    kind: 'remove',
    role: 'ops',
    target: idTarget('上游 id'),
    route: 'DELETE /v0/magpie/providers/<上游 id>',
    request: target => ({
      method: 'DELETE',
      path: `/v0/magpie/providers/${seg(target['id'])}`,
    }),
    current: (read, target) =>
      rowIn(read, '/v0/magpie', 'providers', byId(target), [
        'name',
        'preset',
        'host',
        'enabled',
      ]),
    page: '/admin/magpie',
  },
  {
    id: 'magpie.provider.test',
    area: 'magpie',
    label: '测试网关上游',
    description: '网关向上游发一次最小请求 · 答协议 状态码与耗时',
    kind: 'run',
    role: 'ops',
    target: idTarget('上游 id'),
    route: 'POST /v0/magpie/providers/<上游 id>/test',
    request: target => ({
      method: 'POST',
      path: `/v0/magpie/providers/${seg(target['id'])}/test`,
      body: {},
    }),
    page: '/admin/magpie',
  },
  {
    id: 'magpie.group.save',
    area: 'magpie',
    label: '路由组',
    description: '新建或保存路由组 · 没给的字段沿用网关里的',
    kind: 'update',
    role: 'ops',
    target: idTarget('路由组 id'),
    input: shape({
      from: text('从这个路由组复制'),
      name: text('名称'),
      members: texts('成员上游'),
      routing: choice(MAGPIE_ROUTINGS, '路由方式'),
      affinity: choice(MAGPIE_AFFINITIES, '粘连'),
    }),
    route: 'POST /v0/magpie/groups',
    request: (target, input) => ({
      method: 'POST',
      path: '/v0/magpie/groups',
      body: withTarget(target, input),
    }),
    current: (read, target) =>
      rowIn(read, '/v0/magpie', 'groups', byId(target), [
        'name',
        'members',
        'routing',
        'affinity',
      ]),
    page: '/admin/magpie',
  },
  {
    id: 'magpie.group.remove',
    area: 'magpie',
    label: '路由组',
    description: '删除路由组',
    kind: 'remove',
    role: 'ops',
    target: idTarget('路由组 id'),
    route: 'DELETE /v0/magpie/groups/<路由组 id>',
    request: target => ({
      method: 'DELETE',
      path: `/v0/magpie/groups/${seg(target['id'])}`,
    }),
    current: (read, target) =>
      rowIn(read, '/v0/magpie', 'groups', byId(target), ['name', 'members']),
    page: '/admin/magpie',
  },
  {
    id: 'magpie.key.issue',
    area: 'magpie',
    label: '网关密钥',
    description: '为节点或租户签发网关密钥并写死模型白名单',
    kind: 'create',
    role: 'ops',
    input: shape(
      {
        binding: text('node:<节点> 或 tenant:<租户>', {
          pattern: '^(node|tenant):.+$',
        }),
        mainModel: text('主模型'),
        fastModel: text('快模型'),
        lane: choice(MAGPIE_LANES, '线路'),
        limits: { type: 'array', items: MAGPIE_LIMIT, maxItems: 5 },
        models: texts('模型白名单'),
      },
      ['binding', 'mainModel'],
    ),
    route: 'POST /v0/magpie/keys',
    request: (_target, input) => ({
      method: 'POST',
      path: '/v0/magpie/keys',
      body: input,
    }),
    page: '/admin/magpie',
  },
  {
    id: 'magpie.key.update',
    area: 'magpie',
    label: '网关密钥',
    description: '改一把网关密钥的启用 限额 白名单与模型',
    kind: 'update',
    role: 'ops',
    target: shape(
      {
        binding: text('node:<节点> 或 tenant:<租户>', {
          pattern: '^(node|tenant):.+$',
        }),
      },
      ['binding'],
    ),
    input: MAGPIE_KEY_CHANGE,
    route: 'POST /v0/magpie/keys/<绑定>',
    request: (target, input) => ({
      method: 'POST',
      path: `/v0/magpie/keys/${seg(target['binding'])}`,
      body: input,
    }),
    current: (read, target) => keyOf(read, target),
    page: '/admin/magpie',
  },
  {
    id: 'magpie.key.remove',
    area: 'magpie',
    label: '网关密钥',
    description: '先把节点换回原来的指派再删密钥与档案',
    kind: 'remove',
    role: 'ops',
    target: shape({ binding: text('node:<节点> 或 tenant:<租户>') }, [
      'binding',
    ]),
    route: 'DELETE /v0/magpie/keys/<绑定>',
    request: target => ({
      method: 'DELETE',
      path: `/v0/magpie/keys/${seg(target['binding'])}`,
    }),
    current: (read, target) => keyOf(read, target),
    page: '/admin/magpie',
  },
  {
    id: 'magpie.key.rotate',
    area: 'magpie',
    label: '轮换网关密钥',
    description: '网关生成新值 · 中枢写进档案再下发 · 限额与用量不变',
    kind: 'run',
    role: 'ops',
    target: shape({ binding: text('node:<节点> 或 tenant:<租户>') }, [
      'binding',
    ]),
    route: 'POST /v0/magpie/keys/<绑定>/rotate',
    request: target => ({
      method: 'POST',
      path: `/v0/magpie/keys/${seg(target['binding'])}/rotate`,
      body: {},
    }),
    page: '/admin/magpie',
  },
  {
    id: 'magpie.autojoin',
    area: 'magpie',
    label: '新节点自动接入网关',
    description: '新节点上线时自动签发网关密钥',
    kind: 'set',
    role: 'ops',
    input: shape({ on: flag('开') }, ['on']),
    route: 'POST /v0/magpie/agents/autojoin',
    request: (_target, input) => ({
      method: 'POST',
      path: '/v0/magpie/agents/autojoin',
      body: input,
    }),
    current: async read => ({
      on: recordOf(await read.get('/v0/magpie/agents'))?.['autoJoin'] ?? null,
    }),
    page: '/admin/magpie#agents',
  },
  {
    id: 'magpie.join',
    area: 'magpie',
    label: '节点接入网关',
    description: '为这个节点签发网关密钥并指派',
    kind: 'run',
    role: 'ops',
    target: NODE_TARGET,
    route: 'POST /v0/magpie/agents/join',
    request: target => ({
      method: 'POST',
      path: '/v0/magpie/agents/join',
      body: { node: target['node'] },
    }),
    page: '/admin/magpie#agents',
  },

  // --- 智能体 -------------------------------------------------------------
  {
    id: 'agents.runtime',
    area: 'agents',
    label: '智能体底层与模型',
    description: '改智能体的底层或网关模型 · 模型号或 auto',
    kind: 'set',
    role: 'ops',
    target: AGENT_TARGET,
    input: shape(
      {
        runtime: text('底层 id', { pattern: '^[a-z0-9][a-z0-9-]{0,39}$' }),
        model: text('网关模型号或 auto'),
      },
      [],
      { minProperties: 1 },
    ),
    route: 'POST /v0/magpie/agents/{configure,install,remove,autojoin,join}',
    request: (target, input) => ({
      method: 'POST',
      path: '/v0/magpie/agents/configure',
      body: withTarget(target, input),
    }),
    current: async (read, target) => {
      const node = rowsOf(await read.get('/v0/magpie/agents'), 'nodes').find(
        row => row['node'] === target['node'],
      )
      const agent = rowsOf(node, 'agents').find(
        row => row['agent'] === target['agent'],
      )
      return agent === undefined ? null : pick(agent, ['runtime', 'model'])
    },
    page: '/admin/magpie#agents',
  },
  {
    id: 'agents.model',
    area: 'agents',
    label: '智能体模型字段',
    description:
      '改一个原生字段 · model effort 与底层自己的分档 · <来源>/<模型号> 或强度 · 空串跟随',
    kind: 'set',
    role: 'ops',
    target: shape(
      {
        node: NODE,
        agent: AGENT,
        field: text('字段名', { pattern: '^[a-z][a-z_]{0,31}$' }),
      },
      ['node', 'agent', 'field'],
    ),
    input: shape({ value: text('新值', { maxLength: 256 }) }, ['value']),
    route: 'POST /v0/magpie/agents/{configure,install,remove,autojoin,join}',
    request: (target, input) => ({
      method: 'POST',
      path: '/v0/magpie/agents/configure',
      body: withTarget(target, input),
    }),
    current: async (read, target) => {
      const node = rowsOf(
        await read.get('/v0/magpie/agents/models'),
        'nodes',
      ).find(row => row['node'] === target['node'])
      const agent = rowsOf(node, 'agents').find(
        row => row['agent'] === target['agent'],
      )
      const field = rowsOf(agent, 'fields').find(
        row => row['key'] === target['field'],
      )
      return field === undefined ? null : { value: field['value'] }
    },
    page: '/admin/magpie#agents',
  },
  {
    id: 'agents.runtime.install',
    area: 'agents',
    label: '安装底层',
    description: '在节点上装一个底层 · 进度在网关页',
    kind: 'run',
    role: 'ops',
    target: shape({ node: NODE, runtime: text('底层 id') }, [
      'node',
      'runtime',
    ]),
    route: 'POST /v0/magpie/agents/{configure,install,remove,autojoin,join}',
    request: target => ({
      method: 'POST',
      path: '/v0/magpie/agents/install',
      body: { node: target['node'], runtime: target['runtime'] },
    }),
    page: '/admin/magpie#agents',
  },
  {
    id: 'agents.runtime.remove',
    area: 'agents',
    label: '卸载底层',
    description: '卸掉节点上的一个底层 · 还有智能体配在上面时节点拒绝',
    kind: 'remove',
    role: 'ops',
    target: shape({ node: NODE, runtime: text('底层 id') }, [
      'node',
      'runtime',
    ]),
    route: 'POST /v0/magpie/agents/{configure,install,remove,autojoin,join}',
    request: target => ({
      method: 'POST',
      path: '/v0/magpie/agents/remove',
      body: { node: target['node'], runtime: target['runtime'] },
    }),
    page: '/admin/magpie#agents',
  },
  {
    id: 'agents.extension.install',
    area: 'agents',
    label: '智能体原生扩展',
    description: '由该底层自己的命令装插件 MCP 或技能',
    kind: 'create',
    role: 'ops',
    target: AGENT_TARGET,
    input: shape(
      {
        kind: choice(MAGPIE_EXTENSION_KINDS, '种类'),
        source: text('来源 · GitHub owner/repo 或 npm 包名'),
        name: text('MCP 名称'),
        command: text('MCP stdio 命令'),
        args: texts('命令参数'),
        url: text('MCP https 地址'),
      },
      ['kind'],
    ),
    route: 'POST /v0/magpie/agents/<节点>/<智能体>/extensions/{install,remove}',
    request: (target, input) => ({
      method: 'POST',
      path: `/v0/magpie/agents/${seg(target['node'])}/${seg(target['agent'])}/extensions/install`,
      body: input,
    }),
    page: '/admin/magpie#agents',
  },
  {
    id: 'agents.extension.remove',
    area: 'agents',
    label: '智能体原生扩展',
    description: '经该底层卸掉一个原生扩展',
    kind: 'remove',
    role: 'ops',
    target: AGENT_TARGET,
    input: shape(
      { kind: choice(MAGPIE_EXTENSION_KINDS, '种类'), name: text('名字') },
      ['kind', 'name'],
    ),
    route: 'POST /v0/magpie/agents/<节点>/<智能体>/extensions/{install,remove}',
    request: (target, input) => ({
      method: 'POST',
      path: `/v0/magpie/agents/${seg(target['node'])}/${seg(target['agent'])}/extensions/remove`,
      body: input,
    }),
    page: '/admin/magpie#agents',
  },
  {
    id: 'agents.avatar.set',
    area: 'agents',
    label: '智能体形象',
    description: '七项都从固定清单里选',
    kind: 'set',
    role: 'member',
    target: ADDRESS_TARGET,
    input: AVATAR_INPUT,
    route: 'PUT /v0/avatars/<键>',
    request: (target, input) => ({
      method: 'PUT',
      path: `/v0/avatars/${seg(`agent:${String(target['address'])}`)}`,
      body: input,
    }),
    current: (read, target) => avatarOf(read, target),
    page: '/',
  },
  {
    id: 'agents.avatar.reset',
    area: 'agents',
    label: '智能体形象',
    description: '回到默认形象',
    kind: 'remove',
    role: 'member',
    target: ADDRESS_TARGET,
    route: 'DELETE /v0/avatars/<键>',
    request: target => ({
      method: 'DELETE',
      path: `/v0/avatars/${seg(`agent:${String(target['address'])}`)}`,
    }),
    current: (read, target) => avatarOf(read, target),
    page: '/',
  },

  // --- 节点 ---------------------------------------------------------------
  {
    id: 'nodes.agent.publish',
    area: 'nodes',
    label: '发布智能体',
    description: '注册进注册中心并由本控制台续租',
    kind: 'create',
    role: 'ops',
    input: shape(
      {
        address: ADDRESS,
        endpoint: text('端点 · 有托管清单时可省略'),
        capabilities: texts('能力'),
        publicKey: text('公钥'),
        status: text('状态'),
      },
      ['address'],
    ),
    route: 'POST /v0/agents',
    request: (_target, input) => ({
      method: 'POST',
      path: '/v0/agents',
      body: input,
    }),
    page: '/admin/nodes',
  },
  {
    id: 'nodes.agent.deregister',
    area: 'nodes',
    label: '注销智能体',
    description: '出登记簿 停止续租 再删注册中心那条',
    kind: 'remove',
    role: 'ops',
    target: ADDRESS_TARGET,
    route: 'DELETE /v0/agents/<地址>',
    request: target => ({
      method: 'DELETE',
      path: `/v0/agents/${seg(target['address'])}`,
    }),
    current: (read, target) => registrationOf(read, target),
    page: '/admin/nodes',
  },
  ...(['pause', 'resume', 'retire'] as const).map(
    (verb): SettingOperation => ({
      id: `nodes.agent.${verb}`,
      area: 'nodes',
      label: {
        pause: '暂停智能体',
        resume: '恢复智能体',
        retire: '退役智能体',
      }[verb],
      description: {
        pause: '停止续租并删注册中心那条 · 对话 唤醒与值守都不再拨它',
        resume: '写回 active 并重新注册续租',
        retire: '这个地址从此不再发布 也不再恢复',
      }[verb],
      kind: 'run',
      role: 'ops',
      target: ADDRESS_TARGET,
      route: `POST /v0/agents/<地址>/${verb}`,
      request: target => ({
        method: 'POST',
        path: `/v0/agents/${seg(target['address'])}/${verb}`,
      }),
      current: (read, target) => registrationOf(read, target),
      page: '/admin/nodes',
    }),
  ),

  // --- 初始化配置 -----------------------------------------------------------
  {
    id: 'setup.main',
    area: 'setup',
    label: '主智能体',
    description: '对话前台默认的主智能体 · null 回到启动参数',
    kind: 'set',
    role: 'ops',
    input: shape(
      {
        address: text('智能体地址 · null 回到启动参数', {
          type: ['string', 'null'],
          pattern: ADDRESS_PATTERN,
        }),
      },
      ['address'],
    ),
    route: 'PUT /v0/setup/main',
    request: (_target, input) => ({
      method: 'PUT',
      path: '/v0/setup/main',
      body: input,
    }),
    current: async read => {
      const setup = recordOf(await read.get('/v0/setup'))
      return {
        address: setup?.['mainFromPage'] === true ? setup['main'] : null,
      }
    },
    page: '/admin/setup',
  },

  // --- 渠道 ---------------------------------------------------------------
  {
    id: 'im.create',
    area: 'im',
    label: '聊天渠道',
    description: '新建一个聊天渠道并连上平台',
    kind: 'create',
    role: 'ops',
    human: PERSON_ONLY.channel,
    input: CHANNEL_INPUT,
    secrets: ['secrets.*'],
    route: 'POST /v0/im',
    request: (_target, input) => ({
      method: 'POST',
      path: '/v0/im',
      body: input,
    }),
    page: '/admin/im',
  },
  {
    id: 'im.save',
    area: 'im',
    label: '聊天渠道',
    description: '修改一个渠道 · 秘密字段留空保留原值 · 没给的字段保留原值',
    kind: 'update',
    role: 'ops',
    personOnly: {
      note: PERSON_ONLY.channelAccess,
      when: (input, current) =>
        channelAccessChanged(input, current) ||
        channelTransportChanged(input, current),
    },
    target: idTarget('渠道 id'),
    input: CHANNEL_INPUT,
    secrets: ['secrets.*'],
    route: 'POST /v0/im',
    request: (target, input) => ({
      method: 'POST',
      path: '/v0/im',
      body: withTarget(target, input),
    }),
    current: (read, target) =>
      rowIn(
        read,
        '/v0/im',
        'channels',
        byId(target),
        fieldsOf(CHANNEL_INPUT).filter(key => key !== 'secrets'),
      ),
    page: '/admin/im',
  },
  {
    id: 'im.remove',
    area: 'im',
    label: '聊天渠道',
    description: '停掉连接并删除渠道及其凭据 · 会话保留',
    kind: 'remove',
    role: 'ops',
    target: idTarget('渠道 id'),
    route: 'DELETE /v0/im/<渠道 id>',
    request: target => ({
      method: 'DELETE',
      path: `/v0/im/${seg(target['id'])}`,
    }),
    current: (read, target) =>
      rowIn(read, '/v0/im', 'channels', byId(target), [
        'name',
        'platform',
        'enabled',
        'target',
      ]),
    page: '/admin/im',
  },
  {
    id: 'im.login',
    area: 'im',
    label: '微信扫码登录',
    description: '向官方接口取二维码 · 扫码人记为主人',
    kind: 'run',
    role: 'ops',
    human: PERSON_ONLY.channel,
    input: shape(
      {
        id: text('已有渠道的 id'),
        name: CHANNEL_FIELDS.name,
        platform: CHANNEL_FIELDS.platform,
        target: CHANNEL_FIELDS.target,
        memberTarget: CHANNEL_FIELDS.memberTarget,
      },
      ['name', 'platform', 'target'],
    ),
    route: 'POST /v0/im/login',
    request: (_target, input) => ({
      method: 'POST',
      path: '/v0/im/login',
      body: input,
    }),
    page: '/admin/im',
  },
  {
    id: 'im.pairing',
    area: 'im',
    label: '渠道配对请求',
    description: '把陌生人加进主人号或放行名单 · 或拒绝',
    kind: 'update',
    role: 'ops',
    human: PERSON_ONLY.pairing,
    target: idTarget('渠道 id'),
    input: shape(
      {
        requestId: text('配对请求 id'),
        decision: choice(['owner', 'member', 'deny'], '处理方式'),
      },
      ['requestId', 'decision'],
    ),
    route: 'POST /v0/im/<渠道 id>/pairing',
    request: (target, input) => ({
      method: 'POST',
      path: `/v0/im/${seg(target['id'])}/pairing`,
      body: input,
    }),
    page: '/admin/im',
  },

  // --- 定时任务 -------------------------------------------------------------
  {
    id: 'schedules.create',
    area: 'schedules',
    label: '定时任务',
    description: '新建一个定时任务 · 目标须在对话白名单内',
    kind: 'create',
    role: 'member',
    input: SCHEDULE_INPUT,
    route: 'POST /v0/schedules',
    request: (_target, input) => ({
      method: 'POST',
      path: '/v0/schedules',
      body: input,
    }),
    page: '/admin/jobs',
  },
  {
    id: 'schedules.save',
    area: 'schedules',
    label: '定时任务',
    description: '保存一个定时任务',
    kind: 'update',
    role: 'member',
    target: idTarget('任务 id'),
    input: SCHEDULE_INPUT,
    route: 'POST /v0/schedules',
    request: (target, input) => ({
      method: 'POST',
      path: '/v0/schedules',
      body: withTarget(target, input),
    }),
    current: async (read, target) =>
      pick(
        await read.get(`/v0/schedules/${seg(target['id'])}`),
        fieldsOf(SCHEDULE_INPUT),
      ),
    page: '/admin/jobs',
  },
  {
    id: 'schedules.remove',
    area: 'schedules',
    label: '定时任务',
    description: '删除一个定时任务',
    kind: 'remove',
    role: 'member',
    target: idTarget('任务 id'),
    route: 'DELETE /v0/schedules/<任务 id>',
    request: target => ({
      method: 'DELETE',
      path: `/v0/schedules/${seg(target['id'])}`,
    }),
    current: async (read, target) =>
      pick(await read.get(`/v0/schedules/${seg(target['id'])}`), [
        'title',
        'target',
        'enabled',
      ]),
    page: '/admin/jobs',
  },
  {
    id: 'schedules.enabled',
    area: 'schedules',
    label: '定时任务启用',
    description: '启用或停用一个定时任务',
    kind: 'set',
    role: 'member',
    target: idTarget('任务 id'),
    input: shape({ enabled: flag('启用') }, ['enabled']),
    route: 'POST /v0/schedules/<任务 id>/<enable|disable|run>',
    request: (target, input) => ({
      method: 'POST',
      path: `/v0/schedules/${seg(target['id'])}/${input['enabled'] === true ? 'enable' : 'disable'}`,
      body: {},
    }),
    current: async (read, target) =>
      pick(await read.get(`/v0/schedules/${seg(target['id'])}`), ['enabled']),
    page: '/admin/jobs',
  },
  {
    id: 'schedules.run',
    area: 'schedules',
    label: '立即运行定时任务',
    description: '立即运行一次 · 结果进最近运行',
    kind: 'run',
    role: 'member',
    target: idTarget('任务 id'),
    route: 'POST /v0/schedules/<任务 id>/<enable|disable|run>',
    request: target => ({
      method: 'POST',
      path: `/v0/schedules/${seg(target['id'])}/run`,
      body: {},
    }),
    page: '/admin/jobs',
  },
  {
    id: 'schedules.resolve',
    area: 'schedules',
    label: '确认运行结果',
    description: '确认一次结果未知的运行是成功还是失败 · 解除占用',
    kind: 'update',
    role: 'member',
    target: shape({ id: text('任务 id'), runId: text('运行 id') }, [
      'id',
      'runId',
    ]),
    input: shape({ outcome: choice(['ok', 'failed'], '结果') }, ['outcome']),
    route: 'POST /v0/schedules/<任务 id>/runs/<运行 id>/resolve',
    request: (target, input) => ({
      method: 'POST',
      path: `/v0/schedules/${seg(target['id'])}/runs/${seg(target['runId'])}/resolve`,
      body: input,
    }),
    page: '/admin/jobs',
  },

  // --- 通知渠道 -------------------------------------------------------------
  {
    id: 'notify.create',
    area: 'notify',
    label: '通知渠道',
    description: '添加通知渠道 · 地址默认只收 https · 存下后不再回地址',
    kind: 'create',
    role: 'ops',
    input: shape(
      {
        name: text('名称', { minLength: 1, maxLength: 80 }),
        kind: choice(NOTIFY_KINDS, '种类'),
        url: text('地址'),
        tenant: text('租户 · 只有平台可选'),
      },
      ['name', 'kind', 'url'],
    ),
    secrets: ['url'],
    route: 'POST /v0/channels',
    request: (_target, input) => ({
      method: 'POST',
      path: '/v0/channels',
      body: input,
    }),
    page: '/admin/jobs',
  },
  {
    id: 'notify.save',
    area: 'notify',
    label: '通知渠道',
    description: '修改通知渠道 · 不给地址就保留原地址',
    kind: 'update',
    role: 'ops',
    target: idTarget('渠道 id'),
    input: shape(
      {
        name: text('名称', { minLength: 1, maxLength: 80 }),
        kind: choice(NOTIFY_KINDS, '种类'),
        url: text('新地址'),
      },
      ['name', 'kind'],
    ),
    secrets: ['url'],
    route: 'POST /v0/channels',
    request: (target, input) => ({
      method: 'POST',
      path: '/v0/channels',
      body: withTarget(target, input),
    }),
    current: (read, target) =>
      rowIn(read, '/v0/schedules', 'channels', byId(target), [
        'name',
        'kind',
        'host',
      ]),
    page: '/admin/jobs',
  },
  {
    id: 'notify.remove',
    area: 'notify',
    label: '通知渠道',
    description: '删除通知渠道',
    kind: 'remove',
    role: 'ops',
    target: idTarget('渠道 id'),
    route: 'DELETE /v0/channels/<渠道 id>',
    request: target => ({
      method: 'DELETE',
      path: `/v0/channels/${seg(target['id'])}`,
    }),
    current: (read, target) =>
      rowIn(read, '/v0/schedules', 'channels', byId(target), [
        'name',
        'kind',
        'host',
      ]),
    page: '/admin/jobs',
  },
  {
    id: 'notify.test',
    area: 'notify',
    label: '测试通知渠道',
    description: '向这个渠道发一条测试通知',
    kind: 'run',
    role: 'ops',
    target: idTarget('渠道 id'),
    route: 'POST /v0/channels/<渠道 id>/test',
    request: target => ({
      method: 'POST',
      path: `/v0/channels/${seg(target['id'])}/test`,
      body: {},
    }),
    page: '/admin/jobs',
  },

  // --- 扩展 ---------------------------------------------------------------
  {
    id: 'extensions.create',
    area: 'extensions',
    label: '扩展',
    description: '新建 MCP 技能或插件 · 保存后在后台下发到各节点',
    kind: 'create',
    role: 'ops',
    input: EXTENSION_INPUT,
    secrets: ['env.*', 'headers.*'],
    route: 'POST /v0/extensions',
    request: (_target, input) => ({
      method: 'POST',
      path: '/v0/extensions',
      body: input,
    }),
    page: '/admin/extensions',
  },
  {
    id: 'extensions.save',
    area: 'extensions',
    label: '扩展',
    description: '修改一个扩展 · 只给 enabled 是只切换启用',
    kind: 'update',
    role: 'ops',
    target: idTarget('条目 id'),
    input: EXTENSION_INPUT,
    secrets: ['env.*', 'headers.*'],
    route: 'POST /v0/extensions',
    request: (target, input) => ({
      method: 'POST',
      path: '/v0/extensions',
      body: withTarget(target, input),
    }),
    current: (read, target) =>
      rowIn(
        read,
        '/v0/extensions',
        'extensions',
        byId(target),
        fieldsOf(EXTENSION_INPUT).filter(
          key => key !== 'env' && key !== 'headers',
        ),
      ),
    page: '/admin/extensions',
  },
  {
    id: 'extensions.remove',
    area: 'extensions',
    label: '扩展',
    description: '删除条目与它的秘密 · 各节点随后卸下',
    kind: 'remove',
    role: 'ops',
    target: idTarget('条目 id'),
    route: 'DELETE /v0/extensions/<条目 id>',
    request: target => ({
      method: 'DELETE',
      path: `/v0/extensions/${seg(target['id'])}`,
    }),
    current: (read, target) =>
      rowIn(read, '/v0/extensions', 'extensions', byId(target), [
        'kind',
        'name',
        'enabled',
      ]),
    page: '/admin/extensions',
  },

  // --- 应用连接 -------------------------------------------------------------
  {
    id: 'connectors.create',
    area: 'connectors',
    label: '应用连接',
    description: '新建邮箱 日历或代码仓库连接',
    kind: 'create',
    role: 'ops',
    input: CONNECTOR_INPUT,
    secrets: ['secret'],
    route: 'POST /v0/connectors',
    request: (_target, input) => ({
      method: 'POST',
      path: '/v0/connectors',
      body: input,
    }),
    page: '/admin/connect',
  },
  {
    id: 'connectors.save',
    area: 'connectors',
    label: '应用连接',
    description: '修改一个连接 · 不给秘密就保留原值',
    kind: 'update',
    role: 'ops',
    target: idTarget('连接 id'),
    input: CONNECTOR_INPUT,
    secrets: ['secret'],
    route: 'POST /v0/connectors',
    request: (target, input) => ({
      method: 'POST',
      path: '/v0/connectors',
      body: withTarget(target, input),
    }),
    current: (read, target) =>
      rowIn(read, '/v0/connectors', 'connectors', byId(target), [
        'name',
        'kind',
        'preset',
        'settings',
        'agents',
        'revision',
      ]),
    page: '/admin/connect',
  },
  {
    id: 'connectors.remove',
    area: 'connectors',
    label: '应用连接',
    description: '删除连接及其秘密',
    kind: 'remove',
    role: 'ops',
    target: idTarget('连接 id'),
    route: 'DELETE /v0/connectors/<连接 id>',
    request: target => ({
      method: 'DELETE',
      path: `/v0/connectors/${seg(target['id'])}`,
    }),
    current: (read, target) =>
      rowIn(read, '/v0/connectors', 'connectors', byId(target), [
        'name',
        'kind',
        'preset',
      ]),
    page: '/admin/connect',
  },
  {
    id: 'connectors.probe',
    area: 'connectors',
    label: '测试应用连接',
    description: '用已保存的凭据登录后退出 · 不发邮件也不建事件',
    kind: 'run',
    role: 'ops',
    target: idTarget('连接 id'),
    route: 'POST /v0/connectors/<连接 id>/probe',
    request: target => ({
      method: 'POST',
      path: `/v0/connectors/${seg(target['id'])}/probe`,
      body: {},
    }),
    page: '/admin/connect',
  },
  {
    id: 'connectors.device.pair',
    area: 'connectors',
    label: '接力设备配对',
    description: '签发一次性配对码',
    kind: 'create',
    role: 'member',
    human: PERSON_ONLY.device,
    route: 'POST /v0/handoff/devices/pairing',
    request: () => ({
      method: 'POST',
      path: '/v0/handoff/devices/pairing',
      body: {},
    }),
    page: '/admin/connect',
  },
  {
    id: 'connectors.device.revoke',
    area: 'connectors',
    label: '吊销接力设备',
    description: '吊销一台配对过的设备的令牌',
    kind: 'remove',
    role: 'member',
    human: PERSON_ONLY.device,
    target: idTarget('设备 id'),
    route: 'DELETE /v0/handoff/devices/<设备 id>',
    request: target => ({
      method: 'DELETE',
      path: `/v0/handoff/devices/${seg(target['id'])}`,
    }),
    page: '/admin/connect',
  },

  // --- 云端电脑 -------------------------------------------------------------
  {
    id: 'desktop.set',
    area: 'desktop',
    label: '云端电脑',
    description:
      '专属浏览器与电脑的开关 · 什么时候先问人 · 能开哪些应用 · 只能申请收紧',
    kind: 'set',
    role: 'ops',
    personOnly: { note: PERSON_ONLY.desktop, when: desktopRaises },
    target: AGENT_TARGET,
    input: DESKTOP_INPUT,
    route: 'PUT /v0/desktop/<节点>/<智能体>',
    request: (target, input) => ({
      method: 'PUT',
      path: `/v0/desktop/${seg(target['node'])}/${seg(target['agent'])}`,
      body: input,
    }),
    current: async (read, target) => {
      const found = agentRowOf(await read.get('/v0/desktop'), target)
      if (found === null) return null
      const browser = recordOf(found['browser'])
      const computer = recordOf(found['computer'])
      return {
        browser: browser?.['enabled'] ?? null,
        computer: computer?.['enabled'] ?? null,
        confirm: found['confirm'] ?? null,
        apps: computer?.['apps'] ?? null,
        terminal: computer?.['terminal'] ?? null,
      }
    },
    page: '/admin/desktop',
  },
  {
    id: 'desktop.recycle',
    area: 'desktop',
    label: '回收云端电脑',
    description: '停止并删除该智能体的浏览器与电脑资料',
    kind: 'remove',
    role: 'ops',
    target: AGENT_TARGET,
    route: 'POST /v0/desktop/<节点>/<智能体>/recycle',
    request: target => ({
      method: 'POST',
      path: `/v0/desktop/${seg(target['node'])}/${seg(target['agent'])}/recycle`,
      body: {},
    }),
    page: '/admin/desktop',
  },

  // --- 权限模式 -------------------------------------------------------------
  {
    id: 'elevation.set',
    area: 'elevation',
    label: '高权限模式',
    description: '开启或改档 accept-edits auto full-access',
    kind: 'set',
    role: 'ops',
    human: PERSON_ONLY.elevation,
    target: AGENT_TARGET,
    input: shape(
      {
        tier: choice(['accept-edits', 'auto', 'full-access'], '档位'),
        ttlMs: whole('有效期毫秒 5 分钟到 24 小时', 300_000, 86_400_000),
        maxCalls: whole('调用次数上限', 1, 2000),
      },
      ['tier'],
    ),
    route: 'PUT /v0/elevation/<节点>/<智能体>',
    request: (target, input) => ({
      method: 'PUT',
      path: `/v0/elevation/${seg(target['node'])}/${seg(target['agent'])}`,
      body: input,
    }),
    page: '/admin/elevation',
  },
  {
    id: 'elevation.off',
    area: 'elevation',
    label: '高权限模式',
    description:
      '关闭高权限模式 · 回到人工确认 · 有默认档时同时固定为人工确认 · 中枢不再自动开启',
    kind: 'set',
    role: 'ops',
    target: AGENT_TARGET,
    input: shape({ tier: choice(['off'], '只能是 off') }, ['tier']),
    route: 'PUT /v0/elevation/<节点>/<智能体>',
    request: target => ({
      method: 'PUT',
      path: `/v0/elevation/${seg(target['node'])}/${seg(target['agent'])}`,
      body: { tier: 'off' },
    }),
    current: (read, target) => tierOf(read, target),
    page: '/admin/elevation',
  },
  {
    id: 'elevation.revoke',
    area: 'elevation',
    label: '收回高权限',
    description: '立即收回 · 代次加一 · 作废待批审批并中止在途回合',
    kind: 'run',
    role: 'ops',
    target: AGENT_TARGET,
    route: 'POST /v0/elevation/<节点>/<智能体>/revoke',
    request: target => ({
      method: 'POST',
      path: `/v0/elevation/${seg(target['node'])}/${seg(target['agent'])}/revoke`,
      body: {},
    }),
    current: (read, target) => tierOf(read, target),
    page: '/admin/elevation',
  },
  {
    id: 'elevation.revoke-all',
    area: 'elevation',
    label: '全部收回高权限',
    description:
      '对本租户每个已放权的智能体各收回一次 · 有默认档时人工确认的也一并固定',
    kind: 'run',
    role: 'ops',
    route: 'POST /v0/elevation/revoke-all',
    request: () => ({
      method: 'POST',
      path: '/v0/elevation/revoke-all',
      body: {},
    }),
    page: '/admin/elevation',
  },

  // --- 服务器 -------------------------------------------------------------
  {
    id: 'servers.note',
    area: 'servers',
    label: '服务器备注',
    description: '写一台服务器的备注 · 空串清除 · 最多 500 字',
    kind: 'set',
    role: 'ops',
    target: shape({ server: text('服务器 id · 须在启动白名单里') }, ['server']),
    input: shape({ note: text('备注', { maxLength: 500 }) }, ['note']),
    route: 'PUT /v0/servers/<server id>/note',
    request: (target, input) => ({
      method: 'PUT',
      path: `/v0/servers/${seg(target['server'])}/note`,
      body: input,
    }),
    current: async (read, target) => {
      const card = rowsOf(await read.get('/v0/servers'), 'servers').find(
        row => row['server'] === target['server'],
      )
      if (card === undefined) return null
      return { note: recordOf(card['note'])?.['note'] ?? '' }
    },
    page: '/admin/servers',
  },
  {
    id: 'servers.replicate.inspect',
    area: 'servers',
    label: '添加服务器',
    description: '用 SSH 登录一次 只读探查',
    kind: 'run',
    role: 'ops',
    human: PERSON_ONLY.ssh,
    input: shape(
      {
        host: text('地址'),
        port: whole('SSH 端口', 1, 65535),
        user: text('用户名'),
        auth: shape(
          {
            kind: choice(['password', 'key'], '口令或私钥'),
            secret: text('口令或私钥'),
          },
          ['kind', 'secret'],
        ),
      },
      ['host', 'user', 'auth'],
    ),
    secrets: ['auth.secret'],
    route: 'POST /v0/replicate/inspect',
    request: (_target, input) => ({
      method: 'POST',
      path: '/v0/replicate/inspect',
      body: input,
    }),
    page: '/admin/servers',
  },
  {
    id: 'servers.replicate.start',
    area: 'servers',
    label: '部署到服务器',
    description: '确认指纹后在后台部署节点',
    kind: 'run',
    role: 'ops',
    human: PERSON_ONLY.ssh,
    input: shape(
      {
        ticket: text('检查时的票'),
        fingerprint: text('主机指纹'),
        node: NODE,
        agent: AGENT,
        server: text('服务器名'),
      },
      ['ticket', 'fingerprint', 'node', 'agent', 'server'],
    ),
    route: 'POST /v0/replicate/start',
    request: (_target, input) => ({
      method: 'POST',
      path: '/v0/replicate/start',
      body: input,
    }),
    page: '/admin/servers',
  },

  // --- 更新 ---------------------------------------------------------------
  {
    id: 'updates.save',
    area: 'updates',
    label: '更新设定',
    description: '检查时间 · 每个来源只通知或自动处理 · 通知渠道 · 仓库',
    kind: 'set',
    role: 'ops',
    personOnly: { note: PERSON_ONLY.updates, when: updatesWiden },
    input: UPDATES_INPUT,
    route: 'POST /v0/updates',
    request: (_target, input) => ({
      method: 'POST',
      path: '/v0/updates',
      body: input,
    }),
    current: async read => {
      const snapshot = recordOf(await read.get('/v0/updates'))
      if (snapshot === null) return null
      return {
        times: snapshot['times'] ?? null,
        timezone: snapshot['timezone'] ?? null,
        actions: Object.fromEntries(
          rowsOf(snapshot, 'sources').map(row => [row['id'], row['action']]),
        ),
        channels: snapshot['channels'] ?? null,
        repo: snapshot['repo'] ?? null,
      }
    },
    page: '/admin/updates',
  },
  {
    id: 'updates.run',
    area: 'updates',
    label: '立即检查更新',
    description: '在后台检查一次 · 按各来源的动作处理',
    kind: 'run',
    role: 'ops',
    route: 'POST /v0/updates/run',
    request: () => ({ method: 'POST', path: '/v0/updates/run', body: {} }),
    page: '/admin/updates',
  },
  {
    id: 'updates.upgrade',
    area: 'updates',
    label: '升级阡陌',
    description: '节点逐台升级 · 中枢最后 · 一台失败就停',
    kind: 'run',
    role: 'ops',
    input: VERSION_INPUT,
    route: 'POST /v0/updates/upgrade',
    request: (_target, input) => ({
      method: 'POST',
      path: '/v0/updates/upgrade',
      body: input,
    }),
    page: '/admin/updates',
  },
  {
    id: 'updates.rollback',
    area: 'updates',
    label: '回滚阡陌',
    description: '换回本机备份或装一个更旧的发行 · 中枢最后',
    kind: 'run',
    role: 'ops',
    input: VERSION_INPUT,
    route: 'POST /v0/updates/rollback',
    request: (_target, input) => ({
      method: 'POST',
      path: '/v0/updates/rollback',
      body: input,
    }),
    page: '/admin/updates',
  },

  // --- 告警 ---------------------------------------------------------------
  {
    id: 'alerts.ack',
    area: 'alerts',
    label: '确认告警',
    description: '确认收件箱里的一条告警',
    kind: 'update',
    role: 'ops',
    target: idTarget('告警 id'),
    route: 'POST /v0/alerts/<告警 id>/ack',
    request: target => ({
      method: 'POST',
      path: `/v0/alerts/${seg(target['id'])}/ack`,
      body: {},
    }),
    page: '/admin/alerts',
  },

  // --- 文件互通 -------------------------------------------------------------
  {
    id: 'files.decide',
    area: 'files',
    label: '文件申请',
    description: '批准或拒绝一个智能体的文件申请 · 可收窄范围与时限',
    kind: 'update',
    role: 'member',
    human: PERSON_ONLY.files,
    target: idTarget('申请 id'),
    input: shape(
      {
        approve: flag('批准'),
        scope: shape(
          {
            kind: choice(['file', 'dir'], '文件或目录'),
            path: text('相对路径'),
          },
          ['kind', 'path'],
        ),
        ttlMs: whole('授权时长毫秒', 1),
        note: text('说明', { maxLength: 2000 }),
      },
      ['approve'],
    ),
    route: 'POST /v0/files/requests/<id>/decide',
    request: (target, input) => ({
      method: 'POST',
      path: `/v0/files/requests/${seg(target['id'])}/decide`,
      body: input,
    }),
    page: '/admin/files',
  },
  {
    id: 'files.revoke',
    area: 'files',
    label: '文件授权',
    description: '撤销一项文件授权',
    kind: 'remove',
    role: 'member',
    target: idTarget('授权 id'),
    route: 'POST /v0/files/grants/<id>/revoke',
    request: target => ({
      method: 'POST',
      path: `/v0/files/grants/${seg(target['id'])}/revoke`,
      body: {},
    }),
    page: '/admin/files',
  },
  {
    id: 'files.transfer',
    area: 'files',
    label: '文件传输',
    description: '单来源传输或多来源汇集到一个智能体',
    kind: 'create',
    role: 'member',
    input: shape(
      {
        sources: {
          type: 'array',
          minItems: 1,
          maxItems: 100,
          items: shape({ agent: ADDRESS, path: text('相对路径') }, [
            'agent',
            'path',
          ]),
        },
        target: ADDRESS,
      },
      ['sources', 'target'],
    ),
    route: 'POST /v0/files/transfers',
    request: (_target, input) => ({
      method: 'POST',
      path: '/v0/files/transfers',
      body: input,
    }),
    page: '/admin/files',
  },
  {
    id: 'files.retry',
    area: 'files',
    label: '重试文件传输',
    description: '以新传输号重试失败项',
    kind: 'run',
    role: 'member',
    target: idTarget('传输 id'),
    route: 'POST /v0/files/transfers/<id>/retry',
    request: target => ({
      method: 'POST',
      path: `/v0/files/transfers/${seg(target['id'])}/retry`,
      body: {},
    }),
    page: '/admin/files',
  },

  // --- 账号与访问：只能本人 ----------------------------------------------------
  {
    id: 'accounts.invite',
    area: 'accounts',
    label: '邀请',
    description: '签一份邀请',
    kind: 'create',
    role: 'ops',
    human: PERSON_ONLY.accounts,
    input: shape(
      {
        role: choice(['viewer', 'member', 'ops'], '角色'),
        label: text('称呼'),
        ttlHours: whole('有效小时数', 1),
      },
      ['role'],
    ),
    route: 'POST /v0/accounts/invites',
    request: (_target, input) => ({
      method: 'POST',
      path: '/v0/accounts/invites',
      body: input,
    }),
    page: '/admin/access',
  },
  {
    id: 'accounts.invite.withdraw',
    area: 'accounts',
    label: '撤回邀请',
    description: '撤回一份未兑现的邀请',
    kind: 'remove',
    role: 'ops',
    human: PERSON_ONLY.accounts,
    target: idTarget('邀请 id'),
    route: 'DELETE /v0/accounts/invites/<邀请 id>',
    request: target => ({
      method: 'DELETE',
      path: `/v0/accounts/invites/${seg(target['id'])}`,
    }),
    page: '/admin/access',
  },
  ...(['revoke', 'reset', 'logout'] as const).map(
    (verb): SettingOperation => ({
      id: `accounts.${verb}`,
      area: 'accounts',
      label: { revoke: '吊销账号', reset: '重置凭据', logout: '强制下线' }[
        verb
      ],
      description: {
        revoke: '吊销一个账号',
        reset: '重置一个账号的凭据',
        logout: '关掉这个人的全部会话 · 账号与凭据不动',
      }[verb],
      kind: verb === 'revoke' ? 'remove' : 'run',
      role: 'ops',
      human: PERSON_ONLY.accounts,
      target: shape({ subject: text('账号 u:…') }, ['subject']),
      route: `POST /v0/accounts/<subject>/${verb}`,
      request: target => ({
        method: 'POST',
        path: `/v0/accounts/${seg(target['subject'])}/${verb}`,
        body: {},
      }),
      page: '/admin/access',
    }),
  ),

  // --- 审批：只能本人 ----------------------------------------------------------
  {
    id: 'approvals.auth',
    area: 'approvals',
    label: '审批凭据',
    description: '同账号个人凭据再验证 · 签发审批 cookie',
    kind: 'run',
    role: 'member',
    human: PERSON_ONLY.approvals,
    route: 'POST /v0/approvals/auth',
    request: () => ({ method: 'POST', path: '/v0/approvals/auth', body: {} }),
    page: '/admin/approvals',
  },
  {
    id: 'approvals.decide',
    area: 'approvals',
    label: '审批决定',
    description: '批准一次 · 授权窗口 · 或拒绝',
    kind: 'update',
    role: 'member',
    human: PERSON_ONLY.approvals,
    target: idTarget('审批 requestId'),
    route: 'POST /v0/approvals/<requestId>',
    request: (target, input) => ({
      method: 'POST',
      path: `/v0/approvals/${seg(target['id'])}`,
      body: input,
    }),
    page: '/admin/approvals',
  },
  {
    id: 'approvals.continue',
    area: 'approvals',
    label: '批准并继续',
    description: '批准后发送一条新的签名入站任务',
    kind: 'run',
    role: 'member',
    human: PERSON_ONLY.approvals,
    target: idTarget('审批 requestId'),
    route: 'POST /v0/approvals/<requestId>/continue',
    request: (target, input) => ({
      method: 'POST',
      path: `/v0/approvals/${seg(target['id'])}/continue`,
      body: input,
    }),
    page: '/admin/approvals',
  },
  {
    id: 'approvals.revoke',
    area: 'approvals',
    label: '撤销授权',
    description: '撤销一个授权窗口',
    kind: 'remove',
    role: 'member',
    human: PERSON_ONLY.approvals,
    target: idTarget('审批 requestId'),
    route: 'DELETE /v0/approvals/<requestId>',
    request: target => ({
      method: 'DELETE',
      path: `/v0/approvals/${seg(target['id'])}`,
    }),
    page: '/admin/approvals',
  },

  // --- 订阅：只能本人 ----------------------------------------------------------
  {
    id: 'billing.checkout',
    area: 'billing',
    label: '下单',
    description: '为一个套餐下单',
    kind: 'create',
    role: 'member',
    human: PERSON_ONLY.billing,
    input: shape({ planId: text('套餐'), channel: text('支付通道') }, [
      'planId',
    ]),
    route: 'POST /v0/billing/checkout',
    request: (_target, input) => ({
      method: 'POST',
      path: '/v0/billing/checkout',
      body: input,
    }),
    page: '/admin/billing',
  },
  {
    id: 'billing.redeem',
    area: 'billing',
    label: '兑换',
    description: '用兑换码开通订阅',
    kind: 'run',
    role: 'member',
    human: PERSON_ONLY.billing,
    input: shape({ code: text('兑换码') }, ['code']),
    secrets: ['code'],
    route: 'POST /v0/billing/redeem',
    request: (_target, input) => ({
      method: 'POST',
      path: '/v0/billing/redeem',
      body: input,
    }),
    page: '/admin/billing',
  },
  {
    id: 'billing.model.add',
    area: 'billing',
    label: '自己的上游',
    description: '用 API 密钥预设接自己的上游',
    kind: 'create',
    role: 'member',
    human: PERSON_ONLY.billing,
    input: shape({ preset: text('预设'), key: text('密钥') }, [
      'preset',
      'key',
    ]),
    secrets: ['key'],
    route: 'POST /v0/billing/models',
    request: (_target, input) => ({
      method: 'POST',
      path: '/v0/billing/models',
      body: input,
    }),
    page: '/admin/billing',
  },
  {
    id: 'billing.model.remove',
    area: 'billing',
    label: '自己的上游',
    description: '删除自己接的上游',
    kind: 'remove',
    role: 'member',
    human: PERSON_ONLY.billing,
    target: idTarget('上游 id'),
    route: 'DELETE /v0/billing/models/<上游 id>',
    request: target => ({
      method: 'DELETE',
      path: `/v0/billing/models/${seg(target['id'])}`,
    }),
    page: '/admin/billing',
  },
  ...(['grant', 'refund', 'codes'] as const).map(
    (verb): SettingOperation => ({
      id: `billing.${verb}`,
      area: 'billing',
      label: { grant: '手动开通', refund: '登记退款', codes: '生成兑换码' }[
        verb
      ],
      description: {
        grant: '手动开通或延期一个订阅',
        refund: '登记商户平台上已经做完的退款',
        codes: '生成兑换码 · 明文只出现一次',
      }[verb],
      kind: verb === 'codes' ? 'create' : 'run',
      role: 'ops',
      human: PERSON_ONLY.billing,
      route: `POST /v0/billing/admin/${verb}`,
      request: (_target, input) => ({
        method: 'POST',
        path: `/v0/billing/admin/${verb}`,
        body: input,
      }),
      page: '/admin/billing',
    }),
  ),
]

// --- reads shared by several entries ---------------------------------------

/**
 * A profile in a few fields. The base URL is its host, as any reader below a
 * writer sees it (`baseUrlFor`): the path may carry a token, and this brief
 * goes to the agent and into the approval it asks for.
 */
function profileBrief(view: unknown): unknown {
  const profile = recordOf(view)
  if (profile === null) return null
  const baseUrl = profile['baseUrl']
  const values = recordOf(profile['templateValues'])
  const templateValues: Record<string, string> = {}
  for (const [name, value] of Object.entries(values ?? {}))
    if (typeof value === 'string') templateValues[name] = value
  return {
    name: profile['name'] ?? null,
    revision: profile['revision'] ?? null,
    host:
      typeof baseUrl === 'string'
        ? baseUrlFor({ baseUrl, templateValues }, false)
        : null,
    models: rowsOf(profile, 'models').map(row => row['id']),
    keys: rowsOf(profile, 'keys').map(row => row['id']),
  }
}

async function keyBrief(read: SettingReader, target: Args): Promise<unknown> {
  const profile = recordOf(
    await read.get(`/v0/providers/profiles/${seg(target['profileId'])}`),
  )
  if (profile === null) return null
  const key = rowsOf(profile, 'keys').find(row => row['id'] === target['keyId'])
  return {
    revision: profile['revision'] ?? null,
    set: key !== undefined && key['setAt'] !== undefined,
  }
}

async function keyOf(read: SettingReader, target: Args): Promise<unknown> {
  const key = rowsOf(await read.get('/v0/magpie'), 'keys').find(row => {
    const binding = recordOf(row['binding'])
    return (
      `${String(binding?.['kind'])}:${String(binding?.['id'])}` ===
      target['binding']
    )
  })
  if (key === undefined) return null
  return {
    enabled: key['enabled'] ?? null,
    mainModel: key['mainModel'] ?? null,
    fastModel: key['fastModel'] ?? null,
    models: key['modelsMode'] === 'all' ? null : (key['models'] ?? null),
    limits: rowsOf(key, 'limits').map(limit =>
      pick(limit, ['period', 'days', 'hours', 'tokens', 'cost', 'cacheReads']),
    ),
  }
}

async function avatarOf(read: SettingReader, target: Args): Promise<unknown> {
  const key = `agent:${String(target['address'])}`
  const found = recordOf(
    recordOf(await read.get(`/v0/avatars?key=${encodeURIComponent(key)}`))?.[
      'avatars'
    ],
  )?.[key]
  const avatar = recordOf(found)
  if (avatar === null) return null
  return avatar['saved'] === true ? recordOf(avatar['spec']) : null
}

/**
 * An address's state in the registration ledger. A console without the
 * ledger still registers and deregisters, so a read it cannot answer is no
 * state rather than a refusal; the lifecycle verbs refuse on their own.
 */
async function registrationOf(
  read: SettingReader,
  target: Args,
): Promise<unknown> {
  try {
    return await rowIn(
      read,
      '/v0/registrations',
      'registrations',
      row => row['address'] === target['address'],
      ['state'],
    )
  } catch {
    return null
  }
}

/** The row for one agent in a GET that answers a bare list (desktop, elevation). */
function agentRowOf(
  listed: unknown,
  target: Args,
): Record<string, unknown> | null {
  if (!Array.isArray(listed)) return null
  for (const row of listed) {
    const found = recordOf(row)
    if (found !== null && byAgent(target)(found)) return found
  }
  return null
}

async function tierOf(read: SettingReader, target: Args): Promise<unknown> {
  const found = agentRowOf(await read.get('/v0/elevation'), target)
  if (found === null) return null
  // Under a hub default (P39 §8.1) an agent at off that nobody held is opened
  // again on the next pass, so turning it off still changes something.
  if (
    found['tier'] === 'off' &&
    typeof found['defaultTier'] === 'string' &&
    found['defaultHeld'] !== true
  )
    return {
      tier: `off（未固定 · 中枢会按默认档 ${found['defaultTier']} 开启）`,
    }
  return { tier: found['tier'] }
}

const BY_ID: ReadonlyMap<string, SettingOperation> = new Map(
  CATALOG.map(op => [op.id, op]),
)

/** Every entry, in the panel's order. */
export function settingOperations(): readonly SettingOperation[] {
  return CATALOG
}

/** One entry by id, or `undefined`. */
export function settingOperation(id: string): SettingOperation | undefined {
  return BY_ID.get(id)
}

// ---------------------------------------------------------------------------
// Checking a value against a schema
// ---------------------------------------------------------------------------

function typeOf(value: unknown): JsonType {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (typeof value === 'number')
    return Number.isInteger(value) ? 'integer' : 'number'
  if (typeof value === 'string') return 'string'
  if (typeof value === 'boolean') return 'boolean'
  return 'object'
}

function typeMatches(value: unknown, wanted: JsonSchema['type']): boolean {
  if (wanted === undefined) return true
  const actual = typeOf(value)
  const list: readonly JsonType[] =
    typeof wanted === 'string' ? [wanted] : wanted
  return list.some(
    type => type === actual || (type === 'number' && actual === 'integer'),
  )
}

/**
 * The first way `value` misses `schema`, in a short line naming where; `null`
 * when it fits. Only the keywords of {@link JsonSchema}.
 */
export function schemaProblem(
  schema: JsonSchema,
  value: unknown,
  where: string,
): string | null {
  if (value === undefined) return `${where} 缺失`
  if (schema.anyOf !== undefined) {
    const fits = schema.anyOf.some(
      option => schemaProblem(option, value, where) === null,
    )
    if (!fits) return `${where} 不符合任何一种可选形状`
  }
  if (!typeMatches(value, schema.type)) {
    const wanted =
      typeof schema.type === 'string' ? schema.type : schema.type?.join(' 或 ')
    return `${where} 应为 ${wanted}`
  }
  if (
    schema.enum !== undefined &&
    !schema.enum.some(option => option === value)
  )
    return `${where} 只能是 ${schema.enum.map(String).join(' ')}`
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength)
      return `${where} 太短`
    if (schema.maxLength !== undefined && value.length > schema.maxLength)
      return `${where} 超过 ${schema.maxLength} 字`
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value))
      return `${where} 格式不对`
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum)
      return `${where} 不能小于 ${schema.minimum}`
    if (schema.maximum !== undefined && value > schema.maximum)
      return `${where} 不能大于 ${schema.maximum}`
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems)
      return `${where} 至少 ${schema.minItems} 项`
    if (schema.maxItems !== undefined && value.length > schema.maxItems)
      return `${where} 至多 ${schema.maxItems} 项`
    if (schema.items !== undefined) {
      for (const [index, item] of value.entries()) {
        const problem = schemaProblem(schema.items, item, `${where}[${index}]`)
        if (problem !== null) return problem
      }
    }
  }
  const object = recordOf(value)
  if (object !== null) {
    const keys = Object.keys(object)
    if (
      schema.minProperties !== undefined &&
      keys.length < schema.minProperties
    )
      return `${where} 至少要给一项`
    for (const key of schema.required ?? []) {
      if (object[key] === undefined) return `${where}.${key} 缺失`
    }
    for (const key of keys) {
      // Own properties only: `toString` or `__proto__` is not a field.
      const known =
        schema.properties !== undefined && Object.hasOwn(schema.properties, key)
          ? schema.properties[key]
          : undefined
      if (known !== undefined) {
        const problem = schemaProblem(known, object[key], `${where}.${key}`)
        if (problem !== null) return problem
      } else if (schema.additionalProperties === false) {
        return `${where}.${key} 不认识`
      } else if (typeof schema.additionalProperties === 'object') {
        const problem = schemaProblem(
          schema.additionalProperties,
          object[key],
          `${where}.${key}`,
        )
        if (problem !== null) return problem
      }
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

/** What a secret becomes wherever a change is shown or bound. */
interface SecretMark {
  readonly $secret: string
  readonly sha256: string
}

/** Short secrets keep no tail: four characters of six would be most of it. */
const TAIL_FROM_LENGTH = 8

export function secretMark(value: string): SecretMark {
  return {
    $secret: value.length >= TAIL_FROM_LENGTH ? `…${value.slice(-4)}` : '…',
    sha256: createHash('sha256').update(value).digest('hex'),
  }
}

function isSecretMark(value: unknown): value is SecretMark {
  const found = recordOf(value)
  return (
    found !== null &&
    typeof found['$secret'] === 'string' &&
    typeof found['sha256'] === 'string' &&
    Object.keys(found).length === 2
  )
}

function redactAt(value: unknown, path: readonly string[]): unknown {
  if (path.length === 0) {
    return typeof value === 'string' && value !== '' ? secretMark(value) : value
  }
  const [head, ...rest] = path
  if (Array.isArray(value)) {
    return value.map((item, index) =>
      head === '*' || head === String(index) ? redactAt(item, rest) : item,
    )
  }
  const found = recordOf(value)
  if (found === null) return value
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(found)) {
    out[key] = head === '*' || head === key ? redactAt(item, rest) : item
  }
  return out
}

/** `input` with every secret at `paths` (`secrets.*`, `auth.secret`) marked. */
export function redactSecrets(
  input: unknown,
  paths: readonly string[] = [],
): unknown {
  let out = input
  for (const path of paths) out = redactAt(out, path.split('.'))
  return out
}

// ---------------------------------------------------------------------------
// What an approval binds (§4.2)
// ---------------------------------------------------------------------------

export interface SettingsCard {
  readonly area: string
  readonly label: string
  readonly title: string
  readonly current: string | null
  readonly next: string
  readonly role: SettingRole
  readonly page: string
}

export interface SettingsBound {
  readonly id: string
  readonly target: Record<string, unknown> | null
  readonly input: unknown
  /**
   * The whole value read before the change, hashed: the card's `current` is
   * cut short for a person, so a list or a long field changed by someone
   * else would not show there, but it does here and voids the approval.
   */
  readonly currentSha256: string | null
  readonly card: SettingsCard
}

/** A card line's ceiling (§4.2). */
const CARD_TEXT_MAX = 200

function clip(line: string, max = CARD_TEXT_MAX): string {
  const chars = [...line]
  return chars.length <= max ? line : `${chars.slice(0, max - 1).join('')}…`
}

/** One value in a few words: secrets by their tail, nesting by its size. */
function brief(value: unknown, depth = 0): string {
  if (value === null || value === undefined) return '无'
  if (isSecretMark(value)) return `密钥 ${value.$secret}`
  if (typeof value === 'string') return value === '' ? '空' : value
  if (typeof value !== 'object') return String(value)
  if (Array.isArray(value)) {
    if (value.length === 0) return '空列表'
    if (depth > 0 || value.some(item => typeof item === 'object'))
      return value.length <= 3 && depth === 0
        ? value.map(item => brief(item, depth + 1)).join(' · ')
        : `${value.length} 项`
    return value.map(item => brief(item, depth + 1)).join(' ')
  }
  const entries = Object.entries(value as Record<string, unknown>).filter(
    ([, item]) => item !== undefined,
  )
  if (entries.length === 0) return '空'
  if (depth > 1) return `${entries.length} 项设置`
  return entries
    .map(([key, item]) => `${key} ${brief(item, depth + 1)}`)
    .join(depth === 0 ? ' · ' : ' ')
}

/** The target in one phrase: `tokyo-1/main`, `gw-claude`. */
function targetPhrase(target: Args | null): string {
  if (target === null) return ''
  const values = Object.values(target).filter(
    value => value !== undefined && value !== null,
  )
  return values.map(value => String(value)).join('/')
}

const KIND_WORDS: Readonly<Record<SettingKind, string>> = {
  set: '更改',
  create: '新建',
  update: '修改',
  remove: '删除',
  run: '执行',
}

/** The title's ceiling; the value inside it is clipped first so the target stays. */
const TITLE_MAX = 120
const TITLE_VALUE_MAX = 48

function titleOf(op: SettingOperation, target: Args | null, input: unknown) {
  const where = targetPhrase(target)
  const suffix = where === '' ? '' : ` · ${clip(where, TITLE_VALUE_MAX)}`
  const fields = recordOf(input)
  const only = fields === null ? [] : Object.values(fields)
  if (op.kind === 'set' && only.length === 1) {
    const value = clip(brief(only[0], 1), TITLE_VALUE_MAX)
    return clip(`把${op.label}改成 ${value}${suffix}`, TITLE_MAX)
  }
  if (op.kind === 'run') return clip(`${op.label}${suffix}`, TITLE_MAX)
  const name = fields?.['name'] ?? fields?.['title']
  const named =
    typeof name === 'string' && name !== ''
      ? ` ${clip(name, TITLE_VALUE_MAX)}`
      : ''
  return clip(`${KIND_WORDS[op.kind]}${op.label}${named}${suffix}`, TITLE_MAX)
}

function nextOf(op: SettingOperation, input: unknown): string {
  const fields = recordOf(input)
  if (fields !== null && Object.keys(fields).length > 0) {
    return clip(brief(input))
  }
  if (op.kind === 'remove') return '删除'
  if (op.kind === 'run') return '执行一次'
  return clip(brief(input))
}

/**
 * The bound of one change (§4.2): `input` is already redacted, `current` is
 * what the entry read before the change (`null` when it has none).
 */
export function settingsBound(
  op: SettingOperation,
  target: Args | null,
  given: unknown,
  read: unknown,
): SettingsBound {
  // In key order, so the card's words (and with them the digest) do not
  // depend on the order a model happened to write the fields in.
  const where = target === null ? null : (sortedKeys(target) as Args)
  const input = sortedKeys(given)
  const current = sortedKeys(read)
  return {
    id: op.id,
    target: where,
    input,
    currentSha256:
      current === undefined
        ? null
        : createHash('sha256').update(stableJson(current)).digest('hex'),
    card: {
      area: SETTING_AREAS[op.area],
      label: op.label,
      title: titleOf(op, where, input),
      current:
        op.kind === 'create' || current === undefined
          ? null
          : clip(brief(current)),
      next: nextOf(op, input),
      role: op.role,
      page: op.page,
    },
  }
}

/**
 * The `qianmo_settings_change` arguments that bind `bound` again, or `null`
 * when the bound cannot give them back: a secret is in it only as its mark.
 */
export function settingsCallOf(bound: unknown): Args | null {
  const found = recordOf(bound)
  if (
    found === null ||
    typeof found['id'] !== 'string' ||
    hasSecretMark(found['input'])
  )
    return null
  const target = recordOf(found['target'])
  const input = found['input']
  return {
    id: found['id'],
    ...(target === null ? {} : { target }),
    ...(input === undefined || input === null ? {} : { input }),
  }
}

/** `value` with every object's keys in order; arrays keep theirs. */
function sortedKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedKeys)
  const found = recordOf(value)
  if (found === null) return value
  return Object.fromEntries(
    Object.keys(found)
      .sort()
      .map(key => [key, sortedKeys(found[key])]),
  )
}

function hasSecretMark(value: unknown): boolean {
  if (isSecretMark(value)) return true
  if (Array.isArray(value)) return value.some(hasSecretMark)
  const found = recordOf(value)
  return found !== null && Object.values(found).some(hasSecretMark)
}

/** Key order does not matter to an equality of settings. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  const found = recordOf(value)
  if (found !== null) {
    return `{${Object.keys(found)
      .sort()
      .filter(key => found[key] !== undefined)
      .map(key => `${JSON.stringify(key)}:${stableJson(found[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value ?? null)
}

/**
 * True when a `set` or `update` would leave everything it names as it is:
 * every field of the (redacted) input equals the same field read before. A
 * secret is never equal to anything read, so a change carrying one always
 * goes ahead.
 */
export function settingUnchanged(
  op: SettingOperation,
  input: unknown,
  current: unknown,
): boolean {
  if (op.kind !== 'set' && op.kind !== 'update') return false
  const fields = recordOf(input)
  const before = recordOf(current)
  if (fields === null || before === null) return false
  const keys = Object.keys(fields)
  if (keys.length === 0) return false
  return keys.every(key => stableJson(fields[key]) === stableJson(before[key]))
}
