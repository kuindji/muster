# Muster contract-freeze-11 action-authorization amendment plan

**Status:** Independently reviewed and corrected after the first M2 Task-7
runtime trace. Action-gate evaluation and authorization remain paused until this
amendment is implemented and tagged locally as `contract-freeze-11`.

**Goal:** Amend revision 21 so a new effect intent can be authorized only while
its exact decision result remains live, every reserve lane used by a composite
intent settles in one atomic transaction, and exact verdict retries remain
replayable before mutable runtime and freshness checks.

**Trigger:** The frozen Task-7 Store surface can persist one authorization and
one optional reserve charge, but it does not compare the decision result's live
state when the authorization commits. It also cannot represent an intent that
contains actions from multiple non-borrowable reserve lanes. Finally, the
verdict Store commands replay correctly, but core cannot discover that replay
until after it reloads runtime functions and re-evaluates current bindings. A
lost response can therefore stop being retryable after invalidation, contract
expiry, maximum-lifetime expiry, or runtime unload even though the durable
verdict receipt still exists.

## Finding 1: authorization and first-verdict persistence are not fully fenced

`authorizeOrReplayIntent` verifies only that the named
`DecisionResultRecord` exists. It does not compare the parent result state,
current logical-job cycle, or class-version lifecycle record. If invalidation
wins immediately before a new authorization call, the decision record remains
historically retrievable and the current Store command can still create a
fresh valid authorization from a cancelled, superseded, or expired result.
If authorization wins first, invalidation correctly marks it invalid. The
opposite interleaving is the missing half of the atomic contract.

Freeze an immutable authorization-context snapshot keyed by
`decisionResultHash`. It contains the complete decision record, parent job
cycle, current logical-job record, live result state, class-version record, and
the absolute maximum-in-flight deadline that core computed from the stored
`cycleStartedAt` and loaded class policy. Store persists that operational
deadline with a pending authorization context; it does not enter the wire
request, verdict hash, or authorization. This lets a later human rejection
enforce freshness without reloading consumer functions.
The current job must still name the decision's collection cycle; retaining the
historical cycle record after a result-level requeue is not eligibility. A new
`authorizeOrReplayIntent` compares that expected snapshot in the same
transaction that claims the effect-intent and authorization-request identities,
settles reserves, and persists the initial receipt. Exact effect-intent replay
still precedes the comparison. A new request proceeds only from the exact
current `verified` cycle and a non-retired class version whose acceptance
cutoff has not passed. A stale or ineligible snapshot changes no identity,
charge, receipt, status, or backlog.

Core still owns time and policy. It computes maximum in-flight expiry from the
stored `cycleStartedAt` and the loaded class's frozen
`maxInFlightLifetime`. When contract or maximum-lifetime expiry is already due,
core first applies the existing class-qualified invalidation command and
returns the frozen no-identity consumer refusal. When the request is eligible
at its single captured `Clock.now()` value, the Store comparison excludes a
concurrent operator, emergency, epoch-withdrawal, class-version, or cycle
transition before commit.

The frozen consumer result for a decision that is unavailable to a new intent
remains `intent_invalid`, matching
`retire-verified-before-second-intent`; the new Store outcome preserves the
precise stale or ineligible reason for core audit without adding a public
consumer error code.

The same freshness rule applies while an action verdict is pending. A first
human verdict may authorize only if the pending request and its parent result
remain live at processing time. The verdict's authenticated `decidedAt` remains
part of its canonical hash and receipt; it cannot be used to backdate a verdict
through a later contract or maximum-lifetime cutoff.

A first result-adjudication verdict needs the equivalent fence. The current
Store command compares the pending result state, so explicit invalidation and
verdict application already have one winner, but core does not materialize a
contract or maximum-lifetime expiry that became due before the verdict call.
Both resolution and rejection would therefore remain able to transition an
overdue request when no invalidation caller happened to run first. After exact
verdict-history replay, a first result verdict compares the complete pending
request, current logical-job cycle, live result state, and class-version record.
When the processing-time cutoff is due, core first applies the existing
class-qualified invalidation command and returns the terminal/freshness outcome;
it neither resolves the old cycle nor creates a backdated replacement cycle.

