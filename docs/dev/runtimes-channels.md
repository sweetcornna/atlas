<!-- Copyright 2026 Qianmo AgentNest Team -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# 阡陌 AgentNest — 多底层、聊天渠道与前台调度设计（P27 ~ P32）

| 项 | 内容 |
|---|---|
| 文档版本 | **v1.6（生效）**；v1.6 按 P21+ 落地与 Linux、macOS 实测回写 §6.3、§6.5–§6.7；v1.5 改写 §6（专属电脑补全：外部底层共用执行器、参照 Codex computer use 的人类式操作、私有桌面隔离、自主确认、macOS 按应用授权）；v1.4 新增 §9 P32 扩展（连接器、技能与插件由用户自配置）；v1.2 按 P28 落地回写 §2（QQ 改官方 WebSocket 网关、各平台格式与正在输入、控制台入口）；v1.3 按 P31 落地回写 §5，新增 §5.2 阡陌自身的优雅升级（复刻 sub2api） |
| 日期 | 2026-10-15（v1.5、v1.6 于 2026-10-17） |
| 核对基点 | 本仓库 `be15f741`（main，#226 合并提交，基座 qianmopi v18.8.8）；本机 Claude Code 2.1.296、`codex-cli 0.162.0` |
| 范围依据 | 负责人 2026-10-15 决定（对话记录）：① 参照格兰（Grantley）项目接入 QQ、微信、Telegram、Discord、Slack 等聊天软件；② 把专属电脑做完整；③ 底层不固定，默认 qianmopi，用户可为每个智能体选 Claude Code 或 Codex，多个底层可同时运行、各配各的模型并互相协作；④ 用户可设定时间检查更新、同步官方上游；⑤ 同日追加：把格兰的回复逻辑、主线程常驻、任务分派给子智能体、复用对话、加强缓存命中整套迁移过来；⑥ 同日追加：参照 sub2api 的优雅升级，把那套逻辑复刻到阡陌自身；⑦ 同日追加：让阡陌支持连接器的接入和技能、插件的加入，用户可自己配置，MCP 也自配置 |
| 编号 | P27 ~ P32，另有 P21 补全；包表见 §8 |
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
| 扩展自配置 | P32 | 用户在控制台给智能体装 MCP 连接器、技能与插件；中枢封存秘密、钉住来源，节点按三种底层各自的原生方式加载 |
| 专属电脑补全 | P21+ | 外部底层也能用专属浏览器 / 电脑工具；参照 Codex computer use 像人一样操作电脑（批量动作、按键组合、拖拽、窗口与无障碍树、打开应用）；私有桌面隔离与内存上限；在 Linux 容器里实测 |

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
| 程序位置 | `--claude-code-bin`（默认 `claude`）、`--codex-bin`（默认 `codex`）；P31 的节点升级把程序装到 `qianmoConfigPath('runtimes', 'npm')` 并优先使用（启动参数指定了路径的不管） |
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
- **权限**：Claude Code 用 `--permission-prompt-tool mcp__qianmo__qianmo_permission`，它要征询的调用（工作目录外的读取、写入、shell）由宿主按常驻姿态裁决：允许、拒绝，或转成 P14 审批（只有可批准的越界写入）；`--permission-mode default` 让规则外的调用都经这个工具问节点（2.1.301 不指定时是 `auto`，由它自己的分类器决定、不调提示工具）。定制只来自节点：`--setting-sources user` 只读 `CLAUDE_CONFIG_DIR`（节点按智能体管的目录），项目级 `.claude/`、CLAUDE.md、钩子与 `.mcp.json` 都不加载；`--settings {"disableAllHooks":true}` 关掉插件自带的钩子，`CLAUDE_CODE_DISABLE_AUTO_MEMORY` 关掉自动记忆；`--strict-mcp-config` 只用节点给的 `--mcp-config`。（2.1.301 的 `--safe-mode` 连 `--mcp-config` 也不加载，`--bare` 只剩 Read / Edit 且看不到插件技能，两者都不用。）`--disallowedTools` 去掉派生子代理、定时、工作树、联网工具，未开 `--allow-workspace-edits` 时去掉编辑工具，未开 `--agent-shell` 时去掉 `Bash`。读取用它原生的 `Read`、`Grep`、`Glob`，原生只在工作目录内放行。Codex 线程以 `approvalPolicy: on-request`、`sandbox: workspace-write`（未开 `--allow-workspace-edits` 时 `read-only`）启动，`item/commandExecution/requestApproval` 与 `item/fileChange/requestApproval` 转成同一授权请求。授权请求体复用 `QIANMO_AUTHZ_V1` 的字段（`toolName`、`input`、`agent`）。
- **Codex 的 shell（原生化的例外）**：Codex 只能经 shell 读文件，它的沙箱限不住读取范围，所以常驻 Codex 智能体默认关掉 shell（`--disable shell_tool`、`unified_exec`），由宿主经 MCP 提供 `qianmo_read_file`、`qianmo_list_files`、`qianmo_search`，与 qianmopi 的 `read`、`grep`、`glob` 走同一个裁决。`--agent-shell <名>` 打开后 shell 回到 Codex 沙箱内执行，越过沙箱的请求一律拒绝；Claude Code 打开后每条命令都经审批。
- **隔离**：两种底层的子进程 cwd 是智能体工作区；环境只放白名单变量加凭据；`CLAUDE_CONFIG_DIR` / `CODEX_HOME` 在配置根下按智能体分开，Codex 的 `HOME` 也指到 `CODEX_HOME` 下节点自己的目录（Codex 还会从 `~/.agents/` 读技能与插件，本机的那份属于运行账号）；关掉遥测与自动更新（`DISABLE_AUTOUPDATER`、`DISABLE_TELEMETRY`、`DISABLE_ERROR_REPORTING`、`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`）。
- **升级先过兼容检查**：`runtime.update` 把新版本先装进临时前缀，用节点自己的启动参数、真实的 `qm runtime-mcp` 与本机假模型接口跑一遍：Claude Code 的 init 要列出已连上的 qianmo 服务与工具，假模型发起的 qianmo 工具调用要到达节点并完成回合；Codex 的 app-server 要列出 qianmo 服务与工具。不通过就不换进托管前缀，节点继续用原版本，答复里写明原因。

### 1.4 协作

