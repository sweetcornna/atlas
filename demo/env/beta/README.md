<!-- Copyright 2026 Qianmo AgentNest Team -->
<!-- SPDX-License-Identifier: MIT -->

# demo/env/beta —— 内测拓扑一键起（P11.1 落地包①）

> 形态设计的真源是 [`docs/dev/beta-env.md`](../../../docs/dev/beta-env.md)（v1.0，已评审生效）。
> **本文不复制它**，只写「怎么敲」和「这套脚本做不到什么」。凡是本文与它冲突，以它为准。
>
> 这套脚本是 [`demo/env/`](../) 的**同形派生**：目录布局、三重守卫、pid/日志 helper 一律照抄。
> 演示环境已经证明的四件事（配置根分家、三重守卫、幂等起停、runbook 成本）在这里原样继承，
> 不重新论证（beta-env.md §1）。

## 两条命令

拓扑是「H 上一套 + 每台节点机一个节点」（beta-env.md §2.3）。所以只有两条命令，用 `--role` 区分。

```bash
# ── 任一节点机上（一机一节点）────────────────────────────────────────────────
# 前置：secrets/transport-psk 里已经有**这台机器这个节点**的那一把 PSK（由 H 生成后分发）
./demo/env/beta/beta-up.sh --role node --node <节点名> --agent <名字> --agent <名字>

# ── 宿主 H 上 ───────────────────────────────────────────────────────────────
# 前置：peers.conf 已按各节点机回填的入站端点填好；secrets/peers/<node>.psk 已铺全
./demo/env/beta/beta-up.sh --role host
```

H 腿会按 `peers.conf` 决定每个节点怎么拨：**没有 `node` 坐标行的直连，有的走 SSH 隧道**
（并按 5 min 单向只读拉一次它的审计链镜像）。隧道与镜像是 `systemd --user` 的模板单元，
单元文件与拉取脚本从 [`ops/`](./ops/) 派生 —— **真源在仓库，不在 H 上**，装好的那几份是
生成物，手改会在下一次 `beta-up.sh` 时被覆盖。详见下面「链路：直连与隧道」。

起完各自自检：

```bash
./demo/env/beta/beta-smoke.sh --role node --node <节点名>   # 节点机上：只证本机那一半
./demo/env/beta/beta-smoke.sh --role host                  # H 上：DoD① 的四条判据都在这里
```

停机 `./demo/env/beta/beta-down.sh`（`beta-down.sh <名字>` 只停一个，即 §6 L0 的第①步；
在 H 上给一个铺过链路的节点名，它的隧道与镜像 timer 也一起停），
回到干净运行态 `./demo/env/beta/beta-reset.sh`（`--purge-links` 连链路的生成物一起删，
下次 `beta-up.sh` 会照仓库重新铺出来；**`mirror/` 一条不动**）。

### 首次装机的完整顺序

前四步与演示环境一字不差（beta-env.md §1 第 4 条：每台机器走同一条 runbook）。

```bash
# ① bun 1.3.13 + node + git —— 装法见 docs/dev/demo-env.md §4.1（无 sudo 也能装）
# ② 取代码、装依赖、构建 occ
./demo/env/bootstrap.sh          # ← 内测沿用演示环境这一条，没有 beta-bootstrap.sh

# ③ 本机那把 PSK。**在 H 上生成，拷过来，不在节点机上生成**（beta-env.md §8.3）
#    H 上：LC_ALL=C od -An -tx1 -N 32 /dev/urandom | tr -d ' \n' > secrets/peers/<node>.psk
mkdir -p ~/qianmo-beta/secrets && chmod 700 ~/qianmo-beta ~/qianmo-beta/secrets
install -m 600 /dev/null ~/qianmo-beta/secrets/transport-psk
# …把 H 生成的那一把写进去（scp / 粘贴，别走命令行参数）

# ④ 起节点
./demo/env/beta/beta-up.sh --role node --node <节点名> --agent planner --agent reviewer

# ⑤ 把它打印的那条「入站端点」回填进 H 的 peers.conf，再在 H 上 beta-up.sh --role host
#    —— 节点入站端口从 H 拨不通时（云厂商安全组），改为在 peers.conf 里给它一条
#       node 坐标行，端点写 ws://127.0.0.1:<H 侧回环口>。见下一节。
```

