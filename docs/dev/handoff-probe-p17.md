<!-- Copyright 2026 Qianmo AgentNest Team -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# 阡陌 AgentNest — P17.2 探针结论

| 项 | 内容 |
|---|---|
| 文档版本 | **v0.1**（2026-10-03）。第 1、6、7 项已在负责人本机实测；第 2–5 项需要节点，**待真机** |
| 上位 | [`handoff-p17-plan.md`](./handoff-p17-plan.md) §2 P17.2 卡；设计 [`handoff-m1.md`](./handoff-m1.md) v1.1 |
| 被测二进制 | `qmcode 0.158.0`，fork 分支 `qianmo/p17.1-identity` 头 `348bd27f76`，本机 macOS aarch64 release 构建（`codex-rs/target/release/qmcode`，sha256 `4bec959f…ad4f7b`）。fork 只读，本次未改 |
| 模型网关 | `https://api.cornna.xyz/v1`，模型 `gpt-6-luna`，`wire_api = "responses"`。key 只经环境变量传入，配置里只写 `env_key = "OPENAI_API_KEY"` |
| 环境 | macOS（Darwin 27.0.0，aarch64）。没有在节点、Linux 或 gVisor 上跑 |
| 用量 | 真实模型调用：第 1 项 3 个任务（各 2 轮，共 13 次 `/v1/responses`），第 7 项 2 个任务（各 2 回合，共 5 次）。第 6 项不调模型 |
| 原始证据 | 负责人本机 `~/atlas-evidence/m1-work/p172/`，不入库。内容：命令、输出、时间戳、录制的请求体与响应流。索引在 `commands.txt`；全目录 33705 个文件逐个做 key 计数，命中 0（`keycheck-all.txt`） |

## 结论一览

| # | 探什么 | 结论 | 要点 |
|---|---|---|---|
| 1 | 网关是否提供 Responses API | **有条件通过** | 网关侧全部通过：多轮、工具调用、无状态回传 `encrypted_content`、effort 都正常，**不需要兼容层**。条件在 qmcode 产物：内置模型目录把 `gpt-6-luna` 定为 `code_mode_only`，工具调用要经同目录的辅助二进制 `codex-code-mode-host`，P17.1 产物里没有它，工具全部失败 |
| 2 | app-server 在节点（含 gVisor）常驻 | 待真机 | 计划在节点 p4 上做 |
| 3 | 会话跨机续接 | 待真机 | 计划在节点 p4 上做 |
| 4 | Claude Code 会话导入 | 待真机 | 计划在节点 p4 上做 |
| 5 | 远程直连 | 待真机 | 计划在节点 p4 上做 |
| 6 | fork 内置配置 | **有条件通过** | 上游已有「随二进制内置的默认配置层」：`codex-rs/config/defaults.toml` 编译进二进制，优先级最低。MCP 在首个线程启动时即被拉起，用户层 `enabled = false` 能关掉。条件：用户文件里**只写** `enabled = false` 会让 `qmcode mcp add/remove` 报错，文档必须给完整写法；`notify` 是数组，用户自设会整体顶掉内置值 |
| 7 | 回合结束后会话文件何时落盘完整 | **通过**（得出 P17.4 规则） | 4 个回合全部是：`task_complete` 行落盘 → 0.6–2.1 ms 后收到 `turn/completed` → 再过 0.4–15.6 ms notify 回调进程起来；之后 15 s 内零写入。代码不保证这个先后顺序，所以 P17.4 **按内容判完整**（找本回合的 `task_complete` 行），不用「大小与 mtime 稳定」的计时窗口 |

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

录制反代是一个只绑 `127.0.0.1` 的 Bun 小程序：把请求原样转给网关，记录请求体和 SSE 响应流，请求头只记名字，不记值，所以 `Authorization` 不落盘。反代进程本身不持有 key。

### 结果

