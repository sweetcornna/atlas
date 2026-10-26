// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, expect, test } from 'bun:test'
import { join } from 'node:path'
import { WORK_SESSION_ID, workSessionDir, workSkillsDir } from '../src/index.ts'

const saved = process.env.QIANMO_CONFIG_DIR

afterEach(() => {
  if (saved === undefined) delete process.env.QIANMO_CONFIG_DIR
  else process.env.QIANMO_CONFIG_DIR = saved
})

test('a conversation work folder is three segments under the workspace', () => {
  const id = '6f1c2a4e-0d5b-4c7e-9a10-2b3c4d5e6f70'
  expect(workSessionDir(id)).toBe(`qmo-work/${id}`)
  expect(workSessionDir(id, 'outputs')).toBe(`qmo-work/${id}/outputs`)
  expect(workSessionDir(id, 'previews')).toBe(`qmo-work/${id}/previews`)
  expect(workSessionDir(id, 'sources')).toBe(`qmo-work/${id}/sources`)
})

test('ids that could leave the folder or alias another are refused', () => {
  for (const bad of ['', '..', '.', 'a/b', 'a\\b', '-x', 'x'.repeat(129), 'é'])
    expect(() => workSessionDir(bad)).toThrow()
  expect(WORK_SESSION_ID.test('channel_abc-1')).toBe(true)
})

test('the workflow skills live under the config root', () => {
  process.env.QIANMO_CONFIG_DIR = '/srv/node-a'
  expect(workSkillsDir()).toBe(join('/srv/node-a', 'qianmo', 'work-skills'))
})
