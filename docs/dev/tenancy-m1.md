<!-- Copyright 2026 Qianmo AgentNest Team -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# 阡陌 AgentNest — 租户、账号与智能体生命周期设计（M1 · P15）

| 项 | 内容 |
|---|---|
| 文档版本 | **v0.1-draft**（待负责人裁定 §0 决策点 0 与 §7 其余各项；评审通过后的修订直接改本文并升版本号） |
| 日期 | 2026-09-26；源码与文档核对基点 `30878097` |
| 本文范围 | **只有设计。**不改代码，不改 `roadmap.md` / `charter.md` / 其他设计件；范围回写归 P15.1 |
| 范围依据 | roadmap M1 方向表「注册发现产品化」（`roadmap.md:852`）中的**账号体系**与**智能体生命周期管理**两段；「多租户与配额雏形」（`roadmap.md:856`）整行 |
| 上游文档（指针，不复制） | [`console.md`](./console.md)、[`beta-env.md`](./beta-env.md)（§3「账号最小形态」是本文若获解禁要改写的定案）、[`node-provisioning.md`](./node-provisioning.md)（v0.1-draft，本文只给它加一个输入项）、[`key-distribution.md`](./key-distribution.md)、[`resident-botization.md`](./resident-botization.md)（已认领配额「机制」那半，`roadmap.md:870`） |
| 下游 | `authorization-m1.md`（P14，并行起草）只消费本文 §3.5 的接口，本文不替它设计授权流 |
| 编号 | P15.x。基点上 `git grep "P15\.[0-9]"` 零命中 |
| 结论一句话 | **先裁定 N-2。**若解禁：租户以**节点**为隔离单元，映射只住中枢配置，**协议零改动**；账号取「邀请制 + 个人凭据 + 服务端会话」，不做口令与外部身份源；配额只做租户级用量（消息 / turn / token 强制，存储只计量），不进 `LIMITS`、不计价。若不解禁：用一次性注册令牌满足「无需 CLI 即可注册」，租户隔离与账号整体挪 M2。**两个分支都需要的「注册持久化」可以先做** |

---

## §0 决策点 0：N-2 解禁与否

### 0.1 矛盾在哪（逐条出处）

| 出处 | 原文要点 |
|---|---|
| `charter.md:137` N-2 | 「M0 全部节点属于同一团队、同一信任域。不做账号体系、不做租户级数据隔离。**内测（M1）再做。**」 |
| `charter.md:140`、`:38`（v2.14 解禁 N-5） | 解禁控制台时写明「**不做账号体系（N-2 仍然有效）**」「N-2 保持有效」——这是 M1 语境下的表态 |
| `charter.md:513` §8 | M2 出口：「对外开放注册，**多租户与配额上线**」 |
| `roadmap.md:852`、`:856` | M1 方向表列入「账号体系」与「多租户与配额雏形」，判据「跨租户数据访问用例全部被拒」 |
| `beta-env.md:28`、§3.1 | 已评审定案「不做账号体系（N-2 不解禁）」：一枚共享 view + 两人持 admin |
| `node-provisioning.md:530` | 第三枚 token「不算账号体系，N-2 不需要解禁」，论证轴是「按能力分 vs 按主体分」 |

N-2 列在「M0 明确不做」之下，正文又写「M1 再做」，单读它可以理解为到 M1 自然失效；但 v2.14 在 M1 语境下重申它有效。两份规范文件对同一件事的判断相反，只能按 `charter.md:499`（§7.3「非目标解禁：全员评审 + 负责人签字，回写本文 + 评估对排期影响」）处理。**本文不替负责人判定「是否已经解禁」。**

### 0.2 两个选项

| | **选项 A：按 §7.3 解禁，限定形态** | **选项 B：不解禁，维持 v2.14** |
|---|---|---|
| 解禁范围（穷举，照 v2.14 的写法） | ① 控制台个人账号：邀请制开户、每人一枚个人凭据、服务端会话可吊销（§3）；② 节点粒度的租户隔离（§1、§2）；③ 租户级用量配额，只计量与设硬上限，不计价（§4） | 无 |
| 仍不解禁 | 公开自助注册（章程 §8 放在 M2）、外部身份源、节点内按 agent 分租户、跨租户互通、计费（N-1） | 全部 |
| M1 能达成的判据 | `:852` 判据（开户 + 页面内注册与查看）；`:856` 判据（§5 矩阵） | `:852` 判据经一次性注册令牌达成（§3.7）；`:856` 判据**在 M1 内不可达**，须随 roadmap 回写挪 M2（与章程 §8 的 M2 行一致） |
| 工时（§6） | 120–216 人时 | 36–68 人时 |
| 要改写的既有定案 | `beta-env.md` §3（§0 定案 #4）；`console.md` §8.1；章程 N-2 行加补注并升版本号；roadmap 两行 | 章程不改；roadmap `:852` 的「账号体系」与 `:856` 整行注明挪 M2 |
| 主要代价 | 中枢多一份凭据库与会话表（新攻击面）；迁移期两套凭据并存；运维要管开户与吊销 | P14 的「用户确认」没有「用户」，确认人只能是「持 admin token 者」；收回一个人的访问仍是全员换 token（`beta-env.md` §3.4 第 1 条）；审计仍答不出「是谁」（`console.md` §8.1） |

### 0.3 建议

