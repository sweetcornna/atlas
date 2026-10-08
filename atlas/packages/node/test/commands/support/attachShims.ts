// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Stand-ins for the two programs `qm handoff attach` runs (P17.6): `ssh` and
 * `qmcode`, as Bun scripts written into a directory, to put on `PATH` or to
 * hand to `runAttach` as its commands. Everything else around them is real:
 * the tunnel they make is a real TCP forward, the app-server they reach is
 * `fakeAppServer.ts` over a real WebSocket.
 *
 * - `ssh … -- <target> <command>` runs `<command>` with `sh -c` in the
 *   "node's home" (`QIANMO_SHIM_NODE_HOME`), which is where a real ssh would
 *   run it — so `cat -- 'qianmo-beta/secrets/…'` reads the token file there.
 * - `ssh -N -L 127.0.0.1:<l>:127.0.0.1:<r> … -- <target>` forwards every
 *   connection to `<l>` on to `<r>` until it is told to stop; a `<l>` that is
 *   taken is OpenSSH's `ExitOnForwardFailure` answer: three lines on stderr,
 *   exit 255. `QIANMO_SHIM_SSH_FAIL=connect` fails every connection the way an
 *   unreachable node does, `bind` gives that answer for any `<l>`.
 * - `qmcode resume --remote ws://… --remote-auth-token-env <VAR> <thread>`
 *   reads the token from `<VAR>`, connects with it, `initialize`s, resumes the
 *   thread **without** `cwd` and starts a turn with `QIANMO_SHIM_INPUT` — what
 *   a person typing into the terminal does — then exits with
 *   `QIANMO_SHIM_QMCODE_EXIT`, or stays until it is signalled when
 *   `QIANMO_SHIM_QMCODE_HOLD` is set.
 *
 * Both write one JSON line per event to `QIANMO_SHIM_LOG`: their argv, pid
 * and what happened. The token itself is never written — only its length —
 * so a test can scan the log for it as one more place it must not be.
 */

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const SSH = `
import { appendFileSync } from 'node:fs'
import { connect, createServer } from 'node:net'
const env = process.env
const log = event => {
  if (env.QIANMO_SHIM_LOG) appendFileSync(env.QIANMO_SHIM_LOG, JSON.stringify({ tool: 'ssh', pid: process.pid, ...event }) + '\\n')
}
const args = process.argv.slice(2)
const end = args.indexOf('--')
const options = end === -1 ? args : args.slice(0, end)
const target = end === -1 ? undefined : args[end + 1]
const command = end === -1 ? [] : args.slice(end + 2)
const forward = options.includes('-L') ? options[options.indexOf('-L') + 1] : undefined
log({ event: 'start', argv: args, mode: forward ? 'tunnel' : 'command' })
const fail = env.QIANMO_SHIM_SSH_FAIL
if (fail === 'connect' || (fail === 'tunnel' && forward)) {
  process.stderr.write('ssh: connect to host ' + target + ' port 22: Connection refused\\n')
  process.exit(255)
}
if (forward) {
  const [lhost, lport, rhost, rport] = forward.split(':')
  if (fail === 'bind') {
    process.stderr.write('bind [' + lhost + ']:' + lport + ': Address already in use\\nchannel_setup_fwd_listener_tcpip: cannot listen to port: ' + lport + '\\nCould not request local forwarding.\\n')
    process.exit(255)
  }
  const server = createServer(client => {
    const upstream = connect(Number(rport), rhost)
    client.pipe(upstream)
    upstream.pipe(client)
    client.on('error', () => upstream.destroy())
    upstream.on('error', () => client.destroy())
  })
  server.once('error', () => {
    process.stderr.write('bind [' + lhost + ']:' + lport + ': Address already in use\\nchannel_setup_fwd_listener_tcpip: cannot listen to port: ' + lport + '\\nCould not request local forwarding.\\n')
    log({ event: 'bind-failed' })
    process.exit(255)
  })
  server.listen(Number(lport), lhost, () => log({ event: 'listening' }))
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
    process.on(signal, () => {
      log({ event: 'stopped', signal })
      process.exit(0)
    })
  }
} else {
  const home = env.QIANMO_SHIM_NODE_HOME ?? '/nonexistent'
  const ran = Bun.spawnSync(['sh', '-c', command.join(' ')], {
    cwd: home,
    env: { ...env, HOME: home },
    stdout: 'inherit',
    stderr: 'inherit',
  })
  log({ event: 'ran', exitCode: ran.exitCode })
  process.exit(ran.exitCode ?? 1)
}
`

