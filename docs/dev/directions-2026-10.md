<!-- Copyright 2026 Qianmo AgentNest Team -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# 阡陌 AgentNest — 2026-10 新方向设计（P19 ~ P25）

| 项 | 内容 |
|---|---|
| 文档版本 | **v1.0（生效）** |
| 日期 | 2026-10-11 |
| 核对基点 | 本仓库 `6fd9d2b0`（main，#201 合并提交，基座 omp v18.8.8）；本机 `codex-cli 0.162.0`、Claude Code 现行版 |
| 范围依据 | 负责人 2026-10-11 决定（对话记录）：① 接力改为插件形式，接入支持插件的 agent 工具，本机与服务器之间认证一次即可互通，不再维护 Claude Code 与 Codex 分支；② 节点之间互通文件、汇集成果；③ 用户可为节点的主智能体配专属电脑和浏览器；④ 同日追加五项：长期记忆、主动执行、云端电脑、按任务匹配模型、应用连接（日历、邮件） |
| 编号 | P19 ~ P25；包表见 §10 |
| 结论一句话 | 新增一条「中枢 → 节点」的签名控制链路和「节点 → 中枢」的上行调用，七个方向都挂在这两条线上；控制台为每个方向给出页面，后端能力由中枢统一授权和审计 |

由主 agent 按负责人 10-03 的常设委托（设计取舍自行裁定）定案。各节的「未评估」「未实测」是证据状态，不是授权门槛。

---

## §0 范围与口径

| 方向 | 编号 | 一句话 | 能力来源 |
|---|---|---|---|
| 接力插件化 | P19 | Claude Code、Codex 等工具装上阡陌插件，本机与控制台配对一次后即可转交、查看、接回 | 阡陌自研；插件格式用各工具公开的插件接口 |
| 节点间文件互通 | P20 | 节点按地址申请另一节点的文件，所有者授权后经中枢传输、核对摘要、记审计，可汇集到一个节点 | 阡陌自研 |
| 云端电脑 | P21 | 用户为节点的主智能体开一台专属电脑和浏览器，按节点隔离、可回收，敏感操作要用户确认 | 操作电脑和浏览器的能力来自基座；阡陌负责分配、隔离、回收、授权与审计 |
| 按任务匹配模型 | P22 | 在模型服务页给代码、对话、规划、看图、生图、视频等方向各指定模型 | 阡陌自研的路由与下发；生图、视频调用各厂商公开接口 |
| 长期记忆 | P23 | 智能体记住偏好、计划、项目和日常信息；用户在控制台查看、修改、遗忘 | 在 P16 记忆之上扩展 |
| 主动执行 | P24 | 定时让节点生成简报、跟进任务、整理邮件，结果推送给用户 | 在 P13 值守作业之上扩展 |
| 应用连接 | P25 | 日历、邮件等外部服务接到中枢，智能体经中枢调用，发信和建日程要用户确认 | 阡陌自研 |

**口径**（与章程 N-9、§5.8 一致）：

- 基座自带的浏览器、电脑操作、生图工具不算阡陌成果；对外写「能力来自基座，阡陌负责分配、隔离、回收和审计」。
- 没有用真实服务验证过的接口（生图、视频、邮件、日历的具体厂商）一律标「未评估」；夹具测试通过不等于接上了真实服务。
- 部署仍按观察窗口：本轮只开发与本机验证，不部署舰队。

---
## §1 公共底座：控制链路与上行调用

七个方向里有四个要求中枢对节点做事（开关云端电脑、读写记忆、读写文件、问状态），有两个要求节点向中枢要东西（申请别的节点的文件、调用中枢保管凭据的应用）。现有通道各管一件事（审批订阅、对话、值守作业、接力派发），本轮新增一条通用的，两个方向共用。

**不变的约束**：节点从不主动拨号（H-2，`resident/test/no-dial.test.ts`）；信封只有 JSON、单条不超过 256 KiB（`protocol/src/limits.ts`）；节点以 Ed25519 握手认出对端（`transport/src/frames.ts`）。

