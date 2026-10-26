<!-- Copyright 2026 Qianmo AgentNest Team -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# 阡陌桌面版 v2：即时响应、本机开发与多设备同步（P37.13–P37.16）

| 项 | 内容 |
|---|---|
| 文档版本 | **v1.6.1（生效）**：§8 回写 P37.14a 合入（#283）与 10-25 部署。v1.6：P37.14a 合流后回写——§4.5.1 写明字数按 UTF-16 码元计（壳、运行器、页面同一种算法）、对话框插件为什么套一层去掉它的页面脚本，三方的参数约定落成共用的用例数据；§4.5.2 `runner` 事件只由壳发；§8 P37.14a 的状态；§9 P37.14a 的用例与未实测项；v1.5：§4.3–§4.5 改成可实现的设计——本机节点改由随包的 `qmo` 里的本机运行器实现、不带 `qm`（§4.3.1 有量到的数与备选），三种协议的驱动抽成本机与常驻共用的 `@qianmo/harness`，会话记录与前台的会话同形，四档权限逐个 agent 落到原生设置，页面经壳的命令与有序通道直达运行器，转录由 Code 页用 DOM 自己画；原 P37.16「本机直连」并入 P37.14，§8 拆成 P37.14a–d，P37.16 改为离线打开 Code；§2、§4.1、§4.2、§5.0、§5.1、§5.3、§6、§7、§9 随之改；v1.4：§5 改成按会话的 Remote 开关（负责人 10-24：「可以选择开启 remote 按钮，以实现多端消息同步」，章程 v3.17），§4.1 随之加开关；v1.3：新增 §3.6 两种模式与设置卡片（负责人 10-24 追加），§3.2、§3.5、§4.1 随之改写，§3.5 写入壳侧实现；v1.2：§3.2–§3.5 按 P37.13 局部导航、先改后同步与外观的实现回写，§4.2.1 补识别细则（`qmo agents` 已实现） |
| 日期 | 2026-10-24 |
| 核对基点 | v1.6.1：main `af903b8a`（#283）；v1.6：`feat/p37-14a`（P37.14a 三路合流，基于 `feat/p37-14-local`）；v1.5：本仓库 `b1403211`（`feat/p37-14-local`，基于 #281 的 `feat/p37-13-modes`）；v1.4 及以前为 `b0a8789a`（main，#276 之后） |
| 范围依据 | 负责人 2026-10-24 的要求，原话见 §0。章程 v3.17 §2.13 |
| 编号 | P37.13–P37.16（包表见 §8），P37.14 分 a–d 四包。P37.7「本机节点」并入 P37.14；原 P37.16「本机直连」并入 P37.14a |
| 依赖 | [`qmo-app.md`](./qmo-app.md)（壳、进门、IPC）、[`clients.md`](./clients.md)（`qmo`、设备令牌）、[`harness-backends.md`](./harness-backends.md)（底层目录与各底层的原生接口）、[`console.md`](./console.md)（前台与后台） |
| 结论一句话 | 照 Claude Desktop 的做法：界面点了就动，网络只搬数据；壳里多一个「开发」页，用这台电脑上装好的 agent 在本机项目里干活；本机会话经中枢同步，别的设备能看、能接着说 |

由主 agent 按负责人 10-03 的常设委托（设计取舍自行裁定）定案。「未实测」「未评估」是证据状态，不是授权门槛。

---

## §0 依据

负责人 2026-10-24（对话记录）：

1. 「整个桌面端该不会要等到网页响应才会响应吧（不要这样设计）」
2. 「我希望桌面端可以接入本地常用 agent 进行开发，然后借助云端实现多设备互通同步，agent 识别逻辑参照 magpie」
3. 「学习 claude desktop，几乎复刻，后续我们再做特殊化」
4. 「网页前端也尽量清爽简约，学习 claude desktop」

现状（v1，`qmo-app.md`）：壳里装的是中枢渲染的页面。对话页 `/app` 内部切会话不重载，但后台各页（`/admin/*`）每点一下都是整页导航，每页都把整套内联样式与脚本重新下一遍；开关类操作（权限模式等）等中枢回话才改界面。本机 agent 不在桌面版里。

## §1 Claude Desktop 怎么做（只取做法）

依据 10-22 对本机 Claude Desktop 3.1623.1 的静态分析（负责人本机证据目录，没有启动它），只取架构与交互，不复制代码、文案、图标与品牌：

| 方面 | 它的做法 | 对我们的意义 |
|---|---|---|
| 界面 | 薄壳装远程网页，但网页是单页应用：切页、开菜单、换设置都在本地完成，只有数据走网络 | 「不等网页」靠的是页面自己先动，不是把页面搬进壳 |
| 首帧 | 壳记住上次的侧栏宽度与行位置，网页到之前先画骨架 | 已有骨架页，要改成按上次实际布局画 |
| 本机会话 | 「Code」页的会话在本机跑：壳里有会话管理、终端进程、Git 状态、预览浏览器，随包带 agent SDK | 「开发」页照这个分工：会话在本机，网页经壳的接口驱动 |
| 跨设备 | 设备登记、远程控制、把会话挪到云端 | 本机会话经中枢同步与转发 |
| 视觉 | 暖灰中性色、界面字 14/20、正文 16/24、控件高 32、圆角 8/12、0.5 px 细线、标签少 | 前台与后台统一收成这一套节奏（§3.4） |

不照搬：它的 Cowork 虚拟机、模拟器与 Office 插件、硬件配件；它把整个网页应用另带一份进安装包（只在第三方推理模式用），我们不做——界面跟中枢一起升级更重要，离线时有骨架和本机会话就够。

## §2 总体

```
┌─────────────── Qmo.app ───────────────┐          ┌──────── 中枢 ────────┐
│ 主窗口：中枢页面（单页式导航，§3）      │◀─HTTPS──▶│ 页面、接口、名册      │
│ Code 面 ─IPC─▶ 壳 ─管道─▶ 运行器（§4.3）│          │ 设备链路（§5）        │
│   └ 本机 agent：Claude Code、Codex…     │          │ 本机会话的副本（§5.3）│
│ qmo：设备令牌、进门、设备链路 ──WSS────▶│─────────▶│                      │
└────────────────────────────────────────┘          └──────────────────────┘
        其他设备（浏览器、另一台桌面版）只连中枢，经它看与续写本机会话
```

- 页面仍由中枢渲染（章程 N-5 的「服务端渲染、零新运行时依赖」不变），首屏之后的导航由页面自己的脚本完成。
- 本机节点由随包的 `qmo` 实现：`qmo code serve`（运行器，§4.3）是壳的常驻子进程，不另带 `qm`；状态在客户端目录下，不碰 `~/.qianmo`。
- 设备令牌仍只在 `qmo` 里：运行器就是 `qmo` 进程，设备链路（P37.15）也在这个进程里拨，没有回环端口。

## §3 即时响应与清爽外观（P37.13）

### 3.1 规矩

- 任何点击 100 ms 内有看得见的变化：导航先换高亮与骨架，开关先换状态，提交先出现在列表里。
- 不等网络才改界面。写操作先改本地，失败时回到原样并就地写原因（不弹窗）。
- 切页不重载文档：侧栏、顶栏、滚动位置、正在流式输出的对话都不断。
- 数据旧了先显示旧的，后台刷新，变了再换；用户正在操作的那一块不被刷新打断。

### 3.2 局部导航

实现在 `atlas/packages/console/src/assets/nav.ts`（导航运行时，内联在共享运行时之后）、`view/shell.ts`（`shellPartial`）、`routes/index.ts`（`areaPartial`）与 `http.ts` 的 `servePage`。

| 项 | 做法（已实现） |
|---|---|
| 拦截 | 同源、路径在 `/admin` 下的链接（卡片的区域列表、面包屑、区域里的链接，前台菜单里指向某个区域的链接，不限 `data-nav`）与浏览器前进后退：卡片没开就先打开（§3.6），再在卡片里换。`data-settings` 的链接打开卡片、落在上次看的区域。卡片里指向 `/admin` 以外的链接（`/`、`/app`、`/?agent=…`）先关卡片，再交给浏览器。修饰键、中键、`target`、`download`、同页锚点（卡片的「跳到正文」）、表单 GET 照常走浏览器。监听挂在 `window` 冒泡阶段的最后，运行时或页面脚本已经 `preventDefault` 的点击（`data-action`、对话框开关）不碰 |
| 请求 | `fetch` 原地址，带 `X-Qianmo-Partial: 1`、`Accept: application/json` 和控制台头（存着令牌时另带 `Authorization: Bearer`，从不进 URL）。中枢在同一个 `servePage` 里先跑同一道守卫，再渲染同一页，只是把答案画成 JSON；cookie 会话读部件必须带控制台头（与片段同为 `guarded`）。拒绝一律是 JSON（无凭据 401、角色不够 403、页面自己答的 404），不出登录卡、不重定向。两种答案都带 `Vary: X-Qianmo-Partial`，都是 `no-store`。不带头的请求照旧回整页，浏览器直接打开、刷新、禁用脚本都不受影响 |
| 答案字段 | `v`（协议版本，现为 2：列表是卡片的一列，§3.6）、`shell`（外壳键，见下）、`documentTitle`、`title`（卡片标题 `<h2>` 的文字）、`crumbs`（面包屑 `<nav>`，可空）、`actions`（标题行右侧：页面动作与健康条）、`main`（卡片里区域的内容，含公开版页脚）、`nav`（卡片列表的内容，当前项已标 `aria-current`）、`active`、`poll`、`refresh`（`poll` 时附刷新开关，供首屏没画它的文档插入）、`css`（本页样式表，已去注释）、`script`（本页脚本原文）、`hash`（`script` 的 `'sha256-…'`）。标记字段都是服务端渲染、已转义的视图输出 |
| 换上去 | 换卡片的标题、面包屑、标题行右侧、区域、本页样式表（文档里最后一个 `<style>`）；列表项 id 一致时逐项就地改（焦点不丢），否则整体重画，当前项滚进视野；`pushState`。刷新开关按 `poll` 显示或隐藏，没有时插入并接上。区域里的对话框关上。焦点原在区域里（或没有焦点）时移到卡片的 `#main`，区域滚回顶部；前进后退回到离开时的滚动位置（`history.scrollRestoration = 'manual'`，第一次局部换页时才设）。最后看的区域记在 `sessionStorage`，下次打开卡片落在那里 |
| 预取 | 只在指针按下时开始取（不等松开），按下到松开的提前量已够；悬停不预取：每个部件在中枢上都要读名册、渲染整页，中枢在小机器上，指针扫过侧栏会白白触发多次。同一地址在飞的请求复用，取到的答案 5 秒内直接用 |
| 缓存 | 内存里留最近 20 页（插入序淘汰）。前进后退与回到看过的页面先显示留着的那份；超过 5 秒的同时后台再取，答案的主区变了、读者也还没在这页上点按或按键，才换上新的。不落盘；退出登录、换令牌、会话失效都清空，换令牌后下一次换页走整页（角色标签、策略和侧栏要换成新凭据的） |
| 脚本与 CSP | 页面脚本都是编译期常量。外壳文档只带一段 `<script>`：共享运行时 + 导航运行时 + 本页脚本 + 一行收尾。策略的 `script-src` 列这一段的哈希，再列本页脚本单独的哈希和侧栏对这个读者可见的各区域页面脚本的哈希（`routes/index.ts` 的 `navScriptsFor`，与侧栏同一个 `visibleTo` 判断；读者进不去的页面不列）；`<meta>` 与响应头由同一组脚本算出（`respond.ts` 的 `documentHeaders(body, allow)`）。只有 `script-src` 变长，其余指令逐字不变（`test/nav.test.ts` 核对）。换进来的脚本以内联 `<script>` 插入、立即执行；执行前客户端拿答案的 `hash` 对照文档 `<meta>` 里的策略，不在就整页导航 |
| 外壳键 | `shell` 是共享样式表、两份运行时、头像样式与导航运行时（去掉键本身）的 SHA-256 前 16 位，写进文档里的导航运行时。答案的键对不上（中枢换了版本而页面还开着）就整页导航，免得新页面配旧样式或旧运行时 |
| 页面脚本的进出 | 见下文「与设计的偏离」 |
| 失败 | 网络不通或 5xx：保留当前页，`#conn` 下方出一行细提示「页面没有打开 · 正在重试」，1.2 秒后自动重试一次；仍失败就写明原因（`HTTP 503`、无法连接、浏览器离线）并给「重试」按钮。401、跳去登录门的重定向、403、页面自己的 404、不是本协议的答案、外壳键或哈希对不上：一律整页导航（`location.assign`；前进后退时 `location.reload`），401 因此落到登录门，桌面壳在那里重新进门（`qmo-app.md` §3 第 4 步）。会话已失效的页面不再局部换页 |
| 过渡 | 取页期间卡片带 `data-busy`：区域降到 55% 不透明；换上的区域从 55% 用 120 ms 回到不透明（卡片带两帧 `data-arriving`，`view/frontStyle.ts` 的 `.set[data-busy]`、`.set[data-arriving]`，共享样式表仍无 `@keyframes`）；`prefers-reduced-motion` 时直接换。不用 View Transitions：过渡期间所有按下都落在根元素上（快照盖在上面），列表里紧接着的第二下、×、遮罩都会丢，慢机器上过渡还会拖过卡片关闭（Chrome 155 在 macOS 与 Linux 上实测） |

**与设计的偏离：页面脚本没有各自导出 `mount` / `unmount`。** 后台二十个页面脚本（约 190 KB）都写成立即执行的函数，直接往 `document`、`window` 挂监听、开定时器、向运行时注册动作。逐个改写成导出 `mount` / `unmount` 等于重写全部页面脚本，风险与收益不相称。改为由导航运行时给页面脚本套一个「录制作用域」：脚本执行的那一段同步时间里，它往 `document`、`window` 加的监听、开的 `setTimeout` / `setInterval`、经运行时注册的动作（`onAction`）、提交（`onSubmit`）与失效钩子（`onExpire`）、新加到 `window` 和运行时对象上的属性都记下来；离开这一页时先跑它的失效钩子（页面就是靠这个停轮询的），再逐项撤销。执行脚本就是 `mount`，撤销就是 `unmount`。页面在点击之后才开始的轮询，由它注册的 `qc.onExpire` 停，或注册 `qianmoNav.onLeave`；本包给缺这一步的四处补上了（`connectScript` 的配对倒计时、`updatesScript` 的升级跟踪、`channelsScript` 的扫码轮询；`replicate`、`magpie`、`providers` 原本就有）。浏览器用例核对同一页来回进出两轮后 `document` / `window` 上的监听逐类计数不变。没有覆盖的：脚本在某个回调里（而不是执行当时）直接挂到 `document` / `window` 上的监听——目前的页面脚本没有这种写法，新写的页面脚本要遵守。

**几处之间实际做到的层级。**

- 卡片里各区域之间：局部换页，文档不重载（浏览器用例在 `window` 上放标记，换页、前进后退后仍在）。
- 前台去卡片（设置图标、⋯ 菜单、⌘, / Ctrl+,、桌面版菜单、前台菜单里指向某个区域的链接）：不重载，卡片在当前页上打开，区域经局部换页取来；前台的流式对话、草稿都还在。
- 卡片回前台：关卡片，地址退回打开前那一条；卡片里指向前台的链接（`/?agent=…` 等）先关卡片再整页导航。
- Work 与 Code 之间、前台 `/` 与 `/app` 之间：仍是整页导航。前台带着流式对话（SSE）、草稿与大量状态，局部换要先把前台脚本拆出可卸载的边界，留给后续包。

`/app` 与 `/` 内部原有的会话级局部切换不变。

### 3.3 先改后同步

| 操作 | 本地先做 | 失败 | 状态 |
|---|---|---|---|
| 发消息 | 消息立即进对话，标「发送中」（原本如此） | 已打开的会话里：那一行留下，改画成未送达的样子（虚线气泡），下面写「未送达」和「重试」，文字不再放回输入框；点「重试」去掉这行重新发送。同一会话重绘时这行留在末尾，直到重发或离开页面（不落盘）。欢迎页上开新会话时失败：照旧重画欢迎页、文字放回输入框（没有会话可留这一行） | 已做 |
| 权限模式 | 菜单与按钮立即显示新值，写出去期间该项不可再点 | 只认最后一次选择的答案；被拒时退回中枢最后一次给的值，原因写在输入框下的状态行；切到别的智能体后到达的答案不改屏幕 | 已做（`assets/frontTools.ts`） |
| 模型、推理强度 | 这两项本来就是往会话里发一条 `/model`、`/effort` 命令，走发消息那条路（先显示）；菜单下次打开时按模型服务回报的值或本页记下的值打勾 | 同发消息 | 未另做 |
| 后台开关（带 `data-write` 的复选框、单选、下拉） | 控件立即变；旁边一行「保存中…」 | 退回原值，旁边写「保存失败 · 原因」（`role="alert"`），并照旧弹出提示。这一行在所在区域下一次轮询刷新时随区域一起换掉 | 已做，通用（`assets/nav.ts`，包住 `sendJson`）。云端电脑与定时任务两处开关失败时不再刷新整个区域 |
| 设置行（`view/settingRow.ts`） | 控件立即变 | 退回服务端的值，原因写在行下 | 原本如此，未改 |
| 后台表单的「保存」 | 带 `data-write`、纯文字、以「保存」开头的提交按钮在写出去期间显示「保存中…」（运行时原有的禁用与 `aria-busy` 不变） | 恢复按钮文字；字段级原因照旧由页面写在字段下（`markField`） | 已做 |
| 置顶、改名、归档、删除会话 | — | — | 代码里没有这些操作：会话的 ⋯ 菜单只有「在智能体里打开」「复制地址」，会话接口只有列出、开会话（P37.17 起答读者跟这个智能体的常驻会话，没有才新建）、读取、发消息；智能体行的 ⋯ 另有「其他对话」（只读，[`console.md`](./console.md) §6.1）。删除的「先藏 10 秒可撤销」待这些操作出现时再做 |

### 3.4 外观

