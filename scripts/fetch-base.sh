#!/usr/bin/env bash
#
# Fetch the external reference base (openclaudecode) into vendor/ at a pinned
# commit, for LOCAL STUDY ONLY.
#
# The checkout is gitignored and must never be committed, copied into
# packages/, or redistributed. See NOTICE for the licensing boundary.
#
# Usage: scripts/fetch-base.sh
# Idempotent: re-running verifies the pinned commit instead of re-cloning.

set -euo pipefail

REPO_URL="https://github.com/openclaudecode/openclaudecode.git"
PIN_COMMIT="716504c5fd2a977c82135773977a413f4092634d"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENDOR_DIR="$ROOT_DIR/vendor"
TARGET_DIR="$VENDOR_DIR/openclaudecode"

log() { printf '[fetch-base] %s\n' "$*"; }
die() { printf '[fetch-base] error: %s\n' "$*" >&2; exit 1; }

command -v git >/dev/null 2>&1 || die "git is required but was not found in PATH"

# Pin the working tree to $PIN_COMMIT inside an already-initialised repo.
checkout_pin() {
  log "fetching pinned commit ${PIN_COMMIT:0:12} ..."
  if git -C "$TARGET_DIR" fetch --depth 1 origin "$PIN_COMMIT" 2>/dev/null; then
    git -C "$TARGET_DIR" checkout --detach --force FETCH_HEAD >/dev/null
  else
    # Some servers refuse fetch-by-SHA; fall back to a full history fetch.
    log "shallow fetch by SHA refused, falling back to full fetch (slower) ..."
    git -C "$TARGET_DIR" fetch --unshallow origin 2>/dev/null \
      || git -C "$TARGET_DIR" fetch origin
    git -C "$TARGET_DIR" checkout --detach --force "$PIN_COMMIT" >/dev/null
  fi
}

if [ -e "$TARGET_DIR" ]; then
  [ -d "$TARGET_DIR/.git" ] || die "$TARGET_DIR exists but is not a git repository; remove it and retry"

  current="$(git -C "$TARGET_DIR" rev-parse HEAD)"
  if [ "$current" = "$PIN_COMMIT" ]; then
    log "already at pinned commit ${PIN_COMMIT:0:12}, nothing to do"
  else
    log "found ${current:0:12}, expected ${PIN_COMMIT:0:12}; re-pinning"
    checkout_pin
  fi
else
  log "cloning $REPO_URL -> vendor/openclaudecode"
  mkdir -p "$VENDOR_DIR"
  git init --quiet "$TARGET_DIR"
  git -C "$TARGET_DIR" remote add origin "$REPO_URL"
  checkout_pin
fi

actual="$(git -C "$TARGET_DIR" rev-parse HEAD)"
[ "$actual" = "$PIN_COMMIT" ] || die "HEAD is $actual but the pin is $PIN_COMMIT"

log "ready: vendor/openclaudecode @ $PIN_COMMIT"
echo
echo "================================================================"
echo " 参考基座仅供本地研究 / Reference base: LOCAL STUDY ONLY"
echo
echo " vendor/openclaudecode 是外部参考代码，没有有效的许可授权。"
echo "   * 不得提交入库、不得再分发、不得复制进 packages/"
echo "   * 不得链接进任何构建产物或发布物"
echo " This code carries no valid license grant. Do not commit, do not"
echo " redistribute, do not copy into first-party packages."
echo "================================================================"
