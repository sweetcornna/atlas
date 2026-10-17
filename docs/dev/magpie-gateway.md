<!-- Copyright 2026 Qianmo AgentNest Team -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# 阡陌 Qmo — magpie 统一模型调度与「网关」页设计（P33 ~ P34）

| 项 | 内容 |
|---|---|
| 文档版本 | **v1.5（生效）**；v1.5 新增 §6 P37 桌面版与订阅迁移（规划）的范围与合规边界；v1.4 按 2026-10-17 合并前审查改：§0、§5 写明上游测连与拉模型列表由中枢经管理接口触发、从 magpie 发出（章程 v3.6 N-5 补注），§2.2 与 §4 注明轮换窗口里的换代由测试脚本驱动、常驻主机不在环内，未评估的长跑改为「超过 1 小时」；v1.3 回写 P33.4 TLS 补测（§4）、§1 节点信任自签 CA 与名单行为、§2.2 轮换窗口的实测与「节点能力未知先问节点」；v1.2 回写 P33.4 真机冒烟（§4）、一把密钥服务三种底层（§2.1 `laneAddresses`）、§1 管理链接进日志与额度插件默认状态；v1.1 按实现回写 §2.2 的轮换与两个已知窗口 |
| 日期 | 2026-10-17 |
| 核对基点 | 本仓库 `db52f282`（main，#229 合并提交，基座 qianmopi v18.8.8）；magpie 源码 `yetone/magpie@8b84dc9`，本机发行版 `magpie 0.1.1268`，GitHub 发行 `v0.1.1278` 有 `magpie-cli-linux-{amd64,arm64}`；P33.4 冒烟用 `v0.1.1278` linux-arm64 官方二进制 |
| 范围依据 | 负责人 2026-10-17 决定（对话记录）：接入 magpie 作为模型统一调度管理器；前端按本项目的风格特化；另立公开版（见 [`public-edition.md`](./public-edition.md)，P35）。章程 v3.5 §2.7 |
| 编号 | P33 magpie 统一模型调度；P34「网关」页 |
| 结论一句话 | magpie 作为平台网关单独运行，节点带各自的网关密钥直连它取模型；中枢只调 magpie 的管理接口发放密钥、设额度、读用量，不转发模型流量；在阡陌里 magpie 就是一个普通的模型档案，编译、下发、热切换全部沿用 P18 |

由主 agent 按负责人 10-03 的常设委托（设计取舍自行裁定）定案。「未评估」是证据状态，不是授权门槛。

---

## §0 口径

- **magpie 是什么**：开源（MIT）的本地/服务端模型网关，同一端口说 OpenAI Chat、OpenAI Responses、Anthropic Messages 与 Gemini 四种协议并互相转换；管上游供应商、路由组（同一组内按 smart / order / rotate / usage / pace 选成员、额度用完换下一个）、网关密钥（每把密钥可限模型、可设按日/周/月/N 天的 token 与估算费用上限）和用量记录。
- **一切原生化适配**（章程 §7.2 第 8 条）：magpie 的路由、故障转移、额度和用量都用它自己的；阡陌不另做调度层、不做协议转换，只做 magpie 没有的那一层——身份、授权、隔离、记账与审计。三种底层仍按各自原生协议直连网关：Claude Code 对 `/v1/messages`，Codex 对 `/v1/responses`，qianmopi 按档案通道。
- **模型调用不经过中枢**（章程 N-5 v2.22「由中枢代为调用模型」仍不解禁，R-9 不变）：magpie 是一个独立的网关服务，可以和中枢同机，但不是中枢进程，模型流量是「节点 → magpie → 上游」。中枢只调用 magpie 的管理接口（`/api/*`）和 `/api/hello`、`/v1/models` 这类只读接口。例外（章程 N-5 v3.6 补注、[`providers-console-m1.md`](./providers-console-m1.md) R-9）：加上游时 magpie 保存前向上游拉一次模型列表，「网关」页的「测试」让 magpie 向上游每种协议发一个最小请求；这两类请求由中枢经管理接口触发，从 magpie 发给上游、不经中枢进程，中枢只收到结果（模型号，各协议通断、状态码与耗时，上游报错原文丢掉），不转发模型流量。
- **只用 API key 类上游**（章程 §5.2③、L-6）：magpie 能读取并代用 Claude、ChatGPT、Copilot、Gemini 等个人订阅的登录态，阡陌不用这部分。阡陌签发的每把密钥都带显式的模型白名单，白名单只由 API key 类供应商（`provider/*`）与成员全部是 API key 类供应商的路由组组成；控制台不提供订阅登录入口，已有的订阅类上游只读展示并标「阡陌不使用」。
- **中转商排除条款**（[`providers-console-m1.md`](./providers-console-m1.md) §4.5）：magpie 预设指向运营方自己部署的网关，不是第三方中转商，不在排除之列；预设不带推广链接、logo 或赞助排序（N-5）。magpie 自己的预设目录里有中转站与赞助位：公开版订阅页只列厂商自有接口（`vendor` 类）与 OpenRouter（同 §4.5 的例外）；「网关」页是平台运维自用，列全部 API key 类预设，按 id 排序。
- **证据状态**：magpie 预设 `evaluated:false`；真实 magpie 与真实上游的整轮调用只在 §4 P33.4 记下的组合上跑过，其余组合（跨公网节点、多节点并发、超过 1 小时的长跑、其他上游）仍标「未评估」。