**建议 A。**决定性理由在 P14：M1「权限模型上线」的判据是「所有需确认动作 100% 经过用户授权链路」（`roadmap.md:853`），链路里的「用户确认」需要一个可区分、可撤销的主体。选 B 等于让 P14 以共享 admin token 为确认主体，事后复盘答不出「谁确认的」。次要理由：`:856` 的判据本身可机检（§5），选 B 只是推迟，不会让它变简单。

**选 A 的前提**是 §1.4 的威胁模型被接受：隔离防的是「另一租户的合法用户」，不防中枢失陷。若负责人要求 M1 的租户隔离能抵御中枢失陷，A 的估算不成立（须先完成 `SIGNED_TASK_POLICY` 切默认与每租户签发身份，见 D3），此时建议改选 B。

### 0.4 与裁定无关、可以先做的两包

- **P15.2 注册持久化**：今天控制台上的「注册」活不过 90 s。控制台只有按需心跳（`src/cli/handlers/consolePorts.ts:283`），没有续租者；租约 `DEFAULT_TTL_MS = 90_000`（`packages/registry/src/registry.ts:21`），过期条目从 `list()` / `resolve()` 消失（`registry.ts:727-753`）；内测注册中心只替 `--register` 启动参数那批续租（`demo/lib/p81-registry.ts:109-119`，`demo/env/beta/beta-up.sh:295-303`、`:326-327`）。**判据里的「完成注册」今天只在 90 s 内成立**，A、B 都要修。
- **P15.3 一次性令牌**：B 的全部交付；在 A 里它是邀请开户的底座（§3.1）。

---

## §1 租户模型（若解禁）

### 1.1 租户是什么

租户 = **一组共享节点与数据的人**（课题组、竞赛队、课程小组），不是个人。理由是硬件：内测是 4 个节点服务 20–50 人（`beta-env.md` §2.2），「一人一租户」意味着一人至少一个节点。租户由运维创建，M1 不提供自助开通。

### 1.2 对应关系

| 对象 | 与租户的关系 | 理由 / 出处 |
|---|---|---|
| 节点 | **N:1，一个节点只属于一个租户**；隔离单元是节点 | 现有隔离面都已按节点切：配置根（`beta-env.md` §4.1）、审计链（§4.2）、记忆根（由配置根派生，`packages/memory/src/paths.ts:32`、`src/utils/config/envUtils.ts:15`）、会话表（`src/services/qianmo/resident.ts:484`）、准入台账（`:1967`）、ESTOP（`:515`）、节点身份密钥（`src/services/qianmo/nodeIdentity.ts:51`）、PSK（`beta-env.md` §8.2）、机器（一机一节点，§2.2） |
| agent | **派生**：`tenantOf(qianmo://n/a) = tenantOf(n)`，不另存字段 | 另存就有两份可以不一致的事实 |
| 控制台用户 | **N:1**，M1 一个账号只属于一个租户；另有不属于任何租户的**运维**角色（§3.2） | 一人多租户需要租户切换与跨租户会话语义，目前没有需求证据 |
| 证书 / CA | **不变**：单一离线 CA（`key-distribution.md` §3），证书 SAN 不写租户 | SAN 格式「写死，两处不得各写一份」（同文 §4.2）；PSK 档节点没有证书；写进证书要全网重签 |
| 注册中心记录 | **不带租户字段** | 注册中心零鉴权（`packages/registry/src/http.ts:198-239` 无任何凭据检查，`console.md` §8.2），租户字段在那里只是谁都能写的标签 |
| 协议（信封、帧、capability） | **零改动** | capability claims 字段闭合，多一个键整枚被拒（`packages/protocol/src/capability.ts:142-152`），加 `tenant` 会让新旧节点互拒；`protocol.md:51`「不定义多租户」保持成立；A2A G-24 维持「不适用」（`a2a-gap.md:304`） |

### 1.3 映射只住一处：中枢配置

事实源是中枢的 `peers.conf`：每条 `node` 坐标行加 `tenant=<id>`，照 `--node-server` 的既有形态（`console.md` §11.1，事实只从启动参数来）派生启动参数——控制台 `--node-tenant <node>=<tenant>`；节点 `--tenant <自己的租户>`，多节点直连拓扑另加 `--peer-tenant <node>=<tenant>`。租户 id 复用 `@qianmo/protocol` 的 `isValidSegment`，不另写正则。**控制台与节点都把这张表当白名单**：表里没有的节点，对任何租户用户都等同不存在。

### 1.4 威胁模型：防谁，不防谁

| 防 | 不防（写明，不在实现里假装） |
|---|---|
| 另一租户的合法用户：持有其个人凭据，会用浏览器与 `curl` | **中枢失陷**：注册中心、控制台、审计镜像、全部节点 PSK 同在中枢（`beta-env.md` §8.3），中枢一旦被拿下，所有租户一起失守 |
| 另一租户的节点按 `from` 投递 | **PSK 档下的 `from` 伪造**：`from` 只是审计标签（`key-distribution.md` §7.1 L1），PSK 档里节点侧租户闸只是纵深，不是边界 |
| — | 同机、同 uid 的其他进程（配置根分离不是 uid 边界） |

### 1.5 迁移：默认租户、影子模式、数据面零停机

