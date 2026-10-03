<!-- Copyright 2026 Qianmo AgentNest Team -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

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
| **口径变更（P10.2，2026-08-17）** | **首次真实上游同步后，「我方对基座改了什么」不能再用 `git diff 3380c88 -- <file>` 量** —— 那条现在同时包含上游 v2.38.3→v2.46.0 的改动。改用 **`git diff base-snapshot/v2.46.0 -- <file>`**（当前基座树的零改动快照标签，见 `BASE.md`），它给出的正是「我方相对当前基座还剩什么」。下文各表的 +/− 数已按新口径复核：**逐字未变**——因为我方那几处改动原样落在上游新代码之上（P10.2 的两份合并审计逐条核过）。**基线 `3380c88` 仍是成果边界的历史起点，只是不再是改造点的度量基线** |
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
| `src/config/paths.ts` | `189268d6` | +100/−16 | 基座**没有**路径派生的扩展点：路径与目录名是 `export const`，被约 200 处调用点直接 import。第三重身份（阡陌节点与 occ、官方 CLI 三者共存）只有两条路——改这一个定义点，或 fork 全部调用点。另：本文件在启动期 keychain prefetch 路径上，所以新增的 `identity.ts` 被刻意做成**零 import 模块**，不给它加模块初始化开销。**P17.4 后续改动（`ce2314bb`，+15/−0；相对快照现值 +122/−16，本行 +100/−16 是 P0.3 当时的数）**：纯插入一个函数 `qmcodeHome()`——`$QMCODE_HOME`，否则 `~/.qmcode`，与 fork `codex-rs/utils/home-dir` 同一条规则；`qm handoff sync --hook qmcode` 在它的 `sessions/` 下按 thread id 找 rollout。理由同本行：家目录下的路径只能在这里派生（`CLAUDE.md` §1.1②，身份路径门禁），阡陌自有文件里写 `homedir()` 会被门禁拦下 | 🟢 依据：`src/constants/identity.ts` 顶部「WHY THIS EXISTS」「ZERO IMPORTS, ON PURPOSE」两节 |
| `src/constants/brand.ts` | `189268d6` | +31/−4 | 同上，品牌侧：`BIN_NAME` 的约 78 个消费者继续 import 同一符号、透明拿到正确值。文件内同时逐条注明**哪些不随身份切换**及理由（`NPM_PACKAGE_NAME`、OS deep-link scheme），并保留基座「明确不改」清单原样 | 🟢 依据：本文件顶部「Identity switching」节 |
| `src/config/__tests__/paths.test.ts` | `189268d6` | +13/−1 | 随上两项同步的基座既有测试 | 🟢 |
| `src/commands/plugin/ManagePlugins.tsx` | `06ad1423` | +4/−3 | 三处用户可见文案把 `.claude/settings*.json` **硬编码在本文件里**，那是官方 CLI 的目录、本构建从不写它；文案没有可注入的来源 | ✅ 书面 |
| `src/commands/sandbox-toggle/sandbox-toggle.tsx` | `06ad1423` | +5/−1 | 同上 | ✅ 书面 |
| `src/skills/bundled/ultracode.ts` | `4f262147` | +15/−1 | 明确作答：workflow-engine 引擎「单独发布、零 host 依赖」，自己不能 import `src/config/paths.ts`，所以运行目录提示只能修在宿主侧本文件 | ✅ 书面 |
| `src/utils/settings/mdm/constants.ts` | `47878025` | +17/−0 | 反向决定：MDM 策略域**不**随身份切换，三条理由写在提交里（只读策略非各身份状态 / 切换会静默逃逸管理员策略、安全默认须 fail closed / 阡陌节点是同一套代码的另一种模式） | ✅ 书面 |
| `src/utils/permissions/filesystem.ts` | `6c6eef5b` | +19/−6 | 实测缺口：阡陌态可自动改写 occ 的 `~/.occ`（内含凭据）。保护清单的语义**本就该是「全部身份的并集」**，而该清单的定义就在本文件 | ✅ 书面 |
| `src/utils/sandbox/sandbox-adapter.ts` | `6c6eef5b` | +9/−5 | 同一泄漏的读方向：credentials 拒读表改用 `getProtectedUserConfigDirectories()` | ✅ 书面 |

### 2.2 P3.1 常驻化改造 —— 冻结感知看门狗（3 个修改）

三处都是把裸 `setTimeout` 换成冻结感知的等价物（`FreezeAwareWatchdog`，新增文件，见 §2.8）。

> **P10.3② 已整改（2026-08-17）**：原先是在基座文件里就地 `new FreezeAwareWatchdog({...})` + `reset()`，把整段回调体重排进对象字面量——那正是演练里唯一的代码语义冲突。现改为在 `freezeAwareWatchdog.ts` 里派生一对与全局 `setTimeout` / `clearTimeout` **同形**的注入点（`setFreezeAwareTimeout` / `clearFreezeAwareTimeout` + `FreezeAwareTimer` 句柄接口，含尾随实参透传），三个基座文件的控制流与变量名**回到上游原文**，只剩标识符替换。下表 +/− 为整改后的现状，括号内为整改前。行为逐字不变（超时值/错误语义/重置时机/冻结跨越语义逐项核对），三方合并实测：`responsesAdapter.ts` 对上游 v2.46.0 补丁的冲突 **1 → 0**。

| 文件 | 首改提交 | +/− | 为什么不走扩展点 | 判定 |
| --- | --- | --- | --- | --- |
| `src/services/api/claude.ts` | `4fe8cd1e` | +11/−6（整改前 +34/−33） | **改动理由是书面的**：基座那条 90 s 流空闲看门狗默认开着，沙箱冻结（`docker pause`）期间墙钟继续走，解冻后计时器立即到期，把一条正常的流判成挂死；修法是跨过时间跳跃后重新计时，不是简单加大阈值。**「扩展点为何不够用」是本次补出的**：超时是流读取函数体内的 `setTimeout` 字面量，基座在这三处没有任何可注入的计时器接口，唯一不改核心的替代是 fork 整条流读取路径。**P10.3② 后这条依然成立**——注入点消除的是「就地重写」，不是「必须改这三行」：基座仍然没有可注入的计时器接口，我方只是把替换收窄成一个与 `setTimeout` 同形的标识符 | 🟢 依据：`4fe8cd1e` 提交正文 + `src/utils/network/freezeAwareWatchdog.ts`；`upstream-sync-drill.md` §5 行动项③ 点名的「应抽成注入点而不是就地替换」**已于 P10.3② 落地** |
| `src/services/api/gemini/client.ts` | `4fe8cd1e` | +6/−2（整改前 +7/−5） | 同上 | 🟢 |
| `src/services/api/openai/responsesAdapter.ts` | `4fe8cd1e` | +6/−2（整改前 +15/−10） | 同上。**这一处曾是演练中唯一的代码语义冲突文件，P10.3② 后实测已可干净合并**。**P18.5 后续改动（`c3d3061e`，hermes #12b，+12/−10，相对快照现值 +18/−12）**：`isReasoningSummaryRejection` 的内联判断换成通用检测 `isUnsupportedParameterText`（`modelCompat/unsupportedParam.ts`），这一字段原有的文案表原样留在本文件，行为不变；适配器内的回退走 `retryOpenAIRequest` 的 `onError` 指令，没有别的入口。**P18.8 后续改动（`d868176e` hermes #23、`fc6edcb1` hermes #26，+29/−2，相对快照现值 +47/−14）**：① 推理条目捕获时，`onReasoningItem` 的实参插入签发方印记 `issuer`；回放循环的数据源换成一次 `replayableReasoningItems(…, currentReasoningIssuer())` 调用（`modelCompat/responsesIssuer.ts`），另插入模块内小函数 `currentReasoningIssuer` 与导入；② `extractUsage` 给 `normalizeOpenAIUsage` 的实参插入 `reasoningTokens`（`modelCompat/responsesUsage.ts`）。捕获与回放都只在本文件里发生，没有钩子。舰队线（gpt-6-luna · Responses）同端点回放逐字节不变，由 `requestParity.test.ts` 的 fleet lock 用例钉住 | 🟢 |

### 2.3 P3.1 常驻化改造 —— ACP 扩展方法（8 个修改）

走的**正是**基座的扩展点（ACP `_meta` / `extNotification` / `extMethod`）；改核心的部分只是**在基座侧留挂载点**——`src/services/acp/entry.ts` 的 +15/−0 就是这条路可行的证据。

