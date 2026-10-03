// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Local commands in an ACP session (P18.20, design `providers-console-m1.md`
 * D-9): which ones a client is told about, and making a running session see a
 * settings change it did not make itself.
 *
 * ## What this module does NOT do: execute them
 *
 * An ACP turn already runs slash commands. `prompt` hands the text to
 * `QueryEngine.submitMessage`, whose `processUserInput` → `processSlashCommand`
 * executes any command in the session's command table — and an ACP session's
 * table is the unfiltered `getCommands(cwd)`. The process is non-interactive
 * (`isInteractive` is never set on the `--acp` fast path), so `/context`
 * resolves to its text-only `local` variant. A `local` command's output comes
 * back as a synthetic assistant message, which the bridge forwards as an
 * `agent_message_chunk`; the turn ends `end_turn` without a model request.
 * Measured on an unmodified `--acp` child (2026-10-03): `/autocompact 150k`
 * wrote `autoCompactWindow: 150000` and answered "Auto-compact window set to
 * 150k tokens" with zero model requests.
 *
 * A second recognizer in front of that path would run the same command code by
 * a different route, and every command outside the list below would still need
 * the old route — so there would be two. What was missing is narrower, and is
 * what this module supplies.
 *
 * ## 1. The commands a client is told about
 *
 * `available_commands_update` lists `prompt` commands only. A client that builds
 * its slash menu from that list never offers `/autocompact`, though typing it
 * works. {@link ACP_LOCAL_COMMANDS} is the set of `local` commands that are
 * meaningful in a session with no terminal; they are announced in the same
 * shape the base uses for `prompt` commands. Nothing else is announced, and
 * nothing about how any command runs changes.
 *
 * ## 2. A running session sees the current `autoCompactWindow`
 *
 * D-9 makes the window node-owned and settable four ways: `/autocompact` in this
 * session, the same in another session, `qm provider autocompact`, or editing
 * `settings.json`. Whichever wrote last must govern the next turn of every
 * running session. Two things stood in the way:
 *
 * - **A stale settings cache.** The base's settings change detector (chokidar
 *   watchers, started from `prefetch.tsx`) is never started on the `--acp` fast
 *   path. The merged-settings cache is dropped only when a session is created
 *   or this process writes a setting, so a write by another process was never
 *   seen by a session that was already running.
 * - **A pinned session value.** `/autocompact <value>` copies the result into
 *   the session's AppState with `autoCompactWindowOverride: true`, and from
 *   then on that session ignores the settings file.
 *
 * {@link refreshAcpTurnSettings} runs at the top of every turn and undoes both:
 * it drops the cache when a settings file changed on disk since a turn last
 * looked at it — the same thing the change detector does when it fires, found
 * with a few `stat` calls instead of watchers — and returns the session to
 * reading the window from settings. The second step loses nothing: in an ACP
 * session the only writer of the override is `/autocompact`, which wrote the
 * same value to `userSettings` in the same breath.
 */

import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { type Command, isCommandEnabled } from '../../../types/command.js'
import { SETTING_SOURCES } from '../../../utils/settings/constants.js'
import { getManagedSettingsDropInDir } from '../../../utils/settings/managedPath.js'
import { getSettingsFilePathForSource } from '../../../utils/settings/settings.js'
import { resetSettingsCache } from '../../../utils/settings/settingsCache.js'
import type { AcpSession } from './sessionTypes.js'

/**
 * `local` commands announced to ACP clients, in announcement order.
 *
 * A name belongs here when the command answers in text, needs no terminal, and
 * acts on this session or this node — not because it happens to declare
 * `supportsNonInteractive`.
 */
export const ACP_LOCAL_COMMANDS: readonly string[] = Object.freeze([
  'autocompact',
  'compact',
  'context',
])

/** One `available_commands_update` entry, in the base's own shape. */
export type AcpCommandEntry = {
  name: string
  description: string
  input: { hint: string } | undefined
}

/**
 * Whether `cmd` is one of {@link ACP_LOCAL_COMMANDS} and is usable here.
 *
 * Checked on the command object rather than the name alone, so that a name in
 * the list whose command is something else in this process — the interactive
 * `local-jsx` `/context`, a command turned off by `DISABLE_COMPACT`, a hidden
 * one — is not announced.
 */
