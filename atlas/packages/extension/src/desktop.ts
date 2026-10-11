// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { declareWorkerHostEntry } from '@oh-my-pi/pi-utils/worker-host'
import { createHash } from 'node:crypto'
import * as path from 'node:path'
import { readFileSync } from 'node:fs'
import type { EvalPreludeDefinition } from '@oh-my-pi/pi-coding-agent/eval/preludes'
import type { TSchema } from '@oh-my-pi/omptype/typebox'
import type { ExtensionAPI } from '@oh-my-pi/pi-coding-agent/extensibility/extensions'
import { Settings } from '@oh-my-pi/pi-coding-agent/config/settings'
import { createBrowserPrelude } from '@oh-my-pi/pi-coding-agent/tools/browser'
import { createComputerPrelude } from '@oh-my-pi/pi-coding-agent/tools/computer'
import type { ToolSession } from '@oh-my-pi/pi-coding-agent/tools/index'
import {
  DESKTOP_FIELDS,
  isDesktopTool,
  desktopArgs,
  desktopTools,
  desktopOp,
  type DesktopResource,
  type DesktopTool,
} from './desktopPolicy.js'

export function readDesktopResource(file: string): DesktopResource | undefined {
  try {
    const r = JSON.parse(readFileSync(file, 'utf8')) as DesktopResource
    if (
      typeof r.resourceId !== 'string' ||
      !Number.isSafeInteger(r.resourceEpoch) ||
      typeof r.browser !== 'boolean' ||
      typeof r.computer !== 'boolean' ||
      typeof r.tab !== 'string' ||
      typeof r.downloads !== 'string'
    )
      return undefined
    if (
      r.browser &&
      (typeof r.cdpUrl !== 'string' ||
        !/^http:\/\/127\.0\.0\.1:\d+$/.test(r.cdpUrl))
    )
      return undefined
    return r
  } catch {
    return undefined
  }
}
const digest = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex')

