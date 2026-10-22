<!-- Copyright 2026 Qianmo AgentNest Team -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# 阡陌 Qmo — Windows 与 Linux 客户端设计（P37）

| 项 | 内容 |
|---|---|
| 文档版本 | **v1.2（生效）**；v1.1、v1.0 同日 |
| 日期 | 2026-10-21 |
| 核对基点 | 本仓库 `baf0048c`（main，#262 合并提交，基座 qianmopi v18.8.8） |
| 范围依据 | 负责人 2026-10-21：开始开发 Windows 与 Linux 客户端；负责人 2026-10-17 提出的 P37 桌面版与订阅迁移（[`magpie-gateway.md`](./magpie-gateway.md) §6）。章程 v3.12 §2.11 |
| 编号 | P37.1–P37.9（包表见 §7） |
| 依赖 | [`console.md`](./console.md) §4（登录与会话）、[`handoff-usage.md`](./handoff-usage.md)（P19 配对与设备令牌）、[`magpie-gateway.md`](./magpie-gateway.md)（P33 网关密钥） |
| 结论一句话 | 客户端是装在个人电脑上的单文件程序 `qmo`：用 P19 的配对码登录一台中枢，拿到这台电脑的设备令牌；打开前台时用设备令牌换一张一次性票据，在系统自带 Chromium 内核浏览器的应用窗口里开一个普通会话。设备令牌不进浏览器，Windows 用 DPAPI 保管，Linux 用 0600 文件。本机接力、订阅迁移和本机节点在后续包里做 |

由主 agent 按负责人 10-03 的常设委托（设计取舍自行裁定）定案。「未实测」「未评估」是证据状态，不是授权门槛。

**v1.1（2026-10-21）**：按 #266 的安全复核改了以下几处。
- 设备分「客户端」与「接力」两类，只有客户端设备能要票据。
- 不是客户端自己的窗口，要先确认再进；已登录别的账号的浏览器拒绝进入。
- 账号重置或吊销时，设备一并吊销。
- 会话表记下打开它的设备。
- 配对码不再出现在命令行上。
- 票据限额只算没用掉的。
- 状态文件不跟随软链，并核对属主与权限。

**v1.2（2026-10-21）**：按第二轮复核又改了这些。
- 客户端 cookie 只由 Linux 客户端带头的进门下发，点确认页不下发；退出、登录和在浏览器里吊销设备都会清掉它。
- Windows 每次打开都要在确认页点「进入」（§3.3）。
- 确认页在账号备注旁写出账号号码。
- 账号重置或吊销时，它发出、还没用的配对码一并作废。中枢启动时再核对一遍，补上当时没写进账本的吊销。
- 同一账号的设备合计最多 8 张没用掉的票据。
- 退出登录时，只有中枢说「设备已吊销」才算吊销成功。

---

## §0 现状

- 仓库里没有桌面客户端，也没有可以照搬的 macOS 客户端。P37 在路线图里是「规划」，magpie-gateway §6 只写了目标与合规边界。订阅迁移目前没有任何代码。
- 代码里 `desktop` 指 P21 云端电脑（`DesktopPort`、`/admin/desktop`、`host/desktop*.ts`）。客户端的代码一律叫 client，程序叫 `qmo`，免得和它混淆。
- 本机认证中枢的现成办法是 P19 配对：控制台「连接」页「添加设备」给出 12 位配对码，`qm handoff login` 换回设备令牌 `qmd_…`。这个令牌只能访问 `/v0/handoff*`。设备账本只在中枢开了接力时才存在。
- 控制台登录要贴一段凭据（`POST /login`）。开 `--accounts` 后，会话保存在服务端，cookie 只装会话 id；个人凭据放进链接会得到 400。
- `qm` 没有 Windows 构建。`@qianmo/paths` 在 Windows 上会落到 `%USERPROFILE%\.qianmo`；现有代码在 win32 上跳过文件属主与权限检查；命令沙箱只有 Linux 的 bubblewrap。（CLAUDE.md 里提到的 `src/config/paths.ts` 已随 occ 删除，现在的路径入口是 `@qianmo/paths`。）

## §1 客户端是什么

