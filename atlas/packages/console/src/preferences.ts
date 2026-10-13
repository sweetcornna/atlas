// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { etagMatches } from './respond.js'
import { accentAttrs } from './view/accent.js'

/** Runs after authorization and before compression. A matching ETag never
 * bypasses the current principal/tenant checks. Theme and accent are
 * cosmetic only, and each is drawn only from a value on its closed list.
 */
export async function decorateConsoleResponse(
  request: Request,
  response: Response,
): Promise<Response> {
  if (
    request.method !== 'GET' ||
    response.status !== 200 ||
    !response.headers.get('content-type')?.startsWith('text/html')
  )
    return response
  const body = await response.text()
  const headers = new Headers(response.headers)
  headers.delete('content-length')
  if (new URL(request.url).pathname.startsWith('/fragments/')) {
    const etag = `W/"${new Bun.CryptoHasher('sha256').update(body).digest('hex')}"`
    headers.set('etag', etag)
    headers.set('cache-control', 'private, no-cache')
    headers.set('vary', 'Cookie, Authorization, Accept-Encoding')
    const asked = request.headers.get('if-none-match')
    if (asked !== null && etagMatches(asked, etag))
      return new Response(null, { status: 304, headers })
    return new Response(body, { status: 200, headers })
  }
  const cookie = request.headers.get('cookie') ?? ''
  const theme =
    /(?:^|;\s*)qianmo_theme=(light|dark|system)(?:;|$)/.exec(cookie)?.[1] ??
    'system'
  const accent =
    /(?:^|;\s*)qianmo_accent=([a-z]{2,8}|%23[0-9a-fA-F]{6})(?:;|$)/.exec(
      cookie,
    )?.[1]
  return new Response(
    body.replace(
      /<html lang="(zh-CN|en|ja)">/,
      (_, lang: string) =>
        `<html lang="${lang}" data-theme="${theme}"${accentAttrs(
          accent?.replace('%23', '#'),
        )}>`,
    ),
    { status: 200, headers },
  )
}
