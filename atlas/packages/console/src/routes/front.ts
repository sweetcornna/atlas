// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 对话前台 — `/` (智能体) and `/app` (对话), the desktop app's quick entry at
 * `/app/quick`, and their fragments under `/fragments/chat/front/…`.
 *
 * The pages and their parts (`view/front.ts`, `view/frontQuick.ts`,
 * `docs/dev/qmo-app.md` §4):
 *
 * | Path | What |
 * | --- | --- |
 * | `GET /` | the front's 智能体 face: the main agent's welcome, `?agent=<address>` another agent's, `?session=<id>` an open conversation |
 * | `GET /app` | the front's 对话 face, the desktop app's home: a new conversation with the main agent, `?agent=<address>` with another, `?session=<id>` an open conversation |
 * | `GET /app/quick` | quick entry: one card that opens a conversation and hands it to the main window |
 * | `GET /code` | Code, the main window's second mode: the agents on this computer, inside the desktop app (`view/frontCode.ts`) |
 * | `GET /admin/…` (as a document) | the Work face with nothing open, under the settings card drawn open on the area (`routes/index.ts`) |
 * | `GET /fragments/chat/front/side?agent=&active=[&layout=chat]` | the side panel's agents, sessions and the running strip; `/app`'s conversations by day and its agent picker |
 * | `GET /fragments/chat/front/view?agent=<address>[&layout=chat]` | the head and the welcome for one agent |
 * | `GET /fragments/chat/front/view/<id>[?open=1][&layout=chat]` | the head and one conversation |
 *
 * The two faces are one front: the same guard, the same reading gate, the
 * same fragments with `layout=chat` choosing `/app`'s face of them. Quick
 * entry has the same guard and reads only the roster.
 *
 * Every document here carries the settings card for a reader who may see
 * the management side (`view/shell.ts`): closed on `/`, `/app` and
 * `/code`, open on an area's address. Under an open card the Work face is
 * drawn as `/` (`/app` inside the desktop app) with nothing asked for — the
 * welcome, never a transcript, so opening a settings page reads no
 * conversation and marks none as read.
 *
 * Everything else the front does goes through the chat routes it always went
 * through (`routes/chat.ts`): `POST /v0/chat/sessions` to open a session,
 * `POST /v0/chat/sessions/<id>/messages` to send, `GET /v0/chat/stream` to
 * hear about changes. The guard is the chat guard in full, read-only parts
 * included (`routes/chat.ts`, module note), and a member sees only the
 * sessions that member opened.
 *
 * Who is the **main agent** is decided here, once: the console's
 * `--chat-default` when the roster lists it, else the first agent this console
 * may dial, else the first agent the roster lists. Every other agent is a
 * sub-agent (`view/front.ts`, module note).
 */

import { chatScopeOf, type ChatScope } from '../accountsHttp.js'
import { langOf } from '../i18n.js'
import { agentAvatarKey } from '../avatar.js'
import type {
  ChatPort,
  ChatSession,
  ChatTarget,
  ConsoleFailure,
} from '../deps.js'
import { inDesktopApp } from '../preferences.js'
import { html, notFound } from '../respond.js'
import {
  chatlessParts,
  frontAllow,
  type FrontDocumentModel,
  type FrontLayout,
  frontSideParts,
  frontViewParts,
  renderFrontDocument,
  renderFrontSide,
  renderFrontView,
  type FrontSideModel,
  type FrontViewModel,
} from '../view/front.js'
import type { SettingsCard } from '../view/shell.js'
import { renderQuickDocument } from '../view/frontQuick.js'
import { renderFrontPanel } from '../view/frontPanel.js'
import { FRONT_TEXT } from '../view/frontText.js'
import {
  chatFaces,
  chatTargets,
  type FaceLookup,
  HIDDEN_SESSION,
  LEDGER_CLOSED_FAILURE,
  lookFaces,
  noteTranscriptRead,
  type TranscriptReading,
} from './chatReads.js'
import {
  canWrite,
  DEFAULT_LABEL,
  failureOf,
  guard,
  guardChat,
  loginHref,
  preferredMainAgent,
  textParam,
  valueOf,
} from './shared.js'
import { taskActorOf } from './tasksApi.js'
import type { RouteContext } from './types.js'

