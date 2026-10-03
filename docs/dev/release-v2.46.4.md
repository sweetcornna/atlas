<!-- Copyright 2026 Qianmo AgentNest Team -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# 阡陌 v2.46.4 GitHub Release

v2.46.4 是补丁版：在 v2.46.3（`18a6184a`）之上只加一项修复，即 MiMo 预设换成现行模型。`main` 上 v2.46.3 之后的其他改动都不在本版里，包括 P14、P15、P16、P17 的进行中工作与文档。发行形式与 v2.46.3 相同：`sweetcornna/atlas`，源码归档加 `SHA256SUMS`。基座 pin 仍为 v2.46.0，不含上游同步。

## 为什么要发这一版

小米 MiMo 的 `mimo-v2.5-pro`、`mimo-v2.5` 在 **2026-10-21 10:00（北京时间）**下线，没有系统替换；`mimo-v2-flash` 已在 2026-06-30 下线（官网下线公告 `https://mimo.mi.com/static/docs/updates/deprecate.md`，2026-10-03 取页）。

v2.46.3 的 `/provider` 向导里，MiMo 预设用的全是这些 id。到期之后，在向导里选 MiMo 的用户，第一个请求就会失败。

## 变化

- MiMo 预设（`src/utils/model/chinaLlmProviders.ts`）：
  - 默认模型和 sonnet、opus、fable 三档改为 `mimo-v2.6-pro`，haiku 档改为 `mimo-v2.6-flash`；
  - 模型表只保留这两条，`mimo-v2-flash` 那条删除；
  - 类型、函数和其他三家预设都没有改。
- 新增用例 `src/utils/model/__tests__/chinaLlmProviders.mimo.test.ts`。下线 id 按完整 id 断言，避免误伤仍在上架的 `mimo-v2.5-asr` 等模型。
- `docs/dev/base-modifications.md` §2.9 登记了这处基座改动。

这三个提交是从 `main` 上的 PR #157 cherry-pick 过来的。

## 升级注意

- 已经用向导配置过 MiMo 的用户，settings 的 env 里存的还是旧 id，本版**不会**自动迁移。10-21 之后要重新跑一次 `/provider` 或 `/model`，选新的模型。
- 不用 MiMo 的部署，行为没有任何变化。内测舰队不用 MiMo。
