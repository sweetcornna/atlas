<!-- Copyright 2026 Qianmo AgentNest Team -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# 第三方依赖 SBOM 与许可证清单（oh-my-pi 基座）

> **本文件由 `bun run atlas:sbom` 生成，不要手改。**改判据请改 `atlas/scripts/sbom.ts`。
>
> 输入：`bun.lock`（SHA-256 `c98ac7881fc98b65…`）+ `node_modules` 的 `license` 字段。机器可读版本见同目录 [`sbom-m0.json`](./sbom-m0.json)（CycloneDX 1.5 形状）。

对应 roadmap **P8.4** 交付物①，章程 §5 与风险 L-2 的证据链见 [`license-chain-m0.md`](./license-chain-m0.md)。

## 0. 三条读表须知

**① `dev` 不等于「不分发」。**`atlas/scripts/build-qm.ts` 用 Bun `--compile` 把 qm 与 omp CLI 连同它们触达的库整体编进 `dist/qm-<target>`；而基座把绝大多数运行时库放在各包的 `devDependencies` 或按 catalog 引用，字段归属与是否进入产物没有对应关系。**因此本表的 runtime/dev 划分反映的是 package.json 字段归属，不是产物边界。传染性许可的处置不得以「它是 dev 依赖」为由放行。**

**② 本仓库不发 npm 包**（章程 N-14）。分发形态是演示与竞赛材料随附的源码/产物，不是 registry 上的包。许可义务按「分发」评估仍然成立。

**③ 平台受限的 optional 依赖在本机不装**，因而读不到 `license` 字段。它们单列一节，不混进「许可缺失」清单。

## 1. 统计总览

| 项 | 数 |
|---|---|
| 组件总数（lockfile 条目，含重复解析） | 952 |
| ├ 第三方组件 | 907 |
| └ workspace 自有包 | 45 |
| 唯一 name@version（第三方） | 852 |
| runtime 可达 | 235 |
| dev 可达 | 711 |
| 未被任何根可达（解析遗漏或纯 peer） | 6 |
| 本机未安装（去重，平台受限 optional） | 223 |

## 2. 许可分布

按归一化后的许可表达式统计，范围为**本机已安装的第三方组件**（去重到 name@version，共 618 项）。未安装的 234 项读不到字段，单列在 §5，不计入本表。

「分类」按 §3 的 SPDX 求值口径给出：`(A OR B)` 取较宽松的一支，所以 `(BSD-3-Clause OR GPL-2.0)` 显示为宽松。

| 许可表达式 | 分类 | 组件数 |
|---|---|---|
| `MIT` | 宽松 | 460 |
| `ISC` | 宽松 | 53 |
| `Apache-2.0` | 宽松 | 44 |
| `BSD-3-Clause` | 宽松 | 23 |
| `BSD-2-Clause` | 宽松 | 9 |
| `BlueOak-1.0.0` | 宽松 | 8 |
| `MPL-2.0` | 弱传染（文件级） | 6 |
| `MIT OR Apache-2.0` | 宽松 | 3 |
| `(MIT OR CC0-1.0)` | 宽松 | 2 |
| `SEE LICENSE IN LICENSE` | 未判定 | 2 |
| `(Apache-2.0 AND BSD-3-Clause)` | 宽松 | 1 |
| `(BSD-2-Clause OR MIT OR Apache-2.0)` | 宽松 | 1 |
| `(MIT OR Apache-2.0)` | 宽松 | 1 |
| `0BSD` | 宽松 | 1 |
| `CC-BY-4.0` | 宽松 | 1 |
| `GPL-3.0-only` | 强传染 | 1 |
| `LGPL-3.0-or-later` | 弱传染（文件级） | 1 |
| `Python-2.0` | 宽松 | 1 |

## 3. 传染性许可扫描（P8.4 DoD 判据）

判定口径：SPDX 表达式按 `OR` 取最宽松分支、`AND` 取最严格分支求值——`(MIT OR GPL-2.0)` **不算命中**，因为可以取 MIT 那一支；`GPL-2.0 WITH Classpath-exception-2.0` 降一档，因为该例外正是为解除链接传染而写的。扫描覆盖 GPL / LGPL / AGPL / SSPL / EUPL / CC-BY-SA / OSL / CDDL / MPL / EPL / CPL / MS-RL / APSL / GFDL / Sleepycat / QPL / CECILL / Artistic 等族。

