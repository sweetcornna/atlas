<!-- Copyright 2026 Qianmo AgentNest Team -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# M1 / M2 部署审核清单

本轮开发在 `feat/base-oh-my-pi` 工作树完成，基座为 oh-my-pi 18.8.4。当前代码没有推送、合并或发布。负责人已授权现有服务器隔离实验，现场进度见下文。开发及本地验证状态见 [完成清单](./m1-m2-completion.md)；旧基座长期运行成绩保留为历史证据，不计入本候选现场验收。

## 2026-10-08 授权后的现场实验

用户明确授权“部署到服务器上实验”。v8b 三机工件校验通过，工作节点的版本入口通过，但 resident 与 OMP 原生加载错误选择 linux-arm64，五项 smoke 未通过；已停止全部候选瞬时单元，原 386xx 监听集合保持。失败证据保留在 [v8b 现场结果](/Users/cornna/atlas-evidence/m1-work/m1-completion/Gates/field-execution-20261009T003622Z/RESULT.md)。

修复上游 compile helper 中 `target` 与 `executablePath` 被互斥传入的问题，明确模板不取代目标平台；新增回归先红后绿。新 x64 候选 v9 SHA 为 `5e21f71061ea9990d12791db4d889af5e4f12d838fa8b119816580f657e99c44`，源码清单 `df8afb60aa540b40a3bd67583fb04787637234a269e18117d1fc30a24e4ccae2`，节点运行时代码未变化。脚本回归 198/0，类型及编译相关测试通过；完整 omp 套件与现场运行的独立记录另存，不能仅由回归推断原生成功。

v9 按 [worker-first 审核包](/Users/cornna/atlas-evidence/m1-work/m1-completion/Gates/field-execution-v9-20261009/REVIEW.md) 执行，计划 SHA `f091536c45760396dfadc7874805d0c88742c84f22ce704da5c6d20e294eb4a2`。实际前四项通过，第五项未在原定 30 秒内就绪；内存达到 768 MiB、swap 峰值约 1.1 GiB，随后全部候选单元停止。完整失败与 SSH 中断分别记录在 [v9 结果](/Users/cornna/atlas-evidence/m1-work/m1-completion/Gates/field-execution-v9-20261009/RESULT.md)，没有调大门槛把失败改为通过。

v10 进一步将 Atlas x64 产物限定为兼容范围更广的 baseline 原生插件，避免冷启动解压两份约 191 MB 插件；OMP 默认打包行为不变。代价是该候选不再使用 modern 专用 CPU 优化插件，不能声称性能不变。新产物 257,414,624 字节，SHA `381b20e9797ebac96d48337c0265074303cb710bbcc0796733ec46602b8ec881`，冻结源码清单 SHA `928ba7409a473caa25c9f74faf9ff5549ba114cc740d05f74bbb6d1917599983`；节点运行时代码未变化。新增打包正负控和脚本集合 201/0，类型与原生加载测试通过。

v10 已在 worker 完成实际隔离运行，前四项通过，首次 generation 在原 30 秒门槛内就绪，但第五项的任务回合复合断言失败。取证确认真实读保护、写保护、普通写入和 completed 结果，随后 diag02 确认 ACK、completed 内容和工具保护通过，唯一失败条件为探针未到达本地 HTTP fixture，不能据此改判 5/5。该次内存峰值 768 MiB、swap 峰值约 136.1 MiB；完整 250 条远端持久采样已取回。三机停止与进程消失取证成功，hub/witness 未运行新候选，bwrap、M2 pool 与 P17 后续现场项未执行。见 [v10 结果](/Users/cornna/atlas-evidence/m1-work/m1-completion/Gates/field-execution-v10-20261009/RESULT.md)。v9/v10 都未设置 MemorySwapMax，不属于无 swap 验证。以下 v8 表保留为历史构建基线。

