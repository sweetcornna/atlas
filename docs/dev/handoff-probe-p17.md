<!-- Copyright 2026 Qianmo AgentNest Team -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# 阡陌 AgentNest — P17.2 探针结论

| 项 | 内容 |
|---|---|
| 文档版本 | **v0.4**（2026-10-04）。v0.1 只有本机实测的第 1、6、7 项；v0.2（2026-10-03）补上节点 p4 实测的第 2–5 项和第 7 项的 Linux 补测，第 1 项改写为补上辅助程序后的重跑结果；v0.3 收第 2 项的 24 h 采样（2026-10-03 13:27:20 至 10-04 13:27:00 UTC），内存口径改引计划 v1.1 的裁定；v0.4（同日）回写第 5 项留下的两条，由 P17.6 用真 qmcode 在本机测得：界面与节点的审批 / 沙箱不一致时以节点线程为准，「要按两次回车」是输入框的粘贴突发判定（8 ms / 120 ms） |
| 上位 | [`handoff-p17-plan.md`](./handoff-p17-plan.md) §2 P17.2 卡；设计 [`handoff-m1.md`](./handoff-m1.md) v1.1 |
| 被测二进制 | `qmcode 0.158.0`。本机：fork 分支 `qianmo/p17.1-identity` 在 `348bd27f76` 时的 macOS aarch64 release 构建（`codex-rs/target/release/qmcode`，sha256 `4bec959f…ad4f7b`），旁边放同一源码本机编的 `codex-code-mode-host`（sha256 `81e79b19…08a5bd`）。节点：fork 提交 `90e00225c6` 的 Linux 产物 `qmcode-rust-v0.158.0-90e00225c6-x86_64`（fork 的 `qianmo-build-linux` workflow 构建，run `37123317219`），`qmcode` sha256 `f642651f…b10b81e`、`codex-code-mode-host` sha256 `d5047fcf…daca6b38`，都已剥离 |
| 模型网关 | `https://api.cornna.xyz/v1`，模型 `gpt-6-luna`，`wire_api = "responses"`。key 只经环境变量传入，配置里只写 `env_key = "OPENAI_API_KEY"`；到节点时经 ssh 的标准输入传过去，在远端子 shell 里 `read` 进环境变量，不进命令行参数、文件和日志 |
| 环境 | 本机 macOS（Darwin 27.0.0，aarch64）。节点 p4：KVM 虚拟机，Debian 13（trixie），内核 6.12.43，x86_64，2 核，内存 1973 MB（另有 5 GB swap）。p4 上同时跑着内测节点 beta-5，本次没有碰它的进程、目录和端口。p4 上没有 gVisor（`runsc`），**gVisor 未测** |
| 用量 | 真实模型调用：v0.1 第 1 项 3 个任务（共 13 次 `/v1/responses`），第 7 项 2 个任务（共 5 次）。v0.2：第 1 项 A′ 1 个任务 2 轮（5 次）；第 3 项本机造会话 1 轮；节点上 6 个回合（第 3 项 1、第 4 项 2、第 5 项 2、第 7 项 1），外加第 5 项界面附带的 1 个临时线程回合；第 4 项另用 `claude -p` 造了 1 个 Claude Code 会话。每项都是 1 次跑成，只有第 5 项跑了 2 次（第 1 次没有发出模型调用，见第 5 项）。第 6 项不调模型 |
| 原始证据 | 负责人本机 `~/atlas-evidence/m1-work/p172/`（v0.1）与其下 `node/`（v0.2），不入库。内容：命令、输出、时间戳、录制的请求体与响应流、从 p4 取回的输出与会话文件。索引在 `commands.txt` 与 `node/commands.txt`。key 计数：v0.1 全目录 33705 个文件命中 0（`keycheck-all.txt`）；`node/` 5830 个文件命中 0（`node/keycheck-all.txt`）；p4 上本次目录 238 个文件命中 0（`node/keycheck-remote-p4.txt`）。两个 app-server 的令牌在 `node/` 下也是 0 命中 |

## 结论一览

| # | 探什么 | 结论 | 要点 |
|---|---|---|---|
| 1 | 网关是否提供 Responses API | **通过**（辅助程序补上后） | 网关侧全部通过：多轮、工具调用、无状态回传 `encrypted_content`、effort 都正常，**不需要兼容层**。v0.1 的条件（产物缺 `codex-code-mode-host`，`code_mode_only` 下工具全部失败）已由 fork `90e00225c6` 解除：产物带上辅助程序后，内置目录、直连网关跑通带工具的两轮任务 |
| 2 | app-server 在节点常驻 | **有条件通过**（gVisor 未测） | p4 上经软链接起的 app-server 只听 `127.0.0.1`，无令牌、错令牌的升级都是 401；24 h 的 1442 次 `/readyz` 全部 200，同一进程没有重启过。p4 没有 bwrap，qmcode 只有 `danger-full-access` 能用，按计划卡退路处理；把 Debian 的 bwrap 0.12.0 解包到用户目录后，普通用户能建 user namespace，`read-only`、`workspace` 两档都按预期生效。内存：24 h 里 `VmRSS` 从 147.2 MB 到 149.5 MB，其中约 124 MB 是可执行文件映射进来的干净文件页；匿名内存从 22.5 MB 到 24.9 MB，起跑约 5 h 后不再增长。150 MB 上限按匿名内存判定（计划 v1.1 §0） |
| 3 | 会话跨机续接 | **通过** | 本机 rollout 原样放进 p4 全新 `QMCODE_HOME` 的 `sessions/YYYY/MM/DD/`，`thread/resume` 显式传 `cwd` 即找到；首条相关回答命中原会话算出的代号和工具读到的「甲」。续接前 `thread/turns/list` 就返回原回合（摘要视图），历史不为空 |
| 4 | Claude Code 会话导入 | **通过** | `externalAgentConfig/import` 返回 `successes[0].target`，续接后首条回答命中原会话里工具读到的事实。长会话：导入的历史超过自动压缩阈值时，第一个回合开头就先压缩（阈值调低到 20000 实测）；`gpt-6-luna` 默认阈值是 244800 token，一般的会话不会触发 |
| 5 | 远程直连 | **通过** | 本机 `ssh -L` + `qmcode resume --remote … --remote-auth-token-env …` 接上 p4 上的线程，界面显示完整历史；界面里的输入在 p4 上经 code mode 执行（`hostname` 返回 p4 的主机名），p4 本机的第二个连接收到这个回合的全部事件；第二个连接随后开的回合也显示在界面上。本次自动化驱动时界面要按两次回车才提交，见第 5 项 |
| 6 | fork 内置配置 | **有条件通过** | 上游已有「随二进制内置的默认配置层」：`codex-rs/config/defaults.toml` 编译进二进制，优先级最低。MCP 在首个线程启动时即被拉起，用户层 `enabled = false` 能关掉。条件：用户文件里**只写** `enabled = false` 会让 `qmcode mcp add/remove` 报错，文档必须给完整写法；`notify` 是数组，用户自设会整体顶掉内置值 |
| 7 | 回合结束后会话文件何时落盘完整 | **通过**（得出 P17.4 规则） | 本机 4 个回合全部是：`task_complete` 行落盘 → 0.6–2.1 ms 后收到 `turn/completed` → 再过 0.4–15.6 ms notify 回调进程起来；之后 15 s 内零写入。p4 补测 1 个回合，顺序相同（B − A 7.5 ms，C − B 10.0 ms）。代码不保证这个先后顺序，所以 P17.4 **按内容判完整**（找本回合的 `task_complete` 行），不用「大小与 mtime 稳定」的计时窗口 |

