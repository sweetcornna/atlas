#!/usr/bin/env bash
# Copyright 2026 Qianmo AgentNest Team
# SPDX-License-Identifier: MIT
#
# 阡陌 P11.1 落地包① —— 起内测拓扑。**两条腿一个脚本，用 --role 区分。**
#
#   demo/env/beta/beta-up.sh --role host              # H：注册中心 + 控制台（+ 备份服务，见下）
#   demo/env/beta/beta-up.sh --role node --node <名字> # 任一节点机：该机那一个常驻节点
#
# 为什么两条腿合一个脚本而不是拆两个：它们共用**同一套**根目录布局、同一套守卫、同一份
# 地址表与同一组端口常量。拆成两个文件的第一天是干净的，第三次改端口的时候就会有一边
# 忘了改——而那种不一致的症状是「名册上在线、拨不通」（beta-env.md §9.1），最难查的一类。
#
#   注册中心 :  127.0.0.1:38620   永不出回环（零鉴权，§9.2）
#   控制台   :  127.0.0.1:38621   由反代以 TLS 暴露，它是用户唯一的对外面（§2.5）
#   节点入站 :  0.0.0.0:38625     每台节点机各一个
#
# ── 节点入站怎么被 H 拨到：两种形态，peers.conf 说了算 ──────────────────────
# ① **直连**（默认形态）：peers.conf 里该节点的端点就是它的真实地址。节点入站绑
#    0.0.0.0，那个端口上唯一的门是 PSK 握手（§2.6/§8）。
# ② **SSH 隧道**（兜底）：该节点在 peers.conf 里另有一条 `node` 坐标行。现场三台节点的
#    入站端口被云厂商安全组挡着（实测 22/80/443 通，入站端口与另外十个候选端口全不通），
#    所以本脚本为这些节点建 systemd --user 的 `ssh -L`，把节点的 127.0.0.1:38625 映到 H
#    的回环口；peers.conf 的端点写成那个回环口，**应用层一行代码不改**。这时那个端口
#    根本不对外开放，门是 sshd 的公钥 + PSK 两道。
#    同一条坐标行还定义了审计链的单向只读镜像（节点 → H，5 min 一次）。
#
# **隧道不是默认形态**：没有坐标行的节点保持直连（node-provisioning.md §0 第 12 条的
# 控制面 / 数据面分工）。单元与拉取脚本从 demo/env/beta/ops/ 派生，真源在仓库。
#
# **幂等**：已在跑的进程不重起（照 demo/env/up.sh 的 demo_running）。这是 §6 L0 的前提——
# 「① beta-down.sh <name> 只停这一个 → ③ beta-up.sh 幂等，已在跑的不会被重起」。
#
# 全部状态在 QIANMO_BETA_ROOT 下（默认 $HOME/qianmo-beta）。**不碰用户真实的 ~/.occ / ~/.qianmo。**
# 停机用 beta-down.sh，回到可重起的干净运行态用 beta-reset.sh。

set -euo pipefail

# shellcheck source=demo/env/beta/common.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

ROLE=''
NODE_GIVEN=0
AGENTS_GIVEN=''
READY_TIMEOUT_S="${QIANMO_BETA_READY_TIMEOUT_S:-90}"

usage() {
  beta_say '用法：'
  beta_say '  beta-up.sh --role host'
  beta_say '  beta-up.sh --role node --node <名字> [--agent <名字>]... [--port <端口>]'
  beta_say ''
  beta_say '变量与完整说明见 demo/env/beta/README.md。'
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --role)   ROLE="${2:-}"; shift 2 ;;
    --role=*) ROLE="${1#--role=}"; shift ;;
    --node)   BETA_NODE="${2:-}"; NODE_GIVEN=1; shift 2 ;;
    --node=*) BETA_NODE="${1#--node=}"; NODE_GIVEN=1; shift ;;
    # --agent 可以给多次（每节点 2 个，§2.2）。第一次给就把默认那份整体顶掉，
    # 而不是追加——否则「我只想跑一个 agent」会变成「跑了三个」。
    --agent)   AGENTS_GIVEN="$AGENTS_GIVEN ${2:-}"; shift 2 ;;
    --agent=*) AGENTS_GIVEN="$AGENTS_GIVEN ${1#--agent=}"; shift ;;
    --port)   BETA_NODE_PORT="${2:-}"; shift 2 ;;
    --port=*) BETA_NODE_PORT="${1#--port=}"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) beta_die "未知参数 $1（用 --help 看用法）" ;;
  esac
done

[ -n "$ROLE" ] || { usage; beta_die '缺 --role host|node'; }
case "$ROLE" in
  host|node) ;;
  *) beta_die "--role 只能是 host 或 node，收到 $ROLE" ;;
esac
# 去掉累加时留下的前导空格：它只影响打印出来那一行的观感，`for a in $BETA_AGENTS`
# 的分词本来就吃得下——但那一行是运维照着抄进运维单页的，别让它带个空格。
if [ -n "$AGENTS_GIVEN" ]; then
  BETA_AGENTS="$(printf '%s' "$AGENTS_GIVEN" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
