<!-- Copyright 2026 Qianmo AgentNest Team -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# demo/env/public —— 公开版的部署模板（P35）

公开版是托管服务：用户自己注册，按托管节点订阅（预付周期、到期不自动扣款），**不卖模型
额度**——模型由订阅者在订阅页用自己的 API 密钥经平台网关 magpie 接入。本目录只放三份模板，
不是一键脚本；照着改路径与数值，装成 systemd 系统单元。

| 文件 | 是什么 |
| --- | --- |
| [`magpie.service`](./magpie.service) | 平台模型网关 magpie：管理口只在回环，网关在网络上、带 TLS、要密钥 |
| [`qm-public-console.service`](./qm-public-console.service) | 中枢控制台，跑公开版构建 `dist/qm-public-linux-x64`，带公开版必需的全部选项 |
| [`billing.example.json`](./billing.example.json) | 计费配置样例：套餐、微信支付、支付宝、兑换码、源代码链接 |

选项含义见 [`docs/dev/console.md`](../../../docs/dev/console.md) §3，网关部署形态见
[`docs/dev/magpie-gateway.md`](../../../docs/dev/magpie-gateway.md) §1。本文不复制它们。

## 步骤

1. 构建公开版：`bun run atlas:build:public`，把 `dist/qm-public-linux-x64` 放到 `/opt/qianmo/dist/`。
   这个构建就是公开版，没有开关能把它变回默认版；默认版给 `--billing` 会拒绝启动。
2. 装 magpie，按 `magpie.service` 起来；`/etc/qianmo/magpie.env`（0600）里写 `MAGPIE_WEB_KEY`
   与网关的地址、证书。
3. 准备计费配置：复制 `billing.example.json` 到 `--billing` 指向的位置（0600），**把每个套餐的
   `priceCents` 改成真实价格**，填商户号、应用号、支付宝的卖家 ID（`sellerId`，`2088` 开头，回调的
   `seller_id` 要与它相同）与密钥文件路径；密钥文件都要 0600。`live` 保持 `false`（未开通正式收款：
   不向支付平台下单，只能用兑换码），见文末。
4. 准备租户配置（`--tenancy`，0600）：`platformSubjects` 写平台运维的个人账号；订阅者的租户
   由中枢在开通时自动建，平台运维只需要把节点写进 `nodes`、分给对应的租户。
5. 按 `qm-public-console.service` 起控制台；对外经 TLS 前置转发到 `127.0.0.1:38613`。两条支付
   回调 `/v0/billing/notify/wechatpay`、`/v0/billing/notify/alipay` 必须原样转发，不能改写请求体。
6. 用平台运维的个人账号登录 `/admin/magpie` 连接网关；`/admin/billing` 看订阅、订单与账本。

## 为什么样例的价格是 0

`priceCents` 最小是 1，所以照抄的样例**一定起不来**：控制台读不通计费配置就拒绝启动，并说出
是哪个套餐的哪个字段。这样不会有人把样例里的随手数字当成真实售价挂出去。
`atlas/packages/node/test/commands/consoleBilling.test.ts` 钉着这两件事：原样的样例被拒，
只改价格之后能读通；服务单元里的选项在公开版里能被真实的参数解析器接受。

## 订阅者那一侧

- 匿名访问 `/` 看到套餐页 `/plans`（价格、周期、含几台节点；模型用自己的密钥接入）。
- 注册后在 `/subscription` 下单，扫码付款；付清后中枢建租户和一把**停用**的网关密钥。
- 订阅者在同一页「模型」一节选一个 magpie 预设、贴上自己的 API 密钥，网关密钥才启用，
  白名单只含他自己的上游；平台运维把节点分给他的租户后，节点自动拿到这份档案。
- 没有有效订阅时，所有写操作答 402；到期后网关密钥停用。

## 做不到的事

- 两种支付通道只对本地假服务测过，没有对真实商户号跑过（未评估）。开始收取真实款项前须满足
  章程 §8 M3 的法律前置（L-2 取得书面结论）；在那之前计费配置的 `live` 保持 `false`，中枢不向
  微信支付、支付宝下单，启动横幅的 `payments` 一行与各页面都写明「未开通正式收款」。
- `magpie.service` 没有对真实 magpie 跑过；网关监听、TLS 与 IP 放行按 magpie 自己的文档填。
- 节点的 SSH 动作、对话通道（`--chat-url`、`--chat-sign`、`--trust`）与本模板无关，按
  `docs/dev/console.md` 另行配置。