协作经 P29 的后台任务：任何智能体都可以 `qianmo_task_start {agent: "qianmo://<节点>/<智能体>"}` 把一件事交给名册里的另一个智能体，例如 qianmopi 主智能体把编码交给 Codex 智能体、把审查交给 Claude Code 智能体。中枢以任务创建者的身份开会话、驱动子任务直到它报告完成，再把结果送回发起的会话。不新增节点间直连。

---

## §2 P28 聊天渠道网关

### 2.1 接入方式

| 渠道 | 接口 | 连接方向 | 凭据 |
|---|---|---|---|
| QQ | QQ 开放平台机器人接口（v2）：AppID + AppSecret 换 access token；官方 WebSocket 网关（`/gateway`，鉴权、续连、心跳），单聊 `C2C_MESSAGE_CREATE`、群 @ `GROUP_AT_MESSAGE_CREATE`；被动回复带原消息号与递增 `msg_seq` | 中枢拨出 | AppID 与 AppSecret |
| 微信 | 腾讯 iLink 机器人接口（`ilinkai.weixin.qq.com`）长轮询 `getupdates`、`sendmessage`；回复必须带对方最近一次的 `context_token` | 中枢拨出 | 控制台扫码登录得到的 bot token |
| Telegram | Bot API 长轮询 `getUpdates`、`sendMessage`、`sendChatAction` | 中枢拨出 | bot token |
| Discord | Gateway WebSocket（v10，`MESSAGE_CONTENT` intent）+ REST `channels/{id}/messages` | 中枢拨出 | bot token |
| Slack | Socket Mode（`apps.connections.open` 取 WebSocket 地址）+ Web API `chat.postMessage` | 中枢拨出 | app-level token（`xapp-`）与 bot token（`xoxb-`） |

五种渠道全部由中枢拨出，不开入站端口。平台返回的连接地址（Discord、Slack、QQ 的 WebSocket，微信扫码时的重定向主机）必须在该平台官方域名下，否则不连。QQ 官方若日后只保留回调推送，再在中枢控制台上加签名校验的回调入口。凭据用应用连接的保险箱（`connectors/secrets.ts`）密封后存在中枢，接口与页面只给「已设置」；不是运维的读者连主人号、放行名单与平台设置也看不到。

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
- **命令**（只主人）：`/new` 换新会话、`/stop` 停止本轮（中枢经签名控制链路发 `turn.stop`，节点按任务找到回合，交给底层原生中止）、`/status` 状态（智能体、会话、轮数、方向、排队数）、`/model <方向|default>`（本会话改用的模型方向）、`/compact` 压缩（走对话面的本地命令）、`/help`。成员发命令当普通文字，`/help` 除外。
- **粘性说明**：「这段对话来自哪个平台的私聊或群、对方是不是主人、格式怎么写、不回就答 `[SILENT]`」与运营写的渠道说明只在会话第一轮、内容变了、`/new`、`/compact` 或节点报告本轮底层自动压缩之后、以及每 40 轮发一次；按指纹记，回合成功才算送达（格兰 `sticky_context.py`，P30）。
- **静默**：回复是空、`[SILENT]`、`NO_REPLY` 等标记（允许两边带标点）时不发；正文里提到标记不算。
- **附件**：入站的图片、文件写成一行说明交给智能体；回复里的 `MEDIA:<路径>` 行删掉，主人通道补一句「渠道暂不转交附件」。附件收发等节点出盒与取回（P20）打通后再做。
- **失败**：主人通道的回合失败回一条简短说明（超时与中断分开说）；成员通道静默；`/stop` 停下的回合不再报失败。智能体中途的通知只转给主人通道。
- **去重**：同一渠道同一消息号 5 分钟内只处理一次（平台重投）。
- **正在输入**：回合进行中每 4.5 秒触发一次，各平台用自己的方式并各自限频：QQ 只有单聊（`msg_type` 6，60 秒一次）、微信用 `getconfig` 给的票据调 `sendtyping`、Telegram `sendChatAction`、Discord 频道 typing 接口、Slack `assistant.threads.setStatus`（应用没有该权限就不再请求）。
- **格式**：Telegram 转 MarkdownV2，被拒时同一段文字改纯文本重发；Slack 转 mrkdwn；Discord 原样；QQ 与微信转纯文本。表格一律改成「标题 + 条目」。
- **话题**：Telegram 论坛话题与 Slack 线程各自是一个会话；Slack 频道里的顶层消息开一个线程，回复进线程。
- **长消息**：按平台上限切块（QQ 3000、微信 1800、Telegram 3500、Discord 1900、Slack 3500，按 UTF-16 计），代码块跨块时先闭合再在下一块以同一语言重开，多块带 `(i/n)`。

### 2.4 落点

- 渠道协议：`atlas/packages/node/src/channels/{qq,weixin,telegram,discord,slack}.ts`，各自实现 `ChannelAdapter`（`start`、`stop`、`send`、`typing`、`health`）并把平台事件归一成 `ChannelInbound`；断线按 2、5、10、30、60 秒退避重连，凭据被拒、机器人被封等不可恢复的错误停在「失败」并写明原因。
- 回复逻辑：`channels/gateway.ts`（准入、排队合并、回复窗口、粘性说明、命令、静默、失败说明、切块）；文本规则 `channels/text.ts`。
- 中枢：`commands/consoleChannels.ts`（渠道账本 `channels.json`、密封凭据、会话映射与游标 `state.json`、单实例锁，目录 `qianmoConfigPath('qianmo','console','channels')`）；`qm console --channels` 开启，须同时接了对话面。
- 控制台：「渠道」页 `/admin/im`（`routes/im.ts`），接口 `/v0/im`（`routes/imApi.ts`），写操作只给运维个人账号并记 `im.save` / `im.remove` / `im.login`。微信在页面上扫码：中枢取二维码并在后台轮询（二维码由服务端画成内联 SVG，`console/src/qr.ts`），确认后把 bot token 密封进渠道，扫码的人记为主人。
- 回复的取得沿用定时任务的做法：发出后读会话记录，等到同一 `taskId` 的智能体终态回合；智能体中途的通知（`qianmo_notify`）也转发给主人。
- 证据状态：五个平台都只用脚本化的假网络测过（请求形状、帧、归一、切块、重连），没有用真实账号跑过，页面与接口一律标「未评估」。

---

## §3 P29 前台常驻与后台子智能体（迁自格兰 `tasks/`）

