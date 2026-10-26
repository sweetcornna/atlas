<!-- Copyright 2026 Qianmo AgentNest Team -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# Work 里的广泛性工作（P37.17 B 段）

| 项 | 内容 |
|---|---|
| 文档版本 | **v0.1（接口先行）**：只写「节点与接口」部分——会话种类与执行者、会话记录里文件卡与进度的形状、中枢接口的路径与答复、工作流的名字与触发。「界面」部分由 B-界面一路写在 §9 |
| 日期 | 2026-10-25 |
| 核对基点 | main `3247b9b2a`（#283、#282 之后）；A 段（bot 常驻会话）未合入，字段对齐见 §1.1 |
| 范围依据 | 负责人 2026-10-25 原话（§0）；主 agent 的 P37.17 B 段任务说明（`p37-17b-work.md`，定下的取舍照录在 §0）；Claude Desktop 3.6556.2 静态研究（REA，`claude-cowork-rea/report.md` §1.2、§2.3、§3、§4、§5） |
| 编号 | P37.17 B（A 段是 bot 常驻会话） |
| 依赖 | [`console.md`](./console.md) §5.1、§6（对话面、过程行、落盘）；[`directions-2026-10.md`](./directions-2026-10.md) §1（控制链路与上行调用）、§3.3（文件界限）；[`base-switch-omp.md`](./base-switch-omp.md) §4（常驻子进程、扩展、宿主工具） |
| 结论一句话 | 「开始一项工作」开的仍是一条中枢对话，只多一个 `work` 标记；智能体照常在节点上跑，用随节点下发的六个工作流技能和三件宿主工具把文件写进这条对话自己的产出目录，再把文件交给人；中枢经已有的控制链路列文件、分块取文件，浏览器从中枢下载与预览 |

由主 agent 按负责人 10-03 的常设委托定案，本文记本路的实现取舍。「未实测」「未评估」是证据状态，不是授权门槛。

---

## §0 依据

负责人 2026-10-25：「work这边可以选择直接与bot对话，也可以选择进行广泛性工作，广泛性工作是学习claude desktop，他们就是将chat与cowork统合起来进行广泛性工作，例如制作ppt等等，并且有专用的工作流，请你进行rea，然后进行开发」。

任务说明里定下的取舍（本文不改）：

1. 两种用法同一种会话：跟 bot 说走 A 段的常驻会话，开始一项工作开一条**工作会话**；工作会话也由一个智能体执行，缺省主智能体，可在「由谁来做」里换。保留用户可见的选择，不学 Claude 让模型自动判断（REA §1.4、§5）。
2. 新建即工作；新工作页一个大输入框、一排工作流卡片、`/` 弹工作流菜单、「由谁来做」。
3. 活动面板三块：进度（omp 待办工具，「第 x / y 步」，没有待办不显示）、产出（产出目录里的文件卡）、上下文（这轮用到的工作流与工具、引用的文件）；bot 常驻会话不出面板，但对话里出了文件照样有文件卡。
4. 专用工作流 = 自己写的技能（AGPL），随节点下发、经 omp 自己的技能机制加载；首批六个：演示文稿、文档、表格、调研报告、网页、数据分析。不参考、不改写 Claude 的 pptx/docx/xlsx/pdf 技能正文（专有许可，REA §3.3）。
5. 出文件不靠 LibreOffice：节点宿主工具用打包进 `qm` 的纯 JS 库（MIT / Apache-2.0 / BSD 一类）从结构化描述写 `.pptx`、`.docx`、`.xlsx`，同一份描述画一份自包含 HTML 预览；PDF 在节点有可用浏览器时从预览打印，没有就不提供并写明；中文要能显示。
6. 产出交付：每条工作会话在执行它的智能体工作区下有自己的目录；「交付文件」工具把文件交给人，对话里出文件卡；中枢经中枢→节点控制通道列出产出、取文件（路径只在这条会话的产出目录里、拒绝链接与 `..`、单文件 50 MiB）；浏览器下载走中枢；预览 HTML 放在不跑脚本的 sandbox iframe 里。桌面壳「下载并打开」本轮不做。
7. 批准沿用节点的权限模式与中枢审批（P39）。
8. 本轮不做：项目、定时任务界面、插件市场、Rewind / Fork、本机文件夹授权、模型自动判断、产物版本与分享。

---

## §1 会话种类与执行者

### 1.1 字段

工作会话就是中枢对话存储（`consoleChatStore.ts`）里的一条会话，多两个字段，写一次、之后不变：

```ts
// @qianmo/console 的 ChatSession，与节点包的 StoredChatSession 同名同义
interface ChatSession {
  // …既有字段（id、target、node、agent、createdAt、updatedAt、turnCount、preview、title、running、background）
  /** A 段：常驻会话。 */
  readonly resident?: true
  /** B 段：工作会话，经 POST /v0/work/sessions 开出。与 resident、background 互斥。 */
  readonly work?: true
  /** 开这条工作会话时选的工作流（§2）；没选时不出现。 */
  readonly workflow?: WorkflowId
}

/** ChatPort.open 与 ChatDispatch.open 的第二 / 第三个参数。 */
interface ChatOpenOptions {
  readonly resident?: true
  readonly work?: true
  readonly workflow?: WorkflowId // 只在 work 为真时接受
}
```

