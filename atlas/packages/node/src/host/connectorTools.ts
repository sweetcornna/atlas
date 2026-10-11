// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { newId, type ControlOutcome } from '@qianmo/protocol'
import type { HostToolDefinition } from './notifyTool.js'

export interface ConnectorToolContext {
  readonly agent: string
  readonly sessionId: string
}
export interface ConnectorToolsOptions {
  readonly call: (
    op: string,
    args: Record<string, unknown>,
    options: { agent: string; callId?: string },
  ) => Promise<ControlOutcome>
  readonly approve: (
    ctx: ConnectorToolContext,
    toolName: string,
    input: Record<string, unknown>,
  ) => Promise<{ contextId: string; requestId: string } | null>
}
const string = { type: 'string' }
const specs = [
  {
    name: 'qianmo_connectors',
    op: 'list',
    description:
      'List connections authorized for this agent. Only ids, names and kinds are returned.',
    properties: {},
    required: [],
  },
  {
    name: 'qianmo_mail_search',
    op: 'mail.search',
    description:
      'Search an authorized mailbox. Returns bounded headers and account/folder/UIDVALIDITY-bound handles. Call qianmo_connectors for connectorId.',
    properties: {
      connectorId: string,
      query: string,
      folder: string,
      since: string,
      limit: { type: 'integer', minimum: 1, maximum: 50 },
    },
    required: ['connectorId'],
  },
  {
    name: 'qianmo_mail_read',
    op: 'mail.read',
    description:
      'Read a mail handle from the same connector. At most 64 KiB of plain text; attachment names and sizes only.',
    properties: { connectorId: string, id: string },
    required: ['connectorId', 'id'],
  },
  {
    name: 'qianmo_mail_send',
    op: 'mail.send',
    description:
      'Send exactly one message through an authorized connector. Each call requires fresh user approval. If the outcome is unknown, check with the user; never resend automatically.',
    properties: {
      connectorId: string,
      to: {
        oneOf: [
          string,
          { type: 'array', items: string, minItems: 1, maxItems: 50 },
        ],
      },
      subject: string,
      body: string,
    },
    required: ['connectorId', 'to', 'subject', 'body'],
  },
  {
    name: 'qianmo_calendar_events',
    op: 'calendar.events',
    description:
      'List calendar events within ISO times with explicit timezone. ICS is read-only; recurrence rules are not expanded and the result explains omissions.',
    properties: { connectorId: string, from: string, to: string },
    required: ['connectorId', 'from', 'to'],
  },
  {
    name: 'qianmo_calendar_create',
    op: 'calendar.create',
    description:
      'Create one calendar event after fresh user approval. ISO times require explicit timezone. ICS subscriptions cannot be written. Unknown outcomes must not be retried automatically.',
    properties: {
      connectorId: string,
      title: string,
      start: string,
      end: string,
      location: string,
      notes: string,
    },
    required: ['connectorId', 'title', 'start', 'end'],
  },
]
export function connectorTools(
  options: ConnectorToolsOptions,
): HostToolDefinition[] {
  return specs.map(spec => ({
    name: spec.name,
    description: spec.description,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: spec.properties,
      required: spec.required,
    },
    async handler(raw, ctx) {
      const deny = {
        ok: false,
        text: 'Connection call refused. No external action was executed.',
      }
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return deny
      const params = raw as Record<string, unknown>
      if (
        Object.keys(params).some(key => !Object.hasOwn(spec.properties, key)) ||
        spec.required.some(key => params[key] === undefined)
      )
        return deny
      try {
        let args = { ...params },
          callId: string | undefined
        if (['mail.send', 'calendar.create'].includes(spec.op)) {
          const descriptor = await options.call(
            'connector.describe',
            { connectorId: params['connectorId'] },
            { agent: ctx.agent },
          )
          if (
            !descriptor.ok ||
            !descriptor.value ||
            typeof descriptor.value !== 'object' ||
            Array.isArray(descriptor.value)
          )
            return deny
          const value = descriptor.value as Record<string, unknown>
          if (
            value['readOnly'] === true ||
            typeof value['revision'] !== 'number'
          )
            return deny
          callId = newId()
          const bound = {
            ...params,
            revision: value['revision'],
            operationId: callId,
          }
          const receipt = await options.approve(ctx, spec.name, bound)
          if (!receipt) return deny
          args = {
            ...bound,
            contextId: receipt.contextId,
            approvalId: receipt.requestId,
          }
        }
        const result = await options.call(`connector.${spec.op}`, args, {
          agent: ctx.agent,
          ...(callId === undefined ? {} : { callId }),
        })
        return { ok: result.ok, text: JSON.stringify(result), details: result }
      } catch {
        return {
          ok: false,
          text: 'Connection call failed or outcome unknown. Never resend automatically.',
        }
      }
    },
  }))
}
