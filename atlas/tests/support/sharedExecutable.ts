// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Stand-in executables written once per test file and linked where a test
 * needs them (issues #56, #102).
 *
 * macOS scans every newly written executable inode on its first exec
 * (Gatekeeper / `syspolicyd`). The cost is not a constant: about 335 ms per
 * new script with the machine at load 7, 1.8–2.5 s when it is busy, with no
 * upper bound; a symlink to an inode that already ran costs about 4 ms. A test
 * that writes its own stub pays that scan on its own timer, so these stubs
 * share one inode per content: written once, run once right away, and linked
 * into each test's tree. Make the call at module scope and the scan is paid
 * before any test's timer starts.
 *
 * What that asks of a stub: its text is the same for every test. Anything
 * per test comes from its environment, its arguments, or files next to the
 * link — bash and sh do not resolve symlinks, so `$0` is the link's own path
 * and `${0%/*}` the test's directory, not this one. Bun does resolve them
 * (`process.argv[1]` and `import.meta.dir` name the shared file), so a Bun
 * stub reads only its environment and arguments. Nothing may write through a
 * link: that would rewrite the shared inode (remove the link first).
 *
 * Moved here from `demo/env/bootstrap-preconditions.test.ts` and
 * `demo/env/beta/ops/fleet-acceptance.test.ts`, which each had a copy.
 */

import { afterAll } from 'bun:test'
import { createHash } from 'node:crypto'
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const DIR = mkdtempSync(join(tmpdir(), 'qianmo-shared-exec-'))
afterAll(() => {
  rmSync(DIR, { recursive: true, force: true })
})

/** Content hash → the one file holding it. */
const written = new Map<string, string>()

/** A warm-up that hangs must not hang the file that loads the stub. */
const WARMUP_TIMEOUT_MS = 10_000

interface SharedExecutableOptions {
  /** Part of the file name, for whoever lists the directory; the content picks the inode. */
  readonly name?: string
  /** On top of `process.env` for the one warm-up run (`<file> --qianmo-warmup`). */
  readonly warmupEnv?: Readonly<Record<string, string>>
}

/** The one executable file holding `text` in this test file; written and run on first use. */
export function sharedExecutable(
  text: string,
  options: SharedExecutableOptions = {},
): string {
  const key = createHash('sha256').update(text).digest('hex').slice(0, 16)
  const hit = written.get(key)
  if (hit !== undefined) return hit
  const path = join(
    DIR,
    options.name === undefined ? key : `${options.name}-${key}`,
  )
  writeFileSync(path, text, { mode: 0o755 })
  // The scan is paid here: callers make this call before a test timer runs.
  Bun.spawnSync([path, '--qianmo-warmup'], {
    env: { ...process.env, ...options.warmupEnv },
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'ignore',
    timeout: WARMUP_TIMEOUT_MS,
  })
  written.set(key, path)
  return path
}

/**
 * Make `link` (its directory created, anything already there replaced) a
 * symlink to {@link sharedExecutable}`(text)`; returns `link`.
 */
export function linkSharedExecutable(
  link: string,
  text: string,
  options: SharedExecutableOptions = {},
): string {
  const target = sharedExecutable(text, options)
  mkdirSync(dirname(link), { recursive: true })
  rmSync(link, { force: true })
  symlinkSync(target, link)
  return link
}
