// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { qianmoConfigPath } from '@qianmo/paths'
import { githubHandoffRef, type HandoffManifest } from '@qianmo/handoff'
import { generateNodeKeyPair } from '@qianmo/capability'
import type { TenantPort } from '@qianmo/console'
import { ConsoleConnectors } from '../../packages/node/src/commands/consoleConnectors.js'
import { OutboundPolicy } from '../../packages/node/src/commands/outboundPolicy.js'
import { transportPskEnvVarForNode } from '../../packages/node/src/commands/consoleArgs.js'
import type { HandoffRepoCredentials } from '../../packages/node/src/commands/handoffRepoCredentials.js'
import { accountsHarness } from '../../packages/console/test/accountsHarness.js'
import { openConsoleHandoff } from '../../packages/node/src/commands/consoleHandoff.js'
import { openConsoleHandoffDevices } from '../../packages/node/src/commands/consoleHandoffDevices.js'
import {
  loginDevice,
  deviceTokenPath,
} from '../../packages/node/src/commands/handoffDevice.js'
import { runNow } from '../../packages/node/src/commands/handoffNow.js'
import { runPull } from '../../packages/node/src/commands/handoffPull.js'
import {
  readTokenFile,
  recordSession,
} from '../../packages/node/src/commands/handoffStore.js'
import { type RepoVisibility } from '../../packages/node/src/commands/handoffGithub.js'
import {
  git,
  laptop,
  startTestNode,
} from '../../packages/node/test/commands/support/handoffNodeFixtures.js'
import {
  qmcodeRollout,
  qmcodeRolloutPath,
} from '../../packages/node/test/commands/support/handoffSamples.js'

import {
  cliPrefix,
  freePort,
  INHERITED_KEYS_TO_DROP,
} from './fixtures/handoff-processes.js'

const TOKEN = 'p26-repo-token-canary-0123456789'
const REPO_ACTOR = {
  subject: 'u:0123456789abcdef',
  role: 'ops' as const,
  requestId: 'p26c-integration',
}
const THREAD = '0199e7c2-4a51-7d30-9a1e-5b0c2f7d8e14'
const cleanups: (() => unknown)[] = []
afterEach(async () => {
  for (const clean of cleanups.splice(0).reverse()) await clean()
})

function environment(key: string, value: string): void {
  const previous = process.env[key]
  process.env[key] = value
  cleanups.push(() => {
    if (previous === undefined) delete process.env[key]
    else process.env[key] = previous
  })
}

function files(root: string): string[] {
  if (!fs.existsSync(root)) return []
  return fs.readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(root, entry.name)
    return entry.isDirectory() ? [file, ...files(file)] : [file]
  })
}

async function until(check: () => Promise<boolean>): Promise<void> {
  const end = Date.now() + 15_000
  while (!(await check())) {
    if (Date.now() > end) throw new Error('relay timed out')
    await Bun.sleep(15)
  }
}

