<!-- Copyright 2026 Qianmo AgentNest Team -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# 控制台本地预览

开发控制台页面时用的预览服务与截图脚本，不是测试（文件名不带 `.test`，测试分片不跑它们）。
所有端口都是页面测试用的内存假端口（`../directionFakes.ts`、`../providersFake.ts` 等），
不读写磁盘，不连注册中心和节点。

## 起服务

```bash
bun atlas/packages/console/test/preview/serve.ts            # http://127.0.0.1:38700
bun atlas/packages/console/test/preview/serve.ts 38701 --no-magpie   # 不接网关，看模型页的另一种形态
```

- 浏览器打开 `http://127.0.0.1:38700/__preview/login?as=ops`，以运维账号登录；`as=member`、`as=viewer` 换成员、只读成员。
- 个人账号已开启，启动时用管理令牌签发并兑现了三个账号。
- 测试用的令牌（只在本预览里有效，不是任何真实控制台的令牌）：
  - 管理令牌 `preview-admin-6f1d3a8c27e4`
  - 只读令牌 `preview-view-0b7e52c41a9d`

## 截图

```bash
bun atlas/packages/console/test/preview/shoot.ts --out <目录> [--as ops] [--width 1280] [--height 860] \
  [--theme light|dark|both] 'front|/' 'models|/admin/providers' 'menu|/|document.querySelector("#fx-model-btn").click()'
```

每张截图写成 `<目录>/<名字>-<主题>.png`，截整页。第三段可选，是页面加载后先执行的一段脚本（打开菜单、切页签）。
用的是浏览器测试同一套驱动（`../browser/cdp.ts`），找不到 Chrome 时设 `QIANMO_CHROME`。

`../frontPreview.ts` 是只有对话前台的旧预览，仍可单独起。
