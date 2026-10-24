// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  AGENT_SPECS,
  type AgentsReport,
  formatAgents,
  type LocalAgent,
  type ScanOptions,
  scanAgents,
} from '../src/agents.ts'
import { main, USAGE } from '../src/cli.ts'
import type { ClientIO } from '../src/commands.ts'
import {
  type AgentFs,
  loginShellAsker,
  type RunProbe,
  runProbe,
  systemFs,
} from '../src/computer.ts'

const posix = process.platform !== 'win32'
/** The platform the rule tests run as: this host's kind of PATH and programs. */
const PLATFORM: NodeJS.Platform = posix ? 'linux' : 'win32'

const roots: string[] = []
const savedClientDir = process.env.QMO_CLIENT_DIR
afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true })
  if (savedClientDir === undefined) delete process.env.QMO_CLIENT_DIR
  else process.env.QMO_CLIENT_DIR = savedClientDir
})

function sandbox() {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'qmo-agents-')),
  )
  roots.push(root)
  const home = path.join(root, 'home')
  const bin = path.join(root, 'bin')
  fs.mkdirSync(home)
  fs.mkdirSync(bin)
  return { root, home, bin, cache: path.join(root, 'client', 'agents.json') }
}

type Box = ReturnType<typeof sandbox>

function put(file: string, text = ''): string {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
  return file
}

/** A program named `command` in `dir`: a shell script, or a `.cmd` on Windows. */
function fakeBin(dir: string, command: string, script = 'exit 0'): string {
  const file = path.join(dir, posix ? command : `${command}.cmd`)
  put(file, posix ? `#!/bin/sh\n${script}\n` : '@echo off\r\n')
  fs.chmodSync(file, 0o755)
  return file
}

/** Answers probes by program and arguments; records each. */
function fakeRun(
  answer: (
    program: string,
    args: readonly string[],
    bin: string,
  ) => Partial<Awaited<ReturnType<RunProbe>>> = () => ({}),
) {
  const asked: string[] = []
  const run: RunProbe = async argv => {
    const bin = argv[0]!
    const program = path.basename(bin).replace(/\.(cmd|exe)$/i, '')
    asked.push([program, ...argv.slice(1)].join(' '))
    return {
      code: 0,
      stdout: '',
      stderr: '',
      timedOut: false,
      ...answer(program, argv.slice(1), bin),
    }
  }
  return { run, asked }
}

function base(box: Box, extra: Partial<ScanOptions> = {}): ScanOptions {
  return {
    platform: PLATFORM,
    env: { PATH: box.bin },
    home: box.home,
    systemDirs: [],
    appDirs: [path.join(box.root, 'Applications')],
    loginShell: null,
    run: fakeRun().run,
    ...extra,
  }
}

function agent(report: AgentsReport, id: string): LocalAgent | undefined {
  return report.agents.find(one => one.id === id)
}

function ids(report: AgentsReport): string[] {
  return report.agents.map(one => one.id)
}

const QIANMOPI: LocalAgent = {
  id: 'omp',
  name: 'qianmopi',
  version: null,
  path: null,
  protocol: 'omp',
  available: true,
  reason: null,
  source: 'builtin',
  configFound: false,
  signedIn: null,
}

describe('the registry', () => {
  test('the six the node drives, then the ones it does not', () => {
    expect(AGENT_SPECS.map(spec => spec.id)).toEqual([
      'claude-code',
      'codex',
      'gemini',
      'qwen',
      'opencode',
      'dsh',
      'cursor',
      'kimi',
      'droid',
      'copilot',
      'goose',
    ])
    expect(
      AGENT_SPECS.filter(spec => spec.protocol !== null).map(
        spec => spec.protocol,
      ),
    ).toEqual(['claude-stream', 'codex-app-server', 'acp', 'acp', 'acp', 'acp'])
    expect(
      AGENT_SPECS.filter(spec => spec.identity).map(spec => spec.id),
    ).toEqual(['dsh'])
  })

  test('no config file it looks for is a credential or login file', () => {
    const home = path.join(os.tmpdir(), 'nobody')
    const place = {
      platform: PLATFORM,
      home,
      env: () => undefined,
      isDir: () => false,
      exe: (name: string) => name,
    }
    for (const spec of AGENT_SPECS)
      for (const file of spec.config(place).files)
        expect(file).not.toMatch(/cred|auth|oauth|token|\.claude\.json|key/i)
  })
})