| 阶段 | 做什么 | 行为变化 | 判据 |
|---|---|---|---|
| M-0 | 代码上线，映射缺省 | **无**：没有 `tenant=` 的节点全部落入租户 `default`，跨租户判定恒为同租户 | 既有控制台与常驻测试逐字不改，全绿 |
| M-1 | `peers.conf` 写 `tenant=`；按 `beta-env.md` §7.1 的顺序（注册中心 → 节点逐个 → 控制台）重起 | 节点闸以 **shadow** 运行：只记 `TenantRefused{mode:'shadow'}`、不拒（照 `shadowPolicy` 的既有形态，`src/cli/handlers/resident.ts:1078`） | 建议连续 7 天 shadow 事件为零，或逐条有解释 |
| M-2 | 控制台开账号（§3.4 共存期） | 旧 view token 只能看 `default` 租户 | 运维单页名单内的人全部开户 |
| M-3 | 节点闸切 `enforce`，旧 view token 下线 | 跨租户开始被拒 | §5 矩阵 N/N；真机同一部署连续两轮零红 |

「零停机」的准确含义：**数据面零停机**（节点逐个重起，其余节点不受影响）；控制台每阶段重起一次，实测 H 腿就绪 3–4 s（`beta-env.md` §10 包①）。**节点换租户不是改一行配置**：旧租户的记忆、会话、审计、工作区都在那台节点的配置根里，换租户 = `stop` + 归档配置根 + 重新 `install`（`node-provisioning.md` §5）。

---

## §2 隔离面逐层清单

| 层 | 现在靠什么隔离 | 缺什么 | 怎么加 |
|---|---|---|---|
| 注册中心 | 只绑中枢回环（`beta-env.md` §2.3 第 1 条）；一张全局表，`list()` 返回全部（`registry.ts:744`） | 租户过滤；写操作的租户校验 | **注册中心本体不改。**在控制台的 `RegistryPort` 适配层（`consolePorts.ts`）按 `--node-tenant` 过滤列表；写操作在调端口之前校验地址的节点段属于主体租户。节点不连注册中心（`beta-env.md` §2.3 第 2 条），没有节点侧泄露面 |
| 控制台视图 | 两枚共享 token，角色只有 view / admin / none（`packages/console/src/auth.ts:138`）；view 看全部名册与审计，admin 看全部对话 | 主体与租户作用域 | 路由守卫从 `roleOf`（`auth.ts:307`）换成 `principalOf`（§3.5）；每条路由在 `Protection`（`packages/console/src/http.ts:355`）之外再声明租户类别 `public` / `tenant` / `ops`，由元测试保证无遗漏（§5.3）。按 id 读外租户资源回 **404**，与不存在不可区分；写外租户目标回 **403**，文案与「节点不存在」相同。角色判定仍先于存在性判定（`console.md` §4.5） |
| 审计链 | 每节点一条链（`beta-env.md` §4.2），中枢的只读镜像按节点分（§4.3）；记录有 `node` / `peer`，**没有操作者与租户字段**（`packages/audit/src/record.ts:63-93`） | 控制台动作的主体归属 | 租户由链所属节点派生，控制台只给主体看本租户节点的链（`--audit <node>=<path>` 已按节点分，`src/cli/handlers/consoleArgs.ts:611`），消息链还原只在这些链上做。**主体不写进节点审计**（capability 字段闭合，§1.2），改由中枢一本**控制台动作账本**记 `subject / tenant / action / target / taskId / outcome`，形状照 `@qianmo/audit`、按 `audit-witness.md` 锚定，与 `node-provisioning.md` §9 装机账本同一做法；靠 `taskId` 与节点审计对接 |
| 记忆 | 记忆根 = 配置根下的 `memory/`（`packages/memory/src/paths.ts:32`，`src/memdir/paths.ts:85-90`），每节点一份；节点内召回只取 working 层，按 `(agent, contextId)` 分区（`packages/resident/src/memory-sidecar.ts:95-114`） | 节点粒度下无跨租户缺口，**唯一漏口是 `CLAUDE_CODE_REMOTE_MEMORY_DIR`**：两个不同租户的节点指向同一目录即合流 | 节点启动与 `beta-up.sh` 双重断言：不同租户节点的记忆根解析后互不为前缀（照 `identity-coexistence-m1.md` §2「前缀不相交」用例的形态）。同租户内 project / baseline 层按 agent 共享是既有设计（`memory-sidecar.ts:95-99`），不改 |
| 会话 | 每节点一张 `sessions.json`（`resident.ts:484`）；键 `sessionKeyOf(agent, contextId)`（`packages/resident/src/session-key.ts:85-88`）。**`contextId` 由发送方自报、不与发送方绑定**；没带 `contextId` 的请求全部落进共享的 `DEFAULT_CONTEXT`（`:41`） | 一旦允许跨租户投递，外租户用同一个 `contextId` 就能接进别人的 ACP 会话与记忆分区 | M1 靠下一行的「默认拒」在写信箱之前拦住，**不改键格式**（P13.4 的「能读旧格式」判据保持）。**写死一条前提**：将来开放任何跨租户通道之前，`sessionKeyOf` 必须先把发送方租户并入键。同租户多用户：控制台会话 id 是 `randomUUID()`（`src/cli/handlers/consoleChat.ts:315`，`:925` 用作 `contextId`），会话记录加 `owner` 后只对本人与运维可见 |
| 传输 / 路由 | 每节点一把 PSK，全部由中枢持有（`beta-env.md` §8.3），**内测拓扑里节点之间不互拨**；capability 缺省 `OPEN_POLICY`（`src/cli/handlers/resident.ts:1072`） | 租户闸 | **默认拒。**节点侧在 `#receive` 里、`this.#router.inbound` 之后、ESTOP 检查之前加租户闸（`src/services/qianmo/resident.ts:819` 与 `:841` 之间），与既有拒绝同守 L-1：任何副作用之前拒。控制台发起的流量由控制台按主体租户拦（D3）。中枢 `@qianmo/scheduler` 作业的租户 = 目标节点的租户（`packages/scheduler/src/job.ts:92`），加载时校验。节点回中枢的 `notify` 按 `contextId` 归入会话前，校验发出节点与会话同租户，否则丢弃并记账 |
| 沙箱与机器 | 一机一节点（`beta-env.md` §2.2），沙箱只在其中 1 台（§0 定案 #1） | 同一台机器上出现两个租户的节点 | `beta-up.sh` 读 `peers.conf` 时断言：同一 `server=` 下的节点租户必须相同，否则拒绝起 |
| 备份 | 写 / 归档双 token；`workspace` 名由写入方自报（`packages/backup/src/contracts.ts:35`）。**内测未部署**：没有可执行入口（`beta-up.sh:460-468`） | 共享写 token 下，一个节点可以冒名写别人的 `workspace` | **部署时一租户一实例**（独立 store 根 + 独立写 token），零代码改动；归档 token 仍不出中枢 |
| 中枢侧落盘物 | 对话单文件 `chat.ndjson`（`consoleArgs.ts:189`）、服务器备注（`:200`）、调度器状态（`src/cli/handlers/watch.ts:182`） | 记录没有租户与属主 | 对话记录加 `tenant` 与 `owner`；迁移前的旧记录视为 `default` 租户、属主 `legacy:admin`（它们本来只有 admin 看得见，`console.md` §4.5）。服务器备注与调度器配置为运维专属 |

