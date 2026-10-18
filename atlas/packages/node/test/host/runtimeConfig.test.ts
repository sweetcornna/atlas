// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Each agent's runtime and model (P36.4): `runtimes.json` over the flags over
 * the node default; an agent whose runtime cannot run is on qianmopi with a
 * reason and comes back by itself; the default install runs in the background
 * and retries after 5, 15 and 60 minutes.
 */

import { afterEach, beforeEach, expect, jest, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import * as path from 'node:path'
import { qianmoConfigPath } from '@qianmo/paths'
import type { ControlContext } from '../../src/host/control.js'
import {
  hasLauncher,
  NodeRuntimes,
  type NodeRuntimesOptions,
  type RuntimeAgentFlags,
} from '../../src/host/runtimeConfig.js'
import {
  managedRuntimePrefix,
  type RunCommand,
  RuntimeInstaller,
  type RuntimeUpdateOptions,
} from '../../src/host/runtimeUpdate.js'
import {
  RUNTIME_CATALOG,
  runtimeSpec,
} from '../../src/host/runtimes/catalog.js'
import type {
  AgentRuntimeState,
  RuntimeStatusReply,
  RuntimeVersionsReply,
} from '../../src/host/runtimes/contract.js'
import { isolatedRoot } from '../providers/fake.js'

const CTX: ControlContext = { peer: 'hub', actor: 'ops', taskId: 't' }
const DSH_PIN = (() => {
  const spec = runtimeSpec('dsh')!
  return spec.install.kind === 'npm' ? spec.install.pin : ''
})()

let root: ReturnType<typeof isolatedRoot>
const made: NodeRuntimes[] = []
beforeEach(() => {
  root = isolatedRoot()
})
afterEach(() => {
  for (const runtimes of made.splice(0)) runtimes.stop()
  jest.useRealTimers()
  root.dispose()
})

interface Npm {
  run: RunCommand
  /** `npm install` calls so far (scratch and managed). */
  installs: () => number
  fail: boolean
  node: string | null
  /** Holds every scratch install until released. */
  hold?: Promise<void>
  /** What a binary's `--help` prints (default: its version, like Debian's dsh would not name DeepSeek Harness). */
  help?: string
}

function fakeNpm(): Npm {
  const calls: string[][] = []
  const npm: Npm = {
    fail: false,
    node: 'v24.1.0',
    installs: () => calls.filter(argv => argv[1] === 'install').length,
    run: async argv => {
      calls.push([...argv])
      if (argv[1] === '--help' && npm.help !== undefined)
        return { code: 0, stdout: npm.help }
      if (argv[0] === 'node')
        return npm.node === null
          ? { code: 127, stdout: '' }
          : { code: 0, stdout: npm.node }
      if (argv[1] === 'install') {
        await npm.hold
        if (npm.fail) return { code: 1, stdout: 'ETARGET' }
        const prefix = argv[argv.indexOf('--prefix') + 1]!
        const entry = RUNTIME_CATALOG.find(
          one =>
            one.install.kind === 'npm' &&
            argv.at(-1)!.startsWith(`${one.install.package}@`),
        )!
        const bin = path.join(prefix, 'node_modules', '.bin')
        mkdirSync(bin, { recursive: true })
        if (entry.install.kind === 'npm')
          writeFileSync(path.join(bin, entry.install.command), '')
        return { code: 0, stdout: '' }
      }
      const entry = RUNTIME_CATALOG.find(
        one =>
          one.install.kind === 'npm' &&
          argv[0]!.endsWith(`/${one.install.command}`),
      )
      return {
        code: 0,
        stdout: entry?.install.kind === 'npm' ? entry.install.pin : '0.0.0',
      }
    },
  }
  return npm
}

const MODELS = new Set([
  'magpie/deepseek-v4',
  'luna/gpt-6',
  'magpie/claude-opus-5',
])

function setup(
  options: Partial<Omit<NodeRuntimesOptions, 'installer'>> & {
    agents?: readonly RuntimeAgentFlags[]
    /** Options of the installer the helper builds (not an installer). */
    installer?: RuntimeUpdateOptions
  } = {},
) {
  const { installer: installerOptions, ...rest } = options
  const npm = fakeNpm()
  const smoke = { reason: null as string | null }
  const installer = new RuntimeInstaller({
    run: npm.run,
    freeBytes: () => 64 * 1024 ** 3,
    freeMemoryBytes: () => 64 * 1024 ** 3,
    which: () => null,
    smoke: async () => smoke.reason,
    // Settles within `settle()` (real removal is I/O; these cases count on
    // microtasks only, under fake timers).
    removeTree: async dir => {
      rmSync(dir, { recursive: true, force: true })
    },
    ...installerOptions,
  })
  let main: string | undefined = 'magpie/deepseek-v4'
  const changed: string[] = []
  const runtimes = new NodeRuntimes({
    agents: options.agents ?? [
      { agent: 'main' },
      { agent: 'coder', runtime: 'codex', model: 'luna/gpt-6' },
      { agent: 'pi', runtime: 'omp' },
    ],
    installer,
    credential: (spec, runtime) => {
      if (!MODELS.has(spec))
        throw new Error(
          `model profile ${spec.split('/')[0]} is not applied on this node`,
        )
      return {
        model: spec.slice(spec.indexOf('/') + 1),
        baseUrl: 'http://127.0.0.1:9/v1',
        apiKey: 'sk-test',
        lane: runtimeSpec(runtime)!.lanes[0]!,
      }
    },
    mainModel: () => main,
    // These cases are about install, Node.js and models, not launchers.
    launchable: () => true,
    ...rest,
  })
  made.push(runtimes)
  runtimes.onChange(agent => changed.push(agent))
  return {
    runtimes,
    installer,
    npm,
    smoke,
    changed,
    setMain: (value: string | undefined) => {
      main = value
    },
  }
}

/** Waits (real time, at most 2 s) for `done`; for steps that do real I/O. */
async function until(done: () => boolean): Promise<void> {
  for (let i = 0; i < 400 && !done(); i++) await Bun.sleep(5)
}

/** Lets the installer's promise chains run (no timers involved). */
async function settle(): Promise<void> {
  for (let i = 0; i < 200; i++) await Promise.resolve()
}

function managed(command: string) {
  const bin = path.join(managedRuntimePrefix(), 'node_modules', '.bin')
  mkdirSync(bin, { recursive: true })
  writeFileSync(path.join(bin, command), '')
}

const state = (runtimes: NodeRuntimes, agent: string): AgentRuntimeState =>
  runtimes.state(agent)!

test('runtime comes from runtimes.json, then the flags, then the node default (dsh)', async () => {
  const file = qianmoConfigPath('qianmo', 'runtimes.json')
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(
    file,
    JSON.stringify({
      v: 1,
      agents: { coder: { runtime: 'qianmopi' }, main: { model: 'auto' } },
    }),
  )
  const { runtimes } = setup()
  expect(runtimes.defaultRuntime).toBe('dsh')
  expect(runtimes.configured('main')).toEqual({
    runtime: 'dsh',
    source: 'default',
    model: 'auto',
  })
  expect(runtimes.configured('coder')).toEqual({
    runtime: 'omp',
    source: 'config',
    model: 'luna/gpt-6',
  })
  expect(runtimes.configured('pi')).toEqual({
    runtime: 'omp',
    source: 'flag',
    model: null,
  })
  // `--default-runtime qianmopi` keeps everyone without a choice on omp.
  const kept = setup({ defaultRuntime: 'qianmopi' }).runtimes
  expect(kept.configured('main')).toMatchObject({
    runtime: 'omp',
    source: 'default',
  })
  expect(() => setup({ defaultRuntime: 'vim' })).toThrow('unknown default')
})

test('not installed: on qianmopi with the reason; installed: back on its runtime with model and lane', async () => {
  const { runtimes, changed } = setup()
  expect(state(runtimes, 'main')).toEqual({
    agent: 'main',
    configured: { runtime: 'dsh', source: 'default', model: null },
    effective: { runtime: 'omp' },
    reason: { code: 'not-installed', message: '节点上没有 DeepSeek Harness' },
  })
  expect(runtimes.effectiveRuntime('pi')).toBe('omp')
  expect(state(runtimes, 'pi').reason).toBeUndefined()
  // The binary shows up (an install, or an operator's copy) and a recompute
  // (any of: install finished, configure, model service applied) sees it.
  managed('dsh')
  managed('codex')
  expect(runtimes.recompute().sort()).toEqual(['coder', 'main'])
  expect(changed.sort()).toEqual(['coder', 'main'])
  expect(state(runtimes, 'main').effective).toEqual({
    runtime: 'dsh',
    model: 'magpie/deepseek-v4',
    lane: 'openai-chat',
  })
  expect(state(runtimes, 'main').reason).toBeUndefined()
  expect(state(runtimes, 'coder').effective).toEqual({
    runtime: 'codex',
    model: 'luna/gpt-6',
    lane: 'openai-responses',
  })
  expect(runtimes.launch('coder')).toMatchObject({
    model: 'gpt-6',
    lane: 'openai-responses',
  })
  expect(() => runtimes.launch('pi')).toThrow('runs on qianmopi')
})

test('installing, then install-failed with the error, then back once a retry works', async () => {
  const { runtimes, installer, npm, changed } = setup()
  let release!: () => void
  npm.hold = new Promise(done => {
    release = done
  })
  const install = installer.install('dsh')
  expect(state(runtimes, 'main').reason?.code).toBe('installing')
  npm.fail = true
  release()
  expect((await install).ok).toBe(false)
  expect(state(runtimes, 'main').reason).toEqual({
    code: 'install-failed',
    message: `npm 安装 @deepseek-ai/dsh@${DSH_PIN} 失败`,
  })
  expect(changed).toEqual([])
  npm.hold = undefined
  npm.fail = false
  expect((await installer.install('dsh')).ok).toBe(true)
  expect(state(runtimes, 'main').effective.runtime).toBe('dsh')
  expect(changed).toEqual(['main'])
})

test('a failed compatibility check and a missing Node.js are reasons of their own', async () => {
  const { runtimes, installer, npm, smoke } = setup()
  smoke.reason = 'qianmo 工具不在工具列表里'
  expect((await installer.install('dsh')).ok).toBe(false)
  expect(state(runtimes, 'main').reason?.code).toBe('smoke-failed')
  expect(state(runtimes, 'main').reason?.message).toContain(
    'qianmo 工具不在工具列表里',
  )
  npm.node = null
  expect((await installer.install('dsh')).ok).toBe(false)
  expect(state(runtimes, 'main').reason).toMatchObject({ code: 'no-node' })
  // Installed by hand, but the node has no Node.js it can run on.
  managed('dsh')
  await runtimes.start()
  expect(state(runtimes, 'main').reason).toMatchObject({ code: 'no-node' })
  npm.node = 'v24.2.0'
  await runtimes.start()
  expect(state(runtimes, 'main').effective.runtime).toBe('dsh')
})

test('native extensions belong to the runtime an agent is configured on, qianmopi included', async () => {
  const { runtimes } = setup()
  managed('dsh')
  await runtimes.start()
  // Configured on qianmopi: no other runtime's state is its.
  expect(runtimes.nativeRuntimeOf('pi')).toBe('omp')
  expect(runtimes.externalRuntimeOf('pi')).toBe('dsh')
  // Away on the fallback (Codex is not installed): still Codex's.
  expect(state(runtimes, 'coder').effective.runtime).toBe('omp')
  expect(runtimes.nativeRuntimeOf('coder')).toBe('codex')
})

test('no model: a runtime that cannot send a profile’s custom headers does not run on it', async () => {
  const { runtimes, npm } = setup({
    agents: [{ agent: 'qw', runtime: 'qwen', model: 'gw/qwen3-coder' }],
    credential: (spec, runtime) => ({
      model: spec.slice(spec.indexOf('/') + 1),
      baseUrl: 'http://127.0.0.1:9/v1',
      apiKey: 'sk-test',
      lane: runtimeSpec(runtime)!.lanes[0]!,
      headers: { 'X-Route': 'team-a' },
    }),
  })
  managed('qwen')
  npm.node = 'v24.2.0'
  await runtimes.start()
  expect(state(runtimes, 'qw')).toMatchObject({
    effective: { runtime: 'omp' },
    reason: {
      code: 'no-model',
      message: expect.stringContaining('自定义请求头'),
    },
  })
})

test('no model: no --agent-model and no main model, or one the node does not have; back when the model service has it', async () => {
  const { runtimes, setMain, changed } = setup({
    agents: [
      { agent: 'main' },
      { agent: 'writer', runtime: 'claude-code', model: 'anthropic/claude-x' },
    ],
  })
  managed('dsh')
  managed('claude')
  setMain(undefined)
  runtimes.recompute()
  expect(state(runtimes, 'main').reason).toEqual({
    code: 'no-model',
    message: '没有为它配置模型，节点也没有可用的主模型',
  })
  expect(state(runtimes, 'writer').reason?.code).toBe('no-model')
  expect(state(runtimes, 'writer').reason?.message).toContain(
    'anthropic is not applied',
  )
  // An explicit model never falls back to the main one.
  setMain('magpie/deepseek-v4')
  runtimes.recompute()
  expect(state(runtimes, 'main').effective.model).toBe('magpie/deepseek-v4')
  expect(state(runtimes, 'writer').effective.runtime).toBe('omp')
  // The hub picks one through the console.
  changed.length = 0
  const configured = await runtimes.control(
    'runtime.configure',
    { agent: 'writer', model: 'magpie/claude-opus-5' },
    CTX,
  )
  expect(configured).toMatchObject({
    ok: true,
    value: {
      agent: 'writer',
      configured: { runtime: 'claude-code', source: 'flag' },
      effective: {
        runtime: 'claude-code',
        model: 'magpie/claude-opus-5',
        lane: 'anthropic',
      },
    },
  })
  expect(changed).toEqual(['writer'])
})

test('runtime.configure validates agent, runtime and model, writes runtimes.json privately, and null clears', async () => {
  const { runtimes, changed } = setup()
  const configure = (args: Record<string, unknown>) =>
    runtimes.control('runtime.configure', args, CTX)
  expect(await configure({ agent: 'ghost', runtime: 'dsh' })).toMatchObject({
    ok: false,
    code: 'E_AGENT_UNKNOWN',
  })
  expect(await configure({ agent: 'main', runtime: 'vim' })).toMatchObject({
    ok: false,
    code: 'E_RUNTIME_UNKNOWN',
  })
  for (const model of ['gpt-6', '/x', 'a b/c', 3])
    expect(await configure({ agent: 'main', model })).toMatchObject({
      ok: false,
      code: 'E_RUNTIME_MODEL',
    })
  expect(changed).toEqual([])
  const file = qianmoConfigPath('qianmo', 'runtimes.json')
  const set = await configure({
    agent: 'main',
    runtime: 'qianmopi',
    model: 'auto',
  })
  expect(set).toMatchObject({
    ok: true,
    value: {
      configured: { runtime: 'omp', source: 'config', model: 'auto' },
      effective: { runtime: 'omp' },
    },
  })
  expect(changed).toEqual(['main'])
  expect(statSync(file).mode & 0o777).toBe(0o600)
  expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
    v: 1,
    agents: { main: { runtime: 'omp', model: 'auto' } },
  })
  // The same again changes nothing and recycles nobody.
  await configure({ agent: 'main', runtime: 'omp' })
  expect(changed).toEqual(['main'])
  expect(
    await configure({ agent: 'main', runtime: null, model: null }),
  ).toMatchObject({
    ok: true,
    value: { configured: { runtime: 'dsh', source: 'default', model: null } },
  })
  expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ v: 1, agents: {} })
  // A new process reads what was written.
  await configure({ agent: 'coder', runtime: 'claude-code' })
  const again = setup().runtimes
  expect(again.configured('coder')).toMatchObject({
    runtime: 'claude-code',
    source: 'config',
  })
})

