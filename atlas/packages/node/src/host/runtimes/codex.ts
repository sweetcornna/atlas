// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { existsSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { RUNTIME_MCP_SERVER } from '@qianmo/harness/claudeStream.ts'
import type {
  CodexChannelOptions,
  CodexRequest,
} from '@qianmo/harness/codexRpc.ts'
import { toolArgs } from '@qianmo/harness/process.ts'
import type { RuntimeRoute } from './acpSpec.js'
import { CONNECTOR_PREFIX, RUNTIME_MCP_TIMEOUT_MS } from './claudeCode.js'

/** A TOML literal for one `-c key=value` override. */
export function toml(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number' || typeof value === 'boolean')
    return String(value)
  if (Array.isArray(value)) return `[${value.map(toml).join(', ')}]`
  if (value && typeof value === 'object')
    return `{ ${Object.entries(value)
      .map(([key, entry]) => `${JSON.stringify(key)} = ${toml(entry)}`)
      .join(', ')} }`
  return '""'
}

/** The variable a resident Codex reads its key from. */
export const CODEX_KEY_ENV = 'QIANMO_RUNTIME_KEY'

/** Codex's part of an agent's environment (`runtimeEnv`). */
export function codexEnv(
  home: string,
  route?: RuntimeRoute,
): Record<string, string> {
  return {
    CODEX_HOME: home,
    ...(route === undefined ? {} : { [CODEX_KEY_ENV]: route.apiKey }),
  }
}

/**
 * The paths Codex may key the workspace's trust under: as given, resolved,
 * and the repository root above either (Codex trusts a project at its root).
 */
export function codexWorkspaceKeys(workspace: string): string[] {
  const keys = new Set<string>([workspace])
  try {
    keys.add(realpathSync(workspace))
  } catch {
    // Not there yet: the path as given.
  }
  for (const start of [...keys]) {
    for (let dir = start; ; dir = dirname(dir)) {
      if (existsSync(join(dir, '.git'))) {
        keys.add(dir)
        break
      }
      if (dirname(dir) === dir) break
    }
  }
  return [...keys]
}

/**
 * The pin layer's session overrides (`harness-backends.md` §7.4): the
 * workspace is never a trusted project — its `.codex/` config (MCP servers
 * that would run unasked, hooks) never loads and a `workspace-write` thread
 * persists no trust (P36.7 research T1/L1: before this, the first such turn
 * made the workspace trusted for good). The table must be inline: Codex
 * ignores a dotted `projects."<path>"` override, and an inline one replaces
 * the table for the session, trust the agent's home recorded included. No
 * workspace `AGENTS.md` either.
 */
export function codexPinOverrides(workspace: string): Record<string, unknown> {
  return {
    projects: Object.fromEntries(
      codexWorkspaceKeys(workspace).map(key => [
        key,
        { trust_level: 'untrusted' },
      ]),
    ),
    project_doc_max_bytes: 0,
  }
}

/**
 * Codex features a resident agent never uses. `plugins` stays on: the
 * operator's skills and plugins load through it (P32); what a plugin bundles
 * besides skills is kept out by `apps`, `remote_plugin` and `hooks` here and
 * by the node's config for bundled MCP servers.
 */
const CODEX_DISABLED_FEATURES = [
  'multi_agent',
  'apps',
  'remote_plugin',
  'skill_mcp_dependency_install',
  'browser_use',
  'browser_use_external',
  'computer_use',
  'in_app_browser',
  'image_generation',
  'hooks',
  'memories',
  'goals',
]
const CODEX_SHELL_FEATURES = ['shell_tool', 'unified_exec']

