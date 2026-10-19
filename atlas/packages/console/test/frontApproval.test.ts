// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The front's approval prompt (P39 §2.1): API filter, markup, and script. */

import { describe, expect, test } from 'bun:test'
import type { ApprovalItem, ApprovalPort } from '../src/governance.js'
import { FRONT_APPROVAL_JS } from '../src/view/frontApproval.js'
import { accountsHarness, asSession, person, START } from './accountsHarness.js'

function item(over: Partial<ApprovalItem>): ApprovalItem {
  return {
    requestId: 'r-1',
    node: 'tokyo-1',
    agent: 'qianmo://tokyo-1/planner',
    contextId: 'session-1',
    owner: null,
    toolName: 'qianmo_elevated_github',
    input: { op: 'pr_create', repo: 'acme/app', title: 'Fix' },
    digest: 'digest-1',
    createdAt: START,
    expiresAt: START + 600_000,
    status: 'pending',
    ...over,
  }
}

function port(
  items: (subject: string) => readonly ApprovalItem[],
): ApprovalPort {
  return {
    async list(principal) {
      return { ok: true, value: items(principal.subject) }
    },
    async decide() {
      return { ok: true, value: { delivered: true } }
    },
    async revoke() {
      return { ok: true, value: { delivered: true } }
    },
  }
}

describe('GET /v0/approvals?mine=1', () => {
  test('only pending requests whose session belongs to this person', async () => {
    const h = accountsHarness({
      deps: {
        approvals: port(me => [
          item({ requestId: 'mine', owner: me }),
          item({ requestId: 'done', owner: me, status: 'allowed' }),
          item({ requestId: 'theirs', owner: 'u:someone-else' }),
        ]),
      },
    })
    const ops = await person(h.handle, 'ops')
    const all = (await (
      await h.handle(asSession('GET', '/v0/approvals', ops.sid))
    ).json()) as { approvals: ApprovalItem[] }
    expect(all.approvals.map(a => a.requestId)).toEqual([
      'mine',
      'done',
      'theirs',
    ])
    const mine = (await (
      await h.handle(asSession('GET', '/v0/approvals?mine=1', ops.sid))
    ).json()) as { approvals: ApprovalItem[] }
    expect(mine.approvals.map(a => a.requestId)).toEqual(['mine'])
  })
})

describe('the front document', () => {
  test('carries the prompt only when approvals are wired and the reader may approve', async () => {
    const wired = accountsHarness({ deps: { approvals: port(() => []) } })
    const member = await person(wired.handle, 'member')
    const page = await (
      await wired.handle(asSession('GET', '/', member.sid, { header: false }))
    ).text()
    expect(page).toContain('id="fx-approval"')
    expect(page).toContain('/v0/approvals?mine=1')
    const bare = accountsHarness()
    const other = await person(bare.handle, 'member')
    const plain = await (
      await bare.handle(asSession('GET', '/', other.sid, { header: false }))
    ).text()
    expect(plain).not.toContain('fx-approval')
  })
})

interface FakeNode {
  id: string
  textContent: string
  hidden: boolean
  value: string
  focus(): void
}
interface Sent {
  readonly method: string
  readonly path: string
  readonly body?: unknown
}

