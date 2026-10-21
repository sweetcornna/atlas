// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from 'bun:test'
import { LIMITS } from '@qianmo/protocol'
import {
  NodeTurnExpiredError,
  NodeTurnGate,
  NodeTurnQueueFullError,
} from '../src/turn-gate.js'

describe('node turn gate', () => {
  test('serializes turns across different sessions in arrival order', async () => {
    const gate = new NodeTurnGate()
    const events: string[] = []
    let releaseFirst!: () => void

    const first = gate.run(async () => {
      events.push('a:start')
      await new Promise<void>(resolve => {
        releaseFirst = resolve
      })
      events.push('a:end')
    })
    const second = gate.run(async () => {
      events.push('b:start')
      events.push('b:end')
    })

    await Promise.resolve()
    expect(events).toEqual(['a:start'])
    expect(gate.active).toBe(true)
    expect(gate.queued).toBe(1)

    releaseFirst()
    await Promise.all([first, second])
    expect(events).toEqual(['a:start', 'a:end', 'b:start', 'b:end'])
    expect(gate.active).toBe(false)
  })

  test('a freed gate takes interactive turns before background ones, and never preempts', async () => {
    const gate = new NodeTurnGate()
    const events: string[] = []
    let releaseFirst!: () => void
    const held = new Promise<void>(resolve => {
      releaseFirst = resolve
    })
    // A background turn is running; a person's message arrives behind two
    // more background turns.
    const running = gate.run(
      async () => {
        events.push('bg-1:start')
        await held
        events.push('bg-1:end')
      },
      { background: true },
    )
    const queued = [
      gate.run(async () => events.push('bg-2'), { background: true }),
      gate.run(async () => events.push('bg-3'), { background: true }),
      gate.run(async () => events.push('person')),
    ]
    await Promise.resolve()
    expect(events).toEqual(['bg-1:start'])
    expect(gate.queued).toBe(3)
    releaseFirst()
    await Promise.all([running, ...queued])
    // The running turn finished first; then the person; then the background
    // turns in their own arrival order.
    expect(events).toEqual(['bg-1:start', 'bg-1:end', 'person', 'bg-2', 'bg-3'])
  })

  test('a background turn past its deadline is dropped when its slot comes up', async () => {
    let clock = 1_700_000_000_000
    const gate = new NodeTurnGate({ now: () => clock })
    let release!: () => void
    const held = new Promise<void>(resolve => {
      release = resolve
    })
    const first = gate.run(async () => await held)
    let ran = 0
    const stale = gate.run(
      async () => {
        ran += 1
      },
      { background: true, deadlineAt: clock + 30, sessionId: 'worker' },
    )
    const dropped = stale.then(
      () => null,
      (error: unknown) => error,
    )
    const person = gate.run(async () => 'answered')
    clock += 31
    release()
    expect(await person).toBe('answered')
    expect(await dropped).toBeInstanceOf(NodeTurnExpiredError)
    await first
    expect(ran).toBe(0)
  })

  test('a failed turn still releases the next one', async () => {
    const gate = new NodeTurnGate()
    const first = gate.run(async () => {
      throw new Error('turn failed')
    })
    const second = gate.run(async () => 'next')

    await expect(first).rejects.toThrow('turn failed')
    await expect(second).resolves.toBe('next')
  })

  test('refuses at the queue bound instead of growing without one', async () => {
    const gate = new NodeTurnGate()
    let release!: () => void
    const held = new Promise<void>(resolve => {
      release = resolve
    })
    const ran: number[] = []
    const depths: number[] = []

    // One running turn, then a queue filled to exactly the bound behind it.
    const runs = [gate.run(async () => await held)]
    depths.push(gate.queued)
    for (let index = 0; index < LIMITS.maxQueuedTurns; index++) {
      runs.push(
        gate.run(async () => {
          ran.push(index)
        }),
      )
      depths.push(gate.queued)
    }

    expect(depths).toEqual([
      0,
      ...Array.from({ length: LIMITS.maxQueuedTurns }, (_, i) => i + 1),
    ])
    expect(gate.saturated).toBe(true)

    let extraRan = false
    const refused = gate.run(async () => {
      extraRan = true
    })
    await expect(refused).rejects.toBeInstanceOf(NodeTurnQueueFullError)
    // The bound is the protocol's number, read from the one place it is
    // written down — not a copy kept in step by hand.
    await expect(refused).rejects.toThrow(String(LIMITS.maxQueuedTurns))
    expect(extraRan).toBe(false)
    expect(gate.queued).toBe(LIMITS.maxQueuedTurns)

    release()
    await Promise.all(runs)
    expect(ran).toHaveLength(LIMITS.maxQueuedTurns)
    expect(gate.saturated).toBe(false)
  })

  test('drops a queued turn past its deadline without ever running it', async () => {
    const gate = new NodeTurnGate()
    let release!: () => void
    const held = new Promise<void>(resolve => {
      release = resolve
    })
    const first = gate.run(async () => await held)

    // The spy is the whole assertion: not "it finished quickly" — it never
    // started. A node that has already answered E_TASK_TIMEOUT must not spend
    // a turn on the task afterwards.
    let expiredRan = 0
    const expired = gate.run(
      async () => {
        expiredRan += 1
      },
      { deadlineAt: Date.now() - 1, sessionId: 'session-expired' },
    )
    let liveRan = 0
    const live = gate.run(
      async () => {
        liveRan += 1
      },
      { deadlineAt: Date.now() + 60_000, sessionId: 'session-live' },
    )

    expect(gate.queued).toBe(2)
    release()

    await expect(expired).rejects.toBeInstanceOf(NodeTurnExpiredError)
    await expect(expired).rejects.toThrow('session-expired')
    await Promise.all([first, live])
    expect(expiredRan).toBe(0)
    expect(liveRan).toBe(1)
  })

  test('an expiry that passes while a turn is waiting is caught at the head', async () => {
    // The gate's clock, owned outright by this test.
    //
    // What is being proved here is an *order* — the deadline is read when the
    // turn reaches the head, not when it is enqueued — and an order is not a
    // duration. The earlier shape stated it as one anyway: a deadline 30 ms
    // out, a `setTimeout(45)`, and 15 ms of margin standing in for "the turn
    // waited long enough". That margin is only ever as real as the wall clock
    // behind it, and no shared runner promises `Date.now()` advances
    // monotonically — one backwards correction wider than 15 ms and the turn
    // is still alive at the head, so it runs and the test reports the
    // opposite of the truth. Moving the clock by hand removes the race
    // instead of widening it: no timer, nothing to be late, nothing to drift.
    let clock = 1_700_000_000_000
    const gate = new NodeTurnGate({ now: () => clock })
    let release!: () => void
    const held = new Promise<void>(resolve => {
      release = resolve
    })
    const first = gate.run(async () => await held)

    let ran = 0
    const queued = gate.run(
      async () => {
        ran += 1
      },
      { deadlineAt: clock + 30, sessionId: 'session-slow' },
    )
    // Alive at enqueue — it is waiting, not already culled on the way in.
    // The old shape could not assert this at all; it only ever saw the end
    // state, so "dropped immediately" and "dropped at the head" looked alike.
    expect(gate.queued).toBe(1)

    // …and dead by the time its slot comes up.
    clock += 31
    release()

    await expect(queued).rejects.toBeInstanceOf(NodeTurnExpiredError)
    await first
    expect(ran).toBe(0)
  })
})

