// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { type TeammateMessage, getInboxPath } from '../src/index.js'

export function message(
  text: string,
  read: boolean,
  timestamp = new Date(0).toISOString(),
): TeammateMessage {
  return { from: 'team-lead', text, timestamp, read }
}

/** Point `QIANMO_CONFIG_DIR` at a fresh temp dir for each test. */
export function useTempConfigDir(): () => string {
  let dir = ''
  let previous: string | undefined
  beforeEach(() => {
    previous = process.env.QIANMO_CONFIG_DIR
    dir = mkdtempSync(join(tmpdir(), 'qianmo-mailbox-'))
    process.env.QIANMO_CONFIG_DIR = dir
  })
  afterEach(async () => {
    if (previous === undefined) delete process.env.QIANMO_CONFIG_DIR
    else process.env.QIANMO_CONFIG_DIR = previous
    await rm(dir, { recursive: true, force: true })
  })
  return () => dir
}

export async function seedRaw(
  agent: string,
  team: string,
  content: string,
): Promise<string> {
  const path = getInboxPath(agent, team)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content, 'utf-8')
  return path
}

export async function seed(
  agent: string,
  team: string,
  messages: TeammateMessage[],
): Promise<void> {
  await seedRaw(agent, team, JSON.stringify(messages, null, 2))
}

export async function readRaw(
  agent: string,
  team: string,
): Promise<TeammateMessage[]> {
  return JSON.parse(await readFile(getInboxPath(agent, team), 'utf-8'))
}