export interface CodexLaunch {
  readonly bin: string
  readonly model: string
  /** OpenAI Responses-compatible base URL, ending before `/responses`. */
  readonly baseUrl: string
  /** Name of the environment variable that holds the key. */
  readonly keyEnv: string
  readonly headers?: Readonly<Record<string, string>>
  /** The agent's workspace: never a trusted project (the pin layer). */
  readonly workspace: string
  /** The MCP server that exposes the host's `qianmo_*` tools. */
  readonly mcp?: { readonly command: string; readonly args: readonly string[] }
  /**
   * P32 connectors as `mcp_servers.qm-<name>` tables (session overrides,
   * never written into the agent's `config.toml`).
   */
  readonly connectors?: Readonly<
    Record<string, Readonly<Record<string, unknown>>>
  >
  readonly effort?: string
  /** `--agent-shell`: keep Codex's shell, which then asks for every command. */
  readonly shell?: boolean
}

/** The `-c` overrides the resident process and the frontend share. */
function codexOverrides(launch: CodexLaunch): Record<string, unknown> {
  const provider = {
    name: 'qianmo',
    base_url: launch.baseUrl,
    env_key: launch.keyEnv,
    wire_api: 'responses',
    ...(launch.headers && Object.keys(launch.headers).length > 0
      ? { http_headers: launch.headers }
      : {}),
  }
  return {
    'model_providers.qianmo': provider,
    model_provider: 'qianmo',
    model: launch.model,
    ...codexPinOverrides(launch.workspace),
    // The host authorizes its own tools when they are called; Codex asking
    // first would only get them refused (P32 audit 14).
    ...(launch.mcp === undefined
      ? {}
      : {
          [`mcp_servers.${RUNTIME_MCP_SERVER}`]: {
            command: launch.mcp.command,
            args: [...launch.mcp.args],
            default_tools_approval_mode: 'approve',
            tool_timeout_sec: RUNTIME_MCP_TIMEOUT_MS / 1000,
          },
        }),
    ...Object.fromEntries(
      Object.entries(launch.connectors ?? {}).map(([name, table]) => [
        `mcp_servers.${name}`,
        table,
      ]),
    ),
    // The host is the only notifier; no desktop notification hooks.
    notify: [],
    ...(launch.effort ? { model_reasoning_effort: launch.effort } : {}),
  }
}

function codexConfigArgs(launch: CodexLaunch): string[] {
  return [
    ...Object.entries(codexOverrides(launch)).flatMap(([key, value]) => [
      '-c',
      `${key}=${toml(value)}`,
    ]),
    ...[
      ...CODEX_DISABLED_FEATURES,
      ...(launch.shell ? [] : CODEX_SHELL_FEATURES),
    ].flatMap(feature => ['--disable', feature]),
    '-c',
    'web_search="disabled"',
  ]
}

/** The command line for one resident `codex app-server` (stdio). */
export function codexArgv(launch: CodexLaunch): string[] {
  return [launch.bin, 'app-server', ...codexConfigArgs(launch)]
}

/**
 * The official terminal frontend (`qm runtime open`): the same overrides
 * and disabled features, no shared daemon; the person at the terminal
 * answers Codex's own approvals.
 */
export function codexOpenArgv(launch: CodexLaunch): string[] {
  return [launch.bin, '--no-daemon', ...codexConfigArgs(launch)]
}

/** What the app-server reports about the agent's native items. */
export interface CodexNativeState {
  /** `mcpServerStatus/list` `data`. */
  readonly servers: readonly Record<string, unknown>[]
  /** `plugin/installed` `marketplaces[].plugins[]`. */
  readonly plugins: readonly Record<string, unknown>[]
  /** `skills/list` `data[].skills[]`. */
  readonly skills: readonly Record<string, unknown>[]
}

/**
 * The thread's own overrides (`thread/start` / `thread/resume` `config`),
 * built from what the app-server lists before the thread starts: every tool
 * of a native MCP server asks (a persisted per-tool `approval_mode =
 * "approve"`, an "always" someone answered in the frontend, is overridden
 * per tool; a server-wide default does not override it), and the
 * repository's own skills stay off. Plugin servers are overridden through
 * one inline `plugins` table, which replaces the session's, so it carries
 * every installed plugin's own `enabled`. The node's servers (`qianmo`, P32
 * `qm-*`) are left as the pool configured them.
 */