| 任务 | 请求数 | HTTP | 工具 | 轮 1 回答 | 轮 2 回答 |
|---|---|---|---|---|---|
| A | 5 | 未录制；5 次都完成，`exec` 退出码 0 | 模型发起 3 次 `exec`（code mode 的自由格式工具），3 次都报 `failed to spawn code-mode host …/codex-code-mode-host: No such file or directory`；`app.cfg` 未改 | 「当前命令环境无法启动，未能读取 notes.txt」 | 「前文没有提供」（与轮 1 一致） |
| B | 4 | 全部 200，`response.completed` | `exec_command` 读文件、`sed` 改文件、`cat` 确认；`app.cfg` 改为 `release = 2.4.9` | 「青石-7731」 | 「林望舒；2.4.9」，未运行命令 |
| C | 4 | 全部 200，`response.completed` | 同 B | 「青石-7731」 | 「林望舒；2.4.9」，未运行命令 |

从 B、C 的录制看到的线上形态：

- 请求：`POST /v1/responses`，`stream: true`，`store: false`，**没有** `previous_response_id`，`include: ["reasoning.encrypted_content"]`，`parallel_tool_calls: false`。内置目录给 `gpt-6-luna` 开了 Responses Lite：`instructions` 为空，工具定义放在 `input` 里一个 `additional_tools` 项中，`reasoning.context = "all_turns"`。网关全部接受。
- effort：请求里的 `reasoning.effort` 与 `-c` 给的值一致，网关在 `response.completed` 里原样回显（`low` / `max`）。`low` 的 3 次请求 `reasoning_tokens` 都是 0，不产出 reasoning 项；`max` 每次 39–75 个 reasoning token，并产出带 `encrypted_content` 的 reasoning 项。所以 `-c` 覆盖被接受，也有可观察的效果。内置目录里这个模型支持 `low`、`medium`、`high`、`xhigh`、`max`，默认 `medium`；本次只测了 `low` 和 `max`。
- 无状态多轮：C 的第 2、3 次请求（同一回合内）和第 4 次请求（`exec resume` 新进程）把此前每个响应里的 reasoning 项原样放回 `input`。第 4 次请求带回 3 个 reasoning 项，`encrypted_content` 与当初的响应**逐字节一致**（1764 / 1676 / 1508 字节），网关回 200 并正常完成。
- A 没有录制线上请求体。从它的 rollout 看：工具虽然失败，`custom_tool_call` 与 `custom_tool_call_output`（错误文本）之后的请求都正常完成；5 次请求都产出了带 `encrypted_content` 的 reasoning 项。

### 结论：有条件通过

- **网关：通过。** 多轮、工具调用、无状态回传 `encrypted_content`、effort 档位都已端到端跑通。计划 §6 第一条风险（网关不提供 Responses API）可以关闭，不需要另立兼容层工作包。
- **条件：qmcode 产物缺 `codex-code-mode-host`。** 二进制内置目录（`codex-rs/models-manager/models.json`）里 `gpt-6-luna` 的 `tool_mode` 是 `code_mode_only`，同目录里的 gpt-6 / gpt-5.6 系列也都是。这种模式下工具调用由独立进程 `codex-code-mode-host` 执行；找不到它时不回退到普通工具，而是直接失败（「Code mode will fail closed」）。qmcode 按 `install-context/src/lib.rs` 的 `code_mode_host_program` 查找：先找包布局里的 `codex-resources/`，再找 qmcode 可执行文件所在目录。P17.1 的本机构建与 `qianmo/build-linux.sh` 都只编 `--bin qmcode`，Linux 产物同样缺这个文件。两种修法：
  1. **建议**：构建时一起出 `codex-code-mode-host`（`cargo build --release --locked --bin qmcode --bin codex-code-mode-host`），与 qmcode 放同一目录；产物命名、`.sha256`、部署树 `qmcode/` 目录都按两个文件处理。工具面与上游对这个模型的设定一致。
  2. 临时绕过：在内置配置或节点配置里用 `model_catalog_json` 把 `gpt-6-luna` 覆盖为 `tool_mode = "direct"`（本次 B、C 就是这样跑通的）。代价是目录要随上游手工同步，且偏离了模型的默认工具面。
