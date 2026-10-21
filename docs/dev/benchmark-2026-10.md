<!-- Copyright 2026 Qianmo AgentNest Team -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# 阡陌 Qmo — 竞品对标（2026-10）

| 项 | 内容 |
|---|---|
| 文档版本 | v1.1（2026-10-21，补 §9 复刻规格与 REA 证据） |
| 对象 | Meta Muse、Grok Bot（xAI）、Devin（Cognition）、Claude Desktop（Anthropic） |
| 核对基点 | 阡陌 `origin/main` `baf0048c1`（含 #262）；各产品公开页面与帮助文档 2026-10-21 抓取；客户端 Muse 8.0、Grok Bot 0.72.1、Devin Desktop 3.10.67、Claude Desktop 3.1623.0 |
| 方法 | 只读官方站点、帮助中心、更新日志、官方视频页；四个 Mac 客户端只做静态读（REA 与文件检查），不运行、不登录；阡陌用 `atlas/packages/console/test/preview/serve.ts` 以运维账号查看 `/` 与 `/admin` |
| 结论一句话 | 四家都把「智能体在后台干活、人只在关键处出现」做成了界面的主线：状态先行的侧栏、不走对话的审批卡、可看可接管的电脑、跑完再通知；阡陌这几项能力大多已有，差在呈现与上手，排序清单见 §8 |

## §0 口径

- 价格是 2026-10-21 官网标价，美元，未含税。
- 「需登录可见」的内容没有核对；三家（Muse、Grok Bot、Devin）的实际登录后界面只来自官方帮助文档、设计文章和客户端包里的静态内容。
- 客户端只从厂商官网下载，签名都核过（Developer ID 且已公证）：Muse 签名方 Meta Platforms，Grok Bot 签名方 Anysphere（Cursor 的公司），Devin.app 签名方 Exafunction（Windsurf 原公司）。安装包放在会话临时目录，没有装进系统。
- 界面文字一律转述，只引用单个标签。
- 「推断」是本文的判断，其余每条都有出处。逐家原始笔记（每条带网址或包内路径）在 `~/atlas-evidence/2026-10-21/benchmark/`。
- REA 只做静态分析与未登录网页外壳的分析，证据号与覆盖范围集中在 §9.1；静态分析只说明包里有什么，不说明运行时一定这样走。

## §1 一览

| | Meta Muse | Grok Bot | Devin | Claude Desktop |
|---|---|---|---|---|
| 是什么 | 个人智能体，每人一个，替人把事办完 | 常驻的智能体团队，多个 Bot 共用一台云电脑 | 团队用的自主软件工程师 | 一个 app 装下 Claude 的问答、任务和写代码 |
| 发布 | 2026-09-08 | 2026-08-11 | 2024 起；2026-06 统一品牌 | 桌面版 2024 起；09-16 Chat 与 Cowork 合并 |
| 客户端 | iOS、Android、网页、Mac、WhatsApp | Mac、Windows、Linux、iOS、Android，无网页 | 网页（可装 PWA）、Desktop、CLI、IDE（ACP） | Mac、Windows、Linux beta、网页、iOS、Android |
| 地区 | 美国、加拿大 | 官方支持地区；X 入口部分地区不开 | 官方支持地区 | 官方支持地区 |
| 起步价 | 免费；Power $20 | Premium $30 起 | Free；Pro $20 | Free；Pro $20 |

## §2 Meta Muse

**是什么**。Meta Superintelligence Labs 的个人智能体 app，2026-09-08 发布，由自家 Muse Spark 模型驱动，Muse Wonder 先给订阅用户。首发美国，现为美国和加拿大、18 岁以上。App Store 效率类第一，Google Play 500 万以上下载。

**信息结构**。手机底部五个标签：Chat、Feed（按用户写的提示生成内容流）、Ideas（主动建议）、Goals（每个目标一条状态和时间线）、Library（全部产出）。顶部头像兼做状态栏，实时写它在干什么；点开是活动记录（已做、计划做、待批准）、Upcoming（定时与提醒）和三份可直接编辑的 md 文件（记忆、性格、身份）。对话只有一条长主线，可另开 side chat，上下文在主线和旁支之间共享。设置分连接器、权限、数据（是否用于训练、导入别家记忆、下载、重置）、账号、用量。

**后台与并行**。关掉 app 照常推进；跑完一段先判断值不值得打扰，有新情况或要输入才通知。官方说会派出成群的子代理，浏览器活交给专门的浏览器子代理；界面怎么展示子代理没有公开。

**审批**。由独立进程 Sentinel 放行连接器动作和所有出网请求，智能体绕不过；审批框由客户端直接画，不经过对话。授权范围有仅此一次、本任务、本网站、始终、拒绝，可展开看任务详情。连接器默认「部分操作先问」（写操作和重要的读操作），网页默认访问陌生站点或可能外泄个人信息时问。读过用户数据的进程，其出网请求不再自动放行（污点出网），没碰过用户数据的低风险请求直接过，以此压低审批次数。每笔购买单独批准，用 Link 生成限商户、限额、限时的一次性虚拟卡。

**模型**。不给用户选。

**电脑与浏览器**。每人一台隔离的 Linux VM，带 Chromium、文件系统和终端；智能体在 systemd-nspawn 容器里，与凭据服务、审批进程分属不同安全域；智能体只拿替代令牌，真实凭据在出网时注入。浏览器可实时看、接管（接管期间智能体暂停）、终止；网站登录走专门的录入界面进凭据库，模型看不到。Mac 版能操作本机：信息、备忘录、邮件等逐个设关闭、只读或读写，删除进废纸篓。已宣布 Confidential VM（整机用户密钥加密）。

**集成与渠道**。连接器在设置里连或一句话连；同一 Meta 账号下的 Facebook、Instagram、Threads 自动连；可让 Muse 给没有现成连接器的服务自建。商用工具十几种，零售与支付（Shop Pay、PayPal）在扩。渠道：自家 app 与 WhatsApp；自有邮箱、AI 眼镜、语音、口袋设备已宣布。

**上手**。要 Meta 账号；起名、定头像和性格是官方认定的核心步骤；前几天靠提示引导，Ideas 标签补「不知道从哪开始」。

**价格**。免费有每周上限；Power $20/月（每周 5 亿 token）、Maximum $100/月（每周 30 亿 token）；另售不过期的 token 包。

**客户端静态读**（Muse.app 8.0，`com.meta.endo`，只读包内文件）：

