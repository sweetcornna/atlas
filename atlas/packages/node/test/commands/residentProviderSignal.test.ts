// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The resident's pid file and the SIGHUP that `qm provider apply` (P18.7)
 * sends through it (design `providers-console-m1.md` §2.7, §11 item 8).
 *
 * The rule under test: a signal goes only to a process that provably is the
 * resident that wrote the file — same pid and the same kernel start time —
 * because SIGHUP's default action ends whatever receives it, and the
 * resident's own 5 s poll finds the intent anyway. The `/proc` reads are
 * injected so the Linux rule is exercised on every platform; the last case
 * runs it against the real `/proc` and only runs on Linux.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  linuxProcessStartedAt,
  removeResidentPidFile,
  residentPidPath,
  signalResidentProviderCheck,
  writeResidentPidFile,
} from '../resident.js'

const BTIME = 1_790_000_000

/** A `/proc` with one process in it, started `ticks` after boot. */
function fakeProc(
  pid: number,
  ticks: number,
  comm = 'bun',
): (path: string) => string {
  return path => {
    if (path === '/proc/stat') {
      return `cpu  1 2 3 4\nbtime ${BTIME}\nprocesses 99\n`
    }
    if (path === `/proc/${pid}/stat`) {
      // Fields 3..22 after the comm; starttime is the 22nd field overall.
      const after = ['S', '1', '1', '1', '0', '-1', '4194304']
      while (after.length < 19) after.push('0')
      after.push(String(ticks), '1000', '200')
      return `${pid} (${comm}) ${after.join(' ')}\n`
    }
    throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' })
  }
}

function pidFile(pid: number, startedAtMs: number): string {
  return JSON.stringify({
    pid,
    startedAt: new Date(startedAtMs).toISOString(),
    nonce: 'abc',
  })
}

describe('process start time from /proc', () => {
  test('boot time plus starttime ticks, with a comm that has spaces and parens', () => {
    const at = linuxProcessStartedAt(4242, {
      platform: 'linux',
      readProc: fakeProc(4242, 12_345, 'qm (resident) x'),
    })
    expect(at).toBe(BTIME * 1_000 + 123_450)
  })

  test('no such process is null; not Linux is undefined', () => {
    expect(
      linuxProcessStartedAt(7, { platform: 'linux', readProc: fakeProc(8, 1) }),
    ).toBeNull()
    expect(
      linuxProcessStartedAt(8, {
        platform: 'darwin',
        readProc: fakeProc(8, 1),
      }),
    ).toBeUndefined()
  })
})

describe('signalResidentProviderCheck', () => {
  const started = BTIME * 1_000 + 500_000

  test('signals the resident whose start time matches', () => {
    const kills: [number, string][] = []
    const outcome = signalResidentProviderCheck({
      platform: 'linux',
      readProc: fakeProc(4242, 50_000),
      readPidFile: () => pidFile(4242, started),
      kill: (pid, signal) => kills.push([pid, signal]),
    })
    expect(outcome).toEqual({ signalled: true, pid: 4242 })
    expect(kills).toEqual([[4242, 'SIGHUP']])
  })

  test('a reused pid — same number, another start time — is not signalled', () => {
    const kills: [number, string][] = []
    // The process holding 4242 now started an hour after the resident did.
    const outcome = signalResidentProviderCheck({
      platform: 'linux',
      readProc: fakeProc(4242, 50_000 + 360_000),
      readPidFile: () => pidFile(4242, started),
      kill: (pid, signal) => kills.push([pid, signal]),
    })
    expect(outcome).toEqual({ signalled: false, reason: 'start-mismatch' })
    expect(kills).toEqual([])
  })

  test('within the btime jitter it still matches; past it, it does not', () => {
    const kills: number[] = []
    const kill = (pid: number) => kills.push(pid)
    const readProc = fakeProc(4242, 50_000)
    expect(
      signalResidentProviderCheck({
        platform: 'linux',
        readProc,
        readPidFile: () => pidFile(4242, started + 1_999),
        kill,
      }).signalled,
    ).toBe(true)
    expect(
      signalResidentProviderCheck({
        platform: 'linux',
        readProc,
        readPidFile: () => pidFile(4242, started + 2_001),
        kill,
      }),
    ).toEqual({ signalled: false, reason: 'start-mismatch' })
    expect(kills).toEqual([4242])
  })

  test('off Linux nothing is signalled: the poll is the only path (§11 item 8)', () => {
    const kills: number[] = []
    expect(
      signalResidentProviderCheck({
        platform: 'darwin',
        readProc: fakeProc(4242, 50_000),
        readPidFile: () => pidFile(4242, started),
        kill: pid => kills.push(pid),
      }),
    ).toEqual({ signalled: false, reason: 'unverifiable' })
    expect(kills).toEqual([])
  })

  test('no pid file, a broken one, or a dead pid: nothing is signalled', () => {
    const kills: number[] = []
    const kill = (pid: number) => kills.push(pid)
    const linux = { platform: 'linux' as const, kill }
    expect(
      signalResidentProviderCheck({
        ...linux,
        readPidFile: () => {
          throw new Error('ENOENT')
        },
      }),
    ).toEqual({ signalled: false, reason: 'no-resident' })
    for (const text of ['{', '{"pid":"4242","startedAt":"x"}', '{"pid":0}']) {
      expect(
        signalResidentProviderCheck({ ...linux, readPidFile: () => text }),
      ).toEqual({ signalled: false, reason: 'unreadable' })
    }
    expect(
      signalResidentProviderCheck({
        ...linux,
        readProc: fakeProc(1, 1),
        readPidFile: () => pidFile(4242, started),
      }),
    ).toEqual({ signalled: false, reason: 'not-running' })
    expect(kills).toEqual([])
  })

  test('a kill that throws is reported, not raised', () => {
    expect(
      signalResidentProviderCheck({
        platform: 'linux',
        readProc: fakeProc(4242, 50_000),
        readPidFile: () => pidFile(4242, started),
        kill: () => {
          throw new Error('EPERM')
        },
      }),
    ).toEqual({ signalled: false, reason: 'signal-failed' })
  })
})