| 项 | 定案 |
|---|---|
| 谁是主线程 | 控制台对话（人在 `/` 上与智能体的会话）和渠道里主人的私聊是「前台」：它常驻、保持即时响应，只做短对话、澄清、拆解与调度。渠道的群聊与其他人的私聊不能开任务 |
| 派活 | 前台调 `qianmo_task_start {title, instructions, agent?}`：中枢新开一条子会话（不给 `agent` 时是同一智能体的新会话；给了就是名册里的那个智能体，可以是另一种底层、另一种模型），立即返回任务号，不等执行 |
| 子任务循环 | 中枢以前台会话主人的身份在子会话里一轮接一轮地发提示，直到子智能体 `qianmo_task_report {state: completed\|needs_input}` 且那一轮正常结束。提示首行是「后台任务：标题（编号）」。规则与任务说明在首轮（节点接下才算送达）、重启续跑、换会话、底层压缩之后和每 10 轮发一次；主会话最近 6 条去掉渠道框定、渠道说明、协调规则与任务附注，超长留结尾 1500 字，只在首次交代与压缩后带；其余轮次只带变了的检查点、上一轮异常或重启后的「先核实」与上次中断、未落定的报告、未读追加指示的编号与条数（格兰 `_prompt`）。子任务每轮只推进一个阶段，汇报后结束本轮 |
| 追加与查询 | 前台 `qianmo_task_send` 追加指示（子任务先 `qianmo_task_updates` 读取）；`qianmo_task_status` 读真实阶段；`qianmo_task_cancel` 停止（中枢经 `turn.stop` 中止子会话正在跑的一轮） |
| 完成判据 | 只有子智能体明确报告 completed 且那一轮正常结束才算完成；有未读追加指示时拒绝完成或提问的报告；已读的指示随下一次报告一起确认 |
| 防空转 | 子任务连续 5 轮正常结束却没有汇报新的进展（没汇报或每轮同一句），暂停为「等待你的补充」；连续 10 轮失败同样暂停并说明最近的错误。失败后按 2、4、8 … 60 秒退避重试。这两条是格兰没有的保护，避免一个不汇报的子任务一直消耗额度。账号失效、目标不在可拨名单、额度用完这类拒绝直接暂停并写明原因；追加指示立刻叫醒退避中的任务 |
| 回报 | 完成或需要补充时，中枢在父会话写一条「后台任务」通知（`ChatPort.note`，不经过节点、不算一轮），父会话是渠道对话时同时发回原聊天；按投递目标分别记 sent / failed / unknown / skipped；失败的一路按 1、4、16、30 分钟最多重发到第 5 轮，渠道适配器启动后立刻补发；重启时正在发送的那一路记 unknown，不重发 |
| 状态问询 | 渠道里主人发「进度怎么样了」「好了没」这类整句短问时，有未结束的任务就由网关直接用任务状态回答，不占一轮；没有时只在任务 10 分钟内刚结束且前台没在跑一轮时这样回答（格兰 `_QUERY`、`_NUDGE`）；`/stop` 同时取消这个聊天的后台任务（`/new` 之后、新会话开出之前也算），`/new` 只停本轮、换会话，任务继续跟着这个聊天 |
| 持久化 | `qianmoConfigPath('qianmo','console','tasks')/tasks.json`（0600，单实例锁）：任务、检查点、追加指示与已读位置；重启后未结束的任务在原子会话里续跑，提示里要求先核实再接着做。已结束且投递完的任务保留 30 天、每主人最多 200 条，已确认与已结束任务的追加指示清掉 |
| 名额 | 每个节点同时只有 1 个子任务回合在途，其余排队（阶段显示「排队中」），放出名额时直接交给排队的下一个。节点所有回合共用一个串行闸门，闸门空出来时先取交互回合、后取后台回合，不抢占；后台标记写在中枢签名的 task.request 里，没签或验不过当交互回合。子任务每轮期限默认 30 分钟（审批期限随之），到点节点原生中止这一轮（与 /stop 同路），10 秒内结束后回 E_TASK_TIMEOUT；普通回合不变 |
| 边界 | 子任务不能再开或管理任务；只能汇报自己的任务；每次调用中枢都核对：会话的对象就是调用的智能体、调用来自这条会话里还在等回答的那一轮；每轮派发都过 `ChatDispatch`（租户、白名单、额度、审计）。定时任务（P24）的会话不能开任务，会被拒绝并说明原因 |

宿主工具 `qianmo_task_*`（`host/taskTools.ts`）由节点宿主注册，六个始终都提供，工具面不随轮次变化；调用经上行 `tasks.*` 到中枢（`commands/consoleTasks.ts`），带当前回合的会话号（`contextId`）与任务号，中枢据此判断调用者是前台还是子任务。需要控制链路（`--control`），对话面开启时随之启用。

前台的协调规则在渠道里作为粘性块送入（只在第一轮、变化、换会话、压缩后与每 40 轮重发），当前会话的任务摘要作为附注，只带未结束的与上次附注之后新结束的，内容没变不发；回合成功才算送达，压缩或 /new 之后重发（不进粘性块，避免频繁变化打断缓存前缀）。控制台「主动执行」页列出后台任务，发起人或运维可以取消。控制台网页对话的前台靠工具说明获知同样的规则。

---

## §4 P30 复用对话与缓存命中

| 手段 | 做法 | 依据 |
|---|---|---|
| 一个聊天一条会话 | 渠道会话键 → 控制台会话号，长期复用；`/new` 才换 | 格兰 `sessions.py` |
| 热进程 | 外部底层每个活跃会话保持一个子进程（Claude Code 流式输入、Codex app-server 线程），空闲超时（默认 10 分钟，与 qianmopi 一致）后回收；下次以会话号续上 | 格兰 `warm.py` |
| 系统提示冻结 | 外部底层的附加系统提示在会话第一轮生成并写入会话目录，之后原样复用；Claude Code 加 `--exclude-dynamic-system-prompt-sections`，让机器相关段落进第一条用户消息、系统提示前缀稳定 | 格兰 `system_prompt_for` |
| 粘性上下文 | 网关的不常变块（渠道框定、前台协调规则）带指纹，只在变化、会话换新或每 40 轮时重发；只有该轮成功才记为已送达 | 格兰 `StickyContext` |
| 稳定工具面 | 宿主工具（含后台任务六件）始终全部提供、顺序固定，工具集不变时进程不重启 | 格兰 `WarmPool` 签名 |
| 记账 | 三种底层的用量都走 `message_end.usage`，用量账本照常算缓存命中率；渠道 `/status` 显示渠道主人当日（东八区）的缓存命中率 | P18.19 |

---

## §5 P31 定时检查更新与上游同步

### 5.1 定时检查

