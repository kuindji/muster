# Muster contract-freeze-10 reserve-accounting amendment plan

**Status:** Independently reviewed and corrected; implemented as coordinator
revision 21 and tagged locally as `contract-freeze-10`. M2 Task 6 may resume.

**Goal:** Amend revision 20 so reserve policy is an authoritative durable
control-plane record, every charge publishes its accounting and class-health
effect atomically, and result-adjudication request identity collisions have a
typed fail-closed outcome before Task 6 runtime behavior is implemented.

**Trigger:** The frozen Task-6 Store surface says a charge compares its
`ReservePolicySnapshot` with the durable current policy and rollover window,
but exposes no command that can install, advance, or replace that authoritative
record. A Store that adopts the first charge as current can let a stale policy
win its race, cannot distinguish a legitimate same-window limit change, and
cannot clear saturated health when a window rolls before another charge.
Additionally, standalone charges carry no charge timestamp with which to stamp
an atomic class-health transition. The current outcomes also cannot represent
all required no-change cases: charge-key reuse with changed input, stale policy
on a charge-bearing authorization/adjudication command, or an IdSource
collision while opening a result-adjudication request.

## Finding 1: reserve policy has no authoritative lifecycle

`ReservePolicySnapshot` is presently only an assertion attached to a charge.
There is no durable compare-and-transition surface that makes one policy
version/window authoritative before requests start spending it. Inferring
authority from charge arrival order violates the existing
`reserve-policy-change-race-fails-closed` fixture: a stale in-flight charge may
arrive before the first charge under the new policy and become indistinguishable
from the intended current configuration.

Freeze a class-, contract-version-, and lane-qualified reserve-policy record
with a Store-owned revision and update timestamp. Add read, initialize, and
compare-and-transition commands. A transition within one window retains usage;
a transition to a new explicit window resets usage for that policy record.
Exact old charge replays remain historical and do not debit the new window.
Stale expected records conflict without changing policy, accounting, or health.
The Store still derives no calendar and imports no `JobClass` functions.

Independent review added two safety constraints. Installing a zero-capacity
record must publish saturation immediately rather than waiting for a failed
charge. A changed window must move forward without overlap and must not reuse a
prior window identity; otherwise a controller could roll backward repeatedly
to reset usage. Same-window changes retain their original boundaries.

## Finding 2: accounting and reserve health can become observably inconsistent

The last successful unit makes a lane saturated, while an exhausted attempt
must leave result/action adjudication pending or atomically deny an urgent or
low-cost authorization. Updating `ClassHealth.reserves` afterward through
`transitionClassHealth` leaves an enqueue race in which accounting is exhausted
but health still reports `available`. Conversely, a rolled window cannot make a
saturated lane available until an unrelated charge happens, so intake may stay
closed indefinitely.

Every charge-bearing Store command must compare the installed policy, apply or
refuse the idempotent charge, persist its authorization/adjudication state, and
publish the resulting reserve-health value in one transaction. Standalone
`chargeReserve` must do the same. Add the explicit charge timestamp needed for
the class-health snapshot. Reserve-policy transition recomputes only its lane;
clearing one lane never clears another, and a class lane remains saturated
while any applicable non-retired class-version policy record for that lane is
saturated.

Independent review also found both ways that derivation could drift after this
amendment. Generic class-health and emergency-halt transitions must preserve
accounting-owned reserve lanes. Transitioning a class version to `retired` must
atomically exclude its policy records and recompute only affected lanes, or a
retired saturated version can leave intake closed indefinitely.

## Finding 3: charge replay/conflict outcomes are incomplete

An exact `chargeKey` replay must return the original charged or exhausted
outcome without spending twice. Reusing the key with different workers, lane,
policy, window, or limits is a charge conflict, not a replay and not a policy
change. A retry may supply a later call timestamp; the first persisted timestamp
remains authoritative and replays. The current `ReserveChargeOutcome` has no
such conflict arm.

Likewise, `openResultAdjudication` and `authorizeOrReplayIntent` can encounter a
stale/missing installed policy. The normative rule says `reserve_policy_conflict`
changes nothing, but neither command can currently return it distinctly.
Independent review removed `chargeOk?: boolean`: it cannot represent policy
conflict, charge conflict, original disposition on replay, or the resulting
health revision. Add correlated typed outcomes that preserve:

- authorization/effect-intent conflict;
- result-adjudication request identity conflict;
- reserve charge-key conflict;
- reserve policy/window conflict with the current nullable identity;
- charged versus exhausted behavior;
- exact replay of the already persisted domain outcome.

## Finding 4: result-adjudication request ID collision is unrepresentable

