// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 动作账本的宿主面（P15.9）：真文件、真 `Bun.serve`、只用 HTTP 驱动。
 *
 * **零 `mock.module`**。包内用例用内存文件判规矩，这里判包内判不到的几件事：
 * 落盘的权限位与符号链接、文件指纹真能看见盘上的改动、`--verify-actions` 的
 * 四态与退出码、一个开着账号的真控制台写下的账本里没有任何凭据或正文，以及与
 * P14 的契约——节点链上的决定事件能按 `requestId` 找到控制台这边是谁提交的。
 */

import { afterAll, describe, expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import {
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { AuditSource, AuditTrail, readTrail } from '@qianmo/audit'
import {
  generateNodeKeyPair,
  parseApprover,
  parseAuthzDecision,
  signAuthzDecision,
  type AuthzDecision,
  type AuthzDecisionKind,
} from '@qianmo/capability'
import {
  AUTHZ_DECISION_ACTION_PREFIX,
  AccountBook,
  startConsoleServer,
  type ChatPort,
  type ChatSession,
  type ChatTurn,
  type ChatUpdate,
  type ConsoleDeps,
  type ConsoleResult,
  type ConsoleServerHandle,
} from '@qianmo/console'
import { FileLedger } from '../consoleAccountsStore.js'
import {
  FileActionLedger,
  openConsoleActionLedger,
  runActionLedgerVerify,
} from '../consoleActionLedger.js'
import { consoleActionsPath, parseConsoleArgs } from '../consoleArgs.js'
import { consoleLimits } from '../consolePorts.js'

const roots: string[] = []
const servers: ConsoleServerHandle[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'qianmo-actions-'))
  roots.push(dir)
  return dir
}

