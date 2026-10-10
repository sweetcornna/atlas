<!-- Copyright 2026 Qianmo AgentNest Team -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
# CLAUDE.full.md

本文件是本仓库的详细约定，从 [CLAUDE.md](CLAUDE.md) 的路由表按任务选章节读。omp 基座自己的开发规则不在这里，在根 [AGENTS.md](AGENTS.md) 的分界标记以下（omp 原文，逐字保留）。

基座切换的移植还在进行，设计与接口契约以 [docs/dev/base-switch-omp.md](docs/dev/base-switch-omp.md) 为准。本文与契约或代码不一致时，以契约和代码为准，并回写本文。

## 0. 这是什么仓库

**阡陌（AgentNest）**：云端常驻智能体交流网络。产品线：① 云端常驻编程智能体（网络中的**节点**）；② 智能体通信协作网络（连接节点的**网络**）；③ 本地—云端接力（M1 起，底座是单独仓库里的 Codex fork）。范围以 [docs/dev/charter.md](docs/dev/charter.md) 为准。

| 项 | 内容 |
| --- | --- |
| 仓库性质 | **oh-my-pi（`omp`）v18.8.4 的下游 fork**：omp 树原样在仓库根，阡陌代码在 `atlas/`、`demo/`、`docs/dev/` |
| 基座 | 上游 `can1357/oh-my-pi` 提交 `40e9368ef0458fd9073329cdff4174895f91bc6b`，MIT。零改动快照标签 `base-snapshot/omp-v18.8.8`（无父提交，树 `c7d2ecac…`），导入提交 `c9a87c8c`。现行机器 pin 见 `atlas/upstream/omp.json`，事件记录见 [BASE.md](BASE.md) |
| 许可 | 双许可：阡陌自有代码 AGPL-3.0-or-later（根 `LICENSE`），基座 MIT（根 `LICENSE.base`）。判据是路径：`git cat-file -e <当前 snapshot>:<路径>` 成功即基座文件；当前 snapshot 取 `atlas/upstream/omp.json`。文件头只是标记，范围与豁免见 [NOTICE](NOTICE) 一、许可 |
| 成果边界 | 工作面 `git diff <当前 snapshot>..HEAD`；基座边界 `git show --stat <当前 snapshot>`；工作记录 `git log 3380c88..HEAD`，其中 `d04a79dd`（occ 同步）与 `c9a87c8c`（基座切换导入）两笔是纯上游内容，举证时单独声明 |
| 历史 | 2026-08-11 至 2026-10-07 的基座是 open-claude-code（occ）v2.38.3 → v2.46.0；`3380c88`、`d04a79dd`、`base-snapshot/v2.46.0` 作为历史记录保留。occ 时代的约定（`src/config/paths.ts`、`feature()`、ACP、`OCC_*` 环境变量、mock 卫生与宏卫生棘轮）全部随 occ 失效 |
| 验收状态 | occ 上取得的 M0 / M1 验收证据是历史记录；在 omp 上各条 AC 的状态是「待在新基座上复跑」，只认实际重跑过的结果（章程 §4 v3.0 注） |

**本仓库不做的两件事**（章程 N-14、§5.7）：

- **不发布、不打发布标签、不跑 omp 的发布工具。**根 `package.json` 里的 `release`、`publish`、`ci:release:*` 等脚本是 omp 的发布面，留着是因为它们是 omp 原文，不是给本仓库用的。
- **不临时起意做上游同步。**同步按章程 §5.7（v3.1）自动生成并验证候选更新，合并与部署须人工审核；不得把普通功能任务当作运行同步或部署的授权，流程写在 [BASE.md](BASE.md)。

## 1. 基座规则

