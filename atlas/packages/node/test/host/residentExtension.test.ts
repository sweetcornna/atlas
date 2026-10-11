// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { ompChildEnv } from '@qianmo/paths'
import * as pathModule from 'node:path'
import { afterEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import {
  mkdtempSync,
  mkdirSync,
  copyFileSync,
  readdirSync,
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

test('resident extension asset is bundled, private and loadable without a package tree', async () => {
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
    PI_COMPILED: 'true',
  })
  const nativeDir = pathModule.dirname(
    Bun.resolveSync('@oh-my-pi/pi-natives', import.meta.dir),
  )
  const version = JSON.parse(
    readFileSync(pathModule.join(nativeDir, '../package.json'), 'utf8'),
  ).version as string
  const cache = pathModule.join(env.PI_NATIVES_DIR!, version)
  mkdirSync(cache, { recursive: true, mode: 0o700 })
  for (const file of readdirSync(nativeDir).filter(name =>
    name.endsWith('.node'),
  ))
    copyFileSync(pathModule.join(nativeDir, file), pathModule.join(cache, file))
  const child = Bun.spawn(
    [
      process.execPath,
      '-e',
      `const m = await import(${JSON.stringify(path)}); if (typeof m.default !== 'function') process.exit(4); const hooks = new Map(); m.default({on:(name,fn)=>hooks.set(name,fn)}); const verdict = await hooks.get('tool_call')({toolName:'write',input:{path:'any'}},{}); if (!verdict?.block) process.exit(5);`,
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
