#!/usr/bin/env bash
# Copyright 2026 Qianmo AgentNest Team
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# The atlas suite on this machine the way CI runs it (`bun run atlas:test`):
# the CI groups of test-shards.sh (`--list-groups`) side by side, each with its
# own log and report directory, then CI's anti-skip check
# (check-test-files-ran.ts) over every report.
#
# Usage (from anywhere; runs at the repo root):
#   atlas/scripts/test-groups.sh              every CI group
#   atlas/scripts/test-groups.sh --precheck   the groups plus typecheck,
#                                             identity-paths and license-headers
#                                             (`bun run precheck`, after lint:fix)
#   atlas/scripts/test-groups.sh <args> …     anything else is test-shards.sh's,
#                                             run as before: one shard after
#                                             another, no lock, no check
#
# Environment:
#   ATLAS_TEST_JOBS   tasks at once (default: all of them). 1 runs them one
#                     after another: the checks first, then the groups in
#                     `--list-groups` order.
#   ATLAS_TEST_HEAVY  the heavy test sets (atlas/tests/support/heavy.ts). Unset:
#                     `heavy-tests.ts --local` picks them from this checkout's
#                     changes since origin/main, uncommitted ones included.
#
# Output: test-reports/<group>/shard-*.xml and test-reports/<task>.log, the
# directory cleared first. A finished task prints one line; a red one also
# prints its `::error` lines and the last 40 lines of its log. No early abort,
# as in CI. Exit status is 0 only if every task and the check passed.
#
# One run per machine: the suite's timing-sensitive tests go red when several
# checkouts run theirs at once (three parallel prechecks on 2026-10-18, load
# average up to 21). The lock is a directory, ${TMPDIR:-/tmp}/
# atlas-test-groups.lock.d, holding the owner's pid and checkout; a second run
# says whom it waits for and queues. A lock whose pid is gone is taken over.

set +e
set -uo pipefail

cd "$(dirname "$0")/../.." || exit 2

precheck=0
if [ $# -eq 1 ] && [ "$1" = --precheck ]; then
  precheck=1
elif [ $# -gt 0 ]; then
  exec bash atlas/scripts/test-shards.sh "$@"
fi

jobs="${ATLAS_TEST_JOBS:-0}"
case "$jobs" in
  '' | *[!0-9]*)
    echo "ATLAS_TEST_JOBS must be a whole number, got: ${jobs}" >&2
    exit 2
    ;;
esac

REPORTS=test-reports
LOCK="${TMPDIR:-/tmp}"
LOCK="${LOCK%/}/atlas-test-groups.lock.d"

tasks=()
if [ "$precheck" -eq 1 ]; then
  tasks=(typecheck identity-paths license-headers)
fi
groups="$(bash atlas/scripts/test-shards.sh --list-groups)" || exit 2
for g in $groups; do
  tasks+=("$g")
done
total=${#tasks[@]}

owned=0
release() {
  if [ "$owned" -eq 1 ]; then
    rm -f "$LOCK/owner"
    rmdir "$LOCK" 2>/dev/null
    owned=0
  fi
}

acquire() {
  local said=0 owner pid
  while ! mkdir "$LOCK" 2>/dev/null; do
    owner="$(cat "$LOCK/owner" 2>/dev/null)"
    pid="${owner%% *}"
    # No owner yet: the other run is between mkdir and writing it.
    if [ -n "$pid" ] && ! kill -0 "$pid" 2>/dev/null; then
      echo "──── taking over the test lock of pid ${pid}, which is gone"
      rm -f "$LOCK/owner"
      rmdir "$LOCK" 2>/dev/null
      continue
    fi
    if [ "$said" -eq 0 ]; then
      echo "──── waiting for another test run to finish (pid ${pid:-?}, ${owner#* }); lock ${LOCK}"
      said=1
    fi
    sleep 1
  done
  echo "$$ $PWD" >"$LOCK/owner"
  owned=1
}

# Every process under $1, parents before children. Listed before anything is
# killed: a killed parent's children move to init and drop out of `pgrep -P`.
descendants() {
  local child
  for child in $(pgrep -P "$1"); do
    echo "$child"
    descendants "$child"
  done
}

pids=()
stop() {
  local i tree
  for i in "${!pids[@]}"; do
    [ -n "${pids[$i]}" ] || continue
    tree="${pids[$i]} $(descendants "${pids[$i]}")"
    # shellcheck disable=SC2086 # a list of pids, split on purpose
    kill -TERM $tree 2>/dev/null
  done
  release
}
trap 'stop; exit 130' INT
trap 'stop; exit 143' TERM
trap release EXIT

acquire

if [ -z "${ATLAS_TEST_HEAVY+set}" ]; then
  ATLAS_TEST_HEAVY="$(bun atlas/scripts/ci/heavy-tests.ts --local)" || ATLAS_TEST_HEAVY=all
  export ATLAS_TEST_HEAVY
else
  echo "heavy test sets: ${ATLAS_TEST_HEAVY:-all} (ATLAS_TEST_HEAVY from the environment)"
fi

rm -rf test-reports
mkdir -p "$REPORTS" || exit 2

run_task() {
  case "$1" in
    typecheck) bun run atlas:typecheck ;;
    identity-paths) bun run atlas:check:identity-paths ;;
    license-headers) bun run atlas:check:license-headers ;;
    *) bash atlas/scripts/test-shards.sh --group "$1" --report-dir "${REPORTS}/$1" ;;
  esac
}

