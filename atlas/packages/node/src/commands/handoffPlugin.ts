// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as path from 'node:path'
import * as fs from 'node:fs/promises'
import { qianmoConfigPath } from '@qianmo/paths'
import { readTextIfExists, writePrivateFileAtomic } from '../providers/store.js'
import { HANDOFF_PLUGIN_FILES } from './handoffPluginFiles.js'
import { handoffShellArgument } from './handoffHub.js'
import type { Output } from './handoffNow.js'
import { HandoffUserError } from './handoffStore.js'

export const handoffPluginPath = (): string =>
  qianmoConfigPath('qianmo', 'plugin', 'qianmo')
export type HandoffPluginTool = 'claude-code' | 'codex' | 'omp'

/** All assets are text imports, so source and compiled qm install the same package. */
export async function installHandoffPlugin(
  tool: HandoffPluginTool,
  dryRun: boolean,
  output: Output,
): Promise<number> {
  const directory = handoffPluginPath()
  const marketplace = path.dirname(directory)
  const binary = tool === 'claude-code' ? 'claude' : tool
  const commands = [
    [binary, 'plugin', 'marketplace', 'add', marketplace],
    [binary, 'plugin', tool === 'codex' ? 'add' : 'install', 'qianmo@qianmo'],
  ]
  if (!dryRun) {
    // Codex 0.162 deliberately skips hooks for Agent Plugins manifests. Keep
    // the portable manifest alongside the legacy manifests without activating it.
    if (tool === 'codex') {
      const portable = path.join(directory, 'plugin.json')
      const existing = readTextIfExists(portable)
      if (existing !== undefined) {
        if (existing !== HANDOFF_PLUGIN_FILES['plugin.json'])
          throw new HandoffUserError(
            '插件目录的 plugin.json 已被修改，请保留后另行安装',
          )
        await fs.rename(
          portable,
          path.join(directory, 'plugin.agent-plugins.json'),
        )
      }
    }
    for (const [relative, text] of Object.entries(HANDOFF_PLUGIN_FILES)) {
      const target = path.join(
        directory,
        tool === 'codex' && relative === 'plugin.json'
          ? 'plugin.agent-plugins.json'
          : relative,
      )
      if (readTextIfExists(target) !== text)
        writePrivateFileAtomic(target, text)
    }
    const file = path.join(marketplace, '.claude-plugin', 'marketplace.json')
    const text = `${JSON.stringify({ name: 'qianmo', owner: { name: 'Qianmo AgentNest Team' }, plugins: [{ name: 'qianmo', source: './qianmo' }] }, null, 2)}\n`
    if (readTextIfExists(file) !== text) writePrivateFileAtomic(file, text)
  }
  for (const argv of commands)
    output.out(argv.map(handoffShellArgument).join(' '))
  if (dryRun) return 0
  if (!Bun.which(binary)) {
    output.out(`${binary} 不在 PATH，请安装后执行以上命令。`)
    return 0
  }
  for (const argv of commands) {
    const proc = Bun.spawn(argv, {
      stdin: 'inherit',
      stdout: 'inherit',
      stderr: 'inherit',
    })
    if ((await proc.exited) !== 0)
      throw new HandoffUserError(`${binary} 插件安装失败；可手动执行以上命令`)
  }
  return 0
}
