<!-- Copyright 2026 Qianmo AgentNest Team -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# P26a GitHub 接力交付报告

日期：2026-10-11。工作目录 `/Users/cornna/project/atlas-p26`，分支 `feat/p26a-1011`，起点 `57291d599`。功能提交：a6ff4d3db。仅本机实现与验证，没有 push、PR、部署、真实 GitHub 连接或基座修改；未修改控制台 view/assets，也未实现 P26b 连接页和文件交换。

## 已实做并验证

| 范围 | 文件及最终行为 | 验证 |
|---|---|---|
| 仓库连接端口、生产 CLI | `node/src/commands/handoffRepoCredentials.ts` 定义 `resolve(repo)`；`handoffRepoCli.ts` 实现重复 `--handoff-repo owner/name=tokenFile`，地址固定 github.com，读取沿用 readTokenFile 的属主/权限/非软链校验；`consoleArgs.ts`、`console.ts` 接线，新模式不要求 node-git | 仓库名/HTTPS 与 SSH origin/重复与非法 CLI 值/软链和可读权限拒绝；生产 qm 子进程启动回 GitHub config，git 路由 404，状态目录无仓库 |
| 代码坐标与台账 | `handoff/src/code.ts`、`manifest.ts`、`ledger.ts`；accepted 行保存 code，result 保存结果 ref/commit，cleaned 为独立持久记录；版本保持 1，原记录回放兼容；任务归属来自认证设备/账号 | 旧 ledger/manifest 完整测试；伪造设备引用、短 hash、与 tip 不符、无仓库连接、另一真实账号设备的读取/登记/return 拒绝 |
| 本机转交与 MCP | `handoffGithub.ts`、`handoffConfig.ts`、`handoffDevice.ts`、`handoffNow.ts`、`handoffSync.ts`、`handoffSyncTypes.ts`、`handoff.ts`、`handoffMcp.ts`；从 origin 取仓库名，匿名可见性检查 fail closed；只推允许的会话前缀，原子推 task-scoped 分支后登记；MCP 输出缺会话的原因 | 私有/公开/未知三条真实 git 往返；生产 probe 的 200 public、404、429、无字段、网络异常均通过且不发 Authorization；失败 probe 使用非空真实会话夹具证明拒推；MCP code-only 转交结果与 task view 都写原因 |
| 派发与节点续跑 | `consoleHandoff.ts`、`consoleHandoffDispatch.ts`、`handoffGithubGit.ts`、`handoffNode.ts`；中枢只 ls-remote；每次发送重新 resolve 令牌；仅 wss 或 loopback ws 下发；节点 depth=1 按 ref 浅取并核对 commit/tree，无 session 开新线程；结果 push 后回执确认删除工作目录，失败亦删除；没有节点裸仓 | 真 git + loopback transport + 假 app-server 做真实 commit；非 loopback ws 和撤销连接未发送 payload；结果 tip 不符失败；重启后重发存档结果只跑一轮；E_BUSY 重试的实际 payload 使用轮换后的令牌 |
| 接回与清理 | `handoffPull.ts`、`handoffClean.ts`；验证 origin 仓库与 ledger result tip，再复用原快进/return 分支算法；成功后删除现存三个远端引用并记 returned，重跑可复用本地已接回结果；clean 只操作本设备当前 origin 中已完成的失败/returned 任务；中枢 janitor 默认 7 天并逐项审计 | 接回确实得到 cloud.txt；篡改结果 tip 拒绝且不改本机文件；不同仓库拒绝；三类分支均删除；另一个设备的失败分支保留；超过保留期删、期内留、cleaned 与 hashes 回放保持 |
| API 与使用说明 | `console/src/routes/handoff.ts` 新 GET config、POST task/clean；GitHub 模式 git/projects 路由 404；`docs/dev/console.md` 路由表与参数、`handoff-usage.md` 新“GitHub 代码仓库模式（默认）”、token 最小范围/可见性/分支/清理/旧部署说明 | 完整 console 包及 routeDocs 通过；具体测试结果见下表 |