取 Claude Desktop 的节奏，配色、字体、图标、头像仍是阡陌的。数值按 2026-10-24 对 Claude Desktop 3.6556.2 安装包的静态分析校准（负责人本机证据目录，只取数值；不用它的字体、品牌色与类名，不抄它的样式源码）。前台与后台用同一组变量：只在 `assets/css.ts` 的 `:root` 定义一次（浅色一套，深色在 `prefers-color-scheme` 与 `data-theme="dark"` 两处各写一遍同样的值，两套相同的值只写在浅色里；每份文档都内联这份样式，前台也是），`view/frontStyle.ts` 与前台其余样式只引用。字号、颜色、圆角，以及侧栏宽、顶栏高、阅读栏宽、红绿灯留白都是变量，按实测值校准时只改变量；例外是头像编辑器与头像框自己的尺寸（头像是阡陌的）、主题色选择器的色环，和 `routes/` 里总览、审计两页的页内样式。主题色、浅色 / 深色 / 跟随系统、强调色切换照旧。实际取值：

| 项 | 取值（变量） |
|---|---|
| 底色 | 页面 `#f9f9f7` / 暗 `#0b0b0b`（`--color-bg`）；第一层面 `#fcfcfb` / `#151515`（`--color-surface-1`）；侧栏浅色用第一层面，深色是页面色混 20% 黑（`--color-side`）；面板 `#ffffff` / `#1a1a19`（`--color-surface`）；菜单与弹层 `#ffffff` / `#20201f`（`--ui-menu`）；分段控件选中的底板 `#ffffff` / `#3a3a37`（`--ui-raised`） |
| 文字 | 主文字 `#0b0b0b` / `#f0efec`（`--color-text`）；次文字 `#52514e` / `#c3c2b7`（`--color-quiet`）；弱文字 `#898781`，两套相同，只给输入框占位字（`--color-text-3`，浅色页面上不到 4.5:1）；说明文字仍是主文字的 68%（`--color-muted`），保证各种底色上 4.5:1 |
| 线与悬停 | 分隔线主文字 10%，0.5 px（`--color-divider`、`--hairline`）；强边框 20%（`--ui-line`，控件描边）；悬停 / 选中 5% / 10%，深色 7.5% / 15%（`--ui-hover` / `--ui-selected`） |
| 阡陌自己的颜色 | 强调色（琥珀与标志的鼠尾草绿两条色阶）、主题色、交互蓝 `#2a78d6`（`--color-interactive`）、开关圆钮与勾 `--color-on-interactive`；前台的印章红 `--color-seal`、智能体气泡 `--color-agent-bubble`、用户消息块 `--color-user-block`。参照方的品牌色没有用 |
| 字 | 系统字体：`-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans"`，后接微软雅黑与 Noto Sans SC 给 Windows、Linux 的中文。字号 / 行高：说明小字 12/17（`--text-small`），注释 13/17（`--text-footnote`，`.note`），界面 14/20（`--text-ui`），分节标题 15/20（`--text-heading`，`h2`），对话正文 16/24（`--text-prose`），标题 22/28（`--text-title`），页头 24/32（`--text-page`，设置卡片里的区域名），代码 13/19（`--text-code`）；字重 400 / 500 / 600。另有欢迎页问候语 30/38（`--text-display`）与侧栏品牌字 15（`--text-brand`），这两处参照里没有对应值，是我们自己的 |
| 控件 | 高 32（`--control-h`），另有 24 / 28 / 40（`--control-h-xs` / `-sm` / `-lg`）；圆角 8（`--radius-control`），旁边 6 / 7 / 10（`--radius-xs` / `-sm` / `-lg`），复选框 5（`--radius-check`）；面板与弹层 12（`--radius-panel`）；输入框 14（`--radius-composer`），欢迎页大输入框 20（`--radius-composer-lg`）；对话气泡 18（`--radius-bubble`）；快速输入卡片按 §10.1 保留 16（`--radius-quick`）；图标 20，行内 16（`--icon` / `--icon-sm`） |
| 布局 | 侧栏 288（`--side-w`，后台原来 272，一并改成 288），顶栏 48（`--top-h`），阅读栏 768（`--column-w`）；桌面版 macOS 下品牌行与顶栏左侧给红绿灯留 80（`--shell-lights-x`，参照是 74，壳里核对后再定），红绿灯本身的位置由壳定，不在样式里 |
| 间距 | 4 / 8 / 12 / 16 / 24 / 40（`--space-1`…`--space-8`；`--space-5` 与 `--space-6` 都是 24）；参照的 6 不单设变量 |
| 阴影 | 只三档：`--shadow-sm` / `--shadow-md` / `--shadow-lg`。弹层（lg）是 0.5 px 环（主文字 10%）加 `0 8px 24px` 12%、`0 2px 6px` 8% 的黑，深色 32% / 20%；列表与平铺内容不用阴影 |
| 动效 | 60 / 120 / 200 / 300 ms（`--motion-fast` / `--motion-snap` / `--motion-base` / `--motion-sheet`），`cubic-bezier(.165,.84,.44,1)`（`--ease-out`）；后台样式里的过渡不超过 200，300 只给整块换入与前台抽屉；原前台的 450 并入 300；减弱动效时照旧关掉 |
| 后台页 | 不再一页一堆卡片：卡片去底色和圆角，同类条目排成列表，行间 0.5 px 线；总览的统计格改成一条横排数字。说明文字只留一行；状态用一个点加一个词（`state()`），黄、红两种需要注意的状态词带颜色，其余是安静的墨色 |

未做完的（P37.13 第一轮之后）：说明文字的「?」提示还没有做，现有多行说明是删短或保留；`tag()` 小标签里有一部分是状态（「可达」「链完整」「待审批」等），只有设置页的实例一节改成了点加词，其余仍是带底色的小标签；总览与审计页的页内样式写在 `routes/overview.ts`、`routes/audit.ts` 里，这一轮没动，只随公共变量变化。桌面版本地骨架页（`apps/qmo/ui/app.css`）按值抄这套颜色，已对齐；壳在页面到之前画的窗口底色（`src-tauri/src/shell.rs` 的 `page_background`）取页面上次报的页面色，没报过时是 `#f9f9f7` / `#0b0b0b`（§3.5）。

### 3.5 首帧

页面每次布局变化经命令 `qmo_boot_layout` 报给壳，壳存在设置里；下次启动骨架页按它画，和真实页面对得上。

页面侧与壳侧都已实现。页面只在 `window.__QMO_SHELL__` 是对象且 `window.__TAURI__.core.invoke` 可用时调用；调用包在 `try` 里、返回的 Promise 吞掉拒绝，壳里没有这条命令时什么也不发生。布局稳定 400 ms 后才报，和上一次报的一样就不报。

调用：`invoke('qmo_boot_layout', { layout })`，`layout` 字段：

| 字段 | 类型 | 含义 |
|---|---|---|
| `page` | `'chat'` \| `'agents'` \| `'code'` | 哪个面：`/app`、`/`、`/code`。后台已退役成卡片（§3.6），不再报 `'admin'`；卡片开着时报的是它底下的面 |
| `side` | `'open'` \| `'closed'` | 侧栏是否展开（看 `#fx[data-side]`，窄于 700 px 记为收起） |
| `sideWidth` | 整数 0–1000，CSS 像素 | 侧栏实际宽度（页面先夹到这个范围再报） |
| `rows` | 整数，≤ 60 | 侧栏里看得见的行数（会话行或智能体行，用 `checkVisibility()` 判断） |
| `labels` | 整数，≤ 20 | 看得见的分组标题数（「今天」「昨天」等） |
| `theme` | `'system'` \| `'light'` \| `'dark'` | `<html data-theme>`，缺省 `system` |
| `colors` | `{ dark: boolean, page: '#rrggbb', sidebar: '#rrggbb' }` | 此刻的明暗（`data-theme` 或跟随系统时的 `prefers-color-scheme`）与页面底色、侧栏底色：取计算样式（`body` 与 `#fx-side` 的 `background-color`），在 1×1 画布上画一下再读回成 `#rrggbb`，画布不可用时按 `rgb()` 解析。壳那边可省，页面总是给 |

全部由 `assets/frontShell.ts` 报：启动、窗口改变大小、侧栏开合、侧栏列表变化、换外观、系统明暗变化时。设置卡片自己什么也不报。

壳侧（`atlas/apps/qmo/src-tauri/src/layout.rs`、`ipc.rs`、`ui/skeleton.js`）：


- 命令只给中枢源（remote 能力，另在命令里核一次调用方页面与中枢同源），逐字段校验：`page` 只收 `chat` / `agents` / `code`，`side`、`theme` 只收表里的词，`sideWidth` 0–1000、`rows` 0–60、`labels` 0–20 的整数，多键、类型不对、越界整次拒绝；`theme`、`colors` 可省。`colors` 是 `{ dark, page, sidebar }`，两色必须是 7 位 `#rrggbb`。
- 存进壳的设置文件（`settings.json` 的 `layout` 与 `colors`），颜色按 `dark` 分浅、深两套各存一份；与已存的相同就不写盘。读时 `layout`、两套颜色各自坏了只丢那一块；旧文件里的 `page: 'admin'` 读成 `chat`。
- 骨架页：壳把布局与颜色算成一份计划（Work \| Code 里亮哪一面：`code` 亮 Code，其余亮 Work；侧栏宽或收起；`rows` 行均分到 `labels` 组、每组前一个标题；浅、深两套颜色，没报过的那套用缺省：浅页面 `#f9f9f7`、侧栏 `#fcfcfb`，深页面 `#0b0b0b`、侧栏为页面色混 20% 黑），经主窗口的初始化脚本以 JSON 交给本地页面（只在 `tauri:` / `tauri.localhost` 上定义 `window.__QMO_BOOT__`，不拼进 HTML），`skeleton.js` 在首帧前画，再向壳要一次最新的计划（`local_boot`），不同就重画；经 `about:blank` 进中枢时，壳把同一份计划随骨架写进去。页面上再核一遍颜色与数字，不合格的用样式表的缺省。颜色按系统当前外观选那一套；页面强制了与系统相反的明暗时，骨架用的是系统那套，页面到了会换一次色。
- 主窗口的底色（页面画出来之前看到的）取当前外观那套的页面色。

### 3.6 两种模式与设置卡片

负责人 2026-10-24 追加：「学习成claude desktop那种模式，设置页单独成一个单独卡片」「主页面只显示work和code两个模式」。壳侧对应的是菜单「设置」、`qmo_local_agents`、`qmo_open_local_settings` 与骨架页按 `colors` 画（§3.5）。

**两种模式。** 侧栏顶部是品牌与收起按钮一行，下面是占满侧栏宽度的 Work | Code 分段切换（两个词三种语言都不译）。

| 模式 | 内容 |
|---|---|
| Work | 浏览器里是 `/`（智能体），桌面版里是 `/app`（对话）：切换上的 Work 链接按壳的 cookie 指向其一。原来「对话 · 智能体」两项切换缩成列表标题行右侧的两个小图标 |
| Code | `/code`，即 §4.1 的「开发」页。侧栏：「新代码会话」、「代码会话」标题与列表（本包为空，写「还没有代码会话」）。桌面版里主区是「本机 agent」与「重新检测」，壳经 `qmo_local_agents` 找到的每个 agent 一行（名称、版本、可用，或不可用的原因；答案只经 `textContent` 写进页面），新会话的文件夹与 agent 两项（下拉里只有可用的），「开始」关着，旁边写「本机会话未开放」（P37.14 开放）。浏览器里、壳没有这条命令时，主区只有一行「Code 在 Qmo 桌面版里用」，不给下载链接，「新代码会话」不可点 |

主页面上不再有通往后台的文字链接：空名册的「管理节点」、欢迎页与问候页的管理链接都去掉了。侧栏底部「我」一行保留，滑杆图标与 ⋯ 菜单原来的「管理后台」都改成「设置」。前台菜单与弹层里指向具体区域的上下文链接（节点详情、模型设置、消息链、trace、模型选单里的链接）保留，点了在卡片里打开。

与壳的约定（`qmo_local_agents`，只在 `window.__QMO_SHELL__` 是对象且 `invoke` 可用时调用）：

| 项 | 约定 |
|---|---|
| 调用 | `invoke('qmo_local_agents', { rescan })`：打开 Code 面时 `rescan: false`，「重新检测」时 `true` |
| 成功 | `qmo agents --json` 的对象 `{ agents: [...] }`；页面读每项的 `id`、`name`、`version`、`available`、`reason` |
| 失败 | 拒绝，原因是一行字符串。以 `qmo ` 开头的是壳自己的四种：`qmo did not start: …`、`qmo agents took longer than 30 s`、`qmo agents: <qmo 的消息>`（qmo 没有 `agents` 子命令时也是这一种）、`qmo agents printed an unexpected answer`——原样写进状态行，「重新检测」可再试。其余拒绝是 Tauri 的（命令不存在或不许这个页面调）：当作壳早于 Code，显示那一行 |

**设置卡片。** 管理后台不再有自己的外壳，所有区域都在主窗口上方的一张卡片里（`view/shell.ts` 的 `renderSettings`，运行时 `assets/nav.ts`）。

| 项 | 做法 |
|---|---|
| 内容 | 除对话外的全部区域（日常一组与运维一组），排成一列：组与组之间、`CLUSTER_STARTS` 各处只留空白，不写组名；谁看得见哪个区域照旧由 `visibleTo` 定。桌面版里列表下另有一项「桌面版」，调 `qmo_open_local_settings` 打开壳自己的设置窗 |
| 打开 | 侧栏底部的滑杆图标、⋯ 菜单的「设置」（都是 `href="/admin"` 加 `data-settings` 的链接，不跑脚本时整页去区域地址）、⌘, / Ctrl+,、桌面版菜单「设置… ⌘,」与托盘「设置」（壳在主窗口里执行 `window.__qmoOpenSettings()`）。落在这个标签页上次看的区域（`sessionStorage`），没有就是列表第一个看得见的区域。卡片已开时，这几种方式都只把焦点放回卡片 |
| 关闭 | ×、Esc、在遮罩上按下并松开。焦点回到打开它的那个元素；开着时 Tab 在卡片里循环（第一站「跳到正文」，打开时焦点在搜索框）。一次 Esc 只关一层：卡片里开着对话框时 Esc 是那个对话框的；Chrome 把不经点击打开的对话框与卡片编成一组、随后也给卡片发关闭请求，卡片能留时就留下（之后按过键或点过），浏览器不许留时随它关 |
| 外观 | 遮罩浅色 `#0006`、深色 `#00000080`（`--settings-scrim`）；卡片居中，`min(1080px, 100vw − 64px)` × `min(800px, 100vh − 64px)`，圆角 12，面板底色，弹层阴影。左栏 220（`--settings-side-w`）：上面搜索（只在页面里按名字筛，回车打开剩下的第一个）、下面列表、底部刷新开关、时区与两枚旧令牌才有的令牌框；右边是标题行（面包屑、区域名、页面动作与健康条、右上 ×）与独立滚动的区域。进出 200 ms、`--ease-out`，透明度加 0.98→1 的缩放，减弱动效时没有动画。窄于 700 px 卡片铺满窗口：搜索与一行横向滚动的区域列表在上（当前项滚进视野），区域在中间，左栏底部移到最下。数值都是 `assets/css.ts` `:root` 的变量 |
| 地址 | 打开时 `pushState` 到 `/admin/<区域>`，卡片里每换一次区域再 push 一条（§3.2）。关闭时，这一页自己 push 过的用 `history.go(-n)` 退回打开前那一条；卡片随文档来的（直接打开区域地址）把第一条 `replaceState` 成底下那个面的地址（桌面版 `/app`，浏览器 `/`，Code 面 `/code`）。前进后退到区域地址会再打开卡片，退到别处会关上 |
| 直接打开区域地址 | `/admin/<区域>` 的文档是 Work 面（带桌面版 cookie 时画成 `/app`，否则 `/`）加画开着的卡片，区域在里面，首帧就有；运行时一启动就把它变成模态的。Work 面这时不读对话（不经 `chatReads` 门、不开转录），关了卡片地址换成 Work 面的，默认对话照原有片段路径取。旧的后台外壳已经退役。守卫与 401 / 403 / 404 都不变，404 画在卡片里；读者不能对话时 Work 面只写一行原因，接没接聊天通道是同一行 |
| CSP | Work、Code 与区域地址的文档都列出这个读者在卡片里能去的区域的页面脚本哈希（`navScriptsFor`，与列表同一个 `visibleTo`），`<meta>` 与响应头一起算（§3.2） |
| `window.__qmoOpenSettings` | Work、Code 与区域地址的文档上都有；浏览器里的 ⌘, / Ctrl+, 走同一个函数。读者没有管理侧权限、文档里没有卡片时不定义，壳退回打开自己的设置窗 |

**取舍。** 卡片用原生 `<dialog>` 的 `showModal()`：在顶层、外面的页面自动不可操作、Esc 与焦点归还是浏览器的；`<dialog>` 本身铺满窗口当遮罩、卡片是里面的一块，这样遮罩颜色走变量和过渡，不依赖 `::backdrop` 能否取到变量。toast 区在卡片开着时移进卡片，不然会落在遮罩后面。区域仍是服务端渲染的页面，卡片只换了它们的框（§3.2 的部件协议只改了列表的形状，版本升到 2），没有另起一个设置单页应用。区域地址不保留旧外壳：两套外壳会让同一区域有两种样子、两份样式。

## §4 本机开发（P37.14）

### 4.1 「开发」页

主窗口只有 Work | Code 两种模式（§3.6），「开发」页就是 Code 面（`/code`）。P37.13 已画出它的框：侧栏的「新代码会话」与代码会话列表、主区的本机 agent 与新会话两项，「开始」关着。浏览器里 Code 现在只有一行「Code 在 Qmo 桌面版里用」；P37.15 之后浏览器里显示其他设备同步上来的本机会话（只读或经中枢续写，§5）。

| 区域 | 内容 |
|---|---|
| 侧栏 | 「新会话」；按项目文件夹分组的会话，每行是标题、agent 小标、状态（运行中、等你确认、完成）；设备离线的会话变灰 |
| 新会话 | 选文件夹（壳的原生选择框，最近用过的在前）、选 agent（§4.2 识别出的列表，带版本，不可用的写原因）、是否开独立工作树（Git 仓库才可选）、权限模式（§4.4，缺省自动审批）、Remote 开关（§5.0，P37.15 起，缺省取设置里的值）；第一句话写在下面的大输入框里，发出即开会话 |
| 会话 | 阅读栏与对话页同形（§4.5.5）；标题栏右侧有 Remote 开关（§5.0，P37.15 起）；右侧面板「变更」（工作区的改动，按文件看 diff，§4.3.7）；「文件」、终端、预览浏览器、模型选择是后续包 |