- 形态：原生 Swift 外壳加载一个单文件 React 前端（`Resources/hatch/index.html`，约 45 MB），智能体跑在云端 Linux VM，客户端经加密通道直连 VM；Mac 自己也注册成一个节点，提供本机命令、截屏、本机应用等能力。前端里有三百多条网关路由。推断：结构与 OpenClaw 一类「网关 + 节点」相近（身份、性格、用户、记忆各一份 md）。
- 导航：左侧 Dock 是 Chat、Search、Feed、Ideas、Goals、Library，部分情况多一个 Agents；右侧状态面板分活动、审批、电脑（可开关）、即将运行、身份、邮箱（可开关）。外部渠道来的会话在侧栏标「只读」。智能体可以直接操作界面（跳到某页、给出建议、高亮某处），设置里有开关。
- 状态：智能体状态有十几种，包括等审批、后台等审批、工作中、生成中、压缩上下文、等子代理、额度用完、VM 预热、离线；工作中可带一句活动说明。任务状态：排队、启动、工作、等你、暂停、完成、失败、停止。活动记录区分主线与子代理条目。
- 审批：主按钮「允许」，下拉里按对象给范围：本次、本任务、本任务全部网页、本定时任务、本工件、本创意、本 Feed、始终、此站始终、此连接器始终；拒绝也分本任务与永久。详情列动作、目标、网址、进程、命令；可批量处理；审批会过期；对外发送的消息可以先改再批；有待批时输入框能打字但发不出去。外发白名单按域名、主体、目的地、收件人四种粒度。
- 本机：计算机控制、浏览器自动化、运行命令三项各选每次问、始终允许、始终拒绝；本机应用分只读、可读可操作、屏蔽；文件读与写删分开授权；钥匙串、SSH 私钥目录和废纸篓对智能体不可见。
- 模型：VM 菜单里有「模型」子菜单，列表由服务端下发，格式 `厂商/模型`；切换模型会开新上下文。内部设置里主线与子代理的推理强度分开设（低到最高五档，默认高）。帮助文档没写这些，对普通用户是否开放未知。
- 渠道：WhatsApp（扫码绑定，并提示扫码等于把智能体的控制权交出去）、Telegram（用户自建 bot token）、iMessage（智能体有自己的号码）、Messenger；Muse Mail 给智能体一个邮箱，可设可信发件人直接给它下指令，外发要审批。
- 上手顺序：欢迎 → 候补或邀请码 → 年龄与账号核验 → 条款 → 三条风险告知（能替你动手、昼夜在跑、仍在学习）→ 装手机 app → 连接器 → 勾选建议任务 → 定名字、头像和性格 → 四个标签介绍 → 第一句话。Mac 端另有逐个应用选权限的一步。
- 其他：智能体在回复里写连接链接，前端渲染成连接卡片；两个用户的 Muse 可以配对互通（比对验证码），每个对端有单独的分寸说明文件；导入别家记忆支持 ChatGPT、Claude、Gemini、Meta AI 的导出包。

来源：<https://about.fb.com/news/2026/09/introducing-muse-personal-ai-agent/> · <https://introducing.muse.ai/> · <https://research.meta.ai/blog/security-and-safety-for-ai-agents-our-approach-with-muse> · <https://ai.meta.com/muse/download/> · <https://www.meta.com/help/artificial-intelligence/1385290430137537/>（审批）· <https://www.meta.com/help/artificial-intelligence/2124746764949121/>（浏览器）· <https://www.meta.com/help/artificial-intelligence/1126304576638594/>（Mac）· <https://www.meta.com/help/subscriptions/1021145227643680/>（订阅）· <https://apps.apple.com/us/app/muse-from-meta/id6760173601>

## §3 Grok Bot（xAI）

**是什么**。2026-08-11 发布的常驻智能体团队，每个用户一台云电脑，7×24 运行。「Grok Bot」不是 X 里的 @grok 问答：后者是 Grok 主应用的一个入口。Grok Bot 实际由 Cursor（Anysphere）承建运营：用 Cursor 账号登录，云电脑跑在 Cursor 云上，Mac 客户端由 Anysphere 签名，条款在 cursor.com。10-12 起 Grok、Grok Bot、Cursor、X Premium 并进同一个订阅。时间线：08-26 扩套餐，08-29 接 X，09-03 企业版，09-28 Team Bots 公测。

**信息结构**。产品只露五个对象：Bot、Chat、Prompt（可存成 Skill 或 Routine）、Tool、Artifact。侧栏放 Bot 名册，不放会话历史；头像动效就是状态（空闲、思考、工作、等待、受阻、完成），悬停才显示当前动作。工具和技能归账号，记忆和 Routine 归单个 Bot。输入框有附件、听写、实时语音，`/` 调技能，`@` 提及 Bot、群、Routine 或连接器，Bot 干活时可插话。正文、邮件草稿卡、「已创建 Routine」这类事件卡排在同一条时间线上。设置分通用、电脑、用量与账单、更新；插件不在设置里，在侧栏的连接入口。侧栏有三种关注状态：需要处理、未读、工作中。⌘K 命令面板。

**后台与并行**。活跑在云电脑上，关笔记本不停。Routine 按时间或事件（GitHub、Slack、Linear、webhook、邮件标签）触发，每个 Bot 最多 50 个、保留最近 20 次运行、间隔不少于 5 分钟，有试跑；用户长期不在会先问要不要继续，没回应就暂停。主 Bot 带星标，会主动认领能接的活。Bot 之间异步发消息，群聊 2–6 个 Bot，常见做法是设一个统筹。Bot 可开 Project，由云端 agent 规划后再跑子 agent。Stop 连带停掉后台子 agent 和云端 agent，挂着的审批同时失效。通知按设备走：在桌面推桌面，等输入约 3 分钟后再推手机。

**审批**。审批卡三个选项：允许一次、始终允许、拒绝。不是用户在场时触发的审批（例如 Routine 发起）约 10 分钟过期，不执行。Auto Review 是独立的审查模型，管 shell、插件、电脑操作、Routine 写入和启动子 agent；规则用自然语言写，分「先问」和「自动允许」两类，冲突时先问优先。发送、发布、购买、删除前先回看用户消息里有没有批准。登录、两步验证、验证码由用户点「接管」处理，完成后交还；全屏打开默认只看，按「接管控制」才动手。Secure Form 输入的值不进记录也不给模型看。本机执行另有开关：每次问、总是允许、永不。购买弹卡写金额，批准后经 Link 付款。

**模型**。Grok Bot 不给选，由 Cursor 决定，用量分析里能看到每次实际用的模型；Grok 4.7 训练时适配了 Grok Bot 的 harness。grok.com 另有 Fast / Auto / Expert / Heavy 四档。

**电脑与浏览器**。每人一台持久云电脑，所有 Bot 共用：浏览器、文件系统、终端，共享 cookie、文件和命令行凭据；官方明说 Bot 之间不能当安全边界。可见度三级：标题栏图标变色表示电脑在用，再到侧边固定预览，再到全屏接管。空闲休眠、磁盘保留，提供更新、重置、恢复。出口用共享静态 IP，可改走用户本机出口。支持 1Password 和硬件安全密钥；Bot 可以有自己的邮箱地址。Teach a task：录一段最长 10 分钟的演示，生成技能草稿。

**集成与渠道**。插件与 Cursor 共用一套 MCP、插件和技能，Figma、Notion 等可在聊天里显示成交互卡片。X：不连账号也能搜和读，在 X 上 @bot 就能派活（英国、欧盟、澳大利亚等地不开）。Slack：Team Bot 在线程里回复，审批卡只有本人能点。没有找到 Telegram、WhatsApp 等 IM 入口。

**上手**。浏览器里用 Cursor 账号登录 → 应用介绍 Bot、电脑和 Routine，问你常用哪些工具 → 推荐几个「未来同事」，电脑同时在后台装好；电脑还在启动时应用就可用。团队管理员另有一份设置清单。

**价格**。The X Subscription：Free、Plus $8、Premium $30（起含 Grok Bot）、Super $100、Ultra $200、Teams $30 起每人、Enterprise 定制；Grok、Cursor、Bot 共用每周额度，超出按 API 价充值。

**客户端静态读**（Grok Bot 0.72.1，`com.anysphere.sand`，包名 `sand`，只读包内文件）：