## §1 部署形态

| 项 | 定案 |
|---|---|
| 运行 | `magpie serve --web=127.0.0.1:3430`（systemd 用户服务，或 `ghcr.io/yetone/magpie` 容器把 CMD 换成 `serve --web=0.0.0.0:3430` 并只在内网映射 3430）。`DO_NOT_TRACK=1` 关掉每日统计 |
| 网关 | `MAGPIE_ADDR` 设为非回环地址，配 `--tls-cert/--tls-key`（或放在 TLS 前置之后并设 `MAGPIE_TRUST_PROXY=1`）。非回环即「在网络上」，每个调用方都必须带启用中的网关密钥。可选 `MAGPIE_ALLOW_IPS` 只放行节点所在网段：名单外的来源在看密钥之前就被 403，连有效密钥也一样；本机（回环与本机自己的地址）总是放行，所以 TLS 前置与网关同机时名单看到的是前置的地址，要在前置上限来源（magpie 源码 `internal/gateway/allow.go` 注明，P33.4 实测了直连 TLS 的名单行为）。带证书后对别的电脑只说 https，明文 http 回 400。**节点信任自签 CA**：`NODE_EXTRA_CA_CERTS` 指向 CA（qianmopi 与 Claude Code），`SSL_CERT_FILE` 指向「系统根 + CA」的合并包（Codex）；两者都在常驻主机传给底层的环境白名单里。缺了 CA 时 Claude Code 立即报错、qianmopi 十几秒后报错，Codex 不让回合失败、一直重连 |
| 回环陷阱 | magpie 对回环来源不校验密钥（被吊销的密钥从回环来也会被放行且不计数）。因此**节点不得经回环访问网关**；与中枢同机时，节点仍走对外地址，中枢也只用管理口 |
| 管理口 | `MAGPIE_WEB_KEY`（16 位以上），只监听回环或内网；中枢以 cookie `magpie_web_<port>=<key>` 调用。管理口是全权的，钥匙由中枢加密保管、只写不读。magpie 启动时把带钥匙的管理链接打印到标准输出，journald 或容器日志要按机密保管（P33.4 实测） |
| 时区 | 自然月、自然周额度按 magpie 进程的本地时区算，容器里设 `TZ=Asia/Shanghai` |
| 额度插件 | magpie 的「Key limits」内置插件（插件 id `budget`）必须开着；关着时设了上限的密钥会被 503 拒绝（故障关闭），中枢检查时报出。`0.1.1278` 的默认预设 `essentials` 已开启（`magpie plugin dump` 可查） |

## §2 P33 在阡陌里怎么接

### 2.1 一个普通的模型档案

新增预设 `magpie`（`atlas/packages/providers/src/presets.ts`）：

| 通道 | 地址 | 认证 |
|---|---|---|
| `anthropic` | 网关源站（`https://gw.example.com`） | 档案下发 Bearer，Claude Code 发 `x-api-key`（magpie 依次读 Bearer、`x-api-key`、`x-goog-api-key`） |
| `openai-responses` | 源站 + `/v1` | Bearer |
| `openai-chat` | 源站 + `/v1` | Bearer |

模型号就是 magpie 的号：`provider/model`（模型段可以再带斜杠）或 `group/<id>`。目录取自 `GET /v1/models`（受限密钥只看得到自己能用的模型）。之后的编译（`models.yml` / `config.yml`）、经 SSH 第六类动作下发、节点空闲时热切换、期望与实际对账、Claude Code 的 `ANTHROPIC_BASE_URL`/`ANTHROPIC_API_KEY` 与 Codex 的 `-c model_providers.qianmo…` 全部不变。

