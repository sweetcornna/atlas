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

只收官方发行版自带 ACP 服务端、能经环境变量或配置文件指向自定义网关、不用登录厂商账号的 harness；名单与不收的理由见 §1.3。

### 1.3 目录定案

依据 2026-10-17 两份调研（`dsh-acp-facts.md`、`acp-harness-survey.md`）与 P36.2 的实测：下表四个 ACP 底层都在本机（macOS arm64）、临时配置根、假模型网关上经阡陌的 ACP 通道跑通整轮——取到宿主工具（经真实的 `qm runtime-mcp` 工具桥调用 `qianmo_notify`）、越界写入被拒且零副作用、新进程续上会话（`realDsh.smoke.test.ts`、`realAcpHarnesses.smoke.test.ts`，证据 `p36-2-real-dsh/`、`p36-2-real-acp/`）。未在 Linux 上实测；真实 harness 上的中止未实测。

| id | 名称 | 包与钉住的版本 | 启动 | 凭据与状态目录 | 线路 | 系列 | 运行环境 |
|---|---|---|---|---|---|---|---|
| `dsh` | DeepSeek Harness | `@deepseek-ai/dsh@0.2.1-rc.2` | `dsh --profile acp --patch <补丁>` | 补丁文件写路由（地址、模型、密钥所在的环境变量名）与隔离项；`DSH_HOME`、`DSH_AGENTS_HOME` 在该智能体目录下；密钥放在名字含 `KEY` 的变量里（dsh 不把这类变量交给模型的 shell） | `openai-chat`、`anthropic` | DeepSeek | Node.js `^22.19.0 \|\| >=24`；安装约 850 MB |
| `gemini` | Gemini CLI | `@google/gemini-cli@0.64.0` | `gemini --acp` | `GOOGLE_GEMINI_BASE_URL`、`GEMINI_API_KEY`、`GEMINI_MODEL`；`GEMINI_CLI_HOME` | `gemini` | Gemini | Node.js |
| `qwen` | Qwen Code | `@qwen-code/qwen-code@0.25.2` | `qwen --acp --auth-type openai --approval-mode default` | `OPENAI_BASE_URL`、`OPENAI_API_KEY`、`OPENAI_MODEL`；`QWEN_HOME` | `openai-chat` | Qwen | Node.js |
| `opencode` | opencode | `opencode-ai@1.19.3` | `opencode acp` | `OPENCODE_CONFIG_CONTENT` 写自定义供应商与权限；`XDG_*_HOME` | `openai-chat`、`anthropic` | 跟随节点主模型 | 无（自带二进制） |

不收：goose（只发 GitHub 二进制，v1 只做 npm 安装）；Kimi CLI、Cline、Augment（自定义网关也要先登录厂商账号，或流量只走厂商服务器）；`claude-agent-acp`、`codex-acp`（Claude Code 与 Codex 已按原生接口接入，前者还捆绑专有 SDK）；iFlow（服务已于 2026-04-17 关停）。

**dsh 的几处做法**（`dsh-acp-facts.md` §10）：

- 子进程在该智能体目录下一个空的 `launch/` 里启动，工作区只经 `session/new.cwd` 交给它——dsh 会把启动目录的 `.env` 读进自己的环境。
- 隔离补丁：不注入工作区的 AGENTS.md / CLAUDE.md，技能只认该智能体的 `skills/`，关掉 DeepSeek 原生路由的会话日志上报与插件清单上报、遥测、联网工具、子代理与工作流，会话改存不压缩的 JSONL。
- 权限：dsh 缺省只在越出它自己沙箱时才征询。补丁另装一个本地插件（阡陌生成，约 25 行，写在该智能体目录下），让每次 shell、写入、MCP 调用与工作目录外的读取都经 `session/request_permission` 问节点。这是 dsh 自己的插件机制，不改 dsh。
- 用量：dsh 不在 ACP 里报模型用量，每轮结束后读它会话日志里本轮新增的 `assistant/message` 的 `usage`（未命中输入、输出、缓存读、缓存写）。
- 续会话：dsh 没有 `session/load`，用 `session/resume`（模型侧历史恢复，不回放）。
- 每个 stdio MCP 服务每个会话会被起两次（第一次是探测）；有启动副作用的连接器要能容忍。

