// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import codexStop from '../../packages/node/test/commands/support/fixtures/codex-0.162-stop.json' with {
  type: 'json',
}
import { expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { transportPskEnvVarForNode } from '@qianmo/node/commands/consoleArgs.js'
import { startTestNode } from '../../packages/node/test/commands/support/handoffNodeFixtures.js'
import { qmcodeRollout } from '../../packages/node/test/commands/support/handoffSamples.js'
import {
  cliPrefix,
  freePort,
  INHERITED_KEYS_TO_DROP,
  startHandoffConsole,
  stopConsole,
  waitForConsole,
} from './fixtures/handoff-processes.js'

const THREAD = '01a129f3-aaaa-7000-8000-123456789012'

async function qm(
  cwd: string,
  env: Record<string, string>,
  args: readonly string[],
  stdin?: string,
) {
  const proc = Bun.spawn(
    [process.execPath, ...cliPrefix(), 'handoff', ...args],
    {
      cwd,
      env,
      stdin: stdin === undefined ? 'ignore' : new Blob([stdin]),
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { stdout, stderr, code }
}

function git(cwd: string, args: readonly string[]): string {
  const proc = Bun.spawnSync(
    [
      'git',
      '-c',
      'user.name=P19',
      '-c',
      'user.email=p19@example.invalid',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    { cwd, stdout: 'pipe', stderr: 'pipe' },
  )
  if (proc.exitCode !== 0) throw new Error(proc.stderr.toString())
  return proc.stdout.toString().trim()
}

test('real console pairing → login → implicit HTTPS now → fake node done → pull returns Codex session', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p19-plugin-e2e-'))
  const work = path.join(root, 'atlas')
  fs.mkdirSync(work)
  git(work, ['init', '-q', '-b', 'main'])
  fs.writeFileSync(path.join(work, 'a.txt'), 'one\n')
  git(work, ['add', 'a.txt'])
  git(work, ['commit', '-qm', 'one'])
  fs.writeFileSync(path.join(work, 'a.txt'), 'half done\n')
  const base: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env))
    if (value !== undefined) base[key] = value
  for (const key of [
    ...INHERITED_KEYS_TO_DROP,
    'CODEX_HOME',
    'CODEX_THREAD_ID',
  ])
    delete base[key]
  base.HOME = path.join(root, 'home')
  base.CLAUDE_CONFIG_DIR = path.join(root, 'claude')
  base.PI_CONFIG_DIR = path.join(root, 'omp')
  base.GIT_CONFIG_NOSYSTEM = '1'
  base.GIT_CONFIG_GLOBAL = path.join(root, 'gitconfig')
  fs.writeFileSync(base.GIT_CONFIG_GLOBAL, '')
  const laptop = {
    ...base,
    QIANMO_CONFIG_DIR: path.join(root, 'laptop'),
    CODEX_HOME: path.join(root, 'codex'),
    QMCODE_HOME: path.join(root, 'qmcode'),
    CODEX_THREAD_ID: THREAD,
  }
  const rollout = path.join(
    laptop.CODEX_HOME,
    'sessions',
    '2026',
    '10',
    '11',
    `rollout-2026-10-11T10-00-00-${THREAD}.jsonl`,
  )
  fs.mkdirSync(path.dirname(rollout), { recursive: true })
  fs.writeFileSync(
    rollout,
    qmcodeRollout(THREAD, work, [
      { turnId: 'p19-turn', user: 'finish', assistant: 'half done' },
    ]),
  )
  const hubEnv: Record<string, string> = {
    ...base,
    QIANMO_CONFIG_DIR: path.join(root, 'hub-config'),
  }
  const identityProc = Bun.spawn(
    [process.execPath, ...cliPrefix(), 'console', '--print-wake-identity'],
    { cwd: root, env: hubEnv, stdout: 'pipe', stderr: 'pipe' },
  )
  const identity = await new Response(identityProc.stdout).text()
  expect(await identityProc.exited).toBe(0)
  const publicKey = identity.trim().slice('console='.length)
  const node = await startTestNode(root, {
    fake: {
      work: turn =>
        fs.writeFileSync(path.join(turn.cwd, 'cloud.txt'), 'from cloud\n'),
    },
    bridge: { trusted: [['console', publicKey]] },
  })
  hubEnv[transportPskEnvVarForNode(node.node, 'test')] = node.psk
  const adminToken = 'p19-e2e-admin-credential'
  const admin = path.join(root, 'admin.token')
  const view = path.join(root, 'view.token')
  fs.writeFileSync(admin, adminToken, { mode: 0o600 })
  fs.writeFileSync(view, 'p19-e2e-view-credential', { mode: 0o600 })
  const port = await freePort()
  const hub = startHandoffConsole({
    port,
    handoffRoot: path.join(root, 'hub-repos'),
    adminTokenFile: admin,
    viewTokenFile: view,
    cwd: root,
    env: hubEnv,
    extraArgs: [
      '--accounts',
      '--handoff-node',
      `${node.node}=${node.handle.url}`,
      '--handoff-node-git',
      `${node.node}=${path.join(node.root, 'repos')}`,
    ],
  })
  const url = `http://127.0.0.1:${port}`
  try {
    await waitForConsole(hub, port, 30_000)
    const issued = await fetch(`${url}/v0/handoff/devices/pairing`, {
      method: 'POST',
      headers: { authorization: `Bearer ${adminToken}` },
    })
    expect(issued.status).toBe(200)
    const pairing = (await issued.json()) as { pairing: { code: string } }
    const login = await qm(work, laptop, [
      'login',
      url,
      '--code',
      pairing.pairing.code,
      '--name',
      'integration',
    ])
    expect(login).toMatchObject({ code: 0, stderr: '' })
    const device = JSON.parse(
      fs.readFileSync(
        path.join(laptop.QIANMO_CONFIG_DIR, 'qianmo', 'handoff', 'device.json'),
        'utf8',
      ),
    ) as { deviceId: string }
    expect(login.stdout).toContain(device.deviceId)
    expect(
      (await qm(work, laptop, ['login', url, '--code', pairing.pairing.code]))
        .code,
    ).toBe(1)
    const sync = await qm(
      work,
      laptop,
      ['sync', '--hook', 'auto'],
      JSON.stringify({
        ...codexStop,
        session_id: THREAD,
        transcript_path: rollout,
        cwd: work,
      }),
    )
    expect(sync).toEqual({ code: 0, stdout: '', stderr: '' })
    expect(
      fs.readFileSync(
        path.join(laptop.QIANMO_CONFIG_DIR, 'qianmo', 'handoff', 'sync.log'),
        'utf8',
      ),
    ).toContain('"tool":"codex"')
    const sessionBlob = git(work, [
      '--git-dir',
      path.join(root, 'hub-repos', 'atlas.git'),
      'show',
      `refs/qianmo/sessions/${device.deviceId}/${THREAD}:${path.basename(rollout)}`,
    ])
    expect(sessionBlob).toContain('half done')
    const now = await qm(work, laptop, [
      'now',
      '--goal',
      'finish',
      '--done',
      'half done',
      '--remaining',
      'write cloud.txt',
    ])
    expect(now.code).toBe(0)
    expect(now.stdout).toContain('已落地，可以关机')
    const query = async () => {
      const response = await fetch(`${url}/v0/handoff`, {
        headers: { authorization: `Bearer ${adminToken}` },
      })
      expect(response.status).toBe(200)
      return (
        (await response.json()) as {
          tasks: {
            taskId: string
            state: string
            ownerDevice: string
            ownerSubject: string
            manifest: { tool: string }
          }[]
        }
      ).tasks[0]!
    }
    let task = await query()
    expect(task.ownerDevice).toBe(device.deviceId)
    expect(task.ownerSubject).toBe('legacy:admin')
    expect(task.manifest.tool).toBe('codex')
    const deadline = Date.now() + 20_000
    while (
      task.state !== 'done' &&
      task.state !== 'failed' &&
      Date.now() < deadline
    ) {
      await Bun.sleep(30)
      task = await query()
    }
    expect(task.state).toBe('done')
    const second = await fetch(`${url}/v0/handoff/devices/pairing`, {
      method: 'POST',
      headers: { authorization: `Bearer ${adminToken}` },
    })
    const secondPairing = (await second.json()) as { pairing: { code: string } }
    expect(
      (
        await qm(work, laptop, [
          'login',
          url,
          '--code',
          secondPairing.pairing.code,
          '--force',
          '--name',
          'replacement',
        ])
      ).code,
    ).toBe(0)
    const status = await qm(work, laptop, ['status'])
    expect(status.code).toBe(0)
    expect(status.stdout).toContain(task.taskId)
    const pull = await qm(work, laptop, ['pull'])
    expect(pull.code).toBe(0)
    expect(pull.stdout).toContain('codex resume')
    expect(fs.readFileSync(path.join(work, 'cloud.txt'), 'utf8')).toBe(
      'from cloud\n',
    )
    expect((await query()).state).toBe('returned')
    const identity = await qm(work, laptop, ['whoami'])
    expect(identity.stdout).toContain('replacement')
    expect(identity.stdout).not.toContain(
      fs
        .readFileSync(
          path.join(
            laptop.QIANMO_CONFIG_DIR,
            'qianmo',
            'handoff',
            'device.token',
          ),
          'utf8',
        )
        .trim(),
    )

    expect(
      fs.statSync(
        path.join(
          laptop.QIANMO_CONFIG_DIR,
          'qianmo',
          'handoff',
          'device.token',
        ),
      ).mode & 0o777,
    ).toBe(0o600)
    expect((await qm(work, laptop, ['logout'])).code).toBe(0)
    expect(
      fs.existsSync(
        path.join(laptop.QIANMO_CONFIG_DIR, 'qianmo', 'handoff', 'device.json'),
      ),
    ).toBe(false)
    expect(
      fs.existsSync(
        path.join(
          laptop.QIANMO_CONFIG_DIR,
          'qianmo',
          'handoff',
          'device.token',
        ),
      ),
    ).toBe(false)
  } finally {
    await stopConsole(hub)
    await node.handle.stop()
    node.fake.stop()
    fs.rmSync(root, { recursive: true, force: true })
  }
}, 60_000)
