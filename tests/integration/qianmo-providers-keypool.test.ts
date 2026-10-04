// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Several keys on one profile, on the console path (P18.18,
 * `providers-console-m1.md` §9.2 P18.18, §8.3 AC-P2).
 *
 * The port-level halves of the same two standards are in
 * `src/cli/handlers/__tests__/consoleProviders.test.ts` ("P18.18: several
 * keys"); here every step is a request a page script sends, through the
 * console's routes, as an `ops` person on a session cookie.
 *
 * ## What is real
 *
 * - The console: `createConsoleHandler` with personal accounts, the real
 *   `ActionLedger` and the providers routes.
 * - The hub: `openConsoleProviders`, its book, sealed secret store (real
 *   AES-GCM, real files) and local executor.
 * - The node: the executor runs the real `qm provider serve-stdin` from
 *   source on a temporary 0700 config root (as
 *   `consoleProvidersServeStdin.test.ts` does); it writes `settings.json` and
 *   `key-pool.json` and reports each key from `key-pool-state.json`.
 *
 * ## What is not
 *
 * The vendor: a loopback double the probe reaches. No resident runs, so an
 * apply commits at once. A key's cooldown and revocation are written to
 * `key-pool-state.json` with the call layer's own store function, as the
 * call layer writes them after a 429 or a revoked 401 (the call layer itself
 * is under test in `modelCompat/__tests__/credentialPool*.test.ts`).
 *
 * ## The cases, in order (each builds on the one before)
 *
 * 1. Filled in, stored, sent: a profile made with one key, two more added
 *    through the form's save, the strategy set, assigned and applied; the
 *    node runs all three and the page shows each key's state as the node
 *    reports it, to ops and to a viewer.
 * 2. 测连 on the pool's node; a key filled in again on the console path: its
 *    old ciphertext is gone from `provider-secrets.json`, byte for byte.
 * 3. A key removed on the console path: its ciphertext and its slot are
 *    gone, and after the next apply its value is nowhere on the node.
 * 4. AC-P2 over the whole flow: no key, nor a slice of one, in any response,
 *    page, the ledger, the hub's files, the node's files other than the
 *    three that must hold the live keys, the alarms, the export, or any
 *    `ps -eo args` sampled every 100 ms while it ran.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ActionLedger } from '@qianmo/console'
import { secretFingerprint } from '@qianmo/providers'
import {
  ManualClock,
  accountsHarness,
  asSession,
  person,
  type Person,
} from '../../packages/console/test/accountsHarness.js'
import { MemoryActionStore } from '../../packages/console/test/actionStore.js'
import {
  type ConsoleProviders,
  openConsoleProviders,
  type ProviderScheduler,
} from '../../src/cli/handlers/consoleProviders.js'
import {
  childEnv,
  sourceLaunch,
} from '../../src/cli/handlers/__tests__/providerSource.js'
import { updateKeyPoolState } from '../../src/services/qianmo/modelCompat/credentialPoolStore.js'

const NODE = 'pool-node'
const K1 = 'sk-test-canary-keypool-one-Rv41NqX8sL'
const K2 = 'sk-test-canary-keypool-two-Gm07TzH3wP'
const K3 = 'sk-test-canary-keypool-three-Bc52YkD6uQ'
const K2_ROTATED = 'sk-test-canary-keypool-rotated-Wd93JhF1eM'
const ALL_KEYS = [K1, K2, K3, K2_ROTATED]
/** Each step starts this CLI from source, on a machine other suites share. */
const STEP_MS = 240_000

const STILL: ProviderScheduler = { set: () => null, clear: () => {} }

/** The page's clock is the wall clock, as the hub's is. */
class WallClock extends ManualClock {
  override now = (): number => Date.now()
}

/** The full key and two slices of it: what a leak would most likely carry. */
const PIECES = ALL_KEYS.flatMap(key => [key, key.slice(-8), key.slice(15, 27)])

