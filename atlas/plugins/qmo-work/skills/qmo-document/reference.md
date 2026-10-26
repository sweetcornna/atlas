<!-- Copyright 2026 Qianmo AgentNest Team -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# `qianmo_make_document` · `kind: "document"` 的描述格式

```json
{
  "kind": "document",
  "file": "项目方案.docx",
  "pdf": false,
  "spec": {
    "title": "校园二手书平台项目方案",
    "subtitle": "初稿",
    "author": "产品组 · 2026 年 10 月",
    "theme": "classic",
    "blocks": [
      { "type": "heading", "text": "一、背景", "level": 1 },
      { "type": "paragraph", "text": "每学期末大量教材被丢弃，而新生需要以 **较低价格** 买到它们。\n\n空一行开始新段落。" },
      { "type": "bullets", "items": ["供给：毕业生与高年级学生", "需求：新生与转专业学生"] },
      { "type": "numbered", "items": ["上架", "撮合", "当面交易"] },
      { "type": "table", "caption": "表 1 预算（元）",
        "table": { "columns": ["项目", "金额"], "rows": [["服务器", 1200], ["推广", 3000]] } },
      { "type": "quote", "text": "我们宿舍每年都扔掉一箱书。", "source": "访谈对象 A" },
      { "type": "chart", "caption": "图 1 每月成交量",
        "chart": { "type": "bar", "categories": ["9月", "10月"], "series": [{ "name": "成交", "values": [40, 65] }] } },
      { "type": "pagebreak" },
      { "type": "heading", "text": "附录", "level": 2 },
      { "type": "paragraph", "text": "……" }
    ]
  }
}
```

## 规则

| 字段 | 说明 |
|---|---|
| `title` | 必填 |
| `subtitle`、`author` | 可选，写在标题下面 |
| `theme` | `classic` `ocean` `forest` `sunset` `graphite`，决定标题与表头颜色 |
| `blocks` | 1–400 块，按顺序排 |

块：

| `type` | 字段 |
|---|---|
| `heading` | `text`，`level` 1–3（缺省 1） |
| `paragraph` | `text`；空一行（`\n\n`）分段；`**粗体**` 可用 |
| `bullets`、`numbered` | `items`，1–100 条；每个编号列表从 1 开始 |
| `table` | `table: {columns, rows}`（最多 12 列 60 行，每行格数等于列数），`caption` 可选 |
| `quote` | `text`，`source` 可选 |
| `chart` | `chart: {type, categories, series, unit?}`（同演示文稿），`caption` 可选；Word 里写成数据表 |
| `pagebreak` | 无字段 |

不认的字段会被拒绝并指出位置。正文字体：中文微软雅黑、西文 Calibri。
