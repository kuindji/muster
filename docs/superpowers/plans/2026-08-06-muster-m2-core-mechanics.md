# Muster Milestone 2 core mechanics implementation plan

**Goal:** Implement the complete one-shot coordinator engine in
`@kuindji/muster-core` against revision 20 and the pending
`contract-freeze-9` boundary, including an in-memory Store and reusable
Store/protocol conformance suites.

**Scope:** Core mechanics only. This plan does not implement PostgreSQL, OAuth,
JWKS, rate limiting, MCP transport, provider scheduling, a worker runtime,
staged work, or consumer side effects. Those remain separate plans. The frozen
wire contract and fixtures may be consumed but not changed without a normative
spec revision and a new contract-freeze amendment.

**Architecture:** `muster-core` remains deterministic, I/O-free, and dependent
only on `muster-contract`. Runtime services accept explicit `Store`, `Clock`,
`IdSource`, `EventSink`, `AdmissionHook`, `AdjudicationSource`, and
`ReputationPolicy` ports. Consumer functions are held in an in-process class
registry and matched to durable class-version schema hashes before use;
functions never enter the Store. Public operations return typed outcomes and
delegate atomicity to the frozen Store domain commands. Policy and control flow
are deterministic for an ordered sequence of explicit port outputs; core never
reads entropy or clocks directly. The in-memory Store is the reference adapter,
not a second source of policy.

## Entry gate: contract-freeze-9 (review pending)

Planning against the executable revision-13 ports found that M2 could not
start without making routing policy adapter-owned or inventing unspecified
semantics. Revision 14 and the local `contract-freeze-3` tag completed the
separate `2026-08-06-muster-contract-freeze-3-m2-entry.md` amendment. It fixed:

- `Store.claimLease({ workerId, classIds, now })` both selects and constructs a
  lease but receives no prepared lease ID, expiry, class snapshot, candidate
  identity, diversity/exclusion snapshot, routing priority, or canary identity.
  Core has no candidate-listing Store surface from which to make that decision
  itself.
- Contribution-cap/slot enforcement and canary/audit assignment have no durable
  claim inputs or query surfaces, while `LeaseRecord`/`JobRecord` cannot retain
  canary identity or queue priority.
- Core-created lease and request identities have no frozen source or
  replay/collision ownership.
- Queue mode and class-health mutation cannot atomically fence enqueue/claim or
  become visible together with required emergency invalidation.
- `cost.leaseTtl(payload)` is an arbitrary function. Registration cannot prove
  its range fits the frozen TTL buckets or that every lease plus extension fits
  `maxInFlightLifetime`; the extension count/duration policy is not declared.
- Reserve charging is required to fail closed atomically, but the Store command
  receives no expected limit/config identity. A portable adapter cannot know
  which limit the core evaluated without an out-of-band duplicate policy copy.
- Agreement-fixture and oracle-negative-fixture completeness contain conditions
  that are not represented in fixture metadata and therefore cannot be checked
  mechanically as written.

The revision-14 port and fixtures made those choices explicit, but the first
Task-1 implementation trace found that no command can create or advance the
worker-routing snapshot and no command can initialize per-class health without
adapter-owned defaults. Revision 15 and the separate
`2026-08-06-muster-contract-freeze-4-store-bootstrap.md` amendment correct that
last bootstrap boundary. Task 1 may begin only from a clean, independently
reviewed `contract-freeze-4` tag; later contract changes still require a new
normative revision and freeze amendment.

The first Task-2 registration trace then found that agreement fixtures carried
no payload for the required validator/oracle calls and that the retrospective
audit floor named no configured projection. Revision 16 and the separate
`2026-08-06-muster-contract-freeze-5-registration-inputs.md` amendment bind a
schema-valid payload to each agreement fixture and make the weekly retrospective
audit projection explicit. Task 2 may resume only from the independently
reviewed `contract-freeze-5` tag.

The first Task-3 implementation trace then found that the atomic worker-state
transition returned too little identity for the plan's required per-lease audit
events and that the frozen event union had no lease-requeue member. Revision 17
and the separate
`2026-08-06-muster-contract-freeze-6-worker-requeue-audit.md` amendment add the
minimal Store outcome and audit event. Task 3 may begin only after independent
review and the local `contract-freeze-6` tag.

The first Task-3 runtime pass then found that probation named no configured
checked-success count or minimum enrollment age and worker scheduling named no
deterministic policy owner for slots or routing periods. Revision 18 and the
separate `2026-08-06-muster-contract-freeze-7-worker-control-policy.md`
amendment add that closed deployment-owned policy. Task 3 may resume only after
independent review and the local `contract-freeze-7` tag.

The first Task-4 runtime trace found that canary claims could neither persist
nor later retrieve the exact payload they send, and that the contribution rule
for coarse `no_work` had no atomic Store command. Revision 19 and the separate
`2026-08-07-muster-contract-freeze-8-lease-payload-accounting.md` amendment add
those minimal boundaries. Independent review and the local
`contract-freeze-8` tag are complete.

