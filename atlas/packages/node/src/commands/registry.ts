// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  FileRegistryStore,
  FileRevocationListStore,
  InMemoryRegistry,
  PostgresRegistry,
  defaultRegistryStatePath,
  readRegistryWriteTokenFile,
  revocationListStatePathFor,
  startRegistryServer,
} from '@qianmo/registry'

const HELP = `Usage: qm registry [options]
  --port <number>                default 38620
  --host <address>               default 127.0.0.1
  --write-token-file <path>      required, protected write credential
  --state <path>                 local durable state (single process)
  --database-url-file <path>     PostgreSQL URL; enables shared HA storage
  --namespace <name>             shared PostgreSQL registry (default: default)

Use multiple API replicas with the same PostgreSQL namespace and token.
Database failover is provided by the PostgreSQL deployment.
`

export async function run(argv: string[]): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(HELP)
    return 0
  }
  const allowed = new Set([
    'port',
    'host',
    'write-token-file',
    'state',
    'database-url-file',
    'namespace',
  ])
  const options = new Map<string, string>()
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.slice(2) ?? ''
    const value = argv[i + 1]
    if (
      !argv[i]?.startsWith('--') ||
      !allowed.has(key) ||
      !value ||
      value.startsWith('--') ||
      options.has(key)
    ) {
      throw new Error('invalid registry option (run qm registry --help)')
    }
    options.set(key, value)
  }
  const port = Number(options.get('port') ?? '38620')
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error('invalid registry port')
  const tokenPath = options.get('write-token-file')
  if (!tokenPath) throw new Error('--write-token-file is required')
  const writeToken = readRegistryWriteTokenFile(tokenPath, '--write-token-file')
  const hostname = options.get('host') ?? '127.0.0.1'
  const databasePath = options.get('database-url-file')
  let stop: () => Promise<void>
  let boundPort: number
  if (databasePath) {
    if (options.has('state'))
      throw new Error('--state cannot be combined with PostgreSQL')
    const databaseUrl = readRegistryWriteTokenFile(
      databasePath,
      '--database-url-file',
    )
    const database = new PostgresRegistry({
      databaseUrl,
      writeToken,
      namespace: options.get('namespace'),
    })
    try {
      await database.initialize()
    } catch {
      await database.close()
      throw new Error(
        'registry database initialization failed; check connection and schema',
      )
    }
    let server: ReturnType<typeof Bun.serve>
    try {
      server = Bun.serve({
        hostname,
        port,
        idleTimeout: 10,
        maxRequestBodySize: 1024 * 1024,
        fetch: request => database.fetch(request),
      })
    } catch (error) {
      await database.close()
      throw error
    }
    boundPort = server.port ?? port
    stop = async () => {
      await server.stop()
      await database.close()
    }
  } else {
    if (options.has('namespace'))
      throw new Error('--namespace requires PostgreSQL')
    const state = options.get('state') ?? defaultRegistryStatePath()
    const server = startRegistryServer(port, {
      hostname,
      writeToken,
      registry: new InMemoryRegistry({
        store: new FileRegistryStore(state),
        revocationListStore: new FileRevocationListStore(
          revocationListStatePathFor(state),
        ),
      }),
    })
    boundPort = server.port
    stop = () => server.stop()
  }
  let stopping = false
  const shutdown = () => {
    if (stopping) return
    stopping = true
    void stop().then(
      () => {
        process.off('SIGINT', shutdown)
        process.off('SIGTERM', shutdown)
      },
      () => {
        process.exitCode = 1
      },
    )
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
  process.stdout.write(
    `registry listening on ${hostname}:${boundPort} (${databasePath ? 'postgres' : 'file'})\n`,
  )
  return 0
}