for (const visibility of ['private', 'public', 'unknown'] as const) {
  test(`GitHub ${visibility}: pairing → now → shallow continuation → validated result → pull → branch cleanup, zero hub objects and no persisted token`, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p26-github-'))
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }))
    environment('QIANMO_CONFIG_DIR', path.join(root, 'device-config'))
    environment('QMCODE_HOME', path.join(root, 'laptop-qmcode'))
    environment('CODEX_HOME', path.join(root, 'laptop-codex'))
    environment('CODEX_THREAD_ID', THREAD)
    const work = path.join(root, 'demo')
    fs.mkdirSync(work)
    git(work, 'init', '-q', '-b', 'main')
    fs.writeFileSync(path.join(work, 'a.txt'), 'base\n')
    git(work, 'add', 'a.txt')
    git(work, 'commit', '-qm', 'base')
    // A second ancestor makes depth=1 observable, rather than a root commit
    // that would look shallow even if fetched in full.
    fs.writeFileSync(path.join(work, 'a.txt'), 'second\n')
    git(work, 'commit', '-qam', 'second')
    fs.writeFileSync(path.join(work, 'a.txt'), 'local wip\n')
    const remote = path.join(root, 'github.git')
    git(root, 'init', '--bare', '-q', remote)
    git(work, 'remote', 'add', 'origin', remote)
    const rollout = qmcodeRolloutPath(process.env.CODEX_HOME!, THREAD)
    fs.mkdirSync(path.dirname(rollout), { recursive: true })
    fs.writeFileSync(
      rollout,
      qmcodeRollout(THREAD, work, [
        { turnId: 'local-turn', user: 'finish', assistant: 'prepared' },
      ]),
    )
    await recordSession({
      cwd: work,
      tool: 'codex',
      sessionId: THREAD,
      file: rollout,
      at: Date.now(),
    })
    const argvLog = path.join(root, 'git-argv.log')
    const gitBin = Bun.which('git')!
    const bin = path.join(root, 'bin')
    fs.mkdirSync(bin)
    fs.writeFileSync(
      path.join(bin, 'git'),
      `#!/bin/sh\nprintf '%s\\n' "$@" >> "$QIANMO_GIT_ARGV_LOG"\nexec '${gitBin}' "$@"\n`,
      { mode: 0o755 },
    )
    environment('QIANMO_GIT_ARGV_LOG', argvLog)
    environment('PATH', `${bin}:${process.env.PATH}`)
    let shallow = false
    let config = ''
    let resolved = 0
    const node = await startTestNode(root, {
      bridge: { projects: [], githubRemote: () => `file://${remote}` },
      fake: {
        work: turn => {
          shallow =
            git(turn.cwd, 'rev-parse', '--is-shallow-repository') === 'true'
          config = fs.readFileSync(
            path.join(turn.cwd, '.git', 'config'),
            'utf8',
          )
          fs.writeFileSync(path.join(turn.cwd, 'cloud.txt'), 'from cloud\n')
          git(turn.cwd, 'add', 'cloud.txt')
          git(turn.cwd, 'commit', '-qm', 'cloud result')
        },
        reply: () => `completed without credentials`,
      },
    })
    cleanups.push(async () => {
      node.fake.stop()
      await node.handle.stop()
    })
    const hubRoot = path.join(root, 'hub-state')
    const hubLogs: string[] = []
    const connections = new ConsoleConnectors({
      directory: path.join(hubRoot, 'connections'),
      agents: async () => [],
      policy: new OutboundPolicy({
        lookup: async () => [{ address: '8.8.8.8', family: 4 }],
      }),
      repoFetch: async () =>
        Response.json({
          private: visibility === 'private',
          permissions: { push: true },
        }),
    })
    cleanups.push(() => connections.close())
    const saved = await connections.save(
      {
        name: 'Relay repository',
        kind: 'repo',
        preset: 'github-repo',
        settings: { repo: 'test/demo', exchange: false },
        secret: TOKEN,
        agents: [],
      },
      REPO_ACTOR,
    )
    if (!saved.ok) throw new Error('connection save failed')
    if (visibility !== 'unknown') {
      const probed = await connections.probe(saved.value.id, REPO_ACTOR)
      expect(probed.ok && probed.value.lastProbe?.ok).toBe(true)
    }
    const hub = openConsoleHandoff({
      onError: line => hubLogs.push(line),
      ledgerPath: path.join(hubRoot, 'ledger.ndjson'),
      auditPath: path.join(hubRoot, 'audit.ndjson'),
      credentials: {
        async resolve(repo, scope) {
          resolved++
          const credential = await connections.resolve(repo, scope)
          return credential
            ? { ...credential, remoteUrl: `file://${remote}` }
            : null
        },
      },
      dispatch: {
        status: 'test',
        config: {
          nodes: [{ node: node.node, url: node.handle.url, psk: node.psk }],
          from: 'qianmo://hub/console',
          issueCapability: node.issue,
          pingIntervalMs: 30,
          deliverTtlMs: 40,
          receiptTimeoutMs: 1000,
        },
      },
    })
    cleanups.push(() => hub.close())
    const devices = openConsoleHandoffDevices({
      path: path.join(hubRoot, 'devices.ndjson'),
    })
    cleanups.push(() => devices.close())
    const harness = accountsHarness({
      deps: { handoff: hub.port, handoffDevices: devices },
    })
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: harness.handle,
    })
    cleanups.push(() => server.stop(true))
    const url = `http://127.0.0.1:${server.port}`
    const pair = await devices.issuePairing(
      { subject: 'legacy:admin', role: null, requestId: 'test' },
      url,
    )
    if (!pair.ok) throw new Error('pairing failed')
    const device = await loginDevice(url, pair.value.code, 'p26-test')
    const lines: string[] = []
    expect(
      await runNow(
        work,
        { goal: 'finish' },
        { out: line => lines.push(line), err: line => lines.push(line) },
        {
          repo: 'test/demo',
          probe: async (): Promise<RepoVisibility> => visibility,
        },
      ),
    ).toBe(0)
    const listed = await hub.port.list({
      deviceId: device.deviceId,
      owner: 'legacy:admin',
    })
    if (!listed.ok || !listed.value[0]) throw new Error('task missing')
    const taskId = listed.value[0].taskId
    expect(listed.value[0]).toMatchObject({
      ownerDevice: device.deviceId,
      code: { repo: 'test/demo' },
    })
    const before = git(work, 'ls-remote', 'origin')
    expect(before).toContain(`qianmo/wip/${device.deviceId}/${taskId}`)
    if (visibility === 'private')
      expect(before).toContain(`qianmo/sessions/${device.deviceId}/${taskId}`)
    else {
      expect(before).not.toContain('qianmo/sessions/')
      expect(listed.value[0].code).toMatchObject({
        sessions: null,
        sessionsReason: expect.any(String),
      })
      expect(lines.join('\n')).toContain(
        visibility === 'public' ? '公开仓库' : '可见性未知',
      )
    }
    const headers = {
      authorization: `Bearer ${readTokenFile(deviceTokenPath())}`,
    }
    expect((await fetch(`${url}/v0/handoff/config`, { headers })).status).toBe(
      200,
    )
    expect(
      (
        await fetch(
          `${url}/v0/handoff/git/demo.git/info/refs?service=git-upload-pack`,
          { headers },
        )
      ).status,
    ).toBe(404)
    hub.start()
    await until(async () => {
      const task = await hub.port.get(taskId)
      return task.ok && task.value.state === 'done'
    })
    await node.handle.idle()
    expect(shallow).toBe(true)
    expect(node.fake.calls('thread/start').length).toBe(
      visibility === 'private' ? 0 : 1,
    )
    expect(node.fake.calls('thread/resume').length).toBe(
      visibility === 'private' ? 1 : 0,
    )
    expect(
      fs.existsSync(qianmoConfigPath('qianmo', 'handoff', 'work', taskId)),
    ).toBe(false)
    expect(fs.existsSync(path.join(node.root, 'repos'))).toBe(false)
    expect(resolved).toBeGreaterThanOrEqual(3)
    const done = await hub.port.get(taskId)
    expect(done).toMatchObject({
      ok: true,
      value: {
        code: { result: { ref: `refs/heads/qianmo/result/${taskId}` } },
      },
    })
    await expect(
      runPull(work, { taskId, repo: 'wrong/repo' }, { out() {}, err() {} }),
    ).rejects.toThrow('origin 与任务仓库不匹配')
    if (visibility === 'private' && done.ok && done.value.result) {
      git(
        work,
        'push',
        '--force',
        'origin',
        `${done.value.manifest.wip}:refs/heads/qianmo/result/${taskId}`,
      )
      await expect(
        runPull(work, { taskId, repo: 'test/demo' }, { out() {}, err() {} }),
      ).rejects.toThrow('不是结果里的')
      expect(fs.existsSync(path.join(work, 'cloud.txt'))).toBe(false)
      git(
        remote,
        'update-ref',
        `refs/heads/qianmo/result/${taskId}`,
        done.value.result.head,
      )
    }
    expect(
      await runPull(
        work,
        { taskId, repo: 'test/demo' },
        { out: line => lines.push(line), err: line => lines.push(line) },
      ),
    ).toBe(0)
    expect(fs.readFileSync(path.join(work, 'cloud.txt'), 'utf8')).toBe(
      'from cloud\n',
    )
    expect(git(work, 'ls-remote', 'origin')).not.toContain('refs/heads/qianmo/')
    expect(await hub.port.get(taskId)).toMatchObject({
      ok: true,
      value: { state: 'returned', code: { cleaned: true } },
    })
    // Repeat after the remote refs are gone still uses the already applied
    // local result and retains the recorded hashes.
    expect(
      await runPull(
        work,
        { taskId, repo: 'test/demo' },
        { out() {}, err() {} },
      ),
    ).toBe(0)
    expect(
      files(hubRoot).filter(
        file => path.basename(file) === 'objects' || file.endsWith('.pack'),
      ),
    ).toEqual([])
    const persisted = [
      ...files(node.root),
      ...files(node.qmcodeHome),
      ...files(node.appServerHome),
      ...files(hubRoot),
    ]
      .filter(file => fs.statSync(file).isFile())
      .map(file => fs.readFileSync(file, 'utf8'))
      .join('\n')
    for (const secret of [
      TOKEN,
      Buffer.from(`x-access-token:${TOKEN}`).toString('base64'),
    ]) {
      expect(persisted).not.toContain(secret)
      expect(config).not.toContain(secret)
      expect(node.logs.join('\n')).not.toContain(secret)
      expect(hubLogs.join('\n')).not.toContain(secret)
      expect(JSON.stringify(done)).not.toContain(secret)
      expect(fs.readFileSync(argvLog, 'utf8')).not.toContain(secret)
    }
  }, 30_000)
}

