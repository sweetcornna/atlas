<!-- Copyright 2026 Qianmo AgentNest Team -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

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

换产物（**只换产物，不起进程**）`./demo/env/beta/beta-deploy.sh`。它带保留策略（`--keep`），
顺序是先清后装 —— 空间在开始拷贝之前腾出来，不够就一个字节都不动。**给节点滚产物用
`--only dist,demo`**：部署树各机形状不同，有的树里还压着一整棵源码检出，整棵换会把它换走
（脚本会在整棵换前比一次，覆盖不住就拒绝）。树上有进程跑着时它拒绝换 —— 先 `beta-down.sh`。
两种模式、五条护栏与各自的理由都写在脚本头注里，这里不复制。

停机 `./demo/env/beta/beta-down.sh`（`beta-down.sh <名字>` 只停一个，即 §6 L0 的第①步；
在 H 上给一个铺过链路的节点名，它的隧道与镜像 timer 也一起停），
回到干净运行态 `./demo/env/beta/beta-reset.sh`（`--purge-links` 连链路与 H 腿的生成物一起删，
并先取消那两个开机自启单元再删文件；下次 `beta-up.sh` 会照仓库重新铺出来；**`mirror/` 一条不动**）。

### 尾参透传：`--` 之后的一切交给底层命令

`beta-up.sh` 管的是**拓扑**：端口、配置根、PSK 从哪读、审计链在哪、任务策略那两个开关。
`resident` / `console` 自己的策略参数**不在这里逐个开口子**，一律走同一条尾参约定：

```bash
# node 腿 → resident
./demo/env/beta/beta-up.sh --role node --node <节点名> -- --trust <节点>=<公钥>

# host 腿 → console
./demo/env/beta/beta-up.sh --role host -- --wake-sign
```

`--` 之后的参数**原样追加在底层命令行的最后**，所以它同时也是覆盖上面某个默认值的口子
（最后一个赢）。为什么是一条透传约定而不是三个专用开关：那一侧还有一长串同类的
（`--require-signed-tasks`、`--trust-ca`、`--cert`、`--chat-url`…），今天补三个，明天就有第四个
够不着 —— 2026-08-24 的舰队部署正是卡在这里，只能在部署机上手写瘦封装绕开这里的参数解析，
而那份封装不在仓库里，不可重复、不可交接。

两条边界：

- **`--view-token` / `--admin-token` 的值形式当场拒绝。**命令行上的密钥就是这台机器每一份
  进程列表里的密钥；两枚 token 一律走 `--*-token-file`（`secrets/` 下的 0600 文件），要换就改
  文件内容。尾参是逃生门，不是把这条纪律换掉的旁路。
- **`--print-wake-identity` 本身不是透传参数**，它是 `beta-up.sh` 自己的开关（见下）：那不是
  一次启动而是一次查询，透传过去会被起成后台进程、把公钥写进 `logs/console.out` 然后退出。
  `--` 里的**其余**参数照样跟着那次查询走 —— 身份由 `--chat-from` 决定，这一路与起控制台
  那一路必须问出同一把钥匙。

不认识的参数会把**本脚本支持的全部参数**打出来，并提示尾参透传这条出路。

#### 节点腿的尾参活得过一次「停机 → 换产物 → 起机」

节点腿的尾参落进 `<root>/state/<节点>.passthrough`（0600，一行一个参数）：

| 这一趟给的 | 结果 |
|---|---|
| 带 `-- <参数>` | 以这一趟为准，并重写记录 |
| 不带 `--` | **沿用记录里那一份**，并把沿用了什么打印出来 |
| 带一个空的 `--` | 明确清空记录（原先有东西时会 WARN 说清楚撤掉了什么） |

**方向与控制台腿相反，这是有意的**（issue #111）。控制台那半边「不给尾参 = 撤掉」撑得住，
因为开机是 systemd 读 `ops/console.env`，人不会为一次重启重跑脚本；节点这半边每次换产物
都要人重跑，同一个默认在这里就等于让最常做的那个动作**默认改掉节点的策略面**。

2026-08-26 在 cornna-p3 上真发生过：`beta-down.sh beta-2` → 换产物 → `beta-up.sh --role node
--node beta-2` 之后 argv 少了一个 `--trust <节点>=<公钥>`，其余一字不差 —— 因为那些是脚本按
`--role`/`--node` 推导的。**丢的是策略不是显示项**：节点照常启动、照常在名册上在线、拨号
照常 426，所有存活判据全绿，只有真去发一个签名唤醒任务时才失败。同一条约定上还挂着
`--require-signed-tasks` / `--trust-ca` / `--cert` / `--chat-url`，每一个丢了都是同一种
「看着正常、实际降级」。

含空白的参数在这里**存得住**（`ops/console.env` 那半边存不住，因为它是一行 `KEY=值` 交给
systemd 分词）。存不住的只有以 `#` 开头的参数 —— 那是这份记录里注释行的形状，写入时会
WARN 一句而不是悄悄写坏。

### 签名唤醒：三步，顺序不能换

```bash
# ① H 上：拿控制台的唤醒签名身份（一行 <节点>=<公钥>）。标准输出上只有那一行，可以直接接住
IDENTITY="$(./demo/env/beta/beta-up.sh --print-wake-identity)"

# ② 每台节点机：声明信任这个签名者（幂等脚本不重起在跑的进程，所以先停）
./demo/env/beta/beta-down.sh <节点名>
./demo/env/beta/beta-up.sh --role node --node <节点名> -- --trust "$IDENTITY"

# ③ 回到 H：让控制台真的签名
./demo/env/beta/beta-down.sh console
./demo/env/beta/beta-up.sh --role host -- --wake-sign
```

`--print-wake-identity` **前台跑、不写 pid、不落日志**，用的是控制台**自己**那个配置根
（`nodes/console/config`）。身份按配置根落盘，拿另一个根打出来的公钥与控制台真正用来签名的
不是同一把，而症状只会在节点侧表现为验签失败 —— 一条「密钥不匹配」的错，查起来看不出是
打印那一刻就错了。首次运行会现场创建那把私钥（0600，在配置根里），这是有意的：分发公钥本来
就该发生在控制台第一次带 `--wake-sign` 起来之前。

### 「已启动」是真的启动了

`beta_start_process` 内建两道校验，**不再要求调用方自己跟一句存活检查**：

- 起**之前**问这条命令在不在（`command -v`）。`beta_require_qm` 同时校验产物与解释器 ——
  这道 `command -v bun` 的守卫此前只在 `bootstrap.sh`、`beta-retain.sh`、
  `remote/prepare-sandbox.sh` 三处有，唯独这条主部署路径漏了。
- 起**之后**等 1 s 再问它还在不在；死了就把 `stderr` / `stdout` 末尾摊开、删掉那个 pid 文件、
  退非零。

它挡的是这个形状：`bun` 装在 `~/.bun/bin`，非交互 SSH（乃至 `bash -lc`）解析不到，`nohup` 以
127 退出，而操作者看到的是一行绿色的「OK : 已启动（pid N）」，`run/<名字>.pid` 里还留下一个
指向已死 pid 的陈旧记录。**遇到它就在命令前显式补 PATH**：
`PATH="$HOME/.bun/bin:$PATH" ./demo/env/beta/beta-up.sh ...`。

### pid 文件对不上真进程时（2026-09-26 p1）

旧树留下的 `run/<节点>.pid` 指着一个早已不在的 pid，真进程却还跑着、占着端口。以前
`beta-down.sh <节点>` 只认 pid 文件，报「本来就没在跑」；随后的节点腿起了一个注定
EADDRINUSE 的新进程，就绪探测又被旧进程的应答骗成了绿。现在：

- **`beta-down.sh <节点>`** 在 pid 文件之后再按命令行认一遍：argv 里有 `resident`、`--node <节点>`，
  且绑在本内测根上（`--agent` 指向本根的工作区，或 Linux 上它的 `QIANMO_CONFIG_DIR` 就是本根的
  配置根）。认出来的按同一套 TERM → 10 s → KILL 停掉并 WARN。pid 文件在却陈旧、命令行又认不出
  任何一个、而 `QIANMO_BETA_NODE_PORT`（默认 38625）被占着时，列出占用者的 pid 与命令行，
  **一个都不动**，以非零退出。端口上是本内测根的另一个节点（H 上的 beta-4）不算不一致。
- **节点腿**：pid 文件说没在跑、端口却有人在听，就不起新进程，列出占用者并指向 `beta-down.sh`。
  就绪要三件事都成立：刚起的 pid 活着；它的启动行（`logs/<节点>.out` 首行）是这个节点、带
  公钥；端口有应答，且本机查得到的监听者（ss / lsof / `/proc`）里有这个 pid。新进程退出时当场
  失败并摊开它的 stderr。OK 那一行带出 pid 与公钥，末尾多一行「公钥」，照抄进 H 的
  `peers.conf` 坐标行 `public-key=`。三种办法都查不到监听者的机器上退回「活着 + 启动行 + 应答」，
  并 WARN 说没核对 pid。

## 宿主侧保留与轮转

**只在宿主 H 上由操作员运行**，不放进节点、常驻进程或 `@qianmo/backup` 的入站面。先看计划，
确认候选数和剩余数，再显式申请变更：

```bash
# 默认 dry-run；零写入，不建目录、不压缩、不复制、不删除
./demo/env/beta/beta-retain.sh

# 只有这一条才实际处理宿主侧固定路径
./demo/env/beta/beta-retain.sh --apply

# 升级窗口开始前：先原子复制 beta-up 当前使用的注册表落盘，再轮转到最近四份
./demo/env/beta/beta-retain.sh --apply --snapshot-registry
```