**一把密钥服务三种底层**：magpie 在同一个端口上说三种协议，所以中枢写进 magpie 档案的除了主通道，还有档案字段 `laneAddresses`（另外两条通道各自的地址，上表）。节点编译时为每条另给的通道多写一个同模型、同密钥的 provider（`qm-<档案>-<地址与通道的哈希>`），主通道仍是 qianmopi 用的那一个；Claude Code 与 Codex 取档案里自己协议的那一个，没有就照旧报「需要某某通道的档案」。字段只发给上报了 `capabilities.laneAddresses` 的节点，旧节点照旧收到单通道档案；只允许对话通道、不能重复主通道、档案只能有一把密钥。签发时选的通道因此只决定 qianmopi 走哪种协议。

### 2.2 绑定与密钥

- **绑定**：一把网关密钥绑定到 `{kind:'node', id}`（自用部署，一台节点一把）或 `{kind:'tenant', id}`（公开版，一个订阅者一把，P35）。
- **签发**：中枢生成 32 位以上的随机密钥（不以 `sk-magpie-` 开头，magpie 保留这个前缀），经 `POST /api/caller-keys/add-key {"name":"qm-<binding>-<uuid>","secret":…}` 建到 magpie，再按名字找回 id；随后 `models-key` 写白名单（§0），按需 `limit-key` 设上限。
- **保管**：密钥明文只进 P18 的模型档案（`consoleProvidersSecrets.ts` 的信封加密），magpie 侧状态文件只记名字与 id。之后节点拿到它的方式与任何 API key 档案相同。
- **轮换**：`rotate-key` 由 magpie 生成新值（magpie 不接受指定值，所以轮换后的密钥以 `sk-magpie-key-` 开头）→ 更新档案密钥 → 走正常下发；旧密钥在 magpie 侧即时失效（magpie 每次请求都重读密钥表）。
- **已知窗口**：① magpie 的 `add-key` 不接受白名单与停用，新密钥建出来那一刻是「启用 + 不限模型」，中枢紧接着写白名单（公开版的订阅者密钥再停用）；这段毫秒级窗口里密钥值只有中枢知道。② 轮换后旧值立即失效，节点按 [`providers-console-m1.md`](./providers-console-m1.md) §2.7 等空闲才切到新值：在途的请求照常完成（magpie 只在请求开始时验密钥）；等待期间进旧一代的新回合拿 401 失败——这不是限流，底层不按限流重试，Codex 约 6 s 失败，Claude Code 按自己的重试走完约 3 分钟才失败；空闲换代后重试成功。这几条出自 P33.4 TLS 补测，其中换代由测试脚本 `node-runner.ts` 的 `maybeSwitch` 按 §2.7 的规则驱动（有回合在途就等，空闲后按新档案重起热会话），常驻主机不在环内。由此推断常驻主机在 Claude Code 那约 3 分钟里把节点算忙、换代推迟到它失败之后，这一点未评估。一次性起的 `qm agent -p` 直接读到新值。
- **下发时节点能力未知先问节点**：中枢按节点回报的能力决定是否带 `laneAddresses`。档案带另给的通道、而这个节点自中枢启动以来还没回报过能力（或状态查询一直失败）时，下发前先做一次状态查询，仍未知就拒绝（`capabilities-unknown`），不按 v1 下限把通道编掉——否则节点只剩主通道、Claude Code 与 Codex 找不到自己协议的档案，而版本号相同、中枢不会补发（P33.4 TLS 补测中发现并修掉）。
- **下发结果逐台看**：签发、改模型、轮换、收回与换网关地址之后的下发，按节点自己的回答判断；节点没接（不可达、拒绝、`capabilities-unknown`）时给调用方失败说明（写明已经做成的部分）并写告警，不当成功。收回时节点没接回原来的档案，密钥先不删；指派已经改回，再收回一次就直接删。
- **吊销**：先把节点改派回原档案或空档案，再 `remove-key`；公开版到期用 `off-key`（续费时 `on-key`），不删记录。
- **订阅者删上游**（P35）：先把订阅密钥的白名单收窄到不含它（最后一个就先停用），再从 magpie 删，最后才从中枢的记录里去掉；中途哪一步失败，记录都还在，再删一次就能做完，不会留下中枢已经不认、却还存着订阅者 key 的上游。

### 2.3 中枢的 `MagpiePort`

