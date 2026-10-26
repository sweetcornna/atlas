// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Sessions in a worktree of their own, renaming and deleting (qmo-local.md
 * §4.3.6, §4.3.7, P37.14d), on the runner in this process with the fake
 * Claude Code. Every repository is made here, in a temporary folder, with no
 * global or system git configuration; nothing outside the box is touched.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  begin,
  type Box,
  box,
  cleanBoxes,
  type Message,
  pick,
  Refused,
  startRunner,
  type TestRunner,
} from './helpers.ts'

const git = Bun.which('git')
const posix = process.platform !== 'win32'
const running: TestRunner[] = []

afterEach(async () => {
  for (const runner of running.splice(0)) await runner.stop()
  cleanBoxes()
})

function runner(at: Box, options: Parameters<typeof startRunner>[1] = {}) {
  const started = startRunner(at, options)
  running.push(started)
  return started
}

async function refused(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (error) {
    if (error instanceof Refused) return error.code
    throw error
  }
  throw new Error('not refused')
}

/** git in `cwd`, as the test's own hand (an agent's commit, the main checkout moving on). */
function sh(at: Box, cwd: string, ...args: string[]): string {
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
    {
      cwd,
      env: {
        PATH: '/usr/bin:/bin',
        HOME: at.home,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )
  if (done.exitCode !== 0)
    throw new Error(`git ${args.join(' ')}: ${done.stderr.toString()}`)
  return done.stdout.toString()
}

const write = (file: string, text: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}

/** `at.work` as a repository with `files` in its first commit. */
function repository(at: Box, files: Record<string, string>): string {
  sh(at, at.work, 'init', '-q')
  for (const [name, text] of Object.entries(files))
    write(path.join(at.work, name), text)
  sh(at, at.work, 'add', '.')
  sh(at, at.work, 'commit', '-qm', 'first')
  return sh(at, at.work, 'rev-parse', 'HEAD').trim()
}

/** A `post-checkout` hook: `body` after a line that logs where it ran. */
function hook(at: Box, body = ''): string {
  const log = path.join(at.state, 'hook.log')
  const file = path.join(at.work, '.git', 'hooks', 'post-checkout')
  write(file, `#!/bin/sh\necho "$PWD $3" >> '${log}'\n${body}\n`)
  fs.chmodSync(file, 0o755)
  return log
}

function header(at: Box, id: string): Message {
  return JSON.parse(
    fs.readFileSync(path.join(at.code, 'sessions', id, 'session.json'), 'utf8'),
  ) as Message
}

async function startIn(
  r: TestRunner,
  folder: string,
  text: string,
  mode = 'accept-edits',
): Promise<string> {
  const started = await r.call('session.start', {
    folder,
    agent: 'claude-code',
    mode,
    worktree: true,
    text,
    clientId: 'c1',
  })
  return String((started.session as Message).id)
}

describe.skipIf(git === null || !posix)(
  'a session in a worktree of its own',
  () => {
    test('made before its turn from HEAD, the hook run there, the main checkout untouched; a clean one is removed on delete', async () => {
      const at = box()
      const base = repository(at, { 'notes.md': 'one\n' })
      const log = hook(at)
      const r = runner(at)
      const folder = await pick(r, at.work)
      const mark = r.mark
      const started = await r.call('session.start', {
        folder,
        agent: 'claude-code',
        mode: 'auto',
        worktree: true,
        text: 'Hello, worktree!',
        clientId: 'c1',
      })
      const summary = started.session as Message
      const id = String(summary.id)
      expect(summary.worktree).toEqual({
        branch: expect.stringMatching(
          /^qmo\/\d{8}-hello-worktree-[0-9a-f]{4}$/,
        ),
      })
      await r.event(
        one => one.type === 'activity' && one.words === '正在建独立工作树',
        10_000,
        mark,
      )
      await r.state(id, 'idle', mark)
      const kept = header(at, id)
      const worktree = kept.worktree as Message
      expect(worktree).toEqual({
        path: expect.stringMatching(
          new RegExp(
            `^${path.join(at.code, 'worktrees')}/work-[0-9a-f]{8}/${id}$`,
          ),
        ),
        branch: (summary.worktree as Message).branch,
        base,
        repo: at.work,
        ready: true,
      })
      const where = String(worktree.path)
      expect(kept.root).toBe(where)
      expect(fs.readFileSync(path.join(where, 'notes.md'), 'utf8')).toBe(
        'one\n',
      )
      // The repository's own hook ran, in the worktree, as for a branch checkout.
      expect(fs.readFileSync(log, 'utf8').trim()).toBe(`${where} 1`)
      // The main checkout shows nothing new; git knows the worktree and its branch.
      expect(sh(at, at.work, 'status', '--porcelain')).toBe('')
      expect(sh(at, at.work, 'worktree', 'list', '--porcelain')).toContain(
        `worktree ${where}\n`,
      )
      expect(
        sh(at, at.work, 'rev-parse', `refs/heads/${worktree.branch}`).trim(),
      ).toBe(base)
      expect(await r.call('session.changes', { session: id })).toEqual({
        source: 'git',
        base,
        files: [],
        truncated: false,
      })
      // Deleted: the clean worktree goes, its branch stays, the records go.
      const before = r.mark
      expect(await r.call('session.delete', { session: id })).toEqual({
        worktree: 'removed',
      })
      expect(fs.existsSync(where)).toBe(false)
      expect(fs.existsSync(path.dirname(where))).toBe(false)
      expect(sh(at, at.work, 'worktree', 'list', '--porcelain')).not.toContain(
        where,
      )
      expect(
        sh(at, at.work, 'rev-parse', `refs/heads/${worktree.branch}`).trim(),
      ).toBe(base)
      expect(fs.existsSync(path.join(at.code, 'sessions', id))).toBe(false)
      await r.event(
        one => one.type === 'removed' && one.session === id,
        5_000,
        before,
      )
      expect((await r.call('list')).sessions).toEqual([])
      expect(await refused(r.call('session.read', { session: id }))).toBe(
        'E_SESSION',
      )
      expect(sh(at, at.work, 'status', '--porcelain')).toBe('')
    }, 30_000)

    test('changes are against its base, the agent’s commits too, whatever the main checkout does; one with changes is kept on delete', async () => {
      const at = box()
      const base = repository(at, { 'notes.md': 'one\n' })
      const r = runner(at)
      const folder = await pick(r, at.work)
      const id = await startIn(r, folder, 'edit notes.md')
      await r.state(id, 'idle')
      const where = String((header(at, id).worktree as Message).path)
      // The agent edited the worktree's copy; the main checkout's is as it was.
      expect(fs.readFileSync(path.join(where, 'notes.md'), 'utf8')).toBe(
        'one\nedited\n',
      )
      expect(fs.readFileSync(path.join(at.work, 'notes.md'), 'utf8')).toBe(
        'one\n',
      )
      expect(sh(at, at.work, 'status', '--porcelain')).toBe('')
      // The agent commits a file in its worktree; the main checkout moves on.
      write(path.join(where, 'b.txt'), 'b\n')
      sh(at, where, 'add', 'b.txt')
      sh(at, where, 'commit', '-qm', 'agent')
      write(path.join(at.work, 'c.txt'), 'c\n')
      sh(at, at.work, 'add', 'c.txt')
      sh(at, at.work, 'commit', '-qm', 'main moved')
      const changes = await r.call('session.changes', { session: id })
      expect(changes.base).toBe(base)
      const files = (changes.files as Message[]).sort((a, b) =>
        String(a.path).localeCompare(String(b.path)),
      )
      expect(files).toEqual([
        { path: 'b.txt', status: 'added', added: 1, removed: 0, binary: false },
        {
          path: 'notes.md',
          status: 'modified',
          added: 1,
          removed: 0,
          binary: false,
        },
      ])
      expect(
        String(
          (await r.call('session.diff', { session: id, path: 'b.txt' })).text,
        ),
      ).toContain('+b')
      expect(
        String(
          (await r.call('session.diff', { session: id, path: 'notes.md' }))
            .text,
        ),
      ).toContain('+edited')
      // Not clean: left where it is, and said where.
      expect(await r.call('session.delete', { session: id })).toEqual({
        worktree: 'kept',
        path: where,
      })
      expect(fs.readFileSync(path.join(where, 'notes.md'), 'utf8')).toBe(
        'one\nedited\n',
      )
      expect(fs.existsSync(path.join(at.code, 'sessions', id))).toBe(false)
    }, 30_000)

    test('a folder inside the repository is the same folder in the worktree; one never committed, or a repository with no commit, is refused', async () => {
      const at = box()
      repository(at, { 'pkg/a.txt': 'a\n', 'top.txt': 't\n' })
      const r = runner(at)
      const pkg = await pick(r, path.join(at.work, 'pkg'))
      const id = await startIn(r, pkg, 'edit a.txt')
      await r.state(id, 'idle')
      const kept = header(at, id)
      const where = String((kept.worktree as Message).path)
      expect(kept.root).toBe(path.join(where, 'pkg'))
      expect(fs.readFileSync(path.join(where, 'pkg', 'a.txt'), 'utf8')).toBe(
        'a\nedited\n',
      )
      expect(
        (
          (await r.call('session.changes', { session: id })).files as Message[]
        ).map(one => one.path),
      ).toEqual(['a.txt'])
      // Not in the commit: the worktree would not have it.
      write(path.join(at.work, 'fresh', 'x.txt'), 'x\n')
      const fresh = await pick(r, path.join(at.work, 'fresh'))
      expect(await refused(startIn(r, fresh, 'hi'))).toBe('E_GIT')
      // No commit yet.
      const empty = path.join(at.root, 'empty')
      fs.mkdirSync(empty)
      sh(at, empty, 'init', '-q')
      expect(await refused(startIn(r, await pick(r, empty), 'hi'))).toBe(
        'E_GIT',
      )
      // Nothing was made for the refused ones.
      expect(fs.readdirSync(path.join(at.code, 'worktrees'))).toHaveLength(1)
    }, 30_000)

    test('a hook that fails after the checkout: the session goes on and says so; one that hangs is ended by a stop, or fails the turn past its time', async () => {
      const at = box()
      repository(at, { 'notes.md': 'one\n' })
      hook(at, 'echo "hook says no" >&2\nexit 3')
      const r = runner(at)
      const folder = await pick(r, at.work)
      const id = await startIn(r, folder, 'hello')
      await r.state(id, 'idle')
      expect(header(at, id).worktree).toMatchObject({ ready: true })
      const notice = r
        .turns(id)
        .find(one => String(one.text).startsWith('独立工作树建好了'))
      expect(notice).toMatchObject({ severity: 'warn' })
      expect(String(notice?.text)).toContain('hook says no')
      expect(
        r.turns(id).some(one => String(one.text).startsWith('echo(')),
      ).toBe(true)

      // A hook that hangs, stopped while the worktree is made.
      const pidFile = path.join(at.state, 'hook.pid')
      hook(at, `echo $$ > '${pidFile}'\nexec /bin/sleep 30`)
      const slow = await startIn(r, folder, 'hello again')
      await r.event(
        one =>
          one.type === 'activity' &&
          one.session === slow &&
          one.words === '正在建独立工作树',
      )
      // The hook is running.
      await r.until(() => (fs.existsSync(pidFile) ? true : undefined))
      const mark = r.mark
      const asked = Date.now()
      await r.call('session.stop', { session: slow })
      await r.state(slow, 'interrupted', mark)
      expect(Date.now() - asked).toBeLessThan(5_000)
      expect(
        r.turns(slow).some(one => String(one.text).startsWith('没能建')),
      ).toBe(false)
      // The hook went with git: its process group was ended.
      const pid = Number(fs.readFileSync(pidFile, 'utf8').trim())
      await r.until(() => {
        try {
          process.kill(pid, 0)
          return undefined
        } catch {
          return true
        }
      }, 3_000)

      // Past its time: the turn fails, saying so; the line behind it is withdrawn.
      await r.stop()
      running.splice(0)
      const quick = runner(at, { limits: { worktreeMs: 300 } })
      const late = await startIn(quick, await pick(quick, at.work), 'third')
      const behind = await quick.call('session.send', {
        session: late,
        text: 'fourth',
        clientId: 'c2',
        origin: 'local',
      })
      expect(behind.queued).toBe(true)
      await quick.state(late, 'failed')
      const failed = quick
        .turns(late)
        .find(one => one.author === 'agent' && one.state === 'failed')
      expect(String(failed?.text)).toContain(
        '没能建独立工作树：git worktree 超过 1 秒没有结束',
      )
      expect(failed?.code).toBe('E_GIT')
      expect(
        quick.turns(late).find(one => one.text === 'fourth'),
      ).toMatchObject({ state: 'failed', code: 'E_NOT_SENT' })
    }, 60_000)

    test('kept across a restart: the summary names its branch; a session is renamed and that is kept too', async () => {
      const at = box()
      repository(at, { 'notes.md': 'one\n' })
      const r = runner(at)
      const folder = await pick(r, at.work)
      const id = await startIn(r, folder, 'hello')
      await r.state(id, 'idle')
      const branch = String((header(at, id).worktree as Message).branch)
      const mark = r.mark
      expect(
        await r.call('session.rename', { session: id, title: '  改登录页  ' }),
      ).toEqual({})
      const renamed = await r.event(
        one =>
          one.type === 'session' &&
          (one.session as Message).title === '改登录页',
        5_000,
        mark,
      )
      expect((renamed.session as Message).worktree).toEqual({ branch })
      for (const bad of ['', '   ', 'a\nb', 'x'.repeat(121), 7]) {
        expect(
          await refused(r.call('session.rename', { session: id, title: bad })),
        ).toBe('E_ARGS')
      }
      // 120 UTF-16 code units at most: 60 emoji are 120.
      expect(
        await r.call('session.rename', { session: id, title: '😀'.repeat(60) }),
      ).toEqual({})
      expect(
        await refused(
          r.call('session.rename', { session: id, title: '😀'.repeat(61) }),
        ),
      ).toBe('E_ARGS')
      expect(
        await refused(
          r.call('session.rename', {
            session: 'cs_AAAAAAAAAAAAAAAAAAAAAA',
            title: 'x',
          }),
        ),
      ).toBe('E_SESSION')
      expect(
        await refused(
          r.call('session.rename', { session: id, title: 'x', more: 1 }),
        ),
      ).toBe('E_ARGS')
      await r.call('session.rename', { session: id, title: '改登录页' })
      await r.stop()
      running.splice(0)
      const again = runner(at)
      const listed = ((await again.call('list')).sessions as Message[])[0]
      expect(listed).toMatchObject({
        id,
        title: '改登录页',
        worktree: { branch },
      })
    }, 30_000)

    test('deleting a running session stops it first; a folder that is not Git has no worktree to remove', async () => {
      const at = box()
      const r = runner(at)
      const folder = await pick(r, at.work)
      const id = await begin(r, folder, 'hang', 'auto', 'running')
      // The agent is up and in its turn.
      await r.until(() =>
        fs.existsSync(path.join(at.state, 'argv.ndjson')) ? true : undefined,
      )
      expect(await r.call('session.delete', { session: id })).toEqual({})
      expect(fs.existsSync(path.join(at.code, 'sessions', id))).toBe(false)
      expect(await refused(r.call('session.delete', { session: id }))).toBe(
        'E_SESSION',
      )
      expect(await refused(r.call('session.delete', { session: 'nope' }))).toBe(
        'E_ARGS',
      )
      // The work folder itself is never touched.
      expect(fs.existsSync(at.work)).toBe(true)
    }, 30_000)
  },
)
