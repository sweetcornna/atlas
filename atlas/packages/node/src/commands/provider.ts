// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `qm provider` — the node's end of the sixth action (design
 * `providers-console-m1.md` §2.5, P18.7).
 *
 *   qm provider serve-stdin --node <name>   what the sshd forced command runs
 *   qm provider status [--node <name>]
 *   qm provider probe|models|apply [--node <name>] < request.json
 *   qm provider autocompact [auto|<tokens>] [--json]
 *
 * One JSON request line on stdin (at most 64 KiB, read up to the first
 * newline), one JSON response line on stdout; the dispatch is
 * `providerOps.ts`. Keys travel only on stdin: never in argv, never in a
 * file this command reads. `status` builds its own request and reads nothing.
 *
 * Exit status: 0 — a response with `ok: true` was written; 1 — a response
 * with `ok: false`; 2 — no response (a usage error, or a fault of the node;
 * stderr names it without any message text that could carry a value).
 *
 * `autocompact` is not a protocol op: it is the base `/autocompact` for this
 * node's settings (D-9, `providerAutocompact.ts`), with `--json` for the hub.
 *
 * `__effective` is internal: the child `status` starts to compute §2.4
 * `effective` in a process of its own (`effectiveProcess.ts`).
 */

import { randomUUID } from 'node:crypto'
import {
  errorResponse,
  PROTOCOL_LIMITS,
  PROTOCOL_VERSION,
} from '@qianmo/providers'
const invokedBinName = () => 'qm'
import {
  EFFECTIVE_CHILD_SUBCOMMAND,
  printEffectiveProviderState,
} from '../providers/effectiveProcess.js'
import { parseAutocompactArgs, runAutocompact } from './providerAutocompact.js'
import { handleProviderLine, type NodeProviderResponse } from './providerOps.js'
import { residentOptionValue } from './residentArgs.js'

const QIANMO_PROVIDER_HELP_TEXT = `Usage: ${invokedBinName()} provider <command> [--node <name>]

The node's side of the console's model-service action: check, try out and
apply a model service on this node. Requests are one line of JSON on stdin,
responses one line of JSON on stdout; keys are only ever read from stdin and
never written back.

Commands:

  serve-stdin --node <name>  Read one request of any kind and answer it. This
                             is what the sshd forced command runs; --node is
                             the name the request must carry.
  status                     Report this node's model-service state, including
                             what its runtime will actually send and, for a
                             service with several keys, each key's state
                             (ok, cooling or dead; key ids only). No stdin.
  probe                      Answer a probe request from stdin (auth, latency
                             or call; call makes one real model call).
  models                     List the vendor's models for a request on stdin.
  apply                      Stage a profile from stdin; it takes effect at the
                             resident's next idle point, or now if no resident
                             is running.
  autocompact [auto|<tokens>]
                             Show or set this node's auto-compact window (the
                             /autocompact setting: auto, or 100k-1M tokens).
                             --json prints one JSON line. Maps to omp compaction.thresholdTokens; auto uses
                             its reserve-based threshold.

Options:

  --node <name>              Refuse requests addressed to another node.
  -h, --help                 Print this and exit.

Exit status: 0 for an ok response, 1 for a refusal, 2 when no response could
be written. Run as the account the resident runs as, with the same
QIANMO_CONFIG_DIR.
`

const OPS_FROM_STDIN = new Set(['probe', 'models', 'apply'])

/** How long `serve-stdin` waits for the request line. */
const STDIN_TIMEOUT_MS = 30_000

type ReadResult =
  | { ok: true; line: string }
  | { ok: false; reason: 'too-large' | 'timeout' }

/**
 * The first line of `input` (or all of it, at EOF), refusing as soon as more
 * than `maxBytes` have arrived without a newline: nothing past the limit is
 * buffered, so an oversized request cannot grow the process.
 */
export function readRequestLine(
  input: NodeJS.ReadableStream,
  maxBytes: number = PROTOCOL_LIMITS.maxRequestBytes,
  timeoutMs: number = STDIN_TIMEOUT_MS,
): Promise<ReadResult> {
  return new Promise(resolve => {
    const chunks: Buffer[] = []
    let size = 0
    let settled = false
    const finish = (result: ReadResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      input.removeListener('data', onData)
      input.removeListener('end', onEnd)
      input.removeListener('error', onEnd)
      input.pause()
      resolve(result)
    }
    const onData = (chunk: Buffer | string) => {
      const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
      const newline = buffer.indexOf(0x0a)
      const take = newline === -1 ? buffer : buffer.subarray(0, newline)
      if (size + take.byteLength > maxBytes) {
        finish({ ok: false, reason: 'too-large' })
        return
      }
      chunks.push(take)
      size += take.byteLength
      if (newline !== -1) {
        finish({ ok: true, line: Buffer.concat(chunks).toString('utf8') })
      }
    }
    const onEnd = () =>
      finish({ ok: true, line: Buffer.concat(chunks).toString('utf8') })
    const timer = setTimeout(
      () => finish({ ok: false, reason: 'timeout' }),
      timeoutMs,
    )
    input.on('data', onData)
    input.on('end', onEnd)
    input.on('error', onEnd)
    input.resume()
  })
}

