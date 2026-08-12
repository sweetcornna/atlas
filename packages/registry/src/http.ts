// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: MIT

import {
  InMemoryRegistry,
  RegistryErrorCode,
  type AgentRecord,
  type RegisterResult,
} from './registry.js'

/** Prefix of every route in this API version. */
export const API_PREFIX = '/v0'

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
} as const

function json(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...JSON_HEADERS, ...headers },
  })
}

function fail(
  status: number,
  code: RegistryErrorCode,
  message: string,
  headers: Record<string, string> = {},
): Response {
  return json({ error: { code, message } }, status, headers)
}

function notFound(message: string): Response {
  return fail(404, RegistryErrorCode.E_NOT_FOUND, message)
}

function methodNotAllowed(allowed: readonly string[]): Response {
  return fail(
    405,
    RegistryErrorCode.E_BAD_REQUEST,
    `allowed methods: ${allowed.join(', ')}`,
    {
      allow: allowed.join(', '),
    },
  )
}

function agentBody(entry: AgentRecord): Record<string, unknown> {
  return {
    name: entry.name,
    endpoint: entry.endpoint,
    capabilities: entry.capabilities,
    registeredAt: entry.registeredAt,
    lastHeartbeatAt: entry.lastHeartbeatAt,
    expiresAt: entry.expiresAt,
  }
}

function statusFor(code: RegistryErrorCode): number {
  switch (code) {
    case RegistryErrorCode.E_BAD_REQUEST:
      return 400
    case RegistryErrorCode.E_CONFLICT:
      return 409
    case RegistryErrorCode.E_NOT_FOUND:
      return 404
  }
}

async function readJsonObject(
  request: Request,
): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = await request.json()
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
      return null
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

async function handleCollection(
  request: Request,
  registry: InMemoryRegistry,
): Promise<Response> {
  if (request.method === 'GET') {
    return json({ agents: registry.list().map(agentBody) })
  }
  if (request.method !== 'POST') {
    return methodNotAllowed(['GET', 'POST'])
  }

  const body = await readJsonObject(request)
  if (body === null) {
    return fail(
      400,
      RegistryErrorCode.E_BAD_REQUEST,
      'body must be a JSON object',
    )
  }

  const result: RegisterResult = registry.register(
    body['name'],
    body['endpoint'],
    body['capabilities'],
  )
  if (!result.ok) {
    return fail(statusFor(result.code), result.code, result.message)
  }
  return json(agentBody(result.entry), result.created ? 201 : 200)
}

function handleItem(
  request: Request,
  registry: InMemoryRegistry,
  name: string,
): Response {
  if (request.method === 'GET') {
    const entry = registry.resolve(name)
    return entry === null
      ? notFound(`no live agent named ${name}`)
      : json(agentBody(entry))
  }
  if (request.method === 'DELETE') {
    return registry.deregister(name)
      ? new Response(null, { status: 204 })
      : notFound(`no live agent named ${name}`)
  }
  return methodNotAllowed(['GET', 'DELETE'])
}

function handleHeartbeat(
  request: Request,
  registry: InMemoryRegistry,
  name: string,
): Response {
  if (request.method !== 'POST') return methodNotAllowed(['POST'])
  const entry = registry.heartbeat(name)
  return entry === null
    ? notFound(`no live agent named ${name}`)
    : json(agentBody(entry))
}

/**
 * Build the request handler for the registry HTTP API v0.
 *
 * Exposed separately from {@link startRegistryServer} so it can be exercised
 * with a plain `Request` object, without binding a port.
 */
export function createRegistryHandler(
  registry: InMemoryRegistry,
): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    const { pathname } = new URL(request.url)
    const segments = pathname.split('/').filter(s => s.length > 0)

    if (segments[0] !== 'v0') return notFound(`unknown path: ${pathname}`)

    if (segments.length === 2 && segments[1] === 'health') {
      if (request.method !== 'GET') return methodNotAllowed(['GET'])
      return json({ status: 'ok', agents: registry.size })
    }

    if (segments[1] !== 'agents') return notFound(`unknown path: ${pathname}`)

    if (segments.length === 2) return await handleCollection(request, registry)

    const name = decodeURIComponent(segments[2] ?? '')

    if (segments.length === 3) return handleItem(request, registry, name)
    if (segments.length === 4 && segments[3] === 'heartbeat') {
      return handleHeartbeat(request, registry, name)
    }
    return notFound(`unknown path: ${pathname}`)
  }
}

export interface RegistryServerOptions {
  /** Registry to serve; a fresh {@link InMemoryRegistry} by default. */
  readonly registry?: InMemoryRegistry
  readonly hostname?: string
}

/** Live server handle returned by {@link startRegistryServer}. */
export interface RegistryServerHandle {
  /** Port actually bound — meaningful when starting on port `0`. */
  readonly port: number
  /** Base URL, without a trailing slash. */
  readonly url: string
  readonly registry: InMemoryRegistry
  stop(): Promise<void>
}

/**
 * Start the registry HTTP API. Pass `0` to let the OS pick a free port and
 * read the real one back from the handle.
 */
export function startRegistryServer(
  port = 0,
  options: RegistryServerOptions = {},
): RegistryServerHandle {
  const registry = options.registry ?? new InMemoryRegistry()
  const hostname = options.hostname ?? '127.0.0.1'
  const server = Bun.serve({
    port,
    hostname,
    fetch: createRegistryHandler(registry),
  })

  return {
    // Bun types `Server.port` as `number | undefined` because unix-socket
    // servers have no port. This server always binds TCP, so it is a number.
    port: server.port as number,
    url: `http://${hostname}:${server.port}`,
    registry,
    stop: async (): Promise<void> => {
      await server.stop(true)
    },
  }
}
