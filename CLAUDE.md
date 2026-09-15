# Atlas agent guidance

This is 阡陌 AgentNest, built on the open-claude-code base. The detailed rules live in [CLAUDE.full.md](CLAUDE.full.md); load the sections matching the task, not the whole reference.

## Standing constraints

- Use Bun (`engines.bun >= 1.3.11`) and `bunx`; scripts and the current filesystem determine commands and layout.
- Scope comes from [docs/dev/charter.md](docs/dev/charter.md). Do not publish npm packages, create release tags, run the base release workflow, or initiate an upstream sync as incidental work.
- Preserve the base/local provenance and dual-license boundary. Determine file ownership from `base-snapshot/v2.46.0`, not a missing SPDX header; apply the required headers to new owned files. `BASE.md` is owner-maintained for imports/syncs. Never rewrite the import/sync boundaries, move/delete `base-snapshot/*`, or rewrite post-baseline history.
- Derive runtime paths from `src/config/paths.ts`; preserve official Claude Code state, protocol/brand compatibility strings, and explicit user choices for credential migration.
- Keep model/provider/effort behavior tied to actual configuration and the compatibility rules. Preserve explicit “not generated / not evaluated” claims and required approvals for external claims.
- All PRs require review; no direct push to `main`. Follow the existing Conventional Commits and acceptance rules in [CONTRIBUTING.md](CONTRIBUTING.md).

## Task routes

| Task | Read in `CLAUDE.full.md` |
| --- | --- |
| Scope, packages, core changes, licensing, base sync, external claims | §§0–2, then the specific linked charter/decision document |
| Files, identity, credentials, Windows isolation | “路径与隔离不变式” and the relevant runtime subsection |
| Runtime, providers, models, tools, feature flags, UI | “Architecture Gotchas”, selecting the affected subsection |
| TypeScript or tests | §1.1 and “Testing”; production `as any`, Bun `feature()` placement, shared mocks and reset rules remain mandatory |
| Prompt/tool/skill guidance | “Working with This Codebase” and the matching dev-standards reference |
| Checks or contribution readiness | §3 and the matching CONTRIBUTING workflow; preserve ratchets and review gates |

For code changes, `bun run precheck` must pass with zero errors; it includes formatting writes, so preserve unrelated work and inspect its diff. Pure prose/instruction changes use relevant document/link checks and `git diff --check`, without a business test or formatter run. Push/PR readiness still requires the existing `bun run verify` gate. Reuse unchanged valid evidence; fix failures caused by this task and report actual checks and blockers.
