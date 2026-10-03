// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * P18.19 — does a resident node send each session the same prompt head turn
 * after turn? (design `providers-console-m1.md` §5.11.7, T-1 T-2 T-3 T-8 T-9)
 *
 * A provider can only reuse a cached prefix the client sends again byte for
 * byte. On 2026-10-03 the recording stub found three ways a node stopped
 * doing that, all three now held here:
 *
 * - **switching session** (T-2): coming back to a session recomputed CLAUDE.md,
 *   the date and the git status, and the new values rewrote `input[0]` or the
 *   instructions — the latter also changed the cache key;
 * - **the git status came from the process cwd** (T-9), not the session's;
 * - **replacing the ACP child** (T-3): attachments were not in the transcript
 *   and the context was recomputed, so the resumed session's `input[0]` was
 *   different from the first byte of history on.
 *
 * Each fixed case has a negative control that turns the fix off through its
 * switch (`QIANMO_PROMPT_CONTEXT_SNAPSHOT=0`,
 * `QIANMO_PERSIST_PROMPT_ATTACHMENTS=0`) and must see the divergence — so a
 * green run is evidence the assertion can fail.
 *
 * ## What is real
 *
 * The ACP child (`src/entrypoints/cli.tsx --acp` from source, the shipped
 * defines and features, the production resident environment, via
 * `spawnResidentAcpChild`) with the fleet's model settings: Responses wire,
 * `gpt-6-luna`, effort `max`. The client sends what `ResidentAcpConnection`
 * sends and stops a child with SIGTERM, as `QianmoResident` does.
 *
 * ## What is not
 *
 * The model: `ResponsesRecorder`, a loopback double that records each request
 * body. Nothing here touches a real endpoint.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { ChildProcess } from 'node:child_process'
import { execFileSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ClientSideConnection,
  PROTOCOL_VERSION,
} from '@agentclientprotocol/sdk'
import { spawnResidentAcpChild } from './fixtures/resident-acp-harness.js'
import {
  prefixDivergence,
  type RecordedRequest,
  ResponsesRecorder,
} from './fixtures/responses-recorder.js'

const BOOT_MS = 90_000
const TURN_MS = 60_000
const EXIT_MS = 15_000
const TEST_MS = 400_000

const RESIDENT_META = { qianmo: { resident: true, agent: 'main' } }
/** UTC+14 and UTC−11: always a different local date. */
const TZ_EAST = 'Pacific/Kiritimati'
const TZ_WEST = 'Pacific/Pago_Pago'

let root: string
let recorder: ResponsesRecorder

async function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`timed out: ${what} (${ms}ms)`)),
          ms,
        )
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

function git(cwd: string, ...args: string[]): void {
  execFileSync(
    'git',
    [
      '-C',
      cwd,
      '-c',
      'user.name=p',
      '-c',
      'user.email=p@example.invalid',
      ...args,
    ],
    { stdio: 'ignore' },
  )
}

type Dirs = {
  readonly home: string
  readonly config: string
  /** The resident's own cwd, inherited by the child: a git checkout. */
  readonly proc: string
  /** The agent workspace the sessions run in: a git repo too. */
  readonly ws: string
}

function scenario(name: string): Dirs {
  const base = join(root, name)
  const dirs = {
    home: join(base, 'home'),
    config: join(base, 'config'),
    proc: join(base, 'proc'),
    ws: join(base, 'ws'),
  }
  for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true })
  git(dirs.proc, 'init', '-q')
  writeFileSync(join(dirs.proc, 'README.md'), 'process cwd\n')
  git(dirs.proc, 'add', 'README.md')
  git(dirs.proc, 'commit', '-q', '-m', 'init proc tree')
  writeFileSync(join(dirs.proc, 'proc-only.txt'), 'untracked in proc\n')
  git(dirs.ws, 'init', '-q')
  writeFileSync(join(dirs.ws, 'NOTES.md'), '# workspace\n')
  git(dirs.ws, 'add', 'NOTES.md')
  git(dirs.ws, 'commit', '-q', '-m', 'chore(beta): init workspace')
  return dirs
}

/** One `--acp` child and a resident-shaped client on its stdio. */
class Node {
  private constructor(
    private readonly child: ChildProcess,
    private readonly conn: ClientSideConnection,
    private readonly exited: Promise<unknown>,
  ) {}