for (const mode of ['cli', 'connections'] as const) {
  test(`production console CLI (${mode}) chooses GitHub without handoff-root, advertises mode and never creates a bare repo`, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p26-cli-'))
    const configRoot = path.join(root, 'config')
    const repoToken = path.join(root, 'repo.token')
    const adminToken = path.join(root, 'admin.token')
    const viewToken = path.join(root, 'view.token')
    fs.writeFileSync(repoToken, TOKEN, { mode: 0o600 })
    fs.writeFileSync(adminToken, 'p26-admin-token-0123456789', { mode: 0o600 })
    fs.writeFileSync(viewToken, 'p26-view-token-0123456789', { mode: 0o600 })
    const childEnv: Record<string, string> = {}
    for (const [key, value] of Object.entries(process.env))
      if (value !== undefined) childEnv[key] = value
    for (const key of INHERITED_KEYS_TO_DROP) delete childEnv[key]
    childEnv.QIANMO_CONFIG_DIR = configRoot
    childEnv.HOME = path.join(root, 'home')
    const publicKey = generateNodeKeyPair().publicKey
    const peer = `worker=ws://127.0.0.1:${await freePort()}`
    childEnv[transportPskEnvVarForNode('worker', '--chat-url')] =
      'p26c-control-psk-01234567890123456789'
    if (mode === 'connections') {
      const book = new ConsoleConnectors({
        directory: path.join(configRoot, 'qianmo', 'console', 'connectors'),
        agents: async () => [],
      })
      const saved = await book.save(
        {
          name: 'Relay',
          kind: 'repo',
          preset: 'github-repo',
          settings: { repo: 'test/demo', exchange: false },
          secret: TOKEN,
          agents: [],
        },
        REPO_ACTOR,
      )
      book.close()
      if (!saved.ok) throw new Error('seed failed')
    }
    const port = await freePort()
    const child = Bun.spawn(
      [
        process.execPath,
        ...cliPrefix(),
        'console',
        '--port',
        String(port),
        '--accounts',
        '--admin-token-file',
        adminToken,
        '--view-token-file',
        viewToken,
        ...(mode === 'cli'
          ? ['--handoff-repo', `test/demo=${repoToken}`]
          : [
              '--connectors',
              '--approvals',
              '--chat-sign',
              '--chat-url',
              peer,
              '--control',
              peer,
              '--trust',
              `worker=${publicKey}`,
              '--handoff-node',
              peer,
            ]),
      ],
      { cwd: root, env: childEnv, stdout: 'pipe', stderr: 'pipe' },
    )
    const stdout = new Response(child.stdout).text()
    const stderr = new Response(child.stderr).text()
    try {
      const url = `http://127.0.0.1:${port}`
      const headers = { authorization: 'Bearer p26-admin-token-0123456789' }
      await until(async () => {
        try {
          return (
            (await fetch(`${url}/v0/handoff/config`, { headers })).status ===
            200
          )
        } catch {
          return false
        }
      })
      expect(
        await (await fetch(`${url}/v0/handoff/config`, { headers })).json(),
      ).toEqual({ codeStore: 'github' })
      expect(
        (
          await fetch(
            `${url}/v0/handoff/git/demo.git/info/refs?service=git-upload-pack`,
            { headers },
          )
        ).status,
      ).toBe(404)
      expect(
        files(configRoot).filter(
          file =>
            path.basename(file) === 'objects' ||
            file.endsWith('.pack') ||
            file.endsWith('.git'),
        ),
      ).toEqual([])
    } finally {
      child.kill('SIGTERM')
      const timer = setTimeout(() => child.kill('SIGKILL'), 3000)
      await child.exited
      clearTimeout(timer)
      const printed = `${await stdout}\n${await stderr}`
      expect(printed).not.toContain(TOKEN)
      fs.rmSync(root, { recursive: true, force: true })
    }
  }, 20_000)
}

