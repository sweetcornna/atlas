// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as fs from 'node:fs'
import * as dns from 'node:dns/promises'
import * as net from 'node:net'
import * as https from 'node:https'
import * as http from 'node:http'
import * as tls from 'node:tls'
import { LIMITS } from '@qianmo/protocol'

export type OutboundProtocol = 'imaps' | 'smtps' | 'starttls' | 'https' | 'http'
export interface OutboundSettings {
  readonly allowAddresses?: readonly string[]
  readonly allowPorts?: readonly {
    readonly protocol: OutboundProtocol
    readonly port: number
  }[]
}
export interface OutboundOptions extends OutboundSettings {
  readonly lookup?: (
    host: string,
  ) => Promise<readonly { address: string; family: number }[]>
  /** Fixture CA only; never disable certificate verification. */
  readonly ca?: string
  readonly fetch?: (url: string, init: RequestInit) => Promise<Response>
}
const blocked = new net.BlockList()
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  blocked.addSubnet(address, prefix, 'ipv4')
for (const [address, prefix] of [
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['3fff::', 20],
] as const)
  blocked.addSubnet(address, prefix, 'ipv6')
const global6 = new net.BlockList()
global6.addSubnet('2000::', 3, 'ipv6')

export function publicAddress(address: string): boolean {
  const family = net.isIP(address)
  if (family === 4) return !blocked.check(address, 'ipv4')
  if (family === 6)
    return global6.check(address, 'ipv6') && !blocked.check(address, 'ipv6')
  return false
}

