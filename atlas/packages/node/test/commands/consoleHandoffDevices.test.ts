// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, expect, test, spyOn } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  AccountBook,
  type AccountRole,
  type DirectionActor,
} from '@qianmo/console'
import { openConsoleHandoffDevices } from '../../src/commands/consoleHandoffDevices.js'
import { FileLedger } from '../../src/commands/consoleAccountsStore.js'

const cleanup: (() => void)[] = []
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn()
})
function scene() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p19-devices-'))
  cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }))
  let now = 100_000
  const accounts = new FileLedger(path.join(root, 'accounts.ndjson'))
  const sessions = new FileLedger(path.join(root, 'sessions.ndjson'))
  const book = new AccountBook({ accounts, sessions, now: () => now })
  cleanup.push(() => {
    accounts.close()
    sessions.close()
  })
  const devices = openConsoleHandoffDevices({
    path: path.join(root, 'devices.ndjson'),
    accounts: book,
    now: () => now,
  })
  cleanup.push(() => devices.close())
  const person = (role: AccountRole): DirectionActor => {
    const invite = book.issueInvite({ role, issuedBy: 'legacy:admin' })
    if (!invite.ok) throw new Error('invite failed')
    const user = book.acceptInvite(invite.value.token)
    if (!user.ok) throw new Error('account failed')
    return { subject: user.value.subject, role, requestId: 'p19' }
  }
  const issue = async (actor = person('member')) => {
    const result = await devices.issuePairing(actor, 'http://127.0.0.1:1234')
    if (!result.ok) throw new Error('pairing failed')
    return { ...result.value, actor }
  }
  return {
    root,
    devices,
    book,
    person,
    issue,
    advance: (ms: number) => {
      now += ms
    },
  }
}

test('pairing is single use, secrets stay hashed, revocation and touches survive restart', async () => {
  const h = scene()
  const pairing = await h.issue()
  expect(pairing.code).toMatch(/^[A-Z2-7]{4}(?:-[A-Z2-7]{4}){2}$/)
  expect(pairing.command).toBe(
    `qm handoff login http://127.0.0.1:1234 --code ${pairing.code}`,
  )
  const paired = await h.devices.pair!(
    { code: pairing.code, name: '本机', platform: 'darwin-arm64' },
    'a',
  )
  if (!paired.ok) throw new Error('pair failed')
  expect(paired.value.deviceId).toMatch(/^d-[a-z2-7]{12}$/)
  expect(h.devices.authenticate!(paired.value.token)).toEqual({
    deviceId: paired.value.deviceId,
    owner: pairing.actor.subject,
  })
  const before = fs.readFileSync(path.join(h.root, 'devices.ndjson'), 'utf8')
  h.devices.authenticate!(paired.value.token)
  expect(fs.readFileSync(path.join(h.root, 'devices.ndjson'), 'utf8')).toBe(
    before,
  )
  expect(before).not.toContain(paired.value.token)
  expect(before).not.toContain(pairing.code.replaceAll('-', ''))
  expect(fs.statSync(path.join(h.root, 'devices.ndjson')).mode & 0o777).toBe(
    0o600,
  )
  expect(
    (
      await h.devices.pair!(
        { code: pairing.code, name: 'replay', platform: null },
        'a',
      )
    ).ok,
  ).toBe(false)
  expect(
    (await h.devices.revokeDevice(paired.value.deviceId, h.person('member')))
      .ok,
  ).toBe(false)
  expect(
    (await h.devices.revokeDevice(paired.value.deviceId, pairing.actor)).ok,
  ).toBe(true)
  expect(h.devices.authenticate!(paired.value.token)).toBeNull()
  h.devices.close()
  const restarted = openConsoleHandoffDevices({
    path: path.join(h.root, 'devices.ndjson'),
    accounts: h.book,
  })
  cleanup.push(() => restarted.close())
  expect(restarted.authenticate!(paired.value.token)).toBeNull()
})

test('expired and five mistyped codes are refused; eleven requests hit the per-address limit', async () => {
  const h = scene()
  const expiring = await h.issue()
  h.advance(600_000)
  expect(
    (
      await h.devices.pair!(
        { code: expiring.code, name: 'test', platform: null },
        'a',
      )
    ).ok,
  ).toBe(false)
  const pairing = await h.issue()
  const wrong =
    (pairing.code.startsWith('A') ? 'B' : 'A') + pairing.code.slice(1)
  for (let i = 0; i < 5; i++)
    expect(
      (
        await h.devices.pair!(
          { code: wrong, name: 'test', platform: null },
          'b',
        )
      ).ok,
    ).toBe(false)
  expect(
    (
      await h.devices.pair!(
        { code: pairing.code, name: 'test', platform: null },
        'b',
      )
    ).ok,
  ).toBe(false)
  for (let i = 0; i < 10; i++)
    await h.devices.pair!({ code: '', name: '', platform: null }, 'c')
  expect(
    (await h.devices.pair!({ code: '', name: '', platform: null }, 'c'))
      .retryAfter,
  ).toBe(60)
  h.advance(60_000)
  expect(
    (await h.devices.pair!({ code: '', name: '', platform: null }, 'c'))
      .retryAfter,
  ).toBeUndefined()
})

test('viewer cannot issue; revoked issuers invalidate otherwise active device tokens', async () => {
  const h = scene()
  expect(
    (await h.devices.issuePairing(h.person('viewer'), 'https://example.com'))
      .ok,
  ).toBe(false)
  const pairing = await h.issue()
  const paired = await h.devices.pair!(
    { code: pairing.code, name: 'test', platform: null },
    'a',
  )
  if (!paired.ok) throw new Error('pair failed')
  expect(h.devices.authenticate!(paired.value.token)).not.toBeNull()
  expect(h.book.revoke(pairing.actor.subject, 'legacy:admin').ok).toBe(true)
  expect(h.devices.authenticate!(paired.value.token)).toBeNull()
})

test('a member downgraded to viewer immediately loses device authentication', async () => {
  const h = scene()
  const pairing = await h.issue()
  const result = await h.devices.pair!(
    { code: pairing.code, name: 'test', platform: null },
    'a',
  )
  if (!result.ok) throw new Error('pair failed')
  expect(h.devices.authenticate!(result.value.token)).not.toBeNull()
  const listed = h.book.list()
  if (!listed.ok) throw new Error('book failed')
  const spy = spyOn(h.book, 'list').mockReturnValue({
    ok: true,
    value: {
      ...listed.value,
      accounts: listed.value.accounts.map(account =>
        account.subject === pairing.actor.subject
          ? { ...account, role: 'viewer' as const }
          : account,
      ),
    },
  })
  try {
    expect(h.devices.authenticate!(result.value.token)).toBeNull()
  } finally {
    spy.mockRestore()
  }
})

test('on a console without handoff the pairing dialog spells out the qmo sign-in', async () => {
  const h = scene()
  const client = openConsoleHandoffDevices({
    path: path.join(h.root, 'client-devices.ndjson'),
    accounts: h.book,
    pairWith: 'client',
  })
  cleanup.push(() => client.close())
  const result = await client.issuePairing(
    h.person('member'),
    'https://hub.example/',
  )
  if (!result.ok) throw new Error('pairing failed')
  expect(result.value.command).toBe(
    `qmo sign-in https://hub.example --code ${result.value.code}`,
  )
})