- **种类字段**：本路用 `work?: true`，与 A 段草稿的 `resident?: true` 同一种写法（会话记录上互斥的布尔标记，旧记录两样都没有 = 普通会话）。合流时若统一成一个字段，名字取 `kind`，取值 `'resident' | 'work'`，与这里一一对应，存储上旧行仍按「没有 = 普通会话」读。
- **执行者**就是会话的 `target`（`qianmo://<节点>/<智能体>`），不另设字段；「由谁来做」换的就是开会话时的 `agent`。会话开出后执行者不变。
- 列表与状态：`GET /v0/chat/sessions` 照旧返回全部可见会话，工作会话带 `work: true`（与 `workflow`）。「进行中」读既有的 `running`；「等你」与「完成」的判定由界面一路按 `running`、审批卡片与最后一行定（§9），本路不加字段。

### 1.2 开工作会话：`POST /v0/work/sessions`

请求体（JSON 对象，未列出的键答 400）：

| 键 | 类型 | 必填 | 含义 |
|---|---|---|---|
| `agent` | 地址 | 否 | 由谁来做；缺省为主智能体（§1.3） |
| `workflow` | `WorkflowId` | 否 | 卡片或 `/` 菜单选的工作流（§2.1） |
| `text` | 字符串 | 否 | 首条消息；给了就在开会话之后立即发出，规则同 `POST /v0/chat/sessions/<id>/messages`（长度上限、私钥拦截、本地命令不在这里认） |

答复：

- `200 { "session": ChatSession, "turn": ChatTurn | null }`：开出且（若给了 `text`）首条已交出；`turn` 是操作者那一行。
- 开出了但首条没发出：用首条失败对应的状态码，体为 `{ "error": { code, message }, "session": ChatSession }`，界面据此照样进入这条会话。
- 没开出：与 `POST /v0/chat/sessions` 同一套失败（`guardChat`、账本 503、配额、租户 404）。

记账：开会话记一行 `work.session.open`（target 为执行者地址），首条记 `chat.message.send`（target 为会话 id）。保护等级 `guarded`。

### 1.3 执行者的校验

- 不给 `agent`：主智能体，规则与前台一致——初始化配置页选的、否则 `--chat-default`，**且在名册里**；否则名册第一个可拨的；名册读不出来答 503。
- 给了 `agent`：必须是合法地址、出现在 `GET /v0/chat/targets` 里、`dialable` 为真，并通过对话面同一道授权（`ChatDispatch.authorize`：这个人能不能跟它说话、租户范围）。不在名册或看不见答 404 `not_found`；看得见但不可拨答 400 `rejected`（「这个智能体现在不能对话」）；地址不合法答 400 `invalid`。
- `workflow` 不在 §2.1 的表里答 400 `invalid`。

---

## §2 工作流

### 2.1 名字

| `WorkflowId` | 中文名 | 技能名（omp） | 首条消息带的命令 | 主要产出 |
|---|---|---|---|---|
| `slides` | 演示文稿 | `qmo-slides` | `/skill:qmo-slides` | `.pptx`（另可 `.pdf`） |
| `document` | 文档 | `qmo-document` | `/skill:qmo-document` | `.docx`（另可 `.pdf`） |
| `sheet` | 表格 | `qmo-sheet` | `/skill:qmo-sheet` | `.xlsx` |
| `research` | 调研报告 | `qmo-research` | `/skill:qmo-research` | `.docx`（含来源一节） |
| `webpage` | 网页 | `qmo-webpage` | `/skill:qmo-webpage` | 自包含 `.html` |
| `analysis` | 数据分析 | `qmo-analysis` | `/skill:qmo-analysis` | `.xlsx` 加 `.pptx` 或 `.docx` |

表的顺序就是卡片顺序。三种语言的名称与说明是界面文案，归界面一路（`frontText.ts`）。

### 2.2 触发

- **点名**：卡片与 `/` 菜单都把选中的 `WorkflowId` 放进请求的 `workflow` 字段——开会话时是 `POST /v0/work/sessions` 的 `workflow`，会话里再点一次是 `POST /v0/chat/sessions/<id>/messages` 的可选 `workflow`（本路给这个路由加这一个键）。中枢据此把发给节点的 prompt 写成 `/skill:<技能名> <原文>`，转录里操作者那一行仍是人打的原文，另带 `workflow`（§3.1）。节点上 omp 照自己的技能命令展开（`/skill:` 记号在常驻侧拼好的消息里不在行首，omp 的句中记号形式照样认，§5.2 有用例）。
- **自动匹配**：六个技能的 `description` 写清用途与中英文关键词，omp 把它们列进系统提示，模型按描述自己去读（`read skill://qmo-slides`）。人没选工作流也能用上。
- 本地命令（`/compact` 等）与工作流互斥：一句话认成本地命令时 `workflow` 答 400。

### 2.3 `GET /v0/work/workflows`

```json
{ "workflows": [ { "id": "slides", "skill": "qmo-slides", "outputs": ["pptx", "pdf"] }, … ] }
```

六项、固定顺序、与中枢版本一起变。保护等级 `guarded`，`guardChat` 之后即可读（不碰节点）。

### 2.4 技能怎么到节点、怎么加载

技能源文件在 `atlas/plugins/qmo-work/`（Agent Plugins 布局：`plugin.json` + `skills/<技能名>/SKILL.md` + 参考资料），随 `qm` 编进二进制；常驻宿主启动时把它们原样写到节点配置根下（`@qianmo/paths` 的 `workSkillsDir()`），每个 qianmopi 子进程启动时以 `--plugin-dir` 带上，并把这个目录列进扩展配置的 `readableRoots`（它在受保护的配置根下，不列就读不到）。运维在扩展页装的技能照旧走 P32 的 `plugins/qianmo/`，两者互不覆盖；重名时 omp 按自己的规则加命名空间。外部底层（Claude Code、Codex、ACP）本轮不带这六个技能（§7）。

