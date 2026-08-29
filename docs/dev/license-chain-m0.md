# M0 许可链证据包与 `NOTICE` 核对（P8.4）

> **状态：v0.1-draft。**本文是 roadmap **P8.4「软著与开源预检」**交付物 ②③④ 的工程侧部分：
> 许可链证据包核对表、根 `NOTICE` 与实际状态一致性核对、以及学校科技处咨询的议题清单模板。
>
> **本文不构成法律意见。**所有涉及"MIT 能否覆盖上游被还原的表达"一类判断，一律留给
> 学校科技处/知识产权办公室（章程风险 L-2 对策③、`base-adoption.md` §5 Q-1）。
>
> **v0.1-draft 只列建议、不改文件；2026-08-15 起负责人授权处置了其中的事实性勘误。**
> `NOTICE` / `README*` / `LICENSE` / `BASE.md` 属对外表述面与溯源真源，改动须走章程 §5.8 第 4 条
> （负责人 + 安全 owner 双签）与 §2.4（`BASE.md` 由负责人维护）。**已落地的是 D-1（举证命令勘误）、
> D-3、D-4 的 `NOTICE` 侧与 D-2 的 `BASE.md` 侧**——均为把章程 v2.4 已定案的事实落到文本上，
> 不改任何口径实质；`LICENSE`（D-5）与 `package.json`（D-6）**未动**。逐条状态见 §3.2。
>
> 配套：机器可读依赖清单见 [`sbom-m0.json`](./sbom-m0.json)，人读摘要见 [`sbom-m0.md`](./sbom-m0.md)（`bun run sbom` 生成）。

---

## 1. 本文覆盖什么、不覆盖什么

| P8.4 交付物 | 本文 | 说明 |
|---|---|---|
| ① 第三方依赖 SBOM 与许可证清单 | 指针 | 见 [`sbom-m0.md`](./sbom-m0.md) / [`sbom-m0.json`](./sbom-m0.json) |
| ② 许可链证据包 | **§2** | 列"应有哪些件、每件当前在哪、缺什么"，**不代取需要人去取的材料** |
| ③ 根 `NOTICE` 与实际状态一致性核对 | **§3** | 逐条核对 + 建议改动（待双签） |
| ④ 学校科技处咨询记录 | **§5 模板** | 咨询本身是人做的；本文给议题清单，至少含 L-2 与 L-5 |
| 依赖树里的授权疑点人工核读 | **§4** | SBOM 只读字段、不读授权正文，语义结论记在这里 |

**DoD 中机器可判的两条**：

- **无 GPL 类传染性许可项** —— `bun run sbom --check` 判定。当前结果：**强传染 / 网络传染 0 项，受限/非自由 0 项**；弱传染（文件级）5 项，逐项处置见 [`sbom-m0.md`](./sbom-m0.md) §3。
- **`NOTICE` 与实际状态一致** —— 见 §3。两条硬差异（D-1、D-2）**已于 2026-08-15 处置**（负责人授权），
  另处置 D-3、D-4 的 `NOTICE` 侧。**工程侧一致性已达成**；本条最终判 PASS 仍需负责人 + 安全 owner
  对改后文本双签（章程 §5.8 第 4 条），且 D-4 的 `vendor/audio-capture/` 许可归属仍是待人项（见 U-4）。

---

## 2. 许可链证据包核对表

章程 L-2 对策② 列了四件：基座 `LICENSE`（MIT）、npm 公开发布记录、负责人对基座的归属关系、pin 提交与 tag。
下表按"一件证据 = 一行"展开，并补上本次审计发现的两件（E-6、E-7）。

**状态图例**：✅ 齐备且在仓库内可查 · 🟡 齐备但在仓库外（需保存快照入证据包） · ❌ 缺口（需人去取或需负责人补记）

