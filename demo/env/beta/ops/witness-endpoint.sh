#!/usr/bin/env bash
# Copyright 2026 Qianmo AgentNest Team
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# 阡陌内测 · H 上的审计见证端点（P11.4，audit-witness.md §4）。
#
#   demo/env/beta/ops/witness-endpoint.sh install --key <节点>=<公钥> [--key …] [--port 38640]
#   demo/env/beta/ops/witness-endpoint.sh run        # systemd 单元调它；参数全部来自 ops/witness.env
#
# ── 形态 ────────────────────────────────────────────────────────────────────
# 端点只听 H 的回环（默认 127.0.0.1:38640）。节点够到它的办法是 H → 节点那条 SSH 隧道
# 会话里的 `-R 127.0.0.1:38640:127.0.0.1:38640`（peers.conf 坐标行的 witness-port=），节点
# 侧 authorized_keys 那一行用 `permitlisten="127.0.0.1:38640"` 把反向转发钉死在这一个口上。
# 会话由 H 发起，节点上不放任何指向 H 的凭据——§8.3 的单向信任、以及见证方与被见证方
# 处在不同失陷域（§4.1）这两条都不破。
#
# ── 两枚 token ──────────────────────────────────────────────────────────────
# install 首次运行时各生成一枚（64 hex，0600，两枚必须不同），**不回显**：
#   <根>/secrets/witness-write-token   发给每个节点（节点那边落 secrets/witness-write-token）
#   <根>/secrets/witness-read-token    **永不离开 H**：它能列出全部锚点，只给 `occ audit --verify --witness` 与控制台用
# 已经在的不重生成：换 token 是一次有计划的动作，不是重跑 install 的副作用。
#
# ── 节点公钥 ────────────────────────────────────────────────────────────────
# `--key <节点>=<公钥>` 一次给全，来源是节点 logs/<节点>.out 首行横幅里的 publicKey。
# 加一个节点 = 带着**全部** --key 重跑 install，再 restart 单元。不做首次信任。

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$HERE/../../../.." && pwd)"
BETA_ROOT="${QIANMO_BETA_ROOT:-$HOME/qianmo-beta}"
MARKER="$BETA_ROOT/.qianmo-beta-env"
MARKER_MAGIC='qianmo-beta-env/v1'
OPS_DIR="$BETA_ROOT/ops"
SECRET_DIR="$BETA_ROOT/secrets"
CONF="$OPS_DIR/witness.env"
STORE="$BETA_ROOT/witness/store"
WRITE_TOKEN_FILE="$SECRET_DIR/witness-write-token"
READ_TOKEN_FILE="$SECRET_DIR/witness-read-token"
READY_FILE="$BETA_ROOT/run/witness-ready.json"
UNIT='qianmo-witness.service'
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"

say() { printf '%s\n' "$*"; }
die() {
  printf '[witness-endpoint] %s\n' "$*" >&2
  exit 1
}

require_marker() {
  [ -f "$MARKER" ] || die "$BETA_ROOT 不是内测环境（缺 ${MARKER}）"
  head -1 "$MARKER" | grep -qF "$MARKER_MAGIC" \
    || die "$MARKER 的首行不是 ${MARKER_MAGIC}，拒绝操作"
}

