#!/usr/bin/env bash
# Copyright 2026 Qianmo AgentNest Team
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# 阡陌 P17.5 —— 在一台节点机上起停「云端续跑」那两个进程。
#
#   demo/env/beta/handoff-node.sh start --node <名> --trust <中枢节点>=<公钥> \
#       [--project <名>]... [--port 38630] [--app-server-port 38631] [--bind <地址>]
#   demo/env/beta/handoff-node.sh stop
#
# 环境：
#   QIANMO_HANDOFF_BASE_URL   必填。模型网关的 `/v1` 地址（不进仓库）。
#   QIANMO_HANDOFF_MODEL      默认 gpt-6-luna。
#   QIANMO_HANDOFF_KEY_ENV    默认 OPENAI_API_KEY：app-server 从哪个环境变量取 key。
#                             值来自 secrets/handoff-model-env（KEY=VALUE，0600，属当前用户；
#                             常驻不读它）。这份文件不在时退回 secrets/model-env 并告警
#                             （P17.5 的旧做法；节点迁到中枢托管后那里的模型服务类键会被清掉）。
#   QIANMO_QMCODE_BIN         默认 <部署树>/qmcode/qmcode（beta-deploy.sh --only qmcode 装的那份）。
#
# ── 两个进程 ─────────────────────────────────────────────────────────────────
#
#   handoff-node        `qm handoff node`：收中枢签名的 task.request，在本机裸仓
#                       <内测根>/handoff/node/repos/<项目>.git 上开工作树、续会话、提交 qianmo/<任务>。
#   handoff-app-server  `qmcode app-server`：真正跑模型的那个。只听本机回环，令牌在
#                       secrets/handoff-app-server-token（0600，本机生成，不出机器）。
#
# 先起节点桥、后起 app-server：节点桥启动时自己查 bwrap，查不过就带着原因退出
# （没有沙箱就不续跑，不退到 danger-full-access）——那时 app-server 根本不该起。
# 节点桥连 app-server 是接到任务时才连，所以它先起不会扑空。
#
# ── key 只进 app-server 一个进程（设计 M 条）────────────────────────────────
#
# 两个进程都由本脚本这一个 shell 起，所以「谁看得见 key」只能靠起的时候怎么给环境：
#   · key 从哪份文件来，在起任何进程之前定下（只看文件形状与键名，不读值）：
#     handoff-model-env 优先；不在时退回 model-env（告警）；两边都没有 KEY_ENV 就拒绝。
#   · 节点桥起在载入**之前**，命令前再用 `env -u` 把两份文件里出现的每个键名和 KEY_ENV
#     都去掉——运维自己的 shell 里可能早就 export 着一把。
#   · app-server 起在载入之后（只载入定下的那一份），命令前 `env -u QIANMO_TRANSPORT_PSK`：
#     传输 PSK 是节点桥的，app-server 用不着。
#   · key 的**值**不进 argv、不进 config.toml（那里只写 `env_key` 的名字）、不进任何一行
#     输出；`[shell_environment_policy] inherit = "core"` 不让它进模型起的工具 shell。
#
# ── config.toml 每次 start 按环境重写 ────────────────────────────────────────
#
# qmcode 的内置配置层自带 `[mcp_servers.qianmo]`（`qm handoff mcp`）与 `notify`（回合结束
# 调 `qm handoff sync`）。节点上它们会反过来调接力命令，必须关：app-server 命令行带
#   -c mcp_servers.qianmo.enabled=false  -c 'notify=[]'
# config.toml 里同时写**完整的** `[mcp_servers.qianmo]` 表（只写 enabled = false 时
# `qmcode mcp add/remove` 报 invalid transport，docs/dev/handoff-usage.md §2）。
# 不用 `app-server daemon`：它带自动更新与自管生命周期，这里的起停归本脚本与 beta-down。

set -euo pipefail

# shellcheck source=demo/env/beta/common.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