describe('what says an agent is here, in order', () => {
  test('nothing: only qianmopi, built in', async () => {
    const box = sandbox()
    expect(await scanAgents(base(box))).toEqual({ agents: [QIANMOPI] })
  })

  test('its command on PATH: available, the version read from its npm package', async () => {
    const box = sandbox()
    const pkg = path.join(
      box.root,
      'prefix',
      'node_modules',
      '@openai',
      'codex',
    )
    put(
      path.join(pkg, 'package.json'),
      JSON.stringify({ name: '@openai/codex', version: '0.163.0' }),
    )
    const codex = fakeBin(path.join(pkg, 'bin'), 'codex')
    const probes = fakeRun()
    const report = await scanAgents(
      base(box, {
        env: { PATH: path.join(pkg, 'bin') },
        run: probes.run,
      }),
    )
    expect(agent(report, 'codex')).toEqual({
      id: 'codex',
      name: 'Codex',
      version: '0.163.0',
      path: codex,
      protocol: 'codex-app-server',
      available: true,
      reason: null,
      source: 'path',
      configFound: false,
      signedIn: null,
    })
    // Read, not run.
    expect(probes.asked).toEqual([])
  })

  test('a package of another name says nothing: --version is asked', async () => {
    const box = sandbox()
    const pkg = path.join(box.root, 'prefix', 'node_modules', 'codex-wrapper')
    put(
      path.join(pkg, 'package.json'),
      JSON.stringify({ name: 'codex-wrapper', version: '9.9.9' }),
    )
    fakeBin(path.join(pkg, 'bin'), 'codex')
    const probes = fakeRun(() => ({ stdout: 'codex-cli 0.164.0\n' }))
    const report = await scanAgents(
      base(box, { env: { PATH: path.join(pkg, 'bin') }, run: probes.run }),
    )
    expect(agent(report, 'codex')?.version).toBe('0.164.0')
    expect(probes.asked).toEqual(['codex --version'])
  })

  test('a file where its folder goes beats its config and its command', async () => {
    const box = sandbox()
    put(path.join(box.home, '.dsh'), 'a shell history, not a folder')
    fakeBin(box.bin, 'dsh')
    const probes = fakeRun(() => ({
      stdout: 'dsh: boot a DeepSeek Harness profile',
    }))
    const report = await scanAgents(base(box, { run: probes.run }))
    expect(agent(report, 'dsh')).toBeUndefined()
    expect(probes.asked).toEqual([])
  })

  test('a config file alone: listed, CLI not found', async () => {
    const box = sandbox()
    put(path.join(box.home, '.codex', 'config.toml'))
    const report = await scanAgents(base(box))
    expect(agent(report, 'codex')).toMatchObject({
      available: false,
      path: null,
      version: null,
      source: null,
      configFound: true,
      reason: `CLI 未找到（有 ${path.join(box.home, '.codex')}，但 PATH 与常见安装位置里都没有 codex）`,
    })
  })

  test('its command alone: available, no config', async () => {
    const box = sandbox()
    const claude = fakeBin(box.bin, 'claude')
    const report = await scanAgents(
      base(box, {
        run: fakeRun(() => ({ stdout: '2.1.309 (Claude Code)\n' })).run,
      }),
    )
    expect(agent(report, 'claude-code')).toMatchObject({
      available: true,
      path: claude,
      version: '2.1.309',
      configFound: false,
    })
  })

  test('Gemini CLI is its command only: ~/.gemini is Antigravity’s too', async () => {
    const box = sandbox()
    put(path.join(box.home, '.gemini', 'settings.json'), '{}')
    fs.mkdirSync(path.join(box.home, '.gemini', 'antigravity'))
    expect(agent(await scanAgents(base(box)), 'gemini')).toBeUndefined()
    const gemini = fakeBin(box.bin, 'gemini')
    expect(agent(await scanAgents(base(box)), 'gemini')).toMatchObject({
      available: true,
      path: gemini,
      configFound: true,
    })
  })

  test('a folder holding only what stays after an uninstall is no sign', async () => {
    const box = sandbox()
    const qwen = path.join(box.home, '.qwen')
    fs.mkdirSync(path.join(qwen, 'debug'), { recursive: true })
    fs.mkdirSync(path.join(qwen, 'skills', 'tidy'), { recursive: true })
    fs.mkdirSync(path.join(qwen, 'Logs'))
    put(path.join(qwen, '.DS_Store'))
    expect(agent(await scanAgents(base(box)), 'qwen')).toBeUndefined()
    // A file of a leftover's name is the agent's own.
    put(path.join(qwen, 'cache'))
    expect(agent(await scanAgents(base(box)), 'qwen')).toMatchObject({
      configFound: true,
      available: false,
    })
  })

  test('a folder another app keeps too is no sign; its own config file is', async () => {
    const box = sandbox()
    fs.mkdirSync(path.join(box.home, '.cursor', 'extensions'), {
      recursive: true,
    })
    put(path.join(box.home, '.cursor', 'argv.json'), '{}')
    fs.mkdirSync(path.join(box.home, '.copilot', 'ide'), { recursive: true })
    let report = await scanAgents(base(box))
    expect(agent(report, 'cursor')).toBeUndefined()
    expect(agent(report, 'copilot')).toBeUndefined()
    put(path.join(box.home, '.cursor', 'cli-config.json'), '{}')
    report = await scanAgents(base(box))
    expect(agent(report, 'cursor')).toMatchObject({
      name: 'Cursor CLI',
      protocol: null,
      available: false,
      reason: '暂不支持接入',
      configFound: true,
    })
  })

  test('one the node cannot drive is still listed, with its version', async () => {
    const box = sandbox()
    const kimi = fakeBin(box.bin, 'kimi')
    const report = await scanAgents(
      base(box, {
        run: fakeRun(() => ({ stdout: 'kimi, version 1.52.0' })).run,
      }),
    )
    expect(agent(report, 'kimi')).toEqual({
      id: 'kimi',
      name: 'Kimi Code',
      version: '1.52.0',
      path: kimi,
      protocol: null,
      available: false,
      reason: '暂不支持接入',
      source: 'path',
      configFound: false,
      signedIn: null,
    })
  })

  test('where its vendor’s installer puts it, off PATH', async () => {
    const box = sandbox()
    const exe = (name: string) => (posix ? name : `${name}.exe`)
    const opencode = put(
      path.join(box.home, '.opencode', 'bin', exe('opencode')),
    )
    const claude = put(path.join(box.home, '.claude', 'local', exe('claude')))
    fs.chmodSync(opencode, 0o755)
    fs.chmodSync(claude, 0o755)
    const report = await scanAgents(base(box))
    expect(agent(report, 'opencode')).toMatchObject({
      available: true,
      path: opencode,
      source: 'vendor',
    })
    expect(agent(report, 'claude-code')).toMatchObject({
      available: true,
      path: claude,
      source: 'vendor',
    })
  })

  test('DeepSeek Harness’s macOS app, without its command', async () => {
    const box = sandbox()
    fs.mkdirSync(path.join(box.root, 'Applications', 'DeepSeek Harness.app'), {
      recursive: true,
    })
    expect(
      agent(await scanAgents(base(box, { platform: 'darwin' })), 'dsh'),
    ).toMatchObject({
      available: false,
      configFound: false,
      reason: 'CLI 未找到（只装了桌面 App）',
    })
    expect(agent(await scanAgents(base(box)), 'dsh')).toBeUndefined()
  })

  test.skipIf(!posix)(
    'goose only where Homebrew’s block-goose-cli or its installer put it',
    async () => {
      const box = sandbox()
      // pressly's goose, a database migration tool.
      fakeBin(box.bin, 'goose')
      expect(agent(await scanAgents(base(box)), 'goose')).toBeUndefined()
      const brew = path.join(box.root, 'brew')
      const keg = fakeBin(
        path.join(brew, 'Cellar', 'block-goose-cli', '1.9.0', 'bin'),
        'goose',
      )
      fs.mkdirSync(path.join(brew, 'bin'))
      fs.symlinkSync(keg, path.join(brew, 'bin', 'goose'))
      const report = await scanAgents(
        base(box, { env: { PATH: `${box.bin}:${path.join(brew, 'bin')}` } }),
      )
      expect(agent(report, 'goose')).toMatchObject({
        path: path.join(brew, 'bin', 'goose'),
        source: 'brew',
        reason: '暂不支持接入',
      })
    },
  )
})

