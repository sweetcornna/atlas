# M0 演示环境（P8.1）

> **v0.1 · 2026-08-15 · 本地腿已实测，真机腿未验证**
>
> 一台全新机器按 §4 的 runbook 敲命令，就能起出「两个节点 + 一个注册中心」的完整本地
> 演示拓扑。真机腿（Dormice + gVisor）的脚本在 `demo/env/remote/`，**未在真机验证**，
> 原因见 §7.1。

| 项 | 内容 |
| --- | --- |
| 任务包 | roadmap P8.1（依赖 P6.1；owner 董宗岳 / backup 陈子轩） |
| DoD | 全新机器 **30 min 内**从零复现完整演示环境，由未参与部署的成员实测 |
| 交付物 | `demo/env/`（bootstrap / seed / up / down / reset / smoke + `remote/`）、`demo/lib/p81-{registry,probe}.ts`、本文 |
| 本地腿实测 | ✅ 干净 `git clone` 起跑到冒烟通过，见 §4.3 的计时表 |
| 真机腿实测 | ❌ **未验证**（验收机 SSH 不可达），见 §7.1 |
| 状态真源 | 各任务包的完成状态一律以 `roadmap.md` 的「完成状态速查」为准，本文不复述 |

---

## §1 两条腿

演示环境分成两条互不依赖的腿。**分栏不是为了好看，是为了不让「真机不可用」变成「什么都
演示不了」**——本地腿不需要任何云资源就能撑起 **AC-1 / AC-3 / AC-6(b)(c) / AC-7 / AC-8**
五条（且这五条连模型凭据都不需要），配上模型凭据再加 **AC-4 / AC-5** 两条；**非真机不可的
只有 AC-2 的休眠态与 AC-6(a)**。

| | 本地腿 | 真机腿 |
| --- | --- | --- |
| 跑在哪 | 任意一台装了 bun 的开发机（macOS / Linux 都可） | 装了 Dormice + gVisor 的 Linux 宿主 + 目标沙箱 |
| 起法 | `demo/env/up.sh` | `demo/env/remote/prepare-host.sh` + `prepare-sandbox.sh` |
| 拓扑 | 一台机器上**两个真进程**：两个配置根、两条审计链、两把节点身份 | 宿主跑 activator + 注册中心，沙箱内跑常驻 occ |
| 休眠态 | 没有（本地进程不会冻结） | 有（`docker pause` + `memory.reclaim`，AC-2 判据要的就是它） |
| 状态 | ✅ 已实测 | ❌ 脚本未验证 |

§6 是「哪条腿能演哪几条 AC」的完整对照表。

---

## §2 环境依赖清单

### 2.1 必须

| 依赖 | 要求 | 为什么是这个数 |
| --- | --- | --- |
| **Bun** | **1.3.13**（`.tool-versions` 的 pin）。硬下限是 `package.json` 的 `engines.bun >= 1.3.11` | 见 §2.2——这是本仓库最敏感的一条 |
| **Node** | 任意现代版本（本文实测 v26.3.0） | 不是给 `occ` 用的：`demo/lib/p61-worker.ts` 真的会 `spawn` 一个 node 子进程跑 AC-7 的分块计算；`demo/p61-e2e.sh` 因此把它列进了 `required` |
| **git** | 任意 | 克隆仓库；`seed.sh` 还要用它给两个节点各建一个真 git 工作区（AC-6(b) 恢复演示的对象就是这个形状） |
| **bash** | 4.x 或 macOS 自带的 3.2 均可 | `demo/env/*.sh` 只用两者都有的写法；未用 GNU 专有选项（`timeout` 在 macOS 上就不存在，脚本里因此一处没用） |
| 磁盘 | **约 1.3 GB**：`node_modules` 938 MB + `dist` 102 MB + 源码 + 演示状态（0.3 MB） | 实测值（macOS / arm64，`du -sh`），见 §4.3 |

### 2.2 Bun 版本为什么敏感（**这条别跳过**）

三件事叠在一起：

1. **`.tool-versions` 是 1.3.13，CI 用 `bun-version-file` 读它**（roadmap P0.4：CI 从前写
   `bun-version: latest`，与 pin 不一致，已修）。所以「CI 上是绿的」这句话只对 1.3.13 成立。
