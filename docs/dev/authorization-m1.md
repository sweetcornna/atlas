<!-- Copyright 2026 Qianmo AgentNest Team -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# 阡陌 AgentNest — 用户授权流与权限审计（M1 · 权限模型上线 · P14）

| 项 | 内容 |
|---|---|
| 文档版本 | **v0.1-draft**（评审通过前不生效） |
| 日期 | 2026-09-26 |
| 范围依据 | roadmap M1 方向表「权限模型上线」行（`roadmap.md:853`）：内容「用户授权流（授权申请 → 用户确认 → 时效凭据 → 主动撤销）；权限审计报表」，出口判据「所有需确认动作 100% 经过用户授权链路，抽查无绕过」 |
| 任务包 | P14.1 ~ P14.8（§6）；P14.1 是本文的定稿与范围回写 |
| 不改动 | 本文不改 `roadmap.md` / `charter.md`；回写内容在 P14.1 统一做 |
| 相邻文档 | `tenancy-m1.md`（P15，并行起草；本文只写对它的依赖，见 §3.3）、`key-distribution.md`（P11.2/P12）、`console.md`、`resident-botization.md`（P13）、`protocol.md` §10 |

## 0. 现状：测量结果

M1 这一行**尚未开工**。仓库里与授权相关的东西都是 M0 与 P12/P13 的产物，逐项列出，均为本次读代码所得：

| # | 事实 | 出处 |
|---|---|---|
| F-1 | capability 令牌 `<claims>.<sig>`，claims 八个字段**字段封闭**（多一个键即拒） | `packages/protocol/src/capability.ts:142-152` |
| F-2 | 规则 S-1：`act = user-confirmed` 且 `iss ≠ 本节点` 一律拒，判在验签之前 | `packages/capability/src/token.ts:213-221` |
| F-3 | 默认策略 `SIGNED_TASK_POLICY` 只要求 `task.request` / `wake` 到 `write-limited`；**没有任何消息类型要求 `user-confirmed`** | `packages/capability/src/policy.ts:90-93` |
| F-4 | 生产代码里签发 `user-confirmed` 的地方为零；唯一签发点在演示脚本，且那次「用户授权」是脚本化钩子（`mode: 'scripted-hook'`） | `demo/lib/p61-scenario.ts:417-439`；控制台签发器钉死 `write-limited`：`src/cli/handlers/consoleWakeIdentity.ts:113-135` |
| F-5 | 协商出借方的 `authorize` 钩子是**同步布尔**，缺省时 `?? true`（未接即放行）；`LenderNegotiator` 在 `src/` 与 `packages/` 生产代码里没有构造点，只在测试与 `p61-scenario.ts` | `packages/negotiation/src/lender.ts:75-79`、`:173-183` |
| F-6 | 常驻 ACP 会话的权限上下文由 `getEmptyToolPermissionContext()` 建，`alwaysAllowRules` 为空，只有 `mode` 被覆盖；`src/services/acp/` 下无任何 `alwaysAllowRules` 引用。**settings.json 的 allow 规则不进这条路**（记忆记录与 roadmap v2.61 所述，代码核实成立） | `src/services/acp/agent/createSessionMethod.ts:119`、`:200-206`；`packages/tool-runtime/src/Tool.ts:221-229` |
| F-7 | 常驻缺省模式 `dontAsk`；`dontAsk` 把 `ask` 在管线末端翻成 `deny`，因此**在 `dontAsk` 下宿主一次授权请求都收不到**；`--allow-workspace-edits` 下是 `acceptEdits`，工作目录外的 `ask` 才到达宿主 | `packages/resident/src/acp-client.ts:158`；`src/utils/permissions/permissions.ts:540-553`；`src/services/qianmo/resident.ts:1815` |
| F-8 | 宿主 `requestPermission` 恒答 `cancelled`；ACP 桥把它当拒绝（`onPermissionCancelled` 未接，不中断本轮） | `packages/resident/src/acp-client.ts:120-124`；`src/services/acp/permissions.ts:145-160`；`createSessionMethod.ts:147` |
| F-9 | ACP 桥的 `ExitPlanMode` 分支向客户端提供 `auto` / `acceptEdits` / `default` / `bypassPermissions` 四个选项，选中即 `onModeChange` 改会话模式 | `src/services/acp/permissions.ts:195-279` |
| F-10 | 常驻 hardline 拒绝表在 `checkPermissions` 内求值，先于任何 allow；不从会话配置读取 | `packages/resident/src/guard.ts`；`src/services/qianmo/residentGuard.ts:92` |
| F-11 | 信任档（`untrusted` / `verified-capability`）只改给模型的措辞，**没有任何代码按档位门控执行** | `console.md` §4.7；验收用例 `demo/lib/acceptance/scenarios/trust.ts:158` |
| F-12 | 控制台鉴权是 view / admin 两枚 bearer token；cookie 12 h，**无服务端吊销**，换 token 即重启 | `console.md` §4.1、§8.1；`packages/console/src/auth.ts:135` |
| F-13 | 审计链记录里与授权相关的只有：router 的 `capability_denied`（落为 `capability` 源）、证书目录事件、影子审计、`negotiation.*`、activator 的 `capability.denied`；**工具级权限判决（dontAsk 拒、hardline 拒、宿主应答）不进审计链** | `src/services/qianmo/auditTrail.ts:169-177`、`:563`、`:601-661`；`packages/negotiation/src/audit.ts:17-25` |
| F-14 | `qm audit` 支持 `--trace/--agent/--task/--from/--to/--limit/--json/--verify/--witness/--path`；`TrailQuery` 有 `source` / `outcome` 两个条件但 CLI 未暴露 | `src/cli/handlers/qianmoAudit.ts:111-135`；`packages/audit/src/query.ts:24-37` |
| F-15 | S-3 扫描：列目录、禁变更权限的基座 API、fixture 钉住红方向 | `packages/capability/test/authorization-invariants.test.ts:41-68` |