## 链路：直连与隧道

节点入站端口对 H 开放时什么都不用搭，`peers.conf` 里的端点就是节点机的真实地址。

现场不是这样：节点的入站端口被**云厂商安全组**挡着（实测 22/80/443 通，入站端口与另外
十个候选端口全不通）。所以 `peers.conf` 允许给某个节点加一条 **`node` 坐标行**，H 就为它
建一条 `systemd --user` 的 `ssh -L`（H 回环口 → 节点回环的入站端口），端点改写成那个回环
口，**应用层一行代码不改**。同一条坐标行还定义了审计链的单向只读镜像。

**隧道是「直连不通时的兜底」，不是默认形态**：没有坐标行的节点保持直连
（`node-provisioning.md` §0 第 12 条的控制面 / 数据面分工）。

### `peers.conf` 的两种行

```
# ① 地址行（老格式，一个字没变，老文件原样能读）
qianmo://<node>/<agent>  ws://<节点机地址>:38625

# ② node 坐标行（可选，一行写完，不支持续行）
node <节点名> user=<ssh 用户> host=<节点机地址> port=22 local-port=<H 侧回环口> \
     remote-port=38625 trail=<节点上审计链的绝对路径> key=<H 上的私钥路径>
```

| 键 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `user` / `host` | 是 | | 拼成 `user@host` 交给 ssh。里面出现 `@` 或 `/` 一律拒 |
| `local-port` | 是 | | H 这一侧的回环口。四个节点必须各不相同（撞车会被拒） |
| `port` | 否 | `22` | 节点的 SSH 端口 |
| `remote-port` | 否 | `38625` | 节点侧的入站端口 |
| `trail` | 否 | 无 | 节点上审计链的绝对路径。**给了才做镜像**；不给就只有隧道 |
| `key` | 否 | `QIANMO_BETA_SSH_KEY` | 这条链路用的私钥（H 上的路径；私钥本身永不离开 H） |

向后兼容靠一点：老格式的第一字段必然以 `qianmo://` 开头，所以 `node` 这个关键字不可能和
任何一条合法的老行撞上。**坏行照旧带行号被拒**，未知键、缺必填键、端口非数字、`trail` 非
绝对路径、节点名含 `A-Za-z0-9._-` 之外的字符（它会进 `systemctl` 命令行）也都带行号拒。

还有一条**跨行**的校验：有坐标行的节点，它的每一条地址行端点必须正好是
`ws://127.0.0.1:<local-port>`，否则带两边的值 die。那个不一致正是「名册上在线、拨不通」
（`beta-env.md` §9.1）最常见的来源 —— 链路搭在一个口上，应用拨的是另一个口。

### 生成物在哪

| 路径 | 是什么 | 谁是真源 |
| --- | --- | --- |
| `<root>/ops/tunnel-<node>.env` | 该节点的连通定义（0600，含 SSH 用户与机器地址） | `peers.conf` 的坐标行 |
| `<root>/ops/qianmo-tunnel@.service` | 隧道模板单元 | `demo/env/beta/ops/qianmo-tunnel@.service.in` |
| `<root>/ops/qianmo-mirror@.service` / `.timer` | 镜像 oneshot 与定时器 | 同目录的 `.in` |
| `<root>/ops/mirror-pull.sh` | 拉取脚本（0700） | `demo/env/beta/ops/mirror-pull.sh` |
| `~/.config/systemd/user/qianmo-*.{service,timer}` | 装好的那三份 | `<root>/ops/` 里的同名文件 |

**每次 `beta-up.sh --role host` 都重新派生一遍，且只在内容真的不同时才写。**内容没变就不
`daemon-reload`、不 `enable`、不 `start`；已经在跑的单元**永远不重起**。文件变了而单元正在
跑时，脚本会在末尾列出那些实例并给出维护窗口里的 `systemctl --user restart` 一行 —— systemd
自己不会在任何地方留下这个痕迹。

