// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The 「变更」 panel of a session outside Git from what the agent reported
 * (qmo-local.md §4.3.7): Codex's last `turn/diff/updated`, a unified diff of
 * the turn's files in Git's form (`diff --git a/… b/…`, `---`, `+++`, hunks).
 * Read from the record only, never from the disk. Paths are the session
 * root's: an absolute one inside it is made relative, one outside it is left
 * out (the panel names files under the root only).
 */

import * as path from 'node:path'
import type { ChangedFile, Changes, ChangeStatus, FileDiff } from './git.js'
import { within } from './paths.js'

/** What `session.json`'s neighbour `turn-diff.json` keeps: the last one. */
export interface KeptTurnDiff {
  readonly at: number
  readonly diff: string
  /** Kept only in part: it was larger than the store takes. */
  readonly truncated: boolean
}

interface Section {
  readonly file: ChangedFile
  readonly text: string
}

/** `a/x` or `b/x` as Git writes it, without the side; `undefined` for `/dev/null`. */
function sidePath(raw: string): string | undefined {
  const trimmed = raw.replace(/\t.*$/, '').trim()
  if (trimmed === '/dev/null') return undefined
  return trimmed.replace(/^[ab]\//, '')
}

/** A reported path under the root, `/` between parts; `undefined` outside it. */
function underRoot(root: string, file: string): string | undefined {
  const absolute = path.isAbsolute(file) ? file : path.join(root, file)
  if (!within(path.resolve(absolute), path.resolve(root))) return undefined
  const relative = path.relative(root, absolute).split(path.sep).join('/')
  return relative === '' ? undefined : relative
}

function sectionOf(
  root: string,
  lines: readonly string[],
): Section | undefined {
  let from: string | undefined
  let to: string | undefined
  let header: string | undefined
  let status: ChangeStatus = 'modified'
  let binary = false
  let added = 0
  let removed = 0
  let inHunk = false
  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      const match = /^diff --git (\S+) (\S+)$/.exec(line)
      header = match === null ? undefined : sidePath(match[2]!)
    } else if (!inHunk && line.startsWith('--- '))
      from = sidePath(line.slice(4))
    else if (!inHunk && line.startsWith('+++ ')) to = sidePath(line.slice(4))
    else if (!inHunk && line.startsWith('new file mode')) status = 'added'
    else if (!inHunk && line.startsWith('deleted file mode')) status = 'deleted'
    else if (!inHunk && line.startsWith('rename from')) status = 'renamed'
    else if (
      /^Binary files .* differ$/.test(line) ||
      line === 'GIT binary patch'
    )
      binary = true
    else if (line.startsWith('@@')) inHunk = true
    else if (inHunk && line.startsWith('+')) added++
    else if (inHunk && line.startsWith('-')) removed++
  }
  if (status === 'modified' && from === undefined && to !== undefined)
    status = 'added'
  if (status === 'modified' && to === undefined && from !== undefined)
    status = 'deleted'
  const reported = to ?? from ?? header
  if (reported === undefined) return undefined
  const shown = underRoot(root, reported)
  if (shown === undefined) return undefined
  return {
    file: {
      path: shown,
      status,
      added: binary ? 0 : added,
      removed: binary ? 0 : removed,
      binary,
    },
    text: `${lines.join('\n')}\n`,
  }
}

/** The diff by file, in its order. */
function sections(root: string, diff: string): Section[] {
  const out: Section[] = []
  let current: string[] = []
  const flush = () => {
    const section = current.length === 0 ? undefined : sectionOf(root, current)
    if (section !== undefined) out.push(section)
    current = []
  }
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) flush()
    current.push(line)
  }
  if (current.at(-1) === '') current.pop()
  flush()
  return out
}

/** The panel's list; `undefined` when nothing was kept or nothing in it is under the root. */
export function turnDiffChanges(
  kept: KeptTurnDiff | undefined,
  root: string,
): Changes | undefined {
  if (kept === undefined) return undefined
  const files = sections(root, kept.diff).map(one => one.file)
  if (files.length === 0) return undefined
  return { source: 'session', files, truncated: kept.truncated }
}

/** One file's part of the kept diff; `undefined` when it has none. */
export function turnDiffFile(
  kept: KeptTurnDiff | undefined,
  root: string,
  relative: string,
): FileDiff | undefined {
  if (kept === undefined) return undefined
  const found = sections(root, kept.diff).find(
    one => one.file.path === relative,
  )
  if (found === undefined) return undefined
  return {
    path: found.file.path,
    text: found.file.binary ? '' : found.text,
    truncated: kept.truncated,
    binary: found.file.binary,
  }
}