async function connectionTask(tenancy?: TenantPort) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p26c-relay-'))
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }))
  const from = await laptop(root, { device: 'd-aaaaaaaaaaaa' })
  const remote = path.join(root, 'remote.git')
  git(root, 'init', '--bare', '-q', remote)
  const taskId = 'connection-task'
  const manifest: HandoffManifest = {
    ...from.manifest,
    code: {
      repo: 'test/demo',
      wip: {
        ref: githubHandoffRef('wip', from.manifest.device, taskId),
        commit: from.manifest.wip,
      },
      sessions: null,
      reason: 'test omits sessions',
    },
  }
  git(
    from.work,
    'push',
    '-q',
    remote,
    `${manifest.wip}:${manifest.code!.wip.ref}`,
  )
  const book = new ConsoleConnectors({
    directory: path.join(root, 'connections'),
    agents: async () => [],
    ...(tenancy ? { tenancy } : {}),
  })
  cleanups.push(() => book.close())
  let remoteReads = 0
  const credentials: HandoffRepoCredentials = {
    async resolve(repo, scope) {
      const credential = await book.resolve(repo, scope)
      if (!credential) return null
      remoteReads++
      return { ...credential, remoteUrl: `file://${remote}` }
    },
  }
  const options = {
    ledgerPath: path.join(root, 'hub', 'ledger.ndjson'),
    auditPath: path.join(root, 'hub', 'audit.ndjson'),
    credentials,
  }
  const save = (actor = REPO_ACTOR) =>
    book.save(
      {
        name: 'Relay',
        kind: 'repo',
        preset: 'github-repo',
        settings: { repo: 'test/demo', exchange: false },
        secret: TOKEN,
        agents: [],
      },
      actor,
    )
  return {
    root,
    book,
    options,
    manifest,
    save,
    taskId,
    reads: () => remoteReads,
  }
}

