// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 广泛性工作 on the front (P37.17 B, `docs/dev/work-tasks.md` §9): the new
 * work page, a work session's place in the list, the files an agent hands
 * over, and the activity panel beside a work session.
 *
 * ## Two uses, one kind of conversation
 *
 * Talking to an agent is its row and its one conversation (P37.17 A). 开始一项
 * 工作 opens a **work session**: a conversation the hub keeps with a `work`
 * mark, carried out by one agent (the main agent unless another was picked
 * under 由谁来做), listed by day under the agents rather than as an agent's
 * row. The person picks; nothing guesses which kind a line was meant to be
 * (REA §1.4).
 *
 * ## The new work page
 *
 * The six workflows as a row of cards over the large composer, in the order
 * `work-tasks.md` §2.1 gives them (REA §3.2: the home cards and the `/`
 * menu). A card picks its workflow — a chip in the composer, removed with
 * its × — and so does the `/` menu; the first line then opens the session
 * and is sent with it in one request (`POST /v0/work/sessions`), so a work
 * session is never empty.
 *
 * ## In the list
 *
 * The workflow's mark, the title, and one of three states (REA §1.5's row
 * states): 进行中 while a line waits for its answer (`running`), 等你 while
 * a request in it waits on this person's decision (the front's approval
 * poll marks the row, `frontApproval.ts`), 完成 otherwise. The list has the
 * session records only: reading each one's last line would be a transcript
 * read through the reading gate per row, so it is not done.
 *
 * ## Files
 *
 * A delivered file is a card wherever it was delivered — a bot's resident
 * conversation as well (`work-tasks.md` §3.2): its kind's mark, its name, the
 * kind and size, 预览 when it has one and 下载. A preview opens over the page
 * in an iframe with an empty `sandbox` (no script, no same origin), whose
 * response carries its own policy (§4.4); the page's policy allows framing
 * this origin only (`respond.ts`, `frame-src 'self'`). A download is a plain
 * link with `download`, from the hub (§4.3).
 *
 * ## The activity panel
 *
 * Three parts at the head of the session panel, in a work session only (REA
 * §2.3): 进度 — omp's todo list, 第 x / y 步, absent while there is none; 产出
 * — the files of this session, first as delivered (from the hub's record),
 * then as the outputs folder lists them when the page could ask (§4.2); and
 * 上下文 — the workflows, skills, tools and files of the latest turn. It is
 * part of the view fragment, so it is redrawn with the transcript it is
 * read from and costs no reading of its own.
 *
 * Every string goes out escaped; the page script adds only rows it clones
 * from the document's own template and fills as text (`assets/frontWork.ts`).
 */

import type { ChatTranscript, ChatTurn } from '../deps.js'
import type { Lang } from '../i18n.js'
import {
  deliveredFiles,
  WORKFLOWS,
  type WorkActivity,
  type WorkContext,
  type WorkFileKind,
  type WorkFileRef,
  type WorkflowId,
  type WorkProgress,
  type WorkProgressStatus,
} from '../work.js'
import { icon } from './bits.js'
import { attr, escapeHtml } from './escape.js'
import { formatBytes } from './format.js'
import { FRONT_NARROW_PX } from './frontStyle.js'

// --- words ------------------------------------------------------------------------

interface WorkText {
  /** The side row, the new work page's title and the key that opens it. */
  readonly newWork: string
  readonly placeholder: string
  readonly workflows: string
  readonly flowNames: Readonly<Record<WorkflowId, string>>
  readonly removeFlow: string
  /** 由谁来做: the agent a work session goes to. */
  readonly whoDoes: string
  readonly kinds: Readonly<Record<WorkFileKind, string>>
  readonly files: string
  readonly preview: string
  readonly download: string
  readonly close: string
  readonly tooLarge: string
  readonly progress: string
  stepOf(step: number, total: number): string
  readonly items: Readonly<Record<WorkProgressStatus, string>>
  readonly outputs: string
  readonly noOutputs: string
  readonly context: string
  readonly skills: string
  readonly tools: string
  readonly states: {
    readonly running: string
    readonly waiting: string
    readonly done: string
  }
}

const ZH: WorkText = {
  newWork: '开始一项工作',
  placeholder: '描述要做的事',
  workflows: '工作流',
  flowNames: {
    slides: '演示文稿',
    document: '文档',
    sheet: '表格',
    research: '调研报告',
    webpage: '网页',
    analysis: '数据分析',
  },
  removeFlow: '去掉工作流',
  whoDoes: '由谁来做',
  kinds: {
    presentation: '演示文稿',
    document: '文档',
    spreadsheet: '表格',
    pdf: 'PDF',
    webpage: '网页',
    image: '图片',
    text: '文本',
    data: '数据',
    other: '文件',
  },
  files: '文件',
  preview: '预览',
  download: '下载',
  close: '关闭',
  tooLarge: '超过 50 MiB',
  progress: '进度',
  stepOf: (step, total) => `第 ${step} / ${total} 步`,
  items: {
    pending: '待做',
    in_progress: '进行中',
    completed: '已完成',
    abandoned: '已放弃',
    blocked: '受阻',
  },
  outputs: '产出',
  noOutputs: '还没有产出',
  context: '上下文',
  skills: '技能',
  tools: '工具',
  states: { running: '进行中', waiting: '等你', done: '完成' },
}

const EN: WorkText = {
  newWork: 'New task',
  placeholder: 'Describe the task',
  workflows: 'Workflows',
  flowNames: {
    slides: 'Slides',
    document: 'Document',
    sheet: 'Spreadsheet',
    research: 'Research report',
    webpage: 'Web page',
    analysis: 'Data analysis',
  },
  removeFlow: 'Remove workflow',
  whoDoes: 'Who does it',
  kinds: {
    presentation: 'Presentation',
    document: 'Document',
    spreadsheet: 'Spreadsheet',
    pdf: 'PDF',
    webpage: 'Web page',
    image: 'Image',
    text: 'Text',
    data: 'Data',
    other: 'File',
  },
  files: 'Files',
  preview: 'Preview',
  download: 'Download',
  close: 'Close',
  tooLarge: 'Over 50 MiB',
  progress: 'Progress',
  stepOf: (step, total) => `Step ${step} of ${total}`,
  items: {
    pending: 'To do',
    in_progress: 'In progress',
    completed: 'Done',
    abandoned: 'Dropped',
    blocked: 'Blocked',
  },
  outputs: 'Outputs',
  noOutputs: 'No outputs yet',
  context: 'Context',
  skills: 'Skills',
  tools: 'Tools',
  states: { running: 'Working', waiting: 'Needs you', done: 'Done' },
}

const JA: WorkText = {
  newWork: '新しいタスク',
  placeholder: 'タスクの内容',
  workflows: 'ワークフロー',
  flowNames: {
    slides: 'スライド',
    document: '文書',
    sheet: '表',
    research: '調査レポート',
    webpage: 'Web ページ',
    analysis: 'データ分析',
  },
  removeFlow: 'ワークフローを外す',
  whoDoes: '担当',
  kinds: {
    presentation: 'プレゼンテーション',
    document: '文書',
    spreadsheet: '表',
    pdf: 'PDF',
    webpage: 'Web ページ',
    image: '画像',
    text: 'テキスト',
    data: 'データ',
    other: 'ファイル',
  },
  files: 'ファイル',
  preview: 'プレビュー',
  download: 'ダウンロード',
  close: '閉じる',
  tooLarge: '50 MiB 超',
  progress: '進捗',
  stepOf: (step, total) => `ステップ ${step} / ${total}`,
  items: {
    pending: '未着手',
    in_progress: '進行中',
    completed: '完了',
    abandoned: '中止',
    blocked: '停止中',
  },
  outputs: '成果物',
  noOutputs: '成果物はまだありません',
  context: 'コンテキスト',
  skills: 'スキル',
  tools: 'ツール',
  states: { running: '進行中', waiting: '確認待ち', done: '完了' },
}

export const WORK_TEXT: Readonly<Record<Lang, WorkText>> = {
  'zh-CN': ZH,
  en: EN,
  ja: JA,
}

/** The page script's words for work (`frontClientText`). */
export function workClientWords(lang: Lang): Readonly<Record<string, string>> {
  const w = WORK_TEXT[lang]
  return { newWorkPlaceholder: w.placeholder }
}

// --- marks ------------------------------------------------------------------------

const FLOW_ICON: Readonly<Record<WorkflowId, string>> = {
  slides: 'presentation',
  document: 'file-text',
  sheet: 'sheet',
  research: 'book-open',
  webpage: 'globe',
  analysis: 'chart-column',
}

const KIND_ICON: Readonly<Record<WorkFileKind, string>> = {
  presentation: 'presentation',
  document: 'file-text',
  spreadsheet: 'sheet',
  pdf: 'file-text',
  webpage: 'globe',
  image: 'image',
  text: 'file-text',
  data: 'file',
  other: 'file',
}

const KINDS = Object.keys(KIND_ICON) as WorkFileKind[]

/** A workflow's mark: its icon, small. */
export function flowIcon(id: WorkflowId | undefined): string {
  return icon(id === undefined ? 'sparkles' : FLOW_ICON[id], { small: true })
}

// --- the new work page --------------------------------------------------------------

/**
 * The new work page's body, in place of the welcome: the title and the
 * workflows as one row of cards over the composer. A card picks its
 * workflow for the first line (`aria-pressed`); the page script keeps the
 * cards and the composer's chip in step.
 */
export function newWorkWelcome(lang: Lang): string {
  const w = WORK_TEXT[lang]
  const cards = WORKFLOWS.map(
    flow =>
      `<button type="button" class="fx-flow" data-action="fx-flow" data-workflow="${attr(flow.id)}" aria-pressed="false">` +
      `<span class="fx-flow-mark">${icon(FLOW_ICON[flow.id])}</span>` +
      `<span class="fx-flow-name">${escapeHtml(w.flowNames[flow.id])}</span>` +
      `<span class="fx-flow-out mono">${escapeHtml(flow.outputs.join(' · '))}</span></button>`,
  ).join('')
  return (
    `<div class="fx-welcome fx-greet fx-newwork">` +
    `<h2 class="fx-greet-title">${escapeHtml(w.newWork)}</h2>` +
    `<div class="fx-flows" role="group" aria-label="${attr(w.workflows)}">${cards}</div>` +
    `</div>`
  )
}

/**
 * The workflows in the composer's `/` menu, before the local commands
 * (REA §3.2, "Type / for skills"): `/slides` or the workflow's name in the
 * reader's language picks it.
 */
export function workflowOptions(lang: Lang): string {
  const w = WORK_TEXT[lang]
  return WORKFLOWS.map(
    flow =>
      `<button type="button" class="fx-cmd fx-cmd-flow" role="option" id="${attr(`fx-flow-opt-${flow.id}`)}" ` +
      `data-flow="${attr(flow.id)}" data-cmd="${attr(`/${flow.id}`)}" data-alt="${attr(`/${w.flowNames[flow.id]}`)}" tabindex="-1">` +
      `${icon(FLOW_ICON[flow.id], { small: true })}<code class="mono">/${escapeHtml(flow.id)}</code>` +
      `<span>${escapeHtml(w.flowNames[flow.id])}</span></button>`,
  ).join('')
}

/** The composer's chip for the workflow the next line goes with; empty until one is picked. */
export function flowChip(lang: Lang): string {
  const w = WORK_TEXT[lang]
  return (
    `<div class="fx-flow-chip" id="fx-flow-chip" data-flow="" hidden>` +
    `<span class="fx-flow-chip-mark" id="fx-flow-chip-mark"></span>` +
    `<span class="fx-flow-chip-name" id="fx-flow-chip-name"></span>` +
    `<button type="button" class="fx-flow-chip-x" data-action="fx-flow-clear" aria-label="${attr(w.removeFlow)}">` +
    `${icon('x', { small: true })}</button></div>`
  )
}

/** Over a person's line that went with a workflow: its mark and name. */
export function flowTag(id: WorkflowId, lang: Lang): string {
  return (
    `<span class="fx-flow-tag" data-workflow="${attr(id)}">${flowIcon(id)}` +
    `<span>${escapeHtml(WORK_TEXT[lang].flowNames[id])}</span></span>`
  )
}

// --- the list ----------------------------------------------------------------------

/**
 * A work session's state marks in its row: all three drawn, the row's
 * `data-state` and the approval poll's `data-asking` deciding which one
 * shows (`FRONT_WORK_CSS`), so the poll can turn 等你 on and off without
 * writing any words.
 */
export function workRowState(lang: Lang): string {
  const s = WORK_TEXT[lang].states
  return (
    `<span class="fx-wstate fx-wstate-running" role="img" aria-label="${attr(s.running)}" title="${attr(s.running)}"><span class="fx-pulse"></span></span>` +
    `<span class="fx-wstate fx-wstate-waiting" role="img" aria-label="${attr(s.waiting)}" title="${attr(s.waiting)}"><span class="fx-wstate-dot"></span></span>` +
    `<span class="fx-wstate fx-wstate-done" role="img" aria-label="${attr(s.done)}" title="${attr(s.done)}">${icon('check', { small: true })}</span>`
  )
}

// --- files ------------------------------------------------------------------------

/** Where a session's file is read from (`work-tasks.md` §4.3, §4.4). */
export function workFileUrl(
  sessionId: string,
  name: string,
  view: 'file' | 'preview',
): string {
  return `/v0/work/sessions/${encodeURIComponent(sessionId)}/${view}?name=${encodeURIComponent(name)}`
}

/** What a file row needs: a delivered file, or an output the node listed. */
interface FileFacts {
  readonly name: string
  readonly size: number
  readonly kind: WorkFileKind
  readonly preview: boolean
  readonly title?: string
  readonly tooLarge?: true
}

function baseName(name: string): string {
  return name.slice(name.lastIndexOf('/') + 1)
}

/**
 * One file: its kind's mark, its name (the agent's title for it when it
 * gave one), kind · size, then 预览 and 下载. Over 50 MiB it can be neither
 * previewed nor fetched (§4.2), and says so.
 */
function fileRow(sessionId: string, file: FileFacts, w: WorkText): string {
  const shown = file.title ?? baseName(file.name)
  const actions =
    file.tooLarge === true
      ? `<span class="fx-file-note">${escapeHtml(w.tooLarge)}</span>`
      : (file.preview
          ? `<button type="button" class="fx-file-act" data-action="fx-preview" ` +
            `data-session="${attr(sessionId)}" data-name="${attr(file.name)}" data-title="${attr(shown)}" ` +
            `aria-label="${attr(`${w.preview} · ${shown}`)}" title="${attr(w.preview)}">${icon('eye', { small: true })}</button>`
          : '') +
        `<a class="fx-file-act" href="${attr(workFileUrl(sessionId, file.name, 'file'))}" download="${attr(baseName(file.name))}" ` +
        `aria-label="${attr(`${w.download} · ${shown}`)}" title="${attr(w.download)}">${icon('download', { small: true })}</a>`
  return (
    `<div class="fx-file" data-kind="${attr(file.kind)}" data-name="${attr(file.name)}">` +
    `<span class="fx-file-mark">${icon(KIND_ICON[file.kind])}</span>` +
    `<span class="fx-file-text"><span class="fx-file-name" title="${attr(file.name)}">${escapeHtml(shown)}</span>` +
    `<span class="fx-file-meta">${escapeHtml(`${w.kinds[file.kind]} · ${formatBytes(file.size)}`)}</span></span>` +
    `<span class="fx-file-acts">${actions}</span></div>`
  )
}

/**
 * A delivery in the conversation (`noticeSource: 'files'`): the files as
 * cards, in the order they were handed over.
 */
export function fileCards(
  turn: ChatTurn,
  sessionId: string,
  lang: Lang,
): string {
  const w = WORK_TEXT[lang]
  const files = turn.files ?? []
  return (
    `<div class="fx-files" role="group" aria-label="${attr(w.files)}" data-turn="${attr(turn.id)}">` +
    files.map(file => fileRow(sessionId, file, w)).join('') +
    `</div>`
  )
}

/**
 * What the page script builds a row from when the outputs folder lists a
 * file no delivery carried (`assets/frontWork.ts`): one empty row, and each
 * kind's mark with its word. Cloned and filled as text; drawn once with the
 * document.
 */
export function fileTemplates(lang: Lang): string {
  const w = WORK_TEXT[lang]
  const row =
    `<div class="fx-file">` +
    `<span class="fx-file-mark"></span>` +
    `<span class="fx-file-text"><span class="fx-file-name"></span><span class="fx-file-meta"></span></span>` +
    `<span class="fx-file-acts">` +
    `<button type="button" class="fx-file-act" data-action="fx-preview" title="${attr(w.preview)}" data-word="${attr(w.preview)}">${icon('eye', { small: true })}</button>` +
    `<a class="fx-file-act" title="${attr(w.download)}" data-word="${attr(w.download)}">${icon('download', { small: true })}</a>` +
    `<span class="fx-file-note" hidden>${escapeHtml(w.tooLarge)}</span>` +
    `</span></div>`
  const marks = KINDS.map(
    kind =>
      `<span data-kind-mark="${attr(kind)}" data-kind-word="${attr(w.kinds[kind])}">${icon(KIND_ICON[kind])}</span>`,
  ).join('')
  return `<template id="fx-file-tpl">${row}${marks}</template>`
}

/**
 * The preview over the page: the file's name, 下载, 关闭, and where the
 * frame goes. The page has no frame until a preview is opened: the script
 * puts one in with an empty `sandbox` — no script, no same origin, no
 * forms, no popups — and takes it out when the dialog closes, so a page
 * still loads nothing of its own accord (`assets/frontWork.ts`).
 */
export function previewDialog(lang: Lang): string {
  const w = WORK_TEXT[lang]
  return (
    `<dialog class="dialog fx-preview" id="fx-preview" aria-labelledby="fx-preview-title">` +
    `<div class="fx-preview-top"><b class="fx-preview-title" id="fx-preview-title"></b>` +
    `<a class="fx-icon-btn" id="fx-preview-download" aria-label="${attr(w.download)}" title="${attr(w.download)}">${icon('download', { small: true })}</a>` +
    `<button type="button" class="fx-icon-btn" data-action="confirm-cancel" aria-label="${attr(w.close)}" title="${attr(w.close)}">${icon('x', { small: true })}</button></div>` +
    `<div class="fx-preview-body" id="fx-preview-body" data-frame-title="${attr(w.preview)}"></div>` +
    `</dialog>`
  )
}

// --- the activity panel -----------------------------------------------------------------

const ITEM_MARK: Readonly<Record<WorkProgressStatus, string>> = {
  pending: '',
  in_progress: '',
  completed: 'check',
  abandoned: 'x',
  blocked: 'alert-triangle',
}

function progressPart(progress: WorkProgress, w: WorkText): string {
  let phase = ''
  const phases = new Set(progress.items.map(item => item.phase)).size > 1
  const items = progress.items
    .map(item => {
      const head =
        phases && item.phase !== phase && item.phase !== ''
          ? `<li class="fx-todo-phase">${escapeHtml(item.phase)}</li>`
          : ''
      phase = item.phase
      const mark = ITEM_MARK[item.status]
      return (
        head +
        `<li class="fx-todo" data-status="${attr(item.status)}">` +
        `<span class="fx-todo-mark" aria-hidden="true">${mark === '' ? '' : icon(mark, { small: true })}</span>` +
        `<span class="fx-todo-text">${escapeHtml(item.content)}</span>` +
        `<span class="sr-only">${escapeHtml(w.items[item.status])}</span></li>`
      )
    })
    .join('')
  return (
    `<section class="fx-panel-sec fx-act-progress" aria-labelledby="fx-act-progress-title">` +
    `<div class="fx-panel-head"><h2 class="fx-panel-title" id="fx-act-progress-title">${escapeHtml(w.progress)}</h2>` +
    `<span class="fx-panel-count">${escapeHtml(w.stepOf(progress.step, progress.total))}</span></div>` +
    `<ol class="fx-todos">${items}</ol></section>`
  )
}

function outputsPart(
  sessionId: string,
  files: readonly WorkFileRef[],
  w: WorkText,
): string {
  return (
    `<section class="fx-panel-sec fx-act-outputs" aria-labelledby="fx-act-outputs-title">` +
    `<div class="fx-panel-head"><h2 class="fx-panel-title" id="fx-act-outputs-title">${escapeHtml(w.outputs)}</h2></div>` +
    `<div class="fx-outputs" id="fx-outputs" data-from="delivered">` +
    files.map(file => fileRow(sessionId, file, w)).join('') +
    `<p class="fx-panel-empty"${files.length === 0 ? '' : ' hidden'}>${escapeHtml(w.noOutputs)}</p>` +
    `</div></section>`
  )
}

function contextPart(
  context: WorkContext | null,
  workflow: WorkflowId | undefined,
  w: WorkText,
): string {
  const flows = [
    ...new Set([
      ...(workflow === undefined ? [] : [workflow]),
      ...(context?.workflows ?? []),
    ]),
  ]
  const flowSkills = new Set(WORKFLOWS.map(flow => flow.skill as string))
  const skills = (context?.skills ?? []).filter(skill => !flowSkills.has(skill))
  const tools = context?.tools ?? []
  const files = context?.files ?? []
  if (flows.length + skills.length + tools.length + files.length === 0)
    return ''
  const row = (label: string, body: string): string =>
    body === '' ? '' : `<dt>${escapeHtml(label)}</dt><dd>${body}</dd>`
  return (
    `<section class="fx-panel-sec fx-act-context" aria-labelledby="fx-act-context-title">` +
    `<div class="fx-panel-head"><h2 class="fx-panel-title" id="fx-act-context-title">${escapeHtml(w.context)}</h2></div>` +
    `<dl class="fx-ctx">` +
    row(
      w.workflows,
      flows
        .map(
          id =>
            `<span class="fx-ctx-chip">${flowIcon(id)}${escapeHtml(w.flowNames[id])}</span>`,
        )
        .join(''),
    ) +
    row(
      w.skills,
      skills
        .map(
          skill => `<span class="fx-ctx-chip mono">${escapeHtml(skill)}</span>`,
        )
        .join(''),
    ) +
    row(
      w.tools,
      tools
        .map(
          tool =>
            `<span class="fx-ctx-chip mono">${escapeHtml(tool.name)}` +
            `<span class="fx-ctx-count">×${escapeHtml(String(tool.count))}</span></span>`,
        )
        .join(''),
    ) +
    row(
      w.files,
      files.length === 0
        ? ''
        : `<ul class="fx-ctx-files">${files
            .map(
              file =>
                `<li class="mono" title="${attr(file)}">${escapeHtml(file)}</li>`,
            )
            .join('')}</ul>`,
    ) +
    `</dl></section>`
  )
}

/**
 * The activity panel's three parts for the conversation on screen
 * (`#fx-activity`, swapped with the view): empty and hidden unless it is a
 * work session.
 */
export function activityPanel(
  transcript: ChatTranscript | null,
  lang: Lang,
): string {
  if (transcript === null || transcript.session.work !== true) {
    return `<div class="fx-activity" id="fx-activity" hidden></div>`
  }
  const w = WORK_TEXT[lang]
  const { session, turns } = transcript
  const activity: WorkActivity = transcript.activity ?? {
    progress: null,
    context: null,
  }
  const progress =
    activity.progress !== null && activity.progress.total > 0
      ? progressPart(activity.progress, w)
      : ''
  return (
    `<div class="fx-activity" id="fx-activity" data-session="${attr(session.id)}">` +
    progress +
    outputsPart(session.id, deliveredFiles(turns), w) +
    contextPart(activity.context, session.workflow, w) +
    `</div>`
  )
}

// --- style --------------------------------------------------------------------------

export const FRONT_WORK_CSS = `
/* ---- 广泛性工作 (view/frontWork.ts) ---- */
.fx-row.fx-new-work { text-decoration: none; color: var(--color-text); }
.fx-row.fx-new-work[aria-current="true"] { background: var(--fx-selected); }
.fx-row.fx-new-work .fx-row-text { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* The new work page: the title, the cards, the composer under them. */
.fx-newwork { gap: 18px; padding-bottom: 22px; }
.fx-flows { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 8px; width: 100%; }
.fx-flow {
  display: flex; flex-direction: column; align-items: flex-start; gap: 6px; min-width: 0;
  padding: 10px 10px 9px; border: 0; border-radius: var(--radius-panel); cursor: pointer; text-align: left;
  background: var(--fx-composer); color: var(--color-text); font: inherit;
  box-shadow: inset 0 0 0 0.5px var(--fx-line);
  transition: background-color var(--motion-snap) var(--ease-out), box-shadow var(--motion-snap) var(--ease-out);
}
.fx-flow:hover { background: var(--fx-hover); }
.fx-flow:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 1px; }
.fx-flow[aria-pressed="true"] { background: var(--fx-selected); box-shadow: inset 0 0 0 1.5px var(--color-text); }
.fx-flow-mark { display: inline-grid; place-items: center; width: 28px; height: 28px; border-radius: var(--radius-control); background: var(--fx-hover); color: var(--color-quiet); }
.fx-flow-mark .i { width: 16px; height: 16px; stroke-width: 2.2; }
.fx-flow-name { max-width: 100%; overflow-wrap: break-word; line-height: 1.3; font-size: var(--text-ui); font-weight: 500; }
.fx-flow-out { max-width: 100%; line-height: 1.3; font-size: var(--text-small); color: var(--color-muted); }
/* Six across only where each card keeps its name on one line: with the
   side list and the session panel both open that takes a wide window. */
@media (max-width: 1100px) { .fx-flows { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
@media (min-width: 1101px) and (max-width: 1400px) {
  .fx[data-panel="open"]:not([data-side="closed"]) .fx-flows { grid-template-columns: repeat(3, minmax(0, 1fr)); }
}
@media (max-width: ${FRONT_NARROW_PX}px) {
  .fx-flows { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .fx-flow { flex-direction: row; align-items: center; padding: 8px; }
  .fx-flow-out { display: none; }
}

/* The composer's workflow chip, and the workflow rows of its / menu. */
.fx-flow-chip {
  display: inline-flex; align-self: flex-start; align-items: center; gap: 5px; max-width: 100%;
  margin: 0 0 2px 6px; padding: 2px 3px 2px 8px; border-radius: 999px;
  background: var(--fx-selected); color: var(--color-text); font-size: var(--text-small); font-weight: 500;
}
.fx-flow-chip[hidden] { display: none; }
.fx-flow-chip-mark { display: inline-flex; }
.fx-flow-chip-mark .i-sm { width: 13px; height: 13px; }
.fx-flow-chip-x {
  display: inline-grid; place-items: center; width: 20px; height: 20px; padding: 0; border: 0; border-radius: 50%;
  background: none; color: var(--color-muted); cursor: pointer;
}
.fx-flow-chip-x:hover { background: var(--fx-hover); color: var(--color-text); }
.fx-flow-chip-x .i-sm { width: 12px; height: 12px; }
.fx-cmd-flow { align-items: center; }
.fx-cmd-flow .i-sm { flex: none; width: 14px; height: 14px; color: var(--color-quiet); }
.fx-cmd-flow code { min-width: 92px; }
.fx-cmd-flow + .fx-cmd:not(.fx-cmd-flow):not([hidden]) { margin-top: 4px; }

/* A person's line that went with a workflow. */
.fx-flow-tag {
  display: inline-flex; align-items: center; gap: 4px; margin: 0 2px 4px; padding: 1px 8px 1px 6px; border-radius: 999px;
  background: var(--fx-hover); color: var(--color-quiet); font-size: var(--text-small);
}
.fx-flow-tag .i-sm { width: 12px; height: 12px; }

/* Who does it: the picker's heading says so on the new work page. */
.fx-pick-head-work { display: none; }
.fx:has(#fx-thread[data-new-work="1"]) .fx-pick-head-work { display: block; }
.fx:has(#fx-thread[data-new-work="1"]) .fx-pick-head-agents { display: none; }

/* A work session in the list: its workflow's mark and one of three states. */
.fx-ritem-mark { display: inline-flex; flex: none; color: var(--color-quiet); }
.fx-ritem-mark .i-sm { width: 14px; height: 14px; }
.fx-wstate { display: none; flex: none; align-items: center; justify-content: center; width: 14px; height: 14px; }
.fx-ritem-row[data-state="running"]:not([data-asking]) .fx-wstate-running,
.fx-ritem-row[data-asking] .fx-wstate-waiting,
.fx-ritem-row[data-state="done"]:not([data-asking]) .fx-wstate-done { display: inline-flex; }
.fx-wstate-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--color-warning-fill); }
.fx-wstate-done { color: var(--color-muted); }
.fx-wstate-done .i-sm { width: 12px; height: 12px; }
.fx-ritem-row[data-work] .fx-ritem { padding-right: 32px; }
.fx-ritem-row[data-work] .fx-wstate { position: absolute; right: 13px; top: 11px; }
.fx-ritem-row[data-work].is-unread .fx-unread { right: 30px; }
.fx-ritem-row[data-work]:hover .fx-wstate, .fx-ritem-row[data-work]:focus-within .fx-wstate { visibility: hidden; }

/* Files: a delivery in the conversation, and the panel's outputs. */
.fx-files { display: flex; flex-direction: column; gap: 6px; align-self: flex-start; width: min(100%, 440px); margin-top: 6px; }
.fx-file {
  display: grid; grid-template-columns: 36px minmax(0, 1fr) auto; align-items: center; gap: 10px;
  padding: 8px 8px 8px 10px; border-radius: var(--radius-panel); background: var(--fx-agent-bubble);
  box-shadow: inset 0 0 0 0.5px var(--fx-line);
}
.fx-file-mark { display: inline-grid; place-items: center; width: 36px; height: 36px; border-radius: var(--radius-control); background: var(--fx-composer); color: var(--color-quiet); }
.fx-file-mark .i { width: 18px; height: 18px; stroke-width: 2.2; }
.fx-file-text { display: flex; flex-direction: column; min-width: 0; }
.fx-file-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--text-ui); font-weight: 500; }
.fx-file-meta { font-size: var(--text-small); color: var(--color-muted); }
.fx-file-acts { display: flex; align-items: center; gap: 2px; }
.fx-file-act {
  display: inline-grid; place-items: center; width: 30px; height: 30px; padding: 0; border: 0; border-radius: var(--radius-control);
  background: none; color: var(--color-quiet); cursor: pointer;
}
.fx-file-act:hover { background: var(--fx-hover); color: var(--color-text); }
.fx-file-act:focus-visible { outline: 2px solid var(--color-focus); outline-offset: -2px; }
.fx-file-act .i-sm { width: 15px; height: 15px; }
.fx-file-note { font-size: var(--text-small); color: var(--color-muted); white-space: nowrap; }
.fx-file-note[hidden] { display: none; }
.fx:is([data-layout="chat"]) .fx-files { margin-top: 2px; }

/* The preview over the page. */
dialog.fx-preview { width: min(1100px, calc(100% - 32px)); height: min(820px, calc(100% - 48px)); max-height: none; padding: 0; gap: 0; overflow: hidden; }
dialog.fx-preview[open] { display: flex; flex-direction: column; }
.fx-preview-top { display: flex; align-items: center; gap: 4px; height: 44px; padding: 0 8px 0 16px; flex: none; border-bottom: var(--hairline); }
.fx-preview-title { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--text-ui); font-weight: 600; }
.fx-preview-body { display: flex; flex: 1 1 auto; min-height: 0; }
.fx-preview-frame { flex: 1 1 auto; width: 100%; min-height: 0; border: 0; background: #ffffff; }
@media (max-width: ${FRONT_NARROW_PX}px) {
  dialog.fx-preview { width: 100%; height: 100%; max-width: none; border-radius: 0; }
}

/* The activity panel, at the head of the session panel in a work session. */
.fx-activity { display: flex; flex-direction: column; gap: 16px; padding: 0 8px 16px; flex: none; }
.fx-activity[hidden] { display: none; }
.fx-activity:not([hidden]) + .fx-panel-body { border-top: var(--hairline); padding-top: 12px; }
.fx-activity:not([hidden]) + .fx-panel-body > .fx-panel-empty:only-child { display: none; }
.fx-activity:not([hidden]) + .fx-panel-body:has(> .fx-panel-empty:only-child) { border-top: 0; padding-top: 0; }
.fx-panel:has(.fx-activity:not([hidden])) { overflow-y: auto; }
.fx-panel:has(.fx-activity:not([hidden])) .fx-panel-body { flex: none; overflow: visible; }
.fx-todos { list-style: none; margin: 0; padding: 0 8px; display: flex; flex-direction: column; gap: 2px; }
.fx-todo { display: grid; grid-template-columns: 16px minmax(0, 1fr); align-items: start; gap: 8px; padding: 3px 0; font-size: var(--text-ui); }
.fx-todo-phase { margin: 6px 0 0; font-size: var(--text-small); color: var(--color-muted); }
.fx-todo-mark { display: inline-grid; place-items: center; width: 16px; height: 18px; }
.fx-todo-mark .i-sm { width: 12px; height: 12px; }
.fx-todo[data-status="pending"] .fx-todo-mark::before { content: ''; width: 10px; height: 10px; border-radius: 50%; box-shadow: inset 0 0 0 1.5px var(--color-neutral-400); }
.fx-todo[data-status="in_progress"] .fx-todo-mark::before { content: ''; width: 10px; height: 10px; border-radius: 50%; background: var(--color-neutral-500); animation: fx-pulse 1.6s ease-in-out infinite; }
.fx-todo[data-status="completed"] .fx-todo-mark { color: var(--color-success-text); }
.fx-todo[data-status="completed"] .fx-todo-text { color: var(--color-quiet); }
.fx-todo[data-status="blocked"] .fx-todo-mark { color: var(--color-warning-text); }
.fx-todo[data-status="abandoned"] .fx-todo-mark, .fx-todo[data-status="abandoned"] .fx-todo-text { color: var(--color-muted); }
.fx-todo[data-status="abandoned"] .fx-todo-text { text-decoration: line-through; }
.fx-todo[data-status="in_progress"] .fx-todo-text { font-weight: 500; }
.fx-outputs { display: flex; flex-direction: column; gap: 4px; }
.fx-outputs .fx-file { grid-template-columns: 28px minmax(0, 1fr) auto; gap: 8px; padding: 5px 4px 5px 8px; background: none; box-shadow: none; }
.fx-outputs .fx-file:hover { background: var(--fx-hover); }
.fx-outputs .fx-file-mark { width: 28px; height: 28px; }
.fx-outputs .fx-file-mark .i { width: 15px; height: 15px; }
.fx-outputs .fx-file-act { width: 26px; height: 26px; }
.fx-ctx { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 6px 10px; margin: 0; padding: 0 8px; font-size: var(--text-small); }
.fx-ctx dt { color: var(--color-muted); padding-top: 2px; }
.fx-ctx dd { display: flex; flex-wrap: wrap; gap: 4px; margin: 0; min-width: 0; }
.fx-ctx-chip { display: inline-flex; align-items: center; gap: 4px; max-width: 100%; padding: 1px 7px; border-radius: 999px; background: var(--fx-hover); color: var(--color-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fx-ctx-chip .i-sm { width: 12px; height: 12px; flex: none; }
.fx-ctx-count { color: var(--color-muted); }
.fx-ctx-files { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; min-width: 0; width: 100%; }
.fx-ctx-files li { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--color-quiet); }
@media (prefers-reduced-motion: reduce) { .fx-todo[data-status="in_progress"] .fx-todo-mark::before { animation: none; } }
`
