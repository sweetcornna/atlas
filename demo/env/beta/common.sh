#!/usr/bin/env bash
# Copyright 2026 Qianmo AgentNest Team
# SPDX-License-Identifier: MIT
#
# 阡陌 P11.1 落地包① —— 内测环境公共层。**被 source，不单独执行。**
#
# 这里定死四件事，其余脚本一律从这里取，不各写一份：
#   ① 内测根目录 BETA_ROOT 与它下面的目录布局（beta-env.md §4.1）；
#   ② 配置隔离——每个常驻进程一个 OCC_CONFIG_DIR，全都在 BETA_ROOT 里，
#      **绝不碰用户真实的 ~/.occ / ~/.qianmo / ~/.claude**；
#   ③ 端口、节点名、智能体名的默认值与环境变量覆盖口（beta-env.md §2.6）；
#   ④ 删除动作的三重守卫（guard_root + 标记文件首行 + 逐路径复核）。
#
# 它是 demo/env/common.sh 的**同形派生**：布局、守卫、pid/日志 helper 的形状一律照抄。
# 照抄不是偷懒——那套守卫已经用六个负向用例实测过（demo-env.md §3.2），重写一遍等于
# 把那六次实测作废。
#
# ── 为什么每个常驻进程要有自己的配置根（不是一个共用） ──────────────────────
# 审计链是**按配置根**落一个文件的（`occConfigPath('qianmo','audit','trail.ndjson')`，
# 见 src/services/qianmo/auditTrail.ts）。两个常驻进程共用一个配置根，就是两条哈希链
# 交替写进同一个文件，`occ audit --verify` 必然报断链——而那时候人会去查「谁改了审计
# 文件」，其实只是拓扑搭错了。节点身份（`qianmo/identity/<node>.json`）与常驻会话表
# 同理。内测是一机一节点，本来就天然分家；这一层仍然保留，是为了另外两件事：
#   · H 上不跑常驻，但注册中心与控制台各自也要一个配置根（注册表快照落
#     `<配置根>/registry/agents.json`，chat store 落 `<配置根>/qianmo/console/`）；
#   · L4 整机重建时「恢复配置根」是一个可以整目录 tar 的动作（beta-env.md §6 L4 第③步），
#     四台机器的路径形状不一致，那一步就没法照做。
#
# ── 与演示环境的四处不同（每一处都有代价，不要顺手统一回去） ────────────────
# ① **根目录默认在仓库外**（$HOME/qianmo-beta）。内测环境是长驻的：它要活过 `git clean`、
#    活过换分支、活过仓库被重新 clone。演示环境的 `.demo-env` 放仓库里，是因为它活 87 s。
# ② **PSK 绝不在本机自动生成。**演示环境的 seed.sh 会现生成一把，因为演示那两个节点在
#    同一台机器上、共用那一把。内测是**每节点一把、由 H 生成后分发**（beta-env.md §8.3）：
#    在节点机上自动生成，得到的是一个能起来、能监听、但 H 永远拨不通的节点——而它在名册
#    上还显示「在线」（§9.1）。这是本包里最容易造出来的那个坏形状，所以这里宁可起不来。
# ③ **reset 不删配置根，只改名归档。**配置根里装着审计链，而审计链「内测全程不清」（§5）、
#    「只能挪走不能撤销」（§6.4）。一个会 `rm -rf` 配置根的 reset 与那两条直接冲突，所以这里
#    把删改成 rename——那正是 §6 L2 第②步「改名成 config.bad-<ISO> ← 不删！」的动作。
# ④ **地址表落 $QIANMO_BETA_ROOT/peers.conf，不进仓库。**beta-env.md 文首那条「本文不写机器名 /
#    IP / SSH 别名 / 域名 / 任何一把真实密钥」对脚本同样成立：注册中心要 `--register
#    <地址>=<端点>`，而端点里有 IP。表放在根目录下（0600），仓库里只有一份带占位符的模板。

