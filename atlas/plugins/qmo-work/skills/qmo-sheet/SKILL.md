---
{"name": "qmo-sheet", "description": "做表格、清单、台账、预算表、统计表、数据整理成 Excel 时使用（spreadsheet, sheet, Excel, xlsx, table, budget, tracker）：出一份带表头、格式与公式的 .xlsx，带预览，最后交给用户。"}
---
<!-- Copyright 2026 Qianmo AgentNest Team -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# 表格工作流

目标：交给用户一份打开就能用的 `.xlsx`：表头清楚、类型正确（数字是数字、日期是日期）、需要汇总的地方有公式。

## 步骤

1. **弄清要什么**：用途（记录、统计、预算、名单）、有哪些列、数据从哪来、要不要汇总行。用户给了 CSV、JSON 或文档，就先读它们。
2. **列计划**：用 `todo` 写下几步（读数据、定列、清洗、生成、检查、交付）。
3. **定列**：每列一个 `header` 和合适的 `type`：`text`、`number`、`integer`、`percent`（0.25 显示为 25.0%）、`currency`（两位小数）、`date`（写成 `YYYY-MM-DD`）。
4. **清洗数据**：统一单位与格式，去掉重复与空行；拿不准的值留空，不要猜。
5. **公式**：以 `=` 开头的字符串写成公式，例如 `"=SUM(B2:B31)"`。行号从 2 开始（第 1 行是表头）。预览里显示公式原文，计算由 Excel 打开时完成。
6. **生成**：读 `skill://qmo-sheet/reference.md`，调用 `qianmo_make_document`，`kind` 为 `sheet`。多张表放进 `sheets`，比如「明细」「汇总」「说明」。
7. **检查**：核对行数、列数、合计是否合理。
8. **交付**：调用 `qianmo_deliver_files` 交 `.xlsx`，回复里说明有几张表、多少行、公式在哪。

## 只要 CSV 时

用户只要 CSV 或数据要给别的程序读时，用 `qianmo_write_output` 写 `.csv`（UTF-8，逗号分隔，含表头），再交付。
