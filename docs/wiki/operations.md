---
title: Operations
parents: [README]
children: [operations/security, operations/production-readiness]
related_pages: [integration]
last_updated: 2026-08-09
---

# Operations

Muster supplies deterministic library boundaries, not a managed service.
Production ownership stays with the deployment that combines the packages,
database, OAuth resource server, worker scheduler, and trusted consumer.

- [Security](operations/security.md) — identity, privacy, data, network,
  durability, and authorization controls that remain deployment-owned.
- [Production readiness](operations/production-readiness.md) — completed gates,
  outstanding consumer acceptance, publication status, and the deployment
  checklist.

The package-specific runbooks remain authoritative for exact construction:

- [MCP operations guide](../../packages/mcp/README.md)
- [PostgreSQL Store operations guide](../../packages/store-postgres/README.md)

Monitor both infrastructure failures and domain refusals without weakening the
coarse worker-visible boundary. Restricted operator tooling may correlate
pseudonymous identifiers; worker responses and general logs must not expose raw
OAuth identity, bearer material, payloads, results, or precise queue state.