---

## 第 1 项：模型网关是否提供 OpenAI Responses API

### 做法

在 `QMCODE_HOME` 指向的临时目录写 `config.toml`（三个任务共用，B、C 另加一行目录覆盖，见下）：

```toml
model_provider = "qianmo"
model = "gpt-6-luna"
approval_policy = "never"
sandbox_mode = "workspace-write"
check_for_update_on_startup = false

[analytics]
enabled = false

[shell_environment_policy]
inherit = "core"

[model_providers.qianmo]
name = "qianmo"
base_url = "https://api.cornna.xyz/v1"
env_key = "OPENAI_API_KEY"
wire_api = "responses"
```

工作目录放 `notes.txt`（代号、发布号、负责人）和 `app.cfg`（含 `release = TBD`）。每个任务两轮：

```sh
qmcode exec --json --skip-git-repo-check -C <工作目录> -c 'model_reasoning_effort="<档位>"' \
  -o turn1-last.txt '在当前目录完成三件事：1. 用 shell 命令读取 notes.txt；2. 修改 app.cfg …；3. 改完后用命令显示 app.cfg 的内容确认。最后只用一句话回答：notes.txt 里的代号是什么。'
qmcode exec resume --json --skip-git-repo-check -c 'model_reasoning_effort="<档位>"' -o turn2-last.txt <thread_id> \
  '这一轮不要运行任何命令，也不要读任何文件，只凭本次会话前面的内容回答两个问题：notes.txt 里写的负责人叫什么？app.cfg 里 release 被你改成了什么？'
```

第二轮问的「负责人」只出现在第一轮工具读到的文件内容里，答对说明工具输出随历史回传给了网关。`exec resume` 是新进程，历史从 rollout JSONL 重建。

| 任务 | 路径 | effort（轮 1 / 轮 2） | 模型目录 |
|---|---|---|---|
| A | 直连网关 | `max` / `max` | 二进制内置（`gpt-6-luna` 为 `code_mode_only`） |
| B | 经本机录制反代到同一网关 | `low` / `max` | `model_catalog_json` 覆盖：内置条目原样，只把 `tool_mode` 改为 `direct` |
| C | 同 B | `max` / `max` | 同 B |
| A′（辅助程序补上后重跑） | 直连网关 | `max` / `max` | 二进制内置（同 A），无 `tool_mode` 覆盖 |

A′ 与 A 用同一个 qmcode（sha256 `4bec959f…ad4f7b`），只在它旁边放了本机编的 `codex-code-mode-host`（同一源码，`cargo build --release --locked --bin codex-code-mode-host`，sha256 `81e79b19…08a5bd`），配置、工作目录内容、两轮提示词都与 A 相同。

录制反代是一个只绑 `127.0.0.1` 的 Bun 小程序：把请求原样转给网关，记录请求体和 SSE 响应流，请求头只记名字，不记值，所以 `Authorization` 不落盘。反代进程本身不持有 key。

### 结果

| 任务 | 请求数 | HTTP | 工具 | 轮 1 回答 | 轮 2 回答 |
|---|---|---|---|---|---|
| A | 5 | 未录制；5 次都完成，`exec` 退出码 0 | 模型发起 3 次 `exec`（code mode 的自由格式工具），3 次都报 `failed to spawn code-mode host …/codex-code-mode-host: No such file or directory`；`app.cfg` 未改 | 「当前命令环境无法启动，未能读取 notes.txt」 | 「前文没有提供」（与轮 1 一致） |
| B | 4 | 全部 200，`response.completed` | `exec_command` 读文件、`sed` 改文件、`cat` 确认；`app.cfg` 改为 `release = 2.4.9` | 「青石-7731」 | 「林望舒；2.4.9」，未运行命令 |
| C | 4 | 全部 200，`response.completed` | 同 B | 「青石-7731」 | 「林望舒；2.4.9」，未运行命令 |
| A′ | 5（轮 1 4 次，轮 2 1 次） | 未录制；两轮 `exec` 退出码都是 0 | 模型发起 3 次 code mode 的 `exec`（脚本里调 `tools.exec_command`：`cat notes.txt`、`perl -pi` 改文件、`cat app.cfg`），3 次都返回 `Script completed` 和真实输出；`app.cfg` 改为 `release = 2.4.9` | 「青石-7731」 | 「林望舒；2.4.9」，未运行命令 |

A′ 结束后没有残留的 `codex-code-mode-host` 进程。

从 B、C 的录制看到的线上形态：

- 请求：`POST /v1/responses`，`stream: true`，`store: false`，**没有** `previous_response_id`，`include: ["reasoning.encrypted_content"]`，`parallel_tool_calls: false`。内置目录给 `gpt-6-luna` 开了 Responses Lite：`instructions` 为空，工具定义放在 `input` 里一个 `additional_tools` 项中，`reasoning.context = "all_turns"`。网关全部接受。
- effort：请求里的 `reasoning.effort` 与 `-c` 给的值一致，网关在 `response.completed` 里原样回显（`low` / `max`）。`low` 的 3 次请求 `reasoning_tokens` 都是 0，不产出 reasoning 项；`max` 每次 39–75 个 reasoning token，并产出带 `encrypted_content` 的 reasoning 项。所以 `-c` 覆盖被接受，也有可观察的效果。内置目录里这个模型支持 `low`、`medium`、`high`、`xhigh`、`max`，默认 `medium`；本次只测了 `low` 和 `max`。
- 无状态多轮：C 的第 2、3 次请求（同一回合内）和第 4 次请求（`exec resume` 新进程）把此前每个响应里的 reasoning 项原样放回 `input`。第 4 次请求带回 3 个 reasoning 项，`encrypted_content` 与当初的响应**逐字节一致**（1764 / 1676 / 1508 字节），网关回 200 并正常完成。
- A 没有录制线上请求体。从它的 rollout 看：工具虽然失败，`custom_tool_call` 与 `custom_tool_call_output`（错误文本）之后的请求都正常完成；5 次请求都产出了带 `encrypted_content` 的 reasoning 项。

### 结论：通过（辅助程序补上后）

