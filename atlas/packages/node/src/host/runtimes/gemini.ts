// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Gemini CLI (`gemini --acp`) as an ACP runtime (`harness-backends.md` §1.3,
 * §7; facts from `@google/gemini-cli@0.64.0`, the P36 survey and the P36.7
 * native-extension research of 2026-10-17).
 *
 * One process per agent session, the agent's own home as `HOME` and
 * `GEMINI_CLI_HOME` (state in `<home>/.gemini/`, credentials in a file there,
 * never the keychain), the model route from the environment
 * (`GOOGLE_GEMINI_BASE_URL`; the key goes as `x-goog-api-key`). What the
 * agent's operator installs natively there (extensions, MCP servers,
 * skills) loads as it is, under the node's pin layer:
 *
 * - an admin-tier policy file per process (`--admin-policy`, above every
 *   native, workspace and extension policy): every tool asks
 *   (`session/request_permission`) except reading inside the workspace,
 *   todos and skill activation; the qianmo bridge runs unasked; web tools,
 *   subagents and plan-mode switches are off;
 * - the MCP servers by name (`--allowed-mcp-server-names`): the bridge, the
 *   agent's own and its extensions' servers, the operator's connectors —
 *   never the workspace's. The allowlist would also let them run unasked;
 *   the admin policy makes them ask. The bridge is a server of the node's
 *   own extension with its call timeout (`session/new` carries none, and
 *   Gemini's default is 10 minutes, shorter than `qianmo_ask` waits); the
 *   extension file names the process's command and arguments by environment
 *   variable only, so every process of the agent writes the same file;
 * - `trust: true` on the agent's own MCP servers would skip confirmation
 *   inside the tool, below every policy: the node removes it from
 *   `settings.json` before every start (its one change to native config),
 *   and records which servers it revoked for the console (「已撤销预授权」);
 * - the settings the harness only reads from its settings files — usage
 *   statistics off (they go to Google otherwise), hooks off, no workspace
 *   `.env`, the API-key auth type (no sign-in dialog in the frontend) —
 *   merged into the agent's own `settings.json`, every other entry kept;
 *   system settings would be the natural place, but Gemini skips a system
 *   file not owned by root;
 * - telemetry off and the workspace trusted by environment (an untrusted
 *   folder starts no MCP server, not even the bridge), no self-relaunch;
 * - the operator's skills (P32) in that extension
 *   (`.gemini/extensions/qmo/`), beside whatever the harness installs.
 *
 * Auto-update only runs in the interactive UI, never under `--acp`.
 *
 * A trusted workspace's own `.gemini/settings.json`, `GEMINI.md` and skills
 * still load (Gemini has no per-layer opt-out); its MCP servers are not on
 * the allowlist, and the node refuses writes into `.gemini/` and `.env`
 * files, so an agent cannot plant one.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, join, sep } from 'node:path'
import type {
  AcpBridge,
  AcpLaunch,
  AcpLaunchInput,
  AcpOpenLaunch,
  AcpToolCall,
  AcpVerdictCall,
  RuntimeRoute,
} from './acpSpec.js'
import { writePrivateFileAtomic } from '../../providers/store.js'
import { genericAcpToolCall } from './acpTools.js'

/** The node's policy layer, one per process. */
export const GEMINI_POLICY_FILE = 'qmo-gemini-policy.toml'
const GEMINI_DIR = '.gemini'
/** The node's own extension in the agent's Gemini home. */
const QMO_EXTENSION = join(GEMINI_DIR, 'extensions', 'qmo')
/** Where P32 lands the operator's skills, relative to the agent's home. */
export const GEMINI_QMO_SKILLS = join(QMO_EXTENSION, 'skills')
/** Read-only or session-only tools that run unasked. */
const FREE_TOOLS = [
  'read_file',
  'read_many_files',
  'glob',
  'grep_search',
  'list_directory',
  'write_todos',
  'tracker_create_task',
  'tracker_update_task',
  'tracker_get_task',
  'tracker_list_tasks',
  'tracker_add_dependency',
  'tracker_visualize',
  'update_topic',
  'activate_skill',
]

/** Tools a resident agent does not get on this harness. */
const OFF_TOOLS = [
  'web_fetch',
  'google_web_search',
  'invoke_agent',
  'codebase_investigator',
  'cli_help',
  'generalist',
  'browser_agent',
  'get_internal_docs',
  'take_snapshot',
  'enter_plan_mode',
  'exit_plan_mode',
]

function tomlList(values: readonly string[]): string {
  return `[${values.map(value => JSON.stringify(value)).join(', ')}]`
}

