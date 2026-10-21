<!-- Copyright 2026 Qianmo AgentNest Team -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# 阡陌 AgentNest — 智能体改设置（P40）

| 项 | 内容 |
|---|---|
| 文档版本 | v1.2（2026-10-21）：按合入前审查补四处：`im.save` 改平台、连接设置或凭据也只能本人操作；`updates.save` 只许收紧；`bound` 加 `currentSha256`；目标里的 `.` / `..` 拒绝（§2、§3、§4.2）。v1.1：三块实现合入 `feat/agent-settings`，§2 只能本人操作的清单按实现回写（25 项、两项只许收紧） |
| 范围依据 | 负责人 10-21：「agent 应当可以更改一切设置，设置面板只是用来给人操作的而已，当 agent 要配置模型服务，更改设置等等极高危操作的时候，需要人的确认，具体参照 claudecode 和 claudedesktop，并保证原生化适配底层」 |
| 状态 | 已实现（目录 99 项、20 个区域，智能体可申请 74 项），分支 `feat/agent-settings`，未合入 main、未部署、未在真机上跑过 |
| 相关 | [`authorization-m1.md`](./authorization-m1.md)（P14 单次审批）、[`elevation.md`](./elevation.md)（P39）、[`console.md`](./console.md) §5 路由表、`atlas/packages/node/src/host/connectorTools.ts`（同一种「先批后做」的先例） |
| 一句话 | 控制台的每项配置都登记在一张设置目录里，面板和智能体用的是同一套操作；智能体能读全部设置，改任何一项都要一个人在对话里的确认卡片上点批准，批准只管这一次、绑定确切参数，中枢在动手前再核一遍 |

## 1. 参照

| | Claude Desktop | Claude Code | 本设计 |
|---|---|---|---|
| 读设置 | `get_settings`：每项的当前值、可选值、一行说明、锁定原因；不用批准 | 模型读 settings 文件 | `qianmo_settings_list`：同 Desktop，密钥只显示是否已设与末四位 |
| 改设置 | `set_setting`：一次改一项；人在卡片上看到「当前值 → 新值」后批准 | 改 `.claude/` 下的设置是受保护路径，宽松模式下也要确认；auto 模式的分类器拦「改自己的权限或监督」 | `qianmo_settings_change`：一次一项；卡片写明区域、设置项、当前值 → 新值；每次单独批准，没有「以后都允许」 |
| 不交给模型的 | 安全与信任类设置（权限模式、沙箱、浏览器工具、可信站点）只告诉用户去哪里改 | bypass 下仍拦的几类；`/config` 能关不能开需要确认的开关 | 审批本身、账号与邀请、打开高权限模式、计费、渠道配对、SSH 凭据：目录里有，标「只能本人操作」，告诉智能体去哪个页面 |
| 拒绝的回传 | 卡片拒绝 | 「No, and tell Claude what to do differently」，理由回给模型 | 拒绝写回工具结果；智能体照常继续这一轮 |

## 2. 设置目录

`atlas/packages/console/src/settingsCatalog.ts`，一项一行，面板和智能体共用：

```ts
interface SettingOperation {
  readonly id: string            // 'providers.default'，区域.动作，稳定、可读
  readonly area: SettingArea     // 'providers' | 'routing' | 'magpie' | 'agents' | 'setup' | 'im' | 'schedules' | 'notify' | 'extensions' | 'connectors' | 'desktop' | 'elevation' | 'nodes' | 'servers' | 'updates' | 'alerts' | 'accounts' | 'approvals' | 'billing' | 'files'
  readonly label: string         // 面板上的叫法：「默认模型服务」
  readonly description: string   // 一行，说它改什么
  readonly kind: 'set' | 'create' | 'update' | 'remove' | 'run'
  readonly role: 'ops' | 'member'   // 执行时需要的个人账号角色，与该 /v0 写接口的 guard 一致
  readonly human?: string        // 有值即「只能本人操作」：值是去哪里改，比如「在 /admin/access 由运维本人发邀请」
  readonly target?: JsonSchema   // 定位对象的参数（profileId、node、agent、id…），没有就省略
  readonly input?: JsonSchema    // 改成什么；与对应 /v0 接口的请求体一致
  readonly secrets?: readonly string[]  // input 里的密钥字段路径，例如 ['secrets.*', 'key']
  readonly request: (target, input) => { method: 'POST' | 'PUT' | 'DELETE'; path: string; body?: unknown }
  readonly current?: (ctx, target) => Promise<unknown>  // 改之前的值（脱敏），用于卡片和 list；create 没有
  readonly page: string          // 面板位置，例如 '/admin/providers#routing'
}
```