**跨租户投递的拒绝码（D4）**：建议复用基线码 `E_UNKNOWN_AGENT`（`packages/protocol/src/errors.ts:25`）。对外租户而言那个 agent 确实不可达，且不泄露它的存在；真实原因只写节点本地审计（`TenantRefused`）。备选 `E_CAP_INSUFFICIENT`（`:42`）语义更直白，但等于告诉对方「这里有，只是你不能用」。两者都是基线码，不触发规则 N-1（`protocol.md:786-796`）。

---

## §3 账号体系最小形态与生命周期（若解禁）

### 3.1 身份来源：邀请制 + 个人凭据，无口令

| 候选 | 取舍 |
|---|---|
| **邀请制个人凭据**（采纳） | 运维或租户管理员签一枚一次性邀请（绑定租户 + 角色，≤72 h，单次）；用户打开链接后，控制台生成一枚 ≥32 字节的随机个人凭据、**只显示一次**，服务端只存其 SHA-256。登录沿用现有 `/login` 及其退避限流（`console.md` §8.4）。分发渠道与今天发 view 链接相同（`beta-env.md` §3.3 一人一条私信），不新增渠道 |
| 口令账户 | 放弃：找回口令要一条带外渠道，而邀请已经在用那条渠道；高熵随机凭据不需要慢哈希，口令需要 |
| 校园统一认证（CAS / OIDC） | M1 放弃：外部依赖，可用性与接入审批**未核实**；M2 开放注册时再评估 |
| 第三方 OAuth | 放弃：并非每个内测用户都有账号，且多一个外部可用性依赖 |
| WebAuthn / passkey | 推迟：设备与浏览器分布未知 |

### 3.2 角色

| 角色 | 作用域 | 能做 |
|---|---|---|
| `viewer` | 本租户 | 名册、审计、消息链、上限——今天 view 的能力，收窄到本租户 |
| `member` | 本租户 | viewer + 与本租户 agent 对话（只见自己的会话）。对话面今天限 admin 的两条理由（`console.md` §4.5：花对面节点的模型预算；转录是自由文本）分别由 §4 的配额与会话 `owner` 承接 |
| `tenant-admin` | 本租户 | member + 本租户 agent 的生命周期（§3.6）+ 邀请与吊销本租户用户 |
| `ops` | 全部租户 | 今天 admin 的全部能力；建租户靠改中枢配置，不在页面上；每次跨租户读写进控制台动作账本 |

`provision` 仍是独立的第三枚 token，与以上都不可比（`node-provisioning.md` §8.2），本文不动。

### 3.3 会话

今天的 cookie 装的就是 token 本身，没有服务端吊销（`console.md` §8.1）。账号模式改为**服务端会话**：cookie 只装随机会话 id，服务端表记 `{sid, subject, expiresAt}`，时长沿用 `SESSION_MAX_AGE_SECONDS`（12 h，`auth.ts:135`）。会话表**只在内存**，控制台重启即全员重登（凭据在用户手里，代价是一次粘贴），与「控制台没有活过重启的状态」一致（`console.md` §8.4）。账号表落盘为 append-only NDJSON，0600，路径 `occConfigPath('qianmo', 'console', 'accounts.ndjson')`，形态同 `chat.ndjson`。吊销 = 追加一条 `revoked` + 清掉该主体全部会话，**下一个请求即生效**，不缓存授权结论。cookie 的三道 CSRF 防线（`HttpOnly` / `SameSite=Strict` / 自定义头，`console.md` §4.1、§5.1）原样保留。

### 3.4 与现有 bearer token 的共存与淘汰

| 阶段 | view token | admin token |
|---|---|---|
| 共存（迁移 M-2） | 仍可用，主体 `legacy:view`，**作用域钉在 `default` 租户** | 仍可用，主体 `legacy:admin`，等同 `ops` |
| 淘汰（迁移 M-3） | `--legacy-view-token off`；判据：名单内的人全部开户 | **保留为 break-glass**（D7）：它从不离开中枢（`beta-env.md` §3.3），动作照记账本 |

