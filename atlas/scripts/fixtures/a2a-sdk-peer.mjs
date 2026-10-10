// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Independent official SDK process. Dependencies are installed in a caller-owned tools directory. */
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
const require = createRequire(`${process.env.QIANMO_A2A_SDK_ROOT}/package.json`)
const load = async name => import(pathToFileURL(require.resolve(name)).href)
const { AgentCard, Task, SendMessageRequest } = await load('@a2a-js/sdk')
if (
  JSON.parse(
    readFileSync(
      require
        .resolve('@a2a-js/sdk')
        .replace(/dist\/index\.(?:js|cjs)$/, 'package.json'),
      'utf8',
    ),
  ).version !== '1.3.0'
)
  throw new Error('Interop evidence pins @a2a-js/sdk 1.3.0')
const token = process.env.QIANMO_A2A_TEST_TOKEN
if (!token) throw new Error('test credential required')
if (process.argv[2] === 'client') {
  const { ClientFactory, RestTransportFactory, DefaultAgentCardResolver } =
    await load('@a2a-js/sdk/client')
  const authFetch = (url, init = {}) =>
    fetch(url, {
      ...init,
      headers: {
        ...Object.fromEntries(new Headers(init.headers)),
        Authorization: `Bearer ${token}`,
      },
    })
  const client = await new ClientFactory({
    transports: [new RestTransportFactory({ fetchImpl: authFetch })],
    cardResolver: new DefaultAgentCardResolver({ fetchImpl: authFetch }),
  }).createFromUrl(process.argv[3])
  const result = await client.sendMessage(
    SendMessageRequest.fromJSON(
      JSON.parse(await new Response(Bun.stdin).text()),
    ),
  )
  console.log(JSON.stringify(Task.toJSON(result)))
} else {
  const express = (await load('express')).default
  const { DefaultRequestHandler, InMemoryTaskStore, AgentEvent } =
    await load('@a2a-js/sdk/server')
  const { restHandler, agentCardHandler } = await load(
    '@a2a-js/sdk/server/express',
  )
  const card = AgentCard.fromJSON({
    name: 'Independent SDK code reviewer',
    description:
      'Deterministic source and test report review, no model quality claim',
    version: '1.0.0',
    supportedInterfaces: [
      {
        url: 'http://127.0.0.1:1',
        protocolBinding: 'HTTP+JSON',
        protocolVersion: '1.0',
      },
    ],
    capabilities: { streaming: false, pushNotifications: false },
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    skills: [
      {
        id: 'review',
        name: 'Review',
        description: 'Validate a coding artifact and its test report',
        tags: ['coding', 'review'],
      },
    ],
  })
  const executor = {
    async execute(context, bus) {
      const request = SendMessageRequest.toJSON(context.request)
      const text = request.message.parts.map(part => part.text).join('\n')
      const input = JSON.parse(text)
      const sourceHash = createHash('sha256').update(input.source).digest('hex')
      const passed =
        input.operation === 'review' &&
        sourceHash === input.sha256 &&
        input.testsPassed === 5 &&
        input.source.includes('export function slugify')
      const review = {
        operation: 'review',
        passed,
        sourceHash,
        reviewer: 'official-sdk-independent-process',
        checks: ['source hash', 'export contract', 'test report count'],
      }
      bus.publish(
        AgentEvent.task(
          Task.fromJSON({
            id: context.taskId,
            contextId: context.contextId,
            status: { state: 'TASK_STATE_COMPLETED' },
            artifacts: [
              {
                artifactId: crypto.randomUUID(),
                parts: [{ text: JSON.stringify(review) }],
              },
            ],
          }),
        ),
      )
      bus.finished()
    },
    async cancelTask() {
      throw new Error('unsupported')
    },
  }
  const handler = new DefaultRequestHandler(
    card,
    new InMemoryTaskStore(),
    executor,
  )
  const app = express()
  app.use((req, res, next) =>
    req.headers.authorization === `Bearer ${token}`
      ? next()
      : res.status(401).end(),
  )
  app.use(express.json({ type: ['application/json', 'application/a2a+json'] }))
  app.use(
    '/.well-known/agent-card.json',
    agentCardHandler({ agentCardProvider: handler }),
  )
  app.use(
    restHandler({
      requestHandler: handler,
      userBuilder: async () => ({
        isAuthenticated: true,
        userName: 'qianmo-test',
      }),
    }),
  )
  const server = app.listen(0, '127.0.0.1', () => {
    card.supportedInterfaces[0].url = `http://127.0.0.1:${server.address().port}`
    console.log(JSON.stringify({ url: card.supportedInterfaces[0].url }))
  })
  process.once('SIGTERM', () => server.close())
}
