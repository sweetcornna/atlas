# 对基座的改造点清单

> **定位**：章程 **T-5 对策④**（「必须改基座核心文件时，注明为什么扩展点不够用」）与 roadmap **P9.3** 交付物「对基座的改造点清单」的汇总件。
>
> **它不是什么**：不是成果边界的举证材料（那是 `positioning-m0.md` §3），不是基座溯源记录（那是根 `BASE.md`，由负责人维护，本文不碰），不是同步演练记录（那是 `upstream-sync-drill.md`）。
>
> **起点**：本文**不重做统计**。文件集合、目录汇总与「提交信息里说了什么」三态判定的原始来源是 [`positioning-m0.md`](./positioning-m0.md) §3.3 与附录 A.3。本文在它之上做三件事：① 把它变成可逐行维护的清单，并**为「部分」与「待补」的 21 行补出「扩展点为何不够用」**；② 归纳三类扩展点覆盖不到的改动；③ 补上 `packages/` 与根配置的改动面。

| 项 | 值 |
| --- | --- |
| 基线 | `3380c88`（基座零改动快照导入提交）。**举证一律用它，不用上游 pin `848ad8c2`**——理由与三条答辩纪律见 `positioning-m0.md` §3.4 |
| 本文实跑口径 | `git diff 3380c88..da98d86f`（2026-08-15）。`src/` 的三个数与 `positioning-m0.md` §3.3 逐字一致，说明该文成稿后 `src/` 未再变动 |
| `src/` 规模 | **56 文件 / +5,152 / −154**，其中**修改 32 / 新增 24** |
| 判定图例 | **✅ 书面** = 提交信息或代码注释直接回答了「扩展点为何不够用」<br>**🟢 代码依据** = 依据在代码 / 注释 / 测试里可查，本句由 P9.3 据此补出<br>**⚠️ 推断** = 未找到书面依据，按代码推断，**待改动人确认** |

---

## 1. 汇总

**按归因族**（族的划分沿用 `upstream-sync-drill.md` §3.2，本文不重算冲突数）：

| 族 | 归属任务包 | 修改 | 新增 | 一句话 |
| --- | --- | --- | --- | --- |
| 身份隔离派生层 | P0.3 | 9 | 3 | 两个定义点 + 一个零依赖的身份模块，其余文件只换 helper 调用 |
| 常驻化改造（含 ACP 扩展、看门狗、信箱记账） | P3.1 | 16 | 13 | 进程内生命周期事件 + 常驻子命令 + 新目录 `src/services/qianmo/` |
| 审计接线与 `occ audit` | P7.2 | 1（`cli.tsx`，与 P3.1 共用） | 3 | 翻译层与 CLI 都在基座侧，`@qianmo/audit` 对各层一无所知 |
| 会话持久化缺陷修复 | P1.2 | 2 | 1 | `--resume` 锚点、只读加载项目目录 |
| 节点密钥路径 / 沙箱审计路径 | P4.3 / P1.3 | 0 | 4 | 两个只做路径派生的薄文件 + 各自的用例 |
| 基座既有测试 / 门禁修复 | 工程面（P0.4 周边） | 4 | 0 | flaky、依赖 `readdir` 顺序、固定等待 |
| **合计** | | **32** | **24** | |

**按目录**：见 `positioning-m0.md` §3.3 的「按目录汇总」表，本文不复制。

---

## 2. 逐文件清单（修改的 32 个）

排序按归因族。行数为 `git diff 3380c88..da98d86f --numstat` 的 `+/−`。

### 2.1 P0.3 身份隔离派生层（9 个修改）

