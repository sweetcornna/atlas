<!-- Copyright 2026 Qianmo AgentNest Team -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# 阡陌 Qmo — 多底层目录、默认 DeepSeek Harness 与底层互通设计（P36）

| 项 | 内容 |
|---|---|
| 文档版本 | **v1.0（生效）** |
| 日期 | 2026-10-17 |
| 核对基点 | 本仓库 `16c7be61`（`feat/magpie-gateway`，合并了 main `fdb77fc1`）；DeepSeek Harness 源码 `deepseek-ai/deepseek-harness@687f282e`（2026-10-17），npm `@deepseek-ai/dsh`；调研记录 `atlas-evidence/m1-work/2026-10-17/harness/`（仓库外） |
| 范围依据 | 负责人 2026-10-17 决定（对话记录）：① 默认安装 DeepSeek Harness 作为后端，可选择性安装 qianmopi、Codex、Claude Code 等一众 harness 作为后端；② 后端之间联通交流性很高；③ 用户可直接在我们特化的 magpie 前端上进行各底层的智能体模型配置，用户接入 provider，智能体默认接入 magpie 并配置对应系列的模型（Claude Code 接 Claude、Codex 接 GPT） |
| 编号 | P36（P36.1–P36.7，包表见 §8）；章程 v3.6 §2.8 |
| 依赖 | [`runtimes-channels.md`](./runtimes-channels.md)（P27 多底层、P29 后台任务、P31 更新、P32 扩展）、[`magpie-gateway.md`](./magpie-gateway.md)（P33 网关与密钥、P34「网关」页） |
| 结论一句话 | 底层从写死的三种变成一份目录：DeepSeek Harness 是默认底层、节点默认安装，qianmopi 内置，Claude Code、Codex 与其他支持 ACP 的 harness 按需安装；dsh 与其他 ACP harness 共用一个 ACP 通道；智能体默认经节点的 magpie 密钥取各自系列的模型，用户在「网关」页逐个改；所有底层拿到同一套宿主工具，智能体之间除了后台任务还能同步问答，换底层时对话接着走 |

由主 agent 按负责人 10-03 的常设委托（设计取舍自行裁定）定案。「未评估」「未实测」是证据状态，不是授权门槛。

---

## §0 口径

- **一切原生化适配**（章程 §7.2 第 8 条）：每个 harness 都以官方发行版原样作为子进程运行，不 fork、不改，只经它公开的非交互接口：DeepSeek Harness 与其他支持 ACP 的 harness 走 Agent Client Protocol（stdio JSON-RPC，`agentclientprotocol.com`）；Claude Code 仍走 `--print` 流式 JSON，Codex 仍走 `app-server`。会话续接、中止、权限征询、MCP 都用对方原生的那一套，阡陌只在边界翻译一次。
- **名称**：DeepSeek Harness 简称 dsh（MIT，DeepSeek 发布）；qianmopi 是阡陌自己的基座，内置在 `qm` 里。指称性使用，阡陌与 DeepSeek、Anthropic、OpenAI、Google 等无关联、未获背书。
- **凭据**：外部底层只用 API key 或网关密钥，来自控制台模型服务；默认就是节点的 magpie 网关密钥（P33）。不读用户自己的 `~/.claude`、`~/.codex`、`~/.dsh`、`~/.gemini` 等登录态，不用任何订阅登录（L-6 不变）。
- **N-9**：v3.4 补注的口径扩到 dsh 与目录里的其他 harness——官方发行版原样运行、状态目录与凭据由阡陌隔离，不是维护它们的分支，也不建设插件市场。
- **qianmopi 的「可选安装」**：qianmopi 就是 `qm` 程序本身，节点总有它，所以它在目录里是「内置」，可选的是每个智能体用不用它；它也是其他底层不可用时的退路（§3.3）。

---

## §1 底层目录（P36.1）

目录是一份代码里的表（`host/runtimes/catalog.ts`），节点、中枢、控制台共用，不从网上拉。每一项：