### 1.1 控制链路（中枢 → 节点）

| 项 | 定案 |
|---|---|
| 谁拨号 | 中枢的 `qm console` 进程按 `--control <节点>=<ws 地址>` 对每个节点拨一条链路，签名身份与值守作业、审批相同（`--print-wake-identity` 那一把）；10 秒重连一次 |
| 节点认谁 | 节点以 `--controller <节点名>=<公钥>` 列出可以下控制命令的中枢；不在集合里的对端一律 `E_CAP_INSUFFICIENT`。与 `--trust`（谁能派任务）、`--approver`（谁能批准）三个集合分开 |
| 消息 | 新类型 `node.control`（请求）与 `node.control.result`（应答，reply 类型，沿用请求的 taskId）。请求载荷 `{op, args, actor}`：`op` 形如 `desktop.enable`、`memory.forget`、`files.read`；`actor` 是发起这次操作的控制台主体（账号或 `admin`），只进审计 |
| 节点处理 | `resident.ts` 的 `#receive` 在 authz 之后、邮箱之前截住 `node.control`，按 `op` 的前缀交给注册的处理器；处理器返回 JSON 或错误码。未注册的前缀回 `E_UNSUPPORTED` |
| 审计 | 节点每处理一条写一行 `control.<op>`（来源 `control`），中枢在动作账本记一行；两边都带同一个 taskId |
| 超时 | 中枢等应答 30 秒；文件分块等单块 30 秒 |

### 1.2 上行调用（节点 → 中枢）

| 项 | 定案 |
|---|---|
| 怎么走 | 中枢在控制链路建立后发 `hub.subscribe`；节点把这条链路记为上行通道（同审批订阅的做法）。节点的宿主工具要调用中枢时发 `hub.call {callId, op, args}`，中枢回 `hub.call.result {callId, ok, value|error}` |
| 能调什么 | 本轮只有两类：`files.request`（P20）与 `connector.*`（P25）。中枢按 `op` 分发，未知的回 `unsupported` |
| 没有上行通道时 | 宿主工具直接返回「中枢未连接」，不排队、不重试；模型据此告诉用户 |
| 节点身份 | 中枢以链路握手认出的节点名为准，载荷里的节点名一律忽略 |

### 1.3 落点

- 协议：`atlas/packages/protocol` 增四个类型与载荷校验；`docs/dev/protocol.md` 增 §15。
- 节点：`atlas/packages/node/src/host/control.ts`（处理器注册表、上行调用客户端）。
- 中枢：`atlas/packages/node/src/commands/consoleControl.ts`（链路池、请求/应答关联、上行分发表）。
- 控制台端口：`deps.ts` 的各方向端口都由这一层实现，控制台包不直接碰传输。

---

## §2 P19 接力插件化

### 2.1 目标与完成标准

至少两种工具（Claude Code、Codex）装上阡陌插件后，本机与控制台配对一次，就能在工具里发起转交、查看进度、接回结果；omp 也能装同一个插件（它读 Claude Code 插件格式），但 omp 会话不作为转交来源。

不再为单个工具维护分支：节点续跑改用官方 Codex 的 app-server（`codex app-server`，状态目录用 `CODEX_HOME` 隔离），qmcode 保留为可选项，不再更新。

### 2.2 配对：认证一次

| 步骤 | 做法 |
|---|---|
| ① 控制台出配对码 | 「接力」页「添加设备」：成员及以上（或旧式管理令牌）点一下，得到一个 12 位配对码（形如 `K7QM-2XPA-9FDE`），10 分钟有效、只能用一次；中枢只存哈希，记下签发人 |
| ② 本机换设备令牌 | `qm handoff login <控制台地址> --code <配对码> [--name <设备名>]`。中枢核对配对码后建设备记录，回 `{deviceId, name, token}`；令牌 `qmd_` 开头，32 字节随机，只显示这一次，中枢只存 SHA-256 |
| ③ 本机落盘 | `~/.qianmo/qianmo/handoff/device.json`（控制台地址、设备号、设备名）与 `device.token`（0600、属当前用户、不是软链，读取时照 `readTokenFile` 的规矩检查） |
| 之后 | 所有 `/v0/handoff/*` 请求与 git 传输都用这枚设备令牌；不再要求每个仓库 `qm handoff init`，也不要 SSH 钥匙 |

