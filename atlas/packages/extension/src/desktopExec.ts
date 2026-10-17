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
  DESKTOP_HOST_WINDOWED,
  DESKTOP_LEASE_REFUSED,
  desktopActionItems,
  desktopArgs,
  desktopOp,
  desktopUnavailable,
  type DesktopArgs,
  type DesktopDecision,
  type DesktopResource,
  type DesktopTool,
  type DesktopValue,
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

/** The `value` a base computer call answered with, if any. */
const valueOf = (result: DesktopResult): unknown => {
  const details = 'details' in result ? result.details : undefined
  return details && typeof details === 'object' && 'value' in details
    ? details.value
    : undefined
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
  /**
   * A phase the host itself carries out and answers with a value: `apps`
   * (the applications this computer may open) and `launch` (open one).
   */
  query(request: DesktopGateRequest): Promise<DesktopDecision>
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

/** The part of omp's browser and computer preludes the executor drives. */
export type DesktopPrelude = Pick<EvalPreludeDefinition, 'invoke'>
/** Where the executor gets its preludes; tests pass fakes. */
export interface DesktopPreludes {
  readonly browser?: (session: ToolSession) => DesktopPrelude
  readonly computer?: (session: ToolSession) => DesktopPrelude
}

/** One `call` step on the base computer facade (`computer/call.ts`). */
interface ComputerStep {
  readonly method: string
  readonly args: readonly unknown[]
}
const step = (method: string, ...args: unknown[]): ComputerStep => ({
  method,
  args,
})
/** Copy the present options under the base's names; absent ones stay unset. */
function options(
  args: DesktopArgs,
  names: Readonly<Record<string, string>>,
): Record<string, DesktopValue> | undefined {
  const out: Record<string, DesktopValue> = {}
  for (const [from, to] of Object.entries(names))
    if (args[from] !== undefined) out[to] = args[from]
  return Object.keys(out).length > 0 ? out : undefined
}
const trailing = (...values: unknown[]) =>
  values.at(-1) === undefined ? values.slice(0, -1) : values

/**
 * The base call for one checked `actions` step other than `wait`. With
 * `background`, every input helper that takes options says `takeover: false`:
 * on this Mac's own desktop the owner keeps the foreground (§6.5).
 */
function actionStep(item: DesktopArgs, background = false): ComputerStep {
  const input = (
    present: Record<string, DesktopValue> | undefined,
  ): Record<string, DesktopValue | boolean> | undefined =>
    background ? { ...present, takeover: false } : present
  switch (item.type) {
    case 'click':
      return step(
        'click',
        ...trailing(
          item.x,
          item.y,
          input(
            options(item, {
              button: 'button',
              count: 'count',
              keys: 'modifiers',
            }),
          ),
        ),
      )
    case 'double_click':
      return step(
        'doubleClick',
        ...trailing(
          item.x,
          item.y,
          input(options(item, { keys: 'modifiers' })),
        ),
      )
    case 'move':
      return step('move', item.x, item.y)
    case 'drag':
      return step(
        'drag',
        ...trailing(item.path, input(options(item, { keys: 'keys' }))),
      )
    case 'scroll':
      return step('scroll', item.x, item.y, {
        dx: item.dx,
        dy: item.dy,
        ...(background ? { takeover: false } : {}),
      })
    case 'type':
      return step('type', ...trailing(item.text, input(undefined)))
    case 'keypress':
      return step('press', ...trailing(item.keys, input(undefined)))
    case 'hold_keys':
      return step('holdKeys', item.keys, {
        duration: item.seconds,
        ...(background ? { takeover: false } : {}),
      })
    case 'hold_mouse':
      return step('holdMouse', item.x, item.y, {
        duration: item.seconds,
        ...options(item, { button: 'button' }),
        ...(background ? { takeover: false } : {}),
      })
    default:
      throw new Error(`Unsupported desktop action: ${String(item.type)}`)
  }
}

/** Sleep for a `wait` step; an abort ends it at once. */
function pause(ms: number, signal: AbortSignal | undefined): Promise<void> {
  signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    const done = () => {
      signal?.removeEventListener('abort', stop)
      resolve()
    }
    const timer = setTimeout(done, ms)
    const stop = () => {
      clearTimeout(timer)
      reject(signal?.reason ?? new Error('Desktop wait aborted'))
    }
    signal?.addEventListener('abort', stop, { once: true })
  })
}

/**
 * The window layout a computer call is authorized against: what `windows()`
 * reports for each window, in a stable order. Pixels change with every caret
 * blink and animation on a live desktop, so a pixel digest would call every
 * approved target changed; the layout changes only when the desktop does.
 */
