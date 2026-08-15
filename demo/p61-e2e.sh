#!/usr/bin/env bash
# Copyright 2026 Qianmo AgentNest Team
# SPDX-License-Identifier: MIT

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

if [ -z "${QIANMO_TRANSPORT_PSK:-}" ]; then
  printf 'p61-e2e: missing required environment variable QIANMO_TRANSPORT_PSK\n' >&2
  exit 2
fi

for tool in bun node; do
  command -v "$tool" >/dev/null 2>&1 || {
    printf 'p61-e2e: %s is not in PATH\n' "$tool" >&2
    exit 2
  }
done

cd "$REPO_DIR"
exec bun run demo/lib/p61-scenario.ts "$@"