  static async start(
    dirs: Dirs,
    env: Readonly<Record<string, string>>,
    tag: string,
  ): Promise<Node> {
    const { child, stream } = spawnResidentAcpChild({
      configDir: dirs.config,
      modelBaseUrl: recorder.baseUrl,
      stderrPath: join(dirs.config, `${tag}.stderr`),
      model: 'gpt-6-luna',
      wireApi: 'responses',
      cwd: dirs.proc,
      extraEnv: {
        HOME: dirs.home,
        CLAUDE_CODE_EFFORT_LEVEL: 'max',
        CLAUDE_CODE_ALWAYS_ENABLE_EFFORT: '1',
        ...env,
      },
    })
    const exited = new Promise(resolve => child.once('exit', resolve))
    const conn = new ClientSideConnection(
      () => ({
        async requestPermission() {
          return { outcome: { outcome: 'cancelled' as const } }
        },
        async sessionUpdate() {},
        async extNotification() {},
        async extMethod() {
          return {}
        },
      }),
      stream,
    )
    const node = new Node(child, conn, exited)
    await within(
      conn.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo: { name: 'qianmo-resident', version: '0' },
        _meta: { qianmo: { resident: true } },
      }),
      BOOT_MS,
      'initialize',
    )
    return node
  }

  async newSession(cwd: string): Promise<string> {
    const r = await within(
      this.conn.newSession({
        cwd,
        mcpServers: [],
        _meta: { permissionMode: 'dontAsk', ...RESIDENT_META },
      }),
      BOOT_MS,
      'session/new',
    )
    return r.sessionId
  }

  async resume(sessionId: string, cwd: string): Promise<void> {
    await within(
      this.conn.unstable_resumeSession({
        sessionId,
        cwd,
        mcpServers: [],
        _meta: { permissionMode: 'dontAsk', ...RESIDENT_META },
      }),
      BOOT_MS,
      'session/resume',
    )
  }

  /** The main-loop requests this turn sent, in order. */
  async prompt(sessionId: string, text: string): Promise<RecordedRequest[]> {
    const from = recorder.requests.length
    const r = await within(
      this.conn.prompt({ sessionId, prompt: [{ type: 'text', text }] }),
      TURN_MS,
      `prompt "${text}"`,
    )
    expect(r.stopReason).toBe('end_turn')
    const sent = recorder.mainRequests(from)
    expect(sent.length).toBeGreaterThan(0)
    return sent
  }

  /** What `QianmoResident` does to a child it is done with. */
  async terminate(): Promise<void> {
    this.child.kill('SIGTERM')
    await within(this.exited, EXIT_MS, 'exit after SIGTERM')
  }

  async dispose(): Promise<void> {
    if (this.child.exitCode === null && this.child.signalCode === null) {
      this.child.kill('SIGKILL')
      await this.exited
    }
  }
}

/** Three turns of session A, the second with one tool round trip. */
async function threeTurns(
  node: Node,
  session: string,
): Promise<RecordedRequest[]> {
  return [
    ...(await node.prompt(session, 'turn 1: say hello')),
    ...(await node.prompt(session, 'turn 2: USE_TOOL list the markdown files')),
    ...(await node.prompt(session, 'turn 3: thanks')),
  ]
}

function body(r: RecordedRequest | undefined): Record<string, unknown> {
  if (r === undefined) throw new Error('no request recorded')
  return r.body
}

/** Meanwhile, everything a session's prompt head is read from changes. */
function changeEverythingAround(dirs: Dirs): void {
  writeFileSync(
    join(dirs.ws, 'CLAUDE.md'),
    '# workspace\n\nA note added mid-session.\n',
  )
  writeFileSync(join(dirs.ws, 'report.txt'), 'written by the agent\n')
  writeFileSync(join(dirs.proc, 'deployed.txt'), 'a new build landed here\n')
}

type SwitchRun = {
  readonly a: RecordedRequest[]
  readonly b1: RecordedRequest[]
  readonly a4: RecordedRequest[]
}

/** A three turns → (changes) → new session B one turn → A again. */
async function switchScenario(
  name: string,
  env: Readonly<Record<string, string>>,
): Promise<SwitchRun> {
  const dirs = scenario(name)
  const node = await Node.start(dirs, env, name)
  try {
    const A = await node.newSession(dirs.ws)
    const a = await threeTurns(node, A)
    changeEverythingAround(dirs)
    const B = await node.newSession(dirs.ws)
    const b1 = await node.prompt(B, 'another context, turn 1')
    const a4 = await node.prompt(A, 'turn 4: back to the first context')
    return { a, b1, a4 }
  } finally {
    await node.dispose()
  }
}

type RestartRun = {
  readonly a: RecordedRequest[]
  readonly a4: RecordedRequest[]
  readonly transcript: string
}

/** A three turns → child replaced (SIGTERM), across a date line → resume → A again. */
async function restartScenario(
  name: string,
  env: Readonly<Record<string, string>>,
): Promise<RestartRun> {
  const dirs = scenario(name)
  const first = await Node.start(dirs, { ...env, TZ: TZ_EAST }, `${name}-1`)
  let A: string
  let a: RecordedRequest[]
  try {
    A = await first.newSession(dirs.ws)
    a = await threeTurns(first, A)
    await first.terminate()
  } finally {
    await first.dispose()
  }
  changeEverythingAround(dirs)
  const second = await Node.start(dirs, { ...env, TZ: TZ_WEST }, `${name}-2`)
  try {
    await second.resume(A, dirs.ws)
    const a4 = await second.prompt(
      A,
      'turn 4: after the ACP child was replaced',
    )
    await second.terminate()
    return { a, a4, transcript: readTranscript(dirs.config, A) }
  } finally {
    await second.dispose()
  }
}

