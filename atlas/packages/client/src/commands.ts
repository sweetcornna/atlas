// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The four commands of `qmo` (clients.md §3), over injected effects so each
 * can be run against a fake hub and a fake browser.
 */

import { hostname } from 'node:os'
import { type Browser, findBrowser } from './browser.js'
import { ClientHome } from './home.js'
import {
  ClientError,
  deviceStatus,
  enterUrl,
  type Fetch,
  pairDevice,
  parseHubUrl,
  requestTicket,
  revokeDevice,
  type TicketState,
  ticketState,
} from './hub.js'
import {
  dropDeviceHeader,
  openDefault,
  openOnArgv,
  openOnPipe,
  type PipeOpen,
  pagePath,
  ticketRoute,
} from './window.js'

export interface ClientIO {
  out(line: string): void
  err(line: string): void
  /**
   * One line from the user: the answer to `question` at a terminal, else the
   * first line of standard input; `null` when there is none.
   */
  ask(question: string): Promise<string | null>
}

export interface ClientDeps {
  readonly home: ClientHome
  readonly platform: NodeJS.Platform
  readonly arch: string
  readonly io: ClientIO
  readonly fetch: Fetch
  hostname(): string
  findBrowser(): Browser | null
  openOnArgv(browser: Browser, profile: string, url: string): void
  /** `deviceId` goes with the navigation as `X-Qmo-Device`. */
  openOnPipe(
    browser: Browser,
    profile: string,
    pipeDir: string,
    url: string,
    deviceId: string,
  ): Promise<PipeOpen>
  openDefault(url: string): void
  sleep(ms: number): Promise<void>
}

export function systemDeps(io: ClientIO): ClientDeps {
  return {
    home: new ClientHome(),
    platform: process.platform,
    arch: process.arch,
    io,
    fetch: (input, init) => fetch(input, init),
    hostname,
    findBrowser: () => findBrowser(),
    openOnArgv: (browser, profile, url) =>
      openOnArgv(browser, profile, url, [], process.platform),
    openOnPipe: (browser, profile, pipeDir, url, deviceId) =>
      openOnPipe(browser, profile, pipeDir, url, deviceId),
    openDefault: url => openDefault(url, process.platform),
    sleep: ms => Bun.sleep(ms),
  }
}

const PAIRING_HINT = '配对码在中枢「连接」页「添加设备」里拿'

export interface SignInOptions {
  readonly hub: string
  /** From `--code`, which other users of the computer can read; else asked for. */
  readonly code?: string
  readonly name?: string
  readonly force?: boolean
}

export async function signIn(
  deps: ClientDeps,
  options: SignInOptions,
): Promise<number> {
  const hub = parseHubUrl(options.hub)
  const previous = deps.home.load()
  if (previous !== undefined && options.force !== true)
    throw new ClientError(
      `这台电脑已经登录 ${previous.hub}（设备 ${previous.deviceId}）；重新配对用 --force`,
      2,
    )
  const code =
    options.code?.trim() ||
    (await deps.io.ask(`配对码（${PAIRING_HINT}）：`))?.trim()
  if (!code) throw new ClientError(`需要配对码：${PAIRING_HINT}`, 2)
  const name = options.name?.trim() || deps.hostname()
  const paired = await pairDevice(
    hub,
    { code, name, platform: `${deps.platform}-${deps.arch}` },
    deps.fetch,
  )
  // The device being replaced is revoked, so a re-pair leaves no live token behind.
  if (previous !== undefined) {
    const old = await deps.home.secret.read().catch(() => undefined)
    if (old !== undefined) await revokeDevice(previous.hub, old, deps.fetch)
    deps.home.clear()
  }
  await deps.home.save(
    {
      version: 1,
      hub,
      deviceId: paired.deviceId,
      name: paired.name,
      pairedAt: new Date().toISOString(),
    },
    paired.token,
  )
  deps.io.out(`已登录 ${hub} · 设备 ${paired.name}（${paired.deviceId}）`)
  deps.io.out('打开前台：qmo open')
  return 0
}

/** Poll until the hub says the ticket was spent, or it can no longer be. */
async function waitSpent(
  deps: ClientDeps,
  hub: string,
  token: string,
  id: string,
  until: number,
): Promise<TicketState> {
  for (;;) {
    const state = await ticketState(hub, token, id, deps.fetch)
    if (state !== 'pending' || Date.now() > until) return state
    await deps.sleep(300)
  }
}

/** Where the window settled after the ticket, on the pipe route. */
async function landing(
  deps: ClientDeps,
  open: PipeOpen,
): Promise<string | null> {
  for (let i = 0; i < 40; i++) {
    const where = await pagePath(open)
    if (where !== null && where !== '/client/enter' && where !== 'blank')
      return where
    await deps.sleep(250)
  }
  return null
}

