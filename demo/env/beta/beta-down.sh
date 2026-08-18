#!/usr/bin/env bash
# Copyright 2026 Qianmo AgentNest Team
# SPDX-License-Identifier: MIT
#
# 阡陌 P11.1 落地包① —— 停掉本机那部分内测拓扑。**只停进程，不删任何数据。**
#
#   demo/env/beta/beta-down.sh              # 停本机 run/ 下所有登记在案的进程
#   demo/env/beta/beta-down.sh <名字>...     # 只停指定的那几个（§6 L0 的第①步）
#
# 停机顺序是**控制台 → 节点 → 注册中心**，与 beta-up.sh 的起机顺序（注册中心 → 节点 →
# 控制台，§7.1）严格相反。反过来的话，节点在最后几秒会对着一个已经没了的注册中心重试，
# 日志里凭空多出一段谁都不需要解释的报错；而控制台是用户唯一看得见的面，它该第一个下、
# 最后一个上（§7.1 的同一条理由，倒过来用）。
#
# 三重守卫在这里也全套具备：guard_root（common.sh）→ 标记文件首行 → 每个 pid 文件路径
# 逐个复核在根目录之内（beta_stop_one 里的 beta_assert_inside_root）。停进程虽然不删数据，
# 但它会 `kill` 一个从文件里读来的 pid ——那同样是一个「读错文件就打错人」的动作。
#
# 想连运行态一起清，用 demo/env/beta/beta-reset.sh。

set -euo pipefail

# shellcheck source=demo/env/beta/common.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

for option in "$@"; do
  case "$option" in
    -h|--help)
      beta_say '用法：beta-down.sh [进程名...]（不给名字 = 停本机全部）'
      beta_say '进程名就是 run/<名字>.pid 里的那个：registry / console / <节点名>。'
      exit 0
      ;;
  esac
done

beta_require_marker

# 只给了名字就停那几个。§6 L0 的「只停这一个，不动别的节点」走的是这条。
if [ "$#" -gt 0 ]; then
  beta_head '停止指定进程'
  for name in "$@"; do
    if ! beta_running "$name"; then beta_say "$name 本来就没在跑"; fi
    # 无论如何都跑一遍：它顺带清掉一个指向已死进程的陈旧 pid 文件。
    # 留着不致命（beta_running 会 kill -0 复核），但下次 down 会再报一次「没在跑」，
    # 而 pid 号是会被系统复用的——对着一个复用号做 kill -0 就是一次误判。
    beta_stop_one "$name"
  done
  beta_head '已停机'
  beta_say "数据仍在 : $BETA_ROOT"
  exit 0
fi

# 不给名字：按停机顺序扫 run/ 下的 pid 文件。
# 用 `for f in dir/*.pid` 而不是 `find | while read`：后者的管道会开子 shell，
# 而且 bash 3.2 没有 mapfile（macOS 自带的就是 3.2）。glob 没匹配到时 bash 会把
# 模式原样留下，所以下面逐个 `[ -f ]` 复核。
collect_others() {
  local file base
  for file in "$BETA_RUN_DIR"/*.pid; do
    [ -f "$file" ] || continue
    base="$(basename "$file" .pid)"
    case "$base" in
      "$BETA_CONSOLE_PROC"|"$BETA_REGISTRY_PROC") continue ;;
    esac
    printf '%s\n' "$base"
  done
}

beta_head '停止控制台'
beta_stop_one "$BETA_CONSOLE_PROC"

beta_head '停止常驻节点'
STOPPED_ANY=0
for name in $(collect_others); do
  beta_stop_one "$name"
  STOPPED_ANY=1
done
if [ "$STOPPED_ANY" = '0' ]; then
  beta_say '本机没有登记在案的常驻节点（H 上是正常的：H 自己不跑常驻，§2.2）'
fi

beta_head '停止注册中心'
beta_stop_one "$BETA_REGISTRY_PROC"
rm -f "$BETA_RUN_DIR/registry-ready.json"

beta_head '已停机'
beta_say "数据仍在 : $BETA_ROOT"
beta_say "审计链   : 一条没动 —— 它「只能挪走、不能撤销」（beta-env.md §6.4）"
beta_say '再次启动 : demo/env/beta/beta-up.sh --role host|node'
