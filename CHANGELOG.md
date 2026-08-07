# Changelog

## Milestone 2 Task 4 — 2026-08-07

Implemented deterministic enqueue, worker-pull routing, ordinary and canary
lease preparation, quantized TTL/deadline snapshots, coarse no-work accounting,
holder-bound extension and abandonment, and same-cycle expiry requeue. The
reference Store conformance suite now covers lease holder binding, atomic
expiry/requeue, sticky cycle epochs, fair-attempt contribution release, and
provider-failure retention. Task 5 (submission and verification) remains next.

## contract-freeze-8 — reviewed and tagged 2026-08-07

Revision 19 amendment discovered by the first Milestone 2 Task-4
runtime trace. Every lease now retains the exact operational payload reference,
prepared claims carry that payload, ordinary claims compare it with the queued
job, and canary claims atomically persist a distinct payload without changing
the queued job. A new atomic no-work command advances contribution usage under
the compared worker-routing revision. Lifecycle, concurrency, compile-time, and
reference-Store coverage accompany the change. The review additionally fixes
canary payload-reference ownership, collision preservation, complete no-work
routing comparisons, and transition fencing. Wire contract version remains
`1.1.0`; the reviewed boundary is tagged locally as `contract-freeze-8`.

## contract-freeze-5 — 2026-08-06

Revision 16 amendment discovered by the first Milestone 2 Task-2 registration
trace. Agreement fixtures now bind one schema-valid payload to every candidate
result set so registration can run payload-dependent validators and oracles.
`EscalationReserves` now declares
`retrospectiveAuditProjectionPerWeek`, making the audit-reserve floor
deterministic and class-owned. The closed agreement-fixture shape validator and
compile-time contract tests cover both additions. Wire contract version remains
`1.1.0`; Store ports, durable records, and runtime coordinator behavior are
unchanged.

## contract-freeze-2 — 2026-08-06

Revision 13 amendment before Milestone 2. Freezes Muster Schema 1 and its
zero-dependency structural/value/path implementation; class-qualified
compare-and-apply invalidation; distinct per-cycle requeue hashes; atomic
emergency epoch and worker-state/lease transitions; durable class-version
schema identity and lifecycle; timestamped pending-adjudication reads;
idempotent ordered reputation evidence and the pure consumer-owned
`ReputationPolicy`; explicit authorization-validity audit events; and the
corresponding schema, lifecycle, and concurrency fixtures. Wire contract
version: `1.1.0`.

No runtime coordinator mechanics, Postgres adapter, or MCP server behavior is
included. `contract-freeze-1` remains historical.

## contract-freeze-1 — 2026-08-06

Milestone 1 of
`docs/specs/2026-08-04-muster-coordinator-design.md` revision 12 (§11.1).
Freezes: all public types (§11.1 list) in `@kuindji/muster-contract` and the
`@kuindji/muster-core` port/event skeleton (atomic-domain-command `Store`,
audit and notification event schemas); the action-gate, precedence,
fair-attempt, audit-source, queue-mode, quantization, and privacy-class tables;
pseudonymous core worker identity and severable MCP mapping boundary;
collection-cycle-scoped result lifecycle and requeue isolation; the worker and
contract lifecycle state machines; `input_hash` over the exact sanitized
payload and both schemas, `result_hash`, `decision_result_hash`,
`effect_intent_hash`, and verdict-hash envelopes with cross-checked golden
vectors; the declarative lifecycle/retry/invalidation fixture pack,
store-concurrency case list, and prompt-injection corpus; MCP tool,
availability, `no_work`, and uniform-error schemas; the skill source shape and
`skill_sha256`. Wire contract version: `1.0.0`.

Any change to these from now on is a freeze amendment: spec revision first.