设备令牌的权限：只能访问接力接口与本设备的 git 引用；以签发人的身份行事，签发人的账号被吊销或降为只读时，设备令牌随即失效。控制台「接力」页列出设备（名称、签发人、最近一次使用、平台），可以逐台吊销。配对接口按来源地址限流（每分钟 10 次），配对码错 5 次作废。

### 2.3 git 走控制台的 HTTPS

现有做法是用户自备 SSH 钥匙、运维手工把公钥贴进中枢的 `authorized_keys`。改为控制台直接提供 git 的 smart HTTP：

| 路径 | 做法 |
|---|---|
| `GET /v0/handoff/git/<项目>.git/info/refs?service=git-upload-pack\|git-receive-pack` | 起 `git <service> --stateless-rpc --advertise-refs <裸仓>` |
| `POST /v0/handoff/git/<项目>.git/git-upload-pack` 与 `…/git-receive-pack` | 起 `git <service> --stateless-rpc <裸仓>`，请求体（支持 gzip）接到标准输入，标准输出流式回给客户端 |

- 鉴权：`Authorization: Bearer qmd_…`。本机 git 经环境变量 `GIT_CONFIG_COUNT/KEY/VALUE` 传 `http.extraHeader`，令牌不进命令行参数、不进 `.git/config`。
- 设备隔离：`receive-pack` 带环境变量 `QIANMO_HANDOFF_DEVICE=<设备号>`，pre-receive 钩子在它存在时只放行 `refs/qianmo/wip/<设备号>/…` 与 `refs/qianmo/sessions/<设备号>/…`。
- 建库：`POST /v0/handoff/projects {project}` 在中枢本地 `--handoff-root` 下建 `<项目>.git` 并装钩子，幂等；项目第一次由谁建，就记谁为属主，别人的设备推送回 403。
- 旧的 `--hub user@host:root` + SSH 方式保留，已登记的仓库照旧工作。

### 2.4 任务归属

台账每个任务记 `ownerDevice` 与 `ownerSubject`。设备令牌只看得到、只能 send / attach / return 自己账号的任务；控制台页面上的人按原有角色看全部。`GET /v0/handoff` 的过滤从客户端挪到中枢。

### 2.5 来源工具

| 工具 | 会话位置 | 回合结束同步 | 状态 |
|---|---|---|---|
| Claude Code | `~/.claude/projects/…/<会话>.jsonl`（由 hook 输入给出） | 插件的 `hooks/hooks.json`：`Stop`（async）与 `SessionEnd` | 已有，改由插件安装 |
| Codex（官方） | `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*-<线程>.jsonl`，未设时 `~/.codex` | 插件 hooks（Codex `hooks` 特性，稳定版默认开） | 新增；格式与 qmcode 相同，按 `codex` 记 |
| qmcode | `$QMCODE_HOME` | 内置 notify | 保留，不再更新 |
| omp | — | — | 能装插件、能调用转交工具查看与接回；omp 自身会话暂不作为转交来源 |

`qm handoff sync --hook auto` 按 hook 输入里的 `transcript_path` 判断是哪种工具，插件只写这一条命令。

### 2.6 插件包

放在 `atlas/plugins/qianmo/`，仓库根放 `.claude-plugin/marketplace.json`（Claude Code 与 Codex 都读这个格式）。`qm handoff plugin install --tool claude-code|codex|omp` 把同一份插件写进 `~/.qianmo/qianmo/plugin/`，再调用各工具自己的命令登记本地 marketplace 并安装；不改各工具的其他配置。