| 字段 | 含义 |
|---|---|
| `id` | 稳定标识：`dsh`、`omp`（界面与配置里也写作 `qianmopi`）、`claude-code`、`codex`，以及 §1.2 的 ACP harness |
| `protocol` | `omp`（qianmopi 原有的 RPC）、`claude-stream`、`codex-app-server`、`acp` |
| `install` | `builtin`，或 `npm {package, command, pin}`：官方 npm 包、可执行名、本版本钉住的版本 |
| `default` | 只有 `dsh` 为真：节点缺省底层、缺省安装 |
| `lanes` | 它能说的模型线路，按偏好排序（`openai-chat`、`anthropic`、`openai-responses`、`gemini`）；节点按这个顺序在档案里找它说得通的那一条 |
| `family` | 默认模型系列：名称与一组按偏好排序的模型号匹配规则（§4.2）；qianmopi 为空（跟随节点主模型） |
| `acp` | 只对 `acp`：启动参数、把地址密钥模型交给它的方式（环境变量或写进它自己的配置文件）、状态目录的环境变量、要关掉的东西（遥测、自动更新、用户钩子、自带子代理） |
| `verified` | 本版本在本机实测过整轮（§7）；没实测的照样能装能选，页面标「未实测」 |

### 1.1 四个核心底层

| id | 名称 | 接口 | 安装 | 默认系列 | 线路（偏好序） |
|---|---|---|---|---|---|
| `dsh` | DeepSeek Harness | ACP：`dsh --profile acp` | npm `@deepseek-ai/dsh`，**节点缺省安装** | DeepSeek | `openai-chat`、`anthropic` |
| `omp` | qianmopi | 原有 RPC | 内置 | 跟随节点主模型 | 档案主通道 |
| `claude-code` | Claude Code | `claude -p` 流式 JSON | npm `@anthropic-ai/claude-code`，可选 | Claude | `anthropic` |
| `codex` | Codex | `codex app-server` | npm `@openai/codex`，可选 | GPT | `openai-responses` |

### 1.2 其他 ACP harness

按调研记录（`acp-harness-survey.md`）收进目录的、官方发行版自带 ACP 服务端且能经环境变量或配置文件指向自定义网关的 harness，见 §1.3 的定案表。只经 ACP 适配器（第三方包装）才能说 ACP 的不收；要 OAuth 登录才能用自定义地址的不收。

### 1.3 目录定案

（由 P36.2 按调研与实测填写，与 `catalog.ts` 一致；`presets.test` 式的门禁核对两边相同。）

---

## §2 安装（P36.3）

| 项 | 定案 |
|---|---|
| 位置 | 沿用 P31：`qianmoConfigPath('runtimes','npm')` 前缀，`npm install --prefix`，缓存与配置也在其下；先装进临时前缀、过兼容检查再换入。启动参数指定了路径的（`--claude-code-bin`、`--codex-bin`、新增 `--runtime-bin <id>=<路径>`）不管 |
| 缺省安装 | 节点启动时，若某个智能体的配置底层是 `dsh`（包括按缺省落到 dsh 的）而节点上找不到可用的 dsh，就在后台装钉住的版本；安装期间与失败后，这些智能体按 §3.3 退回 qianmopi 并写明原因，装好后它们的空闲子进程换新（与扩展变更同一个口子），下一轮起用 dsh。`--no-runtime-autoinstall` 关掉；失败按 5、15、60 分钟退避重试，每次启动最多三次 |
| 可选安装 | 控制链路 `runtime.install {runtime, version?}`（不给版本装目录钉住的版本）、`runtime.remove {runtime}`（有智能体配置在它上面时拒绝，写明是哪些）；`runtime.update` 保留，泛化到目录里所有 npm 项。三个都是有副作用的操作，走节点的幂等账本，急停下拒绝 |
| 兼容检查 | 沿用 P31 的做法，按接口分：ACP 底层用节点自己的启动参数、真实的 `qm runtime-mcp` 工具桥与本机假模型接口（按它的首选线路）跑 `initialize` → `session/new`（带 qianmo MCP）→ 一轮，要求工具列表里有 `qianmo_*`、一次宿主工具调用到达节点；不通过就不装，节点留在原状，答复写明原因 |
| 报告 | `runtime.versions` 列出目录里每一项：是否已装、版本、来源（前缀 / PATH / 启动参数）、钉住的版本、上次安装的结果；中枢「更新」页与「网关」页都读它 |
| 出站 | `registry.npmjs.org`（npm 自己的下载域）；走 §7.2 出站策略。dsh 运行要 Node.js（版本见 §1.3），节点没有合适的 Node.js 时安装报「缺少 Node.js」，不替节点装 Node.js |

---