| 文件 | 首改提交 | +/− | 为什么不走扩展点 | 判定 |
| --- | --- | --- | --- | --- |
| `src/services/acp/agent/AcpAgent.ts` | `4fe8cd1e`（+`4b06f672`） | +40/−1 | ACP 扩展通道必须**在基座侧有人实现**：`initialize` 的 `_meta.qianmo.resident` 握手位与 `qianmo/input-status` 方法都需要 `sessions` map 与会话内部状态，外部包够不到。`4b06f672` 进一步把 input-status 改回**只读查询**——代码里写明它「deliberately does not switch the process's current session」，因为那个全局指针正是并发流式 prompt 用来决定写哪个 transcript 文件的。**P18.20 后续改动（`9ed5f5fc`，D-9，+3/−0，相对快照现值 +161/−34）**：`sendAvailableCommandsUpdate` 在原 filter/map 之后纯插入一行 `availableCommands.push(...acpLocalCommandEntries(session.commands))`，另加一行 import；白名单与入选条件在阡陌自有的 `localCommands.ts`（§2.14）。通告表是这个私有方法里的局部数组，外部够不到，也没有注册点 | 🟢 依据：`AcpAgent.ts` `qianmo/input-status` 分支上方注释 |
| `src/services/acp/agent/createSessionMethod.ts` | `4fe8cd1e`（+P13.6、+P13.7） | +63/−15 | 同一握手位；`onInputAccepted` 由此接出 `qianmo/input-accepted` 扩展通知；同时把 `projectDir` 从全局 `getSessionProjectDir()` 改为显式入参。**P13.6** 在此按 `_meta.qianmo.resident` 给常驻会话加一个 `qianmo_notify` 工具（`params.mcpServers` 在本构建里到不了工具面，理由写在 `src/services/qianmo/notifyTool.ts`）。**P13.7** 在同一分支上给该会话的整个工具数组套 hardline 天花板——**这一处正是「扩展点够用」的例子**：包裹 `checkPermissions` 就同时压过本构建里仅有的两条能答 allow 的漏斗（`hasPermissionsToUseToolInner` 的 1c/1d 在 bypass 模式 2a 与整工具 allow 规则 2b 之上；PreToolUse hook 已答 allow 的那条仍跑 `checkRuleBasedPermissions`），因此**没有改 `src/utils/permissions/permissions.ts`**，那是每次工具调用的热路径核心文件，改它等于每次上游同步手工重解一遍 | 🟢 依据：`src/services/qianmo/residentGuard.ts` 顶部注释 |
| `src/services/acp/agent/internalAccessors.ts` | `4fe8cd1e` | +5/−0 | 只加一个 `isQianmoResident()` 访问器——`qianmoResident` 是 `AcpAgent` 的私有字段，`entry.ts` 需要它才能决定要不要发扩展通知 | 🟢 |
| `src/services/acp/agent/promptFlow.ts` | `4fe8cd1e` | +5/−6 | 把 `switchSession(..., getSessionProjectDir())` 改成 `session.projectDir`（去掉对全局的依赖）；`submitMessage` 传 `uuid`，好让受理回调能报出**这一条**输入的 id。**P18.20 后续改动（`f1967600`，D-9，+4/−0，相对快照现值 +139/−66）**：`prompt` 在 `activateAcpSessionWorkspace` 之后、`submitMessage` 之前纯插入一次 `refreshAcpTurnSettings(session)`（`localCommands.ts`，§2.14）。基座的设置变更检测器不在 `--acp` 快速路径上启动，`submitMessage` 开头从会话 AppState 抄走压缩窗口；「每轮开始、提交之前」只有这一处 | 🟢 |
| `src/services/acp/agent/sessionLifecycle.ts` | `4fe8cd1e`；后续 `921b282f`（符号链接 cwd） | +28/−17（M0 时 +4/−5；`921b282f` +3/−6；其余 +21/−6 是两者之间的改动，本文此前未登记） | 把解析出来的 `projectDir` 记到 session 上，供上两项使用。**后续（`921b282f`）**：修一处**基座既有缺陷**（P18.3 实测发现）。会话记录按调用方给的 cwd 原样写，resume 时 `resolveSessionFilePath` 却按 realpath 后的 cwd 查找；cwd 路径里只要有符号链接，每次续会话都是空的。写入 key 由阡陌自有的 `sessionWorkspace.ts` 决定：`projectDirForSessionCwd` 改为先 realpath 再做 NFC，与 `canonicalizePath` 语义相同。本文件**只做标识符替换**：两处 `resolveSessionFilePath` 换成 `resolveAcpSessionFile`，import 随之调整；第一处调用被 biome 从 4 行折成 1 行，所以删除数是 6。`resolveAcpSessionFile` 也在 `sessionWorkspace.ts`：先按规范 key 走基座查找，找不到、并且原样 key 与规范 key 不同时，再按原样 key 找一次，兼容旧版写下的记录。旧记录只能续上最近一次续会话以来的那段：旧版每次续会话都从空会话开始，新的几轮在同一个文件里另起一条链，加载时只沿最新的链往回走，这正是旧进程最后看到的上下文。不改基座 `resolveSessionFilePath` 本身的原因：它还服务 SDK 和 CLI，而按原样 key 写记录的只有 ACP | 🟢；后续部分 ✅ 书面 |
| `src/services/acp/agent/sessionTypes.ts` | `4fe8cd1e` | +1/−0 | 一个字段：`projectDir: string \| null` | 🟢 |
| `src/services/acp/entry.ts` | `4fe8cd1e`；后续 `de34761a`（ACP 退出刷写） | +68/−0（M0 时 +15/−0；`de34761a` +11/−0；其余 +42/−0 是两者之间的改动，本文此前未登记） | 挂载点本身：注册 `registerSessionActivityCallback`，把忙闲边缘经 `qianmo/session-activity` 扩展通知发出，并在 shutdown 时注销。**只留挂载点，逻辑不在这里**。**后续（`de34761a`）**：修一处**基座既有缺陷**（P18.3 实测发现，见 PR #164 说明）。`--acp` 模式不走 `gracefulShutdown`，信号由本文件的 `shutdown()` 处理，关掉会话后直接 `process.exit(0)`；会话记录写队列每 100 ms 才刷一次，刚结束那一轮的回答可能还在队列里，于是丢掉。resident 停机、崩溃重启、热切换回收子进程都会撞上。另外 SIGTERM、SIGINT 和连接关闭都会调 `shutdown()`，第二次调用会截断第一次的收尾。形态仍是**纯插入**，共四处：一行 import、建一个 `exitGate`、`shutdown()` 开头加一行守卫、`process.exit(0)` 前加一行 `await exitGate.flush()`。逻辑放在阡陌自有的 `src/services/acp/exitFlush.ts`：只有第一个触发者执行收尾；先等写队列刷完再退出；整个收尾 2 s 封顶；退出码恒为 0，因为 resident 的 `childClosed` 把非 0 当崩溃。不复用 `gracefulShutdown` 的原因：它会把 SessionEnd hooks、analytics flush 和 5 s failsafe 一起带进 ACP 子进程 | 🟢；后续部分 ✅ 书面 |
| `src/services/acp/__tests__/agent.test.ts` | `4fe8cd1e`（+`4b06f672`） | +106/−2 | 随上述 ACP 改动同步的基座既有测试 | 🟢 |

### 2.4 P3.1 常驻化改造 —— 进程内生命周期事件（4 个修改）

