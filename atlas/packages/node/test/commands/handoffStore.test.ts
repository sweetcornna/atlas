// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * What `qm handoff` keeps on this machine and the names it accepts (P17.4,
 * P17.3 会话定位). Files go to a throwaway `OCC_CONFIG_DIR`.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import {
  chmodSync,
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
  assertDeviceName,
  canonicalPath,
  assertProjectName,
  defaultDeviceName,
  formatHub,
  hubRepoUrl,
  loadProject,
  parseConsoleUrl,
  parseHub,
  projectsPath,
  readTokenFile,
  recordSession,
  saveProject,
  sessionFor,
  sessionsPath,
  stateDir,
} from '../handoffStore.js'

const roots: string[] = []
const savedConfigDir = process.env.OCC_CONFIG_DIR
let configDir = ''

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'qianmo-handoff-store-'))
  roots.push(dir)
  return dir
}

beforeAll(() => {
  configDir = tempDir()
  process.env.OCC_CONFIG_DIR = configDir
})

afterAll(() => {
  if (savedConfigDir === undefined) delete process.env.OCC_CONFIG_DIR
  else process.env.OCC_CONFIG_DIR = savedConfigDir
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

describe('names', () => {
  test('project and device names use the gate alphabet', () => {
    expect(assertProjectName('atlas')).toBe('atlas')
    expect(assertProjectName('qianmo-codex_2.x')).toBe('qianmo-codex_2.x')
    for (const bad of [
      '',
      '-x',
      '.x',
      'a/b',
      'a..b',
      'a.',
      'a.lock',
      'a.git',
      'a b',
      '~a',
      'x'.repeat(65),
    ]) {
      expect(() => assertProjectName(bad)).toThrow('项目名')
    }
  })

  test('the cloud device name is reserved', () => {
    expect(assertDeviceName('laptop')).toBe('laptop')
    expect(() => assertDeviceName('cloud')).toThrow('留给云端')
  })

  test('the default device name folds the short host name', () => {
    expect(defaultDeviceName('Cornna-MacBook.local')).toBe('Cornna-MacBook')
    expect(defaultDeviceName('我的电脑')).toBeNull()
    expect(defaultDeviceName('cloud.example')).toBeNull()
    expect(defaultDeviceName('--laptop--')).toBe('laptop')
  })
})

describe('parseHub', () => {
  test('an absolute path is a local hub', () => {
    expect(parseHub('/srv/qianmo/handoff/repos/')).toEqual({
      kind: 'local',
      root: '/srv/qianmo/handoff/repos',
    })
  })

  test("<target>:<path> is an SSH hub, in the gate's alphabet", () => {
    const hub = parseHub('me@hub.example:/srv/qianmo/handoff/repos/')
    expect(hub).toEqual({
      kind: 'ssh',
      target: 'me@hub.example',
      root: '/srv/qianmo/handoff/repos',
    })
    expect(formatHub(hub)).toBe('me@hub.example:/srv/qianmo/handoff/repos')
    expect(hubRepoUrl(hub, 'atlas')).toBe(
      'me@hub.example:/srv/qianmo/handoff/repos/atlas.git',
    )
    expect(parseHub('hub:~/handoff')).toEqual({
      kind: 'ssh',
      target: 'hub',
      root: '~/handoff',
    })
  })

  test('anything the gate would refuse is refused at init', () => {
    for (const bad of [
      'relative/path',
      ':/srv',
      '-oProxyCommand=x:/srv',
      'hub:',
      'hub:/srv/../etc',
      'hub:/srv/a b',
      'hub:-x',
      'hub:/srv/~x',
      'hub:/srv;rm',
    ]) {
      expect(() => parseHub(bad)).toThrow('--hub')
    }
  })
})

describe('parseConsoleUrl', () => {
  test('https anywhere, http on loopback only', () => {
    expect(parseConsoleUrl('https://hub.example:8443/')).toBe(
      'https://hub.example:8443',
    )
    expect(parseConsoleUrl('http://127.0.0.1:39000')).toBe(
      'http://127.0.0.1:39000',
    )
    expect(parseConsoleUrl('http://localhost:39000/')).toBe(
      'http://localhost:39000',
    )
    expect(() => parseConsoleUrl('http://hub.example:39000')).toThrow('https')
    expect(() => parseConsoleUrl('https://u:p@hub.example')).toThrow('用户名')
    expect(() => parseConsoleUrl('https://hub.example/?token=x')).toThrow(
      '查询串',
    )
    expect(() => parseConsoleUrl('nope')).toThrow('不是 URL')
  })
})

describe('readTokenFile', () => {
  test('reads an owner-only file, trimmed', () => {
    const file = join(tempDir(), 'token')
    writeFileSync(file, 'qm-test-token-0001\n', { mode: 0o600 })
    expect(readTokenFile(file)).toBe('qm-test-token-0001')
  })

  test('refuses a file others can read, an empty file, a directory, a missing file', () => {
    const dir = tempDir()
    const open = join(dir, 'open')
    writeFileSync(open, 'x')
    chmodSync(open, 0o644)
    expect(() => readTokenFile(open)).toThrow('chmod 600')
    const empty = join(dir, 'empty')
    writeFileSync(empty, '\n', { mode: 0o600 })
    expect(() => readTokenFile(empty)).toThrow('是空的')
    const sub = join(dir, 'sub')
    mkdirSync(sub, { mode: 0o700 })
    expect(() => readTokenFile(sub)).toThrow('不是普通文件')
    expect(() => readTokenFile(join(dir, 'missing'))).toThrow('ENOENT')
  })
})

describe('projects.json', () => {
  test('round trip, keyed by repository root, file 0600 under the config root', async () => {
    const root = join(tempDir(), 'repo')
    await saveProject({
      root,
      project: 'atlas',
      device: 'laptop',
      hub: parseHub('me@hub:/srv/repos'),
      key: '/home/me/.ssh/qianmo_gate',
      console: 'https://hub.example',
      tokenFile: '/home/me/.config/qm-token',
    })
    expect(projectsPath()).toBe(
      join(configDir, 'qianmo', 'handoff', 'projects.json'),
    )
    expect(statSync(projectsPath()).mode & 0o777).toBe(0o600)
    expect(loadProject(root)).toEqual({
      root,
      project: 'atlas',
      device: 'laptop',
      hub: { kind: 'ssh', target: 'me@hub', root: '/srv/repos' },
      key: '/home/me/.ssh/qianmo_gate',
      console: 'https://hub.example',
      tokenFile: '/home/me/.config/qm-token',
    })
    expect(loadProject(join(root, 'other'))).toBeUndefined()
    // Paths only: no credential is ever in this file.
    expect(readFileSync(projectsPath(), 'utf8')).not.toContain('token-0001')
  })
})

describe('sessions.json (会话定位)', () => {
  test('the exact directory first, else the latest report inside the repository', async () => {
    const base = tempDir()
    const repo = join(base, 'repo')
    const sub = join(repo, 'packages', 'x')
    mkdirSync(sub, { recursive: true })
    await recordSession({
      cwd: repo,
      tool: 'qmcode',
      sessionId: 'thread-a',
      file: '/q/rollout-a.jsonl',
      at: 1_000,
    })
    await recordSession({
      cwd: sub,
      tool: 'claude-code',
      sessionId: 'cc-b',
      file: '/c/b.jsonl',
      at: 2_000,
    })
    expect(sessionFor(repo, repo)?.sessionId).toBe('thread-a')
    expect(sessionFor(sub, repo)?.sessionId).toBe('cc-b')
    expect(sessionFor(join(repo, 'packages'), repo)?.sessionId).toBe('cc-b')
    expect(sessionFor(base, base)?.sessionId).toBe('cc-b')
    expect(sessionFor('/elsewhere', '/elsewhere')).toBeUndefined()
    expect(statSync(sessionsPath()).mode & 0o777).toBe(0o600)
    const stored = JSON.parse(readFileSync(sessionsPath(), 'utf8'))
    // Keyed by the resolved directory (macOS: /var → /private/var).
    expect(Object.keys(stored.sessions[canonicalPath(repo)]).sort()).toEqual([
      'at',
      'file',
      'sessionId',
      'tool',
    ])
  })

  test('a newer report from the same directory replaces the older', async () => {
    const repo = join(tempDir(), 'repo')
    mkdirSync(repo)
    await recordSession({
      cwd: repo,
      tool: 'qmcode',
      sessionId: 'one',
      file: '/1',
      at: 1,
    })
    await recordSession({
      cwd: repo,
      tool: 'qmcode',
      sessionId: 'two',
      file: '/2',
      at: 2,
    })
    expect(sessionFor(repo, repo)?.sessionId).toBe('two')
  })
})

test('stateDir is one directory per repository under the config root', () => {
  expect(stateDir('/a')).not.toBe(stateDir('/b'))
  expect(
    stateDir('/a').startsWith(join(configDir, 'qianmo', 'handoff', 'state')),
  ).toBe(true)
})