2. **`bun.lock` 是被 1.3.13 规范化过的**：bun 1.3.13 在装新依赖时把 493 条空解析字段改写成
   显式 URL（roadmap v2.31 记录，属一次性机械变更）。用别的版本跑 `bun install` 有可能把它
   改回去——那是一次谁都没打算做的提交，`bootstrap.sh` 因此在版本不一致时明确警告。
3. **本仓库的测量结论绑在具体版本上**：`process.memoryUsage().heapUsed` 在 Bun 1.3.13 下是
   **冻结常量**（`docs/dev/baseline-m0.md` §2.3），采样一律走 `bun:jsc heapStats`。换版本
   之前先看那一节，别拿旧结论套新运行时。

`bootstrap.sh` 的处置：**低于 `engines` 下限直接失败；与 pin 不一致则警告并继续**——把
1.3.14 的机器一律拦死会挡掉真实存在的验收路径（甲骨文那台 ARM 机就是 1.3.14），但
lockfile 若因此出现改动，**不要提交**。

### 2.3 只有真机腿需要

| 依赖 | 要求 | 出处 |
| --- | --- | --- |
| Docker | 已登记 `runsc` 运行时 | `demo/ac6a-sandbox.sh` 的 `command -v docker`；AC-6(a) 的 gVisor 出生契约 |
| gVisor | `runsc release-20260622.0`，systrap 平台 | `selection-m0.md` §1（不在此复述实验数据） |
| Dormice | 已安装并运行；`dor doctor` 全绿；`dormice.service` 应设开机自起 | roadmap P0.1 的服务器侧判据与遗留三项 |
| cgroup v2 | 可读 `/sys/fs/cgroup/cgroup.controllers` | P5.1 的 `oomKillDelta` 依赖它；macOS 上同一 OOM 只能给中等置信 |

版本与机器规格的真源是 `selection-m0.md` §1 与 roadmap 的「现状基线」表，本文只给指针。

### 2.4 端口

全部绑在回环，且都能用环境变量改（`demo/env/common.sh`）：

| 端口 | 谁在用 | 环境变量 |
| --- | --- | --- |
| 38610 | 注册中心 HTTP v0 | `QIANMO_DEMO_REGISTRY_PORT` |
| 38611 | 节点 A 的入站 WebSocket | `QIANMO_DEMO_NODE_A_PORT` |
| 38612 | 节点 B 的入站 WebSocket | `QIANMO_DEMO_NODE_B_PORT` |

其余 demo（AC-3、AC-7、混沌注入等）**各自起完自己的进程就收摊**，不占固定端口。

### 2.5 凭据：谁要、谁不要

| 演示 | 传输 PSK | 备份凭据 | 沙箱 daemon bearer | **模型凭据** |
| --- | --- | --- | --- | --- |
| `demo/env/up.sh` + `smoke.sh` | 要（seed 自动生成） | — | — | **ack 不要**，见下方脚注 |
| AC-3 `demo/ac3-loop-rate.sh` | 要 | — | — | 不要 |
| AC-6(b)(c) `demo/ac6b-restore.sh` | — | 要（seed 自动生成） | — | 不要 |
| AC-7 `make -C demo p61-smoke` | 要 | — | — | 不要（模型那一段是桩） |
| AC-8 `demo/chaos-inject.sh` | 要 | — | — | 不要 |
| P5.1 `demo/p51-diagnosis.sh` | — | — | — | 不要 |
| AC-1 `demo/ac1-restart.sh` | — | — | — | **最后一条判据要**（无凭据时明确跳过，不静默） |
| AC-4 / AC-5 | — | — | — | **要**（两家供应商） |
| AC-2 / AC-6(a)（真机腿） | 要 | — | **要** | 要（沙箱内跑真 turn） |

> **脚注（ack 与凭据的关系，说准一点）**：ack 是在**durable read 之后、turn 之前**发出的
> （P4.1 的设计，见 roadmap P4.1 与 `src/services/qianmo/resident.ts`），所以它在链路上早于
> 任何模型调用。本机两次实测 ack 分别是 **59 ms / 414 ms**。但要如实说明：**实测这两次的
> 机器环境里是有模型凭据的**（ACP 子进程继承环境变量），「没有凭据也能 ack」这句话依据的
> 是链路顺序，不是在一台无凭据机器上跑出来的对照。`task.result` 则确实要凭据，见 §7.3。

