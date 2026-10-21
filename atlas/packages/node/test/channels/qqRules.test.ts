// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later
// 规则来源 NousResearch/hermes-agent `plugins/platforms/qqbot/adapter.py:151`、`:762-769`、`:1374-1396`、`:1507-1515`、`:1639-1641`、`:1655-1657`，`plugins/platforms/qqbot/constants.py:29`、`:34-35`，取于 `63220ae5`，取用日期 2026-10-19

/**
 * The QQ Open Platform bot's message rules rewritten after hermes-agent
 * (`src/channels/rules/qq.ts`, hermes `qqbot` at `63220ae5`).
 */

import { describe, expect, test } from 'bun:test'
import { QqAdapter } from '../../src/channels/qq.js'
import { qqMessageBody, stripAtMention } from '../../src/channels/rules/qq.js'
import { FakeNet } from './fakes.js'

describe('QQ bot (hermes)', () => {
  test('the leading @ of a group message goes; Markdown is the body', () => {
    expect(stripAtMention(' @小阡 这个 ')).toBe('这个')
    expect(stripAtMention('这个 @别人')).toBe('这个 @别人')
    expect(qqMessageBody('**粗**', true)).toEqual({
      markdown: { content: '**粗**' },
      msg_type: 2,
    })
    expect(qqMessageBody('x'.repeat(4_100), false)).toEqual({
      content: 'x'.repeat(4_000),
      msg_type: 0,
    })
  })
})

describe('QQ adapter (hermes rules wired in)', () => {
  test('QQ: a group @ is taken off; refused Markdown is resent plain and stays plain', async () => {
    let markdownRefused = 0
    const net = new FakeNet()
      .on('getAppAccessToken', {
        body: { access_token: 'ACC', expires_in: 7200 },
      })
      .on('/messages', exchange => {
        if ((exchange.body as { msg_type: number }).msg_type === 2) {
          markdownRefused++
          return {
            status: 400,
            body: { code: 304003, message: 'markdown not allowed' },
          }
        }
        return { body: { id: 'out' } }
      })
    const adapter = new QqAdapter({ appId: '1', appSecret: 'S' }, net.io())
    expect((await adapter.send({ type: 'dm', id: 'OPEN1' }, '**一**')).ok).toBe(
      true,
    )
    expect((await adapter.send({ type: 'dm', id: 'OPEN1' }, '二')).ok).toBe(
      true,
    )
    expect(markdownRefused).toBe(1)
    expect(net.to('/messages').map(one => one.body)).toEqual([
      { markdown: { content: '**一**' }, msg_type: 2 },
      { content: '一', msg_type: 0 },
      { content: '二', msg_type: 0 },
    ])
    expect(net.errors).toContain('QQ 拒绝了 Markdown 消息，本次连接改发纯文本')
  })
})
