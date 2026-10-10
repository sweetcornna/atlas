// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from 'bun:test'

import { REDACTED, redactSecrets, scanForSecrets } from '../src/secrets.js'
import { FAKE_GITHUB_PAT } from './helpers.js'

// Fakes are assembled at runtime so no key-shaped literal sits in the repo.
const AWS = ['AKIA', 'IOSFODNN7EXAMPLE'].join('')
const SLACK_BOT = ['xoxb', '1234567890', '1234567890', 'abcdefABCDEF'].join('-')
const STRIPE = ['sk', 'live', 'a1b2c3d4e5f6g7h8i9j0'].join('_')
const NPM = `npm_${'a1B2'.repeat(9)}`
const GITLAB = `glpat-${'x1Y2'.repeat(5)}`
const ANTHROPIC = `${['sk', 'ant', 'api03'].join('-')}-${'a'.repeat(93)}AA`
const OPENAI_LEGACY = `sk-${'A'.repeat(20)}T3BlbkFJ${'b'.repeat(20)}`
const PRIVATE_KEY = [
  '-----BEGIN RSA PRIVATE KEY-----',
  'M'.repeat(64),
  '-----END RSA PRIVATE KEY-----',
].join('\n')

const ids = (text: string) => scanForSecrets(text).map(m => m.ruleId)

describe('scanForSecrets', () => {
  test.each([
    ['github-pat', FAKE_GITHUB_PAT],
    ['aws-access-token', AWS],
    ['slack-bot-token', SLACK_BOT],
    ['stripe-access-token', STRIPE],
    ['npm-access-token', NPM],
    ['gitlab-pat', GITLAB],
    ['anthropic-api-key', ANTHROPIC],
    ['openai-api-key', OPENAI_LEGACY],
    ['private-key', PRIVATE_KEY],
  ])('%s', (ruleId, secret) => {
    expect(ids(`config: ${secret}\n`)).toEqual([ruleId])
  })

  test('one match per rule, however many hits, in rule order', () => {
    expect(ids(`${AWS} ${FAKE_GITHUB_PAT} ${FAKE_GITHUB_PAT}`)).toEqual([
      'aws-access-token',
      'github-pat',
    ])
  })

  test('a match reports the rule only, never the text', () => {
    expect(scanForSecrets(FAKE_GITHUB_PAT)).toEqual([{ ruleId: 'github-pat' }])
  })

  test('repeated scans are independent (no regex state carried over)', () => {
    expect(ids(FAKE_GITHUB_PAT)).toEqual(['github-pat'])
    expect(ids(FAKE_GITHUB_PAT)).toEqual(['github-pat'])
  })

  test('ordinary prose and near-misses do not fire', () => {
    for (const text of [
      'run bun test and commit',
      'ghp_short',
      'AKIA lowercase akiaiosfodnn7example',
      'sk-learn is a python package',
      'stripe sk_live_short',
      '-----BEGIN PUBLIC KEY-----\nabc\n-----END PUBLIC KEY-----',
    ]) {
      expect(ids(text)).toEqual([])
    }
  })

  test('a boundary-delimited key needs its boundary', () => {
    expect(ids(`${NPM}x`)).toEqual([])
    expect(ids(`"${NPM}"`)).toEqual(['npm-access-token'])
  })
})

describe('redactSecrets', () => {
  test('replaces every occurrence of every rule', () => {
    const out = redactSecrets(
      `a=${FAKE_GITHUB_PAT}\nb=${FAKE_GITHUB_PAT}\nc=${AWS}`,
    )
    expect(out).toBe(`a=${REDACTED}\nb=${REDACTED}\nc=${REDACTED}`)
    expect(scanForSecrets(out)).toEqual([])
  })

  test('keeps the boundary characters a rule matched around the key', () => {
    expect(redactSecrets(`{"token":"${NPM}";}`)).toBe(
      `{"token":"${REDACTED}";}`,
    )
    expect(redactSecrets(`key ${STRIPE} end`)).toBe(`key ${REDACTED} end`)
  })

  test('multi-line key blocks are replaced whole', () => {
    expect(redactSecrets(`before\n${PRIVATE_KEY}\nafter`)).toBe(
      `before\n${REDACTED}\nafter`,
    )
  })

  test('text without a hit is returned unchanged', () => {
    const text = 'nothing secret here: sk-learn, ghp_short'
    expect(redactSecrets(text)).toBe(text)
  })
})
