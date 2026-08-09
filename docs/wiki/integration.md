---
title: Integration
parents: [README]
children: [integration/mcp-deployment, integration/consumer-integration]
related_pages: [packages, operations]
last_updated: 2026-08-09
---

# Integration

Muster has two distinct integration boundaries. The deployment operator makes
the worker-facing MCP resource secure and durable. The trusted consumer defines
job classes, sanitizes and enqueues work, interprets results, and enforces live
authorizations. A production design must name both owners.

- [MCP deployment](integration/mcp-deployment.md) — construct and mount the
  stateless handler, connect OAuth and revocation, provide durable state, bind
  workers, install skills, and operate the endpoint.
- [Consumer integration](integration/consumer-integration.md) — select a
  suitable workload, define its contract and verification strength, connect
  core services, and prove authorization enforcement.

The unattended real-provider gate proved that a supported client can
authenticate, report active status, lease a nonce-bound job, and submit an
accepted result. It does not substitute for either integration boundary in a
real application.
