// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `qm provider` as the forced command runs it: this CLI from source, one
 * request on stdin, one response line on stdout, the exit status. The stdin
 * limit is also checked on the reader alone, byte for byte.
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import {
  applyRequest,
  CANARY_KEY,
} from '../../../services/qianmo/providers/__tests__/helpers.js'
import { readRequestLine } from '../provider.js'
import { childEnv, sourceArgs } from './providerSource.js'

const LIMIT = 64 * 1024
const PROCESS_KEY = 'sk-test-canary-provider-cli-env-4Nf7'
const CLI_TIMEOUT_MS = 120_000

let root: string
let config: string

type Run = { code: number; stdout: string; stderr: string }

async function qmProvider(
  args: string[],
  stdin: string | null,
  env: Record<string, string> = {},
): Promise<Run> {
  const child = Bun.spawn(
    [process.execPath, ...sourceArgs(['provider', ...args])],
    {
      cwd: root,
      env: childEnv({ CLAUDE_CONFIG_DIR: config, HOME: root, ...env }),
      stdin: stdin === null ? 'ignore' : 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )
  if (stdin !== null && child.stdin) {
    try {
      child.stdin.write(stdin)
      await child.stdin.end()
    } catch {
      // The node may answer and exit before reading all of an oversized line.
    }
  }
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { code, stdout, stderr }
}

function responseOf(run: Run): Record<string, unknown> {
  const lines = run.stdout.split('\n').filter(line => line !== '')
  expect(lines).toHaveLength(1)
  return JSON.parse(lines[0] as string) as Record<string, unknown>
}

function statusLine(padTo?: number): string {
  const json = JSON.stringify({
    v: 1,
    op: 'status',
    requestId: '01JBCLISTATUS000000000001',
    node: 'beta-1',
  })
  return padTo === undefined ? json : json.padEnd(padTo, ' ')
}

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'qianmo-provider-cli-')))
  config = join(root, 'config')
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

beforeEach(() => {
  rmSync(config, { recursive: true, force: true })
  mkdirSync(config, { mode: 0o700 })
  chmodSync(config, 0o700)
})

describe('readRequestLine: the 64 KiB limit, on the reader alone', () => {
  const feed = (input: PassThrough, chunks: (string | Buffer)[]) => {
    for (const chunk of chunks) input.write(chunk)
  }

  test('exactly 64 KiB, in pieces, then a newline: read in full', async () => {
    const input = new PassThrough()
    const reading = readRequestLine(input, LIMIT, 5_000)
    const body = 'a'.repeat(LIMIT)
    feed(input, [
      body.slice(0, 1000),
      body.slice(1000, 40_000),
      `${body.slice(40_000)}\nnext`,
    ])
    const result = await reading
    expect(result.ok && result.line.length).toBe(LIMIT)
  })

  test('one byte more: refused at once, without waiting for the rest', async () => {
    const input = new PassThrough()
    const reading = readRequestLine(input, LIMIT, 5_000)
    feed(input, ['a'.repeat(LIMIT), 'a'])
    expect(await reading).toEqual({ ok: false, reason: 'too-large' })
    // Nothing ended the stream: the refusal did not wait for EOF.
    expect(input.writableEnded).toBe(false)
  })

  test('the limit counts bytes, not characters', async () => {
    const input = new PassThrough()
    const reading = readRequestLine(input, LIMIT, 5_000)
    // 21 846 three-byte characters: 65 538 bytes.
    feed(input, ['阡'.repeat(21_846)])
    expect(await reading).toEqual({ ok: false, reason: 'too-large' })
  })

  test('only the first line is read; EOF without a newline ends it too', async () => {
    const first = new PassThrough()
    const reading = readRequestLine(first, LIMIT, 5_000)
    feed(first, ['{"a":', '1}\n{"b":2}\n'])
    expect(await reading).toEqual({ ok: true, line: '{"a":1}' })

    const second = new PassThrough()
    const ending = readRequestLine(second, LIMIT, 5_000)
    second.end('{"a":1}')
    expect(await ending).toEqual({ ok: true, line: '{"a":1}' })
  })

  test('a request that never arrives times out', async () => {
    const input = new PassThrough()
    expect(await readRequestLine(input, LIMIT, 50)).toEqual({
      ok: false,
      reason: 'timeout',
    })
  })
})