---

## §3 会话记录里的形状

### 3.1 操作者那一行

```ts
interface ChatTurn {
  // …既有字段
  /** 这一句是带着工作流发的（§2.2）；只在操作者那一行上。 */
  readonly workflow?: WorkflowId
}
```

### 3.2 文件卡：交付文件的那一行

智能体调「交付文件」工具后，中枢在转录里加一行**过程行**（`variant: 'notice'`），来源是新值 `files`：

```ts
interface ChatTurn {
  // …既有字段
  readonly variant?: 'message' | 'notice'
  readonly noticeSource?: 'agent' | 'step' | 'task' | 'files'
  /** 只在 noticeSource 为 'files' 的行上：交给人的文件，按交付顺序。 */
  readonly files?: readonly WorkFileRef[]
}

/** 一个交付出来的文件。名字是它在这条会话产出目录里的相对路径。 */
interface WorkFileRef {
  readonly name: string // 产出目录里的相对路径，'/' 分隔，如 "季度汇报.pptx"、"图/趋势.png"
  readonly size: number // 字节
  readonly kind: WorkFileKind
  readonly mime: string
  readonly sha256: string // 交付那一刻的内容摘要
  readonly preview: boolean // 有没有预览（§4.4）
  readonly title?: string // 智能体给的显示名，可缺
}

type WorkFileKind =
  | 'presentation' // .pptx
  | 'document' // .docx
  | 'spreadsheet' // .xlsx .csv .tsv
  | 'pdf'
  | 'webpage' // .html
  | 'image' // .png .jpg .jpeg .gif .webp .svg
  | 'text' // .md .txt
  | 'data' // .json
  | 'other'
```

- 这一行 `author: 'agent'`、`state: 'done'`、`severity: 'info'`、`taskId` 为交付时那一轮的任务号，`text` 是给旧页面看的一句（「交付了 2 个文件：季度汇报.pptx、季度汇报.pdf」）。它不算一轮、不结束「还在跑」（与工具步骤同一条判据，`console.md` §6.4.2）。
- 任何会话都可能有它（bot 常驻会话里出了文件也是这一行）；活动面板只在工作会话里出。
- 下载与预览的地址由界面按 §4 拼：会话 id + `name`。同名文件再交付一次是新的一行，`sha256` 不同；面板里按 `name` 取最后一次。
- 一条会话最多 200 行文件卡（跨重启有效），一次交付最多 20 个文件。

### 3.3 进度与上下文：转录上的 `activity`

进度与上下文是**会话状态**，不是消息，不进 `turns`，挂在转录上：

```ts
interface ChatTranscript {
  readonly session: ChatSession
  readonly turns: readonly ChatTurn[]
  /** 节点报来的进度与上下文（§5.5）；从没报过时不出现。 */
  readonly activity?: WorkActivity
}

interface WorkActivity {
  /** omp 待办工具的当前清单；null 或 total 为 0 时进度块不显示。 */
  readonly progress: WorkProgress | null
  /** 最近一轮用到的工作流、工具与文件；还没有时为 null。 */
  readonly context: WorkContext | null
}

interface WorkProgress {
  readonly taskId: string // 最后改动清单的那一轮
  readonly at: number // epoch 毫秒
  readonly total: number // 条目数，不含已放弃的
  readonly done: number // 已完成
  readonly step: number // 「第 step / total 步」：done 加上正在做的那一条，不超过 total
  readonly current: string | null // 正在做的那一条
  readonly items: readonly WorkProgressItem[] // 按清单顺序
}

interface WorkProgressItem {
  readonly phase: string // omp 的阶段名
  readonly content: string
  readonly status: 'pending' | 'in_progress' | 'completed' | 'abandoned' | 'blocked'
}

interface WorkContext {
  readonly taskId: string // 这一轮
  readonly at: number
  readonly workflows: readonly WorkflowId[] // 会话的 workflow、这一轮操作者那一行的 workflow、读过的技能里属于 §2.1 的
  readonly skills: readonly string[] // 这一轮读过或点名的技能名（含不是工作流的）
  readonly tools: readonly { readonly name: string; readonly count: number }[] // 这一轮调过的工具与次数
  readonly files: readonly string[] // 这一轮工具参数里点名的文件（工作区相对路径），最多 50 个
}
```

- **进度跨轮保留**：omp 的待办清单是会话状态，某一轮没碰它时中枢保留上一份；清单被清空（全部移除）时 `progress` 变 `null`。
- **上下文按轮**：新一轮第一次报上来时整份替换。
- 每次更新都照常发一个 `ChatUpdate { sessionId, revision }`（SSE 事件不带内容，`console.md` §6.6），页面回头取片段或 §4.5。

### 3.4 落盘

都在同一个 `chat.ndjson` 里（`console.md` §6.5）：会话行多 `work`、`workflow` 两个键；轮次行多 `workflow`、`files`；新增第三种记录 `{ "kind": "activity", "activity": { "sessionId": …, "progress": …, "context": … } }`，重放时每条会话取最后一行。旧版本控制台读到这些：`work`、`workflow`、`files` 被忽略，文件卡行退化成一条过程行，`activity` 行整行跳过——都不会让转录读不出来。

---

## §4 中枢接口

### 4.1 总表