**其他 ACP harness 的共同约束**：qwen、opencode 缺省自动放行一切，目录项把权限改成征询；只有对方在 `initialize` 里声明支持时才交 http MCP 服务，SSE 一律不交；各自的遥测与自动更新开关按调研关掉。用量：dsh 读会话日志，Gemini CLI 取 `session/prompt` 应答里的用量，Qwen Code 与 opencode 不报，记 0 并标「底层未报告」，计量以 magpie 网关侧为准（P33 §2.4）。

- **拒绝之后**：opencode 设 `experimental.continue_loop_on_deny`，模型听到拒绝后接着做；Qwen Code 遇到任何被拒的调用都会结束本轮（它的设计，没有开关），常驻回合因此记为失败。
- **Gemini CLI 的续会话**：`session/load` 先应答、再回放旧对话，通道等到回放停下 200 毫秒（至多 5 秒）再发下一轮。
- **工具桥的位置**：qianmo 工具桥由启动配置挂上（dsh 补丁、Qwen 设置、opencode 配置、Gemini 用节点自己生成的一个扩展），`session/new` 只带运维配的连接器——ACP 的 `session/new` 不能给单个服务设超时，而 `qianmo_ask` 要等到 1800 秒，工具桥的调用超时统一放到 1900 秒。Claude Code 的 `MCP_TOOL_TIMEOUT` 与 Qwen 的空闲超时是全局的，连接器的超时随之变化。

---

## §2 安装（P36.3）

| 项 | 定案 |
|---|---|
| 位置 | 沿用 P31：`qianmoConfigPath('runtimes','npm')` 前缀，`npm install --prefix`，缓存与配置也在其下；先装进临时前缀、过兼容检查再换入。启动参数指定了路径的（`--claude-code-bin`、`--codex-bin`、新增 `--runtime-bin <id>=<路径>`）不管 |
| 缺省安装 | 节点启动时，若某个智能体的配置底层是 `dsh`（包括按缺省落到 dsh 的）而节点上找不到可用的 dsh，就在后台装钉住的版本；安装期间与失败后，这些智能体按 §3.3 退回 qianmopi 并写明原因，装好后它们的空闲子进程换新（与扩展变更同一个口子），下一轮起用 dsh。`--no-runtime-autoinstall` 或环境变量 `QIANMO_RUNTIME_AUTOINSTALL=0` 关掉；首次失败后按 5、15、60 分钟各重试一次，之后本次启动不再试；节点停机时中止进行中的安装，不记为失败 |
| 可选安装 | 控制链路 `runtime.install {runtime, version?}`（不给版本装目录钉住的版本，只收精确版本号）、`runtime.remove {runtime}`（有智能体配置在它上面时拒绝 `E_RUNTIME_IN_USE` 并写明是哪些；内置的 qianmopi 拒绝 `E_RUNTIME_BUILTIN`）；`runtime.update` 保留，泛化到目录里所有 npm 项。同一底层正在装时再装回 `E_RUNTIME_BUSY`，安装失败回 `E_RUNTIME_INSTALL`，被 `--runtime-bin` 钉住路径的底层不装不卸。三个都是有副作用的操作，走节点的幂等账本，急停下拒绝。上次安装的结果记在 `qianmoConfigPath('runtimes','installs.json')`（0600） |
| 兼容检查 | 沿用 P31 的做法，按接口分：ACP 底层用节点自己的启动参数、真实的 `qm runtime-mcp` 工具桥与本机假模型接口（按它的首选线路）跑 `initialize` → `session/new`（带 qianmo MCP）→ 一轮，要求工具列表里有 `qianmo_*`、一次宿主工具调用到达节点；不通过就不装，节点留在原状，答复写明原因 |
| 报告 | `runtime.versions` 列出目录里每一项：是否已装、版本、来源（前缀 / PATH / 启动参数）、钉住的版本、上次安装的结果；中枢「更新」页与「网关」页都读它 |
| 前置 | 安装前核对磁盘：受管前缀所在文件系统的可用空间不够（dsh 要 2 GiB 以上）就不开始，报「磁盘空间不足」；要 Node.js 的底层先核对版本范围（dsh `^22.19.0 \|\| >=24`），不合要求报「缺少 Node.js」（退回原因 `no-node`），不替节点装 Node.js |
| 出站 | `registry.npmjs.org`（npm 自己的下载域）；走 §7.2 出站策略 |