### 4.2 识别本机 agent（参照 magpie）

识别逻辑照 magpie 的做法写成我们自己的代码，结果由 `qmo agents --json` 给出（壳与运行器都读它）：

| 字段 | 含义 |
|---|---|
| `id` | 与底层目录一致：`claude-code`、`codex`、`gemini`、`qwen`、`opencode`、`dsh`；不能驱动的另有自己的 id（§4.2.1）。P37.14a 以前还有 `omp`（内置的 qianmopi），之后不再列（§4.3.1） |
| `name`、`version` | 显示名；版本先读它的 npm 包，否则取它自己的 `--version`，取不到为 `null` |
| `path` | 实际可执行文件路径；没找到为 `null` |
| `protocol` | 与底层目录一致：`omp`、`claude-stream`、`codex-app-server`、`acp`；不能驱动的为 `null` |
| `available` | 能不能用；不能时 `reason` 写原因（找不到命令行程序、不是同名的另一个程序、暂不支持接入等） |
| `source` | 程序从哪里找到的：`builtin`（qianmopi）、`path`（查找目录里按命令名找到）、`vendor`（厂商安装器的固定位置）、`brew`（命令名与别的工具同名时，只认该 agent 的 Homebrew 包装的） |
| `configFound` | 它的配置文件、或它自己的配置目录在这台电脑上 |
| `signedIn` | 本版恒为 `null`（未知），见 §4.2.1 |

#### 4.2.1 判定细则

参照 magpie（yetone/magpie，MIT）的识别逻辑，代码为本项目自写（`atlas/packages/client/src/agents.ts`、`computer.ts`）；依据的 magpie 源文件与提交记在 NOTICE 五.6。

**只做什么**（章程 §2.13 第 3 条；负责人 10-24 补充）：

- 只做：stat 配置文件与配置目录、列配置目录的条目名（判断是不是只剩残留，不打开其中任何文件）；在查找目录里找可执行文件；读 npm 包的 `package.json`（Windows 上还有 npm 的 `.cmd` 垫片）；运行 `<程序> --version`；对 dsh 运行 `dsh --help` 判别。
- 不做：读取或复制任何 agent 的凭据与登录文件（`~/.claude.json`、`.credentials.json`、`auth.json`、`oauth_creds.json`、Keychain 等），连 stat 都不做；不读配置文件内容；不写、不改任何 agent 的目录与配置；不以服务或协议模式启动 agent（不跑 `gemini --acp`、`codex app-server`、`claude -p`，不发 ACP `initialize`）——Gemini CLI 一启动就会自动登录。
- 登录状态本版不做，每项 `signedIn` 恒为 `null`。以后若做，只用文档写明只读的状态命令：`claude auth status --json` 只取 `loggedIn`、`authMethod`、`apiProvider`，丢掉邮箱与组织；`codex login status`。

**候选清单**（写死在代码里；前六项与底层目录 `catalog.ts` 的 id、名称、协议、命令、npm 包一致，由 `qianmo-client-agents-catalog.test.ts` 核对）：

| id | 名称 | 命令 | `protocol` | 配置目录（环境变量优先） | 配置文件 | 特例 |
|---|---|---|---|---|---|---|
| `claude-code` | Claude Code | `claude` | `claude-stream` | `CLAUDE_CONFIG_DIR` > `~/.claude` | `settings.json` | 厂商位置 `<配置目录>/local/claude`、`~/.claude/local/claude` |
| `codex` | Codex | `codex` | `codex-app-server` | `CODEX_HOME` > `~/.codex` | `config.toml` | |
| `gemini` | Gemini CLI | `gemini` | `acp` | `$GEMINI_CLI_HOME/.gemini` > `~/.gemini` | `settings.json` | 只认命令：`~/.gemini` 是 Antigravity 也写的目录 |
| `qwen` | Qwen Code | `qwen` | `acp` | `QWEN_HOME` > `~/.qwen` | `settings.json` | |
| `opencode` | opencode | `opencode` | `acp` | `OPENCODE_CONFIG_DIR` > `$XDG_CONFIG_HOME/opencode` > `~/.config/opencode` | `opencode.jsonc`、`opencode.json`、`config.json` | 厂商位置 `~/.opencode/bin/opencode` |
| `dsh` | DeepSeek Harness | `dsh` | `acp` | `DSH_HOME` > `~/.dsh` | `config.yaml` | macOS 桌面 App `DeepSeek Harness.app`；`dsh --help` 判别 |
| `cursor` | Cursor CLI | `cursor-agent` | — | `~/.cursor` | `cli-config.json` | 目录与 Cursor 编辑器共用 |
| `kimi` | Kimi Code | `kimi` | — | `KIMI_CODE_HOME` > `~/.kimi-code`（只有旧版目录时 `KIMI_SHARE_DIR` > `~/.kimi`） | `config.toml` | |
| `droid` | Droid | `droid` | — | `$FACTORY_HOME_OVERRIDE/.factory` > `~/.factory` | `settings.json`、`config.json` | |
| `copilot` | Copilot CLI | `copilot` | — | `~/.copilot` | `settings.json` | 目录与 GitHub Copilot 编辑器插件共用 |
| `goose` | Goose | `goose` | — | Windows `%APPDATA%\Block\goose\config`；其他 `$XDG_CONFIG_HOME/goose` > `~/.config/goose` | `config.yaml` | 与 pressly 的数据库迁移工具同名：命令只认 Homebrew `block-goose-cli` 装的与厂商位置 `~/.local/bin/goose` |

桌面版不带 `qm`（§4.3.1），P37.14a 起不再列 qianmopi；在那以前它恒为列表第一项（`id: omp`、`source: builtin`、`available: true`）。后五项我们不能驱动，照样识别，`protocol: null`、`available: false`、`reason: 暂不支持接入`，找到的路径与版本照报。只列识别到的；没装的不列。环境变量只认绝对路径，相对路径当没设。

**判定顺序**（每项依次，前一步有结论就不往下）：

1. 自定义：Gemini CLI 只看命令（目录位置没被文件占时）；Goose 的命令只认上表两处。
2. 配置目录的位置（或它的某级上级）被普通文件占了：不是（它建不了自己的目录，如 shell 的 `~/.dsh` 文件）。
3. 配置文件存在：是，`configFound`。
4. 配置目录存在，且不只剩 `skills/`、`.DS_Store` 与名为 `logs`、`log`、`debug`、`diagnostics`、`cache` 的目录（不分大小写；同名的普通文件照算）：是，`configFound`。与别的应用共用的目录（`~/.cursor`、`~/.copilot`，以及 Gemini CLI 的）不作证据。
5. macOS 上装了它的桌面 App（目前只有 DeepSeek Harness）：是。
6. 命令在查找目录里：是。
7. 命令在厂商安装位置：是。

**能不能用**：

- 有命令可用：`available: true`。dsh 逐个候选判别，第一个是 DeepSeek Harness 的才采用（Debian 的 dsh、pdsh 也叫 dsh）：是它官方 npm 包 `@deepseek-ai/dsh` 里的程序（经链接或 Windows 垫片读到包清单）就直接认，不运行；否则跑 `dsh --help`，标准输出里要有「DeepSeek Harness」（它的 `--version` 只打版本号，区分不了），判据与节点是同一份（底层目录 `NpmInstall.identity`）。
- 没有可用的命令：同名程序都不是它，`reason` 写「<路径> 不是 DeepSeek Harness（它的 --help 里没有这个名字）」；问不出来（超时、起不来）写「<路径> 核对不了是不是 DeepSeek Harness（…）」；只有桌面 App 写「CLI 未找到（只装了桌面 App）」；其余写「CLI 未找到（有 <配置目录>，但 PATH 与常见安装位置里都没有 <命令>）」。
- 不设最低版本：底层目录只有节点安装时钉住的版本，没有「太旧」的依据；版本只作展示。

**查找目录**（按顺序、去重、只留存在的目录；同名命令取第一个）：

1. 本进程的 PATH。
2. 登录 shell 的 PATH。桌面版从 Dock 或登录项启动时 PATH 只有 launchd 给的几项，装在 npm 前缀、nvm、bun 里的 agent 都找不到。先 `$SHELL -ilc`（很多人把 PATH 写在 `.zshrc`），没有答案再 `-lc`（profile 里 `exec tmux` 之类会让交互式 shell 答不出）；`$SHELL` 不是绝对路径时用 `/bin/sh`。子进程自成进程组、不接终端、标准输入为空，带 `QMO_SHELL_PROBE=1` 让 profile 认得出；它让 `/bin/sh` 的 `printf` 打出导出的 PATH 与 agent 的目录变量（NUL 分隔、前后两个标记夹住，profile 打印的别的东西不影响），nushell 前面加 `^`。最多等 2 秒（`--rescan` 等 5 秒），到时杀掉整个进程组。agent 的目录变量（上表各列与 nvm、fnm、bun、Volta、pnpm、npm 前缀的变量）本进程没有时取登录 shell 的。
3. 常见用户目录：`~/.local/bin`、npm 前缀（`NPM_CONFIG_PREFIX`）与 `~/.npm-global/bin`、bun（`BUN_INSTALL`）、Volta（`VOLTA_HOME`）、pnpm（`PNPM_HOME`，否则 macOS `~/Library/pnpm`、Linux `~/.local/share/pnpm`）、asdf 与 mise 的 shims、nvm（`NVM_DIR`）/ fnm（`FNM_DIR`）/ mise 装的每个 Node（新版本在前）、cargo、deno。
4. 系统目录：macOS `/opt/homebrew/bin`、`/usr/local/bin`；Linux `/usr/local/bin`、`/home/linuxbrew/.linuxbrew/bin`。

Windows：PATH（变量名不分大小写）里按 `PATHEXT`（缺省 `.COM;.EXE;.BAT;.CMD`）补扩展名找；常见目录 `%APPDATA%\npm`、`~\.local\bin`、`~\.bun\bin`、Volta、pnpm、`~\scoop\shims`、cargo、deno；厂商位置加 `.exe`。不问登录 shell，不查桌面 App，**注册表里的 PATH 本版不读**（PATH 比注册表旧时会漏掉刚装的程序）。

**版本**：

- 先读 npm 包：从程序的真实路径往上找到 `node_modules/<包>`，包名须是该 agent 的官方包，读 `package.json` 的 `version`，不运行程序。Windows 上 npm 装的是 `.cmd` 垫片，读垫片里写的包路径再读同一个 `package.json`。
- 否则运行 `<程序> --version`：标准输入为空，`NO_COLOR=1`，在系统临时目录里起（dsh 会读启动目录的 `.env`），PATH 用上面的查找目录（`#!/usr/bin/env node` 的程序要找得到 Node），10 秒超时；取标准输出与标准错误里第一个版本号。

**缓存与刷新**（`<客户端目录>/agents.json`，客户端目录按 `clientStateDir()`；0600、原子写）：

- `--version` 的结果与 dsh 判别的结果按「真实路径 + 大小 + 修改时间」记：成功留 24 小时，失败（含超时）留 10 分钟；程序文件变了立即重问。npm 包的版本每次现读。
- 登录 shell 的回答（含没答上）留 10 分钟，按 `$SHELL` 区分。
- `qmo agents --rescan` 不用缓存，全部重问，结果重写进缓存。缓存损坏、不属于本人、权限过宽或是链接时当作没有，扫完原子替换。客户端目录本身不是本人独占（不是 0700、不属于当前用户）时不写缓存，也不替用户改权限，每次都重新问；扫描结果照常输出。退出登录不删它：它是这台电脑的事实，与账号无关。
- 同一次扫描里每个命令只查一次。magpie 把 PATH 查找结果在进程内留 2 秒，`qmo` 每次是新进程，这一层没有意义，不做。

**输出**：`qmo agents --json` 标准输出一行 `{"agents":[…]}`，每项是 §4.2 表的字段；用法错误是 `{"error":{"kind":"usage","message":…}}`、退出码 2（与 `qmo` 其他 `--json` 命令同一约定）。不带 `--json` 时每个 agent 一行：名称、版本、可用与否（不可用写原因）、路径。

**与 magpie 的异同**：

- 相同：注册表写死在代码里；判定顺序（自定义、被文件占、配置文件、去掉残留的配置目录、额外信号、PATH）；残留目录名与共用目录的处理；Gemini CLI 只认命令；向登录 shell 要 PATH 的做法（`-ilc` 再 `-lc`、自成会话、最多等 2 秒）；版本先读 npm 包、再跑 `--version`（10 秒）；成功 24 小时、失败 10 分钟。
- 不同：
  - 不读任何 agent 的凭据与登录状态（magpie 读 `.claude.json`、Keychain、`auth.json` 等判断是否登录），不写 agent 的配置（magpie 会改写它们接网关）。
  - 不读 `~/.npmrc` 找 npm 前缀（里面可能有 npm 令牌），改看 `NPM_CONFIG_PREFIX`、常见目录与登录 shell 的 PATH。
  - 不读程序的二进制内容（magpie 读 Go 构建信息分辨 pressly 的 goose），Goose 只认 Homebrew `block-goose-cli` 与厂商位置。
  - nvm 不读 `alias/default`，列出每个 Node 版本目录（新的在前）。
  - 登录 shell 的 PATH 排在常见目录之前（magpie 在后），找到的是终端里会先找到的那一个。
  - 厂商安装位置算识别证据（magpie 只用它判断「CLI 未找到」）；不查 IDE 扩展、编辑器、Codex 桌面 App 这类「还有别的程序在用这个目录」的信号（magpie 的 `cliHeld`），我们要的是能驱动的命令行程序。
  - dsh 判别是我们节点的规则（magpie 没有），同名的多个候选逐个判别，官方 npm 包里的程序不用问；读 npm 包版本时核对包名。
  - 只收底层目录的六项与五个常见的不能驱动的 agent（magpie 有几十个）；不识别 WSL 里的 agent。

### 4.3 本机运行器

本机节点由随包的 `qmo` 实现：子命令 `qmo code serve`（下称运行器）是壳的常驻子进程，按会话起本机 agent、经各自的原生协议驱动、存会话、算变更。桌面版不另带 `qm`。三种协议的驱动从节点代码里抽成本机与常驻共用的包 `@qianmo/harness`（§4.3.3）。

**本机 agent 用这台电脑上用户自己的登录与配置**：子进程按用户在终端里运行它的方式启动（同一个 HOME、同一套配置与登录），这是用户自己的程序在自己的电脑上跑。阡陌的代码不读、不复制、不改它们的凭据与配置目录，不转发它们的模型流量，不转售额度。这是章程 v3.16 §2.13 第 3 条对 L-6 的限定例外，只适用于桌面版的本机会话；服务器上的节点照旧只用 API key 与网关密钥。

#### 4.3.1 为什么不带 `qm`

2026-10-24 在本机（macOS arm64）量的数。只量文件、跑我们自己的两个程序的 `--version`，没有启动任何 agent：

| 项 | 数 |
|---|---|
| `dist/qm-darwin-arm64`（10-21 构建，`fe040d7b`） | 236,910,688 字节；`gzip -6` 后 109,707,009 |
| 其中 omp 原生插件 `pi_natives.darwin-arm64.node` | 120,058,848 字节；以 zstd 帧嵌入，第一次起 omp 时解到 `<配置根>/omp/natives` |
| Bun 1.4.3 运行时 | 70,469,776 字节，`qm` 与 `qmo` 各带一份 |
| `dist/qmo-darwin-arm64`（10-23 构建） | 70,895,474 字节；`gzip -6` 后 30,944,197 |
| v3.1.1 发行的 `Qmo-0.1.0-macos-arm64.dmg` | 36,473,670 字节（`Qmo.app` 约 73 MB，`qmo` 占 71 MB） |
| `qm --version` | 冷启动 1.70 s，之后 0.03 s；最大常驻内存约 71 MB |
| `qmo --version` | 0.02–0.06 s；最大常驻内存约 16.5 MB |
| 常驻 `qm`（10-11 在 p3 上实测，Linux） | 本体 125–142 MB，每个 omp 子进程 225–270 MB |

| 方案 | 取舍 | 理由 |
|---|---|---|
| A. 把完整 `qm` 当第二个 sidecar | 不用 | 安装包从约 36 MB 涨到约 146 MB（按 `gzip -6` 估），装好后约 310 MB，第一次起 omp 再解出 120 MB；空转上百 MB 内存。它是为中枢签名任务、信箱、名册、控制链路设计的常驻节点，外部底层的通道一律钉住网关凭据与隔离的配置目录，正好与「用户自己的登录」相反，要在多层加本机分支；页面要够到它还得开回环端口加认证。唯一多得的是本机 qianmopi，而 qianmopi 在桌面上没有用户自己的登录可用，要另配模型密钥 |
| B. 在 Rust 壳里写三种驱动 | 不用 | 协议、登录 shell 环境、识别逻辑都要用 Rust 再写一遍，节点里已有、已测的 TypeScript 用不上 |
| C. 第三方适配（Claude Agent SDK、`claude-agent-acp`、`codex-acp`） | 不用 | 不是原生接口，前者还要随包带专有 SDK（与 `harness-backends.md` §1.3 同一理由） |
| D. 每个操作起一次 `qmo`（像 `qmo agents`） | 不用 | 流式会话要常驻进程 |
| E. 运行器开回环 HTTP，页面直接连 | 不用 | 中枢页面的 CSP 是 `connect-src 'self'`；回环端口对这台电脑上的别的进程、别的用户都可达 |
| **F. `qmo code serve` + `@qianmo/harness`** | **采用** | 安装包几乎不变（多几百 KB 脚本）；运行器与设备令牌在同一个程序里，P37.15 的链路不用回环；协议代码与常驻节点共用一份 |

代价：桌面版的本机会话没有 qianmopi，`qmo agents` 从 P37.14a 起不再列它（§4.2）；协议代码要先从节点里搬出来（§4.3.3）。以后若要本机 qianmopi，作为可选下载的组件另立包，不进安装包。

#### 4.3.2 进程

