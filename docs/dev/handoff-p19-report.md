<!-- Copyright 2026 Qianmo AgentNest Team -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# P19 接力插件化交付记录

日期：2026-10-11。工作树：`atlas-p19`；分支：`feat/p19-1011`；起点：`f8f022d79`。本轮只做本机开发与验证，没有 push、PR、部署或更新其他工作树。功能提交：`6bc1a9c3`（64 文件，3241 行新增、100 行删除）；以下实现与测试均属于该提交，本文单独以文档提交交付。最终检查结果见下表。

## 已实做并验证

| 范围 | 文件与行为 | 验证 |
|---|---|---|
| 配对、设备账本 | `node/src/commands/consoleHandoffDevices.ts`；`console/src/routes/handoffDevices.ts`。12 位 RFC4648 base32、10 分钟、一次性；qmd_ + 32 随机字节；完整 SHA-256；0600/fsync；错码与来源限流；账号吊销/降级即时失效；lastSeen 最多每分钟落盘一次 | `consoleHandoffDevices.test.ts` 4 通过；`console/test/handoffDevices.test.ts` 4 通过。测试覆盖过期、复用、错误首字符累计五次、11 次来源请求、哈希存储、重启吊销、不同属主撤销、viewer/账号降级拒绝 |
| 接力专用身份 | `console/src/access.ts`、`contracts.ts`、`http.ts`、`tenancy.ts`。新增 device 主体；只准 `/v0/handoff` 及其子路径；查询串 qmd_ 400；其他路由包括静态资产、登录入口一律 403；只有精确 pair 路径免登录 | 设备 API 测试与完整 console 测试；未登录的其他接力路由仍 401；qmd_ Bearer + qmu_ 查询串也保持原拒绝规则 |
| HTTPS Git | `consoleHandoffGit.ts`、`handoffHub.ts`、`routes/handoff.ts`。真实 stateless-rpc、流式响应、pkt-line/flush、gzip、Git-Protocol；每次访问比较/升级 hook；项目属主账本；设备引用约束 | `consoleHandoffGit.test.ts` 1 通过：真实 git push/fetch/ls-remote，自有引用成功、其他设备引用拒绝、无令牌/吊销后 401、其他账号项目 403；真实 gzip upload-pack 也通过 |
| 本机登录与免登记 | `handoffDevice.ts`、`handoffStore.ts`、`handoffNow.ts`、`handoffPull.ts`、`handoffSync.ts`。login/logout/whoami；0600 原子文件、所有者/软链检查；隐式建库；HTTPS 凭据仅经 GIT_CONFIG 环境，未写 argv 或 git config；显式 init 优先 | 真实进程集成 `qianmo-handoff-plugin.test.ts`：配对→login→自动 Codex hook 同步→now→accepted/ownerDevice→假节点 done→重新配对→查看旧任务→pull→whoami→logout。hook 后就断言了裸仓中的会话对象，避免 now 掩盖 hook 没生效 |
| 任务属主 | `consoleHandoff.ts`、`handoff/src/ledger.ts`。记 ownerDevice/ownerSubject；manifest.device 与凭据一致且项目属主匹配；list/get/send/attach/return 以账号隔离，其他账号统一 not_found；旧无属主任务只留给原人工入口 | `consoleHandoff.test.ts` 9 通过；新集成验证同账号重新配对后的任务可见/可接回；旧台账回放与派发测试通过 |
| 官方 Codex | `paths/src/index.ts`、`manifest.ts`、`handoff.ts`、`handoffTranscript.ts`、`handoffMcp.ts`、`handoffNode.ts`、`handoffAttach.ts`。CODEX_HOME 来源、auto hook/notify、rollout 解析、线程元数据 cwd、默认 codex app-server/resume；节点关闭插件/hooks/MCP/notify | 真 Codex 0.162 app-server：readyz 200、thread/start/thread/read cwd，未调用模型；已安装插件的基线 mcp list 有 qianmo，`--disable plugins` 后没有。`handoffCodex.test.ts` 1 通过；MCP 集成 12 通过 |
| 会话归属回归 | `handoffNow.ts`、`handoffNow.test.ts`；集成夹具 `handoff-processes.ts` | 继承其他仓库的 CODEX_THREAD_ID 不再抢走本仓库会话；校验 rollout 的 session_meta.cwd 属于当前仓库。`handoffNow.test.ts` 8 通过；集成夹具移除继承的 CODEX_HOME/THREAD_ID |
| 插件与嵌入安装 | 根 `.claude-plugin/marketplace.json`、`atlas/plugins/qianmo/` 全包；`handoffPlugin.ts`、`handoffPluginFiles.ts`。中文命令/skill、6 个 MCP 工具、dry-run、不重复写同内容、各工具确切 CLI | `handoffPlugin.test.ts` 4 通过。Codex/Claude 实际隔离安装及 MCP 成功；Bun 编译 qm 与编译产物嵌入安装成功。详见下方实测 |
| 运维脚本与门禁 | `demo/env/beta/handoff-node.sh` 及其测试；`check-identity-paths.ts` 及其测试；`docs/dev/console.md`、`handoff-usage.md` | 官方默认无需 qmcode 相邻 helper，CODEX_HOME 与隔离参数生效，模型 key 不进节点桥；脚本 19 通过；路径门禁测试 6 通过；路由文档完整测试通过 |