| # | 证据件 | 应证明什么 | 当前位置 | 状态 |
|---|---|---|---|---|
| **E-1** | 基座 `LICENSE`（MIT 正文 + `Copyright (c) 2026 open-claude-code contributors`） | 基座以 MIT 授权，允许使用/修改/再分发，条件是保留声明 | 本仓库根 [`LICENSE`](../../LICENSE)（随基座快照导入，未改动） | ✅ |
| **E-2** | 上游仓库同一 tag 的 `LICENSE` | 仓库内那份就是上游那份 | 上游 GitHub `https://github.com/sweetcornna/open-claude-code`（URL 出处见 E-5 说明） | 🟡 需存网页/tarball 快照 |
| **E-3** | npm 公开发布记录 | 基座是**公开发布**的开源包，不是私下产物 | npm registry。已实查（2026-08-15）：包名 `@sweetcornna/open-claude-code`，`license: "MIT"`，**v2.38.3 发布时间 `2026-08-11T14:06:24.040Z`**，包首次发布 `2026-08-03T06:27:30Z` | 🟡 需存 `npm view` 输出与包页面快照 |
| **E-4** | **npm tarball 的 `gitHead` 字段** | **把 npm 上的 v2.38.3 与 pin 提交直接绑死** | 实查结果：`gitHead = 848ad8c2c8daca9f5aa2410da555553e07700f5d`，与本仓库 `BASE.md` 记录的 pin **逐字一致**；同版本 `dist.shasum = 41a7d8a71c3ec5454beb0c0196d8165752724e14` | 🟡 需存快照 |
| **E-5** | pin 提交与 tag | 锁定的是哪一版基座 | `BASE.md`（pin 全 SHA + tag v2.38.3）。**本仓库 `git tag` 为空（实测 0 个 tag）**——本仓库经快照导入、不含上游历史，tag 只存在于上游仓库。pin 的可核性靠三条互相独立的链路：① `BASE.md` 记录；② E-4 的 npm `gitHead`；③ P7.4 演练在一次性 clone 中比对上游 tag 的结果（见 [`upstream-sync-drill.md`](./upstream-sync-drill.md) §2：`git diff 3380c88 v2.38.3` 的基座文件修改数为 **0**，零改动快照声明成立） | ✅（本仓库侧）/ 🟡（上游侧需快照） |
| **E-6** | 第三方依赖 SBOM 与许可清单 | 依赖树里没有会污染成果的许可 | [`sbom-m0.json`](./sbom-m0.json) / [`sbom-m0.md`](./sbom-m0.md)，`bun run sbom` 可复现 | ✅ |
| **E-7** | 依赖树中唯一一项非开源授权的定性与影响面 | 主动披露而不是被问出来 | 见 §4（`@anthropic-ai/claude-agent-sdk`） | ✅ |
| **E-8** | **负责人对基座的归属关系** | 「基座是项目负责人自有的开源项目」这句话本身 | **仓库内无任何证据。**仓库里能查到的只有账号标识：npm maintainer `sweetcornna <ymy_live@outlook.com>`、GitHub 组织/用户 `sweetcornna`、`package.json` 的 `author: "open-claude-code"` | ❌ **最大缺口，见下** |
| **E-9** | 上游仓库 URL 写进溯源真源 | 溯源可追 | **已补记（2026-08-15，负责人授权，单独提交）**：`BASE.md` 现记「上游仓库 `https://github.com/sweetcornna/open-claude-code`」，原本地路径 `/Users/cornna/project/open-claude-code` 保留但标注为导入当时的本地副本、非权威地址；另补 npm 侧佐证一行（`repository.url` + v2.38.3 `gitHead`，即 E-3/E-4） | ✅ |

### E-8 说明：这件必须由人去取，工程侧取不到

"负责人自有"目前在文档里是**立项决议的断言**（章程 §5.1 归属行的核实出处就写着"立项决议"），仓库里没有任何可独立验证的对应关系。要闭合它，需要下列材料**至少三选二**，且都只能由负责人本人提供：

1. **npm 账号所有权**：以 `sweetcornna` 账号登录 npmjs.com 的账号设置页截图（含绑定邮箱 `ymy_live@outlook.com`），或 `npm whoami` 在负责人机器上的输出录屏；
2. **GitHub 账号所有权**：`github.com/sweetcornna` 账号设置页 / 仓库 Settings 页截图，证明对 `sweetcornna/open-claude-code` 有 owner 权限；
3. **实名对应**：上述账号邮箱与负责人本人身份的对应（学校邮箱绑定、或账号页公开的实名信息）。

**不要用"我们能推到那个仓库"来代替**——推送权限不等于著作权归属。这三件是科技处咨询时最可能被追问的一组，建议在咨询前先备齐（见 §5 议题 T-2）。

---

## 3. 根 `NOTICE` 与实际状态一致性核对

核对对象：根 [`NOTICE`](../../NOTICE)、[`LICENSE`](../../LICENSE)、[`README.md`](../../README.md)（含基座 `README.zh.md` / `README.ja.md`）、[`BASE.md`](../../BASE.md)、`src/constants/brand.ts` 顶部注释、根 `package.json` 的 `name` / `license` / `author`。

### 3.1 一致的部分（无需改动）

| 核对项 | 结论 |
|---|---|
| 许可声明为 MIT | ✅ 一致。`NOTICE` 一/1 = MIT；`LICENSE` = MIT 正文；`package.json` `"license": "MIT"`；`README.md` §许可 = MIT |
| `@qianmo/*` 随仓库以 MIT 发布（章程 §5.5） | ✅ 一致。**17 个 `@qianmo/*` 包 `license` 字段全部为 `MIT`**，逐包核对见 [`sbom-m0.md`](./sbom-m0.md) §7.1 |
| `@qianmo/*` 版权头两行（章程 §5.5 v2.5） | ✅ 全覆盖。17 个包共 217 个 `.ts` 文件，首两行为 `// Copyright 2026 Qianmo AgentNest Team` + `// SPDX-License-Identifier: MIT` 的比例为 **217/217**，逐包比例见 [`sbom-m0.md`](./sbom-m0.md) §7.1 |
| 商标声明与章程 §5.8 第 2 条 | ✅ 一致。`NOTICE` 四/4 声明"无关联、未获背书、未获赞助"，与章程 §5.2② 第 2 条、README.md 末段逐条对应 |
| "明确不改"标识清单 | ✅ 一致。`NOTICE` 四列出的 5 条（系统提示词前缀 / `claude-code/<version>` UA / OTel `service.name` / `CLAUDE.md`·`CLAUDE.local.md`·`AGENTS.md` / `CLAUDECODE=1`）与 `src/constants/brand.ts` 顶部注释、章程 §5.2③ **逐条一致，无增无漏** |
| 基座性质如实声明（逆向复原） | ✅ 一致。`NOTICE` 三 与章程 §5.2②、`base-adoption.md` §5 R-1 一致；且**不作法律判断**的措辞与章程口径吻合 |
| 提到 npm 包名 `@sweetcornna/open-claude-code` | ✅ 提到了。`NOTICE` 二（中）与 2（英）均列出 |
| 基座 README 的"仅供学习研究用途"（L-5） | ✅ 已解除。仓库内 `README.zh.md`（第 190 行）与 `README.ja.md`（第 168 行）的许可段已无用途限定，与章程 L-5「已解决」一致（实读核对） |

