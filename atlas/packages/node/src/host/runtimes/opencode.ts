// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * opencode (`opencode acp`) as an ACP runtime (`harness-backends.md` §1.3,
 * §7; facts from `opencode-ai@1.19.3`, the P36 survey and the P36.7
 * native-extension research of 2026-10-17).
 *
 * One process per agent session with the agent's home as `HOME` and the
 * XDG directories under it (opencode also reads `~/.claude` and `~/.agents`).
 * The node's configuration is one inline layer per process
 * (`OPENCODE_CONFIG_CONTENT`), merged after the agent's own config files,
 * which stay untouched:
 *
 * - the model route: one provider (`qm`) through the AI SDK adapter of the
 *   lane, its key read from `QM_OPENCODE_GATEWAY_KEY`; no other provider;
 * - permissions, for every agent opencode has and once more through
 *   `OPENCODE_PERMISSION` (an agent's own rules beat the config-wide ones):
 *   every tool asks (`session/request_permission`) but reading, searching
 *   and listing in the project, todos and skills; anything outside the
 *   project asks; subagents and web tools are refused; the bridge runs
 *   unasked; a refusal goes back to the model and the turn goes on
 *   (opencode's own default ends it);
 * - the bridge with its call timeout (servers from `session/new` get no
 *   timeout of their own);
 * - no sharing, no auto-update, no model-list fetch, no LSP downloads, no
 *   workspace `opencode.json`, `.opencode/` or `AGENTS.md`, no `.claude` or
 *   `.agents` skills, no Claude Code compatibility files;
 * - `--pure`: the agent's own opencode plugins are installed and work in
 *   the frontend, but a resident process never loads them — a plugin runs
 *   in-process, can rewrite permissions after every layer above, and its
 *   tools never ask (research O2);
 * - its local server (it listens even under ACP) on a port of the node's
 *   choosing, behind a password of this launch: it serves the resolved
 *   config, the gateway key included, to anyone who asks otherwise;
 * - the operator's skills (P32) from a directory of the node's own.
 *
 * Permission keys the agent's own config names and the node does not (a
 * native MCP server's tools, say) keep the agent's setting. opencode
 * installs its plugin SDK into its global config directory in the
 * background (npm), as it does on any machine.
 */

import { join } from 'node:path'
import type {
  AcpLaunch,
  AcpLaunchInput,
  AcpOpenLaunch,
  AcpToolCall,
  AcpVerdictCall,
  RuntimeRoute,
} from './acpSpec.js'
import { genericAcpToolCall } from './acpTools.js'

/** The variable the gateway key reaches opencode in. */
export const OPENCODE_KEY_ENV = 'QM_OPENCODE_GATEWAY_KEY'
/** Where P32 lands the operator's skills, relative to the agent's home. */
export const OPENCODE_QMO_SKILLS = 'qmo-skills'
const PROVIDER = 'qm'

/** opencode's own permission keys, which never name an MCP server. */
const BUILTIN = new Set([
  'read',
  'edit',
  'write',
  'patch',
  'apply_patch',
  'bash',
  'shell',
  'glob',
  'grep',
  'list',
  'task',
  'todowrite',
  'todoread',
  'webfetch',
  'websearch',
  'codesearch',
  'lsp',
  'skill',
  'question',
  'external_directory',
  'doom_loop',
  'plan_enter',
  'plan_exit',
])

/** opencode's agents: the primary ones and the subagents it ships. */
const AGENTS = ['build', 'plan', 'general', 'explore']

export function opencodePermission(bridge = 'qianmo'): Record<string, string> {
  return {
    '*': 'ask',
    read: 'allow',
    glob: 'allow',
    grep: 'allow',
    list: 'allow',
    todowrite: 'allow',
    todoread: 'allow',
    skill: 'allow',
    edit: 'ask',
    bash: 'ask',
    external_directory: 'ask',
    doom_loop: 'ask',
    task: 'deny',
    webfetch: 'deny',
    websearch: 'deny',
    codesearch: 'deny',
    question: 'deny',
    plan_enter: 'deny',
    plan_exit: 'deny',
    [`${bridge}_*`]: 'allow',
  }
}

export function opencodeConfig(input: AcpLaunchInput): string {
  const anthropic = input.lane === 'anthropic'
  const permission = opencodePermission(input.bridge?.name)
  const limit =
    input.contextWindow === undefined
      ? undefined
      : {
          context: input.contextWindow,
          output:
            input.maxOutputTokens ?? Math.min(32_000, input.contextWindow),
        }
  const config = {
    model: `${PROVIDER}/${input.model}`,
    small_model: `${PROVIDER}/${input.model}`,
    enabled_providers: [PROVIDER],
    provider: {
      [PROVIDER]: {
        name: 'Qianmo gateway',
        npm: anthropic ? '@ai-sdk/anthropic' : '@ai-sdk/openai-compatible',
        options: {
          // The Anthropic adapter appends `/messages` to a versioned base.
          baseURL: anthropic
            ? `${input.baseUrl.replace(/\/+$/, '')}/v1`
            : input.baseUrl,
          apiKey: `{env:${OPENCODE_KEY_ENV}}`,
          ...(input.headers === undefined ||
          Object.keys(input.headers).length === 0
            ? {}
            : { headers: input.headers }),
        },
        models: { [input.model]: limit === undefined ? {} : { limit } },
      },
    },
    default_agent: 'build',
    permission,
    agent: Object.fromEntries(AGENTS.map(agent => [agent, { permission }])),
    ...(input.bridge === undefined
      ? {}
      : {
          mcp: {
            [input.bridge.name]: {
              type: 'local',
              command: [input.bridge.command, ...input.bridge.args],
              enabled: true,
              timeout: input.bridge.timeoutMs,
            },
          },
        }),
    skills: { paths: [join(input.home, OPENCODE_QMO_SKILLS)] },
    share: 'disabled',
    autoupdate: false,
    experimental: { continue_loop_on_deny: true },
  }
  return JSON.stringify(config)
}

/** opencode's part of an agent's environment (`runtimeEnv`). */
export function opencodeEnv(
  home: string,
  route?: RuntimeRoute,
): Record<string, string> {
  return {
    HOME: home,
    XDG_CONFIG_HOME: join(home, 'config'),
    XDG_DATA_HOME: join(home, 'data'),
    XDG_CACHE_HOME: join(home, 'cache'),
    XDG_STATE_HOME: join(home, 'state'),
    OPENCODE_PERMISSION: JSON.stringify(opencodePermission()),
    OPENCODE_DISABLE_AUTOUPDATE: '1',
    OPENCODE_DISABLE_MODELS_FETCH: '1',
    OPENCODE_DISABLE_LSP_DOWNLOAD: '1',
    OPENCODE_DISABLE_PROJECT_CONFIG: '1',
    OPENCODE_DISABLE_EXTERNAL_SKILLS: '1',
    OPENCODE_DISABLE_CLAUDE_CODE: '1',
    OPENCODE_DISABLE_DEFAULT_PLUGINS: '1',
    ...(route === undefined ? {} : { [OPENCODE_KEY_ENV]: route.apiKey }),
  }
}

function opencodePins(input: AcpLaunchInput): Record<string, string> {
  if (input.lane !== 'openai-chat' && input.lane !== 'anthropic')
    throw new Error(`opencode does not call the ${input.lane} lane here`)
  if (input.secret === undefined)
    throw new Error('opencode needs a password for its local server')
  return {
    ...opencodeEnv(input.home, input),
    OPENCODE_CONFIG_CONTENT: opencodeConfig(input),
    OPENCODE_SERVER_PASSWORD: input.secret,
  }
}

export function opencodeLaunch(input: AcpLaunchInput): AcpLaunch {
  if (input.port === undefined)
    throw new Error('opencode needs a port for its local server')
  return {
    argv: [input.bin, 'acp', '--pure', '--port', String(input.port)],
    env: opencodePins(input),
    // It reads project config from its working directory up.
    cwd: join(input.home, 'launch'),
    dirs: [join(input.home, OPENCODE_QMO_SKILLS)],
    mountsBridge: true,
  }
}

/**
 * The frontends on the same pins: the terminal UI in the workspace, or the
 * web UI (`serve`, never `web`, which opens a browser) on loopback behind
 * the password of this launch. The agent's plugins load here (§7.4: they
 * are installed and usable in the frontend; the resident process runs
 * `--pure`, and the console says so).
 */
export function opencodeOpen(
  input: AcpLaunchInput,
  web: boolean,
): AcpOpenLaunch {
  const env = opencodePins(input)
  if (!web)
    return {
      argv: [input.bin],
      env,
      cwd: input.cwd,
      dirs: [join(input.home, OPENCODE_QMO_SKILLS)],
    }
  if (input.port === undefined)
    throw new Error('the opencode web UI needs a port')
  return {
    argv: [
      input.bin,
      'serve',
      '--hostname',
      '127.0.0.1',
      '--port',
      String(input.port),
    ],
    env,
    cwd: input.cwd,
    dirs: [join(input.home, OPENCODE_QMO_SKILLS)],
    url: `http://127.0.0.1:${input.port}/`,
  }
}

/**
 * opencode asks by permission key: the ACP `kind` places its own tools, and
 * an MCP tool's key (`<server>_<tool>`, the title) names its server, whose
 * console names have no underscore.
 */
export function opencodeToolCall(call: AcpToolCall): AcpVerdictCall[] {
  const key = /^([a-z0-9-]+)_(.+)$/.exec(call.title)
  if (
    (call.kind === undefined || call.kind === 'other') &&
    key !== null &&
    !BUILTIN.has(call.title)
  )
    return [
      { toolName: `mcp__${key[1]}__${key[2]}`, input: { ...call.rawInput } },
    ]
  return genericAcpToolCall(call)
}
