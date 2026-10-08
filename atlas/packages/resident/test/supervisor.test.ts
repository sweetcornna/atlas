// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, mock, test } from 'bun:test'
import { ResidentSupervisor } from '../src/supervisor.js'

describe('resident ACP supervisor', () => {
  test('restarts a crashed child with exponential backoff', async () => {
    let startCount = 0
    const waits: number[] = []
    let stop!: () => void
    const supervisor = new ResidentSupervisor({
      start: async () => {
        startCount += 1
        if (startCount < 3) {
          return { closed: Promise.reject(new Error('crash')), stop: () => {} }
        }
        return {
          closed: new Promise<void>(resolve => {
            stop = resolve
          }),
          stop: () => stop(),
        }
      },
      initialBackoffMs: 10,
      maxBackoffMs: 40,
      now: () => 0,
      wait: async delay => {
        waits.push(delay)
      },
    })

    const running = supervisor.run()
    while (startCount < 3) await Promise.resolve()
    supervisor.stop()
    await running

    expect(waits).toEqual([10, 20])
    expect(supervisor.parked).toBe(false)
  })

  test('awaits crashed generation cleanup before restarting', async () => {
    const events: string[] = []
    let finishSecond!: () => void
    const supervisor = new ResidentSupervisor({
      start: async () => {
        const generation =
          events.filter(event => event.startsWith('start')).length + 1
        events.push(`start-${generation}`)
        if (generation === 1) {
          return {
            closed: Promise.reject(new Error('crash')),
            stop: async () => {
              events.push('stop-1-begin')
              await Promise.resolve()
              events.push('stop-1-end')
            },
          }
        }
        return {
          closed: new Promise<void>(resolve => {
            finishSecond = resolve
          }),
          stop: () => finishSecond(),
        }
      },
      wait: async () => {
        events.push('wait')
      },
      now: () => 0,
    })

    const running = supervisor.run()
    while (!events.includes('start-2')) await Promise.resolve()
    supervisor.stop()
    await running

    expect(events.slice(0, 5)).toEqual([
      'start-1',
      'stop-1-begin',
      'stop-1-end',
      'wait',
      'start-2',
    ])
  })

  describe('recycle (providers-console-m1 §2.7)', () => {
    /**
     * Children that stay up until stopped and then exit the way a real one does
     * on SIGTERM: `closed` rejects with a non-zero exit. `crash()` ends the
     * current one from the inside instead, the way a dying child does.
     */
    function generations(): {
      start: () => Promise<{ closed: Promise<void>; stop: () => void }>
      crash: () => void
      readonly started: number
      readonly stops: number
    } {
      let started = 0
      let stops = 0
      let exitCurrent: ((error: Error) => void) | undefined
      return {
        start: async () => {
          started += 1
          let exit!: (error: Error) => void
          const closed = new Promise<void>((_, reject) => {
            exit = reject
          })
          void closed.catch(() => {})
          exitCurrent = exit
          return {
            closed,
            stop: () => {
              stops += 1
              exit(
                new Error('resident ACP child exited code=null signal=SIGTERM'),
              )
            },
          }
        },
        crash: () => {
          exitCurrent?.(new Error('resident ACP child exited code=1'))
        },
        get started() {
          return started
        },
        get stops() {
          return stops
        },
      }
    }

    async function until(predicate: () => boolean): Promise<void> {
      for (let i = 0; i < 1_000 && !predicate(); i++) {
        await new Promise(resolve => setTimeout(resolve, 0))
      }
      expect(predicate()).toBe(true)
    }

    test('two recycles in a row never park, however short the generations', async () => {
      // maxRapidFailures 2 and a frozen clock: two *crashes* like these park
      // (the control below). Two recycles must not.
      const children = generations()
      const errors: unknown[] = []
      const onParked = mock((_failures: number) => {})
      const supervisor = new ResidentSupervisor({
        start: children.start,
        maxRapidFailures: 2,
        now: () => 0,
        wait: async () => {},
        onError: error => errors.push(error),
        onParked,
      })
      const running = supervisor.run()
      await until(() => children.started === 1)

      expect(supervisor.recycle()).toBe(true)
      await until(() => children.started === 2)
      expect(supervisor.recycle()).toBe(true)
      await until(() => children.started === 3)

      expect(supervisor.parked).toBe(false)
      expect(onParked).not.toHaveBeenCalled()
      // The SIGTERM exit of a recycled child is not reported as a fault.
      expect(errors).toEqual([])
      supervisor.stop()
      await running
    })

    test('control: the same two short generations ending on their own park', async () => {
      const children = generations()
      const errors: unknown[] = []
      const onParked = mock((_failures: number) => {})
      const supervisor = new ResidentSupervisor({
        start: children.start,
        maxRapidFailures: 2,
        now: () => 0,
        wait: async () => {},
        onError: error => errors.push(error),
        onParked,
      })
      const running = supervisor.run()
      await until(() => children.started === 1)
      children.crash()
      await until(() => children.started === 2)
      children.crash()
      await running

      expect(supervisor.parked).toBe(true)
      expect(onParked).toHaveBeenCalledWith(2)
      expect(errors.length).toBe(2)
    })

    test('a short recycle keeps the backoff ladder, a stable one resets it', async () => {
      let clock = 0
      const waits: number[] = []
      const children = generations()
      const supervisor = new ResidentSupervisor({
        start: children.start,
        initialBackoffMs: 10,
        maxBackoffMs: 1_000,
        stableAfterMs: 100,
        now: () => clock,
        wait: async delay => {
          waits.push(delay)
        },
      })
      const running = supervisor.run()
      await until(() => children.started === 1)
      clock += 50
      supervisor.recycle()
      await until(() => children.started === 2)
      clock += 50
      supervisor.recycle()
      await until(() => children.started === 3)
      clock += 500
      supervisor.recycle()
      await until(() => children.started === 4)
      supervisor.stop()
      await running

      expect(waits).toEqual([10, 20, 10])
    })

    test('recycle is refused when there is no generation to stop', async () => {
      const supervisor = new ResidentSupervisor({
        start: async () => {
          throw new Error('cannot start')
        },
        maxRapidFailures: 1,
        now: () => 0,
        wait: async () => {},
        onError: () => {},
      })
      expect(supervisor.recycle()).toBe(false)
      await supervisor.run()
      expect(supervisor.parked).toBe(true)
      expect(supervisor.recycle()).toBe(false)
    })
  })

  test('parks after repeated rapid failures', async () => {
    const onParked = mock((_failures: number) => {})
    const supervisor = new ResidentSupervisor({
      start: async () => {
        throw new Error('bad configuration')
      },
      maxRapidFailures: 3,
      now: () => 0,
      wait: async () => {},
      onParked,
    })

    await supervisor.run()

    expect(supervisor.parked).toBe(true)
    expect(onParked).toHaveBeenCalledWith(3)
  })
})