`resolveTokens`（`auth.ts:502`）的三条策略一条不改（先例：`node-provisioning.md` §8.1）；账号解析另起纯函数，两者互不调用。

### 3.5 给 P14 的接口点（只写契约）

```ts
interface ConsolePrincipal {
  readonly subject: string // 'u:<id>' | 'legacy:view' | 'legacy:admin'；稳定、永不复用
  readonly tenant: string // ops 为 '*'
  readonly role: 'viewer' | 'member' | 'tenant-admin' | 'ops'
}
function principalOf(request: Request): ConsolePrincipal | null
```

契约四条：① P14 不自建用户表，「谁确认的」一律取 `subject`；② 求值顺序固定为 认证 → 租户作用域（本文）→ 授权（P14），租户拒绝先于任何授权判定；③ 吊销对下一个请求生效，P14 若签发时效凭据须记下 `subject`，主体被吊销时一并作废；④ 控制台动作账本是两份设计共用的记录面，P14 的授权事件写进去，不另开账本。`legacy:*` 能否充当「确认人」由 P14 决定。

### 3.6 智能体生命周期：注册 / 暂停 / 恢复 / 注销

**事实**：今天的四个写动作（注册、注销、心跳、唤醒）都要 admin（`console.md` §5）；注册只写进注册中心活表，90 s 无续租即消失（§0.4）；节点托管哪些 agent 由节点启动配置决定，控制台的「注册」只是**发布**，不在节点上创建 agent；装机面的动作集钉死五类（`node-provisioning.md:13`），其中没有 agent 粒度的动作；ESTOP 是节点级（`packages/resident/src/estop.ts`）。

**设计：中枢一本「登记簿」表达期望状态，注册中心只是它的投影。**

| 动作 | 登记簿 | 注册中心 | 控制台 | 节点 |
|---|---|---|---|---|
| 注册 | 追加 `active`（带租户与操作主体） | 立即 POST，此后续租者每 20 s 心跳（与 `p81-registry.ts` 同周期） | endpoint 由中枢配置派生、表单不再收（顺带消除 roadmap v2.46 ⑥ 那类占位符错误）；agent 名必须在该节点的托管清单里 | 不动 |
| 暂停 | 追加 `paused` | DELETE，停止续租 | 拒绝对它发起对话与唤醒 | **不动**（D8） |
| 恢复 | 追加 `active` | 同注册 | 同注册 | 不动 |
| 注销 | 追加 `retired`；地址**不再分配**给其他租户 | DELETE | 从名册移除 | 不动；节点侧会话与记忆保留到节点退役 |

续租者住在注册中心进程旁，替换 `--register` 的静态列表；`peers.conf` 的地址行作为登记簿的初始种子。**`@qianmo/registry` 的 HTTP API 不改。**

**暂停只做到注册层（D8）**：内测拓扑里所有投递都从中枢发起（§2「传输 / 路由」行），中枢拒发即有效；但已知端点的直连对端不经中枢，节点照收。节点侧单 agent 暂停需要装机面的第六类动作或一条新控制消息，前者违反五类定案，后者改协议，M1 都不做。

**接 `node-provisioning.md`**：`install` 的输入加一项 `tenant`，写进节点启动配置（`--tenant`）并同步中枢映射，装机账本记下租户；节点托管的 agent 清单在 `install` 时确定。节点退役 = `stop` + 登记簿里该节点全部 agent 置 `retired` + 归档配置根，M1 走运维单页，不新增动作。

### 3.7 不解禁时的最小替代（选项 B）

**一次性注册令牌**：admin 在页面上为一个**确切地址**签发令牌（≤24 h，单次），链接私信给用户；用户持共享 view 登录后打开链接，页面只允许对这一个地址完成注册（endpoint 由中枢派生，同上表），令牌随即作废。它在「按能力分」这条轴上：令牌绑定的是一个地址上的一次动作，控制台**不存令牌与人的对应**，账本只记令牌哈希前缀与地址，论证与 `node-provisioning.md` §10.1 同构，因此不触 N-2。**护栏**：一旦有人要在账本上记「发给了谁」，就是 `beta-env.md` §10 包④ 的那条边界，须回到决策点 0。

---

## §4 配额雏形（若解禁）

### 4.1 计量什么

| 计量 | 来源 | M1 强制 |
|---|---|---|
| 消息数（按主体、租户计 `task.request`） | 控制台发送路径 | 是 |
| turn 数 | 节点准入 | 是 |
| token | ACP `PromptResponse.usage`（`src/services/acp/agent/promptFlow.ts:137-160`，注释称其为**会话累计值**，需取差分）。常驻今天**不读**它，只读 `stopReason`（`packages/resident/src/acp-turn.ts:378`） | 是（事后计量，下一轮准入时判） |
| 存储（记忆根体积、对话落盘字节、会话数） | 定期测量；会话数已有上界 `maxSessionsPerAgent = 16`（`packages/resident/src/session-gc.ts:34`） | **只计量、告警。**审计链永不因配额拒写（`beta-env.md` §0 定案 #6：全程不清） |

**初值本文不预设**：P15.7 先以 shadow 跑满两周，按各租户用量的 P50 / P95 定初值，再切 enforce。

### 4.2 在哪强制

