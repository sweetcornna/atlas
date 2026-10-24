<!-- Copyright 2026 Qianmo AgentNest Team -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# 阡陌桌面版 v2：即时响应、本机开发与多设备同步（P37.13–P37.16）

| 项 | 内容 |
|---|---|
| 文档版本 | **v1.2（生效）**：§3.2–§3.5 按 P37.13 局部导航、先改后同步与外观的实现回写；§4.2.1 补识别细则（`qmo agents` 已实现） |
| 日期 | 2026-10-24 |
| 核对基点 | 本仓库 `b0a8789a`（main，#276 之后） |
| 范围依据 | 负责人 2026-10-24 四条要求，原话见 §0。章程 v3.16 §2.13 |
| 编号 | P37.13–P37.16（包表见 §8）。P37.7「本机节点」并入 P37.14 |
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
│ 「开发」页 ──IPC──▶ 本机节点 qm（§4）    │          │ 设备链路（§5）        │
│   └ 本机 agent：Claude Code、Codex…     │          │ 本机会话的副本（§5.3）│
│ qmo：设备令牌、进门、设备链路 ──WSS────▶│─────────▶│                      │
└────────────────────────────────────────┘          └──────────────────────┘
        其他设备（浏览器、另一台桌面版）只连中枢，经它看与续写本机会话
