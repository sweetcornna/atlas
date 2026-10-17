// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The public edition's source footer (AGPL §13, public-edition.md §0).
 *
 * Every page a member of the public reaches in the public edition ends with
 * a link to the corresponding source, and to the terms when the operator
 * has them: the plans, subscription and checkout pages and the `/` standing
 * cards (`billing.ts`), the login, sign-up and invitation doors and the
 * credential page they answer with (`login.ts`, `invite.ts`,
 * `../signup.ts`), the conversation front (`front.ts`), and every page and
 * error page drawn in the management shell (`shell.ts`, `/admin/*`), where
 * a subscriber lands when the console has no chat channel. The
 * documents outside the shell for a caller not yet signed in
 * (`renderStandalone`) carry none. The default edition has no billing port
 * and draws none of it.
 *
 * The address is the billing port's `sourceUrl` as the host hands it over:
 * in the public edition the configured repository at the commit this build
 * runs (`packages/node/src/provenance.ts` `publicSourceUrl`), and a build
 * that cannot name one clean commit does not start. This module draws the
 * link and decides nothing about it.
 */

import type { BillingSiteView } from '../directionPorts.js'
import { attr } from './escape.js'

/** What the footer needs; the billing port's site view carries both. */
export type SourceLinks = Pick<BillingSiteView, 'sourceUrl' | 'termsUrl'>

/**
 * The footer. `className` is the page's own footer style; the spaces around
 * the separator are text between the links, so a flex footer drops them and
 * a plain one keeps them.
 */
export function sourceFooter(links: SourceLinks, className = 'foot'): string {
  return (
    `<footer class="${attr(className)}">` +
    `<a href="${attr(links.sourceUrl)}" rel="noopener" data-source>源代码 · AGPL-3.0</a>` +
    (links.termsUrl === null
      ? ''
      : ` <span class="sep">·</span> <a href="${attr(links.termsUrl)}" rel="noopener">服务条款</a>`) +
    `</footer>`
  )
}
