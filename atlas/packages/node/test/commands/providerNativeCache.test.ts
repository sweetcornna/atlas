// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { expect, spyOn, test } from 'bun:test'
import * as fs from 'node:fs'
import { spawn, type ChildProcess } from 'node:child_process'
import { join, resolve } from 'node:path'
import { ompChildEnv } from '@qianmo/paths'
import {
  probeCall,
  ProbeExitUnconfirmedError,
} from '../../src/commands/providerCall.js'
import { reuseProbeNativeCache } from '../../src/commands/providerNativeCache.js'
import { compileProfile } from '../../src/providers/compile.js'
import { fakeOpenAI, isolatedRoot } from '../providers/fake.js'
import { CANARY_KEY, wireProfile } from '../providers/helpers.js'

const posixTest = test.skipIf(typeof process.getuid !== 'function')
const entry = resolve(import.meta.dir, '../../src/bin/compiled.ts')
const okProgram = `console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'OK'}],stopReason:'stop'}}))`
const idleProgram = 'setInterval(()=>{},1000)'

function compiled(baseUrl: string) {
  const capabilities = {
    protocol: 1 as const,
    multiKey: true,
    chatEffortHonorsOverride: true,
    replayFilter: true,
  }
  const result = compileProfile(
    wireProfile({ lane: 'openai-chat', baseUrl, compat: {} }, capabilities),
    { secret: CANARY_KEY, capabilities },
  )
  if (!result.ok) throw new Error(result.error.message)
  return result.compiled
}

function cacheFixture(loaderModes = false) {
  const root = isolatedRoot()
  // The trusted child's roots deliberately differ from process-global roots.
  const home = join(root.root, 'child-home')
  const config = join(root.root, 'child-config')
  fs.mkdirSync(home, { mode: 0o700 })
  const env = { ...process.env, HOME: home, QIANMO_CONFIG_DIR: config }
  const cache = ompChildEnv(env).PI_NATIVES_DIR!
  fs.mkdirSync(cache, { recursive: true, mode: 0o700 })
  const version = join(cache, '18.8.4')
  if (loaderModes) {
    fs.mkdirSync(version, { mode: 0o700 })
    fs.chmodSync(cache, 0o775)
    fs.chmodSync(version, 0o775)
  }
  const canary = join(loaderModes ? version : cache, 'resident-cache-canary')
  fs.writeFileSync(canary, 'parent-native-cache', { mode: 0o600 })
  if (loaderModes) fs.chmodSync(canary, 0o755)
  const before = fs.statSync(canary)
  return {
    ...root,
    env,
    config,
    cache,
    version,
    canary,
    assertPreserved() {
      expect(fs.readFileSync(canary, 'utf8')).toBe('parent-native-cache')
      const after = fs.statSync(canary)
      expect([after.dev, after.ino, after.size, after.mode]).toEqual([
        before.dev,
        before.ino,
        before.size,
        before.mode,
      ])
    },
  }
}

interface CacheObservation {
  root: string
  path: string
  link: boolean
  target: string | undefined
}

function observe(env: NodeJS.ProcessEnv): CacheObservation {
  const path = env.PI_NATIVES_DIR!
  return {
    root: env.QIANMO_CONFIG_DIR!,
    path,
    link: fs.existsSync(path) && fs.lstatSync(path).isSymbolicLink(),
    target: fs.existsSync(path) ? fs.realpathSync(path) : undefined,
  }
}

function privateProbe(base: NodeJS.ProcessEnv, root: string) {
  fs.mkdirSync(join(root, 'omp'), { recursive: true, mode: 0o700 })
  return ompChildEnv({ ...base, QIANMO_CONFIG_DIR: root })
}

posixTest(
  'already-safe native cache is linked without changing directory permissions',
  () => {
    const f = cacheFixture()
    const chmod = spyOn(fs, 'fchmodSync')
    try {
      const before = fs.statSync(f.cache)
      const probe = privateProbe(f.env, join(f.root, 'private-probe'))
      reuseProbeNativeCache(f.env, probe)
      expect(observe(probe).target).toBe(fs.realpathSync(f.cache))
      expect(chmod).not.toHaveBeenCalled()
      expect(fs.statSync(f.cache).mode).toBe(before.mode)
      expect(fs.statSync(f.cache).ino).toBe(before.ino)
      f.assertPreserved()
    } finally {
      chmod.mockRestore()
      f.dispose()
    }
  },
)

