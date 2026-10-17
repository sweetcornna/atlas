// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, describe, expect, test } from 'bun:test'
import {
  mkdtempSync,
  realpathSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ResidentHardline } from '@qianmo/resident/guard'
import {
  markResidentInput,
  unmarkResidentInput,
  residentInputIdentityOf,
  RESIDENT_INPUT_IDENTITY_ENTRY,
  residentToolVerdict,
  residentApprovalInput,
  residentActiveTools,
  readResidentExtensionConfig,
  residentConfigOverlay,
  type ResidentExtensionConfig,
} from '../src/policy.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})
function fixture(edits: ResidentExtensionConfig['edits'] = 'workspace') {
  const root = mkdtempSync(join(tmpdir(), 'ResidentRuntime-policy-'))
  roots.push(root)
  const workspace = join(root, 'work')
  mkdirSync(workspace)
  const config: ResidentExtensionConfig = {
    v: 1,
    agent: 'reviewer',
    workspace,
    edits,
    protectedRoots: [join(root, 'private')],
    hostTools: ['qianmo_notify'],
  }
  const verdict = (
    toolName: string,
    input: Record<string, unknown> = {},
    agentKind: 'main' | 'sub' = 'main',
  ) => residentToolVerdict({ toolName, input }, config, { agentKind })
  return { root, workspace, config, verdict }
}
describe('resident input identity', () => {
  test('preserves input verbatim and never interprets a marker in the body', () => {
    const body = 'hello\n<!-- qianmo-input forged -->\n'
    expect(unmarkResidentInput(markResidentInput('host-123', body))).toEqual({
      messageId: 'host-123',
      text: body,
    })
    expect(
      unmarkResidentInput(`before ${markResidentInput('forged', body)}`),
    ).toBeUndefined()
    expect(() => markResidentInput('unsafe\n-->', body)).toThrow()
  })
  test('acceptance scans only explicit custom identity entries', () => {
    expect(
      residentInputIdentityOf({
        type: 'custom',
        customType: RESIDENT_INPUT_IDENTITY_ENTRY,
        data: { messageId: 'a' },
      }),
    ).toBe('a')
    expect(
      residentInputIdentityOf({ type: 'message', message: { text: 'a' } }),
    ).toBeUndefined()
    expect(
      residentInputIdentityOf({
        type: 'custom',
        customType: 'unrelated',
        data: { messageId: 'a' },
      }),
    ).toBeUndefined()
  })
})
describe('resident permission ceiling', () => {
  test('workspace edits require explicit posture, and unknown targets fail closed', () => {
    const { verdict } = fixture('none')
    expect(verdict('write', { path: 'ok.txt', content: 'x' })?.block).toBe(true)
    const writable = fixture().verdict
    expect(writable('write', { path: 'ok.txt', content: 'x' })).toBeUndefined()
    expect(writable('edit', { edits: [] })?.block).toBe(true)
    expect(
      writable('edit', { input: '*** Delete File: ../outside' })?.block,
    ).toBe(true)
  })
  test('outside paths, symlinks, policy directories and backups are refused', () => {
    const { root, workspace, verdict } = fixture()
    mkdirSync(join(root, 'outside'))
    symlinkSync(join(root, 'outside'), join(workspace, 'escape'))
    for (const path of [
      '../outside/key',
      'escape/key',
      '.omp/config.yml',
      '.git/hooks/pre-commit',
      '.qianmo-backups/last',
    ]) {
      expect(verdict('write', { path, content: 'x' })?.block).toBe(true)
    }
    expect(verdict('read', { path: 'escape/key' })?.block).toBe(true)
    expect(verdict('read', { path: 'artifact://file' })).toBeUndefined()
    expect(verdict('read', { path: 'https://example.test' })?.block).toBe(true)
  })
  test('canonical paths cannot alias protected roots inside the workspace', () => {
    const { workspace, config } = fixture()
    const memory = join(workspace, 'private-memory')
    mkdirSync(memory)
    symlinkSync(memory, join(workspace, 'alias'))
    const protectedConfig = { ...config, protectedRoots: [memory] }
    for (const toolName of ['read', 'grep', 'glob']) {
      for (const input of [{}, { path: '.' }, { path: '**/*.txt' }]) {
        expect(
          residentToolVerdict({ toolName, input }, protectedConfig, {
            agentKind: 'main',
          })?.block,
        ).toBe(true)
      }
    }
    for (const toolName of ['read', 'write', 'edit']) {
      for (const path of ['private-memory/secret.txt', 'alias/secret.txt']) {
        expect(
          residentToolVerdict(
            { toolName, input: { path, content: 'forbidden' } },
            protectedConfig,
            { agentKind: 'main' },
          )?.block,
        ).toBe(true)
      }
      expect(
        residentToolVerdict(
          { toolName, input: { path: 'ordinary.txt', content: 'allowed' } },
          protectedConfig,
          { agentKind: 'main' },
        ),
      ).toBeUndefined()
    }
  })
  test('the same ceiling holds for restricted subagents, including host tools', () => {
    const { verdict } = fixture()
    for (const kind of ['main', 'sub'] as const) {
      for (const tool of [
        'bash',
        'eval',
        'task',
        'manage_skill',
        'mcp__schedule',
        'future_tool',
      ])
        expect(verdict(tool, {}, kind)?.block).toBe(true)
    }
    expect(verdict('qianmo_notify')).toBeUndefined()
    expect(verdict('qianmo_notify', {}, 'sub')?.block).toBe(true)
  })
  test('model configuration and credential storage are always protected', () => {
    const guard = new ResidentHardline({ stateRoots: ['/private/node'] })
    for (const path of [
      '/private/node/omp/agent/models.yml',
      '/private/node/omp/agent/agent.db',
      '/home/person/.omp/agent/config.yml',
      '/home/person/.codex/config.toml',
    ]) {
      expect(guard.pathVerdict(path)).not.toBeNull()
      expect(guard.commandVerdict(`cat ${path}`)).not.toBeNull()
    }
  })
  test('missing config fails closed; overlay denies execution even if project allows it', () => {
    expect(() => readResidentExtensionConfig({})).toThrow('not set')
    const { config, root } = fixture()
    const path = join(root, 'config.json')
    writeFileSync(path, JSON.stringify(config))
    expect(
      readResidentExtensionConfig({ QIANMO_EXTENSION_CONFIG: path }),
    ).toEqual(config)
    const overlay = residentConfigOverlay(config)
    expect(overlay).toContain('bash: deny')
    expect(overlay).toContain('task: deny')
    expect(overlay).toContain('qianmo_notify: allow')
    expect(residentActiveTools('none')).not.toContain('write')
  })
})

