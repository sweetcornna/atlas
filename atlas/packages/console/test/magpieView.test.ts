// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 网关's page (P34) where the review of PR #230 found it sending something
 * other than what is: the key form, saved untouched, has to send back the
 * key as it is — its limits' `cacheReads` and its models even when they are
 * not in today's choices (m3).
 *
 * The form is rendered by `view/magpie.ts`, read the way a browser fills a
 * form (an input's value, a select's selected or first option, a checkbox's
 * state), and handed to the page's own script (`view/magpieScript.ts`), run
 * against a stand-in for the console runtime that records what it would
 * send.
 */

import { describe, expect, test } from 'bun:test'
import type { MagpieKeyView, MagpieSnapshot } from '../src/directionPorts.js'
import { renderMagpieForm } from '../src/view/magpie.js'
import { MAGPIE_PAGE_JS } from '../src/view/magpieScript.js'
import { FakeMagpie } from './directionFakes.js'

interface Field {
  readonly value: string
  readonly checked: boolean
}

function unescape(text: string): string {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

function attrsOf(tag: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const match of tag.matchAll(/([a-zA-Z-]+)(?:="([^"]*)")?/g)) {
    out.set(match[1] ?? '', unescape(match[2] ?? ''))
  }
  return out
}

/** The form's fields by name, as a browser would submit them untouched. */
function fieldsOf(html: string): Record<string, Field> {
  const fields: Record<string, Field> = {}
  for (const match of html.matchAll(/<input\b([^>]*)>/g)) {
    const attrs = attrsOf(match[1] ?? '')
    const name = attrs.get('name')
    if (name === undefined) continue
    const checkbox = attrs.get('type') === 'checkbox'
    fields[name] = {
      value: attrs.get('value') ?? (checkbox ? 'on' : ''),
      checked: attrs.has('checked'),
    }
  }
  for (const match of html.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/g)) {
    const name = attrsOf(match[1] ?? '').get('name')
    if (name === undefined) continue
    const options = [
      ...(match[2] ?? '').matchAll(/<option value="([^"]*)"( selected)?>/g),
    ]
    const chosen = options.find(option => option[2] !== undefined) ?? options[0]
    fields[name] = { value: unescape(chosen?.[1] ?? ''), checked: false }
  }
  for (const match of html.matchAll(
    /<textarea\b([^>]*)>([\s\S]*?)<\/textarea>/g,
  )) {
    const name = attrsOf(match[1] ?? '').get('name')
    if (name === undefined) continue
    fields[name] = { value: unescape(match[2] ?? ''), checked: false }
  }
  return fields
}

interface Sent {
  readonly method: string
  readonly path: string
  readonly body: Record<string, unknown>
}

/** Submit `html` through the page script; what it would send. */
function submit(html: string): Sent[] {
  const sent: Sent[] = []
  let onSubmit: ((form: unknown) => void) | undefined
  const idle = () => {}
  const qc = {
    byId: () => null,
    say: idle,
    setText: idle,
    toast: idle,
    openDialog: idle,
    closeDialog: idle,
    failLine: () => '',
    failTone: () => 'bad',
    loadHtml: () => Promise.resolve(''),
    refreshRegion: () => Promise.resolve(),
    onAction: idle,
    onSubmit: (id: string, handler: (form: unknown) => void) => {
      if (id === 'magpie-form') onSubmit = handler
    },
    sendJson: (method: string, path: string, body: Record<string, unknown>) => {
      sent.push({ method, path, body })
      return new Promise(() => {})
    },
  }
  new Function('window', 'document', MAGPIE_PAGE_JS)(
    { qianmoConsole: qc },
    { addEventListener: idle },
  )
  if (onSubmit === undefined) throw new Error('the script took no form')
  onSubmit({ elements: fieldsOf(html) })
  return sent
}

async function snapshot(): Promise<MagpieSnapshot> {
  const result = await new FakeMagpie().snapshot()
  if (!result.ok) throw new Error(result.failure.message)
  return result.value
}

function withKey(
  base: MagpieSnapshot,
  change: Partial<MagpieKeyView>,
): { snapshot: MagpieSnapshot; key: MagpieKeyView } {
  const first = base.keys[0]
  if (first === undefined) throw new Error('no key')
  const key = { ...first, ...change }
  return { snapshot: { ...base, keys: [key] }, key }
}

describe('the key form, saved untouched, sends the key back as it is (m3)', () => {
  test('a limit that counts cache reads keeps counting them', async () => {
    const base = await snapshot()
    const limit = base.keys[0]?.limits[0]
    if (limit === undefined) throw new Error('no limit')
    const { snapshot: snap, key } = withKey(base, {
      limits: [{ ...limit, cacheReads: true }],
    })
    const html = renderMagpieForm({ kind: 'key', snapshot: snap, key })
    const [sent] = submit(html)
    expect(sent?.path).toBe('/v0/magpie/keys/node%3Atokyo-1')
    expect(sent?.body['limits']).toEqual([
      { period: 'day', tokens: 1_000_000, cacheReads: true },
    ])
  })

  test('a limit that does not count them is sent without the flag', async () => {
    const base = await snapshot()
    const key = base.keys[0]
    if (key === undefined) throw new Error('no key')
    const [sent] = submit(
      renderMagpieForm({ kind: 'key', snapshot: base, key }),
    )
    expect(sent?.body['limits']).toEqual([{ period: 'day', tokens: 1_000_000 }])
  })

  test("main and fast models outside today's choices stay what they are", async () => {
    const { snapshot: snap, key } = withKey(await snapshot(), {
      mainModel: 'deepseek/deepseek-v4',
      fastModel: 'group/retired',
    })
    expect(snap.models).not.toContain('deepseek/deepseek-v4')
    const [sent] = submit(
      renderMagpieForm({ kind: 'key', snapshot: snap, key }),
    )
    expect(sent?.body['mainModel']).toBe('deepseek/deepseek-v4')
    expect(sent?.body['fastModel']).toBe('group/retired')
  })

  test('with magpie unread there are no choices, and the models still stay', async () => {
    const { snapshot: snap, key } = withKey(
      { ...(await snapshot()), models: [] },
      {},
    )
    const [sent] = submit(
      renderMagpieForm({ kind: 'key', snapshot: snap, key }),
    )
    expect(sent?.body['mainModel']).toBe('openai/gpt-6')
    expect(sent?.body['fastModel']).toBe('group/fast')
  })

  test('a new key still starts from the first choice', async () => {
    const base = await snapshot()
    const html = renderMagpieForm({ kind: 'key', snapshot: base, key: null })
    expect(fieldsOf(html)['mainModel']?.value).toBe('openai/gpt-6')
  })
})