- **执行就是调那个 `/v0` 接口**：校验、角色、租户、动作账本都走原路由，目录不复制一份业务逻辑。中枢在进程内用一个只对内的入口执行（§5.3），网络上没有新接口。
- **覆盖范围**：凡是面板上能写的配置都登记，第一版按 [`console.md`](./console.md) §5 的写接口逐条过一遍；只读接口不登记（`qianmo_settings_list` 读当前值时用对应的 GET）。
- **只能本人操作**（`human`，共 25 项，以目录为准）：
  - 替人批准：`approvals.*`（决定、撤销、继续、换审批凭据）、`files.decide`（文件互通的访问申请）。
  - 账号与凭据：`accounts.*`（邀请、重置、吊销、下线）、`connectors.device.pair` / `connectors.device.revoke`（接力设备）、`servers.replicate.inspect` / `servers.replicate.start`（SSH 密码或私钥）。
  - 给智能体加权限：`elevation.set`（升到 `off` 以外的档位）、`im.pairing`、`im.create`、`im.login`（扫码登录的人成为渠道主人）。
  - 花钱：`billing.*`。
- **只许收紧的三项**：`desktop.set`（云端电脑）、`im.save`（渠道）与 `updates.save`（更新设定）在 preview 与 apply 时都拿新值与当前值比，凡是放宽一律按只能本人操作拒绝，收紧照常走确认。放宽指：
  - 云端电脑：确认档改成「无需确认」、开终端、加应用；
  - 渠道：改主人、放行名单、配对档位或对话的智能体，以及改平台、平台连接设置（个人 QQ 的 SnowLuma 地址就在这里）或任何一项凭据，因为新连接那头可以冒充主人；
  - 更新：换一个取发行的仓库，或把某个来源从只通知改成自动处理。改回只通知、`repo: null` 不查是收紧。
- **降权**：`elevation.off`、`elevation.revoke`、`elevation.revoke-all` 照常走确认后执行。
- **要确认但不拦**：`extensions.*`、`agents.extension.install`、连接器的 `agents`（把连接借给哪些智能体）也会扩大智能体能做的事，但它们正是负责人要求智能体能改的配置，按每次确认处理，卡片写明装什么、借给谁。理由与 Desktop 一致：智能体不能替人批准、不能拿到能冒充人的凭据、不能花钱、不能自己给自己放权。
- **测试锁**：一条测试把目录与 `console.md` §5 的写接口对账，新增写接口没登记（也没写进豁免表）就红。

## 3. 两个工具

两个工具都是宿主工具（`HostToolDefinition`），走现有的单一派发（`hostToolDispatch.ts`），所以每种底层都用它自己原生的工具通道拿到它们：qianmopi 经 RPC `set_host_tools`，Claude Code、Codex、dsh、opencode 及其他 ACP 底层经 `qianmo` MCP 桥。

### 3.1 `qianmo_settings_list`

参数 `{ area?: string, id?: string }`。无参数返回区域列表和每项的 id、名称、说明、kind、role、是否只能本人操作；带 `area` 或 `id` 时再带上 target / input 的 JSON Schema 和当前值。密钥一律只回 `{ set: true, last4 }`。不需要批准，也不写账本（读）。

### 3.2 `qianmo_settings_change`

参数 `{ id: string, target?: object, input?: object }`，一次一项。处理顺序（节点侧 handler）：

