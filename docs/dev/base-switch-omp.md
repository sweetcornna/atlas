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

编译入口在分派任何命令或 worker 之前，先对当前进程应用 `ompChildEnv()` 与受管凭据字面量清理；`resident` 宿主加载原生库时也使用 `<QIANMO_CONFIG_DIR>/omp/natives`，不等到启动 agent 子进程才隔离。显式 `QIANMO_CONFIG_DIR`、记忆等阡陌路径配置保留；外部 `PI_*` 重定向仍按上述隔离契约覆盖。

### 3.2 `@qianmo/mailbox`

独立重写（不拷贝 occ 代码），对外行为与旧 `teammateMailbox.ts` 一致：

- 路径 `qianmoConfigPath('teams', <team>, 'inboxes', <agent>.json)`；文件是 JSON 数组；
- 锁：`proper-lockfile`，锁文件 `<inbox>.lock`，重试 `{retries: 10, minTimeout: 5, maxTimeout: 100}`；
- 上限：单条正文 64 KiB（`MAX_MAILBOX_MESSAGE_TEXT_BYTES`），文件 4 MiB，压缩后保留 2 MiB，三级压缩顺序与旧实现一致；写入走临时文件 + rename；
- 导出：`writeToMailbox`、`readMailbox`、`markMessagesAsReadBySnapshot`（含 `readBefore` 参数与计数返回值）、`formatTeammateMessages`、`isStructuredProtocolMessage`、`TEAM_LEAD_NAME` 与适配器测试用到的 `sanitize*`。

### 3.3 `@qianmo/node`（`qm` 命令）

- `bin: { qm: "src/cli.ts" }`，Bun 直接执行；`src/cli.ts` 是显式分派表：`resident`、`audit`、`resident-wake`、`console`、`ca`、`cert`、`watch`、`memory`、`provider`、`handoff`、`agent`（转入 omp CLI，见 §4.4）、`--version`、`--help`。
- 每个命令模块导出 `run(argv: string[]): Promise<number>`，位于 `src/commands/<name>.ts`；命令、旗标与输出格式保持不变，帮助文本里的 `OCC_*` 说明换成 `QIANMO_CONFIG_DIR`。
- `handoff` 接力节点仍使用独立的 qmcode app-server（Codex 分支）；它不是 occ 智能体运行时，不随本次 resident/agent 换基座替换。导入转录只写入该 app-server 的隔离目录，不写用户的 `~/.claude`。
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

- 宿主维护 omp RPC 子进程池：**每个活跃会话键（agent + contextId）一个进程**。RPC `open_session` 传 `{sessionDir, provider?, modelId?}`，会话目录在 `qianmoConfigPath('resident', 'sessions', <agent>, <session UUID>)`；会话键到 UUID 的映射持久化，空闲回收沿用 `session-gc`。
- 启动参数包括 `--mode rpc --no-extensions --extension <节点扩展绝对路径> --config <节点覆盖层> --approval-mode <write|always-ask> --tools <显式工具表>`，以及模型与 thinking 参数。未接入宿主审批时另加 `--no-ui`；接入审批时保留 RPC confirm 帧，由宿主按精确请求处理。禁止从工作区自动发现扩展；`--allow-workspace-edits` 对应 write 模式及扩展工作区规则，其余为只读。
- 环境经过 `residentOmpEnvironment(ompSpawnEnv())`：隔离 omp 根，清除 `PI_CONFIG_FILES`、`PI_EDIT_VARIANT` 和与模型字面配置碰撞的环境变量名。已托管（state v2）节点额外清除继承的 provider 凭据及 `CLAUDE_CODE_*`；未托管节点保留操作者显式配置的 provider 环境。

### 4.3 信号映射

