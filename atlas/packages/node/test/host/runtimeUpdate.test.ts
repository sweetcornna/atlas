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
import { randomUUID } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import * as path from 'node:path'
import { qianmoConfigPath } from '@qianmo/paths'
import type { ControlContext } from '../../src/host/control.js'
import {
  availableMemoryBytes,
  INSTALL_MEMORY_MIB,
  managedRuntimeBin,
  managedRuntimePrefix,
  managedRuntimeTree,
  memAvailableBytes,
  type RunCommand,
  RuntimeInstaller,
  runCommand,
  runtimeControl,
  satisfiesVersionRange,
  VERSION_CACHE_MS,
  vmStatAvailableBytes,
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
      // A dsh found on PATH is asked who it is (DeepSeek Harness names itself).
      if (argv[1] === '--help') return { code: 0, stdout: DEEPSEEK_DSH_HELP }
      return { code: 0, stdout: `${installed} (Claude Code)` }
    },
  }
}

/** Disk or memory: plenty, whatever the machine running the test has. */
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
    freeMemoryBytes: roomy,
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
      freeMemoryBytes: roomy,
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
    freeMemoryBytes: roomy,
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
    freeMemoryBytes: roomy,
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

test('too little free memory: the default install never starts and says how much it needs and has; an operator’s install or update goes ahead', async () => {
  const npm = fakeNpm(PIN('dsh'))
  const low = () => 1024 * 1024 * 1024
  const installer = new RuntimeInstaller({
    run: npm.run,
    which: nowhere,
    smoke: async () => null,
    freeBytes: roomy,
    freeMemoryBytes: low,
  })
  // The default install (`ensureRuntimeInstalled`) waits for memory.
  expect(await installer.ensureRuntimeInstalled('dsh')).toEqual({
    ok: false,
    code: 'E_RUNTIME_INSTALL',
    message: `可用内存不足（安装需要约 ${INSTALL_MEMORY_MIB} MiB，现有 1024 MiB），稍后重试`,
    fallback: 'install-failed',
  })
  // Nothing downloaded, nothing staged; the refusal is a recorded failure.
  expect(npm.calls.filter(argv => argv[0] !== 'node')).toEqual([])
  expect(installer.lastInstall('dsh')).toMatchObject({
    ok: false,
    code: 'install-failed',
  })
  expect(INSTALL_MEMORY_MIB).toBe(1536)
  // `runtime.install` and `runtime.update` are the operator's call: the
  // memory floor does not apply (p3 has about 1 GiB available).
  for (const op of ['runtime.install', 'runtime.update'])
    expect(
      await new RuntimeInstaller({
        run: npm.run,
        which: nowhere,
        smoke: async () => null,
        freeBytes: roomy,
        freeMemoryBytes: low,
      }).control(op, { runtime: 'dsh' }, CTX),
    ).toEqual({ ok: true, value: { runtime: 'dsh', version: PIN('dsh') } })
  // On disk now: a success (each installer keeps its own copy in memory).
  expect(new RuntimeInstaller({}).lastInstall('dsh')).toMatchObject({
    ok: true,
  })
  // Disk still applies to them (nothing installed this time).
  rmSync(qianmoConfigPath('runtimes', 'trees'), {
    recursive: true,
    force: true,
  })
  expect(
    await new RuntimeInstaller({
      run: npm.run,
      which: nowhere,
      smoke: async () => null,
      freeBytes: () => 1024 * 1024 * 1024,
      freeMemoryBytes: low,
    }).install('dsh'),
  ).toMatchObject({ ok: false, message: '磁盘空间不足（需要约 2048 MiB）' })
  const enough = new RuntimeInstaller({
    run: npm.run,
    which: nowhere,
    smoke: async () => null,
    freeBytes: roomy,
    freeMemoryBytes: () => INSTALL_MEMORY_MIB * 1024 * 1024,
  })
  expect(await enough.ensureRuntimeInstalled('dsh')).toEqual({
    ok: true,
    version: PIN('dsh'),
  })
})