| 项 | 做法 |
|---|---|
| 起 | 页面第一次调运行器的命令（§4.5.1）时，壳起 `qmo code serve`（就是 `binaries/qmo`，与 `qmo agents` 同一个程序）并等它的 `hello`，至多 2 s。标准输入输出上一行一个 JSON：请求 `{id, method, params}`、应答 `{id, result}` 或 `{id, error:{code, message}}`、事件 `{method:'event', params}`。标准输出上只有协议，日志走标准错误，壳把最后 64 KiB 写进 `<客户端目录>/code/runner.log`，只记起停与错误，不记消息正文 |
| 方法 | 与页面命令一一对应：`list`、`folders.add`（只在原生选择框之后由壳调）、`folders.forget`、`session.start`、`session.send`、`session.stop`、`session.answer`、`session.mode`、`session.read`、`session.changes`、`session.diff`、`session.rename`、`session.delete`、`session.remote`，另有 `hello`、`shutdown`。参数与答复就是 §4.5.1 的形状；事件就是 §4.5.2 的形状，壳只校验、不改写，原样转给页面 |
| 单实例 | `<客户端目录>/code/runner.lock`（pid 与启动时间；持有者不在了就接管） |
| 崩溃 | 壳按 1、2、5、10、30 秒退避重起；在途的命令以 `qmo local E_RUNNER` 拒绝，页面经事件通道收到 `{type:'runner'}`。重起后，上次在跑的会话标「已中断」，下一句话照常续接。运行器把 agent 子进程的 pid 与启动时间记在 `code/children.json`，重起时只结束 pid、启动时间与程序路径都对得上的残留 |
| 退出 | 退出 Qmo 时壳发 `shutdown`：运行器中止各会话的回合、按「拒绝」答掉未答的征询、写完记录，3 s 内退出；5 s 不退壳就结束它。壳没了（标准输入读到结尾）运行器同样收尾退出。关主窗口只是隐藏，会话照跑 |
| agent 进程 | 每个活着的会话一个 agent 子进程，自成进程组。回合之间保持（缓存是热的），空闲 10 分钟回收；同时至多 4 个，满了先回收最久没动的空闲进程，都在跑时新的一轮排队并写明原因。回收后下一句话按原生会话号续接（§4.3.5）。中止先走原生方式，5 s 不停再对进程组发 SIGTERM，3 s 后 SIGKILL；Windows 用 `taskkill /T` |
| 内存 | 运行器自身是一个 Bun 进程（`--version` 约 16.5 MB，带会话缓存估计几十 MB）；agent 的内存是它们自己的 |

#### 4.3.3 共用协议包 `@qianmo/harness`

节点 `host/runtimes/` 里的进程管线基类（`channel.ts`）与三个通道类（`claudeCode.ts`、`codex.ts`、`acp.ts`），对 `@qianmo/resident` 只有 `import type`（编译后擦除），值依赖止于底层目录（`catalog.ts` → `gemini.ts` → 节点的 `providers/store.ts`）与零依赖的 `@qianmo/providers`，不碰 omp 与中枢。但它们在 `@qianmo/node` 里，而客户端只依赖 `@qianmo/paths`，`build-client.ts` 写明不碰 omp 的树，客户端不能依赖节点包。所以：

- 新包 `atlas/packages/harness`（`@qianmo/harness`，零运行时依赖）：`process.ts`（`RuntimeChannelBase`、`toolArgs`、`nonNegative`、`RuntimeUsage`；帧类型自己定义为 `{type: string} & Record<string, unknown>`，与 `OmpRpcFrame` 结构相同）、`claudeStream.ts`（`ClaudeCodeChannel`、`claudeCodeToolName`）、`codexRpc.ts`（`CodexChannel`）、`acpClient.ts`（`AcpChannel`、`AcpRpcError`、`acpSessionGone`）。
- 只搬类与它们的线协议辅助函数；启动参数、钉住层、网关凭据、宿主工具桥、底层目录留在节点。节点的 import 改指新包，不留转发文件。
- 搬家不改常驻的行为（节点两组测试与 `qm` 构建冒烟照旧）。本机要的能力都是可选附加项，常驻不传就与今天逐字节相同：

| 附加项 | 内容 |
|---|---|
| `onDetail(detail)` | 正文增量 `text-delta`、思考 `thinking`（只给等待行用）、工具的输入与结果 `tool`（输出、文件差异）、agent 自报的模式变化 `mode` |
| `ask(request)` → `'once'` \| `'session'` \| `'deny'` | 取代 `permission → boolean`，多一个「本会话都允许」；常驻的适配把 `true` / `false` 映射成 `once` / `deny` |
| Claude Code | 解析 `stream_event`、`control_request`（`can_use_tool`）、`control_response`；`setPermissionMode(mode)`（发 `set_permission_mode`）；工具结果的文字 |
| Codex | 线程参数由调用方给（常驻把现在的 `#nativeState` 与 `codexThreadConfig` 作为参数传入）；`prompt` 可带本轮的 `approvalPolicy`、`sandboxPolicy`；处理 `item/agentMessage/delta`、`item/commandExecution/outputDelta`、`turn/diff/updated`。P37.14b 实现：`ask` 取代 `permission`（`once` / `session` / `deny` → `accept` / `acceptForSession` / `decline`；命令的 `availableDecisions` 里没有 `acceptForSession` 时不给 `session`；MCP 征询与旧版请求只有允许一次与拒绝），征询带一个 `signal`，`serverRequest/resolved`、这一轮结束、进程没了时中止；常驻的适配把节点的允许与否映射成 `once` / `deny`，线上逐字不变 |
| ACP | `setMode(id)`（`session/set_mode`）与 `session/new` 答复里的 `modes`；`agent_message_chunk` 的文字随增量交出；`tool_call` 的 `content`（文字与 `diff`）；征询可选 agent 给的会话级 `allow_always`；进度行的工具名由调用方给的函数算（常驻传 `acpVerdictCalls` 那一套） |

#### 4.3.4 怎么起本机 agent

- **程序**：运行器自己的 `qmo agents` 扫描结果里那一项的 `path`（要 `available: true`，`protocol` 是本版支持的）。页面只给 agent 的 id，给不了路径或命令。
- **工作目录**：会话的文件夹，开了工作树时是工作树里对应的子目录（§4.3.7）。
- **环境**：运行器自己的环境，加上登录 shell 导出的完整环境（问法同 §4.2.1，打印 `env -0`；只在内存里留 10 分钟，不落盘、不进日志）；去掉阡陌与壳自己的变量（`QMO_*`、`QIANMO_*`、`TAURI_*`、`__CFBundleIdentifier`、`XPC_SERVICE_NAME`）和会让 agent 以为自己被嵌套的 `CLAUDECODE`、`CLAUDE_CODE_ENTRYPOINT`。不设 `CLAUDE_CONFIG_DIR`、`CODEX_HOME`、`GEMINI_CLI_HOME` 这类目录变量，不加任何网关地址或密钥。Windows 不问登录 shell（同 §4.2.1）；npm 装的按垫片里写的包路径直接用 `node` 起，不经 `cmd /c`。
- **参数**：只加驱动协议与权限必需的，不加 `--settings`、`--setting-sources`、`--mcp-config`、`-c` 覆盖、补丁文件。用户自己的设置、项目里的 `CLAUDE.md` / `AGENTS.md`、钩子、MCP 服务与插件照常加载，和终端里一样。

| agent | 起法 |
|---|---|
| Claude Code | `claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages --permission-prompt-tool stdio --permission-mode <§4.4> --session-id <uuid>`，续接把 `--session-id` 换成 `--resume`；跳过权限确认时另加 `--allow-dangerously-skip-permissions` |
| Codex | `codex app-server`；`thread/start {cwd, approvalPolicy, sandbox}`，续接 `thread/resume {threadId}` |
| Gemini CLI、Qwen Code、opencode、dsh | 底层目录里的 ACP 起法（`gemini --acp`、`qwen --acp`、`opencode acp`、`dsh --profile acp`）去掉常驻专有的部分（`--auth-type`、`--patch`、`--admin-policy`、`--allowed-mcp-server-names`）；`session/new {cwd, mcpServers: []}`，MCP 服务用 agent 自己配的 |

- **不做**：不调 ACP 的 `authenticate`、不跑任何登录命令；agent 没登录时把它自己的错误原样给出，后面加一句「在终端里运行 `<命令>` 登录后再试」。不读 agent 自己写的会话文件（`~/.claude/projects`、`~/.codex/sessions` 等），页面显示的是运行器自己的记录（§4.3.6）。agent 直接连它自己的服务商。
- Claude Code 2.1.310 的静态字符串里（读文件、没有运行）有：权限模式 `default` / `acceptEdits` / `plan` / `auto` / `dontAsk` / `bypassPermissions`，`auto` 有开通开关（未开通时 `set_permission_mode` 答「gate not enabled」），`bypassPermissions` 要 `--allow-dangerously-skip-permissions`；`--include-partial-messages` 要求 `--print` 与流式 JSON 输出；`can_use_tool` 征询带 `tool_name`、`input`、`tool_use_id`、`permission_suggestions`、`blocked_path`、`description`。Codex 0.164.0 有 `item/agentMessage/delta`、`turn/diff/updated`、`acceptForSession`，`turn/start` 收 `approvalPolicy` 与 `sandboxPolicy`。Gemini CLI 0.64.0 的 ACP 模式是 `default` / `autoEdit` / `yolo`（另有 `plan`），征询里「本会话都允许」与「以后都允许（写进它的设置）」都是 `allow_always`。这些都是实现前的依据，不是实测；Qwen Code、opencode、dsh 的命令行这台电脑上没有，它们的模式名在实现时按 `session/new` 的答复核对。

#### 4.3.5 三种协议怎么映射

记录与事件的名字见 §4.3.6、§4.5.2。

| 运行器 | Claude Code（stream-json） | Codex（app-server） | ACP |
|---|---|---|---|
| 发一句 | 标准输入写 `{type:'user', message}` | `turn/start {threadId, input, approvalPolicy?, sandboxPolicy?}` | `session/prompt` |
| 正文增量 | `stream_event` 的 `content_block_delta`（`text_delta`） | `item/agentMessage/delta` | `agent_message_chunk` |
| 正文一条 | `assistant` 消息的文字块 | `item/completed`（`agentMessage`） | 下一个工具调用或回合结束时把累积的文字收成一条 |
| 思考 | `thinking` 块，只进等待行 | 推理摘要增量，只进等待行 | `agent_thought_chunk`，只进等待行 |
| 工具开始 / 结束 | `assistant` 里的 `tool_use` / `user` 里的 `tool_result`（`is_error`） | `item/started` / `item/completed`（`commandExecution`、`fileChange`、`mcpToolCall`、`webSearch`） | `tool_call` / `tool_call_update`（`completed`、`failed`） |
| 文件差异 | `Edit`、`MultiEdit` 的新旧文字，`Write` 的全文 | `fileChange` 的 `changes[].diff`；整轮的 `turn/diff/updated` | `tool_call` 内容里的 `diff`（新旧文字） |
| 征询 | `control_request`（`can_use_tool`）→ `control_response` 的 `allow` / `deny` | `item/commandExecution/requestApproval`、`item/fileChange/requestApproval` → `accept` / `acceptForSession` / `decline` | `session/request_permission` → 所选项的 `optionId` |
| 一轮结束 | `result`（`is_error`、`subtype`） | `turn/completed`（`completed` / `interrupted` / 失败） | `session/prompt` 的 `stopReason` |
| 中止 | `control_request`（`interrupt`） | `turn/interrupt` | `session/cancel` |
| 续接 | `--resume <uuid>`（同一个工作目录） | `thread/resume` | 有 `session/resume` 用它，否则 `session/load`（Gemini CLI 等回放停下再发） |
| 改模式 | `set_permission_mode`，立即生效 | 下一轮的 `turn/start` 带新值 | 有对应模式时 `session/set_mode`，立即生效；没有时运行器换答法（§4.4） |

- **一次一轮**：在跑时再发的话进运行器的队列（每会话至多 5 条），本轮结束后按顺序发；页面上标「排队中」。中止时队列里的一并撤下，留在记录里标「未发出」。
- **斜杠命令**：原文当一句话发给 agent，各 agent 自己认不认；运行器不解释。
- **用量**：不显示。订阅登录下 token 数与金额没有意义，用 API key 的人在 agent 里用它自己的命令看。

#### 4.3.6 会话怎么存

位置在 `<客户端目录>/code/`（`clientStateDir()`，macOS 是 `~/Library/Application Support/Qmo/code/`），目录 0700，文件 0600，JSON 文件原子写：

| 路径 | 内容 |
|---|---|
| `folders.json` | 选过的文件夹：`{id, path, name, pickedAt}`，至多 20 个，id 是 16 位十六进制随机数 |
| `sessions/<id>/session.json` | 会话抬头：`id`、`title`、`createdAt`、`updatedAt`、`folder {path, name}`、`root`（agent 的工作目录）、`worktree? {path, branch, base, repo}`、`agent {id, name, protocol, version}`、`mode`、`state`、`lastSeq`、`native {kind, id, started}`（Claude Code 会话号、Codex 线程号、ACP 会话号）、`remote {on: false, pushedSeq: 0}`（P37.15 用） |
| `sessions/<id>/events.ndjson` | 对话记录，只追加 |
| `sessions/<id>/turn-diff.json` | Codex 最近一次 `turn/diff/updated` 的整轮差异（`{v, at, truncated, diff}`，至多 1 MiB，按行截断），只给不是 Git 仓库时的变更面板用（§4.3.7）；P37.14b |
| `worktrees/` | 运行器建的工作树（§4.3.7） |
| `runner.lock`、`children.json`、`runner.log` | §4.3.2 |

会话 id 是 `cs_` 加 22 位 base64url。`events.ndjson` 与中枢对话存储（`consoleChatStore.ts`）同一种信封，多一个 `seq`：

```
{"kind":"session","seq":0,"session":{"id":"cs_…","target":"local","node":"local","agent":"Claude Code","createdAt":…}}
{"kind":"turn","seq":1,"turn":{"id":"t_…","sessionId":"cs_…","author":"operator","at":…,"text":"…","state":"read","clientId":"…"}}
{"kind":"turn","seq":7,"turn":{"id":"t_…","sessionId":"cs_…","author":"agent","at":…,"text":"编辑 src/app.ts","state":"done","variant":"notice","noticeSource":"step","severity":"info","detail":"@@ -1,3 +1,4 @@ …","tool":{…}}}
```

- 每条 `turn` 都是一个合格的 `ChatTurn`（`console/src/deps.ts`），本机专有的放在三个附加字段里：`tool`（`{id, name, status: 'running' | 'done' | 'failed' | 'denied', paths?, command?, detailKind: 'output' | 'diff', added?, removed?, approvedBy?: 'mode' | 'user' | 'session'}`）、`ask`（§4.4）、`clientId`（页面先画的那一行的号）。中枢的 `ChatStore` 读这个文件时附加字段被丢掉，`seq` 不认，其余与前台的会话一模一样：人的一句是 `operator`；agent 的正文是 `agent` 的 `message`；工具与征询是 `variant: 'notice'` 的过程行，`text` 是一行摘要，`detail` 是输出或差异。P37.15 原样推上去，中枢用现有的转录画法画（§4.5.6）。
- 同一个 `turn.id` 会被重写（工具从 `running` 到 `done`、征询从未答到已答），读时同一 id 取最后一条、位置取第一次出现，与 `ChatStore` 相同。`seq` 每会话单调递增，每写一行加一。
- 正文增量不落盘：一条正文在 agent 说完时整条写一次；运行器在内存里留着正在流的那一条（`qmo_local_read` 的 `live`），进程中途没了这一条就没了，原生会话里仍有，续接不受影响。
- 上限：人的一句至多 65,536 个字符；正文一条至多 256 KiB（超出截断并标明）；`detail` 至多 16 KiB（输出留尾部，差异留头部）；一个会话的记录文件到 64 MiB 后会话只读，提示开新会话。
- 删除会话（P37.14d）删掉这个目录；agent 自己的会话文件不动（那是 agent 的）。退出登录不删：本机会话是这台电脑的，与账号无关。

#### 4.3.7 工作树与变更

| 项 | 做法 |
|---|---|
| 工作树 | 新会话可选「独立工作树」（文件夹在 Git 仓库里才可选）。运行器在仓库根上 `git worktree add -b qmo/<日期>-<短名> <路径> HEAD`，路径在 `<客户端目录>/code/worktrees/<仓库名>-<8 位哈希>/<会话 id>`；选的文件夹若是仓库里的子目录，agent 的工作目录是工作树里的同一子目录。底是选时的 `HEAD`：主检出里没提交的改动不带过去，选项旁写明 |
| 不放在哪 | 不放进用户的仓库（`<仓库>/.claude/worktrees` 是 Claude Code 的项目配置目录，阡陌不写；也会让 `git status` 多出未跟踪目录），不放在仓库旁边 |
| 删会话 | 工作树干净时 `git worktree remove`，分支留着（上面有 agent 的提交）；不干净就留下并写明路径。从不 `--force` |
| 变更 | 文件夹会话：工作区相对 `HEAD`（没提交的改动，含未跟踪文件）；工作树会话：相对建树时的底（含 agent 的提交）。`git --no-optional-locks status --porcelain=v2 -z --untracked-files=all` 加 `git diff --numstat -z <底>` 列文件；点开一个文件 `git diff --no-color --no-ext-diff --no-textconv -U3 <底> -- <路径>`，未跟踪的用 `git diff --no-index -- /dev/null <路径>` |
| 不是 Git 仓库 | 列这个会话的工具记录里改过的文件，差异取记录里的（不读磁盘）。P37.14b 先做了 Codex 那一份：有 `turn-diff.json` 时按它答（`source: 'session'`，文件取差异头里的路径，绝对路径在会话根里的改成相对、在根外的不列），页面照 Git 的画法列出并写「最近一轮的改动（不是 Git 仓库）」；它只是最近一轮，不是会话以来的全部，其余由 P37.14d 补 |
| 刷新 | 一个编辑或命令类工具结束后 1 s 内刷一次，另有手动刷新 |
| 边界 | 只读：不暂存、不提交、不还原（以后要做的「撤销改动」另立包）。git 用登录 shell 的 PATH 找；环境 `GIT_TERMINAL_PROMPT=0`、`GIT_OPTIONAL_LOCKS=0`、`LC_ALL=C`；每条 10 s 超时；至多列 1000 个文件，一个文件的差异至多 256 KiB，二进制文件只给统计。路径参数一律放在 `--` 之后，先过 §4.5.3 的检查。`worktree add` 会照常触发仓库自己的 `post-checkout` 钩子（与用户在终端里运行同一条命令一样）；`status` 与 `diff` 不触发钩子 |

### 4.4 权限

