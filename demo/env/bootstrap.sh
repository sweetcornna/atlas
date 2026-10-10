#!/usr/bin/env bash
# Copyright 2026 Qianmo AgentNest Team
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# 阡陌 P8.1 —— 全新机器从零到「能跑演示」的第一步。
#
#   demo/env/bootstrap.sh
#
# 做四件事，每件打耗时，最后给总耗时（P8.1 的 DoD 是 30 min 内复现完整演示环境，
# 这个数字就是用来对着看的）：
#   ① 前置检查：bun（≥ 1.4 硬下限，版本再对着 .tool-versions 核）、git、node，可选 docker；
#   ② `bun install --frozen-lockfile`；
#   ③ `bun run build:native` —— 构建 omp 原生插件 `pi_natives.<平台>.node`（cargo，nightly
#      见 rust-toolchain.toml）。常驻节点是 `qm resident`（源码直跑
#      `bun atlas/packages/node/src/cli.ts`），节点智能体是 omp，缺原生插件 omp 起不来。
#      已经放好预编译插件（npm 预编译叶包，或从别处拷来的 `.node`）的机器加 `--skip-build`，
#      效果相同；
#   ④ 自检：跑 demo/lib 的报告核心用例（CI 里的同一个分片），证明依赖装对了。
#
# **幂等**：重复跑不会坏事，②③ 会因为缓存与产物已在而快很多。
# 它不碰 DEMO_ROOT，也不写任何配置根——那是 seed.sh 的事。

set -euo pipefail

# shellcheck source=demo/env/common.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

SKIP_BUILD=0
SKIP_SELFTEST=0
for option in "$@"; do
  case "$option" in
    --skip-build) SKIP_BUILD=1 ;;
    --skip-selftest) SKIP_SELFTEST=1 ;;
    -h|--help)
      demo_say '用法：bootstrap.sh [--skip-build] [--skip-selftest]'
      exit 0
      ;;
    *) demo_die "未知参数 $option" ;;
  esac
done

STARTED_AT="$(demo_now)"
cd "$REPO_DIR"

# ── ① 前置检查 ──────────────────────────────────────────────────────────────
STEP_AT="$(demo_now)"
demo_head '① 前置检查'

demo_require_bun
command -v git >/dev/null 2>&1 || demo_die 'git 不在 PATH 上'
# node 不是给 qm 用的，是 demo/lib/p61-worker.ts 真的会 spawn 它（AC-7 的 worker 子进程）。
# 所以它是 **④ 自检**的前置，不是 ②③ 的：`bun install` 与 `bun run build:native` 全程不碰 node。
#
# 这条区分不是理论上的。2026-08-25 实查：内测舰队四台节点机（beta-1..4）上**一台都没有
# node**——只有 `~/.bun/bin/bun`。而这里原先无条件 die，于是这条「装机 runbook」在真实
# 部署机上从第一步就跑不起来，历史上那几次上机只能绕开本脚本手工构建。绕开的代价
# 具体是：本脚本里那段源 commit 注入（issue #70）也一并被绕过，四台节点因此报
# `sourceCommit=unknown`。
#
# 缺 node 时**不自动跳过 ④**：静默降级会让「自检过了」与「自检压根没跑」在输出里长得
# 一样。要操作者显式写 `--skip-selftest`——跳过一道检查得是一个明确的动作。
if ! command -v node >/dev/null 2>&1; then
  if [ "$SKIP_SELFTEST" = '1' ]; then
    demo_warn 'node 不在 PATH 上 —— 已按 --skip-selftest 跳过 ④，②③ 不需要它'
  else
    demo_die 'node 不在 PATH 上。它只有 ④ 自检要用（demo/lib/p61-worker.ts 会 spawn 它）——
装不了 node 的机器（内测舰队四台节点机就是）请加 --skip-selftest，②③ 照跑。'
  fi
fi

