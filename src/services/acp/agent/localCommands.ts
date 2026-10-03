// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Local commands in an ACP session (P18.20, design `providers-console-m1.md`
 * D-9): which ones a client is told about.
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
 */

import { type Command, isCommandEnabled } from '../../../types/command.js'

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
