// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The console's native extension operations (P36.7, `harness-backends.md`
 * §7.3): `runtime.ext.list`, `runtime.ext.install` and `runtime.ext.remove`
 * for one agent, carried out by the harness's **own** commands in the
 * agent's environment (`runtimeEnv`, the same state the resident process
 * and `qm runtime open` use), from the agent's empty launch directory, with
 * standard input closed and a time limit (lists 30 s, changes 10 min).
 *
 * | runtime | plugins / extensions | MCP servers | skills |
 * |---|---|---|---|
 * | Claude Code | `claude plugin install <p>@<m> -s user` (a GitHub marketplace is added first) | `claude mcp add -s user <n> -- <cmd> …` | `skills/<n>/SKILL.md` |
 * | Codex | `codex plugin add <p>@<m>` (likewise) | `codex mcp add <n> -- <cmd> …` / `--url` | `skills/<n>/SKILL.md` |
 * | dsh | `dsh plugin --profile acp add <npm|github:>` | none: its web frontend | `skills/<n>/SKILL.md` |
 * | Gemini CLI | `gemini extensions install <github> --consent` | `gemini mcp add -s user <n> <cmd> -- …` | `.gemini/skills/<n>/SKILL.md` |
 * | Qwen Code | `qwen extensions install <github|npm> --consent` | `qwen mcp add -s user <n> <cmd> -- …` | `.qwen/skills/<n>/SKILL.md` |
 * | opencode | `opencode plugin <npm> -g` | `opencode mcp add <n> -- <cmd> …` / `--url` | `config/opencode/skills/<n>/SKILL.md` |
 *
 * Arguments that could be read as flags never are: names, sources and
 * commands that start with `-` are refused, and a server's own arguments
 * follow `--` (Gemini and Qwen take it after the command: before it their
 * parser finds no command). Lists come from JSON output or the harness's
 * files, never from an `mcp list` that starts every server. Sources: a
 * GitHub repository, an npm package or the harness's marketplace
 * (`name@market`); URLs with credentials, other hosts and `..` are
 * refused. A skill without a command comes from GitHub at a resolved
 * commit, kept only with a `SKILL.md`, its commit and digest recorded
 * beside it. Removing a plugin or server opencode has no command for edits
 * its plain-JSON config. Connector names (`qm-*`, `qianmo`) and the node's
 * own items (Codex marketplace `qianmo`, Gemini extension `qmo`, dsh skills
 * `qmo`) are refused and left out of lists.
 *
 * Changes run one at a time per agent, never while the agent's official
 * frontend holds its lock (`E_RUNTIME_EXT_LOCKED`), go through the control
 * ledger (the registration says so), and recycle the agent's idle
 * processes afterwards. Every reply is the list as it is after the change,
 * with what the pin layer does to it in `notes`.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
} from 'node:fs'
import { join } from 'node:path'
import { claudeStateFile } from '@qianmo/paths'
import type { ControlOutcome } from '@qianmo/protocol'
import { OutboundPolicy } from '../../commands/outboundPolicy.js'
import {
  readTextIfExists,
  writePrivateFileAtomic,
  writePrivateJson,
} from '../../providers/store.js'
import type { ControlHandler } from '../control.js'
import { fetchGithubDir, GITHUB_REPO, resolveCommit } from '../githubDir.js'
import { runtimeBin } from '../runtimeUpdate.js'
import { runtimeSpec } from './catalog.js'
import type { ExternalRuntimeKind } from './channel.js'
import { CONNECTOR_PREFIX, RUNTIME_MCP_SERVER } from './claudeCode.js'
import {
  type NativeExtensionKind,
  type NativeExtensionRow,
  type NativeExtensionsReply,
  RUNTIME_EXT_ERRORS,
  RUNTIME_EXT_OPS,
} from './contract.js'
import { DSH_QMO_SKILLS } from './dsh.js'
import {
  acquireChangeLock,
  frontendHolds,
  releaseChangeLock,
} from './frontendLock.js'
import { geminiNativeServers, geminiStripTrust } from './gemini.js'
import { qwenNativeServers } from './qwen.js'
import { runtimeDirs, runtimeEnv } from './runtimeEnv.js'

const LIST_TIMEOUT_MS = 30_000
const CHANGE_TIMEOUT_MS = 600_000
const MAX_OUTPUT = 2_000_000

/** One harness command's outcome. */
export interface HarnessResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}
export type HarnessRun = (
  argv: readonly string[],
  options: {
    readonly env: Record<string, string>
    readonly cwd: string
    readonly timeoutMs: number
  },
) => Promise<HarnessResult>

/** Runs a harness command without a shell, stdin closed, killed at the limit. */
export const runHarness: HarnessRun = async (argv, options) => {
  const spawn = () =>
    Bun.spawn([...argv], {
      env: options.env,
      cwd: options.cwd,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    })
  let child: ReturnType<typeof spawn>
  try {
    child = spawn()
  } catch (error) {
    return { code: -1, stdout: '', stderr: String(error) }
  }
  const timer = setTimeout(() => child.kill('SIGKILL'), options.timeoutMs)
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    return {
      code,
      stdout: stdout.slice(0, MAX_OUTPUT),
      stderr: stderr.slice(-4_000),
    }
  } finally {
    clearTimeout(timer)
  }
}

