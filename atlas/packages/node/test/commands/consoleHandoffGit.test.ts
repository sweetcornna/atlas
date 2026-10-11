// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { accountsHarness } from '../../../console/test/accountsHarness.js'
import { openConsoleHandoffDevices } from '../../src/commands/consoleHandoffDevices.js'
import { openConsoleHandoffGit } from '../../src/commands/consoleHandoffGit.js'
import { PRE_RECEIVE_HOOK } from '../../src/commands/handoffHub.js'

async function git(cwd: string, args: readonly string[], token?: string) {
  const proc = Bun.spawn(
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
    {
      cwd,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        ...(token === undefined
          ? {}
          : {
              GIT_CONFIG_COUNT: '1',
              GIT_CONFIG_KEY_0: 'http.extraHeader',
              GIT_CONFIG_VALUE_0: `Authorization: Bearer ${token}`,
            }),
      },
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

test('real git HTTP: push/fetch, device hook, anonymous/revoked token and project owner isolation', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p19-git-'))
  const h = accountsHarness()
  const devices = openConsoleHandoffDevices({
    path: path.join(root, 'devices.ndjson'),
    accounts: h.book,
  })
  const hub = openConsoleHandoffGit(
    path.join(root, 'repos'),
    path.join(root, 'projects.ndjson'),
  )
  const routed = accountsHarness({
    tokens: { admin: 'p19-admin', view: 'p19-view' },
    deps: { handoffDevices: devices, handoffGit: hub },
  })
  const handle = routed.handle
  const statuses: number[] = []
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async (request, server) => {
      const response = await handle(request)
      statuses.push(response.status)
      return response
    },
  })
  const url = `http://127.0.0.1:${server.port}`
  const actor = {
    subject: 'legacy:admin',
    role: null,
    requestId: 'test',
  } as const
  const pair = async () => {
    const issued = await devices.issuePairing(actor, url)
    if (!issued.ok) throw new Error('issue failed')
    const paired = await devices.pair!(
      { code: issued.value.code, name: 'git-client', platform: null },
      crypto.randomUUID(),
    )
    if (!paired.ok) throw new Error('pair failed')
    return paired.value
  }
  try {
    const own = await pair()
    expect(
      (
        await fetch(`${url}/v0/handoff/projects`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${own.token}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ project: 'atlas' }),
        })
      ).status,
    ).toBe(201)
    const work = path.join(root, 'work')
    fs.mkdirSync(work)
    expect((await git(work, ['init', '-q', '-b', 'main'])).code).toBe(0)
    fs.writeFileSync(path.join(work, 'a.txt'), 'own\n')
    await git(work, ['add', 'a.txt'])
    await git(work, ['commit', '-qm', 'one'])
    const remote = `${url}/v0/handoff/git/atlas.git`
    const ownRef = `refs/qianmo/wip/${own.deviceId}/main`
    expect(
      (await git(work, ['push', remote, `HEAD:${ownRef}`], own.token)).code,
    ).toBe(0)
    const listing = await git(work, ['ls-remote', remote], own.token)
    expect(listing.code).toBe(0)
    expect(listing.stdout).toContain(ownRef)
    const sha = listing.stdout.split('\t')[0]!
    const packet = (line: string) =>
      `${(Buffer.byteLength(line) + 4).toString(16).padStart(4, '0')}${line}`
    const rpc = `${packet(`want ${sha}\n`)}0000${packet('done\n')}`
    const packed = await fetch(`${remote}/git-upload-pack`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${own.token}`,
        'content-type': 'application/x-git-upload-pack-request',
        'content-encoding': 'gzip',
      },
      body: Bun.gzipSync(rpc),
    })
    expect(packed.headers.get('content-type')).toBe(
      'application/x-git-upload-pack-result',
    )
    expect(packed.headers.get('cache-control')).toBe('no-cache')
    expect(
      Buffer.from(await packed.arrayBuffer()).includes(Buffer.from('PACK')),
    ).toBe(true)

    expect(
      (
        await git(
          work,
          ['fetch', remote, `${ownRef}:refs/heads/fetched`],
          own.token,
        )
      ).code,
    ).toBe(0)
    expect((await git(work, ['show', 'fetched:a.txt'])).stdout).toBe('own\n')
    // An old hook is upgraded before the next transport operation.
    fs.writeFileSync(
      path.join(root, 'repos', 'atlas.git', 'hooks', 'pre-receive'),
      '#!/bin/sh\nexit 0\n',
    )
    const other = await pair()
    const refused = await git(
      work,
      ['push', remote, `HEAD:refs/qianmo/wip/${other.deviceId}/main`],
      own.token,
    )
    expect(refused.code).not.toBe(0)
    expect(refused.stderr).toContain('pre-receive hook declined')
    expect(
      fs.readFileSync(
        path.join(root, 'repos', 'atlas.git', 'hooks', 'pre-receive'),
        'utf8',
      ),
    ).toBe(PRE_RECEIVE_HOOK)
    const anonymous = await git(work, ['ls-remote', remote])
    expect(anonymous.code).not.toBe(0)
    expect(statuses).toContain(401)
    // A real second account owns no project, although its device is valid.
    const invite = h.book.issueInvite({
      role: 'member',
      issuedBy: 'legacy:admin',
    })
    if (!invite.ok) throw new Error('invite failed')
    const person = h.book.acceptInvite(invite.value.token)
    if (!person.ok) throw new Error('person failed')
    const issued = await devices.issuePairing(
      { subject: person.value.subject, role: 'member', requestId: 'test' },
      url,
    )
    if (!issued.ok) throw new Error('issue failed')
    const stranger = await devices.pair!(
      { code: issued.value.code, name: 'stranger', platform: null },
      'stranger',
    )
    if (!stranger.ok) throw new Error('pair failed')
    const forbidden = await git(
      work,
      ['ls-remote', remote],
      stranger.value.token,
    )
    expect(forbidden.code).not.toBe(0)
    expect(forbidden.stderr).toContain('403')
    await devices.revokeDevice(own.deviceId, actor)
    const revoked = await git(work, ['ls-remote', remote], own.token)
    expect(revoked.code).not.toBe(0)
    expect(statuses.at(-1)).toBe(401)
  } finally {
    server.stop(true)
    devices.close()
    hub.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
}, 30_000)
