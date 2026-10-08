// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * A recording model-vendor stub for the `qm provider` suites (design
 * `providers-console-m1.md` §8.2): a loopback `Bun.serve` that answers each
 * path the way a test scripts it and records every request it got — method,
 * path, the credential headers and the body. It is not a vendor; it shows what
 * this side sent and how this side read the answer.
 */

export type StubRequest = {
  readonly method: string
  readonly path: string
  readonly authorization: string | null
  readonly apiKey: string | null
  readonly googKey: string | null
  readonly anthropicVersion: string | null
  readonly body: unknown
}

type Answer = (request: Request) => Response | Promise<Response>

export class RecordingStub {
  readonly requests: StubRequest[] = []
  readonly #routes = new Map<string, Answer>()
  readonly #server: ReturnType<typeof Bun.serve>

  constructor() {
    this.#server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: async request => {
        const url = new URL(request.url)
        let body: unknown
        try {
          body = await request.clone().json()
        } catch {
          body = undefined
        }
        this.requests.push({
          method: request.method,
          path: url.pathname,
          authorization: request.headers.get('authorization'),
          apiKey: request.headers.get('x-api-key'),
          googKey: request.headers.get('x-goog-api-key'),
          anthropicVersion: request.headers.get('anthropic-version'),
          body,
        })
        const answer =
          this.#routes.get(`${request.method} ${url.pathname}`) ??
          this.#routes.get(url.pathname)
        return answer === undefined
          ? Response.json({ error: { message: 'no route' } }, { status: 404 })
          : answer(request)
      },
    })
  }

  /** `http://127.0.0.1:<port>` */
  get origin(): string {
    return `http://127.0.0.1:${String(this.#server.port)}`
  }

  /** Answer `path` (optionally `METHOD path`) with `answer`. */
  on(path: string, answer: Answer): this {
    this.#routes.set(path, answer)
    return this
  }

  paths(): string[] {
    return this.requests.map(request => request.path)
  }

  async stop(): Promise<void> {
    await this.#server.stop(true)
  }
}

/** A loopback port nothing listens on: connecting to it is refused. */
export async function refusedOrigin(): Promise<string> {
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: () => new Response(''),
  })
  const port = server.port
  await server.stop(true)
  return `http://127.0.0.1:${String(port)}`
}