describe('where an agent keeps its config, as its variables say', () => {
  test('each variable moves its folder; a relative one is passed over', async () => {
    const box = sandbox()
    const at = (name: string) => path.join(box.root, name)
    put(path.join(at('claude'), 'settings.json'))
    put(path.join(at('codex'), 'config.toml'))
    put(path.join(at('qwen'), 'settings.json'))
    put(path.join(at('oc'), 'opencode.json'))
    put(path.join(at('dsh'), 'config.yaml'))
    const report = await scanAgents(
      base(box, {
        env: {
          PATH: box.bin,
          CLAUDE_CONFIG_DIR: at('claude'),
          CODEX_HOME: at('codex'),
          QWEN_HOME: at('qwen'),
          OPENCODE_CONFIG_DIR: at('oc'),
          DSH_HOME: at('dsh'),
          // Relative: not where the agent looks from anywhere in particular.
          XDG_CONFIG_HOME: 'cfg',
        },
      }),
    )
    for (const [id, dir] of [
      ['claude-code', 'claude'],
      ['codex', 'codex'],
      ['qwen', 'qwen'],
      ['opencode', 'oc'],
      ['dsh', 'dsh'],
    ] as const)
      expect(agent(report, id)?.reason).toContain(at(dir))
  })

  test('XDG_CONFIG_HOME moves opencode’s and goose’s', async () => {
    const box = sandbox()
    const cfg = path.join(box.root, 'cfg')
    put(path.join(cfg, 'opencode', 'opencode.jsonc'))
    put(path.join(cfg, 'goose', 'config.yaml'))
    put(path.join(box.home, '.config', 'goose', 'config.yaml'))
    const report = await scanAgents(
      base(box, { env: { PATH: box.bin, XDG_CONFIG_HOME: cfg } }),
    )
    expect(agent(report, 'opencode')?.reason).toContain(
      path.join(cfg, 'opencode'),
    )
    expect(agent(report, 'goose')?.configFound).toBe(true)
  })

  test('the login shell’s, when this process has none; this process’s first', async () => {
    const box = sandbox()
    put(path.join(box.root, 'codex-a', 'config.toml'))
    put(path.join(box.root, 'codex-b', 'config.toml'))
    const login = async () => ({
      path: [],
      vars: { CODEX_HOME: path.join(box.root, 'codex-a') },
    })
    expect(
      agent(await scanAgents(base(box, { loginShell: login })), 'codex')
        ?.reason,
    ).toContain(path.join(box.root, 'codex-a'))
    expect(
      agent(
        await scanAgents(
          base(box, {
            loginShell: login,
            env: { PATH: box.bin, CODEX_HOME: path.join(box.root, 'codex-b') },
          }),
        ),
        'codex',
      )?.reason,
    ).toContain(path.join(box.root, 'codex-b'))
  })
})

