// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: MIT

import { appendFile } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { IDENTITY_MODE, type IdentityMode } from '../../constants/identity.js'
import { QianmoResident } from '../../services/qianmo/resident.js'
import {
  DEFAULT_RESIDENT_ACTIVITY_TIME_JUMP_FACTOR,
  ResidentActivityReporter,
} from '@qianmo/resident/activity'
import type { ResidentTimingEvent } from '@qianmo/resident/timings'
import { assertTeamName, isReservedDeviceName } from '@qianmo/adapter/names'
import { remoteSnapshotWriter } from '@qianmo/backup'
import {
  openAuditTrail,
  routerTrailSink,
  transportTrailSink,
} from '../../services/qianmo/auditTrail.js'
import {
  NodeCapabilities,
  SIGNED_TASK_POLICY,
  StaticPublicKeyDirectory,
} from '@qianmo/capability'
import { isValidSegment } from '@qianmo/protocol'
import { pskFromEnv } from '@qianmo/transport'
import {
  loadOrCreateNodeKeys,
  parseTrustedKey,
} from '../../services/qianmo/nodeIdentity.js'
import { residentOptionValue } from './residentArgs.js'

export const MAX_PENDING_TIMING_EVENTS = 1_024

interface ResidentTimingWriter {
  write(event: ResidentTimingEvent): void
  close(): Promise<void>
}

export function createResidentTimingWriter(
  path: string,
  onError: (error: unknown) => void,
): ResidentTimingWriter {
  let queue: string[] = []
  let pending = 0
  let writing: Promise<void> | null = null
  let closed = false
  let overflowReported = false

  const drain = (): void => {
    if (writing !== null || queue.length === 0) return
    const batch = queue
    queue = []
    writing = appendFile(path, batch.join(''))
      .catch(onError)
      .finally(() => {
        pending -= batch.length
        writing = null
        drain()
      })
  }

  return {
    write(event): void {
      if (closed) return
      if (pending >= MAX_PENDING_TIMING_EVENTS) {
        if (!overflowReported) {
          overflowReported = true
          onError(new Error('resident timing writer queue overflow'))
        }
        return
      }
      queue.push(`${JSON.stringify(event)}\n`)
      pending++
      queueMicrotask(drain)
    },
    async close(): Promise<void> {
      closed = true
      drain()
      while (pending > 0) {
        const current = writing
        if (current !== null) await current
        else drain()
      }
    },
  }
}

interface ResidentCliConfig {
  readonly node: string
  readonly team: string
  readonly agents: readonly { agent: string; cwd: string }[]
  readonly port?: number
  readonly hostname?: string
  readonly unix?: string
  readonly activityUrl?: string
  readonly activityReconnectFactor?: number
  readonly timings?: string
  /** `<node>=<publicKey>` pairs this node will accept capabilities from. */
  readonly trusted: readonly (readonly [string, string])[]
  /** Require `write-limited` for work, rather than admitting unsigned tasks. */
  readonly requireSignedTasks: boolean
  /** Base URL of the host-side backup service (P4.4). */
  readonly backupUrl?: string
  /** Gap between scheduled workspace snapshots. */
  readonly backupIntervalMs?: number
}

