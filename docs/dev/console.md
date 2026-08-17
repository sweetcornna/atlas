# 阡陌控制面板（`occ console`）

> **v0.1 · 2026-08-17 · 本地回环已跑通**
>
> 一条命令起一个网页，把「注册中心里有哪些智能体」「审计链上发生过什么」「协议
> 上限是多少」摆在一页上，并允许注册、注销、心跳、唤醒四个动作。**面向的是内测
> 用户，不是开发者**——出口判据里的那句「无需接触 CLI」指的就是它。

| 项 | 内容 |
| --- | --- |
| 范围依据 | roadmap **M1「注册发现产品化」**：内容「最小 Web 控制台（智能体列表、状态、消息链查看）、账号体系、智能体生命周期管理」，出口判据「**内测用户无需接触 CLI 即可完成注册与查看**」。本包只做这一行里的**最小 Web 控制台**那一段 |
| 明确不在本包内 | **账号体系**（章程 N-2：M0/本包不做账号与租户隔离，M1 另排）、权限模型（M1「权限模型上线」是另一行） |
| 交付物 | `packages/console/`（`@qianmo/console`）、`src/cli/handlers/console{,Args,Ports}.ts`、`src/entrypoints/cli.tsx` 的分派、本文 |
| 依赖 | `@qianmo/audit`（只读）、`@qianmo/protocol`、`@qianmo/registry`、`@qianmo/router`；运行时 Bun（`Bun.serve`） |
| 身份 | **`OCC_IDENTITY=qianmo`**，与 `occ resident` / `occ audit` / `occ resident-wake` 同一条前置校验 |

---

## §1 它是什么

一个**单进程、单页面、零构建**的运维面板。

- **零构建**：没有前端工具链。HTML 在服务端拼字符串，CSS 与 JS 是两个常量
  （`packages/console/src/assets/`）。加一个 npm 依赖就是给内测环境加一条供应链，
  而这个面板要解决的问题不值那个价钱。
- **单进程**：`occ console` 起的就是它自己，不需要注册中心或节点跟它在同一台机器
  上，也不要求它们活着——注册中心挂了，页面照常打开，只是名册那一栏显示不可达。
- **不是网关**：它**不转发**任何东西给注册中心之外的地方，唤醒的目标地址钉死在
  启动参数上（§4.4）。

架构上它是一个叶子包 + 一层 host 适配：包里只有路由、鉴权、渲染，**它不知道注册
中心在哪、审计链是哪个文件、PSK 是什么**；这些由 `occ console` 这个 handler 以四个
端口的形式注进去（`packages/console/src/deps.ts` 是那份契约）。方向和 tool-runtime
的六个 facade 一致：包声明接口，host 实现。好处很直接——包能用纯对象做单测，而
「注册中心挂了会怎样」这种事在测试里是一行假端口，不是一个要起停的服务。

---

## §2 怎么起

### 2.1 最短路径