# shellcheck shell=bash
# shellcheck disable=SC2034
#   ↑ 本文件是被 source 的公共层：下面这些变量的消费者是 beta-up / beta-down /
#     beta-reset / beta-smoke 四个脚本，shellcheck 只能顺着 `source=` 往下看、看不到
#     反方向，于是每一个都报「appears unused」。demo/env/common.sh 有同样的 12 条
#     （已实测），差别只是那边没写这行注解。**只在本文件禁用它**，四个消费脚本仍然全开。

# 被 source 时 BASH_SOURCE[0] 是本文件路径。beta/ 在 demo/env/ 下面，所以仓库根是 ../../..。
QIANMO_BETA_ENV_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$QIANMO_BETA_ENV_DIR/../../.." && pwd)"
export REPO_DIR

# 内测根目录。**长驻**，默认在家目录下而不是仓库里（见文件头第①条）。
BETA_ROOT="${QIANMO_BETA_ROOT:-$HOME/qianmo-beta}"

# ── 拓扑参数：改这些不用改脚本 ───────────────────────────────────────────────
# 端口段 38620–38629，与演示环境的 38610–38613 不重叠——H 上可以同时留着演示拓扑
# （复现 AC 用）和内测拓扑，互不打架（beta-env.md §2.6）。
BETA_REGISTRY_PORT="${QIANMO_BETA_REGISTRY_PORT:-38620}"
BETA_CONSOLE_PORT="${QIANMO_BETA_CONSOLE_PORT:-38621}"
BETA_NODE_PORT="${QIANMO_BETA_NODE_PORT:-38625}"

# H 上这两个进程**永不出回环**：注册中心零鉴权（beta-env.md §9.2），控制台没有 TLS
# 也没有限流（§2.5），对外那一面由反向代理承担。把它们绑到非回环地址，等于把 §2.5
# 与 §9.2 两条硬规矩同时废掉。
BETA_HOST_BIND="${QIANMO_BETA_HOST_BIND:-127.0.0.1}"

# 节点入站绑哪。**默认 0.0.0.0，是有意的**：节点要被 H 拨到，而无 sudo 的 VPS 上没有
# 包过滤，38625 本来就必然对全网开放（beta-env.md §2.6）——那个端口上唯一的门是 PSK
# 握手，这也正是 §8 每节点一把 PSK 的由来。改成 127.0.0.1 会得到一个「起得来、名册上
# 在线、H 拨不通」的节点，即 §9.1 那条最会骗人的形状。本机自验时才覆盖它。
BETA_NODE_BIND="${QIANMO_BETA_NODE_BIND:-0.0.0.0}"

# 节点名与 agent 名一律是参数。这里给的是 beta-env.md §2.2 的定案默认值
# （节点名 beta-1~beta-4，名字里不含机器名与架构；agent 按用途分不按人分），
# 具体是哪一个由 `--node` / `--agent` 给。脚本里没有任何机器名、IP、域名、密钥。
BETA_NODE="${QIANMO_BETA_NODE:-beta-1}"
BETA_AGENTS="${QIANMO_BETA_AGENTS:-planner reviewer}"
BETA_TEAM="${QIANMO_BETA_TEAM:-atlas}"

# 控制台的两个单目标面。两者都钉死单值（`--audit` 见 §4.3、`--wake-url` 见 §8.2），
# 一期都指向同一个节点；把这条限制抬掉是落地包②，不是本包。
BETA_AUDIT_NODE="${QIANMO_BETA_AUDIT_NODE:-beta-1}"
BETA_WAKE_NODE="${QIANMO_BETA_WAKE_NODE:-$BETA_AUDIT_NODE}"

# 页头标签。它是唯一一个 50 个人都会看到、且不需要账号体系的广播位（§7.4）；
# 平时就写「审计视图是哪一条链」——不写等于让人以为那是全网的链（§4.3 最后一句）。
BETA_LABEL="${QIANMO_BETA_LABEL:-阡陌内测 · 审计视图：$BETA_AUDIT_NODE}"

