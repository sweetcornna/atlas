# 阡陌控制面板（`qm console`）

> **v0.2 · 2026-08-17 · 已在内测环境上经反代对外**（v0.1 的那句「本地回环已跑通」不再是
> 全部：登录页与会话 cookie、token 的三个入口、登录失败退避限流都是为「它现在真的被 50 个
> 人打开」这件事补的——部署形态见 [`beta-env.md`](./beta-env.md)）
>
> 一条命令起一个网页，把「注册中心里有哪些智能体」「审计链上发生过什么」「协议
> 上限是多少」摆在一页上，并允许注册、注销、心跳、唤醒四个动作。**面向的是内测
> 用户，不是开发者**——出口判据里的那句「无需接触 CLI」指的就是它。

| 项 | 内容 |
| --- | --- |
| 范围依据 | roadmap **M1「注册发现产品化」**：内容「最小 Web 控制台（智能体列表、状态、消息链查看）、账号体系、智能体生命周期管理」，出口判据「**内测用户无需接触 CLI 即可完成注册与查看**」。本包只做这一行里的**最小 Web 控制台**那一段 |
| 明确不在本包内 | **账号体系**（章程 N-2：M0/本包不做账号与租户隔离，M1 另排）、权限模型（M1「权限模型上线」是另一行） |
| 交付物 | `packages/console/`（`@qianmo/console`）、`src/cli/handlers/console{,Args,Ports,Chat,ChatStore,TokenSources}.ts`、`src/entrypoints/cli.tsx` 的分派、本文 |
| 依赖 | `@qianmo/audit`（只读）、`@qianmo/protocol`、`@qianmo/registry`、`@qianmo/router`；运行时 Bun（`Bun.serve`） |
| 身份 | **`OCC_IDENTITY=qianmo`**，与 `occ resident` / `occ audit` / `occ resident-wake` 同一条前置校验 |
| 命令 | 两种写法都对：`OCC_IDENTITY=qianmo … console`，或 **`qm console …`**（`qm` 的入口文件自己把身份钉成 `qianmo`）。`qm` 要求 PATH 上有 Bun，取舍见 §2.1 |

---

## §1 它是什么

一个**单进程、零构建**的运维面板，服务端渲染出三份文档：主页 `/`（名册 / 审计 / 上限）、
对话页 `/chat`（§6）、登录页 `/login`（§4.1）。

- **零构建**：没有前端工具链。HTML 在服务端拼字符串，CSS 与 JS 是两个常量
  （`packages/console/src/assets/`）。加一个 npm 依赖就是给内测环境加一条供应链，
  而这个面板要解决的问题不值那个价钱。
- **单进程**：`qm console` 起的就是它自己，不需要注册中心或节点跟它在同一台机器
  上，也不要求它们活着——注册中心挂了，页面照常打开，只是名册那一栏显示不可达。
- **不是网关**：它**不转发**任何东西给注册中心之外的地方，出向目标都钉死在启动
  参数上：唤醒（§4.4）与对话（§6.3）。

架构上它是一个叶子包 + 一层 host 适配：包里只有路由、鉴权、渲染，**它不知道注册
中心在哪、审计链是哪个文件、PSK 是什么**；这些由 `qm console` 这个 handler 以五个
端口的形式注进去（`packages/console/src/deps.ts` 是那份契约）。方向和 tool-runtime
的六个 facade 一致：包声明接口，host 实现。好处很直接——包能用纯对象做单测，而
「注册中心挂了会怎样」这种事在测试里是一行假端口，不是一个要起停的服务。

---

## §2 怎么起

### 2.1 最短路径

开发树里：

```bash
OCC_IDENTITY=qianmo bun run dev console
```

装过包的机器上，**`qm console` 是等价且更短的写法**，身份不用再手写：

```bash
qm console
```

`qm` 是 `package.json` 的 `bin` 里第四个名字（原有 `occ` / `occ-bun` / `open-claude-code`
一个没动），指向 `scripts/entrypoints.ts` 生成的 `dist/cli-qianmo.js`；那个文件头一行就是
`process.env.OCC_IDENTITY ??= "qianmo"`。**`??=` 而不是 `=`**，所以 `OCC_IDENTITY=occ qm
console` 仍然按 occ 跑、并照旧被那条前置校验拦下——入口给的是默认值，不是覆盖。
身份**写在文件内容里、不从调用名推断**，理由在 `src/constants/brand.ts` 的
`invokedBinName()` 注释里，本文不复制。**老写法一条都不作废，两种都对。**

**代价是 `qm` 要求 PATH 上有 Bun**：它的 shebang 是 `#!/usr/bin/env bun`
（`scripts/entrypoints.ts` 的 `identityPinnedEntrypointSource`），因为 console 与 resident
都强制 Bun。对 console 来说这不是 `qm` 新引入的限制——`occ` 指向的是 node shebang 的
`dist/cli-node.js`，在 Node 下 `runConsole` 第一步的 `assertConsoleRuntime()` 就会抛
`console mode requires the Bun runtime`（`src/cli/handlers/consoleArgs.ts`），**已安装的
名字里能起 console 的本来就只有 `occ-bun` 和 `qm`**。但这不等于「所以无所谓」：shebang
管的是整个入口，`qm --version` 这类本来纯 Node 就能跑的快路径
（`src/entrypoints/cli.tsx` 的 `--version` 分支）也一并绑上了 Bun。

不带任何参数就能起：默认绑 `127.0.0.1:38613`，注册中心默认指
`http://127.0.0.1:38610`，审计链默认指本机 `qianmo` 身份的那一条
（`auditTrailPath()`，即 `<配置根>/qianmo/audit/trail.ndjson`）。

stdout 会打出这样几行，一行一条，直接复制：

```
console      http://127.0.0.1:38613
open         http://127.0.0.1:38613/?token=Zk3q…（32 字符）
view-token   Zk3q…
admin-token  9pR7…
registry     http://127.0.0.1:38610
audit-trail  /Users/you/.qianmo/qianmo/audit/trail.ndjson
wake         disabled (no --wake-url)
chat         disabled (no --chat-url)
label        127.0.0.1:38613
```

`open` 那一行是可以直接点开的——token 就在查询串里。

**`view-token` / `admin-token` 两行总是打，但打的东西不是一回事**：自动生成的打
**值**（除了这一行没有第二个地方拿得到它），显式提供的打**出处**——
`from --view-token-file /…`、`from $QIANMO_CONSOLE_VIEW_TOKEN`、
`from --view-token (visible in the process list)`。**显式提供的值永不回显**：它已经在
操作者手里，再打进终端记录和 CI 日志只是白白多一份泄露面。**出处则非打不可**：三个
入口里高优先级的那个会静默盖掉低的（§3 的优先级表），而「这一枚来自命令行」同时就是
「它此刻正躺在 `ps -eo args` 里」的告警。显式提供时 `open` 那一行相应变成
`…/?token=<your view token>`（`src/cli/handlers/console.ts` 的 banner 段）。

### 2.2 和演示环境联调

演示拓扑（`docs/dev/demo-env.md`）起的是「两个节点 + 一个注册中心」，控制台是第四个
进程，**端口 38613 就是为了给它让位才挑的**（demo-env.md §2.4 已占 38610/38611/38612）。

```bash
# 1. 先把拓扑起来：注册中心 38610、节点 A 38611、节点 B 38612
demo/env/up.sh

# 2. 再起控制台，指向同一个注册中心，并打开唤醒面（目标是节点 A 的入站 ws）
export QIANMO_TRANSPORT_PSK="$(cat .demo-env/secrets/transport-psk)"   # up.sh 用的同一把
OCC_IDENTITY=qianmo bun run dev console \
  --registry http://127.0.0.1:38610 \
  --wake-url ws://127.0.0.1:38611 \
  --label '演示拓扑'
```

演示拓扑里两个节点各有**自己的配置根和自己的审计链**，所以控制台一次只能看一条。
要看节点 B 的那条，用 `--audit` 指过去（路径在 `demo/env/common.sh` 里），或者起
第二个控制台换个端口。