**一句话诊断**：三级权限的第三级今天在生产路径上没有消费者（F-3、F-4），「用户授权链路」不存在；现有的只是两个接口位——ACP 的 `requestPermission`（F-8）与出借方的 `authorize`（F-5），前者被 `dontAsk` 挡在门外，后者缺省放行。

## 1. 问题与范围

### 1.1 「需确认动作」的判定规则

不写形容词，给判定函数。需确认动作集合 **C = C_tool ∪ C_net**：

| 子集 | 判定规则 | 判定点 |
|---|---|---|
| **C_tool**（节点内工具面） | 常驻 ACP 会话中，基座权限管线对一次工具调用给出 **`ask`** 的全部调用。判定函数就是 `hasPermissionsToUseTool` 在该会话模式、空规则集下的返回（`src/services/acp/permissions.ts:89-104` 的 `ask` 分支） | 宿主 `requestPermission`（`acp-client.ts:120`） |
| **C_net**（跨节点资源） | 出借方在发出 `resource.offer` 之前的放行判断（`lender.ts:173`）。隧道建立是 lease 的后果，不单独确认 | 出借方 `authorize` |

**不属于 C 的三类**，各有归宿：

- **hardline 命中**：恒拒，**不可确认**。grant 不能打开 hardline 目标（hardline 在 `checkPermissions` 内先判，F-10，授权流在其后）。
- **管线直接 `allow` 的调用**（读操作、`acceptEdits` 下工作目录内的编辑）：不 ask，不进授权流。它们的边界由模式决定，模式本身是 §4 的扫描对象。
- **运维启动姿态**（`--allow-workspace-edits`、`--open-policy`、`--trust`、`--approver`）：运维在启动时决定，不是运行时授权；进审计报表的「姿态」栏（§5）。

C_tool 可枚举的方式：P14.2 用固定语料（每类工具的典型输入 × 两种模式）跑一遍真实管线，把「哪些返回 ask」产出成快照并作为测试夹具入库。**快照变化即红**，由评审决定接受还是修正——这也是上游同步改变基座权限语义时唯一能及时发现的地方。

### 1.2 与三级权限的关系

| 等级 | 含义（本文之后） | 能触发什么 | 谁能签 |
|---|---|---|---|
| `read` | 看 | 不开 turn，只有回复类 | 任何消息（未签名即此档） |
| `write-limited` | 有界本地工作 | 开 turn；turn 内**只能做不 ask 的动作**，C 中动作一律转入授权流 | `--trust` 中的签发者（含控制台） |
| `user-confirmed` | 本节点的用户对**某一个具体动作**说了「是」 | C 中与某条 grant 绑定的那一个动作 | **只由本节点自签**（S-1 不动），前提是本节点验过审批者的决定 |

两条不变：**消息的等级是上限，不是加法**（S-3）——一条 `write-limited` 消息不能让它开出的 turn 免于 ask；**跨节点消息永远不携带 in-node 动作的 `user-confirmed`**——对端节点的用户不是本节点的用户。

## 2. 威胁模型

