---
title: Package Guide
parents: [README]
children: []
related_pages: [overview, getting-started, integration]
last_updated: 2026-08-09
---

# Package guide

Muster separates portable contracts and deterministic coordinator logic from
database and network adapters. All packages expose ESM, CommonJS, and TypeScript
declarations under the Apache-2.0 license.

## `@kuindji/muster-contract`

Use the contract package wherever a producer or consumer needs the frozen wire
and domain definitions. It exports Muster Schema 1 validation, canonical JSON
and hashing, job classes, lifecycle and policy tables, MCP schemas, canonical
skill rendering, and versioned fixtures. It has no runtime dependencies.

## `@kuindji/muster-core`

Core owns deterministic coordinator behavior: registration, control-plane
state, enqueue and lease lifecycle, submissions, verification, adjudication,
action authorization, operations, privacy projections, and conformance kits.
It depends only on the contract package and performs no filesystem or network
I/O.

`InMemoryStore` is the reference implementation for tests, evaluation, and
adapter conformance. It is not a production durability claim.

## `@kuindji/muster-store-postgres`

The PostgreSQL adapter implements the complete core `Store` boundary for
PostgreSQL 16 and 18. It owns checked, forward-only migrations and bounded
serializable transaction retries. The caller owns the `pg.Pool`, credentials,
TLS, schema selection, migration role, runtime role, backup, and shutdown.

Read its [construction and operations guide](../../packages/store-postgres/README.md)
before creating a durable Store.

## `@kuindji/muster-mcp`

The MCP package wraps injected core services and MCP state in a framework-neutral
web-standard handler. It exposes the frozen six-tool worker catalog, OAuth/JWT
verification, mandatory revocation checks, severable subject mapping, rate and
slot accounting, canonical skill releases, closed results, and reusable
conformance.

It does not open a listener, terminate TLS, issue tokens, schedule workers, own
deployment policy, or provide production MCP-state persistence. The deployment
must inject those boundaries. Read the detailed [MCP operations guide](../../packages/mcp/README.md).

## Publication status

The workspace manifests currently identify version `0.1.0`, but the repository
has not crossed its package-publication gate. A successful consumer integration
must precede registry publication. Until then, use the source workspace and pin
the exact reviewed commit in any external experiment.