- 未验证：code mode 带真实执行输出时的回传（缺辅助二进制，没法跑）。

## 第 2–5 项：待真机，计划在节点 p4 上做

以下为计划用的命令，均未执行。节点上的 qmcode 同样要带 `codex-code-mode-host`（见第 1 项），否则改用目录覆盖。

**第 2 项 app-server 常驻（含 gVisor 沙箱内）**

```sh
install -d -m 700 "$QMCODE_HOME"; umask 077; openssl rand -hex 32 > <令牌文件>
QMCODE_HOME=<…> qmcode app-server --listen ws://127.0.0.1:<端口> \
  --ws-auth capability-token --ws-token-file <令牌文件>
# 24 h 内每 5 min 记一次，另记进程 RSS
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:<端口>/readyz
# gVisor 内能否建 user namespace、bwrap 能否起来
unshare -Ur true; echo $?
qmcode sandbox linux -- true   # 子命令写法以节点上 `qmcode sandbox --help` 为准
```

本机已验证的部分（macOS，非节点）：该命令只监听 `127.0.0.1`；不带令牌的 WebSocket 升级请求返回 401；`/readyz` 返回 200；进程停止后端口释放。另外，每个新的 `QMCODE_HOME` 首次启动时会从 GitHub 克隆 `openai/plugins` 到 `.tmp/plugins`（本机约 89 MB），失败时改走 GitHub API，再失败走 `chatgpt.com` 的备份包（`core-plugins/src/startup_sync.rs`）。小内存、小磁盘的节点要把这项算进去；`[features] plugins = false` 能否关掉它，读代码是能（`core-plugins/src/manager.rs` 的 `maybe_start_curated_repo_sync_for_config` 以 `plugins_enabled` 为前提），未实测。

**第 3 项 会话跨机**

```sh
# 本机 → 节点：原样拷贝一份 rollout JSONL
scp ~/.qmcode/sessions/YYYY/MM/DD/rollout-*-<threadId>.jsonl <节点>:<QMCODE_HOME>/sessions/YYYY/MM/DD/
# 节点上经 WebSocket：initialize → initialized
#   → thread/resume {threadId, cwd: <节点工作目录>}
#   → thread/turns/list {threadId}   记录历史是否为空（paginated 投影尚未生成时）
#   → turn/start 问一个只有原会话里才有的事实，按 AC-H2 判是否命中
```

**第 4 项 Claude Code 会话导入**

```sh
# 改写 JSONL 每行的 cwd 为节点工作目录，放到 app-server 进程的 $HOME/.claude/projects/qianmo-import/
# 经 WebSocket：externalAgentConfig/import（SESSIONS 项 {path, cwd, title}）
#   → 等完成通知，取 successes[0].target 作 threadId
#   → thread/resume → turn/start，按 AC-H2 判；记录首个回合是否立即触发压缩
```

**第 5 项 远程直连**

```sh
# 另一台机器
ssh -N -L <本地端口>:127.0.0.1:<端口> <节点> &
QMCODE_REMOTE_TOKEN="$(ssh <节点> cat <令牌文件>)" \
  qmcode --remote ws://127.0.0.1:<本地端口> --remote-auth-token-env QMCODE_REMOTE_TOKEN
# 同时让节点桥（或本次的 WebSocket 驱动脚本）resume 同一线程；判据：两个连接都收到事件，界面输入被执行
```

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
2. **按内容判完整，短等待。** 以 notify 载荷的 `turn-id`（或 `turn/completed` 的 `turn.id`）为键，读到 `event_msg` 且 `payload.type` 为 `task_complete`（中断时为 `turn_aborted`）、`payload.turn_id` 相同的行，才算本回合已落盘。没读到就每 10 ms 重读，上限 2 s；超时仍按最后一个完整行同步，台账标「未完整」，下一次 notify 再补。本次实测需要的等待是 0 ms（4/4）。
3. **只同步到最后一个换行符。** 写入不是原子的，本次虽没见半行，规则上不依赖它。
4. **去抖用尾沿。** notify 即发即忘，回合紧挨着时会连续触发；计划里 5 s 去抖必须保证最后一个回合会被同步。
5. **`qm handoff now`**：回「可以关机」前，最近一个 `task_started` 必须已有同 `turn_id` 的 `task_complete` 或 `turn_aborted`，否则提示「回合进行中」。这是 AC-H1「会话记录已完整落地」在会话一侧的判据。
6. **P17.5 节点桥**：收到 `turn/completed` 后用同一判据，再把会话提交到 `refs/qianmo/sessions/cloud/<threadId>`。