路径全由 `common.sh` 从 `QIANMO_BETA_ROOT` 派生：备份 store 是 `<root>/backups/`，当前
注册表落盘是 `<root>/state/registry-agents.json`，升级快照是 `<root>/state/snapshots/`。工具没有
任意目录参数；根目录与 marker 先过公共层守卫，Bun helper 又逐项拒绝非规范路径、根外路径、
符号链接（含父目录）和非普通文件。内测根的 mode 必须严格为 0700；marker、文件和每级后代目录
必须与根同 owner，后代目录可保留正常 umask 产生的 0775。捕获后的每级父目录会按精确的
mode/dev/ino/owner 身份在操作前复验，`chmod` 或替换都会失败关闭；dev/ino 用 bigint 比较，避免大
inode 精度丢失。失败会给出类别/对象并以非零退出，不把部分结果报成成功。所有对象和各类 planner
先完成只读预检并汇总错误；任一错误都会阻止本轮全部数据操作。

自然日和自然周一律按 **UTC**：72 小时边界包含恰好等于边界的快照；其外但在最近 14 个 UTC
自然日内，每日保留 `createdAt` 最新的一份，时间相同按快照 id 词典序取大者。已完成日志压成
`<name>.YYYY-MM-DD.gz`；活着的 pid 对应 raw `.out` / `.err` 不轮转，但仍会验证已有同名 gzip peer，
不能借 active 状态跳过冲突检查。工具不产生 `.gz.gz`，也不会覆盖已有 gzip 目标。raw 日志即使已经
超过 14 天，也先在本轮生成并验证 gzip、再删 raw；新 gzip 到下一轮才按 14 天策略淘汰。若同名
raw 与已有 gzip 解压内容或保留时间不同，双方都保留并非零退出，由操作员处置冲突。`--apply` 的
全量扫描与执行由 `<root>/run/.retain-apply-lock` 串行化；并发的等价运行会在前一份完成后重新扫描并
幂等结算。审计只在周日封存权威源链到
`archive/trail-<ISO-week>.ndjson`，临时文件 fsync 后原子发布，原链、镜像链和台账都不删不改；
台账仅在超过 10 MiB 时告警。完整策略和保留数字以
[`beta-env.md`](../../../docs/dev/beta-env.md) §5 为准。

备份归档与元数据成对删除。删除任一方前，元数据 staging 必须依次完成 payload fd fsync、临时目录
fsync（提交 payload 目录项）和 `run` 目录 fsync（提交临时目录项），每一步都绑定并前后复验已捕获的
同 owner、非符号链接目录身份。公开 pathname 绝不直接传给 `unlink`：工具先在同一父目录创建并
fsync 私有 `.retain-delete-*` quarantine，再用 macOS `renamex_np(RENAME_EXCL)` 或 Linux
`renameat2(RENAME_NOREPLACE)` 原子、无覆盖地隔离 pathname；平台不支持时失败关闭，绝不退回覆盖式
rename。隔离 inode 与计划身份一致、quarantine 和原父目录均 fsync 且原 pathname 确认缺失后，才在
私有 quarantine pathname 上 unlink。两个对象都完成后还要 fsync 已绑定的 `backups` 目录，并在同一
父目录身份下复验两个公开 pathname 都缺失，才算删除已提交并允许清 staging。任何较早故障都不能把
archive 的 settled/missing 误报成提交。

若 syscall 边界隔离到的 inode 不是计划对象，工具绝不 unlink 它；回滚只允许 no-clobber 恢复，原
pathname 已占用时保留 quarantine 对象并报告人工位置。这个协议保证公开 pathname 上的并发 replacement
不会被删除或覆盖。对有权改写 quarantine namespace 的本地对手（典型是同一 UID；父目录若另行授权
writer 也包括在内），身份复验与最终 private unlink 之间仍存在无法由 pathname API 消除的最窄竞态；
残余只位于 quarantine 的物理清理，不扩展成对公开 pathname replacement 的 unlink 保证。

删除未提交时，工具先稳定复验原 metadata 的计划身份与字节；它仍安全时才回收 staging，否则只以
no-clobber hard link 恢复原路径，校验两链接身份与字节、fsync `backups` 后再复验。恢复的 durable
commit 与 staging cleanup 是两个阶段：cleanup 按 payload unlink、临时目录 fsync、临时目录 rmdir、
`run` 目录 fsync 的顺序执行。若 blocker、父目录/文件替换或任一步故障，工具不覆盖或删除并发对象，
并按磁盘事实报告 payload 与临时目录是否仍存在；payload 尚在时位置为
`<root>/run/.retain-*/payload`，恢复已提交但 cleanup 不完整时也不会谎称 payload 仍在。

本仓库仅有临时树回归覆盖，**尚未形成真机一次运行记录，也尚未有两周归档体积复核**；这两项仍按
`beta-env.md` §10 包③的 DoD 留待宿主环境采集。

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
| `public-key` | 否 | 无 | 该节点的公钥（43 位 base64url，节点腿末尾「公钥」那一行）。给了，注册中心登记它的每条地址时一并发布，控制台带 `--anchors` 时以 `--trust` 交给控制台；不给就照旧不带，H 腿 WARN 一句。见下面「名册上的节点公钥」 |

#### 名册上的节点公钥

同一份公钥有两个去处：

- **注册中心**：H 腿给 p81-registry 带上 `--public-key <节点>=<公钥>`，它随每一次登记与重登记
  （含租约过期后的那一次）一并发布，不再需要手工补。
- **控制台**（2026-09-27 起，K-11 F-3）：控制台尾参里有 `--anchors` 时，H 腿给每个有公钥的节点加一条
  `--trust <节点>=<公钥>`。控制台**不再从名册取验签公钥**：名册的写口不鉴权（或只凭一枚共享 token），
  谁往里写一把公钥，谁就能让改过的链显示「已见证」。带 `--anchors` 而一把公钥都没有、尾参里也没有
  `--trust` / `--trust-ca` 时，H 腿在起控制台之前就停下并说明原因（控制台自己也会拒绝启动）。

公钥从哪来：

| 节点 | 来源 |
| --- | --- |
| 有坐标行（走隧道的远端节点） | 坐标行的 `public-key=`。H 读不到远端的身份文件，由人把节点腿末尾的「公钥」抄过来 |
| 没有坐标行、端点是回环（跑在 H 自己身上） | 本机身份文件 `nodes/<节点>/config/qianmo/identity/<节点>.json`，只读 `publicKey` |
| 直连的远端节点 | 没有来源：注册中心照旧不带；控制台那一侧在尾参里手工给 `--trust <节点>=<公钥>`（见「审计见证」第 ⑥ 步） |

没有来源时与改动前完全一样（不带公钥），H 腿逐节点 WARN 一句。在跑的注册中心还挂着别的
（或没有）公钥时，H 腿像处理端点不一致一样重起它一次。**同一个地址别既写进 `peers.conf`
又在控制台页面上注册**：页面那一条的续租是整条重新声明，没带公钥就会把这里发布的抹掉，
`logs/registry.err` 会每轮出现一行「registry 公钥已更新」。

向后兼容靠一点：老格式的第一字段必然以 `qianmo://` 开头，所以 `node` 这个关键字不可能和
任何一条合法的老行撞上。**坏行照旧带行号被拒**，未知键、缺必填键、端口非数字、`trail` 非
绝对路径、节点名不符合协议段（1–64 个小写字母、数字、`_`、`-`，且首尾为字母或数字；它会进
`systemctl` 命令行）也都带行号拒。

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
| `<root>/ops/qianmo-registry.service` | H 上注册中心的开机自启单元 | `demo/env/beta/ops/qianmo-registry.service.in` |
| `<root>/ops/qianmo-console.service` | H 上控制台的开机自启单元 | 同目录的 `.in` |
| `<root>/ops/console.env` | 控制台单元的启动参数（0600，`CONSOLE_EXTRA_ARGS`） | 最后一次 `beta-up.sh --role host` 的尾参 |
| `<root>/state/<节点>.passthrough` | 节点腿的尾参（0600，一行一个） | 最后一次带 `--` 的 `beta-up.sh --role node` |
| `~/.config/systemd/user/qianmo-*.{service,timer}` | 装好的那五份 | `<root>/ops/` 里的同名文件 |

**每次 `beta-up.sh --role host` 都重新派生一遍，且只在内容真的不同时才写。**内容没变就不
`daemon-reload`、不 `enable`、不 `start`；已经在跑的单元**永远不重起**。文件变了而单元正在
跑时，脚本会在末尾列出那些实例并给出维护窗口里的 `systemctl --user restart` 一行 —— systemd
自己不会在任何地方留下这个痕迹。

### 控制台与注册中心的开机自启

隧道与镜像早就有单元，**控制台与注册中心一直是裸进程** —— H 一重启两者就都没了，且不会
自动回来（issue #45）。现在它们各有一个 `systemd --user` 单元，与隧道那套同一套写法与放置
约定（模板真源在 [`ops/`](./ops/)，`beta-up.sh --role host` 派生并安装）。

三件事要一起知道：

- **单元调的是仓库脚本，不是手写薄壳。**`ExecStart` 是
  `beta-up.sh --role host --only links --only registry` 与 `beta-up.sh --role host --only console`，
  `ExecStop` 是 `beta-down.sh <名字>`。注册中心与控制台的命令行都是 `peers.conf` 派生的
  （每条地址一个 `--register`、每个节点一条 `--audit` 与 `--wake-url`），抄进单元文件就是第二处
  真源，而分叉的症状是「改了 `peers.conf` 却不生效」。`--only` 就是为这两个单元加的，日常
  起机不需要它。
