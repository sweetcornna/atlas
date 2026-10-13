// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { expect, test } from 'bun:test'
import {
  ADDRESS,
  accountsHarness,
  asAdmin,
  asSession,
  person,
} from './accountsHarness.js'

const FROM = 'qianmo://console/operator'

test('signed HTTP wake and chat reject forged senders before invoking either port', async () => {
  const h = accountsHarness({ deps: { signedFrom: FROM } })
  const opened = await h.handle(
    asAdmin('POST', '/v0/chat/sessions', { target: ADDRESS }),
  )
  const session = (await opened.json()) as { id: string }
  for (const from of [
    'qianmo://other/operator',
    'qianmo://console/other',
    null,
  ]) {
    const wake = await h.handle(
      asAdmin('POST', '/v0/wake', {
        from,
        to: ADDRESS,
        prompt: 'spoof',
        url: '',
      }),
    )
    const chat = await h.handle(
      asAdmin('POST', `/v0/chat/sessions/${session.id}/messages`, {
        from,
        text: 'spoof',
      }),
    )
    expect(wake.status).toBeGreaterThanOrEqual(400)
    expect(chat.status).toBe(403)
    expect(await chat.json()).toMatchObject({
      error: { code: 'E_SENDER_MISMATCH' },
    })
    if (typeof from === 'string') {
      expect(wake.status).toBe(403)
      expect(await wake.json()).toMatchObject({
        error: { code: 'E_SENDER_MISMATCH' },
      })
    }
  }
  expect(h.wake.sent).toBe(0)
  expect(h.chat.sends).toBe(0)
})

test('signed HTTP sender binding keeps member chat and the admin-only wake guard', async () => {
  const h = accountsHarness({ deps: { signedFrom: FROM } })
  const member = await person(h.handle, 'member')
  const opened = await h.handle(
    asSession('POST', '/v0/chat/sessions', member.sid, {
      body: { target: ADDRESS },
    }),
  )
  expect(opened.status).toBe(200)
  const session = (await opened.json()) as { id: string }
  for (const body of [
    { text: 'normal' },
    { from: FROM, text: 'explicit sender' },
  ]) {
    const sent = await h.handle(
      asSession(
        'POST',
        `/v0/chat/sessions/${session.id}/messages`,
        member.sid,
        { body },
      ),
    )
    expect(sent.status).toBe(200)
  }
  const wake = await h.handle(
    asSession('POST', '/v0/wake', member.sid, {
      body: { from: FROM, to: ADDRESS, prompt: 'wake', url: '' },
    }),
  )
  expect(wake.status).toBe(403)
  expect(h.chat.sends).toBe(2)
  expect(h.wake.sent).toBe(0)
})

test('HTTP wake accepts the configured signed sender and preserves free senders without a signing identity', async () => {
  const signed = accountsHarness({ deps: { signedFrom: FROM } })
  const unsigned = accountsHarness()
  for (const [h, from] of [
    [signed, FROM],
    [unsigned, 'qianmo://other/operator'],
  ] as const) {
    const wake = await h.handle(
      asAdmin('POST', '/v0/wake', {
        from,
        to: ADDRESS,
        prompt: 'wake',
        url: '',
      }),
    )
    expect(wake.status).toBe(200)
    expect(h.wake.sent).toBe(1)
  }
})