独立 diag02 保持 v10 二进制与原时间/资源上限，只运行增强诊断 checker：就绪 26.364 秒，探针进程约 9.796 秒后消失，随后 RPC 完成真实回合；`probeResponses=[]` 为直接证据，重复冷解包则是源码与时序支持的机制推断。该轮内存峰值 768 MiB、swap 42.8 MiB，160 条持久采样完整，精确停止后无候选进程。首次 diag01 因 SSH 跳板断开而未启动运行时，基础设施失败另留档。见 [diag02 结果](/Users/cornna/atlas-evidence/m1-work/m1-completion/Gates/field-execution-v10-diagnostic02-20261009/RESULT.md)。当前修复将探针临时配置与凭据继续隔离，仅尝试复用同节点、同用户的可信原生缓存；新的编译产物尚待完整五项现场复跑。

v11 加入可信原生缓存复用，独立探针凭据/配置、10 秒预算及真实退出屏障不变。源码入口回归通过真实 OMP 调用本地 fixture；修复前 9 pass / 7 fail，相关集合修复后 35/0。新 ELF 为 257,426,912 字节，SHA `797add364592f591fdb1c5b65161548d213634917b6787c6820ce2485f6648fe`，冻结源码清单 SHA `a15107529260581417f3cb57b54141a66462130c04c6f2b191561265eacb8217`。首次完整节点 1202 pass / 1 skip / 1 fail（旧拨号测试墙钟上界）；完整该文件复核 19/0，保持断言的完整节点复跑 1203 pass / 1 skip / 0 fail，6394 断言，97 个节点生产文件起止 SHA 不变。脚本 201 pass / 3 条需编译产物的条件跳过 / 0 fail，类型、只读 lint、路径和许可检查通过。原失败保留于 [缓存修复与集成证据](/Users/cornna/atlas-evidence/m1-work/m1-completion/Gates/probe-native-cache-fix/SUMMARY.md)。[v11 现场包](/Users/cornna/atlas-evidence/m1-work/m1-completion/Gates/field-execution-v11-20261009/REVIEW.md) 已执行原五项 native 检查，结果仍为 4/5；详见下段。

v11 现场保持原限制，ready 26.306 秒；ACK、completed 内容、真实三工具与保护规则均通过，仍仅探针 HTTP 条件失败。运行 55.486 秒、CPU 25.012 秒、memory 768 MiB、swap 167 MiB，256 条采样完整，OOM/kill 为 0。精确停止成功，旧 38625/38640 监听集合保持；未进入 hub/witness、bwrap/pool/P17。只读元数据确认 config/omp 为 0700，但加载器正常生成的 natives/版本目录为 0775，被 helper 严格谓词拒绝；实际 ELF 保留的同步初始化链也确认宿主在 probe 前已加载插件，无需额外预热。下一修订仅在严格私有祖先内收紧这些正常目录的组写权限，仍拒绝不安全缓存，不放宽时间或资源门槛。见 [v11 结果及权限诊断](/Users/cornna/atlas-evidence/m1-work/m1-completion/Gates/field-execution-v11-20261009/RESULT.md)。

v12 将严格私有祖先内正常 0775 原生目录按描述符核对后收紧为 0755，其余不安全布局仍拒绝。相关回归 52/0、436 断言，完整节点 1220 pass / 1 Linux 平台 skip / 0 fail、6536 断言，97 个节点生产文件测试前后不变；类型、只读 lint、路径和许可门禁通过。脚本与 OMP 源在 v11/v12 快照间逐文件相同，沿用各自已留档验证。新 ELF SHA `9cfdd70fd94407c0c7e10c9f027d473e361cf0f2112bff58bcb51b1d78cda77f`，源码清单 SHA `104ed9219474ae8858e7d016dd6f835d692fc5df16140e3d9530933ff6087e87`。

v12 实际三机包成功：worker 完整 5/5，所有五谓词 true、探针 HTTP 200、ready 23.584 秒、三工具正负控通过；hub/witness 版本入口通过。worker 运行 46.375 秒、CPU 22.929 秒、memory 768 MiB、观测 swap 0B、OOM/kill 0，217 个采样完整；swap 上限没有修改，不能称禁用 swap 或已有内存余量。三机 stop/collection 全 0，MainPID 0、旧 386xx 监听保持。一次只读元数据确认 native/版本目录均 0755、UID 1000，无残留 probe 根。见 [v12 RESULT](/Users/cornna/atlas-evidence/m1-work/m1-completion/Gates/field-execution-v12-20261009/RESULT.md)。