- **`--wake-sign` 这类尾参活过重启。**每次起 H 腿都把**那一趟的尾参**落进 `ops/console.env`
  的 `CONSOLE_EXTRA_ARGS`，单元从那里取。于是「单元带什么参数」= 「最后一次
  `beta-up.sh --role host` 带了什么参数」；不带尾参跑一次就等于把它们撤掉，脚本会在那时
  WARN 出被撤掉的那几个。（起注册中心的那一趟不重写这个文件——否则开机时它会把控制台的
  开关一并抹掉。）
- **单元只保证开机自动回来，不做崩溃拉起。**`Type=oneshot` 上 `Restart=` 无效。反过来说，
  `beta-down.sh` 停掉进程之后 `systemctl --user status` 仍是绿的（它记的是「那一趟起过了」），
  所以 `beta-down.sh` 会在那时提醒一句。要连单元一起停用 `systemctl --user stop`。

开机时真能起来还要 `loginctl enable-linger <用户名>`（要 root 跑一次）；没开 linger 的话，
最后一个登录会话退出时这些单元会跟着一起消失。宿主上没有可用的 `systemd --user` 时（开发机
就是这样），脚本不铺单元并如实说「重启后不会自动回来」。

### 真机腿（`--target fleet`）怎么起

```bash
demo/env/beta/ops/fleet-acceptance.sh -- --out /tmp/fleet-run
```

它只做三件事：**从各机现取 PSK 进环境**（`~/qianmo-beta/secrets/transport-psk`，0600）、
**校验四把都取到了**、再 exec `scripts/qianmo-acceptance.ts --target fleet`，尾参原样透传。
值不打印也不落盘 —— 通过时打的是 sha256 前 8 位。

**为什么要有它**（issue #113）：在它之前 `grep -rn "QIANMO_ACCEPTANCE_PSK_"` 在 `*.md` /
`*.sh` 上是空的，唯一提到那几个变量名的是 `fleetConfigFromEnv()` 自己的实现。于是这条腿
「怎么跑起来的」是口头知识，换个人接手时最省事的做法是现编一条命令行 —— 而**少接一把
PSK 的表现不是报错**，是那个节点的场景整片 skip 或红，两者都容易被读成「环境问题」。

两条入口性的事实，真源都在 `demo/lib/acceptance/fleet/driver.ts` 的 `fleetConfigFromEnv()`
注释里，本文只给指针：

- **节点名 → 变量名**：`beta-1` → `QIANMO_ACCEPTANCE_PSK_BETA_1`（连字符换下划线再大写，
  即那里的 `envSuffix()`）。取不到时回退 `QIANMO_TRANSPORT_PSK`。
- **控制台机可置空**：`QIANMO_ACCEPTANCE_CONSOLE_HOST=`（空值）就是「这一轮没有控制台
  机器」，靠它的场景据此如实 skip 而不是红。缺省是 `workbench-iap`。

拨号地址默认 `ws://127.0.0.1:3863x`，**那四个口在控制台机 H 的回环上**。从别处跑要先起隧道
（`ssh -N -L 3863x:127.0.0.1:3863x workbench-iap`），或设 `QIANMO_ACCEPTANCE_DIAL_HOST` /
`QIANMO_ACCEPTANCE_ENDPOINT_<节点>`。套件不自己建隧道 —— 拨不通是**如实的红**，不是假绿。

### 这两个单元的状态不是存活判据 —— 两个方向都不是

2026-08-24 真机腿实测，同一台 H 同一时刻：

```
systemctl --user is-active qianmo-console.service   → inactive (rc=3)
curl /v0/health → 200 ；ss -lnt → 38621 LISTEN ；进程 etimes = 6539
```

**这不是故障，是两条设计合成出来的**（issue #64）：

- `inactive` 而进程活着 —— `beta-up.sh` 每趟都自己起进程，对这两个单元**只 `enable` 不
  `start`**（`start` 会让脚本要求 systemd 起一个此刻正由自己跑着的单元，那是自己等自己）。
  于是它们从没被 systemd 跑过，`is-active` 当然是 `inactive`。
- `active` 而进程已经没了 —— `Type=oneshot` + `RemainAfterExit=yes`，见上一节。

**对照组是同机四条 `qianmo-tunnel@<节点>.service`：它们全是 `active`，而且那是真的。**
差别在 `Type=exec`（systemd 直接管着 ssh 进程），不在 user scope —— 别把隧道那边的经验套过来。

判死活只有一条路，公开、零鉴权、两个进程同形：

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:38620/v0/health   # 注册中心
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:38621/v0/health   # 控制台
```

`beta-smoke.sh --role host` 的第 ①③ 项问的就是这两条；单元状态与现实对不上时，它会在那两项
旁边解释一句为什么，**但不判 FAIL**（「inactive 而进程活着」是本包的正常形态）。

**注册中心那条探针一直都在**，`/v0/health` 还会回 `{"status":"ok","agents":N}`。issue #64 里
「注册中心没有存活探针」是路径试错：`/health` 少了 `/v0` 前缀，`/v0/peers` 则是集合名不对——
注册中心的集合叫 `agents`（`/v0/agents`、`/v0/agents/<地址>`、`/v0/agents/<地址>/heartbeat`），
路由表在 `packages/registry/src/http.ts`，不认的路径一律 `404 unknown path: <路径>`。

**没有把单元改成「状态真实」，是算过账的。**要么把 `peers.conf` 派生出来的整条命令行抄进单元
文件让 systemd 直接管进程（第二处真源，正是上一节拒绝的那件事），要么让 `beta-up.sh` 转手去
`systemctl start`（`Requires=` 会把整条 links+registry 腿再跑一遍，且任何一步绊倒就把一套活着
的部署变成 `failed`）。代价都比收益大。最坏的中间态是「看起来有个状态可查，查出来是错的」，
所以改为把这条差距钉在所有会有人去看的地方：单元的 `Description=`、`beta-up.sh` 末尾的
「存活判据」一行、`beta-smoke.sh` 的 ①③ 项，以及这一节。

### 镜像为什么只能是 `ssh cat`

**理由是设计面的，真源在 [`beta-env.md`](../../../docs/dev/beta-env.md) §4.3，本文不复制**：
一句话是 H 那把 key 在各节点的 `authorized_keys` 里带**强制命令**，`rsync` 协商不到远端的
`--sender`，必然挂在握手上。

操作上要知道的只有两件：链文件只有 KB 量级，全量 `cat` 无代价；`mirror-pull.sh` 里那个
`MIRROR_METHOD=rsync` 分支留着不是为了扩展性，是为了让「有人把 rsync 写回去」当场报错并说明
理由，而不是挂在握手上等超时。

### `qianmo-mirror@<node>.service` 绿了不等于「链在动」

**退出码的分格写在 `mirror-pull.sh` 的文件头，本文不复制**，只说会影响判断的那一条：**「远端
还没有这条链」走成功（exit 0）**，日志里是一行「尚未创建 …… 合法的初始态」。链的第一条记录要
等那个节点第一次真做协议工作，在那之前每 5 分钟造一次 service failure，只会让人不再看这四个
单元的状态——内测环境正是这样连续失败了数天（issue #9）。所以**要知道链有没有内容，看
`mirror/<node>/trail.ndjson` 在不在、多大，不要看单元是不是 `active`**。反过来，SSH 不通、
远端读不了、链凭空消失、拉到空文件却本地已有一份非空镜像，仍然是 `failed`——分开不等于吞掉。

### 隧道口上的 TCP 探测是**假绿**

**现象与三条判据的对照表在 [`beta-env.md`](../../../docs/dev/beta-env.md) §9.8，本文不复制**：
一句话是 `ssh -L` 的本地口由 **ssh 客户端自己** LISTEN，节点侧那个端口没人监听（或被
`permitopen` 挡住）时它照样 `accept` 再立刻关掉 —— 单元 `active`、端口通、拨号全超时，
三个绿灯一个真相。

落到这套脚本上的处置是两条，都在 `common.sh` 里：

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

## 控制台 HTTPS：不占 443 的形态（`ops/console-https.sh`）

§2.5 的原方案是「H 上的 host 级 nginx 加一个 server 块」。当 H 上的 443 与 nginx 属于别的业务、
不归本仓库管时，用这一套：控制台照旧只听回环，对外那一层由
[`ops/console-tls-front.ts`](./ops/console-tls-front.ts)（一个只做转发的 Bun 小程序）在一个
非 443 端口上做 TLS 终结，证书走 Let's Encrypt 的 DNS-01（HTTP-01 要 80、TLS-ALPN-01 要 443，
两个都不是我们的）。**控制台一行代码不改。**

```bash
# 前置：<根>/secrets/cf-dns.env（0600，一行 CF_DNS_API_TOKEN=…）；lego 可执行文件（默认 ~/.local/lego/lego）
demo/env/beta/ops/console-https.sh install --domain <域名> --listen 0.0.0.0:38443 --upstream http://127.0.0.1:38621
<根>/ops/console-https.sh issue --staging   # 先对 staging 走通整条 DNS-01，独立目录，不碰正式证书
<根>/ops/console-https.sh issue             # 正式证书
systemctl --user start qianmo-tls-front.service
```

- **§2.5 的三条强制配置落在前置程序里，由用例钉住**：日志一行只有「时间、对端、方法、路径、状态、
  耗时」，没有 query、没有请求头；上游只有命令行上那一项，必须是回环明文、且不能是注册中心的
  38620；`X-Forwarded-Proto: https` 由前置自己设，客户端送来的转发类头一律先删。逐条理由见前置
  程序的文件头。
- **install 只能从交付树那一份跑**（它要读 `*.in` 模板）；装好的那一份只给续期 timer 与部署钩子用。
  换上游 / 换端口 = 从交付树重跑 install，再 `systemctl --user restart qianmo-tls-front.service`。
- **DNS 凭据只进 lego 那一个进程的环境**，不进 argv、不落第二个文件。那枚 token 能改整个 zone，
  「只动 `_acme-challenge.<域名>` 那一条 TXT」是 lego 的行为，不是 token 的边界——登记进运维单页。
- **续期**：`qianmo-console-cert.timer` 每天一次（随机错开一小时，关机错过开机补）；到期前续签成功
  才调部署钩子重启前置。前置只在启动时读证书。
- **存活判据**：`curl -s -o /dev/null -w '%{http_code}' https://<域名>:<端口>/v0/health` 要 200，
  且不加 `-k`。单元状态不算数（与上面那两个单元同一条理由）。
