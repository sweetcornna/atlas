// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Where a session may be and what it may name (qmo-local.md §4.3.2,
 * §4.3.7): the picked folder, links resolved, outside every agent's own
 * configuration and the client's folder; a relative path in a request,
 * checked before it reaches the disk, and kept under the session's root
 * through links and deleted files.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  checkPickedFolder,
  guardedRoots,
  resolveInRoot,
  within,
} from '../../src/code/paths.ts'
import { CodeError, relativePathOf } from '../../src/code/protocol.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true })
})

function tmp(): string {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'qmo-paths-')),
  )
  roots.push(root)
  return root
}

function refusal(run: () => unknown): string {
  try {
    run()
  } catch (error) {
    if (error instanceof CodeError) return error.code
    throw error
  }
  return 'accepted'
}

const posix = process.platform !== 'win32'

describe('paths', () => {
  test('within: segment by segment; Windows folds case', () => {
    expect(within('/a/b', '/a')).toBe(true)
    expect(within('/a', '/a')).toBe(true)
    expect(within('/ab', '/a')).toBe(false)
    expect(within('/a/../b', '/a')).toBe(false)
    expect(
      within('C:\\Users\\Me\\.Claude\\x', 'c:\\users\\me\\.claude', 'win32'),
    ).toBe(true)
    expect(within('D:\\x', 'C:\\x', 'win32')).toBe(false)
  })

  test('relative paths in a request: no absolute, no option, no empty, `.` or `..` part', () => {
    expect(relativePathOf('src/app.ts', 'linux')).toBe('src/app.ts')
    expect(relativePathOf('src\\app.ts', 'win32')).toBe('src/app.ts')
    for (const bad of [
      '',
      '/etc/passwd',
      '-rf',
      'a//b',
      './a',
      'a/../b',
      '..',
      'a\nb',
      'x'.repeat(1_025),
      7,
    ])
      expect(refusal(() => relativePathOf(bad, 'linux'))).toBe('E_ARGS')
    expect(refusal(() => relativePathOf('C:x', 'win32'))).toBe('E_ARGS')
    expect(refusal(() => relativePathOf('a\\..\\b', 'win32'))).toBe('E_ARGS')
  })

  test.skipIf(!posix)(
    'a picked folder: refused in every agent’s configuration and the client’s own, as named or linked',
    () => {
      const root = tmp()
      const home = path.join(root, 'home')
      const client = path.join(root, 'client')
      const work = path.join(home, 'work')
      for (const dir of [
        work,
        client,
        path.join(home, '.claude', 'projects'),
        path.join(home, '.gemini', 'x'),
      ])
        fs.mkdirSync(dir, { recursive: true })
      const named = guardedRoots(client, home)
      for (const one of [
        '.claude',
        '.codex',
        '.omp',
        '.qianmo',
        '.gemini',
        '.qwen',
        '.dsh',
      ])
        expect(named).toContain(path.join(home, one))
      expect(named).toContain(path.join(home, '.config', 'opencode'))
      expect(named).toContain(client)
      // Accepted: a folder, and the home folder itself (a parent of guarded ones).
      expect(checkPickedFolder(work, client, home)).toBe(work)
      expect(checkPickedFolder(home, client, home)).toBe(home)
      // Refused: guarded, as named and through a link; not absolute, gone, a file.
      const link = path.join(work, 'into-claude')
      fs.symlinkSync(path.join(home, '.claude', 'projects'), link)
      const file = path.join(work, 'file')
      fs.writeFileSync(file, '')
      for (const bad of [
        path.join(home, '.claude', 'projects'),
        path.join(home, '.gemini', 'x'),
        client,
        link,
        'work',
        path.join(root, 'gone'),
        file,
      ])
        expect(refusal(() => checkPickedFolder(bad, client, home))).toBe(
          'E_FOLDER',
        )
    },
  )

  test.skipIf(!posix)(
    'a path under a session’s root: links resolved, a deleted file through its folder, nothing outside',
    () => {
      const root = tmp()
      const work = path.join(root, 'work')
      fs.mkdirSync(path.join(work, 'src'), { recursive: true })
      fs.writeFileSync(path.join(work, 'src', 'a.ts'), '')
      fs.mkdirSync(path.join(root, 'outside'))
      fs.symlinkSync(path.join(root, 'outside'), path.join(work, 'out'))
      fs.symlinkSync('src', path.join(work, 'alias'))
      expect(resolveInRoot(work, 'src/a.ts')).toEqual({
        file: path.join(work, 'src', 'a.ts'),
        relative: 'src/a.ts',
      })
      expect(resolveInRoot(work, 'alias/a.ts').relative).toBe('src/a.ts')
      expect(resolveInRoot(work, 'src/deleted/b.ts')).toEqual({
        file: path.join(work, 'src', 'deleted', 'b.ts'),
        relative: 'src/deleted/b.ts',
      })
      expect(refusal(() => resolveInRoot(work, 'out/secret'))).toBe('E_ARGS')
      expect(refusal(() => resolveInRoot(path.join(root, 'gone'), 'a'))).toBe(
        'E_FOLDER',
      )
    },
  )
})
