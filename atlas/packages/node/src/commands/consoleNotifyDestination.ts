// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

export interface NotifyAddress {
  readonly address: string
  readonly family: number
}

export interface NotifyDestinationOptions {
  readonly allowlist?: readonly string[]
  readonly resolve?: (host: string) => Promise<readonly NotifyAddress[]>
}

/** Exact hosts, optionally constrained to one port; no URL paths or wildcards. */
export function notifyAllowlist(raw: string | undefined): readonly string[] {
  if (!raw?.trim()) return []
  return raw.split(',').map(value => {
    const entry = value.trim()
    let url: URL
    try {
      url = new URL(`https://${entry}`)
    } catch {
      throw new Error('通知放行名单必须是主机名（可带端口）')
    }
    if (
      !entry ||
      entry.includes('*') ||
      /\s/.test(entry) ||
      entry.endsWith(':') ||
      entry.includes('/') ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error('通知放行名单必须是主机名（可带端口）')
    return entry
  })
}

function allowed(url: URL, entries: readonly string[]): boolean {
  return entries.some(entry => {
    const approved = new URL(`https://${entry}`)
    // URL drops an explicit :443; inspect the entry to retain its constraint.
    const port =
      /\]:(\d+)$/.exec(entry)?.[1] ??
      (!entry.startsWith('[') ? /:(\d+)$/.exec(entry)?.[1] : undefined)
    return (
      approved.hostname === url.hostname &&
      (port === undefined ||
        Number(port) ===
          Number(url.port || (url.protocol === 'https:' ? 443 : 80)))
    )
  })
}

function protectedV4(address: string): boolean {
  const [a = 0, b = 0] = address.split('.').map(Number)
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    (a === 100 && b >= 64 && b <= 127)
  )
}

function protectedAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 4) return protectedV4(address)
  if (family !== 6) return true // Unparseable resolver output fails closed.
  const normalized = new URL(
    `http://[${address.replace(/%.*/, '')}]/`,
  ).hostname.slice(1, -1)
  const halves = normalized.split('::')
  const left = halves[0]
    ? halves[0].split(':').map(v => Number.parseInt(v, 16))
    : []
  const right = halves[1]
    ? halves[1].split(':').map(v => Number.parseInt(v, 16))
    : []
  const words =
    halves.length === 1
      ? left
      : [
          ...left,
          ...Array<number>(8 - left.length - right.length).fill(0),
          ...right,
        ]
  const first = words[0]!
  if (
    (first & 0xfe00) === 0xfc00 ||
    (first & 0xffc0) === 0xfe80 ||
    (first & 0xff00) === 0xff00
  )
    return true
  if (
    words.slice(0, 5).every(v => v === 0) &&
    (words[5] === 0 || words[5] === 0xffff)
  ) {
    const high = words[6]!,
      low = words[7]!
    // IPv4-compatible and mapped forms follow the embedded IPv4 policy.
    return protectedV4(`${high >>> 8}.${high & 255}.${low >>> 8}.${low & 255}`)
  }
  return false
}

export class NotifyDestinationError extends Error {}

export function notifyChannelUrl(
  raw: string,
  options: NotifyDestinationOptions = {},
): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new NotifyDestinationError('渠道地址必须是完整 URL')
  }
  if (url.username || url.password || url.hash)
    throw new NotifyDestinationError('渠道地址不能带用户名、密码或片段')
  const approved = allowed(url, options.allowlist ?? [])
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && approved))
    throw new NotifyDestinationError('渠道只允许 HTTPS；HTTP 主机需运维放行')
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (isIP(host) && protectedAddress(host) && !approved)
    throw new NotifyDestinationError('目的地址在受保护网段，需运维放行')
  return url
}

/** All answers must pass; the selected address is used directly by the socket. */
export async function notifyDestination(
  raw: string,
  options: NotifyDestinationOptions = {},
): Promise<{ url: URL; address: NotifyAddress }> {
  const url = notifyChannelUrl(raw, options)
  const host = url.hostname.replace(/^\[|\]$/g, '')
  let addresses: readonly NotifyAddress[]
  try {
    addresses = isIP(host)
      ? [{ address: host, family: isIP(host) }]
      : await (
          options.resolve ??
          (name => lookup(name, { all: true, verbatim: true }))
        )(host)
  } catch {
    throw new NotifyDestinationError('目的主机 DNS 解析失败')
  }
  if (
    !addresses.length ||
    addresses.some(v => !isIP(v.address) || isIP(v.address) !== v.family)
  )
    throw new NotifyDestinationError('目的主机 DNS 没有有效地址')
  if (
    !allowed(url, options.allowlist ?? []) &&
    addresses.some(v => protectedAddress(v.address))
  )
    throw new NotifyDestinationError('目的地址在受保护网段，需运维放行')
  return { url, address: addresses[0]! }
}