- 两条现场教训已写进脚本并有用例：lego 预查留下的 NXDOMAIN 会被本机解析器负缓存，所以只查权威 NS
  （`--dns.propagation.disable-rns`）；URL 会把显式写的协议默认端口（`:80`）规范化成空串，所以上游端口
  从原文里取。

## 注册中心写 token（P15.8）与吊销清单落盘

注册中心默认不鉴权（`beta-env.md` §9.2）：H 上任何本地账号都能改名册、发布吊销清单。P15.8 起它可以要求一枚
写 token：注册、注销、心跳、发布吊销清单要带 `Authorization: Bearer`，否则 401、什么都不改；**读照旧公开**。
H 腿只看 `secrets/registry-write-token` 在不在：在，就给注册中心 `--write-token-file`、给控制台
`--registry-token-file`，两边同一个文件，token 不上命令行；不在，两边都不带，H 腿 WARN 一句。

**启用有先后：先控制台，后注册中心。**控制台先带上 token 没有副作用（没开 token 的注册中心不看这个头）；反过来，
注册中心先开始要求，在跑的旧控制台续租就会被 401，页面注册的条目在一个租约后消失。**7 天长跑窗口内不做**
（至 2026-10-03T18:20Z）：两步都要重启 H 上的进程。

```bash
# ① 生成 token（0600，不回显）。要求 ≥ 16 字符；权限不是 0600/0400，注册中心与控制台都拒绝启动
( umask 077; LC_ALL=C od -An -tx1 -N 32 /dev/urandom | tr -d ' \n' > "$QIANMO_BETA_ROOT/secrets/registry-write-token" )
# ② 先重启控制台：它开始带 token。单元从 ops/console.env 取尾参，不会丢 --anchors / --wake-sign
systemctl --user restart qianmo-console.service
#    没有单元的宿主：beta-down.sh console，再带上**原来的尾参**跑 beta-up.sh --role host --only console -- <原尾参>
# ③ 再重启注册中心：它开始要求 token（控制台单元 Requires 它，会跟着重启一次，照样带 token）
systemctl --user restart qianmo-registry.service
# ④ 验收：不带 token 的写 401，读 200；横幅里有一行 write-token
curl -s -o /dev/null -w '%{http_code}\n' -X POST -H 'content-type: application/json' --data '{}' http://127.0.0.1:38620/v0/agents   # 401
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:38620/v0/agents                                                         # 200
grep 'write-token' "$QIANMO_BETA_ROOT/logs/console.out"
```

撤回：把 `secrets/registry-write-token` 挪走，重启注册中心（控制台跟着重启，不再带 token）。

**吊销清单现在落盘**（K-1 遗留）：与名册表同目录，`state/registry-revocation-list.json`（0600）。注册中心重启后
照旧提供最后一次发布的清单，不必再手工重发。换上带这项改动的构建后，**第一次**启动时盘上还没有这个文件，要照
`ca-runbook.md` §6.1 重发一次；开了写 token 以后，`PUT` 要带头，token 不进命令行：

```bash
curl -fsS -X PUT -H 'content-type: application/json' \
  -H @<(printf 'authorization: Bearer %s\n' "$(cat "$QIANMO_BETA_ROOT/secrets/registry-write-token")") \
  --data-binary @revocation-list.json http://127.0.0.1:38620/v0/revocation-list
```

这个文件读不出来（被截断、不是 JSON、不是 `{payload, signature}`）时，注册中心**拒绝启动**，不以空清单起来：
`logs/registry.err` 写明路径。用 CA 目录里最新的 `revocation-list.json` 覆盖它，或确认要丢弃后把它挪开再起、
然后重发。`beta-retain.sh --snapshot-registry` 只快照名册表，不含这个文件。

## 审计见证（P11.4）：节点经隧道的 `-R` 写锚点，端点在 H 或另一台机器

节点够到见证端点，靠的是 **H 发起的**那条隧道会话里多一个 `-R 127.0.0.1:38640:127.0.0.1:38640`：
节点写自己的回环 38640，SSH 把它送到 H 的回环 38640。节点上不放任何指向 H 的凭据（§8.3 的单向信任）。
H 的回环 38640 后面是什么，有两种形态：

| 形态 | H 回环 38640 后面 | 什么时候用 |
|---|---|---|
| ① 见证在 H | 端点本身（`qianmo-witness.service`） | H 上**没有**节点 |
| ② 见证在另一台机器 W | `qianmo-witness-link.service`：`ssh -N -L 127.0.0.1:38640:127.0.0.1:38640 W`，W 上的端点同样只听回环 | **H 自己也跑着节点时必须用这一种**：见证和它见证的节点不能在同一台机器上（audit-witness.md §4.1，不同失陷域） |

```bash
# ── 形态②（2026-09 的现场就是这一种）──
# ① W：装端点并起它。W 上没跑过 beta-up.sh 也行（内测根不存在时 install 自建标记）；
#    W 没有 linger 时单元活不过最后一次登出，用 start（nohup + pid 文件，oom_score_adj=1000）
demo/env/beta/ops/witness-endpoint.sh install --key beta-4=<公钥> --key beta-1=<公钥> --key beta-5=<公钥>
demo/env/beta/ops/witness-endpoint.sh start          # status：pid 与「不带 token → 401」；stop
# ② H：W 的主机公钥**核对指纹后**放进 known_hosts，再装链路单元；它会打印 W 的 authorized_keys 要加的那一行：
#    restrict,port-forwarding,permitopen="127.0.0.1:38640",permitlisten="127.0.0.1:1",command="/bin/false" <H 的公钥>
demo/env/beta/ops/witness-endpoint.sh link-install --user <W 用户> --host <W 地址> --key <H 上的私钥>
systemctl --user start qianmo-witness-link.service
# ③ H：peers.conf 各坐标行加 witness-port=38640，跑 host 腿（隧道会话多一个 -R）
# ④ 各节点机：authorized_keys 里 H 那一行带 permitlisten="127.0.0.1:38640"；W 的写 token 拷成本机
#    secrets/witness-write-token（0600），节点腿带上尾参
demo/env/beta/beta-up.sh --role node --node <名字> -- --trust console=<公钥> --witness-url http://127.0.0.1:38640
# ⑤ H：W 的读 token 拷成 H 的 secrets/witness-read-token（0600），控制台尾参加 --anchors http://127.0.0.1:38640
# ⑥ H：让控制台拿到每个节点的验签公钥。控制台只按 --trust / --trust-ca 验锚点（不从名册、不从锚点学），
#    漏了这一步，审计页对该节点报「没有节点 <名字> 的可信公钥」。
#    走隧道的节点：坐标行加 public-key=<节点腿末尾「公钥」那一行>，再跑 host 腿；跑在 H 上的节点不用写
#    （H 腿读本机身份文件）。H 腿把它们以 --trust 交给控制台，同时随登记发布进名册（见「名册上的节点公钥」）。
#    直连的远端节点（没有坐标行、不在 H 上）在控制台尾参里手工给，与 --anchors 写在一起：
demo/env/beta/beta-up.sh --role host -- --anchors http://127.0.0.1:38640 --trust <节点>=<节点公钥>
```

- **两枚 token 都在 W 上生成。**写 token 发给每个节点；读 token 只给做验证的一方（形态②下是 H 上的控制台）。
  读 token 只能列出锚点，改不了任何一条。命令行的 `occ audit --verify --witness` 只从**本机配置根**的身份文件
  确立节点公钥，所以要在节点机上用节点自己的配置根跑；锚点源给 W 存储的只读快照（绝对路径）或 HTTP 端点加读 token。
- ⑥ 控制台的 `--trust` 每次起 H 腿都从 `peers.conf` 与本机身份文件重新算，不落进 `ops/console.env`；尾参里手工给的
  那几条随尾参落进 `ops/console.env`，活过重启。同一个节点两边给的公钥不一致，控制台拒绝启动。名册里的公钥照旧
  随每次登记发布，但验签不再用它。
- 尾参里有 `--witness-url` 时，节点腿把写 token 从文件读进环境；控制台尾参里的 `--anchors` 是 HTTP 端点时，
  H 腿把读 token 读进 `QIANMO_WITNESS_READ_TOKEN`。两边都不上命令行；缺文件、权限不是 600、明文 http 指向
  回环以外，都在起进程之前拦下。
