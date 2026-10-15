<!-- Copyright 2026 Qianmo AgentNest Team -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# 阡陌 AgentNest — 多底层、聊天渠道与前台调度设计（P27 ~ P31）

| 项 | 内容 |
|---|---|
| 文档版本 | **v1.1（生效）** |
| 日期 | 2026-10-15 |
| 核对基点 | 本仓库 `be15f741`（main，#226 合并提交，基座 qianmopi v18.8.8）；本机 Claude Code 2.1.296、`codex-cli 0.162.0` |
| 范围依据 | 负责人 2026-10-15 决定（对话记录）：① 参照格兰（Grantley）项目接入 QQ、微信、Telegram、Discord、Slack 等聊天软件；② 把专属电脑做完整；③ 底层不固定，默认 qianmopi，用户可为每个智能体选 Claude Code 或 Codex，多个底层可同时运行、各配各的模型并互相协作；④ 用户可设定时间检查更新、同步官方上游；⑤ 同日追加：把格兰的回复逻辑、主线程常驻、任务分派给子智能体、复用对话、加强缓存命中整套迁移过来 |
| 编号 | P27 ~ P31，另有 P21 补全；包表见 §8 |
| 结论一句话 | 节点上的智能体按配置在三种底层之一上运行，三者对常驻宿主呈现同一组回合信号；中枢新增渠道网关与任务调度，把格兰的一套对话与派活逻辑放在中枢，智能体经上行调用发起和汇报后台任务 |

由主 agent 按负责人 10-03 的常设委托（设计取舍自行裁定）定案。各节的「未评估」「未实测」是证据状态，不是授权门槛。

---

## §0 范围与口径

| 方向 | 编号 | 一句话 |
|---|---|---|
| 多底层并存与协作 | P27 | 每个智能体单独选底层（qianmopi / Claude Code / Codex）和模型；同一节点可以混用；智能体之间经后台任务互相派活 |
| 聊天渠道网关 | P28 | 中枢接入 QQ（QQ 开放平台机器人接口）、微信（iLink 机器人接口）、Telegram、Discord、Slack，消息进对应智能体的会话，回复送回原聊天 |
| 前台常驻与后台子智能体 | P29 | 主人私聊的主会话只做短对话与调度，耗时工作经 `qianmo_task_start` 交给后台子智能体（同一智能体的新会话，或名册里的另一个智能体），完成后回报原聊天 |
| 复用对话与缓存命中 | P30 | 一个聊天固定一条会话；外部底层保持热进程；系统提示按会话冻结；不常变的上下文块只在变化时重发；用量账本记录三种底层的缓存读写 |
| 定时检查更新 | P31 | 控制台设定检查时间；检查 qianmopi 上游、Claude Code、Codex 与阡陌自身的新版本；可选自动触发上游同步工作流、在节点上升级外部底层 |
| 专属电脑补全 | P21+ | 外部底层也能用专属浏览器 / 电脑工具；Linux 上加内存与进程数上限；在 Linux 容器里实测启动、操作与回收 |

**口径**（章程 N-9、§5.2③、§5.8、§7.2 第 8 条）：

- **一切原生化适配**（章程 v3.4 §7.2 第 8 条）：每个底层、模型服务和聊天平台都走对方官方的接口与协议，用对方原生的会话续接、缓存、压缩、审批回调、引用回复、线程、正在输入、富文本与长度规则；阡陌只在边界翻译一次，只补对方没有的身份、授权、隔离、调度、记账与审计。v1.1 据此把 QQ 从 OneBot（模拟 QQ 客户端的第三方实现）改为 QQ 开放平台官方机器人接口。

