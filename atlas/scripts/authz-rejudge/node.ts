// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from 'node:crypto'
import { readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { readTrail, digestOf } from '@qianmo/audit'
import type { ResidentExtensionConfig } from '@qianmo/extension/policy'
import {
  rejudge,
  type Binding,
  type Finding,
  type RejudgeReport,
} from './index.js'

function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(s => typeof s === 'string')
}
function configOf(raw: string): ResidentExtensionConfig {
  const value = JSON.parse(raw) as Partial<ResidentExtensionConfig>
  if (
    !value ||
    value.v !== 1 ||
    typeof value.agent !== 'string' ||
    !value.agent ||
    typeof value.workspace !== 'string' ||
    !isAbsolute(value.workspace) ||
    !['none', 'workspace'].includes(value.edits ?? '') ||
    !strings(value.protectedRoots) ||
    !value.protectedRoots.every(isAbsolute) ||
    !strings(value.hostTools) ||
    (value.approvals !== undefined && typeof value.approvals !== 'boolean')
  )
    throw new Error('Invalid recorded resident policy')
  return value as ResidentExtensionConfig
}

/** Only immutable node audit posture/admission records establish normal CLI bindings. */
export function rejudgeNode(options: {
  sessions: string
  auditFiles: readonly string[]
  node: string
}): RejudgeReport {
  const sessions = resolve(options.sessions)
  const initialAuditHashes = new Map(
    options.auditFiles.map(file => [
      realpathSync(file),
      createHash('sha256').update(readFileSync(file)).digest('hex'),
    ]),
  )
  const records = [
    ...new Map(
      options.auditFiles
        .flatMap(file => readTrail(file).records)
        .filter(
          r =>
            r.node === options.node &&
            r.source === 'resident' &&
            r.outcome === 'ok',
        )
        .map(r => [digestOf(r), r]),
    ).values(),
  ]
  const launches = records
    .filter(
      r =>
        r.kind === 'authz.posture' && typeof r.detail?.sessionId === 'string',
    )
    .sort((a, b) => a.at - b.at || a.seq - b.seq)
  const bindings: Binding[] = []
  const findings: Finding[] = []
  for (const launch of launches) {
    try {
      const d = launch.detail!
      if (
        typeof d.policy !== 'string' ||
        typeof d.configHash !== 'string' ||
        createHash('sha256').update(d.policy).digest('hex') !== d.configHash
      )
        throw new Error('Recorded policy hash mismatch')
      const config = configOf(d.policy)
      if (
        config.agent !== d.agent ||
        typeof d.sessionId !== 'string' ||
        !/^[A-Za-z0-9._-]+$/.test(d.sessionId) ||
        !/^[A-Za-z0-9_-]+$/.test(config.agent)
      )
        throw new Error('Invalid session/agent binding')
      if (
        d.approvalMode !==
        (config.edits === 'workspace' ? 'write' : 'always-ask')
      )
        throw new Error('Recorded mode disagrees with policy')
      const stateRoots: unknown = JSON.parse(String(d.stateRoots))
      if (
        !strings(stateRoots) ||
        !stateRoots.length ||
        !stateRoots.every(isAbsolute)
      )
        throw new Error('Recorded state roots missing')
      if (
        typeof d.home !== 'string' ||
        !isAbsolute(d.home) ||
        typeof d.configDir !== 'string' ||
        !isAbsolute(d.configDir) ||
        typeof d.qmcodeHome !== 'string' ||
        !isAbsolute(d.qmcodeHome)
      )
        throw new Error('Recorded path environment missing')
      const inputs: Record<string, { contextId: string; taskId?: string }> = {}
      for (const r of records.filter(
        r =>
          r.kind === 'authz.admission' &&
          r.detail?.sessionId === d.sessionId &&
          r.detail.agent === config.agent,
      )) {
        const detail = r.detail!
        if (
          typeof detail.messageId !== 'string' ||
          !detail.messageId ||
          typeof detail.contextId !== 'string' ||
          !detail.contextId
        )
          throw new Error('Malformed admission identity')
        const previous = inputs[detail.messageId]
        if (
          previous &&
          (previous.contextId !== detail.contextId ||
            previous.taskId !== r.taskId)
        )
          throw new Error('Conflicting admission identity')
        inputs[detail.messageId] = {
          contextId: detail.contextId,
          ...(r.taskId ? { taskId: r.taskId } : {}),
        }
      }
      const next = launches.find(
        r =>
          (r.at > launch.at || (r.at === launch.at && r.seq > launch.seq)) &&
          r.detail?.sessionId === d.sessionId &&
          r.detail.agent === config.agent,
      )
      bindings.push({
        directory: join(sessions, config.agent, d.sessionId),
        node: options.node,
        config,
        stateRoots,
        inputs,
        startsAt: launch.at,
        ...(next ? { endsAt: next.at } : {}),
        environment: {
          home: d.home,
          configDir: d.configDir,
          qmcodeHome: d.qmcodeHome,
        },
      })
    } catch (error) {
      findings.push({
        file: sessions,
        category: 'incomplete',
        reason: `Invalid immutable posture/admission seq=${launch.seq}: ${String(error)}`,
      })
    }
  }
  const report = rejudge({
    root: sessions,
    auditFiles: options.auditFiles,
    bindings,
  })
  for (const [file, sha256] of initialAuditHashes)
    if (
      !report.evidence.some(
        item => item.file === file && item.sha256 === sha256,
      )
    )
      findings.push({
        file,
        category: 'incomplete',
        reason: 'Audit changed while constructing launch bindings',
      })
  return {
    ...report,
    passed: report.passed && findings.length === 0,
    findings: [...findings, ...report.findings],
  }
}
