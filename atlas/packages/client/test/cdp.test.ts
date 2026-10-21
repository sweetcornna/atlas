// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { launchOnPipe, makeFifos, type PipeWindow } from '../src/cdp.ts'

/**
 * The DevTools pipe without a browser: a Bun script stands in for one,
 * answering each NUL-terminated command on fd 3 with its method on fd 4.
 * Needs `/bin/sh` and `mkfifo`, so not on Windows (which never uses the pipe).
 */
const posix = process.platform !== 'win32'

const FAKE_BROWSER = `
const fs = require('node:fs')
const chunk = Buffer.alloc(65536)
let pending = ''
for (;;) {
  const read = fs.readSync(3, chunk, 0, chunk.length, null)
  if (read === 0) break
  pending += chunk.toString('utf8', 0, read)
  for (let end = pending.indexOf('\\0'); end >= 0; end = pending.indexOf('\\0')) {
    const message = JSON.parse(pending.slice(0, end))
    pending = pending.slice(end + 1)
    fs.writeSync(4, JSON.stringify({ id: message.id, result: { method: message.method } }) + '\\0')
  }
}
`

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qmo-cdp-'))
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

test.skipIf(!posix)('the FIFOs are 0600 in a 0700 directory', () => {
  const dir = path.join(tempDir(), 'pipe')
  const fifos = makeFifos(dir)
  expect(fs.statSync(dir).mode & 0o777).toBe(0o700)
  for (const file of [fifos.input, fifos.output]) {
    expect(fs.lstatSync(file).isFIFO()).toBe(true)
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
  }
})

test.skipIf(!posix)('a pipe directory that is a link is refused', () => {
  const root = tempDir()
  const real = path.join(root, 'real')
  fs.mkdirSync(real, { mode: 0o700 })
  fs.symlinkSync(real, path.join(root, 'pipe'))
  expect(() => makeFifos(path.join(root, 'pipe'))).toThrow(/不是目录/)
  expect(fs.readdirSync(real)).toEqual([])
})

test.skipIf(!posix)(
  'the FIFO names go once the browser answers, and the pipe keeps working',
  async () => {
    const dir = path.join(tempDir(), 'pipe')
    let window: PipeWindow | undefined
    cleanups.push(async () => {
      window?.close()
      if (window !== undefined)
        await Promise.race([window.exited, Bun.sleep(5000)])
    })
    window = launchOnPipe(dir, process.execPath, ['-e', FAKE_BROWSER])
    expect(await window.send('Browser.getVersion')).toEqual({
      method: 'Browser.getVersion',
    })
    expect(fs.readdirSync(dir)).toEqual([])
    expect(await window.send('Target.getTargets')).toEqual({
      method: 'Target.getTargets',
    })
    // Closing the pipe is the browser's end-of-input; it exits.
    window.close()
    expect(
      await Promise.race([window.exited, Bun.sleep(5000).then(() => -1)]),
    ).toBe(0)
  },
  20_000,
)