PSK 与备份凭据由 `demo/env/seed.sh` 在本机现生成（0600，落在 `DEMO_ROOT/secrets/`，
`.demo-env/` 已进 `.gitignore`）。**它们是演示专用的一次性密钥，不是任何真实系统的密钥。**
模型凭据本文不管——它按 occ 自己的方式配（环境变量或 `occ` 登录），演示脚本一个都不读。

> ⚠️ 一条要知道的事实：常驻节点的 ACP 子进程**继承整个进程环境**。演示环境隔离的是
> *配置根*，不是环境变量——你 shell 里的真实模型凭据会被子进程用上。这在需要跑真 turn 的
> 演示里正是想要的；不想要就在干净 shell 里起 `up.sh`。

---

## §3 目录布局与隔离

```
DEMO_ROOT/                      # 默认 <repo>/.demo-env，用 QIANMO_DEMO_ROOT 改
├── .qianmo-demo-env            # 标记文件 —— 一键重置的安全依据（见 §3.2）
├── secrets/                    # 0700：PSK、备份只写/归档凭据（各 0600）
├── nodes/
│   ├── node-a/config/          # 节点 A 的 OCC_CONFIG_DIR
│   ├── node-b/config/          # 节点 B 的 OCC_CONFIG_DIR
│   └── registry/config/        # 注册中心进程的配置根
├── workspaces/{node-a,node-b}/ # 各是一个真 git 仓库
├── state/                      # 注册表落盘、timings、probe/topology 快照、种子摘要
├── run/                        # pid 文件、registry ready 文件
└── logs/                       # 每个进程一对 .out / .err
```

### 3.1 配置隔离：三条硬规矩

1. **一切路径从 `src/config/paths.ts` 派生**（CLAUDE.md §1.1②）。演示脚本只设
   `OCC_CONFIG_DIR`，从不拼 `~/.occ` 之类的字面量。
2. **绝不碰用户真实配置根**。`~/.occ`、`~/.qianmo`、`~/.claude` 三个都是禁区；`common.sh`
   的 `demo_guard_root` 会拒绝把 `DEMO_ROOT` 设到它们里面（也拒绝家目录、仓库根、`/`）。
3. **每个节点一个配置根，不共用**。理由是审计链按配置根落一个文件
   （`occConfigPath('qianmo','audit','trail.ndjson')`）：两个常驻进程共用一个配置根，就是
   两条哈希链交替写进同一个文件，`occ audit --verify` 必然报断链——而那时候人会去查「谁改
   了审计文件」，其实只是拓扑搭错了。节点身份与常驻会话表同理。真实部署里两个节点本来
   就在两台机器上、各有各的配置根，这里只是把它复刻出来。

查某个节点的审计链就指着它自己的配置根查：

```bash
OCC_CONFIG_DIR=$PWD/.demo-env/nodes/node-b/config bun dist/cli-node.js audit --verify
```

### 3.2 一键重置为什么敢删东西

`demo/env/reset.sh` 的删除动作要同时满足三条，缺一条就退出：

1. `DEMO_ROOT` 通过 `demo_guard_root`（不是 `/`、家目录、仓库根，不在 `~/.occ` / `~/.qianmo` / `~/.claude` 里，也不在调用方环境里 `OCC_CONFIG_DIR` / `CLAUDE_CONFIG_DIR` 指向的真实配置根里）；
2. `DEMO_ROOT` 下有标记文件 `.qianmo-demo-env`，**且首行是我们写的那一行**；
3. 每一个待删路径都在 `DEMO_ROOT` 之内——**逐个复核**，不信任变量拼接的结果。

六个负向用例已实测拒绝（对外变量名是 `QIANMO_DEMO_ROOT`，脚本内部才叫 `DEMO_ROOT`）：`QIANMO_DEMO_ROOT=$HOME`、`=<仓库根>`、`=~/.occ/demo`、`=~/.claude/x`、
`=$OCC_CONFIG_DIR/sub`（外层环境设了 `OCC_CONFIG_DIR` 时）、以及「目录存在但没有标记文件」——每例先在目标目录放一个哨兵文件，事后哨兵原样还在。

默认**保留**演示密钥（换 PSK 等于把还连着的对端全部踢下线，那是另一件事），要换用
`reset.sh --rotate-secrets`。

