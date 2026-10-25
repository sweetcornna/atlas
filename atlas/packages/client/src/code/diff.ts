// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * A unified diff of two texts, for a tool line whose input says what it
 * changes (Claude Code's `Edit`, `MultiEdit`, `Write`; qmo-local.md §4.3.5):
 * hunks only (`@@`, ` `, `-`, `+` lines, no `---`/`+++` header), three lines
 * of context, and the counts of added and removed lines.
 */

export interface UnifiedDiff {
  readonly text: string
  readonly added: number
  readonly removed: number
}

/** Past this many edits the middle is shown as all removed, then all added. */
const MAX_EDITS = 1_000
/** The text stops growing here; the counts stay exact (the record keeps 16 KiB). */
const MAX_TEXT = 64 * 1024
const CONTEXT = 3

type Op = readonly [' ' | '-' | '+', string]

function lines(text: string): string[] {
  if (text === '') return []
  const all = text.split('\n')
  if (all[all.length - 1] === '') all.pop()
  return all
}

/**
 * Myers' shortest edit script between `a` and `b`, or `null` when it takes
 * more than {@link MAX_EDITS} edits.
 */
function myers(a: readonly string[], b: readonly string[]): Op[] | null {
  const n = a.length
  const m = b.length
  const max = Math.min(n + m, MAX_EDITS)
  const offset = max + 1
  const v = new Int32Array(2 * max + 3)
  const trace: Int32Array[] = []
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice())
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)
          ? v[offset + k + 1]!
          : v[offset + k - 1]! + 1
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) {
        x++
        y++
      }
      v[offset + k] = x
      if (x >= n && y >= m) return backtrack(a, b, trace, d, offset)
    }
  }
  return null
}

function backtrack(
  a: readonly string[],
  b: readonly string[],
  trace: readonly Int32Array[],
  depth: number,
  offset: number,
): Op[] {
  const ops: Op[] = []
  let x = a.length
  let y = b.length
  for (let d = depth; d > 0; d--) {
    const v = trace[d]!
    const k = x - y
    const down =
      k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)
    const prevK = down ? k + 1 : k - 1
    const prevX = v[offset + prevK]!
    const prevY = prevX - prevK
    while (x > prevX && y > prevY) {
      x--
      y--
      ops.push([' ', a[x]!])
    }
    if (down) {
      y--
      ops.push(['+', b[y]!])
    } else {
      x--
      ops.push(['-', a[x]!])
    }
  }
  while (x > 0 && y > 0) {
    x--
    y--
    ops.push([' ', a[x]!])
  }
  return ops.reverse()
}

/** The edit script of two line lists, the common start and end kept apart. */
function script(a: readonly string[], b: readonly string[]): Op[] {
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let end = 0
  while (
    end < a.length - start &&
    end < b.length - start &&
    a[a.length - 1 - end] === b[b.length - 1 - end]
  )
    end++
  const midA = a.slice(start, a.length - end)
  const midB = b.slice(start, b.length - end)
  const middle = myers(midA, midB) ?? [
    ...midA.map((line): Op => ['-', line]),
    ...midB.map((line): Op => ['+', line]),
  ]
  return [
    ...a.slice(0, start).map((line): Op => [' ', line]),
    ...middle,
    ...a.slice(a.length - end).map((line): Op => [' ', line]),
  ]
}

export function unifiedDiff(before: string, after: string): UnifiedDiff {
  const ops = script(lines(before), lines(after))
  let added = 0
  let removed = 0
  for (const [kind] of ops)
    if (kind === '+') added++
    else if (kind === '-') removed++
  const out: string[] = []
  let size = 0
  let i = 0
  // Old and new line numbers of ops[i], 1-based.
  let oldLine = 1
  let newLine = 1
  while (i < ops.length && size < MAX_TEXT) {
    if (ops[i]![0] === ' ') {
      oldLine++
      newLine++
      i++
      continue
    }
    // A hunk: up to CONTEXT lines before, through the last change that is
    // within 2 * CONTEXT unchanged lines of the next.
    const lead = Math.min(CONTEXT, i)
    const from = i - lead
    const hunkOld = oldLine - lead
    const hunkNew = newLine - lead
    let to = i
    for (let j = i; j < ops.length; j++) {
      if (ops[j]![0] !== ' ') {
        to = j
        continue
      }
      if (j - to > 2 * CONTEXT) break
    }
    const stop = Math.min(ops.length, to + 1 + CONTEXT)
    let oldCount = 0
    let newCount = 0
    const body: string[] = []
    for (let j = from; j < stop; j++) {
      const [kind, line] = ops[j]!
      if (kind !== '+') oldCount++
      if (kind !== '-') newCount++
      body.push(`${kind}${line}`)
    }
    const head = `@@ -${oldCount === 0 ? hunkOld - 1 : hunkOld},${oldCount} +${
      newCount === 0 ? hunkNew - 1 : hunkNew
    },${newCount} @@`
    for (const line of [head, ...body]) {
      out.push(line)
      size += line.length + 1
    }
    oldLine = hunkOld + oldCount
    newLine = hunkNew + newCount
    i = stop
  }
  return { text: out.join('\n'), added, removed }
}
