// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 广泛性工作（P37.17 B，`docs/dev/work-tasks.md`）的共用形状：六个工作流、
 * 交付文件的种类，以及节点报来的进度与上下文。
 *
 * 叶子模块，不引用本包的其他文件：`deps.ts` 的会话、轮次与转录类型要用它，而
 * 端口（`WorkPort`）住在 `deps.ts`，两边互相引用就是一个环（循环预算为 0）。
 * 中枢（`consoleWork.ts`）与节点（`host/workTools.ts`）读的是同一张表，文件
 * 种类与 MIME 只在这里写一次。
 */

/** 首批六个工作流，表的顺序就是卡片顺序（§2.1）。 */
export const WORKFLOWS = [
  { id: 'slides', skill: 'qmo-slides', outputs: ['pptx', 'pdf'] },
  { id: 'document', skill: 'qmo-document', outputs: ['docx', 'pdf'] },
  { id: 'sheet', skill: 'qmo-sheet', outputs: ['xlsx'] },
  { id: 'research', skill: 'qmo-research', outputs: ['docx'] },
  { id: 'webpage', skill: 'qmo-webpage', outputs: ['html'] },
  { id: 'analysis', skill: 'qmo-analysis', outputs: ['xlsx', 'pptx', 'docx'] },
] as const

export type WorkflowId = (typeof WORKFLOWS)[number]['id']

export interface Workflow {
  readonly id: WorkflowId
  /** omp 的技能名；带着工作流发的那一句点名它（{@link workflowPrompt}）。 */
  readonly skill: string
  readonly outputs: readonly string[]
}

const WORKFLOW_IDS: ReadonlySet<string> = new Set(WORKFLOWS.map(one => one.id))

export function isWorkflowId(value: unknown): value is WorkflowId {
  return typeof value === 'string' && WORKFLOW_IDS.has(value)
}

export function workflowOf(id: WorkflowId): Workflow {
  return WORKFLOWS.find(one => one.id === id)!
}

/** 技能名对应的工作流；不是工作流的技能是 `undefined`。 */
export function workflowOfSkill(skill: string): WorkflowId | undefined {
  return WORKFLOWS.find(one => one.skill === skill)?.id
}

/**
 * 发给节点的那句话：原文前面一行点名工作流的技能、让智能体先读它（§2.2）。
 * 转录里留的是原文，这一行只进信封。
 *
 * 不写成 omp 的技能命令 `/skill:<名>`：常驻侧把这句话包进 teammate 块里交给
 * omp，命令不在行首、前面是引号，omp 不认；而把命令挪到包好的消息末行时，
 * omp 把这一轮改成技能消息，常驻侧等的那条用户消息不再出现，这一轮收不进来。
 * 读 `skill://<名>` 走的是 omp 自己的技能目录，与命令展开读的是同一份文件。
 */
export function workflowPrompt(id: WorkflowId, text: string): string {
  const { skill } = workflowOf(id)
  return `[工作流 ${skill}] 先读 skill://${skill}，按里面的步骤做。\n${text}`
}

export type WorkFileKind =
  | 'presentation'
  | 'document'
  | 'spreadsheet'
  | 'pdf'
  | 'webpage'
  | 'image'
  | 'text'
  | 'data'
  | 'other'

/** 扩展名 → 种类与 MIME。认不出的是 `other` / `application/octet-stream`。 */
const FILE_TYPES: Readonly<
  Record<string, { readonly kind: WorkFileKind; readonly mime: string }>
> = {
  pptx: {
    kind: 'presentation',
    mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  },
  docx: {
    kind: 'document',
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  },
  xlsx: {
    kind: 'spreadsheet',
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  },
  csv: { kind: 'spreadsheet', mime: 'text/csv; charset=utf-8' },
  tsv: {
    kind: 'spreadsheet',
    mime: 'text/tab-separated-values; charset=utf-8',
  },
  pdf: { kind: 'pdf', mime: 'application/pdf' },
  html: { kind: 'webpage', mime: 'text/html; charset=utf-8' },
  htm: { kind: 'webpage', mime: 'text/html; charset=utf-8' },
  png: { kind: 'image', mime: 'image/png' },
  jpg: { kind: 'image', mime: 'image/jpeg' },
  jpeg: { kind: 'image', mime: 'image/jpeg' },
  gif: { kind: 'image', mime: 'image/gif' },
  webp: { kind: 'image', mime: 'image/webp' },
  svg: { kind: 'image', mime: 'image/svg+xml' },
  md: { kind: 'text', mime: 'text/markdown; charset=utf-8' },
  txt: { kind: 'text', mime: 'text/plain; charset=utf-8' },
  json: { kind: 'data', mime: 'application/json' },
}

