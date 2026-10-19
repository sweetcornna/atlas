// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Each agent's model, configured the way its runtime configures one
 * (`harness-backends.md` §11): the field table, following and narrowing,
 * what every runtime is started with, the node's `runtime.configure
 * {fields}`, a worker session's task tier, and qianmopi's own model.
 */

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { qianmoConfigPath } from '@qianmo/paths'
import {
  NodeRuntimes,
  type RuntimeModelRoute,
} from '../../src/host/runtimeConfig.js'
import { RuntimeInstaller } from '../../src/host/runtimeUpdate.js'
import {
  claudeCodeArgv,
  claudeCodeModelPlan,
} from '../../src/host/runtimes/claudeCode.js'
import { codexArgv } from '../../src/host/runtimes/codex.js'
import { dshPatch } from '../../src/host/runtimes/dsh.js'
import { geminiEnv } from '../../src/host/runtimes/gemini.js'
import {
  agentModelFields,
  claudeLight,
  effortChoices,
  EXTRA_FIELD_KEYS,
  fieldValueProblem,
  followTier,
  narrowEffort,
  taskTierOf,
} from '../../src/host/runtimes/modelFields.js'
import { opencodeConfig } from '../../src/host/runtimes/opencode.js'
import { qwenEnv } from '../../src/host/runtimes/qwen.js'
import type { AcpLaunchInput } from '../../src/host/runtimes/acpSpec.js'
import {
  nodeRoleModelSpec,
  ompProviderModel,
  runtimeModelCredential,
} from '../../src/providers/node.js'
import { providerPaths } from '../../src/providers/store.js'
import { isolatedRoot } from '../providers/fake.js'

let root: ReturnType<typeof isolatedRoot>
const made: NodeRuntimes[] = []
beforeEach(() => {
  root = isolatedRoot()
})
afterEach(() => {
  for (const one of made.splice(0)) one.stop()
  root.dispose()
})

// --- the table ---------------------------------------------------------------

test('every runtime has its native fields; values are <profile>/<model> or an effort, empty follows', () => {
  expect(agentModelFields('claude-code').map(field => field.key)).toEqual([
    'model',
    'effort',
    'fable',
    'fable_effort',
    'opus',
    'opus_effort',
    'sonnet',
    'sonnet_effort',
    'haiku',
    'haiku_effort',
  ])
  expect(agentModelFields('codex').map(field => field.key)).toEqual([
    'model',
    'effort',
  ])
  expect(agentModelFields('omp').map(field => field.key)).toEqual([
    'model',
    'effort',
  ])
  expect(agentModelFields('dsh').map(field => field.key)).toEqual([
    'model',
    'effort',
  ])
  expect(agentModelFields('gemini').map(field => field.key)).toEqual(['model'])
  expect(agentModelFields('qwen').map(field => field.key)).toEqual(['model'])
  expect(agentModelFields('opencode').map(field => field.key)).toEqual([
    'model',
    'small',
  ])
  // No subagent fields: Task/Agent are denied on a resident Claude Code.
  expect(EXTRA_FIELD_KEYS).not.toContain('subagent')
  expect(EXTRA_FIELD_KEYS).not.toContain('model')
  expect(fieldValueProblem('opus', 'magpie/claude-opus-4-6')).toBeNull()
  expect(fieldValueProblem('opus', '')).toBeNull()
  expect(fieldValueProblem('opus', 'claude-opus')).toContain('<档案>/<模型号>')
  expect(fieldValueProblem('effort', 'xhigh')).toBeNull()
  expect(fieldValueProblem('effort', 'turbo')).toContain('只能是')
  expect(fieldValueProblem('subagent', 'a/b')).toContain('没有这个字段')
  expect(taskTierOf('complex')).toBe('complex')
  expect(taskTierOf('code')).toBeUndefined()
  expect(taskTierOf('__proto__')).toBeUndefined()
})

test('efforts narrow to the runtime and the model, and only ever move down', () => {
  // Claude Code's main effort is --effort: no none or minimal.
  expect(effortChoices('claude-code', 'effort')).toEqual([
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
  ])
  // A tier's level is the gateway's: the whole range.
  expect(effortChoices('claude-code', 'opus_effort')).toHaveLength(7)
  // What Claude Code sends Opus 4.6: no xhigh.
  expect(
    effortChoices('claude-code', 'effort', { id: 'claude-opus-4-6' }),
  ).toEqual(['low', 'medium', 'high', 'max'])
  // Haiku 4.5 takes none at all.
  expect(
    effortChoices('claude-code', 'effort', { id: 'claude-haiku-4-5' }),
  ).toEqual([])
  // Codex has no max; the model's own list narrows further, none stays.
  expect(
    effortChoices('codex', 'effort', {
      id: 'gpt-6',
      efforts: ['low', 'medium', 'high'],
    }),
  ).toEqual(['none', 'low', 'medium', 'high'])
  // A model the service says does not reason: nothing to choose.
  expect(
    effortChoices('dsh', 'effort', { id: 'deepseek-chat', reasoning: false }),
  ).toEqual([])
  expect(effortChoices('gemini', 'effort')).toEqual([])
  expect(narrowEffort('xhigh', ['low', 'medium', 'high', 'max'])).toBe('high')
  expect(narrowEffort('low', ['high'])).toBeUndefined()
  expect(narrowEffort('', ['high'])).toBeUndefined()
})

test('following: opus and sonnet run the main model, haiku the newest Haiku beside a Claude one, fable only on a Fable', () => {
  const models = [
    'anthropic/claude-opus-4-6',
    'anthropic/claude-haiku-4-5-20251001',
    'anthropic/claude-haiku-4-5',
    'anthropic/claude-haiku-3-5',
    'openai/gpt-6',
  ]
  expect(claudeLight('anthropic/claude-opus-4-6', models)).toBe(
    'anthropic/claude-haiku-4-5',
  )
  expect(claudeLight('claude-sonnet-4-6', ['claude-haiku-4-5'])).toBe(
    'claude-haiku-4-5',
  )
  expect(claudeLight('openai/gpt-6', models)).toBeUndefined()
  expect(claudeLight('anthropic/claude-haiku-4-5', models)).toBeUndefined()
  expect(followTier('opus', 'openai/gpt-6', models)).toBe('openai/gpt-6')
  expect(followTier('haiku', 'openai/gpt-6', models)).toBe('openai/gpt-6')
  expect(followTier('haiku', 'anthropic/claude-opus-4-6', models)).toBe(
    'anthropic/claude-haiku-4-5',
  )
  expect(followTier('fable', 'anthropic/claude-opus-4-6', models)).toBe(
    undefined,
  )
  expect(followTier('fable', 'claude-fable-5', [])).toBe('claude-fable-5')
})

// --- what each runtime is started with ----------------------------------------

test('Claude Code: tiers as model:effort[1m], haiku as the small fast model, max in the environment, unset tiers emptied in the pin layer', () => {
  const plan = claudeCodeModelPlan({
    model: 'deepseek-v4',
    effort: 'max',
    contextWindow: 1_000_000,
    maxOutputTokens: 64_000,
    efforts: ['low', 'medium', 'high', 'max'],
    tiers: {
      opus: { model: 'deepseek-v4', contextWindow: 1_000_000 },
      sonnet: { model: 'glm-5', effort: 'high', contextWindow: 200_000 },
      haiku: {
        model: 'deepseek-flash',
        contextWindow: 128_000,
        maxOutputTokens: 40_000,
      },
    },
  })
  expect(plan.model).toBe('deepseek-v4[1m]')
  expect(plan.effort).toBeUndefined()
  expect(plan.env).toEqual({
    ANTHROPIC_DEFAULT_OPUS_MODEL: 'deepseek-v4[1m]',
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-5:high',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'deepseek-flash',
    ANTHROPIC_SMALL_FAST_MODEL: 'deepseek-flash',
    CLAUDE_CODE_EFFORT_LEVEL: 'max',
    // The main model is marked [1m]: the smallest unmarked tier's window.
    CLAUDE_CODE_MAX_CONTEXT_TOKENS: '128000',
    // glm-5's reply length is not known: left to Claude Code.
    CLAUDE_CODE_MODEL_CAPABILITIES: 'deepseek-v4=effort,max_effort',
  })
  // No fable: not set in the process, emptied over the agent's own settings.
  expect(plan.env).not.toHaveProperty('ANTHROPIC_DEFAULT_FABLE_MODEL')
  expect(plan.settingsEnv).toMatchObject({
    ...plan.env,
    ANTHROPIC_DEFAULT_FABLE_MODEL: '',
  })
  const argv = claudeCodeArgv({
    bin: 'claude',
    model: plan.model,
    settingsEnv: plan.settingsEnv,
    baseUrl: 'https://gw.example',
    sessionId: '00000000-0000-4000-8000-000000000000',
    resume: false,
    systemPrompt: 'p',
    mcpConfigPath: '/tmp/mcp.json',
    allowWorkspaceEdits: false,
    effort: 'high',
  })
  expect(argv[argv.indexOf('--model') + 1]).toBe('deepseek-v4[1m]')
  expect(argv[argv.indexOf('--effort') + 1]).toBe('high')
  const settings = JSON.parse(argv[argv.indexOf('--settings') + 1]!)
  expect(settings.env.ANTHROPIC_BASE_URL).toBe('https://gw.example')
  expect(settings.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('glm-5:high')
  expect(settings.env.ANTHROPIC_DEFAULT_FABLE_MODEL).toBe('')
})

test('Claude Code: a Claude main model leaves the reply length to Claude Code; another vendor’s known one past 32000 is told; a tier alias needs a tier', () => {
  const claude = claudeCodeModelPlan({
    model: 'claude-opus-4-6',
    maxOutputTokens: 128_000,
    effort: 'high',
  })
  expect(claude.effort).toBe('high')
  expect(claude.env).toEqual({})
  const other = claudeCodeModelPlan({
    model: 'kimi-k3',
    contextWindow: 256_000,
    maxOutputTokens: 64_000,
    tiers: { haiku: { model: 'kimi-k3', maxOutputTokens: 64_000 } },
    alias: 'haiku',
  })
  expect(other.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe('64000')
  expect(other.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe('256000')
  expect(other.model).toBe('haiku')
  // No opus tier: --model opus would ask the gateway for Claude Code's own
  // Opus, so the session runs the main model.
  expect(claudeCodeModelPlan({ model: 'kimi-k3', alias: 'opus' }).model).toBe(
    'kimi-k3',
  )
  // none and minimal are no --effort.
  expect(claudeCodeModelPlan({ model: 'x', effort: 'none' }).effort).toBe(
    undefined,
  )
})

const ACP: AcpLaunchInput = {
  bin: 'x',
  model: 'deepseek-v4',
  lane: 'openai-chat',
  baseUrl: 'https://gw.example/v1',
  apiKey: 'sk-gw',
  home: '/tmp/home',
  runDir: '/tmp/run',
  cwd: '/tmp/ws',
}

test('Codex: -c model and model_reasoning_effort; dsh: the patch’s agent-default-model reasoningEffort; Gemini and Qwen: their model variable; opencode: small_model', () => {
  const codex = codexArgv({
    bin: 'codex',
    model: 'gpt-6',
    baseUrl: 'https://gw.example/v1',
    keyEnv: 'K',
    workspace: '/tmp/ws',
    effort: 'minimal',
  })
  expect(codex).toContain('model="gpt-6"')
  expect(codex).toContain('model_reasoning_effort="minimal"')
  const patch = dshPatch({ ...ACP, effort: 'none' })
  const row = patch
    .split('\n')
    .find(line => line.includes('"agent-default-model"'))!
  expect(row).toContain('"reasoningEffort": "off"')
  // The model's level map sends off as none.
  expect(patch).toContain('"off": "none"')
  expect(dshPatch(ACP)).not.toContain('reasoningEffort')
  expect(
    geminiEnv('/tmp/h', { model: 'gemini-3-pro', baseUrl: 'b', apiKey: 'k' })
      .GEMINI_MODEL,
  ).toBe('gemini-3-pro')
  expect(
    qwenEnv('/tmp/h', { model: 'qwen4-coder', baseUrl: 'b', apiKey: 'k' })
      .OPENAI_MODEL,
  ).toBe('qwen4-coder')
  const config = JSON.parse(
    opencodeConfig({
      ...ACP,
      bridge: { name: 'qianmo', command: '/bin/qm', args: [], timeoutMs: 1 },
      small: { model: 'deepseek-flash', contextWindow: 128_000 },
    }),
  )
  expect(config.model).toBe('qm/deepseek-v4')
  expect(config.small_model).toBe('qm/deepseek-flash')
  expect(Object.keys(config.provider.qm.models)).toEqual([
    'deepseek-v4',
    'deepseek-flash',
  ])
  expect(JSON.parse(opencodeConfig(ACP)).small_model).toBe('qm/deepseek-v4')
})

// --- the node -------------------------------------------------------------------

/** What `runtimeModelCredential` would answer, from a little model table. */
const PROFILES: Record<
  string,
  readonly {
    id: string
    contextWindow?: number
    maxOutputTokens?: number
    efforts?: string[]
  }[]
> = {
  mg: [
    {
      id: 'anthropic/claude-opus-4-6',
      contextWindow: 1_000_000,
      efforts: ['low', 'medium', 'high', 'max'],
    },
    { id: 'anthropic/claude-haiku-4-5', contextWindow: 200_000 },
    { id: 'openai/gpt-6', efforts: ['low', 'medium', 'high', 'xhigh'] },
    { id: 'deepseek/deepseek-v4', efforts: ['low', 'high', 'max'] },
    { id: 'deepseek/deepseek-flash' },
  ],
  other: [{ id: 'claude-sonnet-4-6' }],
}

function credential(spec: string, runtime: string): RuntimeModelRoute {
  const slash = spec.indexOf('/')
  const profile = spec.slice(0, slash)
  const model = spec.slice(slash + 1)
  const siblings = PROFILES[profile]
  if (siblings === undefined) throw new Error(`no profile ${profile}`)
  if (runtime === 'qwen' && profile === 'mg')
    return {
      model,
      baseUrl: 'b',
      apiKey: 'k',
      lane: 'openai-chat',
      headers: { 'X-Tenant': 't' },
      siblings,
    }
  const facts = siblings.find(one => one.id === model)
  return {
    model,
    baseUrl: `https://${profile}.example`,
    apiKey: `sk-${profile}`,
    lane:
      runtime === 'codex'
        ? 'openai-responses'
        : runtime === 'claude-code'
          ? 'anthropic'
          : 'openai-chat',
    ...(facts === undefined ? {} : { facts }),
    siblings,
  }
}

