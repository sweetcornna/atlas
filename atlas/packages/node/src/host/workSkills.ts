// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The six work workflows (`work-tasks.md` §2.4): skill files compiled into
 * `qm` as text, laid out under the node's config root at start, and handed
 * to every qianmopi child with `--plugin-dir`. The folder is under the
 * protected config root, so it is also listed as a readable root — the
 * agent reads `skill://qmo-slides/reference.md` from there.
 */

import * as path from 'node:path'
import { workSkillsDir } from '@qianmo/paths'
import { readTextIfExists, writePrivateFileAtomic } from '../providers/store.js'
import type { AgentExtensions, AgentExtensionsSource } from './extensions.js'
import plugin from '../../../../plugins/qmo-work/plugin.json' with {
  type: 'json',
}
import slides from '../../../../plugins/qmo-work/skills/qmo-slides/SKILL.md' with {
  type: 'text',
}
import slidesReference from '../../../../plugins/qmo-work/skills/qmo-slides/reference.md' with {
  type: 'text',
}
import document from '../../../../plugins/qmo-work/skills/qmo-document/SKILL.md' with {
  type: 'text',
}
import documentReference from '../../../../plugins/qmo-work/skills/qmo-document/reference.md' with {
  type: 'text',
}
import sheet from '../../../../plugins/qmo-work/skills/qmo-sheet/SKILL.md' with {
  type: 'text',
}
import sheetReference from '../../../../plugins/qmo-work/skills/qmo-sheet/reference.md' with {
  type: 'text',
}
import research from '../../../../plugins/qmo-work/skills/qmo-research/SKILL.md' with {
  type: 'text',
}
import webpage from '../../../../plugins/qmo-work/skills/qmo-webpage/SKILL.md' with {
  type: 'text',
}
import analysis from '../../../../plugins/qmo-work/skills/qmo-analysis/SKILL.md' with {
  type: 'text',
}

export const WORK_SKILL_FILES: Readonly<Record<string, string>> = {
  'plugin.json': `${JSON.stringify(plugin, null, 2)}\n`,
  'skills/qmo-slides/SKILL.md': slides,
  'skills/qmo-slides/reference.md': slidesReference,
  'skills/qmo-document/SKILL.md': document,
  'skills/qmo-document/reference.md': documentReference,
  'skills/qmo-sheet/SKILL.md': sheet,
  'skills/qmo-sheet/reference.md': sheetReference,
  'skills/qmo-research/SKILL.md': research,
  'skills/qmo-webpage/SKILL.md': webpage,
  'skills/qmo-analysis/SKILL.md': analysis,
}

/**
 * Write the skill files where qianmopi will find them, leaving a file that
 * already says the same thing alone. Returns the plugin folder.
 */
export function layOutWorkSkills(directory = workSkillsDir()): string {
  for (const [relative, text] of Object.entries(WORK_SKILL_FILES)) {
    const target = path.join(directory, relative)
    if (readTextIfExists(target) !== text) writePrivateFileAtomic(target, text)
  }
  return directory
}

/** An agent's extension set with the work skills added (qianmopi only). */
export function withWorkSkills(
  source: AgentExtensionsSource,
  directory: string,
): AgentExtensionsSource {
  return agent => {
    const set: AgentExtensions = source(agent) ?? {
      ompPluginDirs: [],
      claudePluginDirs: [],
      mcp: [],
      readableRoots: [],
    }
    return {
      ...set,
      ompPluginDirs: [directory, ...set.ompPluginDirs],
      readableRoots: [directory, ...set.readableRoots],
    }
  }
}