| 方法与路径 | 保护等级 | 答复 |
|---|---|---|
| `GET /v0/work/workflows` | `guarded` | §2.3 |
| `POST /v0/work/sessions` | `guarded` | §1.2 |
| `GET /v0/work/sessions/<会话 id>/activity` | `guarded` | §4.5 |
| `GET /v0/work/sessions/<会话 id>/outputs` | `guarded` | 列产出，§4.2 |
| `GET /v0/work/sessions/<会话 id>/file?name=<相对路径>` | `stream` | 下载，§4.3 |
| `GET /v0/work/sessions/<会话 id>/preview?name=<相对路径>` | `stream` | 预览，§4.4 |

`<会话 id>` 可以是任何种类的会话（bot 常驻会话里交付的文件也从这里取）。`name` 走查询串、不进路径段，文件名里的 `/`、空格与中文都不用再转义成路径。

### 4.2 列产出

```ts
interface WorkOutput {
  readonly name: string // 产出目录里的相对路径
  readonly size: number
  readonly kind: WorkFileKind
  readonly mime: string
  readonly mtime: number // epoch 毫秒
  readonly preview: boolean
  readonly tooLarge?: true // 大于 50 MiB
}
```

```json
{ "files": [ { "name": "季度汇报.pptx", "size": 81234, "kind": "presentation",
               "mime": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
               "mtime": 1761370000000, "preview": true } ],
  "truncated": false }
```

- 现场向执行这条会话的节点要（控制操作 `work.list`，§5.4），列这条会话产出目录里的普通文件（含子目录，深度 4 以内），按 `mtime` 倒序，最多 200 个（`truncated` 为真表示还有）。大于 50 MiB 的文件也列出，带 `"tooLarge": true`，不能下载与预览。符号链接、硬链接、特殊文件不列。
- 产出目录还不存在（这条会话没写过文件）答 `{ "files": [], "truncated": false }`。
- 节点连不上答 503 `unreachable`；节点版本太旧（不认 `work.list`）答 501 `unsupported`。界面这时可退回 §4.5 的 `delivered`。

### 4.3 下载

- 成功：`200`，正文是文件原样字节。头：`content-type` 为 §3.2 的 `mime`（认不出的一律 `application/octet-stream`）、`content-length`、`content-disposition: attachment; filename="<ASCII 退化名>"; filename*=UTF-8''<百分号编码>`、`cache-control: no-store`、`x-content-type-options: nosniff`、`cross-origin-resource-policy: same-origin`、`content-security-policy: default-src 'none'; sandbox`、`referrer-policy: no-referrer`。
- 中枢不落盘：从节点按块取（每块原始字节 160 KiB、base64 后在 256 KiB 信封内），边取边写给浏览器。每个节点的取块速度限在每分钟 150 块（控制链路出站预算 300 的一半，`directions-2026-10.md` §1.1），约 400 KiB/s；50 MiB 的文件约两分钟。界面靠 `content-length` 画进度。
- 中途文件被改（节点按设备号、inode、大小、修改时间核对每一块）或节点断开：响应体在中途报错断开，浏览器得到一个不完整的下载；不会把两个版本拼在一起。

### 4.4 预览

- 成功：`200`，`content-type: text/html; charset=utf-8`，一份自包含 HTML（内联样式，图片用 `data:`，**没有脚本**）。头：
  - `content-security-policy: default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; script-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'; sandbox`
  - `x-frame-options: SAMEORIGIN`、`cross-origin-resource-policy: same-origin`、`cache-control: no-store`、`x-content-type-options: nosniff`、`referrer-policy: no-referrer`、`content-disposition: inline`
- 哪些有预览（`preview: true`）：工具生成的 `.pptx`、`.docx`、`.xlsx`（用生成时同一份描述画的 HTML；文件之后被别的途径改过、与生成时不符时不再提供）；`.html`（文件本身，脚本被上面的 CSP 与 iframe 的 `sandbox` 挡住）；图片（包在一页 HTML 里，单张 8 MiB 以内）；`.md`、`.txt`、`.csv`、`.tsv`、`.json`（转义后放进 `<pre>` 或表格，2 MiB 以内）。`.pdf` 与其他类型没有预览，答 404 `not_found`（「这个文件没有预览」）。
- 页面怎么放：`<iframe sandbox src="/v0/work/sessions/<id>/preview?name=…">`（`sandbox` 不带任何 `allow-*`）。页面自己的 CSP 现在是 `default-src 'none'`，没有 `frame-src`，iframe 会被页面挡掉——界面一路要在放预览框的文档上加 `frame-src 'self'`；或者用 `fetch`（带控制台头）取回文本放进 `<iframe sandbox srcdoc>`，那样不用改页面 CSP。两种都行，由界面一路定。

### 4.5 活动

```json
{ "work": true, "workflow": "slides",
  "progress": WorkProgress | null,
  "context": WorkContext | null,
  "delivered": [ WorkFileRef, … ] }
```

只读中枢自己的记录，不碰节点：`progress`、`context` 即转录的 `activity`（§3.3），`delivered` 是这条会话所有文件卡里的文件、按 `name` 取最后一次、按交付时间倒序。读它与读转录同等：要过 §4.6 的同一道门，并按 `console.md` §6.1 的读取窗口记一次 `chat.transcript.open`。

### 4.6 鉴权：只有能读这条会话的人能取

每条 `/v0/work/sessions/<id>/…` 依次过：

1. `guardChat(access, 等级)`：与对话面同一道角色门（成员、运维或管理令牌；只读账号 403）。
2. `chatScopeOf(access, accounts).visible(id)`：成员只看得见自己开的会话；看不见的与不存在的答同一个 404。
3. 租户范围（`tenantScope.ts`）：会话的节点与地址在这个人的租户里，否则同一个 404。
4. 节点与智能体**取自会话记录**，请求里不接受节点名、智能体名或路径前缀；节点一侧只认这条会话的产出目录（§5.1）。
5. 下载与预览各记一行只读事件 `work.output.read`（target 为 `<会话 id> <name>`），账本停用答 503 且不碰节点；列产出与活动跟读转录一样走读取窗口。