# 备份快照间隔：内测期从默认 15 min 调到 60 min（§5 的定案，算过账的：15 min 间隔
# 是 3.8 GB/天，H 上既放不下也没人看）。代价是一次删库最多丢 60 min 的工作。
BETA_BACKUP_INTERVAL_MS="${QIANMO_BETA_BACKUP_INTERVAL_MS:-3600000}"
# 节点往 H 写快照的地址（§2.7，必须 https）。**没有默认值**：它是一个域名，按文首纪律
# 不进仓库；不设就不开备份面，脚本会明说。
BETA_BACKUP_URL="${QIANMO_BETA_BACKUP_URL:-}"

# ── 目录布局（beta-env.md §4.1）。改这里等于改全套脚本 ───────────────────────
BETA_RUN_DIR="$BETA_ROOT/run"
BETA_LOG_DIR="$BETA_ROOT/logs"
BETA_STATE_DIR="$BETA_ROOT/state"
BETA_SECRET_DIR="$BETA_ROOT/secrets"
BETA_PEER_SECRET_DIR="$BETA_SECRET_DIR/peers"
BETA_WORKSPACE_DIR="$BETA_ROOT/workspaces"
BETA_NODES_DIR="$BETA_ROOT/nodes"
BETA_MIRROR_DIR="$BETA_ROOT/mirror"
BETA_MARKER="$BETA_ROOT/.qianmo-beta-env"
BETA_MARKER_MAGIC='qianmo-beta-env/v1'

# 地址表（见文件头第④条）。0600，不进仓库。
BETA_PEERS_FILE="${QIANMO_BETA_PEERS_FILE:-$BETA_ROOT/peers.conf}"

# 每节点那一把 PSK（节点机上**只有本机这一把**，§8.3）。
BETA_PSK_FILE="$BETA_SECRET_DIR/transport-psk"
# 控制台两枚 token。**一律显式提供、绝不用自动生成的**（§3.2）：自动生成的每次重启都变，
# 而控制台会因为改 --label / 改 --audit / 跟随升级而重启，每重启一次 50 个人手上的链接
# 同时失效。落成文件就是「显式」的持久形式。
BETA_VIEW_TOKEN_FILE="$BETA_SECRET_DIR/console-view-token"
BETA_ADMIN_TOKEN_FILE="$BETA_SECRET_DIR/console-admin-token"
# 备份两枚 token。**归档 token 永不离开 H**（§2.7），所以节点机上只会有 write 那一份。
BETA_BACKUP_WRITE_FILE="$BETA_SECRET_DIR/backup-write-token"
BETA_BACKUP_ARCHIVE_FILE="$BETA_SECRET_DIR/backup-archive-token"

BETA_REGISTRY_URL="http://${BETA_HOST_BIND}:${BETA_REGISTRY_PORT}"
BETA_CONSOLE_URL="http://${BETA_HOST_BIND}:${BETA_CONSOLE_PORT}"

# H 上那两个不跑常驻的进程也各要一个配置根（见文件头）。
BETA_CONFIG_REGISTRY="$BETA_NODES_DIR/registry/config"
BETA_CONFIG_CONSOLE="$BETA_NODES_DIR/console/config"

# ── 审计链路径 ───────────────────────────────────────────────────────────────
#
# 权威副本永远是**节点本机**配置根里那一份；H 上 mirror/ 下那几份是单向只读镜像，
# 不是权威副本（beta-env.md §4.3 第三条）。哈希链在镜像上照样能验（验的是内容），
# 所以「链断了」在镜像上一样看得见——但「镜像滞后 N 分钟」在页面上看不出来，这正是
# 一期不把三条镜像链放进控制台页面的原因。
beta_node_trail()   { printf '%s/%s/config/qianmo/audit/trail.ndjson' "$BETA_NODES_DIR" "$1"; }
beta_mirror_trail() { printf '%s/%s/trail.ndjson' "$BETA_MIRROR_DIR" "$1"; }

# 控制台 `--audit` 指哪。默认指审计节点的**权威**路径（H 上有该节点配置根时成立，
# 例如 beta-1 的沙箱配置根挂到了 H 的文件系统里）；指镜像就把这个变量设成
# `$(beta_mirror_trail <node>)`。控制台只读本机文件、且 --audit 是单值（§4.3 的现状
# 限制），把它抬掉是落地包②。
BETA_AUDIT_PATH="${QIANMO_BETA_AUDIT_PATH:-$BETA_NODES_DIR/$BETA_AUDIT_NODE/config/qianmo/audit/trail.ndjson}"