describe('DeepSeek Harness, told from other programs named dsh', () => {
  const DEBIAN =
    "Distributed Shell / Dancer's shell. version 0.25.10\nUsage: dsh [-v|-q] [-M|-H] [commandline]\n"
  const DEEPSEEK =
    'Usage: dsh [--profile] <name> [options] [app-args...]\n\ndsh: boot a DeepSeek Harness profile\n'

  test('the first that says so is taken; another one is reported', async () => {
    const box = sandbox()
    const other = path.join(box.root, 'usr-bin')
    const debian = fakeBin(other, 'dsh')
    const deepseek = fakeBin(box.bin, 'dsh')
    const probes = fakeRun((_, args, bin) =>
      args[0] === '--help'
        ? { stdout: bin === debian ? DEBIAN : DEEPSEEK }
        : { stdout: '0.2.1-rc.2\n' },
    )
    const delimiter = posix ? ':' : ';'
    let report = await scanAgents(
      base(box, {
        env: { PATH: `${other}${delimiter}${box.bin}` },
        run: probes.run,
      }),
    )
    expect(agent(report, 'dsh')).toMatchObject({
      available: true,
      path: deepseek,
      version: '0.2.1-rc.2',
    })
    expect(probes.asked).toEqual(['dsh --help', 'dsh --help', 'dsh --version'])

    probes.asked.length = 0
    report = await scanAgents(
      base(box, { env: { PATH: other }, run: probes.run }),
    )
    expect(agent(report, 'dsh')).toEqual({
      id: 'dsh',
      name: 'DeepSeek Harness',
      version: null,
      path: null,
      protocol: 'acp',
      available: false,
      reason: `${debian} 不是 DeepSeek Harness（它的 --help 里没有这个名字）`,
      source: null,
      configFound: false,
      signedIn: null,
    })
    // Not asked its version: it is not the agent.
    expect(probes.asked).toEqual(['dsh --help'])
  })

  test('a program of its own npm package needs no asking', async () => {
    const box = sandbox()
    const pkg = path.join(
      box.root,
      'npm',
      'node_modules',
      '@deepseek-ai',
      'dsh',
    )
    put(
      path.join(pkg, 'package.json'),
      JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.1-rc.2' }),
    )
    const dsh = fakeBin(path.join(pkg, 'bin'), 'dsh')
    const probes = fakeRun(() => ({ stdout: DEBIAN }))
    const report = await scanAgents(
      base(box, { env: { PATH: path.join(pkg, 'bin') }, run: probes.run }),
    )
    expect(agent(report, 'dsh')).toMatchObject({
      available: true,
      path: dsh,
      version: '0.2.1-rc.2',
    })
    expect(probes.asked).toEqual([])
  })

  test('one that cannot be asked is not taken either', async () => {
    const box = sandbox()
    const dsh = fakeBin(box.bin, 'dsh')
    const report = await scanAgents(
      base(box, {
        run: fakeRun(() => ({ code: null, timedOut: true })).run,
      }),
    )
    expect(agent(report, 'dsh')?.reason).toBe(
      `${dsh} 核对不了是不是 DeepSeek Harness（dsh --help：10 秒没有结束）`,
    )
  })
})

