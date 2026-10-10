#!/usr/bin/env bash
# Copyright 2026 Qianmo AgentNest Team
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# 阡陌 P8.1 —— 演示环境公共层。**被 source，不单独执行。**
#
# 这里定死三件事，其余脚本一律从这里取，不各写一份：
#   ① 演示根目录 DEMO_ROOT 与它下面的目录布局；
#   ② 配置隔离——每个节点一个 QIANMO_CONFIG_DIR，全都在 DEMO_ROOT 里，
#      **绝不碰用户真实的 ~/.qianmo / ~/.omp / ~/.claude**；
#   ③ 端口、节点名、智能体名的默认值与环境变量覆盖口。
#
# ── 为什么每个节点要有自己的配置根（不是一个共用） ──────────────────────────
# 审计链是**按配置根**落一个文件的（`qianmoConfigPath('qianmo','audit','trail.ndjson')`，
# 见 atlas/packages/node/src/host/auditTrail.ts）。两个常驻进程共用一个配置根，就是两条哈希链
# 交替写进同一个文件，`qm audit --verify` 必然报断链——而那时候你会去查「谁改了审计
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

# demo/lib 的入口解析（`demo_entry`）。实现与理由都在 demo/lib/entry.sh —— 投出去的树
# 上没有 node_modules，源文件里的 @qianmo/* 解析不出来。
#
# 缺文件时不在这里死：source 阶段 `set -e` 掉的症状是「脚本什么都没输出就退了」，
# 与被测函数真的没输出无法区分。把失败推迟到真去解析入口的那一刻（同 beta/common.sh）。
if [ -f "$REPO_DIR/demo/lib/entry.sh" ]; then
  # shellcheck source=demo/lib/entry.sh
  . "$REPO_DIR/demo/lib/entry.sh"
else
  demo_entry() {
    demo_die "要解析 demo 入口 ${1}，但这棵树里没有 ${REPO_DIR}/demo/lib/entry.sh。"
  }