- **omp 文件归 omp 的规则管。**凡路径在 `atlas/upstream/omp.json` 的现行 snapshot 里的文件（`packages/`、`crates/`、根 `scripts/`、`python/`、`sdk/`、`docs/*.md`、根配置），开发规则见根 [AGENTS.md](AGENTS.md) 分界标记 `<!-- base: oh-my-pi v18.8.4 AGENTS.md, verbatim below -->` 以下的 omp 原文。本文不复述它。
- **先用扩展点，不改 omp 文件。**可用的扩展点：`omp --mode rpc`、扩展 API（`tool_call` 等事件、`registerTool`）、`set_host_tools`、`--config` 覆盖层、`models.yml` / `config.yml`。确实不够用才改 omp 文件，并在同一个 PR 里登记到 [docs/dev/base-modifications.md](docs/dev/base-modifications.md)，写明为什么扩展点不够。能做成纯插入或纯追加的不要就地改写上游的行。
- **omp 文件不加 SPDX 头**，改过也不加。
- **工具链分开。**omp 路径用 omp 自己的 oxlint、oxfmt 与各包 tsgo；阡陌路径用 biome 与 `tsgo -p tsconfig.atlas.json`。不要用 biome 重排 omp 文件，也不要用 omp 的 `fmt` 处理阡陌文件。改了 omp 文件的 PR 要跑 omp 的 `bun run test:ts`。
- **判断 omp 能做什么，读 omp 文档，不凭印象。**入口：`docs/rpc.md`、`docs/extensions.md`、`docs/hooks.md`、`docs/sdk.md`、`docs/models.md`、`docs/providers.md`、`docs/config-usage.md`、`docs/approval-mode.md`、`docs/session.md`。
- **omp 里有订阅 OAuth 的客户端身份冒用代码**（章程 §5.2③）。阡陌节点不走这些路径，不修改、不调用、不对外呈现它。

## 2. 阡陌约定

### 2.1 立项文档是范围的唯一依据

- [docs/dev/charter.md](docs/dev/charter.md) 是范围依据：§3 未列入、或 §2.2 已列为非目标的事不做。范围变更回写章程并升版本号。§5 是强制条款。
- [docs/dev/roadmap.md](docs/dev/roadmap.md) 是排期与任务包（含完成判据）的依据。
- [docs/dev/base-switch-omp.md](docs/dev/base-switch-omp.md) 是基座切换的设计与移植契约。occ 时代的基座能力盘点在 [docs/dev/base-adoption.md](docs/dev/base-adoption.md)，只对 occ 成立。
- omp 自带的编程智能体与多模型能力是基座原有能力，不计入阡陌成果，也不顺手接进演示链路。

### 2.2 `@qianmo/*` 包规范

- 位置：`atlas/packages/<domain>/`，包名 `@qianmo/<domain>` 单段。根 `package.json` 的 `workspaces.packages` 已含 `atlas/packages/*`，全仓只有一个 Bun 工作区，不另建 monorepo。
- 引用：跨包一律用包名（`@qianmo/<pkg>`），不跨包写相对路径；omp 只经它的 package exports 引入（`@oh-my-pi/pi-coding-agent/...`、`@oh-my-pi/pi-utils/...`），不 import omp 的内部文件。
- 新增阡陌文件带两行版权头（`// Copyright 2026 Qianmo AgentNest Team` / `// SPDX-License-Identifier: AGPL-3.0-or-later`，Markdown 用 `<!-- … -->`），代码风格 biome：2 空格、单引号、无分号。
- 协议级数值上限（跳数、消息体积、TTL、速率预算）只在 `@qianmo/protocol` 的 `LIMITS` 里写一次。
- 生产代码禁止 `as any`，优先 `as unknown as T` 或补 interface。

### 2.3 路径、身份与 omp 子进程隔离

节点状态的路径全部从 `@qianmo/paths`（`atlas/packages/paths/src/index.ts`）派生：

| 要什么 | 用什么 |
| --- | --- |
| 配置根 | `qianmoConfigDir()`：`QIANMO_CONFIG_DIR`（绝对路径）> `~/.qianmo`；其下的路径用 `qianmoConfigPath(...seg)` |
| omp 自己的状态 | `ompConfigRoot()` = `<配置根>/omp`；`ompAgentDir()` = `<配置根>/omp/agent`（`sessions/`、`config.yml`、`models.yml`、`agent.db`） |
| omp 子进程的环境 | `ompChildEnv(base)`：去掉 `OMP_PROFILE`、`PI_PROFILE`、`PI_CODING_AGENT_DIR`、`XDG_{DATA,STATE,CACHE,CONFIG}_HOME`、`CLAUDE_CONFIG_DIR`，设置 `PI_CONFIG_DIR`（相对 home 指向 `ompConfigRoot()`）与 `PI_NATIVES_DIR` |
| 记忆、CA、qmcode | `memoryBaseDir()`（`QIANMO_MEMORY_DIR`）、`caDir()`（`QIANMO_CA_DIR`，必须在任何配置根之外）、`qmcodeHome()`（`QMCODE_HOME`，只读引用） |
| 受保护的用户根 | `protectedConfigRoots()`：`~/.qianmo`、`~/.omp`、`~/.claude`、`~/.codex`、`~/.qmcode` 与当前配置根 |