A first action rejection does not need runtime functions or automatic-gate
evaluation, but it still compares the stored request binding, persisted
authorization context and deadline, class-version record, and pending state at
`processedAt` while that context is eligible. If a cutoff is due, core does not
apply the rejection: it takes the existing invalidation path and fails closed
if runtime data needed to prepare that invalidation is unavailable. The
rejection loses a concurrent invalidation race and cannot replace an already
expired, superseded, or cancelled status with `human_rejected`.

## Finding 2: verdict decision time is not processing time

`ActionAdjudicationVerdict.decidedAt` and
`ResultAdjudicationVerdict.decidedAt` are authenticated human assertions. They
belong to the canonical verdict hash and immutable `VerdictReceipt`, but they
cannot be the coordinator's freshness clock. The current port's singular `at`
encourages core and Store adapters to use a backdated verdict timestamp for
cutoff eligibility, durable state transitions, `verifiedAt`, or a replacement
cycle's `cycleStartedAt`.

Freeze a distinct core-owned `processedAt` on both first-verdict Store
commands. After authentication, canonicalization, hashing, and verdict-history
lookup show that this is a first verdict, core captures `Clock.now()` exactly
once. The signed `decidedAt` remains byte-identical in the verdict and receipt;
`processedAt` controls freshness comparison, invalidation, newly persisted
result/request transitions, `DecisionResultRecord.verifiedAt`, replacement
`cycleStartedAt`, and audit/state-change event time. Store adapters do not
require `decidedAt === processedAt` and cannot derive processing time.

The time boundaries are exact. A draining contract accepts a first verdict or
new intent at `processedAt <= acceptedUntil` and is expired after that instant.
Maximum in-flight lifetime is half-open: work is eligible only while
`processedAt < cycleStartedAt + maxInFlightLifetime`; equality is already
expired. Active versions have no acceptance cutoff, and retired versions are
ineligible regardless of timestamp. Exact intent and verdict replay precedes
these current-time rules.

## Finding 3: one optional charge cannot represent a composite intent

The specification requires every mapped action gate to pass atomically and
keeps low-cost, urgent, and split-and-adjudication reserves non-borrowable.
`authorizeOrReplayIntent` nevertheless accepts only one `ReserveCharge`.
An intent may legitimately combine `routeToHumanLowCost`, an urgent-lane
action, and a `human_only` action. Picking one "strongest" lane silently skips
the other independent capacity controls; charging before the authorization
command permits partial debit if a later lane or gate fails.

Replace the optional singular authorization charge with a canonical charge set.
The authorization-owned lanes and their exact executable order are:

```ts
type AuthorizationReserveLane =
  | 'lowCost'
  | 'urgent'
  | 'splitAndAdjudication'

const AUTHORIZATION_RESERVE_LANE_ORDER = [
  'lowCost',
  'urgent',
  'splitAndAdjudication',
] as const

interface AuthorizationReserveSettlement {
  lane: AuthorizationReserveLane
  charge: ReserveChargeRecord
  currentPolicy: ReservePolicyRecord
}

interface AuthorizationReserveBatchResult {
  settlements: readonly AuthorizationReserveSettlement[]
  skippedLanes: readonly AuthorizationReserveLane[]
  classHealth: ClassHealthSnapshot
}
```

The batch contains:

- one low-cost charge when any mapped action uses the low-cost lane;
- one urgent charge when any mapped action uses the urgent lane;
- one split-and-adjudication charge when any mapped permit is `human_only`;
- no duplicate charge when several actions share a lane;
- no audit charge, which is never action-request-owned.

Each applicable charge uses
`<authorizationRequestId>:<lane>` as its lane-qualified charge key. The Store
accepts charges only in `AUTHORIZATION_RESERVE_LANE_ORDER` with no duplicate or
extraneous lane. It returns one aggregate authorization-reserve result: the
ordered durable `charged` or `exhausted` charge records, the ordered lanes
skipped without a charge record, each settled lane's resulting policy record,
and one final `ClassHealthSnapshot` after the atomic batch. Intermediate health
revisions are not observable as separate domain outcomes. Exact intent replay
returns the original receipt and this complete stored aggregate without
settling again.