HANDOFF_NODE_PROC='handoff-node'
HANDOFF_APP_PROC='handoff-app-server'
HANDOFF_DIR="$BETA_ROOT/handoff"
HANDOFF_NODE_ROOT="$HANDOFF_DIR/node"
HANDOFF_QMCODE_HOME="$HANDOFF_DIR/qmcode-home"
HANDOFF_APP_HOME="$HANDOFF_DIR/home"
HANDOFF_CONFIG_DIR="$HANDOFF_DIR/occ-config"
HANDOFF_TOKEN_FILE="$BETA_SECRET_DIR/handoff-app-server-token"

usage() {
  beta_say '用法：handoff-node.sh start --node <名> --trust <中枢节点>=<公钥> [选项...]'
  beta_say '      handoff-node.sh stop'
  beta_say ''
  beta_say '  --node <名>               本节点的协议名；节点桥地址是 qianmo://<名>/handoff。'
  beta_say '  --trust <节点>=<公钥>     收谁签的任务（中枢 qm console --print-wake-identity 打的那行），可多次。'
  beta_say '  --project <名>            启动时建好的裸仓，可多次。'
  beta_say '  --port N                  节点桥入站端口，默认 38630。'
  beta_say '  --app-server-port N       app-server 的本机回环端口，默认 38631。'
  beta_say "  --bind <地址>             节点桥绑定地址，默认 ${BETA_NODE_BIND}（与常驻同一个默认）。"
  beta_say ''
  beta_say '环境：QIANMO_HANDOFF_BASE_URL（必填）、QIANMO_HANDOFF_MODEL、QIANMO_HANDOFF_KEY_ENV、QIANMO_QMCODE_BIN。'
  beta_say "key 从 ${BETA_HANDOFF_MODEL_ENV_FILE} 读（0600），只给 app-server；它不在时退回 secrets/model-env 并告警。"
}

# 文件里有没有这个键名（判据同 beta_model_env_names：行首、可带 export 的 KEY=）。不读值。
handoff_env_has() {
  local file="$1" name="$2" names
  names="$(beta_model_env_names "$file")"
  case "
${names}
" in
    *"
${name}
"*) return 0 ;;
  esac
  return 1
}

# handoff_pick_key_source <KEY_ENV> —— 定 app-server 的 key 从哪份文件来，写进
# HANDOFF_KEY_SOURCE（handoff | model-env）。在起任何进程之前跑；只看文件形状与键名。
#
# handoff-model-env 只给一个进程，所以比 model-env 收得更紧：不跟软链、必须是属当前
# 用户的 0600 普通文件。
HANDOFF_KEY_SOURCE=''
handoff_pick_key_source() {
  local key_env="$1" file="$BETA_HANDOFF_MODEL_ENV_FILE" listing mode owner
  if [ -L "$file" ]; then
    beta_die "$file 是一条软链 —— 接力节点的模型 key 要一份普通文件（0600，属当前用户），不跟软链。"
  fi
  if [ -e "$file" ]; then
    [ -f "$file" ] || beta_die "$file 存在但不是普通文件 —— 要的是一份 KEY=VALUE 的 shell 片段。"
    [ -r "$file" ] || beta_die "$file 存在但读不掉 —— 该是 0600 且属当前用户。"
    listing="$(LC_ALL=C ls -ln "$file")"
    mode="$(printf '%s' "$listing" | cut -c1-10)"
    owner="$(printf '%s' "$listing" | awk '{print $3}')"
    [ "$mode" = '-rw-------' ] || beta_die "$file 的权限是 ${mode}，要 0600：chmod 600 $file"
    [ "$owner" = "$(id -u)" ] || beta_die "$file 不属当前用户（属 uid ${owner}）。"
    handoff_env_has "$file" "$key_env" \
      || beta_die "$file 里没有 ${key_env}=… —— app-server 从这个环境变量取 key（QIANMO_HANDOFF_KEY_ENV）。"
    HANDOFF_KEY_SOURCE='handoff'
    return 0
  fi
  if [ -f "$BETA_MODEL_ENV_FILE" ] && [ -r "$BETA_MODEL_ENV_FILE" ] \
    && handoff_env_has "$BETA_MODEL_ENV_FILE" "$key_env"; then
    beta_warn "没有 ${file}：app-server 的 key 这次取自 ${BETA_MODEL_ENV_FILE}（旧做法）。节点迁到中枢托管后那里的模型服务类键会被清掉，接力节点就起不来 —— 把 ${key_env}=… 那一行挪进 ${file}（0600）。"
    HANDOFF_KEY_SOURCE='model-env'
    return 0
  fi
  beta_die "没有 app-server 的模型 key：把 ${key_env}=… 写进 ${file}（chmod 600，属当前用户）。常驻节点不读这份文件。"
}