function readTranscript(configDir: string, sessionId: string): string {
  const projects = join(configDir, 'projects')
  for (const dir of readdirSync(projects)) {
    try {
      return readFileSync(join(projects, dir, `${sessionId}.jsonl`), 'utf8')
    } catch {
      // not in this project dir
    }
  }
  throw new Error(`no transcript for ${sessionId}`)
}

function expectEachExtendsThePrevious(requests: RecordedRequest[]): void {
  for (let i = 1; i < requests.length; i++) {
    expect({
      pair: `#${requests[i - 1]!.seq} -> #${requests[i]!.seq}`,
      divergence: prefixDivergence(body(requests[i - 1]), body(requests[i])),
    }).toEqual({
      pair: `#${requests[i - 1]!.seq} -> #${requests[i]!.seq}`,
      divergence: null,
    })
  }
}

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'qm-prompt-cache-')))
  recorder = new ResponsesRecorder()
})

afterAll(async () => {
  await recorder?.stop()
  if (root) rmSync(root, { recursive: true, force: true })
})

describe("P18.19: switching sessions keeps each session's prompt head", () => {
  let on: SwitchRun
  let off: SwitchRun

  beforeAll(async () => {
    on = await switchScenario('switch-on', {})
    off = await switchScenario('switch-off', {
      QIANMO_PROMPT_CONTEXT_SNAPSHOT: '0',
    })
  }, TEST_MS)

  test('T-1: three turns of one session, each request extends the one before', () => {
    expect(on.a.length).toBe(4)
    expectEachExtendsThePrevious(on.a)
    expect(new Set(on.a.map(r => r.body.prompt_cache_key)).size).toBe(1)
  })

  test('T-2: back from another session after CLAUDE.md, the git status and files changed, A carries on byte for byte with the same key', () => {
    expect(prefixDivergence(body(on.a.at(-1)), body(on.a4[0]))).toBeNull()
    expect(on.a4[0]!.body.prompt_cache_key).toBe(on.a[0]!.body.prompt_cache_key)
  })

  test("T-2 negative control: with the snapshot off, the same steps rewrite A's prompt head", () => {
    expect(prefixDivergence(body(off.a.at(-1)), body(off.a4[0]))).not.toBeNull()
  })

  test("T-9: the git status in the instructions is the session workspace's, not the process cwd's", () => {
    const instructions = String(on.a[0]!.body.instructions)
    expect(instructions).toContain('chore(beta): init workspace')
    expect(instructions).not.toContain('init proc tree')
    expect(instructions).not.toContain('proc-only.txt')
    // A session started after the agent wrote report.txt sees it; A, frozen
    // at its start, does not.
    expect(String(on.b1[0]!.body.instructions)).toContain('report.txt')
    expect(String(on.a4[0]!.body.instructions)).not.toContain('report.txt')
  })
})

describe('P18.19: a session resumed in a replaced ACP child sends the same prompt head', () => {
  let on: RestartRun
  let noAttachments: RestartRun
  let noSnapshot: RestartRun

  beforeAll(async () => {
    on = await restartScenario('restart-on', {})
    noAttachments = await restartScenario('restart-no-attachments', {
      QIANMO_PERSIST_PROMPT_ATTACHMENTS: '0',
    })
    noSnapshot = await restartScenario('restart-no-snapshot', {
      QIANMO_PROMPT_CONTEXT_SNAPSHOT: '0',
    })
  }, TEST_MS * 2)

  test('T-3: across a child replacement, a new date, and a CLAUDE.md edit, the first resumed request extends the last one', () => {
    expect(prefixDivergence(body(on.a.at(-1)), body(on.a4[0]))).toBeNull()
    expect(on.a4[0]!.body.prompt_cache_key).toBe(on.a[0]!.body.prompt_cache_key)
  })

  test('T-3 negative control: without attachments in the transcript, input[0] differs', () => {
    expect(
      prefixDivergence(body(noAttachments.a.at(-1)), body(noAttachments.a4[0])),
    ).toStartWith('input[0]')
  })

  test('T-3 negative control: without the context snapshot, the date and CLAUDE.md rewrite the head', () => {
    expect(
      prefixDivergence(body(noSnapshot.a.at(-1)), body(noSnapshot.a4[0])),
    ).not.toBeNull()
  })

  test('T-8: a node transcript keeps its attachments; with the switch off it does not', () => {
    const kinds = (t: string) =>
      t
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line) as { type?: string })
        .filter(e => e.type === 'attachment').length
    expect(kinds(on.transcript)).toBeGreaterThan(0)
    expect(kinds(noAttachments.transcript)).toBe(0)
  })
})
