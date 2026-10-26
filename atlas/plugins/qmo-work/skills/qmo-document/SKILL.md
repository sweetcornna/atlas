---
{"name": "qmo-document", "description": "写文档、报告、方案、说明书、公文、合同草稿、会议纪要等 Word 文件时使用（document, report, proposal, memo, docx, Word）：出一份排好版的 .docx，带预览，可另出 PDF，最后交给用户。"}
---
<!-- Copyright 2026 Qianmo AgentNest Team -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# 文档工作流

目标：交给用户一份结构清楚、可以直接在 Word / WPS 里继续编辑的 `.docx`。

## 步骤

1. **弄清要什么**：文档类型、读者、篇幅、语气（正式、内部、对外）、有没有模板或必须包含的部分、要不要 PDF。缺主题或关键材料时只问一次。
2. **列计划**：用 `todo` 写下几步（整理材料、提纲、成文、生成、检查、交付），边做边勾。
3. **整理材料**：读用户给的文件；需要事实时查证，查不到的标「待补」，不要编造数字、引文或出处。
4. **提纲**：标题层级最多三级（`heading` 的 `level` 1–3）。常见结构：摘要或背景 → 正文各节 → 结论或建议 → 附录。
5. **成文**：一段一个意思，段落用 `paragraph`，并列内容用 `bullets`，步骤用 `numbered`，对比和数据用 `table`（需要时加 `caption`），引用原话用 `quote` 并写 `source`。`chart` 在 Word 里会写成数据表加图注，预览里画成图。
6. **生成**：读 `skill://qmo-document/reference.md`，调用 `qianmo_make_document`，`kind` 为 `document`；要 PDF 时加 `pdf: true`。
7. **检查**：需要时读工具结果里给的预览与描述路径复核：标题层级、错字、前后数字是否一致、有没有空节。改了就同名重新生成。
8. **交付**：调用 `qianmo_deliver_files` 交 `.docx`（和 `.pdf`），回复里简述结构、篇幅和你做的假设。

## 改稿

读 `sources/<文件名>.json`，只改需要改的块，同一个 `file` 重新生成，再交付一次。

## 不要做

- 不要用 bash、Python 或 LibreOffice 自己拼 docx；只用 `qianmo_make_document`。
- 不要假装已交付；PDF 没生成时说明原因。
