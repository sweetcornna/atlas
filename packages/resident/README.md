<!-- Copyright 2026 Qianmo AgentNest Team -->
<!-- SPDX-License-Identifier: MIT -->

# @qianmo/resident —— 常驻 ACP 宿主的读者、账本与闸门

**一句话定位**：给 ACP 宿主补上一个**在空闲时也会醒来的信箱读者**，并让「检测到 → 输入被受理 → 翻转 read → 一个 turn 打完」这四步落在一本可崩溃恢复的账本上；外加节点级 turn 串行、解冻感知的截止时钟、以及向宿主上报忙闲的活动通道。

| 项 | 指针 |
| --- | --- |
| 任务包 | roadmap **P3.1**（休眠与唤醒）；网络任务改为逐条 ACP turn、durable read 后发 ack 由 **P4.1** 补入 |
| 章程条目 | charter **§3.2 R-3**（休眠与唤醒，基座起点：部分，v2.7 定案） |
| 协议真源 | `protocol.md` §4.5（ack 由谁发出）、§5.3（时间跳跃闸门 T-2）、§4.6（`task.result` 契约） |
| 完成状态 | roadmap「完成状态速查」P3.1 行 |

## 1. 模块架构图

```mermaid
flowchart TD
  poller["poller.ts · ResidentPoller<br/>从完成处重排，不补跑漏掉的 tick"]
  runtime["runtime.ts · ResidentNodeRuntime<br/>按 to 的 agent 段分发；每 agent 一个 reader"]
  gate["turn-gate.ts · NodeTurnGate<br/>跨会话按到达顺序串行"]
  reader["reader.ts · ResidentMailboxReader<br/>#poll → 恢复 pending → 读信箱 → 记 detected<br/>→ submit turn → onAccepted 时 markAdmitted + markRead"]
  ledger["ledger.ts · FileAdmissionLedger<br/>NDJSON · 0700/0600 · fsync · 有界压实"]
  contracts["contracts.ts（端口）<br/>ResidentMailboxPort · ResidentTurnPort<br/>AdmissionLedger · 三相记录类型"]
  identity["mailbox-identity.ts<br/>from / timestamp / text 三元组计数"]
  timings["timings.ts · ResidentTimingRecorder<br/>detected/admitted/read/first_content/turn_completed"]
  deadline["deadline-clock.ts · ResidentDeadlineClock<br/>nowFor(createdAt) 扣掉冻结重叠段"]

  turnport["acp-turn.ts · AcpResidentTurnPort<br/>isAccepted / execute<br/>qianmo/input-status · input-accepted · session-activity"]
  client["acp-client.ts · ResidentAcpConnection<br/>ClientSideConnection + ndJsonStream"]
  sessions["sessions.ts · ResidentSessionManager<br/>首次 newSession，重启后 resumeSession"]
  store["session-store.ts · FileResidentSessionStore<br/>原子落盘、损坏即 fail closed"]
  supervisor["supervisor.ts · ResidentSupervisor<br/>指数退避重启 · 快速连挂即 parking"]
  activity["activity.ts · ResidentActivityReporter<br/>busy/idle 经 transport 报给宿主 keepalive"]

  acp["ACP 子进程（occ --acp）"]
  host["宿主：@qianmo/activator 的 ResidentActivityController"]

  poller --> runtime
  runtime --> reader
  runtime --> gate
  reader --> gate
  reader --> ledger
  reader --> identity
  reader --> timings
  reader -->|端口| contracts
  turnport -.->|"实现"| contracts
  ledger -.->|"实现"| contracts
  reader --> turnport
  turnport --> client
  client --> sessions
  sessions --> store
  supervisor --> client
  client <--> acp
  activity --> host
  deadline -.->|"nowFor"| reader
```

`deadline-clock.ts` 的 `nowFor` 同时被上层（`src/services/qianmo/resident.ts`、`@qianmo/router` 的 `deadlineNow`）用作「过闸门的时钟」，因此一个刚解冻的节点不会把所有在飞投递一起判死。

## 2. 对外 API 面

读 `src/index.ts`（另有 `./activity` 与 `./timings` 两个子入口，供宿主侧的 `@qianmo/activator` 单独引用）：