test('free memory is MemAvailable from /proc/meminfo, in bytes', () => {
  expect(
    memAvailableBytes(
      'MemTotal:        2014256 kB\nMemFree:          101232 kB\nMemAvailable:     812345 kB\n',
    ),
  ).toBe(812_345 * 1024)
  // Kernels before 3.14 have no MemAvailable: the caller falls back.
  expect(memAvailableBytes('MemTotal: 2014256 kB\nMemFree: 1 kB\n')).toBe(
    undefined,
  )
  expect(availableMemoryBytes()).toBeGreaterThan(0)
})

test('on macOS it is the free, inactive and speculative pages vm_stat counts', () => {
  const vmStat = [
    'Mach Virtual Memory Statistics: (page size of 16384 bytes)',
    'Pages free:                                    17325.',
    'Pages active:                                 502750.',
    'Pages inactive:                               497605.',
    'Pages speculative:                              4241.',
    'Pages wired down:                             205667.',
  ].join('\n')
  expect(vmStatAvailableBytes(vmStat)).toBe((17_325 + 497_605 + 4_241) * 16_384)
  expect(vmStatAvailableBytes('Pages free: 1.')).toBeUndefined()
})

test('scratch prefixes a dead node left behind are swept: npm-stage-<uuid> directories under the runtimes root only, never through a link', async () => {
  const runtimes = qianmoConfigPath('runtimes')
  const stage = () => path.join(runtimes, `npm-stage-${randomUUID()}`)
  const outside = mkdtempSync(path.join(tmpdir(), 'qm-sweep-outside-'))
  try {
    writeFileSync(path.join(outside, 'keep'), 'x')
    const stale = stage()
    mkdirSync(path.join(stale, 'node_modules', '.bin'), { recursive: true })
    writeFileSync(path.join(stale, 'node_modules', '.bin', 'dsh'), '')
    // A link inside a stale stage goes with it; what it points at stays.
    symlinkSync(outside, path.join(stale, 'node_modules', 'linked'))
    const link = stage()
    symlinkSync(outside, link)
    const file = stage()
    writeFileSync(file, '')
    const lookalike = path.join(runtimes, 'npm-stage-notauuid')
    mkdirSync(lookalike)
    const elsewhere = qianmoConfigPath('qianmo', `npm-stage-${randomUUID()}`)
    mkdirSync(elsewhere, { recursive: true })
    mkdirSync(managedRuntimePrefix(), { recursive: true })
    const installer = new RuntimeInstaller({ which: nowhere })
    expect(await installer.sweepStages()).toEqual([stale])
    expect(existsSync(stale)).toBe(false)
    expect(readFileSync(path.join(outside, 'keep'), 'utf8')).toBe('x')
    expect(lstatSync(link).isSymbolicLink()).toBe(true)
    expect(existsSync(file)).toBe(true)
    expect(existsSync(lookalike)).toBe(true)
    expect(existsSync(elsewhere)).toBe(true)
    expect(existsSync(managedRuntimePrefix())).toBe(true)
    // Nothing there (a fresh node): nothing to do.
    rmSync(runtimes, { recursive: true, force: true })
    expect(await installer.sweepStages()).toEqual([])
  } finally {
    rmSync(outside, { recursive: true, force: true })
  }
})

test('an operator’s install waits for a sweep in progress before it checks the disk', async () => {
  const stale = path.join(
    qianmoConfigPath('runtimes'),
    `npm-stage-${randomUUID()}`,
  )
  mkdirSync(stale, { recursive: true })
  const events: string[] = []
  let release!: () => void
  const released = new Promise<void>(done => {
    release = done
  })
  const installer = new RuntimeInstaller({
    run: fakeNpm('0.170.0').run,
    which: nowhere,
    smoke: async () => null,
    freeMemoryBytes: roomy,
    freeBytes: () => {
      events.push('disk')
      return roomy()
    },
    removeTree: async dir => {
      if (dir === stale) await released
      rmSync(dir, { recursive: true, force: true })
      events.push(`removed ${path.basename(dir)}`)
    },
  })
  const sweeping = installer.sweepStages()
  const install = installer.install('codex', '0.170.0')
  for (let i = 0; i < 20; i++) await Bun.sleep(5)
  expect(events).toEqual([])
  release()
  expect(await install).toEqual({ ok: true, version: '0.170.0' })
  expect(await sweeping).toEqual([stale])
  expect(events.slice(0, 2)).toEqual([
    `removed ${path.basename(stale)}`,
    'disk',
  ])
})