| 文件 | 首改提交 | +/− | 为什么不走扩展点 | 判定 |
| --- | --- | --- | --- | --- |
| `src/utils/session/sessionActivity.ts` | `4fe8cd1e`（+`fdbbc2e3`） | +20/−7 | `fdbbc2e3` **明确**：新加的两处 `activityCallback` 没走 `CLAUDE_CODE_REMOTE_SEND_KEEPALIVES` 这道基座既有闸门，开关关着也往远端发包——**修的方向是回到基座既有扩展点**。**核实补记（2026-08-16）**：另有一处此前未记录的行为差异——`stopSessionActivity` 的 `startIdleTimer()` 由基线「仅当心跳定时器在跑」放宽为「refcount 归零就调」，扩大了 `session_idle_30s` 诊断日志的触发面（诊断日志语义内，无发包），随 WebSocketTransport 行的两处差异一并**已裁定**（2026-08-17，见 §6.1 #2）：有意为之，维持现状 | ✅ 书面 |
| `src/QueryEngine.ts` | `4fe8cd1e` | +10/−2 | 新增可选配置 `onInputAccepted`，并在 transcript 落盘后 await 它（bare 模式下也强制 flush）。**核实记录（2026-08-16，逐通道排查）**：基座全部 hook 事件中唯一与输入相关的 `UserPromptSubmit` 在 `processUserInput.ts` 内触发——早于消息入 `mutableMessages`（`QueryEngine.ts:424`）与 `recordTranscript`（`:446`），且该 hook 可否决输入，报的是「按了回车」而非「已入上下文」；`sessionActivity` 只有忙闲两态不带输入身份，`Stop` 类事件只报整轮终态；唯一携带该事实的 `SDKUserMessageReplay` 要等模型开始回复才 yield（`QueryEngine.ts:741`），且 ACP 桥接把 user 消息整类丢弃（`src/services/acp/bridge/forwarding.ts:311-315` 注释原文）。**更硬的一层**：本改动同时把挂了回调时的 transcript 写入由 fire-and-forget 改为 await + 强制 flush（`:447`/`:454-456`）——「已落盘」这个事实是它造出来的，任何外部通道都无法只靠观测得到 | 🟢 代码依据（2026-08-16 核实；改动动机仍待改动人过目） |
| `src/cli/transports/WebSocketTransport.ts` | `4fe8cd1e` | +2/−2 | `registerSessionActivityCallback` 回调签名从 `() => void` 变 `(active: boolean) => void` 的**连带修改**；`if (active)` 保证**新增的闲边缘**（`activityCallback?.(false)`，消费者是 `src/services/acp/entry.ts` → `packages/resident` 的沙箱保活上报链）不被基座订阅者当成一次 keep_alive。**核实记录（2026-08-16）：原「逐字不变」的说法不成立，实际有两处 keep_alive 语义内的非逐字差异**：① 忙区间起点会**多发一帧**（新增的忙边缘 `sessionActivity.ts:103` 发 `true`，`if (active)` 拦不住；keep_alive 幂等，无害）；② `sendSessionActivitySignal()` 由无条件回调改为 `cb(refcount > 0)`（`:82`），refcount 为 0 时基座订阅者不再发帧——唯一生产触发面是 `compact.ts` 压缩心跳每 30 s 一次且恰无 API 流在飞的窗口；`sessionActivity.test.ts` 的 `manual signals report the current state` 用例把该行为钉死为**有意语义**。**已裁定（2026-08-17，见 §6.1 #2）**：有意为之，维持现状，不回改 | 🟢 已裁定：有意为之（2026-08-17，见 §6.1 #2） |
| `src/cli/transports/ccrClient.ts` | `4fe8cd1e` | +2/−2 | 同上（核实记录同 WebSocketTransport 行） | 🟢 同上 |

> **勘误**：`positioning-m0.md` §3.3 把 `src/QueryEngine.ts`、`WebSocketTransport.ts`、`ccrClient.ts` 三行的理由写作「看门狗替换」。逐 diff 复核后不成立——三者与 `FreezeAwareWatchdog` 无关，分别是输入受理回调与会话活跃度签名的连带修改。看门狗替换只涉及 §2.2 的三个文件。

### 2.5 P7.2 审计与 `occ audit`（1 个修改）

| 文件 | 首改提交 | +/− | 为什么不走扩展点 | 判定 |
| --- | --- | --- | --- | --- |
| `src/entrypoints/cli.tsx` | `4fe8cd1e`（+`11c0a622`，+ s4/p11-console 新增 `console` 分支） | +28/−0 | 四个子命令分派分支（`resident` / `audit` / `resident-wake` / `console`），各自 `await import(...)` 动态加载。**核实记录（2026-08-16）：原「基座没有子命令注册表」的说法不成立，须改写**——基座有 Commander 注册表（`src/cli/program/commands/index.tsx` 的 `registerSubcommands`，15 个模块），但它被刻意排除在 print 快速路径之外（`src/cli/program/run.tsx`：`-p`/`--print` 提前 return，之后才动态 import，注释自陈为省约 65 ms）；走它就要付 `main.tsx` 全量 bootstrap 与 root preAction。基座自己对 `migrate` / `autonomy` / `remote-control` 的做法正是**两处都写**（`cli.tsx:94` 注释原文 `Also registered in main.tsx so it appears in --help`），另有 `daemon` / `job` 等 4 组子命令只存在于字面量分支。**已收口（P11.5，2026-08-17）**：补了第二半——新增 `src/cli/program/commands/qianmo.tsx`（`registerQianmoCommands`，四个命令各一句英文描述、不复刻选项面，`action` 里动态 import 同一个 fast-path handler 模块，`process.argv.slice(3)` 透传剩余参数，正常不可达），并在 `src/cli/program/commands/index.tsx` 的 `registerSubcommands` 里加一行调用；fast-path 分支本身一行未动。四个命令现出现在 `occ --help`，`tests/integration/cli-golden.test.ts` 的 `ROOT_COMMANDS` 同步补齐。「挂成 daemon worker」仍不可行：`DAEMON_WORKER_KINDS` 是空数组、`runDaemonWorker()` 无 dispatch、未知 kind 退出码 78 被永久 parking（`src/daemon/workerRegistry.ts:16,25-34`、`daemon/main.ts:397`），且 supervisor 只发 `--daemon-worker=<kind>` 加固定 env、没有 argv 通道接 `runResident` 的 14 个选项，还会把表里每个 kind 自动起一份。**P18.7 后续改动（`7ff9820d`，+7/−0；相对快照现值 +84/−16，其间的 `ca` / `cert` / `watch` / `memory` 分支、`--version` 改用 `DISPLAY_NAME`、删去 `MACRO` 兜底不属本批，本行此前未登记）**：在 `memory` 分支之后纯插入 `provider` 分支，与其余快速路径同形（`profileCheckpoint` + 动态 import `src/cli/handlers/provider.js` 的 `runProvider` + `return`）。第六类动作的 sshd 强制命令每次只起 `qm provider serve-stdin` 这一个子命令，走 Commander 就要付 `main.tsx` 全量 bootstrap，理由同上；`--help` 条目照 P11.5 的做法加在阡陌自有的 `qianmo.tsx`，`cli-golden.test.ts` 的 `ROOT_COMMANDS` 同步（§2.13）。**P17.4 后续改动（`0ed84275`，+7/−0；与 P18.7 合并后相对快照现值 +91/−16）**：在 `provider` 分支之后纯插入一个 `args[0] === 'handoff'` 分支，与 `resident` / `console` / `memory` 同形（`profileCheckpoint` + 动态 import `cli/handlers/handoff.js`），理由同本行；`--help` 条目照 P11.5 的做法写在阡陌自有的 `qianmo.tsx`，`cli-golden.test.ts` 的 `ROOT_COMMANDS` 同步（§2.13 那一行） | 🟢 代码依据（2026-08-16 核实 + P11.5 `--help` 待办已收口；「当时是否评估过 daemon 路线」仍待改动人一句话） |

### 2.6 会话与信箱（3 个修改；前两行 P1.2 缺陷修复，第三行 P3.1 常驻化）

| 文件 | 首改提交 | +/− | 为什么不走扩展点 | 判定 |
| --- | --- | --- | --- | --- |
| `src/utils/sessionStorage/logAssembly.ts` | `fad809bc`（+`4b06f672`） | +10/−2 | **基座既有缺陷**：`findLatestMessage` 用严格 `>`，时间戳并列时锚点粘在第一条，`--resume` 静默丢尾部消息——正是 AC-1 / AC-2 最难现场诊断的失效方式。缺陷在基座代码里，修它没有「扩展点」这个选项 | ✅ 书面 |
| `src/utils/sessionStorage/transcriptLoader.ts` | `4b06f672` | +13/−4 | `loadSessionFile` 原从全局状态推项目目录，导致一次**只读查询**必须改全局会话指针；改为允许显式传入项目目录（缺省行为不变） | ✅ 书面 |
| `src/utils/agents/teammateMailbox.ts` | `4fe8cd1e` | +33/−3 | 常驻节点复用基座的**文件信箱**作为入站通道，必须能断言「我快照的这 N 条**恰好**被翻成已读」（`packages/resident/src/reader.ts` 的 `#markRead` 在 `marked !== snapshot.length` 时抛错）。原函数返回 `void`，且按 identity（`from`+`timestamp`+`text`）匹配——重复消息若在快照与翻转之间被**外部**读掉一条，原实现会去翻**后一条同内容**的消息，即把一条本节点从未处理的消息标成已读，而调用方无从察觉。改动两处：① 返回实际计数；② 收一份快照时刻的已读计数 `readBefore`，把外部已读的那条**记账**而不是另找一条来翻。**核实记录（2026-08-16）：竞态真实存在，三个前提全在代码里**——快照是**锁外**取的（`packages/resident/src/reader.ts:98-120` 经无锁的 `readMailbox`），快照与翻转之间隔着整个 ACP turn（`reader.ts:136→240`），消息身份 `[from,timestamp,text]` 不含 id、同内容不可区分；窗口内入站适配器可持锁写进同内容新消息（`packages/adapter/src/inbound.ts:264`）、同 agent 其他进程可把快照那条翻成已读，旧实现会翻错且 `reader.ts:247` 的计数断言恰好仍绿（静默失效）。新参数与新返回值全部在 `teammateMailbox.ts:575-628` 一把锁内消费。**原括注「基座导出了函数，不导出锁」表述不准**：锁的各件其实都可拿到（`getInboxPath` 与 `lockfile.lock` 均导出、`packages/` 可 import `src/`），真正堵死「调用方自己包一层锁」的是 **`proper-lockfile` 不可重入**——持锁再调本函数会撞上内部第二次 `lock()`，10 次重试后抛错 | 🟢 代码依据（2026-08-16 核实；「当时是否即此判断」待改动人一句话） |

