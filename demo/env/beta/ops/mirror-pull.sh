#!/usr/bin/env bash
# Copyright 2026 Qianmo AgentNest Team
# SPDX-License-Identifier: MIT
#
# 阡陌内测 · 把一个节点的审计链**单向只读**拉到 H 的 mirror/<node>/trail.ndjson。
#
#   mirror-pull.sh <node>
#
# **这个文件由 `beta-up.sh --role host` 从仓库拷进 <内测根>/ops/。**改那一份没有意义
# ——下一次 beta-up.sh 会照仓库这一份覆盖它。要改就改 demo/env/beta/ops/mirror-pull.sh。
#
# 权威副本永远是节点本机那一份（beta-env.md §4.3）；这里拉到 H 的是镜像，用途只有两个：
# 出事时四条链摆在一起看，以及给 P11.4 的锚定留取样点。**页面上必须能看出它是镜像**：
# H 腿从 peers.conf 派生命名 --audit 与 --audit-mirror 参数，来源卡片显示镜像与允许滞后；
# console.conf 只保存页头标签。
#
# 方向纪律：**只从节点拉，绝不往节点推。**
#
# ── 为什么只剩 `ssh cat` 一条路径（原先几台走 rsync）───────────────────────────
# H 的那把 key 在四台节点的 authorized_keys 里现在带**强制命令**：
#     restrict,port-forwarding,permitopen="127.0.0.1:<入站端口>",command="/usr/bin/cat -- <链>"
# 强制命令会**忽略客户端发来的命令**，于是 rsync 协商不到远端的 `rsync --server --sender`，
# 必然挂在握手上。这不是退化——它正是这把 key 被收紧的证据：它连自己那条审计链之外的
# 任何东西都读不到。链文件只有 KB 量级，全量 cat 无代价。
#
# 下面那条 ssh 仍把 `cat -- <链>` 作为远端命令发过去：**在强制命令下它是空转**
# （只会落进 SSH_ORIGINAL_COMMAND），但万一哪天选项行被回退，这个脚本照旧是对的。

set -euo pipefail

node="${1:?用法：mirror-pull.sh <node>}"

# 内测根从**本脚本自己的位置**推，不从 $HOME 拼：systemd 单元里这个脚本的路径就是
# <内测根>/ops/mirror-pull.sh，所以 QIANMO_BETA_ROOT 换到哪里，这里跟着换。
# 写死 $HOME/qianmo-beta 的版本在一个非默认根的机器上会安静地拉进错误的目录。
OPS_DIR="$(cd "$(dirname "$0")" && pwd)"
BETA_ROOT="$(cd "$OPS_DIR/.." && pwd)"

env_file="$OPS_DIR/tunnel-$node.env"
[ -f "$env_file" ] || {
  printf '缺 %s —— 它由 beta-up.sh 从 peers.conf 的 node 坐标行派生\n' "$env_file" >&2
  exit 1
}
# shellcheck disable=SC1090
#   ↑ 路径按参数拼，shellcheck 无法静态跟进；文件是本脚本的同伴生成物、0600。
. "$env_file"
: "${NODE_SSH_USER:?}" "${NODE_SSH_HOST:?}" "${NODE_SSH_PORT:?}" "${NODE_SSH_KEY:?}" "${REMOTE_TRAIL:?}"

# MIRROR_METHOD 现在只有一个合法值。留着这个分支不是为了扩展性，是为了让「有人把
# rsync 写回去」当场报错并说明理由，而不是挂在 ssh 握手上等到超时。
case "${MIRROR_METHOD:-cat}" in
  cat) ;;
  rsync)
    printf 'MIRROR_METHOD=rsync 已不可用：这把 key 带强制命令，rsync 起不了远端 --sender。改成 cat。\n' >&2
    exit 1
    ;;
  *)
    printf '未知 MIRROR_METHOD=%s（只支持 cat）\n' "$MIRROR_METHOD" >&2
    exit 1
    ;;
esac

dest_dir="$BETA_ROOT/mirror/$node"
mkdir -p "$dest_dir"
dest="$dest_dir/trail.ndjson"
tmp="$dest.tmp.$$"
cleanup() { rm -f "$tmp"; }
trap cleanup EXIT

# shellcheck disable=SC2086
#   ↑ 选项串故意分词：它们是一串独立的 ssh 参数，不是一个带空格的值。
common_opts="-i $NODE_SSH_KEY -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15 -p $NODE_SSH_PORT"
# shellcheck disable=SC2086
ssh -n $common_opts "$NODE_SSH_USER@$NODE_SSH_HOST" "cat -- '$REMOTE_TRAIL'" >"$tmp"

# 空文件不覆盖：节点侧链文件还没建、或者强制命令读到了一个不存在的路径时，cat 会给
# 出零字节而 ssh 退出码仍是 0。覆盖上去就等于**用一次网络抖动抹掉整条镜像**，而
# `occ audit --verify` 对空文件不报错，页面上也看不出来。
[ -s "$tmp" ] || {
  printf '%s 拉到的是空文件，保留上一份镜像\n' "$node" >&2
  exit 1
}
chmod 600 "$tmp"
# 原子替换：`occ audit --verify` 永远不会读到半个文件。
mv -f "$tmp" "$dest"
printf '%s  %s  bytes=%s lines=%s\n' "$(date -u +%FT%TZ)" "$node" "$(wc -c <"$dest")" "$(wc -l <"$dest")"
