// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The handful of response shapes every route on this console answers with.
 *
 * Lifted out of `http.ts` unchanged when the account routes arrived
 * (`accountsHttp.ts`): the two files have to answer in the same voice — the
 * same headers on a document, the same `{ error: { code, message } }` body on
 * a refusal — and a second copy of these helpers would be a second place for
 * the voice to drift. `test/legacyParity.test.ts` pins that the move changed
 * no byte.
 */

import type { ConsoleFailure } from './deps.js'

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  // No other origin loads an answer as a subresource (H2).
  'cross-origin-resource-policy': 'same-origin',
} as const

/**
 * Content-Security-Policy, as strict as an inline-everything page can be.
 *
 * Scripts are allowed by hash, not by `'unsafe-inline'` (H2): every script a
 * document carries is a compile-time constant (the runtime, the page's own
 * script), so its SHA-256 is known before the response is written, and a
 * script anyone manages to put into the page any other way does not run.
 * A document with no script says `script-src 'none'`. `'unsafe-inline'`
 * stays for styles only: the one `<style>` and the `style=""` attributes.
 * Every *host* directive is `'none'`, which is the half that matters: no
 * origin other than this one can contribute anything, and
 * `connect-src 'self'` keeps the token from being sent anywhere else.
 *
 * `img-src data:` is the one loosening, and it buys exactly one thing: the
 * favicon, which is an inline SVG data URI in the document head. `data:` is not
 * an origin — nothing can be fetched through it and no third party can put
 * anything there — so the property this policy exists for ("no host other than
 * this one contributes anything") is untouched.
 *
 * Lives here rather than beside the document head because two places state
 * it: the `<meta>` in every document (`view/shell.ts`) and the response header
 * on every document ({@link documentHeaders}), both from {@link cspFor} over
 * the same scripts, so the two cannot drift.
 */
export function cspFor(scripts: readonly string[]): string {
  const hashes = [...new Set(scripts.map(scriptHash))]
  return [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    `script-src ${hashes.length === 0 ? "'none'" : hashes.join(' ')}`,
    // `connect-src` also covers `EventSource`: the chat page's stream is a
    // same-origin `GET /v0/chat/stream`, and without this directive the browser
    // would refuse to open it while reporting nothing useful.
    "connect-src 'self'",
    "form-action 'self'",
    "base-uri 'none'",
    'img-src data:',
    "font-src 'none'",
  ].join('; ')
}

const scriptHashes = new Map<string, string>()

/** `'sha256-…'` of one inline script's text, as the browser hashes it. */
export function scriptHash(script: string): string {
  let hash = scriptHashes.get(script)
  if (hash === undefined) {
    const digest = new Bun.CryptoHasher('sha256')
      .update(script)
      .digest('base64')
    hash = `'sha256-${digest}'`
    scriptHashes.set(script, hash)
  }
  return hash
}

/** The policy of a document without a script: the login door, an error page. */
export const CSP = cspFor([])

/**
 * The policy as a response header: {@link cspFor} plus `frame-ancestors 'none'`.
 *
 * `frame-ancestors` is the one directive a `<meta>` policy cannot carry — the
 * browser ignores it there (`authorization-m1.md` TH-5) — and it is the one
 * that stops another page from framing the console with the operator's
 * cookie attached and a click-target laid over 注销 (`SameSite` does not
 * look at the port, so a page on the same host at another port is "same
 * site"). The `<meta>` copy stays as well: it is what a saved copy of the
 * page still enforces.
 */
export function documentCspFor(scripts: readonly string[]): string {
  return `${cspFor(scripts)}; frame-ancestors 'none'`
}

/** {@link documentCspFor} of a document without a script. */
export const DOCUMENT_CSP = documentCspFor([])