### 2.7 基座既有测试 / 门禁修复（4 个修改；M1 另加 2 个，不计入 §1 的 32）

「扩展点」这个判据在这一类上不适用——被改的是基座**自己的**测试。判据换成「改的是不是基座自身的缺陷，或我方新增目录的接入」。

| 文件 | 首改提交 | +/− | 理由 | 判定 |
| --- | --- | --- | --- | --- |
| ~~`src/services/skillLearning/__tests__/throttleAndCircuitBreaker.test.ts`~~ | `e86d901b` | **+0/−0（已撤回）** | 基座既有 flaky：用例缺 `timeoutMs`，前序文件泄漏凭据时会真连网并超时变红。**上游 v2.46.0 自己修了同一处**（同一位置加 `setSkillLearningConfigForTest({ llm: { timeoutMs: 50 } })`），有效配置与我方逐字相同，故 P10.2 撤回我方 10 行、该文件回到与上游逐字节一致（提交 `6406af76`）。**这是同步该收的红利：携带增量减少** | ✅ 书面 |
| `src/utils/__tests__/claudemd.projectDirs.test.ts` | `6bada14c` | +6/−2 | 基座既有断言把 `readdir` 枚举顺序当成契约，CI 的 ext4 上会假红 | ✅ 书面 |
| `src/services/mcp/__tests__/configWatcher.test.ts` | `a8b06a9a` + `0e9e7c3b` + `d162fe72` | +24/−19，后续 +约40 | `a8b06a9a` 提交正文为空，按 diff 推断：三条正向用例原本「固定睡 2600 ms 再断言 `fired > 0`」，改为**等待真实的文件事件**；负向用例保留固定等待并改名 `settleForNoChange`。**该推断已于 2026-08-16 被后续排障坐实并深化**（两个后续提交的正文即书面依据）：偶发的真根因不是「节拍慢」而是 **Linux 上 `fs.watchFile` 的首个 stat 异步落地、抢在它前面的写 / 删被当成基线永不上报**（Debian 13 x86_64 实测原用例 15 跑 8 败、先等过一个轮询周期则 15/15 绿），`d162fe72` 给三条正向用例加 `settleWatcherBaseline()`；`0e9e7c3b` 顺带坐实 **bunfig `[test] timeout` 在 Bun 1.3.13 下不生效**（全仓实际预算是默认 5 s），故显式给 15 s。「事件不来就挂到用例超时」的代价条已由显式预算钉住上界。生产代码始终未动 | ✅ 书面（后续提交） |
| `src/utils/__tests__/teammateMailbox.test.ts` | `4fe8cd1e` | +28/−0 | 随 §2.6 的信箱改动新增一条用例，用例名直述该语义：`resident snapshot accounts for an externally read duplicate without marking a later one`。**核实（2026-08-16）**：用例（`:351-378`）先取含一条未读重复消息的快照，再模拟「快照那条被外部读走 + 又追加一条同内容」，断言带 `readBefore` 调用后返回 1 且盘上是 `[true, false]`——恰好钉住 §2.6 描述的竞态（旧实现会翻成 `[true, true]`） | 🟢 代码依据（随 §2.6 同一条） |
| `src/commands/share/__tests__/share-projectdir.test.ts` | `1be556c9`；后续 ACP 修复 PR 的「state mock 复位」提交 | +20/−64 | 基座测试自身的 mock 卫生缺陷。`1be556c9` 拆掉了钉死 cwd 的几项（理由见 `tests/mocks/state.ts`「NEVER override the cwd / projectRoot cluster」），但 `bootstrap/state` 的 mock 仍然没有 teardown：钉死的 `getSessionId`（`test-session-pd`）和空函数 `switchSession` 留给同一进程里后面所有的文件。整仓 `bun test` 时，后面真正切换会话的用例会把会话记录写进 `test-session-pd.jsonl`；ACP 符号链接修复的一条单测就是这样变红的，复现组合是 `bun test src/commands/share src/services/acp`。改为经 `tests/mocks/state.ts` 的 `setupStateMock()` 取 `makeSharedModuleMock` 的完整委托表面：顶层 `setup()`、`beforeAll` 里 `set()`、`afterAll` 里 `reset()`。覆盖项只留被测命令读的 `getSessionId`、`getSessionProjectDir`；原来另外 45 项是全局计数器的空实现和无害的 setter，被测命令自己不读它们，去掉后本套件照样全绿 | ✅ 书面 |
| `tests/mocks/state.ts` | `1be556c9`；后续 ACP 修复 PR 的「state mock 复位」提交 | +47/−0 | 共享 mock helper，基座测试基础设施。`1be556c9` 加了「NEVER override the cwd / projectRoot cluster」那段说明。后续纯插入一个 `setupStateMock()`，给要覆盖 `getSessionId` / `switchSession` 的套件一个能复位的表面（`makeSharedModuleMock` 的 setup / set / reset）。放在这里而不是让套件自己 `import * as realState`：后者会让 knip 把 `bootstrap/state.ts` 的全部导出都算作已用，`check:unused` 的 exports / types 计数假性下降 13 / 3 | ✅ 书面 |

**判定统计（32 个修改文件）：✅ 书面 12 / 🟢 代码依据 20 / ⚠️ 推断待确认 0**（原 11 / 14 / 7；2026-08-16 考证后 configWatcher 升 ✅，QueryEngine / cli.tsx / teammateMailbox 及其用例升 🟢；2026-08-17 会话活跃度签名两行经自主模式裁定收口，同样升 🟢——见 §6.1）。
（历史记录，五件事均已收口，见 §6.1）原七条 ⚠️ 分属**五件事**：`QueryEngine.onInputAccepted`、会话活跃度签名连带修改（2 个文件）、`cli.tsx` 子命令分派、信箱记账（2 个文件）、`configWatcher` 用例。

### 2.8 新增的 24 个文件

新增文件在上游同步中**不产生冲突**（演练实测：上游新增 261 文件 ∩ 我方新增 372 文件 = 空集，`upstream-sync-drill.md` §3.1），所以逐个论证「扩展点为何不够用」意义有限；按目录列出与归属即可。

| 目录 / 文件 | 个数 | 行数 | 归属 | 性质 |
| --- | --- | --- | --- | --- |
| `src/constants/identity.ts` | 1 | +92 | P0.3 | 身份派生层本体，零 import |
| `src/config/__tests__/identityIsolation.test.ts` / `identityProbe.runner.ts` | 2 | +268 | P0.3 | 子进程探针验证三身份隔离与并集保护 |
| `src/services/qianmo/`（全新目录：`resident.ts` 730 / `auditTrail.ts` 318 / `nodeIdentity.ts` 139 / `sandboxAudit.ts` 8 + 5 个测试/fixture） | 9 | +1,968 | P3.1(4) / P7.2(1) / P4.3(2) / P1.3(2) | 常驻节点接线、审计翻译层、节点密钥路径、沙箱审计路径。**翻译层在基座侧是刻意的**：`@qianmo/audit` 若认识各层就得依赖树里每个包，依赖方向会反过来（`auditTrail.ts` 顶部注释）。`nodeIdentity.ts` / `sandboxAudit.ts` 存在的唯一理由是**路径必须从 `src/config/paths.ts` 派生**，而 `@qianmo/*` 包刻意不持有路径约定 |
| `src/cli/handlers/`（`resident.ts` 590 / `qianmoAudit.ts` 209 / `residentWake.ts` 172 / `residentArgs.ts` 18 + 3 个测试） | 7 | +1,728 | P3.1(5) / P7.2(2) | 三个阡陌子命令的实现，被 `cli.tsx` 动态 import |
| `src/utils/network/freezeAwareWatchdog.ts` + 测试 | 2 | +324（P3.1 时 +233，P10.3② 加注入点 +91） | P3.1 / P10.3② | 时间跳跃感知的看门狗，内部用 `@qianmo/protocol` 的 `TimeJumpGate`；P10.3② 在其上加了与 `setTimeout` 同形的注入点对（见 §2.2 的整改注）——**增量落在阡陌自有文件里，正是为了把基座文件的残余 diff 压到最小** |
| `src/utils/session/__tests__/sessionActivity.test.ts` | 1 | +78 | P3.1 | 忙闲边缘与 keepalive 闸门 |
| `src/utils/sessionStorage/__tests__/logAssemblyTieBreak.test.ts` | 1 | +36 | P1.2 | `--resume` 锚点缺陷的红→绿用例 |
| `src/__tests__/queryEngineInputAdmission.test.ts` | 1 | +101 | P3.1 | 输入受理回调 |

