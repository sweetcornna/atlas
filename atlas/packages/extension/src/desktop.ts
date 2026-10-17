// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { declareWorkerHostEntry } from '@oh-my-pi/pi-utils/worker-host'
import type { TSchema } from '@oh-my-pi/omptype/typebox'
import type { ExtensionAPI } from '@oh-my-pi/pi-coding-agent/extensibility/extensions'
import {
  DESKTOP_FIELDS,
  isDesktopTool,
  desktopLeaseAnswer,
  desktopToolDescription,
  type DesktopTool,
} from './desktopPolicy.js'
import { DesktopExecutor, type DesktopGateway } from './desktopExec.js'

export { readDesktopResource } from './desktopExec.js'

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
  for (const name of Object.keys(DESKTOP_FIELDS) as DesktopTool[]) {
    const fields: Readonly<Record<string, string>> = DESKTOP_FIELDS[name]
    const schema: Record<string, TSchema> = {}
    for (const [key, kind] of Object.entries(fields))
      schema[key] =
        kind === 'number'
          ? Type.Number({ minimum: -10000, maximum: 10000 })
          : Type.String({ maxLength: key === 'text' ? 16000 : 2000 })
    pi.registerTool({
      name,
      label: name,
      description: desktopToolDescription(name),
      parameters: Type.Object(schema, { additionalProperties: false }),
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
