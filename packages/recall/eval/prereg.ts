// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The preregistered values of `docs/dev/memory-m1.md` §9, read from
 * `prereg.toml` next to this file.
 *
 * Two properties are the point of this module:
 *
 *   1. **No defaults.** A key that is not in the file is `null`, and a gate
 *      that needs it throws {@link PreregistrationMissing}. A threshold that
 *      silently fell back to a value in code would be a threshold chosen by
 *      whoever last edited the code, which is exactly what preregistration
 *      exists to prevent.
 *   2. **No overrides.** The command-line tools read the file at its fixed
 *      path and take no flag that changes a value. Tests use
 *      {@link parsePreregistration} on their own text.
 *
 * Unknown keys are rejected rather than ignored: a misspelt key would
 * otherwise read as "not generated" and the value next to it would never be
 * used.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const PREREGISTRATION_PATH = fileURLToPath(
  new URL('./prereg.toml', import.meta.url),
)

export type E1Inference = 'bootstrap' | 'signflip'

export type Preregistration = {
  readonly retrieval: {
    readonly alphaPrimary: number | null
  }
  readonly answer: {
    readonly alphaPrimary: number | null
    readonly noninferiorityDelta: number | null
    readonly aaAlpha: number | null
    readonly bootstrapIterations: number | null
    readonly bootstrapSeed: number | null
    readonly e1Inference: E1Inference | null
  }
  readonly corpus: {
    readonly syntheticV1Sha256: string | null
    readonly docsDevV1Sha256: string | null
    readonly heldoutIdsSha256: string | null
    readonly shuffleSeed: number | null
    readonly m0BaselineSha256: string | null
  }
}

/** A gate needed a value the preregistration does not (yet) hold. */
export class PreregistrationMissing extends Error {
  constructor(readonly key: string) {
    super(
      `preregistration: ${key} is not generated yet (docs/dev/memory-m1.md §9); ` +
        'refusing to judge without it',
    )
    this.name = 'PreregistrationMissing'
  }
}

/** The value, or a {@link PreregistrationMissing} naming its key. */
export function required<T>(value: T | null, key: string): T {
  if (value === null) throw new PreregistrationMissing(key)
  return value
}

type Table = Readonly<Record<string, unknown>>

const SECTIONS: Readonly<Record<string, readonly string[]>> = {
  retrieval: ['alpha_primary'],
  answer: [
    'alpha_primary',
    'noninferiority_delta',
    'aa_alpha',
    'bootstrap_iterations',
    'bootstrap_seed',
    'e1_inference',
  ],
  corpus: [
    'synthetic_v1_sha256',
    'docs_dev_v1_sha256',
    'heldout_ids_sha256',
    'shuffle_seed',
    'm0_baseline_sha256',
  ],
}

function tableOf(root: Table, name: string): Table {
  const value = root[name]
  if (value === undefined) return {}
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`preregistration: [${name}] must be a table`)
  }
  const table = value as Table
  for (const key of Object.keys(table)) {
    if (!(SECTIONS[name] ?? []).includes(key)) {
      throw new Error(`preregistration: unknown key ${name}.${key}`)
    }
  }
  return table
}

function probability(table: Table, section: string, key: string) {
  const value = table[key]
  if (value === undefined) return null
  if (typeof value !== 'number' || !(value > 0 && value < 1)) {
    throw new Error(`preregistration: ${section}.${key} must be in (0, 1)`)
  }
  return value
}

function integer(table: Table, section: string, key: string, min: number) {
  const value = table[key]
  if (value === undefined) return null
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min) {
    throw new Error(
      `preregistration: ${section}.${key} must be an integer ≥ ${min}`,
    )
  }
  return value
}

function sha256(table: Table, section: string, key: string) {
  const value = table[key]
  if (value === undefined) return null
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`preregistration: ${section}.${key} must be a SHA-256 hex`)
  }
  return value
}

/** Parse and validate preregistration TOML. */
export function parsePreregistration(text: string): Preregistration {
  const root = Bun.TOML.parse(text) as Table
  for (const key of Object.keys(root)) {
    if (!(key in SECTIONS)) {
      throw new Error(`preregistration: unknown section [${key}]`)
    }
  }
  const retrieval = tableOf(root, 'retrieval')
  const answer = tableOf(root, 'answer')
  const corpus = tableOf(root, 'corpus')
  const inference = answer['e1_inference']
  if (
    inference !== undefined &&
    inference !== 'bootstrap' &&
    inference !== 'signflip'
  ) {
    throw new Error(
      'preregistration: answer.e1_inference must be "bootstrap" or "signflip"',
    )
  }
  return {
    retrieval: {
      alphaPrimary: probability(retrieval, 'retrieval', 'alpha_primary'),
    },
    answer: {
      alphaPrimary: probability(answer, 'answer', 'alpha_primary'),
      noninferiorityDelta: probability(
        answer,
        'answer',
        'noninferiority_delta',
      ),
      aaAlpha: probability(answer, 'answer', 'aa_alpha'),
      bootstrapIterations: integer(answer, 'answer', 'bootstrap_iterations', 1),
      bootstrapSeed: integer(answer, 'answer', 'bootstrap_seed', 0),
      e1Inference: inference ?? null,
    },
    corpus: {
      syntheticV1Sha256: sha256(corpus, 'corpus', 'synthetic_v1_sha256'),
      docsDevV1Sha256: sha256(corpus, 'corpus', 'docs_dev_v1_sha256'),
      heldoutIdsSha256: sha256(corpus, 'corpus', 'heldout_ids_sha256'),
      shuffleSeed: integer(corpus, 'corpus', 'shuffle_seed', 0),
      m0BaselineSha256: sha256(corpus, 'corpus', 'm0_baseline_sha256'),
    },
  }
}

/** The checked-in preregistration. */
export function loadPreregistration(): Preregistration {
  return parsePreregistration(readFileSync(PREREGISTRATION_PATH, 'utf8'))
}
