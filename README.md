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

**Design phase.** The design is converged for one-shot scope and authorizes an
implementation plan, not code. A platform gate blocks anything beyond a stub
until a real-device test proves that a scheduled task on a mobile-manageable
plan can execute a skill and call a remote MCP connector unattended.

## Specs

| Spec | Status | What it settles |
|---|---|---|
| [2026-08-04 - coordinator design](docs/specs/2026-08-04-muster-coordinator-design.md) (rev 11) | `oneshot` scope; converged over eleven review revisions | What Muster does and does not guarantee, the trusted-consumer boundary, unanimous replication agreement with absorbing splits, separate result and action adjudication contracts, effect-intent idempotency, immutable receipts with live validity and typed denial reasons, explicit automatic/human-only action permits, action-specific oracle coverage with canonical absence domains, multidimensional escalation health, permit epochs and emergency invalidation, confidence-typed diversity, side channels, trust model as tests, privacy, platform gate, licence |
| [2026-08-04 - staged and effecting work](docs/specs/2026-08-04-muster-staged-and-effecting-design.md) | **Deferred; authorizes nothing** | Why multi-stage and side-effecting volunteer work were removed from v1, what was tried, the three unsolved staged-work problems, and the effecting-work trust/execution contract that gate their return |
| [2026-08-05 - interpretation decisions](docs/specs/2026-08-05-spec-interpretation-decisions.md) | Operator-signed footnote to rev 11; amendments in waiting for rev 12 | The six readings the contract freeze commits to where rev 11 is silent or self-contradicting: `payloadSchema` on `JobClass`, `job_class_id` and `policy_version` in `input_hash`, the `JsonPath` grammar, `AbsenceDomain` identity, and the `PrivacyClass` retention values |

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

## License

[Apache-2.0](LICENSE). AI Horde is AGPL-3.0-or-later; Muster studies its
design and never copies its code, schemas, or documentation text.
