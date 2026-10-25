// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The compiled `qmo` with an ACP agent (qmo-local.md §4.3.4, §4.4): built
 * the way `bun run atlas:build:client` builds it, started as `qmo code
 * serve`, with `gemini` on PATH being the harness package's fake ACP agent
 * as Gemini CLI. `qmo agents` finds it as it would the real one (by its
 * command; the scan only asks its `--version`, which the fake answers). No
 * real agent is started; HOME and the client folder are temporary.
 *
 * One conversation: hello lists `acp`; a session in 人工确认 asks about an
 * edit, allowed once, the file written, its diff on the tool line; the mode
 * switched with `session/set_mode`; a command allowed for the session with
 * Gemini's session option, never the one that writes its settings;
 * `authenticate` never sent; shutdown.
 *
 * POSIX only: the fake is a shell script.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  type Box,
  box,
  cleanBoxes,
  logged,
} from '../../packages/client/test/code/helpers.ts'
import { buildClient } from '../../scripts/build-client.ts'

type Message = Record<string, unknown>

const posix = process.platform !== 'win32'

const FAKE_ACP = path.join(
  path.dirname(Bun.resolveSync('@qianmo/harness/process.ts', import.meta.dir)),
  '..',
  'test',
  'fixtures',
  'fake-acp-agent.runner.ts',
)

/** `<bin>/gemini`: the fake as Gemini CLI. */
function fakeGemini(at: Box): void {
  const file = path.join(at.bin, 'gemini')
  const quote = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`
  fs.writeFileSync(
    file,
    `#!/bin/sh\nFAKE_ACP_STATE=${quote(at.state)} FAKE_ACP_PROFILE=gemini exec ${quote(process.execPath)} ${quote(FAKE_ACP)} "$@"\n`,
  )
  fs.chmodSync(file, 0o755)
}

let built = ''