/**
 * Whether this caller gets the front: a chat channel is wired, and the
 * caller may hold a conversation here. The 对话 item of the management
 * sidebar is offered by the same rule (`routes/index.ts`).
 */
export function frontAvailable(ctx: RouteContext): boolean {
  return (
    ctx.deps.chat !== undefined && guardChat(ctx.access, 'document') === null
  )
}

/** Whether the panel's links into the management side are worth drawing. */
function mayAdmin(ctx: RouteContext): boolean {
  return guard(ctx.access.credential, 'view', 'document') === null
}

/** The main agent: the page's choice or `--chat-default` if listed, else the first dialable, else the first. */
function mainAgentOf(
  targets: readonly ChatTarget[] | null,
  preferred: string | undefined,
): string | null {
  if (targets === null) return preferred ?? null
  if (
    preferred !== undefined &&
    targets.some(target => target.address === preferred)
  ) {
    return preferred
  }
  return (
    (targets.find(target => target.dialable) ?? targets[0])?.address ?? null
  )
}

/** What one render reads once and every part of it shares. */
interface FrontData {
  readonly targets: readonly ChatTarget[] | null
  readonly sessions: readonly ChatSession[]
  readonly sessionsFailure: ConsoleFailure | null
  readonly main: string | null
}

async function frontData(
  ctx: RouteContext,
  chat: ChatPort,
  scope: ChatScope,
): Promise<FrontData> {
  const [sessions, targets] = await Promise.all([
    chat.sessions(),
    chatTargets(chat),
  ])
  return {
    targets,
    // Fetched whole and filtered here, as on the legacy rail: the port has no
    // notion of an owner.
    sessions: (valueOf(sessions) ?? []).filter(session =>
      scope.visible(session.id),
    ),
    sessionsFailure: failureOf(sessions),
    main: mainAgentOf(targets, preferredMainAgent(ctx.deps)),
  }
}

/** The agent asked for, when it is one this console knows of; else the main agent. */
function pickedAgent(
  data: FrontData,
  asked: string | undefined,
): string | null {
  if (
    asked !== undefined &&
    ((data.targets ?? []).some(target => target.address === asked) ||
      data.sessions.some(session => session.target === asked))
  ) {
    return asked
  }
  return data.main
}

async function sideModel(
  ctx: RouteContext,
  data: FrontData,
  selected: string | null,
  activeId: string | null,
  scope: ChatScope,
  look: FaceLookup,
  layout: FrontLayout,
): Promise<FrontSideModel> {
  const addresses = new Set<string>([
    ...(data.targets ?? []).map(target => target.address),
    ...data.sessions.map(session => session.target),
  ])
  const faces = await look([...addresses].map(agentAvatarKey))
  return {
    faces: chatFaces(faces),
    targets: data.targets,
    sessions: data.sessions,
    sessionsFailure: data.sessionsFailure,
    main: data.main,
    selected,
    activeId: activeId !== null && scope.visible(activeId) ? activeId : null,
    admin: mayAdmin(ctx),
    now: ctx.now,
    lang: langOf(ctx.request),
    layout,
  }
}

/** One view, with what the page around it needs to know. */
interface FrontViewRender {
  readonly model: FrontViewModel
  /** The agent in focus, for the side panel. */
  readonly selected: string | null
  /** A transcript really loaded: what enables the composer. */
  readonly open: boolean
  /** Nothing open and the agent can be dialled: the first line opens one. */
  readonly startable: boolean
  readonly welcome: boolean
  readonly status?: number
  readonly reading?: TranscriptReading
}

/**
 * The view for `sessionId`, or the welcome of `asked` (or the main agent).
 *
 * A transcript is read only through the gate (`noteTranscriptRead`): refused,
 * the view is the reason in place of the conversation, with a 503, and no
 * transcript was read to draw it.
 */
