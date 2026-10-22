// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { ApprovalItem, ApprovalPort } from '../../src/governance.js'
import { accountsHarness, person, START } from '../accountsHarness.js'
import { MemoryActionLedger } from '../memoryActions.js'
import { Browser, skipReason } from './cdp.js'

const SKIP = skipReason()
if (SKIP) console.warn(`[approvals browser] skipped: ${SKIP}`)
describe.skipIf(SKIP !== null)('personal approvals in a real browser', () => {
  let browser: Browser
  beforeAll(async () => {
    browser = await Browser.launch()
  }, 30_000)
  afterAll(async () => {
    await browser?.close()
  }, 30_000)
  test('an ordinary login approves, revokes and continues directly; a refusal says why on the status line', async () => {
    const actions = new MemoryActionLedger()
    let status: ApprovalItem['status'] = 'pending'
    let refuse = true
    const decisions: string[] = []
    const port: ApprovalPort = {
      async list() {
        return {
          ok: true,
          value: [
            {
              requestId: 'a'.repeat(32),
              node: 'worker',
              agent: 'main',
              contextId: 'own-chat',
              owner: null,
              toolName: 'write',
              input: { path: '/tmp/\u202ereview.txt', content: 'example' },
              digest: 'b'.repeat(64),
              createdAt: START,
              expiresAt: START + 60_000,
              status,
            },
          ],
        }
      },
      async decide(principal) {
        if (refuse) {
          refuse = false
          return {
            ok: false,
            failure: { code: 'refused', message: '审批请求已变化或失效' },
          }
        }
        decisions.push(principal.credential)
        status = 'allowed'
        return { ok: true, value: { delivered: true } }
      },
      async continue(principal) {
        decisions.push(`continue:${principal.credential}`)
        status = 'allowed'
        return {
          ok: true,
          value: { sessionId: 'own-chat', taskId: 'new-task' },
        }
      },
      async revoke(principal) {
        decisions.push(`revoke:${principal.credential}`)
        status = 'denied'
        return { ok: true, value: { delivered: true } }
      },
    }
    const h = accountsHarness({ deps: { approvals: port, actions } })
    const alice = await person(h.handle)
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: request => h.handle(request),
    })
    const tab = await browser.tab()
    try {
      await tab.goto(
        `http://127.0.0.1:${server.port}/login?redirect=/admin/approvals`,
      )
      await tab.evaluate(
        `document.getElementById('token').value=${JSON.stringify(alice.credential)}; document.querySelector('form').requestSubmit()`,
      )
      await tab.waitFor(
        "document.querySelector('[data-approval]') !== null && window.qianmoConsole !== undefined",
      )
      // No credential row: the page has nothing to verify first.
      expect(
        await tab.evaluate<boolean>(
          "document.getElementById('approval-auth') === null && document.querySelector('.apv-page input') === null",
        ),
      ).toBe(true)
      // The hub refuses the first one: the status line says why, and
      // asks for nothing.
      await tab.evaluate(
        "document.querySelector('[data-approval] button[value=allow-once]').click()",
      )
      await tab.waitFor(
        "document.getElementById('approval-status').textContent.includes('审批未完成')",
      )
      expect(
        await tab.evaluate<string>(
          "document.getElementById('approval-status').textContent",
        ),
      ).toBe('审批未完成 · 审批请求已变化或失效')
      expect(
        await tab.evaluate<boolean>(
          "document.querySelector('.apv-page input') === null && !document.querySelector('[data-approval] button[value=allow-once]').disabled",
        ),
      ).toBe(true)
      expect(decisions).toHaveLength(0)
      expect(
        await tab.evaluate<boolean>(
          "document.body.textContent.includes('\\\\u202e')",
        ),
      ).toBe(true)
      expect(
        await tab.evaluate<boolean>(
          "document.body.textContent.includes('\\u202e')",
        ),
      ).toBe(false)
      // The next click goes straight through, on the login session.
      await tab.evaluate(
        "document.querySelector('[data-approval] button[value=allow-once]').click()",
      )
      await tab.waitFor("document.querySelector('[data-revoke]') !== null")
      expect(decisions).toEqual(['session'])
      await tab.evaluate("document.querySelector('[data-revoke]').click()")
      await tab.waitFor("document.body.textContent.includes('已拒绝或撤销')")
      expect(decisions).toEqual(['session', 'revoke:session'])
      expect(
        actions.entries.filter(row => row.action === 'approval.decide')[0]
          ?.target,
      ).toBe('a'.repeat(32))
      status = 'pending'
      await tab.goto(`http://127.0.0.1:${server.port}/admin/approvals`)
      await tab.waitFor(
        "document.querySelector('button[value=continue]') !== null",
      )
      await tab.evaluate(
        "document.querySelector('button[value=continue]').click()",
      )
      await tab.waitFor("document.querySelector('[data-revoke]') !== null")
      expect(decisions).toEqual([
        'session',
        'revoke:session',
        'continue:session',
      ])
      expect(
        actions.entries.find(row => row.action === 'approval.continue')?.target,
      ).toBe('a'.repeat(32))
      expect(JSON.stringify(actions.entries)).not.toContain(alice.credential)
      expect(h.ledger.text).not.toContain(alice.credential)
    } finally {
      await tab.close()
      server.stop(true)
    }
  }, 30_000)
})
