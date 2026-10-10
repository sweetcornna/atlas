// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The hub's bare repository and its ref rule, against real git (P17.4, gate
 * ruling 5): what `init` creates, what the `pre-receive` hook lets through,
 * the same script run the way `init` runs it over SSH (`sh -s`), and the
 * file/directory ref collisions of ruling 7.
 */

import { afterAll, describe, expect, test } from 'bun:test'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  dfConflicts,
  hubConnection,
  initHubRepository,
  lsRemote,
  PRE_RECEIVE_HOOK,
  pushToHub,
  remoteInitScript,
  updateLocalRefs,
} from '../../src/commands/handoffHub.js'
import { parseHub } from '../../src/commands/handoffStore.js'

const roots: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'qianmo-handoff-hub-'))
  roots.push(dir)
  return dir
}

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

function git(
  cwd: string,
  args: readonly string[],
): { code: number; out: string; err: string } {
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
  return {
    code: proc.exitCode ?? -1,
    out: proc.stdout.toString().trim(),
    err: proc.stderr.toString(),
  }
}

function ok(cwd: string, ...args: string[]): string {
  const result = git(cwd, args)
  if (result.code !== 0) throw new Error(`git ${args.join(' ')}: ${result.err}`)
  return result.out
}

/** A work tree with two commits, for something to push. */
function workTree(): { work: string; one: string; two: string } {
  const work = join(tempDir(), 'work')
  mkdirSync(work)
  ok(work, 'init', '-q', '-b', 'main')
  writeFileSync(join(work, 'a.txt'), 'one\n')
  ok(work, 'add', '-A')
  ok(work, 'commit', '-q', '-m', 'one')
  const one = ok(work, 'rev-parse', 'HEAD')
  writeFileSync(join(work, 'a.txt'), 'two\n')
  ok(work, 'commit', '-q', '-am', 'two')
  return { work, one, two: ok(work, 'rev-parse', 'HEAD') }
}

function refsOf(bare: string): string {
  return ok(bare, 'for-each-ref', '--format=%(refname) %(objectname)')
}

describe('initHubRepository (local hub)', () => {
  test('creates <root>/<project>.git with an executable pre-receive hook, idempotently', async () => {
    const root = join(tempDir(), 'hub')
    const repo = await initHubRepository(parseHub(root), 'atlas')
    expect(repo).toBe(join(root, 'atlas.git'))
    expect(ok(repo, 'rev-parse', '--is-bare-repository')).toBe('true')
    const hook = join(repo, 'hooks', 'pre-receive')
    expect(readFileSync(hook, 'utf8')).toBe(PRE_RECEIVE_HOOK)
    expect(statSync(hook).mode & 0o111).toBe(0o111)

    const { work, two } = workTree()
    ok(work, 'push', '-q', repo, `${two}:refs/qianmo/wip/laptop/main`)
    // A second init keeps what is there.
    await initHubRepository(parseHub(root), 'atlas')
    expect(refsOf(repo)).toBe(`refs/qianmo/wip/laptop/main ${two}`)
  })
})

