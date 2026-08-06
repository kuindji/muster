# Muster contract-freeze-3 M2-entry amendment plan

**Status:** Complete in coordinator revision 14 and the local
`contract-freeze-3` tag. No runtime mechanics were added.

**Goal:** Amend the revision-13 core boundary into revision 14 so Milestone 2 is
implementable without moving routing, lease, operational-state, identity, or
reserve policy into Store adapters.

**Trigger:** The first Milestone 2 planning pass traced `lease_job`, class
registration, canary assignment, and reserve charging from normative prose to
the frozen `Store` surface. The current command shapes cannot express those
operations portably. Runtime implementation remains paused until this amendment
is complete.

**Scope:** Normative coordinator spec, `muster-core` port types, frozen
concurrency/lifecycle fixtures, compile-time tests, freeze metadata, and plans.
No runtime coordinator behavior, in-memory Store, Postgres, or MCP behavior.

## Finding 1: candidate selection and atomic claim have no shared boundary

The spec assigns authentication and candidate selection to core, followed by an
atomic Store claim. The frozen Store instead receives only `workerId`, a list of
class IDs, and `now`, and must return a fully formed lease. That input cannot
carry the core-selected job/cycle, lease ID, expiry, byte ceilings, permit and
contract snapshot, exclusion/diversity expectation, or canary/audit identity.
There is also no Store operation that lets core read claimable candidates.

Amend the boundary so core reads immutable candidate snapshots, performs all
policy evaluation, then submits one fully prepared lease plus the expected
candidate snapshot to a compare-and-claim command. The Store must atomically
reject a stale/unclaimable snapshot and must never rank jobs or run consumer
policy. Add race fixtures for one winner, worker/job exclusion, cycle changes,
and stale snapshots.

## Finding 2: core-created identifier ownership is unspecified

The amended claim requires core to prepare `leaseId`, and later mechanics create
result-adjudication, authorization-request, and reputation-evidence identities.
The deterministic core has no identifier source, and deriving an ID from
`Clock.now()` cannot guarantee uniqueness under concurrent calls. Leaving this
to each runtime service would make replay and collision behavior adapter-owned.

Freeze an injected `IdSource` port with a closed `CoreIdentityKind` enum. Core
requests an opaque ID before submitting a prepared domain command; the Store
enforces uniqueness and persists the winning identity atomically. Exact replay
returns the persisted identity, a conflict never replaces it, and an ID consumed
by a losing stale-snapshot race may be skipped but must not leave durable state.
Tests use a deterministic source. Enumerate every identity as caller-supplied,
content-derived, or `IdSource`-allocated so no implementation invents a fourth
model. IDs never affect routing priority or enter `input_hash` unless already
part of a frozen hash envelope.

## Finding 3: routing and canary facts are not durable

Contribution-cap usage, assigned-slot occurrence, queue priority, canary/audit
kind and identity, and accepted-worker diversity determine claim eligibility or
later reputation, but the current records and read surfaces cannot reconstruct
them.

Freeze the minimal hash-free operational records/queries required for core to
evaluate those facts. Canary records bind `canaryId`, `sourceJobId`, source
contract version, assignment kind, and expected-result hash without exposing
raw OAuth identity. Queue priority and attempt accounting must be explicit,
cycle-scoped where applicable, and deterministic under replay.

## Finding 4: queue and class operational state cannot change atomically

M2 must enforce queue modes, multidimensional class health, and precedence, but
the Store has no queue-mode record and only independent class-health get/set
methods. An emergency halt can therefore race enqueue or claim, and a stale
health refresh can overwrite a newer operator halt. Updating operational state
separately from invalidating affected results also leaves an observable window
where one side of the halt is visible without the other.

Freeze durable versioned queue-mode and class-health snapshots and define which
field owns each admission, degraded-mode, reserve, and emergency condition.
Prepared enqueue and claim commands carry the expected operational revisions and
fail on a stale or refusing state. Ordinary refreshes use compare-and-transition
rather than blind replacement. Entering an emergency halt carries the expected
operational transition and complete invalidation snapshot in one Store domain
command, so refusal of new work, affected result/request transitions, and issued
authorization invalidation become visible together. Add halt-versus-enqueue,
halt-versus-claim, stale-refresh-versus-operator-halt, and queue-versus-class
precedence races.

