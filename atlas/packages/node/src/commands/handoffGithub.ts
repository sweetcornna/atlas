// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { randomBytes } from 'node:crypto'
import {
  isHandoffRepo,
  githubHandoffRef,
  shadowCommit,
  sessionCommit,
  runGit,
  isTaskId,
  validateHandoffCode,
  type HandoffCode,
} from '@qianmo/handoff'
import type { HandoffProject } from './handoffStore.js'
import { HandoffUserError } from './handoffStore.js'
import type { SessionSnapshot } from './handoffSyncTypes.js'
import { githubGit, githubRemoteRefs } from './githubRepoGit.js'

export type RepoVisibility = 'public' | 'private' | 'unknown'
export interface GithubHandoffOptions {
  /** Test seam only; the CLI always derives the name from origin. */
  readonly repo?: string
  readonly taskId?: string
  readonly probe?: (repo: string) => Promise<RepoVisibility>
}

export function githubRepoFromOrigin(origin: string): string | null {
  const match =
    /^(?:https:\/\/github\.com\/|git@github\.com:)([A-Za-z0-9-]+\/[A-Za-z0-9._-]+?)\/?$/.exec(
      origin,
    )
  if (!match) return null
  const repo = match[1]?.replace(/\.git$/, '')
  return isHandoffRepo(repo) ? repo : null
}

export async function repoAtOrigin(
  root: string,
  override?: string,
): Promise<string> {
  const origin = (
    await runGit(['remote', 'get-url', 'origin'], { cwd: root })
  ).stdout
    .toString('utf8')
    .trim()
  const repo = override ?? githubRepoFromOrigin(origin)
  if (!isHandoffRepo(repo))
    throw new HandoffUserError(
      'origin 不是 GitHub 仓库，无法转交：需要 https://github.com/owner/name 或 git@github.com:owner/name',
    )
  return repo
}

/** No authentication: a 404 is not publicly visible, all uncertainty fails closed. */
export async function probeGithubVisibility(
  repo: string,
): Promise<RepoVisibility> {
  if (!isHandoffRepo(repo)) return 'unknown'
  try {
    const response = await fetch(`https://api.github.com/repos/${repo}`, {
      headers: { accept: 'application/vnd.github+json' },
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    })
    if (response.status === 404) {
      await response.body?.cancel()
      return 'private'
    }
    if (response.status !== 200) {
      await response.body?.cancel()
      return 'unknown'
    }
    const value: unknown = await response.json()
    return typeof value === 'object' && value !== null && 'private' in value
      ? value.private === false
        ? 'public'
        : value.private === true
          ? 'private'
          : 'unknown'
      : 'unknown'
  } catch {
    return 'unknown'
  }
}

export async function syncGithub(
  project: HandoffProject,
  sessions: readonly SessionSnapshot[],
  options: GithubHandoffOptions = {},
) {
  const repo = await repoAtOrigin(project.root, options.repo)
  const taskId =
    options.taskId ??
    `g-${Date.now().toString(36)}-${randomBytes(6).toString('hex')}`
  if (!isTaskId(taskId)) throw new HandoffUserError('任务号不合法')
  const shadow = await shadowCommit({ cwd: project.root })
  if (!shadow.branch)
    throw new HandoffUserError('当前是 detached HEAD，先建分支再转交')
  let visibility: RepoVisibility
  try {
    visibility = await (options.probe ?? probeGithubVisibility)(repo)
  } catch {
    visibility = 'unknown'
  }
  const first = sessions[0]
  const session =
    visibility === 'private' && first !== undefined
      ? await sessionCommit({
          cwd: project.root,
          file: first.file,
          content: first.content,
          redact: true,
        })
      : null
  const reason =
    session === null
      ? visibility === 'public'
        ? '公开仓库不推送会话记录'
        : visibility === 'unknown'
          ? '仓库可见性未知，不推送会话记录'
          : '没有完整会话记录，不推送会话记录'
      : undefined
  const code: HandoffCode = {
    repo,
    wip: {
      ref: githubHandoffRef('wip', project.device, taskId),
      commit: shadow.commit,
    },
    sessions:
      session === null
        ? null
        : {
            ref: githubHandoffRef('sessions', project.device, taskId),
            commit: session.commit,
          },
    ...(reason === undefined ? {} : { reason }),
  }
  if (!validateHandoffCode(code, project.device))
    throw new HandoffUserError('GitHub 接力坐标不合法')
  const refs = [code.wip, ...(code.sessions === null ? [] : [code.sessions])]
  for (const ref of refs)
    await runGit(['update-ref', ref.ref, ref.commit], { cwd: project.root })
  // User's origin and existing local credential helper; no hub token here.
  await githubGit(
    [
      'push',
      '--atomic',
      'origin',
      ...refs.map(ref => `${ref.commit}:${ref.ref}`),
    ],
    project.root,
  )
  const remote = await githubRemoteRefs(
    project.root,
    'origin',
    refs.map(ref => ref.ref),
  )
  if (refs.some(ref => remote.get(ref.ref) !== ref.commit))
    throw new HandoffUserError('origin 引用未指向刚推送的提交')
  return {
    code,
    taskId,
    branch: shadow.branch,
    head: shadow.head,
    wip: shadow.commit,
    tree: shadow.tree,
    wipRef: code.wip.ref,
    excluded: shadow.excluded,
    sessions:
      session === null || first === undefined
        ? []
        : [
            {
              sessionId: first.sessionId,
              ref: code.sessions?.ref ?? '',
              commit: session.commit,
              reused: session.reused,
              redactions: session.redactions,
            },
          ],
  }
}
