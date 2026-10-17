// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The runtime catalog (P36.1, `harness-backends.md` §1): every agent harness a
 * resident agent can run on, in one table the node, the hub and the console
 * share. Nothing here is fetched; a harness joins by a code change.
 *
 * - `omp` is qianmopi, built into `qm` itself (shown as "qianmopi"); it is
 *   always present and is where an agent falls back when its configured
 *   runtime cannot run (§3.3).
 * - `dsh` (DeepSeek Harness) is the default runtime and the one a node
 *   installs on its own (§2).
 * - `claude-code` and `codex` keep their own protocols (P27); every other
 *   harness speaks the Agent Client Protocol and shares one channel (§5).
 */

import type { AcpRuntime, RuntimeLane } from './acpSpec.js'
import {
  DSH_QMO_SKILLS,
  dshLaunch,
  dshOpen,
  dshToolCall,
  dshUsageReader,
} from './dsh.js'
import {
  GEMINI_QMO_SKILLS,
  geminiLaunch,
  geminiOpen,
  geminiToolCall,
} from './gemini.js'
import {
  OPENCODE_QMO_SKILLS,
  opencodeLaunch,
  opencodeOpen,
  opencodeToolCall,
} from './opencode.js'
import { QWEN_QMO_SKILLS, qwenLaunch, qwenOpen, qwenToolCall } from './qwen.js'

export type {
  AcpLaunch,
  AcpLaunchInput,
  AcpRuntime,
  AcpToolCall,
  AcpUsage,
  AcpUsageReader,
  AcpVerdictCall,
  RuntimeLane,
} from './acpSpec.js'

/** Wire protocols a runtime child is driven over. */
export type RuntimeProtocol =
  | 'omp'
  | 'claude-stream'
  | 'codex-app-server'
  | 'acp'

/** A model family an agent defaults to on its runtime (§4.2). */
export interface ModelFamily {
  readonly id: string
  /** Shown in the console: "Claude", "GPT", "DeepSeek"… */
  readonly label: string
  /**
   * Preference tiers, best first, matched against the model id's last path
   * segment, lower-cased. A model in no tier is not of this family.
   */
  readonly tiers: readonly RegExp[]
}

export interface NpmInstall {
  readonly kind: 'npm'
  /** The official package, installed unmodified. */
  readonly package: string
  /** The executable it puts in `node_modules/.bin`. */
  readonly command: string
  /** The exact version this build installs when none is asked for. */
  readonly pin: string
  /** Needs Node.js on the node at run time (not only npm at install). */
  readonly needsNode?: string
}

export type RuntimeInstall = { readonly kind: 'builtin' } | NpmInstall

export interface RuntimeSpec {
  readonly id: string
  /** Display name. */
  readonly label: string
  readonly protocol: RuntimeProtocol
  readonly install: RuntimeInstall
  /** Only `dsh`: the node default and the one installed unasked. */
  readonly default: boolean
  /** Lanes it can call, preferred first; empty for `omp` (any). */
  readonly lanes: readonly RuntimeLane[]
  /** Default model family; `null` follows the node's main model. */
  readonly family: ModelFamily | null
  readonly acp?: AcpRuntime
  /** A full turn was run on this build (§7); else the console says "未实测". */
  readonly verified: boolean
}

export const FAMILIES = {
  deepseek: {
    id: 'deepseek',
    label: 'DeepSeek',
    tiers: [
      /^deepseek-v\d/,
      /^deepseek-chat/,
      /^deepseek-reasoner/,
      /deepseek/,
    ],
  },
  claude: {
    id: 'claude',
    label: 'Claude',
    tiers: [/claude.*opus/, /claude.*sonnet/, /^claude(?!.*haiku)/, /claude/],
  },
  gpt: {
    id: 'gpt',
    label: 'GPT',
    tiers: [
      /^gpt-[\d.]+.*codex/,
      /^gpt-[\d.]+(?!.*(mini|nano))/,
      /^gpt-/,
      /^o\d/,
    ],
  },
  gemini: {
    id: 'gemini',
    label: 'Gemini',
    tiers: [/^gemini-.*pro/, /^gemini-.*flash(?!.*lite)/, /^gemini/],
  },
  qwen: {
    id: 'qwen',
    label: 'Qwen',
    tiers: [/^qwen.*coder/, /^qwen.*max/, /^qwen/],
  },
  kimi: {
    id: 'kimi',
    label: 'Kimi',
    tiers: [/^kimi-k\d/, /kimi|moonshot/],
  },
} as const satisfies Record<string, ModelFamily>

