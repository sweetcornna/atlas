// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 操作记录 names every verb the ledger knows in words (P18.9 follow-up to
 * P18.6 / P18.10): a verb without a word is shown as its raw code, which is
 * what `provider.*` and `handoff.*` looked like before.
 *
 * A scan over `CONSOLE_ACTIONS` rather than a list of the verbs added here, so
 * a verb added later without a word fails the day it lands. The control is
 * the raw code itself: it must still be on the row (the small print under the
 * word), so the scan is reading the row it thinks it is reading.
 */

import { describe, expect, test } from 'bun:test'
import { CONSOLE_ACTIONS } from '../src/deps.js'
import { ADMIN, accountsHarness, asBearer } from './accountsHarness.js'
import { MemoryActionLedger } from './memoryActions.js'

/** `[word, raw]` of every row of the 操作记录 table, newest first. */
function rows(html: string): (readonly [string, string])[] {
  return [
    ...html.matchAll(
      /<td class="act"><span>([^<]*)<\/span>(?:[\s\S]*?<span class="note mono">([^<]*)<\/span>)?<\/td>/g,
    ),
  ].map(match => [match[1] ?? '', match[2] ?? ''] as const)
}

describe('操作记录 names every verb in words', () => {
  test('each verb of CONSOLE_ACTIONS, recorded once, reads as a word', async () => {
    const actions = new MemoryActionLedger()
    const h = accountsHarness({ deps: { actions } })
    for (const [index, action] of CONSOLE_ACTIONS.entries()) {
      await actions.record({
        at: h.clock.now() + index,
        requestId: `req-${index}`,
        subject: 'legacy:admin',
        action,
        target: action.startsWith('accounts.') ? '/invites' : `t-${index}`,
        outcome: 'ok',
      })
    }
    const response = await h.handle(asBearer('GET', '/access/actions', ADMIN))
    expect(response.status).toBe(200)
    const found = rows(await response.text())
    expect(found).toHaveLength(CONSOLE_ACTIONS.length)
    const raw = new Set(found.map(([, code]) => code))
    for (const action of CONSOLE_ACTIONS) {
      // The control: the code is on its row, under the word.
      expect(`${action} ${raw.has(action)}`).toBe(`${action} true`)
    }
    for (const [word, code] of found) {
      expect(`${code} → ${word.includes('.') ? 'raw' : 'word'}`).toBe(
        `${code} → word`,
      )
    }
    const words = new Map(found.map(([word, code]) => [code, word]))
    expect(words.get('provider.apply')).toBe('下发模型配置')
    expect(words.get('provider.apply.force')).toBe('覆盖下发')
    expect(words.get('provider.probe.call')).toBe('真实调用')
    expect(words.get('provider.autocompact')).toBe('设自动压缩阈值')
    expect(words.get('handoff.accept')).toBe('登记接力')
  })

  test('the verb filter offers 模型服务 and 接力 by name', async () => {
    const h = accountsHarness({ deps: { actions: new MemoryActionLedger() } })
    const html = await (
      await h.handle(asBearer('GET', '/access/actions', ADMIN))
    ).text()
    expect(html).toContain('<option value="provider.">模型服务</option>')
    expect(html).toContain('<option value="handoff.">接力</option>')
    // No family is offered under its bare prefix.
    for (const head of new Set(CONSOLE_ACTIONS.map(a => a.split('.')[0]))) {
      expect(html).not.toContain(`<option value="${head}.">${head}</option>`)
    }
  })
})