| 项 | 定案 |
|---|---|
| 设定 | 控制台「更新」页（`/admin/updates`，管理组）：检查时间（每天或每周几的 HH:MM，可设多条，时区默认 Asia/Shanghai）；每个来源各自的动作：只通知 / 自动处理；有新版本时推送到哪些通知渠道（P24 的平台级渠道）；阡陌所在的 GitHub 仓库。开关 `qm console --updates`，状态在 `qianmoConfigPath('qianmo','console','updates')`；中枢停机错过的检查在下次启动时补跑一次 |
| 来源 | ① qianmopi 上游：GitHub `can1357/oh-my-pi` 最新发行 vs 中枢运行的 qianmopi 版本；② Claude Code：npm `@anthropic-ai/claude-code` 的 `latest` vs 各节点 `runtime.versions` 报告的版本；③ Codex：npm `@openai/codex` 同上；④ 阡陌：所设仓库的最新发行 vs 中枢与各节点 `system.version` 报告的版本，同时记下最近三个更旧的发行供回滚 |
| 自动处理 | ① 经仓库连接（P26 的 `repo` 类连接，令牌需 `actions:write`）触发 `sync-omp.yml` 工作流，产出同步草稿 PR，**不自动合并**（成果边界与评审规则不变）；②③ 经控制链路 `runtime.update` 让节点把指定版本装进 `qianmoConfigPath('runtimes','npm')`（`npm install --prefix`，缓存与配置也在其下），新子进程用新版，启动参数指定了路径的节点不动；④ 逐台升级阡陌（§5.2） |
| 只处理一次 | 每个来源记住已通知或已自动处理过的最新版本；同一版本之后的检查照样记一行，不再推送、不再触发 |
| 记录 | 每次检查每个来源记一行（时间、来源、当前版本、最新版本、结果、说明），保留 100 行；升级或回滚作业结束时另记一行并推送 |
| 出站 | `api.github.com`、`registry.npmjs.org` 与 GitHub 的发行下载域；走 §7.2 出站策略 |

### 5.2 阡陌自身的优雅升级（复刻 sub2api）

sub2api（`Wei-Shaw/sub2api`，2026-10-15 读其 `update_service.go`、`system_handler.go`、`sysutil/restart.go` 与前端 `VersionBadge.vue`）的在线升级是：查 GitHub 发行 → 只从 GitHub 域下载本平台包 → 按发行里的校验和核对 SHA-256 → 在可执行文件同目录暂存解包（防路径穿越、限大小）→ 改名原子替换并留 `.backup` → 先回应答再优雅退出、由 systemd `Restart=always` 拉起 → 前端倒计时、轮询健康后刷新；另有全局系统操作锁、请求幂等、回滚到备份或最近三个更旧的发行。阡陌逐条照做，按自己的部署形状改三处：

| 步骤 | 阡陌的做法 | 与 sub2api 的不同 |
|---|---|---|
| 发行包 | 发行发布时 `fleet-payload.yml` 按标签版本构建（`linux-build.sh --release`，`qm --version` 报这个版本），把载荷作为 `qianmo-<版本>-linux-x64.tgz` 连同 `.sha256` 挂到发行上；手工发行也可在 `SHA256SUMS` 里列出 | sub2api 用 goreleaser 的 `checksums.txt` |
| 下载 | 只走 `api.github.com`、`github.com`、`objects.githubusercontent.com`、`release-assets.githubusercontent.com` 与 HTTPS，每一跳都核对，跨域时去掉令牌；包上限 400 MB；公开仓库不需要令牌，私有仓库用仓库连接的令牌 | 同 |
| 核对 | SHA-256 对上发行记录；`tar -tzf` 先查成员名（只许相对路径、不许 `..`、只许 `dist/` 与 `demo/`），解开后再拒符号链接、硬链接与特殊文件；最后跑新程序 `--version`，必须报目标版本 | 多了新程序自报版本这一道 |
| 暂存 | 在部署树里 `.qianmo-upgrade-*` 暂存（同一文件系统，替换是改名）；**先清后装**：空间不够先删旧备份，仍不够就拒绝、一个字节不动 | 沿用 `beta-deploy.sh` 的先清后装 |
| 排空 | 节点先停止接新活（与急停同一处闸门：收件拒绝、领取暂停），等在途回合、排队、投递全部做完，默认最多 10 分钟；超时就取消升级、恢复接活，原程序照常运行 | sub2api 不排空，替换后立即可重启 |
| 替换 | `dist`、`demo` 改名为 `<名>.bak-upgrade`，新的改名进来；任一步失败把已改的改回去；只留一份备份，记下备份里的版本 | 同（`.backup`） |
| 重启 | 走进程原有的 SIGTERM 停机路径；事件循环清空后 `execve` 新程序，**同一进程号、同样的参数和环境**，舰队脚本按进程号记录的身份仍然对得上；停机 60 秒没收尾就以 75 退出交给 systemd `Restart=` | sub2api 退出后靠 systemd 拉起；舰队的单元是 oneshot、不拉起崩溃进程，所以改成原地换映像 |
| 编排 | 中枢经控制链路 `system.upgrade` 让节点逐台升级，轮询 `system.version` 等它以新版本回来（最多 30 分钟）再下一台；一台失败就停、不再往下推；中枢自己最后升级。同一部署树上的另一个进程发现盘上已是目标版本就只重启 | sub2api 只有单个服务 |
| 回滚 | 不给版本：各台把备份与现役互换（再回滚一次就是回到新版）；给版本：只许最近三个更旧的非预发行版本，走同一条下载核对替换路径 | 同 |
| 并发 | 每棵部署树一把升级锁（`.qianmo-upgrade.lock`，持有进程活着且不超过一小时才算持有）；控制链路上的 `system.upgrade` / `system.rollback` 走节点的幂等账本 | sub2api 用数据库里的全局操作锁 |
| 页面 | 「更新」页「阡陌升级」：中枢与各节点版本、升级到最新发行、回滚（本机备份或三个旧发行）、逐台进度；页面跟着作业轮询，中枢重启期间的失败请求视为正常，作业结束后自动刷新 | 同 |

源码运行（不是 `dist/qm-<平台>` 编译件）的进程报「不能在线升级」，作业里记为跳过。没有用真实发行跑过整套在线升级，证据状态为未评估。

## §6 P21+ 专属电脑补全与像人一样操作

负责人 2026-10-17：「把自主电脑……接入开发完全完成」「学习 codex 的 computer use，agent 要能操纵电脑的一切以及像人一样操纵电脑」。本节 v1.5 改写，取代 v1.4 的三行定案。

