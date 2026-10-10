// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { expect, test } from 'bun:test'
import { createConsoleHandler } from '../src/http.js'
import { ADMIN, TOKENS, VIEW, browse, pageHarness } from './pageHarness.js'

function api(path: string, token = VIEW, extra: Record<string, string> = {}) {
  return new Request(`http://console.test${path}`, {
    headers: { authorization: `Bearer ${token}`, ...extra },
  })
}

test('fragment revalidation still checks authorization and changes on new content', async () => {
  const h = pageHarness()
  const first = await h.handle(api('/fragments/roster'))
  const etag = first.headers.get('etag')!
  expect(first.status).toBe(200)
  expect(etag).toMatch(/^W\/"[a-f0-9]{64}"$/)
  const cached = await h.handle(
    api('/fragments/roster', VIEW, { 'if-none-match': etag }),
  )
  expect(cached.status).toBe(304)
  expect(cached.headers.get('vary')).toContain('Accept-Encoding')
  expect(
    (
      await h.handle(
        api('/fragments/roster', VIEW, {
          'if-none-match': '"unrelated", ' + etag.slice(2),
        }),
      )
    ).status,
  ).toBe(304)
  expect(await cached.text()).toBe('')
  const refused = await h.handle(
    api('/fragments/roster', 'invalid', { 'if-none-match': etag }),
  )
  expect(refused.status).toBe(401)
  h.registry.listResult = { ok: true, value: [] }
  const changed = await h.handle(
    api('/fragments/roster', VIEW, { 'if-none-match': etag }),
  )
  expect(changed.status).toBe(200)
  expect(changed.headers.get('etag')).not.toBe(etag)
})

test('theme is rendered before script and rejects arbitrary cookie content', async () => {
  const h = pageHarness()
  const dark = await h.handle(
    api('/nodes', ADMIN, { cookie: 'qianmo_theme=dark' }),
  )
  expect(await dark.text()).toContain('<html lang="zh-CN" data-theme="dark">')
  const invalid = await h.handle(
    api('/nodes', ADMIN, { cookie: 'qianmo_theme=evil' }),
  )
  expect(await invalid.text()).toContain('data-theme="system"')
})

test('audit export carries scope, bounds, escaping and refuses unreadable trails', async () => {
  const h = pageHarness()
  if (!h.audit.readResult.ok) throw new Error('fixture')
  const page = h.audit.readResult.value
  const record = page.records[0]!
  h.audit.readResult = {
    ok: true,
    value: { ...page, records: [{ ...record, peer: '=HYPERLINK("x")' }] },
  }
  const csv = await h.handle(api('/v0/audit?format=csv&limit=999999'))
  expect(csv.status).toBe(200)
  expect(csv.headers.get('content-disposition')).toContain('qianmo-audit.csv')
  expect(await csv.text()).toContain(`"'=HYPERLINK(""x"")"`)
  expect(h.audit.filters.at(-1)?.limit).toBe(500)
  const ndjson = await h.handle(api('/v0/audit?format=ndjson'))
  expect(JSON.parse((await ndjson.text()).trim())).toMatchObject({
    auditNode: 'default',
    peer: '=HYPERLINK("x")',
    seq: 1,
  })
  expect((await h.handle(api('/v0/audit?format=exe'))).status).toBe(400)
  expect((await h.handle(api('/v0/audit?format=csv', 'wrong'))).status).toBe(
    401,
  )
  h.audit.readResult = {
    ok: false,
    failure: { code: 'unreachable', message: 'offline' },
  }
  expect((await h.handle(api('/v0/audit?format=ndjson'))).status).toBe(503)
})

test('revision stream sends no records and ends on tenant policy change', async () => {
  const h = pageHarness()
  let close: (() => void) | undefined
  let detached = false
  const handle = createConsoleHandler(
    {
      ...h.deps,
      tenancy: {
        read: () => ({
          revision: '1',
          config: {
            version: 1,
            hubServer: 'hub',
            tenants: [],
            subjects: [],
            nodes: [],
            jobs: [],
            platformSubjects: [],
          },
        }),
        subscribe(listener) {
          close = listener
          return () => {
            detached = true
          }
        },
      },
    },
    TOKENS,
  )
  const response = await handle(api('/v0/events', ADMIN))
  expect(response.status).toBe(200)
  const reader = response.body!.getReader()
  let text = ''
  while (!text.includes('event: revision')) {
    const item = await reader.read()
    if (item.done) throw new Error('stream ended before revision')
    text += new TextDecoder().decode(item.value)
  }
  expect(text).not.toContain('tokyo')
  expect(text).not.toContain('records')
  close!()
  while (!(await reader.read()).done) {
    /* drain queued revisions */
  }
  expect(detached).toBe(true)
})

test('audit page exports current filter without carrying URL credentials', async () => {
  const h = pageHarness()
  const html = await (
    await h.handle(browse('/audit?q=test&token=do-not-export', ADMIN))
  ).text()
  expect(html).toContain('data-action="audit-export"')
  expect(html).toContain('q=test')
  expect(html.match(/data-export="[^"]+"/g)?.join('')).not.toContain('token=')
})