- 结构：Electron 外壳，主进程之外有一个本机常驻的执行守护进程（经后端收本机工具请求）和一个协调进程（经网关连到云电脑，管建删 Bot、子代理、附件、密钥、Chrome cookie 注入、MCP 刷新）。REA：5 个窗口、8 个 contextBridge 接口、15 处 IPC、2 个 utility process、5 个原生模块。另带一个本机「计算机使用」助手 app，要屏幕录制、辅助功能、通讯录权限。
- 侧栏：置顶 Bot 磁贴、Bot 分组（可自建分区、拖拽）、隐藏的 Bot、未读过滤；状态点三种：需要处理、有未读、工作中，主 Bot 带星标。详情窗格标签：详情、任务（Routine）、库、电脑、会议、成员。每个 Bot 下有任务线程（进行中 / 完成，可置顶，宽屏与主聊天并排）；群聊只能加共享 Bot；Bot 之间的往来有只读记录。⌘K 跳转搜 Bot、消息、文件、Routine。
- 电脑面板：缩略磁贴五态（启动中带安装进度、休眠、连不上、本机、实时）→ 模态窗口（默认只看，接管后点「我做完了」交还，人离开时画面暂停，多屏对应子代理各自的屏幕）→ 全屏 → macOS 桌面浮窗。云电脑在 `/home/box` 下，画面走 noVNC，内有 Chrome（推断为 Linux）。
- 设置分通用、电脑、权限、保险箱、用量、更新。Bot 可以代用户改设置，分两类：主题、强调色、拼写检查、硬件加速这类直接改；自动审查、安全密钥、本机执行、出口、更新通道、自动更新这类只打开设置页并给出建议值；管理员锁定的项会说明。用量按应用（Grok Bot、Cursor）、来源（你、Routine、Bot 之间、群聊）或 Bot 拆；按需额度月上限三档，可自动充值。
- 审批：本机动作十类，按作用域分全局（跑命令、读写文件、列目录、读 AI 工具配置等）、设置（读短信）、按对象（发 iMessage、用某个 app）、按次（打电话）。卡片按钮：允许一次、始终允许、这次拒绝、不允许；状态含过期。本机执行每台机器设始终 / 询问（默认）/ 从不，团队可设上限，授权记录落在本机。自动审查默认开，两类自然语言规则各最多 20 条、每条 1000 字，自动去重，规则里的网址参数与令牌会脱敏；审查卡带风险标签（不可撤销、动安全设置、外传数据），可附一条建议规则，点一下写进规则表；群聊里只有被等的人能答。外呼电话卡只有打与不打，并提示打出去撤不回。
- 凭据：Secure Form 由宿主直接把值填进指定域名；保险箱存登录、卡、联系人，可导入 1Password、Chrome、Safari、Bitwarden 等导出的 CSV；1Password 服务账号每次取用都要在 1Password 里批；密钥只写不读。购买批准要验 passkey。
- 后台：Routine 触发有 cron（含抖动与时区）、Slack（提及、关键词、表情、任意消息）、GitHub 十五种事件、Linear、Sentry、PagerDuty、Teams、邮件、Webhook、日历会议。长时间没人看结果时先问继续、暂停还是别再问，再不理就全部暂停。后台任务面板分子代理、shell、云端 agent 三类，宿主重启后能重新挂上。本机子代理并发上限 32。
- 模型：没有用户可见的选择器；动态配置里有几种「模型选择器」实验分组，压缩用 grok-4.5 / 4.6。
- 渠道：每个团队 Bot 生成一个独立的 Slack app（私信与 @，可设只在私信里回），Teams 类似；Discord、Slack、Teams 自带 token 直连标为即将推出；Bot 邮箱 `@mail.grokbot.com` 默认关；本机 Messages 可读可发，按收件人授权；实时语音、外呼、进会议做笔记。
- 上手：落地 → 认识 → 电脑演示 → 工作 → 选角色（九种岗位）→ 工具 → 通知 → 交接，全程显示云电脑准备进度；每个角色从 41 个模板里推荐 2 个 Bot。团队 Bot 的设置向导顺序：插件 → 密钥 → 技能 → 记忆 → Routine → 文件 → 发布 → Slack。本机守护进程会读本机 Claude Code 与 Codex 的会话、MCP、技能、插件配置（最多 40 项，读时脱敏；推断用于导入或推荐）。
- 工程：183 个功能开关；107 个结构化错误码，按认证、更新、传输、存储、agent、桌面等域分，每个标可否重试；失败原因是固定枚举（供应方过载、首字卡住、对话过大、主人不在时 Routine 已暂停等）。

来源：<https://x.ai/news/introducing-grok-bot> · <https://x.ai/news/designing-grok-bot> · <https://x.ai/bot> · <https://x.ai/changelog/bot> · <https://docs.x.ai/grok-bot/overview.md> · <https://docs.x.ai/grok-bot/approvals-security-and-privacy.md> · <https://docs.x.ai/grok-bot/security.md> · <https://docs.x.ai/grok-bot/computer-and-apps.md> · <https://docs.x.ai/grok-bot/skills-routines-and-automations.md> · <https://docs.x.ai/grok-bot/settings-and-notifications.md> · <https://x.ai/news/team-bots> · <https://x.ai/pricing>

## §4 Devin（Cognition）

**是什么**。面向工程团队的自主软件工程师，在云端或本机运行，用自己的浏览器测试，做到 PR 可合并为止。2025-07 Cognition 收购 Windsurf；2026-06-02 起统一为 Devin 品牌：Devin Cloud、Devin Desktop（原 Windsurf）、Devin CLI、Devin Review。自研模型 SWE-2 于 09-10 发布。

**信息结构**。网页侧栏：新会话、Automations、Security、Review、Wiki；会话分置顶与参与过。会话列表按状态分组（工作中、就绪、受阻、不活跃），子会话嵌在父会话下画树线，悬停弹预览卡（最新回复实时更新、PR、工作目录），待批准项写明在等什么。⌘K 命令面板，铃铛收件箱。会话页左边对话和工作日志，右边工作区标签：进度、改动与 PR、内嵌 IDE、终端、浏览器（开电脑使用后变桌面）、上下文、Agents（子会话一览）。`/btw` 开只读旁问。组织设置分资源、成员、设置、集成四段；另有 Customize 页集中放插件、MCP、技能、Hooks、规则、记忆。

**后台与并行**。空闲 30 分钟休眠，休眠不计费；打字、打开预览或 SSH 进去都会唤醒，14 天内可恢复。Managed Devins：协调会话拆活，每个子 Devin 一台独立 VM，完成或要输入时唤醒协调者；协调者可发消息、看用量、让子会话休眠或终止；子会话可按 schema 回 JSON。收件箱每类通知可单独开关并推手机。Desktop 的 Agent Command Center 用看板管本地和云端 agent。

**审批**。推荐先在 Ask/Plan 里出计划，再交给 Agent 执行。环境建议、装 MCP 或插件、改技能都用卡片审批，改技能时卡片带 diff；Slack 里有 Apply 按钮。Local Hands（云端会话操作用户本机）：每次工具调用都问，选项为允许一次、本会话允许、拒绝；可开 Bypass，但凭据、提权、破坏性命令照问；接上本机后会话自动转私有。机密分组织、个人、仓库、会话四级，只注入用到它的命令。安全档可限网络、MCP、Git 只读。企业可给单个会话设用量硬上限。

**模型**。Agent 选择器有 Lite、Normal、Ultra、Fusion、SWE-2 等档，卡片上写明底层模型（如 Ultra 用 Fable 5.1 加 GPT-6 Astra），会话中途可换，可用档由管理员定。Desktop 和 CLI 有完整模型列表与自动路由。可绑定 ChatGPT 订阅抵 GPT 部分的用量。

**电脑与浏览器**。每会话一台 VM，默认 Linux，可选 Windows、macOS（带 iOS 模拟器）。电脑使用给 1024×768 桌面；Chrome 开 CDP 端口给 Playwright。遇到 MFA、验证码先暂停再由人接手；登录态可存成浏览器配置写回环境蓝图，以后会话直接带着。`devin ssh` 进 VM。Outposts 让会话跑在客户自己的机器上。