### 镜像为什么只能是 `ssh cat`

H 那把 key 在各节点的 `authorized_keys` 里带**强制命令**
（`restrict,port-forwarding,permitopen=...,command="/usr/bin/cat -- <链>"`）。强制命令会忽略
客户端发来的命令，于是 `rsync` 协商不到远端的 `--sender`，必然挂在握手上。这不是退化 ——
它正是这把 key 被收紧的证据：它连自己那条审计链之外的任何东西都读不到。链文件只有 KB
量级，全量 `cat` 无代价。`mirror-pull.sh` 里那个 `MIRROR_METHOD=rsync` 分支留着不是为了扩展
性，是为了让「有人把 rsync 写回去」当场报错并说明理由。

### 隧道口上的 TCP 探测是**假绿**

`ssh -L` 的本地口由 **ssh 客户端自己** LISTEN。节点侧那个端口没人监听（或被 `permitopen`
挡住）时，ssh 照样 `accept`，然后立刻把连接关掉。于是「TCP 连得上」只证明 ssh 进程活着，
与节点死活完全无关 —— 单元 `active`、端口通、拨号全超时，三个绿灯一个真相。

处置是两条，都在 `common.sh` 里：

- `beta_endpoint_live <host> <port>` 是**唯一**算数的就绪判据：它发一条普通 GET 并真读一行
  应答，节点的 WebSocket 服务会回 `HTTP/1.1 426 Upgrade Required` —— 那一行只有节点进程能
  产生，中间只转发不应答的链路伪造不出来。
- `beta_tcp_open` 被喂一个隧道口时**直接 die**。把一条恒真的判据留在那儿，比没有判据更糟。

复跑那个对照（在 H 上，不碰四条真隧道）：

```bash
# 另起一条指向节点上某个无人监听端口的隧道，本地口挑一个没被占的
. ~/qianmo-beta/ops/tunnel-<node>.env
ssh -i "$NODE_SSH_KEY" -N -T -o BatchMode=yes -o ExitOnForwardFailure=yes \
    -p "$NODE_SSH_PORT" -L 127.0.0.1:38639:127.0.0.1:38699 "$NODE_SSH_USER@$NODE_SSH_HOST" &
# 旧判据（只开一次 TCP）→ 绿；新判据 → 红
(exec 3<>/dev/tcp/127.0.0.1/38639) && echo 'TCP 绿（假的）'
. demo/env/beta/common.sh; beta_endpoint_live 127.0.0.1 38639 || echo '真握手 红（对的）'
```

## 变量表