表中的 `node/console/handoff` 路径前缀都是 `atlas/packages/`。功能均在 a6ff4d3db。

### 验证命令与结果

所有 Bun 命令使用 1.4.2，所有测试带 `--preload ./atlas/tests/preload.ts`。

| 命令 | 结果 |
|---|---|
| `bun run atlas:typecheck` | 通过，0 类型错误 |
| `bunx biome check --write <本次变更的 TS 文件>`，再 `bunx biome check <同样文件>` | 29 文件，0 错误；只格式化本次文件 |
| `bun test ... ./atlas/packages/node/test/commands/handoffGithub.test.ts` | 11 通过、0 失败 |
| `bun test ... ./atlas/packages/node/test/commands/handoffPull.test.ts` | 8 通过、0 失败 |
| `bun test ... ./atlas/tests/integration/qianmo-handoff-github.test.ts` | 4 通过、0 失败（含实际生产 CLI 启动） |
| `bun test ... ./atlas/tests/integration/qianmo-handoff-mcp.test.ts` | 12 通过、0 失败 |
| `bun test ... ./atlas/tests/integration/qianmo-handoff.test.ts` | 15 通过、0 失败 |
| `bun test ... ./atlas/packages/node/test/commands/handoff*.test.ts ./atlas/packages/node/test/commands/consoleHandoff*.test.ts ./atlas/packages/handoff` | 264 通过、0 失败；后续只作类型模块拆分及加强测试，完整 Atlas 分片亦覆盖这些文件 |
| `bun test ... ./atlas/packages/console` | 1150 通过、0 失败 |
| `bun test ... ./atlas/tests/integration/qianmo-handoff*.test.ts` | 43 通过、2 跳过、0 失败（45 项，含生产 CLI 启动） |
| `bun run atlas:check:license-headers` | 通过；自有缺头/基座误贴/豁免被盖章均 0 |
| `bun run atlas:check:identity-paths` | 通过，567 生产文件、0 bypass |
| `bun run atlas:check:cycles` | 通过，runtime 0 / total 0；没有提高预算 |
| `bun run atlas:lint:ci` | 通过；基线有 6 warnings / 9 infos，没有格式化全仓 |
| `bun run atlas:test` | 5962 通过、37 跳过、1 基线失败；34 个分片只有 node 分片因头像 HTTP 测试失败 |
| `bun run atlas:check:unused` | 基线失败：前端 10 exports / 5 types；原始 HEAD 独立导出、offline install 后同命令输出与当前逐字相同，没有修改前端或提高预算 |
| `git diff --check` | 通过 |

未直接运行会全仓写格式的 precheck；按照用户“不要全仓格式化”的优先指令，分别运行其阶段：typecheck、只改本次文件的 biome --write/check、全仓只读 lint、identity/license 与完整 atlas:test。未 push，未运行仅 push/PR 前要求的完整 verify。

### “中枢零代码”与令牌证据

`qianmo-handoff-github.test.ts` 用递归 `files(hubRoot)` 收集全部条目，断言 basename 为 objects 或后缀 .pack 的条目集合严格等于 `[]`；生产 CLI 用例还断言真实 QIANMO_CONFIG_DIR 中不存在 objects、.pack 或 .git。节点用真实 git 证明 `--is-shallow-repository=true`，并断言 work/<taskId> 和 node repos 目录都不存在。

同一往返用例把可执行 git wrapper 放到 PATH 首位，逐个记录 git argv；断言明文 token 和 `base64(x-access-token:token)` 均不出现在 argv 日志。另扫描节点 state、app-server 会话/home、hub 台账/审计的全部文件、节点与中枢日志、git config、API result 消息，同样逐项断言两种令牌形式都不存在。令牌没有设置到宿主环境或 app-server 环境，只经 git 子进程 GIT_CONFIG_COUNT/KEY/VALUE；清空继承的 GIT_CONFIG_PARAMETERS/askpass，关闭 credential.helper、git tracing 与重定向。重复派发凭据重新解析，node 持久请求只存无 credential 的 manifest，delivery ledger 只存结果。

