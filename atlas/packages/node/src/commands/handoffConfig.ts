// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  type HandoffProject,
  HandoffUserError,
  readTokenFile,
} from './handoffStore.js'

/** SSH deployments stay entirely offline; old HTTPS consoles may lack this route. */
export async function handoffCodeStore(
  project: Pick<HandoffProject, 'hub' | 'console' | 'tokenFile'>,
): Promise<'hub' | 'github'> {
  if (project.hub.kind !== 'https') return 'hub'
  if (!project.tokenFile) throw new HandoffUserError('没有设备令牌')
  const response = await fetch(`${project.console}/v0/handoff/config`, {
    headers: { authorization: `Bearer ${readTokenFile(project.tokenFile)}` },
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
  })
  if (response.status === 404 || response.status === 501) return 'hub'
  if (!response.ok)
    throw new HandoffUserError(`查不了接力模式（HTTP ${response.status}）`)
  const value: unknown = await response.json()
  if (
    typeof value !== 'object' ||
    value === null ||
    !('codeStore' in value) ||
    !['github', 'hub'].includes(String(value.codeStore))
  )
    throw new HandoffUserError('中枢接力模式不合法')
  return value.codeStore as 'hub' | 'github'
}