一律用环境变量覆盖，脚本里没有任何具体名字、机器名、IP、域名、密钥（beta-env.md 文首）。

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `QIANMO_BETA_ROOT` | `$HOME/qianmo-beta` | 内测根目录。**长驻**，故意在仓库外——它要活过 `git clean`、活过换分支。与演示环境的 `.demo-env` 不是一回事，两者可以在 H 上共存 |
| `QIANMO_BETA_PEERS_FILE` | `$QIANMO_BETA_ROOT/peers.conf` | 地址表（地址行 + 可选的 `node` 坐标行，见上一节）。**H 腿的必填项**，0600，不进仓库 |
| `QIANMO_BETA_REGISTRY_PORT` | `38620` | 注册中心。**永不出回环**（它零鉴权，§9.2） |
| `QIANMO_BETA_CONSOLE_PORT` | `38621` | 控制台。绑回环，对外那一面由反代做 TLS（§2.5） |
| `QIANMO_BETA_NODE_PORT` | `38625` | 节点入站。一机一节点，四台用同一个号不用协调 |
| `QIANMO_BETA_HOST_BIND` | `127.0.0.1` | 注册中心与控制台绑哪。**改成非回环等于同时废掉 §2.5 与 §9.2 两条硬规矩** |
| `QIANMO_BETA_NODE_BIND` | `0.0.0.0` | 节点入站绑哪。默认全网是**有意的**：节点要被 H 拨到，而无 sudo 的 VPS 上没有包过滤，那个端口上唯一的门本来就是 PSK 握手（§2.6/§8.2）。改成 `127.0.0.1` 会得到一个「起得来、名册上在线、H 拨不通」的节点 |
| `QIANMO_BETA_NODE` | `beta-1` | 节点名。**四台机器上必须各不相同**；没给 `--node` 时脚本会 WARN |
| `QIANMO_BETA_AGENTS` | `planner reviewer` | 该节点的 agent（每节点 2 个，按用途分不按人分，§2.2）。也可用重复的 `--agent` 给 |
| `QIANMO_BETA_TEAM` | `atlas` | `occ resident --team` |
| `QIANMO_BETA_AUDIT_NODE` | console.conf > 地址表里第一个节点 | 控制台 `--audit` 指哪条链。一期是单值（§4.3 的现状限制，落地包②抬掉） |
| `QIANMO_BETA_AUDIT_PATH` | console.conf > 由审计节点派生 | 直接指定链文件。**默认会自动区分权威与镜像**：该节点有 `trail=` 坐标（= 链靠镜像拉过来）时派生成 `<root>/mirror/<node>/trail.ndjson`，否则是 `<root>/nodes/<node>/config/...` |
| `QIANMO_BETA_WAKE_NODE` | console.conf > 同 `AUDIT_NODE` | 控制台唤醒目标。一期只能有一个：`--wake-url` 钉死单值，而 PSK 是每进程一把（§8.2） |
| `QIANMO_BETA_LABEL` | console.conf > 由审计节点派生（镜像时带「滞后 ≤ N min」） | 页头标签。它是唯一一个 50 个人都会看到、且不需要账号体系的广播位（§7.4） |
| `QIANMO_BETA_SSH_KEY` | `$HOME/.ssh/id_ed25519_qianmo` | 隧道与镜像共用的私钥（H 上的路径）。单条坐标行可用 `key=` 覆盖 |
| `QIANMO_BETA_MIRROR_INTERVAL_MIN` | `5` | 审计镜像拉取间隔。**它同时决定页头标签里那句「滞后 ≤ N min」**，两处从同一个变量派生 |
| `QIANMO_BETA_BACKUP_URL` | 无 | 节点写快照的 https 地址（§2.7）。**不设就不开备份面**；给了就必须有写 token |
| `QIANMO_BETA_BACKUP_INTERVAL_MS` | `3600000` | §5 的定案（从默认 15 min 调到 60 min，算过账：15 min 是 3.8 GB/天） |
| `QIANMO_BETA_READY_TIMEOUT_S` | `90` | 就绪探测预算。2 vCPU 机器上首次拨号实测 6.5–7.1 s，重试会吸收掉 |

密钥文件（都不由脚本生成，除控制台两枚 token 外——理由见下）：

| 文件 | 在哪台机器 | 装什么 |
| --- | --- | --- |
| `secrets/transport-psk` | 每台节点机 | **只有本机这个节点那一把**（§8.3）。一台 VPS 被拿下时，攻击者只拿到它自己那一把 |
| `secrets/peers/<node>.psk` | 只在 H | **全部四把**（运维副本）。唤醒与投递都从 H 发起 |
| `secrets/console-view-token` / `console-admin-token` | 只在 H | 控制台两枚。首跑时脚本现生成一次并落 0600 文件，**之后跨重启不变**——「显式提供」要的正是这个（§3.2）；控制台自己生成的那条路每次重启都变，50 个人手上的链接会同时失效 |
| `secrets/backup-write-token` | 每台节点机（若开备份面） | 只写。**归档 token 永不下发到节点机**（§2.7） |
| `secrets/backup-archive-token` | 只在 H | 只读归档 |
| `~/.ssh/id_ed25519_qianmo`（可换，见变量表） | 只在 H | 隧道与镜像那把 key。**私钥不离开 H**；它在各节点的 `authorized_keys` 里带强制命令，除了转发那一个端口和 `cat` 自己那条链，什么都做不了 |

非密钥、但同样 0600 且不进仓库的两份：