fi

STARTED_AT="$(beta_now)"
beta_seed_root
beta_require_marker
beta_require_occ
beta_export_common
cd "$REPO_DIR"

# ─────────────────────────────────────────────────────────────────────────────
# host 腿：注册中心 + 控制台（+ 备份服务）
# ─────────────────────────────────────────────────────────────────────────────
run_host() {
  beta_load_peers
  if [ "$BETA_PEER_COUNT" -eq 0 ]; then
    beta_die "$BETA_PEERS_FILE 里一条地址都没有 —— 按里面的注释填上「<地址> <端点>」再跑。
凡是要长期存在的地址都必须写进这里（= 注册中心的 --register 启动参数）：
租约 90 s，注册中心停机超过 90 s 后落盘表等于空文件，重启后回来的只有 --register 那批
（beta-env.md §2.4 的硬规矩）。控制台页面上点的那个「注册」活不过一次 90 s 以上的重启。"
  fi

  # 审计路径 / 页头标签 / 审计节点 / 唤醒目标：从 console.conf 读，环境变量优先且回写。
  # 必须在 beta_load_peers 之后 —— 「这个节点的链是不是镜像来的」要看坐标行。
  beta_resolve_console_conf

  beta_head '① 链路（SSH 隧道与审计镜像）'
  provision_links

  beta_head "② 注册中心（$BETA_PEER_COUNT 条登记）"
  assert_registry_matches_peers
  local ready="$BETA_RUN_DIR/registry-ready.json"
  local args i
  args=(
    bun run "$REPO_DIR/demo/lib/p81-registry.ts"
    --ready "$ready"
    --port "$BETA_REGISTRY_PORT"
    --host "$BETA_HOST_BIND"
    --state "$BETA_STATE_DIR/registry-agents.json"
  )
  i=0
  while [ "$i" -lt "$BETA_PEER_COUNT" ]; do
    args+=(--register "${BETA_PEER_ADDR[$i]}=${BETA_PEER_EP[$i]}")
    i=$((i + 1))
  done
  if ! beta_running "$BETA_REGISTRY_PROC"; then rm -f "$ready"; fi
  beta_start_process "$BETA_REGISTRY_PROC" "$BETA_CONFIG_REGISTRY" "${args[@]}"

  i=0
  while [ ! -s "$ready" ] && [ "$i" -lt 30 ]; do
    sleep 1
    i=$((i + 1))
    beta_dump_if_dead "$BETA_REGISTRY_PROC"
  done
  [ -s "$ready" ] || beta_die "注册中心 30 s 内没有写出 ready 文件（见 $(beta_logfile "$BETA_REGISTRY_PROC" err)）"
  beta_ok "注册中心就绪：$BETA_REGISTRY_URL"

  beta_head '③ 控制台'
  # 两枚 token 一律从文件取、一律显式传（§3.2）。首跑时现生成一次并落 0600 文件——
  # 「显式」要的是**跨重启稳定**，而文件正是它的持久形式；自动生成的那条路（控制台
  # 自己 resolveTokens）每次重启都变，50 个人手上的链接会同时失效。
  local view admin
  if [ ! -s "$BETA_VIEW_TOKEN_FILE" ]; then
    beta_random_hex 24 >"$BETA_VIEW_TOKEN_FILE"
    chmod 600 "$BETA_VIEW_TOKEN_FILE"
    beta_ok "view token 已生成（0600，不回显）：$BETA_VIEW_TOKEN_FILE"
  fi
  if [ ! -s "$BETA_ADMIN_TOKEN_FILE" ]; then
    beta_random_hex 24 >"$BETA_ADMIN_TOKEN_FILE"
    chmod 600 "$BETA_ADMIN_TOKEN_FILE"
    beta_ok "admin token 已生成（0600，不回显）：$BETA_ADMIN_TOKEN_FILE"
  fi
  view="$(cat "$BETA_VIEW_TOKEN_FILE")"
  admin="$(cat "$BETA_ADMIN_TOKEN_FILE")"
  [ "$view" != "$admin" ] || beta_die '两枚 token 相同 —— resolveTokens 会拒绝，先删掉其中一个重跑'

  local console_args
  console_args=(
    bun "$BETA_OCC" console
    --port "$BETA_CONSOLE_PORT"
    --hostname "$BETA_HOST_BIND"
    --registry "$BETA_REGISTRY_URL"
    --audit "$BETA_AUDIT_PATH"
    --label "$BETA_LABEL"
    # 传**文件路径**而不是 token 值：命令行上的密钥就是这台机器每一份进程列表里的
    # 密钥（`ps -eo args` / `/proc/<pid>/cmdline` 每个本地账号都读得到）。这条纪律
    # console.md §4.4 早就给 PSK 定下了，token 这半边一直没落实——在 H 上实测确认过
    # admin token 明文可读，宿主上还跑着别的账号与一批容器。两个文件本来就是 0600 的，
    # 换成 `--*-token-file` 之后进程列表里只剩路径。
    # 上面 `$view`/`$admin` 仍要读一次，因为「两枚不能相同」这条得在起进程之前查出来。
    --view-token-file "$BETA_VIEW_TOKEN_FILE"
    --admin-token-file "$BETA_ADMIN_TOKEN_FILE"
  )
  if [ ! -f "$BETA_AUDIT_PATH" ]; then
    beta_warn "审计链文件还不存在：$BETA_AUDIT_PATH
（$BETA_AUDIT_NODE 还没写过第一条记录，或它的配置根不在这台机器上。
  控制台对一个不存在的 --audit **不报错，只显示空审计视图**——所以这条 WARN 是唯一的信号。
  该节点跑在别的机器上时，链要靠镜像拉过来：给它一条带 trail= 的 node 坐标行，
  或者直接把 AUDIT_PATH 改成 $(beta_mirror_trail "$BETA_AUDIT_NODE")（改 $BETA_CONSOLE_CONF）。
  镜像**不是权威副本**，页面上也看不出滞后多久，所以页头标签必须标注——beta-env.md §4.3）"
  fi

  # 唤醒面要两个条件同时成立：给了 --wake-url，且环境里有那个目标的 PSK（§8.2）。
  # 一期唤醒目标只能有一个：--wake-url 钉死单值，而 QIANMO_TRANSPORT_PSK 是每进程一把，
  # 两个限制正好重合。其余三个节点的唤醒走 H 上的 `occ resident-wake`。
  local wake_url wake_psk
  wake_url="$(beta_peer_endpoint "$BETA_WAKE_NODE" 2>/dev/null || true)"
  wake_psk="$(beta_peer_psk_file "$BETA_WAKE_NODE")"
  if [ -n "$wake_url" ] && [ -s "$wake_psk" ]; then
    console_args+=(--wake-url "$wake_url")
    QIANMO_TRANSPORT_PSK="$(cat "$wake_psk")"
    export QIANMO_TRANSPORT_PSK
    beta_ok "唤醒目标：$BETA_WAKE_NODE → $wake_url"
  else
    if [ -z "$wake_url" ]; then
      beta_warn "唤醒面不启用 —— 地址表里没有 $BETA_WAKE_NODE 的条目（$BETA_PEERS_FILE）"
    else
      beta_warn "唤醒面不启用 —— 缺 $BETA_WAKE_NODE 的 PSK：$wake_psk
（H 上存全部四把是因为唤醒与投递都从 H 发起；节点机上只存它自己那一把，§8.3）"
    fi
    beta_say '控制台照常起，页面上没有唤醒按钮。'
  fi
  beta_start_process "$BETA_CONSOLE_PROC" "$BETA_CONFIG_CONSOLE" "${console_args[@]}"

  i=0
  local status='000'
  while [ "$i" -lt "$READY_TIMEOUT_S" ]; do
    beta_dump_if_dead "$BETA_CONSOLE_PROC"
    status="$(beta_http_status "$BETA_CONSOLE_URL/v0/health")"
    if [ "$status" = '200' ]; then break; fi
    sleep 2
    i=$((i + 2))
  done
  [ "$status" = '200' ] \
    || beta_die "控制台 ${READY_TIMEOUT_S}s 内没有回 /v0/health 200（收到 $status，见 $(beta_logfile "$BETA_CONSOLE_PROC" err)）"
  beta_ok "控制台就绪：$BETA_CONSOLE_URL"

  beta_head '④ 备份服务'
  # **这里是一个真缺口，不是省略。**`packages/backup` 只导出库函数 `startBackupService()`，
  # 仓库里唯一的调用方是 `demo/lib/ac6b-restore.ts`——那是个一次性演示：它在临时目录里建
  # store、跑完删库恢复就 stop。没有 `occ backup-*` 子命令，也没有任何长驻启动器。
  # 本包的硬约束是「只写 shell 与文档，不含任何功能代码改动」（beta-env.md §10 包①），
  # 所以这里**不伪造**一个入口，只如实报缺。
  # 后果（要写进运维单页）：§2.7 的备份面一期起不来 → 节点不能带 `--backup-url` →
  # §5 里「备份 store 72 h + 14 天日留存」那一行暂时没有数据可管，AC-6(b) 的恢复演示
  # 仍能用 `demo/ac6b-restore.sh` 单独跑。补这个入口是另一个包的事。
  beta_todo '备份服务未启动：@qianmo/backup 没有可执行入口（详见 README「这个脚本不做什么」）'

  beta_head "H 腿就绪，耗时 $(beta_elapsed "$STARTED_AT")"
  beta_say "注册中心 : $BETA_REGISTRY_URL（$BETA_PEER_COUNT 条登记，永不出回环）"
  beta_say "控制台   : $BETA_CONSOLE_URL（由反代以 TLS 暴露；两枚 token 在 $BETA_SECRET_DIR）"
  beta_say "审计视图 : $BETA_AUDIT_PATH"
  beta_say "页头标签 : $BETA_LABEL"
  beta_say "上面两行 : 持久化在 $BETA_CONSOLE_CONF —— 控制台重起不再丢"
  if [ "$BETA_SSH_COUNT" -gt 0 ]; then
    beta_say "链路     : $BETA_SSH_COUNT 条 SSH 隧道 + 审计镜像（systemd --user，见 $BETA_OPS_DIR）"
  else
    beta_say '链路     : 全部直连（peers.conf 里没有 node 坐标行）'
  fi
  if [ -n "$BETA_UNITS_STALE" ]; then
    beta_say ''
    beta_warn "下面这些单元的**文件**已按仓库模板更新，但它们此刻正在跑的仍是旧定义 ——
systemd 不会因为文件变了就重启单元（那正是我们要的：隧道不能说断就断）。
它也不会在任何地方留下痕迹，所以只有这一行会告诉你。要让新定义生效，在维护窗口里跑：
  systemctl --user restart$BETA_UNITS_STALE
（重起隧道 = 该节点在几秒内不可达，注册中心的租约 90 s 兜得住，但正在跑的投递会断。）"
  fi
  beta_say ''
  beta_say '下一步   : demo/env/beta/beta-smoke.sh --role host'
}

