// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The file format from `mapping.ts` §2: one Markdown file per entry, the three
 * `name` / `description` / `type` keys first, then the `qm_*` keys.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  BASE_MEMORY_TYPE_BY_LAYER,
  MemoryParseError,
  parseEntry,
  serializeEntry,
} from '../src/index.js'
import { createSandbox, type Sandbox } from './helpers.js'

let sandbox: Sandbox

beforeEach(() => {
  sandbox = createSandbox()
})

afterEach(() => {
  sandbox.dispose()
})

const AWKWARD_TITLE = 'Bun: 运行时 & 测试器 — "不引入 npm"'
const AWKWARD_BODY = '---\nnot a fence\n\n- item: value # not a comment\n'

describe('serialize / parse', () => {
  test('round-trips values that would break a naive YAML emitter', () => {
    const written = sandbox.store.write({
      scope: { layer: 'working', projectKey: 'atlas', taskId: 't1' },
      title: AWKWARD_TITLE,
      summary: 'colons: everywhere, and a [bracket]',
      body: AWKWARD_BODY,
      source: { kind: 'session', id: 'sess-1' },
      tags: ['a.b', 'c:d'],
    })
    const path = join(
      sandbox.root,
      'working',
      'atlas',
      't1',
      `${written.id}.md`,
    )
    expect(parseEntry(readFileSync(path, 'utf8'))).toEqual(written)
    expect(parseEntry(serializeEntry(written))).toEqual(written)
  })

  test('a file with a tombstone but no reason is rejected, not half-read', () => {
    const entry = sandbox.store.write({
      scope: { layer: 'project', projectKey: 'atlas' },
      title: 't',
      summary: 's',
      body: '',
      source: { kind: 'user', id: 'u' },
    })
    const tampered = serializeEntry(entry).replace(
      'qm_expired_at: null',
      'qm_expired_at: "2026-09-21T00:00:00.000Z"',
    )
    expect(() => parseEntry(tampered)).toThrow(MemoryParseError)
  })
})

describe('on-disk frontmatter layout', () => {
  test('starts with name / description / type, then the qm_* keys', () => {
    const entry = sandbox.store.write({
      scope: { layer: 'project', projectKey: 'atlas' },
      title: AWKWARD_TITLE,
      summary: 'This project standardises on Bun.',
      body: AWKWARD_BODY,
      source: { kind: 'session', id: 'sess-1' },
    })
    const path = join(sandbox.root, 'project', 'atlas', `${entry.id}.md`)
    const lines = readFileSync(path, 'utf8').split('\n')

    expect(BASE_MEMORY_TYPE_BY_LAYER.project).toBe('project')
    expect(lines.slice(0, 5)).toEqual([
      '---',
      `name: ${JSON.stringify(AWKWARD_TITLE)}`,
      'description: "This project standardises on Bun."',
      'type: "project"',
      `qm_id: ${JSON.stringify(entry.id)}`,
    ])
  })

  test('layers with no type counterpart omit `type:`', () => {
    const entry = sandbox.store.write({
      scope: { layer: 'baseline', period: '2026-09' },
      title: 'September baseline',
      summary: 'Median 3.1M tokens/day.',
      body: '',
      source: { kind: 'import', id: 'usage-export' },
    })
    const path = join(sandbox.root, 'baseline', '2026-09', `${entry.id}.md`)
    expect(BASE_MEMORY_TYPE_BY_LAYER.baseline).toBeNull()
    expect(BASE_MEMORY_TYPE_BY_LAYER.working).toBeNull()
    expect(readFileSync(path, 'utf8')).not.toMatch(/^type:/m)
  })
})
