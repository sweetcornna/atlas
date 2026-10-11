---
{"name": "qianmo-handoff", "description": "用户要求把当前工作交给云端、转交接力或准备关机时使用；查看进度与接回结果也适用。"}
---
<!-- Copyright 2026 Qianmo AgentNest Team -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

先调用 qianmo_login_status。已配对且用户要求转交时调用 qianmo_handoff，完整填写目标、已完成、剩余工作；只有返回「已落地，可以关机」才说可以关机。查看进度调用 qianmo_status 或 qianmo_task，追加要求调用 qianmo_send，接回结果调用 qianmo_pull。未配对时提示从控制台获取配对码后运行 qm handoff login。omp 可以调用工具，其自身会话暂不作为转交来源。