- Claude Code、Codex 以官方发行的命令行程序作为子进程运行，**不 fork、不改**；只用它们公开的非交互接口（Claude Code 的 `--print` 流式 JSON、Codex 的 `app-server`）。阡陌的成果是底层适配、隔离、授权、调度与审计。
- 外部底层**只用 API key 或自定义网关凭据**，凭据来自控制台模型服务；不读用户自己的 `~/.claude`、`~/.codex` 登录态，状态目录放在 `qianmoConfigPath('runtimes', …)` 下（`CLAUDE_CONFIG_DIR`、`CODEX_HOME`）。不使用订阅 OAuth 登录（L-6 不变）。
- 名称是指称性使用：阡陌与 Anthropic、OpenAI 无关联、未获背书（§5.2② 第 3 条）。
- 聊天软件只按各家公开文档或公开开源实现的协议事实实现；没有对真实账号跑过的渠道标「未评估」。微信个人号只走腾讯的 iLink 机器人接口（扫码授权），不做逆向协议、不做 hook。
- 格兰是负责人自有项目，逻辑迁移是自有代码的移植；实现按阡陌的结构重写，不逐行翻译。

---

## §1 P27 多底层并存与协作

### 1.1 选择

| 项 | 定案 |
|---|---|
| 粒度 | 每个智能体一种底层。`qm resident --agent <名>=<目录> --agent-runtime <名>=omp\|claude-code\|codex`，不写为 `omp` |
| 模型 | `--agent-model <名>=<模型档案号>/<模型号>`：从模型服务下发到节点的档案里取地址、密钥与模型。Claude Code 只接受 Anthropic 消息接口的档案（`anthropic` 通道）；Codex 只接受 Responses 接口的档案（`openai-responses` 通道）；qianmopi 不受限。不写时 qianmopi 跟随节点主模型，外部底层报「未配置模型」拒绝启动 |
| 程序位置 | `--claude-code-bin`（默认 `claude`）、`--codex-bin`（默认 `codex`）；P31 的节点升级把程序装到 `qianmoConfigPath('runtimes', 'bin')` 并优先使用 |
| 控制台 | 「智能体」页每个智能体显示底层与模型；运维改动经控制链路 `runtime.configure` 写节点的 `runtimes.json`，空闲时重启该智能体的子进程 |
| 并存 | 进程池按会话归属的智能体分流：qianmopi 会话走原有 `ResidentOmpPool`，外部底层走 `ExternalRuntimePool`；两池共用最大子进程数、空闲回收与排队上限 |

### 1.2 统一的回合信号

常驻回合端口（`@qianmo/resident` 的 `OmpTurnPort`）只读一小组帧：`prompt_result`、`message_end`、`message_update`、`tool_execution_start/end`。外部底层的通道把各自的事件翻译成这组帧，回合端口、看门狗、进度、用量、崩溃恢复都不改。

| 回合信号 | Claude Code（`claude -p --input-format stream-json --output-format stream-json`） | Codex（`codex app-server`，stdio JSON-RPC） |
|---|---|---|
| 发出一轮 | 写一行 `{"type":"user","message":…}` | `turn/start {threadId, input}` |
| 输入已接收 | 写入成功即补一条 user `message_end` | `turn/start` 应答即补 |
| 正文 | `assistant` 消息的文本块 → assistant `message_end` | `item/completed` 的 `agentMessage` → assistant `message_end` |
| 工具 | `tool_use` 块 → `tool_execution_start`；`tool_result`（`is_error`）→ `tool_execution_end` | `item/started` / `item/completed` 的 `commandExecution`、`fileChange`、`mcpToolCall` |
| 用量 | `result.usage` 的 `input_tokens`、`output_tokens`、`cache_read_input_tokens`、`cache_creation_input_tokens`（一轮一条） | `thread/tokenUsage/updated.total` 按轮取差：`inputTokens − cachedInputTokens`、`cachedInputTokens`、`outputTokens` |
| 结束 | `result`：`is_error` 为假 → `completed`（`stop_reason: max_tokens` → `length`），否则 `error` | `turn/completed`：`completed` / `interrupted`→`aborted` / `failed`→`error` |
| 中止 | 原生 `control_request {subtype: interrupt}`；5 秒内没有 `result` 才关子进程，下一轮按会话号续上 | `turn/interrupt` |
| 续会话 | `--session-id <会话号>` 首次、`--resume <会话号>` 之后 | `thread/start` 首次，`thread/resume` 之后；线程号记在会话目录 |
| 崩溃恢复 | `isAccepted` 读本池的输入登记文件 | 同左 |

### 1.3 工具与授权