- 不写 `join(homedir(), '.qianmo' | '.omp' | '.claude' | '.occ')` 或这些目录名字面量。门禁 `bun run atlas:check:identity-paths` 扫描阡陌生产代码，零容忍；允许写字面量的文件只有脚本里 `ALLOWLIST` 列出的几个，理由写在脚本里。
- 节点、测试与演示都不得读写用户自己的 `~/.omp`、`~/.claude`、`~/.codex`。
- 干净切换：`OCC_CONFIG_DIR`、`OCC_IDENTITY`、`OCC_SOURCE_COMMIT` 已删除，不留别名；对应的是 `QIANMO_CONFIG_DIR` 与 `QIANMO_SOURCE_COMMIT`。阡陌状态文件在配置根下的相对布局不变；occ 自己的会话与设置不迁移。

### 2.4 `BASE.md` 不可随手改

[BASE.md](BASE.md) 记录基座溯源事件，机器 pin 来自 `atlas/upstream/omp.json`；两者由 `atlas:check:omp-pin` 核对一致。只在「导入」与「上游同步」两类事件时改动，自动候选的更新须随 PR 审核。功能 PR 里顺手改它的提交一律回退。

### 2.5 成果边界基线

历史起点是 occ 导入提交 `3380c88`；当前基座的度量基线是 `atlas/upstream/omp.json` 指定的 snapshot 标签；`d04a79dd` 与 `c9a87c8c` 是两笔纯上游提交。以下操作一律禁止：

- rebase 掉 `3380c88`，或 squash 跨越 `3380c88`、`d04a79dd`、`c9a87c8c`；
- 强推改写这些提交之后的历史；
- 移动或删除任何 `base-snapshot/*` 标签（含 occ 时代的 `base-snapshot/v2.46.0`）；
- 把上游同步内容与阡陌改动放进同一个提交（会让「哪些行来自上游」无法分离）。

这是软著申请与竞赛成果认定的技术基础（章程 §5.5、风险 L-1）。

### 2.6 对外表述

- 标准句（章程 §5.8）：「阡陌基于开源项目 oh-my-pi（MIT 许可）构建，在其上实现常驻化改造与智能体通信网络。」「基于团队负责人自有的开源项目」不再用于描述现状；2026-08-11 至 2026-10-07 这段如实写「该阶段基于 open-claude-code」。
- 对外材料按章程 §5.8 第 1–3 条由撰写人自查（第 4 条双签已于 v2.21 废止）：说清成果边界；不暗示与 Anthropic、OpenAI、Google、Stencil Labs 或 Pi 作者存在授权、合作、背书关系；被问到溯源如实说。
- 验收结果只写在 omp 上实际跑过的；「未生成」「未评估」这类声明照实保留。`custom-openai` 预设的「已评估」是在 occ v2.47.2 上取得的，切换后置回未评估，等 AC-P6 在 omp 上重跑。
- 不把 omp 的订阅 OAuth 身份冒用代码当作阡陌能力描述。

## 3. 命令、测试与门禁

环境：Bun ≥ 1.4（`.tool-versions` 钉 1.4.2），用 `bunx` 不用 `npx`。omp 原生插件 `pi_natives.<platform>.node` 要先构建：`bun run build:native`（需要 `rust-toolchain.toml` 指定的 Rust nightly 与 ninja，细节见 omp 的 `docs/natives-build-release-debugging.md`）。

