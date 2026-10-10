// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The hub's handoff port against real git and real files (P17.4).
 *
 * Every fixture is a real repository: a work tree whose shadow commit and
 * session commit are made by `@qianmo/handoff` and pushed into a bare
 * repository under the hub root, exactly as `qm handoff sync` does. Nothing is
 * mocked — "the object is in the bare repository" is only worth testing
 * against git itself.
 */

import { afterAll, describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AuditSource, readTrail } from '@qianmo/audit'
import {
  type HandoffManifest,
  HandoffLedger,
  sessionCommit,
  sessionRef,
  shadowCommit,
  taskBranch,
  wipRef,
} from '@qianmo/handoff'
import { parseConsoleArgs } from '../../src/commands/consoleArgs.js'
import {
  HANDOFF_AUDIT_KINDS,
  handoffLockRefusal,
  openConsoleHandoff,
} from '../../src/commands/consoleHandoff.js'

const roots: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'qianmo-console-handoff-'))
  roots.push(dir)
  return dir
}

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

function git(cwd: string, ...args: string[]): string {
  const proc = Bun.spawnSync(
    [
      'git',
      '-c',
      'user.name=Handoff Test',
      '-c',
      'user.email=handoff-test@qianmo.invalid',
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

const SESSION = '01a101a4-f755-7fb2-80ed-d37be2a4040a'

interface Landed {
  readonly hubRoot: string
  readonly bare: string
  readonly manifest: HandoffManifest
}

/** A work tree with one commit and one edit, landed in `<hub>/atlas.git`. */
async function landed(): Promise<Landed> {
  const base = tempDir()
  const work = join(base, 'work')
  mkdirSync(work)
  git(work, 'init', '-q', '-b', 'main')
  writeFileSync(join(work, 'a.txt'), 'one\n')
  git(work, 'add', '-A')
  git(work, 'commit', '-q', '-m', 'one')
  writeFileSync(join(work, 'a.txt'), 'two\n')
  const transcript = join(base, `rollout-2026-10-03T05-02-30-${SESSION}.jsonl`)
  writeFileSync(transcript, '{"type":"session_meta"}\n')

  const hubRoot = join(base, 'hub')
  const bare = join(hubRoot, 'atlas.git')
  mkdirSync(hubRoot)
  git(hubRoot, 'init', '-q', '--bare', bare)

  const shadow = await shadowCommit({ cwd: work })
  const session = await sessionCommit({ cwd: work, file: transcript })
  git(
    work,
    'push',
    '-q',
    bare,
    `${shadow.commit}:${wipRef('cornna-mbp', 'main')}`,
    `${session.commit}:${sessionRef('cornna-mbp', SESSION)}`,
  )
  return {
    hubRoot,
    bare,
    manifest: {
      kind: 'handoff',
      project: 'atlas',
      device: 'cornna-mbp',
      branch: 'main',
      wip: shadow.commit,
      tree: shadow.tree,
      tool: 'qmcode',
      sessionId: SESSION,
      sessionRef: sessionRef('cornna-mbp', SESSION),
      sessionCommit: session.commit,
      cwd: work,
      brief: { goal: '跑完测试', done: '', remaining: '全部' },
      deadline: '2026-11-20T02:00:00Z',
    },
  }
}

function hubFiles(): { ledgerPath: string; auditPath: string } {
  const dir = join(tempDir(), 'qianmo', 'handoff')
  return {
    ledgerPath: join(dir, 'ledger.ndjson'),
    auditPath: join(dir, 'audit.ndjson'),
  }
}

/** Delete a loose object from a bare repository, as a damaged hub would lose it. */
function dropObject(bare: string, sha: string): void {
  const path = join(bare, 'objects', sha.slice(0, 2), sha.slice(2))
  expect(existsSync(path)).toBe(true)
  unlinkSync(path)
}

describe('openConsoleHandoff', () => {
  test('accepts a landed manifest once, writes the ledger and the audit line, and replays after a restart', async () => {
    const { hubRoot, manifest } = await landed()
    const files = hubFiles()
    let ids = 0
    const hub = openConsoleHandoff({
      root: hubRoot,
      ...files,
      now: () => 1_791_000_000_000,
      newTaskId: () => `t-${++ids}`,
    })

    const first = await hub.port.accept(manifest)
    expect(first.ok).toBe(true)
    if (!first.ok) return
    expect(first.value.created).toBe(true)
    expect(first.value.task).toMatchObject({ taskId: 't-1', state: 'accepted' })

    // A retry of the same request is the same task, not a second one.
    const again = await hub.port.accept({ ...manifest })
    expect(again.ok && again.value).toMatchObject({
      created: false,
      task: { taskId: 't-1' },
    })
    // A different brief is a different request.
    const other = await hub.port.accept({
      ...manifest,
      brief: { ...manifest.brief, goal: '另一件事' },
    })
    expect(other.ok && other.value.task.taskId).toBe('t-2')

    const trail = readTrail(files.auditPath)
    expect(trail.intact).toBe(true)
    expect(
      trail.records.map(record => [record.source, record.kind, record.taskId]),
    ).toEqual([
      [AuditSource.Handoff, 'handoff.accepted', 't-1'],
      [AuditSource.Handoff, 'handoff.accepted', 't-2'],
    ])
    expect(trail.records[0]?.detail).toMatchObject({
      project: 'atlas',
      wip: manifest.wip,
      sessionCommit: manifest.sessionCommit,
    })
    hub.close()

    const restarted = openConsoleHandoff({ root: hubRoot, ...files })
    expect(restarted.replayed).toBe(2)
    const task = await restarted.port.get('t-1')
    expect(task.ok && task.value.state).toBe('accepted')
    restarted.close()
  })

  test('the ledger is locked while open: a second hub is refused', async () => {
    const { hubRoot } = await landed()
    const files = hubFiles()
    const hub = openConsoleHandoff({ root: hubRoot, ...files })
    let refused: unknown
    try {
      openConsoleHandoff({ root: hubRoot, ...files })
    } catch (error) {
      refused = error
    }
    expect(String(refused)).toContain('in use')
    // What the console prints instead of a stack: the lock file and the pid.
    const sentence = handoffLockRefusal(refused)
    expect(sentence).toContain(`锁文件 ${files.ledgerPath}.lock`)
    expect(sentence).toContain(`持锁进程 pid ${process.pid}`)
    expect(sentence).toContain('控制台没有启动')
    expect(handoffLockRefusal(new Error('other'))).toBeNull()
    hub.close()
    openConsoleHandoff({ root: hubRoot, ...files }).close()
  })

  test('refuses what has not landed, saying what is missing', async () => {
    const files = hubFiles()
    const first = await landed()
    const hub = openConsoleHandoff({ root: first.hubRoot, ...files })

    const noRepo = await hub.port.accept({ ...first.manifest, project: 'nope' })
    expect(!noRepo.ok && noRepo.failure).toMatchObject({ code: 'rejected' })
    expect(!noRepo.ok && noRepo.failure.message).toContain('qm handoff init')

    const wrongTree = await hub.port.accept({
      ...first.manifest,
      tree: 'f'.repeat(40),
    })
    expect(!wrongTree.ok && wrongTree.failure.message).toContain('不一致')

    dropObject(first.bare, first.manifest.sessionCommit)
    const noSession = await hub.port.accept(first.manifest)
    expect(!noSession.ok && noSession.failure).toEqual({
      code: 'rejected',
      message: `会话提交 ${first.manifest.sessionCommit} 不在中枢裸仓里`,
    })

    const invalid = await hub.port.accept({
      ...first.manifest,
      device: 'cloud',
    })
    expect(!invalid.ok && invalid.failure.code).toBe('invalid')

    const listed = await hub.port.list()
    expect(listed.ok && listed.value).toEqual([])
    hub.close()
  })

  test('send keeps a message while the task can hear it', async () => {
    const { hubRoot, manifest } = await landed()
    const files = hubFiles()
    const hub = openConsoleHandoff({
      root: hubRoot,
      ...files,
      newTaskId: () => 't-1',
    })
    await hub.port.accept(manifest)
    const sent = await hub.port.send('t-1', '先跑测试')
    expect(sent.ok && sent.value).toMatchObject({ taskId: 't-1', seq: 1 })
    const unknown = await hub.port.send('t-9', 'x')
    expect(!unknown.ok && unknown.failure.code).toBe('not_found')
    const empty = await hub.port.send('t-1', ' ')
    expect(!empty.ok && empty.failure.code).toBe('invalid')
    hub.close()
  })

  test('attach (P17.6): a locator for a running task only, and the audit line', async () => {
    const { hubRoot, manifest } = await landed()
    const files = hubFiles()
    const CLOUD_THREAD = '0199f1a2-0000-7000-8000-000000000042'
    const seed = HandoffLedger.open(files.ledgerPath)
    seed.accept('t-run', manifest)
    seed.dispatch('t-run', 'node-a')
    seed.start('t-run')
    seed.accept('t-cc', {
      ...manifest,
      tool: 'claude-code',
      brief: { ...manifest.brief, goal: 'cc' },
    })
    seed.dispatch('t-cc', 'node-b')
    seed.start('t-cc')
    seed.accept('t-acc', {
      ...manifest,
      brief: { ...manifest.brief, goal: 'a' },
    })
    seed.accept('t-done', {
      ...manifest,
      brief: { ...manifest.brief, goal: 'd' },
    })
    seed.dispatch('t-done', 'node-c')
    seed.start('t-done')
    seed.complete('t-done', {
      status: 'completed',
      branch: taskBranch('t-done'),
      head: 'e'.repeat(40),
      threadId: CLOUD_THREAD,
      summary: '',
    })
    seed.close()

    const hub = openConsoleHandoff({ root: hubRoot, ...files, now: () => 7 })
    const running = await hub.port.attach('t-run', { device: 'phone-1' })
    expect(running).toEqual({
      ok: true,
      value: {
        taskId: 't-run',
        state: 'running',
        node: 'node-a',
        threadId: SESSION,
        project: 'atlas',
        tool: 'qmcode',
      },
    })
    // A Claude Code session becomes a new thread on the node; the hub does
    // not know which until the result.
    const cc = await hub.port.attach('t-cc', { device: null })
    expect(cc.ok && cc.value).toMatchObject({ node: 'node-b', threadId: null })

    const accepted = await hub.port.attach('t-acc', { device: null })
    expect(!accepted.ok && accepted.failure.code).toBe('rejected')
    expect(!accepted.ok && accepted.failure.message).toContain('还没有派给节点')
    const done = await hub.port.attach('t-done', { device: null })
    expect(!done.ok && done.failure.message).toContain('qm handoff pull')
    const missing = await hub.port.attach('t-9', { device: null })
    expect(!missing.ok && missing.failure.code).toBe('not_found')
    // The refusals a person reads keep the copy rule: no 。，、 no exclamation.
    for (const refusal of [accepted, done, missing]) {
      expect(!refusal.ok && refusal.failure.message).not.toMatch(
        /[。，、！!]|\p{Extended_Pictographic}/u,
      )
    }

    const trail = readTrail(files.auditPath)
    expect(trail.intact).toBe(true)
    expect(
      trail.records.map(record => [
        record.kind,
        record.taskId,
        record.peer,
        record.detail,
      ]),
    ).toEqual([
      [
        'handoff.attach-requested',
        't-run',
        'phone-1',
        { node: 'node-a', threadId: SESSION, device: 'phone-1' },
      ],
      ['handoff.attach-requested', 't-cc', 'cornna-mbp', { node: 'node-b' }],
    ])
    hub.close()
  })

  test('markReturned (P17.6): done and failed become returned once; a repeat is not an error', async () => {
    const { hubRoot, manifest } = await landed()
    const files = hubFiles()
    const seed = HandoffLedger.open(files.ledgerPath)
    seed.accept('t-done', manifest)
    seed.dispatch('t-done', 'node-a')
    seed.start('t-done')
    seed.complete('t-done', {
      status: 'interrupted',
      branch: taskBranch('t-done'),
      head: 'e'.repeat(40),
      threadId: SESSION,
      summary: '',
    })
    seed.accept('t-fail', {
      ...manifest,
      brief: { ...manifest.brief, goal: 'f' },
    })
    seed.fail('t-fail', 'no node took it')
    seed.accept('t-run', {
      ...manifest,
      brief: { ...manifest.brief, goal: 'r' },
    })
    seed.dispatch('t-run', 'node-b')
    seed.start('t-run')
    seed.close()

    const hub = openConsoleHandoff({ root: hubRoot, ...files })
    const first = await hub.port.markReturned('t-done', {
      device: 'laptop',
      mode: 'fast-forward',
    })
    expect(first.ok && first.value.changed).toBe(true)
    expect(first.ok && first.value.task.state).toBe('returned')
    const again = await hub.port.markReturned('t-done', {
      device: 'laptop',
      mode: null,
    })
    expect(again.ok && again.value.changed).toBe(false)
    const failed = await hub.port.markReturned('t-fail', {
      device: null,
      mode: null,
    })
    expect(failed.ok && failed.value.task.state).toBe('returned')
    const running = await hub.port.markReturned('t-run', {
      device: null,
      mode: null,
    })
    expect(!running.ok && running.failure.code).toBe('rejected')
    expect(!running.ok && running.failure.message).toContain('还在 running')
    expect(!running.ok && running.failure.message).not.toMatch(/[。，、！!]/u)
    const missing = await hub.port.markReturned('t-9', {
      device: null,
      mode: null,
    })
    expect(!missing.ok && missing.failure.code).toBe('not_found')

    expect(
      readTrail(files.auditPath).records.map(record => [
        record.kind,
        record.taskId,
        record.detail,
      ]),
    ).toEqual([
      [
        'handoff.returned',
        't-done',
        { from: 'done', mode: 'fast-forward', device: 'laptop' },
      ],
      ['handoff.returned', 't-fail', { from: 'failed' }],
    ])
    hub.close()

    const restarted = openConsoleHandoff({ root: hubRoot, ...files })
    const after = await restarted.port.get('t-done')
    expect(after.ok && after.value.state).toBe('returned')
    restarted.close()
  })

  test('the audit kinds are the plan card six, prefixed handoff.', () => {
    expect(HANDOFF_AUDIT_KINDS).toEqual([
      'handoff.accepted',
      'handoff.dispatched',
      'handoff.completed',
      'handoff.failed',
      'handoff.returned',
      'handoff.attach-requested',
    ])
  })
})

describe('--handoff-root', () => {
  test('absent by default, absolute only', () => {
    expect(parseConsoleArgs([]).handoffRoot).toBeUndefined()
    expect(
      parseConsoleArgs(['--handoff-root', '/srv/qianmo/handoff/repos/'])
        .handoffRoot,
    ).toBe('/srv/qianmo/handoff/repos')
    expect(() => parseConsoleArgs(['--handoff-root=relative/repos'])).toThrow(
      'absolute',
    )
  })
})