**集成与渠道**。Slack：@Devin 后线程与会话双向同步，`!` 关键字切模式，可开「一个会话独占一个频道」的 code channel。Linear：指派、打标签或 @ 触发，待办同步到 Linear 计划界面。Jira、Teams、GitHub/GitLab/Bitbucket/Azure DevOps（PR 评论里 `/devin`）、PagerDuty。Automations 由事件、定时、Webhook 触发。API v3 用服务账号，另有 MCP server 与 Terraform provider。

**上手**。接代码托管 → 索引仓库 → 在会话里说「给这个仓库配环境」→ 批准蓝图建议卡 → 构建快照 → 开第一个会话。新用户送额度，从 Desktop 连 GitHub 再送。

**价格**。Free；Pro $20/月；Max $200/月；Teams 最低 $80/月加每席 $40；Enterprise 按合同、按 ACU。超额按 API 价从按需额度扣。

**客户端静态读**（Devin Desktop 3.10.67，基于 VS Code 1.126，只读包内文件）：

- 三种 agent 同在一个客户端：旧 Cascade（已标弃用，提示换到 Devin Local）、Devin Local（随包的 `devin` 命令行，经 ACP 接入）、Devin Cloud。第三方 agent 也走 ACP，注册表里能看到 Claude Code、opencode、Gemini 等，分发方式有二进制、npx、uvx、websocket。
- Agent 窗口（⌘G 与编辑器互切）是看板：列只有三栏，运行中、受阻、就绪；有挂起的权限请求就算受阻；被拒、超额、报错也归受阻。收件箱可按状态、时间、agent、仓库、工作区、来源（自动化）筛，可按项目、agent、状态、目录分组，有「未读优先」。
- Spaces：把多个会话和固定资源放一组，汇总改动；往 Space 发第一句话时自动附上同组其他会话的摘要（默认开）。每个会话各有自己的 worktree。
- 会话标签：计划、改动、终端、浏览器、电脑、编辑器、任务、Agents（子会话）、PR、预览、iOS 与 Android 模拟器；另有旁问标签。计划可交给任意已连接的 agent 实现（含云端），输入框底部选执行位置：本机、worktree、云端、SSH 主机；命令行 `/handoff` 把仓库、分支、对话和未提交改动带上云，`/pickup` 带回。
- 设置：默认跑满 40 次工具调用停下来问一次；agent 通知默认关；可读取 `.claude/skills`。终端自动执行四档：关、白名单、自动（模型判断）、全部；团队设上限，个人只能在上限内选；命令旁一键加入允许或拒绝前缀，拒绝优先。网页请求三档。权限选项有允许一次、始终允许、全局始终允许、拒绝一次、始终拒绝，还能整台 MCP 服务器放行。每次决定记下来源（用户、系统、模型、默认）。命令行的权限模式：普通、接受编辑、智能（快模型判断）、Bypass、自主（只在沙箱里可用），沙箱起不来就拒绝启动。
- 云端会话状态（侧栏）：工作中、等回复、休眠、准备环境、规划、写代码、测试、等 CI、PR 就绪、等其他会话、崩溃、超限、不活跃。系统通知标题 40 字、正文 100 字以内，按动作类型写。会话可「后台启动」；有常驻的「个人 Devin」；Arena 模式让几个模型对跑同一任务。
- 模型：云端 agent 档有自动（前沿模型配便宜助手模型）、Ultra、Lite（便宜约六成）、快速 Opus、数据分析、规划；另有自研 SWE 系列、Cerebras 托管的快速档，推理强度三档。计费标签区分固定额度、API 价、自带 key、ACU。
- 本机接入：界面里叫「本机访问」，配对码 → 批准 → 本连接放行，可撤销；状态有等待、连接中、已连接、失败、需登录、过期。包里的内部名就是 Local Hands（推断两者是同一功能）。
- 生命周期钩子：读代码、写代码、跑命令、调 MCP、用户提示、agent 回复、建 worktree 前后各一个。
- 首次运行：欢迎 → 设置 → 键位 → 迁移范围 → 从 Cursor、VS Code、Windsurf 导入或从零开始 → 登录 → 主题 → 完成，可跳过。

来源：<https://docs.devin.ai/release-notes/2026> · <https://docs.devin.ai/work-with-devin/devin-session-tools> · <https://docs.devin.ai/work-with-devin/advanced-capabilities> · <https://cognition.com/blog/devin-can-now-manage-devins> · <https://docs.devin.ai/work-with-devin/local-hands> · <https://docs.devin.ai/work-with-devin/computer-use> · <https://docs.devin.ai/admin/billing/usage> · <https://docs.devin.ai/integrations/slack> · <https://docs.devin.ai/onboard-devin/environment> · <https://docs.devin.ai/product-guides/memory> · <https://devin.ai/pricing> · <https://docs.devin.ai/desktop/releases>

## §5 Claude Desktop（Anthropic）

**是什么**。一个 app 装下 Claude：问答、交办任务、写代码，能碰本机文件和应用。09-16 起 Chat 与 Cowork 合成一个入口，不再让用户选模式（Pro/Max 先推，Team/Free 随后，Enterprise 由管理员开）。最新版 3.1623.0（10-20）。

**信息结构**。顶部 Code 标签保留；左栏是最近（问答和任务同一张表）、Projects、Artifacts、Customize（技能、连接器、插件三页，各带发现页）、Scheduled，老用户还有 Dispatch。输入框「+」菜单放附件、按对话开关的连接器、Research、单对话关记忆、技能与斜杠命令；发送键旁的模型菜单管模型、推理强度（低到最高五档）和思考开关；权限选 Auto 或 Manual。设置按通用、记忆、功能、Cowork、Claude Code、本机（计算机使用、拒绝的应用）、连接器、扩展、开发者、用量、隐私、账单分组。

**后台与并行**。10-06 起 Pro/Max 新任务一律在云端跑，合上电脑继续，同一会话在桌面、网页、手机间接着用，完成或要回答时推手机。大任务拆成子任务并行跑子代理。定时任务在云端，可对话创建或填表（名称、提示词、审批模式、频率、模型、文件夹），能看历史、暂停、立即运行。Code 标签：每会话一个标签可分屏，每会话可开独立 worktree，tasks 面板列子代理、后台命令和工作流；会话间能互发带来源的消息卡片；`/btw` 侧问；Code Projects 由一个协调对话派出多个云端线程，总览页列完成的、等你的和 PR。

**审批**。Cowork 三种模式：Manual（每个动作都问）、Auto（每个动作先过安全审查，危险的拦下；被拦多次退回逐个询问）、Skip（不查）；与连接器工具的三档（始终允许、需审批、禁用）交叉成矩阵。永久删除文件在任何模式下都要问。Chrome 按站点：允许这一次、此站始终允许、拒绝；下载、填敏感信息、授权仍单独确认，购物和开账号一律不做。计算机使用按应用授权，能力按类别固定分档：浏览器和交易软件只能看，终端和 IDE 只能点，其余完全控制。Code 的模式：Manual、Accept edits、Plan、Auto、Bypass，Bypass 要先在设置里允许，云端会话没有 Bypass。

**模型**。Opus 5.5、Sonnet 5.5、Haiku 5.5、Fable 5.1；Free 只有 Sonnet 与 Haiku，Opus 从 Pro 起；Fable 在 Pro 上另计用量、在 Max 上有周占比上限。Research 固定跑 Opus 5.5。企业可限模型和推理强度上限、设默认模型。

**电脑与浏览器**。云端每会话一个临时沙箱，访问不了私网，出网走强制代理只放白名单，只拿短期令牌，连接器令牌不进沙箱。桌面 app 是通往本机的桥：本地文件、本地连接器、浏览器、计算机使用都要桌面在线。内置浏览器按站点导入 cookie，银行、邮箱、SSO 站点默认不勾。计算机使用在 macOS 15 以上走后台窗口，不抢鼠标键盘；选工具的顺序是连接器、浏览器、最后才操作屏幕。

