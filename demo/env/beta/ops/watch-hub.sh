#!/usr/bin/env bash
# Copyright 2026 Qianmo AgentNest Team
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# 阡陌内测 · H 上的值守作业（`qm watch`，P13.6；console.md §10、beta-env.md §4.1.2）。
#
#   watch-hub.sh print-identity [--from qianmo://hub/console]    # → hub=<公钥>，原样放进每个目标节点的 --trust
#   watch-hub.sh install --node <节点> --jobs <作业文件> [--from qianmo://hub/console] [--sign]
#   watch-hub.sh run                                              # qianmo-watch.service 调它
#
# ── 四条接线，都不是新定的 ───────────────────────────────────────────────────
# ① **配置根就是控制台那一份**（<根>/nodes/console/config）。`qm watch --sign` 的签名身份按
#    配置根落盘（<config>/qianmo/identity/<--from 的 node 段>.json），print-identity 与 run
#    必须问同一个根——拿另一个根打印出来的公钥，症状是节点端验签失败，查起来看不出是
#    打印的时候就错了（beta-up.sh 的 --print-wake-identity 是同一条理由）。调度状态与
#    ESTOP 因此落在 <根>/nodes/console/config/qianmo/scheduler/。
# ② **一个进程只带一把 PSK**：`qm watch` 读 QIANMO_TRANSPORT_PSK，而内测是每节点一把
#    （§8.2）。所以一个单元只服务一个节点：install 时钉死 --node，run 时从
#    secrets/peers/<节点>.psk 读进环境（不上命令行），并先查作业文件里每个 target 都在这个
#    节点上——PSK 对不上的作业只会在握手时失败，而那一刻已经是计时开始之后了。
# ③ **先 trust，后 --sign**（console.md §10.1.1）：节点解析不出签发方公钥时，两种策略下都
#    拒成 E_CAP_INVALID。顺序：print-identity → 每个目标节点带上 --trust hub=<公钥> 重起 →
#    install --sign → systemctl --user start qianmo-watch.service。
# ④ **签了消息，握手也签**：WATCH_SIGN=1 时 run 每次从 peers.conf（坐标行 public-key=，或本机
#    节点的身份文件）现取目标节点公钥，给 qm watch 加 --trust <节点>=<公钥>，握手于是双向签名。
#    取法与 fleet-probe.sh 的握手探针、H 腿给控制台的 --trust 同一个（beta_resolve_node_key），
#    不抄进 watch.env——公钥只有 peers.conf 这一个出处。带 --controller（或
#    --require-signed-handshake）的节点只收签名握手，不签的拨号拒成 signature_required。
#    取不到公钥时 WARN 并照旧 PSK 握手，与控制台 --wake-sign 缺目标公钥时同一个姿态
#    （console.md §4.6）。反过来，取得到公钥就要求节点回签：节点要带 --sign-handshake
#    （--controller 已含），这与控制台唤醒/对话面对名册公钥的要求相同。
#
# install 只 enable、不 start：开始计时是一个有意的动作。作业文件被拷进
# <根>/watch/jobs.json（0600）；改作业 = 改源文件后重跑 install，再 restart 单元。
# 停手：touch <根>/nodes/console/config/qianmo/scheduler/ESTOP（只挡新 fire，在途不杀）。

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=demo/env/beta/common.sh
. "$HERE/../common.sh"

WATCH_CONF="$BETA_OPS_DIR/watch.env"
WATCH_DIR="$BETA_ROOT/watch"
WATCH_JOBS_FILE="$WATCH_DIR/jobs.json"
WATCH_UNIT='qianmo-watch.service'
WATCH_DEFAULT_FROM='qianmo://hub/console'

# 作业文件里全部 target 的 node 段，一行一个（JSON 里 "target": "qianmo://<node>/<agent>"）。
job_target_nodes() {
  { grep -oE '"target"[[:space:]]*:[[:space:]]*"[^"]*"' "$1" || true; } \
    | sed -E -e 's/.*"qianmo:\/\/([^/"]*)\/.*/\1/' -e 't' -e 's/.*/?/'
}

