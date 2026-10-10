// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const entry = resolve(import.meta.dir, '../../src/bin/compiled.ts')
const snapshot = resolve(import.meta.dir, 'compiledEnvironment.snapshot.ts')

for (const [name, args] of [
  ['plain qm', ['--version']],
  ['resident', ['resident', '--help']],
  ['agent', ['agent', '--help']],
  ['worker selector', ['__omp_worker_invalid_entry_test', '--help']],
] as const) {
  test(`${name} initializes the compiled process environment before dispatch`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'qm-entry-env-'))
    const home = join(root, 'home')
    const config = join(root, 'explicit-node')
    const output = join(root, 'env.json')
    mkdirSync(home)
    mkdirSync(join(config, 'omp', 'agent'), { recursive: true })
    writeFileSync(
      join(config, 'omp', 'agent', 'models.yml'),
      JSON.stringify({
        providers: {
          'qm-entry-test': {
            apiKey: 'ENTRY_LITERAL_KEY',
            headers: { 'x-test-header': 'ENTRY_LITERAL_HEADER' },
          },
        },
      }),
    )
    const child = Bun.spawn(
      [process.execPath, '--preload', snapshot, entry, ...args],
      {
        cwd: root,
        env: {
          ...process.env,
          HOME: home,
          QIANMO_CONFIG_DIR: config,
          QIANMO_MEMORY_DIR: join(root, 'explicit-memory'),
          QIANMO_TEST_ENV_SNAPSHOT: output,
          PI_COMPILED: 'true',
          PI_CONFIG_DIR: '.omp',
          PI_NATIVES_DIR: join(root, 'unrelated-native-root'),
          pi_config_dir: '.unrelated',
          Pi_Natives_Dir: join(root, 'unrelated-native-case-root'),
          OMP_PROFILE: 'unrelated',
          PI_CODING_AGENT_DIR: join(root, 'unrelated-agent'),
          XDG_CONFIG_HOME: join(root, 'unrelated-xdg'),
          CLAUDE_CONFIG_DIR: join(root, 'unrelated-claude'),
          ENTRY_LITERAL_KEY: 'synthetic-key-must-not-survive',
          entry_literal_header: 'synthetic-header-must-not-survive',
          ENTRY_UNRELATED: 'keep-this-value',
        },
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
    const timeout = setTimeout(() => child.kill('SIGKILL'), 15000)
    try {
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      if (name !== 'worker selector') {
        expect({ code, stderr }).toEqual({ code: 0, stderr: '' })
        expect(stdout.length).toBeGreaterThan(0)
      }
      expect(existsSync(output)).toBe(true)
      const env = JSON.parse(readFileSync(output, 'utf8')) as Record<
        string,
        string
      >
      expect(env.HOME).toBe(home)
      expect(env.QIANMO_CONFIG_DIR).toBe(config)
      expect(env.QIANMO_MEMORY_DIR).toBe(join(root, 'explicit-memory'))
      expect(env.QIANMO_OMP_ENTRY).toBe('self')
      expect(resolve(home, env.PI_CONFIG_DIR!)).toBe(join(config, 'omp'))
      expect(env.PI_NATIVES_DIR).toBe(join(config, 'omp', 'natives'))
      for (const name of [
        'pi_config_dir',
        'Pi_Natives_Dir',
        'OMP_PROFILE',
        'PI_CODING_AGENT_DIR',
        'XDG_CONFIG_HOME',
        'CLAUDE_CONFIG_DIR',
        'ENTRY_LITERAL_KEY',
        'entry_literal_header',
      ])
        expect(env[name]).toBeUndefined()
      expect(env.ENTRY_UNRELATED).toBe('keep-this-value')
      expect(existsSync(join(home, '.omp'))).toBe(false)
      expect(existsSync(join(home, '.claude'))).toBe(false)
    } finally {
      clearTimeout(timeout)
      child.kill('SIGKILL')
      await child.exited
      rmSync(root, { recursive: true, force: true })
    }
  }, 20000)
}
