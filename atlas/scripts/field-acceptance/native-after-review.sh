#!/usr/bin/env bash
# Copyright 2026 Qianmo AgentNest Team
# SPDX-License-Identifier: AGPL-3.0-or-later
# Finite candidate-only native probe. Stage/review the exact bytes first.
set -euo pipefail
umask 077
root=${1:?absolute reviewed candidate root required}
role=${2:?hub, worker or witness role required}
expected=${3:?reviewed qm SHA256 required}
case "$role" in hub|worker|witness) ;; *) echo 'invalid role' >&2; exit 2 ;; esac
[ "$(id -u)" -gt 0 ] || { echo 'non-root user required' >&2; exit 2; }
case "$root" in "$HOME"/qianmo-candidate/*) ;; *) echo 'candidate root required' >&2; exit 2 ;; esac
[ "$(readlink -f "$root")" = "$root" ] && [ ! -L "$root" ] || exit 2
candidate=${root##*/}
case "$candidate" in *[!a-zA-Z0-9_.-]*|'') exit 2 ;; esac
[ "$(sha256sum "$root/bin/qm-linux-x64" | cut -d' ' -f1)" = "$expected" ] || { echo 'qm checksum mismatch' >&2; exit 2; }
[ -x "$root/bin/bun-linux-x64" ] && [ -s "$root/bin/check-qm-smoke.mjs" ] || exit 2
[ ! -e "$root/evidence/native-$role.log" ] || { echo 'evidence already exists; never overwrite a previous run' >&2; exit 2; }
unit="$candidate-$role-native"
if systemctl --user is-active --quiet "$unit.service"; then echo 'candidate unit already active' >&2; exit 2; fi
printf 'role=%s unit=%s qmSHA256=%s\n' "$role" "$unit" "$expected" > "$root/evidence/native-$role.log"
if [ "$role" = worker ]; then
  command=("$root/bin/bun-linux-x64" "$root/bin/check-qm-smoke.mjs" "$root/bin/qm-linux-x64")
  memory=768M
else
  command=("$root/bin/qm-linux-x64" --version)
  memory=192M
fi
set +e
systemd-run --user --wait --pipe --collect --unit="$unit" \
  --property=MemoryMax="$memory" --property=CPUQuota=50% \
  --property=RuntimeMaxSec=300 --property=TimeoutStopSec=20 \
  --property=OOMScoreAdjust=900 --property=NoNewPrivileges=yes \
  --property=WorkingDirectory="$root/work" \
  /usr/bin/env -i PATH=/usr/bin:/bin HOME="$root/home" TMPDIR="$root/run" \
  QIANMO_CONFIG_DIR="$root/config" NO_COLOR=1 \
  "${command[@]}" >> "$root/evidence/native-$role.log" 2>&1
code=$?
set -e
printf 'exitCode=%s\n' "$code" >> "$root/evidence/native-$role.log"
# No timer, permanent service, package install or existing deployment is touched.
# Exact rollback while active: systemctl --user stop "$unit.service"
exit "$code"
