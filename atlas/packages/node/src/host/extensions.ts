// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Operator-configured MCP servers, skills and plugins on a node (P32,
 * `runtimes-channels.md` §9).
 *
 * The hub sends the node its whole set on the control link
 * (`extensions.apply`); the node lays it out under
 * `qianmoConfigPath('extensions')` in the shapes each runtime loads natively,
 * and recycles the idle children of every agent whose set changed:
 *
 * | layout (`agents/<agent>/`) | used by |
 * |---|---|
 * | `plugins/qianmo/` — the agent's skills, with Agent Plugins, Claude Code and Codex manifests | `--plugin-dir` (qianmopi, Claude Code); local marketplace (Codex) |
 * | `plugins/<name>/` — an imported plugin, as published | the same, per the manifests it carries |
 * | `.agents/plugins/marketplace.json` | Codex: `codex plugin marketplace add` |
 * | `mcp/qianmo-mcp/` — `plugin.json` + `mcp.json` with the agent's MCP servers and their secrets | `--plugin-dir` (qianmopi only) |
 *
 * Claude Code gets the MCP servers in its `--mcp-config` file and Codex in
 * the agent's own `CODEX_HOME/config.toml`, so their secrets never sit in a
 * directory a runtime copies or an agent may read. A GitHub source is only
 * used when its files match the digest the hub pinned.
 */

import { createHash, randomUUID } from 'node:crypto'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import * as path from 'node:path'
import { z } from 'zod'
import { qianmoConfigPath } from '@qianmo/paths'
import type { ControlOutcome } from '@qianmo/protocol'
import { OutboundPolicy } from '../commands/outboundPolicy.js'
import { readTextIfExists, writePrivateJson } from '../providers/store.js'
import type { ControlHandler } from './control.js'
import { fetchGithubDir, GITHUB_REPO } from './githubDir.js'
import type { ExternalRuntimeKind } from './runtimes/channel.js'
import { toml } from './runtimes/codex.js'
import { runCommand, type RunCommand } from './runtimeUpdate.js'

/** Entry names: what skills, MCP servers and plugins are called everywhere. */
export const EXTENSION_NAME = /^[a-z](?:[a-z0-9]|-(?=[a-z0-9])){0,39}$/
export const EXTENSION_ID = /^ext-[0-9a-f-]{36}$/
/** The plugin that carries an agent's skills. */
export const SKILLS_PLUGIN = 'qianmo'
/** The qianmopi-only plugin that carries an agent's MCP servers. */
export const MCP_PLUGIN = 'qianmo-mcp'
/** Reserved: the runtimes' own `qianmo` MCP server. */
export const RESERVED_NAMES: ReadonlySet<string> = new Set([
  'qianmo',
  'qianmo-mcp',
])

const AGENT_PLUGINS_MANIFEST =
  'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json'
const AGENT_PLUGINS_MCP =
  'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json'

const githubSchema = z.object({
  repo: z.string().regex(GITHUB_REPO),
  commit: z.string().regex(/^[0-9a-f]{40}$/),
  path: z.string().max(300),
  digest: z.string().regex(/^[0-9a-f]{64}$/),
})

export const extensionWireSchema = z.object({
  id: z.string().regex(EXTENSION_ID),
  kind: z.enum(['mcp', 'skill', 'plugin']),
  name: z.string().regex(EXTENSION_NAME),
  /** Agent names on this node; `null` is every agent. */
  agents: z.array(z.string()).nullable(),
  transport: z.enum(['stdio', 'http', 'sse']).optional(),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  url: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  approval: z.enum(['allow', 'ask']).optional(),
  description: z.string().optional(),
  body: z.string().optional(),
  github: githubSchema.optional(),
})
export type ExtensionWireEntry = z.infer<typeof extensionWireSchema>

const applySchema = z.object({
  digest: z.string().regex(/^[0-9a-f]{64}$/),
  entries: z.array(extensionWireSchema).max(200),
})

export interface ExtensionResult {
  readonly id: string
  readonly ok: boolean
  readonly detail: string | null
}

export interface ExtensionsStatus {
  readonly digest: string | null
  readonly results: readonly ExtensionResult[]
  readonly at: number | null
}

