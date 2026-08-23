#!/usr/bin/env bash
#
# Run the whole unit suite one top-level directory at a time.
#
# Bun runs every test file of an invocation in ONE process, and `mock.module`
# is process-global and last-write-wins. Sharding per directory hard-isolates
# cross-directory mock state: a file's mocks can only reach its own directory.
# That is the difference that ended the 55 consecutive red CI runs between
# v2.11.0 and v2.30.0 — not any single test fix.
#
# Which means an UNSHARDED `bun test` is a different execution mode, not a
# stricter version of this one. It has never been proven on a Linux runner, so
# neither CI nor the publish gate uses it.
#
# Lives in a script rather than inline in the workflow so the sharding loop has
# a single home; a copy inlined in ci.yml would drift, and the failure it
# protects against is invisible on macOS.
#
# Usage:
#   scripts/test-shards.sh              # plain run
#   scripts/test-shards.sh --coverage   # per-shard lcov, concatenated
#
# Exit status is 0 only if EVERY directory passed standalone.

# `set +e` is required, not merely omitting `-e`: GitHub Actions invokes `run:`
# steps as `bash -e {0}`, so errexit is already on when this script is sourced
# into that context.
set +e
set -uo pipefail

coverage=0
if [ "${1:-}" = "--coverage" ]; then
  coverage=1
  rm -rf coverage && mkdir -p coverage
fi

shard=0
failed=()

# `tests/boundary` and `demo/lib` are listed explicitly for the same reason
# every other entry is: this loop is the whole of what CI runs, and a test
# directory that is not on it does not run there at all — while `bun test`
# locally does run it. That combination produces "green locally, green in CI"
# where the second green means nothing. P5.4 added the boundary suite; the demo
# report cores had been outside CI since P4.1 and are folded in here.
#
# `demo/env` is the same hole one directory over, and the sharpest case for the
# rule: those suites drive the real operator shell scripts through /bin/bash, so
# what they prove is precisely what differs between a developer's macOS box and
# the Linux runner — bash 3.2 vs 5.x, BSD vs GNU userland, which locales the
# machine even has. The regression for the issue #17 locale bypass (a `[a-z]`
# glob range that collation expands to aAbB…zZ, so `Beta-1` passed node-name
# validation) lived there and had only ever run on macOS, which for a
# locale-dependent defect is the worst possible arrangement.
#
# It is one literal entry rather than `demo/env/*`: tests sit both directly in
# it (resident-task-policy) and two levels down (beta/, beta/ops/), and
# `bun test <dir>` already recurses. The glob would shard the subdirectories and
# silently drop the top-level file — exactly the miss this list exists to stop.
for d in src/* packages/* tests/integration tests/boundary demo/lib demo/env scripts; do
  [ -d "$d" ] || continue
  # Skip directories with no tests at all rather than letting `bun test` treat
  # "no files matched" as a failure.
  if ! find "$d" \( -name '*.test.ts' -o -name '*.test.tsx' \) -print -quit | grep -q .; then
    continue
  fi

  shard=$((shard + 1))
  echo "──── shard ${shard}: ${d}"

  # Qianmo's own packages opt into --isolate (each test file gets a fresh
  # global): it turns cross-file mock/env cleanliness into a structural
  # guarantee instead of something the mock-hygiene ratchet has to police.
  # Measured zero overhead on these (5 files). Base shards stay sharding-only —
  # that mode is proven on Linux, and flipping 700 base files to --isolate off a
  # single local run is unmeasured risk for no gain (and needless base drift).
  isolate=""
  if [ -f "$d/package.json" ] && grep -q '"name"[[:space:]]*:[[:space:]]*"@qianmo/' "$d/package.json"; then
    isolate="--isolate"
  fi

  if [ "$coverage" = "1" ]; then
    bun test $isolate --coverage --coverage-reporter lcov \
      --coverage-dir "coverage/shard-${shard}" "$d" 2>&1 \
      | grep -vE '^\s*(\(pass\)|\(skip\))' | sed '/^.*\/__tests__\/.*:$/d' | cat -s
  else
    bun test $isolate "$d" 2>&1 \
      | grep -vE '^\s*(\(pass\)|\(skip\))' | sed '/^.*\/__tests__\/.*:$/d' | cat -s
  fi

  # PIPESTATUS[0], not $? — the pipeline's status is grep/sed/cat's, and
  # `grep -v` exits 1 whenever it filters out every line.
  if [ "${PIPESTATUS[0]}" -ne 0 ]; then
    failed+=("$d")
    echo "::error title=Test shard failed::${d}"
  fi

  # Tiny shards can produce no lcov at all — the artifact just needs the union
  # of what was measured, not a file per shard.
  if [ "$coverage" = "1" ] && [ -f "coverage/shard-${shard}/lcov.info" ]; then
    cat "coverage/shard-${shard}/lcov.info" >> coverage/lcov.info
  fi
done

# Deliberately no early abort: stopping at the first red shard hides every
# shard after it. That is not hypothetical — one poisoned mock in src/utils
# (shard 22 of 34) meant src/workflow, all of packages/*, tests/integration and
# scripts had never once been exercised on CI.
if [ ${#failed[@]} -ne 0 ]; then
  echo "──── ${#failed[@]} of ${shard} shards failed: ${failed[*]}"
  exit 1
fi

echo "──── all ${shard} shards passed"