| # | 威胁 | 现状 | 本设计的控制 | 残余 |
|---|---|---|---|---|
| TH-1 | **confused deputy**（charter C-5 / T-7）：A 的消息诱导 B 的 agent 执行 C 中动作，并声称「用户已同意」 | S-1 挡住远端 `user-confirmed`（F-2）；但 C 中动作在 `dontAsk` 下是直接拒，没有正路 | 审批只认 B 自己的审批者集（`--approver`，与 `--trust` **不相交**，§4 I-6）；审批绑定 B 自己生成的 `requestId` 与动作摘要；控制台展示「由谁的哪条消息引发」及其信任档 | 用户被 agent 写的理由说服——对策是展示宿主渲染的原始输入并把 agent 文字标为不可信，不以「用户没被骗」验收（charter T-7 对策①） |
| TH-2 | **重放**：审批 / grant 被重放到同节点、他节点或重启之后 | `NonceStore` 在内存（`nonce.ts:34`），重启即清空 | 审批带 `aud`（他节点必拒）、`nonce`、`exp`；**一次性由持久化的请求状态机保证**（`pending → approved/denied/expired` 单向迁移），不靠 nonce 表；allow-once grant 用后即消耗 | 时间窗 grant 在窗内可重复使用同一摘要的动作——这是它的定义，上限见 D-5 |
| TH-3 | **令牌外泄** | admin token / cookie 外泄即完全控制台权限，直到重启换 token（F-12） | 审批凭据与 admin 分开（D-2）；审批 POST 不接受 cookie；审批私钥与控制台对话私钥分开（D-3）；grant 只在签发节点、只对一个摘要有效 | 审批私钥外泄：可伪造审批直到每个节点移除 `--approver` 条目并重启（O(N)，与 `--trust` 同一局限，`key-distribution.md` §6.4 末段） |
| TH-4 | **撤销传播延迟** | 无撤销对象 | §3.5：本地 ESTOP 即时、撤销消息一跳、grant 短寿命封顶 | 节点不可达时，最坏 = grant 剩余寿命（≤ D-5 上限） |
| TH-5 | **控制台会话劫持**（CSRF、XSS、点击劫持、陈旧页面） | CSRF 有 `X-Qianmo-Console` + 无 CORS（`console.md` §4.1）；CSP 为 `<meta>` 形式（`packages/console/src/view/page.ts:740`），`script-src 'unsafe-inline'`；`packages/console` 与 `src/cli/handlers` 中未见 `frame-ancestors` / `X-Frame-Options` | 审批 POST 必须回传页面展示的摘要，服务端复核与挂起行一致；审批页加 `X-Frame-Options: DENY` 响应头（`<meta>` CSP 不承载 `frame-ancestors`）；agent 文本只走既有出口转义 | 持有有效审批凭据的人就是「用户」——N-2 下无法再细分 |
| TH-6 | **agent 自我授权** | `dontAsk` 下无路可走；但 F-9 的模式切换选项、F-6 若被上游同步改变、hook 放行三条是潜在旁路 | ① 挂起行只由宿主从 `requestPermission` 创建，`qianmo_notify` 造不出挂起行；② 审批私钥不在节点上（同机部署时落在 `<config>/qianmo/identity/`，`consoleWakeIdentity.ts:52`，被 hardline 的配置根条目覆盖）；③ 宿主对 F-9 的模式选项恒拒；④ `authz.*` 消息由宿主消费，永不进信箱与 agent 上下文；⑤ 空规则集由测试钉住（I-2） | hardline 是词法匹配，承认可被混淆（`guard.ts` 头注释）；真正的容器仍是沙箱。控制台与节点同机且无沙箱的部署不在本设计的保证范围内 |
| TH-7 | **审批疲劳**：agent 反复触发同一类请求，让用户习惯性点「同意」 | 无 | 同一 `(agent, contextId, digest)` 的挂起请求去重；每会话挂起上限与每节点每小时请求上限是节点本地策略，**不进 `LIMITS`**（与出借上限不进 `LIMITS` 同理，`packages/protocol/src/negotiation.ts` 模块注释）；超限直接拒并记 `authz.refused(reason=budget)` | 上限数值待 P14.4 以语料定 |

**不在本模型内**：沙箱逃逸与节点宿主 root 失陷（由沙箱与 charter A-1 承担）；「模型没被说服」不作为任何一条控制的依据（charter T-7 对策①）；注册中心零鉴权（§6.2）。

## 3. 流程

### 3.1 总图

```
 发起方                        目标节点 B（宿主进程）                                     审批面（控制台）
 ① 本节点 turn 内工具调用 ─┐
 ② 对端 task.request 引发 ─┴─> ACP ask ─> requestPermission ─┐
 ③ resource.request ─────────> 出借方 authorize ──────────────┴─> GrantStore 命中？
                                  是 ─> 放行（allow-once 即消耗），记 authz.grant_used
                                  否 ─> 挂起行 + authz.requested ─── authz.request ───> 待批列表（宿主渲染的原始输入）
                                        本次调用：有界等待或拒绝（D-4）                    │ 确认 / 拒绝（审批私钥签名）
                                  校验 AuthzDecision ─> 自签 user-confirmed grant <── authz.decision
                                        记 authz.approved / authz.denied                   │ 撤销
                                  删 grant，记 authz.revoked <────────────────────── authz.revoke
```

### 3.2 发起点

