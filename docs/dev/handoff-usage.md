<!-- Copyright 2026 Qianmo AgentNest Team -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# 阡陌接力 · 本机入口接法

| 项 | 内容 |
|---|---|
| 版本 | v0.2（2026-10-04，补 P17.5 云端续跑；v0.1 2026-10-03 随 P17.3） |
| 适用 | `qm handoff`（P17.4）、`qm handoff mcp`（P17.3）、`qm handoff node` 与中枢派发（P17.5，§6）；工作包与判据见 [`handoff-p17-plan.md`](./handoff-p17-plan.md) |
| 口径 | 接法按本仓库代码与 fork 的 `codex-rs/config/defaults.toml` 写。qmcode 一侧 2026-10-03 用本机 debug 构建（fork `34e0d210ed`）加假 Responses 服务实测过 `qianmo_handoff` 回合内调用与审批；Claude Code 一侧照基座的 hook 与 MCP 配置格式写，**未在官方 Claude Code 上实测** |

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

**审批**：`qianmo_status`、`qianmo_task` 标为只读，qmcode 不问（读码）。`qianmo_handoff` 会把工作区推出本机，按 qmcode 的规则要审批：默认的 `on-request` 下会弹审批（读码，界面里未实测）；`approval_policy = "never"` 且不是完全访问时，qmcode 直接拒绝，模型看到 `MCP tool call requires approval, but approval policy is never`（实测）。这种配置下想让模型直接转交，给这个工具单独放行（实测用的是同义的命令行覆盖 `-c 'mcp_servers.qianmo.tools.qianmo_handoff.approval_mode="approve"'`，转交成功）。写进 `config.toml` 时同样连完整表一起写，理由同上：

```toml
[mcp_servers.qianmo]
command = "qm"
args = ["handoff", "mcp"]
env_vars = ["QMCODE_HOME"]

[mcp_servers.qianmo.tools.qianmo_handoff]
approval_mode = "approve"
```

不想放行就用界面里的 `/handoff`，它不经过 MCP。

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
| `qianmo_send {taskId, text}` | P17.5 | **有副作用**：给转交出去、还没结束的任务追加一句话。中枢记账后返回第几句；节点接手后按顺序送进正在跑的回合（§6.4） |
| `qianmo_pull {taskId?}` | P17.6 | 接回 |

模型是在回合**中间**调用 `qianmo_handoff` 的，这个回合要等工具返回才会结束。所以转交的会话截到最后一个完整回合，调用它的这一轮不在其中（qmcode 截到这一轮的 `task_started` 之前；Claude Code 截到上一轮结束），返回里写明截到哪。这一轮里交代的事要写进 `goal`、`done`、`remaining`。

同一个仓库同一时刻只有一份转交：另一份正在进行时（另一个线程、另一个终端），后来的那份返回「另一份转交正在进行」，什么都不做。

## 5. 不记录什么

Claude Code 把自己的完整环境（含模型 key）交给 MCP 服务和 hook，qmcode 的 `notify` 也是完整环境。`qm handoff` 的日志、`sessions.json`、推到中枢的清单与工具的返回里都只有 id、路径、哈希和计数，不写任何环境变量；会话正文推送前先做秘密脱敏（P17.4）。

## 6. 云端续跑（P17.5）

转交登记之后，中枢把任务派给一台节点：节点桥 `qm handoff node` 在节点上的裸仓里开一棵工作树，交给同机的 `qmcode app-server` 续上转交的会话，回合结束后把改动提交到 `qianmo/<任务>`，回 `task.result`；中枢把分支和云端会话取回自己的裸仓。接回本机是 P17.6 的事。

### 6.1 中枢

在 `qm console --handoff-root …` 上再加（`console.md` 的参数表有逐条说明）：

```sh
qm console --handoff-root <裸仓根> \
  --handoff-node <节点>=ws://<节点地址>:38630 \
  --handoff-node-git <节点>=<ssh 目标>:<节点内测根>/handoff/node/repos \
  --handoff-node-key <中枢在节点闸门上的专用钥匙> \
  [--handoff-notify-url https://<推送地址>]
```

