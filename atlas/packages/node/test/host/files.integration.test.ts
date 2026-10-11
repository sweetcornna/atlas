// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type {
  ConsoleResult,
  DirectionActor,
  FileTransferView,
} from '@qianmo/console'
import {
  createMessage,
  LIMITS,
  messageBytes,
  MessageType,
  type ControlOutcome,
} from '@qianmo/protocol'
import { ConsoleFiles } from '../../src/commands/consoleFiles.js'
import type { HubCallHandler } from '../../src/commands/consoleControl.js'
import { NodeFiles } from '../../src/host/files.js'
import { residentToolVerdict } from '@qianmo/extension/policy'
import { FileDirectory } from '../../src/host/filesSafeFs.js'
import {
  exportContentRules,
  validateManifest,
  FILE_CHUNK_BYTES,
  FILE_LIMITS,
  manifestSha256,
  sha256,
  scopeContains,
} from '../../src/host/filesPolicy.js'

const actor: DirectionActor = {
  subject: 'legacy:admin',
  role: null,
  requestId: 'test-request',
}
const source = { node: 'alpha', agent: 'main' },
  target = { node: 'beta', agent: 'main' }
function value<T>(result: ConsoleResult<T>): T {
  if (!result.ok) throw new Error(result.failure.message)
  return result.value
}
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qm-files-'))
  const workspaces = new Map([
    ['alpha', path.join(root, 'alpha')],
    ['beta', path.join(root, 'beta')],
  ])
  for (const dir of workspaces.values()) fs.mkdirSync(dir)
  let handler: HubCallHandler,
    allowed = true,
    stopped = false,
    now = Date.now(),
    pace = 0
  let registered = true
  const audits: { node: string; kind: string; detail: unknown }[] = [],
    actions: string[] = []
  const calls: {
    node: string
    op: string
    args: Record<string, unknown>
    at: number
  }[] = []
  const hosts = new Map<string, NodeFiles>()
  let intercept:
    | ((
        node: string,
        op: string,
        args: Record<string, unknown>,
      ) => Promise<ControlOutcome | undefined>)
    | undefined
  for (const node of ['alpha', 'beta'])
    hosts.set(
      node,
      new NodeFiles({
        node,
        agents: () => [{ agent: 'main', cwd: workspaces.get(node)! }],
        directory: path.join(root, `state-${node}`),
        stopped: () => stopped,
        hub: {
          call: (op, args, options) =>
            handler(op, args, {
              node,
              callId: crypto.randomUUID(),
              ...(options?.agent ? { agent: options.agent } : {}),
            }),
        },
        audit: (kind, detail) => audits.push({ node, kind, detail }),
      }),
    )
  const control = {
    onHubCall(_prefix: string, next: HubCallHandler) {
      handler = next
    },
    status: () =>
      ['alpha', 'beta'].map(node => ({
        node,
        connected: true,
        lastConnectedAt: 1,
        lastError: null,
      })),
    async request(
      node: string,
      op: string,
      args: Record<string, unknown>,
      by: string,
    ): Promise<ControlOutcome> {
      calls.push({ node, op, args, at: pace })
      if (op === 'node.ping')
        return { ok: true, value: { node, agents: ['main'] } }
      const overridden = await intercept?.(node, op, args)
      const answer =
        overridden ??
        (await hosts.get(node)!.handle(op, args, {
          peer: 'hub',
          actor: by,
          taskId: crypto.randomUUID(),
        }))
      return answer
    },
  }
  const options = {
    directory: path.join(root, 'hub'),
    control,
    agents: async () => (registered ? [source, target] : []),
    authorized: () => allowed,
    stopped: () => stopped,
    now: () => now,
    pacing: {
      now: () => pace,
      wait: async (ms: number) => {
        pace += ms
      },
    },
    actions: {
      admit: async () => ({ ok: true as const, value: undefined }),
      record: async (entry: { action: string }) => {
        actions.push(entry.action)
        return { ok: true as const, value: undefined }
      },
      list: async () => ({
        ok: true as const,
        value: { entries: [], nextBeforeSeq: null },
      }),
    },
  }
  let hub = new ConsoleFiles(options)
  cleanups.push(async () => {
    await hub.idle()
    hub.close()
    fs.rmSync(root, { recursive: true, force: true })
  })
  return {
    root,
    workspaces,
    hosts,
    control,
    audits,
    actions,
    calls,
    get hub() {
      return hub
    },
    get handler() {
      return handler
    },
    setIntercept(next: typeof intercept) {
      intercept = next
    },
    withoutRegistry() {
      registered = false
    },
    setAllowed(next: boolean) {
      allowed = next
    },
    setStopped(next: boolean) {
      stopped = next
    },
    advance(ms: number) {
      now += ms
    },
    restart() {
      hub.close()
      hub = new ConsoleFiles(options)
      return hub
    },
    file(file: string, text: string | Uint8Array, node = 'alpha') {
      const full = path.join(workspaces.get(node)!, file)
      fs.mkdirSync(path.dirname(full), { recursive: true })
      fs.writeFileSync(full, text)
      return full
    },
    async send(file: string, sources = [{ ...source, path: file }]) {
      const group = value(await hub.transfer({ sources, target }, actor))
      await hub.idle()
      return value(await hub.snapshot()).transfers.filter(one =>
        group.transfers.includes(one.transferId),
      )
    },
  }
}

