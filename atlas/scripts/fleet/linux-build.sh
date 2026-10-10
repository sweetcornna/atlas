#!/usr/bin/env bash
# Copyright 2026 Qianmo AgentNest Team
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# 阡陌舰队产物的 Linux 构建配方（可重跑）。
#
# 产物：payload.tgz = dist/qm-linux-<arch>（qm 与 oh-my-pi CLI 编成一个自包含二进制，
# 内嵌 omp 原生插件）+ dist/demo/*.js + demo/。舰队节点不带 node_modules，也不带
# Rust 工具链，所以载荷里不能依赖它们。
#
# 为什么在 Linux 容器里出：二进制嵌的是构建机本机的原生插件（`bun run build:native`
# 出的 pi_natives.linux-<arch>.node），在 macOS 上编不出 Linux 的插件；容器里的
# 构建机就是目标平台本身，不涉及交叉编译。
#
# 做法：本机 `git bundle` 取源（仓库只读，不 checkout、不改工作区）→ colima 里的
# debian 容器 → 非 root 用户从 bundle 真 clone（带真 .git，天然没有 macOS 扩展属性）→
# 钉 .tool-versions 的 bun、按 rust-toolchain.toml 装 Rust nightly → bun install
# --frozen-lockfile → bun run build:native → atlas/scripts/build-qm.ts →
# check-qm-smoke.ts → 独立复核（qm --version 的源提交等于 HEAD、载荷自包含）→ payload.tgz。
#
# 用法：
#   linux-build.sh [--branch <分支>] [--commit <40位sha，缺省=分支头>] [--platform linux/amd64]
#                  [--repo <仓库路径，缺省=本脚本所在检出>] [--out <目录，缺省在 ~/.atlas-fleet-build/out/ 下>]
# 退出码：0 = 全部判据通过；非 0 = 第一个失败的判据（见 out/verdict.txt）。
#
# Linux 构建机（含 GitHub runner，见 .github/workflows/fleet-payload.yml）不用 colima：
# 设 DOCKER_CONTEXT_NAME=default，本机 docker 通就直接用。
# 判据个数（verdict.txt 里 PASS 行数）= 14；增删判据时 fleet-payload.yml 里的数要同步改。
set -euo pipefail

BRANCH=""
EXPECT=""
PLATFORM=linux/amd64
REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
OUT=""
# 专用 colima profile：default profile 的 docker 数据盘可能被别的项目占满，不去清别人的镜像。
# 首次需要：colima start atlas-build --cpu 4 --memory 8 --disk 60 --vm-type vz --mount-type virtiofs
COLIMA_PROFILE="${COLIMA_PROFILE:-atlas-build}"
DOCKER_CONTEXT="${DOCKER_CONTEXT_NAME:-colima-$COLIMA_PROFILE}"
# node:20-slim（Debian bookworm）：apt 走 deb.debian.org。
IMAGE="${BUILD_IMAGE:-node:20-slim}"

while [ $# -gt 0 ]; do
  case "$1" in
    --branch) BRANCH="$2"; shift 2;;
    --expect|--commit) EXPECT="$2"; shift 2;;
    --platform) PLATFORM="$2"; shift 2;;
    --repo) REPO="$2"; shift 2;;
    --out) OUT="$2"; shift 2;;
    *) echo "unknown arg: $1" >&2; exit 2;;
  esac
done

[ -n "$BRANCH" ] || BRANCH="$(git -C "$REPO" symbolic-ref --short HEAD)"
BRANCH_HEAD="$(git -C "$REPO" rev-parse --verify "refs/heads/$BRANCH^{commit}")"
# 分支可能正被别的会话推进：构建钉在一个确定的提交上（缺省取此刻的分支头）
HEAD_SHA="${EXPECT:-$BRANCH_HEAD}"
HEAD_SHA="$(git -C "$REPO" rev-parse --verify "$HEAD_SHA^{commit}")"
git -C "$REPO" merge-base --is-ancestor "$HEAD_SHA" "$BRANCH_HEAD" \
  || { echo "$HEAD_SHA is not on $BRANCH (head $BRANCH_HEAD)" >&2; exit 3; }
