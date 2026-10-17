// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { declareWorkerHostEntry } from '@oh-my-pi/pi-utils/worker-host'
import type { TSchema, TypeBuilder } from '@oh-my-pi/omptype/typebox'
import type { ExtensionAPI } from '@oh-my-pi/pi-coding-agent/extensibility/extensions'
import {
  isDesktopTool,
  desktopLeaseAnswer,
  desktopToolDescription,
  desktopToolSchema,
  desktopTools,
} from './desktopPolicy.js'
import { DesktopExecutor, type DesktopGateway } from './desktopExec.js'

export { readDesktopResource } from './desktopExec.js'

type JsonSchema = Readonly<Record<string, unknown>>
const isSchema = (value: unknown): value is JsonSchema =>
  !!value && typeof value === 'object' && !Array.isArray(value)
function numberOpts(
  doc: JsonSchema,
  keys: readonly string[],
): Record<string, number> {
  const out: Record<string, number> = {}
  for (const key of keys) {
    const value = doc[key]
    if (typeof value === 'number') out[key] = value
  }
  return out
}

type ToolParameters = Parameters<ExtensionAPI['registerTool']>[0]['parameters']

/**
 * The typebox form of one {@link desktopToolSchema} document. The host's
 * `Type.Unsafe` keeps and validates the raw document; a builder whose
 * `Unsafe` drops it (omptype's own) gets the document rebuilt node by node,
 * covering the keywords desktopPolicy emits.
 */
export function desktopParameters(
  Type: TypeBuilder,
  doc: JsonSchema,
): ToolParameters {
  const probe = Type.Unsafe({ type: 'string', maxLength: 7 })
  if (probe.toJsonSchema().maxLength === 7) return Type.Unsafe({ ...doc })
  return Type.Object(rebuildFields(Type, doc), { additionalProperties: false })
}
function rebuildFields(
  Type: TypeBuilder,
  doc: JsonSchema,
): Record<string, TSchema> {
  const required = Array.isArray(doc.required) ? doc.required : []
  const properties = isSchema(doc.properties) ? doc.properties : {}
  const fields: Record<string, TSchema> = {}
  for (const [key, value] of Object.entries(properties)) {
    if (!isSchema(value)) continue
    const field = rebuild(Type, value)
    fields[key] = required.includes(key) ? field : Type.Optional(field)
  }
  return fields
}
function rebuild(Type: TypeBuilder, doc: JsonSchema): TSchema {
  const meta =
    typeof doc.description === 'string' ? { description: doc.description } : {}
  if (Array.isArray(doc.anyOf))
    return Type.Union(
      doc.anyOf.filter(isSchema).map(branch => rebuild(Type, branch)),
      meta,
    )
  if (Array.isArray(doc.enum))
    return Type.Union(
      doc.enum
        .filter((value): value is string => typeof value === 'string')
        .map(value => Type.Literal(value)),
      meta,
    )
  switch (doc.type) {
    case 'string':
      return Type.String({
        ...meta,
        ...numberOpts(doc, ['minLength', 'maxLength']),
        ...(typeof doc.pattern === 'string' ? { pattern: doc.pattern } : {}),
      })
    case 'number':
    case 'integer':
      return (doc.type === 'integer' ? Type.Integer : Type.Number)({
        ...meta,
        ...numberOpts(doc, ['minimum', 'maximum']),
      })
    case 'array':
      if (!isSchema(doc.items)) break
      return Type.Array(rebuild(Type, doc.items), {
        ...meta,
        ...numberOpts(doc, ['minItems', 'maxItems']),
      })
    case 'object':
      return Type.Object(rebuildFields(Type, doc), {
        ...meta,
        additionalProperties: false,
      })
  }
  throw new Error('Unsupported desktop schema node')
}

/** Invoke only trusted, fixed call chains; no language VM is model-accessible. */
export function registerDesktopTools(
  pi: ExtensionAPI,
  file: string,
  cwd: string,
): void {
  // From source this shares omp's utils instance and points workers at the
  // omp CLI. The compiled extension bundles its own copy of worker-host (the
  // host registry does not serve it); its browser/computer tools are host
  // modules, and the host CLI declares their worker entry itself, so here the
  // call only touches the extension's private copy.
  declareWorkerHostEntry()
  const Type = pi.typebox.Type
  const executor = new DesktopExecutor(file, cwd)
  const originalCalls = new Map<string, { name: string; args: unknown }>()
  pi.on('before_agent_start', () => {
    originalCalls.clear()
  })
  // omp repairs arguments before tool_call. Preserve the provider's original
  // message to reject an entire malformed call instead of a repaired subset.
  pi.on('message_end', event => {
    if (event.message.role !== 'assistant') return
    for (const part of event.message.content)
      if (part.type === 'toolCall' && isDesktopTool(part.name))
        originalCalls.set(part.id, {
          name: part.name,
          args: JSON.parse(JSON.stringify(part.arguments)),
        })
  })
  pi.on('session_shutdown', () => executor.close())
  for (const name of desktopTools({ browser: true, computer: true })) {
    pi.registerTool({
      name,
      label: name,
      description: desktopToolDescription(name),
      parameters: desktopParameters(Type, desktopToolSchema(name)),
      approval: 'read',
      loadMode: 'essential',
      defaultInactive: true,
      execute: async (invocationId, raw, signal, _update, ctx) => {
        const original = originalCalls.get(invocationId)
        originalCalls.delete(invocationId)
        // The host answers every phase: `input` carries a reason back,
        // `confirm` a yes/no (residentOmp.ts).
        const gateway: DesktopGateway = {
          reserve: async request =>
            desktopLeaseAnswer(
              await ctx.ui.input('QIANMO_AUTHZ_V1', JSON.stringify(request), {
                timeout: 60_000,
              }),
            ),
          confirm: (request, timeout) =>
            ctx.ui.confirm('QIANMO_AUTHZ_V1', JSON.stringify(request), {
              timeout,
            }),
          query: async request =>
            desktopLeaseAnswer(
              await ctx.ui.input('QIANMO_AUTHZ_V1', JSON.stringify(request), {
                timeout: 60_000,
              }),
            ),
        }
        return await executor.run(
          {
            name,
            invocationId,
            original: original?.name === name ? original.args : undefined,
            args: raw,
            agentKind: ctx.agent.kind,
            ...(signal ? { signal } : {}),
          },
          gateway,
        )
      },
    })
  }
}
