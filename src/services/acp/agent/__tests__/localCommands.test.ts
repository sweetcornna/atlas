// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

// P18.20 (D-9): which local commands an ACP session announces, and the
// per-turn settings refresh. The end-to-end half — a real `--acp` child, a
// recording model double, compaction actually firing — is
// tests/integration/qianmo-acp-local-commands.test.ts.
//
// No mock.module: the command objects are the real ones and the settings layer
// reads a real file under a temp CLAUDE_CONFIG_DIR.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  resetStateForTests,
  setOriginalCwd,
} from '../../../../bootstrap/state.js'
import autocompact from '../../../../commands/autocompact/index.js'
import compact from '../../../../commands/compact/index.js'
import {
  context,
  contextNonInteractive,
} from '../../../../commands/context/index.js'
import init from '../../../../commands/init.js'
import version from '../../../../commands/version.js'
import { resolveActiveAutoCompactWindow } from '../../../compact/autoCompactWindow.js'
import type { AppState } from '../../../../state/AppStateStore.js'
import type { Command } from '../../../../types/command.js'
import {
  getInitialSettings,
  getSettingsFilePathForSource,
} from '../../../../utils/settings/settings.js'
import {
  getSessionSettingsCache,
  resetSettingsCache,
  setSessionSettingsCache,
} from '../../../../utils/settings/settingsCache.js'
import {
  ACP_LOCAL_COMMANDS,
  acpLocalCommandEntries,
  isAcpLocalCommand,
  refreshAcpTurnSettings,
} from '../localCommands.js'

/**
 * The non-interactive `/context` as an `--acp` process sees it. The real
 * object's `isEnabled` / `isHidden` read the process's interactivity, which an
 * earlier file in the same `bun test` process may have pinned to "interactive"
 * (`tests/mocks/state.ts` has no teardown); the real reading in a real child is
 * covered by tests/integration/qianmo-acp-local-commands.test.ts.
 */
const contextInAcp: Command = {
  ...contextNonInteractive,
  isEnabled: () => true,
  isHidden: false,
}

/** What an ACP session's command table holds for these names. */
const SESSION_COMMANDS: Command[] = [
  init,
  autocompact,
  compact,
  context,
  contextInAcp,
  version,
]

describe('acpLocalCommandEntries', () => {
  let savedDisableCompact: string | undefined

  beforeEach(() => {
    savedDisableCompact = process.env.DISABLE_COMPACT
    delete process.env.DISABLE_COMPACT
  })

  afterEach(() => {
    if (savedDisableCompact === undefined) delete process.env.DISABLE_COMPACT
    else process.env.DISABLE_COMPACT = savedDisableCompact
  })

  test('announces exactly the three commands, in the base prompt-entry shape', () => {
    expect(ACP_LOCAL_COMMANDS).toEqual(['autocompact', 'compact', 'context'])
    expect(acpLocalCommandEntries(SESSION_COMMANDS)).toEqual([
      {
        name: 'autocompact',
        description: autocompact.description,
        input: { hint: autocompact.argumentHint as string },
      },
      {
        name: 'compact',
        description: compact.description,
        input: { hint: compact.argumentHint as string },
      },
      // Takes no argument and the base command declares no hint, so no input.
      {
        name: 'context',
        description: contextInAcp.description,
        input: undefined,
      },
    ])
  })

  test('the interactive /context, a prompt command and an unlisted local command are not local entries', () => {
    expect(isAcpLocalCommand(context)).toBe(false)
    expect(isAcpLocalCommand(init)).toBe(false)
    expect(isAcpLocalCommand(version)).toBe(false)
    expect(acpLocalCommandEntries([init, context, version])).toEqual([])
  })

  test('a listed command that is turned off is not announced', () => {
    process.env.DISABLE_COMPACT = '1'
    expect(
      acpLocalCommandEntries(SESSION_COMMANDS).map(entry => entry.name),
    ).toEqual(['context'])
  })
})