/** A turn the test ends by hand; `started` flips when the gate starts it. */
function held(
  gate: NodeTurnGate,
  events: string[],
  name: string,
  request = {},
) {
  let release!: () => void
  const gateOpen = new Promise<void>(resolve => {
    release = resolve
  })
  const turn = { started: false, release, done: Promise.resolve() }
  turn.done = gate.run(async () => {
    turn.started = true
    events.push(`${name}:start`)
    await gateOpen
    events.push(`${name}:end`)
  }, request)
  return turn
}

describe('re-entry along a verified call chain (P36.6)', () => {
  test('a turn the running one is waiting on starts at once, nested in it', async () => {
    const gate = new NodeTurnGate()
    const events: string[] = []
    const asker = held(gate, events, 'a', { key: 'task-a' })
    const answer = held(gate, events, 'b', {
      key: 'task-b',
      chain: ['task-a'],
    })
    expect(answer.started).toBe(true)
    expect(gate.depth).toBe(2)
    expect(gate.queued).toBe(0)
    answer.release()
    await answer.done
    expect(gate.depth).toBe(1)
    asker.release()
    await asker.done
    expect(events).toEqual(['a:start', 'b:start', 'b:end', 'a:end'])
    expect(gate.active).toBe(false)
  })

  test('a full queue does not refuse an answer that nests; it refuses one that would wait', async () => {
    const gate = new NodeTurnGate()
    const events: string[] = []
    const asker = held(gate, events, 'a', { key: 'task-a' })
    const backlog = Array.from({ length: LIMITS.maxQueuedTurns }, (_, i) =>
      held(gate, events, `q${i}`),
    )
    expect(gate.saturated).toBe(true)
    expect(gate.nestsNow(['task-a'])).toBe(true)
    expect(gate.nestsNow(['task-x'])).toBe(false)
    const answer = held(gate, events, 'b', { key: 'task-b', chain: ['task-a'] })
    expect(answer.started).toBe(true)
    expect(gate.queued).toBe(LIMITS.maxQueuedTurns)
    await expect(
      gate.run(async () => {}, { chain: ['task-x'] }),
    ).rejects.toBeInstanceOf(NodeTurnQueueFullError)
    answer.release()
    await answer.done
    asker.release()
    await asker.done
    for (const turn of backlog) {
      while (!turn.started) await Promise.resolve()
      turn.release()
      await turn.done
    }
  })

  test('a chain that does not name the running turn queues as ever', async () => {
    const gate = new NodeTurnGate()
    const events: string[] = []
    const running = held(gate, events, 'a', { key: 'task-a' })
    const other = held(gate, events, 'b', { chain: ['task-x'] })
    // Keyless turns (local mail, watch jobs) cannot be named by a chain.
    const keyless = held(gate, events, 'c')
    const named = held(gate, events, 'd', { chain: ['task-c'] })
    expect([other.started, keyless.started, named.started]).toEqual([
      false,
      false,
      false,
    ])
    expect(gate.queued).toBe(3)
    running.release()
    await running.done
    expect(other.started).toBe(true)
    other.release()
    keyless.release()
    named.release()
    await Promise.all([other.done, keyless.done, named.done])
    expect(events).toEqual([
      'a:start',
      'a:end',
      'b:start',
      'b:end',
      'c:start',
      'c:end',
      'd:start',
      'd:end',
    ])
  })

  test('a request without a chain (an unsigned one reaches the gate so) queues behind the asker', async () => {
    const gate = new NodeTurnGate()
    const events: string[] = []
    const asker = held(gate, events, 'a', { key: 'task-a' })
    const unsigned = held(gate, events, 'b', { key: 'task-b' })
    expect(unsigned.started).toBe(false)
    asker.release()
    await asker.done
    expect(unsigned.started).toBe(true)
    unsigned.release()
    await unsigned.done
  })

  test(`nesting stops at ${LIMITS.maxAskChain} turns inside the outermost, and a longer chain is ignored`, async () => {
    const gate = new NodeTurnGate()
    const events: string[] = []
    const turns = [held(gate, events, 't0', { key: 'k0' })]
    for (let depth = 1; depth <= LIMITS.maxAskChain; depth++)
      turns.push(
        held(gate, events, `t${depth}`, {
          key: `k${depth}`,
          chain: Array.from({ length: depth }, (_, i) => `k${i}`),
        }),
      )
    expect(turns.every(turn => turn.started)).toBe(true)
    expect(gate.depth).toBe(LIMITS.maxAskChain + 1)
    // One deeper than the limit: queued, even though its chain names the
    // innermost turn.
    const tooDeep = held(gate, events, 'deep', {
      chain: [`k${LIMITS.maxAskChain}`],
    })
    expect(tooDeep.started).toBe(false)
    turns.at(-1)!.release()
    await turns.at(-1)!.done
    // Back at three nested: a chain longer than the limit still does not count.
    const overlong = held(gate, events, 'long', {
      chain: [
        ...Array.from({ length: LIMITS.maxAskChain }, (_, i) => `x${i}`),
        `k${LIMITS.maxAskChain - 1}`,
      ],
    })
    expect(overlong.started).toBe(false)
    for (const turn of turns.slice(0, -1).reverse()) {
      turn.release()
      await turn.done
    }
    tooDeep.release()
    overlong.release()
    await Promise.all([tooDeep.done, overlong.done])
    expect(gate.active).toBe(false)
  })

  test('when the nested turn ends the gate goes back to the asker: its other answers first, nothing else in between', async () => {
    const gate = new NodeTurnGate()
    const events: string[] = []
    const asker = held(gate, events, 'asker', { key: 'task-a' })
    // A person's message and a background turn arrive while the asker waits.
    const person = held(gate, events, 'person')
    const background = held(gate, events, 'bg', { background: true })
    // The asker asked two agents here; they answer one after the other.
    const first = held(gate, events, 'first', { chain: ['task-a'] })
    const second = held(gate, events, 'second', { chain: ['task-a'] })
    expect(first.started).toBe(true)
    expect(second.started).toBe(false)
    first.release()
    await first.done
    expect(second.started).toBe(true)
    expect(person.started).toBe(false)
    second.release()
    await second.done
    // Back to the asker alone: still nothing else starts.
    await Promise.resolve()
    expect(person.started).toBe(false)
    expect(background.started).toBe(false)
    asker.release()
    await asker.done
    person.release()
    background.release()
    await Promise.all([person.done, background.done])
    expect(events).toEqual([
      'asker:start',
      'first:start',
      'first:end',
      'second:start',
      'second:end',
      'asker:end',
      'person:start',
      'person:end',
      'bg:start',
      'bg:end',
    ])
  })

  test('an asker that ends before its answer leaves the gate to the nested turn until it ends', async () => {
    const gate = new NodeTurnGate()
    const events: string[] = []
    const asker = held(gate, events, 'asker', { key: 'task-a' })
    const answer = held(gate, events, 'answer', { chain: ['task-a'] })
    const next = held(gate, events, 'next')
    asker.release()
    await asker.done
    expect(gate.depth).toBe(1)
    expect(next.started).toBe(false)
    answer.release()
    await answer.done
    expect(next.started).toBe(true)
    next.release()
    await next.done
  })

  test('a nested turn past its deadline is dropped, the next nested candidate taken', async () => {
    let clock = 1_700_000_000_000
    const gate = new NodeTurnGate({ now: () => clock })
    const events: string[] = []
    const asker = held(gate, events, 'asker', { key: 'task-a' })
    const first = held(gate, events, 'first', { chain: ['task-a'] })
    const stale = gate.run(async () => events.push('stale'), {
      chain: ['task-a'],
      deadlineAt: clock + 10,
    })
    const live = held(gate, events, 'live', { chain: ['task-a'] })
    clock += 11
    first.release()
    await first.done
    await expect(stale).rejects.toBeInstanceOf(NodeTurnExpiredError)
    expect(live.started).toBe(true)
    live.release()
    asker.release()
    await Promise.all([live.done, asker.done])
    expect(events).not.toContain('stale')
  })

  test('nestsNow tells a host whether a chain would nest right now, without queueing anything', async () => {
    const gate = new NodeTurnGate()
    const events: string[] = []
    // Nothing runs: nothing to nest in.
    expect(gate.nestsNow(['task-a'])).toBe(false)
    const asker = held(gate, events, 'a', { key: 'task-a' })
    expect(gate.nestsNow(['task-a'])).toBe(true)
    expect(gate.nestsNow(['task-x'])).toBe(false)
    expect(gate.nestsNow([])).toBe(false)
    const nested = held(gate, events, 'b', { key: 'task-b', chain: ['task-a'] })
    // Only the innermost turn counts, as for a turn that arrives.
    expect(gate.nestsNow(['task-a'])).toBe(false)
    expect(gate.nestsNow(['task-a', 'task-b'])).toBe(true)
    expect(gate.queued).toBe(0)
    nested.release()
    asker.release()
    await Promise.all([nested.done, asker.done])
    expect(gate.nestsNow(['task-a'])).toBe(false)
  })
})