## §3 每个智能体的底层与模型（P36.4）

### 3.1 配置来源

优先级从高到低：

1. 节点的 `runtimes.json`（`qianmoConfigPath('qianmo','runtimes.json')`，0600 原子写）：控制链路 `runtime.configure {agent, runtime, model}` 写入，`model` 是 `<档案>/<模型号>` 或 `auto`；
2. 启动参数 `--agent-runtime`、`--agent-model`（P27 原有）；
3. 节点缺省底层 `--default-runtime <id>`，**缺省 `dsh`**。

`runtime.configure` 只接受目录里的 id 与本节点名册里的智能体；写入后该智能体的空闲子进程立即换新，忙的回合结束后换（同 P32）。

### 3.2 模型

- 给了 `<档案>/<模型号>`：照 P27 的 `runtimeModelCredential`，按目录的 `lanes` 顺序在该档案（含 `laneAddresses` 生成的同钥 provider）里取第一条它说得通的线路。
- `auto` 或没给：中枢在「网关」页按系列算好后经 `runtime.configure` 写成具体的 `<档案>/<模型号>`（§4）；节点自己没有中枢下发的选择时，取节点主档案里第一条说得通的线路与主模型（qianmopi 照旧跟随节点主模型）。
- 都取不到：「没有可用模型」，按 §3.3 退回。

### 3.3 退回与状态

配置的底层用不了时智能体不停摆，退回 qianmopi，原因写清楚：未安装、安装中、安装失败（带错误）、兼容检查未过、没有可用模型、节点没有 Node.js。原因消失（装好了、模型下发了）后自动回到配置的底层。退回不是静默的：控制链路 `runtime.status` 逐个智能体答 `{configured, effective, model, lane, reason}`，「网关」页与「智能体」页显示「暂用 qianmopi · 原因」。

**对现网的影响**：已经部署、没写 `--agent-runtime` 的节点升级后，智能体按缺省改用 dsh（装好、有模型之后）。要保持原样的节点加 `--default-runtime qianmopi`（与 `omp` 同义）。

---

## §4 「网关」页按系列配模型（P36.5）

### 4.1 默认接入 magpie

中枢接了 magpie（`--magpie`）时，「网关」页「智能体」区块打开「新节点自动接入」（缺省开）：模型指派为 `inherit` 且没有全局缺省档案的节点，自动签发网关密钥、建 magpie 档案并指派、下发（P33 原有的签发链，不是新的调度器）。已经指派了别的档案的节点不动，页面给「接入 magpie」按钮。magpie 档案带 `anthropic`、`openai-responses`、`openai-chat` 三条线路（P33 `laneAddresses`）；目录里有说 Gemini 协议的底层时再加 `gemini` 线路（magpie 同端口也说 Gemini）。

### 4.2 按系列选模型

- 系列规则在目录里：每个系列一组按偏好排序的匹配（例：Claude 先 `opus` 后 `sonnet` 再任意 `claude`，同档里版本号大的在前；GPT 先 `gpt-*-codex`、再 `gpt-*`；DeepSeek 先最新的 `deepseek-v*`、再 `deepseek-chat`）；候选是这把节点密钥在 magpie `/v1/models` 里看得到的模型（白名单随上游变，P33 已有）。路由组 `group/<id>` 只在用户手选时用。
- 智能体模型为「自动」时，中枢按它的底层所属系列取第一名，经 `runtime.configure` 写给节点；上游增删、模型目录变化、智能体改底层、节点新上线时重算，结果没变不重发。
- 该系列一个都没有时：取该底层线路上能用的任意模型的第一名（dsh 用 GPT 或 Claude 也能跑），页面标「系列外」；仍没有就留空，节点按 §3.3 退回。
- 用户手选的模型原样保存，不被重算覆盖；改回「自动」才重算。

### 4.3 页面

「网关」页新增「智能体」区块（与连接、上游、路由组、网关密钥、用量同页，阡陌风格、服务端渲染、零依赖）：

| 列 | 内容 |
|---|---|
| 智能体 | `节点 / 智能体`，主智能体带标记 |
| 底层 | 下拉：目录里本节点已装的底层；未装的列在「安装…」里 |
| 模型 | 下拉：「自动（当前选中的模型）」+ 按系列分组的可用模型 + 路由组 |
| 状态 | 生效中 / 暂用 qianmopi · 原因 / 下发中 / 失败 · 原因 |

