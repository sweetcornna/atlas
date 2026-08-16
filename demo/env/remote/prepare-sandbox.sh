#!/usr/bin/env bash
# Copyright 2026 Qianmo AgentNest Team
# SPDX-License-Identifier: MIT
#
# 阡陌 P8.1 —— 真机腿：**沙箱内**把常驻节点拉起来。
#
#   # 在沙箱里（不是宿主上）：
#   QIANMO_TRANSPORT_PSK=<与宿主同一把> \
#   QIANMO_REMOTE_ACTIVITY_URL=ws://<宿主地址>:<activity 端口> \
#   demo/env/remote/prepare-sandbox.sh --node node-b --agent reviewer --port 38622
#
# ⚠️ **本脚本未在真机验证**（同 prepare-host.sh，原因见 README.md）。它把
# `demo/p41-task-result.sh` / `demo/p31-resident-wake.sh` 头注里对「沙箱内那半边」的
# 要求写成了可执行步骤，但没有在真沙箱里跑过。
#
# 为什么这一步必须在沙箱里手动做：activator 的能力面只有 acquire / list 两个动作，
# **没有 exec**——这不是偷懒，正是 AC-6(c) 依赖的那条边界（见 packages/activator）。
# 宿主永远不能替沙箱把进程拉起来。
#
# 起来之后，把下面两件事告诉宿主：
#   ① 沙箱在 daemon 里的 name  → QIANMO_AC2_SANDBOX
#   ② 本进程的监听地址（宿主视角，容器地址不是回环）→ QIANMO_AC2_TARGET_URL

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="${QIANMO_REPO_DIR:-$(cd "$SCRIPT_DIR/../../.." && pwd)}"

NODE='node-b'
AGENT='reviewer'
PORT='38622'
WORKSPACE=''
SKIP_BUILD=0
FOREGROUND=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --node) NODE="$2"; shift 2 ;;
    --agent) AGENT="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --workspace) WORKSPACE="$2"; shift 2 ;;
    --skip-build) SKIP_BUILD=1; shift ;;
    --foreground) FOREGROUND=1; shift ;;
    -h|--help) sed -n '4,22p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) printf 'prepare-sandbox: 未知参数 %s\n' "$1" >&2; exit 2 ;;
  esac
done

say()  { printf '%s\n' "$*"; }
head1() { printf '\n=== %s ===\n' "$*"; }
die()  { printf 'FAIL : %s\n' "$*" >&2; exit 1; }

[ -n "${QIANMO_TRANSPORT_PSK:-}" ] || die '缺 QIANMO_TRANSPORT_PSK（必须与宿主那把逐字相同）'

# 沙箱里的状态一律放沙箱本地目录，不去猜宿主挂了什么进来。
SANDBOX_ROOT="${QIANMO_SANDBOX_DEMO_ROOT:-$HOME/.qianmo-demo-sandbox}"
CONFIG_DIR="$SANDBOX_ROOT/config"
STATE_DIR="$SANDBOX_ROOT/state"
[ -n "$WORKSPACE" ] || WORKSPACE="$SANDBOX_ROOT/workspace"

head1 '1. 前置检查'
command -v bun >/dev/null 2>&1 || die 'bun 不在 PATH 上。装法见 docs/dev/demo-env.md §2（沙箱镜像里通常要自己装）'
say "bun  : $(bun --version)"
BUN_PIN="$(awk '$1 == "bun" { print $2 }' "$REPO_DIR/.tool-versions" 2>/dev/null || true)"
if [ -n "$BUN_PIN" ] && [ "$(bun --version)" != "$BUN_PIN" ]; then
  say "WARN : bun 与 .tool-versions 的 $BUN_PIN 不一致 —— 跨架构沙箱里这很常见，记录进验收报告"
fi
[ -d "$REPO_DIR/packages/resident" ] || die "$REPO_DIR 看起来不是阡陌仓库"

head1 '2. 依赖与构建'
cd "$REPO_DIR"
bun install --frozen-lockfile
if [ "$SKIP_BUILD" = '1' ]; then
  say '按 --skip-build 跳过构建'
else
  bun run build
fi
OCC="$REPO_DIR/dist/cli-node.js"
[ -f "$OCC" ] || die "缺 $OCC"

head1 '3. 目录'
mkdir -p "$CONFIG_DIR" "$STATE_DIR" "$WORKSPACE"
chmod 700 "$SANDBOX_ROOT" "$CONFIG_DIR"
say "配置根 : $CONFIG_DIR"
say "工作区 : $WORKSPACE"

head1 '4. 启动常驻节点'
TIMINGS="$STATE_DIR/resident-timings.jsonl"
set -- resident \
  --node "$NODE" \
  --team "${QIANMO_DEMO_TEAM:-atlas}" \
  --agent "${AGENT}=${WORKSPACE}" \
  --port "$PORT" \
  --hostname "${QIANMO_REMOTE_BIND:-0.0.0.0}" \
  --timings "$TIMINGS"
# activity 上报是「沙箱内有活干 → 宿主别让我冻上」这条链路的沙箱半边（P3.1）。
# 没给就不接，节点照样能跑，只是不会自己保活。
if [ -n "${QIANMO_REMOTE_ACTIVITY_URL:-}" ]; then
  set -- "$@" --activity-url "$QIANMO_REMOTE_ACTIVITY_URL"
else
  say 'WARN : 未给 QIANMO_REMOTE_ACTIVITY_URL —— 不上报活动，沙箱会照常冻结'
fi

say "命令 : occ $*"
if [ "$FOREGROUND" = '1' ]; then
  exec env OCC_CONFIG_DIR="$CONFIG_DIR" OCC_IDENTITY=qianmo bun "$OCC" "$@"
fi

OUT="$STATE_DIR/resident.out"
ERR="$STATE_DIR/resident.err"
OCC_CONFIG_DIR="$CONFIG_DIR" OCC_IDENTITY=qianmo nohup bun "$OCC" "$@" >"$OUT" 2>"$ERR" &
PID=$!
printf '%s\n' "$PID" >"$STATE_DIR/resident.pid"
sleep 3
kill -0 "$PID" 2>/dev/null || { tail -20 "$ERR" >&2; die '常驻节点未能保持运行'; }

head1 '就绪'
say "pid     : $PID"
say "stdout  : $OUT （首行含本节点公钥，P4.3 的 --trust 要用）"
say "timings : $TIMINGS （p31/p41 的独立核验从这里取）"
say ''
say '回宿主设置：'
say "  QIANMO_AC2_TARGET_URL=ws://<本沙箱在宿主视角的地址>:${PORT}"
say '  QIANMO_AC2_SANDBOX=<本沙箱在 daemon 里的 name>'
say "  QIANMO_AC2_NODE=${NODE}  QIANMO_AC2_AGENT=${AGENT}"
