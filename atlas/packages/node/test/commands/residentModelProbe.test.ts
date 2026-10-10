// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { expect, test } from 'bun:test'
import {
  stageProviderApply,
  commitPendingProviderConfig,
} from '../../src/providers/node.js'
import {
  probeResidentModel,
  residentModelProbeInputs,
  warnRefusedModelCredentials,
  warnUnavailableModelCredentialProbe,
} from '../../src/commands/residentModelProbe.js'
import {
  nodeHasModelCredential,
  runResidentModelCredentialProbe,
} from '../../src/commands/resident.js'
import { isolatedRoot, fakeOpenAI } from '../providers/fake.js'
import { applyRequest, CANARY_KEY } from '../providers/helpers.js'
for (const status of [200, 401, 403, 407, 400, 404, 500])
  test(`startup diagnostic uses compiled omp request, HTTP ${status}`, async () => {
    const f = isolatedRoot()
    const server = fakeOpenAI(status)
    try {
      expect(
        stageProviderApply(
          applyRequest({
            profile: {
              lane: 'openai-chat',
              baseUrl: server.baseUrl,
              compat: {},
            },
          }),
        ).ok,
      ).toBe(true)
      expect((await commitPendingProviderConfig()).status).toBe('committed')
      expect(nodeHasModelCredential()).toBe(true)
      const target = residentModelProbeInputs()!
      const verdict = await probeResidentModel(target, { timeoutMs: 10000 })
      expect(verdict.status).toBe(
        [401, 403, 407].includes(status) ? 'refused' : 'reachable',
      )
      expect(server.requests[0]?.headers.get('authorization')).toBe(
        `Bearer ${CANARY_KEY}`,
      )
      const warnings: string[] = []
      warnRefusedModelCredentials(verdict, s => warnings.push(s))
      expect(warnings.length).toBe([401, 403, 407].includes(status) ? 1 : 0)
      expect(JSON.stringify([verdict, warnings])).not.toContain(CANARY_KEY)
      expect(JSON.stringify([verdict, warnings])).not.toContain(
        'secret-do-not-echo',
      )
    } finally {
      server.stop()
      f.dispose()
    }
  }, 20000)
test('no configured credential skips; ambient credentials cannot turn an unmanaged node into configured', async () => {
  const f = isolatedRoot()
  const old = process.env.ANTHROPIC_API_KEY
  process.env.ANTHROPIC_API_KEY = 'ambient-secret'
  try {
    expect(residentModelProbeInputs()).toBeUndefined()
    expect(nodeHasModelCredential()).toBe(false)
    expect((await runResidentModelCredentialProbe()).status).toBe('skipped')
    const warnings: string[] = []
    expect(
      warnUnavailableModelCredentialProbe(
        { status: 'unavailable', detail: 'private' },
        s => warnings.push(s),
      ),
    ).toBe(true)
    expect(warnings[0]).not.toContain('private')
  } finally {
    if (old === undefined) delete process.env.ANTHROPIC_API_KEY
    else process.env.ANTHROPIC_API_KEY = old
    f.dispose()
  }
})
test('unreachable startup endpoint is bounded and distinct from credential refusal', async () => {
  const f = isolatedRoot()
  const server = fakeOpenAI()
  const url = server.baseUrl
  server.stop()
  try {
    stageProviderApply(
      applyRequest({
        profile: { lane: 'openai-chat', baseUrl: url, compat: {} },
      }),
    )
    await commitPendingProviderConfig()
    expect(
      (
        await probeResidentModel(residentModelProbeInputs()!, {
          timeoutMs: 500,
        })
      ).status,
    ).toBe('unreachable')
  } finally {
    f.dispose()
  }
})