# 把 handoff-model-env 载入当前 shell（只在起 app-server 之前调）。set -a 的作用域是整个
# shell：进来时是开是关，载入完原样还回去（beta_load_model_env 同一条）。
HANDOFF_KEY_FILE_COUNT=0
handoff_load_key_file() {
  local file="$BETA_HANDOFF_MODEL_ENV_FILE" restore
  HANDOFF_KEY_FILE_COUNT="$(beta_model_env_names "$file" | grep -c '.' || true)"
  case "$-" in
    *a*) restore='set -a' ;;
    *) restore='set +a' ;;
  esac
  set -a
  # shellcheck disable=SC1090
  #   ↑ 路径是运行期算出来的；这份文件本来就不在仓库里。
  . "$file"
  eval "$restore"
}

# 横幅上那一行：只说来源、几个键，不说键名与值。
handoff_key_line() {
  case "$HANDOFF_KEY_SOURCE" in
    handoff) printf '已加载（%s，%s 个环境键，只给 app-server）' "$BETA_HANDOFF_MODEL_ENV_FILE" "$HANDOFF_KEY_FILE_COUNT" ;;
    model-env) printf '%s（旧做法：取自 model-env）' "$(beta_model_env_line)" ;;
    *) printf '未加载' ;;
  esac
}

# TOML 基本字符串里不能有的东西一律拒收，而不是去转义：这几个值都是运维给的短串，
# 出现引号、反斜杠或控制字符只可能是贴错了。
assert_toml_safe() {
  local value="$1" what="$2"
  case "$value" in
    *'"'*|*\\*) beta_die "${what} 里有引号或反斜杠，拒收：$value" ;;
  esac
  if printf '%s' "$value" | LC_ALL=C grep -q '[[:cntrl:]]'; then
    beta_die "${what} 里有控制字符，拒收"
  fi
  return 0
}

write_qmcode_config() {
  local model="$1" base_url="$2" key_env="$3" tmp
  mkdir -p "$HANDOFF_QMCODE_HOME"
  chmod 700 "$HANDOFF_QMCODE_HOME"
  tmp="$HANDOFF_QMCODE_HOME/config.toml.tmp.$$"
  cat >"$tmp" <<EOF
# 由 demo/env/beta/handoff-node.sh 生成，每次 start 按环境重写；手改会被覆盖。
model_provider = "qianmo"
model = "${model}"
approval_policy = "never"
sandbox_mode = "workspace-write"
check_for_update_on_startup = false

[analytics]
enabled = false

[features]
plugins = false

[shell_environment_policy]
inherit = "core"

[sandbox_workspace_write]
network_access = true

[model_providers.qianmo]
name = "qianmo"
base_url = "${base_url}"
env_key = "${key_env}"
wire_api = "responses"

[mcp_servers.qianmo]
command = "qm"
args = ["handoff", "mcp"]
enabled = false
EOF
  chmod 600 "$tmp"
  mv -f "$tmp" "$HANDOFF_QMCODE_HOME/config.toml"
}

