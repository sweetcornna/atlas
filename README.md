# 阡陌 AgentNest（Qianmo AgentNest）

> 阡陌交通，鸡犬相闻。

**阡陌**是一个「云端常驻智能体平台 + 智能体通信网络」。智能体不再是一次性的对话进程，
而是长期驻留在云端的个体：它拥有自己的地址、分层记忆与休眠/唤醒生命周期；当它需要别人时，
沿着阡陌小径把消息递到另一个节点上的另一个智能体手里。田连阡陌，鸡犬相闻——这正是我们
希望智能体之间形成的样子：各自安居，彼此可达。

本仓库是阡陌的自研代码库，所有自研包使用 `@qianmo/*` 命名空间。

## 仓库结构

```
.
├── docs/                      项目文档（计划书、申请书、品牌素材、dev 设计文档）
├── packages/
│   ├── protocol/              @qianmo/protocol —— 消息信封 v0、地址、边界与校验（零依赖纯函数）
│   ├── registry/              @qianmo/registry —— 注册发现中心 + HTTP API v0（Bun.serve）
│   └── runtime-adapter/       @qianmo/runtime-adapter —— 智能体运行时接缝与内存版参考实现
├── scripts/
│   └── fetch-base.sh          拉取外部参考基座到 vendor/（本地研究用，不入库）
├── types/                     手写的 Bun 环境类型声明（因零第三方依赖约束而自备）
├── tsconfig.base.json         各包共享的 strict TS 配置
├── LICENSE / NOTICE           Apache-2.0 及与外部参考代码的许可边界说明
└── package.json               bun workspaces 根配置
```

### 三个包的职责

| 包 | 职责 | 依赖 |
| --- | --- | --- |
| `@qianmo/protocol` | 消息信封 `QianmoMessage`、地址 `qianmo://<node>/<agent>`、消息类型、边界常量 `LIMITS`、`validateMessage()` 与错误码 `ProtocolErrorCode` | 无 |
| `@qianmo/registry` | `InMemoryRegistry`（register / resolve / list / deregister / heartbeat，条目带 TTL 租约）与 HTTP API v0 | `@qianmo/protocol` |
| `@qianmo/runtime-adapter` | `AgentNode` / `Mailbox` / `MemoryStore` 接口，以及 `InMemoryMailbox`、`InMemoryMemoryStore`、`StubAgentNode` 参考实现 | `@qianmo/protocol` |

注册中心 HTTP API v0：

| 方法与路径 | 说明 |
| --- | --- |
| `POST /v0/agents` | 注册或续租，新建返回 201、续租返回 200，端点冲突返回 409 |
| `GET /v0/agents` | 列出在线智能体 |
| `GET /v0/agents/:name` | 解析单个智能体，已下线或不存在返回 404 |
| `DELETE /v0/agents/:name` | 注销，成功返回 204 |
| `POST /v0/agents/:name/heartbeat` | 心跳续租，返回新的 `expiresAt` |

## 快速开始

环境要求：Bun ≥ 1.3（开发时使用 bun 1.3.13 / node 26.3.0）。

```bash
# 安装依赖（workspace 内部包自动链接）
bun install

# 运行全部单测
bun test

# 类型检查（各包 tsc --noEmit，strict）
bun run typecheck
```

拉取外部参考基座（**可选**，仅本地研究使用）：

```bash
./scripts/fetch-base.sh          # 或 bun run fetch-base
```

脚本会把参考基座浅克隆到 `vendor/openclaudecode` 并固定在指定 commit；重复执行只校验 commit，
不会重复克隆。`vendor/` 已在 `.gitignore` 中，永不入库。

启动注册中心：

```ts
import { startRegistryServer } from "@qianmo/registry";

const server = startRegistryServer(4400);
console.log(server.url); // http://127.0.0.1:4400
await server.stop();
```

## 参考基座与许可边界

阡陌的自研代码与外部参考基座 **openclaudecode** 严格隔离：

- 自研代码（`packages/`、`scripts/`、根配置）以 Apache-2.0 授权，见 `LICENSE`；
- `vendor/openclaudecode` 是外部参考代码，**没有有效的许可授权**，仅经 `scripts/fetch-base.sh`
  拉到本地供接口层面的研究，不随本仓库分发、不得再分发、不得复制进 `packages/`；
- 详细边界见 `NOTICE`。

## 文档

设计文档位于 `docs/dev/`：

- [`docs/dev/charter.md`](docs/dev/charter.md) —— 项目章程：目标、范围与非目标
- [`docs/dev/roadmap.md`](docs/dev/roadmap.md) —— 路线图与里程碑
- [`docs/dev/base-analysis.md`](docs/dev/base-analysis.md) —— 参考基座分析与可借鉴的接口层面结论

其余项目材料（计划书、申请书、图表素材）见 [`docs/`](docs/)。

## 许可

Apache License 2.0，版权归 Qianmo AgentNest Team。详见 [`LICENSE`](LICENSE) 与 [`NOTICE`](NOTICE)。