### 3.2 差异清单（每条前缀即当前状态：✅ 已处置 / 决定保留 · 🟡 部分处置 · ⏸ 仍待人）

> 本节 v0.1-draft 时是"只列建议、不要直接改"。**2026-08-15 起，D-1 / D-2 / D-3 与 D-4 的 `NOTICE` 侧
> 已由负责人授权处置**；每条开头的引用块是处置记录，其下的"原现状/实际/实测"保留为处置依据，
> **不再是现状描述**。未标"已处置"的条目（D-4 的许可归属、D-5）仍是待人项，`LICENSE` 与
> 根 `package.json` 未动。

#### D-1 ✅ 已处置 —— `NOTICE` 的成果边界举证命令是失效的（原**硬差异，DoD 阻断项**）

> **处置（2026-08-15，负责人授权，与本次修订同一提交）**：`NOTICE` 中文「二、基座溯源」节末与英文
> section 2 节末的举证命令已改为以本仓库导入提交 `3380c88` 为基线（工作面 `git diff 3380c88..HEAD`、
> 工作记录 `git log 3380c88..HEAD`、基座贡献边界 `git show --stat 3380c88`，另加 `67f6081` / `74f7a22`），
> 并各补一句「本仓库经零改动快照导入、不含上游 git 历史，故以导入提交为基线」；**`848ad8c2` 作为上游
> pin 的 SHA 陈述保留**（那是事实，只是不能当本仓库的 diff 基线）。`README.md` 基座说明段同批修正。
> 中英两部分内容等同。**下方原文保留为处置依据，不再是现状描述。**

- **原现状**：`NOTICE` 中文版第 45–46 行、英文版第 133–134 行写着
  「pin 提交 848ad8c2 之后的全部提交为阡陌团队的工作。`git diff 848ad8c2..HEAD` 即为本项目的工作面。」
- **实际**：章程 **v2.4 §5.5「举证命令勘误」**已判定该命令在本仓库不可执行——本仓库经快照导入、不含上游 git 历史，`848ad8c2` 是**上游仓库**的 SHA。正确基线是**本仓库的基座导入提交 `3380c88`**。
- **实测（2026-08-15，两组对照）**：

  | 环境 | `git rev-parse 848ad8c2` | `git diff --shortstat 848ad8c2..HEAD` |
  |---|---|---|
  | 从本仓库做的**干净 clone** | `fatal: unknown revision` | 无法执行 |
  | 当前开发机主检出 | 意外解析成功 | 466 files / +72,275 / −555 |
  | 当前开发机主检出（正确命令 `3380c88..HEAD`） | — | 431 files / +71,710 / −1,362 |

  主检出里 `848ad8c2` 之所以解析得出，是因为本地存在一个**游离对象**——它不被任何 ref 可达（`git for-each-ref --contains` 为空、`git merge-base --is-ancestor` 为否），因此**不随 clone/fetch 传播**，也会被 `git gc --prune` 回收。
- **为什么这条必须改**：这是**答辩现场最危险的一种不一致**——在负责人自己机器上跑得出结果（且是**另一个**结果：多出 36 个文件，那是导入前立项提交 `67f6081`/`74f7a22` 的申报材料），到评审方的 clone 上直接 `unknown revision`。风险 L-1 的举证一旦当场跑失败，伤害远大于命令本身。
- **原建议改动（已执行）**：`NOTICE` 中英两处的举证命令改为 `git diff 3380c88..HEAD`，并按章程 §5.5 补一句"另加导入前的立项提交 `67f6081`、`74f7a22`"。**README.md 第 20 行有同一处错误，已同批修正。**

#### D-2 ✅ 已处置 —— `BASE.md` 的上游记录不含公开仓库 URL（原**硬差异**）

> **处置（2026-08-15，负责人授权，单独提交 `0c2f3b17`）**：`BASE.md` 已补上游公开仓库 URL
> （原本地路径保留并标注为导入当时的本地副本）、npm 侧佐证一行，并新增「上游同步演练记录」一节
> 记入 P7.4 对 v2.46.0 的演练（0.39% 冲突率 / typecheck 零错 / 11311 测试全绿 / 工时 10–20 h，
> 详见 [`upstream-sync-drill.md`](./upstream-sync-drill.md)）。**pin 不变、零改动声明不变。**
> 第 7 行已过期的括注「（立项文档提交后生效）」同批删去。**下方原文保留为处置依据。**