test('runtime.status and runtime.versions answer per contract; remove refuses while agents are configured on it', async () => {
  const { runtimes } = setup()
  const status = await runtimes.control('runtime.status', {}, CTX)
  expect(status.ok).toBe(true)
  const reply = (status as { value: RuntimeStatusReply }).value
  expect(reply.defaultRuntime).toBe('dsh')
  expect(reply.agents.map(one => one.agent)).toEqual(['main', 'coder', 'pi'])
  const versions = await runtimes.control('runtime.versions', {}, CTX)
  expect(
    (versions as { value: RuntimeVersionsReply }).value.defaultRuntime,
  ).toBe('dsh')
  managed('dsh')
  const refused = await runtimes.control(
    'runtime.remove',
    { runtime: 'dsh' },
    CTX,
  )
  expect(refused).toEqual({
    ok: false,
    code: 'E_RUNTIME_IN_USE',
    message: 'DeepSeek Harness 正被这些智能体使用：main；先把它们改到别的底层',
  })
  expect(
    await runtimes.control('runtime.remove', { runtime: 'qianmopi' }, CTX),
  ).toMatchObject({ ok: false, code: 'E_RUNTIME_BUILTIN' })
  expect(runtimes.inUse('codex')).toEqual(['coder'])
})

test('the default install runs at start in the background and retries after 5, 15 and 60 minutes', async () => {
  jest.useFakeTimers()
  const { runtimes, npm, changed } = setup({ autoInstall: true })
  npm.fail = true
  const started = runtimes.start()
  await settle()
  await started
  await settle()
  // Both configured npm runtimes (dsh by default, codex by flag) were tried.
  expect(npm.installs()).toBe(2)
  expect(state(runtimes, 'main').reason?.code).toBe('install-failed')
  const tries = async (ms: number) => {
    jest.advanceTimersByTime(ms)
    await settle()
    return npm.installs()
  }
  expect(await tries(5 * 60_000 - 1)).toBe(2)
  expect(await tries(1)).toBe(4)
  expect(await tries(15 * 60_000)).toBe(6)
  expect(await tries(60 * 60_000)).toBe(8)
  // Three retries per start, then no more.
  expect(await tries(10 * 60 * 60_000)).toBe(8)
  expect(changed).toEqual([])
})