bwrap 前两轮都在任何 stage/提取/实际 probe 之前因不可读进程元数据失败，pool/P17 未执行。第二轮已能依据权威 systemd unit 和完整身份排除既有 user manager，但又发现 PAM 子进程与 SSH 会话的 executable 链接拒绝读取。随后独立只读盘点通过 UID、完整父链、startTicks、systemd 和 loginctl 交叉核验这些当前进程，正在修复精确分类；其他未知进程仍必须使盘点失败。已消失 PID 不追认身份，两轮原始错误与停止盘点不完整结论均保留。见 [第二轮结果](/Users/cornna/atlas-evidence/m1-work/m1-completion/Gates/field-execution-v12-20261009/p17-bwrap/execution-second/RESULT.md)。

bwrap 第三轮仍在 stage 前拒绝既有 SSH 连接的仅用户名标题；安全补读确认完整身份与该明确格式，第四轮修复后进入实际命名空间/工作区检查并完整停止。第四轮自动记录为 allPassed，但独立复核发现 `2>/dev/null` 先失败，保护目标写入没有实际尝试，故 **accepted=false**；原自动结果不改写，也不得作为 pool/P17 的前置通过证据。运行 190 ms、CPU 102 ms、memory 3.6 MiB、观测 swap 0B；stop 0、MainPID 0、完整盘点无候选进程，旧 38625/38640 保持。pool、A/B/C 均未执行，先前依据自动结果的后续放行已撤回。见 [第四轮与独立拒绝结论](/Users/cornna/atlas-evidence/m1-work/m1-completion/Gates/field-execution-v12-20261009/p17-bwrap/execution-fourth/RESULT.md)。

bwrap 第五轮因错误假定 `/dev` 只能有一条挂载记录而失败；后续只读诊断确认底层宿主 devtmpfs 与上层私有 tmpfs 并存。第六轮根据可见目录的设备号选中唯一私有层，并获独立 accepted=true：保护 guard 的真实 `os.open` 返回 EROFS(30)，inode/前后 SHA 保持；工作区实际写入 19 字节，null/zero/urandom I/O、不同 mount/net namespace 与外层复核通过。运行 426 ms、CPU 225 ms、memory 7.2M、观测 swap 0B（未禁用）；stop 0、完整盘点无候选或未知进程、旧监听不变。新包 SHA `861fd9033bcc0a7635489ee04873203297550636f555dff438ee01142ce45014`，独立审阅绑定原始结果 SHA，不能由早期自动通过代替。见 [第六轮结果](/Users/cornna/atlas-evidence/m1-work/m1-completion/Gates/field-execution-v12-20261009/p17-bwrap/execution-sixth/RESULT.md)。

M2 pool 首次现场试验及独立验收通过，包 SHA `f57ead8c7cfef68df1df388aace0906ce292c74804a84eaf6ebe4731f0913bd1`：2/2 检查、28 条实际命令，并发仅一个 worker，重复申请同 PID，正常释放确认进程消失；SIGSTOP 负控使释放返回 unknown，120000 预留继续保留，竞争/重复申请被拒，清理后 ledger 仍 unknown。两条审计链 7/6 记录完整，五份公共证据和受限私有归档齐全。运行 29.457 秒、CPU 13.772 秒、memory 峰 211.8M、OOM 0，完整停止、无未知/候选进程且旧监听保持。这是现有池模拟，不申领真实云实例，不证明逐 worker 的 CPU/RAM 硬隔离。见 [pool 独立结果](/Users/cornna/atlas-evidence/m1-work/m1-completion/Gates/field-execution-v12-20261009/m2-pool/execution-first/RESULT.md)。