### 2.3 起不来的五种常见原因

| 现象 | 原因 |
| --- | --- |
| `console requires OCC_IDENTITY=qianmo` | 忘了设身份变量。控制台属于阡陌节点态，不在 occ 默认身份下跑 |
| `控制台绑定在非环回地址 … 必须显式提供 view token` | 用了 `--hostname 0.0.0.0`（或任何非回环地址）却没给两个 token。这是**故意**的，理由见 §4.2 |
| `--view-token-file … is readable beyond its owner (mode 0644)` | token 文件的 group / other 权限位不为零。`chmod 600` 即可。**这是拒绝启动而不是告警**：一个对 0644 闭眼的「安全入口」只是把明文从 `ps` 挪到了 `ls -l`，那样它就不配排在优先级第一（§3） |
| `--admin-token-file … cannot be read` / `… is empty` | 路径写错、读不到、或文件是空的。**空文件按配错处理，不按「没给」处理**——按「没给」处理的后果是在回环上悄悄换成一枚自动生成的 token，而那恰好是运维以为自己把 token 钉死了的那一刻 |
| `EADDRINUSE` | 38613 被占。换 `--port`，或者先看看是不是已经起了一个 |

第一条来自 `consoleArgs.ts` 的 `parseConsoleArgs`，第二条来自
`packages/console/src/auth.ts` 的 `resolveTokens`，中间那两条来自
`src/cli/handlers/consoleTokenSources.ts`。**凭据在接线之前就定下来**，所以起不来的
那一次不会先把聊天链路拨出去、把会话文件写出来（`console.ts` 的 `runConsole`）。

---

## §3 选项表

全部选项都支持 `--x value` 与 `--x=value` 两种写法（和 `occ resident` 一致）。

| 选项 | 默认 | 说明 |
| --- | --- | --- |
| `--port <0-65535>` | `38613` | `0` = 让内核挑一个空端口，真实端口打印在 `console` 那一行。默认值避开了 demo-env.md §2.4 的 38610/38611/38612 |
| `--hostname <host>` | `127.0.0.1` | 绑哪个地址。**非回环地址会强制要求显式 token**（§4.2） |
| `--registry <url>` | `http://127.0.0.1:38610` | 注册中心 HTTP v0 基址，`http`/`https`。尾斜杠会被去掉 |
| `--audit <绝对路径>` | `auditTrailPath()` | 审计链文件。**必须是绝对路径**——控制台是长驻进程，相对路径的含义会随谁在哪个目录起它而变 |
| `--wake-url <ws://…>` | 无 | 唤醒目标（节点的入站 WebSocket）。**给了才启用唤醒面**，且还要有 PSK（§4.4） |
| `--chat-url <ws://…>` | 无 | 允许对话拨号的入站端点，**可以给多次**，一次一个。**给了才启用对话面**，且还要有 PSK（§6.7）。同一个端点给两遍会被去重——那是复制粘贴，不是要两条链路 |
| `--chat-from <地址>` | `qianmo://console/operator` | 控制台自己在网络上的地址。它**不是**一个注册进注册中心的节点（§6.2）；用处是让对面知道这条 `task.request` 是谁发的——`InboundAdapter` 把它渲染进 provenance，并写成收件箱里那条消息的 `from` |
| `--chat-store <绝对路径>` | `occConfigPath('qianmo','console','chat.ndjson')` | 会话与转录的落盘位置（§6.5）。**必须是绝对路径**，理由同 `--audit` |
| `--label <text>` | `hostname:port` | 页头标签，≤120 字符。两个控制台开在两个标签页时，靠它区分 |
| `--view-token-file <绝对路径>` | 无 | 从文件读只读凭据。**必须是绝对路径**；**权限必须 0600 或更严**（group/other 任一位不为零就拒绝启动），尾部换行会被去掉 |
| `--admin-token-file <绝对路径>` | 无 | 同上，读写凭据 |
| `--view-token <token>` | 环回时自动生成 | 只读凭据。**三个入口里优先级最低，且它会出现在这台机器每一份进程列表里**（见下） |
| `--admin-token <token>` | 环回时自动生成 | 读 + 写（注册/注销/心跳/唤醒）凭据，暴露面同上 |
| `-h`, `--help` | — | 打印选项表并退出。**排在身份校验与运行时断言之前**——问「这个命令怎么用」的人，恰恰是还没把 `OCC_IDENTITY=qianmo` 配对的那个人。Usage 那一行回显的是**你敲的名字**，见下 |

`Usage:` 那一行、以及未知选项报错末尾那句「run … console --help 看列表」，命令名都取自
`src/constants/brand.ts` 的 `invokedBinName()`，它**只用于显示**：白名单里只有 `bin` 真
装出来的四个名字，别的一律回落到 `BIN_NAME`（`BIN_NAME` 本身一个字节没改，它答的仍是
「我是哪个身份」）。**一处已知不准，已决定不修**：
`OCC_IDENTITY=occ qm console --help` 打的是 `Usage: occ console`——Bun 会把 `argv[1]`
解析成 `dist/cli-qianmo.js`，显示层拿不到 `qm` 这个字，于是回落到身份自己的名字。那是
一个把环境变量与命令名故意拧反的调用，修它要新开一条只为显示服务的 env 通道，不值。

两个 token 都至少 16 字符且必须互不相同，这条对自动生成的也一样校验
（`packages/console/src/auth.ts` 的 `resolveTokens`）。

### 3.1 每枚 token 三个入口，优先级：文件 > 环境变量 > 命令行

| 优先级 | 入口 | view / admin |
| --- | --- | --- |
| 1（最高） | 文件 | `--view-token-file` / `--admin-token-file` |
| 2 | 环境变量 | `QIANMO_CONSOLE_VIEW_TOKEN` / `QIANMO_CONSOLE_ADMIN_TOKEN` |
| 3（最低） | 命令行 | `--view-token` / `--admin-token` |

排序的依据是**「这一份密钥能被什么保护」**，不是「哪个写起来更显式」：文件是三者里
唯一能被文件系统权限保护的一个——它不进任何进程的 `argv`，也不进子进程继承的
`environ`；环境变量在 Linux 上是 `/proc/<pid>/environ`，只有属主可读，挡得住同机的其他
账号；命令行是 `/proc/<pid>/cmdline`，**默认全局可读**，所以它排最后，留着只是为了不
打断既有脚本。逐条论证在 `src/cli/handlers/consoleTokenSources.ts` 的模块注释里，本文
不复制。

高优先级的入口静默盖掉低优先级的，是那种事后没人查得清的配置事故，所以**启动横幅
总是把每一枚的出处打出来**（§2.1）。「哪一枚满足多长、两枚必须不同、非环回必须显式给」
不在这里——那是 `resolveTokens` 的三条策略（§4.2），这一层只回答「这一枚从哪儿来」。

---

## §4 鉴权模型

### 4.1 两个 token，不是一个带 scope 的

读面（名册、审计链、上限）和写面（注册、注销、心跳、唤醒）是两个**不同的字符串**，
分别比对。理由和备份服务那边一样：一个带 `scope` 字段的单 token，会把「只读用户
不能唤醒节点」这件事放在一个布尔量的正确性上。admin token 同时满足所有只读路由
——一个人一份凭据是常态，逼他拿两份等于他只会拿一份。

比对是**定长时间**的（`timingSafeEqual`）。

token 可以走**三个位置**，按这个顺序逐个试：

1. `Authorization: Bearer <token>` —— 页面自己的 `fetch` 和 `curl` 用这个；
2. `?token=<token>` —— **浏览器导航**用这个，因为地址栏里敲进去的 URL 没法带 header。
   CLI 打印那条带 token 的 URL，就是为了这个；
3. `qianmo_console` **cookie** —— `POST /login` 之后浏览器自己带上的那一份。有了它，
   打开控制台是「在一个框里填一次 token」，不是「手工往 URL 上拼一段」。

