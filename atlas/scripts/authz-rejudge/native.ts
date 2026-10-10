// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  normalizeToolEventInput,
  resolveToolEventInput,
} from '@oh-my-pi/pi-coding-agent/extensibility/tool-event-input'
import { Settings } from '@oh-my-pi/pi-coding-agent/config/settings'
import { EditTool } from '@oh-my-pi/pi-coding-agent/edit'
import { resolveApproval } from '@oh-my-pi/pi-coding-agent/tools/approval'
import { AstEditTool } from '@oh-my-pi/pi-coding-agent/tools/ast-edit'
import { GlobTool } from '@oh-my-pi/pi-coding-agent/tools/glob'
import { GrepTool } from '@oh-my-pi/pi-coding-agent/tools/grep'
import type { ToolSession } from '@oh-my-pi/pi-coding-agent/tools'
import { ReadTool } from '@oh-my-pi/pi-coding-agent/tools/read'
import { TodoTool } from '@oh-my-pi/pi-coding-agent/tools/todo'
import { WaitTool } from '@oh-my-pi/pi-coding-agent/tools/wait'
import { WriteTool } from '@oh-my-pi/pi-coding-agent/tools/write'
import { YieldTool } from '@oh-my-pi/pi-coding-agent/tools/yield'
import {
  RESIDENT_DENIED_TOOLS,
  type ResidentExtensionConfig,
} from '@qianmo/extension/policy'

/** In-memory settings only. No project config, user rule, hook, model, or tool execution. */
export function nativeApproval(config: ResidentExtensionConfig) {
  const session: ToolSession = {
    cwd: config.workspace,
    hasUI: false,
    getSessionFile: () => null,
    getSessionSpawns: () => null,
    settings: Settings.isolated(),
  }
  const tools = [
    new ReadTool(session),
    new WriteTool(session),
    new EditTool(session),
    new AstEditTool(session),
    new GrepTool(session),
    new GlobTool(session),
    new TodoTool(session),
    new WaitTool(session),
    new YieldTool(session),
  ]
  const policies = Object.fromEntries([
    ...RESIDENT_DENIED_TOOLS.map(name => [name, 'deny']),
    ...config.hostTools.map(name => [name, 'allow']),
  ])
  return (name: string, input: Record<string, unknown>) => {
    const tool = tools.find(tool => tool.name === name) ?? { name }
    return {
      ...resolveApproval(
        tool,
        input,
        config.edits === 'workspace' ? 'write' : 'always-ask',
        policies,
      ),
      input: normalizeToolEventInput(name, resolveToolEventInput(tool, input)),
    }
  }
}
