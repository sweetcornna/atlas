---
{"description": "配对本机设备", "argument-hint": "<控制台地址> --code <配对码>"}
---
<!-- Copyright 2026 Qianmo AgentNest Team -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

先调用 qianmo_login_status。用户提供控制台地址与配对码时执行 qm handoff login <控制台地址> --code <配对码>，可加 --name <设备名>。不要打印设备令牌。已有设备需用户明确要求覆盖才加 --force。