| 文件 | 首改提交 | +/− | 为什么不走扩展点 | 判定 |
| --- | --- | --- | --- | --- |
| `src/config/paths.ts` | `189268d6` | +100/−16 | 基座**没有**路径派生的扩展点：路径与目录名是 `export const`，被约 200 处调用点直接 import。第三重身份（阡陌节点与 occ、官方 CLI 三者共存）只有两条路——改这一个定义点，或 fork 全部调用点。另：本文件在启动期 keychain prefetch 路径上，所以新增的 `identity.ts` 被刻意做成**零 import 模块**，不给它加模块初始化开销 | 🟢 依据：`src/constants/identity.ts` 顶部「WHY THIS EXISTS」「ZERO IMPORTS, ON PURPOSE」两节 |
| `src/constants/brand.ts` | `189268d6` | +31/−4 | 同上，品牌侧：`BIN_NAME` 的约 78 个消费者继续 import 同一符号、透明拿到正确值。文件内同时逐条注明**哪些不随身份切换**及理由（`NPM_PACKAGE_NAME`、OS deep-link scheme），并保留基座「明确不改」清单原样 | 🟢 依据：本文件顶部「Identity switching」节 |
| `src/config/__tests__/paths.test.ts` | `189268d6` | +13/−1 | 随上两项同步的基座既有测试 | 🟢 |
| `src/commands/plugin/ManagePlugins.tsx` | `06ad1423` | +4/−3 | 三处用户可见文案把 `.claude/settings*.json` **硬编码在本文件里**，那是官方 CLI 的目录、本构建从不写它；文案没有可注入的来源 | ✅ 书面 |
| `src/commands/sandbox-toggle/sandbox-toggle.tsx` | `06ad1423` | +5/−1 | 同上 | ✅ 书面 |
| `src/skills/bundled/ultracode.ts` | `4f262147` | +15/−1 | 明确作答：workflow-engine 引擎「单独发布、零 host 依赖」，自己不能 import `src/config/paths.ts`，所以运行目录提示只能修在宿主侧本文件 | ✅ 书面 |
| `src/utils/settings/mdm/constants.ts` | `47878025` | +17/−0 | 反向决定：MDM 策略域**不**随身份切换，三条理由写在提交里（只读策略非各身份状态 / 切换会静默逃逸管理员策略、安全默认须 fail closed / 阡陌节点是同一套代码的另一种模式） | ✅ 书面 |
| `src/utils/permissions/filesystem.ts` | `6c6eef5b` | +19/−6 | 实测缺口：阡陌态可自动改写 occ 的 `~/.occ`（内含凭据）。保护清单的语义**本就该是「全部身份的并集」**，而该清单的定义就在本文件 | ✅ 书面 |
| `src/utils/sandbox/sandbox-adapter.ts` | `6c6eef5b` | +9/−5 | 同一泄漏的读方向：credentials 拒读表改用 `getProtectedUserConfigDirectories()` | ✅ 书面 |

### 2.2 P3.1 常驻化改造 —— 冻结感知看门狗（3 个修改）

三处都是把裸 `setTimeout` 换成 `FreezeAwareWatchdog`（新增文件，见 §2.8）。

| 文件 | 首改提交 | +/− | 为什么不走扩展点 | 判定 |
| --- | --- | --- | --- | --- |
| `src/services/api/claude.ts` | `4fe8cd1e` | +34/−33 | **改动理由是书面的**：基座那条 90 s 流空闲看门狗默认开着，沙箱冻结（`docker pause`）期间墙钟继续走，解冻后计时器立即到期，把一条正常的流判成挂死；修法是跨过时间跳跃后重新计时，不是简单加大阈值。**「扩展点为何不够用」是本次补出的**：超时是流读取函数体内的 `setTimeout` 字面量，基座在这三处没有任何可注入的计时器接口，唯一不改核心的替代是 fork 整条流读取路径 | 🟢 依据：`4fe8cd1e` 提交正文 + `src/utils/network/freezeAwareWatchdog.ts`；**注意**：`upstream-sync-drill.md` §5 行动项③ 已点名这一族「应抽成注入点而不是就地替换」，本次演练唯一的代码语义冲突也出自本族 |
| `src/services/api/gemini/client.ts` | `4fe8cd1e` | +7/−5 | 同上 | 🟢 |
| `src/services/api/openai/responsesAdapter.ts` | `4fe8cd1e` | +15/−10 | 同上。**这一处是演练中唯一的代码语义冲突文件** | 🟢 |

### 2.3 P3.1 常驻化改造 —— ACP 扩展方法（8 个修改）

走的**正是**基座的扩展点（ACP `_meta` / `extNotification` / `extMethod`）；改核心的部分只是**在基座侧留挂载点**——`src/services/acp/entry.ts` 的 +15/−0 就是这条路可行的证据。