The first Task-5 implementation trace then found that invalid submission
settlement, contract-cutoff races, checked evidence atomicity, and durable
absorbing-split routing were not representable through the frozen Store.
Revision 20 and the separate
`2026-08-07-muster-contract-freeze-9-submission-settlement.md` amendment add
those minimal boundaries. Task 5 may begin only after independent review and
the local `contract-freeze-9` tag.

## Global constraints

- Revision 20 is the active proposed normative boundary. Its
  `contract-freeze-9` review and tag are pending, so Task 5 runtime work is
  blocked. The worker wire version is unchanged. Frozen exported types, tables,
  state machines, schemas, and fixtures are read-only after review.
- `muster-core` keeps exactly one runtime dependency and references no network,
  filesystem, environment, or model-inference API.
- Core sees only opaque `WorkerId`; raw OAuth issuer and subject fields stop at
  the future MCP adapter.
- Every job/result operation is keyed by `(jobId, collectionCycle)`. Lease
  expiry and abandonment stay in-cycle; result requeues increment the cycle and
  recompute `input_hash` from the exact stored payload and frozen schemas.
- Exact retries reproduce the original complete receipt. A reused id with a
  different canonical request conflicts.
- Action authorization is advisory to the trusted consumer. Core never
  executes effects.
- Tests drive frozen lifecycle, schema-conformance, golden-hash,
  prompt-injection, and Store-concurrency fixture IDs without rewriting their
  expected semantics.

## Task 1: Reference in-memory Store and Store conformance foundation

Create the in-memory Store and exported Store conformance harness before any
service that depends on durable behavior. Establish clone-on-read/write
isolation, deterministic reset/setup helpers, atomic command serialization, and
reusable fake-clock/identity inputs. Implement and pass the control-plane slice
needed by Tasks 2-3:

- class registration, lifecycle, and permit-epoch replay/conflict;
- worker enrollment/state persistence and atomic open-lease closure;
- versioned queue-mode and class-health reads/transitions, including emergency
  state plus invalidation atomicity;
- identifier uniqueness, replay, conflict, and losing-race behavior.

For Tasks 4-8, implement each remaining Store method and its conformance cases
before the service that consumes it. The harness then grows through job/payload
and cycle isolation; claim/extend/abandon/expiry; submission and decision;
authorization, reserve, and adjudication; ledger, health, invalidation, and
reputation. By the end of Task 8 every frozen Store method and Store-concurrency
fixture must pass the same exported suite a future Postgres adapter will use.

## Task 2: Runtime class registry and registration validation

Create a core-owned runtime registry for loaded `JobClass` definitions and a
registration service that:

- validates Muster Schema 1 payload/output schemas and their canonical hashes;
- rejects duplicate ids, malformed paths, missing schema paths, incomplete
  support/completeness-oracle coverage, invalid absence-domain coverage,
  missing action requirements, uncovered human review/effect paths, invalid
  negative fixtures, agreement-fixture failures, effect-fixture failures,
  reserve-floor violations, and incompatible adjudication policy;
- durably registers `(classId, contractVersion, payloadSchemaHash,
  outputSchemaHash)` as `draft`, with identical replay and digest conflict;
- initializes one core-prepared class-health snapshot for a new class and
  treats an existing snapshot as durable shared class state rather than
  resetting it for each contract version;
- requires the loaded runtime functions to match the durable hashes before
  enqueue, lease, verification, or authorization;
- returns all deterministic registration issues rather than failing at the
  first field.

Tests start with accepted minimal deterministic and human-only classes, then
cover each rejection family and durable replay/conflict behavior.

## Task 3: Contract lifecycle, permit epochs, and worker enrollment

- Implement forward-only class lifecycle transitions and exact replay.
- Enforce leasing/acceptance cutoffs for `draft`, `active`, `draining`, and
  `retired` class versions.
- Implement class-qualified permit-epoch initialization and ordinary
  compare-and-transition changes.
- Implement enrollment through `AdmissionHook`, immutable provider/capability
  recording, policy-derived slot assignment, contract acceptance, evidence- and
  age-gated probation, and the frozen worker state machine. Registration
  atomically persists the worker and its policy-prepared zero-usage contribution
  window/assigned-slot occurrence.
- Suspension/revocation must use the atomic Store transition, emit one worker
  state-change audit event, and emit one identity-bearing `lease_requeue` audit
  event for every requeued open lease.

## Task 4: Enqueue, routing, and lease lifecycle (complete 2026-08-07)

- Enqueue only active compatible class versions after precedence, health,
  reserve, schema, payload-size, and current-epoch checks.
- Compute `input_hash` from the exact sanitized payload plus both frozen schemas,
  class/version, policy version, and permit epoch; persist payload and job
  atomically through the Store boundary with the expected operational-state
  revisions.
