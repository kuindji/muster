# Muster

A coordinator library for verified volunteer agent work: distributing bounded,
sanitized, schema-bound one-shot jobs to untrusted agents that run inside other
people's AI provider clouds, on other people's plan allowance, reached over
MCP — and verifying what comes back to an **achieved strength**, gated by
**what the result is permitted to cause**.

Muster performs no model inference. It distrusts workers, verifies
deterministically, routes disagreement to humans instead of voting, and never
authorizes a consumer-side effect whose verification strength its evidence does
not meet.

## Status

**Design phase.** The design is converged for one-shot scope and authorizes an
implementation plan, not code. A platform gate blocks anything beyond a stub
until a real-device test proves that a scheduled task on a mobile-manageable
plan can execute a skill and call a remote MCP connector unattended.

- [Coordinator design](docs/specs/2026-08-04-muster-coordinator-design.md) —
  the authoritative spec (revision 11)
- [Staged and effecting work](docs/specs/2026-08-04-muster-staged-and-effecting-design.md)
  — deferred design; authorizes nothing
- [AI Horde as a design reference](docs/research/2026-08-04-ai-horde-reference.md)

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