- **原现状**：`BASE.md` 第 3 行记「导入自本地仓库 `/Users/cornna/project/open-claude-code` 的已提交快照」。
- **章程要求**：§5.6① 规定 `BASE.md` 内容"至少包括：**上游仓库**、pin 提交全 SHA 与对应 tag、导入日期、零改动声明、同步记录"。**上游仓库这一项当前是一条本地路径**，对仓库之外的任何人都不可验证。
- **公开 URL 有据可查**：`https://github.com/sweetcornna/open-claude-code`（根 `README.md` 第 20 行；npm 元数据 `repository.url` = `git+https://github.com/sweetcornna/open-claude-code.git`）。
- **建议改动**：由负责人在 `BASE.md` 补记公开仓库 URL。这属于"导入/同步记录"事件，是 §2.4 允许改 `BASE.md` 的两类之一，**不得在功能 PR 里顺手改**。
- **顺带**：`BASE.md` 第 7 行"上游同步：暂定人工比对……（立项文档提交后生效）"的括号已过期（立项文档早已入库）；且 **P7.4 演练已执行**（记录见 [`upstream-sync-drill.md`](./upstream-sync-drill.md)，该文自述"评审与章程 §5.7 回写待做，DoD 未闭环"）**但未记入 `BASE.md`**——roadmap P7.4 交付物一栏写明"`BASE.md` 记录本次演练"。同属负责人维护范围。

#### D-3 ✅ 已处置 —— `NOTICE` 五「第三方组件」的表述已落后于实际

- **原现状**：「完整的依赖与许可清单（SBOM）**随项目发布材料提供**。」
- **实际**：SBOM 现已入库，`bun run sbom` 可复现。
- **处置（2026-08-15）**：`NOTICE` 五（中）/ 5（英）改为指向仓库内路径 `docs/dev/sbom-m0.json` 与 `docs/dev/sbom-m0.md`，并注明由 `bun run sbom` 生成、可复现。遵守"指针不复制"，清单内容未抄进 `NOTICE`。

#### D-4 🟡 部分处置 —— `NOTICE` 五未覆盖仓库内的预编译二进制

- **现状**：`NOTICE` 五只说"基座及其依赖树引入的第三方组件"。
- **实际**：仓库里还有**不来自 npm 依赖树**的第三方二进制（详见 [`sbom-m0.md`](./sbom-m0.md) §6）：
  - `vendor/audio-capture/`：**6 个平台的 `audio-capture.node`（已入库）**，仓库内**无源码、无构建脚本、无 LICENSE、无溯源记录**，且由 `build.ts` / `scripts/post-build.ts` 复制进 `dist/vendor/` 随产物分发；
  - `src/utils/vendor/ripgrep/`：ripgrep 可执行文件，**不入库**（`.gitignore` 第 12 行），由 `scripts/postinstall.cjs` 从 `microsoft/ripgrep-prebuilt` v15.0.1 下载并逐档案校验 SHA-256——**这一项溯源是清楚的**。
- **处置（2026-08-15）**：`NOTICE` 五（中）/ 5（英）已补「随仓库分发的预编译原生二进制」两条，逐条写明位置、入库状态、是否随 `dist/` 分发、以及许可溯源状态。ripgrep 一条溯源清楚（构建工程 microsoft/ripgrep-prebuilt 以 MIT 发布，ripgrep 本体许可以上游 BurntSushi/ripgrep 的许可文件为准）；`vendor/audio-capture/` 一条如实写「源码与许可待上游确认」，**未推定任何许可**。
- **`vendor/audio-capture/` 上游溯源核查结果（2026-08-15 实查，结论：上游同样没有）**：

  | 查了什么 | 结果 |
  |---|---|
  | 上游仓库树 `https://github.com/sweetcornna/open-claude-code/tree/main/vendor/audio-capture` | **只有六个平台三元组目录**（`arm64|x64-darwin|linux|win32`），无源码、无 `Cargo.toml` / `build.rs` / `binding.gyp`、无 `LICENSE`、无 `README` |
  | 上游 `packages/audio-capture-napi/` | 与本仓库一致，**纯 TypeScript**（`package.json` / `tsconfig.json` / `src/`），无原生源码 |
  | 上游仓库根与 README | 未提及 `vendor/`、预编译二进制或音频采集的构建方式 |
  | 本仓库全树 `Cargo.toml` / `*.rs` | **0 命中** |
  | 二进制符号（`strings` 读 `.node`） | Rust + napi-rs 构建：静态链接 `napi 2.16.17`、`cpal 0.15.3`；平台相关 `coreaudio-rs 0.11.3`（darwin）、`alsa 0.9.1`（linux）、`windows 0.54.0`（win32）；导出 `start_recording` / `stop_recording` / `start_playback` / `microphone_authorization_status` 等 |

  **能确定的**：这是一个用 Rust + napi-rs 写的音频采集/播放插件，静态链接了上述几个公开 crate。
  **不能确定的**：**模块自身**的源码在哪、以什么许可发布。静态链接的 crate 各有其自身许可（以各自 crates.io / 仓库的许可文件为准，本文不代为判定），但它们的许可**不能**替代模块自身的许可声明。