test('a retry that works brings the agents over; stop() cancels what is pending; --no-runtime-autoinstall installs nothing', async () => {
  jest.useFakeTimers()
  const { runtimes, npm, changed } = setup({
    autoInstall: true,
    agents: [{ agent: 'main' }],
  })
  npm.fail = true
  await runtimes.start()
  await settle()
  expect(npm.installs()).toBe(1)
  npm.fail = false
  jest.advanceTimersByTime(5 * 60_000)
  await settle()
  expect(state(runtimes, 'main').effective.runtime).toBe('dsh')
  expect(changed).toEqual(['main'])

  const second = setup({ autoInstall: true, agents: [{ agent: 'main' }] })
  rmSync(managedRuntimePrefix(), { recursive: true, force: true })
  second.npm.fail = true
  await second.runtimes.start()
  await settle()
  const before = second.npm.installs()
  second.runtimes.stop()
  jest.advanceTimersByTime(2 * 60 * 60_000)
  await settle()
  expect(second.npm.installs()).toBe(before)

  const off = setup({ autoInstall: false, agents: [{ agent: 'main' }] })
  await off.runtimes.start()
  await settle()
  expect(off.npm.installs()).toBe(0)
})

test('the backoff outlives a restart: a node started again after a failure waits out the rest of it', async () => {
  jest.useFakeTimers()
  const one = setup({ autoInstall: true, agents: [{ agent: 'main' }] })
  one.npm.fail = true
  await one.runtimes.start()
  await settle()
  expect(one.npm.installs()).toBe(1)
  expect(one.installer.lastInstall('dsh')).toMatchObject({
    ok: false,
    failures: 1,
  })
  one.runtimes.stop()
  // Started again two minutes later: three of the five minutes are left.
  jest.advanceTimersByTime(2 * 60_000)
  const two = setup({ autoInstall: true, agents: [{ agent: 'main' }] })
  two.npm.fail = true
  await two.runtimes.start()
  await settle()
  expect(two.npm.installs()).toBe(0)
  expect(state(two.runtimes, 'main').reason?.code).toBe('install-failed')
  const tries = async (ms: number) => {
    jest.advanceTimersByTime(ms)
    await settle()
    return two.npm.installs()
  }
  expect(await tries(3 * 60_000 - 1)).toBe(0)
  expect(await tries(1)).toBe(1)
  expect(two.installer.lastInstall('dsh')).toMatchObject({ failures: 2 })
  // The rest of the schedule goes on as if there had been no restart.
  expect(await tries(15 * 60_000)).toBe(2)
  expect(await tries(60 * 60_000)).toBe(3)
  expect(await tries(10 * 60 * 60_000)).toBe(3)
  expect(two.installer.lastInstall('dsh')).toMatchObject({ failures: 4 })
  two.runtimes.stop()
  // Retries used up: each later start tries once, no sooner than an hour
  // after the last failure (ten hours have passed here)…
  const three = setup({ autoInstall: true, agents: [{ agent: 'main' }] })
  three.npm.fail = true
  await three.runtimes.start()
  await settle()
  expect(three.npm.installs()).toBe(1)
  three.runtimes.stop()
  // …and started again right after that failure, it waits the hour out,
  // tries once and stops trying for that run.
  const four = setup({ autoInstall: true, agents: [{ agent: 'main' }] })
  four.npm.fail = true
  await four.runtimes.start()
  await settle()
  expect(four.npm.installs()).toBe(0)
  const later = async (ms: number) => {
    jest.advanceTimersByTime(ms)
    await settle()
    return four.npm.installs()
  }
  expect(await later(60 * 60_000 - 1)).toBe(0)
  expect(await later(1)).toBe(1)
  expect(await later(10 * 60 * 60_000)).toBe(1)
  expect(four.installer.lastInstall('dsh')).toMatchObject({ failures: 6 })
  // A success clears the count.
  four.npm.fail = false
  expect((await four.installer.install('dsh')).ok).toBe(true)
  expect(four.installer.lastInstall('dsh')).toMatchObject({ ok: true })
  expect(four.installer.lastInstall('dsh')?.failures).toBeUndefined()
})