function hits(text: string | Buffer): string[] {
  return PIECES.filter(piece => text.includes(piece))
}

let root: string
let config: string
let hubDir: string
let port: ConsoleProviders
let ledgerStore: MemoryActionStore
let ledger: ActionLedger
let handle: (request: Request) => Promise<Response>
let ops: Person
let viewer: Person
let vendor: ReturnType<typeof Bun.serve>
let skew = 0
const alarms: string[] = []
/** Every body a response carried, by request. */
const bodies: { readonly what: string; readonly body: string }[] = []
const vendorAuth: string[] = []
/** A process started with this in its argv: the sampler must see it. */
const PS_MARKER = 'qm-keypool-ps-sampler-probe'
const sampler = {
  timer: undefined as ReturnType<typeof setInterval> | undefined,
  busy: false,
  samples: 0,
  hits: [] as string[],
  sawMarker: false,
}

/** The hub's clock moves past its 5 s status throttle instead of sleeping. */
function later(): void {
  skew += 10_000
}

/** `ps -eo args`, every 100 ms, scanned as it comes in. */
function startSampling(): void {
  sampler.timer = setInterval(() => {
    if (sampler.busy) return
    sampler.busy = true
    const ps = Bun.spawn(['ps', '-eo', 'args'], {
      stdout: 'pipe',
      stderr: 'ignore',
    })
    void new Response(ps.stdout)
      .text()
      .then(text => {
        sampler.samples += 1
        if (text.includes(PS_MARKER)) sampler.sawMarker = true
        for (const piece of hits(text)) sampler.hits.push(piece)
      })
      .finally(() => {
        sampler.busy = false
      })
  }, 100)
}

/** The executable the local executor runs as `<command> <node>`. */
function writeNodeCommand(): string {
  const launch = sourceLaunch(
    ['provider', 'serve-stdin', '--node'],
    childEnv({ OCC_IDENTITY: 'qianmo', OCC_CONFIG_DIR: config, HOME: root }),
  )
  writeFileSync(
    join(root, 'launch.json'),
    JSON.stringify({
      execPath: launch.execPath,
      args: launch.args,
      env: launch.env,
    }),
  )
  writeFileSync(
    join(root, 'launch.mjs'),
    `import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
const spec = JSON.parse(readFileSync(${JSON.stringify(join(root, 'launch.json'))}, 'utf8'))
const run = spawnSync(spec.execPath, [...spec.args, process.argv[2]], { stdio: 'inherit', env: spec.env, cwd: ${JSON.stringify(root)} })
process.exit(run.status ?? 2)
`,
  )
  const command = join(root, 'node.sh')
  writeFileSync(
    command,
    `#!/bin/sh\nexec '${process.execPath}' '${join(root, 'launch.mjs')}' "$@"\n`,
  )
  chmodSync(command, 0o755)
  return command
}

/** A script's request (cookie and console header), as `who`. */
function call(
  method: string,
  path: string,
  body?: unknown,
  who: Person = ops,
): Request {
  return asSession(method, path, who.sid, body === undefined ? {} : { body })
}

/** A page as a browser navigates to it. */
function page(path: string, who: Person = ops): Request {
  return asSession('GET', path, who.sid, { header: false })
}

async function ok<T>(request: Request): Promise<T> {
  const response = await handle(request)
  const text = await response.text()
  bodies.push({ what: `${request.method} ${request.url}`, body: text })
  if (response.status !== 200) {
    throw new Error(
      `${request.method} ${request.url} ${response.status} ${text}`,
    )
  }
  return (response.headers.get('content-type') ?? '').includes('json')
    ? (JSON.parse(text) as T)
    : (text as T)
}

/** `provider.*` ledger actions, oldest first. */
async function recorded(): Promise<string[]> {
  const listed = await ledger.list({ actionPrefix: 'provider.', limit: 200 })
  if (!listed.ok) throw new Error(listed.failure.message)
  return [...listed.value.entries].reverse().map(entry => entry.action)
}