- **仍待人（U-4，范围已收窄）**：既然上游仓库里也没有源码与 LICENSE，这一条只能由**负责人以基座作者身份**给出：该原生模块的源码在哪个仓库/分支、以什么许可发布，以及是否愿意把源码或 LICENSE 补进上游 `vendor/audio-capture/`。M0 演示不使用音频能力（章程 N-9 口径），但"不使用"不等于"不分发"——它随 `dist/vendor/` 出货。咨询议题 T-5.2 保持不变。

#### D-5 ⏸ 仍待人 —— `LICENSE` 只有基座的版权行，没有阡陌的（观察项）

- **现状**：`LICENSE` 仅 `Copyright (c) 2026 open-claude-code contributors`；`NOTICE` 第 2 行另有 `Copyright 2026 Qianmo AgentNest Team`。
- **说明**：MIT 只要求**保留**上游声明，因此现状不违规；但软著材料通常希望在许可文件里也体现本团队的版权主体。
- **建议**：**列为科技处咨询议题**（§5 T-4），按其口径再决定是否在 `LICENSE` 增列阡陌版权行。不要凭工程判断改 `LICENSE`。

#### D-6 ✅ 决定保留 —— 根 `package.json` 仍带基座的发布元数据（观察项，**不改**）

- **现状**：`name` = `@sweetcornna/open-claude-code`、`version` = `2.38.3`、`author` = `open-claude-code`、`repository`/`homepage`/`bugs` 均指向基座仓库。
- **张力**：README 与章程 N-14 都写明"本仓库不发 npm 包"，而 `package.json` 看起来就是基座那个 npm 包。审查者可能据此提问。
- **建议**：**不改**（这是基座发布面，`CLAUDE.md` §0 明确不维护），但**在答辩 Q&A 预案（P8.3）里备一句解释**："这是 fork 布局的自然结果，本仓库不执行 `publish`，`publish-npm.yml` 与 release 流程按 roadmap P0.4 处置。"

#### D-7 ✅ 已处置 —— 首次上游同步后 `NOTICE` / `README.md` 的 pin 陈述过期（**新差异，本节 v0.1 起草时尚不存在**）

> **处置（2026-08-28，开源就绪批次）**：`NOTICE` 中文「二、基座溯源」与英文 section 2 的溯源块、
> 以及 `README.md` 第 20 行，均改为**区分两个 pin**：导入提交 `848ad8c2`（v2.38.3，历史锚点，
> 不随同步变化）与当前锁定 `1128a391`（v2.46.0，2026-08-17 首次同步后）。用词与 `BASE.md`
> 第 6 / 8 行一致。中英两部分内容等同。**属事实性勘误**，未改变任何口径或范围。

- **怎么来的**：D-1 那批（2026-08-15）修的是**举证基线**（`848ad8c2..HEAD` → `3380c88..HEAD`），
  当时 pin 陈述本身是对的。两天后 P10.2 把基座同步到 v2.46.0、pin 迁至 `1128a391`
  （章程 v2.13、`BASE.md`「上游同步记录」），**同一处文本因此第二次失准**——这次错的不是命令而是事实。
- **为什么必须改**：`NOTICE` 是溯源声明，是评审方读「基座是什么版本」的地方。它与 `BASE.md` 各说一个 pin，
  等于对外声明与溯源真源自相矛盾；`README.md` 更是自相矛盾——第 20 行说锁定在 v2.38.3，
  第 22 行同时描述「v2.38.3 → v2.46.0 的首次同步」。
- **给下次同步的提示**：pin 出现在 `BASE.md`（2 处）、`NOTICE`（中英各 1 处）、`README.md`（1 处）。
  **`BASE.md` 之外那三处不在同步流程的 checklist 里**，v2.13 回写就是这么漏掉的。
  建议把它们并入 `upstream-sync-drill.md` 的同步后回写清单。

#### D-8 ✅ 已处置 —— `SECURITY.md` 与 issue 模板仍是基座的对外面（原**硬差异，转公开阻断项**）

> **处置（2026-08-28，开源就绪批次）**：`SECURITY.md` 按本仓库重写；
> `.github/ISSUE_TEMPLATE/` 的 `bug_report.md` / `feature_request.md` / `config.yml` 改指本仓库。

- **原现状**：三份文件自 v2.46.0 同步以来**与基座逐字相同**（`git diff base-snapshot/v2.46.0..HEAD` 无差异）。
  于是本仓库的漏洞报告入口指向 `sweetcornna/open-claude-code/security/advisories/new`、
  issue 前必读指向基座的 issue 列表与 README、`config.yml` 指向基座 Discussions
  （**本仓库 Discussions 未启用**，那是一条死链）。
- **为什么这条比看起来严重**：仓库转公开后，第一份安全报告会**私密地进到另一个仓库**。
  报告者以为已经报了，本仓库却收不到，且因为 advisory 私密，双方都不会发现投递错了地方。
- **改了什么**：`SECURITY.md` 去掉基座的「受支持版本」表（本仓库不发版本，判据是 commit）、
  补 M0 阶段与未经审计的如实声明、新增「问题出在哪一侧」归属表（阡陌 / 基座 / 上游三分），
  并把安全边界从基座那五条换成阡陌的威胁模型（签名分档与能力令牌、`LIMITS` 防放大、
  每节点 PSK 与身份私钥、控制台的转义顺序即 XSS 边界），基座继承的隔离与凭据两条保留。