# 缺省产出不放仓库里：12+ MB 的 payload.tgz 会以未跟踪文件留在工作区。
[ -n "$OUT" ] || OUT="$HOME/.atlas-fleet-build/out/${HEAD_SHA:0:8}-${PLATFORM//\//-}"
# colima 只把 $HOME 共享进 VM：容器的输入/输出必须落在家目录下，结束后再拷到 OUT。
WORK="$HOME/.atlas-fleet-build/${HEAD_SHA:0:8}-${PLATFORM//\//-}"
FINAL_OUT="$OUT"
OUT="$WORK"
rm -rf "$OUT" "$FINAL_OUT"; mkdir -p "$OUT/in" "$FINAL_OUT"

# ── 0. 构建机在不在（colima start 会顺手把 docker 默认 context 切过去，要切回来）──────
# 判活用 docker info 而不是 `colima status`：后者会经 limactl shell 跑 docker ps，实测会卡住。
if ! docker --context "$DOCKER_CONTEXT" info >/dev/null 2>&1; then
  command -v colima >/dev/null 2>&1 \
    || { echo "docker context $DOCKER_CONTEXT unreachable, and no colima here to start (Linux: DOCKER_CONTEXT_NAME=default)" >&2; exit 4; }
  PREV_CTX="$(docker context show 2>/dev/null || echo default)"
  colima start "$COLIMA_PROFILE" >/dev/null 2>&1 || { echo "colima profile $COLIMA_PROFILE failed to start" >&2; exit 4; }
  docker context use "$PREV_CTX" >/dev/null 2>&1 || true
fi

# ── 1. 取源：bundle 只读仓库对象，不动工作区与 HEAD ─────────────────────────
# 快照标签一并进 bundle：license-headers 的判据要它（容器里的 clone 取标签，下面 stage2）。
SNAPSHOT_TAG=base-snapshot/omp-v18.8.4
git -C "$REPO" bundle create "$OUT/in/atlas.bundle" "$BRANCH" "refs/tags/$SNAPSHOT_TAG" 2> "$OUT/bundle.log"
git -C "$REPO" bundle verify "$OUT/in/atlas.bundle" >> "$OUT/bundle.log" 2>&1
echo "bundle=$(du -h "$OUT/in/atlas.bundle" | cut -f1) commit=$HEAD_SHA branch=$BRANCH branch_head=$BRANCH_HEAD platform=$PLATFORM" | tee "$OUT/source.txt"

# ── 2. 容器内脚本 ────────────────────────────────────────────────────────────
cat > "$OUT/in/stage1-root.sh" <<'EOS'
set -uo pipefail
export DEBIAN_FRONTEND=noninteractive
# 本机出网经代理，偶发连不上：apt 带重试，整体再试三轮
apt_ok=0
for i in 1 2 3; do
  if apt-get -o Acquire::Retries=5 update -qq >> /out/apt.log 2>&1 && \
     apt-get -o Acquire::Retries=5 install -y -qq --no-install-recommends \
       curl unzip git ca-certificates xz-utils build-essential cmake ninja-build pkg-config python3 >> /out/apt.log 2>&1; then
    apt_ok=1; break
  fi
  sleep 5
done
[ "$apt_ok" = 1 ] || { echo "APT_RC=failed" >> /out/rc.txt; exit 10; }
id builder >/dev/null 2>&1 || useradd -m -u 1001 builder
mkdir -p /home/builder/.bun/install/cache /home/builder/out
chown -R builder:builder /home/builder
install -o builder -g builder -m 0644 /in/atlas.bundle /home/builder/atlas.bundle
# builder 只写自己的家目录；root 最后整体拷回 /out（绑定挂载的属主不归容器管）
su builder -c "BRANCH='${BRANCH}' COMMIT='${COMMIT}' bash /in/stage2-builder.sh"
echo "STAGE2_EXIT=$?" >> /home/builder/out/rc.txt
cp -a /home/builder/out/. /out/
EOS