**集成与渠道**。连接器目录、远程 MCP、本地 MCP 打包成 .mcpb 扩展（敏感配置进钥匙串）、插件（技能 + 连接器 + 子代理，同步到 Claude Code）。Claude 会按对话内容建议已连接的应用，不收推广费。Slack 里的 Claude Tag 有自己的身份，可按频道设花费上限。手机可发起和操作 Cowork 任务；Dispatch 不再对新用户开放。`claude://` 深链接、Quick Entry 全局唤起。

**上手**。每项能力配「试试」示例提示；首次提示开 Quick Entry；内置浏览器首次打开引导导入 cookie；Code 首次打开按常用文件夹自动建环境，回复后给灰色的下一句建议、Tab 采纳。

**价格**。Free；Pro $20/月（年付 $17）；Max $100 / $200；Team Standard $25 / Premium $125 每席；Enterprise $20/席加 API 价用量。计算机使用与 Dispatch 只在 Pro/Max。

**客户端静态读**（3.1623.0，REA 读 `app.asar`，另读 `ion-dist/i18n/en-US.json` 共 36153 条界面字符串）：

- 主进程有 14 个窗口、54 个 contextBridge 接口、约 1576 处 IPC 调用、4 个 utility process。独立窗口里有 Quick Entry、本机执行同意窗、计算机使用的「教学」与「看我做一遍」录制窗、Artifact 外壳、Design 窗。
- 内置技能 docx、pptx、xlsx、pdf、frontend-design；内置 MCP：GitHub、Office 365；`smol-bin.arm64.img`（24 MB）是本机工作区 VM 镜像。文档说 Pro/Max 已全上云，包里本机 VM 仍在：默认「宿主原生」形态（shell 在 VM 里、文件工具在宿主按路径授权），可选整机 VM 隔离，有「重启 VM」、出站域名配置，供 Team/Enterprise 与本机桥使用（推断）。
- 权限文案：「自动审批」已成新任务的默认模式（按套餐逐步），逐个动作做风险检查、可疑才停；「跳过全部审批」只能在本机跑，开启前确认；工具定义变了要重新批准；管理员可禁用「始终允许」；对金融站点、私网站点有专门说明。
- 状态词：需要输入、等你（带时间）、待查看、计划待审；「N 个会话需要输入」「N 个嵌套会话需要输入」；等你回复时自动归档暂停最多一天。
- 计划任务：错过的会补跑并告知；连续启动失败自动停用并写明原因；Routine 可看 CI 与评审意见并推修复；为分散负载有几分钟随机延迟。
- 用量页按子代理、技能、MCP 归因，并提示给简单子代理换便宜模型。
- 记忆存为本机文件，跨问答与云端任务统一。

来源：<https://support.claude.com/en/articles/16761823-claude-cowork-and-chat-are-one-claude> · <https://support.claude.com/en/articles/15520349-use-claude-cowork-on-web-desktop-and-mobile> · <https://support.claude.com/en/articles/13345190-get-started-with-claude-cowork> · <https://support.claude.com/en/articles/14479288-claude-cowork-architecture-overview> · <https://support.claude.com/en/articles/14128542-let-claude-use-your-computer-in-cowork> · <https://support.claude.com/en/articles/12902446-claude-in-chrome-permissions-guide> · <https://support.claude.com/en/articles/16607400-use-the-built-in-browser-in-claude-cowork> · <https://support.claude.com/en/articles/13854387-schedule-recurring-tasks-in-claude-cowork> · <https://code.claude.com/docs/en/desktop> · <https://code.claude.com/docs/en/claude-projects> · <https://support.claude.com/en/articles/8664678-change-the-model-effort-and-thinking-settings> · <https://claude.com/pricing> · 早一版（2.42304）的设置与菜单拆解见 `~/atlas-evidence/2026-10-19/frontend-research/claude-desktop-rea.md`

## §6 阡陌现状（对照用）

- **前台 `/`**：左栏是智能体名册（主智能体标「主」，其余为子智能体，每行最近一句与时间，执行中有标记，⋯ 菜单）和按 24 小时 / 7 天 / 30 天分组的会话列表；欢迎页只有形象、名字和在线状态，没有示例；输入框里有 `+`（本地命令）、「模型」（自动 + 八档推理强度）、「权限模式」（人工确认 / 自动接受编辑 / 自动审批 / 跳过权限确认）、语音；右侧会话面板列后台任务（待你处理、运行中、排队中、已完成），有云端电脑入口。审批到达时有浏览器通知（用户已授权时）。
- **后台 `/admin`**：常用七项（对话、主动执行、记忆、渠道、扩展、云端电脑、模型），管理十三项默认收起。初始化配置页四个必需步骤（运维账号、接入模型、服务器与节点、主智能体）与四个建议项（任务模型、聊天渠道、云端电脑、邀请成员）。
- **电脑**：每个节点的主智能体可开专属浏览器（无头、独立登录与下载）与专属电脑（Linux 私有桌面；macOS 用本机桌面、只开列出的应用）；确认方式三档；空闲 15 分钟自动停用；子智能体不能用。
- **渠道**：QQ、微信、Telegram、Discord、Slack，主人与其他人分流到不同智能体，群里 @ 时回，访客配对；都标「未评估」。
- **在途**：P40 智能体改设置（对话里的确认卡片、审批页改卡片，分支 `feat/agent-settings*`）；P37 桌面版与订阅迁移（规划）。
- **结构差异**：阡陌是「中枢 + 多节点 + 多智能体名册」，自托管，模型自配（magpie 网关、按难度三档、多种底层）；四家都是厂商托管、模型由厂商绑定或只给档位。阡陌没有移动端和桌面客户端，聊天渠道承担了「随时派活」。

## §7 对比

| 维度 | 阡陌 | Muse | Grok Bot | Devin | Claude Desktop |
|---|---|---|---|---|---|
| 智能体数量 | 名册多个，主 + 子，跨节点 | 一个 | 多个 Bot，可群聊 | 每会话一个，协调者 + 子会话 | 一个，任务并行；Code 多会话 |
| 电脑归属 | 每节点主智能体一台 | 每人一台 VM | 每人一台，Bot 共用 | 每会话一台 VM | 每会话云沙箱；本机经桌面桥 |
| 看与接管 | 后台「查看画面」 | 看、接管、终止 | 状态 → 预览 → 接管 → 交还 | 暂停后 IDE/浏览器接手，SSH | 侧栏浏览器；计算机使用后台或全屏 |
| 空闲 | 浏览器 15 分钟停用 | 后台推进 | 休眠，磁盘保留 | 30 分钟休眠不计费，打字即醒 | 云端继续，手机推送 |
| 子任务呈现 | 会话面板后台任务、子智能体执行条 | 状态「等子代理」，活动记录分主线与子代理 | 头像状态、后台任务面板三类、Stop 连带 | 树线、看板三栏、Agents 标签 | tasks 面板、项目总览、嵌套会话 |
| 审批载体 | 审批页 + 前台确认（P40 改卡片） | 客户端审批框，Sentinel 放行 | 卡片，无人在场 10 分钟过期 | 卡片（含 diff）、Slack 按钮 | 卡片 + 模式矩阵 |
| 审批范围 | 单次，绑定精确参数 | 一次 / 本任务 / 本站 / 始终 | 一次 / 始终 / 拒绝 | 一次 / 本会话 / 拒绝 | 一次 / 始终；按应用分档 |
| 自动审批 | 规则档（P39），运维开、限时限次 | 污点出网自动分流 | 独立审查模型 + 自然语言规则 | Bypass 仍问三类 | 安全审查，多次被拦退回人工 |
| 模型 | 自配，按难度三档，八档推理 | 文档未提；包内有服务端下发的模型子菜单 | 不可选 | 档位 + 底层模型可见 | 模型 + 推理强度 + 思考 |
| 渠道 | QQ、微信、Telegram、Discord、Slack | WhatsApp、Telegram、iMessage、Messenger、自有邮箱（后几项来自包内） | X、每 Bot 一个 Slack app、Teams、Bot 邮箱、本机短信 | Slack、Teams、Linear、Jira、Git 评论 | Slack、手机、Office 插件 |
| 记忆 | 记忆页（P23） | 三份可编辑 md | 每 Bot 独立 | 每人一个带来源的仓库 | 本机文件，Topics 可编辑 |
| 上手 | 后台初始化页四步 | 起名、形象、性格 | 问常用工具，推荐 Bot | 会话里配环境，批准建议卡 | 示例提示、Quick Entry |
| 收费 | 自用不计费；公开版按节点订阅、用户自带 key | 免费 + $20 / $100 | $30 起 | Free、$20、$200、Teams | Free、$20、$100、$200 |