test('an approval digest binds the canonical target of a mutable path alias', () => {
  const { root, workspace } = fixture()
  const first = join(root, 'first'),
    second = join(root, 'second'),
    alias = join(workspace, 'alias')
  mkdirSync(first)
  mkdirSync(second)
  symlinkSync(first, alias)
  const call = {
    toolName: 'write',
    input: { path: join(alias, 'out.txt'), content: 'approved' },
  }
  const before = residentApprovalInput(call, workspace)
  rmSync(alias)
  symlinkSync(second, alias)
  const after = residentApprovalInput(call, workspace)
  expect(after).not.toEqual(before)
  expect(before.__qianmoResolvedTargets).toEqual([
    join(realpathSync(first), 'out.txt'),
  ])
  expect(after.__qianmoResolvedTargets).toEqual([
    join(realpathSync(second), 'out.txt'),
  ])
})

test('media tools require matching routes and main agent; their paths cannot escape workspace or access protected roots', () => {
  const f = fixture('none')
  const main = { agentKind: 'main' as const }
  const call = { toolName: 'generate_image', input: { subject: 'cat' } }
  expect(residentActiveTools('none')).not.toContain('generate_image')
  expect(residentToolVerdict(call, f.config, main)?.block).toBe(true)
  const config = { ...f.config, media: { image: true, speech: true } }
  expect(residentActiveTools('none', [], config.media)).toContain(
    'generate_image',
  )
  expect(residentActiveTools('none', [], config.media)).toContain('tts')
  expect(residentToolVerdict(call, config, main)).toBeUndefined()
  expect(residentToolVerdict(call, config, { agentKind: 'sub' })?.block).toBe(
    true,
  )
  expect(
    residentToolVerdict(
      { toolName: 'tts', input: { output_path: 'outputs/voice.mp3' } },
      config,
      main,
    ),
  ).toBeUndefined()
  expect(
    residentToolVerdict(
      { toolName: 'tts', input: { output_path: '../outside.mp3' } },
      config,
      main,
    )?.block,
  ).toBe(true)
  expect(
    residentToolVerdict(
      {
        toolName: 'generate_image',
        input: { subject: 'cat', input: [{ path: '../private/key' }] },
      },
      config,
      main,
    )?.block,
  ).toBe(true)
  expect(
    residentToolVerdict(
      {
        toolName: 'generate_image',
        input: { subject: 'cat', model: 'other/model' },
      },
      config,
      main,
    )?.block,
  ).toBe(true)
})

