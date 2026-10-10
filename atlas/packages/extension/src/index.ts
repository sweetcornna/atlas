// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ExtensionFactory } from '@oh-my-pi/pi-coding-agent/extensibility/extensions'
import { protectedConfigRoots } from '@qianmo/paths'
import { ResidentHardline } from '@qianmo/resident/guard'
import {
  readResidentExtensionConfig,
  residentActiveTools,
  residentToolVerdict,
  residentApprovalInput,
  unmarkResidentInput,
  RESIDENT_INPUT_IDENTITY_ENTRY,
  type ResidentExtensionConfig,
} from './policy.js'

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
  pi.on('session_start', async () => {
    await pi.setActiveTools(
      config === undefined
        ? []
        : residentActiveTools(config.edits, config.hostTools),
    )
  })
  pi.on('tool_call', async (event, ctx) => {
    if (config === undefined) return { block: true, reason: failure }
    const denial = hardline.verdict(event.toolName, event.input)
    if (denial !== null) return { block: true, reason: denial.target.reason }
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
  pi.on('before_subagent_spawn', () => ({
    block: true,
    reason: 'Resident turns cannot spawn unattended agents',
  }))
}
export default extension