- **中枢（控制台）**：按主体与租户计消息数，在调 `ChatPort` 之前拒。内测拓扑里全部流量从这里出发，这是主闸。
- **节点准入**：按本节点所属租户计 turn 与 token，位置在租户闸之后、ESTOP 之前（`resident.ts:819-841` 之间），拒绝发生在写信箱之前（L-1）。节点只属于一个租户，所以节点的份额就是该租户在这台节点上的份额；**租户跨节点的总量不做分布式计数**（D9）。
- **窗口**：自然日（东八区零点重置），页面显示「今日已用 / 上限 / 重置时间」。给人看的额度要能一句话说清，滑动 24 h 做不到。

### 4.3 与 `LIMITS`、运行时限流、P13 的关系

- **租户配额不进 `LIMITS`。**`LIMITS` 是协议级上界的唯一出处（章程 C-4）；租户配额是部署策略，理由与 `RUNTIME_RATE` 不进 `LIMITS` 相同（`packages/router/src/rate.ts` 模块注释「Why the runtime ceiling is not in `LIMITS`」）。数值只住中枢配置一处，节点经启动参数取得，文档不抄数字。
- **配额管量，限流管速，两者不合并。**`LIMITS.ratePerMinute`（协议层，每发送节点）、`RUNTIME_RATE`（运行时层，每发送方 × 目标，`rate.ts:53-56`）、`NotifyBudget`（出站通知，`rate.ts:310`）防的是突发；配额防的是一天的总量。实现不复用 `KeyedBuckets`（同一模块注释「Do not fold it into `KeyedBuckets`」）；控制台上限视图分三组列显示（`console.md` §7.1「两列不是一个数」的延伸）。
- **P13 已认领的机制不动**：`notifyRatePerMinute`、`maxQueuedTurns`（`roadmap.md:870`、`resident-botization.md` §2.5）数值与语义一字不改；租户配额不能调高任何协议上界。
- **N-1**：只计量不计价，`costLimit` 仍恒为 0，非零仍出站即拒（`protocol.md:565`）。

### 4.4 超额错误码（D5）

| 面 | 取舍 | 理由 |
|---|---|---|
| 线上（节点拒绝） | **扩义复用 `E_BUDGET_EXHAUSTED`**（`errors.ts:44`，基线码） | 旧节点能解析，不触规则 N-1（`protocol.md:786`）；发送方的正确处置「重置前不要重试」与字面一致。代价：`errors.ts:43` 的注释与 `protocol.md:780` 的码表说明要从「`costLimit` ≠ 0」改为「发送方预算或接收方配额已耗尽」 |
| 放弃 | `E_RATE_LIMITED` / `E_BUSY` | 两者都是「等一会儿再来」，对零点才重置的额度是错误指引 |
| 放弃 | 新码 `E_QUOTA_EXCEEDED` | 每个新码都是一份兼容负担加一条降级映射（`protocol.md:796`「不要因为多一种情形就多加一个码」） |
| 控制台 HTTP | 429，`code` 同为 `E_BUDGET_EXHAUSTED`，附 `resetAt` | 页面与线上用同一个词 |

---

## §5 测试计划：「跨租户数据访问用例全部被拒」

### 5.1 「被拒」的操作定义

- **列表**：结果里外租户条目为零（过滤，不报错）；
- **按 id 读**：404，响应体与「不存在」逐字节相同；
- **写 / 动作**：403，文案与「节点不存在」相同；
- **一律**：被拒路径上端口调用次数为零（手写假端口计数，沿用控制台包零 `mock.module` 的做法）；注册中心、登记簿、落盘物无变化；节点侧信箱未写、未开 ACP turn。

### 5.2 用例矩阵

主体：租户 A、B 各 `viewer` / `member` / `tenant-admin`，另加 `legacy:view`，共 7 个；对象：另一租户的节点、agent、会话、traceId。`ops` 不进矩阵（按定义跨租户），另设正向用例：每次 `ops` 跨租户读都在动作账本留一条。

| # | 面 | 操作 | 期望 |
|---|---|---|---|
| C1 | 名册（`/v0/agents`、`/fragments/roster`） | 列表 | 外租户零条 |
| C2 | 注册 / 注销 / 心跳 | 写外租户地址 | 403，注册中心与登记簿不变 |
| C3 | 暂停 / 恢复 | 写外租户地址 | 403 |
| C4 | 审计（`/v0/audit`，按 `agent` / `source` / `traceId` 过滤） | 列表 | 外租户零条 |
| C5 | 消息链（`/v0/audit/chain/<traceId>` 与片段） | 按 id 读 | 404 |
| C6 | 唤醒（`/v0/wake`） | 外租户节点 | 403，`WakePort` 零调用 |
| C7 | 对话目标、会话列表 | 列表 | 外租户零条；同租户他人会话零条 |
| C8 | 会话转录（`/v0/chat/sessions/<id>` 与片段） | 读外租户与同租户他人 | 404 |
| C9 | 发消息 | 外租户会话 / 以外租户目标开会话 | 404 / 403，`ChatPort` 零调用 |
| C10 | SSE（`/v0/chat/stream`） | 订阅 | 外租户会话零事件 |
| C11 | 服务器与备注 | 读 / 写 | 非 ops 一律 403 |
| C12 | 账号管理 | 邀请进外租户、吊销外租户用户 | 403 |
| C13 | 一次性令牌 | 持 A 的令牌注册 B 的地址 | 403，令牌不被消耗 |
| N1 | 节点准入 | 外租户节点发 `task.request` | `E_UNKNOWN_AGENT`；信箱未写、无 ACP turn、无新会话、无记忆读 |
| N2 | 节点准入 | 外租户节点发 `wake` | 同 N1 |
| N3 | 中枢收 `notify` | 外租户节点带 A 会话的 `contextId` | 丢弃并记账，A 的转录无变化 |
| H1 | 调度器 | 作业目标属于外租户 | 加载即拒 |
| H2 | 部署检查 | 两个租户的节点同 `server=`；两个租户的记忆根重叠 | `beta-up.sh` 拒起 |