/** The inline scripts of a document, in order, as the browser will hash them. */
export function inlineScripts(body: string): string[] {
  return [...body.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(
    match => match[1] ?? '',
  )
}

/**
 * Powerful features no console page uses, refused for the page and for
 * anything it might frame (H2). The clipboard is not on the list: the copy
 * buttons write to it.
 */
const PERMISSIONS_POLICY = [
  'accelerometer=()',
  'camera=()',
  'geolocation=()',
  'gyroscope=()',
  'magnetometer=()',
  'microphone=()',
  'payment=()',
  'usb=()',
].join(', ')

/**
 * Headers for anything a browser renders, with the policy for this body.
 *
 * `no-referrer` matters here rather than being boilerplate: the page URL can
 * carry the token (`?token=…`), and a default `Referer` would hand it to
 * whatever the operator clicks next.
 *
 * `x-frame-options: DENY` says what `frame-ancestors 'none'` says, for a
 * browser old enough to know only the older header. Every document carries
 * both — the login door and the invitation pages too, since a framed login
 * form is the other half of a clickjacking attack.
 *
 * H2 adds three: `Cross-Origin-Opener-Policy: same-origin`, so a page that
 * opened the console in a window keeps no handle on it; a resource policy of
 * `same-origin`, so no other origin can load the document as a subresource;
 * and the {@link PERMISSIONS_POLICY}.
 */
export function documentHeaders(body: string): Record<string, string> {
  return {
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'content-security-policy': documentCspFor(inlineScripts(body)),
    'x-frame-options': 'DENY',
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-resource-policy': 'same-origin',
    'permissions-policy': PERMISSIONS_POLICY,
  }
}

/** Error vocabulary of this surface. `code` is for clients, not for users. */
type ConsoleErrorCode =
  | ConsoleFailure['code']
  | 'unauthorized'
  | 'forbidden'
  | 'method_not_allowed'
  | 'internal'
  | 'unavailable'
  | 'limit'

export function json(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...JSON_HEADERS, ...headers },
  })
}

export function fail(
  status: number,
  code: ConsoleErrorCode,
  message: string,
  headers: Record<string, string> = {},
): Response {
  return json({ error: { code, message } }, status, headers)
}

export function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      ...documentHeaders(body),
    },
  })
}

/**
 * Smallest body worth compressing. Under it the gzip framing is most of the
 * answer and the CPU is spent for nothing.
 */
const COMPRESS_MIN_BYTES = 1024

/** What is text and worth compressing. An event stream is not: it is never done. */
const COMPRESSIBLE =
  /^(?:text\/html|text\/css|text\/javascript|application\/json)(?:;|$)/

/** True when the caller's `Accept-Encoding` takes gzip (a `q=0` refuses it). */
export function acceptsGzip(request: Request): boolean {
  const header = request.headers.get('accept-encoding')
  if (header === null) return false
  let star = false
  for (const part of header.split(',')) {
    const [name = '', ...params] = part.trim().toLowerCase().split(';')
    const q = params
      .map(param => param.trim())
      .find(param => param.startsWith('q='))
    const refused = q !== undefined && Number(q.slice(2)) === 0
    if (name === 'gzip') return !refused
    if (name === '*') star = !refused
  }
  return star
}

/**
 * The response, gzipped when the caller takes it (G1).
 *
 * Documents are `no-store` and inline their sheet and runtime, so every
 * navigation sends the whole page again; compressed it is a fraction of the
 * size. Only `GET` answers are compressed: the one response that carries a
 * secret the caller just submitted (the credential page answering
 * `POST /invite`) is never put next to its own compressed length, which is
 * the condition a length side channel needs. Bodies are fully known strings
 * here, so this reads and re-wraps them; streams are left alone.
 */