test('a node killed in the middle of an install backs off after the restart instead of installing again at once', async () => {
  jest.useFakeTimers()
  const one = setup({ autoInstall: true, agents: [{ agent: 'main' }] })
  // npm never comes back: the node is OOM-killed while it runs.
  one.npm.hold = new Promise(() => {})
  await one.runtimes.start()
  await settle()
  expect(one.npm.installs()).toBe(1)
  // Killed after ten minutes in the install (npm's scratch step alone may
  // take six), so no stop() and no ending: the disk is all there is. The
  // backoff is counted from the restart, not from when that install began.
  jest.advanceTimersByTime(10 * 60_000)
  const two = setup({ autoInstall: true, agents: [{ agent: 'main' }] })
  await two.runtimes.start()
  await settle()
  expect(two.npm.installs()).toBe(0)
  expect(state(two.runtimes, 'main').reason).toEqual({
    code: 'install-failed',
    message:
      '上一次安装没有结束（节点在安装中途退出，常见原因是内存不足被系统结束）',
  })
  expect(two.installer.lastInstall('dsh')).toMatchObject({ failures: 1 })
  // All five minutes, from this start.
  jest.advanceTimersByTime(5 * 60_000 - 1)
  await settle()
  expect(two.npm.installs()).toBe(0)
  jest.advanceTimersByTime(1)
  await settle()
  expect(two.npm.installs()).toBe(2)
  expect(state(two.runtimes, 'main').effective.runtime).toBe('dsh')
  expect(two.installer.lastInstall('dsh')).toMatchObject({ ok: true })
  expect(two.installer.lastInstall('dsh')?.failures).toBeUndefined()
})