- **宿主工具经 MCP 提供**：外部底层通过 `qm runtime-mcp` 这个 stdio MCP 服务拿到 `qianmo_*` 宿主工具（通知、记忆、任务、应用连接、文件申请、专属浏览器 / 电脑）。它把 `tools/list`、`tools/call` 逐行转给宿主的回环端点（`127.0.0.1` 随机端口，`host/runtimes/toolHost.ts`），每条带该会话的随机令牌；令牌写在会话目录的 `0600` 文件里，不上命令行，会话关闭即吊销。宿主按令牌找回智能体与会话，调用与 qianmopi 同一套处理函数（`host/hostToolDispatch.ts`）。
- **权限**：Claude Code 用 `--permission-prompt-tool mcp__qianmo__qianmo_permission`，它要征询的调用（工作目录外的读取、写入、shell）由宿主按常驻姿态裁决：允许、拒绝，或转成 P14 审批（只有可批准的越界写入）；`--safe-mode` 与 `--strict-mcp-config` 关掉用户与项目级定制（hooks、技能、插件、CLAUDE.md、MCP）；`--disallowedTools` 去掉派生子代理、定时、工作树、联网工具，未开 `--allow-workspace-edits` 时去掉编辑工具，未开 `--agent-shell` 时去掉 `Bash`。读取用它原生的 `Read`、`Grep`、`Glob`，原生只在工作目录内放行。Codex 线程以 `approvalPolicy: on-request`、`sandbox: workspace-write`（未开 `--allow-workspace-edits` 时 `read-only`）启动，`item/commandExecution/requestApproval` 与 `item/fileChange/requestApproval` 转成同一授权请求。授权请求体复用 `QIANMO_AUTHZ_V1` 的字段（`toolName`、`input`、`agent`）。
- **Codex 的 shell（原生化的例外）**：Codex 只能经 shell 读文件，它的沙箱限不住读取范围，所以常驻 Codex 智能体默认关掉 shell（`--disable shell_tool`、`unified_exec`），由宿主经 MCP 提供 `qianmo_read_file`、`qianmo_list_files`、`qianmo_search`，与 qianmopi 的 `read`、`grep`、`glob` 走同一个裁决。`--agent-shell <名>` 打开后 shell 回到 Codex 沙箱内执行，越过沙箱的请求一律拒绝；Claude Code 打开后每条命令都经审批。
- **隔离**：两种底层的子进程 cwd 是智能体工作区；环境只放白名单变量加凭据；`CLAUDE_CONFIG_DIR` / `CODEX_HOME` 在配置根下按智能体分开；关掉遥测与自动更新（`DISABLE_AUTOUPDATER`、`DISABLE_TELEMETRY`、`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`）。

### 1.4 协作

协作经 P29 的后台任务：任何智能体都可以 `qianmo_task_start {agent: "qianmo://<节点>/<智能体>"}` 把一件事交给名册里的另一个智能体，例如 qianmopi 主智能体把编码交给 Codex 智能体、把审查交给 Claude Code 智能体。中枢以任务创建者的身份开会话、驱动子任务直到它报告完成，再把结果送回发起的会话。不新增节点间直连。

---

## §2 P28 聊天渠道网关

### 2.1 接入方式

| 渠道 | 接口 | 连接方向 | 凭据 |
|---|---|---|---|
| QQ | QQ 开放平台机器人接口（v2）：AppID + AppSecret 换 access token；事件经官方推送，群 @、单聊用 `openid`，被动回复带原消息号 | 见 §2.1 注 | AppID 与 AppSecret |
| 微信 | 腾讯 iLink 机器人接口（`ilinkai.weixin.qq.com`）长轮询 `getupdates`、`sendmessage`；回复必须带对方最近一次的 `context_token` | 中枢拨出 | 控制台扫码登录得到的 bot token |
| Telegram | Bot API 长轮询 `getUpdates`、`sendMessage`、`sendChatAction` | 中枢拨出 | bot token |
| Discord | Gateway WebSocket（v10，`MESSAGE_CONTENT` intent）+ REST `channels/{id}/messages` | 中枢拨出 | bot token |
| Slack | Socket Mode（`apps.connections.open` 取 WebSocket 地址）+ Web API `chat.postMessage` | 中枢拨出 | app-level token（`xapp-`）与 bot token（`xoxb-`） |