export function codexThreadConfig(
  state: CodexNativeState,
): Record<string, unknown> {
  const config: Record<string, unknown> = {}
  const own = (name: string) =>
    name === RUNTIME_MCP_SERVER || name.startsWith(CONNECTOR_PREFIX)
  const plugins: Record<string, Record<string, unknown>> = {}
  for (const plugin of state.plugins) {
    if (plugin.installed !== true || typeof plugin.id !== 'string') continue
    plugins[plugin.id] = { enabled: plugin.enabled !== false }
  }
  for (const server of state.servers) {
    const name = server.name
    if (typeof name !== 'string' || own(name)) continue
    const tools = Object.keys(toolArgs(server.tools))
    const prompt = Object.fromEntries(
      tools.map(tool => [tool, { approval_mode: 'prompt' }]),
    )
    const plugin = server.pluginId
    if (typeof plugin === 'string' && plugin !== '') {
      const entry = plugins[plugin] ?? { enabled: true }
      const servers = toolArgs(entry.mcp_servers)
      plugins[plugin] = {
        ...entry,
        mcp_servers: { ...servers, [name]: { tools: prompt } },
      }
    } else
      for (const tool of tools)
        config[`mcp_servers.${name}.tools.${tool}.approval_mode`] = 'prompt'
  }
  if (Object.values(plugins).some(entry => entry.mcp_servers !== undefined))
    config.plugins = plugins
  const repo = state.skills.filter(
    skill => skill.scope === 'repo' && typeof skill.path === 'string',
  )
  if (repo.length > 0)
    config['skills.config'] = repo.map(skill => ({
      path: skill.path,
      enabled: false,
    }))
  return config
}

/**
 * The agent's native MCP servers, plugins and skills as the app-server
 * sees them. A failure fails the start: without the list a persisted
 * approval could run a native tool unasked.
 */
async function codexNativeState(
  request: CodexRequest,
  cwd: string,
): Promise<CodexNativeState> {
  const servers: Record<string, unknown>[] = []
  let cursor: string | undefined
  for (let page = 0; page < 50; page++) {
    const listed = toolArgs(
      await request('mcpServerStatus/list', {
        ...(cursor === undefined ? {} : { cursor }),
      }),
    )
    servers.push(
      ...(Array.isArray(listed.data) ? listed.data : []).map(toolArgs),
    )
    cursor =
      typeof listed.nextCursor === 'string' && listed.nextCursor !== ''
        ? listed.nextCursor
        : undefined
    if (cursor === undefined) break
  }
  const installed = toolArgs(await request('plugin/installed', {}))
  const plugins = (
    Array.isArray(installed.marketplaces) ? installed.marketplaces : []
  ).flatMap(market => {
    const list = toolArgs(market).plugins
    return (Array.isArray(list) ? list : []).map(toolArgs)
  })
  const listed = toolArgs(
    await request('skills/list', {
      cwds: [cwd],
      forceReload: true,
    }),
  )
  const skills = (Array.isArray(listed.data) ? listed.data : []).flatMap(
    entry => {
      const list = toolArgs(entry).skills
      return (Array.isArray(list) ? list : []).map(toolArgs)
    },
  )
  return { servers, plugins, skills }
}

/**
 * A resident agent's thread (`CodexChannel`'s `thread`): asks on request in
 * its sandbox, approvals to this client, the node's instructions, and the
 * native items overridden as `codexThreadConfig` says.
 */
export function codexResidentThread(settings: {
  readonly cwd: string
  readonly developerInstructions: string
  readonly allowWorkspaceEdits: boolean
}): CodexChannelOptions['thread'] {
  return async request => {
    const config = codexThreadConfig(
      await codexNativeState(request, settings.cwd),
    )
    return {
      cwd: settings.cwd,
      approvalPolicy: 'on-request',
      sandbox: settings.allowWorkspaceEdits ? 'workspace-write' : 'read-only',
      developerInstructions: settings.developerInstructions,
      // Approvals come to this client, never Codex's reviewer agent a
      // native `approvals_reviewer` would route them to.
      approvalsReviewer: 'user',
      ...(Object.keys(config).length === 0 ? {} : { config }),
    }
  }
}