test('an install that ended in a failure still backs off from when it failed', async () => {
  jest.useFakeTimers()
  const one = setup({ autoInstall: true, agents: [{ agent: 'main' }] })
  one.npm.fail = true
  await one.runtimes.start()
  await settle()
  expect(one.npm.installs()).toBe(1)
  one.runtimes.stop()
  jest.advanceTimersByTime(10 * 60_000)
  // The five minutes are over: a restart installs at once.
  const two = setup({ autoInstall: true, agents: [{ agent: 'main' }] })
  await two.runtimes.start()
  await settle()
  expect(two.npm.installs()).toBe(2)
})

test('a pending retry is dropped once no agent is configured on its runtime', async () => {
  jest.useFakeTimers()
  const { runtimes, npm } = setup({
    autoInstall: true,
    agents: [{ agent: 'a' }, { agent: 'b' }],
  })
  npm.fail = true
  await runtimes.start()
  await settle()
  expect(npm.installs()).toBe(1)
  // b is still on dsh: the retry stays.
  runtimes.configure({ agent: 'a', runtime: 'qianmopi' })
  jest.advanceTimersByTime(5 * 60_000)
  await settle()
  expect(npm.installs()).toBe(2)
  runtimes.configure({ agent: 'b', runtime: 'qianmopi' })
  expect(runtimes.inUse('dsh')).toEqual([])
  jest.advanceTimersByTime(10 * 60 * 60_000)
  await settle()
  expect(npm.installs()).toBe(2)
})

