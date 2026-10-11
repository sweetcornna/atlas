// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { expect, test } from 'bun:test'
import { MemoryActionLedger } from './memoryActions.js'
import { resolveAccess } from '../src/access.js'
import type { HandoffDevicesPort } from '../src/directionPorts.js'
import {
  accountsHarness,
  asAdmin,
  asSession,
  person,
  TOKENS,
} from './accountsHarness.js'

const TOKEN = 'qmd_device-test-only'
const devices: HandoffDevicesPort = {
  authenticate: token =>
    token === TOKEN
      ? { deviceId: 'd-abcdefghijkl', owner: 'legacy:admin' }
      : null,
  pair: async input =>
    input.code === 'ABCD-EFGH-IJKL'
      ? {
          ok: true,
          value: {
            deviceId: 'd-abcdefghijkl',
            name: input.name,
            token: TOKEN,
            owner: 'legacy:admin',
            console: 'https://console.example',
          },
        }
      : { ok: false, failure: { code: 'rejected', message: '配对码无效' } },
  listDevices: async () => ({ ok: true, value: [] }),
  issuePairing: async (_actor, url) => ({
    ok: true,
    value: {
      code: 'ABCD-EFGH-IJKL',
      expiresAt: 100,
      command: `qm handoff login ${url} --code ABCD-EFGH-IJKL`,
    },
  }),
  revokeDevice: async id => ({
    ok: true,
    value: {
      deviceId: id,
      name: 'test',
      owner: 'legacy:admin',
      platform: null,
      createdAt: 1,
      lastSeenAt: null,
      revokedAt: 2,
      tasks: 0,
    },
  }),
}
const bearer = (route: string, method = 'GET', body?: unknown) =>
  new Request(`http://127.0.0.1${route}`, {
    method,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      'content-type': 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })

test('device access is capped at member and restricted to the handoff path boundary', () => {
  const access = resolveAccess(
    bearer('/v0/handoff'),
    TOKENS,
    undefined,
    true,
    devices,
  )
  expect(access.principal).toMatchObject({
    kind: 'device',
    role: 'member',
    subject: 'legacy:admin',
  })
  expect(access.credential.role).toBe('view')
  for (const route of [
    '/v0/health',
    '/',
    '/login',
    '/invite',
    '/assets/app.css',
    '/v0/handoff-other',
  ]) {
    expect(
      resolveAccess(bearer(route), TOKENS, undefined, true, devices).refusal
        ?.status,
    ).toBe(403)
  }
  expect(
    resolveAccess(
      new Request(`http://127.0.0.1/v0/handoff?token=${TOKEN}`),
      TOKENS,
      undefined,
      true,
      devices,
    ).refusal?.status,
  ).toBe(400)
})

test('only the exact pairing door is public; other handoff routes need credentials', async () => {
  const h = accountsHarness({ deps: { handoffDevices: devices } })
  const response = await h.handle(
    new Request('http://127.0.0.1/v0/handoff/pair', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'ABCD-EFGH-IJKL', name: 'laptop' }),
    }),
  )
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({
    deviceId: 'd-abcdefghijkl',
    name: 'laptop',
  })
  const refused = await h.handle(
    new Request('http://127.0.0.1/v0/handoff/pair', {
      method: 'POST',
      body: '{}',
    }),
  )
  expect(refused.status).toBe(400)
  for (const route of [
    '/v0/handoff',
    '/v0/handoff/devices',
    '/v0/handoff/git/project.git/info/refs',
    '/v0/handoff/projects',
    '/v0/handoff/task/send',
    '/v0/handoff/pair/extra',
  ]) {
    expect(
      (await h.handle(new Request(`http://127.0.0.1${route}`))).status,
    ).toBe(401)
  }
  expect((await h.handle(bearer('/v0/handoff/devices'))).status).toBe(200)
  expect(
    (await h.handle(bearer('/v0/handoff?token=qmu_not-for-urls'))).status,
  ).toBe(400)
  expect((await h.handle(bearer('/v0/health'))).status).toBe(403)
  expect((await h.handle(bearer('/login'))).status).toBe(403)
  expect(
    (
      await h.handle(
        new Request(`http://127.0.0.1/v0/handoff/pair?token=${TOKEN}`, {
          method: 'POST',
          body: '{}',
        }),
      )
    ).status,
  ).toBe(400)
})

test('viewer can list devices; pairing and revocation require member or admin; device cannot mint tokens', async () => {
  const h = accountsHarness({ deps: { handoffDevices: devices } })
  const viewer = await person(h.handle, 'viewer')
  const member = await person(h.handle, 'member')
  expect(
    (await h.handle(asSession('GET', '/v0/handoff/devices', viewer.sid)))
      .status,
  ).toBe(200)
  expect(
    (
      await h.handle(
        asSession('POST', '/v0/handoff/devices/pairing', viewer.sid),
      )
    ).status,
  ).toBe(403)
  expect(
    (
      await h.handle(
        asSession('POST', '/v0/handoff/devices/pairing', member.sid),
      )
    ).status,
  ).toBe(200)
  expect(
    (await h.handle(asAdmin('DELETE', '/v0/handoff/devices/d-abcdefghijkl')))
      .status,
  ).toBe(200)
  expect(
    (await h.handle(bearer('/v0/handoff/devices/pairing', 'POST'))).status,
  ).toBe(403)
})

test('pairing and revocation are recorded without code or token', async () => {
  const actions = new MemoryActionLedger()
  const h = accountsHarness({ deps: { handoffDevices: devices, actions } })
  expect(
    (await h.handle(asAdmin('POST', '/v0/handoff/devices/pairing'))).status,
  ).toBe(200)
  expect(
    (await h.handle(asAdmin('DELETE', '/v0/handoff/devices/d-abcdefghijkl')))
      .status,
  ).toBe(200)
  expect(actions.entries.map(entry => entry.action)).toEqual([
    'handoff.device.pair',
    'handoff.device.revoke',
  ])
  expect(JSON.stringify(actions.entries)).not.toContain('ABCD-EFGH-IJKL')
  expect(JSON.stringify(actions.entries)).not.toContain(TOKEN)
})