- **网关：通过。** 多轮、工具调用、无状态回传 `encrypted_content`、effort 档位都已端到端跑通。计划 §6 第一条风险（网关不提供 Responses API）可以关闭，不需要另立兼容层工作包。
- **v0.1 的条件已解除。** 二进制内置目录（`codex-rs/models-manager/models.json`）里 `gpt-6-luna` 的 `tool_mode` 是 `code_mode_only`，同目录里的 gpt-6 / gpt-5.6 系列也都是。这种模式下工具调用由独立进程 `codex-code-mode-host` 执行，找不到它时不回退普通工具，直接失败（「Code mode will fail closed」，A 就是这样）。按主 agent 裁定，fork 提交 `90e00225c6` 让产物带上它：`qianmo/build-linux.sh` 与 workflow 编 `qmcode`、`codex-code-mode-host` 两个 bin，都剥离、都出 `.debug`，放进同一个产物目录；辅助程序不改名。补上后 A′ 在内置目录、直连网关下跑通了带工具的两轮任务，code mode 的真实执行输出随历史回传给网关，第二轮答对。不再需要 B、C 那样的 `tool_mode = "direct"` 目录覆盖。
- **查找逻辑**（读源码，`install-context/src/lib.rs` 的 `code_mode_host_program`）：先找包布局 `<包>/codex-resources/` 或 `$QMCODE_HOME/packages/standalone/releases/<版本>/codex-resources/`，再找 qmcode 可执行文件所在目录（`current_exe()` 的父目录）；没有环境变量或配置项能另指路径。Linux 上 `current_exe()` 读 `/proc/self/exe`，经软链接调用时找的是真实文件旁边（p4 上的两个 app-server 都经软链接 `bin/qmcode` 启动，辅助程序只在真实文件旁边；第 5 项里 code mode 的工具调用正常，停测试实例前进程表里的辅助程序子进程路径也是真实文件旁边那个）。部署要求：两个文件同一目录，一个版本一个目录。
- **构建上新发现的坑**：`codex-code-mode-host` 链接 V8，工作区开了 `v8_enable_sandbox`，v8 的构建脚本默认去 denoland 下 `ptrcomp_sandbox` 变体的预编译库，那边没有这个变体（404），直接 `cargo build --bin codex-code-mode-host` 会失败。fork 新增 `qianmo/fetch-rusty-v8.sh`，照上游 `.github/actions/setup-rusty-v8` 从上游 `openai/codex` 的 `rusty-v8-v150.4.0` 发行取预编译库，并按仓库内的清单校验；本机与 Linux 构建都用它。qmcode 本身不链接 V8。
- **Linux 产物**：fork 的 workflow 由推送 `qianmo/build/p171-helper` 分支触发，run `37123317219`，编译 44 min 50 s（整个 job 约 47 min）。产物目录 7 个文件；`.sha256` 的四行在本机全部校验通过，传到 p4 的两个程序在 p4 上再校验一次也通过（`.debug` 没传到节点）。
- 未验证：effort 只测了 `low`、`max`；「生效」的依据是网关回显和 reasoning token 数的差别，不是回答质量评估。

## 第 2 项：app-server 在节点常驻

### 做法

- 部署：产物目录 `qmcode-rust-v0.158.0-90e00225c6-x86_64/` 整个放到 p4 的 `~/qianmo-2b/qmcode/`（0700），按 `.sha256` 校验 `qmcode` 与 `codex-code-mode-host`；`~/qianmo-2b/qmcode/bin/qmcode` 是指向产物目录里 `qmcode` 的软链接，辅助程序只在产物目录里。辅助程序动态链接 `libssl.so.3`、`libcrypto.so.3`、`libz.so.1`、`libzstd.so.1` 等，Debian 13 都自带。
- 端口：先用 `ss -ltnp` 看已有监听，选 18472（常驻实例）和 18473（第 4、5、7 项用的短期测试实例），不碰 beta-5 的 38625。
- 启动常驻实例（`HOME` 指向临时目录，第 4 项要用它下面的 `.claude/projects/`）：

  ```sh
  umask 077; openssl rand -hex 32 > <令牌文件>
  HOME=<临时 HOME> QMCODE_HOME=<状态目录> setsid nohup ~/qianmo-2b/qmcode/bin/qmcode app-server \
    --listen ws://127.0.0.1:18472 --ws-auth capability-token --ws-token-file <令牌文件> </dev/null &
  ```

  `config.toml` 与第 1 项相同，另加 `sandbox_mode = "danger-full-access"`（p4 没有 bwrap，见下）、`notify`（第 7 项的 perl 记录器）和 `[features] plugins = false`。模型 key 由本机经 ssh 的标准输入送到远端子 shell，`read` 进环境变量，由 app-server 继承。
- 采样：一个 bash 脚本每分钟整点 `curl http://127.0.0.1:18472/readyz` 一次，记 HTTP 码与耗时、进程是否在、app-server 及其子孙进程的 `VmRSS` / `RssAnon` / `RssFile`、机器的 `MemAvailable`。脚本用 `env -u OPENAI_API_KEY setsid nohup` 起，环境里没有 key 变量；到 24 h（2026-10-04 13:27:20 UTC）自己退出。app-server 不会跟着退出，要另外停。
- 沙箱：查 `runsc`、`bwrap`、`kernel.unprivileged_userns_clone`、`user.max_user_namespaces`，跑 `unshare -Ur true`。不装系统包：只把 Debian 官方源里的 `bubblewrap` 包下载到用户目录，`dpkg-deb -x` 解开后放进 `PATH`，再用 `qmcode sandbox -P <档位> -C <工作目录> -- sh -c '…'` 在工作目录内外各写一个文件。

### 结果

| 检查 | 结果 |
|---|---|
| 监听 | 只有 `127.0.0.1:18472`；启动后第 2 次轮询 `/readyz` 即 200 |
| 鉴权 | 不带令牌、带错令牌的 WebSocket 升级请求都返回 401 |
| key | 启动前后 `ps -eo args` 里 key 都出现 0 次；采样进程的环境里没有 key 变量 |
| 插件目录 | `[features] plugins = false` 后状态目录里没有 `.tmp/plugins`（v0.1 本机每个新目录约 89 MB）；p4 上本次的整个工作目录 15 MB |
| `/readyz` | 24 h（2026-10-03 13:27:20 至 10-04 13:27:00 UTC）共 1442 次采样，全部 200，耗时 0.49–7.59 ms（中位 1.48 ms）；相邻两次采样的间隔最长 61 s，没有漏采。全程是同一个进程（pid 不变），没有重启 |
| 内存：常驻实例 | 刚起 87.7 MB；第 3 项一个回合后 144.5 MB，之后空闲时缓慢升到 147.2 MB。其中匿名内存只有 20–22.5 MB，其余约 124 MB 是 `RssFile`：278 MB 的可执行文件被映射进来的干净页（smaps 里 `Private_Clean` 116 MB）。18 个线程；这个实例只跑了第 3 项，没有调工具，没有子进程。24 h 采样期间：15:42–18:29 UTC 匿名内存约每 12 min 涨 0.2 MB，共涨 2.2 MB；之后 19 h 只再涨 0.2 MB。全程最大 `VmRSS` 149.5 MB、匿名 24.9 MB、`RssFile` 约 124.6 MB，子孙进程始终为 0 |
| 内存：测试实例 | 刚起 81.8 MB（匿名 11.3 MB）；第 4、4b、7、5 项之后依次是 140.6 / 146.9 / 150.3 / 167.2 MB，匿名 21.2 / 26.5 / 28.0 / 36.1 MB。这个实例没有挂采样，数字是每项做完时读的。第 5 项调过工具后有一个 `codex-code-mode-host` 子进程，它的内存没有单独记。做完第 5 项后停掉，端口释放，无残留进程 |
| 机器余量 | 内存 1973 MB，`MemAvailable` 在前 82 min 最低 888 MB，24 h 里最低 744 MB（p4 上同时跑着 beta-5） |