**「逐个试直到命中」而不是「第一个有值的赢」**：判定是 `credentialOf`（`auth.ts`），
它跳过解析不出角色的位置继续往下走。一个还留着 cookie 的浏览器完全可能去点一条
`?token=` 已经轮换过的旧链接，把那种请求判成匿名，等于因为一份过期书签就把人踢下线。
反向的提升永远不成立——每个位置都拿同样那两个字符串比。（另有一个只答「调用者送来了
什么」的 `presentedCredentialOf`，它取第一个**非空**的位置；两者在多个位置同时有值时会
给出不同答案，**路由用的是 `credentialOf`**。）

**cookie 那一份的代价与它的三笔分期偿还，真源是 `packages/console/src/auth.ts` 的模块
注释**——那里逐条论证了「一个 ambient 凭据凭什么可以安全」，本文不复制，只记结论：

- cookie 是 `HttpOnly` / `SameSite=Strict` / `Path=/` / host-only（无 `Domain`，同域的
  兄弟主机认领不走），**`Secure` 只在请求真的走了 TLS 时才加**。无条件加看起来更安全，
  实际是错的：控制台也会经 SSH 隧道以 `http://127.0.0.1:<port>` 打开，而 `Secure` cookie
  在那里根本不会被送回来，登录页于是收下 token 又把人原地弹回自己。
- **`SameSite` 不看端口**——同站是「协议 + 可注册域」，所以同机上任何一个
  `http://127.0.0.1:9999` 与本控制台同站，它发出的请求会自动带上这枚 cookie。因此
  **凡不是纯文档读取的路由，cookie 凭据必须额外带 `X-Qianmo-Console` 请求头**（§5.1），
  而**本服务不回任何 CORS 头、也不答 preflight**：跨源页面既设不了这个自定义头（它会
  强制预检），也过不了那个没人回答的预检。
- `Bearer` 与 `?token=` 两个位置豁免这条，因为它们**不是环境自带的**：能拿出其中任何
  一个的页面已经知道 token，而 CSRF 是不知道 token 的人干的事。

侧栏因此多了两样东西（`view/bits.ts` 的 `identityControl`）：一枚写着「管理 / 只读」的
角色标——admin 是 view 的严格超集，不写出来的话「少一个按钮」看起来像页面坏了而不是
权限不够；以及一个 `退出`，它是一个**原生 `POST /logout` 表单**而不是脚本接管的按钮，
因为它要和它通向的那张登录页在同样的条件下工作（`view/login.ts`：登录页是包里唯一
一个没有 `<script>` 的页面）。

### 4.2 为什么非环回必须显式给 token

`resolveTokens` 的规则只有两条半：

1. **回环 + 没给** → 自动生成，并把带 token 的 URL 打到 stdout。控制台只有本机能连，
   操作者不付任何代价就拿到了一个能挡住同机其他进程误闯的凭据。
2. **只要不是回环** → 两个 token 都必须显式提供，否则**直接抛错、拒绝启动**。
3. （总是）长度 ≥16 且两者不同。

第 2 条是这份设计里唯一一条「宁可起不来」的规则，理由是失效模式不对称：

- 如果自动生成也适用于 `0.0.0.0`，那么 `qm console --hostname 0.0.0.0` 就会在一台
  VPS 的公网口上起一个面板，凭据只出现在一行**没人在看的 stdout** 里（内测环境里
  它大概率被 nohup 到某个日志文件）。谁先扫到这个端口，谁就拿到了名册、审计链和
  那个唤醒按钮。
- 反过来，「忘了给 token 所以起不来」是一个**当场就会被发现**的失败。

一个只在没人看日志时才生效的漏洞，和一个立刻报错的启动失败——只有后者是可以接受的。

**另外**：这条规则不等于「给了 token 就可以挂公网」。控制台没有 TLS、没有账号体系
（§8.1），限流**只有登录路由那一处**、其余 HTTP 面照旧不限（§8.4）。要跨机器访问请用
SSH 端口转发：

```bash
ssh -L 38613:127.0.0.1:38613 <host>     # 然后在本地浏览器开 127.0.0.1:38613
```

### 4.3 哪些路由不要凭据

只有五条路径，都是**公开的**：

- `GET /v0/health` —— 存活探针。一个要凭据的探针是一个没人接的探针。
- `GET /assets/app.css`、`GET /assets/app.js` —— 两个静态常量，不含任何数据。浏览器
  不会给它在页面里发现的 `<link>` / `<script>` 附上控制台的凭据，门起来只会得到一张
  没有样式的页。
- `GET /login`、`POST /login` —— 门。**一扇要钥匙的门不是门。**两个方法都在凭据检查
  之前分派；防线在别处：`POST` 拒绝跨源提交（`Sec-Fetch-Site`），并且**限流跑在比对
  之前**，所以被挡住的调用者连「刚才那一枚对不对」都问不出来（§8.4）。
- `POST /logout` —— 出口。它唯一改变的是调用者自己浏览器里的状态；**要求一枚有效
  token 才准「停止使用 token」**，会把那些开着标签页、而 token 已经被轮换掉的人卡死在
  里面。同样带 `Sec-Fetch-Site` 检查，因为「同站另一个端口上的页面把运维循环登出」
  这种恶作剧只值三行代码就能去掉。

其余全部要 view 或 admin。**未认证的浏览器不会拿到一份它无法处置的 JSON 401**：
`Accept: text/html` 的 `GET` 会被 303 到 `/login` 并带上校验过的回程；而拿着 view token
去撞 admin 页面的人**原地**看到那张登录卡片（他已经登录了，弹去 `/login` 只会被弹回来）。
`curl` 与轮询器仍旧拿 401 JSON——给它们 HTML 加 200 就是在撒谎（`http.ts` 的
`documentDenial`）。

### 4.4 唤醒面为什么可能是灰的

唤醒需要**两个条件同时成立**：

1. 启动时给了 `--wake-url`；
2. 环境变量 `QIANMO_TRANSPORT_PSK` 里有一把可用的 PSK。

缺任何一个，`ConsoleDeps.wake` 就留空，页面把唤醒表单渲染成**禁用并显示原因**——
这比给一个按下去必定报错的按钮诚实。stdout 的 `wake` 那一行也会说明是哪种情况。

**PSK 只从环境变量取，没有对应的命令行选项。**命令行上的密钥就是这台机器每一份
进程列表里的密钥，和 `occ resident --backup-url` 要求 `QIANMO_BACKUP_WRITE_TOKEN`
走环境变量是同一条纪律。

**两枚控制台 token 现在同样遵守这条纪律**（§3.1 的优先级表）。此前它不是这样的：这条
纪律只写在本文里，而实现只给了 `--view-token` / `--admin-token` 两个命令行入口——也就是
说文档在讲一条实现正在违反的规矩。文件与环境变量两个入口就是来补这个缺口的，命令行那
条留着只是为了兼容，且启动横幅会把「这一枚来自命令行」明写出来。

**唤醒目标钉死在 `--wake-url` 上。**页面传来的 `url` 只被允许等于它（或留空）；不等
就拒绝。否则这个端口等于「任何拿到 admin token 的人都能让本机往任意 ws 地址发一条
带 PSK 握手的消息」，而 admin token 的门槛远低于「能改本机的 systemd 单元」。

页面上能排的延时上限是 **60 s**：`executeResidentWake` 是先等够再发，而它是在一个
HTTP 请求里被调用的——十分钟的定时唤醒等于一个挂十分钟的请求。真要排长定时器，用
`occ resident-wake --after-ms`，那是个能自己活着的进程。

### 4.5 对话面全部要 admin，只读路由也要

`/chat` 与 `/v0/chat/*`、`/fragments/chat/*` 的**每一条**都要 admin token，**包括只读
的那几条**（`packages/console/src/http.ts` 模块注释）。两条理由，任何一条单独都够：