---

## §3 每个智能体的底层与模型（P36.4）

### 3.1 配置来源

优先级从高到低：

1. 节点的 `runtimes.json`（`qianmoConfigPath('qianmo','runtimes.json')`，0600 原子写，`{v:1, agents:{<智能体>:{runtime?, model?}}}`）：控制链路 `runtime.configure {agent, runtime, model}` 写入，`model` 是 `<档案>/<模型号>` 或 `auto`，传 `null` 清掉该字段；
2. 启动参数 `--agent-runtime`、`--agent-model`（P27 原有）；
3. 节点缺省底层 `--default-runtime <id>`，**缺省 `dsh`**。

`runtime.configure` 只接受目录里的 id 与本节点名册里的智能体；写入后该智能体的空闲子进程立即换新，忙的回合结束后换（同 P32）。外部底层不再强制要求 `--agent-model`（取不到模型是一种退回原因，不是启动错误）；`--agent-shell` 对任何外部底层都可用。

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

中枢接了 magpie（`--magpie`）时，「网关」页「智能体」区块打开「新节点自动接入」（缺省开）：模型指派为 `inherit` 且没有全局缺省档案的节点，自动签发网关密钥、建 magpie 档案并指派、下发（P33 原有的签发链，不是新的调度器）。已经指派了别的档案的节点不动，页面给「接入 magpie」按钮。magpie 档案带 `anthropic`、`openai-responses`、`openai-chat`、`gemini` 四条线路（P33 `laneAddresses`，magpie 同端口说这四种协议；`gemini` 线路地址是 `<网关>/v1beta`，与模型服务里其他 Gemini 线路的写法一致，Gemini CLI 的启动器去掉这一段再交给它），一把密钥服务目录里所有底层。已有的节点档案在每 10 分钟的核对里补上 `gemini` 线路。

自动接入以中枢自己的身份（账本主体 `system:magpie`，记 `magpie.autojoin node:<节点>`）执行；magpie 里还没有可用模型、节点属于某个租户、或读不到租户配置时都不接；失败后一小时内不再试；需要控制链路（`--control`）。接入时档案的主模型取缺省底层所属系列的第一名。

### 4.2 按系列选模型

- 系列规则在目录里：每个系列一组按偏好排序的匹配（例：Claude 先 `opus` 后 `sonnet` 再任意 `claude`，同档里版本号大的在前；GPT 先 `gpt-*-codex`、再 `gpt-*`；DeepSeek 先最新的 `deepseek-v*`、再 `deepseek-chat`）；候选是这把节点密钥在 magpie `/v1/models` 里看得到的模型（白名单随上游变，P33 已有）。路由组 `group/<id>` 只在用户手选时用。
- 智能体模型为「自动」时，中枢按它的底层所属系列取第一名，经 `runtime.configure` 写给节点；上游增删、模型目录变化、智能体改底层、节点新上线时重算，结果没变不重发。
- 该系列一个都没有时：按目录里各系列的顺序取别的系列的第一名（dsh 用 GPT 或 Claude 也能跑），页面标「系列外」；仍没有就留空，节点按 §3.3 退回。
- 目录里没有默认系列的底层（opencode）与 qianmopi 显示「跟随节点主模型」，中枢不替它选；qianmopi 不收手选模型。
- 节点不再用它的 magpie 档案时，中枢写过的、指向那份档案的模型一并撤回（`model: null`）。
- 用户手选的模型原样保存，不被重算覆盖；改回「自动」才重算。

