// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, spyOn, test } from 'bun:test'
import * as consolePackage from '@qianmo/console'
import type { ConsoleDeps } from '@qianmo/console'
import * as transport from '@qianmo/transport'
import { runConsole } from '../../src/commands/console.js'
import {
  CONSOLE_HELP_TEXT,
  parseConsoleArgs,
} from '../../src/commands/consoleArgs.js'
import type { ConsoleChatHub } from '../../src/commands/consoleChat.js'

const MAIN = 'qianmo://node-b/reviewer'

describe('console front host configuration', () => {
  test('--chat-default parses both option forms and rejects invalid addresses', () => {
    for (const args of [['--chat-default', MAIN], [`--chat-default=${MAIN}`]]) {
      expect(parseConsoleArgs(args).chatDefault).toBe(MAIN)
    }
    for (const value of [
      'http://node-b/reviewer',
      'qianmo://node-b',
      'qianmo://node-b/agent/extra',
      'not-an-address',
    ]) {
      expect(() => parseConsoleArgs([`--chat-default=${value}`])).toThrow(
        '--chat-default must be a qianmo://<node>/<agent> address',
      )
    }
    expect(() => parseConsoleArgs(['--chat-default'])).toThrow('--chat-default')
    expect(CONSOLE_HELP_TEXT).toContain('--chat-default <address>')
    expect(CONSOLE_HELP_TEXT).toContain('qianmo://<node>/<agent>')
  })

  test('the production host passes the preference only when a chat channel was wired', async () => {
    const reachedServer = new Error('server construction intercepted')
    let captured: ConsoleDeps | undefined
    const server = spyOn(
      consolePackage,
      'startConsoleServer',
    ).mockImplementation(deps => {
      captured = deps
      throw reachedServer
    })
    const psk = spyOn(transport, 'pskFromEnv')
    try {
      for (const [args, keyAvailable, expected] of [
        [[], true, false],
        [['--chat-url=node-b=ws://127.0.0.1:38612'], false, false],
        [['--chat-url=node-b=ws://127.0.0.1:38612'], true, true],
      ] as const) {
        captured = undefined
        psk.mockImplementation(() => {
          if (!keyAvailable) throw new Error('missing test key')
          return 'test-console-front-psk-long-enough'
        })
        await expect(
          runConsole(['--port=0', `--chat-default=${MAIN}`, ...args]),
        ).rejects.toBe(reachedServer)
        const deps = captured as ConsoleDeps | undefined
        expect(deps).toBeDefined()
        expect(deps?.chatDefault).toBe(expected ? MAIN : undefined)
        expect(deps?.chat !== undefined).toBe(expected)
        // The production hub is created before the server; close it even though no server was bound.
        if (deps?.chat !== undefined)
          await (deps.chat as ConsoleChatHub).close()
      }
    } finally {
      psk.mockRestore()
      server.mockRestore()
    }
  })
})