- **同批**：`CONTRIBUTING.md` 开篇仍写「欢迎参与 open-claude-code」并把本项目自述为「逆向/反编译社区版」
  ——那是**基座**的定位。按章程 §5.8 标准表述改成「两层」结构；基座那层的逆向溯源**如实保留**（§5.8 第 3 条
  要求被问及时不回避，删掉反而违规）。另补 §10.1「仓库外的贡献者」（fork 流程、不需要 CLA、范围以章程为准、
  基座改动优先发上游、安全问题不走 PR/issue）。
- **未动**：`.github/pull_request_template.md`（已是阡陌版）、`.github/workflows/ci.yml`。

---

## 4. 依赖树里的非 SPDX / 非开源授权项：人工核读结论

`bun run sbom` 只读 `license` 字段、不读授权正文。[`sbom-m0.md`](./sbom-m0.md) §4 列出的 4 项，逐项人工核读结果如下（核读日期 2026-08-15）。

| 包 | `license` 字段 | 实际授权（读正文） | 影响面 | 处置 |
|---|---|---|---|---|
| **`@anthropic-ai/claude-agent-sdk` 0.2.114** | `SEE LICENSE IN README.md` | 包内 `LICENSE.md` 全文为：**「© Anthropic PBC. All rights reserved.」**+ 指向 Anthropic 法律条款页。**这是专有授权，不是开源许可** | 位于根 `devDependencies`。全仓**仅两处引用**：`src/cli/print/runHeadlessStreaming.ts:29` 是 **`import type`（纯类型，编译期擦除）**，`src/services/acp/agent/AcpAgent.ts:5` 是注释里的一句"不使用它"。**实测 `dist/` 中无任何该包的引用**（`grep -rl "claude-agent-sdk" dist` 无输出），即**不进入分发产物** | **主动披露**，不要等被问。见下方"为什么这条重要" |
| `@anthropic-ai/claude-agent-sdk-darwin-arm64` 0.2.114 | `SEE LICENSE IN LICENSE.md` | 同上（上一项的平台原生包） | 同上；另有 7 个平台变体在 lockfile 中、本机未安装 | 同上 |
| `@modelcontextprotocol/server-filesystem` 2026.7.10 | `SEE LICENSE IN LICENSE` | **包内没有 `LICENSE` 文件**（tarball 只含 `README.md` / `dist/` / `package.json`）——字段指向的文件未随包发布，授权正文在本机不存在 | 仅被**测试**使用（`tests/integration/qianmo-mcp-conformance.test.ts` 以子进程启动 `node_modules/.../dist/index.js`），不被 `src/` 引用、不进 `dist/` | 到上游 `modelcontextprotocol/servers` 仓库取许可正文存证；**不阻断** |
| `@modelcontextprotocol/server-memory` 2026.7.4 | `SEE LICENSE IN LICENSE` | 同上（包内无 `LICENSE` 文件） | 同上 | 同上 |

### 为什么 `@anthropic-ai/claude-agent-sdk` 这条重要

它把两件本来分开的事放到了一起：`NOTICE` 四声明"本项目与 Anthropic 无关联"，而依赖树里确实躺着一个 **Anthropic PBC 保留一切权利**的包。这不是矛盾——依赖一个公司的 SDK 与"获得该公司授权/背书"是两回事——但它是**评审方一查 `package.json` 就能看到、而我们没主动说**的那一类事实，正是风险 L-1/L-4 最容易被放大的形态。

**工程侧已确认的缓解事实**（可直接用于答辩）：

1. 它是**类型依赖**，不是运行时依赖——唯一的代码引用是一个 `import type`；
2. **产物里没有它**——`dist/` 中零引用（可现场复跑 `grep -rl "claude-agent-sdk" dist`）；
3. 因此**分发阡陌产物不构成再分发该 SDK**。

### 决定（2026-08-15，负责人授权）：**保留依赖 + 主动披露**，不移除

原提请评审的问题是「要不要把这一处 `import type` 换成本地类型声明，让依赖树里彻底没有专有授权项」。**决定不换，理由三条**：

1. **影响面本来就极小**：全仓仅一处 `import type`（`src/cli/print/runHeadlessStreaming.ts:29`，编译期擦除）加两处注释，`dist/` 零命中——它已经不在分发面上，移除它换来的只是「依赖清单里少一行」的观感。
2. **代价落在基座依赖图上**：移除要改基座根 `package.json` 与 `bun.lock`。基座的发布面本仓库不维护（`CLAUDE.md` §0），且每动一次依赖图，下次上游同步就多一处必然冲突——P7.4 演练的结论正是「上游对 `package.json` 的唯一改动是版本号、`bun.lock` 未动」这份零漂移是当前低冲突率的一部分（[`upstream-sync-drill.md`](./upstream-sync-drill.md) §3.3）。**为观感去动基座依赖图不值。**
3. **披露比移除更符合口径**：风险 L-1/L-4 怕的是「评审方一查 `package.json` 就看到、而我们没主动说」，解法是**说**，不是**藏**。移除后依赖清单干净了，但「曾经依赖过」仍在 git 历史里，反而多一层要解释的东西。