### 2.9 M1 · P18.1 MiMo 预设止血（1 个修改）

本节不计入 §1 与 §2 标题里的「32 / 24」（那是 `da98d86f` 的 M0 口径），+/− 按 `git diff base-snapshot/v2.46.0 -- <file>` 量。设计依据是 `providers-console-m1.md` §4.6 与 §5.8 第一行。同时新增的用例 `src/utils/model/__tests__/chinaLlmProviders.mimo.test.ts` 是阡陌自有文件，不在本表。

| 文件 | 首改提交 | +/− | 为什么不走扩展点 | 判定 |
| --- | --- | --- | --- | --- |
| `src/utils/model/chinaLlmProviders.ts` | `6c068da9`（2026-10-03，P18.1） | +10/−18 | **形态：值替换**（章程 §7.2 第 7 条）。只动 MiMo 段的数据：默认模型与 sonnet/opus/fable 档 `mimo-v2.5-pro` → `mimo-v2.6-pro`，haiku 档 `mimo-v2-flash` → `mimo-v2.6-flash`，模型表两条换 id 与 label（第二条的 tag `Multimodal` → `Fast`），`freeTier` 文案里的 id 同步换掉；`mimo-v2-flash` 那条没有一对一后继，整条删去（占 −18 里的 −8）。类型、函数和其余三家预设一字未动。**为什么改基座**：基座 `/provider` 向导（`ConsoleOAuthFlow.tsx` 的 `china_apikey` 步）把这张静态表的 `defaultModel`、`tiers`、`models` 原样写进 `OPENAI_MODEL` / `OPENAI_DEFAULT_*_MODEL`，没有覆盖层；阡陌的模型目录只服务控制台，管不到基座向导的用户。小米 `mimo-v2-flash` 已于 2026-06-30 下线，`mimo-v2.5-pro`、`mimo-v2.5` 于 2026-10-21 10:00（北京时间）下线且没有系统替换（`https://mimo.mi.com/static/docs/updates/deprecate.md`，2026-10-03 取页），不改的话，10-21 之后选 MiMo 的第一个请求就失败。**上游同步时**：上游若也改了这一段，取 id 更新的一侧，再跑 `chinaLlmProviders.mimo.test.ts` | ✅ 书面 |

### 2.10 M1 · P18.5 调用层第一批 · 止血（7 个修改，另有 2 个在册文件的后续改动补在原行）

依据设计 `providers-console-m1.md` §5.8（每个基座文件「改什么、为什么扩展点不够、目标形态」）。规则表一律落在阡陌自有的新文件里（见本节末），基座文件只留调用点。+/− 为 `git diff base-snapshot/v2.46.0 -- <file>` 的现值；P18.5 之前已有改动、本文此前未登记的两处，在括号里分开写，不归到 P18.5 名下。

| 文件 | 首改提交 | +/− | 为什么不走扩展点 | 判定 |
| --- | --- | --- | --- | --- |
| `src/utils/model/modelSupportOverrides.ts` | `610f76fd`（Q-2） | +56/−1 | 档位表是模块内常量，`get3PModelCapabilityOverride` 是唯一入口，没有注册点；基座自己的 `PROFILE_ENV_KEYS` 写了 FABLE 档与 `GEMINI_` / `GROK_` 前缀的键却没人读。改法只有常量表插入条目（`ANTHROPIC_TIERS` / `OPENAI_TIERS` 各加 FABLE 档，新增 `GEMINI_TIERS` / `GROK_TIERS`）与选档三元式按 provider 插两支 | ✅ 书面（设计 §5.8 + 提交正文） |
| `src/services/api/openai/index.ts` | `8530028d`（Q-1）；后续 `b6041a5f`（#5）、`f6295347`（#3）、`c3d3061e`（#12b）、`55760a88`（#12c） | +74/−32（P18.5 +55/−24；其余 +19/−8 是 P18.5 之前的改动，本文此前未登记） | chat 线 effort 门控、输出上限、cache-key 回退都内联在请求组装里，没有钩子。四处：① 门控谓词 `isChatGPTCodexReasoningModel` 换成 `chatLaneSendsReasoningEffort`（`modelCompat/chatEffort.ts`）；② `resolveOpenAIMaxTokens` 换成 `resolveOpenAIRequestMaxTokens`（`modelCompat/outputTokenDefault.ts`），`maxTokens` 由 `const` 改 `let`，给重试循环插入 `recoverOutputCap` 回调；③ `createChatStreamWithCacheKeyFallback` 的 try/catch 换成一次 `sendDroppingRejectedParameters` 调用（`modelCompat/unsupportedParam.ts`），`prompt_cache_key` 的判据与锁存原样；④ 名单插入 `TEMPERATURE_DROPPABLE` | ✅ 书面（设计 §5.8 + 各提交正文） |
| `src/services/api/openai/wireProtocol.ts` | `5067ba82`（#22） | +8/−0 | `resolveOpenAIWireProtocol` 是唯一的选线函数。在显式 `OPENAI_WIRE_API` 与 ChatGPT 订阅判断之后纯插入一次查表（`modelCompat/wireHosts.ts`），显式值仍然优先 | ✅ 书面 |
| `src/services/api/openai/requestBody.ts` | `5cd8d785`（#11）；后续 `f6295347`（#3）、`24b6a76e`（#12a） | +17/−9 | 请求体由一个函数组装，键名与 temperature 的取舍没有钩子。三处：① `useMaxCompletionTokens` 的谓词换成 `usesMaxCompletionTokens`（`modelCompat/outputTokenParam.ts`）；② 参数 `maxTokens` 改为可选，`undefined` 时不发；③ temperature 分支插入 `omitsSamplingTemperature`（`modelCompat/samplingParams.ts`）。**P18.8 后续改动（`4438b0b4` hermes #4、`3749187e` hermes #14，+23/−2，相对快照现值 +40/−11；形态：标识符替换 + 文件末尾插入包装）**：① 返回对象的 `messages` 换成一次 `applyReasoningReplayPolicy(messages, { model, baseURL })` 调用（`modelCompat/reasoningEcho.ts`；#10 的 Gemini 签名回放在同一遍里，`thoughtSignatureReplay.ts`）；② 原函数改名为模块内的 `buildGenericOpenAIRequestBody`，函数体与对象字面量逐字不变，文件末尾插入同名导出包装，对结果调用一次 `applyChatVendorReasoning`（`modelCompat/effortVendors.ts`）。**不是纯插入**：厂商表要先清掉通用体的全部推理键再写自己的键，在字面量里做不到「先删后写」；直接在 `return {…}` 外面包一层调用会让整段约 60 行重缩进。改名之后导出名与签名不变，调用方零改动 | ✅ 书面 |
| `src/services/api/errors.ts` | `420f6711`（#6） | +5/−0 | 溢出正则与 `isContextOverflowErrorText` 是常量加函数，「限流 → 参数校验 → 输出上限 → 溢出」的顺序只能在函数入口插入。入口插入一次 `overflowTextVerdict`（`modelCompat/overflowText.ts`，输出上限一支在 `outputCap.ts`），基座正则兜底不变 | ✅ 书面 |
| `src/services/api/streamAssembly.ts` | `b6041a5f`（#5） | +61/−3（P18.5 +29/−0；其余 +32/−3 是 P18.5 之前的改动，本文此前未登记） | `retryThirdPartyEventStream` 是第三方线路唯一的重试循环，「缩小上限重发一次」必须走它的 commitment 屏障（#29）。纯插入：一个可选回调参数 `recoverOutputCap`、一个标志位、catch 入口一段判断（只在 commitment 为 `none`、错误可重放时问一次） | ✅ 书面 |
| `src/services/api/retryClassification.ts` | `ed338613`（#15） | +7/−0 | 分类管线是有序的 if 链，没有注册点。在读 `x-should-retry` 之前纯插入一次 `isQuotaExhaustedError`（`modelCompat/errorText.ts`），命中即 `billing_error`、不重试 | ✅ 书面 |

**在册文件的后续改动**（按 §6.3 第 1 条补进原行，不新开行）：`src/services/api/openai/responsesAdapter.ts`（§2.2）与 `packages/@ant/model-provider/src/shared/openaiStreamAdapter.ts`（§5.1）。

**同批新增的阡陌自有文件**（快照之外，带 AGPL 头）：`src/services/qianmo/modelCompat/` 下 11 个源文件（`capabilities.ts`、`chatEffort.ts`、`wireHosts.ts`、`outputTokenParam.ts`、`outputTokenDefault.ts`、`overflowText.ts`、`outputCap.ts`、`errorText.ts`、`errorMessages.ts`、`samplingParams.ts`、`unsupportedParam.ts`）与 13 个测试文件（含录制桩 `__tests__/support/requestCapture.ts` 与逐厂商请求体对等表 `__tests__/requestParity.test.ts`），`packages/@ant/model-provider/src/shared/qianmo/toolCallDeltas.ts` 及其测试。依据 hermes-agent 整理规则的文件与许可声明见 `NOTICE` 五。

