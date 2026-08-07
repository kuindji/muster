# Muster contract-freeze amendment 15: Task-10 review corrections

**Goal:** Amend revision 25 so the final Milestone 2 review describes only
behavior the pull-based coordinator can own and closes two fail-open state
transitions found by the same trace.

**Scope:** Internal contract tables, core ports, reference Store, result
adjudication, and focused conformance coverage. The worker wire remains `1.1.0`.
This amendment does not authorize Postgres, MCP, publication, or a remote push.

## Findings and corrections

### Reputation is eligibility, not cross-worker priority

`lease_job(workerId)` handles one requesting worker at a time. Core never owns a
simultaneous worker candidate set, so the returned reputation `priority` was
computed but could not affect routing. Revision 26 removes that value and keeps
the deterministic, I/O-free `eligible` decision. Job selection continues to use
hard constraints and durable queue priority.

### Degraded mode is a signal, not an unnamed deployment policy

The frozen queue table promised intake throttling and early low-priority expiry
without a throttle ratio, expiry deadline, policy owner, or atomic Store
command. Revision 26 makes the executable boundary explicit: degraded mode
emits backpressure, retains full valid intake, never shortens existing work, and
uses the same urgent-first ordering as all leaseable queue states. A later
deployment may add throttling or expiry only through another reviewed contract.

### Class-qualified invalidation includes its epoch transition

Emergency permit withdrawal now conflicts unless `scope.classId` equals
`epochTransition.classId`. The reusable Store conformance suite proves that a
cross-class command changes neither the invalidation scope nor the unrelated
permit epoch.

### Diversity adjudication requires current-cycle proof

`openResult(... diversity_shortfall)` now requires a declared diversity rule, a
current collecting candidate, no open lease, at least the replication target's
accepted evidence, and an axis still below `minDistinct`. A caller cannot move
an arbitrary collecting job into paid adjudication.

## Executable checkpoint

- the exported reputation-policy assessment is exactly `{ eligible: boolean }`;
- the queue-mode table contains no unowned throttle or early-expiry state;
- Store conformance refuses a cross-class emergency epoch transition;
- adjudication coverage refuses an unproven diversity shortfall;
- frozen install, invariants, fixtures, typechecks, tests, builds, package
  inspection, Markdown checks, and diff checks pass.

The corrected commit is tagged locally as `contract-freeze-15`. The subsequent
final Task-10 independent review passed without another runtime or contract
finding.