- **①② 节点内工具调用**（含对端消息引发的 turn）：唯一入口是宿主 `requestPermission`。前提是会话模式不是 `dontAsk`（F-7）——**这是本设计对基座行为最大的一处依赖**：改为 `default`（或 `acceptEdits`）后，`ask` 才会到达宿主。宿主缺省全拒时，允许集应与 `dontAsk` 相同；这条由 P14.2 用语料实测证明，不靠推理（D-1）。挂起行记录来源：`from`、`taskId`、`traceId`、该消息的信任档。审批永远发给**B 的**审批者，不发给发起方。
- **③ 资源协商**：`authorize` 保持同步接口，改为查同一张 GrantStore（grant 的作用域是 `(borrower, ceiling)`）；无 grant 时拒绝本次 offer 并创建挂起行，借用方在审批后重发。`authorize` 在类型上改为必填，`?? true` 删除（I-7）。
- **投递路径**：`authz.request` 走控制台已建立连接的反方向，与 notify 同路（`resident-botization.md:109`）；控制台缺席时落节点台账、回来后排空。**节点不拨号**，H-2 不变式不动。新消息类型经 P13.2 的 `supportedTypes` 能力发现声明，不升 `FRAME_VERSION`。

### 3.3 「用户」是谁

**N-2 下的最小方案（不依赖账号体系）**：用户 = **持有某台控制台审批凭据的人**，由两样东西定义：

1. 控制台侧：第三枚 bearer token（`--approver-token`，与 view/admin 同样「不同字符串、分别比对」，`console.md` §4.1 的理由原样适用）；审批动作只接受 `Authorization: Bearer`，不接受 cookie。
2. 节点侧：`--approver <name>=<publicKey>`，列出**哪台控制台的审批私钥**能替本节点的用户说「是」。与 `--trust` 是两条轴：`--trust` 答「谁能指挥本节点」，`--approver` 答「谁能代表本节点的用户同意」（沿用 `key-distribution.md` §10.5 的分轴论证）。

审计链上的审批者字段在此阶段是 `<console 名>/approver`——**谁拿到那枚 token，谁就是同一个人**，这是 N-2 的直接后果，如实写进报表表头。

**启用顺序只有一个方向**，与 `--wake-sign` 同理（`console.md` §4.6）：

```
1. qm console --print-approver-identity     # → console=<approverPublicKey>
2. 每个节点加 --approver console=<approverPublicKey>，切到非 dontAsk 模式（D-1），重启节点
3. 控制台加 --approver-token-file <path>，重启控制台
```

反过来做的后果是可诊断的而不是静默的：第 2 步之前，节点的 ask 仍按缺省全拒，控制台的审批会被节点以 `authz.refused(reason=approver)` 拒掉并落链。

**账号体系到位后的收敛**（只写依赖，不替 P15 设计）：

| 接口点 | P14 提供 | 依赖 P15 提供 |
|---|---|---|
| 审批者标识 | `AuthzDecision.approver` 字段从 v1 起存在，值为不透明字符串 | principal 标识的值空间与格式 |
| 谁能替哪个节点审批 | 节点本地 `--approver` 集 | 一个节点可离线校验的「本租户审批者」来源（签名材料），届时替换 `--approver` 的来源、不改校验顺序 |
| 控制台登录 | 第三枚 token | 登录会话；到位后 `--approver-token` 退役 |
| 报表分区 | 按节点集合过滤 | 节点 → 租户映射 |
| 注册中心鉴权 | 不做（§6.2） | 名字归属与准入 |

### 3.4 时效凭据的形状：capability 令牌够在哪、不够在哪

**够：grant 本体。**grant = 一枚本节点自签的 capability：`iss = aud = 本节点`、`act = user-confirmed`、`sub = qianmo://<node>/<agent>`、`taskId = grantId`、`nbf/exp/nonce`。S-1 天然放行（本节点签）；「过期不过 T-2 闸门」（`packages/capability/README.md` 不变式 3）正是 grant 需要的语义；出借方「本节点签、对端带回」的既有模式（`lender.ts` 的 `mintCapability`）无需改动。grant 绑定的动作摘要放在节点本地的绑定行里：`{grantId, requestId, digest, scope, decisionRef, consumedAt?, revokedAt?}`。挂起行与绑定行的文件名要加进 hardline 的 `NODE_STATE_FILES`（`packages/resident/src/guard.ts`），否则 agent 可以改自己的授权状态——这是 P14.3 的 DoD，不是现状。

**不够：审批者的「是」。**三个原因，任一单独成立：

1. 审批来自控制台 = 远端签发者，`act = user-confirmed` 按 S-1 必拒（F-2）；降为 `write-limited` 则与对话令牌同形，缺签名域分隔，可被跨用途解读。
2. claims 字段封闭（F-1），装不下 `decision`、`digest`、`approver`；加字段是对所有校验方的线格式破坏。
3. 审批的一次性不能靠内存 nonce 表（TH-2），要靠持久化的挂起行。

因此新增 **`AuthzDecision`**，接口约定如下（P14.3 实现，`protocol.md` 增一节承载，本表是草案）：