- 端点不在、或 H → W 那条链路断了，节点照常工作，只在 `.err` 里报写不进去（发送方 fail-open）；链上有新记录时
  控制台审计页退回「未见证」。**链头没变时发送方不重发**，空闲节点的 `.err` 里没有见证记录；重启后第一个周期把
  当前链头补发一次，端点回 409 且回带同一个 `head` 时按已接受处理，不记错误。`.err` 里仍出现
  `refused the anchor: 409` 只有两种情况：带 `(seq N already witnessed with a different head)`——端点在同一 seq
  上存着另一段历史，要查（链被重写，或节点根被重置过）；不带括号——端点是 v1.3 之前的版本，确认不了 head，端点
  升级后消失。链头长时间不动不再让 `stale` 为真：审计页的「未见证」只在链越过最新锚点、且见证侧超过 2T 没收到
  新锚点时出现（audit-witness.md §4.1「重发与 409」、§4.3「陈旧的判定」）。存活判据：H 上与 W 上各自
  `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:38640/v0/anchor` 不带 token 要 401。
- 跑在 H 自己身上的节点（没有坐标行）直接写 `http://127.0.0.1:38640`，不经隧道；形态②下它照样经那条 `-L` 落到 W。

## 模型服务（P18.6）：中枢持钥，经第六类动作下发

控制台的「模型服务」一面（`providers-console-m1.md`）：模型密钥由 H 上的控制台以信封加密保管、只写不读，
下发时经**第六类动作**把一行请求 JSON 送到节点的 `qm provider serve-stdin`。和 `--wake-sign` 一样是尾参里的
策略开关，而且要个人账号（写动作只认 ops 角色、每一次都记进动作账本）：

```bash
demo/env/beta/beta-up.sh --role host -- --accounts --providers
```

H 腿见到 `--providers` 才补拓扑那一半（`beta-up.sh` 的 `provider_console_args`）：

- **主密钥** `--provider-key-file $QIANMO_BETA_ROOT/secrets/provider-master.key`。控制台在第一次保存模型密钥时
  生成它（0600），脚本不生成、不读、不打印。它在 `secrets/` 下、控制台配置根之外：**`beta-reset.sh` 的任何参数
  都不碰它**；`--archive-config` 只把密文随控制台配置根一起归档，归档搬回来用同一把就能解开。权限过宽、或者
  密文还在而它不在时，模型服务这一面停用（横幅 `providers  UNAVAILABLE (…)`），**绝不重新生成**——要么把它找回来，
  要么把密文库挪走留证、重新填密钥。它要和配置根分开备份：只备份了配置根，等于备份了一库打不开的密文。
  反过来，整目录 tar 控制台配置根（`beta-env.md` §6 L4）时要排除 `qianmo/console/provider-secrets.json`
  （`providers-console-m1.md` §3.8 ②）：带着密文离开 H 的快照，和主密钥只差一次拷贝。
- **逐节点的执行器**，从 `peers.conf` 派生：
  - 有 `node` 坐标行、且 `$QIANMO_BETA_MODEL_KEY_DIR/<node>` 在 → ssh，用这把**专用 key**；
  - 没有坐标行、端点是回环（节点跑在 H 自己身上）→ 控制台直接起本仓库的 `ops/model-apply.sh <node>`，不经 ssh；
  - 其余（直连的远端节点、缺 key）→ WARN 后跳过，页面上它显示为中枢够不着。
- **中枢自有的 known_hosts** `--provider-known-hosts $QIANMO_BETA_MODEL_KEY_DIR/known_hosts`，
  `StrictHostKeyChecking=yes`：没有条目的节点在起 ssh 之前就被拒绝。

每个远端节点装一次（H 上生成 key，节点上加一行；**不是隧道那把**——`authorized_keys` 里同一把公钥只有第一行的
选项生效，强制命令不同就必须是不同的 key）。`ops/model-apply-enroll.sh` 一条命令做完下面 ①–③ 并验一次
（见「模型服务迁移与真机验收」）；手工做法照旧留在这里：

```bash
# ① H：每个节点一把专用 key，私钥不离开 H
( umask 077; mkdir -p ~/.ssh/qianmo-model-apply )
ssh-keygen -t ed25519 -N '' -C "qianmo-model-apply <node>" -f ~/.ssh/qianmo-model-apply/<node>
# ② 节点机：authorized_keys 加一行（部署根是节点上那棵仓库树；restrict 关掉转发、pty、agent）
#    command="<部署根>/demo/env/beta/ops/model-apply.sh <node>",restrict <上一步的 .pub 内容>
# ③ H：登记节点的主机公钥。**核对指纹后**再追加——这一份就是中枢唯一认的主机钥
ssh-keyscan -p <port> <host> > /tmp/<node>.hostkey && ssh-keygen -lf /tmp/<node>.hostkey   # 与节点上 ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub 比对
cat /tmp/<node>.hostkey >> ~/.ssh/qianmo-model-apply/known_hosts && chmod 600 ~/.ssh/qianmo-model-apply/known_hosts
# ④ H：重起控制台（单元从 ops/console.env 取尾参，--providers 活得过重启）。两种起法的重起不一样，
#    见「模型服务迁移与真机验收」那一节
systemctl --user restart qianmo-console.service
```

`model-apply.sh` 做的事只有一件：在该节点的配置根下跑 `qm provider serve-stdin --node <node>`，stdin、stdout 原样
透传，自己不读 stdin（密钥在那一行里）。它**不读 `SSH_ORIGINAL_COMMAND`**：中枢发来的客户端命令是一个不存在的哨兵
`qianmo-model-apply-v1`——`authorized_keys` 那一行丢了或被改写时，sshd 去执行哨兵、操作失败，而不是静默成功。
节点名不合法、这台机器上没有这个节点的配置根时，它回一行 `bad-request`；同一节点上另一个操作没结束时等锁，超时回
`busy`。**那一行仍是一道会静默失效的门**（§8.3）：被改写成别的命令之后哨兵帮不上忙，列进巡检项。

## 模型服务迁移与真机验收（P18.13）

顺序、每一步的判据与回滚在 `docs/dev/beta-env.md` §13；这里只放命令。尖括号里全是变量，真实值只写在
私有证据目录里。

### 节点信任控制台的签名、控制台签对话（P18.20）

```bash
# ① H：控制台的签名身份（一行 console=<公钥>），与「签名唤醒」是同一把
IDENTITY="$(./demo/env/beta/beta-up.sh --print-wake-identity)"
# ② 每台节点机：信任它，并让它签的 /autocompact、/compact、/context 当本地命令跑。原有的 --trust 一起带上
./demo/env/beta/beta-down.sh <节点> && ./demo/env/beta/beta-up.sh --role node --node <节点> -- \
  --trust "$IDENTITY" --local-commands-from console
# ③ H：控制台签对话（尾参落进 ops/console.env，单元重启后仍在）。不带的尾参等于撤掉：
#    先看 ops/console.env 的 CONSOLE_EXTRA_ARGS，原有的尾参一起带上，下面只是示例
./demo/env/beta/beta-down.sh console && ./demo/env/beta/beta-up.sh --role host -- \
  --accounts --providers --wake-sign --chat-sign
```

节点腿的尾参落在 `<根>/state/<节点>.passthrough`，之后不带 `--` 的重起沿用它；控制台不带尾参重跑会 WARN
点名撤掉了哪些。判据：`logs/<节点>.out` 首行 `trusts` 含 `console`、`localCommandsFrom` 是 `["console"]`；
`logs/console.out` 的 `chat` 行以 `enabled as qianmo://console/operator (signed) -> ` 开头（`--chat-from` 的缺省地址；
地址里的节点名 `console` 要与节点 `--trust console=<公钥>` 的名字相同）。

### 缓存调参：按节点放进 `model-env`

`OPENAI_PROMPT_CACHE_RETENTION=24h` 只开在 `<保留期节点>` 一个节点上（CH-5 对照：一个开、其余不开，比较 idle>TTL
类零命中的占比，`docs/dev/providers-console-m1.md` §5.11.8）；`OPENAI_PROMPT_CACHE_DIAGNOSTICS=1` 只开在 `<诊断节点>`
一个节点上（G-1 归因）。两者可以是同一个节点，也可以不同，由 B 段定；**其余节点都不加**。写进那台机器的
`secrets/model-env`，一行一个，重起该节点。它们不是模型凭据，节点迁到中枢托管之后也不会被
ACP 子进程的 env 剥掉；起节点时横幅多一行 `缓存调参 : <名>=<值>`（值只回显认识的几种，其余写「未回显」）。
节点迁到中枢托管之后（`nodes/<节点>/config/qianmo/provider/state.json` 记着一次已提交的下发），没有 `model-env`
不再报 `Not logged in`；`model-env` 里还留着模型服务类的键时 WARN `env-residue`，只报个数。

### 第六类动作专用 key：`ops/model-apply-enroll.sh`

在**运维本机**跑，经 ssh 调中枢与节点部署树里的同一个脚本：

```bash
demo/env/beta/ops/model-apply-enroll.sh enroll --node <节点> \
  --hub <H> --hub-tree <H 部署根> --node-ssh <节点 ssh> --node-tree <节点部署根> --dry-run
demo/env/beta/ops/model-apply-enroll.sh enroll --node <节点> \
  --hub <H> --hub-tree <H 部署根> --node-ssh <节点 ssh> --node-tree <节点部署根>
# 在 H 上重起控制台：它起来时才看专用 key 在不在。先看是哪种起法
systemctl --user is-active qianmo-console.service
#   active：单元起的 → 原样重起（ExecStop 是 beta-down.sh console，ExecStart 从 ops/console.env 取尾参）
systemctl --user restart qianmo-console.service
#   inactive（或宿主没有 systemd --user）：手工 beta-up.sh --role host 起的 → 停掉，带全原来的尾参重跑同一条 host 腿。
#   尾参就是 ops/console.env 里 CONSOLE_EXTRA_ARGS 的每一个，少带一个就等于撤掉它
./demo/env/beta/beta-down.sh console && ./demo/env/beta/beta-up.sh --role host --only console -- <CONSOLE_EXTRA_ARGS 的全部尾参>
```