describe('the pid file', () => {
  let root: string
  let previousConfigDir: string | undefined

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'qianmo-resident-pid-'))
    previousConfigDir = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = join(root, 'config')
  })

  afterEach(() => {
    if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previousConfigDir
    rmSync(root, { recursive: true, force: true })
  })

  test('is {pid, startedAt, nonce}, 0600, under resident/', () => {
    const record = writeResidentPidFile()
    expect(residentPidPath()).toBe(
      join(root, 'config', 'resident', 'resident.pid'),
    )
    expect(JSON.parse(readFileSync(residentPidPath(), 'utf8'))).toEqual(record)
    expect(record.pid).toBe(process.pid)
    expect(Number.isFinite(Date.parse(record.startedAt))).toBe(true)
    expect(Date.parse(record.startedAt)).toBeLessThanOrEqual(Date.now())
    expect(record.nonce).toMatch(/^[0-9a-f]{16}$/)
    expect(statSync(residentPidPath()).mode & 0o777).toBe(0o600)
    expect(statSync(join(root, 'config', 'resident')).mode & 0o777).toBe(0o700)
  })

  test('is removed on the way out only while it is still this process’s', () => {
    const mine = writeResidentPidFile()
    removeResidentPidFile(mine)
    expect(existsSync(residentPidPath())).toBe(false)

    const stale = writeResidentPidFile()
    // A later resident on the same config root took the file over.
    writeFileSync(residentPidPath(), pidFile(99_999, Date.now()))
    removeResidentPidFile(stale)
    expect(existsSync(residentPidPath())).toBe(true)
  })

  test.skipIf(process.platform !== 'linux')(
    'on Linux: the real /proc decides, and only the real resident is signalled',
    async () => {
      const child = spawn(
        process.execPath,
        [
          '-e',
          "process.on('SIGHUP', () => console.log('hup')); setInterval(() => {}, 1000)",
        ],
        { stdio: ['ignore', 'pipe', 'inherit'] },
      )
      try {
        let output = ''
        child.stdout?.on('data', chunk => {
          output += String(chunk)
        })
        await new Promise(resolve => setTimeout(resolve, 500))
        const pid = child.pid as number
        writeResidentPidFile({ pid })
        expect(signalResidentProviderCheck()).toEqual({
          signalled: true,
          pid,
        })
        const deadline = Date.now() + 5_000
        while (!output.includes('hup') && Date.now() < deadline) {
          await new Promise(resolve => setTimeout(resolve, 20))
        }
        expect(output).toContain('hup')

        // Same pid, a start time an hour off: treated as a reused pid.
        const record = JSON.parse(readFileSync(residentPidPath(), 'utf8')) as {
          startedAt: string
        }
        writeFileSync(
          residentPidPath(),
          pidFile(pid, Date.parse(record.startedAt) - 3_600_000),
        )
        expect(signalResidentProviderCheck()).toEqual({
          signalled: false,
          reason: 'start-mismatch',
        })
      } finally {
        child.kill('SIGKILL')
      }
    },
    20_000,
  )
})