# occ 的构建产物。与演示环境同一条：`bun run build` 产出，`demo/env/bootstrap.sh` 造。
BETA_OCC="$REPO_DIR/dist/cli-node.js"

# 进程名：pid 与日志文件都用它。节点腿那个是节点名本身（一机一节点，不会撞）。
BETA_REGISTRY_PROC='registry'
BETA_CONSOLE_PROC='console'

# ── 输出与计时 ───────────────────────────────────────────────────────────────

beta_say()  { printf '%s\n' "$*"; }
beta_head() { printf '\n=== %s ===\n' "$*"; }
beta_ok()   { printf 'OK   : %s\n' "$*"; }
beta_warn() { printf 'WARN : %s\n' "$*"; }
beta_todo() { printf 'TODO : %s\n' "$*"; }
beta_die()  { printf 'FAIL : %s\n' "$*" >&2; exit 1; }

# 秒级时刻。`date +%s` 到处都有，不引 GNU 专有格式（macOS 自带的 date 没有 `-d`）。
beta_now() { date +%s; }

# beta_elapsed <起始秒> —— 打印形如 `1m12s` 的耗时。
beta_elapsed() {
  local total=$(( $(beta_now) - $1 ))
  printf '%dm%02ds' $((total / 60)) $((total % 60))
}

# UTC 时间戳，用作归档目录后缀。冒号不进文件名（Windows 共享与 tar 上都会咬人）。
beta_stamp() { date -u '+%Y%m%dT%H%M%SZ'; }

