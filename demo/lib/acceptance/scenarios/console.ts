// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: MIT

/**
 * 控制台维度 —— HTTP 面、token、注册中心租约，以及签名唤醒的整条真链路。
 *
 * 四条读断言之前要先知道的事实：
 *
 * ① **在守卫路由上，角色判定排在「方法对不对」之前。**
 *    匿名的 `POST /v0/audit` 拿到的是 401 而不是 405；同一条请求换成 admin
 *    token 才是 405。这样一枚没有凭据的请求探不出这台控制台支持哪些方法。
 *    **公开路径不受这条约束** —— `DELETE /v0/health` 匿名就是 405，因为
 *    `/v0/health` 本来就人人可读，那里没有可泄露的东西。这两条差别真实存在，
 *    写断言时别把它们并成一句（本套件写这条时先按「一律 401」写过一版，红了）。
 *
 * ② **公开路径只有五条**：`GET /v0/health`、两个 `/assets/*`、`GET|POST /login`、
 *    `POST /logout`。其余一律要 token，只读 token 够不到任何 admin 路由。
 *
 * ③ **生成的 token 才回显，显式给的只打出处。**这不是排版偏好，是泄露面：
 *    显式 token 已经在操作者手里，再打进终端记录与 CI 日志只是多一份副本。
 *    两条场景分别钉正反两面。
 *
 * ④ **签名唤醒有严格的三步顺序**（console.md §4.6）：先 `--print-wake-identity`
 *    拿公钥 → 每个目标节点 `--trust console=<公钥>` 重启 → 控制台再开
 *    `--wake-sign`。顺序反了会得到 `E_CAP_INVALID: no published public key for
 *    issuer console`，而那条错读起来像「签名坏了」。本维度把正序走通的那条与
 *    「不签名」「不在白名单」两条拒绝各测一遍。
 *
 * 注册中心那半边有一条**安全事实**顺带钉住：它自己零鉴权（console.md §8.2），
 * 控制台的 admin token 保护的只是控制台。所以这里所有注册动作都经控制台的
 * 代理路由发，测的是那层门；直接打注册中心的场景一条都不写 —— 那会把「注册
 * 中心没有门」写成一条看起来像功能的绿色。
 */

import { LIMITS } from '@qianmo/protocol'
import { DEFAULT_TTL_MS } from '@qianmo/registry'
import { RUNTIME_RATE } from '@qianmo/router'
import { Checks } from '../checks.js'
import { ACCEPTANCE_PSK } from '../local/driver.js'
import { http } from '../local/console.js'
import { sleep } from '../local/spawn.js'
import { delay, waitForMailbox } from '../observe.js'
import type { ConsoleSlot, Scenario, ScenarioContext } from '../types.js'
import {
  ADDRESS,
  AGENT,
  NODE,
  TEAM,
  newParty,
  startNodeTrusting,
} from './fixtures.js'

/** 控制台自己的地址，`--chat-from` 的出厂默认。 */
const CONSOLE_FROM = 'qianmo://console/operator'
/** 那个地址的节点段 —— 唤醒身份就以它命名。 */
const CONSOLE_NODE = 'console'

const AGENT_ADDRESS = 'qianmo://node-a/planner'
const AGENT_ENDPOINT = 'ws://127.0.0.1:38611'

/** 生成的 token：`randomBytes(24).toString('base64url')` = 32 个 base64url 字符。 */
const GENERATED_TOKEN = /^[A-Za-z0-9_-]{32}$/

function agentsOf(
  json: Record<string, unknown> | undefined,
): Record<string, unknown>[] {
  const agents = json?.agents
  return Array.isArray(agents) ? (agents as Record<string, unknown>[]) : []
}

/**
 * 跑一次 `qm console --print-wake-identity`，把 `<node>=<公钥>` 拆开。
 *
 * 经**控制台位**跑而不是本地 `runCli`：这条命令会在配置根里生成一把唤醒身份
 * （那是控制面凭据），而后面 `--wake-sign` 的控制台必须复用**同一个**配置根，
 * 否则它签名用的是另一把私钥、目标节点 `--trust` 的又是这一把公钥。
 */