fi

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
    "$HOME"/.occ|"$HOME"/.occ/*|"$HOME"/.qianmo|"$HOME"/.qianmo/*|"$HOME"/.omp|"$HOME"/.omp/*|"$HOME"/.claude|"$HOME"/.claude/*)
      demo_die "DEMO_ROOT 落在真实配置根里：$root"
      ;;
  esac
  # 用户若用 QIANMO_CONFIG_DIR / CLAUDE_CONFIG_DIR 把真实配置根挪到了别处，上面那几个
  # 字面量就拦不住——这里按调用方进入本脚本时的环境再拦一次（演示自己的按节点
  # QIANMO_CONFIG_DIR 是之后由 demo_node_env 设的，不会走到这里）。
  local outer
  for outer in "${QIANMO_CONFIG_DIR:-}" "${CLAUDE_CONFIG_DIR:-}"; do
    [ -n "$outer" ] || continue
    case "$root" in
      "$outer"|"$outer"/*) demo_die "DEMO_ROOT 落在当前环境的真实配置根里：${root}（${outer}）" ;;
    esac
  done
  return 0
}

# 标记文件在，才认这个目录是演示环境。
# 没有标记就拒绝——不去猜「这大概是我上次建的」，猜错一次就是删了别人的目录。
demo_require_marker() {
  demo_guard_root "$DEMO_ROOT"
  [ -f "$DEMO_MARKER" ] || demo_die "$DEMO_ROOT 不是演示环境（缺 ${DEMO_MARKER}）——先跑 demo/env/seed.sh"
  head -1 "$DEMO_MARKER" | grep -qF "$DEMO_MARKER_MAGIC" \
    || demo_die "$DEMO_MARKER 的首行不是 ${DEMO_MARKER_MAGIC}，拒绝操作"
  return 0
}

# ── 隔离环境 ─────────────────────────────────────────────────────────────────

# demo_export_common —— 所有子进程共用的环境。
# `QIANMO_CONFIG_DIR` 在这里**故意不设**：它按节点分（见文件头），由调用方用
# demo_node_env 逐个设。谁想跑一次性工具，自己挑一个节点的配置根。
demo_export_common() {
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

# ── 构建溯源：源 commit 怎么跟着代码上机（issue #70）───────────────────────────
#
# `qm --version`、常驻启动行与控制台 banner 都报源 commit
# （atlas/packages/node/src/provenance.ts）。源码直跑时它的来源依次是
# `QIANMO_SOURCE_COMMIT`、`git rev-parse HEAD`、`unknown`。而部署树上没有 git 可问：
# 送代码那一步要么是 `git archive`（只出跟踪文件），要么是 tar 排除表
# （docs/dev/demo-env.md §7.1 里 `.git` 就在排除项里，因为仓库根下还可能压着 `.claude`
# 与含凭据的配置根）。两条路的结果一样——机器上那棵树没有 `.git`，于是每台节点都报
# `unknown`，而那正是 issue #70 要消掉的洞。
#
# 补法是把这件事交回**源端**：打包时（demo/env/pack.sh）把 HEAD 写进树里的一个戳
# 文件，机器上起进程前读回来，经 `QIANMO_SOURCE_COMMIT` 交给 qm。戳跟着树走，
# 所以之后任何一次重起都还带得上，不靠操作者记得在命令行前面加一个变量。
DEMO_SOURCE_COMMIT_STAMP="$REPO_DIR/.source-commit"

# demo_tree_is_own_git_repo —— `$REPO_DIR` 自己是不是一个 git 仓库的顶层。
#
# 三条：
#   · `rev-parse` 会**向上**走，所以仅仅「问得到答案」不作数——家目录恰好是个 dotfiles
#     仓库时，它会自信地报出那个仓库的 HEAD，那比 `unknown` 更坏；顶层必须就是这棵树。
#   · 比较走 realpath：macOS 上 `/tmp` 是指向 `/private/tmp` 的软链，字符串比一定不等，
#     于是一棵真仓库会被判成「不是仓库」。
#   · HEAD 也得解析得出来：空仓库（还没有第一个提交）有顶层却没有 HEAD，qm 在那种树上
#     问 git 也问不出来，这边也必须退。
demo_tree_is_own_git_repo() {
  local toplevel
  toplevel="$(git -C "$REPO_DIR" rev-parse --show-toplevel 2>/dev/null || true)"
  [ -n "$toplevel" ] || return 1
  git -C "$REPO_DIR" rev-parse HEAD >/dev/null 2>&1 || return 1
  [ "$(cd "$toplevel" 2>/dev/null && pwd -P)" = "$(cd "$REPO_DIR" 2>/dev/null && pwd -P)" ]
}

# demo_source_commit —— 这棵树应当声明的源 commit；答不出就打印空串。
#
# 三条，按序：
#   ① `$REPO_DIR` 自己就是 git 顶层 → **空串**。不是「不知道」，是「不该由我们说」：
#      qm 会自己去问 git，那条比戳文件新、也比环境变量可信。环境变量是兜底，永远不是
#      覆盖，否则上一轮 shell 里残留的一个 export 就能给一棵真仓库改名。
#   ② 环境里已经有 `QIANMO_SOURCE_COMMIT` → 原样沿用。操作者显式给的排在戳文件之上。
#   ③ 戳文件存在且形状对 → 用它。
#
# 形状必须验：戳文件是从别的机器搬过来的普通文件，一个截断了半截的值会一路流进
# 启动行和验收报告，而它长得像个 commit，没人会怀疑。形状不对时打印空串并在 stderr 上
# 说一句——**不静默降级成 `unknown`**，那会让「戳坏了」和「压根没打包戳」看起来一样。
demo_source_commit() {
  if demo_tree_is_own_git_repo; then
    return 0
  fi
  if [ -n "${QIANMO_SOURCE_COMMIT:-}" ]; then
    printf '%s' "${QIANMO_SOURCE_COMMIT}"
    return 0
  fi
  [ -f "$DEMO_SOURCE_COMMIT_STAMP" ] || return 0
  local stamped
  stamped="$(head -n 1 "$DEMO_SOURCE_COMMIT_STAMP" 2>/dev/null | tr -d '[:space:]')"
  if [[ "$stamped" =~ ^[0-9a-f]{40}(-dirty)?$ ]]; then
    printf '%s' "${stamped}"
    return 0
  fi
  printf 'WARN : %s 里的值不是一个 commit（%s）—— 当作没有戳处理\n' \
    "${DEMO_SOURCE_COMMIT_STAMP}" "${stamped}" >&2
  return 0
}

# demo_export_source_commit —— 起 qm 之前把结论 export 出去，并把三种结局各说一句。
#
# 与判定分成两个函数，是因为**两件事的可测面不一样**：判定是纯函数（给树、给环境，
# 看它答什么），这一条是副作用（export 了没有、话说得对不对）。合成一个的话，想验
# 「git 树上不许设这个变量」就得连带把消息文案也钉进同一个断言里。
#
# git 树上这里会**主动 unset**：qm 源码直跑时 `QIANMO_SOURCE_COMMIT` 排在 git 之前，
# 一个从外层 shell 继承来的陈旧值会原样压过真 HEAD。只有 unset 才能让 ① 的纪律在 qm
# 那一侧也成立。
#
# 最后那一支是这里的重点：没有戳的机器上 qm 会报 `sourceCommit=unknown`，而
# `unknown` 一旦上了线，验收报告里那一行就再也答不出「刚才测的是哪一版」。它是
# WARN 而不是 die——代码本身没坏，拦下来只会让人绕开脚本手工起进程，那更糟。
demo_export_source_commit() {
  local resolved
  resolved="$(demo_source_commit)"
  if [ -n "$resolved" ]; then
    export QIANMO_SOURCE_COMMIT="$resolved"
    demo_ok "源 commit ${resolved}（经 QIANMO_SOURCE_COMMIT 交给 qm）"
    return 0
  fi
  if demo_tree_is_own_git_repo; then
    unset QIANMO_SOURCE_COMMIT
    demo_ok "源 commit $(git -C "$REPO_DIR" rev-parse HEAD)（本树就是仓库，由 git 直接解析）"
    return 0
  fi
  demo_warn "这棵树没有 .git，也没有 ${DEMO_SOURCE_COMMIT_STAMP} —— qm 会报 sourceCommit=unknown"
  demo_say '  送代码请用 demo/env/pack.sh 打包，它会把 HEAD 一起封进去'
}

# ── Bun 版本下限 ─────────────────────────────────────────────────────────────
#
# omp 基座要求 Bun ≥ 1.4（根 package.json 的 `packageManager: bun@>=1.4`，
# docs/dev/base-switch-omp.md §2）。低于它时 `bun install` 与 qm 本身都会在半路以与版本
# 无关的报错倒下，所以在最前面按版本号拦住、把原因说清楚。
DEMO_BUN_MIN='1.4.0'

# demo_version_at_least <实际> <下限> —— 点分数字版本比较，只比前三段；`-canary.1`、
# `+build` 之类的后缀不计。任一段不是数字就判不满足（宁可拦下，也不猜）。
demo_version_at_least() {
  local have="${1%%[-+]*}" want="${2%%[-+]*}" i h w
  local -a hv wv
  IFS=. read -r -a hv <<<"$have"
  IFS=. read -r -a wv <<<"$want"
  for i in 0 1 2; do
    h="${hv[$i]:-0}"
    w="${wv[$i]:-0}"
    [[ "$h" =~ ^[0-9]+$ && "$w" =~ ^[0-9]+$ ]] || return 1
    if [ "$((10#$h))" -gt "$((10#$w))" ]; then return 0; fi
    if [ "$((10#$h))" -lt "$((10#$w))" ]; then return 1; fi
  done
  return 0
}

# demo_require_bun —— bun 在 PATH 上，且版本不低于 DEMO_BUN_MIN。
demo_require_bun() {
  command -v bun >/dev/null 2>&1 || demo_die 'bun 不在 PATH 上。装法见 docs/dev/demo-env.md §2'
  local have
  have="$(bun --version 2>/dev/null || true)"
  demo_version_at_least "$have" "$DEMO_BUN_MIN" \
    || demo_die "bun ${have:-<无版本输出>} 太旧：omp 基座要求 Bun ≥ ${DEMO_BUN_MIN}（先 \`bun upgrade\`，或按 .tool-versions 装）"
}

# qm 的入口：源码直跑（`bun "$DEMO_QM" <命令> …`）。演示环境不编译单文件产物——
# 依赖由 bootstrap.sh 装好，omp 原生插件由它构建或取预编译件。
DEMO_QM="$REPO_DIR/atlas/packages/node/src/cli.ts"

# demo_require_qm —— qm 入口不在就明确报错，不去猜。
demo_require_qm() {
  [ -f "$DEMO_QM" ] || demo_die "缺 $DEMO_QM —— 这棵树不是阡陌检出，或没跑过 demo/env/bootstrap.sh"
}