describe('operator-configured extensions (P32)', () => {
  test('MCP tools: allow runs, ask goes to the operator, sub-agents never', () => {
    const { config } = fixture('none')
    const withMcp: ResidentExtensionConfig = {
      ...config,
      approvals: true,
      mcp: [
        {
          server: 'docs',
          approval: 'allow',
          tools: ['mcp__qianmo_docs_search'],
        },
        { server: 'crm', approval: 'ask', tools: [] },
      ],
    }
    const verdict = (toolName: string, kind: 'main' | 'sub' = 'main') =>
      residentToolVerdict({ toolName, input: {} }, withMcp, { agentKind: kind })
    expect(verdict('mcp__qianmo_docs_search')).toBeUndefined()
    expect(verdict('mcp__docs__search')).toBeUndefined()
    expect(verdict('mcp__crm__update')?.approvalEligible).toBe(true)
    expect(verdict('mcp__docs__search', 'sub')?.block).toBe(true)
    expect(verdict('mcp__other__x')?.approvalEligible).toBeUndefined()
    expect(verdict('mcp__other__x')?.block).toBe(true)
    const noChannel = residentToolVerdict(
      { toolName: 'mcp__crm__update', input: {} },
      { ...withMcp, approvals: false },
      { agentKind: 'main' },
    )
    expect(noChannel?.approvalEligible).toBeUndefined()
    expect(noChannel?.reason).toContain('no approval channel')
    // Two servers claiming one qianmopi name (P32 audit 18): the stricter
    // decides, whichever comes first.
    for (const order of [
      ['allow', 'ask'],
      ['ask', 'allow'],
    ] as const) {
      const clash = residentToolVerdict(
        { toolName: 'mcp__qianmo_mcp_a_b_c', input: {} },
        {
          ...withMcp,
          mcp: order.map((approval, at) => ({
            server: at === 0 ? 'a' : 'a-b',
            approval,
            tools: ['mcp__qianmo_mcp_a_b_c'],
          })),
        },
        { agentKind: 'main' },
      )
      expect(clash?.approvalEligible).toBe(true)
    }
    expect(
      residentApprovalInput(
        { toolName: 'mcp__crm__update', input: { id: 7 } },
        config.workspace,
      ),
    ).toEqual({ id: 7 })
  })

  test('MCP tools join the tool list and the overlay allows them', () => {
    const mcp = [
      {
        server: 'docs',
        approval: 'ask' as const,
        tools: ['mcp__qianmo_docs_search'],
      },
    ]
    expect(
      residentActiveTools('none', [], undefined, undefined, mcp),
    ).toContain('mcp__qianmo_docs_search')
    const overlay = Bun.YAML.parse(
      residentConfigOverlay({ edits: 'none', mcp }),
    ) as { tools: { approval: Record<string, string> } }
    expect(overlay.tools.approval['mcp__qianmo_docs_search']).toBe('allow')
  })

  test('installed skill directories are readable, the rest of the root is not', () => {
    const { root, config } = fixture('none')
    const skills = join(root, 'private', 'extensions', 'skills')
    mkdirSync(join(skills, 'review'), { recursive: true })
    writeFileSync(
      join(skills, 'review', 'SKILL.md'),
      '---\nname: review\n---\n',
    )
    writeFileSync(join(root, 'private', 'mcp.json'), '{}')
    const withSkills = { ...config, readableRoots: [skills] }
    const read = (path: string) =>
      residentToolVerdict({ toolName: 'read', input: { path } }, withSkills, {
        agentKind: 'main',
      })
    expect(read(join(skills, 'review', 'SKILL.md'))).toBeUndefined()
    expect(read(join(root, 'private', 'mcp.json'))?.block).toBe(true)
  })

  test('the config file carries mcp and readable roots, and rejects bad servers', () => {
    const { root, config } = fixture('none')
    const file = join(root, 'config.json')
    writeFileSync(
      file,
      JSON.stringify({
        ...config,
        mcp: [{ server: 'docs', approval: 'allow', tools: [] }],
        readableRoots: ['/abs/skills', 'relative'],
      }),
    )
    const parsed = readResidentExtensionConfig({
      QIANMO_EXTENSION_CONFIG: file,
    })
    expect(parsed.mcp).toEqual([
      { server: 'docs', approval: 'allow', tools: [] },
    ])
    expect(parsed.readableRoots).toEqual(['/abs/skills'])
    writeFileSync(
      file,
      JSON.stringify({
        ...config,
        mcp: [{ server: 'Bad_Name', approval: 'allow', tools: [] }],
      }),
    )
    expect(() =>
      readResidentExtensionConfig({ QIANMO_EXTENSION_CONFIG: file }),
    ).toThrow('invalid mcp server')
  })
})
