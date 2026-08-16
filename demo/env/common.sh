#!/usr/bin/env bash
# Copyright 2026 Qianmo AgentNest Team
# SPDX-License-Identifier: MIT
#
# 阡陌 P8.1 —— 演示环境公共层。**被 source，不单独执行。**
#
# 这里定死三件事，其余脚本一律从这里取，不各写一份：
#   ① 演示根目录 DEMO_ROOT 与它下面的目录布局；
#   ② 配置隔离——每个节点一个 OCC_CONFIG_DIR，全都在 DEMO_ROOT 里，
#      **绝不碰用户真实的 ~/.occ / ~/.qianmo / ~/.claude**；
#   ③ 端口、节点名、智能体名的默认值与环境变量覆盖口。
#
# ── 为什么每个节点要有自己的配置根（不是一个共用） ──────────────────────────
# 审计链是**按配置根**落一个文件的（`occConfigPath('qianmo','audit','trail.ndjson')`，
# 见 src/services/qianmo/auditTrail.ts）。两个常驻进程共用一个配置根，就是两条哈希链
# 交替写进同一个文件，`occ audit --verify` 必然报断链——而那时候你会去查「谁改了审计
# 文件」，其实只是拓扑搭错了。节点身份（`qianmo/identity/<node>.json`）与常驻会话表
# 同理。真实部署里两个节点本来就在两台机器上、各有各的配置根，这里只是把它复刻出来。

# shellcheck shell=bash

# 被 source 时 BASH_SOURCE[0] 是本文件路径。
QIANMO_DEMO_ENV_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$QIANMO_DEMO_ENV_DIR/../.." && pwd)"
export REPO_DIR

# 演示根目录。默认落在仓库里（`.demo-env` 已进 .gitignore），换位置只需改这个变量。
DEMO_ROOT="${QIANMO_DEMO_ROOT:-$REPO_DIR/.demo-env}"

# 拓扑参数：改这些不用改脚本。
DEMO_HOST="${QIANMO_DEMO_HOST:-127.0.0.1}"
DEMO_REGISTRY_PORT="${QIANMO_DEMO_REGISTRY_PORT:-38610}"
DEMO_NODE_A="${QIANMO_DEMO_NODE_A:-node-a}"
DEMO_NODE_B="${QIANMO_DEMO_NODE_B:-node-b}"
DEMO_AGENT_A="${QIANMO_DEMO_AGENT_A:-planner}"
DEMO_AGENT_B="${QIANMO_DEMO_AGENT_B:-reviewer}"
DEMO_PORT_A="${QIANMO_DEMO_NODE_A_PORT:-38611}"
DEMO_PORT_B="${QIANMO_DEMO_NODE_B_PORT:-38612}"
DEMO_TEAM="${QIANMO_DEMO_TEAM:-atlas}"

DEMO_ADDR_A="qianmo://${DEMO_NODE_A}/${DEMO_AGENT_A}"
DEMO_ADDR_B="qianmo://${DEMO_NODE_B}/${DEMO_AGENT_B}"
DEMO_ENDPOINT_A="ws://${DEMO_HOST}:${DEMO_PORT_A}"
DEMO_ENDPOINT_B="ws://${DEMO_HOST}:${DEMO_PORT_B}"
DEMO_REGISTRY_URL="http://${DEMO_HOST}:${DEMO_REGISTRY_PORT}"

# 目录布局。改这里等于改全套脚本。
DEMO_RUN_DIR="$DEMO_ROOT/run"
DEMO_LOG_DIR="$DEMO_ROOT/logs"
DEMO_STATE_DIR="$DEMO_ROOT/state"
DEMO_SECRET_DIR="$DEMO_ROOT/secrets"
DEMO_WORKSPACE_DIR="$DEMO_ROOT/workspaces"
DEMO_NODES_DIR="$DEMO_ROOT/nodes"
DEMO_MARKER="$DEMO_ROOT/.qianmo-demo-env"
DEMO_MARKER_MAGIC='qianmo-demo-env/v1'

