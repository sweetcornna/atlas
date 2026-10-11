// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { OutboundPolicy } from './outboundPolicy.js'
import {
  isLoopbackHostname,
  type NotifyChannelKind,
  type ScheduleRunOutcome,
} from '@qianmo/console'

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

export interface ChannelPushOptions {
  readonly policy?: OutboundPolicy
  readonly fetch?: (url: string, init: RequestInit) => Promise<Response>
  readonly delay?: (ms: number) => Promise<void>
  readonly timeoutMs?: number
}

export function notifyChannelUrl(raw: string): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('渠道地址必须是完整 URL')
  }
  if (
    url.protocol !== 'https:' &&
    !(url.protocol === 'http:' && isLoopbackHostname(url.hostname))
  )
    throw new Error('渠道只允许 HTTPS；回环地址允许 HTTP')
  if (url.username || url.password || url.hash)
    throw new Error('渠道地址不能带用户名、密码或片段')
  return url
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

/** One initial attempt plus at most three retries (2s, 8s, 30s). */
export async function pushNotifyChannel(
  kind: NotifyChannelKind,
  rawUrl: string,
  notice: ScheduleNotification,
  options: ChannelPushOptions = {},
): Promise<ChannelPushResult> {
  let url: URL
  try {
    url = notifyChannelUrl(rawUrl)
  } catch {
    return { ok: false, error: '渠道地址无效', attempts: 0 }
  }
  const delays = [2000, 8000, 30000]
  let error = '渠道发送失败'
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    if (attempt > 0) await (options.delay ?? Bun.sleep)(delays[attempt - 1]!)
    const signal = AbortSignal.timeout(options.timeoutMs ?? 10_000)
    try {
      const response = await (options.policy ?? new OutboundPolicy())
        .withFetch(options.fetch)
        .request(
          url.toString(),
          {
            ...requestFor(kind, notice),
            redirect: 'manual',
            signal,
          },
          false,
        )
      const prefix = await responsePrefix(response)
      const failure = response.ok
        ? serviceError(kind, prefix)
        : `HTTP ${response.status}`
      if (failure === null)
        return { ok: true, error: null, attempts: attempt + 1 }
      error = failure
    } catch {
      error = signal.aborted ? '渠道请求超时' : '渠道发送失败'
    }
  }
  return { ok: false, error, attempts: 4 }
}
