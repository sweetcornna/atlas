#!/usr/bin/env bash
# Copyright 2026 Qianmo AgentNest Team
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# 阡陌内测 · 自我复制的中枢一侧（`node-provisioning.md` §14）。由 `qm replicate run`
# 在中枢上调，不经 ssh；运维也可以单独跑某一步排查。
#
#   replicate-hub.sh check
#   replicate-hub.sh prepare --node <节点> --agent <智能体>
#   replicate-hub.sh add     --node <节点> --agent <智能体> --user <ssh 用户> --host <地址>
#                            --port <ssh 端口> --local-port <回环口> --server <服务器名>
#                            --public-key <节点公钥> --trail <节点上审计链的绝对路径>
#   replicate-hub.sh restart
#   replicate-hub.sh discard --node <节点>
#
# ── 每一步做什么 ─────────────────────────────────────────────────────────────
#   check    中枢能不能接一个复制出来的节点：内测根、console.env 的尾参行、控制台与注册中心
#            的 systemd --user 单元（新节点的隧道与镜像也是 systemd --user 单元，没有它们
#            节点起来了也接不进来）。只读。stdout：READY。
#   prepare  先全部检查再写：节点名合法、peers.conf 里没有它、PSK 与链路 key 都还不在。
#            然后在 secrets/peers/<节点>.psk 生成这个节点的 PSK（0600，PSK 在中枢生成，
#            beta-env.md §8.3），在 ~/.ssh/qianmo-beta-links/<节点> 生成链路 key（ed25519，
#            私钥不离开中枢），挑一个空着的回环口。stdout：
#              LOCAL_PORT <口>
#              LINK_KEY <私钥路径>
#              LINK_PUBKEY <类型> <公钥>
#              PSK_FILE <路径>
#              NODE_ARG <一个参数>        （一行一个，节点腿的尾参，见下）
#   add      peers.conf 追加该节点的坐标行与地址行，console.env 的尾参追加
#            `--chat-url <节点>=ws://127.0.0.1:<口>`。两个文件都先备份（.bak-replicate-<UTC>），
#            再 tmp + mv。stdout：ADDED。
#   restart  起新节点的隧道与镜像（beta-up.sh --role host --only links），再重启注册中心与
#            控制台的单元：两者的命令行都由 peers.conf 派生，新节点的地址、公钥、PSK 与
#            模型执行器从这一刻起生效。控制台会断开约几秒，页面自己重连。
#   discard  撤回 prepare / add 写下的东西（只删本脚本这一次建的、并在
#            state/replicate/<节点>.created 里记过的）。复制中途失败时由 `qm replicate run` 调。
#
# ── 节点腿的尾参 ─────────────────────────────────────────────────────────────
# 新节点信任控制台的签名身份（beta-up.sh --print-wake-identity，按 console.env 的尾参问），
# 只接受控制台发来的本地命令，握手签名，按需起子进程。要再多带几项（比如探针的公钥），
# 写在 ops/replicate-node.args 里，一行一个参数，原样追加在后面。
#
# ── 退出码 ───────────────────────────────────────────────────────────────────
#   0 做完；1 拒绝或失败（原因在 stderr）；2 用法错。

set -euo pipefail

# shellcheck source=demo/env/beta/common.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/common.sh"

LINK_KEY_DIR="${QIANMO_BETA_LINK_KEY_DIR:-$HOME/.ssh/qianmo-beta-links}"
REPLICATE_STATE_DIR="$BETA_STATE_DIR/replicate"
CONSOLE_ENV_FILE="$BETA_OPS_DIR/console.env"
NODE_ARGS_FILE="$BETA_OPS_DIR/replicate-node.args"
# 新节点的回环口从这一段里挑。现场的三个是 38631–38633。
LOCAL_PORT_FIRST="${QIANMO_BETA_REPLICATE_PORT_FIRST:-38631}"
LOCAL_PORT_LAST="${QIANMO_BETA_REPLICATE_PORT_LAST:-38699}"

