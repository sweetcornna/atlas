---
{"description": "把当前工作转交云端", "argument-hint": "[目标]"}
---
<!-- Copyright 2026 Qianmo AgentNest Team -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

用户已要求转交：调用 qianmo_handoff，写清 goal（目标）、done（已完成）、remaining（剩下的）。先用 qianmo_login_status 查看配对；未配对时提示在控制台获取配对码并执行 qm handoff login。只有工具返回「已落地，可以关机」后才能告知可以关机。
