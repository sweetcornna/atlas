// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  type NotifyChannelKind,
  type ScheduleRunOutcome,
} from '@qianmo/console'

import * as http from 'node:http'
import * as https from 'node:https'
import { checkServerIdentity, type PeerCertificate } from 'node:tls'
import {
  notifyDestination,
  NotifyDestinationError,
  type NotifyAddress,
  type NotifyDestinationOptions,
} from './consoleNotifyDestination.js'
export { notifyChannelUrl } from './consoleNotifyDestination.js'

export interface ScheduleNotification {
  readonly title: string
  readonly body: string
  readonly at: number
  readonly qianmo: {
    readonly scheduleId: string
    readonly runId: string
    readonly outcome: ScheduleRunOutcome
  }
}

export interface ChannelPushResult {
  readonly ok: boolean
  readonly error: string | null
  readonly attempts: number
}

export interface ChannelPushOptions extends NotifyDestinationOptions {
  /** Test-only response fixture; production uses the pinned socket transport. */
  readonly fetch?: (url: string, init: RequestInit) => Promise<Response>
  readonly delay?: (ms: number) => Promise<void>
  readonly timeoutMs?: number
}

/** Sources checked 2026-10-11; formats only, no real-service evaluation.
 * Bark: https://github.com/Finb/Bark/blob/master/docs/en-us/tutorial.md (POST /:key JSON).
 * WeCom: https://developer.work.weixin.qq.com/document/path/91770 (text.content).
 * Feishu: https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot (content.text).
 * ntfy: https://docs.ntfy.sh/publish/ (POST body, Title; RFC 2047 for UTF-8 headers).
 * WeCom's official page was inaccessible on the check date; its format remains unevaluated.
 */
function requestFor(
  kind: NotifyChannelKind,
  notice: ScheduleNotification,
): RequestInit {
  const text = `${notice.title}\n${notice.body}`
  if (kind === 'ntfy') {
    const title = notice.title.replace(/[\r\n]/g, ' ')
    return {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        Title: /^[\x20-\x7e]*$/.test(title)
          ? title
          : `=?UTF-8?B?${Buffer.from(title).toString('base64')}?=`,
      },
      body: notice.body,
    }
  }
  const body =
    kind === 'bark'
      ? { title: notice.title, body: notice.body }
      : kind === 'wecom'
        ? { msgtype: 'text', text: { content: text } }
        : kind === 'feishu'
          ? { msg_type: 'text', content: { text } }
          : notice
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body),
  }
}

/** Never retain a remote response or exception: either may echo the secret URL. */
async function responsePrefix(response: Response): Promise<string> {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const pieces: Uint8Array[] = []
  let remaining = 4096
  try {
    while (remaining > 0) {
      const chunk = await reader.read()
      if (chunk.done) break
      const piece = chunk.value.subarray(0, remaining)
      pieces.push(piece)
      remaining -= piece.length
    }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
  return Buffer.concat(pieces).toString('utf8')
}

function serviceError(kind: NotifyChannelKind, prefix: string): string | null {
  if (kind === 'webhook' || kind === 'ntfy') return null
  let value: unknown
  try {
    value = JSON.parse(prefix)
  } catch {
    return '渠道响应格式无效'
  }
  if (!value || typeof value !== 'object') return '渠道响应格式无效'
  const body = value as Record<string, unknown>
  const code =
    kind === 'wecom'
      ? body.errcode
      : kind === 'bark'
        ? body.code
        : (body.code ?? body.StatusCode)
  if (typeof code !== 'number' || !Number.isSafeInteger(code))
    return '渠道响应格式无效'
  return code === (kind === 'bark' ? 200 : 0) ? null : `渠道拒绝（${code}）`
}

/** Pin by connecting to the checked IP literal, with the original Host and TLS
 * identity. This needs no second DNS lookup (including under Bun); proxy env
 * variables and pooled sockets cannot substitute a different destination. */
async function pinnedPost(
  url: URL,
  address: NotifyAddress,
  init: RequestInit,
): Promise<{ status: number; prefix: string }> {
  const pending = Promise.withResolvers<{ status: number; prefix: string }>()
  const host = url.hostname.replace(/^\[|\]$/g, '')
  const transport = url.protocol === 'https:' ? https : http
  const request = transport.request(
    {
      protocol: url.protocol,
      hostname: address.address,
      family: address.family,
      port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)),
      path: `${url.pathname}${url.search}`,
      method: 'POST',
      headers: {
        ...Object.fromEntries(new Headers(init.headers)),
        Host: url.host,
      },
      agent: false,
      signal: init.signal ?? undefined,
      ...(url.protocol === 'https:'
        ? {
            servername: host,
            checkServerIdentity: (_name: string, cert: PeerCertificate) =>
              checkServerIdentity(host, cert),
          }
        : {}),
    },
    response => {
      const pieces: Buffer[] = []
      let remaining = 4096
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        pending.resolve({
          status: response.statusCode ?? 0,
          prefix: Buffer.concat(pieces).toString('utf8'),
        })
      }
      response.on('data', (chunk: Buffer) => {
        const piece = chunk.subarray(0, remaining)
        pieces.push(piece)
        remaining -= piece.length
        if (remaining === 0) {
          finish()
          response.destroy()
        }
      })
      response.on('end', finish)
      response.on('error', pending.reject)
      response.on('aborted', () =>
        pending.reject(new Error('response interrupted')),
      )
    },
  )
  request.on('error', pending.reject)
  request.end(typeof init.body === 'string' ? init.body : '')
  return pending.promise
}

/** One initial attempt plus at most three retries (2s, 8s, 30s). */
export async function pushNotifyChannel(
  kind: NotifyChannelKind,
  rawUrl: string,
  notice: ScheduleNotification,
  options: ChannelPushOptions = {},
): Promise<ChannelPushResult> {
  const delays = [2000, 8000, 30000]
  let error = '渠道发送失败'
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    if (attempt > 0) await (options.delay ?? Bun.sleep)(delays[attempt - 1]!)
    let destination: { url: URL; address: NotifyAddress }
    try {
      destination = await notifyDestination(rawUrl, options)
    } catch (failure) {
      return {
        ok: false,
        error:
          failure instanceof NotifyDestinationError
            ? failure.message
            : '目的地址验证失败',
        attempts: attempt,
      }
    }
    const signal = AbortSignal.timeout(options.timeoutMs ?? 10_000)
    try {
      const init = {
        ...requestFor(kind, notice),
        redirect: 'manual' as const,
        signal,
      }
      const response = options.fetch
        ? await options.fetch(destination.url.toString(), init)
        : null
      const { status, prefix } = response
        ? { status: response.status, prefix: await responsePrefix(response) }
        : await pinnedPost(destination.url, destination.address, init)
      const failure =
        status >= 200 && status < 300
          ? serviceError(kind, prefix)
          : `HTTP ${status}`
      if (failure === null)
        return { ok: true, error: null, attempts: attempt + 1 }
      error = failure
    } catch {
      error = signal.aborted ? '渠道请求超时' : '渠道发送失败'
    }
  }
  return { ok: false, error, attempts: 4 }
}