| occ 时代 | omp RPC 时代 |
|---|---|
| `qianmo/input-accepted`（转录已写入） | `message_end` 只触发检查；宿主确认同一 JSONL 已有用户条目及扩展写入的 `messageId` / `userEntryId` 身份条目，并 fsync 后才 admitted、read、ACK |
| `qianmo/input-status`（崩溃后查询某消息是否已入会话） | 宿主扫描会话 JSONL，核对身份条目链接到的实际用户条目；孤立身份条目不算受理 |
| `qianmo/session-activity`（忙/闲） | `agent_start` / `session_settled`（`prompt_result.sessionSettled`） |
| `qianmo/upstream-status`（上游 HTTP 状态） | `message_end.errorStatus`、`prompt_result.error.httpStatus`、`auto_retry_*` |
| `qianmo_notify` 工具 | `set_host_tools` 注册同名 host tool，`host_tool_call` 回到宿主 |
| `withResidentHardline` | `@qianmo/extension` 的 `tool_call` 拦截 |
| `_meta.permissionMode` | 每进程 `--config` 覆盖层 |
| `interrupt(reason)` | RPC `abort`；原因由宿主写入自身的交付账本与审计（omp 转录里的中断标记文字改为 omp 原生） |
| `unstable_resumeSession`（AC-1） | 重启后 `open_session` 同一会话目录，并显式传 `provider`/`modelId` |

### 4.4 编译产物

Fleet 载荷不带 `node_modules`，因此 `atlas:build:qm` 用 omp 的二进制编译流程（嵌入原生插件）把 `qm` 与 omp CLI 编进一个 `dist/qm-<target>`；`qm agent …` 进入 omp 的 CLI 主函数，宿主拉起的子进程就是同一个二进制的 `agent --mode rpc …`，符合 omp worker 重入约定。源码模式（开发、本地演示、沙箱内源码树）直接 `bun atlas/packages/node/src/cli.ts`。

常驻权限扩展也在构建时独立打包成不依赖工作区包的 ESM，并作为源码常量嵌入二进制。编译产物在节点私有会话目录生成按 SHA-256 命名的 `.mjs`，拒绝同名符号链接或与内嵌内容不同的文件，再将绝对路径传给 omp。该路径不依赖部署目录中的 `node_modules`；源码模式仍解析工作区扩展。构建后 smoke 必须启动真实 compiled resident，验证正常文件工具和受保护根拒绝链路。

## 5. 模型服务

- **保留**：中枢侧 `@qianmo/providers`（类型、校验、预设、协议、指纹、密钥引用）、控制台模型服务页、密钥库、ssh 执行器、两阶段下发与空闲提交。
- **重写编译目标**：一个档案编译成 omp 的 `models.yml`（每档案一个自定义 provider `qm-<profileId>-<urlhash>`，显式 `api`、每模型 `thinking` / `compat` / `contextWindow` / `maxTokens`）与 `config.yml`（`modelRoles` 带 `:level`、`defaultThinkingLevel`、`retry.*`、`providers.cacheRetention`），凭据写 `models.yml` 的 `apiKey`（单钥）或 omp `agent.db` 凭据池（多钥）。文件落在 `ompAgentDir()`。
- **固定 omp 默认值**以免行为漂移：`providers.cacheWarming: off`、网关类 provider `compat.statefulResponses: false`、`defaultThinkingLevel` 按档案显式给出、`retry.fallbackChains` 为空。
- **删除**：`modelCompat` 30 个源文件中除 `capabilities.ts`（重写）外全部、`promptCache` 全部、`@ant/model-provider` 下的阡陌文件——对应怪癖 omp 的 `packages/ai` 与目录规则已原生处理。
- **密钥池语义**：多钥交给 omp 原生池，按会话固定选择，额度耗尽时轮换；瞬时 429 按原生退避处理。旧 `fill_first` / `round_robin` / `least_used` 档案字段保留可读，但节点明确提示不保证旧策略。自定义 Anthropic 端点同时使用多钥与 `x-api-key` 时拒绝下发，因为公共接口没有选中密钥的动态 header resolver；官方 `api.anthropic.com` 的该组合、Bearer 多钥，以及自定义端点的单钥仍可配置。
- **启动凭据探针**：真实 omp 单回合使用独立临时配置根（目录 0700、模型文件 0600），常驻探针预算仍为 10 秒，确认子进程退出后才清理及放行下一代 RPC；退出未知时保留现场并阻断后续生成。为避免同节点重复冷解包，在 POSIX 上只把临时 `omp/natives` 链接到从受信节点环境派生的已有原生缓存；配置、凭据与会话不共享。复用前检查配置根、omp 目录和有界缓存树的同 UID、无组/其他用户写权限、无符号链接。仅当配置根与 omp 目录均严格 0700 时，完整预检后允许将加载器正常生成的 0775 缓存/版本目录通过不跟随符号链接的目录描述符收紧为 0755；逐项及最终身份重验通过后才共享。普通文件不改权限或内容，不安全树、不支持操作或任何失败仍走私有冷路径；中途 chmod 失败可能留下更严格的目录权限，但不放行缓存共享。此边界不隔离同 UID 进程，也不承诺缓存只读：原生加载器仍会维护版本时间和清理旧版本。编译入口再次清理 `PI_*` 后仍从相同私有路径读取，不能用继承的 `PI_NATIVES_DIR` 绕开路径规则。
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
- 对外材料按章程 §5.8 第 1–3 条由撰写人自查（第 4 条双签已于 v2.21 废止）；AC 结果只写已在新基座上实际跑过的。

