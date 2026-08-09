---
title: Security and Privacy
parents: [operations]
children: []
related_pages: [trust-model, integration/mcp-deployment]
last_updated: 2026-08-09
---

# Security and privacy

Muster narrows worker access and separates raw identity from coordinator
history, but the deployment still owns the security perimeter.

## Identity and authorization

- Terminate TLS at a controlled canonical HTTPS origin and configure trusted
  proxies explicitly.
- Accept only short-lived RFC 9068 access tokens with pinned algorithms, exact
  issuer and resource audience, stable subject, and exact Muster scopes.
- Check revocation on every protected request. Fail closed on outage,
  ambiguity, unknown keys, stale mapping, or revoked worker state.
- Keep raw issuer/subject pairs only in the severable MCP mapping. Core, Store
  events, receipts, hashes, metrics, and gate evidence use opaque worker IDs.
- Audit operator-only bind and sever commands; never expose them as worker
  tools.

## Data handling

The consumer must sanitize every payload before enqueue. A leased payload and
submitted result are visible to the selected worker, its provider, and the
deployment path, so do not include credentials or data the worker is not
permitted to process.

Do not log Authorization headers, bearer tokens, raw JWT claims, JWKS bodies,
raw issuer/subject pairs, request bodies, leased payloads, submitted results, or
worker-visible tool responses. Define retention and erasure for live mappings,
severance receipts, revocation records, access logs, and acceptance evidence.

## Durability and availability

Use a durable core Store and a durable MCP-state adapter. Keep rate, slot,
availability, mapping, lease, result, reserve, and authorization comparisons in
their atomic Store commands rather than process memory. Back up PostgreSQL,
test forward migrations and restore procedures, separate migration and runtime
roles, and alert on transaction exhaustion or Store health failures.

OAuth discovery, JWKS, revocation, the database, and the public MCP endpoint
are availability dependencies. Their ambiguity should refuse work rather than
silently weaken authentication or correctness.

## Consumer enforcement

Muster records authorizations; the consumer enforces them. The consumer must
compare the exact action descriptor and current authorization state immediately
before acting, respect expiry and invalidation, replay idempotently, and never
interpret an accepted result alone as permission for an external effect.