单元 `inactive` 时**不要**用 `systemctl --user restart`：它只会 start 单元，ExecStart 的 `beta-up.sh` 见控制台在跑就不重起
（幂等），跑着的还是旧进程，`providers` 行不会多出新登记的节点。判据：`run/console.pid` 的 pid 变了，`providers` 行列出
这个节点、是 `/ssh`。

| 步 | 在哪 | 做什么 |
|---|---|---|
| ① `hub-key` | H | `$QIANMO_BETA_MODEL_KEY_DIR/<节点>` 不在就生成（ed25519，私钥不离开 H）；在就不重生成 |
| ② `hub-coordinate` | H | 从 `peers.conf` 的 `node` 坐标行取 `user` / `host` / `port`——中枢执行器拨的就是它；没有坐标行就拒绝 |
| ③ `node-install` | 节点 | `--node-ssh` 登录的用户必须就是坐标行的 `user`（中枢拨的就是它），否则拒绝；`~/.ssh/authorized_keys` 幂等加一行 `command="<节点部署根>/demo/env/beta/ops/model-apply.sh <节点>",restrict <公钥> qianmo-model-apply <节点>`；同一把公钥带着别的选项 → 拒绝；同节点旧 key 的行 → WARN、不删；写之前备份 `authorized_keys.bak-<戳>` |
| ④ `node-hostkey` | 节点 | 经这条已认证的 ssh 读节点 sshd 自己的主机公钥：`/etc/ssh/ssh_host_{ed25519,ecdsa,rsa}_key.pub` 有几把读几把；一个 `.pub` 都没有（有的镜像只留私钥）时，改在节点上 `ssh-keyscan 127.0.0.1:22` 问本机 sshd 出示的那几把（本机 22 端口只有 root 起的 sshd 绑得上，信任锚不变，⑤ 照样逐把比对）；回环也问不到 → 拒绝 |
| ⑤ `hub-known-host` | H | 从 H 上 `ssh-keyscan` 一次：扫到的每一把都要与 ④ 同类型那一把逐字相同，有一把不同 → 拒绝；两边都有的类型（`ssh-ed25519`、`ecdsa-sha2-*`、`ssh-rsa`）才写进中枢 `known_hosts`（22 口写 `host`，否则 `[host]:port`）；同名同类型已登记另一把 → 拒绝 |
| ⑥ `hub-verify` | H | 用控制台执行器同一组 ssh 参数与哨兵 `qianmo-model-apply-v1` 发一次 `status`，要 `ok:true` |
| 撤回 `hub-key-discard` | H | 只给 `enroll` 用：写的阶段后面一步失败时，删掉这一次刚生成的那一对 key（公钥逐字相同才删） |
| 撤回 `node-uninstall` | 节点 | 只给 `enroll` 用：authorized_keys 与「备份 + 那一行」逐字节相同时把备份换回原位；不同就拒绝、手工处理 |

**顺序：先全部检查，再写。**`enroll` 先只读地走一遍 ② ① ③ ④ ⑤（坐标、key、节点前置与 authorized_keys 冲突、
主机钥比对、中枢 known_hosts 冲突），任何一项会拒绝都在第一次写入之前拒绝，三台机器零改动；全过之后才按
① ③ ⑤ 写，最后 ⑥。写的中途某一步失败（连接断了、盘满了），用上面两个撤回子命令把这一次写下的东西撤掉；
撤不回就打印手工回滚的那几条。⑥ 失败时三处都已写好、彼此一致，不自动撤回（原因与回滚见输出）。
`--dry-run` 只走检查那一遍，打印「将要」写的那一行与 known_hosts 那几行，不跑 ⑥。退出码：0 做完；1 拒绝或某步失败；
2 用法错。前提：节点 sshd 至少出示一把 ed25519 / ecdsa / rsa 主机钥（读 `/etc/ssh/ssh_host_*_key.pub`，没有时问本机回环 22 口）、节点上部署根下 `demo/env/beta/ops/model-apply.sh` 可执行、`~/qianmo-beta/nodes/<节点>/config` 在
（sshd 强制命令下没有 `QIANMO_BETA_ROOT`，所以节点必须用默认内测根）。跑在 H 自己身上的节点走 local，不需要登记。

### 首次下发与清 `model-env`

首次下发（`beta-env.md` §13.2 第 7 步）逐个节点做，**会话选「保留」**：

```bash
# 页面：模型服务 → 节点那一行「下发」→「会话」选「保留」。等价的 API（ops 个人账号的 token）：
#   POST /v0/providers/apply   {"nodes":["<节点>"],"sessions":"keep"}
```

缺省的「按线路与主机判断」只在中枢记着这个节点上一次已提交的下发、且线路与主机都相同时才保留；首次下发没有
可比的记录，**一定是重置**——节点清掉全部会话映射，每个上下文（值守作业也一样）都开新会话。「保留」要节点报告
`replayFilter`，刷新后选不了就停下来查，不要退回缺省。

清 `model-env`（第 8 步）时，`<接力节点>` 先把 key 挪走再删：`handoff-node.sh start` 给 app-server 的模型 key 读
`secrets/handoff-model-env`（`QIANMO_HANDOFF_KEY_ENV`，缺省 `OPENAI_API_KEY`），这份文件不在时才退回 `model-env` 并告警。
先把那一行写进 `secrets/handoff-model-env`（`chmod 600`），确认下一次 start 不再告警，再删 `model-env`；顺序反了，
下一次 `handoff-node.sh start` 直接退出。换个名字留在 `model-env` 里不行：resident 照样载入它，ACP
子进程只按名单剥键，不认的名字不剥。不删则该节点的 A1 判红（`env-residue`）。

### 每轮验收：`ops/provider-acceptance.sh`

```bash
demo/env/beta/ops/provider-acceptance.sh round --config <轮配置> --out <证据目录> --label <轮名>
demo/env/beta/ops/provider-acceptance.sh compare <证据目录>/round-<甲> <证据目录>/round-<乙> --min-gap-minutes 30
touch <证据目录>/HOLD     # 叫停：开跑前与每一项开始前都查它，退出码 42
```

轮配置（只有地址与路径；控制台凭据是 `<ops 凭据文件>`，0600，一行 token）：

```json
{
  "v": 1,
  "console": { "url": "<控制台 URL>", "credentialFile": "<ops 凭据文件>", "chatAs": "console" },
  "machines": {
    "<机器甲>": { "ssh": "<ssh 目标>", "tree": "<部署根>" },
    "<机器乙>": { "ssh": "<ssh 目标>", "tree": "<部署根>", "root": "<内测根，可省>" }
  },
  "hub": "<机器甲>",
  "nodes": { "<节点>": { "machine": "<机器乙>", "profileId": "<期望的档案>" } },
  "expect": { "sourceCommit": "<标签的 40 位提交>" },
  "switch": { "node": "<节点>", "profileId": "<换过去的档案>" },
  "call": { "node": "<节点>" },
  "inflight": { "target": "qianmo://<节点>/<agent>" },
  "canary": { "node": "<节点>", "baseUrl": "http://127.0.0.1:9/v1", "realApply": false }
}
```

`switch.profileId` 选与该节点原档案同线路、同主机的一份（中枢据此保留会话，换线路或主机会重置会话）；`canary.realApply` 缺省 `false`（理由见 `docs/dev/beta-env.md` §13.3）。`timing` 可省（轮询、超时、重试间隔、`ps` 采样间隔都有缺省）；`inflight.prompt` 可省（缺省是一段要写几十秒的
短文）。远端动作经 `ssh` 起部署树里的 `demo/env/beta/ops/provider-acceptance-node.ts`（只用 node 内建模块，
部署树只有 `dist/` 与 `demo/` 也能跑）；`QIANMO_ACCEPTANCE_SSH_BIN` 可换 ssh 程序。退出码：0 零红（compare：
两轮通过）；1 有红；2 用法或配置错；42 HOLD。每一项的判据见 `docs/dev/beta-env.md` §13.3。

## 值守作业（`ops/watch-hub.sh`，`qm watch`）

跑在 H 上的 `qm watch`（P13.6；起法与判据的真源是 console.md §10，这里只写内测的三条接线）：

1. **配置根是控制台那一份**（`<根>/nodes/console/config`）。签名身份按配置根落盘，`print-identity`
   与 `run` 问的是同一个根；调度状态与 `ESTOP` 在 `<根>/nodes/console/config/qianmo/scheduler/`。
2. **一个单元只服务一个节点**：`qm watch` 只读一把 `QIANMO_TRANSPORT_PSK`，而内测是每节点一把。
   `install --node` 钉死目标，`run` 从 `secrets/peers/<节点>.psk` 读进环境，并先查作业文件里每个
   `target` 都在这个节点上。
3. **先 trust，后 `--sign`**（console.md §10.1.1）。

```bash
demo/env/beta/ops/watch-hub.sh print-identity                        # → hub=<公钥>
demo/env/beta/beta-down.sh <节点> && demo/env/beta/beta-up.sh --role node --node <节点> -- \
  --trust console=<控制台公钥> --trust hub=<上面那一行的公钥>         # 已有的 --trust 要一起带上
demo/env/beta/ops/watch-hub.sh install --node <节点> --jobs ./jobs.json --sign   # 只 enable，不 start
systemctl --user start qianmo-watch.service                          # 开始值守
```

