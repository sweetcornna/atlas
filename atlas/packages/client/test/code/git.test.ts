// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The 「变更」 panel (qmo-local.md §4.3.7) against a real git, in temporary
 * repositories, with no global or system git configuration read.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  type ChangedFile,
  changes,
  diff,
  type GitContext,
} from '../../src/code/git.ts'
import { CodeError } from '../../src/code/protocol.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true })
})

const git = Bun.which('git')
const posix = process.platform !== 'win32'

function repo(): {
  root: string
  work: string
  context: GitContext
  sh: (...args: string[]) => void
} {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'qmo-git-')),
  )
  roots.push(root)
  const work = path.join(root, 'work')
  fs.mkdirSync(work)
  const env = {
    PATH: '/usr/bin:/bin',
    HOME: root,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
  }
  const sh = (...args: string[]) => {
    const done = Bun.spawnSync(
      [
        git!,
        '-c',
        'user.name=t',
        '-c',
        'user.email=t@example.invalid',
        '-c',
        'init.defaultBranch=main',
        ...args,
      ],
      { cwd: work, env, stdout: 'ignore', stderr: 'pipe' },
    )
    if (done.exitCode !== 0) throw new Error(done.stderr.toString())
  }
  sh('init', '-q')
  return { root, work, context: { git: git!, env }, sh }
}

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (error) {
    if (error instanceof CodeError) return error.code
    throw error
  }
  return 'accepted'
}

const write = (file: string, text: string | Uint8Array) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}

