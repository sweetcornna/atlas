// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { lookup } from 'node:dns'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { isIP } from 'node:net'
import {
  A2A_MEDIA_TYPE,
  A2A_VERSION,
  type A2aPeer,
  MAX_A2A_BYTES,
} from './types.js'

/** URL and IP policy come only from trusted deployment configuration, never an AgentCard. */
export function peerUrl(peer: A2aPeer): URL {
  const url = new URL(peer.url)
  if (url.username || url.password || url.search || url.hash)
    throw new Error('peer URL must not contain credentials, query or fragment')
  const host = url.hostname.replace(/^\[|\]$/g, '')
  const loopback = host === '127.0.0.1' || host === '::1'
  if (
    url.protocol !== 'https:' &&
    !(url.protocol === 'http:' && loopback && peer.allowLoopbackHttp)
  )
    throw new Error(
      'peer requires HTTPS (literal loopback HTTP must be explicitly enabled)',
    )
  if (!peer.addresses.length || peer.addresses.some(address => !isIP(address)))
    throw new Error('peer requires an explicit IP allowlist')
  if (isIP(host) && !peer.addresses.includes(host))
    throw new Error('peer IP is not allowed')
  return url
}
/** Pins the address selected by DNS at the socket boundary; never follows redirects. */
export async function requestPeer(
  peer: A2aPeer,
  path: string,
  body?: unknown,
  timeoutMs = 30_000,
): Promise<unknown> {
  const base = peerUrl(peer)
  const url = new URL(`${base.href.replace(/\/$/, '')}${path}`)
  return new Promise((resolve, reject) => {
    const encoded = body === undefined ? undefined : JSON.stringify(body)
    if (encoded && Buffer.byteLength(encoded) > MAX_A2A_BYTES)
      return reject(new Error('A2A request exceeds size limit'))
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
      url,
      {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          'Content-Type': A2A_MEDIA_TYPE,
          Accept: A2A_MEDIA_TYPE,
          'A2A-Version': A2A_VERSION,
          Authorization: `Bearer ${peer.token}`,
        },
        agent: false,
        lookup: (hostname, options, callback) => {
          lookup(hostname, { all: true }, (error, addresses) => {
            if (error) return callback(error, '', 4)
            if (
              !addresses.length ||
              addresses.some(item => !peer.addresses.includes(item.address))
            )
              return callback(
                new Error('peer DNS answer is outside allowlist'),
                '',
                4,
              )
            const selected = addresses[0]!
            if (options.all) callback(null, addresses)
            else callback(null, selected.address, selected.family)
          })
        },
      },
      response => {
        const chunks: Buffer[] = []
        let bytes = 0
        response.on('data', (chunk: Buffer) => {
          bytes += chunk.length
          if (bytes > MAX_A2A_BYTES)
            request.destroy(new Error('A2A response exceeds size limit'))
          else chunks.push(chunk)
        })
        response.on('error', reject)
        response.on('end', () => {
          const status = response.statusCode ?? 0
          if (status < 200 || status >= 300)
            return reject(new Error(`A2A peer returned HTTP ${status}`))
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString()))
          } catch {
            reject(new Error('A2A peer returned invalid JSON'))
          }
        })
      },
    )
    const timeout = setTimeout(
      () => request.destroy(new Error('A2A peer deadline exceeded')),
      timeoutMs,
    )
    request.on('close', () => clearTimeout(timeout))
    request.on('error', reject)
    request.end(encoded)
  })
}
