// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as path from 'node:path'
// Like build-qm's compileCodingAgent, this is a pinned build helper, never a
// runtime import into qm. The reused executors reach the legacy registry.
import { createLegacyPiVirtualModulePlugin } from '../../packages/coding-agent/scripts/legacy-pi-virtual-module.ts'

export async function residentExtensionSource(): Promise<string> {
  const result = await Bun.build({
    entrypoints: [
      path.join(import.meta.dir, '../packages/extension/src/index.ts'),
    ],
    target: 'bun',
    format: 'esm',
    packages: 'bundle',
    splitting: false,
    plugins: [await createLegacyPiVirtualModulePlugin()],
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
  return bootstrap + source
}