## 10. 上游自动更新与审核

负责人在 2026-10-08 选择「自动同步上游并验证，部署前审核」。机器 pin 为 [`atlas/upstream/omp.json`](../../atlas/upstream/omp.json)，溯源记录为 [`BASE.md`](../../BASE.md)。[`sync-omp.yml`](../../.github/workflows/sync-omp.yml) 每天 UTC 06:17 或手动触发。

1. 只读 job 查询固定上游 `can1357/oh-my-pi` 的最新稳定版。[`sync-omp.ts`](../../atlas/scripts/sync-omp.ts) 在独立 checkout 中创建不含上游历史的无父快照，三方应用新旧树差异。旧标签不移动，阡陌命名空间与本地新增路径碰撞、合并冲突均停止并留存证据；上游对阡陌已删除基座文件的改动不应用，单独存补丁并列入草稿 PR 正文。
2. 候选依次执行冻结依赖安装、native 构建、阡陌静态/类型/身份/许可/依赖门禁、SBOM、omp 检查及测试、阡陌全量分片、独立的真实 PostgreSQL 共享注册中心检查、qm 编译与独立环境 smoke、AC-1 崩溃恢复。数据库检查缺工具或失败均阻断候选，不能沿用常规分片的跳过结果。每次重新验证先撤销旧的成功记录，失败后不能凭上次的 `verified-head` 打包。任何失败都不会发布候选；不会自动抬高质量预算。
3. 验证通过后，单独有写权限的 job 只导入已验证 Git bundle，不执行候选代码。它以无 force 的原子 push 创建 `codex/sync-omp-<版本>` 分支和新快照，再建立 draft PR。仓库设置须允许 Actions 建 PR（`can_approve_pull_request_reviews`，2026-10-10 已打开）；该设置被关闭时，改开一个同名 issue，附对比链接与审查说明，由审核人从链接建 PR。已有同名分支保留供审核；若它还没有 PR 或 issue，下一次运行补上。PR、检查日志和溯源变更一起接受评审。
4. 合并和节点部署保持人工审核。此流程没有部署命令，不升级运行中的节点。工作流须合入默认分支，且仓库允许 Actions 创建 PR，定时运行才会生效。

离线 fixture 验证覆盖无更新、新版本、上游删除、三方冲突、本地新增碰撞、上游改动阡陌已删除文件、快照无父及历史隔离。2026-10-10 合入 main 后首跑（上游 v18.8.7）停在上游改了已删除的 `.github/workflows/ci.yml`，由此补上已删除路径的处理。测试日志、补丁、候选 metadata 和失败原因保留为 workflow artifact（30 天）。