`file` 与 `preview` 用 `stream` 等级而不是 `guarded`：它们由 `<a href download>` 与 `<iframe src>` 打开，带不了控制台头，与 `EventSource` 同一种情形（`console.md` §5.1）。cookie 单独够，**除非 `Sec-Fetch-Site` 说调用者来自别的源**；`SameSite=Strict`、`frame-ancestors 'self'` 与 `cross-origin-resource-policy: same-origin` 让别的源既读不到内容、也框不住预览。它们只读、不改任何状态。`console.md` §5.1「`/v0/chat/stream` 是唯一一条非文档却接受纯 cookie 的路由」那句随之改成三条。

### 4.7 错误

| 状态 | `code` | 什么时候 |
|---|---|---|
| 400 | `invalid` | `name` 不是合法相对路径（空段、`.`、`..`、`\`、`:`、控制字符、段尾点或空格、超过 2048 字节）；未知键；未知工作流 |
| 400 | `rejected` | 执行者不可拨 |
| 403 | `forbidden` | 角色不够；cookie 跨源 |
| 404 | `not_found` | 会话看不见或不存在；文件不存在、是链接或特殊文件；这个文件没有预览 |
| 413 | `limit` | 文件大于 50 MiB |
| 501 | `unsupported` | 中枢没接控制链路或聊天面（`deps.work` 缺）；节点不认 `work.*` |
| 503 | `unreachable` | 节点控制链路未连接；动作账本停用 |

---

## §5 节点一侧

### 5.1 工作目录

每条会话在**执行它的智能体的工作区**（`--agent <名>=<目录>`）下有自己的目录，路径由 `@qianmo/paths` 派生（`workSessionDir`）：

```
<工作区>/qmo-work/<会话 id>/
  outputs/    交付物；列产出、下载只认这里
  previews/   生成文档时同时写的预览 HTML 与校验记录（不是交付物）
  sources/    生成用的结构化描述 JSON，改稿时智能体读它再生成
```

- 会话 id 就是中枢的会话 id（`contextId`，`console.md` §6.4.1）；只接受 `[A-Za-z0-9][A-Za-z0-9_-]{0,127}`，不合格的对话里这三件工具答「这条对话不能存放文件」。
- 所有读写都经 `filesSafeFs.ts` 的目录句柄逐段 `openat`、`O_NOFOLLOW`：拒绝符号链接、硬链接（`nlink ≠ 1`）、特殊文件、`..` 与大小写或 Unicode 等价的重名；新建目录 0700、文件 0600。
- 目录在工作区里，所以智能体能用 `read` 看自己的产出与描述；开了 `--allow-workspace-edits` 或高权限模式时它也能直接往 `outputs/` 写（例如 Markdown），再交付。

### 5.2 宿主工具（节点内部，不是界面接口）

三件，所有底层共用宿主工具通道（`hostToolDispatch.ts`），只在有控制台或渠道对话的轮次里可用：

| 工具 | 做什么 |
|---|---|
| `qianmo_make_document` | 从结构化描述生成 `slides` → `.pptx`、`document` → `.docx`、`sheet` → `.xlsx`，同时写预览 HTML 与描述 JSON；`pdf: true` 时再从预览打 `.pdf`（节点上没有可用浏览器时如实说没有） |
| `qianmo_write_output` | 往产出目录写一个文本文件（`.md` `.txt` `.csv` `.tsv` `.json` `.html` `.svg`，5 MiB 以内），网页工作流用它 |
| `qianmo_deliver_files` | 把产出目录里的文件交给人：节点核对、算摘要，经上行调用 `work.deliver` 让中枢在转录里加文件卡（§3.2） |

工具参数的形状与上限写在节点代码（`host/workTools.ts`）与技能的参考资料里，可以随实现改，不影响界面。

### 5.3 文档怎么生成

- `.pptx`：pptxgenjs；`.docx`：docx；`.xlsx`：write-excel-file。三者都是 MIT 许可的纯 JS 库，随 `qm` 编进二进制，只在第一次生成时加载。字体：pptx 的拉丁、东亚、复杂文种三种字形都写「Microsoft YaHei」，docx 的东亚字体写「Microsoft YaHei」、拉丁写 Calibri，xlsx 写「Microsoft YaHei」；打开文件的电脑没有这个字体时由 Office 换成本机的中文字体。
- 预览 HTML 由本路自己的代码从同一份描述画出（不经格式转换）：幻灯片按 16:9 一页一张，图表画成内联 SVG；文档按版式排；表格每张工作表一节。字体栈 `-apple-system, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", "Source Han Sans SC", "WenQuanYi Micro Hei", sans-serif`；跟随 `prefers-color-scheme` 明暗。
- PDF：找节点上的 Chrome / Chromium（macOS 的 Google Chrome、`google-chrome`、`chromium`、`chromium-browser`），以无头模式、一次性的用户目录把预览 HTML 打印成 PDF，60 秒超时；找不到或失败就不生成，工具结果写明原因。Linux 上 Chrome 自带沙箱起不来时（无特权用户命名空间被禁）退一次 `--no-sandbox`——打印的只是本路自己生成、带 `script-src 'none'` 的静态 HTML。服务器上没装中文字体时 PDF 里的中文会缺字，这是部署要检查的一项。

### 5.4 控制操作与上行调用