export function parseResidentArgs(
  args: readonly string[],
  identity: IdentityMode = IDENTITY_MODE,
): ResidentCliConfig {
  let node: string | undefined
  let team: string | undefined
  let port: number | undefined
  let hostname: string | undefined
  let unix: string | undefined
  let activityUrl: string | undefined
  let activityReconnectFactor: number | undefined
  let timings: string | undefined
  let requireSignedTasks = false
  let backupUrl: string | undefined
  let backupIntervalMs: number | undefined
  const trusted: Array<readonly [string, string]> = []
  const agents: Array<{ agent: string; cwd: string }> = []

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === '--node' || arg?.startsWith('--node=')) {
      const parsed = residentOptionValue(args, index, '--node')
      node = parsed.value
      index = parsed.next
    } else if (arg === '--team' || arg?.startsWith('--team=')) {
      const parsed = residentOptionValue(args, index, '--team')
      team = parsed.value
      index = parsed.next
    } else if (arg === '--agent' || arg?.startsWith('--agent=')) {
      const parsed = residentOptionValue(args, index, '--agent')
      const separator = parsed.value.indexOf('=')
      if (separator <= 0) {
        throw new Error('--agent must be <name>=<absolute-cwd>')
      }
      const agent = parsed.value.slice(0, separator)
      const cwd = parsed.value.slice(separator + 1)
      if (!isValidSegment(agent) || isReservedDeviceName(agent)) {
        throw new Error(`invalid resident agent ${JSON.stringify(agent)}`)
      }
      if (!isAbsolute(cwd))
        throw new Error('resident agent cwd must be absolute')
      agents.push({ agent, cwd: resolve(cwd) })
      index = parsed.next
    } else if (arg === '--port' || arg?.startsWith('--port=')) {
      const parsed = residentOptionValue(args, index, '--port')
      const number = Number(parsed.value)
      if (!Number.isInteger(number) || number < 0 || number > 65_535) {
        throw new Error('--port must be an integer from 0 to 65535')
      }
      port = number
      index = parsed.next
    } else if (arg === '--hostname' || arg?.startsWith('--hostname=')) {
      const parsed = residentOptionValue(args, index, '--hostname')
      if (parsed.value.trim() === '')
        throw new Error('--hostname must not be empty')
      hostname = parsed.value
      index = parsed.next
    } else if (arg === '--unix' || arg?.startsWith('--unix=')) {
      const parsed = residentOptionValue(args, index, '--unix')
      if (!isAbsolute(parsed.value)) {
        throw new Error('--unix must be an absolute path')
      }
      unix = resolve(parsed.value)
      index = parsed.next
    } else if (arg === '--activity-url' || arg?.startsWith('--activity-url=')) {
      const parsed = residentOptionValue(args, index, '--activity-url')
      const url = new URL(parsed.value)
      if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
        throw new Error('--activity-url must use ws or wss')
      }
      activityUrl = url.toString()
      index = parsed.next
    } else if (
      arg === '--activity-reconnect-factor' ||
      arg?.startsWith('--activity-reconnect-factor=')
    ) {
      const parsed = residentOptionValue(
        args,
        index,
        '--activity-reconnect-factor',
      )
      const factor = Number(parsed.value)
      if (!Number.isFinite(factor) || factor <= 1) {
        throw new Error('--activity-reconnect-factor must be greater than 1')
      }
      activityReconnectFactor = factor
      index = parsed.next
    } else if (arg === '--trust' || arg?.startsWith('--trust=')) {
      const parsed = residentOptionValue(args, index, '--trust')
      trusted.push(parseTrustedKey(parsed.value))
      index = parsed.next
    } else if (arg === '--require-signed-tasks') {
      requireSignedTasks = true
    } else if (arg === '--backup-url' || arg?.startsWith('--backup-url=')) {
      const parsed = residentOptionValue(args, index, '--backup-url')
      const url = new URL(parsed.value)
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error('--backup-url must use http or https')
      }
      backupUrl = url.toString()
      index = parsed.next
    } else if (
      arg === '--backup-interval-ms' ||
      arg?.startsWith('--backup-interval-ms=')
    ) {
      const parsed = residentOptionValue(args, index, '--backup-interval-ms')
      const interval = Number(parsed.value)
      if (!Number.isInteger(interval) || interval < 1_000) {
        throw new Error('--backup-interval-ms must be an integer >= 1000')
      }
      backupIntervalMs = interval
      index = parsed.next
    } else if (arg === '--timings' || arg?.startsWith('--timings=')) {
      const parsed = residentOptionValue(args, index, '--timings')
      if (!isAbsolute(parsed.value)) {
        throw new Error('--timings must be an absolute path')
      }
      timings = resolve(parsed.value)
      index = parsed.next
    } else {
      throw new Error(`unknown resident option ${String(arg)}`)
    }
  }

  if (identity !== 'qianmo') {
    throw new Error('resident mode requires OCC_IDENTITY=qianmo')
  }
  if (!isValidSegment(node) || isReservedDeviceName(node)) {
    throw new Error('resident --node must be a valid non-reserved segment')
  }
  if (team === undefined) throw new Error('resident --team is required')
  assertTeamName(team)
  if (agents.length === 0)
    throw new Error('resident requires at least one --agent')
  if (new Set(agents.map(agent => agent.agent)).size !== agents.length) {
    throw new Error('resident agent names must be unique')
  }
  if (port !== undefined && unix !== undefined) {
    throw new Error('resident takes either --port or --unix, not both')
  }
  if (port === undefined && unix === undefined) {
    throw new Error('resident requires --port or --unix')
  }
  if (port !== undefined && hostname === undefined) {
    throw new Error('resident TCP listen requires explicit --hostname')
  }
  if (unix !== undefined && hostname !== undefined) {
    throw new Error('--hostname is only valid with --port')
  }
  if (activityReconnectFactor !== undefined && activityUrl === undefined) {
    throw new Error('--activity-reconnect-factor requires --activity-url')
  }
  if (backupIntervalMs !== undefined && backupUrl === undefined) {
    throw new Error('--backup-interval-ms requires --backup-url')
  }
  return {
    node,
    team,
    agents,
    ...(port === undefined ? {} : { port }),
    ...(hostname === undefined ? {} : { hostname }),
    ...(unix === undefined ? {} : { unix }),
    ...(activityUrl === undefined
      ? {}
      : {
          activityUrl,
          activityReconnectFactor:
            activityReconnectFactor ??
            DEFAULT_RESIDENT_ACTIVITY_TIME_JUMP_FACTOR,
        }),
    ...(timings === undefined ? {} : { timings }),
    trusted,
    requireSignedTasks,
    ...(backupUrl === undefined ? {} : { backupUrl }),
    ...(backupIntervalMs === undefined ? {} : { backupIntervalMs }),
  }
}