function node(roles: Record<string, string> = {}) {
  const runtimes = new NodeRuntimes({
    agents: [
      {
        agent: 'cc',
        runtime: 'claude-code',
        model: 'mg/anthropic/claude-opus-4-6',
      },
      { agent: 'cx', runtime: 'codex', model: 'mg/openai/gpt-6' },
      { agent: 'oc', runtime: 'opencode', model: 'mg/deepseek/deepseek-v4' },
      { agent: 'qw', runtime: 'qwen', model: 'other/claude-sonnet-4-6' },
      { agent: 'pi', runtime: 'omp' },
    ],
    installer: new RuntimeInstaller({}),
    fallback: false,
    autoInstall: false,
    launchable: () => true,
    credential,
    mainModel: () => 'mg/deepseek/deepseek-v4',
    roleModel: role => roles[role],
    ompModel: spec => ({
      provider: `qm-${spec.slice(0, spec.indexOf('/'))}-0123abcd`,
      modelId: spec.slice(spec.indexOf('/') + 1),
    }),
  })
  made.push(runtimes)
  return runtimes
}

test('runtime.configure {fields}: checked, kept privately in runtimes.json, reported by runtime.status, null clears; a change recycles the agent', async () => {
  const runtimes = node()
  const changed: string[] = []
  runtimes.onChange(agent => changed.push(agent))
  const ok = runtimes.configure({
    agent: 'cc',
    fields: {
      effort: 'high',
      haiku: 'mg/anthropic/claude-haiku-4-5',
      opus: '',
    },
  })
  expect(ok.ok).toBe(true)
  expect(changed).toEqual(['cc'])
  const file = JSON.parse(
    readFileSync(qianmoConfigPath('qianmo', 'runtimes.json'), 'utf8'),
  )
  expect(file.agents.cc).toEqual({
    fields: { effort: 'high', haiku: 'mg/anthropic/claude-haiku-4-5' },
  })
  const status = await runtimes.control(
    'runtime.status',
    {},
    {
      peer: 'hub',
      actor: 'ops',
      taskId: 't',
    },
  )
  const row = status.ok
    ? (
        status.value as { agents: { agent: string; configured: unknown }[] }
      ).agents.find(one => one.agent === 'cc')
    : undefined
  expect(row?.configured).toMatchObject({
    model: 'mg/anthropic/claude-opus-4-6',
    fields: { effort: 'high', haiku: 'mg/anthropic/claude-haiku-4-5' },
  })
  for (const bad of [
    { fields: { model: 'mg/x' } },
    { fields: { effort: 'turbo' } },
    { fields: { opus: 'no-slash' } },
    { fields: { subagent: 'mg/x' } },
    { fields: 'high' },
  ]) {
    const refused = runtimes.configure({ agent: 'cc', ...bad })
    expect(refused).toMatchObject({ ok: false, code: 'E_RUNTIME_MODEL' })
  }
  // A field this build does not know, written by a newer one, is dropped
  // alone when the file is read.
  writeFileSync(
    qianmoConfigPath('qianmo', 'runtimes.json'),
    JSON.stringify({
      v: 1,
      agents: { cc: { fields: { effort: 'low', future: 'x', opus: 7 } } },
    }),
  )
  const again = node()
  expect(again.configured('cc').fields).toEqual({ effort: 'low' })
  expect(runtimes.configure({ agent: 'cc', fields: null }).ok).toBe(true)
  expect(runtimes.configured('cc').fields).toEqual({})
})

