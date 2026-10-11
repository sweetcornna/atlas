#!/usr/bin/env bun
// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { spawn } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { ompChildEnv } from '@qianmo/paths'
import type { ResidentExtensionConfig } from '@qianmo/extension/policy'
import {
  desktopTools,
  type DesktopResource,
} from '@qianmo/extension/desktopPolicy'
import { OmpRpcProcess } from '../packages/node/src/host/residentOmp.js'
import { assertResidentExtensionBudget } from './residentExtensionBudget.js'

/** Cold-load the binary's extracted artifact with desktop registration enabled.
 * A fake model is enough for ready/get_state; no prompt or desktop is opened. */
export async function checkResidentExtensionCompiled(
  binary: string,
  residentRoot: string,
): Promise<{ bytes: number; toolNames: string[] }> {
  const artifacts: string[] = []
  const glob = new Bun.Glob(
    'config/resident/sessions/**/resident-extension-*.mjs',
  )
  let bytes = 0
  for await (const file of glob.scan({ cwd: residentRoot, onlyFiles: true })) {
    const artifact = path.join(residentRoot, file)
    bytes = assertResidentExtensionBudget(await Bun.file(artifact).text())
    artifacts.push(artifact)
  }
  if (artifacts.length === 0)
    throw new Error('Compiled resident did not extract its extension')
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qm-extension-rpc-'))
  const home = path.join(root, 'home')
  const config = path.join(root, 'config')
  const workspace = path.join(root, 'workspace')
  const agentDir = path.join(config, 'omp', 'agent')
  try {
    for (const dir of [home, workspace, agentDir])
      await fs.mkdir(dir, { recursive: true, mode: 0o700 })
    const extension = path.join(root, 'resident-extension.mjs')
    await fs.copyFile(artifacts[0]!, extension)
    const desktop: DesktopResource = {
      resourceId: 'registration-fixture',
      resourceEpoch: 1,
      browser: true,
      computer: true,
      cdpUrl: 'http://127.0.0.1:9',
      display: ':99',
      xauthority: null,
      downloads: path.join(root, 'downloads'),
      tab: 'registration-tab',
    }
    const desktopPath = path.join(root, 'desktop.json')
    await Bun.write(desktopPath, JSON.stringify(desktop))
    const policy: ResidentExtensionConfig = {
      v: 1,
      agent: 'registration',
      workspace,
      edits: 'none',
      protectedRoots: [],
      hostTools: [],
      desktopPath,
      desktop,
    }
    const policyPath = path.join(root, 'resident-extension.json')
    await Bun.write(policyPath, JSON.stringify(policy))
    await Bun.write(
      path.join(agentDir, 'models.yml'),
      'providers:\n  fake:\n    baseUrl: http://127.0.0.1:9/v1\n    api: openai-completions\n    apiKey: fake-not-secret\n    models:\n      - id: registration\n        name: Registration\n        contextWindow: 65536\n        maxTokens: 4096\n',
    )
    await Bun.write(
      path.join(agentDir, 'config.yml'),
      'modelRoles:\n  default: fake/registration\ndefaultThinkingLevel: off\nproviders:\n  cacheWarming: off\n',
    )
    const child = spawn(
      path.resolve(binary),
      ['agent', '--mode', 'rpc', '--no-extensions', '--extension', extension],
      {
        cwd: workspace,
        env: ompChildEnv({
          PATH: '/usr/bin:/bin',
          HOME: home,
          TMPDIR: root,
          QIANMO_CONFIG_DIR: config,
          QIANMO_EXTENSION_CONFIG: policyPath,
        }),
        stdio: ['pipe', 'pipe', 'inherit'],
      },
    )
    const rpc = new OmpRpcProcess(child)
    try {
      await rpc.initialize()
      const state = (await rpc.request('get_state')).data as {
        dumpTools?: { name: string }[]
      }
      const toolNames = (state.dumpTools ?? []).map(tool => tool.name)
      const missing = desktopTools(desktop).filter(
        name => !toolNames.includes(name),
      )
      if (
        missing.length > 0 ||
        toolNames.includes('eval') ||
        toolNames.includes('task')
      )
        throw new Error(
          `Compiled resident extension tools/hooks did not load: ${JSON.stringify({ missing, toolNames })}`,
        )
      if ((await fs.readdir(home)).length !== 0)
        throw new Error('Extension RPC probe wrote outside its config root')
      return { bytes, toolNames }
    } finally {
      await rpc.stop()
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}