| 字段 | 取值 | 约束 |
|---|---|---|
| `v` | `1` | 其他值即拒 |
| `requestId` | 节点生成的 128 bit 随机 id | 必须命中本节点一条 `pending` 挂起行 |
| `aud` | 目标节点名 | ≠ 本节点即拒 |
| `sub` | `qianmo://<node>/<agent>` | 与挂起行一致 |
| `digest` | 64 位 hex | 与挂起行一致；控制台从页面回传，服务端先复核 |
| `decision` | `allow-once` / `allow-window` / `deny` | — |
| `windowMs` | 整数 | `allow-window` 时 `0 < windowMs ≤` D-5 上限，其余为 `0` |
| `approver` | 不透明字符串 | 阶段一为 `<console 名>/approver`；值空间归 P15 |
| `nbf` / `exp` | epoch ms | `exp − nbf ≤` 请求 TTL；过期不过 T-2 闸门 |
| `nonce` | 随机串 | 只作第二道；一次性以挂起行迁移为准 |

`AuthzDecision` 字段封闭，`decision ∈ {allow-once, allow-window, deny}`；签名覆盖原样送达的字节，独立签名域 `qianmo-authz-decision-v1`（同 `key-distribution.md` 握手凭据证明的做法）。校验顺序照搬 `verifyCapability` 的纪律：结构 → 绑定（`aud`、`requestId` 命中本节点挂起行、`digest` 相等）→ 时钟 → 审批者集 → 验签 → 状态机迁移（最后一步才有副作用）。`authz.request` 同样由节点私钥在 `qianmo-authz-request-v1` 域下签名，控制台据此拒绝伪造的待批项。密钥、编码、签名原语全部复用 `packages/capability/src/keys.ts`，不引入依赖。

**摘要**：`digest = sha256([node, agent, contextId, toolName, rawInput])`，由宿主在同一进程内用同一序列化计算，请求时与使用时两次计算必须一致；不跨进程比较，因此不需要规范化 JSON。

### 3.5 主动撤销：不做吊销清单，做「短寿命 + 本地撤销 + 急停」

吊销清单（RL）适合「签发方离线、校验方众多」的证书（`key-distribution.md` §6.4）。grant 恰好相反：**签发方与唯一校验方是同一个节点**，撤销只需通知这一个节点。

| 撤销对象 | 路径 | 最坏延迟 |
|---|---|---|
| 单条 grant | 控制台 `authz.revoke`（审批私钥签名）→ 一跳 → 节点删 grant、记 `authz.revoked` | 节点在线：一次投递（受 `LIMITS.defaultTtlMs` 约束）；节点不可达：grant 剩余寿命，封顶为 D-5 上限。控制台对未送达的撤销显示「未送达」，不显示「已撤销」 |
| 节点全部 grant | 节点本地 ESTOP（P13.5）：engaged 时 GrantStore 一律不命中 | 即时（下一次查询） |
| 挂起请求 | 自然过期（请求 TTL），记 `authz.expired` | 请求 TTL |
| 审批者 | 从各节点 `--approver` 移除并重启 | 取决于运维，无上界；CA 的 RL 不覆盖显式集合（`key-distribution.md` §6.4 末段同理） |

**不做续签**：时间窗到期即失效，续用需要新的审批。自动续签等于把一次同意变成无限期同意。

### 3.6 调用方在审批期间看到什么

两种形态（D-4）：**有界同步等待**——宿主持有这次 `requestPermission` 最多 N 秒，期间审批到达即放行；**拒绝即返回**——宿主立刻拒绝，给模型的拒绝文本由宿主生成（含 `requestId`，不含任何远端文字），批准后由用户重发。约束来自既有机制：turn 门是节点级串行（`charter.md:181` 的 `maxQueuedTurns` 说明），等待会阻塞整个节点的队列；`defaultTaskTtlMs = 5 min` 封顶整条任务；不活动看门狗（P13.5）必须知道「在等审批」不是卡死。

## 4. 「100% 经过、无绕过」的机器判据

**被判定的性质**：凡**被执行**的 C 中动作，都有一条对应的 `authz.grant_used`，且它能沿 `grantId → requestId` 追到一条 `authz.approved`。被拒的动作不算绕过；`dontAsk` 下 C 中动作一律被拒，因此是 fail-closed 的回滚档而不是旁路。注意 C 随姿态变化：`--allow-workspace-edits` 让工作目录内的编辑不再 ask，于是不在 C 里——这是运维声明的姿态，由报表的姿态栏如实呈现，不在「绕过」之列。

思路与 S-3 相同：**把旁路逐条列出，每条变成一个会变红的断言，并用 fixture 钉住红方向**（只会绿的扫描等于没有扫描，F-15 头注释）。