note() { printf '%s\n' "$*" >&2; }
refuse() { printf 'REFUSE : %s\n' "$*" >&2; exit 1; }
usage_die() { printf 'USAGE : %s\n' "$*" >&2; exit 2; }

created_file() { printf '%s/%s.created' "$REPLICATE_STATE_DIR" "$1"; }

record_created() {
  local node="$1" what="$2"
  mkdir -p "$REPLICATE_STATE_DIR"
  chmod 700 "$REPLICATE_STATE_DIR"
  printf '%s\n' "$what" >>"$(created_file "$node")"
}

# 本机上有没有人在听这个口。ss 没有就退回 /dev/tcp 试连。
port_busy() {
  local port="$1"
  if command -v ss >/dev/null 2>&1; then
    ss -Hltn "sport = :$port" 2>/dev/null | grep -q . && return 0
    return 1
  fi
  (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null && return 0
  return 1
}

peers_has_node() {
  local node="$1"
  [ -f "$BETA_PEERS_FILE" ] || return 1
  grep -Eq "^node[[:space:]]+${node}[[:space:]]" "$BETA_PEERS_FILE" && return 0
  grep -Eq "^qianmo://${node}/" "$BETA_PEERS_FILE" && return 0
  return 1
}

used_local_ports() {
  [ -f "$BETA_PEERS_FILE" ] || return 0
  sed -n 's/^node[[:space:]].*[[:space:]]local-port=\([0-9][0-9]*\).*/\1/p' "$BETA_PEERS_FILE"
}

pick_local_port() {
  local used port
  used=" $(used_local_ports | tr '\n' ' ') "
  port="$LOCAL_PORT_FIRST"
  while [ "$port" -le "$LOCAL_PORT_LAST" ]; do
    case "$used" in
      *" $port "*) ;;
      *) if ! port_busy "$port"; then printf '%s\n' "$port"; return 0; fi ;;
    esac
    port=$((port + 1))
  done
  return 1
}

assert_agent_name() {
  case "$1" in
    ''|-*|*[!A-Za-z0-9_-]*) refuse "智能体名只许字母、数字、- 与 _：${1:-<空>}" ;;
  esac
}

assert_ssh_user() {
  case "$1" in
    ''|-*|*[!A-Za-z0-9_.-]*) refuse "ssh 用户名不合法：${1:-<空>}" ;;
  esac
}

assert_host() {
  case "$1" in
    ''|-*|*[!A-Za-z0-9.:_-]*) refuse "地址只许主机名、IPv4 或不带方括号的 IPv6：${1:-<空>}" ;;
  esac
}

