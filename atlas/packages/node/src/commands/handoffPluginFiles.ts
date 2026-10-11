// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import file0 from '../../../../plugins/qianmo/.claude-plugin/plugin.json' with {
  type: 'json',
}
import file1 from '../../../../plugins/qianmo/.codex-plugin/plugin.json' with {
  type: 'json',
}
import file2 from '../../../../plugins/qianmo/plugin.json' with { type: 'json' }
import file3 from '../../../../plugins/qianmo/.mcp.json' with { type: 'json' }
import file4 from '../../../../plugins/qianmo/mcp.json' with { type: 'json' }
import file5 from '../../../../plugins/qianmo/hooks/hooks.json' with {
  type: 'json',
}
import file6 from '../../../../plugins/qianmo/commands/handoff.md' with {
  type: 'text',
}
import file7 from '../../../../plugins/qianmo/commands/pull.md' with {
  type: 'text',
}
import file8 from '../../../../plugins/qianmo/commands/status.md' with {
  type: 'text',
}
import file9 from '../../../../plugins/qianmo/commands/login.md' with {
  type: 'text',
}
import file10 from '../../../../plugins/qianmo/skills/qianmo-handoff/SKILL.md' with {
  type: 'text',
}
import file11 from '../../../../plugins/qianmo/README.md' with { type: 'text' }

export const HANDOFF_PLUGIN_FILES: Readonly<Record<string, string>> = {
  '.claude-plugin/plugin.json': `${JSON.stringify(file0, null, 2)}\n`,
  '.codex-plugin/plugin.json': `${JSON.stringify(file1, null, 2)}\n`,
  'plugin.json': `${JSON.stringify(file2, null, 2)}\n`,
  '.mcp.json': `${JSON.stringify(file3, null, 2)}\n`,
  'mcp.json': `${JSON.stringify(file4, null, 2)}\n`,
  'hooks/hooks.json': `${JSON.stringify(file5, null, 2)}\n`,
  'commands/handoff.md': file6,
  'commands/pull.md': file7,
  'commands/status.md': file8,
  'commands/login.md': file9,
  'skills/qianmo-handoff/SKILL.md': file10,
  'README.md': file11,
}
