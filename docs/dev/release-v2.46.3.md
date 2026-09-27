<!-- Copyright 2026 Qianmo AgentNest Team -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# 阡陌 v2.46.3 GitHub Release

负责人 2026-09-26 决定：把两项高危安全修复及相关文档合入 `main` 后发布 v2.46.3。本版是安全补丁，只含安全修复与相关文档，不改任何功能面。发行仓库、形式与 v2.46.2 相同（`sweetcornna/atlas`，源码归档 + `SHA256SUMS`）；基座 pin 仍为 v2.46.0（同 v2.46.2），本版不含上游同步。

## 为什么要发这一版

两项高危安全修复，都由 M1「生产级加密」渗透自查（K-11，[`pentest-m1.md`](pentest-m1.md)）与 P14 权限授权流设计评审在本地实测发现，已在仓库修复、待部署：

- **F-1**（CVSS 7.5）：控制台 TLS 前置对不带 `Content-Length` 的 chunked 请求先把整个请求体读进内存再校验体积。它在公网可达、在鉴权之前，任何人无需凭据即可把中枢机推向 OOM。
- **E-1~E-4**（CVSS 8.0~8.8）：常驻 ACP 会话里四条不经宿主审批的越权放行路径。在非 root 节点（现网 p1、p4）上，已鉴权的控制台使用者或能投递任务的对端可让节点以其 uid 在工作区外执行任意命令。

这两项在部署到内测舰队之前一直存在（舰队上跑的是修复前的产物）。修复本身先合进代码；按负责人决定，部署安排在 7 天长跑窗口（至 2026-10-03T18:20Z）之后随收口进行。

## 变化

安全修复：

- **F-1 控制台 TLS 前置未鉴权内存放大**：`readCappedBody()` 改用 reader 逐块累加，一超过 `MAX_BODY_BYTES`（1 MiB）就 `cancel()` 回 413，chunked 不再整个缓冲；`Bun.serve` 另传 `maxRequestBodySize`（只挡声明了长度的请求，Bun 1.3.13 管不到 chunked，注释写明）（`0a245e2d`）。裸 TLS 上传辅助函数等背压时不再攒监听器（`ad65e03e`）。
- **E-1~E-4 常驻会话越权放行**（`ef635efd`，配套 `bbd9668b` 抽模块、`d011dbe2` 与 `918fbb67` 回归用例）：
  - E-1 EnterPlanMode 进 plan+bypass：常驻工具面剔除 `EnterPlanMode`/`ExitPlanMode`/`Cron*`/`Team*`（含经 `ExecuteExtraTool`/`SearchExtraTools` 的间接入口）。
  - E-2 PreToolUse hook 回 allow、E-4 Skill allowed-tools：`checkPermissions` 天花板剥掉注入的 allow 规则后按工具本身判定，其余改写成 `safetyCheck` 型 ask。
  - E-3 子 agent 定义 permissionMode：`canUseTool` 天花板包住会话唯一的嵌套查询漏斗，子 agent 采纳的 bypass 在此被拒。
  - 进程层：ACP 子进程缺省安全模式（下详）。
- **hardline 新增的拒绝面**（`ef635efd`）：按词法拒 `*/qianmo/identity/*` 与 `*/qianmo/audit/*`（覆盖同机控制台 / 对端的 identity，不依赖 `stateRoots`）；拒配置根 / 身份目录下的 `agents/`、`skills/`、`plugins/`、`commands/`、`hooks/`；新增 `protectedRoots` 把记忆根整棵纳入。
- **K-1 生产 CA 运行手册**：新增 [`ca-runbook.md`](ca-runbook.md)，记生产 CA 建成、根证书指纹与托管边界、K-2 签发 / RL / 轮换 / 泄露处置（`a4ba5216`）；`key-distribution.md` 的 K-1 行改记已落地（`5429132f`、`53f17f1f`）。

已在 `main`、随本版一起发行的相关改动：

- **P16.0 记忆块结构注入修复**：记忆条目内容不再能改变注入块结构（`a25e0ec4`，PR #140）。
- **从当前版本移除成员个人信息**：移出四份含成员学号 / 电话 / 邮箱的申报文书，`docs/README.md` 与 `license-chain-m0.md` 里内联的个人信息改为可复核的指针；历史不动（`385a84a8`，PR #138）。
- **M1 三份设计定案 v1.0 与章程 v2.19**（仅文档，PR #139，合并提交 `3dd4fdbc`）：P14 权限授权流（`e23b8b9d`）、P15 租户 / 账号（`f596504f`）、P16 记忆（`0b653936`）三份设计升 v1.0；章程升 v2.19（`77468609`）；roadmap 升 v2.74、beta-env 升 v1.3（`8e99d879`）。

K-11 结论随本版由「高危 1 项（F-1）」升为「高危 5 项（F-1、E-1~E-4），均已在仓库修复、待部署」（`pentest-m1.md` v1.2、`key-distribution.md` v1.5）。

## 部署注意

本版是安全补丁，部署时机由负责人在 7 天窗口后决定。生效需要重启，逐项：

- **控制台 TLS 前置**（F-1）：`console-tls-front.ts` 是常驻进程，改动要**重启前置**才生效。
- **常驻节点**（E-1~E-4、hardline）：修复在节点产物里，要**换产物并重启常驻节点**才生效；只改文档不重启不生效。
- **安全模式默认开启**：ACP 子进程缺省 `CLAUDE_CODE_SAFE_MODE=1`（写死在 `residentAcpEnv.ts`，当前无关闭开关）。
  - 它**关掉**的是：用户级与项目级的 **hook、agents、skills、plugins、自定义命令**——即 E-2/E-3/E-4 的攻击面，也是唯一能挡住「预置 hook 命令本身被执行」的手段。
  - 它**没有关**的是：工作区 `CLAUDE.md`、provider（`settings.json` 的 env，含模型凭据）、`qianmo_notify`、记忆 sidecar（在宿主进程，不在子进程）。以上都经真 ACP 子进程实测不受影响，常驻功能不掉。

## 使用与验证

```sh
git clone --branch v2.46.3 https://github.com/sweetcornna/atlas.git
cd atlas
bun install --frozen-lockfile
bun run build:vite
bun run check:bundle
```

同 v2.46.2，用 `check:bundle`（含运行期冒烟，会实际走到 `-p` 的模块初始化）做产物验证，而不是 `--version`。

## 验证边界

- **安全修复只在本机验证过，未部署、未在舰队上复测**：F-1 的内存放大测量、E-1~E-4 的越权路径都是在本机临时部署（含真 ACP 子进程 + 本地假模型）上验证的，修复前红、修复后绿；7 天长跑窗口内不对舰队发探测。E-1~E-4 未用真模型（而非本地假模型）驱动一次投递做端到端复测。
- **仍为源码发行**。真实节点、真实 provider、沙箱（runsc/Dormice）与 Windows 的验收边界同 v2.46.2；平台或凭据相关的跳过测试不算作真实部署已验证。
- 全量 `bun run verify` 由发布前在干净 clone 上跑。
