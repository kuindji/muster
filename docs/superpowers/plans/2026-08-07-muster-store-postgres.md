# Muster PostgreSQL Store implementation plan

**Goal:** Implement `@kuindji/muster-store-postgres` as a production-shaped,
Node-only adapter for the revision-26 `Store` boundary, with forward-only
migrations and real-database conformance coverage against the reviewed
`contract-freeze-15` contract.

**Scope:** PostgreSQL persistence only. This plan does not change the frozen
`Store` interface, core policy, worker wire version `1.1.0`, hashes, schemas,
fixtures, lifecycle tables, or public operations. It does not implement MCP,
OAuth/JWKS, rate limits, provider scheduling, a worker runtime, consumer side
effects, deployment infrastructure, backup automation, npm publication, or a
remote push. A missing atomic fact or unrepresentable outcome stops adapter
work and requires a separate normative amendment before implementation
continues.

**Architecture:** The package depends on `@kuindji/muster-core` and `pg` and
accepts a caller-owned node-postgres `Pool`; the adapter never owns pool
shutdown. A separate migrator owns schema creation and a separate bootstrap
operation installs the deployment-provided initial queue snapshot. Domain
commands use one checked-out client for one short PostgreSQL transaction,
execute at `SERIALIZABLE`, acquire affected rows in canonical key order, and
retry bounded SQLSTATE `40001` serialization failures and `40P01` deadlocks
from the beginning over an immutable pre-await input snapshot. Unique
constraints and compared revisions produce the frozen typed replay/conflict
outcomes; retries never reinterpret a durable identity collision as success.
Relational keys, states, revisions, foreign keys, and query columns enforce
identity and lifecycle integrity, while JSONB retains complete frozen records,
command receipts, and canonical JSON payloads without inventing adapter policy.

