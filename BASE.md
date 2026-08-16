# 基座溯源

- 基座：open-claude-code（CLI 名 `occ`）
- 上游仓库：https://github.com/sweetcornna/open-claude-code
- 导入来源：上游仓库的本地副本 /Users/cornna/project/open-claude-code 的已提交快照（导入当时使用的本地克隆，非权威地址；权威地址为上一行的上游仓库 URL）
- 基座提交：848ad8c2c8daca9f5aa2410da555553e07700f5d（chore(release): v2.38.3）
- 基座版本：v2.38.3 · 许可：MIT（见根目录 LICENSE）
- npm 侧佐证（实查 2026-08-15）：npm 包 `@sweetcornna/open-claude-code` 的 `repository.url` = `git+https://github.com/sweetcornna/open-claude-code.git`；v2.38.3 的 `gitHead` = `848ad8c2c8daca9f5aa2410da555553e07700f5d`，与上方 pin 逐字一致。证据件明细见 docs/dev/license-chain-m0.md §2（E-3 / E-4 / E-9）
- 导入方式：`git archive` 零改动快照；本文件所在提交即导入提交，自该提交起 atlas 树上的一切差异均为阡陌自有改动
- 上游同步：暂定人工比对基座新版本后选择性同步，策略详见 docs/dev/base-adoption.md

## 上游同步演练记录

M0 期间基座 pin 冻结在 v2.38.3、不跟随上游发版（章程 N-13）。本节记录的是**演练**，不是实际同步；演练不改变 pin、不产生代码合入。

### 2026-08-15 · 目标 v2.46.0 · 演练，未合入

- 目标 tag：v2.46.0（`1128a3919a7f01298a6cbf5c468a839c6cf4ee6a`），当时上游最新正式 release
- 方法：一次性 clone 内做**三方应用**（`git diff v2.38.3 v2.46.0` → `git apply --3way`），不是 merge；主检出未加 remote，演练分支未提交、未推送。**勘误（2026-08-15，主 agent 复核）**：演练实际在本仓库的一个 git worktree（`.occ/worktrees/p74-upstream-sync`）内 fetch 上游 tag，worktree 与主检出**共享对象库**，因此上游历史对象（含 `848ad8c2` 及其 1,391 个祖先，共约 1,800 个不可达提交）进入了主检出的 pack——它们**不在任何 ref 上**，`git clone` 不会带走，干净 clone 中 `848ad8c2` 仍不可解析；但本机主检出上 `git diff 848ad8c2..HEAD` 会「跑得通」且给出另一组数字，答辩/举证一律用干净 clone 或以 `3380c88` 为基线
- 结果摘要：区间 61 提交 / 650 文件；冲突 **5 文件 7 块 = 1784 个上游 hunk 的 0.39%**；合并后 `bun run typecheck` exit 0、`bun test` **11311 条全绿**；跟随一次的工时估算 **10–20 h**（中位约 14 h）
- 详见：docs/dev/upstream-sync-drill.md（含冲突清单、按族统计与五条行动项）
- 执行：实施方执行，负责人授权本条记录写入（章程 §2.4「BASE.md 由负责人维护」的记录事件）
- **pin 不变**（仍为 848ad8c2 = v2.38.3）；**零改动快照声明不变**
