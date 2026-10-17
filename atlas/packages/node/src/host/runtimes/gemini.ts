// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Gemini CLI (`gemini --acp`) as an ACP runtime (`harness-backends.md` §1.3;
 * facts from `@google/gemini-cli@0.64.0`, the P36 survey of 2026-10-17).
 *
 * One process per agent session, `GEMINI_CLI_HOME` the agent's own home
 * (state lands in `<home>/.gemini/`), the model route from the environment
 * (`GOOGLE_GEMINI_BASE_URL` selects the gateway auth type; the key goes as
 * `x-goog-api-key`). What the node adds:
 *
 * - an admin-tier policy file per process (`--admin-policy`, above every
 *   native, workspace and extension policy): every tool asks
 *   (`session/request_permission`) except reading inside the workspace,
 *   todos and skill activation; the qianmo bridge runs unasked; web tools,
 *   subagents and plan-mode switches are off;
 * - only the bridge among MCP servers (`--allowed-mcp-server-names`): the
 *   agent's own and its extensions' servers are not started, because
 *   Gemini's permission request does not name the server a tool belongs to
 *   and the node decides MCP calls per server;
 * - the four settings the harness only reads from its settings files —
 *   usage statistics off (they go to Google otherwise), hooks off, no
 *   workspace `.env`, the gateway auth type — merged into the agent's own
 *   `settings.json`, every other entry kept; system settings would be the
 *   natural place, but Gemini skips a system file not owned by root;
 * - telemetry off and the workspace trusted by environment (an untrusted
 *   folder starts no MCP server, not even the bridge), no self-relaunch;
 * - the operator's skills (P32) as the node's own extension under
 *   `.gemini/extensions/qmo/`, beside whatever the harness installs itself.
 *
 * Auto-update only runs in the interactive UI, never under `--acp`. The
 * bridge comes through `session/new`, which carries no timeout: Gemini gives
 * it its 10-minute default, so a host tool that waits longer
 * (`qianmo_ask`) fails here. Its own settings would need the per-process
 * bridge in the agent's shared file, which concurrent sessions would race.
 *
 * A trusted workspace's own `.gemini/settings.json` still layers over the
 * agent's settings (Gemini has no per-layer opt-out); the node refuses
 * writes into it and into `.env` files, so an agent cannot plant one.
 */

import { existsSync, readFileSync } from 'node:fs'
import { basename, join, sep } from 'node:path'
import type {
  AcpLaunch,
  AcpLaunchInput,
  AcpToolCall,
  AcpVerdictCall,
} from './acpSpec.js'
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
export function geminiPolicy(bridge: string): string {
  if (!/^[a-z]+$/.test(bridge))
    throw new Error(`unexpected bridge server name ${JSON.stringify(bridge)}`)
  return `# Written by the qianmo node (P36) for one process. Do not edit.

[[rule]]
toolName = "*"
decision = "ask_user"
priority = 100

[[rule]]
toolName = ${tomlList(FREE_TOOLS)}
decision = "allow"
priority = 200

[[rule]]
mcpName = "${bridge}"
toolName = "*"
decision = "allow"
priority = 400

[[rule]]
toolName = ${tomlList(OFF_TOOLS)}
decision = "deny"
priority = 500
`
}

/** Settings the node needs; every other entry of the file is the harness's. */
const ENFORCED_SETTINGS = {
  privacy: { usageStatisticsEnabled: false },
  hooksConfig: { enabled: false },
  advanced: { ignoreLocalEnv: true },
  security: { auth: { selectedType: 'gateway' } },
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

/**
 * The agent's `settings.json` with the node's settings merged in, or
 * `undefined` when it already has them. A file the node cannot read as
 * plain JSON (comments) is left alone and the launch fails: rewriting it
 * would lose what the harness or the operator wrote.
 */
export function geminiSettings(path: string): string | undefined {
  let current: Record<string, unknown> = {}
  if (existsSync(path)) {
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
    current = parsed
  }
  const merged = overlay(current, ENFORCED_SETTINGS)
  return JSON.stringify(merged) === JSON.stringify(current)
    ? undefined
    : `${JSON.stringify(merged, null, 2)}\n`
}

/**
 * Gemini appends `/v1beta/models/…` itself; the lane's base URL may already
 * end in the version (`<gateway>/v1beta`, as `@qianmo/providers` models it).
 */
export function geminiBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '').replace(/\/v1beta$/, '')
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

export function geminiLaunch(input: AcpLaunchInput): AcpLaunch {
  if (input.lane !== 'gemini')
    throw new Error(`Gemini CLI does not call the ${input.lane} lane`)
  const policy = join(input.runDir, GEMINI_POLICY_FILE)
  const settingsPath = join(input.home, GEMINI_DIR, 'settings.json')
  const settings = geminiSettings(settingsPath)
  return {
    argv: [
      input.bin,
      '--acp',
      '--approval-mode',
      'default',
      '--admin-policy',
      policy,
      // Every other MCP server (the agent's settings, extensions) stays
      // unstarted: the permission request would not say whose tool it is.
      '--allowed-mcp-server-names',
      input.bridge.name,
    ],
    env: {
      GEMINI_CLI_HOME: input.home,
      GOOGLE_GEMINI_BASE_URL: geminiBaseUrl(input.baseUrl),
      GEMINI_API_KEY: input.apiKey,
      GEMINI_MODEL: input.model,
      GEMINI_TELEMETRY_ENABLED: 'false',
      GEMINI_CLI_TRUST_WORKSPACE: 'true',
      GEMINI_CLI_NO_RELAUNCH: 'true',
      ...(input.headers === undefined || Object.keys(input.headers).length === 0
        ? {}
        : { GEMINI_CLI_CUSTOM_HEADERS: customHeaders(input.headers) }),
    },
    files: [
      { path: policy, content: geminiPolicy(input.bridge.name) },
      ...(settings === undefined
        ? []
        : [{ path: settingsPath, content: settings }]),
      {
        path: join(input.home, QMO_EXTENSION, 'gemini-extension.json'),
        content: `${JSON.stringify({ name: 'qmo', version: '1.0.0' }, null, 2)}\n`,
      },
    ],
    // It looks for `.env` files from its working directory up.
    cwd: join(input.home, 'launch'),
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
  return genericAcpToolCall(call)
}