`result_adjudication_request` is an `IdSource` identity and Store is required to
enforce global core-identity uniqueness. `openResultAdjudication` currently has
only opened, replayed, and result-state-conflict outcomes. If the prepared ID is
already durable for another core identity or a different request, the Store
cannot report the required identity conflict without mislabeling the parent
result state.

Add an explicit identity-conflict outcome. Exact request replay still wins
before parent terminal-state checks; a different request or other core identity
using the same ID changes nothing. Concurrent different request IDs for one
collecting cycle still produce one open request and one result-state conflict.

## Required executable coverage

- reserve policy initialization replays identical input and conflicts on a
  changed snapshot without replacement;
- a policy transition racing a stale charge either admits the charge under the
  old record before the complete transition or rejects it afterward, never
  debiting a new window under old limits;
- two distinct charges racing for the final unit yield one charge and one
  exhaustion, and the saturated class-health revision is visible atomically
  with the winning outcome;
- a new explicit window resets only that policy record's usage and clears only
  the affected health lane when every applicable record has capacity;
- a zero-limit installation saturates its lane atomically, and an older,
  overlapping, or reused changed window cannot reset usage;
- exact charged and exhausted charge-key replays preserve their original
  outcome, while changed input under one key conflicts;
- standalone, result-adjudication, and authorization charges all reject a
  missing/stale installed policy without creating a request, receipt, verdict,
  ledger entry, or health change;
- exhausted split/adjudication charges still open one pending request and mark
  the lane saturated; exhausted urgent/low-cost authorization charges preserve
  the frozen fail-closed denial semantics;
- a result-adjudication request ID collision leaves the collecting cycle,
  reserve usage, core identity map, and pending backlog unchanged;
- pending backlog reads retain the first persisted `openedAt` across policy
  transitions, exhaustion, and exact replay.
- generic health transitions preserve reserve lanes, and class-version
  retirement recomputes only lanes affected by that version's policies.

## Independent review trace

| Path | Frozen comparison and atomic publication | No-change outcomes | Executable identity |
|---|---|---|---|
| Policy initialize | Complete snapshot; zero usage; initial lane health | identical replay, changed input, missing/retired class version, missing health, invalid policy | `reserve-policy-initialization-replay-conflict`, `reserve-zero-limit-saturates-on-install` |
| Same-window transition | Expected record revision; retain class/worker usage; recompute one lane | stale record, invalid policy | `reserve-policy-same-window-retains-usage` |
| Window rollover | Expected record revision; forward non-overlapping interval; reset one record | stale record, older/overlapping/reused window | `reserve-window-rollback-refused`, `reserve-policy-change-race-fails-closed` |
| Standalone charge | Charge-key lookup, installed snapshot, usage, charge record, lane health | exact charged/exhausted replay, changed key input, missing/stale policy | `reserve-charge-key-input-conflict`, `reserve-health-last-unit-atomic` |
| Result adjudication | Request identity, parent cycle transition, charge record, pending `openedAt`, lane health | exact opened disposition replay, request-ID collision, state conflict, charge conflict, policy conflict | `reserve-missing-policy-refuses-all-charge-paths`, `result-adjudication-id-collision-preserves-state` |
| Action authorization | Effect-intent/authorization identity, receipt, charge record, authorization/adjudication state, lane health | exact receipt replay, intent conflict, charge conflict, policy conflict; exhaustion persists pending split-lane work or a terminal budget denial | `reserve-last-unit-race-fails-closed`, `reserve-policy-version-conflict` |
| Health/retirement | Operating-only generic health mutation; retirement excludes that version's policies and recomputes affected lanes | stale health or lifecycle revision | `health-transition-preserves-accounting-lanes`, `reserve-retirement-clears-only-applicable-lane` |

## Exit gate

Amend the normative coordinator spec before changing the frozen package. Update
the core port types, compile-time tests, lifecycle fixtures, Store-concurrency
IDs, M2 plan, README, and changelog together. Run frozen install, invariants,
contract/core typechecks and tests, builds, fixture checks, package-content
inspection, Markdown fence/local-link checks, and `git diff --check`.
Independently trace policy installation, same-window changes, rollover,
last-unit races, health publication, exact charge replay, and adjudication-ID
collision through every charge-bearing Store command. Tag only the reviewed and
corrected contract commit as `contract-freeze-10`; that tag authorizes M2 Task
6 runtime implementation.

Worker wire version `1.1.0`, MCP schemas, hash envelopes, job/lease/worker wire
records, action/result verdict shapes, and consumer-visible worker errors remain
unchanged.