Primary implementation references are the PostgreSQL documentation for
[serializable isolation](https://www.postgresql.org/docs/current/transaction-iso.html)
and [explicit locking](https://www.postgresql.org/docs/current/explicit-locking.html),
the node-postgres documentation for
[transactions](https://node-postgres.com/features/transactions) and
[pool ownership](https://node-postgres.com/apis/pool), and the Testcontainers
documentation for the
[PostgreSQL module](https://node.testcontainers.org/modules/postgresql/).

## Entry gate: reviewed Milestone 2

- `main` is clean at the planning boundary and contains the final M2 review at
  `782674901456d0161ad4d9a628a9a8c079908800`.
- Revision 26 is the active normative boundary and is tagged locally as
  `contract-freeze-15` at `93ad945`.
- `@kuindji/muster-core` exports the complete Promise-based `Store`, staged
  Store conformance runners through `runTask8StoreConformance`, and the
  Store-parametric `runTask9ProtocolConformance` suite.
- The reference `InMemoryStore` remains the executable semantic oracle. The
  PostgreSQL adapter may translate persistence mechanics, but it may not copy
  policy into triggers, generated defaults, or SQL-side inference.
- Frozen `store-concurrency-cases.json` contains the required race identities.
  PostgreSQL tests must exercise the existing cases unchanged through multiple
  physical pool clients.

## Fixed adapter decisions

- Support PostgreSQL 16 or newer initially. The primary local/CI conformance
  image is PostgreSQL 16; a current-major PostgreSQL 18 compatibility job runs
  the complete package suite before the adapter is declared complete.
- Use a caller-owned `pg.Pool`. Export `PostgresStore`,
  `migrateMusterPostgres`, and `bootstrapMusterPostgres`; do not read connection
  strings or credentials from `process.env` inside the package.
- Default to a dedicated `muster` schema and allow a caller-supplied schema only
  when it matches `^[a-z_][a-z0-9_]{0,62}$`, a closed lowercase-ASCII grammar
  within PostgreSQL's 63-byte identifier limit. Quote the validated identifier
  in one helper and qualify every object explicitly; do not depend on mutable
  `search_path`.
- Require a UTF-8 database and reject any other `server_encoding` before schema
  creation or bootstrap. The frozen canonical-JSON domain includes Unicode that
  a narrower database encoding cannot represent.
- Keep migrations as ordered, checksum-verified `.sql` assets packaged with the
  library. Migration execution takes one schema-qualified transaction-level
  advisory lock before reading or creating migration state and refuses an
  unknown applied migration or checksum mismatch.
- The Store constructor never migrates or bootstraps. Migration and initial
  queue installation are explicit deployment steps. Bootstrap is
  create/replay/conflict, and no domain timestamp, revision, ID, queue cause,
  epoch, policy, or calendar is derived from database time, sequences, UUID
  functions, or environment state.
- Preserve complete records and receipts as JSONB, with relational columns for
  stable keys, states, revisions, ordering, joins, and predicates. Domain
  timestamps remain byte-preserved in the stored record; typed timestamp
  columns used for comparison are projections, not replacement values returned
  to callers.
- Parameterize every dynamic value. PostgreSQL cannot parameterize identifiers,
  so the single exception is interpolation of the already validated and quoted
  schema identifier into static package-owned SQL. Validate affected-row counts
  and persisted discriminants before returning a `Store` outcome; a malformed
  or future schema fails loudly instead of being cast into a frozen type.
- Before the first await, validate, detach, and freeze every Store command input.
  Keep transactions free of network calls, clocks, entropy, application
  callbacks, and sleeps; `withSerializableTransaction` accepts only an internal
  adapter closure over that snapshot. Lock all multi-row sets in stable bytewise
  identity order. Retried commands reuse the exact snapshot and never allocate a
  replacement identity.
- Retry only `40001` and `40P01` in the generic runner. Expected unique-key races
  use named constraints and conflict-aware statements to produce frozen typed
  replay/conflict outcomes; an unexpected `23505` or `23P01` is an infrastructure
  or schema error, never a blind retry or a guessed domain conflict.
- Give identity/order columns a deterministic database collation for lock
  ordering, but reproduce contract-visible array ordering with the same
  TypeScript comparators as the reference adapter. Database locale must never
  change a receipt, evidence order, target set, or policy decision.

## Independent plan review (complete 2026-08-07)

The pre-implementation review traced all 64 `Store` methods, the reference
adapter's replay maps, the staged conformance arrays, and every required frozen
concurrency ID. It corrected five adapter-plan gaps without changing the frozen
contract:

- dynamic schema names now have a closed, non-truncating quoting boundary rather
  than an impossible all-values-parameterized promise;
- the database encoding is explicitly UTF-8;
- retry attempts operate on a detached pre-await snapshot and cannot re-run an
  application callback or observe caller mutation;
- migration state includes durable command replay receipts and fingerprints, so
  exact old-command replay survives later state transitions and process restart;
  and
- expected identity collisions are handled by named constraints as typed domain
  outcomes, while the generic runner retries only serialization/deadlock errors.

No missing frozen fact was found. Task 1 may begin against revision 26 and
`contract-freeze-15`; implementation must still stop if its first SQL trace
finds an unrepresentable atomic fact.

## Store coverage map

| Plan task | Frozen `Store` methods |
|---|---|
| Task 3 | `getWorker`, `registerWorker`, `transitionWorkerState`, `registerClassVersion`, `getClassVersion`, `listClassVersions`, `transitionClassVersion`, `getCurrentPermitEpoch`, `transitionPermitEpoch`, `getWorkerRoutingSnapshot`, `transitionWorkerRouting`, `getQueueMode`, `transitionQueueMode`, `initializeClassHealth`, `getClassHealth`, `listClassHealth`, `transitionClassHealth` |
| Task 4 | `enqueueJob`, `getJob`, `getPayload`, `listLeaseCandidates`, `compareAndClaimLease`, `recordNoWorkAttempt`, `getLease`, `extendLease`, `abandonLease`, `expireAndRequeue` |
| Task 5 | `acceptOrReplaySubmission`, `rejectSubmission`, `getAcceptedSubmission`, `listAcceptedReplicas`, `getResultState`, `markResultSplit`, `transitionResult`, `recordDecisionResult`, `getDecisionResult`, `inspectAuthorizationContext` |
| Task 6 | `authorizeOrReplayIntent`, `getAuthorizationStatus`, `getInitialReceipt`, `getAuthorization`, `inspectInvalidationScope`, `invalidateResultScope`, `openResultAdjudication`, `getResultAdjudicationRequest`, `inspectResultVerdictContext`, `listPendingResultAdjudications`, `applyResultAdjudicationVerdict`, `getActionAdjudicationRequest`, `getPendingAuthorizationContext`, `listPendingActionAdjudications`, `getVerdictHistory`, `applyActionAdjudicationVerdict`, `inspectAdjudicationLoad`, `refreshClassHealth`, `enterEmergencyHalt`, `getReservePolicy`, `initializeReservePolicy`, `transitionReservePolicy`, `chargeReserve` |
| Task 7 | `appendLedger`, `listLedger`, `recordReputationEvidence`, `listReputationEvidence` |

During Tasks 3-6, untouched methods may use explicit internal
`not_implemented` infrastructure stubs only so the staged class remains
structurally assignable to `Store`; staged conformance must never call outside
its implemented slice. Task 7 removes every stub, and a source/package scan
fails the complete gate if any remains.

## Task 1: Package, connection boundary, and real-PostgreSQL harness (complete 2026-08-08)

Create the package skeleton before domain tables or commands:

- add `packages/store-postgres/package.json`, `tsconfig.json`,
  `tsup.config.ts`, `src/index.ts`, `src/postgres-store.ts`,
  `src/transactions.ts`, `src/migrations.ts`, and `src/codecs.ts` for Node 20+
  ESM/CJS/type output;
- add the runtime dependencies `@kuindji/muster-core` and `pg`, with `@types/pg`
  and `@testcontainers/postgresql` as development dependencies;
- extend `scripts/assert-invariants.mjs` so the adapter's runtime dependency
  set is exactly core plus `pg`, raw OAuth identity remains absent, and no
  direct `@kuindji/muster-contract` dependency bypasses the declared package
  boundary;
- define a minimal `QueryablePool`/caller-owned pool boundary, validated schema
  configuration, positive finite per-transaction lock/statement timeouts,
  transaction retry options with a closed maximum, and typed infrastructure
  errors that remain distinct from frozen domain outcomes;
- add `test/postgres-harness.ts` that starts one real container per test file,
  creates a unique schema for each `StoreFactory`, migrates and bootstraps it,
  returns a store backed by a pool large enough for actual races, and drops only
  that validated test schema during cleanup;
- accept an explicit test connection override for CI or local managed
  PostgreSQL in test code only, while Testcontainers remains the zero-setup
  default; and
- add focused tests for schema-name rejection, caller-owned pool lifetime,
  the 63-byte anti-truncation boundary, caller-owned pool lifetime, client
  release after success/failure, and package ESM/CJS exports.

Checkpoint: package build/typecheck and harness smoke tests pass against
PostgreSQL 16; no `Store` method is implemented yet.

Completion note: `@kuindji/muster-store-postgres` now builds Node 20+ ESM,
CommonJS, and declarations; validates the closed schema/timeout/retry boundary;
borrows and releases clients without owning pool shutdown; and exposes typed
infrastructure failures separately from future Store outcomes. The test-only
harness defaults to a real PostgreSQL 16 Testcontainer, permits an explicit
managed-PostgreSQL override, and creates and drops only unique validated test
schemas. Migration and bootstrap exports fail explicitly as unimplemented until
Task 2, so no schema or frozen Store behavior is fabricated at this checkpoint.

## Task 2: Forward migrations, bootstrap, codecs, and transaction runner (complete 2026-08-08)

Add the persistence foundation:

- create `migrations/0001_initial.sql` plus a checksum manifest and a migrator
  that verifies UTF-8, takes the schema-qualified transaction advisory lock,
  applies each pending migration once, and records version/checksum only in the
  same transaction as its DDL;
- create explicit tables for the migration ledger and singleton queue state;
  class versions and permit epochs; class health; workers and worker routing;
  global core identities; payloads, jobs, cycle state, attempt state, leases,
  accepted submissions, and decisions; reserve policies and charges; result
  and action adjudications, verdict history, effect intents, authorizations,
  and live authorization status; ledger entries; reputation evidence; reserve
  window history; and durable command replay fingerprints plus original typed
  outcomes for every command for which `InMemoryStore` retains history;
- enforce primary/unique keys for every frozen identity and composite scope,
  including `(class_id, contract_version)`, `(job_id, collection_cycle)`, one
  accepted submission per lease, one effect-intent owner, one canonical verdict
  per request, reserve charge keys, and evidence IDs;
- add foreign keys and closed state/check constraints where they protect the
  frozen model without letting SQL derive policy. Add indexes for candidate
  listing, open leases by holder/job-cycle, pending adjudications by
  class/opened time, invalidation scope discovery, ordered reputation evidence,
  and filtered ledger reads;
- implement record/payload codecs that reject non-finite JSON, unexpected nulls,
  invalid revisions, unsafe integers, and unknown stored discriminants. Keep
  returned objects detached from driver-owned values. Implement the reference
  adapter's structural command fingerprint semantics, including optional-field
  presence, without relying on JSONB textual formatting;
- implement `withSerializableTransaction`: acquire one pool client, begin at
  `SERIALIZABLE`, apply configured timeouts through parameterized
  `set_config(..., true)`, run the internal adapter closure on that client,
  commit, roll back on failure, always release, and retry bounded
  `40001`/`40P01` failures with the exact original snapshot. Never use
  `pool.query` inside a transaction; and
- implement explicit queue bootstrap with the same input shape and default
  `cause: "bootstrap"` as `InMemoryStore`, initial revision `1`, exact replay,
  changed-input conflict, and no database-owned domain time.

Migration tests cover fresh install, idempotent rerun, two same-schema migrators
racing, independent-schema lock isolation, checksum drift, an unknown future
migration, non-UTF-8 rejection, rollback after failed DDL, qualified-schema
isolation, identifier truncation rejection, and packaged SQL presence.
Transaction tests force serialization abort, deadlock retry, retry exhaustion,
internal-callback failure, caller mutation between attempts, unexpected unique
violation, and pool-client cleanup.

Checkpoint: schema/migration/transaction tests pass on PostgreSQL 16 and a
freshly packed tarball contains every required migration asset.

Completion note: the package now ships a compiled-and-packaged checksum
manifest plus `0001_initial.sql`, verifies UTF-8 under a schema-qualified
transaction advisory lock, refuses unknown or drifted history, and installs the
complete revision-26 relational/JSONB foundation atomically. Explicit queue
bootstrap has create/replay/conflict semantics with byte-preserved timestamps
and no database-owned domain values. Stored-record codecs reject malformed or
future data, and the internal serializable runner snapshots inputs before I/O,
applies transaction-local timeouts, retries only `40001`/`40P01`, and always
rolls back and releases its borrowed client. Focused tests cover real
PostgreSQL 16 migration races and isolation, bootstrap replay, manifest/history
drift, failure rollback, codec rejection, retry/exhaustion paths, and packaged
asset presence.

## Task 3: Class, worker, routing, and operational control state (complete 2026-08-08)

Implement the control-plane slice first:

- worker registration persists the immutable worker and initial routing record
  atomically; identical replay and changed registration conflict;
- worker-state transition compares the prior state, fences prepared claims,
  closes every affected open lease, and returns the complete requeue identity
  set from one transaction;
- class registration and lifecycle transition preserve schema-digest replay,
  transition cutoffs, retirement behavior, and affected reserve-health
  recomputation;
- permit-epoch initialization and transition remain class-qualified and use the
  exact predecessor comparison;
- queue/class-health initialize, read, list, and ordinary transition commands
  compare complete revisioned snapshots; and
- worker-routing transition compares the entire frozen routing snapshot and
  never derives a window or slot occurrence.

Use revision columns for optimistic comparison and `FOR UPDATE` locks for rows
the command may change. Whole-set operations also rely on serializable
predicate protection, so a newly raced class/version/load row forces retry or
the frozen conflict outcome rather than creating a partial view.

Tests select the control-state cases by frozen ID from
`TASK1_STORE_CONFORMANCE_CASES` against independent real schemas and add direct
two-client checks for atomic registration/bootstrap, state and revision races,
canonical multi-row lock ordering, and exact replay after a later transition and
adapter restart. Open-lease worker suspension and the remaining Task-1 cases
join Task 4 after lease persistence exists.

Checkpoint: every control-state case selected for Task 3 passes through
PostgreSQL and the in-memory suite remains green.

Completion note: `PostgresStore` is now structurally assignable to the complete
frozen `Store`; later-task methods remain explicit `not_implemented`
infrastructure failures. The Task-3 slice persists class versions and lifecycle
cutoffs, class-qualified permit epochs, atomic worker plus routing registration,
worker-state fencing, full routing snapshots, queue modes, and class health.
Every mutation runs in one bounded serializable transaction, compares the
complete frozen predecessor, records its original typed outcome for replay
after later transitions or adapter restart, and uses stable row ordering for
whole-set work. Retirement republishes accounting-owned reserve health while
ordinary health transitions preserve it. The three lease-independent frozen
Task-1 cases pass unchanged against PostgreSQL 16; focused two-client tests also
cover state/revision races, canonical class-version locking, lifecycle cutoffs,
reserve-health retirement, detached reads, and durable replay. Lease-backed
worker suspension and the other Task-1 cases remain intentionally deferred to
Task 4.

## Task 4: Job, payload, routing snapshot, and lease lifecycle (complete 2026-08-08)

Implement the enqueue and lease slice:

- enqueue compares queue/class revisions, class/version/epoch state, global job
  and payload identities, and persists the exact job, payload, and initial
  cycle/attempt state atomically;
- candidate reads return complete candidate, attempt, exclusion, and
  operational revisions without reserving or prioritizing work; the adapter may
  use a storage-stable row order, but urgent-first/value/time/sequence routing
  remains exclusively in core;
- compare-and-claim rechecks every prepared candidate/worker/operational fact,
  ordinary payload byte-equivalence, canary payload ownership, contribution
  cap, slot occurrence, open-lease exclusion, and global lease/payload
  identities before persisting the supplied lease unchanged;
- get, extend, abandon, expiry, no-work, same-cycle requeue, and contribution
  release/retention follow the frozen fair-attempt and deadline semantics; and
- losing claims and identity collisions leave no lease, payload alias,
  contribution increment, or partial attempt mutation.

Tests select the lease/routing/worker-requeue cases by frozen ID from
`TASK4_STORE_CONFORMANCE_CASES` with concurrent pool clients and add query
plan/index assertions for candidate and open-lease predicates plus rollback
checks at each multi-table mutation boundary. Emergency/invalidation cases stay
deferred intact to Task 6 rather than receiving a partial implementation.

Checkpoint: every lease-lifecycle case selected for Task 4 passes against
PostgreSQL 16.

Completion note: enqueue now atomically compares the complete operational,
class-version, permit-epoch, job, and payload state before creating the current
cycle and attempt snapshot. Candidate reads expose storage facts without
ranking them. Claims durably replay their first typed outcome and atomically
bind the supplied lease, exact ordinary or canary payload, attempt revision,
worker routing, contribution, and global lease identity. Extension,
abandonment, expiry, suspension requeue, and coarse no-work accounting preserve
the frozen deadline, sticky-epoch, and fair-attempt rules. All twelve selected
Task-4 lease/routing/worker-requeue cases pass unchanged against PostgreSQL 16;
focused tests additionally prove adapter-restart replay, multi-table rollback,
and use of the candidate and open-lease indexes. Task 5 is the next bounded
adapter slice.

## Task 5: Submission, replicas, result state, and decisions (complete 2026-08-08)

Implement the cycle-scoped result slice:

- accepted submission identity lookup occurs before mutable lease, queue,
  contract, or epoch checks so exact historical replay remains reachable;
- first acceptance atomically checks holder/input/result identity and cutoffs,
  closes the lease, persists the exact body and receipt, updates attempt state,
  and records optional reputation evidence;
- invalid submission settlement atomically closes/requeues the attempt, applies
  contribution accounting, and records qualifying evidence without creating an
  accepted row;
- replica reads exclude canaries and old cycles and use stable evidence order;
- split marking fences the exact current evidence set; automatic decision
  persistence compares the same set and current result state; and
- result transition/requeue increments the cycle once, retains old-cycle
  replay/history, installs the supplied new hash/epoch/time, and excludes old
  evidence from every new-cycle read; and
- decision, result-state, and authorization-context reads reconstruct the
  complete compared snapshot without loading runtime class functions.

Tests select the submission/result cases by frozen ID from
`TASK5_STORE_CONFORMANCE_CASES` and add direct races for exact submission,
contract cutoff, split versus decision, and old/new cycle visibility on
separate clients. The complete cumulative runner remains deferred until Task 6
implements emergency invalidation.

Checkpoint: every submission/result case selected for Task 5 passes against
PostgreSQL 16.

Completion note: accepted submission lookup now preserves holder-first
disclosure and exact historical receipt replay before mutable lease checks.
First acceptance atomically closes the lease, persists the body and receipt,
updates ordinary replica/diversity state, and records optional reputation
evidence; expiry and contract cutoff settle their complete fair-attempt effects
in the same transaction. Invalid settlement has durable create/replay/conflict
history. Replica reads exclude canaries and old cycles, while split markers and
automatic decisions compare the complete same-cycle evidence/open-lease
snapshot. Result transitions terminalize the old cycle, close its leases, and
publish the supplied next hash, epoch, attempt state, and current-job projection
atomically. All seven selected Task-5 cases plus the result-requeue case pass
unchanged against PostgreSQL 16; direct multi-client tests cover adapter-restart
replay, split-versus-decision serialization, cross-cycle isolation, and live
authorization-context reconstruction. Task 6 is the next bounded adapter slice.

## Task 6: Reserves, adjudication, authorization, and invalidation

Implement the high-contention safety slice:

- adjudication-load inspection and class-health refresh compare the complete
  health/load/live-version snapshot; emergency halt compares the queue and
  whole class set and publishes the complete invalidation batch or nothing;
- reserve policy initialize/transition enforces exact replay, same-window
  forward revision, forward-only rollover, stale-policy conflict, per-worker
  quota, and retirement recomputation;
- single and composite charge paths lock lanes in the frozen canonical order,
  preflight every policy/window/key, and publish either the complete settlement
  plus one health snapshot or the frozen no-partial-debit outcome;
- result-adjudication open owns the global request identity, result transition,
  reserve disposition, and backlog timestamp in one transaction;
- first result/action verdict compares the complete live context and processing
  cutoff, persists one canonical verdict/history receipt, and performs every
  resulting decision/requeue/authorization transition atomically;
- authorization intent identity lookup and exact initial-receipt replay precede
  mutable context checks; first authorization atomically claims both identities,
  compares the live decision context, settles all reserves, and persists the
  immutable initial receipt plus independently mutable live status; and
- scope inspection returns canonical complete targets. Invalidation and
  emergency withdrawal compare the exact target/requeue set, class-qualified
  epoch change, result/adjudication/lease state, and authorization validity,
  then apply all targets or none.

Tests first run the complete cumulative `runTask6StoreConformance`, then
exercise every remaining frozen reserve, verdict, authorization, invalidation,
and emergency race identity with multiple clients. SQL faults injected after
preflight but before final writes must prove complete rollback.

Checkpoint: the Task-6 Store conformance slice and every safety-race regression
pass against PostgreSQL 16.

## Task 7: Ledger, privacy boundary, and reputation evidence

Finish the Store surface:

- append ledger entries only after the same closed key/privacy validation as
  the reference adapter; sensitive entries with bodies or descriptors fail
  without allocating an ordinal or partial row;
- list ledger entries in stable append order with exact optional class/kind
  filters and detached JSON values;
- record reputation evidence by globally unique evidence ID with exact replay,
  changed-record conflict, and no raw result or OAuth body; and
- list worker evidence in frozen `(at, evidenceId)` bytewise order.

Run `runTask8StoreConformance` in full. Add restart persistence tests, malformed
row fail-closed tests, sensitive-ledger rejection, evidence race/order checks,
and package-level assertions that the adapter contains no core policy functions
or raw OAuth subject fields.

Checkpoint: the complete exported Store conformance suite passes against
PostgreSQL 16 with real concurrent connections.

## Task 8: Protocol conformance, migration compatibility, and CI

Prove the adapter through public core operations rather than Store calls alone:

- run `runTask9ProtocolConformance` with the published schema and
  prompt-injection fixture packs against a fresh PostgreSQL schema;
- run Store plus protocol suites after destroying and recreating the
  `PostgresStore` instance to prove state survives process-level adapter
  restart;
- replay earlier class, epoch, worker, routing, queue, health, enqueue, claim,
  rejection, split, invalidation, emergency, and reserve commands after later
  transitions and adapter restart, and require the original typed outcomes;
- add an exact coverage manifest keyed by
  `REQUIRED_CONCURRENCY_CASE_IDS`: every frozen ID must be owned either by an
  exported Store conformance case or a named PostgreSQL multi-client test, with
  no missing, invented, or duplicate ownership;
- test fresh install and upgrade from every checked-in migration prefix, and
  verify the migrator refuses checksum drift or a database newer than the
  package;
- add a PostgreSQL 16 CI service for the ordinary workspace gate and a separate
  PostgreSQL 18 compatibility job for the complete adapter package suite;
- keep Testcontainers tests serial at the file/container level while preserving
  genuine multi-client races inside each case; and
- document local commands for Docker/Testcontainers and an explicit external
  test URL without committing credentials or weakening TLS defaults.

Checkpoint: all Store and protocol cases pass on PostgreSQL 16 and 18, both
from source and the packed package.

## Task 9: Documentation, full validation, and independent review

- document public construction, explicit migration/bootstrap, caller-owned pool
  shutdown, supported PostgreSQL versions, transaction retry behavior,
  lock/statement timeout behavior, separate migration/runtime role guidance,
  migration/backup responsibility, schema qualification, and safe rollout
  order;
- update README package/status text and CHANGELOG to claim adapter completion
  only after the implementation and both database-version gates pass;
- run frozen install, invariants, all package typechecks, fixture checks, all
  tests, builds, package-content inspection, Markdown fence/local-link checks,
  and `git diff --check`;
- review every `Store` method against `InMemoryStore`, revision-26 prose,
  lifecycle and concurrency fixture IDs, exact-replay ordering, transaction
  boundaries, query predicates, indexes, and returned typed outcomes; and
- search specifically for SQL interpolation, unqualified schema access,
  identifier truncation, non-UTF-8 databases, `pool.query` inside transactions,
  leaked clients, mutable retry inputs, missing durable replay history,
  database-generated domain IDs/time, partial multi-row writes, inconsistent
  lock order, unbounded retry, swallowed serialization failure, misclassified
  unique violations, raw OAuth identity, old-cycle leakage, mutable initial
  receipts, reserve partial debit, and invalidation subsets.

An independent review is a separate checkpoint. Correct every adapter or plan
defect it finds, rerun PostgreSQL 16 and 18 gates, and stop before MCP work,
npm publication, deployment, commit, tag, or push unless explicitly requested.

## Delivery checkpoints

1. Tasks 1-2: package, real-database harness, migrations, bootstrap, codecs,
   and transaction semantics are executable.
2. Tasks 3-4: control plane and lease lifecycle pass the staged Store
   conformance suites.
3. Tasks 5-7: the complete Store surface and full Store conformance suite pass.
4. Task 8: public protocol conformance and PostgreSQL 16/18 compatibility pass.
5. Task 9: documentation and independent semantic review close the adapter
   milestone.

No checkpoint authorizes a frozen contract change, MCP implementation, npm
publication, deployment, commit, tag, or remote push.
