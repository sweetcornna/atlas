<!-- Copyright 2026 Qianmo AgentNest Team -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# 阡陌 v2.47.2 GitHub Release

v2.47.2 是补丁版，在 v2.47.1 之上修三处。它们都出在中枢对节点新建 ssh 连接太密、撞上节点防火墙限速，以及由此暴露出的一处验收判据缺陷。发行形式与 v2.47.1 相同：`sweetcornna/atlas`，源码归档加 `SHA256SUMS`。基座 pin 仍为 v2.46.0，不含上游同步。

## 为什么要发这一版

v2.47.1 部署到内测舰队后，P18.13 B 段第一轮真机验收（AC-P6）有两类红。

**控制台对一台节点的三次下发，一秒内都报 `ssh 失败 · 连不上节点`。**两台远端节点机都开着 ufw 的 `limit 22/tcp`。这条规则对同一来源 30 s 内的第 4 条新 ssh 连接直接 REJECT，被拒的那次也计数。中枢执行器每个操作都新建一条 ssh 连接，而状态刷新最密每 5 s 一次（apply 之后的跟踪、页面或验收脚本的刷新），30 s 能拨到 6 条，窗口一直是满的，后面的下发就在 TCP 那一步被拒。从节点上 `/proc/net/xt_recent/DEFAULT` 能看到中枢地址的命中记录：每条连接记两次，正好对上 `--hitcount 6`。

**部署指纹在轮内变了，但产物其实没换。**验收拿 `dist/cli-node.js` 的 ctime 当「换过产物」的痕迹。CLI 起来时会把这个文件硬链进运行时目录，链接数一变 ctime 就跟着变。那一刻正好是一次真实调用探测起 CLI 的时刻，sha256 没变。

## 变化

- **中枢执行器的拨号节奏**（`src/cli/handlers/consoleProvidersExec.ts`，设计 `providers-console-m1.md` 升 v1.4 §2.5）：
  - 对同一个 `主机:端口`，任意 30 s 里最多起 3 条 ssh 连接。
  - 下发、探测这类有人在等的操作，等到有名额再拨，最多等一个窗口。
  - 状态刷新没名额就不拨，页面沿用上一次的状态，不记成刷新失败。
  - 在握手之前被拒的（`ssh: connect to host …`、`kex_exchange_identification`、`banner exchange`），请求一个字节都没送到节点，等过一个窗口重拨一次，只重拨这一次。握手之后断的不重拨。
  - 没有改成连接复用：复用的主连接不重新认证，节点撤掉专用 key 之后，只要中枢还在刷新，这条连接就一直有效。
- **验收的部署指纹**（`demo/env/beta/ops/provider-acceptance{,-node}.ts`）：
  - 由 `sourceCommit` 加每台机器 `dist/cli-node.js` 的 sha256、inode、mtime 组成，不再用 ctime。
  - 解包、rsync、cp 换产物时，变的是 inode 或 mtime。
  - 用例钉住三种情况：硬链再撤掉，指纹不变；内容变了，指纹变；同样的字节先删后建，指纹也变。
- **enroll 第 ⑤ 步**（`demo/env/beta/ops/model-apply-enroll.sh`）：
  - 从中枢 `ssh-keyscan` 节点，一把主机钥都没扫到时，等 31 s 再扫一次，只再扫这一次。
  - ssh-keyscan 每种类型各拨一条连接，刚拨过几次之后就会撞上同一条限速。
- `beta-env.md` 升 v1.8（§13 第 5 步与验收的 D0 / D1 一行）。

## 升级注意

- 中枢（控制台）要换到这一版，拨号节奏才生效。节点上的 `model-apply.sh` / `serve-stdin` 没有改。
- 连续操作同一台远端节点时，第 4 次起可能要等几秒到 30 s。这是有意的：比被节点防火墙拒掉、再报「连不上节点」好。
- 用 `provider-acceptance.sh compare` 比对 v2.47.2 之前与之后的两轮时，两轮的指纹格式不同，会判成不是同一份部署。换版本本来也要重跑两轮。

## 出处

改动明细见本版的修复 PR。