# ── 守卫①：根目录本身 ───────────────────────────────────────────────────────
#
# 一键重置会在这个目录下面动东西，所以这道检查是它的全部安全性所在：
# 拒绝根目录、家目录、仓库本身，以及任何真实配置根的内部。
beta_guard_root() {
  local root="$1"
  [ -n "$root" ] || beta_die 'QIANMO_BETA_ROOT 为空'
  case "$root" in
    /*) ;;
    *) beta_die "QIANMO_BETA_ROOT 必须是绝对路径：$root" ;;
  esac
  case "$root" in
    *..*) beta_die "QIANMO_BETA_ROOT 里有 ..，拒绝：$root" ;;
  esac
  case "$root" in
    /|/root|/home|/Users|/tmp|/var|/etc|/usr|/opt|/srv)
      beta_die "QIANMO_BETA_ROOT 不能是 $root"
      ;;
  esac
  if [ "$root" = "$HOME" ]; then beta_die 'QIANMO_BETA_ROOT 不能是家目录'; fi
  if [ "$root" = "$REPO_DIR" ]; then beta_die 'QIANMO_BETA_ROOT 不能是仓库根本身'; fi
  case "$root" in
    "$HOME"/.occ|"$HOME"/.occ/*|"$HOME"/.qianmo|"$HOME"/.qianmo/*|"$HOME"/.claude|"$HOME"/.claude/*)
      beta_die "QIANMO_BETA_ROOT 落在真实配置根里：$root"
      ;;
  esac
  # 用户若用 OCC_CONFIG_DIR / CLAUDE_CONFIG_DIR 把真实配置根挪到了别处，上面那三个
  # 字面量就拦不住——这里按调用方进入本脚本时的环境再拦一次（内测自己的按节点
  # OCC_CONFIG_DIR 是之后由各腿逐个设的，不会走到这里）。
  local outer
  for outer in "${OCC_CONFIG_DIR:-}" "${CLAUDE_CONFIG_DIR:-}"; do
    [ -n "$outer" ] || continue
    case "$root" in
      "$outer"|"$outer"/*)
        beta_die "QIANMO_BETA_ROOT 落在当前环境的真实配置根里：$root（$outer）"
        ;;
    esac
  done
  # 内测机器上真的会有人拿同一台机器跑演示拓扑（H 上就是这么安排的，§2.6）。
  # 演示根目录被当成内测根目录传进来，后果是内测的 reset 去动演示环境的数据。
  if [ -f "$root/.qianmo-demo-env" ]; then
    beta_die "$root 是**演示**环境根（有 .qianmo-demo-env），不是内测环境根"
  fi
  return 0
}

# ── 守卫②：标记文件首行 ─────────────────────────────────────────────────────
#
# 标记文件在，才认这个目录是内测环境。没有标记就拒绝——不去猜「这大概是我上次建的」，
# 猜错一次就是动了别人的目录。
beta_require_marker() {
  beta_guard_root "$BETA_ROOT"
  [ -f "$BETA_MARKER" ] \
    || beta_die "$BETA_ROOT 不是内测环境（缺 $BETA_MARKER）——先跑 demo/env/beta/beta-up.sh"
  head -1 "$BETA_MARKER" | grep -qF "$BETA_MARKER_MAGIC" \
    || beta_die "$BETA_MARKER 的首行不是 $BETA_MARKER_MAGIC，拒绝操作"
  return 0
}

# ── 守卫③：逐路径复核 ───────────────────────────────────────────────────────
#
# 守卫写在删除 / 改名动作**旁边**，而不是只写在脚本开头——中间任何一次变量赋值出错，
# 这里都还能拦住。beta-down / beta-reset 的每一个待处理路径都要过它。
beta_assert_inside_root() {
  local target="$1"
  [ -n "$target" ] || beta_die '待处理路径为空，拒绝'
  case "$target" in
    "$BETA_ROOT"/*) ;;
    *) beta_die "拒绝处理 QIANMO_BETA_ROOT 之外的路径：$target" ;;
  esac
  case "$target" in
    *..*) beta_die "路径里有 ..，拒绝：$target" ;;
  esac
  return 0
}

# ── 目录骨架与标记 ───────────────────────────────────────────────────────────
#
# **不生成任何密钥**（见文件头第②条）。这里只铺目录、写标记、放一份地址表模板。
# 幂等：已在的东西一律不动。
beta_seed_root() {
  beta_guard_root "$BETA_ROOT"
  mkdir -p "$BETA_ROOT"
  chmod 700 "$BETA_ROOT"
  mkdir -p "$BETA_RUN_DIR" "$BETA_LOG_DIR" "$BETA_STATE_DIR" \
    "$BETA_WORKSPACE_DIR" "$BETA_NODES_DIR" "$BETA_MIRROR_DIR"
  mkdir -p "$BETA_SECRET_DIR" "$BETA_PEER_SECRET_DIR"
  chmod 700 "$BETA_SECRET_DIR" "$BETA_PEER_SECRET_DIR"

  if [ ! -f "$BETA_MARKER" ]; then
    {
      printf '%s\n' "$BETA_MARKER_MAGIC"
      printf 'created-at=%s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
      printf 'repo=%s\n' "$REPO_DIR"
      printf '# 这个文件是 demo/env/beta/beta-reset.sh 与 beta-down.sh 的安全依据：\n'
      printf '# 没有它，两个脚本都拒绝动这个目录里的任何东西。\n'
    } >"$BETA_MARKER"
    chmod 600 "$BETA_MARKER"
    beta_ok "标记文件已建：$BETA_MARKER"
  fi

  if [ ! -f "$BETA_PEERS_FILE" ]; then
    beta_write_peers_template
    beta_ok "地址表模板已建：$BETA_PEERS_FILE（**里面是占位符，要按运维单页填**）"
  fi
  return 0
}

# 地址表模板。**只有占位符**——真实机器名 / IP / 域名按 beta-env.md 文首的纪律
# 只存运维单页，不进仓库，也不由脚本猜。
beta_write_peers_template() {
  {
    printf '# 阡陌内测地址表 —— 注册中心的 --register 与冒烟的 --expect 都读它。\n'
    printf '#\n'
    printf '# 一行一条：<地址> <入站端点>，用空白分隔；# 开头是整行注释。\n'
    printf '# 地址形如 qianmo://<node>/<agent>，端点形如 ws://<节点机地址>:%s。\n' "$BETA_NODE_PORT"
    printf '#\n'
    printf '# 为什么长期地址必须写在这里、而不是在控制台页面上点「注册」：\n'
    printf '# 租约 TTL 90 s，InMemoryRegistry 在 restore 时按当前时钟重判租约、过期即丢，\n'
    printf '# 所以注册中心停机超过 90 s，落盘的 agents.json 就等于空文件——重启后回来的\n'
    printf '# 只有 --register 里那批（beta-env.md §2.4 的硬规矩）。\n'
    printf '#\n'
    printf '# 机器名 / IP / 域名不进仓库（beta-env.md 文首）：本文件 0600，只在 H 上。\n'
    printf '#\n'
    printf '# qianmo://<node>/<agent>  ws://<node-host>:%s\n' "$BETA_NODE_PORT"
  } >"$BETA_PEERS_FILE"
  chmod 600 "$BETA_PEERS_FILE"
}

# ── 地址表读取 ───────────────────────────────────────────────────────────────
#
# bash 3.2 没有关联数组（macOS 自带的就是 3.2），所以用三个平行的下标数组 +
# 一个计数器，而不是 map。`beta_peer_nodes` 的去重也因此用字符串包含判断。
BETA_PEER_COUNT=0
BETA_PEER_ADDR=()
BETA_PEER_EP=()
BETA_PEER_NODE=()

beta_load_peers() {
  BETA_PEER_COUNT=0
  BETA_PEER_ADDR=()
  BETA_PEER_EP=()
  BETA_PEER_NODE=()
  [ -f "$BETA_PEERS_FILE" ] || return 0
  # 变量名避开 `tail`：bash 的 local 是动态作用域，一个叫 tail 的变量读起来像是在
  # 覆盖那个命令（实际不会），而这个文件里真的有地方在用 tail 命令。
  local addr ep rest suffix node lineno=0
  # 重定向给 while 本体而不是用管道：管道会开子 shell，数组就赋不回来了。
  while read -r addr ep rest || [ -n "$addr" ]; do
    lineno=$((lineno + 1))
    case "$addr" in '' | \#*) continue ;; esac
    case "$addr" in
      qianmo://*/*) ;;
      *) beta_die "$BETA_PEERS_FILE 第 $lineno 行不是 qianmo://<node>/<agent>：$addr" ;;
    esac
    [ -n "$ep" ] || beta_die "$BETA_PEERS_FILE 第 $lineno 行缺入站端点：$addr"
    case "$ep" in
      ws://*|wss://*) ;;
      *) beta_die "$BETA_PEERS_FILE 第 $lineno 行的端点不是 ws:// 或 wss://：$ep" ;;
    esac
    suffix="${addr#qianmo://}"
    node="${suffix%%/*}"
    [ -n "$node" ] || beta_die "$BETA_PEERS_FILE 第 $lineno 行解析不出节点名：$addr"
    BETA_PEER_ADDR[BETA_PEER_COUNT]="$addr"
    BETA_PEER_EP[BETA_PEER_COUNT]="$ep"
    BETA_PEER_NODE[BETA_PEER_COUNT]="$node"
    BETA_PEER_COUNT=$((BETA_PEER_COUNT + 1))
  done <"$BETA_PEERS_FILE"
  return 0
}

