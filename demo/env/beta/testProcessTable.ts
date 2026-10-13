// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

function assertTemporary(file: string): void {
  const temporary = fs.realpathSync(os.tmpdir()) + path.sep
  if (!fs.realpathSync(path.dirname(file)).startsWith(temporary))
    throw new Error(
      `Process fixtures must stay in the test temporary tree: ${file}`,
    )
}

/**
 * A synthetic procfs for macOS integration tests. Only copied common.sh files in
 * temporary repositories are patched; production has no flag, import or hook to
 * enable this provider. Linux callers leave their copies untouched and use /proc.
 *
 * argv/config come from known test launches, never from ps text. The real parser,
 * identity matching, stop logic, signals, listeners and readiness checks still run.
 * These synthetic start/parent fields are test data, not macOS identity evidence.
 * PID reuse/ancestry races are covered by beta-node-identity.test.ts on both OSes.
 */
export class TestProcessTable {
  readonly directory: string
  readonly #launcher: string

  constructor(temporaryDirectory: string) {
    this.directory = path.join(temporaryDirectory, 'test-proc')
    this.#launcher = path.join(this.directory, 'launch.sh')
    assertTemporary(path.join(temporaryDirectory, 'fixture'))
    fs.mkdirSync(this.directory, { recursive: true })
    fs.writeFileSync(
      this.#launcher,
      `# Test-only exec wrapper: preserve the background PID and record NUL boundaries.
set -euo pipefail
table=${shellQuote(this.directory)}
exe="$1"
shift
dir="$table/$$"
mkdir -p "$dir"
ln -s "$exe" "$dir/exe"
printf '%s\\0' "$@" >"$dir/cmdline"
printf 'QIANMO_CONFIG_DIR=%s\\0' "\${QIANMO_CONFIG_DIR:-}" >"$dir/environ"
printf 'Uid:\\t%s\\t%s\\t%s\\t%s\\n' "$EUID" "$EUID" "$EUID" "$EUID" >"$dir/status"
{
  printf '%s (test launch) S %s' "$$" "$PPID"
  for ((i=0; i<17; i++)); do printf ' 0'; done
  printf ' %s\\n' "$RANDOM$RANDOM$RANDOM"
} >"$dir/stat"
exec "$@"
`,
    )
  }

  /** Install only in a temp copy; no environment variable selects this provider. */
  install(commonCopy: string): void {
    if (
      fs.realpathSync(commonCopy) ===
      fs.realpathSync(path.join(import.meta.dir, 'common.sh'))
    )
      throw new Error('Process fixtures require a temporary common.sh copy')
    assertTemporary(commonCopy)
    if (fs.lstatSync(commonCopy).isSymbolicLink())
      throw new Error(
        `Process fixtures require a regular common.sh copy: ${commonCopy}`,
      )
    fs.appendFileSync(
      commonCopy,
      `
# Test-only process provider, appended by testProcessTable.ts to a temporary copy.
beta_proc_dir() {
  kill -0 "$1" 2>/dev/null || return 1
  printf '%s/%s\\n' ${shellQuote(this.directory)} "$1"
}
beta_proc_dirs() { printf '%s\\n' ${shellQuote(this.directory)}/[0123456789]*; }
# Register the known test shell for the real parser's pre-launch capability probe.
# Its live entry also keeps enumeration nonempty after all launched processes exit.
beta_test_shell_dir=${shellQuote(this.directory)}/$$
mkdir -p "$beta_test_shell_dir"
ln -sf "$BASH" "$beta_test_shell_dir/exe"
printf '%s\\0' "$BASH" >"$beta_test_shell_dir/cmdline"
printf 'QIANMO_CONFIG_DIR=%s\\0' "\${QIANMO_CONFIG_DIR:-}" >"$beta_test_shell_dir/environ"
printf 'Uid:\\t%s\\t%s\\t%s\\t%s\\n' "$EUID" "$EUID" "$EUID" "$EUID" >"$beta_test_shell_dir/status"
{
  printf '%s (test shell) S %s' "$$" "$PPID"
  for ((beta_test_i=0; beta_test_i<17; beta_test_i++)); do printf ' 0'; done
  printf ' %s\\n' "$RANDOM$RANDOM$RANDOM"
} >"$beta_test_shell_dir/stat"
unset beta_test_shell_dir beta_test_i
# This function runs in beta_start_process's background subshell. exec preserves $!.
nohup() {
  local exe header
  exe="$(beta_realpath "$(command -v "$1")")" || return 1
  if [ "$(head -c 2 "$exe")" = '#!' ]; then
    IFS= read -r header <"$exe"
    [ "$header" = '#!/usr/bin/env bun' ] || return 1
    set -- ${shellQuote(process.execPath)} "$@"
    exe=${shellQuote(fs.realpathSync(process.execPath))}
  fi
  exec /usr/bin/nohup /bin/bash ${shellQuote(this.#launcher)} "$exe" "$@"
}
`,
    )
  }

  /** Register a detached process whose argv/env are independently known by its test. */
  record(pid: number, argv: readonly string[], config = '', parent = 1): void {
    const directory = path.join(this.directory, String(pid))
    fs.mkdirSync(directory, { recursive: true })
    fs.symlinkSync(
      fs.realpathSync(argv[0] as string),
      path.join(directory, 'exe'),
    )
    fs.writeFileSync(path.join(directory, 'cmdline'), argv.join('\0') + '\0')
    fs.writeFileSync(
      path.join(directory, 'environ'),
      `QIANMO_CONFIG_DIR=${config}\0`,
    )
    const uid = process.geteuid?.()
    fs.writeFileSync(
      path.join(directory, 'status'),
      `Uid:\t${uid}\t${uid}\t${uid}\t${uid}\n`,
    )
    fs.writeFileSync(
      path.join(directory, 'stat'),
      `${pid} (test detached) S ${parent} ${Array(17).fill('0').join(' ')} ${Date.now()}\n`,
    )
  }
}