async function printWakeIdentity(
  ctx: ScenarioContext,
  slot: ConsoleSlot,
): Promise<{
  readonly line: string
  readonly node?: string
  readonly publicKey?: string
}> {
  const result = await slot.exec(['console', '--print-wake-identity'], {
    timeoutMs: 40_000,
  })
  const line = result.stdout.trim()
  ctx.log(`print-wake-identity: code=${result.code} stdout=${line}`)
  const separator = line.indexOf('=')
  if (result.code !== 0 || separator <= 0) return { line }
  return {
    line,
    node: line.slice(0, separator),
    publicKey: line.slice(separator + 1),
  }
}

export const consoleScenarios: readonly Scenario[] = [
  {
    id: 'console/health-public-agents-guarded',
    dimension: 'console',
    title: '/v0/health 公开、/v0/agents 要 token，守卫路由上角色先于方法',
    expected:
      "无 token 的 GET /v0/health → 200 {status:'ok'}；无 token 的 GET /v0/agents → 401 unauthorized；无 token 的 POST /v0/audit → 401，同一条带 admin token 才是 405",
    requires: ['spawn-console'],
    timeoutMs: 120_000,
    async run(ctx) {
      const registry = await ctx.driver.startRegistry(ctx)
      const console_ = await (await ctx.driver.consoleSlot(ctx)).start({
        registryUrl: registry.hostUrl,
      })

      const health = await http(`${console_.url}/v0/health`)
      const anonymousAgents = await http(`${console_.url}/v0/agents`)
      const withView = await http(`${console_.url}/v0/agents`, {
        token: console_.viewToken,
      })
      // 守卫路由上角色排在方法之前：`/v0/audit` 只支持 GET，但匿名的 POST
      // 拿到的是 401 而不是 405 —— 没有凭据就问不出这条路径支持什么方法。
      const anonymousWrongMethod = await http(`${console_.url}/v0/audit`, {
        method: 'POST',
      })
      const viewWrongMethod = await http(`${console_.url}/v0/audit`, {
        method: 'POST',
        token: console_.viewToken,
      })

      return new Checks()
        .note('health', `${health.status} ${health.body}`)
        .note(
          'anonymous /v0/agents',
          `${anonymousAgents.status} ${anonymousAgents.body}`,
        )
        .note('view /v0/agents', `${withView.status} ${withView.body}`)
        .eq(health.status, 200, 'GET /v0/health 的状态码')
        .eq(health.json?.status, 'ok', 'GET /v0/health 的 status 字段')
        .eq(anonymousAgents.status, 401, '无 token 的 GET /v0/agents 状态码')
        .eq(
          (anonymousAgents.json?.error as Record<string, unknown> | undefined)
            ?.code,
          'unauthorized',
          '401 的 error.code',
        )
        .eq(withView.status, 200, '带 view token 的 GET /v0/agents 状态码')
        .expect(
          Array.isArray(withView.json?.agents),
          '带 token 时拿到 agents 数组',
          withView.body,
        )
        .eq(
          anonymousWrongMethod.status,
          401,
          '匿名 POST /v0/audit 的状态码（守卫路由上角色先于方法）',
        )
        .eq(
          viewWrongMethod.status,
          405,
          '带 view token 的 POST /v0/audit 状态码（有凭据才答得出方法不对）',
        )
        .note(
          '公开路径不适用这条',
          `匿名 DELETE /v0/health = ${(await http(`${console_.url}/v0/health`, { method: 'DELETE' })).status}（405，因为 /v0/health 本来就人人可读）`,
        )
        .done('公开面与守卫面各自成立')
    },
  },

  {
    id: 'console/view-token-cannot-admin',
    dimension: 'console',
    title: '只读 token 够不到 admin 路由，admin token 够得到',
    expected:
      'POST /v0/agents 带 view token → 403 forbidden；带 admin token → 200 且注册真的落到注册中心',
    requires: ['spawn-console'],
    timeoutMs: 120_000,
    async run(ctx) {
      const registry = await ctx.driver.startRegistry(ctx)
      const console_ = await (await ctx.driver.consoleSlot(ctx)).start({
        registryUrl: registry.hostUrl,
      })
      const body = { address: AGENT_ADDRESS, endpoint: AGENT_ENDPOINT }

      const asView = await http(`${console_.url}/v0/agents`, {
        method: 'POST',
        token: console_.viewToken,
        body,
      })
      const asAdmin = await http(`${console_.url}/v0/agents`, {
        method: 'POST',
        token: console_.adminToken,
        body,
      })
      const listed = await http(`${console_.url}/v0/agents`, {
        token: console_.viewToken,
      })

      return (
        new Checks()
          .note('view POST', `${asView.status} ${asView.body}`)
          .note('admin POST', `${asAdmin.status} ${asAdmin.body}`)
          .eq(asView.status, 403, 'view token 打 admin 路由的状态码')
          .eq(
            (asView.json?.error as Record<string, unknown> | undefined)?.code,
            'forbidden',
            '403 的 error.code',
          )
          // 200 而不是 201 是刻意的：控制台的代理端口答不出「这个地址是不是新的」。
          .eq(
            asAdmin.status,
            200,
            'admin token 注册的状态码（是 200 不是 201）',
          )
          .eq(asAdmin.json?.address, AGENT_ADDRESS, '回执里的 address')
          .eq(
            agentsOf(listed.json).filter(a => a.address === AGENT_ADDRESS)
              .length,
            1,
            '名册里这条登记的条数',
          )
          .done('两枚 token 的权限边界成立')
      )
    },
  },

  {
    id: 'console/generated-token-echoed-in-banner',
    dimension: 'console',
    title:
      '回环上自动生成的 token 会回显在 banner 里，且形状是 32 位 base64url',
    expected:
      'banner 的 open 行带 ?token=<view>，view/admin 两枚互不相同、都能用',
    requires: ['spawn-console'],
    timeoutMs: 120_000,
    async run(ctx) {
      const registry = await ctx.driver.startRegistry(ctx)
      const console_ = await (await ctx.driver.consoleSlot(ctx)).start({
        registryUrl: registry.hostUrl,
      })
      const banner = await console_.banner()
      const withView = await http(`${console_.url}/v0/limits`, {
        token: console_.viewToken,
      })
      const withAdmin = await http(`${console_.url}/v0/limits`, {
        token: console_.adminToken,
      })

      return new Checks()
        .note('banner', banner)
        .expect(
          GENERATED_TOKEN.test(console_.viewToken),
          'view token 是 32 位 base64url',
          console_.viewToken,
        )
        .expect(
          GENERATED_TOKEN.test(console_.adminToken),
          'admin token 是 32 位 base64url',
          console_.adminToken,
        )
        .expect(
          console_.viewToken !== console_.adminToken,
          '两枚 token 不相同',
          `${console_.viewToken} / ${console_.adminToken}`,
        )
        .contains(banner, `?token=${console_.viewToken}`, 'banner 的 open 行')
        .eq(withView.status, 200, 'view token 打 /v0/limits')
        .eq(withAdmin.status, 200, 'admin token 打 /v0/limits')
        .done('生成的 token 可用且被回显')
    },
  },

  {
    id: 'console/supplied-token-not-echoed',
    dimension: 'console',
    title: '显式给的 token 只打出处、不打值（少一份泄露面）',
    expected:
      "经环境变量给 token 时，banner 里出现 'from $QIANMO_CONSOLE_VIEW_TOKEN'，且全文不含 token 值",
    requires: ['spawn-console'],
    timeoutMs: 120_000,
    async run(ctx) {
      const registry = await ctx.driver.startRegistry(ctx)
      const viewToken = 'acceptance-view-token-0001'
      const adminToken = 'acceptance-admin-token-0001'
      const console_ = await (await ctx.driver.consoleSlot(ctx)).start({
        registryUrl: registry.hostUrl,
        viewToken,
        adminToken,
      })
      const banner = await console_.banner()
      const probe = await http(`${console_.url}/v0/limits`, {
        token: viewToken,
      })

      return (
        new Checks()
          .note('banner', banner)
          .contains(
            banner,
            'from $QIANMO_CONSOLE_VIEW_TOKEN',
            'banner 的 view-token 行',
          )
          .contains(
            banner,
            'from $QIANMO_CONSOLE_ADMIN_TOKEN',
            'banner 的 admin-token 行',
          )
          .notContains(banner, viewToken, 'banner 全文')
          .notContains(banner, adminToken, 'banner 全文')
          .contains(banner, '?token=<your view token>', 'banner 的 open 行')
          // 不回显不等于没生效 —— 行为面单独验一次。
          .eq(probe.status, 200, '环境变量里的那枚 token 真的能用')
          .done('显式 token 不进终端记录')
      )
    },
  },

  {
    id: 'console/limits-mirror-package-constants',
    dimension: 'console',
    title: '/v0/limits 报的三组数字与三个包的常量逐个相等（没有第二份抄写）',
    expected:
      'protocol 段 === LIMITS、runtime 段 === RUNTIME_RATE、registryTtlMs === DEFAULT_TTL_MS',
    requires: ['spawn-console'],
    timeoutMs: 120_000,
    async run(ctx) {
      const registry = await ctx.driver.startRegistry(ctx)
      const console_ = await (await ctx.driver.consoleSlot(ctx)).start({
        registryUrl: registry.hostUrl,
      })
      const probe = await http(`${console_.url}/v0/limits`, {
        token: console_.viewToken,
      })
      const protocol = probe.json?.protocol as
        | Record<string, unknown>
        | undefined
      const runtime = probe.json?.runtime as Record<string, unknown> | undefined

      return new Checks()
        .note('/v0/limits', probe.body)
        .eq(probe.status, 200, '状态码')
        .eq(
          protocol?.maxMessageBytes,
          LIMITS.maxMessageBytes,
          'protocol.maxMessageBytes',
        )
        .eq(protocol?.maxHops, LIMITS.maxHops, 'protocol.maxHops')
        .eq(
          protocol?.defaultTtlMs,
          LIMITS.defaultTtlMs,
          'protocol.defaultTtlMs',
        )
        .eq(
          protocol?.defaultTaskTtlMs,
          LIMITS.defaultTaskTtlMs,
          'protocol.defaultTaskTtlMs',
        )
        .eq(
          protocol?.ratePerMinute,
          LIMITS.ratePerMinute,
          'protocol.ratePerMinute',
        )
        .eq(runtime?.capacity, RUNTIME_RATE.capacity, 'runtime.capacity')
        .eq(runtime?.windowMs, RUNTIME_RATE.windowMs, 'runtime.windowMs')
        .eq(probe.json?.registryTtlMs, DEFAULT_TTL_MS, 'registryTtlMs')
        .done('控制台报的上限就是各包的常量')
    },
  },

  {
    id: 'console/registry-lease-persisted',
    dimension: 'console',
    title: '注册中心租约：线上带 expiresAt，盘上不带（重启时按 TTL 重算）',
    expected:
      'expiresAt === lastHeartbeatAt + DEFAULT_TTL_MS；agents.json 是 version 1 且条目里没有 expiresAt',
    requires: ['spawn-console'],
    timeoutMs: 120_000,
    async run(ctx) {
      const registry = await ctx.driver.startRegistry(ctx, { persist: true })
      const console_ = await (await ctx.driver.consoleSlot(ctx)).start({
        registryUrl: registry.hostUrl,
      })

      const registered = await http(`${console_.url}/v0/agents`, {
        method: 'POST',
        token: console_.adminToken,
        body: {
          address: AGENT_ADDRESS,
          endpoint: AGENT_ENDPOINT,
          capabilities: ['task.request'],
        },
      })
      // 落盘是同步的（原子写），但读之前给一拍，免得撞上 rename 的窗口。
      await delay(200)
      let disk: Record<string, unknown> | undefined
      // 盘在哪台机器上由驱动决定，所以经 `readState()` 而不是 `node:fs`。
      let diskRaw = (await registry.readState()) ?? ''
      try {
        disk = JSON.parse(diskRaw) as Record<string, unknown>
      } catch (error) {
        diskRaw = `读不回注册中心的落盘内容: ${String(error)}\n${diskRaw}`
      }
      const persisted = agentsOf(disk).find(a => a.address === AGENT_ADDRESS)
      const lastHeartbeatAt = registered.json?.lastHeartbeatAt
      const expiresAt = registered.json?.expiresAt

      return (
        new Checks()
          .note('注册回执', registered.body)
          .note('盘上的 agents.json', diskRaw)
          .eq(registered.status, 200, '注册状态码')
          .expect(
            typeof lastHeartbeatAt === 'number' &&
              typeof expiresAt === 'number',
            '回执带 lastHeartbeatAt 与 expiresAt',
            `${String(lastHeartbeatAt)} / ${String(expiresAt)}`,
          )
          .eq(
            typeof expiresAt === 'number' && typeof lastHeartbeatAt === 'number'
              ? expiresAt - lastHeartbeatAt
              : undefined,
            DEFAULT_TTL_MS,
            '线上的 expiresAt - lastHeartbeatAt',
          )
          .eq(disk?.version, 1, '盘上的 version')
          .expect(persisted !== undefined, '盘上有这条登记', diskRaw)
          .eq(persisted?.endpoint, AGENT_ENDPOINT, '盘上的 endpoint')
          .eq(persisted?.status, 'online', '盘上的 status')
          // 盘上不存 expiresAt 是设计：恢复时按 lastHeartbeatAt + ttl 重算，
          // 于是改 TTL 立刻对存量生效，而不是让老记录带着旧 TTL 复活。
          .expect(
            persisted !== undefined && persisted.expiresAt === undefined,
            '盘上的条目里没有 expiresAt（恢复时重算）',
            persisted,
          )
          .done('租约的线上形状与落盘形状各自正确')
      )
    },
  },

  {
    id: 'console/registry-lease-expires-and-renews',
    dimension: 'console',
    title: '租约到期即从名册消失，心跳能把它续回来',
    expected:
      '短 TTL 下：心跳后仍在名册；停止心跳并等过 TTL 后名册为空（惰性求值，无定时清扫）',
    requires: ['spawn-console'],
    timeoutMs: 120_000,
    async run(ctx) {
      // **TTL 要吃倍率**，理由与 issue #91 那几处硬预算是同一条，只是这里更隐蔽：
      // 流逝的不只是下面那几次 `sleep`，还有**每一次 HTTP 往返**。本地腿的往返
      // 约 1 ms，相对 3 s 的 TTL 可以当成零；真机腿的每一次都要从 runner 经
      // SSH 隧道到控制台那台机器，几百毫秒起步。于是「注册 → 睡 0.6×TTL →
      // 心跳」这条本来留了 40% 余量的路径会被往返吃穿，租约**真的**过期，
      // 心跳如实回 404 —— 那是产品的正确回答，红的是这条场景自己的算术。
      //
      // 实测：真机腿上这条以「心跳 404」收场，而三次 sleep 合计 8.1 s、场景总
      // 耗时 42.4 s —— 三十多秒全花在启动与往返上。
      //
      // 乘上 `timeoutScale` 之后本地腿（倍率 1）逐字节不变，真机腿（默认 4）
      // 拿到 12 s，往返重新变得可以忽略。
      const ttlMs = Math.round(3_000 * ctx.timeoutScale)
      const expiryGraceMs = Math.round(1_500 * ctx.timeoutScale)
      const registry = await ctx.driver.startRegistry(ctx, { ttlMs })
      const console_ = await (await ctx.driver.consoleSlot(ctx)).start({
        registryUrl: registry.hostUrl,
      })
      const encoded = encodeURIComponent(AGENT_ADDRESS)

      const registered = await http(`${console_.url}/v0/agents`, {
        method: 'POST',
        token: console_.adminToken,
        body: { address: AGENT_ADDRESS, endpoint: AGENT_ENDPOINT },
      })
      await sleep(Math.floor(ttlMs * 0.6))
      const beat = await http(
        `${console_.url}/v0/agents/${encoded}/heartbeat`,
        { method: 'POST', token: console_.adminToken },
      )
      await sleep(Math.floor(ttlMs * 0.6))
      // 续过一次，此刻距首次注册已超过一个 TTL，距心跳还没到。
      const afterBeat = await http(`${console_.url}/v0/agents`, {
        token: console_.viewToken,
      })
      await sleep(ttlMs + expiryGraceMs)
      const afterExpiry = await http(`${console_.url}/v0/agents`, {
        token: console_.viewToken,
      })

      return new Checks()
        .note('注册', `${registered.status} ${registered.body}`)
        .note('心跳', `${beat.status} ${beat.body}`)
        .note('心跳之后的名册', `${afterBeat.status} ${afterBeat.body}`)
        .note('过期之后的名册', `${afterExpiry.status} ${afterExpiry.body}`)
        .eq(registered.status, 200, '注册状态码')
        .eq(beat.status, 200, '心跳状态码')
        .expect(
          typeof beat.json?.expiresAt === 'number' &&
            typeof registered.json?.expiresAt === 'number' &&
            (beat.json.expiresAt as number) >
              (registered.json.expiresAt as number),
          '心跳把 expiresAt 往后推了',
          `${String(registered.json?.expiresAt)} → ${String(beat.json?.expiresAt)}`,
        )
        .eq(
          agentsOf(afterBeat.json).length,
          1,
          '心跳续过一个 TTL 之后名册里的条数',
        )
        .eq(agentsOf(afterExpiry.json).length, 0, '停止心跳过了 TTL 之后的条数')
        .done('租约按 TTL 过期、按心跳续期')
    },
  },

  {
    id: 'console/wake-node-not-in-allowlist',
    dimension: 'console',
    title: '唤醒目标不在启动白名单里 → 403 rejected（客户端给的 URL 一律丢弃）',
    expected:
      "403 + error.code='rejected' + '唤醒节点不在启动时配置的白名单中'",
    requires: ['spawn-console'],
    timeoutMs: 120_000,
    async run(ctx) {
      const registry = await ctx.driver.startRegistry(ctx)
      // 白名单里那条的 URL 拨不拨得通无所谓：这条场景问的是**名字不在表里**
      // 时的 403，判定发生在拨号之前。所以这里给一个必然拨不通的口，
      // 而不是去分配一个（分配来的还是 runner 的口，真机腿上更没意义）。
      const console_ = await (await ctx.driver.consoleSlot(ctx)).start({
        registryUrl: registry.hostUrl,
        wakeTargets: [{ node: NODE, url: 'ws://127.0.0.1:1' }],
        wakePsk: { [NODE]: ACCEPTANCE_PSK },
      })
      const probe = await http(`${console_.url}/v0/wake`, {
        method: 'POST',
        token: console_.adminToken,
        body: {
          node: 'somewhere-else',
          from: CONSOLE_FROM,
          to: 'qianmo://somewhere-else/main',
          prompt: 'acceptance allowlist probe',
        },
      })
      return new Checks()
        .note('响应', `${probe.status} ${probe.body}`)
        .eq(probe.status, 403, '状态码')
        .eq(
          (probe.json?.error as Record<string, unknown> | undefined)?.code,
          'rejected',
          'error.code',
        )
        .contains(probe.body, '唤醒节点不在启动时配置的白名单中', '响应正文')
        .done('白名单之外的节点唤不动')
    },
  },

  {
    id: 'console/wake-unsigned-refused',
    dimension: 'console',
    title: '不开 --wake-sign 打严格档节点：403，且拒绝原因原样透到操作面',
    expected:
      "403 + error.code='refused' + 正文含 'E_CAP_INSUFFICIENT' 与 'needs write-limited'",
    requires: ['spawn-console', 'spawn-node', 'read-node-files'],
    timeoutMs: 180_000,
    async run(ctx) {
      const registry = await ctx.driver.startRegistry(ctx)
      const node = await startNodeTrusting(ctx, newParty(), {
        policy: 'signed-task',
      })
      // `hostEndpoint`：拨号方是控制台，它和节点同机（真机腿上由驱动保证），
      // 拨的是节点自己那台机器的回环口。给 `endpoint` 的话真机腿上它会去打
      // **控制台机器**上的一个 runner 侧隧道口 —— 那里没有人在听。
      const console_ = await (await ctx.driver.consoleSlot(ctx)).start({
        registryUrl: registry.hostUrl,
        wakeTargets: [{ node: NODE, url: node.hostEndpoint }],
        wakePsk: { [NODE]: ACCEPTANCE_PSK },
      })
      const probe = await http(`${console_.url}/v0/wake`, {
        method: 'POST',
        token: console_.adminToken,
        body: {
          node: NODE,
          from: CONSOLE_FROM,
          to: ADDRESS,
          prompt: 'acceptance unsigned wake',
        },
      })
      return (
        new Checks()
          .note('响应', `${probe.status} ${probe.body}`)
          .note('控制台 stderr', (await console_.stderr()).slice(0, 1_500))
          .eq(probe.status, 403, '状态码')
          .eq(
            (probe.json?.error as Record<string, unknown> | undefined)?.code,
            'refused',
            'error.code',
          )
          .contains(probe.body, 'E_CAP_INSUFFICIENT', '响应正文')
          .contains(probe.body, 'needs write-limited', '响应正文')
          // 兜底文案不该出现：拿到了真原因就必须给真原因（issue #34 的判据）。
          .notContains(probe.body, '原因见该节点的审计链', '响应正文')
          .done('未签名唤醒被拒且原因可读')
      )
    },
  },

  {
    id: 'console/wake-sign-round-trip',
    dimension: 'console',
    title:
      '签名唤醒整条链路：--print-wake-identity → --trust → --wake-sign → 投进信箱',
    expected:
      "POST /v0/wake → 200 receipt='accepted'，节点信箱里那条 notice.trust='verified-capability'",
    requires: ['spawn-console', 'spawn-node', 'read-node-files'],
    timeoutMs: 240_000,
    async run(ctx) {
      const checks = new Checks()
      const registry = await ctx.driver.startRegistry(ctx)
      const slot = await ctx.driver.consoleSlot(ctx)

      // 第一步：把控制台的唤醒身份印出来。这一步**不起服务器、不读 token**，
      // 所以它在一台还没配好的机器上也答得出来 —— 那正是分发公钥的那一刻。
      const identity = await printWakeIdentity(ctx, slot)
      checks
        .note('print-wake-identity', identity.line)
        .eq(identity.node, CONSOLE_NODE, '身份节点段')
      if (identity.publicKey === undefined) {
        return checks.skip(`--print-wake-identity 没给出公钥：${identity.line}`)
      }

      // 第二步：目标节点把这枚公钥收进 --trust，并跑在严格档上。
      const node = await startNodeTrusting(ctx, newParty(), {
        policy: 'signed-task',
        trust: [`${CONSOLE_NODE}=${identity.publicKey}`],
      })

      // 第三步：控制台带 --wake-sign 起来，复用第一步那个配置根（身份文件
      // 就在里面，`loadOrCreateNodeKeys` 是 wx 创建、永不覆盖）。
      const console_ = await slot.start({
        registryUrl: registry.hostUrl,
        wakeTargets: [{ node: NODE, url: node.hostEndpoint }],
        wakePsk: { [NODE]: ACCEPTANCE_PSK },
        signWakes: true,
      })
      const probe = await http(`${console_.url}/v0/wake`, {
        method: 'POST',
        token: console_.adminToken,
        body: {
          node: NODE,
          from: CONSOLE_FROM,
          to: ADDRESS,
          prompt: 'acceptance signed wake',
        },
      })
      const inbox = await waitForMailbox(ctx, node, TEAM, AGENT)
      const last = inbox.at(-1)

      const banner = await console_.banner()
      return checks
        .note('banner 的 wake-signing 行', banner)
        .note('响应', `${probe.status} ${probe.body}`)
        .note('信箱原文', last?.raw ?? '(信箱是空的)')
        .contains(banner, 'wake-signing', 'banner 里有签名身份那一行')
        .contains(
          banner,
          `${CONSOLE_NODE}=${identity.publicKey}`,
          'banner 里那一行的取值（可原样粘进 --trust）',
        )
        .eq(probe.status, 200, '状态码')
        .eq(probe.json?.receipt, 'accepted', 'receipt')
        .expect(
          typeof probe.json?.msgId === 'string' &&
            typeof probe.json?.taskId === 'string',
          '回执带 msgId 与 taskId',
          probe.body,
        )
        .expect(inbox.length > 0, '信箱里有一条', inbox.length)
        .eq(last?.trust, 'verified-capability', 'notice.trust')
        .eq(last?.capIss, CONSOLE_NODE, 'origin.capIss')
        .done('控制台签名唤醒走通整条链路')
    },
  },
]
