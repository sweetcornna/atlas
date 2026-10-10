// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { AutoCompactReport } from '@qianmo/providers'
import { AUTO_COMPACT_LIMITS } from '@qianmo/providers'
import { readYaml } from '../providers/node.js'
import { computeEffectiveProviderState } from '../providers/effective.js'
import {
  acquireApplyLock,
  providerPaths,
  writePrivateJson,
} from '../providers/store.js'
import { isRecord } from '../providers/managedView.js'
export function parseAutocompactArgs(args: readonly string[]): {
  value: string | undefined
  json: boolean
} {
  let value: string | undefined
  let json = false
  for (const arg of args) {
    if (arg === '--json') json = true
    else if (arg.startsWith('-') || value !== undefined)
      throw new Error('autocompact takes auto or one token count')
    else value = arg
  }
  return { value, json }
}
export type AutocompactResult =
  | ({ ok: true } & AutoCompactReport)
  | ({
      ok: false
      code: 'bad-value' | 'env-override' | 'write-failed'
      message: string
    } & AutoCompactReport)
export async function runAutocompact(input: {
  value: string | undefined
  json: boolean
}) {
  const before = await computeEffectiveProviderState()
  const existing = readYaml(providerPaths.config()).compaction
  const configured =
    isRecord(existing) &&
    typeof existing.thresholdTokens === 'number' &&
    existing.thresholdTokens > 0
      ? existing.thresholdTokens
      : before.autoCompactWindow
  let result: AutocompactResult = {
    ok: true,
    autoCompactWindow: before.autoCompactWindow,
    configured,
    source: before.autoCompactSource,
  }
  if (input.value !== undefined) {
    const value =
      input.value === 'auto'
        ? -1
        : /^\d+$/.test(input.value)
          ? Number(input.value)
          : NaN
    const lock = acquireApplyLock()
    try {
      if (!lock) throw new Error('another configuration write is in progress')
      if (
        value !== -1 &&
        (!Number.isSafeInteger(value) ||
          value < AUTO_COMPACT_LIMITS.minTokens ||
          value > AUTO_COMPACT_LIMITS.maxTokens)
      )
        result = {
          ...result,
          ok: false,
          code: 'bad-value',
          message: `tokens must be ${AUTO_COMPACT_LIMITS.minTokens}-${AUTO_COMPACT_LIMITS.maxTokens}, or auto`,
        }
      else {
        const config = readYaml(providerPaths.config())
        config.compaction = {
          ...(isRecord(config.compaction) ? config.compaction : {}),
          thresholdTokens: value,
          thresholdPercent: -1,
        }
        writePrivateJson(providerPaths.config(), config)
        const after = await computeEffectiveProviderState()
        result = {
          ok: true,
          autoCompactWindow: after.autoCompactWindow,
          configured: value > 0 ? value : after.autoCompactWindow,
          source: after.autoCompactSource,
          message:
            'omp compaction token trigger updated; auto uses omp reserve-based threshold',
        }
      }
    } catch {
      result = {
        ...result,
        ok: false,
        code: 'write-failed',
        message: 'Could not save omp compaction threshold',
      }
    } finally {
      lock?.release()
    }
  }
  return {
    exitCode: result.ok ? 0 : 1,
    stdout: input.json
      ? `${JSON.stringify(result)}\n`
      : result.ok
        ? `${result.message ?? `Auto compaction: ${result.autoCompactWindow} tokens (${result.source})`}\n`
        : '',
    stderr: !input.json && !result.ok ? `${result.message}\n` : '',
  }
}
