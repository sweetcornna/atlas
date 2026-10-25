// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Work outputs on the node (`work-tasks.md` §5): three host tools that make,
 * write and deliver files in the conversation's own folder, and the two
 * read-only control operations the hub lists and fetches them with.
 *
 * The folder is the conversation's (`contextId`) under the workspace of the
 * agent running it; the tools take it from the turn they are called in and
 * the control operations from the hub's session record, so neither a model
 * nor a request names a path outside it.
 */

import { createHash } from 'node:crypto'
import { z } from 'zod'
import {
  WORK_FILE_MAX_BYTES,
  workFileType,
  type WorkFileRef,
  type WorkOutput,
} from '@qianmo/console'
import type { ControlOutcome } from '@qianmo/protocol'
import type { ControlContext, ControlRegistry } from './control.js'
import { FileFault } from './filesSafeFs.js'
import type { HostToolDefinition } from './notifyTool.js'
import type { TaskToolOrigin } from './taskTools.js'
import {
  isWorkSession,
  WORK_CHUNK_BYTES,
  WorkFolder,
  workName,
  type WorkFileStat,
} from './workFiles.js'
import { printPdf } from './workPdf.js'
import {
  plainPreviewKind,
  previewOfPlainFile,
  previewOfSpec,
  IMAGE_PREVIEW_MAX_BYTES,
  TEXT_PREVIEW_MAX_BYTES,
} from './workPreview.js'
import { renderWorkSpec } from './workRender.js'
import {
  makeDocumentInput,
  parseWorkSpec,
  specTitle,
  WORK_SPEC_EXTENSION,
  type WorkSpec,
} from './workSpec.js'

export const WORK_TOOL_NAMES = {
  make: 'qianmo_make_document',
  write: 'qianmo_write_output',
  deliver: 'qianmo_deliver_files',
} as const

/** Files one delivery may carry (§5.6). */
export const WORK_DELIVER_MAX = 20
/** What `qianmo_write_output` takes. */
export const WORK_WRITE_MAX_BYTES = 5 * 1024 * 1024
const WRITE_EXTENSIONS = ['md', 'txt', 'csv', 'tsv', 'json', 'html', 'svg']

export interface NodeWorkOptions {
  readonly agents: () => readonly {
    readonly agent: string
    readonly cwd: string
  }[]
  readonly call: (
    op: string,
    args: Record<string, unknown>,
    options: { agent: string },
  ) => Promise<ControlOutcome>
  /** The console conversation and turn behind a tool call, or null. */
  readonly origin: (ctx: {
    readonly agent: string
    readonly sessionId: string
  }) => TaskToolOrigin | null
  readonly stopped: () => boolean
  readonly audit?: (
    kind: 'work.document' | 'work.write' | 'work.deliver',
    detail: Record<string, string | number | boolean>,
  ) => void
  /** Test seam: the browser PDFs print with; `null` for none. */
  readonly browser?: string | null
}

interface PreviewMeta {
  readonly v: 1
  /** The output file this preview is of, as it was when drawn. */
  readonly etag: string
  readonly origin: 'spec' | 'plain'
}

const previewMetaSchema = z
  .object({
    v: z.literal(1),
    etag: z.string(),
    origin: z.enum(['spec', 'plain']),
  })
  .strict()

const refuse = (code: string, message: string): ControlOutcome => ({
  ok: false,
  code,
  message,
})