| 文件 | 装什么 |
| --- | --- |
| `peers.conf` | 地址表 + `node` 坐标行（含机器地址与 SSH 用户） |
| `ops/tunnel-<node>.env` | 由坐标行派生的连通定义。**手改会被覆盖，要改就改 `peers.conf`** |

### `console.conf` —— 审计路径与页头标签的持久化

`<root>/console.conf`（0600）存四个值：`AUDIT_NODE` / `AUDIT_PATH` / `LABEL` / `WAKE_NODE`。

它存在的理由是一次真实事故：这四个值此前**只走环境变量**。控制台一重起（改标签、跟随
升级、机器重启）就静默丢失 —— `--audit` 退回「审计节点在 H 上的权威路径」，而那个节点跑在
另一台机器上，H 上根本没有那个文件；**控制台对不存在的 `--audit` 不报错，页面就是一张空
审计视图**，页头标签也丢掉了「镜像」标注，看的人会以为那是实时的权威链。

优先级是 **环境变量 > `console.conf` > 派生默认**，而且胜出的那个**会被回写** —— 于是「临时
设一次」自动变成「以后都记得」。派生默认本身也修好了：审计节点的链靠镜像拉过来时，路径
指镜像、标签带「（镜像 · 滞后 ≤ N min，权威副本在节点本机）」。

手改这个文件立刻生效（下一次 `beta-up.sh` 起控制台时）。**注意控制台是幂等启动的**：已经
在跑的那一份不会被重起，所以改完要让它生效得 `beta-down.sh console && beta-up.sh --role host`。

## 六个负向用例怎么复跑

删除动作的三重守卫（`beta_guard_root` → 标记文件首行 → 逐路径复核）与演示环境同形，
负向用例照 `demo-env.md` §3.2 的六例，**另加两例**内测特有的。做法：先在目标目录放一个
哨兵文件，跑完复核哨兵原样还在。

```bash
SENT=.qianmo-beta-negtest-sentinel

# 每例先放哨兵，再跑下面这条，最后 `ls` 复核哨兵还在（脚本必须在动任何东西之前退出）
QIANMO_BETA_ROOT=<被测路径> ./demo/env/beta/beta-reset.sh --purge-logs --purge-state --archive-config
QIANMO_BETA_ROOT=<被测路径> ./demo/env/beta/beta-down.sh
```

| # | 被测路径 | 应该被谁拦下 |
| --- | --- | --- |
| 1 | `$HOME` | `beta_guard_root`：不能是家目录 |
| 2 | 仓库根 | `beta_guard_root`：不能是仓库根本身 |
| 3 | `~/.occ/beta` | `beta_guard_root`：落在真实配置根里 |
| 4 | `~/.claude/x` | 同上 |
| 5 | `$OCC_CONFIG_DIR/sub`（外层设了 `OCC_CONFIG_DIR`） | `beta_guard_root`：按调用方环境再拦一次 |
| 6 | 目录存在但没有标记文件 | `beta_require_marker`：不去猜「这大概是我上次建的」 |
| **7** | 目录里有 `.qianmo-demo-env` | 内测特有：那是**演示**环境根。H 上两套拓扑并存（§2.6），传错一个就是内测的 reset 去动演示的数据 |
| **8** | 标记文件首行被改成别的字符串 | `beta_require_marker`：伪造的标记不算数 |

链路那一半的路径不在内测根里（`~/.config/systemd/user/`），guard_root 管不到，所以另有一套
逐路径复核：`beta_assert_unit_file` 只允许动本包那三个文件名、且必须落在 systemd 用户单元
目录里；`beta_stop_link` 与实例名拼接前再过一次 `beta_assert_node_name`（实例名会原样进
`systemctl` 的命令行）。

### `peers.conf` 解析的负向用例

一条都不需要真机，随便找个空目录当 `QIANMO_BETA_ROOT` 就能跑（`beta_load_peers` 在动任何
东西之前就 die）。每一条都应当带**行号**被拒：