```

- 页面仍由中枢渲染（章程 N-5 的「服务端渲染、零新运行时依赖」不变），首屏之后的导航由页面自己的脚本完成。
- 本机节点是 `qm`，作为壳的第二个 sidecar 随包，状态在客户端目录下，不碰 `~/.qianmo`。
- 设备令牌仍只在 `qmo` 里：设备链路由 `qmo link` 建立，本机节点只经回环连 `qmo`。

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
| 拦截 | 同源、路径在 `/admin` 下的链接（侧栏项、面包屑、页面里的链接，不限 `data-nav`）与浏览器前进后退。修饰键、中键、`target`、`download`、同页锚点、表单 GET 照常走浏览器。监听挂在 `window` 冒泡阶段的最后，运行时或页面脚本已经 `preventDefault` 的点击（`data-action`、对话框开关）不碰 |
| 请求 | `fetch` 原地址，带 `X-Qianmo-Partial: 1`、`Accept: application/json` 和控制台头（存着令牌时另带 `Authorization: Bearer`，从不进 URL）。中枢在同一个 `servePage` 里先跑同一道守卫，再渲染同一页，只是把答案画成 JSON；cookie 会话读部件必须带控制台头（与片段同为 `guarded`）。拒绝一律是 JSON（无凭据 401、角色不够 403、页面自己答的 404），不出登录卡、不重定向。两种答案都带 `Vary: X-Qianmo-Partial`，都是 `no-store`。不带头的请求照旧回整页，浏览器直接打开、刷新、禁用脚本都不受影响 |
| 答案字段 | `v`（协议版本，现为 1）、`shell`（外壳键，见下）、`documentTitle`、`title`（`<h1>` 文字）、`crumbs`（面包屑 `<nav>`，可空）、`actions`（顶栏右侧：页面动作与健康条）、`main`（`<main>` 的内容，含公开版页脚）、`nav`（侧栏 `<nav>` 的内容，当前项已标 `aria-current`）、`active`、`poll`、`refresh`（`poll` 时附刷新开关，供首屏没画它的文档插入）、`css`（本页样式表，已去注释）、`script`（本页脚本原文）、`hash`（`script` 的 `'sha256-…'`）。标记字段都是服务端渲染、已转义的视图输出 |
| 换上去 | 换标题、面包屑、顶栏右侧、主区、本页样式表（文档里第二个 `<style>`）；侧栏项 id 一致时逐项就地改（焦点和展开的「管理」组不丢），否则整体重画；当前项所在的折叠组打开；`pushState`。刷新开关按 `poll` 显示或隐藏，没有时插入并接上。窄屏抽屉关上，页面的对话框关上。焦点原在主区（或页面上没有焦点）时移到 `<main>`，滚动回顶部；前进后退回到离开时的滚动位置（`history.scrollRestoration = 'manual'`，第一次局部换页时才设） |
| 预取 | 只在指针按下时开始取（不等松开），按下到松开的提前量已够；悬停不预取：每个部件在中枢上都要读名册、渲染整页，中枢在小机器上，指针扫过侧栏会白白触发多次。同一地址在飞的请求复用，取到的答案 5 秒内直接用 |
| 缓存 | 内存里留最近 20 页（插入序淘汰）。前进后退与回到看过的页面先显示留着的那份；超过 5 秒的同时后台再取，答案的主区变了、读者也还没在这页上点按或按键，才换上新的。不落盘；退出登录、换令牌、会话失效都清空，换令牌后下一次换页走整页（角色标签、策略和侧栏要换成新凭据的） |
| 脚本与 CSP | 页面脚本都是编译期常量。外壳文档只带一段 `<script>`：共享运行时 + 导航运行时 + 本页脚本 + 一行收尾。策略的 `script-src` 列这一段的哈希，再列本页脚本单独的哈希和侧栏对这个读者可见的各区域页面脚本的哈希（`routes/index.ts` 的 `navScriptsFor`，与侧栏同一个 `visibleTo` 判断；读者进不去的页面不列）；`<meta>` 与响应头由同一组脚本算出（`respond.ts` 的 `documentHeaders(body, allow)`）。只有 `script-src` 变长，其余指令逐字不变（`test/nav.test.ts` 核对）。换进来的脚本以内联 `<script>` 插入、立即执行；执行前客户端拿答案的 `hash` 对照文档 `<meta>` 里的策略，不在就整页导航 |
| 外壳键 | `shell` 是共享样式表、两份运行时、头像样式与导航运行时（去掉键本身）的 SHA-256 前 16 位，写进文档里的导航运行时。答案的键对不上（中枢换了版本而页面还开着）就整页导航，免得新页面配旧样式或旧运行时 |
| 页面脚本的进出 | 见下文「与设计的偏离」 |
| 失败 | 网络不通或 5xx：保留当前页，`#conn` 下方出一行细提示「页面没有打开 · 正在重试」，1.2 秒后自动重试一次；仍失败就写明原因（`HTTP 503`、无法连接、浏览器离线）并给「重试」按钮。401、跳去登录门的重定向、403、页面自己的 404、不是本协议的答案、外壳键或哈希对不上：一律整页导航（`location.assign`；前进后退时 `location.reload`），401 因此落到登录门，桌面壳在那里重新进门（`qmo-app.md` §3 第 4 步）。会话已失效的页面不再局部换页 |
| 过渡 | 支持 View Transitions 的内核（Chromium；WKWebView 视版本）用 `document.startViewTransition`，`html.nav-fade` 下根元素的新旧快照动画 120 ms；`prefers-reduced-motion` 或不支持时直接换。取页期间 `html[data-nav-busy]`：主区降到 55% 不透明、页顶一条 2 px 细线（样式在 `assets/css.ts` 末尾「P37.13 nav」一节，共享样式表仍无 `@keyframes`） |

**与设计的偏离：页面脚本没有各自导出 `mount` / `unmount`。** 后台二十个页面脚本（约 190 KB）都写成立即执行的函数，直接往 `document`、`window` 挂监听、开定时器、向运行时注册动作。逐个改写成导出 `mount` / `unmount` 等于重写全部页面脚本，风险与收益不相称。改为由导航运行时给页面脚本套一个「录制作用域」：脚本执行的那一段同步时间里，它往 `document`、`window` 加的监听、开的 `setTimeout` / `setInterval`、经运行时注册的动作（`onAction`）、提交（`onSubmit`）与失效钩子（`onExpire`）、新加到 `window` 和运行时对象上的属性都记下来；离开这一页时先跑它的失效钩子（页面就是靠这个停轮询的），再逐项撤销。执行脚本就是 `mount`，撤销就是 `unmount`。页面在点击之后才开始的轮询，由它注册的 `qc.onExpire` 停，或注册 `qianmoNav.onLeave`；本包给缺这一步的四处补上了（`connectScript` 的配对倒计时、`updatesScript` 的升级跟踪、`channelsScript` 的扫码轮询；`replicate`、`magpie`、`providers` 原本就有）。浏览器用例核对同一页来回进出两轮后 `document` / `window` 上的监听逐类计数不变。没有覆盖的：脚本在某个回调里（而不是执行当时）直接挂到 `document` / `window` 上的监听——目前的页面脚本没有这种写法，新写的页面脚本要遵守。

