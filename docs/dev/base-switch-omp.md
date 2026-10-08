<!-- Copyright 2026 Qianmo AgentNest Team -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# 基座切换：open-claude-code → oh-my-pi

| 项 | 内容 |
|---|---|
| 决议 | 负责人 2026-10-07：整仓换基座（章程 v3.0 基座路线变更） |
| 新基座 | oh-my-pi（omp）v18.8.4，上游 `can1357/oh-my-pi` 提交 `40e9368ef0458fd9073329cdff4174895f91bc6b`，MIT |
| 新度量基线 | 标签 `base-snapshot/omp-v18.8.4`（无父提交，树 `c7d2ecac…` 与上游逐字节一致） |
| 导入提交 | `c9a87c8c`：删除 occ 基座树 4033 文件，按快照写入 8798 文件，阡陌 1238 文件原样保留 |
| 旧基座 | open-claude-code v2.46.0（`base-snapshot/v2.46.0` 保留，不移动、不删除） |

本文是切换的设计与移植契约。移植期间各工作包按本文的布局、接口与判据执行；与本文冲突的旧约定（`src/config/paths.ts` 派生路径、`feature()` 位置、occ 品牌兼容串等）随 occ 一并失效。

## 1. 为什么能整仓换

阡陌对 occ 的运行时依赖只有一处：常驻宿主拉起 `occ --acp` 子进程，再加上阡陌在 occ 内部做的约 7 处改动（`qianmo/*` ACP 通知、`qianmo_notify` 工具、权限硬顶、QueryEngine 入队钩子）。22 个 `@qianmo/*` 包不 import 任何基座包；通信、能力、审计、注册、调度、控制台、沙箱、备份全部与基座无关。omp 提供 `--mode rpc`、host tools、扩展的 `registerTool` / `tool_call` 拦截与会话事件，足以在不改 omp 核心的前提下承接上述 7 处。

换基座的附带结果：新基座不是对任何商业产品的逆向复原，章程 §5.2② 的溯源风险（L-2）随 occ 树一起离开工作树；代价是「基座为负责人自有项目」这一说法不再成立。

## 2. 目标布局

```
atlas/                          仓库根 = omp v18.8.4 基座树（MIT，见 LICENSE.base）
├── packages/  crates/  docs/*.md  scripts/  python/  sdk/ …   omp 基座（只在必要时改，改动记入 base-modifications.md）
├── atlas/                      阡陌自有代码（AGPL-3.0-or-later）
│   ├── packages/<domain>/      @qianmo/* 工作区包（原 22 个 + paths、mailbox、node、extension）
│   ├── scripts/                阡陌门禁与工具脚本
│   └── tests/                  integration、boundary、support、preload.ts
├── demo/                       演示与验收脚本（阡陌）
├── docs/dev/  docs/assets/  docs/阡陌*.pdf|docx   阡陌文档
└── BASE.md  NOTICE  LICENSE(AGPL)  LICENSE.base(omp MIT)  CLAUDE.md  CLAUDE.full.md  AGENTS.md  README*.md  CONTRIBUTING.md  SECURITY.md
```

放进 `atlas/` 的理由：omp 的 `oxfmt` 门禁按 `packages/*/src/**`、`scripts/**/*.ts` 匹配，阡陌代码留在原位会被 omp 的格式与 lint 判红；单独目录也让「哪部分是阡陌的」在目录层面可见。`demo/` 不在 omp 的匹配范围内，留在根。

根工作区：根 `package.json` 以 omp 版本为底，`workspaces.packages` 追加 `atlas/packages/*`，阡陌脚本一律加 `atlas:` 前缀，不改 omp 既有脚本名。

工具链：Bun **≥ 1.4**（omp `packageManager: bun@>=1.4`，`.tool-versions` 固定 1.4.2）；omp 原生插件 `pi_natives.<platform>.node` 由 `bun run build:native` 本地构建（cargo，需要 `rust-toolchain.toml` 指定的 nightly 与 ninja），或取 npm 预编译叶包。

格式与类型：阡陌路径用 biome（`biome.json` 的 `files.includes` 仅含 `atlas/**`、`demo/**`）与 `tsgo -p tsconfig.atlas.json`；omp 路径保持 oxlint / oxfmt / 各包 tsgo，阡陌不重排 omp 文件。

## 3. 新增包与接口契约

### 3.1 `@qianmo/paths`（零依赖）