### 4.3 页面

「网关」页新增「智能体」区块（与连接、上游、路由组、网关密钥、用量同页，阡陌风格、服务端渲染、零依赖）：

| 列 | 内容 |
|---|---|
| 智能体 | `节点 / 智能体`，主智能体带标记 |
| 底层 | 下拉：目录里本节点已装的底层；未装的列在「安装…」里 |
| 模型 | 下拉：「自动（当前选中的模型）」+ 按系列分组的可用模型 + 路由组 |
| 状态 | 生效中 / 暂用 qianmopi · 原因 / 下发中 / 失败 · 原因 |

每台节点一行「底层」：目录逐项「已装 vX · 未实测」「安装」「卸载」，安装进度跟着作业轮询（发出 5 秒内没答就显示「进行中」，页面每 3 秒刷新）。节点是否支持这些操作看它对 `runtime.status` 的答复形状，答不了的显示「节点版本过旧」、不给写控件。写操作只给运维个人账号（与 P34 同权限），记 `runtime.configure`、`runtime.install`、`runtime.remove`；读者只看到底层与模型名，看不到错误详情。接口 `/v0/magpie/agents`（读）与 `/v0/magpie/agents/{configure,install,remove,autojoin,join}`（写）。

---

## §5 ACP 通道（P36.2）

`host/runtimes/acp.ts` 是一个通用 ACP 客户端通道（继承 `RuntimeChannelBase`），把 ACP 翻成常驻回合端口的那组帧，回合端口、看门狗、进度、用量、崩溃恢复都不改（P27 §1.2 的做法）：

| 回合信号 | ACP |
|---|---|
| 启动 | `initialize`（声明我们的客户端能力：不提供 `fs`、`terminal`——实测 dsh 从不调用它们，文件与命令由 harness 自己的工具做、经权限征询裁决）→ 首次 `session/new {cwd, mcpServers}`，之后按目录项用 `session/load` 或 `session/resume`；都不支持的每次新开并在首轮带 §6.3 的前情 |
| 发出一轮 | `session/prompt {sessionId, prompt: [{type:"text"}]}`；请求发出即补 user `message_end` |
| 正文 | `session/update` 的 `agent_message_chunk` 累积，到下一个工具调用或回合结束时出一条 assistant `message_end`；`agent_thought_chunk` 不进正文 |
| 工具 | `tool_call` → `tool_execution_start`；`tool_call_update` 的 `completed` / `failed` → `tool_execution_end` |
| 用量 | 目录项给的读取方式（dsh 读会话日志，见 §1.3）；ACP 的 `usage_update` 只是上下文占用的估计，不当用量；读不到时记 0 并标「底层未报告」，不估算 |
| 结束 | `session/prompt` 应答的 `stopReason`：`end_turn` → `completed`、`max_tokens` → `length`、`cancelled` → `aborted`、`refusal` 与错误 → `error` |
| 中止 | `session/cancel`；5 秒内没有应答才关子进程 |
| 权限 | `session/request_permission` 按常驻姿态裁决（与 Claude Code 的 `qianmo_permission` 同一套：工作区外读取、写入、shell；可批准的越界写入转 P14 审批），答 `allow_once` 或 `reject_once`，从不答 `allow_always` |
| 宿主工具 | qianmo 工具桥（`qm runtime-mcp`，令牌文件同 P27 §1.3）由目录项在启动配置里挂上（§1.3）；`session/new` 的 `mcpServers` 带该智能体的运维连接器（P32） |

每个 ACP harness 的差异（启动参数、凭据交法、状态目录、要关的东西）都在目录项的 `acp` 字段里，通道本身不分 harness。dsh 的具体做法见 §1.3 与调研记录。