# 每个节点的配置根（见文件头注释）。registry 也给一个，它的落盘表在里面。
DEMO_CONFIG_A="$DEMO_NODES_DIR/$DEMO_NODE_A/config"
DEMO_CONFIG_B="$DEMO_NODES_DIR/$DEMO_NODE_B/config"
DEMO_CONFIG_REGISTRY="$DEMO_NODES_DIR/registry/config"

DEMO_PSK_FILE="$DEMO_SECRET_DIR/transport-psk"
DEMO_BACKUP_WRITE_FILE="$DEMO_SECRET_DIR/backup-write-token"
DEMO_BACKUP_ARCHIVE_FILE="$DEMO_SECRET_DIR/backup-archive-token"

# ── 输出与计时 ───────────────────────────────────────────────────────────────

demo_say()  { printf '%s\n' "$*"; }
demo_head() { printf '\n=== %s ===\n' "$*"; }
demo_ok()   { printf 'OK   : %s\n' "$*"; }
demo_warn() { printf 'WARN : %s\n' "$*"; }
demo_die()  { printf 'FAIL : %s\n' "$*" >&2; exit 1; }

# 秒级时刻。`date +%s` 到处都有，不引 GNU 专有格式。
demo_now() { date +%s; }

# demo_elapsed <起始秒> —— 打印形如 `1m12s` 的耗时。
demo_elapsed() {
  local total=$(( $(demo_now) - $1 ))
  printf '%dm%02ds' $((total / 60)) $((total % 60))
}

# ── 安全守卫 ─────────────────────────────────────────────────────────────────

