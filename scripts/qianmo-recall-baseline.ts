#!/usr/bin/env bun
// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Retrieval-layer baseline for `@qianmo/recall` — `docs/dev/memory-m1.md` §3.
 *
 * Offline and deterministic: no model, no network, no wall clock. It measures
 * which entries `recall()` puts in front of a model, not what a model does
 * with them. The answer layer (hit rate, hallucinated-citation rate) needs a
 * real model and is a separate protocol; nothing printed here is an
 * answer-layer number.
 *
 * Exit code is 0 whenever the run completes. This is a measurement, not a
 * gate: the numbers are not compared against any threshold.
 *
 * Usage:
 *   bun run qianmo:recall-baseline                         # markdown summary
 *   bun run qianmo:recall-baseline --json /tmp/base.json   # also the full report
 *   bun run qianmo:recall-baseline --seed 7 --tiers 30,500 --decay default,off
 */

import { writeFileSync } from 'node:fs'
import { DEFAULT_SEED, DEFAULT_TIERS } from '../packages/recall/eval/dataset.js'
import {
  type DecayMode,
  renderMarkdown,
  runBaseline,
} from '../packages/recall/eval/run.js'

type Cli = {
  readonly seed: number
  readonly tiers: readonly number[]
  readonly decay: readonly DecayMode[]
  readonly json: string | null
}

function parseIntegers(flag: string, raw: string): number[] {
  return raw.split(',').map(part => {
    const value = Number(part.trim())
    if (!Number.isInteger(value)) {
      throw new Error(`${flag} expects integers, got ${JSON.stringify(raw)}`)
    }
    return value
  })
}

function parseDecay(raw: string): DecayMode[] {
  return raw.split(',').map(part => {
    const value = part.trim()
    if (value !== 'default' && value !== 'off') {
      throw new Error(`--decay expects default|off, got ${JSON.stringify(raw)}`)
    }
    return value
  })
}

function parseCli(argv: readonly string[]): Cli {
  let seed = DEFAULT_SEED
  let tiers: readonly number[] = DEFAULT_TIERS
  let decay: readonly DecayMode[] = ['default', 'off']
  let json: string | null = null
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]
    const value = argv[i + 1]
    if (value === undefined) throw new Error(`${flag} needs a value`)
    switch (flag) {
      case '--seed':
        seed = parseIntegers(flag, value)[0] ?? DEFAULT_SEED
        break
      case '--tiers':
        tiers = parseIntegers(flag, value)
        break
      case '--decay':
        decay = parseDecay(value)
        break
      case '--json':
        json = value
        break
      default:
        throw new Error(`unknown flag ${flag}`)
    }
    i += 1
  }
  return { seed, tiers, decay, json }
}

if (import.meta.main) {
  const cli = parseCli(process.argv.slice(2))
  const started = performance.now()
  const report = runBaseline(cli)
  const elapsed = Math.round(performance.now() - started)
  console.log(renderMarkdown(report))
  if (cli.json !== null) {
    writeFileSync(cli.json, `${JSON.stringify(report, null, 2)}\n`)
  }
  // Timing goes to stderr so stdout stays byte-identical across runs.
  console.error(`[recall-baseline] done in ${elapsed} ms`)
}