# ─────────────────────────────────────────────────────────────────────────────
# 链路：为有 node 坐标行的节点建隧道与审计镜像
#
# **幂等是这里的第一要求**：它对着一个正在跑的现场执行，四条隧道与四个 timer 一律
# 不重起。做法是把每一步都写成「先问状态，不同才动」：
#   · 单元文件与拉取脚本用 beta_write_if_changed（内容相同就不写）；
#   · daemon-reload 只在真写过东西时跑；
#   · enable / start 都先 is-enabled / is-active，已经对了就只打一行「不重起」；
#   · **绝不 restart**。文件变了而单元在跑，如实报到末尾那段 WARN 里。
# ─────────────────────────────────────────────────────────────────────────────
provision_links() {
  # 先收残：有过链路、现在 peers.conf 里已经没有坐标行的节点。
  # 这条路径是真会走到的 —— 安全组放行之后「改回直连」就是把坐标行删掉，而删掉之后
  # 那条隧道**照样在跑**：它占着那个回环口，还让「H 到节点」多一跳谁都想不起来的转发。
  sweep_orphan_links

  if [ "$BETA_SSH_COUNT" -eq 0 ]; then
    beta_say 'peers.conf 里没有 node 坐标行 —— 全部节点按**直连**处理，不建隧道、不做镜像。'
    beta_say '隧道是「直连不通时的兜底」，不是默认形态：要用它就给该节点加一条 node 坐标行'
    beta_say "（写法见 $BETA_PEERS_FILE 顶部的注释）。"
    return 0
  fi
  beta_require_systemd_user
  mkdir -p "$BETA_OPS_DIR"
  chmod 700 "$BETA_OPS_DIR"
  mkdir -p "$BETA_SYSTEMD_USER_DIR"
  BETA_SYNC_CHANGED=0
  BETA_UNITS_STALE=''

  render_ops_files

  local i=0
  while [ "$i" -lt "$BETA_SSH_COUNT" ]; do
    write_tunnel_env "$i"
    i=$((i + 1))
  done

  if [ "$BETA_SYNC_CHANGED" -gt 0 ]; then
    systemctl --user daemon-reload
    beta_ok "systemd --user 已 daemon-reload（本次改写了 $BETA_SYNC_CHANGED 个文件）"
  else
    beta_ok '单元与连通定义全部已是仓库派生的内容，无需 daemon-reload'
  fi

  i=0
  local node unit trail
  while [ "$i" -lt "$BETA_SSH_COUNT" ]; do
    node="${BETA_SSH_NODE[$i]}"
    unit="$(beta_unit_instance 'qianmo-tunnel' "$node" '.service')"
    ensure_unit "$unit" "隧道 $node"
    trail="${BETA_SSH_TRAIL[$i]}"
    if [ -n "$trail" ]; then
      unit="$(beta_unit_instance 'qianmo-mirror' "$node" '.timer')"
      ensure_unit "$unit" "审计镜像 $node（${BETA_MIRROR_INTERVAL_MIN} min）"
    else
      beta_say "提示 : $node 的坐标行没有 trail=，不做审计镜像（H 上看不到它的链）"
    fi
    i=$((i + 1))
  done

  i=0
  while [ "$i" -lt "$BETA_SSH_COUNT" ]; do
    wait_tunnel_live "${BETA_SSH_NODE[$i]}" "${BETA_SSH_LOCAL[$i]}"
    i=$((i + 1))
  done
}