| 文件 | 首改提交 | +/− | 为什么不走扩展点 | 判定 |
| --- | --- | --- | --- | --- |
| `src/services/acp/agent/AcpAgent.ts` | `4fe8cd1e`（+`4b06f672`） | +40/−1 | ACP 扩展通道必须**在基座侧有人实现**：`initialize` 的 `_meta.qianmo.resident` 握手位与 `qianmo/input-status` 方法都需要 `sessions` map 与会话内部状态，外部包够不到。`4b06f672` 进一步把 input-status 改回**只读查询**——代码里写明它「deliberately does not switch the process's current session」，因为那个全局指针正是并发流式 prompt 用来决定写哪个 transcript 文件的 | 🟢 依据：`AcpAgent.ts` `qianmo/input-status` 分支上方注释 |
| `src/services/acp/agent/createSessionMethod.ts` | `4fe8cd1e` | +24/−12 | 同一握手位；`onInputAccepted` 由此接出 `qianmo/input-accepted` 扩展通知；同时把 `projectDir` 从全局 `getSessionProjectDir()` 改为显式入参 | 🟢 |
| `src/services/acp/agent/internalAccessors.ts` | `4fe8cd1e` | +5/−0 | 只加一个 `isQianmoResident()` 访问器——`qianmoResident` 是 `AcpAgent` 的私有字段，`entry.ts` 需要它才能决定要不要发扩展通知 | 🟢 |
| `src/services/acp/agent/promptFlow.ts` | `4fe8cd1e` | +5/−6 | 把 `switchSession(..., getSessionProjectDir())` 改成 `session.projectDir`（去掉对全局的依赖）；`submitMessage` 传 `uuid`，好让受理回调能报出**这一条**输入的 id | 🟢 |
| `src/services/acp/agent/sessionLifecycle.ts` | `4fe8cd1e` | +4/−5 | 把解析出来的 `projectDir` 记到 session 上，供上两项使用 | 🟢 |
| `src/services/acp/agent/sessionTypes.ts` | `4fe8cd1e` | +1/−0 | 一个字段：`projectDir: string \| null` | 🟢 |
| `src/services/acp/entry.ts` | `4fe8cd1e` | +15/−0 | 挂载点本身：注册 `registerSessionActivityCallback`，把忙闲边缘经 `qianmo/session-activity` 扩展通知发出，并在 shutdown 时注销。**只留挂载点，逻辑不在这里** | 🟢 |
| `src/services/acp/__tests__/agent.test.ts` | `4fe8cd1e`（+`4b06f672`） | +106/−2 | 随上述 ACP 改动同步的基座既有测试 | 🟢 |

### 2.4 P3.1 常驻化改造 —— 进程内生命周期事件（4 个修改）

| 文件 | 首改提交 | +/− | 为什么不走扩展点 | 判定 |
| --- | --- | --- | --- | --- |
| `src/utils/session/sessionActivity.ts` | `4fe8cd1e`（+`fdbbc2e3`） | +20/−7 | `fdbbc2e3` **明确**：新加的两处 `activityCallback` 没走 `CLAUDE_CODE_REMOTE_SEND_KEEPALIVES` 这道基座既有闸门，开关关着也往远端发包——**修的方向是回到基座既有扩展点** | ✅ 书面 |
| `src/QueryEngine.ts` | `4fe8cd1e` | +10/−2 | 新增可选配置 `onInputAccepted`，并在 transcript 落盘后 await 它（bare 模式下也强制 flush）。**未找到书面依据，按代码推断**：「这条输入已经进了模型的上下文」这个事实只有 QueryEngine 在写 transcript 的那一刻知道，基座既没有对应的 hook 也没有事件通道；宿主要么拿到这个回调，要么只能靠时间猜（提交正文里那句「而不是靠时间猜」正是它要避免的） | ⚠️ 推断（待改动人确认） |
| `src/cli/transports/WebSocketTransport.ts` | `4fe8cd1e` | +2/−2 | **未找到书面依据，按代码推断**：这是 `registerSessionActivityCallback` 回调签名从 `() => void` 变为 `(active: boolean) => void` 的**连带修改**。常驻宿主需要的是忙→闲的**边缘**（新增的 `activityCallback?.(false)` 分支），而基座这两个既有订阅者在旧签名下会把「闲」也当成一次 keep_alive；加 `if (active)` 守卫是为了让基座原语义**逐字不变** | ⚠️ 推断（待改动人确认） |
| `src/cli/transports/ccrClient.ts` | `4fe8cd1e` | +2/−2 | 同上 | ⚠️ 推断（待改动人确认） |