/** Errors from this boundary are fixed sentences, never remote text or URLs. */
export class OutboundPolicy {
  readonly #options: OutboundOptions
  constructor(options: OutboundOptions = {}) {
    this.#options = options
  }
  withFetch(
    fetcher?: (url: string, init: RequestInit) => Promise<Response>,
  ): OutboundPolicy {
    return fetcher
      ? new OutboundPolicy({ ...this.#options, fetch: fetcher })
      : this
  }
  get ca(): string | undefined {
    return this.#options.ca
  }
  checkEndpoint(protocol: OutboundProtocol, host: string, port: number): void {
    const standard = {
      imaps: 993,
      smtps: 465,
      starttls: 587,
      https: 443,
      http: 0,
    }
    if (
      !host ||
      /[\s/@?#\\]/.test(host) ||
      [...host].some(char => char.charCodeAt(0) < 32) ||
      !Number.isSafeInteger(port) ||
      port < 1 ||
      port > 65535
    )
      throw new Error('出站地址无效')
    if (
      port !== standard[protocol] &&
      !this.#options.allowPorts?.some(
        v => v.protocol === protocol && v.port === port,
      )
    )
      throw new Error('出站协议或端口未获运维允许')
  }
  url(raw: string): URL {
    let url: URL
    try {
      url = new URL(raw)
    } catch {
      throw new Error('出站地址无效')
    }
    if (
      !['https:', 'http:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.hash
    )
      throw new Error('出站地址无效')
    this.checkEndpoint(
      url.protocol === 'https:' ? 'https' : 'http',
      url.hostname.replace(/^\[|\]$/g, ''),
      Number(url.port || (url.protocol === 'https:' ? 443 : 80)),
    )
    return url
  }
  async resolve(
    protocol: OutboundProtocol,
    host: string,
    port: number,
  ): Promise<{ address: string; family: number }> {
    host = host.replace(/^\[|\]$/g, '')
    this.checkEndpoint(protocol, host, port)
    let rows: readonly { address: string; family: number }[]
    try {
      rows = net.isIP(host)
        ? [{ address: host, family: net.isIP(host) }]
        : await (
            this.#options.lookup ?? (name => dns.lookup(name, { all: true }))
          )(host)
    } catch {
      throw new Error('出站 DNS 解析失败')
    }
    if (
      !rows.length ||
      rows.some(
        v =>
          !net.isIP(v.address) ||
          (!publicAddress(v.address) &&
            !this.#options.allowAddresses?.includes(v.address)),
      )
    )
      throw new Error('出站地址被策略拒绝')
    return rows[0]!
  }
  async connect(
    protocol: 'imaps' | 'smtps' | 'starttls',
    host: string,
    port: number,
  ): Promise<tls.TLSSocket | net.Socket> {
    const resolved = await this.resolve(protocol, host, port)
    const { promise, resolve, reject } = Promise.withResolvers<
      tls.TLSSocket | net.Socket
    >()
    const socket =
      protocol === 'starttls'
        ? net.connect({ host: resolved.address, port })
        : tls.connect({
            host: resolved.address,
            port,
            servername: net.isIP(host) ? undefined : host,
            ca: this.ca,
            minVersion: 'TLSv1.2',
          })
    const timer = setTimeout(
      () => socket.destroy(new Error('出站连接超时')),
      LIMITS.connectorTimeoutMs,
    )
    socket.once(protocol === 'starttls' ? 'connect' : 'secureConnect', () => {
      clearTimeout(timer)
      resolve(socket)
    })
    socket.once('error', () => {
      clearTimeout(timer)
      reject(new Error('出站连接失败'))
    })
    return promise
  }
  async #fetch(
    url: URL,
    init: RequestInit,
    beforeDispatch?: () => void,
  ): Promise<Response> {
    const endpoint = await this.resolve(
      url.protocol === 'https:' ? 'https' : 'http',
      url.hostname,
      Number(url.port || (url.protocol === 'https:' ? 443 : 80)),
    )
    beforeDispatch?.()
    if (this.#options.fetch)
      return this.#options.fetch(url.toString(), {
        ...init,
        redirect: 'manual',
      })
    const { promise, resolve, reject } = Promise.withResolvers<Response>()
    const headers = Object.fromEntries(new Headers(init.headers))
    // Pin the resolved address at the actual socket dial; a second DNS lookup cannot rebind.
    const request = (url.protocol === 'https:' ? https : http).request(
      url,
      {
        method: init.method ?? 'GET',
        headers,
        signal: init.signal ?? AbortSignal.timeout(LIMITS.connectorTimeoutMs),
        agent: false,
        family: endpoint.family,
        ca: this.ca,
        minVersion: 'TLSv1.2',
        maxHeaderSize: LIMITS.connectorLineBytes,
        lookup: (_host, _opts, callback) =>
          callback(null, endpoint.address, endpoint.family),
      },
      response => {
        const responseHeaders = new Headers()
        for (const [key, value] of Object.entries(response.headers))
          if (value !== undefined)
            responseHeaders.set(
              key,
              Array.isArray(value) ? value.join(', ') : value,
            )
        const body = new ReadableStream<Uint8Array>(
          {
            start(controller) {
              response.on('data', (chunk: Buffer) => {
                response.pause()
                controller.enqueue(chunk)
              })
              response.on('end', () => controller.close())
              response.on('error', () =>
                controller.error(new Error('出站响应失败')),
              )
            },
            pull() {
              response.resume()
            },
            cancel() {
              response.destroy()
              request.destroy()
            },
          },
          { highWaterMark: 0 },
        )
        resolve(
          new Response(
            [204, 304].includes(response.statusCode ?? 0) ? null : body,
            { status: response.statusCode ?? 502, headers: responseHeaders },
          ),
        )
      },
    )
    request.on('error', () => reject(new Error('出站请求失败')))
    if (init.body !== undefined && init.body !== null) {
      if (typeof init.body !== 'string') {
        request.destroy()
        throw new Error('出站请求体无效')
      }
      request.write(init.body)
    }
    request.end()
    return promise
  }
  async request(
    raw: string,
    init: RequestInit = {},
    redirects = true,
    beforeDispatch?: () => void,
  ): Promise<Response> {
    let url = this.url(raw)
    let next = { ...init }
    for (let hop = 0; hop <= LIMITS.connectorRedirects; hop++) {
      const response = await this.#fetch(url, next, beforeDispatch)
      if (!redirects || ![301, 302, 303, 307, 308].includes(response.status))
        return response
      await response.body?.cancel()
      const location = response.headers.get('location')
      if (!location) throw new Error('出站重定向无效')
      let target: URL
      try {
        target = this.url(new URL(location, url).toString())
      } catch {
        throw new Error('出站重定向被策略拒绝')
      }
      if (target.origin !== url.origin) {
        const headers = new Headers(next.headers)
        for (const name of ['authorization', 'proxy-authorization', 'cookie'])
          headers.delete(name)
        // Mutation bodies can also contain credentials/private data. Never forward them across origins.
        if (!['GET', 'HEAD'].includes(next.method ?? 'GET'))
          throw new Error('出站跨源写入重定向被拒绝')
        next = { ...next, headers }
      }
      url = target
    }
    throw new Error('出站重定向过多')
  }
}

export async function boundedText(
  response: Response,
  limit = LIMITS.connectorResponseBytes,
): Promise<string> {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > limit) throw new Error('出站响应超过上限')
      chunks.push(chunk.value)
    }
    return Buffer.concat(chunks).toString('utf8')
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

/** Owner-only deployment settings; absent means deny all exceptions. */
export function loadOutboundPolicy(file: string): OutboundPolicy {
  let raw: unknown
  try {
    const stat = fs.lstatSync(file)
    if (
      !stat.isFile() ||
      (stat.mode & 0o077) !== 0 ||
      (process.getuid && stat.uid !== process.getuid())
    )
      throw new Error()
    raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return new OutboundPolicy()
    throw new Error('出站策略配置不可用')
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new Error('出站策略配置无效')
  const value = raw as Record<string, unknown>
  if (
    Object.keys(value).some(v => !['allowAddresses', 'allowPorts'].includes(v))
  )
    throw new Error('出站策略配置无效')
  const addresses = value['allowAddresses'] ?? [],
    ports = value['allowPorts'] ?? []
  if (
    !Array.isArray(addresses) ||
    addresses.some(v => typeof v !== 'string' || !net.isIP(v)) ||
    !Array.isArray(ports)
  )
    throw new Error('出站策略配置无效')
  const allowPorts: { protocol: OutboundProtocol; port: number }[] = []
  for (const rawPort of ports) {
    if (!rawPort || typeof rawPort !== 'object' || Array.isArray(rawPort))
      throw new Error('出站策略端口无效')
    const entry = rawPort as Record<string, unknown>
    if (
      Object.keys(entry).sort().join(',') !== 'port,protocol' ||
      !['imaps', 'smtps', 'starttls', 'https', 'http'].includes(
        String(entry['protocol']),
      ) ||
      typeof entry['port'] !== 'number' ||
      !Number.isSafeInteger(entry['port']) ||
      entry['port'] < 1 ||
      entry['port'] > 65535
    )
      throw new Error('出站策略端口无效')
    allowPorts.push({
      protocol: entry['protocol'] as OutboundProtocol,
      port: entry['port'],
    })
  }
  return new OutboundPolicy({
    allowAddresses: addresses as string[],
    allowPorts,
  })
}