## Finding 5: lease bounds are not mechanically registrable

`cost.leaseTtl(payload)` has no declared upper bound, while registration is
required to reject TTL bucket overflow and prove that a lease plus all
extensions fits `maxInFlightLifetime`. Neither maximum TTL nor extension policy
is represented.

Choose and freeze one implementable ownership model. The recommended model is:

- add a declared positive `maxLeaseTtl` to class cost policy;
- keep `leaseTtl(payload)` but reject non-finite/non-positive values or values
  above `maxLeaseTtl` at enqueue;
- place positive `extensionTtl` and non-negative integer
  `maxExtensionsPerLease` in explicit core deployment policy;
- registration computes `maxInitialLeaseTtl = bucketFor(maxLeaseTtl,
  TTL_BUCKETS_SECONDS)`, rejects a missing bucket, and requires
  `maxInitialLeaseTtl + extensionTtl * maxExtensionsPerLease <
  maxInFlightLifetime`, preserving the normative strict upper bound after
  quantization;
- the prepared atomic-claim command carries the quantized initial expiry and
  frozen extension snapshot used by later extension commands, including the
  absolute in-flight deadline; every extended expiry must remain strictly before
  that deadline.

If deployment policy varies by class, bind its version at registration/enqueue
and include it in the operational record. It does not enter `input_hash` unless
the normative threat model is deliberately changed.

## Finding 6: reserve limits are duplicated or missing at the atomic boundary

`chargeReserve` and authorization/adjudication domain commands must decide the
last-unit race inside the Store transaction. `ReserveCharge` carries identity
but no expected limit or version, so an adapter can only decide by duplicating
mutable JobClass policy out of band.

Amend charge-bearing commands to carry the class-qualified lane limit and its
policy-version snapshot, and require the Store to compare them to the durable
window/accounting identity before applying. Define rollover identity and the
per-worker quota inputs explicitly. Add changed-policy and last-unit races to
the frozen concurrency pack.

## Finding 7: fixture completeness claims exceed fixture metadata

Registration can run agreement and oracle fixtures, but it cannot infer whether
`resolveEquivalent` can normalize distinct representations, nor can it prove an
unlabelled negative fixture represents every predicate's out-of-domain and
unsupported/omitted-material families.

Make the contract mechanical: whenever agreement exists, require at least one
split fixture and at least one equivalent fixture containing two or more
JCS-distinct result representations that map to one equivalence key. The latter
must run `resolveEquivalent` and validate its output through the frozen schema,
validators, oracles, and equivalence-key check. Add a frozen category plus
predicate binding to oracle negative fixtures. Registration still treats these
as checked consumer evidence, not proof of real-world semantics.

## Task sequence

1. Amend the normative prose to revision 14 and add an explicit M2-entry
   coverage map.
2. Amend frozen identity, operational-state, class, lease, candidate, attempt,
   canary, and reserve types and Store commands; keep core's
   one-dependency/no-direct-I/O/raw-identity invariants green.
3. Extend lifecycle and Store-concurrency fixture IDs and reject malformed new
   fields rather than silently ignoring them.
4. Add compile-time and fixture tests proving core owns selection and identity
   allocation, while Store owns uniqueness, compare-and-claim, operational-state
   transitions, and transaction atomicity rather than policy.
5. Update wire version only if a worker-visible schema or hash envelope changes;
   otherwise document why the wire remains `1.1.0` while the core package
   contract changes.
6. Run the full validation matrix, independently review prose -> ports ->
   fixtures -> tests, commit the reviewed boundary, and tag
   `contract-freeze-3`. Do not push or publish.

## Exit criteria

- A core implementation can compute every lease field before atomic claim.
- Every core-created identifier has one frozen source and replay/collision rule.
- Queue/class emergency state cannot race admission or become visible separately
  from its required invalidation transitions.
- A Store adapter can pass conformance without loading JobClass functions or
  reimplementing routing, diversity, TTL, canary, health, or reserve policy.
- Registration checks every declared bound using finite, quantized data.
- Every new race or replay rule has one frozen fixture ID and an executable
  shape validator.
- No runtime mechanics have been implemented, the full repository is green,
  and `contract-freeze-3` points at the reviewed commit.
