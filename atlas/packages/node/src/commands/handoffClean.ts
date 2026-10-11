// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { validateHandoffCode } from '@qianmo/handoff'
import {
  consoleRequest,
  consoleError,
  projectAt,
  type Output,
  PROCESS_OUTPUT,
  nowLockPath,
} from './handoffNow.js'
import { acquireExclusiveLock } from '@qianmo/handoff'
import { repoAtOrigin } from './handoffGithub.js'
import { handoffCodeStore } from './handoffConfig.js'
import { deleteGithubTaskRefs } from './handoffGithubGit.js'
import { HandoffUserError } from './handoffStore.js'

export async function runClean(
  cwd: string,
  options: { readonly taskId?: string; readonly repo?: string },
  output: Output = PROCESS_OUTPUT,
): Promise<number> {
  const project = await projectAt(cwd)
  if ((await handoffCodeStore(project)) !== 'github')
    throw new HandoffUserError('clean 只适用于 GitHub 模式')
  const repo = await repoAtOrigin(project.root, options.repo)
  const lock = acquireExclusiveLock(nowLockPath(project.root))
  try {
    const answer = await consoleRequest(project, 'GET', '/v0/handoff')
    if (answer.status !== 200 || !Array.isArray(answer.body.tasks))
      throw new HandoffUserError(consoleError(answer))
    let count = 0
    for (const raw of answer.body.tasks) {
      if (typeof raw !== 'object' || raw === null) continue
      const task = raw as Record<string, unknown>
      if (
        task.ownerDevice !== project.device ||
        !['failed', 'returned', 'expired'].includes(String(task.state)) ||
        typeof task.taskId !== 'string' ||
        (options.taskId && options.taskId !== task.taskId)
      )
        continue
      const manifest = task.manifest as Record<string, unknown> | undefined
      const code = validateHandoffCode(manifest?.code, project.device)
      if (!code || code.repo !== repo) continue
      await deleteGithubTaskRefs(project.root, 'origin', code, task.taskId)
      const cleaned = await consoleRequest(
        project,
        'POST',
        `/v0/handoff/${encodeURIComponent(task.taskId)}/clean`,
        {},
      )
      if (cleaned.status !== 200)
        throw new HandoffUserError(consoleError(cleaned))
      output.out(`已清理 ${task.taskId} 的远端分支；提交号保留在台账`)
      count++
    }
    if (count === 0) output.out('没有属于本设备的可清理任务')
    return 0
  } finally {
    lock.release()
  }
}
