// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { firstLine, JSON_EXIT_CODES, main, USAGE } from '../src/cli.ts'
import type { ClientIO } from '../src/commands.ts'
import { fakeHub, PAIRING_CODE } from './fakeHub.ts'

const CLI = path.join(import.meta.dir, '..', 'src', 'cli.ts')

const savedDir = process.env.QMO_CLIENT_DIR
const cleanups: (() => void)[] = []
afterEach(() => {
  if (savedDir === undefined) delete process.env.QMO_CLIENT_DIR
  else process.env.QMO_CLIENT_DIR = savedDir
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

function lines(...chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks)
        controller.enqueue(new TextEncoder().encode(chunk))
      controller.close()
    },
  })
}

/** `qmo` as a user runs it, with `stdin` piped in. */
async function run(
  args: readonly string[],
  env: Record<string, string>,
  stdin: string,
) {
  const proc = Bun.spawn([process.execPath, CLI, ...args], {
    env: { ...process.env, ...env },
    stdin: new Blob([stdin]),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, exit] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { stdout, stderr, exit }
}

describe('the pairing code from standard input', () => {
  test('the first line, without its line ending', async () => {
    expect(await firstLine(lines('ABCD-EFGH-IJKL\nmore\n'))).toBe(
      'ABCD-EFGH-IJKL',
    )
    expect(await firstLine(lines('ABCD-', 'EFGH-IJKL\r\n'))).toBe(
      'ABCD-EFGH-IJKL',
    )
    expect(await firstLine(lines('ABCD-EFGH-IJKL'))).toBe('ABCD-EFGH-IJKL')
    expect(await firstLine(lines())).toBeNull()
  })

  test('qmo sign-in <hub> reads it from a pipe', async () => {
    const hub = fakeHub()
    cleanups.push(() => hub.stop())
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qmo-cli-'))
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }))
    const signedIn = await run(
      ['sign-in', hub.url, '--name', 'pc'],
      { QMO_CLIENT_DIR: path.join(dir, 'client') },
      `${PAIRING_CODE}\n`,
    )
    expect(signedIn.stderr).toBe('')
    expect(signedIn.exit).toBe(0)
    expect(signedIn.stdout).toContain(`已登录 ${hub.url} · 设备 pc`)
    expect(hub.paired).toEqual(['client'])
  }, 30_000)

  test('the usage says --code is visible to others', () => {
    expect(USAGE).toContain(
      'qmo sign-in <中枢地址> [--name <设备名>] [--force] [--json]',
    )
    expect(USAGE).toContain('qmo session --json')
    expect(USAGE).toContain(
      '--code <配对码>，但命令行对这台电脑上的其他用户可见',
    )
  })
})

describe('a relative QMO_CLIENT_DIR', () => {
  test('is a usage error with a message, in process', async () => {
    process.env.QMO_CLIENT_DIR = 'qmo-here'
    const out: string[] = []
    const err: string[] = []
    const io: ClientIO = {
      out: line => out.push(line),
      err: line => err.push(line),
      ask: async () => null,
    }
    expect(await main(['status'], io)).toBe(2)
    expect(err).toEqual(['QMO_CLIENT_DIR 要写绝对路径（现在是 qmo-here）'])
    expect(out).toEqual([])
  })

  test('and from the command line, without a stack trace', async () => {
    const result = await run(['status'], { QMO_CLIENT_DIR: 'qmo-here' }, '')
    expect(result.exit).toBe(2)
    expect(result.stderr.trim()).toBe(
      'QMO_CLIENT_DIR 要写绝对路径（现在是 qmo-here）',
    )
  }, 30_000)
})

/** One line of JSON on standard output, and nothing else. */
function onlyJson(stdout: string): Record<string, unknown> {
  const lines = stdout.trim().split('\n')
  expect(lines).toHaveLength(1)
  return JSON.parse(lines[0]!) as Record<string, unknown>
}

