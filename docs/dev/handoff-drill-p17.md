<!-- Copyright 2026 Qianmo AgentNest Team -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# P17 接力验收与关机演练

2026-10-08 源码盘点：P17.3–P17.6 的 Atlas 实现位于 `atlas/packages/handoff`、`atlas/packages/node/src/commands/handoff*.ts`、`demo/env/beta/handoff-node.sh`。当前已迁到 omp 基座，但接力工具 `qmcode` 仍是独立 Codex fork，不把 omp 的会话当成 qmcode rollout。

## 已完成的本地证据

| 层次 | 入口 / 判据 | 能证明什么 |
| --- | --- | --- |
| 纯逻辑 + 真 git | `atlas/packages/handoff/test` | 影子提交、index/HEAD/stash 不变、秘密扫描、台账重放 |
| 多进程本机链 | `atlas/tests/integration/qianmo-handoff*.test.ts` | sync/now 的持久化确认、hub/node/return、pull 分支保护、补投、MCP；node/app-server 或 SSH 的替身按各文件说明 |
| qmcode 内置入口 + 真 qm | 独立 app-server、builtin MCP / notify / shellCommand 接线探针 | MCP 真握手 ready、notify 真 git 同步、`qm handoff now` 被真实 hub 接受；仅本机进程 |
| 真实 qmcode TUI | `qianmo-handoff-attach-qmcode.test.ts` opt-in | 独立真实 app-server 与远程 TUI、rollout 的 approval/sandbox/cwd、输入与退出；模型是回环 Responses double，SSH 是本机 TCP 隧道 shim |

2026-10-08 最后一项实际 **2 pass / 0 fail、36 断言**：更严格和更宽松的笔记本配置均保留节点的 `never` / `workspace-write`。测试预载原先会清除 `QIANMO_TEST_QMCODE_BIN` 造成两项静默 skip；现已仅保留两项显式测试二进制变量，并增加预载正/负控制。复跑：

```sh
QIANMO_TEST_QMCODE_BIN=/absolute/path/qmcode \
  bun test --preload ./atlas/tests/preload.ts \
  ./atlas/tests/integration/qianmo-handoff-attach-qmcode.test.ts
```

第一次使用旧 P17.1 本机 fork build `ce1e097e9f`；随后找到已归档 P17.3 工作树的现成 debug `qmcode`，工作树 HEAD 为 `34e0d210ed` 且无源码 diff。将二进制以 CoW 复制到独立证据目录（未移动或修改归档树），配同基座未改过的 `codex-code-mode-host` 后重跑，仍为 **2 pass / 0 fail、36 断言**。二进制 SHA256 与来源写入 `qmcode-p173-cached/`，这是**缓存构建验证**，不是本轮重新编译或正式发行构建认证。

使用该缓存程序还跑了可重复入口 `atlas/scripts/qmcode-entry-probe.py`：本机真实 `qmcode app-server` 加当前源码 `qm console`，回环模型只返回固定消息。`qm` 包装器仅记录 argv 后执行真实 CLI，不提供假 MCP 回答、假同步或假任务。结果为：builtin qianmo MCP `ready`；notify 调用 `qm handoff sync --hook qmcode`，审计同步记录 `ok:true` 并真写中枢 git refs；app-server 的 `thread/shellCommand` 执行与 `/handoff` 相同的 `qm handoff now` 路径，真实中枢登记一个 `accepted` 任务。该任务未派往云节点，不能视为云端完成；探针未模拟在 TUI 键入 `/handoff`，也不补全 `/pull` 的字面入口验收。进一步独立核对 manifest 对应的 WIP/session refs、tree SHA，并确认原 HEAD/index 未改。结果在 `p173-verified-probe.log` 与其输出目录的 `summary.json`。

```sh
python3 atlas/scripts/qmcode-entry-probe.py /absolute/path/qmcode /absolute/evidence/dir
```

该入口需要 macOS `sandbox-exec`、Python 3 和 PATH 上的 Bun；通过闭合环境与临时 HOME/QMCODE_HOME 执行，不读取真实工具账号目录。

独立仓库本地缓存 `origin/qianmo/main = 34e0d210ed` 含 P17.3，`qianmo/main = 90e00225c6` 滞后一版；当前 checkout 是纯上游 detached `064c6b8c73`，预存 `codex-rs/Cargo.lock` 修改已保留。本次不切换该 checkout、不覆写其锁文件、不推送分支。已读取并下载既有 Linux CI run `37144581140` 的 artifact `11282942048`（fork `34e0d210ed7936822d08dd00e216dc2b9434472d`），zip SHA256 `4d323913ea6d96fe14fd7e1266d04f8ab74029c530e359df8ff82d3f8d550617` 与产物内四文件校验和全部一致。Linux x86_64 的 qmcode SHA256 `e7747260ca1d09aac4248ff93d404d0eb054cca359d93db0e19c30313a0be2a6`，code-mode helper SHA256 `d5047fcf3b5a492365af03e65bf57929efe2d53b99632dce09ccc5fadaca6b38`；两者已并列进入私有候选审核包。只在本地 Colima/qemu x64 下验证 `qmcode --version` 与 helper `--help` 的零退出，未宣称真机原生、工具任务或跨机接力通过，未重新触发远端构建。

