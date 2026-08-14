// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: MIT

import { MessageType, assertAddress, createMessage } from '@qianmo/protocol'
import {
  TransportClient,
  pskFromEnv,
  type SuccessfulReceiptStatus,
} from '@qianmo/transport'
import { IDENTITY_MODE, type IdentityMode } from '../../constants/identity.js'
import { residentOptionValue } from './residentArgs.js'

const MAX_TIMER_DELAY_MS = 2_147_483_647

export interface ResidentWakeConfig {
  readonly url: string
  readonly from: string
  readonly to: string
  readonly prompt: string
  readonly afterMs: number
  readonly timeoutMs: number
  readonly deliverTtlMs: number
}

function integer(
  raw: string,
  name: string,
  minimum: number,
  maximum: number,
): number {
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`)
  }
  return parsed
}

export function parseResidentWakeArgs(
  args: readonly string[],
  identity: IdentityMode = IDENTITY_MODE,
): ResidentWakeConfig {
  let url: string | undefined
  let from: string | undefined
  let to: string | undefined
  let prompt: string | undefined
  let afterMs = 0
  let timeoutMs = 90_000
  let deliverTtlMs = 90_000

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === '--url' || arg?.startsWith('--url=')) {
      const parsed = residentOptionValue(args, index, '--url')
      const endpoint = new URL(parsed.value)
      if (endpoint.protocol !== 'ws:' && endpoint.protocol !== 'wss:') {
        throw new Error('--url must use ws or wss')
      }
      url = endpoint.toString()
      index = parsed.next
    } else if (arg === '--from' || arg?.startsWith('--from=')) {
      const parsed = residentOptionValue(args, index, '--from')
      assertAddress(parsed.value, '--from')
      from = parsed.value
      index = parsed.next
    } else if (arg === '--to' || arg?.startsWith('--to=')) {
      const parsed = residentOptionValue(args, index, '--to')
      assertAddress(parsed.value, '--to')
      to = parsed.value
      index = parsed.next
    } else if (arg === '--prompt' || arg?.startsWith('--prompt=')) {
      const parsed = residentOptionValue(args, index, '--prompt')
      if (parsed.value.trim() === '')
        throw new Error('--prompt must not be empty')
      prompt = parsed.value
      index = parsed.next
    } else if (arg === '--after-ms' || arg?.startsWith('--after-ms=')) {
      const parsed = residentOptionValue(args, index, '--after-ms')
      afterMs = integer(parsed.value, '--after-ms', 0, MAX_TIMER_DELAY_MS)
      index = parsed.next
    } else if (arg === '--timeout-ms' || arg?.startsWith('--timeout-ms=')) {
      const parsed = residentOptionValue(args, index, '--timeout-ms')
      timeoutMs = integer(parsed.value, '--timeout-ms', 1, MAX_TIMER_DELAY_MS)
      index = parsed.next
    } else if (
      arg === '--deliver-ttl-ms' ||
      arg?.startsWith('--deliver-ttl-ms=')
    ) {
      const parsed = residentOptionValue(args, index, '--deliver-ttl-ms')
      deliverTtlMs = integer(
        parsed.value,
        '--deliver-ttl-ms',
        1,
        MAX_TIMER_DELAY_MS,
      )
      index = parsed.next
    } else {
      throw new Error(`unknown resident wake option ${String(arg)}`)
    }
  }

  if (identity !== 'qianmo') {
    throw new Error('resident wake requires OCC_IDENTITY=qianmo')
  }
  if (url === undefined) throw new Error('resident wake requires --url')
  if (from === undefined) throw new Error('resident wake requires --from')
  if (to === undefined) throw new Error('resident wake requires --to')
  if (prompt === undefined) throw new Error('resident wake requires --prompt')

  return { url, from, to, prompt, afterMs, timeoutMs, deliverTtlMs }
}

interface ResidentWakeResult {
  readonly msgId: string
  readonly taskId: string
  readonly receipt: SuccessfulReceiptStatus
}

export async function executeResidentWake(
  config: ResidentWakeConfig,
  psk: string,
): Promise<ResidentWakeResult> {
  if (config.afterMs > 0) {
    await new Promise<void>(resolve => setTimeout(resolve, config.afterMs))
  }

  const message = createMessage({
    from: config.from,
    to: config.to,
    type: MessageType.Wake,
    payload: {
      trigger: config.afterMs > 0 ? 'timer' : 'manual',
      prompt: config.prompt,
    },
    deliverTtlMs: config.deliverTtlMs,
  })
  const client = new TransportClient({
    endpoint: { url: config.url },
    node: assertAddress(config.from).node,
    psk,
    keepAliveIntervalMs: 0,
  })

  try {
    await client.connect(Math.min(config.timeoutMs, 30_000))
    const receipt = await client.sendAndWait(message, config.timeoutMs)
    return { msgId: message.msgId, taskId: message.taskId, receipt }
  } finally {
    await client.close()
  }
}

export async function runResidentWake(args: readonly string[]): Promise<void> {
  const result = await executeResidentWake(
    parseResidentWakeArgs(args),
    pskFromEnv(),
  )
  process.stdout.write(`${JSON.stringify(result)}\n`)
}