---

## §4 30 min runbook

### 4.1 前提

- 一台能上网的机器（首次 `bun install` 要下依赖）；
- bun 已装且版本见 §2.1。没装：`curl -fsSL https://bun.sh/install | bash`，装完
  `bun --version` 应为 `1.3.13`；
- git、node 已装。

### 4.2 六条命令

```bash
# ① 取代码
git clone <仓库地址> atlas && cd atlas

# ② 装依赖 + 构建 occ + 自检（每步打耗时，最后给总耗时）
./demo/env/bootstrap.sh

# ③ 铺种子：目录、演示密钥、两个节点工作区、AC-7 数据集
./demo/env/seed.sh

# ④ 起拓扑：注册中心 + 两个常驻节点，最后自动做一次就绪探测
./demo/env/up.sh

# ⑤ 自检：按名解析 + 真拨号 + 审计链 +（可选）发一条真消息等 ack
./demo/env/smoke.sh --with-task

# ⑥ 再跑一个本地 AC 作为端到端佐证（AC-3 最快）
export QIANMO_TRANSPORT_PSK="$(cat .demo-env/secrets/transport-psk)"
./demo/ac3-loop-rate.sh
```

停机 `./demo/env/down.sh`，回到种子态 `./demo/env/reset.sh`。

### 4.3 时间预算（本机实测，macOS / M 系列 / bun 1.3.13）

**这是一次真实跑批的数字**，方法是：从当前工作树 `git clone` 到一个新目录，把尚未提交的
P8.1 产物复制进去，然后**只按上面六条命令敲**（另加一条 AC-7 冒烟作佐证），用 `date +%s`
逐段计时。原始日志留在实施会话的临时目录，表里每一行都能对上其中一段。

| 步骤 | 实测 | 说明 |
| --- | --- | --- |
| ① `git clone` | **1 s** | 本地克隆；从远端拉取要另算网络时间 |
| ② `bootstrap.sh` | **10 s** | 前置检查 0 s + `bun install`（1717 包 / 8.35 s）9 s + `bun run build` 1 s + 自检（`bun test demo/lib`，85 pass）0 s |
| ③ `seed.sh` | **0 s** | 目录、密钥、两个 git 工作区、AC-7 数据集 |
| ④ `up.sh` | **5 s** | 含就绪探测重试（节点 A 首次拨号 3.45 s，是它还在启动） |
| ⑤ `smoke.sh --with-task` | **1 s** | 解析 12 ms / 拨号 2 ms / **ack 414 ms**；两条审计链 intact |
| ⑥ `ac3-loop-rate.sh` | **2 s** | 十条 check 全 true，`pass=true` |
| ⑦ `make -C demo p61-smoke` | **63 s** | AC-7 的 1 min 冒烟模式，**不在必需路径上**，作佐证；`pass=true` |
| **合计（①~⑦ + `down.sh`）** | **87 s（1 min 27 s）** | 距 30 min 预算有 20 倍余量 |

> **计时口径四条**（不写清楚，这张表就会被当成承诺）：
> 1. **bun 的全局缓存是热的**（`~/.bun/install/cache` 里已有本仓库的依赖），且是**本地**
>    clone。真正的全新机器要另加：依赖下载（约 938 MB 装出来，按 20 MB/s 估 1~2 min，
>    按 5 MB/s 估 5 min 以上）、从远端 clone、以及 `postinstall` 去 GitHub 下 ripgrep
>    （本次实测 1.8 MB，**它走的是外网，内网机器上这一步会卡住**）。
> 2. 这是**开发机**（macOS / Apple Silicon）的数字。CI runner 或云上 1~2 vCPU 的小机器上
>    `bun install` 与 `bun run build` 会明显更慢。
> 3. 表里没有「人读文档、装 bun、配网络」的时间。DoD 的 30 min 是给**未参与部署的成员**
>    的，那份时间要算在里面——这也是把 runbook 压到六条命令的原因。
> 4. ⑦ 的 63 s 里有 60 s 是 AC-7 冒烟模式**规定的最短时长**（`--minutes 1`），不是机器慢。

### 4.4 跑不动时先看哪