async function viewFor(
  ctx: RouteContext,
  chat: ChatPort,
  data: FrontData,
  scope: ChatScope,
  sessionId: string | null,
  asked: string | undefined,
  explicitOpen: boolean,
  look: FaceLookup,
  layout: FrontLayout,
): Promise<FrontViewRender> {
  const admin = mayAdmin(ctx)
  const registryDown = data.targets === null
  const base = {
    admin,
    registryDown,
    now: ctx.now,
    lang: langOf(ctx.request),
    layout,
  }
  if (sessionId !== null && sessionId !== '') {
    const faces = chatFaces(await look([]))
    if (!scope.visible(sessionId)) {
      return {
        model: {
          ...base,
          faces,
          transcript: null,
          failure: HIDDEN_SESSION,
          target: null,
          agent: null,
          main: false,
        },
        selected: data.main,
        open: false,
        startable: false,
        welcome: false,
      }
    }
    const noted = await noteTranscriptRead(ctx, sessionId, explicitOpen)
    if (noted instanceof Response) {
      return {
        model: {
          ...base,
          faces,
          transcript: null,
          failure: LEDGER_CLOSED_FAILURE,
          target: null,
          agent: null,
          main: false,
        },
        selected: data.main,
        open: false,
        startable: false,
        welcome: false,
        status: 503,
      }
    }
    const transcript = await chat.transcript(sessionId)
    const address = transcript.ok ? transcript.value.session.target : ''
    const looked = chatFaces(
      await look(address === '' ? [] : [agentAvatarKey(address)]),
    )
    return {
      model: {
        ...base,
        faces: looked,
        transcript: valueOf(transcript),
        failure: failureOf(transcript),
        target:
          (data.targets ?? []).find(target => target.address === address) ??
          null,
        agent: address === '' ? null : address,
        main: address !== '' && address === data.main,
      },
      selected: address === '' ? data.main : address,
      // The composer is enabled by a transcript that actually loaded, not by
      // the query naming one: a stale bookmark must not put a live send
      // button under a failure strip.
      open: transcript.ok,
      startable: false,
      welcome: false,
      reading: noted,
    }
  }
  const agent = pickedAgent(data, asked)
  const target =
    agent === null
      ? null
      : ((data.targets ?? []).find(one => one.address === agent) ?? null)
  const faces = chatFaces(
    await look(agent === null ? [] : [agentAvatarKey(agent)]),
  )
  return {
    model: {
      ...base,
      faces,
      transcript: null,
      failure: null,
      target,
      agent,
      main: agent !== null && agent === data.main,
    },
    selected: agent,
    open: false,
    startable: target?.dialable === true,
    welcome: true,
  }
}

/** A front document, and the scripts its policy allows beyond its own (`respond.ts`). */
interface FrontRender {
  readonly html: string
  readonly status: number
  readonly allow: readonly string[]
}

/** What every front document says about its reader, whichever face it is. */
function readerOf(
  ctx: RouteContext,
  card: SettingsCard | undefined,
): Pick<
  FrontDocumentModel,
  'label' | 'role' | 'viewer' | 'relogin' | 'source' | 'settings'
> {
  return {
    label: ctx.deps.label ?? DEFAULT_LABEL,
    role: ctx.access.credential.role,
    ...(ctx.viewer === undefined ? {} : { viewer: ctx.viewer }),
    relogin: loginHref(ctx.url),
    // The public edition's source footer (AGPL §13, `view/source.ts`).
    ...(ctx.deps.billing === undefined
      ? {}
      : { source: ctx.deps.billing.site() }),
    ...(card === undefined ? {} : { settings: card }),
  }
}

function drawn(model: FrontDocumentModel, status: number): FrontRender {
  return { html: renderFrontDocument(model), status, allow: frontAllow(model) }
}

/**
 * One Work face. `opened` says what the address asked for: on `/` and
 * `/app` the query's session or agent, a session read through the gate; under
 * an open settings card nothing, so no transcript is read at all.
 */