上述源码路径的包前缀均为 `atlas/packages/`，node 命令测试位于 `atlas/packages/node/test/commands/`。

### 最终检查

| 检查命令 | 最终结果 |
|---|---|
| `bun test atlas/packages/node/test/commands/handoff*.test.ts atlas/packages/node/test/commands/consoleHandoff*.test.ts atlas/packages/console/test atlas/packages/handoff` | 1334 通过、2 失败、72 文件；仅下述前端基线失败，无新增失败 |
| `bun test atlas/tests/integration/qianmo-handoff*.test.ts` | 39 通过、2 跳过、0 失败、6 文件；跳过的是既有需显式 opt-in 的真 qmcode 终端用例 |
| 每个本轮新增/修改 `.test.ts` 文件逐个 `bun test <文件>` | 15 文件合计 112 通过、2 跳过、0 失败；其中单文件插件流水线通过 |
| 最后 CLI 说明调整后的受影响检查 | handoffNow 与接回集成 15 通过、0 失败 |
| `GOMAXPROCS=2 bun run atlas:typecheck` | 退出 0、无类型错误（Bun 1.4.2） |
| `bunx biome check --write <54 个改动 TS/JSON>`，再同范围 `biome check` | 都退出 0；0 错误、1 条已有 shell 字符串 lint 警告，未放宽门禁 |
| `bun run atlas:lint` | 全仓只读检查退出 0；1079 文件，6 条既有警告、9 条提示 |
| `bun run atlas:check:identity-paths` | 518 个生产文件、0 绕过 |
| `bun run atlas:check:license-headers` | 1302 个自有文件缺头 0、基座误贴 0、豁免误贴 0 |
| `bun run build:native`、`bun run atlas:build:qm` | 都退出 0；真编译 qm 的 plugin install 退出 0、调用工具两次、标准清单保留且不被 Codex 激活、MCP transport=stdio |
| `bun run atlas:test`（precheck 的完整测试阶段） | 5637 通过、36 跳过、2 失败；34 分片中仅 console 分片因上述既有两条失败而退出 1。其余 33 分片通过 |

已有 console 前端 `actionWords.test.ts` 的两条基线失败单列，未修改前端来掩盖它们。

## 本机真实工具实测

所有安装都使用临时 HOME、CODEX_HOME、CLAUDE_CONFIG_DIR、QIANMO_CONFIG_DIR 与临时 PATH/qm 包装器；没有更改真实 `~/.claude`、`~/.codex`、`~/.omp`。Codex 0.162 要求指定的 CODEX_HOME 目录先存在；Claude Code 接受 CLAUDE_CONFIG_DIR，已实际把安装与状态写入临时目录。omp 安装命令用临时 HOME 的可执行桩核对参数，本轮未把真实 omp 注册到用户配置。

