<!-- Copyright 2026 Qianmo AgentNest Team -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# 对 omp 基座文件的改动清单

> **定位**：章程 §5.6③ 与 §5.4 要求的登记处。凡快照 `base-snapshot/omp-v18.8.8` 里存在的路径被阡陌修改或删除，都在本文登记一行，写明改了什么、为什么扩展点不够用。新增的阡陌文件（不在快照里的路径）不登记。
>
> occ 时代（2026-08-11 至 2026-10-07）的改造点记录在 [`base-modifications-occ.md`](./base-modifications-occ.md)，已被本文取代。

## 1. 方法

基座文件的判据只看路径：路径在快照树里即为 omp 基座文件（MIT，不带 SPDX 头），不在即为阡陌文件。改动面用下面这条命令现算，只取修改（`M`）与删除（`D`）两类：

```sh
git diff --name-status --no-renames base-snapshot/omp-v18.8.8 HEAD | awk '$1!="A"'
```

`A` 类是阡陌新增的路径（例如 `.github/workflows/atlas.yml`、`.github/ISSUE_TEMPLATE/bug_report.md`、`LICENSE.base`、`atlas/` 下的全部文件），不在本文范围内。命令依赖 `base-snapshot/*` 标签，浅克隆取不到标签时先补拉：`git fetch --depth 1 origin 'refs/tags/base-snapshot/*:refs/tags/base-snapshot/*'`。

## 2. 当前清单（2026-10-08 按 §1 的命令核对；HEAD 为 `d8594e4b`，加上工作区里尚未提交的移植改动）

### 2.1 修改

| 文件 | 改了什么 | 为什么扩展点不够用 |
|---|---|---|
| `package.json` | 在 omp 原文基础上：`workspaces.packages` 追加 `atlas/packages/*`；`scripts` 追加 `atlas:` 前缀脚本、`qm`、`qianmo:acceptance`，以及 omp 原文没有的 `precheck` / `verify`（阡陌门禁，`verify` 内含 omp 的 `check:ts`）；devDependencies 追加 `@biomejs/biome`、`husky`、`knip`、`madge`；`lint-staged` 追加 `atlas/**`、`demo/**` 两条 biome 规则；`author` 字段被格式化为多行。omp 既有脚本名一个未改 | 根工作区只有一个 `package.json`，阡陌包要进同一个 Bun 工作区、阡陌门禁要能从根调用，只能改它 |
| `.oxlintrc.json` | `ignorePatterns` 只追加 `atlas/**`、`demo/**`；omp 路径与全部原规则不变 | omp 的 `check:tools` 固定调用 `oxlint .`，必须在该扫描器配置中分开阡陌目录；这两个目录由 biome 独立检查 |
| `packages/coding-agent/test/cli-license.test.ts` | `omp --license` 的预期许可文本从 `LICENSE.base` 读取；仍逐字核对内嵌 MIT 与第三方声明 | 双许可布局的根 `LICENSE` 属于阡陌 AGPL，omp 的 MIT 正文位于 `LICENSE.base`；测试硬编码根文件名，没有配置扩展点。运行时输出与其断言强度不变 |
| `packages/coding-agent/scripts/compile-binary.ts` | 显式 Bun runtime 模板与交叉编译 target 同时传递，防止 ARM 构建机常量被烘入 x64 产物 | 上游 helper 把两选项写成互斥分支；Atlas 调用方已提供二者，仍会在 helper 内丢失 target，无法通过现有参数修复。真实 x64 部署复现 native loader 错选 linux-arm64；回归固定这一组合 |
| `packages/natives/scripts/embed-native.ts` | 增加显式 `x64BaselineOnly` 打包选项，Atlas 的便携 x64 构建只嵌基线插件；缺少基线或目标架构不符时拒绝，默认 omp 双插件行为不变 | 原 helper 无筛选入口，冷启动同步解压 modern 与 baseline 两套约 190 MB 插件，引发现场内存压力；通过构建参数减少归档体积，复用既有 loader 的 baseline 回退，不放宽资源/就绪闸门 |
| `bun.lock` | 随根工作区追加阡陌包与其依赖而重新生成 | 生成文件，跟随 `package.json` |
| `AGENTS.md` | 文件顶部插入一段阡陌指针（指向 `CLAUDE.md`、`CLAUDE.full.md`、`CONTRIBUTING.md`）和标记 `<!-- base: oh-my-pi v18.8.8 AGENTS.md, verbatim below -->`，标记以下是 omp 原文，逐字未改 | 跨工具约定只认这个文件名；纯插入在同步时不与上游 hunk 冲突 |
| `README.md` | 文件顶部插入阡陌部分（项目简介、基座说明、仓库布局、快速开始、成果边界、许可）和标记 `<!-- base: oh-my-pi v18.8.8 README.md, verbatim below -->`，标记以下是 omp 原文 | GitHub 首页只渲染根 `README.md`；纯插入 |
| `CONTRIBUTING.md` | 同上，顶部插入阡陌贡献指南和标记 `<!-- base: oh-my-pi v18.8.8 CONTRIBUTING.md, verbatim below -->`，标记以下是 omp 原文 | 贡献入口只有这一个文件名；纯插入 |
| `LICENSE` | 内容整体换成 AGPL-3.0 正文；omp 的 MIT 原文逐字移到新路径 `LICENSE.base` | 章程 v2.16：阡陌自有层以 AGPL 发布，根 `LICENSE` 是该层的许可文件 |
| `.gitignore` | 末尾追加「阡陌（atlas/）追加」一段：`.playwright-mcp/`、`.demo-env/`、`/test-reports/`、`/.source-commit` | 只有一个根忽略文件；纯追加 |
| `.github/ISSUE_TEMPLATE/config.yml` | 换成阡陌的联系链接（私密安全报告、项目文档、基座问题上报入口），关闭空白 issue；基座入口改指 omp 上游 | issue 模板配置是仓库级的，没有扩展点 |
| `.github/PULL_REQUEST_TEMPLATE.md` | 换成阡陌的 PR 模板（Conventional Commits、AC-8 边界用例栏、提交前自查）；自查清单改指 `@qianmo/paths` 与 `CLAUDE.full.md` §2.3、§3 | 同上 |