/** Fault codes as the hub reads them (§4.7). */
function outcomeOf(error: unknown): ControlOutcome {
  const code = error instanceof FileFault ? error.code : 'internal'
  switch (code) {
    case 'not-found':
    case 'unsafe-open':
    case 'unsafe-type':
    case 'name-alias':
    case 'path-race':
    case 'no-preview':
      return refuse('not_found', '文件不存在或没有预览')
    case 'invalid-path':
    case 'too-deep':
    case 'invalid-session':
    case 'invalid-offset':
      return refuse('invalid', '文件名不合法')
    case 'limit':
      return refuse('limit', '文件超过 50 MiB')
    case 'changed':
      return refuse('changed', '文件在读取中途被改动')
    default:
      return refuse('internal', '读取产出失败')
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function kib(size: number): string {
  return size < 1024 ? `${size} B` : `${Math.round(size / 1024)} KiB`
}

/** A file name from a title: path-unsafe characters out, at most 80 long. */
export function fileNameOf(title: string, extension: string): string {
  const base =
    [
      ...[...title]
        .map(char =>
          char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 ? '/' : char,
        )
        .join('')
        .replace(/[\\/:*?"<>|]+/g, '-'),
    ]
      .slice(0, 80)
      .join('')
      .replace(/^[.\s-]+|[.\s]+$/g, '') || 'untitled'
  return `${base}.${extension}`
}

const MAKE_DESCRIPTION = `Make a PowerPoint (.pptx), Word (.docx) or Excel (.xlsx) file from a structured description, in this conversation's outputs folder, with an HTML preview drawn from the same description; pdf: true also prints a PDF when this node has a browser. Read the workflow skill's reference first (qmo-slides, qmo-document, qmo-sheet): it gives the exact shape of spec. kind slides: spec {title, subtitle?, author?, theme?, slides: [{layout: title|section|bullets|two-column|table|chart|quote|closing, title?, subtitle?, bullets?, columns?, table?, chart?, quote?, notes?}]}. kind document: spec {title, subtitle?, author?, theme?, blocks: [{type: heading|paragraph|bullets|numbered|table|quote|chart|pagebreak, …}]}. kind sheet: spec {title?, theme?, sheets: [{name, columns: [{header, type?, width?}], rows, freezeHeader?}]}. theme: classic|ocean|forest|sunset|graphite. file is the name in the outputs folder (made from the title when left out); making it again under the same name replaces it. The description is saved as sources/<file>.json for later revisions. Nothing reaches the person until you deliver it with qianmo_deliver_files.`

const WRITE_DESCRIPTION = `Write one text file into this conversation's outputs folder: .md, .txt, .csv, .tsv, .json, .html or .svg, at most 5 MiB. Use it for a web page (one self-contained .html with inline CSS; scripts will not run in the preview), Markdown notes, or data. An existing file of that name is replaced. Nothing reaches the person until you deliver it with qianmo_deliver_files.`

const DELIVER_DESCRIPTION = `Hand finished files from this conversation's outputs folder to the person: each appears as a file card in the conversation that they can preview and download. Give up to 20 names as they are in the outputs folder (for example "季度汇报.pptx"), each with an optional short title. Deliver once, when the files are ready; deliver a file again after you change it. Only files you made with qianmo_make_document or qianmo_write_output (or wrote into the outputs folder yourself) can be delivered.`

export class NodeWork {
  readonly #options: NodeWorkOptions

  constructor(options: NodeWorkOptions) {
    this.#options = options
  }

  #workspace(agent: string): string {
    const row = this.#options.agents().find(one => one.agent === agent)
    if (row === undefined) throw new FileFault('not-found')
    return row.cwd
  }

  #folder(agent: string, session: string): WorkFolder {
    if (!isWorkSession(session)) throw new FileFault('invalid-session')
    return new WorkFolder(this.#workspace(agent), session)
  }

  #audit(
    kind: 'work.document' | 'work.write' | 'work.deliver',
    detail: Record<string, string | number | boolean>,
  ): void {
    try {
      this.#options.audit?.(kind, detail)
    } catch {
      // Auditing never fails the tool.
    }
  }

  // ── previews ────────────────────────────────────────────────────────────

  #previewMeta(folder: WorkFolder, name: string): PreviewMeta | null {
    try {
      const { data } = folder.readAll('previews', `${name}.json`, 4096)
      const parsed = previewMetaSchema.safeParse(
        JSON.parse(new TextDecoder().decode(data)),
      )
      return parsed.success ? parsed.data : null
    } catch {
      return null
    }
  }

  #hasPreview(folder: WorkFolder, name: string, stat: WorkFileStat): boolean {
    if (stat.size > WORK_FILE_MAX_BYTES) return false
    const plain = plainPreviewKind(name, stat.size)
    if (plain === 'self') return true
    if (this.#previewMeta(folder, name)?.etag === stat.etag) return true
    return plain === 'render'
  }

  /**
   * Where the preview of `name` is served from. A file made from a
   * description has the page drawn with it, while the file is still the one
   * drawn; a page is its own preview; text and images are drawn here once
   * per version of the file.
   */
  #resolvePreview(
    folder: WorkFolder,
    name: string,
  ): { readonly part: 'outputs' | 'previews'; readonly file: string } {
    const stat = folder.stat('outputs', name)
    if (stat === null) throw new FileFault('not-found')
    if (stat.size > WORK_FILE_MAX_BYTES) throw new FileFault('limit')
    const plain = plainPreviewKind(name, stat.size)
    if (plain === 'self') return { part: 'outputs', file: name }
    const file = `${name}.html`
    if (this.#previewMeta(folder, name)?.etag === stat.etag)
      return { part: 'previews', file }
    if (plain !== 'render') throw new FileFault('no-preview')
    const max =
      workFileType(name).kind === 'image'
        ? IMAGE_PREVIEW_MAX_BYTES
        : TEXT_PREVIEW_MAX_BYTES
    const source = folder.readAll('outputs', name, max)
    folder.write(
      'previews',
      file,
      new TextEncoder().encode(previewOfPlainFile(name, source.data)),
    )
    const meta: PreviewMeta = { v: 1, etag: source.stat.etag, origin: 'plain' }
    folder.write(
      'previews',
      `${name}.json`,
      new TextEncoder().encode(JSON.stringify(meta)),
    )
    return { part: 'previews', file }
  }

  // ── control operations ────────────────────────────────────────────────

  register(registry: ControlRegistry): void {
    // Both read only; under ESTOP a person can still take what was made.
    registry.register('work', (op, args, ctx) => this.handle(op, args, ctx), {
      estopAllowed: ['work.list', 'work.read'],
    })
  }

  async handle(
    op: string,
    args: Record<string, unknown>,
    ctx: ControlContext,
  ): Promise<ControlOutcome> {
    try {
      if (op === 'work.list') return this.#list(args)
      if (op === 'work.read') return this.#read(args, ctx)
      return refuse('unsupported', '不支持此控制操作')
    } catch (error) {
      return outcomeOf(error)
    }
  }

  #list(args: Record<string, unknown>): ControlOutcome {
    const parsed = z
      .object({ agent: z.string().min(1), session: z.string() })
      .strict()
      .safeParse(args)
    if (!parsed.success) return refuse('invalid', '参数不合法')
    const folder = this.#folder(parsed.data.agent, parsed.data.session)
    const listed = folder.list()
    const files: WorkOutput[] = listed.files.map(file => {
      const type = workFileType(file.name)
      return {
        name: file.name,
        size: file.size,
        kind: type.kind,
        mime: type.mime,
        mtime: Math.floor(file.mtimeMs),
        preview: this.#hasPreview(folder, file.name, file),
        ...(file.size > WORK_FILE_MAX_BYTES ? { tooLarge: true as const } : {}),
      }
    })
    return { ok: true, value: { files, truncated: listed.truncated } }
  }

  #read(args: Record<string, unknown>, ctx: ControlContext): ControlOutcome {
    const parsed = z
      .object({
        agent: z.string().min(1),
        session: z.string(),
        name: z.string(),
        view: z.enum(['file', 'preview']),
        offset: z.number().int().min(0),
        etag: z.string().max(64).optional(),
      })
      .strict()
      .safeParse(args)
    if (!parsed.success) return refuse('invalid', '参数不合法')
    const { agent, session, view, offset, etag } = parsed.data
    const name = workName(parsed.data.name)
    const folder = this.#folder(agent, session)
    const source =
      view === 'file'
        ? { part: 'outputs' as const, file: name }
        : this.#resolvePreview(folder, name)
    const chunk = folder.read(
      source.part,
      source.file,
      offset,
      WORK_CHUNK_BYTES,
      etag,
    )
    const outcome: ControlOutcome = {
      ok: true,
      value: {
        name,
        size: chunk.stat.size,
        mime:
          view === 'file'
            ? workFileType(name).mime
            : 'text/html; charset=utf-8',
        etag: chunk.stat.etag,
        offset,
        data: Buffer.from(chunk.data).toString('base64'),
        eof: offset + chunk.data.byteLength >= chunk.stat.size,
      },
    }
    if (ctx.resultFits !== undefined && !ctx.resultFits(outcome))
      return refuse('internal', '分块超过信封上限')
    return outcome
  }

  // ── tools ─────────────────────────────────────────────────────────────

  #where(ctx: {
    readonly agent: string
    readonly sessionId: string
  }):
    | { readonly origin: TaskToolOrigin; readonly folder: WorkFolder }
    | string {
    if (this.#options.stopped())
      return 'Refused: this node is halted by its emergency stop.'
    const origin = this.#options.origin(ctx)
    if (origin === null || !isWorkSession(origin.contextId))
      return 'This conversation cannot store files: work files are only available in a console or chat-channel conversation.'
    try {
      return { origin, folder: this.#folder(ctx.agent, origin.contextId) }
    } catch {
      return 'This conversation cannot store files: the agent has no workspace on this node.'
    }
  }

  tools(): HostToolDefinition[] {
    return [this.#makeTool(), this.#writeTool(), this.#deliverTool()]
  }

  #makeTool(): HostToolDefinition {
    return {
      name: WORK_TOOL_NAMES.make,
      description: MAKE_DESCRIPTION,
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', enum: ['slides', 'document', 'sheet'] },
          file: {
            type: 'string',
            description:
              'Optional. Name in the outputs folder, e.g. "季度汇报.pptx"; the extension follows kind.',
          },
          pdf: {
            type: 'boolean',
            description:
              'Optional. Also print a PDF (slides and documents only).',
          },
          spec: {
            type: 'object',
            additionalProperties: true,
            description:
              'The description; its shape is in the workflow skill reference.',
          },
        },
        required: ['kind', 'spec'],
      },
      handler: async (raw, ctx) => {
        const where = this.#where(ctx)
        if (typeof where === 'string') return { ok: false, text: where }
        const input = makeDocumentInput.safeParse(
          raw !== null && typeof raw === 'object'
            ? Object.fromEntries(
                Object.entries(raw).filter(([, value]) => value !== null),
              )
            : raw,
        )
        if (!input.success)
          return {
            ok: false,
            text: 'Invalid arguments: give kind (slides, document or sheet) and spec.',
          }
        const parsed = parseWorkSpec(input.data.kind, input.data.spec)
        if (!parsed.ok)
          return {
            ok: false,
            text: `The description has problems; fix them and call again:\n${parsed.issues.join('\n')}`,
          }
        const spec = parsed.value
        const extension = WORK_SPEC_EXTENSION[spec.kind]
        let file: string
        try {
          const given = input.data.file?.trim()
          file = workName(
            given === undefined || given === ''
              ? fileNameOf(specTitle(spec), extension)
              : given.toLowerCase().endsWith(`.${extension}`)
                ? given
                : `${given}.${extension}`,
          )
        } catch {
          return {
            ok: false,
            text: 'Invalid file name: use a relative name such as "报告.docx", without "..", "\\", ":" or a leading "/", at most four folders deep.',
          }
        }
        return await this.#make(where.origin, where.folder, spec, file, {
          pdf: input.data.pdf === true,
          agent: ctx.agent,
        })
      },
    }
  }

  async #make(
    origin: TaskToolOrigin,
    folder: WorkFolder,
    spec: WorkSpec,
    file: string,
    options: { readonly pdf: boolean; readonly agent: string },
  ): Promise<{ ok: boolean; text: string; details?: unknown }> {
    let bytes: Uint8Array
    try {
      bytes = await renderWorkSpec(spec)
    } catch (error) {
      return {
        ok: false,
        text: `Could not make the file: ${error instanceof Error ? error.message.slice(0, 300) : 'unknown error'}`,
      }
    }
    if (bytes.byteLength > WORK_FILE_MAX_BYTES)
      return { ok: false, text: 'Not made: the file would exceed 50 MiB.' }
    const html = previewOfSpec(spec)
    let made: WorkFileStat
    try {
      const encoder = new TextEncoder()
      folder.write(
        'sources',
        `${file}.json`,
        encoder.encode(
          JSON.stringify({ v: 1, kind: spec.kind, spec: spec.spec }, null, 2),
        ),
      )
      folder.write('previews', `${file}.html`, encoder.encode(html))
      made = folder.write('outputs', file, bytes)
      const meta: PreviewMeta = { v: 1, etag: made.etag, origin: 'spec' }
      folder.write(
        'previews',
        `${file}.json`,
        encoder.encode(JSON.stringify(meta)),
      )
    } catch (error) {
      return {
        ok: false,
        text: `Not saved: ${error instanceof FileFault ? error.code : 'the outputs folder could not be written'}.`,
      }
    }
    const digest = sha256(bytes)
    this.#audit('work.document', {
      agent: options.agent,
      session: origin.contextId,
      file,
      size: made.size,
      sha256: digest,
    })
    const count =
      spec.kind === 'slides'
        ? `${spec.spec.slides.length} slides`
        : spec.kind === 'document'
          ? `${spec.spec.blocks.length} blocks`
          : `${spec.spec.sheets.length} sheets`
    const lines = [
      `Made ${file} (${count}, ${kib(made.size)}) in the outputs folder, with a preview. The description is saved as sources/${file}.json.`,
    ]
    let pdfName: string | undefined
    if (options.pdf && spec.kind !== 'sheet') {
      const printed = await printPdf(
        html,
        this.#options.browser === undefined
          ? {}
          : { browser: this.#options.browser },
      )
      if (printed.ok) {
        pdfName = file.replace(/\.(?:pptx|docx)$/i, '.pdf')
        try {
          const pdf = folder.write('outputs', pdfName, printed.pdf)
          this.#audit('work.document', {
            agent: options.agent,
            session: origin.contextId,
            file: pdfName,
            size: pdf.size,
            sha256: sha256(printed.pdf),
          })
          lines.push(`Printed ${pdfName} (${kib(pdf.size)}).`)
        } catch {
          pdfName = undefined
          lines.push('PDF not saved: the outputs folder could not be written.')
        }
      } else
        lines.push(`PDF not made: ${printed.reason}. Say so to the person.`)
    } else if (options.pdf)
      lines.push('PDF not made: spreadsheets are not printed.')
    lines.push(
      'Check it, then hand it over with qianmo_deliver_files; nothing reaches the person before that.',
    )
    return {
      ok: true,
      text: lines.join('\n'),
      details: {
        file,
        size: made.size,
        sha256: digest,
        ...(pdfName === undefined ? {} : { pdf: pdfName }),
      },
    }
  }

  #writeTool(): HostToolDefinition {
    return {
      name: WORK_TOOL_NAMES.write,
      description: WRITE_DESCRIPTION,
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          file: {
            type: 'string',
            description: 'Name in the outputs folder, e.g. "落地页.html".',
          },
          content: { type: 'string' },
        },
        required: ['file', 'content'],
      },
      handler: async (raw, ctx) => {
        const where = this.#where(ctx)
        if (typeof where === 'string') return { ok: false, text: where }
        const input = z
          .object({ file: z.string(), content: z.string() })
          .strict()
          .safeParse(raw)
        if (!input.success)
          return {
            ok: false,
            text: 'Invalid arguments: give file and content.',
          }
        let file: string
        try {
          file = workName(input.data.file.trim())
        } catch {
          return {
            ok: false,
            text: 'Invalid file name: use a relative name such as "notes.md", without "..", "\\", ":" or a leading "/".',
          }
        }
        const extension = file.slice(file.lastIndexOf('.') + 1).toLowerCase()
        if (!file.includes('.') || !WRITE_EXTENSIONS.includes(extension))
          return {
            ok: false,
            text: `Not written: this tool writes ${WRITE_EXTENSIONS.map(one => `.${one}`).join(' ')}; make office files with qianmo_make_document.`,
          }
        const bytes = new TextEncoder().encode(input.data.content)
        if (bytes.byteLength > WORK_WRITE_MAX_BYTES)
          return { ok: false, text: 'Not written: more than 5 MiB.' }
        let stat: WorkFileStat
        try {
          stat = where.folder.write('outputs', file, bytes)
        } catch (error) {
          return {
            ok: false,
            text: `Not written: ${error instanceof FileFault ? error.code : 'the outputs folder could not be written'}.`,
          }
        }
        this.#audit('work.write', {
          agent: ctx.agent,
          session: where.origin.contextId,
          file,
          size: stat.size,
          sha256: sha256(bytes),
        })
        return {
          ok: true,
          text: `Wrote ${file} (${kib(stat.size)}) in the outputs folder. Hand it over with qianmo_deliver_files when it is ready.`,
          details: { file, size: stat.size },
        }
      },
    }
  }

  #deliverTool(): HostToolDefinition {
    return {
      name: WORK_TOOL_NAMES.deliver,
      description: DELIVER_DESCRIPTION,
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          files: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string' },
                title: {
                  type: 'string',
                  description: 'Optional. A short name to show on the card.',
                },
              },
              required: ['name'],
            },
          },
        },
        required: ['files'],
      },
      handler: async (raw, ctx) => {
        const where = this.#where(ctx)
        if (typeof where === 'string') return { ok: false, text: where }
        const input = z
          .object({
            files: z
              .array(
                z
                  .object({
                    name: z.string(),
                    title: z.string().max(200).nullable().optional(),
                  })
                  .strict(),
              )
              .min(1)
              .max(WORK_DELIVER_MAX),
          })
          .strict()
          .safeParse(raw)
        if (!input.success)
          return {
            ok: false,
            text: `Invalid arguments: give files, 1-${WORK_DELIVER_MAX} entries of {name, title?}.`,
          }
        const refs: WorkFileRef[] = []
        const problems: string[] = []
        const seen = new Set<string>()
        for (const entry of input.data.files) {
          let name: string
          try {
            name = workName(entry.name.trim().replace(/^outputs\//, ''))
          } catch {
            problems.push(
              `${entry.name}: not a valid name in the outputs folder`,
            )
            continue
          }
          if (seen.has(name)) continue
          seen.add(name)
          try {
            const { stat, sha256: digest } = where.folder.sha256(
              'outputs',
              name,
            )
            const type = workFileType(name)
            const title = entry.title?.trim()
            refs.push({
              name,
              size: stat.size,
              kind: type.kind,
              mime: type.mime,
              sha256: digest,
              preview: this.#hasPreview(where.folder, name, stat),
              ...(title === undefined || title === '' ? {} : { title }),
            })
          } catch (error) {
            const code = error instanceof FileFault ? error.code : 'unreadable'
            problems.push(
              `${name}: ${
                code === 'not-found'
                  ? 'no such file in the outputs folder'
                  : code === 'limit'
                    ? 'larger than 50 MiB'
                    : code === 'unsafe-open' || code === 'unsafe-type'
                      ? 'a link or not a regular file'
                      : `cannot be read (${code})`
              }`,
            )
          }
        }
        if (problems.length > 0)
          return {
            ok: false,
            text: `Nothing delivered:\n${problems.join('\n')}`,
          }
        let result: ControlOutcome
        try {
          result = await this.#options.call(
            'work.deliver',
            {
              contextId: where.origin.contextId,
              taskId: where.origin.taskId,
              files: refs,
            },
            { agent: ctx.agent },
          )
        } catch {
          result = refuse('unreachable', 'hub did not answer')
        }
        if (!result.ok)
          return {
            ok: false,
            text: `Not delivered: ${result.message}. The files are still in the outputs folder; try again later or tell the person where they are.`,
            details: result,
          }
        this.#audit('work.deliver', {
          agent: ctx.agent,
          session: where.origin.contextId,
          files: refs.map(ref => ref.name).join('\n'),
          size: refs.reduce((sum, ref) => sum + ref.size, 0),
          sha256: refs.map(ref => ref.sha256).join(','),
        })
        return {
          ok: true,
          text: `Delivered ${refs.length} file${refs.length === 1 ? '' : 's'} to the person as file cards: ${refs.map(ref => ref.name).join(', ')}.`,
          details: { files: refs },
        }
      },
    }
  }
}
