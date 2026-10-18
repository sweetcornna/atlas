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
#   atlas/scripts/test-shards.sh <path> …    only these shards; a path is a
#                                            directory or one *.test.ts(x) file
#   atlas/scripts/test-shards.sh --group <name>
#                                            one CI group (see CI_GROUPS below)
#   --exclude <path>                         leave the tests under <path> out of
#                                            every shard (repeatable); a shard that
#                                            contains <path> runs its other files
#   --list                                   print the shard paths, run nothing
#   --files                                  print every test file the shards
#                                            would run, run nothing
#   --list-groups                            print the CI group names
#
# One JUnit XML per shard lands in `test-reports/` (cleared first, so a shard
# that dies before writing cannot leave a stale report under its name).
# Exit status is 0 only if every shard passed; there is no early abort, so one
# red shard never hides the ones after it.

set +e
set -uo pipefail

cd "$(dirname "$0")/../.." || exit 2

REPORT_DIR=test-reports

DEFAULT_SHARDS=(atlas/packages/* atlas/tests/integration atlas/tests/boundary atlas/tests/support demo/lib demo/env atlas/scripts)

# CI groups: the `test` matrix in .github/workflows/atlas.yml runs one group per
# job. Together they are the default shards with every test file exactly once.
# `packages` takes each default shard no other group claims, so a new package or
# suite reaches CI without editing this list. testShards.test.ts checks the
# partition file by file; the CI summary job checks the JUnit reports against git.
CI_GROUPS="node-host node-rest ops e2e packages"
CLAIMED=" atlas/packages/node demo/env atlas/scripts atlas/tests/integration demo/lib "

usage() {
  echo "usage: test-shards.sh [--list | --files] [--group <name> | <path> …] [--exclude <path> …]" >&2
  echo "       test-shards.sh --list-groups" >&2
  exit 2
}

# `./a/b/` and `a/b` name the same shard.
norm() {
  local p="${1%/}"
  printf '%s' "${p#./}"
}

# True when path $1 is $2 or lies under it.
under() {
  [ "$1" = "$2" ] || [ "${1#"$2"/}" != "$1" ]
}

mode=run
group=""
shards=()
excludes=()
# Files a group runs as shards of their own: left out of any larger shard
# that contains them, the way an exclusion is, but still run.
apart=()
while [ $# -gt 0 ]; do
  case "$1" in
    --list | --files)
      [ "$mode" = run ] || usage
      mode="${1#--}"
      ;;
    --list-groups)
      printf '%s\n' $CI_GROUPS
      exit 0
      ;;
    --group)
      [ $# -ge 2 ] || usage
      group="$2"
      shift
      ;;
    --exclude)
      [ $# -ge 2 ] || usage
      excludes+=("$(norm "$2")")
      shift
      ;;
    -*) usage ;;
    *) shards+=("$1") ;;
  esac
  shift
done

if [ -n "$group" ]; then
  [ ${#shards[@]} -eq 0 ] || usage
  case "$group" in
    node-host) shards=(atlas/packages/node/test/host) ;;
    node-rest)
      # These four run as their own processes. On Linux, Bun 1.4.2 run after
      # them in the same process (then residentRootOverlap's run of openssl
      # spawnSync calls) stops reaping spawnSync children: the child is a
      # zombie, its pidfd is readable, and the main thread spins until the
      # 10 s test timeout (identityIsolation, residentRootOverlap). Bun 1.4.3
      # fixes it; drop this once .tool-versions moves past 1.4.2.
      apart=(
        atlas/packages/node/test/commands/residentModelCredential.isolated.test.ts
        atlas/packages/node/test/commands/residentModelProbe.test.ts
        atlas/packages/node/test/commands/residentModelProbeGate.test.ts
        atlas/packages/node/test/commands/residentProviderSignal.test.ts
      )
      shards=(atlas/packages/node "${apart[@]}")
      excludes+=(atlas/packages/node/test/host)
      ;;
    ops) shards=(demo/env atlas/scripts) ;;
    e2e) shards=(atlas/tests/integration demo/lib) ;;
    packages)
      for d in "${DEFAULT_SHARDS[@]}"; do
        case "$CLAIMED" in
          *" $d "*) ;;
          *) shards+=("$d") ;;
        esac
      done
      ;;
    *)
      echo "unknown group: ${group} (groups: ${CI_GROUPS})" >&2
      exit 2
      ;;
  esac
elif [ ${#shards[@]} -eq 0 ]; then
  shards=("${DEFAULT_SHARDS[@]}")
fi

# The test files one shard runs, sorted, minus the exclusions. A listing is
# never piped into a reader that can exit early: under pipefail,
# `find | grep -q .` dies with SIGPIPE (141) once find writes in more than one
# chunk (GNU find past ~4 KB), which read as "no tests" and silently dropped
# atlas/packages/node from every Linux run.
shard_files() {
  local listing f e keep
  if [ -f "$1" ]; then
    case "$1" in
      *.test.ts | *.test.tsx) listing="$1" ;;
      *) return 0 ;;
    esac
  else
    listing="$(find "$1" -path '*/node_modules' -prune -o \( -name '*.test.ts' -o -name '*.test.tsx' \) -print)"
  fi
  [ -n "$listing" ] || return 0
  while IFS= read -r f; do
    keep=1
    for e in ${excludes[@]+"${excludes[@]}"}; do
      if under "$f" "$e"; then
        keep=0
        break
      fi
    done
    for e in ${apart[@]+"${apart[@]}"}; do
      if [ "$1" != "$e" ] && [ "$f" = "$e" ]; then
        keep=0
        break
      fi
    done
    if [ "$keep" -eq 1 ]; then
      printf '%s\n' "$f"
    fi
  done <<<"$(LC_ALL=C sort <<<"$listing")"
}