| 症状 | 多半是 | 怎么办 |
| --- | --- | --- |
| `bun install --frozen-lockfile` 失败 | lockfile 与 `package.json` 不一致，或 bun 版本不对 | 先核对 §2.2；**不要**改成不带 `--frozen-lockfile` 蒙混过去——那条参数正是用来抓这类问题的 |
| `up.sh` 报「拓扑未就绪」 | 端口被占，或节点起来就死了 | 看 `.demo-env/logs/*.err`；换端口用 §2.4 的环境变量 |
| `smoke.sh` 的 probe `resolved:false` | 注册中心没起来或租约过期 | 看 `logs/registry.err`；租约 90 s、续租 20 s 一次 |
| `smoke.sh` 的 task `acked:false` | 目标节点没收下 | 看目标节点的 `.err`；PSK 两边必须逐字相同 |
| 审计链报断链 | 多半是两个节点共用了配置根 | 见 §3.1 第 3 条 |

---

## §5 日常操作

```bash
demo/env/up.sh                 # 起拓扑（幂等：已在跑的进程不会被重起）
demo/env/smoke.sh              # 快检：解析 + 拨号 + 审计链
demo/env/smoke.sh --with-task  # 再加一条真消息，等 ack
demo/env/smoke.sh --with-ac3   # 再跑一遍 AC-3 一键复现
demo/env/down.sh               # 停机，数据不动
demo/env/reset.sh              # 停机 + 清状态 + 重铺种子（保留密钥）
demo/env/reset.sh --rotate-secrets   # 连密钥一起换
```

**把演示凭据导进当前 shell**（跑那些自己读环境变量的 demo 时要）：

```bash
export QIANMO_TRANSPORT_PSK="$(cat .demo-env/secrets/transport-psk)"
export QIANMO_BACKUP_WRITE_TOKEN="$(cat .demo-env/secrets/backup-write-token)"
export QIANMO_BACKUP_ARCHIVE_TOKEN="$(cat .demo-env/secrets/backup-archive-token)"

./demo/ac6b-restore.sh      # AC-6(b)(c)：实测 11 条 check 全绿，恢复耗时 19 ms
./demo/p51-diagnosis.sh     # P5.1：不需要任何凭据
```

**摊到两台机器**：脚本里没有任何「同机」假设，只有默认值绑在回环上。把
`QIANMO_DEMO_HOST` 改成对外地址、两台机器各起自己那个节点、注册中心里对端的 endpoint
写成对端的真实地址即可。跨机传输本身已在两台真实机器、跨架构、走公网验证过（roadmap
v2.12），本目录的脚本**没有在双机形态下跑过**。

---

## §6 哪条腿能演哪几条 AC

| 判据 | 本地腿 | 真机腿 | 一键复现 |
| --- | --- | --- | --- |
| **AC-1** 重启后恢复上下文 | ✅（最后一条判据需模型凭据，无则明确跳过） | 同左 | `demo/ac1-restart.sh` |
| **AC-2** 跨节点唤醒 + 回执 | ⚠️ **只能演一半**：按名解析 → 投递 → ack 全都成立（`smoke.sh --with-task` 实测 ack 59 / 414 ms），但**没有休眠态**——本地进程不会冻结，而 AC-2 判据要的正是「对端处于冻结态」 | ✅ 唯一成立处 | 本地 `demo/env/smoke.sh --with-task`；真机 `demo/p41-task-result.sh` |
| **AC-3** 环路切断 + 两层限流 | ✅ | 同左 | `demo/ac3-loop-rate.sh` |
| **AC-4** 记忆跨会话检索 | ⚠️ 需模型凭据；无独立 demo 脚本，判据由 `tests/integration/qianmo-memory-recall.test.ts` 承载 | 同左 | `bun test tests/integration/qianmo-memory-recall.test.ts` |
| **AC-5** 模型中立 | ⚠️ 需两家供应商凭据 | 同左 | 见 roadmap P1.4 的记录 |
| **AC-6(a)** 沙箱越权被拒 | ❌ 本地没有沙箱 | ✅ | `demo/ac6a-sandbox.sh` |
| **AC-6(b)(c)** 删库可恢复 / 备份删不掉 | ✅ | 同左（真机还要验沙箱挂载边界，见 roadmap P4.4 的「边界」） | `demo/ac6b-restore.sh` |
| **AC-7** 数模场景端到端 | ✅ | 同左 | `make -C demo p61-smoke`（1 min 冒烟）/ `make -C demo p61`（正式） |
| **AC-8** 边界用例 + 混沌 | ✅ | 同左 | `bun test tests/boundary` + `demo/chaos-inject.sh` |
| P5.1 原因级诊断 | ✅（macOS 上 OOM 只能给中等置信，见 §2.3） | ✅ | `demo/p51-diagnosis.sh` |
| P7.3 性能基线 | ⚠️ **只作仪器校准**，report-core 会把本地数据挡在正式表外 | ✅ 正式数据唯一来源 | `demo/p73-baseline.sh` |

