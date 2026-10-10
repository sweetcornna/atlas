#!/usr/bin/env bash
# Copyright 2026 Qianmo AgentNest Team
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# The atlas test suite, one `bun test` process per shard (base-switch-omp.md §6).
#
# Shards: every atlas workspace package (`atlas/packages/*`), then the
# cross-package suites (`atlas/tests/*`), the demo report cores and drivers
# (`demo/lib`), the demo operator scripts (`demo/env`) and the gate scripts
# (`atlas/scripts`). Each shard runs with `--isolate` (a fresh global per test
# file), so a module mock or env mutation in one file cannot reach another, and
# a separate process per shard keeps `mock.module` from leaking across them.
#
# Every shard is preloaded with `atlas/tests/preload.ts` (credential isolation,
# temp QIANMO_CONFIG_DIR). The preload is passed on the command line, never set
# in the root bunfig.toml: omp's own suites run from the same root and must not
# see it. Paths are passed as `./<dir>` so Bun treats them as paths, not as
# substring filters that could pull in an omp test.
#
# Usage (from anywhere; runs at the repo root):
#   atlas/scripts/test-shards.sh             all shards
#   atlas/scripts/test-shards.sh <dir> …     only these shard directories
#
# One JUnit XML per shard lands in `test-reports/` (cleared first, so a shard
# that dies before writing cannot leave a stale report under its name).
# Exit status is 0 only if every shard passed; there is no early abort, so one
# red shard never hides the ones after it.

set +e
set -uo pipefail

cd "$(dirname "$0")/../.." || exit 2

REPORT_DIR=test-reports
rm -rf "$REPORT_DIR" && mkdir -p "$REPORT_DIR"

if [ $# -gt 0 ]; then
  shards=("$@")
else
  shards=(atlas/packages/* atlas/tests/integration atlas/tests/boundary atlas/tests/support demo/lib demo/env atlas/scripts)
fi

count=0
failed=()

for d in "${shards[@]}"; do
  d="${d%/}"
  [ -d "$d" ] || continue
  # A directory without tests is not a shard; `bun test` would call "no files
  # matched" a failure.
  if ! find "$d" -path '*/node_modules' -prune -o \( -name '*.test.ts' -o -name '*.test.tsx' \) -print | grep -q .; then
    continue
  fi

  count=$((count + 1))
  echo "──── shard ${count}: ${d}"
  report="${REPORT_DIR}/$(printf 'shard-%02d' "$count")-${d//\//-}.xml"

  bun test --preload ./atlas/tests/preload.ts --timeout 10000 --isolate \
    --reporter=junit --reporter-outfile "$report" "./$d" 2>&1 \
    | grep -vE '^\s*(\(pass\)|\(skip\))' | cat -s
  # The pipeline's own status is grep's; the shard's verdict is bun's.
  if [ "${PIPESTATUS[0]}" -ne 0 ]; then
    failed+=("$d")
    echo "::error title=Test shard failed::${d}"
  fi
done

if [ "$count" -eq 0 ]; then
  echo "──── no shards found" >&2
  exit 1
fi

if [ ${#failed[@]} -ne 0 ]; then
  echo "──── ${#failed[@]} of ${count} shards failed: ${failed[*]}"
  exit 1
fi

echo "──── all ${count} shards passed"