中枢→节点（`node.control`，前缀 `work`，急停时也放行，都是只读）：

| 操作 | 参数 | 答复 |
|---|---|---|
| `work.list` | `{ agent, session }` | `{ files: WorkOutput[], truncated }`，即 §4.2 的答复原样 |
| `work.read` | `{ agent, session, name, view: 'file' \| 'preview', offset, etag? }` | `{ name, size, mime, etag, offset, data, eof }`，`data` 为 base64；`etag` 由第一块给出，之后每块带上，对不上答 `changed` |

节点→中枢（`hub.call`，前缀 `work`）：

| 操作 | 参数 | 中枢做什么 |
|---|---|---|
| `work.deliver` | `{ contextId, taskId, files: WorkFileRef[] }` | 核对会话的 `target` 正是发起调用的节点与智能体、`taskId` 是这条会话里还没结束的一轮，然后加文件卡（§3.2） |
| `work.activity` | `{ contextId, taskId, todo?, context }` | 同样核对（`taskId` 是这条会话里的一轮即可，不要求还没结束），更新 `activity`（§3.3） |

### 5.5 进度从哪来

omp 的待办工具 `todo` 本来就在常驻工具面里（`RESIDENT_SESSION_TOOLS`）。常驻轮次端口（`@qianmo/resident` 的 `OmpResidentTurnPort`）把每个工具的开始与结束交给宿主；宿主按轮汇总：`todo` 成功结束时取它结果里的清单（`details.phases`），其余工具记名字与次数、`read skill://<名>` 记技能、参数里的路径记文件。清单变了就报（同一轮两秒内合并成一次），这一轮结束时把上下文再报一次；中途报不出去（中枢没连上）只丢这一份，不重试、不影响这一轮。外部底层的轮次没有这些事件，它们的会话只有文件卡、没有进度与上下文。

### 5.6 界限

| 项 | 规矩 |
|---|---|
| 单文件 | 50 MiB（生成、写入、交付、下载、预览一律） |
| 一次交付 | 20 个文件；一条会话 200 行文件卡 |
| 列产出 | 200 个、深度 4 |
| 描述 | 演示文稿 60 页、文档 400 块、表格 10 张工作表 × 5000 行 × 50 列；描述 JSON 2 MiB |
| 急停 | 三件工具拒绝；`work.list`、`work.read` 放行（只读） |
| 审计 | 节点为生成、写入、交付各记一行（`work.document`、`work.write`、`work.deliver`，只记会话、文件名、大小、摘要）；控制操作照既有规矩各记一行 |

---

## §6 放弃的备选

| 备选 | 为什么不用 |
|---|---|
| 节点装 LibreOffice，用 soffice 生成与转 PDF（Claude 的做法，REA §4.2） | 节点沙箱没有外网、p3 没有 root，装不了系统包；体积数百 MB；任务说明已定不用 |
| 自己手写 OOXML（zip + XML） | 少三个依赖，但 PowerPoint、Word 对细节很挑，自己写的格式在真 Office 里出问题的风险高；任务说明定的是用纯 JS 库 |
| xlsx 用 exceljs 或 SheetJS | exceljs 拖九个依赖（archiver、unzipper 等）、体积大；npm 上的 SheetJS 停在 0.18.5，带已公开的读取漏洞。write-excel-file 只依赖 fflate，够写数据、格式、冻结行与公式 |
| 文件卡用协议里新的消息类型，或塞进 `task.result` | 改协议要所有旧对端一起认（协议 N-1）；交付发生在一轮中间，`task.result` 要等一轮结束。上行调用 `hub.call` 已有、已签名、已按调用方认节点 |
| 进度与上下文写成过程行（`notice`）塞进 `turns` | 它是会话状态，每次都要整份替换；放进 `turns` 要动轮数、预览、「还在跑」三处判据，旧页面还会把它当一句话画出来 |
| 产出放在节点配置根下（智能体读不到） | 智能体要能读自己的产出与描述才能改稿；工作区本来就是它干活的地方，`files.ts` 也只认工作区 |
| 预览由中枢渲染 | 中枢没有原文件也不该有；节点生成时手上就有描述，画预览最准 |
| 下载经 GitHub 交换仓库（P20 的做法） | 那是节点到节点、要运维配仓库；这里是给浏览器一个文件，控制链路已有、文件小 |
| 下载与预览只用 `guarded`（页面 `fetch` 后转 blob） | 也能做，但 50 MiB 要在浏览器内存里攒一份，桌面壳的 blob 下载另要处理；`stream` 等级已有、论证一致 |

---

## §7 本轮不做

任务说明 §0 第 8 条那些；另外：外部底层（Claude Code、Codex、ACP）加载这六个技能与报进度；文档里的图表（演示文稿有原生图表，文档里图表退成数据表加图注）；公式的计算值（预览显示公式原文，读取器可能看不到结果）；预览之外的在线编辑。

---

## §8 验收与状态（节点与接口）

（实现完成后回写：用例、本机中枢 + 节点 + 假模型走一遍的记录、门禁、未实测项。）

---

## §9 界面

由 B-界面一路写（`feat/p37-17-work`）。实现在 `view/frontWork.ts`（文案、卡片、文件卡、预览框、活动面板、样式）与 `assets/frontWork.ts`（预览与产出列表的页面脚本），接进 `view/front.ts`、`assets/frontClient.ts`、`routes/front.ts`；`work.ts` 是节点一路同名文件的原样拷贝（`7a96c7b95`），合并时不冲突。浏览器 `/` 与桌面 `/app` 是同一套渲染（`layout` 开关），下面不分开写的地方两处一样。依据是任务说明定下的取舍（§0）与 REA §1.5（侧栏与行状态）、§2.3（活动面板）、§2.5（中途插话）、§3.2（怎么挑工作流）、§4.2（文件卡与预览）。

