// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 形象: the figure model (`src/avatar.ts`), its drawing (`src/view/avatar.ts`),
 * the two routes (`src/routes/avatars.ts`) and where 对话 draws it.
 */

import { describe, expect, test } from 'bun:test'
import {
  AVATAR_ACCESSORIES,
  AVATAR_COLORS,
  AVATAR_EYES,
  AVATAR_MATERIALS,
  AVATAR_MOUTHS,
  AVATAR_SHAPES,
  AVATAR_STATES,
  type AvatarSpec,
  defaultAvatar,
  parseAvatar,
  parseAvatarKey,
} from '../src/avatar.js'
import type { ChatSession, ChatTurn } from '../src/deps.js'
import { createConsoleHandler } from '../src/http.js'
import {
  AVATAR_CSS,
  avatarSvg,
  renderAvatarEditor,
} from '../src/view/avatar.js'
import {
  type ChatFaces,
  faceState,
  renderChatThread,
} from '../src/view/chat.js'
import {
  ADDRESS,
  accountsHarness,
  asSession,
  person,
} from './accountsHarness.js'
import { FakeAvatars } from './directionFakes.js'
import { MemoryActionLedger } from './memoryActions.js'
import {
  ADMIN,
  browse,
  call,
  NOW,
  pageHarness,
  TOKENS,
  VIEW,
} from './pageHarness.js'

const SPEC: AvatarSpec = {
  shape: 'cloud',
  color: 'mist',
  material: 'plush',
  eyes: 'dot',
  mouth: 'none',
  cheeks: false,
  accessory: 'beret',
}

const KEY = `agent:${ADDRESS}`

interface AvatarsBody {
  readonly editable: boolean
  readonly avatars: Record<
    string,
    {
      readonly spec: AvatarSpec
      readonly saved: boolean
      readonly updatedAt: number | null
    }
  >
}

async function bodyOf(response: Response): Promise<AvatarsBody> {
  return (await response.json()) as AvatarsBody
}