| 文件 | 内容 |
|---|---|
| `.claude-plugin/plugin.json`、`.codex-plugin/plugin.json`、`plugin.json` | 名称 `qianmo`、版本跟随阡陌发行号、说明、`mcpServers: ./.mcp.json` |
| `.mcp.json` | `qianmo → qm handoff mcp` |
| `hooks/hooks.json` | `Stop`、`SessionEnd` → `qm handoff sync --hook auto` |
| `commands/handoff.md`、`pull.md`、`status.md`、`login.md` | `/qianmo:handoff` 等；正文只指示模型调用对应 MCP 工具或运行 `qm handoff login` |
| `skills/qianmo-handoff/SKILL.md` | 用户说「交给云端」「我要关机了」时调用 `qianmo_handoff`，并把目标、已完成、剩下的写清楚 |

MCP 工具沿用 P17 的五个（`qianmo_status`、`qianmo_handoff`、`qianmo_task`、`qianmo_send`、`qianmo_pull`），另加 `qianmo_login_status`（只读：是否已配对、控制台地址、设备名）。

### 2.7 节点续跑换成官方 Codex

`qm handoff node` 增 `--app-server-bin`（默认 `codex`）与 `--app-server-home-env`（默认 `CODEX_HOME`）；节点的 app-server 用 `-c mcp_servers={} -c notify=[]` 起，避免反向调用。`qm handoff attach` 调本机 `codex resume --remote …`（`--client-bin` 可改回 `qmcode`）。官方 Codex 0.162 的 `resume --remote`、`--remote-auth-token-env`、app-server 都已核实存在；Claude Code 会话导入沿用 `externalAgentConfig/import`。

---
## §3 P20 节点间文件互通

### 3.1 流程

节点不拨号、信封只有 JSON，所以文件经中枢中转、分块搬运：

| 步 | 谁 | 做什么 | 审计 |
|---|---|---|---|
| ① 申请 | 节点 A 的主智能体调 `qianmo_file_request {from: "qianmo://B/<agent>", path, reason}`；或控制台用户在「文件互通」页直接发起 | 经上行调用 `files.request` 到中枢，中枢记一条待批申请 | `files.requested` |
| ② 授权 | B 的所有者（B 所在租户的成员及以上；未开账号时为管理令牌） | 在「文件互通」页批准或拒绝；批准时写明范围（一个文件或一个目录前缀）与有效期（默认 1 小时，最长 24 小时） | `files.granted` / `files.denied` |
| ③ 取 | 中枢 → B | `files.stat` 得到清单（每个文件的相对路径、大小、SHA-256），再按 128 KiB 一块 `files.read` | B：`files.read` |
| ④ 核对 | 中枢 | 在中枢暂存目录逐文件算 SHA-256，与清单不一致整次作废 | `files.verified` / `files.rejected` |
| ⑤ 送 | 中枢 → A | `files.write` 分块写进 A 的暂存目录，`files.commit` 时 A 再算一遍摘要，一致才移进工作区 `inbox/<B 节点>/…` | A：`files.delivered` |

由用户在页面上直接发起的传输，发起人同时是 A、B 的所有者时，②省掉，记一条 `files.granted`（`by: 发起人`）。

### 3.2 汇集

「汇集」是一组传输：选一个目标节点和若干来源（节点 + 路径），每个来源各走一遍 ③–⑤，落在目标节点 `inbox/<来源节点>/…` 下。页面上整组显示进度，任何一项失败不影响其余各项，失败项可单独重试。

### 3.3 界限

