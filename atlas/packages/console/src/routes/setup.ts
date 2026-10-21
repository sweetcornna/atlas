// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 初始化配置（`/admin/setup`）：一台新控制台还差哪几步才能对话，没完成的
 * 尽量在本页直接做完。
 *
 * | 方法与路径 | 谁 | 做什么 |
 * | --- | --- | --- |
 * | `GET /admin/setup` | 管理令牌或运维账号 | 整页 |
 * | `GET /v0/setup` | 同上 | 同一份状态的 JSON（`setupState.ts`） |
 * | `PUT /v0/setup/main` `{address}` | 同上 | 改主智能体；`address: null` 回到启动参数 |
 *
 * 只给能管理这台控制台的人：页面上全是写入口和账号、模型服务的状态，查看
 * 令牌与普通成员拿到 404，侧栏也不出现（`available`）。
 *
 * 本页的写操作除主智能体外都走已有接口（邀请走账号接口、模型走模型服务接口），
 * 各自的权限、记账与校验照旧；这里不重复记账。主智能体是新的写入，记一条
 * `chat.main`。
 */

import type { ConsoleResult } from '../deps.js'
import {
  fail,
  json,
  methodNotAllowed,
  notFound,
  readJsonObject,
} from '../respond.js'
import {
  type SetupReadings,
  type SetupSnapshot,
  setupSnapshot,
} from '../setupState.js'
import { KIT_CSS } from '../view/kit.js'
import { renderSetup, SETUP_CSS } from '../view/setup.js'
import { SETUP_PAGE_JS } from '../view/setupScript.js'
import { providerWriter } from './providers.js'
import { canWrite, guard, preferredMainAgent, underPath } from './shared.js'
import type { RouteContext, RouteModule } from './types.js'

const ADDRESS =
  /^qianmo:\/\/[a-z0-9][a-z0-9_.-]{0,63}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/
const MAIN_UNWIRED = '这台控制台不能在页面上改主智能体'
const MAIN_UNKNOWN = '名册里没有这个智能体'

function accountsReading(ctx: RouteContext): SetupReadings['accounts'] {
  const accounts = ctx.accounts
  if (accounts === undefined) return undefined
  const listed = accounts.book.list()
  return listed.ok
    ? { ok: true, value: listed.value }
    : {
        ok: false,
        failure: { code: 'unreachable', message: listed.refusal.message },
      }
}

/**
 * 读齐算一页状态所需的读数。`full` 为 false 时只读必需项要的（侧栏数字用），
 * 不碰任务模型、渠道和云端电脑这几个可能要问节点的端口。
 */
async function readings(
  ctx: RouteContext,
  full: boolean,
): Promise<SetupReadings> {
  const { deps } = ctx
  const [roster, providers, routing, channels, desktop] = await Promise.all([
    ctx.roster(),
    deps.providers?.overview(),
    full ? deps.routing?.snapshot() : undefined,
    full ? deps.channels?.snapshot() : undefined,
    full ? deps.desktop?.list() : undefined,
  ])
  const page = deps.mainAgent?.get() ?? null
  const preferred = preferredMainAgent(deps)
  const accounts = accountsReading(ctx)
  return {
    now: ctx.now,
    ...(accounts === undefined ? {} : { accounts }),
    modelWriter: providerWriter(ctx),
    ...(providers === undefined ? {} : { providers }),
    presets: deps.providers?.catalog().presets ?? [],
    roster,
    replicate: deps.replicate !== undefined,
    chatWired: deps.chat !== undefined,
    mainPreferred: preferred,
    mainFromPage: page !== null,
    mainSettable: deps.mainAgent !== undefined,
    ...(routing === undefined ? {} : { routing }),
    ...(channels === undefined ? {} : { channels }),
    ...(desktop === undefined ? {} : { desktop }),
  }
}

/** 整页状态。 */
async function setupOf(ctx: RouteContext): Promise<SetupSnapshot> {
  return setupSnapshot(await readings(ctx, true))
}

/**
 * 侧栏用：这位读者看得到本页时，必需项里还能在页面上做的数目；看不到时
 * `undefined`。
 */
export async function setupPending(
  ctx: RouteContext,
): Promise<number | undefined> {
  if (!canWrite(ctx.access)) return undefined
  return setupSnapshot(await readings(ctx, false)).actionable
}

async function setMain(ctx: RouteContext): Promise<Response> {
  const port = ctx.deps.mainAgent
  if (port === undefined) return fail(501, 'unsupported', MAIN_UNWIRED)
  const body = await readJsonObject(ctx.request)
  if (body === null) return fail(400, 'invalid', '请求体必须是 JSON 对象')
  const raw = body.address
  if (raw !== null && (typeof raw !== 'string' || !ADDRESS.test(raw))) {
    return fail(400, 'invalid', '地址格式应为 qianmo://<节点>/<智能体>')
  }
  if (raw !== null) {
    const listed = await ctx.roster()
    if (listed.ok && !listed.value.some(agent => agent.address === raw)) {
      return fail(404, 'not_found', MAIN_UNKNOWN)
    }
  }
  const denied = await ctx.admit()
  if (denied !== null) return denied
  const by = ctx.access.principal?.subject ?? 'anonymous'
  const result: ConsoleResult<null> = await port.set(raw, by)
  await ctx.record(
    'chat.main',
    raw ?? 'default',
    result.ok ? 'ok' : 'failed',
    result.ok ? undefined : result.failure.code,
  )
  if (!result.ok) return fail(503, 'unavailable', result.failure.message)
  return json({ main: preferredMainAgent(ctx.deps) ?? null })
}

export const setupRoute: RouteModule = {
  area: {
    id: 'setup',
    label: '初始化配置',
    group: 'manage',
    href: '/admin/setup',
    icon: 'list-checks',
  },
  page: {
    match: underPath('setup'),
    guard: 'view',
    available: ctx => canWrite(ctx.access),
    async render(ctx, rest) {
      if (rest.length !== 0 || !canWrite(ctx.access)) {
        return notFound(`unknown path: ${ctx.url.pathname}`)
      }
      const snapshot = await setupOf(ctx)
      return {
        title: '初始化配置',
        body: renderSetup({
          snapshot,
          admin: true,
          modelWriter: providerWriter(ctx),
          mainSettable: ctx.deps.mainAgent !== undefined,
        }),
      }
    },
    css: KIT_CSS + SETUP_CSS,
    script: SETUP_PAGE_JS,
  },
  api: {
    heads: ['setup'],
    async handle(ctx, _head, rest) {
      const denied = guard(ctx.access.credential, 'admin', 'guarded')
      if (denied !== null) return denied
      if (rest.length === 0) {
        if (ctx.request.method !== 'GET') return methodNotAllowed(['GET'])
        return json(await setupOf(ctx))
      }
      if (rest.length === 1 && rest[0] === 'main') {
        if (ctx.request.method !== 'PUT') return methodNotAllowed(['PUT'])
        return setMain(ctx)
      }
      return notFound(`unknown path: ${ctx.url.pathname}`)
    },
  },
}
