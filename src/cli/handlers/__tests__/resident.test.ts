import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_RESIDENT_MEM_INTERVAL_MS,
  MAX_PENDING_TIMING_EVENTS,
  RESIDENT_HELP_TEXT,
  assertResidentRuntime,
  createResidentMemWriter,
  createResidentTimingWriter,
  isResidentHelpRequest,
  parseResidentArgs,
} from '../resident.js'

const BASE = [
  '--node',
  'node-b',
  '--team',
  'atlas',
  '--agent',
  'reviewer=/workspace',
  '--port',
  '7321',
  '--hostname',
  '127.0.0.1',
] as const

describe('resident CLI configuration', () => {
  test('fails closed outside the Bun runtime', () => {
    expect(() => assertResidentRuntime(false)).toThrow(
      'requires the Bun runtime',
    )
    expect(() => assertResidentRuntime(true)).not.toThrow()
  })

  test('requires the Qianmo identity and preserves explicit exposure choices', () => {
    expect(parseResidentArgs(BASE, 'qianmo')).toEqual({
      node: 'node-b',
      team: 'atlas',
      agents: [{ agent: 'reviewer', cwd: '/workspace' }],
      port: 7321,
      hostname: '127.0.0.1',
      // Capability defaults: trust nobody but itself, and admit unsigned work
      // (P4.3 — `packages/capability/src/policy.ts` says why the M0 default is
      // permissive about *requiring* a token while still verifying every one
      // that is presented).
      trusted: [],
      requireSignedTasks: false,
      // Observation mode is off unless asked for, and it is a *second*
      // switch rather than a mode of the first (§9.2 phase ①).
      auditSignedTasks: false,
    })
    expect(() => parseResidentArgs(BASE, 'occ')).toThrow('OCC_IDENTITY=qianmo')
  })

  test('never guesses a TCP hostname or listener', () => {
    expect(() =>
      parseResidentArgs(
        BASE.filter(arg => arg !== '--hostname' && arg !== '127.0.0.1'),
        'qianmo',
      ),
    ).toThrow('explicit --hostname')
    expect(() => parseResidentArgs(BASE.slice(0, 6), 'qianmo')).toThrow(
      'requires --port or --unix',
    )
  })

  test('requires absolute cwd and unique safe agent names', () => {
    expect(() =>
      parseResidentArgs(
        BASE.map(arg =>
          arg === 'reviewer=/workspace' ? 'reviewer=relative' : arg,
        ),
        'qianmo',
      ),
    ).toThrow('cwd must be absolute')
    expect(() =>
      parseResidentArgs([...BASE, '--agent', 'reviewer=/other'], 'qianmo'),
    ).toThrow('unique')
  })

  test('accepts explicit host activity and timing endpoints', () => {
    expect(
      parseResidentArgs(
        [...BASE, '--activity-url=ws://host.internal:7331'],
        'qianmo',
      ),
    ).toMatchObject({
      activityUrl: 'ws://host.internal:7331/',
      activityReconnectFactor: 1.1,
    })
    expect(
      parseResidentArgs(
        [
          ...BASE,
          '--activity-url=ws://host.internal:7331',
          '--activity-reconnect-factor=1.1',
          '--timings=/tmp/resident-timings.jsonl',
        ],
        'qianmo',
      ),
    ).toMatchObject({
      activityUrl: 'ws://host.internal:7331/',
      activityReconnectFactor: 1.1,
      timings: '/tmp/resident-timings.jsonl',
    })
    expect(() =>
      parseResidentArgs(
        [...BASE, '--activity-url=http://host.internal'],
        'qianmo',
      ),
    ).toThrow('must use ws or wss')
    expect(() =>
      parseResidentArgs([...BASE, '--timings=relative.jsonl'], 'qianmo'),
    ).toThrow('absolute path')
    expect(() =>
      parseResidentArgs([...BASE, '--activity-reconnect-factor=1.1'], 'qianmo'),
    ).toThrow('requires --activity-url')
    expect(() =>
      parseResidentArgs(
        [
          ...BASE,
          '--activity-url=ws://host.internal:7331',
          '--activity-reconnect-factor=1',
        ],
        'qianmo',
      ),
    ).toThrow('greater than 1')
  })

  test('accepts an absolute unix socket without TCP options', () => {
    expect(
      parseResidentArgs(
        [
          '--node=node-b',
          '--team=atlas',
          '--agent=reviewer=/workspace',
          '--unix=/tmp/qianmo-resident.sock',
        ],
        'qianmo',
      ),
    ).toMatchObject({ unix: '/tmp/qianmo-resident.sock' })
  })

  test('takes a memory sampling path and defaults its interval (P7.3)', () => {
    expect(
      parseResidentArgs([...BASE, '--mem-sample=/abs/mem.ndjson'], 'qianmo'),
    ).toMatchObject({
      memSample: '/abs/mem.ndjson',
      memIntervalMs: DEFAULT_RESIDENT_MEM_INTERVAL_MS,
    })
    expect(
      parseResidentArgs(
        [
          ...BASE,
          '--mem-sample',
          '/abs/mem.ndjson',
          '--mem-interval-ms',
          '5000',
        ],
        'qianmo',
      ),
    ).toMatchObject({ memSample: '/abs/mem.ndjson', memIntervalMs: 5_000 })
  })

  test('refuses memory sampling options that would silently lose evidence', () => {
    // Same shape as `--timings`: a relative path would land somewhere that
    // depends on the resident's cwd, which is not where the operator looked.
    expect(() =>
      parseResidentArgs([...BASE, '--mem-sample=relative.ndjson'], 'qianmo'),
    ).toThrow('absolute path')
    // An interval with no path samples into nowhere.
    expect(() =>
      parseResidentArgs([...BASE, '--mem-interval-ms=5000'], 'qianmo'),
    ).toThrow('requires --mem-sample')
    // Sub-second sampling of a 24 h run is a way to fill a disk, not a baseline.
    expect(() =>
      parseResidentArgs(
        [...BASE, '--mem-sample=/abs/mem.ndjson', '--mem-interval-ms=500'],
        'qianmo',
      ),
    ).toThrow('integer >= 1000')
  })

  test('bounds memory samples on the same queue and reports overflow once', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'resident-mem-overflow-'))
    const path = join(directory, 'mem.ndjson')
    const errors: unknown[] = []
    const writer = createResidentMemWriter(path, error => errors.push(error))
    try {
      for (let at = 0; at < MAX_PENDING_TIMING_EVENTS + 10; at++) {
        writer.write({
          at,
          rss: 1,
          heapSize: 1,
          heapCapacity: 1,
          objectCount: 1,
          uptime: 1,
        })
      }

      await writer.close()

      expect(readFileSync(path, 'utf8').trim().split('\n')).toHaveLength(
        MAX_PENDING_TIMING_EVENTS,
      )
      // Its own message, so a reader of the log knows which writer overflowed.
      expect(errors.map(String)).toEqual([
        'Error: resident memory writer queue overflow',
      ])
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('flushes timing evidence in order on close', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'resident-timing-writer-'))
    const path = join(directory, 'timings.jsonl')
    const errors: unknown[] = []
    const writer = createResidentTimingWriter(path, error => errors.push(error))
    try {
      writer.write({
        stage: 'acp_ready',
        at: 1,
        sessionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      })
      writer.write({
        stage: 'acp_ready',
        at: 2,
        sessionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      })

      await writer.close()

      expect(
        readFileSync(path, 'utf8')
          .trim()
          .split('\n')
          .map(line => JSON.parse(line).at),
      ).toEqual([1, 2])
      expect(errors).toEqual([])
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('bounds timing evidence queued in one turn and reports overflow once', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'resident-timing-overflow-'))
    const path = join(directory, 'timings.jsonl')
    const errors: unknown[] = []
    const writer = createResidentTimingWriter(path, error => errors.push(error))
    try {
      for (let at = 0; at < MAX_PENDING_TIMING_EVENTS + 10; at++) {
        writer.write({
          stage: 'acp_ready',
          at,
          sessionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
        })
      }

      await writer.close()

      expect(readFileSync(path, 'utf8').trim().split('\n')).toHaveLength(
        MAX_PENDING_TIMING_EVENTS,
      )
      expect(errors.map(String)).toEqual([
        'Error: resident timing writer queue overflow',
      ])
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

describe('capability flags (P4.3)', () => {
  const KEY = 'A'.repeat(43)

  test('--trust takes <node>=<publicKey> and refuses anything else', () => {
    const parsed = parseResidentArgs(
      [...BASE, '--trust', `node-a=${KEY}`],
      'qianmo',
    )
    expect(parsed.trusted).toEqual([['node-a', KEY]])
    expect(() =>
      parseResidentArgs([...BASE, '--trust', 'node-a'], 'qianmo'),
    ).toThrow('<node>=<publicKey>')
    expect(() =>
      parseResidentArgs([...BASE, '--trust', 'node-a=short'], 'qianmo'),
    ).toThrow('not a valid Ed25519 key')
  })

  test('--require-signed-tasks is off unless asked for', () => {
    expect(parseResidentArgs(BASE, 'qianmo').requireSignedTasks).toBe(false)
    expect(
      parseResidentArgs([...BASE, '--require-signed-tasks'], 'qianmo')
        .requireSignedTasks,
    ).toBe(true)
  })
})

describe('backup flags (P4.4)', () => {
  test('--backup-url must be http(s), and the interval needs it', () => {
    expect(
      parseResidentArgs(
        [...BASE, '--backup-url', 'http://127.0.0.1:7999'],
        'qianmo',
      ).backupUrl,
    ).toBe('http://127.0.0.1:7999/')
    expect(() =>
      parseResidentArgs([...BASE, '--backup-url', 'ws://x'], 'qianmo'),
    ).toThrow('must use http or https')
    expect(() =>
      parseResidentArgs([...BASE, '--backup-interval-ms', '60000'], 'qianmo'),
    ).toThrow('requires --backup-url')
  })

  test('a sub-second snapshot interval is refused', () => {
    // Archiving a workspace every 100 ms is not a backup policy, it is a way
    // to keep the disk busy.
    expect(() =>
      parseResidentArgs(
        [
          ...BASE,
          '--backup-url',
          'http://127.0.0.1:1',
          '--backup-interval-ms',
          '100',
        ],
        'qianmo',
      ),
    ).toThrow('>= 1000')
  })
})

describe('empty option values', () => {
  // `--port=` used to reach `Number('')`, which is 0 — a valid request for an
  // ephemeral port. The node came up on a port the operator never chose and
  // could not read off the command they typed. Every numeric flag here shares
  // the shape, so the guard lives in residentOptionValue and these cases pin
  // both spellings of the empty value.
  test('--port= is refused rather than parsed as port 0', () => {
    expect(() => parseResidentArgs([...BASE, '--port='], 'qianmo')).toThrow(
      '--port requires a value',
    )
  })

  test('an empty value after a space is refused too', () => {
    expect(() => parseResidentArgs([...BASE, '--port', ''], 'qianmo')).toThrow(
      '--port requires a value',
    )
  })

  test('a real port still parses', () => {
    const config = parseResidentArgs(
      [...BASE, '--port=38620', '--hostname=127.0.0.1'],
      'qianmo',
    )
    expect(config.port).toBe(38620)
  })

  test('--team= is refused (the guard is not numeric-only)', () => {
    expect(() =>
      parseResidentArgs(
        ['--node', 'node-a', '--team=', '--agent', 'planner=/tmp/x'],
        'qianmo',
      ),
    ).toThrow('--team requires a value')
  })
})

describe('resident --help', () => {
  test('observation mode is a second switch, not a mode of the first (§9.2 ①)', () => {
    // 「拿指令进来」和「把数据发出去」是两件事，这条也一样：能不能用它把切换的
    // 代价量出来，取决于它**不是**强制开关的一档。
    const observing = parseResidentArgs(
      [...BASE, '--audit-signed-tasks'],
      'qianmo',
    )
    expect(observing.auditSignedTasks).toBe(true)
    expect(observing.requireSignedTasks).toBe(false)

    const enforcing = parseResidentArgs(
      [...BASE, '--require-signed-tasks'],
      'qianmo',
    )
    expect(enforcing.requireSignedTasks).toBe(true)
    expect(enforcing.auditSignedTasks).toBe(false)

    const both = parseResidentArgs(
      [...BASE, '--require-signed-tasks', '--audit-signed-tasks'],
      'qianmo',
    )
    expect(both.requireSignedTasks).toBe(true)
    expect(both.auditSignedTasks).toBe(true)
  })

  test('answers --help and -h wherever they appear on the line', () => {
    // 「敲到一半发现忘了选项名」是人真会做的事，所以位置不限。
    expect(isResidentHelpRequest(['--help'])).toBe(true)
    expect(isResidentHelpRequest(['-h'])).toBe(true)
    expect(isResidentHelpRequest([...BASE, '--help'])).toBe(true)
    expect(isResidentHelpRequest(BASE)).toBe(false)
    expect(isResidentHelpRequest([])).toBe(false)
    // 当成某个选项的值写进去的不算——那是一个值，不是一次请求。
    expect(isResidentHelpRequest(['--team=--help'])).toBe(false)
  })

  test('documents every option the parser actually dispatches on', () => {
    // 反漂移：选项名的唯一出处是解析器的分派链，帮助文本是它的投影。新增一个
    // 选项却忘了写进帮助，这条会红——而不是等到内测用户问「还有别的参数吗」。
    const source = readFileSync(
      new URL('../resident.ts', import.meta.url),
      'utf8',
    )
    const dispatched = [...source.matchAll(/arg === '(--[a-z-]+)'/g)].map(
      match => match[1] as string,
    )
    // 分派链的形状变了（比如改成表驱动）也要在这里被发现，否则这条测试会安静
    // 地变成一个零断言的空转。15 个解析选项加 `--help` 自己那一次全等比较。
    expect(dispatched.length).toBeGreaterThanOrEqual(16)
    for (const option of new Set(dispatched)) {
      expect(RESIDENT_HELP_TEXT).toContain(option)
    }
  })

  test('spells out the three constraints the parser enforces after the loop', () => {
    // 这三条不是「选项存在与否」，而是「怎么组合才起得来」，撞上去只会拿到一条
    // 单句错误；帮助是唯一能一次说全的地方。
    expect(RESIDENT_HELP_TEXT).toContain('exactly one of --port and --unix')
    expect(RESIDENT_HELP_TEXT).toContain('only valid with --port')
    expect(RESIDENT_HELP_TEXT).toContain('Every path above must be absolute')
    expect(RESIDENT_HELP_TEXT).toContain('Requires --backup-url')
    expect(RESIDENT_HELP_TEXT).toContain('Requires --activity-url')
    expect(RESIDENT_HELP_TEXT).toContain('Requires --mem-sample')
  })

  test('names the identity and the two credentials it refuses to run without', () => {
    // 问「这个命令怎么用」的人恰恰是还没配好身份与密钥的那个人。
    expect(RESIDENT_HELP_TEXT).toContain('OCC_IDENTITY')
    expect(RESIDENT_HELP_TEXT).toContain('qianmo')
    expect(RESIDENT_HELP_TEXT).toContain('QIANMO_TRANSPORT_PSK')
    // 两枚密钥都只走环境变量，而帮助必须把「为什么不给命令行选项」一起说。
    expect(RESIDENT_HELP_TEXT).toContain('QIANMO_BACKUP_WRITE_TOKEN')
    expect(RESIDENT_HELP_TEXT).toContain('process listing')
    expect(RESIDENT_HELP_TEXT.endsWith('\n')).toBe(true)
  })

  test('quotes the defaults instead of copying the numbers', () => {
    // 默认值的出处是各自的常量；帮助里出现的必须是插值的结果。
    expect(RESIDENT_HELP_TEXT).toContain(
      `Default ${DEFAULT_RESIDENT_MEM_INTERVAL_MS}`,
    )
  })

  test('the unknown-option error points at the help', () => {
    // 走到那一支的人多半是拼错了选项名，所以顺手指一下那张表在哪。
    expect(() => parseResidentArgs([...BASE, '--noed=x'], 'qianmo')).toThrow(
      'unknown resident option --noed=x',
    )
    expect(() => parseResidentArgs([...BASE, '--noed=x'], 'qianmo')).toThrow(
      'resident --help',
    )
  })
})
