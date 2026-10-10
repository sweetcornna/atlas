// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Application tool boundary for acceptance tasks; this is not an OS sandbox.
 * No shell, subprocess, network, subagent, or extension-management tools are exposed.
 * Hosts start with `--tools ''`; only this loaded guard enables tools.
 * Writes require every effective target to be in the host's exact allowlist. */
import type { ExtensionFactory } from '@oh-my-pi/pi-coding-agent/extensibility/extensions'
import { residentToolVerdict } from '@qianmo/extension/policy'
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'

export interface TaskGuardConfig {
  workspace: string
  allowedFiles: string[]
  readyFile: string
  nonce: string
}
const TOOLS = ['read', 'edit', 'write']
function canonical(path: string): string {
  if (existsSync(path)) return realpathSync(path)
  const parent = dirname(path)
  if (parent === path) return path
  return resolve(canonical(parent), relative(parent, path))
}
function strings(value: unknown): string[] {
  return typeof value === 'string'
    ? [value]
    : Array.isArray(value)
      ? value.flatMap(strings)
      : []
}
export function taskToolDenial(
  config: TaskGuardConfig,
  name: string,
  input: Record<string, unknown>,
): string | undefined {
  if (!TOOLS.includes(name))
    return `Tool ${name} is outside the acceptance allowlist`
  const verdict = residentToolVerdict(
    { toolName: name, input },
    {
      v: 1,
      agent: 'acceptance',
      workspace: config.workspace,
      edits: 'workspace',
      protectedRoots: [],
      hostTools: [],
    },
    { agentKind: 'main' },
  )
  if (verdict?.block) return verdict.reason
  if (name === 'read') return undefined
  const paths = [
    ...strings(input.path),
    ...strings(input.paths),
    ...strings(input._path),
  ]
  if (Array.isArray(input.edits))
    for (const edit of input.edits) {
      if (typeof edit === 'object' && edit !== null)
        paths.push(...strings((edit as Record<string, unknown>).rename))
    }
  for (const key of ['input', '_input']) {
    const value = input[key]
    if (typeof value === 'string')
      for (const match of value.matchAll(
        /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm,
      ))
        paths.push(match[1]!.trim())
  }
  if (paths.length === 0) return 'Cannot determine write targets'
  const workspace = canonical(config.workspace)
  const allowed = new Set(
    config.allowedFiles.map(file => canonical(resolve(workspace, file))),
  )
  for (const path of paths) {
    const file = canonical(resolve(workspace, path))
    const rel = relative(workspace, file)
    if (
      isAbsolute(rel) ||
      rel === '..' ||
      rel.startsWith(`..${sep}`) ||
      !allowed.has(file)
    )
      return `Write outside allowed production files: ${path}`
  }
  return undefined
}
const extension: ExtensionFactory = pi => {
  const file = process.env.QIANMO_TASK_GUARD_CONFIG
  if (!file) throw new Error('Missing acceptance tool guard configuration')
  const raw: unknown = JSON.parse(readFileSync(file, 'utf8'))
  if (typeof raw !== 'object' || raw === null)
    throw new Error('Invalid task guard configuration')
  const value = raw as Record<string, unknown>
  if (
    typeof value.workspace !== 'string' ||
    !isAbsolute(value.workspace) ||
    !Array.isArray(value.allowedFiles) ||
    !value.allowedFiles.every(path => typeof path === 'string') ||
    typeof value.readyFile !== 'string' ||
    typeof value.nonce !== 'string'
  )
    throw new Error('Invalid task guard fields')
  const config = value as unknown as TaskGuardConfig
  pi.on('tool_call', event => {
    const reason = taskToolDenial(config, event.toolName, { ...event.input })
    return reason ? { block: true, reason } : undefined
  })
  pi.on('before_subagent_spawn', () => ({
    block: true,
    reason: 'Acceptance tasks cannot spawn agents',
  }))
  pi.on('session_start', async () => {
    await pi.setActiveTools(TOOLS)
    writeFileSync(config.readyFile, config.nonce, { mode: 0o600 })
  })
}
export default extension
