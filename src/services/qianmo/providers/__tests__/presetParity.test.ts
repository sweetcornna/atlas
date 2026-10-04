// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Per-preset parity table (P18.12, hermes #33; design `providers-console-m1.md`
 * §5.9 item 2, AC-P4 "node computation = request body").
 *
 * Every preset in the catalog, with its main model's effort in each of the
 * three states (`always` / `auto` / `never`), is delivered through the node's
 * real stage + commit into a throwaway config root. A fresh process then
 * starts as an ACP child does and reports two things
 * (`fixtures/preset-request.runner.ts`): what the node computes
 * (`computeEffectiveProviderState`, the `status` the console shows), and the
 * first main-loop request the same settings put on the wire, captured by a
 * recording stub. The cell passes when the two agree on the lane, the wire
 * model, whether effort is sent, and its level — and when they say what the
 * profile asked for (`never` → off; `always` → on, at the compiled level).
 *
 * A cell the node refuses to deliver is a cell too: §3.4 refuses an explicit
 * effort on the Gemini lane, and exactly those are refused. `always` on the
 * chat lane is delivered: the node reports `chatEffortHonorsOverride` from
 * the call layer (true since P18.5; node.ts carried a stale `false` copy
 * until P18.12).
 *
 * `requestParity.test.ts` stays the OpenAI-lane table of hand-picked inputs
 * (side queries, thinking switch, replay); this one is catalog-driven and
 * covers all four lanes. Neither has been checked against a real endpoint.
 *
 * Canary key, a recording stub, no network: the runner refuses any other
 * fetch and reports it.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  compiledEffortLevel,
  type EffectiveState,
  type Lane,
  type ModelCapabilities,
  type ModelEffort,
  PRESETS,
  type Preset,
  type ProviderModel,
} from '@qianmo/providers'
import { resetSettingsCache } from '../../../../utils/settings/settingsCache.js'
import { wireEffortLevel } from '../effective.js'
import {
  commitPendingProviderConfig,
  inheritedProviderKeyNames,
  stageProviderApply,
} from '../node.js'
import { applyRequest, CANARY_KEY, presetProfile } from './helpers.js'

const RUNNER = join(import.meta.dir, 'fixtures', 'preset-request.runner.ts')
const EFFORT_STATES = ['always', 'auto', 'never'] as const
type EffortState = (typeof EFFORT_STATES)[number]

/** How many cell processes run at once. */
const POOL = 8

// ─── the cell's profile ──────────────────────────────────────────────────────

/** The catalog's family defaults for a model given explicit capabilities. */
function explicitCapabilities(
  model: ProviderModel,
  lane: Lane,
): ModelCapabilities {
  if (model.capabilities.mode === 'explicit') return model.capabilities
  return {
    mode: 'explicit',
    thinking: lane === 'anthropic',
    adaptive_thinking: false,
    interleaved_thinking: false,
  }
}

/** The main model, with its effort put into `state`. */
function mainInState(
  model: ProviderModel,
  lane: Lane,
  state: EffortState,
): ProviderModel {
  if (state === 'auto') {
    return {
      ...model,
      capabilities: { mode: 'family' },
      effort: { send: 'auto' },
    }
  }
  const effort: ModelEffort =
    state === 'never'
      ? { send: 'never' }
      : model.effort.send === 'always'
        ? model.effort
        : { send: 'always', levels: ['low', 'medium', 'high'], level: 'high' }
  return { ...model, capabilities: explicitCapabilities(model, lane), effort }
}

type CellProfile = { profile: Record<string, unknown>; main: ProviderModel }

function cellProfile(preset: Preset, state: EffortState): CellProfile {
  const base = presetProfile(preset)
  const models = base.models.map(model =>
    model.role === 'main' ? mainInState(model, base.lane, state) : model,
  )
  const main = models.find(model => model.role === 'main')
  if (main === undefined) throw new Error(`${preset.id}: no main model`)
  return {
    profile: { ...base, models } as unknown as Record<string, unknown>,
    main,
  }
}