C1–C13 对 7 个主体全展开，N、H 各一组；总数 N 由用例表生成，不手写。

### 5.3 放在哪、如何机判 100%

| 层 | 位置 | 证明什么 |
|---|---|---|
| 包内 | `packages/console/src/__tests__/tenancy.test.ts`；`packages/resident` 与 `src/services/qianmo` 的租户闸单测 | 零件对 |
| 组合 | 新目录 `tests/tenancy/cross-tenant.test.ts`，**必须写进 `scripts/test-shards.sh:84` 的目录列表**，否则 CI 不跑（`tests/boundary/README.md`「规矩」第 3 条）。不放 `tests/boundary/`：那里每条用例须对应 `protocol.md` §8.3 的五类之一，跨租户不在其中 | 真注册中心 + 真控制台 handler + 真路由闸装在一起表现对 |
| 真进程 | `demo/lib/acceptance/scenarios/tenancy.ts`，经 `bun run qianmo:acceptance` | 本地腿与舰队腿 |

机判三条：① **完备性元测试**：从控制台路由表枚举全部路由，每条必须有租户类别，每条 `tenant` 类路由在矩阵里至少有一条用例，新增路由不补用例即红（与 `check:identity-paths` 同类的棘轮）；② **不许 skip**：矩阵用例 skip 计为失败，汇总行输出 `cross-tenant refused N/N`，N 与表生成的期望数不等即非零退出；③ 真机腿沿用 `scripts/qianmo-acceptance.ts` 的退出码语义（头注：驱动零调用不得报绿），**同一份部署连续两轮零红**才算判据达成。

---

## §6 任务包

估算口径同 `node-provisioning.md` §11（主开发 + AI 协作），单位人时。

| 包 | 目标 | 依赖 | DoD（可机检） | 估算 |
|---|---|---|---|---|
| **P15.1** ⚖️ 设计定稿与范围回写 | 裁定决策点 0 与 §7 各项，回写范围 | 无 | 本文过评审升 v0.2；A：章程 N-2 行加补注并升版本号，`beta-env.md` §0 #4 与 `console.md` §8.1 加指向本文的改写注；B：roadmap `:852` / `:856` 注明挪 M2；roadmap 收入本表；`git grep "P15\.[0-9]"` 只命中本文与回写处 | 4–8 |
| **P15.2** 注册持久化与生命周期 | 注册活过 90 s；暂停、恢复、注销 | P15.1（**不依赖 D0**） | `ManualClock` 推进超过 90 s 后控制台注册的条目仍在 `list()`；注册中心重启后登记簿里 `active` 的条目回来、`paused` / `retired` 不回来；暂停后对该地址的对话与唤醒被拒且端口零调用；`retired` 地址再注册被拒；`@qianmo/registry` 的 HTTP 路由表零改动（快照断言） | 12–24 |
| **P15.3** 一次性令牌 | B 的注册通道；A 的邀请底座 | P15.2 | 令牌绑定单一地址（或租户 + 角色）；过期与二次使用均 403 且不消耗；存储只有哈希；扫描断言控制台代码与落盘物没有「令牌→人」字段；`resolveTokens` 零改动（对照单测） | 8–16 |
| **P15.4** 租户映射与控制台过滤 | §2 注册中心、控制台视图、审计链、中枢侧落盘物四行 | P15.2 | 缺省 `--node-tenant` 时全部既有控制台测试逐字不改全绿；路由租户类别元测试；C1–C11 全绿；外租户按 id 读的响应与不存在逐字节相同 | 20–36 |
| **P15.5** 账号最小形态 | §3.1–§3.5 | P15.3、P15.4 | 邀请开户端到端，驱动只用 HTTP、不起任何 CLI 子进程；吊销后下一个请求即 401；重启后会话全失效、账号仍在；`legacy:view` 只见 `default`；`ConsolePrincipal` 从包入口导出并有契约单测；C12、C13 全绿 | 24–40 |
| **P15.6** 节点侧租户闸与迁移 | §2 记忆、会话、传输、沙箱、备份五行；§1.5 | P15.4 | 闸位于 `router.inbound` 之后、ESTOP 之前（结构断言）；shadow 只记不拒，enforce 拒且无副作用（N1–N3）；`FRAME_VERSION` 与 `CapabilityClaims` 键集零改动（grep 断言）；`beta-up.sh` 两条部署检查（H2）各有负向用例 | 16–28 |
| **P15.7** 配额雏形 | §4 | P15.5、P15.6（同改 `#receive`，**串行**） | 四类计量落盘；token 取差分，有覆盖 `--resume` 前后累计值的用例；超额在写信箱之前拒、码为 `E_BUDGET_EXHAUSTED`、旧版本对端能解析；`LIMITS` 键集与数值零改动；shadow 两周数据入档后才切 enforce | 20–36 |
| **P15.8** 跨租户矩阵与验收 | §5 | P15.4–P15.7 | `tests/tenancy` 进分片列表；汇总 `N/N` 且 N 由表生成；完备性元测试；真机同一部署连续两轮零红并留档 | 16–28 |

