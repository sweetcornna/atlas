# 阡陌 AgentNest（Qianmo AgentNest）

> 阡陌交通，鸡犬相闻。

**阡陌**是一个**云端常驻智能体交流网络**。智能体不再是一次性的对话进程，而是长期驻留在云端的个体：它拥有自己的地址、分层记忆与休眠/唤醒生命周期；当它需要别人时，沿着阡陌小径把消息递到另一个节点上的另一个智能体手里。田连阡陌，鸡犬相闻——这正是我们希望智能体之间形成的样子：各自安居，彼此可达。

两条产品线：

| 产品线 | 内容 | 在网络中的角色 |
|---|---|---|
| ① 云端常驻编程智能体 | 沙箱驻留、项目记忆、休眠唤醒、随叫随到、模型中立 | **节点** |
| ② 智能体通信协作网络 | 注册发现、按名寻址、加密消息、权限分级、限流防循环、跨节点资源协同 | 连接节点的**网络** |

当前阶段：**M0 原型验证期（2026H2）**。范围与验收标准以 [`docs/dev/charter.md`](docs/dev/charter.md) 为唯一依据。

---

## 基座说明

本仓库是 **[open-claude-code](https://github.com/sweetcornna/open-claude-code)（CLI 名 `occ`，MIT 许可）的下游 fork**。基座由项目负责人自有并已在 npm 公开发布（`@sweetcornna/open-claude-code`），以零改动快照方式导入本仓库根目录，锁定在提交 `848ad8c2c8daca9f5aa2410da555553e07700f5d`（= tag `v2.38.3`）。阡陌的自有代码以 `@qianmo/*` workspace 包的形式加入，常驻化改造直接落在基座运行时上。**pin 提交之后的全部提交即阡陌团队的工作**（`git diff 848ad8c2..HEAD`）。

完整溯源与上游同步记录见 [`BASE.md`](BASE.md)；采用理由、能力盘点与风险见 [`docs/dev/base-adoption.md`](docs/dev/base-adoption.md)；许可与商标声明见 [`NOTICE`](NOTICE)。

基座本体可独立安装试用（注意：这是基座的发布物，阡陌本仓库不发 npm 包）：

```bash
npm install -g @sweetcornna/open-claude-code
```

---

## 目录导览

本仓库是 fork 布局：**基座目录结构原样保留在仓库根**，阡陌自己的东西挂在其中。

```
.
├── BASE.md                  基座溯源记录（上游、pin、同步历史）—— 不随功能 PR 改动
├── LICENSE                  MIT（沿用基座）
├── NOTICE                   许可范围、基座溯源、Anthropic 商标声明
├── CLAUDE.md                本仓库对 AI 代理的工程约定（先读它）
├── BASE-CLAUDE.md           基座 CLAUDE.md 原文（导入时改名保留，架构与工程约定真源）
│
├── src/                     ← 基座：CLI 主体（入口、REPL、命令、服务、工具）
├── packages/                ← 基座 + 阡陌
│   ├── @ant/                  基座：Ink UI 框架、model-provider 等
│   ├── builtin-tools/         基座：内建工具
│   ├── tool-runtime/          基座：host facade 接口层
│   ├── workflow-engine/       基座：确定性工作流引擎
│   ├── …                      基座其余包
│   └── @qianmo/*              阡陌：自有 workspace 包（协议 / 注册 / 传输 / 记忆 …）
├── scripts/                 ← 基座：构建、门禁、基准脚本
├── tests/                   ← 基座：集成测试
├── vendor/                  ← 基座：预编译原生二进制（**不是**隔离目录，见 CLAUDE.md）
│
└── docs/
    ├── zh/ en/ ja/            ← 基座：基座自身的三语功能与内部文档
    ├── README.md              阡陌：申报材料索引
    ├── dev/                   阡陌：立项文档（见下）
    ├── assets/                阡陌：品牌与图表素材
    └── *.docx / *.pdf         阡陌：计划书与申请书
```

### 立项文档（`docs/dev/`）

| 文档 | 用途 |
|---|---|
| [`charter.md`](docs/dev/charter.md) | **立项章程 v2.0** —— 定位、范围与非目标、验收标准 AC-1~AC-8、工程基座与法律边界、风险、分工。**M0 阶段的唯一范围依据** |
| [`roadmap.md`](docs/dev/roadmap.md) | **路线图 v2.0** —— 排期基础假设、关键路径、S0~S9 任务包与完成判据、M1/M2 规划 |
| [`base-adoption.md`](docs/dev/base-adoption.md) | **基座采用报告** —— 基座是什么、为什么改路线（含放弃洁净室的代价）、两条产品线各自的能力与缺口、上游同步策略、风险 |

### 申报材料（`docs/`）

计划书、申请书与全部图表素材见 [`docs/README.md`](docs/README.md)。

---

## 开发入门

沿用基座的命令与门禁，不另起一套。

**环境要求**：[Bun](https://bun.sh/) ≥ 1.3.11（版本偏低会遇到难以定位的问题，基座对此敏感）。

```bash
bun install          # 安装依赖，workspace 内部包自动链接

bun run dev          # 开发模式启动
bun run precheck     # typecheck + lint fix + test —— 任务完成后必须零错误通过
```

其他常用：

```bash
bun test <path>            # 跑单个测试文件
bun run typecheck
bun run check:cycles       # 循环依赖棘轮（双向严格：超预算与低于预算都 fail）
bun run check:mock-hygiene # mock 卫生棘轮
```

完整脚本清单见 `package.json`。

**开工前必读**：
1. 本仓库的 [`CLAUDE.md`](CLAUDE.md) —— 阡陌自己的约定，以及基座硬规则中与阡陌开发直接相关的部分。
2. [`BASE-CLAUDE.md`](BASE-CLAUDE.md)（基座 CLAUDE.md 原文，导入时改名保留）—— 架构地图、路径与隔离不变式、测试与 mock 规范。**改任何路径相关代码前必须读它。**
3. [`docs/dev/charter.md`](docs/dev/charter.md) §5 —— 工程基座与法律边界，强制条款。

**提交规范**：Conventional Commits + 中文描述（`feat:` / `fix:` / `docs:` / `chore:` / `refactor:`），沿用基座约定。全部走 PR + 至少一人评审，不直推主干。

**本仓库不发 npm 包、不跑基座的 release 流程**（章程 N-14）。

---

## 许可

MIT License，沿用基座。详见 [`LICENSE`](LICENSE) 与 [`NOTICE`](NOTICE)。

"Claude"、"Claude Code" 与 "Anthropic" 是 Anthropic, PBC 的商标。本项目与 Anthropic 无关联、未获其背书。
