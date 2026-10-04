#!/usr/bin/env bash
# Copyright 2026 Qianmo AgentNest Team
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# 阡陌内测 · 第六类动作的专用 key 登记（`providers-console-m1.md` §2.9 第 2 步，P18.13）。
#
#   model-apply-enroll.sh enroll --node <节点> --hub <ssh 目标> --hub-tree <H 部署根> \
#                                --node-ssh <ssh 目标> --node-tree <节点部署根> [--dry-run]
#
# 在**运维本机**跑（macOS bash 3.2 与 Linux bash 5 都行）。它经 ssh 调中枢与节点**部署树里
# 的同一个脚本**的几个子命令，把一个远端节点接到中枢的模型服务执行器上：
#
#   ① H     hub-key        没有就生成这个节点的专用 ed25519 key（私钥不离开 H），打印公钥
#   ② H     hub-coordinate 从 peers.conf 的 node 坐标行取 user / host / port（中枢拨的就是它）
#   ③ 节点  node-install   往 ~/.ssh/authorized_keys 幂等地加那一行（见下）
#   ④ 节点  node-hostkey   读节点自己的 ed25519 主机公钥
#   ⑤ H     hub-known-host 从 H 上 ssh-keyscan 一次，与 ④ 逐字比对，相同才写进中枢的 known_hosts
#   ⑥ H     hub-verify     用中枢执行器同一组 ssh 参数、同一个哨兵命令发一次 status，要 ok:true
#
# 每个子命令也能单独跑（手工补某一步、或排查时），用法见下面各函数的头注。
#
# ── 那一行 ──────────────────────────────────────────────────────────────────────
#   command="<节点部署根>/demo/env/beta/ops/model-apply.sh <节点>",restrict ssh-ed25519 <公钥> qianmo-model-apply <节点>
#
# 与 `model-apply.sh` 头注、README「模型服务」手工装法（`-C "qianmo-model-apply <节点>"` 生成的 .pub 原样接在
# `restrict` 后面）得到的那一行一字不差（用例逐字断言）。
# `restrict` 一次关掉端口转发、代理转发、X11、pty 与 ~/.ssh/rc，不留任何一项（这一把只跑
# 第六类动作，用不着转发）。部署根取本脚本所在树的**逻辑**路径（`cd` + `pwd`，不解软链）：
# 部署根若是一条指向带版本号目录的软链，强制命令跟着软链走，换版本之后照样有效。路径只许
# `A-Z a-z 0-9 . _ / -`：它要进 `command=`，由节点上的登录 shell 再 `-c` 一次。
#
# ── 幂等 ────────────────────────────────────────────────────────────────────────
#   · key：已在就不重生成（重生成等于让节点上那一行作废）；
#   · authorized_keys：那一行原样在就不动；**同一把公钥带着别的选项**在 → 拒绝、不改（sshd 只认
#     第一条匹配的行，改哪一行要人看过）；同一节点还有别的 model-apply 行（换过 key）→ WARN 点名，不删；
#     要写时先备份 `authorized_keys.bak-<UTC>`（0600），再 tmp + mv，原有内容一个字节不动；
#   · known_hosts：同名同钥就不动；同名不同钥 → 拒绝。
#
# ── 主机指纹从哪来（不 TOFU）─────────────────────────────────────────────────────
# 信任锚是运维本机到节点那条**已经认证过**的 ssh（它自己的 known_hosts 早就钉着这台机器）：经它读回
# 节点自报的主机公钥；H 上 ssh-keyscan 到的必须与它逐字相同。不同就是中间人或坐标写错，拒绝。
# 写进中枢 known_hosts 的名字与执行器认的一致：端口 22 写 `host`，否则 `[host]:port`。
#
# ── --dry-run ───────────────────────────────────────────────────────────────────
# 每一步只读：不生成 key、不写 authorized_keys、不写 known_hosts、不跑 ⑥。打印「将要」的那一行。
#
# ── 退出码 ──────────────────────────────────────────────────────────────────────
#   0 做完（或 dry-run 看完）；1 拒绝或某一步失败（原因在 stderr）；2 用法错。