**合计**：A = **120–216**；B = P15.1 + P15.2 + P15.3 + P15.7 的节点级子集（只按节点计 turn 与 token，无主体维度，12–20）= **36–68**。

**排期约束**：P15.4 / P15.5 与 P14 都改控制台鉴权（`auth.ts`、`http.ts`），**P15.5 先落**，P14 在 `principalOf` 之上接；P15.6 与 P15.7 都改 `resident.ts` 的 `#receive`，串行。P15 不碰 `packages/transport/src/frames.ts`，与 P12.x / P13.x 在该文件上的约束无交集。

### 6.1 明确不做

- 计费、定价、账单（N-1）；`costLimit` 仍恒为 0。
- 公开自助注册、对校外开放（章程 §8 放在 M2）。
- 口令账户、外部身份源（校园统一认证、第三方 OAuth）、passkey。
- 节点内按 agent 分租户；一人多租户；子租户。
- 跨租户互通或共享的放行通道（M1 只有默认拒）。
- 协议层的租户字段（信封、帧、capability claims）；证书 SAN 里的租户。
- 注册中心自身的鉴权（仍归「权限模型上线」，`console.md` §8.2）。
- 装机面第六类动作；节点侧的单 agent 暂停。
- 租户跨节点的分布式配额计数；存储配额的强制。
- 能抵御中枢失陷的租户隔离（§1.4）。

---

## §7 需要负责人拍板的决策点

| # | 事项 | 本文建议 | 不拍板的后果 |
|---|---|---|---|
| **D0** | N-2 解禁与否（§0） | A，限定形态 | P15.4–P15.8 不能开工；P14 没有主体 |
| D1 | 判据里「完成注册」指什么 | A：开户 + 本租户 agent 的页面内注册；B：凭一次性令牌注册 agent | 验收时各说各话 |
| D2 | 租户粒度 = 节点，不支持节点内分租户（§1.2） | 接受 | 若要 agent 粒度，§2 的审计、记忆、会话三行都要在节点内再切，另行估算 |
| D3 | 控制台发起流量的跨租户防线 | M1 由控制台单点强制。每租户一把签发身份（节点只 `--trust` 本租户那把）推迟到 `SIGNED_TASK_POLICY` 切默认之后：`OPEN_POLICY` 下节点不校验 capability（`src/cli/handlers/resident.ts:1072`），且它会改写「控制台只有一个 `iss`」这条既有规则（`src/cli/handlers/consoleWakeIdentity.ts:9-13`） | 若要求节点侧也能挡控制台，§0.3 里 A 的前提不成立 |
| D4 | 跨租户拒绝码（§2 末） | `E_UNKNOWN_AGENT` | — |
| D5 | 超额码（§4.4） | 扩义 `E_BUDGET_EXHAUSTED`，同步改 `errors.ts` 注释与 `protocol.md:780` | 另立新码就要走规则 N-1 |
| D6 | `ops` 能否读外租户的对话转录 | 能，每次进动作账本并在页面上标注 | 若不能，运维排障要另开通道 |
| D7 | 旧 admin token 是否保留为 break-glass | 保留，动作照记账本 | — |
| D8 | 暂停只做到注册层（§3.6） | 接受 | 节点侧暂停需第六类装机动作或改协议 |
| D9 | 配额窗口取自然日；租户跨节点不算总量 | 接受 | — |

---

## §8 未核实与遗留风险

**未核实**（本文依赖、但没有实测）：

1. ACP `usage` 是会话累计值，出处只是 `promptFlow.ts:137-141` 的注释；`--resume` 后是否归零、跨 compact 是否连续，未测。
2. 现场节点是否开了 `--require-signed-tasks`、是否设置 `CLAUDE_CODE_REMOTE_MEMORY_DIR`，未核实（启动参数在运维单页，不入库）。
3. `beta-env.md` 描述的中枢形态是否仍是现场形态，未核实；本文只依赖「所有租户共享一个中枢」这一形状。
4. 校园统一认证能否接入、需要什么审批，未调研。
5. 内测是否真的触发过 `beta-env.md` §10 包④ 的条件（被迫全员换 token），仓库内没有记录。
6. `node-provisioning.md` 仍是 v0.1-draft 且没有实现（基点上 `ProvisionPort` / `resolveProvisionToken` 全仓零命中）；§3.6 对 `install` 增加 `tenant` 输入的要求，要等它定稿时并入。

**遗留风险**：

- 中枢是全体租户共同的失陷域（§1.4），本文不改变这一点；缓解在 `key-distribution.md` 与 `node-provisioning.md` §4.3。
- 同租户多用户共用 agent 的工作区（`beta-env.md` §4.1 的 `workspaces/<node>/<agent>/`）与 project 层记忆：一个人的会话能读到另一个人让 agent 写下的东西。M1 视为租户内共享，须写进内测公告。
- `DEFAULT_CONTEXT` 是同一 agent 所有无 `contextId` 请求的共享桶（`session-key.ts:41`）。控制台总是带 UUID，但运维脚本等其他发起方不带时会合流。
- 迁移期两套凭据并存。`legacy:view` 钉在 `default` 租户这一条若实现漏掉，就是整张矩阵的旁路，所以矩阵主体里包含它。