# 铺过链路、但 peers.conf 里已经没有它坐标行的节点：停掉、取消自启、删掉连通定义。
#
# **不动 mirror/<node>/**：那里面是已经拉回来的审计链副本，「只能挪走、不能撤销」
# （beta-env.md §6.4）对它同样成立。
sweep_orphan_links() {
  local node env_file
  for node in $(beta_provisioned_nodes); do
    if beta_ssh_index "$node" >/dev/null; then continue; fi
    beta_warn "$node 在 peers.conf 里已经没有 node 坐标行了 —— 停掉它那条链路并删掉连通定义
（改回直连时就是这个形状。不收掉的话它会一直占着那个回环口，而 peers.conf 上已经看不到它了。）"
    beta_stop_link "$node"
    env_file="$BETA_OPS_DIR/tunnel-$node.env"
    beta_assert_inside_root "$env_file"
    rm -f "$env_file"
    beta_say "已删除 $env_file（mirror/$node/ 一条没动）"
  done
}

# 三个单元 + 拉取脚本，从仓库 ops/ 派生到 <root>/ops/，再装进 systemd --user。
render_ops_files() {
  local src dst gen
  gen="$BETA_OPS_DIR/.render.$$"
  beta_assert_inside_root "$gen"
  for src in "$BETA_OPS_SRC_DIR/qianmo-tunnel@.service.in" \
    "$BETA_OPS_SRC_DIR/qianmo-mirror@.service.in" \
    "$BETA_OPS_SRC_DIR/qianmo-mirror@.timer.in"; do
    [ -f "$src" ] || beta_die "缺仓库模板 $src —— demo/env/beta/ops/ 是链路的真源"
    dst="$BETA_OPS_DIR/$(basename "$src" .in)"
    beta_assert_inside_root "$dst"
    # 占位符只有两个，且都是路径 / 数字，用 | 作分隔符不会撞上。
    sed -e "s|@OPS_DIR@|$(beta_unit_path "$BETA_OPS_DIR")|g" \
      -e "s|@MIRROR_INTERVAL_MIN@|$BETA_MIRROR_INTERVAL_MIN|g" \
      "$src" >"$gen"
    beta_write_if_changed "$gen" "$dst" 644 "单元模板 $(basename "$dst")"
  done
  rm -f "$gen"

  src="$BETA_OPS_SRC_DIR/mirror-pull.sh"
  [ -f "$src" ] || beta_die "缺仓库脚本 $src"
  dst="$BETA_OPS_DIR/mirror-pull.sh"
  beta_assert_inside_root "$dst"
  # 原样拷：它自己从 $0 推内测根，没有要替换的东西。
  beta_write_if_changed "$src" "$dst" 700 '镜像拉取脚本 mirror-pull.sh'

  # 装进 systemd --user。~/.config 不在内测根里，所以走另一套逐路径复核。
  local base unit_dst
  for base in 'qianmo-tunnel@.service' 'qianmo-mirror@.service' 'qianmo-mirror@.timer'; do
    unit_dst="$BETA_SYSTEMD_USER_DIR/$base"
    beta_assert_unit_file "$unit_dst"
    if [ -f "$unit_dst" ] && cmp -s "$BETA_OPS_DIR/$base" "$unit_dst"; then
      beta_ok "$base 已装且内容一致，不动"
      continue
    fi
    # 记下「文件变了但可能有实例在跑」——末尾要说出来，systemd 自己不会说。
    note_stale_instances "$base"
    cp "$BETA_OPS_DIR/$base" "$unit_dst"
    chmod 644 "$unit_dst"
    BETA_SYNC_CHANGED=$((BETA_SYNC_CHANGED + 1))
    beta_warn "$base 已装进 $BETA_SYSTEMD_USER_DIR（内容有更新）"
  done
}