cat > "$OUT/in/stage2-builder.sh" <<'EOS'
set -uo pipefail
OUT=$HOME/out; W=$HOME/atlas
rc() { echo "$1=$2" >> $OUT/rc.txt; }
rm -rf "$W"
git clone -q --branch "$BRANCH" "$HOME/atlas.bundle" "$W" || { rc CLONE_RC failed; exit 20; }
cd "$W"
git fetch -q "$HOME/atlas.bundle" "refs/tags/base-snapshot/omp-v18.8.4:refs/tags/base-snapshot/omp-v18.8.4" || { rc FETCH_TAG_RC failed; exit 23; }
git checkout -q --detach "$COMMIT" || { rc CHECKOUT_RC failed; exit 22; }
HEAD=$(git rev-parse HEAD)
PINNED=$(tr -d '\r' < .tool-versions | awk '/^bun /{print $2}')
curl -fsSL https://bun.sh/install | bash -s "bun-v$PINNED" > $OUT/bun-install.log 2>&1 || { rc BUN_INSTALL_RC failed; exit 21; }
export PATH=$HOME/.bun/bin:$HOME/.cargo/bin:$PATH
CHANNEL=$(sed -n 's/^channel *= *"\(.*\)"/\1/p' rust-toolchain.toml)
curl -fsSL https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain "$CHANNEL" > $OUT/rustup.log 2>&1 || { rc RUSTUP_RC failed; exit 24; }
{
  echo "head=$HEAD"
  echo "pinned_bun=$PINNED actual_bun=$(bun --version)"
  echo "rust=$CHANNEL $(rustc --version 2>&1)"
  echo "arch=$(uname -m) uid=$(id -u) user=$(id -un)"
  echo "toplevel=$(git rev-parse --show-toplevel)"
  echo "appledouble_files=$(find . -name '._*' -not -path './.git/*' | wc -l)"
  echo "clean_before_install=$(git status --porcelain | wc -l)"
} > $OUT/env.txt
bun install --frozen-lockfile > $OUT/install.log 2>&1; rc INSTALL_RC $?
if [ "$(uname -m)" = x86_64 ]; then
  # build-qm embeds only the portable baseline addon on x64 (the loader falls back to it on
  # AVX2 hosts). omp's local napi build names its output after the build host's AVX2, so a
  # modern runner would emit only -modern. Pin the baseline ISA floor build-bindings uses for
  # baseline (x86-64-v2) and give the addon its baseline name.
  RUSTFLAGS='-C target-cpu=x86-64-v2' bun run build:native > $OUT/build-native.log 2>&1; rc NATIVE_RC $?
  N=packages/natives/native
  if [ ! -e $N/pi_natives.linux-x64-baseline.node ] && [ -e $N/pi_natives.linux-x64-modern.node ]; then
    mv $N/pi_natives.linux-x64-modern.node $N/pi_natives.linux-x64-baseline.node
    echo "renamed x86-64-v2 build: pi_natives.linux-x64-modern.node -> pi_natives.linux-x64-baseline.node" >> $OUT/build-native.log
  fi
else
  bun run build:native > $OUT/build-native.log 2>&1; rc NATIVE_RC $?