**结论**：本地腿能撑起 AC-1 / AC-3 / AC-6(b)(c) / AC-7 / AC-8 五条完整判据（其中 AC-3、
AC-6(b)(c)、AC-7、AC-8 连模型凭据都不需要），配上凭据再加 AC-4 / AC-5，外加 AC-2 的前半段；
**AC-2 的休眠态与 AC-6(a) 非真机不可**。

本次干净 clone 实跑中，AC-3（十条 check 全 true）与 AC-7 冒烟（`pass=true`）都在这台开发机
上一次通过，见 §4.3。

---

## §7 已知坑

### 7.1 真机腿未验证（**本任务包最大的缺口**）

`demo/env/remote/` 的两个脚本是从 demo 脚本头注、`required` 数组、`scripts/ops/` 与
roadmap / `selection-m0.md` 的记载**反推**出来的，逐条能指到出处（见
`demo/env/remote/README.md` 的对照表），但**一条都没在真机上跑过**——实施期间验收机
`workbench-host` SSH 不可达（与 roadmap v2.31 记录的现象一致：TCP 通、无 banner），
此前那台机器上的 `~/p41-ops/setup.sh` 也因此取不回来。

**第一次在真机上用，请按「未验证脚本」对待**，并把实测结果回写进那份 README。

### 7.2 从源码直接跑常驻起不来 ACP 子进程

`bun run src/entrypoints/cli.tsx resident` 的 ACP 子进程会连续失败五次然后被 park，整个常驻
进程随之退出——`--acp` 那条快路径由 `feature('ACP')` 把守，而 feature flag 是**编译期**注入的
（`docs/dev/baseline-m0.md` §9.4 记的就是这个）。所以 `up.sh` 用的是 `bun run build` 出来的
`dist/cli-node.js`，不是源码入口。走 `bun run dev` 也行，代价是进程树多两层。

### 7.3 `smoke.sh --with-task` 的结果字段只是观测

`pass` 只看 **ack**。`task.result` 的 `outcome` 取决于跑脚本这台机器上有没有模型凭据：本机
实测是 `completed`，而**本机环境里有凭据**（§2.5 脚注）；无凭据的机器上它应当是 `failed`，
这一半**没有实测过**。无论哪种，它都不影响拓扑判定，所以在报告里是观测字段而不是判据。
要端到端的结果，跑真机腿或带凭据的 AC-7 链路。

### 7.4 `check:unused` 只在主检出作数

在 git worktree 里跑 `bun run check:unused` 会得到约 76 个「未使用文件」的**假阳性**，根因与
处置见 `CLAUDE.md` §3.1。本任务包新增的两个 TS runner 已加进 `knip.json` 的入口图。

### 7.5 `.demo-env/` 永不入库

已加进 `.gitignore`。里面有演示密钥（0600）与节点身份私钥——**任何时候看到它出现在
`git status` 的待提交列表里，都是先修 `.gitignore` 而不是 `git add`。**

---

## §8 后续动作

| # | 动作 | 阻塞在 | 归属 |
| --- | --- | --- | --- |
| 1 | 未参与部署的成员按 §4 实测一遍并计时（DoD 的正式判据） | 无 | P8.1 owner |
| 2 | 真机腿两个脚本在验收机上跑通并回写 `demo/env/remote/README.md` | `workbench-host` 可达 | P8.1 owner |
| 3 | 双机形态（两台机器各一个节点）实跑一次 | 第二台机器 | P8.2 |
| 4 | 把 P7.2 后四层 sink（协商 / 隧道 / 备份 / 扩容）接进 `up.sh` 的启动路径 | 无 | P8.2（roadmap 已把这件事记在 P7.2 的「留给 P8.2」里） |
