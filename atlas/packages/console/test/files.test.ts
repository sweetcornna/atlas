// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/** 文件互通 (P20): the page over `FakeFiles`. */

import { describe, expect, test } from 'bun:test'
import { accountsHarness, asSession, person } from './accountsHarness.js'
import { FakeFiles } from './directionFakes.js'
import {
  ADMIN,
  browse,
  NOW,
  pageHarness,
  VIEW,
  visibleText,
  withoutScripts,
} from './pageHarness.js'

function wired(files: FakeFiles | null = new FakeFiles(() => NOW)) {
  const h = pageHarness({ ports: files === null ? {} : { files } })
  return { handle: h.handle, files }
}

async function read(
  handle: (request: Request) => Promise<Response>,
  path: string,
  token = ADMIN,
): Promise<string> {
  const response = await handle(browse(path, token))
  expect(`${path} ${response.status}`).toBe(`${path} 200`)
  return await response.text()
}

describe('文件互通', () => {
  test('requests first, then transfers grouped by gathering, then grants', async () => {
    const { handle } = wired()
    const html = await read(handle, '/files')
    const text = visibleText(html)
    for (const word of [
      '等你批准',
      'reports/2026-10/weekly.md',
      '写周报需要上周的会议纪要',
      'writer · osaka-1 的智能体申请',
      '汇集到 helper · berlin-1',
      '2 个来源 · 1 个完成',
      '摘要一致',
      'inbox/tokyo-1/2026-10',
      '送达中',
      '摘要不一致',
      '收件方核对摘要不一致',
      '整个目录',
      '还有 30 分钟',
      '已撤销',
      '单个文件不超过 64 MiB',
    ]) {
      expect(`${word} ${text.includes(word)}`).toBe(`${word} true`)
    }
    // Order on the page: what needs a person comes first.
    expect(text.indexOf('等你批准')).toBeLessThan(text.indexOf('传输'))
    expect(text.indexOf('传输')).toBeLessThan(text.indexOf('授权'))
    // A request that was already decided is not asked again.
    expect(html).not.toContain('data-id="fr-0"')
    // Progress is the share of bytes delivered.
    expect(html).toContain('aria-valuenow="36"')
  })

  test('the admin token decides, starts, retries and revokes; a view token only reads', async () => {
    const { handle } = wired()
    const admin = withoutScripts(await read(handle, '/files'))
    for (const mark of [
      'data-action="files-approve"',
      'data-action="files-deny"',
      'data-action="files-new"',
      'data-action="files-retry"',
      'data-action="files-revoke"',
      'id="files-approve-dialog"',
      'id="files-new-dialog"',
      'id="confirm-files-deny"',
      'id="confirm-files-revoke"',
    ]) {
      expect(`${mark} ${admin.includes(mark)}`).toBe(`${mark} true`)
    }
    // Only the live grant can be revoked; only the failed transfer retried.
    expect(admin.match(/data-action="files-revoke"/g)?.length).toBe(1)
    expect(admin.match(/data-action="files-retry"/g)?.length).toBe(1)
    const view = withoutScripts(await read(handle, '/files', VIEW))
    for (const mark of [
      'files-approve',
      'files-deny',
      'files-new',
      'files-retry',
      'files-revoke',
    ]) {
      expect(`${mark} ${view.includes(mark)}`).toBe(`${mark} false`)
    }
    expect(visibleText(view)).toContain('reports/2026-10/weekly.md')
  })

  test('a member acts; a viewer account reads', async () => {
    const files = new FakeFiles(() => NOW)
    const h = accountsHarness({ deps: { files } })
    const member = await person(h.handle, 'member')
    const memberHtml = await (
      await h.handle(asSession('GET', '/files', member.sid, { header: false }))
    ).text()
    expect(memberHtml).toContain('data-action="files-approve"')
    expect(memberHtml).toContain('data-action="files-new"')
    const viewer = await person(h.handle, 'viewer')
    const viewerHtml = withoutScripts(
      await (
        await h.handle(
          asSession('GET', '/files', viewer.sid, { header: false }),
        )
      ).text(),
    )
    expect(viewerHtml).toContain('reports/2026-10/weekly.md')
    expect(viewerHtml).not.toContain('data-action="files-approve"')
    expect(viewerHtml).not.toContain('id="files-new-dialog"')
  })

  test('the start dialog offers every agent, and says which are offline', async () => {
    const { handle } = wired()
    const html = await read(handle, '/files')
    expect(html).toContain('value="qianmo://tokyo-1/planner"')
    expect(html).toContain('helper · berlin-1（离线）')
    expect(html).toContain('data-action="files-browse"')
    expect(html).toContain('data-action="files-add-source"')
  })

  test('nothing yet is said, with the way to start', async () => {
    const files = new FakeFiles(() => NOW)
    files.requests = []
    files.grants = []
    files.transfers = []
    files.groups = []
    const { handle } = wired(files)
    const text = visibleText(await read(handle, '/fragments/files'))
    expect(text).toContain('还没有传输')
    expect(text).not.toContain('等你批准')
    expect(text).not.toContain('授权')
  })

  test('a failing port is a failure bar; no port means no area', async () => {
    const files = new FakeFiles(() => NOW)
    files.failSnapshot = true
    const { handle } = wired(files)
    const html = await read(handle, '/files')
    expect(html).toContain('role="alert"')
    expect(html).not.toContain('id="files-new-dialog"')
    const none = wired(null)
    expect((await none.handle(browse('/files', ADMIN))).status).toBe(404)
    expect(await read(none.handle, '/overview')).not.toContain('href="/files"')
    expect(
      (await none.handle(browse('/fragments/files/x', ADMIN))).status,
    ).toBe(404)
  })
})
