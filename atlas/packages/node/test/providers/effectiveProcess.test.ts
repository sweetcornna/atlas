// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { expect, test } from 'bun:test'
import { computeEffectiveInChild } from '../../src/providers/effectiveProcess.js'
import { isolatedRoot } from './fake.js'
import { applyRequest } from './helpers.js'
import {
  stageProviderApply,
  commitPendingProviderConfig,
} from '../../src/providers/node.js'

test('effective child uses native config despite ambient key, validates output and bounds hung child', async () => {
  const f = isolatedRoot()
  try {
    stageProviderApply(applyRequest())
    await commitPendingProviderConfig()
    const real = await computeEffectiveInChild({
      timeoutMs: 5000,
      env: {
        ...process.env,
        OPENAI_API_KEY: 'ambient-private',
        OPENAI_MODEL: 'wrong-model',
      },
    })
    expect(real.ok).toBe(true)
    if (real.ok) expect(real.effective.model).toBe('vendor-model-pro')
    for (const text of [
      'private-noise',
      'QIANMO_EFFECTIVE {"model":"incomplete"}',
      'QIANMO_EFFECTIVE {not-json',
    ]) {
      const result = await computeEffectiveInChild({
        timeoutMs: 1000,
        launch: (_args, env) => ({
          execPath: process.execPath,
          args: ['-e', `console.log(${JSON.stringify(text)})`],
          env,
        }),
      })
      expect(result).toEqual({ ok: false, reason: 'no-result' })
    }
    expect(
      await computeEffectiveInChild({
        timeoutMs: 1000,
        launch: (_args, env) => ({
          execPath: '/missing-runtime',
          args: [],
          env,
        }),
      }),
    ).toEqual({ ok: false, reason: 'spawn-failed' })
    expect(
      await computeEffectiveInChild({
        timeoutMs: 30,
        launch: (_args, env) => ({
          execPath: process.execPath,
          args: ['-e', 'setInterval(()=>{},1000)'],
          env,
        }),
      }),
    ).toEqual({ ok: false, reason: 'timeout' })
  } finally {
    f.dispose()
  }
}, 10000)
