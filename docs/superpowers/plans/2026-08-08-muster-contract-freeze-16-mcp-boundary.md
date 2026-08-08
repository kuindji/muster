# Muster contract-freeze amendment 16: MCP boundary

**Goal:** Amend revision 26 before MCP runtime work so every status, skill,
availability, rate, scope, revocation, output, and side-channel fact required by
the frozen six-tool surface has one deterministic owner.

**Scope:** Coordinator prose, isomorphic contract exports, the worker-control
policy and a read-only core status service, stable lifecycle fixture identities,
and focused conformance coverage. Worker wire remains `1.1.0`. This amendment
does not create `packages/mcp`, change the core Store, publish, deploy, or push.

## Findings and corrections

### Status buckets and next-slot projection

`cap_usage_bucket` now means durable current-window usage: unused; used at most
half; used over half but below cap; or at cap. A zero cap is at cap.
`next_slot_bucket` is an index: open now; within one hour; within six hours;
within one day; within three days; or later. `WorkerControlPolicy.nextSlot()`
owns the exact internal occurrence and seconds-until-start projection without
receiving a job, payload, availability value, or worker-selected slot.

`WorkerStatusService` reads the worker and routing snapshot at one explicit
time, applies the deployment policy, and returns coarse buckets plus only the
internal occurrence/class facts the MCP boundary needs. Missing and revoked
workers are both unavailable. It performs no Store mutation.

### Skill release ownership

The immutable release key is canonical JSON over the accepted wire contract and
the complete sorted non-empty enrolled-class set. Input array order is not
identity.
Deployments must register exactly one rendered skill and verified hash per key;
missing, duplicate, or ambiguous releases fail closed.

### Singular v1 availability and padding

Wire `1.1.0` remains a singular lease. Availability is durable MCP-owned state
and never enters core: within one assigned-slot occurrence it may remain equal
or decrease, and it changes neither selected job, batch size, payload, nor
`input_hash`. Bucket zero produces no core lease call.

Padding is transport-only. The complete encoded JSON response receives trailing
insignificant ASCII whitespace; request-scoped SSE receives an ignored trailing
comment. The parsed tool value and canonical text mirror are unchanged.
Responses above the largest listed bucket continue the same power-of-four
series, so padding cannot strand an already-claimed lease.

### MCP state and rate ownership

`McpStateStore` is a separate atomic domain-command port, not part of core
`Store`. It freezes one-to-one subject binding, exact bind replay/conflict,
severance receipts that retain no raw subject, and one atomic call-state command
over binding revision, worker, tool, reviewed fixed rate window, assigned-slot
occurrence, and optional availability bucket. Rate windows are deterministic UTC
windows from immutable policy; lease attempts also have a per-slot cap.

Internal refusals distinguish stale mapping, rate limit, slot-attempt limit,
availability increase, and invalid policy/window. Worker-facing projection is a
single generic tool error without structured content or precise detail.
Every refusal changes no mapping, rate counter, slot-attempt counter, or
availability value; authorization applies all applicable increments and the
monotonic availability replacement atomically. Binding and severance command
IDs are operator-supplied, wire-safe, raw-subject-free, and never worker inputs.

### OAuth scopes, outcomes, and revocation ordering

Exact scopes are `muster:access`, `muster:jobs`, and `muster:worker`. A call
needs endpoint access and its exact group scope. Missing group scope uses OAuth
`insufficient_scope` and names only the required step-up scope; wildcard-looking
scope values are not part of the contract.

The dispatch order is token validation, mandatory revocation read, scopes,
subject mapping, core worker status, complete input validation, and atomic MCP
call-state authorization. A change committed before its corresponding read is
observed. A concurrent change may linearize before or after that read, and a
later change does not retroactively cancel an already-started core operation.
This is an ordered request boundary, not a distributed transaction.
The mandatory `McpTokenRevocationSource` receives only canonical issuer, a
SHA-256 fingerprint of verified bearer bytes, and request time; no bearer bytes
or subject cross that port.

Successful values use structured content plus an identical canonical JSON text
mirror. Authentication/scope and malformed-input paths remain protocol errors.
Lease domain refusal is `no_work`; submit/abandon use frozen wire errors; extend
uses uniform refusal; invalid status/availability domain behavior and all MCP
state refusals use the generic tool-error path.

## Executable checkpoint

- contract tables/functions pin all cap and next-slot edges, exact scopes, rate
  windows, skill keys, output projections, and padding buckets;
- `WorkerControlPolicy.nextSlot()` and `WorkerStatusService` have positive,
  rollover, revoked/missing, and fail-closed policy coverage;
- the lifecycle required-ID matrix contains one stable case for every section
  5.7 row plus direct calls, exact retries, severance, scope refusal, rate and
  availability races, revocation, and skill selection;
- raw OAuth identity remains absent from the core Store and worker status;
- frozen install, invariants, fixtures, package typechecks, tests, builds,
  package inspection, Markdown checks, and `git diff --check` pass.

The corrected commit is tagged locally as `contract-freeze-16`. Task 2 of the
MCP plan remains a separate runtime unit.