- 一个单文件程序 `qmo`，Windows 上是 `qmo.exe`，装在个人电脑上。本轮它能做三件事：配对登录一台中枢、在应用窗口里打开对话前台 `/`、退出登录并吊销这台设备。
- 窗口借用系统已有的 Chromium 内核浏览器，以应用窗口方式打开。Windows 用系统自带的 Edge（与 WebView2 同一内核）；Linux 依次找 Edge、Chrome、Chromium。客户端用自己的资料目录，不碰用户浏览器的资料。不打包浏览器内核。前台就是控制台的页面，客户端不另写界面。原生 WebView2 / WebKitGTK 窗口留给 P37.8。
- 它不是节点（节点仍是 `qm`），不带模型，P37.6 之前不持有模型密钥，也不使用任何个人订阅的登录。

## §2 打包

| 项 | Windows | Linux |
|---|---|---|
| 程序 | `qmo-windows-x64.exe` | `qmo-linux-x64`、`qmo-linux-arm64` |
| 编译 | `bun run atlas:build:client`，Bun 单文件编译；Windows 产物在 Windows 上编 | 同左；Linux 产物在 Linux 上编（与 `qm` 同一条规矩：macOS 编出的产物不发） |
| 安装（P37.3） | 按用户安装到 `%LOCALAPPDATA%\Programs\Qmo`，开始菜单快捷方式，`qmo://` 注册在 `HKCU\Software\Classes`，不需要管理员；另出一个无控制台窗口的启动器 | `~/.local/bin/qmo`、`~/.local/share/applications/qmo.desktop`、`x-scheme-handler/qmo` |
| 状态目录 | `%LOCALAPPDATA%\Qmo` | `${XDG_CONFIG_HOME:-~/.config}/qmo` |
| 设备令牌 | DPAPI（当前用户）加密后落盘 | 0600 文件；Secret Service 在 P37.4 |
| 窗口 | Edge `--app=<票据地址>` | `--app=about:blank`，经 DevTools 管道导航到票据地址 |

安装器、代码签名和自动更新不在本轮。

## §3 怎么连中枢

### 3.1 登录就是配对

1. 用户在中枢「连接」页「本机工具」里点「添加设备」，拿到配对码（10 分钟有效，只能用一次）。配对框给出 `qmo sign-in https://<中枢>` 这一行，配对码单独显示。
2. 运行 `qmo sign-in https://<中枢>`，在提示处输入配对码；不在终端里时从标准输入读一行。配对码不放进命令行，因为 Linux 上每个用户都能读到别人进程的命令行（`/proc/*/cmdline`）。`--code` 仍可显式使用。
3. 客户端调用 `POST /v0/handoff/pair`，带上设备名（默认主机名）、`<platform>-<arch>` 和 `kind: client`，拿回设备号与设备令牌。
4. 地址只收 `https`，`http` 只限本机回环，规则与 `qm handoff` 相同。客户端保存的是用户输入的地址，不采信中枢回传的 Origin。

设备分两类：带 `kind: client` 配对的是客户端设备；`qm handoff login` 配对的、以及账本里没有这一项的旧设备，是接力设备。只有客户端设备能换票据打开前台，接力设备的令牌仍只能访问接力接口。用 `qm handoff` 配过对的电脑要打开前台，就再用 `qmo sign-in` 配一次。

一台电脑算一台设备，会出现在「连接」页，可以单独吊销。成员只看得到自己的设备，运维看得到全部。吊销后令牌马上失效，用它开的窗口会话也一起关闭。签发人的账号被吊销或重置时，它的设备一并吊销，它发出、还没用的配对码作废，账号恢复后旧设备和旧配对码都不会复活。账号账本记着每个账号的凭据最后一次作废的时间。中枢启动时按它核对一遍：属主不在用，或者属主在配对之后重置过的设备，一律吊销，这类配对码一律删掉。即使当时那次写入没有成功，重启之后也能补上；在补上之前，认证时同样按这个时间拒绝。

中枢侧改一处：开了 `--accounts` 的中枢，即使没开接力，也会建立设备账本。

### 3.2 打开前台要一张一次性票据

设备令牌不交给浏览器。打开前台分五步：