test('launch: the effort narrowed to the model, every tier resolved (own, followed, at its own effort), a tier of another profile left out', () => {
  const runtimes = node()
  runtimes.configure({
    agent: 'cc',
    fields: {
      effort: 'xhigh',
      sonnet: 'mg/deepseek/deepseek-v4',
      sonnet_effort: 'max',
      opus_effort: 'medium',
      fable: 'other/claude-sonnet-4-6',
    },
  })
  const launch = runtimes.launch('cc')
  expect(launch.model).toBe('anthropic/claude-opus-4-6')
  // Opus 4.6 is not sent xhigh: down to high.
  expect(launch.effort).toBe('high')
  expect(launch.contextWindow).toBe(1_000_000)
  expect(launch.tiers).toEqual({
    // Follows the main model, at an effort of its own.
    opus: {
      model: 'anthropic/claude-opus-4-6',
      effort: 'medium',
      contextWindow: 1_000_000,
      efforts: ['low', 'medium', 'high', 'max'],
    },
    sonnet: {
      model: 'deepseek/deepseek-v4',
      effort: 'max',
      efforts: ['low', 'high', 'max'],
    },
    // The newest Haiku of the main model's profile.
    haiku: { model: 'anthropic/claude-haiku-4-5', contextWindow: 200_000 },
    // fable named another profile's model: left out (the main is no Fable).
  })
  const plan = claudeCodeModelPlan(launch)
  expect(plan.env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe(
    'anthropic/claude-opus-4-6:medium[1m]',
  )
  expect(plan.env.ANTHROPIC_SMALL_FAST_MODEL).toBe('anthropic/claude-haiku-4-5')
  expect(plan.settingsEnv.ANTHROPIC_DEFAULT_FABLE_MODEL).toBe('')
  // Codex: none of minimal/max; opencode's small model of the same profile.
  runtimes.configure({ agent: 'cx', fields: { effort: 'max' } })
  expect(runtimes.launch('cx').effort).toBe('xhigh')
  runtimes.configure({
    agent: 'oc',
    fields: { small: 'mg/deepseek/deepseek-flash' },
  })
  expect(runtimes.launch('oc').small).toEqual({
    model: 'deepseek/deepseek-flash',
  })
  runtimes.configure({
    agent: 'oc',
    fields: { small: 'other/claude-sonnet-4-6' },
  })
  expect(runtimes.launch('oc').small).toBeUndefined()
})

test('a worker session’s task tier: the role’s own model where this runtime can call it, else the agent’s; Claude Code by its own tier aliases', () => {
  const runtimes = node({
    plan: 'mg/deepseek/deepseek-v4',
    smol: 'mg/deepseek/deepseek-flash',
  })
  expect(
    runtimes.launch('cx', { sessionId: 's1', tier: 'complex' }).model,
  ).toBe('deepseek/deepseek-v4')
  expect(runtimes.launch('cx', { sessionId: 's2', tier: 'simple' }).model).toBe(
    'deepseek/deepseek-flash',
  )
  // medium is the agent's own model.
  expect(runtimes.launch('cx', { sessionId: 's3', tier: 'medium' }).model).toBe(
    'openai/gpt-6',
  )
  // Qwen cannot send the mg profile's headers: its own model.
  expect(
    runtimes.launch('qw', { sessionId: 's4', tier: 'complex' }).model,
  ).toBe('claude-sonnet-4-6')
  // A role that follows the main model (no own model): the agent's.
  expect(node().launch('cx', { sessionId: 's5', tier: 'complex' }).model).toBe(
    'openai/gpt-6',
  )
  const complex = runtimes.launch('cc', { sessionId: 's6', tier: 'complex' })
  expect(complex.model).toBe('anthropic/claude-opus-4-6')
  expect(complex.alias).toBe('opus')
  expect(claudeCodeModelPlan(complex).model).toBe('opus')
  const simple = runtimes.launch('cc', { sessionId: 's7', tier: 'simple' })
  expect(claudeCodeModelPlan(simple).model).toBe('haiku')
  expect(runtimes.launch('cc', { sessionId: 's8', tier: 'medium' }).alias).toBe(
    undefined,
  )
})

test('qianmopi: an agent configured on it runs its own model and thinking over the node’s, none as off; the others are left alone', () => {
  const runtimes = node()
  const fallback = {
    provider: 'qm-mg-0123abcd',
    modelId: 'deepseek/deepseek-v4',
    thinkingLevel: 'medium',
  }
  expect(runtimes.ompSelection('pi', fallback)).toBeUndefined()
  runtimes.configure({ agent: 'pi', fields: { effort: 'none' } })
  expect(runtimes.ompSelection('pi', fallback)).toEqual({
    ...fallback,
    thinkingLevel: 'off',
  })
  runtimes.configure({
    agent: 'pi',
    model: 'other/claude-sonnet-4-6',
    fields: null,
  })
  expect(runtimes.ompSelection('pi', fallback)).toEqual({
    provider: 'qm-other-0123abcd',
    modelId: 'claude-sonnet-4-6',
    thinkingLevel: 'medium',
  })
  // Configured on Claude Code: its model is Claude Code's business.
  expect(runtimes.ompSelection('cc', fallback)).toBeUndefined()
})

// --- the model service on the node ----------------------------------------------

function yaml(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, Bun.YAML.stringify(value))
}

