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

**Contract freeze 8 is independently reviewed; its local tag is pending.** The
real-provider unattended platform gate passed. Revision 19 corrects the
canary-payload binding and atomic no-work contribution gaps found by the first
M2 Task-4 runtime trace. M2 currently includes the reference in-memory Store
foundation, runtime class registry and registration validator, and the
class/permit/worker control plane. Task 4 resumes only after the freeze-8 tag.

## Specs

| Spec | Status | What it settles |
|---|---|---|
| [2026-08-04 - coordinator design](docs/specs/2026-08-04-muster-coordinator-design.md) (rev 19) | `oneshot` scope; contract-freeze-8 reviewed, tag pending | What Muster does and does not guarantee, the trusted-consumer boundary, Muster Schema 1, core-owned routing and bootstrap state with atomic Store comparison, exact ordinary/canary lease payload binding, atomic no-work contribution accounting, deployment-owned worker probation and routing policy, payload-bound agreement fixtures, explicit retrospective-audit projections, per-lease worker-state requeue audit identity, explicit identity ownership, versioned operational state, bounded lease and reserve policy, mechanically classified fixtures, unanimous replication agreement with absorbing splits, collection-cycle-isolated result requeues, exact sanitized-payload/schema hashing, pseudonymous core identity, class-qualified atomic invalidation, replay-stable receipts, live validity, privacy, platform gate, licence |
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

The wire contract remains frozen at version `1.1.0`. The current reviewed
internal boundary is tagged `contract-freeze-7`; `contract-freeze-1` through
`contract-freeze-6` remain historical boundaries. The binding scope is defined
by [spec §11.1–11.7](docs/specs/2026-08-04-muster-coordinator-design.md#111-milestone-one-is-a-contract-freeze-and-nothing-else),
the checked-in [M0+M1 plan](docs/superpowers/plans/2026-08-05-muster-m0-m1-contract-freeze.md),
the [freeze-2 amendment plan](docs/superpowers/plans/2026-08-06-muster-contract-freeze-2.md),
the [freeze-3 M2-entry amendment plan](docs/superpowers/plans/2026-08-06-muster-contract-freeze-3-m2-entry.md),
the [freeze-4 Store-bootstrap amendment plan](docs/superpowers/plans/2026-08-06-muster-contract-freeze-4-store-bootstrap.md),
the [freeze-5 registration-input amendment plan](docs/superpowers/plans/2026-08-06-muster-contract-freeze-5-registration-inputs.md),
the [freeze-6 worker-state audit amendment plan](docs/superpowers/plans/2026-08-06-muster-contract-freeze-6-worker-requeue-audit.md),
and the [freeze-7 worker-control policy amendment plan](docs/superpowers/plans/2026-08-06-muster-contract-freeze-7-worker-control-policy.md).
The independently reviewed [freeze-8 lease-payload and no-work accounting amendment](docs/superpowers/plans/2026-08-07-muster-contract-freeze-8-lease-payload-accounting.md)
is implemented locally but does not authorize Task 4 until its local tag.
Golden hashes, schema conformance, lifecycle, store-concurrency, and
prompt-injection fixtures live under `packages/contract/fixtures/`.

Changes to a frozen type, table, state machine, hash envelope, schema, or
fixture require a spec revision before implementation.

## License

[Apache-2.0](LICENSE). AI Horde is AGPL-3.0-or-later; Muster studies its
design and never copies its code, schemas, or documentation text.
