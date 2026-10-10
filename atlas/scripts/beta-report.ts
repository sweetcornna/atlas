// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { readTrail } from '@qianmo/audit'
import {
  betaReport,
  type Probe,
  type Timing,
  type Window,
} from './beta-report/core.js'

// Paths are explicit and relative to a local manifest; no network, auto-discovery or writes.
if (process.argv.length !== 3)
  throw new Error(
    'Usage: bun atlas/scripts/beta-report.ts <manifest.json> > report.json',
  )
const manifest = resolve(process.argv[2]!)
const cfg = JSON.parse(readFileSync(manifest, 'utf8')) as Window & {
  probes: string[]
  timings: { node: string; path: string }[]
  audits: string[]
}
if (
  !Array.isArray(cfg.probes) ||
  !cfg.probes.length ||
  !Array.isArray(cfg.timings) ||
  !Array.isArray(cfg.audits) ||
  !cfg.audits.length
)
  throw new Error('explicit probe/timing/audit sources required')
const provenance: { path: string; sha256: string; bytes: number }[] = []
function load(path: string) {
  if (typeof path !== 'string') throw new Error('invalid source path')
  const absolute = resolve(dirname(manifest), path),
    bytes = readFileSync(absolute)
  if (bytes.length > 128 * 1024 * 1024)
    throw new Error('source exceeds 128 MiB; split collection files')
  provenance.push({
    path,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.length,
  })
  return { absolute, bytes }
}
function lines(path: string): unknown[] {
  const { bytes } = load(path),
    text = bytes.toString('utf8')
  if (text && !text.endsWith('\n'))
    throw new Error('torn source tail; use a frozen collection')
  return text
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line))
}
const probes = cfg.probes.flatMap(path => lines(path)) as Probe[]
const timings = cfg.timings.flatMap(source =>
  lines(source.path).map(value => ({
    ...(value as object),
    node: source.node,
  })),
) as Timing[]
const records = cfg.audits.flatMap(path => {
  const { absolute, bytes } = load(path)
  const result = readTrail(absolute)
  if (
    !result.present ||
    !result.intact ||
    !readFileSync(absolute).equals(bytes)
  )
    throw new Error('audit source missing, corrupt or changed during read')
  return [...result.records]
})
console.log(
  JSON.stringify(
    { ...betaReport(cfg, probes, timings, records), provenance },
    null,
    2,
  ),
)