| # | 旁路 | 断言 | 形态 |
|---|---|---|---|
| I-1 | 会话被放到不 ask 的宽松模式 | `ResidentPermissionMode` 联合类型 ⊆ {`dontAsk`, `default`, `acceptEdits`}；`newSession`/`loadSession` 的 `_meta.permissionMode` 取值在集合内；常驻代码注释剥离后不出现 `'bypassPermissions'`/`'auto'` 字面量 | 类型 + 单测 + 扫描 |
| I-2 | allow 规则进入常驻会话 | 配置根写入 allow 规则后建常驻 ACP 会话，断言 `alwaysAllowRules` 为空。**这条钉的是基座行为（F-6），上游同步若开始在 ACP 会话加载规则，它会先红** | 集成测试 |
| I-3 | 宿主在别处放行 | 宿主回 `selected` 的构造点全仓唯一（授权模块内），`optionId` 只可能是 `allow` / `reject`；照 P13.4 `sessionKeyOf` 的「唯一构造点」扫描做法 | 扫描 + fixture |
| I-4 | 模式切换选项（F-9） | 对 `ExitPlanMode` 请求宿主恒拒；对 `auto`/`acceptEdits`/`default`/`bypassPermissions` 四个 optionId 各一条负向用例 | 单测 |
| I-5 | 额外的 `user-confirmed` 签发点 | 生产代码中以 `CapabilityLevel.UserConfirmed` 作签发参数的文件 = {grant 签发模块, 出借方接线}，第三处即红（同 `trust/no-execution-gate` 的白名单形态） | 扫描 + fixture |
| I-6 | 审批者与指挥者混同 | `--approver` 公钥 ∩（`--trust` ∪ 证书目录 ∪ 本节点公钥）= ∅，否则拒绝启动 | 单测 |
| I-7 | 协商缺省放行（F-5） | `LenderOptions.authorize` 必填；`lender.ts` 中不再有 `?? true` | typecheck + 扫描 |
| I-8 | 基座 API 改权限状态 | S-3 扫描的 `SCANNED` 加入授权模块；`FORBIDDEN` 补入 P14.2 探针确认的改规则 / 改模式 API | 既有扫描扩容 |
| I-9 | 有 ask 没记录 | 宿主每次收到 `requestPermission` 先写 `authz.asked` 再作答（spy 断言次数相等）；`authz.*` 消息从不进信箱 | 单测 |
| I-10 | 审计链自洽 | `qm audit --authz-report` 发现「`grant_used` 无对应 `approved`」「`approved` 无对应 `requested`」即退出码 1 | CLI，可进 cron |

**抽查方法**（出口判据后半句）：

1. **攻击语料**（验收场景 `authz/*`，放在 `demo/lib/acceptance/scenarios/`）：对 P14.2 快照中每一类 ask 至少取一个动作，分别经签名控制台对话与签名对端 `task.request` 触发。每个动作的判据：恰好一条 `authz.requested`；批准前无副作用（文件 / 网络探针）；批准后恰好一次 `authz.grant_used` 与副作用；重放审批、他节点审批、`--trust` 节点签的审批、摘要被换的审批各被拒一次并有记录。**同一份部署连续两轮零红才算通过**。
2. **独立复判**：从一个时间窗的审计链随机抽 k 个常驻 turn，取节点侧会话转录中实际执行过的工具调用，用同一模式、空规则集离线重跑基座权限管线得出分类；凡分类为 `ask` 而无对应 `authz.grant_used` 的即为绕过。复判脚本不读宿主写的任何授权记录，只读转录与基座管线，以免自证。

## 5. 权限审计报表

**数据来源**：只读审计链，因此报表的可信度等于链的可信度——先跑 `--verify`（有见证则带 `--witness`），结果印在报表头。

| 类别 | kind（source） | 状态 |
|---|---|---|
| 授权流 | `authz.asked` / `authz.requested` / `authz.approved` / `authz.denied` / `authz.expired` / `authz.revoked` / `authz.grant_used` / `authz.refused`（带 `reason`：replay、aud、approver、digest、expired、estop、budget） | P14 新增，落 `capability` 源（理由见下） |
| hardline | `authz.hardline_denied`：ACP 子进程经一个新的 `qianmo/*` ext 通知上报，宿主落链（沿用 `acp-turn.ts:50-61` 的通道形态） | P14 新增 |
| 姿态 | `authz.posture`：启动时记模式、`--allow-workspace-edits`、策略、信任集名、审批者集名、是否存在 hook 配置 | P14 新增 |
| 既有 | `capability_denied`、影子审计、证书目录事件（`auditTrail.ts:169-177`、`:601-661`）、`negotiation.*` | 已有 |

**为什么落 `capability` 源而不新增一个**：读取端不校验 `source`（`packages/audit/src/trail.ts:165-181`），新增枚举值本身不是兼容问题；选择复用是因为这些都是 C-5 的判决，与 `capability_denied` 同层，控制台按源筛选时一处可见。新增的代价只是控制台筛选项（`packages/console/src/view/audit.ts:293`）与其计数断言（`packages/console/test/view.test.ts:859`）。

