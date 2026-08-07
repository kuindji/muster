# Changelog

## Milestone 2 Task 9 — 2026-08-07

Exported a Store-parametric protocol conformance kit that exercises real core
services through lifecycle and exact-retry behavior, identifier collisions and
admission races, registration schema/oracle/agreement/effect/absence fixtures,
lease terminal-state disclosure safety, authenticated result and action
adjudication, live invalidation, and collection-cycle isolation. The suite
accepts the published schema and prompt-injection corpora explicitly, verifies
all required injection IDs and categories, treats their text byte-for-byte as
untrusted payload/result data, and uses deterministic clocks, identities, and
event assertions. All seven cases pass against the reference in-memory Store;
future Store and MCP adapters can reuse the same exported expectations.

## Milestone 2 Task 8 — 2026-08-07

Implemented finite effective-capacity projection, closed queue observation
validation, degraded/SLA/pool-offline derivation, durable queue causes, manual
admission restoration, and provider-offline signals. Class health now aggregates
every active and draining version conservatively, compares the version/load/
health set atomically, persists continuous unsafe dwell, enters starvation on
capacity or backlog age, and restores only through the explicit higher
threshold. Queue-wide emergency halt publishes all class health and
class-qualified invalidations in one transaction. Operations append correlated
hash-only ledger records, reusable privacy helpers enforce public/internal/
sensitive body and descriptor visibility, and non-finite reputation priority
continues to fail routing closed. Focused operations and privacy coverage joins
the Task-8 Store conformance suite.

## contract-freeze-14 — reviewed and tagged 2026-08-07

Revision 25 amendment discovered by the Task-8 class-health runtime trace.
`listClassVersions` now exposes the complete durable policy set and
`refreshClassHealth` compares it atomically with adjudication load and health.
Core sums required and restoration rates across every active or draining
version and uses the strictest dwell and capacity-freshness bounds; missing or
schema-incompatible live runtime entries fail closed. Version registration or
lifecycle races change no health state. Lifecycle, concurrency, compile-time,
and reference Store coverage accompany the change. Wire contract version
remains `1.1.0`; Task 8 runtime remains separate.

## contract-freeze-13 — reviewed and tagged 2026-08-07

Revision 24 amendment discovered by the Task-8 emergency runtime trace.
`listClassHealth` now exposes the complete queue-wide comparison set and
`enterEmergencyHalt` accepts exactly one canonical whole-class invalidation per
current class. Store preflights every operational snapshot, target, and requeue
plan before publishing queue refusal, all class-health replacements, and all
class-qualified invalidations together. Missing, duplicate, extra, non-class,
or newly raced class scopes change nothing. Multi-class lifecycle,
concurrency, compile-time, and reference Store coverage accompany the change.
Wire contract version remains `1.1.0`; Task 8 runtime remains separate.

## contract-freeze-12 — reviewed and tagged 2026-08-07

Revision 23 amendment discovered by the first Milestone 2 Task-8 trace. A
deployment-owned observation port now owns closed queue capacity, SLA, and
expected-slot arrival facts while core owns the finite effective-throughput
formula and automatic mode derivation. Queue snapshots persist transition
causes. Store exposes one revisioned result/action adjudication-load snapshot
and atomically compares it with persistent unsafe dwell and class health, so
request races fail closed and starvation restoration remains explicit.
Privacy-qualified closed ledger records reject sensitive bodies/descriptors,
and contract-transition audit detail is hash-only. Lifecycle, concurrency,
compile-time, and reference Store coverage accompany the change. Wire contract
version remains `1.1.0`; Task 8 runtime operations remain a separate unit.

## Milestone 2 Task 7 — 2026-08-07

Implemented descriptor-bound, all-actions authorization with canonical intent
hashing, transport and schema checks, declared-path effect projection, exact
automatic derivation comparison, action-specific support/completeness gates,
and human-only review binding. New intents compare the complete live
authorization context, settle every applicable low-cost, urgent, and
split-and-adjudication lane atomically, and persist one immutable authorized,
pending, or denied initial receipt. Exact retries now replay before runtime and
freshness checks, while live status remains independently readable after later
invalidation. Focused coverage includes mixed permits, no-identity descriptor
failure, typed permit denial, fail-closed reserve exhaustion, runtime-unloaded
replay, and contract/maximum-lifetime retirement.

