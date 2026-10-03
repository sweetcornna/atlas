// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * One sync and the debounce around it, against real git (P17.4): what lands
 * on the hub, what stays untouched in the user's repository, rulings 5/8/9,
 * and the trailing edge of the 5 s debounce.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { tryExclusiveLock } from '@qianmo/handoff'
import { initHubRepository } from '../handoffHub.js'
import {
  type HandoffProject,
  HandoffUserError,
  parseHub,
  stateDir,
  syncLogPath,
} from '../handoffStore.js'
import {
  drainPending,
  pendingCount,
  readLastSync,
  syncFailureReason,
  syncOnce,
  writeLastSync,
  writePending,
} from '../handoffSync.js'
import { qmcodeRollout } from './support/handoffSamples.js'

const roots: string[] = []
const savedConfigDir = process.env.OCC_CONFIG_DIR

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'qianmo-handoff-sync-'))
  roots.push(dir)
  return dir
}

beforeAll(() => {
  process.env.OCC_CONFIG_DIR = tempDir()
})

afterAll(() => {
  if (savedConfigDir === undefined) delete process.env.OCC_CONFIG_DIR
  else process.env.OCC_CONFIG_DIR = savedConfigDir
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

/** A GitHub token shape the scanner knows; not a real token. */
const FAKE_PAT = `ghp_${'a1B2'.repeat(9)}`
const THREAD = '0199a4c2-7c1e-7d32-9a5e-3b1f2c4d5e6f'
const TURN = '0199a4c2-8000-7000-8000-000000000001'

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

interface Fixture {
  readonly project: HandoffProject
  readonly bare: string
  readonly transcript: string
}

/** A repository mid-work (staged, unstaged, untracked, a stash) and an empty hub. */
async function fixture(): Promise<Fixture> {
  const base = tempDir()
  const root = join(base, 'repo')
  mkdirSync(root)
  git(root, 'init', '-q', '-b', 'main')
  writeFileSync(join(root, 'a.txt'), 'one\n')
  writeFileSync(join(root, 'b.txt'), 'b\n')
  git(root, 'add', '-A')
  git(root, 'commit', '-q', '-m', 'one')
  writeFileSync(join(root, 'b.txt'), 'stashed\n')
  git(root, 'stash', 'push', '-q')
  writeFileSync(join(root, 'a.txt'), 'staged\n')
  git(root, 'add', 'a.txt')
  writeFileSync(join(root, 'a.txt'), 'staged then edited\n')
  writeFileSync(join(root, 'new.txt'), 'untracked\n')
  const hubRoot = join(base, 'hub')
  const bare = await initHubRepository(parseHub(hubRoot), 'atlas')
  const transcript = join(base, `rollout-2026-10-03T09-00-00-${THREAD}.jsonl`)
  writeFileSync(
    transcript,
    qmcodeRollout(THREAD, root, [
      { turnId: TURN, user: `token ${FAKE_PAT} here`, assistant: 'ok' },
    ]),
  )
  return {
    project: {
      root: git(root, 'rev-parse', '--show-toplevel'),
      project: 'atlas',
      device: 'laptop',
      hub: parseHub(hubRoot),
      console: 'http://127.0.0.1:1',
    },
    bare,
    transcript,
  }
}

/** Everything of the user's repository a sync must not touch. */
function userState(root: string): string {
  const dot = join(root, '.git')
  return JSON.stringify({
    head: readFileSync(join(dot, 'HEAD'), 'utf8'),
    index: readFileSync(join(dot, 'index')).toString('base64'),
    stash: readFileSync(join(dot, 'refs', 'stash'), 'utf8'),
    stashLog: readFileSync(join(dot, 'logs', 'refs', 'stash'), 'utf8'),
    refs: git(
      root,
      'for-each-ref',
      '--format=%(refname) %(objectname)',
      'refs/heads',
      'refs/tags',
      'refs/stash',
    ),
    status: git(root, 'status', '--porcelain=v1', '-uall'),
    a: readFileSync(join(root, 'a.txt'), 'utf8'),
    untracked: readFileSync(join(root, 'new.txt'), 'utf8'),
  })
}

function hubRefs(bare: string): Map<string, string> {
  const out = new Map<string, string>()
  const listed = git(bare, 'for-each-ref', '--format=%(refname) %(objectname)')
  for (const line of listed.split('\n').filter(Boolean)) {
    const [ref, sha] = line.split(' ')
    if (ref !== undefined && sha !== undefined) out.set(ref, sha)
  }
  return out
}

describe('syncOnce', () => {
  test("lands the work tree and the redacted session on the hub; the user's state is byte-identical", async () => {
    const { project, bare, transcript } = await fixture()
    const before = userState(project.root)
    const content = readFileSync(transcript)
    const result = await syncOnce(project, [
      { tool: 'qmcode', sessionId: THREAD, file: transcript, content },
    ])
    expect(userState(project.root)).toBe(before)

    const refs = hubRefs(bare)
    expect(refs.get('refs/qianmo/wip/laptop/main')).toBe(result.wip)
    const session = result.sessions[0]
    expect(session?.ref).toBe(`refs/qianmo/sessions/laptop/${THREAD}`)
    expect(refs.get(`refs/qianmo/sessions/laptop/${THREAD}`)).toBe(
      session?.commit,
    )
    expect([...refs.keys()].sort()).toEqual([
      `refs/qianmo/sessions/laptop/${THREAD}`,
      'refs/qianmo/wip/laptop/main',
    ])
    // The shadow holds the work tree as it is, untracked file included.
    expect(git(bare, 'show', `${result.wip}:a.txt`)).toBe('staged then edited')
    expect(git(bare, 'show', `${result.wip}:new.txt`)).toBe('untracked')

    // Ruling 5: redacted on the way, the file on disk untouched.
    const stored = git(
      bare,
      'show',
      `${session?.commit}:${transcript.split('/').at(-1)}`,
    )
    expect(stored).not.toContain(FAKE_PAT)
    expect(stored).toContain(TURN)
    // Twice: qmcode writes the prompt as a response_item and a user_message.
    expect(session?.redactions).toEqual({ count: 2, ruleIds: ['github-pat'] })
    expect(readFileSync(transcript).equals(content)).toBe(true)

    // Ruling 8: local anti-GC refs at the same commits.
    expect(
      git(project.root, 'rev-parse', 'refs/qianmo/local/laptop/wip/main'),
    ).toBe(result.wip)
    expect(
      git(
        project.root,
        'rev-parse',
        `refs/qianmo/local/laptop/sessions/${THREAD}`,
      ),
    ).toBe(session?.commit ?? '')

    // Unchanged transcript: the same session commit, not a new one.
    const again = await syncOnce(project, [
      { tool: 'qmcode', sessionId: THREAD, file: transcript, content },
    ])
    expect(again.sessions[0]?.commit).toBe(session?.commit ?? '')
    expect(again.sessions[0]?.reused).toBe(true)
  })

  test('a detached HEAD is refused before anything is pushed (ruling 9)', async () => {
    const { project, bare } = await fixture()
    git(project.root, 'stash', 'push', '-q', '--include-untracked')
    git(project.root, 'checkout', '-q', '--detach')
    let error: unknown
    try {
      await syncOnce(project, [])
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(HandoffUserError)
    expect(syncFailureReason(error)).toContain('detached HEAD')
    expect(hubRefs(bare).size).toBe(0)
  })

  test('a secret in a changed file refuses the sync; the reason names the file and rule, not the value', async () => {
    const { project, bare } = await fixture()
    writeFileSync(
      join(project.root, 'config.env'),
      `GITHUB_TOKEN=${FAKE_PAT}\n`,
    )
    let error: unknown
    try {
      await syncOnce(project, [])
    } catch (caught) {
      error = caught
    }
    const reason = syncFailureReason(error)
    expect(reason).toContain('config.env')
    expect(reason).toContain('github-pat')
    expect(reason).not.toContain(FAKE_PAT)
    expect(hubRefs(bare).size).toBe(0)
  })
})

describe('drainPending (trailing-edge debounce)', () => {
  test('another process holding the sync lock: return at once, entry left for it', async () => {
    const { project, bare, transcript } = await fixture()
    const held = tryExclusiveLock(join(stateDir(project.root), 'sync.lock'))
    expect(held).not.toBeNull()
    try {
      writePending(project.root, {
        tool: 'qmcode',
        sessionId: THREAD,
        file: transcript,
        length: readFileSync(transcript).length,
      })
      await drainPending(project, { trigger: 'test', debounceMs: 50 })
      expect(pendingCount(project.root)).toBe(1)
      expect(hubRefs(bare).size).toBe(0)
    } finally {
      held?.release()
    }
    await drainPending(project, { trigger: 'test', debounceMs: 50 })
    expect(pendingCount(project.root)).toBe(0)
    expect(hubRefs(bare).size).toBe(2)
  })

  test('within the window: waits it out, then syncs the latest entry; an entry arriving meanwhile is synced too', async () => {
    const { project, bare, transcript } = await fixture()
    const first = readFileSync(transcript).length
    writeLastSync(project.root, { at: Date.now(), ok: true })
    writePending(project.root, {
      tool: 'qmcode',
      sessionId: THREAD,
      file: transcript,
      length: first,
    })
    // A second turn lands while the drainer waits.
    const second = qmcodeRollout(THREAD, project.root, [
      { turnId: TURN, user: 'q', assistant: 'ok' },
      { turnId: `${TURN}-2`, user: 'q2', assistant: 'ok2' },
    ])
    setTimeout(() => {
      writeFileSync(transcript, second)
      writePending(project.root, {
        tool: 'qmcode',
        sessionId: THREAD,
        file: transcript,
        length: Buffer.byteLength(second),
      })
    }, 100)
    const started = Date.now()
    await drainPending(project, { trigger: 'test', debounceMs: 400 })
    expect(Date.now() - started).toBeGreaterThanOrEqual(390)
    expect(pendingCount(project.root)).toBe(0)
    const commit = hubRefs(bare).get(`refs/qianmo/sessions/laptop/${THREAD}`)
    expect(commit).toBeDefined()
    // The hub has the second turn: the last of the burst was not dropped.
    const stored = git(
      bare,
      'show',
      `${commit}:${transcript.split('/').at(-1)}`,
    )
    expect(stored).toContain(`${TURN}-2`)
    expect(readLastSync(project.root)?.ok).toBe(true)
  })

  test('nothing pending: returns without waiting or syncing', async () => {
    const { project, bare } = await fixture()
    writeLastSync(project.root, { at: Date.now(), ok: true })
    const started = Date.now()
    await drainPending(project, { trigger: 'test', debounceMs: 5_000 })
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(hubRefs(bare).size).toBe(0)
  })

  test('a failed sync is logged with its reason and recorded as the last sync', async () => {
    const { project, transcript } = await fixture()
    writeFileSync(
      join(project.root, 'config.env'),
      `GITHUB_TOKEN=${FAKE_PAT}\n`,
    )
    writePending(project.root, {
      tool: 'qmcode',
      sessionId: THREAD,
      file: transcript,
      length: readFileSync(transcript).length,
    })
    await drainPending(project, { trigger: 'test', debounceMs: 10 })
    const last = readLastSync(project.root)
    expect(last?.ok).toBe(false)
    expect(last?.reason).toContain('config.env')
    const log = readFileSync(syncLogPath(), 'utf8')
    expect(log).toContain('"ok":false')
    expect(log).not.toContain(FAKE_PAT)
  })
})