/** The digest both ends compute over one node's entries. */
export function extensionsDigest(
  entries: readonly ExtensionWireEntry[],
): string {
  const sorted = [...entries].sort((a, b) => a.id.localeCompare(b.id))
  return createHash('sha256').update(JSON.stringify(sorted)).digest('hex')
}

/** One MCP server as a runtime starts it. */
export interface AgentMcpServer {
  readonly name: string
  readonly transport: 'stdio' | 'http' | 'sse'
  readonly command?: string
  readonly args?: readonly string[]
  readonly env?: Readonly<Record<string, string>>
  readonly url?: string
  readonly headers?: Readonly<Record<string, string>>
  readonly approval: 'allow' | 'ask'
  /** qianmopi's names for its tools; empty when the probe failed. */
  readonly tools: readonly string[]
}

/** What one agent's runtime loads (P32). */
export interface AgentExtensions {
  /** `--plugin-dir`, qianmopi. */
  readonly ompPluginDirs: readonly string[]
  /** `--plugin-dir`, Claude Code. */
  readonly claudePluginDirs: readonly string[]
  readonly mcp: readonly AgentMcpServer[]
  /** Skill material the agent may read although it is under the config root. */
  readonly readableRoots: readonly string[]
}

/** How a runtime asks for an agent's set; `null`: nothing configured. */
export type AgentExtensionsSource = (agent: string) => AgentExtensions | null

export interface McpProbeTarget {
  readonly name: string
  readonly transport: 'stdio' | 'http' | 'sse'
  readonly command?: string
  readonly args?: readonly string[]
  readonly env?: Readonly<Record<string, string>>
  readonly url?: string
  readonly headers?: Readonly<Record<string, string>>
  readonly cwd: string
}

/**
 * qianmopi's names for a server's tools, through qianmopi's own MCP client
 * and naming: qianmopi only runs MCP tools named in `--tools`.
 */
export async function probeMcpTools(target: McpProbeTarget): Promise<string[]> {
  const client = await import('@oh-my-pi/pi-coding-agent/mcp/client')
  const bridge = await import('@oh-my-pi/pi-coding-agent/mcp/tool-bridge')
  const server = `${MCP_PLUGIN}:${target.name}`
  const connection = await client.connectToServer(
    server,
    target.transport === 'stdio'
      ? {
          type: 'stdio',
          command: target.command ?? '',
          args: [...(target.args ?? [])],
          env: { ...target.env },
          envPolicy: 'literal',
          cwd: target.cwd,
          timeout: 30_000,
        }
      : {
          type: target.transport,
          url: target.url ?? '',
          headers: { ...target.headers },
          headerPolicy: 'origin-locked',
          timeout: 30_000,
        },
  )
  try {
    const tools = await client.listTools(connection)
    return tools.map(tool => bridge.createMCPToolName(server, tool.name))
  } finally {
    await client.disconnectServer(connection).catch(() => {})
  }
}

const appliedSchema = z.object({
  v: z.literal(1),
  digest: z.string(),
  entries: z.array(extensionWireSchema),
  results: z.array(
    z.object({
      id: z.string(),
      ok: z.boolean(),
      detail: z.string().nullable(),
    }),
  ),
  tools: z.record(z.string(), z.array(z.string())),
  plugins: z.record(
    z.string(),
    z.object({
      claude: z.boolean(),
      codex: z.string().nullable(),
      standard: z.boolean(),
    }),
  ),
  agentDigests: z.record(z.string(), z.string()),
  at: z.number(),
})
type Applied = z.infer<typeof appliedSchema>
type PluginFormats = Applied['plugins'][string]

export interface NodeExtensionsAgent {
  readonly agent: string
  /** Absent: qianmopi. */
  readonly runtime?: ExternalRuntimeKind
}

export interface NodeExtensionsOptions {
  readonly agents: readonly NodeExtensionsAgent[]
  readonly root?: string
  readonly codexHome?: (agent: string) => string
  /** The Codex executable; Codex agents get plugins through it. */
  readonly codexBin?: string
  readonly policy?: OutboundPolicy
  readonly run?: RunCommand
  readonly probe?: (target: McpProbeTarget) => Promise<string[]>
  /** An agent's set changed: recycle its idle children. */
  readonly changed?: (agent: string) => Promise<void>
  readonly now?: () => number
  readonly onError?: (message: string) => void
}