P17 A 和 B 已在 worker 上实测，都获独立 accepted=true（各 23/23，审阅从原始文件重算）。A 是同机私有 sshd 加真实 handoff git gate，第四轮通过：9 条负控全部拒绝，提交 `a2a0dba3…`，memory 峰 96.2M、swap 0、OOM 0。B 是真实 qmcode app-server、外部 code-mode helper 和嵌套 exec_command，第三轮通过：两次 provider 请求的工具都放在 developer `additional_tools` 里；真实 code-mode `exec` 经 helper 跑出嵌套 exec_command；越界写返回 errno 30，guard 不变；正向写入 26 字节；memory 峰 379.9M、swap 0。此前的失败轮次都保留为拒绝。A 三轮：一轮缺终止标记，两轮跳板 SSH 返回 255。B 两轮：一轮是 fixture 只读 `body.tools`；一轮是外层命名空间只读挂载宿主 /proc，嵌套 uid map 失败。据此加了四个修订层：传输重试；每台主机只开一条主连接复用（根因是跳板 sshd MaxStartups 10:30:100 加上持续的扫描流量）；工具从两个载体解析；外层私有 pid/proc。C 跨机双轮接力未执行：origin p1 的 MemAvailable 为 589,068 KiB，低于启动器门槛 917,504 KiB（768+128 MiB）。按拓扑规则在启动新服务前停止，不降检查，也不调上限。之后复查发现 p7 不可行：钉住的 bwrap 需要 GLIBC_2.38，helper 需要 GLIBC_2.39，而 p7 是 Debian 12（glibc 2.36），已实测报错。p1 上的 cornna 没有免密 sudo，停掉 beta-1 也只能腾出约 204 MB。p1–p3 之间换角色，会卡在 p2 内存不足。剩下两条路：一是有人用 root 在 p1 停 hermes 约 15 分钟，再加上停 beta-1；二是换一台 glibc ≥2.39、空闲内存 ≥896 MiB 的 x86_64 主机。负责人 10-10 决定暂不使用 p1，随后又说明 socks 机队除 p1 外都可用。C 因此重新定位：origin 放 p2，上限 640 MiB；hub 放 p7，用新建的普通用户 cornna（uid 1003），钉住的四件 v12 产物已上传并核对 SHA；worker 仍是 p3。C 共跑了四轮。第一轮业务全过，但私有 sshd 启动后会 chdir("/")，身份记录早于这一步，停止时拒绝发信号，判不通过；修法是让 sshd 直接从 / 启动，已在 p3/p7 实地做过红绿对照。第二轮只差 hub 资源门禁：p7 是 6.1 内核，没有 memory.swap.peak；修法是只在 swap.max=0 且每个样本 swap.current 都为 0 时，认定 swap 峰值为 0。另外，p2 上用户的 docker 容器进程以同一 uid 运行，会让进程扫描无法完整；为此新增了「宿主容器进程」分类，要求 systemd 确认该容器 scope 正在运行。第三、四轮用同一份功能包连续通过独立验收（各 39/39）：初始回合、init、第一轮快进、第二轮回到返回分支；停止、扫描、端口、隧道全部干净。内存峰值 origin 444/338 MiB、hub 113/118 MiB、worker 325/311 MiB，swap 和 OOM 均为 0。这次运行仍有三点没覆盖：Mac 一直保持隧道，所以不算物理离线；Responses 用的是固定夹具，不说明模型理解能力；也不覆盖 30 分钟离线窗口。见 [P17 状态](/Users/cornna/atlas-evidence/m1-work/m1-completion/Gates/field-execution-v12-20261009/P17-STATUS.md)。

负责人确认原 Dormice GCP 主机 `burn-vm-01` 已失效，停止连接尝试；新的部署目标尚待指定。官方 main `899bf7f1ef6928a2d4175b0bfa546d943c597def` 已下载并静态审阅，尚未安装。新版涉及 gateway/数据库迁移和与阡陌出生契约冲突的容器默认配置，不能将源码准备当作升级或真实兼容性通过。候选与待核实条件见 [Dormice 审阅记录](/Users/cornna/atlas-evidence/m1-work/m1-completion/Gates/dormice-update-20261009/UPGRADE-CANDIDATE-REVIEW.md)。自有加固补丁已在本地完成，提交 `a5e251f`，补丁 SHA `79cb8a45…`。内容：容器出生时只读 rootfs、no-new-privileges、`/tmp` tmpfs、uid 1000；模板镜像的 USER/VOLUME 在出生前校验；默认 manual-only 升级；安装器默认不加 `--allow-suid`。新测试在基线上为红、在补丁上为绿，主会话已重跑核对。真实 runsc（colima aarch64）下阡陌出生契约 13/13。x86_64 目标主机的验证和受控部署要等新目标。见 [加固报告](/Users/cornna/atlas-evidence/m1-work/m1-completion/Gates/dormice-hardening-20261010/REPORT.md)。