assert_abs_path() {
  case "$2" in
    /*) ;;
    *) refuse "$1 必须是绝对路径：${2:-<空>}" ;;
  esac
  case "$2" in
    *..*|*[!A-Za-z0-9._/-]*) refuse "$1 只许 A-Z a-z 0-9 . _ / -：$2" ;;
  esac
}

# 控制台的签名身份：按 console.env 里的尾参问（身份由 --chat-from 决定）。
# QIANMO_BETA_CONSOLE_IDENTITY=<名字>=<公钥> 直接给定（手工排查与用例用）。
console_identity() {
  local extra=''
  if [ -n "${QIANMO_BETA_CONSOLE_IDENTITY:-}" ]; then
    printf '%s\n' "$QIANMO_BETA_CONSOLE_IDENTITY"
    return 0
  fi
  if [ -f "$CONSOLE_ENV_FILE" ]; then
    extra="$(sed -n 's/^CONSOLE_EXTRA_ARGS=//p' "$CONSOLE_ENV_FILE" | tail -n 1)"
  fi
  # shellcheck disable=SC2086
  "$QIANMO_BETA_ENV_DIR/beta-up.sh" --print-wake-identity -- $extra 2>/dev/null | tail -n 1
}

cmd_prepare() {
  local node='' agent='' port psk key pub identity name line
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --node) node="${2:-}"; shift 2 ;;
      --agent) agent="${2:-}"; shift 2 ;;
      *) usage_die "prepare 不认识的参数：$1" ;;
    esac
  done
  beta_require_marker
  beta_assert_node_name "$node" replicate-hub
  assert_agent_name "$agent"
  psk="$(beta_peer_psk_file "$node")"
  key="$LINK_KEY_DIR/$node"
  # 先全部检查，再写。
  if peers_has_node "$node"; then refuse "peers.conf 里已经有 ${node}"; fi
  [ ! -e "$psk" ] || refuse "${psk} 已经在：换一个节点名，或先确认那一份没人在用"
  [ ! -e "$key" ] || refuse "${key} 已经在：换一个节点名，或先确认那一把没人在用"
  [ ! -e "$(created_file "$node")" ] || refuse "上一次复制 ${node} 留下的记录还在（$(created_file "$node")），先 discard"
  port="$(pick_local_port)" || refuse "${LOCAL_PORT_FIRST}–${LOCAL_PORT_LAST} 里没有空着的回环口"
  identity="$(console_identity)"
  case "$identity" in
    *=*) ;;
    *) refuse '问不出控制台的签名身份（beta-up.sh --print-wake-identity）' ;;
  esac
  name="${identity%%=*}"

  mkdir -p "$BETA_PEER_SECRET_DIR"
  chmod 700 "$BETA_PEER_SECRET_DIR"
  ( umask 077; beta_random_hex 32 | tr -d '\n' >"$psk" )
  chmod 600 "$psk"
  record_created "$node" "file $psk"
  mkdir -p "$LINK_KEY_DIR"
  chmod 700 "$LINK_KEY_DIR"
  ssh-keygen -q -t ed25519 -N '' -C "qianmo-link ${node}" -f "$key" </dev/null >/dev/null
  chmod 600 "$key"
  record_created "$node" "file $key"
  record_created "$node" "file ${key}.pub"
  IFS= read -r pub <"${key}.pub"

  printf 'LOCAL_PORT %s\n' "$port"
  printf 'LINK_KEY %s\n' "$key"
  printf 'LINK_PUBKEY %s\n' "$(printf '%s\n' "$pub" | awk '{print $1, $2}')"
  printf 'PSK_FILE %s\n' "$psk"
  printf 'NODE_ARG %s\n' --trust "$identity" --local-commands-from "$name" \
    --sign-handshake --omp-max-children=1 --omp-idle-ms=60000
  if [ -f "$NODE_ARGS_FILE" ]; then
    while IFS= read -r line || [ -n "$line" ]; do
      case "$line" in ''|'#'*) continue ;; esac
      printf 'NODE_ARG %s\n' "$line"
    done <"$NODE_ARGS_FILE"
  fi
}

# 把一行追加到文件末尾：先备份，再 tmp + mv。
append_line() {
  local file="$1" line="$2" stamp="$3" tmp
  if [ -f "$file" ]; then
    cp -p "$file" "${file}.bak-replicate-${stamp}"
    chmod 600 "${file}.bak-replicate-${stamp}"
  fi
  tmp="$(mktemp "${file}.tmp.XXXXXX")"
  if [ -f "$file" ]; then cat "$file" >"$tmp"; fi
  printf '%s\n' "$line" >>"$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$file"
}

cmd_add() {
  local node='' agent='' user='' host='' port='22' local_port='' server='' public_key='' trail='' key stamp extra tmp
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --node) node="${2:-}"; shift 2 ;;
      --agent) agent="${2:-}"; shift 2 ;;
      --user) user="${2:-}"; shift 2 ;;
      --host) host="${2:-}"; shift 2 ;;
      --port) port="${2:-}"; shift 2 ;;
      --local-port) local_port="${2:-}"; shift 2 ;;
      --server) server="${2:-}"; shift 2 ;;
      --public-key) public_key="${2:-}"; shift 2 ;;
      --trail) trail="${2:-}"; shift 2 ;;
      *) usage_die "add 不认识的参数：$1" ;;
    esac
  done
  beta_require_marker
  beta_assert_node_name "$node" replicate-hub
  assert_agent_name "$agent"
  assert_ssh_user "$user"
  assert_host "$host"
  beta_assert_port "$port" 'ssh 端口' replicate-hub
  beta_assert_port "$local_port" '回环口' replicate-hub
  beta_assert_server_id "$server" replicate-hub
  beta_public_key_ok "$public_key" || refuse "节点公钥不合法（应为 43 位 base64url）"
  assert_abs_path '审计链路径' "$trail"
  key="$LINK_KEY_DIR/$node"
  [ -f "$key" ] || refuse "${key} 不在：先 prepare"
  if peers_has_node "$node"; then refuse "peers.conf 里已经有 ${node}"; fi
  case " $(used_local_ports | tr '\n' ' ') " in
    *" $local_port "*) refuse "回环口 ${local_port} 已经分给别的节点" ;;
  esac
  [ -f "$CONSOLE_ENV_FILE" ] || refuse "${CONSOLE_ENV_FILE} 不在：中枢腿还没起过"
  grep -q '^CONSOLE_EXTRA_ARGS=' "$CONSOLE_ENV_FILE" || refuse "${CONSOLE_ENV_FILE} 里没有 CONSOLE_EXTRA_ARGS 那一行"

  stamp="$(beta_stamp)"
  append_line "$BETA_PEERS_FILE" \
    "node ${node} user=${user} host=${host} port=${port} local-port=${local_port} remote-port=${BETA_NODE_PORT} trail=${trail} key=${key} server=${server} public-key=${public_key}" \
    "$stamp"
  append_line "$BETA_PEERS_FILE" "qianmo://${node}/${agent}  ws://127.0.0.1:${local_port}" "$stamp"
  record_created "$node" "peers $node"

  cp -p "$CONSOLE_ENV_FILE" "${CONSOLE_ENV_FILE}.bak-replicate-${stamp}"
  extra="--chat-url ${node}=ws://127.0.0.1:${local_port}"
  tmp="$(mktemp "${CONSOLE_ENV_FILE}.tmp.XXXXXX")"
  awk -v extra="$extra" '
    /^CONSOLE_EXTRA_ARGS=/ { if ($0 == "CONSOLE_EXTRA_ARGS=") print $0 extra; else print $0 " " extra; next }
    { print }
  ' "$CONSOLE_ENV_FILE" >"$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$CONSOLE_ENV_FILE"
  record_created "$node" "chat-url $extra"
  printf 'ADDED\n'
}

cmd_check() {
  beta_require_marker
  [ -f "$CONSOLE_ENV_FILE" ] || refuse "${CONSOLE_ENV_FILE} 不在：中枢腿还没起过"
  grep -q '^CONSOLE_EXTRA_ARGS=' "$CONSOLE_ENV_FILE" || refuse "${CONSOLE_ENV_FILE} 里没有 CONSOLE_EXTRA_ARGS 那一行"
  command -v systemctl >/dev/null 2>&1 || refuse '中枢上没有 systemctl：新节点的隧道是 systemd --user 单元'
  systemctl --user cat "$BETA_CONSOLE_UNIT" >/dev/null 2>&1 \
    || refuse "没有 ${BETA_CONSOLE_UNIT}：中枢腿没有铺 systemd --user 单元，新节点接不进隧道"
  systemctl --user cat "$BETA_REGISTRY_UNIT" >/dev/null 2>&1 || refuse "没有 ${BETA_REGISTRY_UNIT}"
  printf 'READY\n'
}

cmd_restart() {
  beta_require_marker
  "$QIANMO_BETA_ENV_DIR/beta-up.sh" --role host --only links >&2
  # 一条命令两个单元：控制台 Requires 注册中心，分两次会把控制台重启两遍。
  systemctl --user restart "$BETA_REGISTRY_UNIT" "$BETA_CONSOLE_UNIT"
  printf 'RESTARTED\n'
}

# 去掉 peers.conf 里属于这个节点的两种行；console.env 里去掉那一条 --chat-url。
drop_node_lines() {
  local node="$1" extra="$2" stamp tmp
  stamp="$(beta_stamp)"
  if [ -f "$BETA_PEERS_FILE" ] && peers_has_node "$node"; then
    cp -p "$BETA_PEERS_FILE" "${BETA_PEERS_FILE}.bak-replicate-${stamp}"
    tmp="$(mktemp "${BETA_PEERS_FILE}.tmp.XXXXXX")"
    awk -v node="$node" '
      $1 == "node" && $2 == node { next }
      index($1, "qianmo://" node "/") == 1 { next }
      { print }
    ' "$BETA_PEERS_FILE" >"$tmp"
    chmod 600 "$tmp"
    mv "$tmp" "$BETA_PEERS_FILE"
  fi
  if [ -n "$extra" ] && [ -f "$CONSOLE_ENV_FILE" ]; then
    cp -p "$CONSOLE_ENV_FILE" "${CONSOLE_ENV_FILE}.bak-replicate-${stamp}"
    tmp="$(mktemp "${CONSOLE_ENV_FILE}.tmp.XXXXXX")"
    awk -v extra="$extra" '
      /^CONSOLE_EXTRA_ARGS=/ {
        line = $0
        i = index(line, " " extra)
        if (i > 0) line = substr(line, 1, i - 1) substr(line, i + length(extra) + 1)
        else { i = index(line, "=" extra); if (i > 0) line = substr(line, 1, i) substr(line, i + length(extra) + 2) }
        print line; next
      }
      { print }
    ' "$CONSOLE_ENV_FILE" >"$tmp"
    chmod 600 "$tmp"
    mv "$tmp" "$CONSOLE_ENV_FILE"
  fi
}

cmd_discard() {
  local node='' record kind rest extra='' line
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --node) node="${2:-}"; shift 2 ;;
      *) usage_die "discard 不认识的参数：$1" ;;
    esac
  done
  beta_require_marker
  beta_assert_node_name "$node" replicate-hub
  record="$(created_file "$node")"
  [ -f "$record" ] || { printf 'NOTHING\n'; return 0; }
  while IFS= read -r line || [ -n "$line" ]; do
    kind="${line%% *}"
    rest="${line#* }"
    case "$kind" in
      chat-url) extra="$rest" ;;
    esac
  done <"$record"
  if grep -q '^peers ' "$record" || [ -n "$extra" ]; then
    drop_node_lines "$node" "$extra"
  fi
  while IFS= read -r line || [ -n "$line" ]; do
    kind="${line%% *}"
    rest="${line#* }"
    case "$kind" in
      file)
        case "$rest" in
          "$BETA_PEER_SECRET_DIR"/*|"$LINK_KEY_DIR"/*) rm -f -- "$rest" ;;
          *) note "WARN : 记录里的 ${rest} 不在预期目录里，不删" ;;
        esac
        ;;
    esac
  done <"$record"
  rm -f -- "$record"
  printf 'DISCARDED\n'
}

main() {
  local cmd="${1:-}"
  [ "$#" -gt 0 ] && shift
  case "$cmd" in
    check) cmd_check "$@" ;;
    prepare) cmd_prepare "$@" ;;
    add) cmd_add "$@" ;;
    restart) cmd_restart "$@" ;;
    discard) cmd_discard "$@" ;;
    -h|--help|'') sed -n '5,15p' "$0"; [ -n "$cmd" ] || exit 2 ;;
    *) usage_die "不认识的子命令：$cmd" ;;
  esac
}

main "$@"