### 2.2 删除

| 文件 | 为什么删除 |
|---|---|
| `.github/workflows/ci.yml`、`.github/workflows/bun-cache-warm.yml`、`.github/workflows/nix.yml` | 依赖 omp 的自托管 runner，在本仓库跑不起来；含发布类步骤，本仓库不发布（章程 N-14）。阡陌 CI 是新增的 `.github/workflows/atlas.yml` |
| `.github/ISSUE_TEMPLATE/bug_report.yml`、`feature_request.yml`、`question.yml` | omp 的 issue 模板指向 omp 的上游流程；阡陌用新增的 `bug_report.md`、`feature_request.md` |
| `.github/SECURITY.md` | omp 的安全策略把报告引向 omp 维护者；阡陌的安全策略在根 `SECURITY.md`，两份同在会让 GitHub 显示错误的报告通道 |

## 3. 规则

1. 改或删 omp 文件之前，先确认 omp 的扩展点（`--mode rpc`、扩展 API 的 `tool_call` 等事件、host tools、`--config` 覆盖层、`models.yml`）确实不够用（章程 §5.4、§7.2⑦）。
2. 每一处改动在**同一个 PR** 里登记到 §2，写明改了什么与理由；PR 描述同样写明「为什么扩展点不够用」。
3. 能做成纯插入或纯追加的，就不要就地改写上游的行，这样选择性同步（章程 §5.7）时差异不会撞上游的 hunk。`AGENTS.md`、`README.md`、`CONTRIBUTING.md` 的「阡陌在上、omp 原文在标记之下」就是这条规则的例子：标记以下不要就地改，要更新等上游同步带进来。
4. omp 文件不加 SPDX 头，改过也不加（判据是路径，见 `NOTICE` 一）。
5. 改了 omp 文件的 PR 要跑 omp 自己的 `bun run test:ts`（`base-switch-omp.md` §6）。
6. 每次上游同步后，用 §1 的命令重算，把已被上游吸收或已撤回的行从 §2 删掉。