| 沙箱检查 | 结果 |
|---|---|
| 虚拟化 / gVisor | p4 是 KVM 虚拟机，没有 `runsc`。**gVisor 未测** |
| user namespace | `unprivileged_userns_clone=1`，`max_user_namespaces=7676`，`unshare -Ur true` 返回 0 |
| 不装 bwrap 时 | 系统没有 bwrap。`qmcode sandbox -P :read-only` 和 `-P :workspace` 都直接 panic：`bubblewrap is unavailable: no system bwrap was found on PATH and no bundled codex-resources/bwrap binary was found next to the Codex executable`。只有 `-P :danger-full-access` 能跑。读代码：旧的 Landlock 模式（`features.use_legacy_landlock`）只接受全盘可写的策略，要限制文件系统同样需要 bwrap（`linux-sandbox/src/linux_run_main.rs`），没有不靠 bwrap 的退路 |
| 取 bwrap | `apt-get download bubblewrap` 失败：p4 的 apt 索引里的候选 `0.11.0-2+deb13u1` 已从源上撤下（404）。没有 `apt-get update`（不改系统），直接从 `deb.debian.org` 的 pool 取 `bubblewrap_0.12.0-1~deb13u1_amd64.deb`（sha256 `70aca4fa…24c43431`） |
| 普通用户跑 bwrap | `bwrap --unshare-user --unshare-pid --unshare-net … id` 返回 0 |
| 带 bwrap 的 qmcode 沙箱 | `:read-only`：工作目录内外写文件都报 `Read-only file system`。`:workspace`：工作目录内可写，外面报 `Read-only file system`。都符合预期 |

### 结论：有条件通过

- **常驻与鉴权：通过。** 经软链接起的 app-server 只听回环地址，能力令牌鉴权生效，key 不进命令行参数。连续 24 h `/readyz` 1442 次全部 200，进程没有重启，空闲时匿名内存在 25 MB 以下持平。采样结束后停掉了 app-server，端口释放，没有残留进程。
- **沙箱：p4 上按计划卡退路处理。** p4 不是 gVisor，没有 bwrap，app-server 两个实例都用 `danger-full-access`，只靠外层隔离。只要节点上有 bwrap（系统包，或随产物放 `codex-resources/bwrap`），这类 KVM 节点上普通用户就能建 user namespace，`read-only`、`workspace` 两档都能用。gVisor 内能否建 user namespace 本次答不了。
- **内存上限按匿名内存判定**（计划 v1.1 §0「内存口径」）。按 `VmRSS` 算：常驻实例 24 h 内 147.2–149.5 MB，贴着 150 MB；测试实例第 7 项后 150.3 MB，第 5 项调过工具后 167.2 MB，当时没有立即停，做完第 5 项才停。按匿名内存算：常驻 24.9 MB 以下，测试实例最多 36 MB，远低于上限。`VmRSS` 的大头是可执行文件的干净页，内存紧张时内核可以回收，不代表进程真占了这么多。采样脚本 13:34 UTC 起就按「app-server 与子孙进程的匿名内存合计超过 150 MB，或机器 `MemAvailable` 低于 300 MB」判停，24 h 里没有触发。
- **`[features] plugins = false` 实测有效**（v0.1 只读了代码），节点上应加上。

## 第 3 项：会话跨机续接

### 做法

1. 本机造会话：本机 qmcode（带辅助程序）在临时 `QMCODE_HOME` 下 `qmcode exec` 一轮。工作目录里的 `rules.txt` 写着代号规则（城市表第 3 个城市，接「甲 + 乙」的和；甲 = 1729，乙 = 4096），要求用 shell 读文件后回答代号。回答「代号是金陵-5825。」，rollout 46235 字节。
2. 把这份 rollout 原样拷到 p4 常驻实例全新的 `QMCODE_HOME/sessions/2026/10/03/`，两边 sha256 一致（`44bfd8b6…5c0050`）。p4 上的工作目录 `work3` 是空目录，`rules.txt` 不在节点上。
3. p4 本机经 WebSocket：`initialize` → `initialized` → `thread/resume {threadId, cwd: <p4 的 work3>, approvalPolicy: "never", sandbox: "danger-full-access"}` → `thread/turns/list {threadId, limit: 50}` → `turn/start`（「这一轮不要运行任何命令，也不要读任何文件，只凭本会话前面的内容回答两个问题：刚才按 rules.txt 的规则算出的代号是什么？rules.txt 里「甲」的值是多少？」）→ 再 `thread/turns/list`。

### 结果

- `thread/resume` 直接找到线程，返回 p4 上那份 rollout 的路径，`cwd` 是 p4 的 work3；带回 1 个回合的全部条目（用户消息、两条助手消息、`commandExecution` 及其输出）。
- 续接前的 `thread/turns/list` 返回 1 个回合，只含用户消息和最后一条助手回答（摘要视图，没有中间的命令执行），**不为空**；续接后返回 2 个回合。
- 回答「代号是金陵-5825；「甲」的值是 1729。」，回合 4.0 s，没有执行命令。「甲」只出现在原会话里工具读到的文件内容中，按 AC-H2 判命中。
- 新回合追加在同一个文件里（46235 → 59957 字节），没有另起文件；notify 触发 1 次。

### 结论：通过

- 跨机续接只需要把 rollout 原样放进 `sessions/YYYY/MM/DD/`，`thread/resume` 显式传节点上的 `cwd`。原会话里的本机路径（`turn_context` 的 `cwd`、命令里的 shell）不影响续接。
- 「远程界面翻历史是否为空」：不为空。在全新的 `QMCODE_HOME` 里，第一次续接之前 `thread/turns/list` 就能返回回合（摘要视图）；界面接入后显示完整历史，实测见第 5 项（那个线程是导入来的，不是拷来的 rollout）。

## 第 4 项：Claude Code 会话导入

### 做法

1. 造会话：本机在临时目录用 `claude -p`（Claude Code 2.1.288）新开一个不含敏感内容的会话。工作目录里的 `rules.txt` 写着另一条规则（星宿表第 4 个星宿名，接「甲 × 乙」的积；甲 = 37，乙 = 211），回答「代号是 **房-7807**」。
2. 裁剪与改写：原始 JSONL 40 行，其中有 22 行 `attachment`（带 CLAUDE.md 等本机上下文）和若干其他非对话记录。只保留 8 行 `user` / `assistant`，每行的 `cwd` 改为 p4 上的工作目录（空目录），放进 app-server 进程 `$HOME/.claude/projects/qianmo-import/`（`HOME` 是临时目录）。
3. 再造一份长会话：同一段对话后面接 30 对无关的填充问答（每对约 4 KB），共 68 行、138743 字节。
4. p4 本机经 WebSocket：`externalAgentConfig/import {migrationItems: [{itemType: "SESSIONS", details: {sessions: [{path, cwd}]}}]}` → 等 `externalAgentConfig/import/completed` → 取 `successes[0].target` → `thread/resume {threadId, cwd, …}` → `turn/start` 问只有原会话工具结果里才有的事实。长会话续接时另带 `config: {"model_auto_compact_token_limit": 20000}`，把阈值压到它的长度以下。
5. 第 4、5、7 项都在短期测试实例（18473）上做，常驻实例留给 24 h 采样。

### 结果

