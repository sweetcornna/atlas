#!/usr/bin/env bash
# Copyright 2026 Qianmo AgentNest Team
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# 阡陌内测 · 模型服务的每轮真机验收（AC-P6，`providers-console-m1.md` §8.4，P18.13）。
#
#   provider-acceptance.sh round   --config <轮配置.json> --out <证据目录> [--label <名>]
#   provider-acceptance.sh compare <轮 A 目录> <轮 B 目录> [--min-gap-minutes N]
#
# 在**运维本机**跑（macOS bash 3.2 与 Linux bash 5 都行）。真正干活的是同目录的
# `provider-acceptance.ts`（控制台 HTTP 与判定）和部署树里的 `provider-acceptance-node.ts`
# （经 ssh 在中枢与节点上取 facts、扫金丝雀）。这一层只做三件开跑之前的事：
#
#   ① 找到 bun（PATH 或 ~/.bun/bin）；
#   ② `round` 的证据目录：不在仓库里、私有（0700）；里面有 `HOLD` 文件就不开始，退 42。
#      负责人随时 `touch <证据目录>/HOLD` 叫停：每一项开始之前 .ts 也会再查一次；
#   ③ exec 那个 .ts，参数原样透传。
#
# 退出码：0 零红（compare：两轮通过）；1 有红；2 用法或配置错（没有判定）；42 HOLD。
#
# 轮配置的形状、每一项的判据与证据目录的样子见 `provider-acceptance.ts` 头注与
# `docs/dev/beta-env.md` §13。配置里只有地址与路径，**没有任何密钥**：控制台凭据是
# 运维个人账号的 token，放在一个 0600 文件里，配置只写它的路径。

set -euo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${SELF_DIR}/../../../.." && pwd -P)"

die() {
  printf '%s\n' "$*" >&2
  exit 2
}

usage() {
  sed -n '7,8p' "${SELF_DIR}/provider-acceptance.sh" | sed 's/^# \{0,1\}//' >&2
  exit 2
}

[ "$#" -gt 0 ] || usage
case "$1" in
  round | compare) ;;
  -h | --help) usage ;;
  *) usage ;;
esac

bun_bin="$(command -v bun 2>/dev/null || true)"
if [ -z "$bun_bin" ] && [ -x "${HOME}/.bun/bin/bun" ]; then
  bun_bin="${HOME}/.bun/bin/bun"
fi
[ -n "$bun_bin" ] || die '找不到 bun（PATH 与 ~/.bun/bin 都没有）'

if [ "$1" = 'round' ]; then
  out=''
  prev=''
  for arg in "$@"; do
    if [ "$prev" = '--out' ]; then out="$arg"; fi
    prev="$arg"
  done
  [ -n "$out" ] || die 'round 要 --out <证据目录>'
  if [ -d "$out" ]; then
    out_real="$(cd "$out" && pwd -P)"
    case "${out_real}/" in
      "${REPO_DIR}/"*) die "证据目录不能在仓库里：${out_real}" ;;
    esac
    if [ -e "${out_real}/HOLD" ]; then
      printf 'HOLD：%s 在，不开始\n' "${out_real}/HOLD" >&2
      exit 42
    fi
  fi
fi

exec "$bun_bin" "${SELF_DIR}/provider-acceptance.ts" "$@"
