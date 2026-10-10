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
  test('ordinary login cannot approve; reauthentication clears the secret and permits bound approval and revocation', async () => {
    const actions = new MemoryActionLedger()
    let status: ApprovalItem['status'] = 'pending'
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
        `http://127.0.0.1:${server.port}/login?redirect=/approvals`,
      )
      await tab.evaluate(
        `document.getElementById('token').value=${JSON.stringify(alice.credential)}; document.querySelector('form').requestSubmit()`,
      )
      await tab.waitFor(
        "document.querySelector('[data-approval]') !== null && window.qianmoConsole !== undefined",
      )
      await tab.evaluate(
        "document.querySelector('[data-approval] button').click()",
      )
      await tab.waitFor(
        "document.getElementById('approval-status').textContent.includes('审批未完成')",
      )
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
      await tab.evaluate(
        `document.getElementById('approval-credential').value=${JSON.stringify(alice.credential)}; document.getElementById('approval-auth').requestSubmit()`,
      )
      await tab.waitFor(
        "document.getElementById('approval-status').textContent.includes('已验证')",
      )
      expect(
        await tab.evaluate<string>(
          "document.getElementById('approval-credential').value",
        ),
      ).toBe('')
      expect(
        await tab.evaluate<boolean>(
          "document.cookie.includes('qianmo_approval')",
        ),
      ).toBe(false)
      await tab.evaluate(
        "document.querySelector('[data-approval] button').click()",
      )
      await tab.waitFor("document.querySelector('[data-revoke]') !== null")
      expect(decisions).toEqual(['approval-session'])
      await tab.evaluate("document.querySelector('[data-revoke]').click()")
      await tab.waitFor("document.body.textContent.includes('已拒绝或撤销')")
      expect(decisions).toEqual(['approval-session', 'revoke:approval-session'])
      expect(
        actions.entries.filter(row => row.action === 'approval.decide')[0]
          ?.target,
      ).toBe('a'.repeat(32))
      status = 'pending'
      await tab.goto(`http://127.0.0.1:${server.port}/approvals`)
      await tab.waitFor(
        "document.querySelector('button[value=continue]') !== null",
      )
      await tab.evaluate(
        "document.querySelector('button[value=continue]').click()",
      )
      await tab.waitFor("document.querySelector('[data-revoke]') !== null")
      expect(decisions).toEqual([
        'approval-session',
        'revoke:approval-session',
        'continue:approval-session',
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
