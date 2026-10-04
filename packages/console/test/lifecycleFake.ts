// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * A registration ledger in memory that keeps the rules of the real one
 * (`src/cli/handlers/consoleRegistrations.ts`, `console.md` §7.3.1) closely
 * enough for the node pages to be driven through it: publish and resume only
 * for what the managed list holds, retired is for good, pause and retire take
 * what the ledger or the list knows, a ledger that cannot be read takes
 * nothing and one that cannot be saved still takes pause and retire. It
 * changes state, so a page read after a
 * write shows the write — which is what the browser suite waits for.
 *
 * And the scene the node-page suites share: tokyo-1 with five addresses in
 * five different positions, plus kyoto-1, a node only the ledger knows.
 */

import type {
  LifecycleChange,
  LifecycleOutcome,
  LifecyclePort,
  LifecycleSnapshot,
  PublishInput,
  RegistrationRecord,
  RegistrationState,
} from '../src/deps.js'

export const PLANNER = 'qianmo://tokyo-1/planner'
export const REVIEWER = 'qianmo://tokyo-1/reviewer'
export const SCOUT = 'qianmo://tokyo-1/scout'
export const SLEEPER = 'qianmo://tokyo-1/sleeper'
export const OLD = 'qianmo://tokyo-1/old'
export const KYOTO = 'qianmo://kyoto-1/archivist'
export const OPS_SUBJECT = 'u:0123456789abcdef'

export class StatefulLifecycle implements LifecyclePort {
  readonly calls: string[] = []
  reads = 0
  problem: string | null = null
  /** Which kind `problem` is; the real one says, `deps.ts` explains both. */
  problemKind: 'unreadable' | 'unwritable' = 'unreadable'
  managed: string[] | null = [PLANNER, REVIEWER, SCOUT, SLEEPER]
  readonly records = new Map<string, RegistrationRecord>([
    [PLANNER, { address: PLANNER, state: 'active', by: OPS_SUBJECT, at: 1 }],
    [SLEEPER, { address: SLEEPER, state: 'paused', by: OPS_SUBJECT, at: 2 }],
    [OLD, { address: OLD, state: 'retired', by: 'legacy:admin', at: 3 }],
    [KYOTO, { address: KYOTO, state: 'paused', by: OPS_SUBJECT, at: 4 }],
  ])
  #clock = 10

  read(): Promise<LifecycleSnapshot> {
    this.reads += 1
    const managed = this.managed
    return Promise.resolve({
      problem: this.problem,
      ...(this.problem === null ? {} : { problemKind: this.problemKind }),
      managed: managed === null ? null : [...managed].sort(),
      registrations: [...this.records.values()]
        .map(record =>
          managed === null
            ? record
            : { ...record, managed: managed.includes(record.address) },
        )
        .sort((a, b) => (a.address < b.address ? -1 : 1)),
    })
  }

  #set(
    address: string,
    state: RegistrationState,
    by: string,
  ): LifecycleOutcome<LifecycleChange> {
    this.#clock += 1
    const record: RegistrationRecord = { address, state, by, at: this.#clock }
    this.records.set(address, record)
    return { ok: true, value: { registration: record } }
  }

  #refuse(
    code: 'unavailable' | 'unmanaged' | 'retired' | 'paused' | 'not_found',
    message: string,
  ): Promise<LifecycleOutcome<LifecycleChange>> {
    return Promise.resolve({ ok: false, refusal: { code, message } })
  }

  publish(
    input: PublishInput,
    by: string,
  ): Promise<LifecycleOutcome<LifecycleChange>> {
    this.calls.push(`publish ${input.address} ${by}`)
    if (this.problem !== null) return this.#refuse('unavailable', this.problem)
    const held = this.records.get(input.address)
    if (held?.state === 'retired') return this.#refuse('retired', '已退役')
    if (held?.state === 'paused') return this.#refuse('paused', '已暂停')
    if (this.managed !== null && !this.managed.includes(input.address)) {
      return this.#refuse('unmanaged', '不在托管清单里')
    }
    return Promise.resolve(this.#set(input.address, 'active', by))
  }

  pause(address: string, by: string) {
    this.calls.push(`pause ${address} ${by}`)
    return this.#withdraw(address, 'paused', by)
  }

  retire(address: string, by: string) {
    this.calls.push(`retire ${address} ${by}`)
    return this.#withdraw(address, 'retired', by)
  }

  resume(
    address: string,
    by: string,
  ): Promise<LifecycleOutcome<LifecycleChange>> {
    this.calls.push(`resume ${address} ${by}`)
    if (this.problem !== null) return this.#refuse('unavailable', this.problem)
    const held = this.records.get(address)
    if (held === undefined) return this.#refuse('not_found', '不在登记簿里')
    if (held.state === 'retired') return this.#refuse('retired', '已退役')
    if (this.managed !== null && !this.managed.includes(address)) {
      return this.#refuse('unmanaged', '不在托管清单里')
    }
    return Promise.resolve(this.#set(address, 'active', by))
  }

  #withdraw(
    address: string,
    state: 'paused' | 'retired',
    by: string,
  ): Promise<LifecycleOutcome<LifecycleChange>> {
    // Narrowing is still taken while the ledger only cannot be saved.
    if (this.problem !== null && this.problemKind === 'unreadable') {
      return this.#refuse('unavailable', this.problem)
    }
    const held = this.records.get(address)
    if (held?.state === 'retired' && state === 'paused') {
      return this.#refuse('retired', '已退役')
    }
    if (held === undefined && !(this.managed ?? []).includes(address)) {
      return this.#refuse('not_found', '不在登记簿里也不在托管清单里')
    }
    return Promise.resolve(this.#set(address, state, by))
  }
}