## §8 该学什么（排序）

排序按「对阡陌三个特点的贡献 × 现有实现能接上的程度」。每条写参照和阡陌落点；与在途工作（P38–P40）重叠的写明关系，避免重复做。要照着做的细节（枚举、按钮、上限）见 §9。

### 前台与体验

| # | 改什么 | 参照 | 阡陌落点 |
|---|---|---|---|
| F-1 | **审批卡由界面画，不由模型写**。卡片内容取自中枢的待审批记录（动作、目标、精确参数、发起的会话），对话正文里只留一行引用；有待批时输入框照常可打字但先不发出；范围在「这一次」之外加「本任务」「本站点」，无人在场发起的审批到期作废并写明「没人回答，所以没执行」；能批量处理 | Muse 的审批框与按对象的范围、待批时暂停发送、批量；Grok Bot 过期状态与风险标签；Claude 的模式 × 工具矩阵 | P40 的确认卡片（`view/frontApproval.ts`、`view/approvalCard.ts`）；P14 的「绑定精确参数」不变，新增范围要经节点裁决 |
| F-2 | **一套状态贯穿名册、会话和面板**。归成三桶：要你（待审批、等回答、失败）、在跑、好了（含未读）；有挂起审批就算「要你」。智能体行与会话行用同一组状态点，会话列表可按状态分组，「要你」排最前；悬停出预览（最新一句、正在做什么） | Devin 看板三栏与「有挂起权限就算受阻」；Grok Bot 三种状态点与主 Bot 星标；Muse 十几种状态里可带一句活动说明 | 前台侧栏（`view/front.ts`）；后台侧栏的状态点规则（console.md §5.2）复用到前台 |
| F-3 | **电脑分层可见**。对话顶栏的「正在用电脑」标记 → 会话面板里的缩略磁贴（启动中带进度、休眠、连不上、实时）→ 大窗只看 → 接管（智能体暂停）→ 「交还」写进对话 | Grok Bot 磁贴五态、只看与接管、交还；Muse 看、接管、终止；Devin 暂停后接手 | 会话面板（`view/frontPanel.ts`）；画面来自云端电脑现有截图通道 |
| F-4 | **会话面板升级为总览**：要你、在跑、即将运行（定时）、产出（文件、PR、链接）四区，子会话嵌在主会话下，后台任务分子会话、命令、远端 agent 三类 | Claude Code Projects 总览；Muse 活动记录与即将运行；Grok Bot 后台任务面板；Devin Agents 标签 | 会话面板；P38.2 的子会话回报 |
| F-5 | **欢迎页给能直接点的开场**：按已开的能力（电脑、渠道、连接器）出三四个示例任务，没开的能力不出现 | Claude「试试」示例；Muse 建议任务与 Ideas | 前台欢迎页 |
| F-6 | **旁问**：`/btw` 或侧边小窗问一句，不进主会话上下文，不打断在跑的一轮 | Claude `/btw`；Devin 旁问标签；Muse side chat | 前台本地命令；节点侧作为只读的一次性会话 |
| F-7 | **一键全停**：主会话的停止连带子会话和挂着的审批，停不下来要明说 | Grok Bot 停止连带与「停不下来」状态 | 会话面板停止按钮；急停语义已有，补前台入口 |
| F-8 | **⌘K 跳转与通知收件箱** | Devin、Grok Bot | 前台；低优先 |

### 智能体能力

| # | 改什么 | 参照 | 阡陌落点 |
|---|---|---|---|
| A-1 | **「要你」时经聊天渠道找人**：控制台几分钟没人看时，把「要你」推到主人的 QQ / 微信 / Telegram，可在渠道里直接回答；批准仍回控制台或经个人凭据再验证；后台任务跑完先判断值不值得打扰 | Grok Bot 桌面到手机升级；Muse 跑完先自评、WhatsApp 与 Telegram 渠道；Devin 收件箱推手机 | 渠道（P28）与主动执行；渠道里的批准沿用 P14 的再验证 |
| A-2 | **智能体改设置分三级**：显示类偏好直接改；有后果的项走确认卡片；安全与信任类（审批、权限模式、出口、账号）只打开设置页并给建议值；管理员锁定的项说明原因 | Grok Bot 让 Bot 改设置时分「直接改」与「只开页面给建议值」；Claude Desktop 的 `set_setting` 不碰安全类 | P40 设置目录（`settingsCatalog.ts`）：现设计每项都要卡片，`human` 字段已覆盖第三级，补「直接改」一级 |
| A-3 | **自动审批加两条护栏**：同一会话被拦 N 次退回人工确认；读过用户数据（连接器、文件互通）之后的对外写入一律问；审查卡附一条可一键收下的建议规则 | Claude Auto 多次被拦退回；Muse 污点出网；Grok Bot 先问优先、建议规则 | P39 高权限模式（`elevation.md`）的自动审批档 |
| A-4 | **网站登录不经模型**：云端电脑加「安全录入」，值由宿主直接填进指定域名；登录态按站点保存，银行、邮箱类默认不存；支持从浏览器或密码管理器导出的 CSV 导入 | Grok Bot Secure Form 与保险箱；Muse 凭据库与替代令牌；Claude 按站点导 cookie；Devin 登录态写回蓝图 | 云端电脑（P21）；应用连接（P25）已有加密秘密槽与资源句柄，可复用 |
| A-5 | **电脑休眠而不是停用**：空闲时保留磁盘与登录态，下一次调用或打开画面时自动唤醒，界面显示唤醒进度 | Devin 休眠不计费、打字即醒；Grok Bot 休眠磁盘保留、磁贴显示启动进度 | 云端电脑现为空闲 15 分钟停用 |
| A-6 | **子会话的电脑**：子智能体也能拿到浏览器（独立资料目录），面板标出是谁在用 | Devin 每会话一台；Grok Bot 每个子代理一块屏；Muse 浏览器子代理 | 现在只有主智能体能用（console.md「云端电脑」） |
| A-7 | **定时与事件任务补齐**：试跑、错过补跑、连续失败自动停用并写原因、主人长期不看结果先问再暂停；事件触发加 webhook、渠道消息、GitHub | Claude Scheduled；Grok Bot Routine 触发与花费守护 | 定时任务（P24）、主动执行 |
| A-8 | **工具选择顺序写进宿主说明**：连接器 → 浏览器 → 操作屏幕 | Claude 计算机使用文档 | 宿主工具说明（`qianmo_browser_*`、`qianmo_computer_*`） |
| A-9 | **记忆可见可改、带来源**：对话里出「记忆已更新」卡，每条记忆链接到来源会话；支持导入别家助手的导出包 | Devin 记忆带来源与更新卡；Muse 记忆文件可编辑、可导入 ChatGPT / Claude / Gemini 导出 | 记忆（P23） |
| A-10 | **按渠道和会话设花费上限**：超出直接拒绝并说明；用量按来源（你、定时、智能体之间、群聊）拆 | Claude Tag 按频道上限；Devin 单会话上限；Grok Bot 用量按来源拆 | magpie 网关密钥额度；用量页 |
| A-11 | **失败原因用固定枚举**：每种失败一个码、一句人话、可否重试，前台按码给下一步 | Grok Bot 结构化错误码与失败原因枚举 | 节点回报与前台过程行；云端电脑的固定报错前缀可并入 |
| A-12 | **演示一遍生成技能**：在云端电脑上录一段操作，生成技能草稿再由人改 | Grok Bot Teach a task；Claude「看我做一遍」录制窗 | 扩展页的技能；低优先 |