### 2.11 M1 · P18.8 调用层第二批 · 推理一致性（5 个修改、2 个删除，另有 3 个在册文件的后续改动补在原行）

依据设计 `providers-console-m1.md` §5.4、§5.6、§5.8。规则表落在阡陌自有的新文件里（见本节末），基座文件只留调用点。+/− 为 `git diff base-snapshot/v2.46.0 -- <file>` 的现值；下表七个文件此前都没改过，现值就是本批的量。

| 文件 | 首改提交 | +/− | 为什么不走扩展点 | 判定 |
| --- | --- | --- | --- | --- |
| `packages/@ant/model-provider/src/shared/openaiConvertMessages.ts` | `d868176e`（#23）；后续 `7f084b24`（#10） | +9/−0 | 消息转换是唯一把 tool_use 块变成 tool call、把推理条目带进下一轮的地方，没有钩子。纯插入两处：① `OpenAIReasoningItem` 类型加可选字段 `issuer`（#23 签发方印记，回放时滤掉、从不上线）；② tool_use → tool call 的对象里插入一次 `carriedToolCallSignature(tu)` 展开（`shared/qianmo/geminiToolSignature.ts`），签名挂在注册 symbol 键上，JSON 序列化看不见，只有 chat 线发送边界按目标模型决定写不写成 `extra_content` | ✅ 书面 |
| `packages/@ant/model-provider/src/shared/openaiUsage.ts` | `fc6edcb1`（#26） | +13/−0 | usage 归一就是这几个导出函数，没有注册点。纯插入：`AnthropicUsage` 加可选字段 `reasoning_tokens`；`readOpenAICachedTokens` 的候选表在 OpenAI 写法之后插入顶层 `cache_read_input_tokens`；`normalizeOpenAIUsage` 加可选参数 `reasoningTokens` 与一处条件展开（没报时返回对象逐键不变） | ✅ 书面 |
| `src/services/api/grok/reasoning.ts` | `893426a1`（#13） | +14/−17 | 允许名单与夹取都是模块内函数，没有注入点。允许名单判断换成一次 `grokAcceptsReasoningEffort` 调用，夹取的 `switch` 换成一次 `resolveGrokEffort` 调用（`modelCompat/effortVendors.ts`），文件头插入一段说明。**形态：调用替换并删除被取代的分支**，不是纯插入：两处调用替换之后原 `switch` 与局部类型没有别的用处，留着就是两套规则，所以删去；返回类型随表放宽（`providers/effective.ts` 的 `wireEffortLevel`，原名 `asLevel`，本就接受全集）。grok-3-mini 的两档梯子在表里原样保留 | ✅ 书面 |
| `src/services/api/openai/__tests__/responsesAdapter.test.ts` | `d868176e`（#23） | +7/−1 | 随 #23 同步的基座既有用例：「captures reasoning items from output_item.done」的期望值加一个 `issuer: expect.any(String)`（捕获时盖印）。其余断言不变 | 🟢 |
| `src/services/providerRegistry/providerCompatMatrix.ts` | 删除于 `46a3f2ec`（R-14） | +0/−179（整文件删除） | **形态：整文件删除**。不是扩展点不够，是两套规则不能并存（设计 R-14、§5.8）：这套 compat 档案（`applyCompatRule`）在生产请求路径零调用方（M0 缺口 G-2），只按历史里有没有 thinking 块判定；P18.8 的发送边界回放策略（`modelCompat/reasoningEcho.ts`）按目标端点判定，取代了它。剩下的三个调用方都是阡陌自有文件（`tests/integration/provider-adapter-consistency.test.ts`、`tests/integration/qianmo-memory-recall.test.ts`、`scripts/qianmo-recall-answer-live.ts`），同一提交里改为直接发 `buildOpenAIRequestBody` 的结果；M0 AC-5 的「严格 OpenAI 端点收不到 `reasoning_content`」改走真实请求路径断言，用例名带「M0 AC-5」。`types.ts` 的 `compatRule` 字段保留（见下一行）。**上游同步时**：上游若改了本文件，确认 `applyCompatRule` 仍无生产调用方后维持删除 | ✅ 书面（设计 §5.8 + 提交正文） |
| `src/services/providerRegistry/__tests__/providerCompatMatrix.test.ts` | 删除于 `46a3f2ec`（R-14） | +0/−204（整文件删除） | 随被测文件删除 | 🟢 |
| `src/services/providerRegistry/types.ts` | `4ce8cd3e`（R-14 跟进） | +4/−3 | 随上一行的删除收尾，不是扩展点问题。**形态：删除一个 `export` 关键字 + 两处注释改写**：`CompatRuleSchema` 原先只因被删文件引用 `CompatRule` 才算有人用，删后成了无人导入的导出，unused 棘轮 exports 1240 → 1241，按棘轮的要求收回为模块内常量（`ProviderConfigSchema` 仍在本文件里用它）；文件头与 `ProviderConfigSchema` 说明里指向已删文件的两处注释改为「配置里的标签」。`compatRule` 字段与枚举值不动：用户的 `providers.json` 与 `loader.ts` 内置条目仍写它，删字段会让既有配置校验失败 | ✅ 书面 |

**在册文件的后续改动**（按 §6.3 第 1 条补进原行，不新开行）：`src/services/api/openai/requestBody.ts`（§2.10）、`src/services/api/openai/responsesAdapter.ts`（§2.2）、`packages/@ant/model-provider/src/shared/openaiStreamAdapter.ts`（§5.1）。

**同批新增的阡陌自有文件**（快照之外，带 AGPL 头）：`src/services/qianmo/modelCompat/` 下 6 个源文件（`targetMatch.ts`、`reasoningEcho.ts`、`responsesIssuer.ts`、`thoughtSignatureReplay.ts`、`effortVendors.ts`、`responsesUsage.ts`）与 7 个测试文件；`packages/@ant/model-provider/src/shared/qianmo/` 下 4 个源文件（`reasoningStream.ts`、`thinkTags.ts`、`geminiToolSignature.ts`、`usageFields.ts`）与 4 个测试文件。P18.5 的自有文件 `capabilities.ts`、`chatEffort.ts`、`toolCallDeltas.ts`、`requestParity.test.ts`、`support/requestCapture.ts`、`chatEffort.test.ts` 有后续改动。依据 hermes-agent 整理规则的文件与许可声明见 `NOTICE` 五。

### 2.12 M1 · P17.4 接力本地命令（无新增行；4 个在册文件的后续改动补在原行）

依据 `handoff-p17-plan.md` P17.4 卡与 `handoff-m1.md` v1.1。`src/config/paths.ts`（§2.1）、`src/entrypoints/cli.tsx`（§2.5）、`package.json`（§5.2）、`tests/integration/cli-golden.test.ts`（§2.13）已在册，后续改动按 §6.3 第 1 条补进各自原行。`cli-golden.test.ts` 在本 PR 里原先单独成行，P18.7 同期也登记了它、先合入 main；合并时以 main 为准只留 §2.13 那一行，P17.4 插入的 `'handoff'` 补在那一行里。

**同批新增的阡陌自有文件**（快照之外，带 AGPL 头）：`src/cli/handlers/` 下 `handoff.ts`、`handoffStore.ts`、`handoffTranscript.ts`、`handoffHub.ts`、`handoffSync.ts`、`handoffNow.ts`、`consoleHandoff.ts`，各自的测试与 `__tests__/support/handoffSamples.ts`，`src/config/__tests__/qmcodeHome.test.ts`，`tests/integration/qianmo-handoff.test.ts`；`packages/console/src/routes/handoff.ts`。已在册的阡陌自有文件（`console.ts`、`consoleArgs.ts`、`qianmo.tsx`、`packages/*`）的改动不属本文范围。

### 2.13 M1 · P18.7 节点侧 `qm provider`（2 个修改，另有 1 个在册文件的后续改动补在原行）

依据设计 `providers-console-m1.md` §2.5、§7.5。+/− 为 `git diff base-snapshot/v2.46.0 -- <file>` 的现值；本批只占其中括号里的那部分。

