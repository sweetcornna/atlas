<!-- Copyright 2026 Qianmo AgentNest Team -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# A2A 1.0 边界网关

本实现是 M2 的**单回合文本任务 HTTP+JSON 网关**，从 `qm a2a` 运行；阡陌内部仍用 v0 信封、原 capability 和原 task.result。它不宣称完整 A2A 协议栈，也不等同于任何厂商托管服务认证。

2026-10-08 再核官方 [最新发布](https://github.com/a2aproject/A2A/releases/latest) 为 **v1.0.1**；线上版本使用 **`1.0`**，依据 [该标签的 proto](https://github.com/a2aproject/A2A/blob/v1.0.1/specification/a2a.proto) 与 [HTTP+JSON 规范](https://github.com/a2aproject/A2A/blob/v1.0.1/docs/specification.md#11-httpjson-protocol-binding)。`a2a-gap.md` 是原评估；本页记录本轮实现范围，不倒改评估历史。

## 支持面

| 接口 | 行为 |
| --- | --- |
| `GET /.well-known/agent-card.json` | 经过 Bearer 认证；声明 `HTTP+JSON`、`protocolVersion: 1.0`、结构化 skills、`text/plain` |
| `POST /message:send` | `ROLE_USER`、text parts；服务器自生 taskId；默认等终态，`configuration.returnImmediately: true` 可立即取得 Task 后轮询 |
| `GET /tasks/{id}` | 同一 principal 才能查；重启后仍可查已持久化结果 |
| `qm a2a send` | 调固定 peer 的 `SendMessage`，必要时轮询 `GetTask`；text Artifact 转 v0 成功结果 |
| 其余操作 | 流式、订阅、取消、扩展卡、push、ListTasks 和对现有任务追加消息均明确不支持；不伪造取消成功 |

成功输出放 `Task.artifacts[].parts[].text`；工作状态用 ProtoJSON 的 `TASK_STATE_*`，不接受 v0.3 的小写枚举/`kind` 结构。入向 API 要求 `A2A-Version: 1.0`。HTTP 错误使用 v1.0.1 的 `error` 对象及 `google.rpc.ErrorInfo`，不把 A2A 错误加入内部 `ProtocolErrorCode`。

外向遇到 `INPUT_REQUIRED` / `AUTH_REQUIRED`、非文本 Artifact、直接 Message 结果或无效 taskId 会返回显式失败。内部 v0 没有非终态等待机制，本轮没有假装补出多轮会话。`SUBMITTED` 不翻译为阡陌 A 类 ack；ack 只由真实内部接收端发出。

## 配置和运行

配置是部署方的 JSON 文件，凭据只填**环境变量名**。以下示例需替换端点、公网 IP、token 和受信公钥；不包含真实凭据：

```json
{
  "identity": "team-a-boundary",
  "node": "a2a-hub",
  "host": "127.0.0.1",
  "port": 8088,
  "publicUrl": "https://agents.example.org",
  "name": "Development agent",
  "target": "qianmo://dev-node/coder",
  "targetPublicKey": "<dev-node 的固定 Ed25519 公钥>",
  "endpoint": "wss://dev-node.example.org/inbound",
  "pskEnv": "QIANMO_A2A_TRANSPORT_PSK",
  "timeoutMs": 300000,
  "principals": [{
    "id": "partner-a",
    "tokenEnv": "QIANMO_PARTNER_A_TOKEN",
    "from": "qianmo://a2a-hub/partner-a",
    "targets": ["qianmo://dev-node/coder"]
  }],
  "skills": [{
    "id": "coding", "name": "Coding",
    "description": "Run a bounded coding task in the configured workspace",
    "tags": ["coding", "tests"]
  }],
  "peers": [{
    "id": "reviewer",
    "url": "https://reviewer.example.org",
    "addresses": ["203.0.113.12"],
    "tokenEnv": "QIANMO_REVIEWER_TOKEN"
  }]
}
```

```sh
qm a2a serve --config /absolute/path/gateway.json
qm a2a send --config /absolute/path/gateway.json --peer reviewer --prompt 'Review this bounded change…'
qm a2a task --id '<inbound gateway task id>'
```

启动横幅给出 `capabilityTrust: a2a-hub=<公钥>`。内部节点必须显式信任此签发方，网关只签 `write-limited`，仍经节点正常 capability、策略与工作区边界检查。HTTP 主体不能选择 `from`、内部 target、cap 或网关节点身份；每个 principal 的 synthetic `from` 必须属于网关节点。内部 context 按 principal 分域，不能用别人的 contextId 混入其内部会话。

`targetPublicKey` 必填且钉住内部 target node 的 Ed25519 公钥；不从注册中心、HTTP 请求或对端自报信息取信任。网关使用自己的同一节点密钥进行强制双向签名握手，接收结果时核对实际 `authenticatedPeerNode`、from/to、taskId、contextId 和 traceId。内部节点配置 `--require-signed-handshake --trust a2a-hub=<上述公钥>`；仅知道 PSK 的 unsigned 服务或错误 target 公钥不能接到任务，不能静默降级。生产内部链路使用 WSS，密钥轮换须明确更新受信配置。

M2 部署还须在目标节点的租户配置和受信 hub 列表中显式准入该网关身份；签名与 capability 不绕过节点现有租户、工具或审批闸门。配置由部署方管理，HTTP principal 不能修改这些归属。

生产 HTTP 入口由 TLS 反代保护，网关默认只监听回环。`publicUrl` 是 HTTPS origin；本地开发可用 literal `127.0.0.1` / `::1` HTTP origin。外向 HTTP 也只准显式 `allowLoopbackHttp: true` 的 literal 回环，其他目的地必须 HTTPS。

## 持久化、认证与失败边界

- 入向状态：`<QIANMO_CONFIG_DIR>/qianmo/a2a/tasks.sqlite`；出向状态：同目录 `outbound.sqlite`。每份库单写者，活进程占用时第二写者拒启。目录 0700、数据库 0600，SQLite WAL + FULL synchronous；网关进程只能在私有配置根运行。
- 接任务前先持久化服务器任务 ID ↔ 内部 ID，出向拿到远端 ID 立即落盘。`principal + messageId` 去重，内容变更复用同 ID 会拒绝；出向同内部 taskId 持久去重。重启把未完成映射标为失败/执行结果不明，**不会自动重新执行**。运维须先查内部任务再决定新任务重试。
- `qm a2a send` 和 `serve` 使用不同状态及审计文件，可同时运行；两个同根 `send` 并发时第二写者拒绝。`task` 命令查入向映射；出向映射供本地审计/数据库检查。
- 不存在和无权访问的任务返回同一 404 正文；错误不回显内部异常或凭据。凭据轮换可保留 stable principal id，不改变任务所有权。Agent Card 也要求认证。
- HTTP 请求及响应限 256 KiB；内部回复正文限其一半以留 envelope 空间；并发入向任务限 64；单库保留上限 100000 条，满后拒绝接新任务，需停服后归档再开新库。期限到达会中止等待并标失败；v0 无取消协议，**不能承诺已经派发的内部工作被取消**。
- 外向只准部署配置里的 peer；不从请求/Agent Card 选 URL；每次 socket 建连校验 DNS 全部解析地址与显式 IP allowlist，不跟重定向，TLS hostname 验证保持开启。IP 变更须人工更新 allowlist，不能静默扩大权限。
- 出口保留原 taskId 映射、记录一跳并执行 LoopGuard；携带 `qianmoBoundary` 元数据。入向拒绝任何携带该边界元数据的新任务，保守禁止再转入阡陌；不支持多个网关串接。第三方删除关联信息再创建全新任务无法由本协议可靠识别，不能宣称消灭任意应用层循环。
- `audit.ndjson` / `outbound-audit.ndjson` 写 `AuditSource.A2a`，包含内外 taskId、traceId、方向、peer、跳数与成功/失败。源码位于 `atlas/packages/a2a`，CLI 适配器位于 `atlas/packages/node/src/commands/a2a.ts`。

## 可复跑验证

```sh
bun test --preload ./atlas/tests/preload.ts ./atlas/packages/a2a/test
# 工具依赖装在仓外的专用目录，不改产品依赖：
bun add --cwd /absolute/tools/a2a @a2a-js/sdk@1.3.0 express@5.1.0
bun atlas/scripts/a2a-interop.ts /absolute/tools/a2a /absolute/evidence/a2a
# 对最终编译产物复跑同一互调：
QIANMO_TEST_COMPILED_QM=/absolute/dist/qm-darwin-arm64 \
  bun atlas/scripts/a2a-interop.ts /absolute/tools/a2a /absolute/evidence/a2a-compiled
```

互调脚本实际启动独立官方 SDK Express 进程、独立 SDK client 进程、`qm a2a serve` / `send` CLI，以及要求双向握手签名和 capability 验证的真实 v0 transport 接收端；网关固定接收端公钥。SDK 请求触发确定性 worker 在隔离工作区写入 slugify 实现，实际执行五项用例；Artifact 经出向 A2A 交独立 SDK reviewer 核查 source hash、导出契约和测试数量。故意失败任务和重复请求进入同一链路，报告从实际信封计数计算任务消息占比，不用预置比例。

`worker-transport.ndjson` 来自实际 transport 事件经 `transportTrailSink` 写入的完整审计链。这个单接收端夹具只有 bridge → worker 请求，不能把报告内的 task.request/result 占比当成 M2.5 的 worker → worker 协作比例；该夹具的后者为零，也没有采集全网所有节点。

这证明**独立实现之间的本机协议互通和确定性开发工作流**。它没有使用付费模型、厂商托管服务、跨机器网络或真实团队协作，因此不把该报告写成现场跨厂商验收。输出包括机器可读 `a2a-interop-report.json`、两侧 stderr 和私有临时工作区路径；报告不含 token。正式现场验收仍需在审核过的真实对端和真实工作负载上采同一报告口径。