/** A just-enough DOM for the prompt script, and a scripted `sendJson`. */
function runPrompt(answer: (sent: Sent) => Promise<unknown>): {
  readonly sent: Sent[]
  readonly node: (id: string) => FakeNode
  readonly dialog: { open: boolean }
  readonly click: (choice: string) => void
  readonly tick: () => void
} {
  const nodes = new Map<string, FakeNode>()
  const node = (id: string): FakeNode => {
    let n = nodes.get(id)
    if (!n) {
      n = {
        id,
        textContent: '',
        hidden: id === 'fx-approval-auth',
        value: '',
        focus() {},
      }
      nodes.set(id, n)
    }
    return n
  }
  const handlers: Record<string, (event: unknown) => void> = {}
  const attrs: Record<string, string> = {
    'data-words': JSON.stringify({
      title: 'T',
      command: 'CMD',
      github: 'GH',
      network: 'NET',
      other: 'OTHER',
      needCredential: 'NEED',
      failed: 'FAILED',
      agent: 'A',
      expires: 'E',
    }),
  }
  const dialog = {
    open: false,
    getAttribute: (name: string) => attrs[name] ?? null,
    setAttribute: (name: string, value: string) => {
      attrs[name] = value
    },
    addEventListener: (type: string, fn: (event: unknown) => void) => {
      handlers[type] = fn
    },
    showModal() {
      dialog.open = true
    },
    close() {
      dialog.open = false
    },
  }
  const sent: Sent[] = []
  const qc = {
    sendJson: (method: string, path: string, body?: unknown) => {
      const one = { method, path, ...(body === undefined ? {} : { body }) }
      sent.push(one)
      return answer(one)
    },
  }
  let interval: (() => void) | undefined
  const document = {
    visibilityState: 'visible',
    getElementById: (id: string) => (id === 'fx-approval' ? dialog : node(id)),
    addEventListener: () => {},
  }
  const window = { qianmoConsole: qc, addEventListener: () => {} }
  new Function('window', 'document', 'setInterval', FRONT_APPROVAL_JS)(
    window,
    document,
    (fn: () => void) => {
      interval = fn
      return 0
    },
  )
  const click = (choice: string) =>
    handlers.click?.({
      target: {
        closest: () => ({
          getAttribute: () => choice,
        }),
      },
    })
  return { sent, node, dialog, click, tick: () => interval?.() }
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0))

describe('the prompt script', () => {
  test('shows the oldest pending request in words, and approving sends allow-once', async () => {
    const pending = [
      item({
        requestId: 'b',
        createdAt: START + 5,
        toolName: 'qianmo_elevated_bash',
        input: { command: 'npm test' },
      }),
      item({ requestId: 'a', createdAt: START }),
    ]
    let decided = false
    const page = runPrompt(async sent =>
      sent.method === 'GET'
        ? { approvals: decided ? [] : pending }
        : ((decided = true), { delivered: true }),
    )
    await flush()
    expect(page.dialog.open).toBe(true)
    expect(page.node('fx-approval-what').textContent).toBe('GH')
    expect(page.node('fx-approval-detail').textContent).toContain('pr_create')
    page.click('allow-once')
    await flush()
    await flush()
    expect(page.sent).toContainEqual({
      method: 'POST',
      path: '/v0/approvals/a',
      body: { digest: 'digest-1', decision: 'allow-once' },
    })
    expect(page.dialog.open).toBe(false)
  })

  test('a decision refused for want of a fresh credential asks for it, then retries once', async () => {
    let authed = false
    const page = runPrompt(async sent => {
      if (sent.method === 'GET') return { approvals: authed ? [] : [item({})] }
      if (sent.path === '/v0/approvals/auth') {
        authed = true
        return { verified: true }
      }
      if (!authed) throw Object.assign(new Error('forbidden'), { status: 403 })
      return { delivered: true }
    })
    await flush()
    page.click('allow-once')
    await flush()
    await flush()
    expect(page.node('fx-approval-auth').hidden).toBe(false)
    expect(page.node('fx-approval-status').textContent).toBe('NEED')
    page.node('fx-approval-credential').value = 'secret-credential'
    page.click('allow-once')
    await flush()
    await flush()
    await flush()
    expect(page.sent.map(s => `${s.method} ${s.path}`)).toEqual([
      'GET /v0/approvals?mine=1',
      'POST /v0/approvals/r-1',
      'POST /v0/approvals/auth',
      'POST /v0/approvals/r-1',
      'GET /v0/approvals?mine=1',
    ])
    // The credential leaves the field as soon as it is sent.
    expect(page.node('fx-approval-credential').value).toBe('')
  })

  test('later dismisses a request without deciding it', async () => {
    const page = runPrompt(async () => ({ approvals: [item({})] }))
    await flush()
    page.click('later')
    expect(page.dialog.open).toBe(false)
    page.tick()
    await flush()
    expect(page.dialog.open).toBe(false)
    expect(page.sent.every(s => s.method === 'GET')).toBe(true)
  })
})