# 去重后的节点名，一行一个，保持地址表里的先后顺序。
beta_peer_nodes() {
  local i=0 seen=' ' node
  while [ "$i" -lt "$BETA_PEER_COUNT" ]; do
    node="${BETA_PEER_NODE[$i]}"
    case "$seen" in
      *" $node "*) ;;
      *) printf '%s\n' "$node"; seen="$seen$node " ;;
    esac
    i=$((i + 1))
  done
}

# beta_peer_endpoint <node> —— 该节点的入站端点（取地址表里第一条）。
beta_peer_endpoint() {
  local want="$1" i=0
  while [ "$i" -lt "$BETA_PEER_COUNT" ]; do
    if [ "${BETA_PEER_NODE[$i]}" = "$want" ]; then
      printf '%s\n' "${BETA_PEER_EP[$i]}"
      return 0
    fi
    i=$((i + 1))
  done
  return 1
}

# ── 隔离环境 ─────────────────────────────────────────────────────────────────
#
# 身份变量三件套里的前一个在这里设，另两个按腿分别设（beta-env.md §4.1 的表）：
#   OCC_IDENTITY=qianmo      —— 缺了就落到 ~/.occ，与机器上的 occ 抢配置根；
#   OCC_CONFIG_DIR=<按进程>  —— 由各腿在起进程时逐个给；
#   QIANMO_TRANSPORT_PSK     —— 由 beta_load_psk 从文件取，缺了进程起不来。
beta_export_common() {
  export OCC_IDENTITY=qianmo
  if [ -z "${QIANMO_BACKUP_WRITE_TOKEN:-}" ] && [ -f "$BETA_BACKUP_WRITE_FILE" ]; then
    QIANMO_BACKUP_WRITE_TOKEN="$(cat "$BETA_BACKUP_WRITE_FILE")"
    export QIANMO_BACKUP_WRITE_TOKEN
  fi
  if [ -z "${QIANMO_BACKUP_ARCHIVE_TOKEN:-}" ] && [ -f "$BETA_BACKUP_ARCHIVE_FILE" ]; then
    QIANMO_BACKUP_ARCHIVE_TOKEN="$(cat "$BETA_BACKUP_ARCHIVE_FILE")"
    export QIANMO_BACKUP_ARCHIVE_TOKEN
  fi
}

