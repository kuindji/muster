# Muster contract-freeze-11 action-authorization amendment plan

**Status:** Proposed by the first M2 Task-7 runtime trace. Action-gate
evaluation and authorization remain paused until this amendment is independently
reviewed, corrected, implemented, and tagged locally as `contract-freeze-11`.

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

## Finding 1: authorization persistence is not fenced by live result state

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
cycle, current logical-job record, live result state, and class-version record.
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

## Finding 2: one optional charge cannot represent a composite intent

The specification requires every mapped action gate to pass atomically and
keeps low-cost, urgent, and split-and-adjudication reserves non-borrowable.
`authorizeOrReplayIntent` nevertheless accepts only one `ReserveCharge`.
An intent may legitimately combine `routeToHumanLowCost`, an urgent-lane
action, and a `human_only` action. Picking one "strongest" lane silently skips
the other independent capacity controls; charging before the authorization
command permits partial debit if a later lane or gate fails.

Replace the optional singular authorization charge with a canonical charge set:

- one low-cost charge when any mapped action uses the low-cost lane;
- one urgent charge when any mapped action uses the urgent lane;
- one split-and-adjudication charge when any mapped permit is `human_only`;
- no duplicate charge when several actions share a lane;
- no audit charge, which is never action-request-owned.

Charges are ordered by the frozen lane order, use one lane-qualified charge key
per authorization request, and settle as one domain transaction. Core first
validates every installed policy and charge-key replay. A missing/stale policy
or changed charge input rejects the complete request with no debit. Low-cost or
urgent exhaustion produces the existing terminal
`escalation_budget_exhausted` receipt and debits no other new lane. The batch
preflights every lane before mutation: it durably records each applicable
fail-closed exhausted disposition, but it neither claims nor records a charge
key for a capacity-available lane that the terminal denial skips. Exhausted
split-and-adjudication capacity still creates one uncovered pending request, as
already specified, but any simultaneously applicable low-cost or urgent charge
must succeed in the same transaction. Exact intent replay returns the original
receipt and correlated charged, exhausted, and skipped lane dispositions
without settling again.

Per-worker quota attribution is also made closed. For an automatically resolved
decision, each low-cost or urgent charge contains the canonically sorted unique
workers in the decision evidence. For a human-resolved result, those lanes
carry no worker IDs because the result verdict may have established that only a
subset of candidate evidence was false; class capacity still charges once per
applicable lane. Split-and-adjudication charges are never worker-qualified.

## Finding 3: verdict replay occurs too late in the core call path

The in-memory Store records enough information to replay a verdict before
terminal-state checks, but the public Store surface exposes no verdict-history
read. `AdjudicationService` must currently reload the job and runtime class,
re-run result verification or action-permit checks, and construct the derived
decision or authorization before it can call the replaying Store command.
After registry unload, class retirement, invalidation, or lifetime expiry, an
exact retry can therefore return `runtime_mismatch`, `binding_conflict`, or a
freshness refusal instead of its byte-identical durable receipt.

Freeze a read-only verdict-history lookup returning the request ID, verdict
hash, canonical verdict, and immutable `VerdictReceipt`. Core authenticates,
canonicalizes, and hashes the supplied human verdict, then checks this history
before any runtime, parent-state, cutoff, or gate evaluation. Canonical equality
replays the receipt; a different verdict for the same request is
`verdict_conflict`. Only a first verdict continues to current validation and
the compare-and-apply Store command. This applies equally to result and action
adjudication.

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
  intent or first action verdict can authorize;
- a class-version transition racing authorization either follows the complete
  old eligible state or rejects against the new state;
- a composite intent settles every applicable reserve lane once, in canonical
  order, without duplicate charges for two actions in one lane;
- missing/stale policy, charge-key conflict, and low-cost or urgent exhaustion
  leave every other new lane, identity, receipt, and pending request unchanged;
- uncovered split-and-adjudication capacity persists one pending mixed intent
  with the complete correlated multi-lane charge result;
- automatic decisions attribute low-cost and urgent quotas to sorted unique
  evidence workers, while human-resolved decisions charge class capacity with
  no per-worker attribution;
- exact result- and action-verdict retries replay after invalidation, contract
  expiry, registry unload, and class retirement without rerunning consumer
  functions;
- mixed automatic plus human-only intents bind only the human review subset,
  recheck every automatic gate on first approval, and issue one all-actions
  authorization or none;
- action approval racing invalidation yields one terminal winner and cannot
  resurrect a superseded, expired, or cancelled request.

## Independent review trace

| Path | Frozen comparison and atomic publication | No-change outcomes | Executable identity |
|---|---|---|---|
| New automatic intent | Decision, current job cycle, verified state, class version, intent and authorization IDs, all gates, all charges | exact receipt replay, intent conflict, stale/ineligible context, policy or charge conflict | `authorization-vs-invalidation-single-winner`, `authorization-context-change-fails-closed` |
| Composite reserves | Canonical per-lane charge set, usage, worker quotas, lane health, one receipt | missing/stale policy, changed key input, any fail-closed lane exhaustion | `composite-reserve-charges-atomic`, `composite-reserve-exhaustion-no-partial-debit` |
| Human-only or mixed intent | Complete intent, human-review subset, automatic gates, pending status, split-lane charge | exact initial-receipt replay, uncovered pending state, runtime mismatch | `mixed-action-intent-binds-human-subset` |
| First action verdict | Verdict binding, pending request, parent result, current cycle and class version, automatic recheck, authorization | unauthenticated, binding conflict, freshness conflict, terminal race | `action-verdict-vs-invalidation-single-winner` |
| Verdict retry | Authenticated canonical verdict hash and immutable receipt | exact replay or verdict conflict before runtime/freshness checks | `verdict-replay-precedes-runtime-and-freshness` |
| Time cutoff | One captured processing timestamp, accepted-until record, cycle start and frozen maximum lifetime | exact prior replay; otherwise atomic invalidation before refusal | `authorization-cutoff-retires-before-new-intent` |

## Exit gate

Amend the normative coordinator spec before changing the frozen package. Update
the core port types, in-memory Store, compile-time tests, lifecycle fixtures,
Store-concurrency IDs, reusable Store conformance suite, M2 plan, README, and
changelog together. Run frozen install, invariants, contract/core typechecks and
tests, builds, fixture checks, package-content inspection, Markdown
fence/local-link checks, and `git diff --check`. Independently trace both
invalidation interleavings, every composite reserve combination, first versus
replayed verdict processing, mixed permit modes, contract expiry, and maximum
in-flight expiry. Tag only the reviewed and corrected contract commit as
`contract-freeze-11`; that tag authorizes M2 Task 7 runtime implementation.

Worker wire version `1.1.0`, MCP schemas, hash envelopes, effect-intent and
verdict wire shapes, action tables, consumer-visible error codes, and the
trusted-consumer effect boundary remain unchanged.
