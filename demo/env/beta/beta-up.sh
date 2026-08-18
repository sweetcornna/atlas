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
#   节点入站 :  0.0.0.0:38625     每台节点机各一个；那个端口上唯一的门是 PSK 握手（§2.6/§8）
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

  beta_head "① 注册中心（$BETA_PEER_COUNT 条登记）"
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

  beta_head '② 控制台'
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
  要看镜像那一份就设 QIANMO_BETA_AUDIT_PATH=$(beta_mirror_trail "$BETA_AUDIT_NODE")；
  镜像**不是权威副本**，且页面上看不出滞后多久——beta-env.md §4.3）"
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

  beta_head '③ 备份服务'
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
  beta_say ''
  beta_say '下一步   : demo/env/beta/beta-smoke.sh --role host'
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
  args=(
    bun "$BETA_OCC" resident
    --node "$BETA_NODE"
    --team "$BETA_TEAM"
    --port "$BETA_NODE_PORT"
    --hostname "$BETA_NODE_BIND"
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