export function assertResidentRuntime(
  bunAvailable: boolean = typeof Bun !== 'undefined',
): void {
  if (!bunAvailable) {
    throw new Error('resident mode requires the Bun runtime')
  }
}

export async function runResident(args: readonly string[]): Promise<void> {
  assertResidentRuntime()
  const config = parseResidentArgs(args)
  const psk = pskFromEnv()
  const activity =
    config.activityUrl === undefined
      ? null
      : new ResidentActivityReporter({
          node: config.node,
          endpoint: { url: config.activityUrl },
          psk,
          ...(config.activityReconnectFactor === undefined
            ? {}
            : {
                reconnectTimeJumpFactor: config.activityReconnectFactor,
              }),
        })
  if (activity !== null) {
    void activity.connect().catch(error => {
      console.error('[resident activity]', error)
    })
  }
  let timingWriteFailed = false
  const reportTimingError = (error: unknown): void => {
    if (timingWriteFailed) return
    timingWriteFailed = true
    console.error('[resident timing]', error)
  }
  const timingWriter =
    config.timings === undefined
      ? null
      : createResidentTimingWriter(config.timings, reportTimingError)
  // The node's own identity, created on first run and never replaced (P4.3).
  // Its public half is printed rather than published: M0 has no key
  // distribution, so whoever registers this agent copies the key into the
  // registry by hand, and a node that quietly learned keys from its peers
  // would be a node any peer could impersonate.
  const keys = loadOrCreateNodeKeys(config.node)
  const directory = new StaticPublicKeyDirectory(config.trusted)
  // Its own key is always trusted: rule S-1 accepts `user-confirmed` only when
  // this node signed it, which means verifying its own signature.
  directory.put(config.node, keys.publicKey)
  const capability = new NodeCapabilities({
    node: config.node,
    directory,
    keys,
    ...(config.requireSignedTasks ? { policy: SIGNED_TASK_POLICY } : {}),
  })
  process.stdout.write(
    `${JSON.stringify({
      node: config.node,
      publicKey: keys.publicKey,
      requireSignedTasks: config.requireSignedTasks,
      trusts: config.trusted.map(([node]) => node),
    })}\n`,
  )

  // The write-only backup credential comes from the environment, never from a
  // flag: a token on a command line is a token in every process listing on the
  // machine. Same injection point discipline as the transport PSK.
  const backupToken = process.env['QIANMO_BACKUP_WRITE_TOKEN']
  if (config.backupUrl !== undefined && (backupToken ?? '') === '') {
    throw new Error('--backup-url requires QIANMO_BACKUP_WRITE_TOKEN')
  }
  const backup =
    config.backupUrl === undefined
      ? undefined
      : {
          writer: remoteSnapshotWriter({
            url: config.backupUrl,
            token: backupToken as string,
          }),
          ...(config.backupIntervalMs === undefined
            ? {}
            : { intervalMs: config.backupIntervalMs }),
        }

  // The durable trail (P7.2). Opened here rather than inside the node because
  // this is the layer that owns paths, and because a trail is per *process*:
  // two residents on one machine each continue their own file.
  const trail = openAuditTrail()

  const resident = new QianmoResident({
    node: config.node,
    team: config.team,
    agents: config.agents,
    psk,
    capability,
    auditSink: routerTrailSink(trail, config.node),
    transportEvents: transportTrailSink(trail, config.node),
    ...(backup === undefined ? {} : { backup }),
    listen: {
      ...(config.port === undefined ? {} : { port: config.port }),
      ...(config.hostname === undefined ? {} : { hostname: config.hostname }),
      ...(config.unix === undefined ? {} : { unix: config.unix }),
    },
    onActivity: async active => {
      try {
        await activity?.report(active)
      } catch (error) {
        console.error('[resident activity]', error)
      }
    },
    ...(config.activityUrl === undefined
      ? {}
      : {
          activityReconnectFactor:
            config.activityReconnectFactor ??
            DEFAULT_RESIDENT_ACTIVITY_TIME_JUMP_FACTOR,
        }),
    ...(timingWriter === null
      ? {}
      : {
          onTiming: (event: ResidentTimingEvent) => timingWriter.write(event),
        }),
    onError: error => {
      console.error('[resident]', error)
    },
  })

  const stop = (): void => resident.stop()
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)
  try {
    await resident.run()
  } finally {
    trail.close()
    await timingWriter?.close()
    await activity?.close()
  }
}