do_start() {
  local node='' port=38630 app_port=38631 bind="$BETA_NODE_BIND"
  local trusts=() projects=() pass=() item
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --node) node="${2:-}"; shift 2 ;;
      --trust) trusts+=("${2:-}"); shift 2 ;;
      --project) projects+=("${2:-}"); shift 2 ;;
      --port) port="${2:-}"; shift 2 ;;
      --app-server-port) app_port="${2:-}"; shift 2 ;;
      --bind) bind="${2:-}"; shift 2 ;;
      -h|--help) usage; exit 0 ;;
      *) beta_say "未知参数：$1"; beta_say ''; usage; exit 1 ;;
    esac
  done
  beta_assert_node_name "$node" '--node'
  beta_assert_port "$port" '--port' 'handoff-node.sh'
  beta_assert_port "$app_port" '--app-server-port' 'handoff-node.sh'
  [ "$port" != "$app_port" ] || beta_die "--port 与 --app-server-port 不能是同一个：$port"
  [ -n "$bind" ] || beta_die '--bind 为空'

  local base_url="${QIANMO_HANDOFF_BASE_URL:-}"
  local model="${QIANMO_HANDOFF_MODEL:-gpt-6-luna}"
  local key_env="${QIANMO_HANDOFF_KEY_ENV:-OPENAI_API_KEY}"
  local qmcode="${QIANMO_QMCODE_BIN:-$REPO_DIR/qmcode/qmcode}"
  [ -n "$base_url" ] || beta_die 'QIANMO_HANDOFF_BASE_URL 没给 —— 模型网关的 /v1 地址，按运维单页填，不进仓库'
  case "$base_url" in
    http://*|https://*) ;;
    *) beta_die "QIANMO_HANDOFF_BASE_URL 要 http(s):// 开头：$base_url" ;;
  esac
  assert_toml_safe "$base_url" 'QIANMO_HANDOFF_BASE_URL'
  [ -n "$model" ] || beta_die 'QIANMO_HANDOFF_MODEL 为空'
  assert_toml_safe "$model" 'QIANMO_HANDOFF_MODEL'
  case "$key_env" in
    ''|[0-9]*|*[!ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_]*)
      beta_die "QIANMO_HANDOFF_KEY_ENV 要一个环境变量名：$key_env" ;;
  esac
  [ "$key_env" != 'QIANMO_TRANSPORT_PSK' ] || beta_die 'QIANMO_HANDOFF_KEY_ENV 不能是传输 PSK 的名字'

  beta_require_marker
  beta_require_occ
  local qmcode_real
  qmcode_real="$(beta_qmcode_check "$qmcode")"
  handoff_pick_key_source "$key_env"

  mkdir -p "$BETA_RUN_DIR" "$BETA_LOG_DIR" "$HANDOFF_DIR" "$HANDOFF_NODE_ROOT" "$HANDOFF_APP_HOME"
  chmod 700 "$HANDOFF_DIR" "$HANDOFF_NODE_ROOT" "$HANDOFF_APP_HOME"
  mkdir -p "$BETA_SECRET_DIR"
  chmod 700 "$BETA_SECRET_DIR"

  # app-server 的令牌只在本机两进程之间用：本机生成、0600、已有就沿用（两个进程都在跑时
  # 换掉它，正在跑的 app-server 认的还是旧的）。
  if [ ! -s "$HANDOFF_TOKEN_FILE" ]; then
    beta_assert_inside_root "$HANDOFF_TOKEN_FILE"
    (umask 077 && beta_random_hex 32 >"$HANDOFF_TOKEN_FILE")
    beta_ok "app-server 令牌已生成：$HANDOFF_TOKEN_FILE"
  fi
  chmod 600 "$HANDOFF_TOKEN_FILE"

  write_qmcode_config "$model" "$base_url" "$key_env"
  beta_ok "qmcode 配置已写：$HANDOFF_QMCODE_HOME/config.toml（模型 ${model}，key 取自环境变量 ${key_env}）"

  # ── 节点桥：载入 key 之前起，且把两份文件里可能残留的 key 名逐个去掉 ──
  beta_head '起节点桥'
  beta_load_psk "$BETA_PSK_FILE" '传输 PSK（中枢拨入节点桥用的那把）'
  export OCC_IDENTITY=qianmo
  local name env_file
  local strip=(-u "$key_env")
  for env_file in "$BETA_HANDOFF_MODEL_ENV_FILE" "$BETA_MODEL_ENV_FILE"; do
    [ -f "$env_file" ] && [ -r "$env_file" ] || continue
    while IFS= read -r name; do
      [ -n "$name" ] || continue
      strip+=(-u "$name")
    done <<EOF