/** Where an install comes from. */
export type NativeSource =
  | {
      readonly kind: 'github'
      readonly repo: string
      readonly ref?: string
      readonly path: string
    }
  | { readonly kind: 'npm'; readonly spec: string; readonly name: string }
  | {
      readonly kind: 'market'
      readonly plugin: string
      readonly market: string
    }

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
const NPM_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/
const WORD = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/
const REF = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/
const REPO_PATH = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/

function githubSource(
  repo: string,
  path: string,
  ref: string | undefined,
): NativeSource | string {
  if (!GITHUB_REPO.test(repo)) return '仓库要写成 owner/name'
  if (path !== '' && !REPO_PATH.test(path)) return '仓库里的目录路径无效'
  if (ref !== undefined && (!REF.test(ref) || ref.includes('..')))
    return '分支、标签或提交号无效'
  if (`${repo}/${path}`.split('/').some(part => part === '..' || part === '.'))
    return '路径里不能有 . 或 ..'
  return {
    kind: 'github',
    repo,
    path,
    ...(ref === undefined ? {} : { ref }),
  }
}

/**
 * A source as the hub sends it: `owner/repo[/dir][#ref]`, an https
 * github.com URL, `[@scope/]name[@x.y.z]` (npm), or `name@market`. A string
 * is the refusal.
 */
export function parseNativeSource(raw: string): NativeSource | string {
  const value = raw.trim()
  if (value === '' || value.length > 300) return '来源为空或太长'
  if (value.startsWith('-')) return '来源不能以 - 开头'
  if (
    /[\s\\]/.test(value) ||
    [...value].some(char => char.charCodeAt(0) < 0x20)
  )
    return '来源里不能有空白或控制字符'
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) {
    let url: URL
    try {
      url = new URL(value)
    } catch {
      return '来源地址无效'
    }
    if (url.protocol !== 'https:') return '只收 https 的 GitHub 地址'
    if (url.username !== '' || url.password !== '')
      return '地址里不能带账号或口令'
    if (url.hostname !== 'github.com' || url.port !== '')
      return '只收 github.com 上的仓库'
    if (url.search !== '') return 'GitHub 地址不能带查询参数'
    const parts = decodeURIComponent(url.pathname)
      .replace(/^\/+|\/+$/g, '')
      .split('/')
    const owner = parts[0] ?? ''
    const name = (parts[1] ?? '').replace(/\.git$/, '')
    let ref = url.hash === '' ? undefined : url.hash.slice(1)
    let path = ''
    if (parts.length > 2) {
      if (parts[2] !== 'tree' || parts.length < 4)
        return 'GitHub 地址要指向仓库或 /tree/<分支>/<目录>'
      if (ref !== undefined) return '分支只能写一处'
      ref = parts[3]
      path = parts.slice(4).join('/')
    }
    return githubSource(`${owner}/${name}`, path, ref)
  }
  const hash = value.indexOf('#')
  const head = hash < 0 ? value : value.slice(0, hash)
  const ref = hash < 0 ? undefined : value.slice(hash + 1)
  if (head.startsWith('@')) {
    if (ref !== undefined) return 'npm 包名不带 #'
    const at = head.indexOf('@', 1)
    const name = at < 0 ? head : head.slice(0, at)
    const version = at < 0 ? undefined : head.slice(at + 1)
    if (!NPM_NAME.test(name)) return 'npm 包名无效'
    if (version !== undefined && !SEMVER.test(version))
      return 'npm 版本要写确切的版本号'
    return { kind: 'npm', spec: head, name }
  }
  if (head.includes('/')) {
    const parts = head.split('/')
    return githubSource(
      `${parts[0]}/${parts[1] ?? ''}`,
      parts.slice(2).join('/'),
      ref,
    )
  }
  if (ref !== undefined) return '只有 GitHub 来源可以带 #分支'
  const at = head.indexOf('@')
  if (at < 0)
    return NPM_NAME.test(head)
      ? { kind: 'npm', spec: head, name: head }
      : '来源无效'
  const name = head.slice(0, at)
  const word = head.slice(at + 1)
  if (SEMVER.test(word))
    return NPM_NAME.test(name)
      ? { kind: 'npm', spec: head, name }
      : 'npm 包名无效'
  if (!WORD.test(name) || !WORD.test(word)) return '市场来源要写成 名称@市场'
  return { kind: 'market', plugin: name, market: word }
}

const SERVER_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/
const COMMAND = /^(?:\/[^\0\n\r]*|[A-Za-z0-9_][A-Za-z0-9_.@+-]*)$/
const ITEM_NAME = /^[A-Za-z0-9@][A-Za-z0-9._@/-]{0,199}$/
const SKILL_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/

/** MCP names the node's own servers take (connectors, the bridge). */
export function reservedServerName(name: string): boolean {
  const lower = name.toLowerCase()
  return lower === RUNTIME_MCP_SERVER || lower.startsWith(CONNECTOR_PREFIX)
}

interface McpSpec {
  readonly name: string
  readonly command?: string
  readonly args: readonly string[]
  readonly url?: string
  readonly transport: 'stdio' | 'http' | 'sse'
}

