// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import * as path from 'node:path'
import type { EvalPreludeDefinition } from '@oh-my-pi/pi-coding-agent/eval/preludes'
import { Settings } from '@oh-my-pi/pi-coding-agent/config/settings'
import { createBrowserPrelude } from '@oh-my-pi/pi-coding-agent/tools/browser'
import { createComputerPrelude } from '@oh-my-pi/pi-coding-agent/tools/computer'
import type { ToolSession } from '@oh-my-pi/pi-coding-agent/tools/index'
import {
  DESKTOP_LEASE_REFUSED,
  desktopArgs,
  desktopOp,
  desktopUnavailable,
  type DesktopDecision,
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

/** One `QIANMO_AUTHZ_V1` request: the tool and the phase it is in. */
export interface DesktopGateRequest {
  readonly toolName: DesktopTool
  readonly input: Record<string, unknown>
}

/**
 * How an executor reaches the node's lease and approval gate. The qianmopi
 * extension answers through omp's UI requests; `qm desktop-exec` through the
 * resident host that started it. Both end in `NodeDesktop.decide`.
 */
export interface DesktopGateway {
  /** The lease reservation; a refusal carries the host's reason. */
  reserve(request: DesktopGateRequest): Promise<DesktopDecision>
  /** Every other phase is a plain yes/no answer. */
  confirm(request: DesktopGateRequest, timeoutMs: number): Promise<boolean>
}

/** One desktop call: the provider's id and the arguments as it sent them. */
export interface DesktopCall {
  readonly name: DesktopTool
  readonly invocationId: string
  /** The arguments the model sent, before any repair; absent refuses. */
  readonly original: unknown
  /** The arguments about to run; must equal {@link original}. */
  readonly args: unknown
  readonly agentKind: string
  readonly signal?: AbortSignal
}

/** What a desktop call returns: omp's tool result (text and image parts). */
export type DesktopResult = Awaited<ReturnType<EvalPreludeDefinition['invoke']>>

/**
 * Runs the typed desktop tools against one agent's private browser and
 * display: only trusted, fixed call chains, no language VM the model can
 * reach. Every call takes the same path whichever runtime asked for it:
 * argument checks → lease → observe → operator gate → re-observe → commit →
 * execute → receipt. Calls run one after another; the host grants one lease
 * per resource at a time.
 */
export class DesktopExecutor {
  readonly #resourceFile: string
  readonly #session: ToolSession
  #browser: EvalPreludeDefinition | undefined
  #computer: EvalPreludeDefinition | undefined
  #attached: string | undefined
  #queue: Promise<unknown> = Promise.resolve()

  constructor(resourceFile: string, cwd: string) {
    this.#resourceFile = resourceFile
    this.#session = {
      cwd,
      hasUI: false,
      settings: Settings.isolated({
        browser: { enabled: true, idleCloseSec: 0 },
        computer: { enabled: true },
      }),
      getSessionFile: () => null,
      getSessionSpawns: () => null,
    }
  }

  #browserPrelude(): EvalPreludeDefinition {
    return (this.#browser ??= createBrowserPrelude(this.#session))
  }
  #computerPrelude(): EvalPreludeDefinition {
    return (this.#computer ??= createComputerPrelude(this.#session))
  }

  run(call: DesktopCall, gateway: DesktopGateway): Promise<DesktopResult> {
    const result = this.#queue.then(() => this.#run(call, gateway))
    this.#queue = result.catch(() => {})
    return result
  }

  async #run(
    call: DesktopCall,
    gateway: DesktopGateway,
  ): Promise<DesktopResult> {
    const { name, invocationId, signal } = call
    signal?.throwIfAborted()
    const r = readDesktopResource(this.#resourceFile)
    let args: Record<string, string | number>
    try {
      if (call.original === undefined)
        throw new Error('Missing original desktop invocation')
      args = desktopArgs(name, call.original)
      if (digest(desktopArgs(name, call.args)) !== digest(args))
        throw new Error('Desktop arguments changed before execution')
      const unavailable = desktopUnavailable(name, r, call.agentKind)
      if (!r || unavailable !== undefined)
        throw new Error(
          `Desktop unavailable: ${unavailable ?? '节点没有为这个智能体发放专属浏览器或专属电脑'}`,
        )
      if (args.tab !== undefined && args.tab !== r.tab)
        throw new Error(
          'Stale or foreign tab handle: 专属浏览器已重启或回收，先调用 qianmo_browser_tabs 取当前的标签句柄',
        )
    } catch (error) {
      await gateway
        .confirm(
          {
            toolName: name,
            input: {
              phase: 'refused',
              invocationId,
              canonicalArgsDigest: digest(call.original ?? call.args),
            },
          },
          5000,
        )
        .catch(() => false)
      throw error
    }
    if (!r) throw new Error('Desktop unavailable')
    const session = this.#session
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
      gateway.confirm(
        { toolName: name, input: { ...binding, phase, ...extra } },
        60_000,
      )
    // The reservation is answered with a reason, so a refusal says why: no
    // running resource, ESTOP, another operation holding the lease, an ended
    // task. Every later phase is a plain yes/no confirmation.
    const lease = await gateway.reserve({
      toolName: name,
      input: { ...binding, phase: 'reserve' },
    })
    if (!lease.ok) throw new Error(`${DESKTOP_LEASE_REFUSED}: ${lease.reason}`)
    let executed = false
    try {
      const context = { session, toolCallId: invocationId, signal }
      if (name.startsWith('qianmo_browser_') && this.#attached !== r.tab) {
        await this.#browserPrelude().invoke(
          { action: 'close', all: true },
          context,
        )
        await this.#browserPrelude().invoke(
          {
            action: 'open',
            name: r.tab,
            app: { cdp_url: r.cdpUrl, relay: false, tern: false },
            downloads: r.downloads,
            persist: true,
          },
          context,
        )
        this.#attached = r.tab
      }
      const browserCall = (method: string, values: unknown[] = []) =>
        this.#browserPrelude().invoke(
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
              url: (await browserCall('url')).details,
              page: (await browserCall('ariaSnapshot')).details,
            }
          : (
              await this.#computerPrelude().invoke(
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
          : String((before as { url?: { value?: unknown } }).url?.value ?? '')
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
      let result: DesktopResult
      switch (name) {
        case 'qianmo_browser_tabs':
          result = {
            content: [{ type: 'text', text: JSON.stringify([{ tab: r.tab }]) }],
          }
          break
        case 'qianmo_browser_screenshot':
          result = await browserCall('screenshot')
          break
        case 'qianmo_browser_read_page':
          result = await browserCall('text', ['body'])
          break
        case 'qianmo_browser_find':
          result = await browserCall('count', [args.selector])
          break
        case 'qianmo_browser_navigate':
          result = await browserCall('goto', [args.url])
          break
        case 'qianmo_browser_click':
          result = await browserCall('click', [args.selector])
          break
        case 'qianmo_browser_type':
          result = await browserCall('fill', [args.selector, args.text])
          break
        case 'qianmo_browser_press':
          result = await browserCall('press', [
            args.key,
            { selector: args.selector },
          ])
          break
        case 'qianmo_browser_scroll':
          result = await browserCall('scroll', [args.x, args.y])
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
          result = await this.#computerPrelude().invoke(
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
          details: { actionId: invocationId, resourceEpoch: r.resourceEpoch },
        }
      return result
    } catch (error) {
      await gate(executed ? 'unknown' : 'failed').catch(() => false)
      throw error
    }
  }

  /** Close the attached tab and the display session; never throws. */
  async close(): Promise<void> {
    const context = { session: this.#session, toolCallId: 'desktop-close' }
    await this.#browser
      ?.invoke({ action: 'close', all: true }, context)
      .catch(() => {})
    await this.#computer?.invoke({ action: 'close' }, context).catch(() => {})
  }
}