**三处之间实际做到的层级。**

- 后台各页之间：局部换页，文档不重载（浏览器用例在 `window` 上放标记，换页、前进后退后仍在）。
- 从后台去对话前台（侧栏「对话」是 `/`）：整页导航，但点击当下侧栏项就标为当前、主区变暗、页顶出细线，下一页画出来之前这一页一直在（Chromium 的同源导航默认保留旧页直到新页首绘；WKWebView 里是否同样不白屏未核对）。从浏览器的往返缓存回来时清掉这些状态。
- 前台 `/` 与 `/app` 之间、前台去后台：本包未改，仍是整页导航。前台两种界面共用一套渲染，但带着流式对话（SSE）、草稿与大量状态，局部换要先把前台脚本拆出可卸载的边界，留给后续包。

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
| 置顶、改名、归档、删除会话 | — | — | 代码里没有这些操作：会话的 ⋯ 菜单只有「在智能体里打开」「复制地址」，会话接口只有列出、新建、读取、发消息。删除的「先藏 10 秒可撤销」待这些操作出现时再做 |

### 3.4 外观

取 Claude Desktop 的节奏，配色、字体、图标、头像仍是阡陌的。数值按 2026-10-24 对 Claude Desktop 3.6556.2 安装包的静态分析校准（负责人本机证据目录，只取数值；不用它的字体、品牌色与类名，不抄它的样式源码）。前台与后台用同一组变量：只在 `assets/css.ts` 的 `:root` 定义一次（浅色一套，深色在 `prefers-color-scheme` 与 `data-theme="dark"` 两处各写一遍同样的值，两套相同的值只写在浅色里；每份文档都内联这份样式，前台也是），`view/frontStyle.ts` 与前台其余样式只引用。字号、颜色、圆角，以及侧栏宽、顶栏高、阅读栏宽、红绿灯留白都是变量，按实测值校准时只改变量；例外是头像编辑器与头像框自己的尺寸（头像是阡陌的）、主题色选择器的色环，和 `routes/` 里总览、审计两页的页内样式。主题色、浅色 / 深色 / 跟随系统、强调色切换照旧。实际取值：