fi
git status --porcelain > $OUT/porcelain-before-build.txt
bun atlas/scripts/build-qm.ts > $OUT/build-qm.log 2>&1; rc BUILD_RC $?
BIN=$(ls dist/qm-linux-* 2>/dev/null | head -n1)
echo "binary=$BIN" >> $OUT/env.txt
bun atlas/scripts/check-qm-smoke.ts "$BIN" > $OUT/qm-smoke.log 2>&1; rc SMOKE_RC $?
# 独立复核（不只信冒烟脚本）：源提交、载荷自包含
bun -e "import {DEMO_ENTRYPOINTS as e} from './atlas/scripts/demoBundles.ts'; console.log(e.length)" > $OUT/expected-demo-bundles.txt 2>> $OUT/build-qm.log
ls dist/demo/*.js 2>/dev/null | wc -l > $OUT/demo-bundle-count.txt
head -c 4 "$BIN" | od -An -c | tr -d ' ' > $OUT/binary-magic.txt
tar -czf $OUT/payload.tgz "$BIN" dist/demo demo; rc TAR_RC $?
tar -tzf $OUT/payload.tgz | grep -c node_modules > $OUT/payload-node-modules-count.txt
# 载荷自包含：只解出载荷到空目录，用空环境跑二进制，不能借仓库里的 node_modules 与源码。
rm -rf /tmp/payload-run && mkdir -p /tmp/payload-run/home /tmp/payload-run/cfg
tar -xzf $OUT/payload.tgz -C /tmp/payload-run
( cd /tmp/payload-run && env -i PATH=/usr/bin:/bin HOME=/tmp/payload-run/home QIANMO_CONFIG_DIR=/tmp/payload-run/cfg "./$BIN" --version > $OUT/payload-version.log 2>&1; echo "exit=$?" >> $OUT/payload-version.log )
( cd dist && find . -type f -print0 | sort -z | xargs -0 sha256sum ) > $OUT/dist-sha256.txt
EOS

# ── 3. 跑容器 ─────────────────────────────────────────────────────────────────
: > "$OUT/rc.txt"
START=$(date +%s)
set +e
docker --context "$DOCKER_CONTEXT" run --rm --platform "$PLATFORM" --dns "${BUILD_DNS:-1.1.1.1}" -e BRANCH="$BRANCH" -e COMMIT="$HEAD_SHA" \
  -v "$OUT/in:/in:ro" -v "$OUT:/out" \
  -v "atlas-fleet-bun-cache-${PLATFORM//\//-}:/home/builder/.bun/install/cache" \
  "$IMAGE" bash /in/stage1-root.sh > "$OUT/docker.log" 2>&1
DOCKER_RC=$?
set -e
echo "DOCKER_RC=$DOCKER_RC" >> "$OUT/rc.txt"
echo "elapsed_s=$(( $(date +%s) - START ))" >> "$OUT/source.txt"

# ── 4. 判定（全部判据写进 verdict.txt）────────────────────────────────────────
V="$OUT/verdict.txt"; : > "$V"; FAIL=0
check() { if eval "$2"; then echo "PASS $1" >> "$V"; else echo "FAIL $1" >> "$V"; FAIL=1; fi; }
for k in DOCKER_RC INSTALL_RC NATIVE_RC BUILD_RC SMOKE_RC TAR_RC; do
  check "$k=0" "grep -qx '$k=0' '$OUT/rc.txt'"
done
check "env: uid!=0" "grep -q 'uid=1001' '$OUT/env.txt'"
check "env: bun pinned" "awk -F'[ =]' '/pinned_bun/{found=1; matches=(\$2==\$4)} END {exit !(found && matches)}' '$OUT/env.txt'"
check "env: appledouble=0" "grep -qx 'appledouble_files=0' '$OUT/env.txt'"
check "binary: is an ELF executable" "grep -q 'ELF' '$OUT/binary-magic.txt'"
check "qm --version names $HEAD_SHA (no -dirty)" "grep -q ' $HEAD_SHA\$' '$OUT/payload-version.log'"
check "payload: self-contained (empty env, exit 0)" "grep -qx 'exit=0' '$OUT/payload-version.log'"
check "payload: demo bundles complete" "[ -s '$OUT/expected-demo-bundles.txt' ] && [ \"\$(cat '$OUT/expected-demo-bundles.txt')\" = \"\$(tr -d ' ' < '$OUT/demo-bundle-count.txt')\" ]"
check "payload: no node_modules" "[ -f '$OUT/payload-node-modules-count.txt' ] && [ \"\$(cat '$OUT/payload-node-modules-count.txt')\" = 0 ]"
if [ -f "$OUT/payload.tgz" ]; then
  echo "payload=$OUT/payload.tgz size=$(du -h "$OUT/payload.tgz" | cut -f1) sha256=$(shasum -a 256 "$OUT/payload.tgz" 2>/dev/null | cut -d' ' -f1 || sha256sum "$OUT/payload.tgz" | cut -d' ' -f1)" >> "$V"
fi
# 结果搬回 OUT（bundle 不搬：它是源，按需重建）
find "$OUT" -maxdepth 1 -type f -exec cp -p {} "$FINAL_OUT/" \;
mkdir -p "$FINAL_OUT/in" && cp -p "$OUT/in/"*.sh "$FINAL_OUT/in/"
# 带后缀的 -i.bak 在 BSD 与 GNU sed 上同义；`sed -i ''` 是 BSD 专用。
sed -i.bak "s|$OUT|$FINAL_OUT|g" "$FINAL_OUT/verdict.txt" && rm -f "$FINAL_OUT/verdict.txt.bak"
cat "$FINAL_OUT/verdict.txt"
exit $FAIL
