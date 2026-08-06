# Muster contract-freeze-4 Store bootstrap amendment plan

**Status:** Complete in coordinator revision 15 and the local
`contract-freeze-4` tag. No runtime mechanics were added.

**Goal:** Amend revision 14 into revision 15 so every Store snapshot required by
M2 can be created and advanced through the same portable, policy-free boundary
that later claims compare.

**Trigger:** The first Task-1 implementation trace found that
`getWorkerRoutingSnapshot` is a mandatory read, but `putWorker(record)` carries
neither an initial contribution window nor an assigned-slot occurrence and no
Store command can advance either value. An in-memory implementation could only
invent those values or expose adapter-specific setup. The same trace found that
`getClassHealth(classId)` promises a non-null snapshot although the port has no
class-health initialization command. Both violate revision 14's rule that core
owns policy and Store adapters only compare and persist prepared state.

**Scope:** Normative coordinator prose, core port types, lifecycle/concurrency
fixture identities, compile-time tests, README/freeze metadata, and the M2 plan.
No in-memory Store, routing engine, Postgres, MCP, or worker behavior.

## Finding 1: worker creation cannot create its compared routing record

Replace `putWorker(record)` with one atomic `registerWorker` domain command. Its
input carries the immutable `WorkerRecord` plus core-prepared initial routing
facts: contribution-window identity, zero initial usage, and assigned-slot
occurrence. Store creates both records with one Store-owned routing revision.
An identical registration replays; reuse of the worker ID with different worker
or routing facts conflicts without replacement.

`getWorkerRoutingSnapshot` becomes nullable for an unknown worker. This matches
`getWorker` and prevents adapters from fabricating a snapshot for an identity
that was never registered.

## Finding 2: routing periods cannot advance portably

Add `transitionWorkerRouting`. Core supplies the complete next contribution
window, usage, and assigned-slot occurrence after comparing a snapshot. Store
retains its open-lease set, increments the Store-owned revision, and applies,
replays, or conflicts atomically. Claim remains the only command that increments
usage for a successful lease; every worker-state transition also increments the
routing revision so a state change fences a concurrently prepared claim.

The Store never derives week boundaries, slot calendars, or reset policy. Those
are deterministic core/deployment inputs and remain outside the adapter.

## Finding 3: class health has no creation path

Add `initializeClassHealth` with a complete core-prepared initial health value,
timestamp, and source. It creates revision 1, replays identical initialization,
and conflicts on a different value. `getClassHealth` becomes nullable before
initialization. Registration Task 2 must initialize health before making a
class version active; enqueue and claim fail closed if the snapshot is absent.

Queue mode remains deployment-bootstrap state: every Store implementation is
constructed or migrated with one explicit initial `QueueModeSnapshot`, and
`getQueueMode` remains non-null. This amendment records that ownership rather
than adding a hidden default to adapters.

## Required executable coverage

- worker record and initial routing state appear together or not at all;
- identical worker registration replays and changed registration conflicts;
- a stale routing-period transition conflicts without changing usage, slot, or
  open leases;
- any applied worker-state transition fences an already prepared claim;
- class-health initialization replays identical state and conflicts on a
  different initial state;
- unknown worker-routing and class-health reads return `null`;
- fixture schemas recognize the new command shapes and require these cases.

## Exit gate

Run frozen install, invariants, contract/core typechecks and tests, fixture
validation, builds, package-content inspection, Markdown fence/local-link
checks, and `git diff --check`. Independently review the ownership trace from
enrollment and class registration through compare-and-claim. Only a reviewed
commit tagged `contract-freeze-4` authorizes M2 Task 1 to resume.

Wire version `1.1.0`, worker MCP schemas, hash envelopes, consumer functions,
and all existing fixture outcomes remain unchanged.