const QMCODE = `
import { appendFileSync } from 'node:fs'
const env = process.env
const log = event => {
  if (env.QIANMO_SHIM_LOG) appendFileSync(env.QIANMO_SHIM_LOG, JSON.stringify({ tool: 'qmcode', pid: process.pid, ...event }) + '\\n')
}
const argv = process.argv.slice(2)
const at = name => argv[argv.indexOf(name) + 1]
const url = at('--remote')
const variable = at('--remote-auth-token-env')
const threadId = argv[argv.length - 1]
const token = env[variable] ?? ''
log({ event: 'start', argv, tokenEnv: variable, tokenLength: token.length, cd: argv.includes('--cd') || argv.includes('-C') })
const ws = new WebSocket(url, { headers: { Authorization: 'Bearer ' + token } })
let next = 1
const pending = new Map()
ws.addEventListener('message', event => {
  const frame = JSON.parse(String(event.data))
  if (frame.id !== undefined && frame.method === undefined) {
    pending.get(frame.id)?.(frame)
    pending.delete(frame.id)
  }
})
const request = (method, params) => new Promise(resolve => {
  const id = next++
  pending.set(id, resolve)
  ws.send(JSON.stringify({ id, method, params }))
})
try {
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve)
    ws.addEventListener('error', () => reject(new Error('cannot open ' + url)))
  })
  await request('initialize', { clientInfo: { name: 'qmcode_shim', title: 'shim', version: '0.158.0' } })
  ws.send(JSON.stringify({ method: 'initialized' }))
  const resumed = await request('thread/resume', { threadId })
  log({ event: 'resumed', ok: resumed.error === undefined, cwd: resumed.result?.cwd ?? null })
  const input = env.QIANMO_SHIM_INPUT ?? 'typed in the attached terminal'
  const started = await request('turn/start', { threadId, input: [{ type: 'text', text: input, text_elements: [] }] })
  log({ event: 'turn', ok: started.error === undefined, turnId: started.result?.turn?.id ?? null })
} catch (error) {
  log({ event: 'error', message: String(error) })
  process.exit(9)
}
if (env.QIANMO_SHIM_QMCODE_HOLD) {
  for (const signal of ['SIGTERM', 'SIGHUP']) {
    process.on(signal, () => {
      log({ event: 'signalled', signal })
      process.exit(128 + (signal === 'SIGTERM' ? 15 : 1))
    })
  }
  log({ event: 'holding' })
  setInterval(() => {}, 1000)
} else {
  ws.close()
  process.exit(Number(env.QIANMO_SHIM_QMCODE_EXIT ?? '0'))
}
`

export interface AttachShims {
  readonly dir: string
  readonly ssh: string
  readonly qmcode: string
}

/** Write `ssh` and `qmcode` into `dir` (created), executable, run by this Bun. */
export function writeAttachShims(dir: string): AttachShims {
  mkdirSync(dir, { recursive: true })
  const write = (name: string, body: string): string => {
    const path = join(dir, name)
    writeFileSync(path, `#!${process.execPath}\n${body}`)
    chmodSync(path, 0o755)
    return path
  }
  return { dir, ssh: write('ssh', SSH), qmcode: write('qmcode', QMCODE) }
}

/** One event a stand-in logged. */
export interface ShimEvent {
  readonly tool: 'ssh' | 'qmcode'
  readonly pid: number
  readonly event: string
  readonly [key: string]: unknown
}

export function readShimLog(path: string): ShimEvent[] {
  let text = ''
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return []
  }
  return text
    .split('\n')
    .filter(row => row !== '')
    .map(row => JSON.parse(row) as ShimEvent)
}

/** Whether a process is still there (signal 0). */
export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