for (const scenario of [
  'public-config',
  'public-omp',
  'world-writable-root',
  'world-writable-version',
  'nonstandard-writable-directory',
  'special-directory',
  'special-file',
  'writable-file',
  'version-symlink',
  'unexpected-depth',
  'oversized-tree',
] as const) {
  posixTest(
    `0775 cache ${scenario} falls back before any directory chmod`,
    () => {
      const f = cacheFixture(true)
      const chmod = spyOn(fs, 'fchmodSync')
      try {
        if (scenario === 'public-config') fs.chmodSync(f.config, 0o755)
        if (scenario === 'public-omp')
          fs.chmodSync(join(f.config, 'omp'), 0o755)
        if (scenario === 'world-writable-root') fs.chmodSync(f.cache, 0o777)
        if (scenario === 'world-writable-version')
          fs.chmodSync(f.version, 0o777)
        if (scenario === 'nonstandard-writable-directory')
          fs.chmodSync(f.version, 0o770)
        if (scenario === 'special-directory') fs.chmodSync(f.version, 0o1775)
        if (scenario === 'special-file') fs.chmodSync(f.canary, 0o4755)
        if (scenario === 'writable-file') fs.chmodSync(f.canary, 0o775)
        if (scenario === 'version-symlink') {
          const saved = join(f.root, 'saved-version')
          fs.renameSync(f.version, saved)
          fs.symlinkSync(saved, f.version, 'dir')
        }
        if (scenario === 'unexpected-depth')
          fs.mkdirSync(join(f.version, 'unexpected-subdir'), { mode: 0o700 })
        if (scenario === 'oversized-tree') {
          for (let i = 0; i < 513; i++)
            fs.writeFileSync(join(f.version, `entry-${i}`), '', { mode: 0o600 })
        }
        const before = [f.cache, f.version, f.canary].map(path =>
          fs.lstatSync(path),
        )
        const probe = privateProbe(f.env, join(f.root, 'private-probe'))
        reuseProbeNativeCache(f.env, probe)
        expect(observe(probe).link).toBe(false)
        expect(fs.existsSync(probe.PI_NATIVES_DIR!)).toBe(false)
        expect(chmod).not.toHaveBeenCalled()
        for (const [index, path] of [f.cache, f.version, f.canary].entries()) {
          const after = fs.lstatSync(path)
          expect([after.mode, after.ino]).toEqual([
            before[index]!.mode,
            before[index]!.ino,
          ])
        }
        expect(fs.readFileSync(f.canary, 'utf8')).toBe('parent-native-cache')
      } finally {
        chmod.mockRestore()
        f.dispose()
      }
    },
  )
}