# 单元文件被改写时，把此刻正在跑的实例记下来。**不重起它们**：那是运维窗口的动作。
note_stale_instances() {
  local base="$1" prefix suffix i node unit
  case "$base" in
    'qianmo-tunnel@.service') prefix='qianmo-tunnel'; suffix='.service' ;;
    'qianmo-mirror@.timer') prefix='qianmo-mirror'; suffix='.timer' ;;
    # mirror@.service 是 oneshot，由 timer 触发：它没有「正在跑的旧定义」这个问题，
    # 下一次触发就用新的了。
    *) return 0 ;;
  esac
  i=0
  while [ "$i" -lt "$BETA_SSH_COUNT" ]; do
    node="${BETA_SSH_NODE[$i]}"
    unit="$(beta_unit_instance "$prefix" "$node" "$suffix")"
    if [ "$(systemctl --user is-active "$unit" 2>/dev/null || true)" = 'active' ]; then
      BETA_UNITS_STALE="$BETA_UNITS_STALE $unit"
    fi
    i=$((i + 1))
  done
}

# 每节点一份 0600 的连通定义。**它是 peers.conf 那条坐标行的派生物**，手改会被覆盖：
# 两处各存一份「这个节点在哪」，迟早会分叉，而分叉的症状是隧道连 A、镜像拉 B。
write_tunnel_env() {
  local i="$1" node="${BETA_SSH_NODE[$1]}" dst gen
  dst="$BETA_OPS_DIR/tunnel-$node.env"
  gen="$BETA_OPS_DIR/.render-env.$$"
  beta_assert_inside_root "$dst"
  beta_assert_inside_root "$gen"
  {
    printf '# 阡陌内测 · 节点 %s 的连通定义（隧道与审计镜像共用这一份）。\n' "$node"
    printf '#\n'
    printf '# **由 demo/env/beta/beta-up.sh 从 peers.conf 的 node 坐标行派生，手改会被覆盖。**\n'
    printf '# 要改就改 %s。\n' "$BETA_PEERS_FILE"
    printf '#\n'
    printf '# 机器地址与 SSH 用户不进仓库（beta-env.md 文首）：本文件 0600，只在 H 上。\n'
    printf '# 私钥本身永不离开 H，这里只有路径。\n'
    printf 'NODE_SSH_USER=%s\n' "${BETA_SSH_USER[$i]}"
    printf 'NODE_SSH_HOST=%s\n' "${BETA_SSH_HOST[$i]}"
    printf 'NODE_SSH_PORT=%s\n' "${BETA_SSH_PORT[$i]}"
    printf 'NODE_SSH_KEY=%s\n' "${BETA_SSH_KEYFILE[$i]}"
    printf 'LOCAL_PORT=%s\n' "${BETA_SSH_LOCAL[$i]}"
    printf 'REMOTE_PORT=%s\n' "${BETA_SSH_REMOTE[$i]}"
    if [ -n "${BETA_SSH_TRAIL[$i]}" ]; then
      printf '# 审计镜像（单向、只读、节点 → H）。key 在节点侧带强制命令，只读得到这一个文件。\n'
      printf 'REMOTE_TRAIL=%s\n' "${BETA_SSH_TRAIL[$i]}"
    fi
  } >"$gen"
  chmod 600 "$gen"
  beta_write_if_changed "$gen" "$dst" 600 "连通定义 tunnel-$node.env"
  rm -f "$gen"
}

