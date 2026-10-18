// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `qm runtime open <agent> [--web]` — the agent's official harness frontend
 * on the agent's own state (P36.7, `harness-backends.md` §7.2).
 *
 * The frontend starts with what the resident process starts with
 * (`runtimeEnv`: state directory, credentials, switches; the same pin
 * layer: hooks off, no project layer, the gateway pinned), minus the
 * node's permission bridge and host tools: the person at the terminal is
 * the approver. Console connectors are not mounted (their secrets stay with
 * the resident); what the operator installs natively here is what the
 * resident agent loads next.
 *
 * The agent comes from the resident's roster (`resident/runtime-agents.json`:
 * workspace, runtime, model; no secrets), the credentials from the node's
 * model service, as the resident reads them. Before the frontend starts,
 * the agent's runtime lock is taken (`frontendLock.ts`): a running resident
 * closes the agent's idle processes and starts none until the lock is
 * released, or answers that a turn is in progress, and the command stops.
 * Web frontends listen on loopback only, behind a secret of this launch;
 * the address is printed, no browser is opened.
 */

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { claudeStateFile } from '@qianmo/paths'
import { readTextIfExists, writePrivateFileAtomic } from '../providers/store.js'
import { NodeExtensions } from '../host/extensions.js'
import { runtimeSpec } from '../host/runtimes/catalog.js'
import { claudeCodeOpenArgv } from '../host/runtimes/claudeCode.js'
import { CODEX_KEY_ENV, codexOpenArgv } from '../host/runtimes/codex.js'
import {
  acquireFrontendLock,
  holdsFrontendLock,
  type FrontendLock,
  pidAlive,
  readFrontendAck,
  readResidentRoster,
  releaseFrontendLock,
} from '../host/runtimes/frontendLock.js'
import {
  freeLoopbackPort,
  runtimeDirs,
  runtimeEnv,
  type RuntimeRoute,
} from '../host/runtimes/runtimeEnv.js'

const USAGE = `Usage: qm runtime open <agent> [--web]

Open a resident agent's official harness frontend (Claude Code, Codex,
Gemini CLI, Qwen Code or opencode in this terminal; dsh, and Qwen Code or
opencode with --web, as a web UI on 127.0.0.1) on the agent's own state:
what you install or change there is what the resident agent loads next.
The resident must not be running a turn of the agent; its idle processes
are closed while the frontend is open. Run it on the node, as the node's
user.
`

/** How long a running resident has to answer the lock. */
const ACK_WAIT_MS = 15_000

class OpenError extends Error {}

interface Opened {
  readonly argv: readonly string[]
  readonly env: Record<string, string>
  readonly cwd: string
  /** The web frontend's address and how to sign in. */
  readonly url?: string
  readonly signIn?: string
  /** A directory of this launch, removed afterwards. */
  readonly runDir?: string
}

/**
 * Pre-answers Claude Code's first-run dialogs in the agent's `.claude.json`
 * (onboarding, the gateway key, trust for the workspace); every other entry
 * stays.
 */
function seedClaudeJson(home: string, cwd: string, apiKey: string): void {
  const path = claudeStateFile(home)
  const text = readTextIfExists(path)
  let config: Record<string, unknown>
  try {
    const parsed: unknown = text === undefined ? {} : JSON.parse(text)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
      return
    config = parsed as Record<string, unknown>
  } catch {
    return
  }
  const record = (value: unknown): Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {}
  const responses = record(config.customApiKeyResponses)
  const approved = Array.isArray(responses.approved) ? responses.approved : []
  const tail = apiKey.slice(-20)
  const projects = record(config.projects)
  const next = {
    ...config,
    hasCompletedOnboarding: true,
    theme: typeof config.theme === 'string' ? config.theme : 'dark',
    customApiKeyResponses: {
      rejected: [],
      ...responses,
      approved: approved.includes(tail) ? approved : [...approved, tail],
    },
    projects: {
      ...projects,
      [cwd]: { ...record(projects[cwd]), hasTrustDialogAccepted: true },
    },
  }
  writePrivateFileAtomic(path, `${JSON.stringify(next, null, 2)}\n`)
}