| 写法 | 应该被谁拒 |
| --- | --- |
| `node rowan ... local-port=38631` + 地址端点写 `ws://127.0.0.1:38625` | `beta_assert_peers_match_tunnels`：链路搭在一个口、应用拨另一个口 |
| 两条 `node rowan` | 重复坐标：隧道连 A、镜像拉 B |
| 两个节点用同一个 `local-port` | 端口撞车 |
| `mirror=rsync`（未知键） | 只认七个键 |
| 缺 `local-port=` / `user=` / `host=` | 缺必填键 |
| `user=a@h` | `user`/`host` 里不许有 `@` 或 `/` |
| `trail=relative/path` | 必须是节点上的绝对路径 |
| `node "ro;wan" ...` | 节点名字符集（它会进 `systemctl` 命令行） |
| `local-port=abc` | 端口必须是 1–65535 的数字 |
| 既不是地址行也不是 `node` 行 | 老规矩，照旧带行号拒 |

### 三条现场教训各自的负向自验

| 教训 | 判据在哪 | 怎么复跑 |
| --- | --- | --- |
| 改端点前必须挪开注册中心落盘表 | `beta-up.sh` 的 `assert_registry_matches_peers` | 拿一个 scratch 根：起一次（端点 A）→ 停 → 改 `peers.conf` 成端点 B → **照旧**手起一份注册中心，查 `/v0/agents/<地址>` 仍是 A（病根复现）→ 交给 `beta-up.sh`，它会挪开落盘表并给出 B |
| 隧道口的 TCP 探测是假绿 | `common.sh` 的 `beta_endpoint_live` + `beta_tcp_open` 的守卫 | 见上面「隧道口上的 TCP 探测是**假绿**」那段的三行命令 |
| 审计路径与页头标签必须持久化 | `common.sh` 的 `beta_resolve_console_conf` | 删掉 `console.conf` 再跑一次 `beta-up.sh --role host`，比对它派生出的两个值与 `/proc/<console pid>/cmdline` 里的 `--audit` / `--label` |

## 这个脚本不做什么

**① 不启动备份服务 —— 这是一个真缺口，不是省略。**
`packages/backup` 只导出库函数 `startBackupService()`；仓库里唯一的调用方是
`demo/lib/ac6b-restore.ts`，那是个一次性演示（临时目录建 store、跑完删库恢复就 `stop()`）。
**没有 `occ backup-*` 子命令，也没有任何长驻启动器。**本包的硬约束是「只写 shell 与文档，
不含任何功能代码改动」（beta-env.md §10 包① 的「不含」栏），所以 `beta-up.sh --role host`
在第③步只打一条 `TODO` 并如实报缺，**不伪造入口**。

后果，要写进运维单页：§2.7 的备份面一期起不来 → 节点不能带 `--backup-url` →
§5 里「备份 store 72 h + 14 天日留存」那一行暂时没有数据可管。AC-6(b) 的恢复演示不受影响
（`demo/ac6b-restore.sh` 自带一次性 store）。补这个入口是**另一个包**的事。

**② 不配反向代理。**TLS 终结、443、access log 关 query string、upstream allowlist（只有两项）、
粗粒度限流——全部是 H 上 root 的活（§2.5 / §9.6），不在 shell 脚本的范围里。
**开测前置检查「从校园网真拨一次 H 的 443」也不在这里**，那是人的动作（§10 包① DoD③）。

**③ 不做审计链镜像的 rsync —— 因为那把 key 根本起不了 rsync。**
镜像本身**现在做了**（`beta-up.sh --role host` 建 `qianmo-mirror@<node>.timer`，5 min 一次，
单向只读、节点 → H），但走的是 `ssh cat` 而不是 rsync：H 那把 key 在各节点的
`authorized_keys` 里带强制命令，rsync 协商不到远端 `--sender`，必然挂在握手上。理由与做法见
上面「镜像为什么只能是 `ssh cat`」。**只对有 `trail=` 坐标的节点做**；没有坐标行的节点，
它的链仍然只在节点本机，H 上看不到。
`beta-smoke.sh` 照旧只**读**镜像来验链：`mirror/<node>/trail.ndjson` 在就验它，不在就报缺。