本次随后启动了已有本地 Colima Linux VM，未挂载宿主文件夹，使用一次性容器完成 Linux arm64 编译、真实 compiled 回归与生产 bwrap/oracle 测试。bwrap 正控需要特权外层容器及仅本地 VM 的明确 AppArmor userns profile；普通外层容器负控仍拒绝，不能外推远端可用。另已只读盘点三台现有 x86_64 普通 UID 节点，PATH 均无 bwrap；没有写入、安装或启动远端服务。这些本地 Linux 证据不证明跨机 P17：qmcode Linux 产物已准备并固定hash，真机原生执行、真实云端继续执行、原机离线30分钟及两种入口各双轮仍须按审核后的现场执行包验证。见 [现场执行包](field-acceptance-omp.md)。

## P17.7 现场步骤（待审核环境执行）

本轮没有改生产机器，也没有执行现场关机演练。以下是完整执行清单，不是已通过声明。按 `handoff-usage.md` 配好隔离 HOME、专用 SSH/git 闸门、节点 bwrap、模型凭据和 app-server token 后执行。

1. 固定同一部署的 `qm --version`、`qmcode --version`、二进制 SHA256、fork SHA、节点/客户端的主机 ID、git HEAD、原始 index 字节 SHA256、stash 清单。节点、发起客户端和观察设备记录必须能区分，保存 UTC 时间及命令退出码。
2. qmcode 与 Claude Code **各做两轮**。每轮任务写下只在历史会话中出现、简报不重复的约束，再制造已跟踪未提交、未跟踪、忽略及秘密排除样本。先保存 HEAD/index/stash/工作区基线。
3. 由真实入口发起：qmcode 的 `/handoff` 或 MCP `qianmo_handoff`；Claude Code 的已登记 `qm handoff mcp` 工具。保存 `now` 回执及 taskId，并独立查中枢两个 ref 的 SHA/树。未获得 `accepted` 与 ref 一致证据时禁止记录「可以关机」。
4. 断开发起端网络/关机 **至少 30 分钟**；由另一台设备或节点侧记录继续执行与完成时间。不能用测试 sleep、改系统钟或本机隧道代替跨机离线。保存节点空白工作仓的历史约束命中、真实工具调用、任务产物测试和会话 ref。
5. 从**另一设备**执行 `qm handoff attach <taskId> --ssh <node>`，追加一个可验证小指令。保存 TUI/rollout 证明接入同一 thread，记录节点 cwd、approval/sandbox、token 不在 argv 及隧道退出后关闭；不要把 token 写进演练日志。
6. 发起端上线后执行 `qm handoff pull`。一轮保持本地未变，应快进；另一轮先加本地改动，应保留原分支并创建 `qianmo/<task>`。两轮都核对不覆盖本地工作区/index/stash、节点和中枢仅有允许的 qianmo refs。
7. 分别对离线中断、秘密命中、未完成回合、缺 bwrap、错误 token、重复交接/结果重投做失败控制。记录明确失败与审计关联；不能以退出码 0 单独判通过。

## 现场交付目录

每轮保存 `manifest.json`（工具入口、部署版本、主机 ID、UTC、task/thread/ref/commit IDs）、`commands.log`、已脱敏会话片段、git 前后状态、产物测试报告、审计链片段、30 分钟离线证据和 attach/pull 证据；禁止存真实 key/token 原文。最终表必须逐条列 AC-H1~H5、U1~U4，分成通过/失败/未执行，附具体文件和行。缺任何一轮、入口、跨机或离线时长证据，P17.7 保持未验收。

本轮证据根：`/Users/cornna/atlas-evidence/m1-work/m1-completion/Gates/`；`p17-real-attach.log` 是本机协议验证，不能代替上述目录。

## 固定 fork 的 Linux 构建复现

仓库为 `sweetcornna/qianmo-codex`，固定提交 `34e0d210ed7936822d08dd00e216dc2b9434472d`。在新的同架构 Linux checkout 执行 `qianmo/build-linux.sh <新的输出目录>`，脚本用 Rust `1.95.0`、`cargo build --release --locked --bin qmcode --bin codex-code-mode-host`。依赖为 git/rustup/sha256sum/objcopy/curl/python3、C/C++构建工具链、pkg-config、libssl-dev，以及脚本按 SHA256 校验的 rusty-v8 archive/bindings。x86_64与aarch64按本机架构构建；不把Mac交叉产物当Linux原生验证。

此次优先复用精确同提交的既有成功CI产物（含buildinfo、build.log与debug sidecars），无需重跑大规模编译或改动原checkout的未提交Cargo.lock。本地能做的下载、官方archive digest、内部checksum、ELF架构与隔离emulated入口检查已完成；现场机器上的实际tool round trip与P17双轮仍需要审核后的执行权限和真实时间。