- 导入：请求立即返回 `importId`；`import/completed` 里 `SESSIONS` 成功 1、失败 0，`target` 就是新线程 id，标题取第一条用户消息。
- 导入后的线程：1 个回合 `external-import-turn-1`，7 个条目。用户消息原样；原会话的两次工具调用和结果各变成一条助手消息（`[external_agent_tool_call: Bash] …`、`[external_agent_tool_result] …`）；然后是原来的回答；末尾加一条 `<EXTERNAL SESSION IMPORTED>`。工具调用里的本机绝对路径原样保留，我们只改写了记录的 `cwd` 字段。原会话第一次工具结果是 macOS `cat -v` 的转义输出，导入后也是这样（乱码在原文件里就有，不是导入造成的）。
- 续接：回答「刚才算出的代号是房-7807；「乙」的值是 211。」，没有执行命令，按 AC-H2 判命中。这个回合从开始到第一个输出等了 103 s（推理 token 0，输出 25 token，app-server 日志里没有重试记录），原因未查；本次其余回合都在 10 s 内。
- 长会话：导入后 31 个回合。续接后的第一个回合一开始就是 `contextCompaction` 条目，压缩请求的输入 39209 token，用时 5.8 s，随后收到告警「Heads up: Long threads and multiple compactions can cause the model to be less accurate…」；再回答「房-7807」，事实在压缩后保留。整个回合 8.2 s。

### 结论：通过

- 导入链路按计划卡的写法可用，`successes[0].target` 就是可续接的 thread id。读代码：会话文件必须在 app-server 进程 `$HOME/.claude/projects` 下；`cwd` 取第一条带 `cwd` 的记录，必须是节点上存在的目录。
- 「长会话是否一上来就触发压缩」：看导入的历史是否超过自动压缩阈值。阈值 = min(配置的 `model_auto_compact_token_limit`, 上下文窗口 × 90%)（`protocol/src/openai_models.rs` 的 `auto_compact_token_limit`）。`gpt-6-luna` 的窗口是 272000，默认阈值 244800 token。超过时第一个回合先压缩再回答（本次把阈值调低后实测）；本次的长会话约 39k token，按默认阈值不会压缩。
- 导入只读 `user` / `assistant` 记录（读代码），但整个文件会留在节点上。我们放过去的是只留对话记录的版本，P17.x 往节点送会话时也应先这样裁剪。

## 第 5 项：远程直连

### 做法

- 节点侧：用 p4 测试实例上第 4 项导入的线程。p4 本机起第二个 WebSocket 连接（Bun 写的小程序，下称「桥」）：`thread/resume {threadId, cwd: <p4 的 work5>, approvalPolicy: "never", sandbox: "danger-full-access", excludeTurns: true}`，记下收到的全部通知；界面那个回合结束 5 s 后，桥自己 `turn/start` 一个回合。
- 本机：`ssh -N -L 28472:127.0.0.1:18473 p4`。令牌经 ssh 读进本地 shell 变量，再 `export QMCODE_REMOTE_TOKEN`，不打印、不落盘。界面用本机 macOS 的 qmcode（与节点同为 0.158.0），临时 `QMCODE_HOME`，配置里审批 `never`、沙箱 `danger-full-access`，不载入模型 key：

  ```sh
  qmcode resume --remote ws://127.0.0.1:28472 --remote-auth-token-env QMCODE_REMOTE_TOKEN <threadId>
  ```

  界面在 160×48 的伪终端里由 expect 驱动：等历史出现 → 等状态栏出现模型名 → 输入「Use your shell tool to run the command hostname, then reply with its exact output only.」并回车 → 等回答 → 等桥那个回合的回答 → Ctrl-C 退出 → 关隧道。

### 结果

- 第 1 次实跑（13:39 UTC）：历史 5 s 内出现；输入后回车，文字留在输入框里没有提交，没有回合、没有模型调用。随后本机电量低进入睡眠（13:43–14:26），桥 15 min 后超时退出。这次作废。
- 第 2 次实跑（14:29 UTC，接电源并 `caffeinate`）：
  - 界面 6 s 内显示完整历史（导入的用户消息、工具调用说明、第 4 项那一轮问答），状态栏显示 `GPT-6-Luna` 和 `permissions: YOLO mode`，工作目录显示 p4 上的 work5（由桥的 resume 设置）。
  - 第一次回车后 15 s 内没有回合开始，第二次回车才提交。
  - 提交后 2 s，界面显示「Ran hostname」和 p4 的主机名。p4 上：code mode 的 `exec` 脚本调 `tools.exec_command({cmd: "hostname"})`，`commandExecution` 为 `/bin/bash -lc hostname`，退出码 0。
  - 桥收到这个回合的全部事件：`turn/started`、用户消息、推理、两条助手消息、`commandExecution` 的开始与完成（含输出）、两次 `thread/tokenUsage/updated`、`turn/completed`。
  - 桥 5 s 后开的回合（让模型只回答「6 乘以 7 再加 5500」，不跑命令）在界面上显示了提问和回答「5530」。模型算错了（应为 5542），这里判的是事件到达，不是答案对错。
  - Ctrl-C 后界面退出；关隧道后本地端口释放。
- 回合期间桥还看到另一个线程的 `thread/started`，约 3 s 后转为空闲，随后本线程收到 `thread/name/updated`。notify 也为那个线程触发了一次，它没有 rollout 文件。推测是界面触发的自动起标题临时线程，未核实。
- 显示遗留：界面标题框写 `OpenAI Codex (v0.158.0)`；退出时提示 `Reconnect: codex --remote … resume <threadId>`，命令名应为 `qmcode`；app-server 启动横幅写 `codex app-server (WebSockets)`。

### 结论：通过

- 两个连接同时接在同一线程上，各自都收到对方回合的事件；界面输入在节点上执行。AC-H4 的前提成立。
- 读代码（`tui/src/app_server_session.rs` 的 `thread_resume_params_from_config`）：远程模式下 resume 不带审批和沙箱，沿用节点上线程已保存的设置；`cwd` 只在给了 `--cd` 时才带。`turn/start` 的参数里有 `cwd`、审批和权限，由界面会话里的当前值填。本次本机配置与节点线程一致，实测区分不出两者。v0.4：不一致的情形已由 P17.6 实测，**以节点线程的设置为准**（见「未验证与存疑」第 5 项）；界面那几个值从哪里来，代码路径仍未逐行核对。
- 「要按两次回车」：v0.4 已查明，是输入框的粘贴突发判定，与远程直连无关；逐键输入时一次回车就提交（见「未验证与存疑」第 5 项）。

## 第 6 项：fork 内置配置

### 机制（读源码）