> **勘误**：`positioning-m0.md` §3.3 把 `src/QueryEngine.ts`、`WebSocketTransport.ts`、`ccrClient.ts` 三行的理由写作「看门狗替换」。逐 diff 复核后不成立——三者与 `FreezeAwareWatchdog` 无关，分别是输入受理回调与会话活跃度签名的连带修改。看门狗替换只涉及 §2.2 的三个文件。

### 2.5 P7.2 审计与 `occ audit`（1 个修改）

| 文件 | 首改提交 | +/− | 为什么不走扩展点 | 判定 |
| --- | --- | --- | --- | --- |
| `src/entrypoints/cli.tsx` | `4fe8cd1e`（+`11c0a622`） | +21/−0 | 三个子命令分派分支（`resident` / `audit` / `resident-wake`），各自 `await import(...)` 动态加载。**未找到书面依据，按代码推断**：基座**没有子命令注册表**——`main()` 里是一长串 `if (args[0] === '…')` 字面量分派（`migrate` / `daemon` / `autonomy` / `job` 等十余处都长这样），新增子命令除了在这里加分支之外没有第二个入口 | ⚠️ 推断（待改动人确认） |

### 2.6 会话与信箱（3 个修改；前两行 P1.2 缺陷修复，第三行 P3.1 常驻化）

| 文件 | 首改提交 | +/− | 为什么不走扩展点 | 判定 |
| --- | --- | --- | --- | --- |
| `src/utils/sessionStorage/logAssembly.ts` | `fad809bc`（+`4b06f672`） | +10/−2 | **基座既有缺陷**：`findLatestMessage` 用严格 `>`，时间戳并列时锚点粘在第一条，`--resume` 静默丢尾部消息——正是 AC-1 / AC-2 最难现场诊断的失效方式。缺陷在基座代码里，修它没有「扩展点」这个选项 | ✅ 书面 |
| `src/utils/sessionStorage/transcriptLoader.ts` | `4b06f672` | +13/−4 | `loadSessionFile` 原从全局状态推项目目录，导致一次**只读查询**必须改全局会话指针；改为允许显式传入项目目录（缺省行为不变） | ✅ 书面 |
| `src/utils/agents/teammateMailbox.ts` | `4fe8cd1e` | +33/−3 | 常驻节点复用基座的**文件信箱**作为入站通道，必须能断言「我快照的这 N 条**恰好**被翻成已读」（`packages/resident/src/reader.ts` 的 `#markRead` 在 `marked !== snapshot.length` 时抛错）。原函数返回 `void`，且按 identity（`from`+`timestamp`+`text`）匹配——重复消息若在快照与翻转之间被**外部**读掉一条，原实现会去翻**后一条同内容**的消息，即把一条本节点从未处理的消息标成已读，而调用方无从察觉。改动两处：① 返回实际计数；② 收一份快照时刻的已读计数 `readBefore`，把外部已读的那条**记账**而不是另找一条来翻。**未找到书面依据，按代码推断**扩展点为何不够用：核对必须发生在**同一把文件锁内**（基座导出了函数，不导出锁），锁外重读正是这把锁存在要防的那个竞态 | ⚠️ 推断（待改动人确认） |

### 2.7 基座既有测试 / 门禁修复（4 个修改）

「扩展点」这个判据在这一类上不适用——被改的是基座**自己的**测试。判据换成「改的是不是基座自身的缺陷，或我方新增目录的接入」。

