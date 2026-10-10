// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Fixtures for the node bridge and hub dispatch tests: a laptop work tree
 * with its handoff refs, a `bwrap` stand-in, and a node bridge started next to
 * a fake app-server ({@link startFakeAppServer}).
 */

import { randomBytes } from 'node:crypto'
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { generateNodeKeyPair, type NodeKeyPair } from '@qianmo/capability'
import {
  type HandoffManifest,
  type HandoffTool,
  sessionCommit,
  sessionRef,
  shadowCommit,
  wipRef,
} from '@qianmo/handoff'
import { createConsoleWakeIssuer } from '../../../src/commands/consoleWakeIdentity.js'
import {
  type HandoffNodeHandle,
  type HandoffNodeOptions,
  startHandoffNode,
} from '../../../src/commands/handoffNode.js'
import {
  type FakeAppServer,
  type FakeAppServerOptions,
  startFakeAppServer,
} from './fakeAppServer.js'
import {
  claudeCodeTranscript,
  qmcodeRollout,
  qmcodeRolloutPath,
} from './handoffSamples.js'

export const QMCODE_SESSION = '0199e7c2-4a51-7d30-9a1e-5b0c2f7d8e14'
export const CLAUDE_SESSION = '7f3c2a10-5b6d-4e8f-9a01-23456789abcd'
const APP_SERVER_TOKEN = 'fake-app-server-capability-token-0123456789'
/** The canary shape the handoff redaction knows (`handoff-sk-key`). */
export const MODEL_KEY_CANARY = 'sk-test-canary-p175-0123456789abcdefABCDEF'