describe('places: one turn per session, a bounded number at once (P38)', () => {
  test('the background share is one fewer than all places, and a single place is shared', () => {
    expect(new NodeTurnGate().limits).toEqual({
      maxTurns: 1,
      maxBackgroundTurns: 1,
    })
    expect(new NodeTurnGate({ maxTurns: 4 }).limits).toEqual({
      maxTurns: 4,
      maxBackgroundTurns: 3,
    })
    // Asked for more than leaves the foreground a place: clamped.
    expect(
      new NodeTurnGate({ maxTurns: 3, maxBackgroundTurns: 5 }).limits,
    ).toEqual({ maxTurns: 3, maxBackgroundTurns: 2 })
    expect(
      new NodeTurnGate({ maxTurns: 3, maxBackgroundTurns: 1 }).limits,
    ).toEqual({ maxTurns: 3, maxBackgroundTurns: 1 })
    expect(
      new NodeTurnGate({ maxTurns: 1, maxBackgroundTurns: 3 }).limits,
    ).toEqual({ maxTurns: 1, maxBackgroundTurns: 1 })
    expect(() => new NodeTurnGate({ maxTurns: 0 })).toThrow('positive integer')
    expect(() => new NodeTurnGate({ maxBackgroundTurns: 1.5 })).toThrow(
      'positive integer',
    )
  })

  test('a person’s turn starts at once while background work fills its share', async () => {
    const gate = new NodeTurnGate({ maxTurns: 3, maxBackgroundTurns: 2 })
    const events: string[] = []
    const bg = [1, 2, 3].map(n =>
      held(gate, events, `bg-${n}`, {
        background: true,
        sessionId: `worker-${n}`,
      }),
    )
    expect(bg.map(turn => turn.started)).toEqual([true, true, false])
    expect(gate.backgroundRunning).toBe(2)
    // The third background turn waits for the share, not for the place the
    // foreground keeps.
    const person = held(gate, events, 'person', { sessionId: 'main' })
    expect(person.started).toBe(true)
    expect(gate.running).toBe(3)
    // Every place is taken now: another person waits for one.
    const other = held(gate, events, 'other', { sessionId: 'channel-dm' })
    expect(other.started).toBe(false)
    person.release()
    await person.done
    // A freed place goes to the interactive turn, not the background one.
    expect(other.started).toBe(true)
    expect(bg[2]!.started).toBe(false)
    bg[0]!.release()
    await bg[0]!.done
    expect(bg[2]!.started).toBe(true)
    for (const turn of [other, bg[1]!, bg[2]!]) turn.release()
    await Promise.all([other.done, bg[1]!.done, bg[2]!.done])
    expect(gate.active).toBe(false)
  })

  test('two turns of one session never overlap; a busy session holds up nobody else', async () => {
    const gate = new NodeTurnGate({ maxTurns: 4 })
    const events: string[] = []
    const first = held(gate, events, 'main-1', { sessionId: 'main' })
    const second = held(gate, events, 'main-2', { sessionId: 'main' })
    const elsewhere = held(gate, events, 'worker', {
      sessionId: 'worker',
      background: true,
    })
    const third = held(gate, events, 'main-3', { sessionId: 'main' })
    expect([first.started, second.started, elsewhere.started]).toEqual([
      true,
      false,
      true,
    ])
    expect(gate.sessionBusy('main')).toBe(true)
    expect(gate.queued).toBe(2)
    first.release()
    await first.done
    // In arrival order within the session.
    expect(second.started).toBe(true)
    expect(third.started).toBe(false)
    second.release()
    await second.done
    expect(third.started).toBe(true)
    third.release()
    elsewhere.release()
    await Promise.all([third.done, elsewhere.done])
    expect(events.filter(event => event.startsWith('main'))).toEqual([
      'main-1:start',
      'main-1:end',
      'main-2:start',
      'main-2:end',
      'main-3:start',
      'main-3:end',
    ])
  })

  test('with one place a background turn still takes it when nothing else waits, and never preempts', async () => {
    const gate = new NodeTurnGate({ maxTurns: 1 })
    const events: string[] = []
    const bg = held(gate, events, 'bg', {
      background: true,
      sessionId: 'worker',
    })
    expect(bg.started).toBe(true)
    const person = held(gate, events, 'person', { sessionId: 'main' })
    expect(person.started).toBe(false)
    bg.release()
    await bg.done
    expect(person.started).toBe(true)
    person.release()
    await person.done
  })

  test('an answer nests at once even when every place is taken, and takes none', async () => {
    const gate = new NodeTurnGate({ maxTurns: 2 })
    const events: string[] = []
    const asker = held(gate, events, 'asker', {
      key: 'task-a',
      sessionId: 'main',
    })
    const busy = held(gate, events, 'busy', { sessionId: 'other' })
    expect(gate.running).toBe(2)
    const answer = held(gate, events, 'answer', {
      key: 'task-b',
      chain: ['task-a'],
      sessionId: 'peer',
    })
    expect(answer.started).toBe(true)
    expect(gate.running).toBe(2)
    expect(gate.depth).toBe(3)
    // A second question from the same asker waits for the first answer.
    const again = held(gate, events, 'again', {
      chain: ['task-a'],
      sessionId: 'peer-2',
    })
    expect(again.started).toBe(false)
    expect(gate.nestsNow(['task-a'])).toBe(false)
    expect(gate.nestsNow(['task-a', 'task-b'])).toBe(true)
    answer.release()
    await answer.done
    expect(again.started).toBe(true)
    again.release()
    await again.done
    // The asker ends first while a later answer runs: the answer keeps the
    // asker's place, so a newcomer still waits.
    const late = held(gate, events, 'late', {
      chain: ['task-a'],
      sessionId: 'peer-3',
    })
    expect(late.started).toBe(true)
    asker.release()
    await asker.done
    expect(gate.running).toBe(2)
    const newcomer = held(gate, events, 'newcomer', { sessionId: 'new' })
    expect(newcomer.started).toBe(false)
    late.release()
    await late.done
    expect(newcomer.started).toBe(true)
    newcomer.release()
    busy.release()
    await Promise.all([newcomer.done, busy.done])
    expect(gate.active).toBe(false)
  })

  test('a nested answer for a busy session waits for it, as any turn of that session does', async () => {
    const gate = new NodeTurnGate({ maxTurns: 3 })
    const events: string[] = []
    const asker = held(gate, events, 'asker', {
      key: 'task-a',
      sessionId: 'main',
    })
    const answer = held(gate, events, 'answer', {
      chain: ['task-a'],
      sessionId: 'main',
    })
    expect(answer.started).toBe(false)
    asker.release()
    await asker.done
    expect(answer.started).toBe(true)
    answer.release()
    await answer.done
  })

  test('a turn whose deadline passed while it waited for a place is dropped when one frees up', async () => {
    let clock = 1_700_000_000_000
    const gate = new NodeTurnGate({ now: () => clock, maxTurns: 2 })
    const events: string[] = []
    const a = held(gate, events, 'a', { sessionId: 'a' })
    const b = held(gate, events, 'b', { sessionId: 'b' })
    const stale = gate.run(async () => events.push('stale'), {
      sessionId: 'c',
      deadlineAt: clock + 10,
    })
    const live = held(gate, events, 'live', { sessionId: 'd' })
    clock += 11
    a.release()
    await a.done
    await expect(stale).rejects.toBeInstanceOf(NodeTurnExpiredError)
    expect(live.started).toBe(true)
    live.release()
    b.release()
    await Promise.all([live.done, b.done])
    expect(events).not.toContain('stale')
  })
})