assert_jobs_for_node() {
  local jobs="$1" node="$2" count=0 one
  [ -f "$jobs" ] || beta_die "作业文件不存在：$jobs"
  while IFS= read -r one; do
    count=$((count + 1))
    [ "$one" = "$node" ] \
      || beta_die "作业文件里有 target 不在 ${node} 上（${one}）：一个 qm watch 进程只带 ${node} 这一把 PSK"
  done < <(job_target_nodes "$jobs")
  [ "$count" -gt 0 ] || beta_die "作业文件里一个 target 都没有：$jobs"
}

# watch_resolve_trust <节点> —— 设 WATCH_TRUST：取得到该节点公钥就是 `<节点>=<公钥>`，否则空（④）。
# beta_load_peers 不放进 if 条件里：那里 set -e 不生效，peers.conf 读坏了要当场停。
WATCH_TRUST=''
watch_resolve_trust() {
  local node="$1"
  WATCH_TRUST=''
  beta_load_peers
  if beta_resolve_node_key "$node"; then
    WATCH_TRUST="$node=$BETA_NODE_KEY"
    beta_ok "握手签名：--trust ${WATCH_TRUST}（出处：${BETA_NODE_KEY_SOURCE}）"
    return 0
  fi
  beta_warn "握手不签名（PSK）：取不到 ${node} 的公钥——${BETA_NODE_KEY_GAP}
带 --controller 或 --require-signed-handshake 的节点会拒成 signature_required"
}

assert_from() {
  case "$1" in
    qianmo://*/*) ;;
    *) beta_die "--from 要写成 qianmo://<node>/<agent>：$1" ;;
  esac
}

cmd_print_identity() {
  local from="$WATCH_DEFAULT_FROM"
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --from) from="${2:?}"; shift 2 ;;
      *) beta_die "print-identity 不认识的参数：$1" ;;
    esac
  done
  assert_from "$from"
  beta_require_marker
  mkdir -p "$BETA_CONFIG_CONSOLE"
  chmod 700 "$BETA_CONFIG_CONSOLE"
  beta_say "值守作业的签名身份（配置根 ${BETA_CONFIG_CONSOLE}；整行原样放进每个目标节点的 --trust）：" >&2
  QIANMO_CONFIG_DIR="$BETA_CONFIG_CONSOLE" \
    "${BETA_QM[@]}" watch --print-identity --from "$from"
}