| 文件 | 首改提交 | +/− | 为什么不走扩展点 | 判定 |
| --- | --- | --- | --- | --- |
| `src/utils/process/subprocessEnv.ts` | `ef72d2c7`（P18.7） | +7/−0 | **形态：常量表纯插入**。`GHA_SUBPROCESS_SCRUB` 在 `ANTHROPIC_CUSTOM_HEADERS` 之后插入一行注释与 `OPENAI_API_KEY`、`GEMINI_API_KEY`、`GROK_API_KEY`、`XAI_API_KEY`、`OPENCODE_API_KEY` 五项。名单是模块内常量，`subprocessEnv()` 是 Shell / Bash 快照、hook、MCP stdio、LSP 子进程共用的出口，名单没有注入点。基座只列了 Anthropic 系的密钥，托管节点的 ACP 子进程打开 `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` 之后，别家线路的 key 仍会原样进 Bash（设计 §7.5）。用例：`src/utils/process/__tests__/subprocessEnv.test.ts`（逐项清除、开关关时不变）与 `src/services/qianmo/__tests__/residentAcpEnv.integration.test.ts`（真 `--acp` 子进程里跑 Bash，读不到 `OPENAI_API_KEY`；去掉这五行它就读到）| ✅ 书面 |
| `tests/integration/cli-golden.test.ts` | P11.5 `31dcf795` 起；本批 `7ff9820d`；P17.4 `0ed84275` | +30/−1（P18.7 +1/−0；P17.4 +1/−0；其余是 P11.5、`watch`、`ca`、`cert`、`memory` 各子命令进 `--help` 时补的 `ROOT_COMMANDS` 与 #81 的 defines 注入，本文此前未登记） | 随 §2.5 `cli.tsx` 行同步的基座既有测试：`ROOT_COMMANDS` 按字母序插入 `'provider'`；P17.4 同样插入 `'handoff'`（§2.12）。用例逐字比对 `--help` 列出的顶层命令，不加就红 | 🟢 |

**在册文件的后续改动**（按 §6.3 第 1 条补进原行，不新开行）：`src/entrypoints/cli.tsx`（§2.5，`provider` 快速路径，+7/−0）。

**同批新增或改动的阡陌自有文件**（快照之外，带 AGPL 头）：`src/cli/handlers/` 下 `provider.ts`、`providerOps.ts`、`providerProbe.ts`、`providerCall.ts`、`providerAutocompact.ts` 与 5 个测试文件、2 个测试支撑（`__tests__/providerStub.ts` 录制桩、`__tests__/providerSource.ts` 从源码起 CLI）；`src/services/qianmo/providers/effectiveProcess.ts` 及其测试；`src/services/qianmo/providers/effective.ts`（chat 线 effort 改问 `resolveChatReasoningEffort`；D-9 报回 `autoCompactWindow` / `autoCompactSource`）；`packages/providers/src/protocol.ts` 与 `errors.ts`（`EffectiveState` 加上面两项、`effortLevel` 可为线上的 `none`；第五个 op `autocompact`；错误码加 `env-override`）；`src/services/qianmo/residentAcpEnv.ts`（托管节点剥离 provider 键并打开子进程清理；未托管节点逐字节不变）及其两个测试；`src/cli/program/commands/qianmo.tsx`（`provider` 帮助条目）。

**只 import、未改动的基座文件**：`qm provider autocompact`（D-9）直接调用 `src/commands/autocompact/autocompact.ts` 的 `applyAutoCompactWindow` 与 `formatAutoCompactWindowStatus`，取值解析、`CLAUDE_CODE_AUTO_COMPACT_WINDOW` 已设时的拒绝、写 `userSettings.autoCompactWindow` 与回显文字都是基座原样；`effective` 的生效值与来源取自 `src/services/compact/autoCompactWindow.ts` 的 `resolveActiveAutoCompactWindow`。两个文件都没有改。

### 2.14 M1 · P18.20 ACP 会话里的本地命令（无新增行，2 个在册文件的后续改动补在原行）

依据设计 `providers-console-m1.md` §0.1 D-9 与 §9.2 P18.20 行。本节不计入 §1 与 §2 标题里的「32 / 24」。

- **改动前的实况**（真 `--acp` 子进程，2026-10-03 实测）：ACP 会话本来就执行斜杠命令。`QueryEngine.submitMessage` 的 `processUserInput` → `processSlashCommand` 对会话命令表（未过滤的 `getCommands(cwd)`）里的任何命令生效，`/autocompact 150k` 写入设置并回显，模型请求为 0。所以**没有新增执行路径**，只补两件：`available_commands_update` 通告白名单内的本地命令；每轮开始时按需重读设置并解除 `/autocompact` 对会话值的钉住，让任一途径改的 `autoCompactWindow` 在运行中的会话下一轮生效。
- **在册文件的后续改动**（按 §6.3 第 1 条补进原行）：`src/services/acp/agent/AcpAgent.ts`、`src/services/acp/agent/promptFlow.ts`（§2.3），各一处纯插入。
- **同批新增的阡陌自有文件**（快照之外，带 AGPL 头）：`src/services/acp/agent/localCommands.ts`（白名单 `ACP_LOCAL_COMMANDS`、通告条目、`refreshAcpTurnSettings`），用例 `src/services/acp/agent/__tests__/localCommands.test.ts` 与 `tests/integration/qianmo-acp-local-commands.test.ts`。
- **上游同步时**：上游若也把 local 命令放进通告，删掉 `AcpAgent.ts` 的那一行，否则重复通告；上游若在 ACP 里启动设置变更检测器，`refreshAcpTurnSettings` 里重置缓存的一半可以去掉，解除钉住的一半仍然需要。
- **控制台对话页那一段不改基座**：对话页的消息经 resident 组装成 `<teammate-message>`（`src/services/qianmo/residentPrompt.ts`）再交给 ACP 子进程，不以 `/` 开头，走不到上面的路径。打通它的改动全在阡陌自有文件里：控制台按 `^/(autocompact|compact|context)(\s|$)` 认出命令、查角色、记账本，信封 payload 另带 `command: { name }`（`packages/console/src/routes/chat.ts`、`src/cli/handlers/consoleChat.ts`）；resident 只对「验签通过、签名名在 `--local-commands-from` 里、带标记、原文就是那条命令」的 `task.request` 把原文直接交给 ACP 子进程（`src/services/qianmo/residentLocalCommand.ts`、`resident.ts` 的 `#assemblePrompt`），其余照旧包装。

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
| 2 · 改薄 `CLAUDE.md` / `README.md` | 不在本文范围（根目录文档，非 `src/`；见演练 §3.1 前两行）。**P10.3① 已落地** |
| 3 · 把 `FreezeAwareWatchdog` 类替换抽成注入点 | **§2.2 全部三行**。**P10.3② 已落地**（见 §2.2 的整改注） |
| 4 · 拆分 `unused-budget.json` | **§5.3** 的 `scripts/unused-budget.json`。**P10.3③ 已落地**（`14f8ead9`：基线回到基座原数字 + 阡陌增量另存） |
| 5 · 把 ACP 常驻会话逻辑收进 `@qianmo/resident` | **§2.3 全部八行**（尤其 `entry.ts` 的 +15/−0） |
| 6 · 「先找上游现成的间接层」成文规则 | **§2.1 / §3.2**（正面样板） |

---

## 5. `packages/` 与根配置的改动

实跑：`git diff 3380c88..da98d86f --stat -- packages/ package.json knip.json .gitignore .github`。

### 5.1 `packages/`：253 文件 / +41,962 / −1，其中**修改只有 1 个**

新增 252 个文件中，**251 个属于 17 个 `@qianmo/*` workspace 包**（包清单见 `positioning-m0.md` §3.2），剩下 1 个是基座既有包里新加的测试 `packages/@ant/model-provider/src/shared/__tests__/emptyReasoningChurn.test.ts`（下表那处修复的四条覆盖用例）。**基座既有 `packages/*` 被修改的文件只有一个**：

| 文件 | 提交 | +/− | 为什么不走扩展点 | 判定 |
| --- | --- | --- | --- | --- |
| `packages/@ant/model-provider/src/shared/openaiStreamAdapter.ts` | `8f4c13c8`（2026-08-12，P1.4） | +16/−1 | **提交信息末段直接作答**：「改的是基座核心（流适配器），按 `CLAUDE.md` §2.3 说明：这是流式解析内部的判断，没有任何扩展点能在不 fork 整个适配器的前提下改它」。改动本身很窄——空 `reasoning_content` **且正文已在流动**时忽略它；DeepSeek 的「正文前空串」契约不动。真机实测：修前 qwen3.8-max 一条两点问答产出 251 块（126 thinking，125 个是空的），修后 2 块。**P18.5 后续改动（`0ffa45f8`，hermes #9，+82/−66；相对快照现值 +159/−68，本行 +16/−1 是 P1.4 当时的数）**：原内联的 tool_use 发射代码挪进局部生成器 `emitToolCallSteps`，逐行不变，只是槽位、id、名字改从 `shared/qianmo/toolCallDeltas.ts` 的步骤里取；在 finish_reason 与「以 usage 收尾」两处各纯插入一次 flush。理由同上：流解析是单个状态机，没有插件点。**P18.8 后续改动（`c0f8ce26` #7、`a13f11fb` #8、`7f084b24` #10、`fc6edcb1` #26，+21/−2，相对快照现值 +180/−70）**：① 主循环的数据源 `stream` 换成一次 `normalizeReasoningChunks(stream)` 调用（`shared/qianmo/reasoningStream.ts`、`thinkTags.ts`：`delta.reasoning` / `reasoning_details` 归一到 `reasoning_content`，正文内联的 `<think>` 等标签切成推理）；② tool_use 的 `content_block_start` 对象插入一行条件展开，带出 `_geminiThoughtSignature`（`geminiToolSignature.ts`）；③ usage 分支插入 `reasoning_tokens` 读取，非 OpenAI 官方端点的缓存写入由字面量 `0` 换成一次 `readAnthropicStyleCacheWriteTokens` 调用（`usageFields.ts`）。理由同上 | ✅ 书面 |