| 项 | 取值（变量） |
|---|---|
| 底色 | 页面 `#f9f9f7` / 暗 `#0b0b0b`（`--color-bg`）；第一层面 `#fcfcfb` / `#151515`（`--color-surface-1`）；侧栏浅色用第一层面，深色是页面色混 20% 黑（`--color-side`）；面板 `#ffffff` / `#1a1a19`（`--color-surface`）；菜单与弹层 `#ffffff` / `#20201f`（`--ui-menu`）；分段控件选中的底板 `#ffffff` / `#3a3a37`（`--ui-raised`） |
| 文字 | 主文字 `#0b0b0b` / `#f0efec`（`--color-text`）；次文字 `#52514e` / `#c3c2b7`（`--color-quiet`）；弱文字 `#898781`，两套相同，只给输入框占位字（`--color-text-3`，浅色页面上不到 4.5:1）；说明文字仍是主文字的 68%（`--color-muted`），保证各种底色上 4.5:1 |
| 线与悬停 | 分隔线主文字 10%，0.5 px（`--color-divider`、`--hairline`）；强边框 20%（`--ui-line`，控件描边）；悬停 / 选中 5% / 10%，深色 7.5% / 15%（`--ui-hover` / `--ui-selected`） |
| 阡陌自己的颜色 | 强调色（琥珀与标志的鼠尾草绿两条色阶）、主题色、交互蓝 `#2a78d6`（`--color-interactive`）、开关圆钮与勾 `--color-on-interactive`；前台的印章红 `--color-seal`、智能体气泡 `--color-agent-bubble`、用户消息块 `--color-user-block`。参照方的品牌色没有用 |
| 字 | 系统字体：`-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans"`，后接微软雅黑与 Noto Sans SC 给 Windows、Linux 的中文。字号 / 行高：说明小字 12/17（`--text-small`），注释 13/17（`--text-footnote`，`.note`），界面 14/20（`--text-ui`），分节标题 15/20（`--text-heading`，`h2`），对话正文 16/24（`--text-prose`），标题 22/28（`--text-title`），页头 24/32（`--text-page`，顶栏的页名），代码 13/19（`--text-code`）；字重 400 / 500 / 600。另有欢迎页问候语 30/38（`--text-display`）与侧栏品牌字 15（`--text-brand`），这两处参照里没有对应值，是我们自己的 |
| 控件 | 高 32（`--control-h`），另有 24 / 28 / 40（`--control-h-xs` / `-sm` / `-lg`）；圆角 8（`--radius-control`），旁边 6 / 7 / 10（`--radius-xs` / `-sm` / `-lg`），复选框 5（`--radius-check`）；面板与弹层 12（`--radius-panel`）；输入框 14（`--radius-composer`），欢迎页大输入框 20（`--radius-composer-lg`）；对话气泡 18（`--radius-bubble`）；快速输入卡片按 §10.1 保留 16（`--radius-quick`）；图标 20，行内 16（`--icon` / `--icon-sm`） |
| 布局 | 侧栏 288（`--side-w`，后台原来 272，一并改成 288），顶栏 48（`--top-h`），阅读栏 768（`--column-w`）；桌面版 macOS 下品牌行与顶栏左侧给红绿灯留 80（`--shell-lights-x`，参照是 74，壳里核对后再定），红绿灯本身的位置由壳定，不在样式里 |
| 间距 | 4 / 8 / 12 / 16 / 24 / 40（`--space-1`…`--space-8`；`--space-5` 与 `--space-6` 都是 24）；参照的 6 不单设变量 |
| 阴影 | 只三档：`--shadow-sm` / `--shadow-md` / `--shadow-lg`。弹层（lg）是 0.5 px 环（主文字 10%）加 `0 8px 24px` 12%、`0 2px 6px` 8% 的黑，深色 32% / 20%；列表与平铺内容不用阴影 |
| 动效 | 60 / 120 / 200 / 300 ms（`--motion-fast` / `--motion-snap` / `--motion-base` / `--motion-sheet`），`cubic-bezier(.165,.84,.44,1)`（`--ease-out`）；后台样式里的过渡不超过 200，300 只给整块换入与前台抽屉；原前台的 450 并入 300；减弱动效时照旧关掉 |
| 后台页 | 不再一页一堆卡片：卡片去底色和圆角，同类条目排成列表，行间 0.5 px 线；总览的统计格改成一条横排数字。说明文字只留一行；状态用一个点加一个词（`state()`），黄、红两种需要注意的状态词带颜色，其余是安静的墨色 |

未做完的（P37.13 第一轮之后）：说明文字的「?」提示还没有做，现有多行说明是删短或保留；`tag()` 小标签里有一部分是状态（「可达」「链完整」「待审批」等），只有设置页的实例一节改成了点加词，其余仍是带底色的小标签；总览与审计页的页内样式写在 `routes/overview.ts`、`routes/audit.ts` 里，这一轮没动，只随公共变量变化。桌面版本地骨架页（`apps/qmo/ui/app.css`）按值抄这套颜色，已对齐；壳在页面到之前画的窗口底色（`src-tauri/src/shell.rs` 的 `page_background`）深色仍是 `#1a1a19`，待壳里核对。

### 3.5 首帧

页面每次布局变化经新命令 `qmo_boot_layout` 报给壳，壳存在设置里；下次启动骨架页按它画，和真实页面对得上。

页面侧已实现，壳侧命令本包未实现。只在 `window.__QMO_SHELL__` 是对象且 `window.__TAURI__.core.invoke` 可用时调用；调用包在 `try` 里、返回的 Promise 吞掉拒绝，壳里没有这条命令时什么也不发生。布局稳定 400 ms 后才报，和上一次报的一样就不报。