除 QQ 外全部由中枢拨出，不开入站端口；QQ 按官方推荐的事件推送方式接入，回调挂在中枢已有的 HTTPS 控制台上，按官方签名校验，不另开端口。令牌按应用连接的信封加密存中枢（`consoleProvidersSecrets.ts` 的做法），页面只显示「已设置」。出站地址固定在各家官方域名，走 §7.2 的出站策略。

### 2.2 绑定与身份

一个渠道（`channelId`）对应一个机器人账号，配置：

| 字段 | 说明 |
|---|---|
| `owner` | 主人账号主体（控制台账号）。渠道上的对话以这个主体的身份派发，复用 `ChatDispatch.forSubject`，每次重新核对账号、角色、租户与对话白名单 |
| `ownerIds` | 主人在该平台上的用户号；主人私聊走 `owner` 通道 |
| `target` | 主人通道对话的智能体 `qianmo://<节点>/<智能体>` |
| `memberTarget` | 群聊与其他人私聊对话的智能体；空则不回应非主人 |
| `allowUsers` / `allowGroups` | 允许的私聊用户与群；`allowAll` 关闭名单 |
| `groupTrigger` | 群里何时回：`mention`（@ 或回复机器人，默认）、`all` |
| `replyWindowMs` | 回复窗口，默认 0（格兰 QQ 用 5000） |

主人通道与成员通道发到不同的智能体，这样成员通道可以挂一个没有 shell 与文件工具的智能体（格兰的 `member` 通道只给 MCP 工具）。

### 2.3 回复逻辑（迁自格兰 `gateway/core.py`）

- **会话键**：`<渠道号>:<dm|group>:<聊天号>[:<话题号>]`，对应控制台的一条对话会话，会话号存在渠道账本里，长期复用（P30）。
- **一会话一轮**：同一会话正在跑时新消息排队；私聊把排队的消息并成一轮；群聊按发言人合并，每个发言人保留第一次排队的位置，不同发言人不合并（格兰 `_Pending`）。
- **回复窗口**：`replyWindowMs > 0` 时同一发言人的连续消息在窗口内收齐再发。
- **群聊前缀**：群里每条消息前加 `[昵称(用户号)]`，合并时每行各带。
- **引用**：回复的是机器人自己的消息时加 `[在回复你之前说的："…"]`，否则 `[在回复 某人 的消息："…"]`，截 500 字。
- **命令**（只主人）：`/new` 换新会话、`/stop` 停止本轮并取消后台任务、`/status` 状态（模型、轮数、24 小时缓存命中）、`/model <名|default>`（本会话改用的方向或模型）、`/compact` 压缩、`/help`。成员发命令当普通文字。
- **静默**：回复是 `[SILENT]` 或空时不发。
- **附件**：回复里的 `MEDIA:<路径>` 行只在路径位于该智能体工作区的 `outbox/` 下时由中枢经文件取回后发出（中枢不读节点文件系统，走 P20 的发布与取回；首版只发文本，附件标「未实现」）。
- **失败**：主人通道的回合失败回一条简短说明；成员通道静默。
- **正在输入**：回合进行中每 4.5 秒发一次各平台的「正在输入」。
- **长消息**：按平台上限切块（QQ 4500、微信 2000、Telegram 4096、Discord 2000、Slack 3500 字），代码块不拆开。

### 2.4 落点

- 渠道协议：`atlas/packages/node/src/channels/{qq,weixin,telegram,discord,slack}.ts`，各自实现 `ChannelAdapter`（`start`、`stop`、`send`、`typing`）并把平台事件归一成 `ChannelMessage`。
- 网关：`atlas/packages/node/src/commands/consoleChannels.ts`（绑定、会话账本 `channels.json`、排队合并、命令、派发与回收回复）；控制台 `routes/channelsApi.ts`、「渠道」页。
- 回复的取得沿用定时任务的做法：发出后读会话记录，等到同一 `taskId` 的智能体终态回合；智能体中途的通知（`qianmo_notify`）也转发给主人。

---

## §3 P29 前台常驻与后台子智能体（迁自格兰 `tasks/`）

