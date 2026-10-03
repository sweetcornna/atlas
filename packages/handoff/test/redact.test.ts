// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The handoff's own redaction layer (`redact.ts`): what it catches that the
 * gitleaks subset does not, and the ordinary text it must leave alone.
 */

import { afterAll, describe, expect, test } from 'bun:test'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { redactHandoffSecrets } from '../src/redact.js'
import { sessionCommit } from '../src/session.js'
import { cleanupTemporaries, git, initRepo, tempDir } from './helpers.js'

afterAll(cleanupTemporaries)

/** Fake values only. */
const CANARY = 'sk-test-canary-0123456789abcdefABCDEF'
const UNDERSCORE_KEY = 'sk_qianmo_fake_4f9c2a7e1b3d5f8a'
const CONSOLE_TOKEN = `qmu_${'Ab3-_x9Z'.repeat(6)}`
const BEARER = 'eyJhbGciOiJIUzI1NiJ9.e30.ZmFrZQ'

describe('redactHandoffSecrets: what it catches', () => {
  test('a generic sk- key, hyphens included, the canary shape', () => {
    const result = redactHandoffSecrets(`export OPENAI_API_KEY=${CANARY}\n`)
    expect(result.text).toBe('export OPENAI_API_KEY=***\n')
    expect(result.count).toBe(1)
    expect(result.ruleIds).toEqual(['handoff-sk-key'])
  })

  test('sk_ keys, and several in one text', () => {
    const result = redactHandoffSecrets(`a ${UNDERSCORE_KEY} b "${CANARY}"`)
    expect(result.text).toBe('a *** b "***"')
    expect(result.count).toBe(2)
  })

  test('console tokens qmu_ / qmi_ / qms_', () => {
    for (const prefix of ['qmu_', 'qmi_', 'qms_']) {
      const token = prefix + CONSOLE_TOKEN.slice(4)
      const result = redactHandoffSecrets(`token=${token};`)
      expect(result.text).toBe('token=***;')
      expect(result.ruleIds).toEqual(['handoff-console-token'])
    }
  })

  test('the token after Authorization: Bearer, also inside an escaped JSON string', () => {
    const plain = redactHandoffSecrets(`Authorization: Bearer ${BEARER}\n`)
    expect(plain.text).toBe('Authorization: Bearer ***\n')
    // A tool call in a JSONL transcript: the header sits inside a JSON string.
    const line = JSON.stringify({
      type: 'function_call',
      arguments: JSON.stringify({
        cmd: `curl -H "authorization: bearer ${BEARER}" https://hub.example/v0/handoff`,
      }),
    })
    const escaped = redactHandoffSecrets(line)
    expect(escaped.text).not.toContain(BEARER)
    expect(escaped.ruleIds).toEqual(['handoff-bearer'])
    expect(JSON.parse(escaped.text).type).toBe('function_call')
  })

  test('the value of an api_key field, raw and as JSON inside JSON', () => {
    const raw = redactHandoffSecrets(
      '{"api_key": "plain-value-1", "apiKey":\'v2\'}',
    )
    expect(raw.text).toBe('{"api_key": "***", "apiKey":\'***\'}')
    expect(raw.count).toBe(2)
    const nested = JSON.stringify({
      output: JSON.stringify({
        'api-key': 'nested-value',
        model: 'gpt-6-luna',
      }),
    })
    const result = redactHandoffSecrets(nested)
    expect(result.text).not.toContain('nested-value')
    expect(result.text).toContain('gpt-6-luna')
    expect(JSON.parse(JSON.parse(result.text).output)['api-key']).toBe('***')
  })
})

describe('redactHandoffSecrets: what it leaves alone (positive control)', () => {
  test('ordinary text with look-alike words is returned unchanged, zero hits', () => {
    const text = [
      'task-complete-for-the-long-running-job',
      'ask_the_operator_before_continuing_now',
      'pip install sk-learn',
      'the qms-planner agent and qmu_short',
      'he was the Bearer of bad news',
      'Authorization: Bearer $QM_TOKEN',
      'Authorization: Bearer [REDACTED]',
      '{"api_key": "***", "api_key_name": "billing", "apiKeyHint": "see vault"}',
      'the api key lives in the vault, not here',
    ].join('\n')
    const result = redactHandoffSecrets(text)
    expect(result.text).toBe(text)
    expect(result.count).toBe(0)
    expect(result.ruleIds).toEqual([])
  })
})

describe('sessionCommit applies the handoff layer after the gitleaks one', () => {
  test('the canary is gone from the stored blob; the rule id is reported, the file untouched', async () => {
    const repo = initRepo()
    const file = join(tempDir(), 'rollout.jsonl')
    const text =
      `${JSON.stringify({ type: 'response_item', payload: { text: `key ${CANARY}` } })}\n` +
      `${JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'task-complete-for-the-long-running-job' } })}\n`
    writeFileSync(file, text)
    const result = await sessionCommit({ cwd: repo, file, redact: true })
    const stored = git(repo, 'cat-file', 'blob', result.blob)
    expect(stored).not.toContain(CANARY)
    expect(stored).toContain('key ***')
    expect(stored).toContain('task-complete-for-the-long-running-job')
    expect(result.redactions).toEqual({ count: 1, ruleIds: ['handoff-sk-key'] })
    expect(readFileSync(file, 'utf8')).toBe(text)
  })
})