本机会话的权限模式沿用四档，缺省「自动审批」（负责人 10-24「自动审批是默认最佳权限模式」，`elevation.md` §8.1）。每档用 agent 自己的权限设置表达；agent 没有对应档时由运行器按档回答它的征询。运行器自己从不放行 shell 命令，除非在「跳过权限确认」下。

| 档 | Claude Code `--permission-mode` | Codex `approvalPolicy` · `sandbox` | Gemini CLI / Qwen Code 的 ACP 模式 | opencode、dsh |
|---|---|---|---|---|
| 人工确认 `off` | `default` | `untrusted` · `workspace-write` | `default` | 它问的都交给人 |
| 自动接受编辑 `accept-edits` | `acceptEdits` | `untrusted` · `workspace-write`；文件改动的征询（路径都在会话根里）由运行器直接答 `accept` | `autoEdit` / `auto-edit` | 编辑类、路径都在会话根里的由运行器答允许，其余交给人 |
| **自动审批 `auto`（缺省）** | `auto`；这个账号没开通（以 `auto` 启动即报错、`init` 报的模式不是 `auto`，或切换被拒）时退到 `acceptEdits`，会话里写「这个 Claude Code 没有自动模式，命令仍会问你」 | `on-request` · `workspace-write`（它自己的「Auto」：命令在它的沙箱里跑，要越界时才问） | 同「自动接受编辑」：它们在编辑与 `yolo` 之间没有带安全网的档，命令照问 | 同「自动接受编辑」；dsh 在它自己的沙箱里本来不问 |
| 跳过权限确认 `full-access` | `bypassPermissions`（启动带 `--allow-dangerously-skip-permissions`） | `never` · `danger-full-access` | `yolo` | 运行器全部答允许 |

- **选「跳过权限确认」要再确认一次**：页面上就地出一行「agent 将不经确认执行任何命令与改动 · 确认 / 取消」，不弹窗。
- **改档**：Claude Code 用 `set_permission_mode` 立即改；改到 `bypassPermissions` 而进程启动时没带 `--allow-dangerously-skip-permissions` 的，在下一轮开始前按原会话号带上它重起。Codex 下一轮生效。Gemini、Qwen 用 `session/set_mode` 立即改。页面按命令的答复写「已生效」或「下一轮生效」，被拒时退回原值并写原因（§3.3 的规矩）。
- **Codex 的细节**（P37.14b）：线程按档开（`thread/start` / `thread/resume` 的 `approvalPolicy`、`sandbox`，人工确认与自动接受编辑另带 `approvalsReviewer: 'user'`，征询不交给 Codex 自己的审查 agent）。进程在跑时改档答 `next-turn`：下一轮的 `turn/start` 带新的 `approvalPolicy`，改到跳过权限确认另带 `sandboxPolicy: {type: 'dangerFullAccess'}`，只要与开线程时不同就每轮都带（Codex 是否把本轮的值留给以后各轮都不影响）。两种改法本轮的值说不清，下一轮前在原线程上重起进程：转进要人确认的档而进程开线程时没带 `approvalsReviewer`；从完全访问回到 workspace 沙箱（`turn/start` 只能给一个缺省的 `workspaceWrite`，会盖掉用户自己 `sandbox_workspace_write` 里的可写目录与联网设置，`thread/resume` 带 `sandbox` 则照用户的设置）。没有进程时答 `now`，下一个进程按新档开线程。自动接受编辑由运行器答的只有文件改动：这一项的 `fileChange` 条目先到（app-server 在征询前发 `item/started`），列出的文件与它要的 `grantRoot` 解开链接后都在会话根里才答 `accept`，条目没见到、有一个在根外都交给人；命令一律交给人。跳过权限确认下 Codex 不问（`never`），万一仍来的征询运行器答 `accept`。Codex 的 `decline` 收不了附言，拒绝时写的那句话只留在本机记录里。
- **征询卡片**：在转录里，对应那条工具行的位置。写 agent 给的说明（Claude Code 的 `description` 或工具名加摘要、Codex 的命令与理由、ACP 的 `title`）和涉及的路径；三个按钮「允许一次」「本会话都允许」「拒绝」（拒绝可附一句话，交回给 agent）。`Enter` 不默认批准，焦点放在「允许一次」上，要按空格或点击。
- **本会话都允许**只用会话级的原生选项：Claude Code 把 `permission_suggestions` 原样带回，但每条的 `destination` 一律改成 `session`；Codex 答 `acceptForSession`；ACP 只在 agent 给的 `allow_always` 选项里能认出会话级的那一个时才提供（Gemini CLI 是 `proceed_always`），认不出就只给另两个。从不选会写进 agent 设置的「以后都允许」（Gemini 的 `proceed_always_and_save`、Claude Code 的 `localSettings` / `userSettings`、Codex 的 `acceptWithExecpolicyAmendment`）：要长期放行，人在 agent 自己的界面里设。
- **记录**：征询是一条过程行，`ask` 为 `{id, tool, title, paths?, input?（摘要，至多 2 KiB）, options, decision?, by?: 'user' | 'stop' | 'shutdown', at?}`，答了就重写这一条。运行器按档自动答掉的不单独记，只在那条工具行上记 `approvedBy: 'mode'`。
- 征询不超时，agent 等着；中止本轮、退出 Qmo 时按「拒绝」答掉。窗口不在前面时由壳发系统通知（P37.14d）。
- 不走中枢的审批队列：本机会话的主人就是坐在电脑前的人。命令执行仍由 agent 自己的沙箱与权限机制把关；运行器不另加沙箱。

### 4.5 页面、壳与运行器之间（原 P37.16「本机直连」）

页面不经中枢驱动本机会话：经壳的 `qmo_local_*` 命令与一条事件通道直达运行器。这是本机会话唯一的路，P37.14a 起就是，所以原 P37.16 并入 P37.14a。

```
中枢源的 Code 页 ──invoke──▶ 壳（逐项校验）──标准输入──▶ qmo code serve ──▶ agent 子进程
       ▲                         │                          │
       └──── Channel（有序）◀────┴──────── 标准输出（事件）◀─┘
```

#### 4.5.1 命令

全部只给中枢源（remote 能力：`HUB_PERMISSIONS` 与 `build.rs` 的命令表加上这些命令，本地页面的 `capabilities/local.json` 不加），命令里再核一次调用方页面与登录的中枢同源（`ipc::from_hub`），并且只收主窗口（快速输入窗调用一律拒绝）；参数在 `ipc.rs` 里逐项校验，多键、类型不对、超长、越界整次拒绝。运行器收到后再核一遍。

| 命令 | 参数 | 答复 | 说明 |
|---|---|---|---|
| `qmo_local_list` | 无 | `{v: 1, features: {protocols, worktree, remote}, folders: [Folder], sessions: [Summary], link: {state, reason?}}` | 打开 Code 面先调；也是能力探测：`protocols` 列本版能驱动的协议（P37.14a 只有 `claude-stream`，P37.14b 加 `codex-app-server`），其余 agent 在选择里写「后续版本支持」 |
| `qmo_local_watch` | `channel`：`window.__TAURI__.core.Channel` | `{}` | 登记本页的事件通道（§4.5.2）；再调就换掉旧的 |
| `qmo_local_pick_folder` | 无 | `Folder` 或 `null`（取消了） | 壳弹系统的文件夹选择框，把选中的路径交给运行器的 `folders.add`；这是路径进入系统的唯一入口 |
| `qmo_local_forget_folder` | `folder` | `{}` | 从最近列表去掉；不碰磁盘，已有会话照旧能开 |
| `qmo_local_start` | `folder`、`agent`、`mode`、`worktree`、`text`、`clientId`；`remote?`（缺省 `false`） | `{session: Summary, turn}` | 开会话就是发第一句；`remote: true` 从第一句起同步（§5.0），这台电脑没登录时 `E_REMOTE` |
| `qmo_local_send` | `session`、`text`、`clientId` | `{turn, queued}` | 在跑时进队列（§4.3.5） |
| `qmo_local_stop` | `session` | `{}` | 中止本轮，撤下队列 |
| `qmo_local_answer` | `session`、`ask`、`decision`（`once` \| `session` \| `deny`）、`message?` | `{}` | 已答过或已失效的拒绝 `E_ASK` |
| `qmo_local_set_mode` | `session`、`mode` | `{mode, applies: 'now' \| 'next-turn'}` | §4.4 |
| `qmo_local_read` | `session`、`before?`（seq）、`limit?`（1–200，缺省 100） | `{session: Summary, records: [Record], more, lastSeq, live?: {turn, text}}` | 从新往旧翻页；`live` 是正在流的那一条已到的文字 |
| `qmo_local_changes` | `session` | `{source: 'git' \| 'session', base?, files: [{path, status, added, removed, binary}], truncated}` | §4.3.7 |
| `qmo_local_diff` | `session`、`path` | `{path, text, truncated, binary}` | 一个文件的统一格式差异 |
| `qmo_local_rename` | `session`、`title` | `{}` | P37.14d |
| `qmo_local_delete` | `session` | `{worktree?: 'removed' \| 'kept'}` | P37.14d |
| `qmo_local_set_remote` | `session`、`on` | `{session: Summary}` | 运行器 `session.remote`（§5.0）；打开要这台电脑已登录中枢，否则 `E_REMOTE` |

- 类型：`Folder = {id, name, path, git}`（`path` 只供显示）；`Summary = {id, title, folder: {id | null, name}, agent: {id, name}, mode, state: 'idle' | 'running' | 'waiting' | 'interrupted' | 'failed', worktree?: {branch}, remote: boolean, createdAt, updatedAt, lastSeq}`；`Record = {seq, kind: 'turn', turn}`（§4.3.6）。
- 校验：会话 `cs_[A-Za-z0-9_-]{22}`；文件夹 `[0-9a-f]{16}`；征询 `[A-Za-z0-9_.:-]{1,128}`；`clientId` `[A-Za-z0-9_-]{1,64}`；`agent` 只收底层目录的六个 id；`mode` 只收四档的标识；`text` 1–65,536 个字符、不含 NUL；`message` 至多 500 字、`title` 至多 120 字，都不含控制字符；`path` 见 §4.5.3；`before` 正整数；`worktree`、`on` 布尔。这里的「字」一律按 UTF-16 码元计，即 JavaScript 字符串的 `length`：页面输入框的 `maxLength`、壳的 `ipc::units`、运行器的检查是同一种算法（P37.14a 合流时运行器原按 Unicode 标量计，已改；一个表情符号算两个字）。
- 约定：每条命令页面传哪些键、哪些可缺省、壳交给运行器的方法与参数，写成一份数据 `atlas/packages/console/test/browser/qmo-local-calls.json`，三方的用例都读它——壳的 `ipc.rs` 用例核对按它得出同样的调用、少一个必需键或多一个键都拒绝；页面的假壳（`console/test/browser/codeShell.ts`）按它核对页面每次调用的键与类型；编出来的 `qmo` 的用例把其中每组参数交给运行器，形状都收、多一个键都拒（`E_ARGS`）。改命令的参数要先改这份数据。
- 失败：Promise 以一行字符串拒绝，壳与运行器自己的一律以 `qmo local ` 开头：`qmo local <代码>: <说明>`，代码有 `E_ARGS`、`E_RUNNER`、`E_FOLDER`、`E_AGENT`、`E_SESSION`、`E_BUSY`、`E_LIMIT`、`E_ASK`、`E_GIT`、`E_REMOTE`。其他拒绝是 Tauri 的（壳里没有这条命令或不许这个页面调），页面当作壳早于本功能，写「更新桌面版后可开本机会话」。
- 选文件夹用 `tauri-plugin-dialog` 的 Rust 接口（在工作线程里阻塞调用）；它的 JS 命令不进任何能力，页面调不到。插件注册时套一层 `code::Quiet`，只去掉插件自带的页面脚本，其余照转：这段脚本（2.8.3 的 `init-iife.js`）会给每个页面、含中枢页面，把 `window.alert` 与 `window.confirm` 换成它的 `plugin:dialog|message` 命令，而这条命令不给任何页面，`alert` 就静默失效；`confirm` 还变成返回 Promise 的异步函数，同步写法 `if (!confirm(…)) return` 拿到的 Promise 恒为真，确认被直接跳过（后台计费页删除上游就是这样写的）。壳的用例核对注册处只有这一处、包了这一层、`Quiet` 的页面脚本为空。事件通道的取数命令（`plugin:__TAURI_CHANNEL__|fetch`）在 Tauri 2.12.5 里不经 ACL（`webview/mod.rs` 写明的特例），不用再开权限，也不开 `core:event` 一类。

#### 4.5.2 事件通道

用 Tauri 的 `Channel` 作为 `qmo_local_watch` 的参数，不用全局事件：它按发送顺序交付、只送到调用它的那个页面、不需要给中枢源开事件权限。壳为主窗口留一条通道；主窗口每次开始载入页面（`on_page_load` 的 `Started`），壳丢掉它的通道，新页面重新登记。所有会话的事件都发（只有一个人在用，量小），页面只画打开的那个会话，其余只更新侧栏的行。

| `type` | 字段 | 什么时候 |
|---|---|---|
| `session` | `session: Summary` | 新建；标题、状态、模式变了 |
| `record` | `session`、`seq`、`record`（同 `qmo_local_read`） | 每写一行记录（新写或重写） |
| `delta` | `session`、`turn`、`offset`、`text` | 正文增量；运行器每 50 ms 合并一次，一条至多 4 KiB |
| `activity` | `session`、`kind`、`words` | 思考中、在调哪个工具，给等待行用；不落盘 |
| `removed` | `session` | 会话删了 |
| `link` | `state`、`reason?` | 设备链路的状态变了（§5.1「状态」） |
| `runner` | `state: 'up' \| 'down'`、`reason?` | 运行器起停，只由壳发：`up` 在壳接受了 `hello` 的答复（协议是 1）之后，`down` 在运行器结束或没起来时（带原因，一次故障只说一次）。运行器自己不发这种事件（P37.14a 合流前两边都发 `up`，页面收到两次） |

- 每条带 `v: 1`。页面按会话记已画到的 `seq`，重复的丢掉，见到跳号就 `qmo_local_read` 补；`delta` 的 `offset` 与已画的长度对不上时不接，等这一条的 `record`。页面打开一个会话的顺序：先登记通道，再读，读到的 `lastSeq` 之前的事件丢掉。
- 体积：一条事件尽量小于 8 KiB（Tauri 在这以上改走取数命令）。`record` 的 JSON 超过 8 KiB 时只发 `{session, seq, trimmed: true}`，页面展开或画到它时再读。
- 中枢页面的 CSP（`connect-src 'self'`）挡住 Tauri 的自定义协议取数，Tauri 自动退回 `postMessage`（`ipc-protocol.js` 的回退，现有的 `qmo_*` 命令已走这条路）；每页第一次会在控制台留一条警告，不影响功能。

#### 4.5.3 路径只认选过的文件夹

- 路径只从一个地方进来：`qmo_local_pick_folder` 弹出的系统选择框。运行器把选中的路径取 `realpath`、登记进 `folders.json` 并给一个 id；页面以后只传这个 id，传不了路径。
- 选的时候拒绝：在受保护的根里或就是它们（`protectedConfigRoots()` 的 `~/.qianmo`、`~/.omp`、`~/.claude`、`~/.codex`、`~/.qmcode`，另加 `~/.gemini`、`~/.qwen`、`~/.config/opencode`、`~/.dsh` 与 `<客户端目录>`）；不是目录；读不了。选它们的上级（例如主目录）可以。
- 文件夹下级的路径只出现在 `qmo_local_diff`：相对路径，至多 1024 字符，不含 NUL 与控制字符，不以 `/` 或 `-` 开头，没有空段、`.`、`..`；运行器把它接在会话根上，存在的取 `realpath`、不存在的（删掉的文件）取上级的 `realpath`，结果必须在会话根的 `realpath` 之内（按路径段比较，Windows 不分大小写），再放进 git 命令的 `--` 之后。
- 会话只在自己的根里动：根是选的文件夹或运行器建的工作树，都记在 `session.json`；按会话 id 的操作只在这个根里。
- 文件夹被删或挪走后：开新会话答 `E_FOLDER`「文件夹不在了」，已有会话只读。
- 这只限制阡陌自己的代码（读差异、建工作树、定 agent 的工作目录）。agent 能碰什么由它自己的权限与沙箱决定（§4.4），运行器不另加一层。

#### 4.5.4 断网与版本错配

- 页面载入之后，Code 面的一切操作都只经壳：Code 的脚本不请求中枢的片段与接口，会话之间切换用 `pushState` 到 `/code?session=<id>`，不整页导航。所以中枢断了，正在跑的会话照常流式输出，新会话照样能开、能发、能看变更。
- 还要中枢的：Work 与 Code 之间切换、刷新页面、第一次打开（页面是中枢渲染的，§3.2 留下的整页导航）。中枢连不上时启动的离线打开另立 P37.16（§8）。
- 版本错配：新页面配旧壳，`qmo_local_list` 被 Tauri 拒绝，页面写「更新桌面版后可开本机会话」；旧页面配新壳，页面不调新命令，一切照旧；页面认识的协议以 `features.protocols` 为准，运行器多支持的 agent 页面照样能列。

#### 4.5.5 转录怎么画

本机会话不在中枢，不能走服务端片段；也不让任何 HTML 字符串进页面。Code 页自己用 DOM 画：