async function rawRequest(
  f: ReturnType<typeof fixture>,
  file: string,
  approve = true,
  scope?: { kind: 'file' | 'dir'; path: string },
) {
  const request = await f.handler(
    'files.request',
    { from: 'qianmo://alpha/main', path: file, reason: 'needed' },
    { node: 'beta', agent: 'main', callId: crypto.randomUUID() },
  )
  if (!request.ok) throw new Error('request rejected')
  const id = (request.value as { requestId: string }).requestId
  return value(
    await f.hub.decide(id, { approve, ...(scope ? { scope } : {}) }, actor),
  )
}

function delivered(
  f: ReturnType<typeof fixture>,
  transfer: FileTransferView,
): string {
  expect(transfer.state).toBe('done')
  expect(transfer.verified).toBe(true)
  return path.join(f.workspaces.get('beta')!, transfer.target.path!)
}

test('two node hosts transfer chunks through the hub, verify digests, preserve collisions and use new immutable snapshots on grant reuse', async () => {
  const f = fixture(),
    text = 'data\n'.repeat(30_000)
  f.file('report.txt', text)
  const request = await rawRequest(f, 'report.txt')
  expect(request.state).toBe('granted')
  const [one] = await f.send('report.txt')
  expect(fs.readFileSync(delivered(f, one!), 'utf8')).toBe(text)
  expect(one!.manifestSha256).toBe(
    manifestSha256([
      {
        path: 'report.txt',
        size: Buffer.byteLength(text),
        sha256: sha256(text),
      },
    ]),
  )
  f.file('report.txt', 'second revision')
  const [two] = await f.send('report.txt')
  expect(two!.grantId).toBe(one!.grantId)
  expect(two!.transferId).not.toBe(one!.transferId)
  expect(two!.target.path).toBe(
    `inbox/alpha/report.txt.${two!.transferId.slice(0, 8)}`,
  )
  expect(fs.readFileSync(delivered(f, two!), 'utf8')).toBe('second revision')
  expect(fs.readFileSync(delivered(f, one!), 'utf8')).toBe(text)
  expect(fs.readdirSync(path.join(f.root, 'hub'))).toEqual(['files.json'])
  expect(fs.statSync(path.join(f.root, 'hub', 'files.json')).mode & 0o777).toBe(
    0o600,
  )
  expect(f.audits.filter(one => one.kind === 'files.delivered')).toHaveLength(2)
  expect(f.actions).toEqual([
    'files.decide',
    'files.transfer',
    'files.transfer',
  ])
  for (const call of f.calls.filter(
    one => one.op === 'files.write' && one.args.data !== undefined,
  )) {
    expect(
      Buffer.from(call.args.data as string, 'base64').length,
    ).toBeLessThanOrEqual(FILE_CHUNK_BYTES)
    expect(
      messageBytes(
        createMessage({
          from: 'qianmo://hub/console',
          to: `qianmo://${call.node}/console`,
          type: MessageType.NodeControl,
          payload: { op: call.op, args: call.args, actor: actor.subject },
        }),
      ),
    ).toBeLessThanOrEqual(LIMITS.maxMessageBytes)
  }
  for (const node of ['alpha', 'beta']) {
    const nodeCalls = f.calls.filter(one => one.node === node)
    for (let i = 1; i < nodeCalls.length; i++)
      expect(nodeCalls[i]!.at - nodeCalls[i - 1]!.at).toBeGreaterThanOrEqual(
        1200,
      )
  }
})

