// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as fs from 'node:fs'
import * as path from 'node:path'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import type { Server, ServerWebSocket } from 'bun'
import {
  DESKTOP_CDP_CLAIM_PATH,
  DESKTOP_CDP_TOKEN,
} from '@qianmo/extension/desktopPolicy'
import { ensurePrivateDir } from '../providers/store.js'

/**
 * The host end of one browser's DevTools pipe (runtimes-channels.md §6.3).
 *
 * Chromium runs with `--remote-debugging-pipe`, so no browser listens on a
 * port. This bridge serves the discovery and WebSocket endpoints the base
 * browser tool attaches to (`cdp_url`), on 127.0.0.1, and lets in only the
 * processes that claimed it with the resource's secret: the agents on a node
 * share its network, and the secret lives in the hidden configuration root,
 * out of every private desktop's reach.
 */
export interface CdpBridge {
  /** `http://127.0.0.1:<port>`, what the resource description publishes. */
  readonly url: string
  /**
   * Whether the launcher hands the browser its fd 3 and 4 itself (macOS:
   * Chrome there works only on socket pairs, not on pipes or FIFOs); their
   * other ends then go to {@link attach}. Otherwise the bridge's FIFOs do.
   */
  readonly pair: boolean
  /** The command line that gives the browser the two pipe ends (fd 3, 4). */
  command(argv: readonly string[]): string[]
  /** The host ends of a launcher-made pair; the bridge closes them. */
  attach(pipe: CdpPipe): void
  /**
   * Whether the browser answered over its pipe before `ms` ran out. A ready
   * bridge closes itself once `alive` turns false.
   */
  ready(alive: () => boolean, ms: number): Promise<boolean>
  /** The browser's page targets; throws when it does not answer in `ms`. */
  pages(ms: number): Promise<number>
  close(): void
}

export interface CdpBridgeOptions {
  /** A private directory of the resource; the two FIFOs are made in it. */
  readonly dir: string
  /** The claim secret, as written into the resource description. */
  readonly token: string
  /** FIFOs on Linux, launcher-made socket pairs elsewhere (see `pair`). */
  readonly transport?: 'fifo' | 'pair'
  readonly peers?: CdpPeers
}

/** The host's ends of the browser's DevTools pipe. */
export interface CdpPipe {
  /** Written by the host, read by the browser on its fd 3. */
  readonly input: number
  /** Written by the browser on its fd 4, read by the host. */
  readonly output: number
}

export type CdpBridgeFactory = (options: CdpBridgeOptions) => Promise<CdpBridge>

/** Which local process holds the client end of a loopback connection. */
export interface CdpPeers {
  /**
   * The process that owns the client socket 127.0.0.1:`clientPort` →
   * 127.0.0.1:`serverPort`, looked for among `pids` (every process when
   * absent); `undefined` when none does or this platform cannot tell.
   */
  owner(
    clientPort: number,
    serverPort: number,
    pids?: readonly number[],
  ): Promise<number | undefined>
  /** A live process's start time, to refuse a reused pid. */
  identity(pid: number): Promise<string | undefined>
}

/** The shell that opens the two FIFOs as the browser's fd 3 and 4. */
const PIPE_SCRIPT = 'i=$1 o=$2; shift 2; exec "$@" 3<"$i" 4>"$o"'
/** The largest DevTools message either way (full-page screenshots). */
const MAX_MESSAGE = 128 * 1024 * 1024
/** Peer lookups at once; on macOS each one runs `lsof` and `ps`. */
const MAX_LOOKUPS = 8
/** Claiming processes remembered; each executor restart adds one. */
const MAX_CLAIMS = 16
/** How often a ready bridge checks that its browser still runs. */
const ALIVE_MS = 500
/** `/proc/net/tcp` holds 127.0.0.1 as little-endian hex. */
const LOOPBACK_HEX = '0100007F'

/**
 * Linux: the client socket's inode from `/proc/net/tcp`, then the process
 * with that socket open. Only processes of the node's own account can be
 * read; any other owner counts as none.
 */