- 单元 `Restart=on-failure`、`OOMScoreAdjust=900`；停手不必停单元：`touch <根>/nodes/console/config/qianmo/scheduler/ESTOP`
  （只挡新的 fire，在途不杀）。
- 它跑的是交付树里的 `dist/cli-node.js`：**换产物之前先 `systemctl --user stop qianmo-watch.service`**，否则
  `beta-deploy.sh` 会因为树里有进程而拒绝。
- 确认签名生效：中枢审计链 `watch_fire` 的 `detail.signed=true`，节点链上这条请求没有 `capability_shadow_refusal`。

## 可用性与唤醒探针（`ops/fleet-probe.sh`）

M1 出口「可用性 ≥ 99%（按内测时段计）、唤醒 P95 < 30 s」的量具，跑在 H 上，三个 timer：

| timer | 频率 | 量什么 | 样本文件（`<根>/state/fleet-probe/`） |
|---|---|---|---|
| `qianmo-probe-minute` | 每分钟 | 每个节点端点真读一行应答（426，不是 TCP 探测）；注册中心与控制台 `/v0/health` | `avail-<节点>.ndjson`、`health.ndjson` |
| `qianmo-probe-handshake` | 每 5 分钟 | 按名解析 + 真 PSK 握手（`p81-probe`，**不带 `--task`**） | `handshake-<节点>.ndjson` |
| `qianmo-probe-wake` | 每 10 分钟一格 | 按轮转表经控制台 `POST /v0/wake` 唤醒一个节点，记发起 → 回执与 msgId | `wake-<节点>.ndjson` |

```bash
demo/env/beta/ops/fleet-probe.sh install --rotation "beta-1 beta-5 beta-4 beta-1 beta-5 -"   # 一格 10 分钟，- 为空格
systemctl --user start qianmo-probe-minute.timer qianmo-probe-handshake.timer qianmo-probe-wake.timer   # 开始计时
```

- **唤醒口径（写死在这里，免得被误读）**：发起 → 首个内容 = 本探针记的发起时刻 + 节点 `--timings` 里按
  msgId 关联的 `first_content`，离线算。**这不是 baseline-m0 §3 的「沙箱冻结 → unpause → 就绪」链路**——
  内测舰队上没有沙箱冻结，量的是常驻节点空闲态的唤醒。两个数不能直接比，也不能写成 AC-2 口径。
- 唤醒走控制台而不是 `resident-wake`：那是用户真实走的路；控制台带 `--wake-sign` 时唤醒是
  verified-capability 档，不会在节点链上留 `capability_shadow_refusal`。握手那一档不带 `--task` 也是同一个理由。
- 失败的样本照记，不剔除；P95 按 nearest-rank 算，失败按 +∞ 留在样本里。
- `MemAvailable` 低于 `PROBE_MIN_AVAILABLE_MB`（默认 150）时只记一行 `skipped:low-mem`：H 上的量具不能成为
  压垮它的那一个进程。单元带 `OOMScoreAdjust=900`。
- install **只 enable 不 start**：开始计时是一个有意的动作，要和「这一份部署」对上号。

## 接力节点（P17.5，`handoff-node.sh`）

关机转交之后在云端续跑的那一端：节点桥 `qm handoff node` 收中枢签名的 `task.request`，在本机裸仓上开工作树，
交给旁边的 `qmcode app-server` 续会话，回合结束把改动提交到 `qianmo/<任务>`、回 `task.result`。中枢那一侧的
参数与状态见 [`docs/dev/handoff-usage.md`](../../../docs/dev/handoff-usage.md)。

```bash
# ① 装 qmcode：部署树新的顶层 qmcode/（fork 产物目录 + 一条 qmcode -> <产物名> 软链）。
#    装完核对两个程序同目录、可执行、.sha256 逐行对得上、qmcode --version 跑得起来。
demo/env/beta/beta-deploy.sh --tree <部署树> --from <构建树> --only qmcode
# ② 起（先节点桥、后 app-server；节点机上要有 bwrap，没有就拒绝启动并说原因）
QIANMO_HANDOFF_BASE_URL=<网关 /v1 地址> demo/env/beta/handoff-node.sh start \
  --node <节点名> --trust <中枢控制台 --print-wake-identity 打的那一行> --project <项目>
# ③ 停（只停进程，裸仓、工作树、结果一个不删）
demo/env/beta/handoff-node.sh stop
```

- **key 只进 app-server**：从 `secrets/handoff-model-env` 读（`KEY=VALUE`，0600、属当前用户、不是软链，不合就拒绝启动），
  变量名由 `QIANMO_HANDOFF_KEY_ENV` 定（默认 `OPENAI_API_KEY`）。常驻节点不读它。这份文件不在时退回 `secrets/model-env`
  并告警（P17.5 的旧做法；节点迁到中枢托管后那里的模型服务类键会被清掉）。两份文件里都没有这个变量名就拒绝启动。
  节点桥起在载入之前，命令前还用 `env -u` 去掉两份文件里的每个键名；app-server 那边去掉传输 PSK。从旧做法迁过来：

  ```bash
  (umask 077 && grep '^OPENAI_API_KEY=' <内测根>/secrets/model-env > <内测根>/secrets/handoff-model-env)
  demo/env/beta/handoff-node.sh stop
  QIANMO_HANDOFF_BASE_URL=<网关 /v1 地址> demo/env/beta/handoff-node.sh start …   # 不再报「旧做法」
  ```
- **配置每次 start 重写**：`<根>/handoff/qmcode-home/config.toml`，模型走 `[model_providers.qianmo]`（`responses`），
  `[features] plugins = false`、工具 shell 只继承核心环境变量、内置的阡陌 MCP 写完整表并关掉。app-server 命令行另带
  `-c mcp_servers.qianmo.enabled=false -c 'notify=[]'`：qmcode 内置的那两样在节点上会反过来调接力命令。
- app-server 只听本机回环（默认 38631），令牌 `secrets/handoff-app-server-token` 本机生成、0600；节点桥入站默认
  38630，绑定地址与常驻节点同一个默认（`QIANMO_BETA_NODE_BIND`），PSK 用本机 `secrets/transport-psk`。
- 不用 `app-server daemon`（它自带更新与生命周期管理）。`beta-down.sh` 不给名字时也会停这两个进程。
- 换 `dist` 或 `qmcode` 之前先 `handoff-node.sh stop`：两个进程都跑在部署树里，`beta-deploy.sh` 会拒绝。

## 变量表

一律用环境变量覆盖，脚本里没有任何具体名字、机器名、IP、域名、密钥（beta-env.md 文首）。

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `QIANMO_BETA_ROOT` | `$HOME/qianmo-beta` | 内测根目录。**长驻**，故意在仓库外——它要活过 `git clean`、活过换分支。与演示环境的 `.demo-env` 不是一回事，两者可以在 H 上共存 |
| `QIANMO_BETA_PEERS_FILE` | `$QIANMO_BETA_ROOT/peers.conf` | 地址表（地址行 + 可选的 `node` 坐标行，见上一节）。**H 腿的必填项**，0600，不进仓库 |
| `QIANMO_BETA_REGISTRY_PORT` | `38620` | 注册中心。**永不出回环**（它默认零鉴权；写 token 也只挡写不挡读，§9.2） |
| `QIANMO_BETA_CONSOLE_PORT` | `38621` | 控制台。绑回环，对外那一面由反代做 TLS（§2.5） |
| `QIANMO_BETA_NODE_PORT` | `38625` | 节点入站。一机一节点，四台用同一个号不用协调 |
| `QIANMO_BETA_HOST_BIND` | `127.0.0.1` | 注册中心与控制台绑哪。**改成非回环等于同时废掉 §2.5 与 §9.2 两条硬规矩** |
| `QIANMO_BETA_NODE_BIND` | `0.0.0.0` | 节点入站绑哪。默认全网是**有意的**：节点要被 H 拨到，而无 sudo 的 VPS 上没有包过滤，那个端口上唯一的门本来就是 PSK 握手（§2.6/§8.2）。改成 `127.0.0.1` 会得到一个「起得来、名册上在线、H 拨不通」的节点 |
| `QIANMO_BETA_NODE` | `beta-1` | 节点名。**四台机器上必须各不相同**；没给 `--node` 时脚本会 WARN |
| `QIANMO_BETA_AGENTS` | `planner reviewer` | 该节点的 agent（每节点 2 个，按用途分不按人分，§2.2）。也可用重复的 `--agent` 给 |
| `QIANMO_BETA_TEAM` | `atlas` | `occ resident --team` |
| `QIANMO_BETA_LABEL` | console.conf > `阡陌内测环境 · 多节点审计视图` | 页头标签。它是唯一一个 50 个人都会看到、且不需要账号体系的广播位（§7.4）。**这是设置它的唯一入口**：脚本没有 `--label`，尾参里的 `--label` 只对这一趟的进程生效（标签含空白，写不进 `ops/console.env` 的一行）。`--help` 里单独有一段（issue #60） |
| `QIANMO_BETA_SSH_KEY` | `$HOME/.ssh/id_ed25519_qianmo` | 隧道与镜像共用的私钥（H 上的路径）。单条坐标行可用 `key=` 覆盖 |
| `QIANMO_BETA_MODEL_KEY_DIR` | `$HOME/.ssh/qianmo-model-apply` | 模型服务第六类动作的专用 key（每个远端节点一把，文件名就是节点名）与中枢的 `known_hosts`。只在控制台尾参有 `--providers` 时用到，见「模型服务」 |
| `QIANMO_BETA_MIRROR_INTERVAL_MIN` | `5` | 审计镜像拉取间隔。它同时决定每个镜像审计卡上的「滞后 ≤ N 分钟」标注 |
| `QIANMO_BETA_BACKUP_URL` | 无 | 节点写快照的 https 地址（§2.7）。**不设就不开备份面**；给了就必须有写 token |
| `QIANMO_BETA_BACKUP_INTERVAL_MS` | `3600000` | §5 的定案（从默认 15 min 调到 60 min，算过账：15 min 是 3.8 GB/天） |
| `QIANMO_BETA_READY_TIMEOUT_S` | `90` | 就绪探测预算。2 vCPU 机器上首次拨号实测 6.5–7.1 s，重试会吸收掉 |

