# Muster

A coordinator library for verified volunteer agent work: distributing bounded,
sanitized, schema-bound one-shot jobs to untrusted agents that run inside other
people's AI provider clouds, on other people's plan allowance, reached over
MCP — and verifying what comes back to an **achieved strength**, gated by
**what the result is permitted to cause**.

Muster performs no model inference. It deterministically rejects invalid
submissions, detects consistently bad workers by sampling, routes disagreement
to humans instead of voting, and issues evidence-bound action authorizations.
It does not guarantee that an ordinary worker result is correct, and it trusts
the consumer to obey those authorizations.

## Status

**Milestone 2 Task 6 is complete.** The real-provider unattended platform gate
passed. Revision 22 is independently reviewed, corrected, and tagged locally
as `contract-freeze-11`. M2 now
includes the reference in-memory Store through that boundary, runtime class
registry and registration validator, class/permit/worker control plane,
enqueue/routing/lease lifecycle, and the submission plus cycle-scoped automatic
verification pipeline. It also implements authoritative reserve lifecycle and
atomic health publication, fail-closed escalation charging, authenticated
result and human-only action adjudication with exact verdict replay, bounded
dispute requeues, and class-qualified invalidation with live authorization
validity. The first Task 7 trace found frozen authorization-atomicity,
composite-reserve, verdict-replay, and processing-time gaps. The
`contract-freeze-11` amendment now has executable live-context, composite
reserve, processing-time, and early verdict-replay coverage; action-gate
implementation may resume as the next separate unit.

## Specs

| Spec | Status | What it settles |
|---|---|---|
| [2026-08-04 - coordinator design](docs/specs/2026-08-04-muster-coordinator-design.md) (rev 22) | `oneshot` scope; tagged `contract-freeze-11` | What Muster does and does not guarantee, live authorization contexts, atomic composite reserves, distinct verdict processing time, early exact verdict replay, the trusted-consumer boundary, Muster Schema 1, authoritative reserve policy and atomic accounting/health publication, atomic submission settlement and absorbing-split routing, core-owned routing and bootstrap state with atomic Store comparison, exact ordinary/canary lease payload binding, atomic no-work contribution accounting, deployment-owned worker probation and routing policy, payload-bound agreement fixtures, explicit retrospective-audit projections, per-lease worker-state requeue audit identity, explicit identity ownership, versioned operational state, bounded lease and reserve policy, mechanically classified fixtures, unanimous replication agreement, collection-cycle-isolated result requeues, exact sanitized-payload/schema hashing, pseudonymous core identity, class-qualified atomic invalidation, replay-stable receipts, live validity, privacy, platform gate, licence |
| [2026-08-04 - staged and effecting work](docs/specs/2026-08-04-muster-staged-and-effecting-design.md) | **Deferred; authorizes nothing** | Why multi-stage and side-effecting volunteer work were removed from v1, what was tried, the three unsolved staged-work problems, and the effecting-work trust/execution contract that gate their return |
| [2026-08-05 - interpretation decisions](docs/specs/2026-08-05-spec-interpretation-decisions.md) | Historical operator-signed footnote; superseded by rev 12 | The six revision-11 readings absorbed into revision 12, including the pre-freeze correction that now places the exact canonical sanitized payload and `payload_schema` in `input_hash` |

## Research

| Note | Status | What it covers |
|---|---|---|
| [2026-08-04 - AI Horde as a design reference](docs/research/2026-08-04-ai-horde-reference.md) | Open subject | What transfers from AI Horde, what to avoid, what does not port, the AGPL clean-room boundary, and the SEP-2640 skills-over-MCP finding |

## Planned packages

| Package | Contains |
|---|---|
| `@kuindji/muster-contract` | envelopes, schemas, types, canonical hashing, contract lifecycle, skill generator |
| `@kuindji/muster-core` | routing, leases, verification, action gates, reputation, escalation budgets, ledger |
| `@kuindji/muster-store-postgres` | store adapter and migrations |
| `@kuindji/muster-mcp` | tool surfaces, skill Resource, OAuth, rate limits |

## Contract freeze

The wire contract remains frozen at version `1.1.0`. The current tagged
internal boundary is revision 22 at `contract-freeze-11`. The binding scope is
defined
by [spec §11.1–11.11](docs/specs/2026-08-04-muster-coordinator-design.md#111-milestone-one-is-a-contract-freeze-and-nothing-else),
the checked-in [M0+M1 plan](docs/superpowers/plans/2026-08-05-muster-m0-m1-contract-freeze.md),
the [freeze-2 amendment plan](docs/superpowers/plans/2026-08-06-muster-contract-freeze-2.md),
the [freeze-3 M2-entry amendment plan](docs/superpowers/plans/2026-08-06-muster-contract-freeze-3-m2-entry.md),
the [freeze-4 Store-bootstrap amendment plan](docs/superpowers/plans/2026-08-06-muster-contract-freeze-4-store-bootstrap.md),
the [freeze-5 registration-input amendment plan](docs/superpowers/plans/2026-08-06-muster-contract-freeze-5-registration-inputs.md),
the [freeze-6 worker-state audit amendment plan](docs/superpowers/plans/2026-08-06-muster-contract-freeze-6-worker-requeue-audit.md),
and the [freeze-7 worker-control policy amendment plan](docs/superpowers/plans/2026-08-06-muster-contract-freeze-7-worker-control-policy.md).
The independently reviewed [freeze-8 lease-payload and no-work accounting amendment](docs/superpowers/plans/2026-08-07-muster-contract-freeze-8-lease-payload-accounting.md)
is implemented and tagged locally; that boundary authorized M2 Task 4.
The [freeze-9 submission-settlement amendment](docs/superpowers/plans/2026-08-07-muster-contract-freeze-9-submission-settlement.md)
is independently reviewed, corrected, and tagged; M2 Task 5 is complete against
that boundary.
The [freeze-10 reserve-accounting amendment](docs/superpowers/plans/2026-08-07-muster-contract-freeze-10-reserve-accounting.md)
is independently reviewed, corrected, and tagged; M2 Task 6 is complete against
that boundary.
The independently reviewed and corrected
[freeze-11 action-authorization amendment](docs/superpowers/plans/2026-08-07-muster-contract-freeze-11-action-authorization.md)
records and implements the first Task-7 trace findings; the reviewed boundary
is tagged locally.
Golden hashes, schema conformance, lifecycle, store-concurrency, and
prompt-injection fixtures live under `packages/contract/fixtures/`.

Changes to a frozen type, table, state machine, hash envelope, schema, or
fixture require a spec revision before implementation.

## License

[Apache-2.0](LICENSE). AI Horde is AGPL-3.0-or-later; Muster studies its
design and never copies its code, schemas, or documentation text.