describe('refreshAcpTurnSettings', () => {
  let configDir: string
  let settingsPath: string
  let savedConfigDir: string | undefined

  /** Write the user settings file as another process would, at a later time. */
  function writeWindowLater(value: number, secondsLater: number): void {
    writeFileSync(
      settingsPath,
      `${JSON.stringify({ autoCompactWindow: value })}\n`,
    )
    // The two writes in a test land in the same filesystem tick and are the
    // same size; a real second write is seconds or more after the first.
    const at = new Date(statSync(settingsPath).mtimeMs + secondsLater * 1000)
    utimesSync(settingsPath, at, at)
  }

  /** What `autoCompactIfNeeded` resolves from a session's AppState. */
  function windowFor(
    appState: AppState,
  ): ReturnType<typeof resolveActiveAutoCompactWindow> {
    return resolveActiveAutoCompactWindow(1_000_000, {
      autoCompactWindow: appState.autoCompactWindow,
      autoCompactWindowOverride: appState.autoCompactWindowOverride,
    })
  }

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), 'occ-acp-local-commands-'))
    settingsPath = join(configDir, 'settings.json')
    savedConfigDir = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = configDir
    resetSettingsCache()
    writeWindowLater(150_000, 0)
  })

  afterEach(() => {
    if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = savedConfigDir
    // setOriginalCwd() below moves process-global state into a directory
    // deleted here; put it back for the rest of the shard.
    resetStateForTests()
    resetSettingsCache()
    rmSync(configDir, { recursive: true, force: true })
  })

  test('a write by someone else reaches the next turn; without the refresh it does not', () => {
    const appState = {
      autoCompactWindow: undefined,
      autoCompactWindowOverride: false,
    } as unknown as AppState

    refreshAcpTurnSettings({ appState })
    expect(windowFor(appState)).toEqual({
      window: 150_000,
      configured: 150_000,
      source: 'settings',
    })

    writeWindowLater(300_000, 5)
    // The cache still holds the first read: this is what a running ACP
    // session saw before P18.20.
    expect(getInitialSettings().autoCompactWindow).toBe(150_000)

    refreshAcpTurnSettings({ appState })
    expect(windowFor(appState).window).toBe(300_000)
  })

  test('a session pinned by its own /autocompact follows a later write', () => {
    // `/autocompact 150k` leaves exactly this behind (autocompact.ts onApplied).
    const appState = {
      autoCompactWindow: 150_000,
      autoCompactWindowOverride: true,
    } as unknown as AppState
    refreshAcpTurnSettings({ appState })
    writeWindowLater(100_000, 5)

    refreshAcpTurnSettings({ appState })
    expect(appState.autoCompactWindowOverride).toBe(false)
    expect(appState.autoCompactWindow).toBeUndefined()
    expect(windowFor(appState)).toEqual({
      window: 100_000,
      configured: 100_000,
      source: 'settings',
    })
  })

  test('unchanged files keep the cache: no re-read on an ordinary turn', () => {
    const appState = {
      autoCompactWindow: undefined,
      autoCompactWindowOverride: false,
    } as unknown as AppState
    refreshAcpTurnSettings({ appState })
    getInitialSettings()
    const cached = getSessionSettingsCache()
    expect(cached).not.toBeNull()

    refreshAcpTurnSettings({ appState })
    expect(getSessionSettingsCache()).toBe(cached)

    // A sentinel proves identity rather than equal contents.
    const sentinel = { settings: {}, errors: [] }
    setSessionSettingsCache(sentinel)
    refreshAcpTurnSettings({ appState })
    expect(getSessionSettingsCache()).toBe(sentinel)
  })

  test('switching to a session in another workspace is not by itself a change', () => {
    const appState = {
      autoCompactWindow: undefined,
      autoCompactWindowOverride: false,
    } as unknown as AppState
    const workspaceA = realpathSync(mkdtempSync(join(configDir, 'a-')))
    const workspaceB = realpathSync(mkdtempSync(join(configDir, 'b-')))

    setOriginalCwd(workspaceA)
    refreshAcpTurnSettings({ appState })
    const sentinel = { settings: {}, errors: [] }
    setSessionSettingsCache(sentinel)

    setOriginalCwd(workspaceB)
    refreshAcpTurnSettings({ appState })
    setOriginalCwd(workspaceA)
    refreshAcpTurnSettings({ appState })
    expect(getSessionSettingsCache()).toBe(sentinel)

    // A project settings file appearing in the active workspace is a change.
    const projectSettings = getSettingsFilePathForSource('projectSettings')
    if (projectSettings === undefined) throw new Error('no project path')
    expect(projectSettings.startsWith(workspaceA)).toBe(true)
    mkdirSync(dirname(projectSettings), { recursive: true })
    writeFileSync(projectSettings, '{"autoCompactWindow": 120000}\n')
    refreshAcpTurnSettings({ appState })
    expect(getSessionSettingsCache()).toBeNull()
    expect(windowFor(appState).window).toBe(120_000)
  })
})
