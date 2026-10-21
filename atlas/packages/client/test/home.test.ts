// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { ClientHome } from '../src/home.ts'
import { ClientError } from '../src/hub.ts'

const TOKEN = `qmd_${'h'.repeat(43)}`
const STATE = {
  version: 1,
  hub: 'https://hub.example',
  deviceId: 'd-abcdefghijkl',
  name: 'pc',
  pairedAt: '2026-10-21T00:00:00.000Z',
} as const
const posix = process.platform !== 'win32'

const savedDir = process.env.QMO_CLIENT_DIR
const dirs: string[] = []
afterEach(() => {
  if (savedDir === undefined) delete process.env.QMO_CLIENT_DIR
  else process.env.QMO_CLIENT_DIR = savedDir
  for (const dir of dirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true })
})
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qmo-home-'))
  dirs.push(dir)
  return dir
}

test('a pairing round-trips through client.json and the token file', async () => {
  const home = new ClientHome(path.join(tempDir(), 'client'), 'linux')
  expect(home.load()).toBeUndefined()
  await home.save(STATE, TOKEN)
  expect(home.load()).toEqual(STATE)
  expect(await home.token()).toBe(TOKEN)
  if (posix) expect(fs.statSync(home.statePath).mode & 0o777).toBe(0o600)
})

test.skipIf(!posix)(
  'client.json that is a link, or that others can read, is refused',
  async () => {
    const root = tempDir()
    const home = new ClientHome(path.join(root, 'client'), 'linux')
    await home.save(STATE, TOKEN)
    fs.chmodSync(home.statePath, 0o644)
    expect(() => home.load()).toThrow(/client\.json 的权限过宽/)
    // A planted pairing elsewhere is not taken for this computer's.
    const planted = path.join(root, 'planted.json')
    fs.writeFileSync(
      planted,
      JSON.stringify({ ...STATE, hub: 'https://evil.example' }),
      { mode: 0o600 },
    )
    fs.rmSync(home.statePath)
    fs.symlinkSync(planted, home.statePath)
    expect(() => home.load()).toThrow(/client\.json 不是普通文件/)
  },
)

test('a relative QMO_CLIENT_DIR is a message for the user, not a crash', () => {
  process.env.QMO_CLIENT_DIR = 'relative/qmo'
  let thrown: unknown
  try {
    new ClientHome()
  } catch (error) {
    thrown = error
  }
  expect(thrown).toBeInstanceOf(ClientError)
  expect((thrown as ClientError).message).toBe(
    'QMO_CLIENT_DIR 要写绝对路径（现在是 relative/qmo）',
  )
  expect((thrown as ClientError).exitCode).toBe(2)
})