describe('the pre-receive hook (gate ruling 5)', () => {
  async function hub(): Promise<{
    repo: string
    work: string
    one: string
    two: string
  }> {
    const repo = await initHubRepository(
      parseHub(join(tempDir(), 'hub')),
      'atlas',
    )
    return { repo, ...workTree() }
  }

  test('accepts wip and session refs of a device: create, update, delete', async () => {
    const { repo, work, one, two } = await hub()
    ok(
      work,
      'push',
      '-q',
      '--atomic',
      repo,
      `${one}:refs/qianmo/wip/laptop/feat/x`,
      `${one}:refs/qianmo/sessions/laptop/0199a4c2-7c1e-7d32-9a5e-3b1f2c4d5e6f`,
    )
    ok(work, 'push', '-q', '-f', repo, `${two}:refs/qianmo/wip/laptop/feat/x`)
    ok(
      work,
      'push',
      '-q',
      repo,
      ':refs/qianmo/sessions/laptop/0199a4c2-7c1e-7d32-9a5e-3b1f2c4d5e6f',
    )
    expect(refsOf(repo)).toBe(`refs/qianmo/wip/laptop/feat/x ${two}`)
  })

  test.each([
    ['a branch', 'refs/heads/main'],
    ['a tag', 'refs/tags/v1'],
    ["the cloud device's wip", 'refs/qianmo/wip/cloud/main'],
    ["the cloud device's session", 'refs/qianmo/sessions/cloud/t1'],
    ['a task branch', 'refs/heads/qianmo/20261003-1'],
    ['another qianmo namespace', 'refs/qianmo/local/laptop/wip/main'],
    ['a session id with a slash', 'refs/qianmo/sessions/laptop/a/b'],
    ['a wip ref without a branch', 'refs/qianmo/wip/laptop'],
    ['a device not starting with a letter or digit', 'refs/qianmo/wip/_x/main'],
  ])('refuses %s (%s)', async (_what, ref) => {
    const { repo, work, two } = await hub()
    const result = git(work, ['push', repo, `${two}:${ref}`])
    expect(result.code).not.toBe(0)
    expect(result.err).toContain(`[qianmo handoff] refused ${ref}`)
    expect(refsOf(repo)).toBe('')
  })

  test('one refused ref fails the whole push', async () => {
    const { repo, work, two } = await hub()
    const result = git(work, [
      'push',
      repo,
      `${two}:refs/qianmo/wip/laptop/main`,
      `${two}:refs/heads/main`,
    ])
    expect(result.code).not.toBe(0)
    expect(refsOf(repo)).toBe('')
  })
})

