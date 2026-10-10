#!/usr/bin/env bash
# Copyright 2026 Qianmo AgentNest Team
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Builds the omp native addon that `atlas:build:qm` embeds.
#
# On x64, build-qm embeds only the portable baseline addon (the runtime loader
# tries modern, then baseline, so AVX2 hosts load it too). omp's local napi
# build names its output after the build host's CPU, so an AVX2 machine emits
# only `-modern`. Pin the ISA floor build-bindings itself uses for baseline
# (x86-64-v2) and give the addon its baseline name. Other hosts build as usual.
#
# Used by the CI job and by the fleet recipe (atlas/scripts/fleet/linux-build.sh).
set -euo pipefail
cd "$(dirname "$0")/../.."

if [ "$(uname -s)" = Linux ] && [ "$(uname -m)" = x86_64 ]; then
  RUSTFLAGS='-C target-cpu=x86-64-v2' bun run build:native
  native=packages/natives/native
  if [ ! -e "$native/pi_natives.linux-x64-baseline.node" ] &&
    [ -e "$native/pi_natives.linux-x64-modern.node" ]; then
    mv "$native/pi_natives.linux-x64-modern.node" "$native/pi_natives.linux-x64-baseline.node"
    echo "renamed x86-64-v2 build: pi_natives.linux-x64-modern.node -> pi_natives.linux-x64-baseline.node"
  fi
  test -e "$native/pi_natives.linux-x64-baseline.node"
else
  bun run build:native
fi