1. 调中枢 `settings.preview`，拿回 `bound`（§4.2）。中枢在这一步拒绝：未知 id、只能本人操作（回去哪里改）、参数不合 schema（只认 schema 自己的字段，`toString`、`__proto__` 这类继承来的名字也算不认识）、目标里有 `.` 或 `..` 路径段（URL 会把 `keys/..` 折回上一级，落到别的路由上）、值没变、会话属主没有该角色、这个对话不是一个正在进行的人发起的回合。
2. 用 P14 申请单次批准：`toolName = 'qianmo_settings_change'`，`input = bound`。卡片按 `bound.card` 画（§6）。
3. 批准后调中枢 `settings.apply`，带真实参数（含密钥）和 `approvalId`、`contextId`。中枢重算 `bound`，与批准时逐字节相同才消费批准、执行（§5）。
4. 结果：
   - 成功：一句摘要和脱敏后的结果。
   - 拒绝：「用户拒绝了这次更改」，没有执行。
   - 等待超时：「已提交审批，编号 …；批准后用『批准并继续』接着做，别换参数重发」。
   - 执行失败：原接口的错误文字。结果未知时说明「结果未知，不要自动重试」。

## 4. 节点侧

### 4.1 审批语义

- `qianmo_settings_change` 进 `oneShotOnlyTool`（不允许批准窗口），**不进** `freshApprovalTool`。这样「批准并继续」派来的新回合里，同参数的同一次调用能用上那条已批准的单次授权，不会再弹一张卡。
- 授权命中已有单次授权时，handler 要拿到那条授权的 `requestId`（今天 `#approveConnector` 只在新建请求时拿到），供 `settings.apply` 带上。
- 节点没接审批（没有 `--approver`）、回合不是签名的人发起的回合（`trust !== 'verified-capability'`）、子会话（任务 worker）或值守作业的回合：工具直接回「这里不能改设置」并说明原因。
- 各底层的原生权限面对 `qianmo_*` 一律放行（Claude Code `pool.ts` 的权限提示工具、Codex `default_tools_approval_mode: 'approve'`、opencode `qianmo_*: allow`、dsh 的门、qianmopi 覆盖层）。确认在 handler 里走 P14，所以同一次更改**只弹一张卡**，不会底层问一次、阡陌再问一次。

### 4.2 `bound`：批准绑定的内容

```ts
interface SettingsBound {
  readonly id: string
  readonly target: Record<string, unknown> | null
  readonly input: unknown          // 密钥字段换成 { $secret: '…abcd', sha256: '<hex>' }
  readonly currentSha256: string | null  // 改之前的完整值（键序无关）的 sha256；没有读值的项为 null
  readonly card: {
    readonly area: string          // 区域名：「模型」
    readonly label: string         // 设置项：「默认模型服务」
    readonly title: string         // 一句话：「把默认模型服务改成 Claude 网关」
    readonly current: string | null  // 改之前（脱敏、截断到 200 字）；create 为 null
    readonly next: string          // 改之后（同上）
    readonly role: 'ops' | 'member'
    readonly page: string
  }
}
```

摘要 `digest = authzDigest(node, agent, contextId, 'qianmo_settings_change', bound)`。改之前的值进摘要，所以批准之后有人先改了这一项，apply 时重算出来的值不同，批准作废，要重新申请（与连接器的 revision 同一个道理）。卡片上的 `current` 是截断过的、列表只写条数，别人改了列表里的一项或长字段的后半段，卡片看不出来，所以另有 `currentSha256` 绑定完整值。

## 5. 中枢侧

### 5.1 hub.call 前缀 `settings`

新处理器 `atlas/packages/node/src/commands/consoleSettings.ts`，在 `console.ts` 里与 `tasks`、`connector`、`peers`、`files` 一起注册：

| op | 参数 | 回 |
|---|---|---|
| `settings.list` | `{ area?, id? }` | §3.1 |
| `settings.preview` | `{ id, target?, input? }` | `{ bound }` 或拒绝原因 |
| `settings.apply` | `{ id, target?, input?, approvalId, contextId }` | `{ summary, result }` 或拒绝原因 |

调用方身份照 `ConsoleTasks.#caller`：`contextId` 对应的对话必须正好指向 `qianmo://<node>/<agent>`，且有一个还在进行的人发起的回合；worker、值守作业、非前台会话一律拒绝。

### 5.2 消费批准

`ConsoleApprovals.consumeSettings(...)`，照 `consumeConnector`：

