<!-- Copyright 2026 Qianmo AgentNest Team -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# 阡陌 Qmo — magpie 统一模型调度与「网关」页设计（P33 ~ P34）

| 项 | 内容 |
|---|---|
| 文档版本 | **v1.0（生效）** |
| 日期 | 2026-10-17 |
| 核对基点 | 本仓库 `db52f282`（main，#229 合并提交，基座 qianmopi v18.8.8）；magpie 源码 `yetone/magpie@8b84dc9`，本机发行版 `magpie 0.1.1268`，GitHub 发行 `v0.1.1278` 有 `magpie-cli-linux-{amd64,arm64}` |
| 范围依据 | 负责人 2026-10-17 决定（对话记录）：接入 magpie 作为模型统一调度管理器；前端按本项目的风格特化；另立公开版（见 [`public-edition.md`](./public-edition.md)，P35）。章程 v3.5 §2.7 |
| 编号 | P33 magpie 统一模型调度；P34「网关」页 |
| 结论一句话 | magpie 作为平台网关单独运行，节点带各自的网关密钥直连它取模型；中枢只调 magpie 的管理接口发放密钥、设额度、读用量，不转发模型流量；在阡陌里 magpie 就是一个普通的模型档案，编译、下发、热切换全部沿用 P18 |

由主 agent 按负责人 10-03 的常设委托（设计取舍自行裁定）定案。「未评估」是证据状态，不是授权门槛。

---

## §0 口径

- **magpie 是什么**：开源（MIT）的本地/服务端模型网关，同一端口说 OpenAI Chat、OpenAI Responses、Anthropic Messages 与 Gemini 四种协议并互相转换；管上游供应商、路由组（同一组内按 smart / order / rotate / usage / pace 选成员、额度用完换下一个）、网关密钥（每把密钥可限模型、可设按日/周/月/N 天的 token 与估算费用上限）和用量记录。
- **一切原生化适配**（章程 §7.2 第 8 条）：magpie 的路由、故障转移、额度和用量都用它自己的；阡陌不另做调度层、不做协议转换，只做 magpie 没有的那一层——身份、授权、隔离、记账与审计。三种底层仍按各自原生协议直连网关：Claude Code 对 `/v1/messages`，Codex 对 `/v1/responses`，qianmopi 按档案通道。
- **模型调用不经过中枢**（章程 N-5 v2.22「由中枢代为调用模型」仍不解禁，R-9 不变）：magpie 是一个独立的网关服务，可以和中枢同机，但不是中枢进程，模型流量是「节点 → magpie → 上游」。中枢只调用 magpie 的管理接口（`/api/*`）和 `/api/hello`、`/v1/models` 这类只读接口。
- **只用 API key 类上游**（章程 §5.2③、L-6）：magpie 能读取并代用 Claude、ChatGPT、Copilot、Gemini 等个人订阅的登录态，阡陌不用这部分。阡陌签发的每把密钥都带显式的模型白名单，白名单只由 API key 类供应商（`provider/*`）与成员全部是 API key 类供应商的路由组组成；控制台不提供订阅登录入口，已有的订阅类上游只读展示并标「阡陌不使用」。
- **中转商排除条款**（[`providers-console-m1.md`](./providers-console-m1.md) §4.5）：magpie 预设指向运营方自己部署的网关，不是第三方中转商，不在排除之列；预设不带推广链接、logo 或赞助排序（N-5）。
- **证据状态**：magpie 预设 `evaluated:false`；只用假 magpie 测过的接口、没有用真实上游跑过整轮的组合，页面与文档标「未评估」。

## §1 部署形态

| 项 | 定案 |
|---|---|
| 运行 | `magpie serve --web=127.0.0.1:3430`（systemd 用户服务，或 `ghcr.io/yetone/magpie` 容器把 CMD 换成 `serve --web=0.0.0.0:3430` 并只在内网映射 3430）。`DO_NOT_TRACK=1` 关掉每日统计 |
| 网关 | `MAGPIE_ADDR` 设为非回环地址，配 `--tls-cert/--tls-key`（或放在 TLS 前置之后并设 `MAGPIE_TRUST_PROXY=1`）。非回环即「在网络上」，每个调用方都必须带启用中的网关密钥。可选 `MAGPIE_ALLOW_IPS` 只放行节点所在网段 |
| 回环陷阱 | magpie 对回环来源不校验密钥（被吊销的密钥从回环来也会被放行且不计数）。因此**节点不得经回环访问网关**；与中枢同机时，节点仍走对外地址，中枢也只用管理口 |
| 管理口 | `MAGPIE_WEB_KEY`（16 位以上），只监听回环或内网；中枢以 cookie `magpie_web_<port>=<key>` 调用。管理口是全权的，钥匙由中枢加密保管、只写不读 |
| 时区 | 自然月、自然周额度按 magpie 进程的本地时区算，容器里设 `TZ=Asia/Shanghai` |
| 额度插件 | magpie 的「Key limits」内置插件必须开着；关着时设了上限的密钥会被 503 拒绝（故障关闭），中枢检查时报出 |

