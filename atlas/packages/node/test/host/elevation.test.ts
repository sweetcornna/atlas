// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AuthzCall } from '@qianmo/resident'
import { parseElevationResource } from '@qianmo/extension/elevationPolicy'
import {
  NodeElevation,
  type NodeElevationOptions,
} from '../../src/host/elevation.js'
import { ELEVATION_BWRAP_PROBE } from '../../src/host/elevationSandbox.js'
import type { ResidentAuthzEvent } from '../../src/host/residentAuthorization.js'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true })
})

interface Harness {
  readonly elevation: NodeElevation
  readonly audits: ResidentAuthzEvent[]
  readonly invalidated: string[]
  readonly recycled: string[]
  now: number
  estopped: boolean
}
function harness(over: Partial<NodeElevationOptions> = {}): Harness {
  const workspace = mkdtempSync(join(tmpdir(), 'elevation-ws-'))
  dirs.push(workspace)
  const audits: ResidentAuthzEvent[] = []
  const invalidated: string[] = []
  const recycled: string[] = []
  const h: Harness = {
    now: 1_000_000,
    estopped: false,
    audits,
    invalidated,
    recycled,
    elevation: undefined as unknown as NodeElevation,
  }
  const elevation = new NodeElevation({
    node: 'n1',
    agents: ['reviewer'],
    estop: () => h.estopped,
    workspace: () => workspace,
    audit: event => audits.push(event),
    invalidated: agent => invalidated.push(agent),
    changed: async agent => {
      recycled.push(agent)
    },
    now: () => h.now,
    platform: 'darwin',
    ...over,
  })
  ;(h as { elevation: NodeElevation }).elevation = elevation
  return h
}
const ctx = (operationId: string) => ({
  actor: 'u:op',
  peer: 'console',
  taskId: 'task-1',
  operationId,
})
async function enable(
  h: Harness,
  tier: 'accept-edits' | 'auto' | 'full-access',
  extra: Record<string, unknown> = {},
  id = `op-${Math.random()}`,
) {
  return h.elevation.control(
    'elevation.enable',
    { agent: 'reviewer', operationId: id, tier, ...extra },
    ctx(id),
  )
}
function authorize(
  tool: string,
  args: Record<string, unknown>,
  epoch: number,
  invocationId = `call-${Math.random()}`,
) {
  return {
    toolName: tool,
    input: { phase: 'authorize', invocationId, epoch, agentKind: 'main', args },
  }
}
interface View {
  tier: string
  epoch: number
  usedCalls: number
  maxCalls: number
  sandbox: boolean
  enabledBy: string | null
}
function viewOf(outcome: Awaited<ReturnType<NodeElevation['control']>>): View {
  if (!outcome.ok) throw new Error(`control failed: ${JSON.stringify(outcome)}`)
  return outcome.value as View
}
async function statusOf(h: Harness): Promise<View> {
  const out = await h.elevation.control('elevation.status', {}, ctx('s'))
  if (!out.ok) throw new Error('status failed')
  return (out.value as View[])[0]!
}

describe('NodeElevation control operations', () => {
  test('starts off, enabling writes a live grant and recycles the agent', async () => {
    const h = harness()
    const status = await h.elevation.control('elevation.status', {}, ctx('s'))
    expect((status as { value: { tier: string }[] }).value[0]!.tier).toBe('off')
    const enabled = viewOf(await enable(h, 'auto', { maxCalls: 5 }))
    expect(enabled.tier).toBe('auto')
    expect(enabled.epoch).toBe(2)
    expect(enabled.enabledBy).toBe('u:op')
    expect(h.recycled).toContain('reviewer')
    const resource = parseElevationResource(
      JSON.parse(readFileSync(h.elevation.resourcePath('reviewer'), 'utf8')),
    )
    expect(resource?.tier).toBe('auto')
    expect(resource?.epoch).toBe(2)
    // macOS: no sandbox, so no bash is offered in the grant.
    expect(resource?.sandbox).toBeNull()
    expect(enabled.sandbox).toBe(false)
    expect(h.audits.some(a => a.kind === 'elevation.grant')).toBe(true)
  })
  test('an operationId is idempotent and rejects reuse with new arguments', async () => {
    const h = harness()
    const first = await enable(h, 'auto', {}, 'same')
    const repeat = await enable(h, 'auto', {}, 'same')
    expect(repeat).toEqual(first)
    const clash = await h.elevation.control(
      'elevation.enable',
      { agent: 'reviewer', operationId: 'same', tier: 'full-access' },
      ctx('same'),
    )
    expect(clash.ok).toBe(false)
  })
  test('ttl and call budgets are validated', async () => {
    const h = harness()
    expect((await enable(h, 'auto', { ttlMs: 1_000 })).ok).toBe(false)
    expect((await enable(h, 'auto', { maxCalls: 9_999 })).ok).toBe(false)
    expect((await enable(h, 'auto', { ttlMs: 10 * 60_000 })).ok).toBe(true)
  })
  test('revoke turns it off, bumps the epoch and cancels pending approvals', async () => {
    const h = harness()
    const epoch = viewOf(await enable(h, 'auto')).epoch
    h.invalidated.length = 0
    const revoked = viewOf(
      await h.elevation.control(
        'elevation.revoke',
        { agent: 'reviewer', operationId: 'rev' },
        ctx('rev'),
      ),
    )
    expect(revoked.tier).toBe('off')
    expect(revoked.epoch).toBe(epoch + 1)
    expect(h.invalidated).toContain('reviewer')
    expect(h.audits.some(a => a.kind === 'elevation.revoke')).toBe(true)
  })
})