set -euo pipefail

# 下面的字符类与 ${#} 都按字节算，不随登录用户的 locale 变（handoff-git-gate.sh 同一条理由）。
LC_ALL=C
export LC_ALL
umask 077

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SELF="${SELF_DIR}/$(basename "${BASH_SOURCE[0]}")"
# 强制命令指向的脚本：本脚本所在那棵部署树里的 model-apply.sh。
MODEL_APPLY="${SELF_DIR}/model-apply.sh"
SENTINEL='qianmo-model-apply-v1'
KEY_COMMENT_PREFIX='qianmo-model-apply'

# shellcheck source=demo/env/beta/common.sh
. "${SELF_DIR}/../common.sh"

# 远端子命令的絮语一律走 stderr：stdout 只留给编排那一侧要解析的机器行。
note() { printf '%s\n' "$*" >&2; }
refuse() {
  printf 'FAIL : %s\n' "$*" >&2
  exit 1
}
usage_die() {
  printf '%s\n' "$*" >&2
  printf '用法：model-apply-enroll.sh enroll --node <节点> --hub <ssh 目标> --hub-tree <H 部署根> --node-ssh <ssh 目标> --node-tree <节点部署根> [--dry-run]\n' >&2
  exit 2
}

# 协议的节点名规则（`[a-z0-9-]{1,32}`，与 model-apply.sh、parseProviderRequest 一致）。
assert_node() {
  case "$1" in
    '' | *[!abcdefghijklmnopqrstuvwxyz0123456789-]*) usage_die "节点名不合法：只收小写字母、数字和 -（收到：${1}）" ;;
  esac
  [ "${#1}" -le 32 ] || usage_die "节点名不合法：超过 32 个字符（${1}）"
}

