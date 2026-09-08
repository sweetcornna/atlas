<!-- Copyright 2026 Qianmo AgentNest Team -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# 阡陌 v2.46.1 GitHub Release

本次依负责人 2026-09-08 明确提出的“上传 GitHub、merge、发布新版本”执行首次 GitHub Release，作为现行不发布约定的一次明确例外。发行仓库是 `sweetcornna/atlas`，采用 `v2.46.1` 标签；构建版本从 2.46.0 递增到 2.46.1。基座来源与 pin 仍以 `BASE.md` 为准。本次发行不构成 npm 发布授权或基座上游同步。

## 变化

- 加固 SSH 凭据代理的本地 socket 权限和协议非法输入处理。
- 在读取上传流时执行体积上限，并保护失败替换时的既有制品。
- 修复大序号备份读取、损坏聊天元数据恢复和配置错误对话框的异常传播。
- 修复注册接口非法 URL 编码处理及端口绑定失败时的定时器泄漏。
- 避免登录失败集中到达时反复扫描尚未过期的记录。
- 更新存在已知漏洞的依赖；修复时实际依赖审计结果从 108 条公告降为 0 条。

逐项根因、独立提交、验证数据及审计覆盖限制见 [审计报告](audit-2026-09-08.md)。发行附带由合并提交生成、内置 `.source-commit` 的源码归档和 SHA-256 校验文件；GitHub 也提供标签对应的自动源码归档。

## 使用与验证边界

推荐通过 Git 检出本标签，使用仓库固定的 Bun 版本安装依赖并构建：

```sh
git clone --branch v2.46.1 https://github.com/sweetcornna/atlas.git
cd atlas
bun install --frozen-lockfile
bun run build:vite
bun dist/cli-qianmo.js --version
```

本版为源码发行。R2 跨 TTL 并发替换、注册/签名部署策略、原生二进制及真实节点/provider 的验收边界见审计报告；已有平台/凭据相关跳过测试不作为已通过的真实部署验证。