## 候选内容

个人账号、独立签名审批、批准并继续、个人/租户/全局额度、独立值守作业计量、记忆引用与写入治理、控制台审批和用量页、主题与事件刷新、节点粒度租户隔离、共享 PostgreSQL 注册中心、A2A HTTP 边界、现有资源池弹性模拟及原始日志观测报告。语义记忆的质量测量与是否适合启用按 [记忆评测](./memory-m1.md) 的原定门槛单独判断。

本轮语义记忆 E2、回答 A4 硬闸均未过，候选保持默认 OFF，不申请启用；代码治理正向测试不能替代质量闸门。下表历史 v8 候选为 `omp-20261008-281c3703998b`，冻结源码文件清单 SHA-256 为 `281c3703998b33aa959bf5da2c0c0b0df3aa3afe374c25fc55a7bff0d9b0b5d9`；最新 Linux x64 候选和实际结果见上节。

| 历史 v8 产物 | SHA-256 | 已执行边界 |
| --- | --- | --- |
| macOS arm64 | `01e475c22b975c8b22bfde29479a1299dcb68360b5a125a1ccf767945117f962` | 原生 5/5 smoke、13/0 编译后 CLI 回归、独立官方 SDK 双向互通 |
| Linux arm64 | `8ad8899a51ff805fe7ac7d7d8db33bf3f47173826f2a7b2213247394fb6fdea3` | 本地 Colima 原生 5/5 smoke、13/0 编译后 CLI 回归、独立官方 SDK 双向互通 |
| Linux x64 | `9b268d4a5d57cd8310b65353aac649b53a80cd3b85535bb8883db619a93fa4a0` | 同快照交叉构建；随后目标 x64 真机原生失败，详见本页现场记录 |

旧 `caa133…` 为前一轮产物，v5/v6/v7 也均保留为历史证据，不能与此表混用。启动凭据探针现先确认真实 child close 再开启 OMP RPC；配置切换须等待已有提交，未知退出不进入下一代。宿主审计异常也必须经过真实回收屏障。最终全 node 1187 pass / 1 skip / 0 fail，6274 断言，123 生产文件起止指纹一致；末轮类型与精确格式检查通过。

历史 v8b 具体审核包为 [v8b REVIEW](/Users/cornna/atlas-evidence/m1-work/m1-completion/Gates/field-preparation/deployment-review-v8b/REVIEW.md)，计划 SHA-256 为 `97991306da15e593288872216cf010dd4f4d27660400b96761584ea2e4843e02`。该次审核的动作仅是三台既有机器创建全新隔离根、复制固定产物和运行最多 300 秒的 native probe；不切生产、不启动长期服务或七天窗口。hub 为 cornna-p2、worker 为 cornna-p3、witness 为 cornna-p1，长期候选预留 39720–39740 中的明确回环端口；短期 native smoke 的假 provider 则由 OS 分配临时回环端口，旧 386xx 服务不变。独立 SSH host key、UID、主机名、bootId、目录与端口均在 stage 和 native 两个步骤分别复核；native 在执行任何候选 shell 之前重验全部六件工件的 SHA。停止脚本验证 known_hosts，并逐台尝试全部候选 transient unit，单机失败不会漏停后续 worker。审核生成器与真实本地文件篡改负控为 v8b 独立修订，不改变上表已验证二进制。