### 9.1 侧栏：两种用法各在一处

- 智能体一区（A 段）每个智能体一行，点它进读者跟它的常驻会话。下面按日期分组的列表（今天 · 昨天 · 过去 7 天 · 更早）放**读者自己的工作会话**：`work: true`、账本属主是读者（`chatResident.ts` 的 `workSessions()`；账本不可用时一条也没有，与常驻会话同一规则）。
- 工作会话不算进它那个智能体的行：不进 ⋯ 其他对话的计数，也不让那一行显示「执行中」；其他对话对话框也不列读者自己的工作会话。别人的工作会话（运维看成员的）照旧在其他对话里，只读。
- 搜索上面一行「开始一项工作」，指向新工作页。⌘N（桌面壳）、⌘⇧O（浏览器，浏览器自己占着 ⌘N）同样打开它；桌面壳菜单「文件 → 开始一项工作」、托盘同名一项与 `qmo://new` 都开 `/app?work=new`（`hub.rs` 的 `new_work_url()`）。
- 列表一行：工作流图标（没有工作流时是通用图标）、标题、状态记号、未读点、⋯（在另一张脸打开、复制地址）。行的悬停提示是「标题 · 执行者」。未读、标签页标题与桌面角标的计数、窗口不在前面时的系统通知，都沿用 `/app` 原来按会话的那套。

### 9.2 三种状态

| 状态 | 判据 | 记号 |
|---|---|---|
| 进行中 | `session.running`（全站「还在跑」同一判据，`chatTurns.ts`） | 呼吸的点 |
| 等你 | 这条会话里有等这个人决定的批准请求：前台审批卡片已有的 `GET /v0/approvals?mine=1` 轮询（5 秒）按 `contextId` 给行标 `data-asking`，侧栏重画后立刻再标一次 | 琥珀色实心点；压过进行中 |
| 完成 | 两样都不是 | 淡色对勾 |

§1.1 提到的「最后一行」没有用：列表手上只有会话记录，按行读转录要逐条过读取门、记账（`console.md` §6.1），代价与收益不相称。三个记号都画在行里，由 `data-state` 与 `data-asking` 决定显示哪一个，轮询切换状态时不写文字；读屏读到的是记号的 `aria-label`（三种语言）。

### 9.3 新工作页

- 地址 `/?work=new`、`/app?work=new`；片段 `GET /fragments/chat/front/view?work=new[&agent=<地址>]`。画它不读转录、不记读取。
- 标题「开始一项工作」，下面一排六张卡片（§2.1 的顺序：图标、名字、产出格式），大输入框紧接其下（欢迎页的版式）。宽窗口一排六张；窗口不到 1100 px，或不到 1400 px 而侧栏与会话面板都开着时，三列两排；窄屏两列，只有图标与名字。
- 点卡片 = 选这个工作流：输入框上方出一枚工作流标签（图标 + 名字 + ×），卡片 `aria-pressed`；再点一次或点 × 取消。输入框里打 `/` 弹出的菜单先列六个工作流（`/slides` 或本语言名字都能匹配），选中同样是这枚标签、打的字清掉；新工作页上不列本地命令（还没有会话），已开的会话里工作流在前、本地命令在后。
- 输入框下「由谁来做」：`/app` 原有的智能体选择器，新工作页上两张脸都画；缺省主智能体，菜单标题换成「由谁来做」。在新工作页上选人只换执行者，不离开这一页。
- 第一句：`POST /v0/work/sessions { text, workflow?, agent? }`（`agent` 只在换了人时带），开会话与首条一个请求，不会留下空会话。成功后地址换成 `?session=<id>`、列表里出现这一行；答 `{ error, session }`（开了但首条没送出）时照样进入这条会话，文字放回输入框，状态行说原因；没开出来时留在新工作页，文字与工作流标签放回原处。页面运行时 `sendJson` 的失败对象因此带上答复体（`err.data`）。
- 已开的会话里再选工作流：`POST /v0/chat/sessions/<id>/messages` 带 `workflow`；一句话认成本地命令（`/compact` 等）时不带（§2.2 的互斥）。发出后标签清掉，一次管一句。

### 9.4 工作会话

- 头部两张脸都是标题 + 执行者小牌（点开是智能体的信息卡）；新工作页与工作会话里，侧栏不把执行者那一行标成当前，当前的是「开始一项工作」或列表里这一行。
- 读者自己的工作会话可以接着写；别人的只读，底下一行回到那个智能体。地址 `?session=<id>`。
- 操作者那一行带 `workflow` 时，气泡上方一枚小标签。
- 文件卡：`noticeSource: 'files'` 的行不折进步骤组，单独画成一组卡片——种类图标、名字（有 `title` 用 `title`，`name` 放在悬停提示里）、种类 · 大小（二进制单位，同 `formatBytes`）、预览（`preview` 为真才有）、下载；`tooLarge` 的只写「超过 50 MiB」。bot 常驻会话里交付的文件同样画。

### 9.5 活动面板