test('connection-book revocation after acceptance survives hub restart and fails dispatch before token delivery', async () => {
  const f = await connectionTask()
  const saved = await f.save()
  if (!saved.ok) throw new Error('save failed')
  const actor = { owner: REPO_ACTOR.subject, deviceId: f.manifest.device }
  const acceptedHub = openConsoleHandoff(f.options)
  cleanups.push(() => acceptedHub.close())
  expect((await acceptedHub.port.accept(f.manifest, actor)).ok).toBe(true)
  acceptedHub.close()
  expect((await f.book.remove(saved.value.id, REPO_ACTOR)).ok).toBe(true)
  const reads = f.reads()
  const hub = openConsoleHandoff({
    ...f.options,
    dispatch: {
      status: 'test',
      config: {
        nodes: [
          {
            node: 'worker',
            url: 'ws://127.0.0.1:1',
            psk: 'p26c-test-psk-01234567890123456789',
          },
        ],
        from: 'qianmo://hub/console',
        issueCapability: () => {
          throw new Error('must not deliver')
        },
        pingIntervalMs: 25,
      },
    },
  })
  cleanups.push(() => hub.close())
  hub.start()
  await until(async () => {
    const task = await hub.port.get(f.taskId, actor)
    return task.ok && task.value.state === 'failed'
  })
  expect(await hub.port.get(f.taskId, actor)).toMatchObject({
    ok: true,
    value: { state: 'failed', reason: '仓库连接已撤销' },
  })
  expect(f.reads()).toBe(reads)
  expect(
    files(f.root)
      .filter(file => fs.statSync(file).isFile())
      .map(file => fs.readFileSync(file, 'utf8'))
      .join('\n'),
  ).not.toContain(TOKEN)
}, 20_000)