test('staged trees and unswapped links a dead node left are swept; live trees, their links and lookalikes stay', async () => {
  const trees = qianmoConfigPath('runtimes', 'trees')
  const outside = mkdtempSync(path.join(tmpdir(), 'qm-sweep-outside-'))
  try {
    writeFileSync(path.join(outside, 'keep'), 'x')
    mkdirSync(trees, { recursive: true })
    const stale = path.join(trees, `.stage-dsh-${randomUUID()}`)
    mkdirSync(path.join(stale, 'node_modules'), { recursive: true })
    symlinkSync(outside, path.join(stale, 'node_modules', 'linked'))
    const live = path.join(trees, `dsh-${randomUUID()}`)
    mkdirSync(live)
    symlinkSync(live, managedRuntimeTree('dsh'))
    const pending = path.join(trees, `.dsh.link-${randomUUID()}`)
    symlinkSync(outside, pending)
    const linkedStage = path.join(trees, `.stage-qwen-${randomUUID()}`)
    symlinkSync(outside, linkedStage)
    const pendingDir = path.join(trees, `.qwen.link-${randomUUID()}`)
    mkdirSync(pendingDir)
    const lookalike = path.join(trees, '.stage-dsh-notauuid')
    mkdirSync(lookalike)
    const installer = new RuntimeInstaller({ which: nowhere })
    expect((await installer.sweepStages()).sort()).toEqual(
      [pending, stale].sort(),
    )
    expect(existsSync(stale)).toBe(false)
    expect(existsSync(pending)).toBe(false)
    expect(readFileSync(path.join(outside, 'keep'), 'utf8')).toBe('x')
    expect(existsSync(live)).toBe(true)
    expect(readlinkSync(managedRuntimeTree('dsh'))).toBe(live)
    expect(lstatSync(linkedStage).isSymbolicLink()).toBe(true)
    expect(existsSync(pendingDir)).toBe(true)
    expect(existsSync(lookalike)).toBe(true)
  } finally {
    rmSync(outside, { recursive: true, force: true })
  }
})

