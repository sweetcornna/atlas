#!/usr/bin/env bun
// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Import-cycle ratchet over the atlas module graph (base-switch-omp.md §6).
 *
 * madge walks every module reachable from the `qm` entry
 * (`atlas/packages/node/src/cli.ts`), following `@qianmo/*` workspace imports
 * (resolved through each package's `exports`) into `atlas/packages/*`; omp
 * packages and other dependencies are leaves. Two counts are kept in
 * `atlas/scripts/cycle-budget.json`:
 *
 *   runtime  cycles that survive type erasure (type-only imports skipped):
 *            they execute at import time and can hand out half-initialised
 *            modules;
 *   total    every cycle, `import type` edges included.
 *
 * The ratchet is two-sided: above budget fails (break the cycle or raise the
 * budget deliberately), below budget fails until `--update` commits the lower
 * baseline in the same change.
 *
 * Usage:
 *   bun atlas/scripts/check-cycles.ts
 *   bun atlas/scripts/check-cycles.ts --update
 */

import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { isAbsolute, join, relative, resolve } from 'node:path'

const REPO_ROOT = join(import.meta.dir, '..', '..')
const ENTRY = join(REPO_ROOT, 'atlas', 'packages', 'node', 'src', 'cli.ts')
const BUDGET_FILE = join(import.meta.dir, 'cycle-budget.json')
const SAMPLE_SIZE = 10

type Cycle = string[]
interface MadgeResult {
  circular(): Cycle[]
  obj(): Record<string, string[]>
}
type MadgeFn = (
  entry: string,
  options: Record<string, unknown>,
) => Promise<MadgeResult>

/**
 * madge's TypeScript detective parses through `@typescript-eslint/typescript-estree`,
 * which needs the TypeScript 5 JS API; the repo root hoists TypeScript 7 (native,
 * no JS API). Hand the parser the TypeScript 5 copy madge's own dependency tree
 * already installs, before madge is loaded.
 */
function loadMadge(): MadgeFn {
  const req = createRequire(import.meta.url)
  const madgeReq = createRequire(req.resolve('madge'))
  const ts5 = createRequire(madgeReq.resolve('dependency-tree')).resolve(
    'typescript',
  )
  const estreeReq = createRequire(
    createRequire(madgeReq.resolve('detective-typescript')).resolve(
      '@typescript-eslint/typescript-estree',
    ),
  )
  const key = estreeReq.resolve('typescript')
  req.cache[key] = {
    id: key,
    filename: key,
    loaded: true,
    exports: req(ts5),
  } as unknown as NodeJS.Module
  return req('madge')
}

/** tsconfig `paths` for every `@qianmo/*` export, so subpath imports resolve too. */
function workspacePaths(): Record<string, string[]> {
  const paths: Record<string, string[]> = {}
  const root = join(REPO_ROOT, 'atlas', 'packages')
  for (const dir of readdirSync(root)) {
    const manifest = join(root, dir, 'package.json')
    if (!existsSync(manifest)) continue
    const pkg = JSON.parse(readFileSync(manifest, 'utf8')) as {
      name: string
      exports?: Record<string, string>
    }
    for (const [key, target] of Object.entries(pkg.exports ?? {})) {
      const spec = key === '.' ? pkg.name : `${pkg.name}/${key.slice(2)}`
      paths[spec] = [join('atlas', 'packages', dir, target)]
    }
  }
  return paths
}

interface Budget {
  runtime: number
  total: number
}

/** Repo-relative form of a madge module path (madge reports entry-relative). */
function displayPath(modulePath: string): string {
  const absolute = isAbsolute(modulePath)
    ? modulePath
    : resolve(join(ENTRY, '..'), modulePath)
  const real = existsSync(absolute) ? realpathSync(absolute) : absolute
  return relative(REPO_ROOT, real)
}

async function analyze(
  madge: MadgeFn,
  label: string,
  skipTypeImports: boolean,
): Promise<Cycle[]> {
  const started = Date.now()
  const result = await madge(ENTRY, {
    tsConfig: {
      compilerOptions: {
        baseUrl: REPO_ROOT,
        moduleResolution: 'bundler',
        allowImportingTsExtensions: true,
        paths: workspacePaths(),
      },
    },
    fileExtensions: ['ts', 'tsx'],
    dependencyFilter: (path: string) => {
      const absolute = existsSync(path) ? realpathSync(path) : resolve(path)
      return relative(REPO_ROOT, absolute).startsWith('atlas/')
    },
    ...(skipTypeImports
      ? {
          detectiveOptions: {
            ts: { skipTypeImports: true },
            tsx: { skipTypeImports: true },
          },
        }
      : {}),
  })
  const cycles = result.circular()
  const modules = Object.keys(result.obj()).length
  if (modules < 2)
    throw new Error(
      `Cycle analysis found only ${modules} modules; refusing an empty graph`,
    )
  const seconds = ((Date.now() - started) / 1000).toFixed(1)
  console.log(
    `[cycles] ${label}: ${cycles.length} cycles across ${modules} modules (${seconds}s)`,
  )
  return cycles
}

function verdict(
  label: keyof Budget,
  cycles: Cycle[],
  budget: number,
): boolean {
  const actual = cycles.length
  if (actual === budget) {
    console.log(`[cycles] OK ${label}: ${actual} (at budget)`)
    return false
  }
  if (actual < budget) {
    console.error(
      `[cycles] FAIL ${label}: ${actual} < budget ${budget} — run with --update and commit the lower baseline`,
    )
    return true
  }
  console.error(
    `[cycles] FAIL ${label}: ${actual} > budget ${budget} — new import cycles; break them or raise "${label}" deliberately:`,
  )
  for (const cycle of cycles.slice(0, SAMPLE_SIZE)) {
    const hops = cycle.map(displayPath)
    console.error(`  ${hops.join(' -> ')} -> ${hops[0]}`)
  }
  if (cycles.length > SAMPLE_SIZE) {
    console.error(`  … and ${cycles.length - SAMPLE_SIZE} more`)
  }
  return true
}

async function main(): Promise<void> {
  const update = process.argv.includes('--update')
  if (!existsSync(ENTRY)) {
    console.error(
      `[cycles] FAIL: entry ${relative(REPO_ROOT, ENTRY)} not found`,
    )
    process.exit(1)
  }
  const budget: Budget | undefined = update
    ? undefined
    : (JSON.parse(readFileSync(BUDGET_FILE, 'utf8')) as Budget)

  const madge = loadMadge()
  const runtime = await analyze(madge, 'runtime', true)
  const total = await analyze(madge, 'total', false)

  if (update) {
    const next: Budget = { runtime: runtime.length, total: total.length }
    writeFileSync(BUDGET_FILE, `${JSON.stringify(next, null, 2)}\n`)
    console.log(`[cycles] budget written: ${JSON.stringify(next)}`)
    return
  }
  const failedRuntime = verdict('runtime', runtime, budget?.runtime ?? 0)
  const failedTotal = verdict('total', total, budget?.total ?? 0)
  if (failedRuntime || failedTotal) process.exit(1)
}

if (import.meta.main) await main()
