// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  accountSessionCookie,
  ACCOUNT_SESSION_COOKIE,
  type ConsoleAccounts,
} from './access.js'
import {
  cookieOf,
  isCrossOriginRequest,
  isSecureRequest,
  clearedSessionCookieHeader,
} from './auth.js'
import { fail, html, methodNotAllowed, notFound, readForm } from './respond.js'
import { escapeHtml } from './view/escape.js'
import { documentHead } from './view/page.js'
import { renderCredentialPage } from './view/invite.js'

/** Dedicated registration budget: successful attempts count too; no caller-controlled proxy key. */
export class RegistrationThrottle {
  readonly #buckets = new Map<string, { start: number; count: number }>()
  take(key: string, now: number, limit: number): number {
    for (const [name, bucket] of this.#buckets)
      if (now - bucket.start >= 3_600_000) this.#buckets.delete(name)
    // Bound memory without granting fresh buckets when saturated.
    const bucketKey =
      this.#buckets.has(key) || this.#buckets.size < 4096 ? key : 'overflow'
    const bucket = this.#buckets.get(bucketKey) ?? { start: now, count: 0 }
    if (bucket.count >= limit)
      return Math.max(1, Math.ceil((bucket.start + 3_600_000 - now) / 1000))
    bucket.count += 1
    this.#buckets.set(bucketKey, bucket)
    return 0
  }
}

export async function handleSignup(
  request: Request,
  accounts: ConsoleAccounts,
  label: string,
  throttle: RegistrationThrottle,
  clientKey: string,
  now: number,
): Promise<Response> {
  if (accounts.signup === undefined) return notFound('注册未开放')
  if (request.method === 'GET')
    return html(
      documentHead(`${label} · 注册账号`) +
        `<body><main class="stage"><form class="card panel" method="post" action="/signup"><h1>注册成员账号</h1><p>${escapeHtml(label)}</p><p>注册后由环境负责人分配租户。分配前没有节点或数据访问权限。</p><label for="label">备注（可选）</label><input id="label" name="label" maxlength="40" class="input" autocomplete="off"><button class="btn btn-primary" type="submit">注册并显示个人凭据</button><p>凭据只显示一次，请立即保存。</p></form></main></body></html>`,
    )
  if (request.method !== 'POST') return methodNotAllowed(['GET', 'POST'])
  const origin = request.headers.get('origin')
  if (
    isCrossOriginRequest(request) ||
    (origin !== null && origin !== new URL(request.url).origin)
  )
    return fail(403, 'forbidden', '注册只接受本控制台页面的提交')
  const wait = throttle.take(
    clientKey,
    now,
    accounts.signup.attemptsPerHour ?? 5,
  )
  if (wait > 0) {
    const response = fail(429, 'limit', '注册尝试过多，请稍后再试')
    response.headers.set('retry-after', String(wait))
    return response
  }
  const form = await readForm(request)
  if (form === null || [...form.keys()].some(key => key !== 'label'))
    return fail(400, 'invalid', '注册表单只能包含备注')
  const raw = form.get('label')
  const result = accounts.book.registerMember(
    accounts.signup.maxAccounts,
    typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : undefined,
  )
  if (!result.ok)
    return fail(
      result.refusal.code === 'limit'
        ? 429
        : result.refusal.code === 'unavailable'
          ? 503
          : 400,
      result.refusal.code,
      result.refusal.message,
    )
  const session = accounts.book.sessionFor(
    result.value.subject,
    cookieOf(request, ACCOUNT_SESSION_COOKIE),
  )
  const response = html(
    renderCredentialPage({
      label,
      role: 'member',
      credential: result.value.credential,
      signedIn: session.ok,
    }),
  )
  if (session.ok) {
    const secure = isSecureRequest(request)
    response.headers.append(
      'set-cookie',
      accountSessionCookie(session.value.sid, secure),
    )
    response.headers.append(
      'set-cookie',
      clearedSessionCookieHeader({ secure }),
    )
  }
  return response
}