- **内置默认层是上游现成的。** `codex-rs/config/src/loader/mod.rs` 的 `load_config_layers_state` 用 `include_str!("../../defaults.toml")` 把 `codex-rs/config/defaults.toml` 编译进二进制，作为 `PackagedDefaults` 层。上游这个文件已有 14 项默认值（如 `cli_auth_credentials_store = "file"`）；P17.1 没动它，P17.3 是往里**加**两项，不是新建机制。`LoaderOverrides.packaged_defaults_path` 只在测试里用，命令行和环境变量都换不了这一层。
- **层级**（`config/src/config_layer_source.rs`，数字越大越优先）：内置默认 −10 < MDM 0 < 系统 `/etc/qmcode/config.toml` 10 < 企业云 15 < 用户 `$QMCODE_HOME/config.toml` 20 < 用户 profile 21 < 项目 `.codex/config.toml` 25 < 命令行 `-c` 30 < 旧版托管 40/50。
- **合并**（`config/src/merge.rs` 的 `merge_toml_values`）：表逐键递归合并，数组和标量整体替换。所以用户写 `[mcp_servers.qianmo] enabled = false` 只改这一个键，`command`、`args` 仍来自内置层；用户写 `notify = [...]` 会整个顶掉内置的 `notify`。
- 项目层禁止设 `notify`、`model_providers` 等（`PROJECT_LOCAL_CONFIG_DENYLIST`），不影响内置层。
- app-server 的 `config/read` 在 `origins` 和 `layers` 里过滤掉内置层，只影响显示，有效配置里仍包含内置层的值。
- `notify` 回调（`hooks/src/legacy_notify.rs`）不经 hook 信任检查；进程即发即忘，标准输出与标准错误丢弃；环境是 qmcode 进程自己的完整环境，只去掉 5 个启动上下文变量（`protocol/src/shell_environment.rs`），因此能拿到 `PATH`、`SSH_AUTH_SOCK`，**也能拿到模型 key 所在的环境变量**。`notify = []` 等于关闭（`hooks/src/registry.rs` 过滤空数组）。

### 实测

没有重编二进制，所以「把两项写进 defaults.toml」本身没有实跑。分两步替代：先用真二进制和真内置层验证合并语义；再把计划中的两项放到一个**替身低层**（用户 `config.toml`），用更高的层去关它。MCP 的 `command` 换成一个替身 MCP 服务（Bun 写的 stdio 小程序，启动即写日志），代替尚未实现的 `qm handoff mcp`。这些测试都不调模型，没有载入 key。

| 编号 | 做法 | 结果 |
|---|---|---|
| T0 | 空 `config.toml`，经 stdio 调 `config/read` | 有效配置含内置层的 `history = {persistence = "save-all"}`、`project_root_markers = [".git"]`、`project_doc_max_bytes = 32768`；`origins` 为空，`layers` 里没有内置层 |
| T1 | 用户层写 `project_root_markers = [".hg"]` 与 `[history] max_bytes = 1048576` | `history = {persistence = "save-all", max_bytes = 1048576}`：内置层的表与用户层的半张表**深合并**；`project_root_markers = [".hg"]`：数组**整体替换** |
| T2 | 替身低层写 `notify = ["qm","handoff","sync","--hook","qmcode"]` 和 `[mcp_servers.qianmo]`（替身命令）；全新 `QMCODE_HOME`；`initialize` → `thread/start` → `mcpServerStatus/list` | 首个 `thread/start` 即拉起：`mcpServer/startupStatus/updated` 从 `starting` 到 `ready` 用时 15 ms，工具 `qianmo_status` 可见。`mcpServerStatus/list` 又另起了一个实例（替身日志里两次 `start`） |
| T3 | 同 T2，app-server 加 `-c mcp_servers.qianmo.enabled=false` | 有效配置 `enabled = false`；没有启动通知，替身从未被拉起 |
| T3b | 同 T2，另写 profile 文件层 `user.config.toml`，只含 `[mcp_servers.qianmo] enabled = false`；`qmcode -p user mcp list --json` | `enabled: false`，`command`、`args` 来自低层；不带 `-p` 时 `enabled: true` |
| T4 | 用户 `config.toml` **只写** `[mcp_servers.qianmo] enabled = false`（真实场景下用户会这么写） | 有效配置正常（用 `-c` 补上低层的 `command`、`args` 后 `mcp list` 显示 `enabled: false`）。但 `qmcode mcp remove other` 和 `qmcode mcp add other -- echo hi` 都报 `failed to load MCP servers … invalid transport in 'qianmo'`，退出码 1。原因：这两个命令（`cli/src/mcp_cmd.rs`）用 `load_global_mcp_servers` 单独解析用户文件，半张表在那里不合法 |
| T5 | 用户 `config.toml` 写完整表：`command = "qm"`、`args = ["handoff","mcp"]`、`enabled = false` | `mcp add`、`mcp remove` 都正常；`mcp add` 改写文件时把文件开头原有的注释行去掉了 |
| T6 | 替身低层的 `command` 指向不存在的程序 | `startupStatus` 为 `failed`（`No such file or directory`），线程照常建立 |

### 结论：有条件通过

- **放哪一层、怎么加**：直接加进 fork 的 `codex-rs/config/defaults.toml`，不改 Rust，不用 `/etc/qmcode`（要 root 和单独的安装步骤），不用 MDM。

  ```toml
  notify = ["qm", "handoff", "sync", "--hook", "qmcode"]

  [mcp_servers.qianmo]
  command = "qm"
  args = ["handoff", "mcp"]
  ```

  不设 `required`（默认 `false`）：`qm` 不在 `PATH` 上时 MCP 只报启动失败，线程照常（T6）。
- **首次启动即生效**：内置层不依赖任何文件；MCP 在首个线程启动时拉起（T2 是全新目录）。`notify` 在第 7 项的两次运行里都触发了（同样放在替身低层）。TUI 首次启动的流程没有测。
- **用户能否关掉**：能（T3、T3b）。但给用户的关闭写法必须是**完整表**（T5），不能只写 `enabled = false`（T4 会弄坏 `qmcode mcp add/remove`）。读代码判断 `qmcode mcp remove qianmo` 删不掉内置项（它只看用户文件，会提示找不到），未单独实跑。
- **notify 的限制**：用户自设 `notify` 会整个顶掉内置值，文档要写明；想两者都要，只能由用户自写包装脚本。
- **对 `qm handoff mcp` 的要求**：每个线程拉起一份，状态查询还会再起一份，必须无状态、可并发多实例。
- **对 `qm handoff sync --hook qmcode` 的要求**：会继承 qmcode 的完整环境（含模型 key 变量），不得记录环境变量；以 qmcode 的 `PATH` 找 `qm`。

## 第 7 项：回合结束后会话文件何时落盘完整

### 做法

```sh
QMCODE_HOME=<临时目录> qmcode app-server --listen ws://127.0.0.1:18432 \
  --ws-auth capability-token --ws-token-file <0600 令牌文件>
```

- 起来后 `/readyz` 返回 200；`lsof` 只见 `127.0.0.1:18432`；不带令牌的升级请求返回 401；测完结束进程，端口释放。
- 驱动：Bun 写的 WebSocket 客户端，带 `Authorization: Bearer <令牌>`。`initialize` → `initialized` → `thread/start {cwd, approvalPolicy: "never", sandbox: "workspace-write"}` → 两次 `turn/start`（读 `data.txt` 第二行；不跑命令回答第一行）。每回合结束后再观察 15 s。
- 同一进程每 2 ms 对 rollout 文件 `stat` 一次（APFS 纳秒 mtime），每次变化都读出新增行的类型。
- `notify` 放在替身低层。run1 用 perl 记录器（另存 notify 时刻的文件快照）；run2 用 C 程序，进程起来到第一次 `stat` 约 0.2 ms，用来测「回调最早能读到什么」。
- 模型目录用第 1 项的覆盖（`tool_mode = "direct"`），effort 用默认（`medium`）。

### 结果

A = `task_complete` 行写入时刻（文件 mtime）；B = 客户端收到 `turn/completed`；C = notify 回调进程执行第一条指令。单位 ms。