describe('answers kept between runs', () => {
  const HOUR = 60 * 60 * 1000

  test('a version a day, a failed one ten minutes, a new binary at once', async () => {
    const box = sandbox()
    const claude = fakeBin(box.bin, 'claude')
    let now = 1_000_000
    let says = '2.1.309 (Claude Code)'
    const probes = fakeRun(() => ({ stdout: says }))
    const scan = (rescan = false) =>
      scanAgents(
        base(box, {
          run: probes.run,
          cacheFile: box.cache,
          now: () => now,
          rescan,
        }),
      )

    expect(agent(await scan(), 'claude-code')?.version).toBe('2.1.309')
    now += 23 * HOUR
    expect(agent(await scan(), 'claude-code')?.version).toBe('2.1.309')
    expect(probes.asked).toEqual(['claude --version'])
    now += 2 * HOUR
    await scan()
    expect(probes.asked).toHaveLength(2)

    // Updated in place: another size, another stamp.
    says = '2.1.310 (Claude Code)'
    fs.appendFileSync(claude, posix ? '# 2.1.310\n' : 'rem 2.1.310\r\n')
    expect(agent(await scan(), 'claude-code')?.version).toBe('2.1.310')
    expect(probes.asked).toHaveLength(3)

    // --rescan asks whatever is kept.
    expect(agent(await scan(true), 'claude-code')?.version).toBe('2.1.310')
    expect(probes.asked).toHaveLength(4)

    // A version that cannot be read is asked again after ten minutes.
    says = 'claude: unknown option'
    fs.appendFileSync(claude, posix ? '# broken\n' : 'rem broken\r\n')
    expect(agent(await scan(), 'claude-code')?.version).toBeNull()
    now += 9 * 60 * 1000
    await scan()
    expect(probes.asked).toHaveLength(5)
    now += 2 * 60 * 1000
    await scan()
    expect(probes.asked).toHaveLength(6)

    if (posix) expect(fs.statSync(box.cache).mode & 0o777).toBe(0o600)
  })

  test('a damaged or foreign cache is not taken, and is replaced', async () => {
    const box = sandbox()
    fakeBin(box.bin, 'claude')
    put(box.cache, 'not json')
    if (posix) {
      fs.chmodSync(path.dirname(box.cache), 0o700)
      fs.chmodSync(box.cache, 0o600)
    }
    const probes = fakeRun(() => ({ stdout: '2.1.309' }))
    const options = base(box, { run: probes.run, cacheFile: box.cache })
    await scanAgents(options)
    await scanAgents(options)
    expect(probes.asked).toEqual(['claude --version'])
    if (posix) {
      // Readable by others: refused, asked anew, and rewritten 0600.
      fs.chmodSync(box.cache, 0o644)
      await scanAgents(options)
      expect(probes.asked).toHaveLength(2)
      expect(fs.statSync(box.cache).mode & 0o777).toBe(0o600)
    }
  })
})