- **`ResidentNodeRuntime` / `ResidentAgentBinding`** —— 节点级门面：`deliver(message)` 按收件地址的 agent 段选 reader，`pollAll()` 全量轮询。
- **`ResidentMailboxReader` / `ResidentMailboxReaderOptions` / `ResidentPollResult`** —— 一个 agent 的准入循环，单飞（同一时刻只有一次 `poll` 在跑）。
- **`ResidentPoller` / `DEFAULT_RESIDENT_POLL_INTERVAL_MS`** —— 驱动轮询的定时器，从**完成**处重排。
- **`NodeTurnGate`** —— 节点级 turn 串行闸门，重叠即抛。
- **`FileAdmissionLedger`** 与端口类型 **`AdmissionLedger` / `AdmissionRecord`（`detected` / `admitted` / `read`）/ `PendingAdmission` / `AdmissionQueryResult` / `AdmissionIntegrityIssue`** —— 崩溃恢复账本。
- **`ResidentMailboxPort` / `ResidentTurnPort` / `ResidentTurnInput` / `ResidentTurnResult` / `ResidentMailboxMessage`** —— 两个端口，让整包不依赖任何具体信箱或 ACP 实现。
- **`AcpResidentTurnPort` / `AcpPromptConnection` / `ACP_INPUT_ACCEPTED_METHOD` / `ACP_INPUT_STATUS_METHOD` / `ACP_SESSION_ACTIVITY_METHOD`** —— `ResidentTurnPort` 的 ACP 实现与三个扩展方法名。
- **`ResidentAcpConnection` / `createResidentAcpStream` / `ResidentAcpClientOptions` / `ResidentActivitySink`** —— ACP 客户端侧连接。
- **`ResidentSessionManager` / `ResidentAgentSession` / `ResidentSessionConnection`**、**`FileResidentSessionStore` / `MemoryResidentSessionStore` / `ResidentSessionStore`** —— 会话映射与其落盘。
- **`ResidentSupervisor` / `ResidentChildConnection` / `ResidentSupervisorOptions`** —— ACP 子进程监督。
- **`ResidentDeadlineClock`** —— 解冻感知的截止时钟，导出 `nowFor(createdAt)`。
- **`ResidentTimingRecorder` / `ResidentTimingStage` / `ResidentTimingEvent` / `ResidentTimingSink` / `DEFAULT_RESIDENT_TIMING_CAPACITY`** —— 全链路埋点（P4.1 的独立核验取的就是它）。
- **`ResidentActivityReporter` / `RESIDENT_ACTIVITY_AGENT` / `isResidentActivityMessage` / `isResidentActivityPayload` / `ResidentActivityPayload`** —— 忙闲上报。
- **`residentMailboxIdentity` / `readCountsByIdentity` / `messageCountsByIdentity`** —— 基座信箱条目的身份三元组与计数（基座不给消息 id）。

协议级数值一律以 `@qianmo/protocol` 的 `LIMITS` 为唯一出处，本包不复制。

## 3. 最容易被改坏的五条不变式

| # | 不变式 | 改坏了会怎样 | 钉住它的测试 |
| --- | --- | --- | --- |
| 1 | **ack 必须晚于 durable read**：账本三相 `detected → admitted → read` 只能单向推进，`onRead` 是唯一的 ack 钩子（接线在 `src/services/qianmo/resident.ts` 的 `#ackTask`） | 提前发 ack，AC-2 独立核验里「每条 ack 都晚于沙箱内的 durable read」这条就不成立，且崩溃后无法判断消息到底进没进模型输入 | `test/ledger.test.ts`「advances detected to admitted to read without going backwards」；`test/reader.test.ts`「fsyncs detection before prompt and flips read from the admission callback」「the read callback fires after the flip, the terminal one after the turn」 |
| 2 | **turn 在输入被受理之前就结束 = 失败，不是空成功**；取消 / 拒答 / 触顶都是失败；不认识的 stop reason **不许**被编成失败 | 把它们报成 `completed`，请求方会收到一个它区分不出真假的成功 `task.result` | `test/reader.test.ts`「fails promptly when a turn completes before admission」；`test/acp-turn.test.ts`「a cancelled turn is a failed result, not an empty completed one」「refusals and ceiling stops are failures too, not truncated successes」「an unfamiliar stop reason is not invented into a failure」 |
| 3 | **节点级 turn 串行，且失败的 turn 也必须放行下一个** | 并行开 turn 会让同一节点的两个会话互相踩；失败不释放则整个节点在第一个异常上永久停摆 | `test/turn-gate.test.ts` 两条；`test/reader.test.ts`「returns after admission while retaining the gate until turn completion」 |
| 4 | **账本损坏是报错，不是跳过**：`poll()` 一旦查到 integrity issue 直接抛，压实也拒绝在损坏上进行 | 静默跳过损坏行 = 悄悄丢一条已经承诺过要处理的消息，而这正是账本存在的理由 | `test/ledger.test.ts`「reports a torn tail and refuses to compact damage」「rejects malformed records and unknown fields at runtime」 |
| 5 | **定时器从完成处重排、不补跑漏掉的 tick；截止时间按冻结重叠段扣除** | 冻结期间定时器不补跑（E4），补跑会在解冻瞬间打出一串堆积调用；不扣冻结段则所有「距上次多久」的判据会在同一毫秒一起越阈 | `test/poller.test.ts`「reschedules after each completed poll instead of replaying missed ticks」；`test/deadline-clock.test.ts`「the first deadline query after thaw observes the freeze」「excludes only the overlapping parts of multiple freezes」 |