describe.skipIf(!posix)('the compiled qmo with an ACP agent', () => {
  let out = ''
  let proc: Bun.Subprocess<'pipe', 'pipe', 'pipe'> | undefined

  beforeAll(() => {
    out = fs.mkdtempSync(path.join(os.tmpdir(), 'qmo-built-acp-'))
    built = path.join(out, 'qmo')
    expect(buildClient(built, undefined, 'ignore')).toBe(0)
  }, 120_000)

  afterAll(async () => {
    if (proc !== undefined) {
      proc.kill('SIGKILL')
      await proc.exited
    }
    cleanBoxes()
    if (out !== '') fs.rmSync(out, { recursive: true, force: true })
  })

  test('Gemini CLI: asked, allowed, the mode switched, 本会话都允许 kept to the session', async () => {
    const at = box()
    fakeGemini(at)
    const lines: Message[] = []
    let stderr = ''
    const served = Bun.spawn([built, 'code', 'serve'], {
      env: {
        PATH: `${at.bin}:/usr/bin:/bin`,
        HOME: at.home,
        SHELL: '/bin/sh',
        QMO_CLIENT_DIR: at.client,
      },
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    })
    proc = served
    const reading = (async () => {
      const decoder = new TextDecoder()
      let rest = ''
      for await (const chunk of served.stdout) {
        rest += decoder.decode(chunk, { stream: true })
        for (let end = rest.indexOf('\n'); end >= 0; end = rest.indexOf('\n')) {
          lines.push(JSON.parse(rest.slice(0, end)) as Message)
          rest = rest.slice(end + 1)
        }
      }
    })()
    void (async () => {
      const decoder = new TextDecoder()
      for await (const chunk of served.stderr)
        stderr += decoder.decode(chunk, { stream: true })
    })()
    const until = async <T>(find: () => T | undefined): Promise<T> => {
      const end = Date.now() + 20_000
      for (;;) {
        const found = find()
        if (found !== undefined) return found
        if (Date.now() > end)
          throw new Error(
            `timed out; last lines: ${JSON.stringify(lines.slice(-6))}\n${stderr}`,
          )
        await Bun.sleep(10)
      }
    }
    let next = 0
    const call = async (method: string, params: unknown = {}) => {
      const id = ++next
      served.stdin.write(`${JSON.stringify({ id, method, params })}\n`)
      served.stdin.flush()
      const answer = await until(() => lines.find(one => one.id === id))
      if (answer.error !== undefined)
        throw new Error(`${method}: ${JSON.stringify(answer.error)}`)
      return answer.result as Message
    }
    const events = (after: number) =>
      lines
        .slice(after)
        .filter(one => one.method === 'event')
        .map(one => one.params as Message)
    const state = (session: string, wanted: string, after: number) =>
      until(() =>
        events(after).find(
          one =>
            one.type === 'session' &&
            (one.session as Message).id === session &&
            (one.session as Message).state === wanted,
        ),
      )
    const turns = (session: string) => {
      const byId = new Map<string, Message>()
      for (const event of events(0))
        if (event.type === 'record' && event.session === session) {
          const turn = (event.record as Message).turn as Message
          byId.set(String(turn.id), turn)
        }
      return [...byId.values()]
    }
    const openAsk = (session: string) =>
      until(() => {
        const found = turns(session).find(
          one =>
            one.ask !== undefined &&
            (one.ask as Message).decision === undefined,
        )
        return found === undefined ? undefined : (found.ask as Message)
      })

    const hello = await call('hello')
    expect((hello.features as Message).protocols).toEqual([
      'claude-stream',
      'acp',
    ])
    const folder = await call('folders.add', { path: at.work })
    let mark = lines.length
    const started = await call('session.start', {
      folder: folder.id,
      agent: 'gemini',
      mode: 'off',
      worktree: false,
      text: 'edit notes.md',
      clientId: 'page-1',
      remote: false,
    })
    const id = String((started.session as Message).id)
    expect(started.session).toMatchObject({
      agent: { id: 'gemini', name: 'Gemini CLI' },
      mode: 'off',
    })
    await state(id, 'waiting', mark)
    const first = await openAsk(id)
    expect(first).toMatchObject({
      options: ['once', 'session', 'deny'],
      paths: ['notes.md'],
    })
    mark = lines.length
    await call('session.answer', {
      session: id,
      ask: first.id,
      decision: 'once',
    })
    await state(id, 'idle', mark)
    expect(fs.readFileSync(path.join(at.work, 'notes.md'), 'utf8')).toBe(
      'edited by fake\n',
    )
    expect(turns(id).find(one => one.tool !== undefined)).toMatchObject({
      text: '编辑 notes.md',
      detail: '@@ -0,0 +1,1 @@\n+edited by fake',
      tool: { status: 'done', approvedBy: 'user', added: 1 },
    })
    expect(
      await call('session.mode', { session: id, mode: 'accept-edits' }),
    ).toEqual({ mode: 'accept-edits', applies: 'now' })
    mark = lines.length
    await call('session.send', {
      session: id,
      text: 'bash ls',
      clientId: 'page-2',
      origin: 'local',
    })
    const second = await openAsk(id)
    await call('session.answer', {
      session: id,
      ask: second.id,
      decision: 'session',
    })
    await state(id, 'idle', mark)
    expect(turns(id).at(-1)!.text).toBe('acp(2): bash done')
    const sent = logged(path.join(at.state, 'methods.ndjson'))
    const methods = sent.map(one => one.method)
    expect(methods).not.toContain('authenticate')
    expect(
      sent
        .filter(one => one.method === 'session/set_mode')
        .map(one => (one.params as Message).modeId),
    ).toEqual(['autoEdit'])
    expect(
      logged(path.join(at.state, 'answers.ndjson')).map(one => one.chosen),
    ).toEqual(['proceed_once', 'proceed_always'])
    expect(fs.existsSync(path.join(at.state, 'saved-settings.json'))).toBe(
      false,
    )
    // `qmo agents` asked its version; the session started it with --acp only.
    const argvs = logged(path.join(at.state, 'argv.ndjson'))
    expect(argvs.at(-1)).toEqual(['--acp'])
    for (const argv of argvs)
      expect([['--version'], ['--acp']]).toContainEqual(argv)
    await call('shutdown')
    expect(await served.exited).toBe(0)
    await reading
    proc = undefined
    expect(stderr).not.toContain('edit notes.md')
  })
})
