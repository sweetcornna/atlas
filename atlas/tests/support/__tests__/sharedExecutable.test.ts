// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `support/sharedExecutable.ts`: one inode per content, warmed when it is
 * written, and links that still tell a shell stub which test it runs for.
 */
import { afterAll, expect, test } from 'bun:test'
import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { linkSharedExecutable, sharedExecutable } from '../sharedExecutable.ts'

const ROOT = mkdtempSync(join(tmpdir(), 'qianmo-shared-exec-test-'))
afterAll(() => rmSync(ROOT, { recursive: true, force: true }))

/** Prints the directory of the path it was started by. */
const WHERE = `#!/bin/bash\nprintf '%s' "\${0%/*}"\n`

test('one file per content, run once when it is written', () => {
  const mark = join(ROOT, 'warmed')
  const text =
    '#!/bin/sh\n[ -z "$WARM_MARK" ] || printf \'%s\' "$1" >"$WARM_MARK"\n'
  const first = sharedExecutable(text, { warmupEnv: { WARM_MARK: mark } })
  expect(readFileSync(mark, 'utf8')).toBe('--qianmo-warmup')
  rmSync(mark)
  expect(sharedExecutable(text, { warmupEnv: { WARM_MARK: mark } })).toBe(first)
  // The second call reused the file: no second warm-up.
  expect(() => lstatSync(mark)).toThrow()
  expect(sharedExecutable(`${text}\n`)).not.toBe(first)
})

test('a shell stub behind a link sees the link’s directory, not the shared one', () => {
  const a = linkSharedExecutable(join(ROOT, 'a', 'where'), WHERE)
  const b = linkSharedExecutable(join(ROOT, 'b', 'where'), WHERE)
  expect(realpathSync(a)).toBe(realpathSync(b))
  expect(Bun.spawnSync([a]).stdout.toString()).toBe(join(ROOT, 'a'))
  expect(Bun.spawnSync([b]).stdout.toString()).toBe(join(ROOT, 'b'))
})

test('a link replaces whatever was at its path', () => {
  const link = join(ROOT, 'c', 'where')
  linkSharedExecutable(join(ROOT, 'c', 'other'), WHERE)
  writeFileSync(link, 'not a link\n')
  linkSharedExecutable(link, WHERE)
  expect(lstatSync(link).isSymbolicLink()).toBe(true)
  expect(Bun.spawnSync([link]).stdout.toString()).toBe(join(ROOT, 'c'))
})