1. **发消息花的是对面节点的模型预算。**只读凭据不该能替别人花这笔钱。
2. **转录是这个控制台上唯一有自由文本的面。**其余每一栏都是 id 与计数（§7.2），
   而这一页是那条规则的例外。

所以 view token 不是「能看不能发」，而是**连一条会话存在都看不见**：角色判定在读端口
之前，它拿到的是 403，端口一次都没被问到。

主页侧栏那个「对话」入口要**同时**满足两个条件才渲染：有通道，**并且**当前凭据是
admin（`http.ts` 的 `handleIndex`，`view/page.ts` 的 `chatEnabled`，见 §6.7）。对只读
凭据来说，一台接了聊天通道的控制台和一台没接的，主页看起来一样——和 API 侧「admin
判定先于存在性判定」是同一条防线（本节开头）。

---

## §5 路由表

`v0` 是 API，`fragments` 是页面局部刷新用的 HTML 片段，两者数据同源。

| 方法 | 路径 | 角色 | 说明 |
| --- | --- | --- | --- |
| GET | `/` | view | 整页 |
| GET | `/login` | 公开 | 登录页：一个框、一个按钮，**没有 `<script>`** |
| POST | `/login` | 公开 | 对上就 303 + `Set-Cookie`，对不上就再给一次那张卡片 |
| POST | `/logout` | 公开 | 303 + 一枚清空的 cookie |
| GET | `/assets/app.css`、`/assets/app.js` | 公开 | 两个静态常量 |
| GET | `/v0/health` | 公开 | `{ "status": "ok" }` |
| GET | `/v0/limits` | view | 协议与运行时上限（§7.1） |
| GET | `/v0/agents` | view | 名册 |
| POST | `/v0/agents` | **admin** | 注册 |
| DELETE | `/v0/agents/<地址>` | **admin** | 注销 |
| POST | `/v0/agents/<地址>/heartbeat` | **admin** | 续租 |
| GET | `/v0/audit?…` | view | 审计记录（过滤见下） |
| GET | `/v0/audit/chain/<traceId>` | view | 消息链还原 |
| POST | `/v0/wake` | **admin** | 唤醒 |
| GET | `/fragments/{roster,audit,limits}` | view | HTML 片段 |
| GET | `/fragments/chain/<traceId>` | view | HTML 片段 |
| GET | `/chat?session=<会话 id>` | **admin** | 对话页整页（§6） |
| GET | `/v0/chat/targets` | **admin** | 能聊的对象，含可不可拨（§6.3） |
| GET | `/v0/chat/sessions` | **admin** | 会话列表 |
| POST | `/v0/chat/sessions` | **admin** | 开一条会话 |
| GET | `/v0/chat/sessions/<会话 id>` | **admin** | 转录 |
| POST | `/v0/chat/sessions/<会话 id>/messages` | **admin** | 发一句话，返回**操作者那一轮**（§6.4） |
| GET | `/v0/chat/stream` | **admin** | SSE，事件只有 `{sessionId, revision}`（§6.6） |
| GET | `/fragments/chat/sessions?active=<会话 id>` | **admin** | HTML 片段 |
| GET | `/fragments/chat/thread/<会话 id>` | **admin** | HTML 片段 |

对话那九行**一律 admin，只读的也是**——理由见 §4.5；这台控制台没接对话通道时它们的
两种缺席答案（404 与 501）见 §6.7。

**地址与 traceId 都在单个 path segment 里百分号编码**：
`qianmo://node-b/reviewer` → `qianmo%3A%2F%2Fnode-b%2Freviewer`。这和注册中心
HTTP v0 自己的约定一致（`packages/registry/src/http.ts`），编错了不会报错，只会安静
地路由到另一条规则上去。

`/v0/audit` 的查询参数：`source`、`outcome`、`traceId`、`taskId`、`agent`、`from`、
`to`（ISO 时间或 epoch 毫秒）、`window`（`1h` / `24h` / `7d`，服务端按 `now - 跨度`
换算成 `from`；只要显式给了 `from` 或 `to`，`window` 就被忽略——显式区间赢相对窗口，
两个控件不该互相打架。不认得的 `window` 值原样丢弃而不是 400：查询串可能是手改的
书签，一个筛选器不该为此报错）、`limit`。全部是 AND；`limit` 取的是**尾部** N 条，和
`occ audit --limit` 同一语义。

### 5.1 三个保护等级：一枚 cookie 能单独打开哪些路由

自从 `POST /login` 会给浏览器发 cookie，每条路由都得回答一个新问题：**一份「环境自带」
的凭据在它上面能干什么**。论证在 `auth.ts`（§4.1），这里是分派表——只有三个值
（`http.ts` 的 `Protection`）：

| 等级 | 哪些路由 | cookie 单独够不够 |
| --- | --- | --- |
| `document` | `GET /`、`GET /chat` | **够。**顶层导航带不了自定义头；而外站页面就算逼浏览器导航过来，同源策略让它一个字节都读不到，渲染一张页面本身也不改变这台控制台或它背后的网络 |
| `stream` | `GET /v0/chat/stream` | **够，除非 `Sec-Fetch-Site` 说调用者来自别的源。**`EventSource` 同样带不了头，所以它只能拿这个等级 |
| `guarded` | **其余每一条要凭据的**：所有写、所有 JSON 读、所有 HTML 片段 | **不够**，必须同时带 `X-Qianmo-Console`。跨源调用者设不了它，因为那会触发一次本服务从不回答的预检 |

**`/v0/chat/stream` 是唯一一条非文档、却接受纯 cookie 的路由**，所以它单独配了那个
`Sec-Fetch-Site` 检查——`SameSite` 漏掉的恰恰是「同站但不同端口」，而这个头由浏览器写、
页面脚本伪造不了。**但它是 belt，不是 braces**：不发这个头的浏览器会退回上面那套规则，
真正 fail-closed 的仍然是那个自定义头（`auth.ts` 的 `isCrossOriginRequest`、`http.ts` 的
`guard`）。

角色判定**排在位置判定之前**：没有有效凭据的调用者一律拿 401，无论他有没有顺手带上那个
控制台头——否则那个头就成了一个「这是不是一枚真 cookie」的探针。

---

## §6 对话面

`/chat` 是控制台的**第二个页面**：操作者在浏览器里跟一个常驻 agent 说话，回复顺着
控制台自己拨出去的那条已认证 WebSocket 回来。整个面只对 admin 开放（§4.5），且要两个
启动条件同时成立才存在（§6.7）。

### 6.1 三块：会话轨道、转录、composer

**为什么是第二个页面，不是主页的第六个区块。**主页是一列 `[rail][pane]` 行、整篇当
一个文档滚；对话是相反的形状——两栏各自滚、composer 钉在其中一栏的底部、视口整体
永远不滚。把它塞进主页，代价是主页交出自己的滚动模型（`view/chatPage.ts` 模块注释）。
所以 `/chat` 是自己的一份文档：壳共用（同一套 CSS token、同一条转义纪律），身子不共用。

**转录是账本的一列，不是一摞气泡**（`view/chat.ts` 模块注释）。每一轮左边一个 34px 圆形
头像（`.turn-av`），头像上方是作者名与时间，正文在一块暖色圆角块（`.bubble`）里——和
名册、审计链同一套视觉语法，也是一篇混着代码与地址的转录仍然读得下去的原因。操作者那
一轮的块底色是陶土浅底（`--color-accent-100`），agent 是沙色的 `--color-surface`；头像
同样按作者上色，区别到此为止——**没有左右对齐翻转**：两个作者永远贴着同一条左边线，
翻转会把满是地址、id、代码的转录变成要连蒙带猜找起点的锯齿边。头像里放的是名字的后
两个字符，末位是数字则保留原样（`beta-1` → `b1`）而不是硬取前两位，因为数字才是分辨
同一节点上两个 agent 的那部分。（Organic 改版之前这里是一条发丝线、没有填充也没有头像
——单侧对齐是唯一原样保留到现在的部分，`view/chat.ts` 模块注释。）会话标题取的是目标
地址的 `agent` 段，页面不另发明一个显示名、也不留第二份副本——在注册中心改了名字，
页面跟着改。

