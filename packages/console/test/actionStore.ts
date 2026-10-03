// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The action ledger's file in memory: the account suites' `MemoryLedger` plus
 * the stamp the hash-chained ledger compares (`actionLedger.ts`,
 * `ActionLedgerStore`).
 *
 * The stamp is the text itself behind a generation counter, so any change to
 * the content moves it, and {@link MemoryActionStore.touch} moves it without
 * changing a byte — what `touch(1)` or a backup tool restoring mtimes does to
 * the real file.
 */

import type { ActionLedgerStore } from '../src/actionLedger.js'
import { MemoryLedger } from './accountsHarness.js'

export class MemoryActionStore
  extends MemoryLedger
  implements ActionLedgerStore
{
  #generation = 0

  constructor(text: string | null = null) {
    super('memory://actions.ndjson', text)
  }

  stamp(): string | null {
    return this.text === null ? null : `${this.#generation}:${this.text}`
  }

  /** Move the stamp without changing the content. */
  touch(): void {
    this.#generation += 1
  }

  /** The text's lines, unparsed. */
  rawLines(): string[] {
    return (this.text ?? '').split('\n').filter(line => line !== '')
  }
}
