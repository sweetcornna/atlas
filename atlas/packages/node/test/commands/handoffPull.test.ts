// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `qm handoff pull` against real git (P17.6): the fast-forward when the
 * handoff carried uncommitted and untracked files, the way back when the
 * fast-forward fails, a second pull, the session put back beside a local one,
 * the refusals, and the hub not recording `returned`.
 *
 * The cloud side is built the way the node builds it — a work tree from the
 * hub's bare repository at the shadow commit, a commit on `qianmo/<task>`, a
 * session commit under `refs/qianmo/sessions/cloud/<thread>` — and the hub's
 * HTTP API is a small stand-in here (the real routes and port are tested in
 * `packages/console/test/handoff.test.ts` and `consoleHandoff.test.ts`, the
 * whole chain in `tests/integration/qianmo-handoff-return.test.ts`).
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  sessionCommit,
  sessionRef,
  shadowCommit,
  taskBranch,
  wipRef,
} from '@qianmo/handoff'
import type { Output } from '../../src/commands/handoffNow.js'
import { runPull } from '../../src/commands/handoffPull.js'
import {
  HandoffUserError,
  saveProject,
} from '../../src/commands/handoffStore.js'
import { qmcodeRollout, qmcodeRolloutPath } from './support/handoffSamples.js'

const THREAD = '0199a4c2-7c1e-7d32-9a5e-3b1f2c4d5e71'
const TURN_1 = '0199a4c2-8000-7000-8000-000000000201'
const TURN_2 = '0199a4c2-8000-7000-8000-000000000202'
const COPY_RULE = /[。，、！!]|\p{Extended_Pictographic}/u

const saved = {
  config: process.env.QIANMO_CONFIG_DIR,
  qmcode: process.env.QMCODE_HOME,
}
const roots: string[] = []
let base = ''
let qmHome = ''
let tokenFile = ''
let hub: ReturnType<typeof Bun.serve> | undefined
const tasks = new Map<string, Record<string, unknown>>()
const posts: { path: string; body: unknown }[] = []
/** Task ids whose `return` the stand-in hub answers 503. */
const hubRefusesReturn = new Set<string>()

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'qianmo-handoff-pull-'))
  roots.push(dir)
  return dir
}

function git(cwd: string, ...args: string[]): string {
  const proc = Bun.spawnSync(
    [
      'git',
      '-c',
      'user.name=Pull Test',
      '-c',
      'user.email=pull-test@qianmo.invalid',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    { cwd, stdout: 'pipe', stderr: 'pipe' },
  )
  if (proc.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')}: ${proc.stderr.toString()}`)
  }
  return proc.stdout.toString().trim()
}

function collector(): Output & { lines: string[] } {
  const lines: string[] = []
  return { lines, out: line => lines.push(line), err: line => lines.push(line) }
}

beforeAll(() => {
  base = tempDir()
  process.env.QIANMO_CONFIG_DIR = join(base, 'config')
  qmHome = join(base, 'qmcode-home')
  process.env.QMCODE_HOME = qmHome
  tokenFile = join(base, 'token')
  writeFileSync(tokenFile, 'qm-pull-test-token\n', { mode: 0o600 })
  hub = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      const path = new URL(request.url).pathname
      if (
        request.headers.get('authorization') !== 'Bearer qm-pull-test-token'
      ) {
        return Response.json({ error: { message: 'no' } }, { status: 401 })
      }
      if (request.method === 'GET' && path === '/v0/handoff') {
        return Response.json({ tasks: [...tasks.values()] })
      }
      const id = /^\/v0\/handoff\/([^/]+)(?:\/(return))?$/.exec(path)
      const task = id === null ? undefined : tasks.get(id[1] ?? '')
      if (task === undefined) {
        return Response.json(
          { error: { message: `台账里没有任务 ${id?.[1]}` } },
          { status: 404 },
        )
      }
      if (request.method === 'GET' && id?.[2] === undefined) {
        return Response.json({ task })
      }
      if (request.method === 'POST' && id?.[2] === 'return') {
        posts.push({ path, body: await request.json() })
        if (hubRefusesReturn.has(String(task.taskId))) {
          return Response.json(
            { error: { message: '台账写不进去' } },
            { status: 503 },
          )
        }
        const changed = task.state !== 'returned'
        task.state = 'returned'
        return Response.json({ task, changed })
      }
      return new Response('', { status: 405 })
    },
  })
})

