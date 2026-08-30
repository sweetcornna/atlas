// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The certificate column — key-distribution.md §10.1, and §9.1's **S-5**.
 *
 * S-5 is the one criterion of the five whose evidence is "目视 + 一条页面用例".
 * This file is that用例: the four things §10.1 asks the page to show, plus the
 * copy discipline every string on this console is held to (`view.test.ts`'s
 * `copy discipline` block states the rules; a new column is exactly where they
 * quietly stop being followed).
 */

import { describe, expect, test } from 'bun:test'
import { renderRoster } from '../src/view/agents.js'
import {
  certificateTally,
  reissueCommand,
  renderRevocationBar,
} from '../src/view/certificates.js'
import type {
  ConsoleAgent,
  ConsoleCertificate,
  ConsoleRevocationList,
} from '../src/deps.js'

const NOW = 1_760_000_000_000
const TTL = 300_000
const DAY = 24 * 60 * 60 * 1000

function agent(over: Partial<ConsoleAgent> = {}): ConsoleAgent {
  return {
    address: 'qianmo://node-a/reviewer',
    endpoint: 'node-a.internal:7421',
    capabilities: [],
    status: 'online',
    registeredAt: NOW - 600_000,
    lastHeartbeatAt: NOW - 10_000,
    expiresAt: NOW + TTL - 10_000,
    ...over,
  }
}

function certificate(
  over: Partial<ConsoleCertificate> = {},
): ConsoleCertificate {
  return {
    node: 'node-a',
    status: 'valid',
    fingerprint256: 'AB:CD:EF:01:23:45',
    notAfter: NOW + 62 * DAY,
    ...over,
  }
}

const FRESH_RL: ConsoleRevocationList = {
  issuedAt: NOW - DAY,
  nextUpdate: NOW + 29 * DAY,
  revokedCount: 0,
}

function roster(
  certificates: readonly ConsoleCertificate[] | null,
  revocationList: ConsoleRevocationList | null = FRESH_RL,
): string {
  return renderRoster([agent()], null, NOW, TTL, {
    snapshot: certificates === null ? null : { certificates, revocationList },
    failure: null,
    binName: 'qm',
  })
}

/** Visible text only — same extraction `view.test.ts`'s copy block uses. */
function visibleText(html: string): string {
  return html.replace(/<[^>]*>/g, ' ')
}

describe('the certificate column shows §10.1’s four things', () => {
  test('state, expiry and fingerprint ride on the node card', () => {
    const html = roster([certificate()])
    expect(html).toContain('data-cert-status="valid"')
    expect(html).toContain('证书 有效')
    expect(html).toContain('AB:CD:EF:01:23:45')
    expect(html).toContain('剩余 62d')
  })

  test('the fingerprint is shown whole, unlike the public key beside it', () => {
    // A truncated fingerprint cannot be compared against a runbook by eye,
    // which is the only thing it is for.
    const long = 'F1:E2:D3:C4:B5:A6:97:88:79:6A:5B:4C:3D:2E:1F:00:11:22:33:44'
    expect(roster([certificate({ fingerprint256: long })])).toContain(long)
  })

  test('the revocation list’s two clocks are in the page header', () => {
    const html = roster([certificate()])
    expect(html).toContain('吊销清单 0 条')
    expect(html).toContain('剩余 29d')
  })

  test('a stale list gets the red strip §6.4 needs it to have', () => {
    const html = roster([certificate()], {
      issuedAt: NOW - 40 * DAY,
      nextUpdate: NOW - DAY,
      revokedCount: 2,
    })
    expect(html).toContain('bar-bad')
    expect(html).toContain('已过期')
    expect(html).toContain('全网按 --trust 收敛')
  })

  test('never published and stale are two different lines', () => {
    // §6.4 gives them one fail-closed behaviour and two causes; this line is
    // the only place an operator can tell which one they are in.
    const never = renderRevocationBar(null, null, NOW)
    const stale = renderRevocationBar(
      { issuedAt: NOW - 40 * DAY, nextUpdate: NOW - DAY, revokedCount: 0 },
      null,
      NOW,
    )
    expect(never).toContain('吊销清单未发布')
    expect(stale).toContain('已过期')
    expect(never).not.toBe(stale)
  })
})