/** DeepSeek Harness over ACP (`dsh.ts`). */
const DSH: AcpRuntime = {
  launch: dshLaunch,
  skillsDir: `skills/${DSH_QMO_SKILLS}`,
  // dsh rejects SSE servers in `session/new`.
  mcpTransports: ['stdio', 'http'],
  // No `session/load`; `session/resume` restores the history model-side.
  resume: 'session/resume',
  effortOption: 'reasoning_effort',
  // ACP carries no usage; the session log has the provider's.
  usage: dshUsageReader,
  toolCall: dshToolCall,
  // Its web UI on the agent's acp profile (§7.2).
  open: input => dshOpen(input),
}

/** Gemini CLI over ACP (`gemini.ts`). */
const GEMINI: AcpRuntime = {
  launch: geminiLaunch,
  skillsDir: GEMINI_QMO_SKILLS,
  // An MCP tool's server is named in its title (`gemini.ts`); connectors
  // are also on its server allowlist.
  mcpTransports: ['stdio', 'http', 'sse'],
  // `session/load` (advertised) replays the conversation, after its answer
  // (the channel waits it out); usage comes in `PromptResponse.usage`.
  toolCall: geminiToolCall,
  open: input => geminiOpen(input),
}

/** Qwen Code over ACP (`qwen.ts`). */
const QWEN: AcpRuntime = {
  launch: qwenLaunch,
  skillsDir: QWEN_QMO_SKILLS,
  mcpTransports: ['stdio', 'http', 'sse'],
  // Advertises `session/resume`; usage only as `usage_update` estimates.
  toolCall: qwenToolCall,
  open: qwenOpen,
}

/** opencode over ACP (`opencode.ts`). */
const OPENCODE: AcpRuntime = {
  launch: opencodeLaunch,
  skillsDir: OPENCODE_QMO_SKILLS,
  mcpTransports: ['stdio', 'http', 'sse'],
  // Its `PromptResponse.usage` is the last model call's, not the turn's.
  promptUsage: false,
  toolCall: opencodeToolCall,
  // Its local server listens even under ACP: a port and a password.
  needsPort: true,
  open: opencodeOpen,
}

/**
 * The catalog. ACP entries beyond `dsh` are added by P36.2 from the survey
 * (`harness-backends.md` §1.3); only harnesses whose official release serves
 * ACP itself and can be pointed at a custom gateway with a key qualify.
 */
