# CLAUDE.md

本文件指导 Claude Code 及其他 AI 编码代理在**本仓库**中工作。开工前必读。

## 0. 这是什么仓库

**阡陌（AgentNest）** —— 云端常驻智能体交流网络。两条产品线：① 云端常驻编程智能体（网络中的**节点**）；② 智能体通信协作网络（连接节点的**网络**）。

| 项 | 内容 |
| --- | --- |
| 仓库性质 | **open-claude-code（`occ`）的下游 fork**，fork 布局，基座目录结构原样保留在仓库根 |
| 基座版本 | pin `848ad8c2c8daca9f5aa2410da555553e07700f5d` = tag **v2.38.3**，零改动快照导入 |
| 基座许可 | MIT，项目负责人自有，已在 npm 发布（`@sweetcornna/open-claude-code`） |
| 本仓库许可 | MIT，沿用基座（见 `LICENSE` / `NOTICE`） |
| 阡陌自有代码 | `packages/` 下 `@qianmo/*` workspace 包 + 对基座运行时的常驻化改造 |
| 成果边界 | pin 之后的全部提交即阡陌工作面：`git diff 848ad8c2..HEAD` |

**本仓库不做的两件事**（章程 N-13/N-14）：

- **不发布 npm 包、不打 tag、不跑基座的 release 流程。**`publish-npm.yml` 与 release 脚本相关门禁按 roadmap P0.4 在 S0 移除；在移除落地前它们仍在仓库里——**不要触发**。看到 `scripts/release.ts`、`CHANGELOG.md` 发布约定、npm 包名同步清单这类基座内容——**那是基座的发布面，不是我们的**，不要去维护它，也不要因为它"看起来该更新"而改它。
- **M0 期间不跟随上游发版。**pin 冻结在 v2.38.3。例外只有安全漏洞与依赖不可用，且由负责人决定并写入 `BASE.md`。

## 1. 基座的工程约定继续适用

**基座自己的 `CLAUDE.md` 是架构与工程约定的真源，其全部条款在本仓库继续有效。**本文件**不复制**它，只做两件事：声明它继续适用，并复述其中与阡陌开发最容易撞上的几条硬规则。

> 基座原文保留为根目录 [`BASE-CLAUDE.md`](./BASE-CLAUDE.md)（导入时经 `git mv` 改名，与 `BASE.md` 配对；亦可随时 `git show 848ad8c2:CLAUDE.md` 取到原文）。该放置方案为立项时的落地决定，S0（P0.2）评审可调整。**本文件是摘要，不是替代**——判断细节以 `BASE-CLAUDE.md` 为准。

### 1.1 必须记住的基座硬规则（摘要，完整表述见基座 CLAUDE.md）

**① `bun run precheck` 必须零错误通过。**typecheck + lint fix + test，任务完成后必跑。TypeScript strict 强制；生产代码禁止 `as any`（测试 mock 可用），优先 `as unknown as T` 或补 interface。

**② 路径与隔离不变式：所有路径都必须从 `src/config/paths.ts` 派生。**

绝对不要写 `join(homedir(), '.claude')` / `join(homedir(), '.occ')`、`~/.claude.json` 字面量、`'.claude'` / `'.occ'` 目录名字面量、`'claude'` 作为 CLI 名/进程名/socket 前缀、`'claude-cli'` 作为缓存命名空间。要什么就从 `paths.ts` 的 helper 取（`occConfigDir()` / `occConfigPath()` / `occGlobalConfigFile()` / `PROJECT_DIR_NAME` / `BIN_NAME` / `CACHE_NAMESPACE` / `XDG_SUBDIR`）。

这条对阡陌**格外**重要：阡陌节点态要在基座的隔离之上**再派生一层身份**（roadmap P0.3），而绕过 helper 的硬编码正是隔离机制唯一的失效方式。基座改造前有 12 处这样的硬编码，其中两处造成过真实事故。

**③ 「明确不改」清单。**某些字符串看着像品牌，实际承载协议，改了会以难以诊断的方式坏掉——见基座 `src/constants/brand.ts` 顶部注释。至少包括：系统提示词的 `You are Claude Code, Anthropic's official CLI for Claude` 前缀、`claude-code/<version>` User-Agent、OTel `service.name`、`CLAUDE.md`/`CLAUDE.local.md`/`AGENTS.md` 文件名、子进程环境变量 `CLAUDECODE=1`。**做阡陌改名时同样不动。**（对外表述纪律见章程 §5.2③：技术上保留 ≠ 对外宣称。）

**④ Mock 卫生。**`bun run check:mock-hygiene` 是硬零容忍门禁（也在 precheck 与 CI 里）。要点：

- Bun 的 `mock.module` 是**进程全局 last-write-wins**，不是 per-file 隔离；测试文件顺序由文件系统决定，不是字母序。
- **不要 mock 被测模块的上层业务模块**；mock 底层（如 axios）。
- 多文件共用模块必须用 `tests/mocks/` 下的**完整表面** helper，禁止手写部分表面的内联 `mock.module`。
- 顶层 `setup()` + `beforeAll` 里 `set()` + **`afterAll` 里 `reset()`**，缺 `reset()` 等于把覆盖装给本进程后续所有文件。
- specifier 统一 `.ts` 扩展名。
- **加 mock 前先想想能不能不加**——先试不带 mock 跑一遍。

**⑤ 循环依赖棘轮 `bun run check:cycles` 双向严格**（超预算与低于预算都 fail）。