隔离与 P27 相同（子进程 cwd 例外：会读启动目录配置的 harness 在该智能体目录下的空目录里启动，工作区只经 `session/new` 交给它），环境只放白名单变量加凭据，状态目录在 `qianmoConfigPath('runtimes', <id>, <智能体>)`，关掉遥测与自动更新，不加载用户级钩子与项目里的定制文件（能关的都关，关不掉的在 §1.3 写明）。

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

- **会话**：每对（发问的会话、被问的智能体）一条「对话」会话，长期复用，被问方记得之前问过什么；状态在 `qianmoConfigPath('qianmo','console','peers')`（0600，单实例锁），闲置 30 天清掉。第一行注明「来自 <发问方> 的提问」。
- **身份与授权**：经中枢，以发问会话主人的身份走 `ChatDispatch`（租户、白名单、额度），核对调用来自这条会话里还在等回答的那一轮，与后台任务（P29）同一套；每个目标记一条 `peer.ask` 审计（`A → B`、结果与错误码，不记正文）。不新增节点间直连。渠道的群聊与其他人的私聊、定时任务的会话不能发问。
- **防死锁（重入）**：节点一次只跑一轮（`NodeTurnGate`）。发问方的回合在等工具结果时占着闸门，被问方若在同一节点会永远排不上。所以中枢在发给被问方的 `task.request` 里签一条调用链 `chain: [{node, taskId}]`（由外到内，与任务主人证明一起签，`verifiedChain` 校验；没签或校验不过当没有链）。闸门维护一个正在运行的回合栈：栈不空时，只放行链里点名了**最内层**正在运行回合的那一轮（重入），其他回合一律等栈空；内层结束后回到发问方，发问方的其他回答先于排队的普通回合。链长至多 3（`LIMITS.maxAskChain`）；被问的智能体已在链里（A 问 B、B 又问 A）对该目标拒绝（`cycle`）；被问方在链上某节点已有一条未答的中枢消息时立即拒绝（`busy`）——它的收件读取被那一轮卡着，重入也到不了它。跨节点的环同样靠链识别。
- **时限**：缺省 300 秒、上限 1800 秒，并且不超过发问回合剩余期限减 30 秒；等待期间保持发问回合的看门狗不超时；超时的目标经 `turn.stop` 原生中止。各底层调用 qianmo 工具桥的 MCP 超时放宽到能等满这段时间。
- **与后台任务的分工**：`qianmo_ask` 用于几分钟内能答完的问题（审一段代码、问一个事实、要一个意见）；耗时的活仍用 `qianmo_task_start`。后台子任务里也能用 `qianmo_ask`，但不能再开任务（P29 不变）。
- **名册**：`qianmo_agents` 的底层与模型取各节点的 `runtime.status`。

### 6.3 换底层时对话接着走

每条会话不论底层都记一份「便携记录」（`portable.ndjson`，0600：每轮的用户文字（单条至多 4 KiB）、最终回答（8 KiB）、一行工具摘要（300 字节），保留最近 64 KiB；本地命令不记）。智能体换了底层（用户改了、或因 §3.3 退回 / 恢复）之后，已有会话的下一轮在新底层上开新的原生会话，第一轮前面带一段「前情」（最近若干轮，至多 12 KiB，注明来自哪个底层），之后照常续接。不支持续接的 ACP harness 进程重启时同样用它。

### 6.4 共享

- 技能、MCP 连接器、插件按 P32 对所有底层下发，各用原生方式加载（§5）。
- 长期记忆、通知、文件申请、专属电脑都是宿主工具，任何底层的智能体读写的是同一份。

---

## §7 原生扩展与官方前端（P36.7）

负责人 2026-10-17 追加：插件、MCP、技能等由各底层原生安装与原生配置，用户自由选择接入哪些底层；最好直接进入对应 harness 的官方前端管理；连接器由阡陌前端按阡陌的方式安装。依据调研 `native-extensions.md`（同目录，2026-10-17，六个 harness 均在临时状态目录与假密钥下实测）。

### 7.1 分工

