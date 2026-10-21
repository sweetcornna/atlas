// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash, randomBytes } from 'node:crypto'
import {
  type AccountBook,
  type ConsoleResult,
  type DirectionActor,
  type HandoffDeviceRefusal,
  type HandoffDevicesPort,
  type HandoffDeviceView,
  type HandoffPairingResult,
} from '@qianmo/console'
import { qianmoConfigPath } from '@qianmo/paths'
import { handoffShellArgument } from './handoffHub.js'
import { FileLedger } from './consoleAccountsStore.js'

/**
 * `kind` is written only for a client device: a ledger without one stays
 * readable by builds from before the client (P37.2), and a row without it is
 * a `qm handoff` device.
 */
interface Device extends Omit<HandoffDeviceView, 'tasks' | 'kind'> {
  readonly hash: string
  readonly kind?: 'client'
}
interface Pairing {
  readonly hash: string
  readonly owner: string
  readonly console: string
  readonly expiresAt: number
  readonly attempts: number
  readonly used: boolean
}
interface Snapshot {
  readonly version: 1
  readonly devices: readonly Device[]
  readonly pairings: readonly Pairing[]
}
const digest = (value: string): string =>
  createHash('sha256').update(value).digest('hex')
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
const base32 = (): string =>
  [...randomBytes(12)].map(byte => BASE32[byte & 31]).join('')
const refused = <T>(message = '配对码无效或已过期'): ConsoleResult<T> => ({
  ok: false,
  failure: { code: 'rejected', message },
})

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function timestamp(value: unknown): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}
function isSnapshot(value: unknown): value is Snapshot {
  if (
    !record(value) ||
    value.version !== 1 ||
    !Array.isArray(value.devices) ||
    !Array.isArray(value.pairings) ||
    Object.keys(value).length !== 3
  )
    return false
  const devices = value.devices.every(
    (d: unknown) =>
      record(d) &&
      (Object.keys(d).length === 8 ||
        (Object.keys(d).length === 9 && d.kind === 'client')) &&
      typeof d.deviceId === 'string' &&
      /^d-[a-z2-7]{12}$/.test(d.deviceId) &&
      typeof d.hash === 'string' &&
      /^[a-f0-9]{64}$/.test(d.hash) &&
      typeof d.owner === 'string' &&
      d.owner.length > 0 &&
      typeof d.name === 'string' &&
      d.name.length > 0 &&
      (d.platform === null || typeof d.platform === 'string') &&
      timestamp(d.createdAt) &&
      (d.lastSeenAt === null || timestamp(d.lastSeenAt)) &&
      (d.revokedAt === null || timestamp(d.revokedAt)),
  )
  const pairings = value.pairings.every(
    (p: unknown) =>
      record(p) &&
      Object.keys(p).length === 6 &&
      typeof p.hash === 'string' &&
      /^[a-f0-9]{64}$/.test(p.hash) &&
      typeof p.owner === 'string' &&
      p.owner.length > 0 &&
      typeof p.console === 'string' &&
      timestamp(p.expiresAt) &&
      typeof p.attempts === 'number' &&
      Number.isSafeInteger(p.attempts) &&
      p.attempts >= 0 &&
      typeof p.used === 'boolean',
  )
  return devices && pairings
}

