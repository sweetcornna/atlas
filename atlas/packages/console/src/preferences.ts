// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { etagMatches } from './respond.js'
import { accentAttrs } from './view/accent.js'

/** Runs after authorization and before compression. A matching ETag never
 * bypasses the current principal/tenant checks. Theme, accent and the
 * desktop app's platform are cosmetic only, and each is drawn only from a
 * value on its closed list.
 */
export async function decorateConsoleResponse(
  request: Request,
  response: Response,
): Promise<Response> {
  if (
    request.method !== 'GET' ||
    response.status !== 200 ||
    !response.headers.get('content-type')?.startsWith('text/html') ||
    // A file handed out as it is (work outputs and their previews, P37.17 B).
    response.headers.has('content-disposition')
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
  const shell = shellOf(cookie)
  return new Response(
    body.replace(
      /<html lang="(zh-CN|en|ja)">/,
      (_, lang: string) =>
        `<html lang="${lang}" data-theme="${theme}"${accentAttrs(
          accent?.replace('%23', '#'),
        )}${shell === undefined ? '' : ` data-shell="${shell}"`}>`,
    ),
    { status: 200, headers },
  )
}

/**
 * The desktop app's platform (`docs/dev/qmo-app.md` §5.1): the shell sets
 * `qianmo_shell` so the page is drawn with the window's own margins and drag
 * strip from the first paint. Only the three names count; a browser sends
 * none and its pages do not change.
 */
function shellOf(cookie: string): 'macos' | 'windows' | 'linux' | undefined {
  const value = /(?:^|;\s*)qianmo_shell=(macos|windows|linux)(?:;|$)/.exec(
    cookie,
  )?.[1]
  return value === 'macos' || value === 'windows' || value === 'linux'
    ? value
    : undefined
}

/**
 * Whether this request came from inside the desktop app, by the same cookie
 * the first paint is drawn with: where Work goes (`/app` there, `/` in a
 * browser) and whether `/code` draws its local panel first (P37.13,
 * `qmo-local.md` §3.6). Cosmetic, like the rest of this file: it decides no
 * access.
 */
export function inDesktopApp(request: Request): boolean {
  return shellOf(request.headers.get('cookie') ?? '') !== undefined
}