**结论：强传染 / 网络传染命中 1 项；弱传染（文件级）命中 7 项；受限/非自由 0 项。**

| 包 | 版本 | 许可 | 分类 | 引入路径 | 字段归属 | 处置建议 |
|---|---|---|---|---|---|---|
| `kitty-vt-wasm` | 0.2.0 | `GPL-3.0-only` | 强传染 | @oh-my-pi/pi-tui → kitty-vt-wasm | dev | 已记录例外（不阻断）：仅被 `@oh-my-pi/pi-tui` 与 `pi-coding-agent` 的测试夹具引用（`packages/tui/test/virtual-terminal.ts` 等），生产源码无 import，不进 `dist/qm-<target>`；如生产源码开始引用，本例外自动失效 |
| `@img/sharp-libvips-darwin-arm64` | 1.3.3 | `LGPL-3.0-or-later` | 弱传染（文件级） | @oh-my-pi/pi-coding-agent → @huggingface/transformers → sharp → @img/sharp-libvips-darwin-arm64 | runtime | 可留用（预编译共享库，非 JS，不进 `dist/` 的 JS bundle，随 `node_modules` 以独立文件形式存在）：未修改其源码即不传染到本仓库代码；分发时须随附其许可与版权声明，并保留使用者替换该库的可能（LGPL §4） |
| `axe-core` | 4.13.0 | `MPL-2.0` | 弱传染（文件级） | @oh-my-pi/pi-coding-agent → axe-core | runtime | 可留用：未修改其源文件时义务止于该文件；分发时须随附其许可与版权声明 |
| `lightningcss` | 1.32.0 | `MPL-2.0` | 弱传染（文件级） | robomp-web → @tailwindcss/vite → @tailwindcss/node → @tailwindcss/node/lightningcss | dev | 可留用：未修改其源文件时义务止于该文件；分发时须随附其许可与版权声明 |
| `lightningcss` | 1.33.0 | `MPL-2.0` | 弱传染（文件级） | robomp-web → vite → lightningcss | dev | 可留用：未修改其源文件时义务止于该文件；分发时须随附其许可与版权声明 |
| `lightningcss-darwin-arm64` | 1.32.0 | `MPL-2.0` | 弱传染（文件级） | robomp-web → @tailwindcss/vite → @tailwindcss/node → @tailwindcss/node/lightningcss → @tailwindcss/node/lightningcss/lightningcss-darwin-arm64 | dev | 可留用：未修改其源文件时义务止于该文件；分发时须随附其许可与版权声明 |
| `lightningcss-darwin-arm64` | 1.33.0 | `MPL-2.0` | 弱传染（文件级） | robomp-web → vite → lightningcss → lightningcss-darwin-arm64 | dev | 可留用：未修改其源文件时义务止于该文件；分发时须随附其许可与版权声明 |
| `postcss-values-parser` | 6.0.2 | `MPL-2.0` | 弱传染（文件级） | (root) → … → precinct → detective-postcss → postcss-values-parser | dev | 可留用：未修改其源文件时义务止于该文件；分发时须随附其许可与版权声明 |

## 4. 许可字段缺失 / 非 SPDX / `SEE LICENSE IN`

「包内许可文件」列直接看磁盘：`SEE LICENSE IN <file>` 指向的文件**未必随包发布**，那种情况下授权正文在本机根本不存在，必须回到上游仓库取。

| 包 | 版本 | `license` 字段 | 问题 | 包内许可文件 | 引入路径 |
|---|---|---|---|---|---|
| `@modelcontextprotocol/server-filesystem` | 2026.7.10 | `SEE LICENSE IN LICENSE` | see-license-in, non-spdx | **无** | @qianmo/node → @modelcontextprotocol/server-filesystem |
| `@modelcontextprotocol/server-memory` | 2026.7.4 | `SEE LICENSE IN LICENSE` | see-license-in, non-spdx | **无** | @qianmo/node → @modelcontextprotocol/server-memory |

本脚本只读字段、不读授权正文。**上表每一项的人工核读结论记在 [`license-chain-m0.md`](./license-chain-m0.md) §4**，其中包含本次审计查到的非开源授权项的定性与其影响面判定。