**报表字段**：逐条请求一行——`requestId`、节点、agent、`contextId`、来源（`from` / `taskId` / `traceId` / 信任档）、工具、摘要前 12 位、状态、审批者、决定时延、grant 作用域与到期、使用时刻、拒绝次数；汇总按节点 × 时间窗——asked、requested、approved、denied、expired、revoked、used、按原因分的 refused、决定时延 P50/P95、未到期 grant 数；外加姿态一栏。

**呈现**：

- CLI：`qm audit` 暴露 `TrailQuery` 已有的 `--source` / `--outcome`，新增 `--kind`（前缀匹配）；新增 `qm audit --authz-report [--from --to] [--json]`，I-10 的退出码语义与 `--verify` 一致（`qianmoAudit.ts:103`）。
- 控制台：view token 只看汇总计数（与「只读面只有 id 与计数」一致，`console.md` §4.5）；审批凭据看到待批列表的原始输入与逐条报表。

## 6. 任务包

### 6.1 包表

| 包 | 目标 | 依赖 | DoD（可机检） | 估算 |
|---|---|---|---|---|
| **P14.1** ⚖️ 设计定稿与范围回写 | 本文过评审；roadmap M1 节加入 P14 表；charter C-5 补注「`user-confirmed` 的消费者与审批者轴」 | 无 | 本文状态改为生效；roadmap 出现 P14.1–P14.8；charter 升版本号；全仓 grep 证明 P14 未撞号；§7 决策逐条有结论 | 4–8 人时 |
| **P14.2** 可行性探针与 ask 快照 | 证明 §3.2 的前提，产出 C_tool 快照 | P14.1 | 常驻 ACP 会话在 `default` 下对一条 Bash 写操作到达宿主 `requestPermission`（真 ACP 子进程，非 mock）；语料下「`default` + 宿主全拒」与 `dontAsk` 的允许集逐项相等；ask 快照夹具入库；PreToolUse hook 在常驻会话中是否生效有一条用例给出答案 | 8–14 人时 |
| **P14.3** 授权对象与 GrantStore | `AuthzRequest` / `AuthzDecision` / grant 的类型、签名与校验；持久化挂起行状态机 | P14.2 | 字段封闭（多键即拒）；两个签名域互不接受；校验顺序用例（未签名垃圾烧不掉真审批的 nonce）；重放 / 他节点 / 摘要不符 / 过期 / 非审批者 各一条负向用例；重启后重放同一审批被拒；grant 与 hardline 冲突时 hardline 胜；挂起行 / 绑定行文件进 hardline 表，file 与 shell 双面各一条负向用例；零 mock | 20–32 人时 |
| **P14.4** 常驻宿主接线 | `requestPermission` → GrantStore → 挂起 / 放行；hardline 拒绝上报；姿态记录 | P14.3 | I-1、I-3、I-4、I-9 全绿；ESTOP engaged 时 grant 不命中；等待形态按 D-4 实现且不触发看门狗误判；§5 表中 P14 新增的 kind 全部有落链用例；`packages/resident` 零 mock 保持；基座核心文件改动为零或 PR 注明理由 | 24–40 人时 |
| **P14.5** 传输与控制台审批面 | `authz.request` / `authz.decision` / `authz.revoke` 三个消息类型与审批页 | P14.4 | 新类型经 `supportedTypes` 声明、`FRAME_VERSION` 未变（grep 断言）；控制台缺席时请求落台账、回来后按序排空不重复；审批 POST 只收 Bearer、回传摘要不符即拒；审批页带 `X-Frame-Options: DENY`；agent 文本走既有出口转义语料；未送达的撤销显示为未送达 | 28–48 人时 |
| **P14.6** 协商授权接线 | 出借方 `authorize` 改查 GrantStore；演示从脚本钩子迁到真实审批 | P14.3 | I-7 成立；无 grant 时 offer 被拒并产生挂起行；`p61-scenario.ts` 不再出现 `scripted-hook`；AC-7 连续 3/3 不回归 | 8–16 人时 |
| **P14.7** 无绕过棘轮与抽查 | §4 的 I-2、I-5、I-6、I-8、I-10 与两种抽查 | P14.4、P14.5 | 每个扫描都有「会开火」的 fixture；`authz/*` 验收场景在同一份部署连续两轮零红；独立复判脚本对一个构造的绕过样本（手工放行一次）报出 1 条 | 16–28 人时 |
| **P14.8** 权限审计报表 | CLI 与控制台两处呈现 | P14.3（kind 定义）、P14.4 | `--source/--outcome/--kind` 有用例；`--authz-report` 在链断时报表头标红且退出码 1；view token 调报表只得到计数（403 / 字段缺失各一条用例） | 16–28 人时 |

**合计 124–214 人时**。顺序：P14.1 → P14.2 → P14.3 →（P14.4 → P14.5）∥ P14.6 → P14.7；P14.8 在 P14.4 之后可并行。P14.5 动 `packages/protocol` 的消息类型，与同期碰 `message.ts` 的包**不得并行合并**，先落者在 PR 里注明。