/** Invoke only trusted, fixed call chains; no language VM is model-accessible. */
export function registerDesktopTools(
  pi: ExtensionAPI,
  file: string,
  cwd: string,
): void {
  // Bundled extensions have their own utils module instance. Re-enter the
  // actual omp CLI for workers instead of resolving unshipped worker files.
  declareWorkerHostEntry()
  const Type = pi.typebox.Type
  const originalCalls = new Map<string, { name: string; args: unknown }>()
  pi.on('before_agent_start', () => {
    originalCalls.clear()
  })
  // omp repairs arguments before tool_call. Preserve the provider's original
  // message to reject an entire malformed call instead of a repaired subset.
  pi.on('message_end', event => {
    if (event.message.role !== 'assistant') return
    for (const part of event.message.content)
      if (part.type === 'toolCall' && isDesktopTool(part.name))
        originalCalls.set(part.id, {
          name: part.name,
          args: JSON.parse(JSON.stringify(part.arguments)),
        })
  })
  const session: ToolSession = {
    cwd,
    hasUI: false,
    settings: Settings.isolated({
      browser: { enabled: true, idleCloseSec: 0 },
      computer: { enabled: true },
    }),
    getSessionFile: () => null,
    getSessionSpawns: () => null,
  }
  let browser: EvalPreludeDefinition | undefined
  const browserExecutor = () => (browser ??= createBrowserPrelude(session))
  let computer: EvalPreludeDefinition | undefined
  let attached: string | undefined
  pi.on('session_shutdown', async () => {
    await browser
      ?.invoke(
        { action: 'close', all: true },
        { session, toolCallId: 'desktop-close' },
      )
      .catch(() => {})
    await computer
      ?.invoke({ action: 'close' }, { session, toolCallId: 'desktop-close' })
      .catch(() => {})
  })
  for (const name of Object.keys(DESKTOP_FIELDS) as DesktopTool[]) {
    const fields: Readonly<Record<string, string>> = DESKTOP_FIELDS[name]
    const schema: Record<string, TSchema> = {}
    for (const [key, kind] of Object.entries(fields))
      schema[key] =
        kind === 'number'
          ? Type.Number({ minimum: -10000, maximum: 10000 })
          : Type.String({ maxLength: key === 'text' ? 16000 : 2000 })
    pi.registerTool({
      name,
      label: name,
      description: `Private resource ${desktopOp(name)}. Obtain the current tab handle from qianmo_browser_tabs. Changes require one operator approval.`,
      parameters: Type.Object(schema, { additionalProperties: false }),
      approval: 'read',
      loadMode: 'essential',
      defaultInactive: true,
      async execute(invocationId, raw, signal, _update, ctx) {
        const original = originalCalls.get(invocationId)
        originalCalls.delete(invocationId)
        const r = readDesktopResource(file)
        let args: Record<string, string | number>
        try {
          if (!original || original.name !== name)
            throw new Error('Missing original desktop invocation')
          args = desktopArgs(name, original.args)
          if (digest(desktopArgs(name, raw)) !== digest(args))
            throw new Error('Desktop arguments changed before execution')
          if (
            !r ||
            !desktopTools(r).includes(name) ||
            ctx.agent.kind !== 'main'
          )
            throw new Error('Desktop unavailable')
          if (args.tab !== undefined && args.tab !== r.tab)
            throw new Error('Stale or foreign tab handle')
        } catch (error) {
          await ctx.ui
            .confirm(
              'QIANMO_AUTHZ_V1',
              JSON.stringify({
                toolName: name,
                input: {
                  phase: 'refused',
                  invocationId,
                  canonicalArgsDigest: digest(original?.args ?? raw),
                },
              }),
              { timeout: 5000 },
            )
            .catch(() => false)
          throw error
        }
        if (!r) throw new Error('Desktop unavailable')
        session.settings = Settings.isolated({
          browser: {
            enabled: true,
            idleCloseSec: 0,
            screenshotDir: path.join(path.dirname(r.downloads), 'screenshots'),
          },
          computer: { enabled: true },
        })
        const binding = {
          invocationId,
          resourceId: r.resourceId,
          resourceEpoch: r.resourceEpoch,
          args,
          canonicalArgsDigest: digest(args),
        }
        const gate = (phase: string, extra: Record<string, unknown> = {}) =>
          ctx.ui.confirm(
            'QIANMO_AUTHZ_V1',
            JSON.stringify({
              toolName: name,
              input: { ...binding, phase, ...extra },
            }),
            { timeout: 60_000 },
          )
        if (!(await gate('reserve'))) throw new Error('Desktop lease refused')
        let executed = false
        try {
          const context = { session, toolCallId: invocationId, signal }
          if (name.startsWith('qianmo_browser_') && attached !== r.tab) {
            await browserExecutor().invoke(
              { action: 'close', all: true },
              context,
            )
            await browserExecutor().invoke(
              {
                action: 'open',
                name: r.tab,
                app: { cdp_url: r.cdpUrl, relay: false, tern: false },
                downloads: r.downloads,
                persist: true,
              },
              context,
            )
            attached = r.tab
          }
          const call = (method: string, values: unknown[] = []) =>
            browserExecutor().invoke(
              {
                action: 'call',
                name: r.tab,
                chain: [{ method, args: values }],
              },
              context,
            )
          const target = async () =>
            name.startsWith('qianmo_browser_')
              ? {
                  url: (await call('url')).details,
                  page: (await call('ariaSnapshot')).details,
                }
              : (
                  await (computer ??= createComputerPrelude(session)).invoke(
                    {
                      action: 'call',
                      chain: [{ method: 'screenshot', args: [] }],
                    },
                    context,
                  )
                ).content.filter(part => part.type === 'image')
          const before = await target()
          const observedTargetDigest = digest(before)
          const url =
            name === 'qianmo_browser_navigate'
              ? String(args.url)
              : String(
                  (before as { url?: { value?: unknown } }).url?.value ?? '',
                )
          let host: string | null = null
          try {
            host = new URL(url).hostname
          } catch {
            /* A blank tab has no host. */
          }
          if (!(await gate('authorize', { observedTargetDigest, host })))
            throw new Error('Operator approval denied')
          if (digest(await target()) !== observedTargetDigest)
            throw new Error('Desktop target changed during approval')
          signal?.throwIfAborted()
          if (!(await gate('commit', { observedTargetDigest })))
            throw new Error('Stale desktop approval')
          executed = true
          let result
          switch (name) {
            case 'qianmo_browser_tabs':
              result = {
                content: [
                  {
                    type: 'text' as const,
                    text: JSON.stringify([{ tab: r.tab }]),
                  },
                ],
              }
              break
            case 'qianmo_browser_screenshot':
              result = await call('screenshot')
              break
            case 'qianmo_browser_read_page':
              result = await call('text', ['body'])
              break
            case 'qianmo_browser_find':
              result = await call('count', [args.selector])
              break
            case 'qianmo_browser_navigate':
              result = await call('goto', [args.url])
              break
            case 'qianmo_browser_click':
              result = await call('click', [args.selector])
              break
            case 'qianmo_browser_type':
              result = await call('fill', [args.selector, args.text])
              break
            case 'qianmo_browser_press':
              result = await call('press', [
                args.key,
                { selector: args.selector },
              ])
              break
            case 'qianmo_browser_scroll':
              result = await call('scroll', [args.x, args.y])
              break
            default: {
              const op = desktopOp(name)
              const method = op === 'key' ? 'press' : op
              const values =
                op === 'click'
                  ? [args.x, args.y]
                  : op === 'scroll'
                    ? [args.x, args.y, { dx: args.dx, dy: args.dy }]
                    : op === 'type'
                      ? [args.text]
                      : op === 'key'
                        ? [args.key]
                        : []
              result = await (computer ??=
                createComputerPrelude(session)).invoke(
                { action: 'call', chain: [{ method, args: values }] },
                context,
              )
            }
          }
          if (!(await gate('completed')))
            throw new Error('Desktop completion receipt lost; do not retry')
          const details = 'details' in result ? result.details : undefined
          const value =
            details && typeof details === 'object' && 'value' in details
              ? details.value
              : undefined
          if (
            value !== undefined &&
            !result.content.some(part => part.type === 'image')
          )
            return {
              content: [
                ...result.content,
                {
                  type: 'text',
                  text: (typeof value === 'string'
                    ? value
                    : JSON.stringify(value)
                  ).slice(0, 64000),
                },
              ],
              details: {
                actionId: invocationId,
                resourceEpoch: r.resourceEpoch,
              },
            }
          return result
        } catch (error) {
          await gate(executed ? 'unknown' : 'failed').catch(() => false)
          throw error
        }
      },
    })
  }
}
