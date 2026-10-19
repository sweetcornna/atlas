// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ExtensionFactory } from '@oh-my-pi/pi-coding-agent/extensibility/extensions'
import { registerDesktopTools, readDesktopResource } from './desktop.js'
import { isDesktopTool } from './desktopPolicy.js'
import {
  ELEVATION_GATE_TITLE,
  elevatedCall,
  elevationActive,
  sandboxedCommand,
  unsandboxedCommand,
} from './elevationPolicy.js'
import { readElevationResource } from './elevation.js'
import { protectedConfigRoots } from '@qianmo/paths'
import { ResidentHardline } from '@qianmo/resident/guard'
import {
  readResidentExtensionConfig,
  residentActiveTools,
  residentToolVerdict,
  residentApprovalInput,
  residentWorkspaceTarget,
  unmarkResidentInput,
  RESIDENT_INPUT_IDENTITY_ENTRY,
  type ResidentExtensionConfig,
} from './policy.js'

type Gate = (message: string) => Promise<boolean>

/**
 * omp rebinds this factory into every subagent session and module globals are
 * shared between the bindings. A subagent has no UI of its own, so its
 * elevated calls reach the host gate through the main session's confirm; the
 * host attributes them to the main session's active turn.
 */
let mainGate: Gate | undefined

/** Children never wait for a person: this budget is the host's, not a human's. */
const GATE_TIMEOUT_MS = 75_000

