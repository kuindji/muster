# Muster contract-freeze-7 worker-control policy amendment plan

**Status:** Implemented locally in coordinator revision 18; awaiting independent
review and the `contract-freeze-7` tag. M2 Task 3 runtime work remains paused.

**Goal:** Amend revision 17 into revision 18 so worker enrollment, probation,
and slot/contribution routing use explicit deterministic deployment policy
instead of caller-invented values or an unbounded `enrolled -> active` edge.

**Trigger:** The first Task-3 runtime implementation made two missing ownership
paths executable. The frozen worker graph requires `N` checked successes over
at least `T` days before activation, but no frozen input owns `N` or `T`.
Revision 17 also says core prepares the assigned slot, contribution-window
identity, and assigned-slot occurrence from deployment policy and time, while
`CoreDeploymentPolicy` declares only lease-extension bounds. Accepting those
values directly from the enrollment caller would make eligibility policy a
content selector outside the declared core boundary.

**Scope:** Normative coordinator prose, one internal core policy interface,
compile-time policy coverage, README, and the M2 plan. No Store command, worker
record, routing snapshot, event, wire schema, hash, fixture, enrollment runtime,
lease runtime, MCP adapter, or provider probe changes.

## Required contract

- Add a deployment-owned `WorkerControlPolicy` with positive integer
  `probationCheckedSuccesses`, positive `probationMinimumEnrollmentAge`, a
  deterministic `assignSlot({ workerId, enrolledAt })`, and deterministic
  `routingAt({ workerId, slot, at })`.
- `routingAt` returns a complete `WorkerRoutingPeriod`: wire-safe contribution
  window and assigned-slot occurrence identities plus whether that occurrence
  is open at the supplied instant. Core persists the identities; Store never
  derives a calendar or eligibility.
- Enrollment obtains the slot and initial zero-usage routing period only from
  this policy. Invalid policy values or outputs fail closed before Store
  registration.
- Every `enrolled -> active` or `paused -> active` transition requires at least
  the configured count of durable `checked_success` evidence recorded no
  earlier than enrollment and an elapsed enrollment age at least the configured
  minimum. This closes the `enrolled -> paused -> active` probation bypass; a
  previously active worker already has the retained qualifying evidence. The
  calibration job alone never promotes a worker.
- Later routing compares the policy result at explicit `Clock` time with the
  durable snapshot, resets contribution use only when the window identity
  advances, and refuses a lease when `slotOpen` is false.

## Required executable coverage

- the policy type carries both probation values and closed input/output shapes;
- slot and routing functions cannot receive job, payload, class, queue, or
  result data;
- the routing result requires both durable identities and `slotOpen`;
- worker/Store records, wire version `1.1.0`, events, hashes, and frozen fixture
  data remain unchanged.

## Exit gate

Run frozen install, invariants, contract/core typechecks and tests, builds,
package-content inspection, fixture checks, Markdown fence/local-link checks,
and `git diff --check`. Independently trace enrollment and probation inputs,
search for any alternate owner of `N`, `T`, slot, or routing calendars, and
verify the policy cannot observe job content. Only a reviewed commit tagged
`contract-freeze-7` authorizes M2 Task 3 to resume.