/**
 * The admin policy. Priorities only order rules inside the admin tier,
 * which ranks above all others; the highest matching rule decides.
 * `bridge` is the node's server name (letters only).
 */
export function geminiPolicy(bridge?: string): string {
  if (bridge !== undefined && !/^[a-z]+$/.test(bridge))
    throw new Error(`unexpected bridge server name ${JSON.stringify(bridge)}`)
  const rule = (lines: string[]) => `[[rule]]\n${lines.join('\n')}\n`
  return [
    '# Written by the qianmo node (P36) for one process. Do not edit.\n',
    // Everything asks, MCP tools of every server included…
    rule(['toolName = "*"', 'decision = "ask_user"', 'priority = 100']),
    rule([
      'mcpName = "*"',
      'toolName = "*"',
      'decision = "ask_user"',
      'priority = 300',
    ]),
    // …but reads, todos and skills, and the node's own bridge…
    rule([
      `toolName = ${tomlList(FREE_TOOLS)}`,
      'decision = "allow"',
      'priority = 200',
    ]),
    ...(bridge === undefined
      ? []
      : [
          rule([
            `mcpName = "${bridge}"`,
            'toolName = "*"',
            'decision = "allow"',
            'priority = 400',
          ]),
        ]),
    // …and what a resident agent never gets.
    rule([
      `toolName = ${tomlList(OFF_TOOLS)}`,
      'decision = "deny"',
      'priority = 500',
    ]),
  ].join('\n')
}

/** Settings the node needs; every other entry of the file is the harness's. */
const ENFORCED_SETTINGS = {
  privacy: { usageStatisticsEnabled: false },
  hooksConfig: { enabled: false },
  advanced: { ignoreLocalEnv: true },
  // The frontend's sign-in dialog accepts no `gateway`; under ACP the
  // gateway is chosen from the base URL either way.
  security: { auth: { selectedType: 'gemini-api-key' } },
} as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** `base` with `enforced`'s leaves set, nothing else touched. */
function overlay(
  base: Record<string, unknown>,
  enforced: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(enforced))
    out[key] = isRecord(value)
      ? overlay(isRecord(base[key]) ? base[key] : {}, value)
      : value
  return out
}

function readSettings(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {}
  const raw = readFileSync(path, 'utf8')
  let parsed: unknown
  try {
    parsed = raw.trim() === '' ? {} : JSON.parse(raw)
  } catch {
    throw new Error(
      `Gemini settings ${path} are not plain JSON; the node will not rewrite them`,
    )
  }
  if (!isRecord(parsed))
    throw new Error(`Gemini settings ${path} are not a JSON object`)
  return parsed
}

/** The agent's own MCP servers that carry `trust` (it skips confirmation). */
export function geminiTrusted(path: string): string[] {
  const servers = readSettings(path).mcpServers
  return isRecord(servers)
    ? Object.entries(servers)
        .filter(([, server]) => isRecord(server) && server.trust !== undefined)
        .map(([name]) => name)
    : []
}

/**
 * The agent's `settings.json` with the node's settings merged in and `trust`
 * taken off its MCP servers, or `undefined` when it already is so. A file
 * the node cannot read as plain JSON (comments) is left alone and the
 * launch fails: rewriting it would lose what the harness or the operator
 * wrote.
 */
export function geminiSettings(path: string): string | undefined {
  const current = readSettings(path)
  const merged = overlay(current, ENFORCED_SETTINGS)
  if (isRecord(current.mcpServers))
    merged.mcpServers = Object.fromEntries(
      Object.entries(current.mcpServers).map(([name, server]) => {
        if (!isRecord(server)) return [name, server]
        const { trust: _trust, ...rest } = server
        return [name, rest]
      }),
    )
  return JSON.stringify(merged) === JSON.stringify(current)
    ? undefined
    : `${JSON.stringify(merged, null, 2)}\n`
}

/** Where the node records the servers it took `trust` off, in the home. */
export const GEMINI_TRUST_RECORD = 'qmo-revoked-trust.json'

/** The servers the node has taken `trust` off, as recorded. */
export function geminiRevoked(home: string): string[] {
  try {
    const value: unknown = JSON.parse(
      readFileSync(join(home, GEMINI_TRUST_RECORD), 'utf8'),
    )
    return Array.isArray(value)
      ? value.filter((name): name is string => typeof name === 'string')
      : []
  } catch {
    return []
  }
}

/**
 * Takes `trust` off the agent's own MCP servers now (after a native
 * operation; every launch does the same) and records whom; the servers the
 * node has revoked so far.
 */