| 文件 | 首改提交 | +/− | 理由 | 判定 |
| --- | --- | --- | --- | --- |
| `src/services/skillLearning/__tests__/throttleAndCircuitBreaker.test.ts` | `e86d901b` | +10/−0 | 基座既有 flaky：用例缺 `timeoutMs`，前序文件泄漏凭据时会真连网并超时变红 | ✅ 书面 |
| `src/utils/__tests__/claudemd.projectDirs.test.ts` | `6bada14c` | +6/−2 | 基座既有断言把 `readdir` 枚举顺序当成契约，CI 的 ext4 上会假红 | ✅ 书面 |
| `src/services/mcp/__tests__/configWatcher.test.ts` | `a8b06a9a` | +24/−19 | **提交正文为空。按 diff 推断**：三条正向用例原本「固定睡 2600 ms 再断言 `fired > 0`」；`watchFile` 是 1 s 轮询 + debounce，负载高的 CI runner 上两个 tick 未必落在 2.6 s 内，正向用例因此偶发变红。改为**等待真实的文件事件**（回调 resolve 一个 Promise），把「够不够久」交给测试框架超时而不是猜一个墙钟预算。**负向**用例仍需固定等待（要证明「什么都没发生」只能等够两个 tick），故保留并改名 `settleForNoChange`。**代价须一并记**：正向用例从「偶发断言失败」变成「事件不来就挂到用例超时」 | ⚠️ 推断（待改动人确认） |
| `src/utils/__tests__/teammateMailbox.test.ts` | `4fe8cd1e` | +28/−0 | 随 §2.6 的信箱改动新增一条用例，用例名直述该语义：`resident snapshot accounts for an externally read duplicate without marking a later one` | ⚠️ 推断（随 §2.6 同一条，待改动人确认） |

**判定统计（32 个修改文件）：✅ 书面 11 / 🟢 代码依据 14 / ⚠️ 推断待确认 7。**
七条 ⚠️ 分属**五件事**：`QueryEngine.onInputAccepted`、会话活跃度签名连带修改（2 个文件）、`cli.tsx` 子命令分派、信箱记账（2 个文件）、`configWatcher` 用例。

### 2.8 新增的 24 个文件

新增文件在上游同步中**不产生冲突**（演练实测：上游新增 261 文件 ∩ 我方新增 372 文件 = 空集，`upstream-sync-drill.md` §3.1），所以逐个论证「扩展点为何不够用」意义有限；按目录列出与归属即可。

| 目录 / 文件 | 个数 | 行数 | 归属 | 性质 |
| --- | --- | --- | --- | --- |
| `src/constants/identity.ts` | 1 | +92 | P0.3 | 身份派生层本体，零 import |
| `src/config/__tests__/identityIsolation.test.ts` / `identityProbe.runner.ts` | 2 | +268 | P0.3 | 子进程探针验证三身份隔离与并集保护 |
| `src/services/qianmo/`（全新目录：`resident.ts` 730 / `auditTrail.ts` 318 / `nodeIdentity.ts` 139 / `sandboxAudit.ts` 8 + 5 个测试/fixture） | 9 | +1,968 | P3.1(4) / P7.2(1) / P4.3(2) / P1.3(2) | 常驻节点接线、审计翻译层、节点密钥路径、沙箱审计路径。**翻译层在基座侧是刻意的**：`@qianmo/audit` 若认识各层就得依赖树里每个包，依赖方向会反过来（`auditTrail.ts` 顶部注释）。`nodeIdentity.ts` / `sandboxAudit.ts` 存在的唯一理由是**路径必须从 `src/config/paths.ts` 派生**，而 `@qianmo/*` 包刻意不持有路径约定 |
| `src/cli/handlers/`（`resident.ts` 590 / `qianmoAudit.ts` 209 / `residentWake.ts` 172 / `residentArgs.ts` 18 + 3 个测试） | 7 | +1,728 | P3.1(5) / P7.2(2) | 三个阡陌子命令的实现，被 `cli.tsx` 动态 import |
| `src/utils/network/freezeAwareWatchdog.ts` + 测试 | 2 | +233 | P3.1 | 时间跳跃感知的看门狗，内部用 `@qianmo/protocol` 的 `TimeJumpGate` |
| `src/utils/session/__tests__/sessionActivity.test.ts` | 1 | +78 | P3.1 | 忙闲边缘与 keepalive 闸门 |
| `src/utils/sessionStorage/__tests__/logAssemblyTieBreak.test.ts` | 1 | +36 | P1.2 | `--resume` 锚点缺陷的红→绿用例 |
| `src/__tests__/queryEngineInputAdmission.test.ts` | 1 | +101 | P3.1 | 输入受理回调 |

