#!/usr/bin/env bun
// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/** AC-5: run the same protected programming task through omp with a configured
 * OpenAI-compatible provider. --providers-file supplies id/baseUrl/apiKeyEnv/defaultModel;
 * credentials are written only to isolated, mode-0600 models.yml. No live model is
 * called by test/precheck; an operator explicitly runs this evidence tool. */

import { completedBunTests, runIsolatedCheck } from './taskValidation.js'
import { verifyTaskOracle } from './taskOracle.js'
import { ompChildEnv } from '@qianmo/paths'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_PATH = fileURLToPath(import.meta.url)
const REPO_ROOT = resolve(dirname(SCRIPT_PATH), '..', '..')

// ── 任务夹具：内联在脚本里，两次运行按同一份字符串生成 ──────────────────────

/** 任务自带的断言。跑完之后会校验它没有被改动过。 */
const TASK_TEST_FILE = `import { describe, expect, test } from 'bun:test'
import { slugify } from '../src/slugify.ts'

describe('slugify', () => {
  test('lowercases and hyphenates words', () => {
    expect(slugify('Hello World')).toBe('hello-world')
  })

  test('collapses runs of non-alphanumeric characters into one hyphen', () => {
    expect(slugify('Qianmo  --  AgentNest!!')).toBe('qianmo-agentnest')
  })

  test('trims leading and trailing separators', () => {
    expect(slugify('  ///Edge Case///  ')).toBe('edge-case')
  })

  test('keeps digits', () => {
    expect(slugify('Release 2.38.3')).toBe('release-2-38-3')
  })

  test('returns an empty string when nothing survives', () => {
    expect(slugify('***')).toBe('')
  })
})
`

/** 待补完的桩。原样跑 \`bun test\` 必然全红。 */
const TASK_STUB_FILE = `/**
 * Turn a human title into a URL slug.
 *
 * NOT IMPLEMENTED — implementing this is the task.
 */
export function slugify(input: string): string {
  throw new Error(\`slugify is not implemented yet (input: \${input})\`)
}
`

const TASK_README = `# slug-task

\`src/slugify.ts\` is a stub. \`test/slugify.test.ts\` defines the required
behaviour and must not be edited. Make \`bun test\` pass.
`

const TASK_PROMPT = [
  'This repository has a failing test suite.',
  'Implement the `slugify` function in src/slugify.ts so that `bun test` passes.',
  '',
  'Rules:',
  '- The tests in test/ define the required behaviour. Do NOT modify anything under test/.',
  '- Change only src/slugify.ts.',
  '- The host will run the protected tests after you finish. Use only the allowed file tools.',
].join('\n')

// ── 参数 ────────────────────────────────────────────────────────────────────

interface Args {
  providerId: string
  providersFile: string
  keep: boolean
  jsonOnly: boolean
}

function parseArgs(argv: string[]): Args {
  let providerId = ''
  let providersFile = join(
    REPO_ROOT,
    'atlas',
    'tests',
    'integration',
    'fixtures',
    'qianmo-providers.json',
  )
  let keep = true
  let jsonOnly = false

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--provider') {
      providerId = argv[++i] ?? ''
    } else if (arg === '--providers-file') {
      providersFile = resolve(argv[++i] ?? '')
    } else if (arg === '--keep') {
      keep = true
    } else if (arg === '--clean') {
      keep = false
    } else if (arg === '--json') {
      jsonOnly = true
    } else {
      throw new Error(`未知参数：${arg}`)
    }
  }

  if (!providerId) {
    throw new Error('缺少 --provider <id>')
  }
  return { providerId, providersFile, keep, jsonOnly }
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

function log(jsonOnly: boolean, message: string): void {
  if (!jsonOnly) console.error(message)
}

