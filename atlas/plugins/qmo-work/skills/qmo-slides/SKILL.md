---
{"name": "qmo-slides", "description": "做演示文稿、幻灯片、PPT、路演稿、汇报稿时使用（slides, deck, presentation, pptx, pitch, keynote）：从要点或资料出一份可在 PowerPoint / Keynote / WPS 打开的 .pptx，带预览，可另出 PDF，最后交给用户。"}
---
<!-- Copyright 2026 Qianmo AgentNest Team -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# 演示文稿工作流

目标：交给用户一份结构清楚、每页一个意思的 `.pptx`，用户能直接拿去讲。

## 步骤

1. **弄清要什么**。从用户的话里找：主题、听众、用途（汇报、路演、课程、方案）、页数或时长、语言、要不要 PDF。缺的关键项（主题或材料）只问一次，其余按常理定，并在交付时说明你定了什么。
2. **列计划**。用 `todo` 工具写下几步（例如：整理材料、定大纲、写每页、生成、检查、交付），做一步勾一步——用户在活动面板里看得到进度。
3. **整理材料**。用户给了文件就读它们；需要事实和数字时先查证，查不到的不要编，写成「待补」或问用户。
4. **定大纲**。一般结构：封面 → 目录或背景 → 三到五个主体部分（每部分可用一张 `section` 页开头）→ 结论或下一步 → 结尾页。十分钟大约 8–12 页。
5. **写每一页**。一页一个论点：标题写结论（「收入同比增长 12%」而不是「收入情况」），要点 3–6 条、每条一行左右；数字多时用 `table` 或 `chart`；讲稿写进 `notes`。
6. **生成**。读 `skill://qmo-slides/reference.md` 里的描述格式，调用 `qianmo_make_document`，`kind` 为 `slides`，`file` 用简短的中文或英文名（如 `季度汇报.pptx`）；用户要 PDF 时加 `pdf: true`。工具报描述有问题就按提示改了再调。
7. **检查**。工具结果会说生成了几页、多大。需要时读 `qmo-work/<会话>/previews/` 下的预览 HTML 或 `sources/` 下的描述 JSON 复核：有没有错字、空页、超长的要点、数字前后不一致。改了就整份重新生成（同名覆盖）。
8. **交付**。调用 `qianmo_deliver_files` 把 `.pptx`（和 `.pdf`）交给用户。回复里用两三句话说明：多少页、结构、你替用户做的假设、还缺什么。不要把整份内容再贴一遍。

## 改稿

用户要改时，读 `sources/<文件名>.json` 里上次的描述，只改要改的部分，再用同一个 `file` 生成并重新交付。

## 版式与主题

- 版式：`title` 封面、`section` 章节页、`bullets` 要点、`two-column` 两栏对比、`table` 表格、`chart` 图表（柱状 `bar`、折线 `line`、饼图 `pie`）、`quote` 引言、`closing` 结尾页。
- 主题：`classic`（深蓝）、`ocean`（海蓝）、`forest`（墨绿）、`sunset`（暖红）、`graphite`（石墨）。用户没说就按场景选，一份里只用一个。
- 字体统一为微软雅黑，打开的电脑没有时 Office 会换成本机中文字体。

## 不要做

- 不要用 bash 或别的程序自己拼 pptx，也不要装 Python 库或 LibreOffice；只用 `qianmo_make_document`。
- 不要在没交付的情况下说「已经发给你了」。PDF 没生成时如实告诉用户原因。