test('a failed or stopped install leaves no scratch prefix', async () => {
  const stages = () => {
    try {
      return readdirSync(qianmoConfigPath('runtimes', 'trees')).filter(name =>
        name.startsWith('.stage-'),
      )
    } catch {
      return []
    }
  }
  const failing = new RuntimeInstaller({
    run: fakeNpm(PIN('dsh'), { failInstall: true }).run,
    freeBytes: roomy,
    freeMemoryBytes: roomy,
    which: nowhere,
    smoke: async () => null,
  })
  expect((await failing.install('dsh')).ok).toBe(false)
  expect(stages()).toEqual([])
  let started!: () => void
  const running = new Promise<void>(done => {
    started = done
  })
  const stopped = new RuntimeInstaller({
    freeBytes: roomy,
    freeMemoryBytes: roomy,
    which: nowhere,
    smoke: async () => null,
    run: async (argv, options) => {
      if (argv[0] === 'node') return { code: 0, stdout: 'v24.1.0' }
      // npm has started filling the scratch prefix when the node stops.
      const prefix = argv[argv.indexOf('--prefix') + 1]!
      mkdirSync(path.join(prefix, 'node_modules'), { recursive: true })
      started()
      await new Promise(done =>
        options.signal?.addEventListener('abort', done, { once: true }),
      )
      return { code: 143, stdout: '' }
    },
  })
  const install = stopped.install('dsh')
  await running
  expect(stages()).toHaveLength(1)
  // A sweep while it runs leaves it alone.
  expect(await stopped.sweepStages()).toEqual([])
  stopped.stop()
  expect((await install).ok).toBe(false)
  expect(stages()).toEqual([])
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
    freeMemoryBytes: roomy,
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

test('runtime.versions asks each binary once per ten minutes: reads together share it, an install, a removal or another binary asks again', async () => {
  let now = 1_000_000
  let codexOnPath: string | null = '/usr/local/bin/codex'
  const npm = fakeNpm('0.170.0')
  const installer = new RuntimeInstaller({
    run: npm.run,
    freeBytes: roomy,
    freeMemoryBytes: roomy,
    bins: { 'claude-code': '/opt/claude/bin/claude', dsh: '/opt/dsh/bin/dsh' },
    which: command => (command === 'codex' ? codexOnPath : null),
    smoke: async () => null,
    now: () => now,
  })
  const asked = () => npm.calls.filter(argv => argv[1] === '--version').length
  const [one, two] = await Promise.all([
    installer.versions(),
    installer.versions(),
  ])
  // dsh, Claude Code and Codex: one process each, for both reads.
  expect(asked()).toBe(3)
  expect(two).toEqual(one)
  expect(one.runtimes.find(row => row.id === 'codex')?.version).toBe('0.170.0')
  await installer.versions()
  expect(asked()).toBe(3)
  now += VERSION_CACHE_MS - 1
  await installer.versions()
  expect(asked()).toBe(3)
  now += 1
  await installer.versions()
  expect(asked()).toBe(6)
  // Another binary on PATH is another answer.
  codexOnPath = '/opt/homebrew/bin/codex'
  await installer.versions()
  expect(asked()).toBe(7)
  // An install puts a new binary in place: only that runtime is asked again.
  expect((await installer.install('codex', '0.170.0')).ok).toBe(true)
  const installed = asked()
  await installer.versions()
  expect(asked()).toBe(installed + 1)
  await installer.versions()
  expect(asked()).toBe(installed + 1)
  // Removed: back to the PATH one, asked anew.
  expect(await installer.remove('codex')).toMatchObject({ ok: true })
  await installer.versions()
  expect(asked()).toBe(installed + 2)
})

/** What Debian's `dsh` (distributed shell) answers; DeepSeek Harness's own `--help` names it. */
const DEBIAN_DSH =
  "Distributed Shell / Dancer's shell. version 0.25.10\nUsage: dsh [-v|-q] [-M|-H] [-i|-c] [-b n] [-a] [-g groupname] [-f filename] [-r remoteshellname] [commandline]\n"
const DEEPSEEK_DSH_HELP =
  'Usage: dsh [--profile] <name> [options] [app-args...]\n\ndsh: boot a DeepSeek Harness profile\n'

test('a dsh on PATH counts only once its --help says it is DeepSeek Harness; one given by flag is trusted', async () => {
  const asked: string[] = []
  const answering =
    (help: string): RunCommand =>
    async argv => {
      asked.push(argv.join(' '))
      if (argv[1] === '--help') return { code: 0, stdout: help }
      if (argv[1] === '--version')
        return {
          code: 0,
          stdout: help === DEBIAN_DSH ? DEBIAN_DSH : '0.2.1-rc.2\n',
        }
      return { code: 1, stdout: '' }
    }
  const debian = new RuntimeInstaller({
    run: answering(DEBIAN_DSH),
    which: command => (command === 'dsh' ? '/usr/bin/dsh' : null),
  })
  // Before the check it is not taken either.
  expect(debian.availability('dsh').installed).toBe(false)
  await Promise.all([debian.checkPath('dsh'), debian.checkPath('dsh')])
  expect(debian.availability('dsh')).toEqual({
    installed: false,
    rejected:
      'PATH 上的 /usr/bin/dsh 不是 DeepSeek Harness（它的 --help 里没有这个名字），当作没有安装',
  })
  const row = (await debian.versions()).runtimes.find(one => one.id === 'dsh')!
  expect(row).toMatchObject({ installed: false })
  expect(row.version).toBeUndefined()
  expect(row.source).toBeUndefined()
  // Asked once for that binary, whoever asked.
  expect(asked).toEqual(['/usr/bin/dsh --help'])

  asked.length = 0
  const deepseek = new RuntimeInstaller({
    run: answering(DEEPSEEK_DSH_HELP),
    which: command => (command === 'dsh' ? '/opt/homebrew/bin/dsh' : null),
  })
  expect(await deepseek.ensureRuntimeInstalled('dsh')).toEqual({ ok: true })
  expect(deepseek.availability('dsh')).toEqual({
    installed: true,
    source: 'path',
    bin: '/opt/homebrew/bin/dsh',
  })
  expect(
    (await deepseek.versions()).runtimes.find(one => one.id === 'dsh'),
  ).toMatchObject({ installed: true, source: 'path', version: '0.2.1-rc.2' })
  expect(asked).toEqual([
    '/opt/homebrew/bin/dsh --help',
    '/opt/homebrew/bin/dsh --version',
  ])

  asked.length = 0
  const flagged = new RuntimeInstaller({
    run: answering(DEBIAN_DSH),
    bins: { dsh: '/usr/bin/dsh' },
    which: command => (command === 'dsh' ? '/usr/bin/dsh' : null),
  })
  await flagged.checkPath('dsh')
  expect(flagged.availability('dsh')).toEqual({
    installed: true,
    source: 'flag',
    bin: '/usr/bin/dsh',
  })
  expect(asked).toEqual([])
  // Other runtimes on PATH are taken as they are.
  const codex = new RuntimeInstaller({
    run: answering(DEBIAN_DSH),
    which: command => (command === 'codex' ? '/usr/local/bin/codex' : null),
  })
  await codex.checkPath('codex')
  expect(codex.availability('codex')).toMatchObject({ installed: true })
})

test('a second install of the same runtime is refused while one runs; ensureRuntimeInstalled joins it', async () => {
  const npm = fakeNpm(PIN('codex'))
  let release!: () => void
  const gate = new Promise<void>(done => {
    release = done
  })
  const installer = new RuntimeInstaller({
    freeMemoryBytes: roomy,
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
    freeMemoryBytes: roomy,
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

test('a command that writes a lot to stdout keeps only maxOutput of it', async () => {
  const result = await runCommand(
    [
      process.execPath,
      '-e',
      "for (let i = 0; i < 64; i++) process.stdout.write('y'.repeat(1024 * 1024))",
    ],
    {
      env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin' },
      timeoutMs: 20_000,
      maxOutput: 100,
    },
  )
  expect(result).toEqual({ code: 0, stdout: 'y'.repeat(100), truncated: true })
})

test('a command that ignores its timeout is killed outright, with what it started', async () => {
  const pidFile = path.join(mkdtempSync(path.join(tmpdir(), 'qm-kill-')), 'pid')
  const started = Date.now()
  const result = await runCommand(
    // The shell ignores SIGTERM, and so does the sleep it starts.
    [
      '/bin/sh',
      '-c',
      `trap '' TERM; sleep 6 & echo $! > "$0"; wait; echo late`,
      pidFile,
    ],
    {
      env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin' },
      timeoutMs: 100,
      killGraceMs: 200,
    },
  )
  expect(result.code).not.toBe(0)
  expect(result.stdout).toBe('')
  expect(Date.now() - started).toBeLessThan(2_000)
  expect(await gone(Number(readFileSync(pidFile, 'utf8')))).toBe(true)
  rmSync(path.dirname(pidFile), { recursive: true, force: true })
})

test('a command that exits leaving a process on its pipes: that process is killed, the answer kept', async () => {
  const pidFile = path.join(mkdtempSync(path.join(tmpdir(), 'qm-kill-')), 'pid')
  const started = Date.now()
  const result = await runCommand(
    ['/bin/sh', '-c', `sleep 6 & echo $! > "$0"; echo done`, pidFile],
    {
      env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin' },
      timeoutMs: 20_000,
    },
  )
  // Cut off with the pipes: the output may be incomplete, and says so.
  expect(result).toEqual({ code: 0, stdout: 'done\n', truncated: true })
  expect(Date.now() - started).toBeLessThan(4_000)
  expect(await gone(Number(readFileSync(pidFile, 'utf8')))).toBe(true)
  rmSync(path.dirname(pidFile), { recursive: true, force: true })
})

/** Whether process `pid` is gone within a second. */
async function gone(pid: number): Promise<boolean> {
  for (let i = 0; i < 20; i++) {
    try {
      process.kill(pid, 0)
    } catch {
      return true
    }
    await Bun.sleep(50)
  }
  return false
}

test('an install that comes in while the runtime is being removed is refused, not reported done', async () => {
  const npm = fakeNpm(PIN('codex'))
  let release!: () => void
  const held = new Promise<void>(done => {
    release = done
  })
  let uninstalling!: () => void
  const uninstallStarted = new Promise<void>(done => {
    uninstalling = done
  })
  const installer = new RuntimeInstaller({
    run: async (argv, options) => {
      if (argv[1] === 'uninstall') {
        uninstalling()
        await held
      }
      return npm.run(argv, options)
    },
    freeBytes: roomy,
    freeMemoryBytes: roomy,
    which: nowhere,
    smoke: async () => null,
  })
  // An earlier build's install in the shared prefix, at the pinned version.
  const legacy = path.join(managedRuntimePrefix(), 'node_modules', '.bin')
  mkdirSync(legacy, { recursive: true })
  writeFileSync(path.join(legacy, 'codex'), '')
  const removing = installer.control(
    'runtime.remove',
    { runtime: 'codex' },
    CTX,
  )
  await uninstallStarted
  expect(await installer.install('codex')).toMatchObject({
    ok: false,
    code: 'E_RUNTIME_BUSY',
  })
  expect(
    await installer.control('runtime.remove', { runtime: 'codex' }, CTX),
  ).toMatchObject({ ok: false, code: 'E_RUNTIME_BUSY' })
  release()
  expect(await removing).toEqual({
    ok: true,
    value: { runtime: 'codex', removed: true },
  })
  expect(managedRuntimeBin('codex')).toBeUndefined()
  // Once it is gone, an install goes ahead.
  expect((await installer.install('codex')).ok).toBe(true)
})

/**
 * The default install while a removal is under way: `npm uninstall` of an
 * earlier build's install is held until `release`; `gone` deletes the binary
 * before the hold (the removal past the point of no return).
 */
async function defaultInstallDuringRemoval(gone: boolean) {
  const npm = fakeNpm(PIN('codex'))
  let release!: () => void
  const held = new Promise<void>(done => {
    release = done
  })
  let uninstalling!: () => void
  const uninstallStarted = new Promise<void>(done => {
    uninstalling = done
  })
  const legacy = path.join(managedRuntimePrefix(), 'node_modules', '.bin')
  const installer = new RuntimeInstaller({
    run: async (argv, options) => {
      if (argv[1] === 'uninstall') {
        if (gone) rmSync(path.join(legacy, 'codex'), { force: true })
        uninstalling()
        await held
      }
      return npm.run(argv, options)
    },
    freeBytes: roomy,
    freeMemoryBytes: roomy,
    which: nowhere,
    smoke: async () => null,
  })
  mkdirSync(legacy, { recursive: true })
  writeFileSync(path.join(legacy, 'codex'), '')
  const removing = installer.control(
    'runtime.remove',
    { runtime: 'codex' },
    CTX,
  )
  await uninstallStarted
  let answered = false
  const ensured = installer.ensureRuntimeInstalled('codex').finally(() => {
    answered = true
  })
  for (let i = 0; i < 50; i++) await Promise.resolve()
  await Bun.sleep(20)
  // Neither "installed" (the binary is on its way out) nor "busy" (no
  // failure to back off from): it waits for the removal to end.
  expect(answered).toBe(false)
  release()
  expect(await removing).toEqual({
    ok: true,
    value: { runtime: 'codex', removed: true },
  })
  expect(await ensured).toEqual({ ok: true, version: PIN('codex') })
  expect(managedRuntimeBin('codex')).toBeDefined()
  expect(npm.calls.filter(argv => argv[1] === 'install')).toHaveLength(1)
}

test('the default install waits for a removal whose binary is still there, then installs', async () => {
  await defaultInstallDuringRemoval(false)
})

test('the default install waits for a removal whose binary is already gone instead of failing busy, then installs', async () => {
  await defaultInstallDuringRemoval(true)
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
    freeMemoryBytes: roomy,
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
    freeMemoryBytes: roomy,
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
  // While it runs, the disk says "not finished" (a kill now is a failure)…
  expect(new RuntimeInstaller({}).lastInstall('dsh')).toMatchObject({
    ok: false,
    failures: 1,
    error:
      '上一次安装没有结束（节点在安装中途退出，常见原因是内存不足被系统结束）',
  })
  // …and this node still reports the last install that finished: none.
  expect(installer.lastInstall('dsh')).toBeUndefined()
  expect(
    (await installer.versions()).runtimes.find(row => row.id === 'dsh')!
      .lastInstall,
  ).toBeUndefined()
  installer.stop()
  expect(await install).toMatchObject({ ok: false })
  expect(installer.lastInstall('dsh')).toBeUndefined()
  expect(installer.installing('dsh')).toBe(false)
  // A stop is not a kill: nothing is left on disk to back off from.
  expect(new RuntimeInstaller({}).lastInstall('dsh')).toBeUndefined()
})

test('an install queued behind another writes nothing until its turn; stopped while queued, it never begins', async () => {
  let started!: () => void
  const running = new Promise<void>(done => {
    started = done
  })
  const calls: string[][] = []
  const installer = new RuntimeInstaller({
    freeMemoryBytes: roomy,
    freeBytes: roomy,
    which: nowhere,
    smoke: async () => null,
    run: async (argv, options) => {
      calls.push([...argv])
      if (argv[0] === 'node') return { code: 0, stdout: 'v24.1.0' }
      started()
      // npm runs until the node stops and kills it.
      await new Promise(done =>
        options.signal?.addEventListener('abort', done, { once: true }),
      )
      return { code: 143, stdout: '' }
    },
  })
  const first = installer.install('dsh')
  await running
  const queued = installer.install('qwen')
  expect(installer.installing('qwen')).toBe(true)
  // Waiting its turn is not an install yet: nothing on disk to back off from.
  expect(new RuntimeInstaller({}).lastInstall('qwen')).toBeUndefined()
  installer.stop()
  expect(await first).toMatchObject({ ok: false })
  expect(await queued).toEqual({
    ok: false,
    code: 'E_RUNTIME_BUSY',
    message: '节点正在停机，不开始新的安装或卸载',
  })
  expect(calls.filter(argv => argv.at(-1)?.startsWith('@qwen-code/'))).toEqual(
    [],
  )
  expect(installer.installing('qwen')).toBe(false)
  expect(new RuntimeInstaller({}).lastInstall('qwen')).toBeUndefined()
  expect(new RuntimeInstaller({}).lastInstall('dsh')).toBeUndefined()
})

test('after stop() nothing new is installed or removed: refused before anything is written', async () => {
  const npm = fakeNpm(PIN('dsh'))
  const installer = new RuntimeInstaller({
    run: npm.run,
    freeBytes: roomy,
    freeMemoryBytes: roomy,
    which: nowhere,
    smoke: async () => null,
  })
  // A managed copy to (not) remove.
  const bin = path.join(managedRuntimePrefix(), 'node_modules', '.bin')
  mkdirSync(bin, { recursive: true })
  writeFileSync(path.join(bin, 'codex'), '')
  // The resident stops its runtimes before its control link closes, so a
  // request can still come in after this.
  installer.stop()
  for (const op of ['runtime.install', 'runtime.update'])
    expect(await installer.control(op, { runtime: 'dsh' }, CTX)).toEqual({
      ok: false,
      code: 'E_RUNTIME_BUSY',
      message: '节点正在停机，不开始新的安装或卸载',
    })
  expect(await installer.ensureRuntimeInstalled('dsh')).toMatchObject({
    ok: false,
    code: 'E_RUNTIME_BUSY',
  })
  expect(
    await installer.control('runtime.remove', { runtime: 'codex' }, CTX),
  ).toEqual({
    ok: false,
    code: 'E_RUNTIME_BUSY',
    message: '节点正在停机，不开始新的安装或卸载',
  })
  expect(npm.calls).toEqual([])
  expect(managedRuntimeBin('codex')).toBeDefined()
  // No "unfinished" record for the next start to back off from.
  expect(existsSync(qianmoConfigPath('runtimes', 'installs.json'))).toBe(false)
  expect(new RuntimeInstaller({}).lastInstall('dsh')).toBeUndefined()
})

test('a removal still queued when the node stops is not begun', async () => {
  const npm = fakeNpm(PIN('codex'))
  let release!: () => void
  const held = new Promise<void>(done => {
    release = done
  })
  let uninstalling!: () => void
  const first = new Promise<void>(done => {
    uninstalling = done
  })
  const installer = new RuntimeInstaller({
    run: async (argv, options) => {
      if (argv[1] === 'uninstall') {
        uninstalling()
        await held
      }
      return npm.run(argv, options)
    },
    freeBytes: roomy,
    freeMemoryBytes: roomy,
    which: nowhere,
    smoke: async () => null,
  })
  // Two earlier-build installs in the shared prefix.
  const bin = path.join(managedRuntimePrefix(), 'node_modules', '.bin')
  mkdirSync(bin, { recursive: true })
  writeFileSync(path.join(bin, 'codex'), '')
  writeFileSync(path.join(bin, 'gemini'), '')
  const codex = installer.control('runtime.remove', { runtime: 'codex' }, CTX)
  await first
  const gemini = installer.control('runtime.remove', { runtime: 'gemini' }, CTX)
  installer.stop()
  release()
  await codex
  expect(await gemini).toEqual({
    ok: false,
    code: 'E_RUNTIME_BUSY',
    message: '节点正在停机，不开始新的安装或卸载',
  })
  expect(npm.calls.filter(call => call[1] === 'uninstall')).toHaveLength(1)
  expect(existsSync(path.join(bin, 'gemini'))).toBe(true)
})

test('a failed install counts once, a success clears the count', async () => {
  const installer = new RuntimeInstaller({
    run: fakeNpm(PIN('dsh'), { failInstall: true }).run,
    freeBytes: roomy,
    freeMemoryBytes: roomy,
    which: nowhere,
    smoke: async () => null,
  })
  expect((await installer.install('dsh')).ok).toBe(false)
  expect(installer.lastInstall('dsh')).toMatchObject({ failures: 1 })
  expect(new RuntimeInstaller({}).lastInstall('dsh')).toMatchObject({
    failures: 1,
    error: `npm 安装 @deepseek-ai/dsh@${PIN('dsh')} 失败`,
  })
  expect((await installer.install('dsh')).ok).toBe(false)
  expect(installer.lastInstall('dsh')).toMatchObject({ failures: 2 })
  const working = new RuntimeInstaller({
    run: fakeNpm(PIN('dsh')).run,
    freeBytes: roomy,
    freeMemoryBytes: roomy,
    which: nowhere,
    smoke: async () => null,
  })
  expect((await working.install('dsh')).ok).toBe(true)
  expect(new RuntimeInstaller({}).lastInstall('dsh')).toEqual({
    at: expect.any(Number),
    ok: true,
    version: PIN('dsh'),
  })
})
