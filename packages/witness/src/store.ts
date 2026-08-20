// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: MIT

/** The host-side, append-only filesystem store for witness anchors. */

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isValidSegment } from '@qianmo/protocol'
import { isWitnessAnchor, type WitnessAnchor } from './anchor.js'

function anchorDirectory(root: string, node: string): string {
  return join(root, node)
}

function anchorPath(root: string, node: string, seq: number): string {
  return join(anchorDirectory(root, node), `${String(seq)}.json`)
}

/** An existing `(node, seq)` is evidence, not a slot that can be replaced. */
export class WitnessAnchorExistsError extends Error {
  constructor(node: string, seq: number) {
    super(`witness anchor already exists for ${node} at seq ${seq}`)
    this.name = 'WitnessAnchorExistsError'
  }
}

export interface FileWitnessAnchorStoreOptions {
  /** Directory owned by the host-side witness endpoint. */
  readonly root: string
}

/**
 * Stores exactly one anchor for each `(node, seq)`, created with `wx`.
 *
 * There is intentionally no update or removal method. Retention, when it is
 * needed, is an operator-run action outside the inbound witness surface.
 */
export class FileWitnessAnchorStore {
  readonly root: string

  constructor(options: FileWitnessAnchorStoreOptions) {
    if (options.root.trim() === '') {
      throw new Error('witness store root must not be empty')
    }
    this.root = options.root
  }

  async create(anchor: WitnessAnchor): Promise<void> {
    if (!isWitnessAnchor(anchor)) {
      throw new Error('refusing an invalid witness anchor')
    }
    const directory = anchorDirectory(this.root, anchor.node)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    try {
      await writeFile(
        anchorPath(this.root, anchor.node, anchor.seq),
        `${JSON.stringify(anchor)}\n`,
        { encoding: 'utf8', flag: 'wx', mode: 0o600 },
      )
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new WitnessAnchorExistsError(anchor.node, anchor.seq)
      }
      throw error
    }
  }

  async list(node: string): Promise<readonly WitnessAnchor[]> {
    if (!isValidSegment(node)) return []
    let names: string[]
    try {
      names = await readdir(anchorDirectory(this.root, node))
    } catch {
      return []
    }
    const anchors: WitnessAnchor[] = []
    for (const name of names.sort((a, b) => Number(a) - Number(b))) {
      if (!name.endsWith('.json')) continue
      try {
        const parsed: unknown = JSON.parse(
          await readFile(join(anchorDirectory(this.root, node), name), 'utf8'),
        )
        if (isWitnessAnchor(parsed) && parsed.node === node) {
          anchors.push(parsed)
        }
      } catch {
        // One torn or hand-edited object must not hide older evidence.
      }
    }
    return anchors.sort((a, b) => a.seq - b.seq || a.at - b.at)
  }
}