export function procPeers(procRoot = '/proc'): CdpPeers {
  const hex = (port: number) =>
    `${LOOPBACK_HEX}:${port.toString(16).toUpperCase().padStart(4, '0')}`
  return {
    async owner(clientPort, serverPort, pids) {
      let table: string
      try {
        table = fs.readFileSync(path.join(procRoot, 'net', 'tcp'), 'utf8')
      } catch {
        return undefined
      }
      const local = hex(clientPort),
        remote = hex(serverPort)
      let inode: string | undefined
      for (const line of table.split('\n').slice(1)) {
        // sl local rem st queues tr retrnsmt uid timeout inode …
        const fields = line.trim().split(/\s+/)
        if (fields[1] === local && fields[2] === remote && fields[9] !== '0') {
          inode = fields[9]
          break
        }
      }
      if (!inode) return undefined
      const link = `socket:[${inode}]`
      let candidates = pids
      if (!candidates)
        try {
          candidates = fs
            .readdirSync(procRoot)
            .filter(name => /^\d+$/.test(name))
            .map(Number)
        } catch {
          return undefined
        }
      for (const pid of candidates) {
        const dir = path.join(procRoot, String(pid), 'fd')
        let fds: string[]
        try {
          fds = fs.readdirSync(dir)
        } catch {
          continue
        }
        for (const fd of fds) {
          try {
            if (fs.readlinkSync(path.join(dir, fd)) === link) return pid
          } catch {
            /* Closed while reading. */
          }
        }
      }
      return undefined
    },
    async identity(pid) {
      try {
        const stat = fs.readFileSync(
          path.join(procRoot, String(pid), 'stat'),
          'utf8',
        )
        // "<pid> (<comm>) <state> …": the start time is field 22.
        return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]
      } catch {
        return undefined
      }
    },
  }
}

/** Run a short read-only lookup; its output, or undefined when it failed. */
async function output(argv: readonly string[]): Promise<string | undefined> {
  try {
    const proc = Bun.spawn([...argv], {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'ignore',
      timeout: 5000,
    })
    const [text, code] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ])
    return code === 0 ? text : undefined
  } catch {
    return undefined
  }
}

/**
 * macOS: `lsof` names the process holding the client end; `ps` gives its
 * start time. Both ship with the system.
 */
export function lsofPeers(
  lsof = Bun.which('lsof') ?? '/usr/sbin/lsof',
  ps = Bun.which('ps') ?? '/bin/ps',
): CdpPeers {
  return {
    async owner(clientPort, serverPort, pids) {
      const listed = await output([
        lsof,
        '-nP',
        `-iTCP@127.0.0.1:${clientPort}`,
        '-sTCP:ESTABLISHED',
        '-Fpn',
      ])
      if (listed === undefined) return undefined
      const name = `n127.0.0.1:${clientPort}->127.0.0.1:${serverPort}`
      let pid: number | undefined
      for (const line of listed.split('\n')) {
        if (line.startsWith('p')) pid = Number(line.slice(1))
        else if (line === name && pid !== undefined)
          return !pids || pids.includes(pid) ? pid : undefined
      }
      return undefined
    },
    async identity(pid) {
      const started = (
        await output([ps, '-o', 'lstart=', '-p', String(pid)])
      )?.trim()
      return started ? started : undefined
    },
  }
}

/** Platforms that cannot tell a connection's process let no one in. */
const NO_PEERS: CdpPeers = {
  owner: async () => undefined,
  identity: async () => undefined,
}

export function platformPeers(
  platform: NodeJS.Platform = process.platform,
): CdpPeers {
  return platform === 'linux'
    ? procPeers()
    : platform === 'darwin'
      ? lsofPeers()
      : NO_PEERS
}

interface Socket {
  readonly id: number
}
interface Client {
  readonly socket: ServerWebSocket<Socket>
  /** The client's own browser-target session, once attached. */
  session: string | null
  /** Messages that arrived before that session was attached. */
  readonly queued: string[]
  closed: boolean
}
type Pending =
  | {
      readonly kind: 'client'
      readonly client: Client
      readonly id: number
      /** Sent without a session: the answer goes back without one. */
      readonly own: boolean
      readonly method: string
    }
  | { readonly kind: 'attach'; readonly client: Client }
  | {
      readonly kind: 'host'
      readonly resolve: (result: Record<string, unknown>) => void
      readonly reject: (error: Error) => void
      readonly timer: Timer
    }
  | { readonly kind: 'ignore' }
interface Message {
  id?: unknown
  method?: unknown
  sessionId?: unknown
  params?: { sessionId?: unknown } & Record<string, unknown>
  result?: Record<string, unknown>
  error?: { message?: unknown }
}

/** The part of a stream reader the bridge uses on the browser's pipe. */
interface PipeReader {
  read(): Promise<{ done: boolean; value?: Uint8Array }>
  cancel(): Promise<void>
}