export function git(cwd: string, ...args: string[]): string {
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

/** A directory holding a `bwrap` that exits `exit` (stderr `stderr`). */
export function bwrapStub(dir: string, exit = 0, stderr = ''): string {
  const bin = join(dir, 'bwrap-bin')
  mkdirSync(bin, { recursive: true })
  const path = join(bin, 'bwrap')
  writeFileSync(
    path,
    `#!/bin/sh\n${stderr === '' ? '' : `echo '${stderr}' >&2\n`}exit ${exit}\n`,
  )
  chmodSync(path, 0o755)
  return bin
}

export interface Laptop {
  readonly work: string
  readonly manifest: HandoffManifest
  /** The two refs the hub pushes on: `<wip ref>`, `<session ref>`. */
  readonly refs: readonly [string, string]
}

/**
 * A laptop work tree (`main`, one commit, `a.txt` edited) with its shadow
 * commit and session commit under the handoff refs, as `qm handoff now` leaves
 * them before pushing.
 */
export async function laptop(
  base: string,
  options: {
    readonly tool?: HandoffTool
    readonly project?: string
    readonly device?: string
    readonly deadline?: string
  } = {},
): Promise<Laptop> {
  const tool = options.tool ?? 'qmcode'
  const device = options.device ?? 'cornna-mbp'
  const work = join(base, 'laptop')
  mkdirSync(work, { recursive: true })
  git(work, 'init', '-q', '-b', 'main')
  writeFileSync(join(work, 'a.txt'), 'one\n')
  git(work, 'add', '-A')
  git(work, 'commit', '-q', '-m', 'one')
  writeFileSync(join(work, 'a.txt'), 'one\ntwo\n')

  const sessionId = tool === 'qmcode' ? QMCODE_SESSION : CLAUDE_SESSION
  const transcript =
    tool === 'qmcode'
      ? qmcodeRolloutPath(join(base, 'laptop-qmcode'), sessionId)
      : join(base, 'laptop-claude', 'projects', 'x', `${sessionId}.jsonl`)
  mkdirSync(join(transcript, '..'), { recursive: true })
  writeFileSync(
    transcript,
    tool === 'qmcode'
      ? qmcodeRollout(sessionId, work, [
          {
            turnId: '0199e7c2-0000-7000-8000-00000000a001',
            user: '把 a.txt 读出来',
            assistant: 'a.txt 里是 one',
          },
        ])
      : claudeCodeTranscript(sessionId, work, 'complete'),
  )
  const shadow = await shadowCommit({ cwd: work })
  const session = await sessionCommit({ cwd: work, file: transcript })
  const wip = wipRef(device, 'main')
  const ref = sessionRef(device, sessionId)
  git(work, 'update-ref', wip, shadow.commit)
  git(work, 'update-ref', ref, session.commit)
  return {
    work,
    refs: [wip, ref],
    manifest: {
      kind: 'handoff',
      project: options.project ?? 'atlas',
      device,
      branch: 'main',
      wip: shadow.commit,
      tree: shadow.tree,
      tool,
      sessionId,
      sessionRef: ref,
      sessionCommit: session.commit,
      cwd: work,
      brief: {
        goal: '把 b.txt 写好',
        done: '读了 a.txt',
        remaining: '写 b.txt',
      },
      deadline:
        options.deadline ??
        new Date(Date.now() + 3_600_000).toISOString().replace(/\.\d+Z$/, 'Z'),
    },
  }
}

export interface TestNode {
  readonly node: string
  readonly root: string
  readonly qmcodeHome: string
  readonly appServerHome: string
  readonly psk: string
  readonly keys: NodeKeyPair
  readonly issue: ReturnType<typeof createConsoleWakeIssuer>
  readonly handle: HandoffNodeHandle
  readonly fake: FakeAppServer
  readonly logs: string[]
  repo(project?: string): string
}

/**
 * A node bridge named `node` under `<base>/node`, trusting the issuer `hub`,
 * with a fake app-server. The `bwrap` check passes on a stub.
 */
export async function startTestNode(
  base: string,
  options: {
    readonly node?: string
    readonly fake?: Omit<FakeAppServerOptions, 'token' | 'qmcodeHome'>
    readonly bridge?: Partial<HandoffNodeOptions>
    readonly psk?: string
    readonly keys?: NodeKeyPair
  } = {},
): Promise<TestNode> {
  const node = options.node ?? 'cloud-a'
  const root = join(base, 'node')
  const qmcodeHome = join(base, 'node-qmcode-home')
  const appServerHome = join(base, 'node-home')
  const tokenFile = join(base, 'app-server-token')
  writeFileSync(tokenFile, `${APP_SERVER_TOKEN}\n`, { mode: 0o600 })
  const fake = startFakeAppServer({
    token: APP_SERVER_TOKEN,
    qmcodeHome,
    ...options.fake,
  })
  const psk = options.psk ?? randomBytes(32).toString('hex')
  const keys = options.keys ?? generateNodeKeyPair()
  const logs: string[] = []
  const handle = await startHandoffNode({
    node,
    root,
    port: 0,
    bind: '127.0.0.1',
    trusted: [['hub', keys.publicKey]],
    projects: ['atlas'],
    appServerUrl: fake.url,
    appServerTokenFile: tokenFile,
    qmcodeHome,
    appServerHome,
    psk,
    env: { PATH: bwrapStub(base) },
    log: line => logs.push(line),
    receiptTimeoutMs: 1_000,
    turnEndWaitMs: 1_000,
    ...options.bridge,
  })
  return {
    node,
    root,
    qmcodeHome,
    appServerHome,
    psk,
    keys,
    issue: createConsoleWakeIssuer('hub', keys),
    handle,
    fake,
    logs,
    repo: (project = 'atlas') => join(root, 'repos', `${project}.git`),
  }
}

/** Branches, tags and remote-tracking refs of a repository, and its remotes. */
export function repositoryShape(repo: string): {
  readonly refs: readonly string[]
  readonly remotes: string
} {
  const refs = git(
    repo,
    'for-each-ref',
    '--format=%(refname)',
    'refs/heads',
    'refs/tags',
    'refs/remotes',
  )
  return {
    refs: refs === '' ? [] : refs.split('\n'),
    remotes: git(repo, 'remote'),
  }
}