/** Shares the handoff ledger's single-writer lifetime; every mutation is fsynced. */
export function openConsoleHandoffDevices(
  options: {
    readonly path?: string
    readonly accounts?: AccountBook
    readonly now?: () => number
    readonly taskCount?: (deviceId: string) => number
    /**
     * Which local command the pairing dialog spells out: `qm handoff login`
     * (default) or, on a console without handoff, the `qmo` client's sign-in.
     * With accounts the dialog shows the client's line either way.
     */
    readonly pairWith?: 'handoff' | 'client'
  } = {},
): HandoffDevicesPort & { close(): void } {
  const store = new FileLedger(
    options.path ?? qianmoConfigPath('qianmo', 'handoff', 'devices.ndjson'),
  )
  const now = options.now ?? Date.now
  let state: Snapshot = { version: 1, devices: [], pairings: [] }
  const content = store.read()
  if (content !== null) {
    // A torn revocation must never be silently skipped.
    if (!content.endsWith('\n')) throw new Error('设备账本尾部不完整')
    for (const line of content.trim().split('\n')) {
      if (!line) continue
      const value: unknown = JSON.parse(line)
      if (!isSnapshot(value)) throw new Error('设备账本损坏')
      const parsed = value
      state = parsed
    }
  }
  let failed = false
  const persist = (next: Snapshot): void => {
    if (failed) throw new Error('设备账本不可用')
    try {
      store.append(`${JSON.stringify(next)}\n`)
      state = next
    } catch (error) {
      failed = true
      throw error
    }
  }
  const activeOwner = (owner: string): boolean => {
    if (owner === 'legacy:admin') return true
    const result = options.accounts?.list()
    return (
      result?.ok === true &&
      result.value.accounts.some(
        a => a.subject === owner && a.state === 'active' && a.role !== 'viewer',
      )
    )
  }
  const view = ({ hash: _hash, kind, ...device }: Device): HandoffDeviceView => ({
    ...device,
    kind: kind ?? 'handoff',
    tasks: options.taskCount?.(device.deviceId) ?? 0,
  })
  // An account that is revoked or reset takes its devices with it: a reset
  // person comes back with a new credential, never with the old devices.
  const unsubscribe = options.accounts?.onAccountEnded(({ subject }) => {
    if (failed) return
    const at = now()
    if (!state.devices.some(d => d.owner === subject && d.revokedAt === null))
      return
    persist({
      ...state,
      devices: state.devices.map(d =>
        d.owner === subject && d.revokedAt === null ? { ...d, revokedAt: at } : d,
      ),
    })
  })
  const rates = new Map<string, { start: number; count: number }>()
  return {
    async listDevices() {
      return failed
        ? {
            ok: false,
            failure: { code: 'unreachable', message: '设备账本不可用' },
          }
        : { ok: true, value: state.devices.map(view) }
    },
    async issuePairing(actor: DirectionActor, consoleUrl?: string) {
      if (
        (actor.role !== 'member' &&
          actor.role !== 'ops' &&
          actor.subject !== 'legacy:admin') ||
        !activeOwner(actor.subject)
      )
        return refused('需要成员或运维账号')
      let url: URL
      try {
        url = new URL(consoleUrl ?? '')
      } catch {
        return refused('没有控制台对外地址')
      }
      if (
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        !['http:', 'https:'].includes(url.protocol)
      )
        return refused('控制台地址不合法')
      const code = base32()
      const formatted = code.match(/.{4}/g)!.join('-')
      const expiresAt = now() + 10 * 60_000
      persist({
        ...state,
        pairings: [
          ...state.pairings.filter(
            p => !p.used && p.expiresAt > now() && p.attempts < 5,
          ),
          {
            hash: digest(code),
            owner: actor.subject,
            console: url.toString().replace(/\/$/, ''),
            expiresAt,
            attempts: 0,
            used: false,
          },
        ],
      })
      const hub = handoffShellArgument(url.toString().replace(/\/$/, ''))
      // The client reads the code from its prompt: a command line is
      // readable by every user of the computer (`/proc/*/cmdline`).
      const client = `qmo sign-in ${hub}`
      return {
        ok: true,
        value: {
          code: formatted,
          expiresAt,
          ...(options.pairWith === 'client'
            ? { command: client }
            : {
                command: `qm handoff login ${hub} --code ${formatted}`,
                ...(options.accounts === undefined
                  ? {}
                  : { clientCommand: client }),
              }),
        },
      }
    },
    async pair(input, remoteAddr) {
      const time = now()
      const rate = rates.get(remoteAddr)
      const bucket =
        rate !== undefined && time - rate.start < 60_000
          ? rate
          : { start: time, count: 0 }
      if (rates.size > 10_000)
        for (const [key, value] of rates)
          if (time - value.start >= 60_000) rates.delete(key)
      rates.set(remoteAddr, bucket)
      if (++bucket.count > 10)
        return {
          ...refused<HandoffPairingResult>('配对过于频繁'),
          retryAfter: Math.ceil((60_000 - time + bucket.start) / 1000),
        }
      const code = input.code.replaceAll('-', '').toUpperCase()
      const pairing = state.pairings.find(p => p.hash === digest(code))
      if (pairing === undefined) {
        // With only a full-code hash there is no identifier for an arbitrary
        // wrong string. Recognize a single-character typo without persisting
        // a short prefix hash that would weaken the code's offline entropy.
        const candidates = new Set<Pairing>()
        if (/^[A-Z0-9]{12}$/.test(code)) {
          const active = new Map(
            state.pairings
              .filter(p => !p.used && p.expiresAt > time && p.attempts < 5)
              .map(p => [p.hash, p]),
          )
          for (let index = 0; index < code.length; index++)
            for (const character of BASE32) {
              if (character === code[index]) continue
              const match = active.get(
                digest(
                  `${code.slice(0, index)}${character}${code.slice(index + 1)}`,
                ),
              )
              if (match) candidates.add(match)
            }
        }
        if (candidates.size === 1) {
          const matched = [...candidates][0]
          persist({
            ...state,
            pairings: state.pairings.map(p =>
              p === matched ? { ...p, attempts: p.attempts + 1 } : p,
            ),
          })
        }
        return refused()
      }
      if (
        failed ||
        pairing.used ||
        pairing.attempts >= 5 ||
        time >= pairing.expiresAt ||
        !activeOwner(pairing.owner)
      )
        return refused()
      if (
        !input.name.trim() ||
        input.name.length > 128 ||
        [...input.name].some(char => {
          const value = char.codePointAt(0)!
          return value < 32 || value === 127
        }) ||
        (input.platform !== null && !/^[a-z0-9_-]{1,64}$/.test(input.platform))
      )
        return refused('设备名称或平台不合法')
      let deviceId: string
      do {
        deviceId = `d-${base32().toLowerCase()}`
      } while (state.devices.some(d => d.deviceId === deviceId))
      const token = `qmd_${randomBytes(32).toString('base64url')}`
      const device: Device = {
        deviceId,
        name: input.name.trim(),
        platform: input.platform,
        owner: pairing.owner,
        hash: digest(token),
        ...(input.kind === 'client' ? { kind: 'client' as const } : {}),
        createdAt: time,
        lastSeenAt: null,
        revokedAt: null,
      }
      persist({
        version: 1,
        devices: [...state.devices, device],
        pairings: state.pairings.map(p =>
          p === pairing ? { ...p, used: true } : p,
        ),
      })
      return {
        ok: true,
        value: {
          deviceId,
          owner: pairing.owner,
          kind: device.kind ?? 'handoff',
          name: device.name,
          token,
          console: pairing.console,
        },
      }
    },
    authenticate(token) {
      if (failed || !/^qmd_[A-Za-z0-9_-]{43}$/.test(token)) return null
      const device = state.devices.find(d => d.hash === digest(token))
      if (!device || device.revokedAt !== null || !activeOwner(device.owner))
        return null
      if (device.lastSeenAt === null || now() - device.lastSeenAt >= 60_000) {
        try {
          persist({
            ...state,
            devices: state.devices.map(d =>
              d === device ? { ...d, lastSeenAt: now() } : d,
            ),
          })
        } catch {
          return null
        }
      }
      return {
        deviceId: device.deviceId,
        owner: device.owner,
        kind: device.kind ?? 'handoff',
      }
    },
    refusalOf(token): HandoffDeviceRefusal {
      const device = /^qmd_[A-Za-z0-9_-]{43}$/.test(token)
        ? state.devices.find(d => d.hash === digest(token))
        : undefined
      if (device === undefined) return 'unauthorized'
      if (device.revokedAt !== null) return 'device_revoked'
      return activeOwner(device.owner) ? 'unauthorized' : 'owner_inactive'
    },
    async revokeDevice(deviceId, actor) {
      const device = state.devices.find(d => d.deviceId === deviceId)
      if (!device)
        return {
          ok: false,
          failure: { code: 'not_found', message: '设备不存在' },
        }
      if (
        actor.subject !== 'legacy:admin' &&
        actor.role !== 'ops' &&
        !(actor.role === 'member' && actor.subject === device.owner)
      )
        return {
          ok: false,
          failure: { code: 'refused', message: '只能吊销自己签发的设备' },
        }
      const revoked = { ...device, revokedAt: device.revokedAt ?? now() }
      persist({
        ...state,
        devices: state.devices.map(d => (d === device ? revoked : d)),
      })
      return { ok: true, value: view(revoked) }
    },
    close() {
      unsubscribe?.()
      store.close()
    },
  }
}
