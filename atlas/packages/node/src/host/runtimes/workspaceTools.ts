// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  type Dirent,
  closeSync,
  fstatSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  statSync,
} from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import {
  residentToolVerdict,
  type ResidentExtensionConfig,
} from '@qianmo/extension/policy'
import type { RuntimeToolResult, RuntimeToolSpec } from './toolHost.js'

/**
 * Workspace reading for Codex when it runs without a shell.
 *
 * Codex reads files only through its shell, and its sandbox cannot confine
 * reads, so a resident Codex agent has no shell by default (the documented
 * exception to native adaptation, charter §7.2 item 8). These three tools
 * give it the read side of the workspace, confined by the same resident
 * verdict qianmopi's `read`/`grep`/`glob` go through. Claude Code keeps its
 * native `Read`/`Grep`/`Glob`: they stay inside its working directory and
 * anything outside goes through the permission tool.
 */
export const WORKSPACE_TOOLS: readonly RuntimeToolSpec[] = [
  {
    name: 'qianmo_read_file',
    description:
      'Read a text file inside this agent workspace. Returns numbered lines; use offset/limit (1-based lines) for large files.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string', minLength: 1 },
        offset: { type: 'integer', minimum: 1 },
        limit: { type: 'integer', minimum: 1, maximum: 4000 },
      },
      required: ['path'],
    },
  },
  {
    name: 'qianmo_list_files',
    description:
      'List files under a directory of this agent workspace (recursive, skips .git and node_modules). Optional glob pattern such as "**/*.ts".',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string' },
        pattern: { type: 'string' },
      },
    },
  },
  {
    name: 'qianmo_search',
    description:
      'Search file contents under a directory of this agent workspace with a regular expression. Returns path:line: text matches.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        pattern: { type: 'string', minLength: 1 },
        path: { type: 'string' },
        glob: { type: 'string' },
      },
      required: ['pattern'],
    },
  },
]

const SKIPPED_DIRS = new Set(['.git', 'node_modules'])
const MAX_READ_BYTES = 256 * 1024
const MAX_LIST = 500
const MAX_MATCHES = 200
const MAX_SEARCH_FILE_BYTES = 1024 * 1024
const MAX_VISITED = 20_000

type Policy = Pick<
  ResidentExtensionConfig,
  'agent' | 'workspace' | 'protectedRoots'
>

function refusal(
  policy: Policy,
  toolName: 'read' | 'grep' | 'glob',
  path: string,
): string | undefined {
  const verdict = residentToolVerdict(
    { toolName, input: { path } },
    {
      v: 1,
      agent: policy.agent,
      workspace: policy.workspace,
      edits: 'none',
      protectedRoots: policy.protectedRoots,
      hostTools: [],
    },
    { agentKind: 'main' },
  )
  return verdict?.reason
}

function inside(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** Files under `start`, depth first, staying inside the real workspace. */
function* walk(start: string): Generator<string> {
  const stack = [start]
  let visited = 0
  while (stack.length > 0) {
    const dir = stack.pop()!
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    entries.sort((a, b) => b.name.localeCompare(a.name))
    for (const entry of entries) {
      if (++visited > MAX_VISITED) return
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name)) stack.push(path)
      } else if (entry.isFile()) yield path
      // Symlinks are never followed: a link out of the workspace stays out.
    }
  }
}

function readText(path: string, limit: number): string | undefined {
  const fd = openSync(path, 'r')
  try {
    if (!fstatSync(fd).isFile()) return undefined
    const buffer = Buffer.alloc(limit)
    const length = readSync(fd, buffer, 0, limit, 0)
    const slice = buffer.subarray(0, length)
    if (slice.includes(0)) return undefined // Binary.
    return slice.toString('utf8')
  } finally {
    closeSync(fd)
  }
}