**正文按空行切成 `<p>`，每一块都过 `escapeHtml`**：没有 markdown、没有代码围栏识别、
没有自动链接。那三样每一样都是「对面模型的输出变成本页 markup」的一条路。剩下的排版
只有 CSS 的 `white-space: pre-wrap`（`turnText`）。

**composer** 在没有会话打开时渲染成禁用并写明「先选一条会话，再发消息」，控件留着不撤。
这和唤醒面的取舍相反（§4.4 那边直接不给提交按钮），因为两种缺席不是一回事：没有 PSK 是
**配置**状态，点一万次也不会变；「还没打开会话」是**临时**状态，旁边点一下就好
（`view/chatPage.ts` 的 `composer`）。启用与否看的是**转录真的读出来了**，不是查询串里
写了个 session——书签里的旧 id 不该在一条失败横幅底下放一个能按的发送钮
（`http.ts` 的 `chatThreadFragment`）。`Enter` 发送、`Shift+Enter` 换行；单条消息上限
8000 字符（`MAX_CHAT_TEXT_LENGTH`），composer 的 `maxlength` 与服务端那个 400 用的是
同一个常量。

### 6.2 回程走的是既有那条链路，不是新发明的一条

「浏览器发一句话，agent 回一句话」需要一条**回程**，而仓库里已经有一条：
`task.request` → `ack` → `task.result`，**三者都在发起方自己那条已认证连接上**
（P4.1 / AC-2）。agent 那一轮的正文就是 `task.result` 的 `completed` 分支带的 `content`
（`src/cli/handlers/consoleChat.ts` 模块注释）。

所以控制台是一个**纯拨号方**：不起监听端口、不注册进注册中心、不持有节点身份私钥。

另一条路——把控制台做成一个可寻址的对等体：起 `@qianmo/transport` 的 server、给它一份
PSK 与身份、把 `qianmo://<console>/<operator>` 注册进注册中心——被否掉了，三个理由，
每一个单独都够：

1. **协议里没有「agent 主动对操作者说话」这种消息。**走那条路就得教常驻侧在跑完一轮
   之后**再**发一条新消息，那是改 `packages/resident` / `src/services/qianmo/resident.ts`
   的既有语义。
2. **P4.1 的判据明确把「回程另开一条连接」排除在外。**再造一条等于给同一件事开第二个
   出处，而那个出处不受 AC-2 的用例守着。
3. **它要多一个监听端口、多一份 PSK 服务端面、多一条注册中心写入。**每一样都是真实的
   攻击面，换来的只是同一段文本。

**代价说清楚：这条路只能回答被问到的问题。**agent 想在没人问的时候主动说一句（「我跑完
那个后台任务了」），当前形状承载不了——那要等协议真的长出一个「通知」消息类型。

### 6.3 名字从注册中心来，能不能拨从启动参数来

注册中心自己没有任何鉴权（§8.2），所以「注册中心说这个 agent 的端点在那儿」不是
「控制台就该往那儿发一条带 PSK 握手的消息」的理由。**发现与授权分开**：能聊的对象从
注册中心列（`ChatPort.targets`），允许拨的端点钉死在 `--chat-url` 上。这和唤醒面把目标
钉死在 `--wake-url` 上是同一条纪律，只是这里允许多个。

不在名单里的目标**照样列出来**，只是标成不可拨——下拉里带「（不可拨号）」且不可选，
转录头上显示「端点不在允许名单」。藏起来只会让人以为控制台坏了（`deps.ts` 的
`ChatTarget.dialable`）。真发过去时的拒绝话里直接写了怎么办：重启控制台并补一个
`--chat-url`（`consoleChat.ts` 的 `endpointFor`）。

端点在比较之前一律归一（`normalizeChatEndpoint`）：`ws://h:p` 与 `ws://h:p/` 是同一个
端点；不是 `ws`/`wss` 的一概不认。

页面上「不在名册」与「名册不可达」是**两个不同的答案**，不合并成一个灰点：前者是注册
中心答了而这个地址不在里面（有人把它注销了，下一次发送会失败），后者是根本没人问到，
页面对目标的状态一无所知（发送很可能照样成功）。合并它们，就是操作者去重启一个从来
没有掉线的节点的那条路（`view/chat.ts` 的 `targetState`）。

### 6.4 一条投递状态链，不是一个灰勾

一轮的处置是**一条链**：`pending`（交给传输层了）→ `delivered`（有回执了）→ `read`
（对方 ack 了，消息真的进了它的输入）→ `done`（拿到终态回复）。`failed` 是任何一步的
出口；agent 那一轮只会是 `done` 或 `failed`（`deps.ts` 的 `ChatTurnState`）。

页面把回执、已读、回复渲染成**三个独立的事实**——`已投递 · 回执 accepted · 42ms`、
`已读 · 1.2s`、`用时 12s`——而不是一个灰勾。它们是三个不同的网络事件：一条消息可以有
回执而从没被读，也可以被读而从没有回答；把它们收成一个记号的聊天窗，是那种说不出坏在
哪半边的聊天窗（`view/chat.ts` 模块注释与 `turnMarks`）。

**状态只升不降。**回程那四个事件（回执、ack、终态、本地超时）**不保证按顺序到**：本机
回环上 `task.result` 完全可能先于 `sendAndWait` 的回执落地。`STATE_RANK` 给它们排一个秩，
比在每个回调里各写一遍「除非已经是……」短得多，也少一处会漂移的判断。

**关联只认信封的 `taskId`**（protocol C-1），不认 payload 字段，也不认发送者地址。没人
在等的那个 taskId 的回复被静默丢掉：它要么是去重表放过的一条重复，要么是回给一轮在重启
前就已经了结的消息。

四个期限：

| 常量 | 默认 | 是什么 |
| --- | --- | --- |
| `DEFAULT_CHAT_TASK_TTL_MS` | 5 分钟 | 一轮的任务期限。比唤醒面那 60 s（§4.4）宽得多，因为这里等的是一个**真的模型轮次**（跑工具、读文件、可能还要等别的模型）。这个数与 P4.1 判据给 result 的上限同源（`demo/p41-task-result.sh` 的 `RESULT_LIMIT_MS`），不另立一个 |
| `DEFAULT_CHAT_DELIVER_TTL_MS` | 30 s | 投递期限：这一跳把信送到就算数，与那一轮跑多久无关 |
| `DEFAULT_CHAT_SEND_TIMEOUT_MS` | 20 s | 等回执的预算。回执是「传输层收下了」，不是「agent 答完了」 |
| `DEFAULT_CHAT_CONNECT_TIMEOUT_MS` | 15 s | 建链路的预算 |

**本地兜底计时器**：常驻侧自己会在任务期限到点时发一条 `failed` 的 `task.result`
（`resident.ts` 的 `#armTaskTimeout`），所以正常情况下轮不到它。它存在是为了那条消息
**回不来**的情况——链路断了、对面进程没了——否则页面会永远停在「已读」，而那是所有
状态里最像「还在想」的一个。触发时间是 `taskTtlMs + min(15 s, taskTtlMs)`：宽限期比任务
期限本身还长是没有意义的，夹这一下也让用例能用一个很短的 TTL 把这条路径跑完。触发后
操作者那一轮标成 `failed · E_TASK_TIMEOUT`，并追加一条 agent 轮说明这一轮没在期限内回复。

### 6.5 落盘：一个 append-only 的 NDJSON

会话与转录写在一个 NDJSON 文件里，一行一条记录，启动时整篇 replay。默认位置
`occConfigPath('qianmo','console','chat.ndjson')`，用 `--chat-store` 改（§3）。形状和仓库
里另外两份持久日志（审计链、常驻的准入台账）一致，理由也一致：一次写坏损失的是最后
一行而不是整个文件，写到一半崩掉也不会留下一份改了一半的转录
（`src/cli/handlers/consoleChatStore.ts` 模块注释）。