### 6.1 外部底层也能用

| 项 | 定案 |
|---|---|
| 执行器 | 参数核对 → 租约 → 观察 → 审批 → 复核 → 提交 → 执行 → 回执这条链收进 `extension/src/desktopExec.ts` 的 `DesktopExecutor`，三种底层共用；租约与审批的裁决仍只在宿主的 `NodeDesktop.decide` |
| qianmopi | 扩展照旧注册工具，经 omp 的界面请求（`QIANMO_AUTHZ_V1` 的 `input` / `confirm`）问宿主 |
| Claude Code、Codex | 工具经 `qm runtime-mcp` 列出与调用；宿主为每个用到专属电脑的会话起一个 `qm desktop-exec` 子进程执行（按需启动、随会话关闭），子进程的环境带该智能体私有显示的 `DISPLAY`、`XAUTHORITY`。基座的电脑后端按进程环境选显示，宿主同时服务多个智能体，所以执行不放在宿主进程里 |
| 调用编号 | MCP 的 `tools/call` 不带模型服务的调用编号，宿主为每次调用生成一个 |
| 工具面 | 只在对应单元运行时列出；开关、回收经 `changed` 回收该智能体的空闲会话，下个会话拿到新工具面（与 qianmopi 一致） |
| 结果 | MCP 结果可带图片（截图），`qm runtime-mcp` 原样转出 |

### 6.2 像人一样操作（参照 Codex computer use）

Codex 的做法（OpenAI computer use 指南与本机 `codex-cli 0.163.0`，2026-10-17 读）：一次调用带一串动作（点击、双击、拖拽、移动、滚动、按键组合、输入、等待、截图），执行完回一张截图；动作在隔离的浏览器或桌面里执行；确认按后果分级（必须交还给人、执行时确认、可预先授权、无需确认），不是每次点击都问；本机桌面按应用授权（macOS 的 bundle id、Windows 的可执行文件）。阡陌照这四点做，能力全部来自基座 `computer` 前导（`call` 链，`eval` 继续禁用）：

| 工具 | 参数 | 类别 |
|---|---|---|
| `qianmo_computer_screenshot` | `window?` | 观察 |
| `qianmo_computer_zoom` | `x`、`y`、`width`、`height`、`window?` | 观察：放大一块区域，坐标仍按整屏截图 |
| `qianmo_computer_windows` | — | 观察：窗口编号、应用、标题、位置、是否在前 |
| `qianmo_computer_observe` | `window` | 观察：窗口截图加无障碍树（`[ref=eN]`）；需要无障碍总线 |
| `qianmo_computer_apps` | — | 观察：这台电脑上允许打开的应用 |
| `qianmo_computer_clipboard_read` | — | 观察 |
| `qianmo_computer_actions` | `actions`（1–20 个）、`window?`、`confirm?` | 操作：按序执行，任一步失败即停，最后回一张截图 |
| `qianmo_computer_click` | `x`、`y`、`button?`、`count?`、`keys?`、`window?`、`confirm?` | 操作 |
| `qianmo_computer_type` | `text`、`window?`、`confirm?` | 操作 |
| `qianmo_computer_key` | `key`（组合键如 `ctrl+c`）、`window?`、`confirm?` | 操作 |
| `qianmo_computer_scroll` | `x`、`y`、`dx`、`dy`、`window?`、`confirm?` | 操作 |
| `qianmo_computer_focus` | `window`、`confirm?` | 操作：窗口提到最前 |
| `qianmo_computer_element` | `ref`、`action`（`press` / `click` / `focus` / `set_value`）、`value?`、`confirm?` | 操作：对无障碍树里的元素 |
| `qianmo_computer_menu` | `window`、`path`（菜单路径）、`confirm?` | 操作 |
| `qianmo_computer_open_app` | `app`（`qianmo_computer_apps` 给的编号）、`confirm?` | 操作 |
| `qianmo_computer_clipboard_write` | `text`、`confirm?` | 操作 |

`actions` 的每一项：`click {x, y, button?, count?, keys?}`、`double_click {x, y, keys?}`、`move {x, y}`、`drag {path: [[x, y], …]（2–50 点）, keys?}`、`scroll {x, y, dx, dy}`、`type {text}`、`keypress {keys}`（1–5 个键，一起按下）、`hold_keys {keys, seconds}`、`hold_mouse {x, y, button?, seconds}`、`wait {ms}`；按住不超过 10 秒，一批里等待与按住合计不超过 30 秒。坐标按最近一次整屏（或该窗口）截图。按键名用基座的写法（`ctrl`、`shift`、`alt`、`super`、`enter`、`f5`、字母数字等）。v1.4 只许导航键，是因为快捷键能在显示之外启动程序；私有桌面经 §6.3 隔离后放开，macOS 本机桌面另按 §6.5 限制。

浏览器单元的 `qianmo_browser_*` 不变。

### 6.3 私有桌面会话（Linux）