| 项 | 定案 |
|---|---|
| 状态文件 | `qianmoConfigPath('qianmo','console','magpie.json')`，0600 原子写：节点看到的网关源站、管理源站、绑定表 `[{binding,keyId,keyName,profileId,createdAt}]` |
| 秘密 | 管理钥另存信封加密文件，AAD 绑定用途；接口只回指纹 |
| 客户端 | `@qianmo/magpie`：只收源站（无路径、无账号、无查询串），非回环必须 https；不跟随重定向；默认 5 s 超时；响应上限 2 MiB；错误带稳定的 `code`，任何报错文字都不含密钥 |
| 方法 | `state` / `connect` / `check`、上游与路由组的增删改、`issueKey(binding)` / `updateKey` / `rotateKey` / `removeKey`、`usage(period)`；给 P35 的 `bindTenant` 与 `setBindingEnabled` |
| 写权限 | 个人 `ops` 账号且不在 break-glass 下；开启租户时只有 `platformSubjects`（共享网关属于「无法按节点归属拆分的全局管理功能」，[`tenancy-m2.md`](./tenancy-m2.md) §3） |
| 换网关地址 | 每个绑定的档案改到新地址：节点密钥的档案以运维身份改并逐台下发；订阅者的档案以中枢自己的身份改（公开版包装层只让中枢写它），再通知计费端口，由它的节点同步下发并重试；「无模型」档案同样跟着改 |
| 开关 | `qm console --magpie`，需要 `--accounts` 与 `--providers` |

### 2.4 用量与记账

- 用量取 magpie 的记录（每次请求一行，含模型、token、缓存读写、状态与调用密钥）。magpie 的费用是按当前价目表现算的**估算**，页面写「估算」，不当账单用。
- 阡陌自己的 `usage.tokens` 审计与配额（`UsagePort`）不变；两边口径不同（magpie 按网关看到的请求，阡陌按回合），并列显示，不合并。
- 网关密钥额度耗尽时 magpie 在联系上游之前回 429（带 `Retry-After`、`X-Magpie-Limit-Reset`、`X-Should-Retry: false`，正文是调用方协议的错误形状）。三种底层都把它当限流处理；阡陌把 `X-Magpie-Limit-Reset` 写进常驻回合的失败说明。

## §3 P34「网关」页（阡陌风格）

不嵌 magpie 自带的网页：它的页面有赞助位与厂商 logo（N-5 不许），样式与阡陌不一致，跨站嵌入时 cookie 也不生效。阡陌在 `/admin/magpie` 按控制台现有技术形态自己画：服务端渲染、零依赖、一页一个 `<style>` 一个 `<script>`、CSP 按哈希、文案过门禁。

| 区块 | 内容 |
|---|---|
| 连接 | 网关源站、管理源站、管理钥（只写）、状态（版本号、额度插件、上次检查） |
| 上游 | 供应商名、地址的主机部分、模型数、启停、测连、删除；从 magpie 预设加一个只填 key，或按地址加自定义上游（名称、key、Chat Completions / Responses / Anthropic Messages 地址至少一个）；订阅类上游只读，标「阡陌不使用」 |
| 路由组 | 名称、成员、选择方式、会话粘性；新建与编辑 |
| 网关密钥 | 绑定对象（节点 / 租户）、上限与已用、重置时间、模型白名单、启停、轮换、删除；「为节点签发」 |
| 用量 | 今天 / 7 天 / 30 天 / 全部；按密钥与模型的 token 与估算费用 |

导航：区域 `magpie`，标签「网关」，`main` 组，图标取 Lucide。只读角色看不到指纹，地址只显示主机部分。

## §4 包表与完成标准

