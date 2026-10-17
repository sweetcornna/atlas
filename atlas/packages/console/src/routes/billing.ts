// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 订阅 (P35): the public edition's subscriptions, as platform ops run them.
 *
 * | Route | Who |
 * |---|---|
 * | `GET /admin/billing` | a platform reader (`billingApi.ts`); the area exists only where the billing port is wired |
 *
 * The JSON behind the buttons is `/v0/billing/admin/…` (`routes/billingApi.ts`).
 * What members see — `/plans`, `/subscription`, the checkout — are doors in
 * `http.ts`, drawn by `billingDoors.ts`, not area pages.
 */

import { notFound } from '../respond.js'
import {
  BILLING_ADMIN_CSS,
  type BillingAdminSide,
  billingAdminDialogs,
  renderBillingAdmin,
} from '../view/billing.js'
import { BILLING_ADMIN_JS } from '../view/billingScript.js'
import { KIT_CSS } from '../view/kit.js'
import { billingApi, billingReader, billingWriter } from './billingApi.js'
import type { RouteContext, RouteModule } from './types.js'

async function sideOf(ctx: RouteContext): Promise<BillingAdminSide> {
  const billing = ctx.deps.billing
  if (billing === undefined) return { kind: 'unwired' }
  const admin = await billing.admin()
  return admin.ok
    ? { kind: 'ok', value: admin.value }
    : { kind: 'failed', failure: admin.failure }
}

export const billingRoute: RouteModule = {
  area: {
    id: 'billing',
    label: '订阅',
    group: 'manage',
    href: '/admin/billing',
    icon: 'calendar',
  },
  page: {
    match: segments =>
      segments.length === 1 && segments[0] === 'billing' ? [] : null,
    guard: 'view',
    available: ctx => ctx.deps.billing !== undefined && billingReader(ctx),
    async render(ctx) {
      const billing = ctx.deps.billing
      if (billing === undefined || !billingReader(ctx))
        return notFound(`unknown path: ${ctx.url.pathname}`)
      const writer = billingWriter(ctx)
      const side = await sideOf(ctx)
      return {
        title: '订阅',
        body:
          `<div class="kit-pane" id="billing">${renderBillingAdmin(side, writer)}</div>` +
          (writer && side.kind === 'ok'
            ? billingAdminDialogs(side.value.plans)
            : ''),
      }
    },
    css: KIT_CSS + BILLING_ADMIN_CSS,
    script: BILLING_ADMIN_JS,
  },
  api: billingApi,
}
