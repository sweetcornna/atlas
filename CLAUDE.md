# Atlas agent guidance

This is 阡陌 AgentNest, built on the oh-my-pi (omp) base. The detailed rules live in [CLAUDE.full.md](CLAUDE.full.md); load the sections matching the task, not the whole reference.

## Standing constraints

- Use Bun (`>= 1.4`, pinned in `.tool-versions`) and `bunx`. The omp native addon must be built (`bun run build:native`) before running omp or the atlas suites that start it.
- Scope comes from [docs/dev/charter.md](docs/dev/charter.md). Do not publish npm packages, create release tags, run omp's release tooling, or initiate an upstream sync as incidental work.
- Preserve the base/local provenance and dual-license boundary. A file is base (MIT, no SPDX header) iff its path exists in `base-snapshot/omp-v18.8.4`; everything else is atlas-owned and needs the AGPL header. `BASE.md` is owner-maintained for imports/syncs. Never rewrite the import/sync boundaries, move/delete `base-snapshot/*`, or rewrite post-baseline history.
- Atlas code lives under `atlas/` (packages, scripts, tests) plus `demo/` and `docs/dev/`. Change omp files only when no extension point works, and record every such change in `docs/dev/base-modifications.md`.
- Derive node paths from `@qianmo/paths`; omp's own state stays under `<qianmoConfigDir>/omp` through `ompChildEnv()`. Never write to a user's `~/.omp`, `~/.claude` or `~/.codex`.
- Keep model/provider/effort behavior tied to actual configuration. Preserve explicit “not generated / not evaluated” claims and required approvals for external claims.
- All PRs require review; no direct push to `main`. Follow the existing Conventional Commits and acceptance rules in [CONTRIBUTING.md](CONTRIBUTING.md).

## Task routes

| Task | Read |
| --- | --- |
| Scope, packages, base changes, licensing, base sync, external claims | `CLAUDE.full.md` §§0–2, then [docs/dev/base-switch-omp.md](docs/dev/base-switch-omp.md) and the linked charter section |
| Node paths, identity, credentials, omp child isolation | `CLAUDE.full.md` §2.3 and `atlas/packages/paths` |
| Resident runtime, omp RPC, extension, providers | `CLAUDE.full.md` §4 and base-switch-omp.md §§4–5 |
| TypeScript or tests | `CLAUDE.full.md` §3 |
| Changes inside omp (`packages/`, `crates/`) | omp's rules in the lower half of `CLAUDE.full.md` |

Code changes: `bun run precheck` must be clean (it writes biome formatting under `atlas/` and `demo/`; inspect its diff). Before push/PR: `bun run verify`.