describe('the login shell’s PATH', () => {
  test('what it adds is looked in after this process’s PATH; asked once in ten minutes', async () => {
    const box = sandbox()
    const loginBin = path.join(box.root, 'login-bin')
    const fromLogin = fakeBin(loginBin, 'gemini')
    const asked: number[] = []
    let now = 5_000_000
    const options = (extra: Partial<ScanOptions> = {}) =>
      base(box, {
        cacheFile: box.cache,
        now: () => now,
        loginShell: async (names, timeoutMs) => {
          expect(names).toContain('CLAUDE_CONFIG_DIR')
          expect(names).toContain('CODEX_HOME')
          asked.push(timeoutMs)
          return { path: [loginBin], vars: {} }
        },
        ...extra,
      })
    expect(agent(await scanAgents(options()), 'gemini')).toMatchObject({
      path: fromLogin,
      source: 'path',
    })
    await scanAgents(options())
    expect(asked).toEqual([2000])
    now += 11 * 60 * 1000
    await scanAgents(options())
    await scanAgents(options({ rescan: true }))
    expect(asked).toEqual([2000, 2000, 5000])

    // The same command on this process's PATH comes first.
    const own = fakeBin(box.bin, 'gemini')
    expect(
      agent(await scanAgents(options({ rescan: true })), 'gemini')?.path,
    ).toBe(own)
  })

  test.skipIf(!posix)(
    'asked as a terminal opens it: interactive, else login only; the answer between marks',
    async () => {
      const box = sandbox()
      const extra = path.join(box.root, 'from-profile')
      fs.mkdirSync(extra)
      const log = path.join(box.root, 'asked.log')
      const shell = fakeBin(
        box.root,
        'fake-zsh',
        [
          `echo "$1 $QMO_SHELL_PROBE" >> '${log}'`,
          // A profile that hands an interactive shell to something else.
          '[ "$1" = "-ilc" ] && exit 1',
          'echo "welcome to this computer"',
          `export PATH="${extra}:/usr/bin:/bin"`,
          `export CODEX_HOME=/srv/codex`,
          'exec /bin/sh -c "$2"',
        ].join('\n'),
      )
      const ask = loginShellAsker({ SHELL: shell, PATH: '/usr/bin:/bin' })
      const answer = await ask(['CODEX_HOME', 'CLAUDE_CONFIG_DIR'], 5000)
      expect(answer).toEqual({
        path: [extra, '/usr/bin', '/bin'],
        vars: { CODEX_HOME: '/srv/codex' },
      })
      expect(fs.readFileSync(log, 'utf8')).toBe('-ilc 1\n-lc 1\n')
    },
  )

  test.skipIf(!posix)(
    'a profile that never finishes is given up on in time',
    async () => {
      const box = sandbox()
      const shell = fakeBin(box.root, 'slow-shell', 'sleep 30')
      const started = Date.now()
      expect(
        await loginShellAsker({ SHELL: shell, PATH: '/usr/bin:/bin' })(
          ['CODEX_HOME'],
          400,
        ),
      ).toBe(null)
      expect(Date.now() - started).toBeLessThan(5000)
    },
  )
})

describe.skipIf(!posix)('real probes', () => {
  test('stdout and stderr; a probe past its time is stopped with what it started', async () => {
    const box = sandbox()
    const says = fakeBin(box.root, 'says', 'echo out; echo err >&2; exit 3')
    const sh = { PATH: '/usr/bin:/bin' }
    expect(await runProbe([says, '--version'], sh, 5000)).toEqual({
      code: 3,
      stdout: 'out\n',
      stderr: 'err\n',
      timedOut: false,
    })
    const pidFile = path.join(box.root, 'child.pid')
    const hangs = fakeBin(
      box.root,
      'hangs',
      `sleep 30 & echo $! > '${pidFile}'; wait`,
    )
    const result = await runProbe([hangs], sh, 1500)
    expect(result.timedOut).toBe(true)
    expect(result.code).toBeNull()
    const child = Number(fs.readFileSync(pidFile, 'utf8'))
    await Bun.sleep(100)
    expect(() => process.kill(child, 0)).toThrow()
  })

  test('a probe that exits while something it started holds its pipes', async () => {
    const box = sandbox()
    const pidFile = path.join(box.root, 'held.pid')
    const holds = fakeBin(
      box.root,
      'holds',
      `sleep 30 & echo $! > '${pidFile}'; echo 1.2.3`,
    )
    const started = Date.now()
    const result = await runProbe(
      [holds, '--version'],
      { PATH: '/usr/bin:/bin' },
      10_000,
    )
    expect(result).toEqual({
      code: 0,
      stdout: '1.2.3\n',
      stderr: '',
      timedOut: false,
    })
    expect(Date.now() - started).toBeLessThan(5000)
    const held = Number(fs.readFileSync(pidFile, 'utf8'))
    await Bun.sleep(100)
    expect(() => process.kill(held, 0)).toThrow()
  })

  test('a scan with real programs, kept between runs', async () => {
    const box = sandbox()
    const count = path.join(box.root, 'runs.log')
    fakeBin(
      box.bin,
      'claude',
      `echo "claude $*" >> '${count}'; echo "2.1.309 (Claude Code)"`,
    )
    fakeBin(
      box.bin,
      'dsh',
      `echo "dsh $*" >> '${count}'; [ "$1" = --help ] && echo 'dsh: boot a DeepSeek Harness profile'; [ "$1" = --version ] && echo 0.2.1-rc.2; exit 0`,
    )
    const options = base(box, { run: runProbe, cacheFile: box.cache })
    const report = await scanAgents(options)
    expect(agent(report, 'claude-code')?.version).toBe('2.1.309')
    expect(agent(report, 'dsh')).toMatchObject({
      available: true,
      version: '0.2.1-rc.2',
    })
    const runs = fs.readFileSync(count, 'utf8').trim().split('\n').sort()
    expect(runs).toEqual(['claude --version', 'dsh --help', 'dsh --version'])
    await scanAgents(options)
    expect(fs.readFileSync(count, 'utf8').trim().split('\n')).toHaveLength(3)
  })
})

