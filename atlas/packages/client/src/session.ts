// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The door walked by the client itself, for the desktop shell
 * (qmo-app.md §3): `qmo` spends the ticket on `/client/enter` with the
 * device header, follows no redirect, and hands the cookies the hub set to
 * the shell over standard output. The shell puts them in its WebView. It is
 * the pipe route of clients.md §3.3 with the client as the browser: the
 * header is added by this process, which no page can do.
 */

import { ClientError, type Fetch } from './hub.js'

/** One `Set-Cookie` of the door, attribute by attribute. */
export interface SessionCookie {
  readonly name: string
  readonly value: string
  /** `Domain`, when the hub sent one; a host-only cookie is `null`. */
  readonly domain: string | null
  readonly path: string
  readonly secure: boolean
  readonly httpOnly: boolean
  readonly sameSite: 'Strict' | 'Lax' | 'None' | null
  /** `Max-Age` in seconds; `0` (or less) takes the cookie away. */
  readonly maxAge: number | null
  /** `Expires`, as an ISO time; `Max-Age` wins when both are there. */
  readonly expires: string | null
}

/** The cookie a redeemed ticket opens the front with (console `access.ts`). */
export const SESSION_COOKIE = 'qianmo_session'

const TIMEOUT_MS = 30_000

/** RFC 6265 §5.1.4: the directory of the request path, without its last segment. */
function defaultPath(requestPath: string): string {
  if (!requestPath.startsWith('/')) return '/'
  const end = requestPath.lastIndexOf('/')
  return end <= 0 ? '/' : requestPath.slice(0, end)
}

const SAME_SITE: Readonly<Record<string, SessionCookie['sameSite']>> = {
  strict: 'Strict',
  lax: 'Lax',
  none: 'None',
}

/**
 * One `Set-Cookie` line as RFC 6265 §5.2 reads it: the first pair is the
 * cookie, the rest are attributes in any case, unknown ones ignored. `null`
 * for a line without a name.
 */
export function parseSetCookie(
  line: string,
  requestPath = '/',
): SessionCookie | null {
  const [pair = '', ...attributes] = line.split(';')
  const eq = pair.indexOf('=')
  if (eq <= 0) return null
  const name = pair.slice(0, eq).trim()
  if (name === '') return null
  let domain: string | null = null
  let path: string | null = null
  let secure = false
  let httpOnly = false
  let sameSite: SessionCookie['sameSite'] = null
  let maxAge: number | null = null
  let expires: string | null = null
  for (const attribute of attributes) {
    const at = attribute.indexOf('=')
    const key = (at < 0 ? attribute : attribute.slice(0, at))
      .trim()
      .toLowerCase()
    const raw = at < 0 ? '' : attribute.slice(at + 1).trim()
    if (key === 'domain' && raw !== '')
      domain = raw.replace(/^\./, '').toLowerCase()
    else if (key === 'path') path = raw.startsWith('/') ? raw : null
    else if (key === 'secure') secure = true
    else if (key === 'httponly') httpOnly = true
    else if (key === 'samesite') sameSite = SAME_SITE[raw.toLowerCase()] ?? null
    else if (key === 'max-age' && /^-?\d+$/.test(raw)) maxAge = Number(raw)
    else if (key === 'expires') {
      const when = Date.parse(raw)
      if (Number.isFinite(when)) expires = new Date(when).toISOString()
    }
  }
  return {
    name,
    value: pair.slice(eq + 1).trim(),
    domain,
    path: path ?? defaultPath(requestPath),
    secure,
    httpOnly,
    sameSite,
    maxAge,
    expires,
  }
}

/**
 * `GET /client/enter?ticket=…` as the device's own window: the device header
 * and `Sec-Fetch-Site: none`, no redirect followed, no cookie sent. The answer
 * is the 303 to the front with the session cookie, or a refusal the hub
 * explains on a page meant for a person, which this turns into a message.
 */
export async function enterWithTicket(
  url: string,
  deviceId: string,
  fetchImpl: Fetch = fetch,
): Promise<SessionCookie[]> {
  let response: Response
  try {
    response = await fetchImpl(url, {
      redirect: 'manual',
      credentials: 'omit',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        accept: 'text/html',
        'sec-fetch-site': 'none',
        'x-qmo-device': deviceId,
      },
    })
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new ClientError(`连不上中枢（${reason}）`, 1, 'network')
  }
  // The body is a page for a person either way; nothing in it is read.
  await response.body?.cancel().catch(() => {})
  const requestPath = new URL(url).pathname
  const cookies = response.headers
    .getSetCookie()
    .map(line => parseSetCookie(line, requestPath))
    .filter(cookie => cookie !== null)
  const session = cookies.find(
    cookie =>
      cookie.name === SESSION_COOKIE &&
      cookie.value !== '' &&
      (cookie.maxAge === null || cookie.maxAge > 0),
  )
  if (response.status === 303 && session !== undefined) return cookies
  if (response.status === 429)
    throw new ClientError('进门尝试过多，稍后再试', 1, 'throttled')
  // 200 is the confirmation page: the hub did not take this for the
  // device's own window, so the ticket is still unspent.
  throw new ClientError(
    response.status === 200
      ? '中枢要求在页面上确认账号，没有认出这台设备'
      : response.status === 409
        ? '这个窗口已经以另一个账号登录'
        : `中枢没有让这台设备进门（HTTP ${response.status}）`,
    1,
    'refused',
  )
}