An applied or replayed authorization outcome carries `reserveBatch` whenever
the intent has at least one applicable authorization reserve lane and omits it
otherwise. A batch charge conflict identifies the existing charge record; a
batch policy conflict identifies the requested lane and current nullable policy
record. If more than one preflight conflict exists, the first lane in
`AUTHORIZATION_RESERVE_LANE_ORDER` is returned deterministically. Every
conflict is a top-level no-change outcome, never a partial batch.

The Store first validates every installed policy and every existing charge-key
replay, then preflights all lane capacity before mutation. A missing/stale
policy or changed charge input rejects the complete request and changes no
charge, identity, receipt, status, health, or backlog. If any applicable
low-cost or urgent lane is exhausted, the transaction durably records every
applicable exhausted fail-closed lane, claims the effect-intent and
authorization-request identities, and persists the immutable terminal
`escalation_budget_exhausted` receipt. It records no successful charge and opens
no pending request; every otherwise available lane, and the
split-and-adjudication lane, is reported `skipped` with no charge key. If both
fail-closed lanes are exhausted, both exhausted dispositions are durable.

Only when every applicable low-cost and urgent lane has capacity may the batch
charge those lanes and reach split-and-adjudication. Exhausted
split-and-adjudication capacity then creates one uncovered pending request, as
already specified, in the same transaction as the successful low-cost and
urgent charges. A covered split lane creates the same pending request with a
charged disposition. With no human-only permit, successful applicable
low-cost/urgent charges and automatic authorization publish atomically.

Per-worker quota attribution is also made closed. For an automatically resolved
decision, each low-cost or urgent charge contains the canonically sorted unique
workers in the decision evidence. For a human-resolved result, those lanes
carry no worker IDs because the result verdict may have established that only a
subset of candidate evidence was false; class capacity still charges once per
applicable lane. Split-and-adjudication charges are never worker-qualified.

## Finding 4: verdict replay occurs too late in the core call path

The in-memory Store records enough information to replay a verdict before
terminal-state checks, but the public Store surface exposes no verdict-history
read. `AdjudicationService` must currently reload the job and runtime class,
re-run result verification or action-permit checks, and construct the derived
decision or authorization before it can call the replaying Store command.
After registry unload, class retirement, invalidation, or lifetime expiry, an
exact retry can therefore return `runtime_mismatch`, `binding_conflict`, or a
freshness refusal instead of its byte-identical durable receipt.

Freeze a read-only verdict-history lookup returning the request kind
(`result` or `action`), request ID, verdict hash, complete canonical verdict,
and immutable `VerdictReceipt`. Core authenticates, canonicalizes, and hashes
the supplied human verdict, then checks this history before any runtime,
parent-state, cutoff, clock capture, or gate evaluation. Canonical equality
replays the receipt; a different verdict or request kind for the same request
is `verdict_conflict`. Only a first verdict captures `processedAt` and continues
to current validation and the compare-and-apply Store command. This applies
equally to result and action adjudication.

The first action approval supports a mixed intent: `humanReviews` must equal
the human-only subset in canonical action order, while every automatic permit
is rechecked against the stored payload and decision result. A runtime mismatch
or failed automatic recheck leaves the human request pending and emits no
authorization. A human rejection remains the terminal `human_rejected`
outcome and, after its stored request binding is checked, does not require
runtime functions or automatic-gate evaluation. No contract shape change is
needed for the mixed-mode request itself; the amendment makes its processing
and replay order executable.

## Required executable coverage

- invalidation racing a new authorization yields either an authorization that
  the same invalidation marks invalid or a no-change authorization-context
  conflict; a valid authorization never appears after the result is terminal;
- an old decision record from a requeued cycle cannot authorize a fresh intent,
  while its exact historical effect-intent retry still replays;
- contract and maximum-in-flight expiry retire the parent result before a new
  intent, first result verdict, or first action verdict can transition it;
- `decidedAt` remains in the verdict and receipt while one independently
  captured `processedAt` governs freshness, durable transition timestamps,
  `verifiedAt`, and replacement-cycle start;
- contract-cutoff equality remains eligible, while maximum-lifetime equality
  is expired;
- a class-version transition racing authorization either follows the complete
  old eligible state or rejects against the new state;
- a composite intent settles every applicable reserve lane once, in canonical
  order, without duplicate charges for two actions in one lane;
- missing/stale policy and charge-key conflict leave every lane, identity,
  receipt, status, health, and pending request unchanged;
