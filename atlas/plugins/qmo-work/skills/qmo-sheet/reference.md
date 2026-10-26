<!-- Copyright 2026 Qianmo AgentNest Team -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# `qianmo_make_document` · `kind: "sheet"` 的描述格式

```json
{
  "kind": "sheet",
  "file": "活动预算.xlsx",
  "spec": {
    "title": "迎新活动预算",
    "theme": "forest",
    "sheets": [
      {
        "name": "明细",
        "columns": [
          { "header": "日期", "type": "date" },
          { "header": "项目" },
          { "header": "金额", "type": "currency" },
          { "header": "占比", "type": "percent" }
        ],
        "rows": [
          ["2026-09-01", "场地", 2000, 0.4],
          ["2026-09-02", "物料", 3000, 0.6],
          [null, "合计", "=SUM(C2:C3)", "=SUM(D2:D3)"]
        ]
      },
      { "name": "说明", "columns": [{ "header": "说明", "width": 60 }], "rows": [["金额单位：元"]] }
    ]
  }
}
```

## 规则

| 字段 | 说明 |
|---|---|
| `title` | 可选，预览的标题；缺省用第一张表名 |
| `theme` | 表头颜色，同其他工作流 |
| `sheets` | 1–10 张；表名 1–31 个字符、不含 `[ ] : * ? / \`、不重复 |
| `columns` | 1–50 列：`header` 必填；`type` 为 `text` `number` `integer` `percent` `currency` `date`；`width` 4–80（字符），缺省按内容估 |
| `rows` | 最多 5000 行；每格是文字、数字、`true`/`false` 或 `null`；每行不多于列数，少了补空 |
| `freezeHeader` | 缺省冻结表头，写 `false` 不冻结 |

- 以 `=` 开头的文字是公式。
- `date` 列里的 `YYYY-MM-DD`（或带时间的 ISO 写法）写成 Excel 日期；其他写法按文字。
- 字体为微软雅黑；表头加粗、主题色底白字。