# beta_load_psk <文件> <说明> —— 把一把 PSK 从文件读进环境。
#
# **永远不走命令行**：命令行上的密钥就是这台机器每一份进程列表里的密钥（§8.3）。
# 环境里已经有一把就不动它——运维手工 export 一把跑一次性动作是正常操作。
beta_load_psk() {
  local file="$1" what="$2"
  if [ -n "${QIANMO_TRANSPORT_PSK:-}" ]; then
    return 0
  fi
  [ -f "$file" ] || beta_die "缺 $what：$file —— 它由 H 生成后分发，**不在本机自动生成**（beta-env.md §8.3）"
  QIANMO_TRANSPORT_PSK="$(cat "$file")"
  export QIANMO_TRANSPORT_PSK
  [ -n "$QIANMO_TRANSPORT_PSK" ] || beta_die "$file 是空的"
  return 0
}

# H 上那份运维副本：secrets/peers/<node>.psk（**全部四把**，§8.3 的表）。
beta_peer_psk_file() { printf '%s/%s.psk' "$BETA_PEER_SECRET_DIR" "$1"; }

# beta_random_hex <字节数> —— 生成一串随机 hex。
#
# 用 `od -N` 而不是 `tr -dc ... | head -c`：后者会让 head 先退出、tr 吃到 SIGPIPE，
# 在 `set -o pipefail` 下整条脚本当场以 141 退出。这不是洁癖，是踩过的形状。
beta_random_hex() {
  local bytes="$1"
  if [ -r /dev/urandom ]; then
    LC_ALL=C od -An -tx1 -N "$bytes" /dev/urandom | tr -d ' \n'
    printf '\n'
    return 0
  fi
  bun -e 'process.stdout.write(Buffer.from(crypto.getRandomValues(new Uint8Array(Number(process.argv[1])))).toString("hex")+"\n")' "$bytes"
}

# ── 进程 helper ──────────────────────────────────────────────────────────────

beta_pidfile() { printf '%s/%s.pid' "$BETA_RUN_DIR" "$1"; }
beta_logfile() { printf '%s/%s.%s' "$BETA_LOG_DIR" "$1" "$2"; }

# beta_running <名字> —— pid 文件里的进程还活着吗。**幂等起停的全部依据。**
beta_running() {
  local file
  file="$(beta_pidfile "$1")"
  [ -f "$file" ] || return 1
  local pid
  pid="$(cat "$file" 2>/dev/null || true)"
  [ -n "$pid" ] || return 1
  kill -0 "$pid" 2>/dev/null
}

