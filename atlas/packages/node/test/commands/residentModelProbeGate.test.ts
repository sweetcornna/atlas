// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  createResidentModelProbeGate,
  residentModelProbeFingerprint,
  residentModelProbeInputs,
  probeResidentModel,
  type ResidentModelProbeVerdict,
} from '../../src/commands/residentModelProbe.js'
import { ProbeExitUnconfirmedError } from '../../src/commands/providerCall.js'
import { fakeOpenAI, isolatedRoot } from '../providers/fake.js'
import { providerPaths } from '../../src/providers/store.js'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(r => {
    resolve = r
  })
  return { promise, resolve }
}
const ok = { status: 'reachable', httpStatus: 200 } as const

test('concurrent generations share validation; only same live configuration success is reused', async () => {
  let version = 'A',
    calls = 0
  const first = deferred<ResidentModelProbeVerdict>()
  const gate = createResidentModelProbeGate({
    fingerprint: () => version,
    probe: async () => {
      calls++
      return calls === 1 ? first.promise : ok
    },
  })
  const signal = new AbortController().signal
  const one = gate(signal),
    two = gate(signal)
  expect(calls).toBe(1)
  first.resolve(ok)
  await Promise.all([one, two])
  await gate(signal)
  expect(calls).toBe(1)
  version = 'B'
  await gate(signal)
  expect(calls).toBe(2)
  const restarted = createResidentModelProbeGate({
    fingerprint: () => version,
    probe: async () => {
      calls++
      return ok
    },
  })
  await restarted(signal)
  expect(calls).toBe(3)
})

test('old configuration completion cannot release a newer generation or publish stale health', async () => {
  let version = 'A',
    calls = 0,
    reports = 0
  const first = deferred<ResidentModelProbeVerdict>()
  const gate = createResidentModelProbeGate({
    fingerprint: () => version,
    probe: async () => {
      calls++
      return calls === 1 ? first.promise : ok
    },
    onVerdict: () => {
      reports++
    },
  })
  const signal = new AbortController().signal
  const old = gate(signal)
  version = 'B'
  first.resolve(ok)
  await expect(old).rejects.toThrow('configuration changed')
  expect(reports).toBe(0)
  await gate(signal)
  expect(calls).toBe(2)
  expect(reports).toBe(1)
})

test('unconfirmed exit poisons this process even after a config change', async () => {
  let version = 'A',
    calls = 0
  const gate = createResidentModelProbeGate({
    fingerprint: () => version,
    probe: async () => {
      calls++
      throw new ProbeExitUnconfirmedError()
    },
  })
  const signal = new AbortController().signal
  await expect(gate(signal)).rejects.toBeInstanceOf(ProbeExitUnconfirmedError)
  version = 'B'
  await expect(gate(signal)).rejects.toBeInstanceOf(ProbeExitUnconfirmedError)
  expect(calls).toBe(1)
})

test('known-terminated provider refusal keeps its diagnostic and is not cached as success', async () => {
  let calls = 0
  const observed: string[] = []
  const gate = createResidentModelProbeGate({
    fingerprint: () => 'A',
    probe: async () => {
      calls++
      return {
        status: 'refused',
        httpStatus: 401,
        endpoint: 'http://localhost',
        detail: 'rejected',
      }
    },
    onVerdict: v => observed.push(v.status),
  })
  const signal = new AbortController().signal
  await gate(signal)
  await gate(signal)
  expect(calls).toBe(2)
  expect(observed).toEqual(['refused', 'refused'])
})

test('shutdown during a probe cannot release a generation after late success', async () => {
  const d = deferred<ResidentModelProbeVerdict>(),
    controller = new AbortController()
  const gate = createResidentModelProbeGate({
    fingerprint: () => 'A',
    probe: () => d.promise,
  })
  const pending = gate(controller.signal)
  controller.abort()
  d.resolve(ok)
  await expect(pending).rejects.toThrow()
})

test('native unmanaged config and inline credential changes invalidate the fingerprint', () => {
  const root = isolatedRoot()
  try {
    const models = (key: string) =>
      JSON.stringify({
        providers: {
          fake: {
            baseUrl: 'http://localhost',
            api: 'openai-completions',
            apiKey: key,
          },
        },
      })
    mkdirSync(dirname(providerPaths.models()), { recursive: true })
    writeFileSync(providerPaths.models(), models('first'))
    writeFileSync(
      providerPaths.config(),
      JSON.stringify({ modelRoles: { default: 'fake/one' } }),
    )
    const first = residentModelProbeFingerprint()
    expect(residentModelProbeFingerprint()).toBe(first)
    writeFileSync(providerPaths.models(), models('second'))
    expect(residentModelProbeFingerprint()).not.toBe(first)
    const second = residentModelProbeFingerprint()
    writeFileSync(
      providerPaths.config(),
      JSON.stringify({ modelRoles: { default: 'fake/two' } }),
    )
    expect(residentModelProbeFingerprint()).not.toBe(second)
    expect(first).not.toContain('first')
  } finally {
    root.dispose()
  }
})

test('a real delayed native request for credential A cannot validate replacement B', async () => {
  const root = isolatedRoot(),
    backend = fakeOpenAI(),
    waiting = deferred<void>(),
    received = deferred<void>()
  let requests = 0
  const proxy = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      if (request.method !== 'POST') return Response.json({ data: [] })
      const body = await request.text()
      if (++requests === 1) {
        received.resolve()
        await waiting.promise
      }
      return fetch(`${backend.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: request.headers,
        body,
      })
    },
  })
  const write = (key: string) =>
    writeFileSync(
      providerPaths.models(),
      JSON.stringify({
        providers: {
          fake: {
            baseUrl: `http://127.0.0.1:${proxy.port}/v1`,
            api: 'openai-completions',
            apiKey: key,
            models: [
              { id: 'one', name: 'one', contextWindow: 65536, maxTokens: 100 },
            ],
          },
        },
      }),
    )
  try {
    mkdirSync(dirname(providerPaths.models()), { recursive: true })
    write('credential-A')
    writeFileSync(
      providerPaths.config(),
      JSON.stringify({
        modelRoles: { default: 'fake/one' },
        retry: { enabled: false },
      }),
    )
    const gate = createResidentModelProbeGate({
      fingerprint: residentModelProbeFingerprint,
      probe: signal =>
        probeResidentModel(residentModelProbeInputs()!, { signal }),
    })
    const signal = new AbortController().signal
    const first = gate(signal)
    await received.promise
    write('credential-B')
    waiting.resolve()
    await expect(first).rejects.toThrow('configuration changed')
    await gate(signal)
    expect(backend.requests.map(r => r.headers.get('authorization'))).toEqual([
      'Bearer credential-A',
      'Bearer credential-B',
    ])
    await gate(signal)
    expect(requests).toBe(2)
  } finally {
    waiting.resolve()
    proxy.stop(true)
    backend.stop()
    root.dispose()
  }
}, 20000)