afterAll(() => {
  hub?.stop(true)
  if (saved.config === undefined) delete process.env.QIANMO_CONFIG_DIR
  else process.env.QIANMO_CONFIG_DIR = saved.config
  if (saved.qmcode === undefined) delete process.env.QMCODE_HOME
  else process.env.QMCODE_HOME = saved.qmcode
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

interface Scenario {
  readonly repo: string
  readonly taskId: string
  readonly wip: string
  readonly head: string
  readonly cloudSession: string
}

/**
 * A registered repository with one commit, an edit and an untracked file
 * handed over (shadow commit on the hub), and the cloud's answer: a commit on
 * `qianmo/<task>` that changes `a.txt` and adds `cloud.txt`, plus the cloud
 * session. The hub stand-in lists the task as `state`.
 */
async function scenario(
  taskId: string,
  state = 'done',
  overrides: Record<string, unknown> = {},
): Promise<Scenario> {
  const dir = tempDir()
  const repo = join(dir, 'work', 'atlas')
  mkdirSync(repo, { recursive: true })
  git(repo, 'init', '-q', '-b', 'main')
  writeFileSync(join(repo, 'a.txt'), 'one\n')
  writeFileSync(join(repo, 'keep.txt'), 'kept\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'one')
  writeFileSync(join(repo, 'a.txt'), 'one, edited before the handoff\n')
  writeFileSync(join(repo, 'untracked.txt'), 'not committed anywhere\n')
  const root = realpathSync(repo)

  const hubRoot = join(dir, 'hub')
  const bare = join(hubRoot, 'atlas.git')
  mkdirSync(hubRoot)
  git(hubRoot, 'init', '-q', '--bare', bare)
  const shadow = await shadowCommit({ cwd: root })
  git(root, 'push', '-q', bare, `${shadow.commit}:${wipRef('laptop', 'main')}`)

  // The node: a work tree from the bare repository at the shadow commit.
  const cloud = join(dir, 'node-work')
  git(
    bare,
    'worktree',
    'add',
    '-q',
    '-b',
    taskBranch(taskId),
    cloud,
    shadow.commit,
  )
  writeFileSync(join(cloud, 'a.txt'), 'finished in the cloud\n')
  writeFileSync(join(cloud, 'cloud.txt'), 'from the cloud\n')
  git(cloud, 'add', '-A')
  git(cloud, 'commit', '-q', '-m', 'cloud work')
  const head = git(cloud, 'rev-parse', 'HEAD')
  const rolloutName = `rollout-2026-10-03T09-00-00-${THREAD}.jsonl`
  const cloudSession = qmcodeRollout(THREAD, '/node/work/x', [
    { turnId: TURN_1, user: '把 a.txt 改完', assistant: '改了一半' },
    { turnId: TURN_2, user: '接着做', assistant: '做完了' },
  ])
  const sessionFile = join(dir, rolloutName)
  writeFileSync(sessionFile, cloudSession)
  const session = await sessionCommit({ cwd: cloud, file: sessionFile })
  git(bare, 'update-ref', sessionRef('cloud', THREAD), session.commit)

  await saveProject({
    root,
    project: 'atlas',
    device: 'laptop',
    hub: { kind: 'local', root: hubRoot },
    console: `http://127.0.0.1:${hub?.port}`,
    tokenFile,
  })
  tasks.set(taskId, {
    taskId,
    state,
    manifest: {
      kind: 'handoff',
      project: 'atlas',
      device: 'laptop',
      branch: 'main',
      wip: shadow.commit,
      tree: shadow.tree,
      tool: 'qmcode',
      sessionId: THREAD,
      sessionRef: sessionRef('laptop', THREAD),
      sessionCommit: shadow.commit,
      cwd: root,
      brief: { goal: 'g', done: '', remaining: '' },
      deadline: '2026-11-20T02:00:00Z',
    },
    node: 'cloud-1',
    result:
      state === 'done' || state === 'returned'
        ? {
            status: 'completed',
            branch: taskBranch(taskId),
            head,
            threadId: THREAD,
            summary: '',
          }
        : null,
    reason: state === 'failed' ? '节点拒收（E_DENIED）' : null,
    acceptedAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  })
  return { repo: root, taskId, wip: shadow.commit, head, cloudSession }
}

function clearSessions(): void {
  rmSync(join(qmHome, 'sessions'), { recursive: true, force: true })
}

describe('qm handoff pull', () => {
  test('untouched: the branch fast-forwards although the handoff carried an edit and an untracked file; the session goes home', async () => {
    clearSessions()
    const s = await scenario('t-ff')
    const out = collector()
    expect(await runPull(s.repo, { taskId: 't-ff' }, out)).toBe(0)
    expect(git(s.repo, 'rev-parse', 'HEAD')).toBe(s.head)
    expect(git(s.repo, 'symbolic-ref', '--short', 'HEAD')).toBe('main')
    expect(git(s.repo, 'status', '--porcelain')).toBe('')
    expect(readFileSync(join(s.repo, 'a.txt'), 'utf8')).toBe(
      'finished in the cloud\n',
    )
    expect(readFileSync(join(s.repo, 'cloud.txt'), 'utf8')).toBe(
      'from the cloud\n',
    )
    expect(readFileSync(join(s.repo, 'untracked.txt'), 'utf8')).toBe(
      'not committed anywhere\n',
    )
    // The shadow commit is in the branch's history, right under the cloud's.
    expect(git(s.repo, 'rev-parse', 'HEAD^')).toBe(s.wip)
    const placed = qmcodeRolloutPath(qmHome, THREAD)
    expect(readFileSync(placed, 'utf8')).toBe(s.cloudSession)
    expect(out.lines.join('\n')).toContain(`会话  ${placed}`)
    expect(out.lines.join('\n')).toContain(`qmcode resume ${THREAD} 接着聊`)
    expect(posts.at(-1)).toEqual({
      path: '/v0/handoff/t-ff/return',
      body: { device: 'laptop', mode: 'fast-forward' },
    })
    expect(tasks.get('t-ff')?.state).toBe('returned')
    // The temporary refs are gone again.
    expect(git(s.repo, 'for-each-ref', 'refs/qianmo/pull/')).toBe('')
    for (const line of out.lines) expect(line).not.toMatch(COPY_RULE)

    // A second pull: nothing to move, nothing to post.
    const before = posts.length
    const again = collector()
    expect(await runPull(s.repo, { taskId: 't-ff' }, again)).toBe(0)
    expect(again.lines.join('\n')).toContain('本机已在云端结果上')
    expect(again.lines.join('\n')).toContain('已是云端那份')
    expect(again.lines.join('\n')).toContain('台账  已是 returned')
    expect(posts.length).toBe(before)
  })

  test('a fast-forward that fails puts the branch and the index back and takes the branch way', async () => {
    clearSessions()
    const s = await scenario('t-fallback')
    const head = git(s.repo, 'rev-parse', 'HEAD')
    git(s.repo, 'add', 'untracked.txt')
    const index = readFileSync(join(s.repo, '.git', 'index'))
    // Somebody else holds the index: `git reset` cannot take it.
    writeFileSync(join(s.repo, '.git', 'index.lock'), '')
    try {
      // The work tree differs from the shadow only by what is staged — the
      // tree is the same, so the untouched check passes.
      const out = collector()
      expect(await runPull(s.repo, { taskId: 't-fallback' }, out)).toBe(0)
      expect(out.lines.join('\n')).toContain('快进没有成功')
      expect(git(s.repo, 'rev-parse', 'HEAD')).toBe(head)
      expect(readFileSync(join(s.repo, '.git', 'index')).equals(index)).toBe(
        true,
      )
      expect(
        git(s.repo, 'rev-parse', `${taskBranch('t-fallback')}-return`),
      ).toBe(s.head)
      expect(posts.at(-1)?.body).toEqual({ device: 'laptop', mode: 'branch' })
    } finally {
      rmSync(join(s.repo, '.git', 'index.lock'), { force: true })
    }
  })

  test('a Claude Code task: the code comes home, the session stays on the hub and nothing goes into QMCODE_HOME', async () => {
    clearSessions()
    const s = await scenario('t-cc')
    const task = tasks.get('t-cc') ?? {}
    task.manifest = {
      ...(task.manifest as Record<string, unknown>),
      tool: 'claude-code',
    }
    const out = collector()
    expect(await runPull(s.repo, { taskId: 't-cc' }, out)).toBe(0)
    expect(git(s.repo, 'rev-parse', 'HEAD')).toBe(s.head)
    expect(out.lines.join('\n')).toContain(
      `会话  Claude Code 会话在云端续成了 qmcode 线程 ${THREAD} · 留在中枢 ${sessionRef('cloud', THREAD)} · 没有放到本机`,
    )
    expect(existsSync(join(qmHome, 'sessions'))).toBe(false)
    // Only the branch was fetched: no session ref, temporary or not.
    expect(git(s.repo, 'for-each-ref', 'refs/qianmo/')).not.toContain(
      'sessions/cloud',
    )
    expect(git(s.repo, 'for-each-ref', 'refs/qianmo/pull/')).toBe('')
    expect(posts.at(-1)).toEqual({
      path: '/v0/handoff/t-cc/return',
      body: { device: 'laptop', mode: 'fast-forward' },
    })
    for (const line of out.lines) expect(line).not.toMatch(COPY_RULE)
  })

  test('a local rollout of the thread that differs is kept beside, the cloud one takes its place', async () => {
    clearSessions()
    const s = await scenario('t-session')
    const local = qmcodeRolloutPath(qmHome, THREAD)
    mkdirSync(dirname(local), { recursive: true })
    const localText = qmcodeRollout(THREAD, s.repo, [
      { turnId: TURN_1, user: '把 a.txt 改完', assistant: '改了一半' },
    ])
    writeFileSync(local, localText)
    const out = collector()
    const thread = { taskId: 't-session', callerThread: THREAD }
    expect(await runPull(s.repo, thread, out)).toBe(0)
    expect(readFileSync(local, 'utf8')).toBe(s.cloudSession)
    const backup = `${local}.before-pull-t-session`
    expect(readFileSync(backup, 'utf8')).toBe(localText)
    expect(out.lines.join('\n')).toContain(`本机原来那份改名为 ${backup}`)
    // Run from inside that very thread: it has to be resumed again.
    expect(out.lines.join('\n')).toContain('这个线程正开着')
  })

  test('refused before anything is fetched: still running, failed, another project', async () => {
    const running = await scenario('t-running', 'running')
    const failed = await scenario('t-failed', 'failed')
    const other = await scenario('t-other', 'done')
    const manifest = tasks.get('t-other')?.manifest as Record<string, unknown>
    tasks.set('t-other', {
      ...tasks.get('t-other'),
      manifest: { ...manifest, project: 'elsewhere' },
    })
    for (const [s, said] of [
      [running, '还在云端（running）'],
      [failed, '失败了（failed）'],
      [other, '属于项目 elsewhere'],
    ] as const) {
      let refused: unknown
      try {
        await runPull(s.repo, { taskId: s.taskId }, collector())
      } catch (error) {
        refused = error
      }
      expect(refused).toBeInstanceOf(HandoffUserError)
      expect(String((refused as Error).message)).toContain(said)
      expect((refused as Error).message).not.toMatch(COPY_RULE)
      expect(
        git(s.repo, 'for-each-ref', 'refs/qianmo/', 'refs/heads/qianmo/'),
      ).toBe('')
    }
  })

  test('without a task id: this project and device, the newest done', async () => {
    clearSessions()
    for (const id of [...tasks.keys()]) tasks.delete(id)
    const s = await scenario('t-latest', 'done', { acceptedAt: 2 })
    tasks.set('t-older', {
      ...tasks.get('t-latest'),
      taskId: 't-older',
      acceptedAt: 1,
    })
    tasks.set('t-newer-running', {
      ...tasks.get('t-latest'),
      taskId: 't-newer-running',
      state: 'running',
      acceptedAt: 3,
    })
    const out = collector()
    expect(await runPull(s.repo, {}, out)).toBe(0)
    expect(out.lines[0]).toContain('任务 t-latest')
  })

  test('the hub does not record returned: exit 1 says the local part is done; a second run records it', async () => {
    clearSessions()
    const s = await scenario('t-unrecorded')
    hubRefusesReturn.add('t-unrecorded')
    let refused: unknown
    try {
      await runPull(s.repo, { taskId: 't-unrecorded' }, collector())
    } catch (error) {
      refused = error
    }
    expect((refused as HandoffUserError).exitCode).toBe(1)
    expect((refused as Error).message).toContain('本机已经接回')
    expect((refused as Error).message).toContain('qm handoff pull t-unrecorded')
    expect((refused as Error).message).not.toMatch(COPY_RULE)
    expect(git(s.repo, 'rev-parse', 'HEAD')).toBe(s.head)
    hubRefusesReturn.delete('t-unrecorded')
    expect(await runPull(s.repo, { taskId: 't-unrecorded' }, collector())).toBe(
      0,
    )
    expect(tasks.get('t-unrecorded')?.state).toBe('returned')
  })

  test('the hub cannot be reached, or does not know the task', async () => {
    const s = await scenario('t-known')
    let unknown: unknown
    try {
      await runPull(s.repo, { taskId: 't-nope' }, collector())
    } catch (error) {
      unknown = error
    }
    expect((unknown as Error).message).toBe('中枢台账里没有任务 t-nope')
    await saveProject({
      root: s.repo,
      project: 'atlas',
      device: 'laptop',
      hub: { kind: 'local', root: join(dirname(dirname(s.repo)), 'hub') },
      console: 'http://127.0.0.1:9',
      tokenFile,
    })
    let away: unknown
    try {
      await runPull(s.repo, { taskId: 't-known' }, collector())
    } catch (error) {
      away = error
    }
    expect((away as Error).message).toContain('连不上控制台 http://127.0.0.1:9')
    expect(existsSync(join(s.repo, '.git', 'refs', 'heads', 'qianmo'))).toBe(
      false,
    )
  })
})