/**
 * Cells where the node and the wire agree with each other but not with the
 * profile's explicit effort — pinned as they are, so a fix shows up here.
 *
 * Both are Anthropic model ids on the Anthropic lane: a first-party catalog
 * (`isThirdPartyModelCatalog()` is false — the official host, and OpenRouter
 * because its ids name Claude models), whose capability lists the runtime
 * does not read (`get3PModelCapabilityOverride`). The family table decides
 * instead: Opus sends effort, `~anthropic/claude-sonnet-latest` does not.
 * §3.4 does not refuse an explicit effort there yet; what the console shows
 * is still the node's value, so AC-P4 holds, but the profile's choice is not
 * what happens. Left to the validator's owner (P18.12 report).
 */
const PROFILE_NOT_HONOURED: Readonly<Record<string, string>> = {
  'anthropic/never':
    'official host: first-party catalog, Opus family default sends effort',
  'openrouter/always':
    'Claude ids: first-party catalog, the family table has no effort for this id',
}

/** §3.4, as the design states it — not as the validator computes it. */
function refusedBy(preset: Preset, state: EffortState): string | null {
  if (preset.lane === 'gemini' && state !== 'auto') return 'effort-unsendable'
  return null
}

// ─── running a cell ──────────────────────────────────────────────────────────

type Captured = { url: string; body: Record<string, unknown> }

type CellRun =
  | { refused: string }
  | {
      state: EffectiveState
      requests: Captured[]
      stray: string[]
      outputs: string[]
    }

let root: string

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'qianmo-preset-parity-'))
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

/** Deliver through the real stage + commit; `null` when it was delivered. */
function deliver(
  config: string,
  profile: Record<string, unknown>,
): string | null {
  const previous = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = config
  resetSettingsCache()
  try {
    const staged = stageProviderApply(applyRequest({ profile }), {
      node: 'beta-1',
    })
    if (!staged.ok) return staged.code
    const committed = commitPendingProviderConfig()
    if (committed.status !== 'committed') {
      throw new Error(JSON.stringify(committed))
    }
    return null
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previous
    resetSettingsCache()
  }
}

/**
 * The inherited env minus everything that could pick or shape a provider,
 * and minus the test switches: an ACP child runs without `NODE_ENV=test` and
 * without `CI`, either of which sends the Anthropic lane down the base's
 * test-only key check (`auth.ts`) instead of the delivered bearer token.
 */
function cellEnv(config: string, home: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value
  }
  for (const key of inheritedProviderKeyNames(env)) delete env[key]
  delete env.OCC_CONFIG_DIR
  delete env.OCC_IDENTITY
  delete env.NODE_ENV
  delete env.CI
  env.CLAUDE_CONFIG_DIR = config
  env.HOME = home
  env.USERPROFILE = home
  return env
}