| 项 | 定案 |
|---|---|
| 组成 | Xvfb（1440×900×24、`-nolisten tcp`、独立 Xauthority）→ 可选的私有 D-Bus 会话总线与无障碍总线（节点装有 `dbus-daemon`、`at-spi-bus-launcher` 时）→ 窗口管理器（按序取第一个装了的：openbox、xfwm4、fluxbox、icewm、matchbox-window-manager；都没有也能用，只是窗口没有边框）→ 同时开浏览器与电脑时 Chromium 在这块显示上有头运行（只开浏览器仍是无头）→ `qianmo_computer_open_app` 打开的应用。全部记在资源的进程表里，停用、回收一起结束 |
| 隔离 | Xvfb 以外的进程都在 bubblewrap 里运行：根目录只读，`/tmp` 换成私有的（只读挂回 X 套接字目录），节点用户的家目录、阡陌配置根、常驻守卫的保护目录与记忆目录、`/run/user` 都换成空目录，存在时 `docker.sock` 用 `/dev/null` 盖住，只把该智能体的桌面目录（家目录、下载、浏览器资料）可写地挂回；`--clearenv` 后只给白名单环境（显示、私有总线、XDG 目录、无障碍开关，代理变量只给 Chromium）；`--unshare-user`、`--unshare-pid`、`--unshare-ipc`、`--die-with-parent`、`--new-session`；网络与节点共用。智能体工作区只读挂入，节点开了 `--allow-workspace-edits` 时可写，与常驻姿态一致。Chromium 自身的沙箱保持开启；有头起不来时退回无头并写明原因 |
| 没有 bubblewrap | 电脑照样开（Xvfb 与窗口管理器，不起总线），但打开应用一律拒绝，Chromium 保持无头；状态 `confined: false`，页面写明原因「需要 bubblewrap」（含 Ubuntu 24.04 的 `kernel.apparmor_restrict_unprivileged_userns`）。bubblewrap 与 `systemd-run` 在第一次开启时各探测一次 |
| 应用 | 只认系统应用目录（`/usr/local/share/applications` 优先、`/usr/share/applications`）里的桌面条目，跳过 `NoDisplay` / `Hidden` / 程序不存在的；`Exec` 去掉占位符后由宿主在 bubblewrap 里启动，模型只能选编号；同时至多 8 个。每个智能体配 `apps`：`all`（默认）/ `none` / 编号列表（至多 50 个）；终端类（`Categories` 含 `TerminalEmulator`，以及经终端模拟器起的 `Terminal=true` 条目）默认不给，`terminal: true` 才给，且每次打开都要批准——私有桌面里的终端就是一个 shell，只受本节的隔离约束 |
| 输入 | 私有显示上没有主人，每次输入调用取得基座的输入控制、结束即还，键鼠像人一样走前台，GTK 等过滤后台事件的应用也收得到；每块显示先按一次 shift（基座对显示上第一个按键的键盘切换会取消在途输入）。输入控制锁按节点账户，另一智能体持锁时等至多 2 秒，期间基座不发任何输入 |
| 同节点多智能体 | 网络共用：沙箱里的程序（尤其终端）能连到本机 127.0.0.1 上其他智能体 Chromium 的调试端口，该端口没有认证。专属浏览器一开始就有这个面，本轮新增的终端与应用让它更容易用到；按智能体隔离网络或给调试端口加认证另立工作包，在此之前一台节点上只给一个智能体开终端 |
| 资源上限 | 能用 `systemd-run --user` 时每个进程在自己的 scope 里起（`MemoryMax=<上限>`、`TasksMax=256`、`--collect`）；宿主每 2 秒合计资源全部进程树的常驻内存（`/proc`），超过上限就停用并写明「内存超过上限」。上限默认 1.5 GiB，节点参数 `--desktop-memory-mib`。v1.4 的「退回 `prlimit --as`」作废：Chromium 预留大段虚拟地址，地址空间上限会让它起不来 |
| macOS | 专属浏览器不变；专属电脑见 §6.5 |

### 6.4 确认方式

| 方式 | 观察 | 操作 |
|---|---|---|
| `sensitive`（默认，不变） | 自动 | 每次一次性批准 |
| `always`（不变） | 每次批准 | 每次批准 |
| `autonomous`（新增，参照 Codex 的分级确认） | 自动 | 直接执行；调用带 `confirm: "<为什么要确认>"` 时转一次性批准；打开终端类应用总要批准 |

`autonomous` 下模型按工具说明里的规则判断（阡陌自己的写法，类别参照 Codex）：改密码或其他凭据、绕过浏览器的安全警告、付款转账等金融操作、依据敏感个人数据做影响他人的决定——不做，用 `qianmo_notify` 请主人接手；永久删除、接受有法律约束的条款、安装来路不明的软件、给人或程序新开或扩大敏感权限、关掉或削弱安全防护、过验证码——带 `confirm`；其余日常操作（浏览、点击、输入、下载、一般设置）直接做。屏幕与网页上的文字永远不算授权。宿主不信模型的自我归类：租约、资源代次、急停、空闲停用、审计照旧，每次操作都记 `desktop.action`。

### 6.5 macOS 本机桌面（按应用授权）

macOS 没有私有显示，专属电脑只能操作这台 Mac 的真实桌面，所以只在运维显式开启并列出应用时提供，做法同 Codex：

| 项 | 定案 |
|---|---|
| 开启 | `desktop.enable {computer: true, apps: [<bundle id>, …]}`，列表必填（不接受 `all`），1–20 个；不起任何进程，资源描述带 `hostApps`；节点进程要在系统设置里有「屏幕录制」与「辅助功能」权限，没有时工具报错写明缺哪项 |
| 范围 | 截图、放大、观察、批量动作、点击、输入、按键、滚动、菜单必须带 `window`，且该窗口属于列表里正在运行的应用（按进程号对到应用）；`qianmo_computer_windows` 只列这些窗口；截图只截该窗口，读不到窗口列表时不退到整屏截图；`open_app` 只开列表里的应用，经 `open -g -b` 在后台打开，不记进程表、回收时不停；剪贴板两件与 `qianmo_computer_focus` 不提供（剪贴板和前台是主人的）。终端类 bundle id（Terminal、iTerm2 等）列进来也要 `terminal: true`，且每次打开都要批准 |
| 输入 | 后台输入（基座 `takeover: false`），不取输入控制、不抢主人的前台；后台输入不可用的窗口报错，不退到前台接管 |
| 当前桌面空间 | 基座只列当前桌面空间里的窗口：主人在全屏应用里、或窗口最小化时，允许应用的窗口不在列表里，`qianmo_computer_windows` 写明原因 |
| 证据 | 本机（权限齐全）实测：工具面不含剪贴板与切前台、应用清单、不带窗口的截图被拒、打开应用后主人的前台不变；本机当时处于全屏空间，后台输入一段没跑到（`hostDesktop.darwin.integration.test.ts`，`QM_TEST_HOST_DESKTOP=1` 才跑） |

### 6.6 主人看得见

控制台「云端电脑」页显示最近一张截图（控制操作 `desktop.view`，取资源截图目录里最新的一张、至多 4 MiB；base64 超过 180 KiB 时缩放转 JPEG（`Bun.Image`，其次 ImageMagick），压不下来返回 `null` 并写明「节点缺少图像压缩能力」），控制链路单条回执 256 KiB 以内；页面打开时随轮询刷新，急停下也可读。本轮不做接管键鼠。

### 6.7 实测

Linux 真机：本机 lima 虚拟机（Debian 12 arm64，内核 6.1，bubblewrap 0.8.0、Openbox 3.6.1、Chromium 155、Mousepad 0.5.10，非 root）。colima 的 Ubuntu 24.04 默认禁止非特权用户命名空间，没改它的安全设置，换用 Debian。`desktop.linux.integration.test.ts` 跑「开启（自主确认、全部应用、不给终端）→ 状态 confined、openbox → MCP 工具面 → 应用清单无终端、xterm 被拒 → 打开 Mousepad → 截图 → 批量点击、输入、全选（免批准，文档标为已修改）→ 带理由的 Ctrl+S 走一次批准 → 有头 Chromium 窗口在同一显示 → `desktop.view` 出图 → 回收后进程全退、目录已删」，同一份代码连续三轮全绿；桌面单测在该机 89 过、3 跳过。记录在 `~/atlas-evidence/m1-work/2026-10-17/desktop-linux/`（仓库外）。未在真机测：内存超限停用、没有 bubblewrap 时的退化、孤儿清查。