```bash
OCC_IDENTITY=qianmo bun run dev console
```

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
label        127.0.0.1:38613
```

`open` 那一行是可以直接点开的——token 就在查询串里。**只有自动生成的 token 才会
被打印**；显式提供的那两个不回显（§4.2）。

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

### 2.3 起不来的三种常见原因

| 现象 | 原因 |
| --- | --- |
| `console requires OCC_IDENTITY=qianmo` | 忘了设身份变量。控制台属于阡陌节点态，不在 occ 默认身份下跑 |
| `控制台绑定在非环回地址 … 必须显式提供 view token` | 用了 `--hostname 0.0.0.0`（或任何非回环地址）却没给两个 token。这是**故意**的，理由见 §4.2 |
| `EADDRINUSE` | 38613 被占。换 `--port`，或者先看看是不是已经起了一个 |

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
| `--label <text>` | `hostname:port` | 页头标签，≤120 字符。两个控制台开在两个标签页时，靠它区分 |
| `--view-token <token>` | 环回时自动生成 | 只读凭据 |
| `--admin-token <token>` | 环回时自动生成 | 读 + 写（注册/注销/心跳/唤醒）凭据 |

两个 token 都至少 16 字符且必须互不相同，这条对自动生成的也一样校验
（`packages/console/src/auth.ts` 的 `resolveTokens`）。

---

## §4 鉴权模型

### 4.1 两个 token，不是一个带 scope 的

读面（名册、审计链、上限）和写面（注册、注销、心跳、唤醒）是两个**不同的字符串**，
分别比对。理由和备份服务那边一样：一个带 `scope` 字段的单 token，会把「只读用户
不能唤醒节点」这件事放在一个布尔量的正确性上。admin token 同时满足所有只读路由
——一个人一份凭据是常态，逼他拿两份等于他只会拿一份。

比对是**定长时间**的（`timingSafeEqual`）。

token 可以走两个位置（`presentedTokenOf`）：

- `Authorization: Bearer <token>` —— 页面自己的 `fetch` 和 `curl` 用这个；
- `?token=<token>` —— **浏览器导航**用这个，因为地址栏里敲进去的 URL 没法带 header。
  CLI 打印那条带 token 的 URL，就是为了这个。

**故意不用 cookie**：cookie 是浏览器自动附带的，那会让任何一个本地页面都能对这个
回环端口发出带凭据的跨源 `POST`，每个 admin 路由都变成 CSRF 靶子。「凭据不是环境
自带的」本身就是这里的 CSRF 防线。

### 4.2 为什么非环回必须显式给 token

`resolveTokens` 的规则只有两条半：

1. **回环 + 没给** → 自动生成，并把带 token 的 URL 打到 stdout。控制台只有本机能连，
   操作者不付任何代价就拿到了一个能挡住同机其他进程误闯的凭据。
2. **只要不是回环** → 两个 token 都必须显式提供，否则**直接抛错、拒绝启动**。
3. （总是）长度 ≥16 且两者不同。

第 2 条是这份设计里唯一一条「宁可起不来」的规则，理由是失效模式不对称：

- 如果自动生成也适用于 `0.0.0.0`，那么 `occ console --hostname 0.0.0.0` 就会在一台
  VPS 的公网口上起一个面板，凭据只出现在一行**没人在看的 stdout** 里（内测环境里
  它大概率被 nohup 到某个日志文件）。谁先扫到这个端口，谁就拿到了名册、审计链和
  那个唤醒按钮。
- 反过来，「忘了给 token 所以起不来」是一个**当场就会被发现**的失败。

一个只在没人看日志时才生效的漏洞，和一个立刻报错的启动失败——只有后者是可以接受的。

**另外**：这条规则不等于「给了 token 就可以挂公网」。控制台没有 TLS、没有速率限制、
没有账号体系（§6.3），要跨机器访问请用 SSH 端口转发：

```bash
ssh -L 38613:127.0.0.1:38613 <host>     # 然后在本地浏览器开 127.0.0.1:38613
```

### 4.3 哪些路由不要凭据

只有三条，都是**公开的**：

- `GET /v0/health` —— 存活探针。一个要凭据的探针是一个没人接的探针。
- `GET /assets/app.css`、`GET /assets/app.js` —— 两个静态常量，不含任何数据。

其余全部要 view 或 admin。

### 4.4 唤醒面为什么可能是灰的

唤醒需要**两个条件同时成立**：

1. 启动时给了 `--wake-url`；
2. 环境变量 `QIANMO_TRANSPORT_PSK` 里有一把可用的 PSK。

缺任何一个，`ConsoleDeps.wake` 就留空，页面把唤醒表单渲染成**禁用并显示原因**——
这比给一个按下去必定报错的按钮诚实。stdout 的 `wake` 那一行也会说明是哪种情况。

**PSK 只从环境变量取，没有对应的命令行选项。**命令行上的密钥就是这台机器每一份
进程列表里的密钥，和 `occ resident --backup-url` 要求 `QIANMO_BACKUP_WRITE_TOKEN`
走环境变量是同一条纪律。

**唤醒目标钉死在 `--wake-url` 上。**页面传来的 `url` 只被允许等于它（或留空）；不等
就拒绝。否则这个端口等于「任何拿到 admin token 的人都能让本机往任意 ws 地址发一条
带 PSK 握手的消息」，而 admin token 的门槛远低于「能改本机的 systemd 单元」。

页面上能排的延时上限是 **60 s**：`executeResidentWake` 是先等够再发，而它是在一个
HTTP 请求里被调用的——十分钟的定时唤醒等于一个挂十分钟的请求。真要排长定时器，用
`occ resident-wake --after-ms`，那是个能自己活着的进程。

---

## §5 路由表

`v0` 是 API，`fragments` 是页面局部刷新用的 HTML 片段，两者数据同源。

| 方法 | 路径 | 角色 | 说明 |
| --- | --- | --- | --- |
| GET | `/` | view | 整页 |
| GET | `/assets/app.css`、`/assets/app.js` | 公开 | 两个静态常量 |
| GET | `/v0/health` | 公开 | `{ "status": "ok" }` |
| GET | `/v0/limits` | view | 协议与运行时上限（§6.1） |
| GET | `/v0/agents` | view | 名册 |
| POST | `/v0/agents` | **admin** | 注册 |
| DELETE | `/v0/agents/<地址>` | **admin** | 注销 |
| POST | `/v0/agents/<地址>/heartbeat` | **admin** | 续租 |
| GET | `/v0/audit?…` | view | 审计记录（过滤见下） |
| GET | `/v0/audit/chain/<traceId>` | view | 消息链还原 |
| POST | `/v0/wake` | **admin** | 唤醒 |
| GET | `/fragments/{roster,audit,limits}` | view | HTML 片段 |
| GET | `/fragments/chain/<traceId>` | view | HTML 片段 |

**地址与 traceId 都在单个 path segment 里百分号编码**：
`qianmo://node-b/reviewer` → `qianmo%3A%2F%2Fnode-b%2Freviewer`。这和注册中心
HTTP v0 自己的约定一致（`packages/registry/src/http.ts`），编错了不会报错，只会安静
地路由到另一条规则上去。