export const RUNTIME_CATALOG: readonly RuntimeSpec[] = [
  {
    id: 'dsh',
    label: 'DeepSeek Harness',
    protocol: 'acp',
    install: {
      kind: 'npm',
      package: '@deepseek-ai/dsh',
      command: 'dsh',
      pin: '0.2.1-rc.2',
      needsNode: '^22.19.0 || >=24',
    },
    default: true,
    lanes: ['openai-chat', 'anthropic'],
    family: FAMILIES.deepseek,
    acp: DSH,
    // `realDsh.smoke.test.ts` on 0.2.1-rc.2 (macOS arm64, 2026-10-17).
    verified: true,
  },
  {
    id: 'omp',
    label: 'qianmopi',
    protocol: 'omp',
    install: { kind: 'builtin' },
    default: false,
    lanes: [],
    family: null,
    verified: true,
  },
  {
    id: 'claude-code',
    label: 'Claude Code',
    protocol: 'claude-stream',
    install: {
      kind: 'npm',
      package: '@anthropic-ai/claude-code',
      command: 'claude',
      pin: '2.1.301',
    },
    default: false,
    lanes: ['anthropic'],
    family: FAMILIES.claude,
    verified: true,
  },
  {
    id: 'codex',
    label: 'Codex',
    protocol: 'codex-app-server',
    install: {
      kind: 'npm',
      package: '@openai/codex',
      command: 'codex',
      pin: '0.163.0',
    },
    default: false,
    lanes: ['openai-responses'],
    family: FAMILIES.gpt,
    verified: true,
  },
  {
    id: 'gemini',
    label: 'Gemini CLI',
    protocol: 'acp',
    install: {
      kind: 'npm',
      package: '@google/gemini-cli',
      command: 'gemini',
      pin: '0.64.0',
      needsNode: '>=20',
    },
    default: false,
    lanes: ['gemini'],
    family: FAMILIES.gemini,
    acp: GEMINI,
    // `realAcpHarnesses.smoke.test.ts` on 0.64.0 (macOS arm64, 2026-10-17).
    verified: true,
  },
  {
    id: 'qwen',
    label: 'Qwen Code',
    protocol: 'acp',
    install: {
      kind: 'npm',
      package: '@qwen-code/qwen-code',
      command: 'qwen',
      pin: '0.25.2',
      needsNode: '>=22',
    },
    default: false,
    lanes: ['openai-chat'],
    family: FAMILIES.qwen,
    acp: QWEN,
    // `realAcpHarnesses.smoke.test.ts` on 0.25.2 (macOS arm64, 2026-10-17).
    verified: true,
  },
  {
    id: 'opencode',
    label: 'opencode',
    protocol: 'acp',
    install: {
      kind: 'npm',
      package: 'opencode-ai',
      command: 'opencode',
      pin: '1.19.3',
    },
    default: false,
    lanes: ['openai-chat', 'anthropic'],
    family: null,
    acp: OPENCODE,
    // `realAcpHarnesses.smoke.test.ts` on 1.19.3 (macOS arm64, 2026-10-17).
    verified: true,
  },
]

export const DEFAULT_RUNTIME = 'dsh'
/** Where an agent runs when its configured runtime cannot. */
export const FALLBACK_RUNTIME = 'omp'

export function runtimeSpec(id: string): RuntimeSpec | undefined {
  return RUNTIME_CATALOG.find(spec => spec.id === id)
}

/** Accepts the console's "qianmopi" for the built-in `omp`. */
export function normalizeRuntimeId(value: string): string | undefined {
  const id = value === 'qianmopi' ? 'omp' : value
  return runtimeSpec(id) === undefined ? undefined : id
}

function versionKey(name: string): number[] {
  return (name.match(/\d+/g) ?? []).map(Number)
}

function compareVersionsDesc(a: string, b: string): number {
  const x = versionKey(a)
  const y = versionKey(b)
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (y[i] ?? -1) - (x[i] ?? -1)
    if (d !== 0) return d
  }
  return a.length - b.length || a.localeCompare(b)
}

/**
 * The models of `family` among `models`, best first: by tier, then by the
 * numbers in the name (newer first), then shorter names. Model ids may be
 * gateway ids (`provider/model`); routing groups (`group/…`) never qualify.
 */
export function rankFamilyModels(
  family: ModelFamily,
  models: readonly string[],
): string[] {
  const ranked: { id: string; tier: number; name: string }[] = []
  for (const id of models) {
    if (id.startsWith('group/')) continue
    const name = (id.split('/').pop() ?? id).toLowerCase()
    const tier = family.tiers.findIndex(pattern => pattern.test(name))
    if (tier >= 0) ranked.push({ id, tier, name })
  }
  ranked.sort((a, b) => a.tier - b.tier || compareVersionsDesc(a.name, b.name))
  return ranked.map(entry => entry.id)
}