| 运行 | 回合 | B − A | C − A | C − B | notify 时末行是本回合 `task_complete` | notify 时文件大小 = 最终大小 | `task_complete` 后 15 s 内再写入 | `token_count` → `task_complete` |
|---|---|---|---|---|---|---|---|---|
| run1（perl） | 1 | 1.84 | 17.40 | 15.56 | 是 | 是 | 否 | 5.20 |
| run1（perl） | 2 | 0.57 | 5.51 | 4.94 | 是 | 是 | 否 | 2.40 |
| run2（C） | 1 | 0.79 | 1.16 | 0.37 | 是 | 是 | 否 | 2.21 |
| run2（C） | 2 | 2.10 | 3.57 | 1.47 | 是 | 是 | 否 | 5.52 |
| p4（perl，Linux） | 1 | 7.51 | 17.46 | 9.95 | 是 | 是 | 否 | 16.00 |

- p4 补测（v0.2）：p4 的短期测试实例，产物 `90e00225c6`，二进制内置目录（code mode，带辅助程序），notify 用同一个 perl 记录器，1 个回合（读 `data.txt` 第二行）。模型没有调工具，直接回答「无法直接读取当前目录的文件」，不影响回合末时序的测量。2 ms 轮询在收到 `turn/completed` 之前 4.0 ms 就看到了 `task_complete` 行；没看到半行。先后顺序与本机相同，各段间隔比本机长几毫秒。
- run1 的 notify 快照与最终文件的同长前缀逐字节一致。
- 轮询从未看到半行。
- 回合末的写入顺序固定为 `token_usage_record` → `event_msg/token_count` → `event_msg/task_complete`。`task_complete` 带 `turn_id`，与 notify 载荷里的 `turn-id`、`turn/completed` 里的 `turn.id` 相同。
- 下一回合一开始文件又会追加（`task_started`、`turn_context` …），「稳定」只在两个回合之间成立。

### 代码里的先后（读源码）

- notify 在 `core/src/session/turn.rs` 的回合循环里、Stop hook 之后分发（`run_legacy_after_agent_hook`），只 spawn 不等待。之后才进入 `core/src/tasks/mod.rs` 的 `on_task_finished`：把 `TurnComplete` 交给异步写任务 → 投递事件（app-server 据此发 `turn/completed`）→ 最后才调 `flush_rollout` 作屏障。
- rollout 写任务（`rollout/src/recorder.rs`）收到条目就写，只冲用户态缓冲，不 `fsync`。
- 所以「先落盘，再 `turn/completed`，再 notify」是本次的观测结果：靠进程启动的 1 ms 以上延迟，以及空闲机器上写任务很快。**代码并不保证**：notify 分发时 `task_complete` 还没交给写任务；`turn/completed` 发出时屏障还没执行。

### 结论：通过；P17.4 的同步规则

1. **不用「大小与 mtime 稳定」的计时窗口。** 回合末 `task_complete` 之后 15 s 内零写入，计时窗口没有收益；回合中途模型思考时文件可能几秒不变，计时窗口反而会把未完成的回合当成稳定。
2. **按内容判完整，短等待。** 以 notify 载荷的 `turn-id`（或 `turn/completed` 的 `turn.id`）为键，读到 `event_msg` 且 `payload.type` 为 `task_complete`（中断时为 `turn_aborted`）、`payload.turn_id` 相同的行，才算本回合已落盘。没读到就每 10 ms 重读，上限 2 s；超时仍按最后一个完整行同步，台账标「未完整」，下一次 notify 再补。本次实测需要的等待是 0 ms（本机 4/4，p4 1/1）。notify 也会为没有 rollout 文件的临时线程触发（第 5 项），找不到这个线程的会话文件就跳过，不算失败。
3. **只同步到最后一个换行符。** 写入不是原子的，本次虽没见半行，规则上不依赖它。
4. **去抖用尾沿。** notify 即发即忘，回合紧挨着时会连续触发；计划里 5 s 去抖必须保证最后一个回合会被同步。
5. **`qm handoff now`**：回「可以关机」前，最近一个 `task_started` 必须已有同 `turn_id` 的 `task_complete` 或 `turn_aborted`，否则提示「回合进行中」。这是 AC-H1「会话记录已完整落地」在会话一侧的判据。
   **2026-10-03 回写（P17.4 第二批 #174、P17.3 本仓库）**：调用方本身可能就在一个未完成的回合里，判据按调用方分三种情形，以 `handoffTranscript.ts` 的 `qmcodeSnapshot(content, fromThreadShell)` 为准：
   - ① 终端里、或别的线程里运行：任何未完成的回合都报「回合进行中」（含只有一条 `task_started` 的、等 MCP 就绪的模型回合）。
   - ② qmcode 的 `/handoff` 或 `!`：`thread/shellCommand` 先开一个 shell 回合，命令运行时文件末行就是它的 `task_started`。三条同时满足才认作调用方自己的 shell 回合：环境里的 `CODEX_THREAD_ID` 与本会话相同；那条未完成的 `task_started` 是文件最后一行；它后面没有任何字节。满足就截到它之前，前面部分按同一规则再判；否则按 ①。
   - ③ MCP 工具 `qianmo_handoff`（模型回合内的工具调用）：文件末尾是这个回合的 `task_started`、`turn_context`、`response_item`，最后一条是调用本工具的 `function_call`。这个回合要等工具返回才能结束，所以不拒绝也不等，截到最近一个未完成回合的 `task_started` 之前；Claude Code 会话截到最后一个完整回合。返回里写明截到哪。
   - 会话选择：环境里有 `CODEX_THREAD_ID` 且找得到它的 rollout 时用这个线程（②）；MCP 调用用 `tools/call` 的 `_meta.threadId`（③）；都没有再按工作目录查 `sessions.json`。
6. **P17.5 节点桥**：收到 `turn/completed` 后用同一判据，再把会话提交到 `refs/qianmo/sessions/cloud/<threadId>`。

## 对设计与工作包的影响（已回写）

下列各条已在 2026-10-03 回写进 [`handoff-p17-plan.md`](./handoff-p17-plan.md) v1.1 与 [`handoff-m1.md`](./handoff-m1.md) v1.2（#167）。

