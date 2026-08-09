---
title: MCP Deployment
parents: [integration]
children: []
related_pages: [integration/consumer-integration, operations/security]
last_updated: 2026-08-09
---

# MCP deployment

`@kuindji/muster-mcp` provides a stateless, framework-neutral handler. A real
deployment supplies every network, identity, durability, scheduling, and
operational boundary around it.

## Required components

1. Construct the core services against a durable Store. The checked-in
   PostgreSQL adapter is the production-shaped Store implementation.
2. Supply a durable `McpStateStore` that passes the exported conformance suite.
   The reference in-memory implementation is not durable production state.
3. Configure one canonical HTTPS resource URL and mount `POST /mcp` plus both
   RFC 9728 protected-resource metadata routes on the same handler.
4. Connect an OAuth authorization server that issues short-lived RFC 9068 JWT
   access tokens with pinned algorithms and the exact Muster scopes.
5. Provide a mandatory, highly available per-request revocation source. An
   outage or ambiguous answer must fail authentication.
6. Bind each normalized OAuth issuer/subject pair to one opaque Muster worker
   through the operator-only lifecycle service.
7. Install one immutable canonical skill release matching the accepted contract
   and complete enrolled class set. Hand installation is the stable path.
8. Put trusted-proxy handling, TLS, connection limits, timeouts, denial-of-service
   controls, logs, metrics, and graceful shutdown around the handler.

The complete construction example and exact token, mapping, rate-policy,
privacy, and shutdown rules live in the package's
[MCP operations guide](../../../packages/mcp/README.md).

## Stable worker behavior

Workers see six tools and coarse results. A normal cycle is:

1. call `get_worker_status`;
2. optionally call `set_availability`;
3. call `lease_job` with a coarse availability bucket;
4. serialize exactly one result as JSON text and send it in
   `submit_result.result_json`; and
5. use `abandon_job` or `extend_lease` only for the held lease.

The client must not infer queue depth, eligibility, or precise refusal causes
from errors. It must not use the removed `submit_result.result` field.

## Acceptance

Run local MCP tests, source/packed parity, MCP-state conformance, and the same
authenticated flow over every Store adapter. A real provider/account gate is a
separate deployment check; follow the checked-in
[nonce-bound protocol](../../gate/2026-08-08-mcp-real-client-gate.md) without
reusing its local fixture as remote evidence.