test('the model service gives a model’s window, reply and efforts, its profile’s models, a role’s own model and qianmopi’s provider', () => {
  yaml(providerPaths.models(), {
    providers: {
      'qm-mg-0123abcd': {
        baseUrl: 'https://gw.example/v1',
        api: 'openai-completions',
        apiKey: 'sk-gw',
        models: [
          {
            id: 'deepseek-v4',
            contextWindow: 1_000_000,
            maxTokens: 64_000,
            reasoning: true,
            thinking: { mode: 'effort', efforts: ['low', 'high', 'max'] },
          },
          {
            id: 'deepseek-flash',
            contextWindow: 128_000,
            maxTokens: 8_000,
            reasoning: false,
          },
          { id: 'img', kind: 'image', contextWindow: 1, maxTokens: 1 },
        ],
      },
      'qm-mg-89abcdef': {
        baseUrl: 'https://gw.example',
        api: 'anthropic-messages',
        apiKey: 'sk-gw',
        models: [],
      },
    },
  })
  yaml(providerPaths.config(), {
    modelRoles: {
      default: 'qm-mg-0123abcd/deepseek-v4:high',
      plan: 'qm-mg-0123abcd/deepseek-v4:high',
      smol: 'qm-mg-0123abcd/deepseek-flash:off',
    },
  })
  const route = runtimeModelCredential('mg/deepseek-v4', 'dsh')
  expect(route.facts).toEqual({
    id: 'deepseek-v4',
    contextWindow: 1_000_000,
    maxOutputTokens: 64_000,
    efforts: ['low', 'high', 'max'],
  })
  expect(route.siblings?.map(one => one.id)).toEqual([
    'deepseek-v4',
    'deepseek-flash',
  ])
  expect(route.siblings?.[1]?.reasoning).toBe(false)
  // The same as the main model: no model of its own.
  expect(nodeRoleModelSpec('plan')).toBeUndefined()
  expect(nodeRoleModelSpec('default')).toBeUndefined()
  expect(nodeRoleModelSpec('smol')).toBe('mg/deepseek-flash')
  expect(nodeRoleModelSpec('slow')).toBeUndefined()
  expect(ompProviderModel('mg/deepseek-flash')).toEqual({
    provider: 'qm-mg-0123abcd',
    modelId: 'deepseek-flash',
  })
  expect(ompProviderModel('nope/x')).toBeUndefined()
})

