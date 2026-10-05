<!-- Copyright 2026 Qianmo AgentNest Team -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# 阡陌 v2.47.1 GitHub Release

v2.47.1 是补丁版：在 v2.47.0（`0a298163`）之上加两项内测舰队运维脚本的修复，产品代码没有改动。发行形式与 v2.47.0 相同：`sweetcornna/atlas`，源码归档加 `SHA256SUMS`。基座 pin 仍为 v2.46.0，不含上游同步。

## 为什么要发这一版

v2.47.0 部署到内测舰队之前，P18.13 B 段只读预演查出一处会挡住迁移的问题：有一台节点机的 sshd 只留了主机私钥，没有 `/etc/ssh/ssh_host_*_key.pub`。sshd 本身不需要这个文件，但第六类动作专用 key 的登记脚本只读 `.pub`，读不到就拒绝，这台节点于是接不进中枢的模型服务执行器。登记脚本在节点上从部署树里跑，所以修复要随版本部署才生效。

## 变化

- `demo/env/beta/ops/model-apply-enroll.sh`，第 ④ 步 `node-hostkey`：一个 `.pub` 都读不到时，改在节点上 `ssh-keyscan 127.0.0.1:22`，取 sshd 实际出示的主机钥。
  - 这一步经运维那条已认证的 ssh 在节点上执行，本机 22 端口只有 root 起的 sshd 绑得上，信任锚与读 `.pub` 相同。
  - 第 ⑤ 步仍从中枢扫一次并逐把比对，中间人照样拒绝。
  - 回环也问不到才拒绝。
  - 用例覆盖：只有 RSA 私钥的节点；回环与中枢扫到的不一致；两边都没有。
- `demo/env/beta/handoff-node.sh`（#193）：接力节点 app-server 的模型 key 改读单独的 `secrets/handoff-model-env`，要求 0600、属当前用户、不是软链。常驻节点不读它。
  - 节点的模型服务迁到中枢托管、清掉 `model-env` 之后，接力节点照常能起。
  - 新文件不在时退回 `model-env` 并告警。
- `beta-env.md` 升 v1.7、`handoff-usage.md` 升 v0.4、`demo/env/beta/README.md` 随之更新。

## 升级注意

- 只用到 `dist` 的部署，行为与 v2.47.0 相同。
- 跑着接力节点的机器：清 `model-env` 之前，先把 key 那一行挪进 `secrets/handoff-model-env`（`chmod 600`），做法见 README「接力节点」一节。

## 出处

改动明细见 #193 与本版的发版 PR。
