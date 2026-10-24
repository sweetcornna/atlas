<!-- Copyright 2026 Qianmo AgentNest Team -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# 阡陌 v3.1.1 GitHub Release

v3.1.1 在 v3.1.0 的基础上附上**桌面版 Qmo 0.1.0 的 macOS 安装包**（Apple 芯片，macOS 11 及以上，磁盘映像 `.dmg`），并补上分发壳二进制前欠的第三方许可声明。产品代码与 v3.1.0 相同，仍是 10 月 23 日部署到内测环境的 `c47564c5`；标签所在提交比 v3.1.0 多的只有这次的文档、壳的许可声明与构建配置，可以用 `git diff --stat v3.1.0 v3.1.1` 核对。发行形式在源码归档与 `SHA256SUMS` 之外多一个安装包。识别 `qm` 产物以编译进去的源码提交为准（CONTRIBUTING §11）；`qmo` 与桌面壳自报 0.1.0。

安装包没有 Developer ID 签名，也没有公证。下文写的是已经做到的，没验证的逐条注明。

## 变化

- **桌面版安装包**：`Qmo-0.1.0-macos-arm64.dmg`，内含 `Qmo.app` 与 `Applications` 的快捷方式。`Qmo.app` 是 Tauri v2 原生壳加随包的 `qmo` 客户端（Bun 单文件编译），界面由中枢渲染（对话界面 `/app`、智能体界面 `/`、全局快捷键唤出的快速输入 `/app/quick`），设计与约定见 [`qmo-app.md`](https://github.com/sweetcornna/atlas/blob/v3.1.1/docs/dev/qmo-app.md)。
- **壳的第三方许可声明**：`atlas/apps/qmo/src-tauri/THIRD-PARTY-NOTICES.txt` 由 cargo-about 按 `about.toml`、`about.hbs` 与 `Cargo.lock` 生成，列出编进壳里的 Rust 依赖及各自的许可正文，随 `Qmo.app` 放在 `Contents/Resources/`，与 `LICENSE` 一起；NOTICE 五.3 写明了出处与重新生成的办法。Rust 依赖的许可仍由同目录 `deny.toml` 把关。
- **整包签名**：`tauri.conf.json` 里 `signingIdentity` 设为 `-`（ad-hoc），资源进了封印，`codesign --verify --deep --strict` 通过；关了 hardened runtime，因为没有公证它没有用处，而随包的 `qmo` 是 Bun 编译产物，开着它要另给 JIT 等授权。有 Developer ID 时用环境变量 `APPLE_SIGNING_IDENTITY` 覆盖即可，到时候再决定授权项。

## 安装

1. 打开 `.dmg`，把 `Qmo` 拖进 `Applications`。
2. 第一次打开：在「访达」里对 `Qmo` 右键 → 打开；或在终端里去掉下载标记再正常打开：

    ```sh
    xattr -dr com.apple.quarantine /Applications/Qmo.app
    ```

3. 在登录页填中枢地址和配对码（配对码在中枢「连接」页「添加设备」里拿）。
4. 安装前先核对摘要：下载 `SHA256SUMS`，在同一目录跑 `shasum -a 256 -c SHA256SUMS`。

## 部署与验证

- 安装包在 macOS（Apple 芯片）本机构建，源码是标签所在提交，工作树干净，随包 `qmo` 自报的提交就是这个提交。
- 构建后跑过：`Qmo.app` 的 `codesign --verify --deep --strict` 通过（ad-hoc）；包里有 `THIRD-PARTY-NOTICES.txt` 与 `LICENSE`，与仓库里的文件逐字相同；随包的 `qmo` 对预览中枢（`atlas/packages/console/test/appPreview.ts`）走了配对、`qmo session --json`（取得 `qianmo_session`、`qianmo_console`、`qianmo_client` 三枚 cookie）与 `status --json`；`qmo-app` 从终端起来后 10 秒仍在运行，没有崩溃。
- 没有验证的：
  - 从 `.dmg` 安装到一台干净机器；下载后带隔离标记时 Gatekeeper 的实际提示。
  - 真窗口里的观感、红绿灯与拖动区位置、透明的快速输入窗、系统通知、托盘点击、开机启动（同 `qmo-app.md` §10.2）。
  - Qmo.app 连内测环境的中枢；与内测中枢走通的是同一个 `qmo`。
  - Intel Mac：安装包只含 arm64。
- 中枢侧没有变化，不需要重新部署。

## 升级注意

- 这是桌面版的第一个安装包，没有旧版要升级。壳的自动更新没有做，新版要手动换 `Qmo.app`。

## 已知问题

- 没有签名身份和公证：第一次打开要走上面第 2 步；以后有 Developer ID 与公证再换掉这一条。
- 只有 macOS arm64。Windows 与 Linux 的壳还没有编过，没有安装包（P37.12）；Windows 与 Linux 上继续用客户端 `qmo`。
- 随包的 `qmo` 是 Bun 单文件编译产物，里面带着 Bun 运行时；Bun 自身的第三方声明还没有单独放进安装包，NOTICE 里没有这一项，下一轮补。
- 其余同 v3.1.0 的「已知问题」。

## 出处

构建与许可声明的做法见 [`atlas/apps/qmo/README.md`](https://github.com/sweetcornna/atlas/blob/v3.1.1/atlas/apps/qmo/README.md)。安装包只在本机构建与验证，记录不在仓库里。