调用：`invoke('qmo_boot_layout', { layout })`，`layout` 字段：

| 字段 | 类型 | 含义 |
|---|---|---|
| `page` | `'chat'` \| `'agents'` \| `'admin'` | 哪种外壳：`/app`、`/`、后台 |
| `side` | `'open'` \| `'closed'` | 侧栏是否展开（前台看 `#fx[data-side]`，窄于 700 px 记为收起；后台窄于 1000 px 时侧栏是抽屉，记为收起） |
| `sideWidth` | 整数，CSS 像素 | 侧栏实际宽度 |
| `rows` | 整数，≤ 60 | 侧栏里看得见的行数（前台是会话行或智能体行，后台是侧栏项；折起的「管理」组里的不算，用 `checkVisibility()` 判断） |
| `labels` | 整数，≤ 20 | 看得见的分组标题数（前台是「今天」「昨天」等，后台是分组名） |
| `theme` | `'system'` \| `'light'` \| `'dark'` | `<html data-theme>`，缺省 `system` |

前台由 `assets/frontShell.ts` 报（启动、窗口改变大小、侧栏开合、侧栏列表变化、换外观时）；后台由 `assets/nav.ts` 报（启动、窗口改变大小、「管理」组开合、换外观、每次局部换页后）。壳侧要做的：命令只对中枢源开放、逐字段校验类型与范围（照 `qmo-app.md` §7），存进设置，骨架页按它画侧栏宽度、行与标题。

## §4 本机开发（P37.14）

### 4.1 「开发」页

侧栏顶部的切换变成三项：对话 · 开发 · 智能体（快捷键 ⌘1 / ⌘2 / ⌘3）。只在桌面版里出现「开发」；浏览器里显示其他设备同步上来的本机会话（只读或经中枢续写，§5）。

| 区域 | 内容 |
|---|---|
| 侧栏 | 「新会话」；按项目文件夹分组的会话，每行是标题、agent 小标、状态（运行中、等你确认、完成）；设备离线的会话变灰 |
| 新会话 | 选文件夹（壳的原生选择框，最近用过的在前）、选 agent（§4.2 识别出的列表，带版本，不可用的写原因）、是否开独立工作树（Git 仓库才可选）、权限模式（§4.4） |
| 会话 | 阅读栏与对话页同形；右侧面板加「变更」（工作区的改动，按文件看 diff）与「文件」；终端、预览浏览器是后续包 |

### 4.2 识别本机 agent（参照 magpie）

识别逻辑照 magpie 的做法写成我们自己的代码，结果由 `qmo agents --json` 给出（壳与本机节点都读它）：

| 字段 | 含义 |
|---|---|
| `id` | 与底层目录一致：`omp`（内置的 qianmopi）、`claude-code`、`codex`、`gemini`、`qwen`、`opencode`、`dsh`；不能驱动的另有自己的 id（§4.2.1） |
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

qianmopi 内置在本机节点的 `qm` 里，恒为列表第一项（`id: omp`、`source: builtin`、`available: true`）。后五项我们不能驱动，照样识别，`protocol: null`、`available: false`、`reason: 暂不支持接入`，找到的路径与版本照报。只列识别到的；没装的不列。环境变量只认绝对路径，相对路径当没设。

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

### 4.3 本机节点

- 就是 `qm` 常驻节点，壳启动时以 sidecar 起来，状态在 `<客户端目录>/node`，只监听回环。名册由「开发」页的会话动态生成：一个会话对应一个智能体，底层是选中的本机 agent，工作区是选中的文件夹（或它的工作树）。
- **本机 agent 用这台电脑上用户自己的登录与配置**：子进程按用户在终端里运行它的方式启动（同一个 HOME、同一套配置与登录），这是用户自己的程序在自己的电脑上跑。阡陌的代码不读、不复制、不改它们的凭据与配置目录，不转发它们的模型流量，不转售额度。这是章程 v3.16 §2.13 第 3 条对 L-6 的限定例外，只适用于桌面版的本机节点；服务器上的节点照旧只用 API key 与网关密钥。
- 各 agent 只经它的原生接口驱动（`harness-backends.md` §0）：Claude Code 走流式 JSON，Codex 走 `app-server`，其余走 ACP；会话续接、中止、权限征询都用它自己的。