test('a failure recorded before the count existed backs off like a first one', async () => {
  jest.useFakeTimers()
  const file = qianmoConfigPath('runtimes', 'installs.json')
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(
    file,
    JSON.stringify({
      dsh: { at: Date.now(), ok: false, version: DSH_PIN, error: 'E404' },
    }),
  )
  const { runtimes, npm } = setup({
    autoInstall: true,
    agents: [{ agent: 'main' }],
  })
  npm.fail = true
  await runtimes.start()
  await settle()
  expect(npm.installs()).toBe(0)
  jest.advanceTimersByTime(5 * 60_000)
  await settle()
  expect(npm.installs()).toBe(1)
})

test('a dsh on PATH that is not DeepSeek Harness is no dsh: the agent says why, and the default install goes ahead', async () => {
  const { runtimes, npm } = setup({
    autoInstall: true,
    agents: [{ agent: 'main' }],
    installer: {
      which: command => (command === 'dsh' ? '/usr/bin/dsh' : null),
    },
  })
  let release!: () => void
  npm.hold = new Promise(done => {
    release = done
  })
  await runtimes.start()
  await settle()
  expect(state(runtimes, 'main').reason?.code).toBe('installing')
  expect(npm.installs()).toBe(1)
  release()
  await settle()
  expect(state(runtimes, 'main').effective).toMatchObject({ runtime: 'dsh' })
  expect(runtimes.installer.availability('dsh').source).toBe('prefix')
  // Without the default install, the reason names the binary it did not take.
  rmSync(managedRuntimePrefix(), { recursive: true, force: true })
  const off = setup({
    agents: [{ agent: 'main' }],
    installer: {
      which: command => (command === 'dsh' ? '/usr/bin/dsh' : null),
    },
  })
  await off.runtimes.start()
  expect(state(off.runtimes, 'main').reason).toEqual({
    code: 'not-installed',
    message:
      '节点上没有 DeepSeek Harness：PATH 上的 /usr/bin/dsh 不是 DeepSeek Harness（它的 --help 里没有这个名字），当作没有安装',
  })
})