1. 客户端调用 `POST /v0/client/tickets`（Bearer 设备令牌），换一张一次性票据：60 秒内有效，只能用一次。中枢只在内存里保存它的哈希。每台设备同时最多 4 张没用掉的，每分钟最多 20 张；同一账号的设备合计最多 8 张没用掉的；全台最多 1000 张没用掉的，用掉的不占名额。
2. 窗口打开 `<中枢>/client/enter?ticket=…`。只有 `Sec-Fetch-Site` 为 `none`（系统或客户端直接发起的导航）、同源或没有这个头的请求才会被受理；从别的网站点进来的一律 403，票据也不会被用掉。核对失败计入登录节流。
3. `none` 还不够：邮件或聊天程序里点开的链接也是 `none`，会把它落进的那个浏览器登录成票据的账号。所以票据只在它的窗口里直接生效，判据有两个。
   - Linux 客户端经管道加的 `X-Qmo-Device` 头。网页没办法给导航加这个头。
   - 这台设备的客户端 cookie：HttpOnly、SameSite=Strict，HTTPS 上带 `__Host-` 前缀，值是设备号加中枢的签名。它只在带着上面那个头进门时下发，用来认出同一个窗口配置目录后来没带头的进门。

   别处，包括 Windows 客户端的窗口，先显示「以 <账号> 身份进入」确认页。页面写出账号备注和账号号码，因为备注是注册的人自己填的。确认页没有脚本、不自动提交、不能被嵌进框架；点了按钮，同源的 `POST /client/enter` 才用掉票据，而且不下发客户端 cookie：一次点击说明不了是哪个浏览器，同一台设备之后的票据在这个浏览器里照样要确认。`/login`、`/logout` 和在浏览器里吊销这台设备，都会清掉客户端 cookie。在这台设备自己的票据开的窗口里吊销它时，吊销会当场关掉那个会话，cookie 就留在窗口配置里。这个 cookie 不再起作用：它只和这台设备没用掉的票据对得上，而吊销了的设备再也拿不到票据。浏览器已经以别的账号（或旧式令牌）登录时，一律 409 拒绝，票据不消耗。
4. 用掉票据后，中枢用 `sessionFor(设备属主, 设备号)` 开一个普通的服务端会话，会话表记下设备号，303 到 `/`，下发 `qianmo_session`，与 `/login` 一样。
5. 客户端用 `GET /v0/client/tickets/<id>` 确认窗口确实用掉了票据，然后才报「已登录」。在 Windows 上每次都要在窗口里点「进入」，客户端会一直等到票据过期。

票据只在第一跳的请求行里出现，303 之后地址栏里就没有了；它只能用一次，所以和 console.md §6.8「令牌不进地址栏」不冲突。

另有两条路由：`GET /v0/client/device` 查这台设备是否仍然有效；`DELETE /v0/client/device` 在退出登录时吊销自己，动作账本记一行 `handoff.device.revoke`，与「连接」页吊销相同。令牌不能用时，这几条路由的 401 都带原因：`device_revoked`（设备已吊销，账号重置或吊销之后也是这个）、`owner_inactive`（属主账号眼下不能用，比如降成了只读）、`unauthorized`（不认识），客户端按原因提示下一步。退出登录时，只有 `device_revoked` 算吊销成功；另外两种照样清掉本机，但提示去「连接」页处理。

公开版里，要票据和吊销自己与 `/login`、`/logout`、配对一样不过订阅闸：前者是登录，后者是退出。进了前台之后的写操作照常要有效订阅。

没开账号的中枢（旧式令牌）上，`/v0/client/*` 和 `/client/enter` 仍然是 404，客户端改为直接打开 `/login`，由控制台自己的登录页登录。原因是旧式会话 cookie 里装的就是令牌本身，不能经设备令牌换出来。

### 3.3 票据怎么送进窗口

- **Windows**：票据写在 Edge 的命令行上。别的普通用户读不到你的进程命令行，只有管理员可以。命令行上加不了请求头，所以每次进门都停在确认页，要点一次「进入」。Windows 上也能走管道，但要把两个继承句柄交给浏览器，这一轮没有做，也没有验证；原生窗口（P37.8）做好以后就不再需要这一步。
- **Linux**：`/proc/<pid>/cmdline` 对所有用户可读，所以票据不能出现在命令行上。窗口先以 `about:blank` 启动，带 `--remote-debugging-pipe`；两条 0600 FIFO 放在 0700 的状态目录里，不监听端口，浏览器一接上就把两个文件删掉。客户端经这条管道先给页面加上 `X-Qmo-Device` 头，再 `Page.navigate` 到票据地址，这种导航的 `Sec-Fetch-Site` 是 `none`；进门之后撤掉这个头。窗口关闭之前，客户端一直守着管道。
- **macOS** 只用于开发，按 Windows 的方式启动，不是发行目标。
- **桌面版**（P37.8，[`qmo-app.md`](./qmo-app.md) §3）：不经浏览器。`qmo session --json` 自己带 `X-Qmo-Device` 与 `Sec-Fetch-Site: none` 请求票据地址，不跟随 303，把响应里的 cookie 打成一行 JSON 交给壳，核对票据已用掉后退出；壳把 cookie 写进 WebView 再打开 `/app`。`--json` 时标准输出只有这一行，出错时是 `{"error":{"kind","message"}}`，退出码按 `kind` 区分。
- 找不到能用的 Chromium 内核浏览器时（比如 Ubuntu 默认的 snap 版 Chromium，它读不了家目录下的隐藏目录），用系统默认浏览器打开 `/`，不带票据，由控制台登录页登录。

