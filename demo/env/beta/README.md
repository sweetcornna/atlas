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

起完各自自检：

```bash
./demo/env/beta/beta-smoke.sh --role node --node <节点名>   # 节点机上：只证本机那一半
./demo/env/beta/beta-smoke.sh --role host                  # H 上：DoD① 的四条判据都在这里
```

停机 `./demo/env/beta/beta-down.sh`（`beta-down.sh <名字>` 只停一个，即 §6 L0 的第①步），
回到干净运行态 `./demo/env/beta/beta-reset.sh`。

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
```

## 变量表

一律用环境变量覆盖，脚本里没有任何具体名字、机器名、IP、域名、密钥（beta-env.md 文首）。

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `QIANMO_BETA_ROOT` | `$HOME/qianmo-beta` | 内测根目录。**长驻**，故意在仓库外——它要活过 `git clean`、活过换分支。与演示环境的 `.demo-env` 不是一回事，两者可以在 H 上共存 |
| `QIANMO_BETA_PEERS_FILE` | `$QIANMO_BETA_ROOT/peers.conf` | 地址表（`<地址> <入站端点>`，一行一条）。**H 腿的必填项**，0600，不进仓库 |
| `QIANMO_BETA_REGISTRY_PORT` | `38620` | 注册中心。**永不出回环**（它零鉴权，§9.2） |
| `QIANMO_BETA_CONSOLE_PORT` | `38621` | 控制台。绑回环，对外那一面由反代做 TLS（§2.5） |
| `QIANMO_BETA_NODE_PORT` | `38625` | 节点入站。一机一节点，四台用同一个号不用协调 |
| `QIANMO_BETA_HOST_BIND` | `127.0.0.1` | 注册中心与控制台绑哪。**改成非回环等于同时废掉 §2.5 与 §9.2 两条硬规矩** |
| `QIANMO_BETA_NODE_BIND` | `0.0.0.0` | 节点入站绑哪。默认全网是**有意的**：节点要被 H 拨到，而无 sudo 的 VPS 上没有包过滤，那个端口上唯一的门本来就是 PSK 握手（§2.6/§8.2）。改成 `127.0.0.1` 会得到一个「起得来、名册上在线、H 拨不通」的节点 |
| `QIANMO_BETA_NODE` | `beta-1` | 节点名。**四台机器上必须各不相同**；没给 `--node` 时脚本会 WARN |
| `QIANMO_BETA_AGENTS` | `planner reviewer` | 该节点的 agent（每节点 2 个，按用途分不按人分，§2.2）。也可用重复的 `--agent` 给 |
| `QIANMO_BETA_TEAM` | `atlas` | `occ resident --team` |
| `QIANMO_BETA_AUDIT_NODE` | `beta-1` | 控制台 `--audit` 指哪条链。一期是单值（§4.3 的现状限制，落地包②抬掉） |
| `QIANMO_BETA_AUDIT_PATH` | 由上一行派生 | 直接指定链文件。要看镜像那一份就设成 `<root>/mirror/<node>/trail.ndjson` |
| `QIANMO_BETA_WAKE_NODE` | 同 `AUDIT_NODE` | 控制台唤醒目标。一期只能有一个：`--wake-url` 钉死单值，而 PSK 是每进程一把（§8.2） |
| `QIANMO_BETA_LABEL` | `阡陌内测 · 审计视图：<node>` | 页头标签。它是唯一一个 50 个人都会看到、且不需要账号体系的广播位（§7.4） |
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

**③ 不做审计链镜像的 rsync。**§4.3 的「H 侧只写、节点侧只读」的定时任务属于宿主侧工具
（落地包③ 的邻居）。`beta-smoke.sh` 只**读**镜像来验链：`mirror/<node>/trail.ndjson` 在就验它，
不在就报缺，不去建它。

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

## 兼容性

- **bash 3.2**（macOS 自带）：没有关联数组、没有 `mapfile`、没有 `timeout`（macOS 上根本没这个命令），
  一律不用。地址表用三个平行下标数组，去重用字符串包含判断。
- `set -euo pipefail` 全套；每个文件带 SPDX 头。
- `shellcheck demo/env/beta/*.sh` 干净（0.11.0 实测）。`common.sh` 里有一条文件级
  `disable=SC2034`——它是被 source 的公共层，shellcheck 看不到消费方向，`demo/env/common.sh`
  有同样的 12 条告警；**只在那一个文件禁用，四个消费脚本仍然全开**。
- 不需要 `curl`：`beta_http_status` 有 bun 兜底（bun 本来就是硬依赖）。