export function workFileType(name: string): {
  readonly kind: WorkFileKind
  readonly mime: string
} {
  const dot = name.lastIndexOf('.')
  const extension = dot < 0 ? '' : name.slice(dot + 1).toLowerCase()
  return (
    FILE_TYPES[extension] ?? {
      kind: 'other',
      mime: 'application/octet-stream',
    }
  )
}

/** 单个文件的上限（§5.6）：生成、写入、交付、下载、预览一律。 */
export const WORK_FILE_MAX_BYTES = 50 * 1024 * 1024

/** 一个交付出来的文件（§3.2）。 */
export interface WorkFileRef {
  /** 产出目录里的相对路径，`/` 分隔。 */
  readonly name: string
  readonly size: number
  readonly kind: WorkFileKind
  readonly mime: string
  readonly sha256: string
  readonly preview: boolean
  readonly title?: string
}

/** 列产出的一项（§4.2）。 */
export interface WorkOutput {
  readonly name: string
  readonly size: number
  readonly kind: WorkFileKind
  readonly mime: string
  readonly mtime: number
  readonly preview: boolean
  readonly tooLarge?: true
}

export type WorkProgressStatus =
  | 'pending'
  | 'in_progress'
  | 'completed'
  | 'abandoned'
  | 'blocked'

export interface WorkProgressItem {
  readonly phase: string
  readonly content: string
  readonly status: WorkProgressStatus
}

/** omp 待办工具的当前清单（§3.3）。 */
export interface WorkProgress {
  readonly taskId: string
  readonly at: number
  readonly total: number
  readonly done: number
  readonly step: number
  readonly current: string | null
  readonly items: readonly WorkProgressItem[]
}

/** 最近一轮用到的工作流、工具与文件（§3.3）。 */
export interface WorkContext {
  readonly taskId: string
  readonly at: number
  readonly workflows: readonly WorkflowId[]
  readonly skills: readonly string[]
  readonly tools: readonly { readonly name: string; readonly count: number }[]
  readonly files: readonly string[]
}

export interface WorkActivity {
  readonly progress: WorkProgress | null
  readonly context: WorkContext | null
}

/**
 * 从清单条目算出「第 x / y 步」：放弃的不算总数；正在做的那一条算进当前步，
 * 不超过总数（§3.3）。
 */
export function progressOf(
  taskId: string,
  at: number,
  items: readonly WorkProgressItem[],
): WorkProgress | null {
  const counted = items.filter(item => item.status !== 'abandoned')
  if (counted.length === 0) return null
  const done = counted.filter(item => item.status === 'completed').length
  const current =
    counted.find(item => item.status === 'in_progress')?.content ?? null
  return {
    taskId,
    at,
    total: counted.length,
    done,
    step: Math.min(counted.length, done + (current === null ? 0 : 1)),
    current,
    items,
  }
}

/** 产出目录里文件名的深度上限，含文件本身（§4.2）。 */
export const WORK_NAME_MAX_DEPTH = 4

/**
 * `name` 能不能当产出目录里的相对路径（§4.7 的 400 `invalid`）：非空、至多
 * 2048 字节、不以 `/` 开头，没有 `\`、`:`、控制字符，每段非空、不是 `.` 或
 * `..`、不以点或空格结尾，至多四段。节点那一侧另按目录句柄逐段核对，这里只
 * 挡明显不合格的，免得白跑一趟控制链路。
 */
export function isWorkName(name: unknown): name is string {
  if (typeof name !== 'string' || name === '' || name.startsWith('/'))
    return false
  if (new TextEncoder().encode(name).byteLength > 2048) return false
  if (
    /[\\:]/.test(name) ||
    [...name].some(
      char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
    )
  )
    return false
  const parts = name.split('/')
  return (
    parts.length <= WORK_NAME_MAX_DEPTH &&
    parts.every(
      part =>
        part !== '' && part !== '.' && part !== '..' && !/[. ]$/.test(part),
    )
  )
}

/**
 * 一条会话的文件卡里交付过的文件：按 `name` 取最后一次，按交付时间倒序
 * （§4.5 的 `delivered`）。
 */
export function deliveredFiles(
  turns: readonly {
    readonly at: number
    readonly noticeSource?: string
    readonly files?: readonly WorkFileRef[]
  }[],
): WorkFileRef[] {
  const last = new Map<
    string,
    { at: number; order: number; file: WorkFileRef }
  >()
  let order = 0
  for (const turn of turns) {
    if (turn.noticeSource !== 'files' || turn.files === undefined) continue
    for (const file of turn.files) {
      last.delete(file.name)
      last.set(file.name, { at: turn.at, order: order++, file })
    }
  }
  return [...last.values()]
    .sort((a, b) => b.at - a.at || b.order - a.order)
    .map(one => one.file)
}