for (const scenario of [
  'inode-replaced-before-open',
  'unsupported-open',
  'chmod-failure',
  'path-replaced-after-chmod',
  'new-symlink-after-chmod',
] as const) {
  posixTest(
    `cache repair ${scenario} refuses alias and closes every opened descriptor`,
    () => {
      const f = cacheFixture(true)
      const originalOpen = fs.openSync
      const originalChmod = fs.fchmodSync
      const descriptors: number[] = []
      const saved = join(f.root, 'saved-cache')
      let replaced = false
      const replaceCache = () => {
        fs.renameSync(f.cache, saved)
        fs.mkdirSync(f.cache, { mode: 0o700 })
        fs.chmodSync(f.cache, 0o775)
        fs.writeFileSync(join(f.cache, 'replacement-canary'), 'replacement', {
          mode: 0o600,
        })
        replaced = true
      }
      const open = spyOn(fs, 'openSync').mockImplementation(
        (path, flags, mode) => {
          if (String(path) === f.cache) {
            expect(typeof flags).toBe('number')
            expect((Number(flags) & fs.constants.O_DIRECTORY) !== 0).toBe(true)
            expect((Number(flags) & fs.constants.O_NOFOLLOW) !== 0).toBe(true)
            if (scenario === 'unsupported-open')
              throw Object.assign(new Error('unsupported directory flags'), {
                code: 'ENOTSUP',
              })
            if (scenario === 'inode-replaced-before-open') replaceCache()
          }
          const fd = originalOpen(path, flags, mode)
          descriptors.push(fd)
          return fd
        },
      )
      const chmod = spyOn(fs, 'fchmodSync').mockImplementation((fd, mode) => {
        if (scenario === 'chmod-failure')
          throw Object.assign(new Error('directory chmod refused'), {
            code: 'EPERM',
          })
        originalChmod(fd, mode)
        if (scenario === 'path-replaced-after-chmod' && !replaced)
          replaceCache()
        if (scenario === 'new-symlink-after-chmod' && !replaced) {
          fs.symlinkSync(f.canary, join(f.version, 'uninspected-link'))
          replaced = true
        }
      })
      try {
        const probe = privateProbe(f.env, join(f.root, 'private-probe'))
        reuseProbeNativeCache(f.env, probe)
        expect(observe(probe).link).toBe(false)
        expect(fs.existsSync(probe.PI_NATIVES_DIR!)).toBe(false)
        for (const fd of descriptors) {
          expect(() => fs.fstatSync(fd)).toThrow()
        }
        if (
          scenario === 'inode-replaced-before-open' ||
          scenario === 'unsupported-open'
        )
          expect(chmod).not.toHaveBeenCalled()
        if (scenario === 'inode-replaced-before-open')
          expect(fs.statSync(saved).mode & 0o7777).toBe(0o775)
        if (
          scenario === 'inode-replaced-before-open' ||
          scenario === 'path-replaced-after-chmod'
        ) {
          expect(fs.statSync(f.cache).mode & 0o7777).toBe(0o775)
          expect(
            fs.readFileSync(join(f.cache, 'replacement-canary'), 'utf8'),
          ).toBe('replacement')
          const preserved = join(saved, '18.8.4', 'resident-cache-canary')
          expect(fs.readFileSync(preserved, 'utf8')).toBe('parent-native-cache')
          expect(fs.statSync(preserved).mode & 0o7777).toBe(0o755)
        } else {
          f.assertPreserved()
          if (scenario !== 'new-symlink-after-chmod') {
            expect(fs.statSync(f.cache).mode & 0o7777).toBe(0o775)
            expect(fs.statSync(f.version).mode & 0o7777).toBe(0o775)
          }
        }
      } finally {
        open.mockRestore()
        chmod.mockRestore()
        f.dispose()
      }
    },
  )
}