---

## 3. 基座扩展点覆盖不到的三类改动

把 §2 的 32 行往上抽一层，改核心的**原因**只有三种。这一节是给「下次还要不要改核心」这个问题用的判据。

### 3.1 常驻宿主进程内的扩展点缺失

基座的四个扩展点（ACP、MCP、hooks、workspace 包）都站在**进程之外**或**一次调用之内**：它们能收到「一个 turn 开始了 / 结束了」，收不到常驻化真正需要的**进程内生命周期事实**——

- 「这条输入**已经**进了模型的上下文」这一刻（`QueryEngine.onInputAccepted`），
- 会话从忙到闲的**边缘**（`sessionActivity` 的 `active` 参数），
- 流空闲计时器的**时基**（冻结期间墙钟继续走，`FreezeAwareWatchdog`），
- 新增一个顶层子命令（`cli.tsx` 没有子命令注册表）。

这四件事都只有基座运行时自己知道，任何外部扩展点都拿不到。可行的姿势不是「找一个扩展点」，而是**在基座侧只留挂载点、逻辑放进 `@qianmo/*`**——`src/services/acp/entry.ts` 的 +15/−0 与 `src/cli/handlers/*` 的 1,728 行新增就是这个形状的两个样本。

### 3.2 身份隔离派生层

基座的路径与品牌是 `export const`，被约 200 处调用点直接 import；**基座没有为「同一份代码以另一种身份运行」预留任何派生扩展点**。要让阡陌节点与 occ、官方 Claude Code 三者在同一台机器上共存，只有两条路：改两个定义点（`paths.ts` / `brand.ts`）+ 加一个零依赖身份模块，或 fork 全部调用点。

这一族的形状被同步演练评为**模范样板**（9 个改动文件、0 冲突，理由见 `upstream-sync-drill.md` §3.2 与 §5 行动项⑥）。可复用的规则也在那里，本文不复制。

### 3.3 测试与门禁

`src/` 里有 4 个修改文件、`scripts/` 里有 2 个（见 §5.3），它们没有「扩展点」这一维——被改的是基座**自己的**测试断言、门禁数字与 CI 配置。这一类的正确判据是另外两条：

1. 改的是不是**基座自身的缺陷**（flaky、把 `readdir` 顺序当契约、固定墙钟等待）；
2. 或者是不是**我方新增目录接入既有门禁**（`test-shards.sh` 的分片名单、`knip.json` 的 entry 列表、`unused-budget.json` 的棘轮数字）。

第 2 类每次上游同步都会冲突（数字必然两边都动），这一点演练已经量到，对策见 §4。

---

## 4. M1 减冲突的对策

**本节只给指针，不复制结论。**

- **候选任务包清单**：章程 §5.7「**M1 排期输入（v2.9）**」——**五条**候选项，全部「候选 · 未排期」，是否立项待 M1 排期评审。
- **行动项原文与数据**：[`upstream-sync-drill.md`](./upstream-sync-drill.md) §5（结论与行动项，共 7 条，上述五条对应其第 2 ~ 6 条），冲突清单在同文 §3.1、按族统计在 §3.2、工时在 §4。

本文与那两处的**对应关系**（只作定位用，不重述内容）：

| 演练 §5 第几条 | 指向本文的哪些行 |
| --- | --- |
| 2 · 改薄 `CLAUDE.md` / `README.md` | 不在本文范围（根目录文档，非 `src/`；见演练 §3.1 前两行） |
| 3 · 把 `FreezeAwareWatchdog` 类替换抽成注入点 | **§2.2 全部三行** |
| 4 · 拆分 `unused-budget.json` | **§5.3** 的 `scripts/unused-budget.json` |
| 5 · 把 ACP 常驻会话逻辑收进 `@qianmo/resident` | **§2.3 全部八行**（尤其 `entry.ts` 的 +15/−0） |
| 6 · 「先找上游现成的间接层」成文规则 | **§2.1 / §3.2**（正面样板） |

