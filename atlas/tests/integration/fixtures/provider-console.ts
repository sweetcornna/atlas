// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { chmodSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { ActionLedger } from '@qianmo/console'
import {
  accountsHarness,
  asSession,
  person,
  ManualClock,
} from '../../../packages/console/test/accountsHarness.js'
import { MemoryActionStore } from '../../../packages/console/test/actionStore.js'
import { isolatedRoot } from '../../../packages/node/test/providers/fake.js'
import { openConsoleProviders } from '../../../packages/node/src/commands/consoleProviders.js'
import {
  sourceLaunch,
  childEnv,
} from '../../../packages/node/test/commands/providerSource.js'
import { ResidentOmpPool } from '../../../packages/node/src/host/residentOmp.js'
import { OmpResidentTurnPort } from '@qianmo/resident'

export const NODE = 'node-b'
export async function providerConsole() {
  const f = isolatedRoot()
  let skew = 0
  const spec = sourceLaunch(
    ['provider', 'serve-stdin', '--node', NODE],
    childEnv({ QIANMO_CONFIG_DIR: f.root }),
  )
  const wrapper = join(f.root, 'node.mjs')
  writeFileSync(
    wrapper,
    `import {spawnSync} from 'node:child_process';const spec=${JSON.stringify(spec)};const run=spawnSync(spec.execPath,spec.args,{stdio:'inherit',env:spec.env});process.exit(run.status??2)`,
  )
  const command = join(f.root, 'node.sh')
  writeFileSync(command, `#!/bin/sh\nexec '${process.execPath}' '${wrapper}'\n`)
  chmodSync(command, 0o700)
  const port = openConsoleProviders({
    storePath: join(f.root, 'hub', 'providers.ndjson'),
    secretsPath: join(f.root, 'hub', 'secrets.json'),
    keyPath: join(f.root, 'hub-key', 'master.key'),
    knownHostsFile: join(f.root, 'known_hosts'),
    nodes: [{ node: NODE, kind: 'local', command }],
    onAlarm: () => {},
    now: () => Date.now() + skew,
    scheduler: { set: () => null, clear: () => {} },
  })
  const ledger = new ActionLedger({ store: new MemoryActionStore() })
  class Clock extends ManualClock {
    override now = () => Date.now()
  }
  const { handle } = accountsHarness({
    clock: new Clock(),
    deps: { providers: port, actions: ledger },
  })
  const ops = await person(handle, 'ops')
  function req(method: string, path: string, body?: unknown) {
    return asSession(method, path, ops.sid, body === undefined ? {} : { body })
  }
  async function call<T = Record<string, unknown>>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const response = await handle(req(method, path, body))
    const text = await response.text()
    if (response.status !== 200) throw new Error(`${response.status}: ${text}`)
    return (
      (response.headers.get('content-type') ?? '').includes('json')
        ? JSON.parse(text)
        : text
    ) as T
  }
  const workspace = join(f.root, 'workspace')
  mkdirSync(workspace)
  const pools: ResidentOmpPool[] = []
  async function turn(text: string) {
    const pool = new ResidentOmpPool({
      agents: [{ agent: 'reviewer', cwd: workspace }],
      memoryRoot: join(f.root, 'memory'),
      announce: async () => ({ status: 'queued' }),
    })
    pools.push(pool)
    const sessionId = await pool.newSession({
      agent: 'reviewer',
      cwd: workspace,
    })
    return new OmpResidentTurnPort(pool, {
      inactivity: { timeoutMs: 20000 },
    }).execute(
      { sessionId, messageId: `msg-${pools.length}`, prompt: text },
      async () => {},
    )
  }
  return {
    root: f.root,
    port,
    ledger,
    handle,
    req,
    call,
    turn,
    later() {
      skew += 10000
    },
    async dispose() {
      await Promise.all(pools.map(p => p.stop()))
      port.stop()
      f.dispose()
    },
  }
}
export function draft(baseUrl: string, keys = 1) {
  return {
    id: 'local-chat',
    name: 'Local chat',
    lane: 'openai-chat',
    baseUrl,
    auth: { scheme: 'bearer' },
    keys: Array.from({ length: keys }, (_, i) => ({ id: `k${i + 1}` })),
    models: [
      {
        id: 'page-test-model',
        role: 'main',
        tiers: ['sonnet'],
        capabilities: {
          mode: 'explicit',
          thinking: false,
          adaptive_thinking: false,
          interleaved_thinking: false,
        },
        effort: { send: 'never' },
      },
    ],
    compat: {},
    evaluated: false,
  }
}