afterAll(async () => {
  for (const server of servers) await server.stop()
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

const TOKENS = {
  view: 'view-token-000000000001',
  admin: 'admin-token-00000000001',
}
const ADDRESS = 'qianmo://tokyo-1/planner'
const NOW = 1_700_000_000_000

function quietAlarms(): { readonly lines: string[]; sink(line: string): void } {
  const lines: string[] = []
  return {
    lines,
    sink: line => {
      lines.push(line)
    },
  }
}

function action(over: Record<string, unknown> = {}) {
  return {
    at: NOW,
    requestId: 'r-1',
    subject: 'legacy:admin',
    action: 'agent.heartbeat',
    target: ADDRESS,
    outcome: 'ok' as const,
    ...over,
  }
}

/** Run `--verify-actions` on a path; the exit code and the JSON it printed. */
function verify(path: string): {
  readonly code: number
  readonly summary: Record<string, unknown>
} {
  let out = ''
  const code = runActionLedgerVerify(path, text => {
    out += text
  })
  return { code, summary: JSON.parse(out) as Record<string, unknown> }
}

describe('the ledger file', () => {
  test('0600 in a 0700 directory, with its header from the first moment', () => {
    const path = join(tempDir(), 'qianmo', 'console', 'actions.ndjson')
    const ledger = openConsoleActionLedger({ path, secrets: [] })
    expect(ledger.problem).toBeNull()
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(statSync(join(path, '..')).mode & 0o777).toBe(0o700)
    expect(verify(path)).toEqual({
      code: 0,
      summary: { path, chain: 'empty', actions: 0, intact: true },
    })
  })

  test('the stamp moves with a write and with an edit from outside, not with a read', async () => {
    const path = join(tempDir(), 'actions.ndjson')
    const store = new FileActionLedger(path)
    expect(store.stamp()).toBeNull()
    const ledger = openConsoleActionLedger({ path, secrets: [] })
    const first = store.stamp()
    store.read()
    expect(store.stamp()).toBe(first)
    await ledger.record(action())
    const second = store.stamp()
    expect(second).not.toBe(first)
    // An edit that changes the size.
    const text = readFileSync(path, 'utf8')
    writeFileSync(path, text.replace('"ok"', '"okay"'))
    const third = store.stamp()
    expect(third).not.toBe(second)
    // The same bytes put back as another file: the inode gives it away.
    // (A same-size edit in place is seen through the modification time, which
    // only moves once per filesystem clock tick — a few milliseconds on Linux —
    // so this suite does not lean on it; `list` and `--verify-actions` read
    // the content and catch that one regardless.)
    const copy = `${path}.copy`
    writeFileSync(copy, readFileSync(path))
    renameSync(copy, path)
    expect(store.stamp()).not.toBe(third)
  })

  test('a symbolic link is not followed, and the ledger closes on it', () => {
    const dir = tempDir()
    const target = join(dir, 'elsewhere.ndjson')
    writeFileSync(target, '')
    const path = join(dir, 'actions.ndjson')
    symlinkSync(target, path)
    expect(new FileActionLedger(path).stamp()).toBe('symlink')
    const alarms = quietAlarms()
    const ledger = openConsoleActionLedger({
      path,
      secrets: [],
      onAlarm: alarms.sink,
    })
    expect(ledger.problem).not.toBeNull()
    expect(alarms.lines).toHaveLength(1)
    expect(readFileSync(target, 'utf8')).toBe('')
    expect(verify(path).code).toBe(1)
  })

  test('an edit on disk under a running console closes it before the next write', async () => {
    const path = join(tempDir(), 'actions.ndjson')
    const alarms = quietAlarms()
    const ledger = openConsoleActionLedger({
      path,
      secrets: [],
      onAlarm: alarms.sink,
    })
    for (let i = 1; i <= 3; i++) {
      await ledger.record(action({ requestId: `r-${i}`, target: `t-${i}` }))
    }
    expect((await ledger.admit()).ok).toBe(true)
    writeFileSync(path, readFileSync(path, 'utf8').replace('"t-2"', '"t-20"'))
    const before = readFileSync(path, 'utf8')
    expect((await ledger.admit()).ok).toBe(false)
    expect((await ledger.list({})).ok).toBe(false)
    expect((await ledger.record(action({ requestId: 'r-4' }))).ok).toBe(false)
    expect(readFileSync(path, 'utf8')).toBe(before)
    expect(ledger.problem).toContain('第 4 行：哈希链断开')
    expect(alarms.lines[0]).toContain(path)
  })
})

describe('a ledger file swapped under a running console', () => {
  test('the same bytes as another file still close it: the writes would go nowhere', async () => {
    const path = join(tempDir(), 'actions.ndjson')
    const alarms = quietAlarms()
    const ledger = openConsoleActionLedger({
      path,
      secrets: [],
      onAlarm: alarms.sink,
    })
    await ledger.record(action())
    const copy = `${path}.copy`
    writeFileSync(copy, readFileSync(path))
    renameSync(copy, path)
    const before = readFileSync(path, 'utf8')
    expect((await ledger.admit()).ok).toBe(false)
    expect((await ledger.record(action({ requestId: 'r-2' }))).ok).toBe(false)
    expect(ledger.problem).toContain('文件被换掉了')
    expect(readFileSync(path, 'utf8')).toBe(before)
  })

  test('deleted: closed, not quietly writing into an unlinked file', async () => {
    const path = join(tempDir(), 'actions.ndjson')
    const ledger = openConsoleActionLedger({ path, secrets: [] })
    await ledger.record(action())
    rmSync(path)
    expect((await ledger.admit()).ok).toBe(false)
    expect(ledger.problem).not.toBeNull()
  })
})

describe('--verify-actions', () => {
  test('absent, empty and intact exit 0; broken and unreadable exit 1', async () => {
    const dir = tempDir()
    const path = join(dir, 'actions.ndjson')
    expect(verify(path)).toEqual({
      code: 0,
      summary: { path, chain: 'absent', actions: 0, intact: false },
    })
    const ledger = openConsoleActionLedger({ path, secrets: [] })
    expect(verify(path).summary['chain']).toBe('empty')
    await ledger.record(action())
    await ledger.record(action({ requestId: 'r-2' }))
    expect(verify(path)).toEqual({
      code: 0,
      summary: { path, chain: 'intact', actions: 2, intact: true },
    })

    writeFileSync(path, readFileSync(path, 'utf8').replace('"r-1"', '"r-9"'))
    expect(verify(path)).toEqual({
      code: 1,
      summary: {
        path,
        chain: 'broken',
        actions: 0,
        issue: { line: 3, reason: '哈希链断开' },
        intact: false,
      },
    })

    const link = join(dir, 'link.ndjson')
    symlinkSync(path, link)
    const unreadable = verify(link)
    expect(unreadable.code).toBe(1)
    expect(unreadable.summary['chain']).toBe('broken')
    expect(String(unreadable.summary['issue'] ?? '')).not.toBe('')
  })

  test('a ledger pointed at the account book by mistake is broken, not empty', () => {
    const dir = tempDir()
    const accounts = join(dir, 'accounts.ndjson')
    const book = new AccountBook({
      accounts: new FileLedger(accounts),
      sessions: new FileLedger(join(dir, 'sessions.ndjson')),
    })
    expect(book.problem).toBeNull()
    const result = verify(accounts)
    expect(result.code).toBe(1)
    expect(result.summary['issue']).toEqual({
      line: 1,
      reason: '账名不对：这不是动作账本',
    })
  })
})

// --- `qm console` itself, in a child process -----------------------------------

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..', '..')

/**
 * `runConsole` with these arguments under the qianmo identity and a config
 * root of its own. The identity is fixed when the process starts
 * (`src/constants/identity.ts`), which is why this is a child and not a call.
 */
function consoleChild(configRoot: string, args: readonly string[]) {
  return Bun.spawn(
    [
      'bun',
      '-e',
      "const { runConsole } = await import('./src/cli/handlers/console.ts');" +
        " await runConsole(JSON.parse(process.env.QM_TEST_ARGS ?? '[]'))",
    ],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        OCC_IDENTITY: 'qianmo',
        OCC_CONFIG_DIR: configRoot,
        QM_TEST_ARGS: JSON.stringify(args),
      },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )
}

describe('qm console, end to end', () => {
  test('--verify-actions answers with the exit code a cron job reads', async () => {
    const root = tempDir()
    const path = join(root, 'qianmo', 'console', 'actions.ndjson')
    const absent = consoleChild(root, ['--verify-actions'])
    expect(await absent.exited).toBe(0)
    expect(JSON.parse(await new Response(absent.stdout).text())).toMatchObject({
      path,
      chain: 'absent',
    })

    const ledger = openConsoleActionLedger({ path, secrets: [] })
    await ledger.record(action())
    const intact = consoleChild(root, ['--verify-actions'])
    expect(await intact.exited).toBe(0)

    writeFileSync(path, readFileSync(path, 'utf8').replace('"ok"', '"no"'))
    const broken = consoleChild(root, ['--verify-actions'])
    expect(await broken.exited).toBe(1)
    expect(JSON.parse(await new Response(broken.stdout).text())).toMatchObject({
      chain: 'broken',
      intact: false,
    })
  }, 60_000)

  test('--accounts wires the ledger: the file is there and the banner says where', async () => {
    const root = tempDir()
    const child = consoleChild(root, ['--accounts', '--port', '0'])
    const reader = child.stdout.getReader()
    const decoder = new TextDecoder()
    let banner = ''
    try {
      while (!banner.includes('sourceCommit')) {
        const chunk = await reader.read()
        if (chunk.done) break
        banner += decoder.decode(chunk.value)
      }
    } finally {
      child.kill()
      await child.exited
    }
    const path = join(root, 'qianmo', 'console', 'actions.ndjson')
    expect(banner).toContain(`actions      enabled -> ${path}`)
    expect(verify(path).summary['chain']).toBe('empty')
  }, 60_000)

  test('without --accounts there is no ledger and no line about one', async () => {
    const root = tempDir()
    const child = consoleChild(root, ['--port', '0'])
    const reader = child.stdout.getReader()
    const decoder = new TextDecoder()
    let banner = ''
    try {
      while (!banner.includes('sourceCommit')) {
        const chunk = await reader.read()
        if (chunk.done) break
        banner += decoder.decode(chunk.value)
      }
    } finally {
      child.kill()
      await child.exited
    }
    expect(banner).toContain('sourceCommit')
    expect(banner.includes('actions ')).toBe(false)
    expect(
      verify(join(root, 'qianmo', 'console', 'actions.ndjson')).summary[
        'chain'
      ],
    ).toBe('absent')
  }, 60_000)
})

describe('the flags', () => {
  test('off by default; the parsed config keeps its old shape', () => {
    const config = parseConsoleArgs([], 'qianmo')
    expect('actionsStorePath' in config).toBe(false)
    expect('verifyActions' in config).toBe(false)
  })

  test('on with --accounts, at a path derived from the config root', () => {
    const config = parseConsoleArgs(['--accounts'], 'qianmo')
    expect(config.actionsStorePath).toBe(consoleActionsPath())
    expect(
      consoleActionsPath().endsWith(
        join('qianmo', 'console', 'actions.ndjson'),
      ),
    ).toBe(true)
    expect(
      parseConsoleArgs(
        ['--accounts', '--actions-store=/tmp/actions.ndjson'],
        'qianmo',
      ).actionsStorePath,
    ).toBe('/tmp/actions.ndjson')
  })

  test('--verify-actions stands alone; --actions-store needs one of the two', () => {
    const verifyOnly = parseConsoleArgs(['--verify-actions'], 'qianmo')
    expect(verifyOnly.verifyActions).toBe(true)
    expect(verifyOnly.actionsStorePath).toBe(consoleActionsPath())
    expect('accounts' in verifyOnly).toBe(false)
    expect(
      parseConsoleArgs(
        ['--verify-actions', '--actions-store', '/tmp/a.ndjson'],
        'qianmo',
      ).actionsStorePath,
    ).toBe('/tmp/a.ndjson')
    expect(() =>
      parseConsoleArgs(['--actions-store', '/tmp/a.ndjson'], 'qianmo'),
    ).toThrow('--actions-store needs --accounts or --verify-actions')
    expect(() =>
      parseConsoleArgs(
        ['--accounts', '--actions-store', 'rel.ndjson'],
        'qianmo',
      ),
    ).toThrow('absolute')
  })
})

// --- a real console ------------------------------------------------------------

function ok<T>(value: T): ConsoleResult<T> {
  return { ok: true, value }
}

/** Sessions in memory, the shape the console's chat routes need. */
class MemoryChat implements ChatPort {
  readonly sessionsById = new Map<string, ChatSession>()
  readonly listeners = new Set<(update: ChatUpdate) => void>()
  #next = 0

  targets() {
    return Promise.resolve(
      ok([
        {
          address: ADDRESS,
          node: 'tokyo-1',
          agent: 'planner',
          endpoint: 'ws://127.0.0.1:38611/',
          status: 'online',
          dialable: true,
        },
      ]),
    )
  }
  sessions() {
    return Promise.resolve(ok([...this.sessionsById.values()]))
  }
  open(target: string) {
    this.#next += 1
    const session: ChatSession = {
      id: `session-${this.#next}`,
      target,
      node: 'tokyo-1',
      agent: 'planner',
      createdAt: NOW,
      updatedAt: NOW,
      turnCount: 0,
      preview: '',
    }
    this.sessionsById.set(session.id, session)
    return Promise.resolve(ok(session))
  }
  transcript(sessionId: string) {
    const session = this.sessionsById.get(sessionId)
    return Promise.resolve(
      session === undefined
        ? {
            ok: false as const,
            failure: { code: 'not_found' as const, message: 'no such session' },
          }
        : ok({ session, turns: [] }),
    )
  }
  send(input: { readonly sessionId: string; readonly text: string }) {
    const turn: ChatTurn = {
      id: 'turn-1',
      sessionId: input.sessionId,
      author: 'operator',
      at: NOW,
      text: input.text,
      state: 'pending',
    }
    return Promise.resolve(ok(turn))
  }
  subscribe(listener: (update: ChatUpdate) => void) {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
}

function deps(chat: ChatPort): ConsoleDeps {
  return {
    registry: {
      list: () => Promise.resolve(ok([])),
      register: () =>
        Promise.resolve({
          ok: false,
          failure: { code: 'unsupported', message: 'not here' },
        }),
      deregister: () => Promise.resolve(ok(undefined)),
      heartbeat: () =>
        Promise.resolve({
          ok: false,
          failure: { code: 'unsupported', message: 'not here' },
        }),
    },
    audit: {
      read: () =>
        Promise.resolve(
          ok({
            records: [],
            chain: 'empty' as const,
            intact: true,
            issueCount: 0,
            total: 0,
          }),
        ),
      chain: () => Promise.resolve(ok(null)),
    },
    limits: consoleLimits(),
    label: 'actions-host',
    chat,
  }
}

const SAME_ORIGIN = {
  'content-type': 'application/x-www-form-urlencoded',
  'sec-fetch-site': 'same-origin',
}

describe('a console with accounts, over HTTP only, against real files', () => {
  test('one opening of somebody’s transcript is one line, and no secret or text is on disk', async () => {
    const root = tempDir()
    const dir = join(root, 'qianmo', 'console')
    const actionsPath = join(dir, 'actions.ndjson')
    const book = new AccountBook({
      accounts: new FileLedger(join(dir, 'accounts.ndjson')),
      sessions: new FileLedger(join(dir, 'sessions.ndjson')),
    })
    const actions = openConsoleActionLedger({
      path: actionsPath,
      secrets: [TOKENS.view, TOKENS.admin],
    })
    const server = startConsoleServer(
      { ...deps(new MemoryChat()), actions },
      0,
      {
        tokens: TOKENS,
        accounts: { book, breakGlass: true },
      },
    )
    servers.push(server)
    const admin = { authorization: `Bearer ${TOKENS.admin}` }

    /** Invite as the admin token, redeem in a "browser". */
    const signUp = async (role: 'member' | 'ops') => {
      const issued = await fetch(`${server.url}/v0/accounts/invites`, {
        method: 'POST',
        headers: { ...admin, 'content-type': 'application/json' },
        body: JSON.stringify({ role }),
      })
      const { link } = (await issued.json()) as { link: string }
      const redeemed = await fetch(`${server.url}/invite`, {
        method: 'POST',
        headers: SAME_ORIGIN,
        body: new URLSearchParams({
          invite: link.slice(link.indexOf('#') + 1),
        }).toString(),
      })
      const page = await redeemed.text()
      const credential =
        /id="credential"[^>]*value="([^"]+)"/.exec(page)?.[1] ?? ''
      const sid =
        redeemed.headers
          .getSetCookie()
          .find(line => line.startsWith('qianmo_session='))
          ?.slice('qianmo_session='.length)
          .split(';')[0] ?? ''
      expect(credential.startsWith('qmu_')).toBe(true)
      expect(sid.startsWith('qms_')).toBe(true)
      return { credential, sid }
    }
    const member = await signUp('member')
    const ops = await signUp('ops')
    const as = (sid: string, extra: Record<string, string> = {}) => ({
      cookie: `qianmo_session=${sid}`,
      'x-qianmo-console': '1',
      ...extra,
    })

    // The member opens a conversation and says something private in it.
    const PRIVATE = '只给我自己看的一句话 canary-5d1e'
    const opened = await fetch(`${server.url}/v0/chat/sessions`, {
      method: 'POST',
      headers: as(member.sid, { 'content-type': 'application/json' }),
      body: JSON.stringify({ target: ADDRESS }),
    })
    expect(opened.status).toBe(200)
    const { id } = (await opened.json()) as { id: string }
    const sent = await fetch(`${server.url}/v0/chat/sessions/${id}/messages`, {
      method: 'POST',
      headers: as(member.sid, { 'content-type': 'application/json' }),
      body: JSON.stringify({ text: PRIVATE }),
    })
    expect(sent.status).toBe(200)

    // Ops opens it once, and the page polls it a hundred times.
    const page = await fetch(`${server.url}/chat?session=${id}`, {
      headers: { cookie: `qianmo_session=${ops.sid}`, accept: 'text/html' },
    })
    expect(page.status).toBe(200)
    for (let i = 0; i < 100; i++) {
      const poll = await fetch(`${server.url}/fragments/chat/thread/${id}`, {
        headers: as(ops.sid),
      })
      expect(poll.status).toBe(200)
    }

    const lines = readFileSync(actionsPath, 'utf8')
      .trimEnd()
      .split('\n')
      .map(
        line =>
          JSON.parse(line) as { kind: string; data: Record<string, unknown> },
      )
    const readings = lines.filter(line => line.kind === 'chat.transcript.open')
    expect(readings).toHaveLength(1)
    expect(readings[0]?.data['target']).toBe(id)
    expect(String(readings[0]?.data['subject'])).toMatch(/^u:[0-9a-f]{16}$/)
    expect(readings[0]?.data['subject']).not.toBe(
      lines.find(line => line.kind === 'chat.session.open')?.data['subject'],
    )
    // Every admin-token request is a break-glass line, reads included.
    expect(
      lines.filter(line => line.kind === 'breakglass.request').length,
    ).toBeGreaterThanOrEqual(2)

    // Nothing that opens anything, and nothing anybody said.
    const disk = readFileSync(actionsPath, 'utf8')
    for (const secret of [
      TOKENS.admin,
      TOKENS.view,
      member.credential,
      member.sid,
      ops.credential,
      ops.sid,
      PRIVATE,
    ]) {
      expect(disk.includes(secret)).toBe(false)
    }
    expect(verify(actionsPath).code).toBe(0)

    // An edit on disk: the next write is turned away, the check says so.
    writeFileSync(actionsPath, disk.replace(id, `${id}-edited`))
    const refused = await fetch(
      `${server.url}/v0/chat/sessions/${id}/messages`,
      {
        method: 'POST',
        headers: as(member.sid, { 'content-type': 'application/json' }),
        body: JSON.stringify({ text: 'again' }),
      },
    )
    expect(refused.status).toBe(503)
    expect(verify(actionsPath).code).toBe(1)
  })
})