两种记录，第二种会**重复**：

- `session` 只写一次（id、目标地址、node、agent、创建时间）；
- `turn` 每次变化都**整条重新写一遍**——发出、拿到回执、被读、被回答各写一条——replay
  时每个 id 只保留最后一条（last-write-wins；`Map.set` 落在已有键上保留原插入位置，所以
  「最后一条生效」与「首见顺序」同时成立）。

**为什么不是 patch log**：patch log 要一个 merge 函数，merge 函数要和写入方保持一致，而
四态本来就会乱序到达（§6.4）。四份小对象比一条没人回头复看的 merge 规则便宜。撑得住是
因为写入方是一个**在打字的人**——这句写出来是为了下一个读者别把它推广到别处；压缩是
非目标。

replay 的三条容错是同一个取向——**一条坏行的代价是那一行，不是那份转录**：

- 文件不存在 = 空快照，不是错误（从没聊过的控制台是正常的首次状态）；
- 解不出来、或字段不成形的行跳过（`toTurn` 返回 `null` 而不是抛）；
- 会话记录丢了的 turn 被丢掉而不是变成孤儿：它没有地方渲染，留着只会让轮数和转录对不上
  （`consoleChat.ts` 的 replay 段）。

目录 0700、文件 0600。**路径不在落盘模块里拼**：它从 `consoleArgs.ts` 来、派生自
`occConfigPath()`，和仓库里每一条带身份的路径同一条规矩（CLAUDE.md §1.1②）——
`OCC_CONFIG_DIR` 因此对它同样有效，演示拓扑里每个配置根一份转录。

写盘失败不会把发送带下去：那一轮仍在屏幕上、仍在线上，丢掉的只是它的持久性，原因由
`onError` 写到 stderr（`consoleChat.ts` 的 `persist`、`console.ts` 的 `wireChat`）。

### 6.6 实时性：一条 SSE，事件不带内容

`GET /v0/chat/stream` 是一条 Server-Sent Events 流。**每个事件只有
`{sessionId, revision}`**，页面拿到之后回头去取服务端渲染好的片段。把消息正文顺着这条
管子推下去只会少写一行，却会给远端 agent 的输出开**第二条**进 DOM 的路，而
`view/chat.ts` 在出口转义的全部意义就是这样的路只有一条（`http.ts` 的 `chatStream`、
`deps.ts` 的 `ChatUpdate`）。`revision` 单调递增，客户端据此判断自己有没有漏掉一次。

**心跳 15 s，而 `Bun.serve` 的 `idleTimeout` 是从它算出来的**：
`min(255, ceil(15 s × 2))`。这不是凑数——`Bun.serve` 默认 10 s 空闲就断，15 s 心跳配 10 s
超时等于这条流每十秒被杀一次。Bun 1.3.13 上实测的表现是浏览器报
`ERR_INCOMPLETE_CHUNKED_ENCODING` 然后重拨，于是**页面照常工作**，坏掉的只有一屏错误和
一场重连风暴。把两个数的关系写成算术，是它们不再各自漂移的办法（`http.ts` 的
`startConsoleServer`）。心跳本身也不是装饰：空闲的 `EventSource` 和死掉的连接在浏览器看来
一模一样，而中间每一层——反向代理、笔记本的 NAT 表、SSH 隧道——都会回收长时间不说话的
socket。

流一开先写一行 `retry: 3000` 和一行注释，让浏览器立刻触发 `open`，而不是卡在
`CONNECTING` 等第一个真事件（那可能是几分钟以后）。退订函数与心跳 interval 两个都必须
放掉，无论是浏览器走了（`cancel`）还是 enqueue 因为控制器已关而抛——长驻控制台上漏掉的
订阅是一张只增不减的监听器表。

**拿不到 SSE 就降级成轮询**：没有 `EventSource`、代理在缓冲、服务端把流掐了，页面就每
2 s 取同样那两个片段，并在侧栏写明现在是轮询（`assets/chatClient.ts`）。这不是一个没人
测的降级模式——浏览器旧一点它就是唯一的路，`?stream=off` 正是为此提供的强制开关。页面
在后台时轮询不发请求，切回前台立刻刷一次；别的会话有动静只刷会话轨道、不动当前转录，
因为那条会话的预览和它的「3 分钟前」才是叫人去看一眼的东西。

### 6.7 两个条件才有这个页面，缺一个就是不存在

对话面要**两个条件同时成立**（`src/cli/handlers/console.ts` 的 `wireChat`）：

1. 至少给了一个 `--chat-url`；
2. 环境变量里有一把可用的传输层 PSK。

**PSK 只从环境变量取，没有对应的命令行选项**，与唤醒面同一条纪律（§4.4）。

缺任何一个，`ConsoleDeps.chat` 就留空，而后果与唤醒面**不同**：不是渲染一个禁用的表单，
而是**整个 `/chat` 页面不存在**，主页侧栏也不给入口。取舍不同是因为两者不是一种东西——
唤醒是主页上的**一块**，藏起来会让人以为面板坏了；对话是**另一个页面**，一个打开就说
「这里什么都没有」的页面不如不给入口（`deps.ts` 的 `ChatPort`、`view/page.ts` 的
`chatEnabled`）。

没有通道时两个答案是分开的：`/chat` 答 **404**（这个实例上没有这个页面），`/v0/chat/*`
答 **501**（这条路由在这个版本里有，只是这台控制台后面没有通道）。浏览器拿到诚实的答案，
脚本拿到能诊断的答案。**两者都在 admin 判定之后**——先判角色再判存在性，否则匿名调用者
能靠比较 401 与 501 探出哪台控制台接了对话面（`http.ts` 的 `dispatchChatApi` 与 `route`）。

`--chat-from` 写坏了落在同一处：地址规则住在 `assertAddress`，参数解析不抄第二份，抛出来
的原因被 `wireChat` 接住，控制台照常起来，只是没有对话面。stdout 的 `chat` 那一行说明是
启用了还是哪一种没启用；启用时另打一行 `chat-store`（§2.1 的那几行）。

### 6.8 Bearer 会话的跨页链接把 token 放在查询串里

顶层导航带不了 `Authorization` 头，所以两个方向的侧栏链接都由客户端在渲染之后把 token
补进 href 的查询串（`assets/client.ts` 与 `assets/chatClient.ts` 里的
`paintCrossPageLink`）——和 CLI banner 打印的那条 `?token=` 是同一个位置、同一份暴露面。
服务端渲染出去的是不带 token 的那一版。

**这件事现在只对 Bearer 会话成立。**cookie 会话的 `localStorage` 里什么都没有，也不需要
有：浏览器会自己把 cookie 附到那次导航上（`document` 等级，§5.1）。所以**没有 token 时
链接原样留着，如今是常态而不是坏掉**——它要么被 cookie 认证，要么诚实地把人送到登录页。

到站后页面第一件事仍是把 token 从地址栏洗掉（读进 localStorage 后 `history.replaceState`
重写 URL）。**切换会话仍然不是一次导航，但理由变了**：cookie 会话下 `/chat?session=…` 的
顶层导航是活得下来的——浏览器会带上 cookie。留着 `fetch` 交换，是因为**两种凭据只应该有
一种行为**：一种凭据下换两个片段、另一种凭据下整篇重载文档，那是两条都要维持为真的路径
（`assets/chatClient.ts` 的 `openSession` 注释）。Bearer 会话那边的老理由也还在：token 一
洗掉，导航就当场 401。

同一条约束的另一个出口是流：`EventSource` 也带不了头，所以 `/v0/chat/stream` 的 token 同样
走查询串，或者干脆靠 cookie——`auth.ts` 接受后两个位置，正是为了这一类调用（§4.1），而
它单独付的代价写在 §5.1。

---

## §7 它读什么，不读什么

### 7.1 读