describe('an agent’s credentials and login files', () => {
  test('are never opened, nor anything under its folder; nothing is written there', async () => {
    const box = sandbox()
    const { home } = box
    const secrets = [
      put(path.join(home, '.claude', '.credentials.json'), '{"secret":1}'),
      put(path.join(home, '.claude.json'), '{"oauthAccount":{}}'),
      put(path.join(home, '.codex', 'auth.json'), '{"tokens":{}}'),
      put(path.join(home, '.gemini', 'oauth_creds.json'), '{}'),
      put(path.join(home, '.qwen', 'oauth_creds.json'), '{}'),
      put(path.join(home, '.dsh', '.credentials.yaml'), 'key: x'),
      put(path.join(home, '.local', 'share', 'opencode', 'auth.json'), '{}'),
      put(path.join(home, '.factory', 'auth.json'), '{}'),
    ]
    put(path.join(home, '.claude', 'settings.json'), '{}')
    put(path.join(home, '.codex', 'config.toml'))
    put(path.join(home, '.config', 'opencode', 'opencode.json'), '{}')
    const pkg = path.join(
      box.root,
      'npm',
      'node_modules',
      '@google',
      'gemini-cli',
    )
    put(
      path.join(pkg, 'package.json'),
      JSON.stringify({ name: '@google/gemini-cli', version: '0.64.0' }),
    )
    const delimiter = posix ? ':' : ';'
    for (const command of ['claude', 'codex', 'qwen', 'dsh'])
      fakeBin(box.bin, command)
    fakeBin(path.join(pkg, 'bundle'), 'gemini')

    const snapshot = () =>
      (fs.readdirSync(home, { recursive: true }) as string[])
        .sort()
        .map(name => {
          const stat = fs.statSync(path.join(home, name))
          return `${name} ${stat.size} ${stat.mtimeMs}`
        })
    const before = snapshot()
    const calls: { op: string; file: string }[] = []
    const seen =
      <T>(op: string, look: (file: string) => T) =>
      (file: string): T => {
        calls.push({ op, file })
        return look(file)
      }
    const recording: AgentFs = {
      stat: seen('stat', systemFs.stat),
      realpath: seen('realpath', systemFs.realpath),
      list: seen('list', systemFs.list),
      read: seen('read', systemFs.read),
    }
    const report = await scanAgents(
      base(box, {
        fs: recording,
        env: { PATH: `${box.bin}${delimiter}${path.join(pkg, 'bundle')}` },
        run: fakeRun(program =>
          program === 'dsh'
            ? { stdout: 'dsh: boot a DeepSeek Harness profile' }
            : { stdout: '1.0.0' },
        ).run,
      }),
    )
    expect(ids(report)).toEqual([
      'omp',
      'claude-code',
      'codex',
      'gemini',
      'qwen',
      'opencode',
      'dsh',
      'droid',
    ])
    // Not even looked at: their names are only seen in a folder's listing.
    for (const secret of secrets)
      expect(calls.filter(call => call.file === secret)).toEqual([])
    // The only files read are npm manifests, none under the home folder.
    const reads = calls
      .filter(call => call.op === 'read')
      .map(call => call.file)
    expect(reads.length).toBeGreaterThan(0)
    for (const file of reads) {
      expect(path.basename(file)).toBe('package.json')
      expect(file.split(path.sep)).toContain('node_modules')
      expect(file.startsWith(home)).toBe(false)
    }
    expect(snapshot()).toEqual(before)
  })
})