test('task owner cannot borrow a different tenant repo connection at acceptance or resumed dispatch', async () => {
  const foreign = { ...REPO_ACTOR, subject: 'u:fedcba9876543210' }
  const tenancy: TenantPort = {
    read: () => ({
      revision: '1',
      config: {
        version: 1,
        hubServer: 'hub',
        tenants: [{ id: 'a' }, { id: 'b' }],
        subjects: [
          { subject: REPO_ACTOR.subject, tenant: 'a' },
          { subject: foreign.subject, tenant: 'b' },
        ],
        platformSubjects: [],
        nodes: [],
        jobs: [],
      },
    }),
    subscribe: () => () => {},
  }
  const f = await connectionTask(tenancy)
  expect((await f.save(foreign)).ok).toBe(true)
  const actor = { owner: REPO_ACTOR.subject, deviceId: f.manifest.device }
  const acceptedHub = openConsoleHandoff(f.options)
  cleanups.push(() => acceptedHub.close())
  expect(await acceptedHub.port.accept(f.manifest, actor)).toMatchObject({
    ok: false,
    failure: { message: '中枢没有这个仓库的连接' },
  })
  expect(f.reads()).toBe(0)
  const own = await f.save()
  if (!own.ok) throw new Error('save failed')
  expect((await acceptedHub.port.accept(f.manifest, actor)).ok).toBe(true)
  acceptedHub.close()
  expect((await f.book.remove(own.value.id, REPO_ACTOR)).ok).toBe(true)
  const hub = openConsoleHandoff({
    ...f.options,
    dispatch: {
      status: 'test',
      config: {
        nodes: [
          {
            node: 'worker',
            url: 'ws://127.0.0.1:1',
            psk: 'p26c-test-psk-01234567890123456789',
          },
        ],
        from: 'qianmo://hub/console',
        issueCapability: () => {
          throw new Error('must not deliver')
        },
        pingIntervalMs: 25,
      },
    },
  })
  cleanups.push(() => hub.close())
  hub.start()
  await until(async () => {
    const task = await hub.port.get(f.taskId, actor)
    return task.ok && task.value.state === 'failed'
  })
  expect(await hub.port.get(f.taskId, actor)).toMatchObject({
    ok: true,
    value: { reason: '仓库连接已撤销' },
  })
  expect(f.reads()).toBe(1)
  expect(
    await f.book.resolve('test/demo', { ownerSubject: foreign.subject }),
  ).toMatchObject({ token: TOKEN })
}, 20_000)
