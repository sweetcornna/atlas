// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Starts a disposable loopback PostgreSQL, never the operator's cluster.
 * CI and verify use the same actual database tests. An explicit test URL may
 * target a dedicated external test database; rows use a random namespace.
 */
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'

const command = async (args: string[], env = process.env): Promise<void> => {
  const child = Bun.spawn(args, { env, stdout: 'inherit', stderr: 'inherit' })
  if ((await child.exited) !== 0) throw new Error(`${args[0]} failed`)
}

let url = process.env.ATLAS_TEST_REGISTRY_DATABASE_URL
let pgCtl: string | null = null
let data: string | null = null
try {
  if (!url) {
    const pgConfig = Bun.which('pg_config')
    const bindir = pgConfig
      ? (
          await new Response(Bun.spawn([pgConfig, '--bindir']).stdout).text()
        ).trim()
      : ''
    const binary = (name: string) =>
      Bun.which(name) ?? (bindir ? Bun.which(join(bindir, name)) : null)
    const initdb = binary('initdb')
    pgCtl = binary('pg_ctl')
    if (!initdb || !pgCtl)
      throw new Error(
        'PostgreSQL tools required (install PostgreSQL or set ATLAS_TEST_REGISTRY_DATABASE_URL to a dedicated test database)',
      )
    const root = mkdtempSync(join(tmpdir(), 'qm-registry-ha-'))
    data = join(root, 'data')
    const socket = join(root, 'socket')
    mkdirSync(socket)
    const port = await new Promise<number>((resolve, reject) => {
      const server = createServer()
      server.on('error', reject)
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        if (address === null || typeof address === 'string') {
          server.close()
          reject(new Error('no test port'))
          return
        }
        server.close(() => resolve(address.port))
      })
    })
    await command([
      initdb,
      '-D',
      data,
      '-A',
      'trust',
      '-U',
      'qm_registry_test',
      '--no-locale',
    ])
    // macOS postmaster refuses to start without a valid locale in the
    // environment ("postmaster became multithreaded during startup").
    await command(
      [
        pgCtl,
        '-D',
        data,
        '-l',
        join(root, 'postgres.log'),
        '-o',
        `-h 127.0.0.1 -p ${port} -k ${socket}`,
        '-w',
        'start',
      ],
      { ...process.env, LC_ALL: 'C' },
    )
    url = `postgres://qm_registry_test@127.0.0.1:${port}/postgres`
  }
  await command(
    [
      process.execPath,
      'test',
      '--preload',
      './atlas/tests/preload.ts',
      './atlas/packages/registry/test/postgres.test.ts',
    ],
    { ...process.env, ATLAS_TEST_REGISTRY_DATABASE_URL: url },
  )
} catch (error) {
  // Tool failures contain no production URL; the explicit URL is never logged.
  process.stderr.write(
    `${error instanceof Error ? error.message : 'registry HA verification failed'}\n`,
  )
  process.exitCode = 1
} finally {
  if (pgCtl && data) {
    const child = Bun.spawn([pgCtl, '-D', data, '-m', 'fast', '-w', 'stop'], {
      stdout: 'inherit',
      stderr: 'inherit',
    })
    if ((await child.exited) !== 0) process.exitCode = 1
  }
}
