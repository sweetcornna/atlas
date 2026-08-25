// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: MIT

import { afterEach, describe, expect, test } from 'bun:test'
import { sourceCommit } from '../buildProvenance.js'

/**
 * `MACRO` is a compile-time substitution, so under `bun test` it simply is not
 * a global. Both halves matter here, and the second is the one that has bitten
 * this repo before: the `typeof MACRO !== 'undefined'` idiom survives into the
 * bundle as a test that is *false* at runtime, so a define read that way is
 * silently lost in exactly the shipped artifact it was meant to stamp.
 */
type MacroGlobal = { MACRO?: { SOURCE_COMMIT?: string } }

function setMacro(value: { SOURCE_COMMIT?: string } | undefined): void {
  const holder = globalThis as unknown as MacroGlobal
  if (value === undefined) delete holder.MACRO
  else holder.MACRO = value
}

afterEach(() => {
  // Process-global, like every other MACRO stub in the suite — leaving one
  // behind would hand it to every file that runs after this one.
  setMacro(undefined)
})

describe('sourceCommit', () => {
  test('reports the injected commit', () => {
    setMacro({ SOURCE_COMMIT: 'a'.repeat(40) })

    expect(sourceCommit()).toBe('a'.repeat(40))
  })

  test('keeps the -dirty suffix intact', () => {
    setMacro({ SOURCE_COMMIT: `${'b'.repeat(40)}-dirty` })

    expect(sourceCommit()).toBe(`${'b'.repeat(40)}-dirty`)
  })

  test('answers unknown when the define was never substituted', () => {
    setMacro(undefined)

    expect(sourceCommit()).toBe('unknown')
  })

  test('answers unknown rather than an empty field', () => {
    setMacro({ SOURCE_COMMIT: '' })

    expect(sourceCommit()).toBe('unknown')
  })
})
