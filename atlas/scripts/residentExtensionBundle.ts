// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as path from 'node:path'
// Build helper only: the binary's legacy loader serves these exact keys.
import { collectBundledPiEntries } from '../../packages/coding-agent/scripts/legacy-pi-virtual-module.ts'
import { assertResidentExtensionBudget } from './residentExtensionBudget.js'

const HOST_MODULES = [
  '@oh-my-pi/pi-coding-agent/config/settings',
  '@oh-my-pi/pi-coding-agent/tools/browser',
  '@oh-my-pi/pi-coding-agent/tools/computer',
]

export async function residentExtensionSource(): Promise<string> {
  const hostKeys = new Set(
    (await collectBundledPiEntries()).map(entry => entry.key),
  )
  for (const key of HOST_MODULES)
    if (!hostKeys.has(key))
      throw new Error(
        `Resident extension host module is not registered: ${key}`,
      )
  const result = await Bun.build({
    entrypoints: [
      path.join(import.meta.dir, '../packages/extension/src/index.ts'),
    ],
    target: 'bun',
    format: 'esm',
    packages: 'bundle',
    // Keep canonical imports for the host's legacy mapping. worker-host is
    // absent from that registry and stays bundled; type-only imports disappear.
    external: HOST_MODULES,
    splitting: false,
  })
  const entries = result.outputs.filter(output => output.kind === 'entry-point')
  if (!result.success || entries.length !== 1)
    throw new Error('Could not bundle the required resident extension')
  let source = await entries[0]!.text()
  const assets: [string, string][] = []
  for (const asset of result.outputs.filter(
    output => output.kind === 'asset',
  )) {
    const name = path.basename(asset.path)
    assets.push([name, new Uint8Array(await asset.arrayBuffer()).toBase64()])
    source = source
      .split(JSON.stringify(asset.path))
      .join(`__qmAssetPath.join(import.meta.dir, ${JSON.stringify(name)})`)
  }
  // Keep the fleet's one-file extension contract. File-loader assets are
  // embedded and integrity-checked before any executor can reference them.
  const bootstrap = `import * as __qmAssetFs from 'node:fs';
import * as __qmAssetPath from 'node:path';
for (const [name, data] of ${JSON.stringify(assets)}) {
  const dest = __qmAssetPath.join(import.meta.dir, name);
  const bytes = Buffer.from(data, 'base64');
  let fd;
  try { fd = __qmAssetFs.openSync(dest, 'wx', 0o600); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  if (fd !== undefined) {
    try { __qmAssetFs.writeFileSync(fd, bytes); __qmAssetFs.fsyncSync(fd); }
    finally { __qmAssetFs.closeSync(fd); }
  } else {
    const existing = __qmAssetFs.openSync(dest, __qmAssetFs.constants.O_RDONLY | __qmAssetFs.constants.O_NOFOLLOW);
    try { if (!__qmAssetFs.readFileSync(existing).equals(bytes)) throw new Error('Resident embedded asset differs from this binary'); }
    finally { __qmAssetFs.closeSync(existing); }
  }
}
`
  const bundled = bootstrap + source
  assertResidentExtensionBudget(bundled)
  return bundled
}