### 6.2 明确不做

- **账号体系、SSO、每人身份**（N-2 / P15）；本文只留接口点（§3.3）。
- **注册中心鉴权**：`console.md` §8.2 把它归到本行，本文不接——它答的是「名字归谁」，与「动作要不要用户同意」不是一件事，建议随 P15 处理（D-6）。
- **改 capability claims 字段集**（F-1）、放宽 S-1、让跨节点消息携带 in-node `user-confirmed`。
- **改基座 `permissions.ts`**：授权钩子放在 ACP 客户端侧（扩展点），不在 `dontAsk` 转换前插逻辑。
- **策略语言与通配 grant**（「允许所有 `git push *`」）：v1 只做精确摘要。
- **自动续签**、移动端推送审批、以模型判断代替结构约束。
- **Qianmo 自定的「必须确认」下限表**：除非 P14.2 快照发现有外部副作用的动作被直接 allow（D-7）。

## 7. 需要负责人拍板的决策点

| # | 问题 | 选项 | 建议 |
|---|---|---|---|
| D-1 | 常驻会话模式 | (a) `dontAsk` → `default`，宿主缺省全拒；(b) 保持 `dontAsk`，只做协商与控制台动作的授权；(c) 改基座管线，在 `dontAsk` 转换前插钩子 | **(a)**。(b) 下 C_tool 连请求都发不出，出口判据在节点内工具面不成立；(c) 改核心，每次上游同步重解。(a) 的回滚是一个开关，且等价性由 P14.2 实测 |
| D-2 | N-2 下「用户」的凭据 | (a) 复用 admin token；(b) 第三枚 `--approver-token`，审批只收 Bearer；(c) 浏览器内每人 WebCrypto 密钥 | **(b)**。(a) 让能对话的人顺手能批准，与 `--wake-sign` / `--chat-sign` 分开的理由相同；(c) 已接近账号体系，归 P15 |
| D-3 | 审批签名密钥 | (a) 复用控制台身份密钥 + 签名域分隔；(b) 控制台另持一把审批私钥 | **(b)**。只有密钥不同，I-6 的「审批者 ∩ 指挥者 = ∅」才能在节点启动时机械判定；代价是多分发一个公钥 |
| D-4 | 审批期间的调用形态 | (a) 立即拒绝、批准后用户重发；(b) 有界同步等待 N 秒，超时退回 (a)；(c) 批准后节点自动续跑一轮 | **(b)，N = 90 s，仅对签名控制台会话发起的 turn**；其余来源走 (a)。(a) 单独使用的问题是重发时模型输入稍有不同即摘要不符、再次申请；(c) 等于让节点在没有入站任务时自己开一轮，P13 刻意把这类能力留在中枢（`resident-botization.md` E4、charter R-3 v2.15 补注），不在本包打开 |
| D-5 | grant 时效 | allow-once 单次消费、到期 10 min；时间窗上限 (a) 60 min (b) 8 h (c) 不提供时间窗 | **(a)**。它同时是节点不可达时撤销的最坏延迟 |
| D-6 | 注册中心鉴权归属 | (a) 并入 P14；(b) 随 P15；(c) 单列包 | **(b)**，理由见 §6.2 |
| D-7 | 是否加 Qianmo「必须确认」下限表 | (a) 不加，完全以基座 ask 为准；(b) 加一张冻结表，把特定 allow 改判为 ask | **先 (a)**，P14.2 快照若显示网络外发类命令被直接 allow 再议 |

## 8. 未核实与存疑

- `default` 模式下常驻会话的 `ask` 一律到达宿主：静态阅读支持（空上下文未设 `shouldAvoidPermissionPrompts`；v2.61 记录 `acceptEdits` 下到达），**`default` 未实测**，是 P14.2 的首要判据。
- 「`default` + 宿主全拒」与 `dontAsk` 的允许集相等：静态推断；`packages/builtin-tools/src/tools/PowerShellTool/modeValidation.ts:137-140` 存在按模式分支的工具，需语料覆盖。
- PreToolUse hook 在常驻 ACP 会话中是否执行：**未核实**。若执行，运维配置的 hook 是一条放行来源，需进姿态记录或被禁用。
- 控制台是否对每个节点保持常驻连接：**未核实**；影响 `authz.request` 的送达时延与 D-4 的等待是否有意义。
- 现网节点的实际模式与开关：仓库内无法核实，最近记录是 roadmap v2.61（2026-08-28）。
- `tenancy-m1.md`：并行起草中，本文未读到其内容；§3.3 的依赖项需在两份文档定稿时对账。
- `guard.ts` 头注释称「一条 settings.json 的 allow 规则可以放行任何东西」，与 F-6 对常驻 ACP 会话的结论不一致；hardline 对 hook 与未来上游变化仍有意义，本文不据此改动它，留给 P14.2 一并说明。
- 估算基于 P13 同量级包的历史区间，未经排期评审；日期不在本文承诺范围内。