- **同一套规则**：把 `view/richText.ts` 的封闭子集（围栏代码、行内代码、一级列表、加粗、段落；不认链接、图片、表格、嵌套列表、原始 HTML；未配对的反引号与 `**` 按原文）移植成页面脚本里的一个函数，直接用 `createElement` 与 `textContent` 建节点，不先拼字符串、不转义后再插入。没有可插入的 HTML，也就没有转义顺序的问题。
- **同样的外观**：元素与类名照服务端画法（`fx-msg`、`fx-msg-user`、`fx-bubble`、`fx-msg-agent`、`fx-text`、`turn-p`、`turn-list`、`turn-code`、`fx-steps`、`fx-step`、`fx-pending`、`fx-sep`），沿用前台已有样式。新加的只有工具行里的差异块（`+` / `-` 行着色，不做语法高亮）、征询卡片、变更面板，样式进 `view/frontStyle.ts`。
- **一致性用例**：在真 Chrome 里拿同一组输入（围栏、未闭合的围栏、各种反引号与 `**`、列表、`<script>`、`&amp;`、引号、中日文、空串）分别跑服务端的 `renderRichText` 与页面的函数，两边都经同一个 `<template>` 序列化后逐字相同。另有静态用例：Code 的脚本里没有 `innerHTML`、`outerHTML`、`insertAdjacentHTML`、`document.write`、`eval`、`new Function`。
- **脚本与预算**：共享运行时 `client.ts` 已到 39,331 字符（预算 40,000，余 669），不往里放。Code 的脚本分两段：`assets/codeRender.ts`（`CODE_RENDER_JS`：富文本与记录画法，预算 14,000）、`assets/codeClient.ts`（`CODE_JS`：会话列表、地址、输入框、事件通道、变更面板，预算 34,000；P37.15 加上 Remote 的开关、链路状态、只读与浏览器里的情形后放到 37,000，现在 35,908），仍只拼进 `/code` 文档那一段内联脚本，CSP 照旧按哈希列出。P37.15 另加第三段 `assets/codeHub.ts`（`CODE_HUB_JS`，预算 7,000，现在 5,617），只在个人账号、中枢开了 Remote 时拼在最前（§5.2）。零新运行时依赖。
- **流式**：正在流的那一条先按纯文字追加，每个动画帧至多重画一次富文本；说完换成记录。只画最近 200 条，往上滚到顶再读更早的。
- **Remote 开着时别的设备**：同一套 `CODE_RENDER_JS` 画中枢上的副本，换一条路取数（§5.2，P37.15 定稿时放弃了原写的 `renderMessages`）。本机上的 Code 页始终画运行器的记录，不画这台电脑自己的副本。

#### 4.5.6 给 Remote（P37.15）留的接口

- 记录：`events.ndjson` 与中枢对话存储同形（§4.3.6），推的时候原样推；`session.json` 里的 `remote {on, pushedSeq}` 记推到哪一条，断线后从那里接着推。
- 运行器：写记录处经一个出口（`RecordSink`）；发话的方法带 `origin: 'local' | 'remote'`，P37.14 只收 `local`。P37.14a 没有留空的 `RecordSink`（一个没人传的选项只是死代码）：运行器的记录除重起时的修补外都经 `SessionManager.#write` 一处写出，P37.15 在那里接上出口，并按 `pushedSeq` 从 `events.ndjson` 补推，修补的几行也就带上了。
- 壳与页面：`qmo_local_set_remote` 与 `features.remote` 已在命令表里；`features.remote` 为 `false` 时页面不画 Remote 开关。
- 链路：在运行器这个进程里拨（它就是 `qmo`，设备令牌本来就在这里），不另开回环。
- P37.15 用上了这些接口：出口接在 `SessionManager.#write`（`RemoteSink`，`code/session.ts`），链路在 `code/link.ts`；补推的起点以中枢 `welcome` 里报的为准，`pushedSeq` 是这台电脑记下的「中枢确认到哪」（§5.3）。

### 4.6 风险与未知

| 项 | 说明 | 怎么处理 |
|---|---|---|
| Claude Code 的 `auto` 要开通 | 静态字符串里，没开通时切到 `auto` 被拒（「gate not enabled」）；以 `auto` 启动时的表现不知道 | 退到 `acceptEdits` 并在会话里写明（§4.4）；P37.14a 实测 |
| `--permission-prompt-tool stdio` 是隐藏选项 | 2.1.310 的帮助只写「MCP 工具名」，新增了 `--permission-prompts host`（由宿主回答）；`stdio` 的分支仍在代码里 | P37.14a 实测；不行就换 `--permission-prompts host`，征询仍是同一条 `can_use_tool` |
| 厂商条款 | 用用户自己的订阅登录、以无头方式跑官方 CLI 是它们文档里的用法，条款可能变 | 只用官方 CLI，不碰登录与凭据；条款变了按章程 §2.13 第 3 条重议 |
| macOS 隐私授权 | agent 碰「文稿」「桌面」「下载」时系统按 Qmo.app 弹授权；Qmo.app 是 ad-hoc 签名，更新后签名变，授权可能要重给 | 有 Developer ID（P37.9）后才稳；发行说明写明 |
| WKWebView | 中枢 CSP 让 IPC 走 `postMessage` 回退；长转录的 DOM | 事件小于 8 KiB、只画最近 200 条；P37.14a 在真壳里量 |
| Windows | 壳没在 Windows 上编过（P37.12）；npm 垫片、进程树、路径大小写都按设计写了；Bun 不给 Job Object，运行器崩了 agent 可能留下 | 整条未实测，Windows 包另行验收 |
| Linux | WebKitGTK 上「经 about:blank 进门」未验证（`qmo-app.md` §3） | 同上 |
| 协议漂移 | 三家 CLI 更新快 | 驱动只依赖 §4.3.4、§4.3.5 列出的字段，认不出的消息只当活动信号；假进程钉住形状，真机冒烟随包验收 |
| 共用包搬家 | 动到常驻节点的三种通道 | 只搬不改、附加项可选；节点两组测试、`qm` 构建冒烟与真 harness 冒烟照跑 |
| 不带 qianmopi | 本机会话没有 qianmopi | 写明；要时作为可选组件另立包 |
| Work 与 Code 之间仍整页导航 | 断网时切不过去、刷新不了 | §4.5.4 写明；P37.16 给离线入口 |

## §5 设备外连与同步（P37.15）

负责人 2026-10-24：「可以选择开启remote按钮，以实现多端消息同步」；10-25：「而且我现在remote都开不了」。P37.14a 留好了接口（§4.5.6），本节定下 P37.15 开工前要定的五件事：链路上的帧（§5.1）、中枢副本怎么存、按账号怎么隔离（§5.3）、别的设备上 Code 面怎么画（§5.2）、推之前工具行 `detail` 怎么取舍（§5.3）、macOS 编出来的 `qmo` 里 Bun 自带的 WebSocket 能不能握手、怎么验（§5.4）。放弃的做法在 §5.5。

### 5.0 Remote 开关

参照 Claude Desktop 给本机 Code 会话的 Remote Control：按会话由人选择，缺省关。

| 项 | 做法 |
|---|---|
| 在哪 | 每个本机会话标题栏右侧一个 Remote 开关，旁边写链路的状态；新会话输入框上也有一个，缺省取壳设置窗「Code」一节的「新会话开启 Remote」（缺省关，P37.14d；这是这台电脑的设置，不随账号走；P37.15 本身的页面在这一项合入前缺省关）。会话行上开着的有一个「Remote」小标。运行器的 `features.remote` 为真才画这两个开关 |
| 前提 | 这台电脑用 `qmo` 登录过一台开了个人账号的中枢（Qmo.app 本来就是）。没登录时打开被拒（`E_REMOTE`「这台电脑没有登录中枢」）；中枢不认这台设备、或中枢没有 Remote 时，开关照样开着，开关旁写链路的状态与原因（§5.1「状态」） |
| 关 | 会话只在这台电脑上：页面经 `qmo_local_*` 直达运行器（§4.5），中枢不知道它存在 |
| 开 | 运行器经设备链路（§5.1）把这个会话按 §5.3 同步到中枢；同一账号的别的设备（浏览器、手机上的网页、另一台桌面版）在 Code 列表里看到它，标明在哪台设备、是否在线；设备在线时可以续写、回答权限征询、中止，离线时只读 |
| 再关 | 立刻停止推送，别的设备发来的消息不再收；中枢上已有的副本留作只读，行上标「Remote 已关」，在别的设备上打开它时标题栏有「从中枢删除副本」 |
| 换了登录 | 会话记着它是在哪个设备号下开的 Remote（`session.json` 的 `remote.device`）。重新配对（换了中枢或账号）后，原来开着的会话不往新中枢推：运行器把它关掉，在会话里写一条过程行「Remote 是在上一次登录时开的，已关上」 |
| 链路 | 只要还有一个会话开着 Remote（或还有一个刚关的会话没把「已关」告诉中枢），链路就保持；都没有了就断开，设备在中枢上显示离线 |
| Work | Work 的对话本来就在中枢、各设备共用，没有这个开关 |
| 别处做不了的 | 从别的设备在这台电脑上新开本机会话、改权限模式、看变更面板与差异、删本机会话。续写、答征询、中止之外的事都只在这台电脑上做 |

### 5.1 设备链路

**握手。** 运行器（就是 `qmo`，设备令牌本来就在这个进程里，§4.5.6）用 Bun 自带的 `WebSocket` 拨 `wss://<中枢>/v0/client/link`（回环上的中枢是 `ws://`，与 `parseHubUrl` 同一条规矩），请求头 `Authorization: Bearer <设备令牌>`，子协议 `qmo-link.1`。中枢在升级之前逐条核对，任何一条不过都答普通的 HTTP 错误、不升级：

| 条件 | 不过时 |
|---|---|
| 这台中枢开了个人账号，接了设备账本与 Remote 副本 | 没开账号 404（与 `/v0/client/*` 相同）；开了账号、没接 Remote 副本时不升级，答 501 `unsupported` |
| 令牌放在 `Authorization` 里，地址不带查询串 | 400 |
| 设备账本认这枚令牌（`authenticate`：没吊销、属主账号在用、不是只读账号、配对之后没被重置） | 401，`code` 与 `/v0/client/*` 一致：`device_revoked`、`owner_inactive`、`unauthorized` |
| 设备是 `qmo sign-in` 配的客户端设备，属主是个人账号（`u:`） | 403 `device_kind` / `forbidden` |
| 公开版：属主有有效订阅 | 402 `subscription_required` |
| 带着 `Upgrade: websocket` 与上面的子协议 | 426 |

浏览器的 WebSocket 加不了 `Authorization`，中枢也不看 cookie，所以别的网站开不了这条链路（没有跨站 WebSocket 劫持）。只有个人账号名下、状态正常的客户端设备能主动拨号；服务器节点「中枢建链、节点零拨号」（H-2）不变。

**设备节点。** 中枢把握手成功的链路记进它自己的一张表：设备号 → 属主、建链时刻。这就是这台设备的「设备节点」：名字是设备账本里的设备名，只对它的属主可见，在线就是链路在。它**不进注册中心的名册**：运行器不服务智能体、不收信箱、不实现节点的任务协议，名册上的东西会被整个网络寻址，而一台个人电脑只该被它的主人碰到。同一台设备第二条链路握手成功时，旧的那条以 4409 关掉（换了网络之后的重连不用等旧连接超时）。

**帧。** 文本帧，一帧一个 JSON 对象，`t` 是帧名，中枢一帧至多收 1 MiB，运行器一帧记录至多 256 KiB（一条记录本身更大时单独一帧）。不认识的帧、字段不对、会话号不归这台设备的，中枢以 4400 关掉链路；运行器丢掉不认识的帧，答 `reply` 的错误。

上行（运行器 → 中枢）：

| 帧 | 字段 | 什么时候 |
|---|---|---|
| `hello` | `v: 1`、`version`（`qmo` 的版本） | 连上后第一帧 |
| `session` | `session`：`id`、`title`、`folder`（只有名字）、`agent {id, name}`、`mode`、`state`、`remote`（布尔）、`createdAt`、`updatedAt`、`lastSeq` | 开 Remote 时、开着时抬头每变一次、关 Remote 时最后一次（`remote: false`） |
| `records` | `session`、`records: [{seq, turn}]`，`seq` 严格递增、都大于中枢已有的 | 每写一行记录；补推时成批 |
| `gone` | `session` | 本机删了这个会话（P37.14d）：中枢删副本 |
| `reply` | `id`、`ok: true` 与 `result`，或 `ok: false` 与 `code`、`message` | 答下行的 `send` / `answer` / `stop` |

下行（中枢 → 运行器）：

| 帧 | 字段 | 什么时候 |
|---|---|---|
| `welcome` | `v: 1`、`device {id, name}`、`have: {<会话号>: {seq, remote}}`（中枢上这台设备每个副本存到哪一条、中枢以为它开没开） | 收到 `hello` 之后 |
| `ack` | `session`、`seq` | 这个副本已经落盘到 `seq` |
| `refuse` | `session`、`code`（`full`）、`message` | 副本或账号到了上限（§5.3）：运行器把这个会话的 Remote 关上并写一条过程行 |
| `send` | `id`、`session`、`text`、`clientId` | 别的设备续写一句 |
| `answer` | `id`、`session`、`ask`、`decision`、`message?` | 别的设备答一条征询 |
| `stop` | `id`、`session` | 别的设备中止本轮 |

- 记录就是 `events.ndjson` 里 `seq` 0 以后的行（§4.3.6），`turn` 照原样带上 `tool`、`ask`、`clientId`（页面要靠 `ask` 画征询卡片、靠 `clientId` 认出先画的那一行），只按 §5.3 截短 `detail`。`seq` 0 的会话行不推，`session` 帧代替它。
- `send` 进运行器就是 `session.send`，与本机发的一样排队（至多 5 条）、一样的错误码；人的那一行多一个本机字段 `origin: 'remote'`。`answer` 就是 `session.answer`（`by` 照旧记 `user`），`stop` 就是 `session.stop`。中枢等 `reply` 至多 10 s。

**状态。** 运行器的 `list` 答复多一个 `link: {state, reason?}`，变化时发一个 `{type: 'link', state, reason?}` 事件（§4.5.2 的表加一行）：

| `state` | 意思 |
|---|---|
| `off` | 没有会话要它，不连 |
| `connecting` | 正在握手 |
| `up` | 收到了 `welcome` |
| `retrying` | 断了或没连上，按退避等下一次，`reason` 写原因 |
| `refused` | 不再自动重试：这台电脑没登录、设备被吊销、属主账号停用、中枢没有 Remote。再开一个会话的 Remote 或重新登录后再试 |

**断线与重连。** 断线后 1、2、5、10、30 秒退避重连，之后每 30 秒一次，收到 `welcome` 就从 1 秒重新算。握手没成功时（Bun 的 WebSocket 不交出 HTTP 状态码），运行器先问 `GET /v0/client/device`：吊销、属主停用、令牌无效就转 `refused`；再不带升级头问一次 `GET /v0/client/link`：404 是中枢版本早于 Remote、501 是中枢没开 Remote（都 `refused`），426 说明中枢有、升级被中间的反向代理挡了（`retrying`，原因写明）。

**反向代理。** 中枢前面的反向代理要把 `/v0/client/link` 的升级转过去。内测中枢的 TLS 前置（`demo/env/beta/ops/console-tls-front.ts`）只为这一条路径做了：先替设备向回环上的控制台拨一条链路，控制台 101 了才给设备 101，之后逐帧对转、关闭码原样带回；控制台拒绝时设备拿到 502，随后按上面两条普通请求问清原因。别的路径上的升级照旧走普通转发、不会被升级。

**吊销与停用。** 吊销设备（「连接」页、`qmo sign-out`，都经设备端口的 `revokeDevice`）、属主账号被吊销或重置（`onAccountEnded`）时，中枢当场以 4401 关掉这台设备（或这个账号所有设备）的链路，并删掉它们的副本（§5.3）；之后的握手按上表 401。账号降成只读、订阅到期这类没有事件的变化，由中枢每 30 秒用同一个 `authenticate`（与订阅）对每条链路复核一次，不过就以 4403 / 4402 关掉。为了复核，中枢在链路存在期间把这枚令牌留在内存里，不落盘、不进日志。运行器收到 4401 / 4403 / 4402 不重连，转 `refused`。

### 5.2 别的设备怎么看到

**列表。** 开着 Remote 的本机会话出现在同一账号别的设备的 `/code`：浏览器里的 Code 面、另一台桌面版 Code 面的侧栏（本机会话的文件夹分组之后）。按「设备名 · 项目文件夹名」分组；离线的、Remote 已关的，行上的小标写「离线」「Remote 已关」。一台桌面版自己的副本不出现在它自己的 Code 面里：它的页面是用这台设备的票据进门的（会话表记着设备号，clients.md §3.2），中枢据此把这台设备的副本去掉，这台电脑上画的始终是运行器的记录（§4.5.5）。

**画法。** 别的设备上的会话用同一个 Code 页脚本、同一套 `CODE_RENDER_JS` 画，只是换一条路：页面多一段脚本 `CODE_HUB_JS`（`assets/codeHub.ts`；`codeRemote.ts` 这个名字给了中枢侧的副本类型与校验），只在个人账号、中枢开了 Remote 时随页面下发（`#code-local` 带 `data-remote="1"`），它把 Code 页对运行器的那几条调用（`qmo_local_read`、`qmo_local_send`、`qmo_local_answer`、`qmo_local_stop`）换成下面的中枢接口，把中枢的事件流翻译成 §4.5.2 的事件（列表变了就是 `session`，打开的副本多了记录就是一条 `trimmed` 的 `record`，页面照原有的补读逻辑去读）。会话的键是 `<设备号>.<会话号>`，地址 `/code?session=<键>`，与本机会话的 `cs_…` 不会相撞。

- 不用前台现有的服务端转录画法（`renderMessages`）：副本的记录会被重写（工具从运行中到结束、征询从未答到已答），服务端片段要整段换进页面才能跟上，前台是用 `innerHTML` 换的，而 Code 页的脚本不许有任何把字符串变成标记的路（§4.5.5）；`CODE_RENDER_JS` 的富文本与 `renderRichText` 逐字相同（真 Chrome 用例核对）、类名照前台，外观一样；本机与别处同一种画法，征询卡片、步骤折叠、差异块都是一份代码。`renderMessages` 不认 `tool`、`ask`，画出来的征询没有按钮。代价：不跑脚本时浏览器里只有「Code 在 Qmo 桌面版里用」那一行。
- 在线时可以续写（输入框、`Enter` 发、先画再同步，§3.3）、答征询（同一张卡片）、中止（停止按钮）；设备离线时输入框、发送、停止与卡片的按钮都关着，标题栏的副标题写「<设备名> · <文件夹> · <agent> · 离线 · 只读」；Remote 已关的副本写「Remote 已关 · 只读」，标题栏有「从中枢删除副本」。设备离线时副本若停在「运行中」「等你确认」，画成「已中断」。别处的会话的权限模式菜单关着（只显示当前的档）、没有变更面板、没有 Remote 开关。
- 浏览器里没有壳：Code 面只有这些副本，「新代码会话」关着，空白处写「这里是你在别的电脑上开了 Remote 的会话 · 新会话在 Qmo 桌面版里开」（一个都没有时写怎么开）；中枢没开 Remote 或读者不是个人账号时照旧只有「Code 在 Qmo 桌面版里用」那一行。
- 正文增量本版不转发：别的设备上 agent 说完一条才出现一条，其间是「思考中」的等待行与计时。