describe('qm provider from source', () => {
  test(
    'serve-stdin: a 64 KiB line is answered; 64 KiB + 1 is refused with bad-request and exit 1',
    async () => {
      const atLimit = await qmProvider(
        ['serve-stdin', '--node', 'beta-1'],
        `${statusLine(LIMIT)}\n`,
      )
      expect(atLimit.code).toBe(0)
      expect(responseOf(atLimit)).toMatchObject({ ok: true })

      const over = await qmProvider(
        ['serve-stdin', '--node', 'beta-1'],
        `${statusLine(LIMIT + 1)}\n`,
      )
      expect(over.code).toBe(1)
      expect(responseOf(over)).toEqual({
        v: 1,
        requestId: null,
        ok: false,
        code: 'bad-request',
        message: '请求超过 64 KiB',
      })
    },
    CLI_TIMEOUT_MS,
  )

  test(
    'apply then status: committed here; effective follows settings, not a provider env the node was started with',
    async () => {
      const request = applyRequest()
      const applied = await qmProvider(
        ['serve-stdin', '--node', 'beta-1'],
        `${JSON.stringify(request)}\n`,
      )
      expect(applied.code).toBe(0)
      const appliedResponse = responseOf(applied)
      expect(appliedResponse).toMatchObject({
        ok: true,
        requestId: request.requestId,
        state: { managed: true, pending: null },
      })
      const settings = JSON.parse(
        readFileSync(join(config, 'settings.json'), 'utf8'),
      ) as { env: Record<string, string> }
      expect(settings.env.ANTHROPIC_AUTH_TOKEN).toBe(CANARY_KEY)
      expect(applied.stdout).not.toContain(CANARY_KEY)
      expect(applied.stderr).not.toContain(CANARY_KEY)

      // The fleet's own way of naming a model, in the forced command's env.
      const status = await qmProvider(['status', '--node', 'beta-1'], null, {
        CLAUDE_CODE_USE_OPENAI: '1',
        OPENAI_BASE_URL: 'https://process-env.example/v1',
        OPENAI_API_KEY: PROCESS_KEY,
        OPENAI_MODEL: 'process-env-model',
      })
      expect(status.code).toBe(0)
      const statusResponse = responseOf(status)
      expect(statusResponse).toMatchObject({
        ok: true,
        state: { managed: true },
        effective: {
          apiProvider: 'firstParty',
          wire: 'anthropic',
          model: 'vendor-model-pro',
        },
      })
      for (const text of [status.stdout, status.stderr]) {
        expect(text).not.toContain(CANARY_KEY)
        expect(text).not.toContain(PROCESS_KEY)
      }
    },
    CLI_TIMEOUT_MS,
  )

  test(
    'an op subcommand never runs another op: `probe` given an apply is refused before dispatch',
    async () => {
      const run = await qmProvider(
        ['probe', '--node', 'beta-1'],
        `${JSON.stringify(applyRequest())}\n`,
      )
      expect(run.code).toBe(1)
      expect(responseOf(run)).toMatchObject({
        ok: false,
        code: 'unsupported-op',
        requestId: null,
      })
      expect(existsSync(join(config, 'qianmo'))).toBe(false)
      expect(existsSync(join(config, 'settings.json'))).toBe(false)
    },
    CLI_TIMEOUT_MS,
  )

  test(
    'a request for another node: exit 1, node-mismatch',
    async () => {
      const run = await qmProvider(
        ['serve-stdin', '--node', 'beta-2'],
        `${statusLine()}\n`,
      )
      expect(run.code).toBe(1)
      expect(responseOf(run)).toMatchObject({ code: 'node-mismatch' })
    },
    CLI_TIMEOUT_MS,
  )

  test(
    'usage errors write no response and exit 2: serve-stdin without --node, an unknown command, an unknown option',
    async () => {
      for (const args of [
        ['serve-stdin'],
        ['restart'],
        ['status', '--verbose'],
      ]) {
        const run = await qmProvider(args, null)
        expect(run.code).toBe(2)
        expect(run.stdout).toBe('')
        expect(run.stderr).toContain('provider --help')
      }
    },
    CLI_TIMEOUT_MS,
  )

  test(
    '--help prints the commands and exits 0',
    async () => {
      const run = await qmProvider(['--help'], null)
      expect(run.code).toBe(0)
      for (const word of [
        'serve-stdin',
        'status',
        'probe',
        'models',
        'apply',
      ]) {
        expect(run.stdout).toContain(word)
      }
      expect(run.stdout).not.toContain('__effective')
    },
    CLI_TIMEOUT_MS,
  )

  test(
    'settings.json the node already had stays private after a commit through the CLI',
    async () => {
      writeFileSync(
        join(config, 'settings.json'),
        '{"env":{"MY_TOOL_FLAG":"on"}}\n',
        { mode: 0o644 },
      )
      const run = await qmProvider(
        ['apply', '--node', 'beta-1'],
        `${JSON.stringify(applyRequest())}\n`,
      )
      expect(run.code).toBe(0)
      const settings = JSON.parse(
        readFileSync(join(config, 'settings.json'), 'utf8'),
      ) as { env: Record<string, string> }
      expect(settings.env.MY_TOOL_FLAG).toBe('on')
      expect(settings.env.ANTHROPIC_AUTH_TOKEN).toBe(CANARY_KEY)
    },
    CLI_TIMEOUT_MS,
  )
})