另有两条有专门用例、容易被「优化」掉的性质：**一个 turn 的正文不能漏进下一个**（`test/acp-turn.test.ts`），**未知的受理通知不能翻转任何信箱条目**（同上）。

## 4. 与基座的关系

- **定性：部分**（charter §3.2 R-3，v2.7 定案；P0.2 复核完成）。roadmap P3.1 的 v2.15 勘误把理由改写过一次，结论未变：
  - **唤醒半边零核心改动**——正解是 ACP 自带的 `session/prompt`，不是原文列的四条通道（在 ACP 宿主下一条都不通）。
  - **休眠半边必须改核心**——真正的理由不是「基座没有 idle 事件」（它有四个），而是**基座没有任何进程内扩展点**：插件清单能声明的全是子进程或 Markdown。
- [`base-adoption.md`](../../docs/dev/base-adoption.md) §3.1「休眠与唤醒」判定为**无**（可复用的只有 supervisor 骨架）。
- 代码层面：**本包对基座 `src/` 零 import**——它是端口化的，信箱与 ACP 都是注入进来的。真正的基座核心改动面在 `src/services/qianmo/resident.ts` 与 `src/cli/handlers/resident.ts`（`occ resident`），按章程 T-5 对策④，那些 PR 需注明「为什么扩展点不够用」。
- 外部依赖：`@agentclientprotocol/sdk`（ACP 宿主协议），以及 `@qianmo/protocol` / `@qianmo/transport`。

## 5. 边界与已知未做

- roadmap「完成状态速查」P3.1 行的边界原文：**本包只完成 AC-2 后半（休眠 → 唤醒 → 可响应）；跨节点 ack/result 仍归 P4.1，不在此冒领。**
- 真机验收数据（baseline 2/2 与 candidate 1.1/1.5 各 10/10、accept→first content P95 等）在 roadmap v2.17 与 `demo/p31-resident-wake.sh`，**不在包内**；A/B 只决定了两个专用默认值（resident activity 重连 1.1、宿主 resident keepalive 1.5），通用 transport/协议默认仍为 2。
- 长时驻留的内存与吞吐基线属 **P7.3**，roadmap 完成状态速查 P7.3 行标注「本地腿就绪、正式 24 h / n=100 唤醒 / T3 吞吐数据待真机」。
- `protocol.md` §12.3 第 1 条与本包直接相关：**「轮询循环解冻后是否属热页」是 A 类 ack 成立的关键假设，尚未实测**。

## 6. 怎么跑测试

```bash
bun test packages/resident
```

实测：**47 pass / 0 fail，10 个测试文件**（`acp-turn` / `deadline-clock` / `ledger` / `poller` / `reader` / `session-store` / `sessions` / `supervisor` / `timings` / `turn-gate`），零 mock；宿主侧接线的集成用例另在 `src/services/qianmo/__tests__/resident.integration.test.ts`。

## 7. P9.3 双人签字

> owner 栏语义见 roadmap「任务包字段说明」（v2.3）：主开发一律是喻永昌，owner 栏原名单读作「方向辅助人 / 第二知情人」，括号内 backup 读作「第二辅助」。下表按 P3.1 的 owner 栏填名。

| 角色 | 姓名 | 签字 | 日期 |
| --- | --- | --- | --- |
| owner（P3.1 owner 栏） | 董宗岳 | | |
| backup（P3.1 括号内） | 陈子轩 | | |

### backup 需能独立复述的 3 道题

1. 一条网络任务从进沙箱到发出 `ack`，账本上依次会出现哪三条记录？`ack` 挂在哪一步之后、为什么不能提前？如果进程在中间任意一点被 `kill -9`，下一次 `poll()` 会怎么恢复？
2. ACP 的 turn 结束了但输入从没被受理过——这种情况现在算成功还是失败，为什么？再说：一个本版本没见过的 stop reason 应该被当成什么，理由是什么？
3. 常驻宿主为什么是 ACP 而不是基座的 daemon supervisor？「休眠那半必须改基座核心」的真正理由是什么（注意：不是「基座没有 idle 事件」）？