## 5. 本机未安装的组件（许可待补）

本机 `darwin-arm64`。共 234 项在 lockfile 里但本机 `node_modules` 中不存在，因而读不到 `license` 字段；其中 223 项是被 `os`/`cpu` 过滤掉的平台原生包。**结项材料若要覆盖全平台，须在各目标平台分别跑一次本脚本再并表。**

按引入者归组。「同族已安装样本的许可」是同一引入者下已装组件的许可集合——平台变体包通常与同族一致，可据此预判，但**不构成判定**。

| 引入者 | 未安装项数 | 同族已安装样本的许可 |
|---|---|---|
| `sharp` | 23 | `MIT`、`Apache-2.0`、`LGPL-3.0-or-later`、`ISC` |
| `lightningcss` | 20 | `MPL-2.0` |
| `oxc-parser` | 19 | `MIT` |
| `typescript` | 19 | `Apache-2.0` |
| `oxc-resolver` | 18 | `MIT` |
| `oxfmt` | 18 | `MIT` |
| `oxlint` | 18 | `MIT` |
| `@napi-rs/lzma` | 16 | `MIT` |
| `@napi-rs/tar` | 15 | `MIT` |
| `rolldown` | 14 | `MIT` |
| `@napi-rs/wasm-tools` | 12 | `MIT` |
| `@tailwindcss/oxide` | 11 | `MIT` |
| `@biomejs/biome` | 7 | `MIT OR Apache-2.0` |
| `@typescript/native-preview` | 6 | `Apache-2.0` |
| `sherpa-onnx-node` | 5 | （无已装同族） |
| `@anush008/tokenizers` | 2 | `MIT` |

另有 11 项**不受平台限制却仍未安装**（多为未被选中的 optional / peer 分支），逐项列出：

| 包 | 版本 | 引入路径 |
|---|---|---|
| `@emnapi/core` | 1.11.2 | (root) → knip → oxc-resolver → @oxc-resolver/binding-wasm32-wasi → @emnapi/core |
| `@emnapi/core` | 1.11.3 | robomp-web → @tailwindcss/vite → @tailwindcss/oxide → @tailwindcss/oxide-wasm32-wasi → @tailwindcss/oxide-wasm32-wasi/@emnapi/core |
| `@emnapi/core` | 1.9.2 | @oh-my-pi/pi-natives → @napi-rs/cli → @napi-rs/wasm-tools → @napi-rs/wasm-tools-wasm32-wasi → @napi-rs/wasm-tools-wasm32-wasi/@emnapi/core |
| `@emnapi/runtime` | 1.11.2 | @oh-my-pi/pi-natives → … → @napi-rs/lzma → @napi-rs/lzma-wasm32-wasi → @napi-rs/lzma-wasm32-wasi/@emnapi/runtime |
| `@emnapi/runtime` | 1.11.3 | @oh-my-pi/pi-coding-agent → … → @img/sharp-freebsd-wasm32 → @img/sharp-wasm32 → @img/sharp-wasm32/@emnapi/runtime |
| `@emnapi/wasi-threads` | 1.2.1 | @oh-my-pi/pi-natives → … → @napi-rs/wasm-tools-wasm32-wasi → @napi-rs/wasm-tools-wasm32-wasi/@emnapi/core → @napi-rs/wasm-tools-wasm32-wasi/@emnapi/core/@emnapi/wasi-threads |
| `@emnapi/wasi-threads` | 1.2.2 | (root) → … → @oxc-resolver/binding-wasm32-wasi → @emnapi/core → @emnapi/wasi-threads |
| `@emnapi/wasi-threads` | 1.2.3 | robomp-web → @tailwindcss/vite → @tailwindcss/oxide → @tailwindcss/oxide-wasm32-wasi → @tailwindcss/oxide-wasm32-wasi/@emnapi/wasi-threads |
| `@img/sharp-wasm32` | 0.35.4 | @oh-my-pi/pi-coding-agent → @huggingface/transformers → sharp → @img/sharp-freebsd-wasm32 → @img/sharp-wasm32 |
| `@napi-rs/wasm-runtime` | 1.2.4 | (root) → knip → oxc-parser → @oxc-parser/binding-wasm32-wasi → @napi-rs/wasm-runtime |
| `@tybys/wasm-util` | 0.10.4 | robomp-web → @tailwindcss/vite → @tailwindcss/oxide → @tailwindcss/oxide-wasm32-wasi → @tailwindcss/oxide-wasm32-wasi/@tybys/wasm-util |

