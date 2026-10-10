#!/usr/bin/env bash
# Copyright 2026 Qianmo AgentNest Team
# SPDX-License-Identifier: AGPL-3.0-or-later
# AC-1 recovery after SIGKILL, using a loopback provider and no external credentials.
set -euo pipefail
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
. "$REPO_DIR/demo/lib/entry.sh"
exec bun "$(demo_entry ac1-resume)"
