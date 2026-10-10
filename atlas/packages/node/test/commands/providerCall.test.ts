// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { compileProfile } from '../../src/providers/compile.js'
import {
  probeCall,
  ProbeExitUnconfirmedError,
} from '../../src/commands/providerCall.js'
import { spawn, type ChildProcess } from 'node:child_process'
import { providerDir } from '../../src/providers/store.js'
import { isolatedRoot, fakeOpenAI } from '../providers/fake.js'
import { CANARY_KEY, wireProfile } from '../providers/helpers.js'
const caps = {
  protocol: 1 as const,
  multiKey: true,
  chatEffortHonorsOverride: true,
  replayFilter: true,
}
function compile(baseUrl: string) {
  const result = compileProfile(
    wireProfile({ lane: 'openai-chat', baseUrl, compat: {} }, caps),
    { secret: CANARY_KEY, capabilities: caps },
  )
  if (!result.ok) throw new Error(result.error.message)
  return result.compiled
}
for (const status of [200, 401, 403, 402, 429, 400])
  test(`real omp call ${status}: outcome redacts vendor body and removes private temporary root`, async () => {
    const root = isolatedRoot()
    const fake = fakeOpenAI(status)
    try {
      const outcome = await probeCall({
        requestId: `probe-${status}`,
        baseUrl: fake.baseUrl,
        compiled: compile(fake.baseUrl),
        timeoutMs: 10000,
      })
      expect(outcome.ok).toBe(status === 200)
      expect(outcome.reachable).toBe(true)
      if (status !== 200) expect(outcome.httpStatus).toBe(status)
      expect(fake.requests[0]?.headers.get('authorization')).toBe(
        `Bearer ${CANARY_KEY}`,
      )
      expect(JSON.stringify(outcome)).not.toContain('secret-do-not-echo')
      expect(JSON.stringify(outcome)).not.toContain(CANARY_KEY)
      expect(
        readdirSync(providerDir()).filter(n => n.startsWith('probe-')),
      ).toEqual([])
    } finally {
      fake.stop()
      root.dispose()
    }
  }, 20000)
test('call sandbox is 0700, native model key 0600, inherited secrets removed; launch failure cleaned', async () => {
  const root = isolatedRoot()
  const fake = fakeOpenAI()
  try {
    let inspected = false
    const outcome = await probeCall({
      requestId: 'private',
      baseUrl: fake.baseUrl,
      compiled: compile(fake.baseUrl),
      timeoutMs: 1000,
      env: { ...process.env, OPENAI_API_KEY: 'ambient-secret' },
      launch: (_args, env) => {
        inspected = true
        const temp = env.QIANMO_CONFIG_DIR!
        expect(statSync(temp).mode & 0o777).toBe(0o700)
        const models = join(temp, 'omp', 'agent', 'models.yml')
        expect(statSync(models).mode & 0o777).toBe(0o600)
        expect(readFileSync(models, 'utf8')).toContain(CANARY_KEY)
        expect(env.OPENAI_API_KEY).toBeUndefined()
        return { execPath: '/definitely-missing-omp', args: [], env }
      },
    })
    expect(inspected).toBe(true)
    expect(outcome.ok).toBe(false)
    expect(
      readdirSync(providerDir()).filter(n => n.startsWith('probe-')),
    ).toEqual([])
  } finally {
    fake.stop()
    root.dispose()
  }
})
test('unreachable origin spends nothing and never launches; timeout is bounded', async () => {
  const root = isolatedRoot()
  const fake = fakeOpenAI()
  const baseUrl = fake.baseUrl
  fake.stop()
  try {
    let launched = false
    const result = await probeCall({
      requestId: 'offline',
      baseUrl,
      compiled: compile(baseUrl),
      timeoutMs: 300,
      launch: () => {
        launched = true
        throw new Error('must not launch')
      },
    })
    expect(result.reachable).toBe(false)
    expect(launched).toBe(false)
    const online = fakeOpenAI()
    try {
      const start = Date.now()
      const timeout = await probeCall({
        requestId: 'timeout',
        baseUrl: online.baseUrl,
        compiled: compile(online.baseUrl),
        timeoutMs: 300,
        launch: (_args, env) => ({
          execPath: process.execPath,
          args: ['-e', 'setInterval(()=>{},1000)'],
          env,
        }),
      })
      expect(timeout.ok).toBe(false)
      expect(Date.now() - start).toBeLessThan(4000)
      expect(
        readdirSync(providerDir()).filter(n => n.startsWith('probe-')),
      ).toEqual([])
    } finally {
      online.stop()
    }
  } finally {
    root.dispose()
  }
}, 10000)

test('timeout returns only after the actual child close; cancellation also reaps', async () => {
  const root = isolatedRoot(),
    fake = fakeOpenAI()
  try {
    for (const abort of [false, true]) {
      const controller = new AbortController()
      let child: ChildProcess | undefined,
        closed = false
      const promise = probeCall({
        requestId: `reap-${abort}`,
        baseUrl: fake.baseUrl,
        compiled: compile(fake.baseUrl),
        timeoutMs: 50,
        signal: controller.signal,
        launch: (_args, env) => ({
          execPath: process.execPath,
          args: ['-e', 'setInterval(()=>{},1000)'],
          env,
        }),
        spawn: (spec, options) => {
          child = spawn(spec.execPath, spec.args, { ...options, env: spec.env })
          child.once('close', () => {
            closed = true
          })
          if (abort) setTimeout(() => controller.abort(), 30)
          return child
        },
      })
      if (abort) await expect(promise).rejects.toThrow()
      else expect((await promise).ok).toBe(false)
      expect(closed).toBe(true)
      expect(child?.pid).toBeDefined()
      expect(() => process.kill(child!.pid!, 0)).toThrow()
    }
  } finally {
    fake.stop()
    root.dispose()
  }
}, 10000)

test('unknown exit is an error and preserves the private probe root', async () => {
  const root = isolatedRoot(),
    fake = fakeOpenAI()
  let child: ChildProcess | undefined
  try {
    await expect(
      probeCall({
        requestId: 'unconfirmed',
        baseUrl: fake.baseUrl,
        compiled: compile(fake.baseUrl),
        timeoutMs: 1,
        exitConfirmationMs: 10,
        spawn: (spec, options) => {
          child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
            ...options,
            env: spec.env,
          })
          // A real live PID, with only signal delivery failure injected.
          child.kill = () => false
          return child
        },
      }),
    ).rejects.toBeInstanceOf(ProbeExitUnconfirmedError)
    expect(child?.pid).toBeDefined()
    expect(() => process.kill(child!.pid!, 0)).not.toThrow()
    expect(
      readdirSync(providerDir()).filter(n => n.startsWith('probe-unconfirmed-'))
        .length,
    ).toBe(1)
  } finally {
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      const closed = new Promise<void>(resolve =>
        child!.once('close', () => resolve()),
      )
      process.kill(child.pid, 'SIGKILL')
      await closed
    }
    fake.stop()
    root.dispose()
  }
}, 5000)