| 项 | 规矩 |
|---|---|
| 能读什么 | 只读 B 的智能体工作区内（`--agent <名>=<目录>` 给的目录），不跟随指向工作区外的软链；`.git`、`.qianmo`、`.omp`、`.ssh` 与 `inbox/` 不出；命中接力秘密扫描规则（`@qianmo/handoff` 的 `secrets.ts`）的文件拒绝传出并在审计里写明 |
| 多大 | 单个文件 64 MiB，一次传输 256 MiB、1000 个文件；超出拒绝 |
| 写到哪 | 只写 A 工作区下的 `inbox/`，同名文件不覆盖，另存为 `<名>.<传输号前 8 位>` |
| 授权再用 | 授权在有效期内可以重复取（例如数据更新后再取一次），过期或被撤销后拒绝 |
| 暂存 | 中枢暂存在 `<中枢配置根>/qianmo/files/<传输号>/`，传完删除；节点暂存在 `<节点配置根>/qianmo/files/<传输号>/`，智能体读不到 |

### 3.4 落点

协议没有新消息类型，全部走 §1 的 `node.control`（`files.stat|read|write|commit|abort`）与 `hub.call`（`files.request`）。节点侧 `atlas/packages/node/src/host/files.ts`；中枢侧 `consoleFiles.ts`（申请、授权、传输三张账本，`files.ndjson`）；宿主工具 `qianmo_file_request` 只给主智能体。

---

## §4 P21 云端电脑（专属电脑与浏览器）

### 4.1 分配与隔离

用户在控制台「云端电脑」页为某个节点的主智能体打开「专属浏览器」或「专属电脑」，经控制链路下发 `desktop.enable`。节点的宿主据此起一套环境：

| 项 | Linux 节点 | macOS 节点 |
|---|---|---|
| 显示 | 独立的 Xvfb（`:<编号>`，1440×900），只监听本机 Unix 套接字 | 不提供专属电脑（会操作真实桌面）；只开专属浏览器 |
| 浏览器 | 节点自己起 Chromium：`--user-data-dir=<节点配置根>/qianmo/desktop/<agent>/browser`、`--remote-debugging-port=<随机>`、只绑 127.0.0.1；在该 Xvfb 上有头运行 | 无头 Chromium，同样的独立资料目录 |
| 给 omp 的配置 | 会话覆盖层写 `browser.enabled: true`、`browser.cdpUrl: http://127.0.0.1:<端口>`；开电脑时 `computer.enabled: true`，子进程环境 `DISPLAY=:<编号>`、删掉 `WAYLAND_DISPLAY` | 只有浏览器那一半 |
| 归属 | 资料目录、下载目录、登录状态都在这个节点、这个智能体名下；别的节点、别的智能体看不到 | 同左 |
| 回收 | `desktop.recycle`：停浏览器与 Xvfb，删资料目录；`desktop.disable` 只停不删 | 同左 |

### 4.2 授权与审计

浏览器与电脑操作在 omp 里是 `eval` 的前导函数（`browser`、`computer`），扩展事件看不到单次操作。处理办法：

1. 节点开了云端电脑时，主智能体的工具表放出 `eval`，覆盖层把 `tools.approval.browser`、`tools.approval.computer` 设为 `prompt`，每次操作都会向宿主请求批准。
2. 宿主收到这类请求：读操作（截图、读页面、查元素）直接放行；会改变外部状态的操作（点击、输入、提交、下载）按节点的确认策略处理——「敏感操作要确认」（默认）时，命中账号、付款、发送类关键词或输入框是密码、卡号类的，转成 P14 审批请求，由用户在控制台或对话里批准；其余放行。「每次都要确认」时全部转审批。
3. 每次操作都写审计 `desktop.action`（操作类别、目标网址的主机名、是否经过确认），不记输入的正文。

为了让宿主看得到操作类别，基座的两个前导函数各补一个 `formatApprovalDetails`（只把参数里的操作名、选择器类型、主机名写进批准提示），登记在 `base-modifications.md`，理由是扩展接口拿不到前导函数的参数。`eval` 本身仍受工作区路径与沙箱约束。

### 4.3 落点