posixTest(
  'compiled entry reuses a loader-created 0775 cache after private-directory tightening and PI path sanitization',
  async () => {
    const f = cacheFixture(true),
      fake = fakeOpenAI()
    expect(fs.statSync(f.config).mode & 0o7777).toBe(0o700)
    expect(fs.statSync(join(f.config, 'omp')).mode & 0o7777).toBe(0o700)
    expect(fs.statSync(f.cache).mode & 0o7777).toBe(0o775)
    expect(fs.statSync(f.version).mode & 0o7777).toBe(0o775)
    const snapshot = join(f.root, 'child-snapshot.json')
    const preload = join(f.root, 'snapshot.ts')
    fs.writeFileSync(
      preload,
      `
    import {writeFileSync, existsSync, realpathSync, lstatSync, statSync} from 'node:fs';
    process.on('exit',()=>writeFileSync(${JSON.stringify(snapshot)}, JSON.stringify({
      config:process.env.QIANMO_CONFIG_DIR,
      piConfig:process.env.PI_CONFIG_DIR,
      native:process.env.PI_NATIVES_DIR,
      nativeTarget:existsSync(process.env.PI_NATIVES_DIR)?realpathSync(process.env.PI_NATIVES_DIR):null,
      nativeLink:existsSync(process.env.PI_NATIVES_DIR)&&lstatSync(process.env.PI_NATIVES_DIR).isSymbolicLink(),
      configMode:statSync(process.env.QIANMO_CONFIG_DIR).mode & 0o777,
      modelMode:statSync(process.env.QIANMO_CONFIG_DIR+'/omp/agent/models.yml').mode & 0o777,
      ambientKey:process.env.OPENAI_API_KEY!==undefined,
      unsafeAlias:process.env.Pi_Natives_Dir!==undefined,
      compiledEnvPresent:Object.hasOwn(process.env,'PI_COMPILED'),
    })));
  `,
    )
    const unsafe = join(f.root, 'external-cache-must-not-be-used')
    const env: NodeJS.ProcessEnv = {
      ...f.env,
      PI_NATIVES_DIR: unsafe,
      Pi_Natives_Dir: unsafe,
      PI_CONFIG_DIR: '.omp',
      pi_config_dir: '.omp',
      OPENAI_API_KEY: 'ambient-key-must-not-survive',
    }
    delete env.PI_COMPILED
    const before = { ...env }
    let observed: CacheObservation | undefined
    let childStderr = ''
    try {
      const result = await probeCall({
        requestId: 'compiled-shared-cache',
        baseUrl: fake.baseUrl,
        compiled: compiled(fake.baseUrl),
        timeoutMs: 10000,
        env,
        launch: (args, childEnv) => {
          observed = observe(childEnv)
          // Apply the real build's parse-time marker to the actual entry/module
          // graph. This exercises the source entry, not a standalone ELF build.
          return {
            execPath: process.execPath,
            args: [
              '--define',
              'process.env.PI_COMPILED:"true"',
              '--preload',
              preload,
              entry,
              'agent',
              ...args,
            ],
            env: childEnv,
          }
        },
        spawn: (spec, options) => {
          const child = spawn(spec.execPath, spec.args, {
            ...options,
            env: spec.env,
          })
          child.stderr?.on('data', chunk => {
            childStderr += String(chunk)
          })
          return child
        },
      })
      expect({ result, childStderr }).toMatchObject({ result: { ok: true } })
      expect(fake.requests).toHaveLength(1)
      expect(fake.requests[0]!.headers.get('authorization')).toBe(
        `Bearer ${CANARY_KEY}`,
      )
      expect(observed?.link).toBe(true)
      expect(observed?.target).toBe(fs.realpathSync(f.cache))
      expect(fs.statSync(f.cache).mode & 0o7777).toBe(0o755)
      expect(fs.statSync(f.version).mode & 0o7777).toBe(0o755)
      const actual = JSON.parse(fs.readFileSync(snapshot, 'utf8'))
      expect(actual).toMatchObject({
        config: observed!.root,
        native: observed!.path,
        nativeTarget: fs.realpathSync(f.cache),
        nativeLink: true,
        configMode: 0o700,
        modelMode: 0o600,
        ambientKey: false,
        unsafeAlias: false,
        compiledEnvPresent: false,
      })
      expect(resolve(f.env.HOME, actual.piConfig)).toBe(
        join(observed!.root, 'omp'),
      )
      expect(observed!.root).not.toBe(f.config)
      expect(fs.existsSync(observed!.root)).toBe(false)
      expect(fs.existsSync(join(f.config, 'omp', 'agent'))).toBe(false)
      expect(fs.existsSync(join(f.env.HOME, '.omp'))).toBe(false)
      expect(fs.existsSync(unsafe)).toBe(false)
      expect(env).toEqual(before)
      f.assertPreserved()
    } finally {
      fake.stop()
      f.dispose()
    }
  },
  20000,
)

for (const scenario of [
  'success',
  'nonzero-exit',
  'spawn-failed',
  'timeout',
  'abort',
  'unknown-exit',
] as const) {
  posixTest(
    `shared native cache survives ${scenario}; cleanup follows actual child exit`,
    async () => {
      const f = cacheFixture(),
        fake = fakeOpenAI()
      const controller = new AbortController()
      let observed: CacheObservation | undefined
      let child: ChildProcess | undefined,
        closed = false
      try {
        const result = probeCall({
          requestId: `cache-${scenario}`,
          baseUrl: fake.baseUrl,
          compiled: compiled(fake.baseUrl),
          env: f.env,
          timeoutMs: scenario === 'unknown-exit' ? 1 : 50,
          exitConfirmationMs: scenario === 'unknown-exit' ? 10 : undefined,
          signal: controller.signal,
          launch: (_args, env) => {
            observed = observe(env)
            return {
              execPath:
                scenario === 'spawn-failed'
                  ? '/definitely-missing-omp'
                  : process.execPath,
              args: [
                '-e',
                scenario === 'success'
                  ? okProgram
                  : scenario === 'nonzero-exit'
                    ? 'process.exit(1)'
                    : idleProgram,
              ],
              env,
            }
          },
          spawn: (spec, options) => {
            child = spawn(spec.execPath, spec.args, {
              ...options,
              env: spec.env,
            })
            child.once('close', () => {
              closed = true
            })
            if (scenario === 'abort') setTimeout(() => controller.abort(), 30)
            if (scenario === 'unknown-exit') child.kill = () => false
            return child
          },
        })
        if (scenario === 'unknown-exit')
          await expect(result).rejects.toBeInstanceOf(ProbeExitUnconfirmedError)
        else if (scenario === 'abort') await expect(result).rejects.toThrow()
        else expect((await result).ok).toBe(scenario === 'success')
        expect(observed?.link).toBe(true)
        expect(observed?.target).toBe(fs.realpathSync(f.cache))
        expect(fs.existsSync(observed!.root)).toBe(scenario === 'unknown-exit')
        if (scenario === 'unknown-exit') {
          expect(closed).toBe(false)
          expect(() => process.kill(child!.pid!, 0)).not.toThrow()
        } else if (scenario !== 'spawn-failed') {
          expect(closed).toBe(true)
          expect(() => process.kill(child!.pid!, 0)).toThrow()
        }
        f.assertPreserved()
      } finally {
        if (
          child?.pid &&
          child.exitCode === null &&
          child.signalCode === null
        ) {
          const exited = new Promise<void>(resolve =>
            child!.once('close', () => resolve()),
          )
          process.kill(child.pid, 'SIGKILL')
          await exited
        }
        fake.stop()
        f.dispose()
      }
    },
    5000,
  )
}