function windowLayout(value: unknown): unknown[] | undefined {
  if (!Array.isArray(value)) return undefined
  const windows: {
    id: string
    app: unknown
    title: unknown
    bounds: unknown
    focused: unknown
  }[] = []
  for (const w of value) {
    if (!w || typeof w !== 'object' || typeof w.id !== 'string')
      return undefined
    windows.push({
      id: w.id,
      app: w.app,
      title: w.title,
      bounds: { x: w.x, y: w.y, width: w.width, height: w.height },
      focused: w.focused,
    })
  }
  return windows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

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
  readonly #preludes: DesktopPreludes
  #browser: DesktopPrelude | undefined
  #computer: DesktopPrelude | undefined
  #attached: string | undefined
  #queue: Promise<unknown> = Promise.resolve()

  constructor(
    resourceFile: string,
    cwd: string,
    preludes: DesktopPreludes = {},
  ) {
    this.#resourceFile = resourceFile
    this.#preludes = preludes
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

  #browserPrelude(): DesktopPrelude {
    return (this.#browser ??= (this.#preludes.browser ?? createBrowserPrelude)(
      this.#session,
    ))
  }
  #computerPrelude(): DesktopPrelude {
    return (this.#computer ??= (
      this.#preludes.computer ?? createComputerPrelude
    )(this.#session))
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
    let args: DesktopArgs
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
      if (
        r.hostApps !== undefined &&
        DESKTOP_HOST_WINDOWED.has(name) &&
        args.window === undefined
      )
        throw new Error(
          'Desktop window required: 本机桌面的电脑操作必须带 window，先用 qianmo_computer_windows 取允许应用的窗口编号',
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
    const browser = name.startsWith('qianmo_browser_')
    let executed = false
    try {
      const context = { session, toolCallId: invocationId, signal }
      if (browser && this.#attached !== r.tab) {
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
      const computerCall = (...chain: ComputerStep[]) =>
        this.#computerPrelude().invoke({ action: 'call', chain }, context)
      // Input on one window takes the base's one handle hop.
      const onTarget = (call: ComputerStep) =>
        typeof args.window === 'string'
          ? computerCall(step('window', args.window), call)
          : computerCall(call)
      // This Mac's own desktop (§6.5): only the listed applications' windows
      // exist for the agent, matched by process id, and input stays in the
      // background.
      const hostApps = browser ? undefined : r.hostApps
      const hostWindows = async (): Promise<
        { readonly id: string; readonly pid?: unknown }[]
      > => {
        const running = valueOf(
          await computerCall(step('apps.list', { runningOnly: true })),
        )
        const pids = new Set(
          (Array.isArray(running) ? running : [])
            .filter(app => hostApps?.includes(app?.id) === true)
            .map(app => app?.pid)
            .filter(pid => Number.isSafeInteger(pid)),
        )
        const windows = valueOf(await computerCall(step('windows')))
        if (!Array.isArray(windows))
          throw new Error('Desktop window list unavailable')
        return windows.filter(
          w => w && typeof w.id === 'string' && pids.has(w.pid),
        )
      }
      let layout: boolean | undefined
      const target = async (): Promise<unknown> => {
        if (browser)
          return {
            url: (await browserCall('url')).details,
            page: (await browserCall('ariaSnapshot')).details,
          }
        if (hostApps !== undefined) {
          // No whole-screen fallback: the rest of the screen is the owner's.
          const windows = await hostWindows()
          if (
            typeof args.window === 'string' &&
            !windows.some(w => w.id === args.window)
          )
            throw new Error(
              'Desktop window not allowed: 这个窗口不属于允许的应用或已经关闭，先用 qianmo_computer_windows 取窗口编号',
            )
          return windowLayout(windows)
        }
        // Both observations of one call use the same kind of digest.
        if (layout !== false) {
          try {
            const windows = windowLayout(
              valueOf(await computerCall(step('windows'))),
            )
            if (windows !== undefined) {
              layout = true
              return windows
            }
          } catch (error) {
            if (layout === true) throw error
          }
          if (layout === true)
            throw new Error('Desktop window list became unavailable')
          layout = false
        }
        return (await computerCall(step('screenshot'))).content.filter(
          part => part.type === 'image',
        )
      }
      const before = await target()
      const observedTargetDigest = digest(before)
      let host: string | null = null
      if (browser) {
        const url =
          name === 'qianmo_browser_navigate'
            ? String(args.url)
            : String((before as { url?: { value?: unknown } }).url?.value ?? '')
        try {
          host = new URL(url).hostname
        } catch {
          /* A blank tab has no host. */
        }
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
        case 'qianmo_computer_screenshot':
          result = await onTarget(step('screenshot'))
          break
        case 'qianmo_computer_zoom':
          result = await onTarget(
            step('zoom', {
              x: args.x,
              y: args.y,
              width: args.width,
              height: args.height,
            }),
          )
          break
        case 'qianmo_computer_windows':
          result =
            hostApps === undefined
              ? await computerCall(step('windows'))
              : { content: [], details: { value: await hostWindows() } }
          break
        case 'qianmo_computer_observe':
          result = await onTarget(step('observe'))
          break
        case 'qianmo_computer_clipboard_read':
          result = await computerCall(step('clipboard.read'))
          break
        case 'qianmo_computer_clipboard_write':
          result = await computerCall(step('clipboard.write', args.text))
          break
        case 'qianmo_computer_click':
          result = await onTarget(
            actionStep({ ...args, type: 'click' }, hostApps !== undefined),
          )
          break
        case 'qianmo_computer_type':
          result = await onTarget(
            actionStep(
              { text: args.text!, type: 'type' },
              hostApps !== undefined,
            ),
          )
          break
        case 'qianmo_computer_key':
          result = await onTarget(
            actionStep(
              { keys: args.key!, type: 'keypress' },
              hostApps !== undefined,
            ),
          )
          break
        case 'qianmo_computer_scroll':
          result = await onTarget(
            actionStep({ ...args, type: 'scroll' }, hostApps !== undefined),
          )
          break
        case 'qianmo_computer_focus':
          result = await onTarget(step('raise'))
          break
        case 'qianmo_computer_element':
          result = await computerCall(
            step('ref', args.ref),
            args.action === 'set_value'
              ? step('setValue', args.value)
              : args.action === 'click' && hostApps !== undefined
                ? step('click', { takeover: false })
                : step(String(args.action)),
          )
          break
        case 'qianmo_computer_menu':
          result = await onTarget(step('menu.select', args.path))
          break
        case 'qianmo_computer_actions':
          result = await this.#actions(
            args,
            onTarget,
            signal,
            hostApps !== undefined,
          )
          break
        case 'qianmo_computer_apps':
        case 'qianmo_computer_open_app': {
          // The host lists and launches desktop entries itself (§6.3); the
          // model only ever names an id it was given.
          const answer = await gateway.query({
            toolName: name,
            input: {
              ...binding,
              phase: name === 'qianmo_computer_apps' ? 'apps' : 'launch',
            },
          })
          if (!answer.ok)
            throw new Error(`${DESKTOP_LEASE_REFUSED}: ${answer.reason}`)
          if (answer.value === undefined)
            throw new Error('Desktop host answered without a result')
          result = {
            content: [{ type: 'text', text: answer.value.slice(0, 64000) }],
          }
          break
        }
      }
      if (!(await gate('completed')))
        throw new Error('Desktop completion receipt lost; do not retry')
      const value = valueOf(result)
      const imaged = result.content.some(part => part.type === 'image')
      if ((value !== undefined && !imaged) || result.content.length === 0)
        return {
          content: [
            ...result.content,
            {
              type: 'text',
              text:
                value === undefined || imaged
                  ? `Done: ${desktopOp(name)}`
                  : (typeof value === 'string'
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

  /**
   * One batch, step by step on the same target: waits sleep here, the first
   * failure stops the rest, and a screenshot of the target closes the batch.
   */
  async #actions(
    args: DesktopArgs,
    onTarget: (call: ComputerStep) => Promise<DesktopResult>,
    signal: AbortSignal | undefined,
    background: boolean,
  ): Promise<DesktopResult> {
    const items = desktopActionItems(args)
    const done: string[] = []
    for (const [index, item] of items.entries()) {
      try {
        signal?.throwIfAborted()
        if (item.type === 'wait') await pause(Number(item.ms), signal)
        else await onTarget(actionStep(item, background))
      } catch (error) {
        if (signal?.aborted) throw error
        throw new Error(
          `Desktop actions stopped at step ${index + 1} of ${items.length} (${String(item.type)}): ${
            index === 0
              ? '后面的步骤都没有执行'
              : `前 ${index} 步已执行，后面的没有执行`
          }；${error instanceof Error ? error.message : String(error)}`,
        )
      }
      done.push(
        `${index + 1} ${String(item.type)}${item.type === 'wait' ? ` ${item.ms} ms` : ''}`,
      )
    }
    const shot = await onTarget(step('screenshot'))
    return {
      ...shot,
      content: [
        {
          type: 'text',
          text: `Completed ${done.length} of ${items.length} actions: ${done.join(', ')}.`,
        },
        ...shot.content,
      ],
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
