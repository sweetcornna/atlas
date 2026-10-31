// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as fs from 'node:fs'
import * as path from 'node:path'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import type { Server, ServerWebSocket } from 'bun'

/**
 * The host end of one browser's DevTools pipe (runtimes-channels.md §6.3).
 *
 * Chromium runs with `--remote-debugging-pipe`, so no browser listens on a
 * port. This bridge serves the discovery and WebSocket endpoints the base
 * browser prelude connects to (`cdp_url`), on 127.0.0.1, and lets in only the
 * executor processes that claimed it with the resource's secret: the agents
 * on a node share its network, and the secret never reaches the private
 * desktops (the resource file lives in the hidden configuration root).
 */
export interface CdpBridge {
  /** `http://127.0.0.1:<port>`, what the resource description publishes. */
  readonly url: string
  /** The command line that hands the browser the two pipe ends (fd 3, 4). */
  command(argv: readonly string[]): string[]
  /** Whether the browser answered over its pipe before `ms` ran out. */
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
  readonly peers?: CdpPeers
}

export type CdpBridgeFactory = (options: CdpBridgeOptions) => Promise<CdpBridge>

/** Which local process holds the client end of a loopback connection. */
export interface CdpPeers {
  /**
   * The one of `pids` that owns the client socket `clientPort` →
   * `serverPort`; `undefined` when none does; `null` when this platform
   * cannot tell (the bridge then lets every loopback client in).
   */
  owner(
    clientPort: number,
    serverPort: number,
    pids: readonly number[],
  ): number | undefined | null
  /** A live process's identity (its start time), to refuse a reused pid. */
  identity(pid: number): string | undefined
}

/** The claim endpoint the executor calls before it attaches. */
export const CDP_CLAIM_PATH = '/qianmo/claim'
/** The secret's shape: 32 random bytes, base64url. */
export const CDP_TOKEN = /^[A-Za-z0-9_-]{43}$/

const PIPE_SCRIPT = 'i=$1 o=$2; shift 2; exec "$@" 3<"$i" 4>"$o"'
const MAX_MESSAGE = 256 * 1024 * 1024

/** `/proc/net/tcp` holds 127.0.0.1 as little-endian hex. */
const LOOPBACK_HEX = '0100007F'

/**
 * Linux: the client socket's inode from `/proc/net/tcp`, then the process
 * among `pids` with that socket open. Elsewhere `null`.
 */
export function procPeers(procRoot = '/proc'): CdpPeers {
  const linux = process.platform === 'linux'
  return {
    owner(clientPort, serverPort, pids) {
      if (!linux) return null
      let table: string
      try {
        table = fs.readFileSync(path.join(procRoot, 'net', 'tcp'), 'utf8')
      } catch {
        return null
      }
      const local = `${LOOPBACK_HEX}:${clientPort.toString(16).toUpperCase().padStart(4, '0')}`
      const remote = `${LOOPBACK_HEX}:${serverPort.toString(16).toUpperCase().padStart(4, '0')}`
      let inode: string | undefined
      for (const line of table.split('\n').slice(1)) {
        const fields = line.trim().split(/\s+/)
        if (fields[1] === local && fields[2] === remote && fields[9] !== '0') {
          inode = fields[9]
          break
        }
      }
      if (!inode) return undefined
      const link = `socket:[${inode}]`
      for (const pid of pids) {
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
    identity(pid) {
      try {
        const stat = fs.readFileSync(
          path.join(procRoot, String(pid), 'stat'),
          'utf8',
        )
        // "<pid> (<comm>) <state> …": the start time is field 22.
        return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]
      } catch {
        return linux ? undefined : String(pid)
      }
    },
  }
}

interface Client {
  readonly socket: ServerWebSocket<{ id: number }>
  /** The client's own browser-target session, once attached. */
  session: string | null
  /** Messages that arrived before the session was attached. */
  readonly queued: string[]
  readonly sessions: Set<string>
}
type Pending =
  | {
      readonly kind: 'client'
      readonly client: Client
      readonly id: number
      readonly method: string
    }
  | {
      readon