async function workFace(
  ctx: RouteContext,
  chat: ChatPort,
  layout: FrontLayout,
  card: SettingsCard | undefined,
  opened: { readonly session: string | null; readonly agent?: string },
): Promise<FrontRender> {
  const scope = chatScopeOf(ctx.access, ctx.accounts)
  const look = lookFaces(ctx)
  const data = await frontData(ctx, chat, scope)
  // A page that opens with a conversation in it is one reading.
  const view = await viewFor(
    ctx,
    chat,
    data,
    scope,
    opened.session,
    opened.agent,
    true,
    look,
    layout,
  )
  const side = await sideModel(
    ctx,
    data,
    view.selected,
    opened.session,
    scope,
    look,
    layout,
  )
  await view.reading?.done(view.open)
  return drawn(
    {
      ...readerOf(ctx, card),
      side: frontSideParts(side),
      view: frontViewParts(view.model),
      welcome: view.welcome,
      composerEnabled: view.open || view.startable,
      admin: side.admin,
      faces: side.faces,
      lang: side.lang,
      replicate:
        ctx.deps.replicate === undefined
          ? 'off'
          : canWrite(ctx.access)
            ? 'ops'
            : 'view',
      // Approval cards on the front (P39, P40 §6): only for a person who may
      // approve, with their role, which decides who sees 需要运维批准.
      ...(ctx.deps.approvals !== undefined &&
      ctx.access.principal?.kind === 'user' &&
      ctx.access.principal.role !== 'viewer'
        ? { approvals: ctx.access.principal.role }
        : {}),
      layout,
      picked: view.selected,
    },
    view.status ?? 200,
  )
}

/**
 * `/` or `/app`: the whole front, in either face. The caller has already
 * applied the chat guard.
 */
export async function renderFront(
  ctx: RouteContext,
  layout: FrontLayout = 'agents',
  card?: SettingsCard,
): Promise<FrontRender | Response> {
  const chat = ctx.deps.chat
  if (chat === undefined) return notFound(`unknown path: ${ctx.url.pathname}`)
  const agent = textParam(ctx.url.searchParams, 'agent')
  return await workFace(ctx, chat, layout, card, {
    session: textParam(ctx.url.searchParams, 'session') ?? null,
    ...(agent === undefined ? {} : { agent }),
  })
}

/**
 * An area's address as a document: the Work face under the settings card,
 * drawn open (`routes/index.ts`). The face is `/app`'s inside the desktop
 * app and `/`'s elsewhere, with nothing asked for. A reader who may not hold
 * a conversation here — no chat channel, a view token, a viewer — gets the
 * same frame with one line saying so in place of the conversation.
 */
export async function renderUnderCard(
  ctx: RouteContext,
  card: SettingsCard,
  status: number,
): Promise<FrontRender> {
  const layout: FrontLayout = inDesktopApp(ctx.request) ? 'chat' : 'agents'
  const chat = ctx.deps.chat
  if (chat !== undefined && frontAvailable(ctx)) {
    const face = await workFace(ctx, chat, layout, card, { session: null })
    return { ...face, status }
  }
  const lang = langOf(ctx.request)
  const t = FRONT_TEXT[lang]
  // One line for a reader who may not chat, wired or not: whether this
  // console has a conversation channel is not theirs to learn
  // (`routes/chat.ts`). Only one who could chat is told there is none.
  const line =
    guardChat(ctx.access, 'document') === null ? t.noChatChannel : t.noChatRole
  const parts = chatlessParts(layout, line)
  return drawn(
    {
      ...readerOf(ctx, card),
      ...parts,
      welcome: true,
      composerEnabled: false,
      admin: mayAdmin(ctx),
      faces: chatFaces(await lookFaces(ctx)([])),
      lang,
      layout,
      chatless: line,
    },
    status,
  )
}

/**
 * `/code`: Code, the main window's second mode (`view/frontCode.ts`). It
 * reads nothing of the conversations; the agents it lists are the desktop
 * app's to find (`assets/codeClient.ts`). The caller has already checked
 * that the reader is signed in.
 */
export async function renderCode(
  ctx: RouteContext,
  card: SettingsCard | undefined,
): Promise<FrontRender> {
  const lang = langOf(ctx.request)
  const desktop = inDesktopApp(ctx.request)
  const empty = chatlessParts('agents', '')
  return drawn(
    {
      ...readerOf(ctx, card),
      ...empty,
      welcome: false,
      composerEnabled: false,
      admin: mayAdmin(ctx),
      faces: chatFaces(await lookFaces(ctx)([])),
      lang,
      code: {
        desktop,
        // Remote's copies (P37.15): a personal account, on a hub that keeps them.
        remote:
          ctx.deps.codeLinks !== undefined &&
          ctx.access.principal?.kind === 'user' &&
          !ctx.access.breakGlass,
      },
      workHome: desktop ? '/app' : '/',
    },
    200,
  )
}

