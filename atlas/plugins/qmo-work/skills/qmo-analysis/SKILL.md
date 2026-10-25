---
{"name": "qmo-analysis", "description": "分析数据、做统计、出图表、看趋势、对比各组、做数据报告时使用（data analysis, statistics, charts, trends, dashboard, CSV, Excel analysis）：读入数据、算出结果，出 .xlsx 结果表，再出 .pptx 或 .docx 讲清结论，最后交给用户。"}
---
<!-- Copyright 2026 Qianmo AgentNest Team -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# 数据分析工作流

目标：回答用户关心的问题，并交出两样东西：一份结果表（`.xlsx`），一份讲结论的演示文稿（`.pptx`）或文档（`.docx`）。

## 步骤

1. **定问题**：用户想知道什么（趋势、排名、对比、占比、异常、原因）。数据从哪来：附件、工作区里的文件、用户贴的文字。没有数据就先要数据。
2. **列计划**：用 `todo` 写下：读数据、检查质量、计算、结果表、结论稿、交付。
3. **读数据**：读文件，先看行数、列名、类型、缺失值和明显的错值；在回复或结果表的「说明」页写清楚你怎么处理了它们。
4. **计算**：能运行代码时（有 bash 或 eval 工具）用它做计算，数字以运行结果为准；不能运行时只做能手算核对的小规模计算，并说明。不要编数字。
5. **结果表**：按 `skill://qmo-sheet/reference.md` 调用 `qianmo_make_document`（`kind: "sheet"`）：「汇总」页放关键指标，「明细」页放处理后的数据，「说明」页写口径、来源和处理方法。
6. **结论稿**：要讲给人听用演示文稿（`skill://qmo-slides/reference.md`，图表用 `chart` 版式），要存档阅读用文档（`skill://qmo-document/reference.md`）。每个结论配一个数字或一张图，结论写在标题里。
7. **检查**：结论稿里的数字与结果表一致；图表的单位、类别顺序正确。
8. **交付**：用 `qianmo_deliver_files` 一次交两份文件，回复里列三条主要发现和数据的局限。
