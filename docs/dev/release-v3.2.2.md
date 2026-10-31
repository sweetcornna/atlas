<!-- Copyright 2026 Qianmo AgentNest Team -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# 阡陌 v3.2.2 GitHub Release

v3.2.2 在 v3.2.1 的基础上附上**桌面版 Qmo 0.1.0 的 macOS 安装包**（Apple 芯片，macOS 11 及以上，`.dmg`），里面是 v3.2.0 起的新桌面版：Work | Code 两种模式、Code 本机会话、Remote、离线打开 Code、Work 常驻会话与「开始一项工作」、分栏。v3.1.1 附的 `.dmg` 是旧的壳，没有这些。

安装包里同时补上了此前欠的一项许可声明：随包 `qmo` 内嵌的 Bun 运行时的许可。中枢与节点的代码与 v3.2.1 相同。标签所在提交比 v3.2.1 多的只有这份声明、打包配置、打包前的版本核对和文档，可以用 `git diff --stat v3.2.1 v3.2.2` 核对。识别 `qm` 产物以编译进去的源码提交为准（CONTRIBUTING §11）；`qmo` 与桌面壳自报 0.1.0。

安装包没有 Developer ID 签名，也没有公证。下文写的是已经做到的，没验证的逐条注明。

## 变化

- **桌面版安装包**：`Qmo-0.1.0-macos-arm64.dmg`，内含 `Qmo.app` 与 `Applications` 的快捷方式。界面与功能见 [v3.2.0 发行说明](./release-v3.2.0.md)，设计见 [`qmo-app.md`](./qmo-app.md) 与 [`qmo-local.md`](./qmo-local.md)。
- **Bun 运行时的许可声明**：`atlas/apps/qmo/src-tauri/BUN-NOTICES.txt` 是 Bun bun-v1.4.4 的 `LICENSE.md` 逐字副本，前面加了一段说明，讲怎样用改过的 Bun 重新编出 `qmo`。Bun 本身是 MIT；它静态链接的 JavaScriptCore/WebKit 是 LGPL-2，另有若干库各有许可。这份声明随 `Qmo.app` 放在 `Contents/Resources/`，与 `LICENSE`、`THIRD-PARTY-NOTICES.txt` 在一起，NOTICE 五.3 写明了出处。
- **打包前核对**：`atlas/scripts/build-app.ts` 打包前核对 `BUN-NOTICES.txt` 里写的 Bun 版本，必须与编译 `qmo` 的 Bun 一致，对不上就停。这样以后升级 Bun 时，声明不会落在旧版本上。

## 安装

1. 打开 `.dmg`，把 `Qmo` 拖进 `Applications`。
2. 第一次打开：在「访达」里对 `Qmo` 右键 → 打开；或在终端里去掉下载标记再正常打开：

    ```sh
    xattr -dr com.apple.quarantine /Applications/Qmo.app
    ```

3. 在登录页填中枢地址和配对码。配对码在中枢「连接」页「添加设备」里取。
4. 安装前先核对摘要：下载 `SHA256SUMS`，在同一目录运行 `shasum -a 256 -c SHA256SUMS`。

## 部署与验证

- 安装包在 macOS（Apple 芯片）本机构建，用的是标签所在的干净提交，Bun 1.4.4。
- 构建后检查过：
  - `Qmo.app` 与 `.dmg` 里的 `Qmo.app` 都通过 `codesign --verify --deep --strict`（ad-hoc 签名）。
  - 随包 `qmo` 自报的提交就是标签所在提交。
  - `Contents/Resources/` 里的 `LICENSE`、`THIRD-PARTY-NOTICES.txt`、`BUN-NOTICES.txt` 与仓库里的文件逐字相同。
- 没有验证的：
  - 用 `.dmg` 在一台干净的机器上安装；下载后带隔离标记时 Gatekeeper 实际怎么提示。
  - 真窗口里的 Code 本机会话（用真的 Claude Code、Codex 或 ACP agent）、Remote 与离线打开 Code，同 v3.2.0 的「部署与验证」。
  - Intel Mac：安装包只含 arm64。
- 内测环境的部署情况见[路线图](./roadmap.md)。

## 升级注意

- 从 v3.1.1 的 `Qmo.app` 升级：壳没有自动更新，要手动换掉 `Applications` 里的 `Qmo.app`。没有在两版之间实际换装过。
- 其余同 v3.2.0、v3.2.1 的「升级注意」。

## 已知问题

- 没有签名身份和公证，第一次打开要走上面第 2 步。
- 只有 macOS arm64。Windows 与 Linux 的壳没有安装包，那两个平台上继续用客户端 `qmo`。
- 其余同 v3.2.1 的「已知问题」。

## 出处

构建与许可声明的做法见 [`atlas/apps/qmo/README.md`](../../atlas/apps/qmo/README.md) 与 NOTICE 五.3。安装包只在本机构建与验证，记录不在仓库里。