describe('remoteInitScript (what init runs on an SSH hub)', () => {
  function runScript(
    home: string,
    script: string,
  ): { code: number; out: string; err: string } {
    const proc = Bun.spawnSync(['sh', '-s'], {
      stdin: new Blob([script]),
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    return {
      code: proc.exitCode ?? -1,
      out: proc.stdout.toString().trim(),
      err: proc.stderr.toString(),
    }
  }

  test('~/ roots go under $HOME; the repository is private; the hook is the same text', () => {
    const home = tempDir()
    const result = runScript(home, remoteInitScript('~/qianmo/repos', 'atlas'))
    expect(result.err).toBe('')
    expect(result.code).toBe(0)
    const repo = join(home, 'qianmo', 'repos', 'atlas.git')
    expect(result.out).toBe(repo)
    expect(ok(repo, 'rev-parse', '--is-bare-repository')).toBe('true')
    expect(statSync(repo).mode & 0o077).toBe(0)
    const hook = join(repo, 'hooks', 'pre-receive')
    expect(readFileSync(hook, 'utf8')).toBe(PRE_RECEIVE_HOOK)
    expect(statSync(hook).mode & 0o100).toBe(0o100)

    // Run again: the repository and its refs stay; the hook is rewritten.
    const { work, two } = workTree()
    ok(work, 'push', '-q', repo, `${two}:refs/qianmo/wip/laptop/main`)
    expect(
      runScript(home, remoteInitScript('~/qianmo/repos', 'atlas')).code,
    ).toBe(0)
    expect(refsOf(repo)).toBe(`refs/qianmo/wip/laptop/main ${two}`)
    expect(git(work, ['push', repo, `${two}:refs/heads/main`]).code).not.toBe(0)
  })

  test('an absolute root is used as is', () => {
    const home = tempDir()
    const root = join(tempDir(), 'srv', 'repos')
    const result = runScript(home, remoteInitScript(root, 'atlas'))
    expect(result.code).toBe(0)
    expect(result.out).toBe(join(root, 'atlas.git'))
  })
})

describe('hubConnection', () => {
  const base = {
    root: '/w',
    project: 'atlas',
    device: 'laptop',
    console: 'https://hub.example',
  }

  test('an SSH hub pushes with the gate key only', () => {
    const conn = hubConnection({
      ...base,
      hub: parseHub('me@hub:/srv/repos'),
      key: '/home/me/.ssh/qianmo gate',
    })
    expect(conn.url).toBe('me@hub:/srv/repos/atlas.git')
    expect(conn.env).toEqual({
      GIT_SSH_COMMAND:
        "ssh -i '/home/me/.ssh/qianmo gate' -o IdentitiesOnly=yes -o BatchMode=yes",
    })
  })

  test('an SSH hub without a key is refused; a local hub needs none', () => {
    expect(() =>
      hubConnection({ ...base, hub: parseHub('me@hub:/srv/repos') }),
    ).toThrow('--key')
    expect(hubConnection({ ...base, hub: parseHub('/srv/repos') })).toEqual({
      url: '/srv/repos/atlas.git',
      env: {},
    })
  })
})

describe('file/directory ref collisions (ruling 7)', () => {
  test('dfConflicts finds both directions and nothing else', () => {
    const refs = [
      'refs/qianmo/wip/laptop/feat',
      'refs/qianmo/wip/laptop/feat-2',
      'refs/qianmo/wip/laptop/fix/a/b',
    ]
    expect(dfConflicts(refs, 'refs/qianmo/wip/laptop/feat/x')).toEqual([
      'refs/qianmo/wip/laptop/feat',
    ])
    expect(dfConflicts(refs, 'refs/qianmo/wip/laptop/fix')).toEqual([
      'refs/qianmo/wip/laptop/fix/a/b',
    ])
    expect(dfConflicts(refs, 'refs/qianmo/wip/laptop/feat')).toEqual([])
  })

  test('pushToHub deletes the colliding wip ref first, on the hub and locally', async () => {
    const repo = await initHubRepository(
      parseHub(join(tempDir(), 'hub')),
      'atlas',
    )
    const { work, one, two } = workTree()
    const conn = { url: repo, env: {} }
    await pushToHub(conn, work, [
      { ref: 'refs/qianmo/wip/laptop/feat', sha: one },
    ])
    await pushToHub(conn, work, [
      { ref: 'refs/qianmo/wip/laptop/feat/x', sha: two },
    ])
    expect(refsOf(repo)).toBe(`refs/qianmo/wip/laptop/feat/x ${two}`)
    await pushToHub(conn, work, [
      { ref: 'refs/qianmo/wip/laptop/feat', sha: one },
    ])
    expect([...(await lsRemote(conn, work)).entries()]).toEqual([
      ['refs/qianmo/wip/laptop/feat', one],
    ])

    await updateLocalRefs(work, [
      { ref: 'refs/qianmo/local/laptop/wip/feat', sha: one },
    ])
    await updateLocalRefs(work, [
      { ref: 'refs/qianmo/local/laptop/wip/feat/x', sha: two },
    ])
    expect(
      ok(
        work,
        'for-each-ref',
        '--format=%(refname) %(objectname)',
        'refs/qianmo/',
      ),
    ).toBe(`refs/qianmo/local/laptop/wip/feat/x ${two}`)
  })

  test("the user's own hooks never run for a handoff push", async () => {
    const repo = await initHubRepository(
      parseHub(join(tempDir(), 'hub')),
      'atlas',
    )
    const { work, two } = workTree()
    const marker = join(tempDir(), 'pre-push-ran')
    const hooks = join(work, '.git', 'hooks')
    writeFileSync(
      join(hooks, 'pre-push'),
      `#!/bin/sh\ntouch '${marker}'\nexit 1\n`,
      {
        mode: 0o755,
      },
    )
    await pushToHub({ url: repo, env: {} }, work, [
      { ref: 'refs/qianmo/wip/laptop/main', sha: two },
    ])
    expect(refsOf(repo)).toBe(`refs/qianmo/wip/laptop/main ${two}`)
    expect(() => statSync(marker)).toThrow()
  })
})
