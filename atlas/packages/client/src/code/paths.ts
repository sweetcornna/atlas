// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Paths come in one way only (qmo-local.md §4.5.3): the folder the shell's
 * native dialog picked. A page names a folder by its id and a file under a
 * session's root by a relative path, which is checked here before it reaches
 * the disk or a git command. This limits 阡陌's own code; what an agent may
 * touch is the agent's own permissions and sandbox (§4.4).
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  agentConfigRoots,
  claudeConfigDir,
  protectedConfigRoots,
} from '@qianmo/paths'
import { CodeError } from './protocol.js'

function real(file: string): string | undefined {
  try {
    return fs.realpathSync.native(file)
  } catch {
    return undefined
  }
}

/** Whether `child` is `parent` or inside it, segment by segment. */
export function within(
  child: string,
  parent: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const flavour = platform === 'win32' ? path.win32 : path.posix
  const fold = (one: string) => (platform === 'win32' ? one.toLowerCase() : one)
  const rel = flavour.relative(fold(parent), fold(child))
  return (
    rel === '' ||
    (rel !== '..' &&
      !rel.startsWith(`..${flavour.sep}`) &&
      !flavour.isAbsolute(rel))
  )
}

/**
 * The folders no session may be in: the protected roots (`~/.qianmo`,
 * `~/.omp`, `~/.claude`, `~/.codex`, `~/.qmcode`, the config root), Claude
 * Code's configured one, the other agents' own (`~/.gemini`, `~/.qwen`,
 * `~/.config/opencode`, `~/.dsh`) and the client's own folder; each as named
 * and as its links resolve.
 */
export function guardedRoots(clientDir: string, home?: string): string[] {
  const named = [
    ...protectedConfigRoots(home),
    claudeConfigDir(process.env, home),
    ...agentConfigRoots(home),
    clientDir,
  ]
  const out = new Set<string>()
  for (const root of named) {
    out.add(path.resolve(root))
    const resolved = real(root)
    if (resolved !== undefined) out.add(resolved)
  }
  return [...out]
}

/**
 * The picked folder as its links resolve. Refused: missing, not a folder, not
 * readable, or in a guarded root (its parents, the home folder among them,
 * may be picked).
 */
export function checkPickedFolder(
  picked: string,
  clientDir: string,
  home?: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (!path.isAbsolute(picked))
    throw new CodeError('E_FOLDER', '选的路径不是绝对路径')
  const resolved = real(picked)
  if (resolved === undefined)
    throw new CodeError('E_FOLDER', '选的文件夹不在了')
  let stat: fs.Stats
  try {
    stat = fs.statSync(resolved)
  } catch {
    throw new CodeError('E_FOLDER', '选的文件夹读不了')
  }
  if (!stat.isDirectory()) throw new CodeError('E_FOLDER', '选的不是文件夹')
  try {
    fs.accessSync(resolved, fs.constants.R_OK | fs.constants.X_OK)
  } catch {
    throw new CodeError('E_FOLDER', '选的文件夹读不了')
  }
  for (const root of guardedRoots(clientDir, home))
    if (within(resolved, root, platform))
      throw new CodeError(
        'E_FOLDER',
        `${root} 是受保护的目录，里面的文件夹不能选`,
      )
  return resolved
}

/** A session's root as its links resolve; gone, it can only be read. */
export function sessionRoot(root: string): string {
  const resolved = real(root)
  if (resolved === undefined || !fs.statSync(resolved).isDirectory())
    throw new CodeError('E_FOLDER', '文件夹不在了')
  return resolved
}

/**
 * Whether `file` (absolute, or relative to `root`) is in `root` as links
 * resolve: a file not there yet by its nearest folder that is. For the
 * runner's own answers to an agent's questions (§4.4): an edit it allows
 * must stay in the session's folder.
 */
export function insideRoot(
  root: string,
  file: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const top = real(root)
  if (top === undefined || file === '' || file.includes('\0')) return false
  let probe = path.resolve(top, file)
  const rest: string[] = []
  for (;;) {
    const found = real(probe)
    if (found !== undefined)
      return within(path.join(found, ...rest.reverse()), top, platform)
    const parent = path.dirname(probe)
    if (parent === probe) return false
    rest.push(path.basename(probe))
    probe = parent
  }
}

/**
 * A checked relative path (`relativePathOf`) under a session's root: where
 * it is, links resolved (a deleted file through its nearest folder that is
 * still there), and the same relative to the resolved root. Leaving the
 * root, through `..` or a link, is refused.
 */
export function resolveInRoot(
  root: string,
  relative: string,
  platform: NodeJS.Platform = process.platform,
): { readonly file: string; readonly relative: string } {
  const top = sessionRoot(root)
  const parts = relative.split('/')
  let found: string | undefined
  let rest: string[] = []
  for (let cut = parts.length; cut >= 0 && found === undefined; cut--) {
    found = real(path.join(top, ...parts.slice(0, cut)))
    rest = parts.slice(cut)
  }
  const file = path.join(found ?? top, ...rest)
  if (!within(file, top, platform))
    throw new CodeError('E_ARGS', '这个路径不在会话的文件夹里')
  return {
    file,
    relative: path.relative(top, file).split(path.sep).join('/'),
  }
}
