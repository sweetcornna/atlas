<!-- Copyright 2026 Qianmo AgentNest Team -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# @qianmo/elastic

Durable allocation of an existing resource catalog. The current adapter starts isolated local worker processes to simulate node leases; it does not create cloud instances or enforce OS CPU/RAM quotas. Use `qm elastic` for identity, plan, approve, apply, status, reconcile and release.

`ElasticController` stores plans, signed approvals, reservations and events in SQLite. Apply rechecks per-node, per-tenant and global capacity/budgets atomically. Plan hashes bind the catalog and request; IDs are idempotent. A proven failed allocation releases its reservation; an uncertain execution/release retains it. Reconcile may recover the same existing worker, never blindly repeat an allocation.

[Catalog schema, CLI procedure, costs, crash recovery and actual-process test evidence](../../../docs/dev/elastic-pool.md).
