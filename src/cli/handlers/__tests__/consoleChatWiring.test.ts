// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: MIT

import { describe, expect, test } from 'bun:test'
import { parseConsoleArgs, transportPskEnvVarForNode } from '../consoleArgs.js'
import { wireConsoleChat } from '../console.js'
import type { ConsoleChatHub } from '../consoleChat.js'
import type { RegistryPort } from '@qianmo/console'

const GLOBAL_PSK = 'global-psk-that-must-not-enable-named-targets'
const NAMED_A_PSK = 'named-a-psk-that-is-long-enough-to-be-usable'
const NAMED_B_PSK = 'named-b-psk-that-is-long-enough-to-be-usable'
const STORE = '/tmp/qianmo-chat-wiring-not-written.ndjson'

function registryPort(): RegistryPort {
  return {
    async list() {
      return { ok: true, value: [] }
    },
  } as unknown as RegistryPort
}

/** A hub that is never driven — these tests only inspect what was wired. */
function chatHub(): ConsoleChatHub {
  return {
    async close() {},
  } as unknown as ConsoleChatHub
}

function wire(
  args: readonly string[],
  keys: Readonly<Record<string, string>>,
  options: { readonly globalPsk?: string } = {},
) {
  const queried: Array<string | undefined> = []
  const created: Array<{
    readonly url: string
    readonly psk: string
    readonly node?: string
  }> = []
  const wiring = wireConsoleChat(
    parseConsoleArgs([...args, `--chat-store=${STORE}`], 'qianmo'),
    registryPort(),
    {
      pskFromEnv(variable) {
        queried.push(variable)
        if (variable === undefined) {
          const global = options.globalPsk
          if (global === undefined) throw new Error('psk missing')
          return global
        }
        const value = keys[variable]
        if (value === undefined) throw new Error('psk missing')
        return value
      },
      createChatPort(portOptions) {
        for (const endpoint of portOptions.endpoints) created.push(endpoint)
        return chatHub()
      },
    },
  )
  return { wiring, queried, created }
}

describe('console chat wiring', () => {
  test('named targets read their own PSK variable, never the global one', () => {
    const variable = transportPskEnvVarForNode('beta-4')
    const { wiring, queried, created } = wire(
      ['--chat-url=beta-4=ws://127.0.0.1:38625'],
      { [variable]: NAMED_A_PSK },
      { globalPsk: GLOBAL_PSK },
    )

    expect(queried).toEqual([variable])
    expect(created).toEqual([
      { url: 'ws://127.0.0.1:38625/', psk: NAMED_A_PSK, node: 'beta-4' },
    ])
    expect(wiring.hub).toBeDefined()
    expect(wiring.status).toBe(
      'enabled as qianmo://console/operator -> beta-4 -> ws://127.0.0.1:38625/',
    )
  })

  test('one node without a key does not take the others down with it', () => {
    // 这正是 p11 上会发生的事：四个节点各一把，某一台还没分发到。
    const variableA = transportPskEnvVarForNode('beta-1')
    const variableB = transportPskEnvVarForNode('beta-2')
    const { wiring, created } = wire(
      [
        '--chat-url=beta-1=ws://127.0.0.1:38631',
        '--chat-url=beta-2=ws://127.0.0.1:38632',
      ],
      { [variableB]: NAMED_B_PSK },
    )

    expect(created).toEqual([
      { url: 'ws://127.0.0.1:38632/', psk: NAMED_B_PSK, node: 'beta-2' },
    ])
    expect(wiring.hub).toBeDefined()
    // 逐节点写清楚，而不是一句「有的没起来」。
    expect(wiring.status).toContain('beta-1 disabled (PSK unavailable)')
    expect(wiring.status).toContain('beta-2 -> ws://127.0.0.1:38632/')
    // 秘密边界：钥匙本身与它的读取失败原因都不进 banner。
    expect(wiring.status).not.toContain(variableA)
  })

  test('every node missing a key is the same as having no chat face', () => {
    const { wiring, created } = wire(
      ['--chat-url=beta-1=ws://127.0.0.1:38631'],
      {},
      { globalPsk: GLOBAL_PSK },
    )

    expect(created).toEqual([])
    expect(wiring.hub).toBeUndefined()
    expect(wiring.status).toBe('disabled (beta-1 disabled (PSK unavailable))')
  })

  test('a legacy bare URL still reads the shared PSK and binds no node', () => {
    const { wiring, queried, created } = wire(
      ['--chat-url=ws://127.0.0.1:38611'],
      {},
      { globalPsk: GLOBAL_PSK },
    )

    expect(queried).toEqual([undefined])
    expect(created).toEqual([{ url: 'ws://127.0.0.1:38611/', psk: GLOBAL_PSK }])
    expect(wiring.hub).toBeDefined()
  })

  test('no --chat-url is the one disabled reason that predates PSK lookup', () => {
    const { wiring, queried } = wire([], {}, { globalPsk: GLOBAL_PSK })

    expect(queried).toEqual([])
    expect(wiring.status).toBe('disabled (no --chat-url)')
  })
})
