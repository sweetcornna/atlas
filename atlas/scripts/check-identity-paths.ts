// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Identity-path bypass gate (base-switch-omp.md §6).
 *
 * Node isolation rests on one invariant: every config-root path is derived in
 * `@qianmo/paths` (`qianmoConfigDir()`, `ompConfigRoot()`, `caDir()`, …), and
 * omp children get their state root only through `ompChildEnv()`. A single
 * hard-coded `.qianmo` / `.omp` / `.claude` / `.occ` directory literal anywhere
 * else silently ignores `QIANMO_CONFIG_DIR` and is the one way that isolation
 * fails — a test or node writing into a developer's real `~/.omp` or
 * `~/.claude`.
 *
 * Scope: atlas-owned production code only — tracked or new files (git index
 * plus untracked, not ignored) that do not exist in the base snapshot
 * `base-snapshot/omp-v18.8.4`, with a `.ts` / `.tsx` extension, under `atlas/`
 * or `demo/`, excluding tests. omp's own files are never scanned: they keep
 * their `.omp` literals by design and `ompChildEnv()` redirects them.
 * Comments are stripped, so prose may mention the literals; tests are out of
 * scope because they assert against the literals on purpose.
 *
 * Forbidden outside the allowlist:
 *   - '.qianmo' / '.omp' / '.claude' / '.occ' (and their '.json' forms)
 *   - join(homedir(), '.qianmo' | '.omp' | '.claude' | '.occ')
 *
 * Zero tolerance; there is no budget file because the correct number is zero.
 *
 * Usage: bun atlas/scripts/check-identity-paths.ts
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO_ROOT = join(import.meta.dir, '..', '..')
const SNAPSHOT_TAG = 'base-snapshot/omp-v18.8.4'

const ALLOWLIST: Record<string, true> = {
  // The derivation module itself.
  'atlas/packages/paths/src/index.ts': true,
  // A deliberate inverse exception: the resident hardline table must list the
  // protected roots as literals. Deriving it from the current config root
  // would protect only the current identity, which is exactly the hole the
  // guard exists to close.
  'atlas/packages/resident/src/guard.ts': true,
  // The omp extension enforces that same hardline inside every agent child,
  // where `ompChildEnv()` has already rewritten the omp root; it names the
  // user-level roots literally for the same reason as the guard.
  'atlas/packages/extension/src/index.ts': true,
  // The policy table names protected per-workspace configuration directories.
  'atlas/packages/extension/src/policy.ts': true,
  // qmcode's app-server imports sessions from `$HOME/.claude/projects/…`: a
  // third-party tool's fixed location, kept in one exported constant there.
  'atlas/packages/node/src/commands/handoffNode.ts': true,
}

const IDENTITY_DIR = '(?:qianmo|omp|claude|occ)'
const FORBIDDEN: readonly { pattern: RegExp; label: string }[] = [
  {
    pattern: new RegExp(`['"\`]\\.${IDENTITY_DIR}(?:\\.json)?['"\`]`),
    label: 'identity dir/global-file literal',
  },
  {
    pattern: new RegExp(
      `join\\(\\s*(?:os\\.)?homedir\\(\\)\\s*,\\s*['"\`]\\.${IDENTITY_DIR}['"\`]`,
    ),
    label: 'homedir()-joined identity path',
  },
]

/**
 * Strip comments so prose may mention the literals. Line comments are only
 * recognised when `//` is not preceded by `:` (keeps `https://…` intact);
 * block comments are tracked across lines.
 */
export function stripComments(lines: readonly string[]): string[] {
  const out: string[] = []
  let inBlock = false
  for (const raw of lines) {
    let line = raw
    let result = ''
    while (line.length > 0) {
      if (inBlock) {
        const end = line.indexOf('*/')
        if (end === -1) {
          line = ''
        } else {
          line = line.slice(end + 2)
          inBlock = false
        }
        continue
      }
      const block = line.indexOf('/*')
      const lineComment = line.search(/(?<!:)\/\//)
      if (block !== -1 && (lineComment === -1 || block < lineComment)) {
        result += line.slice(0, block)
        line = line.slice(block + 2)
        inBlock = true
      } else if (lineComment !== -1) {
        result += line.slice(0, lineComment)
        line = ''
      } else {
        result += line
        line = ''
      }
    }
    out.push(result)
  }
  return out
}

/** Whether `path` is atlas production source this gate judges. */
export function isScannedPath(path: string): boolean {
  if (!/^(?:atlas|demo)\//.test(path)) return false
  if (!/\.tsx?$/.test(path) || path.endsWith('.d.ts')) return false
  if (path.startsWith('atlas/tests/')) return false
  if (/(?:^|\/)(?:__tests__|test|tests)\//.test(path)) return false
  if (/\.test\.tsx?$/.test(path)) return false
  return !ALLOWLIST[path]
}

/** Violations in one file's text, as `path:line [label] code`. */
export function findBypasses(path: string, text: string): string[] {
  const violations: string[] = []
  stripComments(text.split('\n')).forEach((line, i) => {
    for (const { pattern, label } of FORBIDDEN) {
      if (pattern.test(line)) {
        violations.push(`${path}:${i + 1} [${label}] ${line.trim()}`)
      }
    }
  })
  return violations
}

/** Run a `-z` git listing; returns the NUL-separated paths, untrimmed. */
function gitPaths(args: string[]): string[] {
  const proc = Bun.spawnSync(['git', ...args], {
    cwd: REPO_ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (proc.exitCode !== 0) {
    console.error(`[identity-paths] git ${args.join(' ')} failed:`)
    console.error(proc.stderr.toString().trim())
    process.exit(1)
  }
  return proc.stdout
    .toString()
    .split('\0')
    .filter(path => path !== '')
}

function main(): void {
  const snapshot = new Set(
    gitPaths(['ls-tree', '-r', '-z', '--name-only', SNAPSHOT_TAG]),
  )
  const candidates = gitPaths([
    'ls-files',
    '-z',
    '--cached',
    '--others',
    '--exclude-standard',
    '--',
    'atlas',
    'demo',
  ])
  const files = candidates
    .filter(path => !snapshot.has(path) && isScannedPath(path))
    .filter(path => existsSync(join(REPO_ROOT, path)))
    .sort()
  if (files.length === 0) {
    console.error('[identity-paths] FAIL: no atlas files to scan')
    process.exit(1)
  }

  const violations: string[] = []
  for (const path of files) {
    const text = readFileSync(join(REPO_ROOT, path), 'utf8')
    violations.push(...findBypasses(path, text))
  }

  if (violations.length > 0) {
    console.error(
      `[identity-paths] FAIL: ${violations.length} identity-path bypass(es) — derive these from @qianmo/paths instead:`,
    )
    for (const v of violations) console.error(`  ${v}`)
    process.exit(1)
  }
  console.log(
    `[identity-paths] OK — ${files.length} atlas production files scanned, 0 bypasses`,
  )
}

if (import.meta.main) main()
