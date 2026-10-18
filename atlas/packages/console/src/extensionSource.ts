// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * What the hub lets through to a node's `runtime.ext.install` and
 * `runtime.ext.remove` (P36.7, `harness-backends.md` §7.3). The node runs the
 * harness's own command with what it is given, so the hub checks the shape
 * first, and the route checks it before anything is written to the ledger.
 *
 * - Plugins and skills come from GitHub (`owner/repo[#ref]` or an
 *   `https://github.com/owner/repo` address), npm (`[@scope/]name[@x.y.z]`,
 *   an exact version only) or the harness's own marketplace
 *   (`name@marketplace`). No other host, no credentials in an address.
 * - An MCP server is a name plus either a command line or an https address.
 *   Its secrets are a connector's business (P32), so an address carries no
 *   credentials and no query. Names starting `qm-` belong to connectors and
 *   `qianmo` is the node's own bridge.
 * - Nothing starts with `-` (it would read as one of the harness's flags),
 *   nothing climbs a path with `..`, nothing is percent-encoded. A server's
 *   own arguments may start with `-` (`npx -y …`); the node passes them after
 *   the command.
 */

import type { ConsoleResult } from './contracts.js'
import type {
  MagpieExtensionInstall,
  MagpieExtensionKind,
} from './directionPorts.js'

/** The request the node gets, less the agent (`NativeExtensionInstallRequest`). */
export interface ExtensionInstallRequest {
  readonly kind: MagpieExtensionKind
  readonly source: string
  readonly name?: string
  readonly command?: string
  readonly args?: readonly string[]
  readonly url?: string
}

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/
const REPO = /^[A-Za-z0-9._-]{1,100}$/
const REF = /^[A-Za-z0-9._/-]{1,200}$/
const NPM_PART = /^[a-z0-9~][a-z0-9._~-]{0,213}$/
const NPM_EXACT = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
const MARKET_PART = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
/** The node's own rule (`nativeExt.ts`): no dots, a harness config path splits on them. */
const MCP_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/
const BARE_COMMAND = /^[A-Za-z0-9_][A-Za-z0-9_.+-]{0,127}$/
const PATH_PART = /^[A-Za-z0-9_.+@-]{1,128}$/
/** A harness's own id for an installed item (`name@market`, `@scope/pkg`, `owner/repo`). */
const ITEM_NAME = /^[A-Za-z0-9@~_][A-Za-z0-9._:/@+~-]{0,213}$/
const MAX_ARGS = 32
const MAX_ARG = 512

function invalid<T>(message: string): ConsoleResult<T> {
  return { ok: false, failure: { code: 'invalid', message } }
}

/** Whitespace, control characters, `..`, `%`, `\` or a leading `-`. */
function unsafe(text: string): boolean {
  return (
    text.startsWith('-') ||
    text.includes('..') ||
    text.includes('%') ||
    text.includes('\\') ||
    /[\s\p{Cc}]/u.test(text)
  )
}

function gitRef(ref: string): boolean {
  return (
    REF.test(ref) &&
    !ref.startsWith('-') &&
    !ref.startsWith('/') &&
    !ref.endsWith('/') &&
    !ref.includes('//') &&
    !ref.endsWith('.lock')
  )
}

function githubShort(text: string): boolean {
  const [repo, ref, ...more] = text.split('#')
  if (more.length > 0 || repo === undefined) return false
  const parts = repo.split('/')
  if (parts.length !== 2) return false
  const [owner, name] = parts
  return (
    owner !== undefined &&
    name !== undefined &&
    OWNER.test(owner) &&
    REPO.test(name) &&
    (ref === undefined || gitRef(ref))
  )
}

/** `https://github.com/owner/repo[.git][/][#ref]` as `https://github.com/owner/repo[#ref]`. */
function githubAddress(text: string): string | null {
  // Checked on the text: `URL` would quietly resolve a `..` away.
  if (text.includes('..') || /[\s\p{Cc}\\%]/u.test(text)) return null
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return null
  }
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'github.com' ||
    url.username !== '' ||
    url.password !== '' ||
    url.port !== '' ||
    url.search !== '' ||
    // `URL` drops an empty `?` and `@`; the text must not have had them.
    text.includes('?') ||
    text.slice('https://'.length).split('/')[0] !== 'github.com'
  )
    return null
  const match = /^\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url.pathname)
  if (match === null) return null
  const [, owner = '', repo = ''] = match
  const ref = url.hash === '' ? undefined : url.hash.slice(1)
  const short =
    ref === undefined ? `${owner}/${repo}` : `${owner}/${repo}#${ref}`
  return githubShort(short) ? `https://github.com/${short}` : null
}

