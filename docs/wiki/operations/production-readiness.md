---
title: Production Readiness
parents: [operations]
children: []
related_pages: [integration/consumer-integration]
last_updated: 2026-08-09
---

# Production readiness

The one-shot coordinator implementation is complete at revision 29
(`contract-freeze-18`), with worker wire `1.1.0`. The in-memory and PostgreSQL
Store conformance suites, packed-package parity, and a fresh unattended
real-provider MCP flow have passed.

Those results establish implementation and provider interoperability. They do
not establish that a particular consumer, deployment, data classification, or
authorization-enforcement boundary is production-ready.

## Current gates

| Gate | Status |
|---|---|
| Frozen one-shot contract and independent semantic review | Complete |
| Core and cross-Store conformance | Complete |
| PostgreSQL 16/18 source and packed adapter gates | Complete |
| MCP protocol, authentication, state, and packed parity | Complete |
| Fresh unattended provider/account MCP acceptance | Complete |
| Successful representative consumer integration | **Pending** |
| Package registry publication | **Blocked on consumer integration** |
| Durable production deployment | Deployment-specific; not completed by this repository gate |

## Deployment checklist

Before production use, document and test:

- the first workload's schemas, verification strength, disclosure boundary,
  retry behavior, and action policy;
- a durable PostgreSQL Store, durable MCP-state adapter, backups, restores,
  migrations, credentials, TLS, and capacity limits;
- OAuth issuance, PKCE, exact scopes, JWKS rotation, per-request revocation,
  subject lifecycle, and incident response;
- canonical skill-release installation and worker enrollment;
- monitoring, privacy-safe logs, retention, alerting, graceful shutdown, and
  disaster recovery;
- end-to-end consumer behavior for accepted results, exact replay, refusals,
  invalidation, and live authorization enforcement; and
- a staged rollout that can stop intake without corrupting durable state.

Implementation history remains in the [changelog](../../../CHANGELOG.md), the
[MCP plan](../../superpowers/plans/2026-08-08-muster-mcp.md), and the
[real-client gate](../../gate/2026-08-08-mcp-real-client-gate.md).
