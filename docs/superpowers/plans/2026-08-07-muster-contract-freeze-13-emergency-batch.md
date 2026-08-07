# Muster contract-freeze amendment 13: queue-wide emergency batch

**Goal:** Amend revision 23 so a queue-wide emergency halt can atomically
publish its queue mode, every class-health replacement, and every affected
class-qualified invalidation.

**Scope:** Internal Store and core boundary only. The worker wire remains
`1.1.0`. This amendment does not implement the Task-8 operations service.

## Finding: one queue halt accepts only one class invalidation

`enterEmergencyHalt` already compares an array of class-health snapshots but
accepts exactly one `InvalidationScope`. Because every invalidation scope is
class-qualified, a deployment with more than one registered class must either
invalidate only one class or run several transactions after the queue is
already observably halted. Both violate section 6.6's emergency atomicity rule.
The Store also has no complete class-health listing with which core can prove it
prepared every affected class before the transaction.

Add `listClassHealth()` and replace the single emergency invalidation with a
canonical array containing exactly one whole-class scope per current class
health snapshot. Store compares the complete current class-health set, every
target snapshot, and every requeue plan before mutation. Duplicate, missing,
extra, non-class, or mismatched scopes conflict without changing queue, health,
result, authorization, lease, epoch, or cycle state. Applied output preserves
one class-qualified invalidation result per input scope in canonical class ID
order.

The executable boundary covers a two-class all-or-nothing emergency, a new
class racing prepared emergency state, and missing/duplicate scope refusal.
The reviewed boundary is tagged locally as `contract-freeze-13`; Task 8 runtime
resumes only after that checkpoint.