| 回写到 | 内容 |
|---|---|
| 计划 P17.1 卡、fork `QIANMO.md` | **产物部分已在 fork 做完**（`90e00225c6`，`QIANMO.md` 第 2、4、6、7、9 节已同步）：产物目录里 `qmcode` 与 `codex-code-mode-host` 并列，各带 `.debug`，`.sha256` 四行；V8 预编译库经 `qianmo/fetch-rusty-v8.sh` 从上游发行取并校验。卡上的完成标准可加「带工具调用的 `qmcode exec` 跑通」（第 1 项 A′）。还剩的显示遗留：界面标题 `OpenAI Codex`、退出时的重连提示 `codex --remote …`、app-server 启动横幅 `codex app-server`、若干帮助文本 |
| `handoff-m1.md` §2「要改的」第 2 条 | 改为「往上游已有的 `codex-rs/config/defaults.toml` 加两项」；补「用户关闭须写完整表」「用户自设 notify 会顶掉内置值」 |
| 计划 P17.3 卡（fork 部分） | `defaults.toml` 内容按第 6 项结论；顺带加 `check_for_update_on_startup = false`（`QIANMO.md` 待办）；节点加 `[features] plugins = false`（第 2 项已实测有效）；完成标准加「`qm handoff mcp` 可并发多实例」「`qm handoff sync` 不记录环境变量」 |
| 计划 P17.4 卡 | 第 7 项的规则：按 `turn_id` 判完整、10 ms / 2 s、截到最后一个换行、尾沿去抖、`now` 的「回合进行中」检查；notify 指向没有会话文件的临时线程时跳过 |
| 计划 P17.5 卡 | ① 沙箱：节点要么带 bwrap（系统装 `bubblewrap`，或随产物放 `codex-resources/bwrap`），要么定为 `danger-full-access` 只靠外层隔离；KVM 上的 Debian 13 普通用户能用 bwrap。② 部署：两个文件同一目录，可经软链接调用。③ 内存：150 MB 上限要写明按 `VmRSS` 还是匿名内存 / PSS；按 `VmRSS` 常驻空闲约 147 MB，调过工具约 167 MB，大头是可回收的文件页。④ 续接：拷来的 rollout 放进 `sessions/YYYY/MM/DD/`，`thread/resume` 显式传 `cwd` 即可。⑤ 导入：app-server 进程的 `HOME` 决定 Claude Code 会话目录；送到节点的会话先裁成只含 `user` / `assistant` 记录；工具调用里的本机路径不会被改写。⑥ 导入的历史超过压缩阈值时，第一个回合先压缩（多几秒，会出告警）。⑦ `turn/completed` 后用第 7 项的同一判据 |
| 计划 P17.6 卡 | 接入命令用 `qmcode resume --remote ws://127.0.0.1:<本地端口> --remote-auth-token-env <变量> <threadId>`；不传 `--cd` 就不改线程的 `cwd`；本机配置的审批 / 沙箱与节点不一致时的行为要进用例；本次自动化驱动时要按两次回车才提交，用例要覆盖 |
| 计划 §6 风险表 | 「网关不提供 Responses API」一行可关闭；「gVisor 内 bwrap 不可用」仍开着（gVisor 未测），补一句：非 gVisor 的 KVM 节点上 bwrap 可用，缺的只是包 |

## 未验证与存疑

- 第 1 项：effort 只测了 `low`、`max`；「生效」的依据是网关回显和 reasoning token 数的差别，不是回答质量评估。A′ 只在本机 macOS 跑；Linux 产物上的 code mode 工具调用由第 5 项覆盖（1 次）。
- 第 2 项：
  - gVisor 未测（p4 没有 `runsc`）。bwrap 是解包到用户目录后单独测的，两个 app-server 实例本身都以 `danger-full-access` 运行，「带 bwrap 的 app-server 回合」没有测。
  - 24 h 里常驻实例只在起跑时跑过第 3 项一个回合，之后全程空闲，没有回合、没有工具调用。有负载时的长时间内存曲线没有测。15:42–18:29 UTC 那段每 12 min 一次的小幅增长是什么引起的，没有查。
  - 按 `VmRSS` 读，测试实例在第 7 项后到线、第 5 项后超限，没有在超限时立即停（口径已定为匿名内存，见第 2 项结论）。
- 第 3 项：两台机器时区相同，rollout 文件名和日期目录都按本地时间，跨时区时的情形没有测。远程界面直接接「拷来的 rollout」线程没有单独测（第 5 项接的是导入的线程）。
- 第 4 项：默认阈值下的真实长会话压缩没有测，只测了把阈值调低的情形。续接后第一个回合首个输出等了 103 s，原因未查。
- 第 5 项：第 1 次实跑因本机睡眠和回车未提交作废；回合期间出现的临时线程是什么没有核实。下面两条原先写「原因未查」「未测」，v0.4 改为 P17.6 的实测结论（2026-10-04，本机 macOS；二进制就是上面「被测二进制」那份本机 release 构建 `qmcode 0.158.0`，sha256 `4bec959f…ad4f7b`；真 `qmcode app-server` 加真 `qmcode resume --remote` 界面，界面由 `qm handoff attach` 在 160×48 的伪终端里拉起，两个进程都用 `sandbox-exec` 只放回环，模型是本地 Responses 替身，ssh 是测试替身；用例 `tests/integration/qianmo-handoff-attach-qmcode.test.ts`，设 `QIANMO_TEST_QMCODE_BIN` 才跑，连跑 5 轮结论一致）：
  - 审批 / 沙箱不一致：节点线程按节点桥的设置建（`approvalPolicy: never`、`sandbox: workspace-write`）。本机 `config.toml` 比节点严（`on-request`、`read-only`）或比节点松（`never`、`danger-full-access`）两种情形下，界面里敲的每个回合在节点 rollout 的 `turn_context` 里都是 `never` / `workspace-write`，工作目录也是节点的。**以节点为准**，本机配置不起作用。
  - 两次回车：文字和回车在同一次写入里到达时（自动化驱动，或终端不支持括号粘贴时的粘贴），输入框把整段当作粘贴突发，那次回车成了粘贴内容里的换行，第二次回车才提交。逐键输入（间隔 40 ms）、回车前停 300 ms、括号粘贴，都是一次回车就提交。出处是 fork `codex-rs/tui/src/bottom_pane/paste_burst.rs`：连续 3 个以上字符、间隔小于 8 ms（`PASTE_BURST_CHAR_INTERVAL`）算粘贴突发，其后 120 ms 内（`PASTE_ENTER_SUPPRESS_WINDOW`）的回车按换行处理。v0.2 第 2 次实跑由 expect 驱动，现象与这种情形一致；那次 expect 是不是把整句和回车一次写入，没有回查原始脚本。
  - 仍未测：两台真机之间、真终端模拟器上的这两条（留给 P17.7 演练）。
- 第 6 项：没有重编二进制把两项真正写进 `defaults.toml`；MCP 与 notify 用的是替身低层，内置层本身的合并语义用它现有的 `[history]` 和 `project_root_markers` 证实。TUI 首次启动、`qmcode mcp remove qianmo` 对内置项的表现、`notify = []` 关闭，只读了代码。
- 第 7 项：本机 4 个回合、p4 1 个回合，gVisor 下的时序未测；中断回合（`turn_aborted`）、自动压缩后的写入未测。本机 4 个回合里只有 1 个调了工具，p4 那个回合也没有调工具，都是模型自己的选择，不影响回合末时序的测量。
- 本机副作用（v0.1）：第 7 项第一次空跑时脚本有错（变量紧跟全角冒号），`config.toml` 写成了空文件，app-server 退回内置的 `openai` 提供方，向 `wss://api.openai.com/v1/responses` 发起约 10 次连接，均因无凭据返回 401；那次没有载入 key。每个新的 `QMCODE_HOME` 都克隆了一份 `openai/plugins`，证据目录因此约 682 MB。
- p4 上的副作用（v0.2）：`~/qianmo-2b/qmcode/` 下新增产物目录（330 MB）和 `p172/` 工作目录（15 MB），`bin/qmcode` 软链接现在指向新产物；常驻 app-server 和采样进程还在跑。没有装系统包，没有动 beta-5 的进程、目录和端口。
- 观察：qmcode 的若干帮助文本仍写 `~/.codex/config.toml`、`Usage: codex exec`，属 P17.1 遗留的显示问题，不影响状态隔离。