## §4 本机的运行时与节点部件（后续包）

- **P37.5 本机接力**：`qm handoff` 改为读客户端的设备登记，一次配对，客户端和接力共用。P19 插件照旧装进本机的 Claude Code、Codex。
- **P37.6 订阅迁移**：中枢沿 P33 的链路给这台设备签一把 magpie 网关密钥（白名单只含 API key 类上游，带额度、轮换与吊销）。`qmo run claude`、`qmo run codex` 用环境变量和启动参数把官方 Claude Code、Codex 指到网关（`ANTHROPIC_BASE_URL` 与 `ANTHROPIC_AUTH_TOKEN`；Codex 用 `-c model_providers.qmo.*`），不改写用户的 `~/.claude`、`~/.codex`，退出后什么都不留下。换一个工具仍用同一把密钥，额度和用量跟着它走。不用 magpie 的订阅登录与 `claude-code install`（L-6）。
- **P37.7 本机节点（可选）**：把个人电脑作为节点接入。这需要 `qm` 的 Windows 构建（omp 原生插件 `win32-x64` 在 Windows 上编）以及 §5 的隔离。那时要把客户端状态目录加进 `protectedConfigRoots()`，让本机智能体改不了它。
- **P37.8 原生窗口**：用 WebView2（Windows）和 WebKitGTK（Linux）自己承载窗口，替换浏览器应用窗口，票据在进程内导航时送进去。

## §5 系统原生适配

### 5.1 路径

- 客户端的状态目录由 `@qianmo/paths` 的 `clientStateDir()` 给出，优先级依次为：`QMO_CLIENT_DIR`（必须是绝对路径，相对路径直接报错）、Windows `%LOCALAPPDATA%\Qmo`、Linux `$XDG_CONFIG_HOME/qmo`（缺省 `~/.config/qmo`）、macOS `~/Library/Application Support/Qmo`。它不放在 `~/.qianmo` 下面，因为那是节点的配置根；同一台电脑上客户端和节点各管各的。
- 目录下的布局固定：`client.json`（中枢地址、设备号、设备名）、`device.token`（Linux 与 macOS，0600）或 `device.token.dpapi`（Windows）、`window/`（浏览器资料目录）、`pipe/`（Linux 的两条 FIFO）。
- 客户端不读写用户自己的 `~/.qianmo`、`~/.omp`、`~/.claude`、`~/.codex`，也不碰用户浏览器的资料目录。每个 `qmo` 窗口都用状态目录下自己的 `window/` 资料目录。身份路径门禁照常扫描客户端代码。
- Linux 与 macOS 上，写文件先在同目录建一个随机名的临时文件（`O_EXCL`，0600）再改名；写之前核对目录是真目录、属于当前用户、组和其他人没有权限。读 `client.json` 和设备令牌时，文件必须是普通文件（不跟随软链）、属于当前用户、0600。

### 5.2 Windows

- **目录**：用 `%LOCALAPPDATA%`，不用漫游的 `%APPDATA%`。设备令牌经 DPAPI 绑定在这台电脑的这个用户上，漫游到别处也解不开。
- **凭据**：DPAPI `CurrentUser`，附加熵 `qmo.client.v1`，经 Windows PowerShell 5.1 的 `ProtectedData` 调用。脚本以 `-EncodedCommand` 传入，令牌只走标准输入输出，不出现在命令行上。
- **文件权限**：Windows 没有 0600。客户端不靠权限位保密，靠的是 DPAPI；`%LOCALAPPDATA%` 默认只有本人、SYSTEM 和管理员能读。
- **进程**：Edge 用独立的 `--user-data-dir` 启动，和用户自己的 Edge 互不影响；它以分离方式启动，客户端确认票据用掉后就退出。
- **隔离**：Windows 上没有命令沙箱。P37.7 的本机节点在 Windows 上有沙箱之前，不能开高权限模式（P39）。