| 来源 | 谁装、怎么装 | 落在哪 | 常驻运行时怎么加载 |
|---|---|---|---|
| **连接器**（MCP 服务、应用连接） | 控制台（P32、P25），秘密由中枢封存 | 不写进 harness 的原生配置，走「钉住层」：Claude Code 的 `--mcp-config` 文件、Codex 的会话 `-c mcp_servers.qm-*`、dsh 补丁里的插入行、ACP harness 的 `session/new.mcpServers`；名字统一加 `qm-` 前缀 | 每次启动重新生成；用户在原生前端里删不掉，也遮不住原生同名项 |
| **原生扩展**（各 harness 自己的插件 / 扩展、MCP 服务、技能、设置） | 用户在该 harness 的官方前端里装，或由控制台调用该 harness 自己的命令装（§7.3） | 该智能体的状态目录（`CLAUDE_CONFIG_DIR`、`CODEX_HOME`、`DSH_HOME`、`GEMINI_CLI_HOME`、`QWEN_HOME`、opencode 的 `XDG_*_HOME` 与 `HOME`），即原生文件 | 原样加载（§7.4 的例外） |

### 7.2 官方前端：`qm runtime open <智能体>`

节点命令，用与常驻子进程**同一份**环境构造（状态目录、凭据、空的启动目录、钉住层）启动该 harness 的官方前端，保证用户在前端里配好、试过的，就是常驻智能体运行时的样子。运维经 SSH 在节点上运行；控制台每个智能体给出这条命令（网页前端另给 `ssh -L` 转发的写法）。

| 底层 | 官方前端 | 做法 |
|---|---|---|
| Claude Code | 终端界面 `claude` | 预置 `.claude.json` 跳过首次引导；`--permission-mode default`（终端界面缺省是自动模式） |
| Codex | 终端界面 `codex` | 模型供应商经 `-c` 传入，无需登录 |
| dsh | 网页界面 `dsh web` | 在 **acp** 这个 profile 上启动（与常驻共用插件组合）；只绑回环，地址里带随机令牌，节点打印地址，不打开浏览器 |
| Gemini CLI | 终端界面 `gemini` | 预置 `security.auth.selectedType: "gemini-api-key"`，不出现登录选择 |
| Qwen Code | 终端界面 `qwen`；网页 `qwen serve` | 网页必须 `--require-auth` 加随机令牌 |
| opencode | 终端界面 `opencode`；网页 `opencode serve` | 网页必须设 `OPENCODE_SERVER_PASSWORD`、显式端口 |

前端里人就是审批者，所以前端不接节点的权限桥，其余钉住项照旧（钩子关、项目层不加载）。打开前端时取该智能体的底层锁：该智能体没有回合在跑才开，并先关掉它的空闲常驻子进程；前端退出后常驻按需重启。控制台不内嵌终端、不代理官方网页：前者要引入第三方终端组件（N-5 零依赖），后者要中枢到节点的 HTTP 隧道，本轮都不做。

### 7.3 控制台调用原生命令

控制链路 `runtime.ext.list` / `runtime.ext.install` / `runtime.ext.remove {agent, kind: plugin|mcp|skill, …}`：节点在该智能体的环境里、空的启动目录下、关掉标准输入并限时，执行该 harness **自己的**命令（调研 §2.2：如 `claude plugin install … -s user`、`codex plugin add … --json`、`dsh plugin --profile acp add`、`gemini extensions install … --consent`、`qwen extensions install … --consent`、`opencode plugin … -g`；MCP 用各自的 `mcp add/remove`；没有技能命令的按原生目录放 `skills/<名>/SKILL.md`）。每次操作后用原生的列表命令（有 JSON 的用 JSON）重读一遍，控制台「网关」页每个智能体显示「原生扩展」清单（插件、MCP、技能）与安装、卸载。安装来源只收 GitHub 仓库、npm 包名与该 harness 的官方市场名；只给运维个人账号，记 `runtime.ext.install` / `runtime.ext.remove`。会派生全部 MCP 服务的列表命令（Gemini、Qwen、opencode 的 `mcp list`）不用，改读它们的配置文件。

