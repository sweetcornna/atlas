// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Operator-configured MCP servers, skills and plugins on a node (P32,
 * `runtimes-channels.md` §9).
 *
 * The hub sends the node its whole set on the control link
 * (`extensions.apply`); the node lays it out under
 * `qianmoConfigPath('extensions')` in the shapes each runtime loads natively,
 * and recycles the children of every agent whose set changed:
 *
 * | layout (`agents/<agent>/`) | used by |
 * |---|---|
 * | `plugins/qianmo/` — the agent's skills, with Agent Plugins, Claude Code and Codex manifests | `--plugin-dir` (qianmopi, Claude Code); local marketplace (Codex) |
 * | `plugins/<name>/` — an imported plugin, without the MCP servers, hooks and LSP servers it bundles | the same, per the manifests it carries |
 * | `.agents/plugins/marketplace.json` | Codex: `codex plugin marketplace add` |
 * | `mcp/qianmo-mcp/` — `plugin.json` + `mcp.json` with the agent's MCP servers and their secrets, and `bin/qm-mcp-exec` | `--plugin-dir` (qianmopi only) |
 *
 * Claude Code gets the MCP servers in its `--mcp-config` file and Codex in
 * the agent's own `CODEX_HOME/config.toml`, so their secrets never sit in a
 * directory a runtime copies or an agent may read. qianmopi starts a stdio
 * server through `qm mcp-exec`, so it sees none of the node's environment. A GitHub source is only
 * used when its files match the digest the hub pinned.
 *
 * Results are kept per entry and agent: a failure on one agent (a Codex
 * install, an SSE server on Codex, a clashing tool name on qianmopi) leaves
 * the entry working for the others. A failure the next apply may get past
 * (a download, a probe, a Codex install) is marked `retry`; the hub resends
 * only for those. The set is laid out again when this node's agents or their
 * runtimes change, and on every start, which also probes every MCP server
 * anew.
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
import { qmArgv } from '../omp/launch.js'
import type { ControlHandler } from './control.js'
import { fetchGithubDir, GITHUB_REPO } from './githubDir.js'
import type { ExternalRuntimeKind } from './runtimes/channel.js'
import { toml } from './runtimes/codex.js'
import { runCommand, type RunCommand } from './runtimeUpdate.js'

/** Skill and plugin names, as Agent Skills allows (up to 64 characters). */
export const EXTENSION_NAME = /^[a-z](?:[a-z0-9]|-(?=[a-z0-9])){0,63}$/
/**
 * MCP server names stay at 40: a runtime's tool name (`mcp__<server>__<tool>`)
 * must fit the 64 characters model APIs accept.
 */
export const MCP_SERVER_NAME = /^[a-z](?:[a-z0-9]|-(?=[a-z0-9])){0,39}$/
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