## contract-freeze-11 — reviewed and tagged 2026-08-07

Revision 22 amendment discovered by the first Milestone 2 Task-7 trace. New
effect intents now compare one live decision/job/result/class context in the
same transaction as identity claims, canonical multi-lane reserve settlement,
status, backlog, and immutable receipt persistence. Composite low-cost, urgent,
and split-and-adjudication charges preflight atomically and publish ordered
settlements, skipped lanes, and one final health snapshot without partial debit.
Both first-verdict commands now distinguish signed `decidedAt` from core-owned
`processedAt`, fence the complete current context, and expose verdict history
for exact replay before runtime or freshness checks. Lifecycle, concurrency,
compile-time, reference Store, and adjudication-service coverage accompany the
change. Wire contract version remains `1.1.0`; Task 7 runtime action-gate work
is a separate unit.

## Milestone 2 Task 6 — 2026-08-07

Implemented authoritative reserve installation, transition, forward rollover,
idempotent charge settlement, atomic reserve-health publication, final-unit
races, per-worker quotas, and urgent fail-closed authorization persistence in
the reference Store. Added authenticated result and human-only action verdict
services with canonical hashes, exact replay/conflict behavior, observable
backlog timestamps, bounded rejected-dispute requeues, and capacity freshness
signals. Class-qualified invalidation now closes affected leases, transitions
pending requests, invalidates issued authorization validity without rewriting
initial receipts, performs emergency epoch withdrawal atomically, and computes
a distinct input hash for every new cycle. The reusable Store conformance suite
now runs through Task 6; Task 7 action-gate evaluation is next.

## contract-freeze-10 — reviewed and tagged 2026-08-07

Revision 21 amendment discovered by the first Milestone 2 Task-6 runtime trace.
Reserve policy is now an authoritative class/version/lane Store record with
typed installation, same-window transition, forward-only rollover, usage, and
health publication. Charge-bearing commands preserve charged versus exhausted
replay and distinguish changed charge keys from missing or stale policy. The
review added zero-limit saturation, rollback prevention, accounting-owned
health lanes, atomic health recomputation on class-version retirement, and a
typed result-adjudication identity collision. Wire contract version remains
`1.1.0`; the reviewed boundary is tagged locally as `contract-freeze-10`.

## Milestone 2 Task 5 — 2026-08-07

Implemented holder-bound submission settlement with immutable accepted replay,
coarse worker errors, structural/validator/oracle checks, atomic qualifying
reputation evidence, held-out canary scoring, unanimous equivalence and resolved
output revalidation, diversity checks, cycle-scoped decision hashing, and
durable absorbing splits. Routing now admits only the configured bounded extra
evidence after a split. Result escalation and adjudication remain Task 6.

## contract-freeze-9 — reviewed and tagged 2026-08-07

Proposed revision 20 amendment discovered by the first Milestone 2 Task-5
runtime trace. Submission acceptance now commits optional checked reputation
evidence atomically and settles lease/contract cutoffs in the same Store
command. A distinct invalid-submission settlement applies honest fair-attempt
accounting instead of masquerading as abandonment. Same-cycle settlement uses
the lease-stamped epoch. Job-cycle snapshots durably mark the first exact
absorbing split, and automatic decisions compare the complete current evidence
set and refuse split-marked cycles. Wire contract version remains `1.1.0`.
Independent review additionally removed a current-epoch claim fence that
stranded replacement leases stamped under an earlier ordinary epoch, and added
abandonment, expiry, and rejected-submission reclaim coverage. The
reviewed boundary is tagged locally as `contract-freeze-9`.

## Milestone 2 Task 4 — 2026-08-07

Implemented deterministic enqueue, worker-pull routing, ordinary and canary
lease preparation, quantized TTL/deadline snapshots, coarse no-work accounting,
holder-bound extension and abandonment, and same-cycle expiry requeue. The
reference Store conformance suite now covers lease holder binding, atomic
expiry/requeue, sticky cycle epochs, fair-attempt contribution release, and
provider-failure retention. Task 5 (submission and verification) is complete.

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
