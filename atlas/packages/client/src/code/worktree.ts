// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * A session in a worktree of its own (qmo-local.md §4.3.7): a new branch
 * from the commit the folder's repository is on, checked out under
 * `<client dir>/code/worktrees/<repository>-<8 hex>/<session id>`, never in
 * or beside the person's repository. A folder picked inside the repository
 * is the same folder in the worktree. What is not committed in the picked
 * folder does not come along.
 *
 * Planning is quick and happens before the session is answered: git is
 * there, the folder is in a repository with a commit, the folder is in that
 * commit. Making it (`git worktree add`, the repository's own
 * `post-checkout` hook included, as in a terminal) can take a while on a
 * large repository or a slow hook, so it happens before the first turn, at
 * most five minutes, and a stop ends it. A hook that fails after the
 * checkout is done leaves a worktree that is there and whole, as it would in
 * a terminal: the session goes on and says what git said.
 *
 * Deleting the session removes a clean worktree with `git worktree remove`
 * and leaves its branch, which has the agent's commits; one with changes is
 * left where it is and its path said. Never `--force`.
 */

import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { ensurePrivateDir } from '../secret.js'
import { type GitContext, GitError, run } from './git.js'
import { CodeError } from './protocol.js'

/** `session.json`'s `worktree` (§4.3.6). */
export interface Worktree {
  /** The worktree's own folder. */
  readonly path: string
  readonly branch: string
  /** The commit it was made from: what its changes are against. */
  readonly base: string
  /** The repository's top folder it was made from. */
  readonly repo: string
  /** `git worktree add` has finished. */
  readonly ready: boolean
}

/** `git worktree add` may take this long (checkout and hooks). */
export const WORKTREE_ADD_MS = 5 * 60 * 1000

function hex(text: string, size: number): string {
  return createHash('sha256').update(text).digest('hex').slice(0, size)
}

/** The worktree folder's name for a repository: its own, plainly, with a hash of where it is. */
function repositoryName(top: string): string {
  const name = path
    .basename(top)
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/^[.]+/, '_')
    .slice(0, 40)
  return `${name || 'repo'}-${hex(top, 8)}`
}

/**
 * `qmo/<YYYYMMDD>-<short name>`: the day, the title's first plain words,
 * and four hex digits of the session's id, in `[a-z0-9-]` only, so no two
 * sessions share one even where branch names are not case-sensitive.
 */
export function branchName(
  session: string,
  title: string,
  now: number,
): string {
  const day = new Date(now)
  const date =
    String(day.getFullYear()) +
    String(day.getMonth() + 1).padStart(2, '0') +
    String(day.getDate()).padStart(2, '0')
  const words = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24)
    .replace(/-+$/, '')
  return `qmo/${date}-${words || 'session'}-${hex(session, 4)}`
}

/** git's answer, or a refusal in our words. */
async function asked(
  context: GitContext,
  cwd: string,
  args: readonly string[],
  refusal: string,
  ok: readonly number[] = [0],
): Promise<{ code: number; out: string }> {
  try {
    const answer = await run(context, cwd, args, { ok })
    return { code: answer.code, out: answer.stdout.toString().trim() }
  } catch {
    throw new CodeError('E_GIT', refusal)
  }
}

/**
 * The worktree a new session in `folder` gets, checked and named but not
 * made; and the agent's working folder in it.
 */
