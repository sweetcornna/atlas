#!/usr/bin/env bash
# Copyright 2026 Qianmo AgentNest Team
# SPDX-License-Identifier: MIT
#
# P1.3 / AC-6(a) host acceptance. Run only against a disposable sandbox.
# Deployment details and the daemon bearer are injected through environment
# variables and are never printed or written to the repository.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

required=(
  QIANMO_SANDBOX_DAEMON_URL
  QIANMO_SANDBOX_DAEMON_TOKEN
  QIANMO_P13_SANDBOX
)
for name in "${required[@]}"; do
  eval "value=\${$name:-}"
  if [ -z "$value" ]; then
    printf 'ac6a-sandbox: missing required environment variable %s\n' "$name" >&2
    exit 2
  fi
done

command -v bun >/dev/null 2>&1 || {
  printf 'ac6a-sandbox: bun is not in PATH\n' >&2
  exit 2
}
command -v docker >/dev/null 2>&1 || {
  printf 'ac6a-sandbox: docker is not in PATH\n' >&2
  exit 2
}

cd "$REPO_DIR"
bun run demo/lib/ac6a-sandbox.ts