/** The frontend's command line and environment for `agent`. */
export async function frontendLaunch(input: {
  readonly agent: string
  readonly runtime: string
  readonly bin: string
  readonly cwd: string
  readonly route: RuntimeRoute & { readonly lane?: string }
  readonly web: boolean
  readonly nonce: string
}): Promise<Opened> {
  const { agent, runtime, cwd, route, web } = input
  // A bare name as the resident found it on PATH (dsh's web app is found
  // beside the real executable).
  const bin = isAbsolute(input.bin)
    ? input.bin
    : (Bun.which(input.bin) ?? input.bin)
  const spec = runtimeSpec(runtime)
  const { home } = runtimeDirs(runtime, agent)
  mkdirSync(home, { recursive: true, mode: 0o700 })
  const env = runtimeEnv(runtime, agent, route)
  if (runtime === 'claude-code' || runtime === 'codex') {
    if (web)
      throw new OpenError(`${spec?.label ?? runtime} 没有网页前端；去掉 --web`)
    if (runtime === 'codex')
      return {
        argv: codexOpenArgv({
          bin,
          model: route.model,
          baseUrl: route.baseUrl,
          keyEnv: CODEX_KEY_ENV,
          ...(route.headers ? { headers: route.headers } : {}),
          workspace: cwd,
        }),
        env,
        cwd,
      }
    seedClaudeJson(home, cwd, route.apiKey)
    // The console's skills and plugins, as the resident process loads them.
    const extensions = new NodeExtensions({
      agents: [{ agent, runtime }],
    }).forAgent(agent)
    return {
      argv: claudeCodeOpenArgv({
        bin,
        model: route.model,
        baseUrl: route.baseUrl,
        ...(extensions === null
          ? {}
          : { pluginDirs: extensions.claudePluginDirs }),
      }),
      env,
      cwd,
    }
  }
  const acp = spec?.acp
  if (spec === undefined || acp?.open === undefined)
    throw new OpenError(`${spec?.label ?? runtime} 没有可以打开的官方前端`)
  if (web && runtime !== 'dsh' && runtime !== 'qwen' && runtime !== 'opencode')
    throw new OpenError(`${spec.label} 没有网页前端；去掉 --web`)
  const lane = spec.lanes.find(one => one === route.lane) ?? spec.lanes[0]
  if (lane === undefined) throw new OpenError(`${spec.label} 没有模型通道`)
  const runDir = join(home, `.qmo-open-${input.nonce}`)
  rmSync(runDir, { recursive: true, force: true })
  mkdirSync(runDir, { recursive: true, mode: 0o700 })
  const secret = randomUUID()
  const plan = acp.open(
    {
      bin,
      model: route.model,
      lane,
      baseUrl: route.baseUrl,
      apiKey: route.apiKey,
      ...(route.headers ? { headers: route.headers } : {}),
      home,
      runDir,
      cwd,
      port: await freeLoopbackPort(),
      secret,
    },
    web,
  )
  for (const dir of [...(plan.dirs ?? []), plan.cwd ?? cwd])
    mkdirSync(dir, { recursive: true, mode: 0o700 })
  for (const file of plan.files ?? []) {
    mkdirSync(dirname(file.path), { recursive: true, mode: 0o700 })
    writeFileSync(file.path, file.content, { mode: 0o600 })
    chmodSync(file.path, 0o600)
  }
  return {
    argv: plan.argv,
    env: { ...env, ...plan.env },
    cwd: plan.cwd ?? cwd,
    runDir,
    ...(plan.url === undefined
      ? {}
      : {
          url: plan.url,
          signIn:
            runtime === 'opencode'
              ? `用户名 opencode，口令 ${secret}`
              : `令牌 ${secret}`,
        }),
  }
}