export function geminiStripTrust(home: string): string[] {
  const path = join(home, GEMINI_DIR, 'settings.json')
  const revoked = geminiTrusted(path)
  const settings = geminiSettings(path)
  if (settings !== undefined) writePrivateFileAtomic(path, settings)
  const record = [...new Set([...geminiRevoked(home), ...revoked])]
  if (revoked.length > 0)
    writePrivateFileAtomic(
      join(home, GEMINI_TRUST_RECORD),
      `${JSON.stringify(record)}\n`,
    )
  return record
}

function serverNames(file: string): string[] {
  try {
    const value: unknown = JSON.parse(readFileSync(file, 'utf8'))
    return isRecord(value) && isRecord(value.mcpServers)
      ? Object.keys(value.mcpServers)
      : []
  } catch {
    return []
  }
}

/**
 * The agent's own MCP servers by name: its settings' and its extensions'
 * (the node's own `qmo` extension aside).
 */
export function geminiNativeServers(home: string): string[] {
  const names = new Set(serverNames(join(home, GEMINI_DIR, 'settings.json')))
  const extensions = join(home, GEMINI_DIR, 'extensions')
  let entries: string[] = []
  try {
    entries = readdirSync(extensions)
  } catch {
    // No extensions.
  }
  for (const name of entries) {
    if (name === 'qmo') continue
    for (const server of serverNames(
      join(extensions, name, 'gemini-extension.json'),
    ))
      names.add(server)
  }
  return [...names].sort()
}

/**
 * Gemini appends `/v1beta/models/…` itself; the lane's base URL may already
 * end in the version (`<gateway>/v1beta`, as `@qianmo/providers` models it).
 */
export function geminiBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '').replace(/\/v1beta$/, '')
}

/** An allowlist entry no server has (`qmo` is the node's extension). */
const NO_SERVER = 'qmo-none'

/** The prefix of the variables the bridge's command line reaches Gemini in. */
const BRIDGE_ENV = 'QM_GEMINI_BRIDGE'

/**
 * The node's extension: its name, and the bridge with the process's
 * command and arguments as variables Gemini resolves from its environment
 * (none in the frontend, which has no bridge).
 */
export function geminiExtension(bridge?: AcpBridge): {
  readonly manifest: string
  readonly env: Readonly<Record<string, string>>
} {
  const env: Record<string, string> = {}
  const servers: Record<string, unknown> = {}
  if (bridge !== undefined) {
    env[`${BRIDGE_ENV}_COMMAND`] = bridge.command
    const args = bridge.args.map((arg, at) => {
      env[`${BRIDGE_ENV}_ARG_${at}`] = arg
      return `\${${BRIDGE_ENV}_ARG_${at}}`
    })
    servers[bridge.name] = {
      command: `\${${BRIDGE_ENV}_COMMAND}`,
      args,
      timeout: bridge.timeoutMs,
    }
  }
  const manifest = {
    name: 'qmo',
    version: '1.0.0',
    ...(bridge === undefined ? {} : { mcpServers: servers }),
  }
  return { manifest: `${JSON.stringify(manifest, null, 2)}\n`, env }
}

/**
 * Gemini's part of an agent's environment (`runtimeEnv`): the agent's home
 * as `HOME` too (no `~/.gemini` or `~/.agents` of the node's account),
 * credentials in a file there, and the route when the caller has one.
 */
export function geminiEnv(
  home: string,
  route?: RuntimeRoute,
): Record<string, string> {
  return {
    HOME: home,
    GEMINI_CLI_HOME: home,
    GEMINI_FORCE_FILE_STORAGE: 'true',
    GEMINI_TELEMETRY_ENABLED: 'false',
    GEMINI_CLI_TRUST_WORKSPACE: 'true',
    GEMINI_CLI_NO_RELAUNCH: 'true',
    ...(route === undefined
      ? {}
      : {
          GOOGLE_GEMINI_BASE_URL: geminiBaseUrl(route.baseUrl),
          GEMINI_API_KEY: route.apiKey,
          GEMINI_MODEL: route.model,
          ...(route.headers === undefined ||
          Object.keys(route.headers).length === 0
            ? {}
            : { GEMINI_CLI_CUSTOM_HEADERS: customHeaders(route.headers) }),
        }),
  }
}

/** `content` unless `path` already holds it. */
function changed(path: string, content: string): string | undefined {
  return existsSync(path) && readFileSync(path, 'utf8') === content
    ? undefined
    : content
}

/** `Name: value, …`, the form `GEMINI_CLI_CUSTOM_HEADERS` is split by. */
function customHeaders(headers: Readonly<Record<string, string>>): string {
  return Object.entries(headers)
    .map(([name, value]) => {
      if (/[,:\r\n]/.test(name) || /[,\r\n]/.test(value))
        throw new Error(
          `Gemini CLI cannot carry header ${JSON.stringify(name)}: commas and line breaks do not survive its header variable`,
        )
      return `${name}: ${value}`
    })
    .join(', ')
}

