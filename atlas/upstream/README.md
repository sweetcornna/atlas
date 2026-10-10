<!-- Copyright 2026 Qianmo AgentNest Team -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# omp 候选同步

`omp.json` 固定当前基座的版本、上游提交、原始 tree 与无父快照标签。它与 `BASE.md` / `NOTICE` 一起受 `bun run atlas:check:omp-pin` 校验；许可证归属和 SBOM 读取同一份固定值，不按“本机最新 tag”猜测。

`.github/workflows/sync-omp.yml` 合并进默认分支后，每天 UTC 06:17 或手动触发：

1. 只从 `can1357/oh-my-pi` 的 GitHub latest release 接受非 draft、非 prerelease 的 `vX.Y.Z` 版本。当前版本或更旧时明确 no-op。
2. 在独立 clone 中导入原始树，校验 tree SHA，创建无父 `base-snapshot/omp-v<版本>`。旧快照绝不移动；上游祖先提交不进入候选仓库。
3. 三方应用旧、新快照的二进制补丁。阡陌新增路径碰撞、Atlas 命名空间侵入、修改冲突均失败并保存补丁及冲突记录。自动化不替人选冲突的一边。上游改动了阡陌已删除的基座文件（登记在 `docs/dev/base-modifications.md` §2.2，例如上游的 `.github/workflows/ci.yml`）时，删除保持不变：这些路径不进应用的补丁，上游差异另存 `upstream-removed-locally.patch`，路径列进草稿 PR 正文，由评审决定是否手工移植。
4. 分开提交上游补丁与新的来源记录。检查依赖安装、native 构建、阡陌静态门禁、SBOM、omp 类型与测试、完整阡陌分片、qm 编译/worker 冒烟和 AC-1 本地恢复。不会自动放宽预算。
5. 仅全部通过的候选生成 Git bundle。在独立、持写权限的 job 中发布新候选分支和新快照标签，创建 draft PR；仓库不允许 Actions 建 PR 时改开同名 issue 交接。验证 job 不持持久写凭据；发布 job 不执行候选代码。已有候选不覆盖。

需要仓库允许 GitHub Actions 创建 PR，并允许新 `codex/sync-omp-*` 分支与新快照标签。若规则拒绝，工作流报失败，证据 artifact 仍保留 30 天。合并和节点部署仍要审核，没有自动 merge、release、fleet rollout 或原生 `omp update` 步骤。

本轮仅实现和离线测试，尚未 push、运行远端工作流或创建真实 PR。

本地检查当前来源：

```sh
bun run atlas:check:omp-pin
```

生成代码的宿主验证使用 macOS `sandbox-exec` 或 Linux `bubblewrap`：任务树和受保护测试只读、网络禁用、HOME/TMPDIR 独立。缺少 OS sandbox 时拒绝执行；Linux CI 会安装 bubblewrap。应用工具边界与宿主测试隔离是两个独立层。

编程任务还由可信宿主持有独立期望值：隔离子进程只返回随机输入的函数结果，宿主逐项比对。生成代码伪造 `bun test` 摘要或提前 `process.exit(0)` 不能通过；类型任务另由只读的 TypeScript 编译器验证类型约束。

准备候选必须从干净的已提交检出运行，输出目录应在仓库外且尚无 candidate：

```sh
bun atlas/scripts/sync-omp.ts prepare /tmp/omp-sync-review
bun atlas/scripts/sync-omp.ts verify /tmp/omp-sync-review
bun atlas/scripts/sync-omp.ts bundle /tmp/omp-sync-review
```

脚本本身从不 push、发 PR、合并或部署。失败保留 `candidate/`、`upstream.patch`、`conflicts.txt`、逐门禁日志；检查成功后生成 `verified-head`，打包前再次确认 HEAD 相同。

`qm agent update` 是 omp 原生命令，面向 PATH 中的 `omp` 安装，并不更新阡陌的源码或已编译 qm。阡陌未来升级走此候选审查流程，再由审核后的 qm 部署流程执行。