function run(
  cmd: string[],
  cwd: string,
  env?: Record<string, string>,
): { code: number; stdout: string; stderr: string } {
  const proc = Bun.spawnSync(cmd, {
    cwd,
    ...(env ? { env } : {}),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return {
    code: proc.exitCode ?? -1,
    stdout: new TextDecoder().decode(proc.stdout),
    stderr: new TextDecoder().decode(proc.stderr),
  }
}

// ── 主流程 ──────────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2))
  const { providerId, providersFile, jsonOnly } = args

  // 1. 隔离的配置目录：把配置文件放进去，再让**基座自己的注册中心**去读。
  //    整个流程不碰用户的真实 ~/.omp。
  const workRoot = mkdtempSync(join(tmpdir(), 'qianmo-ac5-'))
  const configDir = join(workRoot, 'config')
  const taskDir = join(workRoot, 'repo')
  mkdirSync(configDir, { recursive: true })
  mkdirSync(join(taskDir, 'src'), { recursive: true })
  mkdirSync(join(taskDir, 'test'), { recursive: true })

  const providersJson = readFileSync(providersFile, 'utf-8')
  const providers: unknown = JSON.parse(providersJson)
  if (!Array.isArray(providers))
    throw new Error('providers file must contain an array')
  const value: unknown = providers.find(value => value?.id === providerId)
  if (typeof value !== 'object' || value === null)
    throw new Error(`Provider ${providerId} not found`)
  const record = value as Record<string, unknown>
  for (const key of ['id', 'baseUrl', 'apiKeyEnv', 'defaultModel']) {
    if (typeof record[key] !== 'string' || record[key] === '')
      throw new Error(`Provider needs ${key}`)
  }
  const provider = record as {
    id: string
    baseUrl: string
    apiKeyEnv: string
    defaultModel: string
  }
  const apiKey = process.env[provider.apiKeyEnv]
  if (!apiKey) {
    console.error(
      `[AC-5] Missing credential environment variable ${provider.apiKeyEnv}; not evaluated`,
    )
    return 3
  }
  const agentDir = join(configDir, 'omp', 'agent')
  mkdirSync(agentDir, { recursive: true, mode: 0o700 })
  writeFileSync(
    join(agentDir, 'models.yml'),
    JSON.stringify({
      providers: {
        [provider.id]: {
          baseUrl: provider.baseUrl,
          api: 'openai-completions',
          apiKey,
          compat: { statefulResponses: false },
          models: [
            {
              id: provider.defaultModel,
              name: provider.defaultModel,
              reasoning: false,
              contextWindow: 128000,
              maxTokens: 16384,
            },
          ],
        },
      },
    }),
    { mode: 0o600 },
  )
  writeFileSync(
    join(agentDir, 'config.yml'),
    JSON.stringify({
      providers: { cacheWarming: 'off' },
      defaultThinkingLevel: 'off',
    }),
    { mode: 0o600 },
  )
  log(jsonOnly, `[AC-5] omp provider=${provider.id} api=openai-completions`)

  // 2. 任务仓库
  writeFileSync(join(taskDir, 'src', 'slugify.ts'), TASK_STUB_FILE, 'utf-8')
  writeFileSync(
    join(taskDir, 'test', 'slugify.test.ts'),
    TASK_TEST_FILE,
    'utf-8',
  )
  writeFileSync(join(taskDir, 'README.md'), TASK_README, 'utf-8')
  writeFileSync(
    join(taskDir, 'package.json'),
    `${JSON.stringify({ name: 'slug-task', private: true, type: 'module' }, null, 2)}\n`,
    'utf-8',
  )

  const testFileHashBefore = sha256(TASK_TEST_FILE)

  const gitEnv: Record<string, string> = {
    ...(process.env as Record<string, string>),
    GIT_AUTHOR_NAME: 'AC-5 harness',
    GIT_AUTHOR_EMAIL: 'ac5@example.invalid',
    GIT_COMMITTER_NAME: 'AC-5 harness',
    GIT_COMMITTER_EMAIL: 'ac5@example.invalid',
  }
  run(['git', 'init', '-q', '-b', 'main'], taskDir, gitEnv)
  run(['git', 'add', '-A'], taskDir, gitEnv)
  const committed = run(
    ['git', 'commit', '-q', '-m', 'chore: task fixture'],
    taskDir,
    gitEnv,
  )
  if (committed.code !== 0) {
    console.error(`[AC-5] git commit 失败：${committed.stderr}`)
    return 2
  }

  // 3. 基线：任务自带的测试此刻必须是红的，否则这条用例证明不了任何事。
  const baseline = runIsolatedCheck(['bun', 'test'], taskDir)
  if (baseline.code === 0) {
    console.error('[AC-5] 基线异常：桩实现居然让任务自带测试通过了，用例无效')
    return 2
  }
  log(
    jsonOnly,
    `[AC-5] 基线确认：桩实现下 bun test 退出码 ${baseline.code}（应为非 0）`,
  )

  // 4. Run qm agent with a file allowlist, isolated omp config and no shell tools.
  const guardConfig = join(configDir, 'task-guard.json')
  const guardReady = join(configDir, 'guard-ready')
  const nonce = crypto.randomUUID()
  writeFileSync(
    guardConfig,
    JSON.stringify({
      workspace: taskDir,
      allowedFiles: ['src/slugify.ts'],
      readyFile: guardReady,
      nonce,
    }),
    { mode: 0o600 },
  )
  const childEnv = ompChildEnv({
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    QIANMO_CONFIG_DIR: configDir,
    QIANMO_TASK_GUARD_CONFIG: guardConfig,
    NO_COLOR: '1',
  })
  const occArgv = [
    process.execPath,
    join(REPO_ROOT, 'atlas/packages/node/src/cli.ts'),
    'agent',
    '--print',
    '--mode',
    'json',
    '--model',
    `${provider.id}/${provider.defaultModel}`,
    '--no-extensions',
    '--extension',
    join(REPO_ROOT, 'atlas/scripts/programmingTaskGuard.ts'),
    '--approval-mode',
    'write',
    '--tools',
    '',
    TASK_PROMPT,
  ]
  log(jsonOnly, `[AC-5] Starting qm agent (cwd=${taskDir})`)
  const started = Date.now()
  const occ = run(occArgv, taskDir, childEnv)
  const elapsedMs = Date.now() - started
  writeFileSync(join(workRoot, 'agent-stdout.json'), occ.stdout, 'utf-8')
  writeFileSync(join(workRoot, 'agent-stderr.log'), occ.stderr, 'utf-8')
  log(
    jsonOnly,
    `[AC-5] qm agent 退出码 ${occ.code}，耗时 ${(elapsedMs / 1000).toFixed(1)}s`,
  )

  // 5. 测试文件必须没被动过
  const testFileAfter = readFileSync(
    join(taskDir, 'test', 'slugify.test.ts'),
    'utf-8',
  )
  const testFileHashAfter = sha256(testFileAfter)
  const testsUntouchedBefore = testFileHashBefore === testFileHashAfter

  // 6. 任务自带断言
  const verdict = runIsolatedCheck(['bun', 'test'], taskDir)
  const changed = run(['git', 'diff', '--stat'], taskDir, gitEnv)
  const patch = run(['git', 'diff'], taskDir, gitEnv)
  writeFileSync(join(workRoot, 'model-patch.diff'), patch.stdout, 'utf-8')
  // bun test 把结果写 stderr，只看 stdout 会得到一行版本号。
  const verdictOutput = [verdict.stdout.trim(), verdict.stderr.trim()]
    .filter(Boolean)
    .join('\n')
  writeFileSync(join(workRoot, 'task-tests.log'), verdictOutput, 'utf-8')

  const testsUntouched =
    testsUntouchedBefore &&
    sha256(readFileSync(join(taskDir, 'test', 'slugify.test.ts'), 'utf8')) ===
      testFileHashBefore
  const testsCompleted = completedBunTests(verdict, 5)
  const oracle = verifyTaskOracle('slugify', taskDir)
  writeFileSync(join(workRoot, 'host-oracle.log'), oracle.output, 'utf8')
  const guardInitialized =
    existsSync(guardReady) && readFileSync(guardReady, 'utf8') === nonce
  const passed =
    guardInitialized &&
    occ.code === 0 &&
    testsUntouched &&
    testsCompleted &&
    oracle.passed

  const summary = {
    ac: 'AC-5',
    providerId: provider.id,
    api: 'openai-completions',
    enforcementMode: 'omp-tool-allowlist',
    guardInitialized,
    model: provider.defaultModel,
    baseUrl: provider.baseUrl,
    apiKeyEnv: provider.apiKeyEnv,
    agentExitCode: occ.code,
    agentElapsedMs: elapsedMs,
    taskTestsExitCode: verdict.code,
    taskTestsCompleted: testsCompleted,
    hostOraclePassed: oracle.passed,
    hostOracleCases: oracle.cases,
    requiredTests: 5,
    validationIsolation: verdict.isolation,
    taskTestsUntouched: testsUntouched,
    passed,
    workRoot,
    hashes: {
      script: sha256(readFileSync(SCRIPT_PATH, 'utf-8')),
      prompt: sha256(TASK_PROMPT),
      taskTest: testFileHashBefore,
      taskStub: sha256(TASK_STUB_FILE),
      providersFile: sha256(providersJson),
    },
  }

  if (!jsonOnly) {
    console.error('')
    console.error('─── qm agent 最终输出（--mode json）──────────────────')
    console.error(occ.stdout.trim().slice(0, 2000))
    console.error('')
    console.error('─── 模型改了哪些文件 ────────────────────────────────────')
    console.error(changed.stdout.trim() || '(无改动)')
    console.error('')
    console.error('─── 任务自带测试 ────────────────────────────────────────')
    console.error(verdictOutput)
    console.error('')
  }

  console.log(JSON.stringify(summary, null, 2))

  if (!args.keep) {
    rmSync(workRoot, { recursive: true, force: true })
  } else {
    log(jsonOnly, `[AC-5] 取证目录保留在 ${workRoot}`)
  }

  return passed ? 0 : 1
}

process.exit(await main())