节点：`atlas/packages/node/src/host/desktop.ts`（分配、进程看护、回收、状态）、`residentOmp.ts` 的覆盖层与环境、`extension/src/policy.ts` 放行 `eval` 的条件分支；中枢：`consoleDesktop.ts`；控制台「云端电脑」页。

---

## §5 P22 按任务匹配模型

### 5.1 任务方向

| 方向 | 说明 | omp 角色 | 工具 |
|---|---|---|---|
| 编程（默认） | 写代码、改 bug、跑测试 | `default`、`task` | 原有 |
| 对话与简报 | 日常问答、整理、写简报 | 自定义角色 `chat` | 原有 |
| 规划与推理 | 方案、拆解、复杂分析 | `plan`、`slow` | 原有 |
| 快速小任务 | 标题、摘要、压缩 | `smol`、`commit`、`tiny` | — |
| 看图 | 读截图、图表 | `vision` | — |
| 生图 | 按描述生成图片 | `image` | 基座 `generate_image` |
| 语音 | 文字转语音 | `speech` | 基座 `tts` |
| 视频 | 按描述生成短视频 | 自定义角色 `video` | 阡陌宿主工具 `qianmo_generate_video` |

### 5.2 怎么选

- **页面**：模型服务页增「任务分工」卡片，每个方向选一个模型服务和其中一个模型；不选的方向跟随主模型，生图、语音、视频不选就不开对应工具。可以按节点覆盖。
- **自动匹配**：任务进来时，中枢派发的请求可以带 `direction`（定时任务、对话页都能指定）；没带时节点按任务文字做一次确定性的归类（关键词表在 `atlas/packages/providers/src/directions.ts`，例如「画、海报、插图」→生图，「视频、短片」→视频，「计划、方案、分析」→规划，代码与报错特征→编程，其余→对话），用该方向的模型开这一轮。归类结果写进审计 `model.route`，页面上能看到每个节点最近 20 次的归类。
- **下发**：沿用第六类动作，`apply` 由一个档案扩为「主档案 + 被引用的档案 + 路由表」；节点编译成多个 `qm-*` provider 与完整的 `modelRoles`，生图、语音模型带上 `kind` 与 `api`。

### 5.3 预设与口径

新增生图（OpenAI Images、Gemini 图片、OpenRouter 图片）、语音（OpenAI Speech）、视频（OpenRouter 视频）预设，全部标「未评估」。现有网关（api2）只提供 `gpt-6-luna`，所以本轮能实测的只有对话类方向的路由与切换；生图、语音、视频只做到夹具验证。

---

## §6 P23 长期记忆

### 6.1 问题

P16 的记忆按「智能体 + 会话」分区，每个对话、每个值守作业各是一个分区。于是在一次对话里记下的偏好，下一次对话就看不到。

### 6.2 做法

| 项 | 定案 |
|---|---|
| 长期分区 | 每个「智能体 × 已验证账号」一个长期分区（工作层，账号主体 `u:…` / `legacy:admin`；`taskId` 用独立的 `l-` 命名空间）。每一轮的冻结召回同时取「本会话分区 + 请求者的长期分区」，预算不变（50 条 / 2 万字），长期分区优先；无已验证身份不读写长期分区 |
| 类别 | 用标签 `kind:preference`（偏好）、`kind:plan`（计划）、`kind:project`（项目）、`kind:daily`（日常）；不改记录格式 |
| 谁来写 | 智能体的 `qianmo_memory_write` 增可选参数 `kind` 与 `scope: "long"`；仍然每条都要用户批准（P14，单次批准）。用户在控制台写的直接生效，来源 `user:console:<账号>`，信任高于智能体写的 |
| 改与忘 | 沿用「不原地改」：修改 = 新写一条并 `supersedes` 旧的；忘记 = `revoke` 并写原因；事实过期 = `invalidate` |
| 控制台 | 「记忆」页：选节点与智能体，按类别筛、按文字搜；新增、修改、忘记、标为过期；看每条的来源与历史 |
| 通道 | 控制链路 `memory.list|add|edit|forget|invalidate`；节点用 `FileMemoryStore` 以运维写者身份执行，分区校验沿用 `requireInPartition` |