```bash
bun install
bun run build:native            # omp 原生插件
bun run qm -- --help            # qm 源码模式入口（atlas/packages/node/src/cli.ts）
bun run precheck                # 阡陌类型检查 + biome 修复 + identity-paths + license-headers + 阡陌测试；会改文件
bun run verify                  # 推送 / 发 PR 前；只读的全量门禁
bun run atlas:test [<目录> …]    # 阡陌测试分片，可只跑指定目录
```

完整脚本以根 `package.json` 的 `scripts` 为准（阡陌的都带 `atlas:` 前缀，另有 `qm`、`qianmo:acceptance`、`precheck`、`verify`）。

**`precheck` ≠ `verify`。**`precheck` 跑 `atlas:lint:fix`，会改写 `atlas/`、`demo/` 下的文件，跑完看 `git diff`。`verify` 换成只读的 `atlas:lint:ci`，并加上 `atlas:check:cycles`、`atlas:check:unused`、`atlas:sbom -- --check`、omp 的 `check:ts`（证明阡陌没碰坏基座）、`atlas:build:qm` 与 `atlas:check:qm-smoke`。

### 3.1 测试

- 入口是 `atlas/scripts/test-shards.sh`（`bun run atlas:test`）：每个 `atlas/packages/*` 一个分片，另有 `atlas/tests/*`、`demo/lib`、`demo/env`、`atlas/scripts`；每个分片一个 `bun test` 进程、带 `--isolate`，JUnit 报告写到 `test-reports/`。
- 预载 `atlas/tests/preload.ts` 只经命令行传入，根 `bunfig.toml` 不加预载（omp 自己的测试从同一个根跑）。它清掉开发者 shell 里的凭据与改变状态根的变量，把配置根与 CA 目录指到每进程的临时目录，并设置 `PI_TEST_RUNTIME=1`。
- 跑单个文件：`bun test --preload ./atlas/tests/preload.ts ./atlas/packages/<pkg>/test/<name>.test.ts`。路径写成 `./` 开头，否则 Bun 会当成子串过滤、把 omp 的测试也拉进来。
- 测试里起的任何 omp 子进程都用 `ompChildEnv()` / `ompSpawnEnv()`，`QIANMO_CONFIG_DIR` 指向临时目录；测试不得碰 `~/.omp`、`~/.qianmo`、`~/.claude`。需要真跑一轮 RPC 时，用 omp 的假 OpenAI 服务 `packages/coding-agent/test/rpc-wire/fake-openai-server.ts`，经 `models.yml` 自定义 provider 指过去。
- **不对 omp 内部模块做 `mock.module`。**`mock.module` 是进程全局、后写覆盖先写的；阡陌只依赖 omp 的公开面（RPC、扩展 API、`models.yml` / `config.yml`），测试也只在这些面上替身。修 bug 先写出会红的测试。

### 3.2 门禁

| 门禁 | 命令 | 性质 |
| --- | --- | --- |
| 类型 | `bun run atlas:typecheck` | `tsgo -p tsconfig.atlas.json`，覆盖 `atlas/**`、`demo/**` |
| 格式与 lint | `bun run atlas:lint:fix` / `atlas:lint:ci` | biome，`biome.json` 的 `files.includes` 只含 `atlas/**`、`demo/**` |
| 身份路径 | `bun run atlas:check:identity-paths` | 零容忍，见 §2.3 |
| 版权头 | `bun run atlas:check:license-headers` | 三个方向硬零，判据快照取 `atlas/upstream/omp.json`；`-- --report` 只报数 |
| 循环依赖 | `bun run atlas:check:cycles` | madge，从 `qm` 入口走阡陌模块图；预算 `atlas/scripts/cycle-budget.json`，双向严格，改进后 `-- --update` |
| 死代码 | `bun run atlas:check:unused` | knip，配置 `atlas/knip.json`，只覆盖阡陌工作区；预算 `atlas/scripts/unused-budget.json`，双向严格 |
| SBOM | `bun run atlas:sbom -- --check` | 生成 `docs/dev/sbom-m0.{json,md}`，存在强传染或受限许可组件即失败 |
| omp 自检 | `bun run check:ts` | omp 原有脚本 |

版权头与身份路径两道门禁依赖 `base-snapshot/*` 标签，浅克隆先补拉：`git fetch --depth 1 origin 'refs/tags/base-snapshot/*:refs/tags/base-snapshot/*'`。