function npmName(text: string): boolean {
  if (!text.startsWith('@')) return NPM_PART.test(text)
  const parts = text.slice(1).split('/')
  return (
    parts.length === 2 &&
    parts.every(part => NPM_PART.test(part)) &&
    text.length <= 214
  )
}

function npmSpec(text: string): boolean {
  const at = text.lastIndexOf('@')
  if (at <= 0) return npmName(text)
  return npmName(text.slice(0, at)) && NPM_EXACT.test(text.slice(at + 1))
}

function marketplace(text: string): boolean {
  const parts = text.split('@')
  return parts.length === 2 && parts.every(part => MARKET_PART.test(part))
}

/**
 * A plugin's or skill's source, normalised; null when it is none of GitHub,
 * npm or a marketplace name.
 */
function sourceOf(text: string): string | null {
  if (text.length === 0 || text.length > 300) return null
  if (text.startsWith('https://')) return githubAddress(text)
  if (unsafe(text) || text.includes(':')) return null
  if (githubShort(text) || npmSpec(text) || marketplace(text)) return text
  return null
}

/** A skill's source: a GitHub repository only. */
function githubSourceOf(text: string): string | null {
  if (text.length === 0 || text.length > 300) return null
  if (text.startsWith('https://')) return githubAddress(text)
  if (unsafe(text) || text.includes(':')) return null
  return githubShort(text) ? text : null
}

function commandOf(text: string): boolean {
  if (text.length === 0 || unsafe(text)) return false
  if (!text.startsWith('/')) return BARE_COMMAND.test(text)
  const parts = text.slice(1).split('/')
  return (
    text.length <= 256 &&
    parts.every(part => PATH_PART.test(part) && part !== '.')
  )
}

/** An MCP server's https address: any host, no credentials, no query. */
function mcpAddress(text: string): string | null {
  if (text.length > 500 || text.includes('..') || /[\s\p{Cc}\\]/u.test(text))
    return null
  const authority = text.slice('https://'.length).split('/')[0] ?? ''
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return null
  }
  if (
    url.protocol !== 'https:' ||
    url.hostname === '' ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    text.includes('?') ||
    text.includes('#') ||
    authority.includes('@')
  )
    return null
  return url.href
}

/**
 * Check one install and put it the way the node takes it. `source` for an MCP
 * server is its address or command, since the node's request needs one.
 */
export function extensionInstallRequest(
  input: Omit<MagpieExtensionInstall, 'node' | 'agent'>,
): ConsoleResult<ExtensionInstallRequest> {
  if (input.kind !== 'mcp') {
    if (
      input.name !== undefined ||
      input.command !== undefined ||
      input.args !== undefined ||
      input.url !== undefined
    )
      return invalid('插件与技能只给来源')
    const text = input.source ?? ''
    if (input.kind === 'skill') {
      const source = githubSourceOf(text)
      if (source === null) return invalid('技能只收 GitHub 仓库')
      return { ok: true, value: { kind: 'skill', source } }
    }
    const source = sourceOf(text)
    if (source === null)
      return invalid('来源只收 GitHub 仓库 · npm 包名 · 名字@市场')
    return { ok: true, value: { kind: input.kind, source } }
  }
  const name = input.name ?? ''
  if (!MCP_NAME.test(name)) return invalid('MCP 名字只用字母数字与 _ -')
  if (name.toLowerCase().startsWith('qm-') || name.toLowerCase() === 'qianmo')
    return invalid('qm- 开头的名字与 qianmo 留给阡陌自己')
  if (input.source !== undefined) return invalid('MCP 给命令或地址 · 不给来源')
  if ((input.command === undefined) === (input.url === undefined))
    return invalid('MCP 要给命令或 https 地址 · 只给一样')
  if (input.url !== undefined) {
    if (input.args !== undefined) return invalid('地址方式不带参数')
    const url = mcpAddress(input.url)
    if (url === null)
      return invalid('地址只收 https · 不带账号口令与查询参数 · 密钥请用连接器')
    return { ok: true, value: { kind: 'mcp', source: url, name, url } }
  }
  const command = input.command ?? ''
  if (!commandOf(command))
    return invalid('命令只收程序名或绝对路径 · 不以 - 开头')
  const args = input.args ?? []
  if (
    args.length > MAX_ARGS ||
    args.some(arg => arg.length > MAX_ARG || /\p{Cc}/u.test(arg))
  )
    return invalid(
      `参数最多 ${MAX_ARGS} 个 · 每个不超过 ${MAX_ARG} 字 · 不含控制字符`,
    )
  return {
    ok: true,
    value: { kind: 'mcp', source: command, name, command, args },
  }
}

/** An installed item's name as a removal takes it, or null when it cannot be one. */
export function extensionItemName(name: string): string | null {
  return ITEM_NAME.test(name) && !unsafe(name) ? name : null
}
