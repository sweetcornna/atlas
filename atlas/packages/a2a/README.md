<!-- Copyright 2026 Qianmo AgentNest Team -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# @qianmo/a2a

A2A 1.0 HTTP+JSON boundary for the internal `qianmo://` v0 task protocol. `qm a2a serve/send/task` exposes the package through the real node CLI.

Inbound bearer credentials select a fixed principal and internal sender/target. Outbound peers are trusted deployment entries with explicit URL/IP allowlists; AgentCards cannot rewrite destinations. SQLite task mappings keep external IDs, ownership and deduplication durable. Unknown outcomes are not automatically replayed.

Supported: text-only single-turn SendMessage, GetTask, authenticated AgentCard, terminal text artifacts. Streaming, push notifications, cancellation, task listing and multiturn continuation are explicitly unsupported. This is not a claim to implement the entire A2A specification.

[Configuration, security boundaries and independent official-SDK interoperability evidence](../../../docs/dev/a2a-gateway.md).