cmd_install() {
  local node='' jobs='' from="$WATCH_DEFAULT_FROM" sign='0'
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --node) node="${2:?}"; shift 2 ;;
      --jobs) jobs="${2:?}"; shift 2 ;;
      --from) from="${2:?}"; shift 2 ;;
      --sign) sign='1'; shift ;;
      *) beta_die "install 不认识的参数：$1" ;;
    esac
  done
  [ -n "$node" ] && [ -n "$jobs" ] || beta_die 'install 要 --node <节点> --jobs <作业文件>'
  assert_from "$from"
  beta_require_marker
  local psk_file
  psk_file="$(beta_peer_psk_file "$node")"
  [ -s "$psk_file" ] || beta_die "缺 ${node} 的 PSK：${psk_file}（值守进程靠它和节点握手）"
  assert_jobs_for_node "$jobs" "$node"

  mkdir -p "$WATCH_DIR"
  chmod 700 "$WATCH_DIR"
  if [ "$(cd "$(dirname "$jobs")" && pwd)/$(basename "$jobs")" != "$WATCH_JOBS_FILE" ]; then
    (umask 077 && cp "$jobs" "$WATCH_JOBS_FILE")
  fi
  chmod 600 "$WATCH_JOBS_FILE"
  {
    printf '# 阡陌内测 · 值守作业的参数。由 watch-hub.sh install 写，run 读。\n'
    printf 'WATCH_NODE=%s\n' "$node"
    printf 'WATCH_FROM=%s\n' "$from"
    printf 'WATCH_SIGN=%s\n' "$sign"
  } >"$WATCH_CONF"
  chmod 600 "$WATCH_CONF"

  local unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user" bun_dir dst
  bun_dir="$(dirname "$(command -v bun 2>/dev/null || printf '%s' "$HOME/.bun/bin/bun")")"
  mkdir -p "$unit_dir"
  dst="$unit_dir/$WATCH_UNIT"
  sed -e "s|@REPO_DIR@|$(beta_unit_path "$REPO_DIR")|g" \
    -e "s|@BETA_ROOT@|$(beta_unit_path "$BETA_ROOT")|g" \
    -e "s|@BUN_DIR@|$(beta_unit_path "$bun_dir")|g" \
    "$HERE/$WATCH_UNIT.in" >"$dst"
  grep -q '@[A-Z_]*@' "$dst" && beta_die "模板里有没替换掉的占位符：$HERE/$WATCH_UNIT.in"
  chmod 644 "$dst"
  beta_ok "已写：${WATCH_CONF}、${WATCH_JOBS_FILE}、${dst}（节点 ${node}，签名 $([ "$sign" = 1 ] && printf 开 || printf 关)）"
  if [ "$sign" = '1' ]; then
    beta_say "开了 --sign：${node} 必须已经带着 --trust <print-identity 打出的那一行> 起来，否则它会拒成 E_CAP_INVALID"
    # 这里只报一声；run 每次现取，install 不把公钥写进 watch.env。
    watch_resolve_trust "$node"
    [ -z "$WATCH_TRUST" ] \
      || beta_say "握手双向签名：${node} 还要带 --sign-handshake（--controller 已含），否则 run 起来拨不通"
  else
    beta_warn '没开 --sign：默认策略的节点会拒收，--open-policy 的节点收下但 agent 不会执行（console.md §10.1.1）'
  fi
  if [ "${QIANMO_WATCH_NO_SYSTEMCTL:-0}" != '1' ] && beta_systemd_user_ok; then
    systemctl --user daemon-reload
    systemctl --user enable "$WATCH_UNIT" >/dev/null
    beta_say "已 enable ${WATCH_UNIT}，**没有 start**。开始值守：systemctl --user start $WATCH_UNIT"
  fi
}

cmd_run() {
  beta_require_marker
  [ -f "$WATCH_CONF" ] || beta_die "缺 $WATCH_CONF —— 先跑 watch-hub.sh install"
  # shellcheck disable=SC1090
  . "$WATCH_CONF"
  : "${WATCH_NODE:?}" "${WATCH_FROM:?}" "${WATCH_SIGN:?}"
  assert_jobs_for_node "$WATCH_JOBS_FILE" "$WATCH_NODE"
  unset QIANMO_TRANSPORT_PSK
  beta_load_psk "$(beta_peer_psk_file "$WATCH_NODE")" "${WATCH_NODE} 的传输层 PSK"
  local args=(watch --jobs "$WATCH_JOBS_FILE" --from "$WATCH_FROM")
  # --trust 只在 --sign 下才合法（qm watch 自己也会拒）。
  if [ "$WATCH_SIGN" = '1' ]; then
    args+=(--sign)
    watch_resolve_trust "$WATCH_NODE"
    [ -z "$WATCH_TRUST" ] || args+=(--trust "$WATCH_TRUST")
  fi
  export QIANMO_CONFIG_DIR="$BETA_CONFIG_CONSOLE"
  exec "${BETA_QM[@]}" "${args[@]}"
}

case "${1:-}" in
  print-identity) shift; cmd_print_identity "$@" ;;
  install) shift; cmd_install "$@" ;;
  run) cmd_run ;;
  -h|--help|'') sed -n '5,9p' "$0" | sed 's/^# \{0,1\}//' ;;
  *) beta_die "不认识的子命令：$1" ;;
esac
