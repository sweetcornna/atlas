<!-- Copyright 2026 Qianmo AgentNest Team -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# 阡陌接力 · 本机入口接法

| 项 | 内容 |
|---|---|
| 版本 | v0.1（2026-10-03，随 P17.3 本仓库部分） |
| 适用 | `qm handoff`（P17.4）与 `qm handoff mcp`（P17.3）；工作包与判据见 [`handoff-p17-plan.md`](./handoff-p17-plan.md) |
| 口径 | 接法按本仓库代码与 fork 的 `codex-rs/config/defaults.toml` 写；Claude Code 一侧照基座的 hook 与 MCP 配置格式写，**未在官方 Claude Code 上实测** |

## 1. 先登记仓库

每个要接力的仓库在仓库里跑一次：

```sh
qm handoff init --hub <user@host>:<裸仓根目录> --console https://<控制台> --key <专用钥匙> --token-file <凭据文件>
```

`qm handoff --help` 有全部选项。之后两个入口按下文接上：回合结束时同步会话，需要时由模型或人发起转交。

## 2. qmcode：内置，不用配

阡陌 Codex（`qmcode`）随二进制带了两项内置配置（fork `QIANMO.md` 第 10 节）：

```toml
notify = ["qm", "handoff", "sync", "--hook", "qmcode"]

[mcp_servers.qianmo]
command = "qm"
args = ["handoff", "mcp"]
env_vars = ["QMCODE_HOME"]
```

- 每个模型回合结束，`notify` 调 `qm handoff sync --hook qmcode` 同步会话。
- 每个线程起一份 `qm handoff mcp`，模型可以调用 §4 的工具；界面里的 `/handoff` 执行 `qm handoff now`。
- `qm` 要在 qmcode 的 `PATH` 上；找不到时每个新线程开头会显示两条 MCP 启动失败提示，线程照常。

**关掉内置 MCP**：在 `~/.qmcode/config.toml` 写**完整表**：

```toml
[mcp_servers.qianmo]
command = "qm"
args = ["handoff", "mcp"]
enabled = false
```

只写 `enabled = false` 时，`qmcode mcp add`、`qmcode mcp remove` 会报 `invalid transport in 'qianmo'`。

另外两点：自己写的 `notify` 会整个替换内置值，两者都要只能自写包装脚本；给 `[mcp_servers.qianmo]` 另写 `env_vars` 会替换内置值，要把 `QMCODE_HOME` 留在里面。

## 3. Claude Code：两行，自己写

**阡陌不代写你的 `~/.claude`**，下面两处都由你自己加。

第一行，把转交工具接给模型：

```sh
claude mcp add qianmo -- qm handoff mcp
```

默认只对当前项目生效；所有项目都要用，加 `-s user`。

第二行，在 `~/.claude/settings.json` 的 `Stop` 与 `SessionEnd` hook 里调 `qm handoff sync --hook claude-code`：

```json
{
  "hooks": {
    "Stop": [
      { "hooks": [{ "type": "command", "command": "qm handoff sync --hook claude-code", "async": true }] }
    ],
    "SessionEnd": [
      { "hooks": [{ "type": "command", "command": "qm handoff sync --hook claude-code" }] }
    ]
  }
}
```

- hook 从标准输入读 `session_id`、`transcript_path`、`cwd`，把「这个目录最近的会话」记到 `<配置根>/qianmo/handoff/sessions.json`，再推到中枢。`Stop` 用 `async`，回合不等推送。
- `SessionEnd` hook 只有 1.5 s，来不及推的部分由下一次同步或转交补上。
- hook 永远退出 0，结果写在 `<配置根>/qianmo/handoff/sync.log`。没登记过的仓库什么都不做。
- 转交工具按工作目录找会话：先找同一目录，再找同一仓库里最近一次 hook 报过的会话。所以在这个仓库里至少要有一个回合结束过。

## 4. 模型能调的工具

工具表随工作包合入逐个增加，后端没合入的工具不出现。

| 工具 | 何时有 | 做什么 |
|---|---|---|
| `qianmo_status` | P17.3 | 只读：登记信息、转交会带的会话、最近一次同步、中枢上本项目的任务 |
| `qianmo_handoff {goal, done, remaining, deadline?}` | P17.3 | **有副作用**：推送工作区的影子提交与会话记录到中枢，登记接力任务；中枢确认后返回「已落地，可以关机」和任务号，否则返回原因 |
| `qianmo_task {taskId?}` | P17.3 | 只读：一个任务的状态、简报、派发节点、云端结果摘要 |
| `qianmo_send {taskId, text}` | P17.5 | 给云端正在跑的任务追加一句话 |
| `qianmo_pull {taskId?}` | P17.6 | 接回 |

模型是在回合**中间**调用 `qianmo_handoff` 的，这个回合要等工具返回才会结束。所以转交的会话截到最后一个完整回合，调用它的这一轮不在其中（qmcode 截到这一轮的 `task_started` 之前；Claude Code 截到上一轮结束），返回里写明截到哪。这一轮里交代的事要写进 `goal`、`done`、`remaining`。

同一个仓库同一时刻只有一份转交：另一份正在进行时（另一个线程、另一个终端），后来的那份返回「另一份转交正在进行」，什么都不做。

## 5. 不记录什么

Claude Code 把自己的完整环境（含模型 key）交给 MCP 服务和 hook，qmcode 的 `notify` 也是完整环境。`qm handoff` 的日志、`sessions.json`、推到中枢的清单与工具的返回里都只有 id、路径、哈希和计数，不写任何环境变量；会话正文推送前先做秘密脱敏（P17.4）。