/**
 * `/app/quick`: the desktop app's quick entry (`qmo-app.md` §4.3), one
 * card that opens a conversation with the main agent, or the agent picked
 * on it, and hands it to the main window. It reads the roster and the
 * figures and nothing else: no transcript, no session list. The caller has
 * already applied the chat guard.
 */
export async function renderQuick(
  ctx: RouteContext,
): Promise<{ readonly html: string; readonly status: number } | Response> {
  const chat = ctx.deps.chat
  if (chat === undefined) return notFound(`unknown path: ${ctx.url.pathname}`)
  const targets = await chatTargets(chat)
  const main = mainAgentOf(targets, preferredMainAgent(ctx.deps))
  const faces = chatFaces(
    await lookFaces(ctx)(
      (targets ?? []).map(target => agentAvatarKey(target.address)),
    ),
  )
  return {
    html: renderQuickDocument({
      label: ctx.deps.label ?? DEFAULT_LABEL,
      targets,
      main,
      faces,
      relogin: loginHref(ctx.url),
      lang: langOf(ctx.request),
      accounts: ctx.viewer !== undefined,
    }),
    status: 200,
  }
}

/**
 * `/fragments/chat/front/…`, reached through the chat fragment dispatch
 * (`routes/chat.ts`), which has already applied the chat guard, checked the
 * method and found the channel.
 */
export async function dispatchFrontFragment(
  ctx: RouteContext,
  chat: ChatPort,
  scope: ChatScope,
  rest: readonly string[],
): Promise<Response> {
  const look = lookFaces(ctx)
  const params = ctx.url.searchParams
  // `?layout=chat` is `/app` asking for its own face of the same parts.
  const layout: FrontLayout =
    params.get('layout') === 'chat' ? 'chat' : 'agents'
  if (rest[0] === 'side' && rest.length === 1) {
    const data = await frontData(ctx, chat, scope)
    const active = textParam(params, 'active') ?? null
    const activeTarget =
      active === null
        ? undefined
        : data.sessions.find(session => session.id === active)?.target
    const selected =
      activeTarget ?? pickedAgent(data, textParam(params, 'agent'))
    return html(
      renderFrontSide(
        await sideModel(ctx, data, selected, active, scope, look, layout),
      ),
    )
  }
  if (rest[0] === 'view' && (rest.length === 1 || rest.length === 2)) {
    const data = await frontData(ctx, chat, scope)
    let sessionId: string | null = null
    if (rest.length === 2) {
      try {
        sessionId = decodeURIComponent(rest[1] ?? '')
      } catch {
        return notFound(`unknown path: ${ctx.url.pathname}`)
      }
    }
    // `?open=1` is the page switching to this conversation; without it the
    // fetch refreshes what is already open, and is covered by the reading
    // that opened it (`noteTranscriptRead`).
    const view = await viewFor(
      ctx,
      chat,
      data,
      scope,
      sessionId,
      textParam(params, 'agent'),
      params.get('open') === '1',
      look,
      layout,
    )
    await view.reading?.done(view.open)
    return html(renderFrontView(view.model), view.status ?? 200)
  }
  // The session panel (`view/frontPanel.ts`): the reader's background tasks
  // by the port's own ownership rule, and the way to 云端电脑.
  if (rest[0] === 'panel' && rest.length === 1) {
    const tasks = ctx.deps.tasks
    return html(
      renderFrontPanel({
        tasks: tasks === undefined ? null : tasks.list(taskActorOf(ctx)),
        stop: guardChat(ctx.access, 'document') === null,
        desktop: ctx.deps.desktop === undefined ? null : '/admin/desktop',
        now: ctx.now,
        t: FRONT_TEXT[langOf(ctx.request)],
      }),
    )
  }
  return notFound(`unknown path: ${ctx.url.pathname}`)
}
