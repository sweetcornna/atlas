// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { qianmoConfigPath } from '@qianmo/paths'

export function defaultSandboxAuditPath(): string {
  return qianmoConfigPath('sandbox', 'audit.ndjson')
}