start() {
  local name="${tasks[$1]}"
  (
    SECONDS=0
    run_task "$name" >"${REPORTS}/${name}.log" 2>&1
    code=$?
    echo "──── task ${name}: exit ${code} after ${SECONDS} s" >>"${REPORTS}/${name}.log"
    exit "$code"
  ) &
  pids[$1]=$!
}

failed=()
finish() {
  local name="${tasks[$1]}" code secs
  wait "${pids[$1]}"
  code=$?
  pids[$1]=''
  secs="$(sed -n 's/^──── task .*: exit [0-9]* after \([0-9]*\) s$/\1/p' "${REPORTS}/${name}.log" | tail -n 1)"
  if [ "$code" -eq 0 ]; then
    echo "──── ${name}: passed (${secs:-?} s)"
  else
    echo "──── ${name}: FAILED with exit ${code} (${secs:-?} s)"
    failed+=("$name")
  fi
}

limit="$jobs"
if [ "$limit" -eq 0 ] || [ "$limit" -gt "$total" ]; then
  limit="$total"
fi
echo "──── ${total} tasks, ${limit} at a time: ${tasks[*]}; logs in ${REPORTS}/<task>.log"

SECONDS=0
running=()
next=0
while [ "$next" -lt "$total" ]; do
  if [ ${#running[@]} -ge "$limit" ]; then
    finish "${running[0]}"
    running=(${running[@]+"${running[@]:1}"})
  fi
  start "$next"
  running+=("$next")
  next=$((next + 1))
done
for i in ${running[@]+"${running[@]}"}; do
  finish "$i"
done

for name in ${failed[@]+"${failed[@]}"}; do
  echo
  echo "──── ${name} (${REPORTS}/${name}.log)"
  grep '^::error' "${REPORTS}/${name}.log"
  echo "──── last 40 lines of ${name}:"
  tail -n 40 "${REPORTS}/${name}.log"
done

echo
# Untracked test files count: locally a new test is usually not committed yet.
bun atlas/scripts/check-test-files-ran.ts --include-untracked "$REPORTS"
check=$?

if [ ${#failed[@]} -ne 0 ] || [ "$check" -ne 0 ]; then
  [ "$check" -eq 0 ] || failed+=("check-test-files-ran")
  echo "──── ${#failed[@]} failed after ${SECONDS} s: ${failed[*]}"
  exit 1
fi
echo "──── all ${total} tasks passed and every test file ran once (${SECONDS} s)"