`/v0/audit` 的查询参数：`source`、`outcome`、`traceId`、`taskId`、`agent`、`from`、
`to`（ISO 时间或 epoch 毫秒）、`limit`。全部是 AND；`limit` 取的是**尾部** N 条，和
`occ audit --limit` 同一语义。

---

## §6 它读什么，不读什么

### 6.1 读

| 端口 | 读什么 | 挂了会怎样 |
| --- | --- | --- |
| `RegistryPort` | 注册中心 HTTP v0（`GET/POST /v0/agents`、`DELETE`、`POST …/heartbeat`），5 s 超时 | **页面照常打开**，名册那栏显示 `unreachable` 与地址。网络失败一律转成失败值，从不抛 |
| `AuditPort` | 本机审计链文件，**只读** | 文件不存在 = **空页面，不是错误**（刚起的节点还没产生审计是正常状态）。哈希链断了会如实显示，不吞 |
| `LimitsSnapshot` | `LIMITS`（`@qianmo/protocol`）、`RUNTIME_RATE`（`@qianmo/router`）、`DEFAULT_TTL_MS`（`@qianmo/registry`） | 常量，不会挂 |
| `WakePort` | —（只写） | 见 §4.4 |

三个上限的数字**一律 import，不抄**。协议速率与运行时速率在页面上是**两列**，不是
一个数：章程 AC-3 要求两者独立验证且不得混为一谈（`packages/router/src/rate.ts` 的
模块注释解释了为什么运行时那条不放进 `LIMITS`）。

### 6.2 不读

- **不碰任何私钥。**节点身份的私钥半边在节点自己的配置根里，控制台没有读它的路径。
  名册里出现的 `publicKey` 是注册中心本来就公开的那一半，没发布时字段直接缺席。
- **不读会话内容。**transcript、消息 payload、prompt 一概不经过这里。审计链本身就
  **不记录 payload**（只有 id、code、计数——`packages/audit/src/record.ts`），所以
  「把一条链贴进工单前要不要脱敏」这个问题在这里不存在。
