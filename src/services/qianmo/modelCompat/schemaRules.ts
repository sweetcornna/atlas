// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Tool-schema rewrites the chat lane applies before sending (P18.12, hermes
 * #21; design `providers-console-m1.md` §5.6 row 21) — only the three that
 * change no argument the tool accepts:
 *   1. `type` arrays: `["string", "null"]` → `type: "string"` plus
 *      `nullable: true`; several non-null types → an `anyOf` of single-type
 *      schemas, so no branch is lost. Gemini behind OpenAI-compatible
 *      transports and llama.cpp's grammar builder reject the array form;
 *      zod's `.nullable()` produces it.
 *   2. a nested `type: "object"` without `properties` gets `properties: {}`
 *      (the top level already does, `normalizeToObjectSchema`).
 *   3. `default` next to `$ref` is dropped: draft-07-strict validators
 *      (Fireworks-hosted Kimi) reject "keyword(s) ['default'] not allowed at
 *      the same level as $ref".
 * A schema none of these apply to comes back as the same object, so tools
 * that were fine send the same bytes (and keep the prompt cache).
 *
 * Not here (design §5.6 row 21, recorded as left over): property-key
 * renaming (has to be undone on the way back, and applies to the Anthropic
 * lane too), the Moonshot subset, and the reactive strip of `pattern` /
 * `format` after a 400.
 *
 * 规则来源 NousResearch/hermes-agent（MIT，Copyright (c) 2025 Nous Research，
 * 声明见 NOTICE 五），取于 `f9b29c49b6`（2026-10-03 取用）：
 * `tools/schema_sanitizer.py` — `_sanitize_node` `:400-470` (type arrays,
 * ported there from anomalyco/opencode#31877) and `:523-526` (object nodes
 * without properties), `_strip_ref_siblings` `:177-200` (`default` beside
 * `$ref`). Only the rules are taken; the code is ours.
 */
import type { ChatCompletionTool } from 'openai/resources/chat/completions/completions.mjs'

type Schema = Record<string, unknown>

function isSchema(value: unknown): value is Schema {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Keys whose value is a map of name → schema. */
const SCHEMA_MAP_KEYS = [
  'properties',
  '$defs',
  'definitions',
  'patternProperties',
] as const
/** Keys whose value is one schema. */
const SCHEMA_KEYS = [
  'items',
  'additionalProperties',
  'not',
  'if',
  'then',
  'else',
  'contains',
  'propertyNames',
] as const
/** Keys whose value is a list of schemas. */
const SCHEMA_LIST_KEYS = ['anyOf', 'oneOf', 'allOf', 'prefixItems'] as const

function rewriteTypeArray(node: Schema, types: unknown[]): Schema {
  const { type: _type, ...rest } = node
  const hasNull = types.includes('null')
  const nonNull = types.filter(
    (type): type is string => typeof type === 'string' && type !== 'null',
  )
  const nullable = hasNull ? { nullable: node.nullable ?? true } : {}
  if (nonNull.length === 1) return { ...rest, type: nonNull[0], ...nullable }
  if (nonNull.length >= 2) {
    return {
      ...rest,
      anyOf: [
        ...nonNull.map(type => ({ type })),
        ...(Array.isArray(rest.anyOf) ? rest.anyOf : []),
      ],
      ...nullable,
    }
  }
  return { ...rest, type: hasNull ? 'null' : 'object' }
}

/** `schema` with the three rules applied at every level. */
export function applyLosslessSchemaRules(schema: Schema): Schema {
  let node = schema
  let changed = false
  const set = (key: string, value: unknown) => {
    if (!changed) node = { ...node }
    changed = true
    node[key] = value
  }

  for (const key of SCHEMA_MAP_KEYS) {
    const map = node[key]
    if (!isSchema(map)) continue
    let mapChanged = false
    const next: Schema = {}
    for (const [name, value] of Object.entries(map)) {
      const rewritten = isSchema(value)
        ? applyLosslessSchemaRules(value)
        : value
      if (rewritten !== value) mapChanged = true
      next[name] = rewritten
    }
    if (mapChanged) set(key, next)
  }
  for (const key of SCHEMA_KEYS) {
    const value = node[key]
    if (!isSchema(value)) continue
    const rewritten = applyLosslessSchemaRules(value)
    if (rewritten !== value) set(key, rewritten)
  }
  for (const key of SCHEMA_LIST_KEYS) {
    const list = node[key]
    if (!Array.isArray(list)) continue
    const next = list.map(item =>
      isSchema(item) ? applyLosslessSchemaRules(item) : item,
    )
    if (next.some((item, i) => item !== list[i])) set(key, next)
  }

  if (Array.isArray(node.type)) {
    node = rewriteTypeArray(node, node.type)
    changed = true
  }
  if (node.type === 'object' && !isSchema(node.properties)) {
    set('properties', {})
  }
  if ('$ref' in node && 'default' in node) {
    const { default: _dropped, ...rest } = node
    node = rest
    changed = true
  }
  return changed ? node : schema
}

/**
 * `tools` with the rules applied to each function's parameters — on the chat
 * wire only; the Responses wire (the live path) is returned untouched.
 */
export function applyChatSchemaRules(
  tools: ChatCompletionTool[],
  wireProtocol: string,
): ChatCompletionTool[] {
  if (wireProtocol === 'responses') return tools
  return tools.map(tool => {
    if (tool.type !== 'function' || !isSchema(tool.function.parameters)) {
      return tool
    }
    const parameters = applyLosslessSchemaRules(tool.function.parameters)
    return parameters === tool.function.parameters
      ? tool
      : { ...tool, function: { ...tool.function, parameters } }
  })
}
