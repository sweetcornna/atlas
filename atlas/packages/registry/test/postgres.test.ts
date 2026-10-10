// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { SQL } from 'bun'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PostgresRegistry } from '../src/postgres.js'

const token = 'local-registry-test-write-token'
const databaseUrl = process.env.ATLAS_TEST_REGISTRY_DATABASE_URL
const namespace = `test_${randomUUID().replaceAll('-', '')}`
const clients: PostgresRegistry[] = []
const servers: ReturnType<typeof Bun.serve>[] = []

test('HA configuration rejects missing auth and invalid URLs without leaking them', () => {
  expect(
    () =>
      new PostgresRegistry({
        databaseUrl: 'postgres://localhost/test',
        writeToken: '',
      }),
  ).toThrow('at least')
  expect(
    () =>
      new PostgresRegistry({
        databaseUrl: 'SECRET-password',
        writeToken: token,
      }),
  ).toThrow('registry database URL is invalid')
  expect(
    () =>
      new PostgresRegistry({
        databaseUrl: 'sqlite://localhost/test',
        writeToken: token,
      }),
  ).toThrow('PostgreSQL')
})

describe.skipIf(!databaseUrl)('shared registry with real PostgreSQL', () => {
  beforeAll(async () => {
    for (let i = 0; i < 2; i++) {
      const client = new PostgresRegistry({
        databaseUrl: databaseUrl ?? '',
        namespace,
        writeToken: token,
      })
      await client.initialize()
      clients.push(client)
      servers.push(
        Bun.serve({
          port: 0,
          hostname: '127.0.0.1',
          fetch: request => client.fetch(request),
        }),
      )
    }
  })
  afterAll(async () => {
    for (const server of servers) await server.stop(true)
    for (const client of clients) await client.close()
    const sql = new SQL(databaseUrl ?? '')
    await sql`DELETE FROM qianmo_registry_state WHERE namespace = ${namespace}`
    await sql.close()
  })

  const url = (index: number) => `http://127.0.0.1:${servers[index]?.port}`
  const register = (
    index: number,
    name: string,
    endpoint = `wss://${name}.example.test/agent`,
  ) =>
    fetch(`${url(index)}/v0/agents`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ address: `qianmo://${name}/worker`, endpoint }),
    })

  test('concurrent replicas retain every registration and conflict on duplicate ownership', async () => {
    const responses = await Promise.all(
      Array.from({ length: 32 }, (_, i) => register(i % 2, `worker-${i}`)),
    )
    expect(responses.every(response => response.status === 201)).toBe(true)
    const list = (await (await fetch(`${url(1)}/v0/agents`)).json()) as {
      agents: unknown[]
    }
    expect(list.agents).toHaveLength(32)
    const competing = await Promise.all([
      register(0, 'contended', 'wss://first.example.test/a'),
      register(1, 'contended', 'wss://second.example.test/a'),
    ])
    expect(competing.map(response => response.status).sort()).toEqual([
      201, 409,
    ])
  })

  test('authentication and bounded bodies fail without changing state', async () => {
    const refused = await fetch(`${url(0)}/v0/agents`, {
      method: 'POST',
      body: 'not json',
    })
    expect(refused.status).toBe(401)
    const large = await fetch(`${url(0)}/v0/agents`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: 'x'.repeat(1024 * 1024 + 1),
    })
    expect(large.status).toBe(413)
    expect((await fetch(`${url(0)}/v0/health`)).status).toBe(200)
  })

  test('delete on one replica is immediately visible on the other', async () => {
    expect((await register(0, 'delete-me')).status).toBe(201)
    const path = `/v0/agents/${encodeURIComponent('qianmo://delete-me/worker')}`
    expect(
      (
        await fetch(`${url(1)}${path}`, {
          method: 'DELETE',
          headers: { authorization: `Bearer ${token}` },
        })
      ).status,
    ).toBe(204)
    expect((await fetch(`${url(0)}${path}`)).status).toBe(404)
  })

  test('revocation state survives a new replica and expired leases cannot revive', async () => {
    const revocation = { payload: 'cGF5bG9hZA', signature: 'c2ln' }
    expect(
      (
        await fetch(`${url(1)}/v0/revocation-list`, {
          method: 'PUT',
          headers: { authorization: `Bearer ${token}` },
          body: JSON.stringify(revocation),
        })
      ).status,
    ).toBe(200)
    const restarted = new PostgresRegistry({
      databaseUrl: databaseUrl ?? '',
      namespace,
      writeToken: token,
    })
    clients.push(restarted)
    await restarted.initialize()
    expect(
      await (
        await restarted.fetch(
          new Request('http://localhost/v0/revocation-list'),
        )
      ).json(),
    ).toEqual(revocation)
    expect((await register(1, 'expired')).status).toBe(201)
    const sql = new SQL(databaseUrl ?? '')
    try {
      const [row] =
        await sql`SELECT agents FROM qianmo_registry_state WHERE namespace = ${namespace}`
      for (const agent of row.agents.agents) {
        if (agent.address === 'qianmo://expired/worker')
          agent.lastHeartbeatAt = 1
      }
      await sql`UPDATE qianmo_registry_state SET agents = ${row.agents}::jsonb WHERE namespace = ${namespace}`
      const path = `/v0/agents/${encodeURIComponent('qianmo://expired/worker')}`
      expect(
        (await restarted.fetch(new Request(`http://localhost${path}`))).status,
      ).toBe(404)
      expect(
        (
          await restarted.fetch(
            new Request(`http://localhost${path}/heartbeat`, {
              method: 'POST',
              headers: { authorization: `Bearer ${token}` },
            }),
          )
        ).status,
      ).toBe(404)
    } finally {
      await sql.close()
    }
  })

  test('real qm registry process can be killed without losing committed state', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'qm-registry-process-'))
    const tokenFile = join(directory, 'token')
    const databaseFile = join(directory, 'database')
    writeFileSync(tokenFile, token, { mode: 0o600 })
    writeFileSync(databaseFile, databaseUrl ?? '', { mode: 0o600 })
    const process = Bun.spawn(
      [
        Bun.which('bun') ?? 'bun',
        resolve(import.meta.dir, '../../node/src/cli.ts'),
        'registry',
        '--port',
        '0',
        '--write-token-file',
        tokenFile,
        '--database-url-file',
        databaseFile,
        '--namespace',
        namespace,
      ],
      {
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
    const reader = process.stdout.getReader()
    const deadline = setTimeout(() => process.kill('SIGKILL'), 10_000)
    try {
      const first = await reader.read()
      const line = new TextDecoder().decode(first.value)
      const port = /listening on 127\.0\.0\.1:(\d+)/.exec(line)?.[1]
      expect(port).toBeDefined()
      const response = await fetch(`http://127.0.0.1:${port}/v0/agents`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({
          address: 'qianmo://killed-process/worker',
          endpoint: 'wss://process.example.test',
        }),
      })
      expect(response.status).toBe(201)
      process.kill('SIGKILL')
      await process.exited
      const path = `/v0/agents/${encodeURIComponent('qianmo://killed-process/worker')}`
      expect((await fetch(`${url(1)}${path}`)).status).toBe(200)
    } finally {
      clearTimeout(deadline)
      reader.releaseLock()
      process.kill('SIGKILL')
      await process.exited
      rmSync(directory, { recursive: true, force: true })
    }
  }, 15_000)

  test('stopping one API instance leaves its committed rows on the other', async () => {
    expect((await register(0, 'before-stop')).status).toBe(201)
    await servers[0]?.stop(true)
    await clients[0]?.close()
    const path = `/v0/agents/${encodeURIComponent('qianmo://before-stop/worker')}`
    expect((await fetch(`${url(1)}${path}`)).status).toBe(200)
    expect((await register(1, 'after-stop')).status).toBe(201)
    const restarted = new PostgresRegistry({
      databaseUrl: databaseUrl ?? '',
      namespace,
      writeToken: token,
    })
    await restarted.initialize()
    clients.push(restarted)
    expect(
      (await restarted.fetch(new Request(`http://localhost${path}`))).status,
    ).toBe(200)
  })

  test('schema drift or storage loss fails closed, not from process cache', async () => {
    const sql = new SQL(databaseUrl ?? '')
    try {
      await sql`UPDATE qianmo_registry_state SET schema_version = 999 WHERE namespace = ${namespace}`
      expect((await fetch(`${url(1)}/v0/health`)).status).toBe(503)
      await sql`UPDATE qianmo_registry_state SET schema_version = 1 WHERE namespace = ${namespace}`
      expect((await fetch(`${url(1)}/v0/health`)).status).toBe(200)
      await clients[1]?.close()
      expect(
        (await clients[1]?.fetch(new Request('http://localhost/v0/health')))
          ?.status,
      ).toBe(503)
    } finally {
      await sql.close()
    }
  })
})