if [ "$mode" = run ]; then
  rm -rf "$REPORT_DIR" && mkdir -p "$REPORT_DIR"
fi

count=0
failed=()

for d in ${shards[@]+"${shards[@]}"}; do
  d="$(norm "$d")"
  [ -d "$d" ] || [ -f "$d" ] || continue
  files="$(shard_files "$d")"
  # A shard without tests is not a shard; `bun test` would call "no files
  # matched" a failure.
  [ -n "$files" ] || continue

  case "$mode" in
    list)
      echo "$d"
      continue
      ;;
    files)
      printf '%s\n' "$files"
      continue
      ;;
  esac

  # The whole directory, unless an exclusion cuts into it: then the files that
  # remain, by name, still in one process.
  targets=("./$d")
  cut=()
  for e in ${excludes[@]+"${excludes[@]}"}; do
    if under "$e" "$d"; then
      cut+=("$e")
    fi
  done
  for e in ${apart[@]+"${apart[@]}"}; do
    if [ "$e" != "$d" ] && under "$e" "$d"; then
      cut+=("$e")
    fi
  done
  if [ ${#cut[@]} -ne 0 ]; then
    targets=()
    while IFS= read -r f; do
      targets+=("./$f")
    done <<<"$files"
  fi

  count=$((count + 1))
  if [ ${#cut[@]} -ne 0 ]; then
    echo "──── shard ${count}: ${d} (without ${cut[*]})"
  else
    echo "──── shard ${count}: ${d}"
  fi
  report="${REPORT_DIR}/$(printf 'shard-%02d' "$count")-${d//\//-}.xml"

  bun test --preload ./atlas/tests/preload.ts --timeout 10000 --isolate \
    --reporter=junit --reporter-outfile "$report" "${targets[@]}" 2>&1 \
    | grep -vE '^\s*(\(pass\)|\(skip\))' | cat -s
  # The pipeline's own status is grep's; the shard's verdict is bun's.
  if [ "${PIPESTATUS[0]}" -ne 0 ]; then
    failed+=("$d")
    echo "::error title=Test shard failed::${d}"
  fi
done

if [ "$mode" != run ]; then
  exit 0
fi

if [ "$count" -eq 0 ]; then
  echo "──── no shards found" >&2
  exit 1
fi

if [ ${#failed[@]} -ne 0 ]; then
  echo "──── ${#failed[@]} of ${count} shards failed: ${failed[*]}"
  exit 1
fi

echo "──── all ${count} shards passed"