test('directory manifests page; gathering isolates a refused source and retries it with a new transfer', async () => {
  const f = fixture()
  for (let i = 0; i < 65; i++) f.file(`dataset/f${i}.txt`, String(i))
  const [directory] = await f.send('dataset')
  expect(directory!.files).toBe(65)
  expect(
    fs.readFileSync(path.join(delivered(f, directory!), 'f64.txt'), 'utf8'),
  ).toBe('64')
  expect(
    f.calls.some(one => one.op === 'files.stat' && one.args.page === 1),
  ).toBe(true)
  f.file('ok.txt', 'alpha')
  f.file('bad.txt', `qmd_${'a'.repeat(43)}`, 'beta')
  const group = value(
    await f.hub.transfer(
      {
        sources: [
          { ...source, path: 'ok.txt' },
          { ...target, path: 'bad.txt' },
        ],
        target,
      },
      actor,
    ),
  )
  await f.hub.idle()
  const rows = value(await f.hub.snapshot()).transfers.filter(one =>
    group.transfers.includes(one.transferId),
  )
  expect(rows.map(one => one.state)).toEqual(['done', 'failed'])
  f.file('bad.txt', 'fixed', 'beta')
  const retry = value(await f.hub.retry(rows[1]!.transferId, actor))
  expect(retry.transferId).not.toBe(rows[1]!.transferId)
  await f.hub.idle()
  const done = value(await f.hub.snapshot()).transfers.find(
    one => one.transferId === retry.transferId,
  )!
  expect(fs.readFileSync(delivered(f, done), 'utf8')).toBe('fixed')
}, 30_000)

test('path traversal, symlinks (including a stat/open swap), hardlinks and protected trees never export', async () => {
  const f = fixture(),
    outside = path.join(f.root, 'outside')
  fs.writeFileSync(outside, 'private')
  f.file('good.txt', 'ordinary')
  fs.symlinkSync(outside, path.join(f.workspaces.get('alpha')!, 'soft.txt'))
  fs.linkSync(outside, path.join(f.workspaces.get('alpha')!, 'hard.txt'))
  for (const tree of ['.git', '.ssh', '.qianmo', '.omp', 'inbox'])
    f.file(`${tree}/private`, 'private')
  for (const file of [
    '../outside',
    'soft.txt',
    'hard.txt',
    '.git',
    '.ssh',
    '.qianmo',
    '.omp',
    'inbox',
  ]) {
    const result = await f.hub.transfer(
      { sources: [{ ...source, path: file }], target },
      actor,
    )
    if (result.ok) {
      await f.hub.idle()
      expect(
        value(await f.hub.snapshot()).transfers.find(
          one => one.transferId === result.value.transfers[0],
        )!.state,
      ).toBe('failed')
    } else expect(result.failure.code).toBe('invalid')
  }
  let replaced = false
  f.setIntercept(async (node, op, args) => {
    if (
      !replaced &&
      node === 'alpha' &&
      op === 'files.stat' &&
      args.inspect !== true
    ) {
      replaced = true
      fs.unlinkSync(path.join(f.workspaces.get('alpha')!, 'good.txt'))
      fs.symlinkSync(outside, path.join(f.workspaces.get('alpha')!, 'good.txt'))
    }
    return undefined
  })
  const [race] = await f.send('good.txt')
  expect(replaced).toBe(true)
  expect(race!.state).toBe('failed')
  expect(fs.existsSync(path.join(f.workspaces.get('beta')!, 'inbox'))).toBe(
    false,
  )
})