**knip 需要真实安装的 `node_modules`。**在 git worktree 或拷贝来的检出里，`node_modules` 缺失或不是在本目录装出来的，`atlas:check:unused` 会解析出另一张依赖图、报出假的未使用项。先在该目录里重跑一次 `bun install`；仍然红再到主检出或干净 clone 上复核，报「门禁坏了」时附上那边的输出。

### 3.3 提交与评审

Conventional Commits（`feat:` / `fix:` / `docs:` / `chore:` / `refactor:`，可带 scope），一个提交一件事，重构与行为改动分开。全部走 PR 并经评审，不直推 `main`。流程见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 4. 运行时要点

设计细节见 [docs/dev/base-switch-omp.md](docs/dev/base-switch-omp.md) §3–§5，这里只记容易踩的几条。

- **omp 只能作为子进程运行。**omp 的 CLI 会重入 `Bun.main` 启动 worker，把它 import 进 `qm` 会把 `qm` 的入口交给那些 worker。启动一律走 `atlas/packages/node/src/omp/launch.ts` 的 `ompArgv(args)` 与 `ompSpawnEnv(extra)`；子进程 cwd 是该智能体的工作区，不是仓库根（避免根 `bunfig.toml` 影响子进程）。
- **`QIANMO_OMP_ENTRY`**：覆盖 omp 入口；取值 `self` 时子进程是 `<qm 二进制> agent …`，用于编译产物 `dist/qm-<target>`（`bun run atlas:build:qm`，qm 与 omp CLI 编进同一个二进制）。源码模式下解析工作区里 `@oh-my-pi/pi-coding-agent` 的 `bin.omp`。
- **每个活跃会话键一个 RPC 子进程。**常驻宿主按 agent + contextId 维护 `omp --mode rpc` 子进程池，`open_session` 绑定到 `qianmoConfigPath('resident', 'sessions', <agent>, <key>)`；启动参数为 `--mode rpc --no-ui --extension <@qianmo/extension> --config <节点覆盖层>`，再按模型服务的选择加 `--model <provider>/<modelId>`、`--thinking <level>`。occ 时代的 `qianmo/*` ACP 通知在 omp 上的对应信号见契约 §4.3。
- **`@qianmo/extension`** 由宿主以 `--extension` 加载进每个 RPC 子进程，配置经 `QIANMO_EXTENSION_CONFIG`（JSON 文件路径）传入，负责常驻权限硬顶（`tool_call` 拦截；omp 对 `tool_call` 处理器的异常与超时按拦截处理，见 omp `docs/extensions.md`）、子智能体守卫与工具面裁剪、写入带阡陌 `messageId` 的输入身份条目。
- **模型服务写 omp 的配置**：档案编译成 `ompAgentDir()` 下的 `models.yml`、`config.yml`（多钥时还有 `agent.db` 凭据池），omp 子进程原生读取。常驻宿主只在空闲时提交待生效配置，然后回收子进程，用 `nodeModelSelection()` 的结果启动新的子进程。固定的默认值（`providers.cacheWarming: off`、网关类 provider `compat.statefulResponses: false` 等）见契约 §5。
- **原生插件**：omp 子进程经 `ompChildEnv()` 拿到 `PI_NATIVES_DIR=<配置根>/omp/natives`；插件没构建或架构不符时 omp 起不来，依赖它的阡陌测试随之失败。
- **`qm --version`** 输出 `qm <@qianmo/node 版本> (omp <omp 版本>) <源提交>`；源提交依次取构建常量、`QIANMO_SOURCE_COMMIT`、`git rev-parse`，都没有时为 `unknown`。
- **随 occ 消失、不要去找的东西**：`occ` / `occ-bun` 命令、`--acp` 常驻宿主与 `qianmo/*` ACP 通知、`qianmo_notify` 之外的 occ 内部补丁、`src/config/paths.ts`、`feature()` 宏、`modelCompat` / `promptCache`、`dist/cli-qianmo.js`。节点智能体的工具名换成 omp 的（`read`、`edit`、`bash`、`task` …），网络协议字段不变。
