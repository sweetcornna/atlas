<!-- Copyright 2026 Qianmo AgentNest Team -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# `qianmo_make_document` · `kind: "slides"` 的描述格式

```json
{
  "kind": "slides",
  "file": "季度汇报.pptx",
  "pdf": true,
  "spec": {
    "title": "2026 年第三季度经营汇报",
    "subtitle": "华东区 · 10 月",
    "author": "运营部",
    "theme": "ocean",
    "slides": [
      { "layout": "title", "title": "2026 年第三季度经营汇报", "subtitle": "华东区 · 10 月" },
      { "layout": "section", "title": "一、业绩", "subtitle": "收入与客户" },
      { "layout": "bullets", "title": "收入同比增长 12%", "subtitle": "三个原因",
        "bullets": ["新客户 **320** 家，超目标 7%", "老客户续约率 91%", "客单价提高 4%"],
        "notes": "先讲结论，再讲三个原因。" },
      { "layout": "two-column", "title": "上季与本季",
        "columns": [ { "heading": "上季", "bullets": ["渠道单一", "交付慢"] },
                     { "heading": "本季", "bullets": ["新增两个渠道", "交付缩短到 5 天"] } ] },
      { "layout": "table", "title": "分地区收入（万元）",
        "table": { "columns": ["地区", "Q2", "Q3"], "rows": [["上海", 120, 138], ["杭州", 80, 92]] } },
      { "layout": "chart", "title": "月度收入趋势",
        "chart": { "type": "line", "unit": "万元", "categories": ["7月", "8月", "9月"],
                   "series": [ { "name": "2025", "values": [60, 62, 65] }, { "name": "2026", "values": [68, 70, 75] } ] } },
      { "layout": "quote", "quote": "把交付时间从两周缩短到五天，是这一季最重要的变化。", "subtitle": "华东区负责人" },
      { "layout": "closing", "title": "谢谢", "subtitle": "下一步：Q4 目标与资源" }
    ]
  }
}
```

## 规则

| 字段 | 说明 |
|---|---|
| `title` | 必填，整份的标题 |
| `subtitle`、`author` | 可选 |
| `theme` | `classic` `ocean` `forest` `sunset` `graphite`，缺省 `classic` |
| `slides` | 1–60 页 |

每页：

| 字段 | 用于 | 说明 |
|---|---|---|
| `layout` | 全部 | 必填，见下 |
| `title` | 除 `quote`、`closing` 外必填 | 一行，写结论 |
| `subtitle` | `title` `section` `bullets` `closing`；`quote` 里是出处 | 可选 |
| `bullets` | `bullets` 必填 | 最多 12 条，每条 ≤ 500 字；`**粗体**` 可用 |
| `columns` | `two-column` 必填 | 恰好两栏，每栏 `{heading?, bullets}` |
| `table` | `table` 必填 | `{columns: [...], rows: [[...], ...]}`，最多 12 列 60 行；单元格是文字、数字或 `null`；每行格数与列数相同 |
| `chart` | `chart` 必填 | `{type: "bar"|"line"|"pie", categories: [...], series: [{name, values}], unit?}`；每个 `values` 与 `categories` 一样长；饼图只有一个系列；最多 24 类 6 个系列 |
| `quote` | `quote` 必填 | 引言正文，不用自己加引号 |
| `notes` | 全部 | 讲稿，可选 |

- 版式：`title` `section` `bullets` `two-column` `table` `chart` `quote` `closing`。
- 不认的字段会被拒绝并说明位置，例如 `spec.slides.3.chart.series.0.values: has 2 values; there are 3 categories`。
- 文字过长时会自动缩小字号，但最好每页少而精。