describe('Windows: PATHEXT, npm’s shims, no login shell', () => {
  test('claude.cmd is found, its version read from the package beside it', async () => {
    const box = sandbox()
    const npm = path.join(box.root, 'AppData', 'Roaming', 'npm')
    const shim = put(
      path.join(npm, 'claude.cmd'),
      [
        '@ECHO off',
        'SETLOCAL',
        'CALL :find_dp0',
        'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*',
      ].join('\r\n'),
    )
    put(
      path.join(
        npm,
        'node_modules',
        '@anthropic-ai',
        'claude-code',
        'package.json',
      ),
      JSON.stringify({ name: '@anthropic-ai/claude-code', version: '2.1.301' }),
    )
    // Without an extension PATHEXT names, it is no program.
    put(path.join(box.bin, 'codex'))
    const probes = fakeRun()
    const report = await scanAgents({
      platform: 'win32',
      env: { Path: `${npm};${box.bin}`, PATHEXT: '.EXE;.CMD' },
      home: box.home,
      appDirs: [],
      run: probes.run,
    })
    expect(agent(report, 'claude-code')).toMatchObject({
      available: true,
      path: shim,
      version: '2.1.301',
      source: 'path',
    })
    expect(agent(report, 'codex')).toBeUndefined()
    expect(probes.asked).toEqual([])
  })
})

describe('qmo agents', () => {
  function io() {
    const out: string[] = []
    const err: string[] = []
    const value: ClientIO = {
      out: line => out.push(line),
      err: line => err.push(line),
      ask: async () => null,
    }
    return { out, err, io: value }
  }

  test('is in the usage', () => {
    expect(USAGE).toContain('qmo agents [--json] [--rescan]')
  })

  test('--json prints one line; the answers are kept in the client directory', async () => {
    const box = sandbox()
    process.env.QMO_CLIENT_DIR = path.join(box.root, 'client')
    const claude = fakeBin(box.bin, 'claude')
    const seen: ScanOptions[] = []
    const scan = (options: ScanOptions = {}) => {
      seen.push(options)
      return scanAgents({
        ...base(box, { run: fakeRun(() => ({ stdout: '2.1.309' })).run }),
        ...options,
      })
    }
    const json = io()
    expect(await main(['agents', '--json'], json.io, scan)).toBe(0)
    expect(json.err).toEqual([])
    expect(json.out).toHaveLength(1)
    expect(JSON.parse(json.out[0]!)).toEqual({
      agents: [
        QIANMOPI,
        {
          id: 'claude-code',
          name: 'Claude Code',
          version: '2.1.309',
          path: claude,
          protocol: 'claude-stream',
          available: true,
          reason: null,
          source: 'path',
          configFound: false,
          signedIn: null,
        },
      ],
    })
    expect(seen[0]).toEqual({
      cacheFile: path.join(box.root, 'client', 'agents.json'),
      rescan: false,
    })
    expect(fs.existsSync(path.join(box.root, 'client', 'agents.json'))).toBe(
      true,
    )

    const person = io()
    expect(await main(['agents', '--rescan'], person.io, scan)).toBe(0)
    expect(seen[1]?.rescan).toBe(true)
    expect(person.out).toEqual(formatAgents(await scan()))
    expect(person.out[1]).toContain('2.1.309')
    expect(person.out[1]).toContain(claude)

    const wrong = io()
    expect(await main(['agents', 'all', '--json'], wrong.io, scan)).toBe(2)
    expect(JSON.parse(wrong.out[0]!)).toEqual({
      error: { kind: 'usage', message: 'qmo agents 只接受 --json 与 --rescan' },
    })
  })

  test('a person’s table: names, versions and state lined up', () => {
    expect(
      formatAgents({
        agents: [
          QIANMOPI,
          {
            ...QIANMOPI,
            id: 'codex',
            name: 'Codex',
            version: '0.163.0',
            path: '/opt/homebrew/bin/codex',
            protocol: 'codex-app-server',
            source: 'path',
          },
          {
            ...QIANMOPI,
            id: 'cursor',
            name: 'Cursor CLI',
            protocol: null,
            available: false,
            reason: '暂不支持接入',
            source: null,
          },
        ],
      }),
    ).toEqual([
      'qianmopi    内置     可用',
      'Codex       0.163.0  可用  /opt/homebrew/bin/codex',
      'Cursor CLI  —        不可用 · 暂不支持接入',
    ])
  })
})
