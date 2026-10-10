<!-- Copyright 2026 Qianmo AgentNest Team -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# M2 注册中心多实例

`qm registry` 提供原 HTTP v0 接口，单进程可用 `--state` 原子文件存储，多实例用 `--database-url-file` 连接同一个 PostgreSQL namespace。写 token 必填；数据库 URL 与 token 均从仅属主可读文件加载，不放进命令行与启动日志。

```sh
qm registry --host 127.0.0.1 --port 38620 \
  --write-token-file /etc/qianmo/registry-token \
  --database-url-file /etc/qianmo/registry-database \
  --namespace public-beta
```

## 一致性与故障

每个请求在数据库事务中锁定一个 namespace 的状态行，读取最新智能体表与吊销列表，复用现有注册校验，再提交改动。事务提交成功后才返回成功响应。不缓存可继续服务的旧表，因此数据库不可用、schema 漂移或提交失败返回 503。并发重复地址仍按现有冲突语义返回 409。租约依据数据库时间；各 API 实例的机器时钟不参与租约裁决。

请求体在取得锁前读取，上限 1 MiB；写请求先验证 token。行锁等待上限 2 秒、语句上限 5 秒，慢客户端不会占住共享事务。当前实现按 namespace 串行化，适用于登记与续租的控制流；不是无限吞吐的分布式数据库。

## 部署候选

至少两个不同机器上的 API 实例，由支持健康检查的 HTTPS 负载均衡转发。健康检查 `/v0/health` 必须使用真实数据库事务的结果。API 层不执行数据库 leader election，连接的是运维提供的 PostgreSQL 主写入口；数据库需要持久卷、备份以及经过验证的主从/故障转移。把两个 API 都连到一台无副本数据库，不能称为端到端高可用。

`qianmo_registry_state` 是独立表，使用 namespace 主键。首次初始化建立空 namespace；schema version 与 TTL 不匹配拒绝启动，不自动清空。旧文件数据仍保留；迁移时在维护窗口停旧写入，由租户登记簿续租者重新发布登记，再切换负载均衡。CA 吊销列表必须在切换前重新发布并核对，不能依赖智能体续租恢复。回退时先停止新写、恢复旧入口并重新登记和核对吊销列表，不把两套存储同时当作真源。

## 验证

`bun run atlas:test:registry-ha` 启动仅监听本机的临时 PostgreSQL，执行真实数据库测试后停库；要求 `initdb` / `pg_ctl`，也可显式提供专用测试库 `ATLAS_TEST_REGISTRY_DATABASE_URL`。外部测试库仅增删随机 namespace 的测试行。该检查接入 `verify` 与 CI，缺数据库工具时失败，不悄悄跳过。

2026-10-08 本机 PostgreSQL 16.13：8 通过、0 失败。覆盖两个 HTTP 实例并发登记、冲突与鉴权、请求体上限、跨实例删除、吊销列表恢复、过期租约、真实 `qm registry` 进程被 SIGKILL 后的数据可见性、schema/连接失败时返回 503。普通分片没有数据库时会明确跳过 7 个数据库用例，专用门禁补齐它们。尚未在生产部署、未做 PostgreSQL 主从切换或 SLA 长跑。
