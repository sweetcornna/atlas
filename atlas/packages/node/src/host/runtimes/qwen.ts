// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Qwen Code (`qwen --acp`) as an ACP runtime (`harness-backends.md` §1.3;
 * facts from `@qwen-code/qwen-code@0.25.2`, the P36 survey of 2026-10-17).
 *
 * One process per agent session with the agent's home as `HOME` (Qwen also
 * reads `~/.env` and `~/.qwen/.env`) and `QWEN_HOME` under it, the model
 * route from the environment (`--auth-type openai`: Chat Completions with
 * `OPENAI_*`). Everything the node needs is in a system settings file of
 * the node's own per process (`QWEN_CODE_SYSTEM_SETTINGS_PATH`, the layer
 * above the agent's and the workspace's settings, which stay untouched):
 *
 * - only the core tools a resident agent uses (`tools.core`): no subagents,
 *   teams, cron, web, memory, workflows, worktrees or LSP;
 * - `default` approval (Qwen's own default lets a classifier approve) and
 *   ask rules for every change, command and MCP call, above any allow rule
 *   the agent's settings union in;
 * - the bridge with its call timeout (`session/new` carries none), and the
 *   MCP idle timeout raised to it — one setting for every server;
 * - usage statistics, telemetry, hooks and auto-update off;
 * - the operator's skills (P32) from a directory of the node's own.
 *
 * Qwen's permission request carries the tool name (`_meta.toolName`) and
 * its arguments, and names MCP tools `mcp__<server>__<tool>`, so the node
 * decides them as it decides Claude Code's. A refused call ends Qwen's turn
 * there (its design, no setting changes it): the model does not hear of the
 * refusal and the turn has no answer.
 */

import { join } from 'node:path'
import type {
  AcpLaunch,
  AcpLaunchInput,
  AcpToolCall,
  AcpVerdictCall,
} from './acpSpec.js'
import { genericAcpToolCall } from './acpTools.js'

/** The node's settings layer, one per process. */
export const QWEN_SETTINGS_FILE = 'qmo-qwen-settings.json'
/** Where P32 lands the operator's skills, relative to the agent's home. */
export const QWEN_QMO_SKILLS = join('.qwen', 'qmo-skills')

/** The built-in tools a resident agent gets; the rest are not registered. */
const CORE_TOOLS = [
  'read_file',
  'grep_search',
  'glob',
  'list_directory',
  'edit',
  'write_file',
  'run_shell_command',
  'todo_write',
  'skill',
]

/** Asked every time, whatever the agent's own allow rules say. */
const ASK_RULES = ['run_shell_command', 'edit', 'write_file', 'mcp__*']

/**
 * Every other built-in tool of 0.25.2 (`ToolNames`). `tools.core` only
 * trims the tools declared up front; the rest stay registered behind the
 * deferred-tool bridge, which also hides MCP tools. The node declares
 * everything up front (`toolSearch.threshold`) and refuses these, the
 * bridge included, so every call reaches it by its own name.
 */
const DENY_RULES = [
  'exec',
  'zoom_image',
  'save_memory',
  'manage_memory',
  'search_memory',
  'agent',
  'exit_plan_mode',
  'enter_plan_mode',
  'web_fetch',
  'web_search',
  'image_gen',
  'lsp',
  'ask_user_question',
  'cron_create',
  'cron_list',
  'cron_delete',
  'loop_wakeup',
  'create_sub_session',
  'list_agents',
  'task_stop',
  'task_create',
  'task_update',
  'task_list',
  'team_create',
  'team_delete',
  'team_plan_approval',
  'request_shutdown',
  'send_message',
  'structured_output',
  'monitor',
  'notebook_edit',
  'tool_call',
  'tool_search',
  'read_mcp_resource',
  'advisor',
  'enter_worktree',
  'exit_worktree',
  'workflow',
  'artifact',
  'record_artifact',
  'record_source',
  'report_findings',
  'get_goal',
  'update_goal',
  'omni_downsample_image',
  'omni_downscale_video',
  'omni_downsample_audio',
  'omni_extract_keyframes',
  'omni_extract_audio',
  'omni_clip_video',
  'omni_convert_image',
  'omni_transcribe_audio',
  'omni_clip_image',
  'omni_clip_audio',
  'omni_caption_image',
  'omni_caption_audio',
  'omni_ocr_image',
  'omni_understand_video_segments',
  'omni_recall_media_memory',
  'propose_goal',
  'display_image',
]

export function qwenSettings(input: AcpLaunchInput): string {
  const settings = {
    privacy: { usageStatisticsEnabled: false },
    telemetry: { enabled: false },
    general: { enableAutoUpdate: false },
    disableAllHooks: true,
    tools: {
      core: CORE_TOOLS,
      approvalMode: 'default',
      toolSearch: { threshold: 100 },
    },
    permissions: { ask: ASK_RULES, deny: DENY_RULES },
    // Background model calls that write memories on their own.
    memory: { enableManagedAutoMemory: false, enableManagedAutoDream: false },
    skills: { directories: [join(input.home, QWEN_QMO_SKILLS)] },
    mcpServers: {
      [input.bridge.name]: {
        command: input.bridge.command,
        args: [...input.bridge.args],
        timeout: input.bridge.timeoutMs,
      },
    },
    mcp: { toolIdleTimeoutMs: input.bridge.timeoutMs },
  }
  return `${JSON.stringify(settings, null, 2)}\n`
}

export function qwenLaunch(input: AcpLaunchInput): AcpLaunch {
  if (input.lane !== 'openai-chat')
    throw new Error(`Qwen Code does not call the ${input.lane} lane`)
  const settings = join(input.runDir, QWEN_SETTINGS_FILE)
  return {
    argv: [
      input.bin,
      '--acp',
      '--auth-type',
      'openai',
      '--approval-mode',
      'default',
    ],
    env: {
      HOME: input.home,
      QWEN_HOME: join(input.home, '.qwen'),
      QWEN_CODE_SYSTEM_SETTINGS_PATH: settings,
      OPENAI_BASE_URL: input.baseUrl,
      OPENAI_API_KEY: input.apiKey,
      OPENAI_MODEL: input.model,
      QWEN_TELEMETRY_ENABLED: 'false',
      QWEN_USAGE_STATISTICS_ENABLED: 'false',
      // MCP servers connect inside `session/new`: otherwise the first turn
      // can reach the model before the bridge's tools are declared.
      QWEN_CODE_LEGACY_MCP_BLOCKING: '1',
    },
    files: [{ path: settings, content: qwenSettings(input) }],
    // It looks for `.env` files from its working directory up.
    cwd: join(input.home, 'launch'),
    dirs: [join(input.home, QWEN_QMO_SKILLS)],
    mountsBridge: true,
  }
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** Qwen's tool, by the name it puts in `_meta`, in the node's vocabulary. */
export function qwenToolCall(call: AcpToolCall): AcpVerdictCall[] {
  const raw = call.rawInput
  const name = text(call.meta?.toolName) ?? call.title
  const path = text(raw.file_path) ?? text(raw.absolute_path) ?? text(raw.path)
  switch (name) {
    case 'run_shell_command':
      return [{ toolName: 'bash', input: { ...raw } }]
    case 'edit':
    case 'write_file':
      return [
        {
          toolName: name === 'edit' ? 'edit' : 'write',
          input: { ...raw, ...(path ? { path } : {}) },
        },
      ]
    case 'read_file':
      return [{ toolName: 'read', input: { path: path ?? '' } }]
    case 'grep_search':
      return [{ toolName: 'grep', input: { path: path ?? '.' } }]
    case 'glob':
      return [{ toolName: 'glob', input: { path: path ?? '.' } }]
    case 'list_directory':
      return [{ toolName: 'read', input: { path: path ?? '.' } }]
    case 'todo_write':
      return [{ toolName: 'todo', input: {} }]
    default:
      return name.startsWith('mcp__')
        ? [{ toolName: name, input: { ...raw } }]
        : genericAcpToolCall(call)
  }
}