最终 Linux ARM 冷启动在独立 768 MiB / 50% CPU / 无 swap cgroup 内完成全部 5/5。checker 从本次 generation 1 的真实 runtime_ready 等待 5415.7 ms 后派发同一双签任务，确认 ACK/result、保护读写负控和普通写正控；早期即时冷请求 E_UNDELIVERABLE 仍保留为失败。采样含 checker/假 provider 和采样器并逐 PID 分类，probe 与 RPC 未在同一样本并行。**memory.peak 达到 768 MiB，max/reclaim 1127 次，OOM/kill 为 0；这证明受限完成，不证明有余量或实际 x64 小机可部署。** 非原子 PSS 峰与 cgroup charge 口径不同，完整 Pss_Anon/File、memory.stat 和原始样本见 [v8 资源证据](/Users/cornna/atlas-evidence/m1-work/m1-completion/Gates/field-preparation/startup-v8-768-final/summary.json)。v5 的 600 秒稳态不挪作 v8 结论；原 x64 qemu 失败保留。

自动更新工作流仅同步上游到隔离候选，验证后产生草稿更新，不部署。工作流尚未推送到远端启用；首次远端运行还需核对仓库权限和草稿 PR 链路。

## 审核时需要固定的配置

1. 目标机器、节点角色、操作系统与架构；最终目标平台产物的 SHA-256、源码快照及构建日志。macOS 本机构建和 smoke 不能替代 Linux 目标机的原生依赖与 bubblewrap 验证。
2. 中枢与用户可驱动节点的物理部署位置。M2 中枢不运行 resident；现有同机节点需先迁移。M1 独立 uid 方案的完整中枢秘密根与 SSH 根按 [P14.9](./hub-node-isolation-p149.md) 现场核对，不能只填一个声称隔离的布尔值。
3. 账号到租户、节点到租户、值守作业到租户的版本化映射；初始平台管理员名单、注册总量与速率。未映射对象不可默认获得节点，开放注册默认关闭。配置文件由受信运维原子写入并限制权限。
4. 控制台命令公钥、独立审批公钥、每个节点明确钉住的公钥。审批私钥与命令私钥分离，私密材料不写入版本库或发布包。启动使用签名握手与显式 trust；注册中心不是信任材料来源。
5. 个人/租户/全局限额与独立 watch job 限额、可信节点审计镜像及采集周期。token 值是实际观测下界，缺镜像不应当作免费或完整账单；历史 taskId 未绑定来源节点的行不能作为新计量真源。
6. PostgreSQL 主写入口、namespace、备份和写 token。两个 API 副本不消除单数据库故障点，生产主从切换需独立演练。迁移/回退顺序见 [共享注册中心](./registry-ha.md)。
7. A2A 明确支持的协议子集、固定 token 到身份/目标的映射与出站白名单。资源池本轮只启用现有资源模拟，不接入付费实例创建；逻辑容量预留不等于 OS CPU/RAM 隔离。

## 审核后的顺序与回退

先备份当前配置、持久账本与审计链，并保存校验值；原版本可执行文件和服务配置留存。新候选在隔离数据根演练，确认账号、租户、节点与密钥归属后再安排维护窗口。先停止旧入口接收新任务，等待在途回合和未知投递对账，不能通过删除账本清零占用。注册中心切换前必须重新发布并核对 CA 吊销列表。

先部署一组隔离的中枢与工作节点，复跑签名聊天、授权正负控、撤权、真实 token 归账、记忆写入/撤回、值守和跨节点任务；通过后再扩到其余目标。遇到启动失败、越权、审计缺口或账本不一致立即停止新派发。回退使用之前保存的产物与配置，先停止新写并核对状态版本，不能让旧代码盲写新 schema；需要恢复数据时由维护窗口备份恢复，审计和未知在途记录另行保留与对账。

## 现场验收仍需采集

- 同一部署连续两轮接力：真实工具入口、同步哈希、跨机续跑、原设备离线至少 30 分钟、另一设备接入、结果接回且本地改动保留。
- 授权全量原始 JSONL、不可变历史姿态、节点审计与离机见证。复判缺证据或工具错误结果必须保持不完整，不能由错误文案推断无副作用。
- 完整七天的端点、握手、唤醒首内容与值守数据；部署指纹改变即另起窗口。按 [观测口径](./beta-measurement-m2.md) 保留失败、缺样与原始记录。
- 多个连续、完整公测窗口的真实工作节点协作比例；本机受控 fixture 和单次零失败都不构成增长或 SLA 结论。

上述后续现场项目按实际执行与证据逐项确认；本轮隔离实验授权不等于总体验收已通过。
