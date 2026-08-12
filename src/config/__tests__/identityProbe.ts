/**
 * Out-of-process identity probe for identityIsolation.test.ts.
 *
 * Identity is fixed at module load (see src/constants/identity.ts), so the only
 * honest way to observe a NON-default identity is a fresh process with a
 * different `OCC_IDENTITY`. This tiny script is that process: it imports the
 * real derivation modules and reports/acts on whatever identity it booted with.
 * Relative imports (not the `src/*` alias) so it runs identically under
 * `bun run <path>` regardless of tsconfig-path handling.
 *
 * Subcommands (argv[2]):
 *   report              → print the resolved identity surface as JSON
 *   write-cred <text>   → create occConfigDir() and write <text> to its
 *                         .credentials.json, then print the absolute path
 *   read-cred           → print the content of occConfigDir()/.credentials.json,
 *                         or the sentinel "__MISSING__" if it does not exist
 *   protection <root>   → print the write-protection surface as JSON: the
 *                         protected config roots for <root>, plus the
 *                         dangerous-directory and dangerous-file lists
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { BIN_NAME } from '../../constants/brand.js'
import { IDENTITY_MODE } from '../../constants/identity.js'
import {
  CACHE_NAMESPACE,
  getProtectedConfigDirectories,
  occConfigDir,
  occGlobalConfigFile,
  PROJECT_DIR_NAME,
  XDG_SUBDIR,
} from '../paths.js'

const command = process.argv[2] ?? 'report'
const credPath = (): string => join(occConfigDir(), '.credentials.json')

if (command === 'report') {
  process.stdout.write(
    JSON.stringify({
      identity: IDENTITY_MODE,
      binName: BIN_NAME,
      configDir: occConfigDir(),
      globalFile: occGlobalConfigFile(),
      cacheNamespace: CACHE_NAMESPACE,
      xdgSubdir: XDG_SUBDIR,
      projectDirName: PROJECT_DIR_NAME,
    }),
  )
} else if (command === 'write-cred') {
  const text = process.argv[3] ?? ''
  mkdirSync(occConfigDir(), { recursive: true })
  writeFileSync(credPath(), text, 'utf8')
  process.stdout.write(credPath())
} else if (command === 'read-cred') {
  const path = credPath()
  process.stdout.write(
    existsSync(path) ? readFileSync(path, 'utf8') : '__MISSING__',
  )
} else if (command === 'protection') {
  // Imported lazily: src/utils/permissions/filesystem.ts pulls the whole
  // permission/settings/analytics graph, and the credential cases spawn the
  // cheap subcommands above four times per test.
  const { DANGEROUS_DIRECTORIES, DANGEROUS_FILES } = await import(
    '../../utils/permissions/filesystem.js'
  )
  const projectRoot = process.argv[3] ?? '/proj'
  process.stdout.write(
    JSON.stringify({
      identity: IDENTITY_MODE,
      protectedDirs: getProtectedConfigDirectories([projectRoot]),
      dangerousDirs: [...DANGEROUS_DIRECTORIES],
      dangerousFiles: [...DANGEROUS_FILES],
    }),
  )
} else {
  process.stderr.write(`unknown probe command: ${command}`)
  process.exit(2)
}
