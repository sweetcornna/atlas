<!-- Copyright 2026 Qianmo AgentNest Team -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# omp 现场验收执行包

此包准备已有机器上的隔离候选环境。部署前仍需对具体产物哈希、主机角色、资源上限和启停命令审核；准备脚本不会执行 SSH 或部署。真实机器名、SSH 别名、主机指纹和端口盘点放在仓库外的私有证据目录，不复制生产密钥。

`atlas/scripts/field-acceptance/field-plan.py` 使用 Python 3.9 以上。计划绑定源码文件清单 SHA-256、每个实际 Linux 产物 SHA-256、三台独立认证的 SSH 目标身份、启动时 boot ID、非 root UID、候选目录、回环端口和 CPU/内存上限。旧镜像可能共用 `/etc/machine-id`；该字段只存盘点值，独立角色另用真实连接最终目标公钥与主机名的规范摘要。经过跳板机时必须取最后一个目标的主机公钥，不能把跳板的公钥当作三台目标身份。

```sh
python3 -B atlas/scripts/field-acceptance/field-plan.py review private-plan.json private-review-packet
```

输出 `plan.json`、`plan.sha256`、`status.json` 和 `stage-after-review.sh`。固定六件 native 产物的计划可另绑定 `nativePreflight` 契约，生成 `native-after-review.sh` 与 `stop-candidate-units.sh`。native 每次先以内联可信命令重新核对精确身份、boot ID、目录/端口和全部六件工件 SHA（包含将执行的 shell、Bun、checker），才执行候选 shell；stage 成功不代表未来状态仍受信。stop 先核固定 known_hosts SHA，逐机尝试并汇总失败；已回收的 unit 明确跳过，首机失败不会漏停后续 worker。审核后的 stage 只创建全新的 `$HOME/qianmo-candidate/<candidateId>`，复制产物并核对校验和；不覆盖旧根，不启动进程，不写 systemd 单元或 `authorized_keys`。stage 使用单独、哈希固定的 known_hosts，仅信任各目标已审核的公钥；跳板身份仍依照现有 SSH 配置。若目标 SSH 公钥、UID、主机名、machine-id、boot ID 或空闲端口与盘点不符，立即拒绝。再次投递同目录也拒绝。计划哈希参数只是防止错用计划，不能替代人的部署批准。

启动候选时使用独立 `HOME`、`QIANMO_CONFIG_DIR`、密钥、审计链和工作区。中枢没有用户 resident；worker 与 witness 分处另外两台主机。单元名以候选 ID 开头，使用 `systemd-run --user` 的 `MemoryMax`、`CPUQuota`、`OOMScoreAdjust=900` 和 `RuntimeMaxSec`，回环端口限定 39720–39799，经现有 SSH 隧道连通。旧服务、386xx 端口、旧状态、旧 timer 均保留。回滚只停止精确候选单元与精确候选 SSH 隧道，保留候选目录和审计证据，不运行旧环境的 `beta-down` 或 reset。

## 真签名探针

`qm resident-wake --sign --trust worker=<固定公钥>` 同时要求双向签名握手和目标绑定 capability；目标缺公钥或只支持 PSK 时拒绝，不能降级。先用隔离配置根打印探针自身公钥，并按审核的信任配置交给目标节点：

```sh
QIANMO_CONFIG_DIR=/absolute/candidate/probe-config qm resident-wake --print-identity --from qianmo://fleet-probe/operator
```

`fleet-probe.sh handshake` 以独立 `fleet-probe` 身份使用 `p81-probe --sign --trust`；固定目标公钥从已审核 `peers.conf` 坐标行或本机节点身份文件解析，缺失时记录失败，不从网络注册表自动学公钥。仅握手，不发模型任务。`p81-probe --task` 另签 capability 并检查实际连接身份及答复关联；它只证明 ack，不能作为完成结果的验收。

`fleet-probe.sh install` 默认账号模式，要求 `--credential-file /absolute/private-file`。该文件是专用个人账号的长期 credential（不是会话 cookie sid），0600；账号须有 ops 角色且租户映射允许目标。跨租户探针须显式列入 platformSubjects，或按租户分别配置，不能借 break-glass/admin 绕过。探针仍走真实控制台 `/v0/wake`，响应 401/403 时记录失败，不回退 admin token、不自动续期。M1 历史环境须显式传 `--auth-mode legacy-m1` 才会使用旧 admin token；M2 不使用此模式。安装只 enable timer，不 start。开始采样是审核后的独立动作，采样可产生真实模型成本。