export async function planWorktree(input: {
  readonly context: GitContext | undefined
  /** The picked folder, links resolved. */
  readonly folder: string
  /** `<client dir>/code/worktrees`. */
  readonly worktreesDir: string
  readonly session: string
  readonly title: string
  readonly now: number
}): Promise<{ readonly worktree: Worktree; readonly root: string }> {
  const { context, folder } = input
  if (context === undefined)
    throw new CodeError('E_GIT', '这台电脑上没找到 git，开不了独立工作树')
  const where = await asked(
    context,
    folder,
    ['rev-parse', '--show-toplevel', '--show-prefix'],
    '这个文件夹不在 Git 仓库里',
  )
  const [top = '', prefix = ''] = where.out.split('\n')
  if (top === '') throw new CodeError('E_GIT', '这个文件夹不在 Git 仓库里')
  const repo = fs.realpathSync.native(top)
  const head = await asked(
    context,
    folder,
    ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'],
    '仓库还没有提交，开不了独立工作树',
    [0, 1],
  )
  if (head.code !== 0 || !/^[0-9a-f]{40,64}$/.test(head.out))
    throw new CodeError('E_GIT', '仓库还没有提交，开不了独立工作树')
  const inside = prefix.replace(/\/+$/, '')
  if (inside !== '') {
    const kind = await asked(
      context,
      folder,
      ['cat-file', '-t', `${head.out}:${inside}`],
      '选的文件夹不在当前提交里，独立工作树里没有它',
      [0, 128],
    )
    if (kind.out !== 'tree')
      throw new CodeError(
        'E_GIT',
        '选的文件夹不在当前提交里，独立工作树里没有它',
      )
  }
  const at = path.join(input.worktreesDir, repositoryName(repo), input.session)
  return {
    worktree: {
      path: at,
      branch: branchName(input.session, input.title, input.now),
      base: head.out,
      repo,
      ready: false,
    },
    root: inside === '' ? at : path.join(at, ...inside.split('/')),
  }
}

/**
 * `git worktree add -b <branch> <path> <base>` in the repository, as a
 * terminal runs it. Answers what git said when it failed but the worktree is
 * there and whole all the same (a hook that failed after the checkout).
 */
export async function makeWorktree(
  context: GitContext | undefined,
  worktree: Worktree,
  signal: AbortSignal,
  timeoutMs = WORKTREE_ADD_MS,
): Promise<{ readonly warning?: string }> {
  if (context === undefined)
    throw new CodeError('E_GIT', '这台电脑上没找到 git，开不了独立工作树')
  ensurePrivateDir(path.dirname(worktree.path))
  if (fs.existsSync(worktree.path))
    throw new CodeError(
      'E_GIT',
      `${worktree.path} 已经有东西了，可能是上次没建完；删掉这个会话后重开`,
    )
  try {
    await run(
      context,
      worktree.repo,
      ['worktree', 'add', '-b', worktree.branch, worktree.path, worktree.base],
      { timeoutMs, signal, terminal: true },
    )
  } catch (error) {
    if (
      error instanceof GitError &&
      error.ended === 'exit' &&
      (await whole(context, worktree))
    )
      return { warning: error.message }
    throw error
  }
  return {}
}

/** The worktree is checked out on its base, no tracked file missing or changed. */
async function whole(
  context: GitContext,
  worktree: Worktree,
): Promise<boolean> {
  if (!fs.existsSync(worktree.path)) return false
  try {
    const head = await run(context, worktree.path, [
      'rev-parse',
      '--verify',
      'HEAD^{commit}',
    ])
    if (head.stdout.toString().trim() !== worktree.base) return false
    const tracked = await run(context, worktree.path, [
      'status',
      '--porcelain=v2',
      '-z',
      '--untracked-files=no',
    ])
    return tracked.stdout.length === 0
  } catch {
    return false
  }
}

/**
 * A deleted session's worktree: removed when clean (its branch stays),
 * left and named when it has changes or git will not remove it. Nothing
 * there: nothing to say.
 */
export async function removeWorktree(
  context: GitContext | undefined,
  worktree: Worktree,
): Promise<{ readonly worktree?: 'removed' | 'kept'; readonly path?: string }> {
  if (!fs.existsSync(worktree.path)) return {}
  const kept = { worktree: 'kept' as const, path: worktree.path }
  if (context === undefined) return kept
  try {
    const status = await run(context, worktree.path, [
      'status',
      '--porcelain=v2',
      '-z',
      '--untracked-files=all',
    ])
    if (status.stdout.length > 0 || status.truncated) return kept
    await run(context, worktree.repo, ['worktree', 'remove', worktree.path])
  } catch {
    return kept
  }
  if (fs.existsSync(worktree.path)) return kept
  // The repository's folder of worktrees goes with its last one.
  try {
    fs.rmdirSync(path.dirname(worktree.path))
  } catch {}
  return { worktree: 'removed' }
}
