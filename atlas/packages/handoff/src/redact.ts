// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The handoff's own redaction layer, run on a session transcript **after**
 * `redactSecrets` (tool-runtime's gitleaks subset).
 *
 * That subset is built for precision: it knows a key by its vendor's exact
 * shape, so a gateway key such as `sk-` plus forty arbitrary characters, a
 * console credential, or a token sitting in an `Authorization` header goes
 * through it untouched. A transcript is full of exactly those — the model
 * reads config files, runs `curl -H`, echoes `.env` — and it leaves the
 * laptop. So the hub copy gets a second, broader pass:
 *
 * | rule id | catches |
 * | --- | --- |
 * | `handoff-sk-key` | `sk-` / `sk_` followed by key characters, 20 or more in all |
 * | `handoff-console-token` | the console's minted secrets `qmu_` / `qmi_` / `qms_` (`packages/console/src/accounts.ts`: 32 random bytes in base64url after the prefix — 40 characters or more, so `qms-planner` is left alone) |
 * | `handoff-bearer` | the token in `Authorization: Bearer <token>` |
 * | `handoff-api-key-field` | the value in `"api_key": "…"` (also `apiKey`, `api-key`, single quotes, and the `\"…\"` form a JSON string inside a JSONL line takes) |
 *
 * Every hit becomes `***`. What comes back is the count and the rule ids,
 * never the text. Values that are already a mask (`***`, `[REDACTED]`) or a
 * shell variable (`$TOKEN`) are left as they are and not counted.
 *
 * Broader means some false positives: a 20-character word that starts with
 * `sk-` after a non-word character is taken for a key. A transcript loses a
 * word; a key on the hub cannot be taken back.
 */

const MASK = '***'

interface Rule {
  readonly id: string
  readonly pattern: RegExp
  /** The capture group holding the secret; 0 for the whole match. */
  readonly group: 0 | 2
}

/** Not preceded by a key character: `task-…`, `ask_…` are words, not keys. */
const KEY_START = '(?<![A-Za-z0-9_-])'

const RULES: readonly Rule[] = [
  {
    id: 'handoff-sk-key',
    pattern: new RegExp(`${KEY_START}sk[-_][A-Za-z0-9_-]{17,}`, 'g'),
    group: 0,
  },
  {
    id: 'handoff-console-token',
    pattern: new RegExp(`${KEY_START}qm[ius]_[A-Za-z0-9_-]{40,}`, 'g'),
    group: 0,
  },
  {
    id: 'handoff-bearer',
    pattern: /(\bAuthorization\s*:\s*Bearer\s+)([^\s"'\\,;]{8,})/gi,
    group: 2,
  },
  {
    id: 'handoff-api-key-field',
    pattern: /(\\?["']api[_-]?key\\?["']\s*:\s*\\?["'])([^"'\\]+)/gi,
    group: 2,
  },
]

function alreadyMasked(value: string): boolean {
  return (
    value === MASK || value.startsWith('[REDACTED') || value.startsWith('$')
  )
}

/** `text` with every hit of the handoff rules replaced by `***`. */
export function redactHandoffSecrets(text: string): {
  readonly text: string
  readonly count: number
  readonly ruleIds: readonly string[]
} {
  let out = text
  let count = 0
  const ruleIds: string[] = []
  for (const rule of RULES) {
    let hits = 0
    out = out.replace(rule.pattern, (match: string, ...groups: unknown[]) => {
      if (rule.group === 0) {
        hits++
        return MASK
      }
      const prefix = String(groups[0] ?? '')
      const secret = String(groups[1] ?? '')
      if (alreadyMasked(secret)) return match
      hits++
      return `${prefix}${MASK}`
    })
    if (hits > 0) {
      count += hits
      ruleIds.push(rule.id)
    }
  }
  return { text: out, count, ruleIds }
}