const secretsPath = () => join(hubDir, 'provider-secrets.json')

/** The four sealed pieces of one key's entry in the hub's secret store. */
function sealed(keyId: string): string[] {
  const store = JSON.parse(readFileSync(secretsPath(), 'utf8')) as {
    entries: Record<string, Record<string, unknown>>
  }
  const entry = store.entries[`pool:${keyId}`]
  if (entry === undefined) return []
  return [entry.ct, entry.iv, entry.tag, entry.wrappedKey].filter(
    (piece): piece is string => typeof piece === 'string',
  )
}

function inStore(piece: string): boolean {
  return readFileSync(secretsPath()).includes(Buffer.from(piece))
}

/** Every file under `dir`, relative to `root`. */
function files(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...files(path))
    else out.push(path)
  }
  return out
}

/** The node's own record of a key gone bad, written by the call layer's store. */
function markOnNode(change: Parameters<typeof updateKeyPoolState>[0]): void {
  const previous = {
    OCC_CONFIG_DIR: process.env.OCC_CONFIG_DIR,
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
  }
  process.env.OCC_CONFIG_DIR = config
  try {
    updateKeyPoolState(change)
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'qm-providers-keypool-')))
  config = join(root, 'config')
  hubDir = join(root, 'hub')
  mkdirSync(config, { mode: 0o700 })
  chmodSync(config, 0o700)
  vendor = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: request => {
      vendorAuth.push(request.headers.get('authorization') ?? '')
      return Response.json({ object: 'list', data: [{ id: 'gpt-6-luna' }] })
    },
  })
  port = openConsoleProviders({
    storePath: join(hubDir, 'providers.ndjson'),
    secretsPath: join(hubDir, 'provider-secrets.json'),
    keyPath: join(root, 'hub-keys', 'provider-master.key'),
    knownHostsFile: join(root, 'hub-keys', 'known_hosts'),
    nodes: [{ node: NODE, kind: 'local', command: writeNodeCommand() }],
    onAlarm: line => alarms.push(line),
    now: () => Date.now() + skew,
    scheduler: STILL,
  })
  ledgerStore = new MemoryActionStore()
  ledger = new ActionLedger({ store: ledgerStore })
  const h = accountsHarness({
    clock: new WallClock(),
    deps: { actions: ledger, providers: port },
  })
  handle = h.handle
  ops = await person(handle, 'ops')
  viewer = await person(handle, 'viewer')
  startSampling()
  // The sampler's own control: an argv it has to find.
  Bun.spawn(['/bin/sh', '-c', 'sleep 2', PS_MARKER], {
    stdout: 'ignore',
    stderr: 'ignore',
  })
}, 60_000)

afterAll(async () => {
  if (sampler.timer !== undefined) clearInterval(sampler.timer)
  port?.stop()
  await vendor?.stop(true)
  rmSync(root, { recursive: true, force: true })
}, 60_000)