### 上手

| # | 改什么 | 参照 | 阡陌落点 |
|---|---|---|---|
| O-1 | **第一次对话由主智能体带着配**：先问岗位和常用工具，按岗位推荐两三个可直接用的智能体模板和示例任务，再提出要开的能力（模型、渠道、电脑、连接器），每项用确认卡片落地；初始化页保留作清单 | Grok Bot 九种岗位、41 个模板每岗推荐两个；Muse 勾选建议任务；Devin 在会话里配环境再批卡 | P40 设置目录与 `qianmo_settings_change`；`/admin/setup` |
| O-2 | **从本机已有工具导入**：读本机 Claude Code、Codex 的 MCP、技能、插件配置（脱敏），列出来让用户勾选装到智能体上 | Grok Bot 守护进程读本机 Claude Code 与 Codex 配置（推断用于导入）；Devin 首次运行从 Cursor、VS Code 导入 | P37 桌面版；扩展（P32）的安装接口 |
| O-3 | **能力边界表**：每项能力写清要什么在线（节点、中枢、渠道账号、模型），初始化页与前台缺能力时显示同一句 | Claude「哪些要桌面在线」 | 初始化页；`docs/dev/console.md` |
| O-4 | **上手时先讲清三条风险**：能替你动手、昼夜在跑、仍会出错，并说明在哪收回权限 | Muse 首次运行的三条风险告知 | 初始化页或第一次对话；与 P39 收回、急停入口相连 |
| O-5 | **智能体的名字、形象和性格一起定**：性格与说明是一份可改的文本，前台可改 | Muse 起名、头像、性格与可编辑文件 | 已有换形象；补性格说明 |
| O-6 | **公开版注册后先给一个能跑的默认**：订阅开通即有主智能体和一条示例任务，电脑在后台准备并显示进度；缺模型 key 时示例改为引导填 key | Grok Bot 电脑未就绪时应用已可用；Devin 送额度跑首个会话 | 公开版（P35）订阅后的前台 |
| O-7 | **改动公告写清「挪到了哪」**：默认底层、页面合并这类改动，在前台给一次性说明 | Claude 合并 Chat 与 Cowork 的公告 | 更新页与前台提示；低优先 |

## §9 复刻规格（逐条证据）

这一节把 §8 里要照着做的界面行为写成规格，每条注明出处与覆盖范围。覆盖范围分四种：**静态**是读了安装包、没有运行；**外壳**是未登录的网页；**文档**是官方帮助；**推断**是本文的判断。

### 9.1 证据清单

REA 证据号可以在本机证据包 `~/atlas-evidence/2026-10-21/benchmark/rea-evidence.json` 里查（15 条记录）。摘要只写 sha256 前 12 位。

| # | 对象 | REA 操作与证据号 | 摘要 | 覆盖 |
|---|---|---|---|---|
| R-1 | Claude Desktop 3.1623.0 `Resources/app.asar` | 应用图 `ev_0088d8ad2deabe5e033d9451fa5b675f1824b1a8d3eecb6e88051d6b348c697b` | `760e7cbb6f86` | 静态。479 个 JS 全部解析；窗口、IPC 和子进程结构是完整的。界面文案另外从 `ion-dist/i18n/en-US.json` 读取，那是文件检查，不是 REA |
| R-2 | Grok Bot 0.72.1 `Resources/app.asar` | 应用图 `ev_5dc4dccd0ab0bc185d7309a312e6d97dbd47ff58a90fbb613e34ced5f2f2cc22`；审批卡模块 `dist/renderer/assets/chunk-view-DOHqAtZd.js` 的模块项 `ev_90f15f81251f3420fdfea6eb06bce058644c1919a022af9f0eb1b522bc316f89` | `b272ee13db0f`；模块 `a38232161e17` | 静态。应用图只覆盖了一部分；有几个解包出来的 `.node` 文件和包头记录的校验值对不上，按不可信字节记下 |
| R-3 | Muse 8.0 `Resources/hatch/index.html`（源文件 `68b358679df8`）里的两段内联脚本 | 应用图 `ev_7791321a504a8c7d6adbb0c59041705d35a44e68301f611bb4f66da6077d2499` | `7bd5e7814848` | 静态。两段都解析成功，恢复出 45 个 webpack 模块；语义图分析到 4 GiB 堆上限中止，不完整 |
| R-4 | Devin Desktop 3.10.67 `out/vs/workbench/windsurf-chat-client/index.js`（源文件 `8b0f6cd5361b`） | 应用图 `ev_705501052a890b25333858f526b85b23858647fd06fc8f66a707b8eb9945d631` | `29378be8424e` | 静态。全文解析成功，共 435 万个语法节点；单文件打包拆不出模块；语义图到堆上限中止 |
| R-5 | grok.com | 网页包 `ev_e862d6405147bc51976a0a2b39efbe0803b734d279596932edb972b364413c16` | — | 外壳。Next.js 外壳加 Cloudflare 校验页，没有路由和接口 |
| R-6 | app.devin.ai | 网页包 `ev_90e283a725551fe6972390f9b2cefcdf113650cfd67625a492d099bacec4f698` | — | 外壳。只有启动页 |
| R-7 | muse.ai | 网页包 `ev_408933ca293b2b74a9b90a0a40c3df093da35238d063af23fe7bbeb5074a4f6b` | — | 外壳。Next.js，有登录接口，也有 Hatch 命名；据此推断网页版和 Mac 版用的是同一套前端 |

浏览器目标清单是 `ev_907898379cc9816a6675af2194c6a21e0ffef4d9599ffadff75a1c9d1c46da2f`，来自本机无头 Chrome，只连回环地址。REA 用来确认包的身份、模块边界和解析覆盖。下表里的枚举、按钮和上限，是在 R-1 到 R-4 对应的文件里检索字面量得到的，包内路径写在原始笔记里。所以结论只能说明包里有这组字面量，说明不了运行时一定会走到。

### 9.2 规格