function refusalFor(reason: 'too-large' | 'timeout'): NodeProviderResponse {
  return errorResponse(null, {
    code: 'bad-request',
    path: '',
    message:
      reason === 'too-large'
        ? '请求超过 64 KiB'
        : `${Math.round(STDIN_TIMEOUT_MS / 1000)} s 内没有读到完整的请求`,
  })
}

/** Write one line, then end the process once it has left. */
function respondAndExit(code: number, text: string): Promise<never> {
  return new Promise<never>(() => {
    const exit = () => process.exit(code)
    if (text === '') exit()
    else process.stdout.write(text, exit)
  })
}

function usageError(message: string): Promise<never> {
  process.stderr.write(
    `${invokedBinName()} provider: ${message} (run \`${invokedBinName()} provider --help\`)\n`,
  )
  return respondAndExit(2, '')
}

/** `--node <name>` and nothing else; `required` for `serve-stdin`. */
function parseNodeOption(
  args: readonly string[],
  required: boolean,
): string | undefined {
  let node: string | undefined
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string
    if (arg === '--node' || arg.startsWith('--node=')) {
      const parsed = residentOptionValue(args, i, '--node')
      node = parsed.value
      i = parsed.next
      continue
    }
    throw new Error(`unknown option ${arg}`)
  }
  if (required && node === undefined) throw new Error('--node is required')
  return node
}

export async function runProvider(args: readonly string[]): Promise<void> {
  const [command, ...rest] = args
  if (
    command === undefined ||
    args.some(arg => arg === '--help' || arg === '-h')
  ) {
    process.stdout.write(QIANMO_PROVIDER_HELP_TEXT)
    return
  }
  if (command === EFFECTIVE_CHILD_SUBCOMMAND) {
    let line = ''
    await printEffectiveProviderState(text => {
      line += text
    })
    await respondAndExit(0, line)
  }
  if (command === 'autocompact') await autocompact(rest)
  if (
    command !== 'serve-stdin' &&
    command !== 'status' &&
    !OPS_FROM_STDIN.has(command)
  ) {
    await usageError(`unknown command ${command}`)
  }

  let node: string | undefined
  try {
    node = parseNodeOption(rest, command === 'serve-stdin')
  } catch (error) {
    await usageError(error instanceof Error ? error.message : 'bad options')
  }

  let response: NodeProviderResponse
  try {
    if (command === 'status') {
      response = await handleProviderLine(
        JSON.stringify({
          v: PROTOCOL_VERSION,
          op: 'status',
          requestId: randomUUID(),
          node: node ?? 'local',
        }),
        { ...(node === undefined ? {} : { node }) },
      )
    } else {
      const read = await readRequestLine(process.stdin)
      const op = read.ok ? opOf(read.line) : undefined
      if (!read.ok) {
        response = refusalFor(read.reason)
      } else if (
        OPS_FROM_STDIN.has(command) &&
        op !== undefined &&
        op !== command
      ) {
        // Checked before dispatch: `qm provider probe` must never apply.
        response = errorResponse(null, {
          code: 'unsupported-op',
          path: 'op',
          message: `这个子命令只接受 op=${command}`,
        })
      } else {
        response = await handleProviderLine(
          read.line,
          node === undefined ? {} : { node },
        )
      }
    }
  } catch (error) {
    // A fault of the node, not of the request. Only the error's class: its
    // message could quote a configuration file.
    process.stderr.write(
      `${invokedBinName()} provider: internal error (${error instanceof Error ? error.name : typeof error})\n`,
    )
    await respondAndExit(2, '')
    return
  }
  await respondAndExit(response.ok ? 0 : 1, `${JSON.stringify(response)}\n`)
}

async function autocompact(args: readonly string[]): Promise<never> {
  let parsed: ReturnType<typeof parseAutocompactArgs>
  try {
    parsed = parseAutocompactArgs(args)
  } catch (error) {
    return usageError(error instanceof Error ? error.message : 'bad options')
  }
  let run: Awaited<ReturnType<typeof runAutocompact>>
  try {
    run = await runAutocompact(parsed)
  } catch (error) {
    process.stderr.write(
      `${invokedBinName()} provider: internal error (${error instanceof Error ? error.name : typeof error})\n`,
    )
    return respondAndExit(2, '')
  }
  if (run.stderr !== '') process.stderr.write(run.stderr)
  return respondAndExit(run.exitCode, run.stdout)
}

/**
 * The `op` a request line names, if it parses at all; a line that does not
 * is left to the protocol parser, which says why.
 */
function opOf(line: string): unknown {
  try {
    const parsed: unknown = JSON.parse(line)
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as { op?: unknown }).op
      : undefined
  } catch {
    return undefined
  }
}

export async function run(argv: string[]): Promise<number> {
  await runProvider(argv)
  return 0
}
