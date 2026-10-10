// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { withoutModelConfigEnvironment } from '../providers/whitelist.js'
import { ompChildEnv } from '@qianmo/paths'
import type { CompiledProfile } from '../providers/compile.js'
import {
  ensurePrivateDir,
  providerDir,
  writePrivateJson,
} from '../providers/store.js'
import { withoutProviderKeys } from '../host/residentOmpEnv.js'
import { ompArgv } from '../omp/launch.js'
import type { CliLaunchSpec } from '../providers/effectiveProcess.js'
import { originAnswers, type ProbeOutcome } from './providerProbe.js'
import { reuseProbeNativeCache } from './providerNativeCache.js'
function spawnCli(spec: CliLaunchSpec, options: Parameters<typeof spawn>[2]) {
  return spawn(spec.execPath, spec.args, { ...options, env: spec.env })
}

type Launch = (cliArgs: string[], env: NodeJS.ProcessEnv) => CliLaunchSpec

/** What the one turn is asked; one word back keeps the output minimal. */
const PROMPT = 'Reply with the single word OK.'

const CALL_ARGS = [
  '-p',
  '--mode',
  'json',
  '--no-session',
  '--no-tools',
  '--no-extensions',
  '--no-skills',
  '--no-rules',
  '--no-title',
  PROMPT,
]

/** The no-key reachability check before anything is spent. */
const ORIGIN_CHECK_MS = 10_000

/** Output past this is not read; one stream-json turn is far smaller. */
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024

