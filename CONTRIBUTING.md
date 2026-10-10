# 贡献阡陌 AgentNest

阡陌代码位于 `atlas/`、`demo/` 与 `docs/dev/`。先读 [CLAUDE.md](CLAUDE.md)，再按任务路由阅读详细约定；基座切换的接口以 [base-switch-omp.md](docs/dev/base-switch-omp.md) 为准。

## 工作流

1. 从 `main` 建分支，保留已有未提交改动。使用 `.tool-versions` 固定的 Bun 与 `bunx`。
2. 修改阡陌代码后运行 `bun run precheck`，检查其格式化改动。只改文案时核对链接并运行 `git diff --check`。
3. 推送或发 PR 前运行只读门禁 `bun run verify`。实际执行项目、测试分片、预算规则与失败排查见 [CLAUDE.full.md §3](CLAUDE.full.md#3-命令测试与门禁)。
4. 用 Conventional Commits，一件事一个提交。全部走 PR 和评审，不直推 `main`；按 [PR 模板](.github/PULL_REQUEST_TEMPLATE.md)写改动动机、边界用例及实际验证结果。

不对整个仓库运行格式化器。阡陌代码使用 biome，omp 路径使用上游工具。新增检查要同时接进 `verify` 与 `.github/workflows/atlas.yml`。

## 测试与边界

修复行为缺陷先写可复现的失败用例；不能靠跳过测试或削弱断言通过。阡陌测试按包分片并用 `atlas/tests/preload.ts` 隔离环境。任何 omp 子进程都通过 `ompChildEnv()` / `ompSpawnEnv()` 运行，配置指向临时目录；不能触碰使用者自己的状态与凭据。

跨包用 `@qianmo/*`，节点路径来自 `@qianmo/paths`，omp 只经公开导出使用。优先用 RPC、扩展、host tools 和配置扩展点；修改基座路径时同 PR 登记 [基座改动清单](docs/dev/base-modifications.md)。归属按快照路径判断，不能按是否有版权头反推。新增阡陌文件的头与豁免见 [NOTICE](NOTICE)。

## 范围与文档

范围以 [章程](docs/dev/charter.md)为准。一个事实只保留一个真源，其余位置放链接。旧基座验收是历史记录，新基座只写实际复跑的结果。阡陌不发 npm 包、不运行 omp 发布脚本；上游同步另按 [BASE.md](BASE.md)办理。安全问题走 [SECURITY.md](SECURITY.md) 的私密通道。

下文是 omp 原始贡献指南，描述向 omp 上游贡献的流程；阡陌本仓库的贡献使用上面的入口。

<!-- base: oh-my-pi v18.8.4 CONTRIBUTING.md, verbatim below -->

# Contributing to omp

Pull requests are welcome. Keep them focused, understand the work you submit,
and be prepared to explain and maintain it.

> [!NOTE]
> Pull requests are **temporarily open to everyone** as a trial. We previously
> required a vouch before accepting PRs; that requirement is lifted for now
> while we evaluate how open contributions go. Depending on the results, the
> vouch system may return.

## Before you start

### Small changes

Bug fixes, documentation updates, and narrowly scoped improvements can go
straight to a pull request.

### Major changes

Discuss major features and broad architectural or behavioral changes in
[Discord](https://discord.gg/4NMW9cdXZa) **before writing the implementation**.
This includes new subsystems, large UI changes, new dependencies, and changes
that span several packages. A GitHub issue is not a substitute for this
discussion, and prior discussion does not guarantee that a pull request will be
merged.

### Do not open an issue for work you are about to submit

If you intend to implement a change yourself, **do not create an issue for it
first**. robomp treats actionable issues as work to pick up and may start the
same fix in parallel, wasting compute and maintainer time.

Open an issue when you are reporting a problem or proposing work that you are
not already turning into a pull request. If a relevant issue already exists,
link it from your pull request instead of creating another one.

## AI-assisted contributions

AI agents are welcome as tools, not as unattended contributors. Do not give an
agent a vague goal and submit whatever it produces.

Before opening a pull request, you must:

- constrain the agent to the agreed scope and reject unrelated changes;
- review every changed file and understand the resulting behavior;
- run the relevant checks and exercise the changed behavior yourself; and
- submit the pull request only after that review, rather than letting an agent
  publish it autonomously.

You are responsible for the code, regardless of who or what generated it.

## Pull request requirements

Every pull request body **MUST include at least one sentence written by you, in
your own words**, explaining what changed and why. A generated summary, pasted
agent transcript, or checklist alone does not satisfy this requirement.

One honest line is enough:

> I reviewed the full diff; this change fixes duplicate PR reviews by reusing
> the existing delivery guard.

You **MUST verify that the change works as intended**. `bun check` and automated
tests are expected where relevant, but they are not proof that the behavior
works. Exercise the changed path yourself and report the exact scenario and
result in the pull request:

- for a bug fix, reproduce the bug and confirm the same reproduction no longer
  fails;
- for a feature, launch the product and use the feature end to end; and
- for a UI change, interact with it and inspect the rendered result.

“`bun check` passes” by itself is not sufficient verification. For coding-agent
development commands and repository structure, see
[`packages/coding-agent/DEVELOPMENT.md`](packages/coding-agent/DEVELOPMENT.md).

Keep each pull request to one logical change. Avoid unrelated cleanup,
drive-by refactors, generated noise, or features that were not part of the
agreed scope.

## Contribution licensing

A contribution intentionally submitted for inclusion in OMP is licensed under
the MIT License.

This policy does not relicense third-party or vendored code. You must have the
right to submit your contribution and must preserve applicable copyright,
license, attribution, and notice material. Submitting a contribution does not
require signing a Contributor License Agreement (CLA) or certifying a
Developer Certificate of Origin (DCO).

## Review

Maintainers review the submitted behavior and the contributor's understanding
of it—not the volume of generated code. Respond to review feedback yourself,
and only apply suggestions you have checked.

Pull requests may be closed when they skip required prior discussion, lack the
human-written explanation, contain unreviewed agent output, or mix unrelated
changes.