# enable + start，且**只在状态不对时才动**。已经 active 的一律不重起。
ensure_unit() {
  local unit="$1" what="$2" enabled active
  enabled="$(systemctl --user is-enabled "$unit" 2>/dev/null || true)"
  active="$(systemctl --user is-active "$unit" 2>/dev/null || true)"
  if [ "$enabled" != 'enabled' ]; then
    systemctl --user enable "$unit" >/dev/null 2>&1 \
      || beta_die "$what：systemctl --user enable $unit 失败"
    beta_ok "$what 已设为开机自启（$unit）"
  fi
  if [ "$active" = 'active' ]; then
    beta_ok "$what 已在运行，不重起（$unit）"
    return 0
  fi
  systemctl --user start "$unit" \
    || beta_die "$what：systemctl --user start $unit 失败（journalctl --user -u $unit 看原因）"
  beta_ok "$what 已启动（$unit）"
}

# 隧道就绪。**判据是真读一次对端应答，不是 TCP 连得上。**
#
# `ssh -L` 的本地口由 ssh 客户端自己 LISTEN：节点侧没人监听时它照样 accept 然后立刻关，
# 所以 beta_tcp_open 在这里恒为真（common.sh 里那个函数会直接 die，就是为了挡住这个）。
wait_tunnel_live() {
  local node="$1" port="$2" i=0
  while [ "$i" -lt "$READY_TIMEOUT_S" ]; do
    if beta_endpoint_live 127.0.0.1 "$port"; then
      beta_ok "隧道 $node 通到底：127.0.0.1:$port 上收到了节点的应答"
      return 0
    fi
    sleep 2
    i=$((i + 2))
  done
  beta_die "隧道 $node 在 ${READY_TIMEOUT_S}s 内没有让 127.0.0.1:$port 回出任何应答。
注意 TCP 层可能是「通」的 —— ssh 自己在这个口上 LISTEN，节点侧死掉时它 accept 完立刻关，
于是任何 TCP 探测都是绿的。分诊顺序：
  systemctl --user status $(beta_unit_instance 'qianmo-tunnel' "$node" '.service')
  journalctl --user -u $(beta_unit_instance 'qianmo-tunnel' "$node" '.service') -n 50
  出现 administratively prohibited = 节点 authorized_keys 的 permitopen 与 remote-port 对不上；
  出现 open failed: connect failed = 隧道没问题，是节点上的常驻没在跑。"
}