describe('NodeElevation gate (P39 §2)', () => {
  const deny = async () => false
  function spy() {
    const calls: AuthzCall[] = []
    return {
      calls,
      allow: async (call: AuthzCall) => {
        calls.push(call)
        return true
      },
      refuse: async (call: AuthzCall) => {
        calls.push(call)
        return false
      },
    }
  }
  const gate = (
    h: Harness,
    tool: string,
    args: Record<string, unknown>,
    epoch: number,
    approve: (call: AuthzCall) => Promise<boolean>,
    invocationId?: string,
  ) =>
    h.elevation.decide(
      'reviewer',
      'task-1',
      'ctx',
      authorize(tool, args, epoch, invocationId),
      () => true,
      approve,
    )

  test('auto runs local and read-out directly, asks only for act-out', async () => {
    const h = harness()
    const epoch = viewOf(await enable(h, 'auto', { maxCalls: 10 })).epoch
    const s = spy()
    expect(
      (await gate(h, 'web_search', { query: 'x' }, epoch, s.allow)).ok,
    ).toBe(true)
    expect(
      (await gate(h, 'github', { op: 'repo_view' }, epoch, s.allow)).ok,
    ).toBe(true)
    expect(s.calls.length).toBe(0)
    const act = await gate(h, 'github', { op: 'pr_create' }, epoch, s.allow)
    expect(act.ok).toBe(true)
    expect(s.calls[0]?.toolName).toBe('qianmo_elevated_github')
    // A refused approval blocks the act-out call.
    expect((await gate(h, 'github', { op: 'pr_create' }, epoch, deny)).ok).toBe(
      false,
    )
  })
  test('accept-edits asks for every elevated class', async () => {
    const h = harness()
    const epoch = viewOf(await enable(h, 'accept-edits')).epoch
    const s = spy()
    expect(
      (await gate(h, 'web_search', { query: 'x' }, epoch, s.allow)).ok,
    ).toBe(true)
    expect(
      (await gate(h, 'github', { op: 'repo_view' }, epoch, s.allow)).ok,
    ).toBe(true)
    expect(s.calls.map(c => c.toolName)).toEqual([
      'qianmo_elevated_web_search',
      'qianmo_elevated_github',
    ])
    // task is never an elevated call at any tier.
    expect((await gate(h, 'task', { prompt: 'x' }, epoch, s.allow)).ok).toBe(
      false,
    )
  })
  test('full-access runs act-out without asking', async () => {
    const h = harness()
    const epoch = viewOf(await enable(h, 'full-access')).epoch
    const s = spy()
    expect(
      (await gate(h, 'github', { op: 'pr_create' }, epoch, s.allow)).ok,
    ).toBe(true)
    expect(s.calls.length).toBe(0)
  })
  test('a sandboxless node refuses bash even under full-access', async () => {
    const h = harness()
    const epoch = viewOf(await enable(h, 'full-access')).epoch
    const r = await gate(h, 'bash', { command: 'ls' }, epoch, async () => true)
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('沙箱')
  })
  test('the call budget is spent per admitted call and disables on exhaustion', async () => {
    const h = harness()
    const epoch = viewOf(await enable(h, 'auto', { maxCalls: 1 })).epoch
    expect((await gate(h, 'web_search', { query: 'a' }, epoch, deny)).ok).toBe(
      true,
    )
    expect((await gate(h, 'web_search', { query: 'b' }, epoch, deny)).ok).toBe(
      false,
    )
    expect((await statusOf(h)).tier).toBe('off')
  })
  test('a repeat of the same invocation is not recounted', async () => {
    const h = harness()
    const epoch = viewOf(await enable(h, 'auto', { maxCalls: 3 })).epoch
    await gate(h, 'web_search', { query: 'a' }, epoch, deny, 'same')
    await gate(h, 'web_search', { query: 'a' }, epoch, deny, 'same')
    expect((await statusOf(h)).usedCalls).toBe(1)
  })
  test('a stale epoch, an inactive turn and expiry are all refused', async () => {
    const h = harness()
    const epoch = viewOf(await enable(h, 'auto')).epoch
    expect(
      (await gate(h, 'web_search', { query: 'a' }, epoch - 1, deny)).ok,
    ).toBe(false)
    const inactive = await h.elevation.decide(
      'reviewer',
      'task-1',
      'ctx',
      authorize('web_search', { query: 'a' }, epoch),
      () => false,
      deny,
    )
    expect(inactive.ok).toBe(false)
    h.now += 24 * 60 * 60_000
    const expired = await gate(h, 'web_search', { query: 'a' }, epoch, deny)
    expect(expired.ok).toBe(false)
    expect(expired.reason).toContain('到期')
  })
  test('ESTOP clears the grant for good and refuses the call', async () => {
    const h = harness()
    const epoch = viewOf(await enable(h, 'auto')).epoch
    h.estopped = true
    h.invalidated.length = 0
    const r = await gate(h, 'web_search', { query: 'a' }, epoch, deny)
    expect(r.ok).toBe(false)
    expect(h.invalidated).toContain('reviewer')
    const view = await statusOf(h)
    expect(view.tier).toBe('off')
    expect(view.epoch).toBe(epoch + 1)
    // Lifting ESTOP does not restore the grant.
    h.estopped = false
    expect((await statusOf(h)).tier).toBe('off')
  })
  test('the completed phase records an action and never recounts', async () => {
    const h = harness()
    const epoch = viewOf(await enable(h, 'auto')).epoch
    await gate(h, 'web_search', { query: 'a' }, epoch, deny, 'c1')
    await h.elevation.decide(
      'reviewer',
      'task-1',
      'ctx',
      {
        toolName: 'web_search',
        input: { phase: 'completed', invocationId: 'c1', isError: false },
      },
      () => true,
      deny,
    )
    const actions = await h.elevation.control(
      'elevation.actions',
      { agent: 'reviewer', limit: 50 },
      ctx('a'),
    )
    const rows = (actions as { value: { outcome: string }[] }).value
    expect(rows.some(r => r.outcome === 'completed')).toBe(true)
    expect(rows.some(r => r.outcome === 'allowed')).toBe(true)
  })
})