function failure(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function forAgent(entry: ExtensionWireEntry, agent: string): boolean {
  return entry.agents === null || entry.agents.includes(agent)
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(readFileSync(file, 'utf8'))
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

/** Which runtimes can load a plugin directory, from the manifests it carries. */
export function pluginFormats(dir: string): PluginFormats {
  const codex = readJson(path.join(dir, '.codex-plugin', 'plugin.json'))
  const root = readJson(path.join(dir, 'plugin.json'))
  return {
    claude: existsSync(path.join(dir, '.claude-plugin', 'plugin.json')),
    codex:
      typeof codex?.name === 'string' &&
      /^[a-z0-9][a-z0-9._-]{0,63}$/.test(codex.name)
        ? codex.name
        : null,
    standard:
      typeof root?.$schema === 'string' &&
      root.$schema.startsWith('https://agent-plugins.org/schemas/'),
  }
}

/** `SKILL.md` for an inline skill, in the Agent Skills format. */
export function skillMarkdown(
  name: string,
  description: string,
  body: string,
): string {
  return `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\n${body.trim()}\n`
}

function writeManifests(dir: string, name: string, description: string): void {
  const manifest = { name, version: '1.0.0', description }
  mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true })
  mkdirSync(path.join(dir, '.codex-plugin'), { recursive: true })
  writeFileSync(
    path.join(dir, 'plugin.json'),
    JSON.stringify({ $schema: AGENT_PLUGINS_MANIFEST, ...manifest }, null, 2),
  )
  writeFileSync(
    path.join(dir, '.claude-plugin', 'plugin.json'),
    JSON.stringify(manifest, null, 2),
  )
  writeFileSync(
    path.join(dir, '.codex-plugin', 'plugin.json'),
    JSON.stringify({ ...manifest, skills: './skills/' }, null, 2),
  )
}

/** An MCP server in the Agent Plugins `mcp.json` shape. */
function agentPluginsServer(
  entry: ExtensionWireEntry,
): Record<string, unknown> {
  if (entry.transport === 'stdio')
    return {
      type: 'stdio',
      command: entry.command ?? '',
      ...(entry.args?.length ? { args: entry.args } : {}),
      ...(entry.env && Object.keys(entry.env).length ? { env: entry.env } : {}),
    }
  return {
    type: entry.transport === 'sse' ? 'sse' : 'streamable-http',
    url: entry.url ?? '',
    ...(entry.headers && Object.keys(entry.headers).length
      ? { headers: entry.headers }
      : {}),
  }
}

/** The `CODEX_HOME/config.toml` part qianmo owns: the agent's MCP servers. */
export function codexMcpToml(servers: readonly ExtensionWireEntry[]): {
  toml: string
  skipped: readonly string[]
} {
  const lines = [
    '# Written by the qianmo node (P32) on every extension change. Do not edit.',
  ]
  const skipped: string[] = []
  for (const entry of servers) {
    // Codex speaks stdio and streamable HTTP only.
    if (entry.transport === 'sse') {
      skipped.push(entry.id)
      continue
    }
    lines.push('', `[mcp_servers.${JSON.stringify(entry.name)}]`)
    const fields: Record<string, unknown> =
      entry.transport === 'stdio'
        ? {
            command: entry.command ?? '',
            args: entry.args ?? [],
            ...(entry.env && Object.keys(entry.env).length
              ? { env: entry.env }
              : {}),
          }
        : {
            url: entry.url ?? '',
            ...(entry.headers && Object.keys(entry.headers).length
              ? { http_headers: entry.headers }
              : {}),
          }
    fields.default_tools_approval_mode =
      entry.approval === 'ask' ? 'prompt' : 'approve'
    for (const [key, value] of Object.entries(fields))
      lines.push(`${key} = ${toml(value)}`)
  }
  return { toml: `${lines.join('\n')}\n`, skipped }
}

export class NodeExtensions {
  readonly #options: NodeExtensionsOptions
  readonly #root: string
  #applied: Applied | null
  #queue: Promise<unknown> = Promise.resolve()

