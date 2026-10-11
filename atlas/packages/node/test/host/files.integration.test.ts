// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, expect, test, spyOn, mock } from 'bun:test'
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
import { runGit } from '@qianmo/handoff'
import {
  filesRetention,
  probePrivateFilesRepo,
} from '../../src/commands/filesExchangeRepo.js'
import { NodeFiles } from '../../src/host/files.js'
import { exchangeArgs } from '../../src/host/filesGithub.js'
import { residentToolVerdict } from '@qianmo/extension/policy'
import { FileDirectory } from '../../src/host/filesSafeFs.js'
import {
  exportContentRules,
  validateManifest,
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
  mock.restore()
  for (const cleanup of cleanups.splice(0)) await cleanup()
})
function fixture(
  settings: {
    private?: boolean | null
    retentionMs?: number
    revoked?: boolean
    credentialError?: boolean
    link?: string
  } = {},
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qm-files-'))
  const workspaces = new Map([
    ['alpha', path.join(root, 'alpha')],
    ['beta', path.join(root, 'beta')],
    ['gamma', path.join(root, 'gamma')],
    ['delta', path.join(root, 'delta')],
  ])
  for (const dir of workspaces.values()) fs.mkdirSync(dir)
  let handler: HubCallHandler,
    allowed = true,
    stopped = false,
    now = Date.now(),
    pace = 0
  const remote = path.join(root, 'exchange.git')
  expect(
    Bun.spawnSync([
      '/usr/bin/git',
      'init',
      '--bare',
      '--quiet',
      '--template=',
      remote,
    ]).exitCode,
  ).toBe(0)
  const remoteUrl = new URL(`file://${remote}`).href
  const token = 'test-exchange-token-SENTINEL'
  let revoked = settings.revoked ?? false
  let visibility = settings.private === undefined ? true : settings.private
  let link = settings.link ?? 'ws://127.0.0.1:1234'
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
  for (const node of workspaces.keys())
    hosts.set(
      node,
      new NodeFiles({
        node,
        agents: () => [{ agent: 'main', cwd: workspaces.get(node)! }],
        directory: path.join(root, `state-${node}`),
        localExchangeRemote: true,
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
    exchangeRepo: 'owner/exchange',
    credentials: {
      resolve: async () => {
        if (settings.credentialError) throw new Error(token)
        return revoked ? null : { remoteUrl, token }
      },
    },
    probe: async () => visibility,
    retentionMs: settings.retentionMs ?? 0,
    controlUrl: () => link,
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
    remote,
    remoteUrl,
    token,
    setRevoked(next: boolean) {
      revoked = next
    },
    setPrivate(next: boolean | null) {
      visibility = next
    },
    setLink(next: string) {
      link = next
    },
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

test('two node hosts exchange via git without hub bytes, verify digests, preserve collisions and use new immutable snapshots on grant reuse', async () => {
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
  expect(fs.readdirSync(path.join(f.root, 'hub')).sort()).toEqual([
    'files.json',
    'files.ndjson',
  ])
  expect(fs.statSync(path.join(f.root, 'hub', 'files.json')).mode & 0o777).toBe(
    0o600,
  )
  expect(f.audits.filter(one => one.kind === 'files.delivered')).toHaveLength(2)
  expect(f.actions).toEqual([
    'files.decide',
    'files.transfer',
    'files.transfer',
  ])
  expect(f.calls.filter(one => one.op === 'files.publish')).toHaveLength(2)
  expect(f.calls.filter(one => one.op === 'files.fetch')).toHaveLength(2)
  expect(
    f.calls.some(one =>
      ['files.read', 'files.write', 'files.commit'].includes(one.op),
    ),
  ).toBe(false)
  for (const call of f.calls)
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
  for (const row of [one!, two!]) {
    expect(row.exchange?.cleaned).toBe(true)
    expect(
      (
        await runGit(['ls-remote', f.remoteUrl, row.exchange!.ref], {
          cwd: f.root,
        })
      ).stdout.toString(),
    ).toBe('')
  }
  const walk = (dir: string): void => {
    for (const name of fs.readdirSync(dir)) {
      expect(name === 'objects' || name.endsWith('.pack')).toBe(false)
      const file = path.join(dir, name)
      if (fs.statSync(file).isDirectory()) walk(file)
      else {
        const bytes = fs.readFileSync(file)
        expect(sha256(bytes)).not.toBe(sha256(text))
        expect(sha256(bytes)).not.toBe(sha256('second revision'))
        expect(bytes.toString()).not.toContain(f.token)
        expect(bytes.toString()).not.toContain(
          Buffer.from(`x-access-token:${f.token}`).toString('base64'),
        )
      }
    }
  }
  walk(path.join(f.root, 'hub'))
  for (const node of f.workspaces.keys()) {
    expect(fs.readdirSync(path.join(f.root, `state-${node}`))).toEqual([
      'operations.json',
    ])
    walk(path.join(f.root, `state-${node}`))
  }
  expect(JSON.stringify(f.audits)).not.toContain(f.token)
})

test('directory manifests; gathering isolates a refused source and retries it with a new transfer', async () => {
  const f = fixture()
  for (let i = 0; i < 65; i++) f.file(`dataset/f${i}.txt`, String(i))
  const [directory] = await f.send('dataset')
  expect(directory!.files).toBe(65)
  expect(
    fs.readFileSync(path.join(delivered(f, directory!), 'f64.txt'), 'utf8'),
  ).toBe('64')
  expect(f.calls.filter(one => one.op === 'files.publish')).toHaveLength(1)
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
    if (!replaced && node === 'alpha' && op === 'files.publish') {
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
    ['cross.txt', `${' '.repeat(128 * 1024 - 8)}ghp_${'A'.repeat(36)}`],
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
      if (op === 'files.publish' && !invalidated) {
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

test('persistent operation ids deduplicate publish/fetch/abort; ESTOP admits only cleanup and commit timeouts stay unknown', async () => {
  const f = fixture()
  f.file('file.txt', 'delivered')
  let writes = 0,
    commits = 0
  f.setIntercept(async (node, op, args) => {
    if (
      op === 'files.publish' ||
      op === 'files.fetch' ||
      op === 'files.abort'
    ) {
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
        localExchangeRemote: true,
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
      if (op === 'files.publish' || op === 'files.fetch') {
        const rotated = await restarted.handle(
          op,
          {
            ...args,
            credential: { kind: 'github-token', token: 'rotated-secret' },
          },
          ctx,
        )
        expect(rotated).toEqual(first)
        const wrongKind = await restarted.handle(
          op,
          {
            ...args,
            credential: { kind: 'changed-kind', token: 'rotated-secret' },
          },
          ctx,
        )
        expect(wrongKind).toMatchObject({
          ok: false,
          code: 'operation-conflict',
        })
      }
      const conflict = await restarted.handle(
        op,
        { ...args, path: 'different' },
        ctx,
      )
      expect(conflict.ok).toBe(false)
      if (op === 'files.publish') writes++
      if (op === 'files.fetch') commits++
      return first
    }
    return undefined
  })
  const [done] = await f.send('file.txt')
  expect(fs.readFileSync(delivered(f, done!), 'utf8')).toBe('delivered')
  expect(writes).toBe(1)
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
    if (op === 'files.fetch') {
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
    if (op === 'files.publish' && !restarted) {
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
  // Hold the old instance so its background task can finish cleanup.
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
    if (node === 'beta' && op === 'files.fetch')
      args.manifestSha256 = sha256('corrupt')
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
    op === 'files.abort' || op === 'files.fetch'
      ? { ok: false, code: 'unreachable', message: 'disconnected' }
      : undefined,
  )
  const [failed] = await f.send('cleanup.txt')
  expect(failed!.state).toBe('failed')
  const sourceStage = path.join(f.root, 'state-alpha', failed!.transferId)
  const targetStage = path.join(f.root, 'state-beta', failed!.transferId)
  expect(fs.existsSync(sourceStage)).toBe(false)
  expect(fs.existsSync(targetStage)).toBe(false)
  const commits = f.calls.filter(one => one.op === 'files.fetch').length
  f.restart()
  f.setIntercept(undefined)
  await f.hub.cleanup()
  expect(fs.existsSync(sourceStage)).toBe(false)
  expect(fs.existsSync(targetStage)).toBe(false)
  expect(f.calls.filter(one => one.op === 'files.fetch')).toHaveLength(commits)
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
    if (node === 'alpha' && op === 'files.publish') {
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

async function maliciousCommit(
  f: ReturnType<typeof fixture>,
  ref: string,
  rows: readonly {
    name: string
    mode?: string
    bytes?: string
    object?: string
  }[],
): Promise<string> {
  const repo = fs.mkdtempSync(path.join(f.root, 'malicious-'))
  const git = async (args: string[], input?: string) =>
    (
      await runGit(args, {
        cwd: repo,
        input,
        env: {
          GIT_AUTHOR_NAME: 'Test',
          GIT_AUTHOR_EMAIL: 'test@example.invalid',
          GIT_COMMITTER_NAME: 'Test',
          GIT_COMMITTER_EMAIL: 'test@example.invalid',
        },
      })
    ).stdout
      .toString()
      .trim()
  await git(['init', '--quiet', '--template='])
  for (const row of rows) {
    const hash =
      row.object ?? (await git(['hash-object', '-w', '--stdin'], row.bytes!))
    await git([
      'update-index',
      '--add',
      '--cacheinfo',
      row.mode ?? '100644',
      hash,
      row.name,
    ])
  }
  const tree = await git(['write-tree'])
  const commit = await git(['commit-tree', tree, '-m', 'malicious fixture'])
  await git(['push', '--force', f.remoteUrl, `${commit}:${ref}`])
  return commit
}

for (const attack of [
  'symlink',
  'gitlink',
  'outside-tree',
  'outside-manifest',
  'file-digest',
  'file-size',
  'manifest-digest',
  'branch-tip',
] as const) {
  test(`malicious source ${attack} is rejected before inbox publication and its branch is deleted`, async () => {
    const f = fixture()
    f.file('safe.txt', 'safe')
    f.setIntercept(async (_node, op, args) => {
      if (op !== 'files.publish') return undefined
      const entries = [
        {
          path: 'safe.txt',
          size: attack === 'file-size' ? 3 : 4,
          sha256: sha256('safe'),
        },
      ]
      const digest = manifestSha256(entries)
      const manifest = {
        path: 'safe.txt',
        kind: 'file',
        entries,
        manifestSha256: attack === 'manifest-digest' ? sha256('wrong') : digest,
      }
      const rows: {
        name: string
        mode?: string
        bytes?: string
        object?: string
      }[] = [
        { name: 'MANIFEST.json', bytes: JSON.stringify(manifest) },
        {
          name: 'files/safe.txt',
          bytes: attack === 'file-digest' ? 'evil' : 'safe',
        },
      ]
      if (attack === 'symlink')
        rows[1] = {
          name: 'files/safe.txt',
          mode: '120000',
          bytes: '/etc/passwd',
        }
      if (attack === 'gitlink')
        rows[1] = {
          name: 'files/safe.txt',
          mode: '160000',
          object: '1'.repeat(40),
        }
      if (attack === 'outside-tree')
        rows.push({ name: 'evil.txt', bytes: 'evil' })
      if (attack === 'outside-manifest')
        rows.push({ name: 'files/undeclared.txt', bytes: 'evil' })
      const ref = (args.exchange as { ref: string }).ref
      let commit = await maliciousCommit(f, ref, rows)
      if (attack === 'branch-tip') {
        const reported = commit
        rows[1] = { name: 'files/safe.txt', bytes: 'new!' }
        await maliciousCommit(f, ref, rows)
        commit = reported
      }
      return {
        ok: true,
        value: { commit, manifestSha256: digest, files: 1, bytes: 4 },
      }
    })
    const [failed] = await f.send('safe.txt')
    expect(failed!.state).toBe('failed')
    expect(failed!.verified).toBe(false)
    expect(fs.existsSync(path.join(f.workspaces.get('beta')!, 'inbox'))).toBe(
      false,
    )
    expect(
      (
        await runGit(['ls-remote', f.remoteUrl, failed!.exchange!.ref], {
          cwd: f.root,
        })
      ).stdout.length,
    ).toBe(0)
    expect(failed!.exchange!.cleaned).toBe(true)
    for (const node of ['alpha', 'beta'])
      expect(
        fs.existsSync(path.join(f.root, `state-${node}`, failed!.transferId)),
      ).toBe(false)
  })
}

test('three-source gathering delivers independently under each source node', async () => {
  const f = fixture()
  for (const node of ['alpha', 'gamma', 'delta'])
    f.file('report.txt', node, node)
  const rows = await f.send(
    'report.txt',
    ['alpha', 'gamma', 'delta'].map(node => ({
      node,
      agent: 'main',
      path: 'report.txt',
    })),
  )
  expect(rows).toHaveLength(3)
  for (const row of rows) {
    expect(fs.readFileSync(delivered(f, row), 'utf8')).toBe(row.source.node)
    expect(row.target.path).toBe(`inbox/${row.source.node}/report.txt`)
    expect(row.exchange?.cleaned).toBe(true)
  }
  expect(new Set(rows.map(row => row.exchange!.ref)).size).toBe(3)
}, 30_000)

test('public and unknown visibility refuse initialization and transfer creation, including a later visibility change', async () => {
  for (const visibility of [false, null]) {
    const f = fixture({ private: visibility })
    f.file('safe.txt', 'safe')
    await expect(f.hub.initialize()).rejects.toThrow()
    const result = await f.hub.transfer(
      { sources: [{ ...source, path: 'safe.txt' }], target },
      actor,
    )
    expect(result).toMatchObject({
      ok: false,
      failure: { message: '交换仓库必须是私有仓库' },
    })
    expect(value(await f.hub.snapshot()).exchange).toEqual({
      repo: 'owner/exchange',
      private: visibility,
    })
    expect(value(await f.hub.snapshot()).transfers).toEqual([])
    expect(f.calls.some(one => one.op === 'files.publish')).toBe(false)
  }
  const f = fixture()
  await f.hub.initialize()
  f.setPrivate(false)
  expect(
    (
      await f.hub.transfer(
        { sources: [{ ...source, path: 'safe.txt' }], target },
        actor,
      )
    ).ok,
  ).toBe(false)
})

test('tokens require a secure control endpoint and credentials are resolved again before fetch', async () => {
  const f = fixture({ link: 'ws://192.0.2.1:1234' })
  f.file('safe.txt', 'safe')
  const [denied] = await f.send('safe.txt')
  expect(denied!.reason).toBe('令牌只经加密链路下发')
  expect(f.calls.some(one => one.op === 'files.publish')).toBe(false)
  f.setLink('wss://node.example.invalid')
  f.setIntercept(async (node, op, args) => {
    if (op !== 'files.publish') return undefined
    const result = await f.hosts.get(node)!.handle(op, args, {
      peer: 'hub',
      actor: actor.subject,
      taskId: 'publish',
    })
    f.setRevoked(true)
    return result
  })
  const [revoked] = await f.send('safe.txt')
  expect(revoked!.reason).toBe('交换仓库连接已撤销')
  expect(f.calls.some(one => one.op === 'files.fetch')).toBe(false)
  expect(
    (
      await runGit(['ls-remote', f.remoteUrl, revoked!.exchange!.ref], {
        cwd: f.root,
      })
    ).stdout.length,
  ).toBeGreaterThan(0)
  f.setRevoked(false)
  await f.hub.cleanup()
  expect(
    (
      await runGit(['ls-remote', f.remoteUrl, revoked!.exchange!.ref], {
        cwd: f.root,
      })
    ).stdout.length,
  ).toBe(0)
})

test('retention and restart janitor delete failed refs without fetching objects; late timed-out publication is swept', async () => {
  const f = fixture({ retentionMs: 60_000 })
  f.file('retained.txt', 'retained')
  f.setIntercept(async (_node, op) =>
    op === 'files.fetch'
      ? { ok: false, code: 'timeout', message: 'unknown' }
      : undefined,
  )
  const [failed] = await f.send('retained.txt')
  expect(failed!.reason).toContain('结果未知')
  expect(failed!.exchange!.cleaned).toBe(false)
  expect(
    (
      await runGit(['ls-remote', f.remoteUrl, failed!.exchange!.ref], {
        cwd: f.root,
      })
    ).stdout.length,
  ).toBeGreaterThan(0)
  f.restart()
  await f.hub.cleanup()
  expect(value(await f.hub.snapshot()).transfers[0]!.exchange!.cleaned).toBe(
    false,
  )
  f.advance(60_000)
  f.setStopped(true)
  await f.hub.cleanup()
  expect(
    (
      await runGit(['ls-remote', f.remoteUrl, failed!.exchange!.ref], {
        cwd: f.root,
      })
    ).stdout.length,
  ).toBe(0)
  const audit = fs
    .readFileSync(path.join(f.root, 'hub', 'files.ndjson'), 'utf8')
    .trim()
    .split('\n')
    .map(line => JSON.parse(line))
  expect(audit.filter(row => row.kind === 'files.cleaned')).toHaveLength(1)
  expect(value(await f.hub.snapshot()).transfers[0]!.exchange!.commit).toBe(
    failed!.exchange!.commit,
  )
  await maliciousCommit(f, failed!.exchange!.ref, [
    { name: 'late', bytes: 'late push' },
  ])
  await f.hub.cleanup()
  expect(
    (
      await runGit(['ls-remote', f.remoteUrl, failed!.exchange!.ref], {
        cwd: f.root,
      })
    ).stdout.length,
  ).toBe(0)
  expect(fs.readdirSync(path.join(f.root, 'hub')).sort()).toEqual([
    'files.json',
    'files.ndjson',
  ])
})

test('git wrapper sees credentials only in the child environment and tokens never persist in configs, audits or ledgers', async () => {
  const f = fixture()
  const wrapperDir = path.join(f.root, 'bin'),
    log = path.join(f.root, 'git-argv.log')
  fs.mkdirSync(wrapperDir)
  fs.writeFileSync(
    path.join(wrapperDir, 'git'),
    `#!/bin/sh
printf '%s\\n' "$*" >> '${log}'
if [ -n "\${GIT_CONFIG_KEY_0:-}" ]; then printf 'credential-in-env\\n' >> '${log}'; fi
/usr/bin/git "$@"
result=$?
if [ -f .git/config ]; then cat .git/config >> '${log}'; fi
exit $result
`,
    { mode: 0o700 },
  )
  const previousPath = process.env.PATH
  try {
    process.env.PATH = `${wrapperDir}:${previousPath}`
    f.file('argv.txt', 'argv-safe-content')
    const [done] = await f.send('argv.txt')
    expect(fs.readFileSync(delivered(f, done!), 'utf8')).toBe(
      'argv-safe-content',
    )
    const recorded = fs.readFileSync(log, 'utf8')
    expect(recorded).toContain('credential-in-env')
    expect(recorded).toContain('fetch --depth=1')
    expect(recorded).not.toContain('checkout')
    expect(recorded).not.toContain(f.token)
    expect(recorded).not.toContain(
      Buffer.from(`x-access-token:${f.token}`).toString('base64'),
    )
    expect(recorded).not.toContain('extraHeader')
    const assertClean = (dir: string): void => {
      for (const name of fs.readdirSync(dir)) {
        const file = path.join(dir, name)
        if (fs.statSync(file).isDirectory()) assertClean(file)
        else expect(fs.readFileSync(file, 'utf8')).not.toContain(f.token)
      }
    }
    assertClean(path.join(f.root, 'hub'))
    for (const node of f.workspaces.keys())
      assertClean(path.join(f.root, `state-${node}`))
    const commit = (
      await runGit(['cat-file', '-p', done!.exchange!.commit!], {
        cwd: f.remote,
      })
    ).stdout.toString()
    expect(commit).not.toMatch(/^parent /m)
    const tree = (
      await runGit(['ls-tree', '-r', '--name-only', done!.exchange!.commit!], {
        cwd: f.remote,
      })
    ).stdout
      .toString()
      .trim()
      .split('\n')
    expect(tree).toEqual(['MANIFEST.json', 'files/argv.txt'])
  } finally {
    process.env.PATH = previousPath
  }
})

test('production visibility probe uses the repo API and fails closed for public, malformed, failed and rate-limited responses', async () => {
  const credential = {
    remoteUrl: 'https://github.com/owner/exchange.git',
    token: 'probe-token',
  }
  let response: Response | Error = Response.json({ private: true })
  const seen: { url: string; headers: Headers }[] = []
  spyOn(globalThis, 'fetch').mockImplementation(
    Object.assign(
      async (input: string | URL | Request, init?: RequestInit) => {
        seen.push({ url: String(input), headers: new Headers(init?.headers) })
        if (response instanceof Error) throw response
        return response
      },
      { preconnect: globalThis.fetch.preconnect },
    ),
  )
  expect(await probePrivateFilesRepo('owner/exchange', credential)).toBe(true)
  expect(seen[0]!.url).toBe('https://api.github.com/repos/owner/exchange')
  expect(seen[0]!.headers.get('authorization')).toBe('Bearer probe-token')
  response = Response.json({ private: false })
  expect(await probePrivateFilesRepo('owner/exchange', credential)).toBe(false)
  for (const invalid of [
    Response.json({}),
    Response.json({ private: 'true' }),
    new Response('', { status: 403 }),
    new Response('', { status: 429 }),
    new Error('secret-bearing network error'),
  ]) {
    response = invalid
    expect(await probePrivateFilesRepo('owner/exchange', credential)).toBe(null)
  }
  expect(filesRetention('0')).toBe(0)
  expect(filesRetention('30m')).toBe(1_800_000)
  expect(() => filesRetention('-1s')).toThrow()
  expect(() => filesRetention('999999999999999999d')).toThrow()
})

test('revoked before publish refuses without sending a token and a throwing credential adapter is contained', async () => {
  const f = fixture()
  f.file('revoked.txt', 'safe')
  f.setIntercept(async (_node, op, args) => {
    if (op === 'files.stat' && args.inspect === true && args.path === '')
      f.setRevoked(true)
    return undefined
  })
  const [failed] = await f.send('revoked.txt')
  expect(failed!.state).toBe('failed')
  expect(failed!.reason).toBe('交换仓库连接已撤销')
  expect(f.calls.some(one => one.op === 'files.publish')).toBe(false)
  const other = fixture({ credentialError: true })
  await expect(other.hub.initialize()).rejects.toThrow('connection-revoked')
})

test('target authorization is rechecked after fetching and before atomic delivery', async () => {
  const f = fixture()
  f.file('final-check.txt', 'safe')
  let checks = 0
  // NodeFiles calls the grant callback both before fetch and immediately before commit.
  const grantHandler = f.handler
  f.control.onHubCall('files', async (op, args, ctx) => {
    if (op === 'files.validate' && args.side === 'target' && ++checks === 2)
      f.setAllowed(false)
    return grantHandler(op, args, ctx)
  })
  const [failed] = await f.send('final-check.txt')
  expect(checks).toBe(2)
  expect(failed!.state).toBe('failed')
  expect(fs.existsSync(path.join(f.workspaces.get('beta')!, 'inbox'))).toBe(
    false,
  )
})

test('an immutable source snapshot survives workspace edits between snapshot creation and push', async () => {
  const f = fixture()
  f.file('snapshot.txt', 'immutable original')
  const grantHandler = f.handler
  let validations = 0
  f.control.onHubCall('files', async (op, args, ctx) => {
    if (
      op === 'files.validate' &&
      args.side === 'source' &&
      ++validations === 2
    )
      f.file('snapshot.txt', 'later workspace edit')
    return grantHandler(op, args, ctx)
  })
  const [done] = await f.send('snapshot.txt')
  expect(validations).toBe(2)
  expect(fs.readFileSync(delivered(f, done!), 'utf8')).toBe(
    'immutable original',
  )
  expect(
    fs.readFileSync(
      path.join(f.workspaces.get('alpha')!, 'snapshot.txt'),
      'utf8',
    ),
  ).toBe('later workspace edit')
})

test('restart removes incomplete snapshots with no transfer row and never replays a pending operation', async () => {
  const f = fixture()
  const id = crypto.randomUUID(),
    operationId = crypto.randomUUID()
  const directory = path.join(f.root, 'state-alpha'),
    bookPath = path.join(directory, 'operations.json')
  const stage = path.join(directory, id, 'source')
  fs.mkdirSync(stage, { recursive: true })
  fs.writeFileSync(path.join(stage, '0'), 'abandoned snapshot')
  const args = { transferId: id, operationId }
  const book = JSON.parse(fs.readFileSync(bookPath, 'utf8'))
  book.operations[`hub:${operationId}`] = {
    digest: sha256(
      JSON.stringify([
        'files.abort',
        { ...args, credential: undefined },
        actor.subject,
      ]),
    ),
    outcome: null,
  }
  fs.writeFileSync(bookPath, JSON.stringify(book))
  const restarted = new NodeFiles({
    node: 'alpha',
    agents: () => [{ agent: 'main', cwd: f.workspaces.get('alpha')! }],
    directory,
    stopped: () => false,
    hub: {
      call: async () => {
        throw new Error('must not be invoked')
      },
    },
  })
  expect(fs.existsSync(path.join(directory, id))).toBe(false)
  expect(
    await restarted.handle('files.abort', args, {
      peer: 'hub',
      actor: actor.subject,
      taskId: 'pending-replay',
    }),
  ).toMatchObject({ ok: false, code: 'result-unknown' })
})

test('regular executable blobs are accepted; orphan refs observe retention and the janitor audits their deletion', async () => {
  const f = fixture({ retentionMs: 1000 })
  f.file('safe.txt', 'safe')
  f.setIntercept(async (_node, op, args) => {
    if (op !== 'files.publish') return undefined
    const entries = [{ path: 'safe.txt', size: 4, sha256: sha256('safe') }],
      digest = manifestSha256(entries)
    const commit = await maliciousCommit(
      f,
      (args.exchange as { ref: string }).ref,
      [
        {
          name: 'MANIFEST.json',
          bytes: JSON.stringify({
            path: 'safe.txt',
            kind: 'file',
            entries,
            manifestSha256: digest,
          }),
        },
        { name: 'files/safe.txt', mode: '100755', bytes: 'safe' },
      ],
    )
    return {
      ok: true,
      value: { commit, manifestSha256: digest, files: 1, bytes: 4 },
    }
  })
  const [done] = await f.send('safe.txt')
  expect(fs.readFileSync(delivered(f, done!), 'utf8')).toBe('safe')
  const orphan = `refs/heads/qianmo/files/${crypto.randomUUID()}`
  await maliciousCommit(f, orphan, [{ name: 'MANIFEST.json', bytes: '{}' }])
  await f.hub.cleanup()
  expect(
    (await runGit(['ls-remote', f.remoteUrl, orphan], { cwd: f.root })).stdout
      .length,
  ).toBeGreaterThan(0)
  f.advance(1000)
  await f.hub.cleanup()
  expect(
    (await runGit(['ls-remote', f.remoteUrl, orphan], { cwd: f.root })).stdout
      .length,
  ).toBe(0)
  const audit = fs
    .readFileSync(path.join(f.root, 'hub', 'files.ndjson'), 'utf8')
    .trim()
    .split('\n')
    .map(line => JSON.parse(line))
  expect(
    audit
      .filter(row => row.kind === 'files.cleaned')
      .map(row => row.detail.ref)
      .sort(),
  ).toEqual([done!.exchange!.ref, orphan].sort())
})

test('hub restart discards legacy P20 staging without reading or retaining old file bytes', async () => {
  const f = fixture()
  f.file('legacy.txt', 'legacy transferred bytes')
  const [done] = await f.send('legacy.txt')
  const stage = path.join(f.root, 'hub', done!.transferId)
  fs.mkdirSync(stage)
  fs.writeFileSync(path.join(stage, '0'), 'legacy transferred bytes')
  f.restart()
  expect(fs.existsSync(stage)).toBe(false)
  expect(fs.readdirSync(path.join(f.root, 'hub')).sort()).toEqual([
    'files.json',
    'files.ndjson',
  ])
  expect(fs.readFileSync(delivered(f, done!), 'utf8')).toBe(
    'legacy transferred bytes',
  )
})

test('a node accepts only github.com exchange remotes; a file: remote needs the test-only switch', () => {
  const transferId = crypto.randomUUID()
  const args = (remoteUrl: string) => ({
    transferId,
    exchange: { remoteUrl, ref: `refs/heads/qianmo/files/${transferId}` },
    credential: { kind: 'github-token', token: 'test-token' },
  })
  expect(
    exchangeArgs(args('https://github.com/owner/exchange.git')).exchange
      .remoteUrl,
  ).toBe('https://github.com/owner/exchange.git')
  for (const remote of [
    'file:///tmp/exchange.git',
    'https://example.com/owner/exchange.git',
    'https://github.com:8443/owner/exchange.git',
    'https://user@github.com/owner/exchange.git',
    'http://github.com/owner/exchange.git',
  ])
    expect(() => exchangeArgs(args(remote))).toThrow()
  expect(
    exchangeArgs(args('file:///tmp/exchange.git'), true).exchange.remoteUrl,
  ).toBe('file:///tmp/exchange.git')
})
