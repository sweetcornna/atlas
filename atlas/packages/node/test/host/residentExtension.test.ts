// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { ompChildEnv } from '@qianmo/paths'
import { afterEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { residentExtensionSource } from '../../../../scripts/residentExtensionBundle.js'
import { writeResidentExtensionAsset } from '../../src/host/residentExtension.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})
function temporary() {
  const root = mkdtempSync(join(tmpdir(), 'qm-extension-asset-'))
  roots.push(root)
  return root
}

test('resident extension asset is private and source omp loads it without extension-local peers', async () => {
  const source = await residentExtensionSource()
  const root = temporary()
  const path = writeResidentExtensionAsset(root, source)
  expect(readFileSync(path, 'utf8')).toBe(source)
  expect(writeResidentExtensionAsset(root, source)).toBe(path)
  if (process.platform !== 'win32')
    expect(statSync(path).mode & 0o777).toBe(0o600)
  const env = ompChildEnv({
    PATH: process.env.PATH,
    HOME: root,
    QIANMO_CONFIG_DIR: root,
  })
  // Canonical externals are served by omp's loader, in source mode as well as
  // compiled mode. A bare import would bypass the actual extension contract.
  const loader = Bun.resolveSync(
    '@oh-my-pi/pi-coding-agent/extensibility/extensions',
    import.meta.dir,
  )
  const child = Bun.spawn(
    [
      process.execPath,
      '-e',
      `const {loadExtensions} = await import(${JSON.stringify(loader)}); const loaded = await loadExtensions([${JSON.stringify(path)}], process.cwd()); if (loaded.errors.length) throw new Error(JSON.stringify(loaded.errors)); const hook = loaded.extensions[0]?.handlers.get('tool_call')?.[0]; if (!hook) process.exit(4); const verdict = await hook({toolName:'write',input:{path:'any'}},{}); if (!verdict?.block) process.exit(5);`,
    ],
    {
      cwd: root,
      env,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )
  const stderr = await new Response(child.stderr).text()
  expect({ exit: await child.exited, stderr }).toEqual({ exit: 0, stderr: '' })
})

test('existing altered code and symlinks cannot replace the embedded policy', () => {
  const root = temporary()
  const source = 'export default () => {}\n'
  const path = writeResidentExtensionAsset(root, source)
  writeFileSync(path, 'export default () => "untrusted"\n')
  expect(() => writeResidentExtensionAsset(root, source)).toThrow(
    'differs from this binary',
  )
  const linked = temporary()
  const target = join(linked, 'target.mjs')
  writeFileSync(target, source)
  const hash = createHash('sha256').update(source).digest('hex')
  symlinkSync(target, join(linked, `resident-extension-${hash}.mjs`))
  expect(() => writeResidentExtensionAsset(linked, source)).toThrow()
  expect(readFileSync(target, 'utf8')).toBe(source)
})