- 不另开第二个右侧栏：会话面板（后台任务、云端电脑）顶上加 `#fx-activity`，只在工作会话里有内容，bot 常驻会话里没有。宽窗口（≥ 1101 px）打开工作会话时面板自己打开，除非读者在这个浏览器里关过；离开工作会话时，自己打开的那次再自己收起，读者手动开着的不动。
- `#fx-activity` 是视图片段的第三个挂载点，跟转录一起渲染、一起按 id 换：转录本来带 `activity`，SSE 的 ChatUpdate 已经会触发重取，所以不另起轮询，也不多一次读取。
- **进度**：`activity.progress`，标题旁「第 x / y 步」，条目带状态记号（待做空心圈、进行中呼吸点、已完成对勾、受阻警示、已放弃划线），阶段多于一个时按阶段分段；`null` 或 `total` 为 0 不画这一块。
- **产出**：先画转录里交付过的文件（与 §4.5 的 `delivered` 同一算法 `deliveredFiles`）。面板开着时页面再取 `GET …/outputs`，取到就换成产出目录的实际列表（按答复的顺序，mtime 倒序），交付过的那行原样保留（连同智能体给的名字）；有新交付、或工作还在跑时每 15 秒，再取一次；取不到（501、503，或本分支上路由还不存在的 404）就保持交付列表、15 秒内不再问。页面新加的行从文档里的 `<template id="fx-file-tpl">` 克隆，文字一律 `textContent`。都没有时一行「还没有产出」。
- **上下文**：会话的 `workflow` 加 `context.workflows`、不是工作流的技能（`qmo-*` 不重复列）、工具（名字 × 次数）、引用的文件；全空不画这一块。

### 9.6 预览框与下载

- 预览：文档里一个 `<dialog id="fx-preview">`：文件名、下载、关闭，下面一块空的容器。点「预览」时页面脚本才建 `<iframe sandbox="" referrerpolicy="no-referrer">`、设 `src` 为 §4.4 的地址；关闭时把它拿掉。`sandbox` 不带任何 `allow-*`：不跑脚本、不同源、不能提交表单或弹窗。文档本身不含 iframe，页面仍然「不主动加载任何东西」（`pages.test.ts` 的规矩）。宽屏是一张大卡片，窄屏占满。
- 页面 CSP 加 `frame-src 'self'`（`respond.ts` 的 `cspFor`，每个文档同一条）。没有它 iframe 会被 `default-src 'none'` 挡掉；同源的文档都带 `frame-ancestors 'none'` 与 `x-frame-options: DENY`，能被框进来的只有带 `frame-ancestors 'self'` 的预览路由。没有选 `srcdoc`：那要把取回来的 HTML 当字符串放进页面，页面脚本不做这种事。
- 下载：`<a href="…/file?name=…" download="<文件名>">`，浏览器直接从中枢取（`stream` 等级，cookie 够）。桌面壳「下载并打开」本轮不做。

### 9.7 文案

只有标签与状态，三种语言写在 `frontWork.ts` 自己的表里（工作流名、文件种类、三块标题、「第 x / y 步」、三种状态、开始一项工作、由谁来做、预览、下载、关闭、还没有产出、超过 50 MiB）；页面脚本只要新工作页的占位一词，经 `frontClientText` 带过去。键盘帮助里原来的「主智能体」一项改成「开始一项工作」。

### 9.8 验收与状态（界面）

- **单元**（`test/frontWork.test.ts`，11 条）：工作会话在按日期列表、带工作流与状态，不进智能体那一行与其他对话；两张脸的侧栏都有「开始一项工作」且在搜索上方；新工作页六张卡片的顺序、「由谁来做」、不读转录；三种语言；片段；`/` 菜单工作流在本地命令前；文件卡在常驻会话与工作会话里都画、面板只在工作会话里；进度、产出、上下文三块的出现条件；文档里没有 iframe、CSP 带 `frame-src 'self'`；操作者那一行的工作流标签；属主可写、别人只读。A 段的 `front.test.ts` 随 B 的版式改了四处期望。
- **浏览器**（`test/browser/frontWork.browser.test.ts`，6 条，真 Chrome）：卡片与 `/` 菜单设标签、首句一个请求开出工作会话且不带主智能体、行进列表且是「进行中」、面板自己打开、已开会话里第二句带 `workflow`、本地命令不带、⌘⇧O 回新工作页；换执行者不离开新工作页、首条没送出照样进会话且文字回到输入框；产出换成目录列表（含交付外的文件与超限文件）、进度随报告出现、预览框是空 `sandbox`、预览自己不带 CSP 时脚本也没跑（同一文件放进 `allow-scripts` 的对照框里会跑）、下载是附件；列不出产出时保持交付列表；等你随审批出现与消失；手机宽度卡片两列、面板不自开、预览占满。另外 `contrast.browser.test.ts` 加了新工作页、工作会话（文件卡与活动面板）、`/` 菜单、带标签的输入框与预览框，明暗两套；`narrow.browser.test.ts` 加了两张脸的新工作页；`front.browser.test.ts` 的 ⌘⇧O 改为到新工作页；`copyGate.test.ts` 加了两张脸的新工作页与 `WORK_TEXT` 三种语言的全部字串。
- **桌面壳**：`cargo test` 106 条过（`hub.rs` 的 `new_work_url()` 两种中枢地址），`cargo clippy --all-targets -D warnings`、`cargo fmt --check` 退出 0。
- **截图**：`~/atlas-evidence/2026-10-26/p37-17-b/`（新工作页两张脸、工作会话、进行中、预览框，明暗；手机宽度；英文与日文）。
- **未实测**：节点一路的真实 `/v0/work/*` 与消息路由的 `workflow` 字段（本分支用 `test/workFake.ts` 按 §1.2、§4 的形状做假路由）；桌面壳菜单、托盘与 `qmo://new` 的改动只过了 `cargo test` 与 clippy，没在真窗口里按过 ⌘N；真 omp 报出的进度与上下文。