**中枢接口**（都只给个人账号，只看得到、碰得到自己账号的设备；旧式令牌与 break-glass 没有这些接口，答 403；读要能进前台，写要成员或运维，只读账号不能写）：

| 方法 | 路径 | 内容 |
|---|---|---|
| GET | `/v0/code/sessions` | `{devices: [{id, name, online}], sessions: [副本的抬头，带 device]}`：这个账号的副本，去掉发起请求的这台设备自己的 |
| GET | `/v0/code/sessions/<设备号>/<会话号>?before=&limit=` | 与 `qmo_local_read` 同形：`{session, records, more, lastSeq}`，最近的至多 200 条 |
| POST | `/v0/code/sessions/<设备号>/<会话号>/messages` | `{text, clientId}` → 转成 `send`，答 `{turn, queued}`；设备离线 409 `offline`，Remote 已关 409 `remote_off`，运行器拒绝 409 带它的代码，10 s 没答 504。记 `code.remote.send` |
| POST | `…/answer` | `{ask, decision, message?}` → `answer`。记 `code.remote.answer` |
| POST | `…/stop` | `{}` → `stop`。记 `code.remote.stop` |
| DELETE | `/v0/code/sessions/<设备号>/<会话号>` | 删副本，只在 Remote 已关时（开着时 409，先在那台电脑上关）。成功 204，记 `code.remote.drop` |
| GET | `/v0/code/stream` | Server-Sent Events，与 `/v0/chat/stream` 同样的心跳、同样随账号吊销与会话过期关掉；事件 `code` 只有一个递增的 `rev`，不带内容（`console.md` §6.6 的理由），页面拿到就重读列表（合并 150 ms 内的），打开的副本有新记录再读它；另每 30 s 重读一次列表，防事件流被中间挡住 |

公开版的订阅闸照常管这些写接口（`http.ts` 一处）。

### 5.3 同步什么

- **推什么。** 会话抬头（标题、项目文件夹名、agent、权限模式、状态、时刻、`lastSeq`、Remote 开没开）与对话记录（`events.ndjson` 的行，与前台的会话记录同一格式，§4.3.6），按 `seq` 顺序。不推：完整路径、agent 的工作目录、工作树、agent 的原生会话号、文件内容、变更面板、正文增量。单一写入者是运行器：别的设备发的话经中枢转给运行器，运行器写下那一行，再作为记录推回中枢，中枢自己从不往副本里写记录。
- **`detail` 的取舍。** 推之前每条记录的 `detail` 截到 4 KiB（差异留头、输出留尾，规则同 §4.3.6，截了就在末尾写「（更多在那台电脑上）」）；征询的 `ask`（说明、路径、至多 2 KiB 的输入摘要）与征询那一行的 `detail`（要改什么的差异）照推，不然别处答不了征询。本版不设开关：开 Remote 本来就是这个人对这个会话的选择，§5.0 已写明会同步对话；4 KiB 足够在别处看懂改了什么、答得了征询，又让一个副本的体积受控（下一条）。以后要「不推工具输出」，在壳设置窗的「Code」一节加一项，帧格式不变（`detail` 本来就可缺）。
- **顺序与补推。** 运行器每推一批，中枢落盘后答 `ack`；运行器把它记进 `session.json` 的 `remote.pushedSeq`（至多每 2 s 写一次盘，关 Remote 与运行器退出时写完）。重连时中枢在 `welcome` 里报每个副本存到哪一条，运行器从那里接着推（以中枢报的为准，`pushedSeq` 只是这台电脑记下的确认点）：断网期间写下的记录在恢复后按 `seq` 补齐；中枢丢了副本（被删、换了机器）就从头推。一个会话一次只有一批在路上，等到 `ack` 再推下一批；推的时候又写的新记录排在后面。中枢上的副本与本机同样「同一 id 取最后一条、位置取第一次出现」。
- **存放与按账号隔离。** 副本在中枢配置根下：`qianmoConfigPath('qianmo', 'console', 'code-remote', <账号键>, <设备号>, <会话号>)`，里面 `session.json`（中枢收到的抬头，原子写）与 `events.ndjson`（只追加，与本机同一种信封）。账号键是属主 `subject` 的 SHA-256 前 32 位十六进制，路径里不出现账号名；设备号与会话号都按格式核对过才进路径。目录 0700，文件 0600。每一次读写都从这次请求自己的主体出发：链路上的是 `authenticate` 认出的属主与设备，浏览器来的是会话的主体，中枢再核一次设备账本里这台设备的属主就是他。中枢存的是它逐字段核对后重新序列化的记录，不是收到的原文。
- **上限。** 一个副本至多 16 MiB，一个账号至多 100 个副本、合计 256 MiB；到了就答 `refuse`，那个会话的 Remote 由运行器关上（副本留着、只读）。一帧至多 1 MiB。
- **什么时候删。** 吊销设备时删这台设备的全部副本；属主账号被吊销或重置时删这个账号的全部副本；本机删了会话（`gone`）删那一个；别的设备上「从中枢删除副本」删那一个。中枢启动时再核对一遍：设备账本里已吊销、已不存在、或属主对不上的设备，它的副本删掉（停机期间发生的吊销也补上）。

### 5.4 macOS 构建的 `qmo` 与 WebSocket

历史上 macOS 编出来的 `qm` 内联了纯 JS 的 npm `ws`，在 Bun 下握手静默失败（30 s 超时）。`qmo` 用的是 Bun 运行时自带的 `WebSocket`（原生实现，Linux 与 macOS 同一份），客户端的依赖只有 `@qianmo/paths` 与 `@qianmo/harness`，图里没有 `ws`。不靠推断，靠实测：

1. 端到端用例 `atlas/tests/integration/qianmo-client-remote.test.ts`（e2e 分片）：用 `buildClient` 在跑用例的这台机器上当场编出 `qmo`（本机是 macOS，CI 是 Linux），在本进程起一台真的中枢（`startConsoleServer`，个人账号、设备账本、Remote 副本都用生产实现，配置根是临时目录，`127.0.0.1`），配对一台客户端设备，以 `qmo code serve` 跑一个假 Claude Code 的会话、打开 Remote，核对：握手成功（链路 `up`）、副本的记录与本机 `events.ndjson` 逐条相同、从中枢续写一句经链路进了会话、断线期间写的记录重连后按 `seq` 补齐、吊销设备后链路当场断开且重连被拒。
2. 再用 `bun run atlas:build:client` 出的 `dist/qmo-darwin-arm64` 本身对同样起的一台中枢手跑一遍握手与一轮推送，输出记在 §9。
3. 编出来的 `qmo` 里不该有 `ws` 包：用例把同一个入口不压缩地打包一份，核对里面有 `qmo-link.1`、没有 `node_modules/ws/`。

握手失败时运行器在标准错误（壳写进 `runner.log`）记一行关闭码与原因，页面的开关旁写链路状态（§5.1），不会静默。

### 5.5 放弃的做法

| 做法 | 为什么不用 |
|---|---|
| 让运行器当一台常驻节点，走节点的控制链路与任务协议 | 节点协议是中枢拨节点（H-2），运行器在 NAT 后面拨不进来；任务协议、信箱、名册都是为服务智能体设计的，个人电脑进名册会被整个网络寻址。专用的几种帧更小，校验也写得全 |
| 不用 WebSocket，改长轮询或 SSE 加 POST | 续写要中枢主动推给运行器，长轮询每一句话多一个往返，还要自己做顺序与重传；WebSocket 在 Bun 两头都是原生的，一条连接上双向有序 |
| 浏览器里用 `renderMessages` 画副本 | §5.2：跟不上重写的记录，前台的片段换法要 `innerHTML`；也画不出征询的按钮 |
| 设备令牌放在 WebSocket 地址的查询串里 | 会进反向代理与访问日志；Bun 的 WebSocket 可以带请求头 |
| 推之前把 `detail` 全去掉 | 别处答不了征询（看不到要改什么），也看不懂一个工具做了什么 |
| 中枢副本存进前台的对话存储（`chat.ndjson`） | 那是中枢与节点之间的会话，所有账号一份文件；副本要按账号、按设备删，要有自己的上限 |
| 别的设备续写时由中枢先写下那一行再转给运行器 | 两个写入者就要合并规则；单一写入者让副本永远是本机记录的前缀加截短 |

## §6 安全

- 设备令牌仍只在 `qmo`；壳、网页都拿不到，运行器就是 `qmo`。设备链路只开在中枢已有的客户端设备账本上，吊销立即生效。
- 运行器不开任何端口：壳与它只经标准输入输出说话，页面只经壳的命令与通道；中枢经设备链路下来的请求按账号核对，只能触达这个账号自己的设备。
- 本机 agent 的权限模式默认自动审批，但命令执行仍由 agent 自己的沙箱与权限机制把关；运行器只在「跳过权限确认」下替 agent 放行命令；跳过权限确认要再确认一次（§4.4）。
- 壳新增的命令（`qmo_boot_layout`、`qmo_local_*`，选文件夹是 `qmo_local_pick_folder`）照 `qmo-app.md` §7 的规矩：只给中枢源与主窗口、参数逐项校验、路径只认选过的文件夹（§4.5.3）。
- 运行器的日志不记消息正文；会话记录 0600、目录 0700；登录 shell 的完整环境只在内存里、只交给 agent 子进程。
- Remote（§5）：设备令牌只在运行器的 `Authorization` 头里，不进地址、不进日志；中枢为 30 s 复查在链路存在期间把它留在内存里，不落盘。只有个人账号名下、状态正常的客户端设备能升级（§5.1 的表），吊销设备、吊销或重置账号当场以 4401 断开并删副本，降成只读、订阅到期在下一次复查时断开。中枢存的副本按账号键（`subject` 的哈希）分目录、0700/0600，逐字段核对后重新序列化，没有路径与原生会话号；浏览器与别的设备只能读写自己账号的副本，链路下来的请求只送到本账号的设备。`CODE_HUB_JS` 只请求 `/v0/code/…`、带控制台头；三段 Code 脚本都没有把字符串变成标记的路。

## §7 不做（本轮）

Cowork 式虚拟机、模拟器、Office 插件；把整个网页应用另带一份进安装包；云端代为运行本机会话（设备离线时会话不在别处继续跑）；桌面版带 `qm` 或本机 qianmopi（§4.3.1）；运行器另加沙箱；变更面板里的暂存、提交、还原。

## §8 包表

| 包 | 内容 | 完成标准 | 状态 |
|---|---|---|---|
| P37.13 | 局部导航、先改后同步、外观收成一套、首帧按上次布局、两种模式与设置卡片（§3） | 后台与两种前台切页不重载文档；§3.3 的操作失败能回到原样；明暗对比、三种语言、窄屏的现有用例全过；预览环境截图核对 | 局部导航、§3.3 中代码里存在的操作、外观（§3.4）、首帧的页面侧与壳侧、两种模式与设置卡片（§3.6）已实现；两种前台之间仍整页导航；未在真壳里联调 |
| P37.14 | `qmo agents --json` 识别本机 agent（§4.2） | macOS 本机识别出已装的 agent | 已实现（§9） |
| P37.14a | 本机会话第一轮，Claude Code：`@qianmo/harness`（进程基类与 Claude Code 通道搬家，加 §4.3.3 的附加项）；运行器 `qmo code serve`（§4.3.2、§4.3.4–§4.3.6 的 Claude Code 部分，§4.4 的四档）；壳的运行器桥、选文件夹与 §4.5.1 的命令（改名、删除留给 d，`qmo_local_set_remote` 先一律拒绝）；Code 页的会话列表（按文件夹分组）、新会话、转录（§4.5.5）、征询卡片、权限菜单、Git 文件夹的变更面板；`qmo agents` 不再列 qianmopi。原 P37.16「本机直连」并入这里 | macOS 本机经 Qmo.app 用 Claude Code 在一个文件夹里：发一句 → 流式回答 → 改一个文件 → 变更面板看到这个文件的 diff；页面载入后断网，同一会话再跑一轮；退出 Qmo 再开，接着说；节点两组测试与 `qm` 构建冒烟不变；富文本一致性用例、脚本预算与「没有 innerHTML」用例 | 已实现，三路（`@qianmo/harness` 与运行器、壳、Code 页）已合入 main（#283）；Code 页 10-25 随 af903b8a 部署到内测中枢，运行器与壳在客户端；用例与门禁见 §9。真机这一条（Qmo.app 里用真的 Claude Code 走一轮、断网再跑、退出再开）未实测；`RecordSink` 没留（§4.5.6） |
| P37.14b | Codex：`CodexChannel` 搬进 `@qianmo/harness` 并加附加项；运行器的 Codex 驱动（§4.3.5、§4.4 的 Codex 列，`turn/diff/updated`） | 用 Codex 在一个本机文件夹里跑通一轮（改一个文件、看到变更）；四档在假 app-server 上各一轮；常驻 Codex 用例不变 | 已实现，已合入 main，未部署；只在假 app-server 上验过，Qmo.app 里用真的 Codex 未实测（§9） |
| P37.14c | ACP：`AcpChannel` 搬进 `@qianmo/harness` 并加附加项；Gemini CLI、Qwen Code、opencode、dsh 的本机起法、模式映射与会话级「允许」的认法 | Gemini CLI 在本机文件夹里跑通一轮；其余三个在假 ACP 上过，真机标未实测；常驻 ACP 用例不变 | 设计 |
| P37.14d | 独立工作树（§4.3.7）；变更面板补全（非 Git 文件夹、未跟踪、二进制、大文件）；改名、删除（含工作树的去留）；窗口不在前面时的系统通知（一轮完成、等你确认）与角标；退出 Qmo 时有会话在跑先问；壳设置窗「Code」一节（新会话的缺省权限模式、新会话开 Remote 的缺省） | 在 Git 仓库里开工作树会话、改文件、主检出不受影响，删会话时干净的工作树被移除、不干净的留下；通知点开回到那个会话；以上在 macOS 本机走一遍 | 设计 |
| P37.15 | 设备链路与中枢 `/v0/client/link`、设备节点、开着 Remote 的会话同步与续写（§5）；用 P37.14a 留好的接口（§4.5.6） | 本机会话在浏览器里看得到；设备在线时从浏览器续写一轮；吊销设备后链路断开；断网期间的记录在恢复后按 `seq` 补齐 | 已实现并合入 main，未部署；用例与实测见 §9。编出来的 macOS `qmo` 对本机中枢的握手与推送已实测；Qmo.app 里的整条路（真壳、真 Claude Code、真浏览器对内测中枢）未实测 |
| P37.16 | 离线打开 Code（原「本机直连」已并入 P37.14a）：中枢连不上时，壳的离线页给「打开本机会话」，进壳自带的精简本机页（只画本机会话，富文本画法在构建时从控制台的 `CODE_RENDER_JS` 拷入，不是网页应用的副本），本地页面的能力加上运行器的命令 | 断网冷启动 Qmo，能看本机会话、跑完一轮；联网后回到中枢页面 | 设计 |

## §9 验证

§4.1、§4.3–§5 只有设计。§4.3.1 的数是 2026-10-24 在本机量的（文件大小、`gzip -6`、我们自己两个程序的 `--version`），§4.3.4 末条的协议细节来自读已装的 Claude Code、Codex、Gemini CLI 的文件，没有启动任何 agent；Tauri 通道的取数特例与 IPC 回退读的是 `tauri` 2.12.5 的源码。都要在 P37.14a–c 里实测。

P37.13 已有的用例（`atlas/packages/console/test/`）：

- `nav.test.ts`：带与不带 `X-Qianmo-Partial` 的两种答案；部件就是整页在那几处画的内容；守卫不变（无凭据 401、只读令牌读对话类页面 403、cookie 不带控制台头 403、非 GET 405），拒绝是 JSON 而不是登录卡或重定向；策略只在 `script-src` 增长、列出读者可去页面的脚本哈希且不列进不去的、`<meta>` 与响应头一致，Work 与 Code 文档列的与区域文档相同；导航运行时的体积与写法。
- `view.test.ts`、`pages.test.ts`、`front.test.ts`、`p1.test.ts`、`chat.test.ts`：卡片的标记（开着带区域、关着只有列表；一列、组间与簇首只留空白；跳到正文、搜索、桌面版一项）；区域地址的文档是 Work 面加开着的卡片、首帧就有区域且不读转录；404 画在卡片里；对话不在卡片里；读者不能对话时接没接聊天通道 Work 面逐字相同。
- `browser/nav.browser.test.ts`（真 Chrome）：卡片列表切页不重载文档（`window` 上的标记还在、请求是部件请求、没有 CSP 违规、设置页脚本加到运行时的东西离开时撤掉）；前进后退；同一页来回两轮监听逐类计数不变；按下即预取、点击复用，指针扫过列表各项不发请求；无答案时保留当前页、细提示、自动重试一次、「重试」生效；会话失效与外壳键不符时整页导航（前者落到登录门）；卡片里指向前台的链接先关卡片再导航；`data-write` 开关被拒时退回并就地写原因；发送失败留下「未送达 · 重试」，重试后发出；首帧：用一个没有 `qmo_boot_layout` 命令（`invoke` 一律拒绝）的假壳，区域地址上报的是卡片底下的面（`agents`，颜色为 `#rrggbb`），卡片里换区域与关卡片都不报，换深色、窄窗口、收起前台侧栏各报一次，页面上没有未处理的拒绝或报错。
- `browser/modes.browser.test.ts`（真 Chrome）：Work | Code 切换与 Work 的两种地址；Code 在浏览器、带 agent 的假壳、没有命令的旧壳、qmo 答不上来的壳四种情形；卡片经滑杆、⋯ 菜单、⌘,、`__qmoOpenSettings` 打开，已开时只取焦点、不多 push；Esc、×、遮罩关闭，焦点回到打开者；60 次 Tab / Shift+Tab 焦点不出卡片；搜索筛选与回车；区域地址首帧即模态卡片、减弱动效下关闭不等动画，接管不关任何东西、过时的 close 不改状态；脚本打开的卡片内对话框按 Esc 只关它、卡片留下；换区域后紧接着的真实按下（列表下一项、遮罩）不丢；桌面版一项调 `qmo_open_local_settings`。
- `browser/narrow.browser.test.ts`：375 px 时卡片铺满窗口、列表一行横向滚动且当前项在视野里、底部在区域下面、Esc 回到 Work 面；不跑脚本时卡片就是页面。
- `browser/frontTools.browser.test.ts`：权限模式先显示新值，中枢拒绝时退回并写原因。

