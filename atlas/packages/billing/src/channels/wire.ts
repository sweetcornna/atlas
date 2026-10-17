// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { ChannelError } from './types.js'

/** `fetch` as the channels use it; injectable so tests never leave the host. */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>

interface HttpResult {
  readonly status: number
  readonly headers: Headers
  readonly text: string
}

const TIMEOUT_MS = 10_000
const MAX_RESPONSE_BYTES = 1024 * 1024

/**
 * One request with a 10 s deadline, no redirects followed and a 1 MiB
 * response cap. Errors say which call failed, never what was sent.
 */
export async function send(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
  label: string,
): Promise<HttpResult> {
  const signal = AbortSignal.timeout(TIMEOUT_MS)
  let response: Response
  try {
    response = await fetchImpl(url, { ...init, redirect: 'manual', signal })
  } catch {
    throw new ChannelError(
      signal.aborted ? 'timeout' : 'network',
      signal.aborted ? `${label}：请求超时` : `${label}：网络请求失败`,
    )
  }
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel()
    throw new ChannelError('redirect', `${label}：对方返回了重定向`)
  }
  const declared = Number(response.headers.get('content-length') ?? '0')
  if (declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel()
    throw new ChannelError('too_large', `${label}：应答过大`)
  }
  let bytes: ArrayBuffer
  try {
    bytes = await response.arrayBuffer()
  } catch {
    throw new ChannelError(
      signal.aborted ? 'timeout' : 'network',
      signal.aborted ? `${label}：读取应答超时` : `${label}：读取应答失败`,
    )
  }
  if (bytes.byteLength > MAX_RESPONSE_BYTES)
    throw new ChannelError('too_large', `${label}：应答过大`)
  return {
    status: response.status,
    headers: response.headers,
    text: new TextDecoder('utf-8', { fatal: false }).decode(bytes),
  }
}

const SHANGHAI_OFFSET_MS = 8 * 3_600_000

/** `yyyy-MM-dd HH:mm:ss` in Asia/Shanghai (UTC+8, no DST). */
export function shanghaiDateTime(at: number): string {
  const iso = new Date(Math.floor(at / 1000) * 1000 + SHANGHAI_OFFSET_MS)
    .toISOString()
    .slice(0, 19)
  return iso.replace('T', ' ')
}

/** RFC 3339 with the +08:00 offset, as WeChat Pay's `time_expire` wants it. */
export function shanghaiRfc3339(at: number): string {
  return `${shanghaiDateTime(at).replace(' ', 'T')}+08:00`
}