新模式中枢启动示例（令牌和 PSK 在文件/环境里，不写值）：

```sh
qm console --handoff-repo owner/name=/绝对路径/github.token \
  --handoff-node cloud=wss://node.example:38630 \
  --chat-from qianmo://console/chat
```

节点 `cloud` 的中枢侧 PSK 变量是 `QIANMO_TRANSPORT_PSK_NODE_636C6F7564`；节点按原接法信任 console 的签名身份。新模式不传 `--handoff-root` 或 `--handoff-node-git`。本机 push/pull 始终使用 origin 和用户自己的本地 git 凭据。

## 已写未验证

真实 GitHub、真实细粒度 token 的权限/可见性、跨机 wss 和真实模型续跑没有验证；本轮按任务书明确禁止连接真实 GitHub，所有 git 远端均为本机 bare 仓库，app-server 为夹具。两条既有 qmcode 交互终端 opt-in 用例仍跳过，不宣称已实测。

## 未做

P26a 要求的实现与本机验证没有未做项。任务书排除的 P26b repo-kind 连接、连接页面、文件交换、控制台 view/assets、基座修改、真实 GitHub 操作均未做。没有 push、PR、合并或部署。

## 端口变更与自行裁定

- `directionPorts.ts`：未改。
- `deps.ts`：HandoffTaskView 增可选 code（repo/wip/sessions/sessionsReason/result/cleaned）；HandoffPort 增可选只读 codeStore 与 markCleaned，以兼容现有 fake/旧宿主；页面不需改动。
- 模式发现选择 GET `/v0/handoff/config`；它在已有设备允许的 `/v0/handoff/*` 边界内，不扩大设备权限。旧 HTTPS 中枢无此路由时 404/501 回退 hub，显式 SSH 原接法保持离线。
- GitHub 分支含任务号，因此本机先生成安全唯一任务号，中枢从校验过的 wip ref 取相同号；台账 fsync 后才答 accepted，设备/账号从凭据绑定。
- 既有 manifest 的 sessionId/ref/commit 保留字符串形状；没有 session 时用 `no-session` 与 wip hash 占位兼容，新的 code.sessions=null 才是是否有会话的依据，节点不会把占位提交当会话导入。
- 显式 sync 在新模式和 now 一样登记任务；自动 hook 只留下本机已完整前缀，防止每个回合制造无台账归属的 GitHub 分支。旧 hub/SSH 的后台同步保持原行为。
- expired 沿用既有 deadline → failed 状态，不新增台账状态；清理保留期按失败记录的 updatedAt 算。GitHub 结果只有代码结果分支，不回传云端会话分支；public/unknown 及无完整会话均新建线程。
- git push 删除引用仍要求 repository context：janitor 在 hub 状态目录之外创建一次性空**非裸仓**，不 fetch 任何对象，用完删除；hub 状态目录和节点均无持久裸仓。
- 接回重复执行时，已应用到 HEAD 或 return 分支的相同结果可复用，本机成功后先删远端 refs 再记 returned；origin 仓库名和 result tip 仍在首次接回前核对。
- 更新三个旧精确文案断言以符合 P19 已存在的 Codex/工具无关文案：handoffPull.test.ts、qianmo-handoff-mcp.test.ts、qianmo-handoff.test.ts；没有改旧路径输出或放宽断言。

## 范围外基线问题

原始 HEAD 的临时隔离副本 `/tmp/p26-unused-baseline-1011`（复核后删除） 通过 `git archive HEAD` 导出，Bun 1.4.2 `bun install --offline --ignore-scripts` 安装本地依赖，没有更改别的 worktree。

1. unused 门禁：10 个未使用前端导出、5 个类型。当前与基线日志逐字一致（cmp 退出 0）。全部文件都未改，不提高棘轮预算。
2. `node/test/commands/consoleAvatars.test.ts:534`：头像 HTTP 保存期待 200、实际 404；当前单文件 13 通过/1 失败，基线同样 13 通过/1 失败；完整 atlas:test 的 node 分片也报告这一项。它属于主导者头像路由/前端，未修改。