test('configured onto a dsh found on PATH while running: it is asked who it is, and the agent moves once it says DeepSeek Harness', async () => {
  const { runtimes, npm, changed } = setup({
    agents: [{ agent: 'pi', runtime: 'omp' }],
    installer: {
      which: command => (command === 'dsh' ? '/opt/homebrew/bin/dsh' : null),
    },
  })
  npm.help =
    'Usage: dsh [--profile] <name>\n\ndsh: boot a DeepSeek Harness profile\n'
  await runtimes.start()
  expect(runtimes.effectiveRuntime('pi')).toBe('omp')
  const outcome = runtimes.configure({ agent: 'pi', runtime: 'dsh' })
  // Not waited for: configure answers at once, the check runs behind it.
  expect(outcome).toMatchObject({
    ok: true,
    value: { effective: { runtime: 'omp' }, reason: { code: 'not-installed' } },
  })
  await settle()
  expect(state(runtimes, 'pi').effective).toEqual({
    runtime: 'dsh',
    model: 'magpie/deepseek-v4',
    lane: 'openai-chat',
  })
  expect(changed).toEqual(['pi', 'pi'])
})

test('start sweeps the scratch prefixes a dead node left, behind it: start does not wait for a large leftover to go', async () => {
  const stale = qianmoConfigPath(
    'runtimes',
    'npm-stage-0f9c6a52-6a8e-4d1b-9d4e-2b7f0c1a3e55',
  )
  mkdirSync(path.join(stale, 'node_modules'), { recursive: true })
  const removing: string[] = []
  let release!: () => void
  const released = new Promise<void>(done => {
    release = done
  })
  const { runtimes, npm } = setup({
    autoInstall: false,
    installer: {
      // dsh leaves about 850 MB: a removal that takes its time.
      removeTree: async dir => {
        removing.push(dir)
        await released
        rmSync(dir, { recursive: true, force: true })
      },
    },
  })
  await runtimes.start()
  // start() is done; the sweep reads the directory (real I/O) and then
  // removes, and the removal is still going.
  await until(() => removing.length > 0)
  expect(removing).toEqual([stale])
  expect(existsSync(stale)).toBe(true)
  release()
  await until(() => !existsSync(stale))
  expect(existsSync(stale)).toBe(false)
  expect(npm.installs()).toBe(0)
})

