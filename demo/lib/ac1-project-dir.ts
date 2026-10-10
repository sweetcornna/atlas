// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later
import { qianmoConfigPath } from '@qianmo/paths'
if (!process.env.QIANMO_CONFIG_DIR)
  throw new Error('AC-1 requires an isolated QIANMO_CONFIG_DIR')
process.stdout.write(qianmoConfigPath('acceptance', 'ac1', 'sessions'))