密钥文件（都不由脚本生成，除控制台两枚 token 外——理由见下）：

| 文件 | 在哪台机器 | 装什么 |
| --- | --- | --- |
| `secrets/transport-psk` | 每台节点机 | **只有本机这个节点那一把**（§8.3）。一台 VPS 被拿下时，攻击者只拿到它自己那一把 |
| `secrets/peers/<node>.psk` | 只在 H | **全部四把**（运维副本）。唤醒与投递都从 H 发起 |
| `secrets/console-view-token` / `console-admin-token` | 只在 H | 控制台两枚。首跑时脚本现生成一次并落 0600 文件，**之后跨重启不变**——「显式提供」要的正是这个（§3.2）；控制台自己生成的那条路每次重启都变，50 个人手上的链接会同时失效 |
| `secrets/registry-write-token` | 只在 H | 注册中心写 token（P15.8）。**不由脚本生成**：文件在，注册中心要求它、控制台带上它；不在，注册中心照旧不鉴权。启用有先后，见「注册中心写 token」 |
| `secrets/backup-write-token` | 每台节点机（若开备份面） | 只写。**归档 token 永不下发到节点机**（§2.7） |
| `secrets/backup-archive-token` | 只在 H | 只读归档 |
| `secrets/model-env` | 每台节点机 | 该节点的模型凭据，一份 `KEY=VALUE` 的 shell 片段。节点腿在**起 resident 之前**注入它（ACP 子进程继承 resident 起来那一刻的环境，事后 export 到不了）。**H 上不需要也不该有**：控制台不跑 agent 轮次。没有这个文件节点照常起，但被唤醒后 agent 那一轮必然是 `Not logged in · Please run /login`——脚本与 resident 各会为此报一条 |
| `~/.ssh/id_ed25519_qianmo`（可换，见变量表） | 只在 H | 隧道与镜像那把 key。**私钥不离开 H**；它在各节点的 `authorized_keys` 里带强制命令，除了转发那一个端口和 `cat` 自己那条链，什么都做不了 |
| `secrets/provider-master.key` | 只在 H | 模型服务的主密钥（P18.6）。**由控制台生成**，不由脚本生成；`beta-reset.sh` 任何参数都不碰。见「模型服务」 |
| `~/.ssh/qianmo-model-apply/<node>`（可换，见变量表） | 只在 H | 第六类动作的专用 key，每个远端节点一把。它在该节点的 `authorized_keys` 里带 `command="…/model-apply.sh <node>",restrict`，除了对这个节点跑模型服务的五个操作，什么都做不了 |

非密钥、但同样 0600 且不进仓库的两份：

| 文件 | 装什么 |
| --- | --- |
| `peers.conf` | 地址表 + `node` 坐标行（含机器地址与 SSH 用户） |
| `ops/tunnel-<node>.env` | 由坐标行派生的连通定义。**手改会被覆盖，要改就改 `peers.conf`** |

### `console.conf` —— 页头标签的持久化

`<root>/console.conf`（0600）只存 `LABEL`。

**旧 schema 会被报出来再删掉。**`AUDIT_NODE` / `AUDIT_PATH` / `WAKE_NODE` 曾经也存在这里
（单数写法，一份文件只放得下一个目标）。它们现在一个字都不生效，但没人读不等于没人写——
2026-08-24 的实查里 H 上那份还整整齐齐写着它们。`beta-up.sh --role host` 读到就 WARN 一句
并在回写时删掉，不再静默忽略（issue #45）。

节点名册只有 `peers.conf` 一份：`beta-up.sh --role host` 按其中每个当前节点各生成一条
命名 `--audit` 和一条命名 `--wake-url`。权威或镜像路径、镜像滞后以及节点 PSK 都由这份
名册和对应的 `secrets/peers/<node>.psk` 派生；`console.conf` 绝不追加或保留一个目标。
删掉 peer 后再起控制台，那个节点不会从旧配置复活。


操作上，`QIANMO_BETA_LABEL` 的优先级是 **环境变量 > `console.conf` > 派生默认**，胜出的
标签会被回写。改完这一个展示项后，要先停掉正在运行的 console，再重新运行 H 腿才会生效。
手改这个文件立刻生效（下一次 `beta-up.sh` 起控制台时）。**注意控制台是幂等启动的**：已经
在跑的那一份不会被重起，所以改完要让它生效得 `beta-down.sh console && beta-up.sh --role host`。

**存量 `LABEL` 与名册对不上会 WARN。**上面那条只删了旧 schema 的三个键，`LABEL` 自己
**同样会过期而没有守卫**：2026-08-24 铺新产物时 H 上躺着的是单节点时代的
「…审计视图：beta-1（…权威副本在节点本机）」，而控制台早已是四目标形态——那一趟显式带了
`QIANMO_BETA_LABEL` 才没让页头退回单节点文案（issue #60）。现在标签点名的节点与
`peers.conf` 对不上时会 WARN 一句，形状与 #45 那条一致。

判据故意窄，**只在标签自己点名了名册的一部分时才说话**：

- 一个节点名都没提的标签（派生默认那句「多节点审计视图」就是）永远不报；
- 提全了的不报。`beta-1..4` 这种**区间写法先展开再比**——现场那份正确的标签正是这个形状，
  不展开就会每跑一次假警报一次，而一条会误报的警等于没有警；
- 提了一部分（标签写 `beta-1`、名册四个），或提到名册里已经没有的名字（`beta-9`）——报。

标签不影响任何一条链路，所以没有别的东西会为此变红。这条守卫存在的理由就是这个：
它是**唯一**会说话的地方。

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
| 5 | `$QIANMO_CONFIG_DIR/sub`（外层设了 `QIANMO_CONFIG_DIR`） | `beta_guard_root`：按调用方环境再拦一次 |
| 6 | 目录存在但没有标记文件 | `beta_require_marker`：不去猜「这大概是我上次建的」 |
| **7** | 目录里有 `.qianmo-demo-env` | 内测特有：那是**演示**环境根。H 上两套拓扑并存（§2.6），传错一个就是内测的 reset 去动演示的数据 |
| **8** | 标记文件首行被改成别的字符串 | `beta_require_marker`：伪造的标记不算数 |

链路那一半的路径不在内测根里（`~/.config/systemd/user/`），guard_root 管不到，所以另有一套
逐路径复核：`beta_assert_unit_file` 只允许动本包那五个文件名、且必须落在 systemd 用户单元
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
| 节点名册只认 `peers.conf`，页头标签可持久化 | `common.sh` 的 `beta_resolve_console_conf` 与 H 腿的循环 | 在 `console.conf` 手写旧的 `AUDIT_NODE` / `AUDIT_PATH` / `WAKE_NODE`，删掉一个 peer 后起 H 腿；生成的 `console.conf` 只留 `LABEL`，进程参数只含当前 peers |

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
H 上的 443 不归我们时，用上面「控制台 HTTPS：不占 443 的形态」那一套；它独立于本脚本，
`beta-up.sh` 不调它。
**开测前置检查「从校园网真拨一次 H 的 443」也不在这里**，那是人的动作（§10 包① DoD③）。

**③ 不做审计链镜像的 rsync —— 因为那把 key 根本起不了 rsync。**
镜像本身**现在做了**（`beta-up.sh --role host` 建 `qianmo-mirror@<node>.timer`，5 min 一次，
单向只读、节点 → H），但走的是 `ssh cat` 而不是 rsync：H 那把 key 在各节点的
`authorized_keys` 里带强制命令，rsync 协商不到远端 `--sender`，必然挂在握手上。理由与做法见
上面「镜像为什么只能是 `ssh cat`」。**只对有 `trail=` 坐标的节点做**；没有坐标行的节点，
它的链仍然只在节点本机，H 上看不到。
`beta-smoke.sh` 照旧只**读**镜像来验链：`mirror/<node>/trail.ndjson` 在就验它，不在就报缺。

**④ 不把保留与轮转塞进 reset 或入站服务。**§5 的数字由宿主侧
[`beta-retain.sh`](./beta-retain.sh) 独立处理；`beta-reset.sh` 的 `--purge-logs` 仍然是「重来一次」
的动作，不是轮转，别拿它当保留策略用。

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
- `shellcheck demo/env/beta/*.sh demo/env/beta/ops/*.sh` 干净（0.11.0 实测）。`common.sh` 里有一条文件级
  `disable=SC2034`——它是被 source 的公共层，shellcheck 看不到消费方向，`demo/env/common.sh`
  有同样的 12 条告警；**只在那一个文件禁用，四个消费脚本仍然全开**。
- 不需要 `curl`：`beta_http_status` 有 bun 兜底（bun 本来就是硬依赖）。
