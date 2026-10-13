#!/usr/bin/env bash
# Copyright 2026 Qianmo AgentNest Team
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# 阡陌内测 · 第六类动作在节点上的入口（`providers-console-m1.md` §2.5，P18.6）。
#
#   model-apply.sh <节点名> [--root <绝对路径>] # stdin 一行请求 JSON，stdout 一行响应 JSON
#
# 它只在两处被调用，调用方式一样：
#   · 节点 `~/.ssh/authorized_keys` 里中枢那把**模型服务专用 key** 的强制命令：
#       command="<部署根>/demo/env/beta/ops/model-apply.sh <节点名>",restrict <公钥>
#   · 中枢同机的节点：控制台的 local 执行器直接起它（`--provider-local <节点>=<本文件>`）。
#
# 做的事只有一件：在这个节点的配置根下跑 `qm provider serve-stdin --node <节点名>`，
# 让 stdin 原样流进去、stdout 原样流出来。**本脚本不读 stdin**：密钥在那一行里，过一道
# shell 就多一处可能落进日志、`ps` 或临时文件的地方。
#
# ── 不认 SSH_ORIGINAL_COMMAND ──────────────────────────────────────────────────
# 强制命令下，客户端发来的命令落在 SSH_ORIGINAL_COMMAND 里。中枢发的是一个不存在的
# 哨兵（`qianmo-model-apply-v1`），它的用处在 sshd 那一侧：这一行丢了时 sshd 去执行
# 哨兵、失败，而不是静默成功。**这里一个字都不读它**，第一件事就是 unset：节点名与
# 操作只来自强制命令里写死的参数和 stdin 那一行协议请求，拿着这把 key 的人改不了
# 「对哪个节点、跑什么程序」。
#
# ── 退出码（中枢执行器的约定，`consoleProvidersExec.ts`）────────────────────────
#   0 / 1   子进程的退出码原样带出：协议响应 ok:true / ok:false。本脚本自己拒绝时也回
#           一行 ok:false 的协议响应（requestId 为 null）并退 1，原因写在 message 里：
#             bad-request  参数个数不对、节点名不合法、这个节点没有配置根；
#             busy         本机另一个模型服务操作还没结束（主机锁超时）。
#   2       没有协议响应：bun 或构建产物不在。原因写 stderr，中枢只报「节点没有回协议
#           响应」，不转述 stderr。
#
# ── 同一主机串行 ───────────────────────────────────────────────────────────────
# 同一服务账号的所有入口固定共享 $HOME/.qianmo-model-apply-host.lock。
# 固定等待 20 秒，锁位置、等待时间与后端均不接受环境变量覆盖。
# 从固定系统路径选 flock，没有（macOS）用 mkdir；后代不继承锁 fd。

set -euo pipefail

unset SSH_ORIGINAL_COMMAND

# 本脚本自己的拒绝：一行协议响应（requestId 为 null，与节点解析不了请求时同形），退 1。
# message 是固定的中文句子，不插入任何来自调用方的字符串，所以不用 JSON 转义。
reply_refused() {
  printf '{"v":1,"requestId":null,"ok":false,"code":"%s","message":"%s"}\n' "$1" "$2"
  exit 1
}

if [ "${1:-}" = --help ] || [ "${1:-}" = -h ]; then
  # Help prints the variable name literally.
  # shellcheck disable=SC2016
  printf '用法：model-apply.sh <节点名> [--root <绝对路径>]\n主机共享锁：$HOME/.qianmo-model-apply-host.lock（固定位置），固定等待 20 秒。\n'
  exit 0
fi
if [ "$#" -ne 1 ] && { [ "$#" -ne 3 ] || [ "${2:-}" != --root ] || [ -z "${3:-}" ]; }; then
  reply_refused bad-request 'model-apply.sh 收节点名和可选的 --root 绝对路径'
fi
node="$1"

# 协议的节点名规则（`[a-z0-9-]{1,32}`，`packages/providers` 的 parseProviderRequest）。
# 字符逐个枚举、不用 `[a-z]` 范围：范围在某些 locale 下会穿透（common.sh 的
# beta_assert_node_name 头注）。
case "$node" in
  '' | *[!abcdefghijklmnopqrstuvwxyz0123456789-]*)
    reply_refused bad-request '节点名不合法：只收小写字母、数字和 -'
    ;;
esac
if [ "${#node}" -gt 32 ]; then
  reply_refused bad-request '节点名不合法：超过 32 个字符'
fi

# shellcheck source=demo/env/beta/common.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/common.sh"

if ! (beta_guard_root "$BETA_ROOT") >/dev/null 2>&1; then
  reply_refused bad-request '内测根不合法或落在受保护目录'
