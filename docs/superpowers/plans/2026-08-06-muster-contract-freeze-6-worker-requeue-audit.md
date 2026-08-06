# Muster contract-freeze-6 worker-requeue audit amendment plan

**Status:** Implemented locally in coordinator revision 17; awaiting independent
review and the `contract-freeze-6` tag. No worker-control runtime mechanics are
authorized before that boundary.

**Goal:** Amend revision 16 into revision 17 so M2 Task 3 can emit a truthful,
self-contained append-only audit event for every lease atomically closed and
requeued by worker suspension or revocation.

**Trigger:** The first Task-3 implementation trace found that
`WorkerStateTransitionOutcome.requeuedOpenLeases` retained only lease, class,
job, and collection-cycle identity. It omitted the stamped contract version and
permit epoch. The frozen audit union also had no requeue member. The existing
`lease` event means issuance, while `state_change` has no lease identity, so
either substitution would make the audit trail false or incomplete.

**Scope:** Normative coordinator prose, the internal core/Store outcome, the
append-only event union, the reference Store implementation, Store conformance,
compile-time event coverage, README, and the M2 plan. No worker state service,
enrollment service, routing, verification, Postgres, MCP, worker wire, hash, or
job/result lifecycle change.

## Required contract

- `RequeuedLeaseIdentity` retains `leaseId`, `classId`, `jobId`,
  `collectionCycle`, `contractVersion`, and `permitEpoch` from the closed lease.
- `MusterAuditEvent` adds `lease_requeue`, scoped to one job cycle and carrying
  the lease ID, opaque worker ID, provider surface, contract version, permit
  epoch, and a closed `worker_suspended | worker_revoked` reason.
- An applied suspension or revocation produces one worker `state_change` event
  plus one `lease_requeue` event for every returned lease identity. Replays do
  not append duplicate events.
- The atomic Store command remains the sole owner of lease closure and
  same-cycle requeue. Core does not reconstruct the stamped version or epoch
  from a later read.

## Required executable coverage

- the audit type list and union accept a complete `lease_requeue` event and
  reject one missing its stamped epoch;
- the reference Store returns the exact contract version and permit epoch from
  every requeued lease;
- the existing `worker-suspension-requeues-open-leases` conformance case checks
  those retained audit fields without changing its atomicity semantics;
- wire version `1.1.0`, MCP schemas, hashes, and job/result state remain
  unchanged.

## Exit gate

Run frozen install, invariants, contract/core typechecks and tests, builds,
package-content inspection, fixture checks, Markdown fence/local-link checks,
and `git diff --check`. Independently trace a prepared lease through atomic
suspension into `RequeuedLeaseIdentity`, verify that every event field is
constructible from that outcome plus the immutable worker record, and search
for any code that misuses issuance or result-state events for requeue auditing.
Only a reviewed commit tagged `contract-freeze-6` authorizes M2 Task 3 to begin.
