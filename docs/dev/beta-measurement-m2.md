<!-- Copyright 2026 Qianmo AgentNest Team -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# M2 协作与稳定性观测

`bun run atlas:report:beta manifest.json > report.json` 只读汇总冻结的原始数据，不启动探针、部署节点或调用模型。实际探针仍使用 `demo/env/beta/ops/fleet-probe.sh`，节点启用 `--timings`。先固定观测窗口、工作节点集合、采样频率，再开始采样。不同部署指纹、模型或配置的记录分别报告，不能混成同一次稳定性验收。

清单里的路径相对清单文件。`from` / `to` 为 epoch 毫秒，窗口左闭右开；以下只演示三分钟计算，不是七天 SLA 结果。

```json
{
  "from": 1791417600000,
  "to": 1791417780000,
  "bucketMs": 60000,
  "workerNodes": ["node-a", "node-b"],
  "lanes": [
    {"node": "node-a", "probe": "endpoint", "intervalMs": 60000},
    {"node": "node-b", "probe": "endpoint", "intervalMs": 60000},
    {"node": "node-a", "probe": "wake", "intervalMs": 60000}
  ],
  "probes": ["avail-node-a.ndjson", "avail-node-b.ndjson", "wake-node-a.ndjson"],
  "timings": [{"node": "node-a", "path": "node-a-timings.ndjson"}],
  "audits": ["node-a-trail.ndjson", "node-b-trail.ndjson"]
}
```

## 指标口径

**可用性**按固定采样槽统计，分母是窗口内应有槽数。缺样、失败、内存护栏跳过均不算成功。一个槽多次采样时保留失败，不用后来的成功冲掉失败。报告同时列出覆盖率、重复、缺失和失败数量。节点端点应答、PSK 握手、注册中心健康与控制台健康须用不同 lane，不能互相代替。

**唤醒延迟**用探针 `detail` 的 msgId 和采集时明确标定的节点，关联节点 `first_content`，不能以 `/v0/wake` 的 HTTP 200 当作首内容。旧探针 `t` 只有秒级精度，报告给出毫秒下界与保守上界；P50/P95 使用 nearest-rank 上界。唤醒也必须配置固定采样 lane；没有计划 lane 时不可判定。计划槽缺样、失败、缺失首内容与逆序时钟保留为无穷，同一 msgId 不重复填槽，同槽多次请求保留最坏结果，JSON 用 `"infinite"` 表示。跨机墙钟须同步；这仍是空闲常驻唤醒，不是容器冻结解冻延迟。原样本在报告中保留，源文件有 SHA-256 与字节数。

**协作占比**按全局 msgId 去重受理的传输信封，按最早观测时间分桶。分母为应用消息：task.request、task.result、wake、notify 和 resource.*；分子为其中发送与接收地址属于预先指定工作节点、且节点不同的消息。ACK、ping/pong、error、authz.* 单列为控制消息；已知唤醒探针以及同 taskId 的回复均排除。它量的是网络协作流量，不直接代表模型质量、任务成功率或用户留存。

当前接收器的审计事件新增 messageType/from/to 元数据，不记录 payload 或密钥。旧日志缺元数据单列 unknown，相应桶不可判定；不猜历史消息类型。连续上升需至少三个有应用消息且无 unknown 的桶，比例严格逐桶上升；空桶与样本不足返回 null，持平或下降返回 false。仍须结合业务量和完整采集判断，短期受控场景不能证明公测增长。

原始 sample / slot 的未知延迟保留 `null`，在分位数计算中作为无穷；分位数输出用 `"infinite"`，不会因缺值跳过计划槽或缩小分母。

读取时验证每份审计链完整性，拒绝缺文件、损坏、读取中变更、截断 JSONL 及同 msgId 元数据冲突。链完整只能证明文件内部一致，采集是否完整及离机见证窗口需运维另行核实。

## 协作开发场景

`atlas/scripts/a2a-interop.ts` 使用真实 qm CLI、独立官方 A2A SDK 进程和带签名的阡陌传输，完成开发请求、测试结果与复核结果归集；源文件摘要、任务 ID 和信封计数随运行留档。开发实现与复核内容是受控 fixture，不能称为真实模型协作质量。现有真实双节点 OMP 集成另验证常驻任务链，见 [`a2a-gateway.md`](./a2a-gateway.md)。本轮不增加通用工作流编排器。

本轮只完成统计器和本地场景的开发与回归；当前版本七天生产观测、跨机时钟核对与真实公测比例趋势仍需部署审核后采集。