BUN_PIN="$(awk '$1 == "bun" { print $2 }' "$REPO_DIR/.tool-versions")"
BUN_HAVE="$(bun --version)"
[ -n "$BUN_PIN" ] || demo_die '.tool-versions 里读不到 bun 版本'
if [ "$BUN_HAVE" = "$BUN_PIN" ]; then
  demo_ok "bun ${BUN_HAVE}（与 .tool-versions 一致）"
else
  # 不是硬拦：硬下限（≥ 1.4）上面 demo_require_bun 已经拦过，而 pin 是 lockfile 与 CI 的口径。
  # 但也不静默——用别的版本 `bun install` 可能把 lockfile 改写，那是一次谁都没打算做的提交。
  demo_warn "bun $BUN_HAVE ≠ .tool-versions 的 $BUN_PIN —— 允许继续，但 lockfile 若出现改动请勿提交"
fi
if command -v node >/dev/null 2>&1; then
  demo_ok "node $(node --version)"
fi
demo_ok "git $(git --version | awk '{print $3}')"
if command -v docker >/dev/null 2>&1; then
  demo_ok "docker $(docker --version 2>/dev/null | awk '{print $3}' | tr -d ,)（真机腿才用得上）"
else
  demo_say '提示 : 没有 docker —— 本地腿不需要它，真机腿（AC-6(a) / AC-2）需要'
fi
demo_say "耗时 : $(demo_elapsed "$STEP_AT")"

# ── ② 装依赖 ────────────────────────────────────────────────────────────────
STEP_AT="$(demo_now)"
demo_head '② bun install --frozen-lockfile'
# --frozen-lockfile 是刻意的：它会因为 lockfile 与 package.json 不一致而失败，
# 而那正是「换台机器就装出另一套依赖」这类问题唯一会被抓住的地方（roadmap P0.1 DoD）。
bun install --frozen-lockfile
demo_say "耗时 : $(demo_elapsed "$STEP_AT")"

# ── ③ 构建 omp 原生插件 ─────────────────────────────────────────────────────
STEP_AT="$(demo_now)"
demo_head '③ bun run build:native'

# 先说清这棵树声称自己是哪一版（issue #70）。判定、优先级与三种结局的措辞都在
# common.sh 的 demo_source_commit / demo_export_source_commit 里。qm 是源码直跑，源
# commit 在**运行时**才读，所以 up.sh 起节点前还会再走一遍同一个函数；这里先报，
# 是因为它正是操作者在一台新机器上最想先确认的事。
demo_export_source_commit

if [ "$SKIP_BUILD" = '1' ]; then
  demo_say '按 --skip-build 跳过（原生插件已就位：本机构建过，或用的是预编译件）'
else
  # 只构建原生插件，不跑根工作区的 build 脚本：演示环境源码直跑 qm，不需要任何打包产物；
  # 舰队用的单文件 `dist/qm-<平台>-<架构>` 由 atlas/scripts/build-qm.ts 另行编译。
  bun run build:native
fi
demo_require_qm
demo_ok "qm 入口就位：$DEMO_QM"
demo_say "耗时 : $(demo_elapsed "$STEP_AT")"

# ── ④ 自检 ──────────────────────────────────────────────────────────────────
STEP_AT="$(demo_now)"
demo_head '④ 自检：demo/lib 用例'
if [ "$SKIP_SELFTEST" = '1' ]; then
  demo_say '按 --skip-selftest 跳过'
else
  # 挑 demo/lib 是因为它就是 CI 分片列表里的一项（scripts/test-shards.sh），
  # 跑得快、且真的会 import 阡陌各包——依赖没链接好在这里就会红。
  bun test demo/lib
fi
demo_say "耗时 : $(demo_elapsed "$STEP_AT")"

demo_head "bootstrap 完成，总耗时 $(demo_elapsed "$STARTED_AT")"
demo_say '下一步：demo/env/seed.sh（种子数据） → demo/env/up.sh（起两个节点）'