// --- the P14 contract ----------------------------------------------------------

/**
 * `tenancy-m1.md` §3.5「账本分工」与 `authorization-m1.md` §3.3：节点审计链是
 * 授权判决的权威记录，控制台动作账本记「主体对 requestId 提交了决定」，两边以
 * `requestId` 关联、不另开账本。
 *
 * 节点链上那一行的字段名（`detail.requestId`、`detail.approver`）按
 * `authorization-m1.md` §5 的报表字段推定——P14.4 落链之前仓库里还没有写它的
 * 代码；它真落下时若换了字段，改这里的构造即可，契约本身（requestId 原样、
 * 审批人 = `<console>/<subject>`）不变。
 */
describe('P14 decisions join the node chain on requestId', () => {
  const KINDS: readonly AuthzDecisionKind[] = [
    'allow-once',
    'allow-window',
    'deny',
  ]

  function decision(kind: AuthzDecisionKind, approver: string): AuthzDecision {
    return {
      v: 1,
      requestId: randomBytes(16).toString('hex'),
      aud: 'tokyo-1',
      sub: ADDRESS,
      digest: randomBytes(32).toString('hex'),
      decision: kind,
      windowMs: kind === 'allow-window' ? 60_000 : 0,
      approver,
      nbf: NOW,
      exp: NOW + 60_000,
      nonce: randomBytes(8).toString('hex'),
    }
  }

  test('every decision the console submitted is found from the node’s record, and nothing else is', async () => {
    const dir = tempDir()
    const ledger = openConsoleActionLedger({
      path: join(dir, 'actions.ndjson'),
      secrets: [],
    })
    const nodeTrail = new AuditTrail(join(dir, 'node-trail.ndjson'))
    const consoleKeys = generateNodeKeyPair()
    const people = ['u:0123456789abcdef', 'u:fedcba9876543210'] as const

    const submitted: AuthzDecision[] = []
    for (const [index, kind] of KINDS.entries()) {
      const subject = people[index % people.length] ?? people[0]
      // What the node receives: a signed decision, parsed the node's way.
      const wire = signAuthzDecision(
        consoleKeys,
        decision(kind, `console/${subject}`),
      )
      const received = parseAuthzDecision(wire)
      if (received === null) throw new Error('decision did not parse')
      submitted.push(received.value)

      // The console's half: who submitted it, against the node's request id.
      const recorded = await ledger.record({
        at: NOW + index,
        requestId: crypto.randomUUID(),
        subject,
        action: `${AUTHZ_DECISION_ACTION_PREFIX}${received.value.decision}`,
        target: received.value.requestId,
        outcome: 'ok',
      })
      expect(recorded.ok).toBe(true)
      // Noise around it: readings and other actions on the same ledger.
      await ledger.record({
        at: NOW + index,
        requestId: crypto.randomUUID(),
        subject,
        action: 'chat.transcript.open',
        target: received.value.requestId,
        outcome: 'ok',
      })

      // The node's half: the verdict on its own chain.
      nodeTrail.append({
        at: NOW + index,
        source: AuditSource.Capability,
        kind: kind === 'deny' ? 'authz.denied' : 'authz.approved',
        node: 'tokyo-1',
        outcome: kind === 'deny' ? 'refused' : 'ok',
        detail: {
          requestId: received.value.requestId,
          approver: received.value.approver,
          decision: kind,
        },
      })
    }
    // A request the node decided with no console involved (expired).
    const orphan = randomBytes(16).toString('hex')
    nodeTrail.append({
      at: NOW + 9,
      source: AuditSource.Capability,
      kind: 'authz.expired',
      node: 'tokyo-1',
      outcome: 'refused',
      detail: { requestId: orphan },
    })
    nodeTrail.close()

    const chain = readTrail(join(dir, 'node-trail.ndjson'))
    expect(chain.intact).toBe(true)
    let joined = 0
    for (const record of chain.records) {
      const requestId = record.detail?.['requestId']
      if (typeof requestId !== 'string') continue
      const page = await ledger.list({
        targets: [requestId],
        actionPrefix: AUTHZ_DECISION_ACTION_PREFIX,
      })
      if (!page.ok) throw new Error('list failed')
      if (requestId === orphan) {
        expect(page.value.entries).toEqual([])
        continue
      }
      expect(page.value.entries).toHaveLength(1)
      const entry = page.value.entries[0]
      const approver = parseApprover(record.detail?.['approver'])
      if (!approver.ok || entry === undefined) throw new Error('no approver')
      expect(entry.subject).toBe(approver.subject)
      expect(entry.action).toBe(
        `${AUTHZ_DECISION_ACTION_PREFIX}${String(record.detail?.['decision'])}`,
      )
      expect(entry.target).toBe(requestId)
      joined += 1
    }
    expect(joined).toBe(KINDS.length)
    expect(submitted.map(d => d.requestId)).toHaveLength(KINDS.length)
  })

  test('a request id survives the ledger verbatim: no cleaning ever touches it', async () => {
    const ledger = openConsoleActionLedger({
      path: join(tempDir(), 'actions.ndjson'),
      secrets: [],
    })
    const requestId = randomBytes(16).toString('hex')
    await ledger.record({
      at: NOW,
      requestId: crypto.randomUUID(),
      subject: 'u:0123456789abcdef',
      action: `${AUTHZ_DECISION_ACTION_PREFIX}deny`,
      target: requestId,
      outcome: 'refused',
      code: 'approver',
    })
    const page = await ledger.list({ targets: [requestId] })
    expect(page.ok && page.value.entries.map(e => e.target)).toEqual([
      requestId,
    ])
  })
})