$(beta_model_env_names "$env_file")
EOF
  done
  for item in ${trusts[@]+"${trusts[@]}"}; do pass+=(--trust "$item"); done
  for item in ${projects[@]+"${projects[@]}"}; do pass+=(--project "$item"); done
  beta_start_process "$HANDOFF_NODE_PROC" "$HANDOFF_CONFIG_DIR" \
    env "${strip[@]}" bun "$BETA_OCC" handoff node \
    --node "$node" \
    --root "$HANDOFF_NODE_ROOT" \
    --port "$port" \
    --bind "$bind" \
    --app-server "ws://127.0.0.1:${app_port}" \
    --app-server-token-file "$HANDOFF_TOKEN_FILE" \
    --app-server-home "$HANDOFF_APP_HOME" \
    --qmcode-home "$HANDOFF_QMCODE_HOME" \
    --app-server-pid-file "$(beta_pidfile "$HANDOFF_APP_PROC")" \
    ${pass[@]+"${pass[@]}"}

  # ── app-server：这时才载入 key（只载入定下的那一份）──
  beta_head '起 app-server'
  local key_file="$BETA_HANDOFF_MODEL_ENV_FILE"
  if [ "$HANDOFF_KEY_SOURCE" = 'handoff' ]; then
    handoff_load_key_file
  else
    key_file="$BETA_MODEL_ENV_FILE"
    beta_load_model_env
  fi
  if [ -z "${!key_env:-}" ]; then
    beta_stop_one "$HANDOFF_NODE_PROC"
    beta_die "环境变量 ${key_env} 是空的 —— ${key_file} 里那一行没有值。节点桥已停回去。"
  fi
  if ! (beta_start_process "$HANDOFF_APP_PROC" "$HANDOFF_APP_HOME" \
    env -u QIANMO_TRANSPORT_PSK \
    HOME="$HANDOFF_APP_HOME" \
    QMCODE_HOME="$HANDOFF_QMCODE_HOME" \
    "$qmcode_real" app-server \
    --listen "ws://127.0.0.1:${app_port}" \
    --ws-auth capability-token \
    --ws-token-file "$HANDOFF_TOKEN_FILE" \
    -c 'mcp_servers.qianmo.enabled=false' \
    -c 'notify=[]'); then
    beta_stop_one "$HANDOFF_NODE_PROC"
    beta_die 'app-server 没起来（原因在上面）。节点桥已停回去 —— 只剩一半的节点会接下任务再失败。'
  fi

  beta_head '已起'
  beta_say "节点桥     : qianmo://${node}/handoff，监听 ${bind}:${port}"
  beta_say "app-server : ws://127.0.0.1:${app_port}（${qmcode_real}）"
  beta_say "模型凭据   : $(handoff_key_line)"
  beta_say "日志       : $(beta_logfile "$HANDOFF_NODE_PROC" out)、$(beta_logfile "$HANDOFF_APP_PROC" err)"
  beta_say '中枢那边   : qm console --handoff-node <本节点>=ws://<本机>:<端口> --handoff-node-git <本节点>=<ssh 目标>:<本节点 node 根>'
}

do_stop() {
  [ "$#" -eq 0 ] || { beta_say "stop 不接参数：$1"; usage; exit 1; }
  beta_require_marker
  # 先停节点桥：它不再接任务，再停它背后的 app-server。数据（裸仓、工作树、结果）一个不删。
  beta_head '停接力节点'
  local name
  for name in "$HANDOFF_NODE_PROC" "$HANDOFF_APP_PROC"; do
    if ! beta_running "$name"; then beta_say "$name 本来就没在跑"; fi
    # 无论如何都跑一遍：它顺带清掉指向已死进程的陈旧 pid 文件（beta-down.sh 同一条）。
    beta_stop_one "$name"
  done
  beta_say "数据仍在 : $HANDOFF_DIR"
}

action="${1:-}"
[ "$#" -eq 0 ] || shift
case "$action" in
  start) do_start "$@" ;;
  stop) do_stop "$@" ;;
  -h|--help|'') usage; [ -n "$action" ] || exit 1 ;;
  *) beta_say "未知动作：$action"; usage; exit 1 ;;
esac