describe('several keys on the console path, against the real hub and node', () => {
  test(
    'filled in, stored, sent: three keys reach the node, and the page shows each one’s state as the node reports it',
    async () => {
      const first = await ok<{
        node: { actual: { capabilities: { multiKey: boolean } } | null }
      }>(call('POST', `/v0/providers/nodes/${NODE}/refresh`))
      expect(first.node.actual?.capabilities.multiKey).toBe(true)

      const created = await ok<{ profile: { revision: number } }>(
        call('POST', '/v0/providers/profiles', {
          presetId: 'custom-openai',
          profile: {
            id: 'pool',
            name: '密钥池',
            lane: 'openai-responses',
            baseUrl: `http://127.0.0.1:${String(vendor.port)}/v1`,
            auth: { scheme: 'bearer' },
            models: [
              {
                id: 'gpt-6-luna',
                role: 'main',
                tiers: ['opus', 'sonnet', 'haiku', 'fable'],
                capabilities: { mode: 'family' },
                effort: { send: 'auto' },
              },
            ],
          },
          secrets: { k1: K1 },
        }),
      )
      // Two more, one save each, the way 加一把密钥 sends it.
      const two = await ok<{ profile: { revision: number } }>(
        call('PUT', '/v0/providers/profiles/pool', {
          ifMatch: created.profile.revision,
          profile: { keys: [{ id: 'k1' }, { id: 'k2', label: '备用' }] },
          secrets: { k2: K2 },
        }),
      )
      const three = await ok<{ profile: { revision: number } }>(
        call('PUT', '/v0/providers/profiles/pool', {
          ifMatch: two.profile.revision,
          profile: {
            keys: [{ id: 'k1' }, { id: 'k2', label: '备用' }, { id: 'k3' }],
          },
          secrets: { k3: K3 },
        }),
      )
      // The strategy, the way 保存 sends it with the select on the form.
      const chosen = await ok<{
        profile: {
          keySelection: string
          keys: { id: string; fingerprint?: string }[]
        }
      }>(
        call('PUT', '/v0/providers/profiles/pool', {
          ifMatch: three.profile.revision,
          profile: { keySelection: 'round_robin' },
        }),
      )
      expect(chosen.profile.keySelection).toBe('round_robin')
      expect(chosen.profile.keys.map(key => key.fingerprint)).toEqual([
        secretFingerprint(K1),
        secretFingerprint(K2),
        secretFingerprint(K3),
      ])

      await ok(
        call('PUT', `/v0/providers/nodes/${NODE}/assignment`, {
          mode: 'profile',
          profileId: 'pool',
        }),
      )
      const applied = await ok<{ results: { outcome: string }[] }>(
        call('POST', '/v0/providers/apply', { nodes: [NODE] }),
      )
      expect(applied.results.map(result => result.outcome)).toEqual(['ok'])

      // On the node: the primary in settings.json, all three in key-pool.json.
      const settings = JSON.parse(
        readFileSync(join(config, 'settings.json'), 'utf8'),
      ) as { env?: Record<string, string> }
      expect(settings.env?.OPENAI_API_KEY).toBe(K1)
      const poolPath = join(config, 'qianmo', 'provider', 'key-pool.json')
      expect(statSync(poolPath).mode & 0o777).toBe(0o600)
      const pool = JSON.parse(readFileSync(poolPath, 'utf8')) as {
        selection: string
        keys: { id: string; value: string }[]
      }
      expect(pool.selection).toBe('round_robin')
      expect(pool.keys).toEqual([
        { id: 'k1', value: K1 },
        { id: 'k2', value: K2 },
        { id: 'k3', value: K3 },
      ])

      // What the call layer writes after a second 429 on k2 and a revoked
      // 401 on k3; the node reports it on the next refresh.
      const until = new Date(Date.now() + 3_600_000).toISOString()
      markOnNode(state => {
        state.marks.k2 = {
          fp: secretFingerprint(K2),
          state: 'cooling',
          until,
          reason: 'rate-limit',
          status: 429,
          at: new Date().toISOString(),
        }
        state.marks.k3 = {
          fp: secretFingerprint(K3),
          state: 'dead',
          reason: 'revoked',
          status: 401,
          at: new Date().toISOString(),
        }
      })
      later()
      const refreshed = await ok<{
        node: { actual: { keys?: unknown } }
      }>(call('POST', `/v0/providers/nodes/${NODE}/refresh`))
      expect(refreshed.node.actual.keys).toEqual([
        { id: 'k1', state: 'ok' },
        { id: 'k2', state: 'cooling', until, reason: 'rate-limit' },
        { id: 'k3', state: 'dead', reason: 'revoked' },
      ])

      for (const who of [ops, viewer]) {
        const tab = await ok<string>(
          call('GET', `/fragments/providers/node/${NODE}`, undefined, who),
        )
        const words = tab.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ')
        expect(words).toContain('k1 可用')
        expect(words).toContain('k2 冷却中 到')
        expect(words).toContain('k3 已停用 凭据已吊销')
        const nodes = await ok<string>(
          call(
            'GET',
            '/fragments/providers/profiles/pool/nodes',
            undefined,
            who,
          ),
        )
        expect(nodes).toContain('k1 可用 · k2 冷却中 · k3 已停用')
      }
      // The form lists the three, in the node's order, for ops.
      const form = await ok<string>(page('/providers/profiles/pool'))
      expect(
        [...form.matchAll(/data-pool-key="(k\d)"/g)].map(match => match[1]),
      ).toEqual(['k1', 'k2', 'k3'])

      expect(await recorded()).toEqual([
        'provider.save',
        'provider.secret.set',
        'provider.save',
        'provider.secret.set',
        'provider.save',
        'provider.secret.set',
        'provider.save',
        'provider.assign',
        'provider.apply',
      ])
    },
    STEP_MS,
  )

  test(
    'filled in again on the console path: 测连 first, then the old ciphertext of that key is gone from the store, byte for byte',
    async () => {
      // 测连 on the node, with the stored pool: the primary goes out.
      const probed = await ok<{ ok: boolean; reachable: boolean }>(
        call('POST', '/v0/providers/probe', {
          node: NODE,
          mode: 'auth',
          profileId: 'pool',
        }),
      )
      expect(probed.reachable).toBe(true)
      expect(vendorAuth).toContain(`Bearer ${K1}`)

      const old = sealed('k2')
      expect(old).toHaveLength(4)
      // Positive control: the scan finds them while they are there.
      for (const piece of old) expect(inStore(piece)).toBe(true)
      const before = await ok<{ revision: number }>(
        call('GET', '/v0/providers/profiles/pool'),
      )
      const rotated = await ok<{
        profile: { keys: { id: string; fingerprint?: string }[] }
      }>(
        call('PUT', '/v0/providers/profiles/pool/keys/k2', {
          ifMatch: before.revision,
          value: K2_ROTATED,
        }),
      )
      expect(
        rotated.profile.keys.find(key => key.id === 'k2')?.fingerprint,
      ).toBe(secretFingerprint(K2_ROTATED))
      for (const piece of old) {
        expect([piece.slice(0, 12), inStore(piece)]).toEqual([
          piece.slice(0, 12),
          false,
        ])
      }
      expect(sealed('k2')).toHaveLength(4)
      expect((await recorded()).slice(-2)).toEqual([
        'provider.probe.auth',
        'provider.secret.set',
      ])
    },
    STEP_MS,
  )

  test(
    'removed on the console path: its ciphertext and slot are gone, and after the next apply its value is nowhere on the node',
    async () => {
      const old = sealed('k3')
      expect(old).toHaveLength(4)
      for (const piece of old) expect(inStore(piece)).toBe(true)
      const before = await ok<{ revision: number }>(
        call('GET', '/v0/providers/profiles/pool'),
      )
      // 删除 sends the stored list without k3.
      await ok(
        call('PUT', '/v0/providers/profiles/pool', {
          ifMatch: before.revision,
          profile: { keys: [{ id: 'k1' }, { id: 'k2', label: '备用' }] },
        }),
      )
      for (const piece of old) {
        expect([piece.slice(0, 12), inStore(piece)]).toEqual([
          piece.slice(0, 12),
          false,
        ])
      }
      expect(sealed('k3')).toEqual([])
      expect(readFileSync(secretsPath(), 'utf8')).not.toContain('pool:k3')

      later()
      const applied = await ok<{ results: { outcome: string }[] }>(
        call('POST', '/v0/providers/apply', { nodes: [NODE] }),
      )
      expect(applied.results.map(result => result.outcome)).toEqual(['ok'])
      const pool = JSON.parse(
        readFileSync(
          join(config, 'qianmo', 'provider', 'key-pool.json'),
          'utf8',
        ),
      ) as { keys: { id: string; value: string }[] }
      expect(pool.keys).toEqual([
        { id: 'k1', value: K1 },
        { id: 'k2', value: K2_ROTATED },
      ])
      // The removed key and the replaced value: on no file of the node.
      for (const path of files(config)) {
        const bytes = readFileSync(path)
        for (const gone of [K3, K2]) {
          expect([path, bytes.includes(Buffer.from(gone))]).toEqual([
            path,
            false,
          ])
        }
      }
      later()
      const view = await ok<{ node: { actual: { keys?: unknown } } }>(
        call('POST', `/v0/providers/nodes/${NODE}/refresh`),
      )
      // The new value of k2 earned nothing the old one did.
      expect(view.node.actual.keys).toEqual([
        { id: 'k1', state: 'ok' },
        { id: 'k2', state: 'ok' },
      ])
      expect((await recorded()).slice(-2)).toEqual([
        'provider.save',
        'provider.apply',
      ])
    },
    STEP_MS,
  )

  test(
    'AC-P2 over the whole flow: no key nor a slice of one anywhere but the three node files that must hold the live keys',
    async () => {
      // The export, the pages and the reads a person can open, both roles.
      const exported = await handle(
        asSession('GET', '/v0/providers/export', ops.sid, { header: false }),
      )
      expect(exported.status).toBe(200)
      const exportText = await exported.text()
      expect(exportText).toContain('"pool"')
      expect(exportText).not.toContain('fp1:')
      for (const who of [ops, viewer]) {
        for (const path of [
          '/providers',
          '/providers/profiles/pool',
          `/providers/nodes/${NODE}`,
        ]) {
          await ok(page(path, who))
        }
        for (const path of [
          '/v0/providers',
          '/v0/providers/profiles/pool',
          `/v0/providers/nodes/${NODE}`,
          '/fragments/providers/board',
        ]) {
          await ok(call('GET', path, undefined, who))
        }
      }
      // Let the sampler see the quiet after the last step too.
      const seen = sampler.samples
      await new Promise(resolve => setTimeout(resolve, 300))
      if (sampler.timer !== undefined) clearInterval(sampler.timer)

      const surfaces: Record<string, string> = {
        responses: JSON.stringify(bodies),
        export: exportText,
        ledger: ledgerStore.text ?? '',
        alarms: alarms.join('\n'),
      }
      for (const path of files(hubDir)) {
        surfaces[path.slice(root.length + 1)] = readFileSync(path, 'latin1')
      }
      // The node's files, but the three that hold the live keys by design
      // (§8.3, and P18.18's key-pool.json beside pending.json).
      const holders = new Set([
        join(config, 'settings.json'),
        join(config, 'qianmo', 'provider', 'pending.json'),
        join(config, 'qianmo', 'provider', 'key-pool.json'),
      ])
      for (const path of files(config)) {
        if (!holders.has(path)) {
          surfaces[path.slice(root.length + 1)] = readFileSync(path, 'latin1')
        }
      }
      expect(Object.keys(surfaces)).toEqual(
        expect.arrayContaining([
          'hub/providers.ndjson',
          'hub/provider-secrets.json',
          'config/qianmo/provider/key-pool-state.json',
          'config/qianmo/provider/state.json',
        ]),
      )
      for (const [name, text] of Object.entries(surfaces)) {
        expect([name, hits(text)]).toEqual([name, []])
      }
      expect(sampler.hits).toEqual([])
      expect(sampler.samples).toBeGreaterThan(Math.max(seen, 20))
      expect(sampler.sawMarker).toBe(true)

      // Positive control: the scan is not blind. The live keys are in the
      // node's key pool, and `hits` finds them there.
      const live = readFileSync(
        join(config, 'qianmo', 'provider', 'key-pool.json'),
        'utf8',
      )
      expect(hits(live)).toEqual(
        expect.arrayContaining([K1, K2_ROTATED, K1.slice(-8)]),
      )
    },
    STEP_MS,
  )
})