/** The pins a resident process and the frontend share. */
function geminiPins(input: AcpLaunchInput): {
  readonly args: string[]
  readonly env: Record<string, string>
  readonly files: { path: string; content: string }[]
} {
  if (input.lane !== 'gemini')
    throw new Error(`Gemini CLI does not call the ${input.lane} lane`)
  const policy = join(input.runDir, GEMINI_POLICY_FILE)
  const settingsPath = join(input.home, GEMINI_DIR, 'settings.json')
  const revoked = geminiTrusted(settingsPath)
  const settings = geminiSettings(settingsPath)
  const extension = geminiExtension(input.bridge)
  const manifestPath = join(input.home, QMO_EXTENSION, 'gemini-extension.json')
  const manifest = changed(manifestPath, extension.manifest)
  const record = [...new Set([...geminiRevoked(input.home), ...revoked])]
  const allowed = [
    ...(input.bridge === undefined ? [] : [input.bridge.name]),
    ...geminiNativeServers(input.home),
    ...(input.mcpNames ?? []),
  ]
  // Without a name the flag would be left out and every server allowed.
  if (allowed.length === 0) allowed.push(NO_SERVER)
  return {
    args: [
      '--approval-mode',
      'default',
      '--admin-policy',
      policy,
      // The workspace's servers stay unstarted; the policy makes the
      // listed ones ask (the allowlist alone would let them run).
      '--allowed-mcp-server-names',
      [...new Set(allowed)].join(','),
    ],
    env: {
      ...geminiEnv(input.home, input),
      ...extension.env,
    },
    files: [
      {
        path: policy,
        content: geminiPolicy(input.bridge?.name),
      },
      ...(settings === undefined
        ? []
        : [{ path: settingsPath, content: settings }]),
      ...(revoked.length === 0
        ? []
        : [
            {
              path: join(input.home, GEMINI_TRUST_RECORD),
              content: `${JSON.stringify(record)}\n`,
            },
          ]),
      ...(manifest === undefined
        ? []
        : [{ path: manifestPath, content: manifest }]),
    ],
  }
}

export function geminiLaunch(input: AcpLaunchInput): AcpLaunch {
  const pins = geminiPins(input)
  return {
    argv: [input.bin, '--acp', ...pins.args],
    env: pins.env,
    files: pins.files,
    // It looks for `.env` files from its working directory up.
    cwd: join(input.home, 'launch'),
    dirs: [join(input.home, GEMINI_QMO_SKILLS)],
    mountsBridge: true,
  }
}

/**
 * The terminal frontend on the same pins, in the workspace (its sessions
 * and project settings key on the working directory); the person at the
 * terminal answers the prompts.
 */
export function geminiOpen(input: AcpLaunchInput): AcpOpenLaunch {
  const pins = geminiPins(input)
  return {
    argv: [input.bin, ...pins.args],
    env: pins.env,
    files: pins.files,
    cwd: input.cwd,
    dirs: [join(input.home, GEMINI_QMO_SKILLS)],
  }
}

/** A path inside a `.gemini` directory, or an env file: harness config. */
function harnessConfig(path: string): boolean {
  const name = basename(path)
  return (
    name === '.env' ||
    name.startsWith('.env.') ||
    path.split(/[\\/]/).includes(GEMINI_DIR) ||
    path.includes(`${sep}${GEMINI_DIR}${sep}`)
  )
}

/**
 * Gemini sends no `rawInput`, only the kind and the locations; the generic
 * mapping places those. A change to Gemini's own configuration in the
 * workspace is refused outright (a tool the verdict does not know).
 */
export function geminiToolCall(call: AcpToolCall): AcpVerdictCall[] {
  const changes =
    call.kind === 'edit' || call.kind === 'delete' || call.kind === 'move'
  if (changes && call.paths.some(harnessConfig))
    return [{ toolName: 'gemini_config', input: { paths: [...call.paths] } }]
  // An MCP tool's title names its server: `<tool> (<server> MCP Server)`
  // (Gemini keeps tool names to `[A-Za-z0-9_.-]`, so no tool can fake it).
  const mcp = /^([A-Za-z0-9_.-]+) \(([A-Za-z0-9_-]+) MCP Server\)$/.exec(
    call.title,
  )
  if (mcp !== null && (call.kind === undefined || call.kind === 'other'))
    return [
      { toolName: `mcp__${mcp[2]}__${mcp[1]}`, input: { ...call.rawInput } },
    ]
  return genericAcpToolCall(call)
}