| 端口 | 读什么 | 挂了会怎样 |
| --- | --- | --- |
| `RegistryPort` | 注册中心 HTTP v0（`GET/POST /v0/agents`、`DELETE`、`POST …/heartbeat`），5 s 超时 | **页面照常打开**，名册那栏显示 `unreachable` 与地址。网络失败一律转成失败值，从不抛 |
| `AuditPort` | 本机审计链文件，**只读** | 文件不存在 = **空页面，不是错误**（刚起的节点还没产生审计是正常状态）。哈希链断了会如实显示，不吞 |
| `LimitsSnapshot` | `LIMITS`（`@qianmo/protocol`）、`RUNTIME_RATE`（`@qianmo/router`）、`DEFAULT_TTL_MS`（`@qianmo/registry`） | 常量，不会挂 |
| `WakePort` | —（只写） | 见 §4.4 |

三个上限的数字**一律 import，不抄**。协议速率与运行时速率在页面上是**两列**，不是
一个数：章程 AC-3 要求两者独立验证且不得混为一谈（`packages/router/src/rate.ts` 的
模块注释解释了为什么运行时那条不放进 `LIMITS`）。

### 7.2 不读

- **不碰任何私钥。**节点身份的私钥半边在节点自己的配置根里，控制台没有读它的路径。
  名册里出现的 `publicKey` 是注册中心本来就公开的那一半，没发布时字段直接缺席。
- **不读会话内容。**transcript、消息 payload、prompt 一概不经过这里。审计链本身就
  **不记录 payload**（只有 id、code、计数——`packages/audit/src/record.ts`），所以
  「把一条链贴进工单前要不要脱敏」这个问题在这里不存在。
- **审计链只读。**这个端口连一个能追加的方法都没有。审计链唯一的写入口是节点进程
  自己的 append-only fd。
- **不改 settings、不改配置根。**控制台没有任何写本机配置的路径。

---

## §8 已知边界

按「会咬人的程度」排。

### 8.1 没有账号体系

两个共享 token 就是全部的身份概念。**谁拿到 admin token，谁就是同一个人**——面板上
没有「是谁注销了这个 agent」，审计链上也不会因为动作来自控制台而多出一个操作者字段。

这是章程 **N-2** 的直接后果（M0/本阶段不做账号体系与租户隔离），不是疏漏。真正的
账号与授权链是 M1「注册发现产品化」与「权限模型上线」两行各自的事。

**推论**：token 要当密码管——别提交进仓库、别写进共享的 shell profile、换人就换 token
（重启控制台即可，控制台自己不落盘任何 token；用 `--*-token-file` 时那份文件是运维自己
的，不是控制台写的）。

**登录页给 token 加了第三个落脚点：浏览器的 cookie jar，12 小时**（`SESSION_MAX_AGE_SECONDS`）。
另外两个是操作者手里的那份和页面的 `localStorage`。三个都要一起想：

- **cookie 里装的就是 token 本身。**这里**刻意没有做**「服务端签发一个 session id、另存一张
  表」那一套——理由与代价在 `auth.ts` 的模块注释里，本文不复制。
- **所以没有服务端吊销。**一枚外泄的 cookie 一直有效**到 token 本身改变为止**（也就是重启
  控制台换 token），12 小时的 `Max-Age` 只是让它自己过期，不是让你能撤销它。
- **`退出` 只清浏览器那一份**：`POST /logout` 发一枚清空的 cookie、客户端顺手扔掉
  `localStorage` 里那份副本。它是「这台机器上的这个人不再持有凭据」，不是「这枚凭据作废」。
  两者的差别在丢了笔记本的那天才会显现，而那天要做的是换 token。

### 8.2 注册中心本身没有任何鉴权

`packages/registry/src/http.ts` 里**没有一行 token 检查**：能连上注册中心端口的人，
就能注册、注销、心跳任何地址。

所以控制台的 admin token **保护的只是控制台自己**，不是注册中心。由此得出一条硬规矩：

> **绝不能把注册中心暴露到回环之外。**

控制台反倒是那个可以（在给了 token 之后）稍微放开一点的东西；注册中心不是。给注册
中心加鉴权属于 M1「权限模型上线」，不在本包。

### 8.3 审计链「外部改动无法阻止，但一定被检测到（锚定窗口内除外）」

审计链的三句承诺要分清（`packages/audit/src/index.ts` 的模块注释写得很小心）：

1. 写入方**确实无法修改**（append-only fd，没有任何 seek/delete 方法）；✅
2. 外部改动**确实可检测**（哈希链）；✅ —— 控制台会把 `intact: false` 和问题条数显示
   出来，不吞；
3. 外部改动**无法阻止，但一定被检测到（锚定窗口内除外）**。✅

P11.4 的机外见证已接入审计页：链内断裂显示「断裂」，链内自洽但机外摘要不符显示
「锚点不符」，未配置或已陈旧的锚点显示「未见证」。完整边界、锚定窗口和见证侧失陷域
只见 [`audit-witness.md`](./audit-witness.md) §7；这里不复制。

### 8.4 其他

| 边界 | 说明 |
| --- | --- |
| 没有 TLS | 只在回环上安全。跨机器用 SSH 端口转发（§4.2） |
| 限流只有登录路由一处 | 见下。面板其余 HTTP 面（名册、审计、片段、对话、SSE）仍然不限流，回环 + token 是它们的全部防线 |
| 审计链全量读进内存 | `readTrail` 一次性读整个文件。链很长时首屏会慢；页面侧有尾部条数上限兜着，但这不是分页 |
| 一次只看一条审计链 | 每个节点一条链，跨节点还原要么在同一台机器上换 `--audit`，要么起多个控制台 |
| 名册即注册中心的视图 | 注册中心是内存表（可选文件落盘），控制台不缓存也不补齐。它显示不出来的东西，注册中心里就没有 |

**登录路由那一处限流长这样**（`packages/console/src/throttle.ts`）：前 5 次失败免罚
（打错字不是攻击），之后每多失一次，封锁时长翻一倍——第 6 次失败罚 1 s、第 7 次 2 s、
第 8 次 4 s……**上限 300 s**（从第 15 次失败起就是这个封顶值），计数器**闲置 1 小时即
遗忘**，一次成功登录直接清零。它守的不是「32 字符随机串会不会被猜中」，而是登录**表单**
新造出来的那件事：在它存在之前，猜测意味着写一个脚本去驱动 JSON API；一个答 200 或 401
的文本框，是任何找到这个端口的人都能从浏览器标签页里驱动的猜测预言机。计数器只在内存里
——控制台本来就没有活过重启的状态，重启就诚实地忘掉。

**它在单层反向代理后面会退化成一个全局桶**，这件事要写清楚：计数的键是 socket 的对端
地址，**绝不是 `X-Forwarded-For`**——直连时那个头由客户端自己写，信它等于让一个攻击者
每次尝试都换一个新桶，这个文件就没有存在的意义了。代价是反代后面所有人共享
`127.0.0.1` 一个桶：**好处**是任意 IP 的攻击者都被同一条曲线限住（被猜的是**控制台**，
不是某个调用者）；**坏处**是一个连错密码的合法运维会把其他人一起挡住，最坏 5 分钟。
真要修得先有 `--trusted-proxy` 之类的显式信任声明 + 受控解析 `X-Forwarded-For`——**在
那之前，「反代上加一条 `limit_req` 就行了」不是替代品**：那条规则是 per-location 的，而
本控制台的实时面（SSE 流、轮询）恰恰是这种规则通常要跳过的那些，何况它住在一个本仓库
不拥有、也无法测试的配置文件里。

---

## §9 相关文件