## Linux RSS 与 bwrap

```sh
python3 -B atlas/scripts/field-acceptance/measure-linux.py --pid <candidate-resident-pid> --duration 600 --interval 1 --out <new-evidence-directory>
```

采样器只读 `/proc`，绑定 PID 起始 ticks，逐进程记录 RSS/HWM/PSS 和 CPU ticks。PSS 可供进程树汇总参考，但逐 PID 顺序采样不是原子快照，不能与 cgroup charge 等同；RSS/HWM 不相加。cgroup 读数明确注明可能包含其他进程；未赋予独立 cgroup 的数字不能当作单个代理的内存。它不把“十分钟采样完成”自动判为 AC-1/AC-2 达标。

本地 Linux 已执行生产 `taskValidation`/`taskOracle` 测试（普通 UID 5/0，含early-exit/伪造摘要等负控）。外层容器允许用户命名空间不代表普通容器或远端节点也允许。Ubuntu 24.04 的 AppArmor userns 限制、容器 seccomp/权限和目标 host 的 bwrap 都必须现场核实；无可用隔离时拒绝执行生成代码。不能把应用工具 allowlist 或 Docker pause 当作 OS 隔离与沙箱零资源冻结的证明。

## AC-2、P17 与七天窗口

AC-2 完整协议 runner 为 `demo/p41-task-result.sh`，使用真实 Dormice 冻结沙箱和独立接收端，连续十轮保留冻结状态、唤醒时间、带 taskId 的 ack（每轮≤60秒，另报P95）与真实非空完成结果（每轮≤5分钟）。每轮先等真实 daemon 报 frozen，未达到即失败且不投递。它默认 `QIANMO_P41_SIGN=1`：调用方→activator 和 activator→目标均强制双向签名握手，固定目标公钥，缺失或错 key 不降级；任务另附目标绑定 capability。目标 resident 必须信任 activator 的握手公钥和 sender 的 capability 公钥；M2 映射另将实际 activator 标为受信 hub，并明确 sender/任务归属。

在独立 `QIANMO_CONFIG_DIR` 下用 `demo/lib/ac2-activator.ts --print-identity` 和 `demo/lib/p41-send.ts --print-identity` 准备公钥；真实目标从自己的 identity 输出取得。设置 `QIANMO_P41_{SENDER,HOST,TARGET}_PUBLIC_KEY`，脚本会核对前两者与隔离根内身份一致。daemon URL/token、传输 PSK、目标 sandbox/name/url、activity端口和冻结/停止策略均按脚本 required 列表显式注入；不复制现网 secret。所有 demo helpers 随 `atlas:build:qm` 生成 `dist/demo/*.mjs`，没有源码依赖的投递树由 `demo/lib/entry.sh` 选择 bundle。

发送器只接同一连接的精确 taskId/traceId/contextId/反向地址 ack/result。报告拒绝重复轮次/任务/消息、伪造或负数时间、缺少 receipt、仅交付/仅 ack；`--ac2` 固定10轮/60秒/300秒和强制签名，无法放宽参数取得通过。协议报告的 `pass` 只代表这一层，`ac2Passed:false` 始终保留，真实冻结资源读数与独立审阅仍要归档。显式 `QIANMO_P41_SIGN=0` 仅保留 M1 对照 fixture，不能取得严格 AC-2 协议通过。

本地真实独立 sender/activator/target 与 supervisor fixture 的正负控已经验证签名及报告接线；该 fixture 不复现物理冻结。`demo/ac2-wake-forward.sh` 只证明转发交付，不能单独满足该口径。现有主机若未配置 Dormice/gVisor，执行包明确保留外部验收缺口，不自动安装或改生产内核。

P17 每个真实入口（qmcode、Claude Code）各两轮。每轮保留真实入口记录、accepted receipt、发送前后 refs、云端转录、制品测试、原机离线至少30分钟的第三机观测、attach转录、pull receipt、本地拉取前后状态。`handoff-check` 只做这些材料的完整性与文件 SHA 检查；文件齐全仍返回 `p17Passed:false`，必须独立检查历史约束、远端继续执行、refs 一致和本地未提交内容保留。三进程回环演示不冒充三台机器。