describe('形象 · the figure', () => {
  test('a default is a valid figure, the same for one seed, and varies across seeds', () => {
    const seen = new Set<string>()
    for (let index = 0; index < 200; index += 1) {
      const seed = `qianmo://node-${index}/agent`
      const spec = defaultAvatar(seed)
      expect(parseAvatar(spec)).toEqual(spec)
      expect(defaultAvatar(seed)).toEqual(spec)
      seen.add(JSON.stringify(spec))
    }
    expect(seen.size).toBeGreaterThan(150)
  })

  test('a saved figure is only ever the closed lists', () => {
    expect(parseAvatar(SPEC)).toEqual(SPEC)
    expect(parseAvatar({ ...SPEC, extra: '<script>' })).toEqual(SPEC)
    for (const bad of [
      null,
      [],
      'cloud',
      { ...SPEC, shape: 'square' },
      { ...SPEC, color: '#fff' },
      { ...SPEC, cheeks: 'yes' },
      { ...SPEC, accessory: undefined },
      { ...SPEC, eyes: '<b>' },
    ]) {
      expect(parseAvatar(bad)).toBeNull()
    }
  })

  test('a key names an agent by address or a person by subject, nothing else', () => {
    expect(parseAvatarKey(KEY)).toBe(KEY)
    expect(parseAvatarKey('user:u:0000000000000001')).toBe(
      'user:u:0000000000000001',
    )
    for (const bad of ['agent:tokyo-1', 'user:', 'other:x', 'user:a b', '']) {
      expect(parseAvatarKey(bad)).toBeNull()
    }
    expect(parseAvatarKey(`user:${'x'.repeat(400)}`)).toBeNull()
  })

  test('every choice draws, rich and flat, with no hole in the markup', () => {
    const lists = [
      ['shape', AVATAR_SHAPES],
      ['color', AVATAR_COLORS],
      ['material', AVATAR_MATERIALS],
      ['eyes', AVATAR_EYES],
      ['mouth', AVATAR_MOUTHS],
      ['accessory', AVATAR_ACCESSORIES],
    ] as const
    for (const [field, values] of lists) {
      for (const value of values) {
        for (const shape of AVATAR_SHAPES) {
          const spec = { ...SPEC, shape, [field]: value } as AvatarSpec
          for (const markup of [
            avatarSvg(spec, { size: 40 }),
            avatarSvg(spec, { size: 160, uid: 'u1', live: true }),
          ]) {
            const label = `${field}=${value} ${shape}`
            expect(`${label} ${/undefined|NaN|Infinity/.test(markup)}`).toBe(
              `${label} false`,
            )
            expect(markup.startsWith('<svg ')).toBe(true)
            expect(markup.endsWith('</svg>')).toBe(true)
          }
        }
      }
    }
  })

  test('flat has no definitions to collide; rich names its own after uid', () => {
    const flat = avatarSvg(SPEC, { size: 30 })
    expect(flat).not.toContain('url(')
    expect(flat).not.toContain(' id="')
    expect(flat).not.toContain('av-live')
    const rich = avatarSvg(SPEC, { size: 160, uid: 'g7', live: true })
    expect(rich).toContain('id="g7-b"')
    expect(rich).toContain('url(#g7-b)')
    expect(rich).toContain('feTurbulence')
    expect(rich).toContain('class="avatar av-live"')
    // Nothing is fetched: every reference points into the figure itself.
    for (const match of rich.matchAll(/url\(([^)]*)\)/g)) {
      expect(match[1]?.startsWith('#g7-')).toBe(true)
    }
    const matte = avatarSvg(
      { ...SPEC, material: 'matte' },
      { size: 160, uid: 'g8' },
    )
    expect(matte).not.toContain('feTurbulence')
    expect(matte).not.toContain('av-live')
  })

  test('a named figure is an image with an escaped name; an unnamed one is hidden', () => {
    expect(avatarSvg(SPEC, { size: 30, label: '<x> & y' })).toContain(
      'role="img" aria-label="&lt;x&gt; &amp; y"',
    )
    expect(avatarSvg(SPEC, { size: 30 })).toContain('aria-hidden="true"')
  })

  test('the breath and the blink hold still under reduced motion', () => {
    const reduced = AVATAR_CSS.slice(
      AVATAR_CSS.indexOf('@media (prefers-reduced-motion: reduce)'),
    )
    expect(reduced).toContain('animation: none')
    expect(AVATAR_CSS).not.toContain('url(')
  })

  test('the editor draws every choice as the figure it would make', () => {
    const html = renderAvatarEditor(SPEC, 'planner')
    expect(html).toContain(
      `data-spec="${'{&quot;shape&quot;:&quot;cloud&quot;'}`,
    )
    expect(html.match(/name="shape"/g)?.length).toBe(AVATAR_SHAPES.length)
    expect(html.match(/name="color"/g)?.length).toBe(AVATAR_COLORS.length)
    // One live figure on the stage; every choice is a small chip.
    expect(html.match(/class="avatar av-live/g)?.length).toBe(1)
    expect(html.match(/class="av-opt"/g)?.length).toBe(
      AVATAR_SHAPES.length +
        AVATAR_MATERIALS.length +
        AVATAR_EYES.length +
        AVATAR_MOUTHS.length +
        2 +
        AVATAR_ACCESSORIES.length,
    )
    expect(html).toContain('name="shape" value="cloud" checked')
    expect(html).toContain('name="cheeks" value="off" checked')
    expect(html).toContain('雾蓝云')
    // Every state can be tried on the stage.
    for (const state of AVATAR_STATES) {
      expect(html).toContain(`data-action="avatar-state" data-state="${state}"`)
    }
  })
})

const SESSION: ChatSession = {
  id: 'session-1',
  target: ADDRESS,
  node: 'tokyo-1',
  agent: 'planner',
  createdAt: NOW,
  updatedAt: NOW,
  turnCount: 2,
  preview: '好的',
}

const TURNS: readonly ChatTurn[] = [
  {
    id: 't1',
    sessionId: 'session-1',
    author: 'operator',
    at: NOW,
    text: '整理今天的计划',
    state: 'read',
  },
  {
    id: 't2',
    sessionId: 'session-1',
    author: 'agent',
    at: NOW + 1000,
    text: '好的',
    state: 'done',
  },
]

function faces(editable: boolean): ChatFaces {
  return {
    agent: () => SPEC,
    self: { ...SPEC, shape: 'capsule', color: 'sage' },
    selfKey: 'user:legacy:admin',
    editable,
  }
}

describe('形象 · in 对话', () => {
  test('each turn wears its author: the agent its figure, the reader theirs', () => {
    const html = renderChatThread({
      transcript: { session: SESSION, turns: TURNS },
      failure: null,
      target: null,
      now: NOW,
      faces: faces(true),
    })
    expect(html.match(/class="turn-av turn-av-face"/g)?.length).toBe(2)
    expect(html).toContain('data-action="avatar-edit"')
    expect(html).toContain(`data-key="agent:${ADDRESS}"`)
    // The header's figure is the live one; the turns' are still.
    expect(html.match(/av-live/g)?.length).toBe(1)
  })

  test('without the right to change figures there is no button, and without faces the letters', () => {
    const still = renderChatThread({
      transcript: { session: SESSION, turns: TURNS },
      failure: null,
      target: null,
      now: NOW,
      faces: faces(false),
    })
    expect(still).not.toContain('data-action="avatar-edit"')
    expect(still).toContain('class="chat-head-face"')
    const letters = renderChatThread({
      transcript: { session: SESSION, turns: TURNS },
      failure: null,
      target: null,
      now: NOW,
    })
    expect(letters).not.toContain('<svg class="avatar')
    expect(letters).toContain(
      '<span class="turn-av" aria-hidden="true">pl</span>',
    )
  })

  test('the figure does what the conversation says', () => {
    const online = {
      address: ADDRESS,
      node: 'tokyo-1',
      agent: 'planner',
      endpoint: 'ws://127.0.0.1:1/',
      status: 'online',
      dialable: true,
    } as const
    const sent: ChatTurn = { ...(TURNS[0] as ChatTurn), state: 'delivered' }
    const read: ChatTurn = { ...sent, state: 'read' }
    const reply = TURNS[1] as ChatTurn
    expect(faceState([], online, false, NOW)).toBe('idle')
    expect(faceState([sent], online, false, NOW)).toBe('listening')
    expect(faceState([read], online, false, NOW)).toBe('thinking')
    expect(faceState([read, reply], online, false, NOW + 5_000)).toBe('happy')
    expect(faceState([read, reply], online, false, NOW + 60_000)).toBe('idle')
    expect(faceState([{ ...sent, state: 'failed' }], online, false, NOW)).toBe(
      'error',
    )
    // Not in the roster, or not dialable: asleep. Nobody could ask: no claim.
    expect(faceState([], null, false, NOW)).toBe('sleep')
    expect(faceState([], { ...online, dialable: false }, false, NOW)).toBe(
      'sleep',
    )
    expect(faceState([], null, true, NOW)).toBe('idle')
  })

  test('every state is an expression in the markup, and only a live figure moves', () => {
    const rich = avatarSvg(SPEC, {
      size: 120,
      uid: 's1',
      live: true,
      state: 'thinking',
    })
    expect(rich).toContain('data-state="thinking"')
    for (const part of [
      'av-eyes-own',
      'av-eyes-happy',
      'av-eyes-closed',
      'av-eyes-low',
      'av-talk',
      'av-think',
      'av-sparks',
      'av-zzz',
    ]) {
      expect(rich).toContain(
        `class="${part === 'av-talk' || part === 'av-think' || part === 'av-sparks' || part === 'av-zzz' ? part : `av-eyes ${part}`}"`,
      )
    }
    for (const state of AVATAR_STATES) {
      if (state === 'idle') continue
      expect(AVATAR_CSS).toContain(`[data-state="${state}"]`)
    }
  })

  test('a page with nothing open is greeted by the agent the picker offers', () => {
    const html = renderChatThread({
      transcript: null,
      failure: null,
      target: null,
      now: NOW,
      faces: faces(true),
      greeter: { agent: 'planner', address: ADDRESS },
    })
    expect(html).toContain('你好 · 我是 planner')
    expect(html).toContain('av-live')
    expect(html).toContain('class="chat-greet-figure"')
  })
})

function wired(avatars?: FakeAvatars) {
  const base = pageHarness({ chat: true })
  const actions = new MemoryActionLedger()
  const handle = createConsoleHandler(
    {
      ...base.deps,
      actions,
      ...(avatars === undefined ? {} : { avatars }),
    },
    TOKENS,
  )
  return { handle, actions }
}

const PATH = `/v0/avatars/${encodeURIComponent(KEY)}`

describe('/v0/avatars and /fragments/avatar', () => {
  test('read: the default until somebody saves one, then the saved one', async () => {
    const avatars = new FakeAvatars(() => NOW)
    const { handle, actions } = wired(avatars)
    const query = `/v0/avatars?key=${encodeURIComponent(KEY)}`
    const before = await bodyOf(await handle(call('GET', query, VIEW)))
    expect(before.avatars[KEY]).toEqual({
      spec: defaultAvatar(ADDRESS),
      saved: false,
      updatedAt: null,
    })
    // A view token reads figures, it does not change them.
    expect(before.editable).toBe(false)
    const put = await handle(call('PUT', PATH, ADMIN, SPEC))
    expect(put.status).toBe(200)
    expect(
      actions.entries.map(entry => `${entry.action} ${entry.target}`),
    ).toEqual([`avatar.save ${KEY}`])
    const after = await bodyOf(await handle(call('GET', query, ADMIN)))
    expect(after.avatars[KEY]).toEqual({
      spec: SPEC,
      saved: true,
      updatedAt: NOW,
    })
    expect(after.editable).toBe(true)
    // DELETE forgets it: the default is back.
    expect((await handle(call('DELETE', PATH, ADMIN))).status).toBe(200)
    const reset = await bodyOf(await handle(call('GET', query, ADMIN)))
    expect(reset.avatars[KEY].saved).toBe(false)
  })

  test('refused: a view token, a figure off the lists, a key that is no key', async () => {
    const avatars = new FakeAvatars(() => NOW)
    const { handle } = wired(avatars)
    expect((await handle(call('PUT', PATH, VIEW, SPEC))).status).toBe(403)
    expect(
      (await handle(call('PUT', PATH, ADMIN, { ...SPEC, shape: 'x' }))).status,
    ).toBe(400)
    expect(
      (await handle(call('PUT', '/v0/avatars/agent%3Atokyo', ADMIN, SPEC)))
        .status,
    ).toBe(400)
    expect(
      (await handle(call('GET', '/v0/avatars?key=nobody', ADMIN))).status,
    ).toBe(400)
    expect(avatars.saved.size).toBe(0)
  })

  test('without a store every figure is the default and nothing can be saved', async () => {
    const { handle } = wired()
    expect((await handle(call('PUT', PATH, ADMIN, SPEC))).status).toBe(501)
    const read = await bodyOf(
      await handle(
        call('GET', `/v0/avatars?key=${encodeURIComponent(KEY)}`, ADMIN),
      ),
    )
    expect(read.editable).toBe(false)
    expect(read.avatars[KEY].spec).toEqual(defaultAvatar(ADDRESS))
  })

  test('a member changes their own figure and nobody else’s', async () => {
    const avatars = new FakeAvatars(() => NOW)
    const h = accountsHarness({ deps: { avatars } })
    const member = await person(h.handle, 'member')
    const other = encodeURIComponent('user:u:somebody-else')
    const refused = await h.handle(
      asSession('PUT', `/v0/avatars/${other}`, member.sid, { body: SPEC }),
    )
    expect(refused.status).toBe(403)
    const mine = await bodyOf(
      await h.handle(asSession('GET', '/v0/avatars', member.sid)),
    )
    expect(mine.editable).toBe(true)
    expect(avatars.saved.size).toBe(0)
  })

  test('the fragment draws the editor for the saved figure, a draft, or the default', async () => {
    const avatars = new FakeAvatars(() => NOW)
    const { handle } = wired(avatars)
    await handle(call('PUT', PATH, ADMIN, SPEC))
    const base = `/fragments/avatar?key=${encodeURIComponent(KEY)}`
    const saved = await (await handle(call('GET', base, ADMIN))).text()
    expect(saved).toContain('name="shape" value="cloud" checked')
    const draft = await (
      await handle(
        call(
          'GET',
          `${base}&spec=${encodeURIComponent(JSON.stringify({ ...SPEC, shape: 'pebble' }))}`,
          ADMIN,
        ),
      )
    ).text()
    expect(draft).toContain('name="shape" value="pebble" checked')
    const fallback = await (
      await handle(call('GET', `${base}&default=1`, ADMIN))
    ).text()
    expect(fallback).toContain(
      `name="shape" value="${defaultAvatar(ADDRESS).shape}" checked`,
    )
    // A draft off the lists is no draft.
    const junk = await (
      await handle(call('GET', `${base}&spec=%7Bnope`, ADMIN))
    ).text()
    expect(junk).toContain('name="shape" value="cloud" checked')
  })

  test('对话 greets with the figure and carries the editor', async () => {
    const avatars = new FakeAvatars(() => NOW)
    const { handle } = wired(avatars)
    const page = await (await handle(browse('/', ADMIN))).text()
    expect(page).toContain('class="chat-greet"')
    expect(page).toContain('id="avatar-dialog"')
    expect(page).toContain("qc.onAction('avatar-edit'")
  })
})