```ts
export const IDENTITY = 'qianmo'
export function qianmoConfigDir(): string            // QIANMO_CONFIG_DIR（绝对路径）> ~/.qianmo
export function qianmoConfigPath(...seg: string[]): string  // 取代 occConfigPath
export function ompConfigRoot(): string              // <qianmoConfigDir>/omp
export function ompAgentDir(): string                // <qianmoConfigDir>/omp/agent
export function ompChildEnv(base: NodeJS.ProcessEnv): Record<string, string>
// 复制 base，删除 OMP_PROFILE、PI_PROFILE、PI_CODING_AGENT_DIR、XDG_{DATA,STATE,CACHE,CONFIG}_HOME、CLAUDE_CONFIG_DIR，
// 设置 PI_CONFIG_DIR = path.relative(homedir(), ompConfigRoot())，PI_NATIVES_DIR = <qianmoConfigDir>/omp/natives
export function memoryBaseDir(): string              // QIANMO_MEMORY_DIR > qianmoConfigDir()
export function caDir(): string                      // QIANMO_CA_DIR > ~/.qianmo-ca（必须在任何配置根之外）
export function qmcodeHome(): string                 // QMCODE_HOME > ~/.qmcode（只读引用）
export function protectedConfigRoots(): string[]     // ~/.qianmo、~/.omp、~/.claude、~/.codex、~/.qmcode 与当前 qianmoConfigDir 的并集
```

`OCC_CONFIG_DIR` / `OCC_IDENTITY` / `CLAUDE_CONFIG_DIR` 回落全部删除（干净切换，不留别名）。阡陌状态文件在配置根下的相对布局不变（`qianmo/audit/trail.ndjson`、`resident/*`、`registry/agents.json`、`teams/<team>/inboxes/<agent>.json` …），已部署节点的阡陌状态原地可用；occ 自己的会话、`settings.json`、`.credentials.json` 不迁移。

### 3.2 `@qianmo/mailbox`

独立重写（不拷贝 occ 代码），对外行为与旧 `teammateMailbox.ts` 一致：

- 路径 `qianmoConfigPath('teams', <team>, 'inboxes', <agent>.json)`；文件是 JSON 数组；
- 锁：`proper-lockfile`，锁文件 `<inbox>.lock`，重试 `{retries: 10, minTimeout: 5, maxTimeout: 100}`；
- 上限：单条正文 64 KiB（`MAX_MAILBOX_MESSAGE_TEXT_BYTES`），文件 4 MiB，压缩后保留 2 MiB，三级压缩顺序与旧实现一致；写入走临时文件 + rename；
- 导出：`writeToMailbox`、`readMailbox`、`markMessagesAsReadBySnapshot`（含 `readBefore` 参数与计数返回值）、`formatTeammateMessages`、`isStructuredProtocolMessage`、`TEAM_LEAD_NAME` 与适配器测试用到的 `sanitize*`。

### 3.3 `@qianmo/node`（`qm` 命令）

- `bin: { qm: "src/cli.ts" }`，Bun 直接执行；`src/cli.ts` 是显式分派表：`resident`、`audit`、`resident-wake`、`console`、`ca`、`cert`、`watch`、`memory`、`provider`、`handoff`、`agent`（转入 omp CLI，见 §4.4）、`--version`、`--help`。
- 每个命令模块导出 `run(argv: string[]): Promise<number>`，位于 `src/commands/<name>.ts`；命令、旗标与输出格式保持不变，帮助文本里的 `OCC_*` 说明换成 `QIANMO_CONFIG_DIR`。
- 目录：`src/commands/`（原 `src/cli/handlers` 的阡陌文件）、`src/host/`（原 `src/services/qianmo` 常驻宿主）、`src/ca/`、`src/providers/`（节点侧模型服务）、`src/omp/`（omp 启动与 RPC 封装）、`src/provenance.ts`。
- `qm --version` 输出 `qm <@qianmo/node 版本> (omp <omp 版本>) <源提交>`；源提交来自构建生成的常量，回落 `QIANMO_SOURCE_COMMIT`，再回落 `git rev-parse`，最后 `unknown`。

### 3.4 `@qianmo/extension`（加载进节点智能体的 omp 扩展）

默认导出 omp `ExtensionFactory`，由宿主以 `--extension <path>` 加载到每个 RPC 子进程。配置经环境变量 `QIANMO_EXTENSION_CONFIG`（JSON 文件路径）传入。职责：

1. 常驻权限硬顶：`pi.on('tool_call')` 按 `@qianmo/resident` 的 `ResidentHardline` 表拦截越权（受保护配置根、工作区外写、删除备份等），失败即拦（omp 对 `tool_call` 超时与异常本就 fail-closed）；
2. 子智能体守卫与工具面裁剪（去掉常驻场景不允许的工具）；
3. 输入身份：用户消息落盘时写入带阡陌 `messageId` 的自定义条目，供宿主崩溃恢复时扫描会话 JSONL 判定 input-status；
4. 可选：`before_provider_request` 记录前缀指纹（取代 occ 时代的 CH-6 诊断）。

### 3.5 `src/omp/launch.ts`（宿主与模型服务共用）

