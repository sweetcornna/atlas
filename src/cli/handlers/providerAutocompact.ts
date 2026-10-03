// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `qm provider autocompact [auto|<tokens>] [--json]` — the node CLI entry of
 * D-9 (design `providers-console-m1.md` §0.1): show or set this node's
 * auto-compact window.
 *
 * It is the base `/autocompact` command, not a second one: parsing, the
 * refusal while `CLAUDE_CODE_AUTO_COMPACT_WINDOW` is set, the write to
 * `userSettings.autoCompactWindow` and the reply text all come from
 * `applyAutoCompactWindow`; the status panel is `formatAutoCompactWindowStatus`.
 * `userSettings` is `settings.json` under this process's config root, so
 * `OCC_CONFIG_DIR` picks the node.
 *
 * The value belongs to the node (D-9): it is not in any profile, not a managed
 * key, and an `apply` neither writes nor compares it.
 *
 * The model whose window caps the value is the one the node's ACP child would
 * run: this process drops every provider-shaped key from its own environment
 * and replays the child's settings start-up (`computeEffectiveProviderState`),
 * the same way `status` computes `effective` in a stripped child — so the two
 * report the same window. Call it only in a process of its own.
 */

import {
  applyAutoCompactWindow,
  formatAutoCompactWindowStatus,
} from '../../commands/autocompact/autocompact.js'
import { isAutoCompactEnabled } from '../../services/compact/autoCompact.js'
import {
  type ResolvedAutoCompactWindow,
  resolveActiveAutoCompactWindow,
} from '../../services/compact/autoCompactWindow.js'
import {
  autoCompactSourceOf,
  computeEffectiveProviderState,
} from '../../services/qianmo/providers/effective.js'
import { inheritedProviderKeyNames } from '../../services/qianmo/providers/whitelist.js'
import { getMainLoopModelSettingsSlot } from '../../utils/model/model.js'

type AutocompactArgs = { value: string | undefined; json: boolean }

/** `[value] [--json]`; anything else is a usage error (thrown). */
export function parseAutocompactArgs(args: readonly string[]): AutocompactArgs {
  let value: string | undefined
  let json = false
  for (const arg of args) {
    if (arg === '--json') {
      json = true
    } else if (arg.startsWith('-')) {
      throw new Error(`unknown option ${arg}`)
    } else if (value === undefined) {
      value = arg
    } else {
      throw new Error('autocompact takes one value: auto or a token count')
    }
  }
  return { value, json }
}

/** Why a value was not written (`--json` `code`). */
type RefusalCode = 'bad-value' | 'env-override' | 'write-failed'

type Window = {
  /** In effect: `min(model window, configured)`. */
  autoCompactWindow: number
  /** What the winning source asked for, before the model cap. */
  configured: number
  source: 'env' | 'settings' | 'auto'
}

function windowOf(resolved: ResolvedAutoCompactWindow): Window {
  return {
    autoCompactWindow: resolved.window,
    configured: resolved.configured,
    source: autoCompactSourceOf(resolved.source),
  }
}

type AutocompactRun = {
  exitCode: 0 | 1
  stdout: string
  stderr: string
}

/**
 * Show (no value) or set the window. `exitCode` 1 when the value was refused:
 * unparseable, `CLAUDE_CODE_AUTO_COMPACT_WINDOW` set, or the write failed.
 */
export function runAutocompact({
  value,
  json,
}: AutocompactArgs): AutocompactRun {
  for (const key of inheritedProviderKeyNames(process.env)) {
    delete process.env[key]
  }
  const { model, contextTokens } = computeEffectiveProviderState()
  const slot = getMainLoopModelSettingsSlot(model)
  const before = resolveActiveAutoCompactWindow(contextTokens)

  if (value === undefined) {
    return {
      exitCode: 0,
      stdout: json
        ? `${JSON.stringify({ ok: true, ...windowOf(before) })}\n`
        : `${formatAutoCompactWindowStatus(before, isAutoCompactEnabled())}\n`,
      stderr: '',
    }
  }

  let written = false
  const message = applyAutoCompactWindow(value, model, slot, () => {
    written = true
  })
  const after = windowOf(resolveActiveAutoCompactWindow(contextTokens))
  if (written) {
    return {
      exitCode: 0,
      stdout: json
        ? `${JSON.stringify({ ok: true, ...after, message })}\n`
        : `${message}\n`,
      stderr: '',
    }
  }
  // `applyAutoCompactWindow` reports a refusal as text only; which one it was
  // is read from the state it checked, and from its own wording for the one
  // failure that leaves no state behind.
  const code: RefusalCode =
    before.source === 'env'
      ? 'env-override'
      : message.startsWith("Couldn't save setting")
        ? 'write-failed'
        : 'bad-value'
  return json
    ? {
        exitCode: 1,
        stdout: `${JSON.stringify({ ok: false, code, message, ...after })}\n`,
        stderr: '',
      }
    : { exitCode: 1, stdout: '', stderr: `${message}\n` }
}