每台节点一行「底层」：目录逐项「已装 vX · 未实测」「安装」「卸载」，安装进度跟着作业轮询。写操作只给运维个人账号（与 P34 同权限），记 `runtime.configure`、`runtime.install`、`runtime.remove`；读者只看到底层与模型名，看不到错误详情。接口 `/v0/magpie/agents`。

---

## §5 ACP 通道（P36.2）

`host/runtimes/acp.ts` 是一个通用 ACP 客户端通道（继承 `RuntimeChannelBase`），把 ACP 翻成常驻回合端口的那组帧，回合端口、看门狗、进度、用量、崩溃恢复都不改（P27 §1.2 的做法）：

| 回合信号 | ACP |
|---|---|
| 启动 | `initialize`（声明我们的客户端能力：不提供 `fs`、`terminal`，文件与命令由 harness 自己的工具做、经权限征询裁决）→ 首次 `session/new {cwd, mcpServers}`，之后 `session/load`（harness 声明 `loadSession` 时；不支持的每次新开并在首轮带 §6.3 的前情） |
| 发出一轮 | `session/prompt {sessionId, prompt: [{type:"text"}]}`；请求发出即补 user `message_end` |
| 正文 | `session/update` 的 `agent_message_chunk` 累积，到下一个工具调用或回合结束时出一条 assistant `message_end`；`agent_thought_chunk` 不进正文 |
| 工具 | `tool_call` → `tool_execution_start`；`tool_call_update` 的 `completed` / `failed` → `tool_execution_end` |
| 用量 | harness 在 ACP 里报的用量（`session/prompt` 应答或 `usage_update`，以调研为准）；不报时用量记 0 并标「底层未报告」，不估算 |
| 结束 | `session/prompt` 应答的 `stopReason`：`end_turn` → `completed`、`max_tokens` → `length`、`cancelled` → `aborted`、`refusal` 与错误 → `error` |
| 中止 | `session/cancel`；5 秒内没有应答才关子进程 |
| 权限 | `session/request_permission` 按常驻姿态裁决（与 Claude Code 的 `qianmo_permission` 同一套：工作区外读取、写入、shell；可批准的越界写入转 P14 审批），答 `allow_once` 或 `reject_once`，从不答 `allow_always` |
| 宿主工具 | `session/new` 的 `mcpServers` 带 qianmo 工具桥（`qm runtime-mcp`，令牌文件同 P27 §1.3）与该智能体的运维 MCP 服务（P32） |

每个 ACP harness 的差异（启动参数、凭据交法、状态目录、要关的东西）都在目录项的 `acp` 字段里，通道本身不分 harness。dsh 的具体做法见 §1.3 与调研记录。

隔离与 P27 相同：子进程 cwd 是智能体工作区，环境只放白名单变量加凭据，状态目录在 `qianmoConfigPath('runtimes', <id>, <智能体>)`，关掉遥测与自动更新，不加载用户级钩子与项目里的定制文件（能关的都关，关不掉的在 §1.3 写明）。

扩展（P32）：MCP 连接器经 `session/new` 的 `mcpServers` 交给所有 ACP harness；技能按各 harness 原生的技能目录落地（dsh 有原生技能目录），没有原生技能机制的底层在扩展状态里标「该底层不支持技能」。

---

## §6 底层互通（P36.6）

目标：不管智能体跑在哪种底层上，彼此找得到、说得上话、接得住对方的上下文。

### 6.1 同一套宿主工具

所有底层拿到同一组 `qianmo_*` 宿主工具（qianmopi 经扩展、其余经 `qm runtime-mcp`），工具面顺序固定（P30）。新增的两件也一样。

### 6.2 名册与同步问答

| 工具 | 参数 | 做什么 |
|---|---|---|
| `qianmo_agents` | — | 列出调用者可拨的智能体：`qianmo://<节点>/<智能体>`、底层、模型、在线、忙闲、一句说明 |
| `qianmo_ask` | `agent` 或 `agents`（至多 4 个）、`message`、`timeoutSec?`（缺省 300，上限 1800） | 同步问一个或几个智能体，等它们这一轮的回答后一并返回；几个目标并行发出 |