describe('the six states stay six', () => {
  test.each([
    ['valid', '证书 有效'],
    ['expiring', '证书 将到期'],
    ['expired', '证书 已过期'],
    ['revoked', '证书 已吊销'],
    ['absent', '证书 未发布'],
    ['bad-signature', '证书 签名不符'],
  ] as const)('%s renders its own word', (status, word) => {
    expect(roster([certificate({ status })])).toContain(word)
  })

  test('a forgery and an absence do not read the same', () => {
    // Opposite next actions: one is "this node has not been issued one", the
    // other is "somebody put something in a zero-auth registry" (§5.2 T-B).
    const forged = roster([certificate({ status: 'bad-signature' })])
    const missing = roster([certificate({ status: 'absent' })])
    expect(forged).toContain('证书 签名不符')
    expect(missing).toContain('证书 未发布')
    // `未发布` on its own also belongs to the public-key cell one row down —
    // the assertion has to name the certificate's word, not the string.
    expect(forged).not.toContain('证书 未发布')
  })
})

describe('§10.2: the command, never the button', () => {
  test('an expiring certificate offers a command line to copy', () => {
    const html = roster([certificate({ status: 'expiring' })])
    expect(html).toContain('qm ca issue node-a')
    // Not a form, not a button, not a route.
    expect(html).not.toContain('data-action="issue"')
    expect(html).not.toContain('<form')
  })

  test('a revoked certificate is not offered a re-issue', () => {
    // The one case where nudging would be wrong: somebody revoked that key
    // on purpose.
    expect(reissueCommand(certificate({ status: 'revoked' }), 'qm')).toBe('')
    expect(reissueCommand(certificate({ status: 'valid' }), 'qm')).toBe('')
    expect(reissueCommand(undefined, 'qm')).toBe('')
  })
})

describe('absent port removes the column rather than filling it', () => {
  test('no certificate half means no certificate markup at all', () => {
    const plain = renderRoster([agent()], null, NOW, TTL)
    expect(plain).not.toContain('data-cert-status')
    expect(plain).not.toContain('吊销清单')
    expect(plain).not.toContain('证书')
  })

  test('a node the port said nothing about gets no line either', () => {
    const html = roster([certificate({ node: 'node-z' })])
    expect(html).not.toContain('data-cert-status')
    // The header strip is still there: the revocation list is a fact about
    // the whole network, not about any one card.
    expect(html).toContain('吊销清单')
  })

  test('a failed certificate read is a strip, never an exception', () => {
    const html = renderRoster([agent()], null, NOW, TTL, {
      snapshot: null,
      failure: { code: 'unreachable', message: '连接被拒绝' },
      binName: 'qm',
    })
    expect(html).toContain('吊销清单未读到 · 连接被拒绝')
  })
})

describe('the column obeys the console’s copy discipline', () => {
  const html = roster([
    certificate({ status: 'expiring', notAfter: NOW + 5 * DAY }),
  ])

  test('no sentences and no comma-joined clauses', () => {
    const text = visibleText(html)
    expect(text).not.toContain('。')
    expect(text).not.toContain('，')
    expect(text).not.toContain('、')
  })

  test('no emoji and no pictographs', () => {
    expect(visibleText(html)).not.toMatch(/\p{Extended_Pictographic}/u)
  })

  test('the words are states, not explanations', () => {
    for (const banned of ['请', '建议', '可能', '注意事项']) {
      expect(visibleText(html)).not.toContain(banned)
    }
  })
})

describe('the roster header counts certificates that need a look', () => {
  test('all valid says so; anything else counts', () => {
    expect(
      certificateTally([certificate(), certificate({ node: 'node-b' })]),
    ).toContain('2 张证书有效')
    expect(
      certificateTally([
        certificate(),
        certificate({ node: 'node-b', status: 'expired' }),
      ]),
    ).toContain('1 张证书需注意')
    expect(certificateTally(null)).toBe('')
    expect(certificateTally([])).toBe('')
  })
})