test('secret filenames, Qianmo credentials and secrets crossing chunk boundaries are refused; binary policy is filename-only', async () => {
  const f = fixture()
  const cases = [
    ['.env.prod', 'value'],
    ['id_custom', 'value'],
    ['credentials.json', 'value'],
    ['tls.pem', 'value'],
    ['.npmrc', 'value'],
    ['.pypirc', 'value'],
    ['cross.txt', `${' '.repeat(FILE_CHUNK_BYTES - 8)}ghp_${'A'.repeat(36)}`],
  ]
  for (const [file, text] of cases) {
    f.file(file!, text!)
    expect((await f.send(file!))[0]!.state).toBe('failed')
  }
  for (const prefix of ['qmd_', 'qmu_', 'qmi_', 'qms_']) {
    f.file('q.txt', prefix + 'a'.repeat(43))
    expect((await f.send('q.txt'))[0]!.state).toBe('failed')
  }
  expect(JSON.stringify(f.audits)).not.toContain('ghp_')
  expect(JSON.stringify(f.audits)).not.toContain('qmd_')
  const binary = Buffer.from([0, 1, 255, 34])
  f.file('blob.bin', binary)
  const [done] = await f.send('blob.bin')
  expect(fs.readFileSync(delivered(f, done!))).toEqual(binary)
  expect(
    f.audits.some(
      one =>
        one.kind === 'files.read' &&
        JSON.stringify(one.detail).includes('filename-only'),
    ),
  ).toBe(true)
})

test('oversized source, aggregate limit, dangerous aliases and a symlinked inbox refuse', async () => {
  const f = fixture(),
    large = f.file('huge.txt', '')
  fs.truncateSync(large, FILE_LIMITS.maxFileBytes + 1)
  expect((await f.send('huge.txt'))[0]!.state).toBe('failed')
  for (let i = 0; i < 1001; i++) f.file(`too-many/f${i}`, '')
  expect((await f.send('too-many'))[0]!.state).toBe('failed')
  f.file('aliases/A.txt', 'a')
  f.file('aliases/Ａ.txt', 'b')
  // Case-insensitive filesystems collapse these names; a mismatched spelling
  // is still a dangerous alias at the descriptor boundary.
  expect((await f.send('aliases/A.txt'))[0]!.state).toBe('failed')
  f.file('safe.txt', 'safe')
  const outside = path.join(f.root, 'escape')
  fs.mkdirSync(outside)
  fs.symlinkSync(outside, path.join(f.workspaces.get('beta')!, 'inbox'))
  expect((await f.send('safe.txt'))[0]!.state).toBe('failed')
  expect(fs.readdirSync(outside)).toEqual([])
}, 30_000)

test('expiry, revocation, issuer withdrawal, workspace replacement and segmented directory scopes are enforced', async () => {
  expect(scopeContains({ kind: 'dir', path: 'a/b' }, 'a/bc/file')).toBe(false)
  expect(scopeContains({ kind: 'dir', path: 'a/b' }, 'a/b/file')).toBe(true)
  for (const invalidate of [
    'expiry',
    'revoke',
    'issuer',
    'source-workspace',
    'target-workspace',
  ] as const) {
    const f = fixture()
    f.file('a/b/data', 'data')
    f.file('a/bc/data', 'private')
    const request = await rawRequest(f, 'a/b', true, {
      kind: 'dir',
      path: 'a/b',
    })
    let invalidated = false
    f.setIntercept(async (_node, op, args) => {
      if (op === 'files.read' && !invalidated) {
        invalidated = true
        if (invalidate === 'expiry') f.advance(FILE_LIMITS.maxTtlMs)
        if (invalidate === 'revoke')
          await f.hub.revokeGrant(request.grantId!, actor)
        if (invalidate === 'issuer') f.setAllowed(false)
        if (invalidate.endsWith('workspace')) {
          const node = invalidate === 'source-workspace' ? 'alpha' : 'beta',
            old = f.workspaces.get(node)!
          fs.renameSync(old, `${old}-previous`)
          fs.mkdirSync(old)
        }
      }
      return undefined
    })
    const [transfer] = await f.send('a/b')
    expect(invalidated).toBe(true)
    expect(transfer!.state).toBe('failed')
    expect(f.audits.some(one => one.kind === 'files.delivered')).toBe(false)
  }
})

