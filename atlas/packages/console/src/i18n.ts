// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The languages the conversation front speaks, and which one a request asked
 * for.
 *
 * The choice is the reader's, made in the front's own menu and kept in a
 * cookie (`qianmo_lang`) the way the light/dark choice is; without one the
 * front speaks 简体中文, the console's first language. The browser's
 * `Accept-Language` is not consulted: a console is set up for a team, and a
 * page that changes language with whoever's laptop opened it is harder to
 * talk about than one that changes only when somebody asks.
 *
 * The strings themselves live with the views that say them
 * (`view/frontText.ts`); the management side under `/admin` is Chinese only
 * for now.
 */

export const LANGS = ['zh-CN', 'en', 'ja'] as const
export type Lang = (typeof LANGS)[number]

/** Each language in its own words, for the picker. */
export const LANG_NAMES: Readonly<Record<Lang, string>> = {
  'zh-CN': '简体中文',
  en: 'English',
  ja: '日本語',
}

/** The language a cookie value names, or `undefined` for anything else. */
function parseLang(value: string | undefined): Lang | undefined {
  return (LANGS as readonly string[]).includes(value ?? '')
    ? (value as Lang)
    : undefined
}

/** The language this request's reader chose, or 简体中文. */
export function langOf(request: Request): Lang {
  const cookie = request.headers.get('cookie') ?? ''
  return (
    parseLang(
      /(?:^|;\s*)qianmo_lang=([A-Za-z-]{2,5})(?:;|$)/.exec(cookie)?.[1],
    ) ?? 'zh-CN'
  )
}