const forbidden = () => new Response(null, { status: 403 })

/**
 * Serve the bridge, and on Linux make the two FIFOs and open the ends the
 * host keeps. Both FIFOs are opened read-write, so neither open waits for
 * the browser and a browser that never starts leaves nothing blocked.
 */
export const createCdpBridge: CdpBridgeFactory = async options => {
  if (!DESKTOP_CDP_TOKEN.test(options.token))
    throw new Error('Invalid DevTools bridge secret')
  const peers = options.peers ?? platformPeers()
  const pair =
    (options.transport ?? (process.platform === 'linux' ? 'fifo' : 'pair')) ===
    'pair'
  ensurePrivateDir(options.dir)
  const input = path.join(options.dir, 'in'),
    output = path.join(options.dir, 'out')
  let writeFd = -1
  let readFd = -1
  let reader: PipeReader | undefined
  if (!pair) {
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
  }

  const token = Buffer.from(options.token)
  const browserId = randomUUID()
  const clients = new Map<number, Client>()
  /** Who owns each session: browser-target sessions and the ones under them. */
  const sessions = new Map<string, Client>()
  const pending = new Map<number, Pending>()
  /** Claiming processes, by pid, with their start time. */
  const claims = new Map<number, string>()
  let sequence = 0
  let clientSequence = 0
  let closed = false
  let version: Record<string, unknown> = {}

  const queue: Buffer[] = []
  let queuedBytes = 0
  let offset = 0
  let retry: Timer | undefined
  /** A FIFO never ends while the host holds both ends, so ask the process. */
  let watch: Timer | undefined
  let lookups = 0
  const pump = () => {
    retry = undefined
    while (queue.length > 0 && !closed && writeFd >= 0) {
      const head = queue[0]!
      try {
        offset += fs.writeSync(writeFd, head, offset)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EAGAIN') {
          retry = setTimeout(pump, 2)
          return
        }
        close()
        return
      }
      if (offset >= head.length) {
        queue.shift()
        queuedBytes -= head.length
        offset = 0
      }
    }
  }
  const write = (message: Record<string, unknown>) => {
    if (closed) return
    const bytes = Buffer.from(`${JSON.stringify(message)}\0`)
    queuedBytes += bytes.length
    // A browser that stopped reading takes the bridge down with it.
    if (queuedBytes > MAX_MESSAGE) {
      close()
      return
    }
    queue.push(bytes)
    if (retry === undefined) pump()
  }
  const command = (
    method: string,
    params: Record<string, unknown>,
    ms: number,
  ) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      if (closed) {
        reject(new Error('DevTools bridge closed'))
        return
      }
      const id = ++sequence
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`DevTools ${method} timed out`))
      }, ms)
      pending.set(id, { kind: 'host', resolve, reject, timer })
      write({ id, method, params })
    })

  const send = (client: Client, message: Message) => {
    if (client.closed) return
    if (client.socket.send(JSON.stringify(message)) === 0) client.socket.close()
  }
  const detach = (session: string) => {
    const id = ++sequence
    pending.set(id, { kind: 'ignore' })
    write({
      id,
      method: 'Target.detachFromTarget',
      params: { sessionId: session },
    })
  }
  const forward = (client: Client, text: string) => {
    let message: Message
    try {
      message = JSON.parse(text) as Message
    } catch {
      client.socket.close(1007, 'Malformed DevTools message')
      return
    }
    if (
      !message ||
      typeof message !== 'object' ||
      !Number.isSafeInteger(message.id) ||
      typeof message.method !== 'string'
    ) {
      client.socket.close(1007, 'Malformed DevTools message')
      return
    }
    const own = message.sessionId === undefined
    // A client reaches its own sessions only.
    if (
      !own &&
      (typeof message.sessionId !== 'string' ||
        sessions.get(message.sessionId) !== client)
    ) {
      send(client, {
        id: message.id,
        error: { code: -32001, message: 'Session with given id not found.' },
      } as Message)
      return
    }
    const id = ++sequence
    pending.set(id, {
      kind: 'client',
      client,
      id: message.id as number,
      own,
      method: message.method,
    })
    write({
      ...message,
      id,
      sessionId: own ? client.session : message.sessionId,
    })
  }
  const adopt = (message: Message, owner: Client) => {
    const child = message.params?.sessionId
    if (typeof child !== 'string') return
    if (message.method === 'Target.attachedToTarget') sessions.set(child, owner)
    if (message.method === 'Target.detachedFromTarget') sessions.delete(child)
  }
  const fromBrowser = (message: Message) => {
    if (typeof message.id === 'number') {
      const entry = pending.get(message.id)
      if (!entry) return
      pending.delete(message.id)
      if (entry.kind === 'host') {
        clearTimeout(entry.timer)
        if (message.error)
          entry.reject(
            new Error(String(message.error.message ?? 'DevTools error')),
          )
        else entry.resolve(message.result ?? {})
        return
      }
      if (entry.kind === 'attach') {
        const session = message.result?.sessionId
        if (typeof session !== 'string') {
          entry.client.socket.close(1011, 'Browser session unavailable')
          return
        }
        if (entry.client.closed) {
          detach(session)
          return
        }
        entry.client.session = session
        sessions.set(session, entry.client)
        for (const text of entry.client.queued.splice(0))
          forward(entry.client, text)
        return
      }
      if (entry.kind === 'ignore' || entry.client.closed) return
      const attached = message.result?.sessionId
      if (
        entry.method === 'Target.attachToTarget' &&
        typeof attached === 'string'
      )
        sessions.set(attached, entry.client)
      const reply: Message = { ...message, id: entry.id }
      if (entry.own) delete reply.sessionId
      send(entry.client, reply)
      return
    }
    // Events: only those of a client's sessions, to that client.
    if (typeof message.sessionId !== 'string') return
    const owner = sessions.get(message.sessionId)
    if (!owner || owner.closed) return
    adopt(message, owner)
    if (message.sessionId === owner.session) {
      const event: Message = { ...message }
      delete event.sessionId
      send(owner, event)
    } else send(owner, message)
  }

  /** Read the browser's NUL-terminated messages until the pipe closes. */
  const listen = async (from: PipeReader) => {
    let parts: Uint8Array[] = []
    let size = 0
    try {
      for (;;) {
        const { value, done } = await from.read()
        if (done || closed || !value) break
        let start = 0
        for (
          let end = value.indexOf(0);
          end !== -1;
          end = value.indexOf(0, start)
        ) {
          parts.push(value.subarray(start, end))
          const text = Buffer.concat(parts).toString('utf8')
          parts = []
          size = 0
          start = end + 1
          let message: Message
          try {
            message = JSON.parse(text) as Message
          } catch {
            continue
          }
          if (message && typeof message === 'object')
            try {
              fromBrowser(message)
            } catch {
              /* One message the bridge cannot route; the rest still flow. */
            }
        }
        if (start < value.length) {
          parts.push(value.subarray(start))
          size += value.length - start
          if (size > MAX_MESSAGE) break
        }
      }
    } catch {
      /* The pipe closed under the reader. */
    }
    close()
  }
  const open = (pipe: CdpPipe) => {
    writeFd = pipe.input
    readFd = pipe.output
    const next = Bun.file(readFd).stream().getReader()
    reader = next
    void listen(next)
    pump()
  }

  const claimedBy = async (clientPort: number) => {
    const pids = [...claims.keys()]
    if (pids.length === 0) return false
    const pid = await peers.owner(clientPort, server.port!, pids)
    if (pid === undefined) return false
    if ((await peers.identity(pid)) === claims.get(pid)) return true
    claims.delete(pid)
    return false
  }
  const secret = (header: string | null) => {
    const presented = Buffer.from(header?.match(/^Bearer (\S+)$/)?.[1] ?? '')
    return (
      presented.length === token.length && timingSafeEqual(presented, token)
    )
  }
  const wsPath = `/devtools/browser/${browserId}`
  const serve = async (
    req: Request,
    srv: Server<Socket>,
    port: number,
  ): Promise<Response | undefined> => {
    const { pathname } = new URL(req.url)
    if (pathname === DESKTOP_CDP_CLAIM_PATH) {
      if (req.method !== 'POST') return new Response(null, { status: 405 })
      if (!secret(req.headers.get('authorization'))) return forbidden()
      const pid = await peers.owner(port, srv.port!)
      const started = pid === undefined ? undefined : await peers.identity(pid)
      if (pid === undefined || started === undefined) return forbidden()
      claims.delete(pid)
      claims.set(pid, started)
      for (const old of claims.keys()) {
        if (claims.size <= MAX_CLAIMS) break
        claims.delete(old)
      }
      return new Response(null, { status: 204 })
    }
    if (!(await claimedBy(port)) || closed) return forbidden()
    if (pathname === '/json/version' || pathname === '/json/version/')
      return Response.json({
        Browser: version.product,
        'Protocol-Version': version.protocolVersion,
        'User-Agent': version.userAgent,
        'V8-Version': version.jsVersion,
        'WebKit-Version': version.revision,
        webSocketDebuggerUrl: `ws://127.0.0.1:${srv.port}${wsPath}`,
      })
    if (pathname === wsPath) {
      if (srv.upgrade(req, { data: { id: ++clientSequence } })) return undefined
      return new Response(null, { status: 400 })
    }
    return new Response(null, { status: 404 })
  }
  const server: Server<Socket> = Bun.serve<Socket>({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req, srv) {
      const peer = srv.requestIP(req)
      if (closed || peer?.address !== '127.0.0.1') return forbidden()
      if (lookups >= MAX_LOOKUPS) return new Response(null, { status: 503 })
      lookups++
      try {
        return await serve(req, srv, peer.port)
      } finally {
        lookups--
      }
    },
    websocket: {
      maxPayloadLength: MAX_MESSAGE,
      backpressureLimit: 2 * MAX_MESSAGE,
      closeOnBackpressureLimit: true,
      perMessageDeflate: false,
      open(socket) {
        const client: Client = {
          socket,
          session: null,
          queued: [],
          closed: false,
        }
        clients.set(socket.data.id, client)
        // Its own browser session: what it sends without a session goes
        // there, and the browser keeps each session's state apart.
        const id = ++sequence
        pending.set(id, { kind: 'attach', client })
        write({ id, method: 'Target.attachToBrowserTarget', params: {} })
      },
      message(socket, raw) {
        const client = clients.get(socket.data.id)
        if (!client) return
        const text = typeof raw === 'string' ? raw : raw.toString('utf8')
        if (client.session === null) client.queued.push(text)
        else forward(client, text)
      },
      close(socket) {
        const client = clients.get(socket.data.id)
        if (!client) return
        clients.delete(socket.data.id)
        client.closed = true
        for (const [session, owner] of sessions)
          if (owner === client) sessions.delete(session)
        if (client.session !== null) detach(client.session)
      },
    },
  })

  function close() {
    if (closed) return
    closed = true
    if (retry !== undefined) clearTimeout(retry)
    if (watch !== undefined) clearInterval(watch)
    for (const entry of pending.values())
      if (entry.kind === 'host') {
        clearTimeout(entry.timer)
        entry.reject(new Error('DevTools bridge closed'))
      }
    pending.clear()
    server.stop(true)
    void reader?.cancel().catch(() => {})
    for (const fd of new Set([writeFd, readFd]))
      if (fd >= 0)
        try {
          fs.closeSync(fd)
        } catch {
          /* Already closed. */
        }
    if (!pair)
      for (const file of [input, output]) fs.rmSync(file, { force: true })
  }

  if (!pair)
    open({
      input: fs.openSync(input, fs.constants.O_RDWR | fs.constants.O_NONBLOCK),
      output: fs.openSync(output, fs.constants.O_RDWR),
    })

  return {
    url: `http://127.0.0.1:${server.port}`,
    pair,
    command: argv =>
      pair
        ? [...argv]
        : ['/bin/sh', '-c', PIPE_SCRIPT, 'qianmo-cdp', input, output, ...argv],
    attach(pipe) {
      if (!pair || writeFd >= 0) throw new Error('DevTools pipe already open')
      if (closed) {
        for (const fd of new Set([pipe.input, pipe.output])) fs.closeSync(fd)
        return
      }
      open(pipe)
    },
    async ready(alive, ms) {
      const deadline = Date.now() + ms
      const answer = command('Browser.getVersion', {}, ms).catch(() => null)
      while (Date.now() < deadline && alive() && !closed) {
        const result = await Promise.race([answer, Bun.sleep(25)])
        if (result === null) return false
        if (result) {
          version = result
          clearInterval(watch)
          watch = setInterval(() => {
            if (!alive()) close()
          }, ALIVE_MS)
          watch.unref()
          return true
        }
      }
      return false
    },
    async pages(ms) {
      const { targetInfos } = await command('Target.getTargets', {}, ms)
      if (!Array.isArray(targetInfos))
        throw new Error('DevTools target list unavailable')
      return targetInfos.filter(
        (t: { type?: unknown } | null) => t?.type === 'page',
      ).length
    },
    close,
  }
}