// --- 读进来的形状：节点报的、落盘重放的，一律在这里核对 -----------------------

const FILE_KINDS: ReadonlySet<string> = new Set<WorkFileKind>([
  'presentation',
  'document',
  'spreadsheet',
  'pdf',
  'webpage',
  'image',
  'text',
  'data',
  'other',
])

const PROGRESS_STATUSES: ReadonlySet<string> = new Set<WorkProgressStatus>([
  'pending',
  'in_progress',
  'completed',
  'abandoned',
  'blocked',
])

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function boundedText(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.length <= max ? value : null
}

/** 一个交付文件，或 `null`（形状不对就整条不认）。 */
export function parseWorkFileRef(value: unknown): WorkFileRef | null {
  const row = recordOf(value)
  if (row === null) return null
  const { name, size, kind, mime, sha256, preview, title } = row
  if (!isWorkName(name)) return null
  if (
    typeof size !== 'number' ||
    !Number.isSafeInteger(size) ||
    size < 0 ||
    size > WORK_FILE_MAX_BYTES
  )
    return null
  if (typeof kind !== 'string' || !FILE_KINDS.has(kind)) return null
  if (boundedText(mime, 200) === null) return null
  if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) return null
  if (typeof preview !== 'boolean') return null
  const shown = title === undefined ? null : boundedText(title, 200)
  if (title !== undefined && shown === null) return null
  return {
    name,
    size,
    kind: kind as WorkFileKind,
    mime: mime as string,
    sha256,
    preview,
    ...(shown === null || shown === '' ? {} : { title: shown }),
  }
}

/** 待办清单的条目，最多 100 条；形状不对时 `null`。 */
export function parseProgressItems(value: unknown): WorkProgressItem[] | null {
  if (!Array.isArray(value) || value.length > 100) return null
  const items: WorkProgressItem[] = []
  for (const one of value) {
    const row = recordOf(one)
    if (row === null) return null
    const phase = boundedText(row.phase, 200)
    const content = boundedText(row.content, 500)
    if (phase === null || content === null) return null
    if (typeof row.status !== 'string' || !PROGRESS_STATUSES.has(row.status))
      return null
    items.push({
      phase,
      content,
      status: row.status as WorkProgressStatus,
    })
  }
  return items
}

function names(value: unknown, max: number, each: number): string[] | null {
  if (!Array.isArray(value)) return null
  const out: string[] = []
  for (const one of value.slice(0, max)) {
    const text = boundedText(one, each)
    if (text === null || text === '') continue
    if (!out.includes(text)) out.push(text)
  }
  return out
}

/** 节点报来的上下文（技能、工具、文件）；工作流由中枢补。 */
export function parseReportedContext(value: unknown): {
  readonly skills: readonly string[]
  readonly tools: readonly { readonly name: string; readonly count: number }[]
  readonly files: readonly string[]
} | null {
  const row = recordOf(value)
  if (row === null) return null
  const skills = names(row.skills, 50, 160)
  const files = names(row.files, 50, 1024)
  if (skills === null || files === null || !Array.isArray(row.tools))
    return null
  const tools: { name: string; count: number }[] = []
  for (const one of row.tools.slice(0, 50)) {
    const tool = recordOf(one)
    const name = boundedText(tool?.name, 160)
    const count = tool?.count
    if (
      name === null ||
      name === '' ||
      typeof count !== 'number' ||
      !Number.isSafeInteger(count) ||
      count < 1
    )
      continue
    if (!tools.some(seen => seen.name === name)) tools.push({ name, count })
  }
  return { skills, tools, files }
}

/** 重放落盘的一份活动；认不出的部分当作没有。 */
export function parseWorkActivity(value: unknown): WorkActivity | null {
  const row = recordOf(value)
  if (row === null) return null
  const progressRow = recordOf(row.progress)
  const contextRow = recordOf(row.context)
  let progress: WorkProgress | null = null
  if (progressRow !== null) {
    const items = parseProgressItems(progressRow.items)
    const taskId = boundedText(progressRow.taskId, 200)
    const at = progressRow.at
    if (items !== null && taskId !== null && typeof at === 'number')
      progress = progressOf(taskId, at, items)
  }
  let context: WorkContext | null = null
  if (contextRow !== null) {
    const reported = parseReportedContext(contextRow)
    const taskId = boundedText(contextRow.taskId, 200)
    const at = contextRow.at
    const flows = Array.isArray(contextRow.workflows)
      ? contextRow.workflows.filter(isWorkflowId)
      : []
    if (reported !== null && taskId !== null && typeof at === 'number')
      context = { taskId, at, workflows: flows, ...reported }
  }
  return { progress, context }
}
