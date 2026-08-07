# Muster contract-freeze-9 submission-settlement amendment plan

**Status:** Implemented as coordinator revision 20 and awaiting independent
review. It is not tagged; M2 Task 5 remains blocked.

**Goal:** Amend revision 19 into revision 20 so submission rejection,
contract-cutoff settlement, checked reputation evidence, and absorbing-split
routing have atomic, restart-stable Store boundaries before the verification
runtime is implemented.

**Trigger:** The first M2 Task-5 implementation trace found that the frozen
Store could atomically accept a submission but could not settle an invalid
submission under the distinct `rejected_invalid` fair-attempt row. Reusing an
abandonment classification would lose the honest attempt identity. A contract
cutoff could also race the service's pre-read because `SubmitOutcome` exposed
no atomic `contract_expired` settlement. Checked-success or failure evidence
would otherwise be recorded after acceptance/rejection, leaving a crash window.
Finally, the lease boundary had no durable indication that a target evidence
set had already split, so routing could neither open only the bounded
split-evidence allowance nor keep that split absorbing across retries.

## Required contract

- `acceptOrReplaySubmission` may carry one qualifying
  `ReputationEvidenceRecord`. Holder binding and accepted-row replay still run
  first. A first acceptance commits the immutable receipt, body, lease closure,
  ordinary same-cycle replica/diversity facts, contribution retention, and
  optional evidence together. Evidence-ID conflict changes nothing.
- The acceptance command evaluates its receipt time against the immutable
  lease expiry/deadline and durable class cutoff in the same transaction. An
  expired lease returns the coarse `lease_not_held` outcome and releases the
  occurrence; a contract cutoff returns `contract_expired`, closes/requeues the
  lease, and retains the occurrence as a coordinator fault. Neither path can
  replace a previously accepted row.
- Add `rejectSubmission` for `rejected_invalid`, `coordinator_fault`, and
  `lease_expired_no_fault`. It rechecks holder/open state and atomically closes
  and requeues the stamped-cycle lease, applies the frozen contribution rule,
  and records optional qualifying reputation evidence. Exact settlement
  replays; changed settlement or evidence identity conflicts without partial
  mutation.
- Same-cycle abandonment, expiry, and rejection compare the lease's stamped
  permit epoch rather than the class's later current epoch. An ordinary epoch
  transition does not retroactively revoke or strand in-flight work.
- `JobCycleAttemptSnapshot.splitObserved` starts false. `markResultSplit`
  compares the exact complete accepted ordinary evidence set for that job
  cycle and atomically makes the marker true. A stale or mixed-cycle set
  conflicts. Once true, it never clears in that cycle and
  `recordDecisionResult` cannot create an automatic decision for it.
- `recordDecisionResult` compares the complete current accepted evidence set,
  requires no open lease, and rejects a split-marked cycle. This prevents a
  stale automatic decision from racing another accepted replica.

## Required executable coverage

- concurrent exact submissions produce one acceptance plus byte-identical
  replay; a changed retry preserves the accepted row and holder binding still
  precedes disclosure;
- invalid settlement closes/requeues, releases current-window contribution,
  records negative evidence atomically, replays exactly, and fences later
  acceptance;
- contract cutoff and acceptance are one atomic outcome with coordinator-fault
  accounting;
- the first split marker requires the exact same-cycle accepted evidence set,
  survives candidate reads, and fences automatic decision persistence;
- accepted ordinary replicas and checked evidence are committed together,
  while canary submissions remain absent from ordinary replica queries;
- same-cycle abandon/expiry remains valid after an ordinary current-epoch
  transition.

## Exit gate

Run frozen install, invariants, contract/core typechecks and tests, builds,
fixture checks, package-content inspection, Markdown fence/local-link checks,
and `git diff --check`. Independently trace acceptance/rejection races,
same-cycle epoch stickiness, canary-versus-ordinary replica projection, and the
split marker through claim eligibility and decision persistence. Only the
reviewed and corrected commit may be tagged `contract-freeze-9`; that tag
authorizes M2 Task 5.

Wire version `1.1.0`, MCP schemas, hash envelopes, audit-event schemas, class,
job, lease, and worker records, and worker-visible error vocabulary remain
unchanged.