| 项 | 定案 |
|---|---|
| 谁是主线程 | 主人通道的私聊会话（以及控制台前台的会话）是「前台」：它常驻、保持即时响应，只做短对话、澄清、拆解与调度 |
| 派活 | 前台调 `qianmo_task_start {title, instructions, agent?}`：中枢新开一条子会话（不给 `agent` 时是同一智能体的新会话；给了就是名册里的那个智能体，可以是另一种底层），立即返回任务号，不等执行 |
| 子任务循环 | 中枢以创建者身份在子会话里一轮接一轮地发「继续」提示，直到子智能体 `qianmo_task_report {state: completed\|needs_input}`。提示里带任务说明、原始请求、父会话最近 6 条、持久检查点、上次中断、未读的追加指示（格兰 `_prompt`） |
| 追加与查询 | 前台 `qianmo_task_send` 追加指示（子任务下一轮先读 `qianmo_task_updates`）；`qianmo_task_status` 读真实阶段；`qianmo_task_cancel` 停止 |
| 完成判据 | 只有子智能体明确 `task_report(completed)` 且那一轮正常结束才算完成；有未读追加指示时拒绝完成报告 |
| 回报 | 完成或需要补充时，中枢把结果写进父会话（一条通知回合），并经渠道送回原聊天；发送结果记 `sent / failed / unknown`，结果未知不重发 |
| 状态问询 | 主人问「进度怎么样了」这类短句时，网关直接用任务状态回答，不占一轮（格兰 `_QUERY` 正则） |
| 持久化 | `tasks.json` 在中枢配置目录；重启后未结束的任务从检查点继续（先核实再接着做） |
| 名额 | 中枢对每个智能体最多并行 2 个子任务；前台回合不排在子任务后面（节点的回合闸门按会话分开） |
| 边界 | 子任务不能再开子任务；只能报告自己的任务；租户与对话白名单在每轮前复核 |

宿主工具 `qianmo_task_*` 由节点宿主注册，经上行调用 `tasks.*` 到中枢；调用带当前回合的 `contextId`，中枢据此找到对应的对话会话与任务，并核对调用智能体就是会话的对象。

前台的协调规则作为一个粘性上下文块随轮次送入（§4）：「你是保持即时响应的主智能体……需要工具执行、研究、多步或长时间工作的请求立即 `qianmo_task_start` 交给后台子智能体……只有子智能体报告 completed 才能说完成」，并附当前会话的任务摘要。

---

## §4 P30 复用对话与缓存命中

| 手段 | 做法 | 依据 |
|---|---|---|
| 一个聊天一条会话 | 渠道会话键 → 控制台会话号，长期复用；`/new` 才换 | 格兰 `sessions.py` |
| 热进程 | 外部底层每个活跃会话保持一个子进程（Claude Code 流式输入、Codex app-server 线程），空闲超时（默认 10 分钟，与 qianmopi 一致）后回收；下次以会话号续上 | 格兰 `warm.py` |
| 系统提示冻结 | 外部底层的附加系统提示在会话第一轮生成并写入会话目录，之后原样复用；Claude Code 加 `--exclude-dynamic-system-prompt-sections`，让机器相关段落进第一条用户消息、系统提示前缀稳定 | 格兰 `system_prompt_for` |
| 粘性上下文 | 网关的不常变块（渠道框定、前台协调规则）带指纹，只在变化、会话换新或每 40 轮时重发；只有该轮成功才记为已送达 | 格兰 `StickyContext` |
| 稳定工具面 | MCP 工具按名字排序注册，工具集不变时进程不重启 | 格兰 `WarmPool` 签名 |
| 记账 | 三种底层的用量都走 `message_end.usage`，用量账本照常算缓存命中率；`/status` 显示 24 小时命中率 | P18.19 |

---

## §5 P31 定时检查更新与上游同步