| 文件 | 是什么 |
| --- | --- |
| `packages/console/src/deps.ts` | **五个端口的契约**。改端口形状从这里开始 |
| `packages/console/src/auth.ts` | token 策略（生成 / 校验 / 角色判定 / 三个位置）与 **cookie 那套论证**的唯一出处（§4.1） |
| `packages/console/src/throttle.ts` | 登录失败退避：免罚次数、翻倍、上限、遗忘窗口，以及「为什么反代的 `limit_req` 顶不了它」（§8.4） |
| `packages/console/src/view/login.ts` | `/login` 那张卡片。包里唯一没有 `<script>` 的页面，理由在模块注释 |
| `packages/console/src/http.ts` | 路由、鉴权门、三个保护等级的分派（§5.1）、JSON 与 HTML 片段 |
| `packages/console/src/view/` | 服务端渲染 |
| `packages/console/src/view/chat.ts`、`chatPage.ts` | 对话面的渲染：转录与会话轨道、`/chat` 那份文档（§6.1） |
| `packages/console/src/assets/chatClient.ts` | 对话页的客户端常量：片段替换、SSE 与降级轮询、跨页链接签 token（§6.6、§6.8） |
| `src/cli/handlers/consoleArgs.ts` | 参数解析（纯函数）与 `--help` 全文，**不 import 控制台包** |
| `scripts/entrypoints.ts` | 三个 `bin` 入口的生成处，含 `qm` 为什么把身份写死在文件里、以及那里的 `await import` 与 `??=` 各自在挡什么（§2.1） |
| `src/cli/handlers/consoleTokenSources.ts` | 两枚 token 的三个入口与优先级、token 文件的权限检查（§3.1） |
| `src/cli/handlers/consolePorts.ts` | 注册中心 / 审计 / 上限 / 唤醒四个端口的生产实现 |
| `src/cli/handlers/consoleChat.ts` | `ChatPort` 的生产实现：拨号、回程关联、允许名单（§6.2、§6.3） |
| `src/cli/handlers/consoleChatStore.ts` | 会话与转录的 NDJSON 落盘与 replay（§6.5） |
| `src/cli/handlers/console.ts` | 启动面：注入、`resolveTokens`、打印、信号 |
| `docs/dev/demo-env.md` §2.4 | 端口分配表。改默认端口前先看它 |
| `src/cli/handlers/watch.ts` | `qm watch` 的全部：作业文件解析、拨号与握住连接、fire 与 notify 的审计写入（§10） |
| `packages/scheduler/README.md` | 调度器包本身：一次性预约、CAS、补跑塌缩、失败退避（§10） |
| `docs/dev/node-provisioning.md` | **节点装机与接网设计**：控制台上填 SSH 凭证把一台机器变成节点。它给控制台加的是第三枚 `provision` token（与 view / admin **互不包含**）与五类钉死的动作，本文的鉴权模型是它的地基 |

---

## §10 值守作业（`qm watch`）

**这不是控制台的一个页面，是另一个进程。**P13.6 把定时反转到了中枢侧：作业的
时间表全部住在中枢，节点侧一行调度状态都没有（`docs/dev/resident-botization.md`
§4.1）。跑它的入口是 `qm watch`，与 `qm console` 各起各的——控制台的作业页与通知页
本批次**没有做**，见下面的「已知边界」。

### §10.1 怎么起一个真实值守作业

三步，第三步之后这个进程就不该再退了。

**① 写一个作业文件**（JSON 数组，一项一个作业）：

```json
[
  {
    "id": "disk-watch",
    "title": "每十分钟看一次 beta-1 的磁盘",
    "target": "qianmo://beta-1/reviewer",
    "url": "ws://127.0.0.1:38611",
    "prompt": "检查 / 与 /var 的使用率。任一超过 90% 就调用 qianmo_notify（kind=watch、severity=warn、dedupKey 用挂载点）告诉运维；否则什么都不用做，正常结束即可。",
    "schedule": { "everyMs": 600000 },
    "taskTtlMs": 900000,
    "notifyPolicy": "agent-initiated"
  }
]
```

- `target` 是节点上的 agent 地址，`url` 是那台节点的**入站** ws（中枢拨过去）。两个字段
  分工不同：调度器只认 `target`，`url` 由 `qm watch` 自己读——调度包里没有传输层，这条
  边界是刻意的。
- `schedule.everyMs` 是周期；要固定相位（比如每天 09:00）就再给一个 `anchorMs`。**不写
  `anchorMs` 的作业在第一次规划时就会跑一次**，那一次是用来给网格定相的（理由写在
  `packages/scheduler/src/reserve.ts`）。
- `taskTtlMs` **必填、且故意不吃协议默认的 5 分钟**：值守作业跑二十分钟是常态，而
  「任务能跑多久」只允许由发送方声明，不允许节点自己偷偷续命（hermes B10）。
- **prompt 里要明说「没事就什么都别做」。**产出默认静默是设计的一半——turn 的结果照常
  回 `task.result` 进审计链，但**只有 agent 显式调 `qianmo_notify` 才会有人被打扰**。

**② 把 PSK 放进环境**（与目标节点共享的那把；命令行上不接受，那等于写进 `ps` 输出）：

```bash
export QIANMO_TRANSPORT_PSK=...  # 变量名的唯一出处是 @qianmo/transport 的 PSK_ENV_VAR
export OCC_IDENTITY=qianmo       # qm 入口已经写死，手工跑 occ 时要显式给
```

**③ 起它**：

```bash
qm watch --jobs ./jobs.json --from qianmo://hub/console
# 冒烟：只把此刻到点的作业跑一遍就退
qm watch --jobs ./jobs.json --from qianmo://hub/console --once
```

`--from` 是中枢自己的地址：它既是审计链的链头，也是每条通知回寄的地址。状态默认落在
`<config>/qianmo/scheduler`（`--state-dir` 可改），里面两样东西——`state.json` 记每个作业
上次跑到哪，`claims/` 每个 `(jobId, fireAtMs)` 一个空文件。**两个 `qm watch` 指向同一个
目录是被支持的用法**：抢同一格的时候，赢家由 `O_EXCL` 在内核里决出，输的那个把这一格
记成 `preempted` 走人（roadmap F7）。

### §10.2 怎么确认它在跑

| 想知道 | 看哪儿 |
| --- | --- |
| 中枢有没有按时发 | 审计链里 `source=scheduler`、`kind=watch_fire`（`qm audit`，或控制台审计页按来源筛 `scheduler`） |
| 通知有没有真到人眼前 | 同一条链上 `kind=watch_notify_received`；节点那侧对应 `source=resident` 的 `notify_sent` / `notify_delivered` |
| 有没有通知被压着没发出去 | 节点侧 `notify_held`（原因 `no_channel` 或 `budget`）与 `notify_abandoned` |
| 节点这条命是不是被杀过 | `<config>/resident/lifecycle.json`（P13.5 的终止取证哨兵） |
| 停手 | `touch <config>/qianmo/scheduler/ESTOP`。**只挡新的 fire，在途一律不杀**——节点欠着别人一条 `task.result`，杀掉是把「慢答案」变成「丢答案」。删掉文件即恢复，没有需要重启的东西 |

七天连续运行的判据配套（`resident-botization.md` §4.1 末段）：lifecycle 哨兵七天内没有
`phase=running` 的孤儿记录；`watch_fire` 的条数与作业周期对得上；节点侧 notify 台账里没有
超过一个 TTL 窗口还挂着的条目。

### §10.3 已知边界

- **控制台没有作业页与通知页。**本批次的通知出口是 `qm watch` 的 stdout 加审计链；
  `packages/console` 一行没动。要在面板上看，先按 §9 的端口形状加 `SchedulerPort` /
  `NotifyPort`。
- **`notifyPolicy` 只被记录与透传，没有任何一处读它做判断。**它是留给「always / silent」
  那两档策略的位置，本批次三档行为一致——打不打扰人完全由 agent 自己决定。
- **中枢是定时的单点。**这是 A7 的刻意背离（节点侧 ticker 会让节点永不空闲、永不冻结，
  直接抵消 R-3 的休眠形态），代价就是中枢不在的时候没人发起。补偿是「缺席可见」：
  `SchedulerRunner.status()` 的 `lastTickAt` 就是给这个用的，接到面板上是遗留项。