---

## 5. `packages/` 与根配置的改动

实跑：`git diff 3380c88..da98d86f --stat -- packages/ package.json knip.json .gitignore .github`。

### 5.1 `packages/`：253 文件 / +41,962 / −1，其中**修改只有 1 个**

新增 252 个文件中，**251 个属于 17 个 `@qianmo/*` workspace 包**（包清单见 `positioning-m0.md` §3.2），剩下 1 个是基座既有包里新加的测试 `packages/@ant/model-provider/src/shared/__tests__/emptyReasoningChurn.test.ts`（下表那处修复的四条覆盖用例）。**基座既有 `packages/*` 被修改的文件只有一个**：

| 文件 | 提交 | +/− | 为什么不走扩展点 | 判定 |
| --- | --- | --- | --- | --- |
| `packages/@ant/model-provider/src/shared/openaiStreamAdapter.ts` | `8f4c13c8`（2026-08-12，P1.4） | +16/−1 | **提交信息末段直接作答**：「改的是基座核心（流适配器），按 `CLAUDE.md` §2.3 说明：这是流式解析内部的判断，没有任何扩展点能在不 fork 整个适配器的前提下改它」。改动本身很窄——空 `reasoning_content` **且正文已在流动**时忽略它；DeepSeek 的「正文前空串」契约不动。真机实测：修前 qwen3.8-max 一条两点问答产出 251 块（126 thinking，125 个是空的），修后 2 块 | ✅ 书面 |

> 该文件同时是同步演练中的冲突文件之一（`upstream-sync-drill.md` §3.1，归因族「其他 / provider 兼容修复」）。

### 5.2 根配置：6 文件 / +66 / −146

| 文件 | +/− | 改了什么 |
| --- | --- | --- |
| `.github/workflows/publish-npm.yml` | 删除（−135） | **整份移除**——本仓库不发布 npm 包、不打 tag、不跑基座 release 流程（章程 N-13/N-14，roadmap P0.4） |
| `.github/workflows/ci.yml` | +13/−6 | 两处 `bun-version: latest` → `bun-version-file: .tool-versions`（CI 不得静默跟随上游 Bun 发版，会威胁 P8.1 的「全新机器 30 min 复现」）；随 `publish-npm.yml` 删除同步改掉两处注释里的交叉引用 |
| `.github/pull_request_template.md` | +14/−3 | 新增必填项「**本 PR 修复的边界问题对应哪条用例**」（P0.4 为 AC-8 流程约束预埋）；自查清单补 `bun run verify`、一件事一个提交、走 PR 不直推 |
| `package.json` | +23/−1 | 新增 17 条 `@qianmo/*` workspace 依赖；新增 script `verify` / `verify:p32` / `sbom`；新增两个 MCP server 依赖（P6.3 兼容子集核验用）。**`release` script 与其余基座发布面原样保留、不触发** |
| `knip.json` | +12/−1 | 两个 MCP server 加进 `ignoreDependencies`；`demo/lib/*.ts` 的 9 个入口加进 entry 列表（否则被判「未使用文件」） |
| `.gitignore` | +4/−0 | 忽略 `.demo-env/`——演示环境运行态（密钥、节点配置根、日志、工作区），由 `demo/env/seed.sh` 生成，永不入库 |

### 5.3 附：`scripts/` 里被修改的两个基座文件

不在上一条的统计命令内，但属同一类改动，列在这里以免遗漏（`git diff 3380c88..da98d86f --stat -- scripts/`：12 文件 / +4,222 / −7，其余 10 个为新增）。

| 文件 | +/− | 改了什么 |
| --- | --- | --- |
| `scripts/test-shards.sh` | +23/−6 | ① 分片名单加入 `tests/boundary` 与 `demo/lib`——不在这个循环里的测试目录**在 CI 里根本不跑**，而本地 `bun test` 会跑，那种「本地绿 + CI 绿」的第二个绿毫无意义；② `@qianmo/*` 包的分片加 `--isolate`（每个测试文件一份全新 global，把跨文件 mock/env 洁净度变成结构保证），**基座分片保持原样**——把 700 个基座文件翻成 `--isolate` 是未经度量的风险且平白制造基座漂移；③ 随 `publish-npm.yml` 删除改掉注释里的交叉引用 |
| `scripts/unused-budget.json` | +1/−1 | `exports` 棘轮 1255 → 1251。**每次上游同步必然冲突的那个数字**，对策见 §4 |

