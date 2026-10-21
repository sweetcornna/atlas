// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { firstLine, main, USAGE } from '../src/cli.ts'
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
      'qmo sign-in <中枢地址> [--name <设备名>] [--force]',
    )
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