## §2 P33 在阡陌里怎么接

### 2.1 一个普通的模型档案

新增预设 `magpie`（`atlas/packages/providers/src/presets.ts`）：

| 通道 | 地址 | 认证 |
|---|---|---|
| `anthropic` | 网关源站（`https://gw.example.com`） | `x-api-key`（magpie 依次读 Bearer、`x-api-key`、`x-goog-api-key`） |
| `openai-responses` | 源站 + `/v1` | Bearer |
| `openai-chat` | 源站 + `/v1` | Bearer |

模型号就是 magpie 的号：`provider/model`（模型段可以再带斜杠）或 `group/<id>`。目录取自 `GET /v1/models`（受限密钥只看得到自己能用的模型）。之后的编译（`models.yml` / `config.yml`）、经 SSH 第六类动作下发、节点空闲时热切换、期望与实际对账、Claude Code 的 `ANTHROPIC_BASE_URL`/`ANTHROPIC_API_KEY` 与 Codex 的 `-c model_providers.qianmo…` 全部不变。

### 2.2 绑定与密钥

- **绑定**：一把网关密钥绑定到 `{kind:'node', id}`（自用部署，一台节点一把）或 `{kind:'tenant', id}`（公开版，一个订阅者一把，P35）。
- **签发**：中枢生成 32 位以上的随机密钥（不以 `sk-magpie-` 开头，magpie 保留这个前缀），经 `POST /api/caller-keys/add-key {"name":"qm-<binding>-<uuid>","secret":…}` 建到 magpie，再按名字找回 id；随后 `models-key` 写白名单（§0），按需 `limit-key` 设上限。
- **保管**：密钥明文只进 P18 的模型档案（`consoleProvidersSecrets.ts` 的信封加密），magpie 侧状态文件只记名字与 id。之后节点拿到它的方式与任何 API key 档案相同。
- **轮换**：生成新密钥 → `rotate-key` → 更新档案密钥 → 走正常下发；旧密钥在 magpie 侧即时失效（magpie 每次请求都重读密钥表）。
- **吊销**：先把节点改派回原档案或空档案，再 `remove-key`；公开版到期用 `off-key`（续费时 `on-key`），不删记录。

### 2.3 中枢的 `MagpiePort`

| 项 | 定案 |
|---|---|
| 状态文件 | `qianmoConfigPath('qianmo','console','magpie.json')`，0600 原子写：节点看到的网关源站、管理源站、绑定表 `[{binding,keyId,keyName,profileId,createdAt}]` |
| 秘密 | 管理钥另存信封加密文件，AAD 绑定用途；接口只回指纹 |
| 客户端 | `@qianmo/magpie`：只收源站（无路径、无账号、无查询串），非回环必须 https；不跟随重定向；默认 5 s 超时；响应上限 2 MiB；错误带稳定的 `code`，任何报错文字都不含密钥 |
| 方法 | `state` / `connect` / `check`、上游与路由组的增删改、`issueKey(binding)` / `updateKey` / `rotateKey` / `removeKey`、`usage(period)`；给 P35 的 `bindTenant` 与 `setBindingEnabled` |
| 写权限 | 个人 `ops` 账号且不在 break-glass 下；开启租户时只有 `platformSubjects`（共享网关属于「无法按节点归属拆分的全局管理功能」，[`tenancy-m2.md`](./tenancy-m2.md) §3） |
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
| 上游 | 供应商名、地址的主机部分、模型数、启停、测连、删除；从 magpie 预设加一个只填 key；订阅类上游只读，标「阡陌不使用」 |
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
| P33.4 | 真实 magpie 冒烟 | **未评估**：等真实上游 key 与部署后，在节点上用三种底层各跑一轮，回写本节 |

## §5 不做

- 不在阡陌里实现路由、故障转移或协议转换（magpie 做）。
- 不经中枢转发模型请求；不在中枢上替节点测连测速。
- 不使用 magpie 的订阅登录、账号导入、账号切换、`claude-code install` 等功能。
- 不把 magpie 的网页嵌进控制台，不改 magpie 源码；magpie 升级跟随其官方发行版，由运维执行。