for (const scenario of [
  'missing',
  'root-link',
  'parent-link',
  'version-link',
  'file-link',
  'writable-root',
  'writable-file',
  'wrong-owner',
  'unsupported-link',
] as const) {
  posixTest(
    `native cache ${scenario} safely keeps the private probe path`,
    async () => {
      const f = cacheFixture(),
        fake = fakeOpenAI()
      let restore = () => {}
      let observed: CacheObservation | undefined
      try {
        const external = join(f.root, 'external')
        fs.mkdirSync(external, { mode: 0o700 })
        fs.writeFileSync(join(external, 'keep'), 'external-canary', {
          mode: 0o600,
        })
        if (scenario === 'missing') fs.rmSync(f.config, { recursive: true })
        if (scenario === 'root-link') {
          fs.renameSync(f.cache, join(f.root, 'saved-cache'))
          fs.symlinkSync(external, f.cache, 'dir')
        }
        if (scenario === 'parent-link') {
          fs.renameSync(join(f.config, 'omp'), join(f.root, 'saved-omp'))
          fs.mkdirSync(join(external, 'natives'), { mode: 0o700 })
          fs.symlinkSync(external, join(f.config, 'omp'), 'dir')
        }
        if (scenario === 'version-link')
          fs.symlinkSync(external, join(f.cache, '18.8.4'), 'dir')
        if (scenario === 'file-link')
          fs.symlinkSync(join(external, 'keep'), join(f.cache, 'addon.node'))
        if (scenario === 'writable-root') fs.chmodSync(f.cache, 0o777)
        if (scenario === 'writable-file') fs.chmodSync(f.canary, 0o666)
        if (scenario === 'wrong-owner') {
          const uid = process.getuid!()
          const mocked = spyOn(process, 'getuid').mockReturnValue(uid + 1)
          restore = () => mocked.mockRestore()
        }
        if (scenario === 'unsupported-link') {
          const mocked = spyOn(fs, 'symlinkSync').mockImplementation(() => {
            throw Object.assign(new Error('unsupported fixture'), {
              code: 'ENOTSUP',
            })
          })
          restore = () => mocked.mockRestore()
        }
        const result = await probeCall({
          requestId: `cache-${scenario}`,
          baseUrl: fake.baseUrl,
          compiled: compiled(fake.baseUrl),
          env: f.env,
          timeoutMs: 1000,
          launch: (_args, env) => {
            observed = observe(env)
            return { execPath: process.execPath, args: ['-e', okProgram], env }
          },
        })
        expect(result.ok).toBe(true)
        expect(observed).toBeDefined()
        expect(observed!.link).toBe(false)
        expect(observed!.path).toBe(join(observed!.root, 'omp', 'natives'))
        expect(fs.existsSync(observed!.root)).toBe(false)
        expect(fs.readFileSync(join(external, 'keep'), 'utf8')).toBe(
          'external-canary',
        )
        if (scenario === 'missing') expect(fs.existsSync(f.config)).toBe(false)
        if (scenario === 'wrong-owner' || scenario === 'unsupported-link')
          f.assertPreserved()
      } finally {
        restore()
        fake.stop()
        f.dispose()
      }
    },
    5000,
  )
}