/** The temporary config root for one `call`. */
export function callProbeRoot(requestId: string): string {
  return join(providerDir(), `probe-${requestId}`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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

/** A signal is not exit evidence. Callers must not start another model child. */
export class ProbeExitUnconfirmedError extends Error {
  constructor() {
    super(
      'native model probe exit could not be confirmed; generation remains unavailable',
    )
    this.name = 'ProbeExitUnconfirmedError'
  }
}

/**
 * The HTTP status in the runtime's own error line (`describeAPIError`:
 * `… · status=401 · code=… · category=…`). Only the digits are taken — the
 * vendor's words before them are not — and the last match, since the metadata
 * follows the message.
 */
/** The category the HTTP status itself names, when it names one plainly. */
function statusCategory(status: number | null): string | null {
  if (status === 401 || status === 403) return 'authentication_failed'
  if (status === 402) return 'billing_error'
  if (status === 429) return 'rate_limit'
  return null
}

function readStream(stdout: string): CallRun | null {
  let result: CallRun | null = null
  for (const line of stdout.split('\n')) {
    let event: unknown
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    if (
      !isRecord(event) ||
      event.type !== 'message_end' ||
      !isRecord(event.message) ||
      event.message.role !== 'assistant'
    )
      continue
    const msg = event.message
    const status = typeof msg.errorStatus === 'number' ? msg.errorStatus : null
    result = {
      kind: 'done',
      isError:
        msg.stopReason === 'error' ||
        msg.stopReason === 'aborted' ||
        !Array.isArray(msg.content) ||
        !msg.content.some(
          block =>
            isRecord(block) &&
            block.type === 'text' &&
            typeof block.text === 'string' &&
            block.text.trim().length > 0,
        ),
      category: statusCategory(status),
      httpStatus: status,
    }
  }
  return result
}

function runOnce(
  root: string,
  env: NodeJS.ProcessEnv,
  launch: Launch,
  timeoutMs: number,
  options: {
    signal?: AbortSignal
    spawn?: typeof spawnCli
    exitConfirmationMs?: number
  } = {},
): Promise<CallRun> {
  return new Promise((resolve, reject) => {
    options.signal?.throwIfAborted()
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let exitTimer: ReturnType<typeof setTimeout> | undefined
    let terminated = false
    const finish = (run: CallRun) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(exitTimer)
      options.signal?.removeEventListener('abort', terminate)
      resolve(run)
    }
    let child: ReturnType<typeof spawnCli>
    try {
      child = (options.spawn ?? spawnCli)(launch([...CALL_ARGS], env), {
        cwd: root,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch {
      resolve({ kind: 'spawn-failed' })
      return
    }
    function terminate() {
      if (settled || terminated) return
      terminated = true
      try {
        child.kill('SIGKILL')
      } catch {
        /* close remains the only evidence */
      }
      exitTimer = setTimeout(() => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        options.signal?.removeEventListener('abort', terminate)
        reject(new ProbeExitUnconfirmedError())
      }, options.exitConfirmationMs ?? 2000)
    }
    timer = setTimeout(terminate, timeoutMs)
    options.signal?.addEventListener('abort', terminate, { once: true })
    if (options.signal?.aborted) terminate()
    let stdout = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < MAX_OUTPUT_BYTES) stdout += chunk.toString()
    })
    child.stderr?.on('data', () => {
      // Drained so the pipe never fills; never relayed.
    })
    child.on('error', () => {
      if (child.pid === undefined) finish({ kind: 'spawn-failed' })
      else terminate()
    })
    child.on('close', code => {
      finish(
        terminated
          ? { kind: 'timeout' }
          : (readStream(stdout) ?? { kind: 'no-result', exitCode: code }),
      )
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

/** Known-terminated failures return a diagnostic. Cancellation and unconfirmed
 * exit throw; only unconfirmed exit retains its private root for diagnosis. */
export async function probeCall(input: {
  readonly requestId: string
  readonly baseUrl: string
  readonly compiled: CompiledProfile
  readonly timeoutMs: number
  /** Defaults to this process's; provider keys are removed either way. */
  readonly env?: NodeJS.ProcessEnv
  /** How to re-execute this CLI; tests run it from source. */
  readonly launch?: Launch
  readonly signal?: AbortSignal
  /** Trusted local test seam; never accepted from a provider or wire request. */
  readonly spawn?: typeof spawnCli
  readonly exitConfirmationMs?: number
}): Promise<ProbeOutcome> {
  input.signal?.throwIfAborted()
  const started = Date.now()
  const unreachable = await originAnswers(
    input.baseUrl,
    Math.min(ORIGIN_CHECK_MS, input.timeoutMs),
  )
  if (unreachable !== null) return unreachable

  ensurePrivateDir(providerDir())
  const root = mkdtempSync(`${callProbeRoot(input.requestId)}-`)
  let exitConfirmed = true
  try {
    ensurePrivateDir(root)
    const agentDir = join(root, 'omp', 'agent')
    writePrivateJson(join(agentDir, 'models.yml'), input.compiled.models)
    writePrivateJson(join(agentDir, 'config.yml'), {
      ...input.compiled.config,
      retry: { enabled: false, maxRetries: 0, fallbackChains: {} },
    })
    const env = withoutModelConfigEnvironment(
      ompChildEnv({
        ...withoutProviderKeys(input.env ?? process.env),
        QIANMO_CONFIG_DIR: root,
      }),
      input.compiled.models,
    )
    reuseProbeNativeCache(input.env ?? process.env, env)
    const remaining = Math.max(1_000, input.timeoutMs - (Date.now() - started))
    const launch: Launch =
      input.launch ??
      ((args, childEnv) => {
        const argv = ompArgv(args)
        return { execPath: argv[0]!, args: argv.slice(1), env: childEnv }
      })
    const run = await runOnce(root, env, launch, remaining, input)
    input.signal?.throwIfAborted()
    return outcomeOf(run, remaining)
  } catch (error) {
    if (error instanceof ProbeExitUnconfirmedError) {
      exitConfirmed = false
      throw error
    }
    input.signal?.throwIfAborted()
    return {
      ok: false,
      reachable: true,
      message: '节点没能准备真实调用的临时配置',
    }
  } finally {
    // An unconfirmed child may still read its private config. Preserve it for
    // diagnosis; the caller is required to leave the generation unavailable.
    if (exitConfirmed) rmSync(root, { recursive: true, force: true })
  }
}