describe.skipIf(git === null || !posix)('changes in a Git folder', () => {
  test('before the first commit: against the empty tree', async () => {
    const { work, context, sh } = repo()
    write(path.join(work, 'a.txt'), 'one\ntwo\n')
    sh('add', 'a.txt')
    write(path.join(work, 'b.txt'), 'x')
    const found = await changes(context, work)
    expect(found.base).toBe('4b825dc642cb6eb9a060e54bf8d69288fbee4904')
    expect(found.files).toEqual([
      { path: 'a.txt', status: 'added', added: 2, removed: 0, binary: false },
      {
        path: 'b.txt',
        status: 'untracked',
        added: 1,
        removed: 0,
        binary: false,
      },
    ])
  })

  test('modified, deleted, renamed, untracked and binary; names as they are', async () => {
    const { work, context, sh } = repo()
    write(path.join(work, 'keep.txt'), '1\n2\n3\n')
    write(path.join(work, 'gone.txt'), 'bye\n')
    write(path.join(work, 'old.txt'), 'same\nsame\nsame\n')
    sh('add', '.')
    sh('commit', '-qm', 'first')
    write(path.join(work, 'keep.txt'), '1\nzwei\n3\nvier\n')
    fs.rmSync(path.join(work, 'gone.txt'))
    sh('mv', 'old.txt', 'new.txt')
    write(path.join(work, '新 文件.txt'), '你好\n')
    write(path.join(work, 'pic.bin'), new Uint8Array([0, 1, 2, 0]))
    const found = await changes(context, work)
    expect(found.base).toBe('HEAD')
    expect(found.truncated).toBe(false)
    const expected: ChangedFile[] = [
      {
        path: 'gone.txt',
        status: 'deleted',
        added: 0,
        removed: 1,
        binary: false,
      },
      {
        path: 'keep.txt',
        status: 'modified',
        added: 2,
        removed: 1,
        binary: false,
      },
      {
        path: 'new.txt',
        status: 'renamed',
        added: 0,
        removed: 0,
        binary: false,
      },
      {
        path: 'pic.bin',
        status: 'untracked',
        added: 0,
        removed: 0,
        binary: true,
      },
      {
        path: '新 文件.txt',
        status: 'untracked',
        added: 1,
        removed: 0,
        binary: false,
      },
    ]
    const byPath = (a: ChangedFile, b: ChangedFile) =>
      a.path.localeCompare(b.path)
    expect([...found.files].sort(byPath)).toEqual(expected.sort(byPath))
    const keep = await diff(context, work, 'keep.txt')
    expect(keep).toMatchObject({
      path: 'keep.txt',
      binary: false,
      truncated: false,
    })
    expect(keep.text).toContain('-2\n+zwei\n')
    const fresh = await diff(context, work, '新 文件.txt')
    expect(fresh.text).toContain('+你好')
    expect(await diff(context, work, 'gone.txt')).toMatchObject({
      binary: false,
    })
    expect((await diff(context, work, 'gone.txt')).text).toContain('-bye')
    expect(await diff(context, work, 'pic.bin')).toMatchObject({
      binary: true,
      text: '',
    })
  })

  test('past the limits only counts: a diff over 256 KiB, an untracked file over 1 MiB, files past a thousand', async () => {
    const { work, context, sh } = repo()
    write(path.join(work, 'long.txt'), `a${'字'.repeat(100_000)}\n`)
    sh('add', '.')
    sh('commit', '-qm', 'first')
    write(path.join(work, 'long.txt'), `${'文'.repeat(100_000)}\n`)
    expect(await diff(context, work, 'long.txt')).toEqual({
      path: 'long.txt',
      text: '',
      truncated: true,
      binary: false,
      large: true,
    })
    write(path.join(work, 'huge.log'), 'x\n'.repeat(600_000))
    const found = await changes(context, work)
    expect(found.files.find(one => one.path === 'long.txt')).toEqual({
      path: 'long.txt',
      status: 'modified',
      added: 1,
      removed: 1,
      binary: false,
    })
    expect(found.files.find(one => one.path === 'huge.log')).toEqual({
      path: 'huge.log',
      status: 'untracked',
      added: 0,
      removed: 0,
      binary: false,
      large: true,
    })
    expect(await diff(context, work, 'huge.log')).toMatchObject({
      text: '',
      large: true,
    })
    for (let i = 0; i < 1_003; i++)
      write(path.join(work, 'many', `f${i}.txt`), 'x\n')
    const many = await changes(context, work)
    expect(many.files).toHaveLength(1_000)
    expect(many).toMatchObject({ truncated: true, omitted: 5 })
  })

  test('against a given commit: what was committed since counts, what is in it does not', async () => {
    const { work, context, sh } = repo()
    write(path.join(work, 'a.txt'), '1\n')
    sh('add', '.')
    sh('commit', '-qm', 'first')
    const base = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], {
      cwd: work,
      env: { PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1' },
    })
      .stdout.toString()
      .trim()
    write(path.join(work, 'a.txt'), '1\n2\n')
    write(path.join(work, 'b.txt'), 'b\n')
    sh('add', '.')
    sh('commit', '-qm', 'second')
    write(path.join(work, 'c.txt'), 'c\n')
    expect((await changes(context, work)).files.map(one => one.path)).toEqual([
      'c.txt',
    ])
    const since = await changes(context, work, base)
    expect(since.base).toBe(base)
    expect(since.files).toEqual([
      {
        path: 'a.txt',
        status: 'modified',
        added: 1,
        removed: 0,
        binary: false,
      },
      { path: 'b.txt', status: 'added', added: 1, removed: 0, binary: false },
      {
        path: 'c.txt',
        status: 'untracked',
        added: 1,
        removed: 0,
        binary: false,
      },
    ])
    expect((await diff(context, work, 'a.txt', base)).text).toContain('+2')
    expect((await diff(context, work, 'a.txt')).text).toBe('')
  })

  test('a session in a subfolder sees only its files, relative to itself', async () => {
    const { work, context } = repo()
    write(path.join(work, 'top.txt'), 'x\n')
    write(path.join(work, 'pkg', 'src', 'a.ts'), 'y\n')
    const found = await changes(context, path.join(work, 'pkg'))
    expect(found.files.map(one => one.path)).toEqual(['src/a.ts'])
    expect((await diff(context, path.join(work, 'pkg'), 'src/a.ts')).path).toBe(
      'src/a.ts',
    )
  })

  test('a path through a link out of the folder is refused; a folder that is not Git has none', async () => {
    const { root, work, context } = repo()
    fs.mkdirSync(path.join(root, 'outside'))
    write(path.join(root, 'outside', 'secret'), 's')
    fs.symlinkSync(path.join(root, 'outside'), path.join(work, 'out'))
    expect(await refusal(diff(context, work, 'out/secret'))).toBe('E_ARGS')
    const plain = path.join(root, 'plain')
    fs.mkdirSync(plain)
    expect(await changes(context, plain)).toEqual({
      source: 'session',
      files: [],
      truncated: false,
    })
    expect(await refusal(diff(context, plain, 'a'))).toBe('E_GIT')
  })
})
