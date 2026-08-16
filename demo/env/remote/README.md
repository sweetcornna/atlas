<!-- Copyright 2026 Qianmo AgentNest Team -->
<!-- SPDX-License-Identifier: MIT -->

# demo/env/remote —— 真机腿（Dormice + gVisor）

> ⚠️ **本目录的两个脚本未在真机验证。**
>
> 实施 P8.1 期间验收机 `workbench-host` SSH 不可达（此前 v2.31 已记录同一现象：TCP 通、
> 无 banner），此前那台机器上的部署脚本 `~/p41-ops/setup.sh` 也因此取不回来。这里的
> `prepare-host.sh` / `prepare-sandbox.sh` 是**从仓库里已有的东西反推**出来的：demo 脚本
> 头注写明的前提、`required` 环境变量数组、`scripts/ops/` 的加固脚本，以及 roadmap /
> `selection-m0.md` 里关于这台机器的记载。逐条都能指到出处（见下表），但**没有一条在真
> 机上跑过**。
>
> 第一次在真机上用它们，请当作「未验证脚本」：先只跑检查（`prepare-host.sh` 不带
> `--apply`），逐条核对输出，再决定是否落实加固。**跑通之后请把实测结果回写到本文件**，
> 并在 roadmap 的 P8.1 条目里注明是谁、在哪台机器、什么时候验证的。

## 两个脚本

| 脚本 | 在哪跑 | 干什么 |
| --- | --- | --- |
| `prepare-host.sh` | 宿主（Debian 12 那台），普通用户；`--apply` 要 sudo | 七项就位检查：平台 / docker+runsc / cgroup v2 / Dormice 与 `dor doctor` / 镜像 / daemon 绑定不变式 / 网络加固，最后列出真机腿要用的环境变量名 |
| `prepare-sandbox.sh` | **目标沙箱内部** | 装依赖、构建 `occ`、以隔离配置根起一个常驻节点，并打印回填给宿主的三个变量 |

**为什么沙箱那半边必须手动进去做**：activator 的能力面只有 `acquireSandbox` / `listSandboxes`，
**没有 exec**——这正是 AC-6(c) 依赖的边界。宿主没有、也不该有把沙箱内进程拉起来的能力。

## 每一条检查的出处

| 检查 | 出处 |
| --- | --- |
| docker 里有 `runsc` 运行时 | `packages/sandbox/`、AC-6(a) 的 gVisor 出生契约；`selection-m0.md` §1（runsc `release-20260622.0`，systrap 平台） |
| cgroup v2 可读 | `docs/dev/roadmap.md` P5.1 的边界：`oomKillDelta` 需要 cgroup v2 |
| `dor doctor` 全绿 | roadmap P0.1 DoD 的服务器侧判据 |
| `dormice.service` 应 `enabled` | roadmap P0.1 遗留③（现状 active 但 disabled，重启不自起） |
| `dormice-base:20260718` 是重建件 | roadmap P0.1 遗留①、`selection-m0.md` §1（apt 层浮动，不保证与原件逐字节一致） |
| `workbench:0.7.10` 缺失 | roadmap P0.1 遗留②（任何 `template: workbench` 的 acquire 都会失败） |
| daemon 只绑回环 | `scripts/ops/check-daemon-bind.sh` + `scripts/ops/README.md`（AC-6(c) 的单点依赖） |
| INPUT + DOCKER-USER 两条链都要加 | `scripts/ops/README.md` 的「一条反直觉的结论」——容器访问宿主端口走 INPUT，不走 DOCKER-USER |
| 环境变量清单 | `demo/ac2-wake-forward.sh` / `demo/p31-resident-wake.sh` / `demo/p41-task-result.sh` / `demo/ac6a-sandbox.sh` 各自的 `required` 数组 |

## 跑通之后能演示什么

见 `docs/dev/demo-env.md` §6 的两栏表。简述：真机腿是 **AC-2**（跨节点唤醒 + ack/result）
与 **AC-6(a)**（沙箱越权被拒）唯一成立的地方，也是 **P7.3** 正式基线数据的唯一来源；本地腿
（`demo/env/up.sh`）覆盖其余各条。

## 已知会绊人的地方

1. **沙箱里的 bun 多半要自己装**，且架构可能与开发机不同（甲骨文那台是 aarch64）。
   `prepare-sandbox.sh` 只警告不拦截，但**架构差异必须写进验收报告**（P7.3 的口径）。
2. **PSK 必须两边逐字相同**，宿主与沙箱各自从环境变量注入，不要落盘传递。
3. **每一轮真机跑批都要先确认沙箱 `state=frozen`** 再投递——这是 AC-2 判据的一部分，
   demo 脚本自己会做，别手动跳过。
4. **`touch` 方法不存在**：Dormice 的真实 API 是「方法名即路径段」的 RPC，保活用
   `acquireSandbox`，状态取值是 `active` 不是 `running`（roadmap v2.8 真机核实结论）。
