// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The window's DevTools pipe on Linux (clients.md §3.3).
 *
 * `/proc/<pid>/cmdline` is readable by every user, so the ticket cannot ride
 * on the browser's command line there. The window starts on `about:blank`
 * with `--remote-debugging-pipe` and the client navigates it over the pipe:
 * no port is opened, and a navigation asked for over DevTools carries
 * `Sec-Fetch-Site: none`, like one typed into the address bar.
 *
 * The pipe is two 0600 FIFOs in a 0700 directory, handed to the browser as
 * fd 3 (commands in) and fd 4 (replies out) by a shell redirect. The client
 * opens both read-write and non-blocking, so neither open waits for the
 * browser, and a browser that never starts leaves nothing blocked. Messages
 * are JSON terminated by a NUL byte. A FIFO the client holds both ends of
 * never reaches end-of-file, so the browser's exit is read from its process.
 * The FIFOs' names go as soon as the browser first answers: it holds both
 * ends by then, the open descriptors outlive the names, and nothing else can
 * open the pipe afterwards.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { ensurePrivateDir } from './secret.js'

type Message = {
  readonly id?: number
  readonly result?: Record<string, unknown>
  readonly error?: { readonly message?: string }
}

interface Waiting {
  resolve(result: Record<string, unknown>): void
  reject(error: Error): void
  timer: Timer
}

/** Largest reply the client keeps buffered before it gives up on the pipe. */
const MAX_BUFFER = 8 * 1024 * 1024
const POLL_MS = 15

export interface PipeWindow {
  /** The browser's exit code, once it has gone. */
  readonly exited: Promise<number>
  /** Send one DevTools command; `sessionId` addresses an attached page. */
  send(
    method: string,
    params?: Record<string, unknown>,
    options?: { readonly sessionId?: string; readonly ms?: number },
  ): Promise<Record<string, unknown>>
  /** Stop listening and remove the FIFOs. The browser keeps running only while the pipe is held. */
  close(): void
}

function errnoOf(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code
}

/** Make the FIFO pair in a private directory. */
export function makeFifos(dir: string): { input: string; output: string } {
  ensurePrivateDir(dir)
  const input = path.join(dir, 'in')
  const output = path.join(dir, 'out')
  for (const file of [input, output]) fs.rmSync(file, { force: true })
  const made = Bun.spawnSync(['mkfifo', '-m', '600', input, output], {
    stdout: 'ignore',
    stderr: 'ignore',
  })
  if (
    made.exitCode !== 0 ||
    ![input, output].every(file => fs.lstatSync(file).isFIFO())
  )
    throw new Error('DevTools pipe could not be created')
  return { input, output }
}

/**
 * The argv that starts `program` with the FIFOs as its fd 3 and 4. The paths
 * are arguments to the shell, not part of its script, so no quoting is
 * involved.
 */
export function pipeArgv(
  fifos: { readonly input: string; readonly output: string },
  program: string,
  args: readonly string[],
): string[] {
  return [
    '/bin/sh',
    '-c',
    'exec 3<"$1" 4>"$2"; shift 2; exec "$@"',
    'qmo-window',
    fifos.input,
    fifos.output,
    program,
    ...args,
  ]
}

/** Start `program` on the pipe in `dir`. */
export function launchOnPipe(
  dir: string,
  program: string,
  args: readonly string[],
  env: Record<string, string | undefined> = process.env,
): PipeWindow {
  const fifos = makeFifos(dir)
  const flags = fs.constants.O_RDWR | fs.constants.O_NONBLOCK
  const writeFd = fs.openSync(fifos.input, flags)
  const readFd = fs.openSync(fifos.output, flags)
  const proc = Bun.spawn(pipeArgv(fifos, program, args), {
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'ignore',
    env,
  })

  const waiting = new Map<number, Waiting>()
  let sequence = 0
  let buffered = Buffer.alloc(0)
  let closed = false
  let named = true
  const chunk = Buffer.alloc(64 * 1024)

  /** Remove the FIFOs' names; the descriptors already open keep working. */
  const unname = () => {
    if (!named) return
    named = false
    for (const file of [fifos.input, fifos.output])
      fs.rmSync(file, { force: true })
  }

  const failAll = (error: Error) => {
    for (const [id, entry] of waiting) {
      clearTimeout(entry.timer)
      waiting.delete(id)
      entry.reject(error)
    }
  }

  const deliver = (text: string) => {
    let message: Message
    try {
      message = JSON.parse(text) as Message
    } catch {
      return
    }
    if (typeof message.id !== 'number') return
    const entry = waiting.get(message.id)
    if (entry === undefined) return
    waiting.delete(message.id)
    clearTimeout(entry.timer)
    if (message.error)
      entry.reject(new Error(message.error.message ?? 'DevTools error'))
    else entry.resolve(message.result ?? {})
  }

  const poll = setInterval(() => {
    for (;;) {
      let read = 0
      try {
        read = fs.readSync(readFd, chunk, 0, chunk.length, null)
      } catch (error) {
        if (errnoOf(error) === 'EAGAIN') return
        close()
        return
      }
      if (read === 0) return
      // The browser has written, so its shell opened both FIFOs before it.
      unname()
      buffered = Buffer.concat([buffered, chunk.subarray(0, read)])
      if (buffered.length > MAX_BUFFER) {
        close()
        return
      }
      let end = buffered.indexOf(0)
      while (end >= 0) {
        deliver(buffered.subarray(0, end).toString('utf8'))
        buffered = buffered.subarray(end + 1)
        end = buffered.indexOf(0)
      }
    }
  }, POLL_MS)

  const exited = proc.exited.then(code => {
    failAll(new Error('browser exited'))
    return code
  })

  const write = (bytes: Buffer) => {
    let offset = 0
    const deadline = Date.now() + 5000
    while (offset < bytes.length) {
      try {
        offset += fs.writeSync(writeFd, bytes, offset)
      } catch (error) {
        if (errnoOf(error) !== 'EAGAIN' || Date.now() > deadline) throw error
        Bun.sleepSync(2)
      }
    }
  }

  function close(): void {
    if (closed) return
    closed = true
    clearInterval(poll)
    failAll(new Error('DevTools pipe closed'))
    for (const fd of [writeFd, readFd]) {
      try {
        fs.closeSync(fd)
      } catch {}
    }
    unname()
  }

  return {
    exited,
    send(method, params = {}, options = {}) {
      return new Promise((resolve, reject) => {
        if (closed) {
          reject(new Error('DevTools pipe closed'))
          return
        }
        const id = ++sequence
        const timer = setTimeout(() => {
          waiting.delete(id)
          reject(new Error(`DevTools ${method} timed out`))
        }, options.ms ?? 10_000)
        waiting.set(id, { resolve, reject, timer })
        const message = {
          id,
          method,
          params,
          ...(options.sessionId === undefined
            ? {}
            : { sessionId: options.sessionId }),
        }
        try {
          write(Buffer.from(`${JSON.stringify(message)}\0`))
        } catch (error) {
          waiting.delete(id)
          clearTimeout(timer)
          reject(error instanceof Error ? error : new Error(String(error)))
        }
      })
    },
    close,
  }
}
