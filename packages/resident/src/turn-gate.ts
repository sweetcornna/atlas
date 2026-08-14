// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: MIT

export class NodeTurnGate {
  #tail: Promise<void> = Promise.resolve()
  #active = false
  #queued = 0

  get active(): boolean {
    return this.#active
  }

  get queued(): number {
    return this.#queued
  }

  run<T>(work: () => Promise<T>): Promise<T> {
    this.#queued += 1
    const result = this.#tail.then(async () => {
      this.#queued -= 1
      if (this.#active) throw new Error('node turn gate overlap')
      this.#active = true
      try {
        return await work()
      } finally {
        this.#active = false
      }
    })
    this.#tail = result.then(
      () => {},
      () => {},
    )
    return result
  }
}
