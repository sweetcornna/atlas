---
name: dev-standards
description: "在修改 open-claude-code 的 system prompt、工具定义、CLAUDE.md、技能或 Windows 兼容行为时使用，帮助确定规则、接口说明、按需参考文档与可执行检查的边界。"
---

# open-claude-code 开发规范

只写**判断依据**。能从代码读出来的事实在 `CLAUDE.md`，流程与命令在 `CONTRIBUTING.md`。

## 总原则：少即是多

官方复盘的第一结论：他们**过度约束**了 Claude Code——system prompt 和 CLAUDE.md 两头都是。
针对 Opus 5 / Fable 5 删掉 **80% 以上的 system prompt**，编码评测**没有下降**。

这是所引历史资料中特定模型与评测配置的结论，不是本仓库所有模型的验证结果，也不能直接推广到 Astra。应用模型相关建议前，确认实际模型、路由与任务证据。

新增任何"规则"前先自问：**这条是在补充模型不知道的事实，还是在替模型做它自己会做的判断？**
对后者先检查是否提供了任务边界、验收信号或必要风险控制；只有确认冗余且没有独立价值时才合并或删除。

对 CLAUDE.md 的每一行检查它是否是项目事实、授权、安全或验收要求的唯一来源，结合实际失败案例判断是否可删。
过长的 CLAUDE.md 的真实代价不是 token，是**重要规则被淹没后被忽略**。

## 模型相关建议与必要复核

以下是 Opus 5 相关资料中的调整方向。是否采用取决于实际模型、任务风险与项目验收；不据此跳过必要步骤或改变其他模型的门控。

- **空泛、无条件的验证或子代理复核** —— 改成与变更相关的检查及完成标准。保留项目要求、敏感操作、高风险改动和独立审查所需的验证。
- **"再检查一遍" / "回答前再确认"** —— 已有充分证据且没有新改动、失败或疑点时不重复；出现新证据时继续针对性复核。
- **"不要思考" / "不要推理"** —— 关 thinking 时反而**增加** `<thinking>` 标签泄漏。
- **评审类的"只报高危" / "保守一点"** —— 可能导致漏报。覆盖完整评审范围，报告有证据的可操作问题并按严重性排序，不强制另跑一轮过滤。

需要控制成本时，降 **effort** 而不是关 thinking：thinking 开 + `low` effort 通常优于 thinking 关的同等成本。

反过来，Opus 5 需要**显式**给的是：响应长度（verbosity 不随 effort 下降）、写盘文档的长度、
任务边界（它会自行扩大范围）、子 agent 的委派门槛与数量上限。

## 四个面的落点

| 面 | 放什么 | 细则 |
| --- | --- | --- |
| system prompt | 产品身份与环境事实——模型无法自己得知的 | [prompts-and-tools.md](prompts-and-tools.md) |
| 工具定义 | 用参数与 schema 表达能力，不用示例约束 | [prompts-and-tools.md](prompts-and-tools.md) |
| CLAUDE.md | 仓库概览 + gotcha，其余只留指针 | [docs-and-skills.md](docs-and-skills.md) |
| skills | 团队观点与实践，渐进式披露 | [docs-and-skills.md](docs-and-skills.md) |

## 给 Claude 可验证的检查

官方最强的一条工程建议：**给 Claude 一个它自己能跑的检查**，否则"看起来完成了"就是唯一信号，
人变成验证回路。本仓库现成的检查：`bun run precheck`、`bun run check:cycles`、
`bun test <path>`、`scripts/dump-prompt.ts` 前后对比。

写任务描述时把验收条件写成**能跑的东西**，而不是形容词。要求它**出示证据**（命令与输出），
而不是声称成功。

## 参照物优先于文字描述

要复现某个形态时给**高保真参照**——现有实现、测试、快照——而不是散文规格。
本仓库天然有很多："新增 facade 照抄 `slowOperations.ts`"、"新增 provider 照抄 `specs.ts` 的表项"
比十行规格准确得多。

## 跨平台：路径一律正斜杠

官方 skill 规范明写：**永远用正斜杠**，即使在 Windows 上。反斜杠在 Unix 上直接出错。
本仓库还有一条更强的：**解析**路径时必须同时接受两种分隔符（`split(/[/\\]/)`），
因为 `join()`/`dirname()` 在 Windows 上产出反斜杠——这里踩过坑（plugin 命名空间、版本解析）。

Windows 相关的不变式在 `CLAUDE.md` 的路径与隔离一节。

## 反模式对照

| 旧做法 | 现在 |
| --- | --- |
| 没有任务依据的流程性护栏 | 按风险陈述边界，保留权限、安全、隔离和验收契约 |
| 给工具写用法示例 | 把能力表达进参数与 schema |
| 同一条指令多处重复 | 单一权威位置，其余引用 |
| 知识堆在 CLAUDE.md | gotcha 留下，其余进 skill / `docs/` |
| 用散文描述期望产物 | 给代码 / 测试 / 快照当参照 |
| 无条件重复叮嘱复核 | 给出可执行检查、适用条件与完成证据 |
| 无脑派子 agent | 只在大且真正独立的任务上派 |

## 参考

- [The new rules of context engineering for Claude 5 generation models](https://claude.com/blog/the-new-rules-of-context-engineering-for-claude-5-generation-models)
- [Prompting Claude Opus 5](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5)
- [Best practices for Claude Code](https://code.claude.com/docs/en/best-practices)
- [Writing effective tools for AI agents](https://www.anthropic.com/engineering/writing-tools-for-agents)
- [Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- [Skill authoring best practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices)