function mcpSpec(args: Record<string, unknown>): McpSpec | string {
  const name = args.name
  if (typeof name !== 'string' || !SERVER_NAME.test(name))
    return 'MCP 服务名无效'
  if (reservedServerName(name))
    return `MCP 服务名 ${name} 留给阡陌的连接器（qm- 前缀与 qianmo）`
  const source = args.source
  if (typeof args.url === 'string') {
    let url: URL
    try {
      url = new URL(args.url)
    } catch {
      return 'MCP 地址无效'
    }
    if (url.protocol !== 'https:') return 'MCP 地址只收 https'
    if (url.username !== '' || url.password !== '')
      return 'MCP 地址里不能带账号或口令'
    if (source !== args.url) return '来源要与 MCP 地址一致'
    return {
      name,
      url: args.url,
      args: [],
      transport: args.transport === 'sse' ? 'sse' : 'http',
    }
  }
  const command = args.command
  if (typeof command !== 'string' || !COMMAND.test(command))
    return 'MCP 命令无效（不能以 - 开头）'
  if (source !== command) return '来源要与 MCP 命令一致'
  const list = args.args ?? []
  if (
    !Array.isArray(list) ||
    list.length > 64 ||
    !list.every(
      arg =>
        typeof arg === 'string' && arg.length <= 1_000 && !/[\0\n\r]/.test(arg),
    )
  )
    return 'MCP 命令参数无效'
  return { name, command, args: list as string[], transport: 'stdio' }
}

/** What one agent's operation runs with. */
interface Context {
  readonly agent: string
  readonly runtime: string
  readonly home: string
  readonly launchDir: string
  readonly workspace: string
  readonly bin: string
  readonly env: Record<string, string>
  readonly run: (
    argv: readonly string[],
    timeoutMs: number,
  ) => Promise<HarnessResult>
}

class OpError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

function failed(result: HarnessResult, what: string): OpError {
  const said = `${result.stderr}\n${result.stdout}`
    .trim()
    .split('\n')
    .filter(line => line.trim() !== '')
    .slice(-2)
    .join(' · ')
  return new OpError(
    RUNTIME_EXT_ERRORS.failed,
    `${what}失败（退出码 ${result.code}）${said === '' ? '' : `：${said}`}`.slice(
      0,
      600,
    ),
  )
}

async function step(
  ctx: Context,
  argv: readonly string[],
  what: string,
  timeoutMs = CHANGE_TIMEOUT_MS,
): Promise<HarnessResult> {
  const result = await ctx.run([ctx.bin, ...argv], timeoutMs)
  if (result.code !== 0) throw failed(result, what)
  return result
}

