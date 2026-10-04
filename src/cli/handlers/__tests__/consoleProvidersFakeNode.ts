// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * A stand-in for a node's `qm provider serve-stdin`, and for `ssh`, as real
 * executables in a temp directory. The hub's executor runs them as child
 * processes exactly as it runs the real ones; only the JSON shapes of P18.7
 * are assumed (the hub depends on nothing else).
 *
 * The fake node records every request line it reads (`requests.ndjson`), the
 * argv and environment names it was started with (`argv.ndjson`), and the
 * span it was busy (`spans.ndjson`). Its answers can be steered by files in
 * its directory: `reply-<op>.json` (a fixed reply; `requestId` is filled in),
 * `raw-<op>` (raw stdout and an exit code, for protocol violations),
 * `delay-ms`, `pending` (apply stages instead of committing), `strict-expect`
 * (apply checks `expect.ownedHash` like a real node), `multi-key` (reports
 * `capabilities.multiKey`, P18.18).
 *
 * The fake ssh writes its argv (NUL-separated) and its stdin to files, then
 * plays sshd: with a `forced-command` file it runs that command with
 * `SSH_ORIGINAL_COMMAND` set to the client command; without one it runs the
 * client command itself, which for the hub is the sentinel and fails 127.
 */

import {
  chmodSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

const FAKE_NODE = String.raw`
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

const [dir, node, ...rest] = process.argv.slice(2)
const started = Date.now()
let input = ''
for await (const chunk of process.stdin) {
  input += chunk
  if (input.includes('\n')) break
}
const line = input.split('\n')[0]
appendFileSync(join(dir, 'requests.ndjson'), line + '\n')
appendFileSync(
  join(dir, 'argv.ndjson'),
  JSON.stringify({ node, rest, env: Object.keys(process.env).sort() }) + '\n',
)
const request = JSON.parse(line)
const op = request.op
const delay = existsSync(join(dir, 'delay-ms'))
  ? Number(readFileSync(join(dir, 'delay-ms'), 'utf8'))
  : 0
if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay))
appendFileSync(
  join(dir, 'spans.ndjson'),
  JSON.stringify({ node, op, start: started, end: Date.now() }) + '\n',
)

function answer(reply) {
  process.stdout.write(JSON.stringify(reply) + '\n')
  process.exit(reply.ok ? 0 : 1)
}

const raw = join(dir, 'raw-' + op)
if (existsSync(raw)) {
  const [code, ...body] = readFileSync(raw, 'utf8').split('\n')
  process.stdout.write(body.join('\n'))
  process.exit(Number(code))
}
const fixed = join(dir, 'reply-' + op + '.json')
if (existsSync(fixed)) {
  const reply = JSON.parse(readFileSync(fixed, 'utf8'))
  if (reply.requestId !== null) reply.requestId = request.requestId
  answer(reply)
}

const statePath = join(dir, 'node-state.json')
const saved = existsSync(statePath)
  ? JSON.parse(readFileSync(statePath, 'utf8'))
  : { applied: null, appliedHash: null, pending: null, context: null }
const EMPTY = 'sha256:' + '0'.repeat(64)
function state() {
  return {
    managed: saved.applied !== null,
    applied: saved.applied,
    onDiskHash: saved.appliedHash ?? EMPTY,
    appliedHash: saved.appliedHash,
    loadedHash: saved.appliedHash,
    pending: saved.pending,
    resident: { running: false, generation: null, inFlight: null },
    inheritedProviderKeys: [],
    capabilities: {
      protocol: 1,
      chatEffortHonorsOverride: false,
      replayFilter: false,
      multiKey: existsSync(join(dir, 'multi-key')),
    },
    lastResult: null,
  }
}
const base = { v: 1, requestId: request.requestId }

if (op === 'status') {
  answer({
    ...base,
    ok: true,
    state: state(),
    effective: {
      apiProvider: 'openai',
      wire: 'responses',
      model: 'vendor-model-pro',
      wireModel: 'vendor-model-pro',
      modelSettingsSlot: 'default',
      effortOnWire: true,
      effortLevel: 'max',
      contextTokens: saved.context ?? 200000,
      autoCompactWindow: 180000,
      autoCompactSource: 'settings',
    },
  })
}
if (op === 'apply') {
  if (request.dryRun) {
    answer({ ...base, ok: true, diffKeys: ['OPENAI_MODEL', 'OPENAI_API_KEY'] })
  }
  if (existsSync(join(dir, 'strict-expect')) && !request.force) {
    const expected = request.expect.ownedHash
    const managed = saved.applied !== null
    if ((expected === null && managed) || (expected !== null && expected !== saved.appliedHash)) {
      answer({ ...base, ok: false, code: 'conflict', message: '节点上的受管键在上次下发后被改过', diffKeys: ['OPENAI_BASE_URL'] })
    }
  }
  const main = request.profile.models.find(model => model.role === 'main')
  const hash = 'sha256:' + createHash('sha256')
    .update(JSON.stringify(request.profile.models) + request.profile.baseUrl)
    .digest('hex')
  const at = new Date().toISOString()
  const applied = {
    profileId: request.profile.id,
    revision: request.profile.revision,
    requestId: request.requestId,
    at,
  }
  if (existsSync(join(dir, 'pending'))) {
    saved.pending = { requestId: request.requestId, since: at, waitingTurns: 1 }
    saved.next = { applied, appliedHash: hash, context: main?.contextTokens ?? null }
  } else {
    saved.applied = applied
    saved.appliedHash = hash
    saved.context = main?.contextTokens ?? null
  }
  writeFileSync(statePath, JSON.stringify(saved))
  answer({ ...base, ok: true, state: state() })
}
if (op === 'probe') {
  answer({ ...base, ok: true, reachable: true, message: '密钥可用', httpStatus: 200 })
}
if (op === 'models') {
  answer({ ...base, ok: true, reachable: true, message: '可用', models: [{ id: 'm-1' }, { id: 'm-2' }] })
}
if (op === 'autocompact') {
  const value = request.value
  answer({
    ...base,
    ok: true,
    autoCompactWindow: typeof value === 'number' ? value : 200000,
    configured: typeof value === 'number' ? value : 200000,
    source: value === undefined || value === 'auto' ? 'auto' : 'settings',
    message: 'Auto-compact window set',
  })
}
answer({ ...base, ok: false, code: 'unsupported-op', message: '不支持的操作' })
`

const FAKE_SSH = `#!/bin/bash
dir="$FAKE_SSH_DIR_PLACEHOLDER"
stamp="$$-$RANDOM"
printf '%s\\0' "$@" > "$dir/ssh-argv-$stamp"
last="\${@: -1}"
if [ -f "$dir/forced-command" ]; then
  export SSH_ORIGINAL_COMMAND="$last"
  # shellcheck disable=SC2046
  exec $(cat "$dir/forced-command")
fi
exec /bin/sh -c "$last"
`

export interface FakeNode {
  readonly dir: string
  /** Executable: `<command> <node>` is what the local executor runs. */
  readonly command: string
  requests(): Record<string, unknown>[]
  argv(): { node: string; rest: string[]; env: string[] }[]
  spans(): { node: string; op: string; start: number; end: number }[]
  /** A file that steers the next answers (see the module note). */
  set(name: string, content: string): void
}

function lines(path: string): string[] {
  try {
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter(line => line !== '')
  } catch {
    return []
  }
}

/** A fake node under `dir` (created if needed). */
export function fakeNode(dir: string): FakeNode {
  mkdirSync(dir, { recursive: true })
  const script = join(dir, 'fake-node.mjs')
  writeFileSync(script, FAKE_NODE)
  const command = join(dir, 'fake-node.sh')
  writeFileSync(
    command,
    `#!/bin/sh\nexec '${process.execPath}' '${script}' '${dir}' "$@"\n`,
  )
  chmodSync(command, 0o755)
  return {
    dir,
    command,
    requests: () =>
      lines(join(dir, 'requests.ndjson')).map(
        line => JSON.parse(line) as Record<string, unknown>,
      ),
    argv: () =>
      lines(join(dir, 'argv.ndjson')).map(
        line =>
          JSON.parse(line) as { node: string; rest: string[]; env: string[] },
      ),
    spans: () =>
      lines(join(dir, 'spans.ndjson')).map(
        line =>
          JSON.parse(line) as {
            node: string
            op: string
            start: number
            end: number
          },
      ),
    set: (name, content) => writeFileSync(join(dir, name), content),
  }
}

interface FakeSsh {
  readonly binary: string
  readonly dir: string
  /** Every argv the fake ssh was started with, in no particular order. */
  invocations(): string[][]
  /** Make it play sshd with this forced command (`null`: the line is gone). */
  forcedCommand(command: string | null): void
}

export function fakeSsh(dir: string): FakeSsh {
  mkdirSync(dir, { recursive: true })
  const binary = join(dir, 'ssh')
  writeFileSync(binary, FAKE_SSH.replace('$FAKE_SSH_DIR_PLACEHOLDER', dir))
  chmodSync(binary, 0o755)
  return {
    binary,
    dir,
    invocations: () =>
      readdirSync(dir)
        .filter(name => name.startsWith('ssh-argv-'))
        .map(name =>
          readFileSync(join(dir, name), 'utf8')
            .split('\0')
            .filter(
              (part, index, all) => index < all.length - 1 || part !== '',
            ),
        ),
    forcedCommand: command => {
      const path = join(dir, 'forced-command')
      if (command === null) {
        rmSync(path, { force: true })
        return
      }
      writeFileSync(path, command)
    },
  }
}
