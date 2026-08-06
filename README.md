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

**Contract freeze complete.** The real-provider unattended platform gate
passed, and Milestone 1 now freezes the one-shot wire contract, executable
tables and state machines, conformance fixtures, and the types-only core port
boundary. Runtime coordinator behavior remains Milestone 2 work.

## Specs

| Spec | Status | What it settles |
|---|---|---|
| [2026-08-04 - coordinator design](docs/specs/2026-08-04-muster-coordinator-design.md) (rev 12) | `oneshot` scope; converged over twelve review revisions | What Muster does and does not guarantee, the trusted-consumer boundary, unanimous replication agreement with absorbing splits, collection-cycle-isolated result requeues, exact sanitized-payload/schema hashing, pseudonymous core identity, separate result and action adjudication contracts, replay-stable authorization receipts, effect-intent idempotency, live validity and typed denial reasons, explicit automatic/human-only action permits, action-specific oracle coverage with canonical absence domains, multidimensional escalation health, permit epochs and emergency invalidation, confidence-typed diversity, side channels, trust model as tests, privacy, platform gate, licence |
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

The Milestone 1 contract is frozen at wire version `1.0.0` and tagged locally
as `contract-freeze-1`. The binding scope is defined by
[spec §11.1](docs/specs/2026-08-04-muster-coordinator-design.md#111-milestone-one-is-a-contract-freeze-and-nothing-else)
and the checked-in
[M0+M1 implementation plan](docs/superpowers/plans/2026-08-05-muster-m0-m1-contract-freeze.md).
Golden hash vectors, lifecycle fixtures, store-concurrency cases, and the
prompt-injection corpus live under `packages/contract/fixtures/`.

Changes to a frozen type, table, state machine, hash envelope, schema, or
fixture require a spec revision before implementation.

## License

[Apache-2.0](LICENSE). AI Horde is AGPL-3.0-or-later; Muster studies its
design and never copies its code, schemas, or documentation text.