- **会话**：每对（发问的会话、被问的智能体）一条「对话」会话，长期复用，被问方记得之前问过什么；发问方开新会话或 `/new` 才换。
- **身份与授权**：经中枢，以发问会话主人的身份走 `ChatDispatch`（租户、白名单、额度、审计 `peer.ask`），与后台任务（P29）同一套核对；不新增节点间直连。
- **防死锁（重入）**：节点一次只跑一轮（`NodeTurnGate`）。发问方的回合在等工具结果时占着闸门，被问方若在同一节点会永远排不上。所以中枢给每次问答签一条调用链 `chain: [{node, turn}]`（签名同后台标记），节点的闸门在当前正在跑的回合出现在链里时让这一轮**重入**——发问方此刻只是在等，不会并发。链长至多 3 层；被问的智能体已在链里（A 问 B、B 又问 A）直接拒绝并写明。跨节点的环同样靠链识别。
- **与后台任务的分工**：`qianmo_ask` 用于几分钟内能答完的问题（审一段代码、问一个事实、要一个意见）；耗时的活仍用 `qianmo_task_start`。后台子任务里也能用 `qianmo_ask`，但不能再开任务（P29 不变）。

### 6.3 换底层时对话接着走

每条会话不论底层都记一份「便携记录」（会话目录 `portable.ndjson`，0600：每轮的用户文字、最终回答、一行工具摘要，保留最近 64 KiB）。智能体换了底层（用户改了、或因 §3.3 退回 / 恢复）之后，已有会话的下一轮在新底层上开新的原生会话，第一轮前面带一段「前情」（最近若干轮，至多 12 KiB，注明来自哪个底层），之后照常续接。不支持续接的 ACP harness 进程重启时同样用它。

### 6.4 共享

- 技能、MCP 连接器、插件按 P32 对所有底层下发，各用原生方式加载（§5）。
- 长期记忆、通知、文件申请、专属电脑都是宿主工具，任何底层的智能体读写的是同一份。

---

## §7 证据

| 项 | 状态 |
|---|---|
| dsh 经 ACP 跑通整轮（假模型接口） | 由 P36.2 实测后回写 |
| 其他 ACP harness | 逐项回写 `verified` |
| 真实 magpie 上 dsh 一轮 | 未评估 |
| `qianmo_ask` 跨节点、重入 | 由 P36.6 的测试回写 |

---

## §8 工作包

| 包 | 内容 | 主要文件 | 完成标准 |
|---|---|---|---|
| P36.0 | 本文、章程 v3.6、路线图 v3.7、`runtimes-channels.md` 回写 | `docs/dev/*` | 合入 |
| P36.1 | 底层目录 | `host/runtimes/catalog.ts` | 目录项校验；中枢与节点同一份；类型从写死的两种改为目录 id |
| P36.2 | ACP 通道与 dsh 等适配 | `host/runtimes/acp.ts`、`host/runtimes/pool.ts`、`extensions.ts` | 假 ACP harness 脚本驱动的整轮：正文、工具进度、用量、权限放行与拒绝零副作用、中止、续会话、崩溃恢复；真 dsh 子进程在假模型接口上跑通一轮并调到宿主工具 |
| P36.3 | 安装 | `host/runtimeUpdate.ts`、`host/runtimes/smoke.ts` | 缺省安装、可选安装、卸载被占用时拒绝、兼容检查不过不装、退避重试 |
| P36.4 | 智能体配置、模型与退回 | `host/runtimeConfig.ts`、`providers/node.ts`、`commands/resident.ts` | 三级优先级；线路按偏好序取；六种退回原因与恢复；`runtime.status` |
| P36.5 | 「网关」页按系列配模型 | `commands/consoleMagpie*.ts`、`console/src/{routes,view}/magpie*.ts` | 自动接入；系列排序；手选不被覆盖；写权限与审计；页面各门禁 |
| P36.6 | 底层互通 | `host/peerTools.ts`、`commands/consolePeers.ts`、`resident/src/turn-gate.ts`、`capability` | 名册；单个与多个目标问答；同节点重入不死锁；环与超深链拒绝；便携记录与换底层前情 |

## §9 不做

- 不 fork、不改任何 harness；不读写用户自己的登录态目录；不用订阅登录。
- 不收只能经第三方 ACP 适配器接入的 harness，不提供「任意命令当底层」（那等于让运维之外的人在节点上跑程序）。
- 不替节点安装 Node.js、Python 等运行环境。
- 不在中枢转发模型请求（N-5 不变）。