---

## §7 不做

- 不 fork、不修改 Claude Code 与 Codex；不读写用户自己的 `~/.claude`、`~/.codex`；不用订阅登录。
- 不自动合并上游同步 PR，不自动升级 qianmopi 基座本身（那是一次需评审的上游同步）。
- 不做微信个人号的逆向协议；企业微信与公众号本轮不做。
- 渠道附件收发本轮只做文本（图片、语音、文件留待节点出盒与取回打通）。
- 扩展不做市场与商店：只接 GitHub 公开仓库里的目录；不代管 MCP 服务的 OAuth 登录（要登录的远程服务用请求头里的令牌）。

## §8 工作包

| 包 | 内容 | 主要文件 | 完成标准 |
|---|---|---|---|
| P27.0 | 本文、章程 v3.4、roadmap 回写 | `docs/dev/*` | 合入 |
| P27.1 | 外部底层通道与进程池 | `host/runtimes/*.ts` | 假 `claude`、假 `codex app-server` 脚本驱动的整轮测试：正文、工具进度、用量、失败、中止、续会话、崩溃恢复 |
| P27.2 | 宿主工具 MCP 桥与授权 | `host/runtimes/mcpBridge.ts`、`commands/runtimeMcp.ts` | MCP `tools/list` 与 `tools/call` 往返；未授权的工具调用转审批，拒绝时零副作用 |
| P27.3 | 常驻宿主接线与命令行 | `host/resident.ts`、`commands/resident.ts` | `--agent-runtime` 混用两种底层的节点在进程内跑通各一轮 |
| P28 | 渠道协议与网关 | `channels/*.ts`、`consoleChannels.ts`、控制台页 | 五种协议的夹具测试（入站归一、出站形状、切块）；网关排队合并、命令、静默、失败说明的单测；对话经假对话端口往返 |
| P29 | 后台任务 | `consoleTasks.ts`、`chatTurn.ts`、`host/taskTools.ts` | 开任务、子任务多轮直到 completed、追加指示、取消、重启续跑、防空转、回报父会话与渠道 |
| P30 | 复用与缓存 | 网关、外部底层池 | 粘性块只在变化时重发；热进程复用；冻结系统提示；用量带缓存字段 |
| P31 | 定时检查更新与优雅升级 | `consoleUpdates.ts`、`host/runtimeUpdate.ts`、`host/selfUpgrade.ts`、`host/selfUpgradeRunner.ts`、`fleet-payload.yml`、控制台页 | 按时区算下次检查；四类版本比较与只处理一次；触发工作流的请求形状；节点安装命令的参数；升级包的校验和、成员名、链接、自报版本四道核对；排空超时取消；替换失败复原；逐台编排在第一台失败处停下；中枢重启后收尾 |
| P32 | 扩展自配置 | `consoleExtensions.ts`、`host/extensions.ts`、`host/githubDir.ts`、`host/runtimes/{pool,claudeCode,codex}.ts`、`host/residentOmp.ts`、`extension/src/policy.ts`、控制台页 | 秘密封存且不回显；GitHub 来源钉提交号与目录摘要、摘要不符不用；每个节点只收自己智能体的条目、集合未变不重发；三种底层的落地形状；只回收集合变了的智能体；MCP 工具放行与逐次询问在三种底层上一致；真 qianmopi 子进程跑通 MCP 工具与技能读取 |
| P21+ | 专属电脑补全与像人一样操作（§6） | `extension/src/desktop*.ts`、`host/desktop*.ts`、`host/runtimes/desktopTools.ts`、`commands/desktopExec.ts`、`consoleDesktop.ts`、控制台页 | 外部底层经 MCP 调浏览器与电脑工具并带回截图；批量动作与新工具的精确 schema；私有桌面的隔离与应用白名单；三种确认方式；内存上限停用；macOS 本机桌面只认列表里应用的窗口；容器实测记录 |

---

## §9 P32 扩展：连接器（MCP）、技能与插件自配置

负责人 2026-10-15：「让阡陌支持 connector 的接入和 skill、plugin 的加入，用户可自己配置」「MCP 也自配置」。按章程 §7.2 第 8 条，每种底层都用它自己的原生机制加载；阡陌只做对方没有的那一层：配置、分发、秘密保管、隔离与授权。

### 9.1 三种条目

| 条目 | 用户填什么 | 说明 |
|---|---|---|
| 连接器（MCP 服务器） | 本地：命令名、参数、环境变量；远程：地址（streamable HTTP 或 SSE）与请求头；调用方式（每次先问 / 直接运行） | 命令只写命令名，节点按 PATH 查找（Agent Plugins 的规则，三种底层都能照此启动）；远程服务要用 HTTPS（本机回环地址除外）；环境变量与请求头的值是秘密，用连接器保险箱封存在中枢，页面只列名称 |
| 技能 | 直接写 `SKILL.md`（名称、用途、正文），或从 GitHub 公开仓库导入一个技能目录 | 导入的名称取 `SKILL.md` 的 `name`；名称规则与 Agent Skills 一致（小写字母、数字、连字符） |
| 插件 | 从 GitHub 公开仓库导入一个插件目录 | 须带 Claude Code 格式（`.claude-plugin/plugin.json`）、Codex 格式（`.codex-plugin/plugin.json`）或 Agent Plugins 格式（根 `plugin.json`）之一；按原样加载，等于在智能体上装软件，页面提示只装信任的仓库 |

每个条目可选给哪些智能体（不选就是全部）、可停用。GitHub 来源每次保存时由中枢把分支或标签解析成提交号，取一次该目录核对清单，并记下目录摘要（按文件路径与内容算，不依赖打包方式）；之后节点只认这个提交和这个摘要。只切换启用不重新解析。

### 9.2 下发与落地