**落地**：根 `NOTICE` 五（中）/ 5（英）已补一条**开发期专有授权依赖披露**——写明它是 devDependencies、专有授权（包内 LICENSE.md「© Anthropic PBC. All rights reserved.」）、仅 `import type`、`dist/` 零命中不随产物分发、其许可条款以其包内 LICENSE 为准，并明确该披露**不构成**与 Anthropic, PBC 的关联/授权/背书关系。同时保留 P8.3 Q&A 预案里的三条缓解事实。

**仍要做的**：科技处议题 T-5.1（是否需要在申报材料中同样披露）不变，等其口径。

---

## 5. 学校科技处 / 知识产权办公室咨询议题清单（模板）

> **使用方式**：咨询由**安全 owner（陈曦宇）**主办、负责人（喻永昌）参加（章程 §6.2 L-2 责任人）。
> 本清单是**去咨询时带的问题单**，不是答案单。**每条都要带走一句可复述的口径**——章程 P8.4 的 DoD 写的是
> "科技处咨询已完成并有**书面或可复述的口径**"，只带回"他们说应该没问题"不算完成。
>
> **退路预留**：若口径要求更强隔离，**立即触发范围评审**（章程 L-2 对策⑤）。不要假定一定过。

### 5.0 咨询前须备齐

- [ ] §2 表中 ✅ / 🟡 各项的快照（网页、`npm view` 输出、tarball 元数据）
- [ ] **E-8 的归属关系材料**（最可能被追问的一组，工程侧取不到）
- [ ] 本文 §3 的 `NOTICE` 差异清单（说明哪些已修、哪些待其口径再定）
- [ ] [`sbom-m0.md`](./sbom-m0.md)（一句话结论：无强传染许可项）
- [ ] `base-adoption.md` §5 R-1 的事实四条（**逆向工程溯源，不要隐去**）

### 5.1 议题 T-1 ⚖️ 逆向工程溯源与 MIT 的覆盖范围（**风险 L-2 核心，必问**）

> 出处：章程 §6.2 L-2、`base-adoption.md` §5 **Q-1**。

**事实陈述（照读，不要润色）**：本项目的基座 open-claude-code 由项目负责人自有并以 MIT 在 npm 公开发布；该基座**自述**为对 Anthropic Claude Code 的**逆向复原（reverse-engineered restoration）**，并记录它 fork 自另一个还原工程。

**要问的**：

- **T-1.1** MIT 是基座作者对**其自身还原与原创工作**的授权。它能否覆盖**上游被还原的表达**？在软著申请与竞赛成果认定中，这一层会被如何看待？
- **T-1.2** 我方是该基座的**下游 fork**（公开事实，不隐瞒）。软著申请时，作品说明里应当如何描述"基于自有 MIT 开源项目的下游 fork + 自研常驻化改造与通信网络"这一形态？**是按"改编作品"申报，还是只就新增部分申报？**
- **T-1.3** 若评审方要求证明"新增部分独立可分"，`git diff 3380c88..HEAD` 这类 git 基线举证是否被接受？还有没有更被认可的举证形式？
- **T-1.4** **退路**：若贵处认为溯源风险不可接受，我们应当把隔离做到什么程度才算达标？（此问的答案直接决定是否触发范围评审）

### 5.2 议题 T-2 ⚖️ 归属关系的举证标准

> 对应本文 **E-8 缺口**。

- **T-2.1** 「基座是项目负责人自有」这一事实，需要哪些材料才算证成？npm/GitHub 账号所有权截图够不够？需不需要更正式的权属声明？
- **T-2.2** 负责人个人持有的开源项目，被用作**学校立项项目**的基座，权属上有没有需要事先处理的事项（职务作品认定、学校对成果的权利主张等）？
- **T-2.3** 若基座本身也需要登记，与本项目的软著是分开登记还是合并？

### 5.3 议题 T-3 ⚖️ 用途限定与商业化路径（**风险 L-5 轨道**）

> 章程 L-5 已于 2026-08-11 由基座侧修正三语 README 而**解除**（用途限定移除，许可正文与自述一致，见章程 §6.2 L-5、`base-adoption.md` §5 Q-2）。
> **本议题是复核，不是重开**——目的是拿到科技处对"已解除"这一判断的确认。

- **T-3.1** 基座 README 曾含"**仅供学习研究用途**"字样、其后由基座作者（即本项目负责人）自行修正。这种"作者自行修正自述"的处理方式，在申报材料里需要说明吗？**历史版本仍留在上游 git 历史里**，会不会构成问题？
- **T-3.2** 已解除的这一条，与 **M3 商业化**（章程规划 2028）之间还有没有遗留约束？
- **T-3.3** 若答辩现场被出示 README 的**历史版本**并追问，建议口径是什么？

### 5.4 议题 T-4 许可文件与声明的形式要求

> 对应本文 **D-5**。

- **T-4.1** 我方仓库沿用基座 MIT，`LICENSE` 中目前只有基座的版权行。软著申报是否要求（或建议）在 `LICENSE` 中增列本团队版权行？增列会不会影响"沿用基座许可"这一表述？
- **T-4.2** 根 `NOTICE` 现有的四节结构（许可 / 基座溯源 / 基座性质如实声明 / Anthropic 商标）是否满足申报要求？还缺什么？
- **T-4.3** 代码中**技术性保留**的 Anthropic 标识（系统提示词前缀、User-Agent、OTel `service.name`、`CLAUDECODE=1` 等，改动会破坏功能）——现有的"技术性保留不构成关联性主张"声明措辞是否足够？