语义检索仍默认关闭，长期记忆走确定性召回；不把「记得住」说成「答得准」，回答质量仍以 P16 的评测为准。

---

## §7 P24 主动执行

### 7.1 定时任务

在控制台里建、改、停，不用改文件、不用重启进程。调度放在中枢 `qm console` 进程里，经对话面（`consoleChat.ts` 的 `send`）把提示词送进该智能体的一个专属会话，回复正文与对话记录一起保存。原有 `qm watch` 值守作业保留、页面上照旧只读。

| 字段 | 说明 |
|---|---|
| 目标 | `qianmo://<节点>/<智能体>` |
| 时间 | 每天 HH:MM；每周几 HH:MM；每隔 N 分钟或 N 小时（最短 15 分钟）；时区默认 Asia/Shanghai |
| 内容 | 模板：晨间简报、跟进待办、整理邮件（需要 P25 邮件连接）、自定义；模板只是预填的提示词，用户可改 |
| 方向 | 可选 P22 的方向，默认「对话与简报」 |
| 通知 | 结果推送到一个或多个通知渠道；可选「只在智能体主动通知时推送」 |
| 状态 | 启用 / 停用；超时（默认 10 分钟） |

每次运行记一行：计划时间、实际时间、任务号、结果（完成 / 失败 / 超时 / 跳过）、回复前 2000 字；页面上能看历史并跳到对应会话。同一任务上一轮没结束时，这一轮记「跳过」。紧急停止文件对定时任务同样生效。

### 7.2 通知渠道

控制台「主动执行」页管理渠道：通用 Webhook、Bark、企业微信群机器人、飞书群机器人、ntfy。地址里含密钥的只显示主机名。发送失败记进运行记录，不重试超过 3 次。各渠道只按公开文档写了请求格式，没有对真实服务发过，标「未评估」。

---

## §8 P25 应用连接

### 8.1 做法

凭据只留在中枢：节点上的智能体调宿主工具，宿主经上行调用把请求交给中枢，中枢用保管的凭据访问外部服务，把结果交回。

| 连接 | 协议 | 宿主工具 |
|---|---|---|
| 邮件 | IMAP（读）+ SMTP（发），TLS | `qianmo_mail_search {query?, folder?, since?, limit?}`、`qianmo_mail_read {id}`、`qianmo_mail_send {to, subject, body}` |
| 日历 | CalDAV（读写），或 ICS 订阅地址（只读） | `qianmo_calendar_events {from, to}`、`qianmo_calendar_create {title, start, end, location?, notes?}` |

### 8.2 界限

- 发信、建日程每次都要用户批准：节点先走 P14 审批（批准绑定这次调用的全部参数），批准后才发上行调用；中枢再按连接的授权表核对这个智能体能不能用它。
- 读邮件只取纯文本正文前 64 KiB，附件只列名称和大小；不下载附件。
- 凭据用模型密钥同一套信封加密（`consoleProvidersSecrets.ts` 的做法）存在中枢，页面只显示「已设置」和设置时间。
- 每次调用写审计 `connector.<操作>`（连接名、结果、条数），不记邮件正文与收件人地址的完整值（只记域名）。
- 预设：QQ 邮箱、163 邮箱、Gmail（应用专用密码）、Outlook、自定义；iCloud 与自定义 CalDAV、ICS 订阅。全部标「未评估」，本轮用夹具服务器验证协议实现。

---

## §9 控制台页面