- **来源规则**（中枢先核对形状再记账，节点再核一遍）：GitHub 只认 `github.com`，不带账号、端口与查询串；npm 要精确版本；任何一段不能以 `-` 开头，拒绝 `..`、`%`、反斜杠与空白；MCP 服务要么给命令（裸命令名或绝对路径）、要么给不带账号与查询串的 https 地址，二者不兼得；`qm-` 开头的名字与 `qianmo` 留给阡陌。节点把服务命令放在 `--` 之后再交给 harness 的命令行，免得 `npx -y` 一类参数被当成 harness 自己的选项。
- **读取**：列表命令要起 harness 的命令行，所以页面只从中枢的缓存渲染，打开面板时缓存超过 1 分钟才重读；节点支不支持看第一次对该节点第一个智能体的探测（答 `unsupported` 就是旧节点，1 小时后再探）。
- **写入**：同一智能体同一时刻只跑一件装卸；5 秒内没答就显示「进行中」，页面每 3 秒跟进。审计目标是 `节点/智能体 种类:名称或来源`，不记参数与地址。官方前端开着时节点拒绝（「该智能体的官方前端正开着」）；该底层没有这类扩展时显示「该底层不支持这类扩展」。读者看得到清单与命令，看不到表单、卸载按钮与失败详情。
- **前端命令**：面板给出 `qm runtime open` 那一行并可复制；命令里带端口的（网页前端）另给一行 `ssh -L` 转发写法。

### 7.4 钉住层：原生配置改不动的几条

原生扩展是运维的信任决定，但下面几条由阡陌每次启动重新生成（命令行、环境变量或节点自有文件，从不写进原生文件），原生配置改不动：钩子关闭；会产生副作用的调用经节点裁决；不加载工作区里的项目级配置；不开 harness 自带的子代理。

| 底层 | 钉住层 | 常驻侧的改动 |
|---|---|---|
| Claude Code | `--settings` 标志层（`disableAllHooks`、`permissions.ask`、`env`、`apiKeyHelper`）+ `--permission-mode default` + `--setting-sources user` | 去掉 `--strict-mcp-config`，让用户级与插件自带的 MCP 加载；权限桥对 `mcp__qianmo__*` 直接放行（它们在宿主侧自行授权） |
| Codex | 会话 `-c`：工作区一律 `trust_level = "untrusted"`（必须写成内联表）、`project_doc_max_bytes=0`、仓库技能关闭、原生 MCP 工具逐个 `approval_mode="prompt"`；`thread/start` 带 `approvalsReviewer: "user"`；`--disable hooks` | **现网修复**：现在第一轮 `workspace-write` 会把工作区写成受信，之后工作区 `.codex/config.toml` 里的 MCP 服务不经询问就运行。另外 P32 的连接器改走 `-c`，不再整份重写 `config.toml` 与 `plugins/`（会抹掉原生安装与原生的授权记录） |
| dsh | `--patch` 文件 + 闸门插件第二版（最先注册、`tools.guard()`、缺省征询） | 原生插件对执行前事件答「允许」会绕过第一版闸门，第二版堵上 |
| Gemini CLI | `--admin-policy`（节点生成）+ `--allowed-mcp-server-names` + `--approval-mode default` | 工作区必须受信 MCP 才可用，于是项目层会被加载：项目 MCP 由策略挡住，项目 `GEMINI.md` 与项目技能仍会加载（没有开关），状态里写明。用户级 MCP 条目上的 `trust: true` 会跳过确认，节点每次启动前把它去掉——这是节点唯一改动原生配置的地方，控制台显示「已撤销预授权」 |
| Qwen Code | 该智能体自己的系统设置文件（`QWEN_CODE_SYSTEM_SETTINGS_PATH`：`disableAllHooks`、`permissions.ask`、项目技能关闭）+ `--approval-mode default` + `--allowed-mcp-server-names` | 项目 `QWEN.md` / `AGENTS.md` 仍会加载，状态里写明 |
| opencode | `OPENCODE_CONFIG_CONTENT`（每个代理的权限全部征询）+ `OPENCODE_PERMISSION` + `OPENCODE_DISABLE_PROJECT_CONFIG=1` + `OPENCODE_DISABLE_EXTERNAL_SKILLS=1` + `--pure` + 独立 `HOME` + 访问口令与显式端口 | 原生插件能在配置钩子里改掉权限、自带的工具从不征询，所以常驻运行时用 `--pure`：插件装得上、在前端里可用，常驻智能体不加载，控制台写明「常驻运行时不加载 opencode 插件」 |

