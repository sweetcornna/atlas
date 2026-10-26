---
{"name": "qmo-webpage", "description": "做网页、落地页、活动页、个人主页、作品展示页、HTML 页面时使用（webpage, landing page, website, HTML page, one-pager）：写一份自包含的 .html（样式内联、不依赖外部资源），带预览，最后交给用户。"}
---
<!-- Copyright 2026 Qianmo AgentNest Team -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# 网页工作流

目标：交给用户一个单文件 `.html`，双击就能在浏览器里打开，手机和电脑上都好看。

## 步骤

1. **弄清要什么**：用途、受众、要有哪些区块（首屏、介绍、亮点、价格、常见问题、联系方式……）、风格与主色、语言。
2. **列计划**：用 `todo` 写下：内容、结构、样式、写文件、检查、交付。
3. **写内容**：先把每个区块的文字写好；文字要具体，不要堆形容词。没有的信息（电话、价格）用明显的占位并在交付时说明。
4. **写页面**：一个文件，`<!doctype html>`、`<meta charset="utf-8">`、`<meta name="viewport" content="width=device-width, initial-scale=1">`，样式写在 `<style>` 里；用语义标签（`header` `main` `section` `footer`）；用 CSS 网格或弹性布局适配窄屏；字体用系统字体栈（如 `-apple-system, "PingFang SC", "Microsoft YaHei", sans-serif`）；支持 `prefers-color-scheme` 更好。
5. **不要依赖外部资源**：不引用外部 CSS、字体、脚本或图片；图标用内联 SVG，图片用 `data:` 或留出占位块。预览里脚本不会运行，页面不能靠脚本才显示内容；确有交互需要时，内容先用纯 HTML 写全，脚本只做锦上添花。
6. **写文件**：调用 `qianmo_write_output`，`file` 如 `招新页.html`，`content` 是整页 HTML（5 MiB 以内）。
7. **检查**：读一遍自己写的文件：标签是否闭合、窄屏下是否有横向滚动、占位是否都标出来了。
8. **交付**：调用 `qianmo_deliver_files` 交 `.html`，回复里说明区块结构和需要用户补的信息。
