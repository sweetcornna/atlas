// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Installing catalog runtimes (P31, P36.3): a version is installed into a
 * staged tree of its own, and only that same tree goes live after it passed
 * the compatibility check; one that fails leaves the node on what it had and
 * says why. No Node.js in
 * range, or too little disk, and nothing starts at all.
 */

import { afterEach, beforeEach, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import * as path from 'node:path'
import { qianmoConfigPath } from '@qianmo/paths'
import type { ControlContext } from '../../src/host/control.js'
import {
  managedRuntimeBin,
  managedRuntimePrefix,
  managedRuntimeTree,
  type RunCommand,
  RuntimeInstaller,
  runCommand,
  runtimeControl,
  satisfiesVersionRange,
} from '../../src/host/runtimeUpdate.js'
import {
  RUNTIME_CATALOG,
  runtimeSpec,
} from '../../src/host/runtimes/catalog.js'
import type { RuntimeVersionsReply } from '../../src/host/runtimes/contract.js'
import { isolatedRoot } from '../providers/fake.js'

const CTX: ControlContext = { peer: 'hub', actor: 'updates', taskId: 't' }
const PIN = (id: string) => {
  const spec = runtimeSpec(id)!
  if (spec.install.kind !== 'npm') throw new Error(`${id} is built in`)
  return spec.install.pin
}

let root: ReturnType<typeof isolatedRoot>
beforeEach(() => {
  root = isolatedRoot()
})
afterEach(() => root.dispose())

/** A stand-in npm: `install` lays out the package's bin, `uninstall` removes it. */
function fakeNpm(
  installed: string,
  options: { node?: string | null; failInstall?: boolean } = {},
): {
  run: RunCommand
  prefixes: string[]
  calls: string[][]
  envs: Record<string, string>[]
} {
  const prefixes: string[] = []
  const calls: string[][] = []
  const envs: Record<string, string>[] = []
  const commandOf = (spec: string) =>
    RUNTIME_CATALOG.flatMap(entry =>
      entry.install.kind === 'npm' &&
      spec.startsWith(`${entry.install.package}@`)
        ? [entry.install.command]
        : [],
    )[0]
  return {
    prefixes,
    calls,
    envs,
    run: async (argv, run) => {
      calls.push([...argv])
      envs.push(run.env)
      if (argv[0] === 'node') {
        const node = options.node === undefined ? 'v24.1.0' : options.node
        return node === null
          ? { code: 127, stdout: '' }
          : { code: 0, stdout: `${node}\n` }
      }
      const prefix = argv[argv.indexOf('--prefix') + 1]!
      if (argv[1] === 'install') {
        prefixes.push(prefix)
        if (options.failInstall) return { code: 1, stdout: 'E404' }
        const bin = path.join(prefix, 'node_modules', '.bin')
        mkdirSync(bin, { recursive: true })
        writeFileSync(path.join(bin, commandOf(argv.at(-1)!)!), '')
        // npm 11 warns about blocked install scripts; that is not a failure.
        return { code: 0, stdout: 'npm warn blocked install scripts (5)' }
      }
      if (argv[1] === 'uninstall') {
        const command = RUNTIME_CATALOG.find(
          entry =>
            entry.install.kind === 'npm' &&
            entry.install.package === argv.at(-1),
        )
        if (command?.install.kind === 'npm')
          rmSync(
            path.join(prefix, 'node_modules', '.bin', command.install.command),
            { force: true },
          )
        return { code: 0, stdout: '' }
      }
      return { code: 0, stdout: `${installed} (Claude Code)` }
    },
  }
}

const roomy = () => 64 * 1024 * 1024 * 1024
const nowhere = () => null

test('a version that fails the check is not installed, and the update says why (P32 ruling 3)', async () => {
  const npm = fakeNpm('2.2.0')
  const checked: string[] = []
  const installed: string[] = []
  const control = runtimeControl({
    run: npm.run,
    freeBytes: roomy,
    smoke: async (kind, bin) => {
      checked.push(`${kind} ${bin}`)
      return '没有连上 qianmo 工具桥（failed）'
    },
    onInstalled: kind => installed.push(kind),
  })
  const outcome = await control(
    'runtime.update',
    {
      runtime: 'claude-code',
      version: '2.2.0',
    },
    CTX,
  )
  expect(outcome).toEqual({
    ok: false,
    code: 'E_RUNTIME_INSTALL',
    message:
      '2.2.0 没有通过兼容检查，节点继续用原来的版本：没有连上 qianmo 工具桥（failed）',
  })
  // Only the staged tree got it, and it is gone again.
  expect(npm.prefixes).toHaveLength(1)
  expect(path.dirname(npm.prefixes[0]!)).toBe(
    qianmoConfigPath('runtimes', 'trees'),
  )
  expect(existsSync(npm.prefixes[0]!)).toBe(false)
  expect(checked).toEqual([
    `claude-code ${path.join(npm.prefixes[0]!, 'node_modules', '.bin', 'claude')}`,
  ])
  expect(installed).toEqual([])
  expect(managedRuntimeBin('claude-code')).toBeUndefined()
  expect(readdirSync(qianmoConfigPath('runtimes', 'trees'))).toEqual([])
})

test('a version that passes goes live as the very tree that was checked, without a second npm install', async () => {
  const npm = fakeNpm('0.170.0')
  const installed: string[] = []
  const control = runtimeControl({
    // Each installed binary answers `--version` with the version put there.
    run: async (argv, options) => {
      if (argv[0] !== 'npm')
        return argv[0] === 'node'
          ? npm.run(argv, options)
          : { code: 0, stdout: `codex-cli ${readFileSync(argv[0]!, 'utf8')}` }
      const result = await npm.run(argv, options)
      if (argv[1] === 'install')
        writeFileSync(
          path.join(
            argv[argv.indexOf('--prefix') + 1]!,
            'node_modules',
            '.bin',
            'codex',
          ),
          argv.at(-1)!.split('@').pop()!,
        )
      return result
    },
    freeBytes: roomy,
    smoke: async () => null,
    onInstalled: kind => installed.push(kind),
  })
  const outcome = await control(
    'runtime.update',
    {
      runtime: 'codex',
      version: '0.170.0',
    },
    CTX,
  )
  expect(outcome).toEqual({
    ok: true,
    value: { runtime: 'codex', version: '0.170.0' },
  })
  expect(npm.prefixes).toHaveLength(1)
  expect(installed).toEqual(['codex'])
  expect(managedRuntimeBin('codex')).toBe(
    path.join(managedRuntimeTree('codex'), 'node_modules', '.bin', 'codex'),
  )
  const first = readlinkSync(managedRuntimeTree('codex'))
  expect(first).toStartWith('codex-')
  // Another version: the link moves; the tree it replaced stays one install
  // (a process may still run from it), the one before goes.
  const again = async (next: string) => {
    const result = await control(
      'runtime.update',
      { runtime: 'codex', version: next },
      CTX,
    )
    expect(result.ok).toBe(true)
  }
  await again('0.171.0')
  const second = readlinkSync(managedRuntimeTree('codex'))
  expect(second).not.toBe(first)
  expect(readdirSync(qianmoConfigPath('runtimes', 'trees')).sort()).toEqual(
    ['codex', first, second].sort(),
  )
  await again('0.172.0')
  const third = readlinkSync(managedRuntimeTree('codex'))
  expect(readdirSync(qianmoConfigPath('runtimes', 'trees')).sort()).toEqual(
    ['codex', second, third].sort(),
  )
  // npm's cache, config and HOME are the node's, never the user's.
  for (const env of npm.envs) {
    expect(env.HOME!.startsWith(qianmoConfigPath('runtimes'))).toBe(true)
    expect(env.npm_config_cache!.startsWith(managedRuntimePrefix())).toBe(true)
    expect(env.npm_config_userconfig!.startsWith(managedRuntimePrefix())).toBe(
      true,
    )
    expect(env.npm_config_cache!.startsWith(path.join(homedir(), '.npm'))).toBe(
      false,
    )
  }
})

test('a scratch install of another version than asked is refused before the check', async () => {
  const npm = fakeNpm('2.1.0')
  let checked = false
  const control = runtimeControl({
    run: npm.run,
    freeBytes: roomy,
    smoke: async () => {
      checked = true
      return null
    },
  })
  const outcome = await control(
    'runtime.update',
    {
      runtime: 'claude-code',
      version: '2.2.0',
    },
    CTX,
  )
  expect(outcome.ok).toBe(false)
  expect(checked).toBe(false)
  expect(npm.prefixes).toHaveLength(1)
})

test('runtime.install without a version installs the catalog pin, DeepSeek Harness included', async () => {
  const pin = PIN('dsh')
  const npm = fakeNpm(pin)
  const smoked: string[] = []
  const installer = new RuntimeInstaller({
    run: npm.run,
    freeBytes: roomy,
    which: nowhere,
    smoke: async kind => {
      smoked.push(kind)
      return null
    },
  })
  const outcome = await installer.control(
    'runtime.install',
    { runtime: 'dsh' },
    CTX,
  )
  expect(outcome).toEqual({ ok: true, value: { runtime: 'dsh', version: pin } })
  expect(smoked).toEqual(['dsh'])
  expect(
    npm.calls.filter(argv => argv[1] === 'install').map(argv => argv.at(-1)),
  ).toEqual([`@deepseek-ai/dsh@${pin}`])
  // Node.js was checked before anything was downloaded.
  expect(npm.calls[0]).toEqual(['node', '--version'])
  expect(installer.availability('dsh')).toEqual({
    installed: true,
    source: 'prefix',
    bin: managedRuntimeBin('dsh'),
  })
  // The result is kept, privately, across restarts.
  const file = qianmoConfigPath('runtimes', 'installs.json')
  expect(statSync(file).mode & 0o777).toBe(0o600)
  expect(new RuntimeInstaller({}).lastInstall('dsh')).toMatchObject({
    ok: true,
    version: pin,
  })
})

test('no Node.js in range: nothing is downloaded, the install says so (no-node)', async () => {
  // The catalog's range (`needsNode`) decides; v18 is outside any of them.
  for (const node of [null, 'v18.20.4']) {
    const npm = fakeNpm(PIN('dsh'), { node })
    const installer = new RuntimeInstaller({
      run: npm.run,
      freeBytes: roomy,
      which: nowhere,
      smoke: async () => null,
    })
    const result = await installer.install('dsh')
    expect(result).toMatchObject({
      ok: false,
      code: 'E_RUNTIME_INSTALL',
      fallback: 'no-node',
    })
    expect(result.ok ? '' : result.message).toStartWith('缺少 Node.js')
    expect(npm.calls.every(argv => argv[0] === 'node')).toBe(true)
    expect(installer.lastInstall('dsh')).toMatchObject({
      ok: false,
      code: 'no-node',
    })
  }
})

test('too little disk: the install never starts, and says how much it needs', async () => {
  const npm = fakeNpm(PIN('dsh'))
  const asked: string[] = []
  const installer = new RuntimeInstaller({
    run: npm.run,
    which: nowhere,
    smoke: async () => null,
    freeBytes: dir => {
      asked.push(dir)
      return 1024 * 1024 * 1024
    },
  })
  const result = await installer.install('dsh')
  expect(result).toEqual({
    ok: false,
    code: 'E_RUNTIME_INSTALL',
    message: '磁盘空间不足（需要约 2048 MiB）',
    fallback: 'install-failed',
  })
  expect(asked).toEqual([qianmoConfigPath('runtimes')])
  expect(npm.calls.filter(argv => argv[0] !== 'node')).toEqual([])
  // Other runtimes need less: 1 GiB is enough for Codex.
  const codex = new RuntimeInstaller({
    run: fakeNpm('0.170.0').run,
    which: nowhere,
    smoke: async () => null,
    freeBytes: () => 1024 * 1024 * 1024,
  })
  expect(await codex.install('codex', '0.170.0')).toEqual({
    ok: true,
    version: '0.170.0',
  })
})

test('Node.js ranges: ||, ^, ~, >= and partial versions', () => {
  const range = '^22.19.0 || >=24'
  expect(satisfiesVersionRange('v22.18.0', range)).toBe(false)
  expect(satisfiesVersionRange('v22.19.0', range)).toBe(true)
  expect(satisfiesVersionRange('22.30.1', range)).toBe(true)
  expect(satisfiesVersionRange('v23.11.0', range)).toBe(false)
  expect(satisfiesVersionRange('v24.0.0', range)).toBe(true)
  expect(satisfiesVersionRange('v26.3.0', range)).toBe(true)
  expect(satisfiesVersionRange('v21.9.9', '>=22')).toBe(false)
  expect(satisfiesVersionRange('v22.0.0', '>=22')).toBe(true)
  expect(satisfiesVersionRange('v22.0.0', '>= 22.0.0 <23')).toBe(true)
  expect(satisfiesVersionRange('v23.0.0', '>= 22.0.0 <23')).toBe(false)
  expect(satisfiesVersionRange('v22.4.9', '~22.4')).toBe(true)
  expect(satisfiesVersionRange('v22.5.0', '~22.4')).toBe(false)
  expect(satisfiesVersionRange('v0.3.9', '^0.3.1')).toBe(true)
  expect(satisfiesVersionRange('v0.4.0', '^0.3.1')).toBe(false)
  expect(satisfiesVersionRange('v20.1.0', '20')).toBe(true)
  expect(satisfiesVersionRange('v20.1.0', 'banana')).toBe(false)
  expect(satisfiesVersionRange('not a version', '>=1')).toBe(false)
})

test('runtime.versions lists every catalog entry: built in, managed, on PATH, from a flag', async () => {
  const npm = fakeNpm('0.170.0')
  const installer = new RuntimeInstaller({
    run: npm.run,
    freeBytes: roomy,
    bins: { 'claude-code': '/opt/claude/bin/claude' },
    which: command => (command === 'dsh' ? '/usr/local/bin/dsh' : null),
    smoke: async () => null,
    defaultRuntime: () => 'dsh',
  })
  expect((await installer.install('codex', '0.170.0')).ok).toBe(true)
  const outcome = await installer.control('runtime.versions', {}, CTX)
  expect(outcome.ok).toBe(true)
  const reply = (outcome as { value: RuntimeVersionsReply }).value
  expect(reply.defaultRuntime).toBe('dsh')
  expect(reply.runtimes.map(row => row.id)).toEqual(
    RUNTIME_CATALOG.map(spec => spec.id),
  )
  const row = (id: string) => reply.runtimes.find(one => one.id === id)!
  expect(row('omp')).toMatchObject({
    installed: true,
    source: 'builtin',
    installing: false,
  })
  expect(row('omp').pin).toBeUndefined()
  expect(row('codex')).toMatchObject({
    installed: true,
    source: 'prefix',
    version: '0.170.0',
    pin: PIN('codex'),
    lastInstall: { ok: true, version: '0.170.0' },
  })
  // The failure code stays on the node; the wire has what the contract says.
  expect(Object.keys(row('codex').lastInstall!).sort()).toEqual([
    'at',
    'ok',
    'version',
  ])
  expect(row('claude-code')).toMatchObject({ installed: true, source: 'flag' })
  expect(row('dsh')).toMatchObject({
    installed: true,
    source: 'path',
    pin: PIN('dsh'),
  })
})

test('a second install of the same runtime is refused while one runs; ensureRuntimeInstalled joins it', async () => {
  const npm = fakeNpm(PIN('codex'))
  let release!: () => void
  const gate = new Promise<void>(done => {
    release = done
  })
  const installer = new RuntimeInstaller({
    run: npm.run,
    freeBytes: roomy,
    which: nowhere,
    smoke: async () => {
      await gate
      return null
    },
  })
  const changes: string[] = []
  installer.onChange(kind =>
    changes.push(`${kind}:${installer.installing(kind)}`),
  )
  const first = installer.install('codex')
  expect(installer.installing('codex')).toBe(true)
  expect(await installer.install('codex')).toMatchObject({
    ok: false,
    code: 'E_RUNTIME_BUSY',
  })
  const joined = installer.ensureRuntimeInstalled('codex')
  release()
  expect(await first).toEqual({ ok: true, version: PIN('codex') })
  expect(await joined).toEqual({ ok: true, version: PIN('codex') })
  expect(changes).toEqual(['codex:true', 'codex:false'])
  // Installed now: nothing more to do.
  expect(await installer.ensureRuntimeInstalled('codex')).toEqual({ ok: true })
})

test('runtime.remove: refused for qianmopi, for unknown ids and while agents use it; else only what the node installed', async () => {
  const npm = fakeNpm('0.170.0')
  let users: string[] = ['coder', 'writer']
  const installer = new RuntimeInstaller({
    run: npm.run,
    freeBytes: roomy,
    which: nowhere,
    smoke: async () => null,
    inUse: () => users,
  })
  expect((await installer.install('codex', '0.170.0')).ok).toBe(true)
  expect(
    await installer.control('runtime.remove', { runtime: 'omp' }, CTX),
  ).toMatchObject({
    ok: false,
    code: 'E_RUNTIME_BUILTIN',
  })
  expect(
    await installer.control('runtime.remove', { runtime: 'vim' }, CTX),
  ).toMatchObject({ ok: false, code: 'E_RUNTIME_UNKNOWN' })
  const busy = await installer.control(
    'runtime.remove',
    { runtime: 'codex' },
    CTX,
  )
  expect(busy).toMatchObject({ ok: false, code: 'E_RUNTIME_IN_USE' })
  expect(busy.ok ? '' : busy.message).toContain('coder、writer')
  expect(managedRuntimeBin('codex')).toBeDefined()
  users = []
  expect(
    await installer.control('runtime.remove', { runtime: 'codex' }, CTX),
  ).toEqual({ ok: true, value: { runtime: 'codex', removed: true } })
  expect(readdirSync(qianmoConfigPath('runtimes', 'trees'))).toEqual([])
  expect(managedRuntimeBin('codex')).toBeUndefined()
  expect(installer.availability('codex').installed).toBe(false)
  // Nothing of it left to remove.
  expect(
    await installer.control('runtime.remove', { runtime: 'codex' }, CTX),
  ).toEqual({ ok: true, value: { runtime: 'codex', removed: false } })
  // An earlier build's install in the shared prefix is found and removed
  // with npm there.
  const legacy = path.join(managedRuntimePrefix(), 'node_modules', '.bin')
  mkdirSync(legacy, { recursive: true })
  writeFileSync(path.join(legacy, 'codex'), '')
  expect(managedRuntimeBin('codex')).toBe(path.join(legacy, 'codex'))
  expect(
    await installer.control('runtime.remove', { runtime: 'codex' }, CTX),
  ).toEqual({ ok: true, value: { runtime: 'codex', removed: true } })
  expect(npm.calls.at(-1)!.slice(0, 4)).toEqual([
    'npm',
    'uninstall',
    '--prefix',
    managedRuntimePrefix(),
  ])
  expect(managedRuntimeBin('codex')).toBeUndefined()
})

test('a command that writes a lot to stderr still finishes', async () => {
  const result = await runCommand(
    [
      process.execPath,
      '-e',
      "process.stderr.write('x'.repeat(4 * 1024 * 1024)); console.log('done')",
    ],
    {
      env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin' },
      timeoutMs: 20_000,
    },
  )
  expect(result).toMatchObject({ code: 0, stdout: 'done\n' })
})

test('installs of two runtimes run one after the other, never together', async () => {
  const npm = fakeNpm(PIN('gemini'))
  let running = 0
  let most = 0
  const installer = new RuntimeInstaller({
    run: async (argv, options) => {
      running += 1
      most = Math.max(most, running)
      await Bun.sleep(5)
      try {
        return await npm.run(argv, options)
      } finally {
        running -= 1
      }
    },
    freeBytes: roomy,
    which: nowhere,
    smoke: async () => null,
  })
  const [a, b] = await Promise.all([
    installer.install('gemini'),
    installer.install('qwen'),
  ])
  expect(installer.installing('qwen')).toBe(false)
  expect(most).toBe(1)
  expect(a.ok).toBe(true)
  expect(npm.calls.some(argv => argv.at(-1)?.startsWith('@qwen-code/'))).toBe(
    true,
  )
  expect(b.ok ? 'ok' : b.message).toContain('不是')
})

test('a runtime given by flag is the operator’s: never installed or removed here', async () => {
  const npm = fakeNpm('2.2.0')
  const installer = new RuntimeInstaller({
    run: npm.run,
    freeBytes: roomy,
    bins: { codex: 'codex-nightly' },
    smoke: async () => null,
  })
  for (const op of ['runtime.install', 'runtime.update', 'runtime.remove'])
    expect(
      await installer.control(op, { runtime: 'codex' }, CTX),
    ).toMatchObject({ ok: false, code: 'refused' })
  expect(
    await installer.control(
      'runtime.install',
      { runtime: 'claude-code', version: 'latest' },
      CTX,
    ),
  ).toMatchObject({ ok: false, code: 'invalid' })
  expect(npm.calls).toEqual([])
})

test('stopping the node ends a running install without recording a verdict', async () => {
  let started!: () => void
  const running = new Promise<void>(done => {
    started = done
  })
  const installer = new RuntimeInstaller({
    freeBytes: roomy,
    which: nowhere,
    smoke: async () => null,
    run: async (argv, options) => {
      if (argv[0] === 'node') return { code: 0, stdout: 'v24.1.0' }
      started()
      // npm runs until the node stops and kills it.
      await new Promise(done =>
        options.signal?.addEventListener('abort', done, { once: true }),
      )
      return { code: 143, stdout: '' }
    },
  })
  const install = installer.install('dsh')
  await running
  installer.stop()
  expect(await install).toMatchObject({ ok: false })
  expect(installer.lastInstall('dsh')).toBeUndefined()
  expect(installer.installing('dsh')).toBe(false)
})