// --- the pool -------------------------------------------------------------------

test('the pool keeps a session’s first task tier, starts it with that tier every time, and a later turn’s tier changes nothing', async () => {
  const { ExternalRuntimePool } = await import(
    '../../src/host/runtimes/pool.js'
  )
  const { spawn } = await import('node:child_process')
  const cwd = `${root.root}-ws`
  mkdirSync(cwd, { recursive: true })
  const asked: { sessionId: string; tier?: string }[] = []
  const argvs: string[][] = []
  const pool = new ExternalRuntimePool({
    agents: [{ agent: 'cc', cwd, runtime: 'claude-code' }],
    resolveLaunch: (_agent, session) => {
      asked.push({ ...session })
      return {
        model: 'kimi-k3',
        baseUrl: 'http://127.0.0.1:9',
        apiKey: 'sk-test',
        tiers: { haiku: { model: 'kimi-k3-mini' } },
        ...(session.tier === 'simple' ? { alias: 'haiku' as const } : {}),
      }
    },
    memoryRoot: join(root.root, 'memory'),
    hostTools: { announce: async () => ({ status: 'sent' }) },
    spawn: input => {
      argvs.push([...input.argv])
      return spawn(
        process.execPath,
        [
          join(import.meta.dir, 'fixtures', 'fake-claude-code.runner.ts'),
          ...input.argv.slice(1),
        ],
        { cwd: input.cwd, env: input.env, stdio: ['pipe', 'pipe', 'pipe'] },
      )
    },
  })
  try {
    const session = await pool.newSession({ agent: 'cc', cwd })
    pool.noteTier(session, 'simple')
    pool.noteTier(session, 'complex')
    await pool.channelFor(session)
    expect(asked).toEqual([{ sessionId: session, tier: 'simple' }])
    expect(argvs[0]![argvs[0]!.indexOf('--model') + 1]).toBe('haiku')
    // Started again (reaped, or the node restarted): the same tier.
    pool.closeSession(session)
    pool.noteTier(session, 'complex')
    await pool.channelFor(session)
    expect(asked.at(-1)).toEqual({ sessionId: session, tier: 'simple' })
    const record = JSON.parse(
      readFileSync(
        qianmoConfigPath('resident', 'sessions', 'cc', session, 'runtime.json'),
        'utf8',
      ),
    )
    expect(record.tier).toBe('simple')
    // A session without a tier (a chat) ignores directions that are not one.
    const chat = await pool.newSession({ agent: 'cc', cwd })
    pool.noteTier(chat, 'code')
    await pool.channelFor(chat)
    expect(asked.at(-1)).toEqual({ sessionId: chat })
  } finally {
    await pool.stop()
    rmSync(cwd, { recursive: true, force: true })
  }
})
