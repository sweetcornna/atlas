// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/** AC-1: two turns, SIGKILL during a third, then resume without replaying history.
 * A loopback provider derives its reply from the actual transmitted conversation.
 * This verifies persistence and request construction; it is not a live-model evaluation. */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ompArgv } from '@qianmo/node/omp/launch.js'
import { ompChildEnv } from '@qianmo/paths'
const root = mkdtempSync(join(tmpdir(), 'qm-ac1-resume-'))
const workspace = join(root, 'workspace')
const config = join(root, 'config')
const agentDir = join(config, 'omp', 'agent')
mkdirSync(workspace, { recursive: true })
mkdirSync(agentDir, { recursive: true })
let session: string | undefined
const sessionDir = join(root, 'sessions')
mkdirSync(sessionDir)
const secret = `QM_LATCH_${crypto.randomUUID().replaceAll('-', '')}=4917`
let hangStarted: (() => void) | undefined
const requests: { role: string; content?: unknown }[][] = []
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(req) {
    const request = (await req.json()) as {
      messages: { role: string; content?: unknown }[]
    }
    requests.push(request.messages)
    const last = JSON.stringify(request.messages.at(-1)?.content)
    if (last.includes('crash-point')) {
      hangStarted?.()
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(': waiting\n\n'))
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      )
    }
    const history = JSON.stringify(request.messages.slice(0, -1))
    const reply = last.includes('continue-without-replay')
      ? history.includes(secret)
        ? secret
        : 'MISSING_HISTORY'
      : 'remembered'
    const base = {
      id: 'chatcmpl-ac1',
      object: 'chat.completion.chunk',
      created: 0,
      model: 'ac1',
    }
    const chunks = [
      {
        ...base,
        choices: [
          {
            index: 0,
            delta: { role: 'assistant', content: reply },
            finish_reason: null,
          },
        ],
      },
      { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    ]
    return new Response(
      chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') +
        'data: [DONE]\n\n',
      { headers: { 'content-type': 'text/event-stream' } },
    )
  },
})
writeFileSync(
  join(agentDir, 'models.yml'),
  JSON.stringify({
    providers: {
      ac1: {
        baseUrl: `http://127.0.0.1:${server.port}/v1`,
        auth: 'none',
        api: 'openai-completions',
        models: [{ id: 'ac1', name: 'AC1', reasoning: false }],
      },
    },
  }),
)
const repo = resolve(import.meta.dir, '../..')
const binary = join(repo, 'dist', `qm-${process.platform}-${process.arch}`)
const qm = process.env.AC1_QM_BINARY
  ? [process.env.AC1_QM_BINARY, 'agent']
  : existsSync(binary)
    ? [binary, 'agent']
    : ompArgv([])
function launch(prompt: string) {
  return Bun.spawn(
    [
      ...qm,
      '--print',
      '--mode',
      'json',
      '--no-tools',
      '--no-extensions',
      '--model',
      'ac1/ac1',
      '--session-dir',
      sessionDir,
      ...(session ? ['--session', session] : []),
      prompt,
    ],
    {
      cwd: workspace,
      env: ompChildEnv({
        PATH: process.env.PATH,
        HOME: join(root, 'home'),
        QIANMO_CONFIG_DIR: config,
        PI_TEST_RUNTIME: '1',
        NO_COLOR: '1',
      }),
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 30000,
    },
  )
}
async function turn(prompt: string): Promise<string> {
  const child = launch(prompt)
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (code !== 0) throw new Error(`qm agent exited ${code}: ${err}`)
  session ??= readdirSync(sessionDir)
    .filter(file => file.endsWith('.jsonl'))
    .map(file => join(sessionDir, file))[0]
  return out
}
function id(): string | undefined {
  for (const line of readFileSync(session!, 'utf8')
    .split('\n')
    .filter(Boolean)) {
    const entry = JSON.parse(line) as { type?: string; id?: string }
    if (entry.type === 'session') return entry.id
  }
}
try {
  await turn(`Remember this run-specific fact: ${secret}`)
  await turn('Keep that exact fact in this conversation.')
  const before = id()
  const started = new Promise<void>(resolve => {
    hangStarted = resolve
  })
  const crash = launch('crash-point: start the long explanation')
  const out = new Response(crash.stdout).text()
  const err = new Response(crash.stderr).text()
  await Promise.race([
    started,
    crash.exited.then(code => {
      throw new Error(`Crash turn exited early: ${code}`)
    }),
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error('Crash turn never reached provider')),
        15000,
      ),
    ),
  ])
  crash.kill('SIGKILL')
  await crash.exited
  await Promise.all([out, err])
  const answer = await turn(
    'continue-without-replay: return the exact fact remembered earlier',
  )
  const after = id()
  const lastPrompt = JSON.stringify(requests.at(-1)?.at(-1))
  const result = {
    ac: 'AC-1',
    provider: 'loopback-scripted',
    liveModelEvaluated: false,
    sessionIdPreserved: before !== undefined && before === after,
    noPromptReplay: !lastPrompt.includes(secret),
    recoveredFact: answer.includes(secret),
    crashReachedProvider: requests.length >= 4,
    sessionId: after,
    evidence: root,
  }
  const pass =
    result.sessionIdPreserved &&
    result.noPromptReplay &&
    result.recoveredFact &&
    result.crashReachedProvider
  writeFileSync(
    join(root, 'result.json'),
    JSON.stringify({ ...result, pass }, null, 2),
  )
  console.log(JSON.stringify({ ...result, pass }, null, 2))
  if (!pass) process.exitCode = 1
} finally {
  server.stop(true)
}
