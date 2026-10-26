// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The 「变更」 panel of a session in a folder that is not Git, or where git
 * is not installed (qmo-local.md §4.3.7): what the session's own tool lines
 * say was changed, never the disk. A file is listed when a tool line that
 * carries a diff (`detailKind: 'diff'`) finished (`done`) on it, with the
 * path inside the session's root; denied, failed and running ones changed
 * nothing yet. Its counts are the tool lines' own (exact even where a
 * line's detail was cut at 16 KiB); its diff is their diffs one after
 * another, so a hunk's line numbers are those of the edit's own text, not
 * of the file. Whether a file is new or gone is read from its first diff:
 * `@@ -0,0` is a new file, `+0,0 @@` an emptied one; anything else is a
 * change. That holds for every agent's diffs, not only Claude Code's.
 */

import * as path from 'node:path'
import type { ChangedFile, ChangeStatus, Changes, FileDiff } from './git.js'
import { CodeError, type CodeTurn } from './protocol.js'
import { DIFF_CUT } from './store.js'

/** As the Git panel: at most this many files, a diff over this not shown. */
const MAX_FILES = 1_000
const MAX_DIFF_BYTES = 256 * 1024

interface Edit {
  readonly text: string
  readonly added: number
  readonly removed: number
}

/** Lines that start with `+` or `-` in a hunk (not a `+++` / `---` header). */
function counted(text: string): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const line of text.split('\n')) {
    if (/^\+(?!\+\+ )/.test(line)) added++
    else if (/^-(?!-- )/.test(line)) removed++
  }
  return { added, removed }
}

function statusOf(first: string): ChangeStatus {
  const head = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/m.exec(first)
  if (head === null) return 'modified'
  if (head[1] === '0' && head[2] === '0') return 'added'
  if (head[3] === '0' && head[4] === '0') return 'deleted'
  return 'modified'
}

/** Each file's edits, in the order the session first touched it. */
function editsOf(turns: readonly CodeTurn[]): Map<string, Edit[]> {
  const out = new Map<string, Edit[]>()
  for (const turn of turns) {
    const tool = turn.tool
    if (
      tool === undefined ||
      tool.detailKind !== 'diff' ||
      tool.status !== 'done' ||
      tool.paths === undefined
    )
      continue
    const inside = tool.paths.filter(
      one =>
        one !== '' &&
        !path.isAbsolute(one) &&
        !path.win32.isAbsolute(one) &&
        !one.split(/[\\/]/).includes('..'),
    )
    const text = turn.detail ?? ''
    // One path: the counts are its own. Several (one tool line over many
    // files): each is listed, with the whole line's diff and no counts.
    const own = inside.length === 1
    const counts =
      own && tool.added !== undefined && tool.removed !== undefined
        ? { added: tool.added, removed: tool.removed }
        : own
          ? counted(text)
          : { added: 0, removed: 0 }
    for (const file of inside) {
      const edits = out.get(file) ?? []
      edits.push({ text, ...counts })
      out.set(file, edits)
    }
  }
  return out
}

/** The files the session's records say it changed. */
export function recordedChanges(turns: readonly CodeTurn[]): Changes {
  const edits = editsOf(turns)
  const files: ChangedFile[] = []
  for (const [file, list] of edits) {
    if (files.length >= MAX_FILES) break
    files.push({
      path: file,
      status: statusOf(list[0]?.text ?? ''),
      added: list.reduce((sum, one) => sum + one.added, 0),
      removed: list.reduce((sum, one) => sum + one.removed, 0),
      binary: false,
    })
  }
  const omitted = edits.size - files.length
  return {
    source: 'session',
    files,
    truncated: omitted > 0,
    ...(omitted > 0 ? { omitted } : {}),
  }
}

/** One file's diff as the session's records have it. */
export function recordedDiff(
  turns: readonly CodeTurn[],
  relative: string,
): FileDiff {
  const list = editsOf(turns).get(relative)
  if (list === undefined)
    throw new CodeError('E_ARGS', '这个会话的记录里没有改过这个文件')
  const text = list
    .map(one => one.text)
    .filter(one => one !== '')
    .join('\n')
  if (Buffer.byteLength(text) > MAX_DIFF_BYTES)
    return {
      path: relative,
      text: '',
      truncated: true,
      binary: false,
      large: true,
    }
  return {
    path: relative,
    text,
    truncated: list.some(one => one.text.endsWith(DIFF_CUT)),
    binary: false,
  }
}