| 区域 | 侧栏分组 | 页面 | 对应 |
|---|---|---|---|
| 接力 | 运行 | 已配对设备（添加、吊销）、接力任务（状态、节点、结果、接回） | P19 |
| 文件互通 | 运行 | 待批申请、授权（撤销）、传输与汇集（进度、摘要核对结果、重试） | P20 |
| 记忆 | 运行 | 按节点与智能体浏览、筛选、搜索、新增、修改、忘记 | P23 |
| 主动执行（原「值守作业」） | 运行 | 定时任务（新建、编辑、启停、立即运行、运行历史）、通知渠道、原值守作业（只读） | P24 |
| 云端电脑 | 配置 | 每个节点的专属浏览器 / 电脑：开关、确认策略、状态、回收 | P21 |
| 模型服务 · 任务分工 | 配置 | 方向 → 服务与模型；最近的自动归类 | P22 |
| 应用连接 | 配置 | 邮件与日历连接：新增、测试、授权给哪些智能体、最近调用 | P25 |

前端规矩不变：服务端渲染、零依赖、零外部资产、CSP 只放行内联脚本的哈希；写操作先 `admit` 再 `record`；只读角色看不到写控件；窄屏可用。

---

## §10 工作包

| 包 | 内容 | 主要文件 | 完成标准 |
|---|---|---|---|
| P19.0 | 本文与章程、roadmap 回写 | `docs/dev/*` | 合入 |
| S0 | 控制链路与上行调用 | protocol、`host/control.ts`、`consoleControl.ts` | 两节点进程内往返、拒绝未授权控制者、无上行通道时宿主工具明确报错 |
| P19.1 | 配对、设备令牌、HTTPS git、任务归属 | `handoff*.ts`、`consoleHandoff*.ts`、`routes/handoff.ts` | 真 git 客户端经控制台推送与取回；别的设备的引用推送被拒；吊销后 401 |
| P19.2 | 官方 Codex 来源与节点续跑 | `handoffTranscript.ts`、`handoffNode.ts`、`handoffAttach.ts` | 官方 Codex 会话样本转交、假 app-server 续跑通过 |
| P19.3 | 插件包与安装命令 | `atlas/plugins/qianmo/`、`.claude-plugin/marketplace.json`、`handoffPlugin.ts` | 本机 Claude Code 与 Codex 各装上一次并列出 MCP 工具；hook 触发同步 |
| P20 | 文件互通 | `host/files.ts`、`consoleFiles.ts` | 两节点真文件往返与摘要核对；越界路径、软链逃逸、秘密文件、过期授权全部被拒 |
| P21 | 云端电脑 | `host/desktop.ts`、`consoleDesktop.ts`、policy 与覆盖层、基座两处 `formatApprovalDetails` | 本机起独立资料目录的浏览器并被 omp 接上；敏感操作转审批；回收后目录不在 |
| P22 | 按任务匹配模型 | `@qianmo/providers`、`compile.ts`、`node.ts`、`consoleProviders*.ts` | 多档案编译与 `modelRoles`；归类表单测；真 key 切换对话类方向 |
| P23 | 长期记忆 | `memory-sidecar.ts`、`residentMemoryWrite.ts`、`host/memoryControl.ts` | 一次对话写入、另一对话召回；控制台改与忘生效且留痕 |
| P24 | 主动执行 | `consoleSchedules.ts`、`consoleNotifyChannels.ts` | 按时区算下一次运行；到点经对话面执行并保存回复；渠道请求形状单测 |
| P25 | 应用连接 | `consoleConnectors.ts`、`host/connectorTools.ts`、IMAP/SMTP/CalDAV/ICS 客户端 | 夹具服务器上读信、发信、读写日程；发信未批准时零副作用 |
| UI | 七个页面 | `atlas/packages/console/src/{routes,view}/*` | 页面测试、角色测试、真 Chrome 页面测试、窄屏 |

## §11 本轮不做

- 不部署舰队（观察窗至 2026-10-17）；不对外发布插件到公共 marketplace。
- 不做节点之间直接拨号；文件不走 P2P。
- 不做附件下载、邮件规则、自动回信；不做日历邀请的回复。
- 不让中枢代节点调用大模型（章程 N-5 v2.22 原样有效）；生图、视频由节点调用。
- 记忆的语义增强仍默认关闭。
