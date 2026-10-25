// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The diff a tool line shows for an edit (qmo-local.md §4.3.5). */

import { describe, expect, test } from 'bun:test'
import { unifiedDiff } from '../../src/code/diff.ts'

describe('unifiedDiff', () => {
  test('nothing changed: nothing shown', () => {
    expect(unifiedDiff('a\nb\n', 'a\nb\n')).toEqual({
      text: '',
      added: 0,
      removed: 0,
    })
  })

  test('one line changed in the middle: three lines of context each side', () => {
    const before = ['1', '2', '3', '4', '5', '6', '7', '8', '9'].join('\n')
    const after = before.replace('5', 'five')
    expect(unifiedDiff(before, after)).toEqual({
      text: [
        '@@ -2,7 +2,7 @@',
        ' 2',
        ' 3',
        ' 4',
        '-5',
        '+five',
        ' 6',
        ' 7',
        ' 8',
      ].join('\n'),
      added: 1,
      removed: 1,
    })
  })

  test('a new file: all added, from line 0', () => {
    expect(unifiedDiff('', 'a\nb\n')).toEqual({
      text: ['@@ -0,0 +1,2 @@', '+a', '+b'].join('\n'),
      added: 2,
      removed: 0,
    })
  })

  test('changes far apart: two hunks; near: one', () => {
    const lines = Array.from({ length: 30 }, (_, n) => String(n + 1))
    const far = [...lines]
    far[1] = 'x'
    far[25] = 'y'
    const text = unifiedDiff(lines.join('\n'), far.join('\n')).text
    expect(text.split('\n').filter(line => line.startsWith('@@'))).toEqual([
      '@@ -1,5 +1,5 @@',
      '@@ -23,7 +23,7 @@',
    ])
    const near = [...lines]
    near[1] = 'x'
    near[7] = 'y'
    expect(
      unifiedDiff(lines.join('\n'), near.join('\n'))
        .text.split('\n')
        .filter(line => line.startsWith('@@')),
    ).toEqual(['@@ -1,11 +1,11 @@'])
  })

  test('past a thousand edits: the middle as removed, then added; counts exact', () => {
    const before = Array.from({ length: 1_500 }, (_, n) => `a${n}`).join('\n')
    const after = Array.from({ length: 1_500 }, (_, n) => `b${n}`).join('\n')
    const diff = unifiedDiff(before, after)
    expect([diff.added, diff.removed]).toEqual([1_500, 1_500])
    expect(diff.text.length).toBeLessThanOrEqual(64 * 1024 + 16)
  })
})