## 6. 原生二进制（Rust 插件与编译产物）的许可来源核对

| 位置 | 内容 | 入库状态 | 目录内 LICENSE | 溯源 |
|---|---|---|---|---|
| `packages/natives/native/` | 1 个本机构建的 `pi_natives` N-API 插件（pi_natives.darwin-arm64.node） | 不入库（构建产物）；编译时嵌入 `dist/qm-<target>` | THIRD-PARTY-NOTICES.txt、about.toml、deny.toml（仓库根） | 由 Cargo workspace（`Cargo.lock` 1067 个 package）构建；Rust 第三方依赖的许可清单取 omp 的 `THIRD-PARTY-NOTICES.txt`，接受的许可表在 `about.toml`，由 cargo-deny 的 `deny.toml` 兜底 |
| `crates/vendor/` | 5 个就地打补丁的第三方 Rust crate（brush-core、brush-parser、cfg_aliases、napi、tree-sitter-go） | 入库（git 跟踪） | 5/5 个目录带 LICENSE/COPYING/NOTICE | 经 `[patch.crates-io]` 接入 Cargo workspace；各自许可正文收录在 THIRD-PARTY-NOTICES.txt 的「TRACKED VENDORED CODE」一节 |
| `dist/qm-<target>` | qm 与 oh-my-pi CLI 编成的单个可执行文件（Bun --compile），内嵌上面的 `pi_natives` 插件 | 不入库（`atlas/scripts/build-qm.ts` 产物） | 随产物分发时附 LICENSE、LICENSE.base、NOTICE 与 THIRD-PARTY-NOTICES.txt | 源码为本仓库（阡陌层 AGPL-3.0-or-later，基座层 MIT）；JS 依赖由上面的 bun.lock 清单覆盖，Rust 依赖由 omp 的 THIRD-PARTY-NOTICES.txt 覆盖 |

## 7. workspace 自有包

「版权头」列 = 该包 `.ts` 文件中首两行为 `// Copyright 2026 Qianmo AgentNest Team` + `// SPDX-License-Identifier: AGPL-3.0-or-later` 的比例（章程 §5.5 要求 `@qianmo/*` 全覆盖）。

### 7.1 阡陌自有（`@qianmo/*`）