async function runCell(
  preset: Preset,
  state: EffortState,
  profile: Record<string, unknown>,
): Promise<CellRun> {
  const dir = join(root, `${preset.id}-${state}`)
  const config = join(dir, 'config')
  const home = join(dir, 'home')
  const project = join(dir, 'project')
  for (const path of [config, home, project]) {
    mkdirSync(path, { recursive: true, mode: 0o700 })
  }
  const refused = deliver(config, profile)
  if (refused !== null) return { refused }

  const child = Bun.spawn([process.execPath, 'run', RUNNER], {
    cwd: project,
    env: cellEnv(config, home),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  const marker = 'QIANMO_PRESET_REQUEST '
  const line = stdout.split('\n').find(text => text.startsWith(marker))
  if (exitCode !== 0 || line === undefined) {
    throw new Error(
      `${preset.id}/${state}: runner exited ${exitCode}: ${stderr}`,
    )
  }
  // The key travels in a header the runner does not print; make sure.
  expect(stdout).not.toContain(CANARY_KEY)
  return JSON.parse(line.slice(marker.length)) as CellRun
}

const cells = PRESETS.flatMap(preset =>
  EFFORT_STATES.map(state => ({
    preset,
    state,
    ...cellProfile(preset, state),
  })),
)
const runs = new Map<string, Promise<CellRun>>()
const cellKey = (id: string, state: EffortState) => `${id}/${state}`

/**
 * Start every cell, `POOL` at a time, in table order. Delivery is synchronous
 * and flips `CLAUDE_CONFIG_DIR` for its duration, so two never interleave.
 */
function startCells(): void {
  let next = 0
  const settle = new Map<string, (run: Promise<CellRun>) => void>()
  for (const cell of cells) {
    runs.set(
      cellKey(cell.preset.id, cell.state),
      new Promise<CellRun>((resolve, reject) => {
        settle.set(cellKey(cell.preset.id, cell.state), run =>
          run.then(resolve, reject),
        )
      }),
    )
  }
  const worker = async (): Promise<void> => {
    while (next < cells.length) {
      const cell = cells[next++]!
      const run = runCell(cell.preset, cell.state, cell.profile)
      settle.get(cellKey(cell.preset.id, cell.state))!(run)
      await run.catch(() => undefined)
    }
  }
  for (let i = 0; i < POOL; i++) void worker()
}

// ─── reading the request ─────────────────────────────────────────────────────

type Observed = {
  wire: string
  wireModel: string
  effortOnWire: boolean
  effortLevel: string | null
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : {}
}

/** What the captured request says, in the node's terms. */
function observe({ url, body }: Captured): Observed {
  const path = new URL(url).pathname
  const effort = (value: unknown) => ({
    effortOnWire: value !== undefined,
    effortLevel: value === undefined ? null : wireEffortLevel(value),
  })
  if (path.endsWith('/messages')) {
    return {
      wire: 'anthropic',
      wireModel: String(body.model),
      ...effort(record(body.output_config).effort),
    }
  }
  if (path.endsWith('/responses')) {
    return {
      wire: 'responses',
      wireModel: String(body.model),
      ...effort(record(body.reasoning).effort),
    }
  }
  if (path.endsWith('/chat/completions')) {
    return {
      wire: 'chat',
      wireModel: String(body.model),
      ...effort(body.reasoning_effort),
    }
  }
  const gemini = /\/models\/([^/:]+):streamGenerateContent$/.exec(path)
  if (gemini === null) throw new Error(`unrecognised request path ${path}`)
  // Gemini has no effort field; the effort scales `thinkingBudget`.
  const budget = record(
    record(body.generationConfig).thinkingConfig,
  ).thinkingBudget
  return {
    wire: 'gemini',
    wireModel: decodeURIComponent(gemini[1]!),
    effortOnWire: budget !== undefined,
    effortLevel: budget === undefined ? null : `budget:${String(budget)}`,
  }
}

// ─── the table ───────────────────────────────────────────────────────────────

describe('per-preset parity: node computation = request body', () => {
  beforeAll(() => startCells())

  test('every preset in the catalog has a cell in each effort state', () => {
    const covered = new Set(
      cells.map(cell => cellKey(cell.preset.id, cell.state)),
    )
    const expected = PRESETS.flatMap(preset =>
      EFFORT_STATES.map(state => cellKey(preset.id, state)),
    )
    expect([...covered].sort()).toEqual([...expected].sort())
    expect(new Set(PRESETS.map(preset => preset.id)).size).toBe(PRESETS.length)
  })

  for (const cell of cells) {
    const { preset, state, main } = cell
    test(`${preset.id} · ${preset.lane} · ${main.id} · effort ${state}`, async () => {
      const run = await runs.get(cellKey(preset.id, state))!
      const refused: string | null = 'refused' in run ? run.refused : null
      expect({ refused }).toEqual({ refused: refusedBy(preset, state) })
      if ('refused' in run) return

      expect(run.stray).toEqual([])
      expect(
        run.outputs.filter(output => output.startsWith('api_error')),
      ).toEqual([])
      expect(run.outputs).toContain('assistant')
      expect(run.requests).toHaveLength(1)

      const node: Observed = {
        wire: run.state.wire,
        wireModel: run.state.wireModel,
        effortOnWire: run.state.effortOnWire,
        effortLevel: run.state.effortLevel,
      }
      expect(observe(run.requests[0]!)).toEqual(node)
      expect(run.state.wireModel).toBe(main.id)

      // What the profile asked for.
      if (state === 'auto') return
      const asked = {
        effortOnWire: state === 'always',
        effortLevel:
          state === 'always'
            ? (compiledEffortLevel(main.effort) ?? null)
            : null,
      }
      const done = {
        effortOnWire: node.effortOnWire,
        effortLevel: node.effortLevel,
      }
      if (cellKey(preset.id, state) in PROFILE_NOT_HONOURED) {
        expect(done.effortOnWire).toBe(!asked.effortOnWire)
      } else {
        expect(done).toEqual(asked)
      }
    }, 60_000)
  }
})