```ts
export function ompEntry(): string        // QIANMO_OMP_ENTRY > require.resolve('@oh-my-pi/pi-coding-agent/package.json') 的 bin.omp
export function ompArgv(args: string[]): string[]   // 源码模式 [process.execPath, ompEntry(), ...args]；编译产物模式 [process.execPath, 'agent', ...args]
export function ompSpawnEnv(extra?: Record<string, string>): Record<string, string>  // ompChildEnv(process.env) + extra
```

子进程 cwd 一律是该智能体的工作区（不是仓库根），避免仓库根的 bunfig 影响 omp 子进程。

## 4. 节点运行时契约（常驻宿主 ↔ omp）

### 4.1 选型：`omp --mode rpc`

ACP 路线下 omp 的 `prompt` 丢弃 `messageId`、`cancel` 不读 `_meta`、`extMethod` 是封闭分支、`extNotification` 为空实现，阡陌需要的 6 类信号都要靠私有旁路或改 omp 核心。RPC 模式原生提供：`prompt` 应答 + `prompt_result`（含 `status`、`error.httpStatus`）、用户与助手 `message_end`（助手失败尝试带 `errorStatus`）、`agent_start` / `agent_end` / `session_settled`、`tool_execution_*`（真实工具名）、`set_host_tools`、`open_session`。

### 4.2 进程拓扑

- 宿主维护 omp RPC 子进程池：**每个活跃会话键（agent + contextId）一个进程**，`open_session <会话目录>`，会话目录在 `qianmoConfigPath('resident', 'sessions', <agent>, <key>)`；空闲回收沿用 `session-gc`。
- 启动参数：`--mode rpc --no-ui --extension <@qianmo/extension> --config <节点覆盖层> [--model <provider/model>] [--thinking <level>]`；覆盖层固定审批模式与工具禁用（`--allow-workspace-edits` 映射为 `tools.approvalMode: write` + 扩展的工作区规则；其余为只读）。
- 环境：`ompSpawnEnv()`；去掉 occ 时代的 `CLAUDE_CODE_*`。

### 4.3 信号映射

| occ 时代 | omp RPC 时代 |
|---|---|
| `qianmo/input-accepted`（转录已写入） | 用户消息的 `message_end`（omp 在 agent 开始时同步追加到 JSONL，无 fsync，与 occ 的 flush 语义同级） |
| `qianmo/input-status`（崩溃后查询某消息是否已入会话） | 宿主扫描会话 JSONL 中扩展写入的输入身份条目 |
| `qianmo/session-activity`（忙/闲） | `agent_start` / `session_settled`（`prompt_result.sessionSettled`） |
| `qianmo/upstream-status`（上游 HTTP 状态） | `message_end.errorStatus`、`prompt_result.error.httpStatus`、`auto_retry_*` |
| `qianmo_notify` 工具 | `set_host_tools` 注册同名 host tool，`host_tool_call` 回到宿主 |
| `withResidentHardline` | `@qianmo/extension` 的 `tool_call` 拦截 |
| `_meta.permissionMode` | 每进程 `--config` 覆盖层 |
| `interrupt(reason)` | RPC `abort`；原因由宿主写入自身的交付账本与审计（omp 转录里的中断标记文字改为 omp 原生） |
| `unstable_resumeSession`（AC-1） | 重启后 `open_session` 同一会话目录，并显式传 `provider`/`modelId` |

### 4.4 编译产物

Fleet 载荷不带 `node_modules`，因此 `atlas:build:qm` 用 omp 的二进制编译流程（嵌入原生插件）把 `qm` 与 omp CLI 编进一个 `dist/qm-<target>`；`qm agent …` 进入 omp 的 CLI 主函数，宿主拉起的子进程就是同一个二进制的 `agent --mode rpc …`，符合 omp worker 重入约定。源码模式（开发、本地演示、沙箱内源码树）直接 `bun atlas/packages/node/src/cli.ts`。

## 5. 模型服务

- **保留**：中枢侧 `@qianmo/providers`（类型、校验、预设、协议、指纹、密钥引用）、控制台模型服务页、密钥库、ssh 执行器、两阶段下发与空闲提交。
- **重写编译目标**：一个档案编译成 omp 的 `models.yml`（每档案一个自定义 provider `qm-<profileId>-<urlhash>`，显式 `api`、每模型 `thinking` / `compat` / `contextWindow` / `maxTokens`）与 `config.yml`（`modelRoles` 带 `:level`、`defaultThinkingLevel`、`retry.*`、`providers.cacheRetention`），凭据写 `models.yml` 的 `apiKey`（单钥）或 omp `agent.db` 凭据池（多钥）。文件落在 `ompAgentDir()`。
- **固定 omp 默认值**以免行为漂移：`providers.cacheWarming: off`、网关类 provider `compat.statefulResponses: false`、`defaultThinkingLevel` 按档案显式给出、`retry.fallbackChains` 为空。
- **删除**：`modelCompat` 30 个源文件中除 `capabilities.ts`（重写）外全部、`promptCache` 全部、`@ant/model-provider` 下的阡陌文件——对应怪癖 omp 的 `packages/ai` 与目录规则已原生处理。
- **对外声明复位**：`custom-openai` 预设的「已评估」是在 occ v2.47.2 上取得的，切换后置回 `false`，等 AC-P6 在 omp 上重跑后再恢复。
- 协议字段名不变；`effective.apiProvider` / `wire` 的取值改用 omp 的 api 名称，`capabilities` 中 occ 特有的开关改为常量。