### 4.4 权限

本机会话的权限模式沿用四档（人工确认 / 自动接受编辑 / 自动审批 / 跳过权限确认），缺省自动审批（`elevation.md` §8.1）。四档翻译成各 agent 自己的权限设置（例如 Claude Code 的 `--permission-mode`），问询经 agent 的原生征询送到页面，在会话里出确认卡片，不走中枢的审批队列（本机会话的主人就是坐在电脑前的人）。

### 4.5 本机直连（P37.16）

页面不经中枢驱动本机会话：经壳的命令 `qmo_local_*`（开会话、发消息、中止、批准、读变更）与事件通道（流式输出）直达本机节点。中枢断了照样能用；同步（§5.3）在后台补。命令同样只对中枢源开放、参数逐项校验，文件路径只认用户在选择框里选过的文件夹及其下级。

## §5 设备外连与同步（P37.15）

### 5.1 设备链路

- `qmo link` 用设备令牌向中枢 `wss://<中枢>/v0/client/link` 拨号，只有个人账号名下、状态正常的客户端设备能连；中枢把它登记成一台**设备节点**（名字是设备名，归属这个账号），节点主动拨号只对这种节点成立。服务器节点「中枢建链、节点零拨号」（H-2）不变。
- 链路上跑的是现有的控制与对话帧，`qmo` 在回环上把它们转给本机节点，所以中枢与节点两边的处理代码不分这条链路是谁拨的。
- 断线 1、2、5、10、30 秒退避重连；设备吊销、账号停用时中枢立即断开并拒绝重连。

### 5.2 别的设备怎么看到

设备节点上的智能体出现在这个账号的名册里（「开发」页列表与浏览器里的对应页面），标明在哪台设备、是否在线。在线时别的设备发的消息经中枢转给本机节点，和在本机发的一样进同一个会话；离线时只读。

### 5.3 同步什么

- 本机节点把每个会话的标题、项目文件夹名（不含完整路径）、agent、状态与对话事件（与前台现有的会话事件同一格式）按顺序推给中枢，中枢存一份副本，供离线时读与新设备补历史。单一写入者是本机节点，不会冲突。
- 不同步文件内容与 diff，只同步对话里本来就有的文字。项目可设「不同步」，这时中枢只知道会话存在。
- 副本存在中枢配置根下，按账号隔离；删除会话或吊销设备时一起删。

## §6 安全

- 设备令牌仍只在 `qmo`；本机节点、壳、网页都拿不到。设备链路只开在中枢已有的客户端设备账本上，吊销立即生效。
- 本机节点只监听回环，不对外开端口；中枢经设备链路下来的请求按账号核对，只能触达这个账号自己的设备节点。
- 本机 agent 的权限模式默认自动审批，但命令执行仍由 agent 自己的沙箱与权限机制把关；跳过权限确认要再确认一次。
- 壳新增的命令（`qmo_boot_layout`、`qmo_pick_folder`、`qmo_local_*`）照 `qmo-app.md` §7 的规矩：只给中枢源、参数逐项校验、路径限定在用户选过的文件夹里。

## §7 不做（本轮）

Cowork 式虚拟机、模拟器、Office 插件；把整个网页应用另带一份进安装包；云端代为运行本机会话（设备离线时会话不在别处继续跑）。

## §8 包表