### 5.3 Linux

- 遵循 XDG 目录规范；目录 0700，文件 0600；DevTools 走 FIFO，不开调试端口。
- 窗口带 `--class=Qmo`，P37.3 的 `.desktop` 靠它把窗口和启动项对上。
- 遇到 snap 等受限分发的浏览器时跳过，退回系统默认浏览器（§3.3）。

## §6 安全边界

- 设备令牌只存在于客户端进程和 DPAPI 密文或 0600 文件里，不进浏览器、命令行和地址栏。
- 只有客户端设备能换票据；接力设备的令牌出不了接力接口。
- 票据：60 秒有效，只能用一次，只存哈希，每台设备最多 4 张没用掉的、每分钟最多 20 张，同一账号合计最多 8 张；全台限额只算没用掉的；用错计入登录节流。
- 票据只在 Linux 客户端自己的窗口里直接生效，别处（含 Windows）要人点确认，点确认不留下任何免确认的记号；已登录别的账号的浏览器拒绝进入（§3.2）。
- 吊销设备后，令牌失效，用它开的会话随即关闭。会话表记着设备号，中枢重启之后吊销也照样关得掉。账号被吊销或重置时，设备一并吊销，没用的配对码作废；中枢启动时按账号账本再核对一遍。
- 同一个用户运行的其他程序能读到这台电脑上该用户的一切，这和浏览器保存的登录状态是同一条边界，客户端不承诺比这更多。

## §7 包表

| 包 | 内容 | 完成标准 | 状态 |
|---|---|---|---|
| P37.1 | 客户端外壳 `@qianmo/client`：`qmo sign-in / open / status / sign-out`，状态目录，Windows DPAPI 与 Linux 0600 保管，查找浏览器，两种系统各自的窗口打开方式，构建脚本 `atlas:build:client` 与冒烟 | 单测覆盖两种系统的路径、凭据保管、浏览器查找与启动参数；在 Linux 上用真浏览器经管道导航；Windows 与 Linux 上编出的程序能运行 | 本轮 |
| P37.2 | 中枢：设备票据 `/v0/client/*` 与 `/client/enter`；开了账号就建立设备账本；吊销设备时关闭会话 | 票据单次使用、过期、跨站拒绝、节流、吊销后关会话、没开账号仍是 404，都有用例；有客户端 → 中枢 → 前台的进程内端到端用例 | 本轮 |
| P37.3 | 安装与系统集成：Windows 按用户安装、开始菜单、`qmo://`、无控制台窗口的启动器、卸载；Linux `.desktop`、图标、协议处理；配对对话框加一行 `qmo sign-in` | 两种系统真机各装卸一轮 | 规划 |
| P37.4 | 系统钥匙串：Linux Secret Service（libsecret），没有会话总线时退回 0600 文件并写明 | 有会话总线、没有会话总线两种情形 | 规划 |
| P37.5 | 本机接力共用客户端的设备登记 | `qm handoff` 不再单独配对 | 规划 |
| P37.6 | 订阅迁移：设备的 magpie 网关密钥，`qmo run claude / codex` | 一把密钥、两种工具，用量归到同一把密钥；用户配置文件不变 | 规划 |
| P37.7 | 本机节点：Windows 构建 `qm`、原生插件、隔离与受保护目录 | Windows 上节点跑通一轮对话 | 规划 |
| P37.8 | 原生窗口：WebView2 / WebKitGTK（2026-10-22 起由桌面版落实，设计见 [`qmo-app.md`](./qmo-app.md)） | 不依赖系统浏览器即可登录并打开前台 | 本轮（见 `qmo-app.md` §9） |
| P37.9 | 构建与发行：在 Windows 上编 Windows 产物、在 Linux 上编 Linux 产物，CI 矩阵，代码签名 | CI 出两种系统的产物并冒烟 | 规划 |

## §8 本轮验证

2026-10-21，P37.1 / P37.2。