test('persistent operation ids deduplicate write/commit/abort; ESTOP admits only cleanup and commit timeouts stay unknown', async () => {
  const f = fixture()
  f.file('file.txt', 'delivered')
  let writes = 0,
    commits = 0
  f.setIntercept(async (node, op, args) => {
    if (op === 'files.write' || op === 'files.commit' || op === 'files.abort') {
      const ctx = {
        peer: 'hub',
        actor: actor.subject,
        taskId: crypto.randomUUID(),
      }
      const first = await f.hosts.get(node)!.handle(op, args, ctx)
      const restarted = new NodeFiles({
        node,
        agents: () => [{ agent: 'main', cwd: f.workspaces.get(node)! }],
        directory: path.join(f.root, `state-${node}`),
        stopped: () => false,
        hub: {
          call: (verb, input, options) =>
            f.handler(verb, input, {
              node,
              callId: crypto.randomUUID(),
              agent: options?.agent,
            }),
        },
      })
      const repeated = await restarted.handle(op, args, ctx)
      expect(repeated).toEqual(first)
      const conflict = await restarted.handle(
        op,
        { ...args, path: 'different' },
        ctx,
      )
      expect(conflict.ok).toBe(false)
      if (op === 'files.write') writes++
      if (op === 'files.commit') commits++
      return first
    }
    return undefined
  })
  const [done] = await f.send('file.txt')
  expect(fs.readFileSync(delivered(f, done!), 'utf8')).toBe('delivered')
  expect(writes).toBe(2)
  expect(commits).toBe(1)
  f.setIntercept(undefined)
  f.setStopped(true)
  expect(
    (
      await f.hosts
        .get('alpha')!
        .handle(
          'files.browse',
          { agent: 'main', path: '' },
          { peer: 'hub', actor: actor.subject, taskId: 'task' },
        )
    ).ok,
  ).toBe(false)
  expect(
    (
      await f.hosts
        .get('alpha')!
        .handle(
          'files.abort',
          { transferId: crypto.randomUUID(), operationId: crypto.randomUUID() },
          { peer: 'hub', actor: actor.subject, taskId: 'task' },
        )
    ).ok,
  ).toBe(true)
  f.setStopped(false)
  let attempts = 0
  f.setIntercept(async (node, op, args) => {
    if (op === 'files.commit') {
      attempts++
      await f.hosts.get(node)!.handle(op, args, {
        peer: 'hub',
        actor: actor.subject,
        taskId: 'lost-reply',
      })
      return { ok: false, code: 'timeout', message: 'lost reply' }
    }
    return undefined
  })
  const [unknown] = await f.send('file.txt')
  expect(unknown!.state).toBe('failed')
  expect(unknown!.reason).toContain('结果未知')
  expect(attempts).toBe(1)
})

test('restart checkpoints fail in-flight work and an explicit retry uses a new snapshot', async () => {
  const f = fixture()
  f.file('restart.txt', 'original')
  let restarted = false
  f.setIntercept(async (_node, op) => {
    if (op === 'files.read' && !restarted) {
      restarted = true
      f.restart()
      return { ok: false, code: 'timeout', message: 'process gone' }
    }
    return undefined
  })
  const group = value(
    await f.hub.transfer(
      { sources: [{ ...source, path: 'restart.txt' }], target },
      actor,
    ),
  )
  // Hold the old instance so its background task can clean up its own bytes.
  const old = f.hub
  await old.idle()
  expect(restarted).toBe(true)
  const interrupted = value(await f.hub.snapshot()).transfers.find(
    one => one.transferId === group.transfers[0],
  )!
  expect(interrupted.state).toBe('failed')
  expect(interrupted.reason).toContain('重启')
  f.setIntercept(undefined)
  f.file('restart.txt', 'updated')
  const retry = value(await f.hub.retry(interrupted.transferId, actor))
  await f.hub.idle()
  const done = value(await f.hub.snapshot()).transfers.find(
    one => one.transferId === retry.transferId,
  )!
  expect(fs.readFileSync(delivered(f, done), 'utf8')).toBe('updated')
})

test('descriptor walker rejects path traversal and platform aliases; canonical manifests bind sizes', () => {
  const f = fixture(),
    dir = FileDirectory.root(f.workspaces.get('alpha')!)
  try {
    expect(() => dir.open('../outside')).toThrow()
    expect(() => dir.open('CON.txt', true)).toThrow()
    expect(() => dir.open('a\tname', true)).toThrow()
  } finally {
    dir.close()
  }
  expect(
    manifestSha256([{ path: 'a', size: 1, sha256: sha256('x') }]),
  ).not.toBe(manifestSha256([{ path: 'a', size: 2, sha256: sha256('x') }]))
})

