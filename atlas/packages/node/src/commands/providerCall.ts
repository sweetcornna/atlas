// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `qm provider probe` with `mode: call`: one real, minimal model call with a
 * candidate configuration (design `providers-console-m1.md` §5.5). It costs
 * one small call, which the console confirms before sending; the point is to
 * go through the runtime's own request path — the lane, the model mapping and
 * the effort gate — rather than a hand-made request.
 *
 * How:
 *
 *   1. Ask the base URL's origin for anything at all, without the key. No HTTP
 *      answer means `reachable: false`, and nothing is spent.
 *   2. Build a throwaway config root at
 *      `occConfigPath('qianmo','provider','probe-<requestId>')` (0700) whose
 *      `settings.json` (0600) is the node's own settings with the candidate's
 *      compiled patch laid over it, exactly as a commit would lay it — so the
 *      node's other settings (a proxy in its `env`, say) still apply.
 *   3. Run this CLI once in it: `-p`, one turn, no tools, no session kept,
 *      safe mode (as the resident's ACP child runs), user settings only, and
 *      the environment with every provider-shaped key removed (the ACP child's
 *      managed-node env, `withoutProviderKeys`). Its output is read for the
 *      result's `is_error` and the assistant message's error category; the
 *      text itself — which may quote a vendor's error, and with it part of the
 *      key — is never passed on.
 *   4. Remove the root, whatever happened, in `finally`.
 */

import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { occConfigPath } from '../../config/paths.js'
import type { CompiledProfile } from '../../services/qianmo/providers/compile.js'
import {
  ensurePrivateDir,
  providerDir,
  writePrivateJson,
} from '../../services/qianmo/providers/store.js'
import { withoutProviderKeys } from '../../services/qianmo/residentAcpEnv.js'
import { MODEL_SETTINGS_SLOTS } from '../../utils/model/modelTier.js'
import {
  buildCliLaunch,
  type CliLaunchSpec,
  spawnCli,
} from '../../utils/process/cliLaunch.js'
import {
  nodeSettings,
  originAnswers,
  type ProbeOutcome,
} from './providerProbe.js'

type Launch = (cliArgs: string[], env: NodeJS.ProcessEnv) => CliLaunchSpec

/** What the one turn is asked; one word back keeps the output minimal. */
const PROMPT = 'Reply with the single word OK.'

const CALL_ARGS = [
  '-p',
  PROMPT,
  '--output-format',
  'stream-json',
  '--verbose',
  '--max-turns',
  '1',
  '--tools',
  '',
  '--no-session-persistence',
  '--safe-mode',
  '--setting-sources',
  'user',
]

/** The no-key reachability check before anything is spent. */
const ORIGIN_CHECK_MS = 10_000

/** Output past this is not read; one stream-json turn is far smaller. */
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024

/** The temporary config root for one `call`. */
export function callProbeRoot(requestId: string): string {
  return occConfigPath('qianmo', 'provider', `probe-${requestId}`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** `settings` with `patch` laid over it the way a commit lays it. */
function withPatch(
  settings: Record<string, unknown>,
  patch: CompiledProfile['patch'],
): Record<string, unknown> {
  const env: Record<string, unknown> = isRecord(settings.env)
    ? { ...settings.env }
    : {}
  for (const [key, value] of Object.entries(patch.env)) {
    if (value === undefined) delete env[key]
    else env[key] = value
  }
  const modelSettings: Record<string, unknown> = isRecord(
    settings.modelSettings,
  )
    ? { ...settings.modelSettings }
    : {}
  for (const slot of MODEL_SETTINGS_SLOTS) {
    const entry = patch.modelSettings[slot]
    if (entry === undefined) delete modelSettings[slot]
    else modelSettings[slot] = entry
  }
  return { ...settings, modelType: patch.modelType, env, modelSettings }
}

/** The SDK's assistant-message error categories, in our words. */
const CATEGORY_MESSAGES: Record<string, string> = {
  authentication_failed:
    '真实调用失败 · 凭据被拒 · 检查密钥是否填对、是否属于这个站点',
  billing_error: '真实调用失败 · 余额或额度不足',
  rate_limit: '真实调用失败 · 被限流或额度用尽 · 稍后再试',
  invalid_request:
    '真实调用失败 · 请求被拒 · 常见原因是模型名不对或参数不被接受',
  server_error: '真实调用失败 · 服务端出错 · 稍后再试',
  max_output_tokens: '真实调用失败 · 输出上限太小',
}

type CallRun =
  | {
      kind: 'done'
      isError: boolean
      category: string | null
      httpStatus: number | null
    }
  | { kind: 'no-result'; exitCode: number | null }
  | { kind: 'timeout' }
  | { kind: 'spawn-failed' }

/**
 * The HTTP status in the runtime's own error line (`describeAPIError`:
 * `… · status=401 · code=… · category=…`). Only the digits are taken — the
 * vendor's words before them are not — and the last match, since the metadata
 * follows the message.
 */
function statusIn(text: string): number | null {
  const matches = [...text.matchAll(/ · status=(\d{3})(?= · |$)/g)]
  const last = matches.at(-1)?.[1]
  return last === undefined ? null : Number(last)
}

/** The category the HTTP status itself names, when it names one plainly. */
function statusCategory(status: number | null): string | null {
  if (status === 401 || status === 403) return 'authentication_failed'
  if (status === 402) return 'billing_error'
  if (status === 429) return 'rate_limit'
  return null
}

function readStream(stdout: string): CallRun | null {
  let category: string | null = null
  let httpStatus: number | null = null
  let result: { isError: boolean } | null = null
  for (const line of stdout.split('\n')) {
    if (!line.startsWith('{')) continue
    let message: unknown
    try {
      message = JSON.parse(line)
    } catch {
      continue
    }
    if (!isRecord(message)) continue
    if (message.type === 'assistant' && typeof message.error === 'string') {
      category = message.error
    }
    if (message.type === 'result') {
      result = {
        isError: message.is_error === true || message.subtype !== 'success',
      }
      if (typeof message.result === 'string') {
        httpStatus = statusIn(message.result)
      }
    }
  }
  return result === null
    ? null
    : { kind: 'done', ...result, category, httpStatus }
}

function runOnce(
  root: string,
  env: NodeJS.ProcessEnv,
  launch: Launch,
  timeoutMs: number,
): Promise<CallRun> {
  return new Promise(resolve => {
    let settled = false
    const finish = (run: CallRun) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(run)
    }
    let child: ReturnType<typeof spawnCli>
    try {
      child = spawnCli(launch([...CALL_ARGS], env), {
        cwd: root,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch {
      resolve({ kind: 'spawn-failed' })
      return
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish({ kind: 'timeout' })
    }, timeoutMs)
    let stdout = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < MAX_OUTPUT_BYTES) stdout += chunk.toString()
    })
    child.stderr?.on('data', () => {
      // Drained so the pipe never fills; never relayed.
    })
    child.on('error', () => finish({ kind: 'spawn-failed' }))
    child.on('close', code => {
      finish(readStream(stdout) ?? { kind: 'no-result', exitCode: code })
    })
  })
}

function failedCall(run: Extract<CallRun, { kind: 'done' }>): ProbeOutcome {
  // The runtime reads a body's own words before its status, so OpenAI's
  // bad-key answer (401, `type: invalid_request_error`) comes back as
  // `invalid_request`; a 401 / 403 / 402 / 429 status settles it here.
  const category = statusCategory(run.httpStatus) ?? run.category
  return {
    ok: false,
    reachable: true,
    ...(run.httpStatus === null ? {} : { httpStatus: run.httpStatus }),
    message:
      (category === null ? undefined : CATEGORY_MESSAGES[category]) ??
      '真实调用失败 · 原因不明',
  }
}

function outcomeOf(run: CallRun, timeoutMs: number): ProbeOutcome {
  switch (run.kind) {
    case 'done':
      return run.isError
        ? failedCall(run)
        : { ok: true, reachable: true, message: '可用 · 真实调用成功' }
    case 'timeout':
      return {
        ok: false,
        reachable: true,
        message: `真实调用超时（${Math.round(timeoutMs / 1000)} s）· 服务可达但没有在时限内答完`,
      }
    case 'no-result':
      return {
        ok: false,
        reachable: true,
        message: `真实调用没有返回结果（退出码 ${String(run.exitCode)}）`,
      }
    case 'spawn-failed':
      return {
        ok: false,
        reachable: true,
        message: '节点没能启动真实调用',
      }
  }
}

/** Run one `call` probe. Never throws; the root is gone when this returns. */
export async function probeCall(input: {
  readonly requestId: string
  readonly baseUrl: string
  readonly compiled: CompiledProfile
  readonly timeoutMs: number
  /** Defaults to this process's; provider keys are removed either way. */
  readonly env?: NodeJS.ProcessEnv
  /** How to re-execute this CLI; tests run it from source. */
  readonly launch?: Launch
}): Promise<ProbeOutcome> {
  const started = Date.now()
  const unreachable = await originAnswers(
    input.baseUrl,
    Math.min(ORIGIN_CHECK_MS, input.timeoutMs),
  )
  if (unreachable !== null) return unreachable

  const root = callProbeRoot(input.requestId)
  try {
    ensurePrivateDir(providerDir())
    rmSync(root, { recursive: true, force: true })
    mkdirSync(root, { mode: 0o700 })
    ensurePrivateDir(root)
    writePrivateJson(
      join(root, 'settings.json'),
      withPatch(nodeSettings(), input.compiled.patch),
    )
    const env: NodeJS.ProcessEnv = {
      ...withoutProviderKeys(input.env ?? process.env),
      OCC_CONFIG_DIR: root,
      // Fewer side requests to the vendor than an interactive start makes.
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    }
    delete env.CLAUDE_CONFIG_DIR
    const remaining = Math.max(1_000, input.timeoutMs - (Date.now() - started))
    const launch: Launch =
      input.launch ??
      ((cliArgs, childEnv) => buildCliLaunch(cliArgs, { env: childEnv }))
    return outcomeOf(await runOnce(root, env, launch, remaining), remaining)
  } catch {
    return {
      ok: false,
      reachable: true,
      message: '节点没能准备真实调用的临时配置',
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}
