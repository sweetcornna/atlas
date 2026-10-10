<!-- Copyright 2026 Qianmo AgentNest Team -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# P14.9 中枢与节点隔离前置检查

`demo/env/beta/beta-up.sh --role node` 在解析并恢复节点上次保存的尾参后、创建工作区和启动 resident 前检查部署姿态。它不会替运维迁移节点、切换 uid 或修改系统权限。本轮没有部署、停止或重启现网服务；既有同机节点的最终迁移选择仍须由运维在批准的窗口执行并记录。

## 输入与判定

`peers.conf` 的 `local-server <id>` 表示中枢服务器，节点归属来自该节点的 `server=`，没有坐标行时从地址端点派生。无隧道的回环端点归中枢。启用审批或 M2 时，缺中枢 id 或节点归属会拒绝启动，不能靠“未配置所以看不出同机”绕过。

- `QIANMO_BETA_STAGE=M1` 是兼容旧脚本的默认值。与中枢同机且有 `--approver` 时，要求下面的 OS 检查全部通过。
- `QIANMO_BETA_STAGE=M2` 拒绝在中枢启动任何 resident。出现 `--tenancy` 时自动按 M2 判定，即使环境声明 M1 也不能降级。非租户的 M2 部署也须显式设置 stage。
- 节点名须在 `--` 之前给出，透传尾参不接受 `--node` 覆盖，因为那会让所检查的归属与真正启动的身份不同。`--approver=x` 与 `--approver x`、保存后恢复的尾参都会检查。

## M1 同机审批的必要条件

运行该脚本的 euid 就是节点 uid，必须为 POSIX 非零 uid。运维显式给出两个绝对目录：

```sh
QIANMO_BETA_STAGE=M1 \
QIANMO_BETA_HUB_ROOT=/srv/qianmo-hub \
QIANMO_BETA_HUB_SSH_DIR=/home/qianmo-hub/.ssh \
  demo/env/beta/beta-up.sh --role node --node <node> -- \
  --require-signed-handshake --trust console=<commander-public-key> \
  --approver console=<different-approver-public-key>
```

整个中枢数据根涵盖 console/registry 配置、identity、审批签名密钥、token、transport PSK、provider 主密钥、备份与运维文件；SSH 根涵盖隧道、镜像和 provider executor 私钥。**这些路径是部署清单的约束**：把中枢秘密放在两棵树之外不在此配置的覆盖面内，必须先迁回或扩充实际受保护根，不能仍声称完整隔离。

检查使用真实 `geteuid`、`realpath`、`stat` 和 `access(W_OK)`，不接受一个自报 uid 或“已隔离”布尔值。两棵树必须为目录、由同一个中枢 uid 持有，且该 uid 不同于节点 uid；不能 group/world writable，也不能被当前节点 uid 写入。声明路径及其 canonical 路径两边都检查；节点持有的软链接、祖先目录可写且允许替换受保护目录时拒绝；共享临时目录只有 sticky bit 确实阻止当前 uid 改名他人目录时才例外。权限/ACL 无法读取或核实就拒绝。

通过后，两个规范化目录自动追加成 resident 的 `--protected-root`。resident 的 omp 工具策略与宿主审批 hardline 同时使用它们，读取、修改、删除及其父目录递归操作均不能由批准覆盖。只通过脚本检查而没有这条 runtime 接线，不算 P14.9 完成。

这道检查由可信运维配置驱动；它不是允许不可信节点自行提交 `peers.conf` 的远程部署 API，也不替代 OS 沙箱或中枢 uid 的权限隔离。即使 M1 条件通过，M2 仍必须分机。

## 本地验证与现场边界

`demo/env/beta/beta-up-args.test.ts` 运行真实 bash 参数解析与目录准备流程，仅把最终进程启动替换成 argv 记录器，避免触碰现网端口。OS 判定不打桩：同 uid 的临时树必须拒绝；非 root 开发机用 root 持有的只读系统目录作元数据夹具，验证真实独立 owner 后两个 canonical roots 确实出现在 resident argv。测试不读取这些目录内容。以 root 运行该用例时验证其必须被拒，不能伪造正向独立 uid。

另覆盖缺拓扑、缺完整根、持久尾参恢复、节点身份覆盖、M2 无审批同机拒绝、`--tenancy` 自动升级和分机放行。runtime 的受保护根读写副作用测试位于 resident 相关测试中。现场运行 uid、路径归属与 beta 节点迁移记录需要上线前复核；本地绿灯不能写成已完成生产处置。

新增 `atlas/packages/node/test/host/residentProtectedRoots.integration.test.ts` 用真实 OMP 子进程验证：工作区内显式 protected root 的 native read/write 被拦截，普通工作区文件仍实际写入。隔离临时数据树的运行日志为 `/Users/cornna/atlas-evidence/m1-work/m1-completion/Resident/protected-root-real.log`；该正负控是 runtime 接线证据，不代表已处置现网节点。