test('the sweep removes for real without an injected remover, off the event loop', async () => {
  const stale = qianmoConfigPath(
    'runtimes',
    'npm-stage-1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d',
  )
  mkdirSync(path.join(stale, 'node_modules', '.bin'), { recursive: true })
  writeFileSync(path.join(stale, 'node_modules', '.bin', 'dsh'), '')
  expect(await new RuntimeInstaller({}).sweepStages()).toEqual([stale])
  expect(existsSync(stale)).toBe(false)
})

test('unmanaged (embedders): no fallback and no default install; agents run where they say', () => {
  const runtimes = NodeRuntimes.unmanaged([
    { agent: 'a' },
    { agent: 'b', runtime: 'codex' },
  ])
  made.push(runtimes)
  expect(runtimes.defaultRuntime).toBe('omp')
  expect(runtimes.effectiveRuntime('a')).toBe('omp')
  expect(runtimes.effectiveRuntime('b')).toBe('codex')
  expect(runtimes.externalRuntimeOf('b')).toBe('codex')
  expect(runtimes.externalRuntimeOf('a')).toBe('dsh')
})

test('an ACP runtime this build has no launcher for stays on qianmopi, installed or not', () => {
  const dsh = runtimeSpec('dsh')!
  expect(hasLauncher(dsh)).toBe(dsh.acp !== undefined)
  expect(hasLauncher({ ...dsh, acp: undefined })).toBe(false)
  expect(hasLauncher(runtimeSpec('codex')!)).toBe(true)
  managed('dsh')
  const { runtimes } = setup({
    agents: [{ agent: 'main' }],
    launchable: spec => spec.id !== 'dsh',
  })
  expect(state(runtimes, 'main')).toMatchObject({
    effective: { runtime: 'omp' },
    reason: {
      code: 'smoke-failed',
      message: '这个版本的阡陌还不能驱动 DeepSeek Harness（ACP 启动方式未定）',
    },
  })
})