> M1 · P18.8 又改了两个基座 `packages/` 文件（`openaiConvertMessages.ts`、`openaiUsage.ts`），按批登记在 §2.11，本节标题的「1 个」仍是 M0 口径。

> 该文件同时是同步演练中的冲突文件之一（`upstream-sync-drill.md` §3.1，归因族「其他 / provider 兼容修复」）。

### 5.2 根配置：6 文件 / +66 / −146

| 文件 | +/− | 改了什么 |
| --- | --- | --- |
| `.github/workflows/publish-npm.yml` | 删除（−135） | **整份移除**——本仓库不发布 npm 包、不打 tag、不跑基座 release 流程（章程 N-13/N-14，roadmap P0.4） |
| `.github/workflows/ci.yml` | +13/−6 | 两处 `bun-version: latest` → `bun-version-file: .tool-versions`（CI 不得静默跟随上游 Bun 发版，会威胁 P8.1 的「全新机器 30 min 复现」）；随 `publish-npm.yml` 删除同步改掉两处注释里的交叉引用 |
| `.github/pull_request_template.md` | +14/−3 | 新增必填项「**本 PR 修复的边界问题对应哪条用例**」（P0.4 为 AC-8 流程约束预埋）；自查清单补 `bun run verify`、一件事一个提交、走 PR 不直推 |
| `package.json` | +23/−1 | 新增 17 条 `@qianmo/*` workspace 依赖；新增 script `verify` / `verify:p32` / `sbom`；新增两个 MCP server 依赖（P6.3 兼容子集核验用）。**`release` script 与其余基座发布面原样保留、不触发**。**P17.4 后续改动（`97256e34`，+1/−0；相对快照现值 +58/−21）**：纯插入 `"@qianmo/handoff": "workspace:*"`（P17 裁定 1：根包直接依赖 workspace 包），`bun.lock` 随之多一行 |
| `knip.json` | +12/−1 | 两个 MCP server 加进 `ignoreDependencies`；`demo/lib/*.ts` 的 9 个入口加进 entry 列表（否则被判「未使用文件」） |
| `.gitignore` | +4/−0 | 忽略 `.demo-env/`——演示环境运行态（密钥、节点配置根、日志、工作区），由 `demo/env/seed.sh` 生成，永不入库 |

### 5.3 附：`scripts/` 里被修改的两个基座文件

不在上一条的统计命令内，但属同一类改动，列在这里以免遗漏（`git diff 3380c88..da98d86f --stat -- scripts/`：12 文件 / +4,222 / −7，其余 10 个为新增）。

| 文件 | +/− | 改了什么 |
| --- | --- | --- |
| `scripts/test-shards.sh` | +37/−6 | ① 分片名单加入 `tests/boundary`、`demo/lib` 与 `demo/env`——不在这个循环里的测试目录**在 CI 里根本不跑**，而本地 `bun test` 会跑，那种「本地绿 + CI 绿」的第二个绿毫无意义。`demo/env` 那四套（beta-wake-psk / beta-retain / ops/mirror-pull / resident-task-policy）跑的是真运维 shell 脚本，最该在 Linux 上跑，却直到 S14 才进这份名单；写成字面量而不是 `demo/env/*`，因为用例横跨该目录本身与 `beta/`、`beta/ops/` 两层子目录，而 `bun test <dir>` 本来就递归；② `@qianmo/*` 包的分片加 `--isolate`（每个测试文件一份全新 global，把跨文件 mock/env 洁净度变成结构保证），**基座分片保持原样**——把 700 个基座文件翻成 `--isolate` 是未经度量的风险且平白制造基座漂移；③ 随 `publish-npm.yml` 删除改掉注释里的交叉引用 |
| `scripts/unused-budget.json` | +1/−1 | `exports` 棘轮 1255 → 1251。**每次上游同步必然冲突的那个数字**，对策见 §4 |

---

## 6. 待办与维护规矩

### 6.1 待改动人确认的 7 行（分属 5 件事）——2026-08-16 考证后的状态

章程 T-5 对策④ 要求「扩展点为何不够用」写在 PR 描述里。下列各行的这句话是 P9.3 **按代码推断**补出的，需要原改动人确认或改写：

| # | 事项 | 涉及文件 | 请确认什么 |
| --- | --- | --- | --- |
| 1 | `QueryEngine.onInputAccepted` | `src/QueryEngine.ts` | ~~是否确实没有 hook / 事件能拿到「输入已入上下文」这一刻？~~ **已核实：确实没有**（逐通道排查记录在 §2 对应行；且该事实是本改动**造出来**的，观测不到）。剩「改动动机」一句话过目 |
| 2 | 会话活跃度签名连带修改 | `src/cli/transports/WebSocketTransport.ts`、`src/cli/transports/ccrClient.ts` | **核实推翻了「逐字不变」**：忙边缘多一帧、`sendSessionActivitySignal()` 在 refcount 0 时不再发帧（另有 idle 计时器触发面扩大一处，见 §2.4 首行）。三处差异均在 keep_alive / 诊断语义内且有测试钉死。~~请裁定：有意为之（维持现状）还是漏看（需回改）？~~ **已裁定（2026-08-17，自主模式下按测试钉死的语义裁定）：有意为之，维持现状，不回改；依据 `src/utils/session/__tests__/sessionActivity.test.ts:60-80`（`manual signals report the current state` 用例——`:67` 在 refcount 为 0 的空闲态调用 `sendSessionActivitySignal()`，`:72` 断言其回调收到的首个值是 `[false]`，把 `cb(refcount > 0)`（`sessionActivity.ts:82`）钉为有意语义：空闲时发 keep_alive 帧才是谎报状态）。另两处不构成回改理由：忙边缘多发一帧 keep_alive 幂等无害；idle 计时器触发面扩大只影响 `session_idle_30s` 诊断日志、无发包 |
| 3 | 子命令分派 | `src/entrypoints/cli.tsx`、`src/cli/program/commands/qianmo.tsx`（新增）、`src/cli/program/commands/index.tsx` | ~~基座确实没有注册表？daemon 分派可复用？~~ **已核实**：Commander 注册表存在但被排除在 print 快速路径外、基座自己就双写；daemon worker 路线四条硬伤坐实不可行（§2 对应行）。**已定夺（P11.5，2026-08-17）**：补第二半——照基座 migrate/remote-control 的先例（`cli.tsx:94` 附近 `Also registered in main.tsx so it appears in --help` 注释）新增 `src/cli/program/commands/qianmo.tsx`（`registerQianmoCommands`，四个命令各一行英文描述，选项面不复刻，`action` 兜底动态 import 同一个 fast-path handler 模块并透传 `process.argv.slice(3)`，正常不可达），`index.tsx` 的 `registerSubcommands` 加一行调用；`cli.tsx` 的 fast-path 分支一行未动。代价只是 `commands/` barrel 里四个 `.command()` 声明——该 barrel 本就只在非 print 路径动态加载（`run.tsx`），不额外引入 bootstrap 开销，先前「付 `main.tsx` 全量 bootstrap 的代价」的说法不成立。四个命令现出现在 `occ --help`，`tests/integration/cli-golden.test.ts` 的 `ROOT_COMMANDS` 同步补齐 |
| 4 | 信箱记账 | `src/utils/agents/teammateMailbox.ts`、`src/utils/__tests__/teammateMailbox.test.ts` | ~~锁内核对的理由是否成立？~~ **已核实：竞态真实、锁内消费无一步在外、新用例恰好钉住它**；原括注「不导出锁」改为「`proper-lockfile` 不可重入」（§2 对应行）。剩「当时是否即此判断」一句话过目 |
| 5 | ~~`configWatcher` 用例~~ | `src/services/mcp/__tests__/configWatcher.test.ts` | **已闭环（2026-08-16）**：动机被 CI run `31904161135` / `31939084748` / `31939787564` 的失败形态证实；真根因（首个 stat 之前的改动被当基线）考证与修法见 `0e9e7c3b` / `d162fe72` 的提交正文，代价由显式 15 s 预算钉住。该行判定已升为 ✅ 书面 |

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