**④ 不做保留与轮转。**§5 的全部数字（备份 72 h + 14 天日留存、日志 14 天、审计链周封存、
注册表快照 4 份、准入台账体积告警）是**落地包③**。`beta-reset.sh` 的 `--purge-logs`
是「重来一次」的动作，不是轮转，别拿它当保留策略用。

**⑤ 不换 PSK。**演示环境的 `reset.sh --rotate-secrets` 在这里**故意没有对应参数**。
PSK 是每节点一把、由 H 生成后分发；在节点机上本地重新生成一把，得到的是一个 H 永远拨不通
的节点。换 PSK 是 §8.4 的七步流程，且只能在升级窗口做——那不是一个脚本参数。

**⑥ 不装 bun / node / 依赖。**用演示环境的 `demo/env/bootstrap.sh`，内测没有第二份。

**⑦ 不删配置根。**`beta-reset.sh --archive-config` 是**改名**（`config.bad-<ISO>`），不是删除——
配置根里装着审计链，而审计链「内测全程不清」（§5）、「只能挪走，不能撤销」（§6.4）。
**归档之后必须在运维单页写一行**（§6 L2 第⑤步），脚本会把那句话打出来提醒。

## 与 `demo/env/` 的差异一览

| | `demo/env/` | `demo/env/beta/` | 为什么 |
| --- | --- | --- | --- |
| 根目录 | `<repo>/.demo-env` | `$HOME/qianmo-beta` | 内测是长驻的，要活过 `git clean` |
| 脚本数 | bootstrap / seed / up / down / reset / smoke | up / down / reset / smoke（+ common） | bootstrap 复用演示那一条；seed 折进 `beta_seed_root`（up 与 reset 都会调） |
| 两条腿 | 一条（本机拓扑） | `--role host` / `--role node` | 拓扑跨四台机器 |
| PSK | seed 现生成一把，两个节点共用 | **绝不本机生成**，缺了就拒绝启动 | 每节点一把、由 H 分发（§8.3） |
| reset | `rm -rf` nodes/ 与 state/ | 默认只清 `run/`；配置根改名归档 | 审计链与 timings 明文规定不许清（§5 / §6.4） |
| 冒烟的 probe | 一次带两个 `--expect` | **一个地址一个进程** | PSK 每节点一把，一个进程只能跟共用同一把的对端握手；另外要说出**哪一个**拨不通 |
| 链路 | 同机回环，没有链路这一层 | 直连，或 `systemd --user` 的 SSH 隧道 + 审计镜像 | 节点入站端口被云厂商安全组挡着 |
| 就绪判据 | `beta_tcp_open`（本机真 listen，够用） | 隧道口只认 `beta_endpoint_live`（真读一次应答） | `ssh -L` 的本地口是 ssh 自己 listen，TCP 探测恒为真 |

## 兼容性

- **bash 3.2**（macOS 自带）：没有关联数组、没有 `mapfile`、没有 `timeout`（macOS 上根本没这个命令），
  一律不用。地址表用三个平行下标数组，去重用字符串包含判断。
- `set -euo pipefail` 全套；每个文件带 SPDX 头（`ops/` 下的 systemd 模板用 `#` 注释同样带）。
- **链路那一层要 `systemd --user`**，所以只在 Linux 宿主上成立。`peers.conf` 里有 `node`
  坐标行而机器上没有 `systemctl`（或没有用户级 D-Bus 会话）时**直接 die**，不静默跳过 ——
  跳过会得到一个「名册上在线、拨号全超时」的拓扑。无 sudo 的机器要先让 root 跑一次
  `loginctl enable-linger <用户名>`，否则最后一个登录会话退出时全部隧道会跟着消失。
- `shellcheck demo/env/beta/*.sh demo/env/beta/ops/mirror-pull.sh` 干净（0.11.0 实测）。`common.sh` 里有一条文件级
  `disable=SC2034`——它是被 source 的公共层，shellcheck 看不到消费方向，`demo/env/common.sh`
  有同样的 12 条告警；**只在那一个文件禁用，四个消费脚本仍然全开**。
- 不需要 `curl`：`beta_http_status` 有 bun 兜底（bun 本来就是硬依赖）。
