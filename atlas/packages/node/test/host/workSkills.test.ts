// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * P37.17 B — the six workflow skills (`docs/dev/work-tasks.md` §2.4): what
 * `qm` carries is every file of `atlas/plugins/qmo-work`, each skill names
 * itself in its frontmatter and carries the AGPL header, the layout writes
 * them privately and leaves an unchanged file alone, and every qianmopi
 * child gets the folder as a plugin dir and a readable root.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { WORKFLOWS } from '@qianmo/console'
import {
  layOutWorkSkills,
  WORK_SKILL_FILES,
  withWorkSkills,
} from '../../src/host/workSkills.js'

const PLUGIN = path.resolve(import.meta.dir, '../../../../plugins/qmo-work')

function filesUnder(root: string, prefix = ''): string[] {
  return fs
    .readdirSync(path.join(root, prefix), { withFileTypes: true })
    .flatMap(entry => {
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      return entry.isDirectory() ? filesUnder(root, relative) : [relative]
    })
    .sort()
}

let root: string
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'qm-work-skills-'))
})
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('the shipped skills', () => {
  test('qm carries every file of the plugin, byte for byte', () => {
    expect(Object.keys(WORK_SKILL_FILES).sort()).toEqual(filesUnder(PLUGIN))
    for (const [relative, text] of Object.entries(WORK_SKILL_FILES)) {
      if (relative === 'plugin.json')
        expect(JSON.parse(text)).toEqual(
          JSON.parse(fs.readFileSync(path.join(PLUGIN, relative), 'utf8')),
        )
      else
        expect(text).toBe(fs.readFileSync(path.join(PLUGIN, relative), 'utf8'))
    }
  })

  test('one skill per workflow, named in its frontmatter, AGPL', () => {
    for (const workflow of WORKFLOWS) {
      const text = WORK_SKILL_FILES[`skills/${workflow.skill}/SKILL.md`]
      expect(text).toBeDefined()
      const front = /^---\n([\s\S]*?)\n---\n/.exec(text!)
      expect(front).not.toBeNull()
      const meta = JSON.parse(front![1]!) as {
        name: string
        description: string
      }
      expect(meta.name).toBe(workflow.skill)
      expect(meta.description.length).toBeGreaterThan(20)
      expect(text).toContain('SPDX-License-Identifier: AGPL-3.0-or-later')
    }
    expect(
      Object.keys(WORK_SKILL_FILES).filter(name => name.endsWith('SKILL.md')),
    ).toHaveLength(WORKFLOWS.length)
  })
})

describe('layOutWorkSkills', () => {
  test('writes every file privately and leaves an unchanged one alone', () => {
    const folder = path.join(root, 'work-skills')
    expect(layOutWorkSkills(folder)).toBe(folder)
    expect(filesUnder(folder)).toEqual(Object.keys(WORK_SKILL_FILES).sort())
    const slides = path.join(folder, 'skills/qmo-slides/SKILL.md')
    expect(fs.statSync(slides).mode & 0o077).toBe(0)
    const before = fs.statSync(slides).mtimeMs
    const stale = path.join(folder, 'skills/qmo-sheet/SKILL.md')
    fs.writeFileSync(stale, 'edited by hand')
    Bun.sleepSync(20)
    layOutWorkSkills(folder)
    expect(fs.statSync(slides).mtimeMs).toBe(before)
    expect(fs.readFileSync(stale, 'utf8')).toBe(
      WORK_SKILL_FILES['skills/qmo-sheet/SKILL.md'],
    )
  })
})

describe('withWorkSkills', () => {
  test('the folder goes first among plugin dirs and readable roots', () => {
    const set = {
      ompPluginDirs: ['/ops/plugins'],
      claudePluginDirs: ['/ops/claude'],
      mcp: [],
      readableRoots: ['/ops/plugins'],
    }
    const source = withWorkSkills(() => set, '/node/work-skills')
    expect(source('writer')).toEqual({
      ompPluginDirs: ['/node/work-skills', '/ops/plugins'],
      claudePluginDirs: ['/ops/claude'],
      mcp: [],
      readableRoots: ['/node/work-skills', '/ops/plugins'],
    })
  })

  test('an agent with no operator extensions still gets the skills', () => {
    const source = withWorkSkills(() => null, '/node/work-skills')
    expect(source('writer')).toEqual({
      ompPluginDirs: ['/node/work-skills'],
      claudePluginDirs: [],
      mcp: [],
      readableRoots: ['/node/work-skills'],
    })
  })
})