export async function openFront(deps: ClientDeps): Promise<number> {
  const state = deps.home.load()
  if (state === undefined)
    throw new ClientError(
      `还没登录：先 qmo sign-in <中枢地址>（${PAIRING_HINT}）`,
    )
  const token = await deps.home.token()
  // No ticket for a window that will not be ours.
  const browser = deps.findBrowser()
  if (browser === null) {
    deps.openDefault(`${state.hub}/`)
    deps.io.out(
      `没找到 Edge、Chrome 或 Chromium，已用默认浏览器打开 ${state.hub}/，请在登录页登录`,
    )
    return 0
  }
  const outcome = await requestTicket(state.hub, token, deps.fetch)
  const profile = deps.home.windowProfile
  if (outcome.kind === 'unsupported') {
    deps.openOnArgv(browser, profile, `${state.hub}/login`)
    deps.io.out(
      `${outcome.reason ?? '这台中枢没有客户端票据（没开个人账号，或版本较旧）'} · 窗口打开了登录页`,
    )
    return 0
  }
  const url = enterUrl(state.hub, outcome.ticket)
  const until = outcome.expiresAt + 2000

  if (ticketRoute(deps.platform) === 'argv') {
    deps.openOnArgv(browser, profile, url)
    // Nothing can put a header on this window, so the hub asks every time.
    deps.io.out('等窗口进入前台 · 要在窗口里点「进入」确认账号')
    const spent = await waitSpent(deps, state.hub, token, outcome.id, until)
    if (spent !== 'used') {
      deps.io.err(
        '窗口打开了，但没有用上票据（要在一分钟内点「进入」）· 关掉窗口后重新 qmo open',
      )
      return 1
    }
    deps.io.out(`已在窗口里打开 ${state.hub}/`)
    return 0
  }

  const open = await deps.openOnPipe(
    browser,
    profile,
    deps.home.pipeDir,
    url,
    state.deviceId,
  )
  try {
    const spent = await waitSpent(deps, state.hub, token, outcome.id, until)
    const where = spent === 'used' ? await landing(deps, open) : null
    await dropDeviceHeader(open)
    if (spent !== 'used')
      deps.io.err('窗口打开了，但没有用上票据 · 关掉窗口后重新 qmo open')
    else if (where === '/login')
      deps.io.err('窗口停在登录页 · 这台设备的账号可能没有对话权限')
    else deps.io.out(`已在窗口里打开 ${state.hub}/ · 关掉窗口后本命令退出`)
    await open.window.exited
    return spent === 'used' ? 0 : 1
  } finally {
    open.window.close()
  }
}

export async function status(deps: ClientDeps): Promise<number> {
  const { home, io } = deps
  const state = home.load()
  io.out(`目录    ${home.dir}`)
  if (state === undefined) {
    io.out('状态    还没登录')
    return 0
  }
  io.out(`中枢    ${state.hub}`)
  io.out(`设备    ${state.name}（${state.deviceId}）· 配对于 ${state.pairedAt}`)
  io.out(
    `令牌    ${home.secret.kind === 'dpapi' ? 'Windows 数据保护' : '仅本人可读的文件'} · ${home.secret.file}`,
  )
  const token = await home.secret.read()
  const device =
    token === undefined
      ? '令牌不见了，请 qmo sign-in --force'
      : {
          active: '有效',
          revoked: '已吊销，请 qmo sign-in --force',
          owner_inactive:
            '所属账号已停用或已重置 · 账号恢复或重新登录中枢后，再 qmo sign-in --force',
          invalid: '令牌无效，请 qmo sign-in --force',
          unsupported: '这台中枢没有客户端接口',
          unreachable: '连不上中枢',
        }[await deviceStatus(state.hub, token, deps.fetch)]
  io.out(`状态    ${device}`)
  const browser = deps.findBrowser()
  io.out(
    `窗口    ${browser === null ? '没找到 Edge、Chrome 或 Chromium，用默认浏览器' : browser.path}`,
  )
  return 0
}

export async function signOut(deps: ClientDeps): Promise<number> {
  const state = deps.home.load()
  if (state === undefined) {
    deps.io.out('本来就没有登录')
    return 0
  }
  const token = await deps.home.secret.read().catch(() => undefined)
  const revoked =
    token === undefined
      ? 'failed'
      : await revokeDevice(state.hub, token, deps.fetch)
  deps.home.clear()
  if (revoked === 'revoked') {
    deps.io.out('已退出 · 中枢上的这台设备已吊销')
    return 0
  }
  deps.io.err(
    revoked === 'owner_inactive'
      ? '已退出本机 · 设备所属的账号已停用，中枢上的设备没能吊销，请在「连接」页手动吊销'
      : revoked === 'unknown'
        ? '已退出本机 · 中枢不认识这台设备的令牌，请在「连接」页确认设备已不在'
        : '已退出本机 · 中枢上的设备没能吊销，请在「连接」页手动吊销',
  )
  return 1
}