# 要进 command= 或远端命令行的绝对路径：只许不需要引号的字符。
assert_safe_abs() {
  local what="$1" value="$2"
  case "$value" in /*) ;; *) usage_die "${what} 必须是绝对路径：${value}" ;; esac
  case "$value" in
    *[!ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._/-]*)
      usage_die "${what} 里只许 A-Z a-z 0-9 . _ / -（它要进 command= 与远端命令行）：${value}"
      ;;
  esac
  case "${value}/" in */../*) usage_die "${what} 里不许有 .. 段：${value}" ;; esac
}

# ssh 目标原样交给 ssh：不许空白、不许以 - 开头（会被当成选项）。
assert_ssh_target() {
  case "$2" in
    '' | -* | *[[:space:]]*) usage_die "$1 不像一个 ssh 目标：${2}" ;;
  esac
}

# parse_pubkey <一行> —— 拆成 PUB_TYPE / PUB_BLOB；不像一把 OpenSSH 公钥就返回 1。
PUB_TYPE=''
PUB_BLOB=''
parse_pubkey() {
  local line="$1" rest
  case "$line" in *[[:cntrl:]]*) return 1 ;; esac
  PUB_TYPE="${line%% *}"
  rest="${line#* }"
  PUB_BLOB="${rest%% *}"
  case "$PUB_TYPE" in
    ssh-ed25519 | ssh-rsa | ecdsa-sha2-nistp256 | ecdsa-sha2-nistp384 | ecdsa-sha2-nistp521) ;;
    sk-ssh-ed25519@openssh.com | sk-ecdsa-sha2-nistp256@openssh.com) ;;
    *) return 1 ;;
  esac
  case "$PUB_BLOB" in
    '' | *[!ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=]*) return 1 ;;
  esac
  return 0
}

# authorized_line <节点> —— 那一行（PUB_TYPE / PUB_BLOB 已解析好）。
authorized_line() {
  printf 'command="%s %s",restrict %s %s %s %s\n' \
    "$MODEL_APPLY" "$1" "$PUB_TYPE" "$PUB_BLOB" "$KEY_COMMENT_PREFIX" "$1"
}

# ── authorized-key --node <节点> --pubkey-file <文件|-> ──────────────────────────
# 纯函数：打印那一行，不碰任何文件。给手工装的人、也给用例逐字核对。
cmd_authorized_key() {
  local node='' file='' line
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --node) node="${2:-}"; shift 2 ;;
      --pubkey-file) file="${2:-}"; shift 2 ;;
      *) usage_die "authorized-key 不认识的参数：$1" ;;
    esac
  done
  assert_node "$node"
  [ -n "$file" ] || usage_die 'authorized-key 要 --pubkey-file <文件|->'
  assert_safe_abs '部署根下的 model-apply.sh 路径' "$MODEL_APPLY"
  if [ "$file" = '-' ]; then
    IFS= read -r line || true
  else
    [ -f "$file" ] || refuse "公钥文件不存在：$file"
    IFS= read -r line <"$file" || true
  fi
  parse_pubkey "$line" || refuse '不像一把 OpenSSH 公钥（给的是私钥，或已经带了选项？）'
  authorized_line "$node"
}

# ── hub-key --node <节点> [--dry-run] ───────────────────────────────────────────
# H 上。stdout 一行：`PUBKEY <类型> <公钥>`；dry-run 且还没生成时 `PUBKEY-ABSENT`。
cmd_hub_key() {
  local node='' dry=0 key pub line
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --node) node="${2:-}"; shift 2 ;;
      --dry-run) dry=1; shift ;;
      *) usage_die "hub-key 不认识的参数：$1" ;;
    esac
  done
  assert_node "$node"
  key="${BETA_MODEL_KEY_DIR}/${node}"
  pub="${key}.pub"
  if [ -f "$key" ]; then
    if [ -f "$pub" ]; then
      IFS= read -r line <"$pub" || true
    else
      # 公钥文件丢了而私钥在：从私钥推出来，不重生成（重生成会让节点上那一行作废）。
      line="$(ssh-keygen -y -f "$key")"
    fi
    parse_pubkey "$line" || refuse "${key} 的公钥读不出来"
    note "OK   : ${node} 的专用 key 已在（${key}），不重生成"
  elif [ "$dry" = '1' ]; then
    note "DRY  : 将生成 ${key}（ed25519，无口令，目录 0700、私钥 0600）"
    printf 'PUBKEY-ABSENT\n'
    return 0
  else
    mkdir -p "$BETA_MODEL_KEY_DIR"
    chmod 700 "$BETA_MODEL_KEY_DIR"
    ssh-keygen -q -t ed25519 -N '' -C "${KEY_COMMENT_PREFIX} ${node}" -f "$key" </dev/null >/dev/null
    chmod 600 "$key"
    IFS= read -r line <"$pub" || true
    parse_pubkey "$line" || refuse "刚生成的 ${pub} 读不出来"
    note "OK   : 已生成 ${node} 的专用 key（${key}，私钥不离开这台机器）"
  fi
  printf 'PUBKEY %s %s\n' "$PUB_TYPE" "$PUB_BLOB"
}

# ── hub-coordinate --node <节点> ────────────────────────────────────────────────
# H 上。stdout 一行：`COORD <user> <host> <port>`（peers.conf 的 node 坐标行，中枢执行器拨的就是它）。
cmd_hub_coordinate() {
  local node='' index
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --node) node="${2:-}"; shift 2 ;;
      *) usage_die "hub-coordinate 不认识的参数：$1" ;;
    esac
  done
  assert_node "$node"
  beta_load_peers
  if ! index="$(beta_ssh_index "$node")"; then
    refuse "${BETA_PEERS_FILE} 里 ${node} 没有 node 坐标行。跑在 H 自己身上的节点走 local，不需要登记；
直连的远端节点中枢没有控制面，先给它一条坐标行（README「链路：直连与隧道」）。"
  fi
  printf 'COORD %s %s %s\n' "${BETA_SSH_USER[$index]}" "${BETA_SSH_HOST[$index]}" "${BETA_SSH_PORT[$index]}"
}

# 中枢 known_hosts 里这台机器用的名字：端口 22 写 host，否则 [host]:port（consoleProvidersExec.ts 的 knownHostsHasEntry）。
known_name() {
  if [ "$2" = '22' ]; then printf '%s' "$1"; else printf '[%s]:%s' "$1" "$2"; fi
}

# ── node-install --node <节点> [--dry-run] ──────────────────────────────────────
# 节点上。stdin 第一行：`PUBKEY <类型> <公钥>`（或 dry-run 时的 `PUBKEY-ABSENT`）。
# stdout 一行：`INSTALLED|PRESENT|WOULD-ADD <那一行>`。
cmd_node_install() {
  local node='' dry=0 input line ak dir config default_root stale bak tmp
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --node) node="${2:-}"; shift 2 ;;
      --dry-run) dry=1; shift ;;
      *) usage_die "node-install 不认识的参数：$1" ;;
    esac
  done
  assert_node "$node"
  assert_safe_abs '部署根下的 model-apply.sh 路径' "$MODEL_APPLY"
  [ -f "$MODEL_APPLY" ] && [ -x "$MODEL_APPLY" ] \
    || refuse "强制命令要指向的 ${MODEL_APPLY} 不在或不可执行 —— --node-tree 给的是这台机器上的部署根吗？"
  # sshd 起强制命令时环境里没有 QIANMO_BETA_ROOT：model-apply.sh 只会看默认根。
  default_root="${HOME}/qianmo-beta"
  if [ -n "${QIANMO_BETA_ROOT:-}" ] && [ "$QIANMO_BETA_ROOT" != "$default_root" ]; then
    refuse "这个会话设了 QIANMO_BETA_ROOT=${QIANMO_BETA_ROOT}，而 sshd 强制命令下 model-apply.sh 只看 ${default_root}。
两者不一致时中枢的每一次操作都会回「这台机器上没有这个节点的配置根」。"
  fi
  config="${default_root}/nodes/${node}/config"
  if [ ! -d "$config" ] || [ -L "${default_root}/nodes/${node}" ] || [ -L "$config" ]; then
    refuse "这台机器上没有 ${node} 的配置根 ${config}（节点腿 beta-up.sh --role node --node ${node} 建出来的；model-apply.sh 不认软链）"
  fi

  dir="${HOME}/.ssh"
  ak="${dir}/authorized_keys"
  [ ! -L "$ak" ] || refuse "${ak} 是一条软链：不替它决定写到哪去，手工处理"

  IFS= read -r input || true
  case "$input" in
    PUBKEY-ABSENT)
      [ "$dry" = '1' ] || refuse '没有收到公钥（PUBKEY-ABSENT 只在 --dry-run 里出现）'
      PUB_BLOB=''
      line="command=\"${MODEL_APPLY} ${node}\",restrict ssh-ed25519 <H 上将生成的公钥> ${KEY_COMMENT_PREFIX} ${node}"
      ;;
    'PUBKEY '*)
      parse_pubkey "${input#PUBKEY }" || refuse '收到的公钥不像一把 OpenSSH 公钥'
      line="$(authorized_line "$node")"
      if [ -f "$ak" ] && grep -Fxq -- "$line" "$ak"; then
        note "OK   : ${ak} 里已有这一行，不动"
        printf 'PRESENT %s\n' "$line"
        return 0
      fi
      if [ -f "$ak" ] && grep -Fq -- " ${PUB_BLOB}" "$ak"; then
        refuse "${ak} 里已经有这把公钥，但那一行不是要装的这一行（sshd 只认第一条匹配的行）。
核对之后手工删掉那一行再跑；本脚本不替人决定哪一行该留。"
      fi
      ;;
    *) refuse 'stdin 第一行应是 PUBKEY <类型> <公钥>' ;;
  esac
  # 走到这里：这把公钥不在文件里。同一节点还指着 model-apply.sh 的行就都是别的 key（换过 key）。
  stale=0
  if [ -f "$ak" ]; then
    stale="$(grep -cF -- "/model-apply.sh ${node}\"" "$ak" || true)"
  fi
  if [ "$stale" -gt 0 ]; then
    note "WARN : ${ak} 里还有 ${stale} 行别的 key 指向 ${node} 的 model-apply.sh（换过 key？）。本脚本不删，核对后手工删。"
  fi
  if [ "$dry" = '1' ]; then
    note "DRY  : 将追加：${line}"
    printf 'WOULD-ADD %s\n' "$line"
    return 0
  fi
  mkdir -p "$dir"
  chmod 700 "$dir"
  tmp="${dir}/.authorized_keys.qianmo.$$"
  if [ -f "$ak" ]; then
    bak="${ak}.bak-$(beta_stamp)"
    cp -p "$ak" "$bak"
    chmod 600 "$bak"
    cat "$ak" >"$tmp"
    # 原文件最后一行没有换行时补一个，免得新行粘在别人那一行后面。
    if [ -s "$ak" ] && [ "$(tail -c 1 "$ak" | od -An -c | tr -d ' ')" != '\n' ]; then
      printf '\n' >>"$tmp"
    fi
    note "OK   : 原文件已备份：${bak}"
  else
    : >"$tmp"
  fi
  printf '%s\n' "$line" >>"$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$ak"
  note "OK   : 已追加到 ${ak}"
  printf 'INSTALLED %s\n' "$line"
}

# ── node-hostkey ─────────────────────────────────────────────────────────────────
# 节点上。stdout 一行：`HOSTKEY ssh-ed25519 <公钥>`。来源默认 sshd 的主机公钥文件。
cmd_node_hostkey() {
  [ "$#" -eq 0 ] || usage_die "node-hostkey 不收参数：$*"
  local file="${QIANMO_SSHD_HOST_KEY:-/etc/ssh/ssh_host_ed25519_key.pub}" line
  [ -r "$file" ] || refuse "读不到 ${file}（节点的 sshd 没有 ed25519 主机钥？）"
  IFS= read -r line <"$file" || true
  parse_pubkey "$line" || refuse "${file} 不像一把公钥"
  [ "$PUB_TYPE" = 'ssh-ed25519' ] || refuse "${file} 不是 ed25519"
  printf 'HOSTKEY %s %s\n' "$PUB_TYPE" "$PUB_BLOB"
}

# ── hub-known-host --node <节点> [--dry-run] ───────────────────────────────────
# H 上。stdin 第一行：`HOSTKEY ssh-ed25519 <公钥>`（节点经已认证通道自报的）。
# stdout 一行：`REGISTERED|PRESENT|WOULD-ADD <known_hosts 那一行>`。
cmd_hub_known_host() {
  local node='' dry=0 input coord user host port name want scanned got entry found fp
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --node) node="${2:-}"; shift 2 ;;
      --dry-run) dry=1; shift ;;
      *) usage_die "hub-known-host 不认识的参数：$1" ;;
    esac
  done
  assert_node "$node"
  IFS= read -r input || true
  case "$input" in
    'HOSTKEY '*) parse_pubkey "${input#HOSTKEY }" || refuse '收到的主机公钥读不出来' ;;
    *) refuse 'stdin 第一行应是 HOSTKEY ssh-ed25519 <公钥>' ;;
  esac
  [ "$PUB_TYPE" = 'ssh-ed25519' ] || refuse '只登记 ed25519 主机钥'
  want="$PUB_BLOB"
  coord="$(cmd_hub_coordinate --node "$node")"
  # shellcheck disable=SC2086
  set -- $coord
  user="$2" host="$3" port="$4"
  name="$(known_name "$host" "$port")"
  entry="${name} ssh-ed25519 ${want}"

  # 从 H 这一侧看到的主机钥：中枢执行器拨的正是这条路。
  scanned="$(ssh-keyscan -T 10 -t ed25519 -p "$port" "$host" 2>/dev/null | grep -v '^#' || true)"
  got=''
  if [ -n "$scanned" ]; then
    got="$(printf '%s\n' "$scanned" | awk '$2 == "ssh-ed25519" { print $3; exit }')"
  fi
  [ -n "$got" ] || refuse "从这台机器 ssh-keyscan ${name} 没拿到 ed25519 主机钥（${user}@${host}:${port} 拨不通？）"
  [ "$got" = "$want" ] || refuse "从这台机器扫到的 ${name} 主机钥与节点自报的不一样 —— 中间人，或者 peers.conf 的坐标指错了机器。不登记。"

  fp="$(printf '%s\n' "$entry" | ssh-keygen -lf - 2>/dev/null | awk '{ print $2 }' || true)"
  if [ -f "$BETA_MODEL_KNOWN_HOSTS" ] && found="$(ssh-keygen -F "$name" -f "$BETA_MODEL_KNOWN_HOSTS" 2>/dev/null | grep -v '^#')"; then
    if printf '%s\n' "$found" | awk -v b="$want" '$2 == "ssh-ed25519" && $3 == b { ok = 1 } END { exit ok ? 0 : 1 }'; then
      note "OK   : 中枢 known_hosts 里已有 ${name}（${fp}），不动"
      printf 'PRESENT %s\n' "$entry"
      return 0
    fi
    if printf '%s\n' "$found" | awk '$2 == "ssh-ed25519" { bad = 1 } END { exit bad ? 0 : 1 }'; then
      refuse "中枢 known_hosts 里 ${name} 已经登记了另一把 ed25519 主机钥。节点重装过？核对后手工删掉旧行（ssh-keygen -R '${name}' -f ${BETA_MODEL_KNOWN_HOSTS}）再跑。"
    fi
  fi
  if [ "$dry" = '1' ]; then
    note "DRY  : 将登记 ${name}（${fp}）到 ${BETA_MODEL_KNOWN_HOSTS}"
    printf 'WOULD-ADD %s\n' "$entry"
    return 0
  fi
  mkdir -p "$BETA_MODEL_KEY_DIR"
  chmod 700 "$BETA_MODEL_KEY_DIR"
  if [ -s "$BETA_MODEL_KNOWN_HOSTS" ] && [ "$(tail -c 1 "$BETA_MODEL_KNOWN_HOSTS" | od -An -c | tr -d ' ')" != '\n' ]; then
    printf '\n' >>"$BETA_MODEL_KNOWN_HOSTS"
  fi
  printf '%s\n' "$entry" >>"$BETA_MODEL_KNOWN_HOSTS"
  chmod 600 "$BETA_MODEL_KNOWN_HOSTS"
  note "OK   : 已登记 ${name}（${fp}）到 ${BETA_MODEL_KNOWN_HOSTS}"
  printf 'REGISTERED %s\n' "$entry"
}

# ── hub-verify --node <节点> ──────────────────────────────────────────────────────
# H 上。用中枢执行器的 ssh 参数（consoleProvidersExec.ts 的 providerSshArgv）与哨兵发一次 status。
# stdout 一行：`VERIFY ok managed=<true|false>`；不是 ok:true 就退 1。响应里本来就没有任何值。
cmd_hub_verify() {
  local node='' coord user host port key rid reply rc managed line
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --node) node="${2:-}"; shift 2 ;;
      *) usage_die "hub-verify 不认识的参数：$1" ;;
    esac
  done
  assert_node "$node"
  coord="$(cmd_hub_coordinate --node "$node")"
  # shellcheck disable=SC2086
  set -- $coord
  user="$2" host="$3" port="$4"
  key="${BETA_MODEL_KEY_DIR}/${node}"
  [ -f "$key" ] || refuse "没有 ${key}：先跑 hub-key"
  [ -f "$BETA_MODEL_KNOWN_HOSTS" ] || refuse "没有 ${BETA_MODEL_KNOWN_HOSTS}：先跑 hub-known-host"
  rid="enroll-$(beta_stamp)-$$"
  rc=0
  reply="$(printf '{"v":1,"op":"status","requestId":"%s","node":"%s"}\n' "$rid" "$node" \
    | ssh -F /dev/null -i "$key" \
      -o IdentitiesOnly=yes -o IdentityAgent=none -o BatchMode=yes \
      -o StrictHostKeyChecking=yes -o "UserKnownHostsFile=${BETA_MODEL_KNOWN_HOSTS}" \
      -o GlobalKnownHostsFile=/dev/null -o ControlMaster=no -o ControlPath=none \
      -o ConnectTimeout=10 -o LogLevel=ERROR -T -x -a \
      -p "$port" "${user}@${host}" "$SENTINEL" 2>&1)" || rc=$?
  # 协议响应是带 "requestId" 的那一行；其余（ssh 自己的报错）只在失败时转述头几行。
  line="$(printf '%s\n' "$reply" | grep -F '"requestId"' | head -n 1 || true)"
  case "$line" in
    *'"ok":true'*)
      managed="$(printf '%s' "$line" | sed -n 's/.*"managed":\([a-z]*\).*/\1/p')"
      note "OK   : ${node} 回了 status（ok:true）—— 专用 key 被接受、强制命令生效、节点配置根在"
      printf 'VERIFY ok managed=%s\n' "${managed:-unknown}"
      ;;
    *)
      refuse "${node} 没有回 ok:true（ssh 退出码 ${rc}）：$(printf '%s\n' "$reply" | head -n 3)