- Select eligible workers by hard capabilities, contract acceptance,
  contribution cap, slot, exclusions, `notBefore`, class health, deterministic
  reputation eligibility/priority, and declared diversity axes.
- Compare-and-transition complete worker routing periods before claim whenever
  the deterministic contribution window or assigned-slot occurrence advances;
  never ask Store to derive either calendar.
- Implement replication targets, canary/audit assignment, coarse no-work
  outcomes, `IdSource`-allocated lease identity, quantized initial TTL, absolute
  in-flight deadlines, extension caps, lease snapshots, abandon classifications,
  expiry, and same-cycle requeue semantics.

## Task 5: Submission and cycle-scoped verification pipeline

- Collapse unknown, closed, wrong-holder, and expired lease disclosure to the
  frozen worker-wire refusal while retaining honest audit identity.
- Enforce input hash, body size, Muster Schema 1 output validation, consumer
  validators, prompt-injection data treatment, result hashing, and exact
  submission replay/conflict.
- Record fair-attempt and reputation evidence only for the frozen qualifying
  outcomes.
- Run support/completeness oracles and declared evidence requirements without
  allowing model advice or reputation to raise verification strength.
- Compute equivalence, replication targets, confidence-typed diversity, and
  absorbing splits per collection cycle. Persist verified decisions and hashes
  atomically; isolate old-cycle evidence after result requeues.

## Task 6: Escalation, adjudication, and invalidation

- Charge reserves idempotently by lane and enforce urgent fail-closed behavior,
  reserve floors, adjudication capacity, and dispute-requeue caps.
- Implement result/action adjudication open, exact verdict replay/conflict,
  authenticated verdicts, backlog timestamps, and terminal transitions.
- Apply the full precedence table through immutable invalidation snapshots and
  class-qualified compare-and-apply commands.
- Recompute one hash per requeued cycle, make emergency epoch withdrawal atomic,
  invalidate issued authorization validity, retain retrievable initial
  receipts, and emit every returned audit transition.

## Task 7: Action gates and replay-stable authorization

- Verify descriptor-bound `EffectIntent` hashes, action composition, exact
  `deriveEffect` byte identity, decision-result freshness, class/version/epoch,
  result strength, oracle evidence, human-review requirements, and action gate
  table rows.
- Evaluate every mapped action atomically and choose authorize, deny, or pend
  without partial authorization.
- Persist the complete initial receipt for exact replay; distinguish request-id
  conflict from effect-intent-id replay.
- Expose live authorization status so later invalidation cannot be mistaken for
  a still-valid initial receipt.

## Task 8: Capacity, class health, observability, and privacy

- Implement capacity projection, queue modes, multidimensional class health,
  starvation dwell, provider-offline signals, and the frozen precedence between
  intake, in-flight work, action requests, and reserve saturation.
- Use versioned operational-state transitions so stale refreshes cannot replace
  operator state and emergency refusal becomes visible atomically with required
  invalidation.
- Emit correlated notifications and append-only audit events for every public
  operation and atomic Store outcome.
- Apply `PrivacyClass` body/descriptor retention rules to ledger and consumer
  notifications while audit events remain hash-only.
- Keep reputation evidence idempotent and ordered; validate policy priority is
  finite and use it only as a routing tiebreaker.

## Task 9: Protocol conformance kit

Export a reusable suite that drives the public core operations through:

- frozen lifecycle and exact-retry cases;
- identifier uniqueness/replay and operational-state admission races;
- schema, oracle, agreement, action, absence, and effect fixtures;
- lease terminal states and disclosure-equivalent refusals;
- result/action adjudication and invalidation transitions;
- skill prompt-injection corpus treatment as untrusted data;
- deterministic fake-clock/event assertions and cross-cycle isolation.

Run the suite against the reference in-memory Store. The future MCP plan will
reuse the protocol-level expectations at its adapter boundary.

## Task 10: Full validation and independent review

Run frozen install, invariants, package typechecks, fixtures check, all tests,
builds, package-content inspection, Markdown fence/local-link checks, and
`git diff --check`. Review from revision-15 prose through public operations,
Store calls, events, fixture IDs, and conformance tests. Search specifically for
raw OAuth identity, direct I/O/entropy, unowned identifiers, unqualified
epochs/versions, non-quantized TTL bounds, mutable aliases, stale operational or
invalidation snapshots, partial target application, cross-cycle evidence,
non-finite reputation priority, model inference, and authorization paths that
bypass live validity.

## Delivery checkpoints

1. Tasks 1-3: reference Store foundation and class/worker control plane are
   executable and conformance-backed.
2. Tasks 4-5: one-shot lease/result path and its Store slices are
   conformance-backed.
3. Tasks 6-8: safety, authorization, and operations are complete.
4. Tasks 9-10: M2 is independently reviewed and ready for separate Postgres and
   MCP plans.

No checkpoint authorizes npm publication, a remote push, Postgres work, MCP
work, or integration into the first consumer without an explicit follow-up.
