<!-- Copyright 2026 Qianmo AgentNest Team -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# 阡陌接力插件

支持 Claude Code、官方 Codex 与 omp。先安装：

```sh
qm handoff plugin install --tool codex
qm handoff login https://你的控制台 --code XXXX-XXXX-XXXX
```

在工具中使用 `/qianmo:handoff`、`/qianmo:status`、`/qianmo:pull`、`/qianmo:login`，或直接说「交给云端」。Stop 与 SessionEnd 自动同步已配对仓库。Codex 0.162 请使用上述 qm 安装命令（标准清单在安装目录另存为 plugin.agent-plugins.json，以启用该版本的 hooks）；首次运行需要在 `/hooks` 中信任插件 hooks；参见仓库 `docs/dev/handoff-usage.md`。

阡陌基于 oh-my-pi（MIT）构建；此插件及阡陌代码采用 AGPL-3.0-or-later。与工具厂商不存在授权或背书关系。
