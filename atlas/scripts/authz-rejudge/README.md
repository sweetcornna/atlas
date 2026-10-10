<!-- Copyright 2026 Qianmo AgentNest Team -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# OMP resident permission replay (P14.7)

This is an offline, read-only inspection of a complete **one-node** acquisition. It loads no user configuration, hook, project extension, model or tool executor. It uses the pinned base's `resolveApproval`, actual native tool approval declarations and edit event normalization, followed by the current resident hardline and allowlist. It does not trust a host's `authorized: true` field.

Run from the repository root with its pinned Bun after obtaining a consistent copy (or stopping only the isolated test node):

```sh
bun atlas/scripts/authz-rejudge.ts \
  --sessions /acquisition/node/config/resident/sessions \
  --node node-name \
  --audit /acquisition/node/audit.ndjson \
  --out /acquisition/rejudge-report.json
```

`--audit` can repeat for audit segments. The report output must be a new file; existing evidence is never overwritten. Without `--out`, JSON goes to stdout. Exit 0 means every covered call passed; 1 means policy findings or incomplete evidence; 2 means invocation/read/schema error. The report records hashes of every input transcript and audit file, detects changes during reading and includes per-scan coverage. Do not place report files in the transcript tree.

Production resident now appends immutable `authz.posture` before opening each child, including session, agent, exact policy/hash, approval mode, protected roots and path environment. `authz.admission` binds the input message ID to context/task. The scanner gets bindings from those node audit records, verifies the local audit hash chain, and selects the posture by call timestamp. It does **not** use the mutable `resident-extension.json` as historical truth. Copies predating those fields fail incomplete and require a separately reviewed historical reconstruction; they cannot silently pass with the latest config.

Every `.jsonl` below `--sessions` is inspected, including nested subagent/sidechain files, abandoned branches and disconnected ancestry. Missing parents, duplicate identifiers, unknown posture, corrupt lines and symbolic links fail incomplete. Subagent/fork sessions are conservatively evaluated as subagents. A child transcript without its own input identity cannot obtain the parent's approval by inference.

An `ask` is a resident approval-eligible outside-workspace write or a native `prompt`. For each successful ask, replay recomputes `authzDigest(node, agent, context, tool, normalized input)` and joins a node `authz.grant_used` to a matching request and `allow-once`/`allow-window` decision. The grant must fall between the native assistant `message.timestamp` (response start) and its result: streaming `tool_call` approval can precede persistence of the enclosing assistant entry. A missing or inconsistent response timestamp fails incomplete. Time, expiry, task, approver, scope and revocation are checked; a use record can cover only one call, and an `allow-once` request can cover only one use. Duplicate copies of the audit file do not supply extra uses. A protected-root or disallowed-tool violation cannot be excused by a grant.

## Evidence limits and acceptance

The native `tool_execution_start` happens **before** final wrapper approval. Therefore it is not proof of execution. A native successful `toolResult` supplies execution evidence; errors, missing results and ambiguous results are explicitly **uncertain**, even when an error string says “denied.” A failing tool could have partially executed, and its text is not an authorization oracle. Such cases prevent a green report. Findings retain `execution: success|uncertain` so a denied attempt is not misreported as a proven side effect.

Replay checks the filesystem available **now**, including symlink canonicalization. It cannot prove historical symlink targets or recover omitted files; collect immutable filesystem/evidence snapshots for a historical claim. The local hash chain does not replace the off-host audit witness. The scanner neither tests OS sandbox strength nor claims a completed two-round production attack drill.

```sh
bun test --preload ./atlas/tests/preload.ts atlas/scripts/authz-rejudge/rejudge.test.ts
```

The suite includes successful E1 MCP, E2 shell, E3 subagent and E4 skill-writer bypass transcripts as **positive detection fixtures**, a protected-root positive, abandoned branch/sidechain traversal, exact grant and negative grant joins, duplicate evidence/use rejection, false host authorization, corrupt/empty evidence, and a real local OMP child writing a file whose native transcript is replayed. The positive fixtures establish that each scanner fires; they are not claims that the repaired runtime permits those attacks. Actual repaired runtime attack tests remain in `atlas/tests/integration/qianmo-resident-permission-bypass.test.ts`.

`atlas/packages/node/test/host/residentApprovals.integration.test.ts` also freezes and replays a real signed console → node approval chain and approved outside-workspace write, using production posture/admission metadata.

P14.7's operational closeout still requires complete copies from both real attack rounds, witness verification, investigation of every uncertain call and an archived report for each node. This script reports those gaps rather than converting them to passing counts.

Provider call IDs are scoped to an assistant entry: a later turn can reuse an ID, while duplicates inside one entry remain invalid. Each result must belong to the nearest assistant ancestor declaring that ID; later-turn results cannot silently satisfy earlier calls. `qianmo_memory_write` always requires its exact `allow-once` request/decision/use chain even though it is a registered host tool; a time-window grant is insufficient.