## 对设计与工作包的影响（待回写）

本文只记结论，下列回写不在本次提交里做。

| 回写到 | 内容 |
|---|---|
| 计划 P17.1 卡、fork `QIANMO.md`（第 6、7 节） | 产物增加 `codex-code-mode-host`：`build-linux.sh` 与 workflow 编两个 bin，产物命名、`.sha256`、部署树 `qmcode/` 都按两个文件处理；完成标准加「带工具调用的 `qmcode exec` 跑通」。或者明确选第 1 项的目录覆盖作为绕过 |
| `handoff-m1.md` §2「要改的」第 2 条 | 改为「往上游已有的 `codex-rs/config/defaults.toml` 加两项」；补「用户关闭须写完整表」「用户自设 notify 会顶掉内置值」 |
| 计划 P17.3 卡（fork 部分） | `defaults.toml` 内容按第 6 项结论；顺带加 `check_for_update_on_startup = false`（`QIANMO.md` 待办）；节点是否加 `[features] plugins = false` 待实测；完成标准加「`qm handoff mcp` 可并发多实例」「`qm handoff sync` 不记录环境变量」 |
| 计划 P17.4 卡 | 第 7 项的 6 条规则：按 `turn_id` 判完整、10 ms / 2 s、截到最后一个换行、尾沿去抖、`now` 的「回合进行中」检查 |
| 计划 P17.5 卡 | 节点上的 qmcode 同样需要辅助二进制；`turn/completed` 后用同一判据；新 `QMCODE_HOME` 首次启动会从 GitHub 克隆约 89 MB 的插件目录 |
| 计划 §6 风险表 | 「网关不提供 Responses API」一行可关闭 |

## 未验证与存疑

- 第 2–5 项全部未做。
- 第 1 项：code mode 带真实执行输出的回传未测；effort 只测了 `low`、`max`；「生效」的依据是网关回显和 reasoning token 数的差别，不是回答质量评估。
- 第 6 项：没有重编二进制把两项真正写进 `defaults.toml`；MCP 与 notify 用的是替身低层，内置层本身的合并语义用它现有的 `[history]` 和 `project_root_markers` 证实。TUI 首次启动、`qmcode mcp remove qianmo` 对内置项的表现、`notify = []` 关闭，只读了代码。
- 第 7 项：只在空闲的 macOS 本机测了 4 个回合，Linux 节点与 gVisor 下的时序未测；中断回合（`turn_aborted`）、自动压缩后的写入未测。4 个回合里只有 1 个调了工具：run1 的第一回合模型没有尝试工具就回答「无法访问 data.txt」，上下文与 run2 相同，没有告警，属模型行为，不影响回合末时序的测量。
- 本机副作用：第 7 项第一次空跑时脚本有错（变量紧跟全角冒号），`config.toml` 写成了空文件，app-server 退回内置的 `openai` 提供方，向 `wss://api.openai.com/v1/responses` 发起约 10 次连接，均因无凭据返回 401；那次没有载入 key。每个新的 `QMCODE_HOME` 都克隆了一份 `openai/plugins`，证据目录因此约 682 MB。
- 观察：qmcode 的若干帮助文本仍写 `~/.codex/config.toml`、`Usage: codex exec`，属 P17.1 遗留的显示问题，不影响状态隔离。