function json(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    // Some commands print a line before their JSON.
    const at = text.search(/^[[{]/m)
    if (at < 0) return undefined
    try {
      return JSON.parse(text.slice(at))
    } catch {
      return undefined
    }
  }
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function readJsonFile(path: string): Record<string, unknown> {
  const text = readTextIfExists(path)
  return text === undefined ? {} : record(json(text))
}

/** Names of a JSON file's `mcpServers` (or another key). */
function serverRows(path: string, key = 'mcpServers'): NativeExtensionRow[] {
  return Object.entries(record(readJsonFile(path)[key]))
    .filter(([name]) => !reservedServerName(name))
    .map(([name, value]) => ({
      kind: 'mcp' as const,
      name,
      enabled:
        record(value).disabled !== true && record(value).enabled !== false,
    }))
}

function skillRows(
  dir: string,
  skip: readonly string[] = [],
): NativeExtensionRow[] {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  return names
    .filter(
      name => !skip.includes(name) && existsSync(join(dir, name, 'SKILL.md')),
    )
    .sort()
    .map(name => {
      const pinned = readJsonFile(join(dir, name, PIN_FILE))
      return {
        kind: 'skill' as const,
        name,
        enabled: true,
        ...(typeof pinned.repo === 'string'
          ? { source: `${pinned.repo}@${String(pinned.commit).slice(0, 12)}` }
          : {}),
      }
    })
}

/** Where a skill the node fetched records its origin. */
const PIN_FILE = '.qmo-source.json'

/** opencode's global config: the plain-JSON file it reads and writes. */
function opencodeConfigPath(home: string): string {
  const dir = join(home, 'config', 'opencode')
  for (const name of ['opencode.json', 'opencode.jsonc'])
    if (existsSync(join(dir, name))) return join(dir, name)
  return join(dir, 'opencode.json')
}

/** One harness's native operations. */
interface Driver {
  readonly skillsDir: (home: string) => string
  /** Skill directory names that are the node's own. */
  readonly ownSkills?: readonly string[]
  readonly web: boolean
  list(ctx: Context): Promise<{
    items: NativeExtensionRow[]
    notes: string[]
  }>
  installPlugin(
    ctx: Context,
    source: NativeSource,
    name?: string,
  ): Promise<string[]>
  removePlugin(ctx: Context, name: string): Promise<void>
  addMcp(ctx: Context, spec: McpSpec): Promise<void>
  removeMcp(ctx: Context, name: string): Promise<void>
}

function unsupported(message: string): OpError {
  return new OpError(RUNTIME_EXT_ERRORS.unsupported, message)
}
function badSource(message: string): OpError {
  return new OpError(RUNTIME_EXT_ERRORS.badSource, message)
}

/** `name` for a command line: never a flag. */
function itemName(name: string): string {
  if (!ITEM_NAME.test(name)) throw badSource(`名称 ${name} 无效`)
  return name
}

/**
 * Claude Code and Codex install a plugin from a marketplace: a GitHub source
 * adds the marketplace first, then installs `name` from it.
 */
async function marketplacePlugin(
  ctx: Context,
  source: NativeSource,
  name: string | undefined,
  harness: {
    readonly label: string
    readonly addMarket: (source: NativeSource & { kind: 'github' }) => string[]
    readonly removeMarket: (market: string) => string[]
    readonly marketName: (
      added: HarnessResult,
      source: NativeSource & { kind: 'github' },
    ) => Promise<string | undefined>
    readonly install: (id: string) => string[]
  },
): Promise<string[]> {
  if (source.kind === 'npm')
    throw badSource(
      `${harness.label} 的插件来自市场或 GitHub 仓库，不收 npm 包`,
    )
  if (source.kind === 'market') {
    if (source.market === 'qianmo') throw badSource('qianmo 市场归阡陌所有')
    await step(
      ctx,
      harness.install(`${source.plugin}@${source.market}`),
      '安装插件',
    )
    return []
  }
  if (source.path !== '') throw badSource('市场来源不带目录')
  const added = await step(ctx, harness.addMarket(source), '添加市场')
  const market = await harness.marketName(added, source)
  if (market === 'qianmo') {
    // Already added under the node's own marketplace name: taken back.
    await step(ctx, harness.removeMarket(market), '移除市场').catch(() => {})
    throw badSource('qianmo 市场归阡陌所有')
  }
  if (name === undefined)
    return [
      market === undefined
        ? `已添加市场 ${source.repo}；再用 名称@市场 安装其中的插件`
        : `已添加市场 ${market}；再用 名称@${market} 安装其中的插件`,
    ]
  if (market === undefined) throw failed(added, '读取市场名称')
  await step(ctx, harness.install(`${itemName(name)}@${market}`), '安装插件')
  return []
}

const CLAUDE: Driver = {
  skillsDir: home => join(home, 'skills'),
  web: false,
  async list(ctx) {
    const listed = await step(
      ctx,
      ['plugin', 'list', '--json'],
      '列出插件',
      LIST_TIMEOUT_MS,
    )
    const plugins = json(listed.stdout)
    const items: NativeExtensionRow[] = (
      Array.isArray(plugins) ? plugins : []
    ).flatMap(raw => {
      const row = record(raw)
      return typeof row.id === 'string'
        ? [
            {
              kind: 'plugin' as const,
              name: row.id,
              enabled: row.enabled !== false,
              ...(typeof row.version === 'string'
                ? { version: row.version }
                : {}),
            },
          ]
        : []
    })
    // User-scope servers; `mcp list` would start them all.
    items.push(...serverRows(claudeStateFile(ctx.home)))
    items.push(...skillRows(this.skillsDir(ctx.home)))
    return { items, notes: [] }
  },
  installPlugin: (ctx, source, name) =>
    marketplacePlugin(ctx, source, name, {
      label: 'Claude Code',
      addMarket: source => {
        if (source.ref !== undefined)
          throw badSource('Claude Code 的市场来源不带分支')
        return ['plugin', 'marketplace', 'add', source.repo]
      },
      removeMarket: market => ['plugin', 'marketplace', 'remove', market],
      // Its `marketplace add` prints no JSON: the list names it by repo.
      marketName: async (_added, source) => {
        const listed = await step(
          ctx,
          ['plugin', 'marketplace', 'list', '--json'],
          '列出市场',
          LIST_TIMEOUT_MS,
        )
        const rows = json(listed.stdout)
        for (const raw of Array.isArray(rows) ? rows : []) {
          const row = record(raw)
          if (typeof row.name === 'string' && row.repo === source.repo)
            return row.name
        }
        return undefined
      },
      install: id => ['plugin', 'install', id, '-s', 'user', '--json'],
    }),
  async removePlugin(ctx, name) {
    await step(
      ctx,
      ['plugin', 'uninstall', itemName(name), '--json'],
      '卸载插件',
    )
  },
  async addMcp(ctx, spec) {
    await step(
      ctx,
      spec.url === undefined
        ? [
            'mcp',
            'add',
            '-s',
            'user',
            spec.name,
            '--',
            spec.command!,
            ...spec.args,
          ]
        : [
            'mcp',
            'add',
            '-s',
            'user',
            '--transport',
            spec.transport,
            spec.name,
            spec.url,
          ],
      '添加 MCP 服务',
    )
  },
  async removeMcp(ctx, name) {
    await step(ctx, ['mcp', 'remove', '-s', 'user', name], '删除 MCP 服务')
  },
}

const CODEX: Driver = {
  skillsDir: home => join(home, 'skills'),
  web: false,
  async list(ctx) {
    const plugins = await step(
      ctx,
      ['plugin', 'list', '--json'],
      '列出插件',
      LIST_TIMEOUT_MS,
    )
    const installed = record(json(plugins.stdout)).installed
    const items: NativeExtensionRow[] = (
      Array.isArray(installed) ? installed : []
    ).flatMap(raw => {
      const row = record(raw)
      // The node's own marketplace carries the console's skills (P32).
      if (row.marketplaceName === 'qianmo' || typeof row.pluginId !== 'string')
        return []
      return [
        {
          kind: 'plugin' as const,
          name: row.pluginId,
          enabled: row.enabled !== false,
          ...(typeof row.version === 'string' ? { version: row.version } : {}),
        },
      ]
    })
    const servers = await step(
      ctx,
      ['mcp', 'list', '--json'],
      '列出 MCP 服务',
      LIST_TIMEOUT_MS,
    )
    const rows = json(servers.stdout)
    for (const raw of Array.isArray(rows) ? rows : []) {
      const row = record(raw)
      if (typeof row.name !== 'string' || reservedServerName(row.name)) continue
      items.push({
        kind: 'mcp',
        name: row.name,
        enabled: row.enabled !== false,
      })
    }
    items.push(...skillRows(this.skillsDir(ctx.home)))
    return { items, notes: [] }
  },
  installPlugin: (ctx, source, name) =>
    marketplacePlugin(ctx, source, name, {
      label: 'Codex',
      addMarket: source => [
        'plugin',
        'marketplace',
        'add',
        source.repo,
        ...(source.ref === undefined ? [] : ['--ref', source.ref]),
        '--json',
      ],
      removeMarket: market => ['plugin', 'marketplace', 'remove', market],
      marketName: async added => {
        const name = record(json(added.stdout)).marketplaceName
        return typeof name === 'string' ? name : undefined
      },
      install: id => ['plugin', 'add', id, '--json'],
    }),
  async removePlugin(ctx, name) {
    if (name.endsWith('@qianmo'))
      throw badSource('qianmo 市场的插件由控制台管理')
    await step(ctx, ['plugin', 'remove', itemName(name), '--json'], '卸载插件')
  },
  async addMcp(ctx, spec) {
    if (spec.transport === 'sse') throw unsupported('Codex 不支持 SSE 传输')
    await step(
      ctx,
      spec.url === undefined
        ? ['mcp', 'add', spec.name, '--', spec.command!, ...spec.args]
        : ['mcp', 'add', spec.name, '--url', spec.url],
      '添加 MCP 服务',
    )
  },
  async removeMcp(ctx, name) {
    await step(ctx, ['mcp', 'remove', name], '删除 MCP 服务')
  },
}

const DSH_MCP =
  'dsh 没有添加 MCP 服务的命令：在 qm runtime open 打开的网页界面里配置'

const DSH: Driver = {
  skillsDir: home => join(home, 'skills'),
  ownSkills: [DSH_QMO_SKILLS],
  web: true,
  async list(ctx) {
    const listed = await step(
      ctx,
      ['plugin', '--profile', 'acp', 'list', '--json'],
      '列出插件',
      LIST_TIMEOUT_MS,
    )
    const projects = json(listed.stdout)
    const items: NativeExtensionRow[] = []
    for (const project of Array.isArray(projects) ? projects : [projects])
      for (const [name, raw] of Object.entries(
        record(record(project).dependencies),
      )) {
        const row = record(raw)
        items.push({
          kind: 'plugin',
          name,
          enabled: true,
          ...(typeof row.version === 'string' ? { version: row.version } : {}),
        })
      }
    items.push(...skillRows(this.skillsDir(ctx.home), this.ownSkills))
    return { items, notes: [DSH_MCP] }
  },
  async installPlugin(ctx, source) {
    if (source.kind === 'market')
      throw badSource('dsh 的插件来自 npm 或 GitHub')
    if (source.kind === 'github' && source.path !== '')
      throw badSource('dsh 的 GitHub 来源不带目录')
    const spec =
      source.kind === 'npm'
        ? source.spec
        : `github:${source.repo}${source.ref === undefined ? '' : `#${source.ref}`}`
    await step(ctx, ['plugin', '--profile', 'acp', 'add', spec], '安装插件')
    return []
  },
  async removePlugin(ctx, name) {
    await step(
      ctx,
      ['plugin', '--profile', 'acp', 'remove', itemName(name)],
      '卸载插件',
    )
  },
  async addMcp() {
    throw unsupported(DSH_MCP)
  },
  async removeMcp() {
    throw unsupported(DSH_MCP)
  },
}

/** Gemini and Qwen share their command shapes (Qwen is Gemini's fork). */
function yargsMcpAdd(spec: McpSpec): string[] {
  return spec.url === undefined
    ? // The separator after the command: before it their parser sees none.
      ['mcp', 'add', '-s', 'user', spec.name, spec.command!, '--', ...spec.args]
    : [
        'mcp',
        'add',
        '-s',
        'user',
        '--transport',
        spec.transport,
        spec.name,
        spec.url,
      ]
}

const GEMINI: Driver = {
  skillsDir: home => join(home, '.gemini', 'skills'),
  web: false,
  async list(ctx) {
    const listed = await step(
      ctx,
      ['extensions', 'list', '-o', 'json'],
      '列出扩展',
      LIST_TIMEOUT_MS,
    )
    const rows = json(listed.stdout)
    const items: NativeExtensionRow[] = (
      Array.isArray(rows) ? rows : []
    ).flatMap(raw => {
      const row = record(raw)
      if (typeof row.name !== 'string' || row.name === 'qmo') return []
      return [
        {
          kind: 'plugin' as const,
          name: row.name,
          enabled: row.isActive !== false,
          ...(typeof row.version === 'string' ? { version: row.version } : {}),
          ...(typeof record(row.installMetadata).source === 'string'
            ? { source: String(record(row.installMetadata).source) }
            : {}),
        },
      ]
    })
    for (const name of geminiNativeServers(ctx.home))
      if (!reservedServerName(name))
        items.push({ kind: 'mcp', name, enabled: true })
    items.push(...skillRows(this.skillsDir(ctx.home)))
    return { items, notes: [] }
  },
  async installPlugin(ctx, source) {
    if (source.kind !== 'github' || source.path !== '')
      throw badSource('Gemini CLI 的扩展来自 GitHub 仓库')
    await step(
      ctx,
      [
        'extensions',
        'install',
        `https://github.com/${source.repo}`,
        ...(source.ref === undefined ? [] : ['--ref', source.ref]),
        '--consent',
      ],
      '安装扩展',
    )
    return []
  },
  async removePlugin(ctx, name) {
    if (name === 'qmo') throw badSource('qmo 扩展归阡陌所有')
    await step(ctx, ['extensions', 'uninstall', itemName(name)], '卸载扩展')
  },
  async addMcp(ctx, spec) {
    await step(ctx, yargsMcpAdd(spec), '添加 MCP 服务')
  },
  async removeMcp(ctx, name) {
    await step(ctx, ['mcp', 'remove', '-s', 'user', name], '删除 MCP 服务')
  },
}

const QWEN: Driver = {
  skillsDir: home => join(home, '.qwen', 'skills'),
  web: true,
  async list(ctx) {
    const items: NativeExtensionRow[] = []
    const root = join(ctx.home, '.qwen', 'extensions')
    let names: string[] = []
    try {
      names = readdirSync(root)
    } catch {
      // None.
    }
    for (const dir of names.sort()) {
      const manifest = readJsonFile(join(root, dir, 'qwen-extension.json'))
      if (typeof manifest.name !== 'string') continue
      items.push({
        kind: 'plugin',
        name: manifest.name,
        enabled: true,
        ...(typeof manifest.version === 'string'
          ? { version: manifest.version }
          : {}),
      })
    }
    for (const name of qwenNativeServers(ctx.home))
      if (!reservedServerName(name))
        items.push({ kind: 'mcp', name, enabled: true })
    items.push(...skillRows(this.skillsDir(ctx.home)))
    return {
      items,
      notes: ['工作区的 QWEN.md / AGENTS.md 仍会加载（Qwen Code 没有开关）'],
    }
  },
  async installPlugin(ctx, source) {
    if (source.kind === 'market')
      throw badSource('Qwen Code 的扩展来自 GitHub 或 npm')
    if (
      source.kind === 'github' &&
      (source.path !== '' || source.ref !== undefined)
    )
      throw badSource('Qwen Code 的 GitHub 来源只收仓库本身')
    if (source.kind === 'npm' && !source.name.startsWith('@'))
      throw badSource('Qwen Code 只收带作用域的 npm 包（@scope/name）')
    await step(
      ctx,
      [
        'extensions',
        'install',
        source.kind === 'npm'
          ? source.spec
          : `https://github.com/${source.repo}`,
        '--consent',
      ],
      '安装扩展',
    )
    return []
  },
  async removePlugin(ctx, name) {
    await step(ctx, ['extensions', 'uninstall', itemName(name)], '卸载扩展')
  },
  async addMcp(ctx, spec) {
    await step(ctx, yargsMcpAdd(spec), '添加 MCP 服务')
  },
  async removeMcp(ctx, name) {
    await step(ctx, ['mcp', 'remove', '-s', 'user', name], '删除 MCP 服务')
  },
}

const OPENCODE_PLUGINS =
  '常驻运行时不加载 opencode 插件（--pure），只在官方前端里可用'

/** opencode's global config for an edit it has no command for. */
function opencodeEdit(
  home: string,
  edit: (config: Record<string, unknown>) => boolean,
): void {
  const path = opencodeConfigPath(home)
  const text = readTextIfExists(path)
  let config: Record<string, unknown>
  try {
    config = record(JSON.parse(text ?? '{}'))
  } catch {
    throw unsupported(
      'opencode 的配置里有注释，节点不改它：在 qm runtime open 打开的前端里删除',
    )
  }
  if (!edit(config)) throw new OpError(RUNTIME_EXT_ERRORS.failed, '没有这一项')
  writePrivateFileAtomic(path, `${JSON.stringify(config, null, 2)}\n`)
}

const OPENCODE: Driver = {
  skillsDir: home => join(home, 'config', 'opencode', 'skills'),
  web: true,
  async list(ctx) {
    let config: Record<string, unknown> = {}
    try {
      config = record(
        JSON.parse(readTextIfExists(opencodeConfigPath(ctx.home)) ?? '{}'),
      )
    } catch {
      return {
        items: skillRows(this.skillsDir(ctx.home)),
        notes: [
          'opencode 的配置里有注释，节点读不了插件与 MCP 清单',
          OPENCODE_PLUGINS,
        ],
      }
    }
    const items: NativeExtensionRow[] = []
    for (const plugin of Array.isArray(config.plugin) ? config.plugin : [])
      if (typeof plugin === 'string')
        items.push({
          kind: 'plugin',
          name: plugin,
          enabled: true,
          notLoaded: OPENCODE_PLUGINS,
        })
    for (const [name, raw] of Object.entries(record(config.mcp)))
      if (!reservedServerName(name))
        items.push({
          kind: 'mcp',
          name,
          enabled: record(raw).enabled !== false,
        })
    items.push(...skillRows(this.skillsDir(ctx.home)))
    return { items, notes: [OPENCODE_PLUGINS] }
  },
  async installPlugin(ctx, source) {
    if (source.kind !== 'npm') throw badSource('opencode 的插件来自 npm')
    await step(ctx, ['plugin', source.spec, '-g'], '安装插件')
    return []
  },
  async removePlugin(ctx, name) {
    opencodeEdit(ctx.home, config => {
      const plugins = Array.isArray(config.plugin) ? config.plugin : []
      const kept = plugins.filter(
        one =>
          one !== name &&
          !(typeof one === 'string' && one.startsWith(`${name}@`)),
      )
      config.plugin = kept
      return kept.length !== plugins.length
    })
  },
  async addMcp(ctx, spec) {
    if (spec.transport === 'sse')
      throw unsupported('opencode 的远程 MCP 只收 HTTP')
    await step(
      ctx,
      spec.url === undefined
        ? ['mcp', 'add', spec.name, '--', spec.command!, ...spec.args]
        : ['mcp', 'add', spec.name, '--url', spec.url],
      '添加 MCP 服务',
    )
  },
  async removeMcp(ctx, name) {
    opencodeEdit(ctx.home, config => {
      const mcp = record(config.mcp)
      if (!(name in mcp)) return false
      delete mcp[name]
      config.mcp = mcp
      return true
    })
  },
}

const DRIVERS: Readonly<Record<string, Driver>> = {
  'claude-code': CLAUDE,
  codex: CODEX,
  dsh: DSH,
  gemini: GEMINI,
  qwen: QWEN,
  opencode: OPENCODE,
}

/** The node command that opens `agent`'s official frontend. */
export function openCommand(agent: string, runtime: string): string {
  const base = `qm runtime open ${agent}`
  if (runtime === 'qwen' || runtime === 'opencode')
    return `${base}（加 --web 打开网页界面）`
  return base
}

export interface NativeExtensionsOptions {
  /** The node's agents and their workspaces. */
  readonly agents: readonly { readonly agent: string; readonly cwd: string }[]
  /** The external runtime `agent`'s sessions use (the pool's answer). */
  readonly runtimeOf: (agent: string) => string
  readonly bins?: Partial<Record<ExternalRuntimeKind, string>>
  /** Recycles `agent`'s idle processes after a change. */
  readonly invalidate?: (agent: string) => Promise<void>
  /** GitHub downloads for skills; tests point it elsewhere. */
  readonly policy?: OutboundPolicy
  readonly run?: HarnessRun
  /** The environment the agent's runtime sees; default the node's. */
  readonly source?: Readonly<Record<string, string | undefined>>
}

/** `runtime.ext.*` on the control link. */
export class NativeExtensions {
  readonly #options: NativeExtensionsOptions
  readonly #queues = new Map<string, Promise<unknown>>()

  constructor(options: NativeExtensionsOptions) {
    this.#options = options
  }

  #context(agent: string): Context & { driver: Driver } {
    const one = this.#options.agents.find(entry => entry.agent === agent)
    if (one === undefined)
      throw new OpError('invalid', `这台节点上没有智能体 ${agent}`)
    const runtime = this.#options.runtimeOf(agent)
    const driver = DRIVERS[runtime]
    if (driver === undefined || runtimeSpec(runtime)?.protocol === 'omp')
      throw unsupported(`${agent} 不在外部底层上，没有原生扩展`)
    const { home, launchDir } = runtimeDirs(runtime, agent)
    mkdirSync(launchDir, { recursive: true, mode: 0o700 })
    const env = runtimeEnv(runtime, agent, undefined, this.#options.source)
    const run = this.#options.run ?? runHarness
    return {
      agent,
      runtime,
      home,
      launchDir,
      workspace: one.cwd,
      bin: runtimeBin(runtime, this.#options.bins),
      env,
      run: (argv, timeoutMs) => run(argv, { env, cwd: launchDir, timeoutMs }),
      driver,
    }
  }

  /** One operation of `agent` at a time. */
  #serial<T>(agent: string, work: () => Promise<T>): Promise<T> {
    const previous = this.#queues.get(agent) ?? Promise.resolve()
    const run = previous.then(work, work)
    this.#queues.set(
      agent,
      run.catch(() => {}),
    )
    return run
  }

  async #reply(
    ctx: Context & { driver: Driver },
    extra: readonly string[] = [],
  ): Promise<NativeExtensionsReply> {
    const listed = await ctx.driver.list(ctx)
    const notes = [...extra, ...listed.notes]
    if (ctx.runtime === 'gemini') {
      const revoked = geminiStripTrust(ctx.home)
      if (revoked.length > 0) notes.push(`已撤销预授权：${revoked.join('、')}`)
      notes.push('工作区的 GEMINI.md 与项目技能仍会加载（Gemini CLI 没有开关）')
    }
    if (frontendHolds(ctx.agent))
      notes.push('官方前端正开着：安装与卸载要等它退出')
    return {
      agent: ctx.agent,
      runtime: ctx.runtime,
      items: listed.items,
      notes,
      openCommand: openCommand(ctx.agent, ctx.runtime),
    }
  }

  async list(agent: string): Promise<NativeExtensionsReply> {
    return this.#serial(agent, async () => this.#reply(this.#context(agent)))
  }

  async install(args: Record<string, unknown>): Promise<NativeExtensionsReply> {
    const agent = String(args.agent ?? '')
    return this.#change(agent, async ctx => {
      const kind = args.kind as NativeExtensionKind
      if (kind === 'mcp') {
        const spec = mcpSpec(args)
        if (typeof spec === 'string') throw badSource(spec)
        await ctx.driver.addMcp(ctx, spec)
        return []
      }
      if (typeof args.source !== 'string') throw badSource('缺少来源')
      const source = parseNativeSource(args.source)
      if (typeof source === 'string') throw badSource(source)
      const name =
        typeof args.name === 'string' && args.name !== ''
          ? args.name
          : undefined
      if (kind === 'plugin') return ctx.driver.installPlugin(ctx, source, name)
      if (kind === 'skill') return this.#installSkill(ctx, source, name)
      throw badSource('kind 要是 plugin、mcp 或 skill')
    })
  }

  async remove(args: Record<string, unknown>): Promise<NativeExtensionsReply> {
    const agent = String(args.agent ?? '')
    return this.#change(agent, async ctx => {
      const name = typeof args.name === 'string' ? args.name : ''
      if (name === '' || name.startsWith('-')) throw badSource('名称无效')
      switch (args.kind) {
        case 'plugin':
          await ctx.driver.removePlugin(ctx, name)
          return []
        case 'mcp':
          if (!SERVER_NAME.test(name)) throw badSource('MCP 服务名无效')
          if (reservedServerName(name))
            throw badSource(
              'qm- 前缀与 qianmo 是阡陌连接器，在控制台的连接器里管理',
            )
          await ctx.driver.removeMcp(ctx, name)
          return []
        case 'skill': {
          if (
            !SKILL_NAME.test(name) ||
            (ctx.driver.ownSkills ?? []).includes(name)
          )
            throw badSource('技能名无效')
          const dir = join(ctx.driver.skillsDir(ctx.home), name)
          if (!existsSync(join(dir, 'SKILL.md')))
            throw new OpError(RUNTIME_EXT_ERRORS.failed, `没有技能 ${name}`)
          rmSync(dir, { recursive: true, force: true })
          return []
        }
        default:
          throw badSource('kind 要是 plugin、mcp 或 skill')
      }
    })
  }

  async #change(
    agent: string,
    work: (ctx: Context & { driver: Driver }) => Promise<string[]>,
  ): Promise<NativeExtensionsReply> {
    return this.#serial(agent, async () => {
      const ctx = this.#context(agent)
      // Held for the whole change: a frontend opened meanwhile finds it.
      const held = acquireChangeLock(agent, ctx.runtime)
      if (held === undefined || frontendHolds(agent)) {
        if (held !== undefined) releaseChangeLock(agent, held)
        throw new OpError(
          RUNTIME_EXT_ERRORS.locked,
          held === undefined
            ? `${agent} 的原生扩展正由另一处在改`
            : `${agent} 的官方前端正开着（qm runtime open）；关掉之后再装或卸`,
        )
      }
      let notes: string[]
      try {
        notes = await work(ctx)
      } finally {
        releaseChangeLock(agent, held)
        await this.#options.invalidate?.(agent).catch(() => {})
      }
      return this.#reply(ctx, notes)
    })
  }

  /**
   * A skill from GitHub at the commit its reference names now, kept only
   * with a `SKILL.md`, into the harness's skills directory; its commit and
   * digest are recorded beside it.
   */
  async #installSkill(
    ctx: Context & { driver: Driver },
    source: NativeSource,
    named: string | undefined,
  ): Promise<string[]> {
    if (source.kind !== 'github') throw badSource('技能来自 GitHub 仓库')
    const name =
      named ??
      (source.path === ''
        ? source.repo.split('/')[1]!
        : source.path.split('/').pop()!)
    if (!SKILL_NAME.test(name) || (ctx.driver.ownSkills ?? []).includes(name))
      throw badSource(`技能名 ${name} 无效`)
    const root = ctx.driver.skillsDir(ctx.home)
    const target = join(root, name)
    if (existsSync(target))
      throw new OpError(RUNTIME_EXT_ERRORS.failed, `已经有技能 ${name}；先卸载`)
    const policy = this.#options.policy ?? new OutboundPolicy()
    const work = join(ctx.home, '.qmo-work')
    const dest = join(work, `skill-${name}-${Date.now()}`)
    try {
      const commit = await resolveCommit(
        policy,
        source.repo,
        source.ref ?? 'HEAD',
      )
      const fetched = await fetchGithubDir({
        policy,
        repo: source.repo,
        commit,
        path: source.path,
        work,
        dest,
      })
      if (!existsSync(join(dest, 'SKILL.md')))
        throw new OpError(RUNTIME_EXT_ERRORS.failed, '这个目录里没有 SKILL.md')
      writePrivateJson(join(dest, PIN_FILE), {
        repo: source.repo,
        path: source.path,
        commit,
        digest: fetched.digest,
      })
      mkdirSync(root, { recursive: true, mode: 0o700 })
      renameSync(dest, target)
      return [`技能 ${name} 取自 ${source.repo}@${commit.slice(0, 12)}`]
    } catch (error) {
      if (error instanceof OpError) throw error
      throw new OpError(
        RUNTIME_EXT_ERRORS.failed,
        `取技能失败：${error instanceof Error ? error.message : String(error)}`,
      )
    } finally {
      rmSync(dest, { recursive: true, force: true })
    }
  }

  /** `runtime.ext.list|install|remove` (the `runtime` registration routes here). */
  readonly control: ControlHandler = async (
    op,
    args,
  ): Promise<ControlOutcome> => {
    try {
      if (typeof args.agent !== 'string' || args.agent === '')
        return { ok: false, code: 'invalid', message: '缺少智能体' }
      if (op === RUNTIME_EXT_OPS.list)
        return { ok: true, value: await this.list(args.agent) }
      if (op === RUNTIME_EXT_OPS.install)
        return { ok: true, value: await this.install(args) }
      if (op === RUNTIME_EXT_OPS.remove)
        return { ok: true, value: await this.remove(args) }
      return { ok: false, code: 'unsupported', message: '不支持此原生扩展操作' }
    } catch (error) {
      if (error instanceof OpError)
        return { ok: false, code: error.code, message: error.message }
      return {
        ok: false,
        code: RUNTIME_EXT_ERRORS.failed,
        message: error instanceof Error ? error.message : String(error),
      }
    }
  }
}

/** Whether `op` is one of the native extension operations. */
export function isNativeExtensionOp(op: string): boolean {
  return (Object.values(RUNTIME_EXT_OPS) as string[]).includes(op)
}