unit_path() {
  case "$1" in
    "$HOME"/*) printf '%%h/%s' "${1#"$HOME"/}" ;;
    *) printf '%s' "$1" ;;
  esac
}

systemd_user_ok() {
  [ "${QIANMO_WITNESS_NO_SYSTEMCTL:-0}" = '1' ] && return 1
  command -v systemctl >/dev/null 2>&1 || return 1
  systemctl --user show-environment >/dev/null 2>&1
}

new_token() {
  LC_ALL=C od -An -tx1 -N 32 /dev/urandom | tr -d ' \n'
}

ensure_token() {
  local file="$1" what="$2"
  if [ -s "$file" ]; then
    say "$what 已在（不重生成，不回显）：$file"
    return 0
  fi
  (umask 077 && new_token >"$file")
  chmod 600 "$file"
  say "$what 已生成（0600，不回显）：$file"
}

cmd_install() {
  local port='38640' keys='' one
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --key)
        one="${2:?--key 缺值}"
        case "$one" in
          [a-z0-9]*=?*) ;;
          *) die "--key 要写成 <节点>=<公钥>：$one" ;;
        esac
        case "$one" in *[[:space:]]*) die "--key 里不能有空白：$one" ;; esac
        keys="$keys $one"
        shift 2
        ;;
      --port) port="${2:?}"; shift 2 ;;
      *) die "install 不认识的参数：$1" ;;
    esac
  done
  [ -n "$keys" ] || die 'install 至少要一条 --key <节点>=<公钥>'
  case "$port" in ''|*[!0-9]*) die "--port 不是端口号：$port" ;; esac
  require_marker
  mkdir -p "$OPS_DIR" "$SECRET_DIR" "$UNIT_DIR"
  chmod 700 "$SECRET_DIR"

  ensure_token "$WRITE_TOKEN_FILE" '见证写 token'
  ensure_token "$READ_TOKEN_FILE" '见证读 token'
  cmp -s "$WRITE_TOKEN_FILE" "$READ_TOKEN_FILE" \
    && die '两枚见证 token 相同——删掉其中一个重跑 install'

  {
    printf '# 阡陌内测 · 见证端点的参数。由 witness-endpoint.sh install 写，单元经 run 读。\n'
    printf 'WITNESS_PORT=%s\n' "$port"
    printf 'WITNESS_KEYS=%s\n' "${keys# }"
  } >"$CONF"
  chmod 600 "$CONF"

  local bun_path
  bun_path="$(command -v bun 2>/dev/null || printf '%s' "$HOME/.bun/bin/bun")"
  sed -e "s|@REPO_DIR@|$(unit_path "$REPO_DIR")|g" \
    -e "s|@BETA_ROOT@|$(unit_path "$BETA_ROOT")|g" \
    -e "s|@BUN_DIR@|$(unit_path "$(dirname "$bun_path")")|g" \
    "$HERE/$UNIT.in" >"$OPS_DIR/$UNIT"
  if grep -q '@[A-Z_]*@' "$OPS_DIR/$UNIT"; then die "模板里有没替换掉的占位符"; fi
  cp "$OPS_DIR/$UNIT" "$UNIT_DIR/$UNIT"
  chmod 644 "$UNIT_DIR/$UNIT"
  say "已装：${CONF}、$UNIT_DIR/${UNIT}（节点：${keys# }）"

  if systemd_user_ok; then
    systemctl --user daemon-reload
    systemctl --user enable "$UNIT" >/dev/null
    say "已 enable ${UNIT}；首次起：systemctl --user start ${UNIT}；改了参数：systemctl --user restart $UNIT"
  else
    say '这台机器上没有可用的 systemd --user：单元文件已写好，没有 enable'
  fi
}

cmd_run() {
  require_marker
  [ -f "$CONF" ] || die "缺 $CONF —— 先跑 witness-endpoint.sh install"
  # shellcheck disable=SC1090
  . "$CONF"
  : "${WITNESS_PORT:?}" "${WITNESS_KEYS:?}"
  # shellcheck source=demo/lib/entry.sh
  . "$REPO_DIR/demo/lib/entry.sh"
  local args=(
    --store "$STORE"
    --host 127.0.0.1
    --port "$WITNESS_PORT"
    --write-token-file "$WRITE_TOKEN_FILE"
    --read-token-file "$READ_TOKEN_FILE"
    --ready "$READY_FILE"
  )
  local one
  for one in $WITNESS_KEYS; do args+=(--key "$one"); done
  mkdir -p "$STORE"
  chmod 700 "$BETA_ROOT/witness" "$STORE"
  exec bun run "$(demo_entry witness-endpoint)" "${args[@]}"
}

case "${1:-}" in
  install) shift; cmd_install "$@" ;;
  run) shift; cmd_run "$@" ;;
  -h|--help|'') sed -n '5,8p' "$0" | sed 's/^# \{0,1\}//' ;;
  *) die "不认识的子命令：$1" ;;
esac
