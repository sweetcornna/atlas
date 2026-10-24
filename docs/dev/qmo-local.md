<!-- Copyright 2026 Qianmo AgentNest Team -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# 阡陌桌面版 v2：即时响应、本机开发与多设备同步（P37.13–P37.16）

| 项 | 内容 |
|---|---|
| 文档版本 | **v1.1（生效）**：v1.0 之后补 §4.2.1 识别细则（`qmo agents` 已实现） |
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

| 项 | 做法 |
|---|---|
| 拦截 | 同源、带 `data-nav` 的链接与侧栏项、浏览器前进后退；修饰键点击、下载、表单 GET 照常 |
| 请求 | `fetch` 原地址，带 `X-Qianmo-Partial: 1`；中枢只回这一页的主区、标题、面包屑、页面动作与页面脚本，不回外壳与内联样式（JSON：`{title, crumbs, actions, main, scripts, nav}`）。不带头的请求照旧回整页，浏览器直接打开、刷新、禁用脚本都不受影响 |
| 预取 | 指针按下即开始取（不等松开）；悬停 80 ms 预取；每个地址只预取一次，5 秒内复用 |
| 缓存 | 内存里留最近 20 页，前进后退与回到看过的页面先显示缓存，后台再取；不落盘，退出登录与换账号清空 |
| 脚本 | 页面脚本是固定字符串，首屏的 CSP 一次列出所有页面脚本的哈希，换进来的脚本才能执行；每页脚本导出 `mount` / `unmount`，离开时解绑监听与定时器 |
| 失败 | 取不到时保留当前页、顶部细提示，重试一次；401 交给壳重新进门（`qmo-app.md` §3 第 4 步） |
| 过渡 | 支持 View Transitions 的内核用它做 120 ms 淡入，不支持的直接换 |

`/app` 与 `/` 内部已有会话级的局部切换，本包只把后台各页与两种前台之间的切换补齐，并把三处的导航收成一套代码。

### 3.3 先改后同步

| 操作 | 本地先做 | 失败 |
|---|---|---|
| 发消息 | 消息立即进对话，标「发送中」 | 标「未送达」，点重试 |
| 权限模式、模型、推理强度 | 菜单立即显示新值 | 退回原值，输入框下写原因 |
| 后台开关与表单（`data-write`） | 控件立即变；保存按钮变「保存中」 | 退回，字段旁写原因 |
| 置顶、改名、归档、删除会话 | 列表立即变（删除先藏起，10 秒内可撤销，到时才发请求） | 恢复原位 |

### 3.4 外观

取 Claude Desktop 的节奏，配色、字体、图标、头像仍是阡陌的。前台与后台用同一组变量（`frontStyle.ts` 与 `assets/css.ts` 合成一套 token）：

| 项 | 取值 |
|---|---|
| 中性色 | 暖灰一条：页面底 `#fcfcfb` / 暗色 `#151515`，侧栏比页面深半档，分隔线是文字色的 10%（0.5 px） |
| 字 | 界面 14/20，对话正文 16/24，小字 12/17，标题 22/28；字重 400 / 500 / 600 三档 |
| 控件 | 高 32（小 28），圆角 8；面板与弹层 12；输入框 14，欢迎页大输入框 20 |
| 间距 | 4 的倍数：8 / 12 / 16 / 24 / 40 |
| 动效 | 60 / 120 / 200 / 300 ms，`cubic-bezier(.165,.84,.44,1)` |
| 后台页 | 不再一页一堆卡片：同类条目排成列表，行间 0.5 px 线；说明文字只留一行，多的收进「?」提示；状态用一个点加一个词 |

### 3.5 首帧

页面每次布局变化（侧栏宽度、收起、最近对话的行数）经新命令 `qmo_boot_layout` 报给壳，壳存在设置里；下次启动骨架页按它画，和真实页面对得上。

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

- 有命令可用：`available: true`。dsh 逐个候选跑 `dsh --help`，标准输出里有「DeepSeek Harness」的第一个才采用（Debian 的 dsh、pdsh 也叫 dsh，它的 `--version` 只打版本号，区分不了）；判据与节点是同一份（底层目录 `NpmInstall.identity`）。
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
- `qmo agents --rescan` 不用缓存，全部重问，结果重写进缓存。缓存损坏、不属于本人、权限过宽或是链接时当作没有，扫完原子替换。退出登录不删它：它是这台电脑的事实，与账号无关。
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
  - dsh 判别是我们节点的规则（magpie 没有），同名的多个候选逐个判别；读 npm 包版本时核对包名。
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
| P37.13 | 局部导航、先改后同步、外观收成一套、首帧按上次布局（§3） | 后台与两种前台切页不重载文档；§3.3 的操作失败能回到原样；明暗对比、三种语言、窄屏的现有用例全过；预览环境截图核对 | 设计 |
| P37.14 | 「开发」页、`qmo agents --json` 识别本机 agent、本机节点 sidecar、选文件夹、按项目分组的会话、变更面板（§4.1–§4.4） | macOS 本机识别出已装的 agent；用 Claude Code 与 Codex 各在一个本机项目里跑通一轮（改一个文件、看到变更）；其余 agent 标未实测 | 进行中：`qmo agents` 已实现（§9），其余为设计 |
| P37.15 | 设备链路 `qmo link` 与中枢 `/v0/client/link`、设备节点、会话同步与续写（§5） | 本机会话在浏览器里看得到；设备在线时从浏览器续写一轮；吊销设备后链路断开 | 设计 |
| P37.16 | 本机直连 `qmo_local_*`（§4.5） | 拔掉网络后本机会话照样跑完一轮，恢复后中枢补齐 | 设计 |

## §9 验证

§3、§4.1、§4.3–§5 只有设计。

`qmo agents`（§4.2）：

- 单元测试（`atlas/packages/client/test/agents.test.ts`）用临时 HOME、临时 PATH 与假程序覆盖判定顺序、残留目录、共用目录、环境变量与登录 shell 给的变量、CLI 未找到与厂商位置、dsh 同名判别（含问不出来）、版本缓存的有效期与失效、`--rescan`、登录 shell 的 PATH（注入的与真起一个假 shell 的）、Windows 的 `PATHEXT` 与 npm 垫片（在 macOS 上按 `win32` 跑），并经可计数的文件探针确认凭据文件连 stat 都没有、读过的文件只有 `node_modules` 里的 `package.json`、HOME 下没有任何文件被改动。`qianmo-client-agents-catalog.test.ts` 核对与底层目录一致。
- 本机（macOS arm64）真跑一次，识别出 Claude Code、Codex、Gemini CLI（可用，带版本），opencode 与 DeepSeek Harness 有配置目录、没有命令行程序（CLI 未找到）；`~/.qwen` 等只剩 `skills/` 的目录没有列出。
- 未实测：Linux 真机、Windows 真机（Windows 的查找只在 macOS 上按 `win32` 模拟过；Windows 上直接运行 `.cmd` 取 `--version` 没验证过，npm 垫片走读包的路径不运行）；登录 shell 为 fish、nushell 的情况；macOS 桌面 App 那一路只在测试里模拟过。