- 状态是已批准、单次、未消费、未撤销、未过期；`iss`、`sub`、`contextId`、`toolName` 对得上；摘要等于用重算出的 `bound` 算出来的摘要。
- 批准人此刻仍是有效账号，且**角色不低于 `bound.card.role`**。
- 先落一行 `settings-consumed`，再执行。
- `decide` 时也按 `bound.card.role` 拦：成员不能批准需要运维的更改，卡片上直接写「需要运维批准」，不给成员按钮。

### 5.3 执行

`createConsoleHandler` 增加一个只在进程内可用的入口（不挂到任何网络路径）：

```ts
handler.as(principal: ConsolePrincipal, request: Request, via: { agent: string; approval: string }): Promise<Response>
```

- `principal` 是**批准人**的账号（`credential: 'approval-session'`，`authenticatedAt` = 批准时间）：这次更改是这个人点头的，账本记在这个人名下。
- 请求走完整的 `routeAs`：同样的 guard、租户收窄、`admit`、`record`。
- 账本行多两个字段 `agent`（智能体地址）和 `approval`（requestId）；`ActionLedger` 的字段白名单与校验、`qm audit` 的读取跟着加。账号与访问页的操作记录里显示「经 ops（qianmo://hub/ops）· 审批 …」。

## 6. 前台

- **对话里的确认卡片**：当前对话有挂起的审批时，卡片出现在消息流末尾（像 Claude Desktop 的权限提示），不再是一个跟对话无关的弹窗。
- 设置更改的卡片写：「ops 想更改设置」，区域 · 设置项，「现在：… → 改为：…」，需要的角色，「在面板里看」链接；按钮「批准」「拒绝」。成员看到需要运维批准的更改时只显示说明。
- 其他工具（邮件、日历、云端电脑、高权限命令、记忆）的卡片按原来的信息排版，放进同一个位置。
- 别的对话里挂起的审批：侧栏「审批」的计数和一条横幅，点进去到那个对话。
- 审批页（`/admin/approvals`）同样按 `bound.card` 画设置更改，不显示原始 JSON 里的密钥摘要以外的东西。

## 7. 不做

- 不给智能体任何能批准、能发凭据、能升权限、能花钱的路径（§2「只能本人操作」）。
- 不做「以后都允许这类更改」：设置每次都确认。以后要做，按 Claude Code 的规则形式加，另立任务。
- 不新增网络接口；不让智能体拿到人的凭据。
- 不改基座。

## 8. 验证

- 目录与写接口对账测试（§2）。
- 中枢：preview 的每类拒绝；apply 的摘要不符、重复消费、批准后当前值变化、批准人角色不够、账号已吊销；账本行带 `agent` 与 `approval`。
- 节点：两个工具在 qianmopi 与外部底层的工具表里都在；没接审批时的回答；继续回合用上原批准、不再弹卡；拒绝与超时的回答。
- 前台浏览器测试：对话里出现卡片、显示当前值与新值、批准后卡片消失、拒绝后智能体收到拒绝；成员看到需要运维批准的卡片没有按钮。
- 真机：未做。合入后在部署面上跑一遍「智能体改默认模型服务 → 卡片 → 批准 → 生效 → 账本」再写进 roadmap。

## 9. 实现分块

| 块 | 范围 | 文件 |
|---|---|---|
| H 中枢 | 设置目录、`settings.*` 处理器、`consumeSettings` 与 decide 的角色拦截、`handler.as`、账本字段 | `atlas/packages/console/src/settingsCatalog.ts`、`http.ts`、`actionLedger.ts`、`deps.ts`（ConsoleAction）、`atlas/packages/node/src/commands/consoleSettings.ts`、`consoleApprovals.ts`、`console.ts` |
| N 节点 | 两个宿主工具、审批语义（§4.1）、命中授权时拿 requestId | `atlas/packages/node/src/host/settingsTools.ts`、`resident.ts`、`residentAuthorization.ts`、`atlas/packages/resident/src/grant-store.ts` |
| F 前台 | 对话内卡片、设置更改的排版、审批页排版、横幅 | `atlas/packages/console/src/view/frontApproval.ts`、`view/front.ts`、`assets/front*.ts`、`view/approvals*.ts`、`routes/approvals.ts`（只读部分） |