test('transfer totals, target digest rejection and host-owned staging guards protect externally visible publication', async () => {
  const f = fixture()
  const oversized = Array.from({ length: 5 }, (_, i) => ({
    path: `f${i}`,
    size: FILE_LIMITS.maxFileBytes,
    sha256: sha256('x'),
  }))
  expect(() => validateManifest(oversized)).toThrow('transfer-too-large')
  f.file('digest.txt', 'must verify')
  f.setIntercept(async (node, op, args) => {
    if (node === 'beta' && op === 'files.commit') {
      fs.writeFileSync(
        path.join(
          f.root,
          'state-beta',
          args.transferId as string,
          'target',
          '0',
        ),
        'corrupt',
      )
    }
    return undefined
  })
  const [failed] = await f.send('digest.txt')
  expect(failed!.state).toBe('failed')
  expect(fs.existsSync(path.join(f.workspaces.get('beta')!, 'inbox'))).toBe(
    false,
  )
  const config = {
    v: 1 as const,
    agent: 'main',
    workspace: f.workspaces.get('beta')!,
    edits: 'workspace' as const,
    protectedRoots: [],
    hostTools: ['qianmo_file_request'],
  }
  expect(
    residentToolVerdict(
      {
        toolName: 'write',
        input: { path: 'inbox/alpha/.files-test/data', content: 'corrupt' },
      },
      config,
      { agentKind: 'main' },
    ),
  ).toMatchObject({ block: true })
  expect(
    residentToolVerdict(
      { toolName: 'qianmo_file_request', input: {} },
      config,
      { agentKind: 'sub' },
    ),
  ).toMatchObject({ block: true })
  expect(
    residentToolVerdict(
      { toolName: 'read', input: { path: path.join(f.root, 'state-alpha') } },
      config,
      { agentKind: 'main' },
    ),
  ).toMatchObject({ block: true })
  expect(
    residentToolVerdict(
      {
        toolName: 'tts',
        input: { output_path: 'inbox/alpha/.files-test/data', text: 'replace' },
      },
      { ...config, media: { image: false, speech: true } },
      { agentKind: 'main' },
    ),
  ).toMatchObject({ block: true })
  expect(
    exportContentRules('bundle.zip', Buffer.from('ghp_' + 'A'.repeat(36))),
  ).toEqual({ rules: [], scan: 'filename-only' })
})

test('denials are durable and withdrawn ownership refuses before admission or dialing', async () => {
  const f = fixture()
  f.file('deny.txt', 'safe')
  const denied = await rawRequest(f, 'deny.txt', false)
  expect(denied.state).toBe('denied')
  expect(f.audits.some(one => one.kind === 'files.denied')).toBe(true)
  f.setAllowed(false)
  const count = f.calls.length,
    actions = f.actions.length
  expect(
    (
      await f.hub.transfer(
        { sources: [{ ...source, path: 'deny.txt' }], target },
        actor,
      )
    ).ok,
  ).toBe(false)
  expect(f.calls).toHaveLength(count)
  expect(f.actions).toHaveLength(actions)
})

test('cleanup missed during disconnection survives hub restart and resumes without another commit', async () => {
  const f = fixture()
  f.file('cleanup.txt', 'staged')
  f.setIntercept(async (_node, op) =>
    op === 'files.abort' || op === 'files.commit'
      ? { ok: false, code: 'unreachable', message: 'disconnected' }
      : undefined,
  )
  const [failed] = await f.send('cleanup.txt')
  expect(failed!.state).toBe('failed')
  const sourceStage = path.join(f.root, 'state-alpha', failed!.transferId)
  const targetStage = path.join(f.root, 'state-beta', failed!.transferId)
  expect(fs.existsSync(sourceStage)).toBe(true)
  expect(fs.existsSync(targetStage)).toBe(true)
  const commits = f.calls.filter(one => one.op === 'files.commit').length
  f.restart()
  f.setIntercept(undefined)
  await f.hub.cleanup()
  expect(fs.existsSync(sourceStage)).toBe(false)
  expect(fs.existsSync(targetStage)).toBe(false)
  expect(f.calls.filter(one => one.op === 'files.commit')).toHaveLength(commits)
})