另：所有底层都用该智能体自己的 `HOME`（opencode、Gemini、Qwen 现在会读到节点账号的 `~/.claude/skills` 一类目录）。

## §8 证据

| 项 | 状态 |
|---|---|
| dsh 经 ACP 跑通整轮（假模型接口） | 由 P36.2 实测后回写 |
| 其他 ACP harness | 逐项回写 `verified` |
| 真实 magpie 上 dsh 一轮 | 未评估 |
| `qianmo_ask` 同节点互问（重入） | 夹具子进程上通过（`residentPeers.integration.test.ts`，A 问 B、B 问 A 各一层）；未签链的对照组按时限超时 |
| `qianmo_ask` 跨节点 | 只有中枢单元测试，未端到端实测 |

---

## §9 工作包

| 包 | 内容 | 主要文件 | 完成标准 |
|---|---|---|---|
| P36.0 | 本文、章程 v3.6、路线图 v3.7、`runtimes-channels.md` 回写 | `docs/dev/*` | 合入 |
| P36.1 | 底层目录 | `host/runtimes/catalog.ts` | 目录项校验；中枢与节点同一份；类型从写死的两种改为目录 id |
| P36.2 | ACP 通道与 dsh 等适配 | `host/runtimes/acp.ts`、`host/runtimes/pool.ts`、`extensions.ts` | 假 ACP harness 脚本驱动的整轮：正文、工具进度、用量、权限放行与拒绝零副作用、中止、续会话、崩溃恢复；真 dsh 子进程在假模型接口上跑通一轮并调到宿主工具 |
| P36.3 | 安装 | `host/runtimeUpdate.ts`、`host/runtimes/smoke.ts` | 缺省安装、可选安装、卸载被占用时拒绝、兼容检查不过不装、退避重试 |
| P36.4 | 智能体配置、模型与退回 | `host/runtimeConfig.ts`、`providers/node.ts`、`commands/resident.ts` | 三级优先级；线路按偏好序取；六种退回原因与恢复；`runtime.status` |
| P36.5 | 「网关」页按系列配模型 | `commands/consoleMagpie*.ts`、`console/src/{routes,view}/magpie*.ts` | 自动接入；系列排序；手选不被覆盖；写权限与审计；页面各门禁 |
| P36.6 | 底层互通 | `host/peerTools.ts`、`commands/consolePeers.ts`、`resident/src/turn-gate.ts`、`capability` | 名册；单个与多个目标问答；同节点重入不死锁；环与超深链拒绝；便携记录与换底层前情 |
| P36.7 | 原生扩展与官方前端 | `host/runtimes/{runtimeEnv,nativeExt}.ts`、`claudeCode.ts`、`codex.ts`、`extensions.ts`、`catalog.ts`、`commands/runtimeOpen.ts`、网关页 | 同一份环境构造三处共用；六种底层的钉住层逐条有用例（含 Codex 受信泄漏的回归用例）；连接器不进原生文件；原生命令的列出、安装、卸载；`qm runtime open` 取锁与网页前端带令牌 |

## §10 不做

- 不 fork、不改任何 harness；不读写用户自己的登录态目录；不用订阅登录。
- 控制台不内嵌终端、不代理 harness 的官方网页（§7.2）。
- 不收只能经第三方 ACP 适配器接入的 harness，不提供「任意命令当底层」（那等于让运维之外的人在节点上跑程序）。
- 不替节点安装 Node.js、Python 等运行环境。
- 不在中枢转发模型请求（N-5 不变）。