退出码 255 = 连接 / 主机钥 / 公钥被拒；127 = 强制命令那一行没生效，sshd 去执行了哨兵 ${SENTINEL}。"
      ;;
  esac
}

# ── enroll（运维本机）───────────────────────────────────────────────────────────
# 远端调同一个脚本的子命令：bash '<部署根>/demo/env/beta/ops/model-apply-enroll.sh' <子命令> …
remote() {
  local target="$1" tree="$2"
  shift 2
  ssh -o BatchMode=yes -o ConnectTimeout=15 "$target" \
    "bash '${tree}/demo/env/beta/ops/model-apply-enroll.sh' $*"
}

cmd_enroll() {
  local node='' hub='' hub_tree='' node_ssh='' node_tree='' dry=0 dry_flag='' out pubkey hostkey line
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --node) node="${2:-}"; shift 2 ;;
      --hub) hub="${2:-}"; shift 2 ;;
      --hub-tree) hub_tree="${2:-}"; shift 2 ;;
      --node-ssh) node_ssh="${2:-}"; shift 2 ;;
      --node-tree) node_tree="${2:-}"; shift 2 ;;
      --dry-run) dry=1; dry_flag=' --dry-run'; shift ;;
      -h | --help) usage_die '' ;;
      *) usage_die "enroll 不认识的参数：$1" ;;
    esac
  done
  assert_node "$node"
  assert_ssh_target '--hub' "$hub"
  assert_ssh_target '--node-ssh' "$node_ssh"
  assert_safe_abs '--hub-tree' "$hub_tree"
  assert_safe_abs '--node-tree' "$node_tree"

  if [ "$dry" = '1' ]; then
    beta_head "登记 ${node} 的第六类动作专用 key（dry-run：只读，不改任何东西）"
  else
    beta_head "登记 ${node} 的第六类动作专用 key"
  fi

  beta_say '① H：专用 key'
  out="$(remote "$hub" "$hub_tree" "hub-key --node ${node}${dry_flag}" </dev/null)" \
    || beta_die "① 失败（H 上 hub-key），后面的步骤没有做"
  pubkey="$(printf '%s\n' "$out" | grep -E '^PUBKEY(-ABSENT| )' | head -n 1 || true)"
  [ -n "$pubkey" ] || beta_die '① H 没有回公钥行'

  beta_say '② H：peers.conf 里的坐标'
  out="$(remote "$hub" "$hub_tree" "hub-coordinate --node ${node}" </dev/null)" \
    || beta_die '② 失败：H 上没有这个节点的 node 坐标行'
  beta_ok "中枢拨的是 $(printf '%s' "$out" | sed -n 's/^COORD \([^ ]*\) \([^ ]*\) \([^ ]*\)$/\1@\2:\3/p')"

  beta_say '③ 节点：authorized_keys 那一行'
  out="$(printf '%s\n' "$pubkey" | remote "$node_ssh" "$node_tree" "node-install --node ${node}${dry_flag}")" \
    || beta_die '③ 失败（节点上 node-install），authorized_keys 没有改'
  line="$(printf '%s\n' "$out" | grep -E '^(INSTALLED|PRESENT|WOULD-ADD) ' | head -n 1 || true)"
  [ -n "$line" ] || beta_die '③ 节点没有回结果行'
  beta_ok "${line%% *}：${line#* }"

  beta_say '④ 节点：主机公钥（经这条已认证的 ssh 读）'
  hostkey="$(remote "$node_ssh" "$node_tree" 'node-hostkey' </dev/null | grep -E '^HOSTKEY ' | head -n 1 || true)"
  [ -n "$hostkey" ] || beta_die '④ 读不到节点的 ed25519 主机公钥'

  beta_say '⑤ H：比对 ssh-keyscan 并登记中枢的 known_hosts'
  out="$(printf '%s\n' "$hostkey" | remote "$hub" "$hub_tree" "hub-known-host --node ${node}${dry_flag}")" \
    || beta_die '⑤ 失败：主机钥没有登记'
  line="$(printf '%s\n' "$out" | grep -E '^(REGISTERED|PRESENT|WOULD-ADD) ' | head -n 1 || true)"
  [ -n "$line" ] || beta_die '⑤ H 没有回结果行'
  beta_ok "${line%% *}：${line#* }"

  if [ "$dry" = '1' ]; then
    beta_say '⑥ 验证：dry-run 不跑（它要真的连一次节点）'
    beta_head 'dry-run 结束：上面每一步都只读，没有改任何机器'
    return 0
  fi
  beta_say '⑥ H：用中枢执行器的 ssh 参数发一次 status'
  out="$(remote "$hub" "$hub_tree" "hub-verify --node ${node}" </dev/null)" \
    || beta_die '⑥ 失败：中枢还够不着这个节点（原因见上面 H 的输出）'
  beta_ok "$(printf '%s\n' "$out" | grep -E '^VERIFY ' | head -n 1)"
  beta_head "${node} 已登记"
  beta_say '下一步 : 在 H 上重起控制台，让它带上这个节点的 ssh 执行器（beta-up.sh 起控制台时才看专用 key 在不在）'
  beta_say '           systemctl --user restart qianmo-console.service'
  beta_say '         （没有 systemd --user 的宿主：beta-down.sh console，再带上原来的尾参跑 beta-up.sh --role host）'
}

sub="${1:-}"
[ "$#" -eq 0 ] || shift
case "$sub" in
  enroll) cmd_enroll "$@" ;;
  hub-key) cmd_hub_key "$@" ;;
  hub-coordinate) cmd_hub_coordinate "$@" ;;
  authorized-key) cmd_authorized_key "$@" ;;
  node-install) cmd_node_install "$@" ;;
  node-hostkey) cmd_node_hostkey "$@" ;;
  hub-known-host) cmd_hub_known_host "$@" ;;
  hub-verify) cmd_hub_verify "$@" ;;
  -h | --help | '') sed -n '5,30p' "$SELF" | sed 's/^# \{0,1\}//'; [ -n "$sub" ] || exit 2 ;;
  *) usage_die "不认识的子命令：${sub}" ;;
esac