describe('NodeElevation sandbox on Linux', () => {
  test('a usable bubblewrap yields a frozen sandbox argv and allows bash', async () => {
    let probed: readonly string[] | undefined
    const h = harness({
      platform: 'linux',
      bwrap: {
        available: program => program === 'bwrap',
        probe: async argv => {
          probed = argv
          return true
        },
        shell: () => '/bin/bash',
      },
    })
    const view = viewOf(await enable(h, 'auto'))
    expect(view.sandbox).toBe(true)
    expect(probed).toEqual(ELEVATION_BWRAP_PROBE)
    const resource = parseElevationResource(
      JSON.parse(readFileSync(h.elevation.resourcePath('reviewer'), 'utf8')),
    )
    expect(resource?.sandbox?.argv[0]).toBe('bwrap')
    expect(resource?.sandbox?.shell).toBe('/bin/bash')
    expect(resource?.sandbox?.argv).toContain('--unshare-net')
    const epoch = view.epoch
    expect(
      (
        await h.elevation.decide(
          'reviewer',
          'task-1',
          'ctx',
          authorize('bash', { command: 'ls' }, epoch),
          () => true,
          async () => true,
        )
      ).ok,
    ).toBe(true)
  })
})

describe('elevation sandbox argv (P39 §3)', () => {
  test('no network, read-only system tree, writable workspace, read-only policy dirs', async () => {
    const { elevationSandboxArgv } = await import(
      '../../src/host/elevationSandbox.js'
    )
    const present = new Set([
      '/usr',
      '/bin',
      '/etc',
      '/work/.git',
      '/work/.omp',
    ])
    const argv = elevationSandboxArgv({
      bwrap: 'bwrap',
      shell: '/bin/bash',
      workspace: '/work',
      exists: file => present.has(file),
    })
    expect(argv[0]).toBe('bwrap')
    for (const flag of [
      '--unshare-net',
      '--unshare-pid',
      '--clearenv',
      '--die-with-parent',
    ])
      expect(argv).toContain(flag)
    const pairs = (flag: string) =>
      argv.flatMap((word, i) => (word === flag ? [argv[i + 1]] : []))
    expect(pairs('--ro-bind')).toEqual([
      '/usr',
      '/bin',
      '/etc',
      '/work/.git',
      '/work/.omp',
    ])
    expect(pairs('--bind')).toEqual(['/work'])
    // The node's home and config root are never mounted, so they do not exist inside.
    expect(argv.join(' ')).not.toContain('--ro-bind / /')
    expect(argv.indexOf('--bind')).toBeLessThan(argv.indexOf('/work/.git'))
    expect(argv).toContain('HOME')
  })
})