实际命令（`$TEMP` 是临时目录，网关密钥仅在环境中，未回显）：

```sh
CODEX_HOME=$TEMP/codex qm handoff plugin install --tool codex
# 执行 codex plugin marketplace add <生成的 marketplace 根>
# 与 codex plugin add qianmo@qianmo
CODEX_HOME=$TEMP/codex codex mcp list
CLAUDE_CONFIG_DIR=$TEMP/claude claude plugin validate atlas/plugins/qianmo
CLAUDE_CONFIG_DIR=$TEMP/claude claude plugin marketplace add <本仓库根>
CLAUDE_CONFIG_DIR=$TEMP/claude claude plugin install qianmo@qianmo
CLAUDE_CONFIG_DIR=$TEMP/claude claude mcp list
```

- Codex：安装退出 0；mcp list 列出 `qianmo qm handoff mcp enabled`。真实运行日志还确认 MCP initialize 协议版本 2025-06-18、服务版本 3.0.0-dev。
- Claude Code：validate 与安装退出 0；mcp list 为 `plugin:qianmo:qianmo: ✔ Connected`。命令/skill frontmatter 使用合法 YAML flow mapping，后两行放版权和 SPDX；实际两种工具解析成功，未放宽许可门禁。
- 真实 api2 gpt-6-luna：最初上游 429 model_cooldown/usage_limit_reached；冷却结束后 `codex --dangerously-bypass-hook-trust exec --skip-git-repo-check -m gpt-6-luna` 加临时 model_provider 的 Responses 配置，最小提示“只输出 OK，不要调用工具”，退出 0、输出 OK。provider 的 base_url 从 api2.env 派生到 /v1，env_key 指向临时密钥环境变量，supports_websockets=false；密钥不进 argv。
- 最终兼容安装的真实网关 TUI Stop 于 2026-10-11 09:55:40 UTC 写入 `sync.log` 的 `hook-seen/tool=codex`；真实 exec 的 SessionEnd 于 09:57:35 UTC 写入同类记录。Stop stdin 有 `session_id, turn_id, transcript_path, cwd, hook_event_name, model, permission_mode, stop_hook_active, last_assistant_message`；SessionEnd 有 `session_id, transcript_path, cwd, hook_event_name, reason`。路径脱敏的夹具：`support/fixtures/codex-0.162-stop.json` 与 `codex-0.162-session-end.json`。
- 最初也用本机 Responses 替身驱动真 Codex 验证 hooks。最终 Stop 有真实 api2 请求证据；本轮仍未把它等同于真实云端模型续跑。
- 正常使用在 Codex `/hooks` 检查并信任当前定义；修改后重新审阅。`--dangerously-bypass-hook-trust` 只用于隔离实测、不持久授信。参考 [官方 hooks](https://learn.chatgpt.com/docs/hooks)、[插件文档](https://developers.openai.com/plugins/build/plugins)。

## 已写未验证

- 真 Codex 对转交 rollout 的模型续跑、Claude Code externalAgentConfig/import 在官方 Codex 上的真实模型续接、真 Codex remote resume 终端接入：保留/实现对应代码与参数，协议路径由既有假 app-server、真实 Codex无模型 smoke、旧 qmcode 集成替身验证；本轮没有把新来源的真实云端 turn/resume 跑到完成。
- omp 真实插件注册、Claude Code 真模型触发 Stop：本轮分别验证 CLI 参数/包格式和真实安装/MCP 连接，未启动这两个工具的模型回合。omp 不执行 hooks，来源工具仍拒绝 omp。
- 两台真机之间的 SSH/接入/接回：本机回环与假节点通过，跨机未验证。

## 未做与自行裁定

1. **任意未知码无法归属某个签发码的“五错作废”**：pair API 只有完整 code，没有 pairingId。仅存完整 SHA-256 无法把任意随机错误字符串关联到正确码。实现用完整哈希查唯一单字符邻码（包括第一个字符）并累计五错；其他未知/多字符错误走来源 10 次/分钟限流。没有保存可离线破解的短前缀哈希，也不因随机错误吊销其他人的配对码。此处是任务字面要求的受限实现，不宣称任意五次猜测可作废某个特定码。
2. **Codex 0.162 的标准 Agent Plugins hooks 上游限制**：[该版本 loader.rs](https://github.com/openai/codex/blob/rust-v0.162.0/codex-rs/core-plugins/src/loader.rs#L953) 对 AgentPlugin 格式直接返回空 hooks。源码保留所要求的标准 plugin.json；`qm ... install --tool codex` 将它另存为 plugin.agent-plugins.json，以 .codex-plugin 清单加载 hooks。已有生成的标准清单可逆改名保留，用户修改过则拒绝覆盖。直接从仓库 marketplace 安装此版本只能启用 MCP，需要 qm 兼容安装才能有 hooks；不声称标准布局在该版本 hook 可用。
3. 配对 command 的对外地址：console 启动参数没有独立对外 URL；路由传请求 Origin，缺失时用请求 URL.origin。新 `issuePairing(actor, consoleUrl?)` 只扩展这个参数。login 持久保存用户输入地址，避免信任响应地址把未来 Bearer 发给另一主机。
4. 官方节点生命周期：保留现有“外部 app-server + 节点桥”默认；新增 opt-in `--start-app-server` 才由 qm 管理子进程。运维脚本本身默认启动官方 codex；显式 QIANMO_QMCODE_BIN 继续兼容 QMCODE_HOME。`--qmcode-home` 旧字段用于兼容既有节点配置。
5. 没有属主的旧 SSH 裸仓拒绝被配对设备认领；原有显式 init/SSH 通路保留。同一账号的同名目录映射一个项目；已有全局同名项目归其他账号时 403，不自动改名或抢属主。
6. 新设备属于签发账号，以最高 member 执行接力；GET devices 按既有 view 门槛，设备不能签发配对/撤销其他设备。同账号任务可以在其他设备/重新配对后接回，HTTPS 客户端不再按旧 deviceId 筛掉它们；旧 SSH 客户端保留原 project+device 筛选。
7. 设计中的添加设备页面属于主导者前端工作，本轮只交付 API，没有触碰 console/src/view 或 assets。没有其他设计 §2 功能被静默省略；未验证项如上所列。
8. 遵守“不全仓格式化”：最后检查按 precheck 同样阶段运行 typecheck、只读 atlas:lint、identity/license、完整 atlas:test；仅对本轮改动文件执行 biome --write。

## 端口与接口变更

| 文件 | 变更及理由 |
|---|---|
| `console/src/directionPorts.ts` | 新 HandoffDeviceIdentity、HandoffPairingResult；HandoffDevicesPort 增可选同步 authenticate(token)、异步 pair(input, remoteAddr)、issuePairing 可选 consoleUrl。可选成员保留旧前端/fake 适配器兼容；鉴权/公开门缺实现时关闭，不降级放行。说明只允许单次配对码/令牌签发响应返回秘密 |
| `console/src/deps.ts` | 新 HandoffRequestActor `{deviceId, owner}`；HandoffPort 的 accept/list/get/send/attach/markReturned 增可选 actor，未传时保留人工语义；新 HandoffGitPort 的 createProject/handle 与 ConsoleDeps.handoffGit，承载流式 Response、请求体与 Git 协议头 |
| `console/src/contracts.ts`、`index.ts` | 新 device 主体与新端口类型出口；主体 subject 取账号 owner，方便审计和租户规则 |
| `handoff/src/ledger.ts` | accepted 行可选 ownerDevice/ownerSubject 成对校验，任务视图保留到后续状态，version:1 旧记录兼容 |
| `handoffStore.ts`、`paths/src/index.ts` | HubLocation 新 https；集中导出 handoffPath/within；codexHome 尊重 CODEX_HOME，claudeProjectsDir 尊重 CLAUDE_CONFIG_DIR；identity-paths 登记 codex/qmcode，没有增加绕过 |

## 范围外问题

`atlas/packages/console/test/actionWords.test.ts` 的两条基线失败：CONSOLE_ACTIONS 有 72 个方向动作，而前端只渲染 50 个；files 等新动作前缀缺中文标签。在未修改的 HEAD `f8f022d79` 导出副本中重跑同文件，也为 0 通过/2 失败。它属于新方向前端集成，本任务禁止修改 view/assets，因此保留并报告；未删除测试或放宽预期。

## 功能提交文件清单

`git show --name-only 6bc1a9c3` 的完整文件列表：

```text
.claude-plugin/marketplace.json
atlas/packages/console/src/access.ts
atlas/packages/console/src/contracts.ts
atlas/packages/console/src/deps.ts
atlas/packages/console/src/directionPorts.ts
atlas/packages/console/src/http.ts
atlas/packages/console/src/index.ts
atlas/packages/console/src/routes/handoff.ts
atlas/packages/console/src/routes/handoffDevices.ts
atlas/packages/console/src/tenancy.ts
atlas/packages/console/test/handoffDevices.test.ts
atlas/packages/handoff/src/ledger.ts
atlas/packages/handoff/src/manifest.ts
atlas/packages/handoff/test/manifest.test.ts
atlas/packages/node/src/commands/console.ts
atlas/packages/node/src/commands/consoleHandoff.ts
atlas/packages/node/src/commands/consoleHandoffDevices.ts
atlas/packages/node/src/commands/consoleHandoffGit.ts
atlas/packages/node/src/commands/handoff.ts
atlas/packages/node/src/commands/handoffAttach.ts
atlas/packages/node/src/commands/handoffDevice.ts
atlas/packages/node/src/commands/handoffHub.ts
atlas/packages/node/src/commands/handoffMcp.ts
atlas/packages/node/src/commands/handoffNode.ts
atlas/packages/node/src/commands/handoffNow.ts
atlas/packages/node/src/commands/handoffPlugin.ts
atlas/packages/node/src/commands/handoffPluginFiles.ts
atlas/packages/node/src/commands/handoffPull.ts
atlas/packages/node/src/commands/handoffStore.ts
atlas/packages/node/src/commands/handoffSync.ts
atlas/packages/node/src/commands/handoffTranscript.ts
atlas/packages/node/test/commands/consoleHandoff.test.ts
atlas/packages/node/test/commands/consoleHandoffDevices.test.ts
atlas/packages/node/test/commands/consoleHandoffGit.test.ts
atlas/packages/node/test/commands/handoffAttach.test.ts
atlas/packages/node/test/commands/handoffCodex.test.ts
atlas/packages/node/test/commands/handoffNow.test.ts
atlas/packages/node/test/commands/handoffPlugin.test.ts
atlas/packages/node/test/commands/support/fixtures/codex-0.162-session-end.json
atlas/packages/node/test/commands/support/fixtures/codex-0.162-stop.json
atlas/packages/paths/src/index.ts
atlas/plugins/qianmo/.claude-plugin/plugin.json
atlas/plugins/qianmo/.codex-plugin/plugin.json
atlas/plugins/qianmo/.mcp.json
atlas/plugins/qianmo/README.md
atlas/plugins/qianmo/commands/handoff.md
atlas/plugins/qianmo/commands/login.md
atlas/plugins/qianmo/commands/pull.md
atlas/plugins/qianmo/commands/status.md
atlas/plugins/qianmo/hooks/hooks.json
atlas/plugins/qianmo/mcp.json
atlas/plugins/qianmo/plugin.json
atlas/plugins/qianmo/skills/qianmo-handoff/SKILL.md
atlas/scripts/__tests__/checkIdentityPaths.test.ts
atlas/scripts/check-identity-paths.ts
atlas/tests/integration/fixtures/handoff-processes.ts
atlas/tests/integration/qianmo-handoff-attach-qmcode.test.ts
atlas/tests/integration/qianmo-handoff-mcp.test.ts
atlas/tests/integration/qianmo-handoff-plugin.test.ts
atlas/tests/integration/qianmo-handoff-return.test.ts
demo/env/beta/handoff-node.sh
demo/env/beta/handoff-node.test.ts
docs/dev/console.md
docs/dev/handoff-usage.md
```