| 环境 | 跑了什么 | 结果 |
|---|---|---|
| macOS 本机，真 Chrome | 客户端与路径用例（含真浏览器的命令行路线、`sign-in → open → sign-out` 端到端）；控制台分片；进程内端到端 `qianmo-client-front`；本机编出的 `qmo` 冒烟；交叉编出 `windows-x64`（PE32+ 控制台程序）与 `linux-arm64` | 通过 |
| macOS 本机，真中枢 | 本分支 `qm console --accounts`，编出的 `qmo` 走完配对、开窗口进前台、退出吊销 | 通过 |
| Debian 12 arm64 容器，真 Chromium | 客户端与路径用例（含管道路线：票据不出现在任何进程命令行、FIFO 0700/0600）；Xvfb 下有界面的 Chromium 对上面那台真中枢走完整流程，Linux 上编出的 `qmo` | 通过 |
| GitHub `windows-latest` | CI 作业 `client-windows`：客户端用例（真 DPAPI 往返、真 Edge 命令行路线、无头 Edge 下 `sign-in → open → sign-out` 端到端）、`clientStateDir`、Windows 上编出的 `qmo.exe` 冒烟 | 通过（24 过、2 个 Linux 专属跳过） |
| GitHub `ubuntu-latest` | `packages` 组跑客户端用例（真浏览器）；`build-qm` 作业编 Linux `qmo` 并冒烟 | 见 PR 的 CI |

没有验证：

- 局域网那台 Windows 11 真机：本轮连不上（本机不在那个网段）。Windows 上的证据只有 CI runner。
- 安装、开始菜单、`qmo://`、无控制台启动器（P37.3），snap 版浏览器（只确认会跳过），Linux Secret Service（P37.4），以及 §4 的后续包。
- 有界面的 Windows 窗口：CI 上是无头 Edge。

### v1.1 复核修改后

| 环境 | 跑了什么 | 结果 |
|---|---|---|
| macOS 本机 | 控制台分片（含 `/client/*`、路由文档、文案门禁）；设备账本用例；生产账本上的端到端 `qianmo-client-door`（接力设备拿不到票据、重置后设备作废、已登录别的账号的浏览器得 409、8 个窗口抢一张票据只开一个会话、吊销写进操作记录、成员只看到自己的设备）与 `qianmo-client-front`；客户端与路径用例；编出的 `qmo` 冒烟（含从标准输入读配对码、拒绝相对路径的 `QMO_CLIENT_DIR`） | 通过 |
| Debian 12 arm64 容器，真 Chromium | 客户端与路径用例：管道路线带着 `X-Qmo-Device` 进入，浏览器打开 FIFO 后即删除 | 通过（64 过，DPAPI 1 条跳过） |
| GitHub `windows-latest` / `ubuntu-latest` | 同上一轮的作业 | 见 PR 的 CI |

没有验证：

- 确认页没有在真窗口里点过「进入」。用例按表单发同源 POST，真浏览器用例连的是替身中枢，没有确认页。
- 状态文件属主不对的情形：要用另一个用户建文件，本机和 CI 都没有做，只测了权限位和软链。
- Windows 上随机名 `wx` 写入和 `O_NOFOLLOW` 读取，只在 CI 的 Windows 作业里跑过。
- `qm handoff login` 的配对对话框照旧带 `--code`，那是接力的老用法，这一轮没有动。

### v1.2 第二轮复核修改后

| 环境 | 跑了什么 | 结果 |
|---|---|---|
| macOS 本机 | 生产账本上的 `qianmo-client-door`：新增「点确认页不留 cookie，退出和吊销清 cookie」「重置前签发的码恢复后配不上」两条；设备账本新增「重置作废配对码」「漏写的重置在下次启动补上」；账号账本新增「作废时间重启后还在」；票据入口新增「同一账号 8 张」「确认页写出账号号码」；客户端按 401 原因判断退出；`bun run precheck`、`bun run verify` 全绿（617 个测试文件各跑一次，含 `ATLAS_TEST_HEAVY=all`；registry-ha；`qm` 冒烟 7/7、`qmo` 冒烟 7/7） | 通过 |
| Debian 12 arm64 容器，真 Chromium | 客户端与路径用例，含管道路线 | 通过（64 过，DPAPI 1 条跳过） |
| GitHub `windows-latest` / `ubuntu-latest` | 同上一轮的作业 | 见 PR 的 CI |

没有验证：

- Windows 上每次都停在确认页，这一点只有用例，没有在真窗口里点过。
- 上一轮列出的几项照旧没有验证。