| 包 | 内容 | 完成标准 | 状态 |
|---|---|---|---|
| P37.13 | 局部导航、先改后同步、外观收成一套、首帧按上次布局（§3） | 后台与两种前台切页不重载文档；§3.3 的操作失败能回到原样；明暗对比、三种语言、窄屏的现有用例全过；预览环境截图核对 | 局部导航（后台各页之间）、§3.3 中代码里存在的操作、外观（§3.4）、首帧的页面侧已实现；两种前台之间仍整页导航；首帧的壳侧命令未做 |
| P37.14 | 「开发」页、`qmo agents --json` 识别本机 agent、本机节点 sidecar、选文件夹、按项目分组的会话、变更面板（§4.1–§4.4） | macOS 本机识别出已装的 agent；用 Claude Code 与 Codex 各在一个本机项目里跑通一轮（改一个文件、看到变更）；其余 agent 标未实测 | 进行中：`qmo agents` 已实现（§9），其余为设计 |
| P37.15 | 设备链路 `qmo link` 与中枢 `/v0/client/link`、设备节点、会话同步与续写（§5） | 本机会话在浏览器里看得到；设备在线时从浏览器续写一轮；吊销设备后链路断开 | 设计 |
| P37.16 | 本机直连 `qmo_local_*`（§4.5） | 拔掉网络后本机会话照样跑完一轮，恢复后中枢补齐 | 设计 |

## §9 验证

§4.1、§4.3–§5 只有设计。

P37.13 已有的用例（`atlas/packages/console/test/`）：

- `nav.test.ts`：带与不带 `X-Qianmo-Partial` 的两种答案；部件就是整页在那几处画的内容；守卫不变（无凭据 401、只读令牌读对话类页面 403、cookie 不带控制台头 403、非 GET 405），拒绝是 JSON 而不是登录卡或重定向；策略只在 `script-src` 增长、列出读者可去页面的脚本哈希且不列进不去的、`<meta>` 与响应头一致；导航运行时的体积与写法。
- `browser/nav.browser.test.ts`（真 Chrome）：侧栏切页不重载文档（`window` 上的标记还在、请求是部件请求、没有 CSP 违规、设置页脚本加到运行时的东西离开时撤掉）；前进后退；同一页来回两轮监听逐类计数不变；按下即预取、点击复用，指针扫过侧栏各项不发请求；无答案时保留当前页、细提示、自动重试一次、「重试」生效；会话失效与外壳键不符时整页导航（前者落到登录门）；去前台时当下标记并变暗；`data-write` 开关被拒时退回并就地写原因；发送失败留下「未送达 · 重试」，重试后发出；首帧：用一个没有 `qmo_boot_layout` 命令（`invoke` 一律拒绝）的假壳，后台页与前台 `/app`、`/` 都按变化上报布局字段（无变化不报，收起「管理」组、窄窗口、收起前台侧栏各报一次），页面上没有未处理的拒绝或报错。
- `browser/frontTools.browser.test.ts`：权限模式先显示新值，中枢拒绝时退回并写原因。

未验证：WKWebView（桌面壳）里的 View Transitions 与局部换页；壳侧 `qmo_boot_layout`；Firefox、Safari。

`qmo agents`（§4.2）：

- 单元测试（`atlas/packages/client/test/agents.test.ts`）用临时 HOME、临时 PATH 与假程序覆盖判定顺序、残留目录、共用目录、环境变量与登录 shell 给的变量、CLI 未找到与厂商位置、dsh 同名判别（含问不出来）、版本缓存的有效期与失效、`--rescan`、登录 shell 的 PATH（注入的与真起一个假 shell 的）、Windows 的 `PATHEXT` 与 npm 垫片（在 macOS 上按 `win32` 跑），并经可计数的文件探针确认凭据文件连 stat 都没有、读过的文件只有 `node_modules` 里的 `package.json`、HOME 下没有任何文件被改动。`qianmo-client-agents-catalog.test.ts` 核对与底层目录一致。
- 本机（macOS arm64）真跑一次，识别出 Claude Code、Codex、Gemini CLI（可用，带版本），opencode 与 DeepSeek Harness 有配置目录、没有命令行程序（CLI 未找到）；`~/.qwen` 等只剩 `skills/` 的目录没有列出。
- 未实测：Linux 真机、Windows 真机（Windows 的查找只在 macOS 上按 `win32` 模拟过；Windows 上直接运行 `.cmd` 取 `--version` 没验证过，npm 垫片走读包的路径不运行）；登录 shell 为 fish、nushell 的情况；macOS 桌面 App 那一路只在测试里模拟过。