/** Waits for the resident's answer to `lock`; `true` when it let go. */
async function residentYields(
  lock: FrontendLock,
  agent: string,
): Promise<boolean> {
  const deadline = Date.now() + ACK_WAIT_MS
  while (Date.now() < deadline) {
    const ack = readFrontendAck(agent)
    if (ack?.nonce === lock.nonce) {
      if (ack.busy)
        throw new OpenError(`${agent} 有回合正在进行；等它结束后再打开前端`)
      return true
    }
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  return false
}

export async function run(argv: string[]): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(USAGE)
    return 0
  }
  const [command, agent, ...rest] = argv
  const web = rest.includes('--web')
  if (
    command !== 'open' ||
    agent === undefined ||
    agent.startsWith('-') ||
    rest.some(arg => arg !== '--web')
  ) {
    process.stderr.write(USAGE)
    return 2
  }
  let lock: FrontendLock | undefined
  let runDir: string | undefined
  try {
    const roster = readResidentRoster()
    if (roster === undefined)
      throw new OpenError(
        '没有找到常驻节点的智能体名册：先在这台机器上启动 qm resident',
      )
    const entry = roster.agents.find(one => one.agent === agent)
    if (entry === undefined)
      throw new OpenError(`常驻节点上没有智能体 ${agent}`)
    const spec = runtimeSpec(entry.runtime)
    if (spec === undefined || spec.protocol === 'omp')
      throw new OpenError(`${agent} 不在外部底层上，没有官方前端`)
    if (entry.model === null)
      throw new OpenError(
        `${agent} 现在没有可用的模型（runtime.status 里有原因）`,
      )
    const { runtimeModelCredential } = await import('../providers/node.js')
    const credential = runtimeModelCredential(entry.model, entry.runtime)
    lock = acquireFrontendLock(agent, entry.runtime)
    if (lock === undefined) throw new OpenError(`${agent} 的另一个前端正开着`)
    if (pidAlive(roster.pid) && !(await residentYields(lock, agent)))
      throw new OpenError(
        '常驻节点没有回应前端锁（它可能是不支持 qm runtime open 的旧版本）',
      )
    if (!holdsFrontendLock(agent, lock))
      throw new OpenError(`${agent} 的另一个前端正开着`)
    const opened = await frontendLaunch({
      agent,
      runtime: entry.runtime,
      bin: entry.bin,
      cwd: entry.cwd,
      route: {
        model: credential.model,
        baseUrl: credential.baseUrl,
        apiKey: credential.apiKey,
        lane: credential.lane,
        ...(credential.headers ? { headers: credential.headers } : {}),
      },
      web,
      nonce: lock.nonce,
    })
    runDir = opened.runDir
    if (opened.url !== undefined)
      process.stdout.write(
        `${spec.label} 网页前端：${opened.url}（${opened.signIn}）\n只在本机回环上；从别处看用 ssh -L 转发，不要开端口。\n`,
      )
    const child = spawn(opened.argv[0]!, opened.argv.slice(1), {
      cwd: opened.cwd,
      env: opened.env,
      stdio: 'inherit',
    })
    // Ctrl-C belongs to the frontend; this process stays to let go of the lock.
    const ignore = () => {}
    process.on('SIGINT', ignore)
    try {
      return await new Promise<number>(resolve => {
        child.once('error', error => {
          process.stderr.write(`qm runtime open: ${error.message}\n`)
          resolve(1)
        })
        child.once('exit', (code, signal) =>
          resolve(code ?? (signal === null ? 0 : 1)),
        )
      })
    } finally {
      process.off('SIGINT', ignore)
    }
  } catch (error) {
    process.stderr.write(
      `qm runtime open: ${error instanceof Error ? error.message : String(error)}\n`,
    )
    return error instanceof OpenError ? 2 : 1
  } finally {
    if (runDir !== undefined) rmSync(runDir, { recursive: true, force: true })
    if (lock !== undefined) releaseFrontendLock(agent, lock)
  }
}
