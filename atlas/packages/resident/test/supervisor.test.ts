// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, mock, test } from 'bun:test'
import { ResidentSupervisor } from '../src/supervisor.js'

describe('resident ACP supervisor', () => {
  test('actual RPC health overrides generation age and a healthy round resets rapid crashes before cleanup', async () => {
    let starts = 0
    let clock = 0
    const waits: number[] = []
    const supervisor = new ResidentSupervisor({
      start: async () => {
        const generation = ++starts
        let healthy = generation === 2
        if (generation > 4) supervisor.stop()
        return {
          closed: Promise.reject(new Error('RPC crash')),
          isStable: () => healthy,
          stop: () => {
            healthy = false
            clock += 30_000
          },
        }
      },
      now: () => {
        clock += 30_000
        return clock
      },
      initialBackoffMs: 10,
      maxRapidFailures: 2,
      wait: async delay => {
        waits.push(delay)
      },
    })
    await supervisor.run()
    expect(supervisor.parked).toBe(true)
    expect(starts).toBe(4)
    expect(waits).toEqual([10, 10, 20])
  })

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

  test('counts every slow start failure and parks with exponential backoff', async () => {
    let clock = 0
    let starts = 0
    const waits: number[] = []
    const errors: unknown[] = []
    const onParked = mock((_failures: number) => {})
    const supervisor = new ResidentSupervisor({
      start: async () => {
        // Bound the regression: the old loop would restart forever.
        if (++starts > 3) supervisor.stop()
        clock += 30_000
        throw new Error('omp RPC ready timed out')
      },
      stableAfterMs: 10_000,
      maxRapidFailures: 3,
      initialBackoffMs: 2_000,
      now: () => clock,
      wait: async delay => {
        waits.push(delay)
      },
      onError: error => errors.push(error),
      onParked,
    })

    await supervisor.run()

    expect(starts).toBe(3)
    expect(errors).toHaveLength(3)
    expect(waits).toEqual([2_000, 4_000])
    expect(supervisor.parked).toBe(true)
    expect(onParked).toHaveBeenCalledWith(3)
  })

  test('slow startup and cleanup do not make a short ready generation stable', async () => {
    let clock = 0
    let starts = 0
    const waits: number[] = []
    const onParked = mock((_failures: number) => {})
    const supervisor = new ResidentSupervisor({
      start: async () => {
        if (++starts > 2) {
          supervisor.stop()
          throw new Error('unexpected extra generation')
        }
        clock += 30_000
        return {
          closed: Promise.reject(new Error('crash immediately after ready')),
          stop: async () => {
            clock += 20_000
          },
        }
      },
      stableAfterMs: 10_000,
      maxRapidFailures: 2,
      initialBackoffMs: 10,
      now: () => clock,
      wait: async delay => {
        waits.push(delay)
      },
      onParked,
    })

    await supervisor.run()

    expect(starts).toBe(2)
    expect(waits).toEqual([10])
    expect(supervisor.parked).toBe(true)
    expect(onParked).toHaveBeenCalledWith(2)
  })

  test('a failed start after a ready generation keeps its failure count and cannot recycle the old child', async () => {
    const closed = Promise.withResolvers<void>()
    const ready = Promise.withResolvers<void>()
    const failure = new Error('next generation failed to start')
    const errors: unknown[] = []
    const waits: number[] = []
    const parked: number[] = []
    const stop = mock(() => {})
    let starts = 0
    const supervisor = new ResidentSupervisor({
      start: async () => {
        if (++starts === 1) return { closed: closed.promise, stop }
        expect(supervisor.recycle()).toBe(false)
        if (starts > 2) supervisor.stop()
        throw failure
      },
      now: () => {
        ready.resolve()
        return 0
      },
      initialBackoffMs: 10,
      maxRapidFailures: 2,
      wait: async delay => {
        waits.push(delay)
      },
      onError: error => errors.push(error),
      onParked: failures => parked.push(failures),
    })
    const running = supervisor.run()
    const crash = new Error('ready generation crashed')
    try {
      await ready.promise
      closed.reject(crash)
      await running

      expect(starts).toBe(2)
      expect(stop).toHaveBeenCalledTimes(1)
      expect(errors).toEqual([crash, failure])
      expect(waits).toEqual([10])
      expect(parked).toEqual([2])
      expect(supervisor.parked).toBe(true)
    } finally {
      closed.resolve()
      supervisor.stop()
      await running
    }
  })

  test('abort during backoff cancels the wait without restarting or parking', async () => {
    const waiting = Promise.withResolvers<AbortSignal>()
    const errors: unknown[] = []
    const waits: number[] = []
    const parked: number[] = []
    const failure = new Error('start failed')
    let starts = 0
    const supervisor = new ResidentSupervisor({
      start: async () => {
        starts++
        throw failure
      },
      initialBackoffMs: 10,
      maxRapidFailures: 2,
      wait: (delay, signal) => {
        waits.push(delay)
        const finished = Promise.withResolvers<void>()
        signal.addEventListener('abort', () => finished.reject(signal.reason), {
          once: true,
        })
        waiting.resolve(signal)
        return finished.promise
      },
      onError: error => errors.push(error),
      onParked: failures => parked.push(failures),
    })
    const running = supervisor.run()
    try {
      const signal = await waiting.promise
      supervisor.stop()
      await running

      expect(signal.aborted).toBe(true)
      expect(starts).toBe(1)
      expect(waits).toEqual([10])
      expect(errors).toEqual([failure])
      expect(parked).toEqual([])
      expect(supervisor.parked).toBe(false)
    } finally {
      supervisor.stop()
      await running
    }
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

    test('a short recycle with slow cleanup preserves failures and backoff from its first request', async () => {
      const closed = Promise.withResolvers<void>()
      const reaped = Promise.withResolvers<void>()
      const cleanupStarted = Promise.withResolvers<void>()
      const failures = [
        new Error('first start failed'),
        new Error('third start failed'),
      ]
      const errors: unknown[] = []
      const waits: number[] = []
      const parked: number[] = []
      let starts = 0
      let clock = 0
      const supervisor = new ResidentSupervisor({
        start: async () => {
          if (++starts === 2)
            return {
              closed: closed.promise,
              stop: () => {
                cleanupStarted.resolve()
                return reaped.promise
              },
            }
          if (starts > 3) supervisor.stop()
          throw failures[starts === 1 ? 0 : 1]
        },
        stableAfterMs: 100,
        maxRapidFailures: 2,
        initialBackoffMs: 10,
        now: () => clock,
        wait: async delay => {
          waits.push(delay)
        },
        onError: error => errors.push(error),
        onParked: count => parked.push(count),
      })
      const running = supervisor.run()
      try {
        await until(() => starts === 2)
        clock += 1
        expect(supervisor.recycle()).toBe(true)
        await cleanupStarted.promise
        clock += 200
        // A repeat request must not replace the original end of runtime.
        expect(supervisor.recycle()).toBe(true)
        closed.reject(new Error('planned SIGTERM exit'))
        await Promise.resolve()
        await Promise.resolve()
        expect(starts).toBe(2)
        expect(waits).toEqual([10])
        reaped.resolve()
        await running

        expect(starts).toBe(3)
        expect(waits).toEqual([10, 20])
        expect(errors).toEqual(failures)
        expect(parked).toEqual([2])
        expect(supervisor.parked).toBe(true)
      } finally {
        closed.resolve()
        reaped.resolve()
        supervisor.stop()
        await running
      }
    })

    test('abort during recycle cleanup waits for reaping without restarting or parking', async () => {
      const closed = Promise.withResolvers<void>()
      const reaped = Promise.withResolvers<void>()
      const cleanupStarted = Promise.withResolvers<void>()
      const errors: unknown[] = []
      const waits: number[] = []
      const parked: number[] = []
      let starts = 0
      let finished = false
      const supervisor = new ResidentSupervisor({
        start: async () => {
          starts++
          return {
            closed: closed.promise,
            stop: () => {
              cleanupStarted.resolve()
              return reaped.promise
            },
          }
        },
        maxRapidFailures: 1,
        now: () => 0,
        wait: async delay => {
          waits.push(delay)
        },
        onError: error => errors.push(error),
        onParked: failures => parked.push(failures),
      })
      const running = supervisor.run().then(() => {
        finished = true
      })
      try {
        await until(() => starts === 1)
        expect(supervisor.recycle()).toBe(true)
        await cleanupStarted.promise
        supervisor.stop()
        closed.reject(new Error('planned SIGTERM exit'))
        await Promise.resolve()
        await Promise.resolve()
        expect(finished).toBe(false)
        reaped.resolve()
        await running

        expect(starts).toBe(1)
        expect(waits).toEqual([])
        expect(errors).toEqual([])
        expect(parked).toEqual([])
        expect(supervisor.parked).toBe(false)
      } finally {
        closed.resolve()
        reaped.resolve()
        supervisor.stop()
        await running
      }
    })

    test('a stable ready generation resets previous failures and backoff', async () => {
      let clock = 0
      const waits: number[] = []
      const children = generations()
      const onParked = mock((_failures: number) => {})
      const supervisor = new ResidentSupervisor({
        start: children.start,
        initialBackoffMs: 10,
        stableAfterMs: 100,
        maxRapidFailures: 2,
        now: () => clock,
        wait: async delay => {
          waits.push(delay)
        },
        onParked,
      })
      const running = supervisor.run()
      try {
        await until(() => children.started === 1)
        children.crash()
        await until(() => children.started === 2)
        clock += 101
        children.crash()
        await until(() => children.started === 3)
        children.crash()
        await until(() => children.started === 4)
        children.crash()
        await running

        expect(children.started).toBe(4)
        expect(waits).toEqual([10, 10, 20])
        expect(supervisor.parked).toBe(true)
        expect(onParked).toHaveBeenCalledWith(2)
      } finally {
        supervisor.stop()
        await running
      }
    })

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