| 包 | 内容 | 完成标准 |
|---|---|---|
| P33.1 | `@qianmo/magpie` 客户端与假 magpie 服务（测试用，导出给其他包） | 每个方法对假服务有用例；地址校验、拒绝重定向、超时、体积上限、认证失败、报错不含密钥 |
| P33.2 | `magpie` 预设与模型号校验 | `presets.test.ts` 控制台集合 = 节点集合；`provider/model`、`group/<id>` 能编译进 `models.yml` |
| P33.3 | `MagpiePort` 与 `--magpie` | 用假 magpie 跑通签发 → 建档 → 指派 → 下发 → 轮换 → 吊销；状态文件 0600；白名单只含 API key 类上游 |
| P34 | 「网关」页 | 路由、页面、角色、文档同步、动作词、依赖与文案各门禁通过；读者看不到写控件 |
| P33.4 | 真实 magpie 冒烟 | **2026-10-17 实测通过**。环境：magpie `0.1.1278` linux-arm64 官方二进制跑在 colima 容器里（`DO_NOT_TRACK=1`、`TZ=Asia/Shanghai`），网关经端口映射访问，magpie 看到的来源都不是回环，每个调用都要密钥；上游是一个 API key 类自定义上游；Claude Code `2.1.301`、codex-cli `0.163.0`，qianmopi 与中枢为本分支源码。结果：中枢签发 → 建档 → 下发到真节点；同一台节点、同一把密钥上 qianmopi（`qm agent -p`）、Claude Code（阡陌的 stream-json 启动参数与环境）、Codex（阡陌的 `CodexChannel` 驱动 `codex app-server`）各完成一轮真实对话，用量按这把密钥归账；轮换后节点拿到新值、旧值 401；额度用尽回 429，带 `Retry-After`、`X-Magpie-Limit-Reset`、`X-Should-Retry: false`；删钥后 401；另一个容器与宿主不带或带错密钥一律 401，不带 cookie 访问管理口 401。冒烟中补了两处：网关页可按地址加自定义上游、`laneAddresses`。证据在 `atlas-evidence/2026-10-17/magpie-smoke/`。<br>**TLS 补测（同日）**：magpie 同一发行版以 `--tls-cert/--tls-key` 起网关与管理页（自签 CA，`MAGPIE_ALLOW_IPS` 只放节点网段，`DO_NOT_TRACK=1`、`TZ=Asia/Shanghai`，只映射到本机回环、不对公网开放）；中枢以 https 网关源站与 https 管理源站连接、签发、下发，非回环的 http 源站被客户端拒绝，中枢不信任 CA 时报「连不上」；节点信任 CA 后一把密钥上 qianmopi、Claude Code、Codex 各通一轮。第三来源在名单内不带或带错密钥一律 401（三种协议），名单外连有效密钥也 403。节点连续 1 小时、每 5 分钟三种底层各一轮（39/39 成功），中途在 Claude Code 长回合进行时轮换：长回合照常完成，进旧一代的 Codex 回合 401，节点空闲后换代、重试成功；换代由测试脚本 `node-runner.ts` 的 `maybeSwitch` 按 providers-console-m1 §2.7 的规则驱动，常驻主机不在环内。补测中修掉一处：节点能力未知时下发会丢掉 `laneAddresses`（§2.2）。证据在 `atlas-evidence/2026-10-17/magpie-smoke-tls/`。<br>**未覆盖**：跨公网的另一台机器（节点与网关在两台机器上）、多节点并发、超过 1 小时的长跑、常驻主机自己驱动的换代（上面由测试脚本代行）。 |

## §5 不做

- 不在阡陌里实现路由、故障转移或协议转换（magpie 做）。
- 不经中枢转发模型请求；不在中枢上替节点测连测速。magpie 上游的测连与拉列表由 magpie 自己发出，中枢只经管理接口触发（§0 例外）。
- 不使用 magpie 的订阅登录、账号导入、账号切换、`claude-code install` 等功能。
- 不把 magpie 的网页嵌进控制台，不改 magpie 源码；magpie 升级跟随其官方发行版，由运维执行。

## §6 P37 桌面版与订阅迁移（规划）

负责人 2026-10-17 提出，状态为**规划**：未开发、未评估，负责人计划一天内完成开发；完成标准在设计定稿时补进 §4。

- **目标**：用户在个人电脑上安装阡陌桌面版，经 magpie 把网关里配好的模型套餐接到本机的 Claude Code、Codex 等智能体；换用另一个智能体工具时，模型、额度与用量记录跟着走（同一把网关密钥、同一份模型白名单与额度，用量仍按这把密钥归账）。
- **「订阅」指什么**：用户在网关里配好的模型套餐与 API 密钥（API key 类上游及其路由组），不是 Claude、ChatGPT、Copilot 等个人订阅的登录态。
- **合规边界**（章程 §5.2③、L-6，与 §0、§5 一致）：只放行 API key 类上游；不使用 magpie 的个人订阅登录、账号导入或 `claude-code install`，不让本机智能体借用订阅账号的身份；不转售模型额度（与 P35「不卖模型额度」一致）。
- **沿用的部分**：密钥签发、白名单、额度、轮换与吊销走 P33 的链路；一把密钥服务三种协议靠 `laneAddresses`（§2.1）。写本机智能体工具的配置时只写阡陌自己的条目、可撤销，不改用户已有的配置。具体形态（绑定对象、配置写入方式、桌面端界面）待设计。

