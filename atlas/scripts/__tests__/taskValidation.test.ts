// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, expect, test } from 'bun:test'
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { completedBunTests, runIsolatedCheck } from '../taskValidation'
const roots: string[] = []
afterEach(() => {
  for (const path of roots.splice(0))
    rmSync(path, { recursive: true, force: true })
})
test('generated code cannot read outside, write protected tests, use credentials, or dial network', async () => {
  const root = mkdtempSync(join(tmpdir(), 'qm-validation-'))
  roots.push(root)
  const workspace = join(root, 'repo')
  mkdirSync(workspace)
  const secret = join(root, 'outside-secret')
  writeFileSync(secret, 'must-not-be-readable')
  const server = Bun.spawn(
    [
      process.execPath,
      '-e',
      "const s=Bun.serve({hostname:'127.0.0.1',port:0,fetch(){return new Response('reachable')}}); console.log(s.port)",
    ],
    { stdout: 'pipe', stderr: 'pipe', env: { PATH: process.env.PATH } },
  )
  const reader = server.stdout.getReader()
  const first = await reader.read()
  const port = Number(new TextDecoder().decode(first.value).trim())
  expect(port).toBeGreaterThan(0)
  const url = `http://127.0.0.1:${port}`
  expect(await (await fetch(url)).text()).toBe('reachable')
  const file = join(workspace, 'probe.test.ts')
  const source = `import { expect, test } from 'bun:test'; import { readFileSync, writeFileSync } from 'node:fs';
  test('real OS boundaries', async () => {
    expect(() => readFileSync(${JSON.stringify(secret)})).toThrow();
    expect(() => writeFileSync(${JSON.stringify(file)}, 'tampered')).toThrow();
    expect(process.env.QM_INHERITED_SECRET).toBeUndefined();
    let blocked = false; try { await fetch(${JSON.stringify(url)}, { signal: AbortSignal.timeout(500) }) } catch { blocked = true } expect(blocked).toBe(true);
    writeFileSync(process.env.TMPDIR + '/allowed', 'yes'); expect(readFileSync(process.env.TMPDIR + '/allowed', 'utf8')).toBe('yes');
  })`
  writeFileSync(file, source)
  const old = process.env.QM_INHERITED_SECRET
  process.env.QM_INHERITED_SECRET = 'do-not-inherit'
  let result: ReturnType<typeof runIsolatedCheck>
  try {
    result = runIsolatedCheck(['bun', 'test', file], workspace)
  } finally {
    if (old === undefined) delete process.env.QM_INHERITED_SECRET
    else process.env.QM_INHERITED_SECRET = old
    server.kill()
    await server.exited
    reader.releaseLock()
  }
  expect({
    code: result.code,
    stderr: result.code ? result.stderr : '',
  }).toEqual({ code: 0, stderr: '' })
  expect(completedBunTests(result, 1)).toBe(true)
  expect(readFileSync(file, 'utf8')).toBe(source)
})
test('process.exit(0) from generated code is never counted as completed tests', () => {
  const root = mkdtempSync(join(tmpdir(), 'qm-exit-zero-'))
  roots.push(root)
  writeFileSync(join(root, 'exit.test.ts'), 'process.exit(0)\n')
  const result = runIsolatedCheck(['bun', 'test', 'exit.test.ts'], root)
  expect(result.code).toBe(0)
  expect(completedBunTests(result, 1)).toBe(false)
})