export function runWorkspaceTool(
  policy: Policy,
  name: string,
  args: Record<string, unknown>,
): RuntimeToolResult | undefined {
  if (!WORKSPACE_TOOLS.some(tool => tool.name === name)) return undefined
  const workspace = realpathSync(policy.workspace)
  const raw =
    typeof args.path === 'string' && args.path !== '' ? args.path : '.'
  const toolName =
    name === 'qianmo_read_file'
      ? 'read'
      : name === 'qianmo_search'
        ? 'grep'
        : 'glob'
  const refused = refusal(policy, toolName, raw)
  if (refused !== undefined) return { ok: false, text: refused }
  const target = resolve(workspace, raw)
  let real: string
  try {
    real = realpathSync(target)
  } catch {
    return { ok: false, text: `${raw} does not exist` }
  }
  if (!inside(workspace, real))
    return { ok: false, text: `${raw} is outside this agent's workspace` }
  const shown = (path: string) => relative(workspace, path) || '.'

  if (name === 'qianmo_read_file') {
    if (!statSync(real).isFile())
      return { ok: false, text: `${raw} is not a file` }
    const text = readText(real, MAX_READ_BYTES)
    if (text === undefined)
      return { ok: false, text: `${raw} is binary; not shown` }
    const lines = text.split('\n')
    const offset =
      typeof args.offset === 'number' && args.offset >= 1 ? args.offset : 1
    const limit =
      typeof args.limit === 'number' && args.limit >= 1 ? args.limit : 2000
    const chosen = lines.slice(offset - 1, offset - 1 + limit)
    const body = chosen
      .map((line, index) => `${String(offset + index).padStart(6)}\t${line}`)
      .join('\n')
    const more =
      offset - 1 + limit < lines.length
        ? `\n… ${lines.length - (offset - 1 + limit)} more lines (use offset)`
        : ''
    return { ok: true, text: `${body}${more}` }
  }

  if (!statSync(real).isDirectory())
    return { ok: false, text: `${raw} is not a directory` }
  const glob =
    typeof (name === 'qianmo_search' ? args.glob : args.pattern) === 'string'
      ? new Bun.Glob(
          String(name === 'qianmo_search' ? args.glob : args.pattern),
        )
      : undefined
  const matchesGlob = (path: string) =>
    glob === undefined || glob.match(relative(real, path).split(sep).join('/'))

  if (name === 'qianmo_list_files') {
    const files: string[] = []
    for (const path of walk(real)) {
      if (!matchesGlob(path)) continue
      files.push(shown(path))
      if (files.length >= MAX_LIST) break
    }
    return {
      ok: true,
      text:
        files.length === 0
          ? '(no files)'
          : `${files.join('\n')}${files.length >= MAX_LIST ? `\n… stopped at ${MAX_LIST} files` : ''}`,
    }
  }

  let expression: RegExp
  try {
    expression = new RegExp(String(args.pattern))
  } catch (error) {
    return {
      ok: false,
      text: `invalid pattern: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
  const matches: string[] = []
  for (const path of walk(real)) {
    if (!matchesGlob(path)) continue
    if (refusal(policy, 'read', path) !== undefined) continue
    let text: string | undefined
    try {
      if (statSync(path).size > MAX_SEARCH_FILE_BYTES) continue
      text = readText(path, MAX_SEARCH_FILE_BYTES)
    } catch {
      continue
    }
    if (text === undefined) continue
    const lines = text.split('\n')
    for (let index = 0; index < lines.length; index++) {
      if (!expression.test(lines[index]!)) continue
      matches.push(
        `${shown(path)}:${index + 1}: ${lines[index]!.slice(0, 300)}`,
      )
      if (matches.length >= MAX_MATCHES) break
    }
    if (matches.length >= MAX_MATCHES) break
  }
  return {
    ok: true,
    text:
      matches.length === 0
        ? '(no matches)'
        : `${matches.join('\n')}${matches.length >= MAX_MATCHES ? `\n… stopped at ${MAX_MATCHES} matches` : ''}`,
  }
}