describe('approval helpers for elevated calls', () => {
  test('elevated tools are fresh one-shot approvals', async () => {
    const { freshApprovalTool } = await import(
      '../../src/host/residentAuthorization.js'
    )
    expect(freshApprovalTool('qianmo_elevated_bash')).toBe(true)
    expect(freshApprovalTool('qianmo_elevated_github')).toBe(true)
    expect(freshApprovalTool('write')).toBe(false)
  })
})

describe('revoke, sweep and runtime support', () => {
  test('revoke terminates running children; disable only recycles', async () => {
    const terminated: string[] = []
    const h = harness({
      terminate: async agent => {
        terminated.push(agent)
      },
    })
    await enable(h, 'auto')
    h.recycled.length = 0
    await h.elevation.control(
      'elevation.disable',
      { agent: 'reviewer', operationId: 'd1' },
      ctx('d1'),
    )
    expect(terminated).toEqual([])
    expect(h.recycled).toEqual(['reviewer'])
    await enable(h, 'auto')
    await h.elevation.control(
      'elevation.revoke',
      { agent: 'reviewer', operationId: 'r1' },
      ctx('r1'),
    )
    expect(terminated).toEqual(['reviewer'])
  })
  test('the sweep clears an expired grant and an ESTOP without waiting for a call', async () => {
    const h = harness()
    await enable(h, 'auto', { ttlMs: 5 * 60_000 })
    h.now += 5 * 60_000
    await h.elevation.sweep()
    expect((await statusOf(h)).tier).toBe('off')
    await enable(h, 'auto')
    h.estopped = true
    await h.elevation.sweep()
    expect((await statusOf(h)).tier).toBe('off')
    expect(h.audits.some(a => a.kind === 'elevation.estop')).toBe(true)
    // ESTOP refuses a new grant until it is lifted.
    expect((await enable(h, 'auto')).ok).toBe(false)
  })
  test('an agent on an external runtime cannot be elevated, and says why', async () => {
    let external = true
    const h = harness({
      unsupported: () =>
        external ? '该智能体运行在外部底层 dsh 上' : undefined,
    })
    const refused = await enable(h, 'auto')
    expect(refused.ok).toBe(false)
    expect((refused as { message: string }).message).toContain('dsh')
    expect((await statusOf(h)) as unknown).toMatchObject({
      unsupportedReason: '该智能体运行在外部底层 dsh 上',
    })
    external = false
    expect((await enable(h, 'auto')).ok).toBe(true)
    // Moving onto an external runtime withdraws a live grant at the next sweep.
    external = true
    await h.elevation.sweep()
    expect((await statusOf(h)).tier).toBe('off')
  })
  test('macOS reports why commands are unavailable before any grant', async () => {
    const h = harness()
    expect((await statusOf(h)) as unknown).toMatchObject({
      sandbox: false,
      sandboxReason: expect.stringContaining('沙箱'),
    })
  })
})
