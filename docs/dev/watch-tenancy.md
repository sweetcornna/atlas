<!-- Copyright 2026 Qianmo AgentNest Team -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# M2 watch jobs and notification identity

`qm watch` can use the same private tenant mapping as the console and resident nodes:

```sh
qm watch --jobs /private/watch-jobs.json \
  --from qianmo://watch-hub/console \
  --sign --trust worker-a=WORKER_PUBLIC_KEY \
  --tenancy /private/tenancy.json
```

The mapping is a 0600 file following `consoleTenancy.ts` / `TenantConfig`: each job ID belongs to a tenant and a target node; the node belongs to the same tenant. Repeat `--trust` for every target node. The watch hub's own key is the key printed by `qm watch --print-identity --from ...`; the node must already trust it. No keys are generated for other nodes and no production configuration is modified by this command documentation.

With `--tenancy`, `--sign` and explicit trusted target keys are mandatory. The client binds each URL to one expected node and requires a signed listener handshake. A URL shared by different node identities is rejected. Before dialing and again after connection, the current tenant mapping and node pause/retire gate must allow the exact configured job/target. Missing, damaged or changed mappings fail closed; an unmapped job is recorded as skipped, not dispatched.

Incoming notifications and results first pass the normal router's loop, hop, deadline and rate checks. Then the destination must be this hub, the context must be a configured job, the sender address must match that job's target, and the actual connection identity must match the job's node. In M2, a PSK-only claim cannot satisfy this check. Tenant/job assignments are read again at notification time. Forged or mismatched notifications produce no notice, stdout alert, or successful notification audit record.

Accepted notification records include `detail.connectionNode` taken from the transport's authenticated channel. `createNotifyPort` exposes that value as `ConsoleNotice.node`; tenant filtering uses it, not the message's self-reported `from`. Historical notifications without a verified connection node remain unassigned and are hidden from tenant-specific feeds. Legacy M1 watch runs may still use the prior PSK-only mode; that does not create a verified notification owner.

Validation: `watchBoundary.test.ts` covers cross-tenant/wrong-connection claims, empty signed identity, mismatched recipients, duplicate messages, mapping removal before dispatch and during dialing, plus actual `qm watch` child processes connected to a signed local transport server. The real positive records only the correct notification and displays its authenticated node; the negative changes job ownership and proves zero additional dispatches. This is local protocol/authorization evidence, not a production fleet deployment or cloud resource test. Scheduled-job token accounting is a separate concern from these identity gates.

To run the same actual CLI test against the built executable, set `QIANMO_TEST_COMPILED_QM=/absolute/dist/qm-darwin-arm64` when running `bun test --preload ./atlas/tests/preload.ts ./atlas/packages/node/test/commands/watchBoundary.test.ts`. The signed server remains an independent local test process; only the watch client and status command switch to the compiled CLI.

## 作业计量与配额

`qm watch` 维护独立的 `<config>/watch/usage.ndjson` 与任务归属数据库，不争用 console 的个人账本。每个配置根只允许一个 watch writer；第二个进程不能夺取计量锁后继续发任务。默认 shadow 无限制；启用限制须在每次启动时传 `--usage-policy /absolute/policy.json`，格式复用 `UsagePolicy`：

```json
{"mode":"enforce","person":{},"job":{"wakes":100,"inFlight":1},"global":{"wakes":1000},"tenants":{"team-a":{"wakes":200}}}
```

这些是 **watch 账本范围**的作业、租户与全部作业额度，不与独立 console 个人额度合并。`kind:job / subject:jobId` 来自固定作业文件，tenant 来自当前受保护映射；拨号后再核对归属未变。派发前持久预约，超限时零拨号、零发包。`wakes` 计已准入的唤醒尝试（即使后来拨号失败）；`messages` 是个人对话口径，此入口不伪增它。

实际 taskId 在发包前持久绑定 job、目标和 tenant。确认尚未发送的失败释放 inFlight；发出后缺回执、超时、断线或进程重启均保留，直到对应的已认证真实 `task.result`、可信节点审计终态或预约 TTL。TTL 至少覆盖最长作业期限加连接预算。未知/其他 taskId、错误 job/节点或已改变的租户归属不能冒充终态释放配额。

可重复传 `--usage-audit node=/absolute/node-audit-copy.ndjson`，从运维提供的本地节点审计副本读取四列 token。只有链完整、node 与原任务目标相符、taskId 已绑定的 `usage.tokens` 才归账，事件跨重启去重；`usage.turn_end` 可结束该任务预约。审计副本由可信采集过程提供，本参数不自动拉取远端、不替代离机见证。没有副本或副本延迟时只知已观察到的下界，不能把零 token 写成实际零消耗，token 上限也只针对已观察计数。

`qm watch --usage-status` 只读最近持久化的计量快照，含 `observedAt`、`lowerBound:true`、四列 token、charged、wakes、inFlight 与额度；先检查观察时间，不将陈旧快照当实时值。实际 qm 签名 socket 测试验证正常终态归零、下一次唤醒被持久额度拒绝、重启和独立 status 命令；另外验证收据未知保留、租户拨号竞态及审计 token 重放去重。