describe('--json, for the desktop shell (qmo-app.md §3)', () => {
  function signedInDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qmo-json-'))
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }))
    return { QMO_CLIENT_DIR: path.join(dir, 'client') }
  }

  test('sign-in, status, session and sign-out each print one line of JSON', async () => {
    const hub = fakeHub()
    cleanups.push(() => hub.stop())
    const env = signedInDir()

    const before = await run(['status', '--json'], env, '')
    expect(before.exit).toBe(0)
    expect(onlyJson(before.stdout)).toEqual({
      dir: env.QMO_CLIENT_DIR,
      signedIn: false,
    })

    // The code comes on standard input, with no prompt on standard output.
    const signedIn = await run(
      ['sign-in', hub.url, '--name', 'mac', '--json'],
      env,
      `${PAIRING_CODE}\n`,
    )
    expect(signedIn.exit).toBe(0)
    const paired = onlyJson(signedIn.stdout)
    expect(paired).toEqual({
      hub: hub.url,
      deviceId: expect.stringMatching(/^d-[a-z2-7]{12}$/),
      name: 'mac',
    })

    const status = await run(['status', '--json'], env, '')
    expect(onlyJson(status.stdout)).toMatchObject({
      signedIn: true,
      hub: hub.url,
      deviceId: paired.deviceId,
      name: 'mac',
      token: 'file',
      device: 'active',
    })

    const session = await run(['session', '--json'], env, '')
    expect(session.stderr).toBe('')
    expect(session.exit).toBe(0)
    const entered = onlyJson(session.stdout)
    expect(entered).toMatchObject({
      hub: hub.url,
      deviceId: paired.deviceId,
      name: 'mac',
    })
    expect(entered.cookies).toEqual([
      {
        name: 'qianmo_session',
        value: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
        domain: null,
        path: '/',
        secure: false,
        httpOnly: true,
        sameSite: 'Strict',
        maxAge: null,
        expires: null,
      },
    ])
    expect(hub.entered).toEqual([
      { site: 'none', device: String(paired.deviceId) },
    ])

    const out = await run(['sign-out', '--json'], env, '')
    expect(out.exit).toBe(0)
    expect(onlyJson(out.stdout)).toEqual({ result: 'revoked' })
    const again = await run(['sign-out', '--json'], env, '')
    expect(onlyJson(again.stdout)).toEqual({ result: 'signed_out' })
  }, 60_000)

  test('each failure is a kind and its own exit code', async () => {
    const hub = fakeHub()
    cleanups.push(() => hub.stop())
    const env = signedInDir()

    const signedOut = await run(['session', '--json'], env, '')
    expect(signedOut.exit).toBe(3)
    expect(onlyJson(signedOut.stdout)).toEqual({
      error: { kind: 'signed_out', message: expect.any(String) },
    })

    const badCode = await run(['sign-in', hub.url, '--json'], env, 'WRONG\n')
    expect(badCode.exit).toBe(8)
    expect(onlyJson(badCode.stdout)).toMatchObject({
      error: { kind: 'bad_code' },
    })

    await run(['sign-in', hub.url, '--json'], env, `${PAIRING_CODE}\n`)
    const again = await run(
      ['sign-in', hub.url, '--json'],
      env,
      `${PAIRING_CODE}\n`,
    )
    expect(again.exit).toBe(2)
    expect(onlyJson(again.stdout)).toMatchObject({
      error: { kind: 'signed_in' },
    })

    const status = onlyJson((await run(['status', '--json'], env, '')).stdout)
    hub.revoked.add(String(status.deviceId))
    const revoked = await run(['session', '--json'], env, '')
    expect(revoked.exit).toBe(4)
    // The device it was about rides along, so the shell can name the hub.
    expect(onlyJson(revoked.stdout)).toEqual({
      error: { kind: 'revoked', message: expect.any(String) },
      hub: hub.url,
      deviceId: status.deviceId,
      name: expect.any(String),
    })

    hub.stop()
    const gone = await run(['session', '--json'], env, '')
    expect(gone.exit).toBe(7)
    expect(onlyJson(gone.stdout)).toMatchObject({ error: { kind: 'network' } })
  }, 60_000)

  test('a hub without personal accounts is unsupported, exit 6', async () => {
    const hub = fakeHub({ accounts: false })
    cleanups.push(() => hub.stop())
    const env = signedInDir()
    await run(['sign-in', hub.url, '--json'], env, `${PAIRING_CODE}\n`)
    const session = await run(['session', '--json'], env, '')
    expect(session.exit).toBe(6)
    expect(onlyJson(session.stdout)).toMatchObject({
      error: { kind: 'unsupported' },
      hub: hub.url,
    })
  }, 60_000)

  test('session is for --json only, and the others take nothing else', async () => {
    const io: ClientIO = { out: () => {}, err: () => {}, ask: async () => null }
    process.env.QMO_CLIENT_DIR = signedInDir().QMO_CLIENT_DIR
    expect(await main(['session'], io)).toBe(2)
    expect(await main(['session', '--json', '--force'], io)).toBe(
      JSON_EXIT_CODES.usage,
    )
    expect(await main(['open', '--json'], io)).toBe(2)
    expect(await main(['status', '--force'], io)).toBe(2)
  })

  test('every kind has its own code, apart from those that mean the same', () => {
    expect(JSON_EXIT_CODES).toEqual({
      refused: 1,
      usage: 2,
      signed_in: 2,
      signed_out: 3,
      revoked: 4,
      invalid: 4,
      device_kind: 4,
      owner_inactive: 5,
      unsupported: 6,
      network: 7,
      bad_code: 8,
      throttled: 9,
    })
  })
})