export const extensionWireSchema = z
  .object({
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
  .refine(entry => entry.kind !== 'mcp' || MCP_SERVER_NAME.test(entry.name), {
    message: 'MCP server names are at most 40 characters',
  })
export type ExtensionWireEntry = z.infer<typeof extensionWireSchema>

const applySchema = z.object({
  digest: z.string().regex(/^[0-9a-f]{64}$/),
  entries: z.array(extensionWireSchema).max(200),
})

/** How one entry landed for one agent on this node. */
export interface ExtensionAgentResult {
  readonly agent: string
  readonly ok: boolean
  readonly detail: string | null
  /** The failure may go away on the next apply. */
  readonly retry: boolean
}

export interface ExtensionResult {
  readonly id: string
  /** It works for every agent it is for on this node. */
  readonly ok: boolean
  /** The first failure, prefixed with the agent when others have it. */
  readonly detail: string | null
  /** Some failure may go away on the next apply: the hub sends it again. */
  readonly retry: boolean
  readonly agents: readonly ExtensionAgentResult[]
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

const formatsSchema = z.object({
  claude: z.boolean(),
  codex: z.string().nullable(),
  standard: z.boolean(),
})
type PluginFormats = z.infer<typeof formatsSchema>

const rosterSchema = z.array(
  z.object({
    agent: z.string(),
    runtime: z.enum(['claude-code', 'codex']).nullable(),
  }),
)
type Roster = z.infer<typeof rosterSchema>

const appliedSchema = z.object({
  /** 1: before results per agent; read, then laid out again on start. */
  v: z.union([z.literal(1), z.literal(2)]),
  digest: z.string(),
  entries: z.array(extensionWireSchema),
  results: z.array(
    z.object({
      id: z.string(),
      ok: z.boolean(),
      detail: z.string().nullable(),
      retry: z.boolean().default(false),
      agents: z
        .array(
          z.object({
            agent: z.string(),
            ok: z.boolean(),
            detail: z.string().nullable(),
            retry: z.boolean(),
          }),
        )
        .default([]),
    }),
  ),
  tools: z.record(z.string(), z.array(z.string())),
  plugins: z.record(z.string(), formatsSchema),
  agentDigests: z.record(z.string(), z.string()),
  /** The agents and runtimes the set was laid out for. */
  roster: rosterSchema.optional(),
  /** Codex agents: what their `CODEX_HOME` was last installed with. */
  codex: z.record(z.string(), z.string()).default({}),
  at: z.number(),
})
type Applied = z.infer<typeof appliedSchema> & { roster: Roster }

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
  /** How qianmopi starts `qm mcp-exec`; tests point it elsewhere. */
  readonly mcpExec?: (args: readonly string[]) => string[]
  /** An agent's set changed: recycle its children. */
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

function sha256(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function sameRoster(a: Roster, b: Roster): boolean {
  const key = (roster: Roster) =>
    JSON.stringify([...roster].sort((x, y) => x.agent.localeCompare(y.agent)))
  return key(a) === key(b)
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

/** Files at a plugin's root that start processes outside qianmo's verdict. */
const BUNDLED_RUNNABLE_FILES = ['.mcp.json', 'mcp.json', '.lsp.json']
/** Manifest fields that do the same. */
const BUNDLED_RUNNABLE_FIELDS: ReadonlySet<string> = new Set([
  'mcpServers',
  'hooks',
  'lspServers',
])
const PLUGIN_MANIFESTS = [
  ['.claude-plugin', 'plugin.json'],
  ['.codex-plugin', 'plugin.json'],
  ['plugin.json'],
] as const

/**
 * An imported plugin brings its instructions (skills, commands, agents,
 * rules), never processes of its own: no bundled MCP server (configure it as
 * a connector, so its secrets, approval and environment are qianmo's), no
 * hooks, no LSP servers, and for qianmopi no custom tool modules, which it
 * would import in-process.
 */
export function keepInstructionsOnly(
  dir: string,
  runtime: ExternalRuntimeKind | undefined,
): void {
  for (const name of BUNDLED_RUNNABLE_FILES)
    rmSync(path.join(dir, name), { force: true })
  rmSync(path.join(dir, 'hooks'), { recursive: true, force: true })
  if (runtime === undefined)
    rmSync(path.join(dir, 'tools'), { recursive: true, force: true })
  for (const parts of PLUGIN_MANIFESTS) {
    const file = path.join(dir, ...parts)
    const manifest = readJson(file)
    if (manifest === null) continue
    const kept = Object.fromEntries(
      Object.entries(manifest).filter(
        ([key]) => !BUNDLED_RUNNABLE_FIELDS.has(key),
      ),
    )
    if (Object.keys(kept).length !== Object.keys(manifest).length)
      writeFileSync(file, JSON.stringify(kept, null, 2))
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

/**
 * `qm mcp-exec`'s arguments for a stdio server: it starts the server with the
 * baseline environment and the server's own variables only.
 */
function mcpExecArgs(entry: ExtensionWireEntry): string[] {
  const keep = Object.keys(entry.env ?? {})
  return [
    ...(keep.length > 0 ? ['--keep', keep.join(',')] : []),
    '--',
    entry.command ?? '',
    ...(entry.args ?? []),
  ]
}

/** The wrapper inside the MCP plugin that runs `qm mcp-exec`. */
const MCP_EXEC_SHIM = './bin/qm-mcp-exec'

/**
 * Agent Plugins only start a bare command or one inside the plugin
 * (`./…`, symlinks resolved), so the plugin carries a script that execs qm.
 */
function mcpExecShim(argv: readonly string[]): string {
  const quoted = argv.map(arg => `'${arg.replaceAll("'", "'\\''")}'`)
  return [
    '#!/bin/sh',
    '# Written by the qianmo node (P32). Do not edit.',
    `exec ${quoted.join(' ')} "$@"`,
    '',
  ].join('\n')
}

/** An MCP server in the Agent Plugins `mcp.json` shape. */
function agentPluginsServer(
  entry: ExtensionWireEntry,
): Record<string, unknown> {
  if (entry.transport === 'stdio')
    return {
      type: 'stdio',
      command: MCP_EXEC_SHIM,
      args: mcpExecArgs(entry),
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

interface Failure {
  readonly detail: string
  readonly retry: boolean
}

/** Failures of one apply: for an entry everywhere, or for one agent. */
class Failures {
  readonly #entry = new Map<string, Failure>()
  readonly #agent = new Map<string, Map<string, Failure>>()

  /** The first failure recorded wins. */
  fail(
    id: string,
    detail: string,
    retry: boolean,
    agents?: readonly string[],
  ): void {
    if (agents === undefined) {
      if (!this.#entry.has(id)) this.#entry.set(id, { detail, retry })
      return
    }
    const byAgent = this.#agent.get(id) ?? new Map<string, Failure>()
    for (const agent of agents)
      if (!byAgent.has(agent)) byAgent.set(agent, { detail, retry })
    this.#agent.set(id, byAgent)
  }

  entry(id: string): Failure | undefined {
    return this.#entry.get(id)
  }

  of(id: string, agent: string): Failure | undefined {
    return this.#entry.get(id) ?? this.#agent.get(id)?.get(agent)
  }

  /**
   * Not laid out for `agent`: failed everywhere, or for good on this agent.
   * An MCP server whose probe failed stays, with the tools it had.
   */
  blocked(id: string, agent: string): boolean {
    if (this.#entry.has(id)) return true
    const failed = this.#agent.get(id)?.get(agent)
    return failed !== undefined && !failed.retry
  }
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
      if (text !== undefined) {
        const parsed = appliedSchema.parse(JSON.parse(text))
        // Before v2 the roster was not kept; `start()` lays the set out again.
        applied = { ...parsed, roster: parsed.roster ?? this.#roster() }
      }
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

  #mcpExecCommand(args: readonly string[]): {
    command: string
    args: string[]
  } {
    const [command, ...rest] = (this.#options.mcpExec ?? qmArgv)([
      'mcp-exec',
      ...args,
    ])
    return { command: command!, args: rest }
  }

  #roster(): Roster {
    return this.#options.agents.map(agent => ({
      agent: agent.agent,
      runtime: agent.runtime ?? null,
    }))
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
    // Laid out for another runtime, or before this agent existed: nothing
    // until the set is laid out again.
    const here = this.#options.agents.find(one => one.agent === agent)
    const laid = applied.roster.find(one => one.agent === agent)
    if (
      here === undefined ||
      laid === undefined ||
      (here.runtime ?? null) !== laid.runtime
    )
      return null
    const entries = applied.entries.filter(entry => forAgent(entry, agent))
    if (entries.length === 0) return null
    const usable = (entry: ExtensionWireEntry): boolean => {
      const result = applied.results.find(one => one.id === entry.id)
      if (result === undefined) return true
      const mine =
        result.agents.find(one => one.agent === agent) ??
        (result.agents.length === 0 ? result : undefined)
      if (mine === undefined || mine.ok) return true
      return entry.kind === 'mcp' && mine.retry
    }
    const dir = this.#agentDir(agent)
    const skillsPlugin = path.join(dir, 'plugins', SKILLS_PLUGIN)
    const skills =
      entries.some(entry => entry.kind === 'skill' && usable(entry)) &&
      existsSync(skillsPlugin)
    const plugins = entries.filter(
      entry =>
        entry.kind === 'plugin' &&
        usable(entry) &&
        existsSync(path.join(dir, 'plugins', entry.name)),
    )
    const formats = (entry: ExtensionWireEntry): PluginFormats =>
      applied.plugins[entry.id] ?? {
        claude: false,
        codex: null,
        standard: false,
      }
    const mcp = entries.filter(entry => entry.kind === 'mcp' && usable(entry))
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
  apply(
    entries: readonly ExtensionWireEntry[],
    digest = extensionsDigest(entries),
  ): Promise<ControlOutcome> {
    return this.#serial(() => this.#apply(entries, digest, false))
  }

  /**
   * At node start: lays the last set out again for this node's agents (some
   * may be new or on another runtime) and probes every MCP server anew, so a
   * server that gained tools gets them allowed. Recycles who changed.
   */
  start(): Promise<void> {
    const applied = this.#applied
    if (applied === null) return Promise.resolve()
    return this.#serial(() =>
      this.#apply(applied.entries, applied.digest, true),
    ).then(
      outcome => {
        if (!outcome.ok)
          this.#options.onError?.(`extensions: ${outcome.message}`)
      },
      error =>
        this.#options.onError?.(`extensions: start failed: ${failure(error)}`),
    )
  }

  /** Waits for the apply in progress. */
  async close(): Promise<void> {
    await this.#queue
  }

  #serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(work)
    this.#queue = run.catch(() => {})
    return run
  }

  async #apply(
    entries: readonly ExtensionWireEntry[],
    digest: string,
    again: boolean,
  ): Promise<ControlOutcome> {
    const previous = this.#applied
    const roster = this.#roster()
    if (
      !again &&
      previous?.digest === digest &&
      sameRoster(previous.roster, roster) &&
      !previous.results.some(result => result.retry)
    )
      return { ok: true, value: this.status() }
    const failures = new Failures()
    const applies = (entry: ExtensionWireEntry) =>
      roster.map(one => one.agent).filter(agent => forAgent(entry, agent))
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
            failures.fail(entry.id, '下载到的文件与中枢记录的摘要不符', false)
            continue
          }
        } catch (error) {
          failures.fail(entry.id, failure(error), true)
          continue
        }
      }
      if (entry.kind === 'skill' && !existsSync(path.join(dest, 'SKILL.md')))
        failures.fail(entry.id, '目录里没有 SKILL.md', false)
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
        failures.fail(entry.id, '目录里没有可识别的插件清单', false)
      plugins[entry.id] = formats
    }

    // 3. qianmopi needs each MCP server's tool names: asked anew every time,
    // so tools a server adds later are allowed too.
    const ompAgents = roster
      .filter(one => one.runtime === null)
      .map(one => one.agent)
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
          try {
            tools[entry.id] = await probe({
              name: entry.name,
              transport: entry.transport ?? 'stdio',
              // Started as qianmopi will start it, through `qm mcp-exec`.
              ...((entry.transport ?? 'stdio') === 'stdio'
                ? this.#mcpExecCommand(mcpExecArgs(entry))
                : {}),
              ...(entry.env === undefined ? {} : { env: entry.env }),
              ...(entry.url === undefined ? {} : { url: entry.url }),
              ...(entry.headers === undefined
                ? {}
                : { headers: entry.headers }),
              cwd: this.#root,
            })
          } catch (error) {
            // A server that is down for now keeps the tools it had.
            const before = previous?.entries.find(old => old.id === entry.id)
            tools[entry.id] =
              before !== undefined &&
              JSON.stringify(before) === JSON.stringify(entry)
                ? (previous?.tools[entry.id] ?? [])
                : []
            failures.fail(
              entry.id,
              `qianmopi 连不上这个服务器：${failure(error)}`,
              true,
              ompAgents.filter(agent => forAgent(entry, agent)),
            )
          }
        }),
    )

    // 4. Two servers whose tools qianmopi would name alike: the verdict could
    // not tell them apart, so the later name stays off that agent.
    for (const agent of ompAgents) {
      const seen = new Map<string, ExtensionWireEntry>()
      const servers = entries
        .filter(entry => entry.kind === 'mcp' && forAgent(entry, agent))
        .sort((a, b) => a.name.localeCompare(b.name))
      for (const entry of servers) {
        const clash = (tools[entry.id] ?? [])
          .map(name => seen.get(name))
          .find(other => other !== undefined)
        if (clash !== undefined) {
          failures.fail(
            entry.id,
            `qianmopi 里它的工具名与连接器 ${clash.name} 的相同 · 给其中一个换个名称`,
            false,
            [agent],
          )
          continue
        }
        for (const name of tools[entry.id] ?? []) seen.set(name, entry)
      }
    }

    // 5. What a runtime cannot take, and entries for nobody here.
    const codexAgents = roster
      .filter(one => one.runtime === 'codex')
      .map(one => one.agent)
    for (const entry of entries) {
      if (entry.kind === 'mcp' && entry.transport === 'sse')
        failures.fail(
          entry.id,
          'Codex 不支持 SSE 传输',
          false,
          codexAgents.filter(agent => forAgent(entry, agent)),
        )
      if (applies(entry).length === 0)
        failures.fail(entry.id, '这台节点上没有它适用的智能体', false)
    }

    // 6. Every agent's layout, built aside and swapped in whole.
    const laidOut = (agent: string) =>
      entries.filter(
        entry => forAgent(entry, agent) && !failures.blocked(entry.id, agent),
      )
    const next = path.join(this.#root, `agents.next-${randomUUID()}`)
    try {
      for (const { agent, runtime } of roster) {
        const mine = laidOut(agent)
        if (mine.length === 0) continue
        this.#layout(
          path.join(next, agent),
          agent,
          runtime ?? undefined,
          mine,
          { sources, plugins },
        )
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

    // 7. Codex agents install through Codex itself, when what they should
    // have differs from their last install or that install failed.
    const codex: Record<string, string> = { ...(previous?.codex ?? {}) }
    for (const agent of codexAgents) {
      const mine = laidOut(agent)
      const wanted = sha256({
        entries: mine,
        plugins: mine.map(entry => plugins[entry.id] ?? null),
      })
      const failedBefore = (previous?.results ?? []).some(result =>
        result.agents.some(one => one.agent === agent && !one.ok && one.retry),
      )
      if (codex[agent] === wanted && !failedBefore) continue
      if (codex[agent] === undefined && mine.length === 0) continue
      if (await this.#installCodex(agent, mine, plugins, failures))
        codex[agent] = wanted
    }

    // 8. Results, and who sees something else now.
    const results: Applied['results'] = entries.map(entry => {
      const agents = applies(entry).map(agent => {
        const failed = failures.of(entry.id, agent)
        return {
          agent,
          ok: failed === undefined,
          detail: failed?.detail ?? null,
          retry: failed?.retry ?? false,
        }
      })
      const whole = failures.entry(entry.id)
      const bad = agents.filter(one => !one.ok)
      const first = bad[0]
      return {
        id: entry.id,
        ok: whole === undefined && bad.length === 0,
        detail:
          whole?.detail ??
          (first === undefined
            ? null
            : bad.length === agents.length &&
                bad.every(one => one.detail === first.detail)
              ? first.detail
              : `${first.agent}：${first.detail}`),
        retry: whole?.retry ?? bad.some(one => one.retry),
        agents,
      }
    })
    const agentDigests: Record<string, string> = {}
    for (const { agent, runtime } of roster) {
      const mine = laidOut(agent)
      agentDigests[agent] = sha256(
        runtime === 'codex'
          ? { runtime, installed: codex[agent] ?? null }
          : {
              runtime,
              entries: mine,
              plugins: mine.map(entry => plugins[entry.id] ?? null),
              tools:
                runtime === null
                  ? mine.map(entry => tools[entry.id] ?? [])
                  : [],
            },
      )
    }
    const changed = roster
      .map(one => one.agent)
      .filter(agent => previous?.agentDigests[agent] !== agentDigests[agent])

    this.#applied = {
      v: 2,
      digest,
      entries: [...entries],
      results,
      tools,
      plugins,
      agentDigests,
      roster,
      codex,
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
    },
  ): void {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const plugins = path.join(dir, 'plugins')
    const market: Record<string, unknown>[] = []
    const skills = entries.filter(entry => entry.kind === 'skill')
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
      if (entry.kind !== 'plugin') continue
      const source = context.sources.get(entry.id)
      if (source === undefined) continue
      const target = path.join(plugins, entry.name)
      cpSync(source, target, { recursive: true })
      keepInstructionsOnly(target, runtime)
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
      if (mcp.some(entry => entry.transport === 'stdio')) {
        const shim = path.join(root, MCP_EXEC_SHIM)
        mkdirSync(path.dirname(shim), { recursive: true, mode: 0o700 })
        const { command, args } = this.#mcpExecCommand([])
        writeFileSync(shim, mcpExecShim([command, ...args]), { mode: 0o700 })
      }
    }
  }

  /**
   * Builds the agent's Codex configuration in a fresh `CODEX_HOME` beside the
   * live one, then swaps the plugin cache and `config.toml` in. A running
   * Codex never sees a half-written home; if the marketplace cannot be added
   * the live home stays as it was. Whether every plugin went in.
   */
  async #installCodex(
    agent: string,
    mine: readonly ExtensionWireEntry[],
    plugins: Readonly<Record<string, PluginFormats>>,
    failures: Failures,
  ): Promise<boolean> {
    const home = this.#codexHome(agent)
    mkdirSync(home, { recursive: true, mode: 0o700 })
    const stage = `${home}.next-${randomUUID()}`
    mkdirSync(stage, { mode: 0o700 })
    try {
      const { toml: config } = codexMcpToml(
        mine.filter(entry => entry.kind === 'mcp'),
      )
      writeFileSync(path.join(stage, 'config.toml'), config, { mode: 0o600 })
      const wanted = new Map<string, string[]>()
      const want = (name: string, id: string) =>
        wanted.set(name, [...(wanted.get(name) ?? []), id])
      for (const entry of mine) {
        if (entry.kind === 'skill') want(SKILLS_PLUGIN, entry.id)
        const codexName = plugins[entry.id]?.codex
        if (entry.kind === 'plugin' && codexName) want(codexName, entry.id)
      }
      let complete = true
      const bin = this.#options.codexBin
      if (wanted.size > 0 && bin === undefined) {
        for (const ids of wanted.values())
          for (const id of ids)
            failures.fail(id, '这台节点没有 Codex，装不上', false, [agent])
        complete = false
      } else if (wanted.size > 0 && bin !== undefined) {
        const run = this.#options.run ?? runCommand
        const env = {
          PATH: process.env['PATH'] ?? '/usr/bin:/bin',
          HOME: stage,
          CODEX_HOME: stage,
          LC_ALL: 'C',
        }
        const step = (argv: readonly string[]) =>
          run(argv, { env, timeoutMs: 120_000 }).catch(error => ({
            code: -1,
            stdout: failure(error),
          }))
        const said = (stdout: string) =>
          `Codex 安装失败：${stdout.trim().split('\n').pop() ?? ''}`
        const market = await step([
          bin,
          'plugin',
          'marketplace',
          'add',
          this.#agentDir(agent),
        ])
        if (market.code !== 0) {
          for (const entry of mine)
            failures.fail(
              entry.id,
              `${said(market.stdout)} · 这个智能体沿用上一次的扩展`,
              true,
              [agent],
            )
          return false
        }
        for (const [name, ids] of wanted) {
          const added = await step([bin, 'plugin', 'add', `${name}@qianmo`])
          if (added.code === 0) continue
          complete = false
          for (const id of ids)
            failures.fail(id, said(added.stdout), true, [agent])
        }
      }
      // The plugin cache first, then the config that enables it. The cache
      // before this one stays until the next install, for a turn still
      // reading a skill from it.
      const live = path.join(home, 'plugins')
      const previous = path.join(home, 'plugins.previous')
      rmSync(previous, { recursive: true, force: true })
      if (existsSync(live)) renameSync(live, previous)
      const staged = path.join(stage, 'plugins')
      if (existsSync(staged)) renameSync(staged, live)
      renameSync(
        path.join(stage, 'config.toml'),
        path.join(home, 'config.toml'),
      )
      return complete
    } finally {
      rmSync(stage, { recursive: true, force: true })
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
