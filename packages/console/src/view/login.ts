// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: MIT

/**
 * The `/login` document: one field, one button, nothing else.
 *
 * ## Why it is a third document rather than a panel on the first
 *
 * The ledger page and the chat page are both things an authenticated operator
 * looks at; this is the door. Rendering it as a state of `renderPage` would
 * mean the roster markup, the wake form and the client script all exist in the
 * response an anonymous caller gets back, which is a wide surface to hand out
 * for the sake of reusing a shell.
 *
 * ## No script at all
 *
 * This is the only page in the package with no `<script>`. The form is a native
 * `POST` to `/login`, so the door still works when script is off, when the
 * client bundle fails to parse, and in the browser somebody keeps around for
 * exactly one job. It also means the page cannot read the credential back out
 * of the field — the cookie it receives is `HttpOnly` and nothing here would
 * know what to do with it anyway (`auth.ts`).
 *
 * ## The shape
 *
 * A single centred card, which is the skeleton of the reference console's login
 * page with its brand half removed: that half is a shader gradient, and this
 * package renders CSS from a string with no build step and no third-party
 * component. What survives is the part that was load-bearing — the card, the
 * wordmark above the field, the instance name under it, and one line of red
 * when the last attempt did not work.
 *
 * ## What the error line may say
 *
 * Two states, and neither distinguishes "no such token" from "wrong token" —
 * there are only two valid strings on this console and telling a guesser which
 * half of the pair they got close to is free information. The refusal never
 * echoes what was typed, for the same reason `http.ts` never echoes a token
 * into a 401: a credential in a response ends up in a log or a screenshot.
 */

import { CONSOLE_CSS } from '../assets/css.js'
import { attr, escapeHtml } from './escape.js'
import { BRAND, CSP } from './page.js'

export interface LoginPageModel {
  /** The instance label, so two consoles in two tabs are told apart. */
  readonly label: string
  /**
   * Where a successful login sends the browser.
   *
   * **Already validated** by `safeRedirect` — this module renders it into a
   * hidden field and does not re-check it, because two places deciding what a
   * safe redirect is would eventually disagree.
   */
  readonly redirect: string
  /** The one line above the field when the last attempt did not work. */
  readonly error?: string
}

/** The field label and the button, kept next to each other on purpose. */
const FIELD_LABEL = '令牌'
const SUBMIT_LABEL = '进入'

/** The whole `/login` document. Self-contained: nothing is fetched. */
export function renderLoginPage(model: LoginPageModel): string {
  const title = `${BRAND} · 登录 · ${model.label}`
  const error =
    model.error === undefined || model.error === ''
      ? ''
      : `<p class="bar bar-bad" role="alert">${escapeHtml(model.error)}</p>`

  const form =
    `<form class="login-form" method="post" action="/login">` +
    `<input type="hidden" name="redirect" value="${attr(model.redirect)}">` +
    `<label class="field"><span>${escapeHtml(FIELD_LABEL)}</span>` +
    // `current-password` rather than `off`: the alternative to a password
    // manager holding a 32-character random string is a text file holding it.
    `<input type="password" name="token" autocomplete="current-password" ` +
    `spellcheck="false" autofocus required></label>` +
    `<button type="submit" class="btn btn-primary login-submit">` +
    `${escapeHtml(SUBMIT_LABEL)}</button>` +
    `</form>`

  return (
    `<!DOCTYPE html>\n<html lang="zh-CN">\n<head>\n` +
    `<meta charset="utf-8">\n` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">\n` +
    `<meta name="color-scheme" content="light dark">\n` +
    `<meta name="referrer" content="no-referrer">\n` +
    `<meta http-equiv="Content-Security-Policy" content="${attr(CSP)}">\n` +
    `<title>${escapeHtml(title)}</title>\n` +
    `<style>${CONSOLE_CSS}</style>\n` +
    `</head>\n<body>\n` +
    `<div class="login-shell">\n` +
    `<section class="login-card">` +
    `<div class="login-head">` +
    `<p class="login-mark">阡陌</p>` +
    `<p class="login-inst">${escapeHtml(model.label)}</p>` +
    `</div>` +
    error +
    form +
    `</section>\n</div>\n` +
    `</body>\n</html>\n`
  )
}