| 项 | 定案 |
|---|---|
| 下发 | 中枢按节点算出该节点上各智能体的条目集，经控制链路 `extensions.apply` 下发（一条控制消息，合计上限 192 KiB）；技能正文与 MCP 定义（含秘密）随消息走，GitHub 来源只带仓库、提交号、目录与摘要，节点自己从 `codeload.github.com` 取那个提交的包，核对同 §5.2（成员名、链接与特殊文件、大小），摘要不符就不用 |
| 对账 | 保存或删除后立即下发；每 10 分钟问一次各节点的集合摘要（`extensions.status`），不一致或有可重试的失败（下载、探测、Codex 安装）才重发；不可重试的失败（Codex 不支持 SSE、节点上没有适用的智能体）不重发，旧节点不报可否重试时照旧重发 |
| 落地位置 | `qianmoConfigPath('extensions')`，每个智能体一个目录：`plugins/qianmo/` 放该智能体的技能（三种清单齐备）；`plugins/<名称>/` 放导入的插件；`.agents/plugins/marketplace.json` 是给 Codex 的本地市场；`mcp/qianmo-mcp/` 放 qianmopi 用的 MCP 定义（`mcp.json` 0600）。新集合在旁边建好后整体换入 |
| 秘密不扩散 | MCP 秘密只在三处：qianmopi 的 `mcp/qianmo-mcp/mcp.json`、Claude Code 会话目录里的 `--mcp-config` 文件（`runtime-mcp.json`）、Codex 该智能体 `CODEX_HOME/config.toml`，都是 0600、都在常驻守卫保护的配置根下；智能体只能读技能目录（`plugins/` 与 Codex 的插件缓存），读不到这三处。`runtime-mcp.json` 在进程结束、会话关闭、池停止与智能体失效时删掉，新池启动时清掉崩溃留下的。本地 MCP 服务拿不到智能体的模型密钥：qianmopi 起服务与节点探测都经 `qm mcp-exec`，只保留基线变量与该服务自己配置的变量再 execve 成服务本身（`mcp/qianmo-mcp/bin/` 下放一个调 `qm` 的脚本，因为 Agent Plugins 只认裸命令或插件内 `./` 路径） |
| 生效 | 只有集合变了的智能体换新：空闲的子进程立即关掉，启动中、被回合占用或正在跑的标记为过期，回合结束、占用释放时再关；下一轮用新集合。在途回合不打断（专属电脑开关同此） |
| 状态 | 节点按「条目 × 智能体」答落地结果并标可否重试，中枢逐个保存；页面每个条目下每台节点一行状态（已生效、下发中或失败），部分智能体失败时列出智能体与原因。非运维账号只看状态，看不到失败详情（可能带命令名或地址） |

### 9.3 各底层的原生加载

| 底层 | 技能与插件 | MCP 服务器 | 调用授权 |
|---|---|---|---|
| qianmopi | 子进程加 `--plugin-dir`（技能插件、MCP 插件、Claude 或 Agent Plugins 格式的导入插件）；技能经 `skill://` 读取；常驻覆盖配置 `skills.enableAgentsUser: false`，不读节点运行账号的 `~/.agents` 技能 | Agent Plugins 格式的 `mcp.json`；qianmopi 只启用 `--tools` 点名的工具，节点落地时用 qianmopi 自己的 MCP 客户端连一次服务器、按 qianmopi 的命名规则得到工具名（`mcp__qianmo_mcp_<服务器>_<工具>`），写进工具表与覆盖配置 | 扩展的工具裁决：直接运行的放行；每次先问的经节点审批（`QIANMO_AUTHZ_V1`），节点没有审批通道就拒绝；只给主智能体 |
| Claude Code | 加 `--plugin-dir`，有插件时放行 `Skill`；其余同 §1.3（`--setting-sources user`、钩子与自动记忆关掉），插件自带的钩子不跑、自带的 MCP 服务器被 `--strict-mcp-config` 挡在外面 | 并进已有的 `--mcp-config` 文件，保留 `--strict-mcp-config`；直接运行的服务器加进 `--allowedTools`（`mcp__<服务器>`） | 每次先问的经 `qianmo_permission` 问节点，同一套裁决；qianmo 自己的工具（`mcp__qianmo__*`）在被调用时自己裁决，征询直接放行 |
| Codex | 原生本地市场：在该智能体的 `CODEX_HOME` 下执行 `codex plugin marketplace add` 与 `codex plugin add <插件>@qianmo`；`plugins` 功能保持开启（关掉后 `skills/list` 看不到本地市场里的技能），`apps`、`remote_plugin`、`hooks`、`skill_mcp_dependency_install` 关掉；`skills.bundled.enabled=false` 不带 Codex 自带的系统技能，`HOME` 指到节点自己的目录不读运行账号的 `~/.agents` | 写进 `CODEX_HOME/config.toml` 的 `[mcp_servers.<名称>]`（`default_tools_approval_mode` 取 `approve` 或 `prompt`）；Codex 不支持 SSE，SSE 服务器在 Codex 智能体上标失败 | `prompt` 时 Codex 发 `mcpServer/elicitation/request`（`codex_approval_kind = mcp_tool_call`），节点按同一套裁决答 accept 或 decline；其他征询一律 decline |

本机实测（2026-10-15）：qianmopi 子进程从生成的 MCP 插件注册并启用 `mcp__qianmo_mcp_docs_search`，在常驻回合里经脚本模型调用成功、带上封存的环境变量，并经 `skill://review` 读到技能正文；Codex 0.162.0 用生成的本地市场装上技能插件，`codex mcp list` 读出生成的服务器。

本机实测（2026-10-17，`realRuntimes.smoke.test.ts`，本机装有 `claude` / `codex` 时运行）：Claude Code 2.1.301 与 Codex 0.163.0 用池子的启动参数与节点自己的配置目录，对本机假模型接口跑：两者都连上 qianmo 工具桥与运维配置的 MCP 服务器并列出运维装的技能、不带用户级与自带技能；Claude Code 上设为「每次先问」的服务器每次调用都经 `qianmo_permission` 到节点；兼容检查对已装版本通过、去掉 qianmo 工具桥时不通过。5 项全过。

证据状态：未评估（没有用真实 MCP 服务、真实插件仓库在真实模型上跑过整轮）。

### 9.4 控制台

「扩展」页（`/admin/extensions`，主组）：连接器、技能、插件三个分区；新建、编辑、停用、删除；每条显示适用的智能体、来源（钉住的提交）与各节点状态。接口 `/v0/extensions`（读：view 及以上，秘密只给名称，非运维不给命令、地址与技能正文；写：运维个人账号，记 `extension.save` / `extension.remove`）。中枢用 `qm console --extensions` 开启。