const extension: ExtensionFactory = pi => {
  let config: ResidentExtensionConfig | undefined
  let failure = 'resident configuration unavailable'
  try {
    config = readResidentExtensionConfig()
  } catch (error) {
    failure = String(error)
  }
  const hardline = new ResidentHardline({
    stateRoots: protectedConfigRoots(),
    protectedRoots: [
      ...protectedConfigRoots(),
      ...(config?.protectedRoots ?? []),
    ],
  })
  if (config?.desktopPath)
    registerDesktopTools(pi, config.desktopPath, config.workspace)
  const refreshDesktop = () => {
    if (config?.desktopPath)
      config = { ...config, desktop: readDesktopResource(config.desktopPath) }
  }
  const refreshElevation = () => {
    if (config?.elevationPath)
      config = {
        ...config,
        elevation: readElevationResource(config.elevationPath),
      }
  }
  /** Elevated calls this binding let through, awaiting their result. */
  const elevatedPending = new Map<string, string>()
  pi.on('before_agent_start', async () => {
    refreshDesktop()
    refreshElevation()
    if (config)
      await pi.setActiveTools(
        residentActiveTools(
          config.edits,
          config.hostTools,
          config.media,
          config.desktop,
          config.mcp,
          config.elevation,
        ),
      )
  })
  let pendingId: string | undefined
  pi.on('input', event => {
    const input = unmarkResidentInput(event.text)
    pendingId = input?.messageId
    if (input !== undefined) return { text: input.text }
  })
  // omp emits message_end before its queued persistence finishes. Link the
  // admission marker to the actual user entry, never merely to an input hook.
  pi.on('message_end', async (event, ctx) => {
    if (event.message.role !== 'user' || pendingId === undefined) return
    const message = event.message
    const messageId = pendingId
    pendingId = undefined
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      const user = ctx.sessionManager
        .getEntries()
        .findLast(
          entry =>
            entry.type === 'message' &&
            entry.message.role === 'user' &&
            entry.message.timestamp === message.timestamp &&
            JSON.stringify(entry.message.content) ===
              JSON.stringify(message.content),
        )
      if (user !== undefined) {
        pi.appendEntry(RESIDENT_INPUT_IDENTITY_ENTRY, {
          messageId,
          userEntryId: user.id,
        })
        return
      }
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    throw new Error('Resident input did not reach the omp session transcript')
  })
  pi.on('session_start', async (_event, ctx) => {
    if (ctx.agent.kind === 'main')
      mainGate = message =>
        ctx.ui.confirm(ELEVATION_GATE_TITLE, message, {
          timeout: GATE_TIMEOUT_MS,
        })
    refreshDesktop()
    refreshElevation()
    await pi.setActiveTools(
      config === undefined
        ? []
        : residentActiveTools(
            config.edits,
            config.hostTools,
            config.media,
            config.desktop,
            config.mcp,
            config.elevation,
          ),
    )
  })
  pi.on('tool_call', async (event, ctx) => {
    if (config === undefined) return { block: true, reason: failure }
    if (isDesktopTool(event.toolName)) {
      refreshDesktop()
      return residentToolVerdict(
        {
          toolName: event.toolName,
          input: event.input as Readonly<Record<string, unknown>>,
        },
        config,
        { agentKind: ctx.agent.kind },
      )
    }
    refreshElevation()
    const grant = config.elevation
    // Judge a repeated earlier rewrite by the command it wraps.
    const original = event.input as Readonly<Record<string, unknown>>
    const input =
      elevationActive(grant) &&
      grant.sandbox !== null &&
      event.toolName === 'bash' &&
      typeof original.command === 'string'
        ? {
            ...original,
            command: unsandboxedCommand(original.command, grant.sandbox),
          }
        : original
    const denial = hardline.verdict(event.toolName, input)
    if (denial !== null) return { block: true, reason: denial.target.reason }
    if (elevationActive(grant)) {
      const elevated = elevatedCall(event.toolName, input)
      if (typeof elevated === 'string')
        return {
          block: true,
          reason: `Qianmo high-permission mode: ${elevated}`,
        }
      if (elevated !== undefined) {
        let bound: Readonly<Record<string, unknown>> = input
        let cwd: string | undefined
        if (event.toolName === 'bash') {
          if (grant.sandbox === null)
            return {
              block: true,
              reason:
                'Qianmo high-permission mode: this node has no command sandbox',
            }
          const place = residentWorkspaceTarget(
            typeof input.cwd === 'string' ? input.cwd : '.',
            config.workspace,
          )
          if (!place.inside)
            return {
              block: true,
              reason:
                'Qianmo high-permission mode: bash cwd must stay inside the workspace',
            }
          cwd = place.target
          bound = { ...input, cwd }
        }
        const gate: Gate | undefined =
          ctx.agent.kind === 'main'
            ? message =>
                ctx.ui.confirm(ELEVATION_GATE_TITLE, message, {
                  timeout: GATE_TIMEOUT_MS,
                })
            : mainGate
        const allowed =
          gate !== undefined &&
          (await gate(
            JSON.stringify({
              toolName: event.toolName,
              input: {
                phase: 'authorize',
                invocationId: event.toolCallId,
                epoch: grant.epoch,
                agentKind: ctx.agent.kind,
                args: bound,
              },
            }),
          ).catch(() => false))
        if (!allowed)
          return {
            block: true,
            reason:
              'Qianmo high-permission mode: the node refused this call (expired, revoked, over budget, ESTOP, needs approval a subagent cannot wait for, or not approved)',
          }
        elevatedPending.set(event.toolCallId, event.toolName)
        if (event.toolName === 'bash' && grant.sandbox !== null && cwd)
          return {
            input: {
              ...input,
              cwd,
              command: sandboxedCommand(
                String(bound.command),
                cwd,
                grant.sandbox,
              ),
            },
          }
        return undefined
      }
    }
    const verdict = residentToolVerdict(
      {
        toolName: event.toolName,
        input: event.input as Readonly<Record<string, unknown>>,
      },
      config,
      { agentKind: ctx.agent.kind },
    )
    if (verdict?.approvalEligible !== true) return verdict
    const approvedInput = residentApprovalInput(
      {
        toolName: event.toolName,
        input: event.input as Readonly<Record<string, unknown>>,
      },
      config.workspace,
    )
    const approved = await ctx.ui.confirm(
      'QIANMO_AUTHZ_V1',
      JSON.stringify({ toolName: event.toolName, input: approvedInput }),
      { timeout: 60_000 },
    )
    if (!approved)
      return {
        block: true,
        reason: 'Operator approval was not granted for this exact tool call',
      }
    if (
      JSON.stringify(approvedInput) !==
      JSON.stringify(
        residentApprovalInput(
          {
            toolName: event.toolName,
            input: event.input as Readonly<Record<string, unknown>>,
          },
          config.workspace,
        ),
      )
    )
      return {
        block: true,
        reason: 'Approved file target changed while awaiting the decision',
      }
    const after = residentToolVerdict(
      {
        toolName: event.toolName,
        input: event.input as Readonly<Record<string, unknown>>,
      },
      config,
      { agentKind: ctx.agent.kind },
    )
    return after?.approvalEligible === true ? undefined : after
  })
  pi.on('tool_result', async (event, ctx) => {
    const toolName = elevatedPending.get(event.toolCallId)
    if (toolName === undefined) return
    elevatedPending.delete(event.toolCallId)
    const gate: Gate | undefined =
      ctx.agent.kind === 'main'
        ? message =>
            ctx.ui.confirm(ELEVATION_GATE_TITLE, message, {
              timeout: GATE_TIMEOUT_MS,
            })
        : mainGate
    await gate?.(
      JSON.stringify({
        toolName,
        input: {
          phase: 'completed',
          invocationId: event.toolCallId,
          agentKind: ctx.agent.kind,
          isError: event.isError,
        },
      }),
    ).catch(() => false)
  })
  // Subagents run only under a live grant; their every call is gated above.
  pi.on('before_subagent_spawn', () => {
    refreshElevation()
    return elevationActive(config?.elevation)
      ? undefined
      : {
          block: true,
          reason: 'Resident turns cannot spawn unattended agents',
        }
  })
}
export default extension