fi
config_dir="$BETA_NODES_DIR/$node/config"
# 节点的配置根由 beta-up.sh 的节点腿建出来；不在就说明这台机器上没有这个节点，
# 不替它建一个空的——那会让 serve-stdin 在一个谁都不读的配置根里「成功」下发。
if [ ! -d "$config_dir" ] || [ -L "$BETA_NODES_DIR" ] || [ -L "$BETA_NODES_DIR/$node" ] || [ -L "$config_dir" ]; then
  reply_refused bad-request '这台机器上没有这个节点的配置根'
fi

# 非交互 sshd 的 PATH 里通常没有 ~/.bun/bin（2026-08-24 舰队部署踩过，common.sh 的
# beta_require_qm 头注）。先 PATH，再家目录下的默认安装位置。
bun_bin="$(command -v bun 2>/dev/null || true)"
if [ -z "$bun_bin" ] && [ -x "$HOME/.bun/bin/bun" ]; then
  bun_bin="$HOME/.bun/bin/bun"
fi
if [ -z "$bun_bin" ]; then
  printf 'model-apply.sh：找不到 bun（PATH 与 ~/.bun/bin 都没有）\n' >&2
  exit 2
fi
if [ ! -f "$BETA_QM_BIN" ] && [ ! -f "$BETA_QM_SRC" ]; then
  printf 'model-apply.sh：缺 qm：既没有 %s 也没有 %s\n' "$BETA_QM_BIN" "$BETA_QM_SRC" >&2
  exit 2
fi
# 源码形态下用上面找到的 bun 绝对路径（PATH 里可能没有）；编译产物直接执行。
qm_cmd=("${BETA_QM[@]}")
if [ "${qm_cmd[0]}" = bun ]; then qm_cmd[0]="$bun_bin"; fi

# These choices must survive the console executor's environment allowlist. HOME is
# the service account's login home at all three entrypoints; different roots share it.
lock_wait=20
lock="$HOME/.qianmo-model-apply-host.lock"
[ ! -L "$lock" ] && [ ! -L "$lock.d" ] && [ ! -L "$lock.guard" ] || reply_refused bad-request '主机锁不能是软链'
umask 077
flock_bin="$(beta_model_flock)"
lock_mode='mkdir'
if [ -n "$flock_bin" ]; then lock_mode='flock'; fi

if [ "$lock_mode" = flock ]; then
  exec 9>>"$lock"
  if ! "$flock_bin" -w "$lock_wait" 9; then
    reply_refused busy '本机另一个模型服务操作还没结束（主机锁超时）'
  fi
else
  lock_dir="$lock.d"
  guard_dir="$lock.guard"
  deadline=$(($(date +%s) + lock_wait))
  # Serialize mkdir acquisition, stale reclamation and release themselves. Without this
  # guard, two reclaimers can unlink the new owner's pid after the old owner has exited.
  while :; do
    acquired=0
    if mkdir "$guard_dir" 2>/dev/null; then
      if mkdir "$lock_dir" 2>/dev/null; then
        printf '%s\n' "$$" >"$lock_dir/pid"
        acquired=1
      else
        holder="$(cat "$lock_dir/pid" 2>/dev/null || true)"
        case "$holder" in
          '' | *[!0123456789]*) ;;
          *)
            if ! kill -0 "$holder" 2>/dev/null; then
              unlink "$lock_dir/pid" 2>/dev/null || true
              if rmdir "$lock_dir" 2>/dev/null && mkdir "$lock_dir" 2>/dev/null; then
                printf '%s\n' "$$" >"$lock_dir/pid"
                acquired=1
              fi
            fi ;;
        esac
      fi
      rmdir "$guard_dir"
    fi
    [ "$acquired" = 0 ] || break
    if [ "$(date +%s)" -ge "$deadline" ]; then
      reply_refused busy '本机另一个模型服务操作还没结束（主机锁超时）'
    fi
    sleep 0.1
  done
  # shellcheck disable=SC2329
  #   ↑ 由下面的 trap 调用。
  release() {
    # Never touch a replacement lock. A stuck guard fails closed and needs operator cleanup.
    local until_time
    until_time=$(($(date +%s) + lock_wait))
    while ! mkdir "$guard_dir" 2>/dev/null; do
      [ "$(date +%s)" -lt "$until_time" ] || return 0
      sleep 0.1
    done
    if [ "$(cat "$lock_dir/pid" 2>/dev/null || true)" = "$$" ]; then
      unlink "$lock_dir/pid" 2>/dev/null || true
      rmdir "$lock_dir" 2>/dev/null || true
    fi
    rmdir "$guard_dir" 2>/dev/null || true
  }
  trap release EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM
fi

status=0
QIANMO_CONFIG_DIR="$config_dir" \
  "${qm_cmd[@]}" provider serve-stdin --node "$node" 9>&- || status=$?
exit "$status"