| 包 | 路径 | `license` | private | 版权头 |
|---|---|---|---|---|
| `@qianmo/a2a` | `atlas/packages/a2a` | AGPL-3.0-or-later | 是 | 8/8 |
| `@qianmo/activator` | `atlas/packages/activator` | AGPL-3.0-or-later | 是 | 31/31 |
| `@qianmo/adapter` | `atlas/packages/adapter` | AGPL-3.0-or-later | 是 | 15/15 |
| `@qianmo/audit` | `atlas/packages/audit` | AGPL-3.0-or-later | 是 | 10/10 |
| `@qianmo/backup` | `atlas/packages/backup` | AGPL-3.0-or-later | 是 | 13/13 |
| `@qianmo/capability` | `atlas/packages/capability` | AGPL-3.0-or-later | 是 | 15/15 |
| `@qianmo/capacity` | `atlas/packages/capacity` | AGPL-3.0-or-later | 是 | 13/13 |
| `@qianmo/console` | `atlas/packages/console` | AGPL-3.0-or-later | 是 | 125/125 |
| `@qianmo/diagnosis` | `atlas/packages/diagnosis` | AGPL-3.0-or-later | 是 | 6/6 |
| `@qianmo/elastic` | `atlas/packages/elastic` | AGPL-3.0-or-later | 是 | 4/4 |
| `@qianmo/extension` | `atlas/packages/extension` | AGPL-3.0-or-later | 是 | 3/3 |
| `@qianmo/handoff` | `atlas/packages/handoff` | AGPL-3.0-or-later | 是 | 19/19 |
| `@qianmo/mailbox` | `atlas/packages/mailbox` | AGPL-3.0-or-later | 是 | 4/4 |
| `@qianmo/memory` | `atlas/packages/memory` | AGPL-3.0-or-later | 是 | 23/23 |
| `@qianmo/negotiation` | `atlas/packages/negotiation` | AGPL-3.0-or-later | 是 | 7/7 |
| `@qianmo/node` | `atlas/packages/node` | AGPL-3.0-or-later | 是 | 223/223 |
| `@qianmo/paths` | `atlas/packages/paths` | AGPL-3.0-or-later | 是 | 3/3 |
| `@qianmo/protocol` | `atlas/packages/protocol` | AGPL-3.0-or-later | 是 | 17/17 |
| `@qianmo/providers` | `atlas/packages/providers` | AGPL-3.0-or-later | 是 | 16/16 |
| `@qianmo/recall` | `atlas/packages/recall` | AGPL-3.0-or-later | 是 | 65/65 |
| `@qianmo/registry` | `atlas/packages/registry` | AGPL-3.0-or-later | 是 | 16/16 |
| `@qianmo/resident` | `atlas/packages/resident` | AGPL-3.0-or-later | 是 | 52/52 |
| `@qianmo/router` | `atlas/packages/router` | AGPL-3.0-or-later | 是 | 10/10 |
| `@qianmo/sandbox` | `atlas/packages/sandbox` | AGPL-3.0-or-later | 是 | 7/7 |
| `@qianmo/scheduler` | `atlas/packages/scheduler` | AGPL-3.0-or-later | 是 | 14/14 |
| `@qianmo/transport` | `atlas/packages/transport` | AGPL-3.0-or-later | 是 | 29/29 |
| `@qianmo/tunnel` | `atlas/packages/tunnel` | AGPL-3.0-or-later | 是 | 5/5 |
| `@qianmo/witness` | `atlas/packages/witness` | AGPL-3.0-or-later | 是 | 7/7 |

### 7.2 基座既有 workspace 包

基座包普遍不写 `license` 字段。它们 `private: true` 且不单独发布，由 `LICENSE.base`（MIT，基座层）覆盖——见 `NOTICE` 一、许可。**根 `LICENSE` 是阡陌自有层的 AGPL-3.0，不覆盖它们**：两层的权威判据是文件在不在基座快照 `base-snapshot/*` 里，不是文件头——**带头 ⇒ 属于 AGPL 层**成立，反向不成立：无头文件既可能是基座文件，也可能是不在基座快照里的阡陌文件；另有一批带着阡陌改动的基座文件有意不加头，这是独立限制、不是反例。具体个数与拆分现跑现算，命令与口径见 `NOTICE` 一、许可。**不建议在本任务里补字段**：那是基座发布面（CLAUDE.md §0）。

| 包 | 路径 | `license` | private |
|---|---|---|---|
| `@oh-my-pi/browser-relay` | `packages/browser-relay` | MIT | 是 |
| `@oh-my-pi/collab-web` | `packages/collab-web` | MIT | 是 |
| `@oh-my-pi/omp-stats` | `packages/stats` | MIT | 否 |
| `@oh-my-pi/omptype` | `packages/omptype` | MIT | 否 |
| `@oh-my-pi/pi-agent-core` | `packages/agent` | MIT | 否 |
| `@oh-my-pi/pi-ai` | `packages/ai` | MIT | 否 |
| `@oh-my-pi/pi-catalog` | `packages/catalog` | MIT | 否 |
| `@oh-my-pi/pi-coding-agent` | `packages/coding-agent` | MIT | 否 |
| `@oh-my-pi/pi-metaharness` | `packages/metaharness` | MIT | 是 |
| `@oh-my-pi/pi-mnemopi` | `packages/mnemopi` | MIT | 否 |
| `@oh-my-pi/pi-natives` | `packages/natives` | MIT | 否 |
| `@oh-my-pi/pi-tui` | `packages/tui` | MIT | 否 |
| `@oh-my-pi/pi-utils` | `packages/utils` | MIT | 否 |
| `@oh-my-pi/pi-wire` | `packages/wire` | MIT | 否 |
| `@oh-my-pi/snapcompact` | `packages/snapcompact` | MIT | 否 |
| `@oh-my-pi/typescript-edit-benchmark` | `packages/typescript-edit-benchmark` | MIT | 是 |
| `robomp-web` | `python/robomp/web` | MIT | 是 |