export function isAcpLocalCommand(cmd: Command): boolean {
  return (
    cmd.type === 'local' &&
    cmd.supportsNonInteractive &&
    ACP_LOCAL_COMMANDS.includes(cmd.name) &&
    cmd.isHidden !== true &&
    cmd.userInvocable !== false &&
    isCommandEnabled(cmd)
  )
}

/**
 * The `available_commands_update` entries for this session's announced local
 * commands. Same mapping as the base's `prompt` entries: a command without an
 * `argumentHint` takes no input, so it gets none.
 */
export function acpLocalCommandEntries(
  commands: readonly Command[],
): AcpCommandEntry[] {
  return ACP_LOCAL_COMMANDS.flatMap(name => {
    const cmd = commands.find(c => c.name === name && isAcpLocalCommand(c))
    return cmd === undefined
      ? []
      : [
          {
            name: cmd.name,
            description: cmd.description,
            input: cmd.argumentHint ? { hint: cmd.argumentHint } : undefined,
          },
        ]
  })
}

/** What a settings file looks like now; `-` when it does not exist. */
function statToken(path: string): string {
  try {
    const stats = statSync(path)
    return `${stats.mtimeMs}:${stats.ctimeMs}:${stats.size}:${stats.ino}`
  } catch {
    return '-'
  }
}

/**
 * The files the base's settings change detector would watch (its
 * `getWatchTargets`), each with its {@link statToken}: every source's settings
 * file except `flagSettings`, the managed drop-in directory's listing, and each
 * JSON file in it. Project and local paths are the active session's.
 */
function settingsFileTokens(): Array<[key: string, token: string]> {
  const tokens: Array<[string, string]> = []
  for (const source of SETTING_SOURCES) {
    if (source === 'flagSettings') continue
    const path = getSettingsFilePathForSource(source)
    if (path !== undefined) tokens.push([path, statToken(path)])
  }
  const dropInDir = getManagedSettingsDropInDir()
  let dropIns: string[] | undefined
  try {
    dropIns = readdirSync(dropInDir)
      .filter(name => name.endsWith('.json'))
      .sort()
  } catch {
    // No drop-in directory: its listing token is `-`.
  }
  tokens.push([
    `drop-ins:${dropInDir}`,
    dropIns === undefined ? '-' : dropIns.join('/'),
  ])
  for (const name of dropIns ?? []) {
    const path = join(dropInDir, name)
    tokens.push([path, statToken(path)])
  }
  return tokens
}

/**
 * The token each settings file had when a turn last looked at it.
 * Process-wide, like the cache it guards.
 */
const seenSettingsFiles = new Map<string, string>()

/**
 * Whether a settings file changed on disk since a turn last looked at it.
 *
 * A path seen for the first time is not a change: that is a session in a
 * workspace no turn has run in yet, and treating the switch itself as a change
 * would make each turn re-read its own workspace's project settings — a
 * different behaviour for multi-workspace processes than the one they have,
 * and not what D-9 asks for. The very first turn in the process does start
 * from a fresh read, so a write made between `session/new` and that turn is
 * not lost.
 */
function settingsFilesChanged(): boolean {
  const firstTurn = seenSettingsFiles.size === 0
  let changed = false
  for (const [key, token] of settingsFileTokens()) {
    const previous = seenSettingsFiles.get(key)
    if (previous !== undefined && previous !== token) changed = true
    seenSettingsFiles.set(key, token)
  }
  return firstTurn || changed
}

/**
 * Make this turn read the current settings. Call after the session's workspace
 * is active (project settings resolve against its cwd) and before the turn is
 * submitted (the query engine copies the window out of AppState when it starts).
 */
export function refreshAcpTurnSettings(
  session: Pick<AcpSession, 'appState'>,
): void {
  if (settingsFilesChanged()) resetSettingsCache()
  const { appState } = session
  if (
    appState.autoCompactWindowOverride === true ||
    appState.autoCompactWindow !== undefined
  ) {
    // The same in-place write the session's own `setAppState` makes
    // (`createSessionMethod.ts`): the query engine holds this object.
    Object.assign(appState, {
      autoCompactWindow: undefined,
      autoCompactWindowOverride: false,
    })
  }
}