### 5.5 议题 T-5 第三方依赖与预编译二进制

- **T-5.1** 依赖树中存在一项 **Anthropic PBC 专有授权**的包（`@anthropic-ai/claude-agent-sdk`，仅类型引用、不进产物，见 §4）。**是否需要在申报材料中主动披露？**
- **T-5.2** 仓库内含**源码与许可未确认的预编译原生二进制**（`vendor/audio-capture/`；**上游仓库里同样只有六个 `.node`、无源码无 LICENSE**，实查见 D-4）。它随产物分发但 M0 不使用该功能——需不需要在申报前移除、或由基座作者补齐源码与许可？（`NOTICE` 已如实披露现状，未推定许可）
- **T-5.3** 弱传染许可（LGPL-3.0-or-later 的 `@img/sharp-libvips-*`、MPL-2.0 的 `lightningcss` 等，共 5 项）在软著申报中需要单独说明吗？

### 5.6 咨询结论回填（**咨询后填，空着即视为 P8.4 未闭环**）

| 议题 | 科技处口径（可复述） | 是否触发范围评审 | 记录人 / 日期 |
|---|---|---|---|
| T-1 | | | |
| T-2 | | | |
| T-3 | | | |
| T-4 | | | |
| T-5 | | | |

---

## 6. 未决事项

| # | 事项 | 谁做 | 阻断什么 | 状态 |
|---|---|---|---|---|
| U-1 | `NOTICE` 中英两处举证命令改为 `3380c88..HEAD`（D-1）；`README.md` 同批修正 | — | **P8.4 DoD「`NOTICE` 与实际状态一致」** | ✅ **已处置**（2026-08-15，负责人授权）。**剩余**：改后文本仍需负责人 + 安全 owner 双签确认（章程 §5.8 第 4 条） |
| U-2 | `BASE.md` 补记上游公开仓库 URL；补记 P7.4 演练（D-2） | — | P8.4 证据包 E-9；P7.4 交付物 | ✅ **已处置**（提交 `0c2f3b17`，负责人授权的记录事件） |
| U-3 | 取齐 E-8 归属关系材料 | 负责人本人 | 科技处咨询 T-2；证据包最大缺口 | ⏸ **仍待人**（工程侧取不到，见 §2「E-8 说明」） |
| U-4 | `vendor/audio-capture/` **源码位置与许可**说明（D-4） | 负责人（以基座作者身份） | 证据包完整性；咨询 T-5.2 | ⏸ **仍待人，范围已收窄**：`NOTICE` 侧已如实披露（含上游同样无源码/无 LICENSE 的核查结果与二进制符号读出的 crate 清单）；缺的只剩「模块自身源码在哪、以什么许可发布」 |
| U-5 | 上游 `LICENSE` / npm 页面 / tarball 元数据快照存证（E-2/E-3/E-4） | 安全 owner | 证据包 🟡 转 ✅ | ⏸ 仍待人 |
| U-6 | 科技处咨询实施并回填 §5.6 | 安全 owner 主办 | **P8.4 DoD「科技处咨询已完成」** | ⏸ 仍待人 |
| U-7 | 是否移除对 `@anthropic-ai/claude-agent-sdk` 的类型依赖（§4） | — | 无（优化项） | ✅ **已决**：保留 + 主动披露，理由与落地见 §4「决定」 |
| U-8 | 在其它目标平台各跑一次 `bun run sbom` 并表（本机 `darwin-arm64` 读不到 198 项平台包的许可字段） | 谁有对应机器谁跑 | SBOM 全平台完整性 | ⏸ 仍待人 |
| U-9 | `LICENSE` 是否增列阡陌版权行（D-5） | 科技处口径（T-4.1）后由负责人定 | 无（形式项） | ⏸ 仍待人，**本次未动 `LICENSE`** |
| U-10 | `NOTICE` / `README.md` 的 pin 陈述跟进首次上游同步（D-7） | — | `NOTICE` 与 `BASE.md` 互相矛盾 | ✅ **已处置**（2026-08-28）。改的是已双签件的正文，属 D-1 同类的**事实性勘误**（把 `BASE.md` 与章程 v2.13 已定案的事实落到文本上），按 D-1 先例处理；**不另设签署待办**——M0 流程件已于 2026-08-17 负责人决议关闭（roadmap v2.41） |
| U-11 | `SECURITY.md` 与 issue 模板对外化（D-8） | — | **仓库转公开**（漏洞报告会误投基座仓库） | ✅ **已处置**（2026-08-28）。新写的对外文本，负责人转公开前过一眼即可；同上不另设签署待办 |
| U-12 | 把 `NOTICE` / `README.md` 的 pin 陈述并入上游同步后的回写清单 | — | 无（防复发） | ✅ **已处置**（2026-08-28）：记入 [`upstream-sync-drill.md`](./upstream-sync-drill.md) §7.1 第 5 条 |