- 节点按给出的顺序挑，一个节点同时只跑一个任务。传输 PSK 与对话面同一个按节点派生的变量。
- 派发请求**总是签名**，用控制台自己的签名身份。`qm console --print-wake-identity` 打出的那一行要给节点桥的 `--trust`；不签或签名不对的请求节点一律拒收。
- 推送和取回都走节点上的 SSH 闸门（`demo/env/beta/ops/handoff-git-gate.sh`，根目录是节点桥的 `repos/`），用中枢**专用**的一把钥匙，不是登录用的那把。推送和取回都由中枢发起，节点桥不往中枢拨号。

### 6.2 节点

```sh
demo/env/beta/beta-deploy.sh --tree <部署树> --from <构建树> --only qmcode
QIANMO_HANDOFF_BASE_URL=<网关 /v1 地址> demo/env/beta/handoff-node.sh start \
  --node <节点> --trust console=<公钥> --project <项目>
```

- 节点机上要有能建 user namespace 的 `bwrap`。没有时节点桥拒绝启动并写明原因，不退到 `danger-full-access`。
- 模型 key 只给 app-server，节点桥、日志、台账和结果里都没有它。key 从 `secrets/model-env` 读，变量名由 `QIANMO_HANDOFF_KEY_ENV` 指定，默认 `OPENAI_API_KEY`。
- app-server 启动时带 `-c mcp_servers.qianmo.enabled=false -c 'notify=[]'`。qmcode 内置的阡陌 MCP 和回合结束回调在节点上会反过来调用接力命令。
- 节点仓由节点桥按 `--project` 建好：只有 `qianmo/` 分支，没有 remote，装的是和中枢同一份 pre-receive 钩子。
- app-server 进程及其子进程的 `RssAnon` 合计超过 150 MiB 时，节点桥不接新任务（回 `E_BUSY`，中枢稍后重派），正在跑的回合不受影响；`VmRSS` 只写进日志。没有 `/proc` 的系统上不做这项判断。

脚本的细节见 `demo/env/beta/README.md`「接力节点」一节。

### 6.3 状态与通知

| 台账状态 | 意思 |
|---|---|
| `accepted` | 中枢已登记，还没有节点接手 |
| `dispatched` | 对象已推到节点，`task.request` 已发出 |
| `running` | 节点回了 ack，回合在跑 |
| `done` | 节点回了结果，分支和云端会话已取回中枢。回合被中断或失败也记 `done`，结果里的 `status` 写明，分支与线程 id 都在，可以接回 |
| `failed` | 节点拒收、结果解不开或取回失败；也包括到截止时间仍没有节点接手，或派出后超过截止时间 10 分钟仍没有结果 |

- 节点暂时拒收（`E_BUSY`、`E_RATE_LIMITED`、`E_LOOP`）不算失败，下一个周期再发。
- 任务进行中，中枢每 60 秒 ping 一次节点；回执丢了的结果，节点在下一次收到消息时补发。
- 配了 `--handoff-notify-url` 时，任务到 `done` 或 `failed` 时 POST 一次 JSON：`title`、`body`、`msgtype: "text"` 加 `text.content`，以及 `qianmo` 字段（任务、状态、节点、分支、head、线程 id、原因）。字段是照 Bark 与企业微信群机器人的请求形状凑的，**没有对这两个真实服务发过**；没有专门适配 ntfy 的格式。
- MCP 的 `qianmo_task` 看得到状态、派到哪个节点和结果摘要。摘要离开节点前已脱敏。

### 6.4 追加一句话

`qianmo_send {taskId, text}`（或 `POST /v0/handoff/<任务>/send`）先写进中枢台账，返回这是第几句；台账只在任务处于 `accepted`、`dispatched`、`running` 时收。节点接手后，中枢按顺序把这些话转给节点桥，节点桥在同一个线程上 `turn/start`，回合还在跑时就并进这个回合。

节点已经在收尾（回合结束、正在提交）时，这句话不再送进线程，节点回一个失败结果。这个结果目前只写进中枢的日志，`qianmo_task` 里看不到。