## 6. 门禁

| 门禁 | 处置 |
|---|---|
| prompt-purity、mock-hygiene、macro-guards、docs-i18n、shipped-features、vite 构建与 bundle 检查、windows 作业、ripgrep 安装、音频采集构建 | 随 occ 删除 |
| license-headers | 快照标签改为 `base-snapshot/omp-v18.8.4`；判据不变：快照内路径为基座（无 SPDX 头），其余为阡陌（必须有 AGPL 头） |
| identity-paths | 只扫描阡陌文件（git ls-files 减快照路径）；禁用字面量加入 `.omp`、`.claude` 之外的 occ 目录名 `.occ` |
| sbom | 基座 pin 改为 omp v18.8.4；按 hoisted 布局与 `catalog:` 解析；Rust 依赖取 omp 的 `about.toml` / `THIRD-PARTY-NOTICES.txt` |
| cycles、unused | 只覆盖 `atlas/`，预算重置 |
| 测试 | `atlas/scripts/test-shards.sh`：每个阡陌包一个分片（`--isolate`），预载 `atlas/tests/preload.ts`；根 `bunfig.toml` 不加预载 |
| omp 自身 | `verify` 里跑 omp 的 `check:ts`（证明阡陌没碰坏基座）；只有改了 omp 文件时才跑 omp 的 `test:ts` |

`precheck` = 阡陌类型检查 + biome 修复 + identity-paths + license-headers + 阡陌测试；`verify` = 在此之上加 biome ci、cycles、unused、sbom --check、omp `check:ts`、`qm` 编译与冒烟。CI 改为 `.github/workflows/atlas.yml`；omp 自带的 `ci.yml`、`bun-cache-warm.yml`、`nix.yml` 依赖 omp 的自托管 runner，在本仓库删除，发布类流程一律不保留。

## 7. 对外可见的变化

- `occ`、`occ-bun`、`open-claude-code` 命令消失；`qm` 改由 `@qianmo/node` 提供，产物从 `dist/cli-qianmo.js` 改为源码直跑或 `dist/qm-<target>`。
- 环境变量：`OCC_CONFIG_DIR` → `QIANMO_CONFIG_DIR`，`OCC_SOURCE_COMMIT` → `QIANMO_SOURCE_COMMIT`，`OCC_IDENTITY` 删除。
- 智能体状态从 occ 布局改为 `<配置根>/omp/agent/{sessions,config.yml,models.yml,agent.db}`；occ 会话不迁移，`resident/sessions.json` 结构变化，升级后重置。
- 节点智能体的工具名换成 omp 的（`read` / `edit` / `bash` / `task` …），进度通知里的工具名随之变化；网络协议（`task.result`、`notify`、`dedupKey`、`causeTaskId`）不变。
- Bun 最低版本 1.4；需要 omp 原生插件。

## 8. 验证计划

- 单元与集成：阡陌全部分片通过；omp `check:ts` 通过。
- 本地双节点冒烟：`demo/env/up.sh` 起中枢与两个节点，节点智能体为 omp，模型指向本地假 OpenAI 服务；跑通投递 → 唤醒 → 回执 → 结果。
- AC 复跑（本机能跑的）：AC-1 重启续答、AC-3 环路与限流、AC-4 记忆召回、AC-8 边界用例；AC-2 / AC-6 / AC-7 依赖 gVisor 与内测集群，切换后在内测环境重跑，结果出来之前对外不写「已在新基座上验收」。

## 9. 对外材料口径

- 一句话版改为：「阡陌基于开源项目 oh-my-pi（MIT 许可）构建，在其上实现常驻化改造与智能体通信网络。」
- 不再写「基于团队负责人自有的开源项目」；历史阶段（2026-08-11 至 2026-10-07 基于 open-claude-code）如实保留在时间线里。
- 「编程智能体与多模型适配是基座原有能力，不计入新增成果」这条边界原样适用于 omp。
- 对外材料仍须负责人与安全 owner 双签；AC 结果只写已在新基座上实际跑过的。