---

## 6. 待办与维护规矩

### 6.1 待改动人确认的 7 行（分属 5 件事）

章程 T-5 对策④ 要求「扩展点为何不够用」写在 PR 描述里。下列各行的这句话是 P9.3 **按代码推断**补出的，需要原改动人确认或改写：

| # | 事项 | 涉及文件 | 请确认什么 |
| --- | --- | --- | --- |
| 1 | `QueryEngine.onInputAccepted` | `src/QueryEngine.ts` | 是否确实没有 hook / 事件能在基座外拿到「输入已入上下文」这一刻？ |
| 2 | 会话活跃度签名连带修改 | `src/cli/transports/WebSocketTransport.ts`、`src/cli/transports/ccrClient.ts` | 加 `if (active)` 是否只为保持基座原语义逐字不变、没有别的意图？ |
| 3 | 子命令分派 | `src/entrypoints/cli.tsx` | 基座确实没有子命令注册表可用？是否评估过复用 `daemon` 那条分派？ |
| 4 | 信箱记账 | `src/utils/agents/teammateMailbox.ts`、`src/utils/__tests__/teammateMailbox.test.ts` | 「核对必须在同一把文件锁内、锁外重读即竞态」这个理由是否就是当时的判断？ |
| 5 | `configWatcher` 用例 | `src/services/mcp/__tests__/configWatcher.test.ts` | 提交正文为空。改动动机是否为 CI 上的固定等待偶发失败？「事件不来就挂到用例超时」这一代价是否评估过？ |

### 6.2 ⚠️ 一处与章程措辞的不一致（本文不擅自处理）

> **已处置（2026-08-16）**：章程 v2.10 采用下文「维持原句并加补注」方案，于 §5.5 该句处加补注指向本节与 §2.6；下文保留为记录。

章程 **§5.5「P0.5 复核结论 · 与基座既有机制的关系定性」**写着：最后一跳「**复用基座既有的文件信箱，不另造、不改基座核心**」。

**实际状态与这句话不符**：P3.1（`4fe8cd1e`）改了 `src/utils/agents/teammateMailbox.ts`（+33/−3，见 §2.6 第三行）。

- **改动性质是加法、不改默认行为**：新增一个**可选**参数 `readBefore` 与一个返回值；不传该参数时行为与基座原实现一致（`return markedCount`，此前是 `return`）。所以「不另造」成立，「不改基座核心」这半句在字面上不成立。
- **为什么值得提**：这句话是章程 §5.5 的**书面结论**，也是答辩时「你们改了基座哪些地方」这一问的引用来源之一；一处字面不符会被当场问出来。
- **建议处置（待负责人裁定，本文不改章程）**：把该句改为「复用基座既有的文件信箱，不另造；为常驻侧的读回执核对，对 `teammateMailbox.ts` 做了一处向后兼容的加法（见 `base-modifications.md` §2.6）」，或维持原句并在该处加一条补注指向本文。**章程改动须回写并升版本号**（`CLAUDE.md` §2.1）。

### 6.3 维护规矩

1. **本文按文件维护，不按提交维护。**新增一行的触发条件是「一个此前未被改过的基座文件被改了」；同一文件的后续改动补进同一行的「为什么」栏，不新开行。
2. **改基座核心的 PR，必须同时更新本文对应行**，理由逐字取自 PR 描述（章程 T-5 对策④）。
3. **本文不复制** `positioning-m0.md` 的目录汇总表、`upstream-sync-drill.md` 的冲突数据、章程 §5.7 的 M1 候选清单——只放指针（「指针不复制」铁律，`CLAUDE.md` §1.1⑧）。
4. **本文不是 `BASE.md`。**上游、pin、导入日期、同步记录仍由负责人在 `BASE.md` 维护（`CLAUDE.md` §2.4）。
5. 数字过期时**重跑**表头那条命令并更新「本文实跑口径」行，不要凭印象改。