- low-cost or urgent exhaustion persists one terminal intent identity and
  denial receipt plus every applicable exhausted fail-closed disposition, while
  recording no successful charge or pending request and marking every
  unattempted lane skipped;
- uncovered split-and-adjudication capacity persists one pending mixed intent
  with the complete correlated multi-lane charge result;
- automatic decisions attribute low-cost and urgent quotas to sorted unique
  evidence workers, while human-resolved decisions charge class capacity with
  no per-worker attribution;
- exact result- and action-verdict retries replay after invalidation, contract
  expiry, registry unload, and class retirement without rerunning consumer
  functions;
- first result verdicts racing invalidation or arriving after a time cutoff
  cannot resolve, reject, or requeue the terminal old cycle;
- an otherwise eligible first action rejection uses its persisted
  context/deadline after registry unload, but still loses to a due cutoff or
  concurrent invalidation;
- mixed automatic plus human-only intents bind only the human review subset,
  recheck every automatic gate on first approval, and issue one all-actions
  authorization or none;
- action approval racing invalidation yields one terminal winner and cannot
  resurrect a superseded, expired, or cancelled request.

## Independent review trace

| Path | Frozen comparison and atomic publication | No-change outcomes | Executable identity |
|---|---|---|---|
| New automatic intent | Decision, current job cycle, verified state, class version, intent and authorization IDs, all gates, all charges | exact receipt replay, intent conflict, stale/ineligible context, policy or charge conflict | `authorization-vs-invalidation-single-winner`, `authorization-context-change-fails-closed` |
| Composite reserves | Exact lane order and keys, per-lane usage/worker quotas, durable settlements, skipped lanes, final health, one receipt | missing/stale policy or changed key input changes nothing; fail-closed exhaustion persists only exhausted dispositions and terminal denial | `composite-reserve-charges-atomic`, `composite-reserve-exhaustion-no-partial-debit` |
| Human-only or mixed intent | Complete intent, human-review subset, automatic gates, pending status, split-lane charge | exact initial-receipt replay, uncovered pending state, runtime mismatch | `mixed-action-intent-binds-human-subset` |
| First action verdict | Verdict binding, pending request, parent result, current cycle and class version, automatic recheck, authorization | unauthenticated, binding conflict, freshness conflict, terminal race | `action-verdict-vs-invalidation-single-winner` |
| First result verdict | Verdict binding, pending request, current job cycle/state and class version, processing time, resolved decision or bounded requeue | unauthenticated, binding/freshness conflict, terminal race | `result-verdict-vs-invalidation-single-winner`, `result-verdict-cutoff-retires-before-transition` |
| Verdict retry | Authenticated canonical verdict kind/hash/value and immutable receipt | exact replay or verdict conflict before clock/runtime/freshness checks | `verdict-replay-precedes-runtime-and-freshness` |
| Time cutoff | Signed decision time plus distinct processing time, inclusive accepted-until record, half-open maximum lifetime | exact prior replay; otherwise atomic invalidation before refusal | `authorization-cutoff-retires-before-new-intent`, `verdict-processing-time-cannot-be-backdated` |

## Exit gate

Amend the normative coordinator spec before changing the frozen package. Update
the core port types, in-memory Store, `AdjudicationService`, their focused and
compile-time tests, lifecycle fixtures, Store-concurrency IDs, reusable Store
conformance suite, M2 plan, README, and changelog together. Result-verdict
replay and freshness are existing Task-6 behavior and must be corrected before
the tag rather than deferred to Task 7. Run frozen install, invariants,
contract/core typechecks and tests, builds, fixture checks, package-content
inspection, Markdown
fence/local-link checks, and `git diff --check`. Independently trace both
invalidation interleavings for new intents and both first-verdict paths, every
composite reserve combination and aggregate outcome, signed decision time versus
processing time, first versus replayed verdict processing, mixed permit modes,
contract expiry, and maximum in-flight expiry. Tag only the reviewed and
corrected contract commit as
`contract-freeze-11`; that tag authorizes M2 Task 7 runtime implementation.

Worker wire version `1.1.0`, MCP schemas, hash envelopes, effect-intent and
verdict wire shapes, action tables, consumer-visible error codes, and the
trusted-consumer effect boundary remain unchanged.