# 演示根目录必须是「我们自己造的、专门的」目录。
# 一键重置会 rm -rf 它下面的东西，所以这道检查是它的全部安全性所在：
# 拒绝根目录、家目录、仓库本身，以及任何真实配置根的内部。
demo_guard_root() {
  local root="$1"
  case "$root" in
    /|/root|/home|/Users) demo_die "DEMO_ROOT 不能是 $root" ;;
  esac
  [ -n "$root" ] || demo_die 'DEMO_ROOT 为空'
  if [ "$root" = "$HOME" ]; then demo_die 'DEMO_ROOT 不能是家目录'; fi
  if [ "$root" = "$REPO_DIR" ]; then demo_die 'DEMO_ROOT 不能是仓库根本身'; fi
  case "$root" in
    "$HOME"/.occ|"$HOME"/.occ/*|"$HOME"/.qianmo|"$HOME"/.qianmo/*|"$HOME"/.claude|"$HOME"/.claude/*)
      demo_die "DEMO_ROOT 落在真实配置根里：$root"
      ;;
  esac
  # 用户若用 OCC_CONFIG_DIR / CLAUDE_CONFIG_DIR 把真实配置根挪到了别处，上面那三个
  # 字面量就拦不住——这里按调用方进入本脚本时的环境再拦一次（演示自己的按节点
  # OCC_CONFIG_DIR 是之后由 demo_node_env 设的，不会走到这里）。
  local outer
  for outer in "${OCC_CONFIG_DIR:-}" "${CLAUDE_CONFIG_DIR:-}"; do
    [ -n "$outer" ] || continue
    case "$root" in
      "$outer"|"$outer"/*) demo_die "DEMO_ROOT 落在当前环境的真实配置根里：$root（$outer）" ;;
    esac
  done
  return 0
}

# 标记文件在，才认这个目录是演示环境。
# 没有标记就拒绝——不去猜「这大概是我上次建的」，猜错一次就是删了别人的目录。
demo_require_marker() {
  demo_guard_root "$DEMO_ROOT"
  [ -f "$DEMO_MARKER" ] || demo_die "$DEMO_ROOT 不是演示环境（缺 $DEMO_MARKER）——先跑 demo/env/seed.sh"
  head -1 "$DEMO_MARKER" | grep -qF "$DEMO_MARKER_MAGIC" \
    || demo_die "$DEMO_MARKER 的首行不是 $DEMO_MARKER_MAGIC，拒绝操作"
  return 0
}

# ── 隔离环境 ─────────────────────────────────────────────────────────────────

# demo_export_common —— 所有子进程共用的环境。
# `OCC_CONFIG_DIR` 在这里**故意不设**：它按节点分（见文件头），由调用方用
# demo_node_env 逐个设。谁想跑一次性工具，自己挑一个节点的配置根。
demo_export_common() {
  export OCC_IDENTITY=qianmo
  if [ -z "${QIANMO_TRANSPORT_PSK:-}" ] && [ -f "$DEMO_PSK_FILE" ]; then
    QIANMO_TRANSPORT_PSK="$(cat "$DEMO_PSK_FILE")"
    export QIANMO_TRANSPORT_PSK
  fi
  if [ -z "${QIANMO_BACKUP_WRITE_TOKEN:-}" ] && [ -f "$DEMO_BACKUP_WRITE_FILE" ]; then
    QIANMO_BACKUP_WRITE_TOKEN="$(cat "$DEMO_BACKUP_WRITE_FILE")"
    export QIANMO_BACKUP_WRITE_TOKEN
  fi
  if [ -z "${QIANMO_BACKUP_ARCHIVE_TOKEN:-}" ] && [ -f "$DEMO_BACKUP_ARCHIVE_FILE" ]; then
    QIANMO_BACKUP_ARCHIVE_TOKEN="$(cat "$DEMO_BACKUP_ARCHIVE_FILE")"
    export QIANMO_BACKUP_ARCHIVE_TOKEN
  fi
}

# demo_random_hex <字节数> —— 生成一串随机 hex，用作**演示专用**密钥。
#
# 用 `od -N` 而不是 `tr -dc ... | head -c`：后者会让 head 先退出、tr 吃到 SIGPIPE，
# 在 `set -o pipefail` 下整条脚本当场以 141 退出。这不是洁癖，是踩过的形状。
demo_random_hex() {
  local bytes="$1"
  if [ -r /dev/urandom ]; then
    LC_ALL=C od -An -tx1 -N "$bytes" /dev/urandom | tr -d ' \n'
    printf '\n'
    return 0
  fi
  bun -e 'process.stdout.write(Buffer.from(crypto.getRandomValues(new Uint8Array(Number(process.argv[1])))).toString("hex")+"\n")' "$bytes"
}

# demo_pidfile <名字> / demo_logfile <名字> <out|err>
demo_pidfile() { printf '%s/%s.pid' "$DEMO_RUN_DIR" "$1"; }
demo_logfile() { printf '%s/%s.%s' "$DEMO_LOG_DIR" "$1" "$2"; }

# demo_running <名字> —— pid 文件里的进程还活着吗。
demo_running() {
  local file
  file="$(demo_pidfile "$1")"
  [ -f "$file" ] || return 1
  local pid
  pid="$(cat "$file" 2>/dev/null || true)"
  [ -n "$pid" ] || return 1
  kill -0 "$pid" 2>/dev/null
}

# demo_stop_one <名字> —— 先 TERM，10 s 不走再 KILL。
demo_stop_one() {
  local name="$1" file pid i
  file="$(demo_pidfile "$name")"
  [ -f "$file" ] || return 0
  pid="$(cat "$file" 2>/dev/null || true)"
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    kill -TERM "$pid" 2>/dev/null || true
    i=0
    while kill -0 "$pid" 2>/dev/null && [ "$i" -lt 10 ]; do
      sleep 1
      i=$((i + 1))
    done
    if kill -0 "$pid" 2>/dev/null; then
      demo_warn "$name (pid $pid) 未响应 SIGTERM，改用 SIGKILL"
      kill -KILL "$pid" 2>/dev/null || true
    fi
    demo_say "已停止 $name (pid $pid)"
  fi
  rm -f "$file"
}

# occ 的构建产物。bootstrap.sh 负责把它造出来。
DEMO_OCC="$REPO_DIR/dist/cli-node.js"

# demo_require_occ —— 没有构建产物就明确报错，不去猜。
demo_require_occ() {
  [ -f "$DEMO_OCC" ] || demo_die "缺 $DEMO_OCC —— 先跑 demo/env/bootstrap.sh"
}
