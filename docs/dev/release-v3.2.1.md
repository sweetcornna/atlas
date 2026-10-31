<!-- Copyright 2026 Qianmo AgentNest Team -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# 阡陌 v3.2.1 GitHub Release

v3.2.1 修的是 v3.2.0 基座同步（qianmopi 到上游 v18.14.1、Bun 1.4.4）之后，本机跑完全部重测试时发现的三处问题（#299）。最要紧的一处是 **v3.2.0 的源码构建不了 `qm`**：`bun run atlas:build:qm` 在第一步就失败。用 v3.2.0 源码构建的，请换用本版。

标签打在 #299 的合并提交上。与 v3.2.0 相比只多了这三处修复和本次的文档，可以用 `git diff --stat v3.2.0 v3.2.1` 核对。发行形式与 v3.2.0 相同：源码归档加 `SHA256SUMS`。桌面安装包随 v3.2.2 发行。其余内容见 [v3.2.0 发行说明](./release-v3.2.0.md)。

## 变化

- **`qm` 能构建了**：上游把生成导出查看器的脚本从 `gen:tool-views` 改名为 `gen:export-viewer`，`atlas/scripts/build-qm.ts` 跟着改。
- **elastic 并发打开状态库**：两个 `qm elastic` 进程同时打开同一个新状态库时，SQLite 对后一个连接切换 WAL 的请求直接回 `SQLITE_BUSY`，不按 busy_timeout 等待。本机最小复现：Bun 1.4.4 下 30 轮里约一半报 `database is locked`。改为撞锁时 5 秒内重试。
- **测试**：撤下模型的用例改按新基座的报错文字断言（`Model "<id>" not found. Did you mean …?`）。行为不变：子进程不启动，也不会换成别的模型。

## 部署与验证

- 本机（macOS，Bun 1.4.4）上通过：biome、阡陌类型检查、上面几条用例单跑（elastic CLI 用例连跑 5 次）、`atlas:build:qm`，以及对新构建的 `dist/qm-darwin-arm64` 跑 `atlas:check:qm-smoke`（7 项）。
- v3.2.0 合入后本机跑完的整组门禁里，registry-ha、客户端构建与冒烟通过。基座 `test:ts` 的 228 组里只有 tui 的一条假 tmux 用例红，单跑通过。
- CI：本版发行时 #299 的 CI 还没跑完，main 上 v3.2.0 那次合并的 CI 也没跑完。
- 没有部署记录：内测环境仍是 10 月 25 日的 `af903b8a`。

## 已知问题

- Bun 1.4.4 下，控制链路收到一条伪造来源、被拒绝的消息后，状态在同一轮事件循环里会显示「控制链路已断开」，下一个宏任务恢复。这时发出的控制请求直接得到 `unreachable`。Bun 1.4.3 下没有这个现象。对应用例 `consoleControl.test.ts` 在 1.4.4 下红，原因还在查。
- 本机测试受这台电脑环境影响的两条，与本版改动无关：
  - `qianmo-prompt-cache.test.ts` 的夹具没有隔离 HOME，会读到本机 Claude Code 插件里的 MCP 服务器。
  - `moreMenu.browser.test.ts` 在 Bun 1.4.3、1.4.4 下都红。
- 其余同 v3.2.0。

## 出处

改动见 #299。基座同步见 [BASE.md](../../BASE.md) 与 [v3.2.0 发行说明](./release-v3.2.0.md)。