| 项 | 定案 |
|---|---|
| 设定 | 控制台「更新」页：检查时间（每天 HH:MM 或每周几 HH:MM，时区默认 Asia/Shanghai，可设多条）；每个来源各自的动作：只通知 / 自动处理 |
| 来源 | ① qianmopi 上游：GitHub `can1357/oh-my-pi` 最新发行 vs `atlas/upstream/omp.json` 的 pin；② Claude Code：npm `@anthropic-ai/claude-code` 的 `latest` vs 各节点报告的版本；③ Codex：npm `@openai/codex` 同上；④ 阡陌：GitHub 发行 vs 中枢运行的版本 |
| 自动处理 | ① 经仓库连接（P26 的 `repo` 类连接，令牌需 `actions:write`）触发 `sync-omp.yml` 工作流，产出同步草稿 PR，**不自动合并**（成果边界与评审规则不变）；②③ 经控制链路 `runtime.update` 让节点把指定版本装进 `qianmoConfigPath('runtimes','bin')`（`npm install --prefix`），装好后空闲时回收该底层的子进程；④ 只通知 |
| 记录 | 每次检查记一行（时间、来源、当前版本、最新版本、动作、结果），页面保留 100 行；有新版本时经 P24 的通知渠道推送 |
| 出站 | `api.github.com`、`registry.npmjs.org`；走 §7.2 出站策略 |

---

## §6 P21 专属电脑补全

| 项 | 定案 |
|---|---|
| 外部底层 | `qianmo_browser_*` / `qianmo_computer_*` 从扩展搬到宿主工具层，qianmopi 与外部底层共用同一套租约、审批、执行与审计；外部底层经 `qm runtime-mcp` 拿到。qianmopi 侧的扩展注册不变 |
| 资源上限 | Linux 上浏览器与显示进程经 `systemd-run --user --scope -p MemoryMax=<上限> -p TasksMax=256` 启动（没有 systemd 用户实例时退回 `prlimit --as`），默认 1.5 GiB，可按节点配；macOS 不设 |
| 实测 | 在 Linux 容器（本机 colima）里装 Xvfb、xauth、Chromium，跑开启 → 截图 → 导航 → 回收 → 目录已删 的整条链，结果写进验收记录 |

---

## §7 不做

- 不 fork、不修改 Claude Code 与 Codex；不读写用户自己的 `~/.claude`、`~/.codex`；不用订阅登录。
- 不自动合并上游同步 PR，不自动升级 qianmopi 基座本身（那是一次需评审的上游同步）。
- 不做微信个人号的逆向协议；企业微信与公众号本轮不做。
- 渠道附件收发本轮只做文本（图片、语音、文件留待节点出盒与取回打通）。

## §8 工作包

| 包 | 内容 | 主要文件 | 完成标准 |
|---|---|---|---|
| P27.0 | 本文、章程 v3.4、roadmap 回写 | `docs/dev/*` | 合入 |
| P27.1 | 外部底层通道与进程池 | `host/runtimes/*.ts` | 假 `claude`、假 `codex app-server` 脚本驱动的整轮测试：正文、工具进度、用量、失败、中止、续会话、崩溃恢复 |
| P27.2 | 宿主工具 MCP 桥与授权 | `host/runtimes/mcpBridge.ts`、`commands/runtimeMcp.ts` | MCP `tools/list` 与 `tools/call` 往返；未授权的工具调用转审批，拒绝时零副作用 |
| P27.3 | 常驻宿主接线与命令行 | `host/resident.ts`、`commands/resident.ts` | `--agent-runtime` 混用两种底层的节点在进程内跑通各一轮 |
| P28 | 渠道协议与网关 | `channels/*.ts`、`consoleChannels.ts`、控制台页 | 五种协议的夹具测试（入站归一、出站形状、切块）；网关排队合并、命令、静默、失败说明的单测；对话经假对话端口往返 |
| P29 | 后台任务 | `consoleTasks.ts`、`host/taskTools.ts` | 开任务、子任务多轮直到 completed、追加指示、取消、重启续跑、回报父会话与渠道 |
| P30 | 复用与缓存 | 网关、外部底层池 | 粘性块只在变化时重发；热进程复用；冻结系统提示；用量带缓存字段 |
| P31 | 定时检查更新 | `consoleUpdates.ts`、`host/runtimeUpdate.ts`、控制台页 | 按时区算下次检查；三类版本比较；触发工作流的请求形状；节点安装命令的参数 |
| P21+ | 专属电脑补全 | `host/desktop*.ts` | 外部底层能调浏览器工具；Linux 资源上限参数；容器实测记录 |