| # | 复刻什么 | 规格 | 出处 | 覆盖 | 对应 |
|---|---|---|---|---|---|
| S-1 | 状态三桶 | Devin 的归类：active、pending、canceling 归「在跑」；cancelled、max_tokens、max_turn_requests、refusal、unknown_error 归「受阻」；idle、end_turn 归「就绪」。有挂起的权限请求或正在等用户时，也算受阻。看板三列依次是 ready、blocked、running，每列最小宽 320 px，可以按 Space 分组。阡陌这样对应：受阻就是「要你」，就绪加未读就是「好了」 | R-4，列定义字面量 `["ready","blocked","running"]` | 静态 | F-2 |
| S-2 | 状态词 | Muse 的智能体状态有 14 个，从 connected 到 connection_error，其中「等子智能体」「额度用完（带升级入口）」「VM 更新中」各占一个，working 可以带一句活动说明。任务状态有 8 个：排队、启动、进行中、等你、暂停、完成、失败、已停止。Claude 用 Needs input、带时间的「等你」、Ready for review，还会汇总成「N 个嵌套会话需要输入」。阡陌的做法：节点回报先统一成这套词，再归到三桶 | R-3 `BOT_STATUS_STATES`；R-1 界面文案 | 静态 | F-2、F-4 |
| S-3 | 审批卡按钮与状态 | Grok Bot 有四个按钮：允许一次、总是允许、拒绝一次（Esc）、不允许。卡片状态有 pending、allowed、always、never、denied、expired。团队策略可以禁掉「总是允许」，也可以要求每一轮都审批 | R-2 审批卡模块项 | 静态 | F-1 |
| S-4 | 审批范围 | Muse 的主按钮是「允许」，下拉里选范围：一次、本任务、本任务内所有上网、本定时任务、本产出、永久、本站点永久、本连接器永久。拒绝一侧的范围对称。「详情」列出动作、目标、网址、进程、程序和命令。可以批量处理；审批会过期；发出去的消息可以先改再批。阡陌先做四档：一次、本会话、本站点或本连接器、永久，每一档都由节点裁决 | R-3 字面量 `allow_once` 等 | 静态 | F-1 |
| S-5 | 待批时暂停发送 | 有审批没处理时，输入框照常能打字，但消息先不发出 | R-3 文案「sending is paused」 | 静态（交互时序未看到） | F-1 |
| S-6 | 本机动作作用域 | Grok Bot 把本机动作分成 10 类、4 种作用域：global、setting、subject、call。subject 类按收件人或按 app 授权。每台机器选 always、ask 或 never，默认 ask，团队可以设上限。客户端界面和本机守护进程用的是同一张动作表 | R-2，`index.eager-app` 与 `local-exec-daemon/main.cjs` | 静态 | F-1、A-3 |
| S-7 | 自动审查规则 | Grok Bot 用两类自然语言规则：「先问」和「自动允许」，冲突时「先问」优先。每类最多 20 条，每条最多 1000 字；规则里的网址查询串和 token 会被脱敏。审查卡附一条建议规则，点一下就能收下。风险标签有三种：撤不回、安全设置、外传数据。Claude 的默认档是「自动批准」，逐个动作做风险检查，可疑的才停 | R-2；R-1 界面文案；Claude 帮助文档 | 静态、文档 | A-3 |
| S-8 | 改设置分级 | Grok Bot 里，主题、强调色、拼写检查、硬件加速这几项直接改。自动审查、安全密钥、本机执行、出口、更新通道、自动更新这几项只打开设置页并给建议值。被管理员锁定的项会说明原因 | R-2 `index.eager-app` | 静态 | A-2 |
| S-9 | 电脑磁贴与接管 | Grok Bot 的磁贴有五种状态：启动中（唤醒或安装进度%）、休眠、连不上、在本机、实时。打开后默认「只看」，可以「接管」，用完点「我好了」交还。用户离开时画面暂停 | R-2 `chunk-computer-screen-preview-*`、`chunk-box-desktop-modal-*` | 静态 | F-3 |
| S-10 | 休眠与唤醒 | Devin 的云会话会在闲置、额度用完、超限或网络配置变更时休眠，唤醒最多要 90 秒左右。Grok Bot 的磁贴显示唤醒进度 | R-4 `sessionStatus.*`；R-2 | 静态 | A-5 |
| S-11 | 上手步骤 | Grok Bot 的顺序：落地页 → 认识 → 电脑演示 → 工作 → 岗位 → 工具或新建 → 通知（只在 macOS）→ 交接，过程中显示电脑的准备进度。岗位有 9 种，每种推荐 2 个模板，模板库共 41 个。Muse 先讲三条风险，再让用户多选建议任务，最后换头像、换名字、选性格（自填最多 120 字） | R-2 `chunk-onboarding-flow-*`；R-3 | 静态 | O-1、O-4、O-5 |
| S-12 | 从本机导入 | Grok Bot 的本机守护进程会读本机 Claude Code 和 Codex 的会话、MCP、技能、插件配置，最多 40 项，读取时脱敏。至于拿来导入还是推荐，是推断 | R-2 `local-exec-daemon/main.cjs` | 静态、推断 | O-2 |
| S-13 | 失败码 | Grok Bot 有 107 个结构化错误码，按登录、更新、传输、存储、智能体等域划分，每个都标了能否重试，并配一句摘要。失败原因是固定枚举，比如供应方过载、首字卡住、对话过大、离开期间暂停 | R-2 `electron-main/main-core.cjs` | 静态 | A-11 |
| S-14 | 花费守护 | Grok Bot 在主人长时间不看定时结果时，先问继续、暂停还是不再问，之后全部暂停。用量按你、定时、智能体之间、群聊四类拆分。按量付费的月上限分三档：无、固定、不限 | R-2 | 静态（阈值不在客户端里） | A-7、A-10 |
| S-15 | 系统通知 | Devin 的系统通知标题不超过 40 字、正文不超过 100 字，正文按工具类型写。结束时取最后一条消息，或写「已出计划」「已完成」 | R-4 | 静态 | A-1 |
| S-16 | 审批模式 | Claude 有三档：手动、自动批准（默认）、全部跳过（只在本机，开启前要确认）。「允许一次」只对当前页面有效；「总是允许」存在本机，可以撤销；工具定义变了要重新批准；管理员可以禁掉「总是允许」 | R-1 界面文案；Claude 帮助文档 | 静态、文档 | F-1、A-3 |

### 9.3 覆盖与没做的

- 四个客户端都没有运行，所以运行时的网络行为、实际渲染和交互时序都没看到。REA 的浏览器和 Electron 运行时观察，没有用在这四个客户端上。
- 三家的网页版都要登录才能用，未登录时只拿到外壳（R-5 到 R-7）；本次没有注册账号。
- REA 的语义图在 Muse 和 Devin 两个大包上用满了 4 GiB 堆，Grok Bot 的图也只覆盖了一部分。所以 S 表的结论只能说明包里有这组字面量，具体落在哪个文件，靠文件检查对位。
- 由服务端决定的值在客户端里找不到，仍然未知，包括审批过期时长、花费守护阈值和模型清单。

## §10 不跟的

- **用订阅账号抵模型费用**（Devin 绑定 ChatGPT 订阅）：与 L-6「只用 API key 或网关密钥」冲突，不做。
- **一人一台、所有智能体共用电脑**（Grok Bot）：阡陌按智能体隔离，保留；F-3、A-4 只学可见度与休眠。
- **不给选模型**（Muse、Grok Bot）：模型中立是阡陌的卖点，保留；把「自动」做成好用的默认即可。
- **Feed、内容流**（Muse）：与定位无关。
- **购物与支付代办**（Muse、Grok Bot 的 Link 卡）：章程 §1.6 把支付列为独立通道与独立确认，暂不做。

## §11 对外材料要更新的事实

路演与计划书里的相似产品页，按本文更新这几条：Grok Bot 由 Cursor 承建、跑在 Cursor 云上，2026-08 发布；Muse 2026-09-08 发布、只在美国和加拿大；Devin 已覆盖「每会话一台电脑（Linux / Windows / macOS）」和「云端会话操作本机」；Claude 的 Cowork 10-06 起在云端跑、09-16 起与问答合并。

## §12 没覆盖的

- 三家登录后的真实界面（Muse、Grok Bot 要账号；Devin 网页版要账号）。
- 四个客户端的运行时行为（见 §9.3）。
- Meta AI app、grok.com 主应用、Windsurf 时代的旧界面：只作背景，不展开。
- 价格里的地区差异、税与教育优惠。