壳侧（`cd atlas/apps/qmo/src-tauri && cargo test`）：`qmo_boot_layout`、`qmo_local_agents`、`qmo_open_local_settings` 的参数逐项校验与调用方同源判定，三条命令只在中枢的 remote 能力里、不在本地页面的能力里；设置文件里布局与颜色的读写（旧的 `admin`、越界、坏颜色只丢那一块）；骨架计划（哪一面亮、行与标题的排法、两套颜色与缺省）和它交给骨架页的 JSON；`qmo agents` 同一时刻只跑一个。

未验证：WKWebView（桌面壳）里的局部换页与 `<dialog>` 设置卡片；壳里真实的首帧（骨架页只在无头 Chromium 里按三份计划看过）与菜单「设置」接上后的整体；Firefox、Safari。

P37.14a（本机会话第一轮，Claude Code）的用例，全部用假进程，从不启动真的 agent：

- `@qianmo/harness`（`atlas/packages/harness/test/claudeStream.test.ts`，假进程 `test/fixtures/fake-claude-stream.runner.ts`）：帧与常驻时相同、流式事件只喂看门狗；正文增量、整条消息、思考与模式经 `onDetail` 交出；工具的完整输入与结果、子 agent 标记；征询的允许一次（原样带回输入、不留权限）、本会话都允许（`permission_suggestions` 的 `destination` 一律改成 `session`）、拒绝附言、答不了按拒绝、中止时未答的按拒绝且迟到的答复丢掉；`set_permission_mode` 按 id 配对、被拒则拒绝；`interrupt` 的答复。节点两组测试与 `qm` 构建冒烟照旧（搬家单独一个提交）。
- 运行器（`atlas/packages/client/test/code/`）：`runner.test.ts` 在本进程里走各方法——`hello`、选文件夹与受保护根、一轮的流式与记录、`start` 不支持的（工作树、Remote、别的 agent）、四档的原生值与 `auto` 没开通的三种退法（起不来、`init` 报的不是、切换被拒）、跳过权限确认的重起、人工确认的征询、本会话都允许与拒绝附言、中止时未答的征询、五条队列与中止撤下、排队按序、失败的原话与登录提示、崩溃后续接、对话在 Claude Code 那边没了、两种起不来的原因不分先后、64 MiB 只读、空闲回收、进程上限、中止升级到整个进程组、agent 自己的目录从不打开、环境过滤与登录 shell 环境不落盘、Git 变更与差异、落盘的权限位与信封；字数按 UTF-16 计（表情符号算两个）、运行器自己不发 `runner` 事件。`serve.test.ts` 把源码的 `qmo code serve` 当子进程：标准输出只有协议、标准输入结束即退、`shutdown` 在 3 s 内结束连忽略 SIGTERM 的 agent、一个客户端目录一个运行器、被杀后下一个接管锁并结束残留、会话标「已中断」、下一句按原会话号续上。另有 `store`、`git`、`paths`、`env`、`diff` 的单元用例；`agents.test.ts` 与 `qianmo-client-agents-catalog.test.ts` 核对不再列 qianmopi。
- 编出来的 `qmo`：`atlas/tests/integration/qianmo-client-code-serve.test.ts`（e2e 分片）用 `build-client.ts` 的 `buildClient` 当场编一个，按壳的说法（补 `origin: 'local'`、`remote: false`）在临时 Git 仓库里走完 `hello` → `folders.add` → 人工确认档 `session.start` → 征询 → `answer` → 改文件 → 流式 → `changes` / `diff` → `session.mode` → 第二句 → `shutdown`，核对事件的先后（记录、增量在它的记录之前、会话状态 运行中 → 等你确认 → 运行中 → 完成）、`seq` 逐一、`events.ndjson` 每行与发出的记录逐字相同、0700/0600、运行器不发 `runner` 事件、日志里没有说的话；并把三方约定（§4.5.1）里的每组参数交给它，形状都收、多一个键都拒。`check-client-smoke.ts` 对编出来的 `qmo` 跑 `code serve` 的 `hello` 与 `shutdown`。`qianmo-client-code-store.test.ts` 用中枢的 `ChatStore` 读运行器写的记录，与本机读出的逐条相同。
- 壳（`cargo test`）：十三条命令的合法与非法参数（多键、类型、超长、越界、`../`、`-` 开头、控制字符、坏的会话 id / 文件夹 id / 通道串）、按三方约定得出的调用；中枢源以外、快速输入窗、本地页面调用被拒；命令只在 remote 能力里，对话框插件的权限不在任何能力里、它的页面脚本被去掉；对着内存管道上的假运行器：按 id 配对、并发、事件按序进通道、运行器的杂讯被丢、页面重新载入丢通道、退出后在途的被拒并退避重起、一次故障只说一次 `down`、`hello` 超时与协议不对被结束、调用超时不杀运行器、`shutdown` 的三种收尾；一个真的子进程起、重起与退出。`qmo agents` 的用例数据不再有 qianmopi。
- Code 页（`atlas/packages/console/test/`）：`code.test.ts` 核对两段脚本的预算（`CODE_RENDER_JS` < 14,000、`CODE_JS` < 34,000）、能解析、没有 `innerHTML` 一类、`/code` 的 CSP 哈希；`browser/codeRender.browser.test.ts` 在真 Chrome 里核对富文本与服务端逐字相同；`browser/code.browser.test.ts` 对着页面里的假壳（`codeShell.ts`，按三方约定核对每次调用的键与类型）走端到端、跳号补读与重复不重画、运行器起停、停止与排队、征询的焦点、权限模式、发送与开会话失败、选文件夹、前进后退与翻页、重新检测、旧壳与浏览器、三种语言、明暗对比、375 px，全程不向中枢发一个请求。
- 体积：`qmo`（macOS arm64，`--minify`）从基点 `af43e20d` 的 70,895,474 字节到 70,961,522 字节，多 66,048 字节；打包进来的模块只有 `client`、`harness`、`paths`，没有 omp 的代码。

P37.14a 未实测（要在负责人的机器上用 Qmo.app 与真的 Claude Code 核）：

- 真的 Claude Code：`--permission-prompt-tool stdio` 是否仍有效（无效就换 `--permission-prompts host`，§4.6）；以 `--permission-mode auto` 启动在没开通的账号上怎么报（运行器认的两句原话「Session ID … is already in use」「No conversation found」也是按现有提示写的，没对过）；`init` 里有没有 `permissionMode`；`stream_event` 增量的实际形状；登录失效时的原话。
- Qmo.app 里的整条路：WKWebView 里 `Channel` 经 `postMessage` 回退的顺序与延迟、长转录的 DOM；页面载入后断网同一会话再跑一轮；退出 Qmo 再开接着说；系统选择框；`runner.log` 的内容。`bun run atlas:build:app` 只编过，没有打开。
- Windows、Linux：运行器的锁在 Windows 上没有启动时刻核对（总被接管）、进程树与 npm 垫片、壳在这两个系统上都没编过。

P37.14b（Codex）的用例，全部用假进程（`@qianmo/harness` 的 `test/fixtures/fake-codex-app-server.runner.ts`，从节点的 `fake-codex.runner.ts` 扩展），从不启动真的 Codex：

- 搬家单独一个提交（`CodexChannel` 到 `harness/src/codexRpc.ts`，线程参数改由调用方给，常驻的 `codexResidentThread` 键序不变）；节点三组 Codex 用例（`residentRuntimes`、`runtimeNative`、`settingsToolsRuntimes`）不改照过。
- `@qianmo/harness`（`test/codexRpc.test.ts`）：帧与常驻时相同、增量只喂看门狗；调用方给的线程参数（可先问 app-server）、续接带同样的参数、线程没了另开；没有 `ask` 一律 `decline`；正文增量、整条正文、推理、命令开始与输出增量与结束、文件改动的原样条目、整轮差异、失败的 `error`；`once` / `session` / `deny` 的三种答复、没有 `acceptForSession` 时不给也不发、MCP 征询、撤回的征询中止 `signal`、从不发 amendment；本轮的 `approvalPolicy` / `sandboxPolicy` 写进 `turn/start`。
- 运行器（`atlas/packages/client/test/code/codex.test.ts`）：命令行只有 `app-server`、四档开线程的原生值（两档带 `approvalsReviewer`）、改档的三种走法（本轮的值、重起后 `thread/resume`、没有进程时 `now`）与同一线程上的计数、人工确认的征询与允许、本会话都允许与拒绝（文件没改、附言不发）、自动接受编辑的界线（根里的文件由档允许、命令与根外的交给人）、自动审批只在越界时问、跳过权限确认什么都不问、中止与开着的征询、空闲回收后续接、崩溃后续接、线程没了、失败原话与 `codex login` 提示（没有任何登录方法）、非 Git 文件夹的变更与差异（只读记录、0600）、环境与 `~/.codex` 从不打开；驱动登记与 `features.protocols` 一一对应。
- 编出来的 `qmo`（`qianmo-client-code-serve.test.ts`）多一轮 Codex：假 app-server 在 PATH 上、文件夹不是 Git 仓库，人工确认的征询、改文件、变更来自整轮差异、改档下一轮生效、第二句、`shutdown`。Code 页的浏览器用例多一条：不是 Git 仓库时列最近一轮的改动。
- 体积：`qmo`（macOS arm64，`--minify`）从基点 `3247b9b2a` 的 70,961,522 字节到 70,978,034 字节，多 16,512 字节；打包进来的模块仍只有 `client`、`harness`、`paths`。

P37.14b 未实测（要在负责人的机器上用 Qmo.app 与真的 Codex 核）：

- 真的 Codex 0.164.0：`item/agentMessage/delta`、`item/commandExecution/outputDelta`、`turn/diff/updated` 的实际形状（尤其整轮差异里的路径在不是 Git 仓库时是绝对还是相对）；`fileChange` 条目是否在征询之前到（不是的话自动接受编辑会退成交给人）；`thread/start` 是否收 `approvalsReviewer`、`turn/start` 的 `approvalPolicy` / `sandboxPolicy` 是否留给以后各轮；没登录时的原话与 `codexErrorInfo`；拒绝后的命令有没有 `item/started`；npm 装的 `codex` 起子进程时 `children.json` 的残留清理。
- Qmo.app 里的整条路：在一个本机文件夹里用 Codex 改一个文件、变更面板看到它。

P37.15（Remote）的用例与实测，全部用假进程与回环上的中枢，不连舰队、不启动真的 agent：

- 中枢（`atlas/packages/console/test/codeLink.test.ts`，真 `Bun.serve` 上的真 WebSocket、内存里的副本）：谁能升级（个人账号的客户端设备才行；无令牌、坏令牌、吊销、属主停用 401，接力设备与旧式令牌配对 403，不带子协议 426，地址带查询串 400，公开版没订阅 402）与真拨号的 101 / 非 101；`hello` → `welcome`（设备名、`have`），抬头与记录的 `ack`、再拨时 `have` 报存到哪；帧不对、`hello` 之前的帧、`seq` 不递增、二进制帧 4400；抬头里多出来的路径不进副本；账号满了 `refuse`；同一设备第二条链路把第一条以 4409 换掉；`gone` 删副本；`/v0/code` 的列表与读页只给本账号（别的账号同一路径 404、旧令牌 403），续写、答复、停下经链路到运行器、按运行器的答复回 HTTP 并记动作账本，离线 409、Remote 已关 409、开着时不能删、关了能删；事件流只带 `rev`；`DELETE /v0/client/device` 当场 4401 并删副本、重拨被拒，账号吊销关掉它所有设备的链路、不碰别人的，复查把降成只读的以 4403、订阅到期的以 4402 关掉；没接副本的中枢 501。`consoleCodeCopies.test.ts`（node）：落盘的目录 0700、文件 0600、路径里没有账号名，重开后读回、每个 turn 取最后一行放在第一次的位置，100 个副本与 16 MiB 的上限、满了之后重开仍是满的、拒收的那批一个字节也没写，删一个、一台设备、一个账号，启动时按设备账本清理，不是 id 的路径段一律拒绝。另 `routeDocs`、`actionWords`、`settingsCatalog` 跟着新路由与动作更新。
- 运行器（`atlas/packages/client/test/code/remote.test.ts`，本进程的运行器加一个回环上的假中枢）：开 Remote 才拨、抬头不带路径、记录按序推完、`pushedSeq` 落盘；中枢断开期间写的记录在重连后补上、没有重复；别处的一句以 `origin: 'remote'` 跑完；没开 Remote 的会话从别处够不着，`origin: 'remote'` 不能从管道来；最后一个 Remote 关掉就断、再开再拨；4401 不再重试并写原因，再开一次时握手被拒、问出「已吊销」；中枢没有 Remote 时写明；副本满了 Remote 关上并写一条过程行；没登录开不了，换了登录后旧的 Remote 关上并写明；`detail` 截到 4 KiB（差异留头、输出留尾、不切半个字），征询的字段照推。`runner.test.ts` 的 `hello` 改为 `remote: true`。
- 页面（`code.test.ts`、`browser/codeRemote.browser.test.ts`）：三段脚本的预算与「没有 innerHTML」、`CODE_HUB_JS` 只请求 `/v0/code/`、命令表加上 `qmo_local_set_remote`；个人账号在开了 Remote 的中枢上才有 `data-remote` 与 `CODE_HUB_JS`，旧令牌与没开的中枢逐字照旧。真 Chrome 里：浏览器列出 MacBook · atlas 的副本、读出记录与征询卡片、续写一句经链路到运行器再以记录回来（只画一次）、答征询、离线时副标题写「离线 · 只读」且输入框、发送与卡片按钮都关着、Remote 关着时「从中枢删除副本」删掉它；桌面版的假壳上新会话的 Remote 开关把 `remote: true` 交给 `qmo_local_start`、标题栏开关与行上小标、链路状态「已同步」「正在重连 · 原因」、关掉时调 `qmo_local_set_remote`、另一台电脑的副本列在旁边且读它不经壳。原有的 `code.browser.test.ts` 全过。
- TLS 前置（`demo/env/beta/ops/console-tls-front.test.ts`）：只有 `/v0/client/link` 升级、上游先送的帧不丢、子协议照上游选的回、4401 原样带回、设备关了上游也关、上游拒绝时 502 且同一路径的普通 GET 拿到上游自己的应答、真 TLS（`wss`）上同样对转。
- 编出来的 `qmo`（`atlas/tests/integration/qianmo-client-remote.test.ts`，e2e 分片）：`buildClient` 当场编出、按壳的说法跑 `qmo code serve`，对本进程起的中枢（`startConsoleServer`、生产的账号库、设备账本与副本存储，临时目录，`127.0.0.1`）：经 `/v0/handoff/pair` 配对客户端设备、`remote: true` 开会话，链路 `up`、副本每个 turn 与 `events.ndjson` 一致、路径不进副本；浏览器那边续写一句、以 `origin: 'remote'` 落在本机；中枢停掉、其间本机说一句、在同一端口重起（副本从盘上读回），链路回到 `up`、补齐且没有重复；`DELETE /v0/client/device` 后链路 `refused`、副本没了，再开一次 Remote 被拒并写「这台设备已被吊销 · 在 Qmo 里重新登录」；日志里没有令牌。同一入口不压缩打包的结果里有 `qmo-link.1`、没有 `node_modules/ws/`。本机 Bun 1.4.3 下两条都过（用例本身约 3.3 s，编译另算）。
- 手跑（2026-10-25 14:17Z，本机 macOS arm64，记录在 `~/atlas-evidence/2026-10-25/p37-15/manual-remote.log`，脚本同目录）：`bun run atlas:build:client` 出的 `dist/qmo-darwin-arm64`（70,978,034 字节，提交 `03f85c736`，比 P37.14a 记的 70,961,522 多 16,512）对 `qm console --accounts`（临时配置根、`127.0.0.1`）：受邀成员登录、领配对码，`qmo sign-in <中枢> --code` 配对成功；`qmo code serve` 的 `hello` 报 `remote: true`；`remote: true` 开会话后 412 ms 链路 `connecting` → `up`，中枢日志 `[code-link] up d-…`；`/v0/code/sessions` 列出这台设备在线、会话 `lastSeq` 2，副本两条记录与本机 `events.ndjson` 的 seq 1、2 相同；中枢上的两个文件在 `qianmo/console/code-remote/<32 位账号键>/<设备号>/<会话号>/` 下，都是 0600。

P37.15 未实测：Qmo.app 里的整条路（真壳的 `qmo_local_set_remote`、WKWebView 里 `CODE_HUB_JS` 的 `fetch` 与 `EventSource`、真 Claude Code 的一轮经链路推到中枢）；内测中枢的 TLS 前置与真证书下设备对 `wss://` 握手（只在用例里用自签证书过了 `wss`）；经系统 HTTP 代理拨链路（`proxy` 选项按环境变量选，没有真代理测过）；Windows、Linux 编出的 `qmo` 的链路（CI 的 Linux 只跑 e2e 用例，Windows 没有）；手机浏览器上的画法；正文增量不转发，别处要等一条说完。

`qmo agents`（§4.2）：

- 单元测试（`atlas/packages/client/test/agents.test.ts`）用临时 HOME、临时 PATH 与假程序覆盖判定顺序、残留目录、共用目录、环境变量与登录 shell 给的变量、CLI 未找到与厂商位置、dsh 同名判别（含问不出来）、版本缓存的有效期与失效、`--rescan`、登录 shell 的 PATH（注入的与真起一个假 shell 的）、Windows 的 `PATHEXT` 与 npm 垫片（在 macOS 上按 `win32` 跑），并经可计数的文件探针确认凭据文件连 stat 都没有、读过的文件只有 `node_modules` 里的 `package.json`、HOME 下没有任何文件被改动。`qianmo-client-agents-catalog.test.ts` 核对与底层目录一致。
- 本机（macOS arm64）真跑一次，识别出 Claude Code、Codex、Gemini CLI（可用，带版本），opencode 与 DeepSeek Harness 有配置目录、没有命令行程序（CLI 未找到）；`~/.qwen` 等只剩 `skills/` 的目录没有列出。
- 未实测：Linux 真机、Windows 真机（Windows 的查找只在 macOS 上按 `win32` 模拟过；Windows 上直接运行 `.cmd` 取 `--version` 没验证过，npm 垫片走读包的路径不运行）；登录 shell 为 fish、nushell 的情况；macOS 桌面 App 那一路只在测试里模拟过。
