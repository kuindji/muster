# Muster contract-freeze amendment 12: operations and observability boundary

**Goal:** Amend the revision-22 internal core boundary so Milestone 2 Task 8 can
implement queue capacity, provider-offline detection, adjudication starvation,
operator restoration, and privacy-safe ledger records without inventing hidden
adapter policy or racing durable operational state.

**Scope:** Internal core, Store, event, and fixture contracts only. The worker
wire remains `1.1.0`. This amendment does not implement Task 8 runtime services,
PostgreSQL, MCP transport, retention deletion, or consumer callbacks.

## Finding 1: queue capacity inputs and thresholds have no owner

Section 6.12 names `W`, `B`, `q`, and `R_avg`, capacity-below-threshold,
SLA aging, and expected-slot arrivals, but revision 22 exposes no port that owns
those observations or the deployment threshold. Core cannot distinguish a
provider outage from an operator pause, so emitting `pool_offline` from the
current queue mode alone would be false.

Add a deployment-owned, deterministic `OperationsSource` whose closed output is
one timestamped `QueueCapacityObservation`: active workers, items per batch,
combined canary/audit fraction, mean replication factor, minimum effective
capacity, oldest SLA breach, and a closed expected-slot observation window.
Core validates the complete observation, computes effective capacity as
`W * B * (1 - q) / R_avg`, and derives only automatic `normal`, `degraded`, or
pool-offline `admission_halted` transitions. Queue snapshots retain a cause so
automatic refresh cannot impersonate an operator pause or emergency halt.
Explicit operator restoration remains required after any admission halt.

## Finding 2: starvation dwell and backlog can race health publication

Pending reads preserve `openedAt`, but separate result/action reads have no
single comparison token and omit resolved requests needed for rolling admitted
demand. Class health has nowhere to retain when unsafe supply/demand first
began. A Task-8 service would otherwise either starve immediately, forget dwell
across calls, or overwrite a newer request/health transition.

Add a Store-owned `AdjudicationLoadSnapshot` covering rolling admitted demand
and the oldest pending request, with a monotonically increasing revision. Add
`adjudicationUnsafeSince` to `ClassHealthSnapshot`. A dedicated
`refreshClassHealth` command compares both complete snapshots and publishes the
next operating state plus dwell marker atomically while preserving
accounting-owned reserve lanes. Opening, resolving, rejecting, expiring,
superseding, or cancelling a pending request advances the load revision.

Automatic refresh may enter `adjudication_starved` but never restores it.
Operator restoration compares the same load snapshot and is permitted only
when fresh capacity is strictly above `restoreAbovePerWeek`, rolling demand is
covered, and the oldest pending request is younger than `starvationDwell`.
Operator or emergency health states cannot be replaced by an automatic refresh.

## Finding 3: the ledger boundary cannot enforce privacy

`appendLedger({ kind, detail })` accepts arbitrary bodies without class or
privacy identity, and `contract_transition.detail` permits arbitrary content in
the audit stream even though audit events must be hash-only.

Replace the generic ledger input with a closed `LedgerEntry` that carries the
class privacy value, hash-only bindings, optional bodies, and optional effect
descriptors. Store rejects entries that violate `PRIVACY_CLASS_RULES`:
`sensitive` entries are hash-only; `internal` may retain bodies in the ledger
but notifications expose none; `public` may retain and expose both. Audit
`contract_transition` carries only `detailHash`. Retention duration and deletion
remain adapter/operator policy outside this amendment.

## Frozen executable coverage

- capacity projection validates finite, bounded inputs and uses the exact
  effective-throughput formula;
- malformed observations fail closed without changing queue state;
- stale queue refreshes cannot replace operator or emergency state;
- `pool_offline` is emitted only for a closed expected-arrival window with no
  observed arrivals and is retained as the durable queue cause;
- backlog aging and continuous under-capacity dwell enter starvation;
- request-open/terminal races make stale health refreshes conflict;
- starvation restoration is explicit and uses the higher threshold;
- sensitive ledger entries reject bodies/descriptors, and audit events expose
  hashes only;
- at the revision-23 boundary, reputation policy priority remains finite and is
  only a final routing tiebreaker. Revision 26 and `contract-freeze-15` later
  supersede that unrepresentable pull-routing shape with eligibility only.

The reviewed amendment is tagged locally as `contract-freeze-12`. M2 Task 8
runtime work resumes only after that review boundary.