- **审计链只读。**这个端口连一个能追加的方法都没有。审计链唯一的写入口是节点进程
  自己的 append-only fd。
- **不改 settings、不改配置根。**控制台没有任何写本机配置的路径。

---

## §7 已知边界

按「会咬人的程度」排。

### 7.1 没有账号体系

两个共享 token 就是全部的身份概念。**谁拿到 admin token，谁就是同一个人**——面板上
没有「是谁注销了这个 agent」，审计链上也不会因为动作来自控制台而多出一个操作者字段。

这是章程 **N-2** 的直接后果（M0/本阶段不做账号体系与租户隔离），不是疏漏。真正的
账号与授权链是 M1「注册发现产品化」与「权限模型上线」两行各自的事。

**推论**：token 要当密码管——别提交进仓库、别写进共享的 shell profile、换人就换 token
（重启控制台即可，token 不落盘）。

### 7.2 注册中心本身没有任何鉴权

`packages/registry/src/http.ts` 里**没有一行 token 检查**：能连上注册中心端口的人，
就能注册、注销、心跳任何地址。

所以控制台的 admin token **保护的只是控制台自己**，不是注册中心。由此得出一条硬规矩：

> **绝不能把注册中心暴露到回环之外。**

控制台反倒是那个可以（在给了 token 之后）稍微放开一点的东西；注册中心不是。给注册
中心加鉴权属于 M1「权限模型上线」，不在本包。

### 7.3 审计链「外部改动无法阻止」

审计链的三句承诺要分清（`packages/audit/src/index.ts` 的模块注释写得很小心）：

1. 写入方**确实无法修改**（append-only fd，没有任何 seek/delete 方法）；✅
2. 外部改动**确实可检测**（哈希链）；✅ —— 控制台会把 `intact: false` 和问题条数显示
   出来，不吞；
3. 外部改动**没有被阻止**。❌

第 3 条需要 WORM 挂载或一个机外见证者，本阶段两样都没有。也就是说：**一个有本机
写权限的人可以整篇重写审计链并重算全部哈希，控制台会显示「完好」。**

这条缺口已登记为 **P11.4「审计的机外见证（选型 + 最小验证）」**，判据就是「人为整篇
重写并重算哈希后仍能被发现」。在它落地之前，控制台上的「完好」只代表「没有人**不
小心**改坏它」。

### 7.4 其他

| 边界 | 说明 |
| --- | --- |
| 没有 TLS | 只在回环上安全。跨机器用 SSH 端口转发（§4.2） |
| 没有速率限制 | 面板自身的 HTTP 面不限流。回环 + token 是当前的全部防线 |
| 审计链全量读进内存 | `readTrail` 一次性读整个文件。链很长时首屏会慢；页面侧有尾部条数上限兜着，但这不是分页 |
| 一次只看一条审计链 | 每个节点一条链，跨节点还原要么在同一台机器上换 `--audit`，要么起多个控制台 |
| 名册即注册中心的视图 | 注册中心是内存表（可选文件落盘），控制台不缓存也不补齐。它显示不出来的东西，注册中心里就没有 |

---

## §8 相关文件

| 文件 | 是什么 |
| --- | --- |
| `packages/console/src/deps.ts` | **四个端口的契约**。改端口形状从这里开始 |
| `packages/console/src/auth.ts` | token 策略（生成 / 校验 / 角色判定）的唯一出处 |
| `packages/console/src/http.ts` | 路由、鉴权门、JSON 与 HTML 片段 |
| `packages/console/src/view/` | 服务端渲染 |
| `src/cli/handlers/consoleArgs.ts` | 参数解析（纯函数），**不 import 控制台包** |
| `src/cli/handlers/consolePorts.ts` | 四个端口的生产实现 |
| `src/cli/handlers/console.ts` | 启动面：注入、`resolveTokens`、打印、信号 |
| `docs/dev/demo-env.md` §2.4 | 端口分配表。改默认端口前先看它 |