# beta_stop_one <名字> —— 先 TERM，10 s 不走再 KILL。
beta_stop_one() {
  local name="$1" file pid i
  file="$(beta_pidfile "$name")"
  beta_assert_inside_root "$file"
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
      beta_warn "$name (pid $pid) 未响应 SIGTERM，改用 SIGKILL"
      kill -KILL "$pid" 2>/dev/null || true
    fi
    beta_say "已停止 $name (pid $pid)"
  fi
  rm -f "$file"
}

# beta_start_process <名字> <配置根> -- <命令...>
# 起一个后台进程，pid 落 run/，stdout/stderr 落 logs/。已在跑的不重起（幂等）。
beta_start_process() {
  local name="$1" config_dir="$2"
  shift 2
  if beta_running "$name"; then
    beta_ok "$name 已在运行（pid $(cat "$(beta_pidfile "$name")")），不重起"
    return 0
  fi
  local out err
  out="$(beta_logfile "$name" out)"
  err="$(beta_logfile "$name" err)"
  mkdir -p "$config_dir"
  chmod 700 "$config_dir"
  # 每个进程一个配置根：审计链、节点身份、会话表都按配置根分家（见文件头）。
  OCC_CONFIG_DIR="$config_dir" nohup "$@" >"$out" 2>"$err" &
  local pid=$!
  printf '%s\n' "$pid" >"$(beta_pidfile "$name")"
  beta_ok "$name 已启动（pid $pid，日志 $out）"
}

# 进程死了就把它的错误摊开来，不要只说一句「没起来」。
beta_dump_if_dead() {
  local name="$1"
  beta_running "$name" && return 0
  beta_say "--- $name stderr 末尾 ---"
  tail -20 "$(beta_logfile "$name" err)" 2>/dev/null || true
  beta_say "--- $name stdout 末尾 ---"
  tail -20 "$(beta_logfile "$name" out)" 2>/dev/null || true
  beta_die "$name 未能保持运行"
}

# ── 拨测 helper ──────────────────────────────────────────────────────────────

# beta_http_status <url> —— 打印 HTTP 状态码，拿不到就打 000。
#
# curl 在 Debian minimal 上不一定有（`unzip` 都没有，demo-env.md §4.4 踩过），
# 所以留一条 bun 兜底——bun 本来就是硬依赖（occ 跑在它上面）。
# 不用 `timeout`：macOS 自带的系统里没有这个命令。
beta_http_status() {
  local url="$1" out
  # 先把输出接住再判断：连不上时 curl 自己也会按 -w 打一个 `000` **并**返回非零，
  # 写成 `curl … || printf '000'` 会得到 `000000` —— 一个永远不等于 200 的字符串，
  # 症状是「就绪探测永远超时」而日志里什么都没有。
  if command -v curl >/dev/null 2>&1; then
    out="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$url" 2>/dev/null || true)"
  else
    out="$(bun -e 'const r = await fetch(process.argv[1], { signal: AbortSignal.timeout(5000) }); process.stdout.write(String(r.status))' "$url" 2>/dev/null || true)"
  fi
  [ -n "$out" ] || out='000'
  printf '%s' "$out"
}

# beta_tcp_open <host> <port> —— 端口收不收 TCP 连接。
#
# 只用于**本机回环**的就绪判断：/dev/tcp 没有超时，对远端可能挂住。
# 它只证明「在监听」，**证不了 PSK 对不对**——那要真握手，而握手只有从 H 拨过来
# 才算数（beta-smoke.sh 的 host 腿做的正是那件事）。
beta_tcp_open() {
  local host="$1" port="$2"
  (exec 3<>"/dev/tcp/$host/$port") 2>/dev/null || return 1
  return 0
}

# ── occ 产物 ────────────────────────────────────────────────────────────────

# 没有构建产物就明确报错，不去猜。造它的是 demo/env/bootstrap.sh（内测沿用同一条）。
beta_require_occ() {
  [ -f "$BETA_OCC" ] || beta_die "缺 $BETA_OCC —— 先跑 demo/env/bootstrap.sh"
}