test('canonical Unicode paths transfer, while scope forgery and FIFO export are refused', async () => {
  const f = fixture()
  f.file('résumé.txt', 'unicode')
  const [normal] = await f.send('résumé.txt')
  expect(fs.readFileSync(delivered(f, normal!), 'utf8')).toBe('unicode')
  f.file('a/b/file.txt', 'public')
  f.file('a/bc/file.txt', 'private')
  await rawRequest(f, 'a/b', true, { kind: 'dir', path: 'a/b' })
  f.setIntercept(async (node, op, args) => {
    if (node === 'alpha' && op === 'files.stat' && args.inspect !== true) {
      const response = await f.hosts
        .get(node)!
        .handle(
          op,
          { ...args, path: 'a/bc/file.txt' },
          { peer: 'hub', actor: actor.subject, taskId: 'scope-forgery' },
        )
      expect(response).toMatchObject({ ok: false, code: 'scope-mismatch' })
      return response
    }
    return undefined
  })
  expect((await f.send('a/b'))[0]!.state).toBe('failed')
  f.setIntercept(undefined)
  const fifo = path.join(f.workspaces.get('alpha')!, 'pipe')
  expect(Bun.spawnSync(['mkfifo', fifo]).exitCode).toBe(0)
  expect((await f.send('pipe'))[0]!.state).toBe('failed')
})

test('a corrupt restart checkpoint cannot use a transfer id to delete files outside staging', async () => {
  const f = fixture()
  f.file('checkpoint.txt', 'retained')
  await f.send('checkpoint.txt')
  const bookPath = path.join(f.root, 'hub', 'files.json')
  const book = JSON.parse(fs.readFileSync(bookPath, 'utf8'))
  book.transfers[0].transferId = '..'
  book.transfers[0].state = 'reading'
  fs.writeFileSync(bookPath, JSON.stringify(book))
  expect(() => f.restart()).toThrow()
  expect(
    fs.readFileSync(
      path.join(f.workspaces.get('alpha')!, 'checkpoint.txt'),
      'utf8',
    ),
  ).toBe('retained')
})

test('main-agent file tool persists its authenticated target and requested audit; invalid calls and ESTOP cannot create requests', async () => {
  const f = fixture()
  f.file('requested.txt', 'requested')
  const tool = f.hosts.get('beta')!.tool()
  const request = {
    from: 'qianmo://alpha/main',
    path: 'requested.txt',
    reason: 'needed for work',
  }
  expect(
    (await tool.handler(request, { agent: 'main', sessionId: 'session' })).ok,
  ).toBe(true)
  expect(value(await f.hub.snapshot()).requests).toMatchObject([
    {
      source,
      target,
      path: 'requested.txt',
      requestedBy: 'agent',
      state: 'pending',
    },
  ])
  expect(f.audits.filter(one => one.kind === 'files.requested')).toHaveLength(1)
  expect(
    (
      await tool.handler(
        { ...request, path: '../private' },
        { agent: 'main', sessionId: 'session' },
      )
    ).ok,
  ).toBe(false)
  f.setStopped(true)
  expect(
    (await tool.handler(request, { agent: 'main', sessionId: 'session' })).ok,
  ).toBe(false)
  expect(value(await f.hub.snapshot()).requests).toHaveLength(1)
})

test('control-linked agents can request and receive files when no registry roster is available', async () => {
  const f = fixture()
  f.withoutRegistry()
  await f.hub.discover()
  f.file('control-only.txt', 'from control')
  expect(
    value(await f.hub.snapshot()).agents.map(one => `${one.node}/${one.agent}`),
  ).toEqual(['alpha/main', 'beta/main'])
  const request = await f.hosts.get('beta')!.tool().handler(
    {
      from: 'qianmo://alpha/main',
      path: 'control-only.txt',
      reason: 'without registry',
    },
    { agent: 'main', sessionId: 'session' },
  )
  expect(request.ok).toBe(true)
  const [done] = await f.send('control-only.txt')
  expect(fs.readFileSync(delivered(f, done!), 'utf8')).toBe('from control')
})
