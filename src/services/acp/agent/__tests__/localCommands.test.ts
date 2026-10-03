// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

// P18.20 (D-9): which local commands an ACP session announces.
//
// No mock.module: the command objects are the real ones.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import autocompact from '../../../../commands/autocompact/index.js'
import compact from '../../../../commands/compact/index.js'
import {
  context,
  contextNonInteractive,
} from '../../../../commands/context/index.js'
import init from '../../../../commands/init.js'
import version from '../../../../commands/version.js'
import type { Command } from '../../../../types/command.js'
import {
  ACP_LOCAL_COMMANDS,
  acpLocalCommandEntries,
  isAcpLocalCommand,
} from '../localCommands.js'

/** What an ACP session's command table holds for these names in this process. */
const SESSION_COMMANDS: Command[] = [
  init,
  autocompact,
  compact,
  context,
  contextNonInteractive,
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
        description: contextNonInteractive.description,
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