export async function compressed(
  request: Request,
  response: Response,
): Promise<Response> {
  if (request.method !== 'GET' || response.body === null) return response
  if (response.headers.has('content-encoding')) return response
  if (!COMPRESSIBLE.test(response.headers.get('content-type') ?? '')) {
    return response
  }
  if (!acceptsGzip(request)) return response
  const raw = new Uint8Array(await response.arrayBuffer())
  const headers = new Headers(response.headers)
  const init = { status: response.status, statusText: response.statusText }
  if (raw.byteLength < COMPRESS_MIN_BYTES) {
    return new Response(raw, { ...init, headers })
  }
  headers.set('content-encoding', 'gzip')
  headers.delete('content-length')
  const vary = headers.get('vary')
  if (vary === null) headers.set('vary', 'accept-encoding')
  else if (!/\baccept-encoding\b/i.test(vary)) {
    headers.set('vary', `${vary}, accept-encoding`)
  }
  return new Response(Bun.gzipSync(raw), { ...init, headers })
}

/**
 * A compiled-in asset, revalidated by its content hash (G1).
 *
 * `no-cache`, not `immutable`: the URL carries no version, so the next
 * release serves different bytes at the same address and a browser told
 * "never ask again" would keep the old ones. With the ETag the question costs
 * a 304 and no body. Weak, because the gzipped and plain answers are the same
 * content in two encodings.
 */
export function asset(
  request: Request,
  body: string,
  contentType: string,
): Response {
  const tag = assetTag(body)
  const headers = {
    'content-type': contentType,
    'cache-control': 'no-cache',
    etag: tag,
    vary: 'accept-encoding',
    'x-content-type-options': 'nosniff',
    'cross-origin-resource-policy': 'same-origin',
  }
  const asked = request.headers.get('if-none-match')
  if (asked !== null && etagMatches(asked, tag)) {
    return new Response(null, { status: 304, headers })
  }
  return new Response(body, { status: 200, headers })
}

const assetTags = new Map<string, string>()

function assetTag(body: string): string {
  let tag = assetTags.get(body)
  if (tag === undefined) {
    const digest = new Bun.CryptoHasher('sha256').update(body).digest('hex')
    tag = `W/"${digest.slice(0, 32)}"`
    assetTags.set(body, tag)
  }
  return tag
}

/** `If-None-Match` by weak comparison: `*`, or any listed tag, W/ or not. */
function etagMatches(header: string, tag: string): boolean {
  if (header.trim() === '*') return true
  const bare = tag.replace(/^W\//, '')
  return header
    .split(',')
    .map(one => one.trim().replace(/^W\//, ''))
    .includes(bare)
}

export function notFound(message: string): Response {
  return fail(404, 'not_found', message)
}

export function methodNotAllowed(allowed: readonly string[]): Response {
  return fail(405, 'method_not_allowed', `允许的方法：${allowed.join(', ')}`, {
    allow: allowed.join(', '),
  })
}

/** A redirect that carries no body. `303` so a POST becomes a GET. */
export function seeOther(
  location: string,
  headers: Record<string, string> = {},
): Response {
  return new Response(null, {
    status: 303,
    headers: {
      location,
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      ...headers,
    },
  })
}

/**
 * Biggest form body this will read.
 *
 * The forms here have two short fields. Anything larger is not a submission,
 * and refusing it by `Content-Length` costs nothing while reading it costs
 * whatever the sender decided.
 */
const MAX_FORM_BODY_BYTES = 4096

/** A urlencoded form body, or `null` when this is not one. */
export async function readForm(
  request: Request,
): Promise<URLSearchParams | null> {
  const declared = Number(request.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > MAX_FORM_BODY_BYTES) return null
  const type = request.headers.get('content-type') ?? ''
  if (!type.includes('application/x-www-form-urlencoded')) return null
  try {
    const text = await request.text()
    if (text.length > MAX_FORM_BODY_BYTES) return null
    return new URLSearchParams(text)
  } catch {
    return null
  }
}

/** A JSON object body, or `null` for anything else (arrays and scalars included). */
export async function readJsonObject(
  request: Request,
): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = await request.json()
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return null
    }
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}