**⑥ Feature flags**：`import { feature } from 'bun:bundle'` + `feature('FLAG_NAME')`，**只能直接用在 `if` 或三元的条件位置**（Bun 编译器限制），不能赋值变量、不能进箭头函数体、不能作 `&&` 链的一部分。

**⑦ 提交规范**：Conventional Commits + 中文描述（`feat:` / `fix:` / `docs:` / `chore:` / `refactor:`）。一个提交一件事，重构与行为改动分开提交。全部走 PR + 至少一人评审，不直推主干。

**⑧ 「指针不复制」铁律**：同一个事实只允许存在于一个地方，其他地方只放指针。本文件本身就在遵守它——所以它是摘要而不是副本。

### 1.2 容易误判的两处

- **`vendor/` 不是隔离目录。**本仓库根的 `vendor/` 是基座的**预编译原生二进制**（音频采集等），是正常构建资产。旧立项路线（历史提交 `67f6081` 及更早）里那个"存放外部参考代码、永不入库"的 `vendor/` 概念**已经废止**，与此同名但毫无关系。不要对它套用任何隔离规则。
- **基座里已删除的子系统不要去找、不要恢复**：Remote Control 传输层（`src/bridge/`、RCS、acp-link，约 45k 行，2026-07 删除）、`DIRECT_CONNECT`（`src/server/`）、`packages/weixin/`，以及 feature flag `CONTEXT_COLLAPSE` / `UDS_INBOX` / `LAN_PIPES` / `REVIEW_ARTIFACT` / `TEAMMEM` / `HISTORY_SNIP`。**其中 `LAN_PIPES` 与 `UDS_INBOX` 正落在阡陌产品线 ② 的方向上，但它们的代码已被删除——阡陌的跨节点传输是从零自研，不是"把它们打开"。**

## 2. 阡陌自有约定

### 2.1 立项文档是范围的唯一依据

- **`docs/dev/charter.md`（立项章程）是 M0 阶段的唯一范围依据。**凡章程 §3 未列入、或 §2.2 非目标已列出的事项，M0 内一律不做。写代码前先确认它在范围内。
- `docs/dev/roadmap.md` 是排期与任务包（含完成判据 DoD）的依据。
- `docs/dev/base-adoption.md` 是"基座给了什么、缺了什么"的依据。**判定某能力基座是否已有时查它，不要凭印象。**
- **范围变更必须回写章程并升版本号**，无书面变更不开工。
- 章程 §5（工程基座与法律边界）是强制条款，违反的提交一律回退。

**基座功能表很长，容易产生"什么都有了"的错觉。**基座既有的插件市场、Artifacts、语音、Computer Use 等能力**不纳入 M0 验收与演示**（章程 N-9）。不要"顺手"把它们接进阡陌的演示链路。

### 2.2 `@qianmo/*` 包规范

- 命名：`@qianmo/<domain>` **单段**（如 `@qianmo/protocol`、`@qianmo/transport`、`@qianmo/memory`）。不引入第二套命名。
- 形态：作为 **workspace 包**接入基座既有 workspace，放在 `packages/` 下。**不另建 monorepo。**
- 门禁：与基座代码同等对待——precheck 零错误、进 CI、遵守循环依赖与 mock 卫生棘轮。
- 协议级数值上限（跳数、消息体积、TTL、速率预算）**以 `@qianmo/protocol` 的 `LIMITS` 为唯一出处**，文档与其他包不得各写一份。

### 2.3 改造基座的姿势

**优先走扩展点，能不改核心就不改。**基座提供了多个扩展点：ACP、MCP、hooks、workspace 包。走扩展点的改动在将来同步上游时几乎不冲突；改核心的改动每次同步都要重解一遍。

**必须改基座核心文件时，PR 描述里注明"为什么扩展点不够用"。**（章程 T-5 对策④）

### 2.4 `BASE.md` 不可随手改

根目录 `BASE.md` 是基座溯源的唯一真源（上游、pin、导入日期、零改动声明、同步记录）。

- **由负责人维护，只有"导入"与"上游同步"两类事件才写它。**
- **任何在功能 PR 里顺手改 `BASE.md` 的提交一律回退。**

### 2.5 禁止破坏成果边界基线

阡陌的成果边界靠 git 历史证明：pin `848ad8c2` 之后的全部提交即本项目工作面。因此**以下操作一律禁止**：

- rebase 掉 pin 提交
- squash 跨越 pin 提交
- 强推改写 pin 之后的历史

这不是洁癖——它是软著申请与竞赛成果认定的技术基础（章程 §5.5、风险 L-1）。

### 2.6 对外表述

技术来源的统一口径见章程 §5.8。**不得**暗示与 Anthropic 存在授权、合作或背书关系；对外材料由负责人与安全 owner 双签后发出。代码里保留 Anthropic 相关标识是技术兼容需要（见 §1.1③），**不构成关联性主张**，也不得据此在口头或书面表述中暗示关联。

## 3. 常用命令

```bash
bun install                 # 安装依赖，workspace 内部包自动链接
bun run dev                 # 开发模式
bun test <path>             # 单个测试文件
bun run precheck            # typecheck + lint fix + test —— 任务完成后必跑，零错误
bun run check:cycles        # 循环依赖棘轮
bun run check:mock-hygiene  # mock 卫生棘轮
```

完整清单见 `package.json` scripts（其中发布类命令属于基座发布面，本仓库不用，见 §0）。