# ─────────────────────────────────────────────────────────────────────────────
# 注册中心落盘表 / 活表与 peers.conf 的一致性（改端点之前必须先挪开旧表）
#
# 病根见 common.sh「注册中心落盘表与 peers.conf 的一致性」那一节：p81-registry.ts 的
# announce() 在 heartbeat 成功时整条跳过 --register，于是**改了 peers.conf 也不生效**。
# 这件事以前只能靠人记得，现在由脚本自己查、自己挪开。
# ─────────────────────────────────────────────────────────────────────────────
assert_registry_matches_peers() {
  local state="$BETA_STATE_DIR/registry-agents.json"
  local disk_bad=0 live_bad=0 i addr want got backup

  if [ -f "$state" ]; then
    local pairs saddr sep
    pairs="$BETA_RUN_DIR/registry-state-pairs.$$"
    beta_state_pairs "$state" >"$pairs"
    while read -r saddr sep || [ -n "$saddr" ]; do
      [ -n "$saddr" ] || continue
      want="$(beta_peer_addr_endpoint "$saddr")" || continue
      if [ "$want" != "$sep" ]; then
        beta_warn "落盘表里 $saddr → $sep，而 peers.conf 说是 $want"
        disk_bad=1
      fi
    done <"$pairs"
    rm -f "$pairs"
  fi

  if beta_running "$BETA_REGISTRY_PROC"; then
    i=0
    while [ "$i" -lt "$BETA_PEER_COUNT" ]; do
      addr="${BETA_PEER_ADDR[$i]}"
      got="$(beta_live_endpoint "$addr")"
      if [ -n "$got" ] && [ "$got" != "${BETA_PEER_EP[$i]}" ]; then
        beta_warn "在跑的注册中心把 $addr 解析成 $got，而 peers.conf 说是 ${BETA_PEER_EP[$i]}"
        live_bad=1
      fi
      i=$((i + 1))
    done
  fi

  if [ "$disk_bad" = '0' ] && [ "$live_bad" = '0' ]; then
    beta_ok '注册表与 peers.conf 一致（落盘表与活表都查过）'
    return 0
  fi

  if [ "$disk_bad" = '1' ]; then
    backup="$state.stale-$(beta_stamp)"
    beta_assert_inside_root "$state"
    beta_assert_inside_root "$backup"
    mv "$state" "$backup"
    beta_warn "落盘的注册表与 peers.conf 不一致，**已挪开**（未删除）：
  $state
→ $backup
为什么必须挪：注册中心重启时会从落盘表 restore，租约 90 s 内的条目带着旧端点原样回来，
于是 announce() 里那句 \`if (registry.heartbeat(address) !== null) continue\` 把整条
--register 跳过 —— 改了 peers.conf 也不生效，症状是「smoke 全红而 peers.conf 明明是对的」。"
  fi

  if [ "$live_bad" = '1' ]; then
    beta_warn '在跑的注册中心，它的表在**内存**里 —— 挪开落盘表管不着它，必须重起才能换上新端点。'
    beta_stop_one "$BETA_REGISTRY_PROC"
    rm -f "$BETA_RUN_DIR/registry-ready.json"
    beta_warn '已停止注册中心，下面会用 peers.conf 的端点重新起一份。
**这是本脚本唯一一个会被重起的组件，且只在真的检出不一致时发生。**'
  fi
  return 0
}

# beta_peer_addr_endpoint <地址> —— peers.conf 说这个地址的端点是什么；表里没有就返回 1。
beta_peer_addr_endpoint() {
  local want="$1" i=0
  while [ "$i" -lt "$BETA_PEER_COUNT" ]; do
    if [ "${BETA_PEER_ADDR[$i]}" = "$want" ]; then
      printf '%s' "${BETA_PEER_EP[$i]}"
      return 0
    fi
    i=$((i + 1))
  done
  return 1
}

# ─────────────────────────────────────────────────────────────────────────────
# node 腿：该机那一个常驻节点
# ─────────────────────────────────────────────────────────────────────────────
run_node() {
  if [ "$NODE_GIVEN" = '0' ]; then
    # 四台机器上都用默认值 = 四个同名节点，而症状是注册表里互相覆盖、审计链张冠李戴。
    # 不硬拦（本机自验时默认值很方便），但要说一声。
    beta_warn "没给 --node，用默认节点名 $BETA_NODE —— 四台机器上必须各不相同"
  fi
  # PSK 由 H 生成后分发（§8.3）。**本机不生成**，理由见 common.sh 文件头第②条。
  beta_load_psk "$BETA_PSK_FILE" "本机节点的传输层 PSK"

  local config_dir="$BETA_NODES_DIR/$BETA_NODE/config"
  local ws_root="$BETA_WORKSPACE_DIR/$BETA_NODE"

  beta_head "① 工作区（节点 $BETA_NODE）"
  local agent
  for agent in $BETA_AGENTS; do
    seed_workspace "$ws_root/$agent" "$BETA_NODE/$agent"
  done

  beta_head "② 常驻节点 $BETA_NODE"
  local args
  # P12.4 的真实内测舰队仍处在 §9.2 阶段 ①：这两个参数成对出现，不是永久遗留。
  # 代码默认已经是 SIGNED_TASK_POLICY，但 S-1~S-4 证据与「连续 7 天若强制会被拒的
  # 消息计数为 0」的观察窗口满足前，舰队保持 §9.3 的 --open-policy 逃生策略，并用
  # --audit-signed-tasks 审计每一条若强制会被拒的消息。
  args=(
    bun "$BETA_OCC" resident
    --node "$BETA_NODE"
    --team "$BETA_TEAM"
    --port "$BETA_NODE_PORT"
    --hostname "$BETA_NODE_BIND"
    --open-policy
    --audit-signed-tasks
    --timings "$BETA_STATE_DIR/$BETA_NODE-timings.jsonl"
  )
  for agent in $BETA_AGENTS; do
    args+=(--agent "$agent=$ws_root/$agent")
  done
  # 备份面要 URL 与写 token 同时在。写 token 走环境变量、不走命令行——命令行上的
  # 凭据就是这台机器每一份进程列表里的凭据（resident 自己也是这么要求的）。
  if [ -n "$BETA_BACKUP_URL" ]; then
    if [ -n "${QIANMO_BACKUP_WRITE_TOKEN:-}" ]; then
      case "$BETA_BACKUP_URL" in
        https://*) ;;
        # 写 token 在 Authorization: Bearer 头里，明文 HTTP 等于每小时把它广播一次（§2.7）。
        *) beta_die "QIANMO_BETA_BACKUP_URL 必须是 https:// —— 收到 $BETA_BACKUP_URL" ;;
      esac
      args+=(--backup-url "$BETA_BACKUP_URL" --backup-interval-ms "$BETA_BACKUP_INTERVAL_MS")
      beta_ok "备份面已开：$BETA_BACKUP_URL（间隔 ${BETA_BACKUP_INTERVAL_MS} ms）"
    else
      beta_die "给了 QIANMO_BETA_BACKUP_URL 却没有写 token —— 放一份到 $BETA_BACKUP_WRITE_FILE（0600）。
**归档 token 永不下发到节点机**（§2.7）：那等于让任何一台被拿下的 VPS 读走全部快照。"
    fi
  else
    beta_say '提示 : 未设 QIANMO_BETA_BACKUP_URL，本节点不写备份快照（H 上的备份服务也还没有入口，见 README）'
  fi

  beta_start_process "$BETA_NODE" "$config_dir" "${args[@]}"

  beta_head '③ 就绪探测'
  # 就绪的定义不是「进程还在」，而是「端口真的收连接」。
  # 注意它**证不了 PSK 对不对**：握手只有从 H 拨过来才算数（beta-smoke.sh 的 host 腿）。
  # 这正是 §9.1 那条——本机一切正常、名册上也在线，而 H 拨过来是超时。
  local probe_host="$BETA_NODE_BIND"
  if [ "$probe_host" = '0.0.0.0' ]; then probe_host='127.0.0.1'; fi
  local i=0 listening=0
  while [ "$i" -lt "$READY_TIMEOUT_S" ]; do
    beta_dump_if_dead "$BETA_NODE"
    if beta_tcp_open "$probe_host" "$BETA_NODE_PORT"; then
      listening=1
      break
    fi
    sleep 2
    i=$((i + 2))
  done
  [ "$listening" = '1' ] \
    || beta_die "$BETA_NODE 在 ${READY_TIMEOUT_S}s 内没有在 ${probe_host}:${BETA_NODE_PORT} 上监听（见 $(beta_logfile "$BETA_NODE" err)）"
  beta_ok "$BETA_NODE 在 ${probe_host}:${BETA_NODE_PORT} 上监听"

  beta_head "节点腿就绪，耗时 $(beta_elapsed "$STARTED_AT")"
  beta_say "节点     : $BETA_NODE（agent：$BETA_AGENTS）"
  beta_say "配置根   : $config_dir"
  beta_say "审计链   : $(beta_node_trail "$BETA_NODE")   ← **权威副本，H 上那份是只读镜像**"
  beta_say "入站端点 : ws://<本机对外地址>:$BETA_NODE_PORT   ← 把它填进 H 的 peers.conf"
  beta_say "节点身份 : $(head -1 "$(beta_logfile "$BETA_NODE" out)" 2>/dev/null || true)"
  beta_say ''
  beta_say '下一步   : demo/env/beta/beta-smoke.sh --role node（本机自检）'
  beta_say '           在 H 上把上面那条入站端点填进 peers.conf，再跑 H 腿的 beta-smoke.sh'
}

# 每个 agent 一个真 git 工作区（§4.1 的 workspaces/<node>/<agent>/）。
# 幂等：已存在的不重建——重建等于把那个 agent 的工作成果扔掉。
seed_workspace() {
  local dir="$1" what="$2"
  if [ -d "$dir/.git" ]; then
    beta_ok "$what 工作区已存在：$dir"
    return 0
  fi
  mkdir -p "$dir"
  git -C "$dir" init -q
  {
    printf '# %s\n\n' "$what"
    printf '阡陌内测环境的 agent 工作区，由 demo/env/beta/beta-up.sh 生成。\n'
    printf '常驻节点以它为该 agent 的 cwd。\n'
  } >"$dir/NOTES.md"
  git -C "$dir" add NOTES.md
  # 提交身份走 -c，不依赖跑这条命令的人配过 git 全局身份（全新 VPS 上常常没配）。
  git -C "$dir" -c user.name='Qianmo Beta' -c user.email='beta@example.invalid' \
    commit -q -m 'chore(beta): 内测工作区初始提交'
  beta_ok "$what 工作区已建：$dir"
}

case "$ROLE" in
  host) run_host ;;
  node) run_node ;;
esac