```sh
python3 -B atlas/scripts/field-acceptance/field-plan.py handoff-check <rounds-manifest.json>
python3 -B atlas/scripts/field-acceptance/field-plan.py window-start <plan.json> --approved-plan-sha <sha256> <new-window.json>
python3 -B atlas/scripts/field-acceptance/field-plan.py window-status <window.json>
```

只有候选部署与探针实际开始后才能 `window-start`。窗口从命令执行时钟起算完整七天，不能缩短为实验时间；到期状态仅为 `acquisition-window-elapsed`，`sevenDayPassed` 始终为 false，之后还要冻结完整的探针、timing、审计链和部署指纹，按 [M2 统计口径](beta-measurement-m2.md) 运行真实 beta-report，并独立审阅失败样本、缺样和权限复判。七天没有经过时只能写“尚未完成”。

## 构建后强制原生 resident 自检

`atlas:check:qm-smoke` 现含第五项：在无源码和 node_modules 的临时工作区启动实际 compiled resident，经强制双签连接提交有 capability 的任务，本地 fake provider 指令驱动原生OMP工具。必须同时收到真实ack/完成result、普通write落盘、保护根read/write拒绝，且新HOME保持空（OMP native与state必须留在qianmo config根）。旧版漏打包extension和父qm启动过早写HOME的缺陷都能被这项真实负控抓住。

启动凭据探针与实际 OMP RPC 代际串行：探针进程确认 `close` 后才开 RPC；切换配置时先等旧代际的全部 OMP RPC 子进程回收，再按当前有效配置和凭据验证。协议解析失败、审计落盘或回执错误都不能代替真实进程退出。退出未知时保持不可用。成功结果只在本进程内、同一配置摘要下复用；配置变化、进程重启和未确认退出不能借旧结果放行。模型的已知 401 等仍保留原来的诊断语义，探针退出确认与凭据是否被接受分开处理。

自检在新建私有目录中读取真实 `runtime_ready` timing，匹配当前 `generation.json` 的第一代和启动时间，最长等待30秒并记录 `startupWaitMs`；连接后再次核对代数。然后才创建带原有 TTL 的同一个签名任务并要求完整 ACK/result。socket 存在不代表模型已就绪。受限冷启动中，过早请求仍可能收到现有3秒等待窗后的 `E_UNDELIVERABLE`；该失败须单独保留，不能改称一开始就执行成功。

本地 Linux ARM64 已在独立768 MiB、0.5 CPU、无外部网络的 cgroup 中完成重复冷启动、延迟探针和已知401探针路径；计入同组的自检与采样进程。各轮无 OOM kill，但触及内存上限并发生回收，不能宣称有充足余量。逐进程 PSS 是非原子采样，共享页的 PSS 归属与 cgroup charge 不同，不能把 `MemoryMax` 当作进程树物理内存上限。最终工件、逐轮原始数据和实际计数以仓库外 `Gates/RESULTS.md` 为准；这不推导已有 x64 小机容量，也不替代原生 x64、物理冻结、AC-1/AC-2 或七天验收。

独立执行 `bun atlas/scripts/check-resident-compiled.ts <binary> [<absolute-rss-output-dir>]`；只有Linux可传第二参数，在真实工具回合完成后继续采样600秒。此采样不运行付费模型，也不代表物理冻结或七天连续观察。部署审核包使用同一checker的self-contained Bun bundle及固定Bun1.4.2运行时；`native-after-review.sh`限定fresh候选根、非root UID、binary hash、transient user unit的CPU/内存/最长300秒，不创建永久服务。

旧Dormice实验机的历史记录指向GCP workbench（旧SSH直连失效后改走IAP）；本轮既有IAP配置的只读连接报 `Failed to lookup instance`，对应project实例查询另被billing未启用拦截。此事实只能表示当前通路无法核验其可用性，不能推断实例已删除或自动启费重建。三台新候选普通UID节点只读盘点未发现bwrap/runsc或3676监听；没有向它们安装任何组件。