  constructor(options: NodeExtensionsOptions) {
    this.#options = options
    this.#root = options.root ?? qianmoConfigPath('extensions')
    const text = readTextIfExists(path.join(this.#root, 'applied.json'))
    let applied: Applied | null = null
    try {
      applied =
        text === undefined ? null : appliedSchema.parse(JSON.parse(text))
    } catch {
      options.onError?.(
        'extensions: applied.json is unreadable; waiting for the hub',
      )
    }
    this.#applied = applied
  }

  #now(): number {
    return (this.#options.now ?? Date.now)()
  }

  #codexHome(agent: string): string {
    return (
      this.#options.codexHome?.(agent) ??
      qianmoConfigPath('runtimes', 'codex', agent)
    )
  }

  #agentDir(agent: string): string {
    return path.join(this.#root, 'agents', agent)
  }

  status(): ExtensionsStatus {
    return {
      digest: this.#applied?.digest ?? null,
      results: this.#applied?.results ?? [],
      at: this.#applied?.at ?? null,
    }
  }

  /** What `agent`'s runtime loads; `null` when nothing is configured for it. */
  forAgent(agent: string): AgentExtensions | null {
    const applied = this.#applied
    if (applied === null) return null
    const entries = applied.entries.filter(entry => forAgent(entry, agent))
    if (entries.length === 0) return null
    const dir = this.#agentDir(agent)
    const failed = new Set(
      applied.results.filter(result => !result.ok).map(result => result.id),
    )
    const skills = entries.some(
      entry => entry.kind === 'skill' && !failed.has(entry.id),
    )
    const skillsPlugin = path.join(dir, 'plugins', SKILLS_PLUGIN)
    const plugins = entries.filter(
      entry =>
        entry.kind === 'plugin' &&
        existsSync(path.join(dir, 'plugins', entry.name)),
    )
    const formats = (entry: ExtensionWireEntry): PluginFormats =>
      applied.plugins[entry.id] ?? {
        claude: false,
        codex: null,
        standard: false,
      }
    const mcp = entries.filter(entry => entry.kind === 'mcp')
    const mcpPlugin = path.join(dir, 'mcp', MCP_PLUGIN)
    return {
      ompPluginDirs: [
        ...(skills ? [skillsPlugin] : []),
        ...(mcp.length > 0 && existsSync(mcpPlugin) ? [mcpPlugin] : []),
        ...plugins
          .filter(entry => formats(entry).claude || formats(entry).standard)
          .map(entry => path.join(dir, 'plugins', entry.name)),
      ],
      claudePluginDirs: [
        ...(skills ? [skillsPlugin] : []),
        ...plugins
          .filter(entry => formats(entry).claude)
          .map(entry => path.join(dir, 'plugins', entry.name)),
      ],
      mcp: mcp.map(entry => ({
        name: entry.name,
        transport: entry.transport ?? 'stdio',
        ...(entry.command === undefined ? {} : { command: entry.command }),
        ...(entry.args === undefined ? {} : { args: entry.args }),
        ...(entry.env === undefined ? {} : { env: entry.env }),
        ...(entry.url === undefined ? {} : { url: entry.url }),
        ...(entry.headers === undefined ? {} : { headers: entry.headers }),
        approval: entry.approval ?? 'ask',
        tools: applied.tools[entry.id] ?? [],
      })),
      readableRoots: [
        path.join(dir, 'plugins'),
        path.join(this.#codexHome(agent), 'plugins', 'cache', 'qianmo'),
      ],
    }
  }

  /** `extensions.apply` / `extensions.status` on the control link. */
  readonly control: ControlHandler = async (op, args) => {
    if (op === 'extensions.status') return { ok: true, value: this.status() }
    if (op !== 'extensions.apply')
      return { ok: false, code: 'unsupported', message: '不支持此扩展操作' }
    const parsed = applySchema.safeParse(args)
    if (!parsed.success)
      return { ok: false, code: 'invalid', message: '扩展清单格式无效' }
    if (extensionsDigest(parsed.data.entries) !== parsed.data.digest)
      return { ok: false, code: 'invalid', message: '扩展清单摘要不符' }
    return this.apply(parsed.data.entries, parsed.data.digest)
  }

  /** Lays out `entries`; one apply at a time. */
  async apply(
    entries: readonly ExtensionWireEntry[],
    digest = extensionsDigest(entries),
  ): Promise<ControlOutcome> {
    const run = this.#queue.then(() => this.#apply(entries, digest))
    this.#queue = run.catch(() => {})
    return run
  }

  async #apply(
    entries: readonly ExtensionWireEntry[],
    digest: string,
  ): Promise<ControlOutcome> {
    const previous = this.#applied
    if (
      previous?.digest === digest &&
      previous.results.every(result => result.ok)
    )
      return { ok: true, value: this.status() }
    const known = new Set(this.#options.agents.map(agent => agent.agent))
    const errors = new Map<string, string>()
    const fail = (id: string, message: string) => {
      if (!errors.has(id)) errors.set(id, message)
    }
    mkdirSync(this.#root, { recursive: true, mode: 0o700 })

    // 1. GitHub sources, cached by commit, directory and digest.
    const sources = new Map<string, string>()
    for (const entry of entries) {
      if (entry.github === undefined) continue
      const { repo, commit, digest: want } = entry.github
      const key = createHash('sha256')
        .update(`${repo}\0${commit}\0${entry.github.path}\0${want}`)
        .digest('hex')
        .slice(0, 32)
      const dest = path.join(this.#root, 'sources', key)
      if (!existsSync(dest)) {
        try {
          const got = await fetchGithubDir({
            policy: this.#options.policy ?? new OutboundPolicy(),
            repo,
            commit,
            path: entry.github.path,
            work: path.join(this.#root, 'work'),
            dest,
            ...(this.#options.run === undefined
              ? {}
              : { run: this.#options.run }),
          })
          if (got.digest !== want) {
            rmSync(dest, { recursive: true, force: true })
            fail(entry.id, '下载到的文件与中枢记录的摘要不符')
            continue
          }
        } catch (error) {
          fail(entry.id, failure(error))
          continue
        }
      }
      if (entry.kind === 'skill' && !existsSync(path.join(dest, 'SKILL.md')))
        fail(entry.id, '目录里没有 SKILL.md')
      sources.set(entry.id, dest)
    }

    // 2. Plugin formats.
    const plugins: Record<string, PluginFormats> = {}
    for (const entry of entries) {
      if (entry.kind !== 'plugin') continue
      const source = sources.get(entry.id)
      if (source === undefined) continue
      const formats = pluginFormats(source)
      if (!formats.claude && !formats.standard && formats.codex === null)
        fail(entry.id, '目录里没有可识别的插件清单')
      plugins[entry.id] = formats
    }

    // 3. qianmopi needs each MCP server's tool names.
    const ompAgents = this.#options.agents
      .filter(agent => agent.runtime === undefined)
      .map(agent => agent.agent)
    const tools: Record<string, string[]> = {}
    const probe = this.#options.probe ?? probeMcpTools
    await Promise.all(
      entries
        .filter(
          entry =>
            entry.kind === 'mcp' &&
            ompAgents.some(agent => forAgent(entry, agent)),
        )
        .map(async entry => {
          const reused = previous?.entries.find(old => old.id === entry.id)
          if (
            reused !== undefined &&
            JSON.stringify(reused) === JSON.stringify(entry) &&
            (previous?.tools[entry.id]?.length ?? 0) > 0
          ) {
            tools[entry.id] = previous!.tools[entry.id]!
            return
          }
          try {
            tools[entry.id] = await probe({
              name: entry.name,
              transport: entry.transport ?? 'stdio',
              ...(entry.command === undefined
                ? {}
                : { command: entry.command }),
              ...(entry.args === undefined ? {} : { args: entry.args }),
              ...(entry.env === undefined ? {} : { env: entry.env }),
              ...(entry.url === undefined ? {} : { url: entry.url }),
              ...(entry.headers === undefined
                ? {}
                : { headers: entry.headers }),
              cwd: this.#root,
            })
          } catch (error) {
            tools[entry.id] = []
            fail(entry.id, `qianmopi 连不上这个服务器：${failure(error)}`)
          }
        }),
    )

    // 4. Every agent's layout, built aside and swapped in whole.
    const next = path.join(this.#root, `agents.next-${randomUUID()}`)
    const agentDigests: Record<string, string> = {}
    try {
      for (const { agent, runtime } of this.#options.agents) {
        const mine = entries.filter(entry => forAgent(entry, agent))
        agentDigests[agent] = createHash('sha256')
          .update(
            JSON.stringify({
              entries: mine,
              tools: mine.map(entry => tools[entry.id] ?? []),
              failed: mine.map(entry => errors.has(entry.id)),
            }),
          )
          .digest('hex')
        if (mine.length === 0) continue
        this.#layout(path.join(next, agent), agent, runtime, mine, {
          sources,
          plugins,
          errors,
        })
      }
      const live = path.join(this.#root, 'agents')
      const old = path.join(this.#root, `agents.old-${randomUUID()}`)
      if (existsSync(live)) renameSync(live, old)
      mkdirSync(next, { recursive: true, mode: 0o700 })
      renameSync(next, live)
      rmSync(old, { recursive: true, force: true })
    } catch (error) {
      rmSync(next, { recursive: true, force: true })
      return {
        ok: false,
        code: 'failed',
        message: `扩展落地失败：${failure(error)}`,
      }
    }
    for (const entry of entries)
      if (
        entry.agents !== null &&
        !entry.agents.some(agent => known.has(agent))
      )
        fail(entry.id, '这台节点上没有它适用的智能体')

    const changed = this.#options.agents
      .map(agent => agent.agent)
      .filter(agent => previous?.agentDigests[agent] !== agentDigests[agent])

    // 5. Codex agents install through Codex itself; a failed install is
    // retried on the next apply even when the set did not change.
    const failedBefore = new Set(
      (previous?.results ?? [])
        .filter(result => !result.ok)
        .map(result => result.id),
    )
    for (const { agent, runtime } of this.#options.agents) {
      if (runtime !== 'codex') continue
      const retry = entries.some(
        entry => forAgent(entry, agent) && failedBefore.has(entry.id),
      )
      if (!changed.includes(agent) && !retry) continue
      await this.#installCodex(agent, entries, plugins, fail)
      if (retry && !changed.includes(agent)) changed.push(agent)
    }

    this.#applied = {
      v: 1,
      digest,
      entries: [...entries],
      results: entries.map(entry => ({
        id: entry.id,
        ok: !errors.has(entry.id),
        detail: errors.get(entry.id) ?? null,
      })),
      tools,
      plugins,
      agentDigests,
      at: this.#now(),
    }
    // Lifting a cache entry nobody uses any more is housekeeping.
    this.#pruneSources(new Set(sources.values()))
    writePrivateJson(path.join(this.#root, 'applied.json'), this.#applied)
    for (const agent of changed)
      await this.#options
        .changed?.(agent)
        .catch(error =>
          this.#options.onError?.(
            `extensions: recycling ${agent}: ${failure(error)}`,
          ),
        )
    return { ok: true, value: this.status() }
  }

  #layout(
    dir: string,
    agent: string,
    runtime: ExternalRuntimeKind | undefined,
    entries: readonly ExtensionWireEntry[],
    context: {
      readonly sources: ReadonlyMap<string, string>
      readonly plugins: Readonly<Record<string, PluginFormats>>
      readonly errors: ReadonlyMap<string, string>
    },
  ): void {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const plugins = path.join(dir, 'plugins')
    const market: Record<string, unknown>[] = []
    const skills = entries.filter(
      entry => entry.kind === 'skill' && !context.errors.has(entry.id),
    )
    if (skills.length > 0) {
      const root = path.join(plugins, SKILLS_PLUGIN)
      writeManifests(
        root,
        SKILLS_PLUGIN,
        `Skills the operator installed for ${agent}`,
      )
      for (const entry of skills) {
        const target = path.join(root, 'skills', entry.name)
        const source = context.sources.get(entry.id)
        if (source !== undefined) cpSync(source, target, { recursive: true })
        else {
          mkdirSync(target, { recursive: true })
          writeFileSync(
            path.join(target, 'SKILL.md'),
            skillMarkdown(
              entry.name,
              entry.description ?? '',
              entry.body ?? '',
            ),
          )
        }
      }
      market.push({
        name: SKILLS_PLUGIN,
        source: { source: 'local', path: `./plugins/${SKILLS_PLUGIN}` },
        policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
        category: 'Productivity',
      })
    }
    for (const entry of entries) {
      if (entry.kind !== 'plugin' || context.errors.has(entry.id)) continue
      const source = context.sources.get(entry.id)
      if (source === undefined) continue
      cpSync(source, path.join(plugins, entry.name), { recursive: true })
      const codexName = context.plugins[entry.id]?.codex
      if (codexName)
        market.push({
          name: codexName,
          source: { source: 'local', path: `./plugins/${entry.name}` },
          policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
          category: 'Productivity',
        })
    }
    if (market.length > 0) {
      mkdirSync(path.join(dir, '.agents', 'plugins'), { recursive: true })
      writeFileSync(
        path.join(dir, '.agents', 'plugins', 'marketplace.json'),
        JSON.stringify({
          name: 'qianmo',
          interface: { displayName: 'Qianmo' },
          plugins: market,
        }),
      )
    }
    const mcp = entries.filter(entry => entry.kind === 'mcp')
    if (runtime === undefined && mcp.length > 0) {
      const root = path.join(dir, 'mcp', MCP_PLUGIN)
      mkdirSync(root, { recursive: true, mode: 0o700 })
      writeFileSync(
        path.join(root, 'plugin.json'),
        JSON.stringify({
          $schema: AGENT_PLUGINS_MANIFEST,
          name: MCP_PLUGIN,
          version: '1.0.0',
          description: `MCP servers the operator configured for ${agent}`,
        }),
      )
      writeFileSync(
        path.join(root, 'mcp.json'),
        JSON.stringify({
          $schema: AGENT_PLUGINS_MCP,
          mcpServers: Object.fromEntries(
            mcp.map(entry => [entry.name, agentPluginsServer(entry)]),
          ),
        }),
        { mode: 0o600 },
      )
    }
  }

  async #installCodex(
    agent: string,
    entries: readonly ExtensionWireEntry[],
    plugins: Readonly<Record<string, PluginFormats>>,
    fail: (id: string, message: string) => void,
  ): Promise<void> {
    const mine = entries.filter(entry => forAgent(entry, agent))
    const home = this.#codexHome(agent)
    mkdirSync(home, { recursive: true, mode: 0o700 })
    const { toml: config, skipped } = codexMcpToml(
      mine.filter(entry => entry.kind === 'mcp'),
    )
    for (const id of skipped) fail(id, 'Codex 不支持 SSE 传输')
    writeFileSync(path.join(home, 'config.toml'), config, { mode: 0o600 })
    rmSync(path.join(home, 'plugins'), { recursive: true, force: true })
    const names = [
      ...(mine.some(entry => entry.kind === 'skill') ? [SKILLS_PLUGIN] : []),
      ...mine.flatMap(entry =>
        entry.kind === 'plugin' && plugins[entry.id]?.codex
          ? [plugins[entry.id]!.codex!]
          : [],
      ),
    ]
    if (names.length === 0) return
    const ids = mine
      .filter(entry => entry.kind !== 'mcp')
      .map(entry => entry.id)
    const bin = this.#options.codexBin
    if (bin === undefined) {
      for (const id of ids) fail(id, '这台节点没有 Codex，装不上')
      return
    }
    const run = this.#options.run ?? runCommand
    const env = {
      PATH: process.env['PATH'] ?? '/usr/bin:/bin',
      HOME: home,
      CODEX_HOME: home,
      LC_ALL: 'C',
    }
    const steps = [
      [bin, 'plugin', 'marketplace', 'add', this.#agentDir(agent)],
      ...names.map(name => [bin, 'plugin', 'add', `${name}@qianmo`]),
    ]
    for (const argv of steps) {
      const result = await run(argv, { env, timeoutMs: 120_000 }).catch(
        error => ({ code: -1, stdout: failure(error) }),
      )
      if (result.code !== 0) {
        const detail = `Codex 安装失败：${result.stdout.trim().split('\n').pop() ?? ''}`
        for (const id of ids) fail(id, detail)
        return
      }
    }
  }

  #pruneSources(keep: ReadonlySet<string>): void {
    const dir = path.join(this.#root, 'sources')
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      return
    }
    for (const name of names) {
      const full = path.join(dir, name)
      if (!keep.has(full)) rmSync(full, { recursive: true, force: true })
    }
  }
}
